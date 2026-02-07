// freezr.info - Modern ES6 Module - OAuth API Controller
// Handles all OAuth-related API requests

import { sendApiSuccess, sendFailure, sendAuthFailure } from '../../../adapters/http/responses.mjs'
import { FS_AUTH_URL, FS_getRefreshToken } from '../../../adapters/datastore/environmentDefaults.mjs'
import {
  createStateParams,
  isStateValid,
  storeState,
  getState,
  deleteState,
  MAX_STATE_TIME_MS
} from '../services/oauthService.mjs'
import { startsWith, randomText, expiryDatePassed } from '../../../common/helpers/utils.mjs'
import { APP_TOKEN_OAC } from '../../../common/helpers/config.mjs'

/**
 * Create OAuth API controller
 * All handlers expect res.locals.freezr to have oauthorDb and cacheManager
 * 
 * @returns {Object} Controller with handler functions
 */
export const createOauthApiController = () => {
  return {
    /**
     * List all OAuth configurations
     * GET /oauth/privateapi/list_oauths
     * Admin only - returns all OAuth configurations for the admin page
     */
    listOauths: async (req, res) => {
      try {
        // console.log('listOauths controller', { freezr: res.locals.freezr })
        const { oauthorDb } = res.locals.freezr
        
        if (!oauthorDb) {
          return sendFailure(res, { message: 'OAuth database not initialized' }, 'listOauths', 500)
        }
        
        const results = await oauthorDb.query({}, {})
        res.locals.freezr.permGiven = true
        
        return sendApiSuccess(res, { results: results || [] })
      } catch (error) {
        console.error('❌ Error in listOauths:', error)
        return sendFailure(res, error, 'listOauths', 500)
      }
    },
    
    /**
     * Create or update OAuth configuration
     * PUT /oauth/privateapi/oauth_perm
     * Admin only - creates new OAuth config or updates existing one
     */
    oauthPermMake: async (req, res) => {
      try {
        // console.log('oauthPermMake ', { freezr: res.locals.freezr })
        const { oauthorDb } = res.locals.freezr
        
        if (!oauthorDb) {
          return sendFailure(res, { message: 'OAuth database not initialized' }, 'oauthPermMake', 500)
        }
        
        // Handle delete
        if (req.body.delete && req.body._id) {
          await oauthorDb.delete_record(req.body._id)
          res.locals.freezr.permGiven = true
          return sendApiSuccess(res, { written: 'deleted' })
        }
        
        const isUpdate = Boolean(req.body._id)
        let updateType = null
        
        // Build params object
        const params = {
          type: req.body.type,
          name: req.body.name,
          key: req.body.key,
          redirecturi: req.body.redirecturi,
          secret: req.body.secret,
          enabled: req.body.enabled
        }
        
        // Check if exists
        let existingRecord = null
        if (isUpdate) {
          existingRecord = await oauthorDb.read_by_id(req.body._id)
        } else {
          const results = await oauthorDb.query({ type: req.body.type, name: req.body.name }, {})
          if (results && results.length > 0) {
            existingRecord = results[0]
          }
        }
        
        // Create or update
        if (!existingRecord) {
          if (isUpdate) {
            return sendFailure(res, { message: 'Marked as update but no object found' }, 'oauthPermMake', 404)
          }
          updateType = 'new'
          await oauthorDb.create(null, params, null)
        } else {
          updateType = isUpdate ? 'update' : 'update_unplanned'
          const recordId = existingRecord._id + ''
          await oauthorDb.update(recordId, params, { replaceAllFields: true })
        }
        
        res.locals.freezr.permGiven = true
        return sendApiSuccess(res, { written: updateType })
      } catch (error) {
        console.error('❌ Error in oauthPermMake:', error)
        return sendFailure(res, error, 'oauthPermMake', 500)
      }
    },
    
    /**
     * Handle public OAuth operations
     * GET /oauth/:dowhat
     * Public endpoint - handles get_new_state and validate_state
     * 
     * dowhat can be:
     * - get_new_state: Start OAuth flow, returns redirect URL to third party
     * - validate_state: Validate OAuth callback and return credentials
     */
    publicApiActions: async (req, res) => {
      try {
        const { oauthorDb, cacheManager } = res.locals.freezr
        const dowhat = req.params.dowhat
        
        if (!oauthorDb) {
          return sendFailure(res, { message: 'OAuth database not initialized' }, 'publicApiActions', 500)
        }
        
        if (!cacheManager) {
          return sendFailure(res, { message: 'Cache manager not initialized' }, 'publicApiActions', 500)
        }
        
        if (dowhat === 'get_new_state') {
          // Start OAuth flow - get redirect URL to third party
          await handleGetNewState(req, res, oauthorDb, cacheManager)
        } else if (dowhat === 'validate_state') {
          // Validate OAuth callback
          await handleValidateState(req, res, oauthorDb, cacheManager)
        } else {
          return sendFailure(res, { message: 'Invalid OAuth action: ' + dowhat }, 'publicApiActions', 400)
        }
      } catch (error) {
        console.error('❌ Error in publicApiActions:', error)
        return sendFailure(res, error, 'publicApiActions', 500)
      }
    }
  }
}

