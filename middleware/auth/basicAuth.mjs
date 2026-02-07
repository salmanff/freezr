// freezr.info - Modern ES6 Module - Basic Authentication Checks
// Pure functions that check authentication conditions
// These return true/false and have NO side effects (no redirects, no mutations)
//
// Also includes common guard creators that are used across multiple features

import { getAppTokenFromHeaderAndDoMinimalChecks, getOrSetAppTokenForLoggedInUser, getAndCheckCookieTokenForLoggedInUser } from '../tokens/tokenHandler.mjs'
import { sendAuthFailure } from '../../adapters/http/responses.mjs'
import { APP_TOKEN_OAC } from '../../common/helpers/config.mjs'
/**
 * Check if freezr system is set up
 * Pure function - just returns boolean
 * 
 * @param {object} dsManager - Data store manager
 * @returns {boolean} True if freezr is configured
 */
export const isSetup = (dsManager) => {
  const result = dsManager?.freezrIsSetup
  if (!result) console.warn('❌ isSetup test -> freezr is not set up!')
  return result
}

/**
 * Check if user has an active session
 * Pure function - just returns boolean
 * 
 * @param {object} session - Express session object
 * @returns {boolean} True if session exists
 */
export const hasSession = (session) => {
  return !!session
}

/**
 * Check if user is authenticated (logged in)
 * Pure function - just returns boolean
 * 
 * @param {object} session - Express session object
 * @returns {boolean} True if user is logged in
 */
export const isAuthenticated = (session) => {
  return !!session?.logged_in_user_id
}

/**
 * Get logged in user ID from session
 * Pure function - just returns value
 * 
 * @param {object} session - Express session object
 * @returns {string|null} User ID or null
 */
export const getAuthenticatedUserId = (session) => {
  return session?.logged_in_user_id || null
}

/**
 * Creates a guard that ensures freezr is set up
 * Redirects to setup page if not configured
 * 
 * Common guard used across multiple features (account, apps, admin, etc.)
 * Allows specific paths to be accessible even when setup is not complete
 * 
 * @param {object} dsManager - Data store manager
 * @returns {function} Express middleware
 */
export const createSetupGuard = (dsManager) => {
  // Paths that should be accessible even if server is not set up

  return async (req, res, next) => {

    /**
     * Paths that should be accessible even if freezr system is not set up
     * These are essential files needed for the initial setup process
     */
    const allowedPathsWhenNotSetup = [
      '/app/info.freezr.public/public/freezrApiV2.js',
      '/app/info.freezr.public/public/freezr_core.css',
      '/app/info.freezr.public/public/freezr_style.css',
      '/app/info.freezr.register/public/firstSetUp.js',
      '/app/info.freezr.register/public/firstSetUp.css',
      '/app/info.freezr.public/public/static/freezr_texture.png',
      '/app/info.freezr.public/public/static/freezer_log_top.png',
      '/register/api/checkresource',
      '/register/api/firstSetUp',
      '/favicon.ico'
      // '/app/info.freezr.register/firstSetUp.js'
    ]

    // If setup is complete, of if the requested path is in the allowed list
    if (isSetup(dsManager) || allowedPathsWhenNotSetup.includes(req.originalUrl)) {
      if (!isSetup(dsManager))console.log('✅ freezr is not set up - allowing access to:', { url: req.originalUrl})
      const isDev = process?.env?.NODE_ENV === 'development'
      if (isDev || process?.env?.FREEZR_SETUP_TOKEN) {
        return next()
      }
      return sendAuthFailure(res, { 
        message: 'Setup token missing on server env.', 
        error: 'Setup token missing on server env. - createSetupGuard', 
        type: 'setupTokenMissing', 
        path: req.path,
        url: req.url,
        statusCode: 403
      })
    }
  }
}
/**
 * Creates a guard that ensures user is authenticated
 * Redirects to login if not authenticated
 * 
 * Common guard used across multiple features (account, apps, admin, etc.)
 * 
 * @param {string} loginUrl - Where to redirect if not authenticated (default: /account/login)
 * @returns {function} Express middleware
 */
