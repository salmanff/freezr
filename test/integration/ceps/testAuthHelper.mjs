/**
 * Test Authentication Helper
 * Handles login, session management, and token extraction for integration tests
 * 
 * CEPS 2.0 Baseline Authentication Flow:
 *   1. Login to get session cookie and account token
 *   2. Generate app password using account token via /acctapi/generateAppPassword
 *   3. Exchange app password for access token via /oauth/token
 *   4. Use access token as Bearer token for CEPS calls
 * 
 * Usage:
 *   import { TestAuthHelper } from './testAuthHelper.mjs'
 *   const auth = new TestAuthHelper(serverUrl)
 *   await auth.loginAndSetupApp('testuser1', 'testpass1', 'com.test.ceps')
 *   const headers = auth.getAuthHeaders()
 */

import fetch from 'node-fetch'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Load test credentials from the credentials file
 * @param {string} credentialsPath - Path to credentials file (optional)
 * @returns {object} Parsed credentials
 */
export function loadTestCredentials(credentialsPath = null) {
  const defaultPath = join(__dirname, '../../../users_freezr/test_credentials/testUserCreds.json')
  const path = credentialsPath || defaultPath
  
  try {
    const content = readFileSync(path, 'utf-8')
    return JSON.parse(content)
  } catch (error) {
    throw new Error(`Failed to load test credentials from ${path}: ${error.message}`)
  }
}

/**
 * TestAuthHelper class for managing authentication in tests
 */
export class TestAuthHelper {
  constructor(serverUrl = 'http://localhost:3000') {
    this.serverUrl = serverUrl.replace(/\/$/, '') // Remove trailing slash
    this.cookies = {}
    this.appTokens = {} // Structure: { userId: { appName: token } }
    this.userId = null
    this.appName = null
    this.isLoggedIn = false
  }
  
  /**
   * Get the current app token for the active user and app
   * @returns {string|null} App token or null
   */
  getCurrentAppToken() {
    if (!this.userId || !this.appName) return null
    return this.appTokens[this.userId]?.[this.appName] || null
  }
  
  /**
   * Set app token for a specific user and app
   * @param {string} userId - User ID
   * @param {string} appName - App name
   * @param {string} token - Token value
   */
  setAppToken(userId, appName, token) {
    if (!this.appTokens[userId]) {
      this.appTokens[userId] = {}
    }
    this.appTokens[userId][appName] = token
  }

  /**
   * Parse Set-Cookie headers and store cookies
   * @param {Headers} headers - Response headers
   * @param {string} contextApp - The app context for this token (optional, defaults to this.appName)
   */
  parseCookies(headers, contextApp = null) {
    // console.log(`    Parsing cookies from headers: `, JSON.stringify(headers.raw()))
    const setCookieHeaders = headers.raw()['set-cookie'] || []
    const targetApp = contextApp || this.appName
    
    for (const cookieStr of setCookieHeaders) {
      // Parse cookie name=value; other attributes
      const parts = cookieStr.split(';')[0].trim()
      const [name, ...valueParts] = parts.split('=')
      const value = valueParts.join('=') // Handle values with = in them
      
      if (name && value) {
        // Don't store empty or deleted cookies
        if (value === '' || value === 'deleted') {
          console.log(`      Cookie ${name} was cleared/deleted`)
          continue
        }
        
        // Store in cookies collection
        const oldValue = this.cookies[name]
        const isNewValue = oldValue !== value
        this.cookies[name] = value

        // console.log(`    GOT  Cookie ${name} = ${value}`)
        
        // Check if this is an app_token cookie for our user
        if (name === `app_token_${this.userId}` && this.userId && targetApp) {
          this.setAppToken(this.userId, targetApp, value)
          console.log(`      Got app_token for ${this.userId}/${targetApp}${isNewValue && oldValue ? ' (UPDATED)' : ''}`)
        } else if (name === `app_token_${this.userId}`) { 
          console.log(`      Got app_token for ${this.userId} WHAT TARGET??  = ${value}`) 
        }
      }
    }
  }

