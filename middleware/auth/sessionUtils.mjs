// freezr.info - Modern ES6 Module - Session Utilities
// Cross-cutting utilities for session management
//
// Architecture: Pure functions that don't depend on Express req/res
// These can be used anywhere - middleware, controllers, services

/**
 * Ensures session has a device code
 * Pure function - takes session as input, returns modified session
 * 
 * @param {object} session - User session
 * @param {object} helpers - Helpers module with randomText function
 * @returns {object} Session with device_code
 */
export const ensureDeviceCode = (session, helpers) => {
  if (!session.device_code) {
    session.device_code = helpers.randomText(20)
  }
  return session
}

/**
 * Checks if a session exists
 * 
 * @param {object} session - User session
 * @returns {boolean} True if session exists
 */
export const hasSession = (session) => {
  return !!session
}

/**
 * Gets user ID from session if logged in
 * 
 * @param {object} session - User session
 * @returns {string|null} User ID or null
 */
export const getLoggedInUserId = (session) => {
  return session?.logged_in_user_id || null
}

export default {
  ensureDeviceCode,
  hasSession,
  getLoggedInUserId
}

