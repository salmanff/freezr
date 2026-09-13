// freezr.info - Anthropic LLM Connector
// Adapter to translate freezr's standard LLM format into Anthropic API calls.
//
// Connector contract for any provider adapter:
// - `listModels({ apiKey })` -> [{ id, family, provider, version, ... }]
// - `parseModelId(id)` -> { id, family, provider, version }
// - `getPricing({ apiKey, targetModel? })` -> { models, source, sourceModel } | null
// - `ask({ apiKey, prompt, context, model, max_tokens, role, responseType, thinking, files, web })`
//      -> { response, thinking, provider, model, family, rawUsage, tokensUsed,
//           toolsUsed, citations, unavailable }
// - `CAPABILITIES` -> what THIS ADAPTER implements, against the vocabulary in
//      common/helpers/llmCapabilities.mjs. Hardcoded, but it is a fact about our own code,
//      not about the provider's model lineup, so it cannot go stale on its own.
// - `getCapabilities({ apiKey, model? })` -> the same map narrowed for one model, values
//      true | false | 'unknown'. NEVER derive these from a model-id substring: resolve them
//      from the provider's own data, or return 'unknown' and let the request settle it.
//      'unknown' means "try it", and the capability gate lets it through on purpose.
// - `getFamilyFromModelId(id)` -> canonical family key used by pricing/ping snapshots
// - `getVendorForModel(id)` -> who actually ran the model, for cost accounting. For a
//      direct-key adapter this is a constant; an aggregator (e.g. OpenRouter, whose model
//      ids look like `<vendor>/<model>`) must return the real upstream vendor, because
//      info.freezr.account.usageTallies keys a row by (app, api key, vendor, day).
//
// The controller uses these exports to build `freezr.llm.ping()` results:
// `{ success, exists, defaultProvider, defaultFamily, providers, imageProviders, capabilities, pricingMeta }`
// Not all features have been tested!!
//
// CAPABILITY RESOLUTION IS THREE-TIER, and freezr keeps NO hand-written per-model feature
// table (see the note at the top of common/helpers/llmCapabilities.mjs):
//   1. provider — CAPABILITIES below: does this adapter wire the feature at all.
//   2. model    — read live from the Models API `capabilities` tree, off the model list that
//                 getAvailableModels already caches for an hour.
//   3. unknown  — probed, not guessed: send it, and if the API rejects it (which happens on
//                 create(), before any token streams, so a retry is free) degrade and
//                 remember the verdict via rememberProbe.
// Tier 3 is the same ladder this file already used for `thinking` and `output_config`; web
// access simply joins it. Verified against the live Models API (2026-09): the tree publishes
// batch, citations, code_execution, context_management, effort, image_input, pdf_input,
// structured_outputs and thinking — but NOTHING about the web tools, so web access is a
// tier-3 capability by design, not by oversight.

import Anthropic from '@anthropic-ai/sdk'
import { UNKNOWN, normalizeWebOption } from '../../common/helpers/llmCapabilities.mjs'

export const DEFAULT_FAMILY = 'sonnet'

/** Every model reachable with an Anthropic key is run by Anthropic. See connector contract above. */
export const getVendorForModel = (_modelId) => 'anthropic'

const DEFAULT_MAX_TOKENS = 1024 * 30
let cachedModels = null
let cachedModelsTimestamp = 0
const MODEL_CACHE_TTL = 1000 * 60 * 60 // 1 hour

export const getFamilyFromModelId = (id) => {
  if (!id) return ''
  let name = id.toLowerCase()
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
  const segments = name.split('-')
  const nameParts = []
  let majorVersion = null
  for (const seg of segments) {
    if (/^\d+$/.test(seg)) {
      if (majorVersion === null) majorVersion = seg
    } else {
      nameParts.push(seg)
    }
  }
  const base = nameParts.join('-')
  return majorVersion ? `${base}-${majorVersion}` : base
}

export const parseModelId = (id) => {
  if (!id) return { id: id || '', family: '', provider: 'Claude', version: '' }
  const stripped = id.toLowerCase().replace(/-\d{8}$/, '').replace(/^claude-/, '')
  const segments = stripped.split('-')
  const familyParts = []
  const versionParts = []
  let majorVersion = null
  for (const seg of segments) {
    if (/^\d+$/.test(seg)) {
      if (majorVersion === null) majorVersion = seg
      versionParts.push(seg)
    } else {
      familyParts.push(seg)
    }
  }
  const baseName = familyParts.join('-') || ''
  const family = majorVersion ? `${baseName}-${majorVersion}` : baseName
  return {
    id,
    family,
    provider: 'Claude',
    version: versionParts.join('.') || ''
  }
}

const compareVersions = (a, b) => {
  const numA = parseFloat(a) || 0
  const numB = parseFloat(b) || 0
  if (numA !== numB) return numA - numB
  return (a || '').localeCompare(b || '')
}

const markLatestPerFamily = (models) => {
  const best = {}
  for (const m of models) {
    if (!best[m.family] || compareVersions(m.version, best[m.family].version) > 0) {
      best[m.family] = m
    }
  }
  for (const m of models) {
    m.latest = (m === best[m.family])
  }
  return models
}

// Which thinking SHAPE this model takes: `{ type: 'adaptive' }` or the legacy
// `{ type: 'enabled', budget_tokens }`. Sending the wrong one is a 400
// ("thinking.type.enabled is not supported for this model").
//
// ANSWERED BY THE PROVIDER when we have its capability tree, which publishes exactly this:
//   "thinking": { "supported": true,
//                 "types": { "enabled": { "supported": false },
//                            "adaptive": { "supported": true } } }
// The version regex below is now only the FALLBACK, for when the tree is unavailable (offline,
// a model missing from the list, a cold cache). It used to be the sole source of truth, and it
// is the last hand-maintained capability guess in this file — every model the tree covers now
// bypasses it entirely, so a new family cannot silently get the wrong shape.
const isAdaptiveOnlyThinkingModel = (modelId, tree = null) => {
  const adaptive = readCapabilityLeaf(tree, ['thinking.types.adaptive'])
  const enabled = readCapabilityLeaf(tree, ['thinking.types.enabled'])
  // Adaptive-only means: adaptive works AND the legacy budget form does not.
  if (adaptive !== UNKNOWN && enabled !== UNKNOWN) return adaptive === true && enabled === false
  if (adaptive === true && enabled === UNKNOWN) return true

  if (!modelId) return false
  const id = modelId.toLowerCase()
  if (/fable|mythos/.test(id)) return true
  // GENERIC version parse — the old opus-only regex missed every single-number model
  // (claude-sonnet-5, claude-opus-5), so thinking:true sent them the legacy enabled+budget shape,
  // which they reject with a 400. Adaptive applies from 4.6 up (4.6 accepts both; the docs say
  // prefer adaptive there) and on every 5-series model. Haiku 4.5 and older stay on the budget form.
  const m = id.match(/(?:opus|sonnet|haiku)-(\d+)(?:-(\d+))?/)
  if (!m) return false
  const major = parseInt(m[1], 10)
  const minor = m[2] != null ? parseInt(m[2], 10) : 0
  if (/haiku/.test(id)) return major >= 5
  return major >= 5 || (major === 4 && minor >= 6)
}

