import {
    collection,
    addDoc,
    getDocs,
    query,
    orderBy,
    limit,
    where,
    doc,
    updateDoc,
    increment,
    getDoc,
    setDoc,
    deleteDoc
} from 'firebase/firestore';
import { db } from './firebase/config';

// Waitlist analytics function
export const getWaitlistAnalytics = async () => {
    try {
        const waitlistQuery = query(collection(db, 'waitlist'));
        const waitlistSnapshot = await getDocs(waitlistQuery);

        const analytics = {
            totalCount: waitlistSnapshot.size,
            recentSignups: 0,
            byCity: {},
            byService: {},
            byUrgency: {},
            byVehicleType: {}
        };

        const oneDayAgo = new Date();
        oneDayAgo.setDate(oneDayAgo.getDate() - 1);

        waitlistSnapshot.forEach((doc) => {
            const data = doc.data();

            // Count recent signups
            if (data.createdAt && data.createdAt.toDate() > oneDayAgo) {
                analytics.recentSignups++;
            }

            // Count by city
            if (data.city) {
                analytics.byCity[data.city] = (analytics.byCity[data.city] || 0) + 1;
            }

            // Count by service
            if (data.service) {
                analytics.byService[data.service] = (analytics.byService[data.service] || 0) + 1;
            }

            // Count by urgency
            if (data.urgency) {
                analytics.byUrgency[data.urgency] = (analytics.byUrgency[data.urgency] || 0) + 1;
            }

            // Count by vehicle type
            if (data.vehicleType) {
                analytics.byVehicleType[data.vehicleType] = (analytics.byVehicleType[data.vehicleType] || 0) + 1;
            }
        });

        return analytics;
    } catch (error) {
        console.error('Error fetching waitlist analytics:', error);
        throw error;
    }
};

// Provider management functions
export const getProviderBookings = async (providerId) => {
    try {
        const bookingsQuery = query(
            collection(db, 'bookings'),
            where('providerId', '==', providerId),
            orderBy('date', 'desc')
        );
        const bookingsSnapshot = await getDocs(bookingsQuery);

        const bookings = [];
        bookingsSnapshot.forEach((doc) => {
            bookings.push({
                id: doc.id,
                ...doc.data()
            });
        });

        return bookings;
    } catch (error) {
        console.error('Error fetching provider bookings:', error);
        throw error;
    }
};

export const updateProviderServices = async (providerId, services) => {
    try {
        // Update in users collection
        await updateDoc(doc(db, 'users', providerId), {
            services: services
        });

        // Also update in providers collection
        const providerQuery = query(collection(db, 'providers'), where('userId', '==', providerId));
        const providerSnapshot = await getDocs(providerQuery);

        if (!providerSnapshot.empty) {
            const providerDoc = providerSnapshot.docs[0];
            await updateDoc(providerDoc.ref, {
                services: services
            });
        }

        return true;
    } catch (error) {
        console.error('Error updating provider services:', error);
        throw error;
    }
};

export const updateProviderAvailability = async (providerId, availability) => {
    try {
        const providerQuery = query(collection(db, 'providers'), where('userId', '==', providerId));
        const providerSnapshot = await getDocs(providerQuery);

        if (!providerSnapshot.empty) {
            const providerDoc = providerSnapshot.docs[0];
            await updateDoc(providerDoc.ref, {
                defaultAvailability: availability
            });
        }

        return true;
    } catch (error) {
        console.error('Error updating provider availability:', error);
        throw error;
    }
};

export const addProviderDateOverride = async (providerId, dateOverride) => {
    try {
        const providerQuery = query(collection(db, 'providers'), where('userId', '==', providerId));
        const providerSnapshot = await getDocs(providerQuery);

        if (!providerSnapshot.empty) {
            const providerDoc = providerSnapshot.docs[0];
            const providerData = providerDoc.data();
            const dateOverrides = providerData.dateOverrides || {};

            const overrideId = Date.now().toString();
            dateOverrides[overrideId] = dateOverride;

            await updateDoc(providerDoc.ref, {
                dateOverrides: dateOverrides
            });
        }

        return true;
    } catch (error) {
        console.error('Error adding date override:', error);
        throw error;
    }
};

export const removeProviderDateOverride = async (providerId, overrideId) => {
    try {
        const providerQuery = query(collection(db, 'providers'), where('userId', '==', providerId));
        const providerSnapshot = await getDocs(providerQuery);

        if (!providerSnapshot.empty) {
            const providerDoc = providerSnapshot.docs[0];
            const providerData = providerDoc.data();
            const dateOverrides = providerData.dateOverrides || {};

            delete dateOverrides[overrideId];

            await updateDoc(providerDoc.ref, {
                dateOverrides: dateOverrides
            });
        }

        return true;
    } catch (error) {
        console.error('Error removing date override:', error);
        throw error;
    }
};

// ==================== SERVICE IMPORT FUNCTION ====================
// Imports services from JSON and REPLACES all services for ALL detailers

