# Account Feature - Auth Middleware

Feature-specific authentication middleware for account pages.

## Purpose

This directory contains middleware that is specific to the **account feature** (login, registration, etc.) and sets up the authentication context for account pages.

## Architecture Pattern: `res.locals`

Following Express best practices, this middleware:
1. **Does NOT mutate `req`** (except for necessary session management)
2. **Sets `res.locals.freezr`** with all context data
3. **Makes data flow explicit** - downstream code knows exactly what's available

## Files

### `publicUserPageAuth.mjs`

Middleware for public account pages (like login page).

**What it does:**
- Sets up `res.locals.freezr` with:
  - `freezrVersion` - Freezr server version
  - `isSetup` - Whether freezr is configured
  - `appName` - Current app name
  - `appFS` - App filesystem handler
  - `status` - Freezr status object
  - `selfRegOptions` - Self-registration options
  - `serverName` - Server URL for generating links

**Usage:**
```javascript
app.get('/account/login', checkSetUp, async (req, res, next) => {
  const { default: publicUserPageAuth } = await import('./path/to/publicUserPageAuth.mjs')
  await publicUserPageAuth(req, res, dsManager, next)
}, controllerFunction)
```

## Why Feature-Specific?

Account feature has unique requirements:
- Needs public access (no login required)
- Needs self-registration options
- Needs freezr status for templates
- May need different context than admin or apps features

Other features (admin, apps) will have their own auth middleware with different context.

## Data Flow

```
Request
  ↓
[checkSetUp] - Server-level middleware
  ↓
[publicUserPageAuth] - Feature middleware (sets res.locals.freezr)
  ↓
[Controller] - Reads res.locals.freezr
  ↓
[Service] - Receives explicit parameters (session, context, params)
  ↓
Response
```

## Benefits

1. **No Hidden Dependencies** - Controller explicitly receives what it needs
2. **Testable** - Can mock res.locals for testing
3. **Clear Separation** - Middleware = setup, Controller = orchestration, Service = logic
4. **Reusable** - Other account pages can use same middleware
5. **Type-Safe Ready** - res.locals structure can be typed with JSDoc or TypeScript

## Next Steps

As we modernize more account pages, they can all use `publicUserPageAuth` middleware, ensuring consistent context setup across the account feature.

