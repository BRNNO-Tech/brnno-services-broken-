import { 
    collection, 
    addDoc, 
    query, 
    where, 
    orderBy, 
    limit, 
    getDocs, 
    updateDoc, 
    doc, 
    getDoc,
    serverTimestamp,
    onSnapshot,
    Timestamp
} from 'firebase/firestore';
import { db } from '../firebase/config';
import { getToken, onMessage } from 'firebase/messaging';
import { messaging } from '../firebase/config';

// Request notification permission and get FCM token
export async function requestNotificationPermission() {
    if (!('Notification' in window)) {
        console.warn('This browser does not support notifications');
        return null;
    }

    if (Notification.permission === 'granted') {
        return await getFCMToken();
    }

    if (Notification.permission !== 'denied') {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            return await getFCMToken();
        }
    }

    return null;
}

// Get FCM token
export async function getFCMToken() {
    if (!messaging) {
        console.warn('Firebase Messaging is not available');
        return null;
    }

    try {
        const token = await getToken(messaging, {
            vapidKey: process.env.REACT_APP_FIREBASE_VAPID_KEY || ''
        });
        return token;
    } catch (error) {
        console.error('Error getting FCM token:', error);
        return null;
    }
}

// Save FCM token to Firestore
export async function saveFCMToken(userId, token) {
    if (!token || !userId) return;

    try {
        const userRef = doc(db, 'users', userId);
        await updateDoc(userRef, {
            fcmToken: token,
            fcmTokenUpdatedAt: serverTimestamp()
        });
    } catch (error) {
        console.error('Error saving FCM token:', error);
    }
}

// Create a notification in Firestore
export async function createNotification(notificationData) {
    try {
        const notification = {
            ...notificationData,
            read: false,
            createdAt: serverTimestamp()
        };
        const docRef = await addDoc(collection(db, 'notifications'), notification);
        return docRef.id;
    } catch (error) {
        console.error('Error creating notification:', error);
        throw error;
    }
}

// Get notifications for a user
export async function getNotifications(userId, limitCount = 50) {
    try {
        const q = query(
            collection(db, 'notifications'),
            where('userId', '==', userId),
            orderBy('createdAt', 'desc'),
            limit(limitCount)
        );
        const snapshot = await getDocs(q);
        return snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
    } catch (error) {
        console.error('Error getting notifications:', error);
        return [];
    }
}

// Get unread notification count
export async function getUnreadCount(userId) {
    try {
        const q = query(
            collection(db, 'notifications'),
            where('userId', '==', userId),
            where('read', '==', false)
        );
        const snapshot = await getDocs(q);
        return snapshot.size;
    } catch (error) {
        console.error('Error getting unread count:', error);
        return 0;
    }
}

// Mark notification as read
export async function markNotificationAsRead(notificationId) {
    try {
        const notificationRef = doc(db, 'notifications', notificationId);
        await updateDoc(notificationRef, {
            read: true,
            readAt: serverTimestamp()
        });
    } catch (error) {
        console.error('Error marking notification as read:', error);
    }
}

// Mark all notifications as read for a user
export async function markAllAsRead(userId) {
    try {
        const q = query(
            collection(db, 'notifications'),
            where('userId', '==', userId),
            where('read', '==', false)
        );
        const snapshot = await getDocs(q);
        const updates = snapshot.docs.map(doc => 
            updateDoc(doc.ref, {
                read: true,
                readAt: serverTimestamp()
            })
        );
        await Promise.all(updates);
    } catch (error) {
        console.error('Error marking all as read:', error);
    }
}

// Set up real-time listener for notifications
export function subscribeToNotifications(userId, callback) {
    if (!userId) return () => {};

    try {
        // Try with orderBy first (requires composite index)
        const q = query(
            collection(db, 'notifications'),
            where('userId', '==', userId),
            orderBy('createdAt', 'desc'),
            limit(50)
        );

        return onSnapshot(q, (snapshot) => {
            const notifications = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            // Sort manually as fallback
            notifications.sort((a, b) => {
                const aTime = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : 
                             (a.createdAt?.seconds ? a.createdAt.seconds * 1000 : 0);
                const bTime = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : 
                             (b.createdAt?.seconds ? b.createdAt.seconds * 1000 : 0);
                return bTime - aTime;
            });
            callback(notifications);
        }, (error) => {
            console.error('Error in notification listener (with orderBy):', error);
            // Fallback: try without orderBy
            if (error.code === 'failed-precondition') {
                console.warn('Composite index missing, falling back to query without orderBy');
                const fallbackQ = query(
                    collection(db, 'notifications'),
                    where('userId', '==', userId),
                    limit(50)
                );
                return onSnapshot(fallbackQ, (snapshot) => {
                    const notifications = snapshot.docs.map(doc => ({
                        id: doc.id,
                        ...doc.data()
                    }));
                    // Sort manually
                    notifications.sort((a, b) => {
                        const aTime = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : 
                                     (a.createdAt?.seconds ? a.createdAt.seconds * 1000 : 0);
                        const bTime = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : 
                                     (b.createdAt?.seconds ? b.createdAt.seconds * 1000 : 0);
                        return bTime - aTime;
                    });
                    callback(notifications);
                }, (fallbackError) => {
                    console.error('Error in fallback notification listener:', fallbackError);
                    callback([]); // Return empty array on error
                });
            } else {
                callback([]); // Return empty array on error
            }
        });
    } catch (error) {
        console.error('Error setting up notification listener:', error);
        callback([]); // Return empty array on error
        return () => {}; // Return no-op unsubscribe function
    }
}

