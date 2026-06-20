// freezr.info - Modern ES6 Module - OAuth API Controller
// Handles all OAuth-related API requests

import { sendApiSuccess, sendFailure, sendAuthFailure } from '../../../adapters/http/responses.mjs'
import { OAUTH_PROVIDERS } from '../services/providers/index.mjs'
import {
  createStateParams,
  isStateValid,
  storeState,
  getState,
  deleteState,
  MAX_STATE_TIME_MS
} from '../services/oauthService.mjs'
import { writeConnectionRecord } from '../services/connectionWriter.mjs'
import { startsWith, randomText, expiryDatePassed } from '../../../common/helpers/utils.mjs'
import { APP_TOKEN_OAC, FREEZR_DEFAULT_AUTH_PROVIDER } from '../../../common/helpers/config.mjs'

const RESOURCES_APP_TABLE = 'info.freezr.account.resources'

/**
 * Create OAuth API controller
 * All handlers expect res.locals.freezr to have oauthorDb and cacheManager.
 *
 * @param {Object} [deps]                Optional dependencies for purpose=connection support
 * @param {Object} [deps.dsManager]      Data store manager (required for purpose=connection)
 * @param {Object} [deps.freezrPrefs]    Freezr preferences (required for purpose=connection)
 * @returns {Object} Controller with handler functions
 */
export const createOauthApiController = (deps = {}) => {
  const { dsManager, freezrPrefs } = deps
  return {
    /**
     * List all OAuth configurations
     * GET /oauth/privateapi/list_oauths
     * Admin only - returns all OAuth configurations for the admin page
     */
    listOauths: async (req, res) => {
      try {
        // console.log('listOauths controller', { freezr: res.locals.freezr })
        const { oauthorDb } = res.locals.freezr
        
        if (!oauthorDb) {
          return sendFailure(res, { message: 'OAuth database not initialized' }, 'listOauths', 500)
        }
        
        const results = await oauthorDb.query({}, {})
        res.locals.freezr.permGiven = true
        
        return sendApiSuccess(res, { results: results || [] })
      } catch (error) {
        console.error('❌ Error in listOauths:', error)
        return sendFailure(res, error, 'listOauths', 500)
      }
    },
    
    /**
     * Create or update OAuth configuration
     * PUT /oauth/privateapi/oauth_perm
     * Admin only - creates new OAuth config or updates existing one
     */
    oauthPermMake: async (req, res) => {
      try {
        // console.log('oauthPermMake ', { freezr: res.locals.freezr })
        const { oauthorDb } = res.locals.freezr
        
        if (!oauthorDb) {
          return sendFailure(res, { message: 'OAuth database not initialized' }, 'oauthPermMake', 500)
        }
        
        // Handle delete
        if (req.body.delete && req.body._id) {
          await oauthorDb.delete_record(req.body._id)
          res.locals.freezr.permGiven = true
          return sendApiSuccess(res, { written: 'deleted' })
        }
        
        const isUpdate = Boolean(req.body._id)
        let updateType = null

        // Federation fields (provider-side only — see freezr_mail_phase1.md §2.9):
        //  - federation_enabled: explicit opt-in to act as an OAuth provider for OTHER
        //    freezrs. Default false → partner requests are refused.
        //  - partner_redirect_uris: optional whitelist of consumer freezrs whose users
        //    will see a "pre-approved" banner on the partner_confirm page. Only meaningful
        //    when federation_enabled is true.
        let partnerRedirectUris = req.body.partner_redirect_uris
        if (typeof partnerRedirectUris === 'string') {
          partnerRedirectUris = partnerRedirectUris.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
        } else if (!Array.isArray(partnerRedirectUris)) {
          partnerRedirectUris = []
        }

        // Validation: every admin row IS a direct provider config now. Type, name, key,
        // and redirecturi are required. Users picking a non-default auth provider do so
        // via /connections/new (Custom URL) — no admin-side consumer config needed.
        if (!req.body.type || !req.body.name) {
          return sendFailure(res, { message: 'type and name are required' }, 'oauthPermMake', 400)
        }
        if (!req.body.key || !req.body.redirecturi) {
          return sendFailure(res, { message: 'Client ID and Redirect URI are required' }, 'oauthPermMake', 400)
        }

        // Build params object
        const params = {
          type: req.body.type,
          name: req.body.name,
          key: req.body.key,
          redirecturi: req.body.redirecturi,
          secret: req.body.secret || '',
          enabled: req.body.enabled,
          federation_enabled: !!req.body.federation_enabled,
          partner_redirect_uris: partnerRedirectUris
        }
        
        // Check if exists
        let existingRecord = null
        if (isUpdate) {
          existingRecord = await oauthorDb.read_by_id(req.body._id)
        } else {
          const results = await oauthorDb.query({ type: req.body.type, name: req.body.name }, {})
          if (results && results.length > 0) {
            existingRecord = results[0]
          }
        }
        
        // Create or update
        if (!existingRecord) {
          if (isUpdate) {
            return sendFailure(res, { message: 'Marked as update but no object found' }, 'oauthPermMake', 404)
          }
          updateType = 'new'
          await oauthorDb.create(null, params, null)
        } else {
          updateType = isUpdate ? 'update' : 'update_unplanned'
          const recordId = existingRecord._id + ''
          await oauthorDb.update(recordId, params, { replaceAllFields: true })
        }
        
        res.locals.freezr.permGiven = true
        return sendApiSuccess(res, { written: updateType })
      } catch (error) {
        console.error('❌ Error in oauthPermMake:', error)
        return sendFailure(res, error, 'oauthPermMake', 500)
      }
    },
    
    /**
     * Handle public OAuth operations
     * GET /oauth/:dowhat
     * Public endpoint - handles get_new_state and validate_state
     * 
     * dowhat can be:
     * - get_new_state: Start OAuth flow, returns redirect URL to third party
     * - validate_state: Validate OAuth callback and return credentials
     */
    publicApiActions: async (req, res) => {
      try {
        const { oauthorDb, cacheManager } = res.locals.freezr
        const dowhat = req.params.dowhat
        
        if (!oauthorDb) {
          return sendFailure(res, { message: 'OAuth database not initialized' }, 'publicApiActions', 500)
        }
        
        if (!cacheManager) {
          return sendFailure(res, { message: 'Cache manager not initialized' }, 'publicApiActions', 500)
        }
        
        if (dowhat === 'get_new_state') {
          // Start OAuth flow - get redirect URL to third party
          await handleGetNewState(req, res, oauthorDb, cacheManager)
        } else if (dowhat === 'validate_state') {
          // Validate OAuth callback
          await handleValidateState(req, res, oauthorDb, cacheManager, { dsManager, freezrPrefs })
        } else if (dowhat === 'transfer_info') {
          // Federation: provider-side. Confirm-page reads display details for a transfer flow.
          await handleTransferInfo(req, res, cacheManager)
        } else if (dowhat === 'transfer_proceed') {
          // Federation: provider-side. After user confirms, build Google URL and return it.
          await handleTransferProceed(req, res, cacheManager)
        } else {
          return sendFailure(res, { message: 'Invalid OAuth action: ' + dowhat }, 'publicApiActions', 400)
        }
      } catch (error) {
        console.error('❌ Error in publicApiActions:', error)
        return sendFailure(res, error, 'publicApiActions', 500)
      }
    }
  }
}

