// freezr.info - OAuth Providers Registry
// Aggregates per-provider modules into a single OAUTH_PROVIDERS map keyed by provider type.
//
// The provider type matches the value stored in the admin oauth_serve_setup config
// (oauthorDb records: { type, name, key, secret, redirecturi, enabled }).
//
// Each provider module exports:
//   - purposes:                  string[]               ('fs' | 'connection')
//   - buildAuthUrl(options):     string | Promise<string>
//   - exchangeCodeForTokens(opts): Promise<{ accessToken, refreshToken, expiry, scope? }>
//   - refreshAccessToken(opts):  Promise<{ accessToken, expiry, scope? }>  (optional)
//   - scopesByService?:          { [service]: { read, readwrite } }       (connection providers only)
//   - scopesFor?(access):        string[]                                  (helper for connection providers)

import * as dropbox from './dropbox.mjs'
import * as googleDrive from './googleDrive.mjs'
import * as google from './google.mjs'

export const OAUTH_PROVIDERS = {
  dropbox,
  googleDrive,
  google
}

/**
 * Look up a provider module by type, or return null if not registered.
 * @param {string} type
 */
export const getProvider = (type) => OAUTH_PROVIDERS[type] || null

/**
 * Check whether a provider supports a given purpose.
 * @param {string} type
 * @param {string} purpose  'fs' | 'connection'
 */
export const providerSupportsPurpose = (type, purpose) => {
  const p = OAUTH_PROVIDERS[type]
  return !!(p && p.purposes && p.purposes.includes(purpose))
}

export default { OAUTH_PROVIDERS, getProvider, providerSupportsPurpose }
