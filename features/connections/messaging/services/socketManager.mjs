// freezr.info - Messaging socket manager
//
// The provider-blind supervisor for server-held outbound sockets (phase 1:
// Slack Socket Mode). Transport lives in per-provider INGESTORS
// (adapters/connections/messaging/slackIngestor.mjs); this file owns
// governance, routing, and lifecycle:
//
//   GOVERNANCE — a socket starts only when ALL THREE hold, each checked live:
//     1. freezrPrefs.sockets_enabled === true            (admin master switch)
//     2. an enabled socket-admission row for the provider (explicit capability)
//     3. a provider credential exists                    (xapp token on the
//        slack oauth config row — provisioning, deliberately act #1 of two)
//
//   ROUTING — fail-closed. Events carry (teamId, authUserIds); they are
//   delivered only to registry rows matching BOTH team_id AND provider_user_id.
//   Anything unmatched is COUNTED (stats.unrouted) and dropped — never guessed.
//   This is what makes multi-user safe before multi-user attribution has been
//   fully verified: mis-attribution can only ever mean a dropped event, not a
//   leaked one.
//
//   LIFECYCLE — phase 1 is MANUAL start/stop from the /admin/sockets page (no
//   boot autostart, no SIGTERM hook yet — deliberate; see plan). stop() closes
//   every socket and opens gaps so /changes answers honestly about the window.
//
// Module-level singleton: the manager must survive across requests, so admin
// handlers use getOrCreateSocketManager(ctx) rather than constructing per
// request (contrast run_scheduler_now, whose scheduler is safely disposable).

import { OAUTH_DB_OAC } from '../../../oauth/middleware/oauthContext.mjs'
import { SOCKET_ADMISSIONS_OAC } from '../../../../common/helpers/config.mjs'
import { createSlackIngestor } from '../../../../adapters/connections/messaging/slackIngestor.mjs'
import { getEnabledProviderAdmission } from './socketAdmissions.mjs'
import { listLive } from './messagingRegistry.mjs'
import { recordActivity, openGap, closeGap } from './activityIndex.mjs'

// Liveness heartbeat: while running, a singleton runtime row (in the socket
// admissions collection, kind:'runtime') is stamped every minute. On boot,
// reconcileCrashGaps reads it — clean_stop:false with a stale last_alive means
// the previous process DIED without stop() ever recording a gap, so the
// downtime is recorded retroactively (resolution: one heartbeat interval).
// Without this, a crashed/killed server would leave getChanges claiming
// complete:true over a window whose events were silently lost.
const HEARTBEAT_MS = 60 * 1000

// Per-provider ingestor factories — the one place a new provider registers.
const INGESTOR_FACTORIES = {
  slack: createSlackIngestor
}

const redactToken = (token) => {
  if (!token || token.length < 12) return '(set)'
  return token.slice(0, 5) + '…' + token.slice(-4)
}

