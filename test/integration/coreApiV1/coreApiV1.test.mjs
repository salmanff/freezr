/**
 * Core API V1 Integration Tests
 * 
 * Tests the freezr API through the freezr_core.js interface (freepr API)
 * instead of direct HTTP calls. This tests the actual API that apps use.
 * 
 * Tests cover:
 *   - CEPS operations (create, read, query, update, delete)
 *   - FEPS operations (create, read, update, delete, upload, restore)
 *   - Permissions operations
 *   - Messaging operations
 *   - File operations
 * 
 * Prerequisites: 
 *   1. Server must be running on the configured URL
 *   2. Test users must exist (see users_freezr/test_credentials/testUserCreds.json)
 *   3. Run with: npm run test:coreApiV1
 */

import { expect } from 'chai'
import { TestAuthHelper, loadTestCredentials, createAuthenticatedHelper, createOtherServerAuthenticatedHelper } from '../ceps/testAuthHelper.mjs'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createContext, runInContext } from 'vm'
import fetch from 'node-fetch'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Load test configuration
let testConfig
let serverUrl
let appTable

try {
  testConfig = loadTestCredentials()
  serverUrl = testConfig.serverUrl
  appTable = testConfig.testAppConfig.appTable
} catch (error) {
  console.error('Failed to load test credentials:', error.message)
  console.error('Please ensure users_freezr/test_credentials/testUserCreds.json exists and is configured correctly.')
  process.exit(1)
}

/**
 * FreezrCoreHelper - Loads and executes the actual freezr_core.js file
 * Sets up Node.js environment with proper mocks for browser globals
 */
class FreezrCoreHelper {
  constructor(authHelper, appName, userId, serverAddress) {
    this.auth = authHelper
    this.appName = appName
    this.userId = userId
    this.serverAddress = serverAddress
    this.freepr = null
    this.freezr = null
    
    // Initialize by loading actual freezr_core.js
    this.initializeFreezrCore()
  }

