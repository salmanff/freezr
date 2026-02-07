# OAuth Integration Tests

Comprehensive tests for the OAuth feature in freezr.

## Running the Tests

```bash
# Start the server in test mode first
npm run devtest

# In another terminal, run the OAuth tests
npm run test:oauth
```

## Test Coverage

### Admin API Tests

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/oauth/privateapi/oauth_perm` | PUT | Create new OAuth configuration |
| `/oauth/privateapi/oauth_perm` | PUT | Update existing OAuth configuration |
| `/oauth/privateapi/oauth_perm` | PUT | Delete OAuth configuration (with `delete: true`) |
| `/oauth/privateapi/list_oauths` | GET | List all OAuth configurations |

### Public OAuth Flow Tests

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/public/oauth/oauth_start_oauth.html` | GET | Serve OAuth start page |
| `/public/oauth/oauth_validate_page.html` | GET | Serve OAuth validate page |
| `/oauth/get_new_state` | GET | Get state token and redirect URL |
| `/oauth/validate_state` | GET | Validate callback state and return credentials |

### OAuth Flow Simulation

The tests simulate the full OAuth flow:

1. **Admin creates OAuth configuration** - Sets up a Dropbox OAuth config
2. **Get new state** - Simulates external app requesting OAuth authentication
3. **Third party callback** - Simulates Dropbox redirecting back with auth code
4. **State validation** - Validates the callback and returns credentials
5. **Cleanup** - Deletes the test OAuth configuration

### Authentication Tests

- Verifies admin API requires authentication
- Verifies admin API rejects non-admin users
- Verifies public pages are accessible without auth
- Verifies public API is accessible without auth

## Prerequisites

1. Server must be running in test mode: `npm run devtest`
2. Test users must exist (see `users_freezr/test_credentials/testUserCreds.json`)
3. Admin user must have admin privileges

## Test User Configuration

The tests use credentials from `users_freezr/test_credentials/testUserCreds.json`:

```json
{
  "users": {
    "admin": {
      "user_id": "testadmin",
      "password": "testadminpass"
    }
  }
}
```

## Notes

- The full OAuth flow simulation may show "state mismatch" errors in the test environment since we can't maintain proper session cookies across test requests. This is expected behavior.
- The tests create a temporary OAuth configuration and clean it up after completion.
- Each test run uses unique identifiers to avoid conflicts.
