// freezr.info - OAuth Provider: Dropbox
// File-system OAuth provider for Dropbox.
// Extracted from adapters/datastore/environmentDefaults.mjs as part of the OAUTH_PROVIDERS refactor.
//
// Each provider in this directory exports the same interface:
//   - purposes:                 string[]   - which freezr purposes this provider serves
//   - buildAuthUrl(options):    string     - synchronous URL builder for /oauth/get_new_state
//   - exchangeCodeForTokens(opts): Promise<{ accessToken, refreshToken, expiry }>
//                                          - called from /oauth/validate_state
//   - refreshAccessToken(opts): Promise<{ accessToken, expiry }>  (optional)
//                                          - called by long-running consumers needing a fresh token

export const purposes = ['fs']

/**
 * Build the Dropbox authorization URL.
 * Dropbox uses PKCE (no client_secret needed for public client model freezr currently uses).
 *
 * @param {Object} options
 * @param {string} options.state         OAuth state token
 * @param {string} options.codeChallenge PKCE challenge (S256)
 * @param {string} options.clientId      Dropbox app key
 * @param {string} options.redirecturi   Callback URL
 * @returns {string|null}                Auth URL, or null if required params missing
 */
export const buildAuthUrl = (options) => {
  if (!options.codeChallenge || !options.state || !options.clientId) {
    return null
  }
  return 'https://www.dropbox.com/oauth2/authorize?client_id=' + options.clientId +
    '&redirect_uri=' + encodeURIComponent(options.redirecturi) +
    '&response_type=code&token_access_type=offline&state=' + options.state +
    '&code_challenge_method=S256&code_challenge=' + options.codeChallenge
}

/**
 * Exchange an authorization code for tokens via the Dropbox SDK.
 *
 * @param {Object} options
 * @param {string} options.code          Authorization code returned by Dropbox
 * @param {string} options.codeChallenge PKCE challenge (passed to SDK auth instance)
 * @param {string} options.codeVerifier  PKCE verifier (proves the original challenge)
 * @param {string} options.clientId      Dropbox app key
 * @param {string} options.redirecturi   Callback URL (must match buildAuthUrl)
 * @returns {Promise<{accessToken,refreshToken,expiry}>}
 */
export const exchangeCodeForTokens = async (options) => {
  const { Dropbox } = await import('dropbox')
  const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args))
  const dbx = new Dropbox({ fetch, clientId: options.clientId })

  dbx.auth.codeChallenge = options.codeChallenge
  dbx.auth.codeVerifier = options.codeVerifier

  const token = await dbx.auth.getAccessTokenFromCode(options.redirecturi, options.code)
  if (!token || !token.result) {
    throw new Error('could not get token for dropbox')
  }
  return {
    accessToken: token.result.access_token,
    refreshToken: token.result.refresh_token,
    expiry: token.result.expiry_date || (token.result.expires_in ? Date.now() + token.result.expires_in * 1000 : null)
  }
}

export default { purposes, buildAuthUrl, exchangeCodeForTokens }
