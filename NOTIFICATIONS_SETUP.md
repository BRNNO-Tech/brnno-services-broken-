# Notification System Setup Guide

## ✅ What's Implemented

The notification system for detailers/providers is now fully implemented with:

1. **In-App Notifications** ✅
   - Real-time notification center in Provider Dashboard
   - Badge counter showing unread count
   - Notification history with read/unread status
   - Automatic updates via Firestore listeners

2. **Notification Types** ✅
   - New Booking Request
   - Booking Confirmed
   - Booking Cancelled
   - Payment Received
   - Booking Reminder (ready for implementation)

3. **FCM Integration** ✅
   - Firebase Cloud Messaging initialized
   - Permission request flow
   - FCM token storage in Firestore
   - Foreground message handler (when app is open)

## 🔧 Setup Required

### 1. Firebase VAPID Key (Required for Push Notifications)

To enable push notifications when the app is closed:

1. Go to Firebase Console → Project Settings → Cloud Messaging
2. Under "Web configuration", generate a new key pair (or use existing)
3. Copy the **Key pair** value
4. Add to your `.env` file:
   ```
   REACT_APP_FIREBASE_VAPID_KEY=your-vapid-key-here
   ```
5. Add to Vercel environment variables (if deploying)

### 2. Service Worker for Background Notifications (Optional)

For background push notifications, create `public/firebase-messaging-sw.js`:

```javascript
importScripts('https://www.gstatic.com/firebasejs/12.4.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.4.0/firebase-messaging-compat.js');

const firebaseConfig = {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_AUTH_DOMAIN",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_STORAGE_BUCKET",
    messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
    appId: "YOUR_APP_ID"
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
    const notificationTitle = payload.notification?.title || 'New Notification';
    const notificationOptions = {
        body: payload.notification?.body || '',
        icon: '/icon-192x192.png',
        badge: '/icon-192x192.png'
    };
    
    self.registration.showNotification(notificationTitle, notificationOptions);
});
```

### 3. Backend Push Notification API (Optional)

For sending push notifications via backend, you need:

1. **Firebase Admin SDK Setup**:
   - Go to Firebase Console → Project Settings → Service Accounts
   - Generate a new private key
   - Download the JSON file
   - Add to Vercel environment variables as `FIREBASE_SERVICE_ACCOUNT` (as JSON string)

2. **Install Firebase Admin** (if using Node.js server):
   ```bash
   npm install firebase-admin
   ```

3. **API Endpoint**: The `api/send-notification.js` file is ready but requires Firebase Admin setup.

## 📋 Firestore Security Rules

Add these rules for the `notifications` collection:

```javascript
match /notifications/{notificationId} {
  allow read: if request.auth != null && 
    resource.data.userId == request.auth.uid;
  allow create: if request.auth != null;
  allow update: if request.auth != null && 
    resource.data.userId == request.auth.uid;
}
```

## 🎯 How It Works

### In-App Notifications (Currently Active)
- When a booking is created/updated, a notification document is created in Firestore
- The Provider Dashboard listens to notifications in real-time
- Notifications appear instantly in the Notification Center tab
- Badge counter updates automatically

### Push Notifications (Requires Setup)
- FCM tokens are stored when providers log in
- Backend can send push notifications using the stored tokens
- Notifications appear even when the app is closed (after service worker setup)

## 🧪 Testing

1. **Test In-App Notifications**:
   - Log in as a provider
   - Create a booking as a customer
   - Check Provider Dashboard → Notifications tab
   - You should see the notification appear immediately

2. **Test Push Notifications** (after setup):
   - Grant notification permission when prompted
   - Close the app/browser tab
   - Create a booking as a customer
   - Provider should receive a browser push notification

## 📝 Notification Triggers

Notifications are automatically created when:
- ✅ New booking is created (after payment)
- ✅ Booking status changes to "cancelled"
- ⏳ Booking reminder (24h before) - ready but not scheduled yet

## 🔄 Next Steps (Optional)

1. **Set up Cloud Functions** for automatic push notifications:
   - Create a Cloud Function that triggers on notification document creation
   - Automatically send FCM push notification
   - More reliable than API endpoint approach

2. **Schedule Booking Reminders**:
   - Set up a scheduled Cloud Function
   - Check bookings 24 hours before scheduled time
   - Send reminder notifications

3. **Email Notifications** (if desired):
   - Integrate SendGrid/Resend
   - Send email notifications for important events

## 🐛 Troubleshooting

- **No notifications appearing**: Check Firestore security rules
- **Permission denied**: User needs to grant notification permission
- **Push notifications not working**: Verify VAPID key is set correctly
- **FCM token not saving**: Check Firestore write permissions for users collection

