// Secure configuration for API keys
// For development, set these directly here
// For production, these will be replaced by webpack DefinePlugin

const config = {
    // Google Maps API Key (consider moving to env var as well)
    googleMapsApiKey: 'AIzaSyCT3Y9DeGWOz6fjJXFr6I1n2H0etTVRJ64',

    // Stripe publishable key - never ship production key in source
    stripePublishableKey:
        process.env.NODE_ENV === 'production'
            ? '' // Force runtime env var in prod
            : 'pk_test_51SAg8pPbLPDcISuo3tL9zQ0SwWtnpMtEabkOadMIttxZbbnZ7OUa1QAUwR0hpCHuEaSLv5mpNRJNL3q29QkisUgR00Pp4LXstT',

    // Firebase Configuration (if needed)
    firebase: {
        apiKey: '',
        authDomain: '',
        projectId: '',
    },
};

export default config;