export const buildThinkingConfig = (modelId, thinking, maxTokens, tree = null) => {
  // EXPLICIT false ≠ absent. Recent models (Sonnet 5, Opus 4.7+) think BY DEFAULT when no thinking
  // param is sent, and those tokens bill as OUTPUT — so "omit the param" stopped meaning "off".
  // A caller doing high-volume structured extraction must be able to opt out; without this the
  // model can spend its entire output budget reasoning (observed: 40k tokens, $0.60, per email).
  if (thinking === false) {
    return isAdaptiveOnlyThinkingModel(modelId, tree) ? { type: 'disabled' } : null
  }
  if (!thinking) return null
  if (isAdaptiveOnlyThinkingModel(modelId, tree)) {
    const config = { type: 'adaptive' }
    // display: 'summarized' | 'omitted'. On these models the API DEFAULTS TO
    // 'omitted', which still streams thinking blocks but with empty text — so a
    // caller that shows reasoning to a user gets nothing back while still paying
    // for the thinking tokens. Pass { display: 'summarized' } to get a readable
    // summary. (The raw chain of thought is never returned on any model.)
    // Only the adaptive shape takes display; the legacy enabled+budget models
    // below return their thinking text in full and reject the field.
    if (typeof thinking === 'object' && thinking.display) config.display = String(thinking.display)
    return config
  }
  // A display-ONLY request ({ display: 'summarized' } with no budget) means "let the
  // model do what it does by default, but let me SEE the thinking". Older models
  // return their thinking in full already and have no display field, so for them
  // this is a no-op — returning null leaves the model default alone rather than
  // silently switching thinking ON with a 10k budget the caller never asked for.
  if (typeof thinking === 'object' && thinking.display && !thinking.budget_tokens) return null

  const budgetTokens = (typeof thinking === 'object' && thinking.budget_tokens)
    ? thinking.budget_tokens
    : Math.min(10000, maxTokens - 1)
  return { type: 'enabled', budget_tokens: budgetTokens }
}

// Prompt caching — two modes.
//
// EXPLICIT (the caller placed cache_control on message blocks itself): the caller decides what is
// worth caching. Only the SYSTEM breakpoint is added here (the system prompt precedes every
// message, so caching it is never wrong); the messages are sent exactly as given — NO automatic
// breakpoints. This exists because the automatic layout below cannot tell a stable turn from a
// volatile one: an app whose last message is a fresh email on every call was paying the write
// premium (2x at the 1h TTL) on every email body, and reading it back almost never. In explicit
// mode the system breakpoint takes the 1h TTL when the caller asked for it OR when any caller
// marker is 1h — Anthropic rejects a request whose 5-minute entry precedes a 1-hour one.
// Caller markers alone imply the intent: `cache` may be omitted.
//
// AUTOMATIC (cache: true / { ttl: '1h' }, no caller markers): set up to THREE cache
// breakpoints: the SYSTEM prompt, the SECOND-TO-LAST message, and the LAST message. Anthropic
// caching is a PREFIX match that only resolves AT a breakpoint, which makes the second-to-last
// one the important — and previously missing — case:
// - system: pays off across DIFFERENT requests sharing the instruction block.
// - LAST message: pays off when a follow-up re-sends the same conversation and only APPENDS
//   (repeated Q&A over one document; a model's request-for-detail round).
// - SECOND-TO-LAST message: the end of the STABLE PREFIX in the [big stable turn, small volatile
//   turn] layout. Without a boundary there, request N+1 (same stable turn, DIFFERENT volatile turn)
//   matches nothing past the system prompt — so the stable turn is never read from cache and is
//   RE-WRITTEN at the 1.25x premium on every request. Caching then costs MORE than not caching,
//   which is exactly backwards.
// Cached spans bill at ~10% of the input rate; writes at 1.25x. Default TTL 5 minutes; { ttl: '1h' }
// costs more to write but survives longer gaps. At most 4 breakpoints per request, and attached
// files already carry one each — add only what fits (system first: widest reuse).
//
// callerPlaced must be measured BEFORE file blocks are injected (ask/askStream do this): the
// injected document blocks carry cache_control of their own and would otherwise read as explicit.
export const hasCallerCacheMarkers = (messages) => (messages || []).some(m =>
  m && Array.isArray(m.content) && m.content.some(b => b && typeof b === 'object' && b.cache_control))

export const applyCacheControl = (params, cache, { callerPlaced = false } = {}) => {
  if (!cache && !callerPlaced) return
  const messages = params.messages || []
  let breakpoints = 0
  let callerHour = false
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (!(b && typeof b === 'object' && b.cache_control)) continue
      breakpoints++
      if (b.cache_control.ttl === '1h') callerHour = true
    }
  }
  const ttl = ((cache && typeof cache === 'object' && cache.ttl === '1h') || (callerPlaced && callerHour)) ? '1h' : null
  const cc = { type: 'ephemeral', ...(ttl ? { ttl } : {}) }
  if (params.system && breakpoints < 4) {
    if (typeof params.system === 'string') params.system = [{ type: 'text', text: params.system }]
    if (Array.isArray(params.system) && params.system.length) {
      const sysLast = params.system[params.system.length - 1]
      if (sysLast && typeof sysLast === 'object') { sysLast.cache_control = cc; breakpoints++ }
    }
  }
  if (callerPlaced) return // explicit mode: the caller's markers are the whole layout
  if (!messages.length) return
  const mark = (msg) => {
    if (!msg || breakpoints >= 4) return
    if (typeof msg.content === 'string') msg.content = [{ type: 'text', text: msg.content }]
    if (!Array.isArray(msg.content) || msg.content.length === 0) return
    const block = msg.content[msg.content.length - 1]
    if (block && typeof block === 'object' && !block.cache_control) { block.cache_control = cc; breakpoints++ }
  }
  // stable-prefix end FIRST (wider reuse), then the whole conversation for append-style follow-ups
  if (messages.length >= 2) mark(messages[messages.length - 2])
  mark(messages[messages.length - 1])
}

// Usage arrives across two chunks of a stream and the shapes differ by API version: message_start
// carries input_tokens + the cache_* counts, message_delta carries the final output_tokens and, on
// some versions, echoes the input fields — sometimes as 0. A plain spread would let that 0 clobber
// a real count and silently UNDER-REPORT the bill, so merge by keeping the larger number: within a
// single message every count is cumulative, so the larger value is always the truer one.
const mergeUsage = (prev, next) => {
  const out = { ...(prev || {}) }
  for (const [k, v] of Object.entries(next || {})) {
    if (v == null) continue
    if (typeof v === 'number') out[k] = Math.max(v, typeof out[k] === 'number' ? out[k] : 0)
    // nested counters (cache_creation: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens },
    // server_tool_use) get the same per-field max-merge — a wholesale replace would let a
    // zeroed echo in message_delta wipe the TTL split the 1h/5m write pricing depends on
    else if (typeof v === 'object' && !Array.isArray(v)) out[k] = mergeUsage(out[k], v)
    else out[k] = v
  }
  return out
}

/**
 * @param {Object} usage - the provider's raw usage block
 * @param {Object} [toolsUsed] - what we OBSERVED the server tools do this turn. Used only as a
 *   fallback for request counts: if the provider does not report server_tool_use (the field is
 *   not guaranteed), billing from the counts we watched go past is far better than billing zero.
 */
