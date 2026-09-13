// freezr.info - OpenAI LLM Connector
// Adapter to translate freezr's standard LLM format into OpenAI API calls.
//
// Connector contract for any provider adapter:
// - `listModels({ apiKey })` -> [{ id, family, provider, version, ... }]
// - `parseModelId(id)` -> { id, family, provider, version }
// - `getPricing({ apiKey, targetModel? })` -> { models, source, sourceModel } | null
// - `ask({ apiKey, prompt, context, model, max_tokens, role, responseType, thinking, files })`
//      -> { response, thinking, provider, model, family, stopReason, maxTokens, rawUsage, tokensUsed }
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
// `{ success, exists, defaultProvider, defaultFamily, providers, imageProviders, pricingMeta }`
//
// THIS ADAPTER RUNS ON THE RESPONSES API (`client.responses.create`), not Chat Completions.
// The difference is not cosmetic, and it is why web access and reasoning text arrive together:
//
//   Chat Completions          one message in, one message out
//   Responses                 a list of typed ITEMS in, a list of typed ITEMS out
//
// A server-side tool run is simply more items in the output array (`web_search_call` beside
// `message` and `reasoning`), which is structurally the same as Anthropic's content-block
// stream — so the two connectors in this directory can stay siblings instead of diverging.
// The field-by-field mapping, for anyone reading a Chat Completions example and wondering
// why nothing lines up:
//
//   messages[]                 -> input[]  (+ `instructions` for the system prompt)
//   max_completion_tokens      -> max_output_tokens
//   reasoning_effort: 'high'   -> reasoning: { effort: 'high', summary: 'auto' }
//   (no web tool at all)       -> tools: [{ type: 'web_search', ... }]
//   choices[0].message.content -> output[] items, streamed as ~50 NAMED events
//   finish_reason: 'length'    -> status 'incomplete' + incomplete_details.reason
//   prompt_tokens/completion_  -> input_tokens/output_tokens (same meaning, renamed)
//
// Chat Completions survives ONLY as the last rung of the degrade ladder (see runWithDegrades),
// for a model or an OpenAI-compatible endpoint that rejects /v1/responses.
//
// `store: false` IS SET ON EVERY REQUEST AND MUST STAY THAT WAY. The Responses API defaults
// `store` to TRUE, which means OpenAI retains the full request and response for 30 days. That
// is a privacy regression freezr would otherwise have taken on silently when this file moved
// off Chat Completions. It costs nothing here: `store: true` only buys reasoning continuity
// across `previous_response_id` turns, and freezr always sends the whole conversation instead.
//
// TRUNCATION: `stopReason` is normalised to the Anthropic connector's vocabulary, so
// a caller checks `stopReason === 'max_tokens'` once for either provider (OpenAI's
// own word is kept as `rawStopReason`). Note that `max_output_tokens` covers REASONING
// tokens as well as visible output, so a reasoning model can exhaust the budget thinking
// and return an EMPTY answer with status 'incomplete'.
//
// WEB ACCESS: one tool, not two. OpenAI's `web_search` searches, opens pages AND searches
// within them — `search`, `open_page` and `find_in_page` are ACTIONS of a single tool, where
// Anthropic has two separately declarable tools. So freezr's `web.search` and `web.fetch`
// both map onto the same declaration here (which is what makes the common `web: true` call
// work identically on both providers), and fetch-ONLY is not achievable. It also has no
// `max_uses`, no `blocked_domains` and no `max_content_tokens` — only `allowed_domains`,
// `user_location` and a `search_context_size` dial. Anything a caller asked for that cannot
// be honoured is NAMED BACK to them in `unavailable` (see webUnavailableOptions) rather than
// silently dropped: an app using `maxUses: 3` as a spend cap has no cap here, and needs to
// find that out from the response instead of from its bill.

import OpenAI from 'openai'
import { UNKNOWN, normalizeWebOption } from '../../common/helpers/llmCapabilities.mjs'

export const DEFAULT_FAMILY = 'gpt-5.5'

/** Every model reachable with an OpenAI key is run by OpenAI. See connector contract above. */
export const getVendorForModel = (_modelId) => 'openai'

const DEFAULT_MODEL = 'gpt-5.4-mini'
const DEFAULT_REASONING_MODEL = 'gpt-5.5'
const DEFAULT_REASONING_MODEL_PREFERENCES = ['gpt-5.5', 'gpt-5.4-mini','gpt-5.4', 'gpt-5.3', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'o3', 'o4-mini', 'o3-mini']
const MODEL_CACHE_TTL = 5 * 60 * 1000
const OPENAI_PRICING_URL = 'https://developers.openai.com/api/docs/pricing'
let cachedModels = null
let cachedModelsTimestamp = 0

/**
 * Send a request to OpenAI
 * @param {Object} params
 * @param {string} params.apiKey - OpenAI API key
 * @param {string|Array} params.prompt - Text prompt or array of { role, content } messages
 * @param {string} [params.context] - System message (LLM instructions/persona)
 * @param {string} [params.model] - Model name (defaults to gpt-5.2)
 * @param {number} [params.max_tokens] - Max tokens for the response
 * @param {string} [params.role] - Default role when prompt is a string (defaults to 'user')
 * @param {string} [params.responseType] - 'json' to auto-parse JSON from response
 * @param {boolean|Object} [params.thinking] - Enable reasoning. true uses default, or { effort: 'low'|'medium'|'high' }. Requires a reasoning-capable model.
 * @param {Object[]} [params.files] - Array of multer file objects (buffer + originalname)
 * @returns {Promise<Object>} { response, thinking, provider, model, usage }
 */
const getAvailableModels = async (client) => {
  const now = Date.now()
  if (cachedModels && (now - cachedModelsTimestamp) < MODEL_CACHE_TTL) {
    return cachedModels
  }
  const response = await client.models.list()
  cachedModels = []
  for await (const model of response) {
    cachedModels.push(model)
  }
  cachedModelsTimestamp = now
  return cachedModels
}

const isKnownChatModelName = (id) => (
  id.startsWith('gpt-') ||
  id.startsWith('o1') ||
  id.startsWith('o3') ||
  id.startsWith('o4') ||
  id.startsWith('chatgpt-')
)

// Models that are not general text models, so they do not belong in the ask() model list.
// NOTE what is deliberately NOT here any more: the `-pro` models (gpt-5-pro, o3-pro) and the
// `deep-research` models used to be excluded because Chat Completions cannot run them. On the
// Responses API they work, so excluding them is now simply wrong — it hid usable models.
// `audio` / `transcri` / `tts` / `whisper` stay excluded from the CHAT list because they are
// the voice models, reachable through transcribe()/speak() and listVoiceModels() instead.
const NON_CHAT_MODEL_MARKERS = [
  'audio',
  'babbage',
  'codex',
  'computer-use',
  'dall-e',
  'davinci',
  'embedding',
  'image',
  'instruct',
  'moderation',
  'realtime',
  'search',
  'transcri',
  'tts',
  'whisper'
]

const isExcludedFromChatCompletions = (id) => (
  NON_CHAT_MODEL_MARKERS.some(marker => id.includes(marker))
)

const isChatModel = (id) => {
  return isKnownChatModelName(id) && !isExcludedFromChatCompletions(id)
}

const isPotentialChatModel = (id) => Boolean(id) && !isExcludedFromChatCompletions(id)

const isImageModel = (id) => id.includes('image')

const VOICE_MODEL_MARKERS = ['transcri', 'tts', 'whisper']

const isVoiceModel = (id) => VOICE_MODEL_MARKERS.some(marker => id.includes(marker))

const isStableModel = (id) => {
  return !id.includes('preview') &&
    !id.includes('beta') &&
    !id.includes('alpha') &&
    !id.includes('experimental') &&
    !id.includes('canary') &&
    !id.includes('test')
}

const normalizeModelId = (id) => {
  return (id || '')
    .toLowerCase()
    .trim()
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-latest$/, '')
}

/**
 * Server-tool rates, read at REQUEST time so a pricing record written before these existed
 * cannot silently bill web searches at zero (see withServerToolPrices in the controller —
 * a stored per-model value still wins).
 *
 * ⚠️ THIS CONSTANT IS ALMOST THE ENTIRE COST OF A WEB CALL HERE, so verify it against
 * OpenAI's pricing page and re-verify when it moves — nothing in this file can detect that
 * it has. Measured on gpt-5.4-mini (2026-09-06): a 2-search call cost $0.0212, of which
 * $0.020 — 94% — was this flat fee and only $0.0012 was tokens. That is the OPPOSITE of
 * Anthropic, where page bodies dominate and searches were ~10% of the bill; the fee is flat
 * per search regardless of model, so the cheaper the model, the more it dominates.
 */
