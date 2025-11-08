import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
    apiVersion: '2024-09-30.acacia',
});

export default async function handler(req, res) {
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
        return res.status(400).json({ error: err?.message || 'Stripe error' });
    }
}


