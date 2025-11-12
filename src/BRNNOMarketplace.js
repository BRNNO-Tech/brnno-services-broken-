import React, { useState, useEffect, useMemo } from 'react';
import config from './config';
import {
    MapPin, Car, Calendar, Star, CheckCircle2, X, ChevronRight,
    Clock, DollarSign, Shield, User, CreditCard, Home, Package,
    Edit2, Trash2, Plus, LogOut, Menu, Search, Mail, Phone, MessageSquare
} from 'lucide-react';
import {
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signInWithPopup,
    onAuthStateChanged,
    signOut
} from 'firebase/auth';
import {
    collection,
    addDoc,
    getDocs,
    getDoc,
    query,
    where,
    updateDoc,
    deleteDoc,
    doc,
    setDoc,
    serverTimestamp,
    onSnapshot
} from 'firebase/firestore';
import { auth, db } from './firebase';
import { GoogleAuthProvider } from 'firebase/auth';
import PaymentForm from './components/PaymentForm';

// Use centralized Firebase config
const googleProvider = new GoogleAuthProvider();

// Google Maps API Key (use your existing key)
const GOOGLE_MAPS_API_KEY = config.googleMapsApiKey;

// ==================== LOCATION HELPER FUNCTIONS ====================

// Dynamically load Google Maps JS API (with Places)
let googleMapsApiLoadPromise;
function loadGoogleMapsApi() {
    if (window.google && window.google.maps) return Promise.resolve();
    if (googleMapsApiLoadPromise) return googleMapsApiLoadPromise;
    googleMapsApiLoadPromise = new Promise((resolve, reject) => {
        const existing = document.getElementById('google-maps-js');
        if (existing) {
            existing.addEventListener('load', () => resolve());
            existing.addEventListener('error', () => reject(new Error('Failed to load Google Maps')));
            return;
        }
        const script = document.createElement('script');
        script.id = 'google-maps-js';
        script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=places&loading=async`;
        script.async = true;
        script.defer = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load Google Maps'));
        document.head.appendChild(script);
    });
    return googleMapsApiLoadPromise;
}

// ==================== SCHEDULING HELPER FUNCTIONS ====================

// Generate available time slots based on provider's schedule for a specific date
function generateAvailableTimesForDate(defaultAvailability, dateOverrides, selectedDate) {
    if (!selectedDate || !defaultAvailability) {
        return [];
    }

    const date = new Date(selectedDate + 'T00:00:00'); // ensure local timezone
    const dayOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][date.getDay()];
    const dateString = selectedDate; // YYYY-MM-DD

    // Check overrides
    if (dateOverrides && dateOverrides[dateString]) {
        const override = dateOverrides[dateString];
        if (override.type === 'unavailable') {
            return [];
        }
        if (override.type === 'custom' && override.hours) {
            return generateTimeSlots(override.hours.start, override.hours.end);
        }
    }

    const daySchedule = defaultAvailability[dayOfWeek];

    if (!daySchedule) {
        return [];
    }

    if (!daySchedule.enabled) {
        return [];
    }

    // Ensure start and end times exist, use defaults if missing
    const startTime = daySchedule.start || '09:00';
    const endTime = daySchedule.end || '17:00';

    return generateTimeSlots(startTime, endTime);
}

// Generate time slots in 1-hour increments (e.g., 09:00-14:00)
function generateTimeSlots(startTime, endTime) {
    if (!startTime || !endTime) return [];
    const slots = [];
    const startHour = parseInt(startTime.split(':')[0]);
    const endHour = parseInt(endTime.split(':')[0]);
    for (let hour = startHour; hour < endHour; hour++) {
        const period = hour >= 12 ? 'PM' : 'AM';
        const displayHour = hour > 12 ? hour - 12 : (hour === 0 ? 12 : hour);
        slots.push(`${displayHour}:00 ${period}`);
    }
    return slots;
}

// Get provider's general hours (for display on cards)
function getProviderHours(defaultAvailability) {
    if (!defaultAvailability) return 'Hours vary';
    const monday = defaultAvailability.monday;
    if (monday && monday.enabled) {
        const start = formatTime(monday.start);
        const end = formatTime(monday.end);
        return `${start} - ${end}`;
    }
    return 'Hours vary';
}

// Format 24hr time to 12hr (10:00 → 10:00 AM)
function formatTime(time24) {
    if (!time24) return '';
    const [hours, minutes] = time24.split(':');
    const hour = parseInt(hours);
    const period = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour > 12 ? hour - 12 : (hour === 0 ? 12 : hour);
    return `${displayHour}:${minutes} ${period}`;
}

// Check if a date is available (not blocked)
function isDateAvailable(dateOverrides, dateString) {
    if (!dateOverrides || !dateString) return true;
    const override = dateOverrides[dateString];
    if (override && override.type === 'unavailable') return false;
    return true;
}

// Geocode address to coordinates using Google Maps API
async function geocodeAddress(address) {
    try {
        await loadGoogleMapsApi();
        const geocoder = new window.google.maps.Geocoder();
        const response = await geocoder.geocode({ address });
        const result = response.results && response.results[0];
        if (!result) return null;

        const byType = (type) => result.address_components.find(c => c.types.includes(type));
        return {
            lat: result.geometry.location.lat(),
            lng: result.geometry.location.lng(),
            formattedAddress: result.formatted_address,
            city: byType('locality')?.long_name || '',
            state: byType('administrative_area_level_1')?.short_name || '',
            zip: byType('postal_code')?.long_name || ''
        };
    } catch (error) {
        console.error('Geocoding error:', error);
        return null;
    }
}

// Calculate straight-line distance using Haversine formula (in miles)
function calculateRealDistance(lat1, lng1, lat2, lng2) {
    if (!lat1 || !lng1 || !lat2 || !lng2) return 999;

    const R = 3959; // Earth's radius in miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;

    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;

    return parseFloat(distance.toFixed(1));
}

// ==================== MAIN APP COMPONENT ====================
export default function BrnnoMarketplace() {
    // Auth state
    const [currentUser, setCurrentUser] = useState(null);
    const [loading, setLoading] = useState(true);
    const [userAccountType, setUserAccountType] = useState(null);

    // User location
    const [userCoordinates, setUserCoordinates] = useState(null);

    // Search and filter state
    const [searchQuery, setSearchQuery] = useState('');
    const [distanceFilter, setDistanceFilter] = useState(50); // miles
    const [sortBy, setSortBy] = useState('distance'); // distance, price, rating, reviews

    // Page state
    const [currentPage, setCurrentPage] = useState('landing'); // landing, marketplace, detailerProfile, dashboard

    // Modal/flow state
    const [modalType, setModalType] = useState(null); // 'address', 'questions', 'signup'
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);

    // Form data
    const [address, setAddress] = useState('');
    const [answers, setAnswers] = useState({
        vehicleType: '',
        serviceType: '',
        timeSlot: ''
    });
    const [signupData, setSignupData] = useState({
        name: '',
        email: '',
        password: ''
    });

    // Reference for address input and autocomplete
    const addressInputRef = React.useRef(null);
    const autocompleteRef = React.useRef(null);

    // Track when Google Maps JS API is loaded
    const [googleMapsLoaded, setGoogleMapsLoaded] = useState(false);

    // Marketplace data
    const [selectedDetailer, setSelectedDetailer] = useState(null);
    const [detailers, setDetailers] = useState([]);

    // Filter and sort detailers based on search query, distance filter, and sort option
    const filteredDetailers = React.useMemo(() => {
        let filtered = [...detailers];

        // Search filter (by service area/city)
        if (searchQuery.trim()) {
            filtered = filtered.filter(d =>
                d.serviceArea?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                d.name?.toLowerCase().includes(searchQuery.toLowerCase())
            );
        }

        // Distance filter
        if (distanceFilter < 999) {
            filtered = filtered.filter(d => d.distance <= distanceFilter);
        }

        // Sort
        switch (sortBy) {
            case 'distance':
                filtered.sort((a, b) => a.distance - b.distance);
                break;
            case 'price':
                filtered.sort((a, b) => a.price - b.price);
                break;
            case 'rating':
                filtered.sort((a, b) => b.rating - a.rating);
                break;
            case 'reviews':
                filtered.sort((a, b) => b.reviews - a.reviews);
                break;
            default:
                // Default to distance
                filtered.sort((a, b) => a.distance - b.distance);
        }

        return filtered;
    }, [detailers, searchQuery, distanceFilter, sortBy]);

    // Load Google Maps script once and set loaded flag
    useEffect(() => {
        let isActive = true;
        (async () => {
            try {
                await loadGoogleMapsApi();
                if (isActive) {
                    setGoogleMapsLoaded(true);
                }
            } catch (e) {
                console.error('Failed to load Google Maps:', e);
            }
        })();
        return () => { isActive = false; };
    }, []);

    // Initialize Google Places Autocomplete on the address input
    useEffect(() => {
        if (modalType !== 'address' || !googleMapsLoaded) return;

        let listener = null;
        try {
            if (!addressInputRef.current || !window.google?.maps?.places) return;

            const ac = new window.google.maps.places.Autocomplete(addressInputRef.current, {
                componentRestrictions: { country: 'us' },
                fields: ['formatted_address', 'geometry', 'address_components']
            });
            autocompleteRef.current = ac;

            listener = ac.addListener('place_changed', () => {
                const place = ac.getPlace();
                if (place?.formatted_address) {
                    setAddress(place.formatted_address);
                    if (place.geometry) {
                        setUserCoordinates({
                            lat: place.geometry.location.lat(),
                            lng: place.geometry.location.lng(),
                            formattedAddress: place.formatted_address
                        });
                    }
                }
            });
        } catch (e) {
            console.error('Autocomplete init failed:', e);
        }

        return () => {
            if (listener && listener.remove) listener.remove();
            autocompleteRef.current = null;
        };
    }, [modalType, googleMapsLoaded]);

    // Profile dropdown
    const [showProfileDropdown, setShowProfileDropdown] = useState(false);

    // Questions for onboarding
    const questions = [
        {
            id: 'vehicleType',
            question: 'What type of vehicle do you have?',
            icon: Car,
            options: ['Sedan', 'SUV', 'Truck', 'Sports Car', 'Van', 'Motorcycle']
        },
        {
            id: 'serviceType',
            question: 'What service are you looking for?',
            icon: Package,
            options: ['Full Detail', 'Exterior Only', 'Interior Only', 'Paint Correction', 'Ceramic Coating', 'Basic Wash']
        },
        {
            id: 'timeSlot',
            question: 'When do you need service?',
            icon: Calendar,
            options: ['Morning (8am-12pm)', 'Afternoon (12pm-4pm)', 'Evening (4pm-8pm)', 'Flexible']
        }
    ];

    // ==================== AUTH LISTENER ====================
    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (user) => {
            if (user) {
                const userInfo = {
                    uid: user.uid,
                    email: user.email,
                    name: user.displayName || signupData.name || user.email.split('@')[0],
                    photoURL: user.photoURL,
                    initials: getInitials(user.displayName || signupData.name || user.email)
                };

                setCurrentUser(userInfo);

                // Check if user has completed onboarding before
                await checkUserOnboarding(user.uid);
            } else {
                // User is not logged in - show landing page
                setCurrentUser(null);
                setUserAccountType(null);
                setCurrentPage('landing');
            }
            setLoading(false);
        });

        return () => unsubscribe();
    }, []);

    // Check if returning user has already completed onboarding
    async function checkUserOnboarding(uid) {
        try {
            const userQuery = query(
                collection(db, 'users'),
                where('uid', '==', uid)
            );
            const userSnapshot = await getDocs(userQuery);

            if (userSnapshot.empty) {
                // User is logged in but no profile - they need to complete onboarding
                setCurrentPage('landing');
                return;
            }

            const userData = userSnapshot.docs[0].data();

            // Store account type for conditional rendering
            setUserAccountType(userData.accountType || 'customer');

            // Providers/Admins should go straight to their dashboard
            if (userData.accountType === 'provider' || userData.role === 'admin') {

                try {
                    const providerSnapshot = await getDocs(
                        query(collection(db, 'providers'), where('userId', '==', uid))
                    );

                    if (!providerSnapshot.empty) {
                        const providerData = providerSnapshot.docs[0].data();

                        setAddress(
                            providerData.businessAddress ||
                            providerData.serviceArea ||
                            providerData.address ||
                            ''
                        );
                        setUserCoordinates(providerData.coordinates || null);
                        setAnswers({
                            vehicleType: providerData.vehicleSpecialty || 'All Vehicles',
                            serviceType: providerData.primaryService || 'Multiple Services',
                            timeSlot: 'Flexible'
                        });
                    }
                } catch (err) {
                    console.warn('Unable to load provider profile for dashboard:', err?.message || err);
                }

                setCurrentPage('dashboard');
                return;
            }

            // Customers - treat presence of profile as onboarded, even if address/preferences missing
            if (userData.onboarded || userData.address || userData.preferences) {

                setAddress(userData.coordinates?.formattedAddress || userData.address || '');
                setUserCoordinates(userData.coordinates || null);
                setAnswers({
                    vehicleType: userData.preferences?.vehicleType || 'Sedan',
                    serviceType: userData.preferences?.serviceType || 'Full Detail',
                    timeSlot: userData.preferences?.timeSlot || 'Flexible'
                });

                setCurrentPage('marketplace');
            } else {
                // Profile exists but incomplete - show landing to complete onboarding
                setCurrentPage('landing');
            }
        } catch (error) {
            console.error('Error checking user onboarding:', error);
            // On error, default to landing page
            setCurrentPage('landing');
        }
    }

    // Load detailers when marketplace opens (and when coordinates become available)
    useEffect(() => {
        if (currentPage === 'marketplace' && detailers.length === 0) {
            loadDetailers();
        }
    }, [currentPage, userCoordinates]);

    // Real-time listener for provider updates (optional but recommended)
    useEffect(() => {
        if (currentPage === 'marketplace') {
            // Listen for changes to providers collection
            const unsubscribe = onSnapshot(collection(db, 'providers'),
                (snapshot) => {
                    const loadedDetailers = snapshot.docs.map(doc => {
                        const data = doc.data();

                        // Filter only active services
                        const activeServices = data.services
                            ? data.services.filter(service => service.active !== false)
                            : [];

                        // Generate available times based on defaultAvailability
                        const availableTimes = generateAvailableTimes(data.defaultAvailability);

                        return {
                            id: doc.id,
                            name: data.businessName || 'Professional Detailer',
                            ownerName: data.ownerName,
                            rating: data.rating || 4.8,
                            reviews: data.reviewCount || 150,
                            distance: calculateDistance(address, data.serviceArea),
                            available: data.status !== 'inactive',
                            price: getStartingPrice(activeServices),
                            image: data.image || null,
                            about: data.about || 'Professional mobile detailing service. Background checked and insured.',
                            services: activeServices,
                            photos: data.portfolio || [],
                            availableTimes: availableTimes,
                            status: data.status,
                            phone: data.phone,
                            email: data.email,
                            serviceArea: data.serviceArea,
                            employeeCount: data.employeeCount || 1,
                            backgroundCheck: data.backgroundCheck,
                            defaultAvailability: data.defaultAvailability,
                            dateOverrides: data.dateOverrides || {}
                        };
                    });

                    setDetailers(loadedDetailers);
                },
                (error) => {
                    console.error('Error in real-time listener:', error);
                }
            );

            // Cleanup listener when leaving marketplace
            return () => {
                unsubscribe();
            };
        }
    }, [currentPage, address]);

    // ==================== HELPER FUNCTIONS ====================
    function getInitials(name) {
        if (!name) return '?';
        const parts = name.split(' ');
        if (parts.length >= 2) {
            return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
        }
        return name.substring(0, 2).toUpperCase();
    }

    async function loadDetailers() {
        try {
            // Query your Firebase 'providers' collection
            const providersQuery = collection(db, 'providers');
            const snapshot = await getDocs(providersQuery);


            const loadedDetailers = snapshot.docs.map(doc => {
                const data = doc.data();

                // Filter only active services
                const activeServices = data.services
                    ? data.services.filter(service => service.active !== false)
                    : [];

                // Calculate real distance if both user and provider have coordinates
                let distance = 999; // Default high value
                if (userCoordinates && data.coordinates) {
                    distance = calculateRealDistance(
                        userCoordinates.lat,
                        userCoordinates.lng,
                        data.coordinates.lat,
                        data.coordinates.lng
                    );
                } else {
                    console.warn(`Missing coordinates for distance calculation:`, {
                        provider: data.businessName,
                        hasUserCoords: !!userCoordinates,
                        hasProviderCoords: !!data.coordinates
                    });
                }

                // Generate available times based on defaultAvailability
                const availableTimes = generateAvailableTimes(data.defaultAvailability);

                // Use bio field if it exists, otherwise use a neutral default without provider address
                const aboutText = data.bio || data.about ||
                    'Professional mobile detailing service. Background checked and insured.';

                return {
                    id: doc.id,
                    userId: data.userId, // Provider's user UID
                    name: data.businessName || 'Professional Detailer',
                    ownerName: data.ownerName,
                    rating: data.rating || 4.8,
                    reviews: data.reviewCount || 150,
                    distance: distance,
                    available: data.status === 'approved' && activeServices.length > 0, // Must be approved and have active services!
                    price: getStartingPrice(activeServices),
                    image: data.image || null,
                    about: aboutText,
                    services: activeServices,
                    photos: data.portfolio || [],
                    availableTimes: availableTimes,
                    status: data.status,
                    phone: data.phone,
                    email: data.email,
                    serviceArea: data.serviceArea,
                    employeeCount: data.employeeCount || 1,
                    backgroundCheck: data.backgroundCheck,
                    defaultAvailability: data.defaultAvailability,
                    dateOverrides: data.dateOverrides || {},
                    coordinates: data.coordinates,
                    hasActiveServices: activeServices.length > 0
                };
            });

            // Only show providers that are APPROVED and have active services
            let availableDetailers = loadedDetailers.filter(d =>
                d.hasActiveServices && d.status === 'approved'
            );

            // Sort by distance (closest first) by default
            availableDetailers.sort((a, b) => a.distance - b.distance);

            setDetailers(availableDetailers);
        } catch (error) {
            console.error('Error loading detailers:', error);
            alert('Error loading detailers. Check console for details.');
            // Fallback to mock data if error
            setDetailers(getMockDetailers());
        }
    }

    function getStartingPrice(services) {
        if (!services || services.length === 0) return 65;
        const prices = services.map(s => s.price || 0).filter(p => p > 0);
        return prices.length > 0 ? Math.min(...prices) : 65;
    }

    function generateAvailableTimes(availability) {
        if (!availability) return ['9:00 AM', '11:00 AM', '2:00 PM', '4:00 PM'];

        // Find first enabled day to show times
        const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        for (const day of days) {
            if (availability[day]?.enabled && availability[day]?.start) {
                const start = availability[day].start; // e.g., "10:00"
                const end = availability[day].end; // e.g., "18:00"

                // Generate time slots between start and end
                const times = [];
                let currentHour = parseInt(start.split(':')[0]);
                const endHour = parseInt(end.split(':')[0]);

                while (currentHour < endHour && times.length < 4) {
                    const hour12 = currentHour > 12 ? currentHour - 12 : currentHour;
                    const ampm = currentHour >= 12 ? 'PM' : 'AM';
                    times.push(`${hour12}:00 ${ampm}`);
                    currentHour += 2; // 2 hour intervals
                }

                return times.length > 0 ? times : ['9:00 AM', '11:00 AM', '2:00 PM', '4:00 PM'];
            }
        }

        return ['9:00 AM', '11:00 AM', '2:00 PM', '4:00 PM'];
    }

    function calculateDistance(userAddress, serviceArea) {
        // Implement actual distance calculation or return estimate
        return (Math.random() * 10 + 0.5).toFixed(1);
    }

    function getMockDetailers() {
        return [
            {
                id: '1',
                name: 'Premium Auto Spa',
                rating: 4.9,
                reviews: 183,
                distance: '2.3',
                available: true,
                price: 75,
                image: null,
                about: 'We specialize in premium detailing services with 10+ years of experience.',
                services: [
                    { name: 'Full Detail', price: 150, duration: '3 hours' },
                    { name: 'Exterior Only', price: 75, duration: '1.5 hours' },
                    { name: 'Interior Only', price: 85, duration: '2 hours' }
                ],
                photos: [],
                availableTimes: ['9:00 AM', '11:00 AM', '2:00 PM', '4:00 PM']
            },
            {
                id: '2',
                name: 'Elite Mobile Detail',
                rating: 4.8,
                reviews: 156,
                distance: '3.1',
                available: true,
                price: 65,
                image: null,
                about: 'Mobile detailing done right. We come to you with all professional equipment.',
                services: [
                    { name: 'Basic Wash', price: 65, duration: '1 hour' },
                    { name: 'Full Detail', price: 140, duration: '3 hours' },
                    { name: 'Ceramic Coating', price: 350, duration: '5 hours' }
                ],
                photos: [],
                availableTimes: ['8:00 AM', '10:00 AM', '1:00 PM', '3:00 PM']
            }
        ];
    }

    // ==================== AUTH FUNCTIONS ====================
    async function handleEmailSignup() {
        try {
            const userCredential = await createUserWithEmailAndPassword(
                auth,
                signupData.email,
                signupData.password
            );

            // Save additional user info to Firestore
            const userDocRef = await addDoc(collection(db, 'users'), {
                uid: userCredential.user.uid,
                name: signupData.name,
                email: signupData.email,
                firstName: signupData.name.split(' ')[0],
                lastName: signupData.name.split(' ').slice(1).join(' '),
                accountType: 'customer',
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
                address: address,
                coordinates: userCoordinates || null, // Save geocoded coordinates
                preferences: answers,
                onboarded: true
            });

            // Persist the entered address into saved addresses subcollection
            try {
                if (address && address.trim()) {
                    const addrDoc = doc(collection(db, 'users', userDocRef.id, 'addresses'));
                    await setDoc(addrDoc, {
                        label: 'Home',
                        address: address,
                        coordinates: userCoordinates || null,
                        createdAt: serverTimestamp(),
                        updatedAt: serverTimestamp()
                    });
                }
            } catch (e) {
                console.warn('Could not save saved address (email signup):', e?.message || e);
            }

            setModalType(null);
            setCurrentPage('marketplace');
        } catch (error) {
            console.error('Signup error:', error);
            alert(error.message);
        }
    }

    // Login function - only for existing users
    async function handleGoogleLogin() {
        try {
            const result = await signInWithPopup(auth, googleProvider);

            // Check if user already exists
            const userQueryRef = query(
                collection(db, 'users'),
                where('uid', '==', result.user.uid)
            );
            const existingUser = await getDocs(userQueryRef);

            if (existingUser.empty) {
                // User doesn't exist - sign them out and tell them to use "Get Started"
                await signOut(auth);
                alert('No account found. Please use "Get Started" to create a new account and complete onboarding.');
                return;
            }

            // User exists - the auth listener will handle routing them to the right page
        } catch (error) {
            console.error('Google login error:', error.code, error.message);
            if (error.code === 'permission-denied') {
                alert('Permission error. Please check Firestore rules.');
            } else {
                alert(`Sign-in failed: ${error.message}`);
            }
        }
    }

    // Signup function - for new users going through onboarding
    async function handleGoogleSignup() {
        try {
            const result = await signInWithPopup(auth, googleProvider);

            // Check if user already exists
            const userQueryRef = query(
                collection(db, 'users'),
                where('uid', '==', result.user.uid)
            );
            const existingUser = await getDocs(userQueryRef);

            if (existingUser.empty) {
                // Only create if user doesn't exist
                const newUserRef = await addDoc(collection(db, 'users'), {
                    uid: result.user.uid,
                    name: result.user.displayName,
                    email: result.user.email,
                    firstName: result.user.displayName?.split(' ')[0] || '',
                    lastName: result.user.displayName?.split(' ').slice(1).join(' ') || '',
                    photoURL: result.user.photoURL,
                    accountType: 'customer',
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp(),
                    address: address,
                    coordinates: userCoordinates || null,
                    preferences: answers,
                    onboarded: true
                });
                // Save address into subcollection for new user
                try {
                    if (address && address.trim()) {
                        const addrDoc = doc(collection(db, 'users', newUserRef.id, 'addresses'));
                        await setDoc(addrDoc, {
                            label: 'Home',
                            address: address,
                            coordinates: userCoordinates || null,
                            createdAt: serverTimestamp(),
                            updatedAt: serverTimestamp()
                        });
                    }
                } catch (e) {
                    console.warn('Could not save saved address (google new):', e?.message || e);
                }
            } else {
                // Optionally update onboarding flag and latest address/preferences
                const docRef = existingUser.docs[0].ref;
                try {
                    await updateDoc(docRef, {
                        onboarded: true,
                        address: address || existingUser.docs[0].data().address || '',
                        coordinates: userCoordinates || existingUser.docs[0].data().coordinates || null,
                        preferences: Object.keys(answers || {}).length ? answers : existingUser.docs[0].data().preferences || {}
                    });
                    // Also ensure saved address exists
                    if (address && address.trim()) {
                        const addrDoc = doc(collection(db, 'users', docRef.id, 'addresses'), 'primary');
                        await setDoc(addrDoc, {
                            label: 'Home',
                            address: address,
                            coordinates: userCoordinates || null,
                            updatedAt: serverTimestamp(),
                            createdAt: serverTimestamp()
                        }, { merge: true });
                    }
                } catch (e) {
                    console.warn('Skipping optional user update:', e?.message || e);
                }
            }

            setModalType(null);
            setCurrentPage('marketplace');
        } catch (error) {
            console.error('Google signup error:', error.code, error.message);
            if (error.code === 'permission-denied') {
                alert('Permission error. Please check Firestore rules.');
            } else {
                alert(`Sign-in failed: ${error.message}`);
            }
        }
    }

    async function handleLogout() {
        await signOut(auth);
        setCurrentPage('landing');
        setShowProfileDropdown(false);
    }

    // ==================== ONBOARDING FLOW ====================
    function startOnboarding() {
        setModalType('address');
    }

    async function handleAddressSubmit() {
        if (!address.trim()) return;

        // Show loading state
        const originalModalType = modalType;
        setModalType('loading');

        try {
            // Prefer coordinates from autocomplete if available
            let coords = userCoordinates;
            if (!coords || !coords.formattedAddress || coords.formattedAddress !== address) {
                coords = await geocodeAddress(address);
            }

            if (!coords) {
                alert('Could not find that address. Please check and try again.');
                setModalType(originalModalType);
                return;
            }

            // Save coordinates
            setUserCoordinates(coords);

            // Use formatted address from Google
            if (coords.formattedAddress) {
                setAddress(coords.formattedAddress);
            }

            // Continue to questions
            setModalType('questions');
            setCurrentQuestionIndex(0);
        } catch (error) {
            console.error('Error geocoding address:', error);
            alert('Error validating address. Please try again.');
            setModalType(originalModalType);
        }
    }

    function handleAnswerSelect(answer) {
        const currentQ = questions[currentQuestionIndex];
        setAnswers(prev => ({ ...prev, [currentQ.id]: answer }));

        if (currentQuestionIndex < questions.length - 1) {
            setCurrentQuestionIndex(prev => prev + 1);
        } else {
            // All questions answered
            setModalType('signup');
        }
    }

    function handleBackQuestion() {
        if (currentQuestionIndex > 0) {
            setCurrentQuestionIndex(prev => prev - 1);
        } else {
            setModalType('address');
        }
    }

    // ==================== RENDER FUNCTIONS ====================
    if (loading) {
        return (
            <div className="min-h-screen bg-gray-50 flex items-center justify-center">
                <div className="text-center">
                    <div className="w-16 h-16 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
                    <p className="text-gray-600">Loading...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gray-50">
            {/* Landing Page */}
            {currentPage === 'landing' && (
                <LandingPage
                    onGetStarted={startOnboarding}
                    onLogin={handleGoogleLogin}
                />
            )}

            {/* Marketplace */}
            {currentPage === 'marketplace' && (
                <MarketplacePage
                    detailers={filteredDetailers}
                    allDetailersCount={detailers.length}
                    onSelectDetailer={(detailer) => {
                        setSelectedDetailer(detailer);
                        setCurrentPage('detailerProfile');
                    }}
                    currentUser={currentUser}
                    onGoToDashboard={() => { setShowProfileDropdown(false); setCurrentPage('dashboard'); }}
                    onLogout={handleLogout}
                    showProfileDropdown={showProfileDropdown}
                    setShowProfileDropdown={setShowProfileDropdown}
                    address={address}
                    onChangeLocation={() => setModalType('address')}
                    searchQuery={searchQuery}
                    onSearchChange={setSearchQuery}
                    distanceFilter={distanceFilter}
                    onDistanceChange={setDistanceFilter}
                    sortBy={sortBy}
                    onSortChange={setSortBy}
                />
            )}

            {/* Detailer Profile */}
            {currentPage === 'detailerProfile' && selectedDetailer && (
                <DetailerProfilePage
                    detailer={selectedDetailer}
                    answers={answers}
                    address={address}
                    setAddress={setAddress}
                    setAnswers={setAnswers}
                    currentUser={currentUser}
                    onBack={() => setCurrentPage('marketplace')}
                    onBook={() => {
                        alert('Booking functionality - integrate with your Stripe!');
                    }}
                />
            )}

            {/* Dashboard - conditional based on account type */}
            {currentPage === 'dashboard' && (
                userAccountType === 'provider' || currentUser?.role === 'admin' ? (
                    <ProviderDashboard
                        currentUser={currentUser}
                        onBackToMarketplace={() => setCurrentPage('marketplace')}
                        onLogout={handleLogout}
                        showProfileDropdown={showProfileDropdown}
                        setShowProfileDropdown={setShowProfileDropdown}
                    />
                ) : (
                    <CustomerDashboard
                        currentUser={currentUser}
                        onBackToMarketplace={() => setCurrentPage('marketplace')}
                        onLogout={handleLogout}
                        showProfileDropdown={showProfileDropdown}
                        setShowProfileDropdown={setShowProfileDropdown}
                        address={address}
                        answers={answers}
                        userCoordinates={userCoordinates}
                    />
                )
            )}

            {/* Modals */}
            {modalType === 'address' && (
                <AddressModal
                    address={address}
                    setAddress={setAddress}
                    addressInputRef={addressInputRef}
                    onSubmit={handleAddressSubmit}
                    onClose={() => setModalType(null)}
                />
            )}

            {modalType === 'questions' && (
                <QuestionsModal
                    question={questions[currentQuestionIndex]}
                    currentIndex={currentQuestionIndex}
                    totalQuestions={questions.length}
                    selectedAnswer={answers[questions[currentQuestionIndex].id]}
                    onSelectAnswer={handleAnswerSelect}
                    onBack={handleBackQuestion}
                    onClose={() => setModalType(null)}
                />
            )}

            {modalType === 'signup' && (
                <SignupModal
                    signupData={signupData}
                    setSignupData={setSignupData}
                    onEmailSignup={handleEmailSignup}
                    onGoogleSignup={handleGoogleSignup}
                    onBack={() => setModalType('questions')}
                    onClose={() => setModalType(null)}
                />
            )}
        </div>
    );
}

// ==================== LANDING PAGE ====================
function LandingPage({ onGetStarted, onLogin }) {
    return (
        <div className="min-h-screen bg-gradient-to-br from-blue-600 via-blue-700 to-blue-900 text-white">
            <div className="max-w-6xl mx-auto px-4 py-12 sm:py-20">
                <div className="text-center mb-12 sm:mb-16">
                    <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold mb-4 sm:mb-6">Welcome to Brnno</h1>
                    <p className="text-lg sm:text-xl md:text-2xl text-blue-100 mb-8 sm:mb-12 px-4">
                        Premium mobile detailing at your fingertips
                    </p>
                    <div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4 px-4">
                        <button
                            onClick={onGetStarted}
                            className="w-full sm:w-auto bg-white text-blue-600 px-8 sm:px-12 py-3 sm:py-4 rounded-xl text-lg sm:text-xl font-semibold hover:bg-blue-50 transition-all transform hover:scale-105 shadow-2xl"
                        >
                            Get Started
                        </button>
                        <button
                            onClick={onLogin}
                            className="w-full sm:w-auto bg-blue-500 text-white px-8 sm:px-12 py-3 sm:py-4 rounded-xl text-lg sm:text-xl font-semibold hover:bg-blue-400 transition-all transform hover:scale-105 shadow-2xl border-2 border-blue-400"
                        >
                            Login
                        </button>
                    </div>
                </div>

                <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-6 sm:gap-8 mt-12 sm:mt-20 px-4">
                    <FeatureCard
                        icon={Shield}
                        title="Vetted Professionals"
                        description="All detailers are background checked and insured"
                    />
                    <FeatureCard
                        icon={MapPin}
                        title="Mobile Service"
                        description="They come to you - home, office, or anywhere"
                    />
                    <FeatureCard
                        icon={Star}
                        title="Quality Guaranteed"
                        description="Read reviews and choose the best for your needs"
                    />
                </div>
            </div>
        </div>
    );
}

function FeatureCard({ icon: Icon, title, description }) {
    return (
        <div className="bg-white/10 backdrop-blur-lg p-6 sm:p-8 rounded-2xl border border-white/20">
            <Icon className="w-10 h-10 sm:w-12 sm:h-12 mb-3 sm:mb-4" />
            <h3 className="text-lg sm:text-xl font-bold mb-2">{title}</h3>
            <p className="text-sm sm:text-base text-blue-100">{description}</p>
        </div>
    );
}

// ==================== MODALS ====================
function AddressModal({ address, setAddress, addressInputRef, onSubmit, onClose }) {
    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-2xl max-w-md w-full p-8 relative animate-fadeIn">
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
                >
                    <X className="w-6 h-6" />
                </button>

                <div className="mb-6">
                    <MapPin className="w-12 h-12 text-blue-600 mb-4" />
                    <h2 className="text-2xl font-bold text-gray-900 mb-2">
                        Where should we come?
                    </h2>
                    <p className="text-gray-600">
                        Enter your address to find nearby detailers
                    </p>
                </div>

                <input
                    ref={addressInputRef}
                    type="text"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="Start typing your address..."
                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none mb-6"
                />

                <button
                    onClick={onSubmit}
                    disabled={!address.trim()}
                    className="w-full bg-blue-600 text-white py-3 rounded-xl font-semibold hover:bg-blue-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                    Continue
                </button>
            </div>
        </div>
    );
}

function QuestionsModal({ question, currentIndex, totalQuestions, selectedAnswer, onSelectAnswer, onBack, onClose }) {
    const Icon = question.icon;

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-2xl max-w-2xl w-full p-8 relative animate-fadeIn">
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
                >
                    <X className="w-6 h-6" />
                </button>

                <div className="mb-8">
                    <div className="flex items-center justify-between mb-4">
                        <Icon className="w-10 h-10 text-blue-600" />
                        <span className="text-sm text-gray-500">
                            Question {currentIndex + 1} of {totalQuestions}
                        </span>
                    </div>
                    <h2 className="text-2xl font-bold text-gray-900 mb-2">
                        {question.question}
                    </h2>
                </div>

                <div className="grid grid-cols-2 gap-3 mb-6">
                    {question.options.map((option) => (
                        <button
                            key={option}
                            onClick={() => onSelectAnswer(option)}
                            className={`p-4 rounded-xl border-2 font-medium transition-all ${selectedAnswer === option
                                ? 'border-blue-600 bg-blue-50 text-blue-600'
                                : 'border-gray-200 hover:border-blue-300 text-gray-700'
                                }`}
                        >
                            {option}
                        </button>
                    ))}
                </div>

                {currentIndex > 0 && (
                    <button
                        onClick={onBack}
                        className="text-blue-600 font-medium hover:text-blue-700"
                    >
                        ← Back
                    </button>
                )}
            </div>
        </div>
    );
}

function SignupModal({ signupData, setSignupData, onEmailSignup, onGoogleSignup, onBack, onClose }) {
    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50 overflow-y-auto">
            <div className="bg-white rounded-2xl max-w-md w-full p-8 relative my-8 animate-fadeIn">
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
                >
                    <X className="w-6 h-6" />
                </button>

                <div className="mb-6">
                    <h2 className="text-2xl font-bold text-gray-900 mb-2">
                        Create your account
                    </h2>
                    <p className="text-gray-600">
                        Sign up to see available detailers and book service
                    </p>
                </div>

                <div className="space-y-4 mb-6">
                    <input
                        type="text"
                        value={signupData.name}
                        onChange={(e) => setSignupData({ ...signupData, name: e.target.value })}
                        placeholder="Full Name"
                        className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                    />
                    <input
                        type="email"
                        value={signupData.email}
                        onChange={(e) => setSignupData({ ...signupData, email: e.target.value })}
                        placeholder="Email"
                        className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                    />
                    <input
                        type="password"
                        value={signupData.password}
                        onChange={(e) => setSignupData({ ...signupData, password: e.target.value })}
                        placeholder="Password"
                        className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                    />
                </div>

                <button
                    onClick={onEmailSignup}
                    disabled={!signupData.name || !signupData.email || !signupData.password}
                    className="w-full bg-blue-600 text-white py-3 rounded-xl font-semibold hover:bg-blue-700 transition-colors mb-4 disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                    Sign Up with Email
                </button>

                <div className="relative my-6">
                    <div className="absolute inset-0 flex items-center">
                        <div className="w-full border-t border-gray-200"></div>
                    </div>
                    <div className="relative flex justify-center text-sm">
                        <span className="px-4 bg-white text-gray-500">or</span>
                    </div>
                </div>

                <button
                    onClick={onGoogleSignup}
                    className="w-full bg-white border-2 border-gray-200 text-gray-700 py-3 rounded-xl font-semibold hover:bg-gray-50 transition-colors flex items-center justify-center gap-2"
                >
                    <svg className="w-5 h-5" viewBox="0 0 24 24">
                        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                    </svg>
                    Continue with Google
                </button>

                <button
                    onClick={onBack}
                    className="w-full mt-4 text-blue-600 font-medium hover:text-blue-700"
                >
                    ← Back
                </button>
            </div>
        </div>
    );
}

// ==================== BOOKING SIDEBAR COMPONENT ====================
function BookingSidebar({
    detailer,
    selectedServices: selectedServicesProp,
    setSelectedServices: setSelectedServicesProp,
    selectedDate: selectedDateProp,
    setSelectedDate: setSelectedDateProp,
    selectedTime: selectedTimeProp,
    setSelectedTime: setSelectedTimeProp,
    onBookNow,
    isBooking: isBookingProp,
    currentUser: currentUserProp,
    address,
    answers,
    setAddress,
    setAnswers,
    onBook // backward compatibility
}) {
    // Local state fallbacks if parent doesn't control these
    const [selectedServicesState, setSelectedServicesState] = useState(selectedServicesProp || []);
    const [selectedTimeState, setSelectedTimeState] = useState(selectedTimeProp || '');
    const [selectedDateState, setSelectedDateState] = useState(selectedDateProp || '');
    const [isBookingState, setIsBookingState] = useState(!!isBookingProp);

    const [serviceSearch, setServiceSearch] = useState('');
    const [selectedCategory, setSelectedCategory] = useState('all');
    const [servicesExpanded, setServicesExpanded] = useState(true);
    const [showPayment, setShowPayment] = useState(false);
    const [bookingData, setBookingData] = useState(null);

    const selectedServices = selectedServicesProp ?? selectedServicesState;
    const setSelectedServices = setSelectedServicesProp ?? setSelectedServicesState;
    const selectedTime = selectedTimeProp ?? selectedTimeState;
    const setSelectedTime = setSelectedTimeProp ?? setSelectedTimeState;
    const selectedDate = selectedDateProp ?? selectedDateState;
    const setSelectedDate = setSelectedDateProp ?? setSelectedDateState;
    const isBooking = isBookingProp ?? isBookingState;

    // Get current user from auth if not provided
    const currentUser = currentUserProp || auth.currentUser;

    // Calculate total price from selected services
    const totalPrice = useMemo(() => {
        return selectedServices.reduce((sum, service) => sum + (service.price || 0), 0);
    }, [selectedServices]);

    useEffect(() => {
        // Don't pre-select - let user choose services
        setSelectedCategory('all');
        setServiceSearch('');
        setServicesExpanded(true);
    }, [detailer]);

    // Calculate available times based on selected date
    const availableTimesForSelectedDate = useMemo(() => {
        if (!selectedDate) {
            return [];
        }

        // If provider has defaultAvailability, use it for dynamic times
        if (detailer.defaultAvailability) {
            return generateAvailableTimesForDate(
                detailer.defaultAvailability,
                detailer.dateOverrides || {},
                selectedDate
            );
        }

        // Fallback to static availableTimes if defaultAvailability is not set
        // This handles providers who haven't set up their schedule yet
        if (detailer.availableTimes && detailer.availableTimes.length > 0) {
            return detailer.availableTimes;
        }

        return [];
    }, [selectedDate, detailer.defaultAvailability, detailer.dateOverrides, detailer.availableTimes]);

    // Clear selected time when date changes and no times available
    useEffect(() => {
        if (selectedDate && availableTimesForSelectedDate.length === 0) {
            setSelectedTime('');
        }
    }, [selectedDate, availableTimesForSelectedDate]);

    const categories = useMemo(() => {
        const unique = new Set((detailer.services || []).map(s => s.category || 'Other'));
        return ['all', ...Array.from(unique)];
    }, [detailer.services]);

    const filteredServices = useMemo(() => {
        if (!detailer.services) return [];
        return detailer.services.filter((service) => {
            const matchesCategory = selectedCategory === 'all' || service.category === selectedCategory;
            const matchesSearch = service.name?.toLowerCase().includes(serviceSearch.toLowerCase())
                || service.description?.toLowerCase().includes(serviceSearch.toLowerCase());
            return matchesCategory && matchesSearch;
        });
    }, [detailer.services, selectedCategory, serviceSearch]);

    const servicesGrouped = useMemo(() => {
        return filteredServices.reduce((acc, service) => {
            const category = service.category || 'Other';
            if (!acc[category]) acc[category] = [];
            acc[category].push(service);
            return acc;
        }, {});
    }, [filteredServices]);

    async function handleBookNow() {
        if (!currentUser) {
            alert('Please log in to book a service');
            return;
        }

        // Prevent providers from booking services
        try {
            const providerQuery = query(
                collection(db, 'providers'),
                where('userId', '==', currentUser.uid)
            );
            const providerSnapshot = await getDocs(providerQuery);
            if (!providerSnapshot.empty) {
                alert('Providers cannot book services. Please use your provider dashboard to manage bookings.');
                return;
            }
        } catch (err) {
            console.warn('Could not check if user is provider:', err);
        }

        if (!selectedServices || selectedServices.length === 0) {
            alert('Please select at least one service');
            return;
        }

        if (!selectedTime) {
            alert('Please select a time');
            return;
        }

        if (!selectedDate) {
            alert('Please select a date');
            return;
        }

        // Get the actual provider userId from the provider document
        let actualProviderUserId = detailer.userId;
        if (!actualProviderUserId) {
            try {
                const providerDocRef = doc(db, 'providers', detailer.id);
                const providerDocSnap = await getDoc(providerDocRef);
                if (providerDocSnap.exists()) {
                    actualProviderUserId = providerDocSnap.data().userId;
                }
            } catch (err) {
                console.warn('Could not fetch provider userId:', err);
            }
        }

        if (!actualProviderUserId) {
            console.error('ERROR: No provider userId found! Cannot create booking without providerUserId.');
            alert('Error: Could not determine provider information. Please try again.');
            return;
        }

        // Store booking data and show payment modal
        const bookingDataToStore = {
            customerId: currentUser.uid,
            customerEmail: currentUser.email,
            providerId: detailer.id,
            providerUserId: actualProviderUserId,
            providerName: detailer.name,
            // Store services as array
            services: selectedServices.map(s => ({
                id: s.id,
                slug: s.slug,
                name: s.name,
                price: s.price,
                duration: s.duration,
                category: s.category
            })),
            // Keep serviceName for backward compatibility
            serviceName: selectedServices.length === 1 
                ? selectedServices[0].name 
                : `${selectedServices.length} Services`,
            // Store total price
            price: totalPrice,
            date: selectedDate,
            time: selectedTime,
            address: address,
            vehicleType: answers.vehicleType,
            preferredTimeSlot: answers.timeSlot,
            status: 'pending',
        };

        setBookingData(bookingDataToStore);
        setShowPayment(true);
    }

    // Handle payment completion
    async function handlePaymentComplete(paymentResult) {
        if (paymentResult.status !== 'succeeded') {
            alert('Payment failed. Please try again.');
            setShowPayment(false);
            return;
        }

        setIsBookingState(true);
        try {
            // Create booking after payment succeeds
            const finalBookingData = {
                ...bookingData,
                ...(paymentResult.paymentIntent?.id && { paymentIntentId: paymentResult.paymentIntent.id }),
                paymentStatus: 'paid',
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            };

            const bookingRef = await addDoc(collection(db, 'bookings'), finalBookingData);

            const serviceText = bookingData.services && bookingData.services.length > 0
                ? (bookingData.services.length === 1 
                    ? bookingData.services[0].name 
                    : `${bookingData.services.length} services`)
                : bookingData.serviceName || 'service';
            alert(`Booking confirmed! Your ${serviceText} ${bookingData.services?.length === 1 ? 'is' : 'are'} scheduled for ${bookingData.date} at ${bookingData.time}.`);

            setShowPayment(false);
            setBookingData(null);

            // Optionally redirect or refresh
            window.location.href = '#';
        } catch (error) {
            console.error('Error creating booking:', error);
            alert('Payment succeeded but failed to create booking. Please contact support.');
        } finally {
            setIsBookingState(false);
        }
    }

    // Simple helper editors for address/vehicle
    const handleChangeAddress = () => {
        if (!setAddress) return;
        const updated = window.prompt('Where should the detailer meet you?', address || '');
        if (updated !== null) {
            const trimmed = updated.trim();
            if (trimmed) {
                setAddress(trimmed);
            }
        }
    };

    const handleChangeVehicle = () => {
        if (!setAnswers) return;
        const updated = window.prompt('What vehicle should we service?', answers?.vehicleType || '');
        if (updated !== null) {
            const trimmed = updated.trim();
            if (trimmed) {
                setAnswers(prev => ({
                    ...prev,
                    vehicleType: trimmed
                }));
            }
        }
    };

    // Contact handlers
    const handleEmail = () => {
        if (!detailer?.email) return;
        const serviceText = selectedServices.length > 0 
            ? (selectedServices.length === 1 ? selectedServices[0].name : 'your services')
            : 'your services';
        window.location.href = `mailto:${detailer.email}?subject=Question about ${serviceText}`;
    };

    const handleCall = () => {
        if (!detailer?.phone) return;
        window.location.href = `tel:${detailer.phone}`;
    };

    const handleSupport = () => {
        window.location.href = 'mailto:support@brnno.com?subject=Customer Support Request';
    };

    return (
        <div className="bg-white rounded-xl shadow-lg p-6 sticky top-4">
            {/* Provider Info */}
            <div className="mb-6 pb-6 border-b border-gray-200">
                <div className="flex items-center gap-3 mb-3">
                    <div className="w-12 h-12 bg-blue-600 rounded-full flex items-center justify-center text-white font-bold text-lg">
                        {detailer.name.charAt(0)}
                    </div>
                    <div>
                        <h3 className="font-bold text-lg">{detailer.name}</h3>
                        <div className="flex items-center gap-1 text-sm">
                            <Star className="w-4 h-4 fill-yellow-400 text-yellow-400" />
                            <span className="font-semibold">{detailer.rating}</span>
                            <span className="text-gray-500">({detailer.reviews})</span>
                        </div>
                    </div>
                </div>

                <div className="space-y-1 text-sm text-gray-600 mb-3">
                    <div className="flex items-center gap-2">
                        <MapPin className="w-4 h-4" />
                        <span>Serves {detailer.serviceArea || 'your area'}</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="w-4 h-4" />
                        <span>{detailer.distance} miles from you</span>
                    </div>
                </div>

                {/* Contact Provider Buttons */}
                <div className="space-y-2">
                    <p className="text-xs font-medium text-gray-700">Contact Provider</p>
                    <div className="flex gap-2">
                        {detailer.email && (
                            <button onClick={handleEmail} className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 flex items-center justify-center gap-2">
                                <Mail className="w-4 h-4" />
                                Email
                            </button>
                        )}
                        {detailer.phone && (
                            <button onClick={handleCall} className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 flex items-center justify-center gap-2">
                                <Phone className="w-4 h-4" />
                                Call
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Customer's Booking Info */}
            <div className="mb-6">
                <h3 className="font-semibold text-gray-900 mb-4">{(currentUser?.displayName || currentUser?.email || 'Your').split(' ')[0]}'s Booking</h3>

                {/* Service Location */}
                <div className="mb-4 p-3 bg-blue-50 rounded-lg">
                    <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-gray-700">Service Location</span>
                        {setAddress && (
                            <button className="text-xs text-blue-600 hover:text-blue-700 font-medium" onClick={handleChangeAddress}>
                                Change
                            </button>
                        )}
                    </div>
                    <div className="flex items-start gap-2">
                        <MapPin className="w-4 h-4 text-gray-600 mt-0.5 flex-shrink-0" />
                        <p className="text-sm text-gray-800">{address}</p>
                    </div>
                </div>

                {/* Vehicle */}
                <div className="mb-4 p-3 bg-blue-50 rounded-lg">
                    <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-gray-700">Your Vehicle</span>
                        {setAnswers && (
                            <button className="text-xs text-blue-600 hover:text-blue-700 font-medium" onClick={handleChangeVehicle}>
                                Change
                            </button>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        <Car className="w-4 h-4 text-gray-600" />
                        <p className="text-sm text-gray-800">{answers?.vehicleType}</p>
                    </div>
                </div>
            </div>

            {/* Select Service */}
            <div className="mb-6">
                <div className="flex items-center justify-between mb-4">
                    <h4 className="font-semibold text-gray-900">Select Services</h4>
                    {selectedServices.length > 0 && (
                        <button
                            onClick={() => setServicesExpanded(!servicesExpanded)}
                            className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                        >
                            {servicesExpanded ? 'Hide' : 'Show'} Services
                        </button>
                    )}
                </div>

                {/* Show selected services summary when collapsed */}
                {selectedServices.length > 0 && !servicesExpanded && (
                    <div className="mb-4 space-y-2">
                        {selectedServices.map((service, idx) => (
                            <div key={service.slug || service.id || idx} className="p-3 bg-blue-50 border-2 border-blue-200 rounded-lg">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <div className="font-semibold text-gray-900 text-sm">{service.name}</div>
                                        <div className="text-xs text-gray-500">{service.duration}</div>
                                    </div>
                                    <div className="text-right">
                                        <div className="font-bold text-gray-900">${service.price}</div>
                                    </div>
                                </div>
                            </div>
                        ))}
                        <div className="p-3 bg-gray-50 border-2 border-gray-200 rounded-lg">
                            <div className="flex items-center justify-between">
                                <span className="font-semibold text-gray-900 text-sm">Total:</span>
                                <span className="font-bold text-gray-900">${totalPrice}</span>
                            </div>
                        </div>
                        <button
                            onClick={() => setServicesExpanded(true)}
                            className="w-full text-xs text-blue-600 hover:text-blue-700 font-medium"
                        >
                            Change Services
                        </button>
                    </div>
                )}

                {/* Services list - only show when expanded or no services selected */}
                {(servicesExpanded || selectedServices.length === 0) && (
                    <>
                        <div className="flex flex-wrap items-center gap-2 mb-3">
                            {categories.map((cat) => (
                                <button
                                    key={cat}
                                    onClick={() => setSelectedCategory(cat)}
                                    className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${selectedCategory === cat ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                                >
                                    {cat === 'all' ? 'All Services' : cat.replace(/-/g, ' ')}
                                </button>
                            ))}
                        </div>

                        <div className="mb-4">
                            <div className="relative">
                                <input
                                    type="text"
                                    value={serviceSearch}
                                    onChange={(e) => setServiceSearch(e.target.value)}
                                    placeholder="Search services..."
                                    className="w-full px-4 py-2 border-2 border-gray-200 rounded-lg focus:border-blue-600 focus:outline-none text-sm"
                                />
                                <Search className="w-4 h-4 text-gray-400 absolute right-3 top-1/2 -translate-y-1/2" />
                            </div>
                        </div>

                        <div className="space-y-3 max-h-60 overflow-y-auto pr-1">
                            {Object.keys(servicesGrouped).length === 0 && (
                                <p className="text-sm text-gray-500">No services match your filters.</p>
                            )}
                            {Object.entries(servicesGrouped).map(([category, services]) => (
                                <div key={category}>
                                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                                        {category.replace(/-/g, ' ')}
                                    </p>
                                    <div className="space-y-2">
                                        {services.map((service) => {
                                            const isSelected = selectedServices.some(s => 
                                                (s.slug && s.slug === service.slug) || 
                                                (s.id && s.id === service.id) ||
                                                (s.name && s.name === service.name)
                                            );
                                            return (
                                                <div
                                                    key={service.id || service.slug || service.name}
                                                    onClick={() => {
                                                        if (isSelected) {
                                                            // Remove service
                                                            setSelectedServices(prev => prev.filter(s => 
                                                                (s.slug !== service.slug) && 
                                                                (s.id !== service.id) &&
                                                                (s.name !== service.name)
                                                            ));
                                                        } else {
                                                            // Add service
                                                            setSelectedServices(prev => [...prev, service]);
                                                        }
                                                    }}
                                                    className={`w-full text-left px-3 py-2 border-2 rounded-lg transition-all cursor-pointer ${
                                                        isSelected 
                                                            ? 'border-blue-600 bg-blue-50' 
                                                            : 'border-gray-200 hover:border-blue-300'
                                                    }`}
                                                >
                                                    <div className="flex items-center justify-between gap-2">
                                                        <div className="flex items-center gap-2 flex-1 min-w-0">
                                                            <input
                                                                type="checkbox"
                                                                checked={isSelected}
                                                                onChange={() => {}} // Handled by parent div onClick
                                                                className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 flex-shrink-0"
                                                            />
                                                            <div className="flex-1 min-w-0">
                                                                <div className="font-semibold text-gray-900 text-sm truncate">{service.name}</div>
                                                                <div className="text-xs text-gray-500">{service.duration}</div>
                                                            </div>
                                                        </div>
                                                        <div className="text-right flex-shrink-0">
                                                            <div className="font-bold text-gray-900 text-sm">${service.price}</div>
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </>
                )}
            </div>

            {/* Desktop: Regular date/time selection */}
            <div className="hidden lg:block">
                {/* Select Date */}
                <div className="mb-6">
                    <label className="block font-semibold text-gray-900 mb-3">Select Date</label>
                    <input
                        type="date"
                        value={selectedDate}
                        onChange={(e) => setSelectedDate(e.target.value)}
                        min={new Date().toISOString().split('T')[0]}
                        className="w-full px-4 py-2 border-2 border-gray-200 rounded-lg focus:border-blue-600 focus:outline-none"
                    />
                </div>

                {/* Select Time */}
                <div className="mb-6">
                    <label className="block font-semibold text-gray-900 mb-3">Select Time</label>
                    {availableTimesForSelectedDate.length === 0 ? (
                        <div className="p-4 bg-gray-100 border-2 border-gray-200 rounded-lg text-center">
                            <p className="text-gray-600 font-medium">
                                {selectedDate ? 'Closed - No availability on this day' : 'Please select a date first'}
                            </p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-2 gap-2">
                            {availableTimesForSelectedDate.map((time) => (
                                <button
                                    key={time}
                                    onClick={() => setSelectedTime(time)}
                                    className={`px-4 py-2 border-2 rounded-lg font-medium transition-all ${selectedTime === time ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-700 hover:border-blue-300'
                                        }`}
                                >
                                    {time}
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {/* Total */}
                {selectedServices.length > 0 && (
                    <div className="p-4 bg-gray-50 rounded-lg mb-4">
                        <div className="mb-2 space-y-1">
                            {selectedServices.map((service, idx) => (
                                <div key={service.slug || service.id || idx} className="flex items-center justify-between text-sm">
                                    <span className="text-gray-600">{service.name}:</span>
                                    <span className="text-gray-900 font-medium">${service.price}</span>
                                </div>
                            ))}
                        </div>
                        <div className="flex items-center justify-between pt-2 border-t border-gray-300">
                            <span className="text-gray-600 font-medium">Total:</span>
                            <span className="text-3xl font-bold text-gray-900">${totalPrice}</span>
                        </div>
                    </div>
                )}

                {/* Book Button */}
                <button
                    onClick={onBookNow || handleBookNow}
                    disabled={isBooking || selectedServices.length === 0 || !selectedTime || !selectedDate}
                    className="w-full bg-blue-600 text-white py-4 rounded-xl font-bold text-lg hover:bg-blue-700 transition-colors shadow-lg disabled:bg-gray-300 disabled:cursor-not-allowed mb-4"
                >
                    {isBooking 
                        ? 'Booking...' 
                        : selectedServices.length === 0 
                            ? 'Select Services' 
                            : selectedServices.length === 1
                                ? `Book ${selectedServices[0].name}`
                                : `Book ${selectedServices.length} Services`
                    }
                </button>
            </div>

            {/* Mobile: Sticky footer with date/time and book button */}
            <div className="lg:hidden sticky bottom-0 bg-white border-t border-gray-200 p-4 -mx-6 -mb-6 mt-6 shadow-lg">
                {/* Total */}
                {selectedServices.length > 0 && (
                    <div className="mb-3 p-3 bg-gray-50 rounded-lg">
                        <div className="mb-2 space-y-1">
                            {selectedServices.map((service, idx) => (
                                <div key={service.slug || service.id || idx} className="flex items-center justify-between text-xs">
                                    <span className="text-gray-600 truncate pr-2">{service.name}:</span>
                                    <span className="text-gray-900 font-medium">${service.price}</span>
                                </div>
                            ))}
                        </div>
                        <div className="flex items-center justify-between pt-2 border-t border-gray-300">
                            <span className="text-gray-600 font-medium text-sm">Total:</span>
                            <span className="text-2xl font-bold text-gray-900">${totalPrice}</span>
                        </div>
                    </div>
                )}

                {/* Select Date */}
                <div className="mb-3">
                    <label className="block font-semibold text-gray-900 mb-2 text-sm">Select Date</label>
                    <input
                        type="date"
                        value={selectedDate}
                        onChange={(e) => setSelectedDate(e.target.value)}
                        min={new Date().toISOString().split('T')[0]}
                        className="w-full px-4 py-2 border-2 border-gray-200 rounded-lg focus:border-blue-600 focus:outline-none text-sm"
                    />
                </div>

                {/* Select Time */}
                <div className="mb-3">
                    <label className="block font-semibold text-gray-900 mb-2 text-sm">Select Time</label>
                    {availableTimesForSelectedDate.length === 0 ? (
                        <div className="p-3 bg-gray-100 border-2 border-gray-200 rounded-lg text-center">
                            <p className="text-gray-600 font-medium text-sm">
                                {selectedDate ? 'Closed - No availability on this day' : 'Please select a date first'}
                            </p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-3 gap-2 max-h-32 overflow-y-auto">
                            {availableTimesForSelectedDate.map((time) => (
                                <button
                                    key={time}
                                    onClick={() => setSelectedTime(time)}
                                    className={`px-3 py-2 border-2 rounded-lg font-medium transition-all text-sm ${selectedTime === time ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-700 hover:border-blue-300'
                                        }`}
                                >
                                    {time}
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {/* Book Button */}
                <button
                    onClick={onBookNow || handleBookNow}
                    disabled={isBooking || selectedServices.length === 0 || !selectedTime || !selectedDate}
                    className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold text-base hover:bg-blue-700 transition-colors shadow-lg disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                    {isBooking 
                        ? 'Booking...' 
                        : selectedServices.length === 0 
                            ? 'Select Services' 
                            : selectedServices.length === 1
                                ? `Book ${selectedServices[0].name}`
                                : `Book ${selectedServices.length} Services`
                    }
                </button>
            </div>

            {/* Payment Modal */}
            {showPayment && bookingData && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                    <PaymentForm
                        amount={bookingData.price}
                        onClose={() => {
                            setShowPayment(false);
                            setBookingData(null);
                        }}
                        onComplete={handlePaymentComplete}
                    />
                </div>
            )}

            {/* Support */}
            <button onClick={handleSupport} className="w-full py-2 text-sm text-gray-600 hover:text-gray-800 flex items-center justify-center gap-2">
                <MessageSquare className="w-4 h-4" />
                Need help? Contact Brnno Support
            </button>
        </div>
    );
}

// ==================== MARKETPLACE PAGE ====================
function MarketplacePage({
    detailers,
    allDetailersCount,
    onSelectDetailer,
    currentUser,
    onGoToDashboard,
    onLogout,
    showProfileDropdown,
    setShowProfileDropdown,
    address,
    onChangeLocation,
    searchQuery,
    onSearchChange,
    distanceFilter,
    onDistanceChange,
    sortBy,
    onSortChange
}) {
    const profileDropdownRef = React.useRef(null);

    // Close dropdown when clicking outside
    useEffect(() => {
        function handleClickOutside(event) {
            if (profileDropdownRef.current && !profileDropdownRef.current.contains(event.target)) {
                setShowProfileDropdown(false);
            }
        }

        if (showProfileDropdown) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [showProfileDropdown, setShowProfileDropdown]);

    return (
        <div className="min-h-screen bg-gray-50">
            {/* Glassmorphic Header */}
            <div className="sticky top-0 z-40 backdrop-blur-xl bg-gradient-to-r from-blue-600/90 via-blue-700/90 to-indigo-600/90 border-b border-blue-400/20 shadow-lg">
                <div className="max-w-6xl mx-auto px-4 py-4">
                    <div className="flex items-center justify-between">
                        <h1 className="text-2xl font-bold text-white drop-shadow-md">Brnno</h1>

                        {currentUser && (
                            <div className="relative" ref={profileDropdownRef}>
                                <button
                                    onClick={() => setShowProfileDropdown(!showProfileDropdown)}
                                    className="w-11 h-11 bg-gradient-to-br from-purple-500 to-pink-500 rounded-full flex items-center justify-center text-white font-semibold hover:from-purple-600 hover:to-pink-600 transition-all shadow-lg hover:shadow-xl transform hover:scale-105 ring-2 ring-white/30"
                                >
                                    {currentUser.initials}
                                </button>
                                {showProfileDropdown && (
                                    <ProfileDropdown
                                        currentUser={currentUser}
                                        onGoToDashboard={() => { setShowProfileDropdown(false); onGoToDashboard(); }}
                                        onLogout={onLogout}
                                    />
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Search & Filter Bar */}
            <div className="bg-white border-b border-gray-200 py-4">
                <div className="max-w-6xl mx-auto px-4">
                    <div className="flex flex-col md:flex-row gap-4 mb-3">
                        {/* Search Input */}
                        <div className="flex-1 relative">
                            <MapPin className="absolute left-3 top-3 w-5 h-5 text-gray-400" />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => onSearchChange(e.target.value)}
                                placeholder="Search by city or ZIP code..."
                                className="w-full pl-10 pr-4 py-2.5 border-2 border-gray-200 rounded-lg focus:border-blue-600 focus:outline-none"
                            />
                        </div>

                        {/* Distance Filter */}
                        <select
                            value={distanceFilter}
                            onChange={(e) => onDistanceChange(Number(e.target.value))}
                            className="px-4 py-2.5 border-2 border-gray-200 rounded-lg focus:border-blue-600 focus:outline-none bg-white"
                        >
                            <option value={5}>Within 5 miles</option>
                            <option value={10}>Within 10 miles</option>
                            <option value={25}>Within 25 miles</option>
                            <option value={50}>Within 50 miles</option>
                            <option value={999}>Any distance</option>
                        </select>

                        {/* Sort Dropdown */}
                        <select
                            value={sortBy}
                            onChange={(e) => onSortChange(e.target.value)}
                            className="px-4 py-2.5 border-2 border-gray-200 rounded-lg focus:border-blue-600 focus:outline-none bg-white"
                        >
                            <option value="distance">Sort: Distance</option>
                            <option value="price">Sort: Price</option>
                            <option value="rating">Sort: Rating</option>
                            <option value="reviews">Sort: Reviews</option>
                        </select>
                    </div>

                    {/* Current Location & Results Count */}
                    <div className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2">
                            <span className="text-gray-600">
                                Showing results near:
                            </span>
                            <strong className="text-gray-900">{address}</strong>
                            <button
                                onClick={onChangeLocation}
                                className="text-blue-600 hover:text-blue-700 font-medium ml-2"
                            >
                                Change
                            </button>
                        </div>
                        <span className="text-gray-500">
                            {detailers.length} of {allDetailersCount} detailer{allDetailersCount !== 1 ? 's' : ''}
                        </span>
                    </div>
                </div>
            </div>

            {/* Detailer List */}
            <div className="max-w-6xl mx-auto px-4 py-8">
                {detailers.length === 0 ? (
                    <div className="text-center py-12">
                        <Search className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                        <h3 className="text-xl font-semibold text-gray-900 mb-2">No detailers found</h3>
                        <p className="text-gray-600 mb-4">
                            Try adjusting your filters or search in a different area
                        </p>
                        <button
                            onClick={() => {
                                onSearchChange('');
                                onDistanceChange(50);
                            }}
                            className="px-6 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700"
                        >
                            Clear Filters
                        </button>
                    </div>
                ) : (
                    <>
                        <h2 className="text-3xl font-bold text-gray-900 mb-6">
                            Available Detailers
                        </h2>

                        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {detailers.map((detailer) => (
                                <DetailerCard
                                    key={detailer.id}
                                    detailer={detailer}
                                    onClick={() => onSelectDetailer(detailer)}
                                />
                            ))}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

function DetailerCard({ detailer, onClick }) {
    // Default logo for Cloud Mobile if no image is set
    const isCloudMobile = detailer.name?.toLowerCase().includes('cloud mobile');
    const imageUrl = detailer.image || (isCloudMobile ? 'https://via.placeholder.com/400x200/3B82F6/FFFFFF?text=Cloud+Mobile' : null);

    return (
        <div
            onClick={onClick}
            className="bg-white rounded-xl border border-gray-200 overflow-hidden hover:shadow-lg transition-shadow cursor-pointer"
        >
            <div className="h-48 bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center">
                {imageUrl ? (
                    <img src={imageUrl} alt={detailer.name} className="w-full h-full object-cover" />
                ) : (
                    <span className="text-4xl sm:text-5xl md:text-6xl font-bold text-white">
                        {detailer.name.charAt(0)}
                    </span>
                )}
            </div>

            <div className="p-6">
                <h3 className="text-xl font-bold text-gray-900 mb-2">
                    {detailer.name}
                </h3>

                <div className="flex items-center gap-2 mb-2">
                    <div className="flex items-center gap-1">
                        <Star className="w-4 h-4 fill-yellow-400 text-yellow-400" />
                        <span className="font-semibold">{detailer.rating}</span>
                    </div>
                    <span className="text-sm text-gray-500">({detailer.reviews})</span>
                </div>
                <div className="space-y-1 text-sm text-gray-600 mb-3">
                    <div className="flex items-center gap-1">
                        <MapPin className="w-4 h-4" />
                        <span>{detailer.serviceArea} • {detailer.distance} mi</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <Clock className="w-4 h-4" />
                        <span>{getProviderHours(detailer.defaultAvailability)}</span>
                    </div>
                </div>
                <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-500">Starting at</span>
                    <span className="font-bold text-lg text-gray-900">${detailer.price}</span>
                </div>
            </div>
        </div>
    );
}

function ProfileDropdown({ currentUser, onGoToDashboard, onLogout }) {
    const handleDashboardClick = () => {
        if (onGoToDashboard) {
            onGoToDashboard();
        }
    };

    const handleLogoutClick = () => {
        if (onLogout) {
            onLogout();
        }
    };

    return (
        <div className="absolute right-0 top-12 w-64 bg-white rounded-xl shadow-xl border border-gray-200 py-2 z-50 animate-fadeIn">
            <div className="px-4 py-3 border-b border-gray-100">
                <div className="font-semibold text-gray-900">{currentUser.name}</div>
                <div className="text-sm text-gray-500">{currentUser.email}</div>
            </div>

            <button
                onClick={handleDashboardClick}
                className="w-full px-4 py-3 text-left hover:bg-gray-50 flex items-center gap-3 text-gray-700"
            >
                <User className="w-5 h-5" />
                <span>My Dashboard</span>
            </button>

            <button
                onClick={handleLogoutClick}
                className="w-full px-4 py-3 text-left hover:bg-gray-50 flex items-center gap-3 text-red-600"
            >
                <LogOut className="w-5 h-5" />
                <span>Sign Out</span>
            </button>
        </div>
    );
}

// ==================== DETAILER PROFILE PAGE ====================
function DetailerProfilePage({ detailer, answers, address, setAddress, setAnswers, currentUser, onBack, onBook }) {
    const [activeTab, setActiveTab] = useState('about');

    return (
        <div className="min-h-screen bg-gray-50">
            {/* Glassmorphic Header */}
            <div className="sticky top-0 z-40 backdrop-blur-xl bg-gradient-to-r from-blue-600/90 via-blue-700/90 to-indigo-600/90 border-b border-blue-400/20 shadow-lg">
                <div className="max-w-6xl mx-auto px-4 py-4">
                    <button
                        onClick={onBack}
                        className="flex items-center gap-2 text-white font-semibold hover:text-blue-100 transition-colors drop-shadow-sm"
                    >
                        ← Back
                    </button>
                </div>
            </div>

            <div className="max-w-5xl mx-auto px-4 py-6 sm:py-8">
                {/* Profile Header Card */}
                <div className="bg-white rounded-xl border border-gray-200 shadow-md p-4 sm:p-6 mb-6">
                    <div className="flex items-start gap-3 sm:gap-4">
                        <div className="w-16 h-16 sm:w-20 sm:h-20 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-xl flex items-center justify-center flex-shrink-0 shadow-lg">
                            <span className="text-2xl sm:text-3xl font-bold text-white">
                                {detailer.name.charAt(0)}
                            </span>
                        </div>
                        <div className="flex-1 min-w-0">
                            <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-2 break-words">
                                {detailer.name}
                            </h1>
                            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-4 text-sm mb-3">
                                <div className="flex items-center gap-1">
                                    <Star className="w-4 h-4 sm:w-5 sm:h-5 text-yellow-500 fill-current" />
                                    <span className="font-semibold text-base sm:text-lg">{detailer.rating}</span>
                                    <span className="text-gray-500">({detailer.reviews} reviews)</span>
                                </div>
                                <span className="hidden sm:inline text-gray-400">•</span>
                                <div className="flex items-center gap-1 text-gray-600">
                                    <MapPin className="w-4 h-4 sm:w-5 sm:h-5" />
                                    <span>{detailer.distance} miles away</span>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <CheckCircle2 className="w-5 h-5 text-green-600" />
                                <span className="font-medium text-green-600">
                                    Available for your time slot
                                </span>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="grid lg:grid-cols-3 gap-4 sm:gap-6">
                    {/* Main Content with Tabs */}
                    <div className="lg:col-span-2">
                        {/* Tabs */}
                        <div className="bg-white rounded-t-xl border border-gray-200 border-b-0 shadow-sm">
                            <div className="flex overflow-x-auto scrollbar-hide">
                                <button
                                    onClick={() => setActiveTab('about')}
                                    className={`px-6 py-4 border-b-2 font-semibold transition-all whitespace-nowrap ${activeTab === 'about'
                                        ? 'border-blue-600 text-blue-600 bg-blue-50/50'
                                        : 'border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                                        }`}
                                >
                                    About
                                </button>
                                <button
                                    onClick={() => setActiveTab('services')}
                                    className={`px-6 py-4 border-b-2 font-semibold transition-all whitespace-nowrap ${activeTab === 'services'
                                        ? 'border-blue-600 text-blue-600 bg-blue-50/50'
                                        : 'border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                                        }`}
                                >
                                    Services
                                </button>
                                <button
                                    onClick={() => setActiveTab('photos')}
                                    className={`px-6 py-4 border-b-2 font-semibold transition-all whitespace-nowrap ${activeTab === 'photos'
                                        ? 'border-blue-600 text-blue-600 bg-blue-50/50'
                                        : 'border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                                        }`}
                                >
                                    Photos
                                </button>
                            </div>
                        </div>

                        {/* Tab Content */}
                        <div className="bg-white rounded-b-xl border border-gray-200 shadow-md p-4 sm:p-6 min-h-[400px]">
                            {activeTab === 'about' && (
                                <div>
                                    <h3 className="font-semibold text-gray-900 mb-4 text-lg">About</h3>
                                    <p className="text-gray-600 leading-relaxed">{detailer.about}</p>
                                </div>
                            )}

                            {activeTab === 'services' && (
                                <div>
                                    <h3 className="font-semibold text-gray-900 mb-4 text-lg">Services</h3>
                                    <div className="space-y-2 sm:space-y-3">
                                        {detailer.services.map((service, idx) => (
                                            <div
                                                key={idx}
                                                className="flex items-center justify-between p-3 sm:p-4 border border-gray-200 rounded-lg hover:border-blue-300 hover:shadow-sm transition-all"
                                            >
                                                <div className="flex-1 min-w-0 pr-2">
                                                    <div className="font-semibold text-gray-900 text-sm sm:text-base truncate">{service.name}</div>
                                                    <div className="text-xs sm:text-sm text-gray-500">{service.duration}</div>
                                                </div>
                                                <div className="text-right flex-shrink-0">
                                                    <div className="text-xl sm:text-2xl font-bold text-blue-600">${service.price}</div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {activeTab === 'photos' && (
                                <div>
                                    <h3 className="font-semibold text-gray-900 mb-4 text-lg">Recent Work</h3>
                                    {detailer.photos && detailer.photos.length > 0 ? (
                                        <div className="grid grid-cols-3 gap-3">
                                            {detailer.photos.map((photo, idx) => (
                                                <div key={idx} className="aspect-square bg-gray-200 rounded-lg overflow-hidden hover:scale-105 transition-transform shadow-md cursor-pointer">
                                                    <img src={photo} alt={`Work ${idx + 1}`} className="w-full h-full object-cover" />
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="text-center py-12">
                                            <Package className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                                            <p className="text-gray-500">No photos available</p>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Booking Sidebar */}
                    <div className="lg:col-span-1">
                        <BookingSidebar
                            detailer={detailer}
                            answers={answers}
                            address={address}
                            setAddress={setAddress}
                            setAnswers={setAnswers}
                            currentUser={currentUser}
                            onBook={onBook}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}

// ==================== CUSTOMER DASHBOARD ====================
function CustomerDashboard({ currentUser, onBackToMarketplace, onLogout, showProfileDropdown, setShowProfileDropdown, address, answers, userCoordinates }) {
    const [activeTab, setActiveTab] = useState('upcoming');
    const [loading, setLoading] = useState(true);
    const profileDropdownRef = React.useRef(null);

    // Real data from Firebase
    const [upcomingAppointments, setUpcomingAppointments] = useState([]);
    const [savedVehicles, setSavedVehicles] = useState([]);
    const [paymentMethods, setPaymentMethods] = useState([]);
    const [savedAddresses, setSavedAddresses] = useState([]);
    const [userData, setUserData] = useState(null);

    // Close dropdown when clicking outside
    useEffect(() => {
        function handleClickOutside(event) {
            if (profileDropdownRef.current && !profileDropdownRef.current.contains(event.target)) {
                setShowProfileDropdown(false);
            }
        }

        if (showProfileDropdown) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [showProfileDropdown, setShowProfileDropdown]);

    // Load user data and related info
    useEffect(() => {
        if (currentUser) {
            loadDashboardData();
        }
    }, [currentUser]);

    async function loadDashboardData() {
        setLoading(true);
        try {
            // Load user profile data
            const userQuery = query(
                collection(db, 'users'),
                where('uid', '==', currentUser.uid)
            );
            const userSnapshot = await getDocs(userQuery);

            let userId = null;
            if (!userSnapshot.empty) {
                const userDoc = userSnapshot.docs[0];
                userId = userDoc.id;
                setUserData({ id: userDoc.id, ...userDoc.data() });
            }

            // Load upcoming bookings
            await loadUpcomingAppointments();

            // Load saved vehicles (if you add this collection later)
            if (userId) {
                await loadSavedVehicles(userId);
            }

            // Load saved addresses (if you add this collection later)
            if (userId) {
                await loadSavedAddresses(userId);
            }

            // Note: Payment methods would come from Stripe, not Firebase
            // You'd need to call your Stripe API endpoint

        } catch (error) {
            console.error('Error loading dashboard data:', error);
        } finally {
            setLoading(false);
        }
    }

    async function loadUpcomingAppointments() {
        try {
            // Query bookings collection for this user's upcoming appointments
            const bookingsQuery = query(
                collection(db, 'bookings'),
                where('customerId', '==', currentUser.uid),
                where('status', 'in', ['pending', 'confirmed', 'scheduled'])
            );

            const bookingsSnapshot = await getDocs(bookingsQuery);

            const appointments = await Promise.all(
                bookingsSnapshot.docs.map(async (bookingDoc) => {
                    const booking = bookingDoc.data();

                    // Get provider details
                    let providerName = 'Unknown Provider';
                    if (booking.providerId) {
                        const providerDoc = await getDocs(
                            query(collection(db, 'providers'), where('userId', '==', booking.providerId))
                        );
                        if (!providerDoc.empty) {
                            providerName = providerDoc.docs[0].data().businessName;
                        }
                    }

                    return {
                        id: bookingDoc.id,
                        detailerName: providerName,
                        service: booking.services && booking.services.length > 0
                            ? booking.services.map(s => s.name).join(', ')
                            : booking.serviceName || 'Service',
                        services: booking.services || (booking.serviceName ? [{ name: booking.serviceName, price: booking.price }] : []),
                        date: booking.date ? new Date(booking.date).toLocaleDateString() : 'TBD',
                        time: booking.time || 'TBD',
                        price: booking.price || 0,
                        address: booking.address || 'N/A',
                        status: booking.status
                    };
                })
            );

            setUpcomingAppointments(appointments);
        } catch (error) {
            console.error('Error loading appointments:', error);
            setUpcomingAppointments([]);
        }
    }

    async function loadSavedVehicles(userId) {
        if (!userId) {
            setSavedVehicles([]);
            return;
        }
        try {
            // Check if vehicles subcollection exists
            const vehiclesSnapshot = await getDocs(
                collection(db, 'users', userId, 'vehicles')
            );

            const vehicles = vehiclesSnapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));

            setSavedVehicles(vehicles);
        } catch (error) {
            // Collection doesn't exist yet - that's fine
            setSavedVehicles([]);
        }
    }

    async function loadSavedAddresses(userId) {
        if (!userId) {
            setSavedAddresses([]);
            return;
        }
        try {
            // Check if addresses subcollection exists
            const addressesSnapshot = await getDocs(
                collection(db, 'users', userId, 'addresses')
            );

            const addresses = addressesSnapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));

            setSavedAddresses(addresses);
        } catch (error) {
            // Collection doesn't exist yet - that's fine
            setSavedAddresses([]);
        }
    }

    if (loading) {
        return (
            <div className="min-h-screen bg-gray-50 flex items-center justify-center">
                <div className="text-center">
                    <div className="w-16 h-16 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
                    <p className="text-gray-600">Loading your dashboard...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gray-50">
            {/* Glassmorphic Header */}
            <div className="sticky top-0 z-40 backdrop-blur-xl bg-gradient-to-r from-blue-600/90 via-blue-700/90 to-indigo-600/90 border-b border-blue-400/20 shadow-lg">
                <div className="max-w-6xl mx-auto px-4 py-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                            <button
                                onClick={onBackToMarketplace}
                                className="text-white font-semibold hover:text-blue-100 transition-colors drop-shadow-sm"
                            >
                                ← Back
                            </button>
                            <h1 className="text-2xl font-bold text-white drop-shadow-md">My Dashboard</h1>
                        </div>

                        <div className="relative" ref={profileDropdownRef}>
                            <button
                                onClick={() => setShowProfileDropdown(!showProfileDropdown)}
                                className="w-11 h-11 bg-gradient-to-br from-purple-500 to-pink-500 rounded-full flex items-center justify-center text-white font-semibold hover:from-purple-600 hover:to-pink-600 transition-all shadow-lg hover:shadow-xl transform hover:scale-105 ring-2 ring-white/30"
                            >
                                {currentUser?.initials || (currentUser?.name ? currentUser.name.substring(0, 2).toUpperCase() : 'ME')}
                            </button>
                            {showProfileDropdown && (
                                <ProfileDropdown
                                    currentUser={currentUser}
                                    onGoToDashboard={() => { setShowProfileDropdown(false); }}
                                    onLogout={onLogout}
                                />
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* User Info Banner */}
            {userData && (
                <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white">
                    <div className="max-w-6xl mx-auto px-4 py-6">
                        <h2 className="text-3xl font-bold mb-2">
                            Welcome back, {userData.firstName || currentUser.name}!
                        </h2>
                        <div className="flex items-center gap-4 text-blue-100">
                            <span>{userData.email}</span>
                            {userData.phone && (
                                <>
                                    <span>•</span>
                                    <span>{userData.phone}</span>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Tabs */}
            <div className="bg-white border-b border-gray-200">
                <div className="max-w-6xl mx-auto px-4">
                    <div className="flex gap-8">
                        <button
                            onClick={() => setActiveTab('upcoming')}
                            className={`py-4 border-b-2 font-semibold transition-colors ${activeTab === 'upcoming'
                                ? 'border-blue-600 text-blue-600'
                                : 'border-transparent text-gray-600 hover:text-gray-900'
                                }`}
                        >
                            Upcoming
                        </button>
                        <button
                            onClick={() => setActiveTab('vehicles')}
                            className={`py-4 border-b-2 font-semibold transition-colors ${activeTab === 'vehicles'
                                ? 'border-blue-600 text-blue-600'
                                : 'border-transparent text-gray-600 hover:text-gray-900'
                                }`}
                        >
                            Vehicles
                        </button>
                        <button
                            onClick={() => setActiveTab('addresses')}
                            className={`py-4 border-b-2 font-semibold transition-colors ${activeTab === 'addresses'
                                ? 'border-blue-600 text-blue-600'
                                : 'border-transparent text-gray-600 hover:text-gray-900'
                                }`}
                        >
                            Addresses
                        </button>
                        <button
                            onClick={() => setActiveTab('profile')}
                            className={`py-4 border-b-2 font-semibold transition-colors ${activeTab === 'profile'
                                ? 'border-blue-600 text-blue-600'
                                : 'border-transparent text-gray-600 hover:text-gray-900'
                                }`}
                        >
                            Profile
                        </button>
                        <button
                            onClick={() => setActiveTab('payment')}
                            className={`py-4 border-b-2 font-semibold transition-colors ${activeTab === 'payment'
                                ? 'border-blue-600 text-blue-600'
                                : 'border-transparent text-gray-600 hover:text-gray-900'
                                }`}
                        >
                            Payment Methods
                        </button>
                    </div>
                </div>
            </div>

            {/* Content */}
            <div className="max-w-6xl mx-auto px-4 py-8">
                {activeTab === 'upcoming' && (
                    <UpcomingAppointments
                        appointments={upcomingAppointments}
                        onRefresh={loadUpcomingAppointments}
                    />
                )}
                {activeTab === 'vehicles' && (
                    <SavedVehicles
                        vehicles={savedVehicles}
                        userData={userData}
                        onRefresh={() => userData?.id && loadSavedVehicles(userData.id)}
                    />
                )}
                {activeTab === 'addresses' && (
                    <SavedAddresses
                        addresses={savedAddresses}
                        userData={userData}
                        onRefresh={() => userData?.id && loadSavedAddresses(userData.id)}
                    />
                )}
                {activeTab === 'profile' && (
                    <UserProfile
                        userData={userData}
                        currentUser={currentUser}
                        address={address}
                        answers={answers}
                        userCoordinates={userCoordinates}
                    />
                )}
                {activeTab === 'payment' && (
                    <PaymentMethods
                        methods={paymentMethods}
                        currentUser={currentUser}
                    />
                )}
            </div>
        </div>
    );
}

function UpcomingAppointments({ appointments, onRefresh }) {
    async function handleCancelBooking(appointmentId) {
        if (!confirm('Are you sure you want to cancel this appointment?')) return;

        try {
            await updateDoc(doc(db, 'bookings', appointmentId), {
                status: 'cancelled',
                cancelledAt: serverTimestamp()
            });
            alert('Appointment cancelled successfully');
            onRefresh();
        } catch (error) {
            console.error('Error cancelling appointment:', error);
            alert('Failed to cancel appointment');
        }
    }

    return (
        <div>
            <div className="flex items-center justify-between mb-6">
                <h2 className="text-2xl font-bold text-gray-900">Upcoming Appointments</h2>
                <button
                    onClick={onRefresh}
                    className="px-4 py-2 text-sm border-2 border-gray-200 rounded-lg font-medium hover:bg-gray-50"
                >
                    Refresh
                </button>
            </div>

            {appointments.length === 0 ? (
                <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
                    <Calendar className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                    <h3 className="text-xl font-semibold text-gray-900 mb-2">No upcoming appointments</h3>
                    <p className="text-gray-600 mb-4">Book a detailing service to get started</p>
                    <button
                        onClick={() => window.location.reload()}
                        className="px-6 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700"
                    >
                        Browse Detailers
                    </button>
                </div>
            ) : (
                <div className="space-y-4">
                    {appointments.map((apt) => (
                        <div key={apt.id} className="bg-white rounded-xl border border-gray-200 p-6">
                            <div className="flex items-start justify-between mb-4">
                                <div>
                                    <h3 className="text-xl font-bold text-gray-900">{apt.detailerName}</h3>
                                    <p className="text-gray-600">{apt.service}</p>
                                    <span className={`inline-block mt-2 px-3 py-1 rounded-full text-sm font-medium ${apt.status === 'confirmed' ? 'bg-green-100 text-green-700' :
                                        apt.status === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                                            'bg-blue-100 text-blue-700'
                                        }`}>
                                        {apt.status.charAt(0).toUpperCase() + apt.status.slice(1)}
                                    </span>
                                </div>
                                <div className="text-right">
                                    <div className="text-2xl font-bold text-gray-900">${apt.price}</div>
                                </div>
                            </div>

                            <div className="grid grid-cols-3 gap-4 text-sm mb-4">
                                <div className="flex items-center gap-2">
                                    <Calendar className="w-4 h-4 text-gray-400" />
                                    <span>{apt.date}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Clock className="w-4 h-4 text-gray-400" />
                                    <span>{apt.time}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <MapPin className="w-4 h-4 text-gray-400" />
                                    <span className="truncate">{apt.address}</span>
                                </div>
                            </div>

                            <div className="flex gap-3 pt-4 border-t border-gray-100">
                                <button
                                    className="flex-1 px-4 py-2 border-2 border-gray-200 rounded-lg font-semibold hover:bg-gray-50"
                                    onClick={() => alert('Reschedule feature coming soon!')}
                                >
                                    Reschedule
                                </button>
                                <button
                                    onClick={() => handleCancelBooking(apt.id)}
                                    className="flex-1 px-4 py-2 bg-red-50 text-red-600 rounded-lg font-semibold hover:bg-red-100"
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function SavedVehicles({ vehicles, userData, onRefresh }) {
    const [showAddModal, setShowAddModal] = useState(false);
    const [editingVehicle, setEditingVehicle] = useState(null);
    const [vehicleData, setVehicleData] = useState({
        make: '',
        model: '',
        year: '',
        color: ''
    });

    async function handleSaveVehicle() {
        if (!userData?.id) {
            alert('User data not loaded');
            return;
        }

        if (!vehicleData.make || !vehicleData.model || !vehicleData.year) {
            alert('Please fill in all required fields');
            return;
        }

        try {
            if (editingVehicle) {
                // Update existing vehicle
                await updateDoc(
                    doc(db, 'users', userData.id, 'vehicles', editingVehicle.id),
                    vehicleData
                );
                alert('Vehicle updated successfully!');
            } else {
                // Add new vehicle
                await addDoc(
                    collection(db, 'users', userData.id, 'vehicles'),
                    {
                        ...vehicleData,
                        createdAt: serverTimestamp()
                    }
                );
                alert('Vehicle added successfully!');
            }

            setShowAddModal(false);
            setEditingVehicle(null);
            setVehicleData({ make: '', model: '', year: '', color: '' });
            onRefresh();
        } catch (error) {
            console.error('Error saving vehicle:', error);
            alert('Failed to save vehicle');
        }
    }

    async function handleDeleteVehicle(vehicleId) {
        if (!confirm('Are you sure you want to delete this vehicle?')) return;

        try {
            await deleteDoc(doc(db, 'users', userData.id, 'vehicles', vehicleId));
            alert('Vehicle deleted successfully!');
            onRefresh();
        } catch (error) {
            console.error('Error deleting vehicle:', error);
            alert('Failed to delete vehicle');
        }
    }

    function openEditModal(vehicle) {
        setEditingVehicle(vehicle);
        setVehicleData({
            make: vehicle.make,
            model: vehicle.model,
            year: vehicle.year,
            color: vehicle.color
        });
        setShowAddModal(true);
    }

    return (
        <div>
            <div className="flex items-center justify-between mb-6">
                <h2 className="text-2xl font-bold text-gray-900">Saved Vehicles</h2>
                <button
                    onClick={() => {
                        setEditingVehicle(null);
                        setVehicleData({ make: '', model: '', year: '', color: '' });
                        setShowAddModal(true);
                    }}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700"
                >
                    <Plus className="w-5 h-5" />
                    Add Vehicle
                </button>
            </div>

            {vehicles.length === 0 ? (
                <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
                    <Car className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                    <h3 className="text-xl font-semibold text-gray-900 mb-2">No saved vehicles</h3>
                    <p className="text-gray-600 mb-4">Add your vehicles for faster booking</p>
                    <button
                        onClick={() => setShowAddModal(true)}
                        className="px-6 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700"
                    >
                        Add Your First Vehicle
                    </button>
                </div>
            ) : (
                <div className="grid md:grid-cols-2 gap-4">
                    {vehicles.map((vehicle) => (
                        <div key={vehicle.id} className="bg-white rounded-xl border border-gray-200 p-6">
                            <div className="flex items-start justify-between mb-4">
                                <div>
                                    <h3 className="text-xl font-bold text-gray-900">
                                        {vehicle.year} {vehicle.make} {vehicle.model}
                                    </h3>
                                    {vehicle.color && <p className="text-gray-600">{vehicle.color}</p>}
                                </div>
                                <Car className="w-8 h-8 text-gray-400" />
                            </div>

                            <div className="flex gap-2">
                                <button
                                    onClick={() => openEditModal(vehicle)}
                                    className="flex items-center gap-2 px-3 py-2 border-2 border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-50"
                                >
                                    <Edit2 className="w-4 h-4" />
                                    Edit
                                </button>
                                <button
                                    onClick={() => handleDeleteVehicle(vehicle.id)}
                                    className="flex items-center gap-2 px-3 py-2 border-2 border-red-200 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50"
                                >
                                    <Trash2 className="w-4 h-4" />
                                    Delete
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Add/Edit Vehicle Modal */}
            {showAddModal && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
                    <div className="bg-white rounded-2xl max-w-md w-full p-8 relative">
                        <button
                            onClick={() => {
                                setShowAddModal(false);
                                setEditingVehicle(null);
                            }}
                            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
                        >
                            <X className="w-6 h-6" />
                        </button>

                        <h2 className="text-2xl font-bold text-gray-900 mb-6">
                            {editingVehicle ? 'Edit Vehicle' : 'Add Vehicle'}
                        </h2>

                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Make *
                                </label>
                                <input
                                    type="text"
                                    value={vehicleData.make}
                                    onChange={(e) => setVehicleData({ ...vehicleData, make: e.target.value })}
                                    placeholder="Tesla, Honda, Ford..."
                                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Model *
                                </label>
                                <input
                                    type="text"
                                    value={vehicleData.model}
                                    onChange={(e) => setVehicleData({ ...vehicleData, model: e.target.value })}
                                    placeholder="Model 3, Civic, F-150..."
                                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Year *
                                </label>
                                <input
                                    type="number"
                                    value={vehicleData.year}
                                    onChange={(e) => setVehicleData({ ...vehicleData, year: e.target.value })}
                                    placeholder="2023"
                                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Color
                                </label>
                                <input
                                    type="text"
                                    value={vehicleData.color}
                                    onChange={(e) => setVehicleData({ ...vehicleData, color: e.target.value })}
                                    placeholder="White, Black, Red..."
                                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                                />
                            </div>
                        </div>

                        <button
                            onClick={handleSaveVehicle}
                            className="w-full mt-6 bg-blue-600 text-white py-3 rounded-xl font-semibold hover:bg-blue-700"
                        >
                            {editingVehicle ? 'Update Vehicle' : 'Add Vehicle'}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

function PaymentMethods({ methods, currentUser }) {
    const paymentMethods = methods || [];

    return (
        <div>
            <div className="flex items-center justify-between mb-6">
                <h2 className="text-2xl font-bold text-gray-900">Payment Methods</h2>
                <button className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700">
                    <Plus className="w-5 h-5" />
                    Add Payment Method
                </button>
            </div>

            {paymentMethods.length === 0 ? (
                <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
                    <CreditCard className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                    <h3 className="text-xl font-semibold text-gray-900 mb-2">No payment methods</h3>
                    <p className="text-gray-600 mb-4">Add a payment method to make booking easier</p>
                    <button className="px-6 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700">
                        Add Payment Method
                    </button>
                </div>
            ) : (
                <div className="space-y-4">
                    {paymentMethods.map((method) => (
                        <div key={method.id} className="bg-white rounded-xl border border-gray-200 p-6">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-4">
                                    <CreditCard className="w-8 h-8 text-gray-400" />
                                    <div>
                                        <div className="font-semibold text-gray-900">
                                            {method.type} •••• {method.last4}
                                        </div>
                                        <div className="text-sm text-gray-500">Expires {method.expiry}</div>
                                    </div>
                                </div>

                                <button className="px-3 py-2 border-2 border-red-200 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50">
                                    Remove
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function SavedAddresses({ addresses, userData, onRefresh }) {
    const [showAddModal, setShowAddModal] = useState(false);
    const [editingAddress, setEditingAddress] = useState(null);
    const [addressData, setAddressData] = useState({
        label: '',
        address: ''
    });

    async function handleSaveAddress() {
        if (!userData?.id) {
            alert('User data not loaded');
            return;
        }

        if (!addressData.label || !addressData.address) {
            alert('Please fill in all fields');
            return;
        }

        try {
            if (editingAddress) {
                await updateDoc(
                    doc(db, 'users', userData.id, 'addresses', editingAddress.id),
                    addressData
                );
                alert('Address updated successfully!');
            } else {
                await addDoc(
                    collection(db, 'users', userData.id, 'addresses'),
                    {
                        ...addressData,
                        createdAt: serverTimestamp()
                    }
                );
                alert('Address added successfully!');
            }

            setShowAddModal(false);
            setEditingAddress(null);
            setAddressData({ label: '', address: '' });
            onRefresh();
        } catch (error) {
            console.error('Error saving address:', error);
            alert('Failed to save address');
        }
    }

    async function handleDeleteAddress(addressId) {
        if (!confirm('Are you sure you want to delete this address?')) return;

        try {
            await deleteDoc(doc(db, 'users', userData.id, 'addresses', addressId));
            alert('Address deleted successfully!');
            onRefresh();
        } catch (error) {
            console.error('Error deleting address:', error);
            alert('Failed to delete address');
        }
    }

    function openEditModal(address) {
        setEditingAddress(address);
        setAddressData({
            label: address.label,
            address: address.address
        });
        setShowAddModal(true);
    }

    return (
        <div>
            <div className="flex items-center justify-between mb-6">
                <h2 className="text-2xl font-bold text-gray-900">Saved Addresses</h2>
                <button
                    onClick={() => {
                        setEditingAddress(null);
                        setAddressData({ label: '', address: '' });
                        setShowAddModal(true);
                    }}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700"
                >
                    <Plus className="w-5 h-5" />
                    Add Address
                </button>
            </div>

            {addresses.length === 0 ? (
                <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
                    <Home className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                    <h3 className="text-xl font-semibold text-gray-900 mb-2">No saved addresses</h3>
                    <p className="text-gray-600 mb-4">Save addresses for faster booking</p>
                    <button
                        onClick={() => setShowAddModal(true)}
                        className="px-6 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700"
                    >
                        Add Your First Address
                    </button>
                </div>
            ) : (
                <div className="space-y-4">
                    {addresses.map((addr) => (
                        <div key={addr.id} className="bg-white rounded-xl border border-gray-200 p-6">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-4">
                                    <Home className="w-8 h-8 text-gray-400" />
                                    <div>
                                        <div className="font-semibold text-gray-900">{addr.label}</div>
                                        <div className="text-sm text-gray-500">{addr.address}</div>
                                    </div>
                                </div>

                                <div className="flex gap-2">
                                    <button
                                        onClick={() => openEditModal(addr)}
                                        className="px-3 py-2 border-2 border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-50"
                                    >
                                        Edit
                                    </button>
                                    <button
                                        onClick={() => handleDeleteAddress(addr.id)}
                                        className="px-3 py-2 border-2 border-red-200 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50"
                                    >
                                        Remove
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Add/Edit Address Modal */}
            {showAddModal && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
                    <div className="bg-white rounded-2xl max-w-md w-full p-8 relative">
                        <button
                            onClick={() => {
                                setShowAddModal(false);
                                setEditingAddress(null);
                            }}
                            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
                        >
                            <X className="w-6 h-6" />
                        </button>

                        <h2 className="text-2xl font-bold text-gray-900 mb-6">
                            {editingAddress ? 'Edit Address' : 'Add Address'}
                        </h2>

                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Label *
                                </label>
                                <input
                                    type="text"
                                    value={addressData.label}
                                    onChange={(e) => setAddressData({ ...addressData, label: e.target.value })}
                                    placeholder="Home, Work, Parent's House..."
                                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Address *
                                </label>
                                <textarea
                                    value={addressData.address}
                                    onChange={(e) => setAddressData({ ...addressData, address: e.target.value })}
                                    placeholder="123 Main St, City, ST 12345"
                                    rows="3"
                                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                                />
                            </div>
                        </div>

                        <button
                            onClick={handleSaveAddress}
                            className="w-full mt-6 bg-blue-600 text-white py-3 rounded-xl font-semibold hover:bg-blue-700"
                        >
                            {editingAddress ? 'Update Address' : 'Add Address'}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

function UserProfile({ userData, currentUser, address, answers, userCoordinates }) {
    const [isEditingPreferences, setIsEditingPreferences] = useState(false);
    const [editedAddress, setEditedAddress] = useState('');
    const [editedPreferences, setEditedPreferences] = useState({
        vehicleType: '',
        serviceType: '',
        timeSlot: ''
    });

    useEffect(() => {
        if (userData) {
            setEditedAddress(userData.address || '');
            setEditedPreferences(userData.preferences || {
                vehicleType: '',
                serviceType: '',
                timeSlot: ''
            });
        }
    }, [userData]);

    async function handleSavePreferences() {
        if (!userData?.id) return;

        try {
            const userDocRef = doc(db, 'users', userData.id);
            await updateDoc(userDocRef, {
                address: editedAddress,
                preferences: editedPreferences,
                updatedAt: serverTimestamp()
            });

            alert('Preferences updated successfully!');
            setIsEditingPreferences(false);
            window.location.reload(); // Reload to show updated data
        } catch (error) {
            console.error('Error updating preferences:', error);
            alert('Failed to update preferences');
        }
    }

    if (!userData) {
        return (
            <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
                <p className="text-gray-600">Loading profile...</p>
            </div>
        );
    }

    return (
        <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-6">Profile Information</h2>


            {/* Personal Info */}
            <div className="bg-white rounded-xl border border-gray-200 p-8 mb-6">
                <h3 className="text-lg font-bold text-gray-900 mb-4">Personal Information</h3>
                <div className="max-w-2xl">
                    <div className="grid grid-cols-2 gap-6">
                        <div>
                            <label className="block text-sm font-medium text-gray-500 mb-1">
                                First Name
                            </label>
                            <div className="text-lg font-semibold text-gray-900">
                                {userData.firstName || 'Not set'}
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-500 mb-1">
                                Last Name
                            </label>
                            <div className="text-lg font-semibold text-gray-900">
                                {userData.lastName || 'Not set'}
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-500 mb-1">
                                Email
                            </label>
                            <div className="text-lg font-semibold text-gray-900">
                                {userData.email}
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-500 mb-1">
                                Phone
                            </label>
                            <div className="text-lg font-semibold text-gray-900">
                                {userData.phone || 'Not set'}
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-500 mb-1">
                                Account Type
                            </label>
                            <div className="text-lg font-semibold text-gray-900 capitalize">
                                {userData.accountType || 'customer'}
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-500 mb-1">
                                Member Since
                            </label>
                            <div className="text-lg font-semibold text-gray-900">
                                {userData.createdAt ? new Date(userData.createdAt.seconds * 1000).toLocaleDateString() : 'N/A'}
                            </div>
                        </div>
                    </div>

                    <div className="mt-8 pt-8 border-t border-gray-200">
                        <button
                            onClick={() => alert('Profile editing feature coming soon!')}
                            className="px-6 py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700"
                        >
                            Edit Profile
                        </button>
                    </div>
                </div>
            </div>

            {/* Booking Preferences */}
            <div className="bg-white rounded-xl border border-gray-200 p-8">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-bold text-gray-900">Booking Preferences</h3>
                    {!isEditingPreferences && (
                        <button
                            onClick={() => setIsEditingPreferences(true)}
                            className="flex items-center gap-2 px-4 py-2 border-2 border-gray-200 rounded-lg font-semibold hover:bg-gray-50"
                        >
                            <Edit2 className="w-4 h-4" />
                            Edit
                        </button>
                    )}
                </div>

                {!isEditingPreferences ? (
                    <div className="max-w-2xl space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-500 mb-1">
                                Default Address
                            </label>
                            <div className="text-lg text-gray-900">
                                {userData.address || 'Not set'}
                            </div>
                        </div>

                        {userData.preferences && (
                            <>
                                <div>
                                    <label className="block text-sm font-medium text-gray-500 mb-1">
                                        Preferred Vehicle Type
                                    </label>
                                    <div className="text-lg text-gray-900">
                                        {userData.preferences.vehicleType || 'Not set'}
                                    </div>
                                </div>

                                <div>
                                    <label className="block text-sm font-medium text-gray-500 mb-1">
                                        Preferred Service Type
                                    </label>
                                    <div className="text-lg text-gray-900">
                                        {userData.preferences.serviceType || 'Not set'}
                                    </div>
                                </div>

                                <div>
                                    <label className="block text-sm font-medium text-gray-500 mb-1">
                                        Preferred Time Slot
                                    </label>
                                    <div className="text-lg text-gray-900">
                                        {userData.preferences.timeSlot || 'Not set'}
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                ) : (
                    <div className="max-w-2xl space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                Default Address
                            </label>
                            <input
                                type="text"
                                value={editedAddress}
                                onChange={(e) => setEditedAddress(e.target.value)}
                                placeholder="123 Main St, City, State ZIP"
                                className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                Preferred Vehicle Type
                            </label>
                            <select
                                value={editedPreferences.vehicleType}
                                onChange={(e) => setEditedPreferences({ ...editedPreferences, vehicleType: e.target.value })}
                                className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                            >
                                <option value="">Select vehicle type</option>
                                <option value="Sedan">Sedan</option>
                                <option value="SUV">SUV</option>
                                <option value="Truck">Truck</option>
                                <option value="Sports Car">Sports Car</option>
                                <option value="Van">Van</option>
                                <option value="Motorcycle">Motorcycle</option>
                            </select>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                Preferred Service Type
                            </label>
                            <select
                                value={editedPreferences.serviceType}
                                onChange={(e) => setEditedPreferences({ ...editedPreferences, serviceType: e.target.value })}
                                className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                            >
                                <option value="">Select service type</option>
                                <option value="Full Detail">Full Detail</option>
                                <option value="Exterior Only">Exterior Only</option>
                                <option value="Interior Only">Interior Only</option>
                                <option value="Paint Correction">Paint Correction</option>
                                <option value="Ceramic Coating">Ceramic Coating</option>
                                <option value="Basic Wash">Basic Wash</option>
                            </select>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                Preferred Time Slot
                            </label>
                            <select
                                value={editedPreferences.timeSlot}
                                onChange={(e) => setEditedPreferences({ ...editedPreferences, timeSlot: e.target.value })}
                                className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                            >
                                <option value="">Select time slot</option>
                                <option value="Morning (8am-12pm)">Morning (8am-12pm)</option>
                                <option value="Afternoon (12pm-4pm)">Afternoon (12pm-4pm)</option>
                                <option value="Evening (4pm-8pm)">Evening (4pm-8pm)</option>
                                <option value="Flexible">Flexible</option>
                            </select>
                        </div>

                        <div className="flex gap-3 pt-4">
                            <button
                                onClick={handleSavePreferences}
                                className="px-6 py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700"
                            >
                                Save Changes
                            </button>
                            <button
                                onClick={() => setIsEditingPreferences(false)}
                                className="px-6 py-3 border-2 border-gray-200 rounded-lg font-semibold hover:bg-gray-50"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}

                <div className="mt-6 p-4 bg-blue-50 rounded-lg">
                    <p className="text-sm text-blue-900">
                        💡 <strong>Tip:</strong> These preferences are used to pre-fill your booking information. You can always change them when making a booking.
                    </p>
                </div>
            </div>
        </div>
    );
}

function BookingHistory({ history }) {
    return (
        <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-6">Booking History</h2>

            <div className="space-y-4">
                {history.slice(0, 5).map((booking) => (
                    <div key={booking.id} className="bg-white rounded-xl border border-gray-200 p-6">
                        <div className="flex items-start justify-between mb-3">
                            <div>
                                <h3 className="font-bold text-gray-900">{booking.detailerName}</h3>
                                {booking.services && booking.services.length > 0 ? (
                                    <div className="space-y-1">
                                        {booking.services.map((service, idx) => (
                                            <p key={idx} className="text-gray-600">
                                                {service.name} {service.price ? `- $${service.price}` : ''}
                                            </p>
                                        ))}
                                    </div>
                                ) : (
                                    <p className="text-gray-600">{booking.service}</p>
                                )}
                            </div>
                            <div className="text-right">
                                <div className="font-bold text-gray-900">${booking.price}</div>
                                <div className="text-sm text-green-600">{booking.status}</div>
                            </div>
                        </div>

                        <div className="flex items-center gap-2 text-sm text-gray-500">
                            <Calendar className="w-4 h-4" />
                            <span>{booking.date}</span>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ==================== PROVIDER DASHBOARD ====================
function ProviderDashboard({ currentUser, onBackToMarketplace, onLogout, showProfileDropdown, setShowProfileDropdown }) {
    const [activeTab, setActiveTab] = useState('bookings');
    const [loading, setLoading] = useState(true);
    const [bookings, setBookings] = useState([]);
    const [providerData, setProviderData] = useState(null);
    const [userData, setUserData] = useState(null);
    const [services, setServices] = useState([]);
    const [editingService, setEditingService] = useState(null);
    const [showEditModal, setShowEditModal] = useState(false);
    const [weeklySchedule, setWeeklySchedule] = useState({});
    const [blackoutDates, setBlackoutDates] = useState([]);
    const [selectedBlackoutDate, setSelectedBlackoutDate] = useState('');
    const [showBlackoutModal, setShowBlackoutModal] = useState(false);
    const [pendingProviders, setPendingProviders] = useState([]);
    const [loadingPending, setLoadingPending] = useState(false);
    const profileDropdownRef = React.useRef(null);

    // Close dropdown when clicking outside
    useEffect(() => {
        function handleClickOutside(event) {
            if (profileDropdownRef.current && !profileDropdownRef.current.contains(event.target)) {
                setShowProfileDropdown(false);
            }
        }

        if (showProfileDropdown) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [showProfileDropdown, setShowProfileDropdown]);

    async function loadPendingProviders() {
        if (userData?.role !== 'admin') return;  // Change from currentUser?.role

        setLoadingPending(true);
        try {
            const pendingQuery = query(
                collection(db, 'providers'),
                where('status', '==', 'pending')
            );
            const snapshot = await getDocs(pendingQuery);

            const pending = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));

            setPendingProviders(pending);
        } catch (error) {
            console.error('Error loading pending providers:', error);
        } finally {
            setLoadingPending(false);
        }
    }

    useEffect(() => {
        if (currentUser) {
            loadProviderData();
        }
    }, [currentUser]);

    // Add separate useEffect for admin check after userData loads:
    useEffect(() => {
        if (userData?.role === 'admin') {
            loadPendingProviders();
        }
    }, [userData]);

    // Reload pending providers when admin tab is activated
    useEffect(() => {
        if (activeTab === 'admin' && userData?.role === 'admin') {  // Change to userData
            loadPendingProviders();
        }
    }, [activeTab, userData]);  // Add userData to dependencies

    async function loadProviderData() {
        setLoading(true);
        try {
            // Load user data
            const userQuery = query(
                collection(db, 'users'),
                where('uid', '==', currentUser.uid)
            );
            const userSnapshot = await getDocs(userQuery);
            if (!userSnapshot.empty) {
                const data = userSnapshot.docs[0].data();
                setUserData({ id: userSnapshot.docs[0].id, ...data });
            }

            // Load provider data
            const providerQuery = query(
                collection(db, 'providers'),
                where('userId', '==', currentUser.uid)
            );
            const providerSnapshot = await getDocs(providerQuery);
            if (!providerSnapshot.empty) {
                const data = providerSnapshot.docs[0].data();
                setProviderData(data);
                setServices(data.services || []); // Load services

                // Load availability and ensure enabled days have start/end times
                const defaultAvail = data.defaultAvailability || {};
                // Normalize the schedule - ensure enabled days have start/end times
                const normalizedSchedule = {};
                Object.keys(defaultAvail).forEach(day => {
                    const daySchedule = defaultAvail[day];
                    if (daySchedule && daySchedule.enabled) {
                        normalizedSchedule[day] = {
                            enabled: true,
                            start: daySchedule.start || '09:00',
                            end: daySchedule.end || '17:00'
                        };
                    } else {
                        normalizedSchedule[day] = daySchedule;
                    }
                });
                setWeeklySchedule(normalizedSchedule);

                // Convert dateOverrides object to array for easier management
                const overrides = data.dateOverrides || {};
                const blackouts = Object.keys(overrides)
                    .filter(date => overrides[date]?.type === 'unavailable')
                    .map(date => ({ date, type: 'unavailable' }));
                setBlackoutDates(blackouts);
            }

            // Load bookings for this provider
            await loadBookings();
        } catch (error) {
            console.error('Error loading provider data:', error);
        } finally {
            setLoading(false);
        }
    }

    async function loadBookings() {
        try {
            // First, get the provider document to find the provider document ID
            const providerQuery = query(
                collection(db, 'providers'),
                where('userId', '==', currentUser.uid)
            );
            const providerSnapshot = await getDocs(providerQuery);

            const providerDocId = !providerSnapshot.empty ? providerSnapshot.docs[0].id : null;
            const providerUserId = !providerSnapshot.empty ? providerSnapshot.docs[0].data().userId : currentUser.uid;

            // Query by providerUserId first (this is what new bookings use)
            let bookingsByUserId = { docs: [] };
            try {
                const bookingsQueryByUserId = query(
                    collection(db, 'bookings'),
                    where('providerUserId', '==', providerUserId)
                );
                bookingsByUserId = await getDocs(bookingsQueryByUserId);
            } catch (err) {
                console.warn('Could not query by providerUserId:', err);
            }

            // Also query by providerId if we have a provider document
            // Note: This query may fail due to security rules if providerUserId isn't set correctly
            // It's a fallback, so we'll fail silently
            let bookingsById = { docs: [] };
            if (providerDocId) {
                try {
                    const bookingsQueryById = query(
                        collection(db, 'bookings'),
                        where('providerId', '==', providerDocId)
                    );
                    bookingsById = await getDocs(bookingsQueryById);
                } catch (err) {
                    // Silently fail - this is expected if security rules don't allow querying by providerId alone
                    // The primary query by providerUserId should work
                    if (err.code !== 'permission-denied') {
                        console.warn('Could not query by providerId:', err);
                    }
                }
            }

            // Combine results and remove duplicates
            let allBookingDocs = [...bookingsByUserId.docs];
            const existingIds = new Set(bookingsByUserId.docs.map(d => d.id));

            bookingsById.docs.forEach(doc => {
                if (!existingIds.has(doc.id)) {
                    allBookingDocs.push(doc);
                }
            });

            // Note: Removed fallback search that queries all bookings due to permission restrictions
            // If bookings aren't showing up, check that:
            // 1. providerUserId in booking matches the provider's userId field
            // 2. providerId in booking matches the provider document ID

            const bookingsSnapshot = {
                docs: allBookingDocs
            };

            const bookingsList = await Promise.all(
                bookingsSnapshot.docs.map(async (bookingDoc) => {
                    const booking = bookingDoc.data();

                    // Get customer details
                    let customerName = 'Unknown Customer';
                    let customerEmail = '';
                    let customerPhone = '';
                    if (booking.customerId) {
                        const customerQuery = query(
                            collection(db, 'users'),
                            where('uid', '==', booking.customerId)
                        );
                        const customerSnapshot = await getDocs(customerQuery);
                        if (!customerSnapshot.empty) {
                            const customerData = customerSnapshot.docs[0].data();
                            customerName = customerData.firstName && customerData.lastName
                                ? `${customerData.firstName} ${customerData.lastName}`
                                : customerData.displayName || customerData.email || 'Unknown';
                            customerEmail = customerData.email || '';
                            customerPhone = customerData.phone || '';
                        }
                    }

                    return {
                        id: bookingDoc.id,
                        customerName,
                        customerEmail,
                        customerPhone,
                        service: booking.services && booking.services.length > 0
                            ? booking.services.map(s => s.name).join(', ')
                            : booking.serviceName || 'Service',
                        services: booking.services || (booking.serviceName ? [{ name: booking.serviceName, price: booking.price }] : []),
                        date: booking.date ? new Date(booking.date.seconds ? booking.date.seconds * 1000 : booking.date).toLocaleDateString() : 'TBD',
                        time: booking.time || 'TBD',
                        price: booking.price || 0,
                        address: booking.address || 'N/A',
                        vehicleType: booking.vehicleType || 'Not specified',
                        status: booking.status || 'pending',
                        createdAt: booking.createdAt
                    };
                })
            );

            // Sort by date (upcoming first)
            bookingsList.sort((a, b) => {
                if (a.date === 'TBD') return 1;
                if (b.date === 'TBD') return -1;
                return new Date(a.date) - new Date(b.date);
            });

            setBookings(bookingsList);
        } catch (error) {
            console.error('Error loading bookings:', error);
            setBookings([]);
        }
    }

    async function handleUpdateBookingStatus(bookingId, newStatus) {
        try {
            await updateDoc(doc(db, 'bookings', bookingId), {
                status: newStatus,
                updatedAt: serverTimestamp()
            });
            alert(`Booking ${newStatus} successfully`);
            loadBookings();
        } catch (error) {
            console.error('Error updating booking:', error);
            alert('Failed to update booking');
        }
    }

    async function handleToggleService(serviceId) {
        try {
            const updatedServices = services.map(service =>
                service.id === serviceId
                    ? { ...service, active: !service.active }
                    : service
            );

            setServices(updatedServices);

            // Update in Firestore
            const providerQuery = query(
                collection(db, 'providers'),
                where('userId', '==', currentUser.uid)
            );
            const providerSnapshot = await getDocs(providerQuery);

            if (!providerSnapshot.empty) {
                await updateDoc(doc(db, 'providers', providerSnapshot.docs[0].id), {
                    services: updatedServices,
                    updatedAt: serverTimestamp()
                });
                alert('Service status updated!');
            }
        } catch (error) {
            console.error('Error updating service:', error);
            alert('Failed to update service');
            // Revert on error
            loadProviderData();
        }
    }

    async function handleSaveService(updatedService) {
        try {
            const updatedServices = services.map(service =>
                service.id === updatedService.id ? updatedService : service
            );

            setServices(updatedServices);
            setShowEditModal(false);
            setEditingService(null);

            // Update in Firestore
            const providerQuery = query(
                collection(db, 'providers'),
                where('userId', '==', currentUser.uid)
            );
            const providerSnapshot = await getDocs(providerQuery);

            if (!providerSnapshot.empty) {
                await updateDoc(doc(db, 'providers', providerSnapshot.docs[0].id), {
                    services: updatedServices,
                    updatedAt: serverTimestamp()
                });
                alert('Service updated successfully!');
            }
        } catch (error) {
            console.error('Error saving service:', error);
            alert('Failed to save service');
            loadProviderData();
        }
    }

    function handleEditService(service) {
        setEditingService({ ...service });
        setShowEditModal(true);
    }

    async function handleSaveWeeklySchedule() {
        try {
            const providerQuery = query(
                collection(db, 'providers'),
                where('userId', '==', currentUser.uid)
            );
            const providerSnapshot = await getDocs(providerQuery);

            if (!providerSnapshot.empty) {
                await updateDoc(doc(db, 'providers', providerSnapshot.docs[0].id), {
                    defaultAvailability: weeklySchedule,
                    updatedAt: serverTimestamp()
                });
                alert('Weekly schedule saved successfully!');
            }
        } catch (error) {
            console.error('Error saving schedule:', error);
            alert('Failed to save schedule');
            loadProviderData();
        }
    }

    function handleDayScheduleChange(day, field, value) {
        setWeeklySchedule(prev => ({
            ...prev,
            [day]: {
                ...prev[day],
                [field]: value
            }
        }));
    }

    function handleToggleDay(day) {
        setWeeklySchedule(prev => {
            const currentDay = prev[day] || {};
            const isCurrentlyEnabled = currentDay.enabled || false;

            return {
                ...prev,
                [day]: {
                    ...currentDay,
                    enabled: !isCurrentlyEnabled,
                    // If enabling and no start/end times exist, set defaults
                    start: currentDay.start || '09:00',
                    end: currentDay.end || '17:00'
                }
            };
        });
    }

    async function handleAddBlackoutDate() {
        if (!selectedBlackoutDate) {
            alert('Please select a date');
            return;
        }

        if (blackoutDates.find(b => b.date === selectedBlackoutDate)) {
            alert('This date is already blocked out');
            return;
        }

        try {
            const newBlackout = { date: selectedBlackoutDate, type: 'unavailable' };
            const updatedBlackouts = [...blackoutDates, newBlackout];
            setBlackoutDates(updatedBlackouts);

            // Update in Firestore
            const providerQuery = query(
                collection(db, 'providers'),
                where('userId', '==', currentUser.uid)
            );
            const providerSnapshot = await getDocs(providerQuery);

            if (!providerSnapshot.empty) {
                const providerDoc = providerSnapshot.docs[0];
                const providerData = providerDoc.data();
                const dateOverrides = providerData.dateOverrides || {};

                dateOverrides[selectedBlackoutDate] = { type: 'unavailable' };

                await updateDoc(doc(db, 'providers', providerSnapshot.docs[0].id), {
                    dateOverrides: dateOverrides,
                    updatedAt: serverTimestamp()
                });

                setSelectedBlackoutDate('');
                setShowBlackoutModal(false);
                alert('Blackout date added successfully!');
            }
        } catch (error) {
            console.error('Error adding blackout date:', error);
            alert('Failed to add blackout date');
            loadProviderData();
        }
    }

    async function handleRemoveBlackoutDate(dateToRemove) {
        if (!confirm('Are you sure you want to remove this blackout date?')) return;

        try {
            const updatedBlackouts = blackoutDates.filter(b => b.date !== dateToRemove);
            setBlackoutDates(updatedBlackouts);

            // Update in Firestore
            const providerQuery = query(
                collection(db, 'providers'),
                where('userId', '==', currentUser.uid)
            );
            const providerSnapshot = await getDocs(providerQuery);

            if (!providerSnapshot.empty) {
                const providerDoc = providerSnapshot.docs[0];
                const providerData = providerDoc.data();
                const dateOverrides = providerData.dateOverrides || {};

                delete dateOverrides[dateToRemove];

                await updateDoc(doc(db, 'providers', providerSnapshot.docs[0].id), {
                    dateOverrides: dateOverrides,
                    updatedAt: serverTimestamp()
                });

                alert('Blackout date removed successfully!');
            }
        } catch (error) {
            console.error('Error removing blackout date:', error);
            alert('Failed to remove blackout date');
            loadProviderData();
        }
    }

    async function handleApproveProvider(providerId) {
        if (!confirm('Approve this provider? They will be able to accept bookings.')) return;

        try {
            await updateDoc(doc(db, 'providers', providerId), {
                status: 'approved',
                approvedAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
            alert('Provider approved successfully!');
            loadPendingProviders();
        } catch (error) {
            console.error('Error approving provider:', error);
            alert('Failed to approve provider');
        }
    }

    async function handleRejectProvider(providerId) {
        const reason = prompt('Reason for rejection (optional):');
        if (reason === null) return; // User cancelled

        try {
            await updateDoc(doc(db, 'providers', providerId), {
                status: 'rejected',
                rejectionReason: reason || '',
                rejectedAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
            alert('Provider rejected.');
            loadPendingProviders();
        } catch (error) {
            console.error('Error rejecting provider:', error);
            alert('Failed to reject provider');
        }
    }

    if (loading) {
        return (
            <div className="min-h-screen bg-gray-50 flex items-center justify-center">
                <p className="text-gray-600">Loading dashboard...</p>
            </div>
        );
    }

    const upcomingBookings = bookings.filter(b => ['pending', 'confirmed', 'scheduled'].includes(b.status));
    const completedBookings = bookings.filter(b => ['completed', 'cancelled'].includes(b.status));

    return (
        <div className="min-h-screen bg-gray-50">
            {/* Glassmorphic Header */}
            <div className="sticky top-0 z-40 backdrop-blur-xl bg-gradient-to-r from-blue-600/90 via-blue-700/90 to-indigo-600/90 border-b border-blue-400/20 shadow-lg">
                <div className="max-w-6xl mx-auto px-4 py-6">
                    <div className="flex items-center justify-between">
                        <div>
                            <h1 className="text-3xl font-bold text-white drop-shadow-md">
                                Provider Dashboard
                            </h1>
                            {providerData && (
                                <p className="text-blue-100 mt-1 drop-shadow-sm">
                                    {providerData.businessName || 'Your Business'}
                                </p>
                            )}
                        </div>
                        <div className="flex items-center gap-4">
                            <button
                                onClick={onBackToMarketplace}
                                className="px-4 py-2 text-white hover:text-blue-100 font-medium transition-colors drop-shadow-sm"
                            >
                                Marketplace
                            </button>
                            <button
                                onClick={onLogout}
                                className="px-4 py-2 bg-red-500/90 backdrop-blur-sm text-white rounded-lg hover:bg-red-600/90 font-medium shadow-md transition-all"
                            >
                                Logout
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* Tabs */}
            <div className="bg-white border-b border-gray-200">
                <div className="max-w-6xl mx-auto px-4">
                    <div className="flex gap-8">
                        <button
                            onClick={() => setActiveTab('bookings')}
                            className={`py-4 border-b-2 font-semibold transition-colors ${activeTab === 'bookings'
                                ? 'border-blue-600 text-blue-600'
                                : 'border-transparent text-gray-600 hover:text-gray-900'
                                }`}
                        >
                            Bookings ({upcomingBookings.length})
                        </button>
                        <button
                            onClick={() => setActiveTab('history')}
                            className={`py-4 border-b-2 font-semibold transition-colors ${activeTab === 'history'
                                ? 'border-blue-600 text-blue-600'
                                : 'border-transparent text-gray-600 hover:text-gray-900'
                                }`}
                        >
                            History ({completedBookings.length})
                        </button>
                        <button
                            onClick={() => setActiveTab('services')}
                            className={`py-4 border-b-2 font-semibold transition-colors ${activeTab === 'services'
                                ? 'border-blue-600 text-blue-600'
                                : 'border-transparent text-gray-600 hover:text-gray-900'
                                }`}
                        >
                            Services
                        </button>
                        <button
                            onClick={() => setActiveTab('availability')}
                            className={`py-4 border-b-2 font-semibold transition-colors ${activeTab === 'availability'
                                ? 'border-blue-600 text-blue-600'
                                : 'border-transparent text-gray-600 hover:text-gray-900'
                                }`}
                        >
                            Availability
                        </button>
                        <button
                            onClick={() => setActiveTab('profile')}
                            className={`py-4 border-b-2 font-semibold transition-colors ${activeTab === 'profile'
                                ? 'border-blue-600 text-blue-600'
                                : 'border-transparent text-gray-600 hover:text-gray-900'
                                }`}
                        >
                            Profile
                        </button>
                        {userData?.role === 'admin' && (  // Change to userData
                            <button
                                onClick={() => setActiveTab('admin')}
                                className={`py-4 border-b-2 font-semibold transition-colors ${activeTab === 'admin'
                                    ? 'border-blue-600 text-blue-600'
                                    : 'border-transparent text-gray-600 hover:text-gray-900'
                                    }`}
                            >
                                Admin {pendingProviders.length > 0 && `(${pendingProviders.length})`}
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Content */}
            <div className="max-w-6xl mx-auto px-4 py-8">
                {activeTab === 'bookings' && (
                    <div>
                        <div className="flex items-center justify-between mb-6">
                            <h2 className="text-2xl font-bold text-gray-900">Upcoming Bookings</h2>
                            <button
                                onClick={loadBookings}
                                className="px-4 py-2 text-sm border-2 border-gray-200 rounded-lg font-medium hover:bg-gray-50"
                            >
                                Refresh
                            </button>
                        </div>
                        {upcomingBookings.length === 0 ? (
                            <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
                                <Calendar className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                                <h3 className="text-xl font-semibold text-gray-900 mb-2">No upcoming bookings</h3>
                                <p className="text-gray-600">New bookings will appear here</p>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                {upcomingBookings.map((booking) => (
                                    <div key={booking.id} className="bg-white rounded-xl border border-gray-200 p-6">
                                        <div className="flex justify-between items-start mb-4">
                                            <div className="flex-1">
                                                <h3 className="text-xl font-bold text-gray-900 mb-2">
                                                    {booking.customerName}
                                                </h3>

                                                {/* Contact Information */}
                                                <div className="flex flex-wrap gap-4 mb-4 text-sm">
                                                    {booking.customerEmail && (
                                                        <div className="flex items-center gap-2 text-gray-600">
                                                            <Mail className="w-4 h-4" />
                                                            <a href={`mailto:${booking.customerEmail}`} className="hover:text-blue-600">
                                                                {booking.customerEmail}
                                                            </a>
                                                        </div>
                                                    )}
                                                    {booking.customerPhone && (
                                                        <div className="flex items-center gap-2 text-gray-600">
                                                            <Phone className="w-4 h-4" />
                                                            <a href={`tel:${booking.customerPhone}`} className="hover:text-blue-600">
                                                                {booking.customerPhone}
                                                            </a>
                                                        </div>
                                                    )}
                                                </div>

                                                {/* Service & Vehicle */}
                                                <div className="mb-4">
                                                    {booking.services && booking.services.length > 0 ? (
                                                        <div className="space-y-2 mb-2">
                                                            {booking.services.map((service, idx) => (
                                                                <div key={idx} className="flex items-center justify-between">
                                                                    <p className="text-lg font-semibold text-gray-900">{service.name}</p>
                                                                    {service.price && (
                                                                        <span className="text-sm font-medium text-gray-600">${service.price}</span>
                                                                    )}
                                                                </div>
                                                            ))}
                                                        </div>
                                                    ) : (
                                                        <p className="text-lg font-semibold text-gray-900 mb-2">{booking.service}</p>
                                                    )}
                                                    <div className="flex items-center gap-2 text-sm text-gray-600">
                                                        <Car className="w-4 h-4" />
                                                        <span className="font-medium">Vehicle:</span>
                                                        <span>{booking.vehicleType || 'Not specified'}</span>
                                                    </div>
                                                </div>

                                                {/* Date, Time, and Address */}
                                                <div className="space-y-2 text-sm">
                                                    <div className="flex items-center gap-2 text-gray-600">
                                                        <Calendar className="w-4 h-4" />
                                                        <span className="font-medium">{booking.date}</span>
                                                    </div>
                                                    <div className="flex items-center gap-2 text-gray-600">
                                                        <Clock className="w-4 h-4" />
                                                        <span className="font-medium">{booking.time}</span>
                                                    </div>
                                                    <div className="flex items-start gap-2 text-gray-600">
                                                        <MapPin className="w-4 h-4 mt-0.5 flex-shrink-0" />
                                                        <span className="font-medium">{booking.address}</span>
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="text-right ml-6">
                                                <p className="text-2xl font-bold text-gray-900 mb-2">
                                                    ${booking.price.toFixed(2)}
                                                </p>
                                                <span className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${booking.status === 'confirmed'
                                                    ? 'bg-green-100 text-green-800'
                                                    : booking.status === 'pending'
                                                        ? 'bg-yellow-100 text-yellow-800'
                                                        : 'bg-blue-100 text-blue-800'
                                                    }`}>
                                                    {booking.status.charAt(0).toUpperCase() + booking.status.slice(1)}
                                                </span>
                                            </div>
                                        </div>

                                        {booking.status === 'pending' && (
                                            <div className="flex gap-3 pt-4 border-t border-gray-100">
                                                <button
                                                    onClick={() => handleUpdateBookingStatus(booking.id, 'confirmed')}
                                                    className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700"
                                                >
                                                    Accept
                                                </button>
                                                <button
                                                    onClick={() => {
                                                        if (confirm('Are you sure you want to reject this booking?')) {
                                                            handleUpdateBookingStatus(booking.id, 'cancelled');
                                                        }
                                                    }}
                                                    className="flex-1 px-4 py-2 bg-red-50 text-red-600 rounded-lg font-semibold hover:bg-red-100"
                                                >
                                                    Reject
                                                </button>
                                            </div>
                                        )}

                                        {booking.status === 'confirmed' && (
                                            <div className="flex gap-3 pt-4 border-t border-gray-100">
                                                <button
                                                    onClick={() => handleUpdateBookingStatus(booking.id, 'completed')}
                                                    className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700"
                                                >
                                                    Mark Complete
                                                </button>
                                                <button
                                                    onClick={() => {
                                                        if (confirm('Are you sure you want to cancel this booking?')) {
                                                            handleUpdateBookingStatus(booking.id, 'cancelled');
                                                        }
                                                    }}
                                                    className="flex-1 px-4 py-2 bg-red-50 text-red-600 rounded-lg font-semibold hover:bg-red-100"
                                                >
                                                    Cancel
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'history' && (
                    <div>
                        <h2 className="text-2xl font-bold text-gray-900 mb-6">Booking History</h2>
                        {completedBookings.length === 0 ? (
                            <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
                                <p className="text-gray-600">No completed bookings yet</p>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                {completedBookings.map((booking) => (
                                    <div key={booking.id} className="bg-white rounded-xl border border-gray-200 p-6">
                                        <div className="flex justify-between items-start">
                                            <div className="flex-1">
                                                <h3 className="text-lg font-semibold text-gray-900 mb-2">
                                                    {booking.customerName}
                                                </h3>

                                                {/* Contact Information */}
                                                {(booking.customerEmail || booking.customerPhone) && (
                                                    <div className="flex flex-wrap gap-4 mb-3 text-sm">
                                                        {booking.customerEmail && (
                                                            <div className="flex items-center gap-2 text-gray-600">
                                                                <Mail className="w-4 h-4" />
                                                                <span>{booking.customerEmail}</span>
                                                            </div>
                                                        )}
                                                        {booking.customerPhone && (
                                                            <div className="flex items-center gap-2 text-gray-600">
                                                                <Phone className="w-4 h-4" />
                                                                <span>{booking.customerPhone}</span>
                                                            </div>
                                                        )}
                                                    </div>
                                                )}

                                                {booking.services && booking.services.length > 0 ? (
                                                    <div className="mb-2">
                                                        {booking.services.map((service, idx) => (
                                                            <p key={idx} className="text-gray-600 mb-1">
                                                                {service.name} {service.price ? `- $${service.price}` : ''}
                                                            </p>
                                                        ))}
                                                    </div>
                                                ) : (
                                                    <p className="text-gray-600 mb-1">{booking.service}</p>
                                                )}
                                                <p className="text-sm text-gray-500 mb-2">
                                                    <span className="font-medium">Vehicle:</span> {booking.vehicleType || 'Not specified'}
                                                </p>
                                                <div className="flex flex-wrap gap-4 text-sm text-gray-500 mt-2">
                                                    <span>{booking.date} at {booking.time}</span>
                                                    {booking.address && booking.address !== 'N/A' && (
                                                        <span className="flex items-center gap-1">
                                                            <MapPin className="w-3 h-3" />
                                                            {booking.address}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="text-right ml-6">
                                                <p className="text-xl font-bold text-gray-900">
                                                    ${booking.price.toFixed(2)}
                                                </p>
                                                <span className={`inline-block mt-2 px-3 py-1 rounded-full text-sm ${booking.status === 'completed'
                                                    ? 'bg-green-100 text-green-800'
                                                    : 'bg-gray-100 text-gray-800'
                                                    }`}>
                                                    {booking.status.charAt(0).toUpperCase() + booking.status.slice(1)}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'services' && (
                    <div>
                        <div className="flex items-center justify-between mb-6">
                            <h2 className="text-2xl font-bold text-gray-900">Manage Services</h2>
                            <p className="text-sm text-gray-500">
                                {services.filter(s => s.active !== false).length} of {services.length} services active
                            </p>
                        </div>

                        {services.length === 0 ? (
                            <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
                                <Package className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                                <h3 className="text-xl font-semibold text-gray-900 mb-2">No services found</h3>
                                <p className="text-gray-600">Contact support to add services to your account.</p>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                {services.map((service) => (
                                    <div
                                        key={service.id}
                                        className={`bg-white rounded-xl border-2 p-6 ${service.active === false
                                            ? 'border-gray-200 opacity-60'
                                            : 'border-gray-200'
                                            }`}
                                    >
                                        <div className="flex items-start justify-between">
                                            <div className="flex-1">
                                                <div className="flex items-center gap-3 mb-2">
                                                    <h3 className="text-lg font-semibold text-gray-900">
                                                        {service.name}
                                                    </h3>
                                                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${service.active === false
                                                        ? 'bg-gray-100 text-gray-600'
                                                        : 'bg-green-100 text-green-800'
                                                        }`}>
                                                        {service.active === false ? 'Disabled' : 'Active'}
                                                    </span>
                                                </div>

                                                {service.description && (
                                                    <p className="text-sm text-gray-600 mb-3">{service.description}</p>
                                                )}

                                                <div className="flex flex-wrap gap-4 text-sm text-gray-500">
                                                    <div className="flex items-center gap-1">
                                                        <DollarSign className="w-4 h-4" />
                                                        <span className="font-medium">${service.price || 0}</span>
                                                    </div>
                                                    {service.duration && (
                                                        <div className="flex items-center gap-1">
                                                            <Clock className="w-4 h-4" />
                                                            <span>{service.duration}</span>
                                                        </div>
                                                    )}
                                                    {service.category && (
                                                        <span className="px-2 py-1 bg-gray-100 rounded text-xs">
                                                            {service.category}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>

                                            <div className="flex items-center gap-3 ml-4">
                                                {/* Toggle Switch */}
                                                <label className="relative inline-flex items-center cursor-pointer">
                                                    <input
                                                        type="checkbox"
                                                        checked={service.active !== false}
                                                        onChange={() => handleToggleService(service.id)}
                                                        className="sr-only peer"
                                                    />
                                                    <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                                                </label>

                                                {/* Edit Button */}
                                                <button
                                                    onClick={() => handleEditService(service)}
                                                    className="px-4 py-2 text-sm border-2 border-gray-200 rounded-lg font-medium hover:bg-gray-50 flex items-center gap-2"
                                                >
                                                    <Edit2 className="w-4 h-4" />
                                                    Edit
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Edit Service Modal */}
                        {showEditModal && editingService && (
                            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                                <div className="bg-white rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
                                    <div className="p-6 border-b border-gray-200">
                                        <div className="flex items-center justify-between">
                                            <h3 className="text-xl font-bold text-gray-900">Edit Service</h3>
                                            <button
                                                onClick={() => {
                                                    setShowEditModal(false);
                                                    setEditingService(null);
                                                }}
                                                className="text-gray-400 hover:text-gray-600"
                                            >
                                                <X className="w-6 h-6" />
                                            </button>
                                        </div>
                                    </div>

                                    <div className="p-6 space-y-4">
                                        <div>
                                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                                Service Name
                                            </label>
                                            <input
                                                type="text"
                                                value={editingService.name || ''}
                                                onChange={(e) => setEditingService({ ...editingService, name: e.target.value })}
                                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                            />
                                        </div>

                                        <div className="grid grid-cols-2 gap-4">
                                            <div>
                                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                                    Price ($)
                                                </label>
                                                <input
                                                    type="number"
                                                    min="0"
                                                    step="0.01"
                                                    value={editingService.price || 0}
                                                    onChange={(e) => setEditingService({ ...editingService, price: parseFloat(e.target.value) || 0 })}
                                                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                                />
                                            </div>

                                            <div>
                                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                                    Duration
                                                </label>
                                                <input
                                                    type="text"
                                                    value={editingService.duration || ''}
                                                    onChange={(e) => setEditingService({ ...editingService, duration: e.target.value })}
                                                    placeholder="e.g., 2-3 hours"
                                                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                                />
                                            </div>
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                                Description
                                            </label>
                                            <textarea
                                                value={editingService.description || ''}
                                                onChange={(e) => setEditingService({ ...editingService, description: e.target.value })}
                                                rows="4"
                                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                                placeholder="Describe what's included in this service..."
                                            />
                                        </div>
                                    </div>

                                    <div className="p-6 border-t border-gray-200 flex gap-3">
                                        <button
                                            onClick={() => handleSaveService(editingService)}
                                            className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700"
                                        >
                                            Save Changes
                                        </button>
                                        <button
                                            onClick={() => {
                                                setShowEditModal(false);
                                                setEditingService(null);
                                            }}
                                            className="px-6 py-2 border-2 border-gray-200 rounded-lg font-semibold hover:bg-gray-50"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'availability' && (
                    <div>
                        <h2 className="text-2xl font-bold text-gray-900 mb-6">Manage Availability</h2>

                        {/* Weekly Schedule */}
                        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
                            <div className="flex items-center justify-between mb-4">
                                <h3 className="text-lg font-semibold text-gray-900">Weekly Schedule</h3>
                                <button
                                    onClick={handleSaveWeeklySchedule}
                                    className="px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700"
                                >
                                    Save Schedule
                                </button>
                            </div>
                            <p className="text-sm text-gray-500 mb-4">
                                Set your default working hours for each day of the week. This schedule will remain constant until you change it.
                            </p>

                            <div className="space-y-3">
                                {['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((day) => {
                                    const daySchedule = weeklySchedule[day] || { enabled: false, start: '09:00', end: '17:00' };
                                    const dayName = day.charAt(0).toUpperCase() + day.slice(1);

                                    return (
                                        <div key={day} className="flex items-center gap-4 p-4 border border-gray-200 rounded-lg">
                                            <div className="flex items-center gap-3 w-32">
                                                <input
                                                    type="checkbox"
                                                    checked={daySchedule.enabled || false}
                                                    onChange={() => handleToggleDay(day)}
                                                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                                                />
                                                <label className="font-medium text-gray-900">{dayName}</label>
                                            </div>

                                            {daySchedule.enabled ? (
                                                <div className="flex items-center gap-3 flex-1">
                                                    <div className="flex items-center gap-2">
                                                        <label className="text-sm text-gray-600">Start:</label>
                                                        <input
                                                            type="time"
                                                            value={daySchedule.start || '09:00'}
                                                            onChange={(e) => handleDayScheduleChange(day, 'start', e.target.value)}
                                                            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                                        />
                                                    </div>
                                                    <span className="text-gray-400">to</span>
                                                    <div className="flex items-center gap-2">
                                                        <label className="text-sm text-gray-600">End:</label>
                                                        <input
                                                            type="time"
                                                            value={daySchedule.end || '17:00'}
                                                            onChange={(e) => handleDayScheduleChange(day, 'end', e.target.value)}
                                                            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                                        />
                                                    </div>
                                                </div>
                                            ) : (
                                                <span className="text-sm text-gray-400 italic">Not available</span>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Blackout Dates */}
                        <div className="bg-white rounded-xl border border-gray-200 p-6">
                            <div className="flex items-center justify-between mb-4">
                                <h3 className="text-lg font-semibold text-gray-900">Blackout Dates</h3>
                                <button
                                    onClick={() => setShowBlackoutModal(true)}
                                    className="px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700 flex items-center gap-2"
                                >
                                    <Plus className="w-4 h-4" />
                                    Add Blackout Date
                                </button>
                            </div>
                            <p className="text-sm text-gray-500 mb-4">
                                Block out dates when you're unavailable (holidays, emergencies, etc.). No bookings will be available on these dates.
                            </p>

                            {blackoutDates.length === 0 ? (
                                <div className="text-center py-8 text-gray-500">
                                    <Calendar className="w-12 h-12 mx-auto mb-2 text-gray-300" />
                                    <p>No blackout dates set</p>
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {blackoutDates.map((blackout) => {
                                        const date = new Date(blackout.date + 'T00:00:00');
                                        const formattedDate = date.toLocaleDateString('en-US', {
                                            weekday: 'long',
                                            year: 'numeric',
                                            month: 'long',
                                            day: 'numeric'
                                        });

                                        return (
                                            <div key={blackout.date} className="flex items-center justify-between p-3 bg-red-50 border border-red-200 rounded-lg">
                                                <div className="flex items-center gap-3">
                                                    <Calendar className="w-5 h-5 text-red-600" />
                                                    <span className="font-medium text-gray-900">{formattedDate}</span>
                                                </div>
                                                <button
                                                    onClick={() => handleRemoveBlackoutDate(blackout.date)}
                                                    className="px-3 py-1 text-sm text-red-600 hover:bg-red-100 rounded-lg font-medium"
                                                >
                                                    Remove
                                                </button>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        {/* Add Blackout Date Modal */}
                        {showBlackoutModal && (
                            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                                <div className="bg-white rounded-xl max-w-md w-full">
                                    <div className="p-6 border-b border-gray-200">
                                        <div className="flex items-center justify-between">
                                            <h3 className="text-xl font-bold text-gray-900">Add Blackout Date</h3>
                                            <button
                                                onClick={() => {
                                                    setShowBlackoutModal(false);
                                                    setSelectedBlackoutDate('');
                                                }}
                                                className="text-gray-400 hover:text-gray-600"
                                            >
                                                <X className="w-6 h-6" />
                                            </button>
                                        </div>
                                    </div>

                                    <div className="p-6 space-y-4">
                                        <div>
                                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                                Select Date
                                            </label>
                                            <input
                                                type="date"
                                                value={selectedBlackoutDate}
                                                onChange={(e) => setSelectedBlackoutDate(e.target.value)}
                                                min={new Date().toISOString().split('T')[0]}
                                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                            />
                                        </div>
                                        <p className="text-sm text-gray-500">
                                            This date will be blocked out and no bookings will be available.
                                        </p>
                                    </div>

                                    <div className="p-6 border-t border-gray-200 flex gap-3">
                                        <button
                                            onClick={handleAddBlackoutDate}
                                            className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700"
                                        >
                                            Add Blackout Date
                                        </button>
                                        <button
                                            onClick={() => {
                                                setShowBlackoutModal(false);
                                                setSelectedBlackoutDate('');
                                            }}
                                            className="px-6 py-2 border-2 border-gray-200 rounded-lg font-semibold hover:bg-gray-50"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'admin' && userData?.role === 'admin' && (  // Change to userData
                    <div>
                        <div className="flex items-center justify-between mb-6">
                            <h2 className="text-2xl font-bold text-gray-900">Provider Approvals</h2>
                            <button
                                onClick={loadPendingProviders}
                                className="px-4 py-2 text-sm border-2 border-gray-200 rounded-lg font-medium hover:bg-gray-50"
                            >
                                Refresh
                            </button>
                        </div>

                        {loadingPending ? (
                            <div className="text-center py-8">
                                <p className="text-gray-600">Loading pending applications...</p>
                            </div>
                        ) : pendingProviders.length === 0 ? (
                            <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
                                <CheckCircle2 className="w-16 h-16 text-green-300 mx-auto mb-4" />
                                <h3 className="text-xl font-semibold text-gray-900 mb-2">No pending applications</h3>
                                <p className="text-gray-600">All provider applications have been reviewed.</p>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                {pendingProviders.map((provider) => (
                                    <div key={provider.id} className="bg-white rounded-xl border-2 border-yellow-200 p-6">
                                        <div className="flex items-start justify-between mb-4">
                                            <div className="flex-1">
                                                <h3 className="text-xl font-bold text-gray-900 mb-2">
                                                    {provider.businessName}
                                                </h3>
                                                <div className="space-y-2 text-sm text-gray-600">
                                                    <div className="flex items-center gap-2">
                                                        <Mail className="w-4 h-4" />
                                                        <span>{provider.email}</span>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <Phone className="w-4 h-4" />
                                                        <span>{provider.phone}</span>
                                                    </div>
                                                    {provider.ownerName && (
                                                        <div className="flex items-center gap-2">
                                                            <User className="w-4 h-4" />
                                                            <span>Owner: {provider.ownerName}</span>
                                                        </div>
                                                    )}
                                                    {provider.address && (
                                                        <div className="flex items-center gap-2">
                                                            <MapPin className="w-4 h-4" />
                                                            <span>{provider.address}</span>
                                                        </div>
                                                    )}
                                                    {provider.serviceArea && (
                                                        <div className="flex items-center gap-2">
                                                            <MapPin className="w-4 h-4" />
                                                            <span>Service Area: {provider.serviceArea}</span>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                            <span className="px-3 py-1 bg-yellow-100 text-yellow-800 rounded-full text-sm font-medium">
                                                Pending
                                            </span>
                                        </div>

                                        {/* Business Details */}
                                        <div className="grid grid-cols-2 gap-4 mb-4 p-4 bg-gray-50 rounded-lg">
                                            <div>
                                                <label className="text-xs font-medium text-gray-500">Business License</label>
                                                <p className="text-sm font-semibold text-gray-900">{provider.businessLicenseNumber || 'N/A'}</p>
                                            </div>
                                            {provider.ein && (
                                                <div>
                                                    <label className="text-xs font-medium text-gray-500">EIN</label>
                                                    <p className="text-sm font-semibold text-gray-900">{provider.ein}</p>
                                                </div>
                                            )}
                                            <div>
                                                <label className="text-xs font-medium text-gray-500">Insurance Provider</label>
                                                <p className="text-sm font-semibold text-gray-900">{provider.insuranceProvider || 'N/A'}</p>
                                            </div>
                                            <div>
                                                <label className="text-xs font-medium text-gray-500">Insurance Number</label>
                                                <p className="text-sm font-semibold text-gray-900">{provider.insuranceNumber || 'N/A'}</p>
                                            </div>
                                        </div>

                                        {provider.about && (
                                            <div className="mb-4">
                                                <label className="text-xs font-medium text-gray-500">About</label>
                                                <p className="text-sm text-gray-700 mt-1">{provider.about}</p>
                                            </div>
                                        )}

                                        {/* Action Buttons */}
                                        <div className="flex gap-3 pt-4 border-t border-gray-200">
                                            <button
                                                onClick={() => handleApproveProvider(provider.id)}
                                                className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700"
                                            >
                                                Approve
                                            </button>
                                            <button
                                                onClick={() => handleRejectProvider(provider.id)}
                                                className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700"
                                            >
                                                Reject
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'profile' && (
                    <div>
                        <h2 className="text-2xl font-bold text-gray-900 mb-6">Provider Profile</h2>
                        {providerData ? (
                            <div className="bg-white rounded-xl border border-gray-200 p-8">
                                <div className="space-y-6">
                                    <div>
                                        <label className="block text-sm font-medium text-gray-500 mb-1">
                                            Business Name
                                        </label>
                                        <div className="text-lg font-semibold text-gray-900">
                                            {providerData.businessName || 'Not set'}
                                        </div>
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-gray-500 mb-1">
                                            Service Area
                                        </label>
                                        <div className="text-lg font-semibold text-gray-900">
                                            {providerData.serviceArea || providerData.businessAddress || 'Not set'}
                                        </div>
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-gray-500 mb-1">
                                            Primary Service
                                        </label>
                                        <div className="text-lg font-semibold text-gray-900">
                                            {providerData.primaryService || 'Not set'}
                                        </div>
                                    </div>
                                    {providerData.phone && (
                                        <div>
                                            <label className="block text-sm font-medium text-gray-500 mb-1">
                                                Phone
                                            </label>
                                            <div className="text-lg font-semibold text-gray-900">
                                                {providerData.phone}
                                            </div>
                                        </div>
                                    )}
                                    {providerData.email && (
                                        <div>
                                            <label className="block text-sm font-medium text-gray-500 mb-1">
                                                Email
                                            </label>
                                            <div className="text-lg font-semibold text-gray-900">
                                                {providerData.email}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ) : (
                            <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
                                <p className="text-gray-600">Provider profile not found</p>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}