const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
    apiVersion: '2024-09-30.acacia',
});

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { amountCents, metadata, serviceAddress } = req.body || {};
        const amount = Number(amountCents);
        if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ error: 'Invalid amount' });
        }

        // Build payment intent with automatic tax
        const paymentIntentParams = {
            amount,
            currency: 'usd',
            automatic_payment_methods: { enabled: true },
            automatic_tax: { enabled: true },
            metadata: metadata || {},
        };

        // Add shipping address for tax calculation (service location for mobile detailing)
        // Stripe Tax uses this to determine the tax jurisdiction
        if (serviceAddress) {
            // For mobile services, the service location determines tax jurisdiction
            // We'll use shipping address to represent where the service is performed
            paymentIntentParams.shipping = {
                address: {
                    line1: serviceAddress, // Full address string
                    country: 'US', // Assuming US for now
                },
            };
        }

        const paymentIntent = await stripe.paymentIntents.create(paymentIntentParams);

        return res.status(200).json({ clientSecret: paymentIntent.client_secret });
    } catch (err) {
        return res.status(400).json({ error: err?.message || 'Stripe error' });
    }
};

