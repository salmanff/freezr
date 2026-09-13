// freezr.info - API Rate Limiter
// Per-user rate limiting for authenticated API endpoints
// Prevents DoS from registered users flooding the server with requests
//
// Sliding window approach — counts requests in the last WINDOW_MS.
// As older requests age out, the count drops and throttling eases.
//
// Two-phase approach:
//   1. Under throttleStart (90% of max): full speed, no delay
//   2. throttleStart to max: increasing delay per request (graceful for sequential backups)
//   3. At max: hard reject with 429 (rejected requests are NOT counted, so a
//      client that keeps retrying still recovers as older requests age out)
//
// The max is admin-configurable via the apiRateLimitPerUserMinute preference
// (admin/prefs page); when unset, API_RATE_LIMIT.MAX_REQUESTS_PER_USER applies.
//
// setTimeout delays do NOT block the Node.js event loop — other users are unaffected.
// Per-server (in-memory) — correct for freezr's single-instance architecture.

import { API_RATE_LIMIT } from '../../common/startup/constants.mjs'

// Map of userId → array of request timestamps (within the current window)
const userRequests = new Map()

// Periodic cleanup of stale entries (every 2 minutes)
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - API_RATE_LIMIT.WINDOW_MS
  for (const [userId, timestamps] of userRequests) {
    // Remove entries where all timestamps are expired
    if (timestamps.length === 0 || timestamps[timestamps.length - 1] < cutoff) {
      userRequests.delete(userId)
    }
  }
}, 120000)
if (cleanupTimer.unref) cleanupTimer.unref()

/**
 * Resolve the effective per-user max from admin prefs, falling back to the constant.
 */
const maxRequestsFromPrefs = (freezrPrefs) => {
  const prefLimit = freezrPrefs?.apiRateLimitPerUserMinute
  if (Number.isInteger(prefLimit) && prefLimit > 0) return prefLimit
  return API_RATE_LIMIT.MAX_REQUESTS_PER_USER
}

/**
 * Count recent requests and determine action.
 * Returns { action: 'allow' | 'throttle' | 'reject', delayMs, retryAfterMs }
 */
const checkUserRate = (userId, maxRequests) => {
  const now = Date.now()
  const cutoff = now - API_RATE_LIMIT.WINDOW_MS
  const throttleStart = Math.floor(maxRequests * 0.9)

  let timestamps = userRequests.get(userId)
  if (!timestamps) {
    timestamps = []
    userRequests.set(userId, timestamps)
  }

  // Drop timestamps outside the window
  while (timestamps.length > 0 && timestamps[0] <= cutoff) {
    timestamps.shift()
  }

  if (timestamps.length >= maxRequests) {
    // Reject without recording — keeps the array bounded at maxRequests and
    // lets a retrying client back in as soon as older requests age out
    const oldestRelevant = timestamps[timestamps.length - maxRequests]
    const retryAfterMs = oldestRelevant ? (oldestRelevant - cutoff) : API_RATE_LIMIT.WINDOW_MS
    return { action: 'reject', retryAfterMs: Math.max(retryAfterMs, 1000) }
  }

  // Record this request
  timestamps.push(now)
  const count = timestamps.length

  if (count <= throttleStart) {
    return { action: 'allow' }
  }

  // Throttle zone: linearly increasing delay from ~0ms to ~1000ms
  const throttleRange = maxRequests - throttleStart
  const progress = (count - throttleStart) / throttleRange
  const delayMs = Math.round(progress * 1000)
  return { action: 'throttle', delayMs }
}

/**
 * Express middleware for per-user API rate limiting.
 * Must be placed after token validation middleware (needs res.locals.freezr.tokenInfo).
 */
export const apiRateLimit = (req, res, next) => {
  if (process.env.NODE_ENV === 'development') {
    return next()
  }

  const userId = res.locals.freezr?.tokenInfo?.requestor_id
  if (!userId) {
    return next()
  }

  const maxRequests = maxRequestsFromPrefs(res.locals.freezr?.freezrPrefs)
  const result = checkUserRate(userId, maxRequests)

  if (result.action === 'allow') {
    return next()
  }

  if (result.action === 'reject') {
    const retryAfterSec = Math.ceil(result.retryAfterMs / 1000)
    res.set('Retry-After', String(retryAfterSec))
    return res.status(429).json({
      error: 'Too many requests. Please slow down.',
      retryAfter: retryAfterSec
    })
  }

  // Throttle: delay then proceed
  setTimeout(() => next(), result.delayMs)
}