/**
 * Handle get_new_state action
 * Creates OAuth state and returns redirect URL to third party OAuth provider
 * 
 * Query params:
 * - type: OAuth provider type (dropbox, googleDrive)
 * - sender: URL to redirect back to after OAuth flow
 * - regcode: Registration code from the sender
 */
const handleGetNewState = async (req, res, oauthorDb, cacheManager) => {
  const { type, sender, regcode } = req.query
  
  // Validate required params
  if (!type || !regcode || !sender) {
    return sendFailure(res, 'Need type, regcode and sender to get a state', 'publicApiActions:get_new_state', 400)
  }
  
  // Check if we have URL generator for this type
  if (!FS_AUTH_URL[type]) {
    return sendFailure(res, 'Missing URL generator for type: ' + type, 'publicApiActions:get_new_state', 400)
  }
  
  // Find enabled OAuth configuration for this type
  const records = await oauthorDb.query({ type, enabled: true }, null)
  
  if (!records || records.length === 0) {
    return sendFailure(res, 'No enabled OAuth configuration found for type: ' + type, 'publicApiActions:get_new_state', 404)
  }
  
  const oauthConfig = records[0]
  
  if (!oauthConfig.enabled) {
    return sendFailure(res, 'OAuth configuration is not enabled', 'publicApiActions:get_new_state', 403)
  }
  
  // Create state parameters with PKCE codes
  const redirecturi = (startsWith(req.get('host'), 'localhost') ? 'http' : 'https') + 
    '://' + req.headers.host + '/public/oauth/oauth_validate_page.html'
  
  const stateParams = createStateParams({
    ip: req.ip,
    type,
    regcode,
    sender,
    redirecturi,
    clientId: oauthConfig.key,
    secret: oauthConfig.secret,
    name: oauthConfig.name
  })
  
  // Store state in cache
  storeState(cacheManager, stateParams)
  
  // Store state in session for validation
  req.session.oauth_state = stateParams.state
  
  const authUrl = await FS_AUTH_URL[type](stateParams)
  
  if (!authUrl) {
    return sendFailure(res, 'Failed to generate auth URL for type: ' + type, 'publicApiActions:get_new_state', 500)
  }
  
  res.locals.freezr.permGiven = true
  return sendApiSuccess(res, { redirecturi: authUrl })
}

/**
 * Handle validate_state action
 * Validates OAuth callback and returns credentials to sender
 * 
 * Query params:
 * - state: OAuth state token
 * - code: Authorization code from OAuth provider (optional)
 * - accessToken: Access token from OAuth provider (optional)
 */