// Helper: figure out our own external base URL (scheme + host) for building
// redirect / receiver URLs.
const selfBaseUrl = (req) =>
  (startsWith(req.get('host'), 'localhost') ? 'http' : 'https') + '://' + req.headers.host

// Helper: validate a partner URL (must be HTTPS unless localhost). Returns parsed URL or null.
const parsePartnerUrl = (urlStr) => {
  try {
    const u = new URL(urlStr)
    if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return null
    return u
  } catch (_) { return null }
}

/**
 * Handle get_new_state action.
 * Creates OAuth state and returns redirect URL to third party OAuth provider.
 *
 * Query params (common):
 * - type: OAuth provider type (dropbox, googleDrive, google)
 * - sender: URL to redirect back to after OAuth flow
 * - regcode: Registration code from the sender
 * - purpose: 'fs' (default, backwards-compatible) | 'connection'
 *
 * Query params (purpose=connection only):
 * - connectionName: alphanumeric name for the new connection record
 * - services: comma-separated list of services to enable (e.g. 'mail')
 * - access_<service>: 'read' | 'readwrite' per service (defaults to 'read')
 *
 * Federation query params (purpose=connection only; see freezr_mail_phase1.md §2.9):
 * - redirect_back: when present, this freezr is acting as the PROVIDER for a federated
 *                  flow. After Google consent, freezr-B redirects the user (with tokens) to
 *                  this URL instead of writing to a local user DB. Always shows the
 *                  partner_confirm page first.
 * - consumer_state: opaque state token from the consumer freezr, echoed back so the
 *                   consumer's receiver can look up its own state record.
 */
