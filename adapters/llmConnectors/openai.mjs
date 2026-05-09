// freezr.info - OpenAI LLM Connector
// Adapter to translate freezr's standard LLM format into OpenAI API calls.
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

import OpenAI from 'openai'

export const DEFAULT_FAMILY = 'gpt-5.5'

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

const isResponsesOnlyModel = (id) => (
  /^gpt-\d+(?:\.\d+)?(?:o)?-pro(?:-|$)/.test(id) ||
  /^o[13]-pro(?:-|$)/.test(id)
)

const isKnownChatModelName = (id) => (
  id.startsWith('gpt-') ||
  id.startsWith('o1') ||
  id.startsWith('o3') ||
  id.startsWith('o4') ||
  id.startsWith('chatgpt-')
)

const NON_CHAT_MODEL_MARKERS = [
  'audio',
  'babbage',
  'codex',
  'computer-use',
  'dall-e',
  'davinci',
  'deep-research',
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
  isResponsesOnlyModel(id) ||
  NON_CHAT_MODEL_MARKERS.some(marker => id.includes(marker))
)

const isChatModel = (id) => {
  return isKnownChatModelName(id) && !isExcludedFromChatCompletions(id)
}

const isPotentialChatModel = (id) => Boolean(id) && !isExcludedFromChatCompletions(id)

const isImageModel = (id) => id.includes('image')

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

