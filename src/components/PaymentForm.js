import React, { useState, useEffect } from 'react';
import { CardElement, AddressElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { isTestMode } from '../stripe';

export default function PaymentForm({ amount, serviceAddress, onClose, onComplete }) {
    const stripe = useStripe();
    const elements = useElements();
    const [isLoading, setIsLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');
    const [billingAddress, setBillingAddress] = useState(null);
    const [taxBreakdown, setTaxBreakdown] = useState(null);
    const [isCalculatingTax, setIsCalculatingTax] = useState(false);

    // Calculate tax when billing address changes
    const calculateTax = async (amountCents, zipCode, state, address) => {
        if (!zipCode || !amountCents) return;

        setIsCalculatingTax(true);
        try {
            const response = await fetch('/api/calculate-tax', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    amountCents: amountCents,
                    zipCode,
                    state,
                    serviceAddress: address || serviceAddress,
                }),
            });

            const data = await response.json();
            setTaxBreakdown(data);
        } catch (error) {
            console.error('Tax calculation failed:', error);
            // Fallback: show subtotal only
            setTaxBreakdown({
                subtotal: amountCents,
                tax: 0,
                total: amountCents,
            });
        } finally {
            setIsCalculatingTax(false);
        }
    };

    // Watch for address changes
    useEffect(() => {
        if (billingAddress?.address?.postal_code && amount) {
            const amountCents = Math.round((amount || 0) * 100);
            calculateTax(
                amountCents,
                billingAddress.address.postal_code,
                billingAddress.address.state,
                serviceAddress
            );
        }
    }, [billingAddress?.address?.postal_code, billingAddress?.address?.state, amount, serviceAddress]);

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

            // Use tax breakdown total if available, otherwise use original amount
            const finalAmountCents = taxBreakdown?.total || Math.round((amount || 0) * 100);

            const res = await fetch('/api/create-payment-intent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    amountCents: finalAmountCents,
                    metadata: {
                        source: 'brnno-marketplace',
                        subtotal: taxBreakdown?.subtotal || finalAmountCents,
                        tax: taxBreakdown?.tax || 0,
                    },
                    serviceAddress: serviceAddress || null,
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

    const subtotalCents = Math.round((amount || 0) * 100);
    const displaySubtotal = taxBreakdown?.subtotal || subtotalCents;
    const displayTax = taxBreakdown?.tax || 0;
    const displayTotal = taxBreakdown?.total || subtotalCents;

    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50 overflow-y-auto">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] my-auto flex flex-col p-6">
                <div className="flex items-center justify-between mb-4 flex-shrink-0">
                    <h3 className="text-lg font-semibold text-gray-900">Checkout</h3>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
                </div>

                {/* Tax Breakdown */}
                <div className="flex-shrink-0 mb-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
                    <div className="space-y-2">
                        <div className="flex justify-between text-sm">
                            <span className="text-gray-600">Subtotal:</span>
                            <span className="font-medium">${(displaySubtotal / 100).toFixed(2)}</span>
                        </div>
                        {isCalculatingTax ? (
                            <div className="flex justify-between text-sm">
                                <span className="text-gray-600">Tax:</span>
                                <span className="text-gray-400">Calculating...</span>
                            </div>
                        ) : taxBreakdown ? (
                            <div className="flex justify-between text-sm">
                                <span className="text-gray-600">Tax:</span>
                                <span className="font-medium">${(displayTax / 100).toFixed(2)}</span>
                            </div>
                        ) : (
                            <div className="flex justify-between text-sm">
                                <span className="text-gray-600">Tax:</span>
                                <span className="text-xs text-gray-500">Enter address to calculate</span>
                            </div>
                        )}
                        <div className="flex justify-between pt-2 border-t border-gray-300">
                            <span className="font-semibold text-gray-900">Total:</span>
                            <span className="font-bold text-lg text-gray-900">${(displayTotal / 100).toFixed(2)}</span>
                        </div>
                    </div>
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
                            disabled={!stripe || isLoading || isCalculatingTax}
                            className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-60"
                        >
                            {isLoading ? 'Processing…' : `Pay $${(displayTotal / 100).toFixed(2)}`}
                        </button>
                        {isTestMode && (
                            <p className="text-xs text-gray-500 text-center mt-2">Stripe Test Mode • Use 4242 4242 4242 4242</p>
                        )}
                    </div>
                </form>
            </div>
        </div>
    );
}


