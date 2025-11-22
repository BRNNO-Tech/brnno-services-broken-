/**
 * Cleanup Script: Remove duplicate users and providers
 * 
 * This script helps clean up duplicate accounts after migration.
 * It identifies users with the same email and helps merge or delete duplicates.
 * 
 * Usage:
 * 1. Install Firebase Admin SDK: npm install firebase-admin
 * 2. Set up service account key in project root as 'service-account-key.json'
 * 3. Run: node scripts/cleanup-duplicate-users.js
 */

const admin = require('firebase-admin');
const readline = require('readline');

// Initialize Firebase Admin
try {
    const serviceAccount = require('../service-account-key.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
} catch (error) {
    // Try alternative initialization methods
    try {
        admin.initializeApp({
            credential: admin.credential.applicationDefault()
        });
    } catch (err) {
        console.error('❌ Failed to initialize Firebase Admin:', err.message);
        console.error('Please ensure service-account-key.json exists or GOOGLE_APPLICATION_CREDENTIALS is set');
        process.exit(1);
    }
}

const db = admin.firestore();

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(prompt) {
    return new Promise((resolve) => {
        rl.question(prompt, resolve);
    });
}

async function cleanupDuplicates() {
    console.log('🧹 Starting duplicate user cleanup...\n');

    try {
        // Get all users
        const usersSnapshot = await db.collection('users').get();
        console.log(`📋 Found ${usersSnapshot.size} user document(s)\n`);

        // Group by email
        const usersByEmail = {};
        usersSnapshot.docs.forEach(doc => {
            const data = doc.data();
            const email = data.email || data.businessEmail || 'no-email';
            
            if (!usersByEmail[email]) {
                usersByEmail[email] = [];
            }
            
            usersByEmail[email].push({
                id: doc.id,
                ...data,
                docRef: doc.ref, // Keep reference for potential use
                createdAt: data.createdAt // Preserve timestamp
            });
        });

        // Find duplicates
        const duplicates = Object.entries(usersByEmail).filter(([email, users]) => {
            return users.length > 1 && email !== 'no-email';
        });

        if (duplicates.length === 0) {
            console.log('✅ No duplicate emails found!');
            rl.close();
            return;
        }

        console.log(`🔍 Found ${duplicates.length} email(s) with duplicates:\n`);

        for (const [email, users] of duplicates) {
            console.log(`\n📧 Email: ${email}`);
            console.log(`   Found ${users.length} account(s):`);
            
            users.forEach((user, index) => {
                console.log(`\n   ${index + 1}. Document ID: ${user.id}`);
                console.log(`      Account Type: ${user.accountType || 'customer'}`);
                console.log(`      Name: ${user.name || user.businessName || 'N/A'}`);
                console.log(`      Status: ${user.status || 'N/A'}`);
                console.log(`      Role: ${user.role || 'user'}`);
                console.log(`      Created: ${user.createdAt?.toDate?.() || 'N/A'}`);
                console.log(`      Has packages: ${user.offeredPackages?.length > 0 ? 'Yes' : 'No'}`);
            });

            const action = await question(`\n   What would you like to do?\n   [k]eep all, [d]elete duplicates (keep newest), [m]erge, [s]kip: `);
            
            if (action.toLowerCase() === 'd') {
                // Keep the newest one (by createdAt or document ID)
                const sorted = users.sort((a, b) => {
                    const aTime = a.createdAt?.toDate?.() || new Date(0);
                    const bTime = b.createdAt?.toDate?.() || new Date(0);
                    return bTime - aTime; // Newest first
                });
                
                const keep = sorted[0];
                const toDelete = sorted.slice(1);
                
                console.log(`\n   ✅ Keeping: ${keep.id}`);
                
                let deletedCount = 0;
                let errorCount = 0;
                
                for (const user of toDelete) {
                    try {
                        console.log(`   🗑️  Deleting: ${user.id}...`);
                        const docRef = db.collection('users').doc(user.id);
                        
                        // Verify document exists before deleting
                        const docSnapshot = await docRef.get();
                        if (!docSnapshot.exists) {
                            console.log(`   ⚠️  Document ${user.id} doesn't exist, skipping`);
                            continue;
                        }
                        
                        await docRef.delete();
                        
                        // Verify deletion
                        const verifySnapshot = await docRef.get();
                        if (verifySnapshot.exists) {
                            console.log(`   ❌ Failed to delete ${user.id} - document still exists`);
                            errorCount++;
                        } else {
                            console.log(`   ✅ Successfully deleted ${user.id}`);
                            deletedCount++;
                        }
                    } catch (error) {
                        console.error(`   ❌ Error deleting ${user.id}:`, error.message);
                        errorCount++;
                    }
                }
                
                console.log(`\n   📊 Summary: ${deletedCount} deleted, ${errorCount} errors`);
            } else if (action.toLowerCase() === 'm') {
                // Merge: keep the most complete one, merge data
                const sorted = users.sort((a, b) => {
                    // Prioritize: providers > customers, approved > pending, has packages > no packages
                    const aScore = (a.accountType === 'provider' ? 10 : 0) +
                                  (a.status === 'approved' ? 5 : 0) +
                                  (a.offeredPackages?.length > 0 ? 3 : 0);
                    const bScore = (b.accountType === 'provider' ? 10 : 0) +
                                  (b.status === 'approved' ? 5 : 0) +
                                  (b.offeredPackages?.length > 0 ? 3 : 0);
                    return bScore - aScore;
                });
                
                const keep = sorted[0];
                const toMerge = sorted.slice(1);
                
                console.log(`\n   ✅ Keeping: ${keep.id}`);
                
                // Merge data from duplicates
                const mergedData = { ...keep };
                for (const user of toMerge) {
                    // Merge non-empty fields
                    Object.keys(user).forEach(key => {
                        if (key !== 'id' && key !== 'docRef' && user[key] !== undefined && user[key] !== null) {
                            if (!mergedData[key] || (Array.isArray(user[key]) && user[key].length > 0)) {
                                mergedData[key] = user[key];
                            }
                        }
                    });
                }
                
                // Update the kept document
                try {
                    const keepRef = db.collection('users').doc(keep.id);
                    await keepRef.update({
                        ...mergedData,
                        mergedAt: admin.firestore.FieldValue.serverTimestamp(),
                        mergedFrom: toMerge.map(u => u.id)
                    });
                    console.log(`   ✅ Updated ${keep.id} with merged data`);
                } catch (error) {
                    console.error(`   ❌ Error updating ${keep.id}:`, error.message);
                }
                
                // Delete merged documents
                let deletedCount = 0;
                let errorCount = 0;
                
                for (const user of toMerge) {
                    try {
                        console.log(`   🗑️  Deleting: ${user.id}...`);
                        const docRef = db.collection('users').doc(user.id);
                        
                        // Verify document exists before deleting
                        const docSnapshot = await docRef.get();
                        if (!docSnapshot.exists) {
                            console.log(`   ⚠️  Document ${user.id} doesn't exist, skipping`);
                            continue;
                        }
                        
                        await docRef.delete();
                        
                        // Verify deletion
                        const verifySnapshot = await docRef.get();
                        if (verifySnapshot.exists) {
                            console.log(`   ❌ Failed to delete ${user.id} - document still exists`);
                            errorCount++;
                        } else {
                            console.log(`   ✅ Successfully deleted ${user.id}`);
                            deletedCount++;
                        }
                    } catch (error) {
                        console.error(`   ❌ Error deleting ${user.id}:`, error.message);
                        errorCount++;
                    }
                }
                
                console.log(`\n   📊 Summary: ${deletedCount} deleted, ${errorCount} errors`);
            } else if (action.toLowerCase() === 's') {
                console.log(`   ⏭️  Skipping ${email}`);
            } else {
                console.log(`   ✅ Keeping all accounts for ${email}`);
            }
        }

        console.log('\n✨ Cleanup complete!');
        console.log('\n⚠️  Next steps:');
        console.log('   1. Verify data in Firebase Console');
        console.log('   2. Test the application');
        console.log('   3. Check if detailers load correctly');

    } catch (error) {
        console.error('❌ Cleanup failed:', error);
        process.exit(1);
    } finally {
        rl.close();
    }
}

// Run cleanup
cleanupDuplicates()
    .then(() => {
        console.log('\n🎉 Cleanup script completed!');
        process.exit(0);
    })
    .catch((error) => {
        console.error('💥 Fatal error:', error);
        process.exit(1);
    });

