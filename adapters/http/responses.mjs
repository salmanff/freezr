// freezr.info - Modern ES6 Module - HTTP Response Adapter
// Adapts application responses to HTTP/Express format
//
// Architecture Pattern:
// - Adapter layer for HTTP responses (Express.js)
// - Consistent JSON response format
// - Centralized error logging
// - Easy to extend with headers, status codes, etc.
//
// Location: adapters/http/
// - This is an ADAPTER because it interfaces between the application and HTTP/web

import { isPageRequest } from '../../common/helpers/utils.mjs'

/**
 * 
 * Checks if the permission has been checked - if not, this is a develkoper error
 * @param {Object} res - Express response object
 * @returns {Object|null} - Express response object or null if permission is given
 */
const checkPermGiven = (res) => {
  if (res.locals?.freezr?.permGiven) return null
  res.locals.flogger.error('perm Not set up - dev error');
  return res.status(400).json({
    success: false,
    error: 'Develper error - Permission not given'
  })
}
/**
 * Send successful JSON response
 * 
 * @param {Object} res - Express response object
 * @param {Object} data - Data to send (will be JSON stringified)
 * @param {number} statusCode - HTTP status code (default: 200)
 */
export function sendApiSuccess(res, data = {}, statusCode = 200) {
  // onsole.log('sendApiSuccess called with app_name: ', res.locals?.freezr?.tokenInfo?.app_name);
  res.locals.flogger.track('api', { app_name: res.locals?.freezr?.tokenInfo?.app_name });
  res.status(statusCode)
  return checkPermGiven(res) || res.json(data)
}

/**
 * Send successful Page Content
 * 
 * @param {Object} res - Express response object
 * @param {Object} textContent - page content to send
 * @param {number} statusCode - HTTP status code (default: 200)
 */
export function sendContent(res, textContent = '', type) {
  res.locals.flogger.track('page', { app_name: res.locals?.freezr?.tokenInfo?.app_name });
  // example of dev debug logging:
  // res.locals.flogger.debug('sendContent captured for app ', { app_name: res.locals?.freezr?.tokenInfo?.app_name });
  if (type) res.type(type)
  else res.setHeader('Content-Type', 'text/html')
  return checkPermGiven(res) || res.send(textContent)
}

/**
 * Send successful file 
 * 
 * @param {Object} res - Express response object
 * @param {Object} localPath - localPath to send (will be JSON stringified)
 * @param {number} statusCode - HTTP status code (default: 200)
 */
export function sendFile(res, localPath = '', statusCode = 200) {
  res.locals.flogger?.track?.('file'); // "?" needed for when freezr is not set up
  res.status(statusCode)
  return checkPermGiven(res) ||  res.sendFile(localPath)
}

/**
 * Send successful stream 
 * 
 * @param {Object} res - Express response object
 * @param {Object} stream - localPath to send (will be JSON stringified)
 * @param {number} statusCode - HTTP status code (default: 200)
 */
export function sendStream(res, streamOrFile, statusCode = 200) {
  res.locals.flogger.track('file');
  res.status(statusCode)
  return checkPermGiven(res) || res.send(streamOrFile)
}

/**
 * Pipe a stream to the response
/**
 * Pipe a stream to the response
 * 
 * @param {Object} res - Express response object
 * @param {Object} stream - stream to pipe
 * @param {number} statusCode - HTTP status code (default: 200)
 */
export function pipeStream(res, stream, statusCode = 200) {
  res.locals.flogger.track('file');
  res.status(statusCode)
  return checkPermGiven(res) ||  stream.pipe(res)
}
/**
 * Send error JSON response with logging
 * 
 * @param {Object} res - Express response object
 * @param {Error|string} err - Error object or error message
 * @param {string} context - Context for logging (e.g., 'loginController.handleLogin')
 * @param {number} statusCode - HTTP status code (default: 500)
 */
export function sendFailure(res, err, context = 'unknown', statusCode = 500) {
  // Normalize error to be an Error instance if not already
  const errorObj = err instanceof Error ? err : new Error(err);
  const message = errorObj.message || 'unknown_error';

  if (typeof context === 'string') {
    context = { function: context }
  }

  res.locals.flogger.error(message, context);

  if (context.redirectUrl && isPageRequest(context.path)) {
    res.redirect(context.redirectUrl)
    res.end()
  } else {
    // Send standardized error response
    res.status(statusCode).json({
      success: false,
      error: message
    })
  }
}

/**
 * Send login failure response
 * 
 * @param {Object} res - Express response object
 * @param {string} context - Context for logging (e.g., 'loginController.handleLogin')
 */
// export function sendLoginFailure(res, context) {
//   // Log the error
//   const user_id = context.user_id

//   // Record failed auth attempt for rate limiting (if this was a real auth attempt)
//   if (context.shouldBeAlertedToFailure && res.locals.authGuard) {
//     res.locals.authGuard.recordFailure('login')
//   }

//   res.locals.flogger.auth(context.error, { user_id, type: 'loginFailure' })
  
//   // Send standardized error response
//   res.status(401).json({
//     success: false,
//     error: context.error
//   })
// }

/**
 * Send Auth failure response
 * 
 * @param {Object} res - Express response object
 * @param {Object} context - Context for logging
 * @param {Object|string} user_id- userid of user in case of log in
 * @param {Object|number} statusCode - HTTP status code (default: 500)
 * @param {Object|string} type - type of auth failure - loginFailure, Unauthorized, expired
 * @param {Object|string} message - message to return - if not use type
 * @param {string|object} error - Error generated. This can be a string or object.
 * @param {Object|string} redirectUrl - redirect url in case of page failure
 * @param {Object|boolean} shouldBeAlertedToFailure - whether to count the auth guard to failure
 */
export function sendAuthFailure(res, context = {}) {
  // Log the error
  const user_id = context.user_id // for login
  const type = context.type || 'authFailure'
  const error = context.error || context.msg
  
  // Record failed auth attempt for rate limiting (if this was a real auth attempt)
  if (context.shouldBeAlertedToFailure && res.locals.authGuard) {
    res.locals.authGuard.recordFailure(type)
  }
  res.locals.flogger.auth(type, { user_id, error })
  
  // Send standardized error response
  if (context.redirectUrl && isPageRequest(context.path)) {
    res.redirect(context.redirectUrl)
    res.end()
  } else {
    // onsole.log('sendAuthFailure called with context: ', context)
    res.status(context.statusCode || 401).json({
      success: false,
      message: context.message || type
    })
  }
}

// Default export with all functions
export default {
  sendApiSuccess,
  sendFailure,
  sendAuthFailure,
  sendContent,
  sendFile,
  sendStream,
  pipeStream
}

