// freezr.info - OAuth Connection Writer Service
//
// Shared logic for persisting a connection record to a user's
// info.freezr.account.resources collection after a successful OAuth exchange.
//
// Used by:
//   - handleConnectionPurpose in oauthApiController (direct connection flow)
//   - store_transferred_credentials endpoint (federated transfer flow)
//
// Both call sites have done the OAuth dance and have tokens in hand; this
// service handles the common steps:
//   1. Reconcile requested vs actually-granted services/access (MIN)
//   2. Best-effort fetch the connected account's profile email
//   3. Encrypt the oauth sub-object
//   4. Upsert the connection record (create new, or replace on reconnect)

import { encryptParams } from '../../register/services/registerServices.mjs'
import { OAUTH_PROVIDERS } from './providers/index.mjs'

const RESOURCES_APP_TABLE = 'info.freezr.account.resources'

/**
 * Write (or upsert on reconnect) a connection record on behalf of the given user.
 *
 * @param {Object} args
 * @param {Object} args.dsManager
 * @param {Object} args.freezrPrefs
 * @param {string} args.userId
 * @param {string} args.providerType        e.g. 'google'
 * @param {string} args.oauthConfigName     Name of the oauth_serve_setup row used (for traceability)
 * @param {string} args.accessToken
 * @param {string} args.refreshToken
 * @param {number|null} args.expiry         ms timestamp
 * @param {string|null} args.tokenScope     space-separated scope string returned by provider
 * @param {string} args.connectionName
 * @param {string[]} args.requestedServices Services the user asked for (e.g. ['mail','calendar'])
 * @param {Object} args.requestedAccess     Per-service requested access (e.g. { mail: 'readwrite' })
 * @returns {Promise<{ ok:boolean,
 *                     resourceId?:string,
 *                     accountEmail?:string,
 *                     actualServices?:string[],
 *                     actualAccess?:Object,
 *                     downgraded?:Array,
 *                     code?:string,
 *                     message?:string }>}
 */
export const writeConnectionRecord = async (args) => {
  const {
    dsManager, freezrPrefs, userId,
    providerType, oauthConfigName,
    accessToken, refreshToken, expiry, tokenScope,
    connectionName, requestedServices = [], requestedAccess = {}
  } = args

  if (!userId) return { ok: false, code: 'not_logged_in', message: 'Must be logged in to write a connection record' }
  if (!accessToken || !refreshToken) {
    return { ok: false, code: 'incomplete_tokens', message: 'Both accessToken and refreshToken are required to persist a connection' }
  }
  if (!connectionName) return { ok: false, code: 'no_name', message: 'connectionName is required' }

  const provider = OAUTH_PROVIDERS[providerType]
  if (!provider) {
    return { ok: false, code: 'unknown_provider', message: 'Unknown OAuth provider type: ' + providerType }
  }

  // Reconcile requested vs actually granted (MIN per service). Services not granted at all
  // get dropped. If nothing was granted, return code=no_services_granted so caller can
  // surface a useful retry message.
  const grantedAccess = (typeof provider.accessFromGrantedScopes === 'function')
    ? provider.accessFromGrantedScopes(tokenScope || '')
    : {}

  const actualServices = []
  const actualAccess = {}
  const downgraded = []
  for (const service of requestedServices) {
    const requested = requestedAccess[service] || 'read'
    const granted = grantedAccess[service]
    if (!granted) continue
    const effective = (requested === 'readwrite' && granted === 'readwrite') ? 'readwrite' : 'read'
    actualServices.push(service)
    actualAccess[service] = effective
    if (effective !== requested) downgraded.push({ service, requested, effective })
  }
  if (actualServices.length === 0) {
    return { ok: false, code: 'no_services_granted', message: 'OAuth completed but none of the requested services were granted. Reconnect and tick the relevant boxes on the consent screen.' }
  }

  // Best-effort: account email for display
  let accountEmail = null
  if (typeof provider.fetchAccountProfile === 'function') {
    try {
      const profile = await provider.fetchAccountProfile({ accessToken })
      accountEmail = profile?.email || null
    } catch (e) {
      console.warn('writeConnectionRecord: fetchAccountProfile failed (non-fatal):', e?.message || e)
    }
  }

  // Open user's resources DB
  const resourcesDb = await dsManager.getorInitDb(
    { app_table: RESOURCES_APP_TABLE, owner: userId },
    { freezrPrefs }
  )
  if (!resourcesDb) {
    return { ok: false, code: 'db_unavailable', message: 'Could not open user resources DB' }
  }

  const encryptedOauth = encryptParams({
    accessToken, refreshToken, expiry,
    oauthConfigName
  })

  const connectionRecord = {
    type: 'connection',
    provider: providerType,
    connectionName,
    account_email: accountEmail,
    services: actualServices,
    access: actualAccess,
    oauth: encryptedOauth,
    status: 'ok',
    refresh_lock_at: null,
    sync_bodies: false,
    sync_attachments: false
  }

  let resourceId
  try {
    const existing = await resourcesDb.query({ type: 'connection', connectionName }, null)
    if (existing && existing.length > 0) {
      resourceId = existing[0]._id + ''
      await resourcesDb.update(resourceId, connectionRecord, { replaceAllFields: true })
    } else {
      const created = await resourcesDb.create(null, connectionRecord, null)
      resourceId = (created && (created._id || created.id)) ? (created._id || created.id) + '' : null
      if (!resourceId && typeof created === 'string') resourceId = created
    }
  } catch (e) {
    console.error('writeConnectionRecord: persistence failed:', e)
    return { ok: false, code: 'write_failed', message: 'Failed to write connection record: ' + (e?.message || e) }
  }

  if (downgraded.length > 0) {
    console.warn('writeConnectionRecord: scope downgrades for ' + connectionName, downgraded)
  }

  return {
    ok: true,
    resourceId,
    accountEmail,
    actualServices,
    actualAccess,
    downgraded
  }
}

export default { writeConnectionRecord }