export const createSocketManager = ({ dsManager, freezrPrefs, logManager }) => {
  let running = false
  let startedAt = null
  let heartbeatTimer = null
  const ingestors = [] // { provider, tokenHint, ingestor }
  // routing map: `${provider}:${team_id}:${provider_user_id}` → [{ ownerId, connectionName }]
  let routes = new Map()
  const counters = { routedEvents: 0, unrouted: 0, writeErrors: 0 }
  let lastStartError = null

  const getRuntimeDb = () => dsManager.getorInitDb(SOCKET_ADMISSIONS_OAC, { freezrPrefs })

  const readRuntimeRow = async () => {
    const db = await getRuntimeDb()
    return (((await db.query({ kind: 'runtime' }, {})) || [])[0]) || null
  }

  const writeRuntimeRow = async (fields) => {
    const db = await getRuntimeDb()
    const existing = await readRuntimeRow()
    if (existing) await db.update(existing._id + '', fields, { replaceAllFields: false })
    else await db.create(null, { kind: 'runtime', ...fields }, null)
  }

  const log = (msg) => {
    if (logManager?.info) logManager.info('socketManager: ' + msg)
    else console.log('🔌 socketManager: ' + msg)
  }

  const buildRoutes = async () => {
    const rows = await listLive({ dsManager, freezrPrefs })
    const map = new Map()
    for (const r of rows) {
      const key = r.provider + ':' + r.team_id + ':' + r.provider_user_id
      if (!map.has(key)) map.set(key, [])
      map.get(key).push({ ownerId: r.owner_id, connectionName: r.connection_name })
    }
    return map
  }

  const forEachRoutedConnection = async (fn) => {
    const seenKeys = new Set()
    for (const targets of routes.values()) {
      for (const t of targets) {
        const k = t.ownerId + ':' + t.connectionName
        if (seenKeys.has(k)) continue
        seenKeys.add(k)
        try { await fn(t) } catch (e) {
          console.warn('socketManager: per-connection op failed for ' + k + ':', e?.message || e)
        }
      }
    }
  }

  const onActivity = (activity) => {
    // Fail-closed routing: only exact (team, authorized user) matches receive
    // the event. Multiple registered connections for the same identity (rare —
    // same person, two connection names) all get it.
    let matched = false
    for (const authUserId of (activity.authUserIds || [])) {
      const key = activity.provider + ':' + activity.teamId + ':' + authUserId
      const targets = routes.get(key)
      if (!targets) continue
      matched = true
      for (const t of targets) {
        counters.routedEvents++
        recordActivity({
          dsManager,
          freezrPrefs,
          ownerId: t.ownerId,
          connectionName: t.connectionName,
          activity
        }).catch(e => {
          counters.writeErrors++
          console.warn('socketManager: activity write failed for ' + t.ownerId + ':', e?.message || e)
        })
      }
    }
    if (!matched) counters.unrouted++
  }

  const onStatus = (status) => {
    // Gap bookkeeping: a disconnect opens a gap on every routed connection
    // (events may be lost — Slack has no replay); a (re)connect closes it.
    if (status.event === 'disconnected' || status.event === 'gave_up') {
      forEachRoutedConnection(t => openGap({ dsManager, freezrPrefs, ownerId: t.ownerId, connectionName: t.connectionName, from: Date.now() }))
    } else if (status.event === 'connected') {
      forEachRoutedConnection(t => closeGap({ dsManager, freezrPrefs, ownerId: t.ownerId, connectionName: t.connectionName }))
    }
  }

  const start = async () => {
    lastStartError = null
    if (running) return { started: false, reason: 'already_running' }

    // Gate 1 — admin master switch (live pref).
    if (freezrPrefs.sockets_enabled !== true) {
      lastStartError = 'sockets_disabled_in_prefs'
      return { started: false, reason: lastStartError }
    }

    // Gate 2 — explicit provider admission.
    const admission = await getEnabledProviderAdmission({ dsManager, freezrPrefs, provider: 'slack' })
    if (!admission) {
      lastStartError = 'no_enabled_admission_for_slack'
      return { started: false, reason: lastStartError }
    }

    // Gate 3 — provider credential (xapp token on enabled slack oauth rows).
    const oauthorDb = await dsManager.getorInitDb(OAUTH_DB_OAC, { freezrPrefs })
    const oauthRows = (await oauthorDb.query({ type: 'slack', enabled: true }, {})) || []
    const appTokens = [...new Set(oauthRows.map(r => r.appToken).filter(t => t && t.startsWith('xapp-')))]
    if (appTokens.length === 0) {
      lastStartError = 'no_app_token_on_slack_oauth_config'
      return { started: false, reason: lastStartError }
    }

    // Routing table from the live registry. Empty is allowed (socket runs,
    // everything lands in `unrouted`) — useful while testing attribution.
    routes = await buildRoutes()

    const cap = admission.maxSockets || 3
    for (const token of appTokens.slice(0, cap)) {
      const ingestor = INGESTOR_FACTORIES.slack({ appToken: token, onActivity, onStatus })
      ingestors.push({ provider: 'slack', tokenHint: redactToken(token), ingestor })
      ingestor.start()
    }
    if (appTokens.length > cap) {
      log('admission cap ' + cap + ' reached — ' + (appTokens.length - cap) + ' slack app token(s) not started')
    }

    running = true
    startedAt = Date.now()
    // Arm the liveness heartbeat (crash detection — see header note). Failures
    // are non-fatal: a missed stamp only widens the recorded crash window.
    try { await writeRuntimeRow({ last_alive: Date.now(), clean_stop: false }) } catch (e) { console.warn('socketManager: runtime stamp failed:', e?.message || e) }
    heartbeatTimer = setInterval(() => {
      writeRuntimeRow({ last_alive: Date.now() }).catch(() => {})
    }, HEARTBEAT_MS)
    log('started — ' + ingestors.length + ' socket(s), ' + routes.size + ' routing key(s)')
    return { started: true, sockets: ingestors.length, routes: routes.size }
  }

  const stop = async () => {
    if (!running && ingestors.length === 0) return { stopped: false, reason: 'not_running' }
    for (const entry of ingestors) {
      try { entry.ingestor.stop() } catch (e) { console.warn('socketManager: ingestor stop failed:', e?.message || e) }
    }
    ingestors.length = 0
    running = false
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
    // Stopping means events WILL be missed from now on — open gaps so /changes
    // stays honest, then drop the routing table. clean_stop marks that this
    // downtime IS recorded, so the next boot doesn't double-record it.
    await forEachRoutedConnection(t => openGap({ dsManager, freezrPrefs, ownerId: t.ownerId, connectionName: t.connectionName, from: Date.now() }))
    try { await writeRuntimeRow({ clean_stop: true }) } catch (e) { console.warn('socketManager: runtime stamp failed:', e?.message || e) }
    routes = new Map()
    log('stopped')
    return { stopped: true }
  }

  /**
   * Boot-time crash reconciliation — call BEFORE start(), and even when sockets
   * won't be started this boot. If the previous process died while running
   * (runtime row says clean_stop:false), record the unknown downtime as a
   * closed gap {from: last_alive, to: now} on every currently-live connection,
   * so getChanges answers complete:false for windows spanning the crash.
   */
  const reconcileCrashGaps = async () => {
    const row = await readRuntimeRow()
    if (!row || row.clean_stop !== false || !row.last_alive) return { reconciled: false }
    const crashRoutes = await buildRoutes()
    const seen = new Set()
    let count = 0
    for (const targets of crashRoutes.values()) {
      for (const t of targets) {
        const k = t.ownerId + ':' + t.connectionName
        if (seen.has(k)) continue
        seen.add(k)
        try {
          await openGap({ dsManager, freezrPrefs, ownerId: t.ownerId, connectionName: t.connectionName, from: row.last_alive })
          await closeGap({ dsManager, freezrPrefs, ownerId: t.ownerId, connectionName: t.connectionName })
          count++
        } catch (e) {
          console.warn('socketManager: crash-gap record failed for ' + k + ':', e?.message || e)
        }
      }
    }
    // Mark reconciled so a later boot (or a pref left off) doesn't re-record it.
    await writeRuntimeRow({ clean_stop: true })
    return { reconciled: true, connections: count, downSince: row.last_alive }
  }

  /**
   * Re-read the live registry without restarting sockets — called after a user
   * toggles live updates so the change takes effect immediately.
   */
  const refreshRoutes = async () => {
    if (!running) return { refreshed: false, reason: 'not_running' }
    routes = await buildRoutes()
    return { refreshed: true, routes: routes.size }
  }

  const getStats = () => ({
    running,
    startedAt,
    prefsEnabled: freezrPrefs.sockets_enabled === true,
    lastStartError,
    routes: routes.size,
    counters: { ...counters },
    sockets: ingestors.map(e => ({
      provider: e.provider,
      appToken: e.tokenHint, // redacted — never the real token
      ...e.ingestor.getStats()
    }))
  })

  return { start, stop, refreshRoutes, reconcileCrashGaps, getStats, isRunning: () => running }
}

// ---- module singleton (survives across requests) ----

let INSTANCE = null

export const getOrCreateSocketManager = (ctx) => {
  if (!INSTANCE) INSTANCE = createSocketManager(ctx)
  return INSTANCE
}

export const getSocketManagerIfRunning = () => INSTANCE

export default { createSocketManager, getOrCreateSocketManager, getSocketManagerIfRunning }
