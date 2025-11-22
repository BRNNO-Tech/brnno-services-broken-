import { loadStripe } from '@stripe/stripe-js';

// Use environment variable only - ensures production uses live keys
const publishableKey = process.env.REACT_APP_STRIPE_PUBLISHABLE_KEY || '';

export const stripePromise = publishableKey
    ? loadStripe(publishableKey)
    : Promise.resolve(null);

export default stripePromise;