const standardizeUsage = (usage, toolsUsed = null) => {
  if (!usage) {
    return {
      input: { qtty: 0, cost: 0 },
      output: { qtty: 0, cost: 0 },
      other: { qtty: 0, cost: 0, details: {} }
    }
  }
  const inputQty = usage.input_tokens || 0
  const outputQty = usage.output_tokens || 0
  // Cached-prompt tokens (see applyCacheControl). Anthropic's input_tokens EXCLUDES them, so they
  // are additional volume, reported under `other` with named details the controller can price
  // (reads at the cached rate, writes at a small premium).
  const cacheRead = usage.cache_read_input_tokens || 0
  const cacheWrite = usage.cache_creation_input_tokens || 0
  // Server-tool usage. Web search is billed PER REQUEST (a flat rate per 1,000), not per
  // token, so it goes in `details` for the cost service to price but NOT in `other.qtty` —
  // that field is a token count and feeds totalTokens, where a request count would be a lie.
  const webSearchRequests = usage.server_tool_use?.web_search_requests || toolsUsed?.webSearch?.requests || 0
  const webFetchRequests = usage.server_tool_use?.web_fetch_requests || toolsUsed?.webFetch?.requests || 0

  const details = {}
  if (cacheRead || cacheWrite) {
    details.cacheReadTokens = cacheRead
    details.cacheCreationTokens = cacheWrite
    // The write premium depends on the TTL: 1.25x for 5-minute entries, 2x for 1-hour ones.
    // Anthropic splits the write count by TTL in usage.cache_creation; pass the split through so
    // the cost service can price it (it used to bill every write at 1.25x — a 37.5% under-report
    // on every 1h write, which is exactly the kind an app asking for { ttl: '1h' } makes).
    const split = usage.cache_creation || {}
    const w1h = Number(split.ephemeral_1h_input_tokens) || 0
    const w5m = Number(split.ephemeral_5m_input_tokens) || 0
    if (w1h || w5m) {
      details.cacheCreation1hTokens = w1h
      details.cacheCreation5mTokens = w5m
    }
  }
  if (webSearchRequests) details.webSearchRequests = webSearchRequests
  if (webFetchRequests) details.webFetchRequests = webFetchRequests

  return {
    input: { qtty: inputQty, cost: 0 },
    output: { qtty: outputQty, cost: 0 },
    other: {
      qtty: cacheRead + cacheWrite,
      cost: 0,
      details
    }
  }
}

/**
 * Send a request to Anthropic
 * @param {Object} params
 * @param {string} params.apiKey - Anthropic API key
 * @param {string|Array} params.prompt - Text prompt or array of { role, content } messages
 * @param {string} [params.context] - System message (LLM instructions/persona)
 * @param {string} [params.model] - Model shorthand ('sonnet','opus') or full name; defaults to opus
 * @param {number} [params.max_tokens] - Max tokens for the response
 * @param {string} [params.role] - Default role when prompt is a string (defaults to 'user')
 * @param {string} [params.responseType] - 'json' to auto-parse JSON from response
 * @param {boolean|Object} [params.thinking] - Enable extended thinking. true for default budget, or { budget_tokens: N }
 * @param {boolean|Object} [params.cache] - Cache the prompt prefix (see applyCacheControl). true for the default 5-minute TTL, or { ttl: '1h' }.
 *   A caller that places cache_control on its own message blocks gets ONLY the system breakpoint added (explicit mode).
 * @param {Object[]} [params.files] - Array of multer file objects (buffer + originalname)
 * @returns {Promise<Object>} { response, thinking, provider, model, usage }
 */
export const ask = async ({ apiKey, prompt, context, model, max_tokens, role, responseType, thinking, cache, effort, files, web }) => {
  const client = new Anthropic({ apiKey })
  const modelToUse = await resolveModel(client, model)
  const maxTokens = max_tokens || DEFAULT_MAX_TOKENS

  let messages
  if (Array.isArray(prompt)) {
    messages = prompt
  } else {
    const userContent = prompt || ''
    messages = [{ role: role || 'user', content: userContent }]
  }
  // before file injection — injected document blocks carry markers of their own (see applyCacheControl)
  const callerPlaced = hasCallerCacheMarkers(messages)

  if (files && files.length > 0) {
    const lastUserIdx = findLastIndex(messages, m => m.role === 'user')
    if (lastUserIdx >= 0) {
      const msg = messages[lastUserIdx]
      const existingContent = typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : (Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content) }])

      const fileBlocks = files.map(f => {
        const mime = mimeFromFilename(f.originalname)
        const isImage = mime.startsWith('image/')
        return {
          type: isImage ? 'image' : 'document',
          source: {
            type: 'base64',
            media_type: mime,
            data: f.buffer.toString('base64')
          },
          ...(isImage ? {} : { cache_control: { type: 'ephemeral' } })
        }
      })

      messages[lastUserIdx] = { role: 'user', content: [...fileBlocks, ...existingContent] }
    }
  }

  const params = {
    model: modelToUse,
    max_tokens: maxTokens,
    stream: true,
    messages
  }
  if (context) params.system = context
  applyCacheControl(params, cache, { callerPlaced })

  // effort (output_config): the provider-recommended dial for trading thoroughness against token
  // spend on current models — it scales EVERYTHING the model writes, thinking included. Passed only
  // when the caller sets it; unknown-to-the-model values fail the request, so the degrade-retry
  // below also covers output_config.
  if (effort) params.output_config = { effort: String(effort) }

  // Web access: server tools run on Anthropic's side, so declaring them is the whole
  // integration. Which tool VERSION this model takes is settled by runWithDegrades trying,
  // not by us matching on the model id.
  const webOption = normalizeWebOption(web)
  const webTools = buildWebTools(webOption)
  if (webTools) params.tools = webTools

  // Extended thinking: with the explicit budget_tokens form, temperature must be 1.
  // Opus 4.7+/Fable/Mythos use adaptive thinking instead and reject both budget_tokens
  // and any temperature, so we only set temperature for the budget form.
  // The provider's own answer on which thinking shape this model takes, so we do not have to
  // infer it from the model's name.
  const modelTree = await modelCapabilityTree(client, modelToUse)
  const thinkingConfig = buildThinkingConfig(modelToUse, thinking, maxTokens, modelTree)
  if (thinkingConfig) {
    params.thinking = thinkingConfig
    if (thinkingConfig.type === 'enabled') params.temperature = 1
  }

  // Not every model supports extended thinking (e.g. older Sonnet). Rather than fail the whole
  // request when the caller asked to think, degrade gracefully: retry once without thinking if the
  // API rejects it. Robust across models without maintaining a fragile per-model capability table.
  const collected = await runWithDegrades(client, params, { web: webOption, model: modelToUse })
  const { textResponse, thinkingResponse, usage, stopReason, toolsUsed, citations, webDropped } = collected
  const response = responseType === 'json' ? parseJsonResponse(textResponse) : textResponse

  if (stopReason === 'pause_turn') {
    console.warn('[freezr anthropic] the answer stopped at a paused server-tool turn — the caller is getting a PARTIAL answer')
  }
  if (stopReason === 'max_tokens') {
    console.warn('[freezr anthropic] answer hit the max_tokens ceiling (' + maxTokens +
      ') and was CUT OFF — the caller is getting a partial answer' +
      (responseType === 'json' ? ' (and its JSON will not parse)' : ''))
  }

  return {
    response,
    thinking: thinkingResponse || null,
    provider: 'Claude',
    model: modelToUse,
    family: getFamilyFromModelId(modelToUse),
    // 'max_tokens' means the answer was truncated; 'end_turn' means it finished.
    stopReason: stopReason || null,
    maxTokens,
    // What the server tools actually did — sources for display, fetched URLs for audit.
    toolsUsed: toolsUsed || null,
    citations: (citations && citations.length) ? citations : null,
    // The caller passed web:{optional:true} and this model could not; say so rather than
    // letting a stale answer pass for a web-informed one.
    unavailable: webDropped ? ['web'] : [],
    rawUsage: usage,
    tokensUsed: standardizeUsage(usage, toolsUsed)
  }
}

/**
 * Resolve a model shorthand (e.g. 'sonnet', 'opus', 'haiku') to a full Anthropic model ID.
 * Fetches available models from the API and picks the latest matching one.
 * If the model string already looks like a full ID (contains a date stamp), it is used as-is.
 */
const resolveModel = async (client, model) => {
  const shorthand = (model || 'sonnet').toLowerCase()

  if (shorthand.includes('-20') || shorthand.startsWith('claude-')) {
    return model
  }

  try {
    const models = await getAvailableModels(client)
    const matching = models
      .filter(m => m.id.includes(shorthand))
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    if (matching.length > 0) return matching[0].id
  } catch (e) {
    console.warn('Could not fetch Anthropic models, using fallback:', e.message)
  }

  return 'claude-sonnet-4-20250514'
}

const getAvailableModels = async (client) => {
  const now = Date.now()
  if (cachedModels && (now - cachedModelsTimestamp) < MODEL_CACHE_TTL) {
    return cachedModels
  }
  const response = await client.models.list({ limit: 100 })
  cachedModels = response?.data || []
  cachedModelsTimestamp = now
  return cachedModels
}

