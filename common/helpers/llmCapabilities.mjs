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
 * embeddings (OpenAI yes / Anthropic no), codeExecution, moderation (OpenAI, free),
 * mcp (hosted MCP connectors on both).
 */
export const CAPABILITY_KEYS = [
  'web', // { search, fetch } — reach the live web
  'vision', // image input
  'documents', // pdf / document input
  'thinking', // { text } — whether the REASONING TEXT comes back, not whether it thinks
  'effort', // output_config.effort dial
  'cache', // { explicit, ttl } vs { automatic }
  'images', // { generate: 'svg' | 'raster' }
  'voice', // { stt, tts } — reserved; no provider wired yet
  // Native schema-constrained generation: the PROVIDER guarantees the reply matches a JSON
  // Schema (OpenAI `text.format`, Anthropic `output_config.format`). A different thing from
  // responseType:'json', which asks for JSON in the prompt and parses whatever comes back; a
  // connector that only does the latter must NOT declare this. Added 2026-09-19.
  'structuredOutput'
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

// ── structuredOutput: the request option and the strict parse ────────────────────────────
//
// Both live here rather than in the controller because they are pure, both sides of the
// boundary need the same reading of them, and they must be unit-testable without a server.
//
// THE RULE THIS OPTION EXISTS TO KEEP: a caller who supplies a schema either gets a reply that
// satisfies it or an error — never a success carrying text that "probably" parses. So `strict`
// cannot be turned off, and the parser has none of the fence-stripping, brace-hunting tolerance
// that responseType:'json' has. A caller who does not pass the option is untouched by any of
// this: normalizeStructuredOutput returns null and nothing downstream looks further.

const STRUCTURED_OUTPUT_DEFAULT_NAME = 'freezr_response'

const invalidStructuredOption = (message) => {
  const err = new Error('structuredOutput: ' + message)
  err.code = 'structured_output_invalid_option'
  return err
}

/**
 * Normalize the `structuredOutput` request option.
 *   absent / null / false            -> null (nothing asked for; every existing path is unchanged)
 *   { schema, name?, description? }  -> { name, description?, schema, strict: true }
 * Throws (code 'structured_output_invalid_option') on a malformed option, so the controller can
 * answer 400 before any connector is called or any token is spent. `name` is clamped to
 * OpenAI's accepted form (letters, digits, _ and -, at most 64) — the stricter of the two
 * providers; Anthropic ignores it.
 */
export const normalizeStructuredOutput = (opt) => {
  if (opt === undefined || opt === null || opt === false) return null
  if (!isPlainObject(opt)) throw invalidStructuredOption('must be an object { schema, name?, description? }')
  if (!isPlainObject(opt.schema)) throw invalidStructuredOption('schema must be a JSON Schema object')
  if (opt.strict === false) throw invalidStructuredOption("strict:false is not supported — the option exists to guarantee the schema; use responseType:'json' for best-effort parsing")
  const rawName = (opt.name === undefined || opt.name === null) ? STRUCTURED_OUTPUT_DEFAULT_NAME : String(opt.name)
  const name = rawName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || STRUCTURED_OUTPUT_DEFAULT_NAME
  const out = { name, schema: opt.schema, strict: true }
  if (opt.description !== undefined && opt.description !== null) out.description = String(opt.description).slice(0, 500)
  return out
}

/**
 * Strict parse of a structured reply. Returns { ok: true, value } or { ok: false, error }.
 * An object is accepted as-is (a connector may already have parsed); a string must be EXACTLY
 * one JSON document — no fences, no prose around it. Anything else is a failure the caller must
 * surface, never a success.
 */
export const parseStructuredOutput = (response) => {
  if (response !== null && typeof response === 'object') return { ok: true, value: response }
  if (typeof response !== 'string' || !response.trim()) return { ok: false, error: 'the model returned no JSON' }
  try {
    return { ok: true, value: JSON.parse(response) }
  } catch (e) {
    return { ok: false, error: 'the reply is not valid JSON (' + (e && e.message) + ')' }
  }
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
