// freezr.info — Internal (in-process) API client for Jobs- InternalApiClient.mjs 
//
// Lets server-side code (Jobs running locally, the scheduler, run-now) call the freezr API
// WITHOUT a loopback HTTP hop AND WITHOUT duplicating any route's middleware chain.
//
// It stands up a fresh in-process Express app and mounts the REAL route table on it
// (mountAllModernRoutes — the exact same code froutes uses for the live server), then
// dispatches a synthetic req/res straight through `app(req, res, done)`. Express matches the
// route by method+url across ALL the routers (ceps, feps, /feps/llm, /feps/connections/mail,
// …), fills req.params, and runs whatever middleware + controller each route registers. So:
//   - covers the whole API surface a job can call (data, llm, connections, …), not just ceps;
//   - auto-tracks future changes — new middleware or endpoints are picked up with no edits here;
//   - auth/permission enforcement is byte-identical to the HTTP path (no second surface).
//
// Express's expressInit gives the synthetic req/res the proper request/response prototypes
// (req.path/req.query getters, etc.) while preserving the res.locals we pre-set (freezr + the
// threaded flogger). The capturing res below shadows json/send/etc. as OWN properties so the
// controllers' responses are captured instead of written to a socket. No app-level body parser
// runs (we set req.body directly); the data middleware don't stream-read the socket (Phase-0).
//
// permGiven is set by the controllers themselves; the capturing res honors it via responses.mjs.
// ctx.flogger threads the ambient request logger so a job's calls log like any other client's.

// Last-resort no-op logger (used only when no real flogger is threaded in, e.g. the smoke test).
const makeNoopFlogger = () => ({
  info () {}, warn () {}, error () {}, debug () {}, auth () {}, track () {}, setTokenParams () {}
})

const safeStringify = (b) => { try { return JSON.stringify(b) } catch (e) { return String(b) } }
const chunkToString = (c) => (typeof c === 'string') ? c : (c && c.toString ? c.toString('utf8') : String(c))

// Synthetic res that captures status + BOTH the parsed body (json/send) AND the raw response text
// (incl. streamed res.write/res.end — e.g. the SSE that /feps/llm/ask emits), instead of writing to a
// socket. The raw text lets the job-client shim expose a faithful body.getReader() so the browser
// client's streaming reader (llm, binary) works in-process. Notifies _onDone on capture (Express does
// not await async route handlers, so capture — not the final next() — signals completion). Methods
// are own-properties so they shadow the Express response prototype.
const makeRes = (session, flogger) => {
  const res = {
    locals: { freezr: {}, flogger: flogger || makeNoopFlogger(), session },
    statusCode: 200,
    _captured: undefined,
    _rawBuffer: undefined, // accumulates streamed write() chunks
    _onDone: null,
    _capture (body, rawText) {
      if (this._captured === undefined) {
        this._captured = { statusCode: this.statusCode, body, rawText }
        if (this._onDone) this._onDone()
      }
      return this
    },
    status (c) { this.statusCode = c; return this },
    json (b) { return this._capture(b, safeStringify(b)) },
    send (b) { return this._capture(b, (typeof b === 'string' ? b : safeStringify(b))) },
    type () { return this },
    set () { return this },
    setHeader () { return this },
    getHeader () { return undefined },
    writeHead () { return this },
    flushHeaders () { return this },
    flush () { return this },
    // Streaming (SSE): accumulate chunks; the response completes on end().
    write (chunk) { if (chunk != null) this._rawBuffer = (this._rawBuffer || '') + chunkToString(chunk); return true },
    redirect (url) { return this._capture({ redirect: url }, safeStringify({ redirect: url })) },
    end (chunk) {
      if (chunk != null) this._rawBuffer = (this._rawBuffer || '') + chunkToString(chunk)
      if (this._captured === undefined) this._capture(undefined, this._rawBuffer)
      return this
    }
  }
  return res
}

// One in-process app per process (deps are process singletons), built lazily on first use and
// shared by every client instance — so the route table is stood up once, not per caller.
let _sharedAppPromise = null
const getInProcessApp = (deps) => {
  if (!_sharedAppPromise) {
    _sharedAppPromise = (async () => {
      const express = (await import('express')).default
      const { mountAllModernRoutes } = await import('../../froutes/index.mjs')
      const app = express()
      await mountAllModernRoutes(app, deps)
      return app
    })()
  }
  return _sharedAppPromise
}

