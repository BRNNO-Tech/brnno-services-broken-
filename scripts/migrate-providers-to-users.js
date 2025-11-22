/**
 * Migration Script: Merge providers collection into users collection
 * 
 * This script merges all provider documents into the unified users collection.
 * Run this ONCE after deploying the unified structure code.
 * 
 * Usage:
 * 1. Install Firebase Admin SDK: npm install firebase-admin
 * 2. Set up service account key in project root as 'service-account-key.json'
 * 3. Run: node scripts/migrate-providers-to-users.js
 */

const admin = require('firebase-admin');
const serviceAccount = require('../service-account-key.json');

// Initialize Firebase Admin
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function migrateProvidersToUsers() {
    console.log('🚀 Starting migration: providers → users collection...\n');

    try {
        // Get all providers
        const providersSnapshot = await db.collection('providers').get();

        if (providersSnapshot.empty) {
            console.log('✅ No providers found. Migration complete!');
            return;
        }

        console.log(`📋 Found ${providersSnapshot.size} provider(s) to migrate\n`);

        let migrated = 0;
        let skipped = 0;
        let errors = 0;

        for (const providerDoc of providersSnapshot.docs) {
            const providerData = providerDoc.data();
            const userId = providerData.userId;

            if (!userId) {
                console.log(`⚠️  Skipping provider ${providerDoc.id}: No userId field`);
                skipped++;
                continue;
            }

            try {
                // Get existing user document
                const userDocRef = db.collection('users').doc(userId);
                const userDoc = await userDocRef.get();

                if (userDoc.exists) {
                    // Merge provider data into existing user document
                    const userData = userDoc.data();

                    // Merge provider fields, preserving existing user fields
                    const mergedData = {
                        ...userData,
                        ...providerData,
                        accountType: 'provider', // Ensure accountType is set
                        uid: userId, // Ensure uid matches document ID
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                        migratedAt: admin.firestore.FieldValue.serverTimestamp(),
                        migratedFrom: `providers/${providerDoc.id}`
                    };

                    await userDocRef.set(mergedData, { merge: false });
                    console.log(`✅ Migrated provider ${providerDoc.id} → users/${userId}`);
                    migrated++;
                } else {
                    // Create new user document with provider data
                    const newUserData = {
                        uid: userId,
                        accountType: 'provider',
                        role: 'user',
                        ...providerData,
                        createdAt: providerData.createdAt || admin.firestore.FieldValue.serverTimestamp(),
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                        migratedAt: admin.firestore.FieldValue.serverTimestamp(),
                        migratedFrom: `providers/${providerDoc.id}`
                    };

                    await userDocRef.set(newUserData);
                    console.log(`✅ Created new user document for provider ${providerDoc.id} → users/${userId}`);
                    migrated++;
                }
            } catch (error) {
                console.error(`❌ Error migrating provider ${providerDoc.id}:`, error.message);
                errors++;
            }
        }

        console.log('\n📊 Migration Summary:');
        console.log(`   ✅ Migrated: ${migrated}`);
        console.log(`   ⏭️  Skipped: ${skipped}`);
        console.log(`   ❌ Errors: ${errors}`);
        console.log('\n✨ Migration complete!');
        console.log('\n⚠️  Next steps:');
        console.log('   1. Verify data in Firebase Console');
        console.log('   2. Test the application');
        console.log('   3. Once verified, you can delete the providers collection');

    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    }
}

// Run migration
migrateProvidersToUsers()
    .then(() => {
        console.log('\n🎉 Migration script completed!');
        process.exit(0);
    })
    .catch((error) => {
        console.error('💥 Fatal error:', error);
        process.exit(1);
    });