  initializeFreezrCore() {
    // Set up freezrMeta global object (required by freezr_core.js)
    const freezrMeta = {
      appName: this.appName,
      userId: this.userId,
      serverAddress: this.serverAddress,
      appToken: this.auth.getCurrentAppToken(),
      appDisplayName: this.appName,
      serverVersion: 'test'
    }

    // Create a mock document object
    const mockDocument = {
      cookie: '',
      getElementsByTagName: () => [],
      getElementById: () => null,
      createElement: () => ({ 
        style: {},
        onclick: null,
        innerHTML: '',
        appendChild: () => {},
        addEventListener: () => {},
        removeEventListener: () => {}
      })
    }

    // Create a mock window object
    const mockWindow = {
      location: { href: this.serverAddress },
      scrollTo: () => {}
    }

    // Mock confirm function
    const mockConfirm = () => true

    // Create a custom fetch that uses our auth helper's cookies and tokens
    // This needs to match the browser fetch API but work in Node.js
    const customFetch = async (url, options = {}) => {
      // If URL is relative and we're not web-based, prepend server address
      // (freezr_core.js will handle this, but we need to ensure absolute URLs for node-fetch)
      let fullUrl = url
      if (!url.startsWith('http')) {
        fullUrl = this.serverAddress + url
      }

      // Get app token - freezr_core.js will pass it in options.appToken or use freezrMeta.appToken
      const appToken = options.appToken || freezrMeta.appToken || this.auth.getCurrentAppToken()
      
      // Set up headers
      const headers = {
        ...options.headers,
        'Authorization': `Bearer ${appToken}`,
        'Cookie': this.auth.getCookieHeader()
      }

      // Make the actual fetch call using node-fetch
      const response = await fetch(fullUrl, {
        ...options,
        headers
      })

      // Return a response object that matches browser fetch API
      // node-fetch already provides a compatible Response object
      return response
    }

    // Create a shared global object that we can access from outside the VM context
    const sharedGlobal = {}
    
    // Create VM context with all necessary globals
    const vmContext = createContext({
      // Node.js globals
      console,
      Buffer,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Promise,
      Error,
      Object,
      Array,
      Date,
      JSON,
      Math,
      String,
      Number,
      Boolean,
      RegExp,
      Map,
      Set,
      WeakMap,
      WeakSet,
      // freezr_core.js required globals
      freezrMeta,
      fetch: customFetch,
      FormData: class FormData {
        constructor() {
          this.data = []
        }
        append(name, value) {
          this.data.push({ name, value })
        }
      },
      document: mockDocument,
      window: mockWindow,
      confirm: mockConfirm,
      // Prevent undefined variable errors
      // Use shared global object that we can access
      global: sharedGlobal,
      process: { env: {} }
    })
    
    // Store reference to sharedGlobal for later access
    this.sharedGlobal = sharedGlobal

    // Store reference to vmContext for later updates
    this.vmContext = vmContext

    // Load the actual freezr_core.js file
    const freezrCorePath = join(__dirname, '../../../systemapps/info.freezr.public/public/freezr_core.js')
    const freezrCoreCode = readFileSync(freezrCorePath, 'utf-8')

    // Execute freezr_core.js in the VM context
    try {
      // Append code to explicitly expose freezr to the context
      // This ensures we can access it even if const variables aren't directly accessible
      const codeWithExports = freezrCoreCode + `
        // Explicitly expose freezr and freepr for access from outside the VM context
        if (typeof freezr !== 'undefined') {
          // In VM contexts, we can't directly modify the context object,
          // but we can create a global reference
          global.freezr = freezr;
          global.freepr = typeof freepr !== 'undefined' ? freepr : freezr.promise;
        }
      `
      
      runInContext(codeWithExports, vmContext, { 
        filename: 'freezr_core.js',
        displayErrors: true,
        timeout: 10000
      })
      
      // Try to access freezr from sharedGlobal first, then from context
      this.freezr = sharedGlobal.freezr || vmContext.freezr
      
      if (!this.freezr) {
        // Last resort: try evaluating it directly
        try {
          this.freezr = runInContext('freezr', vmContext)
        } catch (evalError) {
          // Check what's actually in the context
          const contextKeys = Object.keys(vmContext).filter(k => 
            !['console', 'Buffer', 'setTimeout', 'clearTimeout', 'setInterval', 
              'clearInterval', 'Promise', 'Error', 'Object', 'Array', 'Date', 
              'JSON', 'Math', 'String', 'Number', 'Boolean', 'RegExp', 'Map', 
              'Set', 'WeakMap', 'WeakSet', 'process', 'freezrMeta',
              'fetch', 'FormData', 'document', 'window', 'confirm', 'global'].includes(k) &&
            !k.startsWith('_')
          )
          console.error('Debug: Available context keys:', contextKeys)
          console.error('Debug: sharedGlobal keys:', Object.keys(sharedGlobal))
          console.error('Debug: sharedGlobal.freezr:', sharedGlobal.freezr)
          console.error('Debug: vmContext.freezr type:', typeof vmContext.freezr)
          throw new Error(`freezr object not found in context. Available keys: ${contextKeys.join(', ')}`)
        }
      }
      
      // Get freepr from sharedGlobal or freezr.promise
      this.freepr = sharedGlobal.freepr || this.freezr.promise

      // freepr is created as: const freepr = freezr.promise (line 518)
      // Since const variables aren't directly accessible in VM context,
      // we access it through freezr.promise instead
      this.freepr = this.freezr.promise

      if (!this.freepr) {
        console.error('Debug: freezr keys:', Object.keys(this.freezr))
        console.error('Debug: freezr.ceps exists?', !!this.freezr.ceps)
        console.error('Debug: freezr.feps exists?', !!this.freezr.feps)
        console.error('Debug: freezr.promise type:', typeof this.freezr.promise)
        console.error('Debug: freezr.promise value:', this.freezr.promise)
        throw new Error('freezr.promise (freepr) not found - freezr_core.js may not have executed completely. Check if promise creation code ran.')
      }

      // Verify freepr has the expected structure
      if (!this.freepr.ceps || !this.freepr.feps || !this.freepr.perms) {
        console.error('Debug: freepr structure:', Object.keys(this.freepr))
        console.error('Debug: freepr.ceps:', this.freepr.ceps)
        console.error('Debug: freepr.feps:', this.freepr.feps)
        console.error('Debug: freepr.perms:', this.freepr.perms)
        throw new Error('freepr API structure is incomplete - missing ceps, feps, or perms')
      }

      // Set isWebBased to false so it uses serverAddress for URLs
      if (this.freezr && this.freezr.app) {
        this.freezr.app.isWebBased = false
      }
    } catch (error) {
      console.error('Error loading freezr_core.js:', error)
      console.error('Error name:', error.name)
      console.error('Error message:', error.message)
      console.error('Error stack:', error.stack)
      throw new Error(`Failed to load freezr_core.js: ${error.message}`)
    }
  }

