# 📦 Service Import Instructions

## How to Import Services to All Detailers

This will **REPLACE** all existing services for **ALL** detailers with the new comprehensive service list.

### Option 1: Browser Console (Easiest)

1. **Open your app** in browser: `http://localhost:3000`
2. **Open browser console** (F12 or Right-click → Inspect → Console)
3. **Make sure you're logged in** (as admin if possible)
4. **Paste this code** and press Enter:

```javascript
// Import the function
import { importServicesToAllDetailers } from './src/firebaseService.js';

// Run the import
importServicesToAllDetailers();
```

**OR** if imports don't work in console, use this:

```javascript
// Get Firebase functions
const { collection, getDocs, updateDoc, doc, query } = await import('firebase/firestore');
const { db } = await import('./src/firebase/config.js');
const { importServicesToAllDetailers } = await import('./src/firebaseService.js');

// Run import
await importServicesToAllDetailers();
```

### Option 2: Add to Admin Dashboard

Add a button in your admin dashboard that calls:

```javascript
import { importServicesToAllDetailers } from './firebaseService';

// In your admin component:
<button onClick={async () => {
    if (confirm('This will REPLACE all services for ALL detailers. Continue?')) {
        await importServicesToAllDetailers();
    }
}}>
    Import Services to All Detailers
</button>
```

### Option 3: Temporary Admin Page

Create a temporary page/route that runs the import:

```javascript
import { importServicesToAllDetailers } from './firebaseService';

function ServiceImportPage() {
    const [loading, setLoading] = useState(false);
    
    const handleImport = async () => {
        if (!confirm('This will REPLACE all services for ALL detailers. Continue?')) {
            return;
        }
        
        setLoading(true);
        try {
            await importServicesToAllDetailers();
        } finally {
            setLoading(false);
        }
    };
    
    return (
        <div>
            <button onClick={handleImport} disabled={loading}>
                {loading ? 'Importing...' : 'Import Services to All Detailers'}
            </button>
        </div>
    );
}
```

## What Gets Imported

- **23 services** total
- **Categories**: interior, exterior, paint-protection, additional
- **Each service includes**:
  - Name
  - Price (average of min/max range)
  - Duration
  - Category
  - Description
  - Slug (for URLs)
  - Price range (min/max)
  - Active status (all set to `true`)

## What Happens

1. ✅ Converts JSON services to Firebase format
2. ✅ Gets all providers from Firestore
3. ✅ **REPLACES** the `services` array for each provider
4. ✅ Updates both `providers` and `users` collections
5. ✅ Shows progress in console
6. ✅ Shows summary alert when complete

## ⚠️ Important Notes

- **This REPLACES all existing services** - make sure you want to do this!
- All detailers will have the **same 23 services**
- Services are set to `active: true` by default
- Prices are calculated as average of min/max range
- The function is in `src/firebaseService.js` as `importServicesToAllDetailers()`

## Testing

After importing:
1. Check a detailer profile - should show all 23 services
2. Check booking flow - services should appear in dropdown
3. Verify prices and durations are correct
4. Check Firebase console to confirm services were updated

## Troubleshooting

**"Cannot find module" error:**
- Make sure you're running from the app context
- Try Option 1 (browser console) instead

**"Permission denied" error:**
- Check Firestore security rules
- Make sure you're logged in
- Verify you have write access to `providers` collection

**Services not showing:**
- Refresh the page
- Check browser console for errors
- Verify services were saved in Firebase console