const handleGetNewState = async (req, res, oauthorDb, cacheManager) => {
  const { type, sender, regcode, connectionName, services: servicesParam } = req.query
  const purpose = req.query.purpose || 'fs'
  const redirectBack = req.query.redirect_back || null
  const consumerState = req.query.consumer_state || null
  // User-supplied auth-provider override (per-connection picker on /connections/new):
  //   absent              → server picks default per admin oauth config
  //   '__local__'         → force admin's direct google config (skip delegation even if admin row has delegate_to)
  //   any other URL       → delegate to that URL (overrides admin default)
  const delegateToOverride = req.query.delegate_to_override || null

  if (!type || !regcode || !sender) {
    return sendFailure(res, 'Need type, regcode and sender to get a state', 'publicApiActions:get_new_state', 400)
  }

  const provider = OAUTH_PROVIDERS[type]
  if (!provider) {
    return sendFailure(res, 'Missing URL generator for type: ' + type, 'publicApiActions:get_new_state', 400)
  }
  if (!provider.purposes || !provider.purposes.includes(purpose)) {
    return sendFailure(res, `Provider '${type}' does not support purpose='${purpose}'`, 'publicApiActions:get_new_state', 400)
  }

  // Validate connection-specific params
  let services = null
  let access = null
  if (purpose === 'connection') {
    if (!connectionName) {
      return sendFailure(res, 'connectionName is required for purpose=connection', 'publicApiActions:get_new_state', 400)
    }
    if (!/^[A-Za-z0-9_-]+$/.test(connectionName)) {
      return sendFailure(res, 'connectionName must be alphanumeric (underscore/dash allowed)', 'publicApiActions:get_new_state', 400)
    }
    services = servicesParam ? servicesParam.split(',').map(s => s.trim()).filter(Boolean) : ['mail']
    access = {}
    for (const s of services) {
      const level = req.query['access_' + s] || 'read'
      if (level !== 'read' && level !== 'readwrite') {
        return sendFailure(res, `access_${s} must be 'read' or 'readwrite'`, 'publicApiActions:get_new_state', 400)
      }
      access[s] = level
    }
  }

  // Find enabled OAuth configuration for this type.
  //
  // Admin oauth_serve_setup rows are always DIRECT provider configs (key + secret +
  // redirecturi). Delegation to a partner freezr is decided per-flow:
  //   - User picks "Custom (another freezr)" at /connections/new → delegate_to_override = URL
  //   - User picks "Default" + no admin row exists  → fall back to FREEZR_DEFAULT_AUTH_PROVIDER
  //   - User picks "Default" + admin row exists      → use the admin row directly
  //   - User picks "This freezr's own"               → delegate_to_override = '__local__'
  //                                                    (force admin row, refuse if missing)
  // The "consumer branch" below is only triggered when delegateToOverride is a URL OR the
  // fallback constant kicks in — admin can no longer pin a row to delegated mode.
  const records = await oauthorDb.query({ type, enabled: true }, null)
  let oauthConfig = (records && records.length > 0) ? records[0] : null

  if (delegateToOverride && purpose === 'connection') {
    if (delegateToOverride === '__local__') {
      // User chose "this freezr's own credentials" — require an admin direct row.
      const direct = (records || []).find(r => r && r.key && r.redirecturi)
      if (!direct) {
        return sendFailure(res, "No direct OAuth client is registered on this freezr. Pick a different authenticator option on /connections/new.", 'publicApiActions:get_new_state', 404)
      }
      oauthConfig = direct
    } else {
      // User typed a custom freezr URL — virtual consumer config delegating there.
      if (!parsePartnerUrl(delegateToOverride)) {
        return sendFailure(res, 'Custom authenticator URL must be HTTPS (or localhost for dev)', 'publicApiActions:get_new_state', 400)
      }
      oauthConfig = { type, name: 'user_custom', delegate_to: delegateToOverride, enabled: true }
    }
  } else if (!oauthConfig && purpose === 'connection' && FREEZR_DEFAULT_AUTH_PROVIDER && type === 'google') {
    // No admin row → fall back to delegating to the freezr.info default provider.
    oauthConfig = { type, name: 'default_freezr_info', delegate_to: FREEZR_DEFAULT_AUTH_PROVIDER, enabled: true }
  } else if (!oauthConfig) {
    return sendFailure(res, 'No enabled OAuth configuration found for type: ' + type, 'publicApiActions:get_new_state', 404)
  }
  if (!oauthConfig.enabled) {
    return sendFailure(res, 'OAuth configuration is not enabled', 'publicApiActions:get_new_state', 403)
  }

  // ===== Branch: PROVIDER side of a federated flow (redirect_back is present) =====
  // We're being asked by another freezr to handle a Google OAuth flow on their behalf.
  // Refuse unless the admin has explicitly opted in via federation_enabled — by default
  // a freezr's credentials only serve its own users.
  if (redirectBack && purpose === 'connection') {
    const parsedRedirectBack = parsePartnerUrl(redirectBack)
    if (!parsedRedirectBack) {
      return sendFailure(res, 'redirect_back must be a valid HTTPS URL (or localhost for dev)', 'publicApiActions:get_new_state', 400)
    }
    if (!oauthConfig.key || !oauthConfig.secret) {
      return sendFailure(res, 'This freezr is not configured as a provider (no Google client registered). Cannot accept delegated flows.', 'publicApiActions:get_new_state', 500)
    }
    if (!oauthConfig.federation_enabled) {
      return sendFailure(res, "This freezr has not opted in to act as an auth provider for other freezrs. Pick a different authenticator at /connections/new.", 'publicApiActions:get_new_state', 403)
    }

    const partnerRedirectUris = Array.isArray(oauthConfig.partner_redirect_uris) ? oauthConfig.partner_redirect_uris : []
    const isWhitelisted = partnerRedirectUris.some(u => {
      try { return new URL(u).href === parsedRedirectBack.href } catch (_) { return false }
    })

    const ourRedirectUri = selfBaseUrl(req) + '/public/oauth/oauth_validate_page'

    const stateParams = createStateParams({
      ip: req.ip, type, regcode,
      sender: redirectBack,  // After Google we redirect tokens to consumer's receiver
      redirecturi: ourRedirectUri,
      clientId: oauthConfig.key,
      secret: oauthConfig.secret,
      name: oauthConfig.name
    })
    stateParams.purpose = 'connection'
    stateParams.connectionName = connectionName
    stateParams.services = services
    stateParams.access = access
    stateParams.redirect_back = redirectBack
    stateParams.consumer_state = consumerState
    stateParams.is_provider_transfer = true
    stateParams.is_whitelisted_consumer = isWhitelisted
    if (typeof provider.scopesFor === 'function') {
      stateParams.scopes = provider.scopesFor(access)
    }

    storeState(cacheManager, stateParams)
    req.session.oauth_state = stateParams.state

    const confirmUrl = selfBaseUrl(req) + '/public/oauth/partner_confirm?state=' + encodeURIComponent(stateParams.state)
    res.locals.freezr.permGiven = true
    return sendApiSuccess(res, { redirecturi: confirmUrl })
  }

  // ===== Branch: CONSUMER side of a federated flow (oauthConfig has delegate_to) =====
  // We don't have our own provider client (or have chosen to delegate). Redirect user
  // to the partner freezr's start page, carrying our state token as consumer_state so
  // the partner can echo it back; we use it to recover this flow's context on return.
  if (oauthConfig.delegate_to && purpose === 'connection') {
    const parsedPartner = parsePartnerUrl(oauthConfig.delegate_to)
    if (!parsedPartner) {
      return sendFailure(res, 'delegate_to is not a valid HTTPS URL', 'publicApiActions:get_new_state', 500)
    }

    const ourReceiver = selfBaseUrl(req) + '/public/oauth/oauth_transfer_receiver'

    const stateParams = createStateParams({
      ip: req.ip, type, regcode, sender,
      redirecturi: ourReceiver,
      clientId: '',     // we don't have one — partner does
      secret: '',
      name: oauthConfig.name
    })
    stateParams.purpose = 'connection'
    stateParams.connectionName = connectionName
    stateParams.services = services
    stateParams.access = access
    stateParams.delegate_to = oauthConfig.delegate_to
    stateParams.is_consumer_state = true
    storeState(cacheManager, stateParams)
    req.session.oauth_state = stateParams.state

    // Build URL to partner's start page
    const partnerUrl = new URL(parsedPartner.href.replace(/\/$/, '') + '/public/oauth/oauth_start_oauth')
    partnerUrl.searchParams.set('type', type)
    partnerUrl.searchParams.set('purpose', 'connection')
    partnerUrl.searchParams.set('sender', ourReceiver)
    partnerUrl.searchParams.set('regcode', regcode)
    partnerUrl.searchParams.set('connectionName', connectionName)
    partnerUrl.searchParams.set('services', services.join(','))
    services.forEach(s => partnerUrl.searchParams.set('access_' + s, access[s]))
    partnerUrl.searchParams.set('redirect_back', ourReceiver)
    partnerUrl.searchParams.set('consumer_state', stateParams.state)

    res.locals.freezr.permGiven = true
    return sendApiSuccess(res, { redirecturi: partnerUrl.toString() })
  }

  // ===== Direct flow (no federation) — existing behavior =====
  const redirecturi = selfBaseUrl(req) + '/public/oauth/oauth_validate_page'

  const stateParams = createStateParams({
    ip: req.ip, type, regcode, sender, redirecturi,
    clientId: oauthConfig.key, secret: oauthConfig.secret, name: oauthConfig.name
  })
  stateParams.purpose = purpose
  if (purpose === 'connection') {
    stateParams.connectionName = connectionName
    stateParams.services = services
    stateParams.access = access
    if (typeof provider.scopesFor === 'function') {
      stateParams.scopes = provider.scopesFor(access)
    }
  }

  storeState(cacheManager, stateParams)
  req.session.oauth_state = stateParams.state

  const authUrl = await provider.buildAuthUrl(stateParams)
  if (!authUrl) {
    return sendFailure(res, 'Failed to generate auth URL for type: ' + type, 'publicApiActions:get_new_state', 500)
  }

  res.locals.freezr.permGiven = true
  return sendApiSuccess(res, { redirecturi: authUrl })
}

