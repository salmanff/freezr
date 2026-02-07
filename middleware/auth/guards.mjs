// freezr.info - Modern ES6 Module - Generic Guard Middleware
// Generic guard creators that handle redirects based on check functions
// These compose pure check functions with redirect logic

/**
 * Creates a guard middleware that redirects if check fails
 * Generic pattern for creating any redirect-based guard
 * 
 * @param {function} checkFn - Function that returns true (pass) or false (fail)
 * @param {string} redirectUrl - Where to redirect if check fails
 * @returns {function} Express middleware
 * 
 * @example
 * const authGuard = createRedirectGuard(
 *   (req) => isAuthenticated(req.session),
 *   '/account/login'
 * )
 */
export const createRedirectGuard = (checkFn, redirectUrl) => {
  return (req, res, next) => {
    if (checkFn(req, res)) {
      next()
    } else if (redirectUrl) {
      res.redirect(redirectUrl)
    } else {
      res.status(401).send('Unauthorized')
    }
  }
}

/**
 * Creates a guard middleware that sends 403 if check fails
 * Generic pattern for permission checks
 * 
 * @param {function} checkFn - Function that returns true (allowed) or false (forbidden)
 * @param {string} message - Optional error message
 * @returns {function} Express middleware
 * 
 * @example
 * const adminGuard = createForbiddenGuard(
 *   (req) => req.session.user_role === 'admin',
 *   'Admin access required'
 * )
 */
export const createForbiddenGuard = (checkFn, message = 'Forbidden') => {
  return (req, res, next) => {
    if (checkFn(req, res)) {
      next()
    } else {
      res.status(403).send(message)
    }
  }
}

/**
 * Creates a guard middleware that sends 401 if check fails
 * Generic pattern for authentication checks
 * 
 * @param {function} checkFn - Function that returns true (authenticated) or false (not authenticated)
 * @param {string} message - Optional error message
 * @returns {function} Express middleware
 */
export const createUnauthorizedGuard = (checkFn, message = 'Unauthorized') => {
  return (req, res, next) => {
    if (checkFn(req, res)) {
      next()
    } else {
      res.status(401).send(message)
    }
  }
}

/**
 * Creates a guard that redirects if check PASSES (inverse logic)
 * Useful for "redirect if already logged in" scenarios
 * 
 * @param {function} checkFn - Function that returns true (redirect) or false (continue)
 * @param {string} redirectUrl - Where to redirect if check passes
 * @returns {function} Express middleware
 * 
 * @example
 * const noAuthGuard = createInverseRedirectGuard(
 *   (req) => isAuthenticated(req.session),
 *   '/account/home'
 * )
 */
export const createInverseRedirectGuard = (checkFn, redirectUrl) => {
  return (req, res, next) => {
    if (checkFn(req, res)) {
      res.redirect(redirectUrl)
    } else {
      next()
    }
  }
}

export default {
  createRedirectGuard,
  createForbiddenGuard,
  createUnauthorizedGuard,
  createInverseRedirectGuard
}

