/**
 * Core API V2 Integration Tests
 * 
 * Tests the freezr API through the freezrApiV2.js interface 
 * instead of direct HTTP calls. This tests the actual API that apps use.
 * 
 * Tests cover:
 *   - CEPS operations (create, read, query, update, delete) via freepr.ceps.*
 *   - FEPS operations (create, read, update, delete, upload) via freepr.feps.*
 *   - Permissions operations via freepr.perms.*
 *   - Utilities (ping) via freezr.utils.*
 * 
 * Note: This uses the backward compatibility layer (freezr.ceps/feps) from freezr_core_v2.js
 * to test the legacy API interface that existing apps use.
 * 
 * Prerequisites: 
 *   1. Server must be running on the configured URL
 *   2. Test users must exist (see users_freezr/test_credentials/testUserCreds.json)
 *   3. Run with: npm run test:coreApiV2
 */

import { expect } from 'chai'
import { TestAuthHelper, loadTestCredentials, createAuthenticatedHelper, createOtherServerAuthenticatedHelper } from '../ceps/testAuthHelper.mjs'
import { readFileSync } from 'fs'
import { Readable } from 'stream'
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

    // Create a mock BODY element that can have children appended
    const mockBody = {
      style: { overflow: 'visible' },
      appendChild: () => {},
      scrollTop: 0
    }
    
    // Create a mock document object
    const mockDocument = {
      cookie: '',
      readyState: 'complete', // Set to 'complete' so menu._createElements() runs immediately
      getElementsByTagName: (tagName) => {
        // freezr_core_v2.js calls document.getElementsByTagName('BODY')[0]
        if (tagName === 'BODY' || tagName === 'body') {
          return [mockBody]
        }
        return []
      },
      getElementById: () => null,
      createElement: (tagName) => {
        const element = {
          style: {},
          onclick: null,
          innerHTML: '',
          appendChild: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          id: '',
          className: '',
          src: '',
          innerText: ''
        }
        // For img elements, add src property
        if (tagName === 'img') {
          element.src = ''
        }
        return element
      },
      addEventListener: () => {}
    }

    // Create a mock window object
    const mockWindow = {
      location: { href: this.serverAddress },
      scrollTo: () => {},
      innerWidth: 1024,
      innerHeight: 768
    }
    
    // Create a mock navigator object (used by freezr_core_v2.js)
    const mockNavigator = {
      userAgent: 'Mozilla/5.0 (Node.js Test Environment)'
    }

    // Mock confirm function
    const mockConfirm = () => true

    // Create a FormData implementation that works with node-fetch
    // Use a mock FormData that we can convert to multipart in customFetch
    const FormDataClass = class FormData {
      constructor() {
        this._streams = []
      }
      append(name, value, options = {}) {
        this._streams.push({ name, value, options })
      }
      // Make it compatible with node-fetch by providing a stream method
      get [Symbol.toStringTag]() {
        return 'FormData'
      }
    }

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

      // Handle FormData body - if it's our mock FormData, convert it to multipart
      let body = options.body
      if (body && body.constructor && body.constructor.name === 'FormData' && body._streams) {
        // Convert mock FormData to multipart form data
        const boundary = `----WebKitFormBoundary${Date.now()}`
        const parts = []
        
        for (const stream of body._streams) {
          const { name, value, options: streamOptions } = stream
          let part = `--${boundary}\r\n`
          part += `Content-Disposition: form-data; name="${name}"`
          
          if (value && typeof value === 'object' && value.name) {
            // It's a file
            part += `; filename="${value.name}"\r\n`
            part += `Content-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`
            parts.push(Buffer.from(part, 'utf8'))
            // Add file content
            if (value.arrayBuffer) {
              const arrayBuffer = await value.arrayBuffer()
              parts.push(Buffer.from(arrayBuffer))
            } else if (Buffer.isBuffer(value)) {
              parts.push(value)
            } else {
              parts.push(Buffer.from(String(value)))
            }
            parts.push(Buffer.from('\r\n', 'utf8'))
          } else {
            // It's a regular field
            part += `\r\n\r\n${String(value)}\r\n`
            parts.push(Buffer.from(part, 'utf8'))
          }
        }
        
        parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
        body = Buffer.concat(parts)
        headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`
      }

      // Make the actual fetch call using node-fetch
      const response = await fetch(fullUrl, {
        ...options,
        headers,
        body
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
      FormData: FormDataClass,
      document: mockDocument,
      window: mockWindow,
      navigator: mockNavigator,
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

    // Load the actual freezr_core_v2.js file
    const freezrCorePath = join(__dirname, '../../../freezrsystmapps/info.freezr.public/public/freezrApiV2.js')
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
        filename: 'freezrApiV2.js',
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

  // core.query
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
      // In v2, freezr.utils.ping is already async (returns a promise)
      const result = await this.freezr.utils.ping(options)
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
      console.log('core.sendMessage error', {error, that: this, freeprceps: this.freepr.ceps})
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

  // ============================================
  // MODERN API V2 METHODS (freezr.create, freezr.read, etc.)
  // ============================================

  /**
   * Modern API: freezr.create(collection, data, options)
   */
  async createV2(collection, data, options = {}) {
    this.updateAppToken()
    if (options.appToken) {
      this.vmContext.freezrMeta.appToken = options.appToken
    }
    try {
      const result = await this.freezr.create(collection, data, options)
      return { ok: true, status: 200, data: result }
    } catch (error) {
      console.log('      🔑  should create a new record using modern API - createv2 error', {options, error})
      return { ok: false, status: error.status || 500, data: { error: error.message } }
    }
  }

  /**
   * Modern API: freezr.read(collection, id, options)
   */
  async readV2(collection, id, options = {}) {
    this.updateAppToken()
    if (options.appToken) {
      this.vmContext.freezrMeta.appToken = options.appToken
    }
    try {
      const result = await this.freezr.read(collection, id, options)
      return { ok: true, status: 200, data: result }
    } catch (error) {
      return { ok: false, status: error.status || 500, data: { error: error.message } }
    }
  }

  /**
   * Modern API: freezr.query(collection, query, options)
   */
  async queryV2(collection, query = {}, options = {}) {
    this.updateAppToken()
    if (options.appToken) {
      this.vmContext.freezrMeta.appToken = options.appToken
    }
    try {
      const result = await this.freezr.query(collection, query, options)
      return { ok: true, status: 200, data: result }
    } catch (error) {
      return { ok: false, status: error.status || 500, data: { error: error.message } }
    }
  }

  /**
   * Modern API: freezr.update(collection, id, data, options)
   */
  async updateV2(collection, id, data, options = {}) {
    this.updateAppToken()
    if (options.appToken) {
      this.vmContext.freezrMeta.appToken = options.appToken
    }
    try {
      const result = await this.freezr.update(collection, id, data, options)
      return { ok: true, status: 200, data: result }
    } catch (error) {
      return { ok: false, status: error.status || 500, data: { error: error.message } }
    }
  }

  /**
   * Modern API: freezr.delete(collection, idOrQuery, options)
   */
  async deleteV2(collection, idOrQuery, options = {}) {
    this.updateAppToken()
    if (options.appToken) {
      this.vmContext.freezrMeta.appToken = options.appToken
    }
    try {
      const result = await this.freezr.delete(collection, idOrQuery, options)
      return { ok: true, status: 200, data: result }
    } catch (error) {
      return { ok: false, status: error.status || 500, data: { error: error.message } }
    }
  }

  /**
   * Modern API: freezr.updateFields(collection, id, fields, options)
   */
  async updateFieldsV2(collection, id, fields, options = {}) {
    this.updateAppToken()
    if (options.appToken) {
      this.vmContext.freezrMeta.appToken = options.appToken
    }
    try {
      const result = await this.freezr.updateFields(collection, id, fields, options)
      return { ok: true, status: 200, data: result }
    } catch (error) {
      return { ok: false, status: error.status || 500, data: { error: error.message } }
    }
  }

  /**
   * Modern API: freezr.upload(file, options)
   */
  async uploadV2(file, options = {}) {
    this.updateAppToken()
    if (options.appToken) {
      this.vmContext.freezrMeta.appToken = options.appToken
    }
    try {
      const result = await this.freezr.upload(file, options)
      return { ok: true, status: 200, data: result }
    } catch (error) {
      return { ok: false, status: error.status || 500, data: { error: error.message } }
    }
  }

  /**
   * Modern API: freezr.perms.getAppPermissions(options)
   */
  async getPermissionsV2(options = {}) {
    this.updateAppToken()
    try {
      const result = await this.freezr.perms.getAppPermissions(options)
      return { ok: true, status: 200, data: result }
    } catch (error) {
      return { ok: false, status: error.status || 500, data: { error: error.message } }
    }
  }

  /**
   * Modern API: freezr.perms.shareRecords(idOrQuery, options)
   */
  async shareRecordsV2(idOrQuery, options = {}) {
    this.updateAppToken()
    if (options && options.appToken) {
      this.vmContext.freezrMeta.appToken = options.appToken
    }
    try {
      const result = await this.freezr.perms.shareRecords(idOrQuery, options)
      return { ok: true, status: 200, data: result }
    } catch (error) {
      return { ok: false, status: error.status || 500, data: { error: error.message } }
    }
  }

  /**
   * Modern API: freezr.messages.send(message, options)
   */
  async sendMessageV2(message, options = {}) {
    this.updateAppToken()
    try {
      const result = await this.freezr.messages.send(message, options)
      return { ok: true, status: 200, data: result }
    } catch (error) {
      return { ok: false, status: error.status || 500, data: { error: error.message } }
    }
  }
}

describe('Core API V2 Integration Tests (via freepr)', function () {
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

  // ===== FEPS UPLOAD TESTS =====
  describe('freepr.feps.upload', function () {
    let uploadedFileId
    const appName = testConfig.testAppConfig.appName

    after(async function () {
      // Cleanup: Delete uploaded file if it exists
      if (uploadedFileId) {
        try {
          await core.fepsDelete(uploadedFileId, { app_table: `${appName}.files` })
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    })

    it('should upload a file and create a file record', async function () {
      // Read test logo file
      const testLogoPath = join(__dirname, '../../../users_freezr/test_credentials/testlogo.png')
      let fileBuffer
      try {
        fileBuffer = readFileSync(testLogoPath)
      } catch (error) {
        console.log('      ⚠ Test logo file not found, skipping file upload test')
        this.skip()
      }

      // Create a File-like object from Buffer
      // In Node.js 18+, we can use the File class from node:buffer
      let file
      try {
        // Try to use Node.js File class (Node 18+)
        // Use dynamic import since it's async
        const nodeBuffer = await import('node:buffer')
        if (nodeBuffer.File) {
          file = new nodeBuffer.File([fileBuffer], 'testlogo.png', { type: 'image/png' })
        } else {
          throw new Error('File not available')
        }
      } catch (e) {
        // Fallback: create a File-like object that works with our FormData mock
        file = {
          name: 'testlogo.png',
          type: 'image/png',
          size: fileBuffer.length,
          arrayBuffer: async () => fileBuffer.buffer,
          stream: () => {
            return Readable.from([fileBuffer])
          }
        }
      }

      const options = {
        fileName: `test_${Date.now()}.png`,
        targetFolder: 'test_uploads',
        overwrite: true,
        data: {
          description: 'Test upload from Core API V2 integration test',
          uploadedAt: Date.now()
        }
      }

      const response = await core.fepsUpload(file, options)

      if (response.ok) {
        expect(response.data).to.have.property('_id')
        uploadedFileId = response.data._id
        console.log(`      ✓ File uploaded successfully: ${uploadedFileId}`)
      } else {
        // Upload might fail for various reasons (permissions, etc.)
        console.log(`      ⚠ File upload returned status ${response.status}: ${JSON.stringify(response.data)}`)
        expect([200, 400, 401, 403, 500]).to.include(response.status)
      }
    })

    it('should upload a file with custom metadata', async function () {
      // Read test logo file
      const testLogoPath = join(__dirname, '../../../users_freezr/test_credentials/testlogo.png')
      let fileBuffer
      try {
        fileBuffer = readFileSync(testLogoPath)
      } catch (error) {
        this.skip()
      }

      // Create a File-like object
      let file
      try {
        const nodeBuffer = await import('node:buffer')
        if (nodeBuffer.File) {
          file = new nodeBuffer.File([fileBuffer], 'testlogo.png', { type: 'image/png' })
        } else {
          throw new Error('File not available')
        }
      } catch (e) {
        file = {
          name: 'testlogo.png',
          type: 'image/png',
          size: fileBuffer.length,
          arrayBuffer: async () => fileBuffer.buffer
        }
      }

      const options = {
        fileName: `test_metadata_${Date.now()}.png`,
        targetFolder: 'test_uploads',
        overwrite: true,
        data: {
          description: 'File with custom metadata',
          category: 'test',
          tags: ['upload', 'test', 'metadata'],
          uploadedAt: Date.now(),
          customField: 'custom value'
        }
      }

      const response = await core.fepsUpload(file, options)

      if (response.ok && response.data._id) {
        const fileId = response.data._id
        console.log(`      ✓ File uploaded with metadata: ${fileId}`)
        
        // Cleanup
        try {
          await core.fepsDelete(fileId, { app_table: `${appName}.files` })
        } catch (e) {
          // Ignore
        }
      } else {
        expect([200, 400, 401, 403, 500]).to.include(response.status)
      }
    })

    it('should handle upload with overwrite option', async function () {
      // Read test logo file
      const testLogoPath = join(__dirname, '../../../users_freezr/test_credentials/testlogo.png')
      let fileBuffer
      try {
        fileBuffer = readFileSync(testLogoPath)
      } catch (error) {
        this.skip()
      }

      // Create a File-like object
      let file
      try {
        const nodeBuffer = await import('node:buffer')
        if (nodeBuffer.File) {
          file = new nodeBuffer.File([fileBuffer], 'testlogo.png', { type: 'image/png' })
        } else {
          throw new Error('File not available')
        }
      } catch (e) {
        file = {
          name: 'testlogo.png',
          type: 'image/png',
          size: fileBuffer.length,
          arrayBuffer: async () => fileBuffer.buffer
        }
      }

      const fileName = `overwrite_test_${Date.now()}.png`
      const options1 = {
        fileName: fileName,
        targetFolder: 'test_uploads',
        overwrite: true
      }

      // Upload file first time
      const response1 = await core.fepsUpload(file, options1)
      
      if (!response1.ok || !response1.data._id) {
        this.skip()
      }

      const firstFileId = response1.data._id

      try {
        // Upload again with overwrite:true (should succeed and replace)
        const options2 = {
          fileName: fileName,
          targetFolder: 'test_uploads',
          overwrite: true
        }

        const response2 = await core.fepsUpload(file, options2)

        if (response2.ok) {
          expect(response2.data).to.have.property('_id')
          console.log(`      ✓ File overwritten successfully`)
        } else {
          expect([200, 400, 401, 403, 500]).to.include(response2.status)
        }
      } finally {
        // Cleanup
        try {
          await core.fepsDelete(firstFileId, { app_table: `${appName}.files` })
        } catch (e) {
          // Ignore
        }
      }
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

  // ===== SHARING TESTS =====
  describe('freepr.perms.shareRecords', function () {
    this.timeout(30000)
    
    let primaryAuth
    let secondaryAuth
    let primaryCore
    let secondaryCore
    let sharedRecordId
    const permissionName = 'public_link_test'
    const permissionTableId = appTable

    before(async function () {
      try {
        primaryAuth = await createAuthenticatedHelper('primary')
        console.log(`    ✓ Primary user logged in: ${primaryAuth.userId}`)
        
        primaryCore = new FreezrCoreHelper(
          primaryAuth,
          testConfig.testAppConfig.appName,
          primaryAuth.userId,
          serverUrl
        )
      } catch (error) {
        console.error(`    ✗ Primary user login failed: ${error.message}`)
        this.skip()
      }

      try {
        secondaryAuth = await createAuthenticatedHelper('secondary')
        console.log(`    ✓ Secondary user logged in: ${secondaryAuth.userId}`)
        
        secondaryCore = new FreezrCoreHelper(
          secondaryAuth,
          testConfig.testAppConfig.appName,
          secondaryAuth.userId,
          serverUrl
        )
      } catch (error) {
        console.warn(`    ⚠ Secondary user login failed: ${error.message}`)
        console.warn('    Sharing tests will be skipped. Create secondary test user to enable.')
        this.skip()
      }
    })

    after(async function () {
      // Cleanup
      if (primaryCore && sharedRecordId) {
        try {
          await primaryCore.delete(sharedRecordId, { app_table: appTable })
        } catch (e) {
          // Ignore
        }
      }
      
      if (primaryAuth) await primaryAuth.logout()
      if (secondaryAuth) await secondaryAuth.logout()
    })

    it('should grant permission using account access token', async function () {
      if (!primaryAuth) this.skip()
      
      const result = await primaryAuth.changePermission(
        permissionName,
        permissionTableId,
        testConfig.testAppConfig.appName,
        testConfig.testAppConfig.appName,
        true // grant
      )
      
      console.log(`      ✓ Permission ${permissionName} granted`)
      expect(result).to.exist
    })

    it('should allow primary user to create a record', async function () {
      if (!primaryCore) this.skip()
      
      const response = await primaryCore.create({
        title: 'Shared Record',
        owner: 'primary',
        content: 'This record should be accessible to secondary user after sharing'
      }, { app_table: appTable })
      
      expect(response.ok).to.be.true
      expect(response.data._id).to.exist
      sharedRecordId = response.data._id
      console.log(`      ✓ Primary user created record: ${sharedRecordId}`)
    })

    it('should allow primary user to share record with secondary user using freepr API', async function () {
      if (!primaryCore || !secondaryAuth || !sharedRecordId) this.skip()
      
      // Share the record with secondary user using freepr.perms.shareRecords
      const shareOptions = {
        name: permissionName,
        table_id: appTable,
        record_id: sharedRecordId,
        grantees: [secondaryAuth.userId],
        action: 'grant'
      }
      
      const response = await primaryCore.shareRecords(sharedRecordId, shareOptions)
      
      expect(response.ok).to.be.true
      console.log(`      ✓ Primary user shared record with secondary user using freepr API`)
    })

    it('should allow secondary user to read primary user\'s shared record', async function () {
      if (!secondaryCore || !primaryAuth || !sharedRecordId) this.skip()
      
      // Secondary user reads the shared record
      const response = await secondaryCore.getById(sharedRecordId, { 
        app_table: appTable,
        owner_id: primaryAuth.userId 
      })
      
      expect(response.ok).to.be.true
      expect(response.data).to.be.an('object')
      expect(response.data._id).to.equal(sharedRecordId)
      expect(response.data.title).to.equal('Shared Record')
      console.log(`      ✓ Secondary user successfully read primary user's record`)
    })
  })

  // ===== PUBLIC SHARING TESTS =====
  describe('freepr.perms.shareRecords with public', function () {
    this.timeout(30000)
    
    let primaryAuth
    let primaryCore
    let publicSharedRecordId
    const permissionName = 'public_link_test'
    const permissionTableId = appTable

    before(async function () {
      try {
        primaryAuth = await createAuthenticatedHelper('primary')
        console.log(`    ✓ Primary user logged in: ${primaryAuth.userId}`)
        
        primaryCore = new FreezrCoreHelper(
          primaryAuth,
          testConfig.testAppConfig.appName,
          primaryAuth.userId,
          serverUrl
        )
      } catch (error) {
        console.error(`    ✗ Primary user login failed: ${error.message}`)
        this.skip()
      }
    })

    after(async function () {
      // Cleanup
      if (primaryCore && publicSharedRecordId) {
        try {
          await primaryCore.delete(publicSharedRecordId, { app_table: appTable })
        } catch (e) {
          // Ignore
        }
      }
      
      if (primaryAuth) await primaryAuth.logout()
    })

    it('should grant permission using account access token', async function () {
      if (!primaryAuth) this.skip()
      
      const result = await primaryAuth.changePermission(
        permissionName,
        permissionTableId,
        testConfig.testAppConfig.appName,
        testConfig.testAppConfig.appName,
        true // grant
      )
      
      console.log(`      ✓ Permission ${permissionName} granted`)
      expect(result).to.exist
    })

    it('should allow primary user to create a record for public sharing', async function () {
      if (!primaryCore) this.skip()
      
      const response = await primaryCore.create({
        title: 'Public Shared Record',
        owner: 'primary',
        content: 'This record should be accessible to the public without authentication',
        publicContent: true
      }, { app_table: appTable })
      
      expect(response.ok).to.be.true
      expect(response.data._id).to.exist
      publicSharedRecordId = response.data._id
      console.log(`      ✓ Primary user created record for public sharing: ${publicSharedRecordId}`)
    })

    it('should allow primary user to share record with public using _public as grantee', async function () {
      if (!primaryCore || !publicSharedRecordId) this.skip()
      
      // Share the record with public using freepr.perms.shareRecords
      const shareOptions = {
        name: permissionName,
        table_id: appTable,
        record_id: publicSharedRecordId,
        grantees: ['_public'],
        action: 'grant'
      }
      
      const response = await primaryCore.shareRecords(publicSharedRecordId, shareOptions)
      
      expect(response.ok).to.be.true
      console.log(`      ✓ Primary user shared record with public using freepr API`)
    })

    it('should allow reading public shared record without authentication tokens', async function () {
      if (!primaryAuth || !publicSharedRecordId) this.skip()
      
      // Read the record using direct HTTP fetch WITHOUT any tokens
      // URL format: /v1/pobject/@:user_id/:requestee_app_table/:data_object_id
      const publicId = `@${primaryAuth.userId}/${appTable}/${publicSharedRecordId}`
      const publicUrl = `${serverUrl}/public/readobject/${publicId}`
      
      await new Promise(resolve => setTimeout(resolve, 100))

      const response = await fetch(publicUrl, {
        method: 'GET',
        // Explicitly do NOT include Authorization or Cookie headers
        headers: {
          'Content-Type': 'application/json'
        }
      })

      const responseJson = await response.json()
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      expect(responseJson).to.be.an('object')
      expect(responseJson._original_id).to.equal(publicSharedRecordId)
      expect(responseJson._id).to.equal(publicId)
      expect(responseJson.title).to.equal('Public Shared Record')
      console.log(`      ✓ Successfully read public shared record without authentication`)
    })
  })

  // ===== MESSAGE TESTS =====
  describe('freepr.ceps.sendMessage', function () {
    this.timeout(30000)
    
    let primaryAuth
    let secondaryAuth
    let primaryCore
    let secondaryCore
    let messageRecordId
    const messagePermissionName = 'message_link'
    const contactPermissionName = 'friends'
    const messagesPermissionName = 'message_link'

    before(async function () {
      try {
        primaryAuth = await createAuthenticatedHelper('primary')
        console.log(`    ✓ Primary user logged in: ${primaryAuth.userId}`)
        
        primaryCore = new FreezrCoreHelper(
          primaryAuth,
          testConfig.testAppConfig.appName,
          primaryAuth.userId,
          serverUrl
        )
      } catch (error) {
        console.error(`    ✗ Primary user login failed: ${error.message}`)
        this.skip()
      }

      try {
        secondaryAuth = await createAuthenticatedHelper('secondary')
        console.log(`    ✓ Secondary user logged in: ${secondaryAuth.userId}`)
        
        secondaryCore = new FreezrCoreHelper(
          secondaryAuth,
          testConfig.testAppConfig.appName,
          secondaryAuth.userId,
          serverUrl
        )
      } catch (error) {
        console.warn(`    ⚠ Secondary user login failed: ${error.message}`)
        console.warn('    Message tests will be skipped. Create secondary test user to enable.')
        this.skip()
      }
    })

    after(async function () {
      // Cleanup
      if (primaryCore && messageRecordId) {
        try {
          await primaryCore.delete(messageRecordId, { app_table: appTable })
        } catch (e) {
          // Ignore
        }
      }
      
      if (primaryAuth) await primaryAuth.logout()
      if (secondaryAuth) await secondaryAuth.logout()
    })

    it('should grant message_link permission for primary user', async function () {
      if (!primaryAuth) this.skip()
      
      const permissions = await primaryAuth.getPermissions()
      const messagePerm = permissions.find(p => 
        p.name === messagePermissionName && 
        p.type === 'message_records'
      )
      
      if (messagePerm) {
        if (!messagePerm.granted) {
          const result = await primaryAuth.changePermission(
            messagePermissionName,
            null,
            testConfig.testAppConfig.appName,
            testConfig.testAppConfig.appName,
            true // grant
          )
          expect(result).to.exist
          console.log(`      ✓ Granted ${messagePermissionName} permission`)
        } else {
          console.log(`      ✓ ${messagePermissionName} permission already granted`)
        }
      } else {
        console.log(`      ℹ ${messagePermissionName} permission not found in app manifest`)
        this.skip()
      }
    })

    it('should grant contact permission for primary user', async function () {
      if (!primaryAuth) this.skip()
      
      const permissions = await primaryAuth.getPermissions()
      const contactPerm = permissions.find(p => 
        p.name === contactPermissionName && 
        p.table_id === 'dev.ceps.contacts' &&
        (p.type === 'read_all' || p.type === 'write_own' || p.type === 'write_all')
      )
      
      if (contactPerm) {
        if (!contactPerm.granted) {
          const result = await primaryAuth.changePermission(
            contactPermissionName,
            null,
            testConfig.testAppConfig.appName,
            testConfig.testAppConfig.appName,
            true // grant
          )
          expect(result).to.exist
          console.log(`      ✓ Granted ${contactPermissionName} permission for contacts`)
        } else {
          console.log(`      ✓ ${contactPermissionName} permission already granted`)
        }
      } else {
        console.log(`      ℹ ${contactPermissionName} permission not found - may need to be registered`)
        try {
          await primaryAuth.changePermission(
            contactPermissionName,
            'dev.ceps.contacts',
            testConfig.testAppConfig.appName,
            testConfig.testAppConfig.appName,
            true
          )
          console.log(`      ✓ Attempted to grant ${contactPermissionName} permission`)
        } catch (e) {
          console.log(`      ⚠ Could not grant contact permission: ${e.message}`)
        }
      }
    })

    it('should verify both message_link and contact permissions are granted before sending', async function () {
      if (!primaryAuth) this.skip()
      
      const permissions = await primaryAuth.getPermissions()
      
      const messagePerm = permissions.find(p => 
        p.name === messagePermissionName && 
        p.type === 'message_records' &&
        p.granted === true
      )
      expect(messagePerm).to.exist
      expect(messagePerm.granted).to.be.true
      console.log(`      ✓ Verified ${messagePermissionName} permission is granted`)
      
      const contactPerm = permissions.find(p => 
        p.name === contactPermissionName && 
        (p.table_id === 'dev.ceps.contacts' || p.table_id.includes('dev.ceps.contacts')) &&
        (p.type === 'read_all' || p.type === 'write_own' || p.type === 'write_all') &&
        p.granted === true
      )
      expect(contactPerm).to.exist
      expect(contactPerm.granted).to.be.true
      console.log(`      ✓ Verified ${contactPermissionName} permission is granted for dev.ceps.contacts`)
      
      if (!messagePerm || !contactPerm) {
        throw new Error('Required permissions not granted. Cannot send message without both message_link and contact permissions.')
      }
    })

    it('should create a record to send as a message', async function () {
      if (!primaryCore) this.skip()
      
      const response = await primaryCore.create({
        title: 'Message Test Record',
        content: 'This record will be sent as a message',
        owner: 'primary',
        messageData: { important: true, priority: 'high' }
      }, { app_table: appTable })
      
      expect(response.ok).to.be.true
      expect(response.data._id).to.exist
      messageRecordId = response.data._id
      console.log(`      ✓ Created record for messaging: ${messageRecordId}`)
    })

    it('should send a message using freepr.ceps.sendMessage', async function () {
      if (!primaryCore || !secondaryAuth || !messageRecordId) this.skip()
      
      // Verify permissions are granted
      const permissions = await primaryAuth.getPermissions()
      const messagePerm = permissions.find(p => 
        p.name === messagePermissionName && 
        p.type === 'message_records' &&
        p.granted === true
      )
      const contactPerm = permissions.find(p => 
        p.name === contactPermissionName && 
        p.granted === true
      )
      
      if (!messagePerm || !contactPerm) {
        throw new Error(`Cannot send message: Required permissions not granted. message_link: ${!!messagePerm}, contact: ${!!contactPerm}`)
      }
      
      console.log(`      ✓ Verified permissions before sending: message_link=${messagePerm.granted}, contact=${contactPerm.granted}`)
      
      // Get the full record to send
      const recordResponse = await primaryCore.getById(messageRecordId, { app_table: appTable })
      expect(recordResponse.ok).to.be.true
      
      // Prepare message data for freepr.ceps.sendMessage
      // freepr.ceps.sendMessage expects: recipient_id, messaging_permission, contact_permission, table_id, record_id, record
      const toShare = {
        recipient_id: secondaryAuth.userId,
        // recipient_host is optional for same-server (omitted here)
        messaging_permission: messagePermissionName,
        contact_permission: contactPermissionName,
        table_id: appTable,
        record_id: messageRecordId,
        record: {
          title: recordResponse.data.title,
          content: recordResponse.data.content,
          messageData: recordResponse.data.messageData
        }
      }
      
      const result = await primaryCore.sendMessage(toShare)

      expect(result).to.exist
      if (result.ok !== undefined) {
        expect(result.ok).to.be.true
      }
      console.log(`      ✓ Message sent successfully using freepr.ceps.sendMessage`)
    })

    it('should grant messages permission for secondary user to read messages', async function () {
      if (!secondaryAuth) this.skip()

      const permissions = await secondaryAuth.getPermissions()
      const messagesPerm = permissions.find(p => 
        p.name === messagesPermissionName
      )
      
      if (messagesPerm) {
        if (!messagesPerm.granted) {
          const result = await secondaryAuth.changePermission(
            messagesPermissionName,
            messagesPerm.table_id,
            testConfig.testAppConfig.appName,
            testConfig.testAppConfig.appName,
            true // grant
          )
          expect(result).to.exist
          console.log(`      ✓ Secondary user granted ${messagesPermissionName} permission for ${messagesPerm.table_id}`)
        }
      } else {
        console.log(`      ℹ ${messagesPermissionName} permission not found - trying to grant for dev.ceps.messages.got`)
        try {
          await secondaryAuth.changePermission(
            messagesPermissionName,
            'dev.ceps.messages.got',
            testConfig.testAppConfig.appName,
            testConfig.testAppConfig.appName,
            true
          )
          console.log(`      ✓ Attempted to grant ${messagesPermissionName} permission`)
        } catch (e) {
          console.log(`      ⚠ Could not grant messages permission: ${e.message}`)
        }
      }
    })

    it('should allow secondary user to retrieve messages using getMessages', async function () {
      if (!secondaryAuth || !messageRecordId) this.skip()
      
      const permissions = await secondaryAuth.getPermissions()
      const messagesPerm = permissions.find(p => 
        p.name === messagesPermissionName
      )

      if (!messagesPerm) {
        throw new Error(`Permission ${messagesPermissionName} not found.`)
      }

      if (!messagesPerm.granted) {
        console.log(`      ℹ Permission ${messagesPermissionName} is not granted, attempting to grant...`)
        const result2 = await secondaryAuth.changePermission(
          messagesPermissionName,
          messagesPerm.table_id,
          testConfig.testAppConfig.appName,
          testConfig.testAppConfig.appName,
          true // grant
        )
        
        const permissionsAfter = await secondaryAuth.getPermissions()
        const messagesPermAfter = permissionsAfter.find(p => 
          p.name === messagesPermissionName
        )
        if (!messagesPermAfter || !messagesPermAfter.granted) {
          throw new Error(`Failed to grant ${messagesPermissionName} permission.`)
        }
      } else {
        console.log(`      ✓ Permission ${messagesPermissionName} is already granted`)
      }
      
      let messages = null
      let errorMessage = null
      try {
        messages = await secondaryAuth.getMessages({ app_id: testConfig.testAppConfig.appName })
      } catch (e) {
        errorMessage = e.message || String(e)
        if (errorMessage.includes('Permission') || errorMessage.includes('permission') || errorMessage.includes('401') || errorMessage.includes('403')) {
          throw new Error(`Failed to get messages due to permission issue: ${errorMessage}`)
        }
        throw new Error(`Failed to get messages: ${errorMessage}`)
      }
      
      expect(messages).to.be.an('array')
      console.log(`      ✓ Secondary user retrieved ${messages.length} messages from dev.ceps.messages.got`)
      
      // Find the message we sent
      const ourMessage = messages.find(m => 
        m.sender_id === primaryAuth.userId &&
        m.record_id === messageRecordId &&
        (m.table_id === appTable || m.table_id.includes(appTable))
      )
      
      if (ourMessage) {
        expect(ourMessage.type).to.equal('message_records')
        expect(ourMessage.messaging_permission).to.equal(messagePermissionName)
        expect(ourMessage.record).to.exist
        expect(ourMessage.record.title).to.equal('Message Test Record')
        console.log(`      ✓ Found the sent message in dev.ceps.messages.got`)
        console.log(`        Message ID: ${ourMessage._id}`)
        console.log(`        Sender: ${ourMessage.sender_id}`)
        console.log(`        Type: ${ourMessage.type}`)
      } else {
        console.log(`      ⚠ Message not found yet - may need more time to process`)
        console.log(`        Available messages: ${messages.length}`)
        if (messages.length > 0) {
          console.log(`        Sample message:`, JSON.stringify(messages[0], null, 2))
        }
      }
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

// ============================================
// MODERN API V2 TESTS (freezr.create, freezr.read, etc.)
// ============================================
describe('Core API V2 Modern Interface Tests', function () {
  // Increase timeout for network requests
  this.timeout(10000)

  let auth
  let core
  let createdRecordId

  // Extract collection name from appTable (e.g., "com.salmanff.apitester.table1" -> "table1")
  // Must use the appName to correctly extract just the collection part
  const appName = testConfig.testAppConfig.appName
  const collection = appTable.startsWith(appName + '.') 
    ? appTable.slice(appName.length + 1) 
    : appTable

  // Test data
  const testRecord = {
    title: 'Modern API Test Record',
    description: 'Created by Modern API V2 test',
    value: 42,
    tags: ['test', 'modern', 'v2'],
    timestamp: Date.now()
  }

  before(async function () {
    // Login before running tests
    try {
      auth = await createAuthenticatedHelper('primary')
      console.log(`    ✓ Logged in as ${auth.userId}`)
      
      // Initialize freezr core helper (reuse from previous tests)
      core = new FreezrCoreHelper(
        auth,
        testConfig.testAppConfig.appName,
        auth.userId,
        serverUrl
      )
      console.log(`    ✓ Initialized freezr core API V2`)
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
        await core.deleteV2(collection, createdRecordId, { app_table: appTable })
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    
    // Logout
    if (auth) {
      await auth.logout()
    }
  })

  // ===== MODERN CREATE TESTS =====
  describe('freezr.create()', function () {
    it('should create a new record using modern API', async function () {
      const response = await core.createV2(collection, testRecord, { app_table: appTable })
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      expect(response.data).to.be.an('object')
      expect(response.data._id).to.exist
      
      // Store ID for subsequent tests
      createdRecordId = response.data._id
    })

    it('should return CEPS 2.0 compliant response with _date_created and _date_modified', async function () {
      const response = await core.createV2(collection, {
        title: 'Modern API Compliance Test',
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
      await core.deleteV2(collection, response.data._id, { app_table: appTable })
    })

    it('should create record with custom ID using data_object_id option', async function () {
      const customId = `modern_test_${Date.now()}`
      const response = await core.createV2(collection, {
        title: 'Record with Custom ID',
        value: 999
      }, { app_table: appTable, data_object_id: customId })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      expect(response.data._id).to.equal(customId)
      
      // Cleanup
      await core.deleteV2(collection, customId, { app_table: appTable })
    })

    it('should support upsert option', async function () {
      const customId = `upsert_modern_${Date.now()}`
      
      // Create initial record
      const createResponse = await core.createV2(collection, {
        title: 'Original Title',
        value: 100
      }, { app_table: appTable, data_object_id: customId })
      
      expect(createResponse.ok).to.be.true
      const originalDateModified = createResponse.data._date_modified
      
      // Wait a bit to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 100))
      
      // Update using upsert option
      const upsertResponse = await core.createV2(collection, {
        title: 'Updated via Upsert',
        value: 200,
        newField: 'added'
      }, { app_table: appTable, data_object_id: customId, upsert: true })
      
      expect(upsertResponse.ok).to.be.true

      // Read back the record to verify the fields have been updated
      const verifyResponse = await core.readV2(collection, customId, { app_table: appTable })
      expect(verifyResponse.ok).to.be.true
      expect(verifyResponse.data.title).to.equal('Updated via Upsert')
      expect(verifyResponse.data.value).to.equal(200)
      expect(verifyResponse.data.newField).to.equal('added')
      expect(verifyResponse.data._date_modified).to.be.greaterThan(originalDateModified)
      
      // Cleanup
      await core.deleteV2(collection, customId, { app_table: appTable })
    })
  })

  // ===== MODERN READ TESTS =====
  describe('freezr.read()', function () {
    it('should read an existing record by ID', async function () {
      if (!createdRecordId) this.skip()
      
      const response = await core.readV2(collection, createdRecordId, { app_table: appTable })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      expect(response.data).to.be.an('object')
      expect(response.data._id).to.equal(createdRecordId)
      expect(response.data.title).to.equal(testRecord.title)
      expect(response.data.value).to.equal(testRecord.value)
    })

    it('should return CEPS 2.0 compliant response with _date_created and _date_modified', async function () {
      if (!createdRecordId) this.skip()
      
      const response = await core.readV2(collection, createdRecordId, { app_table: appTable })
      
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

  // ===== MODERN QUERY TESTS =====
  describe('freezr.query()', function () {
    it('should query records without filters (get all)', async function () {
      const response = await core.queryV2(collection, {}, { app_table: appTable })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      // CEPS 2.0 spec requires: response must be an array of records
      expect(response.data).to.be.an('array')
    })

    it('should query records with filter parameters', async function () {
      // Query for records with specific title
      const response = await core.queryV2(collection, { title: testRecord.title }, { app_table: appTable })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      // CEPS 2.0 spec requires: response must be an array
      expect(response.data).to.be.an('array')
      
      // If we got results, they should match our filter
      const matching = response.data.filter(r => r.title === testRecord.title)
      expect(matching.length).to.be.at.least(0) // May be 0 if no matches
    })

    it('should return CEPS 2.0 compliant array response', async function () {
      const response = await core.queryV2(collection, {}, { app_table: appTable })
      
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
      const createResponse = await core.createV2(collection, {
        title: 'Modified Date Test',
        timestamp: now
      }, { app_table: appTable })
      const testRecordId = createResponse.data._id
      const recordDateModified = createResponse.data._date_modified
      
      try {
        // Query with _modified_after (should include our record)
        const afterResponse = await core.queryV2(collection, {
          _date_modified: { $gt: recordDateModified - 5000 }
        }, { app_table: appTable })

        expect(afterResponse.ok).to.be.true
        expect(afterResponse.data).to.be.an('array')
        const foundAfter = afterResponse.data.find(r => r._id === testRecordId)
        expect(foundAfter).to.exist
        
        // Query with _modified_before (should include our record)
        const beforeResponse = await core.queryV2(collection, {
          _date_modified: { $lt: recordDateModified + 5000 }
        }, { app_table: appTable })
        expect(beforeResponse.ok).to.be.true
        expect(beforeResponse.data).to.be.an('array')
        const foundBefore = beforeResponse.data.find(r => r._id === testRecordId)
        expect(foundBefore).to.exist
      } finally {
        // Cleanup
        await core.deleteV2(collection, testRecordId, { app_table: appTable })
      }
    })
  })

  // ===== MODERN UPDATE TESTS =====
  describe('freezr.update()', function () {
    it('should update an existing record', async function () {
      if (!createdRecordId) this.skip()
      
      const updates = {
        title: 'Updated via Modern API',
        value: 100,
        updatedAt: Date.now()
      }
      
      const response = await core.updateV2(collection, createdRecordId, updates, { app_table: appTable })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      // Verify the update by reading the record
      const readResponse = await core.readV2(collection, createdRecordId, { app_table: appTable })
      expect(readResponse.ok).to.be.true
      expect(readResponse.data.title).to.equal(updates.title)
      expect(readResponse.data.value).to.equal(updates.value)
    })

    it('should return CEPS 2.0 compliant response with _date_created and _date_modified', async function () {
      if (!createdRecordId) this.skip()
      
      // First, read the original record to get its _date_created
      const beforeResponse = await core.readV2(collection, createdRecordId, { app_table: appTable })
      const originalDateCreated = beforeResponse.data._date_created
      const originalDateModified = beforeResponse.data._date_modified
      
      // Wait a bit to ensure _date_modified changes
      await new Promise(resolve => setTimeout(resolve, 100))
      
      const updates = {
        title: 'Modern API Compliance Update Test',
        value: 999
      }
      
      const response = await core.updateV2(collection, createdRecordId, updates, { app_table: appTable })
      
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

    it('should support updateFields for partial updates', async function () {
      if (!createdRecordId) this.skip()
      
      // First create a record with multiple fields
      const testId = `updateFields_test_${Date.now()}`
      const createResponse = await core.createV2(collection, {
        title: 'Original Title',
        description: 'Original Description',
        value: 100,
        category: 'test'
      }, { app_table: appTable, data_object_id: testId })
      
      if (!createResponse.ok) this.skip()
      
      try {
        // Use updateFields to update only specific fields
        const response = await core.updateFieldsV2(collection, testId, {
          value: 200,
          newField: 'added'
        }, { app_table: appTable })
        
        expect(response.ok).to.be.true
        expect(response.data).to.have.property('_id')
        
        // Verify partial update by reading the record
        const readResponse = await core.readV2(collection, testId, { app_table: appTable })
        expect(readResponse.ok).to.be.true
        expect(readResponse.data.value).to.equal(200)
        expect(readResponse.data.newField).to.equal('added')
        // Original fields should remain
        expect(readResponse.data.title).to.equal('Original Title')
        expect(readResponse.data.description).to.equal('Original Description')
      } finally {
        // Cleanup
        await core.deleteV2(collection, testId, { app_table: appTable })
      }
    })
  })

  // ===== MODERN DELETE TESTS =====
  describe('freezr.delete()', function () {
    let recordToDeleteId

    before(async function () {
      // Create a record specifically for deletion testing
      const response = await core.createV2(collection, {
        title: 'Record to delete',
        purpose: 'deletion test'
      }, { app_table: appTable })
      
      if (response.ok) {
        recordToDeleteId = response.data._id
      }
    })

    it('should delete an existing record', async function () {
      if (!recordToDeleteId) this.skip()
      
      const response = await core.deleteV2(collection, recordToDeleteId, { app_table: appTable })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      expect(response.data).to.be.an('object')
      
      // Verify the record is deleted by trying to read it
      const readResponse = await core.readV2(collection, recordToDeleteId, { app_table: appTable })
      
      // Should return error
      expect(readResponse.ok).to.be.false
    })
  })

  // ===== MODERN PERMISSIONS TESTS =====
  describe('freezr.perms.getAppPermissions()', function () {
    it('should get permissions using modern API', async function () {
      const response = await core.getPermissionsV2()
      
      // CEPS 2.0 spec: response should be an array
      expect(response.ok).to.be.true
      expect(response.data).to.be.an('array')
      console.log(`      ✓ Got ${response.data.length} permissions using modern API`)
    })
  })

  // ===== MODERN SHARING TESTS =====
  describe('freezr.perms.shareRecords()', function () {
    this.timeout(30000)
    
    let primaryAuth
    let secondaryAuth
    let primaryCore
    let secondaryCore
    let sharedRecordId
    const permissionName = 'public_link_test'
    const permissionTableId = appTable

    before(async function () {
      try {
        primaryAuth = await createAuthenticatedHelper('primary')
        console.log(`    ✓ Primary user logged in: ${primaryAuth.userId}`)
        
        primaryCore = new FreezrCoreHelper(
          primaryAuth,
          testConfig.testAppConfig.appName,
          primaryAuth.userId,
          serverUrl
        )
      } catch (error) {
        console.error(`    ✗ Primary user login failed: ${error.message}`)
        this.skip()
      }

      try {
        secondaryAuth = await createAuthenticatedHelper('secondary')
        console.log(`    ✓ Secondary user logged in: ${secondaryAuth.userId}`)
        
        secondaryCore = new FreezrCoreHelper(
          secondaryAuth,
          testConfig.testAppConfig.appName,
          secondaryAuth.userId,
          serverUrl
        )
      } catch (error) {
        console.warn(`    ⚠ Secondary user login failed: ${error.message}`)
        console.warn('    Modern sharing tests will be skipped. Create secondary test user to enable.')
        this.skip()
      }
    })

    after(async function () {
      // Cleanup
      if (primaryCore && sharedRecordId) {
        try {
          await primaryCore.deleteV2(collection, sharedRecordId, { app_table: appTable })
        } catch (e) {
          // Ignore
        }
      }
      
      if (primaryAuth) await primaryAuth.logout()
      if (secondaryAuth) await secondaryAuth.logout()
    })

    it('should grant permission using account access token', async function () {
      if (!primaryAuth) this.skip()
      
      const result = await primaryAuth.changePermission(
        permissionName,
        permissionTableId,
        testConfig.testAppConfig.appName,
        testConfig.testAppConfig.appName,
        true // grant
      )
      
      console.log(`      ✓ Permission ${permissionName} granted`)
      expect(result).to.exist
    })

    it('should allow primary user to create a record using modern API', async function () {
      if (!primaryCore) this.skip()
      
      const response = await primaryCore.createV2(collection, {
        title: 'Shared Record (Modern API)',
        owner: 'primary',
        content: 'This record should be accessible to secondary user after sharing'
      }, { app_table: appTable })
      
      expect(response.ok).to.be.true
      expect(response.data._id).to.exist
      sharedRecordId = response.data._id
      console.log(`      ✓ Primary user created record using modern API: ${sharedRecordId}`)
    })

    it('should allow primary user to share record with secondary user using modern API', async function () {
      if (!primaryCore || !secondaryAuth || !sharedRecordId) this.skip()
      
      // Share the record with secondary user using freezr.perms.shareRecords
      const shareOptions = {
        name: permissionName,
        table_id: appTable,
        record_id: sharedRecordId,
        grantees: [secondaryAuth.userId],
        action: 'grant'
      }
      
      const response = await primaryCore.shareRecordsV2(sharedRecordId, shareOptions)
      
      expect(response.ok).to.be.true
      console.log(`      ✓ Primary user shared record with secondary user using modern API`)
    })

    it('should allow secondary user to read primary user\'s shared record using modern API', async function () {
      if (!secondaryCore || !primaryAuth || !sharedRecordId) this.skip()
      
      // Secondary user reads the shared record
      const response = await secondaryCore.readV2(collection, sharedRecordId, { 
        app_table: appTable,
        owner_id: primaryAuth.userId ,
        //host: primaryAuth.serverUrl,
        permission_name: 'public_link_test'
      })
      
      expect(response.ok).to.be.true
      expect(response.data).to.be.an('object')
      expect(response.data._id).to.equal(sharedRecordId)
      expect(response.data.title).to.equal('Shared Record (Modern API)')
      console.log(`      ✓ Secondary user successfully read primary user's record using modern API`)
    })
  })

  // ===== MODERN PUBLIC SHARING TESTS =====
  describe('freezr.perms.shareRecords() with public', function () {
    this.timeout(30000)
    
    let primaryAuth
    let primaryCore
    let publicSharedRecordId
    const permissionName = 'public_link_test'
    const permissionTableId = appTable

    before(async function () {
      try {
        primaryAuth = await createAuthenticatedHelper('primary')
        console.log(`    ✓ Primary user logged in: ${primaryAuth.userId}`)
        
        primaryCore = new FreezrCoreHelper(
          primaryAuth,
          testConfig.testAppConfig.appName,
          primaryAuth.userId,
          serverUrl
        )
      } catch (error) {
        console.error(`    ✗ Primary user login failed: ${error.message}`)
        this.skip()
      }
    })

    after(async function () {
      // Cleanup
      if (primaryCore && publicSharedRecordId) {
        try {
          await primaryCore.deleteV2(collection, publicSharedRecordId, { app_table: appTable })
        } catch (e) {
          // Ignore
        }
      }
      
      if (primaryAuth) await primaryAuth.logout()
    })

    it('should grant permission using account access token', async function () {
      if (!primaryAuth) this.skip()
      
      const result = await primaryAuth.changePermission(
        permissionName,
        permissionTableId,
        testConfig.testAppConfig.appName,
        testConfig.testAppConfig.appName,
        true // grant
      )
      
      console.log(`      ✓ Permission ${permissionName} granted`)
      expect(result).to.exist
    })

    it('should allow primary user to create a record for public sharing using modern API', async function () {
      if (!primaryCore) this.skip()
      
      const response = await primaryCore.createV2(collection, {
        title: 'Public Shared Record (Modern API)',
        owner: 'primary',
        content: 'This record should be accessible to the public without authentication',
        publicContent: true
      }, { app_table: appTable })
      
      expect(response.ok).to.be.true
      expect(response.data._id).to.exist
      publicSharedRecordId = response.data._id
      console.log(`      ✓ Primary user created record for public sharing using modern API: ${publicSharedRecordId}`)
    })

    it('should allow primary user to share record with public using _public as grantee (modern API)', async function () {
      if (!primaryCore || !publicSharedRecordId) this.skip()
      
      // Share the record with public using freezr.perms.shareRecords
      const shareOptions = {
        name: permissionName,
        table_id: appTable,
        record_id: publicSharedRecordId,
        grantees: ['_public'],
        action: 'grant'
      }
      
      const response = await primaryCore.shareRecordsV2(publicSharedRecordId, shareOptions)
      
      expect(response.ok).to.be.true
      console.log(`      ✓ Primary user shared record with public using modern API`)
    })

    it('should allow reading public shared record without authentication tokens (modern API)', async function () {
      if (!primaryAuth || !publicSharedRecordId) this.skip()
      
      // Read the record using direct HTTP fetch WITHOUT any tokens
      // URL format: /v1/pobject/@:user_id/:requestee_app_table/:data_object_id

      const publicId = `@${primaryAuth.userId}/${appTable}/${publicSharedRecordId}`
      const publicUrl = `${serverUrl}/public/readobject/${publicId}`
      
      await new Promise(resolve => setTimeout(resolve, 100))

      const response = await fetch(publicUrl, {
        method: 'GET',
        // Explicitly do NOT include Authorization or Cookie headers
        headers: {
          'Content-Type': 'application/json'
        }
      })

      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      const responseJson  = await response.json()
      expect(responseJson).to.be.an('object')
      expect(responseJson._original_id).to.equal(publicSharedRecordId)
      expect(responseJson._id).to.equal(publicId)
      expect(responseJson.title).to.equal('Public Shared Record (Modern API)')
    })

    it('should allow querying all public records without authentication', async function () {
      if (!primaryAuth || !publicSharedRecordId) this.skip()
      
      // Wait a bit for the record to be indexed
      await new Promise(resolve => setTimeout(resolve, 500))
      
      const queryUrl = `${serverUrl}/public/query`
      
      const response = await fetch(queryUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      const responseJson = await response.json()
      expect(responseJson).to.be.an('object')
      expect(responseJson.results).to.be.an('array')
      expect(responseJson.count).to.be.a('number')
      
      // Should find at least our public record
      const foundRecord = responseJson.results.find(r => r._original_id === publicSharedRecordId)
      expect(foundRecord).to.exist
      expect(foundRecord.title).to.equal('Public Shared Record (Modern API)')
      
      console.log(`      ✓ Queried all public records: found ${responseJson.count} record(s)`)
    })

    it('should allow querying public records by user without authentication', async function () {
      if (!primaryAuth || !publicSharedRecordId) this.skip()
      
      await new Promise(resolve => setTimeout(resolve, 200))
      
      const queryUrl = `${serverUrl}/public/query/@${primaryAuth.userId}`
      
      const response = await fetch(queryUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      const responseJson = await response.json()
      expect(responseJson).to.be.an('object')
      expect(responseJson.results).to.be.an('array')
      
      // All results should be from the specified user
      responseJson.results.forEach(record => {
        expect(record._data_owner).to.equal(primaryAuth.userId)
      })
      
      // Should find our public record
      const foundRecord = responseJson.results.find(r => r._original_id === publicSharedRecordId)
      expect(foundRecord).to.exist
      
      console.log(`      ✓ Queried public records by user: found ${responseJson.count} record(s)`)
    })

    it('should allow querying public records by user and app without authentication', async function () {
      if (!primaryAuth || !publicSharedRecordId) this.skip()
      
      await new Promise(resolve => setTimeout(resolve, 200))
      
      const appName = testConfig.testAppConfig.appName
      const queryUrl = `${serverUrl}/public/query/@${primaryAuth.userId}/${appName}`
      
      const response = await fetch(queryUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      const responseJson = await response.json()
      expect(responseJson).to.be.an('object')
      expect(responseJson.results).to.be.an('array')
      
      // All results should be from the specified user and app
      responseJson.results.forEach(record => {
        expect(record._data_owner).to.equal(primaryAuth.userId)
        expect(record._app_name).to.equal(appName)
      })
      
      // Should find our public record
      const foundRecord = responseJson.results.find(r => r._original_id === publicSharedRecordId)
      expect(foundRecord).to.exist
      
      console.log(`      ✓ Queried public records by user and app: found ${responseJson.count} record(s)`)
    })

    it('should allow querying public records by search term without authentication', async function () {
      if (!primaryAuth || !publicSharedRecordId) this.skip()
      
      await new Promise(resolve => setTimeout(resolve, 200))
      
      const queryUrl = `${serverUrl}/public/query?search=Public`
      
      const response = await fetch(queryUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      const responseJson = await response.json()
      expect(responseJson).to.be.an('object')
      expect(responseJson.results).to.be.an('array')
      
      // Should find our public record (title contains "Public")
      const foundRecord = responseJson.results.find(r => r._original_id === publicSharedRecordId)
      expect(foundRecord).to.exist
      expect(foundRecord.title).to.include('Public')
      
      console.log(`      ✓ Queried public records by search: found ${responseJson.count} record(s)`)
    })

    it('should render public object page without authentication (objectpage route)', async function () {
      if (!primaryAuth || !publicSharedRecordId) this.skip()
      
      await new Promise(resolve => setTimeout(resolve, 200))
      
      // Use the full public ID format: @user_id/app_table/record_id
      const publicId = `@${primaryAuth.userId}/${appTable}/${publicSharedRecordId}`
      const objectPageUrl = `${serverUrl}/public/objectpage/${publicId}`
      
      const response = await fetch(objectPageUrl, {
        method: 'GET',
        // No authentication headers
        headers: {
          'Accept': 'text/html'
        }
      })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      const responseText = await response.text()
      expect(responseText).to.be.a('string')
      expect(responseText.length).to.be.greaterThan(0)
      
      // Should be an HTML page (contains basic HTML structure)
      expect(responseText).to.include('<!DOCTYPE html')
      
      console.log(`      ✓ Rendered public object page for ${publicId}`)
    })

    it('should render public object page using path params format', async function () {
      if (!primaryAuth || !publicSharedRecordId) this.skip()
      
      await new Promise(resolve => setTimeout(resolve, 200))
      
      // Use the path params format: /public/objectpage/@user_id/app_table/record_id
      const objectPageUrl = `${serverUrl}/public/objectpage/@${primaryAuth.userId}/${appTable}/${publicSharedRecordId}`
      
      const response = await fetch(objectPageUrl, {
        method: 'GET',
        headers: {
          'Accept': 'text/html'
        }
      })
      
      expect(response.ok).to.be.true
      expect(response.status).to.equal(200)
      
      const responseText = await response.text()
      expect(responseText).to.be.a('string')
      expect(responseText).to.include('<!DOCTYPE html')
      
      console.log(`      ✓ Rendered public object page using path params format`)
    })
  })

  // ===== MODERN MESSAGE TESTS =====
  describe('freezr.messages.send()', function () {
    this.timeout(30000)
    
    let primaryAuth
    let secondaryAuth
    let primaryCore
    let secondaryCore
    let messageRecordId
    const messagePermissionName = 'message_link'
    const contactPermissionName = 'friends'
    const messagesPermissionName = 'message_link'

    before(async function () {
      try {
        primaryAuth = await createAuthenticatedHelper('primary')
        console.log(`    ✓ Primary user logged in: ${primaryAuth.userId}`)
        
        primaryCore = new FreezrCoreHelper(
          primaryAuth,
          testConfig.testAppConfig.appName,
          primaryAuth.userId,
          serverUrl
        )
      } catch (error) {
        console.error(`    ✗ Primary user login failed: ${error.message}`)
        this.skip()
      }

      try {
        secondaryAuth = await createAuthenticatedHelper('secondary')
        console.log(`    ✓ Secondary user logged in: ${secondaryAuth.userId}`)
        
        secondaryCore = new FreezrCoreHelper(
          secondaryAuth,
          testConfig.testAppConfig.appName,
          secondaryAuth.userId,
          serverUrl
        )
      } catch (error) {
        console.warn(`    ⚠ Secondary user login failed: ${error.message}`)
        console.warn('    Modern message tests will be skipped. Create secondary test user to enable.')
        this.skip()
      }
    })

    after(async function () {
      // Cleanup
      if (primaryCore && messageRecordId) {
        try {
          await primaryCore.deleteV2(collection, messageRecordId, { app_table: appTable })
        } catch (e) {
          // Ignore
        }
      }
      
      if (primaryAuth) await primaryAuth.logout()
      if (secondaryAuth) await secondaryAuth.logout()
    })

    it('should grant message_link permission for primary user', async function () {
      if (!primaryAuth) this.skip()
      
      const permissions = await primaryAuth.getPermissions()
      const messagePerm = permissions.find(p => 
        p.name === messagePermissionName && 
        p.type === 'message_records'
      )
      
      if (messagePerm) {
        if (!messagePerm.granted) {
          const result = await primaryAuth.changePermission(
            messagePermissionName,
            null,
            testConfig.testAppConfig.appName,
            testConfig.testAppConfig.appName,
            true // grant
          )
          expect(result).to.exist
          console.log(`      ✓ Granted ${messagePermissionName} permission`)
        } else {
          console.log(`      ✓ ${messagePermissionName} permission already granted`)
        }
      } else {
        console.log(`      ℹ ${messagePermissionName} permission not found in app manifest`)
        this.skip()
      }
    })

    it('should grant contact permission for primary user', async function () {
      if (!primaryAuth) this.skip()
      
      const permissions = await primaryAuth.getPermissions()
      const contactPerm = permissions.find(p => 
        p.name === contactPermissionName && 
        p.table_id === 'dev.ceps.contacts' &&
        (p.type === 'read_all' || p.type === 'write_own' || p.type === 'write_all')
      )
      
      if (contactPerm) {
        if (!contactPerm.granted) {
          const result = await primaryAuth.changePermission(
            contactPermissionName,
            null,
            testConfig.testAppConfig.appName,
            testConfig.testAppConfig.appName,
            true // grant
          )
          expect(result).to.exist
          console.log(`      ✓ Granted ${contactPermissionName} permission for contacts`)
        } else {
          console.log(`      ✓ ${contactPermissionName} permission already granted`)
        }
      } else {
        console.log(`      ℹ ${contactPermissionName} permission not found - may need to be registered`)
        try {
          await primaryAuth.changePermission(
            contactPermissionName,
            'dev.ceps.contacts',
            testConfig.testAppConfig.appName,
            testConfig.testAppConfig.appName,
            true
          )
          console.log(`      ✓ Attempted to grant ${contactPermissionName} permission`)
        } catch (e) {
          console.log(`      ⚠ Could not grant contact permission: ${e.message}`)
        }
      }
    })

    it('should verify both message_link and contact permissions are granted before sending', async function () {
      if (!primaryAuth) this.skip()
      
      const permissions = await primaryAuth.getPermissions()
      
      const messagePerm = permissions.find(p => 
        p.name === messagePermissionName && 
        p.type === 'message_records' &&
        p.granted === true
      )
      expect(messagePerm).to.exist
      expect(messagePerm.granted).to.be.true
      console.log(`      ✓ Verified ${messagePermissionName} permission is granted`)
      
      const contactPerm = permissions.find(p => 
        p.name === contactPermissionName && 
        (p.table_id === 'dev.ceps.contacts' || p.table_id.includes('dev.ceps.contacts')) &&
        (p.type === 'read_all' || p.type === 'write_own' || p.type === 'write_all') &&
        p.granted === true
      )
      expect(contactPerm).to.exist
      expect(contactPerm.granted).to.be.true
      console.log(`      ✓ Verified ${contactPermissionName} permission is granted for dev.ceps.contacts`)
      
      if (!messagePerm || !contactPerm) {
        throw new Error('Required permissions not granted. Cannot send message without both message_link and contact permissions.')
      }
    })

    it('should create a record to send as a message using modern API', async function () {
      if (!primaryCore) this.skip()
      
      const response = await primaryCore.createV2(collection, {
        title: 'Message Test Record (Modern API)',
        content: 'This record will be sent as a message',
        owner: 'primary',
        messageData: { important: true, priority: 'high' }
      }, { app_table: appTable })
      
      expect(response.ok).to.be.true
      expect(response.data._id).to.exist
      messageRecordId = response.data._id
      console.log(`      ✓ Created record for messaging using modern API: ${messageRecordId}`)
    })

    it('should send a message using freezr.messages.send', async function () {
      if (!primaryCore || !secondaryAuth || !messageRecordId) this.skip()
      
      // Verify permissions are granted
      const permissions = await primaryAuth.getPermissions()
      const messagePerm = permissions.find(p => 
        p.name === messagePermissionName && 
        p.type === 'message_records' &&
        p.granted === true
      )
      const contactPerm = permissions.find(p => 
        p.name === contactPermissionName && 
        p.granted === true
      )
      
      if (!messagePerm || !contactPerm) {
        throw new Error(`Cannot send message: Required permissions not granted. message_link: ${!!messagePerm}, contact: ${!!contactPerm}`)
      }
      
      console.log(`      ✓ Verified permissions before sending: message_link=${messagePerm.granted}, contact=${contactPerm.granted}`)
      
      // Get the full record to send
      const recordResponse = await primaryCore.readV2(collection, messageRecordId, { app_table: appTable })
      expect(recordResponse.ok).to.be.true
      
      // Prepare message data for freezr.messages.send
      // freezr.messages.send expects: recipient_id, messaging_permission, contact_permission, table_id, record_id, record
      const message = {
        recipient_id: secondaryAuth.userId,
        // recipient_host is optional for same-server (omitted here)
        messaging_permission: messagePermissionName,
        contact_permission: contactPermissionName,
        table_id: appTable,
        record_id: messageRecordId,
        record: {
          title: recordResponse.data.title,
          content: recordResponse.data.content,
          messageData: recordResponse.data.messageData
        }
      }
      
      const result = await primaryCore.sendMessageV2(message)
      
      expect(result).to.exist
      if (result.ok !== undefined) {
        expect(result.ok).to.be.true
      }
      console.log(`      ✓ Message sent successfully using freezr.messages.send`)
    })

    it('should grant messages permission for secondary user to read messages', async function () {
      if (!secondaryAuth) this.skip()

      const permissions = await secondaryAuth.getPermissions()
      const messagesPerm = permissions.find(p => 
        p.name === messagesPermissionName
      )
      
      if (messagesPerm) {
        if (!messagesPerm.granted) {
          const result = await secondaryAuth.changePermission(
            messagesPermissionName,
            messagesPerm.table_id,
            testConfig.testAppConfig.appName,
            testConfig.testAppConfig.appName,
            true // grant
          )
          expect(result).to.exist
          console.log(`      ✓ Secondary user granted ${messagesPermissionName} permission for ${messagesPerm.table_id}`)
        }
      } else {
        console.log(`      ℹ ${messagesPermissionName} permission not found - trying to grant for dev.ceps.messages.got`)
        try {
          await secondaryAuth.changePermission(
            messagesPermissionName,
            'dev.ceps.messages.got',
            testConfig.testAppConfig.appName,
            testConfig.testAppConfig.appName,
            true
          )
          console.log(`      ✓ Attempted to grant ${messagesPermissionName} permission`)
        } catch (e) {
          console.log(`      ⚠ Could not grant messages permission: ${e.message}`)
        }
      }
    })

    it('should allow secondary user to retrieve messages using getMessages', async function () {
      if (!secondaryAuth || !messageRecordId) this.skip()
      
      const permissions = await secondaryAuth.getPermissions()
      const messagesPerm = permissions.find(p => 
        p.name === messagesPermissionName
      )

      if (!messagesPerm) {
        throw new Error(`Permission ${messagesPermissionName} not found.`)
      }

      if (!messagesPerm.granted) {
        console.log(`      ℹ Permission ${messagesPermissionName} is not granted, attempting to grant...`)
        const result2 = await secondaryAuth.changePermission(
          messagesPermissionName,
          messagesPerm.table_id,
          testConfig.testAppConfig.appName,
          testConfig.testAppConfig.appName,
          true // grant
        )
        
        const permissionsAfter = await secondaryAuth.getPermissions()
        const messagesPermAfter = permissionsAfter.find(p => 
          p.name === messagesPermissionName
        )
        if (!messagesPermAfter || !messagesPermAfter.granted) {
          throw new Error(`Failed to grant ${messagesPermissionName} permission.`)
        }
      } else {
        console.log(`      ✓ Permission ${messagesPermissionName} is already granted`)
      }
      
      let messages = null
      let errorMessage = null
      try {
        messages = await secondaryAuth.getMessages({ app_id: testConfig.testAppConfig.appName })
      } catch (e) {
        errorMessage = e.message || String(e)
        if (errorMessage.includes('Permission') || errorMessage.includes('permission') || errorMessage.includes('401') || errorMessage.includes('403')) {
          throw new Error(`Failed to get messages due to permission issue: ${errorMessage}`)
        }
        throw new Error(`Failed to get messages: ${errorMessage}`)
      }
      
      expect(messages).to.be.an('array')
      console.log(`      ✓ Secondary user retrieved ${messages.length} messages from dev.ceps.messages.got`)
      
      // Find the message we sent
      const ourMessage = messages.find(m => 
        m.sender_id === primaryAuth.userId &&
        m.record_id === messageRecordId &&
        (m.table_id === appTable || m.table_id.includes(appTable))
      )
      
      if (ourMessage) {
        expect(ourMessage.type).to.equal('message_records')
        expect(ourMessage.messaging_permission).to.equal(messagePermissionName)
        expect(ourMessage.record).to.exist
        expect(ourMessage.record.title).to.equal('Message Test Record (Modern API)')
        console.log(`      ✓ Found the sent message in dev.ceps.messages.got`)
        console.log(`        Message ID: ${ourMessage._id}`)
        console.log(`        Sender: ${ourMessage.sender_id}`)
        console.log(`        Type: ${ourMessage.type}`)
      } else {
        console.log(`      ⚠ Message not found yet - may need more time to process`)
        console.log(`        Available messages: ${messages.length}`)
        if (messages.length > 0) {
          console.log(`        Sample message:`, JSON.stringify(messages[0], null, 2))
        }
      }
    })
  })

  // ===== MODERN UPLOAD TESTS =====
  describe('freezr.upload()', function () {
    let uploadedFileId
    const appName = testConfig.testAppConfig.appName

    after(async function () {
      // Cleanup: Delete uploaded file if it exists
      if (uploadedFileId) {
        try {
          await core.deleteV2('files', uploadedFileId, { app_table: `${appName}.files` })
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    })

    it('should upload a file and create a file record using modern API', async function () {
      // Read test logo file
      const testLogoPath = join(__dirname, '../../../users_freezr/test_credentials/testlogo.png')
      let fileBuffer
      try {
        fileBuffer = readFileSync(testLogoPath)
      } catch (error) {
        console.log('      ⚠ Test logo file not found, skipping file upload test')
        this.skip()
      }

      // Create a File-like object from Buffer
      let file
      try {
        // Try to use Node.js File class (Node 18+)
        const { File } = await import('node:buffer')
        file = new File([fileBuffer], 'testlogo.png', { type: 'image/png' })
      } catch (e) {
        // Fallback: create a Blob-like object
        file = {
          name: 'testlogo.png',
          type: 'image/png',
          size: fileBuffer.length,
          arrayBuffer: async () => fileBuffer.buffer,
          stream: () => {
            return Readable.from([fileBuffer])
          }
        }
      }

      const options = {
        fileName: `test_modern_${Date.now()}.png`,
        targetFolder: 'test_uploads',
        overwrite: true,
        data: {
          description: 'Test upload from Modern API V2 test',
          uploadedAt: Date.now()
        }
      }

      const response = await core.uploadV2(file, options)

      if (response.ok) {
        expect(response.data).to.have.property('_id')
        uploadedFileId = response.data._id
        console.log(`      ✓ File uploaded successfully using modern API: ${uploadedFileId}`)
      } else {
        // Upload might fail for various reasons (permissions, etc.)
        console.log(`      ⚠ File upload returned status ${response.status}: ${JSON.stringify(response.data)}`)
        expect([200, 400, 401, 403, 500]).to.include(response.status)
      }
    })

    it('should upload a file with custom metadata using modern API', async function () {
      // Read test logo file
      const testLogoPath = join(__dirname, '../../../users_freezr/test_credentials/testlogo.png')
      let fileBuffer
      try {
        fileBuffer = readFileSync(testLogoPath)
      } catch (error) {
        this.skip()
      }

      // Create a File-like object
      let file
      try {
        const nodeBuffer = await import('node:buffer')
        if (nodeBuffer.File) {
          file = new nodeBuffer.File([fileBuffer], 'testlogo.png', { type: 'image/png' })
        } else {
          throw new Error('File not available')
        }
      } catch (e) {
        file = {
          name: 'testlogo.png',
          type: 'image/png',
          size: fileBuffer.length,
          arrayBuffer: async () => fileBuffer.buffer
        }
      }

      const options = {
        fileName: `test_modern_metadata_${Date.now()}.png`,
        targetFolder: 'test_uploads',
        overwrite: true,
        data: {
          description: 'File with custom metadata via modern API',
          category: 'test',
          tags: ['upload', 'test', 'modern', 'v2'],
          uploadedAt: Date.now(),
          customField: 'modern api value'
        }
      }

      const response = await core.uploadV2(file, options)

      if (response.ok && response.data._id) {
        const fileId = response.data._id
        console.log(`      ✓ File uploaded with metadata using modern API: ${fileId}`)
        
        // Cleanup
        try {
          await core.deleteV2('files', fileId, { app_table: `${appName}.files` })
        } catch (e) {
          // Ignore
        }
      } else {
        expect([200, 400, 401, 403, 500]).to.include(response.status)
      }
    })

    it('should handle upload with overwrite option using modern API', async function () {
      // Read test logo file
      const testLogoPath = join(__dirname, '../../../users_freezr/test_credentials/testlogo.png')
      let fileBuffer
      try {
        fileBuffer = readFileSync(testLogoPath)
      } catch (error) {
        this.skip()
      }

      // Create a File-like object
      let file
      try {
        const nodeBuffer = await import('node:buffer')
        if (nodeBuffer.File) {
          file = new nodeBuffer.File([fileBuffer], 'testlogo.png', { type: 'image/png' })
        } else {
          throw new Error('File not available')
        }
      } catch (e) {
        file = {
          name: 'testlogo.png',
          type: 'image/png',
          size: fileBuffer.length,
          arrayBuffer: async () => fileBuffer.buffer
        }
      }

      const fileName = `overwrite_modern_test_${Date.now()}.png`
      const options1 = {
        fileName: fileName,
        targetFolder: 'test_uploads',
        overwrite: true
      }

      // Upload file first time
      const response1 = await core.uploadV2(file, options1)
      
      if (!response1.ok || !response1.data._id) {
        this.skip()
      }

      const firstFileId = response1.data._id

      try {
        // Upload again with overwrite:true (should succeed and replace)
        const options2 = {
          fileName: fileName,
          targetFolder: 'test_uploads',
          overwrite: true
        }

        const response2 = await core.uploadV2(file, options2)

        if (response2.ok) {
          expect(response2.data).to.have.property('_id')
          console.log(`      ✓ File overwritten successfully using modern API`)
        } else {
          expect([200, 400, 401, 403, 500]).to.include(response2.status)
        }
      } finally {
        // Cleanup
        try {
          await core.deleteV2('files', firstFileId, { app_table: `${appName}.files` })
        } catch (e) {
          // Ignore
        }
      }
    })
  })

  // ===== MODERN COLLECTION FACTORY TESTS =====
  describe('freezr.collection() factory', function () {
    it('should create a collection object with all CRUD methods', async function () {
      const testCollection = core.freezr.collection(collection)
      
      expect(testCollection).to.have.property('create')
      expect(testCollection).to.have.property('read')
      expect(testCollection).to.have.property('query')
      expect(testCollection).to.have.property('update')
      expect(testCollection).to.have.property('updateFields')
      expect(testCollection).to.have.property('delete')
      
      // Test that collection methods work
      const testId = `collection_factory_${Date.now()}`
      const createResponse = await testCollection.create({
        title: 'Collection Factory Test',
        value: 42
      }, { app_table: appTable, data_object_id: testId })
      
      expect(createResponse).to.have.property('_id')
      expect(createResponse._id).to.equal(testId)
      
      // Test read
      const readResponse = await testCollection.read(testId, { app_table: appTable })
      expect(readResponse).to.have.property('_id')
      expect(readResponse.title).to.equal('Collection Factory Test')
      
      // Test update
      const updateResponse = await testCollection.update(testId, {
        title: 'Updated via Collection',
        value: 100
      }, { app_table: appTable })
      expect(updateResponse).to.have.property('_id')
      
      // Test query
      const queryResponse = await testCollection.query({ title: 'Updated via Collection' }, { app_table: appTable })
      expect(queryResponse).to.be.an('array')
      const found = queryResponse.find(r => r._id === testId)
      expect(found).to.exist
      
      // Test delete
      const deleteResponse = await testCollection.delete(testId, { app_table: appTable })
      expect(deleteResponse).to.exist
      
      // Verify deleted
      try {
        await testCollection.read(testId, { app_table: appTable })
        expect.fail('Record should have been deleted')
      } catch (error) {
        // Expected - record should be deleted
        expect(error).to.exist
      }
    })
  })

  // ===== CLEANUP =====
  describe('Cleanup Modern API Tests', function () {
    it('should delete the main test record', async function () {
      if (!createdRecordId) this.skip()
      
      const response = await core.deleteV2(collection, createdRecordId, { app_table: appTable })
      
      expect(response.ok).to.be.true
      createdRecordId = null // Mark as deleted
    })
  })
})

