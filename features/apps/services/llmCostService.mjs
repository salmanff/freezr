// freezr.info — LLM cost & pricing helpers — llmCostService.mjs
//
// Pure functions extracted verbatim from cepsfepsApiController.mjs so that both the LLM
// controller and the usage-tally service can share one implementation of the token/cost
// maths. Nothing here touches a db or a network: the db-bound pricing helpers
// (getPricingRecord / upsertPricingRecord / refreshProviderPricing / refreshImagePricing)
// stay in the controller.
//
// Note on model keys: sanitizeModelKeys/unsanitizeModelKeys exist for the pricing table
// (info.freezr.account.llmpricing), which uses model ids as OBJECT KEYS and so cannot hold
// a '.' (mongo field-name rule). The '_' -> '.' reverse is lossy for ids that already
// contain '_', which is why info.freezr.account.usageTallies stores its per-model
// breakdown as an ARRAY of { model, ... } entries and never sanitizes.

export const sanitizeModelKeys = (models) => {
  if (!models || typeof models !== 'object') return models
  const clean = {}
  for (const [key, val] of Object.entries(models)) {
    clean[key.replace(/\./g, '_')] = val
  }
  return clean
}

export const canonicalizeModelKey = (provider, key) => {
  if (!key) return key
  if (provider === 'ChatGPT') {
    return key
      .replace(/-\d{4}-\d{2}-\d{2}$/, '')
      .replace(/-latest$/, '')
  }
  return key
}

export const canonicalizeModelMap = (provider, models) => {
  if (!models || typeof models !== 'object') return models
  const clean = {}
  for (const [key, val] of Object.entries(models)) {
    clean[canonicalizeModelKey(provider, key)] = val
  }
  return clean
}

export const unsanitizeModelKeys = (models) => {
  if (!models || typeof models !== 'object') return models
  const clean = {}
  for (const [key, val] of Object.entries(models)) {
    clean[key.replace(/_/g, '.')] = val
  }
  return clean
}

// Providers whose models genuinely cost $0 per call (the ClaudeLocal connector runs on the
// owner's subscription). For everyone else an all-zero row is a placeholder to reject —
// models mis-report their own prices — but here zero IS the price, and keeping the row is
// what makes downstream cost figures an honest $0.00 rather than "unknown".
export const ZERO_COST_PROVIDERS = ['ClaudeLocal', 'CodexLocal']