/**
 * TIER 1 — what THIS ADAPTER implements. A fact about our own code, not about Anthropic's
 * model lineup, so it cannot rot: it changes only when someone edits this file.
 * Per-model truth is tiers 2/3 in getCapabilities() below.
 */
export const CAPABILITIES = {
  web: { search: true, fetch: true },
  vision: true,
  documents: true,
  thinking: { text: true },
  effort: true,
  cache: { explicit: true, ttl: ['5m', '1h'] },
  images: { generate: 'svg' },
  voice: false
}

// TIER 3 memo: verdicts LEARNED by trying (see probeMemoKey / rememberProbe below). Shares
// the model cache's TTL so a provider-side change is picked up within the hour, and so the
// whole thing evaporates on restart rather than hardening into a stale table.
let probeMemo = {}
let probeMemoTimestamp = 0

const probeMemoKey = (model, capability) => (model || '') + '::' + capability

const readProbeMemo = (model, capability) => {
  if ((Date.now() - probeMemoTimestamp) >= MODEL_CACHE_TTL) { probeMemo = {}; return undefined }
  return probeMemo[probeMemoKey(model, capability)]
}

/**
 * Record what the API just told us about (model, capability). Called from the degrade
 * ladders in ask()/askStream() so a rejection is paid once an hour, not once a request.
 */
export const rememberProbe = (model, capability, supported) => {
  if ((Date.now() - probeMemoTimestamp) >= MODEL_CACHE_TTL) { probeMemo = {}; probeMemoTimestamp = Date.now() }
  if (!probeMemoTimestamp) probeMemoTimestamp = Date.now()
  probeMemo[probeMemoKey(model, capability)] = supported
}

/**
 * TIER 2 — the provider's own answer. The Models API returns a `capabilities` tree per model
 * ({ image_input: { supported }, thinking: { types: { adaptive: { supported } } }, effort: {...},
 * structured_outputs: {...}, ... }) and getAvailableModels ALREADY caches the full model objects
 * for an hour — listModels was simply throwing the tree away. So this costs no extra request.
 */
export const capabilityTreeFor = (models, modelId) => {
  if (!modelId) return null
  const exact = (models || []).find(m => m.id === modelId)
  if (exact) return exact.capabilities || null
  // A shorthand ('sonnet') that resolveModel would expand — match the newest id containing it.
  const matching = (models || [])
    .filter(m => m.id.includes(String(modelId).toLowerCase()))
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
  return matching.length ? (matching[0].capabilities || null) : null
}

/**
 * Read a `supported` leaf, trying several documented spellings. Returns true / false /
 * UNKNOWN — and UNKNOWN when the tree is SILENT, never a guess from the model id.
 */
export const readCapabilityLeaf = (tree, candidatePaths) => {
  if (!tree || typeof tree !== 'object') return UNKNOWN
  for (const path of candidatePaths) {
    let node = tree
    let found = true
    for (const seg of path.split('.')) {
      if (!node || typeof node !== 'object' || !(seg in node)) { found = false; break }
      node = node[seg]
    }
    if (!found) continue
    if (node && typeof node === 'object' && 'supported' in node) return node.supported === true
    if (typeof node === 'boolean') return node
  }
  return UNKNOWN
}

// Where each vocabulary key lives in the capability tree. Several spellings are tried per key
// because the tree is provider-owned and versioned independently of us; a key none of these
// match resolves to UNKNOWN (-> tier 3 probe), which is the designed fallback, not a failure.
export const CAPABILITY_TREE_PATHS = {
  vision: ['image_input'],
  documents: ['document_input', 'pdf_input'],
  effort: ['effort'],
  'web.search': ['web_search', 'web_search_tool', 'tools.web_search', 'server_tools.web_search'],
  'web.fetch': ['web_fetch', 'web_fetch_tool', 'tools.web_fetch', 'server_tools.web_fetch']
}

/**
 * The capability tree for one model, off the shared (1-hour) model cache. Never throws and
 * never blocks a request: if the list is unreachable we return null and every caller falls
 * back to its own guess, exactly as before this existed.
 */
const modelCapabilityTree = async (client, modelId) => {
  try {
    return capabilityTreeFor(await getAvailableModels(client), modelId)
  } catch (e) {
    console.warn('[freezr anthropic] could not read the model capability tree:', e.message)
    return null
  }
}

/**
 * Condense one model's provider tree into freezr's vocabulary, for the ping model list.
 * Compact on purpose: the raw tree is large and a ping carries every model, so we publish
 * the handful of keys apps actually branch on rather than the whole thing.
 */
export const summarizeModelCapabilities = (tree) => {
  if (!tree) return null
  const out = {}
  for (const [key, paths] of Object.entries(CAPABILITY_TREE_PATHS)) {
    const leaf = readCapabilityLeaf(tree, paths)
    if (leaf === UNKNOWN) continue // say nothing rather than guess
    if (key.startsWith('web.')) {
      out.web = out.web || {}
      out.web[key.slice(4)] = leaf
    } else {
      out[key] = leaf
    }
  }
  return Object.keys(out).length ? out : null
}

/**
 * What this provider can do for a given model. See the three-tier note in
 * features/apps/services/llmCapabilityService.mjs — the short version is that tier 1 is
 * hardcoded about OUR code, tier 2 is read live from the provider, and tier 3 is learned by
 * trying. Nowhere is a model id string-matched against a hand-written feature list.
 *
 * Never throws: a models.list() failure degrades every uncertain key to UNKNOWN, which means
 * "try it" — a transient API blip must not look like a capability being withdrawn.
 *
 * @returns {Promise<Object>} capability map, values true | false | 'unknown' | detail object
 */
export const getCapabilities = async ({ apiKey, model } = {}) => {
  const resolved = { ...CAPABILITIES }
  if (!apiKey) return resolved

  let tree = null
  try {
    const client = new Anthropic({ apiKey })
    tree = capabilityTreeFor(await getAvailableModels(client), model)
  } catch (e) {
    console.warn('[freezr anthropic] could not read model capabilities, treating as unknown:', e.message)
  }

  const web = {}
  for (const half of ['search', 'fetch']) {
    if (CAPABILITIES.web[half] !== true) { web[half] = false; continue } // tier 1 says we don't wire it
    const memo = readProbeMemo(model, 'web.' + half)
    if (memo !== undefined) { web[half] = memo; continue } // tier 3, already learned
    web[half] = tree
      ? readCapabilityLeaf(tree, CAPABILITY_TREE_PATHS['web.' + half])
      : UNKNOWN
  }
  resolved.web = web

  for (const key of ['vision', 'documents', 'effort']) {
    if (CAPABILITIES[key] === false) continue
    const memo = readProbeMemo(model, key)
    if (memo !== undefined) { resolved[key] = memo; continue }
    if (tree) {
      const leaf = readCapabilityLeaf(tree, CAPABILITY_TREE_PATHS[key] || [])
      if (leaf !== UNKNOWN) resolved[key] = leaf
      else if (model) resolved[key] = UNKNOWN
    } else if (model) {
      resolved[key] = UNKNOWN
    }
  }

  return resolved
}

export const getLatestModelForFamily = async ({ apiKey, family }) => {
  const shorthand = (family || DEFAULT_FAMILY).toLowerCase()
  const client = new Anthropic({ apiKey })
  try {
    const models = await getAvailableModels(client)
    const matching = models
      .filter(m => m.id.includes(shorthand))
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    if (matching.length > 0) return matching[0].id
  } catch (e) {
    console.warn('Could not fetch Anthropic models for family lookup:', e.message)
  }
  return 'claude-sonnet-4-20250514'
}

