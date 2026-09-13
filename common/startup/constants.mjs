// constants.mjs - Server startup constants and configuration

/**
 * Session configuration
 */
export const SESSION_CONFIG = {
  /** Session TTL in milliseconds (30 days) */
  TTL_MS: 30 * 24 * 60 * 60 * 1000,  // 2592000000
  
  /** Session cookie name */
  COOKIE_NAME: 'freezr_session',
  
  /** Session ID prefix for file storage */
  PREFIX: 'session_'
}

/**
 * Auth rate limiting configuration
 */
export const AUTH_RATE_LIMIT = {
  /** Maximum failed attempts per IP before blocking */
  MAX_ATTEMPTS_PER_IP: 3,
  
  /** Maximum failed attempts per device before blocking */
  MAX_ATTEMPTS_PER_DEVICE: 3,
  
  /** Time window for counting attempts (1 minute) */
  WINDOW_MS: 60 * 1000,
  
  /** How long to block after exceeding limits (5 minutes) */
  BLOCK_DURATION_MS: 5 * 60 * 1000
}

/**
 * API rate limiting configuration (per-user, per-server)
 */
export const API_RATE_LIMIT = {
  /** Default maximum API requests per user per time window before hard reject.
   *  Admin can override via the apiRateLimitPerUserMinute preference (admin/prefs).
   *  Throttling (gradual delay) begins at 90% of the max. */
  MAX_REQUESTS_PER_USER: 1000,

  /** Time window in milliseconds (1 minute) */
  WINDOW_MS: 60 * 1000
}

/**
 * Express server configuration
 */
export const EXPRESS_CONFIG = {
  /** Maximum JSON body size */
  JSON_MB_LIMIT: '50mb',
  
  /** Maximum URL-encoded body size */
  URL_ENCODED_MB_LIMIT: '50mb'
}

/**
 * Request watchdog configuration (middleware/requestWatchdog.mjs)
 * A request that never answers parks the browser connection it arrived on, and
 * browsers only allow ~6 per origin - so a handful of stalls freezes the whole
 * app. Both values can be overridden with FREEZR_REQUEST_SLOW_MS /
 * FREEZR_REQUEST_TIMEOUT_MS.
 */
export const REQUEST_WATCHDOG = {
  /** Log a warning naming the route if it is still unanswered after this (10s) */
  SLOW_MS: 10 * 1000,

  /** Give up and answer 503, freeing the connection, after this (2 min).
   *  Well beyond any normal freezr request; streaming responses are exempt
   *  because their headers are already sent. */
  TIMEOUT_MS: 2 * 60 * 1000,

  /** Routes that can legitimately run past TIMEOUT_MS and must NOT be cut off.
   *  Matched as a prefix of req.path. These are still *warned* about at SLOW_MS,
   *  they are just never aborted. A route not listed here can opt out at runtime
   *  with markLongRunning(res) from middleware/requestWatchdog.mjs.
   *  Kept deliberately short - every entry is a route that can no longer free its
   *  connection on its own, so only add one that genuinely runs for minutes. */
  LONG_RUNNING_PATHS: [
    '/feps/llm/ask',                    // model generation - minutes for a long answer
    '/acctapi/fsMigration',             // copies a user's whole file store
    '/acctapi/dbMigration',             // copies a user's whole database
    '/acctapi/app_install_from_zipfile', // upload + unpack + install
    '/jobs/run'                         // job execution, incl. cloud runners
  ]
}

/**
 * Secret generation configuration
 */
export const SECRET_CONFIG = {
  /** Length of generated secrets */
  SECRET_LENGTH: 64,
  
  /** Characters used for secret generation */
  SECRET_CHARS: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?'
}