const handleValidateState = async (req, res, oauthorDb, cacheManager) => {
  let { state, code, accessToken } = req.query
  
  // Normalize null strings
  if (accessToken === 'null') accessToken = null
  if (code === 'null') code = null
  
  // Get state from cache
  const stateParams = getState(cacheManager, state)
  
  // Validate state
  if (!stateParams) {
    return sendAuthFailure(res, { 
      message: 'No auth state found or state expired',
      type: 'auth_error',
      message: 'No auth state found or state expired',
      path: req.path,
      url: req.url
    })
  }
  
  if (req.session.oauth_state !== state) {
    return sendAuthFailure(res, { 
      message: 'State mismatch - session state does not match',
      type: 'auth_error',
      message: 'State mismatch - session state does not match',
      path: req.path,
      url: req.url
    })
  }
  
  if (!isStateValid(stateParams)) {
    deleteState(cacheManager, state)
    return sendAuthFailure(res, { 
      message: 'State has expired',
      type: 'auth_error',
      message: 'State has expired',
      path: req.path,
      url: req.url
    })
  }
  
  if (!code && !accessToken) {
    return sendAuthFailure(res, { 
      message: 'Missing code or access token',
      type: 'auth_error',
      message: 'Missing code or access token',
      path: req.path,
      url: req.url
    })
  }
  
  // Store code in state params if present
  if (code) stateParams.code = code
  
  // Verify OAuth configuration is still enabled
  const records = await oauthorDb.query({ type: stateParams.type, name: stateParams.name }, null)
  
  if (!records || records.length === 0) {
    return sendAuthFailure(res, { 
      message: 'OAuth configuration no longer exists',
      type: 'auth_error',
      message: 'OAuth configuration no longer exists',
      path: req.path,
      url: req.url
    })
  }
  
  if (!records[0].enabled) {
    return sendAuthFailure(res, { 
      message: 'OAuth configuration has been disabled',
      type: 'auth_error',
      message: 'OAuth configuration has been disabled',
      path: req.path,
      url: req.url
    })
  }
  
  // Get refresh token if available for this type
  const refreshTokenGetter = FS_getRefreshToken[stateParams.type]
  
  if (refreshTokenGetter) {
    try {
      const token = await refreshTokenGetter(stateParams)
      
      if (token) {
        stateParams.refreshToken = token.refresh_token
        stateParams.accessToken = token.access_token
        stateParams.expiry = token.expiry_date
      }
    } catch (error) {
      console.warn('Failed to get refresh token:', error.message)
      // Continue anyway - some providers don't support refresh tokens
    }
  }
  
  // Build response
  const toSend = {
    code: code,
    accessToken: accessToken || stateParams.accessToken,
    regcode: stateParams.regcode,
    type: stateParams.type,
    sender: stateParams.sender,
    clientId: stateParams.clientId,
    codeChallenge: stateParams.codeChallenge,
    codeVerifier: stateParams.codeVerifier,
    redirecturi: stateParams.redirecturi,
    refreshToken: stateParams.refreshToken,
    expiry: stateParams.expiry,
    success: true
  }
  
  // For Google Drive, we need to include the secret
  // (Unfortunately the only way to authenticate without re-pinging every hour)
  if (stateParams.type === 'googleDrive') {
    toSend.secret = stateParams.secret
  }
  
  // Clean up state
  deleteState(cacheManager, state)
  req.session.oauth_state = null
  
  res.locals.freezr.permGiven = true
  return sendApiSuccess(res, toSend)
}

/**
 * Create App Token Login controller
 * Handles POST /oauth/token - exchanges app password for access token
 * 
 * This is the OAuth 2.0 password grant flow for freezr apps:
 * 1. App generates app password via /acctapi/generateAppPassword
 * 2. App exchanges app password for access token via POST /oauth/token
 * 3. App uses access token for subsequent API calls
 * 
 * @param {object} dependencies - Required dependencies
 * @param {object} dependencies.dsManager - Data store manager
 * @param {object} dependencies.freezrPrefs - Freezr preferences
 * @returns {Function} Express handler function
 */
