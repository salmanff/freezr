// requestLogger.mjs - Request-scoped logging middleware

import { FLogger } from '../common/loganalytics/logging.mjs'
import { sendAuthFailure } from '../adapters/http/responses.mjs'

/**
 * Creates the request logging middleware that:
 * - Assigns a unique request ID
 * - Creates a request-scoped FLogger
 * - Sets up auth rate limiting guard
 * - Blocks requests if rate limited
 */
export function createRequestLoggerMiddleware ({ logManager, coreLogger, authRateLimiter }) {
  return (req, res, next) => {
    req.id = Math.random().toString(36).substring(7)
    res.locals.session = req.session
    
    const logMetaData = {
      reqId: req.id,
      reqIp: req.ip,
      method: req.method,
      path: req.path,
      user: req.session?.logged_in_user_id,
      device: req.session?.device_code
    }
    
    res.locals.flogger = new FLogger(coreLogger, logMetaData)
    // console.log('🔄 createRequestLoggerMiddleware - SET res.locals.flogger:', { flogger: res.locals.flogger })
    res.locals.authGuard = authRateLimiter.createRequestGuard(logMetaData)
    
    // Check rate limiting
    const rateCheck = res.locals.authGuard.checkBlock()
    if (!rateCheck.allowed && process.env.FREEZR_TEST_MODE !== 'true') {
      const mins = Math.ceil(rateCheck.retryAfter / 60)
      return sendAuthFailure(res, {
        type: 'authLimitBlock',
        message: `Too many requests. Please try again in ${mins} minutes.`,
        statusCode: 429
      })
    }
    
    next()
  }
}

export function createAddConsoleFloggerMiddleware (consoleFlogger) {
  return (req, res, next) => {
    res.locals.flogger = consoleFlogger
    next()
  }
}