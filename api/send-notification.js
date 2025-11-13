// Vercel serverless function to send FCM push notifications
// Note: This requires Firebase Admin SDK setup
// For production, consider using Firebase Cloud Functions instead

import admin from 'firebase-admin';

// Initialize Firebase Admin (only if credentials are available)
let adminInitialized = false;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        adminInitialized = true;
    } catch (error) {
        console.error('Failed to initialize Firebase Admin:', error);
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    if (!adminInitialized) {
        return res.status(503).json({ 
            error: 'Firebase Admin not initialized. Set FIREBASE_SERVICE_ACCOUNT environment variable.' 
        });
    }

    try {
        const { fcmToken, title, body, data } = req.body;

        if (!fcmToken || !title || !body) {
            return res.status(400).json({ error: 'Missing required fields: fcmToken, title, body' });
        }

        const message = {
            notification: {
                title,
                body,
            },
            data: data || {},
            token: fcmToken,
        };

        const response = await admin.messaging().send(message);
        
        return res.status(200).json({ 
            success: true, 
            messageId: response 
        });
    } catch (error) {
        console.error('Error sending FCM notification:', error);
        return res.status(500).json({ 
            error: error.message || 'Failed to send notification' 
        });
    }
}