export const SERVICES_JSON = [
    {
        "category": "interior",
        "name": "Interior Vacuum",
        "slug": "interior-vacuum",
        "description": "Full vacuum of seats, carpets, floor mats, trunk, and all crevices.",
        "estimatedDuration": "15-25 min",
        "avgPriceRange": { "min": 20, "max": 40 }
    },
    {
        "category": "interior",
        "name": "Steam Cleaning or Shampooing Upholstery, Carpets, Floor Mats",
        "slug": "steam-shampoo-upholstery-carpets-mats",
        "description": "Deep extraction or high-temperature steam cleaning to lift dirt, stains, and allergens.",
        "estimatedDuration": "45-75 min",
        "avgPriceRange": { "min": 80, "max": 150 }
    },
    {
        "category": "interior",
        "name": "Leather Cleaning and Conditioning",
        "slug": "leather-clean-condition",
        "description": "pH-balanced cleaner followed by premium conditioner to restore suppleness and UV protection.",
        "estimatedDuration": "30-45 min",
        "avgPriceRange": { "min": 60, "max": 120 }
    },
    {
        "category": "interior",
        "name": "Leather Restoration (e.g., Dyeing)",
        "slug": "leather-restoration-dyeing",
        "description": "Color restoration, crack repair, and re-dyeing of worn leather surfaces.",
        "estimatedDuration": "90-180 min",
        "avgPriceRange": { "min": 150, "max": 400 }
    },
    {
        "category": "interior",
        "name": "Pet Hair Removal",
        "slug": "pet-hair-removal",
        "description": "Specialized tools (rubber brushes, air purge, lint rollers) to eliminate embedded pet hair.",
        "estimatedDuration": "30-60 min",
        "avgPriceRange": { "min": 40, "max": 90 }
    },
    {
        "category": "interior",
        "name": "Stain and Odor Removal",
        "slug": "stain-odor-removal",
        "description": "Enzyme treatments, ozone shock, or steam extraction to neutralize and eliminate odors (smoke, food, pets).",
        "estimatedDuration": "45-90 min",
        "avgPriceRange": { "min": 70, "max": 160 }
    },
    {
        "category": "exterior",
        "name": "Hand Wash and Dry",
        "slug": "hand-wash-dry",
        "description": "Two-bucket method with pH-neutral shampoo, microfiber mitts, and blower drying.",
        "estimatedDuration": "20-30 min",
        "avgPriceRange": { "min": 30, "max": 60 }
    },
    {
        "category": "exterior",
        "name": "Waxing and Removing Swirls",
        "slug": "waxing-swirl-removal",
        "description": "Machine polish to eliminate light swirls, followed by a protective carnauba or synthetic wax.",
        "estimatedDuration": "60-120 min",
        "avgPriceRange": { "min": 120, "max": 250 }
    },
    {
        "category": "exterior",
        "name": "Clay Bar Treatment",
        "slug": "clay-bar-treatment",
        "description": "Removes bonded contaminants (rail dust, industrial fallout) using detailing clay and lubricant.",
        "estimatedDuration": "30-45 min",
        "avgPriceRange": { "min": 50, "max": 100 }
    },
    {
        "category": "exterior",
        "name": "Bug and Tar Removal",
        "slug": "bug-tar-removal",
        "description": "Specialized solvents and clay to safely dissolve insects and road tar without damaging paint.",
        "estimatedDuration": "15-30 min",
        "avgPriceRange": { "min": 25, "max": 60 }
    },
    {
        "category": "exterior",
        "name": "Wheel and Tire Cleaning",
        "slug": "wheel-tire-cleaning",
        "description": "pH-balanced wheel cleaner, iron remover, tire scrub, and glossy tire dressing.",
        "estimatedDuration": "20-35 min",
        "avgPriceRange": { "min": 30, "max": 70 }
    },
    {
        "category": "exterior",
        "name": "Wheel Polishing",
        "slug": "wheel-polishing",
        "description": "Metal polish for chrome/aluminum wheels to restore mirror-like shine.",
        "estimatedDuration": "45-75 min",
        "avgPriceRange": { "min": 80, "max": 150 }
    },
    {
        "category": "exterior",
        "name": "Trim and Chrome Polishing",
        "slug": "trim-chrome-polishing",
        "description": "Restores faded plastic trim and polishes chrome accents with dedicated protectants.",
        "estimatedDuration": "20-40 min",
        "avgPriceRange": { "min": 40, "max": 90 }
    },
    {
        "category": "paint-protection",
        "name": "Ceramic Coatings",
        "slug": "ceramic-coatings",
        "description": "Professional-grade nano-ceramic application (1-5 year durability) for extreme hydrophobicity and UV resistance.",
        "estimatedDuration": "4-8 hrs (multi-day cure)",
        "avgPriceRange": { "min": 500, "max": 1500 }
    },
    {
        "category": "paint-protection",
        "name": "Paint Correction – Light",
        "slug": "paint-correction-light",
        "description": "Single-stage machine polish to remove light swirls and 50-70% of defects.",
        "estimatedDuration": "3-5 hrs",
        "avgPriceRange": { "min": 250, "max": 450 }
    },
    {
        "category": "paint-protection",
        "name": "Paint Correction – Heavy",
        "slug": "paint-correction-heavy",
        "description": "Multi-stage compounding and finishing to eliminate deep scratches and heavy oxidation.",
        "estimatedDuration": "6-12 hrs",
        "avgPriceRange": { "min": 600, "max": 1200 }
    },
    {
        "category": "paint-protection",
        "name": "Scratch and Scuff Removal",
        "slug": "scratch-scuff-removal",
        "description": "Localized wet-sanding and polishing for isolated scratches that do not penetrate clear coat.",
        "estimatedDuration": "30-90 min per panel",
        "avgPriceRange": { "min": 75, "max": 200 }
    },
    {
        "category": "paint-protection",
        "name": "Touch-Up Painting",
        "slug": "touch-up-painting",
        "description": "OEM-matched paint for rock chips and small blemishes, blended seamlessly.",
        "estimatedDuration": "45-90 min",
        "avgPriceRange": { "min": 80, "max": 180 }
    },
    {
        "category": "additional",
        "name": "Headlight Restoration",
        "slug": "headlight-restoration",
        "description": "Wet-sanding, compounding, and UV sealant to restore clarity and nighttime visibility.",
        "estimatedDuration": "45-75 min",
        "avgPriceRange": { "min": 80, "max": 150 }
    },
    {
        "category": "additional",
        "name": "Engine Bay Cleaning",
        "slug": "engine-bay-cleaning",
        "description": "Degrease, pressure rinse (low PSI), and dress plastics for a showroom engine compartment.",
        "estimatedDuration": "45-60 min",
        "avgPriceRange": { "min": 70, "max": 130 }
    },
    {
        "category": "additional",
        "name": "Water Spot Removal",
        "slug": "water-spot-removal",
        "description": "Acid-based or polishing compounds to dissolve mineral deposits on glass and paint.",
        "estimatedDuration": "20-40 min",
        "avgPriceRange": { "min": 40, "max": 90 }
    },
    {
        "category": "additional",
        "name": "Fleet Detailing (Commercial Vehicles)",
        "slug": "fleet-detailing",
        "description": "Bulk pricing packages for vans, trucks, or company cars – interior/exterior combo.",
        "estimatedDuration": "Varies",
        "avgPriceRange": { "min": 150, "max": 400 }
    },
    {
        "category": "additional",
        "name": "Boat / RV / Motorcycle / Aircraft Detailing",
        "slug": "specialty-vehicle-detailing",
        "description": "Custom detailing for marine, recreational, powersport, or aviation surfaces.",
        "estimatedDuration": "Quote-based",
        "avgPriceRange": { "min": 300, "max": 2000 }
    }
];