export const createAuthGuard = (loginUrl = '/account/login') => {
  return (req, res, next) => {
    if (isAuthenticated(req.session)) {
      next()
    } else {
      return sendAuthFailure(res, { 
        message: 'Unauthenticated user - not logged in', 
        error: 'Unauthenticated user - not logged in - createAuthGuard', 
        type: 'notLoggedIn', 
        url: req.url,
        path: req.path,
        shouldBeAlertedToFailure: true, 
        redirectUrl: loginUrl
      })
    }
  }
}

/**
 * Middleware to handle logged-in user page/API requests with token validation
 * Validates app token for authenticated users
 *
 * Common guard used across multiple features (account, apps, admin, etc.)
 *
 * @param {Object} dsManager - Data store manager
 * @param {Object} options - Options object
 * @param {string} options.appNameIfNoneSpecified - Default app name to use if not in params
 * @param {boolean} options.useTokenAppName - If true, sets req.params.app_name from token
 * @param {boolean} options.isPageRequest - If true, redirects on error; if false, sends 401 status
 *  // also if true - resets app token 
 * @returns {Function} Express middleware function
 */
export const createGetAppTokenInfoFromheaderForApi = (dsManager, options = {}) => {
  const { ensureAppName, ensureAppNames } = options  
  return async (req, res, next) => {
    // onsole.log('🔐 createGetAppTokenInfoFromheaderForApi middleware called with Request details:', {
    //   method: req.method,
    //   url: req.url,
    //   sessionId: req.sessionID,
    //   userId: req.session.logged_in_user_id,
    //   page: req.params.page
    // })

    const userId = req.session.logged_in_user_id
    try {

      // Get or set app token
      const tokenDb = dsManager.getDB(APP_TOKEN_OAC)
      const tokenInfo = await getAppTokenFromHeaderAndDoMinimalChecks(
        tokenDb,
        req.session,
        req.headers,
        req.cookies, // Only for testing / checking - to remove
        // false // fromgetorset
      )

      if (!tokenInfo || !tokenInfo.app_token) {
        console.error('❌ Token info or app_token not found', { tokenInfo, userId })``
        req.session.regenerate((regenerateErr) => {
          if (regenerateErr) {
            console.error('Session regeneration error during app logout:', regenerateErr)
          }
          sendAuthFailure(res, { 
            message: 'Unauthorized', 
            user_id: userId, 
            error: 'tokenNotFound - createGetAppTokenInfoFromheaderForApi',
            type: 'tokenNotFound', 
            path: req.path, 
            shouldBeAlertedToFailure: true })
        })
      }

      if (ensureAppName && tokenInfo.app_name !== ensureAppName) {
        return sendAuthFailure(res, { 
          message: 'Unauthorized', 
          user_id: userId, 
          error: 'tokenMismatch - createGetAppTokenInfoFromheaderForApi',
          type: 'tokenMismatch', 
          path: req.path, 
          shouldBeAlertedToFailure: true })
      } else if (ensureAppNames && ensureAppNames.indexOf(tokenInfo.app_name) === -1) {
        return sendAuthFailure(res, { 
          message: 'Unauthorized', 
          user_id: userId, 
          error: 'tokenMismatch - createGetAppTokenInfoFromheaderForApi',
          type: 'tokenMismatch', 
          path: req.path, 
          shouldBeAlertedToFailure: true })
      }

      if ((userId || tokenInfo.logged_in) && tokenInfo.requestor_id !== userId) {
        return sendAuthFailure(res, { 
          message: 'Unauthorized', 
          user_id: userId, 
          error: 'sessionMismatch - createGetAppTokenInfoFromheaderForApi',
          type: 'sessionMismatch', 
          path: req.path, 
          shouldBeAlertedToFailure: true })
      }

      if (!res.locals.freezr) {
        res.locals.freezr = {}
      }
      res.locals.freezr.tokenInfo = tokenInfo
      
      // Update flogger with app name from token
      if (res.locals.flogger) {
        res.locals.flogger.setTokenParams(tokenInfo.app_name)
      }

      next()

    } catch (error) {
      return sendAuthFailure(res, {
        type: (error.code === 'expired' ? 'expired' : 'Unauthorized'), 
        error: (error.message || 'unknown error ' ) + ' - createGetAppTokenInfoFromheaderForApi', 
        user_id: userId, 
        message: 'error validating credentials', 
        path: req.path, 
        shouldBeAlertedToFailure: (error.code !== 'expired')
      })
    }
  }
}