export const listModels = async ({ apiKey }) => {
  const client = new Anthropic({ apiKey })
  const models = await getAvailableModels(client)
  const list = models
    // `capabilities` is the provider's own per-model feature tree (tier 2). It was previously
    // dropped here, which is why per-model capability used to look like it needed a table.
    .map(m => ({ ...parseModelId(m.id), created_at: m.created_at, capabilities: summarizeModelCapabilities(m.capabilities) }))
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
  return markLatestPerFamily(list)
}

const makePricingPromptWithModels = (modelIds) => {
  const modelList = modelIds.map(id => `"${id}"`).join(', ')
  return `You are a helpful assistant that provides current Anthropic Claude API pricing information.
Here are the model IDs I need pricing for: ${modelList}

IMPORTANT: Different model generations have VERY different prices even if they share the same base name.
For example, claude-3-haiku costs $0.25/$1.25, but claude-haiku-4-5 costs $1/$5 per million tokens.
Do NOT assume models with similar names have the same price. Look up each model individually.

Return ONLY a valid JSON object (no markdown, no explanation) with per-million-token pricing in USD.
The format must be exactly:
{
  "models": {
    "<model-id>": { "input": <price_per_million_input_tokens>, "output": <price_per_million_output_tokens> },
    ...
  }
}
Use the exact model ID strings I provided as keys.
If you are unsure of the exact price for a model, provide your best estimate based on the specific generation and tier.
Never use 0 as a placeholder price unless the model is genuinely free.`
}

const makeSingleModelPricingPrompt = (modelId) => {
  return `You are a helpful assistant that provides current Anthropic Claude API pricing information.
Return ONLY a valid JSON object (no markdown, no explanation) with the per-million-token pricing in USD for model "${modelId}".
The format must be exactly:
{ "input": <price_per_million_input_tokens>, "output": <price_per_million_output_tokens> }
IMPORTANT: Different model generations have very different prices. Do NOT confuse older models with newer ones.
If you are unsure of the exact price for "${modelId}", provide your best estimate based on its specific generation and tier.
Never return 0 unless the model is genuinely free.`
}

// OFFICIAL first-party prices, USD per MILLION tokens, keyed by canonical model prefix (longest
// prefix wins). Asking a model what it costs — the previous only source — produced confidently
// wrong answers: every current Opus model self-reported at the OLD Opus 3/4.1 rate ($15/$75),
// tripling every cost figure shown to users while their provider billed $5/$25. Models know their
// own prices no better than they know today's date. The self-report path below survives ONLY as a
// fallback for model ids this table has never heard of, and is labelled as such.
// cachedInput = the 5-minute cache-read rate (10% of input); the write premium is applied by the
// pricing consumer. Update this table when Anthropic changes prices — it is a fact, not a guess.
const OFFICIAL_PRICES = {
  'claude-fable-5': { input: 10, output: 50, cachedInput: 1 },
  'claude-opus-5': { input: 5, output: 25, cachedInput: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cachedInput: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cachedInput: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cachedInput: 0.5 },
  'claude-opus-4-5': { input: 5, output: 25, cachedInput: 0.5 },
  'claude-opus-4-1': { input: 15, output: 75, cachedInput: 1.5 },
  'claude-opus-4': { input: 15, output: 75, cachedInput: 1.5 },
  'claude-opus-3': { input: 15, output: 75, cachedInput: 1.5 },
  // introductory rate through 2026-08-31, standard from September — resolved at lookup time so a
  // refresh on either side of the boundary stores the rate that is actually being charged
  'claude-sonnet-5': () => (Date.now() < Date.UTC(2026, 8, 1)
    ? { input: 2, output: 10, cachedInput: 0.2 }
    : { input: 3, output: 15, cachedInput: 0.3 }),
  'claude-sonnet-4-6': { input: 3, output: 15, cachedInput: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, cachedInput: 0.3 },
  'claude-sonnet-4': { input: 3, output: 15, cachedInput: 0.3 },
  'claude-3-7-sonnet': { input: 3, output: 15, cachedInput: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cachedInput: 0.1 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cachedInput: 0.08 },
  'claude-3-haiku': { input: 0.25, output: 1.25, cachedInput: 0.03 }
}

// Server-tool rates. These are PROVIDER-level, not per-model, and are billed per request
// rather than per token — web search at $10 per 1,000 searches, web fetch unmetered. Attached
// to every price lookup so a stale self-reported pricing record cannot silently lose them
// (the LLM-self-report path only ever knows about token prices).
const SERVER_TOOL_PRICES = {
  webSearchPer1000: 10,
  webFetchPer1000: 0
}

/**
 * Server-tool rates, read straight from the connector at request time.
 *
 * These must NOT be taken from a stored pricing record. They are provider-level constants,
 * but pricing records are per-model and cached for a week — so any record written before
 * these rates existed carries no `webSearchPer1000`, and the cost maths then silently bills
 * searches at ZERO. (Observed exactly that: 6 searches, otherCost 0.) Reading them from the
 * connector makes a stale record harmless.
 */
export const getServerToolPrices = () => ({ ...SERVER_TOOL_PRICES })
const officialPriceFor = (modelId) => {
  const id = String(modelId || '').toLowerCase()
  let best = null
  for (const [prefix, price] of Object.entries(OFFICIAL_PRICES)) {
    if (id.startsWith(prefix) && (!best || prefix.length > best[0].length)) best = [prefix, price]
  }
  if (!best) return null
  const price = typeof best[1] === 'function' ? best[1]() : best[1]
  return { ...price, ...SERVER_TOOL_PRICES }
}