/**
 * Handle validate_state action.
 * Validates OAuth callback, exchanges code for tokens, then either:
 *   - purpose=fs (default):     returns credentials to sender page (existing behavior)
 *   - purpose=connection:       writes a connection record to the user's resources DB
 *                               server-side, then returns success metadata (no tokens) to sender
 *
 * Query params:
 * - state: OAuth state token
 * - code: Authorization code from OAuth provider (optional)
 * - accessToken: Access token from OAuth provider (optional, legacy)
 */
const handleValidateState = async (req, res, oauthorDb, cacheManager, deps = {}) => {
  let { state, code, accessToken } = req.query

  // Normalize null strings
  if (accessToken === 'null') accessToken = null
  if (code === 'null') code = null

  // Get state from cache
  const stateParams = getState(cacheManager, state)

  // Validate state
  if (!stateParams) {
    return sendAuthFailure(res, {
      message: 'No auth state found or state expired',
      type: 'auth_error',
      path: req.path,
      url: req.url
    })
  }

  if (req.session.oauth_state !== state) {
    return sendAuthFailure(res, {
      message: 'State mismatch - session state does not match',
      type: 'auth_error',
      path: req.path,
      url: req.url
    })
  }

  if (!isStateValid(stateParams)) {
    deleteState(cacheManager, state)
    return sendAuthFailure(res, {
      message: 'State has expired',
      type: 'auth_error',
      path: req.path,
      url: req.url
    })
  }

  if (!code && !accessToken) {
    return sendAuthFailure(res, {
      message: 'Missing code or access token',
      type: 'auth_error',
      path: req.path,
      url: req.url
    })
  }

  // Store code in state params if present
  if (code) stateParams.code = code

  // Verify OAuth configuration is still enabled
  const records = await oauthorDb.query({ type: stateParams.type, name: stateParams.name }, null)
  if (!records || records.length === 0) {
    return sendAuthFailure(res, {
      message: 'OAuth configuration no longer exists',
      type: 'auth_error',
      path: req.path,
      url: req.url
    })
  }
  if (!records[0].enabled) {
    return sendAuthFailure(res, {
      message: 'OAuth configuration has been disabled',
      type: 'auth_error',
      path: req.path,
      url: req.url
    })
  }

  // Exchange code for tokens via the provider registry
  const provider = OAUTH_PROVIDERS[stateParams.type]
  if (provider && typeof provider.exchangeCodeForTokens === 'function' && code) {
    try {
      const tokens = await provider.exchangeCodeForTokens(stateParams)
      if (tokens) {
        stateParams.refreshToken = tokens.refreshToken
        stateParams.accessToken = tokens.accessToken
        stateParams.expiry = tokens.expiry
        stateParams.tokenScope = tokens.scope
      }
    } catch (error) {
      console.warn('Failed to get refresh token:', error.message)
      // Continue anyway - some providers don't return refresh tokens (e.g. accessToken-only flows)
    }
  }

  // Branch on flow:
  //   1) Provider-side federated transfer  → URL-pass tokens back to consumer (no DB write here)
  //   2) Direct connection                  → write to local user's resources DB
  //   3) FS flow                            → return creds to sender page (existing behavior)
  const purpose = stateParams.purpose || 'fs'

  if (purpose === 'connection' && stateParams.is_provider_transfer) {
    // We're freezr-B finishing the OAuth dance on behalf of freezr-A.
    // No logged-in user on this freezr — return tokens to the consumer's receiver via the
    // existing sender-redirect machinery in oauth_validate_page.js. The sender is the
    // consumer's transfer_receiver URL (we set it as stateParams.sender during get_new_state).
    if (!stateParams.accessToken || !stateParams.refreshToken) {
      return sendAuthFailure(res, {
        message: 'Token exchange did not return both access and refresh tokens — cannot complete transfer',
        type: 'auth_error',
        path: req.path,
        url: req.url
      })
    }

    const transferPayload = {
      success: true,
      purpose: 'connection_transfer',
      sender: stateParams.sender,                       // consumer freezr's transfer_receiver URL
      consumer_state: stateParams.consumer_state,       // consumer's state key — they look up flow context with this
      accessToken: stateParams.accessToken,
      refreshToken: stateParams.refreshToken,
      expiry: stateParams.expiry,
      tokenScope: stateParams.tokenScope || '',
      // Echo the requested context so the consumer doesn't have to round-trip its own state cache
      // for the basics (it can still use consumer_state to recover the full record).
      connectionName: stateParams.connectionName,
      provider: stateParams.type,
      services: (stateParams.services || []).join(','),
      // Per-service access map serialized for URL transit
      access: JSON.stringify(stateParams.access || {})
    }

    deleteState(cacheManager, state)
    req.session.oauth_state = null

    res.locals.freezr.permGiven = true
    return sendApiSuccess(res, transferPayload)
  }

  if (purpose === 'connection') {
    return await handleConnectionPurpose(req, res, stateParams, cacheManager, deps, provider)
  }

  // Build response (existing FS flow)
  const toSend = {
    code: code,
    accessToken: accessToken || stateParams.accessToken,
    regcode: stateParams.regcode,
    type: stateParams.type,
    sender: stateParams.sender,
    clientId: stateParams.clientId,
    codeChallenge: stateParams.codeChallenge,
    codeVerifier: stateParams.codeVerifier,
    redirecturi: stateParams.redirecturi,
    refreshToken: stateParams.refreshToken,
    expiry: stateParams.expiry,
    success: true
  }
  
  // For Google Drive, we need to include the secret
  // (Unfortunately the only way to authenticate without re-pinging every hour)
  if (stateParams.type === 'googleDrive') {
    toSend.secret = stateParams.secret
  }
  
  // Clean up state
  deleteState(cacheManager, state)
  req.session.oauth_state = null

  res.locals.freezr.permGiven = true
  return sendApiSuccess(res, toSend)
}

