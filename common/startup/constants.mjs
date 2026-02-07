// constants.mjs - Server startup constants and configuration

/**
 * Session configuration
 */
export const SESSION_CONFIG = {
  /** Session TTL in milliseconds (6 months) */
  TTL_MS: 6 * 30 * 24 * 60 * 60 * 1000,  // 15552000000
  
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
 * Express server configuration
 */
export const EXPRESS_CONFIG = {
  /** Maximum JSON body size */
  JSON_MB_LIMIT: '50mb',
  
  /** Maximum URL-encoded body size */
  URL_ENCODED_MB_LIMIT: '50mb'
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

