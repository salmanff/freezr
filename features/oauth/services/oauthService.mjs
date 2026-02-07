// freezr.info - Modern ES6 Module - OAuth Service
// Business logic for OAuth operations including PKCE generation and state management

import crypto from 'crypto'
import { TextEncoder } from 'util'

const Encoder = TextEncoder

// Constants
export const MAX_STATE_TIME_MS = 30000 // 30 seconds - max time for OAuth state to be valid
export const PKCE_LENGTH = 128

/**
 * Generate PKCE codes for OAuth 2.0 with PKCE
 * Creates a code verifier and corresponding code challenge
 * 
 * @returns {Object} { codeChallenge, codeVerifier }
 */
export const generatePKCECodes = () => {
  // Generate random code verifier
  let codeVerifier = crypto.randomBytes(PKCE_LENGTH)
  codeVerifier = codeVerifier.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
    .substr(0, 128)

  // Generate code challenge from verifier using SHA256
  const encoder = new Encoder()
  const codeData = encoder.encode(codeVerifier)
  let codeChallenge = crypto.createHash('sha256').update(codeData).digest()
  codeChallenge = codeChallenge.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')

  return { codeChallenge, codeVerifier }
}

/**
 * Generate a random state token for OAuth flow
 * 
 * @param {number} length - Length of the state token (default: 40)
 * @returns {string} Random state token
 */
export const generateStateToken = (length = 40) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  const randomBytes = crypto.randomBytes(length)
  for (let i = 0; i < length; i++) {
    result += chars[randomBytes[i] % chars.length]
  }
  return result
}

/**
 * Create OAuth state parameters object
 * 
 * @param {Object} params - Parameters for the state
 * @param {string} params.ip - Client IP address
 * @param {string} params.type - OAuth provider type (dropbox, googleDrive)
 * @param {string} params.regcode - Registration code from the sender
 * @param {string} params.sender - URL to redirect back to after OAuth
 * @param {string} params.redirecturi - OAuth callback URL
 * @param {string} params.clientId - OAuth client ID
 * @param {string} params.secret - OAuth client secret (for Google)
 * @param {string} params.name - OAuth configuration name
 * @returns {Object} State parameters with PKCE codes and timestamp
 */
export const createStateParams = (params) => {
  const state = generateStateToken(40)
  const { codeChallenge, codeVerifier } = generatePKCECodes()

  return {
    state,
    ip: params.ip,
    date_created: Date.now(),
    type: params.type,
    regcode: params.regcode,
    sender: params.sender,
    redirecturi: params.redirecturi,
    codeChallenge,
    codeVerifier,
    clientId: params.clientId,
    secret: params.secret,
    name: params.name
  }
}

/**
 * Validate that a state has not expired
 * 
 * @param {Object} stateParams - State parameters object
 * @returns {boolean} True if state is still valid
 */
export const isStateValid = (stateParams) => {
  if (!stateParams || !stateParams.date_created) {
    return false
  }
  const elapsed = Date.now() - stateParams.date_created
  return elapsed < MAX_STATE_TIME_MS
}

/**
 * Get cache key for OAuth state
 * 
 * @param {string} state - State token
 * @returns {string} Cache key
 */
export const getStateCacheKey = (state) => {
  return `oauth_state:${state}`
}

/**
 * Store OAuth state in cache
 * 
 * @param {Object} cacheManager - Cache manager instance
 * @param {Object} stateParams - State parameters to store
 * @returns {boolean} Success
 */
export const storeState = (cacheManager, stateParams) => {
  const key = getStateCacheKey(stateParams.state)
  return cacheManager.set(key, stateParams, {
    ttl: Math.ceil(MAX_STATE_TIME_MS / 1000), // TTL in seconds
    type: 'oauth_state',
    namespace: 'oauth'
  })
}

/**
 * Retrieve OAuth state from cache
 * 
 * @param {Object} cacheManager - Cache manager instance
 * @param {string} state - State token
 * @returns {Object|null} State parameters or null if not found/expired
 */
export const getState = (cacheManager, state) => {
  const key = getStateCacheKey(state)
  return cacheManager.get(key)
}

/**
 * Delete OAuth state from cache
 * 
 * @param {Object} cacheManager - Cache manager instance
 * @param {string} state - State token
 * @returns {boolean} Success
 */
export const deleteState = (cacheManager, state) => {
  const key = getStateCacheKey(state)
  return cacheManager.delete(key)
}

export default {
  generatePKCECodes,
  generateStateToken,
  createStateParams,
  isStateValid,
  getStateCacheKey,
  storeState,
  getState,
  deleteState,
  MAX_STATE_TIME_MS
}
