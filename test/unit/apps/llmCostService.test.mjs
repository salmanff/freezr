// Unit tests for the LLM pricing/cost maths (features/apps/services/llmCostService.mjs),
// extracted from cepsfepsApiController so both the LLM response path and the usage meter
// price a call identically.
//
// The subtle part is prompt caching, where the two providers report opposite things:
//   Anthropic — cache read/write tokens are EXCLUDED from input.qtty, so they are extra
//               volume priced under `other` (reads cheap, writes at a 1.25x premium).
//   OpenAI    — cached tokens are INCLUDED in prompt_tokens, so the cached SHARE of input
//               is re-priced cheaper, never added on top.
// Getting that backwards silently over- or under-bills every cached call, which is why the
// conventions are pinned here rather than left to the controller.
import { expect } from 'chai'
import {
  sanitizeModelKeys, unsanitizeModelKeys, canonicalizeModelKey, canonicalizeModelMap,
  normalizePricingModels, makeEmptyTokensUsed, getModelFamily, isValidPrice, findModelPrice,
  isLookupFailedForModel, buildCostSummary, applyPriceToTokensUsed, normalizeModelId,
  getImagePricingProvider, findImageModelPrice, applyImagePriceToTokensUsed
} from '../../../features/apps/services/llmCostService.mjs'

const M = 1000000
const tokens = ({ input = 0, output = 0, other = 0, details = {} } = {}) => ({
  input: { qtty: input, cost: 0 },
  output: { qtty: output, cost: 0 },
  other: { qtty: other, cost: 0, details }
})

