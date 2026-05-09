// freezr.info - Anthropic LLM Connector
// Adapter to translate freezr's standard LLM format into Anthropic API calls.
//
// Connector contract for any provider adapter:
// - `listModels({ apiKey })` -> [{ id, family, provider, version, ... }]
// - `parseModelId(id)` -> { id, family, provider, version }
// - `getPricing({ apiKey, targetModel? })` -> { models, source, sourceModel } | null
// - `ask({ apiKey, prompt, context, model, max_tokens, role, responseType, thinking, files })`
//      -> { response, thinking, provider, model, family, rawUsage, tokensUsed }
// - `getFamilyFromModelId(id)` -> canonical family key used by pricing/ping snapshots
//
// The controller uses these exports to build `freezr.llm.ping()` results:
// `{ success, exists, defaultProvider, defaultFamily, providers, imageProviders, pricingMeta }`
// Not all features have been tested!!

import Anthropic from '@anthropic-ai/sdk'

export const DEFAULT_FAMILY = 'sonnet'

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

// Claude Opus 4.7 only supports adaptive thinking mode.
// Sending `{ type: 'enabled', budget_tokens }` is rejected with a 400 error.
// For all earlier thinking-capable models we keep the explicit budget form.
const isAdaptiveOnlyThinkingModel = (modelId) => {
  if (!modelId) return false
  return /opus-4-7/i.test(modelId)
}

const buildThinkingConfig = (modelId, thinking, maxTokens) => {
  if (!thinking) return null
  if (isAdaptiveOnlyThinkingModel(modelId)) {
    return { type: 'adaptive' }
  }
  const budgetTokens = (typeof thinking === 'object' && thinking.budget_tokens)
    ? thinking.budget_tokens
    : Math.min(10000, maxTokens - 1)
  return { type: 'enabled', budget_tokens: budgetTokens }
}

const standardizeUsage = (usage) => {
  if (!usage) {
    return {
      input: { qtty: 0, cost: 0 },
      output: { qtty: 0, cost: 0 },
      other: { qtty: 0, cost: 0, details: {} }
    }
  }
  const inputQty = usage.input_tokens || 0
  const outputQty = usage.output_tokens || 0
  return {
    input: { qtty: inputQty, cost: 0 },
    output: { qtty: outputQty, cost: 0 },
    // Keep provider-specific details in `rawUsage`; this shape stays minimal and stable.
    other: { qtty: 0, cost: 0, details: {} }
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
 * @param {Object[]} [params.files] - Array of multer file objects (buffer + originalname)
 * @returns {Promise<Object>} { response, thinking, provider, model, usage }
 */
export const ask = async ({ apiKey, prompt, context, model, max_tokens, role, responseType, thinking, files }) => {
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

  // Extended thinking: temperature must be 1. For most models we pass an explicit
  // budget_tokens, but Claude Opus 4.7 rejects that and only accepts `adaptive`.
  const thinkingConfig = buildThinkingConfig(modelToUse, thinking, maxTokens)
  if (thinkingConfig) {
    params.thinking = thinkingConfig
    params.temperature = 1
  }

  const { textResponse, thinkingResponse, usage } = await streamAndCollect(client, params)
  const response = responseType === 'json' ? parseJsonResponse(textResponse) : textResponse

  return {
    response,
    thinking: thinkingResponse || null,
    provider: 'Claude',
    model: modelToUse,
    family: getFamilyFromModelId(modelToUse),
    rawUsage: usage,
    tokensUsed: standardizeUsage(usage)
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
    .map(m => ({ ...parseModelId(m.id), created_at: m.created_at }))
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

export const getPricing = async ({ apiKey, targetModel = null }) => {
  let modelIds = []
  try {
    modelIds = (await listModels({ apiKey })).map(m => m.id)
  } catch (e) {
    console.warn('Could not fetch Anthropic models for pricing:', e.message)
  }

  const prompt = targetModel
    ? makeSingleModelPricingPrompt(targetModel)
    : makePricingPromptWithModels(modelIds.length > 0
      ? modelIds
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

  return models
    ? { models, source: 'llm_self_report', sourceModel: llmResult.model }
    : null
}

const streamAndCollect = async (client, params) => {
  const stream = await client.messages.create(params)
  let textResponse = ''
  let thinkingResponse = ''
  let currentBlockType = null
  let usage = null
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_start') {
      currentBlockType = chunk.content_block?.type || null
    } else if (chunk.type === 'content_block_delta') {
      if (chunk.delta.type === 'thinking_delta') {
        thinkingResponse += chunk.delta.thinking
      } else if (chunk.delta.type === 'text_delta') {
        textResponse += chunk.delta.text
      }
    } else if (chunk.type === 'content_block_stop') {
      currentBlockType = null
    } else if (chunk.type === 'message_delta' && chunk.usage) {
      usage = chunk.usage
    }
  }
  return { textResponse, thinkingResponse, usage }
}

/**
 * Streaming variant of ask(). Returns an async generator that yields chunk objects:
 *   { type: 'delta', text }     – incremental text content
 *   { type: 'thinking', text }  – incremental thinking content
 *   { type: 'done', response, thinking, provider, model, family, rawUsage, tokensUsed }
 *
 * Same params as ask() except responseType is ignored (raw text is always yielded).
 */
export async function * askStream ({ apiKey, prompt, context, model, max_tokens, role, thinking, files }) {
  const client = new Anthropic({ apiKey })
  const modelToUse = await resolveModel(client, model)
  const maxTokens = max_tokens || DEFAULT_MAX_TOKENS

  let messages
  if (Array.isArray(prompt)) {
    messages = prompt
  } else {
    messages = [{ role: role || 'user', content: prompt || '' }]
  }

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

  const thinkingConfig = buildThinkingConfig(modelToUse, thinking, maxTokens)
  if (thinkingConfig) {
    params.thinking = thinkingConfig
    params.temperature = 1
  }

  const stream = await client.messages.create(params)
  let textResponse = ''
  let thinkingResponse = ''
  let usage = null

  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta') {
      if (chunk.delta.type === 'thinking_delta') {
        thinkingResponse += chunk.delta.thinking
        yield { type: 'thinking', text: chunk.delta.thinking }
      } else if (chunk.delta.type === 'text_delta') {
        textResponse += chunk.delta.text
        yield { type: 'delta', text: chunk.delta.text }
      }
    } else if (chunk.type === 'message_delta' && chunk.usage) {
      usage = chunk.usage
    }
  }

  yield {
    type: 'done',
    response: textResponse,
    thinking: thinkingResponse || null,
    provider: 'Claude',
    model: modelToUse,
    family: getFamilyFromModelId(modelToUse),
    rawUsage: usage,
    tokensUsed: standardizeUsage(usage)
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
