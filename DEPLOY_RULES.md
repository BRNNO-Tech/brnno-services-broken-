# 🔥 Deploy Firestore Rules

## Quick Deploy Options

### Option 1: Firebase Console (Easiest - No CLI needed)

1. **Open Firebase Console**: https://console.firebase.google.com/project/brnno-enterprises/firestore/rules

2. **Copy rules** from `firestore.rules` file

3. **Paste** into the rules editor

4. **Click "Publish"**

✅ Done! Rules are deployed immediately.

---

### Option 2: Firebase CLI

1. **Install Firebase CLI** (if not installed):
   ```bash
   npm install -g firebase-tools
   ```

2. **Login**:
   ```bash
   firebase login
   ```

3. **Set project** (if not already set):
   ```bash
   firebase use brnno-enterprises
   ```

4. **Deploy rules**:
   ```bash
   firebase deploy --only firestore:rules
   ```

---

### Option 3: Using npm script (if Firebase CLI is installed)

Add to `package.json` scripts:
```json
"deploy:rules": "firebase deploy --only firestore:rules"
```

Then run:
```bash
npm run deploy:rules
```

---

## ✅ Verify Deployment

After deploying, test by:
1. Opening your app
2. Checking browser console (F12)
3. Looking for detailed logs from `loadDetailers()`
4. If you see permission errors, check the rules were deployed correctly