describe('llmCostService — applyPriceToTokensUsed', function () {
  const price = { input: 3, output: 15 } // USD per million

  it('prices plain input and output per million tokens', function () {
    const out = applyPriceToTokensUsed(tokens({ input: M, output: M / 2 }), price)
    expect(out.tokensUsed.input.cost).to.be.closeTo(3, 1e-12)
    expect(out.tokensUsed.output.cost).to.be.closeTo(7.5, 1e-12)
    expect(out.cost.totalCost).to.be.closeTo(10.5, 1e-12)
    expect(out.cost.totalTokens).to.equal(M + M / 2)
  })

  it('returns cost:null (and null per-bucket costs) when the model has no price', function () {
    const out = applyPriceToTokensUsed(tokens({ input: 100, output: 100 }), null)
    expect(out.cost).to.equal(null)
    expect(out.tokensUsed.input).to.deep.equal({ qtty: 100, cost: null })
    expect(out.tokensUsed.output.qtty).to.equal(100)
  })

  it('Anthropic: cache READS bill at the cached rate, on top of input', function () {
    const withRate = applyPriceToTokensUsed(
      tokens({ input: M, output: 0, other: M, details: { cacheReadTokens: M } }),
      { ...price, cachedInput: 0.3 })
    expect(withRate.tokensUsed.input.cost).to.be.closeTo(3, 1e-12) // input untouched
    expect(withRate.tokensUsed.other.cost).to.be.closeTo(0.3, 1e-12)
    expect(withRate.cost.totalCost).to.be.closeTo(3.3, 1e-12)

    // No published cached rate: falls back to the ~10%-of-input convention.
    const noRate = applyPriceToTokensUsed(
      tokens({ input: 0, output: 0, other: M, details: { cacheReadTokens: M } }), price)
    expect(noRate.tokensUsed.other.cost).to.be.closeTo(0.3, 1e-12)
  })

  it('Anthropic: cache WRITES bill at a 1.25x premium over input', function () {
    const out = applyPriceToTokensUsed(
      tokens({ other: M, details: { cacheCreationTokens: M } }), price)
    expect(out.tokensUsed.other.cost).to.be.closeTo(3.75, 1e-12)
  })

  it('Anthropic: 1-hour cache WRITES bill at 2x, 5-minute ones at 1.25x, from the TTL split', function () {
    const out = applyPriceToTokensUsed(
      tokens({ other: M, details: { cacheCreationTokens: M, cacheCreation1hTokens: M, cacheCreation5mTokens: 0 } }), price)
    expect(out.tokensUsed.other.cost).to.be.closeTo(6, 1e-12)
    const mixed = applyPriceToTokensUsed(
      tokens({ other: M, details: { cacheCreationTokens: M, cacheCreation1hTokens: M / 2, cacheCreation5mTokens: M / 2 } }), price)
    expect(mixed.tokensUsed.other.cost).to.be.closeTo(3 + 1.875, 1e-12)
    // a 1h count larger than the total (bad split) is clamped — never priced twice
    const clamped = applyPriceToTokensUsed(
      tokens({ other: M, details: { cacheCreationTokens: M, cacheCreation1hTokens: 2 * M } }), price)
    expect(clamped.tokensUsed.other.cost).to.be.closeTo(6, 1e-12)
  })

  it('Anthropic: reads and writes in one call are added, not overwritten', function () {
    const out = applyPriceToTokensUsed(
      tokens({ other: 2 * M, details: { cacheReadTokens: M, cacheCreationTokens: M } }), price)
    expect(out.tokensUsed.other.cost).to.be.closeTo(0.3 + 3.75, 1e-12)
  })

  it('OpenAI: cached prompt tokens re-price the cached SHARE of input, never add to it', function () {
    const p = { input: 2.5, output: 10 }
    // 1M input of which 500k came from cache; no published cached rate -> 50% convention.
    const out = applyPriceToTokensUsed(
      tokens({ input: M, output: 0, details: { cachedPromptTokens: M / 2 } }), p)
    expect(out.tokensUsed.input.cost).to.be.closeTo(1.25 + 0.625, 1e-12)
    expect(out.tokensUsed.other.cost).to.equal(0)
    // Strictly cheaper than the uncached price, and never more expensive.
    expect(out.tokensUsed.input.cost).to.be.below(2.5)

    const withRate = applyPriceToTokensUsed(
      tokens({ input: M, details: { cachedPromptTokens: M / 2 } }), { ...p, cachedInput: 0.25 })
    expect(withRate.tokensUsed.input.cost).to.be.closeTo(1.25 + 0.125, 1e-12)
  })

  it('OpenAI: a cached count larger than input is clamped, never negative-priced', function () {
    const out = applyPriceToTokensUsed(
      tokens({ input: 1000, details: { cachedPromptTokens: 99999 } }), { input: 2.5, output: 10 })
    expect(out.tokensUsed.input.cost).to.be.at.least(0)
    expect(out.tokensUsed.input.cost).to.be.closeTo((1000 / M) * 1.25, 1e-12)
  })

  it('zero usage prices to zero, not to null', function () {
    const out = applyPriceToTokensUsed(tokens({}), { input: 3, output: 15 })
    expect(out.cost.totalCost).to.equal(0)
    expect(out.cost.totalTokens).to.equal(0)
  })
})

describe('llmCostService — buildCostSummary / makeEmptyTokensUsed', function () {
  it('sums the three buckets for tokens and dollars', function () {
    const summary = buildCostSummary({
      input: { qtty: 10, cost: 1 }, output: { qtty: 20, cost: 2 }, other: { qtty: 30, cost: 3 }
    })
    expect(summary).to.include({ inputTokens: 10, outputTokens: 20, otherTokens: 30, totalTokens: 60, totalCost: 6 })
  })

  it('keeps token counts and cache details but nulls every cost', function () {
    const empty = makeEmptyTokensUsed(tokens({ input: 5, output: 6, other: 7, details: { cacheReadTokens: 7 } }))
    expect(empty.input).to.deep.equal({ qtty: 5, cost: null })
    expect(empty.other.details).to.deep.equal({ cacheReadTokens: 7 })
  })

  it('tolerates a missing/partial tokensUsed', function () {
    expect(makeEmptyTokensUsed().input).to.deep.equal({ qtty: 0, cost: null })
    expect(buildCostSummary(null).totalTokens).to.equal(0)
  })
})

