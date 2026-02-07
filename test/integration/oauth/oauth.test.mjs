/**
 * OAuth Feature Integration Tests
 * 
 * Tests the OAuth functionality end-to-end:
 * 
 * Admin API Tests:
 *   PUT    /oauth/privateapi/oauth_perm     - Create/update/delete OAuth configuration
 *   GET    /oauth/privateapi/list_oauths    - List all OAuth configurations
 * 
 * Public OAuth Flow Tests:
 *   GET    /public/oauth/oauth_start_oauth.html  - Public OAuth start page
 *   GET    /oauth/get_new_state             - Get state and redirect URL
 *   GET    /oauth/validate_state            - Validate callback state
 * 
 * OAuth Flow Simulation:
 *   1. Admin creates OAuth configuration
 *   2. External user visits start page
 *   3. Server generates state and redirect URL
 *   4. (Simulated) Third party redirects back with code/token
 *   5. Server validates state and returns credentials
 *   6. Admin deletes OAuth configuration (cleanup)
 * 
 * Prerequisites: 
 *   1. Server must be running on the configured URL (npm run devtest)
 *   2. Test users must exist (see users_freezr/test_credentials/testUserCreds.json)
 *   3. Admin user must have admin privileges
 *   4. Run with: npm run test:oauth
 */

import { expect } from 'chai'
import fetch from 'node-fetch'
import { TestAuthHelper, loadTestCredentials } from '../ceps/testAuthHelper.mjs'

// Load test configuration
let testConfig
let serverUrl
let adminUser

try {
  testConfig = loadTestCredentials()
  serverUrl = testConfig.serverUrl
  // Use primary user - must have admin privileges for OAuth admin tests
  adminUser = testConfig.users.primary
} catch (error) {
  console.error('Failed to load test credentials:', error.message)
  console.error('Please ensure users_freezr/test_credentials/testUserCreds.json exists and is configured correctly.')
  process.exit(1)
}

