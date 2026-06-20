// freezr.info - Mail feature: token refresh
// Refreshes the connection's OAuth access token when it's near expiry, using the
// stored refresh token + the admin-registered client credentials.
//
// Concurrency: see freezr_mail_phase1.md §4.3. Uses a `refresh_lock_at` timestamp
// field on the connection record to coordinate parallel refresh attempts. The lock
// is best-effort (no atomic compare-and-set across freezr's storage adapters) but
// works well in practice for the FEPS sync request volume.

import { encryptParams } from '../../../register/services/registerServices.mjs'
import { decryptResourceSensitiveFields } from '../../../account/services/resourceCrypto.mjs'
import { OAUTH_PROVIDERS } from '../../../oauth/services/providers/index.mjs'
import { OAUTH_DB_OAC } from '../../../oauth/middleware/oauthContext.mjs'

const RESOURCES_APP_TABLE = 'info.freezr.account.resources'
const REFRESH_WINDOW_MS = 60 * 1000    // refresh if token expires within the next 60s
const REFRESH_LOCK_TTL_MS = 30 * 1000  // treat older locks as stale
const POLL_INTERVAL_MS = 250
const MAX_POLL_WAIT_MS = 5 * 1000

const now = () => Date.now()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * Ensure the given connection record has a usable, non-expired access token.
 *
 * Reads the record (caller may pass an already-fetched record to avoid a re-read),
 * refreshes if needed, persists the new tokens encrypted, and returns the
 * decrypted oauth sub-object so the caller can use the access token immediately.
 *
 * @param {Object} options
 * @param {Object} options.dsManager       Required
 * @param {Object} options.freezrPrefs     Required
 * @param {string} options.userId          Owner of the connection record
 * @param {Object} options.connection      The connection record (as queried from the DB)
 * @returns {Promise<{accessToken,refreshToken,expiry,...}>}  Decrypted oauth for immediate use
 * @throws  If refresh fails (e.g. refresh token revoked). The connection record's
 *          status is set to 'token_expired' on persistent failure.
 */
export const ensureFreshAccessToken = async ({ dsManager, freezrPrefs, userId, connection }) => {
  if (!connection) throw new Error('ensureFreshAccessToken: connection record is required')

  // Decrypt current oauth — handles both encrypted and plain-object shapes.
  const decrypted = decryptResourceSensitiveFields(connection)
  const currentOauth = decrypted.oauth || {}

  // Fresh enough? Use what we have.
  const expiry = currentOauth.expiry || 0
  if (expiry && expiry > now() + REFRESH_WINDOW_MS && currentOauth.accessToken) {
    return currentOauth
  }

  // Need a refresh. Get the DB so we can read locks + persist new tokens.
  const resourcesDb = await dsManager.getorInitDb(
    { app_table: RESOURCES_APP_TABLE, owner: userId },
    { freezrPrefs }
  )
  if (!resourcesDb) throw new Error('Could not open user resources DB for token refresh')

  // Acquire a refresh lock — see §4.3. Race-safe enough for our load:
  // - If another request set refresh_lock_at recently, wait briefly for the
  //   updated tokens to land, then read them.
  // - Otherwise set our own lock and proceed.
  const lockedAt = connection.refresh_lock_at
  if (lockedAt && (now() - lockedAt) < REFRESH_LOCK_TTL_MS) {
    // Another request is refreshing. Poll for the new tokens.
    const waitStart = now()
    while ((now() - waitStart) < MAX_POLL_WAIT_MS) {
      await sleep(POLL_INTERVAL_MS)
      const fresh = await resourcesDb.read_by_id(connection._id + '').catch(() => null)
      if (!fresh) break
      if (!fresh.refresh_lock_at || (now() - fresh.refresh_lock_at) > REFRESH_LOCK_TTL_MS) {
        // Lock cleared — re-read and check expiry
        const f = decryptResourceSensitiveFields(fresh).oauth || {}
        if (f.expiry && f.expiry > now() + REFRESH_WINDOW_MS && f.accessToken) {
          return f
        }
        break
      }
    }
    // Fall through and attempt our own refresh as stale-lock safety.
  }

  // Set our lock and refresh.
  await resourcesDb.update(connection._id + '', { refresh_lock_at: now() }, { replaceAllFields: false }).catch(() => {})

  // Need the admin OAuth config (clientId + secret) for this provider.
  const provider = OAUTH_PROVIDERS[connection.provider]
  if (!provider || typeof provider.refreshAccessToken !== 'function') {
    await resourcesDb.update(connection._id + '', { refresh_lock_at: null, status: 'token_expired' }, { replaceAllFields: false }).catch(() => {})
    const err = new Error('Provider does not support refresh: ' + connection.provider)
    err.code = 'no_refresh_support'
    throw err
  }

  const oauthorDb = await dsManager.getorInitDb(OAUTH_DB_OAC, { freezrPrefs })
  const oauthRows = await oauthorDb.query({ type: connection.provider, enabled: true }, null)
  const oauthConfig = (oauthRows && oauthRows[0]) || null
  if (!oauthConfig) {
    await resourcesDb.update(connection._id + '', { refresh_lock_at: null, status: 'token_expired' }, { replaceAllFields: false }).catch(() => {})
    const err = new Error('No enabled OAuth config for provider ' + connection.provider)
    err.code = 'no_oauth_config'
    throw err
  }

  if (!currentOauth.refreshToken) {
    await resourcesDb.update(connection._id + '', { refresh_lock_at: null, status: 'token_expired' }, { replaceAllFields: false }).catch(() => {})
    const err = new Error('Connection has no refresh token — must reconnect')
    err.code = 'no_refresh_token'
    throw err
  }

  let refreshed
  try {
    refreshed = await provider.refreshAccessToken({
      refreshToken: currentOauth.refreshToken,
      clientId: oauthConfig.key,
      secret: oauthConfig.secret
    })
  } catch (e) {
    // Refresh failed (revoked, etc.) — mark as expired, surface error.
    await resourcesDb.update(connection._id + '', { refresh_lock_at: null, status: 'token_expired' }, { replaceAllFields: false }).catch(() => {})
    const err = new Error('Token refresh failed: ' + (e?.message || e))
    err.code = 'refresh_failed'
    throw err
  }

  // Build the new encrypted oauth blob, preserving the refresh token (Google's refresh
  // response usually omits it — the original stays valid until revoked).
  const newOauth = {
    accessToken: refreshed.accessToken,
    refreshToken: currentOauth.refreshToken,
    expiry: refreshed.expiry,
    oauthConfigName: currentOauth.oauthConfigName || oauthConfig.name
  }

  await resourcesDb.update(connection._id + '', {
    oauth: encryptParams(newOauth),
    status: 'ok',
    refresh_lock_at: null
  }, { replaceAllFields: false })

  return newOauth
}

export default { ensureFreshAccessToken }