describe('llmCostService — model keys and families', function () {
  it('canonicalizes OpenAI ids by dropping date and -latest suffixes; leaves Claude ids alone', function () {
    expect(canonicalizeModelKey('ChatGPT', 'gpt-5.5-2026-01-15')).to.equal('gpt-5.5')
    expect(canonicalizeModelKey('ChatGPT', 'gpt-4.1-latest')).to.equal('gpt-4.1')
    expect(canonicalizeModelKey('Claude', 'claude-sonnet-4-5-20260101')).to.equal('claude-sonnet-4-5-20260101')
    expect(canonicalizeModelMap('ChatGPT', { 'gpt-5.5-2026-01-15': { input: 1, output: 2 } }))
      .to.have.property('gpt-5.5')
  })

  it('derives a Claude family from an id with a date stamp', function () {
    expect(getModelFamily('Claude', 'claude-sonnet-4-5-20260101')).to.equal('sonnet-4')
    expect(getModelFamily('Claude', 'claude-haiku-4-5')).to.equal('haiku-4')
    expect(getModelFamily('ChatGPT', 'gpt-5.5-2026-01-15')).to.equal('gpt-5.5')
  })

  it('sanitizes dots out of pricing-table keys, and the reverse is lossy', function () {
    expect(sanitizeModelKeys({ 'gpt-5.5': 1 })).to.deep.equal({ 'gpt-5_5': 1 })
    expect(unsanitizeModelKeys({ 'gpt-5_5': 1 })).to.deep.equal({ 'gpt-5.5': 1 })
    // The lossy case: an id that already contains '_' cannot survive the round trip. This
    // is exactly why info.freezr.account.usageTallies stores models in an ARRAY instead.
    expect(unsanitizeModelKeys(sanitizeModelKeys({ my_model: 1 }))).to.deep.equal({ 'my.model': 1 })
    expect(sanitizeModelKeys(null)).to.equal(null)
  })

  it('normalizeModelId lowercases and strips version suffixes', function () {
    expect(normalizeModelId('GPT-Image-1-2026-01-15')).to.equal('gpt-image-1')
    expect(normalizeModelId(null)).to.equal('')
  })
})

describe('llmCostService — findModelPrice', function () {
  const models = {
    'claude-sonnet-4-5-20260101': { input: 3, output: 15 },
    'claude-haiku-4-5': { input: 0.8, output: 4 },
    'claude-opus-4-1': { lookup_failed: true }
  }

  it('prefers an exact canonical match', function () {
    expect(findModelPrice('Claude', models, 'claude-sonnet-4-5-20260101').input).to.equal(3)
  })

  it('falls back to another id in the same family', function () {
    // A newly-released dated build with no row of its own still prices off its family.
    const hit = findModelPrice('Claude', models, 'claude-sonnet-4-5-20260901', 'sonnet-4')
    expect(hit).to.not.equal(null)
    expect(hit.key).to.equal('claude-sonnet-4-5-20260101')
  })

  it('never returns a lookup_failed or malformed entry', function () {
    expect(isValidPrice({ lookup_failed: true })).to.equal(false)
    expect(isValidPrice({ input: 1 })).to.be.oneOf([false, undefined])
    expect(findModelPrice('Claude', models, 'claude-opus-4-1')).to.equal(null)
    expect(findModelPrice('Claude', null, 'anything')).to.equal(null)
  })

  it('reports a model already marked lookup_failed so the caller stops re-asking', function () {
    expect(isLookupFailedForModel('Claude', models, 'claude-opus-4-1')).to.equal(true)
    expect(isLookupFailedForModel('Claude', models, 'claude-haiku-4-5')).to.equal(false)
  })
})

describe('llmCostService — pricing table normalization', function () {
  it('keeps well-formed rows, canonicalizes keys and preserves cachedInput', function () {
    const out = normalizePricingModels('ChatGPT', {
      'gpt-5.5-2026-01-15': { input: '2.5', output: '10', cachedInput: '0.25' }
    })
    expect(out).to.deep.equal({ 'gpt-5.5': { input: 2.5, output: 10, cachedInput: 0.25 } })
  })

  it('drops unusable rows and returns null when nothing survives', function () {
    expect(normalizePricingModels('Claude', { a: { input: 'x', output: 1 }, b: { input: 0, output: 0 }, c: 'nope' })).to.equal(null)
    expect(normalizePricingModels('Claude', null)).to.equal(null)
  })
})

