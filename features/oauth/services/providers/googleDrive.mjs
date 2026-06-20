// freezr.info - OAuth Provider: Google Drive (file-system)
// File-system OAuth provider for Google Drive.
// Extracted from adapters/datastore/environmentDefaults.mjs as part of the OAUTH_PROVIDERS refactor.
//
// This module is purpose=fs only. The provider for connection purpose (Gmail/Calendar/Contacts)
// is './google.mjs' — a separate entry because the freezr admin oauth_serve_setup stores them
// as separate rows. They CAN share a single Google Cloud OAuth client at the operator's
// discretion, but freezr-side they remain decoupled.

export const purposes = ['fs']

const SCOPES = [
  'https://www.googleapis.com/auth/drive'
]

/**
 * Build the Google Drive authorization URL via the googleapis SDK.
 *
 * @param {Object} options
 * @param {string} options.state         OAuth state token
 * @param {string} options.codeChallenge PKCE challenge (S256)
 * @param {string} options.clientId      Google OAuth client ID
 * @param {string} options.secret        Google OAuth client secret
 * @param {string} options.redirecturi   Callback URL
 * @returns {Promise<string>}            Auth URL
 */
export const buildAuthUrl = async (options) => {
  const { google } = await import('googleapis')
  const oauth2Client = new google.auth.OAuth2(options.clientId, options.secret, options.redirecturi)

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    code_challenge_method: 'S256',
    prompt: 'consent', // forces refresh_token issuance — see google-api-nodejs-client #750
    code_challenge: options.codeChallenge,
    // The following params are redundant when present on oauth2Client, but kept for clarity:
    response_type: 'code',
    client_id: options.clientId,
    redirect_uri: options.redirecturi
  })

  return url + '&state=' + options.state
}

/**
 * Exchange an authorization code for tokens via the googleapis SDK.
 *
 * @param {Object} options
 * @param {string} options.code          Authorization code
 * @param {string} options.codeVerifier  PKCE verifier
 * @param {string} options.clientId      Google OAuth client ID
 * @param {string} options.secret        Google OAuth client secret
 * @param {string} options.redirecturi   Callback URL
 * @returns {Promise<{accessToken,refreshToken,expiry}>}
 */
export const exchangeCodeForTokens = async (options) => {
  const { google } = await import('googleapis')
  const oauth2Client = new google.auth.OAuth2(options.clientId, options.secret, options.redirecturi)

  const { tokens } = await oauth2Client.getToken({
    code: options.code,
    codeVerifier: options.codeVerifier,
    client_id: options.clientId,
    redirect_uri: options.redirecturi
  })

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiry: tokens.expiry_date || (tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null)
  }
}

export default { purposes, buildAuthUrl, exchangeCodeForTokens }