export function convertServices(servicesJson) {
    return servicesJson.map(service => {
        const avgPrice = Math.round((service.avgPriceRange.min + service.avgPriceRange.max) / 2);
        
        return {
            id: service.slug,
            name: service.name,
            price: avgPrice,
            duration: service.estimatedDuration,
            category: service.category,
            description: service.description,
            slug: service.slug,
            priceRange: {
                min: service.avgPriceRange.min,
                max: service.avgPriceRange.max
            },
            active: true
        };
    });
}

export const importServicesToAllDetailers = async () => {
    try {
        console.log('🔄 Starting service import...');
        
        const convertedServices = convertServices(SERVICES_JSON);
        console.log(`✅ Converted ${convertedServices.length} services`);
        
        // Get all providers
        const providersQuery = query(collection(db, 'providers'));
        const providersSnapshot = await getDocs(providersQuery);
        
        console.log(`📋 Found ${providersSnapshot.size} providers`);
        
        let successCount = 0;
        let errorCount = 0;
        
        for (const providerDoc of providersSnapshot.docs) {
            try {
                const providerId = providerDoc.id;
                const providerData = providerDoc.data();
                
                // REPLACE services in providers collection
                await updateDoc(doc(db, 'providers', providerId), {
                    services: convertedServices
                });
                
                // Also update in users collection if userId exists
                if (providerData.userId) {
                    await updateDoc(doc(db, 'users', providerData.userId), {
                        services: convertedServices
                    });
                }
                
                console.log(`✅ Updated: ${providerData.businessName || providerData.ownerName || providerId}`);
                successCount++;
            } catch (error) {
                console.error(`❌ Error updating provider ${providerDoc.id}:`, error);
                errorCount++;
            }
        }
        
        const message = `✅ Import complete!\n\n` +
            `📊 Summary:\n` +
            `- Services imported: ${convertedServices.length}\n` +
            `- Providers updated: ${successCount}\n` +
            `- Errors: ${errorCount}`;
        
        console.log(message);
        alert(message);
        
        return {
            success: true,
            servicesCount: convertedServices.length,
            providersUpdated: successCount,
            errors: errorCount
        };
    } catch (error) {
        console.error('❌ Import failed:', error);
        alert('Error importing services: ' + error.message);
        throw error;
    }
};

// Make available in browser console for admin usage
if (typeof window !== 'undefined') {
    window.importServicesToAllDetailers = importServicesToAllDetailers;
}