/**
 * Middleware to handle logged-in user API requests with token validation from cookie
 * Validates app token for authenticated users from cookie instead of header
 *
 * Common guard used across multiple features (account, apps, admin, etc.)
 *
 * @param {Object} dsManager - Data store manager
 * @param {Object} options - Options object
 * @returns {Function} Express middleware function
 */
export const createGetAppTokenInfoFromCookieForFiles = (dsManager, options = {}) => {
  const { ensureAppName } = options  
  return async (req, res, next) => {

    const userId = req.session.logged_in_user_id
    try {

      // Get app token from cookie
      const tokenDb = dsManager.getDB(APP_TOKEN_OAC)
      const tokenInfo = await getAndCheckCookieTokenForLoggedInUser(
        tokenDb,
        req.session,
        req.cookies
      )
      // console.log('🔍 createGetAppTokenInfoFromCookieForFiles - ', { tokenInfo, userId, app: req.params.app_name })

      if (!tokenInfo || !tokenInfo.app_token) {
        console.error('❌ Token info or app_token not found', { tokenInfo, userId })
        req.session.regenerate((regenerateErr) => {
          if (regenerateErr) {
            console.error('Session regeneration error during app logout:', regenerateErr)
            return 
          }
          return sendAuthFailure(res, { type: 'Unauthorized', user_id: userId, error: 'tokenNotFound', shouldBeAlertedToFailure: true })
        })
      }


      // Check userId consistency - ensure token's requestor_id matches session userId
      if (userId && tokenInfo.requestor_id !== userId) {
        console.error('❌ UserId mismatch between session and token', { 
          sessionUserId: userId, 
          tokenRequestorId: tokenInfo.requestor_id 
        })
        return sendAuthFailure(res, { 
          type: 'Unauthorized', 
          user_id: userId, 
          error: 'userIdMismatch', 
          shouldBeAlertedToFailure: true 
        })
      }

      if (tokenInfo.app_name !== req.params.app_name) {
        return sendAuthFailure(res, { type: 'Unauthorized', user_id: userId, error: 'tokenMismatch', shouldBeAlertedToFailure: true })
      }

      if ((userId || tokenInfo.logged_in) && tokenInfo.requestor_id !== userId) {
        return sendAuthFailure(res, { type: 'Unauthorized', user_id: userId, error: 'sessionMismatch', shouldBeAlertedToFailure: true })
      }

      if (!res.locals.freezr) {
        res.locals.freezr = {}
      }
      res.locals.freezr.tokenInfo = tokenInfo
      
      // Update flogger with app name from token
      if (res.locals.flogger) {
        res.locals.flogger.setTokenParams({ app: tokenInfo.app_name })
      }

      next()

    } catch (error) {
      console.error('❌ Error in createGetAppTokenInfoFromCookieForFiles middleware:', error)
      return sendAuthFailure(res, {
        type: (error.code === 'expired' ? 'expired' : 'Unauthorized'), 
        msg: error.message,
        error, 
        user_id: userId, 
        shouldBeAlertedToFailure: (error.code !== 'expired')
      })
    }
  }
}




/**
 * Middleware to handle logged-in user page requests with setting or updating a validation token
 *
 * Common guard used across multiple features (account, apps, admin, etc.)
 *
 * @param {Object} dsManager - Data store manager
 * @param {Object} options - Options object
 * @param {string} options.forceAppName - Default app name to use if not in params
 * @returns {Function} Express middleware function
 */
