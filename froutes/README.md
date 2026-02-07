# Froutes Directory (Freezr Routes)

This directory contains route mounting logic for modern feature modules.

## Purpose

- **`index.mjs`** - Master orchestrator that mounts ALL modern routes (single entry point)
- **Individual files** - Each feature has its own route mounting logic

## Structure

```
froutes/
├── README.md              # This file
├── index.mjs              # ⭐ MASTER - Mounts all routes (called from server.js)
├── accountRoutes.mjs      # Account feature route mounting
├── adminRoutes.mjs        # Admin feature route mounting (future)
└── appsRoutes.mjs         # Apps feature route mounting (future)
```

## Pattern

Each route mounting module exports functions that:
- Accept the Express `app` instance
- Accept dependencies (dsManager, freezrPrefs, etc.)
- Return a result object with `{ success: boolean }`

### Example:

```javascript
// routes/accountRoutes.mjs
export async function mountAccountApiRoutes(app, { dsManager, freezrPrefs, freezrStatus }) {
  try {
    const { createAccountRoutes } = await import('../features/account/routes.mjs')
    const accountRoutes = createAccountRoutes({ dsManager, freezrPrefs, freezrStatus })
    app.use('/api/account', accountRoutes)
    return { success: true }
  } catch (error) {
    return { success: false, error }
  }
}
```

## Usage in server.js

**Simple!** Just ONE function call to mount ALL routes:

```javascript
// server.js
async.waterfall([
  // ... initialize dsManager, freezrPrefs, etc.
  
  async function (cb) {
    // Single function mounts ALL modern routes
    const { mountAllModernRoutes } = await import('./froutes/index.mjs')
    await mountAllModernRoutes(app, { dsManager, freezrPrefs, freezrStatus })
    cb(null)
  }
])
```

**That's it!** No need to call 10 different mounting functions.

## Benefits

1. **Separation of Concerns** - Route mounting logic is separate from server.js
2. **Scalability** - Easy to add new feature route mounting
3. **Testability** - Each mounting function can be tested independently
4. **Clarity** - Clear where routes are mounted and with what dependencies

## Migration Path

As features are modernized:
1. Create a new file in `routes/` (e.g., `adminRoutes.mjs`)
2. Export mounting functions for that feature
3. Import and call in server.js waterfall
4. Remove legacy route definitions from server.js

## How It Works

```
server.js
    ↓ calls
froutes/index.mjs (mountAllModernRoutes)
    ↓ orchestrates
    ├── froutes/accountRoutes.mjs (mountAccountApiRoutes)
    ├── froutes/adminRoutes.mjs (mountAdminApiRoutes)
    └── froutes/appsRoutes.mjs (mountAppsApiRoutes)
        ↓ each imports and mounts
        └── features/*/routes.mjs (createXxxRoutes)
```

**server.js stays clean** - Just ONE function call, no matter how many features you add!

Clean, modular, and maintainable! 🎉