export const getPricing = async ({ apiKey, targetModel = null }) => {
  let modelIds = []
  try {
    modelIds = (await listModels({ apiKey })).map(m => m.id)
  } catch (e) {
    console.warn('Could not fetch Anthropic models for pricing:', e.message)
  }

  // the official table answers first — the LLM round-trip is only for ids it has never heard of
  const ids = targetModel ? [targetModel] : modelIds
  const official = {}
  const unknown = []
  for (const id of ids) {
    const price = officialPriceFor(id)
    if (price) official[id] = { ...price }
    else unknown.push(id)
  }
  if (ids.length && !unknown.length) {
    return { models: official, source: 'official_builtin', sourceModel: null }
  }

  const prompt = targetModel
    ? makeSingleModelPricingPrompt(targetModel)
    : makePricingPromptWithModels(unknown.length > 0
      ? unknown
      : ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-haiku-3-5-20241022'])

  const llmResult = await ask({
    apiKey,
    prompt,
    context: 'You are a pricing data assistant. Return only valid JSON.',
    model: 'sonnet',
    max_tokens: 4096,
    responseType: 'json'
  })

  let parsed = null
  if (typeof llmResult.response === 'string') {
    try { parsed = JSON.parse(llmResult.response) } catch (e) {
      console.warn('Anthropic getPricing: could not parse LLM response as JSON:', e.message)
      return null
    }
  } else {
    parsed = llmResult.response
  }

  let models = null
  if (targetModel && parsed) {
    if (parsed.input !== undefined && parsed.output !== undefined) {
      models = { [targetModel]: { input: parsed.input, output: parsed.output } }
    } else if (parsed.models && parsed.models[targetModel]) {
      models = parsed.models
    }
  } else if (parsed && parsed.models) {
    models = parsed.models
  }

  // official facts always win over anything the model said about itself
  const merged = { ...(models || {}), ...official }
  // Server-tool rates are provider-level and the self-report prompt only ever asks about
  // token prices, so stamp them onto every entry — otherwise a model priced by self-report
  // would silently bill web searches at zero.
  for (const id of Object.keys(merged)) {
    merged[id] = { ...SERVER_TOOL_PRICES, ...merged[id] }
  }
  return Object.keys(merged).length
    ? { models: merged, source: Object.keys(official).length ? 'official_builtin+llm_self_report' : 'llm_self_report', sourceModel: llmResult.model }
    : null
}

// Several helpers below are exported purely so the unit tests can drive them with a fake
// client (they take `client` as a parameter for exactly that reason). Not part of the
// connector contract — the controller calls ask/askStream/getCapabilities only.
// ── Web access (server tools) ────────────────────────────────────────────────────────────
//
// These run on Anthropic's side: we declare them and the results come back as content blocks
// in the same response. There is no client-side execution loop.

// Newest first. The older pair is the fallback for models that reject the current one — which
// model wants which is decided by TRYING (tier 3), never by matching on the model id.
const WEB_TOOL_VARIANTS = [
  { search: 'web_search_20260209', fetch: 'web_fetch_20260209' },
  { search: 'web_search_20250305', fetch: 'web_fetch_20250910' }
]

/**
 * Translate freezr's normalized `web` option into Anthropic tool definitions.
 * Deliberately does NOT also declare code_execution: the _20260209 tools run it internally
 * for dynamic filtering, and a second execution environment confuses the model.
 */
export const buildWebTools = (web, variantIndex = 0) => {
  if (!web) return null
  // The deliberately non-portable escape hatch: when a caller passes raw.anthropic they get
  // exactly those tool definitions, unvalidated. Documented as provider-specific — an app
  // using it has opted out of freezr translating anything.
  if (Array.isArray(web.raw?.anthropic)) return web.raw.anthropic.length ? web.raw.anthropic : null
  const variant = WEB_TOOL_VARIANTS[variantIndex] || WEB_TOOL_VARIANTS[WEB_TOOL_VARIANTS.length - 1]
  const tools = []

  const commonOpts = (opts) => {
    const out = {}
    if (!opts || opts === true) return out
    if (opts.maxUses) out.max_uses = opts.maxUses
    // allowed and blocked are mutually exclusive at the API; prefer the allow-list, which is
    // the one that actually constrains where a prompt-injected URL can send data.
    if (Array.isArray(opts.allowedDomains) && opts.allowedDomains.length) out.allowed_domains = opts.allowedDomains
    else if (Array.isArray(opts.blockedDomains) && opts.blockedDomains.length) out.blocked_domains = opts.blockedDomains
    return out
  }

  if (web.search) {
    const opts = commonOpts(web.search)
    if (web.search !== true && web.search.userLocation) opts.user_location = web.search.userLocation
    tools.push({ type: variant.search, name: 'web_search', ...opts })
  }
  if (web.fetch) {
    const opts = commonOpts(web.fetch)
    if (web.fetch !== true && web.fetch.maxContentTokens) opts.max_content_tokens = web.fetch.maxContentTokens
    // Citations on by default: an app showing a web-derived answer needs to show its sources,
    // and the fetched-URL list is the audit trail for what left the conversation.
    opts.citations = { enabled: web.fetch === true ? true : (web.fetch.citations !== false) }
    tools.push({ type: variant.fetch, name: 'web_fetch', ...opts })
  }
  return tools.length ? tools : null
}

/** Does this error mean "this model won't take that tool version"? Drives the tier-3 ladder. */
export const isWebToolRejection = (err) => {
  const msg = ((err && (err.message || String(err))) || '').toLowerCase()
  return msg.includes('web_search') || msg.includes('web_fetch') ||
    (msg.includes('tool') && (msg.includes('not supported') || msg.includes('unsupported') || msg.includes('invalid')))
}

/**
 * Accumulates everything the web tools produced, for both the streaming and non-streaming
 * paths. Server-tool errors DO NOT throw — they arrive as a normal 200 with the result
 * block's `content` being an error OBJECT where success is an ARRAY, so every read branches
 * on that before indexing.
 */
export const makeWebCollector = () => {
  const searchQueries = []
  const sources = []
  const fetchedUrls = []
  const errors = []
  const citations = []
  const limitReached = {}
  let searchRequests = 0
  let fetchRequests = 0

  const noteToolUse = (block) => {
    if (block?.name === 'web_search') searchRequests++
    else if (block?.name === 'web_fetch') fetchRequests++
  }

  const noteResult = (block) => {
    const tool = block?.type === 'web_search_tool_result' ? 'web_search' : 'web_fetch'
    const content = block?.content
    if (content && !Array.isArray(content) && content.error_code) {
      errors.push({ tool, code: content.error_code })
      // Hitting the caller's own maxUses is categorically different from a page being
      // unreachable: it means the ANSWER IS SHALLOWER THAN IT COULD BE, and the caller can
      // do something about it (re-ask with a higher cap). Normalising it here means an app
      // checks one freezr-level flag instead of string-matching a provider error code.
      if (content.error_code === 'max_uses_exceeded') limitReached[tool] = true
      return { tool, status: 'error', code: content.error_code }
    }
    if (tool === 'web_search' && Array.isArray(content)) {
      for (const r of content) {
        if (r?.url) sources.push({ url: r.url, title: r.title || null })
      }
      return { tool, status: 'result', results: content.length }
    }
    if (tool === 'web_fetch') {
      const url = content?.url || block?.url
      if (url) fetchedUrls.push(url)
      return { tool, status: 'result', url: url || null }
    }
    return { tool, status: 'result' }
  }

  const noteCitation = (citation) => {
    if (!citation) return
    citations.push({
      url: citation.url || null,
      title: citation.title || citation.document_title || null,
      citedText: citation.cited_text || null
    })
  }

  // The query's location is not guaranteed: the dynamic-filtering tool can express a search
  // differently from the basic one. Take what is there rather than insisting on `.query`.
  const noteQuery = (input) => {
    if (!input) return
    if (typeof input === 'string') { searchQueries.push(input); return }
    if (typeof input.query === 'string') { searchQueries.push(input.query); return }
    if (Array.isArray(input.queries)) {
      for (const q of input.queries) if (typeof q === 'string') searchQueries.push(q)
    }
  }

  const summary = () => {
    if (!searchRequests && !fetchRequests && !errors.length) return null
    const out = {}
    if (searchRequests) out.webSearch = { requests: searchRequests, queries: searchQueries, sources }
    if (fetchRequests) out.webFetch = { requests: fetchRequests, urls: fetchedUrls }
    if (errors.length) out.errors = errors
    // The answer was cut short by a cap the CALLER set — surfaced separately from `errors`
    // so an app can offer "search more" without parsing provider error codes.
    if (Object.keys(limitReached).length) {
      out.limitReached = {
        search: limitReached.web_search === true,
        fetch: limitReached.web_fetch === true
      }
    }
    return out
  }

  return { noteToolUse, noteResult, noteCitation, noteQuery, summary, citations: () => citations }
}

/**
 * Rebuild the assistant's content blocks from a stream. Needed for pause_turn: resuming
 * means re-sending the assistant turn EXACTLY as it came back (with no added user message —
 * the API sees the trailing server_tool_use block and knows to continue).
 */
export const makeBlockRebuilder = () => {
  const blocks = []
  return {
    start (index, contentBlock) {
      blocks[index] = JSON.parse(JSON.stringify(contentBlock || {}))
      if (blocks[index].type === 'server_tool_use') blocks[index]._partialJson = ''
    },
    delta (index, delta) {
      const b = blocks[index]
      if (!b || !delta) return
      if (delta.type === 'text_delta') b.text = (b.text || '') + delta.text
      else if (delta.type === 'thinking_delta') b.thinking = (b.thinking || '') + delta.thinking
      else if (delta.type === 'signature_delta') b.signature = delta.signature
      else if (delta.type === 'input_json_delta') b._partialJson = (b._partialJson || '') + delta.partial_json
      else if (delta.type === 'citations_delta') (b.citations = b.citations || []).push(delta.citation)
    },
    stop (index) {
      const b = blocks[index]
      if (!b) return null
      // Only overwrite `input` when deltas actually streamed one. A tool input can arrive
      // WHOLE on content_block_start (observed with the dynamic-filtering web tools), and
      // blanking it to {} then loses the query — and, worse, corrupts a pause_turn resume,
      // which re-sends this very block back to the API.
      if (b._partialJson) {
        try { b.input = JSON.parse(b._partialJson) } catch (e) { b.input = b.input || {} }
      }
      delete b._partialJson
      return b
    },
    all () { return blocks.filter(Boolean) }
  }
}

// The server-side tool loop pauses at 10 iterations with stop_reason 'pause_turn'. Resuming is
// cheap and expected, but it is still the model spending the caller's money, so cap it.
const MAX_PAUSE_TURN_RESUMES = 3

export const streamAndCollect = async (client, params, { web = null, onEvent = null } = {}) => {
  const collector = makeWebCollector()
  let textResponse = ''
  let thinkingResponse = ''
  let usage = null
  let stopReason = null
  let resumes = 0
  // Only mutated on a pause_turn resume; the caller's params are otherwise left alone.
  let messages = params.messages

  while (true) {
    const rebuilder = makeBlockRebuilder()
    const stream = await client.messages.create({ ...params, messages })
    stopReason = null

    for await (const chunk of stream) {
      if (chunk.type === 'message_start' && chunk.message?.usage) {
        // input_tokens and the cache_*_input_tokens counts arrive HERE, not on message_delta.
        usage = mergeUsage(usage, chunk.message.usage)
      } else if (chunk.type === 'content_block_start') {
        rebuilder.start(chunk.index, chunk.content_block)
        const block = chunk.content_block
        if (block?.type === 'server_tool_use') {
          collector.noteToolUse(block)
          if (onEvent) onEvent({ type: 'tool', tool: block.name, status: 'started' })
        } else if (block?.type === 'web_search_tool_result' || block?.type === 'web_fetch_tool_result') {
          // The result arrives whole on the block start, not via deltas.
          const evt = collector.noteResult(block)
          if (onEvent && evt) onEvent({ type: 'tool', ...evt })
        }
      } else if (chunk.type === 'content_block_delta') {
        rebuilder.delta(chunk.index, chunk.delta)
        if (chunk.delta.type === 'thinking_delta') {
          thinkingResponse += chunk.delta.thinking
          if (onEvent) onEvent({ type: 'thinking', text: chunk.delta.thinking })
        } else if (chunk.delta.type === 'text_delta') {
          textResponse += chunk.delta.text
          if (onEvent) onEvent({ type: 'delta', text: chunk.delta.text })
        } else if (chunk.delta.type === 'citations_delta') {
          collector.noteCitation(chunk.delta.citation)
        }
      } else if (chunk.type === 'content_block_stop') {
        const block = rebuilder.stop(chunk.index)
        // The search query is only complete once its input JSON has finished streaming.
        if (block?.type === 'server_tool_use' && block.name === 'web_search') {
          collector.noteQuery(block.input)
          if (onEvent && block.input?.query) {
            onEvent({ type: 'tool', tool: 'web_search', status: 'searching', query: block.input.query })
          }
        }
      } else if (chunk.type === 'message_delta') {
        // stop_reason lives on delta, NOT usage — and it is the only trustworthy
        // signal that the answer was cut off ('max_tokens') rather than finished
        // ('end_turn'). Callers were previously left guessing from token counts.
        if (chunk.delta?.stop_reason) stopReason = chunk.delta.stop_reason
        if (chunk.usage) usage = mergeUsage(usage, chunk.usage)
      }
    }

    if (stopReason !== 'pause_turn') break
    if (resumes >= MAX_PAUSE_TURN_RESUMES) {
      console.warn('[freezr anthropic] the server tool loop paused ' + (resumes + 1) + ' times and hit freezr\'s resume cap' +
        ' — returning a PARTIAL answer with stopReason pause_turn')
      break
    }
    // Resume by re-sending the assistant turn EXACTLY as it arrived, with NO extra user
    // message: the API detects the trailing server_tool_use block and continues by itself.
    // Adding a 'Continue.' turn here would corrupt the resume.
    messages = [...messages, { role: 'assistant', content: rebuilder.all() }]
    resumes++
  }

  return {
    textResponse,
    thinkingResponse,
    usage,
    stopReason,
    toolsUsed: collector.summary(),
    citations: collector.citations(),
    pauseResumes: resumes
  }
}

/**
 * The one degrade ladder, shared by ask() and askStream() so the two paths cannot drift.
 *
 * Every rejection handled here happens on create(), BEFORE any token streams, so a retry
 * costs nothing and never double-bills. That property is what lets freezr discover per-model
 * support by trying instead of maintaining a table of which model takes which feature.
 *
 * Verdicts are memoized via rememberProbe so the same rejection is paid once an hour.
 */
export const runWithDegrades = async (client, params, { web = null, model = null, onEvent = null } = {}) => {
  let webVariant = 0
  let webDropped = false

  while (true) {
    try {
      const collected = await streamAndCollect(client, params, { web, onEvent })
      if (params.tools && !webDropped) {
        // It worked — record it so the next request skips straight to this variant.
        if (web?.search) rememberProbe(model, 'web.search', true)
        if (web?.fetch) rememberProbe(model, 'web.fetch', true)
      }
      return { ...collected, webDropped }
    } catch (err) {
      const emsg = ((err && (err.message || String(err))) || '').toLowerCase()

      if (params.tools && isWebToolRejection(err)) {
        // TIER 3, step 1: this model may just want the older tool version.
        if (webVariant + 1 < WEB_TOOL_VARIANTS.length) {
          webVariant++
          console.warn('[freezr anthropic] ' + params.model + ' rejected web tool version ' +
            WEB_TOOL_VARIANTS[webVariant - 1].search + ' — retrying with ' + WEB_TOOL_VARIANTS[webVariant].search)
          params.tools = buildWebTools(web, webVariant)
          continue
        }
        // TIER 3, step 2: no variant works — this model genuinely cannot reach the web.
        if (web?.search) rememberProbe(model, 'web.search', false)
        if (web?.fetch) rememberProbe(model, 'web.fetch', false)
        if (web?.optional) {
          console.warn('[freezr anthropic] ' + params.model + ' cannot use the web tools — continuing WITHOUT them (the caller passed optional)')
          delete params.tools
          webDropped = true
          continue
        }
        const capErr = new Error(params.model + ' cannot reach the web')
        capErr.code = 'capability_unsupported_on_model'
        capErr.capability = 'web'
        capErr.model = params.model
        throw capErr
      }

      if (params.output_config && (emsg.includes('output_config') || emsg.includes('effort'))) {
        console.warn('[freezr anthropic] the API rejected output_config ' + JSON.stringify(params.output_config) +
          ' for ' + params.model + ' — retrying without it')
        rememberProbe(model, 'effort', false)
        delete params.output_config
        continue
      }

      if (params.thinking && params.thinking.type === 'enabled' && emsg.includes('adaptive')) {
        // The API's own correction: this model wants adaptive, not enabled+budget. Obey it — the
        // caller asked for thinking and stripping the param would still deliver thinking (default),
        // but uncapped and unlabelled; adaptive is what they meant.
        console.warn('[freezr anthropic] ' + params.model + ' rejected the legacy thinking shape — retrying as { type: adaptive } per the API error')
        params.thinking = { type: 'adaptive' }
        delete params.temperature
        continue
      }

      if (params.thinking && emsg.includes('thinking')) {
        // LOUD, because this retry is where a caller's intent can silently invert: on models that
        // think BY DEFAULT, stripping a {type:'disabled'} config re-enables thinking at full cost.
        console.warn('[freezr anthropic] the API rejected thinking config ' + JSON.stringify(params.thinking) +
          ' for ' + params.model + ' (' + (err && err.message) + ') — retrying WITHOUT it. ' +
          (params.thinking.type === 'disabled'
            ? 'NOTE: this model thinks by default, so the caller asked for NO thinking and will now get DEFAULT thinking.'
            : ''))
        delete params.thinking
        delete params.temperature
        continue
      }

      throw err
    }
  }
}

/**
 * Bridge runWithDegrades' onEvent callback into an async generator, so askStream() can share
 * the exact collection logic ask() uses rather than re-implementing the stream loop (which is
 * how the two would drift — and the streaming path is the one the controller actually takes).
 */
async function * streamWithDegrades (client, params, opts) {
  const queue = []
  let wake = null
  let finished = false
  let failure = null
  let collected = null

  const wakeUp = () => { if (wake) { const w = wake; wake = null; w() } }
  const running = runWithDegrades(client, params, { ...opts, onEvent: (e) => { queue.push(e); wakeUp() } })
    .then(r => { collected = r }, e => { failure = e })
    .finally(() => { finished = true; wakeUp() })

  while (true) {
    while (queue.length) yield queue.shift()
    if (finished) break
    await new Promise(resolve => { wake = resolve })
  }
  await running
  if (failure) throw failure
  return collected
}

/**
 * Streaming variant of ask(). Returns an async generator that yields chunk objects:
 *   { type: 'delta', text }     – incremental text content
 *   { type: 'thinking', text }  – incremental thinking content
 *   { type: 'tool', tool, status, query?, results?, url? } – server-tool progress (web access)
 *   { type: 'done', response, thinking, provider, model, family, rawUsage, tokensUsed }
 *
 * Same params as ask() except responseType is ignored (raw text is always yielded).
 */
export async function * askStream ({ apiKey, prompt, context, model, max_tokens, role, thinking, cache, effort, files, web }) {
  const client = new Anthropic({ apiKey })
  const modelToUse = await resolveModel(client, model)
  const maxTokens = max_tokens || DEFAULT_MAX_TOKENS

  let messages
  if (Array.isArray(prompt)) {
    messages = prompt
  } else {
    messages = [{ role: role || 'user', content: prompt || '' }]
  }
  const callerPlaced = hasCallerCacheMarkers(messages) // before file injection (see applyCacheControl)

  if (files && files.length > 0) {
    const lastUserIdx = findLastIndex(messages, m => m.role === 'user')
    if (lastUserIdx >= 0) {
      const msg = messages[lastUserIdx]
      const existingContent = typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : (Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content) }])
      const fileBlocks = files.map(f => {
        const mime = mimeFromFilename(f.originalname)
        const isImage = mime.startsWith('image/')
        return {
          type: isImage ? 'image' : 'document',
          source: { type: 'base64', media_type: mime, data: f.buffer.toString('base64') },
          ...(isImage ? {} : { cache_control: { type: 'ephemeral' } })
        }
      })
      messages[lastUserIdx] = { role: 'user', content: [...fileBlocks, ...existingContent] }
    }
  }

  const params = { model: modelToUse, max_tokens: maxTokens, stream: true, messages }
  if (context) params.system = context
  applyCacheControl(params, cache, { callerPlaced })
  if (effort) params.output_config = { effort: String(effort) }

  const webOption = normalizeWebOption(web)
  const webTools = buildWebTools(webOption)
  if (webTools) params.tools = webTools

  // The provider's own answer on which thinking shape this model takes, so we do not have to
  // infer it from the model's name.
  const modelTree = await modelCapabilityTree(client, modelToUse)
  const thinkingConfig = buildThinkingConfig(modelToUse, thinking, maxTokens, modelTree)
  if (thinkingConfig) {
    params.thinking = thinkingConfig
    if (thinkingConfig.type === 'enabled') params.temperature = 1
  }

  // The stream loop, the degrade ladder and the web-tool collection all live in
  // runWithDegrades/streamAndCollect, shared with ask(). Duplicating them here is how the
  // streaming and non-streaming paths would drift — and streaming is the path the controller
  // actually takes, so a web feature that only worked in ask() would look like it worked.
  const collected = yield * streamWithDegrades(client, params, { web: webOption, model: modelToUse })

  const { textResponse, thinkingResponse, usage, stopReason, toolsUsed, citations, webDropped } = collected

  if (stopReason === 'pause_turn') {
    console.warn('[freezr anthropic] streamed answer stopped at a paused server-tool turn — the caller is getting a PARTIAL answer')
  }
  if (stopReason === 'max_tokens') {
    console.warn('[freezr anthropic] streamed answer hit the max_tokens ceiling (' + maxTokens +
      ') and was CUT OFF — the caller is getting a partial answer')
  }

  yield {
    type: 'done',
    response: textResponse,
    thinking: thinkingResponse || null,
    provider: 'Claude',
    model: modelToUse,
    family: getFamilyFromModelId(modelToUse),
    // 'max_tokens' means the answer was truncated; 'end_turn' means it finished.
    stopReason: stopReason || null,
    maxTokens,
    toolsUsed: toolsUsed || null,
    citations: (citations && citations.length) ? citations : null,
    unavailable: webDropped ? ['web'] : [],
    rawUsage: usage,
    tokensUsed: standardizeUsage(usage, toolsUsed)
  }
}