export const createOrUpdateTokenGuardFromPage = (dsManager, options = {}) => {
  const { forceAppName } = options  
  return async (req, res, next) => {
    // console.log('🔐 createOrUpdateTokenGuardFromPage middleware called with Request details:', {
    //   method: req.method,
    //   url: req.url,
    //   sessionId: req.sessionID,
    //   userId: req.session.logged_in_user_id,
    //   page: req.params.page,
    //   forceAppName
    // })

    try {
      const userId = req.session.logged_in_user_id
      if (forceAppName) {
        // console.log('🔐 createOrUpdateTokenGuardFromPage - forceAppName', { forceAppName })
        req.params.app_name = forceAppName
      }
      if (!req.params.app_name) {
          throw new Error('App name is required')
      }

      // Get or set app token
      const tokenDb = dsManager.getDB(APP_TOKEN_OAC)
      const appName = req.params.app_name
      const tokenInfo = await getOrSetAppTokenForLoggedInUser(
        tokenDb,
        appName,
        req.session,
        req.cookies // will not be used in when !isPageRequest
      )

      if (!tokenInfo || !tokenInfo.app_token) {
        console.error('❌ Error setting Token ', { tokenInfo, userId, appName })
        return res.redirect('/account/login?redirect=missing_token')
      }

      if (!res.locals.freezr) {
        res.locals.freezr = {}
      }
      res.locals.freezr.tokenInfo = tokenInfo
      
      // Update flogger with app name from token
      if (res.locals.flogger) {
        res.locals.flogger.setTokenParams(tokenInfo.app_name)
      }

      next()

    } catch (error) {
      if (isSetup(dsManager)) {
        console.error('❌ Error in createGetAppTokenInfoFromheaderForApi middleware:', error)
        console.error('Error stack:', error.stack)
        return res.redirect('/account/login?redirect=auth_error')
      } else {
        console.error('❌ freezr is not set up -> redirecting to first registration page:', error)
        res.redirect('/register/firstSetUp')
      }
    }
  }
}

/**
 * Middleware to validate app token from Authorization header
 * Does NOT require logged-in user - validates token only
 * Adds tokenDb to res.locals for use in controllers
 *
 * Used for app logout and other token-based operations
 *
 * @param {Object} dsManager - Data store manager
 * @returns {Function} Express middleware function
 */
export const createAddAppTokenInfo = (dsManager) => {
  return async (req, res, next) => {
    // onsole.log('🔐 createAddAppTokenInfo middleware called')
    
    try {
      // Check for Authorization header
      const authHeader = req.header('Authorization')
      if (!authHeader || authHeader.length <= 10) {
        console.warn('⚠️  No Authorization header found')
        //visitLogger.addNewFailedAuthAttempt(dsManager, req, { source: 'creds', accessPt: 'appToken' })
        // return res.status(401).json({
        //   success: false,
        //   error: 'Unauthorized attempt to logout',
        //   code: 'AUTHENTICATION_ERROR'
        // })
        sendAuthFailure(res, { type: 'Unauthorized', error: 'tokenNotFound', shouldBeAlertedToFailure: true })
      }

      // Extract app token from header (format: "Bearer <token>" or just the token)
      const appToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader

      // Get token database
      const tokenDb = dsManager.getDB(APP_TOKEN_OAC)
      
      // Validate token exists in database
      const nowTime = new Date().getTime()
      let tokenInfo = null

      // Check cache first
      // if (tokenDb.cache?.byToken && tokenDb.cache.byToken[appToken]) {
      //   const cachedToken = tokenDb.cache.byToken[appToken]
      //   // Cache is valid if expiry is within 5 days
      //   if (cachedToken.expiry + (5 * 24 * 60 * 60 * 1000) > nowTime) {
      //     tokenInfo = cachedToken
      //   }
      // }

      // If not in cache or cache expired, query database
      if (!tokenInfo) {
        const results = await tokenDb.query({ app_token: appToken }, {})
        if (results && results.length > 0) {
          tokenInfo = results[0]
          // Update cache
          if (!tokenDb.cache) tokenDb.cache = {}
          if (!tokenDb.cache.byToken) tokenDb.cache.byToken = {}
          tokenDb.cache.byToken[appToken] = tokenInfo
        }
      }

      if (!tokenInfo) {
        // console.warn('⚠️  App token not found:', appToken)
        // visitLogger.addNewFailedAuthAttempt(dsManager, req, { source: 'creds', accessPt: 'appToken' })
        // return res.status(401).json({
        //   success: false,
        //   error: 'Unauthorized attempt to logout',
        //   code: 'AUTHENTICATION_ERROR'
        // })
        sendAuthFailure(res, { type: 'Unauthorized', user_id: userId, error: 'tokenNotFound', shouldBeAlertedToFailure: true })
      }

      // Add tokenDb, tokenInfo, and dsManager to res.locals
      if (!res.locals.freezr) {
        res.locals.freezr = {}
      }
      res.locals.freezr.appTokenDb = tokenDb
      res.locals.freezr.appToken = appToken
      res.locals.freezr.tokenInfo = tokenInfo
      
      // Update flogger with app name from token
      if (res.locals.flogger) {
        res.locals.flogger.setTokenParams({ app: tokenInfo.app_name })
      }
      
      // onsole.log('✅ App token validated, proceeding to next middleware')
      next()

    } catch (error) {
      console.error('❌ Error in createAddAppTokenInfo middleware:', error)
      sendAuthFailure(res, { type: 'Unauthorized', user_id: userId, error: 'tokenNotFound', shouldBeAlertedToFailure: true })
      // res.locals.flogger.authError('Unauthorized attempt to logout', { source: 'creds', accessPt: 'appToken' })
      // return res.status(401).json({
      //   success: false,
      //   error: 'Unauthorized attempt to logout',
      //   code: 'AUTHENTICATION_ERROR'
      // })
    }
  }
}