export function createInternalApiClient ({ dsManager, freezrPrefs, freezrStatus, logManager }) {
  const getApp = () => getInProcessApp({ dsManager, freezrPrefs, freezrStatus, logManager })

  // Run a synthetic request through the in-process app; resolve with { statusCode, body, rawText }.
  // `deadline` (absolute ms) propagates a composition time budget: a job calling another job carries
  // the OUTERMOST job's deadline so the whole tree stays within the top job's maxRuntime.
  const runThroughApp = (app, { method, fullPath, body, token, flogger, deadline }) => {
    return new Promise((resolve, reject) => {
      let settled = false
      const session = {}
      const headers = { authorization: 'Bearer ' + token }
      if (deadline) headers['x-freezr-job-deadline'] = String(deadline)
      const req = {
        method,
        url: fullPath, // Express parses path + query from here
        originalUrl: fullPath,
        body: body || {},
        headers,
        cookies: {},
        session
      }
      const res = makeRes(session, flogger)
      const finish = () => {
        if (settled) return
        settled = true
        resolve(res._captured ?? { statusCode: 500, body: { error: 'internalApiClient: no response captured' }, rawText: undefined })
      }
      res._onDone = finish
      // Called only if no route responds (404) or a sync error bubbles up.
      const done = (err) => {
        if (settled) return
        if (err) { settled = true; return reject(err) }
        if (res._captured !== undefined) return finish()
        settled = true
        resolve({ statusCode: 404, body: { error: 'no matching internal route: ' + method + ' ' + fullPath }, rawText: undefined })
      }
      try {
        app(req, res, done)
      } catch (e) {
        if (!settled) { settled = true; reject(e) }
      }
    })
  }

  // Verb helpers: send a request through the real in-process route table and return the PARSED body.
  // Throws on status >= 400 (mirrors what an HTTP client sees). Used by the selftest verb methods.
  const request = async ({ method, path, body = {}, token, ctx = {} }) => {
    const app = await getApp()
    const captured = await runThroughApp(app, { method, fullPath: path, body, token, flogger: ctx.flogger })
    if (captured.statusCode >= 400) {
      const err = new Error(captured.body?.error || captured.body?.message || ('API error ' + captured.statusCode))
      err.statusCode = captured.statusCode
      err.body = captured.body
      throw err
    }
    return captured.body
  }

  // Transport for the bundled job client (jobFreezrClient → makeFetchShim): returns the RAW response
  // envelope { ok, status, bodyText } and never throws on 4xx/5xx — the shim turns bodyText into a
  // faithful Response (json()/text()/body.getReader()) so the browser client's streaming reader works.
  const requestRaw = async ({ method, path, body = {}, token, ctx = {} }) => {
    const app = await getApp()
    const captured = await runThroughApp(app, { method, fullPath: path, body, token, flogger: ctx.flogger, deadline: ctx.deadline })
    const bodyText = (captured.rawText !== undefined && captured.rawText !== null)
      ? captured.rawText
      : (captured.body !== undefined ? safeStringify(captured.body) : '')
    return { ok: captured.statusCode < 400, status: captured.statusCode, bodyText }
  }

  return {
    // Convenience verb methods (used by the selftest endpoints) — all go through the real routes.
    write (token, app_table, record = {}, query = {}, ctx = {}) {
      return request({ method: 'POST', path: '/ceps/write/' + app_table, body: record, token, ctx })
    },
    read (token, app_table, data_object_id, ctx = {}) {
      return request({ method: 'GET', path: '/ceps/read/' + app_table + '/' + data_object_id, token, ctx })
    },
    query (token, app_table, q = {}, opts = {}, ctx = {}) {
      return request({ method: 'POST', path: '/ceps/query/' + app_table, body: { q, ...opts }, token, ctx })
    },
    update (token, app_table, data_object_id, record = {}, ctx = {}) {
      return request({ method: 'PUT', path: '/ceps/update/' + app_table + '/' + data_object_id, body: record, token, ctx })
    },
    delete (token, app_table, data_object_id, ctx = {}) {
      return request({ method: 'DELETE', path: '/ceps/delete/' + app_table + '/' + data_object_id, token, ctx })
    },

    // The transport target for the bundled job client (jobFreezrClient): it already builds full
    // /ceps|feps/... paths (incl. /feps/llm, /feps/connections/*) + bodies, so we route them
    // straight through the real app. Covers the whole surface, not just ceps.
    dispatch (method, path, body = {}, token, ctx = {}) {
      return requestRaw({ method, path, body, token, ctx })
    }
  }
}

export default { createInternalApiClient }
