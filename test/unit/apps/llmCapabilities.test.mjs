// Unit tests for the LLM capability layer:
//   common/helpers/llmCapabilities.mjs        — the vocabulary and the tri-state resolver
//   features/apps/services/llmCapabilityService.mjs — the request gate and error shape
//   adapters/llmConnectors/anthropic.mjs      — tier 2, reading the provider's own tree
//
// The design constraint these pin: freezr must never hold a hand-written list of which model
// supports which feature. Capability is TIER 1 (a fact about our own adapter code), TIER 2
// (read live from the provider's Models API tree) or TIER 3 (learned by trying). The most
// important assertions here are the ones about UNKNOWN — a feature the provider is silent
// about must resolve to 'unknown' and be ALLOWED THROUGH to be probed, never rounded down to
// a 'no'. Rounding it down would silently disable features on every model the provider hasn't
// documented yet, which is the exact failure this design exists to prevent.
import { expect } from 'chai'
import {
  UNKNOWN, CAPABILITY_KEYS, resolveCapability, isPermitted, isConfirmed,
  normalizeWebOption, normalizeStructuredOutput, parseStructuredOutput
} from '../../../common/helpers/llmCapabilities.mjs'
import {
  checkCapabilities, computeSupportedBy, buildCapabilityError,
  CAPABILITY_ERROR, CAPABILITY_ERROR_ON_MODEL
} from '../../../features/apps/services/llmCapabilityService.mjs'
import {
  CAPABILITIES as CLAUDE_CAPS, capabilityTreeFor, readCapabilityLeaf, CAPABILITY_TREE_PATHS
} from '../../../adapters/llmConnectors/anthropic.mjs'
import { CAPABILITIES as GPT_CAPS, getCapabilities as gptCapabilities } from '../../../adapters/llmConnectors/openai.mjs'
import * as claudeConnector from '../../../adapters/llmConnectors/anthropic.mjs'
import * as gptConnector from '../../../adapters/llmConnectors/openai.mjs'

const CLAUDE = { web: { search: true, fetch: true }, vision: true, voice: false }
const CHATGPT = { web: false, vision: true, voice: false }

describe('capability vocabulary', () => {
  it('both connectors declare against the same vocabulary', () => {
    for (const key of CAPABILITY_KEYS) {
      expect(CLAUDE_CAPS, 'anthropic missing ' + key).to.have.property(key)
      expect(GPT_CAPS, 'openai missing ' + key).to.have.property(key)
    }
  })

  it('declares nothing that is not wired — voice is ChatGPT-only, because only ChatGPT has it', () => {
    // The first capability that runs the OTHER way round from web: Anthropic ships no STT or
    // TTS at all, so a voice request there must produce a clean capability_unsupported naming
    // ChatGPT. Flip this to `true` on Claude only when there is code behind it.
    expect(CLAUDE_CAPS.voice).to.equal(false)
    expect(GPT_CAPS.voice).to.deep.equal({ stt: true, tts: true })
  })

  it('openai declares web now that the adapter runs on the Responses API', () => {
    // It was `false` while this adapter was on Chat Completions, which has no web tool. The
    // declaration is about OUR code, so it changed when our code did — not on a schedule.
    expect(GPT_CAPS.web).to.deep.equal({ search: true, fetch: true })
  })

  it('openai declares reasoning TEXT, the other half of the same port', () => {
    // Chat Completions could not return reasoning text at any effort; Responses can, via
    // reasoning.summary. web and thinking.text were always one job, not two.
    expect(GPT_CAPS.thinking).to.deep.equal({ text: true })
    expect(GPT_CAPS.effort).to.equal(true)
  })
})

