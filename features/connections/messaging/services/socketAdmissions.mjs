// freezr.info - Socket admissions registry
//
// The admin's EXPLICIT capability grants for server-held outbound sockets — the
// second of two deliberately distinct admin acts (the first being credential
// provisioning, e.g. the Slack app-level token on the oauth config row). No
// enabled admission row ⇒ no socket, no matter what credentials exist.
//
// Governance mirror of the trusted-jobs registry: fradmin-owned rows an admin
// creates on the /admin/sockets page. Phase 1 uses kind:'provider' rows only;
// kind:'app' rows (the socket_connect dumb-pipe for third-party apps) are part
// of the registered vocabulary but not yet executed.
//
// Row shape: { kind: 'provider', provider, enabled, maxSockets, notes,
//              _date_created, _date_modified }

import { SOCKET_ADMISSIONS_OAC } from '../../../../common/helpers/config.mjs'

const VALID_KINDS = ['provider']
const VALID_PROVIDERS = ['slack'] // grows with each ingestor implementation

const getDb = async (dsManager, freezrPrefs) =>
  dsManager.getorInitDb(SOCKET_ADMISSIONS_OAC, { freezrPrefs })

/**
 * All admission rows (for the admin page).
 */
export const listAdmissions = async ({ dsManager, freezrPrefs }) => {
  const db = await getDb(dsManager, freezrPrefs)
  return (await db.query({}, {})) || []
}

/**
 * The enabled admission row for a provider, or null. The socket manager's gate.
 */
export const getEnabledProviderAdmission = async ({ dsManager, freezrPrefs, provider }) => {
  const db = await getDb(dsManager, freezrPrefs)
  const rows = await db.query({ kind: 'provider', provider }, {})
  const row = (rows || [])[0] || null
  return (row && row.enabled === true) ? row : null
}

/**
 * Create or update a provider admission (admin page action). Upserts on
 * (kind, provider) so there is at most one row per provider.
 */
export const setProviderAdmission = async ({ dsManager, freezrPrefs, provider, enabled, maxSockets, notes }) => {
  if (!VALID_PROVIDERS.includes(provider)) {
    const err = new Error('Unknown socket provider: ' + provider + ' (known: ' + VALID_PROVIDERS.join(', ') + ')')
    err.code = 'unknown_provider'
    throw err
  }
  const db = await getDb(dsManager, freezrPrefs)
  const existing = ((await db.query({ kind: 'provider', provider }, {})) || [])[0]
  const params = {
    kind: 'provider',
    provider,
    enabled: enabled === true,
    maxSockets: Number.isFinite(maxSockets) && maxSockets > 0 ? Math.floor(maxSockets) : 3,
    notes: typeof notes === 'string' ? notes.slice(0, 500) : (existing?.notes || '')
  }
  if (existing) {
    await db.update(existing._id + '', params, { replaceAllFields: false })
    return { ...existing, ...params }
  }
  const created = await db.create(null, params, null)
  return { ...params, _id: created?._id }
}

export default { listAdmissions, getEnabledProviderAdmission, setProviderAdmission, VALID_KINDS, VALID_PROVIDERS }
