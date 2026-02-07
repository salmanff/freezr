// freezr.info - Modern ES6 Module - Account Feature Guards
// Account-specific guard middleware using pure auth checks + generic guards

import { isAuthenticated } from '../../../middleware/auth/basicAuth.mjs'
import { createRedirectGuard, createInverseRedirectGuard } from '../../../middleware/auth/guards.mjs'
import { getAndCheckCookieTokenForLoggedInUser } from '../../../middleware/tokens/tokenHandler.mjs'
import { isSystemApp, APP_TOKEN_OAC } from '../../../common/helpers/config.mjs'
import { loadDataHtmlAndPage } from '../../../adapters/rendering/pageLoader.mjs'

/**
 * Creates a guard that redirects authenticated users away
 * Useful for login/register pages - if already logged in, go to home
 * 
 * @param {string} homeUrl - Where to redirect authenticated users (default: /account/home)
 * @returns {function} Express middleware
 */
export const createNoAuthGuard = (homeUrl = '/account/home') => {
  return createInverseRedirectGuard(
    (req) => isAuthenticated(req.session),
    homeUrl
  )
}

/**
 * Pure function to check if user should be redirected from login page
 * Kept separate for backward compatibility and explicit checking
 * 
 * @param {object} session - User session
 * @param {string} url - Current URL
 * @returns {boolean} True if user should be redirected
 */
export const shouldRedirectLoggedInUser = (session, url) => {
  return isAuthenticated(session) && url === '/account/login'
}

/**
 * Creates a guard that ensures the app name is a system app
 * Redirects to error page if not a system app
 * 
 * @param {string} errorUrl - Where to redirect if not a system app (default: /account/home)
 * @returns {function} Express middleware
 */
export const createSystemAppGuard = (errorUrl = null) => {
  return createRedirectGuard(
    (req) => {
      const appName = req.params.app_name
      return appName && isSystemApp(appName)
    },
    errorUrl
  )
}

export default {
  createNoAuthGuard,
  shouldRedirectLoggedInUser,
  createSystemAppGuard
}

