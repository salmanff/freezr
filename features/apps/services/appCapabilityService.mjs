// freezr.info — App capability reporting - appCapabilityService.mjs
//
// A granted permission is not always a USABLE permission: use_llm without any LLM key,
// run_job / schedule_job without a runnable location (admin hasn't trusted the job locally
// and the user has no serverless compute credential), use_mail without a covered
// connection, etc. This service computes, for one (user, app) pair:
//
//   permissions   — the app's permission grants (as /ceps/perms/get returns them, trimmed),
//                   each annotated with { usable, blocked_by }
//   capabilities  — grant-independent user/server facts an app can use to guide its UI
//                   ({ llm: { available }, compute: { available }, connections: { mail: n, ... } })
//                   Connection counts are of WORKING connections; one whose token has expired
//                   (needs reconnect) is excluded and surfaces as connection_needs_reconnect on
//                   the relevant permission's blocked_by.
//
// Consumed by /ceps/ping (via createAddAppCapabilities below) so an app learns in ONE call
// both what it has been granted and whether the grants can actually run right now.
//
// SECURITY: everything here is computed for the token's requestor (the user the app acts
// for) about that user's OWN account. The capabilities summary is deliberately coarse
// (booleans and counts — no key names, no connection names) since any valid app token can
// see it. Fail open on errors: ping must never break because annotation failed; the extra
// fields are simply omitted.

import { parseJobId } from '../../jobs/services/jobId.mjs'
import { TRUSTED_JOBS_OAC, USER_DB_OAC } from '../../../common/helpers/config.mjs'
import { isUserAdmin } from '../../jobs/services/userAdminStatus.mjs'
import { localAgentsAllowedForApp } from '../../../common/helpers/localAgentPolicy.mjs'

const PERMS_APP_TABLE = 'info.freezr.account.permissions'
const RESOURCES_APP_TABLE = 'info.freezr.account.resources'

// Connection-scoped permission types → the `services[]` entry they cover.
const CONNECTION_SERVICE_BY_PERM_TYPE = {
  use_mail: 'mail',
  use_contacts: 'contacts',
  use_calendar: 'calendar',
  use_messaging: 'messaging',
  use_file_sys: 'fs'
}

/**
 * Blockers reported in `blocked_by` (null when the permission is usable):
 * - not_granted             — the user has not granted (or has revoked) the permission
 * - no_llm_keys             — use_llm granted but no LLM API key in Account Resources
 * - no_compute_credential   — the job/function must run on the user's cloud but no
 *                             serverless compute credential is set up
 * - job_not_trusted         — the grant says run locally but the admin has not trusted the job
 * - no_job_runtime          — location 'auto' and NEITHER local trust NOR a compute credential exists
 * - no_matching_connection  — use_mail/use_contacts/use_calendar granted but no connected
 *                             account is covered by the permission's connection_names
 * - connection_needs_reconnect — a covered connection exists but its OAuth token has expired
 *                             (status 'token_expired'); the user must re-authorise it. This
 *                             reflects the LAST KNOWN token state (set when a call last failed
 *                             to refresh) — ping does not do a live token refresh.
 */

// Connections matching this permission (right service + covered by connection_names), split by
// whether their last-known token state is usable. `expired` = status 'token_expired' (a refresh
// failed permanently — revoked/absent refresh token, etc.); everything else counts as ok.
const matchingConnections = (perm, connections, service) => {
  const list = perm.connection_names
  // Fail closed (same rule as connectionsContext): no explicit list covers nothing; ['*'] covers all.
  if (!Array.isArray(list) || list.length === 0) return { ok: 0, expired: 0 }
  const allowAll = list.includes('*')
  let ok = 0
  let expired = 0
  for (const c of connections) {
    const services = Array.isArray(c.services) ? c.services : []
    if (!services.includes(service)) continue
    if (!allowAll && !list.includes(c.connectionName)) continue
    if (c.status === 'token_expired') expired++
    else ok++
  }
  return { ok, expired }
}

/**
 * Compute { ok, blocker } for one permission given the user-level facts.
 * `ok` answers: if this permission were granted, could the server actually honor it right now?
 */
