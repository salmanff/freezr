// freezr.info - MongoClientRegistry
//
// One MongoClient per unique connection URI, reused across all DB operations
// for that URI. Designed to replace the per-operation `new MongoClient(uri)
// / client.close()` churn in dbApi_mongodb.mjs.
//
// Properties:
// - Cache key = normalized URI (sorted query params). Different creds / host
//   / params -> different client. Same URI -> same client, always.
// - Promise-caching: concurrent first-call for the same URI yields a single
//   MongoClient (no race where two get created).
// - Failed initial connect is NOT cached; next acquire() retries from scratch.
// - Idle sweep closes clients whose lastUsedAt is older than `idleEvictMs`
//   AND whose inFlight count is 0. Never yanks a client mid-op.
// - LRU cap on BYO clients (configurable), so hundreds of registered BYO
//   users don't cause unbounded socket growth on any one process.
// - Self-managed lifecycle: first acquire() starts the sweep timer and binds
//   SIGTERM/SIGINT. Module has zero side effects on import.
// - Platform-aware defaults (heroku / azure-app-service / generic).
// - URIs (which contain credentials) are never returned unredacted from
//   getStats(); `redactUri` is the only exported way to log them.
//
// Usage from the mongo adapter:
//   const { client, release } = await acquire(uri, { kind: 'system' })
//   try {
//     await client.db(name).collection(coll).findOne(...)
//   } finally {
//     release()
//   }
//
// To get stats from console, go to an admin page and use:  await freezr.apiRequest('GET', '/adminapi/get_mongo_connection_stats')
// 
// NOTE: callers must call release() for every successful acquire(). If acquire()
// throws, no release is needed (inFlight was decremented internally).

import { MongoClient } from 'mongodb'

// -------------------------------------------------------------------------
// Configuration
// -------------------------------------------------------------------------

const DETECTED_PLATFORM = detectPlatform()

const DEFAULT_CONFIG = {
  system: {
    maxPoolSize: 10,
    minPoolSize: 0,
    idleEvictMs: 30 * 60 * 1000,        // 30 min
    serverSelectionTimeoutMs: 5000
  },
  byo: {
    maxPoolSize: 3,
    minPoolSize: 0,
    idleEvictMs: 10 * 60 * 1000,        // 10 min
    serverSelectionTimeoutMs: 5000
  },
  sweepIntervalMs: 5 * 60 * 1000,       // check every 5 min
  maxActiveByoClients: 100,             // 0 = unlimited
  appNamePrefix: 'freezr',
  logStatsEveryMs: 0                    // 0 = disabled
}

// Platform overrides applied on top of DEFAULT_CONFIG at module load.
// Kept narrow on purpose — we only tweak knobs where the platform actually
// demands it. Admin can override further via configure().
const PLATFORM_OVERRIDES = {
  'azure-app-service': {
    // SNAT ports are precious on Azure App Service. Shorter idle eviction
    // means BYO clients release sockets sooner; lower LRU cap limits total
    // live monitoring sockets across many BYO URIs.
    system: { idleEvictMs: 15 * 60 * 1000 },
    byo: { idleEvictMs: 5 * 60 * 1000 },
    maxActiveByoClients: 50
  },
  heroku: {},
  generic: {}
}

let _config = mergeConfig(DEFAULT_CONFIG, PLATFORM_OVERRIDES[DETECTED_PLATFORM] || {})

// -------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------

// Entry = {
//   uri:             string (normalized)
//   kind:            'system' | 'byo'
//   clientPromise:   Promise<MongoClient>   // resolved once; failed -> removed
//   createdAt:       number (ms)
//   lastUsedAt:      number (ms)
//   inFlight:        number                  // ops currently using this client
//   poolConfig:      object                  // resolved opts used at creation
// }
const _entries = new Map()

let _sweepTimer = null
let _statsTimer = null
let _signalsBound = false
let _closingAll = false

const _counters = {
  acquireCalls: 0,
  clientsCreated: 0,
  clientsClosed: 0,
  evictedIdle: 0,
  evictedLru: 0,
  connectFailures: 0
}

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

/**
 * Override defaults. Merges deep one level for nested objects (system, byo).
 * Safe to call multiple times; applies to future acquires only.
 */
export function configure (opts = {}) {
  _config = mergeConfig(_config, opts)
}