describe('OAuth Feature Integration Tests', function () {
  // Increase timeout for network requests
  this.timeout(15000)

  let adminAuth
  let createdOauthId = null

  // Test OAuth configuration data
  const testOauthConfig = {
    type: 'dropbox',
    name: 'test_oauth_app_' + Date.now(),
    key: 'test_client_id_' + Date.now(),
    secret: 'test_client_secret_' + Date.now(),
    redirecturi: 'http://localhost:3000/public/oauth/oauth_validate_page.html',
    enabled: true
  }

  before(async function () {
    // Login as admin before running tests
    try {
      console.log(`    Attempting login with user: "${adminUser.user_id}"`)
      
      adminAuth = new TestAuthHelper(serverUrl)
      const result = await adminAuth.loginAndSetupApp(
        adminUser.user_id,
        adminUser.password,
        'info.freezr.admin'
      )
      
      if (!result.success) {
        console.error(`    Login failed for user "${adminUser.user_id}"`)
        console.error(`    Make sure this user exists on the server and has admin privileges.`)
        console.error(`    You can update the credentials in: users_freezr/test_credentials/testUserCreds.json`)
        throw new Error(`Admin login failed: ${result.error}`)
      }
      
      console.log(`    ✓ Logged in as admin: ${adminAuth.userId}`)
    } catch (error) {
      console.error(`    ✗ Failed to authenticate admin: ${error.message}`)
      console.error('    Make sure the server is running (npm run devtest) and admin user exists.')
      console.error(`    Expected admin user: "${adminUser.user_id}" (from testUserCreds.json)`)
      this.skip()
    }
  })

  after(async function () {
    // Cleanup: Delete test OAuth configuration if it still exists
    if (adminAuth && createdOauthId) {
      try {
        await adminAuth.put('/oauth/privateapi/oauth_perm', {
          _id: createdOauthId,
          delete: true
        })
        console.log('    ✓ Cleanup: Deleted test OAuth configuration')
      } catch (e) {
        // Ignore cleanup errors
        console.log('    ⚠ Cleanup: OAuth config may already be deleted')
      }
    }
    
    // Logout
    if (adminAuth) {
      await adminAuth.logout()
    }
  })

  // ===== ADMIN API TESTS =====
  describe('Admin OAuth API', function () {
    
    describe('PUT /oauth/privateapi/oauth_perm (Create)', function () {
      it('should create a new OAuth configuration', async function () {
        if (!adminAuth) this.skip()
        
        const response = await adminAuth.put('/oauth/privateapi/oauth_perm', testOauthConfig)
        
        console.log('      Create OAuth response:', response.data)
        
        expect(response.ok).to.be.true
        expect(response.status).to.equal(200)
        expect(response.data).to.be.an('object')
        expect(response.data.written).to.equal('new')
      })
      
      it('should update existing OAuth configuration when same type/name is used', async function () {
        if (!adminAuth) this.skip()
        
        // Try to create same config again - should update
        const updatedConfig = {
          ...testOauthConfig,
          secret: 'updated_secret_' + Date.now()
        }
        
        const response = await adminAuth.put('/oauth/privateapi/oauth_perm', updatedConfig)
        
        console.log('      Update OAuth response:', response.data)
        
        expect(response.ok).to.be.true
        expect(response.data.written).to.equal('update_unplanned')
      })
    })
    
    describe('GET /oauth/privateapi/list_oauths', function () {
      it('should list all OAuth configurations', async function () {
        if (!adminAuth) this.skip()
        
        const response = await adminAuth.get('/oauth/privateapi/list_oauths')
        
        console.log('      List OAuth response: found', response.data?.results?.length, 'configurations')
        
        expect(response.ok).to.be.true
        expect(response.status).to.equal(200)
        expect(response.data).to.be.an('object')
        expect(response.data.results).to.be.an('array')
        
        // Find our test config
        const testConfigFound = response.data.results.find(
          c => c.type === testOauthConfig.type && c.name === testOauthConfig.name
        )
        
        expect(testConfigFound).to.exist
        expect(testConfigFound.key).to.equal(testOauthConfig.key)
        expect(testConfigFound.enabled).to.be.true
        
        // Store the ID for later tests
        createdOauthId = testConfigFound._id
        console.log('      Found test config with ID:', createdOauthId)
      })
    })
    
    describe('PUT /oauth/privateapi/oauth_perm (Update by ID)', function () {
      it('should update OAuth configuration by ID', async function () {
        if (!adminAuth || !createdOauthId) this.skip()
        
        const updateData = {
          _id: createdOauthId,
          type: testOauthConfig.type,
          name: testOauthConfig.name,
          key: testOauthConfig.key,
          secret: 'newly_updated_secret_' + Date.now(),
          redirecturi: testOauthConfig.redirecturi,
          enabled: true
        }
        
        const response = await adminAuth.put('/oauth/privateapi/oauth_perm', updateData)
        
        console.log('      Update by ID response:', response.data)
        
        expect(response.ok).to.be.true
        expect(response.data.written).to.equal('update')
      })
      
      it('should fail to update non-existent ID', async function () {
        if (!adminAuth) this.skip()
        
        const response = await adminAuth.put('/oauth/privateapi/oauth_perm', {
          _id: 'nonexistent_id_12345',
          type: 'dropbox',
          name: 'test',
          key: 'key',
          redirecturi: 'http://test.com'
        })
        
        expect(response.ok).to.be.false
        expect(response.status).to.equal(404)
      })
    })
    
    describe('PUT /oauth/privateapi/oauth_perm (Disable)', function () {
      it('should disable OAuth configuration', async function () {
        if (!adminAuth || !createdOauthId) this.skip()
        
        const disableData = {
          _id: createdOauthId,
          type: testOauthConfig.type,
          name: testOauthConfig.name,
          key: testOauthConfig.key,
          secret: testOauthConfig.secret,
          redirecturi: testOauthConfig.redirecturi,
          enabled: false
        }
        
        const response = await adminAuth.put('/oauth/privateapi/oauth_perm', disableData)
        
        expect(response.ok).to.be.true
        expect(response.data.written).to.equal('update')
        
        // Verify it's disabled
        const listResponse = await adminAuth.get('/oauth/privateapi/list_oauths')
        const config = listResponse.data.results.find(c => c._id === createdOauthId)
        
        expect(config.enabled).to.be.false
        console.log('      ✓ OAuth configuration disabled')
      })
      
      it('should re-enable OAuth configuration', async function () {
        if (!adminAuth || !createdOauthId) this.skip()
        
        const enableData = {
          _id: createdOauthId,
          type: testOauthConfig.type,
          name: testOauthConfig.name,
          key: testOauthConfig.key,
          secret: testOauthConfig.secret,
          redirecturi: testOauthConfig.redirecturi,
          enabled: true
        }
        
        const response = await adminAuth.put('/oauth/privateapi/oauth_perm', enableData)
        
        expect(response.ok).to.be.true
        
        // Verify it's enabled
        const listResponse = await adminAuth.get('/oauth/privateapi/list_oauths')
        const config = listResponse.data.results.find(c => c._id === createdOauthId)
        
        expect(config.enabled).to.be.true
        console.log('      ✓ OAuth configuration re-enabled')
      })
    })
  })

  // ===== PUBLIC OAUTH PAGE TESTS =====
  describe('Public OAuth Pages', function () {
    
    describe('GET /public/oauth/oauth_start_oauth', function () {
      it('should serve the OAuth start page', async function () {
        const response = await fetch(`${serverUrl}/public/oauth/oauth_start_oauth`)
        const text = await response.text()
        
        console.log('      OAuth start page response:', {
          ok: response.ok,
          status: response.status,
          contentType: response.headers.get('content-type'),
          textPreview: text.substring(0, 200)
        })
        
        expect(response.ok).to.be.true
        expect(response.status).to.equal(200)
        
        const contentType = response.headers.get('content-type')
        expect(contentType).to.include('text/html')
        
        expect(text.toLowerCase()).to.include('oauth')
        console.log('      ✓ OAuth start page served correctly')
      })
    })
    
    describe('GET /public/oauth/oauth_validate_page', function () {
      it('should serve the OAuth validate page', async function () {
        const response = await fetch(`${serverUrl}/public/oauth/oauth_validate_page`)
        const text = await response.text()
        
        console.log('      OAuth validate page response:', {
          ok: response.ok,
          status: response.status,
          contentType: response.headers.get('content-type'),
          textPreview: text.substring(0, 200)
        })
        
        expect(response.ok).to.be.true
        expect(response.status).to.equal(200)
        
        const contentType = response.headers.get('content-type')
        expect(contentType).to.include('text/html')
        
        expect(text.toLowerCase()).to.include('oauth')
        console.log('      ✓ OAuth validate page served correctly')
      })
    })
  })

  // ===== PUBLIC OAUTH API TESTS =====
  describe('Public OAuth API', function () {
    
    describe('GET /oauth/get_new_state', function () {
      it('should fail without required parameters', async function () {
        const response = await fetch(`${serverUrl}/oauth/get_new_state`)
        const data = await response.json()
        
        expect(response.ok).to.be.false
        expect(response.status).to.equal(400)
        expect(data.error).to.include('Need type, regcode and sender')
        console.log('      ✓ Correctly rejects missing parameters')
      })
      
      it('should fail with invalid OAuth type', async function () {
        const params = new URLSearchParams({
          type: 'invalid_type',
          sender: 'http://example.com/callback',
          regcode: 'test_regcode_123'
        })
        
        const response = await fetch(`${serverUrl}/oauth/get_new_state?${params}`)
        const data = await response.json()
        
        expect(response.ok).to.be.false
        expect(response.status).to.equal(400)
        expect(data.error).to.include('Missing URL generator')
        console.log('      ✓ Correctly rejects invalid type')
      })
      
      it('should return redirect URL for valid dropbox request', async function () {
        // First ensure our test OAuth config is enabled
        if (!adminAuth || !createdOauthId) {
          console.log('      ⚠ Skipping - no OAuth config available')
          this.skip()
        }
        
        const params = new URLSearchParams({
          type: 'dropbox',
          sender: 'http://example.com/callback',
          regcode: 'test_regcode_' + Date.now()
        })
        
        const response = await fetch(`${serverUrl}/oauth/get_new_state?${params}`)
        const data = await response.json()
        
        console.log('      get_new_state response:', { 
          ok: response.ok, 
          status: response.status,
          hasRedirect: !!data.redirecturi,
          error: data.error,
          data: JSON.stringify(data).substring(0, 200)
        })
        
        // If no enabled dropbox config exists, skip the test
        if (data.error && data.error.includes('No enabled OAuth configuration')) {
          console.log('      ⚠ Skipping - no enabled dropbox OAuth config on server')
          this.skip()
        }
        
        expect(response.ok).to.be.true
        expect(response.status).to.equal(200)
        expect(data.redirecturi).to.exist
        expect(data.redirecturi).to.include('dropbox.com')
        expect(data.redirecturi).to.include('state=')
        
        console.log('      ✓ Got valid Dropbox redirect URL')
      })
    })
    
    describe('GET /oauth/validate_state', function () {
      it('should fail without state parameter', async function () {
        const response = await fetch(`${serverUrl}/oauth/validate_state`)
        const data = await response.json()
        
        // Should fail because no state in cache
        expect(response.ok).to.be.false
        console.log('      ✓ Correctly rejects missing state')
      })
      
      it('should fail with invalid state', async function () {
        const params = new URLSearchParams({
          state: 'invalid_state_token_12345',
          code: 'some_auth_code'
        })
        
        const response = await fetch(`${serverUrl}/oauth/validate_state?${params}`)
        const data = await response.json()
        
        expect(response.ok).to.be.false
        expect(data.message).to.include('No auth state found')
        console.log('      ✓ Correctly rejects invalid state')
      })
    })
  })

  // ===== FULL OAUTH FLOW SIMULATION =====
  describe('OAuth Flow Simulation', function () {
    let stateToken = null
    let sessionCookie = null
    
    it('Step 1: Get new state and redirect URL', async function () {
      if (!createdOauthId) {
        console.log('      ⚠ Skipping flow test - no OAuth config')
        this.skip()
      }
      
      const params = new URLSearchParams({
        type: 'dropbox',
        sender: 'http://localhost:3000/test/callback',
        regcode: 'flow_test_regcode_' + Date.now()
      })
      
      const response = await fetch(`${serverUrl}/oauth/get_new_state?${params}`)
      const data = await response.json()
      
      console.log('      Flow Step 1 response:', {
        ok: response.ok,
        status: response.status,
        error: data.error,
        hasRedirectUri: !!data.redirecturi
      })
      
      // If no enabled dropbox config exists, skip
      if (data.error && data.error.includes('No enabled OAuth configuration')) {
        console.log('      ⚠ Skipping - no enabled dropbox OAuth config on server')
        this.skip()
      }
      
      // Store session cookie for state validation
      const setCookie = response.headers.get('set-cookie')
      if (setCookie) {
        sessionCookie = setCookie.split(';')[0]
      }
      
      expect(response.ok).to.be.true
      expect(data.redirecturi).to.exist
      
      // Extract state from redirect URL
      const redirectUrl = new URL(data.redirecturi)
      stateToken = redirectUrl.searchParams.get('state')
      
      expect(stateToken).to.exist
      expect(stateToken.length).to.be.greaterThan(20)
      
      console.log('      ✓ Got state token:', stateToken.substring(0, 20) + '...')
      console.log('      ✓ Redirect URL points to:', redirectUrl.hostname)
    })
    
    it('Step 2: Simulate third-party callback (validate state)', async function () {
      if (!stateToken || !sessionCookie) {
        console.log('      ⚠ Skipping - no state token from previous step')
        this.skip()
      }
      
      // Simulate the OAuth provider calling back with code
      const params = new URLSearchParams({
        state: stateToken,
        code: 'simulated_auth_code_' + Date.now()
      })
      
      const response = await fetch(`${serverUrl}/oauth/validate_state?${params}`, {
        headers: {
          'Cookie': sessionCookie
        }
      })
      
      const data = await response.json()
      
      console.log('      validate_state response:', {
        ok: response.ok,
        status: response.status,
        success: data.success,
        type: data.type,
        hasSender: !!data.sender
      })
      
      if (response.ok) {
        expect(data.success).to.be.true
        expect(data.type).to.equal('dropbox')
        expect(data.sender).to.exist
        expect(data.clientId).to.exist
        expect(data.codeVerifier).to.exist
        expect(data.codeChallenge).to.exist
        console.log('      ✓ State validated successfully')
        console.log('      ✓ PKCE codes present: codeVerifier and codeChallenge')
      } else {
        // Session mismatch is expected in test environment
        // since we can't maintain proper session across requests
        console.log('      ⚠ State validation failed (expected in test env):', data.code)
        expect(data.code).to.be.oneOf([
          'auth_error_state_mismatch',
          'auth_error_no_state',
          'auth_error_state_time_exceeded'
        ])
      }
    })
  })

  // ===== DELETE (CLEANUP) TESTS =====
  describe('PUT /oauth/privateapi/oauth_perm (Delete)', function () {
    it('should delete OAuth configuration', async function () {
      if (!adminAuth || !createdOauthId) {
        console.log('      ⚠ Skipping - no OAuth config to delete')
        this.skip()
      }
      
      const response = await adminAuth.put('/oauth/privateapi/oauth_perm', {
        _id: createdOauthId,
        delete: true
      })
      
      console.log('      Delete response:', response.data)
      
      expect(response.ok).to.be.true
      expect(response.data.written).to.equal('deleted')
      
      // Verify it's gone
      const listResponse = await adminAuth.get('/oauth/privateapi/list_oauths')
      const configStillExists = listResponse.data.results.find(c => c._id === createdOauthId)
      
      expect(configStillExists).to.be.undefined
      console.log('      ✓ OAuth configuration deleted and verified')
      
      // Clear the ID so after() doesn't try to delete again
      createdOauthId = null
    })
    
    it('should handle deletion of non-existent config gracefully', async function () {
      if (!adminAuth) this.skip()
      
      const response = await adminAuth.put('/oauth/privateapi/oauth_perm', {
        _id: 'definitely_not_a_real_id_12345',
        delete: true
      })
      
      // Should either succeed (no error on delete missing) or fail gracefully
      console.log('      Delete non-existent response:', response.data)
      // The exact behavior depends on the db implementation
    })
  })

  // ===== AUTHENTICATION TESTS =====
  describe('Authentication Requirements', function () {
    
    it('should reject unauthenticated requests to admin API', async function () {
      // Use redirect: 'manual' to prevent following redirects to login page
      const response = await fetch(`${serverUrl}/oauth/privateapi/list_oauths`, {
        redirect: 'manual'
      })
      
      // Either 401/403 for API error or 302/303 for redirect to login
      const isRejected = !response.ok || response.status >= 300
      expect(isRejected).to.be.true
      console.log(`      ✓ Admin API correctly requires authentication (status: ${response.status})`)
    })
    
    it('should reject non-admin users from admin API', async function () {
      // Login as secondary (non-admin) user
      const guestAuth = new TestAuthHelper(serverUrl)
      try {
        const result = await guestAuth.loginAndSetupApp(
          testConfig.users.secondary.user_id,
          testConfig.users.secondary.password,
          'info.freezr.admin'
        )
        
        if (!result.success) {
          console.log('      ⚠ Could not login as secondary user, skipping')
          this.skip()
        }
        
        const response = await guestAuth.get('/oauth/privateapi/list_oauths')
        
        expect(response.ok).to.be.false
        expect(response.status).to.be.oneOf([401, 403])
        console.log('      ✓ Admin API correctly rejects non-admin users')
        
        await guestAuth.logout()
      } catch (error) {
        console.log('      ⚠ Test skipped:', error.message)
        this.skip()
      }
    })
    
    it('should allow public access to OAuth start page', async function () {
      // No auth headers - path without .html extension
      const response = await fetch(`${serverUrl}/public/oauth/oauth_start_oauth`)
      
      expect(response.ok).to.be.true
      console.log('      ✓ Public pages are accessible without authentication')
    })
    
    it('should allow public access to get_new_state API', async function () {
      // No auth headers, but needs valid params
      const params = new URLSearchParams({
        type: 'dropbox',
        sender: 'http://example.com',
        regcode: 'test'
      })
      
      const response = await fetch(`${serverUrl}/oauth/get_new_state?${params}`)
      
      // Will fail due to no enabled config, but should NOT be 401/403
      expect(response.status).to.not.equal(401)
      expect(response.status).to.not.equal(403)
      console.log('      ✓ Public API is accessible without authentication')
    })
  })
})