const capabilityForPerm = (perm, facts) => {
  switch (perm.type) {
    case 'use_llm':
      return facts.hasLlmKey ? { ok: true } : { ok: false, blocker: 'no_llm_keys' }
    case 'use_serverless':
    case 'use_3pFunction':
      return facts.hasCompute ? { ok: true } : { ok: false, blocker: 'no_compute_credential' }
    case 'run_job':
    case 'schedule_job': {
      const location = perm.location || 'auto'
      const trusted = !!facts.trustedByJob[perm.job_name]
      if (location === 'local') return trusted ? { ok: true } : { ok: false, blocker: 'job_not_trusted' }
      if (location === 'cloud') return facts.hasCompute ? { ok: true } : { ok: false, blocker: 'no_compute_credential' }
      return (trusted || facts.hasCompute) ? { ok: true } : { ok: false, blocker: 'no_job_runtime' }
    }
    case 'socket_connect':
      // Vocabulary-only today: the app-socket pipe is not implemented, and no
      // admission rows of kind:'app' exist yet, so every grant is blocked. When
      // the pipe lands, this becomes a lookup against the socket admissions
      // registry (kind:'app', app_name, domains) — mirroring trustedByJob.
      return { ok: false, blocker: 'socket_not_admitted' }
    case 'use_mail':
    case 'use_contacts':
    case 'use_calendar':
    case 'use_messaging':
    case 'use_file_sys': {
      const service = CONNECTION_SERVICE_BY_PERM_TYPE[perm.type]
      const { ok, expired } = matchingConnections(perm, facts.connections, service)
      if (ok > 0) return { ok: true }
      // A covered connection exists but its token expired → reconnect, not "connect a new one".
      if (expired > 0) return { ok: false, blocker: 'connection_needs_reconnect' }
      return { ok: false, blocker: 'no_matching_connection' }
    }
    default:
      // db access, sharing, CSP relaxations, … — capability is intrinsic to the server.
      return { ok: true }
  }
}

// The annotated permission a ping caller sees — the grant's app-relevant fields only
// (never internal db fields beyond what /ceps/perms/get already exposes).
const trimPerm = (perm, { ok, blocker }) => {
  const out = {
    name: perm.name,
    type: perm.type,
    granted: !!perm.granted,
    usable: !!perm.granted && ok,
    blocked_by: !perm.granted ? 'not_granted' : (ok ? null : blocker)
  }
  for (const key of ['table_id', 'table_ids', 'job_name', 'location', 'connection_names', 'scopes', 'description']) {
    if (perm[key] !== undefined) out[key] = perm[key]
  }
  return out
}

/**
 * Build the annotated permission list + capability summary for (userId, appName).
 * Handle-based per the freezr principle where possible; opens only the dbs it needs.
 *
 * @returns {Promise<{ permissions: Array<object>, capabilities: object }>}
 */