// Set up real-time listener for unread count
export function subscribeToUnreadCount(userId, callback) {
    if (!userId) return () => {};

    const q = query(
        collection(db, 'notifications'),
        where('userId', '==', userId),
        where('read', '==', false)
    );

    return onSnapshot(q, (snapshot) => {
        callback(snapshot.size);
    }, (error) => {
        console.error('Error in unread count listener:', error);
    });
}

// Set up foreground message handler (when app is open)
export function setupForegroundMessageHandler() {
    if (!messaging) return;

    onMessage(messaging, (payload) => {
        console.log('Message received in foreground:', payload);
        
        // Show browser notification
        if (Notification.permission === 'granted') {
            const notificationTitle = payload.notification?.title || 'New Notification';
            const notificationOptions = {
                body: payload.notification?.body || '',
                icon: payload.notification?.icon || '/icon-192x192.png',
                badge: '/icon-192x192.png',
                tag: payload.data?.notificationId || 'notification',
                requireInteraction: false
            };
            
            new Notification(notificationTitle, notificationOptions);
        }
    });
}

// Notification types and helpers
export const NotificationTypes = {
    NEW_BOOKING: 'new_booking',
    BOOKING_CONFIRMED: 'booking_confirmed',
    BOOKING_CANCELLED: 'booking_cancelled',
    PAYMENT_RECEIVED: 'payment_received',
    BOOKING_REMINDER: 'booking_reminder'
};

// Create notification for new booking
export async function notifyNewBooking(providerUserId, bookingData) {
    const serviceText = bookingData.services?.length > 0
        ? (bookingData.services.length === 1 
            ? bookingData.services[0].name 
            : `${bookingData.services.length} services`)
        : bookingData.serviceName || 'service';

    return await createNotification({
        userId: providerUserId,
        type: NotificationTypes.NEW_BOOKING,
        title: 'New Booking Request',
        message: `You have a new booking request for ${serviceText} on ${bookingData.date} at ${bookingData.time}`,
        bookingId: bookingData.id,
        data: {
            bookingId: bookingData.id,
            customerName: bookingData.customerEmail || 'Customer',
            date: bookingData.date,
            time: bookingData.time
        }
    });
}

// Create notification for booking confirmed
export async function notifyBookingConfirmed(providerUserId, bookingData) {
    return await createNotification({
        userId: providerUserId,
        type: NotificationTypes.BOOKING_CONFIRMED,
        title: 'Booking Confirmed',
        message: `Booking for ${bookingData.date} at ${bookingData.time} has been confirmed`,
        bookingId: bookingData.id,
        data: {
            bookingId: bookingData.id,
            date: bookingData.date,
            time: bookingData.time
        }
    });
}

// Create notification for booking cancelled
export async function notifyBookingCancelled(providerUserId, bookingData) {
    return await createNotification({
        userId: providerUserId,
        type: NotificationTypes.BOOKING_CANCELLED,
        title: 'Booking Cancelled',
        message: `Booking for ${bookingData.date} at ${bookingData.time} has been cancelled`,
        bookingId: bookingData.id,
        data: {
            bookingId: bookingData.id,
            date: bookingData.date,
            time: bookingData.time
        }
    });
}

// Create notification for payment received
export async function notifyPaymentReceived(providerUserId, bookingData) {
    return await createNotification({
        userId: providerUserId,
        type: NotificationTypes.PAYMENT_RECEIVED,
        title: 'Payment Received',
        message: `Payment of $${bookingData.price || bookingData.totalPrice || 0} received for booking on ${bookingData.date}`,
        bookingId: bookingData.id,
        data: {
            bookingId: bookingData.id,
            amount: bookingData.price || bookingData.totalPrice || 0,
            date: bookingData.date
        }
    });
}

// Create notification for booking reminder
export async function notifyBookingReminder(providerUserId, bookingData) {
    const serviceText = bookingData.services?.length > 0
        ? (bookingData.services.length === 1 
            ? bookingData.services[0].name 
            : `${bookingData.services.length} services`)
        : bookingData.serviceName || 'service';

    return await createNotification({
        userId: providerUserId,
        type: NotificationTypes.BOOKING_REMINDER,
        title: 'Booking Reminder',
        message: `Reminder: You have a booking for ${serviceText} tomorrow at ${bookingData.time}`,
        bookingId: bookingData.id,
        data: {
            bookingId: bookingData.id,
            date: bookingData.date,
            time: bookingData.time
        }
    });
}

// Send FCM push notification (optional - requires backend API)
export async function sendPushNotification(fcmToken, title, body, data = {}) {
    if (!fcmToken) return;

    try {
        // Try to call the API endpoint if it exists
        const apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:3001';
        const response = await fetch(`${apiUrl}/api/send-notification`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                fcmToken,
                title,
                body,
                data
            })
        });

        if (!response.ok) {
            console.warn('Failed to send push notification:', await response.text());
        }
    } catch (error) {
        // Silently fail - push notifications are optional
        console.warn('Push notification service unavailable:', error);
    }
}

// Helper to get FCM token for a user and send push notification
export async function sendPushNotificationToUser(userId, title, body, data = {}) {
    try {
        // Get user's FCM token from Firestore
        const userDoc = await getDoc(doc(db, 'users', userId));
        if (userDoc.exists()) {
            const userData = userDoc.data();
            if (userData.fcmToken) {
                await sendPushNotification(userData.fcmToken, title, body, data);
            }
        }
    } catch (error) {
        console.warn('Failed to send push notification to user:', error);
    }
}

