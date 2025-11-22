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
        const { amountCents, zipCode, state, serviceAddress } = req.body;

        // Option A: Use Stripe Tax Calculation API (proper way)
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
            console.error('Stripe Tax calculation error:', stripeError);
            
            // Fallback to manual calculation if Stripe Tax fails
            const TAX_RATE = 0.0719; // Utah average (7.19%)
            const taxAmount = Math.round(amountCents * TAX_RATE);
            
            return res.status(200).json({
                subtotal: amountCents,
                tax: taxAmount,
                total: amountCents + taxAmount,
            });
        }
    } catch (err) {
        console.error('Tax calculation error:', err);
        
        // Fallback to manual calculation
        const { amountCents } = req.body;
        const TAX_RATE = 0.0719; // Utah average
        const taxAmount = Math.round((amountCents || 0) * TAX_RATE);
        
        return res.status(200).json({
            subtotal: amountCents || 0,
            tax: taxAmount,
            total: (amountCents || 0) + taxAmount,
        });
    }
};