const standardizeUsage = (usage) => {
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
  const otherQty = Math.max(0, totalQty - inputQty - outputQty)

  return {
    input: { qtty: inputQty, cost: 0 },
    output: { qtty: outputQty, cost: 0 },
    other: { qtty: otherQty, cost: 0, details: reasoningQty ? { reasoningTokens: reasoningQty } : {} }
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
      const reasoningModel = available.find(m => supportsReasoningEffort(m.id))
      if (reasoningModel) return reasoningModel.id
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

const supportsReasoningEffort = (modelId) => {
  const normalized = normalizeModelId(modelId)
  return /^o\d(?:-|$)/.test(normalized) || /^gpt-5(?:\.|-|$)/.test(normalized)
}

const applyReasoningEffort = (params, modelId, thinking) => {
  delete params.reasoning_effort
  if (!thinking) return
  if (!supportsReasoningEffort(modelId)) {
    console.warn('OpenAI model', modelId, 'does not support reasoning_effort; omitting thinking option.')
    return
  }
  const effort = (typeof thinking === 'object' && thinking.effort) ? thinking.effort : 'medium'
  params.reasoning_effort = effort
}

const isNotChatModelError = (err) => {
  const message = (err?.message || err?.error?.message || '').toLowerCase()
  return err?.status === 404 && message.includes('not a chat model')
}

const createChatCompletionWithFallback = async ({ client, params, explicitModel, thinking }) => {
  const originalModel = params?.model
  try {
    return await client.chat.completions.create(params)
  } catch (err) {
    if (!isNotChatModelError(err) || !params?.model) throw err
    const fallbackModel = await resolveDefaultModel(client, thinking)
    if (!fallbackModel || fallbackModel === params.model) throw err
    console.warn('OpenAI model', params.model, 'is not supported by chat completions; retrying with', fallbackModel)
    params.model = fallbackModel
    applyReasoningEffort(params, fallbackModel, thinking)
    const completion = await client.chat.completions.create(params)
    completion._freezrFallbackModel = fallbackModel
    completion._freezrOriginalModel = explicitModel || originalModel
    return completion
  }
}

export const ask = async ({ apiKey, prompt, context, model, max_tokens, role, responseType, thinking, files }) => {
  const client = new OpenAI({ apiKey })
  const modelToUse = await resolveModel(client, model, thinking)

  if (files && files.length > 0) {
    return askWithFiles({ client, prompt, context, model: modelToUse, role, responseType, files })
  }

  let messages = []
  if (context) messages.push({ role: 'system', content: context })

  if (Array.isArray(prompt)) {
    messages = messages.concat(prompt)
  } else {
    messages.push({ role: role || 'user', content: prompt || '' })
  }

  const params = { model: modelToUse, messages }
  if (max_tokens) params.max_completion_tokens = max_tokens

  applyReasoningEffort(params, modelToUse, thinking)

  const completion = await createChatCompletionWithFallback({ client, params, explicitModel: model, thinking })
  const finalModel = completion._freezrFallbackModel || modelToUse
  const message = completion.choices?.[0]?.message
  const textResponse = message?.content || ''
  const thinkingResponse = message?.reasoning_content || null
  const response = responseType === 'json' ? parseJsonResponse(textResponse) : textResponse

  return {
    response,
    thinking: thinkingResponse,
    provider: 'ChatGPT',
    model: finalModel,
    family: getFamilyFromModelId(finalModel),
    rawUsage: completion.usage || null,
    tokensUsed: standardizeUsage(completion.usage || null)
  }
}

/**
 * Streaming variant of ask(). Returns an async generator that yields chunk objects:
 *   { type: 'delta', text }     – incremental text content
 *   { type: 'thinking', text }  – incremental reasoning content (o-series)
 *   { type: 'done', response, thinking, provider, model, family, rawUsage, tokensUsed }
 *
 * Same params as ask() except responseType is ignored (raw text is always yielded).
 */
export async function * askStream ({ apiKey, prompt, context, model, max_tokens, role, thinking }) {
  const client = new OpenAI({ apiKey })
  const modelToUse = await resolveModel(client, model, thinking)

  let messages = []
  if (context) messages.push({ role: 'system', content: context })

  if (Array.isArray(prompt)) {
    messages = messages.concat(prompt)
  } else {
    messages.push({ role: role || 'user', content: prompt || '' })
  }

  const params = { model: modelToUse, messages, stream: true, stream_options: { include_usage: true } }
  if (max_tokens) params.max_completion_tokens = max_tokens

  applyReasoningEffort(params, modelToUse, thinking)

  const stream = await createChatCompletionWithFallback({ client, params, explicitModel: model, thinking })
  const finalModel = stream._freezrFallbackModel || modelToUse
  let textResponse = ''
  let thinkingResponse = ''
  let usage = null

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta
    if (delta?.reasoning_content) {
      thinkingResponse += delta.reasoning_content
      yield { type: 'thinking', text: delta.reasoning_content }
    }
    if (delta?.content) {
      textResponse += delta.content
      yield { type: 'delta', text: delta.content }
    }
    if (chunk.usage) {
      usage = chunk.usage
    }
  }

  yield {
    type: 'done',
    response: textResponse,
    thinking: thinkingResponse || null,
    provider: 'ChatGPT',
    model: finalModel,
    family: getFamilyFromModelId(finalModel),
    rawUsage: usage,
    tokensUsed: standardizeUsage(usage)
  }
}

/**
 * Handle file-based queries using OpenAI's assistants API.
 * Supports multiple files.
 */
const askWithFiles = async ({ client, prompt, context, model, role, responseType, files }) => {
  const fs = await import('fs')
  const path = await import('path')
  const { fileURLToPath } = await import('url')
  const { v4: uuidv4 } = await import('uuid')

  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const tempPaths = []
  const uploadedFileIds = []

  try {
    for (const file of files) {
      const tempPath = path.join(__dirname, uuidv4() + '-' + file.originalname)
      tempPaths.push(tempPath)
      await fs.promises.writeFile(tempPath, file.buffer)
      const fileStream = fs.createReadStream(tempPath)
      const uploaded = await client.files.create({ file: fileStream, purpose: 'assistants' })
      uploadedFileIds.push(uploaded.id)
    }

    const instructions = context || 'You are a diligent assistant who reads files and answers questions about them.'
    const assistant = await client.beta.assistants.create({
      name: 'Freezr File Assistant',
      instructions,
      model,
      tools: [{ type: 'file_search' }]
    })

    const vectorStore = await client.beta.vectorStores.create({ name: 'freezr_temp_store' })
    await client.beta.assistants.update(assistant.id, {
      tool_resources: { file_search: { vector_store_ids: [vectorStore.id] } }
    })

    const promptText = Array.isArray(prompt)
      ? prompt.filter(m => m.role === 'user').map(m => m.content).join('\n')
      : (prompt || 'Please summarise the attached documents.')

    const thread = await client.beta.threads.create({
      messages: [{
        role: role || 'user',
        content: promptText,
        attachments: uploadedFileIds.map(id => ({ file_id: id, tools: [{ type: 'file_search' }] }))
      }]
    })

    const run = await client.beta.threads.runs.createAndPoll(thread.id, { assistant_id: assistant.id })
    const responseMessages = await client.beta.threads.messages.list(thread.id, { run_id: run.id })
    const message = responseMessages.data.pop()
    const textResponse = message?.content?.[0]?.type === 'text'
      ? message.content[0].text.value
      : JSON.stringify(message?.content)

    const response = responseType === 'json' ? parseJsonResponse(textResponse) : textResponse

    // Cleanup
    try { await client.beta.threads.del(thread.id) } catch (e) { /* ignore */ }
    try { await client.beta.vectorStores.del(vectorStore.id) } catch (e) { /* ignore */ }
    try { await client.beta.assistants.del(assistant.id) } catch (e) { /* ignore */ }
    for (const fid of uploadedFileIds) { try { await client.files.del(fid) } catch (e) { /* ignore */ } }

    return {
      response,
      provider: 'ChatGPT',
      model,
      family: getFamilyFromModelId(model),
      rawUsage: null,
      tokensUsed: standardizeUsage(null)
    }
  } finally {
    for (const tp of tempPaths) { try { await fs.promises.unlink(tp) } catch (e) { /* ignore */ } }
  }
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