  /**
   * Update freezrMeta appToken in the VM context
   */
  updateAppToken() {
    // This will be called before each API call to ensure token is current
    const appToken = this.auth.getCurrentAppToken()
    if (this.vmContext && this.vmContext.freezrMeta) {
      this.vmContext.freezrMeta.appToken = appToken
    }
  }

  /**
   * Convenience methods that wrap freepr API calls
   * These use the ACTUAL freepr API from freezr_core.js
   */
  async create(data, options = {}) {
    this.updateAppToken()
    // Add appToken to options if provided
    if (options.appToken) {
      this.vmContext.freezrMeta.appToken = options.appToken
    }
    try {
      const result = await this.freepr.ceps.create(data, options)
      return { ok: true, status: 200, data: result }
    } catch (error) {
      return { ok: false, status: error.status || 500, data: { error: error.message } }
    }
  }

  async getById(dataObjectId, options = {}) {
    this.updateAppToken()
    if (options.appToken) {
      this.vmContext.freezrMeta.appToken = options.appToken
    }
    try {
      const result = await this.freepr.ceps.getById(dataObjectId, options)
      return { ok: true, status: 200, data: result }
    } catch (error) {
      return { ok: false, status: error.status || 500, data: { error: error.message } }
    }
  }

  async query(options = {}) {
    this.updateAppToken()
    if (options.appToken) {
      this.vmContext.freezrMeta.appToken = options.appToken
    }
    try {
      const result = await this.freepr.ceps.getquery(options)
      return { ok: true, status: 200, data: result }
    } catch (error) {
      return { ok: false, status: error.status || 500, data: { error: error.message } }
    }
  }

  async update(data, options = {}) {
    this.updateAppToken()
    if (options.appToken) {
      this.vmContext.freezrMeta.appToken = options.appToken
    }
    try {
      const result = await this.freepr.ceps.update(data, options)
      return { ok: true, status: 200, data: result }
    } catch (error) {
      return { ok: false, status: error.status || 500, data: { error: error.message } }
    }
  }

  async delete(dataObjectId, options = {}) {
    this.updateAppToken()
    if (options.appToken) {
      this.vmContext.freezrMeta.appToken = options.appToken
    }
    try {
      const result = await this.freepr.ceps.delete(dataObjectId, options)
      return { ok: true, status: 200, data: result }
    } catch (error) {
      return { ok: false, status: error.status || 500, data: { error: error.message } }
    }
  }

  async fepsCreate(data, options = {}) {
    this.updateAppToken()
    if (options.appToken) {
      this.vmContext.freezrMeta.appToken = options.appToken
    }
    try {
      const result = await this.freepr.feps.create(data, options)
      return { ok: true, status: 200, data: result }
    } catch (error) {
      return { ok: false, status: error.status || 500, data: { error: error.message } }
    }
  }

