import React, { useEffect, useMemo, useState } from 'react';
import { Calendar, Car, Clock, ChevronRight, MapPin, Phone, Star, CreditCard, Edit2, Trash2, Plus, Home } from 'lucide-react';
import { auth, db } from './firebase';
import { collection, query, where, getDocs, doc, updateDoc, deleteDoc, addDoc, serverTimestamp } from 'firebase/firestore';

// Helpers
const getInitials = (fullName = '') => {
    if (!fullName) return '?';
    const parts = fullName.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return fullName.substring(0, 2).toUpperCase();
};

const mockAddresses = [
    {
        id: 'addr_1',
        label: 'Home',
        address: '1550 Market St, Denver, CO 80202',
        isPrimary: true
    },
    {
        id: 'addr_2',
        label: 'Work',
        address: '2800 Pearl St, Boulder, CO 80302',
        isPrimary: false
    }
];

const mockUpcomingAppointments = [
    {
        id: 'apt_1',
        date: 'Fri, Oct 31',
        time: '2:30 PM',
        service: 'Full Interior + Exterior',
        provider: 'ShinePro Mobile Detail',
        status: 'Confirmed',
        eta: 'Arrives in 10–20 min',
        address: '1550 Market St, Denver, CO',
        vehicle: '2021 Tesla Model 3',
        amount: 150
    },
    {
        id: 'apt_2',
        date: 'Mon, Nov 4',
        time: '10:00 AM',
        service: 'Exterior Wash + Wax',
        provider: 'Elite Detail Co',
        status: 'Scheduled',
        address: '1550 Market St, Denver, CO',
        vehicle: '2018 Ford F-150',
        amount: 85
    }
];

const mockVehicles = [
    {
        id: 'veh_1',
        name: '2021 Tesla Model 3',
        make: 'Tesla',
        model: 'Model 3',
        year: 2021,
        plate: 'BRN-2021',
        color: 'Pearl White',
        lastService: 'Sep 22, 2025'
    },
    {
        id: 'veh_2',
        name: '2018 Ford F-150',
        make: 'Ford',
        model: 'F-150',
        year: 2018,
        plate: 'TRK-518',
        color: 'Midnight Black',
        lastService: 'Aug 2, 2025'
    }
];

const mockPaymentMethods = [
    {
        id: 'pm_1',
        type: 'card',
        brand: 'Visa',
        last4: '4242',
        expiry: '12/26',
        isDefault: true
    },
    {
        id: 'pm_2',
        type: 'card',
        brand: 'Mastercard',
        last4: '8888',
        expiry: '09/25',
        isDefault: false
    }
];

// Only show last 5 bookings
const mockHistory = [
    {
        id: 'h1',
        date: 'Sep 22, 2025',
        service: 'Maintenance Detail',
        provider: 'Mile High Detailing',
        vehicle: '2021 Tesla Model 3',
        rating: 5,
        amount: 175,
        status: 'Completed'
    },
    {
        id: 'h2',
        date: 'Aug 2, 2025',
        service: 'Exterior Wash + Wax',
        provider: 'ShinePro Mobile Detail',
        vehicle: '2021 Tesla Model 3',
        rating: 4,
        amount: 120,
        status: 'Completed'
    },
    {
        id: 'h3',
        date: 'Jul 15, 2025',
        service: 'Full Detail',
        provider: 'Elite Detail Co',
        vehicle: '2018 Ford F-150',
        rating: 5,
        amount: 200,
        status: 'Completed'
    },
    {
        id: 'h4',
        date: 'Jun 8, 2025',
        service: 'Interior Detail',
        provider: 'Quick Shine Pro',
        vehicle: '2021 Tesla Model 3',
        rating: 4,
        amount: 95,
        status: 'Completed'
    },
    {
        id: 'h5',
        date: 'May 20, 2025',
        service: 'Paint Correction',
        provider: 'Elite Detail Co',
        vehicle: '2018 Ford F-150',
        rating: 5,
        amount: 350,
        status: 'Completed'
    }
].slice(0, 5); // Limit to 5 most recent

