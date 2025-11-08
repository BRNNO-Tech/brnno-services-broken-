// ============================================
// SERVICE IMPORT SCRIPT - Browser Console Version
// ============================================
// 
// INSTRUCTIONS:
// 1. Open your app in browser (http://localhost:3000)
// 2. Open browser console (F12)
// 3. Make sure you're logged in as admin
// 4. Copy and paste this ENTIRE script into console
// 5. Press Enter to run
//
// This will REPLACE all services for ALL detailers with the new service list
// ============================================

(async function importServices() {
    // Import Firebase functions
    const { collection, getDocs, updateDoc, doc, query } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
    
    // You'll need to get db from your app - let's use window if available
    let db;
    if (window.db) {
        db = window.db;
    } else {
        // Try to get from React app
        console.log('⚠️  Need Firebase db instance. Please run this from your app context.');
        console.log('💡 Alternative: Use the import-services-admin.js version instead');
        return;
    }

    // Services JSON data
    const servicesJson = [
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

    // Convert JSON services to Firebase format
    function convertServices(servicesJson) {
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

    try {
        console.log('🔄 Starting service import...');
        
        const convertedServices = convertServices(servicesJson);
        console.log(`✅ Converted ${convertedServices.length} services`);
        console.log('Sample service:', convertedServices[0]);
        
        // Get db from window or React context
        // For now, we'll need to access it differently
        console.log('⚠️  This script needs to be run from within your React app context.');
        console.log('💡 Better option: Use the admin function version (see import-services-admin.js)');
        
    } catch (error) {
        console.error('❌ Error:', error);
    }
})();