export async function buildAppCapabilities ({ dsManager, freezrPrefs, userId, appName }) {
  const permsDb = await dsManager.getorInitDb({ app_table: PERMS_APP_TABLE, owner: userId }, { freezrPrefs })
  const resourcesDb = await dsManager.getorInitDb({ app_table: RESOURCES_APP_TABLE, owner: userId }, { freezrPrefs })
  if (!permsDb || !resourcesDb) throw new Error('could not open permissions/resources dbs for capability report')

  const perms = (await permsDb.query({ requestor_app: appName, status: { $ne: 'removed' } }, {})) || []
  const resources = (await resourcesDb.query({}, {})) || []

  // Admin-gated local resources (the local-CLI LLM connector, and local file stores)
  // count as capabilities only under the SAME gates their use-time middleware enforces —
  // otherwise the report would advertise something the route then refuses. Resolve the
  // admin flag once, only when a gated resource actually exists.
  // Local-CLI resources count only for apps allowed to use them (creator by default) — the
  // same gate llmContext applies at ask time. Without this, ping would advertise an LLM that
  // the ask route then refuses, which is worse than reporting none.
  const hasLocalCliResource = resources.some(r => r.type === 'llm' && r.localCli) &&
    localAgentsAllowedForApp(appName)
  const hasLocalFsStore = resources.some(r => r.type === 'connection' &&
    Array.isArray(r.services) && r.services.includes('fs') && r.fsParams?.type === 'local')
  let userIsAdmin = false
  if ((freezrPrefs?.local_llm_cli_enabled && hasLocalCliResource) ||
      (freezrPrefs?.local_fs_access_enabled && hasLocalFsStore)) {
    try {
      userIsAdmin = await isUserAdmin(dsManager.getDB(USER_DB_OAC), userId)
    } catch (e) { /* stays false */ }
  }
  const hasUsableLocalCli = !!(freezrPrefs?.local_llm_cli_enabled && hasLocalCliResource && userIsAdmin)
  // Mirrors localFsGate minus the per-request localhost check (ping has no say on where
  // a future request will come from) — a local store an off-localhost request can't use
  // still shows here when the standing conditions hold.
  const localFsAllowed = !!(freezrPrefs?.local_fs_access_enabled && userIsAdmin &&
    dsManager?.systemEnvironment?.fsParams?.type === 'local')

  // Presence checks only — encrypted fields stay encrypted (truthiness is enough here,
  // matching userHasComputeCredential's r.secret check). Local fs stores the gate would
  // refuse are excluded so use_file_sys reports no_matching_connection instead of usable.
  const facts = {
    hasLlmKey: resources.some(r => r.type === 'llm' && r.key) || hasUsableLocalCli,
    hasCompute: resources.some(r => r.type === 'compute' && r.secret),
    connections: resources.filter(r => r.type === 'connection' &&
      (localFsAllowed || !(Array.isArray(r.services) && r.services.includes('fs') && r.fsParams?.type === 'local'))),
    trustedByJob: {}
  }

  // Only touch the trusted-jobs registry when a job permission actually exists — and then with
  // ONE query-all ({} is cache-served: the registry is small, admin-curated and cacheAll'd in
  // defaultCachePrefs), pruned in JS, instead of a per-job { app_name, job_name } lookup which
  // the cache layer cannot serve.
  const jobNames = [...new Set(perms.filter(p => (p.type === 'run_job' || p.type === 'schedule_job') && p.job_name).map(p => p.job_name))]
  if (jobNames.length > 0) {
    const trustedJobsDb = await dsManager.getorInitDb(TRUSTED_JOBS_OAC, { freezrPrefs })
    const allTrusted = (await trustedJobsDb.query({}, {})) || []
    for (const jn of jobNames) {
      const parsed = parseJobId(jn, appName)
      facts.trustedByJob[jn] = !!(parsed && allTrusted.some(rec => rec.app_name === parsed.ownerApp && rec.job_name === parsed.jobName && rec.trusted))
    }
  }

  // Counts reflect WORKING connections — a connection whose token has expired (needs reconnect)
  // is not something the app can use right now, so it is excluded from the summary counts.
  const connectionCounts = { mail: 0, contacts: 0, calendar: 0, messaging: 0, fs: 0 }
  for (const c of facts.connections) {
    if (c.status === 'token_expired') continue
    for (const s of (Array.isArray(c.services) ? c.services : [])) {
      if (connectionCounts[s] !== undefined) connectionCounts[s]++
    }
  }

  // Messaging live updates (socket-fed activity index): tell apps whether the
  // push pipeline is WORKING RIGHT NOW — and if not, WHICH link in the setup
  // chain is missing, so the app can guide the user instead of failing mutely.
  // Mirrors the jobs pattern of reporting backend state, not just grants.
  // The chain, in order: prefs master switch → provider admission → manager
  // running → this user's per-connection opt-in. `sockets_running` reads the
  // in-process manager, so it is accurate per server instance.
  let socketsRunning = false
  let admittedProviders = []
  try {
    const { getSocketManagerIfRunning } = await import('../../connections/messaging/services/socketManager.mjs')
    const mgr = getSocketManagerIfRunning()
    socketsRunning = !!(mgr && mgr.isRunning())
    const { listAdmissions } = await import('../../connections/messaging/services/socketAdmissions.mjs')
    admittedProviders = ((await listAdmissions({ dsManager, freezrPrefs })) || [])
      .filter(a => a.kind === 'provider' && a.enabled === true)
      .map(a => a.provider)
  } catch (e) { /* non-fatal — report the pipeline as unavailable */ }
  const prefsEnabled = freezrPrefs.sockets_enabled === true
  const liveConnectionNames = facts.connections
    .filter(c => c.status !== 'token_expired' && c.live === true &&
      Array.isArray(c.services) && c.services.includes('messaging'))
    .map(c => c.connectionName)

  // First missing link, or null when the whole chain is in place. The first
  // three are ADMIN fixes ("ask your server admin"); the last is the USER's
  // own switch (/account/resources → Live updates).
  const messagingLiveBlockedBy =
    !prefsEnabled ? 'server_sockets_not_enabled'
      : admittedProviders.length === 0 ? 'no_provider_admitted'
        : !socketsRunning ? 'sockets_not_running'
          : liveConnectionNames.length === 0 ? 'no_live_connections'
            : null

  return {
    permissions: perms.map(p => trimPerm(p, capabilityForPerm(p, facts))),
    capabilities: {
      llm: { available: facts.hasLlmKey },
      compute: { available: facts.hasCompute },
      connections: connectionCounts,
      // active === the server-side promise: the full chain is in place for at
      // least one of this user's connections. Apps should still read `complete`
      // on each getChanges response — active says the pipe exists, not that it
      // has no gaps.
      messaging_live: {
        active: messagingLiveBlockedBy === null,
        blocked_by: messagingLiveBlockedBy,
        sockets_running: socketsRunning,
        prefs_enabled: prefsEnabled,
        admitted_providers: admittedProviders,
        live_connections: liveConnectionNames
      }
    }
  }
}

/**
 * Middleware for /ceps/ping: when the caller has been identified as an app acting for a
 * local user, attach the capability report to res.locals.freezr for the ping handler.
 * NON-FATAL by design — on any error ping proceeds without the extra fields.
 */
export const createAddAppCapabilities = (dsManager, freezrPrefs) => {
  return async (req, res, next) => {
    try {
      const tokenInfo = res.locals.freezr?.tokenInfo
      const appName = tokenInfo?.app_name
      const userId = tokenInfo?.requestor_id
      // Cross-host requestors get no report (fail closed, same as /ceps/perms/get).
      if (!appName || !userId || userId.includes('@')) return next()
      const { permissions, capabilities } = await buildAppCapabilities({ dsManager, freezrPrefs, userId, appName })
      res.locals.freezr.appPermissions = permissions
      res.locals.freezr.appCapabilities = capabilities
    } catch (error) {
      console.warn('⚠️ addAppCapabilities (non-fatal — ping proceeds without capability info):', error && error.message)
    }
    next()
  }
}

export default { buildAppCapabilities, createAddAppCapabilities }