describe('tri-state resolution', () => {
  it('resolves a nested sub-capability', () => {
    expect(resolveCapability(CLAUDE, 'web.search')).to.equal(true)
    expect(resolveCapability(CHATGPT, 'web')).to.equal(false)
  })

  it('treats a key absent from the map as unsupported', () => {
    expect(resolveCapability(CLAUDE, 'embeddings')).to.equal(false)
  })

  it('propagates UNKNOWN rather than rounding it to a no', () => {
    expect(resolveCapability({ web: UNKNOWN }, 'web')).to.equal(UNKNOWN)
    expect(resolveCapability({ web: UNKNOWN }, 'web.search')).to.equal(UNKNOWN)
    expect(resolveCapability({ web: { search: UNKNOWN } }, 'web.search')).to.equal(UNKNOWN)
  })

  it('returns UNKNOWN for a sub-key of a capability that is only known in general', () => {
    // 'supported, but nothing said about this half' is not the same as 'unsupported'.
    expect(resolveCapability({ web: true }, 'web.search')).to.equal(UNKNOWN)
  })

  it('an all-false detail object is unsupported', () => {
    expect(resolveCapability({ web: { search: false, fetch: false } }, 'web')).to.equal(false)
  })

  it('isPermitted lets UNKNOWN through; isConfirmed does not', () => {
    expect(isPermitted(UNKNOWN)).to.equal(true) // -> probe it
    expect(isPermitted(false)).to.equal(false)
    expect(isConfirmed(UNKNOWN)).to.equal(false) // -> do not promise it in ping
    expect(isConfirmed(true)).to.equal(true)
  })
})

describe('the web request option', () => {
  it('true means everything the provider has', () => {
    expect(normalizeWebOption(true)).to.deep.equal({ search: true, fetch: true, optional: false, raw: null })
  })

  it('naming one half turns the other off', () => {
    expect(normalizeWebOption({ fetch: true })).to.include({ search: false, fetch: true })
    expect(normalizeWebOption({ search: true })).to.include({ search: true, fetch: false })
  })

  it('naming neither half still means both — an options object is not a narrowing', () => {
    expect(normalizeWebOption({ optional: true })).to.include({ search: true, fetch: true, optional: true })
  })

  it('carries the deliberately non-portable raw escape hatch through', () => {
    expect(normalizeWebOption({ raw: { anthropic: [{ type: 'x' }] } }).raw).to.deep.equal({ anthropic: [{ type: 'x' }] })
  })

  it('asking for nothing is null, not an empty request', () => {
    expect(normalizeWebOption(false)).to.equal(null)
    expect(normalizeWebOption(undefined)).to.equal(null)
  })

  it('is idempotent — the controller normalizes, then the connector normalizes again', () => {
    // Both layers call this on the way to the provider. If a second pass changed the shape,
    // { search: true } would silently widen back to both halves inside the connector.
    for (const input of [true, { search: true }, { fetch: true }, { optional: true }]) {
      const once = normalizeWebOption(input)
      expect(normalizeWebOption(once)).to.deep.equal(once)
    }
  })
})

