# Account Feature Module

This directory contains the modernized account management functionality following a scalable, feature-based architecture.

## Structure

```
account/
├── controllers/          # Request handlers (thin orchestration layer)
│   └── loginController.mjs
├── middleware/           # Feature-specific middleware
│   ├── accountContext.mjs    # Sets res.locals with account data
│   └── loginGuards.mjs       # Login-specific auth guards
├── services/             # Business logic (pure functions)
│   └── loginService.mjs
└── routes.mjs            # Route definitions with dependency injection
```

## Architecture Pattern

This feature demonstrates the scalable pattern for all Freezr features:

### Middleware Flow
Each route follows this pattern:
1. **Basic Auth** (cross-cutting) - from `middleware/auth/basicAuth.mjs`
   - Setup checks, session validation
2. **Feature Context** (feature-specific) - from `./middleware/accountContext.mjs`
   - Sets `res.locals.freezr` with account-specific data
3. **Route Guards** (route-specific) - from `./middleware/loginGuards.mjs`
   - Route-specific validation and redirects
4. **Controllers** - from `./controllers/*.mjs`
   - Orchestrates services, renders response

### Example: Login Route

```javascript
// In routes.mjs
router.get('/login', 
  setupCheck,              // 1. Cross-cutting: verify freezr is configured
  loginRedirect,           // 2. Route guard: redirect if already logged in
  publicAccountContext,    // 3. Feature context: set res.locals.freezr
  generateLoginPage        // 4. Controller: render page
)
```

### Data Flow Pattern

```javascript
// 1. Pure check (no side effects)
export const isAuthenticated = (session) => {
  return !!session?.logged_in_user_id
}

// 2. Generic guard (composes check + redirect)
export const createInverseRedirectGuard = (checkFn, redirectUrl) => {
  return (req, res, next) => {
    checkFn(req, res) ? res.redirect(redirectUrl) : next()
  }
}

// 3. Feature guard (composes pure check + generic guard)
export const createNoAuthGuard = (homeUrl = '/account/home') => {
  return createInverseRedirectGuard(
    (req) => isAuthenticated(req.session),
    homeUrl
  )
}

// 4. Context middleware sets res.locals
export const createPublicAccountContext = (dsManager, freezrPrefs) => {
  return async (req, res, next) => {
    res.locals.freezr = { serverVersion, isSetup, appName, appFS, ... }
    next()
  }
}

// 5. Controller reads from res.locals
export const generateLoginPage = async (req, res) => {
  const options = buildLoginPageOptions(
    req.session,
    res.locals.freezr,
    req.params
  )
  return fileHandler.load_data_html_and_page(req, res, options)
}

// 6. Service uses pure functions
export const buildLoginPageOptions = (session, freezrContext, params) => {
  return {
    page_title: params.app_name ? `Login for ${params.app_name}` : 'Login',
    server_name: freezrContext.serverName,
    // ...
  }
}
```

## Modernization Status

### Phase 4: Clean Separation Pattern ✅ COMPLETE

**Objective**: Separate pure checks from guard logic for maximum reusability

**Completed**:
1. ✅ Created `middleware/auth/basicAuth.mjs` (pure auth checks)
   - `isSetup(dsManager)` → boolean
   - `isAuthenticated(session)` → boolean
   - `hasSession(session)` → boolean
   - **Pure functions**: No side effects, just return true/false

2. ✅ Created `middleware/auth/guards.mjs` (generic guard creators)
   - `createRedirectGuard(checkFn, redirectUrl)` - Redirect if check fails
   - `createInverseRedirectGuard(checkFn, redirectUrl)` - Redirect if check passes
   - `createForbiddenGuard(checkFn, message)` - Send 403 if check fails
   - **Composable**: Work with any check function

3. ✅ Created `middleware/accountGuards.mjs` (feature guards)
   - `createSetupGuard(dsManager)` - Composes isSetup + createRedirectGuard
   - `createAuthGuard(loginUrl)` - Composes isAuthenticated + createRedirectGuard
   - `createNoAuthGuard(homeUrl)` - Composes isAuthenticated + createInverseRedirectGuard
   - **Feature-specific**: Combine layers 1 + 2

4. ✅ Created `middleware/accountContext.mjs` (feature context)
   - `createPublicAccountContext()` - Loads data into res.locals.freezr

5. ✅ Updated `routes.mjs` - Clean composition
6. ✅ Removed `loginGuards.mjs` - Replaced by accountGuards.mjs

**Benefits**:
- ✅ **Pure functions**: Auth checks are easily testable
- ✅ **Composable**: Same check, different behaviors (redirect, 403, 401)
- ✅ **Reusable**: Generic guards work with any check function
- ✅ **Scalable**: Pattern replicates to all features
- ✅ **Clear separation**: Check logic vs response handling
- ✅ **No side effects**: Pure checks have no mutations

## Testing the Modern Version

Both routes are available:
- **Modern:** `/account/login` - ES6 module implementation (transitional approach)
- **Legacy:** `/account/oldlogin` - Original CommonJS implementation (for comparison)

The modern version demonstrates:
- ✅ Clean separation pattern (pure checks + generic guards)
- ✅ Dependency injection pattern
- ✅ Factory functions for middleware
- ✅ `res.locals` pattern (no req mutation)
- ✅ Pure service functions
- ✅ Clear middleware composition
- ✅ Feature-based architecture
- ✅ Modern page loader adapter (no req.freezrAppFS dependency)
- ✅ Transitional approach (dynamic imports in legacy routes)

## Replication Guide for Other Features

To modernize another feature (e.g., `apps`, `admin`):

1. Create `features/{feature}/middleware/{feature}Context.mjs`
   - Factory functions that set `res.locals.{feature}`
   - Feature-specific context (e.g., app manifest, user permissions)

2. Create `features/{feature}/middleware/{feature}Guards.mjs`
   - Route-specific validation (e.g., user owns app, user is admin)

3. Create `features/{feature}/routes.mjs`
   - Import from `middleware/auth/basicAuth.mjs` (cross-cutting)
   - Import from `./middleware/{feature}Context.mjs` (feature-specific)
   - Compose middleware: basic → context → guards → controller

4. Controllers read from `res.locals`, never mutate `req`

## Next Steps

See `MODERNIZATION_ROADMAP.md` for remaining gaps to 100% modernization:
- Remove `req.freezrPrefs` dependency
- Replace legacy file handler with modern renderer
- Add centralized error handling
- Add request logging middleware
