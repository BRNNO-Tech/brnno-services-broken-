import { loadStripe } from '@stripe/stripe-js';

const publishableKey = process.env.REACT_APP_STRIPE_PUBLISHABLE_KEY;

if (!publishableKey) {
    console.error('Stripe publishable key is not set in environment variables');
}

export const stripePromise = publishableKey
    ? loadStripe(publishableKey)
    : Promise.resolve(null);

export default stripePromise;


