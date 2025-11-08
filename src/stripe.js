import { loadStripe } from '@stripe/stripe-js';
import config from './config';

// Use environment variable first, fallback to config.js (which has test key)
const publishableKey = process.env.REACT_APP_STRIPE_PUBLISHABLE_KEY || config.stripePublishableKey || '';

export const stripePromise = publishableKey
    ? loadStripe(publishableKey)
    : Promise.resolve(null);

export default stripePromise;


