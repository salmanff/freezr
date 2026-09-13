// freezr.info — LLM capability vocabulary — llmCapabilities.mjs
//
// The shared vocabulary for what an LLM provider can do beyond plain text-in/text-out, and
// the tri-state resolver over it. Lives in common/ because BOTH sides need it: the connectors
// in adapters/llmConnectors DECLARE against this vocabulary, and llmCapabilityService in
// features/apps ENFORCES against it. Keeping it here means an adapter never has to import
// upward out of features/.
//
// Nothing here touches a db or a network.
//
// THREE-STATE VALUES. Every capability resolves to one of:
//   true / a detail object  — supported
//   false                   — definitively NOT supported
//   'unknown'               — the provider never said
// 'unknown' is not a soft 'no'. It is the honest answer when the provider's own capability
// data is silent about a feature, and it MUST be allowed through to the provider: the
// connectors discover the truth by trying and degrading on rejection (the same ladder the
// Anthropic adapter already runs for `thinking` and `output_config`), which is what keeps
// freezr out of the business of maintaining a per-model capability table that would rot.
// Blocking on 'unknown' would silently deny features on every model the provider hasn't
// documented yet — exactly the failure this design exists to avoid.

export const UNKNOWN = 'unknown'

/**
 * The capability vocabulary. A key absent from a connector's map means unsupported.
 * Only keys freezr actually routes belong here — nothing is declared that isn't wired.
 *
 * Not in the vocabulary yet, in rough order of value when someone builds them:
 * embeddings (OpenAI yes / Anthropic no), codeExecution, structuredOutput (both have
 * native schema-constrained output; responseType:'json' is prompt-parsed today),
 * moderation (OpenAI, free), mcp (hosted MCP connectors on both).
 */
export const CAPABILITY_KEYS = [
  'web', // { search, fetch } — reach the live web
  'vision', // image input
  'documents', // pdf / document input
  'thinking', // { text } — whether the REASONING TEXT comes back, not whether it thinks
  'effort', // output_config.effort dial
  'cache', // { explicit, ttl } vs { automatic }
  'images', // { generate: 'svg' | 'raster' }
  'voice' // { stt, tts } — reserved; no provider wired yet
]

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/**
 * Resolve a dotted capability path ('web', 'web.search', 'voice.stt') against a
 * connector's capability map. Returns true / false / UNKNOWN — never undefined.
 *
 * A missing key is `false` (the connector's map is the complete list of what it wires),
 * but an explicit UNKNOWN anywhere along the path wins, because "the provider didn't say"
 * is information we must not round to a no.
 */
export const resolveCapability = (capabilities, path) => {
  if (!isPlainObject(capabilities)) return UNKNOWN
  const segments = String(path || '').split('.').filter(Boolean)
  if (!segments.length) return false

  let node = capabilities
  for (const segment of segments) {
    if (node === UNKNOWN) return UNKNOWN
    if (node === true) return UNKNOWN // supported in general, silent about this sub-key
    if (!isPlainObject(node)) return false
    if (!(segment in node)) return false
    node = node[segment]
  }
  if (node === UNKNOWN) return UNKNOWN
  if (isPlainObject(node)) {
    // A detail object counts as supported as long as it isn't all-false.
    const values = Object.values(node)
    if (values.length && values.every(v => v === false)) return false
    return node
  }
  return node || false
}

/** True when a resolved value means "go ahead" — including UNKNOWN, which means "try it". */
export const isPermitted = (value) => value !== false

/** True only when the provider positively confirmed it. Used for ping/`can`, never to block. */
export const isConfirmed = (value) => value !== false && value !== UNKNOWN

/**
 * Normalize the `web` request option into a canonical shape.
 *   true                      -> { search: true, fetch: true }
 *   { search, fetch, ... }    -> passed through, missing halves defaulted OFF
 * `optional` and `raw` are carried through untouched (raw is the deliberately
 * non-portable per-provider escape hatch).
 * Returns null when the caller asked for nothing.
 */
export const normalizeWebOption = (web) => {
  if (!web) return null
  if (web === true) return { search: true, fetch: true, optional: false, raw: null }
  if (!isPlainObject(web)) return null

  // An object that names neither half means "whatever you have" — same as true.
  const namesNeither = web.search === undefined && web.fetch === undefined
  return {
    search: namesNeither ? true : (web.search || false),
    fetch: namesNeither ? true : (web.fetch || false),
    optional: web.optional === true,
    raw: isPlainObject(web.raw) ? web.raw : null
  }
}