export const normalizePricingModels = (provider, models) => {
  if (!models || typeof models !== 'object') return null
  const normalized = {}
  for (const [rawKey, rawVal] of Object.entries(models)) {
    if (!rawVal || typeof rawVal !== 'object') continue
    const input = Number(rawVal.input)
    const output = Number(rawVal.output)
    const cachedInput = rawVal.cachedInput !== undefined ? Number(rawVal.cachedInput) : null
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue
    if (input <= 0 && output <= 0 && !ZERO_COST_PROVIDERS.includes(provider)) continue

    const key = canonicalizeModelKey(provider, rawKey)
    normalized[key] = { input, output }
    if (Number.isFinite(cachedInput) && cachedInput >= 0) {
      normalized[key].cachedInput = cachedInput
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : null
}

export const makeEmptyTokensUsed = (tokensUsed = {}) => ({
  input: { qtty: tokensUsed.input?.qtty || 0, cost: null },
  output: { qtty: tokensUsed.output?.qtty || 0, cost: null },
  other: {
    qtty: tokensUsed.other?.qtty || 0,
    cost: null,
    details: tokensUsed.other?.details || {}
  }
})

export const getModelFamily = (provider, modelId) => {
  const canonical = canonicalizeModelKey(provider, modelId || '')
  // ClaudeLocal shares Claude's id grammar ('sonnet' aliases parse to themselves)
  if (provider === 'Claude' || provider === 'ClaudeLocal') {
    const stripped = canonical
      .replace(/^claude-/, '')
      .replace(/-\d{8}$/, '')
    const segments = stripped.split('-')
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
  return canonical
}

export const isValidPrice = (entry) => (
  entry && entry.input !== undefined && entry.output !== undefined && !entry.lookup_failed
)

export const findModelPrice = (provider, pricingModels, modelId, family) => {
  if (!pricingModels) return null
  const canonicalId = canonicalizeModelKey(provider, modelId || '')
  if (isValidPrice(pricingModels[canonicalId])) {
    return { key: canonicalId, ...pricingModels[canonicalId] }
  }
  const wantedFamily = family || getModelFamily(provider, modelId)
  for (const [key, entry] of Object.entries(pricingModels)) {
    if (isValidPrice(entry) && getModelFamily(provider, key) === wantedFamily) {
      return { key, ...entry }
    }
  }
  return null
}

export const isLookupFailedForModel = (provider, pricingModels, modelId) => {
  if (!pricingModels) return false
  const canonicalId = canonicalizeModelKey(provider, modelId || '')
  return pricingModels[canonicalId]?.lookup_failed === true
}

export const buildCostSummary = (tokensUsed) => {
  const inputTokens = tokensUsed?.input?.qtty || 0
  const outputTokens = tokensUsed?.output?.qtty || 0
  const otherTokens = tokensUsed?.other?.qtty || 0
  const inputCost = tokensUsed?.input?.cost || 0
  const outputCost = tokensUsed?.output?.cost || 0
  const otherCost = tokensUsed?.other?.cost || 0
  return {
    inputTokens,
    outputTokens,
    otherTokens,
    totalTokens: inputTokens + outputTokens + otherTokens,
    inputCost,
    outputCost,
    otherCost,
    totalCost: inputCost + outputCost + otherCost
  }
}

export const applyPriceToTokensUsed = (tokensUsed, price) => {
  const normalized = makeEmptyTokensUsed(tokensUsed)
  if (!price) return { tokensUsed: normalized, cost: null }

  const details = normalized.other.details || {}

  // Cached-prompt tokens, two provider conventions:
  // - Anthropic (the `cache` ask option): cacheReadTokens / cacheCreationTokens are EXCLUDED
  //   from input.qtty — extra volume priced under `other`. Reads bill at the cached-input rate
  //   (price.cachedInput, else the ~10%-of-input convention); WRITES bill at a premium that
  //   depends on the entry's TTL — 1.25x for 5-minute entries, 2x for 1-hour ones. The connector
  //   passes the provider's TTL split (cacheCreation1hTokens / cacheCreation5mTokens); when the
  //   split is missing (older connector, other provider) every write is priced at 1.25x.
  // - OpenAI (automatic caching): cachedPromptTokens are INCLUDED in input.qtty — the cached
  //   share of input is re-priced at the cached rate (price.cachedInput, else 50%), not added.
  const cachedPrompt = Math.min(details.cachedPromptTokens || 0, normalized.input.qtty)
  if (cachedPrompt) {
    const cachedRate = Number.isFinite(price.cachedInput) ? price.cachedInput : price.input * 0.5
    normalized.input.cost = ((normalized.input.qtty - cachedPrompt) / 1000000) * price.input +
      (cachedPrompt / 1000000) * cachedRate
  } else {
    normalized.input.cost = (normalized.input.qtty / 1000000) * price.input
  }
  normalized.output.cost = (normalized.output.qtty / 1000000) * price.output

  let otherCost = 0
  if (details.cacheReadTokens) {
    const cachedRate = Number.isFinite(price.cachedInput) ? price.cachedInput : price.input * 0.1
    otherCost += (details.cacheReadTokens / 1000000) * cachedRate
  }
  if (details.cacheCreationTokens) {
    const total = details.cacheCreationTokens
    const w1h = Math.min(Number(details.cacheCreation1hTokens) || 0, total)
    otherCost += (w1h / 1000000) * price.input * 2
    otherCost += ((total - w1h) / 1000000) * price.input * 1.25
  }
  // Server tools (web search/fetch) bill PER REQUEST at a flat rate per 1,000, not per token.
  // The counts deliberately never reach other.qtty — totalTokens must stay a token figure —
  // so they are priced here from `details` and land only in the cost totals.
  if (details.webSearchRequests && Number.isFinite(price.webSearchPer1000)) {
    otherCost += (details.webSearchRequests / 1000) * price.webSearchPer1000
  }
  if (details.webFetchRequests && Number.isFinite(price.webFetchPer1000)) {
    otherCost += (details.webFetchRequests / 1000) * price.webFetchPer1000
  }
  normalized.other.cost = otherCost

  return {
    tokensUsed: normalized,
    cost: buildCostSummary(normalized)
  }
}

export const normalizeModelId = (id) => (id || '').toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-latest$/, '')

export const IMAGE_PRICING_SUFFIX = '_image'

export const getImagePricingProvider = (provider) => provider + IMAGE_PRICING_SUFFIX

export const findImageModelPrice = (pricingModels, modelId) => {
  if (!pricingModels || !modelId) return null
  const normalId = normalizeModelId(modelId)
  for (const [key, entry] of Object.entries(pricingModels)) {
    const normKey = normalizeModelId(key)
    if (normKey === normalId || key === modelId) {
      if (entry.text_input !== undefined && entry.image_output !== undefined) {
        const price = { ...entry }
        if (price.text_input < 0.1 && price.image_output < 0.1) {
          console.warn('🖼️ Image prices look like per-1K, normalizing to per-1M')
          // hack for getting wrng unit prices from
          price.text_input *= 1000
          price.image_input = (price.image_input || 0) * 1000
          price.image_output *= 1000
        }
        return price
      }
    }
  }
  return null
}

export const applyImagePriceToTokensUsed = (tokensUsed, price) => {
  const normalized = makeEmptyTokensUsed(tokensUsed)
  if (!price) return { tokensUsed: normalized, cost: null }

  const details = tokensUsed?.other?.details || {}
  const textInputTokens = details.textInputTokens || 0
  const imageInputTokens = details.imageInputTokens || 0
  const outputTokens = normalized.output.qtty || 0

  const textInputCost = (textInputTokens / 1000000) * (price.text_input || 0)
  const imageInputCost = (imageInputTokens / 1000000) * (price.image_input || 0)
  const outputCost = (outputTokens / 1000000) * (price.image_output || 0)

  normalized.input.cost = textInputCost + imageInputCost
  normalized.output.cost = outputCost
  normalized.other.details = {
    ...details,
    textInputCost,
    imageInputCost
  }

  return {
    tokensUsed: normalized,
    cost: buildCostSummary(normalized)
  }
}

// ── Voice (speech-to-text / text-to-speech) ──────────────────────────────────────────────
//
// A third pricing namespace beside text and images, because audio models bill on axes the
// text table has no room for: an audio token is not a text token and does not cost the same.
// A record looks like
//   { input, output, audio_input, audio_output, per_million_characters }
// all in USD per 1,000,000 units, and a model uses only the axes it actually reports.
//
// THE ASYMMETRY THAT MATTERS, and the reason per_million_characters exists at all:
//   transcribe() gets a real `usage` block back and is metered exactly.
//   speak() DOES NOT. The speech endpoint returns raw audio bytes and no usage of any kind,
//   so there is nothing to count after the fact. Billing it as zero would be the same silent
//   under-report as the missing web-search rate was (see the server-tool tests below), so a
//   TTS call is priced on the exact CHARACTER count of the text that was sent — which is the
//   unit the older TTS models bill in anyway, and which tracks audio duration closely enough
//   to be an honest estimate rather than a guess. Anything priced this way is marked
//   `costEstimated: true` in the details so a caller can tell it apart from a measured cost.
export const AUDIO_PRICING_SUFFIX = '_audio'

export const getAudioPricingProvider = (provider) => provider + AUDIO_PRICING_SUFFIX

const AUDIO_PRICE_AXES = ['input', 'output', 'audio_input', 'audio_output', 'per_million_characters']

export const findAudioModelPrice = (pricingModels, modelId) => {
  if (!pricingModels || !modelId) return null
  const normalId = normalizeModelId(modelId)
  for (const [key, entry] of Object.entries(pricingModels)) {
    if (!entry || typeof entry !== 'object') continue
    if (normalizeModelId(key) !== normalId && key !== modelId) continue
    // A row with none of the audio axes is a text row that landed in the wrong namespace;
    // returning it would price audio tokens at text rates.
    if (!AUDIO_PRICE_AXES.some(axis => Number.isFinite(Number(entry[axis])))) return null
    return { ...entry }
  }
  return null
}

export const applyAudioPriceToTokensUsed = (tokensUsed, price) => {
  const normalized = makeEmptyTokensUsed(tokensUsed)
  if (!price) return { tokensUsed: normalized, cost: null }

  const details = tokensUsed?.other?.details || {}
  const rate = (axis) => (Number.isFinite(Number(price[axis])) ? Number(price[axis]) : 0)
  const per1M = (qtty, axis) => ((qtty || 0) / 1000000) * rate(axis)

  const textInputTokens = details.textInputTokens || 0
  const audioInputTokens = details.audioInputTokens || 0
  const audioOutputTokens = details.audioOutputTokens || 0
  // Anything the provider counted as input but did not break down is text.
  const untypedInput = Math.max(0, (normalized.input.qtty || 0) - textInputTokens - audioInputTokens)
  const untypedOutput = Math.max(0, (normalized.output.qtty || 0) - audioOutputTokens)

  let inputCost = per1M(textInputTokens + untypedInput, 'input') + per1M(audioInputTokens, 'audio_input')
  let outputCost = per1M(untypedOutput, 'output') + per1M(audioOutputTokens, 'audio_output')
  let estimated = false

  // No usage at all — a speak() call. Price the characters we know were sent.
  if (!normalized.input.qtty && !normalized.output.qtty && details.characters && rate('per_million_characters')) {
    inputCost = per1M(details.characters, 'per_million_characters')
    outputCost = 0
    estimated = true
  }

  normalized.input.cost = inputCost
  normalized.output.cost = outputCost
  normalized.other.cost = 0
  normalized.other.details = estimated ? { ...details, costEstimated: true } : { ...details }

  return {
    tokensUsed: normalized,
    cost: buildCostSummary(normalized)
  }
}