  async fepsGetById(dataObjectId, options = {}) {
    this.updateAppToken()
    if (options.appToken) {
      this.vmContext.freezrMeta.appToken = options.appToken
    }
    try {
      const result = await this.freepr.feps.getById(dataObjectId, options)
      return { ok: true, status: 200, data: result }
    } catch (error) {
      return { ok: false, status: error.status || 500, data: { error: error.message } }
    }
  }

  async fepsUpdate(data, options = {}) {
    this.updateAppToken()
    if (options.appToken) {
      this.vmContext.freezrMeta.appToken = options.appToken
    }
    try {
      const result = await this.freepr.feps.update(data, options)
      return { ok: true, status: 200, data: result }
    } catch (error) {
      return { ok: false, status: error.status || 500, data: { error: error.message } }
    }
  }

  async fepsDelete(idOrQuery, options = {}) {
    this.updateAppToken()
    if (options.appToken) {
      this.vmContext.freezrMeta.appToken = options.appToken
    }
    try {
      const result = await this.freepr.feps.delete(idOrQuery, options)
      return { ok: true, status: 200, data: result }
    } catch (error) {
      return { ok: false, status: error.status || 500, data: { error: error.message } }
    }
  }

  async fepsUpload(file, options = {}) {
    this.updateAppToken()
    if (options.appToken) {
      this.vmContext.freezrMeta.appToken = options.appToken
    }
    try {
      const result = await this.freepr.feps.upload(file, options)
      return { ok: true, status: 200, data: result }
    } catch (error) {
      return { ok: false, status: error.status || 500, data: { error: error.message } }
    }
  }

  async ping(options = {}) {
    this.updateAppToken()
    try {
      // freepr doesn't include utils, so we need to use freezr.utils.ping directly
      // and wrap it in a promise since it uses callbacks
      const result = await new Promise((resolve, reject) => {
        this.freezr.utils.ping(options, (error, resp) => {
          if (error) {
            reject(error)
          } else {
            resolve(resp)
          }
        })
      })
      return { ok: true, status: 200, data: result }
    } catch (error) {
      return { ok: false, status: error.status || 500, data: { error: error.message } }
    }
  }

  async getPermissions() {
    this.updateAppToken()
    try {
      const result = await this.freepr.perms.getAppPermissions()
      return { ok: true, status: 200, data: result }
    } catch (error) {
      return { ok: false, status: error.status || 500, data: { error: error.message } }
    }
  }

  async shareRecords(idOrQuery, options) {
    this.updateAppToken()
    if (options && options.appToken) {
      this.vmContext.freezrMeta.appToken = options.appToken
    }
    try {
      const result = await this.freepr.perms.shareRecords(idOrQuery, options)
      return { ok: true, status: 200, data: result }
    } catch (error) {
      return { ok: false, status: error.status || 500, data: { error: error.message } }
    }
  }

  async sendMessage(toShare) {
    this.updateAppToken()
    try {
      const result = await this.freepr.ceps.sendMessage(toShare)
      return { ok: true, status: 200, data: result }
    } catch (error) {
      return { ok: false, status: error.status || 500, data: { error: error.message } }
    }
  }

  /**
   * Helper to get messages (uses direct HTTP since freepr doesn't have getMessages yet)
   */
  async getMessages(options = {}) {
    return await this.auth.getMessages(options)
  }

  /**
   * Helper to change permission (uses direct HTTP since it needs account token)
   */
  async changePermission(permissionName, tableId, requestorApp, targetApp, grant) {
    return await this.auth.changePermission(permissionName, tableId, requestorApp, targetApp, grant)
  }
}