export default function CustomerDashboard({ onGoToMarketplace }) {
    const [editingVehicle, setEditingVehicle] = useState(null);
    const [userDoc, setUserDoc] = useState(null);
    const [upcomingAppointments, setUpcomingAppointments] = useState([]);
    const [addresses, setAddresses] = useState([]);
    const [paymentMethods] = useState([]); // Stripe-managed in backend
    const [vehicles, setVehicles] = useState([]);
    const currentAuthUser = auth.currentUser;

    useEffect(() => {
        const fetchAll = async () => {
            if (!auth.currentUser) return;
            // Load user profile
            const usersQ = query(collection(db, 'users'), where('uid', '==', auth.currentUser.uid));
            const usersSnap = await getDocs(usersQ);
            if (!usersSnap.empty) {
                const d = usersSnap.docs[0];
                setUserDoc({ id: d.id, ...d.data() });
            }

            // Load upcoming bookings
            try {
                const bookingsQ = query(
                    collection(db, 'bookings'),
                    where('customerId', '==', auth.currentUser.uid),
                    where('status', 'in', ['pending', 'confirmed', 'scheduled'])
                );
                const bookingsSnap = await getDocs(bookingsQ);
                const apts = bookingsSnap.docs.map((b) => {
                    const data = b.data();
                    return {
                        id: b.id,
                        detailerName: data.detailerName || 'Detailer',
                        service: data.serviceName || 'Service',
                        date: data.date ? new Date(data.date).toLocaleDateString() : 'TBD',
                        time: data.time || 'TBD',
                        price: data.price || 0,
                        address: data.address || '',
                        status: data.status || 'pending'
                    };
                });
                setUpcomingAppointments(apts);
            } catch (_) {
                setUpcomingAppointments([]);
            }

            // Load addresses subcollection (optional)
            try {
                if (usersSnap && !usersSnap.empty) {
                    const d = usersSnap.docs[0];
                    const addrSnap = await getDocs(collection(db, 'users', d.id, 'addresses'));
                    setAddresses(addrSnap.docs.map((ad) => ({ id: ad.id, ...ad.data() })));
                }
            } catch (_) {
                setAddresses([]);
            }

            // Load vehicles subcollection (optional)
            try {
                if (usersSnap && !usersSnap.empty) {
                    const d = usersSnap.docs[0];
                    const vehSnap = await getDocs(collection(db, 'users', d.id, 'vehicles'));
                    setVehicles(vehSnap.docs.map((vh) => ({ id: vh.id, ...vh.data() })));
                }
            } catch (_) {
                setVehicles([]);
            }
        };
        fetchAll();
    }, []);

    const handleEditVehicle = (vehicleId) => {
        alert(`Edit vehicle: ${vehicleId}`);
    };

    const handleDeleteVehicle = (vehicleId) => {
        if (confirm('Are you sure you want to delete this vehicle?')) {
            alert(`Delete vehicle: ${vehicleId}`);
        }
    };

    const handleGoToMarketplace = () => {
        if (onGoToMarketplace) onGoToMarketplace();
    };

    return (
        <div className="min-h-screen bg-gray-50">
            {/* Header */}
            <div className="bg-white border-b border-gray-200">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                            {/* Profile Picture */}
                            <div className="w-16 h-16 bg-blue-600 rounded-full flex items-center justify-center text-white font-bold text-2xl">
                                {getInitials(userDoc?.name || currentAuthUser?.displayName || currentAuthUser?.email || '')}
                            </div>
                            <div>
                                <h1 className="text-3xl font-bold text-gray-900">{userDoc?.name || currentAuthUser?.displayName || 'My Profile'}</h1>
                                <p className="text-gray-600 mt-1">{userDoc?.email || currentAuthUser?.email || ''}</p>
                            </div>
                        </div>
                        <button
                            onClick={handleGoToMarketplace}
                            className="px-4 py-2 border-2 border-gray-300 rounded-lg font-semibold text-gray-700 hover:bg-gray-50 transition-all flex items-center gap-2"
                        >
                            <Calendar className="w-4 h-4" />
                            Find Detailers
                        </button>
                    </div>
                </div>
            </div>

            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                {/* Main Grid */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
                    {/* Upcoming Appointments - 2 columns */}
                    <div className="lg:col-span-2 space-y-4">
                        <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                            <Clock className="w-6 h-6" />
                            Upcoming Appointments
                        </h2>

                        {upcomingAppointments.map((appointment) => (
                            <div key={appointment.id} className="bg-white border border-gray-200 rounded-lg p-6">
                                <div className="grid md:grid-cols-2 gap-6">
                                    <div className="bg-blue-600 rounded-lg p-6 flex items-center justify-center">
                                        <div className="text-center text-white">
                                            <Car className="w-16 h-16 mx-auto mb-3 opacity-90" />
                                            <p className="font-semibold text-lg">{appointment.vehicle}</p>
                                        </div>
                                    </div>

                                    <div className="space-y-3">
                                        <div>
                                            <p className="text-lg font-semibold text-gray-900">{appointment.service}</p>
                                            <p className="text-gray-600">{appointment.provider}</p>
                                        </div>

                                        <div className="space-y-1 text-sm">
                                            <p className="text-gray-900 font-medium">
                                                {appointment.date} • {appointment.time}
                                            </p>
                                            <p className="text-green-600 font-medium flex items-center gap-1">
                                                <div className="w-2 h-2 bg-green-600 rounded-full"></div>
                                                {appointment.status}
                                                {appointment.eta && ` — ${appointment.eta}`}
                                            </p>
                                            <p className="text-gray-600 flex items-center gap-1">
                                                <MapPin className="w-4 h-4" />
                                                {appointment.address}
                                            </p>
                                            <p className="text-gray-900 font-semibold mt-2">
                                                ${appointment.amount}
                                            </p>
                                        </div>

                                        <div className="pt-3 flex gap-2">
                                            <button className="flex-1 px-4 py-2 border-2 border-gray-300 rounded-lg font-semibold text-gray-700 hover:bg-gray-50 transition-all flex items-center justify-center gap-2 text-sm">
                                                <Phone className="w-4 h-4" />
                                                Contact
                                            </button>
                                            {appointment.eta && (
                                                <button className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition-all flex items-center justify-center gap-2 text-sm">
                                                    Track
                                                    <ChevronRight className="w-4 h-4" />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}

                        {upcomingAppointments.length === 0 && (
                            <div className="bg-white border border-gray-200 rounded-lg p-12 text-center">
                                <Calendar className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                                <p className="text-gray-600 mb-4">No upcoming appointments</p>
                                <button className="px-6 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition-all">
                                    Book a Service
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Right Column - Payment & Addresses */}
                    <div className="space-y-6">
                        {/* Payment Methods */}
                        <div className="bg-white border border-gray-200 rounded-lg p-6">
                            <div className="flex items-center gap-2 mb-4">
                                <CreditCard className="w-5 h-5 text-blue-600" />
                                <h2 className="text-xl font-bold text-gray-900">Payment Methods</h2>
                            </div>

                            <div className="space-y-3">
                                {paymentMethods.map((method) => (
                                    <div
                                        key={method.id}
                                        className={`p-4 border-2 rounded-lg ${method.isDefault
                                            ? 'border-blue-500 bg-blue-50'
                                            : 'border-gray-200 bg-white'
                                            }`}
                                    >
                                        <div className="flex items-start justify-between mb-2">
                                            <div className="flex items-center gap-2">
                                                <CreditCard className="w-5 h-5 text-gray-600" />
                                                <div>
                                                    <p className="font-semibold text-gray-900">
                                                        {method.brand} •••• {method.last4}
                                                    </p>
                                                    <p className="text-sm text-gray-600">Expires {method.expiry}</p>
                                                </div>
                                            </div>
                                            {method.isDefault && (
                                                <span className="px-2 py-1 bg-blue-600 text-white text-xs font-semibold rounded">
                                                    Default
                                                </span>
                                            )}
                                        </div>

                                        {!method.isDefault && (
                                            <button className="text-sm text-blue-600 hover:text-blue-700 font-medium">
                                                Set as default
                                            </button>
                                        )}
                                    </div>
                                ))}
                            </div>

                            <button className="w-full mt-4 px-4 py-2 border-2 border-gray-300 rounded-lg font-semibold text-gray-700 hover:bg-gray-50 transition-all text-sm">
                                + Add Payment Method
                            </button>
                        </div>

                        {/* Saved Addresses */}
                        <div className="bg-white border border-gray-200 rounded-lg p-6">
                            <div className="flex items-center gap-2 mb-4">
                                <Home className="w-5 h-5 text-blue-600" />
                                <h2 className="text-xl font-bold text-gray-900">Saved Addresses</h2>
                            </div>

                            <div className="space-y-3">
                                {addresses.map((addr) => (
                                    <div
                                        key={addr.id}
                                        className={`p-4 border-2 rounded-lg ${addr.isPrimary
                                            ? 'border-blue-500 bg-blue-50'
                                            : 'border-gray-200 bg-white'
                                            }`}
                                    >
                                        <div className="flex items-start justify-between mb-2">
                                            <div>
                                                <div className="flex items-center gap-2 mb-1">
                                                    <p className="font-semibold text-gray-900">{addr.label}</p>
                                                    {addr.isPrimary && (
                                                        <span className="px-2 py-0.5 bg-blue-600 text-white text-xs font-semibold rounded">
                                                            Primary
                                                        </span>
                                                    )}
                                                </div>
                                                <p className="text-sm text-gray-600">{addr.address}</p>
                                            </div>
                                        </div>

                                        {!addr.isPrimary && (
                                            <button className="text-sm text-blue-600 hover:text-blue-700 font-medium">
                                                Set as primary
                                            </button>
                                        )}
                                    </div>
                                ))}
                            </div>

                            <button className="w-full mt-4 px-4 py-2 border-2 border-gray-300 rounded-lg font-semibold text-gray-700 hover:bg-gray-50 transition-all text-sm">
                                + Add Address
                            </button>
                        </div>
                    </div>
                </div>

                {/* Your Vehicles Section */}
                <div className="mb-8">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                            <Car className="w-6 h-6" />
                            Your Vehicles
                        </h2>
                        <button className="px-4 py-2 border-2 border-gray-300 rounded-lg font-semibold text-gray-700 hover:bg-gray-50 transition-all text-sm flex items-center gap-2">
                            <Plus className="w-4 h-4" />
                            Add Vehicle
                        </button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {vehicles.map((vehicle) => (
                            <div key={vehicle.id} className="bg-white border border-gray-200 rounded-lg overflow-hidden hover:shadow-lg transition-all">
                                <div className="bg-gradient-to-br from-blue-500 to-blue-600 h-32 flex items-center justify-center">
                                    <Car className="w-16 h-16 text-white opacity-90" />
                                </div>

                                <div className="p-5">
                                    <h3 className="font-bold text-lg text-gray-900 mb-1">{vehicle.name}</h3>
                                    <div className="space-y-1 text-sm text-gray-600 mb-4">
                                        <p>Plate: <span className="font-medium text-gray-900">{vehicle.plate}</span></p>
                                        <p>Color: <span className="font-medium text-gray-900">{vehicle.color}</span></p>
                                        <p className="text-xs">Last service: {vehicle.lastService}</p>
                                    </div>

                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => handleEditVehicle(vehicle.id)}
                                            className="flex-1 px-3 py-2 border-2 border-gray-300 rounded-lg font-semibold text-gray-700 hover:bg-gray-50 transition-all text-sm flex items-center justify-center gap-1"
                                        >
                                            <Edit2 className="w-3.5 h-3.5" />
                                            Edit
                                        </button>
                                        <button
                                            onClick={() => handleDeleteVehicle(vehicle.id)}
                                            className="px-3 py-2 border-2 border-red-200 text-red-600 rounded-lg font-semibold hover:bg-red-50 transition-all text-sm flex items-center justify-center gap-1"
                                        >
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Booking History Section - Limited to 5 */}
                <div>
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                            <Clock className="w-6 h-6" />
                            Recent Bookings
                        </h2>
                        <span className="text-sm text-gray-600">Showing last 5 bookings</span>
                    </div>

                    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                        <div className="divide-y divide-gray-200">
                            {mockHistory.map((booking) => (
                                <div key={booking.id} className="p-5 hover:bg-gray-50 transition-all">
                                    <div className="flex items-start justify-between">
                                        <div className="flex-1">
                                            <div className="flex items-center gap-3 mb-2">
                                                <h3 className="font-bold text-lg text-gray-900">{booking.service}</h3>
                                                <span className="px-2 py-1 bg-green-100 text-green-700 rounded text-xs font-semibold">
                                                    {booking.status}
                                                </span>
                                            </div>

                                            <div className="space-y-1 text-sm text-gray-600">
                                                <p>{booking.provider}</p>
                                                <p>{booking.vehicle}</p>
                                                <p className="text-xs">{booking.date}</p>
                                            </div>

                                            <div className="flex items-center gap-1 mt-2">
                                                {[...Array(5)].map((_, i) => (
                                                    <Star
                                                        key={i}
                                                        className={`w-4 h-4 ${i < booking.rating
                                                            ? 'text-yellow-500 fill-current'
                                                            : 'text-gray-300'
                                                            }`}
                                                    />
                                                ))}
                                            </div>
                                        </div>

                                        <div className="text-right">
                                            <p className="text-2xl font-bold text-gray-900">${booking.amount}</p>
                                            <button className="mt-2 px-4 py-1.5 border-2 border-gray-300 rounded-lg font-semibold text-gray-700 hover:bg-gray-50 transition-all text-sm">
                                                Book Again
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}


