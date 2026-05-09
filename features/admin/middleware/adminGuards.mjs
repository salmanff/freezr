// freezr.info - Modern ES6 Module - Admin Feature Guards
// Admin-specific guard middleware using pure auth checks + generic guards

import { isAuthenticated, isSetup } from '../../../middleware/auth/basicAuth.mjs'
import { createRedirectGuard, createInverseRedirectGuard, createForbiddenGuard } from '../../../middleware/auth/guards.mjs'
import { sendAuthFailure } from '../../../adapters/http/responses.mjs'
import { parseSetupToken, tokenExpired } from '../../register/services/registerServices.mjs'
import { buildLoginRedirectUrl } from '../../../common/helpers/utils.mjs'

/**
 * Creates a guard that checks if freezr is NOT set up
 * Used for first setup page - redirects if already set up
 * Also validates the setup token (format + expiry) in non-dev environments
 * 
 * @param {Object} dsManager - Data store manager
 * @returns {function} Express middleware
 */
export const createFirstSetupGuard = (dsManager) => {
  return (req, res, next) => {
    if (isSetup(dsManager)) {
      return res.redirect('/admin')
    }
    const isDev = process?.env?.NODE_ENV === 'development'
    if (isDev) return next()

    const envTokenRaw = process?.env?.FREEZR_SETUP_TOKEN
    if (!envTokenRaw) {
      return sendAuthFailure(res, {
        error: 'Setup token missing on server env.',
        type: 'setupTokenMissing',
        message: 'Setup token missing on server env.',
        statusCode: 403
      })
    }
    const envToken = parseSetupToken(envTokenRaw)
    if (!envToken) {
      return sendAuthFailure(res, {
        error: 'Invalid setup token format. Use <token>.<YYYY-MM-DD>',
        type: 'setupTokenInvalid',
        message: 'Invalid setup token format. Use <token>.<YYYY-MM-DD>',
        statusCode: 403
      })
    }
    if (tokenExpired(envToken.expires)) {
      return sendAuthFailure(res, {
        error: 'Setup token has expired. Generate a new one to proceed.',
        type: 'setupTokenExpired',
        message: 'Setup token has expired. Generate a new one to proceed.',
        statusCode: 403
      })
    }
    next()
  }
}

/**
 * Creates a guard that ensures user is authenticated and is an admin
 * Redirects to login if not authenticated, or to account home if not admin
 * 
 * @param {string} loginUrl - Where to redirect if not authenticated (default: /account/login)
 * @param {string} homeUrl - Where to redirect if not admin (default: /account/home)
 * @returns {function} Express middleware
 */
export const createAdminAuthGuard = (loginUrl = '/account/login', homeUrl = '/account/home') => {
  return (req, res, next) => {
    // Check if authenticated
    if (!isAuthenticated(req.session)) {
      return res.redirect(buildLoginRedirectUrl(req, loginUrl))
    }
    
    // Check if admin
    if (!req.session.logged_in_as_admin) {
      return res.redirect(`${homeUrl}?redirectReason=adminOnly`)
    }
    
    next()
  }
}

/**
 * Creates a guard that ensures user is authenticated and is an admin (for API routes)
 * Returns 401 status instead of redirecting (for JSON API responses)
 * 
 * @returns {function} Express middleware
 */
export const createAdminAuthGuardForApi = () => {
  return (req, res, next) => {
    // Check if authenticated
    if (!isAuthenticated(req.session)) {
      return sendAuthFailure(res, {
        type: 'Unauthorized',
        message: 'Unauthorized',
        error: 'Authentication required in createAdminAuthGuardForApi',
        path: req.path,
        url: req.url,
        statusCode: 401
      })
    }
    
    // Check if admin
    if (!req.session.logged_in_as_admin) {
      return sendAuthFailure(res, {
        type: 'Unauthorized',
        message: 'Unauthorized',
        error: 'Admin access required in createAdminAuthGuardForApi middleware',
        path: req.path,
        url: req.url,
        statusCode: 401
      })
    }
    
    next()
  }
}


export default {
  createFirstSetupGuard,
  createAdminAuthGuard,
  createAdminAuthGuardForApi
}