/**
 * Acquire a shared MongoClient for the given URI. Returns { client, release }.
 * Call release() exactly once when your op is done (whether it succeeded or
 * failed). If acquire() itself throws, no release is needed.
 */
export async function acquire (rawUri, opts = {}) {
  _counters.acquireCalls++
  if (_closingAll) throw new Error('MongoClientRegistry is shutting down')
  if (!rawUri || typeof rawUri !== 'string') throw new Error('acquire: uri is required')

  ensureLifecycleTimers()
  const uri = normalizeUri(rawUri)

  let entry = _entries.get(uri)
  if (!entry) {
    entry = createEntry(uri, opts)
    _entries.set(uri, entry)
    enforceByoLruCap(entry)
  }

  entry.inFlight++
  entry.lastUsedAt = Date.now()

  let client
  try {
    client = await entry.clientPromise
  } catch (err) {
    // Connect failed — don't cache a poisoned promise.
    entry.inFlight = Math.max(0, entry.inFlight - 1)
    if (_entries.get(uri) === entry) _entries.delete(uri)
    _counters.connectFailures++
    throw err
  }

  let released = false
  return {
    client,
    release () {
      if (released) return    // idempotent; protects against double-release bugs
      released = true
      entry.inFlight = Math.max(0, entry.inFlight - 1)
      entry.lastUsedAt = Date.now()
    }
  }
}

/**
 * Snapshot of current registry state. URIs are redacted. Safe to log.
 */
export function getStats () {
  const now = Date.now()
  const entries = Array.from(_entries.values()).map(e => ({
    uri: redactUri(e.uri),
    kind: e.kind,
    createdAt: e.createdAt,
    lastUsedAt: e.lastUsedAt,
    idleMs: now - e.lastUsedAt,
    inFlight: e.inFlight,
    poolConfig: { ...e.poolConfig, appName: e.poolConfig.appName }
  }))
  return {
    platform: DETECTED_PLATFORM,
    entries,
    totalEntries: entries.length,
    totalInFlight: entries.reduce((a, e) => a + e.inFlight, 0),
    counters: { ..._counters },
    config: publicConfigView()
  }
}

/**
 * Close and remove clients whose idle time exceeds their kind's threshold.
 * Skips any client with inFlight > 0. Returns count evicted.
 */
export async function sweepIdle (now = Date.now()) {
  const toEvict = []
  for (const [uri, entry] of _entries) {
    const kindCfg = _config[entry.kind] || _config.byo
    const idleFor = now - entry.lastUsedAt
    if (entry.inFlight === 0 && idleFor > kindCfg.idleEvictMs) {
      toEvict.push([uri, entry])
    }
  }
  for (const [uri, entry] of toEvict) {
    if (_entries.get(uri) === entry) _entries.delete(uri)
    _counters.evictedIdle++
    await safeClose(entry)
  }
  return toEvict.length
}

/**
 * Close every client. Used on process shutdown (SIGTERM/SIGINT) and in tests.
 * After this returns, the registry is re-usable for new acquires.
 */
export async function closeAll () {
  _closingAll = true
  if (_sweepTimer) { clearInterval(_sweepTimer); _sweepTimer = null }
  if (_statsTimer) { clearInterval(_statsTimer); _statsTimer = null }
  const entries = Array.from(_entries.values())
  _entries.clear()
  await Promise.allSettled(entries.map(safeClose))
  _closingAll = false
}

/** Redact password in a mongodb:// or mongodb+srv:// URI for logging. */
export function redactUri (uri) {
  if (!uri) return uri
  return String(uri).replace(/(\/\/[^:@/]+:)[^@/]+(@)/, '$1***$2')
}

/** Exposed for tests only. */
export const __internal = {
  normalizeUri,
  detectPlatform,
  mergeConfig,
  getEntriesMap: () => _entries,
  resetForTests: async () => {
    await closeAll()
    _signalsBound = false    // only meaningful for test harnesses
    for (const k of Object.keys(_counters)) _counters[k] = 0
  }
}

// -------------------------------------------------------------------------
// Internal
// -------------------------------------------------------------------------

