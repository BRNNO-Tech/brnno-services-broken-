import React, { useState } from 'react';
import { CardElement, useElements, useStripe } from '@stripe/react-stripe-js';

export default function PaymentForm({ amount, onClose, onComplete }) {
    const stripe = useStripe();
    const elements = useElements();
    const [isLoading, setIsLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');

    const handleSubmit = async (e) => {
        e.preventDefault();
        setErrorMessage('');
        if (!stripe || !elements) return;
        setIsLoading(true);

        try {
            const res = await fetch('/api/create-payment-intent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    amountCents: Math.round((amount || 0) * 100),
                    metadata: { source: 'brnno-marketplace' }
                })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error || 'Failed to create PaymentIntent');

            const clientSecret = data.clientSecret;
            const card = elements.getElement(CardElement);
            const { error: confirmError, paymentIntent } = await stripe.confirmCardPayment(clientSecret, {
                payment_method: { card }
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
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-semibold text-gray-900">Checkout</h3>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
                </div>
                <p className="text-sm text-gray-600 mb-4">Amount due: <span className="font-semibold">${amount?.toFixed?.(2) || amount}</span></p>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="p-3 border-2 border-gray-200 rounded-lg">
                        <CardElement options={{ style: { base: { fontSize: '16px' } } }} />
                    </div>
                    {errorMessage && (
                        <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">{errorMessage}</div>
                    )}
                    <button
                        type="submit"
                        disabled={!stripe || isLoading}
                        className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-60"
                    >
                        {isLoading ? 'Processing…' : 'Pay'}
                    </button>
                    <p className="text-xs text-gray-500 text-center">Stripe Test Mode • Use 4242 4242 4242 4242</p>
                </form>
            </div>
        </div>
    );
}


