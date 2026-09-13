// freezr.info - OAuth Provider: Slack (connection — messaging)
// Used by purpose=connection flows for the info.freezr.connections umbrella app.
//
// Slack particulars vs google.mjs/microsoft.mjs:
//   - USER tokens (xoxp), not bot tokens: scopes are requested via the
//     `user_scope` param on the authorize URL (the `scope` param is bot-only),
//     and the token comes back under `authed_user` in oauth.v2.access.
//   - No PKCE support — codeChallenge/codeVerifier are simply not sent.
//   - Errors arrive as HTTP 200 + { ok: false, error }.
//   - Tokens DO NOT EXPIRE unless the Slack app opts into token rotation. With
//     rotation off (the default) there is no refresh token and no expires_in —
//     we store a far-future expiry so tokenRefresh never triggers. With
//     rotation on, authed_user carries refresh_token + expires_in and
//     refreshAccessToken below handles the rotation grant.
//   - No per-scope opt-out on the consent screen: Slack grants exactly what
//     was requested, so accessFromGrantedScopes is a straight reverse-map.

export const purposes = ['connection']

// Rotation-off Slack apps (the default) issue no refresh token — the user token
// simply never expires. connectionWriter checks this flag before insisting on one.
export const refreshTokenOptional = true

/**
 * User-token scopes by service and access level.
 * read  — enumerate + read all conversations the user is in, resolve users.
 * readwrite — additionally send as the user (chat:write) and move the read
 * cursor (conversations.mark needs the *:write conversation scopes).
 */
export const scopesByService = {
  messaging: {
    read: [
      'channels:read', 'groups:read', 'im:read', 'mpim:read',
      'channels:history', 'groups:history', 'im:history', 'mpim:history',
      'users:read', 'users:read.email'
    ],
    readwrite: [
      'channels:read', 'groups:read', 'im:read', 'mpim:read',
      'channels:history', 'groups:history', 'im:history', 'mpim:history',
      'users:read', 'users:read.email',
      'chat:write',
      'channels:write', 'groups:write', 'im:write', 'mpim:write'
    ]
  }
}

const AUTH_ENDPOINT = 'https://slack.com/oauth/v2/authorize'
const TOKEN_ENDPOINT = 'https://slack.com/api/oauth.v2.access'

// Rotation-off tokens never expire; store an expiry far enough out that
// ensureFreshAccessToken's "fresh enough" check always passes. (~100 years)
const NON_EXPIRING_MS = 100 * 365 * 24 * 60 * 60 * 1000

/**
 * Compute the final scope list from a services+access map.
 * @param {Object} access  e.g. { messaging: 'readwrite' }
 * @returns {string[]}
 */
export const scopesFor = (access) => {
  const out = new Set()
  for (const [service, level] of Object.entries(access || {})) {
    const arr = scopesByService[service]?.[level] || []
    for (const s of arr) out.add(s)
  }
  return [...out]
}

/**
 * Build the Slack authorization URL. User scopes go in `user_scope`.
 * (No PKCE — Slack doesn't support it; state is the CSRF protection.)
 */
export const buildAuthUrl = (options) => {
  if (!options.state || !options.clientId || !options.scopes) return null
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirecturi,
    state: options.state,
    user_scope: options.scopes.join(',')
  })
  return AUTH_ENDPOINT + '?' + params.toString()
}

// oauth.v2.access (both grants) returns HTTP 200 with ok:false on failure.
const postTokenEndpoint = async (bodyParams, label) => {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(bodyParams)
  })
  const data = await res.json().catch(() => null)
  if (!res.ok || !data || data.ok !== true) {
    const err = new Error('Slack ' + label + ' failed: ' + (data?.error || res.statusText))
    err.code = data?.error
    throw err
  }
  return data
}

/**
 * Exchange an authorization code for a user token.
 * @returns {Promise<{accessToken,refreshToken,expiry,scope}>}
 */
