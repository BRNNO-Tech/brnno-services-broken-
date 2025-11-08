const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Stripe
// For local development/testing, prefer test keys
// Check if we have a test secret key, otherwise use the env var
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY_TEST || '';

if (!stripeSecretKey) {
    console.warn('⚠️  WARNING: No Stripe secret key found. Set STRIPE_SECRET_KEY or STRIPE_SECRET_KEY_TEST in .env');
}

const stripe = new Stripe(stripeSecretKey, {
    apiVersion: '2024-09-30.acacia',
});

// Payment Intent endpoint
app.post('/api/create-payment-intent', async (req, res) => {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { amountCents, metadata } = req.body || {};
        const amount = Number(amountCents);
        if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ error: 'Invalid amount' });
        }

        const paymentIntent = await stripe.paymentIntents.create({
            amount,
            currency: 'usd',
            automatic_payment_methods: { enabled: true },
            metadata: metadata || {},
        });

        return res.status(200).json({ clientSecret: paymentIntent.client_secret });
    } catch (err) {
        console.error('Stripe error:', err);
        return res.status(400).json({ error: err?.message || 'Stripe error' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 API server running on http://localhost:${PORT}`);
    console.log(`📝 Stripe endpoint: http://localhost:${PORT}/api/create-payment-intent`);
});

