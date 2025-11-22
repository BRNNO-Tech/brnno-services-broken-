const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { amountCents, zipCode, state, serviceAddress } = req.body;

        // Try Stripe Tax API first
        try {
            const taxCalculation = await stripe.tax.calculations.create({
                currency: 'usd',
                line_items: [{
                    amount: amountCents,
                    reference: 'detailing_service',
                }],
                customer_details: {
                    address: {
                        line1: serviceAddress || '123 Main St',
                        postal_code: zipCode,
                        state: state || 'UT',
                        country: 'US',
                    },
                    address_source: 'shipping',
                },
            });

            return res.status(200).json({
                subtotal: amountCents,
                tax: taxCalculation.tax_amount_exclusive,
                total: taxCalculation.amount_total,
            });
        } catch (stripeError) {
            console.log('Stripe Tax API failed, using fallback:', stripeError.message);
            // Fallback to manual calculation
            const TAX_RATE = 0.0719; // Utah average rate
            const taxAmount = Math.round(amountCents * TAX_RATE);
            
            return res.status(200).json({
                subtotal: amountCents,
                tax: taxAmount,
                total: amountCents + taxAmount,
            });
        }

    } catch (err) {
        console.error('Tax calculation error:', err);
        return res.status(500).json({ error: 'Failed to calculate tax' });
    }
};

