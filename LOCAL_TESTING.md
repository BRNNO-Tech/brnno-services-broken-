# 🚀 Local Testing Guide

## Quick Start

To run the application locally with Stripe testing:

### Option 1: Run Both Servers Together (Recommended)
```bash
npm run dev:all
```

This will start:
- **API Server** on `http://localhost:3001` (Stripe payment endpoint)
- **Webpack Dev Server** on `http://localhost:3000` (React app)

### Option 2: Run Servers Separately

**Terminal 1 - API Server:**
```bash
npm run server
```

**Terminal 2 - Webpack Dev Server:**
```bash
npm start
```

## 🔑 Stripe Keys Setup

### For Testing (Recommended)
Your `config.js` has **test keys** already configured. To use test keys:

1. **Option A**: Comment out Stripe keys in `.env`:
   ```env
   # REACT_APP_STRIPE_PUBLISHABLE_KEY=pk_live_...
   # STRIPE_SECRET_KEY=sk_live_...
   ```

2. **Option B**: Add test keys to `.env`:
   ```env
   REACT_APP_STRIPE_PUBLISHABLE_KEY=pk_test_51SAg8pPbLPDcISuo3tL9zQ0SwWtnpMtEabkOadMIttxZbbnZ7OUa1QAUwR0hpCHuEaSLv5mpNRJNL3q29QkisUgR00Pp4LXstT
   STRIPE_SECRET_KEY=sk_test_YOUR_TEST_SECRET_KEY
   ```

### Test Card Numbers
When testing, use these Stripe test cards:
- **Success**: `4242 4242 4242 4242`
- **Decline**: `4000 0000 0000 0002`
- Any future expiry date and any 3-digit CVC

## ✅ Testing Checklist

- [ ] API server running on port 3001
- [ ] Webpack dev server running on port 3000
- [ ] App loads in browser at `http://localhost:3000`
- [ ] Can browse services
- [ ] Can book a service
- [ ] Payment form opens
- [ ] Can process test payment with `4242 4242 4242 4242`

## 🐛 Troubleshooting

### API Server Not Starting
- Check if port 3001 is already in use
- Verify `STRIPE_SECRET_KEY` is set in `.env`
- Check console for error messages

### Payment Form Not Working
- Verify API server is running on port 3001
- Check browser console for errors
- Ensure Stripe publishable key is loaded (check Network tab)

### CORS Errors
- Make sure API server is running
- Check webpack proxy configuration in `webpack.config.js`

## 📝 Notes

- The API server proxies requests from `/api/*` to `http://localhost:3001`
- Test keys are safe to use and won't charge real money
- Live keys in `.env` will process real payments - use with caution!

