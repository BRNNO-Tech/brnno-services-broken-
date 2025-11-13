import React, { useState } from 'react';
import { CardElement, AddressElement, useElements, useStripe } from '@stripe/react-stripe-js';

export default function PaymentForm({ amount, serviceAddress, onClose, onComplete }) {
    const stripe = useStripe();
    const elements = useElements();
    const [isLoading, setIsLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');
    const [billingAddress, setBillingAddress] = useState(null);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setErrorMessage('');
        if (!stripe || !elements) return;
        setIsLoading(true);

        try {
            // Get billing address from AddressElement if available
            const addressElement = elements.getElement(AddressElement);
            let billingAddressData = null;
            if (addressElement) {
                const { complete, value } = await addressElement.getValue();
                if (complete && value) {
                    billingAddressData = {
                        line1: value.address.line1,
                        line2: value.address.line2,
                        city: value.address.city,
                        state: value.address.state,
                        postal_code: value.address.postal_code,
                        country: value.address.country,
                    };
                }
            }

            const res = await fetch('/api/create-payment-intent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    amountCents: Math.round((amount || 0) * 100),
                    metadata: { source: 'brnno-marketplace' },
                    serviceAddress: serviceAddress || null, // Pass service location for tax calculation
                })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error || 'Failed to create PaymentIntent');

            const clientSecret = data.clientSecret;
            const card = elements.getElement(CardElement);
            
            // Prepare payment method options with billing address if available
            const paymentMethodOptions = {
                card: card,
            };
            
            if (billingAddressData) {
                paymentMethodOptions.billing_details = {
                    address: billingAddressData,
                };
            }

            const { error: confirmError, paymentIntent } = await stripe.confirmCardPayment(clientSecret, {
                payment_method: paymentMethodOptions
            });
            if (confirmError) throw new Error(confirmError.message);

            onComplete && onComplete({ 
                status: paymentIntent?.status || 'succeeded',
                paymentIntent: paymentIntent 
            });
            onClose && onClose();
        } catch (err) {
            setErrorMessage(err?.message || 'Payment failed.');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50 overflow-y-auto">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] my-auto flex flex-col p-6">
                <div className="flex items-center justify-between mb-4 flex-shrink-0">
                    <h3 className="text-lg font-semibold text-gray-900">Checkout</h3>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
                </div>
                <div className="flex-shrink-0 mb-4">
                    <p className="text-sm text-gray-600">
                        Subtotal: <span className="font-semibold">${amount?.toFixed?.(2) || amount}</span>
                        <br />
                        <span className="text-xs text-gray-500">Tax will be calculated automatically based on service location</span>
                    </p>
                </div>
                <form onSubmit={handleSubmit} className="space-y-4 overflow-y-auto flex-1 min-h-0">
                    {/* Billing Address */}
                    <div className="p-3 border-2 border-gray-200 rounded-lg">
                        <AddressElement 
                            options={{
                                mode: 'billing',
                                allowedCountries: ['US'],
                                fields: {
                                    phone: 'auto',
                                },
                            }}
                            onChange={(e) => {
                                if (e.complete) {
                                    setBillingAddress(e.value);
                                }
                            }}
                        />
                    </div>
                    
                    {/* Card Details */}
                    <div className="p-3 border-2 border-gray-200 rounded-lg">
                        <CardElement options={{ style: { base: { fontSize: '16px' } } }} />
                    </div>
                    {errorMessage && (
                        <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">{errorMessage}</div>
                    )}
                    <div className="flex-shrink-0 pt-2">
                        <button
                            type="submit"
                            disabled={!stripe || isLoading}
                            className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-60"
                        >
                            {isLoading ? 'Processing…' : 'Pay'}
                        </button>
                        <p className="text-xs text-gray-500 text-center mt-2">Stripe Test Mode • Use 4242 4242 4242 4242</p>
                    </div>
                </form>
            </div>
        </div>
    );
}