  /**
   * Get cookie header string for requests
   * @returns {string} Cookie header value
   */
  getCookieHeader() {
    return Object.entries(this.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ')
  }

  /**
   * Login to the freezr server
   * @param {string} userId - User ID
   * @param {string} password - Password
   * @returns {Promise<object>} Login response
   */
  async login(userId, password) {
    this.userId = userId // Set early so parseCookies can find the right token
    
    const response = await fetch(`${this.serverUrl}/acctapi/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ user_id: userId, password })
    })

    // Store cookies from response - login creates an account token for 'info.freezr.account'
    this.parseCookies(response.headers, 'info.freezr.account')
    
    const data = await response.json()
    
    if (response.ok && data.logged_in) {
      this.isLoggedIn = true
    } else {
      this.userId = null
    }
    
    return {
      success: response.ok && data.logged_in,
      status: response.status,
      data,
      cookies: this.cookies
    }
  }

  /**
   * Generate an app password using the account token
   * @param {string} appName - App name (e.g., 'com.test.ceps')
   * @param {number} daysExpiry - Expiry in days (default: 90)
   * @returns {Promise<object>} Result with app_password
   */
  async generateAppPassword(appName, daysExpiry = 90) {
    // Get account token for authentication - try appTokens first, then cookies
    let accountToken = this.appTokens[this.userId]?.['info.freezr.account']
    if (!accountToken && this.userId) {
      // Fallback to cookie if not in appTokens structure
      accountToken = this.cookies[`app_token_${this.userId}`]
      if (accountToken) {
        // Store it in appTokens for future use
        this.setAppToken(this.userId, 'info.freezr.account', accountToken)
      }
    }
    
    if (!accountToken) {
      throw new Error('Account token not available. Please login first.')
    }

    const expiry = new Date().getTime() + (daysExpiry * 24 * 3600 * 1000)
    const url = `${this.serverUrl}/acctapi/generateAppPassword?app_name=${encodeURIComponent(appName)}&expiry=${expiry}&one_device=false`
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accountToken}`,
        'Cookie': this.getCookieHeader()
      }
    })

    const data = await this.parseResponseBody(response)
    
    if (!response.ok || !data.app_password) {
      throw new Error(`Failed to generate app password: ${data.error || data.message || 'Unknown error'}`)
    }