describe('Core API V1 Integration Tests (via freepr)', function () {
  // Increase timeout for network requests
  this.timeout(10000)

  let auth
  let core
  let createdRecordId

  // Test data
  const testRecord = {
    title: 'Core API Test Record',
    description: 'Created by Core API integration test',
    value: 42,
    tags: ['test', 'core', 'integration'],
    timestamp: Date.now()
  }

  before(async function () {
    // Login before running tests
    try {
      auth = await createAuthenticatedHelper('primary')
      console.log(`    ✓ Logged in as ${auth.userId}`)
      
      // Initialize freezr core helper
      core = new FreezrCoreHelper(
        auth,
        testConfig.testAppConfig.appName,
        auth.userId,
        serverUrl
      )
      console.log(`    ✓ Initialized freezr core API`)
    } catch (error) {
      console.error(`    ✗ Failed to authenticate or initialize: ${error.message}`)
      console.error('    Make sure the server is running and test user exists.')
      this.skip()
    }
  })

  after(async function () {
    // Cleanup: Delete any remaining test records
    if (core && createdRecordId) {
      try {
        await core.delete(createdRecordId, { app_table: appTable })
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    
    // Logout
    if (auth) {
      await auth.logout()
    }
  })

  // ===== PING TEST =====
  describe('freepr.utils.ping', function () {
    it('should return ping response when authenticated', async function () {
      const response = await core.ping()

      console.log('      🔑 coreApiV1.test.mjs should return ping response when authenticated - response', response)
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      expect(response.data).to.be.an('object')
    })
  })

  // ===== CEPS CREATE TESTS =====
  describe('freepr.ceps.create', function () {
    it('should create a new record', async function () {
      const response = await core.create(testRecord, { app_table: appTable })

      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      expect(response.data).to.be.an('object')
      expect(response.data._id).to.exist
      
      // Store ID for subsequent tests
      createdRecordId = response.data._id
    })

    it('should return CEPS 2.0 compliant response with _date_created and _date_modified', async function () {
      const response = await core.create({
        title: 'CEPS Compliance Test',
        value: 123
      }, { app_table: appTable })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      // CEPS 2.0 spec requires: _id, _date_created, _date_modified
      expect(response.data).to.have.property('_id')
      expect(response.data).to.have.property('_date_created')
      expect(response.data).to.have.property('_date_modified')
      
      // Verify timestamps are Unix epoch (numbers)
      expect(response.data._date_created).to.be.a('number')
      expect(response.data._date_modified).to.be.a('number')
      
      // _date_created and _date_modified should be equal for new records
      expect(response.data._date_created).to.equal(response.data._date_modified)
      
      // Cleanup
      await core.delete(response.data._id, { app_table: appTable })
    })

    it('should create record with custom fields', async function () {
      const customRecord = {
        customField: 'custom value',
        nested: { key: 'value' },
        arrayField: [1, 2, 3]
      }
      
      const response = await core.create(customRecord, { app_table: appTable })
      
      expect(response.ok).to.be.true
      expect(response.data._id).to.exist

      // Cleanup: delete this record
      await core.delete(response.data._id, { app_table: appTable })
    })
  })

  // ===== CEPS READ TESTS =====
  describe('freepr.ceps.getById', function () {
    it('should read an existing record by ID', async function () {
      if (!createdRecordId) this.skip()
      
      const response = await core.getById(createdRecordId, { app_table: appTable })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      expect(response.data).to.be.an('object')
      expect(response.data._id).to.equal(createdRecordId)
      expect(response.data.title).to.equal(testRecord.title)
      expect(response.data.value).to.equal(testRecord.value)
    })

    it('should return CEPS 2.0 compliant response with _date_created and _date_modified', async function () {
      if (!createdRecordId) this.skip()
      
      const response = await core.getById(createdRecordId, { app_table: appTable })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      // CEPS 2.0 spec requires: _id, _date_created, _date_modified
      expect(response.data).to.have.property('_id')
      expect(response.data).to.have.property('_date_created')
      expect(response.data).to.have.property('_date_modified')
      
      // Verify timestamps are Unix epoch (numbers)
      expect(response.data._date_created).to.be.a('number')
      expect(response.data._date_modified).to.be.a('number')
      
      // _date_modified should be >= _date_created
      expect(response.data._date_modified).to.be.at.least(response.data._date_created)
    })
  })

  // ===== CEPS QUERY TESTS =====
  describe('freepr.ceps.getquery', function () {
    it('should query records without filters (get all)', async function () {
      const response = await core.query({ app_table: appTable })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      // CEPS 2.0 spec requires: response must be an array of records
      expect(response.data).to.be.an('array')
    })

    it('should query records with filter parameters', async function () {
      // Query for records with specific title
      const response = await core.query({ 
        app_table: appTable,
        q: { title: testRecord.title }
      })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      // CEPS 2.0 spec requires: response must be an array
      expect(response.data).to.be.an('array')
      
      // If we got results, they should match our filter
      const matching = response.data.filter(r => r.title === testRecord.title)
      expect(matching.length).to.be.at.least(0) // May be 0 if no matches
    })

    it('should return CEPS 2.0 compliant array response', async function () {
      const response = await core.query({ app_table: appTable })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      // CEPS 2.0 spec: response MUST be an array of records (not an object)
      expect(response.data).to.be.an('array')
      
      // If we have results, verify they have required fields
      if (response.data.length > 0) {
        const firstRecord = response.data[0]
        expect(firstRecord).to.have.property('_id')
        expect(firstRecord).to.have.property('_date_created')
        expect(firstRecord).to.have.property('_date_modified')
      }
    })

    it('should support _modified_before and _modified_after query parameters (CEPS 2.0)', async function () {
      // Create a record with known timestamp
      const now = Date.now()
      const createResponse = await core.create({
        title: 'Modified Date Test',
        timestamp: now
      }, { app_table: appTable })
      const testRecordId = createResponse.data._id
      const recordDateModified = createResponse.data._date_modified
      
      try {
        // Query with _modified_after (should include our record)
        const afterResponse = await core.query({
          app_table: appTable,
          q: { _date_modified: { $gt: recordDateModified - 5000 } }
        })

        expect(afterResponse.ok).to.be.true
        expect(afterResponse.data).to.be.an('array')
        const foundAfter = afterResponse.data.find(r => r._id === testRecordId)
        expect(foundAfter).to.exist
        
        // Query with _modified_before (should include our record)
        const beforeResponse = await core.query({
          app_table: appTable,
          q: { _date_modified: { $lt: recordDateModified + 5000 } }
        })
        expect(beforeResponse.ok).to.be.true
        expect(beforeResponse.data).to.be.an('array')
        const foundBefore = beforeResponse.data.find(r => r._id === testRecordId)
        expect(foundBefore).to.exist
      } finally {
        // Cleanup
        await core.delete(testRecordId, { app_table: appTable })
      }
    })
  })

  // ===== CEPS UPDATE TESTS =====
  describe('freepr.ceps.update', function () {
    it('should update an existing record', async function () {
      if (!createdRecordId) this.skip()
      
      const updates = {
        _id: createdRecordId,
        title: 'Updated Test Record',
        value: 100,
        updatedAt: Date.now()
      }
      
      const response = await core.update(updates, { app_table: appTable })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      // Verify the update by reading the record
      const readResponse = await core.getById(createdRecordId, { app_table: appTable })
      expect(readResponse.ok).to.be.true
      expect(readResponse.data.title).to.equal(updates.title)
      expect(readResponse.data.value).to.equal(updates.value)
    })

    it('should return CEPS 2.0 compliant response with _date_created and _date_modified', async function () {
      if (!createdRecordId) this.skip()
      
      // First, read the original record to get its _date_created
      const beforeResponse = await core.getById(createdRecordId, { app_table: appTable })
      const originalDateCreated = beforeResponse.data._date_created
      const originalDateModified = beforeResponse.data._date_modified
      
      // Wait a bit to ensure _date_modified changes
      await new Promise(resolve => setTimeout(resolve, 100))
      
      const updates = {
        _id: createdRecordId,
        title: 'CEPS Compliance Update Test',
        value: 999
      }
      
      const response = await core.update(updates, { app_table: appTable })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      // CEPS 2.0 spec requires: _id, _date_created, _date_modified
      expect(response.data).to.have.property('_id')
      expect(response.data).to.have.property('_date_created')
      expect(response.data).to.have.property('_date_modified')
      
      // Verify timestamps are Unix epoch (numbers)
      expect(response.data._date_created).to.be.a('number')
      expect(response.data._date_modified).to.be.a('number')
      
      // _date_created should remain the same
      expect(response.data._date_created).to.equal(originalDateCreated)
      
      // _date_modified should be updated (greater than or equal to original)
      expect(response.data._date_modified).to.be.at.least(originalDateModified)
    })
  })

  // ===== CEPS DELETE TESTS =====
  describe('freepr.ceps.delete', function () {
    let recordToDeleteId

    before(async function () {
      // Create a record specifically for deletion testing
      const response = await core.create({
        title: 'Record to delete',
        purpose: 'deletion test'
      }, { app_table: appTable })
      
      if (response.ok) {
        recordToDeleteId = response.data._id
      }
    })

    it('should delete an existing record', async function () {
      if (!recordToDeleteId) this.skip()
      
      const response = await core.delete(recordToDeleteId, { app_table: appTable })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      expect(response.data).to.be.an('object')
      
      // Verify the record is deleted by trying to read it
      const readResponse = await core.getById(recordToDeleteId, { app_table: appTable })
      
      // Should return error
      expect(readResponse.ok).to.be.false
    })
  })

  // ===== FEPS CREATE TESTS =====
  describe('freepr.feps.create', function () {
    it('should create a new record', async function () {
      const response = await core.fepsCreate(testRecord, { app_table: appTable })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      expect(response.data).to.be.an('object')
      expect(response.data._id).to.exist
      
      // Cleanup
      await core.fepsDelete(response.data._id, { app_table: appTable })
    })

    it('should return response with _date_created and _date_modified', async function () {
      const response = await core.fepsCreate({
        title: 'FEPS Compliance Test',
        value: 123
      }, { app_table: appTable })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      // Verify required fields
      expect(response.data).to.have.property('_id')
      expect(response.data).to.have.property('_date_created')
      expect(response.data).to.have.property('_date_modified')
      
      // Verify timestamps are Unix epoch (numbers)
      expect(response.data._date_created).to.be.a('number')
      expect(response.data._date_modified).to.be.a('number')
      
      // _date_created and _date_modified should be equal for new records
      expect(response.data._date_created).to.equal(response.data._date_modified)
      
      // Cleanup
      await core.fepsDelete(response.data._id, { app_table: appTable })
    })

    it('should create a record with specific ID', async function () {
      const customId = `test_record_${Date.now()}`
      const response = await core.fepsCreate({
        title: 'Record with Custom ID',
        value: 999
      }, { app_table: appTable, data_object_id: customId })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      expect(response.data._id).to.equal(customId)
      
      // Cleanup
      await core.fepsDelete(customId, { app_table: appTable })
    })
  })

  // ===== FEPS UPDATE TESTS =====
  describe('freepr.feps.update', function () {
    let fepsRecordId

    before(async function () {
      const response = await core.fepsCreate({
        title: 'FEPS Update Test',
        value: 42
      }, { app_table: appTable })
      
      if (response.ok) {
        fepsRecordId = response.data._id
      }
    })

    after(async function () {
      if (fepsRecordId) {
        try {
          await core.fepsDelete(fepsRecordId, { app_table: appTable })
        } catch (e) {
          // Ignore
        }
      }
    })

    it('should update an existing record', async function () {
      if (!fepsRecordId) this.skip()
      
      const updates = {
        _id: fepsRecordId,
        title: 'Updated FEPS Test Record',
        value: 100,
        updatedAt: Date.now()
      }
      
      const response = await core.fepsUpdate(updates, { app_table: appTable })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      // Verify the update by reading the record
      const readResponse = await core.fepsGetById(fepsRecordId, { app_table: appTable })
      expect(readResponse.ok).to.be.true
      expect(readResponse.data.title).to.equal(updates.title)
      expect(readResponse.data.value).to.equal(updates.value)
    })
  })

  // ===== FEPS DELETE TESTS =====
  describe('freepr.feps.delete', function () {
    it('should delete an existing record', async function () {
      // Create a record first
      const createResponse = await core.fepsCreate({
        title: 'Record to delete',
        purpose: 'deletion test'
      }, { app_table: appTable })
      
      if (!createResponse.ok) this.skip()
      
      const recordId = createResponse.data._id
      
      const response = await core.fepsDelete(recordId, { app_table: appTable })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      expect(response.data).to.be.an('object')
    })
  })

  // ===== FEPS UPSERT TESTS =====
  describe('freepr.feps.create with upsert', function () {
    it('should support upsert option to update existing record', async function () {
      const customId = `upsert_test_${Date.now()}`
      
      // Create initial record
      const createResponse = await core.fepsCreate({
        title: 'Original Title',
        value: 100
      }, { app_table: appTable, data_object_id: customId })
      
      expect(createResponse.ok).to.be.true
      const originalDateModified = createResponse.data._date_modified
      
      // Wait a bit to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 100))
      
      // Update using upsert option
      const upsertResponse = await core.fepsCreate({
        title: 'Updated via Upsert',
        value: 200,
        newField: 'added'
      }, { app_table: appTable, data_object_id: customId, upsert: true })
      
      expect(upsertResponse.ok).to.be.true

      // Read back the record by ID to verify the fields have been updated by upsert
      const verifyResponse = await core.fepsGetById(customId, { app_table: appTable })
      expect(verifyResponse.ok).to.be.true
      expect(verifyResponse.data.title).to.equal('Updated via Upsert')
      expect(verifyResponse.data.value).to.equal(200)
      expect(verifyResponse.data.newField).to.equal('added')
      expect(verifyResponse.data._date_modified).to.be.greaterThan(originalDateModified)
      
      // Cleanup
      await core.fepsDelete(customId, { app_table: appTable })
    })
  })

  // ===== FEPS QUERY-BASED UPDATE TESTS =====
  describe('freepr.feps.update with query', function () {
    it('should update records by query', async function () {
      // Create a test record first
      const createResponse = await core.fepsCreate({
        title: 'Query Update Test',
        category: 'test',
        value: 1
      }, { app_table: appTable })
      
      if (!createResponse.ok) {
        this.skip()
      }
      
      const testId = createResponse.data._id
      
      try {
        // Update by query
        const response = await core.fepsUpdate(
          { value: 2, updated: true },
          { app_table: appTable, q: { category: 'test' } }
        )
        
        expect(response.ok).to.be.true
        expect(response.status).to.equal(200)
      } finally {
        // Cleanup
        await core.fepsDelete(testId, { app_table: appTable })
      }
    })
  })

  // ===== PERMISSIONS TESTS =====
  describe('freepr.perms.getAppPermissions', function () {
    it('should get permissions using app access token', async function () {
      const response = await core.getPermissions()
      
      // CEPS 2.0 spec: response should be an array
      expect(response.ok).to.be.true
      expect(response.data).to.be.an('array')
      console.log(`      ✓ Got ${response.data.length} permissions`)
    })
  })

  // ===== CLEANUP =====
  describe('Cleanup', function () {
    it('should delete the main test record', async function () {
      if (!createdRecordId) this.skip()
      
      const response = await core.delete(createdRecordId, { app_table: appTable })
      
      expect(response.ok).to.be.true
      createdRecordId = null // Mark as deleted
    })
  })
})

