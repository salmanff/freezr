// Unit tests for voice (speech-to-text / text-to-speech) on the OpenAI connector, and for the
// audio pricing namespace in llmCostService.
//
// Voice is the first capability that runs the OPPOSITE way to every other one: ChatGPT has it
// and Claude does not. So the thing worth pinning first is that the gate says so, correctly,
// in that direction — every previous capability error named Claude as the fix.
//
// The second is metering. transcribe() gets a real usage block; speak() gets NOTHING back but
// audio bytes, so a naive implementation reports an empty usage and bills every spoken word at
// zero — the same silent under-report as a missing web-search rate. These pin the character
// count that stands in for it, and the whisper-1 trap of a DURATION arriving where a token
// count is expected.
import { expect } from 'chai'
import { standardizeAudioUsage, CAPABILITIES as GPT_CAPS } from '../../../adapters/llmConnectors/openai.mjs'
import { CAPABILITIES as CLAUDE_CAPS } from '../../../adapters/llmConnectors/anthropic.mjs'
import {
  findAudioModelPrice, applyAudioPriceToTokensUsed, getAudioPricingProvider, AUDIO_PRICING_SUFFIX
} from '../../../features/apps/services/llmCostService.mjs'
import { checkCapabilities, CAPABILITY_ERROR } from '../../../features/apps/services/llmCapabilityService.mjs'

const providerCapabilities = { ChatGPT: GPT_CAPS, Claude: CLAUDE_CAPS }

describe('voice — the capability gate, running the other way round', () => {
  it('lets a speech-to-text request through on ChatGPT', () => {
    const gate = checkCapabilities({ required: ['voice.stt'], providerCapabilities, provider: 'ChatGPT', model: 'gpt-4o-transcribe' })
    expect(gate.ok).to.equal(true)
  })

  it('refuses on Claude and names ChatGPT as the fix', () => {
    // Every capability error before this one pointed AT Claude. If supportedBy comes back
    // empty here, the gate is only able to advertise one provider and the layer is half-built.
    const gate = checkCapabilities({ required: ['voice.tts'], providerCapabilities, provider: 'Claude', model: 'claude-sonnet-5' })
    expect(gate.ok).to.equal(false)
    expect(gate.error.code).to.equal(CAPABILITY_ERROR)
    expect(gate.error.supportedBy).to.deep.equal(['ChatGPT'])
    expect(gate.error.error).to.contain('Claude cannot do text-to-speech')
    expect(gate.error.error).to.contain('ChatGPT')
  })

  it('does not offer a provider the user holds no key for', () => {
    // supportedBy is computed over the user's OWN keyed providers, so a Claude-only user is
    // told what they cannot do, not sold a second subscription.
    const gate = checkCapabilities({ required: ['voice.stt'], providerCapabilities: { Claude: CLAUDE_CAPS }, provider: 'Claude' })
    expect(gate.error.supportedBy).to.deep.equal([])
  })
})

describe('voice — usage normalisation', () => {
  it('splits a transcription\'s text and audio input tokens', () => {
    // They bill at different rates, so collapsing them into one input figure misprices the call.
    const out = standardizeAudioUsage({
      type: 'tokens',
      input_tokens: 1200,
      input_token_details: { text_tokens: 200, audio_tokens: 1000 },
      output_tokens: 45
    })
    expect(out.input.qtty).to.equal(1200)
    expect(out.output.qtty).to.equal(45)
    expect(out.other.details).to.deep.equal({ textInputTokens: 200, audioInputTokens: 1000 })
  })

  it('keeps whisper-1\'s DURATION out of every token field', () => {
    // whisper-1 bills per audio minute and reports seconds where the others report tokens.
    // Letting that number into a qtty would add it to totalTokens — a duration counted as
    // tokens, which is why whisper-1 is not the default model.
    const out = standardizeAudioUsage({ type: 'duration', seconds: 93 })
    expect(out.other.details).to.deep.equal({ audioSeconds: 93 })
    expect(out.input.qtty).to.equal(0)
    expect(out.output.qtty).to.equal(0)
    expect(out.other.qtty).to.equal(0)
  })

  it('reports zeros rather than throwing when the provider sends no usage', () => {
    expect(standardizeAudioUsage(null).other.details).to.deep.equal({})
  })
})