/**
 * Handle purpose=connection completion: write the connection record to the user's
 * info.freezr.account.resources collection, then return success metadata to the sender
 * page (which redirects the browser to e.g. /account/resources?success=true&resource_id=...).
 *
 * Requires the user to be logged in (req.session.logged_in_user_id) and requires
 * dsManager + freezrPrefs to be available via deps.
 *
 * Tokens are NEVER returned to the client for purpose=connection — they are encrypted
 * with encryptParams and stored server-side.
 */
const handleConnectionPurpose = async (req, res, stateParams, cacheManager, deps, provider) => {
  const { dsManager, freezrPrefs } = deps || {}
  const userId = req.session?.logged_in_user_id

  if (!userId) {
    return sendAuthFailure(res, {
      message: 'Must be logged in to complete a connection OAuth flow',
      type: 'auth_error',
      path: req.path,
      url: req.url
    })
  }

  if (!dsManager || !freezrPrefs) {
    console.error('handleConnectionPurpose missing dsManager / freezrPrefs — controller wiring bug')
    return sendFailure(res, { message: 'Server misconfiguration: connection purpose unavailable' }, 'handleConnectionPurpose', 500)
  }

  if (!stateParams.accessToken || !stateParams.refreshToken) {
    return sendAuthFailure(res, {
      message: 'Token exchange did not return both access and refresh tokens — cannot persist connection',
      type: 'auth_error',
      path: req.path,
      url: req.url
    })
  }

  // Delegate persistence to the shared writeConnectionRecord service — used here by the
  // direct connection flow AND by /oauth/store_transferred_credentials for the federated
  // transfer flow. The service reconciles requested-vs-granted scopes, fetches the
  // account email, encrypts oauth, and upserts the connection record.
  const result = await writeConnectionRecord({
    dsManager,
    freezrPrefs,
    userId,
    providerType: stateParams.type,
    oauthConfigName: stateParams.name,
    accessToken: stateParams.accessToken,
    refreshToken: stateParams.refreshToken,
    expiry: stateParams.expiry,
    tokenScope: stateParams.tokenScope,
    connectionName: stateParams.connectionName,
    requestedServices: stateParams.services || [],
    requestedAccess: stateParams.access || {}
  })

  if (!result.ok) {
    if (result.code === 'no_services_granted') {
      return sendAuthFailure(res, {
        message: result.message,
        type: 'auth_error',
        path: req.path,
        url: req.url
      })
    }
    return sendFailure(res, { message: result.message }, 'handleConnectionPurpose', 500)
  }

  // Clean up state
  deleteState(cacheManager, stateParams.state)
  req.session.oauth_state = null

  res.locals.freezr.permGiven = true
  return sendApiSuccess(res, {
    success: true,
    purpose: 'connection',
    sender: stateParams.sender,
    resource_id: result.resourceId,
    connectionName: stateParams.connectionName,
    provider: stateParams.type,
    services: result.actualServices,
    downgraded: result.downgraded.length > 0 ? JSON.stringify(result.downgraded) : undefined
  })
}