/**
 * Generate an image as SVG using Claude's text API.
 * Claude cannot generate raster images, but can produce SVG markup.
 * The server endpoint can convert SVG to PNG via sharp if needed.
 * Uses the same model resolution as ask() — respects user's preferred model.
 * @param {Object} params
 * @param {string} params.apiKey - Anthropic API key
 * @param {string} params.prompt - Text description of the image to generate
 * @param {string} [params.model] - Model shorthand or full ID (defaults to ask() default)
 * @returns {Promise<Object>} { format, svgData, revisedPrompt, provider, model, tokensUsed, family }
 */
export const generateImage = async ({ apiKey, prompt, model }) => {
  const svgPrompt = 'Generate an SVG image for the following request: ' + prompt +
    '\n\nReturn ONLY the raw SVG markup starting with <svg and ending with </svg>. ' +
    'No markdown, no explanation, no code fences. Use a viewBox of "0 0 512 512". ' +
    'Make the design clean, modern, and visually appealing.'

  const result = await ask({
    apiKey,
    prompt: svgPrompt,
    context: 'You are a skilled SVG artist and graphic designer. Return only valid SVG markup, nothing else.',
    model: model || undefined,
    max_tokens: 8192
  })

  let svg = result.response || ''
  const svgMatch = svg.match(/<svg[\s\S]*<\/svg>/)
  if (svgMatch) svg = svgMatch[0]
  if (!svg.startsWith('<svg')) {
    throw new Error('Claude did not return valid SVG markup.')
  }

  return {
    format: 'svg',
    svgData: svg,
    revisedPrompt: null,
    provider: 'Claude',
    model: result.model,
    rawUsage: result.rawUsage,
    tokensUsed: result.tokensUsed,
    family: result.family
  }
}