describe('the capability gate', () => {
  const providerCapabilities = { Claude: CLAUDE, ChatGPT: CHATGPT }

  it('passes a supported request through', () => {
    const r = checkCapabilities({ required: ['web.search'], providerCapabilities, provider: 'Claude' })
    expect(r.ok).to.equal(true)
    expect(r.unavailable).to.deep.equal([])
  })

  it('hard-fails an unsupported one by default, and says who could', () => {
    const r = checkCapabilities({ required: ['web.search'], providerCapabilities, provider: 'ChatGPT' })
    expect(r.ok).to.equal(false)
    expect(r.error.code).to.equal(CAPABILITY_ERROR)
    expect(r.error.capability).to.equal('web.search')
    expect(r.error.provider).to.equal('ChatGPT')
    expect(r.error.supportedBy).to.deep.equal(['Claude'])
  })

  it('degrades instead of failing when the caller passed optional', () => {
    const r = checkCapabilities({ required: ['web.search'], optional: true, providerCapabilities, provider: 'ChatGPT' })
    expect(r.ok).to.equal(true)
    expect(r.unavailable).to.deep.equal(['web.search'])
  })

  it('lets UNKNOWN through to be probed rather than blocking it', () => {
    // This is the whole reason freezr needs no per-model table: when the provider has not
    // said, we try. Blocking here would deny web access on every undocumented model.
    const r = checkCapabilities({
      required: ['web.search'],
      providerCapabilities: { Claude: { web: { search: UNKNOWN } } },
      provider: 'Claude'
    })
    expect(r.ok).to.equal(true)
  })

  it('never advertises a provider the user has no key for', () => {
    // supportedBy is computed only over the providers passed in, which the controller builds
    // from the user's own resources.
    expect(computeSupportedBy('web.search', { ChatGPT: CHATGPT }, 'ChatGPT')).to.deep.equal([])
  })

  it('does not offer UNKNOWN providers as the fix', () => {
    expect(computeSupportedBy('web.search', { Claude: { web: UNKNOWN }, ChatGPT: CHATGPT }, 'ChatGPT')).to.deep.equal([])
  })

  it('writes errors as prose, not as dotted vocabulary paths', () => {
    expect(buildCapabilityError({ capability: 'web.search', provider: 'ChatGPT', supportedBy: ['Claude'] }).error)
      .to.equal('ChatGPT cannot search the web. Available with: Claude')
    expect(buildCapabilityError({ capability: 'voice.stt', provider: 'Claude' }).error)
      .to.equal('Claude cannot do speech-to-text')
  })

  it('distinguishes "this provider cannot" from "this model cannot"', () => {
    const onModel = buildCapabilityError({ capability: 'web', provider: 'Claude', model: 'claude-3-haiku', onModel: true })
    expect(onModel.code).to.equal(CAPABILITY_ERROR_ON_MODEL)
    expect(onModel.model).to.equal('claude-3-haiku')
  })
})

describe('tier 2 — reading the provider capability tree', () => {
  const models = [
    { id: 'claude-opus-5', created_at: '2026-01-01', capabilities: { image_input: { supported: true }, effort: { supported: true } } },
    { id: 'claude-sonnet-4-20250514', created_at: '2025-05-14', capabilities: { image_input: { supported: true }, effort: { supported: false } } },
    { id: 'claude-no-tree', created_at: '2024-01-01' }
  ]

  it('finds a tree by exact model id', () => {
    expect(capabilityTreeFor(models, 'claude-opus-5').effort).to.deep.equal({ supported: true })
  })

  it('resolves a family shorthand to the newest matching model', () => {
    expect(capabilityTreeFor(models, 'sonnet')).to.deep.equal(models[1].capabilities)
  })

  it('returns null when the model has no tree at all', () => {
    expect(capabilityTreeFor(models, 'claude-no-tree')).to.equal(null)
    expect(capabilityTreeFor(models, 'not-a-model')).to.equal(null)
  })

  it('reads a supported leaf as a boolean', () => {
    const tree = models[0].capabilities
    expect(readCapabilityLeaf(tree, ['image_input'])).to.equal(true)
    expect(readCapabilityLeaf(models[1].capabilities, ['effort'])).to.equal(false)
  })

  it('returns UNKNOWN when the tree is SILENT about a feature — never a guess', () => {
    // This is the branch web access lands in if the tree carries no web-tool leaf: the
    // answer becomes "try it" (tier 3), not "no".
    expect(readCapabilityLeaf(models[0].capabilities, CAPABILITY_TREE_PATHS['web.search'])).to.equal(UNKNOWN)
    expect(readCapabilityLeaf(null, ['anything'])).to.equal(UNKNOWN)
  })

  it('tries several spellings, because the tree is versioned by the provider not by us', () => {
    expect(readCapabilityLeaf({ web_search: { supported: true } }, CAPABILITY_TREE_PATHS['web.search'])).to.equal(true)
    expect(readCapabilityLeaf({ tools: { web_search: { supported: true } } }, CAPABILITY_TREE_PATHS['web.search'])).to.equal(true)
  })

  it('decides from the TREE, not from the model id', () => {
    // Same tree, wildly different ids -> identical answers. If anyone reintroduces a
    // per-model lookup table keyed on the id, this is what breaks.
    const tree = { image_input: { supported: true } }
    const viaHaiku = readCapabilityLeaf(capabilityTreeFor([{ id: 'claude-3-haiku', capabilities: tree }], 'claude-3-haiku'), ['image_input'])
    const viaOpus = readCapabilityLeaf(capabilityTreeFor([{ id: 'claude-opus-5', capabilities: tree }], 'claude-opus-5'), ['image_input'])
    expect(viaHaiku).to.equal(viaOpus).and.to.equal(true)
  })
})

