import { loadStripe } from '@stripe/stripe-js';

// Use environment variable only - ensures production uses live keys
const publishableKey = process.env.REACT_APP_STRIPE_PUBLISHABLE_KEY || '';

// Detect if we're in test mode (test keys start with pk_test_)
export const isTestMode = publishableKey.startsWith('pk_test_');

export const stripePromise = publishableKey
    ? loadStripe(publishableKey)
    : Promise.resolve(null);

export default stripePromise;