/**
 * Middleware to get app token from Authorization header without validation
 * Does NOT require logged-in user - validates token only
 *
 * @param {Object} dsManager - Data store manager
 * @returns {Function} Express middleware function
 */
export const createAddAppTokenInfoWithoutChecks = (dsManager) => {
  return async (req, res, next) => {
    // onsole.log('🔐 createAddAppTokenInfo middleware called')
    
    try {
      // Check for Authorization header
      // console.log('🔐 createAddAppTokenInfoWithoutChecks middleware called', { path: req.path })

      const authHeader = req.header('Authorization')
      if (!authHeader || authHeader.length <= 10) {
        return next()
      } else {
        // Extract app token from header (format: "Bearer <token>" or just the token)
        const appToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader

        // Get token database
        const tokenDb = dsManager.getDB(APP_TOKEN_OAC)
        
        // Validate token exists in database
        let tokenInfo = null

        // Check cache first
        const nowTime = new Date().getTime()
        if (tokenDb.cache?.byToken && tokenDb.cache.byToken[appToken]) {
          const cachedToken = tokenDb.cache.byToken[appToken]
          // Cache is valid if expiry is within 5 days
          if (cachedToken.expiry + (5 * 24 * 60 * 60 * 1000) > nowTime) {
            tokenInfo = cachedToken
          }
        }

        // If not in cache or cache expired, query database
        if (!tokenInfo) {
          const results = await tokenDb.query({ app_token: appToken }, {})
          if (results && results.length > 0) {
            tokenInfo = results[0]
            // Update cache
            if (!tokenDb.cache) tokenDb.cache = {}
            if (!tokenDb.cache.byToken) tokenDb.cache.byToken = {}
            tokenDb.cache.byToken[appToken] = tokenInfo
          }
        }

        // Add tokenDb, tokenInfo, and dsManager to res.locals
        if (!res.locals.freezr) {
          res.locals.freezr = {}
        }
        // res.locals.freezr.appTokenDb = tokenDb
        // res.locals.freezr.appToken = appToken
        res.locals.freezr.tokenInfo = tokenInfo
        
        // Update flogger with app name from token
        if (res.locals.flogger) {
          res.locals.flogger.setTokenParams({ app: tokenInfo.app_name })
        }
        
        // onsole.log('✅ App token validated, proceeding to next middleware')
        next()
      }

    } catch (error) {
      console.error('❌ Error in createAddAppTokenInfo middleware:', error)
      next()
    }
  }
}

export default {
  isSetup,
  hasSession,
  isAuthenticated,
  getAuthenticatedUserId,
  createSetupGuard,
  createAuthGuard,
  createGetAppTokenInfoFromheaderForApi,
  createGetAppTokenInfoFromCookieForFiles,
  createAddAppTokenInfo,
  createAddAppTokenInfoWithoutChecks
}
