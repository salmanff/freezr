// freezr.info — Portable job-client core (the vm loader, no host paths)
//
// This is the SINGLE implementation of "turn the real browser freezr client into a node-side
// client backed by an arbitrary transport." It takes the client SOURCE STRINGS as input and
// has NO filesystem / manifest / host dependency — so the exact same module runs both:
//   - on the freezr host (jobFreezrClient.mjs supplies sources read from disk), and
//   - inside a deployed serverless bundle (the generated entrypoint supplies sources from the
//     bundle's clientSources.json).
// Keeping the vm + fetch-shim logic here (not duplicated) preserves the "one client" promise.

import vm from 'node:vm'

// Build a faithful Response from a raw body string: .json()/.text() AND a real .body.getReader()
// (so the browser client's streaming reader — llm SSE, connection binary — works). The whole body is
// replayed as a single chunk; for a headless job that's equivalent (the final result is identical).
const makeResponse = (ok, status, text) => {
  let read = false
  return {
    ok,
    status,
    json: async () => (text ? JSON.parse(text) : null),
    text: async () => text,
    body: {
      getReader () {
        return {
          read: async () => {
            if (read) return { done: true, value: undefined }
            read = true
            return { done: false, value: new TextEncoder().encode(text) }
          },
          releaseLock () {},
          cancel () {}
        }
      }
    }
  }
}

// A fetch() that satisfies how freezrApiV2's apiRequest + streaming reader consume a response, but
// routes the call to `transport` instead of the network. The transport returns a raw envelope
// { ok, status, bodyText }; or it may throw { statusCode, body } on a hard failure (no URL / network).
// (Back-compat: a transport that returns a plain parsed object is treated as a 200 JSON body.)
export const makeFetchShim = (transport) => async (url, opts = {}) => {
  const method = (opts.method || 'GET').toUpperCase()
  const path = String(url)
  let body = opts.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch (e) { /* keep raw string */ } }
  let envelope
  try {
    envelope = await transport(method, path, body, opts)
  } catch (e) {
    const status = e.statusCode || 500
    const errBody = e.body || { success: false, error: e.message || 'error' }
    return makeResponse(false, status, JSON.stringify(errBody))
  }
  if (envelope && typeof envelope === 'object' && 'bodyText' in envelope) {
    return makeResponse(!!envelope.ok, envelope.status || 200, envelope.bodyText || '')
  }
  // Back-compat: a transport that returns a parsed result rather than an envelope.
  return makeResponse(true, 200, JSON.stringify(envelope))
}

/**
 * Build a job-side `freezr` client from client source strings + a transport.
 * @param {Object}   args
 * @param {Function} args.transport          (method, path, body, options) => Promise<result>
 * @param {Object}   [args.freezrMeta]       { appName, appToken, serverAddress, ... }
 * @param {Object}   args.sources            { coreName, core, addons: [{ name, src }] }
 * @returns the real freezr client (freezr.create/read/query/..., freezr.llm.*, freezr.connections.*)
 */
export function buildFreezrClient ({ transport, freezrMeta = {}, sources }) {
  if (typeof transport !== 'function') throw new Error('buildFreezrClient: transport function required')
  if (!sources || !sources.core) throw new Error('buildFreezrClient: client sources required')

  // Globals the browser scripts read at LOAD time. `document` is deliberately omitted so the
  // menu/DOM-init blocks (guarded by `typeof document`) are skipped. `window` is provided because
  // the core does `window.freezr = freezr` — our capture point. serverAddress '' keeps apiRequest's
  // URL relative ('/ceps/...') so the transport sees the path; appToken non-empty satisfies its
  // "need a token" guard (the transport handles real auth).
  const sandbox = {
    window: {},
    console,
    fetch: makeFetchShim(transport),
    FormData: (typeof FormData !== 'undefined' ? FormData : undefined),
    // TextDecoder/TextEncoder: the browser client decodes streamed responses (e.g. llm SSE via
    // response.body.getReader()) with `new TextDecoder()`; the vm sandbox has no globals unless we
    // inject them, so without these freezr.llm.ask throws "TextDecoder is not defined" inside a job.
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    URL,
    freezrMeta: { serverAddress: '', appToken: 'inprocess', ...freezrMeta }
  }
  const context = vm.createContext(sandbox)

  vm.runInContext(sources.core, context, { filename: sources.coreName || 'freezrApiV2.js' })

  // The core declares `const freezr` (lexical, invisible to later vm scripts). Expose it as a
  // context global so the addon scripts' free `freezr` reference resolves.
  context.freezr = context.window.freezr
  for (const addon of (sources.addons || [])) {
    vm.runInContext(addon.src, context, { filename: addon.name })
  }

  const freezr = context.window.freezr
  if (!freezr) throw new Error('buildFreezrClient: failed to construct freezr client from source')

  freezr.app.isWebBased = false
  return freezr
}

export default { buildFreezrClient, makeFetchShim }