describe('llmCostService — image pricing', function () {
  it('namespaces image prices under a <provider>_image record', function () {
    expect(getImagePricingProvider('ChatGPT')).to.equal('ChatGPT_image')
  })

  it('matches an image model on its normalized id', function () {
    const found = findImageModelPrice({ 'gpt-image-1': { text_input: 5, image_input: 10, image_output: 40 } }, 'gpt-image-1-2026-01-15')
    expect(found.image_output).to.equal(40)
    expect(findImageModelPrice({}, 'gpt-image-1')).to.equal(null)
  })

  it('rescales a price table that came back in per-1K units', function () {
    // Self-reported image prices sometimes arrive per 1K tokens; sub-0.1 values are treated
    // as that mistake and scaled to per-1M.
    const found = findImageModelPrice({ 'gpt-image-1': { text_input: 0.005, image_input: 0.01, image_output: 0.04 } }, 'gpt-image-1')
    expect(found.text_input).to.be.closeTo(5, 1e-9)
    expect(found.image_output).to.be.closeTo(40, 1e-9)
  })

  it('prices text and image input separately from image output', function () {
    const out = applyImagePriceToTokensUsed(
      tokens({ output: M, details: { textInputTokens: M, imageInputTokens: M / 2 } }),
      { text_input: 5, image_input: 10, image_output: 40 })
    expect(out.tokensUsed.input.cost).to.be.closeTo(5 + 5, 1e-12)
    expect(out.tokensUsed.output.cost).to.be.closeTo(40, 1e-12)
    expect(out.cost.totalCost).to.be.closeTo(50, 1e-12)
    expect(out.tokensUsed.other.details).to.include({ textInputCost: 5 })
  })

  it('returns cost:null with no image price', function () {
    expect(applyImagePriceToTokensUsed(tokens({ output: 10 }), null).cost).to.equal(null)
  })
})

describe('server-tool costs (web search)', () => {
  // Web search bills PER REQUEST at a flat rate per 1,000 — not per token. Two things went
  // wrong live and are pinned here: the request count must never inflate totalTokens, and a
  // pricing record cached before server-tool rates existed must not silently bill it at zero.
  const tokens = (details) => ({
    input: { qtty: 1000, cost: 0 },
    output: { qtty: 500, cost: 0 },
    other: { qtty: 0, cost: 0, details }
  })

  it('prices searches per 1,000 requests', () => {
    const r = applyPriceToTokensUsed(tokens({ webSearchRequests: 6 }), { input: 2, output: 10, webSearchPer1000: 10 })
    expect(r.cost.otherCost).to.be.closeTo(0.06, 1e-9)
  })

  it('never counts requests as tokens', () => {
    const r = applyPriceToTokensUsed(tokens({ webSearchRequests: 6 }), { input: 2, output: 10, webSearchPer1000: 10 })
    expect(r.cost.totalTokens).to.equal(1500)
    expect(r.tokensUsed.other.qtty).to.equal(0)
  })

  it('bills zero when the rate is missing — which is why the rate is read from the connector', () => {
    // Reproduces the live miss: a record stored before server-tool rates existed
    // ({key, input, output, cachedInput}) prices 6 real searches at nothing.
    const stale = { key: 'claude-sonnet-5', input: 2, output: 10, cachedInput: 0.2 }
    expect(applyPriceToTokensUsed(tokens({ webSearchRequests: 6 }), stale).cost.otherCost).to.equal(0)
    // …and is fixed by folding the connector's provider-level rates in at request time.
    const repaired = { webSearchPer1000: 10, ...stale }
    expect(applyPriceToTokensUsed(tokens({ webSearchRequests: 6 }), repaired).cost.otherCost).to.be.closeTo(0.06, 1e-9)
  })

  it('leaves cache-token pricing alone', () => {
    const r = applyPriceToTokensUsed(
      { input: { qtty: 1000, cost: 0 }, output: { qtty: 0, cost: 0 }, other: { qtty: 200, cost: 0, details: { cacheReadTokens: 200, webSearchRequests: 1 } } },
      { input: 2, output: 10, cachedInput: 0.2, webSearchPer1000: 10 })
    // 200 cached-read tokens at 0.2/M  +  1 search at $10/1000
    expect(r.cost.otherCost).to.be.closeTo((200 / 1e6) * 0.2 + 0.01, 1e-9)
  })
})