describe('voice — pricing', () => {
  const tokens = (input, output, details) => ({
    input: { qtty: input, cost: 0 },
    output: { qtty: output, cost: 0 },
    other: { qtty: 0, cost: 0, details: details || {} }
  })

  it('namespaces audio prices away from text and image prices', () => {
    expect(getAudioPricingProvider('ChatGPT')).to.equal('ChatGPT_audio')
    expect(AUDIO_PRICING_SUFFIX).to.equal('_audio')
  })

  it('prices audio input tokens at the audio rate, not the text rate', () => {
    const price = { input: 2.5, audio_input: 6, output: 10 }
    const { cost } = applyAudioPriceToTokensUsed(
      tokens(1200, 45, { textInputTokens: 200, audioInputTokens: 1000 }),
      price
    )
    // 200 text @ $2.50/M + 1000 audio @ $6/M
    expect(cost.inputCost).to.be.closeTo((200 / 1e6) * 2.5 + (1000 / 1e6) * 6, 1e-12)
    expect(cost.outputCost).to.be.closeTo((45 / 1e6) * 10, 1e-12)
  })

  it('treats an unbroken-down input as text rather than losing it', () => {
    // If the provider stops sending input_token_details, the tokens must still be billed.
    const { cost } = applyAudioPriceToTokensUsed(tokens(1000, 0, {}), { input: 2.5 })
    expect(cost.inputCost).to.be.closeTo((1000 / 1e6) * 2.5, 1e-12)
  })

  it('prices a speak() call on its character count, and says the cost is an estimate', () => {
    // The whole reason per_million_characters exists: the speech endpoint returns no usage, so
    // without this every spoken word bills at zero.
    const { tokensUsed, cost } = applyAudioPriceToTokensUsed(
      tokens(0, 0, { characters: 500 }),
      { per_million_characters: 15 }
    )
    expect(cost.inputCost).to.be.closeTo((500 / 1e6) * 15, 1e-12)
    expect(cost.totalCost).to.be.above(0)
    expect(tokensUsed.other.details.costEstimated).to.equal(true)
  })

  it('does not mark a measured cost as estimated', () => {
    const { tokensUsed } = applyAudioPriceToTokensUsed(tokens(1000, 20, { audioInputTokens: 1000 }), { audio_input: 6, output: 10 })
    expect(tokensUsed.other.details).to.not.have.property('costEstimated')
  })

  it('returns cost:null with no audio price rather than inventing one', () => {
    const { cost } = applyAudioPriceToTokensUsed(tokens(1000, 20, {}), null)
    expect(cost).to.equal(null)
  })

  it('refuses a text-shaped row that landed in the audio namespace', () => {
    // A row with no audio axis is a text price. Returning it would bill audio tokens at text
    // rates — quietly, and about 3x under.
    expect(findAudioModelPrice({ 'gpt-4o-transcribe': { foo: 1 } }, 'gpt-4o-transcribe')).to.equal(null)
    expect(findAudioModelPrice({ 'gpt-4o-transcribe': { input: 2.5, audio_input: 6 } }, 'gpt-4o-transcribe'))
      .to.deep.equal({ input: 2.5, audio_input: 6 })
  })

  it('matches a model whose stored key carries a date stamp', () => {
    expect(findAudioModelPrice({ 'gpt-4o-mini-tts-2025-03-20': { per_million_characters: 15 } }, 'gpt-4o-mini-tts'))
      .to.deep.equal({ per_million_characters: 15 })
  })
})
