import React, { useState, useEffect, useMemo, useCallback } from 'react';
import config from './config';
import {
    MapPin, Car, Calendar, Star, CheckCircle2, X, ChevronRight,
    Clock, DollarSign, Shield, User, CreditCard, Home, Package,
    Edit2, Trash2, Plus, LogOut, Menu, Search, Mail, Phone, MessageSquare,
    Bell, CheckCircle
} from 'lucide-react';
import {
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signInWithPopup,
    onAuthStateChanged,
    signOut,
    sendPasswordResetEmail
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
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { auth, db, storage } from './firebase/config';
import { GoogleAuthProvider } from 'firebase/auth';
import PaymentForm from './components/PaymentForm';
import { PACKAGES_DATA, ADD_ONS, importPackagesToFirestore, initializePackagesIfEmpty } from './data/packages';
import {
    requestNotificationPermission,
    saveFCMToken,
    subscribeToNotifications,
    subscribeToUnreadCount,
    markNotificationAsRead,
    markAllAsRead,
    setupForegroundMessageHandler,
    notifyNewBooking,
    notifyBookingConfirmed,
    notifyBookingCancelled,
    notifyPaymentReceived
} from './services/notificationService';

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
        if (!address || !address.trim()) {
            console.error('Geocoding error: Empty address provided');
            return null;
        }

        await loadGoogleMapsApi();

        if (!window.google || !window.google.maps || !window.google.maps.Geocoder) {
            console.error('Geocoding error: Google Maps API not loaded');
            return null;
        }

        const geocoder = new window.google.maps.Geocoder();
        const response = await geocoder.geocode({ address });

        if (!response || !response.results || response.results.length === 0) {
            console.error('Geocoding error: No results found for address:', address);
            return null;
        }

        const result = response.results[0];
        if (!result || !result.geometry || !result.geometry.location) {
            console.error('Geocoding error: Invalid result structure');
            return null;
        }

        const byType = (type) => result.address_components?.find(c => c.types.includes(type));
        const coords = {
            lat: result.geometry.location.lat(),
            lng: result.geometry.location.lng(),
            formattedAddress: result.formatted_address,
            city: byType('locality')?.long_name || '',
            state: byType('administrative_area_level_1')?.short_name || '',
            zip: byType('postal_code')?.long_name || ''
        };

        return coords;
    } catch (error) {
        console.error('Geocoding error:', error);
        console.error('Error details:', {
            message: error.message,
            stack: error.stack,
            address: address
        });
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
    const [isProvider, setIsProvider] = useState(false);
    const isCreatingAccountRef = React.useRef(false); // Flag to prevent auth listener from signing out during account creation

    // User location
    const [userCoordinates, setUserCoordinates] = useState(null);

    // Search and filter state
    const [searchQuery, setSearchQuery] = useState('');
    const [distanceFilter, setDistanceFilter] = useState(50); // miles
    const [sortBy, setSortBy] = useState('distance'); // distance, price, rating, reviews

    // Page state
    const [currentPage, setCurrentPage] = useState('landing'); // landing, marketplace, detailerProfile, dashboard

    // Modal/flow state
    const [modalType, setModalType] = useState(null); // 'address', 'signup', 'login', 'providerOnboarding'

    // Login form state
    const [loginData, setLoginData] = useState({
        email: '',
        password: ''
    });

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
        password: '',
        accountType: 'customer'
    });

    // Provider onboarding form state
    const [providerOnboardingData, setProviderOnboardingData] = useState({
        businessName: '',
        businessAddress: '',
        serviceArea: '',
        phone: '',
        email: ''
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

    // Initialize Google Places Autocomplete on the address input (for both address and provider onboarding modals)
    useEffect(() => {
        if ((modalType !== 'address' && modalType !== 'providerOnboarding') || !googleMapsLoaded) return;

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
                    const formattedAddr = place.formatted_address;
                    // Get full coordinate details from Places API (includes city, state, zip)
                    const byType = (type) => place.address_components?.find(c => c.types.includes(type));
                    const coords = place.geometry ? {
                        lat: place.geometry.location.lat(),
                        lng: place.geometry.location.lng(),
                        formattedAddress: formattedAddr,
                        city: byType('locality')?.long_name || '',
                        state: byType('administrative_area_level_1')?.short_name || '',
                        zip: byType('postal_code')?.long_name || ''
                    } : null;

                    // Update based on which modal is open
                    if (modalType === 'providerOnboarding') {
                        setProviderOnboardingData(prev => ({
                            ...prev,
                            businessAddress: formattedAddr
                        }));
                        if (coords) {
                            setUserCoordinates(coords);
                        }
                    } else {
                        // Address modal
                        setAddress(formattedAddr);
                        if (coords) {
                            setUserCoordinates(coords);
                        }
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
    }, [modalType, googleMapsLoaded]); // Don't include providerOnboardingData to avoid recreating autocomplete

    // Profile dropdown
    const [showProfileDropdown, setShowProfileDropdown] = useState(false);

    // Questions removed - users go directly from address to signup

    // ==================== CLEAR ORPHANED SESSIONS ON LOAD ====================
    // Check and clear any orphaned Firebase Auth sessions on page load
    useEffect(() => {
        const checkAndClearOrphanedSession = async () => {
            try {
                const currentAuthUser = auth.currentUser;
                if (currentAuthUser) {
                    // Check both customer and detailer collections
                    const customerDoc = await getDoc(doc(db, 'customer', currentAuthUser.uid));
                    const detailerDoc = await getDoc(doc(db, 'detailer', currentAuthUser.uid));

                    if (!customerDoc.exists() && !detailerDoc.exists()) {
                        // Clear Firebase Auth storage
                        try {
                            if (window.indexedDB) {
                                indexedDB.deleteDatabase('firebaseLocalStorageDb');
                            }
                            Object.keys(localStorage).forEach(key => {
                                if (key.startsWith('firebase:authUser:')) {
                                    localStorage.removeItem(key);
                                }
                            });
                        } catch (e) {
                            console.warn('Could not clear storage:', e);
                        }
                        // Sign out
                        await signOut(auth);
                    }
                }
            } catch (error) {
                console.error('Error checking orphaned session:', error);
            }
        };

        // Run check after a short delay to ensure Firebase is initialized
        const timeout = setTimeout(checkAndClearOrphanedSession, 500);
        return () => clearTimeout(timeout);
    }, []);

    // ==================== AUTH LISTENER ====================
    useEffect(() => {
        let isSigningOut = false; // Flag to prevent infinite loop

        const unsubscribe = onAuthStateChanged(auth, async (user) => {
            // Prevent infinite loop if we're already signing out
            if (isSigningOut) {
                return;
            }
            if (user) {
                try {
                    // 1. Check if they exist as a CUSTOMER
                    const customerRef = doc(db, 'customer', user.uid);
                    const customerDoc = await getDoc(customerRef);

                    // 2. Check if they exist as a DETAILER
                    const detailerRef = doc(db, 'detailer', user.uid);
                    const detailerDoc = await getDoc(detailerRef);

                    // 3. Check if they are a NEW USER
                    if (!customerDoc.exists() && !detailerDoc.exists()) {
                        // This is a BRAND NEW user. They don't exist in either collection.

                        // 4. Get the role we saved from the button click
                        const role = localStorage.getItem('pendingUserRole') || 'customer'; // Default to 'customer'

                        // 5. IMPORTANT: Clear the note
                        localStorage.removeItem('pendingUserRole');

                        // 6. Set flag to prevent auth listener from signing out during creation
                        isCreatingAccountRef.current = true;

                        // 7. Create their document in the correct collection
                        const userData = {
                            uid: user.uid,
                            email: user.email,
                            displayName: user.displayName,
                            photoURL: user.photoURL,
                            createdAt: serverTimestamp(),
                        };

                        if (role === 'detailer') {
                            // Create a new DETAILER document
                            await setDoc(detailerRef, {
                                ...userData,
                                businessName: user.displayName || 'New Business',
                                businessAddress: '',
                                serviceArea: '',
                                phone: '',
                                services: [],
                                offeredPackages: [],
                                addOns: [],
                                packagePrices: {},
                                defaultAvailability: {
                                    monday: { enabled: false, start: '09:00', end: '17:00' },
                                    tuesday: { enabled: false, start: '09:00', end: '17:00' },
                                    wednesday: { enabled: false, start: '09:00', end: '17:00' },
                                    thursday: { enabled: false, start: '09:00', end: '17:00' },
                                    friday: { enabled: false, start: '09:00', end: '17:00' },
                                    saturday: { enabled: false, start: '09:00', end: '17:00' },
                                    sunday: { enabled: false, start: '09:00', end: '17:00' }
                                },
                                dateOverrides: {},
                                rating: 0,
                                reviewCount: 0,
                                employeeCount: 1,
                                backgroundCheck: false,
                                status: 'pending',
                                onboarded: false
                            });

                            // Set user info and route to detailer onboarding
                            const userInfo = {
                                uid: user.uid,
                                email: user.email,
                                name: user.displayName || user.email.split('@')[0],
                                photoURL: user.photoURL,
                                initials: getInitials(user.displayName || user.email)
                            };
                            setCurrentUser(userInfo);
                            setUserAccountType('detailer');
                            setIsProvider(true);
                            setCurrentPage('landing');
                            setProviderOnboardingData({
                                businessName: '',
                                businessAddress: '',
                                serviceArea: '',
                                phone: '',
                                email: user.email || ''
                            });
                            setModalType('providerOnboarding');

                            // Clear the flag after a delay
                            setTimeout(() => {
                                isCreatingAccountRef.current = false;
                            }, 3000);
                        } else {
                            // Create a new CUSTOMER document
                            await setDoc(customerRef, {
                                ...userData,
                                savedAddresses: [],
                                favoriteProviders: [],
                                address: '',
                                coordinates: null,
                                preferences: {},
                                onboarded: false
                            });

                            // Set user info and route to address modal
                            const userInfo = {
                                uid: user.uid,
                                email: user.email,
                                name: user.displayName || user.email.split('@')[0],
                                photoURL: user.photoURL,
                                initials: getInitials(user.displayName || user.email)
                            };
                            setCurrentUser(userInfo);
                            setUserAccountType('customer');
                            setIsProvider(false);
                            setCurrentPage('landing');
                            setModalType('address');

                            // Clear the flag after a delay
                            setTimeout(() => {
                                isCreatingAccountRef.current = false;
                            }, 3000);
                        }
                    } else {
                        // This is an EXISTING user.
                        const userInfo = {
                            uid: user.uid,
                            email: user.email,
                            name: user.displayName || user.email.split('@')[0],
                            photoURL: user.photoURL,
                            initials: getInitials(user.displayName || user.email)
                        };
                        setCurrentUser(userInfo);

                        if (customerDoc.exists()) {
                            setUserAccountType('customer');
                            setIsProvider(false);
                            // Check onboarding will handle routing
                            if (!isCreatingAccountRef.current) {
                                await checkUserOnboarding(user.uid, 'customer');
                            }
                        } else if (detailerDoc.exists()) {
                            setUserAccountType('detailer');
                            setIsProvider(true);
                            // Check onboarding will handle routing
                            if (!isCreatingAccountRef.current) {
                                await checkUserOnboarding(user.uid, 'detailer');
                            }
                        }
                    }
                } catch (error) {
                    console.error('❌ Error checking user documents on auth:', error);
                    // Set flag to prevent loop
                    isSigningOut = true;
                    // If we can't check, sign out to be safe
                    await signOut(auth);
                    setCurrentUser(null);
                    setUserAccountType(null);
                    setIsProvider(false);
                    setCurrentPage('landing');
                    setLoading(false);
                    // Reset flag after a delay
                    setTimeout(() => { isSigningOut = false; }, 2000);
                    return;
                }
            } else {
                // User is not logged in - show landing page
                setCurrentUser(null);
                setUserAccountType(null);
                setIsProvider(false);
                setCurrentPage('landing');
            }
            setLoading(false);
        });

        return () => unsubscribe();
    }, []);

    // ==================== AUTO-INITIALIZE PACKAGES ====================
    useEffect(() => {
        // Auto-create packages if they don't exist (runs once on app load)
        initializePackagesIfEmpty().catch(error => {
            console.error('Failed to auto-initialize packages:', error);
        });
    }, []);

    // Check if returning user has already completed onboarding
    async function checkUserOnboarding(uid, role) {
        try {
            // Determine which collection to check based on role
            const collectionName = role === 'detailer' ? 'detailer' : 'customer';
            const userDocRef = doc(db, collectionName, uid);

            let userDoc;
            try {
                userDoc = await getDoc(userDocRef);
            } catch (docError) {
                console.error('❌ Error reading user document:', docError);
                console.error('Document read error details:', {
                    code: docError.code,
                    message: docError.message,
                    stack: docError.stack
                });
                throw docError;
            }

            if (!userDoc.exists()) {
                // User is authenticated but has no Firestore document - sign them out
                // This happens when Firebase Auth session exists but Firestore document was deleted
                await signOut(auth);
                setCurrentPage('landing');
                setCurrentUser(null);
                setUserAccountType(null);
                setIsProvider(false);
                return;
            }

            const userData = userDoc.data();

            if (role === 'detailer') {
                // Detailer/Provider flow
                setIsProvider(true);
                setAddress(
                    userData.businessAddress ||
                    userData.serviceArea ||
                    ''
                );
                setUserCoordinates(userData.coordinates || null);
                setAnswers({
                    vehicleType: userData.vehicleSpecialty || 'All Vehicles',
                    serviceType: userData.primaryService || 'Multiple Services',
                    timeSlot: 'Flexible'
                });

                // Check if detailer needs to complete onboarding
                if (!userData.onboarded || !userData.businessName || !userData.businessAddress) {
                    setCurrentPage('landing');
                    setModalType('providerOnboarding');
                    return;
                }

                setCurrentPage('dashboard');
            } else {
                // Customer flow
                setIsProvider(false);

                // Customers - check if they have an address
                if (userData.address || userData.coordinates) {
                    setAddress(userData.coordinates?.formattedAddress || userData.address || '');
                    setUserCoordinates(userData.coordinates || null);
                    setAnswers({
                        vehicleType: userData.preferences?.vehicleType || 'Sedan',
                        serviceType: userData.preferences?.serviceType || 'Full Detail',
                        timeSlot: userData.preferences?.timeSlot || 'Flexible'
                    });

                    setCurrentPage('marketplace');
                } else {
                    // Customer exists but needs to enter address - show address modal
                    setCurrentPage('landing');
                    setModalType('address');
                }
            }
        } catch (error) {
            console.error('❌ Error checking user onboarding:', error);
            console.error('Onboarding error details:', {
                code: error.code,
                message: error.message,
                stack: error.stack,
                name: error.name
            });
            console.error('🔐 Auth state at error:', {
                isAuthenticated: !!auth.currentUser,
                uid: auth.currentUser?.uid,
                email: auth.currentUser?.email
            });

            if (error.code === 'permission-denied') {
                console.error('🚨 PERMISSION DENIED when reading own user document!');
                console.error('This suggests Firestore rules may not be deployed or are incorrect.');
                console.error('Please deploy the updated firestore.rules file to Firebase Console.');
            }

            // On error, default to landing page
            setCurrentPage('landing');
        }
    }

    // Load detailers when marketplace opens (and when coordinates become available)
    useEffect(() => {
        if (currentPage === 'marketplace') {
            // Always reload when navigating to marketplace to get latest data
            // Use a small delay to ensure Firebase is ready
            const loadTimeout = setTimeout(() => {
                loadDetailers().catch(error => {
                    console.error('Error loading detailers:', error);
                });
            }, 100);

            return () => clearTimeout(loadTimeout);
        }
    }, [currentPage, userCoordinates]);

    // Real-time listener for provider updates - reloads detailers when providers change
    useEffect(() => {
        if (currentPage === 'marketplace') {
            let isInitialLoad = true;
            let loadTimeout = null;

            // Listen for changes to users collection (providers) - unified structure

            const unsubscribe = onSnapshot(
                query(collection(db, 'detailer')),
                async (snapshot) => {
                    // Skip the initial load - let the manual loadDetailers() handle it
                    if (isInitialLoad) {
                        isInitialLoad = false;
                        return;
                    }

                    // Debounce rapid updates
                    if (loadTimeout) {
                        clearTimeout(loadTimeout);
                    }

                    loadTimeout = setTimeout(async () => {
                        try {
                            await loadDetailers();
                        } catch (error) {
                            console.error('❌ Error reloading detailers from listener:', error);
                            console.error('Error details:', {
                                code: error.code,
                                message: error.message,
                                stack: error.stack
                            });
                        }
                    }, 500); // Wait 500ms before reloading
                },
                (error) => {
                    console.error('❌ Error in real-time listener:', error);
                    console.error('Listener error details:', {
                        code: error.code,
                        message: error.message,
                        stack: error.stack,
                        name: error.name
                    });
                    console.error('🔐 Auth state at listener error:', {
                        isAuthenticated: !!auth.currentUser,
                        uid: auth.currentUser?.uid
                    });
                    // Don't reload on error - let manual load handle it
                }
            );

            // Mark initial load as complete after a short delay
            setTimeout(() => {
                isInitialLoad = false;
            }, 1000);

            // Cleanup listener when leaving marketplace
            return () => {
                if (loadTimeout) {
                    clearTimeout(loadTimeout);
                }
                unsubscribe();
            };
        }
    }, [currentPage, address, userCoordinates]);

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
            // Load packages from Firestore
            const packagesQuery = collection(db, 'packages');
            const packagesSnapshot = await getDocs(packagesQuery);
            const packagesMap = {};
            packagesSnapshot.docs.forEach(doc => {
                packagesMap[doc.id] = { id: doc.id, ...doc.data() };
            });

            // Fallback to local packages if Firestore is empty
            if (Object.keys(packagesMap).length === 0) {

                // Try to auto-create packages
                try {
                    await initializePackagesIfEmpty();
                    // Reload packages after creation
                    const retrySnapshot = await getDocs(collection(db, 'packages'));
                    retrySnapshot.docs.forEach(doc => {
                        packagesMap[doc.id] = { id: doc.id, ...doc.data() };
                    });

                    if (Object.keys(packagesMap).length === 0) {
                        // Still empty, use local fallback
                        PACKAGES_DATA.forEach(pkg => {
                            packagesMap[pkg.id] = pkg;
                        });
                    }
                } catch (error) {
                    console.error('Error auto-creating packages:', error);
                    // Fallback to local packages
                    PACKAGES_DATA.forEach(pkg => {
                        packagesMap[pkg.id] = pkg;
                    });
                }
            }

            // Query detailer collection

            const providersQuery = query(
                collection(db, 'detailer')
            );

            let snapshot;
            try {
                snapshot = await getDocs(providersQuery);
            } catch (queryError) {
                console.error('Firestore Query Error:', queryError);
                throw queryError; // Re-throw to be caught by outer catch
            }

            const loadedDetailers = await Promise.all(snapshot.docs.map(async (docSnapshot) => {
                const data = docSnapshot.data();

                // Load packages for this provider
                const offeredPackages = data.offeredPackages || [];
                const customPrices = data.packagePrices || {};

                const packages = offeredPackages
                    .map(pkgId => {
                        const pkg = packagesMap[pkgId];
                        if (!pkg) {
                            console.warn(`⚠️ Package ${pkgId} not found in packagesMap for provider ${data.businessName}`);
                            return undefined;
                        }
                        // Merge custom prices if they exist
                        if (customPrices[pkgId]) {
                            return {
                                ...pkg,
                                price: customPrices[pkgId].price
                            };
                        }
                        return pkg;
                    })
                    .filter(pkg => pkg !== undefined);

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
                    id: docSnapshot.id,
                    userId: data.uid, // Provider's user UID (now same as document ID)
                    name: data.businessName || data.name || 'Professional Detailer',
                    ownerName: data.name,
                    rating: (data.reviewCount && data.reviewCount > 0) ? (data.rating || null) : null,
                    reviews: data.reviewCount || 0,
                    distance: distance,
                    available: data.status === 'approved' && packages.length > 0, // Must be approved and have packages!
                    price: getStartingPriceFromPackages(packages),
                    image: data.image || null,
                    about: aboutText,
                    packages: packages, // New: packages array
                    addOns: data.addOns || [], // Available add-ons
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
                    hasPackages: packages.length > 0
                };
            }));

            // Show providers that are APPROVED
            // Note: We'll show approved providers even if they don't have packages yet
            // (they can add packages in their dashboard)
            let availableDetailers = loadedDetailers.filter(d => {
                const isApproved = d.status === 'approved';
                if (!isApproved) {
                    console.log(`❌ Filtered out: ${d.name} - Status: ${d.status}`);
                } else if (!d.hasPackages) {
                    console.warn(`⚠️ Approved provider ${d.name} has no packages yet`);
                }
                return isApproved;
            });

            console.log('✅ Filtered detailers:', {
                total: loadedDetailers.length,
                approved: availableDetailers.length,
                withPackages: availableDetailers.filter(d => d.hasPackages).length,
                withoutPackages: availableDetailers.filter(d => !d.hasPackages).length,
                detailerNames: availableDetailers.map(d => d.name),
                detailerIds: availableDetailers.map(d => d.id)
            });

            // Sort by distance (closest first) by default
            availableDetailers.sort((a, b) => a.distance - b.distance);

            setDetailers(availableDetailers);
        } catch (error) {
            // Enhanced error logging
            console.error('Error loading detailers:', error);

            // More specific error messages
            let errorMessage = 'Error loading detailers. ';
            if (error.code === 'permission-denied') {
                errorMessage += 'Permission denied. Check Firestore rules.';
                console.error('PERMISSION DENIED - Check Firestore rules and authentication');
            } else if (error.code === 'unavailable') {
                errorMessage += 'Firebase is unavailable. Check your connection.';
            } else if (error.code === 'failed-precondition') {
                errorMessage += 'Query requires an index. Check Firebase Console.';
            } else {
                errorMessage += `Error: ${error.message}`;
            }

            // Always show alert and log to console
            alert(`${errorMessage}\n\nCheck console (F12) for details.`);

            // Fallback to mock data if error
            console.warn('Falling back to mock data');
            setDetailers(getMockDetailers());
        }
    }

    function getStartingPrice(services) {
        if (!services || services.length === 0) return 65;
        const prices = services.map(s => s.price || 0).filter(p => p > 0);
        return prices.length > 0 ? Math.min(...prices) : 65;
    }

    function getStartingPriceFromPackages(packages) {
        if (!packages || packages.length === 0) return 150;
        const prices = packages.map(pkg => pkg.price || 0).filter(p => p > 0);
        return prices.length > 0 ? Math.min(...prices) : 150;
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
                rating: null,
                reviews: 0,
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
                rating: null,
                reviews: 0,
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

            // Determine which collection to use based on account type
            const accountType = signupData.accountType || 'customer';
            const collectionName = accountType === 'provider' ? 'detailer' : 'customer';

            // Create user document data
            const userData = {
                uid: userCredential.user.uid,
                email: userCredential.user.email,
                displayName: signupData.name,
                photoURL: userCredential.user.photoURL,
                createdAt: serverTimestamp(),
            };

            // Create document in the appropriate collection
            if (accountType === 'provider') {
                // Create detailer document
                await setDoc(doc(db, 'detailer', userCredential.user.uid), {
                    ...userData,
                    businessName: signupData.name || 'New Business',
                    businessAddress: '',
                    serviceArea: '',
                    phone: '',
                    services: [],
                    offeredPackages: [],
                    addOns: [],
                    packagePrices: {},
                    defaultAvailability: {
                        monday: { enabled: false, start: '09:00', end: '17:00' },
                        tuesday: { enabled: false, start: '09:00', end: '17:00' },
                        wednesday: { enabled: false, start: '09:00', end: '17:00' },
                        thursday: { enabled: false, start: '09:00', end: '17:00' },
                        friday: { enabled: false, start: '09:00', end: '17:00' },
                        saturday: { enabled: false, start: '09:00', end: '17:00' },
                        sunday: { enabled: false, start: '09:00', end: '17:00' }
                    },
                    dateOverrides: {},
                    rating: 0,
                    reviewCount: 0,
                    employeeCount: 1,
                    backgroundCheck: false,
                    status: 'pending',
                    onboarded: false
                });
            } else {
                // Create customer document
                await setDoc(doc(db, 'customer', userCredential.user.uid), {
                    ...userData,
                    savedAddresses: [],
                    favoriteProviders: [],
                    address: address || '',
                    coordinates: userCoordinates || null,
                    preferences: answers || {},
                    onboarded: false
                });
            }

            // Set user info immediately
            const userInfo = {
                uid: userCredential.user.uid,
                email: userCredential.user.email,
                name: signupData.name || userCredential.user.email.split('@')[0],
                photoURL: userCredential.user.photoURL,
                initials: getInitials(signupData.name || userCredential.user.email)
            };
            setCurrentUser(userInfo);

            // Set account type for routing
            setUserAccountType(signupData.accountType || 'customer');
            if (signupData.accountType === 'provider') {
                // Providers need to complete onboarding (business credentials)
                setIsProvider(true);
                setCurrentPage('landing');
                // Pre-fill email in onboarding form
                setProviderOnboardingData({
                    businessName: '',
                    businessAddress: '',
                    serviceArea: '',
                    phone: '',
                    email: signupData.email || userCredential.user.email || ''
                });
                setModalType('providerOnboarding');
            } else {
                // Customers need to enter address after signup
                setModalType('address');
            }
        } catch (error) {
            console.error('Signup error:', error);
            alert(error.message);
        }
    }

    // Email/password login function
    async function handleEmailLogin() {
        try {
            if (!loginData.email || !loginData.password) {
                alert('Please enter your email and password');
                return;
            }

            const result = await signInWithEmailAndPassword(auth, loginData.email, loginData.password);

            // Check if user exists in customer or detailer collection
            const customerDoc = await getDoc(doc(db, 'customer', result.user.uid));
            const detailerDoc = await getDoc(doc(db, 'detailer', result.user.uid));

            if (!customerDoc.exists() && !detailerDoc.exists()) {
                // User doesn't exist - create a basic customer account automatically

                // Set flag to prevent auth listener from signing out during creation
                isCreatingAccountRef.current = true;

                const userData = {
                    uid: result.user.uid,
                    email: result.user.email,
                    displayName: result.user.displayName || loginData.email.split('@')[0],
                    photoURL: result.user.photoURL,
                    createdAt: serverTimestamp(),
                    savedAddresses: [],
                    favoriteProviders: [],
                    address: '',
                    coordinates: null,
                    preferences: {},
                    onboarded: false
                };

                await setDoc(doc(db, 'customer', result.user.uid), userData);

                // Clear the flag after a short delay to allow auth listener to process
                setTimeout(() => {
                    isCreatingAccountRef.current = false;
                }, 2000);

                // Set account type and show address modal (same flow as signup)
                setUserAccountType('customer');
                setModalType('address');
                setLoginData({ email: '', password: '' });
                return;
            }

            // Close login modal - auth listener will handle routing
            setModalType(null);
            setLoginData({ email: '', password: '' });
        } catch (error) {
            console.error('❌ Email login error:', error.code, error.message);

            if (error.code === 'auth/user-not-found') {
                // No account found - redirect to signup with email pre-filled
                setSignupData({ ...signupData, email: loginData.email });
                setModalType('signup');
                // Clear password from login data for security
                setLoginData({ email: loginData.email, password: '' });
            } else {
                // Other errors - show alert
                let errorMessage = 'Login failed. ';
                if (error.code === 'auth/wrong-password') {
                    errorMessage += 'Incorrect password.';
                } else if (error.code === 'auth/invalid-email') {
                    errorMessage += 'Invalid email address.';
                } else {
                    errorMessage += error.message;
                }
                alert(errorMessage);
            }
        }
    }

    // Generic Google sign-in function
    const startGoogleSignIn = async () => {
        try {
            await signInWithPopup(auth, googleProvider);
        } catch (error) {
            console.error('Google Popup Error', error);
            if (error.code === 'permission-denied') {
                alert('Permission error. Please check Firestore rules.');
            } else {
                alert(`Sign-in failed: ${error.message}`);
            }
        }
    };

    // Login function - for existing users
    async function handleGoogleLogin() {
        // Clear any pending role (login doesn't create new accounts)
        localStorage.removeItem('pendingUserRole');
        await startGoogleSignIn();
    }

    // Signup function - for new users going through onboarding
    async function handleGoogleSignup() {
        // Role is already stored in localStorage by SignupModal
        // Just trigger Google sign-in, auth listener will handle account creation
        await startGoogleSignIn();
    }

    async function handleLogout() {
        try {
            // Clear all local state first
            setCurrentUser(null);
            setUserAccountType(null);
            setIsProvider(false);
            setShowProfileDropdown(false);
            setAddress('');
            setAnswers({
                vehicleType: '',
                serviceType: '',
                timeSlot: ''
            });
            setUserCoordinates(null);
            setDetailers([]);

            // Sign out from Firebase
            await signOut(auth);

            // Clear Firebase Auth storage from browser
            try {
                // Clear Firebase Auth persistence
                if (typeof window !== 'undefined' && window.indexedDB) {
                    // Clear IndexedDB Firebase Auth storage
                    const deleteReq = indexedDB.deleteDatabase('firebaseLocalStorageDb');
                    deleteReq.onsuccess = () => {
                    };
                    deleteReq.onerror = () => {
                        console.warn('⚠️ Could not clear Firebase Auth storage');
                    };
                }
                // Also clear localStorage Firebase keys
                Object.keys(localStorage).forEach(key => {
                    if (key.startsWith('firebase:authUser:')) {
                        localStorage.removeItem(key);
                    }
                });
            } catch (storageError) {
                console.warn('⚠️ Could not clear browser storage:', storageError);
            }

            // Navigate to landing page
            setCurrentPage('landing');

            // Clear any modals
            setModalType(null);

            // Force page reload to clear any cached state
            window.location.reload();
        } catch (error) {
            console.error('❌ Error during logout:', error);
            // Still navigate to landing page even if signOut fails
            setCurrentPage('landing');
            setCurrentUser(null);
            // Force reload to clear state
            window.location.reload();
        }
    }

    // ==================== ONBOARDING FLOW ====================
    const startOnboarding = useCallback(() => {
        // If user is already logged in but needs address, show address modal
        if (currentUser && userAccountType === 'customer' && !address) {
            setModalType('address');
        } else {
            // Show signup modal first - users can choose customer or provider
            setModalType('signup');
        }
    }, [currentUser, userAccountType, address]);

    const startLogin = useCallback(() => {
        // Show login modal for returning users
        setModalType('login');
    }, []);

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

            // Save address to customer's document and subcollection if user is logged in
            if (currentUser && currentUser.uid) {
                try {
                    // Update customer document with address (customers only, detailers don't need this)
                    const customerDocRef = doc(db, 'customer', currentUser.uid);
                    const customerDoc = await getDoc(customerDocRef);
                    if (customerDoc.exists()) {
                        await updateDoc(customerDocRef, {
                            address: coords.formattedAddress || address,
                            coordinates: coords,
                            updatedAt: serverTimestamp()
                        });

                        // Save to addresses subcollection
                        const addrDoc = doc(collection(db, 'customer', currentUser.uid, 'addresses'));
                        await setDoc(addrDoc, {
                            label: 'Home',
                            address: coords.formattedAddress || address,
                            coordinates: coords,
                            createdAt: serverTimestamp(),
                            updatedAt: serverTimestamp()
                        });
                    }
                } catch (e) {
                    console.warn('Could not save address:', e?.message || e);
                }
            }

            // Close modal and go to marketplace
            setModalType(null);
            setCurrentPage('marketplace');
        } catch (error) {
            console.error('Error geocoding address:', error);
            alert('Error validating address. Please try again.');
            setModalType(originalModalType);
        }
    }

    // Question handlers removed - questions flow removed

    // ==================== PROVIDER ONBOARDING ====================
    async function handleProviderOnboarding() {
        if (!currentUser || !currentUser.uid) {
            alert('You must be logged in to complete provider onboarding');
            return;
        }

        if (!providerOnboardingData.businessName || !providerOnboardingData.businessAddress) {
            alert('Please fill in all required fields (Business Name and Business Address)');
            return;
        }

        try {
            // Use coordinates from Google Places Autocomplete if available
            let coords = userCoordinates;

            // Check if we already have coordinates from Google Places Autocomplete
            // The coordinates should match the business address if user selected from autocomplete
            if (coords && coords.lat && coords.lng && coords.formattedAddress) {
                // Verify the address matches (allowing for slight variations)
                const addressMatches = coords.formattedAddress === providerOnboardingData.businessAddress ||
                    providerOnboardingData.businessAddress.includes(coords.formattedAddress.split(',')[0]) ||
                    coords.formattedAddress.includes(providerOnboardingData.businessAddress.split(',')[0]);

                if (addressMatches) {
                } else {
                    console.warn('⚠️ Address mismatch, but using existing coordinates');
                    // Still use the coordinates but update the formatted address
                    coords = {
                        ...coords,
                        formattedAddress: providerOnboardingData.businessAddress
                    };
                }
            } else {
                // No coordinates available - user must select from autocomplete
                if (!providerOnboardingData.businessAddress || !providerOnboardingData.businessAddress.trim()) {
                    alert('Please enter a valid business address.');
                    return;
                }

                alert('Please select an address from the suggestions dropdown. This ensures accurate location data.');
                return;
            }

            // Update detailer document with provider business information
            const detailerDocRef = doc(db, 'detailer', currentUser.uid);
            await updateDoc(detailerDocRef, {
                businessName: providerOnboardingData.businessName,
                businessAddress: providerOnboardingData.businessAddress,
                serviceArea: providerOnboardingData.serviceArea || providerOnboardingData.businessAddress,
                phone: providerOnboardingData.phone || '',
                email: providerOnboardingData.email || currentUser.email,
                coordinates: coords,
                onboarded: true,
                updatedAt: serverTimestamp()
            });


            // Close modal and go to dashboard
            setModalType(null);
            setCurrentPage('dashboard');

            // Update local state
            setAddress(providerOnboardingData.businessAddress);
            setUserCoordinates(coords);
        } catch (error) {
            console.error('Error completing provider onboarding:', error);
            alert(`Error saving business information: ${error.message}`);
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
                    onLogin={startLogin}
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
                (userAccountType === 'provider' || isProvider || currentUser?.role === 'admin') ? (
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

            {modalType === 'login' && (
                <LoginModal
                    loginData={loginData}
                    setLoginData={setLoginData}
                    onEmailLogin={handleEmailLogin}
                    onGoogleLogin={handleGoogleLogin}
                    onClose={() => setModalType(null)}
                    onSwitchToSignup={() => {
                        setModalType('signup');
                        // Pre-fill email if they entered it
                        if (loginData.email) {
                            setSignupData({ ...signupData, email: loginData.email });
                        }
                    }}
                />
            )}

            {modalType === 'signup' && (
                <SignupModal
                    signupData={signupData}
                    setSignupData={setSignupData}
                    onEmailSignup={handleEmailSignup}
                    onGoogleSignup={handleGoogleSignup}
                    onBack={null}
                    onClose={() => setModalType(null)}
                    onSwitchToLogin={() => {
                        setModalType('login');
                        // Pre-fill email if they entered it
                        if (signupData.email) {
                            setLoginData({ ...loginData, email: signupData.email });
                        }
                    }}
                />
            )}

            {modalType === 'providerOnboarding' && (
                <ProviderOnboardingModal
                    providerOnboardingData={providerOnboardingData}
                    setProviderOnboardingData={setProviderOnboardingData}
                    addressInputRef={addressInputRef}
                    onSubmit={handleProviderOnboarding}
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
                        {onLogin && (
                            <button
                                onClick={onLogin}
                                className="w-full sm:w-auto bg-transparent border-2 border-white text-white px-8 sm:px-12 py-3 sm:py-4 rounded-xl text-lg sm:text-xl font-semibold hover:bg-white/10 transition-all transform hover:scale-105"
                            >
                                Sign In
                            </button>
                        )}
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

// QuestionsModal component removed - questions flow removed

// ==================== LOGIN MODAL ====================
function LoginModal({ loginData, setLoginData, onEmailLogin, onGoogleLogin, onClose, onSwitchToSignup }) {
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
                        Welcome back
                    </h2>
                    <p className="text-gray-600">
                        Sign in to your account
                    </p>
                </div>

                <div className="space-y-4 mb-6">
                    <input
                        type="email"
                        value={loginData.email}
                        onChange={(e) => setLoginData({ ...loginData, email: e.target.value })}
                        placeholder="Email"
                        className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                        onKeyPress={(e) => {
                            if (e.key === 'Enter' && loginData.email && loginData.password) {
                                onEmailLogin();
                            }
                        }}
                    />
                    <input
                        type="password"
                        value={loginData.password}
                        onChange={(e) => setLoginData({ ...loginData, password: e.target.value })}
                        placeholder="Password"
                        className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                        onKeyPress={(e) => {
                            if (e.key === 'Enter' && loginData.email && loginData.password) {
                                onEmailLogin();
                            }
                        }}
                    />
                </div>

                <button
                    onClick={onEmailLogin}
                    disabled={!loginData.email || !loginData.password}
                    className="w-full bg-blue-600 text-white py-3 rounded-xl font-semibold hover:bg-blue-700 transition-colors mb-4 disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                    Sign In
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
                    onClick={onGoogleLogin}
                    className="w-full bg-white border-2 border-gray-200 text-gray-700 py-3 rounded-xl font-semibold hover:bg-gray-50 transition-colors flex items-center justify-center gap-2 mb-4"
                >
                    <svg className="w-5 h-5" viewBox="0 0 24 24">
                        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                    </svg>
                    Continue with Google
                </button>

                <div className="text-center">
                    <button
                        onClick={onSwitchToSignup}
                        className="text-blue-600 font-medium hover:text-blue-700"
                    >
                        Don't have an account? Sign up
                    </button>
                </div>
            </div>
        </div>
    );
}

// ==================== PROVIDER ONBOARDING MODAL ====================
function ProviderOnboardingModal({ providerOnboardingData, setProviderOnboardingData, addressInputRef, onSubmit, onClose }) {
    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50 overflow-y-auto">
            <div className="bg-white rounded-2xl max-w-2xl w-full p-8 relative my-8 animate-fadeIn">
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
                >
                    <X className="w-6 h-6" />
                </button>

                <div className="mb-6">
                    <h2 className="text-2xl font-bold text-gray-900 mb-2">
                        Complete Your Provider Profile
                    </h2>
                    <p className="text-gray-600">
                        Please provide your business information to get started
                    </p>
                </div>

                <div className="space-y-4 mb-6">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Business Name <span className="text-red-500">*</span>
                        </label>
                        <input
                            type="text"
                            value={providerOnboardingData.businessName}
                            onChange={(e) => setProviderOnboardingData({ ...providerOnboardingData, businessName: e.target.value })}
                            placeholder="Your Business Name"
                            className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Business Address <span className="text-red-500">*</span>
                        </label>
                        <input
                            ref={addressInputRef}
                            type="text"
                            value={providerOnboardingData.businessAddress}
                            onChange={(e) => setProviderOnboardingData({ ...providerOnboardingData, businessAddress: e.target.value })}
                            placeholder="Start typing your business address..."
                            className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                        />
                        <p className="mt-1 text-xs text-gray-500">
                            This address will be used to help customers find you
                        </p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Service Area (Optional)
                        </label>
                        <input
                            type="text"
                            value={providerOnboardingData.serviceArea}
                            onChange={(e) => setProviderOnboardingData({ ...providerOnboardingData, serviceArea: e.target.value })}
                            placeholder="e.g., Los Angeles, CA or 25 miles radius"
                            className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Business Phone (Optional)
                        </label>
                        <input
                            type="tel"
                            value={providerOnboardingData.phone}
                            onChange={(e) => setProviderOnboardingData({ ...providerOnboardingData, phone: e.target.value })}
                            placeholder="(555) 123-4567"
                            className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Business Email (Optional)
                        </label>
                        <input
                            type="email"
                            value={providerOnboardingData.email}
                            onChange={(e) => setProviderOnboardingData({ ...providerOnboardingData, email: e.target.value })}
                            placeholder="business@example.com"
                            className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                        />
                    </div>
                </div>

                <button
                    onClick={onSubmit}
                    disabled={!providerOnboardingData.businessName || !providerOnboardingData.businessAddress}
                    className="w-full bg-blue-600 text-white py-3 rounded-xl font-semibold hover:bg-blue-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                    Complete Setup
                </button>
            </div>
        </div>
    );
}

function SignupModal({ signupData, setSignupData, onEmailSignup, onGoogleSignup, onBack, onClose, onSwitchToLogin }) {
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
                        Choose your account type to get started
                    </p>
                </div>

                {/* Account Type Selection */}
                <div className="mb-6">
                    <label className="block text-sm font-medium text-gray-700 mb-3">
                        I want to sign up as:
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                        <button
                            type="button"
                            onClick={() => setSignupData({ ...signupData, accountType: 'customer' })}
                            className={`px-4 py-3 rounded-xl border-2 font-medium transition-all ${signupData.accountType === 'customer'
                                ? 'border-blue-600 bg-blue-50 text-blue-700'
                                : 'border-gray-200 text-gray-700 hover:border-gray-300'
                                }`}
                        >
                            Customer
                        </button>
                        <button
                            type="button"
                            onClick={() => setSignupData({ ...signupData, accountType: 'provider' })}
                            className={`px-4 py-3 rounded-xl border-2 font-medium transition-all ${signupData.accountType === 'provider'
                                ? 'border-blue-600 bg-blue-50 text-blue-700'
                                : 'border-gray-200 text-gray-700 hover:border-gray-300'
                                }`}
                        >
                            Provider
                        </button>
                    </div>
                    {signupData.accountType === 'provider' && (
                        <p className="mt-2 text-xs text-gray-500">
                            Providers will need to complete additional information after signup
                        </p>
                    )}
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
                    onClick={() => {
                        // Store role in localStorage before Google sign-in
                        const role = signupData.accountType === 'provider' ? 'detailer' : 'customer';
                        localStorage.setItem('pendingUserRole', role);
                        onGoogleSignup();
                    }}
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

                <div className="flex items-center justify-center mt-4">
                    {onSwitchToLogin && (
                        <button
                            onClick={onSwitchToLogin}
                            className="text-blue-600 font-medium hover:text-blue-700"
                        >
                            Already have an account? Sign in
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

// ==================== BOOKING SIDEBAR COMPONENT ====================
function BookingSidebar({
    detailer,
    selectedPackage: selectedPackageProp,
    setSelectedPackage: setSelectedPackageProp,
    selectedAddOns: selectedAddOnsProp,
    setSelectedAddOns: setSelectedAddOnsProp,
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
    const [selectedPackageState, setSelectedPackageState] = useState(selectedPackageProp || null);
    const [selectedAddOnsState, setSelectedAddOnsState] = useState(selectedAddOnsProp || []);
    const [selectedTimeState, setSelectedTimeState] = useState(selectedTimeProp || '');
    const [selectedDateState, setSelectedDateState] = useState(selectedDateProp || '');
    const [isBookingState, setIsBookingState] = useState(!!isBookingProp);
    const [packageExpanded, setPackageExpanded] = useState(true);
    const [showPayment, setShowPayment] = useState(false);
    const [bookingData, setBookingData] = useState(null);

    const selectedPackage = selectedPackageProp ?? selectedPackageState;
    const setSelectedPackage = setSelectedPackageProp ?? setSelectedPackageState;
    const selectedAddOns = selectedAddOnsProp ?? selectedAddOnsState;
    const setSelectedAddOns = setSelectedAddOnsProp ?? setSelectedAddOnsState;
    const selectedTime = selectedTimeProp ?? selectedTimeState;
    const setSelectedTime = setSelectedTimeProp ?? setSelectedTimeState;
    const selectedDate = selectedDateProp ?? selectedDateState;
    const setSelectedDate = setSelectedDateProp ?? setSelectedDateState;
    const isBooking = isBookingProp ?? isBookingState;

    // Get current user from auth if not provided
    const currentUser = currentUserProp || auth.currentUser;

    // Available packages from detailer, sorted by price (low to high)
    const availablePackages = useMemo(() => {
        if (!detailer.packages || detailer.packages.length === 0) return [];
        // Create a copy to avoid mutating the original array
        const sorted = [...detailer.packages].sort((a, b) => {
            const priceA = Number(a.price) || 0;
            const priceB = Number(b.price) || 0;
            return priceA - priceB; // Sort low to high
        });
        return sorted;
    }, [detailer.packages]);

    // Available add-ons (from detailer or all add-ons)
    const availableAddOnsList = detailer.addOns
        ? ADD_ONS.filter(addon => detailer.addOns.includes(addon.id))
        : ADD_ONS;

    // Calculate total price: package price + add-ons
    const totalPrice = useMemo(() => {
        let price = 0;
        if (selectedPackage) {
            // Use single price
            price = selectedPackage.price;
        }
        // Add selected add-ons
        selectedAddOns.forEach(addOnId => {
            const addOn = ADD_ONS.find(a => a.id === addOnId);
            if (addOn) {
                price += addOn.price;
            }
        });
        return price;
    }, [selectedPackage, selectedAddOns]);

    useEffect(() => {
        // Reset selection when detailer changes
        setSelectedPackage(null);
        setSelectedAddOns([]);
        setPackageExpanded(true);
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

    // Toggle add-on selection
    const toggleAddOn = (addOnId) => {
        setSelectedAddOns(prev =>
            prev.includes(addOnId)
                ? prev.filter(id => id !== addOnId)
                : [...prev, addOnId]
        );
    };

    async function handleBookNow() {
        if (!currentUser) {
            alert('Please log in to book a service');
            return;
        }

        // Prevent providers from booking services
        try {
            // Check if user is a detailer
            const detailerDoc = await getDoc(doc(db, 'detailer', currentUser.uid));
            if (detailerDoc.exists()) {
                alert('Providers cannot book services. Please use your provider dashboard to manage bookings.');
                return;
            }
        } catch (err) {
            console.warn('Could not check if user is provider:', err);
        }

        if (!selectedPackage) {
            alert('Please select a package');
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
            // Store package data
            packageId: selectedPackage.id,
            packageName: selectedPackage.name,
            packagePrice: selectedPackage.price,
            exteriorServices: selectedPackage.exteriorServices || [],
            interiorServices: selectedPackage.interiorServices || [],
            addOns: selectedAddOns.map(addOnId => {
                const addOn = ADD_ONS.find(a => a.id === addOnId);
                return addOn ? { id: addOn.id, name: addOn.name, price: addOn.price } : null;
            }).filter(Boolean),
            // Keep serviceName for backward compatibility
            serviceName: selectedPackage.name,
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
            const bookingId = bookingRef.id;

            // Create notifications for provider
            try {
                const bookingWithId = { ...finalBookingData, id: bookingId };
                // Notify provider of new booking
                await notifyNewBooking(bookingData.providerUserId, bookingWithId);
                // Notify provider of payment received
                await notifyPaymentReceived(bookingData.providerUserId, bookingWithId);
                // Notify provider of booking confirmed
                await notifyBookingConfirmed(bookingData.providerUserId, bookingWithId);
            } catch (notifError) {
                console.warn('Failed to create notifications:', notifError);
            }

            const serviceText = bookingData.packageName || bookingData.serviceName || 'service';
            alert(`Booking confirmed! Your ${serviceText} is scheduled for ${bookingData.date} at ${bookingData.time}.`);

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
        const serviceText = selectedPackage ? selectedPackage.name : 'your booking';
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
                            <Star className={`w-4 h-4 ${detailer.reviews > 0 ? 'fill-yellow-400 text-yellow-400' : 'fill-gray-300 text-gray-300'}`} />
                            {detailer.rating && detailer.reviews > 0 ? (
                                <>
                                    <span className="font-semibold">{detailer.rating}</span>
                                    <span className="text-gray-500">({detailer.reviews})</span>
                                </>
                            ) : (
                                <span className="text-gray-500">No reviews yet</span>
                            )}
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

            {/* Select Package */}
            <div className="mb-6">
                <div className="flex items-center justify-between mb-4">
                    <h4 className="font-semibold text-gray-900">Select Package</h4>
                    {selectedPackage && (
                        <button
                            onClick={() => setPackageExpanded(!packageExpanded)}
                            className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                        >
                            {packageExpanded ? 'Hide' : 'Show'} Packages
                        </button>
                    )}
                </div>

                {/* Show selected package summary when collapsed */}
                {selectedPackage && !packageExpanded && (
                    <div className="mb-4 space-y-2">
                        <div className="p-4 bg-blue-50 border-2 border-blue-200 rounded-lg">
                            <div className="flex items-center justify-between mb-2">
                                <div>
                                    <div className="font-semibold text-gray-900">{selectedPackage.name}</div>
                                </div>
                                <div className="text-right">
                                    <div className="font-bold text-gray-900">${selectedPackage.price}</div>
                                </div>
                            </div>
                            {selectedAddOns.length > 0 && (
                                <div className="mt-2 pt-2 border-t border-blue-200">
                                    <div className="text-xs text-gray-600 mb-1">Add-ons:</div>
                                    {selectedAddOns.map(addOnId => {
                                        const addOn = ADD_ONS.find(a => a.id === addOnId);
                                        return addOn ? (
                                            <div key={addOnId} className="text-xs text-gray-700">+ {addOn.name} (${addOn.price})</div>
                                        ) : null;
                                    })}
                                </div>
                            )}
                        </div>
                        <div className="p-3 bg-gray-50 border-2 border-gray-200 rounded-lg">
                            <div className="flex items-center justify-between">
                                <span className="font-semibold text-gray-900 text-sm">Total:</span>
                                <span className="font-bold text-gray-900">${totalPrice}</span>
                            </div>
                        </div>
                        <button
                            onClick={() => setPackageExpanded(true)}
                            className="w-full text-xs text-blue-600 hover:text-blue-700 font-medium"
                        >
                            Change Package
                        </button>
                    </div>
                )}

                {/* Packages list - only show when expanded or no package selected */}
                {(packageExpanded || !selectedPackage) && (
                    <div className="space-y-3">
                        {availablePackages.length === 0 ? (
                            <p className="text-sm text-gray-500">No packages available.</p>
                        ) : (
                            availablePackages.map((pkg) => {
                                const isSelected = selectedPackage?.id === pkg.id;
                                return (
                                    <div
                                        key={pkg.id}
                                        onClick={() => setSelectedPackage(pkg)}
                                        className={`w-full text-left p-4 border-2 rounded-lg transition-all cursor-pointer ${isSelected
                                            ? 'border-blue-600 bg-blue-50'
                                            : 'border-gray-200 hover:border-blue-300'
                                            }`}
                                    >
                                        <div className="flex items-start justify-between gap-3 mb-2">
                                            <div className="flex items-center gap-3 flex-1 min-w-0">
                                                <input
                                                    type="radio"
                                                    checked={isSelected}
                                                    onChange={() => setSelectedPackage(pkg)}
                                                    className="w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500 flex-shrink-0 mt-1"
                                                />
                                                <div className="flex-1 min-w-0">
                                                    <div className="font-semibold text-gray-900 text-base mb-1">{pkg.name}</div>
                                                    <div className="text-xs text-gray-500 mb-2">{pkg.description}</div>
                                                </div>
                                            </div>
                                            <div className="text-right flex-shrink-0">
                                                <div className="font-bold text-gray-900">${pkg.price}</div>
                                            </div>
                                        </div>

                                        {/* Show services included when selected */}
                                        {isSelected && (
                                            <div className="mt-3 pt-3 border-t border-blue-200">
                                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                                                    <div>
                                                        <div className="font-semibold text-gray-700 mb-1">Exterior:</div>
                                                        <ul className="space-y-1 text-gray-600">
                                                            {pkg.exteriorServices.map((svc, idx) => (
                                                                <li key={idx} className="flex items-start">
                                                                    <CheckCircle2 className="w-3 h-3 text-green-500 mr-1 mt-0.5 flex-shrink-0" />
                                                                    <span>{svc}</span>
                                                                </li>
                                                            ))}
                                                        </ul>
                                                    </div>
                                                    <div>
                                                        <div className="font-semibold text-gray-700 mb-1">Interior:</div>
                                                        <ul className="space-y-1 text-gray-600">
                                                            {pkg.interiorServices.map((svc, idx) => (
                                                                <li key={idx} className="flex items-start">
                                                                    <CheckCircle2 className="w-3 h-3 text-green-500 mr-1 mt-0.5 flex-shrink-0" />
                                                                    <span>{svc}</span>
                                                                </li>
                                                            ))}
                                                        </ul>
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </div>
                )}

                {/* Add-ons section - only show when package is selected */}
                {selectedPackage && availableAddOnsList.length > 0 && (
                    <div className="mt-4 pt-4 border-t border-gray-200">
                        <h5 className="font-semibold text-gray-900 mb-3 text-sm">Add-ons (Optional)</h5>
                        <div className="space-y-2">
                            {availableAddOnsList.map((addOn) => {
                                const isSelected = selectedAddOns.includes(addOn.id);
                                return (
                                    <div
                                        key={addOn.id}
                                        onClick={() => toggleAddOn(addOn.id)}
                                        className={`w-full text-left px-3 py-2 border-2 rounded-lg transition-all cursor-pointer ${isSelected
                                            ? 'border-blue-600 bg-blue-50'
                                            : 'border-gray-200 hover:border-blue-300'
                                            }`}
                                    >
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="flex items-center gap-2 flex-1 min-w-0">
                                                <input
                                                    type="checkbox"
                                                    checked={isSelected}
                                                    onChange={() => toggleAddOn(addOn.id)}
                                                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 flex-shrink-0"
                                                />
                                                <div className="flex-1 min-w-0">
                                                    <div className="font-semibold text-gray-900 text-sm">{addOn.name}</div>
                                                    <div className="text-xs text-gray-500">{addOn.description}</div>
                                                </div>
                                            </div>
                                            <div className="text-right flex-shrink-0">
                                                <div className="font-bold text-gray-900 text-sm">+${addOn.price}</div>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
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
                {selectedPackage && (
                    <div className="p-4 bg-gray-50 rounded-lg mb-4">
                        <div className="mb-2 space-y-1">
                            <div className="flex items-center justify-between text-sm">
                                <span className="text-gray-600">{selectedPackage.name}:</span>
                                <span className="text-gray-900 font-medium">${selectedPackage.price}</span>
                            </div>
                            {selectedAddOns.map(addOnId => {
                                const addOn = ADD_ONS.find(a => a.id === addOnId);
                                return addOn ? (
                                    <div key={addOnId} className="flex items-center justify-between text-sm">
                                        <span className="text-gray-600">+ {addOn.name}:</span>
                                        <span className="text-gray-900 font-medium">${addOn.price}</span>
                                    </div>
                                ) : null;
                            })}
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
                    disabled={isBooking || !selectedPackage || !selectedTime || !selectedDate}
                    className="w-full bg-blue-600 text-white py-4 rounded-xl font-bold text-lg hover:bg-blue-700 transition-colors shadow-lg disabled:bg-gray-300 disabled:cursor-not-allowed mb-4"
                >
                    {isBooking
                        ? 'Booking...'
                        : !selectedPackage
                            ? 'Select Package'
                            : `Book ${selectedPackage.name}`
                    }
                </button>
            </div>

            {/* Mobile: Sticky footer with date/time and book button */}
            <div className="lg:hidden sticky bottom-0 bg-white border-t border-gray-200 p-4 -mx-6 -mb-6 mt-6 shadow-lg">
                {/* Total */}
                {selectedPackage && (
                    <div className="mb-3 p-3 bg-gray-50 rounded-lg">
                        <div className="mb-2 space-y-1">
                            <div className="flex items-center justify-between text-xs">
                                <span className="text-gray-600 truncate pr-2">{selectedPackage.name}:</span>
                                <span className="text-gray-900 font-medium">${selectedPackage.price}</span>
                            </div>
                            {selectedAddOns.map(addOnId => {
                                const addOn = ADD_ONS.find(a => a.id === addOnId);
                                return addOn ? (
                                    <div key={addOnId} className="flex items-center justify-between text-xs">
                                        <span className="text-gray-600 truncate pr-2">+ {addOn.name}:</span>
                                        <span className="text-gray-900 font-medium">${addOn.price}</span>
                                    </div>
                                ) : null;
                            })}
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
                    disabled={isBooking || !selectedPackage || !selectedTime || !selectedDate}
                    className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold text-base hover:bg-blue-700 transition-colors shadow-lg disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                    {isBooking
                        ? 'Booking...'
                        : !selectedPackage
                            ? 'Select Package'
                            : `Book ${selectedPackage.name}`
                    }
                </button>
            </div>

            {/* Payment Modal */}
            {showPayment && bookingData && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                    <PaymentForm
                        amount={bookingData.price}
                        serviceAddress={bookingData.address}
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
                        <Star className={`w-4 h-4 ${detailer.reviews > 0 ? 'fill-yellow-400 text-yellow-400' : 'fill-gray-300 text-gray-300'}`} />
                        {detailer.rating && detailer.reviews > 0 ? (
                            <>
                                <span className="font-semibold">{detailer.rating}</span>
                                <span className="text-sm text-gray-500">({detailer.reviews})</span>
                            </>
                        ) : (
                            <span className="text-sm text-gray-500">No reviews yet</span>
                        )}
                    </div>
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
                                    <Star className={`w-4 h-4 sm:w-5 sm:h-5 ${detailer.reviews > 0 ? 'text-yellow-500 fill-current' : 'text-gray-300 fill-gray-300'}`} />
                                    {detailer.rating && detailer.reviews > 0 ? (
                                        <>
                                            <span className="font-semibold text-base sm:text-lg">{detailer.rating}</span>
                                            <span className="text-gray-500">({detailer.reviews} reviews)</span>
                                        </>
                                    ) : (
                                        <span className="text-gray-500 text-sm sm:text-base">No reviews yet</span>
                                    )}
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
                                    <h3 className="font-semibold text-gray-900 mb-4 text-lg">Packages</h3>
                                    {detailer.packages && detailer.packages.length > 0 ? (
                                        <div className="space-y-4">
                                            {[...detailer.packages].sort((a, b) => {
                                                const priceA = a.price || 0;
                                                const priceB = b.price || 0;
                                                return priceA - priceB; // Sort low to high
                                            }).map((pkg) => (
                                                <div
                                                    key={pkg.id}
                                                    className="p-4 border-2 border-gray-200 rounded-lg hover:border-blue-300 hover:shadow-md transition-all"
                                                >
                                                    <div className="flex items-start justify-between mb-3">
                                                        <div className="flex-1 min-w-0 pr-2">
                                                            <div className="font-semibold text-gray-900 text-base mb-1">{pkg.name}</div>
                                                            <div className="text-xs text-gray-500 mb-2">{pkg.description}</div>
                                                        </div>
                                                        <div className="text-right flex-shrink-0">
                                                            <div className="text-lg font-bold text-blue-600">${pkg.price}</div>
                                                        </div>
                                                    </div>
                                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3 pt-3 border-t border-gray-200">
                                                        <div>
                                                            <div className="text-xs font-semibold text-gray-700 mb-1">Exterior Services:</div>
                                                            <ul className="text-xs text-gray-600 space-y-1">
                                                                {pkg.exteriorServices.map((svc, idx) => (
                                                                    <li key={idx} className="flex items-start">
                                                                        <CheckCircle2 className="w-3 h-3 text-green-500 mr-1 mt-0.5 flex-shrink-0" />
                                                                        <span>{svc}</span>
                                                                    </li>
                                                                ))}
                                                            </ul>
                                                        </div>
                                                        <div>
                                                            <div className="text-xs font-semibold text-gray-700 mb-1">Interior Services:</div>
                                                            <ul className="text-xs text-gray-600 space-y-1">
                                                                {pkg.interiorServices.map((svc, idx) => (
                                                                    <li key={idx} className="flex items-start">
                                                                        <CheckCircle2 className="w-3 h-3 text-green-500 mr-1 mt-0.5 flex-shrink-0" />
                                                                        <span>{svc}</span>
                                                                    </li>
                                                                ))}
                                                            </ul>
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <p className="text-gray-500">No packages available.</p>
                                    )}
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

    // Initialize notifications for customers
    useEffect(() => {
        if (!currentUser) return;

        let unsubscribeNotifications = null;
        let unsubscribeUnread = null;

        async function initializeNotifications() {
            try {
                // Request notification permission and get token
                const token = await requestNotificationPermission();
                if (token) {
                    await saveFCMToken(currentUser.uid, token);
                }

                // Set up foreground message handler
                setupForegroundMessageHandler();

                // Subscribe to notifications with error handling
                try {
                    unsubscribeNotifications = subscribeToNotifications(currentUser.uid, (notifs) => {
                        try {
                            // Handle customer notifications if needed
                            // You can add state management here if needed
                        } catch (error) {
                            console.error('Error handling customer notifications:', error);
                        }
                    });

                    unsubscribeUnread = subscribeToUnreadCount(currentUser.uid, (count) => {
                        try {
                            // Handle unread count if needed
                        } catch (error) {
                            console.error('Error handling unread count:', error);
                        }
                    });
                } catch (subscriptionError) {
                    console.error('Error setting up notification subscriptions:', subscriptionError);
                }
            } catch (error) {
                console.error('Error initializing customer notifications:', error);
            }
        }

        initializeNotifications();

        // Cleanup function
        return () => {
            try {
                if (typeof unsubscribeNotifications === 'function') unsubscribeNotifications();
                if (typeof unsubscribeUnread === 'function') unsubscribeUnread();
            } catch (error) {
                console.warn('Error unsubscribing from notifications:', error);
            }
        };
    }, [currentUser]);

    async function loadDashboardData() {
        setLoading(true);
        try {
            // Load user profile data - check both customer and detailer collections
            const customerDoc = await getDoc(doc(db, 'customer', currentUser.uid));
            const detailerDoc = await getDoc(doc(db, 'detailer', currentUser.uid));

            let userId = null;
            if (customerDoc.exists()) {
                userId = customerDoc.id;
                setUserData({ id: customerDoc.id, ...customerDoc.data() });
            } else if (detailerDoc.exists()) {
                userId = detailerDoc.id;
                setUserData({ id: detailerDoc.id, ...detailerDoc.data() });
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

                    // Get provider details (unified structure)
                    let providerName = 'Unknown Provider';
                    if (booking.providerUserId) {
                        const providerDoc = await getDoc(doc(db, 'detailer', booking.providerUserId));
                        if (providerDoc.exists()) {
                            providerName = providerDoc.data().businessName || providerDoc.data().displayName || 'Unknown Provider';
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
                collection(db, 'customer', userId, 'vehicles')
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
                collection(db, 'customer', userId, 'addresses')
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
                    doc(db, 'customer', userData.id, 'vehicles', editingVehicle.id),
                    vehicleData
                );
                alert('Vehicle updated successfully!');
            } else {
                // Add new vehicle
                await addDoc(
                    collection(db, 'customer', userData.id, 'vehicles'),
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
            await deleteDoc(doc(db, 'customer', userData.id, 'vehicles', vehicleId));
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
                    doc(db, 'customer', userData.id, 'addresses', editingAddress.id),
                    addressData
                );
                alert('Address updated successfully!');
            } else {
                await addDoc(
                    collection(db, 'customer', userData.id, 'addresses'),
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
            await deleteDoc(doc(db, 'customer', userData.id, 'addresses', addressId));
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
    const [isEditingProfile, setIsEditingProfile] = useState(false);
    const [editedAddress, setEditedAddress] = useState('');
    const [editedProfile, setEditedProfile] = useState({
        firstName: '',
        lastName: '',
        phone: ''
    });
    const [editedPreferences, setEditedPreferences] = useState({
        vehicleType: '',
        serviceType: '',
        timeSlot: ''
    });

    useEffect(() => {
        if (userData) {
            setEditedAddress(userData.address || '');
            setEditedProfile({
                firstName: userData.firstName || '',
                lastName: userData.lastName || '',
                phone: userData.phone || ''
            });
            setEditedPreferences(userData.preferences || {
                vehicleType: '',
                serviceType: '',
                timeSlot: ''
            });
        }
    }, [userData]);

    async function handleSaveProfile() {
        if (!userData?.id) return;

        try {
            const userDocRef = doc(db, 'customer', userData.id);
            await updateDoc(userDocRef, {
                firstName: editedProfile.firstName,
                lastName: editedProfile.lastName,
                displayName: `${editedProfile.firstName} ${editedProfile.lastName}`.trim(),
                phone: editedProfile.phone,
                updatedAt: serverTimestamp()
            });

            alert('Profile updated successfully!');
            setIsEditingProfile(false);
            window.location.reload(); // Reload to show updated data
        } catch (error) {
            console.error('Error updating profile:', error);
            alert('Failed to update profile');
        }
    }

    async function handleResetPassword() {
        if (!currentUser?.email) {
            alert('Email address not found. Please contact support.');
            return;
        }

        try {
            await sendPasswordResetEmail(auth, currentUser.email);
            alert('Password reset email sent! Please check your inbox and follow the instructions to reset your password.');
        } catch (error) {
            console.error('Error sending password reset email:', error);
            alert(`Failed to send password reset email: ${error.message}`);
        }
    }

    async function handleSavePreferences() {
        if (!userData?.id) return;

        try {
            const userDocRef = doc(db, 'customer', userData.id);
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
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-bold text-gray-900">Personal Information</h3>
                    {!isEditingProfile && (
                        <button
                            onClick={() => setIsEditingProfile(true)}
                            className="flex items-center gap-2 px-4 py-2 border-2 border-gray-200 rounded-lg font-semibold hover:bg-gray-50"
                        >
                            <Edit2 className="w-4 h-4" />
                            Edit
                        </button>
                    )}
                </div>
                <div className="max-w-2xl">
                    {!isEditingProfile ? (
                        <>
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
                                    <p className="text-xs text-gray-500 mt-1">Email cannot be changed</p>
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
                            <div className="mt-6 pt-6 border-t border-gray-200">
                                <button
                                    onClick={handleResetPassword}
                                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition-colors"
                                >
                                    <Shield className="w-4 h-4" />
                                    Reset Password
                                </button>
                                <p className="text-xs text-gray-500 mt-2">
                                    We'll send a password reset link to your email address.
                                </p>
                            </div>
                        </>
                    ) : (
                        <div className="space-y-4">
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-2">
                                        First Name
                                    </label>
                                    <input
                                        type="text"
                                        value={editedProfile.firstName}
                                        onChange={(e) => setEditedProfile({ ...editedProfile, firstName: e.target.value })}
                                        className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                                        placeholder="First Name"
                                    />
                                </div>

                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-2">
                                        Last Name
                                    </label>
                                    <input
                                        type="text"
                                        value={editedProfile.lastName}
                                        onChange={(e) => setEditedProfile({ ...editedProfile, lastName: e.target.value })}
                                        className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                                        placeholder="Last Name"
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                    Phone
                                </label>
                                <input
                                    type="tel"
                                    value={editedProfile.phone}
                                    onChange={(e) => setEditedProfile({ ...editedProfile, phone: e.target.value })}
                                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                                    placeholder="(555) 123-4567"
                                />
                            </div>

                            <div className="flex gap-3 pt-4">
                                <button
                                    onClick={handleSaveProfile}
                                    className="px-6 py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700"
                                >
                                    Save Changes
                                </button>
                                <button
                                    onClick={() => {
                                        setIsEditingProfile(false);
                                        // Reset to original values
                                        setEditedProfile({
                                            firstName: userData.firstName || '',
                                            lastName: userData.lastName || '',
                                            phone: userData.phone || ''
                                        });
                                    }}
                                    className="px-6 py-3 border-2 border-gray-200 rounded-lg font-semibold hover:bg-gray-50"
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    )}
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

// ==================== NOTIFICATION CENTER ====================
function NotificationCenter({ notifications = [], unreadCount = 0, onMarkAsRead, onMarkAllAsRead }) {
    const getNotificationIcon = (type) => {
        switch (type) {
            case 'new_booking':
                return <Calendar className="w-5 h-5 text-blue-600" />;
            case 'booking_confirmed':
                return <CheckCircle className="w-5 h-5 text-green-600" />;
            case 'booking_cancelled':
                return <X className="w-5 h-5 text-red-600" />;
            case 'payment_received':
                return <DollarSign className="w-5 h-5 text-green-600" />;
            case 'booking_reminder':
                return <Clock className="w-5 h-5 text-yellow-600" />;
            default:
                return <Bell className="w-5 h-5 text-gray-600" />;
        }
    };

    const getNotificationColor = (type) => {
        switch (type) {
            case 'new_booking':
                return 'bg-blue-50 border-blue-200';
            case 'booking_confirmed':
                return 'bg-green-50 border-green-200';
            case 'booking_cancelled':
                return 'bg-red-50 border-red-200';
            case 'payment_received':
                return 'bg-green-50 border-green-200';
            case 'booking_reminder':
                return 'bg-yellow-50 border-yellow-200';
            default:
                return 'bg-gray-50 border-gray-200';
        }
    };

    const formatDate = (timestamp) => {
        try {
            if (!timestamp) return 'Just now';

            let date;
            if (timestamp && typeof timestamp.toDate === 'function') {
                // Firestore Timestamp
                date = timestamp.toDate();
            } else if (timestamp && timestamp.seconds) {
                // Firestore Timestamp object with seconds
                date = new Date(timestamp.seconds * 1000);
            } else if (typeof timestamp === 'string' || typeof timestamp === 'number') {
                // String or number timestamp
                date = new Date(timestamp);
            } else {
                return 'Just now';
            }

            // Check if date is valid
            if (isNaN(date.getTime())) {
                return 'Just now';
            }

            const now = new Date();
            const diffMs = now - date;
            const diffMins = Math.floor(diffMs / 60000);
            const diffHours = Math.floor(diffMs / 3600000);
            const diffDays = Math.floor(diffMs / 86400000);

            if (diffMins < 1) return 'Just now';
            if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
            if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
            if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
            return date.toLocaleDateString();
        } catch (error) {
            console.warn('Error formatting date:', error);
            return 'Just now';
        }
    };

    return (
        <div>
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h2 className="text-2xl font-bold text-gray-900">Notifications</h2>
                    {unreadCount > 0 && (
                        <p className="text-sm text-gray-600 mt-1">
                            {unreadCount} unread notification{unreadCount > 1 ? 's' : ''}
                        </p>
                    )}
                </div>
                {unreadCount > 0 && (
                    <button
                        onClick={onMarkAllAsRead}
                        className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700"
                    >
                        Mark all as read
                    </button>
                )}
            </div>

            {!notifications || notifications.length === 0 ? (
                <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
                    <Bell className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                    <h3 className="text-xl font-semibold text-gray-900 mb-2">No notifications</h3>
                    <p className="text-gray-600">You'll see notifications about bookings, payments, and updates here</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {notifications.map((notification) => {
                        if (!notification) return null;
                        return (
                            <div
                                key={notification.id || Math.random()}
                                className={`bg-white rounded-xl border-2 p-5 transition-all cursor-pointer hover:shadow-md ${notification.read ? 'opacity-75' : getNotificationColor(notification.type || 'default')
                                    }`}
                                onClick={() => !notification.read && onMarkAsRead && onMarkAsRead(notification.id)}
                            >
                                <div className="flex items-start gap-4">
                                    <div className="flex-shrink-0 mt-0.5">
                                        {getNotificationIcon(notification.type || 'default')}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="flex-1">
                                                <h3 className="font-semibold text-gray-900 mb-1">
                                                    {notification.title || 'Notification'}
                                                </h3>
                                                <p className="text-gray-600 text-sm mb-2">
                                                    {notification.message || ''}
                                                </p>
                                                <p className="text-xs text-gray-500">
                                                    {formatDate(notification.createdAt)}
                                                </p>
                                            </div>
                                            {!notification.read && (
                                                <div className="flex-shrink-0">
                                                    <div className="w-2 h-2 bg-blue-600 rounded-full"></div>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ==================== PROVIDER DASHBOARD ====================
function ProviderDashboard({ currentUser, onBackToMarketplace, onLogout, showProfileDropdown, setShowProfileDropdown }) {
    const [activeTab, setActiveTab] = useState('bookings');
    const [loading, setLoading] = useState(true);
    const [bookings, setBookings] = useState([]);
    // providerData removed - using userData instead (unified structure)
    const [providerDocId, setProviderDocId] = useState(null); // Store provider document ID
    const [userData, setUserData] = useState(null);
    const [availablePackages, setAvailablePackages] = useState([]);
    const [selectedPackages, setSelectedPackages] = useState([]);
    const [selectedAddOns, setSelectedAddOns] = useState([]);
    const [packagePrices, setPackagePrices] = useState({}); // { "package-id": { price: X } }
    const [savingPackages, setSavingPackages] = useState(false);
    const [weeklySchedule, setWeeklySchedule] = useState({});
    const [blackoutDates, setBlackoutDates] = useState([]);
    const [selectedBlackoutDate, setSelectedBlackoutDate] = useState('');
    const [showBlackoutModal, setShowBlackoutModal] = useState(false);
    const [pendingProviders, setPendingProviders] = useState([]);
    const [rejectedProviders, setRejectedProviders] = useState([]);
    const [loadingPending, setLoadingPending] = useState(false);
    const [notifications, setNotifications] = useState([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [isEditingProfile, setIsEditingProfile] = useState(false);
    const [editedProviderProfile, setEditedProviderProfile] = useState({
        businessName: '',
        serviceArea: '',
        businessAddress: '',
        phone: '',
        email: ''
    });
    const [logoFile, setLogoFile] = useState(null);
    const [logoPreview, setLogoPreview] = useState(null);
    const [uploadingLogo, setUploadingLogo] = useState(false);
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
        if (userData?.role !== 'admin') return;

        setLoadingPending(true);
        try {
            // Query users collection for providers with pending status
            const pendingQuery = query(
                collection(db, 'detailer'),
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

    async function loadRejectedProviders() {
        if (userData?.role !== 'admin') return;

        try {
            // Query detailer collection for providers with rejected status
            const rejectedQuery = query(
                collection(db, 'detailer'),
                where('status', '==', 'rejected')
            );
            const snapshot = await getDocs(rejectedQuery);

            const rejected = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));

            setRejectedProviders(rejected);
        } catch (error) {
            console.error('Error loading rejected providers:', error);
        }
    }

    useEffect(() => {
        if (currentUser) {
            loadProviderData();
            // Initialize FCM and request notification permission
            initializeNotifications();
        }
    }, [currentUser]);

    // Initialize notifications
    async function initializeNotifications() {
        if (!currentUser) return;

        try {
            // Request notification permission and get token
            const token = await requestNotificationPermission();
            if (token) {
                await saveFCMToken(currentUser.uid, token);
            }

            // Set up foreground message handler
            setupForegroundMessageHandler();

            // Subscribe to notifications with error handling
            try {
                const unsubscribeNotifications = subscribeToNotifications(currentUser.uid, (notifs) => {
                    try {
                        setNotifications(Array.isArray(notifs) ? notifs : []);
                    } catch (error) {
                        console.error('Error setting notifications state:', error);
                        setNotifications([]);
                    }
                });

                // Subscribe to unread count with error handling
                const unsubscribeUnread = subscribeToUnreadCount(currentUser.uid, (count) => {
                    try {
                        setUnreadCount(typeof count === 'number' ? count : 0);
                    } catch (error) {
                        console.error('Error setting unread count state:', error);
                        setUnreadCount(0);
                    }
                });

                return () => {
                    try {
                        if (typeof unsubscribeNotifications === 'function') unsubscribeNotifications();
                        if (typeof unsubscribeUnread === 'function') unsubscribeUnread();
                    } catch (error) {
                        console.warn('Error unsubscribing from notifications:', error);
                    }
                };
            } catch (subscriptionError) {
                console.error('Error setting up notification subscriptions:', subscriptionError);
                // Set defaults to prevent white screen
                setNotifications([]);
                setUnreadCount(0);
            }
        } catch (error) {
            console.error('Error initializing notifications:', error);
            // Set defaults to prevent white screen
            setNotifications([]);
            setUnreadCount(0);
        }
    }

    // Add separate useEffect for admin check after userData loads:
    useEffect(() => {
        if (userData?.role === 'admin') {
            loadPendingProviders();
        }
    }, [userData]);

    // Reload pending and rejected providers when admin tab is activated
    useEffect(() => {
        if (activeTab === 'admin' && userData?.role === 'admin') {  // Change to userData
            loadPendingProviders();
            loadRejectedProviders();
        }
    }, [activeTab, userData]);  // Add userData to dependencies

    async function loadProviderData() {
        setLoading(true);
        try {
            // Read from detailer collection
            const detailerDoc = await getDoc(doc(db, 'detailer', currentUser.uid));

            if (!detailerDoc.exists()) {
                console.error('Detailer document not found');
                return;
            }

            const data = detailerDoc.data();
            setUserData({ id: detailerDoc.id, ...data });

            // Store document ID (same as UID now)
            setProviderDocId(detailerDoc.id);

            // Load provider-specific state from unified document
            setSelectedPackages(data.offeredPackages || []);
            setSelectedAddOns(data.addOns || []);
            setPackagePrices(data.packagePrices || {});

            // Initialize edited profile data
            setEditedProviderProfile({
                businessName: data.businessName || '',
                serviceArea: data.serviceArea || '',
                businessAddress: data.businessAddress || data.address || '',
                phone: data.phone || '',
                email: data.email || ''
            });

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

            // Load packages from Firestore
            const packagesQuery = collection(db, 'packages');
            const packagesSnapshot = await getDocs(packagesQuery);
            if (!packagesSnapshot.empty) {
                const packages = packagesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                setAvailablePackages(packages);
            } else {
                // Fallback to local packages
                setAvailablePackages(PACKAGES_DATA);
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
            // Debug: Log current user UID
            console.log('Current user UID:', auth.currentUser?.uid);

            // Unified structure: providerUserId is the same as currentUser.uid
            const providerUserId = currentUser.uid;
            const providerDocId = currentUser.uid; // Document ID is now the UID

            console.log('Loading bookings for provider:', providerUserId);

            // Query by providerUserId first (this is what new bookings use)
            let bookingsByUserId = { docs: [] };
            try {
                const bookingsQueryByUserId = query(
                    collection(db, 'bookings'),
                    where('providerUserId', '==', providerUserId)
                );
                bookingsByUserId = await getDocs(bookingsQueryByUserId);
                console.log(`Found ${bookingsByUserId.docs.length} bookings by providerUserId`);
            } catch (err) {
                console.error('Error querying by providerUserId:', err);
                console.error('Error details:', {
                    code: err.code,
                    message: err.message,
                    stack: err.stack
                });
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
                    console.log(`Found ${bookingsById.docs.length} bookings by providerId`);
                } catch (err) {
                    // Log error but don't fail completely
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

            console.log(`Total unique bookings found: ${allBookingDocs.length}`);

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

                    ustomer details
                    omerName = 'Unknown Customer';
                    omerEmail = '';
                        Phone = '';
                    ing.customerId) {
                        
                        et customer directly by UID (no query needed)
                    // Note: This may fail due to security rules - providers can't read customer docs
back
                    const customerDoc = await getDoc(doc(db, 'customer', booking.customerId));
                        customerDoc.exists()) {
                        const customerData = customerDoc.data();
                    ustomerName = customerData.firstName && customerData.lastName
                    ? `${customerData.firstName} ${customerData.lastName}`
                                    : customerData.displayName || customerData.email || 'Unknown';
                            customerEmail = customerData.email || '';
                                customerPhone = customerData.phone || '';
                            }
                    } catch (customerError) {
                        // Permission denied - use booking data instead
                                            console.warn('Could not read customer document (expected for providers):', customerError);
                        // Use customer email from booking if available
                       customerEmail = booking.customerEmail || '';
                        customerName = booking.customerEmail || 'Customer';
             }
                
                
            
            ingDoc.id,
        omerName,
                        customerEmail,
        omerPhone,
        ice: booking.services && booking.services.length > 0
        ? booking.services.map(s => s.name).join(', ')
        : booking.serviceName || 'Service',
        ices: booking.services || (booking.serviceName ? [{ name: booking.serviceName, price: booking.price }] : []),
    date: booking.date ? new Date(booking.date.seconds ? booking.date.seconds * 1000 : booking.date).toLocaleDateString() : 'TBD',
    time: booking.time || 'TBD',
                        price: booking.price || 0,
    address: booking.address || 'N/A',
    cleType: booking.vehicleType || 'Not specified',
    status: booking.status || 'pending',
    createdAt: booking.createdAt
    
    
        
        
    ate (upcoming first)
    .sort((a, b) => {
    te === 'TBD') return 1;
    te === 'TBD') return -1;
    ew Date(a.date) - new Date(b.date);
    
    
    bookingsList);
or) {
            console.error('Error loading bookings:', error);
            setBookings([]);
        }


    on handleUpdateBookingStatus(bookingId, newStatus) {
    
    t updateDoc(doc(db, 'bookings', bookingId), {
    status: newStatus,
                updatedAt: serverTimestamp()
});

    // Create notification if booking is cancelled
    if (newStatus === 'cancelled') {
        try {
                    const bookingDoc = await getDoc(doc(db, 'bookings', bookingId));
                    if (bookingDoc.exists()) {
                    const bookingData = { id: bookingId, ...bookingDoc.data() };
                    if (bookingData.providerUserId) {
                        await notifyBookingCancelled(bookingData.providerUserId, bookingData);
                    }
                }
            } catch (notifError) {
                    console.warn('Failed to create cancellation notification:', notifError);
            }
            }
            
            alert(`Booking ${newStatus} successfully`);
                Bookings();
                    or) {
                ole.error('Error updating booking:', error);
                    ailed to update booking');
                
            

            nction handleToggleService(serviceId) {  
    
    
        vices = services.map(service =>
            service.id === serviceId
                ? { ...service, active: !service.active }
                rvice
                
                
            ces(updatedServices);
        
            irestore
        const providerQuery = query(
ection(db, 'providers'),
            where('userId', '==',  currentUser.uid)
        
                            t providerSnapshot = await getDocs(providerQuery);
                    
                    !providerSnapshot.empty) {
                    await updateDoc(doc(db, 'providers', providerSnapshot.docs[0].id), {
                        services: updatedServices,
                        updatedAt: serverTimestamp()
                    });
    alert('Service status updated!');

tch (error) {
ole.error('Error updating service:', error);
                alert('Failed to update service');
            // Revert on error
                    ProviderData();
                                            
                                             
                
    async function handleSaveService(updatedService) {
                {
            // More robustmatching - check id, slug, or name as fallback
            datedServices = services.map(service => {
                 by id first, then slug, then name as fallback
                tches =
                    .id && updatedService.id && service.id === updatedService.id) ||
                    .slug && updatedService.slug && service.slug === updatedService.slug) ||
                        e && updatedService.name && service.name === updatedService.name);
                            
                        atches ? updatedService : service;
                                           
                                                    
we actually found and updated a service
                                t serviceFound = updatedServices.some((s, idx) => {
                    const original = services[idx];
                    return JSON.stringify (s) !== J SON.stringify(original);
                });
                
                if (!serviceFound) {
                    console.warn('Service not found for update:', updatedService);
                    alert('Service not found. Please try again.');
                    return;
                }

                setServices(updatedServices);
                setShowEditModal(false);
                setEditingService(null);
                
                    pdate in Firestore (detailer collection)
                    t updateDoc(doc(db, 'detailer', currentUser.uid), {
                        ices: updatedServices,
                        tedAt: serverTimestamp()
                        

                    eload provider data to ensure consistency
                await loadProviderData();
            alert('Service updated successfully!');
                tch (error) {
                console.error('Error saving service:', error);
                    t('Failed to save service: ' + (error.message || 'Unknown error'));
                    eload to revert any local changes
                loadProviderData();
        }
                
                    
                    dleEditService(service) {
                    ngService({ ...service });
                howEditModal(true);
    }
                
                nction handleSaveWeeklySchedule() {
                {
            // Update detailer collection
                await updateDoc(doc(db, 'detailer', currentUser.uid), {
                    defaultAvailability: weeklySchedule,
                    updatedAt: serverTimestamp()
                    
                alert('Weekly schedule saved successfully!');
        } catch (error) {
                console.error('Error saving schedule:', error);
                alert('Failed to save schedule');
                loadProviderData();
            }
                
                
                 handleDayScheduleChange(day, field, value) {
                eeklySchedule(prev => ({
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
                    
                    rn {
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
            
                
                nction handleAddBlackoutDate() {
                    ectedBlackoutDate) {
                    t('Please select a date');
                return;
            }
        
        if (blackoutDates.find(b => b.date === selectedBlackoutDate)) {
                alert('This date is already blocked out');
                return;
                
                
        try {
                const newBlackout = { date: selectedBlackoutDate, type: 'unavailable' };
                    t updatedBlackouts = [...blackoutDates, newBlackout];
                    lackoutDates(updatedBlackouts);
                        
                        e in Firestore
                        e detailer collection
                        tailerDoc = await getDoc(doc(db, 'detailer', currentUser.uid));
                        
                    detailerDoc.exists()) {
                    const detailerData = detailerDoc.data();
                    const dateOverrides = detailerData.dateOverrides || {};
        
                dateOverrides[selectedBlackoutDate] = { type: 'unavailable' };
        
                    await updateDoc(doc(db, 'detailer', currentUser.uid), {
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
                
                nction handleRemoveBlackoutDate(dateToRemove) {
                !confirm('Are you sure you want to remove this blackout date?')) return;

                {
                    t updatedBlackouts = blackoutDates.filter(b => b.date !== dateToRemove);
                    lackoutDates(updatedBlackouts);

                    pdate in Firestore (detailer collection)
            const detailerDoc = await getDoc(doc(db, 'detailer', currentUser.uid));
                    
                        ilerDoc.exists()) {
                        t detailerData = detailerDoc.data();
                    const dateOverrides = detailerData.dateOverrides || {};

                    delete dateOverrides[dateToRemove];
                    
                    await updateDoc(doc(db, 'detailer', currentUser.uid), {
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
            
                
                nction handleApproveProvider(providerId) {
        if (!confirm('Approve this provider? They will be able to accept bookings.')) return;
                
                {
            // Get the detailer document
                const detailerDoc = await getDoc(doc(db, 'detailer', providerId));
                    
                    !detailerDoc.exists()) {
                alert('Error: Provider document not found!');
                    return;
            }
                    
                        tailerData = detailerDoc.data();
                        
                    repare update data
            const updateData = {
                    status: 'approved',
                    approvedAt: serverTimestamp(),
                    updatedAt: serverTimestamp()
                };
                
                // If provider doesn't have packages, initialize with all packages
                if (!detailerData.offeredPackages || detailerData.offeredPackages.length === 0) {
                    updateData.offeredPackages = PACKAGES_DATA.map(pkg => pkg.id);
            }
        
                // Perform the update (detailer collection)
            await updateDoc(doc(db, 'detailer', providerId), updateData);
            
                // Verify the update succeeded by reading the document again
                const verifyDoc = await getDoc(doc(db, 'detailer', providerId));
            const verifyData = verifyDoc.data();
                
                    verifyData.status !== 'approved') {
                    throw new Error('Update verification failed: status is still not approved');
                }

                alert('Provider approved successfully!');
            // Reload pending providers list
                await loadPendingProviders();
                tch (error) {
                    ole.error('Error approving provider:', error);
                    t(`Failed to approve provider: ${error.message || 'Unknown error'}`);
                    
                

                nction handleRejectProvider(providerId) {
                t reason = prompt('Reason for rejection (optional):');
                    on === null) return; // User cancelled
                
        try {
                // Update detailer collection
                await updateDoc(doc(db, 'detailer', providerId), {
                status: 'rejected',
                    rejectionReason: reason || '',
                    rejectedAt: serverTimestamp(),
                    updatedAt: serverTimestamp()
            });
                alert('Provider rejected.');
                    PendingProviders();
                loadRejectedProviders(); // Also reload rejected providers list
        } catch (error) {
                console.error('Error rejecting provider:', error);
                alert('Failed to reject provider');
                
            
                
                nction handleDeleteProvider(providerId) {
            if (!confirm('Are you sure you want to permanently delete this provider account? This action cannot be undone.')) {
                return;
        }
        
            try {
                // Delete the detailer document
            await deleteDoc(doc(db, 'detailer', providerId));
                alert('Provider account deleted successfully.');
                loadPendingProviders();
                loadRejectedProviders(); // Reload rejected providers list
                    (error) {

n error'}`);

                        
                
                            
                {
                // Query users collection for providers (unified structure)
                const providersQuery = query(
                                
                                    
                                        
                                            
                const providersList = providersSnapshot.docs.map(doc => {
                            
                            
                            
                            
                                
                                                    email: data.email,
                                                    businessName: data.businessName || data.name || 'N/A',
                                                    status: data.status,
                                                    hasPackages: (data.offeredPackages || []).length > 0,
                                                    packageCount: (data.offeredPackages || []).length,
                                        
                    };
                });
                
                // Log to console
                console.table(providersList);

                                                
                                            
                                            }\n   Status: ${p.status}\n   Packages: ${p.packageCount}\n   UserId: ${p.userId}\n   DocId: ${p.id}`
                ).join('\n\n');
                                                
                alert(`Found  ${providersList.length} provide r (s):\n\n${details}\n\nCheck console for table view.`);
                tch (error) {
            console.error('Error listing providers:', error);
                alert(`Error: ${error.message}`);
                    
                    
                        
                        election for logo upload
                        ileSelect(e) {
                         e.target.files[0];
                        
                        ate  file type  
                        e.type.startsWith('image/')) {
                        t('Please select an image file');
                    return;
                }

                // Validate file size (max 5MB)
                if (file.size > 5 * 1024 * 1024) {
                alert('Image size must be less than 5MB');
                    return;      
                }
                    
                setLogoFile(file);

                // Create preview
                                                    const reader = new FileReader();
                reader.onloadend = () => {
                    setLogoPreview(reader.result);
                };
                                                                      
        }
        }
              
            andle logo upload
            c function handleLogoUpload() {
                !logoFile) return;   
                
                    
                    ploadingLogo(true);
                
            // Create storage reference
                const storageRef = ref(storage, `provider-logos/${currentUser.uid}/${Date.now()}_${logoFile.name}`);
                
                    pload file
                    t uploadBytes(storageRef, logoFile);
                
            // Get download URL
                const downloadURL = await getDownloadURL(storageRef);

                // Update detailer collection
                await updateDoc(doc(db, 'detailer', currentUser.uid), {
                    image: downloadURL,
                    updatedAt: serverTimestamp()
                });
                
                alert('Logo uploaded successfully!');
                setLogoFile(null);
            setLogoPreview(null);
                await loadProviderData();
            } catch (error) {
                console.error('Error uploading logo:', error);
            alert(`Failed to upload logo: ${error.message}`);
            } finally {
                setUploadingLogo(false);
        }
                
                
    // --- EARLY RETURN FIX ---
                ading or userData doesn't exist yet, show loading message
                TOP the function here to prevent accessing undefined properties
    if (loading || !userData) {
                rn (      


                                                00 mx-auto"></div>

                                                
                                                

                                                
                                                
                                                    
                                                        
(b.status));

                                                    


                                                    
0/90 via-blue-700/90 to-indigo-600/90 border-b border-blue-400/20 shadow-lg">
                                                     
                                                            <div className="fl ex items-center justify-between">
                            <div>
                                <h1 className="text-3xl font-bold text-white drop-shadow-md">
                                    Provider Dashboard
                                </h1>
                                {userData && (
                                    <p className="text-blue-100 mt-1 drop-shadow-sm">
                                        {userData.businessName || userData.name || 'Your Business'}
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
                            
                                
                                    
                                
                                bg-white border-b border-gray-200">
                                    max-w-6xl mx-auto px-4">
                                        flex gap-8">
                                    
                                onClick={() => setActiveTab('bookings')}
                                className={`py-4 border-b-2 font-semibold transition-colors ${activeTab === 'bookings'
                                    ? 'border-blue-600 text-blue-600'
                                    : 'border-transparent text-gray-600 hover:text-gray-900'
                                    }`}
                                    
                                Bookings ({upcomingBookings.length})
                                    >
                                ton
                                onClick={() => setActiveTab('history')}
                                    sName={`py-4 border-b-2 font-semibold transition-colors ${activeTab === 'history'
                                    ? 'border-blue-600 text-blue-600'
                                    : 'border-transparent text-gray-600 hover:text-gray-900'
                                    }`}
                                
                                History ({completedBookings.length})
                            </button>
                            <button
                                onClick={() => setActiveTab('packages')}
                            className={`py-4 border-b-2 font-semibold transition-colors ${activeTab === 'packages'
                                    ? 'border-blue-600 text-blue-600'
                                    : 'border-transparent text-gray-600 hover:text-gray-900'
                                    }`}
                            >
                                Packages
                                tton>
                                ton
                                    ick={() => setActiveTab('availability')}
                                    sName={`py-4 border-b-2 font-semibold transition-colors ${activeTab === 'availability'
                                    ? 'border-blue-600 text-blue-600'
                                    : 'border-transparent text-gray-600 hover:text-gray-900'
                                    }`}
                            >
                                Availability
                                tton>
                                ton
                                    ick={() => setActiveTab('profile')}
                                    sName={`py-4 border-b-2 font-semibold transition-colors ${activeTab === 'profile'
                                    ? 'border-blue-600 text-blue-600'
                                    : 'border-transparent text-gray-600 hover:text-gray-900'
                                    }`}
                            >
                                Profile
                                tton>
                                ton
                                    ick={() => setActiveTab('notifications')}
                                    sName={`py-4 border-b-2 font-semibold transition-colors relative ${activeTab === 'notifications'
                                    ? 'border-blue-600 text-blue-600'
                                    : 'border-transparent text-gray-600 hover:text-gray-900'
                                    }`}
                            >
                                Notifications
                                {unreadCount > 0 && (
                                    <span className="absolute top-2 right-0 bg-red-500 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
                                        {unreadCount > 9 ? '9+' : unreadCount}
                                    </span>
                                    
                            </button>
                                rData?.role === 'admin' && (  // Change to userData
                                <button
                                    onClick={() => setActiveTab('admin')}
                                    className={`py-4 border-b-2 font-semibold transition-colors ${activeTab === 'admin'
                                        ? 'border-blue-600 text-blue-600'
                                        : 'border-transparent text-gray-600 hover:text-gray-900'
                                        }`}
                                    
                                    Admin {pendingProviders.length > 0 && `(${pendingProviders.length})`}
                                </button>
                            )}
                            v>
                                
                                
                                    
                                    
                                    w-6xl mx-auto px-4 py-8">
                            ab === 'bookings' && (
                                
                                 className="flex items-center justify-between mb-6">
                                    className="text-2xl font-bold text-gray-900">Upcoming Bookings</h2>
                                        
                                    onClick={loadBookings}
                                    className="px-4 py-2 text-sm border-2 border-gray-200 rounded-lg font-medium hover:bg-gray-50"
                                >
                                    Refresh
                                </button>
                                    
                                    gBookings.length === 0 ? (
                                        ssName="bg-white rounded-xl border border-gray-200 p-12 text-center">
                                        endar className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                                        className="text-xl font-semibold text-gray-900 mb-2">No upcoming bookings</h3>
                                    <p className="text-gray-600">New bookings will appear here</p>
                                    v>
                                (
                                <div className="space-y-4">
                                    {upcomingBookings.map((booking) => (
                                        <div key={booking.id} className="bg-white rounded-xl border border-gray-200 p-6">
                                            <div className="flex justify-between items-start mb-4">
                                            <div className="flex-1">
                                                    <h3 className="text-xl font-bold text-gray-900 mb-2">
                                                        


                                                                    




t-blue-600">
                                                            
                                                          
                                                            </div>      
                                                    
                                                         {booking.customerPhone && (
0">

r:text-blue-600">
                                                                
                                                                </a>    

                                                            
                                                    </div >   
                                                        
                                                            
                                                    {/* Package/Service & Vehicle */}
                                                    <div className="mb-4">
                                                        {booking.packageName ? (
                                                                            <div className="space-y-2 mb-2">
                                                                            <div className="flex items-center justify-between">
                                                                                    <p className="text-lg font-semibold text-gray-900">{booking.packageName}</p>
                                                                                    {booking.packagePrice && (
                                                                                    <span className="text-sm font-medium text-gray-600">
                                                                            ${booking.packagePrice}
                                                                                        </span>
                                                                                    )}
                                                                        
                                                                            
                                                                                    <div className="ml-4 space-y-1">
                                                                                        {booking.addOns.map((addOn, idx) => (
                                                                            <div key={idx} className="flex items-center justify-between text-sm">
                                                                                 <span className="text-gray-600">+ {addOn.name}</span>
                                                                                                   {a ddOn.price && (
                                                                                    <span className="text-gray-600">${addOn.price}</span>
                                                                                )}
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                )}
                                                        </div>
                                                        ) : booking.services && booking.services.length > 0 ? (
                                                            <div className="space-y-2 mb-2">
                                                                {booking.services.map((service, idx) => (
                                                                    <div key={idx} className="flex items-center justify-between">
                                                                        <p className="text-lg font-semibold text-gray-900">{service.name}</p>
                                                                        {service.price && (
                                                                    
                                                                         text-gray-600">${service.price}</span>
                                                                            
                                                                                
                                                                                    
                                                                                    
                                                                                                                                    
                                                                                                                                    lassName="text-lg font-semibold text-gray-900 mb-2">{booking.service || booking.serviceName || 'Service'}</p>
                                                                                                                                    
                                                                                                                                        flex items-center gap-2 text-sm text-gray-600">
                                                                        
                                                                                 t-medium">Vehicle:</span> 
                                                                                leType || 'Not specified' }</span>
                                                                    
                                                                       
                                                                     
                                                                                                                                                   
                                                                            
                                                                                
                                                                                
                                                                                    
                                                                                
                                                                            
                                                                        y-
                                                                    600">
                                                                    lassName="w-4 h-4" /> 
                                                                ime}</span>
                                                                                                                                            
                                                                             items-start gap-2 text-gray-600">
                                                                        sName="w-4 h-4 mt-0.5 flex-shr i nk-0" /> 
                                                                                                                                   assName="font-medium">{booking.address}</span>
                                                                
                                                            
                                                         
                                                             

                                                                
                                                       
                                                        
                                                            xt-sm font-medium ${booking.status === 'confirmed'
                                                                    ? 'bg-green-100 text-green-800'
                                                                
                                                        ? 'bg-yellow-100 text-yellow-800'
                                                            : 'bg-blue-100 text-blue-800'
                                                        }`}>
                                                        {booking.status.charAt(0).toUpperCase() + booking.status.slice(1)}
                                                            
                                                            
                                                        
                                                        
                                                          
                                               === 'pending' && (
                                                    m e ="flex gap-3 pt-4 border-t border-gray-100">
                                                        ton
                                                                                                       onClick={() => handleUpdateBookingStatus(booking.id, 'confirmed')}
                                                                                                             sName="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700"
                                                                                                              
                                                         Accept
                                                 
                                                    
                                                    
                                                        o reject this booking?')) {
                                                                                                    handleUpdateBookingStatus(booking.id, 'cancelled');
                                                                                                }
                                                                                        }}
                                                                                            className="flex-1 px-4 py-2 bg-red-50 text-red-600 rounded-lg font-semibold hover:bg-red-100"
                                                                                        
                                                                                        Reject
                                                            
                                                                                

                                                                
                                                    .status === 'confirmed' && (
                                                                                                                <div className="flex gap-3 pt-4 border-t border-gray-100">
                                                                    
                                                                        king.id, 'completed')}
                                                                            -white rounded-lg font-semibold hover:bg-blue-700"


                                                                                                 
                                                        ton
                                                        onClick={() => {
                                                            if (confirm('Are you sure you want to cancel this booking?')) {
                                                                handleUpdateBookingStatus(booking.id, 'cancelled');
                                                            }
                                                        }}
                                                            sName="flex-1 px-4 py-2 bg-red-50 text-red-600 rounded-lg font-semibold hover:bg-red-100"
                                                                                      

                                                                              
                                                                
                                                    
                                                                
                                                    

                                                                
                                                                    
                                                                    


                                                                
                                                        -bold text-gray-900 mb-6">Booking History</h2>
                                                    h === 0 ? (
                                                         rounded-xl border border-gray-200 p-12 text-center">
                                                    xt-gray-600">No completed bookings yet</p>
                                                    
                                                        
                                                            
                                                                ing) => (
                                                                            } className="bg-white rounded-xl border border-gray-200 p-6">
                                                        me="flex justify-between items-start">
                                                                    ssName="flex-1">
                                                                    className="text-lg font-semibold text-gray-900 mb-2">


                                                                            
                                                    {/* Contact Information */}          

                                                        <div className="flex flex-wrap gap-4 mb-3 text-sm">

                                                                        mter  g ap-2 text-gray-600">
                                                                    <Mail className="w-4 h-4" />
                                                                                            <span>{booking.customerEmail}</span>
                                                            </div>
                                                                        )}
                                                                    rPhone && (
                                                                <div className="flex items-center gap-2 text-gray-600">
                                                                    <Phone className="w-4 h-4" />
                                                                    <span>{booking.customerPhone}</span>
                                                                                                                                </div>
                                                            )}
                                                                                                                        </div>
                                                                
                                                                    
                                                                    
                                                                                                                    <div className="mb-2">
                                                            xt-gray-600 mb-1 font-semibold">{booking.packageName}</p>
                                                                        {booking.packagePrice && (
                                                                <p className="text-gray-500 text-sm mb-1">
                                                                                                                            ${booking.packagePrice}
                                                            
                                                        
                                                                    {booking.addOns && booking.addOns.length > 0 && (
                                                                 <div className="ml-2 mt-1">
                                  
                                                                          {booking.addOns.map((addOn, idx) => (
                                                                         <p key={idx} className="text-gray-500 text-sm">
                         
                                                                                       + {addOn.name} {addOn.price ? `($${addOn.price})` : ''}
                                                                         </p>
                 
                                                                                   ))}
                                                                </div>
                                 
                                                                               )}
                                                                                    
                                                                ices && booking.services.length > 0 ? (
                                                                                                                me="mb-2">
                                                map( rvice, id)=> (
                                                    ext-gray-600 mb-1">
                                                    price ? `- $${service.price}` : ''}
                                                                                                    </p>
                                                                                                ))}
                                                        </div>
                                                                                                (
                                            ray-600 mb-1">{booking.service || booking.serviceName || 'Service'}</p>
                                                            
                                                                ="text-sm text-gray-500 mb-2">
                                            "font-medium">Vehicle:</span> {booking.vehicleType || 'Not specified'}
                                                
                                                    t-sm text-gray-500 mt-2">
                                                .time}</span>
                                            address !== 'N/A' && (
                                        x items-center gap-1">
                                    sName="w-3 h-3" />
                                                                                        ress}
                                    
                                
                                                                    
                                                                
                                                            
                                                        ssName="text-right ml-6">
                                                    <p className="text-xl font-bold text-gray-900">
                                                        ${booking.price.toFixed(2)}
                                                            
                                                                ame={`inline-block mt-2 px-3 py-1 rounded-full text-sm ${booking.status === 'completed'
                                                                    100 text-green-800'
                                                                ay-100 text-gray-800'
                                                            
                                                        {booking.status.charAt(0).toUpperCase() + booking.status.slice(1)}
                                                    </span> 
                                                                                        
                                        
                                            
                                                                                        
                                        
                                            
                                            
                                                                                            
                                            
                                        
                                    
n mb-6">

                                                    ext-2xl font-bold text-gray-900">Manage Packages</h2>
mt-1">
o offer to customers
                                                    




                                      
                                
                                
                                    
                                        
                                        entUser: currentUser?.uid,
                                            
                                        
                                    
                                    
                                        
                                        

                                        
                                            
                                                 
                                        try {


User.uid) {
 You must be logged in to save changes.';
                                            ;
                                    
                                                alert(errorMsg);
                                        se);   
                                                return;
                                            }
                                        
                                            // Unified structure: document ID is the UID
                                        const docIdToUpdate = currentUser.uid;
                                        
                                            // Verify document exists
                                            const detailerDocRef = doc(db, 'detailer', currentUser.uid);
                                            const detailerDocSnap = await getDoc(detailerDocRef);
                                            
                                            if (!detailerDocSnap.exists()) {
                                                console.error('⚠️ Detailer document not found!');
                                            alert('Error: Your detailer account was not found. Please contact support.');
                                                return;
                                            }
                                        
                                        // Ensure packagePrices is always an object
                                            const safePackagePrices = packagePrices || {};
                                            
                                        // Update detailer collection
                                            await updateDoc(detailerDocRef, {
                                                offeredPackages: selectedPackages,
                                                addOns: selectedAddOns,
                                                packagePrices: safePackagePrices,
                                                updatedAt: serverTimestamp()
                                                
                                            
                                        alert('Packages saved successfully!');
                                            
                                            // Reload provider data to reflect changes
                                        await loadProviderData();
                                            tch (error) {
                                            console.error('❌ Error saving packages:', error);
                                            console.error('Error details:', {
                                            message: error.message,
                                                code: error.code,
                                                stack: error.stack
                                                
                                                t(`Failed to save packages: ${error.message || 'Unknown error'}`);
                                            nally {
                                        setSavingPackages(false);
                                            console.log('🏁 Save process complete');
                                            
                                }}
                                            ={savingPackages}
                                            e="px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center gap-2 cursor-pointer"
                                                nterEvents: savingPackages ? 'none' : 'auto' }}
                                                
                                                ges ? ( 
                                                
                                            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                                        Saving...                     

                                     
                                     
                                        
                                                 
                                              
                                             


ay-900 mb-4">Available Packages</h3>

er border-gray-200 p-12 text-center">
                                                t-gray-300 mx-auto mb-4" />   
                                                    semibold text-gray-900 mb-2">No packages available</h3>
                                                        kages will appear here once they're added to the system.</p>
                                                            
                                                                
                                                                
                                        {availablePackages.map((pkg) => {
                                            const isSelected = selectedPackages.includes(pkg.id);
                                            return (
                                                <div
                                                    key={pkg.id}
                                                    className={`bg-white rounded-xl border-2 p-6 transition-all ${isSelected ? 'border-blue-600 bg-blue-50' : 'border-gray-200'
                                                        }`}
                                                >
                                                                flex items-start justify-between">
                                                                me="flex-1">
                                                                me="flex items-center gap-3 mb-2">
                                                                e="text-lg font-semibold text-gray-900">{pkg.name}</h3>
                                                                {isSelected && (
                                                                    "px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                                                                        Offered
                                                                    </span>
                                                                )}
                                                                
                                                                m text-gray-600 mb-3">{pkg.description}</p>
                                                            <div className="flex flex-wrap items-center justify-between gap-4 text-sm mb-3 p-3 bg-gray-50 rounded-lg">
                                                                <div className="flex items-center gap-4">
                                                                    ssName="flex items-center gap-2">
                                                                        <DollarSign className="w-4 h-4 text-gray-600" />
                                                                       <span className={`font-bold text-lg ${isSelected && packagePrices[pkg.id] ? 'text-blue-600' : 'text-gray-900'}`}>
                                                                    gePrices[pkg.id]?.price ?? pkg.price}
                                                                        </span >  
                                                                lected && packagePrices[pkg.id] && (
                                                            "px-2 py-1 rounded-full text-xs bg-blue-100 text-blue-700 font-medium">Custom</span>
                                                           )}
                                                    
                                                                </div> 
                                 

                                 
                                    e prices if not set 
es[pkg.id]) {
                                        (prev => ({
                                
                                 
                                e: pkg.price
                                    
                                    
                                    
                                        
                                        -600 text-white rounded-lg font-semibold hover:bg-blue-700 flex items-center gap-2 text-sm"
                                        
                                    Edit2 className="w-4 h-4" />
                                                                                        {packagePrices[pkg.id] ? 'Edit Prices' : 'Set Custom Prices'}
                                                                                            tton>
                                                                                                    
                             
                                                                                           
                                                                                          
                                                                                                    g section - only show if package is selected */}
                                                                                            && packagePrices[pkg.id] && (
                                                                      className="mb-3 p-4 bg-blue-50 rounded-lg border-2 border-blue-300">
                                                                                                 <div className="flex items-center justify-between mb-3">
                                                                        <label className="block text-sm font-semibold text-gray-900">
                            lassName="w-4 h-4 inline mr-1" />
                                                    Custom Pricing
                                                    bel>
                                                                            ton
                             
                                                                       ick={() => {
                                          
                              ackagePrices(prev => {
                                            const updated = { ...prev };
                                                te updated[pkg.id];
                                                                                    return updated;
                                                                                });
                                                                            }}
                                                                            className="text-xs text-red-600 hover:text-red-700 font-medium flex items-center gap-1 px-2 py-1 hover:bg-red-50 rounded"
                                                                        >
                                                                            <X className="w-3 h-3" />
                                                                            Reset to Default
                                                                        </button>
                                                                    </div>
                                                                    <p className="text-xs text-gray-600 mb-3">Set your price for this package</p>
                                                                    <div>
                                                                    <label className="block text-xs font-medium text-gray-700 mb-1">Price ($)</label>
                                                                        <input
                                                                            type="number"
                                                                            min="0"
                                                                            step="1"
                                                                            value={packagePrices[pkg.id]?.price ?? pkg.price}
                                                                            onChange={(e) => {
                                                                                const value = parseInt(e.target.value) || pkg.price;
                                                                                setPackagePrices(prev => ({
                                                                                    ...prev,
                                                                                    [pkg.id]: {
                                                                                        price: value
                                                                                    }
                                                                                    
                                                                                    
                                                                                sName="w-full px-3 py-2 text-sm border-2 border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white font-medium"
                                                                            placeholder={pkg.price?.toString() || '0'}
                                                                            
                                                                        v>
                                                                            ssName="mt-3 pt-3 border-t border-blue-200">
                                                                             className="flex items-center gap-2 text-sm">
                                                                            <DollarSign className="w-4 h-4 text-blue-600" />
                                                                            <span className="font-bold text-blue-700">
                                                                                Your Price: ${packagePrices[pkg.id]?.price ?? pkg.price}
                                                                            </span>
                                                                        </div>
                                                                        v>
                                                                            
                                                                            
                                                                            grid grid-cols-1 md:grid-cols-2 gap-3 mt-3 pt-3 border-t border-gray-200">
                                                                            
                                                                            ssName="text-xs font-semibold text-gray-700 mb-1">Exterior Services:</div>
                                                                                e="text-xs text-gray-600 space-y-1">
                                                                                eriorServices.map((svc, idx) => (
                                                                                    {idx} className="flex items-start">
                                                                                    ckCircle2 className="w-3 h-3 text-green-500 mr-1 mt-0.5 flex-shrink-0" />
                                                                                        vc}</span>
                                                                                    
                                                                                
                                                                            
                                                                            
                                                                            
                                                                         className="text-xs font-semibold text-gray-700 mb-1">Interior Services:</div>
                                                                    <ul className="text-xs text-gray-600 space-y-1">
                                                                        {pkg.interiorServices.map((svc, idx) => (
                                                                            <li key={idx} className="flex items-start">
                                                                                <CheckCircle2 className="w-3 h-3 text-green-500 mr-1 mt-0.5 flex-shrink-0" />
                                                                                <span>{svc}</span>
                                                                                >
                                                                            
                                                                        >
                                                                    v>
                                                                v>
                                                            v>
                                                             className="ml-4">
                                                                el className="relative inline-flex items-center cursor-pointer">
                                                                    ut
                                                                    type="checkbox"
                                                                        ked={isSelected}
                                                                            ={() => {
                                                                                lected) {
                                                                                emove package and its custom prices
                                                                            setSelectedPackages(prev => prev.filter(id => id !== pkg.id));
                                                                            setPackagePrices(prev => {
                                                                                const updated = { ...prev };
                                                                                delete updated[pkg.id];
                                                                                return updated;
                                                                            });
                                                                        } else {
                                                                            setSelectedPackages(prev => [...prev, pkg.id]);
                                                                            
                                                                                
                                                                                r-only peer"
                                                                            
                                                                        ssName="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                                                                    
                                                                
                                                            
                                                        
                                                        
                                                            
                                                                
                                                                    
                                                                    
                                                                    
                                                                        
                                                                            
                                                                            ay-900 mb-4">Available Add-ons</h3>
                                                                            lect which add-ons you want to offer with your packages</p>
                                                                                
                                                                                
                                                                                es(addOn.id);
                                                                            
                                                                        
                                                                            
                                                                        nded-xl border-2 p-4 transition-all ${isSelected ? 'border-blue-600 bg-blue-50' : 'border-gray-200'
                                                                    
                                                                    
                                                                flex items-center justify-between">
                                                                me="flex-1">
                                                             className="flex items-center gap-3 mb-1">
                                                            <h4 className="font-semibold text-gray-900">{addOn.name}</h4>
                                                            <span className="text-sm font-medium text-gray-600">+${addOn.price}</span>
                                                        </div>
                                                        <p className="text-sm text-gray-600">{addOn.description}</p>
                                                    </div>
                                                    <div className="ml-4">
                                                        <label className="relative inline-flex items-center cursor-pointer">
                                                            <input
                                                            type="checkbox"
                                                                checked={isSelected}
                                                                onChange={() => {
                                                                    if (isSelected) {
                                                                        setSelectedAddOns(prev => prev.filter(id => id !== addOn.id));
                                                                    } else {
                                                                        setSelectedAddOns(prev => [...prev, addOn.id]);
                                                                    }
                                                                }}
                                                                className="sr-only peer"
                                                            />
                                                            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                                                        </label>
                                                    </div>
                                                </div>
                                                    
                                                        
                                                            
                                                            
                                                        
                                                        
                                                    
                                                    
                                                        
                                                            
                                                                xt-gray-900 mb-6">Manage Availability</h2>
                                                                
                                                                
                                                                    er border-gray-200 p-6 mb-6">
                                                                        y-between mb-4">
                                                                    bold text-gray-900">Weekly Schedule</h3>
                                                                        
                                                                    edule}
                                                                blue-600 text-white rounded-lg font-semibold hover:bg-blue-700"
                                                                
                                                            
                                                            
                                                        
                                                    m text-gray-500 mb-4">
                                                ault working hours for each day of the week. This schedule will remain constant until you change it.
                                            
                                        
                                     className="space-y-3">
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
                                                    (
                                                    <span className="text-sm text-gray-400 italic">Not available</span>
                                            )}
                                                v>
                                                    
                                                        
                                                            
                                                            
                                                                
                                                                
                                                                border border-gray-200 p-6">
                                                                r justify-between mb-4">
                                                            ont-semibold text-gray-900">Blackout Dates</h3>
                                                        
                                                        etShowBlackoutModal(true)}
                                                        py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700 flex items-center gap-2"
                                                            
                                                             h-4" />
                                                                
                                                                
                                                                
                                                                500 mb-4">
                                                            're unavailable (holidays, emergencies, etc.). No bookings will be available on these dates.
                                                        
                                                    
                                                ength === 0 ? (
                                                    text-center py-8 text-gray-500">
                                                r className="w-12 h-12 mx-auto mb-2 text-gray-300" />
                                            o blackout dates set</p>
                                        v>
                                    (
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
                                        
                                            
                                            
                                                e Modal */}
                                                & (
                                                fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                                                me="bg-white rounded-xl max-w-md w-full">
                                             className="p-6 border-b border-gray-200">
                                        <div className="flex items-center justify-between">
                                                <h3 className="text-xl font-bold text-gray-900">Add Blackout Date</h3>
                                                <button
                                                    onClick={() => {
                                                        setShowBlackoutModal(false);
                                                        setSelectedBlackoutDate('');
                                                    }}
                                                    className="text-gray-400 hover:text-gray-600"
                                                        
                                                        lassName="w-6 h-6" />
                                                    tton>
                                                        
                                                    
                                                
                                             className="p-6 space-y-4">
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
                                                v>
                                                lassName="text-sm text-gray-500">
                                                     date will be blocked out and no bookings will be available.
                                                        
                                                        
                                                    
                                                    me="p-6 border-t border-gray-200 flex gap-3">
                                                ton
                                                    ick={handleAddBlackoutDate}
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
                                                    
                                                    el
                                                    >
                                                    
                                                    
                                                
                                            
                                            
                                                
                                            
                                        n' && userData?.role === 'admin' && (  // Change to userData
                    <div>
                                        me="flex items-center justify-between mb-6">
                                            e="text-2xl font-bold text-gray-900">Admin Panel</h2>
                                                flex gap-2">
                                                
                                            ick={async () => {
                                                confirm('This will import all packages to Firestore. Continue?')) {
                                                try {
                                                    await importPackagesToFirestore();
                                                } catch (error) {
                                                    console.error('Import error:', error);
                                                    
                                                
                                                
                                            sName="px-4 py-2 text-sm bg-green-600 text-white rounded-lg font-medium hover:bg-green-700"
                                                
                                            rt Packages
                                        tton>
                                    <button
                                        onClick={listAllProviders}
                                        className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700"
                                    >
                                        List All Providers
                                </button>
                                    <button
                                        onClick={loadPendingProviders}
                                        className="px-4 py-2 text-sm border-2 border-gray-200 rounded-lg font-medium hover:bg-gray-50"
                                    >
                                        Refresh
                                    </button>
                                        
                                            
                                                
                                                    
                                                ext-lg font-semibold text-gray-900 mb-4">Provider Approvals</h3>
                                                    
                                                ? (
                                            ssName="text-center py-8">
                                        <p className="text-gray-600">Loading pending applications...</p>
                                        v>
                                    pendingProviders.length === 0 ? (
                                         className="bg-white rounded-xl border border-gray-200 p-12 text-center">
                                        <CheckCircle2 className="w-16 h-16 text-green-300 mx-auto mb-4" />
                                        <h3 className="text-xl font-semibold text-gray-900 mb-2">No pending applications</h3>
                                        <p className="text-gray-600">All provider applications have been reviewed.</p>
                                        v>
                                    (
                                         className="space-y-4">
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
                                                                
                                                                
                                                            assName="px-3 py-1 bg-yellow-100 text-yellow-800 rounded-full text-sm font-medium">
                                                            ing
                                                                
                                                                
                                                            
                                                             Details */}
                                                                grid grid-cols-2 gap-4 mb-4 p-4 bg-gray-50 rounded-lg">
                                                                    
                                                                    Name="text-xs font-medium text-gray-500">Business License</label>
                                                                Name="text-sm font-semibold text-gray-900">{provider.businessLicenseNumber || 'N/A'}</p>
                                                            
                                                            r.ein && (
                                                                
                                                                    lassName="text-xs font-medium text-gray-500">EIN</label>
                                                                    Name="text-sm font-semibold text-gray-900">{provider.ein}</p>
                                                                
                                                            
                                                            
                                                                lassName="text-xs font-medium text-gray-500">Insurance Provider</label>
                                                                    ="text-sm font-semibold text-gray-900">{provider.insuranceProvider || 'N/A'}</p>
                                                                    
                                                                
                                                            el className="text-xs font-medium text-gray-500">Insurance Number</label>
                                                        <p className="text-sm font-semibold text-gray-900">{provider.insuranceNumber || 'N/A'}</p>
                                                    </div>
                                                    v>
                                                        
                                                    vider.about && (
                                                    <div className="mb-4">
                                                    <label className="text-xs font-medium text-gray-500">About</label>
                                                        <p className="text-sm text-gray-700 mt-1">{provider.about}</p>
                                                    </div>
                                                    
                                                        
                                                        on Buttons */}
                                                     className="flex gap-3 pt-4 border-t border-gray-200">
                                                    <button
                                                        onClick={() => handleApproveProvider(provider.id)}
                                                            sName="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700"
                                                            
                                                        Approve
                                                    </button>
                                                    <button
                                                        onClick={() => handleRejectProvider(provider.id)}
                                                        className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700"
                                                    >
                                                        Reject
                                                        tton>
                                                        
                                                    
                                                
                                </div>
                                                
                                                    
                                                        
                                                        on */}
                                                    
                                                flex items-center justify-between mb-4">
                                <h3 className="text-lg font-bold text-gray-900">Rejected Providers</h3>
                                                
                                                {loadRejectedProviders}
                                                    x-4 py-2 text-sm border-2 border-gray-200 rounded-lg font-semibold hover:bg-gray-50"
                                                        
                                                        
                                                    
                                                        
                                                    ength === 0 ? (
                                                    bg-white rounded-xl border border-gray-200 p-8 text-center">
                                                        xt-gray-600">No rejected providers.</p>
                                                        
                                                    
                                                        e-y-4">
                                                    viders.map((provider) => (
                                                 key={provider.id} className="bg-white rounded-xl border-2 border-red-200 p-6">
                                                <div className="flex items-start justify-between mb-4">
                                                    <div className="flex-1">
                                                        <h4 className="text-lg font-bold text-gray-900 mb-2">
                                                            {provider.businessName || provider.name || 'N/A'}
                                                        </h4>
                                                    <div className="space-y-1 text-sm text-gray-600">
                                                            <div className="flex items-center gap-2">
                                                                <Mail className="w-4 h-4" />
                                                                <span>{provider.email}</span>
                                                            </div>
                                                            {provider.phone && (
                                                                <div className="flex items-center gap-2">
                                                                    <Phone className="w-4 h-4" />
                                                                    <span>{provider.phone}</span>
                                                                </div>
                                                            )}
                                                            {provider.rejectionReason && (
                                                                <div className="mt-2 p-2 bg-red-50 rounded text-xs text-red-800">
                                                                    <strong>Reason:</strong> {provider.rejectionReason}
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <span className="px-3 py-1 bg-red-100 text-red-800 rounded-full text-sm font-medium">
                                                        Rejected
                                                    </span>
                                                    v>
                                                        ssName="flex gap-3 pt-4 border-t border-gray-200">
                                                            
                                                        onClick={() => handleDeleteProvider(provider.id)}
                                                        className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700"
                                                            
                                                                ccount
                                                                
                                                            
                                                            
                                                                
                                                                    
                                                                    
                                                                
                                                            
                                                            
                                                                
                                                                    
                                                                
                                                            
                                                        
                                                    cationAsRead}
                                                    arkAllAsRead(currentUser.uid)}
                                                        
                                                    
                                                (
                                                
                                                    ms-center justify-between mb-6">
                                                        font-bold text-gray-900">Provider Profile</h2>
                                                        erData && (
                                                    
                                                        etIsEditingProfile(true)}
                                                    lex items-center gap-2 px-4 py-2 border-2 border-gray-200 rounded-lg font-semibold hover:bg-gray-50"
                                                
                                            t2 className="w-4 h-4" />
                                        Edit Profile
                                    </button>
                                )}
                            </div>
                            {userData ? (
                                <div className="bg-white rounded-xl border border-gray-200 p-8">
                                {!isEditingProfile ? (
                                        <>
                                            <div className="space-y-6">
                                                {/* Logo Display */}
                                                <div>
                                                    <label className="block text-sm font-medium text-gray-500 mb-2">
                                                        Business Logo
                                                    </label>
                                                    <div className="w-32 h-32 bg-gray-100 rounded-lg overflow-hidden border-2 border-gray-200 flex items-center justify-center">
                                                        {userData.image ? (
                                                            <img src={userData.image} alt="Business logo" className="w-full h-full object-cover" />
                                                        ) : (
                                                            <span className="text-gray-400 text-3xl font-bold">
                                                                {userData.businessName?.charAt(0) || userData.name?.charAt(0) || '?'}
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                                <div>
                                                    <label className="block text-sm font-medium text-gray-500 mb-1">
                                                        Business Name
                                                    </label>
                                                    <div className="text-lg font-semibold text-gray-900">
                                                        {userData.businessName || 'Not set'}
                                                    </div>
                                                </div>
                                                <div>
                                                    <label className="block text-sm font-medium text-gray-500 mb-1">
                                                        Service Area
                                                    </label>
                                                    <div className="text-lg font-semibold text-gray-900">
                                                        {userData.serviceArea || userData.businessAddress || 'Not set'}
                                                    </div>
                                                    v>
                                                        
                                                            lassName="block text-sm font-medium text-gray-500 mb-1">
                                                        Business Address
                                                            
                                                                me="text-lg font-semibold text-gray-900">
                                                            rData.businessAddress || userData.address || 'Not set'}
                                                        v>
                                                    v>
                                                <div>
                                                    <label className="block text-sm font-medium text-gray-500 mb-1">
                                                        Primary Service
                                                        bel>
                                                    <div className="text-lg font-semibold text-gray-900">
                                                        {userData.primaryService || 'Not set'}
                                                        v>
                                                    v>
                                                <div>
                                                    <label className="block text-sm font-medium text-gray-500 mb-1">
                                                        Phone
                                                        bel>
                                                    <div className="text-lg font-semibold text-gray-900">
                                                        {userData.phone || 'Not set'}
                                                        v>
                                                    v>
                                                <div>
                                                    <label className="block text-sm font-medium text-gray-500 mb-1">
                                                        Email
                                                        bel>
                                                    <div className="text-lg font-semibold text-gray-900">
                                                        {userData.email || 'Not set'}
                                                        v>
                                                    v>
                                                v>
                                                 className="mt-6 pt-6 border-t border-gray-200">
                                                    ton
                                                        ick={async () => {
                                                        if (!currentUser?.email) {
                                                            alert('Email address not found. Please contact support.');
                                                            return;
                                                        }
                                                
                                                        try {
                                                            await sendPasswordResetEmail(auth, currentUser.email);
                                                            alert('Password reset email sent! Please check your inbox and follow the instructions to reset your password.');
                                                        } catch (error) {
                                                            console.error('Error sending password reset email:', error);
                                                            alert(`Failed to send password reset email: ${error.message}`);
                                                        }
                                                    }}
                                                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition-colors"
                                                    
                                                        eld className="w-4 h-4" />
                                                    Reset Password
                                                    tton>
                                                        Name="text-xs text-gray-500 mt-2">
                                                    We'll send a password reset link to your email address.
                                                </p>
                                            </div>
                                            
                                                
                                                    me="space-y-4">
                                                        oad Section */}
                                                            
                                                            Name="block text-sm font-semibold text-gray-700 mb-2">
                                                        ness Logo
                                            </label>
                                                        
                                                            me="flex items-center gap-4">
                                                            ent Logo Preview */}
                                                         className="w-32 h-32 bg-gray-100 rounded-lg overflow-hidden border-2 border-gray-200 flex items-center justify-center flex-shrink-0">
                                                            oPreview ? (
                                                            <img src={logoPreview} alt="Logo preview" className="w-full h-full object-cover" />
                                                        ) : userData?.image ? (
                                                            <img src={userData.image} alt="Current logo" className="w-full h-full object-cover" />
                                                        ) : (
                                                            <span className="text-gray-400 text-3xl font-bold">
                                                                {userData?.businessName?.charAt(0) || userData?.name?.charAt(0) || '?'}
                                                            </span>
                                                        )}
                                                    </div>
                                                    
                                                    {/* Upload Controls */}
                                                    <div className="flex-1">
                                                        <input
                                                            type="file"
                                                            accept="image/*"
                                                            onChange={handleFileSelect}  
                                  
                                
                                    
                                        
                                            
                                                
                                                
                                                 font-semibold hover:bg-blue-700 cursor-pointer transition-colors ${uploadingLogo ? 'opacity-50 cursor-not-allowed' : ''}`}
                                                                                            >
                                                
                                            
                                            
                                                
                                                       
                                                                                                                <div className="mt-2 flex items-center gap-2">
                                                    
                                                
                                                
                                                ver:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                                            
                                                
                                                                                                    </button>
                                        
                                    
                                

                                
                                                                    }}
                                                                    disabled={uploadingLogo}
                                                                    className="px-4 py-2 border-2 border-gray-300 rounded-lg font-semibold hover:bg-gray-50 disabled:opacity-50"
                                                                >
                                                                    Cancel
                                                                </button>
                                    
                                    
                                                        
                                                            lassName="text-xs text-gray-500 mt-2">
                                                            Recommended: Square image, max 5MB. Will appear on your detailer card.
                                                    </p>
                                                                                            v>

                                                                
                                                                    
                                                                    ock text-sm font-medium text-gray-700 mb-2">
                                                                    
                                                                
                                                                    
                                                                
                                                                dProviderProfile.businessName}
                                                                     setEditedProviderProfile({ ...editedProviderProfile, businessName: e.target.value })}
                                                                        -4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                                                                        s Name"
                                                                    
                                                                    
                                                                    
                                                                ="block text-sm font-medium text-gray-700 mb-2">
                                                                    
                                                                
                                                            
                                                        ="text"
                                                value={editedProviderProfile.serviceArea}
                                                        ange={(e) => setEditedProviderProfile({ ...editedProviderProfile, serviceArea: e.target.value })}
                                                            e="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                                                        eholder="City, State or ZIP codes"
                                                    
                                                v>
                                            <div>
                                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                                    Business Address
                                                    bel>
                                                <input
                                                    type="text"
                                                    value={editedProviderProfile.businessAddress}
                                                    onChange={(e) => setEditedProviderProfile({ ...editedProviderProfile, businessAddress: e.target.value })}
                                                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                                                    placeholder="123 Main St, City, State ZIP"
                                                    
                                                v>
                                            <div>
                                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                                    Phone
                                                    bel>
                                                <input
                                                    type="tel"
                                                    value={editedProviderProfile.phone}
                                                    onChange={(e) => setEditedProviderProfile({ ...editedProviderProfile, phone: e.target.value })}
                                                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                                                    placeholder="(555) 123-4567"
                                                    
                                                v>
                                            <div>
                                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                                    Email
                                                    bel>
                                                <input
                                                    type="email"
                                                    value={editedProviderProfile.email}
                                                    onChange={(e) => setEditedProviderProfile({ ...editedProviderProfile, email: e.target.value })}
                                                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-blue-600 focus:outline-none"
                                                    placeholder="business@example.com"
                                                    
                                                v>
                                            <div className="flex gap-3 pt-4">
                                                <button
                                                    onClick={async () => {
                                                        try {
                                                            // Update detailer collection
                                                            await updateDoc(doc(db, 'detailer', currentUser.uid), {
                                                                businessName: editedProviderProfile.businessName,
                                                                serviceArea: editedProviderProfile.serviceArea,
                                                                businessAddress: editedProviderProfile.businessAddress,
                                                                phone: editedProviderProfile.phone,
                                                                email: editedProviderProfile.email,
                                                                updatedAt: serverTimestamp()
                                                            });
                                                            alert('Profile updated successfully!');
                                                            setIsEditingProfile(false);
                                                            loadProviderData(); // Reload to show updated data
                                                        } catch (error) {
                                                            console.error('Error updating provider profile:', error);
                                                            alert('Failed to update profile');
                                                        }
                                                    }}
                                                    className="px-6 py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700"
                                                    
                                                    Save Changes
                                                </button>
                                                <button
                                                    onClick={() => {
                                                        setIsEditingProfile(false);
                                                        // Reset to original values
                                                            ditedProviderProfile({
                                                            businessName: userData?.businessName || '',
                                                                iceArea: userData?.serviceArea || '',
                                                                nessAddress: userData?.businessAddress || userData?.address || '',
                                                                e: userData?.phone || '',
                                                                l: userData?.email || ''
                                                                
                                                                 logo upload state
                                                            ogoFile(null);
                                                            ogoPreview(null);
                                                            
                                                            e="px-6 py-3 border-2 border-gray-200 rounded-lg font-semibold hover:bg-gray-50"
                                                        
                                                            
                                                            
                                                        
                                                    
                                                    
                                                
                                                    
                                                bg-white rounded-xl border border-gray-200 p-12 text-center">
                                                ="text-gray-600">Provider profile not found</p>
                                                    
                                                        
                                                        
                                                        
                                                            
                                                            
                                                            
}