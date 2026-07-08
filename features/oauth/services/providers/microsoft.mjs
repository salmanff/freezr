// freezr.info - OAuth Provider: Microsoft (connection — Outlook Mail / Calendar / Contacts)
// Used by purpose=connection flows, exactly like google.mjs. Talks to the Microsoft
// identity platform (Entra ID) v2.0 endpoints with the `common` tenant, so both
// organizational (Microsoft 365) and personal (outlook.com / hotmail) accounts work.
//
// Microsoft-specific notes vs google.mjs:
//   - Refresh tokens ROTATE: every refresh response may include a new refresh_token
//     that replaces the old one. refreshAccessToken returns it; tokenRefresh.mjs
//     persists it when present.
//   - There is no scope-untick on the Microsoft consent screen (all-or-nothing),
//     but accessFromGrantedScopes still parses the granted scope string so partial
//     admin-consent setups are reflected correctly.
//   - No public token-revocation endpoint exists for the v2.0 platform; users revoke
//     via https://account.live.com/consent/Manage (personal) or myaccount.microsoft.com
//     (work/school). revokeRefreshToken is therefore a documented no-op.

export const purposes = ['connection']

const GRAPH_SCOPE_PREFIX = 'https://graph.microsoft.com/'

/**
 * Scopes by service and access level (Graph delegated permissions).
 * Mail.ReadWrite covers folders/drafts/moves; Mail.Send is the separate send grant.
 */
export const scopesByService = {
  mail: {
    read: [GRAPH_SCOPE_PREFIX + 'Mail.Read'],
    readwrite: [
      GRAPH_SCOPE_PREFIX + 'Mail.ReadWrite',
      GRAPH_SCOPE_PREFIX + 'Mail.Send'
    ]
  },
  calendar: {
    read: [GRAPH_SCOPE_PREFIX + 'Calendars.Read'],
    readwrite: [GRAPH_SCOPE_PREFIX + 'Calendars.ReadWrite']
  },
  contacts: {
    read: [GRAPH_SCOPE_PREFIX + 'Contacts.Read'],
    readwrite: [GRAPH_SCOPE_PREFIX + 'Contacts.ReadWrite']
  }
}

// offline_access → refresh token; User.Read → GET /me for account_email on connect.
const BASE_SCOPES = [
  'openid',
  'email',
  'offline_access',
  GRAPH_SCOPE_PREFIX + 'User.Read'
]

const AUTH_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
const TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'

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
 * Build the Microsoft authorization URL.
 *
 * @param {Object} options
 * @param {string} options.state         OAuth state token
 * @param {string} options.codeChallenge PKCE challenge (S256)
 * @param {string} options.clientId      Entra app (client) ID
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
    response_mode: 'query',
    prompt: 'select_account'
  })
  return AUTH_ENDPOINT + '?' + params.toString()
}

// Shared token-endpoint POST. Microsoft public clients must NOT send client_secret;
// confidential (web) clients must — so it's included only when configured.
const tokenRequest = async (fields, secret, what) => {
  const body = new URLSearchParams(fields)
  if (secret) body.set('client_secret', secret)
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  const data = await res.json()
  if (!res.ok) {
    const err = new Error('Microsoft ' + what + ' failed: ' + (data.error_description || data.error || res.statusText))
    err.code = data.error
    throw err
  }
  return data
}

/**
 * Exchange an authorization code for tokens.
 *
 * @param {Object} options
 * @param {string} options.code         Authorization code
 * @param {string} options.codeVerifier PKCE verifier
 * @param {string} options.clientId     Entra app (client) ID
 * @param {string} [options.secret]     Client secret (confidential clients only)
 * @param {string} options.redirecturi  Callback URL
 * @returns {Promise<{accessToken,refreshToken,expiry,scope}>}
 */
export const exchangeCodeForTokens = async (options) => {
  const data = await tokenRequest({
    code: options.code,
    client_id: options.clientId,
    redirect_uri: options.redirecturi,
    grant_type: 'authorization_code',
    code_verifier: options.codeVerifier
  }, options.secret, 'token exchange')
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiry: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
    scope: data.scope
  }
}

/**
 * Refresh an access token. Microsoft rotates refresh tokens — the response's new
 * refresh_token (when present) must replace the stored one, so it's returned here
 * and persisted by tokenRefresh.mjs.
 *
 * @param {Object} options
 * @param {string} options.refreshToken Stored refresh token
 * @param {string} options.clientId     Entra app (client) ID
 * @param {string} [options.secret]     Client secret (confidential clients only)
 * @returns {Promise<{accessToken,refreshToken,expiry,scope}>}
 */
export const refreshAccessToken = async (options) => {
  const data = await tokenRequest({
    refresh_token: options.refreshToken,
    client_id: options.clientId,
    grant_type: 'refresh_token'
  }, options.secret, 'token refresh')
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiry: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
    scope: data.scope
  }
}

/**
 * Compute a per-service access map (read | readwrite) from the space-separated
 * scope string Microsoft returns in its token response. Scopes may come back
 * short-form ('Mail.Read') or fully-qualified — both are handled.
 *
 * @param {string} grantedScopeString
 * @returns {{mail?:string, calendar?:string, contacts?:string}}
 */
export const accessFromGrantedScopes = (grantedScopeString) => {
  if (!grantedScopeString || typeof grantedScopeString !== 'string') return {}
  const scopes = new Set(
    grantedScopeString.split(/\s+/).filter(Boolean).map(s =>
      (s.startsWith(GRAPH_SCOPE_PREFIX) ? s.slice(GRAPH_SCOPE_PREFIX.length) : s).toLowerCase()
    )
  )
  const access = {}

  if (scopes.has('mail.readwrite') || scopes.has('mail.send')) access.mail = 'readwrite'
  else if (scopes.has('mail.read')) access.mail = 'read'

  if (scopes.has('calendars.readwrite')) access.calendar = 'readwrite'
  else if (scopes.has('calendars.read')) access.calendar = 'read'

  if (scopes.has('contacts.readwrite')) access.contacts = 'readwrite'
  else if (scopes.has('contacts.read')) access.contacts = 'read'

  return access
}

/**
 * Fetch the authenticated user's profile for populating connection.account_email.
 * `mail` is the mailbox address; userPrincipalName is the sign-in fallback (personal
 * accounts sometimes leave `mail` null).
 *
 * @param {Object} options
 * @param {string} options.accessToken Fresh access token
 * @returns {Promise<{email?:string, name?:string}|null>}
 */
export const fetchAccountProfile = async (options) => {
  const res = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', {
    headers: { Authorization: 'Bearer ' + options.accessToken }
  })
  if (!res.ok) return null
  const data = await res.json()
  return {
    email: data.mail || data.userPrincipalName || null,
    name: data.displayName || null
  }
}

/**
 * The Microsoft identity platform v2.0 has no public token-revocation endpoint.
 * Deleting the local connection record is the effective disconnect; the user can
 * fully revoke the grant at account.live.com/consent/Manage (personal) or
 * myaccount.microsoft.com → App permissions (work/school). Returns false so the
 * caller logs the revoke as not-performed (non-fatal, same contract as google.mjs).
 */
export const revokeRefreshToken = async () => false

export default { purposes, scopesByService, scopesFor, accessFromGrantedScopes, buildAuthUrl, exchangeCodeForTokens, refreshAccessToken, fetchAccountProfile, revokeRefreshToken }
