// freezr.info - OAuth Provider: Google (connection — Gmail / Calendar / Contacts)
// Used by purpose=connection flows for the info.freezr.connections umbrella app
// (mail page in Phase 1; calendar/contacts pages later). Single OAuth grant can
// cover any combination of services depending on the user's choice in /account/resources.
//
// Implemented with native fetch — no googleapis SDK dependency for this path. The existing
// googleDrive.mjs still uses googleapis since it's the FS layer.

export const purposes = ['connection']

/**
 * Scopes by service and access level.
 * The caller (oauthApiController) builds the final scope list by selecting one of these
 * sub-arrays per requested service and flattening.
 */
export const scopesByService = {
  mail: {
    read: ['https://www.googleapis.com/auth/gmail.readonly'],
    readwrite: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send'
    ]
  },
  calendar: {
    read: ['https://www.googleapis.com/auth/calendar.readonly'],
    readwrite: ['https://www.googleapis.com/auth/calendar']
  },
  contacts: {
    read: ['https://www.googleapis.com/auth/contacts.readonly'],
    readwrite: ['https://www.googleapis.com/auth/contacts']
  }
}

// Always request profile/email so we can populate connection.account_email on first connect.
const BASE_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'openid'
]

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/**
 * Compute the final scope list from a services+access map.
 * @param {Object} access  e.g. { mail: 'read', calendar: 'readwrite' }
 * @returns {string[]}     Deduplicated scope list including BASE_SCOPES.
 */
export const scopesFor = (access) => {
  const out = new Set(BASE_SCOPES)
  for (const [service, level] of Object.entries(access || {})) {
    const arr = scopesByService[service]?.[level] || []
    for (const s of arr) out.add(s)
  }
  return [...out]
}

/**
 * Build the Google authorization URL.
 *
 * @param {Object} options
 * @param {string} options.state         OAuth state token
 * @param {string} options.codeChallenge PKCE challenge (S256)
 * @param {string} options.clientId      Google OAuth client ID
 * @param {string} options.redirecturi   Callback URL
 * @param {string[]} options.scopes      Final scope list (use scopesFor() to compute)
 * @returns {string}                     Auth URL
 */
export const buildAuthUrl = (options) => {
  if (!options.codeChallenge || !options.state || !options.clientId || !options.scopes) {
    return null
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: options.clientId,
    redirect_uri: options.redirecturi,
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
    scope: options.scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent', // forces refresh_token issuance on every grant
    include_granted_scopes: 'true'
  })
  return AUTH_ENDPOINT + '?' + params.toString()
}

/**
 * Exchange an authorization code for tokens.
 *
 * @param {Object} options
 * @param {string} options.code         Authorization code
 * @param {string} options.codeVerifier PKCE verifier
 * @param {string} options.clientId     Google OAuth client ID
 * @param {string} options.secret       Google OAuth client secret
 * @param {string} options.redirecturi  Callback URL
 * @returns {Promise<{accessToken,refreshToken,expiry,scope}>}
 */
export const exchangeCodeForTokens = async (options) => {
  const body = new URLSearchParams({
    code: options.code,
    client_id: options.clientId,
    client_secret: options.secret,
    redirect_uri: options.redirecturi,
    grant_type: 'authorization_code',
    code_verifier: options.codeVerifier
  })
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error('Google token exchange failed: ' + (data.error_description || data.error || res.statusText))
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiry: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
    scope: data.scope
  }
}

/**
 * Refresh an access token using a stored refresh token.
 *
 * @param {Object} options
 * @param {string} options.refreshToken Stored refresh token
 * @param {string} options.clientId     Google OAuth client ID
 * @param {string} options.secret       Google OAuth client secret
 * @returns {Promise<{accessToken,expiry}>}
 */
export const refreshAccessToken = async (options) => {
  const body = new URLSearchParams({
    refresh_token: options.refreshToken,
    client_id: options.clientId,
    client_secret: options.secret,
    grant_type: 'refresh_token'
  })
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  const data = await res.json()
  if (!res.ok) {
    const err = new Error('Google token refresh failed: ' + (data.error_description || data.error || res.statusText))
    err.code = data.error
    throw err
  }
  return {
    accessToken: data.access_token,
    expiry: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
    scope: data.scope
  }
}

/**
 * Compute a per-service access map (read | readwrite) from the actual space-separated
 * scope string Google returns in its token response.
 *
 * On Google's consent screen the user can un-tick individual scopes. If we requested
 * gmail.modify + gmail.send but the user only ticked gmail.readonly, the token grants
 * read-only access — and the connection record must reflect that, not the request.
 *
 * Returns a per-service access level for each service Google actually granted. Services
 * with no granted scopes are omitted from the result entirely (caller decides whether
 * a partial grant is acceptable or a failure).
 *
 * @param {string} grantedScopeString  e.g. "openid https://www.googleapis.com/auth/gmail.readonly ..."
 * @returns {{mail?:string, calendar?:string, contacts?:string}}
 */
export const accessFromGrantedScopes = (grantedScopeString) => {
  if (!grantedScopeString || typeof grantedScopeString !== 'string') return {}
  const scopes = new Set(grantedScopeString.split(/\s+/).filter(Boolean))
  const access = {}

  // Mail: any of {modify, send} implies readwrite; readonly alone implies read.
  if (scopes.has('https://www.googleapis.com/auth/gmail.modify') ||
      scopes.has('https://www.googleapis.com/auth/gmail.send')) {
    access.mail = 'readwrite'
  } else if (scopes.has('https://www.googleapis.com/auth/gmail.readonly')) {
    access.mail = 'read'
  }

  // Calendar: full /calendar implies readwrite; readonly variant implies read.
  if (scopes.has('https://www.googleapis.com/auth/calendar')) {
    access.calendar = 'readwrite'
  } else if (scopes.has('https://www.googleapis.com/auth/calendar.readonly')) {
    access.calendar = 'read'
  }

  // Contacts: full /contacts implies readwrite; readonly variant implies read.
  if (scopes.has('https://www.googleapis.com/auth/contacts')) {
    access.contacts = 'readwrite'
  } else if (scopes.has('https://www.googleapis.com/auth/contacts.readonly')) {
    access.contacts = 'read'
  }

  return access
}

/**
 * Fetch the authenticated user's Google profile (email, name) for populating
 * connection.account_email on first connect.
 *
 * @param {Object} options
 * @param {string} options.accessToken Fresh access token
 * @returns {Promise<{email?:string, name?:string, picture?:string}|null>}
 */
export const fetchAccountProfile = async (options) => {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: 'Bearer ' + options.accessToken }
  })
  if (!res.ok) return null
  return await res.json()
}

/**
 * Revoke a refresh or access token at Google. Best-effort; failure is non-fatal
 * because the local connection record is deleted regardless.
 *
 * Google accepts either the access token or the refresh token at /revoke; revoking
 * the refresh token invalidates all access tokens issued from it.
 *
 * @param {Object} options
 * @param {string} options.token   refreshToken or accessToken to revoke
 * @returns {Promise<boolean>}     true on success, false on any failure
 */
export const revokeRefreshToken = async (options) => {
  if (!options || !options.token) return false
  try {
    const body = new URLSearchParams({ token: options.token })
    const res = await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    })
    return res.ok
  } catch (e) {
    return false
  }
}

export default { purposes, scopesByService, scopesFor, accessFromGrantedScopes, buildAuthUrl, exchangeCodeForTokens, refreshAccessToken, fetchAccountProfile, revokeRefreshToken }
