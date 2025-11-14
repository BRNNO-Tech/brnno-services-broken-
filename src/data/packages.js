import { collection, doc, setDoc, deleteDoc, getDocs, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase/config';

// Package definitions for mobile detailing services
export const PACKAGES_DATA = [
    {
        id: "standard-full-detail",
        name: "Standard Full Detail",
        priceMin: 150,
        priceMax: 300,
        estimatedHours: 3,
        description: "Great for regular maintenance. Keeps your car clean and protected for 1–2 months.",
        exteriorServices: [
            "Hand wash & dry",
            "Wheel & tire cleaning",
            "Tire shine",
            "Door jamb cleaning",
            "Basic bug/tar removal",
            "Spray wax or basic sealant (1–2 months protection)"
        ],
        interiorServices: [
            "Full vacuum (seats, carpets, trunk)",
            "Wipe down of all surfaces",
            "Cup holders & compartments cleaned",
            "Windows cleaned inside/out",
            "Light shampooing",
            "Light odor neutralization"
        ]
    },
    {
        id: "mid-range-detail",
        name: "Mid-Range Detail",
        priceMin: 250,
        priceMax: 500,
        estimatedHours: 5,
        description: "Deeper clean + enhanced protection. Ideal for monthly upkeep.",
        exteriorServices: [
            "Hand wash & dry",
            "Wheel & tire cleaning",
            "Tire shine",
            "Door jamb cleaning",
            "Clay bar treatment",
            "Iron remover",
            "Machine-applied sealant (3–6 months protection)",
            "Light polishing (1-step enhancement)"
        ],
        interiorServices: [
            "Full vacuum (seats, carpets, trunk)",
            "Full carpet shampoo or steam clean",
            "Full seat shampoo or leather deep clean",
            "Stain removal",
            "Deep clean of vents & cracks",
            "Interior protectant applied",
            "Windows cleaned inside/out"
        ]
    },
    {
        id: "premium-detail",
        name: "Premium Detail",
        priceMin: 400,
        priceMax: 1200,
        estimatedHours: 8,
        description: "Showroom-ready. Full correction, ceramic, and long-term protection.",
        exteriorServices: [
            "Hand wash & dry",
            "Wheel & tire cleaning",
            "Tire shine",
            "Door jamb cleaning",
            "Clay bar treatment",
            "Iron remover",
            "Multi-stage paint correction",
            "Professional ceramic coating",
            "Glass polishing & coating",
            "Trim restoration",
            "Exhaust tip polishing",
            "Headlight restoration"
        ],
        interiorServices: [
            "Full interior extraction",
            "Ozone odor treatment",
            "Leather reconditioning",
            "Carpet/fabric protection coating",
            "Complete plastic & trim rejuvenation",
            "Full seat & carpet shampoo",
            "Deep clean of all surfaces, vents, and cracks",
            "Windows cleaned inside/out"
        ]
    }
];

// Add-ons that can be added to any package
export const ADD_ONS = [
    {
        id: "headlight-restoration",
        name: "Headlight Restoration",
        price: 100,
        description: "Restore cloudy or yellowed headlights to like-new condition"
    },
    {
        id: "ceramic-coating",
        name: "Ceramic Coating",
        price: 200,
        description: "Long-lasting paint protection (2-5 years)"
    },
    {
        id: "engine-bay-cleaning",
        name: "Engine Bay Cleaning",
        price: 75,
        description: "Deep clean and protect engine compartment"
    },
    {
        id: "pet-hair-removal",
        name: "Pet Hair Removal",
        price: 50,
        description: "Specialized removal of embedded pet hair"
    }
];

// Function to import packages to Firestore
export async function importPackagesToFirestore() {
    try {
        // Check if packages already exist
        const existingQuery = collection(db, 'packages');
        const existingSnapshot = await getDocs(existingQuery);
        
        if (!existingSnapshot.empty) {
            const overwrite = confirm(`${existingSnapshot.size} packages already exist. Do you want to overwrite them?`);
            if (!overwrite) {
                console.log('Import cancelled');
                return false;
            }
            // Delete existing packages
            const deletePromises = existingSnapshot.docs.map(doc => deleteDoc(doc.ref));
            await Promise.all(deletePromises);
        }
        
        // Import new packages
        const batch = [];
        for (const pkg of PACKAGES_DATA) {
            const pkgRef = doc(collection(db, 'packages'), pkg.id);
            batch.push(setDoc(pkgRef, {
                name: pkg.name,
                priceMin: pkg.priceMin,
                priceMax: pkg.priceMax,
                estimatedHours: pkg.estimatedHours,
                description: pkg.description,
                exteriorServices: pkg.exteriorServices,
                interiorServices: pkg.interiorServices,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            }));
        }
        
        // Execute all writes
        await Promise.all(batch);
        console.log(`✅ Imported ${PACKAGES_DATA.length} packages to Firestore`);
        alert(`Successfully imported ${PACKAGES_DATA.length} packages to Firestore!`);
        return true;
    } catch (error) {
        console.error('Error importing packages:', error);
        alert(`Error importing packages: ${error.message}`);
        throw error;
    }
}

