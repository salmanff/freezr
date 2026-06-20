// freezr.info — HTTP transport for the bundled job client (the serverless path)
//
// The job client (jobClientCore.buildFreezrClient) is transport-polymorphic: locally the transport
// routes into the in-process API; on serverless it makes a real HTTPS call back to the freezr
// server. This module is that real-network transport. It is COPIED VERBATIM into every serverless
// bundle (adapters/jobs/serverlessBundle.mjs) and imported by the generated entrypoint, so it must
// stay dependency-free and rely only on the runtime's global `fetch` (Node 18+ / Lambda nodejs20.x).
//
// Contract (matches makeFetchShim's expectation): returns the parsed JSON body on success, throws
// { statusCode, body } on an HTTP error — so the client surfaces failures the same way it does
// in-process.

/**
 * @param {Object} args
 * @param {string} args.baseUrl  freezr server base URL (no trailing slash needed)
 * @param {string} args.token    bearer token for the run (the short-lived job token)
 * @returns {Function} transport(method, path, body) => Promise<result>
 */
export function makeHttpTransport ({ baseUrl, token }) {
  // No baseUrl is allowed: a job that never calls freezr.* still runs. We only fail (clearly) if a
  // freezr.* call is actually made without a callback URL — so construction never throws.
  const base = baseUrl ? String(baseUrl).replace(/\/$/, '') : ''
  return async (method, path, body) => {
    if (!base) {
      const e = new Error('this serverless job tried to call the freezr API but no callback URL is configured (set the Serverless callback URL in admin prefs)')
      e.statusCode = 503
      e.body = { success: false, error: e.message }
      throw e
    }
    const m = (method || 'GET').toUpperCase()
    const headers = { Authorization: 'Bearer ' + token }
    let payload
    if (m !== 'GET' && m !== 'HEAD' && body != null) {
      headers['Content-Type'] = 'application/json'
      payload = typeof body === 'string' ? body : JSON.stringify(body)
    }
    let res
    try {
      res = await fetch(base + String(path), { method: m, headers, body: payload })
    } catch (e) {
      // Node's global fetch reports a bare "fetch failed"; the real reason is in e.cause (ENOTFOUND,
      // ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT, a TLS cert error, …). Surface it so a serverless run
      // shows WHY it couldn't reach the freezr server (almost always the callback URL / reachability).
      const cause = e && e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : (e && e.message)
      const err = new Error('freezr callback fetch failed (' + (cause || 'unknown') + ') → ' + base + String(path))
      err.statusCode = 502
      err.body = { success: false, error: err.message }
      throw err
    }
    // Return the RAW body (the job-client shim turns it into a faithful Response). Buffering the whole
    // body — including an SSE stream from /feps/llm/ask — is fine for a headless job: the final result
    // is identical; the client's stream reader just receives it in one chunk. No throw on 4xx/5xx —
    // the shim surfaces the status to the browser client exactly like a real fetch.
    const bodyText = await res.text()
    return { ok: res.ok, status: res.status, bodyText }
  }
}

export default { makeHttpTransport }