const SERVER_TOOL_PRICES = {
  webSearchPer1000: 10,
  // UNVERIFIED, and possibly moot: OpenAI folds page reading into the search tool, and a live
  // 2-search run produced ZERO open_page actions — so this may never fire. It is set to the
  // search rate rather than to 0 on the reasoning that an under-report is the failure this
  // codebase has already been bitten by (6 searches billed at $0), and a fetch that never
  // happens costs nothing either way. If open_page turns out NOT to be separately billed,
  // this should become 0 — check before assuming.
  webFetchPer1000: 10
}

export const getServerToolPrices = () => ({ ...SERVER_TOOL_PRICES })

/**
 * TIER 1 — what THIS ADAPTER implements. See the three-tier note in
 * common/helpers/llmCapabilities.mjs. A fact about our own code, not about OpenAI's lineup.
 *
 * `web` and `thinking.text` both became true with the move to the Responses API; they were
 * one job, not two, exactly as the old header predicted.
 */
export const CAPABILITIES = {
  // One tool serves both halves — see the WEB ACCESS note in the header. Declaring `fetch`
  // true is honest about what happens (the tool does open pages), not about it being
  // separately requestable; a fetch-ONLY request is reported back as unavailable.
  web: { search: true, fetch: true },
  vision: true,
  documents: true,
  // thinking.text and effort look like the same thing and are narrowed differently on purpose.
  // thinking.text answers "IF this model reasons, will we show you the text?" — true for any
  // model on this transport, because it is a fact about our code asking for reasoning.summary.
  // effort answers "does THIS model accept the reasoning dial at all?" — which only the API
  // can say, so a named model narrows it to 'unknown' and the ladder settles it.
  thinking: { text: true }, // reasoning.summary — the summary text, never the raw chain
  effort: true, // reasoning.effort
  cache: { automatic: true }, // OpenAI caches on its own; nothing for a caller to set
  images: { generate: 'raster' },
  // The first capability where ChatGPT can and Claude cannot. See transcribe() / speak().
  voice: { stt: true, tts: true }
}

// TIER 3 memo: verdicts LEARNED by trying, written by the degrade ladder in runWithDegrades.
// Shares the model cache's TTL so a provider-side change is picked up within the window, and
// evaporates on restart rather than hardening into the per-model table this design exists to
// avoid. Same shape as the Anthropic connector's, deliberately.
let probeMemo = {}
let probeMemoTimestamp = 0

const probeMemoKey = (model, capability) => (model || '') + '::' + capability

const readProbeMemo = (model, capability) => {
  if ((Date.now() - probeMemoTimestamp) >= MODEL_CACHE_TTL) { probeMemo = {}; return undefined }
  return probeMemo[probeMemoKey(model, capability)]
}

export const rememberProbe = (model, capability, supported) => {
  if ((Date.now() - probeMemoTimestamp) >= MODEL_CACHE_TTL) { probeMemo = {}; probeMemoTimestamp = Date.now() }
  if (!probeMemoTimestamp) probeMemoTimestamp = Date.now()
  probeMemo[probeMemoKey(model, capability)] = supported
}

/**
 * TIER 2 is not available here — OpenAI's models.list() returns { id, created, owned_by } with
 * no capability data (unlike Anthropic, where the Models API publishes a per-model tree). So
 * this is tier 1 narrowed by whatever tier 3 has LEARNED, and anything neither settles stays
 * UNKNOWN, which means "try it and let the API answer". Guessing from a model-id substring is
 * the exact habit this design exists to prevent — do not reintroduce it.
 */
export const getCapabilities = async ({ apiKey, model } = {}) => {
  const resolved = { ...CAPABILITIES }
  if (!model) return resolved

  const web = {}
  for (const half of ['search', 'fetch']) {
    const memo = readProbeMemo(model, 'web.' + half)
    web[half] = memo === undefined ? UNKNOWN : memo
  }
  resolved.web = web

  for (const key of ['vision', 'documents', 'effort']) {
    const memo = readProbeMemo(model, key)
    resolved[key] = memo === undefined ? UNKNOWN : memo
  }
  return resolved
}

export const getFamilyFromModelId = (id) => parseModelId(id).family

const getSearchTermForModel = (model) => {
  const shorthand = normalizeModelId(model)
  if (!shorthand) return ''
  return shorthand.startsWith('gpt-') || shorthand.startsWith('o') || shorthand.startsWith('chatgpt-')
    ? shorthand
    : (/^\d/.test(shorthand) ? 'gpt-' + shorthand : shorthand)
}

const selectModelFromAvailable = (available, model) => {
  const shorthand = normalizeModelId(model)
  if (!shorthand) return null

  const searchTerm = getSearchTermForModel(shorthand)
  const exact = available.find(m => m.id === searchTerm)
  if (exact) return exact.id

  const normalizedSearch = normalizeModelId(searchTerm)
  const normalized = available.find(m => normalizeModelId(m.id) === normalizedSearch)
  if (normalized) return normalized.id

  const prefixed = available.find(m => m.id.startsWith(searchTerm + '-'))
  if (prefixed) return prefixed.id

  const family = available.find(m => parseModelId(m.id).family === shorthand)
  if (family) return family.id

  return null
}