export const exchangeCodeForTokens = async (options) => {
  const data = await postTokenEndpoint({
    code: options.code,
    client_id: options.clientId,
    client_secret: options.secret,
    redirect_uri: options.redirecturi
  }, 'token exchange')

  const user = data.authed_user || {}
  if (!user.access_token) {
    throw new Error('Slack token exchange returned no user token — the app may have requested bot scopes only')
  }
  return {
    accessToken: user.access_token,
    refreshToken: user.refresh_token || null,
    expiry: user.expires_in ? Date.now() + user.expires_in * 1000 : Date.now() + NON_EXPIRING_MS,
    scope: user.scope || ''
  }
}

/**
 * Refresh a user token (token-rotation apps only; rotation-off connections
 * never reach here because their stored expiry is far-future).
 * @returns {Promise<{accessToken,refreshToken?,expiry,scope}>}
 */
export const refreshAccessToken = async (options) => {
  const data = await postTokenEndpoint({
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
    client_id: options.clientId,
    client_secret: options.secret
  }, 'token refresh')

  // Rotation responses have carried the token top-level or under authed_user
  // depending on token type — accept either.
  const user = data.authed_user || data
  if (!user.access_token) {
    const err = new Error('Slack token refresh returned no access token')
    err.code = 'refresh_failed'
    throw err
  }
  return {
    accessToken: user.access_token,
    refreshToken: user.refresh_token || null,
    expiry: user.expires_in ? Date.now() + user.expires_in * 1000 : Date.now() + NON_EXPIRING_MS,
    scope: user.scope || ''
  }
}

/**
 * Reverse-map the granted scope string (comma-separated for Slack) to a
 * per-service access map. Slack grants exactly what was requested, so this
 * mostly mirrors the request — but stay defensive and derive from the string.
 */
export const accessFromGrantedScopes = (grantedScopeString) => {
  if (!grantedScopeString || typeof grantedScopeString !== 'string') return {}
  const scopes = new Set(grantedScopeString.split(/[\s,]+/).filter(Boolean))
  const access = {}
  const canRead = ['channels:history', 'groups:history', 'im:history', 'mpim:history']
    .some(s => scopes.has(s))
  if (scopes.has('chat:write')) {
    access.messaging = 'readwrite'
  } else if (canRead) {
    access.messaging = 'read'
  }
  return access
}

/**
 * Fetch the authenticated user's identity for connection.account_email.
 * auth.test gives ids; users.info adds email (users:read.email) — best-effort.
 * @returns {Promise<{email?:string, name?:string}|null>}
 */
export const fetchAccountProfile = async (options) => {
  const call = async (method, params) => {
    const url = new URL('https://slack.com/api/' + method)
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v)
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + options.accessToken } })
    const data = await res.json().catch(() => null)
    return (data && data.ok === true) ? data : null
  }
  const auth = await call('auth.test', {})
  if (!auth) return null
  const info = auth.user_id ? await call('users.info', { user: auth.user_id }) : null
  return {
    email: info?.user?.profile?.email || null,
    name: info?.user?.profile?.real_name || auth.user || null,
    team: auth.team || null
  }
}

/**
 * Revoke the token at Slack (auth.revoke works on the access token).
 * Best-effort; failure is non-fatal — the local record is deleted regardless.
 */
export const revokeRefreshToken = async (options) => {
  if (!options || !options.token) return false
  try {
    const res = await fetch('https://slack.com/api/auth.revoke', {
      headers: { Authorization: 'Bearer ' + options.token }
    })
    const data = await res.json().catch(() => null)
    return !!(data && data.ok)
  } catch (e) {
    return false
  }
}

export default { purposes, scopesByService, scopesFor, accessFromGrantedScopes, buildAuthUrl, exchangeCodeForTokens, refreshAccessToken, fetchAccountProfile, revokeRefreshToken }