describe('tier 2/3 on a provider that publishes nothing', () => {
  it('openai stays UNKNOWN rather than guessing from model-id substrings', async () => {
    const caps = await gptCapabilities({ model: 'gpt-5.5' })
    expect(caps.vision).to.equal(UNKNOWN)
    expect(caps.documents).to.equal(UNKNOWN)
    // Web too, now that the adapter wires it: OpenAI's models.list() publishes no capability
    // tree, so nothing can narrow tier 1 for a named model until a request has actually been
    // tried (tier 3). 'unknown' is the honest answer and the gate lets it through.
    expect(caps.web).to.deep.equal({ search: UNKNOWN, fetch: UNKNOWN })
    // 'gpt-5.5' would have matched the old /^gpt-5/ reasoning regex. It must not resolve to a
    // confident `true` on the strength of its NAME — that regex is what this test outlaws.
    expect(caps.effort).to.equal(UNKNOWN)
  })

  it('with no model named, tier 1 answers alone', async () => {
    expect((await gptCapabilities({})).vision).to.equal(true)
  })
})

describe('the connector contract', () => {
  // Both files open with the same contract comment block, and nothing enforced it. The next
  // connector (an aggregator like OpenRouter) will be written by reading that comment, so the
  // cost of it being subtly wrong is paid then, far from here.
  const connectors = { Claude: claudeConnector, ChatGPT: gptConnector }

  it('every connector implements the required surface', () => {
    const required = ['listModels', 'parseModelId', 'getPricing', 'ask', 'getCapabilities',
      'getFamilyFromModelId', 'getVendorForModel']
    for (const [name, connector] of Object.entries(connectors)) {
      for (const fn of required) {
        expect(connector[fn], name + ' is missing ' + fn).to.be.a('function')
      }
      expect(connector.CAPABILITIES, name + ' declares no CAPABILITIES').to.be.an('object')
      expect(connector.DEFAULT_FAMILY, name + ' has no DEFAULT_FAMILY').to.be.a('string')
    }
  })

  it('names a real upstream vendor for cost accounting', () => {
    // usageTallies keys a row by (app, api key, VENDOR, day). A connector that returned the
    // wrong vendor — or undefined — would merge or lose a user's spend rows.
    expect(claudeConnector.getVendorForModel('claude-sonnet-5')).to.equal('anthropic')
    expect(gptConnector.getVendorForModel('gpt-5.5')).to.equal('openai')
  })

  it('either omits an optional member or implements it — never a stub that throws', () => {
    // The design rule that keeps the capability layer honest: a connector DECLARES what it
    // does and the gate enforces it, so nothing here exists only to throw 'not supported'.
    // Anthropic has no transcribe/speak at all, and says so with voice:false.
    const optional = ['askStream', 'getServerToolPrices', 'getLatestModelForFamily',
      'generateImage', 'listImageModels', 'getImagePricing',
      'transcribe', 'speak', 'listVoiceModels', 'getVoicePricing']
    for (const [name, connector] of Object.entries(connectors)) {
      for (const fn of optional) {
        if (connector[fn] !== undefined) expect(connector[fn], name + '.' + fn).to.be.a('function')
      }
    }
    expect(claudeConnector.transcribe, 'anthropic must not stub voice').to.equal(undefined)
    expect(claudeConnector.speak, 'anthropic must not stub voice').to.equal(undefined)
    expect(gptConnector.transcribe).to.be.a('function')
    expect(gptConnector.speak).to.be.a('function')
  })

  it('a connector that wires a server tool also publishes its rate', () => {
    // The web-search miss that billed 6 searches at $0: the rate has to travel WITH the code
    // that can spend it, not wait for a pricing record to be refreshed.
    for (const [name, connector] of Object.entries(connectors)) {
      const wiresWeb = connector.CAPABILITIES.web && connector.CAPABILITIES.web !== false
      if (!wiresWeb) continue
      const prices = connector.getServerToolPrices()
      expect(prices.webSearchPer1000, name + ' wires web search but publishes no rate').to.be.a('number')
    }
  })
})