/**
 * GET /oauth/transfer_info?state=<state>  — provider-side
 *
 * Returns display-safe info about an in-flight transfer flow for the partner_confirm page
 * to render. Returns 404 if the state is unknown / expired. The caller's session must own
 * this state (matches req.session.oauth_state) — otherwise refuse.
 *
 * No tokens / clientId / secret are ever included in the response.
 */
const handleTransferInfo = async (req, res, cacheManager) => {
  const { state } = req.query
  if (!state) {
    return sendFailure(res, 'state is required', 'transfer_info', 400)
  }
  const sp = getState(cacheManager, state)
  if (!sp || !sp.is_provider_transfer) {
    return sendFailure(res, 'No transfer state found (may have expired)', 'transfer_info', 404)
  }
  if (req.session.oauth_state !== state) {
    return sendFailure(res, 'state does not match session', 'transfer_info', 403)
  }
  if (!isStateValid(sp)) {
    deleteState(cacheManager, state)
    return sendFailure(res, 'state has expired', 'transfer_info', 410)
  }

  res.locals.freezr.permGiven = true
  return sendApiSuccess(res, {
    state,                          // echoed back so the page can pass it to /oauth/transfer_proceed
    redirect_back: sp.redirect_back,
    is_whitelisted_consumer: !!sp.is_whitelisted_consumer,
    provider: sp.type,
    connectionName: sp.connectionName,
    services: sp.services || [],
    access: sp.access || {}
  })
}

/**
 * GET /oauth/transfer_proceed?state=<state>  — provider-side
 *
 * Called by the partner_confirm page after the user clicks Continue. Builds the real
 * provider auth URL (e.g. Google's consent screen) and returns it for the page to navigate
 * to. State must still match the session and not have expired.
 */
const handleTransferProceed = async (req, res, cacheManager) => {
  const { state } = req.query
  if (!state) {
    return sendFailure(res, 'state is required', 'transfer_proceed', 400)
  }
  const sp = getState(cacheManager, state)
  if (!sp || !sp.is_provider_transfer) {
    return sendFailure(res, 'No transfer state found (may have expired)', 'transfer_proceed', 404)
  }
  if (req.session.oauth_state !== state) {
    return sendFailure(res, 'state does not match session', 'transfer_proceed', 403)
  }
  if (!isStateValid(sp)) {
    deleteState(cacheManager, state)
    return sendFailure(res, 'state has expired', 'transfer_proceed', 410)
  }

  const provider = OAUTH_PROVIDERS[sp.type]
  if (!provider || typeof provider.buildAuthUrl !== 'function') {
    return sendFailure(res, 'Provider not registered or cannot build auth URL', 'transfer_proceed', 500)
  }

  const authUrl = await provider.buildAuthUrl(sp)
  if (!authUrl) {
    return sendFailure(res, 'Failed to generate auth URL', 'transfer_proceed', 500)
  }

  res.locals.freezr.permGiven = true
  return sendApiSuccess(res, { redirecturi: authUrl })
}

