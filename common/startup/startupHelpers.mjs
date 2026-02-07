// startupHelpers.mjs - Helper functions for server startup

import session from 'express-session'
import FreezrSessionStore from '../../middleware/sessionStore.mjs'
import { SESSION_CONFIG, SECRET_CONFIG } from './constants.mjs'

/**
 * Determines the public URL redirect based on user preferences
 * @param {Request} req - Express request object
 * @param {Object} dsManager - Data store manager instance
 * @param {Object} freezrPrefs - User preferences object
 * @returns {string|null} - Redirect URL or null if no redirect needed
 */
export function getPublicUrlFromPrefs (req, dsManager, freezrPrefs) {
  if (!dsManager.freezrIsSetup) return '/register/firstSetUp'
  if (!freezrPrefs?.redirect_public || (!freezrPrefs.public_landing_page && !freezrPrefs.public_landing_app)) return null
  if (freezrPrefs.public_landing_page === 'public' || (req.query.noredirect === 'true' && req.baseUrl === '/public')) return null
  if (freezrPrefs.public_landing_page) return '/' + freezrPrefs.public_landing_page
  return '/papp/' + freezrPrefs.public_landing_app
}

/**
 * Generates new cookie secrets or returns existing ones
 * @param {Object} [secrets] - Existing secrets object with session_cookie_secret
 * @returns {Object} - Object containing session_cookie_secret
 */
export function newFreezrSecrets (secrets) {
  // If secrets are provided (from file), use them
  if (secrets?.session_cookie_secret) {
    return { session_cookie_secret: secrets.session_cookie_secret }
  }
  
  // Generate a random secret
  let result = ''
  for (let i = 0; i < SECRET_CONFIG.SECRET_LENGTH; i++) {
    result += SECRET_CONFIG.SECRET_CHARS.charAt(
      Math.floor(Math.random() * SECRET_CONFIG.SECRET_CHARS.length)
    )
  }
  
  return { session_cookie_secret: result }
}

/**
 * Configures Express session, CORS headers, and root redirect
 * @param {Express} app - Express application instance
 * @param {Object} cookieSecrets - Object containing session_cookie_secret
 * @param {Object} fradminAdminFs - File system adapter for session storage
 * @param {Function} getRedirectUrl - Function to determine root redirect URL
 */
export function addAppUses (app, cookieSecrets, fradminAdminFs, getRedirectUrl) {
  // Create the session store
  const sessionStore = new FreezrSessionStore({
    fradminAdminFs: fradminAdminFs,
    ttl: SESSION_CONFIG.TTL_MS,
    prefix: SESSION_CONFIG.PREFIX
  })
  
  const sessionConfig = {
    name: SESSION_CONFIG.COOKIE_NAME,
    secret: cookieSecrets.session_cookie_secret,
    resave: false,
    saveUninitialized: false,
    genid: function (req) {
      const expires = Date.now() + SESSION_CONFIG.TTL_MS
      return sessionStore.generateSessionId(expires)
    },
    store: sessionStore,
    cookie: {
      maxAge: SESSION_CONFIG.TTL_MS,
      secure: process?.env?.NODE_ENV !== 'development',
      sameSite: 'strict'
    }
  }
  
  app.use(session(sessionConfig))
  
  // CORS headers
  app.use(function (req, res, next) {
    res.header('Access-Control-Allow-Credentials', 'true')
    res.header('Access-Control-Allow-Origin', null)
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Origin, Accept')
    res.header('Access-Control-Allow-Methods', 'PUT, POST, GET, OPTIONS')
    next()
  })

  // Root redirect
  app.get('/', function (req, res) {
    const redirectUrl = getRedirectUrl(req)
    res.redirect(redirectUrl)
    res.end()
  })
}
