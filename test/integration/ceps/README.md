# CEPS Integration Tests

## Overview

This directory contains integration tests for the CEPS (Common Endpoint Pattern System) API endpoints.

**Status:** ✅ **All 15 tests passing!**

## Test Status

### ✅ All Tests Passing! (15/15 tests passing)
- ✅ `/ceps/ping` - Health check
- ✅ `/ceps/write` - Create records
- ✅ `/ceps/read` - Read record by ID
- ✅ `/ceps/query` - Query records  
- ✅ `/ceps/update` - Update records
- ✅ `/ceps/delete` - Delete records
- ✅ All authentication rejection tests
- ⏭️ Multi-user tests (2 pending - require secondary test user)

## How It Works

The test suite authenticates by:
1. **Login** via `/acctapi/login` to get session cookie
2. **Visit app page** `/apps/com.test.ceps` to get app-specific token
3. **Use Bearer token** in `Authorization` header for CEPS API calls

The key insight: The server checks for `sec-fetch-mode: navigate` header (from browsers) before issuing app tokens. In test mode (`FREEZR_TEST_MODE=true`), this check is bypassed.

## Files Created

1. **`testUserCreds.json`** - Test user credentials
   - Contains credentials for multiple test users
   - Configures test app name and table

2. **`testAuthHelper.mjs`** - Authentication helper
   - Handles login and token acquisition
   - Provides convenience methods for HTTP requests
   - Manages cookies and sessions

3. **`ceps.test.mjs`** - Main test suite
   - Tests all 5 CEPS endpoints
   - Includes multi-user test scaffolding

4. **`debug_token.mjs`** - Debug script
   - Standalone script to debug token issues
   - Run with: `node test/integration/ceps/debug_token.mjs`

## Running Tests

**IMPORTANT:** The server must be running in test mode for tests to work:

```bash
# Terminal 1: Start server in test mode (allows test requests to get app tokens)
npm run devtest

# Terminal 2: Run CEPS tests
npm run test:ceps

# Or run debug script
node test/integration/ceps/debug_token.mjs
```

### Why Test Mode?

The server checks for `sec-fetch-mode: navigate` header (from real browsers) before issuing app tokens. In test mode (`FREEZR_TEST_MODE=true`), this check is bypassed so automated tests can obtain app tokens.

## Prerequisites

1. Server must be running in test mode: `npm run devtest`
2. Test user must exist (currently using `guest2`)
3. Test app `com.test.ceps` must be installed for the test user

## Test Coverage

### Endpoints Tested
1. **POST /ceps/write/:app_table** - Create records
2. **GET /ceps/read/:app_table/:id** - Read by ID
3. **GET /ceps/query/:app_table** - Query records
4. **PUT /ceps/update/:app_table/:id** - Update records
5. **DELETE /ceps/delete/:app_table/:id** - Delete records
6. **GET /ceps/ping** - Health check

### Test Scenarios
- ✅ Successful CRUD operations
- ✅ Authentication enforcement (unauthorized access rejection)
- ✅ Error handling (non-existent records)
- ✅ Query with filters
- ✅ Custom field support
- ✅ Record verification after operations

## Troubleshooting

### ⚠️ If You See "500 Error" or "Failed to get app token"

**You forgot to run the server in test mode!**

```bash
# WRONG ❌
npm run dev

# CORRECT ✅
npm run devtest
```

The test suite will show you a big warning if this happens.

### Other Common Issues

**Login failed**: Test user doesn't exist or credentials are wrong in `testUserCreds.json`

**App not found**: Run the app installation step or manually create `com.test.ceps` app for the test user

**Connection refused**: Server is not running at all