/**
 * Parse JSON from an LLM text response.
 * Tries: raw parse -> ```json block -> ``` block -> returns raw text on failure.
 */
const parseJsonResponse = (text) => {
  if (!text) return text
  // Try direct parse
  try { return JSON.parse(text) } catch (e) { /* continue */ }

  // Try extracting from code fences
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()) } catch (e) { /* continue */ }
  }

  // Try finding the first { ... } or [ ... ] block
  const braceStart = text.indexOf('{')
  const bracketStart = text.indexOf('[')
  const start = (braceStart >= 0 && (bracketStart < 0 || braceStart < bracketStart)) ? braceStart : bracketStart
  if (start >= 0) {
    const closer = text[start] === '{' ? '}' : ']'
    const end = text.lastIndexOf(closer)
    if (end > start) {
      try { return JSON.parse(text.slice(start, end + 1)) } catch (e) { /* continue */ }
    }
  }

  return text
}

const findLastIndex = (arr, predicate) => {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) return i
  }
  return -1
}

const mimeFromFilename = (name) => {
  if (!name) return 'application/octet-stream'
  const ext = name.split('.').pop().toLowerCase()
  const map = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    txt: 'text/plain',
    csv: 'text/csv'
  }
  return map[ext] || 'application/octet-stream'
}