/**
 * Factory: POST /oauth/store_transferred_credentials  — consumer-side
 *
 * Called by the oauth_transfer_receiver page on the consumer freezr after the user
 * returns from the partner with tokens in the URL. Body contains the received tokens
 * + the consumer_state token that lets us recover the original flow context (services,
 * access, connectionName).
 *
 * Persists via writeConnectionRecord — same code path as the direct connection flow.
 *
 * Auth: requires logged-in session. The state's session-binding is also re-checked.
 */
export const createStoreTransferredCredentialsHandler = ({ dsManager, freezrPrefs }) => {
  return async (req, res) => {
    try {
      const userId = req.session?.logged_in_user_id
      if (!userId) {
        return sendAuthFailure(res, {
          message: 'Must be logged in to complete a connection',
          type: 'auth_error',
          path: req.path, url: req.url
        })
      }

      const {
        consumer_state: consumerState,
        accessToken, refreshToken, expiry, tokenScope,
        connectionName, provider: providerType, services, access
      } = req.body || {}

      if (!consumerState || !accessToken || !refreshToken) {
        return sendFailure(res, 'Missing required fields (consumer_state, accessToken, refreshToken)', 'store_transferred_credentials', 400)
      }

      // Recover the consumer-side state to verify continuity (session binding +
      // canonical connectionName / services / access).
      const cacheManager = res.locals.freezr?.cacheManager
      if (!cacheManager) {
        return sendFailure(res, { message: 'Cache manager not available' }, 'store_transferred_credentials', 500)
      }
      const sp = getState(cacheManager, consumerState)
      if (!sp || !sp.is_consumer_state) {
        return sendFailure(res, 'Consumer state not found (may have expired)', 'store_transferred_credentials', 404)
      }
      if (req.session.oauth_state !== consumerState) {
        return sendFailure(res, 'consumer_state does not match session', 'store_transferred_credentials', 403)
      }
      if (!isStateValid(sp)) {
        deleteState(cacheManager, consumerState)
        return sendFailure(res, 'consumer_state has expired', 'store_transferred_credentials', 410)
      }

      // Use authoritative values from server-side state, falling back to client-supplied
      // ones if state somehow doesn't have them. The state-derived values are the canonical
      // source — body fields are accepted only as best-effort hints for logging.
      const canonicalConnectionName = sp.connectionName || connectionName
      const canonicalProvider = sp.type || providerType
      const canonicalServices = sp.services || (typeof services === 'string' ? services.split(',').filter(Boolean) : (services || []))
      let canonicalAccess = sp.access
      if (!canonicalAccess) {
        try { canonicalAccess = typeof access === 'string' ? JSON.parse(access) : (access || {}) }
        catch (_) { canonicalAccess = {} }
      }

      const result = await writeConnectionRecord({
        dsManager,
        freezrPrefs,
        userId,
        providerType: canonicalProvider,
        oauthConfigName: sp.name,
        accessToken,
        refreshToken,
        expiry: Number(expiry) || null,
        tokenScope: tokenScope || '',
        connectionName: canonicalConnectionName,
        requestedServices: canonicalServices,
        requestedAccess: canonicalAccess
      })

      if (!result.ok) {
        const status = result.code === 'no_services_granted' ? 400 : 500
        return sendFailure(res, { message: result.message }, 'store_transferred_credentials', status)
      }

      // Done. Clean up the consumer state.
      deleteState(cacheManager, consumerState)
      req.session.oauth_state = null

      res.locals.freezr.permGiven = true
      return sendApiSuccess(res, {
        success: true,
        purpose: 'connection',
        sender: sp.sender,            // typically /account/resources
        resource_id: result.resourceId,
        connectionName: canonicalConnectionName,
        provider: canonicalProvider,
        services: result.actualServices,
        downgraded: result.downgraded.length > 0 ? JSON.stringify(result.downgraded) : undefined
      })
    } catch (error) {
      console.error('❌ Error in store_transferred_credentials:', error)
      return sendFailure(res, error, 'store_transferred_credentials', 500)
    }
  }
}

/**
 * Create App Token Login controller
 * Handles POST /oauth/token - exchanges app password for access token
 * 
 * This is the OAuth 2.0 password grant flow for freezr apps:
 * 1. App generates app password via /acctapi/generateAppPassword
 * 2. App exchanges app password for access token via POST /oauth/token
 * 3. App uses access token for subsequent API calls
 * 
 * @param {object} dependencies - Required dependencies
 * @param {object} dependencies.dsManager - Data store manager
 * @param {object} dependencies.freezrPrefs - Freezr preferences
 * @returns {Function} Express handler function
 */
