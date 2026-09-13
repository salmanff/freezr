// freezr.info — Local Job Runner (the LocalRunner from the JobRunner family, §9)
//
// Loads a developer's job by CONVENTION — users_jobs/<app>/<name>/index.mjs exporting
// handler(freezr, params) — injects the bundled in-process freezr client, runs the
// handler with a maxRuntime timeout, and captures result/error/duration.
//
// Tier 1 (no deps): index.mjs alone. Tier 2 (deps): the folder also ships a pre-built
// node_modules (freezr never runs npm install). Both are just "import the handler".
//
// LIMITATION (v1): the maxRuntime timeout REJECTS the awaited run, but cannot truly
// kill a runaway in-process handler (no thread interruption in-process). Local jobs are
// full-trust by design; a future hardening runs them in a dropped-privilege child
// process / worker for a real hard-kill (plan §8).

import { createInternalApiClient } from './internalApiClient.mjs'
import { createJobFreezrClient } from './jobFreezrClient.mjs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { stat, readFile } from 'node:fs/promises'
import { bjLog } from '../../common/debug/consoleFlags.mjs'

const DEFAULT_JOBS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../users_jobs')

// Shared so the admin "trust" install writes job code to the SAME place the runner reads it.
export const jobsBaseDir = () => process.env.FREEZR_JOBS_DIR || DEFAULT_JOBS_DIR

// Accept '30s' / '5m' / '500ms' / a number of ms. Default 30s.
export const parseDurationMs = (v, def = 30000) => {
  if (typeof v === 'number' && isFinite(v)) return v
  if (typeof v === 'string') {
    const m = v.trim().match(/^(\d+)\s*(ms|s|m)?$/)
    if (m) {
      const n = Number(m[1])
      return m[2] === 'ms' ? n : m[2] === 'm' ? n * 60000 : n * 1000 // bare number => seconds
    }
  }
  return def
}

const withTimeout = (promise, ms) => {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error('job exceeded maxRuntime (' + ms + 'ms)')
      e.code = 'JOB_TIMEOUT'
      reject(e)
    }, ms)
  })
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(timer)), timeout])
}

export function createLocalJobRunner ({ dsManager, freezrPrefs, freezrStatus, logManager, jobsDir } = {}) {
  const internalApi = createInternalApiClient({ dsManager, freezrPrefs, freezrStatus, logManager })
  const baseDir = jobsDir || process.env.FREEZR_JOBS_DIR || DEFAULT_JOBS_DIR

  const segmentOk = (s) => typeof s === 'string' && /^[a-zA-Z0-9._-]+$/.test(s) && !s.includes('..')

  // Resolve the job's CURRENT entry file. materializeJobToCache writes each build into a
  // content-stamped dir (<name>@<stamp>/) and flips <name>.current to the live stamp: Node's ESM
  // cache is keyed by URL and can't be evicted, so only a never-imported dir guarantees the WHOLE
  // import graph (index.mjs AND its ./sibling.js imports) loads fresh after a re-materialize.
  // No pointer → legacy unversioned <name>/index.mjs (hand-placed dev jobs, pre-stamp caches).
  async function resolveEntry (app, name) {
    try {
      const stamp = (await readFile(join(baseDir, app, name + '.current'), 'utf8')).trim()
      if (/^[a-f0-9]{8,64}$/.test(stamp)) {
        const p = join(baseDir, app, name + '@' + stamp, 'index.mjs')
        await stat(p)
        return { path: p, versioned: true }
      }
    } catch (e) { /* fall through to legacy layout */ }
    return { path: join(baseDir, app, name, 'index.mjs'), versioned: false }
  }

  async function exists (app, name) {
    if (!segmentOk(app) || !segmentOk(name)) return false
    try { await stat((await resolveEntry(app, name)).path); return true } catch (e) { return false }
  }

  async function loadHandler (app, name) {
    const { path: p, versioned } = await resolveEntry(app, name)
    // A stamped dir needs no cache-busting: new content → new dir → every file gets a fresh URL.
    // The legacy layout keeps the old ?v=<mtime> query, but that only refreshes index.mjs ITSELF —
    // relative static imports resolve with the query stripped and stay cached, so a multi-file
    // legacy job still needs a server restart to pick up sibling edits (stamped dirs fix this).
    let v = ''
    if (!versioned) {
      try { const { mtimeMs } = await stat(p); v = '?v=' + Math.round(mtimeMs) } catch (e) { /* import will surface a clear error */ }
    }
    bjLog('🔎 TMPJOBLOG [LOCAL-LOAD] importing ' + app + '/' + name + ' ← ' + p + (v || ''))
    const mod = await import(pathToFileURL(p).href + v)
    const handler = mod.handler || mod.default
    if (typeof handler !== 'function') {
      throw new Error('job ' + app + '/' + name + ' does not export a handler function')
    }
    return handler
  }

  /**
   * Run a local job now.
   * @returns { ok, result, error, errorCode, durationMs }
   */
  async function run ({ app, name, token, userId = null, params = {}, maxRuntime = '30s', flogger = null, deadline = null }) {
    const startedAt = Date.now()
    // Composition time budget: the outermost job sets the deadline (now + its maxRuntime); a nested
    // run inherits that SAME deadline, so its effective maxRuntime = min(declared, deadline − now) —
    // the whole job tree is bounded by the top job's limit. The deadline is threaded onto the client
    // transport so this job's own freezr.jobs.run carries it onward.
    const declaredMs = parseDurationMs(maxRuntime)
    const effectiveDeadline = deadline || (startedAt + declaredMs)
    const maxMs = Math.max(1, Math.min(declaredMs, effectiveDeadline - startedAt))
    let result = null
    let error = null
    try {
      if (!segmentOk(app) || !segmentOk(name)) throw new Error('invalid app/job name')
      const handler = await loadHandler(app, name)
      // In-process transport closes over the run token; the handler never sees it. The
      // ambient flogger is threaded so the job's API calls log like any other client's.
      // userId is exposed via freezrMeta so job code using the browser idiom freezrMeta.userId
      // (and messages.send, which stamps sender_id from it) works; serverAddress stays '' by
      // design (relative paths — the transport owns routing).
      // `job` identifies this run to middleware that treats an in-process job as a trusted
      // origin (see fsContext.mjs localFsGate) and makes its reads attributable in the log.
      const transport = (method, path, body) => internalApi.dispatch(method, path, body, token, { flogger, deadline: effectiveDeadline, job: { appName: app, jobName: name } })
      const freezr = createJobFreezrClient({ transport, freezrMeta: { appName: app, appToken: token, userId } })
      result = await withTimeout(Promise.resolve().then(() => handler(freezr, params)), maxMs)
    } catch (e) {
      error = e
    }
    return {
      ok: !error,
      result,
      error: error ? (error.message || String(error)) : null,
      errorCode: error?.code || null,
      durationMs: Date.now() - startedAt
    }
  }

  return { run, exists, baseDir }
}

export default { createLocalJobRunner, parseDurationMs }