    return { app_password: data.app_password, app_name: data.app_name || appName }
  }

  /**
   * Exchange app password for access token via OAuth
   * @param {string} appPassword - App password from generateAppPassword
   * @param {string} appName - App name (e.g., 'com.test.ceps')
   * @returns {Promise<object>} Result with access_token
   */
  async exchangeAppPasswordForToken(appPassword, appName) {
    const url = `${this.serverUrl}/oauth/token`
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        username: this.userId,
        password: appPassword,
        client_id: appName,
        grant_type: 'password'
      })
    })

    const data = await this.parseResponseBody(response)
    
    if (!response.ok || !data.access_token) {
      throw new Error(`Failed to exchange app password for token: ${data.error || data.message || 'Unknown error'}`)
    }

    return { access_token: data.access_token, app_name: data.app_name || appName }
  }

  /**
   * Normalize GitHub URL to zip download URL
   * @param {string} url - GitHub repository URL
   * @returns {string} Normalized URL pointing to zip file
   */
  normalizeGithubUrl(url) {
    if (url && url.startsWith('https://github.com/') && (url.match(/\//g) || []).length === 4 && !url.endsWith('.zip')) {
      return url + '/archive/main.zip'
    }
    return url
  }

  /**
   * Install an app from URL
   * @param {string} appUrl - URL to download app zip file from
   * @param {string} appName - Name of the app to install
   * @returns {Promise<object>} Installation result
   */
  async installAppFromUrl(appUrl, appName) {
    // Get account token for authentication
    let accountToken = this.appTokens[this.userId]?.['info.freezr.account']
    if (!accountToken && this.userId) {
      accountToken = this.cookies[`app_token_${this.userId}`]
      if (accountToken) {
        this.setAppToken(this.userId, 'info.freezr.account', accountToken)
      }
    }
    
    if (!accountToken) {
      throw new Error('Account token not available. Please login first.')
    }

    // Normalize GitHub URLs
    const normalizedUrl = this.normalizeGithubUrl(appUrl)
    
    const url = `${this.serverUrl}/acctapi/app_install_from_url`
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accountToken}`,
        'Cookie': this.getCookieHeader()
      },
      body: JSON.stringify({
        app_url: normalizedUrl,
        app_name: appName
      })
    })

    const data = await this.parseResponseBody(response)
    
    if (!response.ok) {
      throw new Error(`Failed to install app from URL: ${data.error || data.message || data.err || 'Unknown error'}`)
    }

    return data
  }

  /**
   * Get app permissions using app access token
   * @param {string} tableId - Optional table ID to filter permissions
   * @param {string} name - Optional permission name to filter
   * @returns {Promise<array>} Array of permission objects
   */
  async getPermissions(tableId = null, name = null) {
    const appToken = this.getCurrentAppToken()
    if (!appToken) {
      throw new Error('App token not available. Please login and setup app first.')
    }

    let url = `${this.serverUrl}/ceps/perms/get`
    const params = []
    if (tableId) params.push(`table-id=${encodeURIComponent(tableId)}`)
    if (name) params.push(`name=${encodeURIComponent(name)}`)
    if (params.length > 0) url += '?' + params.join('&')

    // console.log(`      Getting permissions from ${url}`)
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${appToken}`,
        'Cookie': this.getCookieHeader()
      }
    })

    const data = await this.parseResponseBody(response)

    // console.log(`      Permissions response`, { data })
    
    if (!response.ok) {
      throw new Error(`Failed to get permissions: ${data.error || data.message || 'Unknown error'}`)
    }

    // CEPS spec says response should be an array
    if (!Array.isArray(data)) {
      throw new Error(`Invalid permissions response format: expected array, got ${typeof data}`)
    }

    return data
  }

  /**
   * Grant or deny a permission using account access token
   * @param {string} permissionName - Name of the permission
   * @param {string} tableId - Table ID for the permission
   * @param {string} requestorApp - App requesting the permission
   * @param {string} targetApp - Target app (usually same as requestorApp)
   * @param {boolean} grant - true to grant (Accept), false to deny (Deny)
   * @returns {Promise<object>} Result of the permission change
   */
  async changePermission(permissionName, tableId, requestorApp, targetApp, grant = true) {
    // if (!tableId) {
    //   throw new Error('tableId is required for changing permissions')
    // }
    
    // Get account token for authentication
    let accountToken = this.appTokens[this.userId]?.['info.freezr.account']
    if (!accountToken && this.userId) {
      accountToken = this.cookies[`app_token_${this.userId}`]
      if (accountToken) {
        this.setAppToken(this.userId, 'info.freezr.account', accountToken)
      }
    }
    
    if (!accountToken) {
      throw new Error('Account token not available. Please login first.')
    }

    const url = `${this.serverUrl}/feps/permissions/change`
    
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accountToken}`,
        'Cookie': this.getCookieHeader()
      },
      body: JSON.stringify({
        change: {
          name: permissionName,
          table_id: tableId,
          requestor_app: requestorApp,
          action: grant ? 'Accept' : 'Deny'
        },
        targetApp: targetApp
      })
    })

    const data = await this.parseResponseBody(response)

    if (!response.ok) {
      throw new Error(`Failed to change permission: ${data.error || data.message || 'Unknown error'}`)
    }

    return data
  }

  /**
   * Send a message using CEPS message API
   * @param {string} recipientId - Recipient user ID
   * @param {string} recipientHost - Recipient host (optional, null for same server)
   * @param {string} tableId - Table ID of the record
   * @param {string} recordId - Record ID to send
   * @param {string} messagingPermission - Name of messaging permission (e.g., 'message_link')
   * @param {string} contactPermission - Name of contact permission
   * @param {object} record - The record data to send (for message_records)
   * @param {string} message - Optional text message
   * @returns {Promise<object>} Message initiation result
   */
  async sendMessage(recipientId, recipientHost, tableId, recordId, messagingPermission, contactPermission, record, message = null) {
    const appToken = this.getCurrentAppToken()
    if (!appToken) {
      throw new Error('App token not available. Please login and setup app first.')
    }

    const url = `${this.serverUrl}/ceps/message/initiate`
    
    // For same server, recipient_host can be omitted or set to sender_host
    const messageData = {
      app_id: this.appName,
      sender_id: this.userId,
      sender_host: this.serverUrl,
      type: 'message_records',
      recipient_id: recipientId,
      table_id: tableId,
      record_id: recordId,
      messaging_permission: messagingPermission,
      contact_permission: contactPermission,
      record: record
    }
    
    // Only include recipient_host if it's different from sender_host
    if (recipientHost && recipientHost !== this.serverUrl) {
      messageData.recipient_host = recipientHost
    }
    
    if (message) {
      messageData.message = message
    }
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${appToken}`,
        'Cookie': this.getCookieHeader()
      },
      body: JSON.stringify(messageData)
    })

    const data = await this.parseResponseBody(response)

    // console.log(`      Message response`, { messageData, url, data })
    
    if (!response.ok) {
      throw new Error(`Failed to initiate message: ${data.error || data.message || data.err || 'Unknown error'}`)
    }

    return data
  }

  /**
   * Transmit a message (usually called by server, but available for testing)
   * @param {object} messageData - Message data to transmit
   * @returns {Promise<object>} Transmission result
   */
  async transmitMessage(messageData) {
    const appToken = this.getCurrentAppToken()
    if (!appToken) {
      throw new Error('App token not available. Please login and setup app first.')
    }

    const url = `${this.serverUrl}/ceps/message/transmit`
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${appToken}`,
        'Cookie': this.getCookieHeader()
      },
      body: JSON.stringify(messageData)
    })

    const data = await this.parseResponseBody(response)
    
    if (!response.ok) {
      throw new Error(`Failed to transmit message: ${data.error || data.message || 'Unknown error'}`)
    }

    return data
  }

  /**
   * Verify a message (usually called by server, but available for testing)
   * @param {object} messageData - Message data to verify
   * @returns {Promise<object>} Verification result
   */
  async verifyMessage(messageData) {
    const appToken = this.getCurrentAppToken()
    if (!appToken) {
      throw new Error('App token not available. Please login and setup app first.')
    }

    const url = `${this.serverUrl}/ceps/message/verify`
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${appToken}`,
        'Cookie': this.getCookieHeader()
      },
      body: JSON.stringify(messageData)
    })

    const data = await this.parseResponseBody(response)
    
    if (!response.ok) {
      throw new Error(`Failed to verify message: ${data.error || data.message || 'Unknown error'}`)
    }

    return data
  }

  /**
   * Query messages from dev.ceps.messages.got table
   * @param {object} filters - Optional filters (e.g., { app_id: 'com.test.app' })
   * @returns {Promise<array>} Array of received messages
   */
  async getMessages(filters = {}) {
    const appToken = this.getCurrentAppToken()
    if (!appToken) {
      throw new Error('App token not available. Please login and setup app first.')
    }

    let url = `${this.serverUrl}/ceps/query/dev.ceps.messages.got`
    const params = []
    Object.keys(filters).forEach(key => {
      params.push(`${key}=${encodeURIComponent(filters[key])}`)
    })
    if (params.length > 0) url += '?' + params.join('&')
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${appToken}`,
        'Cookie': this.getCookieHeader()
      }
    })

    const data = await this.parseResponseBody(response)
    
    if (!response.ok) {
      throw new Error(`Failed to get messages: ${data.error || data.message || 'Unknown error'}`)
    }

    // CEPS spec says response should be an array
    if (!Array.isArray(data)) {
      throw new Error(`Invalid messages response format: expected array, got ${typeof data}`)
    }

    return data
  }

  /**
   * Deny (ungrant) all permissions for an app
   * @param {string} appName - App name
   * @returns {Promise<array>} Array of denied permissions
   */
  async denyAllPermissions(appName) {
    // Get all permissions first
    const permissions = await this.getPermissions()
    
    // Filter permissions for this app that are granted
    const appPermissions = permissions.filter(p => 
      p.requestor_app === appName && p.granted === true
    )
    
    const denied = []
    
    // Deny each granted permission
    for (const perm of appPermissions) {
      try {
        await this.changePermission(
          perm.name,
          perm.table_id,
          appName,
          appName,
          false // deny
        )
        denied.push(perm)
        console.log(`      ✓ Denied permission: ${perm.name} for table ${perm.table_id}`)
      } catch (error) {
        console.error(`      ✗ Failed to deny permission ${perm.name}: ${error.message}`)
      }
    }
    
    return denied
  }

  /**
   * Login and set up the test app to get a valid app token
   * This is the main entry point for test authentication
   * 
   * Uses CEPS 2.0 baseline authentication flow:
   * 1. Login to get account token
   * 2. Generate app password using account token
   * 3. Exchange app password for access token via /oauth/token
   * 
   * @param {string} userId - User ID
   * @param {string} password - Password
   * @param {string} appName - App name (e.g., 'com.test.ceps')
   * @returns {Promise<object>} Setup result
   */
  async loginAndSetupApp(userId, password, appName) {
    this.appName = appName
    
    // Step 1: Login (gets session cookie AND an account token)
    const loginResult = await this.login(userId, password)
    if (!loginResult.success) {
      return { success: false, error: 'Login failed', details: loginResult }
    }
    console.log(`      ✓ Logged in as ${userId}`)

    // Step 2: Generate app password using account token
    let appPasswordResult
    try {
      appPasswordResult = await this.generateAppPassword(appName, 90)
      console.log(`      ✓ Generated app password for ${appName}`)
    } catch (error) {
      console.error(`      ✗ Failed to generate app password: ${error.message}`)
      return { success: false, error: 'Failed to generate app password', details: error.message }
    }

    // Step 3: Exchange app password for access token
    let tokenResult
    try {
      tokenResult = await this.exchangeAppPasswordForToken(appPasswordResult.app_password, appName)
      console.log(`      ✓ Exchanged app password for access token`)
    } catch (error) {
      console.error(`      ✗ Failed to exchange app password for token: ${error.message}`)
      return { success: false, error: 'Failed to exchange app password for token', details: error.message }
    }

    // Step 4: Store the access token
    this.setAppToken(this.userId, appName, tokenResult.access_token)
    const currentToken = this.getCurrentAppToken()
    
    if (!currentToken) {
      console.error('\n')
      console.error('  ⚠️  FAILED TO STORE APP TOKEN ⚠️')
      console.error('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      console.error(`  User: ${this.userId}`)
      console.error(`  App: ${this.appName}`)
      console.error('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      console.error('\n')
      return { success: false, error: 'Failed to store app token' }
    }
    
    console.log(`      ✓ Got app token for ${appName}`)
    // console.log(`      Token value (first 20 chars): ${currentToken.substring(0, 20)}...`)

    return { success: true, userId, appName, hasToken: !!currentToken }
  }

  /**
   * Get the account app token by visiting the account home page
   * This is required before making account API calls
   */
  async getAccountToken() {
    // Visit account home to get the account app token
    const response = await fetch(`${this.serverUrl}/account/home`, {
      method: 'GET',
      headers: {
        'Cookie': this.getCookieHeader()
      },
      redirect: 'manual'
    })
    this.parseCookies(response.headers)
    
    // Follow redirect if needed
    if (response.headers.get('location')) {
      const redirectUrl = response.headers.get('location')
      if (!redirectUrl.includes('/login')) { // Don't follow login redirects
        const fullUrl = redirectUrl.startsWith('http') ? redirectUrl : `${this.serverUrl}${redirectUrl}`
        const redirectResponse = await fetch(fullUrl, {
          method: 'GET',
          headers: {
            'Cookie': this.getCookieHeader()
          },
          redirect: 'manual'
        })
        this.parseCookies(redirectResponse.headers)
      }
    }
    
    return this.cookies[`app_token_${this.userId}`]
  }

  /**
   * Install a blank app using the account API
   * @param {string} appName - App name to install
   */
  async installApp(appName) {
    // First, get the account token
    const accountToken = await this.getAccountToken()
    
    if (!accountToken) {
      console.log('      ⚠ Could not get account token, app may already exist')
      return { status: 0, data: { error: 'no account token' } }
    }
    
    // Try to install the app
    const response = await fetch(`${this.serverUrl}/acctapi/app_install_served`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': this.getCookieHeader(),
        'Authorization': `Bearer ${accountToken}`
      },
      body: JSON.stringify({ 
        app_name: appName
      })
    })
    
    this.parseCookies(response.headers)
    
    // It's OK if app already exists - we just need it to be installed
    let data
    try {
      data = await response.json()
    } catch (e) {
      data = { status: response.status }
    }
    
    // Log result
    if (response.ok) {
      console.log(`      ✓ App ${appName} installed successfully`)
    } else if (data.message && data.message.includes('already exists')) {
      console.log(`      ✓ App ${appName} already exists`)
    } else {
      console.log(`      ⚠ Install response: ${response.status} - ${JSON.stringify(data)}`)
    }
    
    return { status: response.status, data }
  }

  /**
   * Visit an app page to trigger app token generation
   * The app token is set as a cookie when visiting /apps/<appName>
   * @param {string} appName - App name to visit
   */
  async visitAppPage(appName) {
    this.appName = appName // Track which app we're getting token for
    
    const url = `${this.serverUrl}/apps/${appName}`
    console.log(`      Visiting: ${url}`)
    
    // Visit the app page - this generates the app_token cookie
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Cookie': this.getCookieHeader()
      },
      redirect: 'manual' // Don't follow redirects, we just want the cookies
    })
    
    console.log(`      Response status: ${response.status}`)
    console.log(`      Response location: ${response.headers.get('location') || 'none'}`)
    
    this.parseCookies(response.headers)
    
    // Always follow redirects to make sure we get the app token
    if (response.headers.get('location')) {
      const redirectUrl = response.headers.get('location')
      const fullUrl = redirectUrl.startsWith('http') ? redirectUrl : `${this.serverUrl}${redirectUrl}`
      
      console.log(`      Following redirect to: ${fullUrl}`)
      const redirectResponse = await fetch(fullUrl, {
        method: 'GET',
        headers: {
          'Cookie': this.getCookieHeader()
        },
        redirect: 'manual'
      })
      
      console.log(`      Redirect response status: ${redirectResponse.status}`)
      this.parseCookies(redirectResponse.headers, this.appName)
      
      // Check for 500 error without getting a token for THIS app - likely means test mode is not enabled
      const tokenForThisApp = this.getCurrentAppToken()
      if (redirectResponse.status === 500 && !tokenForThisApp) {
        console.error('\n')
        console.error('  ⚠️  ⚠️  ⚠️  IMPORTANT WARNING ⚠️  ⚠️  ⚠️')
        console.error('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        console.error('  ')
        console.error(`  Got 500 error when visiting app page for ${this.appName}!`)
        console.error('  This usually means the server is NOT running in TEST MODE.')
        console.error('  ')
        console.error('  🔧 FIX: Start the server with:')
        console.error('     npm run devtest')
        console.error('  ')
        console.error('  (Not just "npm run dev" - you need "devtest"!)')
        console.error('  ')
        console.error('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        console.error('\n')
      }
    }
    
    return { hasToken: !!this.getCurrentAppToken() }
  }

  /**
   * Get headers for authenticated API requests
   * @returns {object} Headers object with Authorization and Cookie
   */
  getAuthHeaders() {
    const token = this.getCurrentAppToken()
    
    if (!token) {
      console.warn('\n⚠️  Warning: No app token available for this user/app combination!')
      console.warn(`   User: ${this.userId || 'none'}`)
      console.warn(`   App: ${this.appName || 'none'}`)
      console.warn(`   Available tokens:`, JSON.stringify(this.appTokens, null, 2))
      console.warn('   MAKE SURE THAT YOU ARE RUNNING npm run devtest\n')
    }
    
    return {
      'Content-Type': 'application/json',
      'Authorization': token ? `Bearer ${token}` : '',
      'Cookie': this.getCookieHeader()
    }
  }

  /**
   * Parse response body - tries JSON first, falls back to text
   */
  async parseResponseBody(response) {
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch (e) {
      return text
    }
  }

  /**
   * Make an authenticated GET request
   * @param {string} endpoint - API endpoint (e.g., '/ceps/ping')
   * @returns {Promise<object>} Response with status and data
   */
  async get(endpoint) {
    const url = `${this.serverUrl}${endpoint}`
    const response = await fetch(url, {
      method: 'GET',
      headers: this.getAuthHeaders()
    })
    
    this.parseCookies(response.headers)
    const data = await this.parseResponseBody(response)
    
    return { status: response.status, ok: response.ok, data }
  }

  /**
   * Make an authenticated POST request
   * @param {string} endpoint - API endpoint
   * @param {object} body - Request body
   * @returns {Promise<object>} Response with status and data
   */
  async post(endpoint, body = {}) {
    const url = `${this.serverUrl}${endpoint}`
    const headers = this.getAuthHeaders()
    
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })
    
    this.parseCookies(response.headers)
    const data = await this.parseResponseBody(response)
    
    return { status: response.status, ok: response.ok, data }
  }

  /**
   * Make an authenticated PUT request
   * @param {string} endpoint - API endpoint
   * @param {object} body - Request body
   * @returns {Promise<object>} Response with status and data
   */
  async put(endpoint, body = {}) {
    const url = `${this.serverUrl}${endpoint}`
    const response = await fetch(url, {
      method: 'PUT',
      headers: this.getAuthHeaders(),
      body: JSON.stringify(body)
    })
    
    this.parseCookies(response.headers)
    const data = await this.parseResponseBody(response)
    
    return { status: response.status, ok: response.ok, data }
  }

  /**
   * Make an authenticated DELETE request
   * @param {string} endpoint - API endpoint
   * @returns {Promise<object>} Response with status and data
   */
  async delete(endpoint) {
    const url = `${this.serverUrl}${endpoint}`
    const response = await fetch(url, {
      method: 'DELETE',
      headers: this.getAuthHeaders()
    })
    
    this.parseCookies(response.headers)
    const data = await this.parseResponseBody(response)
    
    return { status: response.status, ok: response.ok, data }
  }

  /**
   * Logout and clear session
   */
  async logout() {
    if (this.isLoggedIn) {
      try {
        await this.post('/acctapi/applogout')
      } catch (e) {
        // Ignore logout errors
      }
    }
    
    this.cookies = {}
    this.appTokens = {}
    this.userId = null
    this.appName = null
    this.isLoggedIn = false
  }

  /**
   * Get current auth state for debugging
   */
  getState() {
    return {
      serverUrl: this.serverUrl,
      userId: this.userId,
      appName: this.appName,
      isLoggedIn: this.isLoggedIn,
      currentAppToken: this.getCurrentAppToken(),
      allAppTokens: this.appTokens,
      cookieCount: Object.keys(this.cookies).length
    }
  }
}

/**
 * Create a pre-configured auth helper from credentials file
 * This handles the full setup: login, app installation, and token acquisition
 * 
 * @param {string} userKey - Key in users object (e.g., 'primary', 'secondary')
 * @param {string} credentialsPath - Optional path to credentials file
 * @returns {Promise<TestAuthHelper>} Fully authenticated helper with app token
 */
export async function createAuthenticatedHelper(userKey = 'primary', credentialsPath = null) {
  const credentials = loadTestCredentials(credentialsPath)
  const user = credentials.users[userKey]
  const appName = credentials.testAppConfig.appName
  
  if (!user) {
    throw new Error(`User '${userKey}' not found in credentials file`)
  }
  
  if (!appName) {
    throw new Error('testAppConfig.appName not found in credentials file')
  }
  
  const auth = new TestAuthHelper(credentials.serverUrl)
  const result = await auth.loginAndSetupApp(user.user_id, user.password, appName)
  
  if (!result.success) {
    throw new Error(`Failed to setup auth for ${user.user_id}: ${result.error || JSON.stringify(result)}`)
  }
  
  return auth
}

/**
 * Create a pre-configured auth helper for the other server
 * This handles the full setup: login, app installation, and token acquisition for cross-server tests
 * 
 * @param {string} userKey - Key in otherServerUsers object (e.g., 'primary')
 * @param {string} credentialsPath - Optional path to credentials file
 * @returns {Promise<TestAuthHelper>} Fully authenticated helper with app token for other server
 */
export async function createOtherServerAuthenticatedHelper(userKey = 'primary', credentialsPath = null) {
  const credentials = loadTestCredentials(credentialsPath)
  const user = credentials.otherServerUsers?.[userKey]
  const appName = credentials.testAppConfig.appName
  
  if (!credentials.otherServerUrl) {
    throw new Error('otherServerUrl not found in credentials file')
  }
  
  if (!user) {
    throw new Error(`User '${userKey}' not found in otherServerUsers in credentials file`)
  }
  
  if (!appName) {
    throw new Error('testAppConfig.appName not found in credentials file')
  }
  
  const auth = new TestAuthHelper(credentials.otherServerUrl)
  const result = await auth.loginAndSetupApp(user.user_id, user.password, appName)
  
  if (!result.success) {
    throw new Error(`Failed to setup auth for other server user ${user.user_id}: ${result.error || JSON.stringify(result)}`)
  }
  
  return auth
}

export default TestAuthHelper
