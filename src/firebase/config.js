import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getMessaging, getToken, onMessage, isSupported } from 'firebase/messaging';

const firebaseConfig = {
    apiKey: process.env.REACT_APP_FIREBASE_API_KEY || '',
    authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN || '',
    projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID || '',
    storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID || '',
    appId: process.env.REACT_APP_FIREBASE_APP_ID || '',
    measurementId: process.env.REACT_APP_FIREBASE_MEASUREMENT_ID || undefined
};

// Validate Firebase config before initializing
if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
    console.error('⚠️ Firebase configuration is missing required fields:', {
        hasApiKey: !!firebaseConfig.apiKey,
        hasProjectId: !!firebaseConfig.projectId,
        hasAuthDomain: !!firebaseConfig.authDomain
    });
}

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

// Initialize Firebase Cloud Messaging
let messagingInstance = null;
if (typeof window !== 'undefined') {
    isSupported().then((supported) => {
        if (supported) {
            messagingInstance = getMessaging(app);
        }
    }).catch(() => {
        // ignore messaging errors silently
    });
}

export const messaging = messagingInstance;

// Log Firebase initialization
console.log('✅ Firebase initialized:', {
    projectId: firebaseConfig.projectId || 'NOT SET',
    authDomain: firebaseConfig.authDomain || 'NOT SET'
});

let analyticsInstance = null;
if (typeof window !== 'undefined' && firebaseConfig.measurementId) {
    // Dynamically import analytics to avoid module side-effects in unsupported envs
    import('firebase/analytics')
        .then(({ getAnalytics, isSupported }) => {
            return isSupported().then((supported) => {
                if (supported) {
                    analyticsInstance = getAnalytics(app);
                }
            });
        })
        .catch(() => {
            // ignore analytics errors silently
        });
}

export const analytics = analyticsInstance;

export default app;