describe('the structuredOutput option (additive, 2026-09-19)', () => {
  // The rule these pin: a caller who does NOT pass the option is untouched (null in, nothing
  // downstream), and a caller who does gets the schema honoured or an error — never text that
  // "probably" parses. The tolerant behaviour stays with responseType:'json'.
  it('is in the vocabulary and both native connectors declare it', () => {
    expect(CAPABILITY_KEYS).to.include('structuredOutput')
    expect(CLAUDE_CAPS.structuredOutput).to.equal(true)
    expect(GPT_CAPS.structuredOutput).to.equal(true)
  })

  it('absent means null — every existing path sees nothing', () => {
    expect(normalizeStructuredOutput(undefined)).to.equal(null)
    expect(normalizeStructuredOutput(null)).to.equal(null)
    expect(normalizeStructuredOutput(false)).to.equal(null)
  })

  it('normalizes a valid option and clamps the name to the provider-safe form', () => {
    const out = normalizeStructuredOutput({ schema: { type: 'object' }, name: 'my schema! v2', description: 'd' })
    expect(out).to.deep.equal({ name: 'my_schema__v2', description: 'd', schema: { type: 'object' }, strict: true })
    expect(normalizeStructuredOutput({ schema: { type: 'object' } }).name).to.equal('freezr_response')
    expect(normalizeStructuredOutput({ schema: { type: 'object' } })).to.not.have.property('description')
  })

  it('rejects a malformed option before any connector could be called', () => {
    for (const bad of ['x', 42, {}, { schema: 'nope' }, { schema: [] }, { schema: { type: 'object' }, strict: false }]) {
      let caught = null
      try { normalizeStructuredOutput(bad) } catch (e) { caught = e }
      expect(caught && caught.code, JSON.stringify(bad)).to.equal('structured_output_invalid_option')
    }
  })

  it('the strict parser accepts exactly one JSON document and nothing looser', () => {
    expect(parseStructuredOutput('{"a":1}')).to.deep.equal({ ok: true, value: { a: 1 } })
    expect(parseStructuredOutput({ a: 1 }).ok, 'an already-parsed object passes through').to.equal(true)
    expect(parseStructuredOutput('```json\n{"a":1}\n```').ok, 'fenced JSON is NOT accepted here — that is responseType:json territory').to.equal(false)
    expect(parseStructuredOutput('Sure! {"a":1}').ok).to.equal(false)
    expect(parseStructuredOutput('').ok).to.equal(false)
    expect(parseStructuredOutput('   ').ok).to.equal(false)
    expect(parseStructuredOutput(null).ok).to.equal(false)
    expect(parseStructuredOutput(undefined).ok).to.equal(false)
  })

  it('the gate refuses a schema on a connector that does not declare it', () => {
    // A local CLI connector can be PROMPTED to emit JSON but cannot GUARANTEE it, so it does not
    // declare the capability — and the gate must refuse rather than let the prompt try.
    const gate = checkCapabilities({
      required: ['structuredOutput'], optional: false,
      providerCapabilities: { Local: { web: false, vision: false } }, provider: 'Local'
    })
    expect(gate.ok).to.equal(false)
    expect(gate.error).to.have.property('code', CAPABILITY_ERROR)
  })

  it('Anthropic reads it off the provider tree flag structured_outputs', () => {
    expect(CAPABILITY_TREE_PATHS.structuredOutput).to.include('structured_outputs')
  })
})
