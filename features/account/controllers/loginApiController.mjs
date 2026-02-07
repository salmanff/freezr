// freezr.info - Modern ES6 Module - Login API Controller
// Handles HTTP requests for login API endpoints
//
// Architecture Pattern:
// - Controller handles HTTP concerns (request/response)
// - Delegates business logic to services
// - Returns structured JSON responses
// - Uses functional approach with closures for dependency injection

import { LoginService } from '../services/loginService.mjs'
import { sendApiSuccess, sendFailure, sendAuthFailure } from '../../../adapters/http/responses.mjs'
import { getOrSetAppTokenForLoggedInUser } from '../../../middleware/tokens/tokenHandler.mjs'

/**
 * Update session with user data
 * 
 * @param {Object} session - Express session object
 * @param {Object} user - User data from authentication
 * @param {string} deviceCode - Device code
 */
const updateSession = (session, user, deviceCode) => {
  // console.log('🔑 Updating session for user:', user.user_id)
  
  // TODO: FIX session.regenerate() - it's not sending the new session cookie to browser
  // TEMPORARILY using direct assignment
  
  session.logged_in = true
  session.logged_in_user_id = user.user_id
  session.logged_in_date = new Date().getTime()
  session.logged_in_as_admin = Boolean(user.isAdmin)
  session.logged_in_as_publisher = Boolean(user.isPublisher)
  session.device_code = deviceCode

  return
  
  // onsole.log('🔑 Session updated - sessionID:', session.id, 'user_id:', session.logged_in_user_id)
}


/**
 * Handle POST /acctapi/login
 * Authenticate user and create session
 * 
 * @param {Object} dsManager - Data store manager
 * @returns {Function} Express route handler
 */
const createHandleLogin = (dsManager) => async (req, res) => {
  res.locals.flogger.debug('login ✅ called - Request details:', {
    method: req.method,
    url: req.url,
    body: !!req.body,
    user_id: req.body?.user_id,
    hasPassword: !!req.body?.password,
    sessionId: req.sessionID,
    deviceCode: req.session?.device_code
  })
  
  try {
    const { user_id, password } = req.body
    
    // Check for too many failed attempts BEFORE authentication
    const rateCheck = res.locals.authGuard.check('login')
    if (!rateCheck.allowed && process.env.FREEZR_TEST_MODE !== 'true') {
      console.warn('⚠️  Too many failed login attempts - ', req.ip, rateCheck.reason)
      return sendFailure(res, `Too many login attempts. Please try again in ${rateCheck.retryAfter} seconds.`, 'loginApiController.handleLogin', 429)
    }
    
    // Authenticate user (ONLY authentication, no side effects)
    const loginService = new LoginService(dsManager)
    const result = await loginService.authenticateUser(user_id, password)

    if (result.success) {
      res.locals.flogger.debug('login ✅ Authentication successful for user:', result.user.user_id)
      
      // Update session with user data
      updateSession(req.session, result.user, req.session.device_code)
  
      // Generate app token
      const tokenDb = dsManager.getDB({
        app_name: 'info.freezr.admin',
        collection_name: 'app_tokens',
        owner: 'fradmin'
      })
      const newAppTokenInfo = await getOrSetAppTokenForLoggedInUser(
        tokenDb, 
        'info.freezr.account', 
        req.session,
        req.cookies
      )
      // onsole.log('🔑 New app token info:', newAppTokenInfo)
      const newAppToken = newAppTokenInfo.app_token
      
      // Set app token cookie
      res.cookie('app_token_' + result.user.user_id, newAppToken, { path: '/account' })
      // onsole.log('🔑 App token cookie set for user:', result.user.user_id)

      // Save session and send response
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('❌ Session save error:', saveErr)
          return sendFailure(res, 'Login failed - session save error', 'loginApiController.handleLogin', 500)
        }
        
        res.locals.flogger.debug('`login ✅ Session saved successfully ', req.session)
        
        // Send success response
        return sendApiSuccess(res, { 
          logged_in: true, 
          user_id: result.user 
        })
      })

    } else {
      sendAuthFailure(res, {
        type: 'loginFailure', 
        message: 'invalid credentials',
        path: req.path, 
        url: req.url,
        error: result.error, 
        user_id: result.user?.user_id, 
        shouldBeAlertedToFailure: result.shouldBeAlertedToFailure 
      })
    }

  } catch (error) {
    console.error('❌ Login error:', error)
    sendFailure(res, error, 'loginApiController.handleLogin', 500)
  }
}

/**
 * Factory function to create login API controller
 * Returns an object with handler functions
 * 
 * @param {Object} dsManager - Data store manager
 * @returns {Object} Controller with handler functions
 */
export const createLoginApiController = (dsManager) => {
  return {
    handleLogin: createHandleLogin(dsManager)
  }
}

export default createLoginApiController