export const createAppTokenLoginHandler = ({ dsManager, freezrPrefs }) => {
  return async (req, res) => {
    try {
      // Initialize res.locals.freezr if not present
      if (!res.locals.freezr) {
        res.locals.freezr = {}
      }
            
      // Extract request body
      const { password, username: userId, client_id: appName, grant_type, expiry: requestedExpiry } = req.body
      
      // Validate required parameters
      if (!userId) {
        return sendAuthFailure(res, { message: 'Missing username', code: 'missing_user_id' })
      }
      if (!appName) {
        return sendAuthFailure(res, { message: 'Missing client_id', code: 'missing_app_name' })
      }
      if (!password) {
        return sendAuthFailure(res, { message: 'Missing password', code: 'missing_password' })
      }
      if (grant_type !== 'password') {
        return sendAuthFailure(res, { message: 'Wrong grant type - only password accepted', code: 'wrong_grant_type' })
      }
      
      // Create/update device_code in session if not present
      if (!req.session.device_code) {
        req.session.device_code = randomText(20)
        
        const devicesOac = {
          app_name: 'info.freezr.account',
          collection_name: 'user_devices',
          owner: userId
        }
        
        const devicesDb = await dsManager.getorInitDb(devicesOac, { freezrPrefs })
        
        const deviceWrite = {
          device_code: req.session.device_code,
          user_id: userId,
          single_app: appName,
          user_agent: req.headers['user-agent']
        }
        
        await devicesDb.upsert(
          { device_code: req.session.device_code, user_id: userId, single_app: appName },
          deviceWrite
        )
      }
      
      // Get token database
      const tokenDb = await dsManager.getorInitDb(APP_TOKEN_OAC, { freezrPrefs })
      
      // Query for the app password record
      const results = await tokenDb.query({ app_password: password }, null)
      
      if (!results || results.length === 0) {
        return sendAuthFailure(res, { 
          message: 'Invalid password',
          type: 'auth_error',
          error: 'Invalid password in createAppTokenLoginHandler',
          path: req.path,
          url: req.url
        })
      }
      
      const record = results[0]
      
      // Validate the password record
      if (record.owner_id !== userId || record.requestor_id !== userId || record.app_name !== appName) {
        return sendAuthFailure(res, { 
          message: 'App name or user ID do not match',
          type: 'auth_error',
          error: 'Credential mismatch in createAppTokenLoginHandler',
          path: req.path,
          url: req.url
        })
      }
      
      if (record.date_used) {
        return sendAuthFailure(res, { 
          message: 'One time password already in use',
          type: 'auth_error',
          error: 'One time password already used in createAppTokenLoginHandler',
          path: req.path,
          url: req.url
        })
      }
      
      if (expiryDatePassed(record.expiry)) {
        console.warn('appToken / password_expired for user:', userId)
        return sendAuthFailure(res, { 
          message: 'One time password has expired',
          type: 'auth_error',
          error: 'One time password expired in createAppTokenLoginHandler',
          path: req.path,
          url: req.url
        })
      }
      
      // Get the app token
      const appToken = record.app_token
      let expiresIn = record.expiry
      
      // Use requested expiry if it's sooner
      if (requestedExpiry && requestedExpiry < expiresIn) {
        expiresIn = requestedExpiry
      }
      
      // Update the record to mark it as used
      await tokenDb.update(
        record._id + '',
        { 
          date_used: new Date().getTime(), 
          user_device: req.session.device_code, 
          expiry: expiresIn 
        },
        {}
      )
      
      // Send success response
      res.locals.freezr.permGiven = true
      return sendApiSuccess(res, { 
        access_token: appToken, 
        user_id: userId, 
        app_name: appName, 
        expires_in: expiresIn 
      })
      
    } catch (error) {
      console.error('❌ Error in appTokenLogin:', error)
      return sendAuthFailure(res, { 
        message: 'Token exchange failed',
        type: 'auth_error',
        error: (error.message || 'unknown error') + ' - Token exchange failed in createAppTokenLoginHandler',
        path: req.path,
        url: req.url
      })
    }
  }
}

export default {
  createOauthApiController,
  createAppTokenLoginHandler
}
