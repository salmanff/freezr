// freezr.info - API Rate Limiter
// Per-user rate limiting for authenticated API endpoints
// Prevents DoS from registered users flooding the server with requests
//
// Sliding window approach — counts requests in the last WINDOW_MS.
// As older requests age out, the count drops and throttling eases.
//
// Two-phase approach:
//   1. Under THROTTLE_START: full speed, no delay
//   2. THROTTLE_START to MAX: increasing delay per request (graceful for sequential backups)
//   3. Over MAX: hard reject with 429
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
 * Count recent requests and determine action.
 * Returns { action: 'allow' | 'throttle' | 'reject', delayMs, retryAfterMs }
 */
const checkUserRate = (userId) => {
  const now = Date.now()
  const cutoff = now - API_RATE_LIMIT.WINDOW_MS

  let timestamps = userRequests.get(userId)
  if (!timestamps) {
    timestamps = []
    userRequests.set(userId, timestamps)
  }

  // Drop timestamps outside the window
  while (timestamps.length > 0 && timestamps[0] <= cutoff) {
    timestamps.shift()
  }

  // Record this request
  timestamps.push(now)
  const count = timestamps.length

  if (count <= API_RATE_LIMIT.THROTTLE_START) {
    return { action: 'allow' }
  }

  if (count > API_RATE_LIMIT.MAX_REQUESTS_PER_USER) {
    // Estimate when the oldest throttle-zone request will age out
    const oldestRelevant = timestamps[count - API_RATE_LIMIT.MAX_REQUESTS_PER_USER]
    const retryAfterMs = oldestRelevant ? (oldestRelevant - cutoff) : API_RATE_LIMIT.WINDOW_MS
    return { action: 'reject', retryAfterMs: Math.max(retryAfterMs, 1000) }
  }

  // Throttle zone: linearly increasing delay from ~0ms to ~1000ms
  const throttleRange = API_RATE_LIMIT.MAX_REQUESTS_PER_USER - API_RATE_LIMIT.THROTTLE_START
  const progress = (count - API_RATE_LIMIT.THROTTLE_START) / throttleRange
  const delayMs = Math.round(progress * 1000)
  return { action: 'throttle', delayMs }
}

/**
 * Express middleware for per-user API rate limiting.
 * Must be placed after token validation middleware (needs res.locals.freezr.tokenInfo).
 */
export const apiRateLimit = (req, res, next) => {
  const userId = res.locals.freezr?.tokenInfo?.requestor_id
  if (!userId) {
    return next()
  }

  const result = checkUserRate(userId)

  if (result.action === 'allow') {
    return next()
  }

  if (process.env.NODE_ENV === 'development') {
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