export const parseModelId = (id) => {
  const normalized = normalizeModelId(id)

  // o-series: o3, o3-mini, o4-mini, o1-pro, etc.
  const oMatch = normalized.match(/^o(\d+)(?:-(.+))?$/)
  if (oMatch) {
    return { id: normalized, family: normalized, provider: 'ChatGPT', version: oMatch[1] }
  }

  // gpt-series: gpt-5.2-pro, gpt-4o-mini, gpt-4.1, gpt-5-nano, etc.
  const gptMatch = normalized.match(/^gpt-(\d+(?:\.\d+)?o?)(?:-(.+))?$/)
  if (gptMatch) {
    return { id: normalized, family: normalized, provider: 'ChatGPT', version: gptMatch[1] }
  }

  // chatgpt-series: chatgpt-4o, etc.
  const chatgptMatch = normalized.match(/^chatgpt-(\d+(?:\.\d+)?o?)(?:-(.+))?$/)
  if (chatgptMatch) {
    return { id: normalized, family: normalized, provider: 'ChatGPT', version: chatgptMatch[1] }
  }

  return { id: normalized, family: normalized, provider: 'ChatGPT', version: '' }
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

const sortByCreatedDesc = (models) => models.sort((a, b) => (b.created || 0) - (a.created || 0))

const getChatModels = (models, { stable = false } = {}) => {
  const baseFilter = (m, matcher) => (
    matcher(m.id) &&
    !m.id.endsWith('-latest') &&
    (!stable || isStableModel(m.id))
  )

  const known = models.filter(m => baseFilter(m, isChatModel))
  if (known.length > 0) return sortByCreatedDesc(known)

  console.warn('OpenAI model list used fallback chat-model filtering; naming conventions may have changed.')
  return sortByCreatedDesc(models.filter(m => baseFilter(m, isPotentialChatModel)))
}

/**
 * @param {Object} usage - the provider's raw usage block
 * @param {Object} [toolsUsed] - what we OBSERVED the web tool do this turn. OpenAI reports no
 *   per-tool counter in `usage` at all (Anthropic has server_tool_use), so unlike there this
 *   is the ONLY source for the request counts — without it every web search bills at zero.
 */
const standardizeUsage = (usage, toolsUsed = null) => {
  if (!usage) {
    return {
      input: { qtty: 0, cost: 0 },
      output: { qtty: 0, cost: 0 },
      other: { qtty: 0, cost: 0, details: {} }
    }
  }

  const inputQty = usage.prompt_tokens || usage.input_tokens || 0
  const outputQty = usage.completion_tokens || usage.output_tokens || 0
  const totalQty = usage.total_tokens || (inputQty + outputQty)
  const reasoningQty = usage.completion_tokens_details?.reasoning_tokens || usage.output_tokens_details?.reasoning_tokens || 0
  // OpenAI caches long prompt prefixes automatically (no request param) and bills the cached
  // share at a discount. UNLIKE Anthropic, these tokens are INCLUDED in prompt_tokens — so they
  // are reported as a detail (cachedPromptTokens) for the pricing layer to discount, NOT added
  // to other.qtty (that would double-count them).
  const cachedPromptQty = usage.prompt_tokens_details?.cached_tokens || usage.input_tokens_details?.cached_tokens || 0
  const otherQty = Math.max(0, totalQty - inputQty - outputQty)
  // The web tool bills PER REQUEST at a flat rate per 1,000, not per token, so the counts go
  // in `details` for the cost service to price but NOT in other.qtty — that field is a token
  // count and feeds totalTokens, where a request count would be a lie.
  const webSearchRequests = toolsUsed?.webSearch?.requests || 0
  const webFetchRequests = toolsUsed?.webFetch?.requests || 0

  const details = {}
  if (reasoningQty) details.reasoningTokens = reasoningQty
  if (cachedPromptQty) details.cachedPromptTokens = cachedPromptQty
  if (webSearchRequests) details.webSearchRequests = webSearchRequests
  if (webFetchRequests) details.webFetchRequests = webFetchRequests

  return {
    input: { qtty: inputQty, cost: 0 },
    output: { qtty: outputQty, cost: 0 },
    other: { qtty: otherQty, cost: 0, details }
  }
}

const standardizeImageUsage = (usage) => {
  if (!usage) {
    return {
      input: { qtty: 0, cost: 0 },
      output: { qtty: 0, cost: 0 },
      other: { qtty: 0, cost: 0, details: {} }
    }
  }

  const inputQty = usage.input_tokens || 0
  const outputQty = usage.output_tokens || 0
  const details = {}
  if (usage.input_tokens_details) {
    details.imageInputTokens = usage.input_tokens_details.image_tokens || 0
    details.textInputTokens = usage.input_tokens_details.text_tokens || 0
  }

  return {
    input: { qtty: inputQty, cost: 0 },
    output: { qtty: outputQty, cost: 0 },
    other: { qtty: 0, cost: 0, details }
  }
}

export const getLatestModelForFamily = async ({ apiKey, family }) => {
  const shorthand = (family || DEFAULT_FAMILY).toLowerCase()
  const client = new OpenAI({ apiKey })
  try {
    const available = getChatModels(await getAvailableModels(client))
    const selected = selectModelFromAvailable(available, shorthand)
    if (selected) return selected
    if (available[0]?.id) return available[0].id
  } catch (e) {
    console.warn('Could not fetch OpenAI models for family lookup:', e.message)
  }
  return DEFAULT_MODEL
}

export const listModels = async ({ apiKey }) => {
  const client = new OpenAI({ apiKey })
  const all = await getAvailableModels(client)
  const canonical = new Map()
  const available = getChatModels(all, { stable: true })

  for (const model of available) {
    const parsed = parseModelId(model.id)
    if (!canonical.has(parsed.id)) {
      canonical.set(parsed.id, { ...parsed, created: model.created })
    }
  }

  return markLatestPerFamily(Array.from(canonical.values()))
}

export const listImageModels = async ({ apiKey }) => {
  const client = new OpenAI({ apiKey })
  const all = await getAvailableModels(client)
  return all
    .filter(m => isImageModel(m.id))
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .map(m => ({ id: m.id, provider: 'ChatGPT', created: m.created }))
}

const resolveImageModel = async (client) => {
  try {
    const all = await getAvailableModels(client)
    const imageModels = all
      .filter(m => isImageModel(m.id))
      .sort((a, b) => (b.created || 0) - (a.created || 0))
    if (imageModels.length > 0) return imageModels[0].id
  } catch (e) {
    console.warn('Could not fetch OpenAI image models, using fallback:', e.message)
  }
  return 'gpt-image-1'
}

const makePricingPromptWithModels = (modelIds) => {
  const modelList = modelIds.map(id => `"${id}"`).join(', ')
  return `You are a helpful assistant that provides current API pricing information.
Here are the model IDs I need pricing for: ${modelList}
Return ONLY a valid JSON object (no markdown, no explanation) with per-million-token pricing in USD.
The format must be exactly:
{
  "models": {
    "<model-id>": { "input": <price_per_million_input_tokens>, "output": <price_per_million_output_tokens> },
    ...
  }
}
Use the exact model ID strings I provided as keys.
If you are unsure of the exact price for a model, omit that model instead of guessing 0.
Never use 0 as a placeholder price unless the model is genuinely free.`
}

const makeSingleModelPricingPrompt = (modelId) => {
  return `You are a helpful assistant that provides current API pricing information.
Return ONLY a valid JSON object (no markdown, no explanation) with the per-million-token pricing in USD for model "${modelId}".
The format must be exactly:
{ "input": <price_per_million_input_tokens>, "output": <price_per_million_output_tokens> }
If you are unsure of the exact price for "${modelId}", provide your best estimate based on the model family it belongs to.
Never return 0 unless the model is genuinely free.`
}

const fetchTextFromUrl = async (url) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`)
  return await response.text()
}

const parsePricingLiteral = (rawValue) => {
  const value = String(rawValue || '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .trim()
  if (!value || value === 'null' || value === 'undefined') return null
  if (value === '-' || /^free$/i.test(value)) return null
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    const inner = value.slice(1, -1).trim()
    if (!inner || inner === '-' || /^free$/i.test(inner)) return null
    const numberValue = Number(inner.replace(/[$,]/g, ''))
    return Number.isFinite(numberValue) ? numberValue : null
  }
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

const normalizePricingLabel = (label) => {
  return (label || '')
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
}

const parsePricingRows = (pageText) => {
  const models = {}
  const rowsRegex = /rows=\{\[([\s\S]*?)\]\}/g
  const rowRegex = /\[\s*"([^"]+)"\s*,\s*([^,\]\n]+)\s*,\s*([^,\]\n]+)\s*,\s*([^,\]\n]+)\s*\]/g
  let tableMatch = null

  while ((tableMatch = rowsRegex.exec(pageText)) !== null) {
    const tableText = tableMatch[1]
    let rowMatch = null
    while ((rowMatch = rowRegex.exec(tableText)) !== null) {
      const modelId = normalizeModelId(normalizePricingLabel(rowMatch[1]))
      if (!isPotentialChatModel(modelId)) continue
      if (models[modelId]) continue

      const input = parsePricingLiteral(rowMatch[2])
      const cachedInput = parsePricingLiteral(rowMatch[3])
      const output = parsePricingLiteral(rowMatch[4])
      if (!Number.isFinite(input) || !Number.isFinite(output)) continue

      models[modelId] = { input, output }
      if (Number.isFinite(cachedInput) && cachedInput >= 0) {
        models[modelId].cachedInput = cachedInput
      }
    }
  }

  return Object.keys(models).length > 0 ? models : null
}

const parseOfficialPricing = (pageText) => {
  const rowModels = parsePricingRows(pageText)
  if (rowModels) return rowModels

  const models = {}
  const rowRegex = /\[\[0,&quot;([\s\S]*?)&quot;\],\[0,([^,\]]+)\],\[0,([^,\]]+)\],\[0,([^,\]]+)\]\]\]/g
  let match = null

  while ((match = rowRegex.exec(pageText)) !== null) {
    const modelId = normalizeModelId(normalizePricingLabel(match[1]))
    if (!isPotentialChatModel(modelId)) continue
    if (models[modelId]) continue

    const input = parsePricingLiteral(match[2])
    const cachedInput = parsePricingLiteral(match[3])
    const output = parsePricingLiteral(match[4])
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue

    models[modelId] = { input, output }
    if (Number.isFinite(cachedInput) && cachedInput >= 0) {
      models[modelId].cachedInput = cachedInput
    }
  }

  return Object.keys(models).length > 0 ? models : null
}

const fetchOfficialPricing = async ({ modelIds = [], targetModel = null } = {}) => {
  const pageText = await fetchTextFromUrl(OPENAI_PRICING_URL)
  const allModels = parseOfficialPricing(pageText)
  if (!allModels) return null

  const requested = targetModel
    ? [targetModel]
    : (modelIds.length > 0 ? modelIds : Object.keys(allModels))
  const filtered = {}

  for (const modelId of requested) {
    const canonicalId = normalizeModelId(modelId)
    if (allModels[canonicalId]) filtered[canonicalId] = allModels[canonicalId]
  }
  return Object.keys(filtered).length > 0 ? filtered : null
}

const normalizeTextPricingModels = (models) => {
  if (!models || typeof models !== 'object') return null
  const normalized = {}
  for (const [rawKey, rawVal] of Object.entries(models)) {
    if (!rawVal || typeof rawVal !== 'object') continue
    const input = Number(rawVal.input)
    const output = Number(rawVal.output)
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue
    if (input <= 0 || output <= 0) continue
    const key = normalizeModelId(rawKey)
    normalized[key] = { input, output }
    const cachedInput = Number(rawVal.cachedInput)
    if (Number.isFinite(cachedInput) && cachedInput > 0) {
      normalized[key].cachedInput = cachedInput
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : null
}

export const getPricing = async ({ apiKey, targetModel = null }) => {
  let modelIds = []
  try {
    modelIds = (await listModels({ apiKey })).map(m => normalizeModelId(m.id))
  } catch (e) {
    console.warn('Could not fetch OpenAI models for pricing:', e.message)
  }

  try {
    const officialModels = await fetchOfficialPricing({ modelIds, targetModel })
    if (officialModels) {
      return {
        models: officialModels,
        source: 'official_pricing_page',
        sourceModel: 'openai_pricing_page'
      }
    }
  } catch (e) {
    console.warn('Official OpenAI pricing fetch failed:', e.message)
  }

  const prompt = targetModel
    ? makeSingleModelPricingPrompt(targetModel)
    : makePricingPromptWithModels(modelIds.length > 0
      ? modelIds
      : ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3-mini', 'o4-mini'])

  let llmResult = null
  try {
    llmResult = await ask({
      apiKey,
      prompt,
      context: 'You are a pricing data assistant. Return only valid JSON.',
      model: DEFAULT_MODEL,
      max_tokens: 4096,
      responseType: 'json'
    })
  } catch (e) {
    console.warn('OpenAI pricing LLM fallback failed:', e.message)
    return null
  }
  let parsed = null
  if (typeof llmResult.response === 'string') {
    try { parsed = JSON.parse(llmResult.response) } catch (e) {
      console.warn('OpenAI getPricing: could not parse LLM response as JSON:', e.message)
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

  models = normalizeTextPricingModels(models)

  return models
    ? { models, source: 'llm_self_report', sourceModel: llmResult.model }
    : null
}

export const getImagePricing = async ({ apiKey, targetModel = null }) => {
  let imageModelIds = []
  try {
    const models = await listImageModels({ apiKey })
    imageModelIds = models.map(m => m.id)
  } catch (e) {
    console.warn('Could not fetch OpenAI image models for pricing:', e.message)
  }
  if (imageModelIds.length === 0 && !targetModel) {
    imageModelIds = ['gpt-image-1', 'gpt-image-1-mini']
  }

  const modelsToPrice = targetModel ? [targetModel] : imageModelIds
  const modelList = modelsToPrice.map(id => `"${id}"`).join(', ')

  const prompt = `You are a helpful assistant that provides current OpenAI API pricing information.
Here are the image model IDs I need pricing for: ${modelList}

Image models have a different pricing structure from text models. They charge per-million-tokens for:
- text_input: price in USD per 1 MILLION text input tokens
- image_input: price in USD per 1 MILLION image input tokens
- image_output: price in USD per 1 MILLION image output tokens

IMPORTANT: All prices must be in USD per 1,000,000 (one million) tokens, NOT per 1,000 tokens.
For reference, gpt-image-1 costs approximately $5 per million text input tokens, $10 per million image input tokens, and $40 per million image output tokens.

Return ONLY a valid JSON object (no markdown, no explanation).
The format must be exactly:
{
  "models": {
    "<model-id>": { "text_input": <price>, "image_input": <price>, "image_output": <price> },
    ...
  }
}
Use the exact model ID strings I provided as keys. Never use 0 as a placeholder.`

  const llmResult = await ask({
    apiKey,
    prompt,
    context: 'You are a pricing data assistant. Return only valid JSON.',
    model: 'gpt-4o-mini',
    max_tokens: 4096,
    responseType: 'json'
  })

  const parsed = typeof llmResult.response === 'string'
    ? JSON.parse(llmResult.response)
    : llmResult.response

  let models = null
  if (targetModel && parsed) {
    if (parsed.text_input !== undefined) {
      models = { [targetModel]: parsed }
    } else if (parsed.models && parsed.models[targetModel]) {
      models = parsed.models
    }
  } else if (parsed && parsed.models) {
    models = parsed.models
  }

  return models
    ? { models, source: 'llm_self_report', sourceModel: llmResult.model }
    : null
}

const resolveDefaultModel = async (client, thinking) => {
  const preferred = thinking ? DEFAULT_REASONING_MODEL : DEFAULT_MODEL
  try {
    const available = getChatModels(await getAvailableModels(client))
    if (thinking) {
      for (const candidate of DEFAULT_REASONING_MODEL_PREFERENCES) {
        const selected = selectModelFromAvailable(available, candidate)
        if (selected) return selected
      }
      // No model-id test to fall back on any more, deliberately: whether a model reasons is
      // settled by the API (see buildReasoningConfig), so the preference list above is the
      // only ordering we assert, and anything past it is just "the newest chat model".
    }
    const selected = selectModelFromAvailable(available, preferred)
    if (selected) return selected
    if (available[0]?.id) return available[0].id
  } catch (e) {
    console.warn('Could not fetch OpenAI models for default lookup:', e.message)
  }
  return preferred
}

const resolveModel = async (client, model, thinking) => {
  if (!model) return resolveDefaultModel(client, thinking)

  const shorthand = normalizeModelId(model)

  try {
    const available = getChatModels(await getAvailableModels(client))
    const selected = selectModelFromAvailable(available, shorthand)
    if (selected) return selected
  } catch (e) {
    console.warn('Could not fetch OpenAI models, using fallback:', e.message)
  }

  return getSearchTermForModel(model)
}

/**
 * Which reasoning config this request wants, or null for "leave the model's default alone".
 *
 * There is deliberately NO model-id test here any more. The old supportsReasoningEffort()
 * matched /^o\d/ and /^gpt-5/ against the id, which is the one habit the capability design
 * exists to prevent — it silently dropped the caller's `thinking` on any model whose name
 * did not fit the pattern, including every future one. A model that will not take `reasoning`
 * now says so on create(), before a single token streams, and runWithDegrades removes it and
 * remembers (tier 3).
 *
 * `effort` (the top-level option) and `thinking.effort` both land on reasoning.effort;
 * TOP-LEVEL `effort` WINS, because it is the newer, provider-recommended dial and a caller
 * who sets both explicitly meant the more specific one.
 *
 * `summary: 'auto'` is what makes reasoning TEXT come back at all — it is the whole reason
 * this connector can now declare thinking.text true. (The raw chain of thought is never
 * returned by any provider; this is a model-written summary of it.)
 */
const buildReasoningConfig = (thinking, effort) => {
  // EXPLICIT false ≠ absent: reasoning models think by default and those tokens bill as
  // output, so a caller doing high-volume extraction must be able to opt out.
  if (thinking === false && !effort) return { effort: 'none' }
  if (!thinking && !effort) return null
  const chosen = effort || (typeof thinking === 'object' && thinking.effort) || null
  const config = { summary: 'auto' }
  if (chosen) config.effort = String(chosen)
  return config
}

// Normalise a Chat Completions finish_reason to the same vocabulary. Only the fallback rung
// produces one now — the Responses path goes through normaliseResponseStatus instead.
//   'length'         -> 'max_tokens'  (the answer was CUT OFF)
//   'stop'           -> 'end_turn'
//   'tool_calls'     -> 'tool_use'
const normaliseFinishReason = (finishReason) => {
  if (!finishReason) return null
  if (finishReason === 'length') return 'max_tokens'
  if (finishReason === 'stop') return 'end_turn'
  if (finishReason === 'tool_calls' || finishReason === 'function_call') return 'tool_use'
  return finishReason
}

// One warning for both ask() and askStream(). The empty-answer case is called out separately
// because it is confusing in the wild: max_output_tokens covers REASONING tokens as well as
// visible output, so a reasoning model can spend the whole budget thinking and come back
// truncated with no content at all — which reads like an API fault rather than a ceiling.
const warnIfTruncated = (stopReason, { maxTokens, textResponse, usage, model }) => {
  if (stopReason !== 'max_tokens') return
  const reasoningTokens = usage?.output_tokens_details?.reasoning_tokens ||
    usage?.completion_tokens_details?.reasoning_tokens || 0
  if (!textResponse) {
    console.warn('[freezr openai] ' + model + ' returned NO text and stopped at the max_output_tokens ceiling (' +
      (maxTokens || 'unset') + ')' + (reasoningTokens ? ' — it spent all ' + reasoningTokens + ' tokens reasoning' : '') +
      '. Raise the ceiling or lower the reasoning effort.')
    return
  }
  console.warn('[freezr openai] answer hit the max_output_tokens ceiling (' + (maxTokens || 'unset') +
    ') and was CUT OFF — the caller is getting a partial answer' +
    (reasoningTokens ? ' (' + reasoningTokens + ' of the budget went on reasoning)' : ''))
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

// ── Web access (server tools) ────────────────────────────────────────────────────────────
//
// These run on OpenAI's side: we declare the tool and the results come back as items in the
// same response. There is no client-side execution loop.
//
// Several helpers below are exported purely so the unit tests can drive them with a fake
// client (they take `client` as a parameter for exactly that reason). Not part of the
// connector contract — the controller calls ask/askStream/getCapabilities only.

/**
 * Translate freezr's normalized `web` option into the OpenAI tool definition.
 * ONE tool covers both halves — see the WEB ACCESS note in the header — so this returns at
 * most a single definition however many halves the caller named.
 */
export const buildWebTools = (web) => {
  if (!web) return null
  // The deliberately non-portable escape hatch: when a caller passes raw.openai they get
  // exactly those tool definitions, unvalidated. Documented as provider-specific — an app
  // using it has opted out of freezr translating anything.
  if (Array.isArray(web.raw?.openai)) return web.raw.openai.length ? web.raw.openai : null
  if (!web.search && !web.fetch) return null

  const tool = { type: 'web_search' }
  const halves = [web.search, web.fetch].filter(h => h && h !== true)

  // allowed_domains is the only domain control OpenAI offers, and it happens to be the one
  // that actually constrains where a prompt-injected URL can send data. Merge whatever the
  // named halves asked for; blockedDomains has no equivalent and is reported unavailable.
  const allowed = []
  for (const half of halves) {
    if (!Array.isArray(half.allowedDomains)) continue
    for (const domain of half.allowedDomains) if (!allowed.includes(domain)) allowed.push(domain)
  }
  if (allowed.length) tool.filters = { allowed_domains: allowed }

  const located = halves.find(h => h.userLocation)
  if (located) tool.user_location = { type: 'approximate', ...located.userLocation }

  // Set ONLY when a caller names it. It is tempting to derive it from maxContentTokens, but
  // that is a token budget and this is a three-position dial — inferring one from the other
  // would be freezr inventing a number and reporting it as the caller's.
  const sized = halves.find(h => h.contextSize)
  if (sized) tool.search_context_size = String(sized.contextSize)

  return [tool]
}

/**
 * Everything the caller asked for that this provider cannot honour, named in the same dotted
 * vocabulary the capability gate uses. Travels back to the app as `unavailable`, because the
 * alternative — dropping a `maxUses` spend cap or a `blockedDomains` safety control on the
 * floor — means the app finds out from its bill or its incident review instead.
 */
export const webUnavailableOptions = (web) => {
  if (!web) return []
  // raw.openai means the caller took the wheel; nothing here was translated, so nothing was lost.
  if (Array.isArray(web.raw?.openai)) return []

  const out = []
  const check = (name, opts) => {
    if (!opts || opts === true) return
    if (opts.maxUses) out.push('web.' + name + '.maxUses')
    if (Array.isArray(opts.blockedDomains) && opts.blockedDomains.length) out.push('web.' + name + '.blockedDomains')
    if (opts.maxContentTokens) out.push('web.' + name + '.maxContentTokens')
  }
  check('search', web.search)
  check('fetch', web.fetch)
  // A SHAPE difference rather than an option difference: there is no fetch-only tool, so a
  // caller who asked for fetch alone is getting search as well.
  if (web.fetch && !web.search) out.push('web.fetch.only')
  return out
}

/** Does this error mean "this model won't take that tool"? Drives the tier-3 ladder. */
export const isWebToolRejection = (err) => {
  const msg = ((err && (err.message || String(err))) || '').toLowerCase()
  return msg.includes('web_search') ||
    (msg.includes('tool') && (msg.includes('not supported') || msg.includes('unsupported') ||
      msg.includes('does not support') || msg.includes('invalid')))
}

/**
 * Does this error mean the endpoint itself is unavailable — an OpenAI-compatible server that
 * only implements /v1/chat/completions, or a model the Responses API will not run? Distinct
 * from a tool rejection: this one costs us the whole transport, not one feature.
 */
export const isResponsesUnsupported = (err) => {
  const msg = ((err && (err.message || String(err))) || '').toLowerCase()
  if (msg.includes('responses')) return true
  return err?.status === 404 && (msg.includes('unrecognized') || msg.includes('url'))
}

const capabilityError = (model, capability) => {
  const err = new Error(model + ' cannot reach the web')
  err.code = 'capability_unsupported_on_model'
  err.capability = capability
  err.model = model
  return err
}

/**
 * Accumulates everything the web tool produced. Unlike Anthropic's two tools, OpenAI reports
 * ONE `web_search_call` item per action, and the item's `action.type` is what says whether it
 * was a search, a page open or a find-in-page — which is also how it bills. So the split into
 * freezr's webSearch/webFetch halves happens here, on the action, not on the tool name.
 */
export const makeWebCollector = () => {
  const searchQueries = []
  const sources = []
  const fetchedUrls = []
  const errors = []
  const pendingCitations = []
  let searchRequests = 0
  let fetchRequests = 0

  const noteCall = (item) => {
    const action = item?.action || null
    const kind = action?.type || 'search'
    const tool = kind === 'search' ? 'web_search' : 'web_fetch'

    // A failed tool call is a normal 200 with a failed ITEM, never a thrown error — the same
    // trap as Anthropic's error-object-instead-of-array, in a different shape.
    if (item?.status === 'failed' || item?.status === 'incomplete') {
      const code = item.error?.code || item.error?.type || item.status
      errors.push({ tool, code })
      return { tool, status: 'error', code }
    }

    if (kind === 'search') {
      searchRequests++
      if (typeof action?.query === 'string' && action.query) searchQueries.push(action.query)
      if (Array.isArray(action?.sources)) {
        for (const source of action.sources) {
          if (source?.url) sources.push({ url: source.url, title: source.title || null })
        }
      }
      return {
        tool,
        status: 'result',
        results: Array.isArray(action?.sources) ? action.sources.length : 0,
        query: action?.query || null
      }
    }

    // open_page / find_in_page — the pages that actually entered the conversation.
    fetchRequests++
    if (action?.url) fetchedUrls.push(action.url)
    return { tool, status: 'result', url: action?.url || null }
  }

  // OpenAI's url_citation carries INDEXES into the answer text rather than the quoted text
  // itself, so the quote can only be resolved once the text has finished streaming.
  const noteCitation = (annotation) => {
    if (!annotation || annotation.type !== 'url_citation') return
    pendingCitations.push({
      url: annotation.url || null,
      title: annotation.title || null,
      start: annotation.start_index,
      end: annotation.end_index
    })
  }

  const citations = (text) => pendingCitations.map(c => ({
    url: c.url,
    title: c.title,
    citedText: (typeof text === 'string' && Number.isInteger(c.start) && Number.isInteger(c.end) && c.end > c.start)
      ? text.slice(c.start, c.end)
      : null
  }))

  const summary = () => {
    if (!searchRequests && !fetchRequests && !errors.length) return null
    const out = {}
    if (searchRequests) out.webSearch = { requests: searchRequests, queries: searchQueries, sources }
    if (fetchRequests) out.webFetch = { requests: fetchRequests, urls: fetchedUrls }
    if (errors.length) out.errors = errors
    // No `limitReached`: OpenAI's tool has no caps to reach (see webUnavailableOptions), so
    // reporting one would be inventing a state. Apps read `meta.toolsUsed.limitReached` as
    // optional already, because Anthropic only sets it when a cap was actually hit.
    return out
  }

  return { noteCall, noteCitation, citations, summary }
}

/**
 * Normalise a Responses status to the same vocabulary the Anthropic connector reports, so an
 * app checks meta.stopReason === 'max_tokens' once instead of branching per provider.
 *   status 'completed'                            -> 'end_turn'
 *   status 'incomplete' + 'max_output_tokens'     -> 'max_tokens'   (the answer was CUT OFF)
 *   a refusal                                     -> 'content_filter'
 */
const normaliseResponseStatus = (status, incompleteReason, refusal) => {
  if (refusal) return 'content_filter'
  if (status === 'incomplete') {
    if (incompleteReason === 'max_output_tokens') return 'max_tokens'
    if (incompleteReason === 'content_filter') return 'content_filter'
    return incompleteReason || 'incomplete'
  }
  if (status === 'completed') return 'end_turn'
  return status || null
}

/**
 * The one stream loop, shared by ask() and askStream() so the two paths cannot drift.
 * Returns the collected answer; emits progress through onEvent when one is supplied.
 */
export const streamAndCollect = async (client, params, { onEvent = null } = {}) => {
  const collector = makeWebCollector()
  let textResponse = ''
  let thinkingResponse = ''
  let refusal = ''
  let usage = null
  let status = null
  let incompleteReason = null

  const stream = await client.responses.create({ ...params, stream: true })

  for await (const event of stream) {
    switch (event?.type) {
      case 'response.output_text.delta':
        if (event.delta) {
          textResponse += event.delta
          if (onEvent) onEvent({ type: 'delta', text: event.delta })
        }
        break

      // Two spellings on purpose: `reasoning_summary_text` is the model-written summary that
      // `reasoning: { summary: 'auto' }` asks for, `reasoning_text` is the direct form some
      // models emit. Either one is what an app renders as "thinking".
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (event.delta) {
          thinkingResponse += event.delta
          if (onEvent) onEvent({ type: 'thinking', text: event.delta })
        }
        break

      // A summary arrives in discrete parts; without a separator they run together into one
      // unreadable paragraph.
      case 'response.reasoning_summary_part.added':
        if (thinkingResponse) {
          thinkingResponse += '\n\n'
          if (onEvent) onEvent({ type: 'thinking', text: '\n\n' })
        }
        break

      case 'response.refusal.delta':
        if (event.delta) refusal += event.delta
        break

      case 'response.output_item.added':
        if (event.item?.type === 'web_search_call' && onEvent) {
          onEvent({ type: 'tool', tool: 'web_search', status: 'started' })
        }
        break

      case 'response.web_search_call.searching':
        if (onEvent) onEvent({ type: 'tool', tool: 'web_search', status: 'searching' })
        break

      case 'response.output_item.done': {
        // The action (and with it the query, the sources and the opened URL) is only complete
        // on the item's done event — reading it on `added` gets an empty shell.
        if (event.item?.type !== 'web_search_call') break
        const noted = collector.noteCall(event.item)
        if (onEvent && noted) onEvent({ type: 'tool', ...noted })
        break
      }

      case 'response.output_text.annotation.added':
        collector.noteCitation(event.annotation)
        break

      case 'response.completed':
      case 'response.incomplete':
        usage = event.response?.usage || usage
        status = event.response?.status || null
        incompleteReason = event.response?.incomplete_details?.reason || null
        break

      case 'response.failed': {
        const failure = event.response?.error
        const err = new Error(failure?.message || 'the OpenAI response failed')
        if (failure?.code) err.code = failure.code
        throw err
      }

      default:
        break
    }
  }

  // A refusal is still the model's answer to the user, so it becomes the response rather than
  // an empty string — with a stopReason that says why it reads the way it does.
  const finalText = textResponse || refusal

  return {
    textResponse: finalText,
    thinkingResponse,
    usage,
    stopReason: normaliseResponseStatus(status, incompleteReason, refusal),
    rawStopReason: incompleteReason || status || null,
    toolsUsed: collector.summary(),
    citations: collector.citations(finalText)
  }
}

/**
 * Translate Responses params back into a Chat Completions request for the fallback rung.
 * Lossy on purpose — there is no web tool over there, which is why runWithDegrades settles
 * the web question BEFORE dropping to this transport.
 */
const responsesParamsToChat = (params) => {
  const contentFor = (content) => {
    if (typeof content === 'string' || !Array.isArray(content)) return content
    return content.map(part => {
      if (part?.type === 'input_text') return { type: 'text', text: part.text }
      if (part?.type === 'input_image') return { type: 'image_url', image_url: { url: part.image_url } }
      if (part?.type === 'input_file') return { type: 'file', file: { filename: part.filename, file_data: part.file_data } }
      return part
    })
  }

  const messages = []
  if (params.instructions) messages.push({ role: 'system', content: params.instructions })
  for (const item of params.input || []) {
    messages.push({ role: item.role || 'user', content: contentFor(item.content) })
  }

  const chat = { model: params.model, messages, stream: true, stream_options: { include_usage: true } }
  if (params.max_output_tokens) chat.max_completion_tokens = params.max_output_tokens
  if (params.reasoning?.effort && params.reasoning.effort !== 'none') chat.reasoning_effort = params.reasoning.effort
  return chat
}

/**
 * The fallback transport. Produces the SAME collected shape as streamAndCollect so the rest of
 * the connector never learns which rung it came from.
 */
const streamViaChatCompletions = async (client, params, { onEvent = null } = {}) => {
  const stream = await client.chat.completions.create(responsesParamsToChat(params))
  let textResponse = ''
  let thinkingResponse = ''
  let usage = null
  let rawStopReason = null

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0]
    const delta = choice?.delta
    // reasoning_content is not an OpenAI field — it is the DeepSeek / vLLM / compatible-proxy
    // convention, and those servers are exactly who this rung exists for.
    if (delta?.reasoning_content) {
      thinkingResponse += delta.reasoning_content
      if (onEvent) onEvent({ type: 'thinking', text: delta.reasoning_content })
    }
    if (delta?.content) {
      textResponse += delta.content
      if (onEvent) onEvent({ type: 'delta', text: delta.content })
    }
    // finish_reason arrives on the LAST content chunk, before the usage-only chunk that
    // include_usage adds — so read it per chunk, not at the end.
    if (choice?.finish_reason) rawStopReason = choice.finish_reason
    if (chunk.usage) usage = chunk.usage
  }

  return {
    textResponse,
    thinkingResponse,
    usage,
    stopReason: normaliseFinishReason(rawStopReason),
    rawStopReason,
    toolsUsed: null,
    citations: []
  }
}

/**
 * The one degrade ladder, shared by ask() and askStream().
 *
 * Every rejection handled here happens on create(), BEFORE any token streams, so a retry
 * costs nothing and never double-bills. That property is what lets freezr discover per-model
 * support by trying instead of maintaining a table of which model takes which feature.
 *
 * Verdicts are memoized via rememberProbe so the same rejection is paid once per cache window.
 */
export const runWithDegrades = async (client, params, { web = null, model = null, onEvent = null } = {}) => {
  let webDropped = false
  // A previous request already learned this endpoint has no /v1/responses — start on the
  // fallback rather than paying the same 404 again.
  let viaChatCompletions = readProbeMemo(model, 'responses') === false

  /**
   * The chat-completions transport has no web tool of ANY kind, so moving onto it settles the
   * web question rather than deferring it. Called from both entrances to that rung — the
   * memoized start below and the 404 rung inside the loop — because handling it in only one
   * would mean the SECOND web request to a Responses-less endpoint quietly answered from the
   * model's stale knowledge with nothing in the response to say the web was never reached.
   */
  const settleWebForChatFallback = () => {
    if (!params.tools) return
    if (web?.search) rememberProbe(model, 'web.search', false)
    if (web?.fetch) rememberProbe(model, 'web.fetch', false)
    if (!web?.optional) throw capabilityError(params.model, 'web')
    console.warn('[freezr openai] chat completions cannot reach the web — continuing WITHOUT it (the caller passed optional)')
    delete params.tools
    delete params.include
    webDropped = true
  }

  if (viaChatCompletions) settleWebForChatFallback()

  while (true) {
    try {
      const collected = viaChatCompletions
        ? await streamViaChatCompletions(client, params, { onEvent })
        : await streamAndCollect(client, params, { onEvent })

      if (!viaChatCompletions) {
        if (params.tools && !webDropped) {
          if (web?.search) rememberProbe(model, 'web.search', true)
          if (web?.fetch) rememberProbe(model, 'web.fetch', true)
        }
        if (params.reasoning) rememberProbe(model, 'effort', true)
      }
      return { ...collected, webDropped, viaChatCompletions }
    } catch (err) {
      const emsg = ((err && (err.message || String(err))) || '').toLowerCase()

      // TIER 3, rung 1: no Responses API here at all.
      if (!viaChatCompletions && isResponsesUnsupported(err)) {
        console.warn('[freezr openai] ' + params.model + ' rejected the Responses API (' +
          (err && err.message) + ') — falling back to chat completions')
        rememberProbe(model, 'responses', false)
        viaChatCompletions = true
        settleWebForChatFallback()
        continue
      }

      // TIER 3, rung 2: the endpoint is fine, this model will not take the web tool.
      if (params.tools && isWebToolRejection(err)) {
        if (web?.search) rememberProbe(model, 'web.search', false)
        if (web?.fetch) rememberProbe(model, 'web.fetch', false)
        if (web?.optional) {
          console.warn('[freezr openai] ' + params.model + ' cannot use the web tool — continuing WITHOUT it (the caller passed optional)')
          delete params.tools
          delete params.include
          webDropped = true
          continue
        }
        throw capabilityError(params.model, 'web')
      }

      // TIER 3, rung 3: not a reasoning model. This is what replaced the model-id regex — the
      // API answers the question that /^gpt-5/ used to guess at.
      if (params.reasoning && (emsg.includes('reasoning') || emsg.includes('effort'))) {
        console.warn('[freezr openai] ' + params.model + ' rejected reasoning config ' +
          JSON.stringify(params.reasoning) + ' — retrying without it')
        rememberProbe(model, 'effort', false)
        delete params.reasoning
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
 * Build the `input` array. Files become content PARTS on the last user message — the same
 * placement rule the Anthropic connector uses, so an app attaching a PDF gets the same
 * behaviour from either provider.
 *
 * This is what replaced askWithFiles(), which uploaded each file, spun up an Assistant, a
 * vector store and a thread, polled a run and then deleted all four. That path had also gone
 * quietly dead: `client.beta.vectorStores` no longer exists in the installed SDK, it was
 * unreachable from the streaming route the controller actually takes, and it reported no
 * token usage at all — so a file call billed the user nothing.
 */
const buildResponseInput = (prompt, role, files) => {
  const input = Array.isArray(prompt)
    ? prompt.map(m => ({ role: m.role || 'user', content: m.content }))
    : [{ role: role || 'user', content: prompt || '' }]

  if (!files || files.length === 0) return input

  const lastUserIdx = findLastIndex(input, m => m.role === 'user')
  if (lastUserIdx < 0) return input

  const msg = input[lastUserIdx]
  const existingContent = typeof msg.content === 'string'
    ? [{ type: 'input_text', text: msg.content }]
    : (Array.isArray(msg.content) ? msg.content : [{ type: 'input_text', text: String(msg.content) }])

  const fileParts = files.map(f => {
    const mime = mimeFromFilename(f.originalname)
    const dataUri = 'data:' + mime + ';base64,' + f.buffer.toString('base64')
    return mime.startsWith('image/')
      ? { type: 'input_image', detail: 'auto', image_url: dataUri }
      : { type: 'input_file', filename: f.originalname, file_data: dataUri }
  })

  input[lastUserIdx] = { role: 'user', content: [...fileParts, ...existingContent] }
  return input
}

/** One request builder for ask() and askStream(), so an option cannot ship in only one. */
export const buildResponseParams = ({ model, prompt, context, max_tokens, role, thinking, effort, files, web }) => {
  const params = {
    model,
    input: buildResponseInput(prompt, role, files),
    // NOT optional, and NOT a default worth inheriting: see the store note in the header.
    store: false
  }
  if (context) params.instructions = context
  if (max_tokens) params.max_output_tokens = max_tokens

  const reasoning = buildReasoningConfig(thinking, effort)
  if (reasoning) params.reasoning = reasoning

  const tools = buildWebTools(web)
  if (tools) {
    params.tools = tools
    // Without this the search action comes back with no `sources`, and meta.toolsUsed would
    // report requests against an empty source list — which is the part apps display.
    params.include = ['web_search_call.action.sources']
  }
  return params
}

export const ask = async ({ apiKey, prompt, context, model, max_tokens, role, responseType, thinking, cache, effort, files, web }) => {
  const client = new OpenAI({ apiKey })
  // `effort` counts as asking to reason, not just `thinking` — they land on the same
  // reasoning config, so a caller who passed only effort was picking the default model as if
  // they had asked for no reasoning at all.
  const modelToUse = await resolveModel(client, model, thinking || effort)
  // `cache` is accepted and ignored: OpenAI caches long prefixes on its own with nothing for a
  // caller to set, which is what CAPABILITIES.cache = { automatic: true } says.
  const webOption = normalizeWebOption(web)
  const params = buildResponseParams({ model: modelToUse, prompt, context, max_tokens, role, thinking, effort, files, web: webOption })

  const collected = await runWithDegrades(client, params, { web: webOption, model: modelToUse })
  const { textResponse, thinkingResponse, usage, stopReason, rawStopReason, toolsUsed, citations, webDropped } = collected
  const response = responseType === 'json' ? parseJsonResponse(textResponse) : textResponse

  warnIfTruncated(stopReason, { maxTokens: max_tokens, textResponse, usage, model: modelToUse })

  return {
    response,
    thinking: thinkingResponse || null,
    provider: 'ChatGPT',
    model: modelToUse,
    family: getFamilyFromModelId(modelToUse),
    // 'max_tokens' means the answer was truncated; 'end_turn' means it finished.
    stopReason,
    rawStopReason,
    maxTokens: max_tokens || null,
    // What the web tool actually did — sources for display, opened URLs for audit.
    toolsUsed: toolsUsed || null,
    citations: (citations && citations.length) ? citations : null,
    // Everything asked for and not delivered: the options this provider has no equivalent for,
    // plus 'web' itself if the caller passed optional and the model could not.
    unavailable: [...webUnavailableOptions(webOption), ...(webDropped ? ['web'] : [])],
    rawUsage: usage,
    tokensUsed: standardizeUsage(usage, toolsUsed)
  }
}

/**
 * Streaming variant of ask(). Returns an async generator that yields chunk objects:
 *   { type: 'delta', text }     – incremental text content
 *   { type: 'thinking', text }  – incremental reasoning summary
 *   { type: 'tool', tool, status, query?, results?, url? } – web-tool progress
 *   { type: 'done', response, thinking, provider, model, family, rawUsage, tokensUsed }
 *
 * Same params as ask() except responseType is ignored (raw text is always yielded).
 */
export async function * askStream ({ apiKey, prompt, context, model, max_tokens, role, thinking, cache, effort, files, web }) {
  const client = new OpenAI({ apiKey })
  const modelToUse = await resolveModel(client, model, thinking || effort)
  const webOption = normalizeWebOption(web)
  const params = buildResponseParams({ model: modelToUse, prompt, context, max_tokens, role, thinking, effort, files, web: webOption })

  // The stream loop, the degrade ladder and the web collection all live in
  // runWithDegrades/streamAndCollect, shared with ask(). Duplicating them here is how the
  // streaming and non-streaming paths would drift — and streaming is the path the controller
  // actually takes, so a feature that only worked in ask() would look like it worked.
  const collected = yield * streamWithDegrades(client, params, { web: webOption, model: modelToUse })
  const { textResponse, thinkingResponse, usage, stopReason, rawStopReason, toolsUsed, citations, webDropped } = collected

  warnIfTruncated(stopReason, { maxTokens: max_tokens, textResponse, usage, model: modelToUse })

  yield {
    type: 'done',
    response: textResponse,
    thinking: thinkingResponse || null,
    provider: 'ChatGPT',
    model: modelToUse,
    family: getFamilyFromModelId(modelToUse),
    // 'max_tokens' means the answer was truncated; 'end_turn' means it finished.
    stopReason,
    rawStopReason,
    maxTokens: max_tokens || null,
    toolsUsed: toolsUsed || null,
    citations: (citations && citations.length) ? citations : null,
    unavailable: [...webUnavailableOptions(webOption), ...(webDropped ? ['web'] : [])],
    rawUsage: usage,
    tokensUsed: standardizeUsage(usage, toolsUsed)
  }
}

// ── Voice (speech-to-text / text-to-speech) ──────────────────────────────────────────────
//
// Separate endpoints, not part of the chat call, so these are separate connector exports —
// exactly like generateImage(). An app calls freezr.llm.transcribe() / .speak() and the
// capability gate answers for `voice.stt` / `voice.tts`.
//
// This is the first capability where CHATGPT CAN AND CLAUDE CANNOT. Anthropic ships no STT
// or TTS at all, so its connector deliberately has no transcribe/speak to call: the gate sees
// `voice: false` there and returns a capability_unsupported naming ChatGPT. That direction had
// never been exercised before — every capability so far ran the other way.

// These defaults are NAMED rather than discovered as "the newest voice model", which is the
// opposite of how generateImage picks its model — and for two concrete reasons, both visible
// in a real key's lineup (2026-09):
//   - whisper-1 bills per audio MINUTE and returns no token counts at all, so metering it
//     exactly is impossible. It must never be the default; a caller who names it explicitly
//     gets its duration reported instead (see standardizeAudioUsage).
//   - gpt-live-transcribe / gpt-realtime-whisper are for the REALTIME socket transport, not
//     for handing over a finished clip. Newest-wins would select one of them and fail.
// A caller who wants a different model passes `model` and gets it.
const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-transcribe'
const DEFAULT_SPEECH_MODEL = 'gpt-4o-mini-tts'
const DEFAULT_SPEECH_VOICE = 'alloy'
const DEFAULT_SPEECH_FORMAT = 'mp3'

export const listVoiceModels = async ({ apiKey }) => {
  const client = new OpenAI({ apiKey })
  const all = await getAvailableModels(client)
  return all
    .filter(m => isVoiceModel(m.id))
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .map(m => ({
      id: m.id,
      provider: 'ChatGPT',
      created: m.created,
      // Which half of `voice` this model serves, so an app picking a model does not have to
      // parse its name — and so a tts model can never be handed to transcribe().
      kind: (m.id.includes('tts')) ? 'tts' : 'stt'
    }))
}

/**
 * Normalise an audio usage block. The transcription endpoint reports either
 *   { type: 'tokens', input_tokens, input_token_details: { text_tokens, audio_tokens }, output_tokens }
 * or, on whisper-1, { type: 'duration', seconds } — which is not a token count at all, so it
 * goes to `details.audioSeconds` and NEVER into a qtty field that feeds totalTokens.
 */
export const standardizeAudioUsage = (usage) => {
  const empty = {
    input: { qtty: 0, cost: 0 },
    output: { qtty: 0, cost: 0 },
    other: { qtty: 0, cost: 0, details: {} }
  }
  if (!usage) return empty

  const details = {}
  if (usage.type === 'duration' || usage.seconds !== undefined) {
    details.audioSeconds = usage.seconds || 0
    return { ...empty, other: { qtty: 0, cost: 0, details } }
  }

  const inputQty = usage.input_tokens || 0
  const outputQty = usage.output_tokens || 0
  const breakdown = usage.input_token_details || usage.input_tokens_details || null
  if (breakdown) {
    if (breakdown.text_tokens) details.textInputTokens = breakdown.text_tokens
    if (breakdown.audio_tokens) details.audioInputTokens = breakdown.audio_tokens
  }

  return {
    input: { qtty: inputQty, cost: 0 },
    output: { qtty: outputQty, cost: 0 },
    other: { qtty: 0, cost: 0, details }
  }
}

/**
 * Speech to text.
 * @param {Object} params
 * @param {string} params.apiKey - OpenAI API key
 * @param {Object} params.audio - a multer-style file object ({ buffer, originalname, mimetype })
 * @param {string} [params.model] - defaults to gpt-4o-transcribe
 * @param {string} [params.language] - ISO-639-1 hint; improves accuracy and latency
 * @param {string} [params.prompt] - vocabulary hint (names, jargon) for the transcriber
 * @returns {Promise<Object>} { text, provider, model, family, rawUsage, tokensUsed }
 */
export const transcribe = async ({ apiKey, audio, model, language, prompt }) => {
  if (!audio || !audio.buffer) throw new Error('No audio provided to transcribe')
  const client = new OpenAI({ apiKey })
  const modelToUse = model || DEFAULT_TRANSCRIBE_MODEL

  // toFile keeps the filename, and the API infers the container format from its extension —
  // an unnamed buffer is rejected as an unsupported format however valid the audio is.
  const file = await OpenAI.toFile(
    audio.buffer,
    audio.originalname || 'audio.webm',
    audio.mimetype ? { type: audio.mimetype } : undefined
  )

  const params = { file, model: modelToUse }
  if (language) params.language = language
  if (prompt) params.prompt = prompt

  const result = await client.audio.transcriptions.create(params)
  const usage = result.usage || null

  return {
    text: result.text || '',
    provider: 'ChatGPT',
    model: modelToUse,
    family: normalizeModelId(modelToUse),
    rawUsage: usage,
    tokensUsed: standardizeAudioUsage(usage)
  }
}

/**
 * Text to speech. Returns base64 so it travels the same way generateImage's output does.
 * @param {Object} params
 * @param {string} params.apiKey - OpenAI API key
 * @param {string} params.text - what to say
 * @param {string} [params.voice] - 'alloy' | 'ash' | 'coral' | 'sage' | 'marin' | … (default alloy)
 * @param {string} [params.format] - 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm' (default mp3)
 * @param {string} [params.instructions] - how to say it ("calm, slow"); ignored by tts-1/tts-1-hd
 * @returns {Promise<Object>} { format, b64Data, provider, model, family, rawUsage, tokensUsed }
 */
export const speak = async ({ apiKey, text, voice, format, model, instructions }) => {
  if (!text) throw new Error('No text provided to speak')
  const client = new OpenAI({ apiKey })
  const modelToUse = model || DEFAULT_SPEECH_MODEL
  const formatToUse = format || DEFAULT_SPEECH_FORMAT

  const params = {
    model: modelToUse,
    voice: voice || DEFAULT_SPEECH_VOICE,
    input: String(text),
    response_format: formatToUse
  }
  if (instructions) params.instructions = instructions

  const result = await client.audio.speech.create(params)
  const b64Data = Buffer.from(await result.arrayBuffer()).toString('base64')

  // The speech endpoint returns audio and NOTHING else — no usage block of any kind. So the
  // only honest thing to meter on is the exact character count of what was sent, which the
  // cost service prices with per_million_characters and marks costEstimated. Reporting an
  // empty usage instead would bill every spoken word at zero.
  const characters = String(text).length

  return {
    format: formatToUse,
    b64Data,
    provider: 'ChatGPT',
    model: modelToUse,
    family: normalizeModelId(modelToUse),
    rawUsage: null,
    tokensUsed: {
      input: { qtty: 0, cost: 0 },
      output: { qtty: 0, cost: 0 },
      other: { qtty: 0, cost: 0, details: { characters } }
    }
  }
}

export const getVoicePricing = async ({ apiKey, targetModel = null }) => {
  let voiceModelIds = []
  try {
    voiceModelIds = (await listVoiceModels({ apiKey })).map(m => m.id)
  } catch (e) {
    console.warn('Could not fetch OpenAI voice models for pricing:', e.message)
  }
  if (voiceModelIds.length === 0 && !targetModel) {
    voiceModelIds = [DEFAULT_TRANSCRIBE_MODEL, DEFAULT_SPEECH_MODEL, 'gpt-4o-mini-transcribe']
  }

  const modelsToPrice = targetModel ? [targetModel] : voiceModelIds
  const modelList = modelsToPrice.map(id => `"${id}"`).join(', ')

  const prompt = `You are a helpful assistant that provides current OpenAI API pricing information.
Here are the audio model IDs I need pricing for: ${modelList}

Audio models bill on several axes. For each model return ONLY the axes that model actually charges for:
- input: USD per 1 MILLION text input tokens
- output: USD per 1 MILLION text output tokens
- audio_input: USD per 1 MILLION audio input tokens
- audio_output: USD per 1 MILLION audio output tokens
- per_million_characters: USD per 1 MILLION input characters, for text-to-speech models

IMPORTANT: every price is per 1,000,000 units, NOT per 1,000.
Return ONLY a valid JSON object (no markdown, no explanation), in exactly this format:
{
  "models": {
    "<model-id>": { "input": <price>, "audio_input": <price> },
    ...
  }
}
Use the exact model ID strings I provided as keys. Omit an axis a model does not charge for.
Never use 0 as a placeholder price.`

  let llmResult = null
  try {
    llmResult = await ask({
      apiKey,
      prompt,
      context: 'You are a pricing data assistant. Return only valid JSON.',
      model: DEFAULT_MODEL,
      max_tokens: 4096,
      responseType: 'json'
    })
  } catch (e) {
    console.warn('OpenAI voice pricing lookup failed:', e.message)
    return null
  }

  const parsed = typeof llmResult.response === 'string'
    ? _tryParse(llmResult.response)
    : llmResult.response

  let models = null
  if (targetModel && parsed) {
    if (parsed.models && parsed.models[targetModel]) models = parsed.models
    else if (Object.keys(parsed).some(k => AUDIO_AXES.includes(k))) models = { [targetModel]: parsed }
  } else if (parsed && parsed.models) {
    models = parsed.models
  }

  return models
    ? { models, source: 'llm_self_report', sourceModel: llmResult.model }
    : null
}

const AUDIO_AXES = ['input', 'output', 'audio_input', 'audio_output', 'per_million_characters']

const _tryParse = (text) => {
  try { return JSON.parse(text) } catch (e) { return parseJsonResponse(text) }
}

/**
 * Generate an image using OpenAI's image generation API.
 * Dynamically discovers the best available image model via list().
 * @param {Object} params
 * @param {string} params.apiKey - OpenAI API key
 * @param {string} params.prompt - Text description of the image to generate
 * @param {string} [params.size] - Image size (default '1024x1024')
 * @param {string} [params.quality] - Quality level (default 'auto')
 * @returns {Promise<Object>} { format, b64Data, revisedPrompt, provider, model, tokensUsed }
 */
const FALLBACK_IMAGE_MODEL = 'gpt-image-1'

const callImageGenerate = async (client, model, prompt, size, quality) => {
  const result = await client.images.generate({
    model,
    prompt,
    n: 1,
    size: size || '1024x1024',
    quality: quality || 'auto'
  })
  const imageData = result.data?.[0]
  if (!imageData) throw new Error('No image data returned from OpenAI')

  const usage = result.usage || null
  const tokensUsed = standardizeImageUsage(usage)

  let b64Data = imageData.b64_json || null
  if (!b64Data && imageData.url) {
    const resp = await fetch(imageData.url)
    if (!resp.ok) throw new Error('Failed to download generated image')
    const buffer = Buffer.from(await resp.arrayBuffer())
    b64Data = buffer.toString('base64')
  }

  return {
    format: 'png',
    b64Data,
    revisedPrompt: imageData.revised_prompt || null,
    provider: 'ChatGPT',
    model,
    rawUsage: usage,
    tokensUsed,
    family: normalizeModelId(model)
  }
}

export const generateImage = async ({ apiKey, prompt, size, quality, model }) => {
  const client = new OpenAI({ apiKey })
  const modelToUse = model || await resolveImageModel(client)

  try {
    return await callImageGenerate(client, modelToUse, prompt, size, quality)
  } catch (err) {
    if (err.status === 403 && modelToUse !== FALLBACK_IMAGE_MODEL) {
      console.warn('Image model', modelToUse, 'returned 403, falling back to', FALLBACK_IMAGE_MODEL)
      return await callImageGenerate(client, FALLBACK_IMAGE_MODEL, prompt, size, quality)
    }
    throw err
  }
}

/**
 * Parse JSON from an LLM text response.
 * Tries: raw parse -> ```json block -> ``` block -> first {}/{[ block -> raw text
 */
const parseJsonResponse = (text) => {
  if (!text) return text
  try { return JSON.parse(text) } catch (e) { /* continue */ }

  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()) } catch (e) { /* continue */ }
  }

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