export const createAppTokenLoginHandler = ({ dsManager, freezrPrefs }) => {
  return async (req, res) => {
    try {
      // Initialize res.locals.freezr if not present
      if (!res.locals.freezr) {
        res.locals.freezr = {}
      }
            
      // Extract request body
      const { password, username: userId, client_id: appName, grant_type, expiry: requestedExpiry } = req.body
      
      // Validate required parameters
      if (!userId) {
        return sendAuthFailure(res, { message: 'Missing username', code: 'missing_user_id' })
      }
      if (!appName) {
        return sendAuthFailure(res, { message: 'Missing client_id', code: 'missing_app_name' })
      }
      if (!password) {
        return sendAuthFailure(res, { message: 'Missing password', code: 'missing_password' })
      }
      if (grant_type !== 'password') {
        return sendAuthFailure(res, { message: 'Wrong grant type - only password accepted', code: 'wrong_grant_type' })
      }
      
      // Create/update device_code in session if not present
      if (!req.session.device_code) {
        req.session.device_code = randomText(20)
        
        const devicesOac = {
          app_name: 'info.freezr.account',
          collection_name: 'user_devices',
          owner: userId
        }
        
        const devicesDb = await dsManager.getorInitDb(devicesOac, { freezrPrefs })
        
        const deviceWrite = {
          device_code: req.session.device_code,
          user_id: userId,
          single_app: appName,
          user_agent: req.headers['user-agent']
        }
        
        await devicesDb.upsert(
          { device_code: req.session.device_code, user_id: userId, single_app: appName },
          deviceWrite
        )
      }
      
      // Get token database
      const tokenDb = await dsManager.getorInitDb(APP_TOKEN_OAC, { freezrPrefs })
      
      // Query for the app password record
      const results = await tokenDb.query({ app_password: password }, null)
      
      if (!results || results.length === 0) {
        return sendAuthFailure(res, { 
          message: 'Invalid password',
          type: 'auth_error',
          error: 'Invalid password in createAppTokenLoginHandler',
          path: req.path,
          url: req.url
        })
      }
      
      const record = results[0]
      
      // Validate the password record
      if (record.owner_id !== userId || record.requestor_id !== userId || record.app_name !== appName) {
        return sendAuthFailure(res, { 
          message: 'App name or user ID do not match',
          type: 'auth_error',
          error: 'Credential mismatch in createAppTokenLoginHandler',
          path: req.path,
          url: req.url
        })
      }
      
      if (record.date_used) {
        return sendAuthFailure(res, { 
          message: 'One time password already in use',
          type: 'auth_error',
          error: 'One time password already used in createAppTokenLoginHandler',
          path: req.path,
          url: req.url
        })
      }
      
      if (expiryDatePassed(record.expiry)) {
        console.warn('appToken / password_expired for user:', userId)
        return sendAuthFailure(res, { 
          message: 'One time password has expired',
          type: 'auth_error',
          error: 'One time password expired in createAppTokenLoginHandler',
          path: req.path,
          url: req.url
        })
      }
      
      // Get the app token
      const appToken = record.app_token
      let expiresIn = record.expiry
      
      // Use requested expiry if it's sooner
      if (requestedExpiry && requestedExpiry < expiresIn) {
        expiresIn = requestedExpiry
      }
      
      // 🟣🟣🟣 DIAG: OAuth password-grant exchange touches an offline token's expiry
      // (only path other than CEPS validate that writes to expiry). Should NOT fire
      // on ordinary CEPS read/write/query calls.
      // console.log('🟣🟣🟣 OFFLINE-TOKEN OAuth password-grant exchange (writes expiry)', {
      //   app_token: appToken ? appToken.substring(0, 10) + '...' : null,
      //   user_id: userId,
      //   app_name: appName,
      //   record_expiry_iso: record.expiry ? new Date(record.expiry).toISOString() : null,
      //   requestedExpiry_iso: requestedExpiry ? new Date(requestedExpiry).toISOString() : null,
      //   finalExpiresIn_iso: expiresIn ? new Date(expiresIn).toISOString() : null,
      //   finalExpiresIn_sec_from_now: expiresIn ? Math.round((expiresIn - Date.now()) / 1000) : null
      // })

      // Update the record to mark it as used
      await tokenDb.update(
        record._id + '',
        { 
          date_used: new Date().getTime(), 
          user_device: req.session.device_code, 
          expiry: expiresIn 
        },
        {}
      )
      
      // Send success response
      res.locals.freezr.permGiven = true
      return sendApiSuccess(res, { 
        access_token: appToken, 
        user_id: userId, 
        app_name: appName, 
        expires_in: expiresIn 
      })
      
    } catch (error) {
      console.error('❌ Error in appTokenLogin:', error)
      return sendAuthFailure(res, { 
        message: 'Token exchange failed',
        type: 'auth_error',
        error: (error.message || 'unknown error') + ' - Token exchange failed in createAppTokenLoginHandler',
        path: req.path,
        url: req.url
      })
    }
  }
}

export default {
  createOauthApiController,
  createAppTokenLoginHandler
}
