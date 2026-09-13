// requestWatchdog.mjs - names and frees requests that never answer
//
// WHY THIS EXISTS
// A request that hangs forever does not just lose itself: it parks the TCP
// connection it arrived on. Browsers allow ~6 concurrent connections per origin
// on HTTP/1.1, so six hung requests lock the browser out of the server
// completely - every later click, poll and page load queues behind them and the
// app looks totally frozen even though the server is healthy and answering new
// connections fine. Node's own timeouts do not help: `requestTimeout` measures
// receiving the request, not producing the response, and a socket-level
// `server.timeout` would also kill legitimately quiet long-lived streams.
//
// Worse, freezr logs `track('api')` / `track('page')` from the response helpers
// (adapters/http/responses.mjs), i.e. at RESPONSE time - so a request that never
// responds writes nothing at all to the log. The symptom is a log that just
// stops, with the idle-flush heartbeat as its last line.
//
// So this middleware does two things:
//   1. logs any request still unanswered after SLOW_MS, with path + user, so the
//      stalled route names itself instead of vanishing;
//   2. answers it with a 503 after TIMEOUT_MS, which frees the connection and
//      keeps one bad route from taking the whole app down with it.
//
// Streaming responses (SSE, downloads) send their headers immediately and then
// stay open by design, so anything with headers already sent is left alone.
//
// Requests that legitimately run for minutes without sending anything - a model
// generation, a store migration, a job run - are NOT streaming and would be cut
// off, so they are exempted by path (REQUEST_WATCHDOG.LONG_RUNNING_PATHS) or at
// runtime via markLongRunning(res). Exempt requests are still warned about at
// SLOW_MS; they are only spared the abort.

/**
 * Exempt THIS request from the abort (it will still be logged if slow).
 * For a route that can legitimately run past the timeout but isn't covered by
 * REQUEST_WATCHDOG.LONG_RUNNING_PATHS - eg one whose duration depends on a
 * runtime choice. Call it before doing the slow work.
 */
export function markLongRunning (res) {
  if (res && res.locals) res.locals.freezrLongRunning = true
}

const envInt = (name, fallback) => {
  const raw = parseInt(process.env[name], 10)
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

/**
 * Mount AFTER createRequestLoggerMiddleware, so res.locals.flogger exists.
 * @param {number} [options.slowMs] - log a warning if still unanswered after this
 * @param {number} [options.timeoutMs] - send a 503 if still unanswered after this
 */
export function createRequestWatchdogMiddleware (options = {}) {
  const slowMs = options.slowMs || envInt('FREEZR_REQUEST_SLOW_MS', 10 * 1000)
  const timeoutMs = options.timeoutMs || envInt('FREEZR_REQUEST_TIMEOUT_MS', 2 * 60 * 1000)
  const longRunningPaths = options.longRunningPaths || []

  const isLongRunning = (req, res) => res.locals?.freezrLongRunning ||
    longRunningPaths.some(prefix => req.path === prefix || req.path.startsWith(prefix + '/'))

  return (req, res, next) => {
    const startedAt = Date.now()
    const where = () => ({
      method: req.method,
      path: req.originalUrl || req.path,
      user: req.session?.logged_in_user_id,
      waitedMs: Date.now() - startedAt
    })

    const slowTimer = setTimeout(() => {
      if (res.headersSent) return // streaming response, not a stall
      const flogger = res.locals?.flogger
      const msg = '⏳ [WATCHDOG] request still unanswered after ' + Math.round(slowMs / 1000) + 's'
      if (flogger?.warn) flogger.warn(msg, where())
      else console.warn(msg, where())
    }, slowMs)

    const killTimer = setTimeout(() => {
      if (res.headersSent) return // streaming response, already answering
      if (isLongRunning(req, res)) return // allowed to take as long as it takes
      const flogger = res.locals?.flogger
      const msg = '🛑 [WATCHDOG] no response after ' + Math.round(timeoutMs / 1000) + 's - freeing the connection'
      if (flogger?.error) flogger.error(msg, where())
      else console.error(msg, where())

      // Mark it so the response helpers stay quiet if the route ever does finish.
      res.locals.freezrTimedOut = true
      try {
        res.status(503).json({
          success: false,
          error: 'The server did not answer this request in time. See the WATCHDOG line in the server log for the route that stalled.'
        })
      } catch (e) {
        try { res.destroy() } catch (e2) { /* socket already gone */ }
      }
    }, timeoutMs)

    // unref so a stalled request can never hold the process open on shutdown
    slowTimer.unref?.()
    killTimer.unref?.()

    const clear = () => { clearTimeout(slowTimer); clearTimeout(killTimer) }
    res.on('finish', clear)
    res.on('close', clear)

    next()
  }
}
