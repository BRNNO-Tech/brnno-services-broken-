import React from 'react';
import { createRoot } from 'react-dom/client';
import { Elements } from '@stripe/react-stripe-js';
import BrnnoMarketplace from './BrnnoMarketplace';
import { stripePromise } from './stripe';
import './firebaseService'; // ensure service import helpers are bundled (attaches to window for admin tools)

// ==================== GLOBAL ERROR HANDLERS ====================
// Temporarily simplified to prevent browser freeze issues
// Catch all unhandled errors and promise rejections to ensure they show in console

let errorHandlerActive = true;

window.addEventListener('error', (event) => {
    if (!errorHandlerActive) return;
    // Simplified logging to prevent performance issues
    console.error('🚨 Error:', event.message);
    // Don't prevent default - let it show in console normally
});

window.addEventListener('unhandledrejection', (event) => {
    if (!errorHandlerActive) return;
    // Simplified logging to prevent performance issues
    console.error('🚨 Promise Rejection:', event.reason?.message || String(event.reason));
    // Don't prevent default - let it show in console normally
});

// Log when console is ready
console.log('✅ Global error handlers initialized');

const container = document.getElementById('root');
const root = createRoot(container);
root.render(
    <Elements stripe={stripePromise}>
        <BrnnoMarketplace />
    </Elements>
);


