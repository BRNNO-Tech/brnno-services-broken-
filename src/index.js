import React from 'react';
import { createRoot } from 'react-dom/client';
import { Elements } from '@stripe/react-stripe-js';
import BrnnoMarketplace from './BrnnoMarketplace';
import { stripePromise } from './stripe';
import './firebaseService'; // ensure service import helpers are bundled (attaches to window for admin tools)

const container = document.getElementById('root');
const root = createRoot(container);
root.render(
    <Elements stripe={stripePromise}>
        <BrnnoMarketplace />
    </Elements>
);