function createEntry (uri, opts) {
  const kind = opts.kind === 'system' ? 'system' : 'byo'
  const kindCfg = _config[kind]
  const appName = opts.appName || buildAppName()
  const poolConfig = {
    maxPoolSize: opts.maxPoolSize || kindCfg.maxPoolSize,
    minPoolSize: opts.minPoolSize != null ? opts.minPoolSize : kindCfg.minPoolSize,
    serverSelectionTimeoutMS: kindCfg.serverSelectionTimeoutMs,
    appName
  }

  const clientPromise = (async () => {
    const client = new MongoClient(uri, poolConfig)
    await client.connect()
    _counters.clientsCreated++
    return client
  })()

  // Defensive: attach a no-op catch so an unhandled rejection never surfaces
  // if nothing else ever awaits this promise (shouldn't happen, but cheap).
  clientPromise.catch(() => {})

  return {
    uri,
    kind,
    clientPromise,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    inFlight: 0,
    poolConfig
  }
}

async function safeClose (entry) {
  try {
    const client = await entry.clientPromise
    await client.close()
    _counters.clientsClosed++
  } catch (_err) {
    // Either connect never succeeded, or close failed. Either way, the entry
    // has already been removed from _entries; nothing more to do.
  }
}

function enforceByoLruCap (justCreatedEntry) {
  const cap = _config.maxActiveByoClients
  if (!cap || cap <= 0) return
  const byoEntries = Array.from(_entries.entries())
    .filter(([, e]) => e.kind === 'byo')
  if (byoEntries.length <= cap) return

  // Evict oldest-idle BYO first; never evict in-flight clients.
  byoEntries.sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)
  let excess = byoEntries.length - cap
  for (const [uri, entry] of byoEntries) {
    if (excess <= 0) break
    if (entry === justCreatedEntry) continue   // paranoia
    if (entry.inFlight > 0) continue
    if (_entries.get(uri) === entry) _entries.delete(uri)
    _counters.evictedLru++
    safeClose(entry)                           // fire-and-forget OK; already removed
    excess--
  }
}

function ensureLifecycleTimers () {
  if (_closingAll) return
  if (!_sweepTimer) {
    _sweepTimer = setInterval(() => {
      sweepIdle().catch(() => { /* swallow; logged via counters */ })
    }, _config.sweepIntervalMs)
    if (_sweepTimer.unref) _sweepTimer.unref()
  }
  if (!_statsTimer && _config.logStatsEveryMs > 0) {
    _statsTimer = setInterval(() => {
      try {
        const s = getStats()
        console.log('[mongoRegistry]', {
          platform: s.platform,
          entries: s.totalEntries,
          inFlight: s.totalInFlight,
          counters: s.counters
        })
      } catch (_) { /* noop */ }
    }, _config.logStatsEveryMs)
    if (_statsTimer.unref) _statsTimer.unref()
  }
  if (!_signalsBound) {
    _signalsBound = true
    const onSignal = () => { closeAll().catch(() => {}) }
    // `once` to avoid stacking handlers if timers are re-armed after a
    // closeAll() (e.g. during tests). Real shutdowns only fire once anyway.
    process.once('SIGTERM', onSignal)
    process.once('SIGINT', onSignal)
  }
}

function detectPlatform () {
  if (process.env.DYNO) return 'heroku'
  if (process.env.WEBSITE_SITE_NAME || process.env.WEBSITE_INSTANCE_ID) return 'azure-app-service'
  return 'generic'
}

function buildAppName () {
  const host =
    process.env.DYNO ||
    process.env.WEBSITE_INSTANCE_ID ||
    process.env.HOSTNAME ||
    'local'
  // Atlas truncates appName at ~128 chars; keep it short.
  const safeHost = String(host).slice(0, 32).replace(/[^A-Za-z0-9_\-.]/g, '_')
  return `${_config.appNamePrefix}-${safeHost}-${process.pid}`
}

/**
 * Cache key normalization: same URI with query params in different order
 * must map to the same entry. Does NOT modify credentials, host, or path.
 */
function normalizeUri (uri) {
  const qIdx = uri.indexOf('?')
  if (qIdx < 0) return uri
  const base = uri.slice(0, qIdx)
  const query = uri.slice(qIdx + 1)
  const params = query.split('&').filter(Boolean)
  params.sort()
  return base + '?' + params.join('&')
}

function mergeConfig (a, b) {
  const out = { ...a }
  for (const k of Object.keys(b || {})) {
    const bv = b[k]
    if (bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[k] = { ...(a[k] || {}), ...bv }
    } else {
      out[k] = bv
    }
  }
  return out
}

function publicConfigView () {
  return JSON.parse(JSON.stringify(_config))
}
