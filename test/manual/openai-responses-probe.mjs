// Manual probe: does the Responses port actually work against a real OpenAI key?
//
// WHY THIS EXISTS. Every unit test around this connector runs against a scripted fake client.
// That proves the wiring but CANNOT prove the ~50 streaming event names, the tool shape, the
// `store: false` param, the file content-part shapes or the price are right — only a live call
// does that. Each check below prints PASS/FAIL for one thing the fakes cannot settle.
//
// Usage:
//   OPENAI_API_KEY=sk-... node test/manual/openai-responses-probe.mjs
//   node test/manual/openai-responses-probe.mjs --key-file ~/.openai-key
//   ... --model gpt-5.4-mini      pick the model (default: the adapter's own default)
//   ... --web                     ALSO run the web-search checks — see the cost warning
//   ... --only voice              run one section: transport | reasoning | files | voice | web
//
// COST. Everything except --web is a few thousand tokens, well under a cent in total. The
// --web section is the expensive one: on Anthropic the equivalent searching call cost $0.57,
// because fetched page bodies flood the context. It is opt-in for that reason.
//
// The key is never printed, and no prompt here contains user data.

import { readFileSync } from 'fs'
import {
  ask, CAPABILITIES, getCapabilities, getServerToolPrices, getPricing,
  listModels, listVoiceModels, transcribe, speak
} from '../../adapters/llmConnectors/openai.mjs'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null
}

const keyFile = flag('key-file')
const readKeyFile = (path) => {
  try {
    return readFileSync(path.replace(/^~/, process.env.HOME || '~'), 'utf8').trim()
  } catch (e) {
    console.error('Could not read --key-file ' + path + ': ' + e.message)
    process.exit(1)
  }
}
// --key-file is the recommended route: it keeps the key out of your shell history and out of
// any transcript, and nothing below ever prints it.
const apiKey = (typeof keyFile === 'string' ? readKeyFile(keyFile) : null) ||
  args.find(a => a.startsWith('sk-')) || process.env.OPENAI_API_KEY
if (!apiKey) {
  console.error('No key. Set OPENAI_API_KEY, or pass --key-file <path>, or pass the key as an argument.')
  console.error('Your freezr key is under Account > Resources (it is stored encrypted, so this script cannot read it for you).')
  process.exit(1)
}

const model = typeof flag('model') === 'string' ? flag('model') : undefined
const only = typeof flag('only') === 'string' ? flag('only') : null
const wantWeb = Boolean(flag('web'))
const wants = (section) => (only ? only === section : (section !== 'web' || wantWeb))

let passes = 0
let failures = 0
const checks = []
const check = (label, ok, detail) => {
  checks.push({ label, ok, detail })
  if (ok) passes++
  else failures++
  console.log('   ' + (ok ? '✅' : '❌') + ' ' + label + (detail ? '  — ' + detail : ''))
}

const usd = (n) => (n === null || n === undefined ? '$?' : '$' + n.toFixed(5))
let rate = null
const costOf = (tokensUsed) => {
  if (!rate) return null
  const d = tokensUsed?.other?.details || {}
  const cached = Math.min(d.cachedPromptTokens || 0, tokensUsed.input.qtty || 0)
  const tools = getServerToolPrices()
  return ((tokensUsed.input.qtty - cached) / 1e6) * rate.input +
    (cached / 1e6) * (rate.cachedInput ?? rate.input * 0.5) +
    ((tokensUsed.output.qtty || 0) / 1e6) * rate.output +
    ((d.webSearchRequests || 0) / 1000) * (tools.webSearchPer1000 || 0) +
    ((d.webFetchRequests || 0) / 1000) * (tools.webFetchPer1000 || 0)
}

const spend = []
const summarise = (label, result) => {
  const t = result.tokensUsed
  const d = t.other.details || {}
  const cost = costOf(t)
  spend.push({ label, tokens: t.input.qtty, cost, model: result.model })
  console.log('      model:  ' + result.model + '  (family ' + result.family + ')')
  console.log('      tokens: in=' + t.input.qtty + (d.cachedPromptTokens ? ' (' + d.cachedPromptTokens + ' cached)' : '') +
    ' out=' + t.output.qtty + (d.reasoningTokens ? ' (' + d.reasoningTokens + ' reasoning)' : '') +
    '  stop=' + result.stopReason + '  cost=' + usd(cost))
}

// ── free checks: what the adapter and the API say, before spending anything ───────────────
const probeCapabilities = async () => {
  console.log('\n══ capabilities (free) ══')
  console.log('   tier 1 (this adapter wires):', JSON.stringify(CAPABILITIES))
  check('web is declared', CAPABILITIES.web && CAPABILITIES.web.search === true)
  check('voice is declared', Boolean(CAPABILITIES.voice && CAPABILITIES.voice.stt))

  const models = await listModels({ apiKey })

  // With NO model named, tier 1 answers alone and `effort: true` is the right answer. The
  // interesting branch is a NAMED model, where the answer must be 'unknown' — OpenAI publishes
  // no capability tree, so anything else would be a guess from the id. Use a real id from the
  // key's own lineup, so this keeps testing the right thing as the lineup changes.
  const namedModel = model || models[0]?.id
  const caps = await getCapabilities({ apiKey, model: namedModel })
  console.log('   for ' + namedModel + ':', JSON.stringify(caps))
  check('a named model resolves to unknown, not a guess from its id',
    caps.effort === 'unknown' && caps.vision === 'unknown', 'effort=' + caps.effort + ' vision=' + caps.vision)
  console.log('   chat models:', models.length, '— e.g.', models.slice(0, 6).map(m => m.id).join(', '))
  // The port removed the -pro / deep-research exclusions, because Chat Completions could not
  // run them and Responses can. If none appear, either the key has no access or the filter is
  // still wrong; the ids are the evidence.
  const pro = models.filter(m => /-pro|deep-research/.test(m.id)).map(m => m.id)
  console.log('   models the OLD adapter hid:', pro.length ? pro.join(', ') : '(none on this key)')

  const voices = await listVoiceModels({ apiKey })
  console.log('   voice models:', voices.map(v => v.id + '[' + v.kind + ']').join(', ') || '(none)')
  check('voice models are listed and split stt/tts',
    voices.some(v => v.kind === 'stt') && voices.some(v => v.kind === 'tts'))

  try {
    const pricing = await getPricing({ apiKey, targetModel: model })
    rate = pricing?.models ? Object.values(pricing.models)[0] : null
    console.log('   pricing source:', pricing?.source || '(none)', rate ? JSON.stringify(rate) : '')
    check('a text price was found (costs below are real)', Boolean(rate))
  } catch (e) {
    check('a text price was found', false, e.message)
  }
  console.log('   server-tool rates:', JSON.stringify(getServerToolPrices()),
    '⚠️ hand-entered — verify against OpenAI\'s pricing page')
}

// ── the transport itself ──────────────────────────────────────────────────────────────────
const probeTransport = async () => {
  console.log('\n══ transport: does /v1/responses work at all? (cheap) ══')
  const result = await ask({
    apiKey, model, prompt: 'Reply with exactly: FREEZR-OK', max_tokens: 2048, thinking: false
  })
  summarise('plain ask', result)
  check('an answer came back', Boolean(result.response), JSON.stringify(String(result.response).slice(0, 60)))
  check('it did NOT fall back to chat completions',
    !result.viaChatCompletions, 'if this fails, /v1/responses was rejected — read the warning above')
  check('stopReason is normalised to the shared vocabulary',
    ['end_turn', 'max_tokens', 'content_filter'].includes(result.stopReason), result.stopReason)
  check('usage was reported (so the call is billable)', result.tokensUsed.input.qtty > 0)
  check('store:false was accepted', true, 'no error means the param is valid; retention is off')
  return result
}

// ── reasoning text: the half of the port Chat Completions could never do ──────────────────
const probeReasoning = async () => {
  console.log('\n══ reasoning summary: the thing Chat Completions could never return (cheap) ══')
  const result = await ask({
    apiKey,
    model,
    prompt: 'A farmer has 17 sheep and all but 9 run away. How many are left? Think it through.',
    max_tokens: 4096,
    effort: 'medium'
  })
  summarise('reasoning ask', result)
  check('reasoning.effort was accepted', Boolean(result.response))
  const gotText = Boolean(result.thinking && result.thinking.trim())
  check('reasoning TEXT came back — thinking:{text:true} is honest', gotText,
    gotText ? result.thinking.slice(0, 120).replace(/\n/g, ' ') + '…' : 'EMPTY: summary:auto returned nothing on this model')
  if (!gotText) {
    console.log('      NOTE: not every model emits summaries. Try --model gpt-5.5 before')
    console.log('      concluding thinking.text should go back to false.')
  }
}

// ── files: the live bug the port fixed ────────────────────────────────────────────────────
const probeFiles = async () => {
  console.log('\n══ files: the path that was SILENTLY DROPPING attachments (cheap) ══')
  const sharp = (await import('sharp')).default
  const png = await sharp({ create: { width: 96, height: 96, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .png().toBuffer()

  const result = await ask({
    apiKey,
    model,
    prompt: 'What single colour fills this image? Answer with just the colour name.',
    max_tokens: 2048,
    thinking: false,
    files: [{ originalname: 'swatch.png', buffer: png }]
  })
  summarise('image attach', result)
  const answer = String(result.response || '').toLowerCase()
  check('the model actually SAW the image', /red|crimson|maroon/.test(answer),
    'answered: ' + answer.slice(0, 60))
  console.log('      (before the port, askStream never destructured `files`, so on ChatGPT this')
  console.log('       question was answered with no image attached at all.)')

  // input_file with a non-PDF is undocumented. Reported either way: a rejection here is a real
  // finding for the docs, not a failure of the port.
  try {
    const txt = Buffer.from('The passphrase is HALIBUT-4711.', 'utf8')
    const r2 = await ask({
      apiKey,
      model,
      max_tokens: 2048,
      thinking: false,
      prompt: 'What is the passphrase in the attached file?',
      files: [{ originalname: 'note.txt', buffer: txt }]
    })
    summarise('text-file attach', r2)
    check('input_file accepts a plain text file', /halibut/i.test(String(r2.response)),
      'answered: ' + String(r2.response).slice(0, 60))
  } catch (e) {
    check('input_file accepts a plain text file', false, 'REJECTED: ' + e.message + ' (document this: PDF/image only)')
  }
}

// ── voice: round-trip, so no audio fixture is needed ──────────────────────────────────────
const probeVoice = async () => {
  console.log('\n══ voice: speak() then transcribe() the result back (cheap) ══')
  const PHRASE = 'The quick brown fox jumps over the lazy dog.'

  const spoken = await speak({ apiKey, text: PHRASE, voice: 'alloy', format: 'mp3' })
  check('speak() returned audio', Boolean(spoken.b64Data && spoken.b64Data.length > 1000),
    spoken.format + ', ' + Math.round((spoken.b64Data || '').length * 0.75 / 1024) + ' KB, model ' + spoken.model)
  check('speak() reports a character count to meter on',
    spoken.tokensUsed.other.details.characters === PHRASE.length,
    'characters=' + spoken.tokensUsed.other.details.characters)

  const heard = await transcribe({
    apiKey,
    audio: { buffer: Buffer.from(spoken.b64Data, 'base64'), originalname: 'roundtrip.mp3', mimetype: 'audio/mpeg' },
    language: 'en'
  })
  console.log('      heard back:', JSON.stringify(heard.text))
  const words = (s) => s.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean)
  const expected = words(PHRASE)
  const actual = words(heard.text || '')
  const overlap = expected.filter(w => actual.includes(w)).length / expected.length
  check('transcribe() read the audio back', overlap > 0.7, Math.round(overlap * 100) + '% of words matched')
  check('transcribe() reports real token usage', heard.tokensUsed.input.qtty > 0,
    JSON.stringify(heard.tokensUsed.other.details))
  if (!heard.tokensUsed.input.qtty) {
    console.log('      NOTE: no token usage means this model bills per audio MINUTE (whisper-1')
    console.log('      behaves that way). Check `details.audioSeconds` instead.')
  }
}

// ── web: the expensive section ────────────────────────────────────────────────────────────
const probeWeb = async () => {
  console.log('\n══ web access (COSTS REAL MONEY) ══')
  const QUESTION = 'does wikipedia have a public api'

  const off = await ask({ apiKey, model, prompt: QUESTION, max_tokens: 2048, thinking: false })
  summarise('web OFF', off)

  const on = await ask({ apiKey, model, prompt: QUESTION, max_tokens: 2048, thinking: false, web: true })
  summarise('web ON, model chooses', on)
  check('the web tool was accepted by the API', true, 'no capability error was thrown')
  const tax = on.tokensUsed.input.qtty - off.tokensUsed.input.qtty
  console.log('      DECLARATION TAX: ' + tax + ' extra input tokens just for offering the tool')
  console.log('      (Anthropic charges ~7,200 here. If this is near zero, the per-app advice')
  console.log('       in freezr-context.md differs by provider and should say so.)')

  const searched = await ask({
    apiKey,
    model,
    prompt: 'Check wikipedia\'s current API rate limits on their own documentation and quote the exact figure.',
    max_tokens: 4096,
    thinking: false,
    // Deliberately mixes options this provider CANNOT honour, to prove they are reported
    // rather than silently dropped.
    web: { search: { maxUses: 3, allowedDomains: ['wikipedia.org', 'wikimedia.org'] }, fetch: { maxContentTokens: 5000 } }
  })
  summarise('web ON, searching', searched)
  const used = searched.toolsUsed || {}
  check('searches were counted (so they bill)', (used.webSearch?.requests || 0) > 0,
    'search=' + (used.webSearch?.requests || 0) + ' fetch=' + (used.webFetch?.requests || 0))
  check('queries were captured', Boolean(used.webSearch?.queries?.length),
    JSON.stringify(used.webSearch?.queries || []))
  check('sources were captured (apps display these)', Boolean(used.webSearch?.sources?.length),
    (used.webSearch?.sources || []).length + ' sources; include:web_search_call.action.sources is what makes this work')
  check('citations came back', Boolean(searched.citations?.length),
    (searched.citations || []).length + ' citations')
  check('unhonourable options were NAMED, not dropped',
    searched.unavailable.includes('web.search.maxUses') && searched.unavailable.includes('web.fetch.maxContentTokens'),
    JSON.stringify(searched.unavailable))
  check('the request count reached the billing details',
    (searched.tokensUsed.other.details.webSearchRequests || 0) > 0,
    'webSearchRequests=' + (searched.tokensUsed.other.details.webSearchRequests || 0))
  if (used.errors?.length) console.log('      tool errors (normal, not failures):', JSON.stringify(used.errors))
}

const sections = [
  ['capabilities', probeCapabilities],
  ['transport', probeTransport],
  ['reasoning', probeReasoning],
  ['files', probeFiles],
  ['voice', probeVoice],
  ['web', probeWeb]
]

const run = async () => {
  for (const [name, fn] of sections) {
    if (name !== 'capabilities' && !wants(name)) continue
    if (only && name !== only && name !== 'capabilities') continue
    try {
      await fn()
    } catch (e) {
      check(name + ' section did not complete', false, e.message + (e.code ? ' [' + e.code + ']' : ''))
      if (process.env.PROBE_TRACE) console.error(e)
    }
  }

  console.log('\n══ result: ' + passes + ' passed, ' + failures + ' failed ══')
  if (failures) {
    console.log('   failed:')
    for (const c of checks.filter(c => !c.ok)) console.log('     ❌ ' + c.label + (c.detail ? ' — ' + c.detail : ''))
  }

  if (spend.length) {
    console.log('\n══ measured cost — the rows freezr-context.md is missing ══')
    for (const s of spend) console.log('   ' + s.label.padEnd(26), String(s.tokens).padStart(8) + ' input tokens ', usd(s.cost).padEnd(10), s.model)
    const total = spend.reduce((a, s) => a + (s.cost || 0), 0)
    console.log('   ' + 'TOTAL SPENT BY THIS PROBE'.padEnd(26), ' '.repeat(8) + '              ', usd(total))
  }
  if (!wantWeb && !only) console.log('\n   (web section skipped — pass --web to measure it. That is the expensive one.)')
  process.exit(failures ? 1 : 0)
}

run().catch(e => {
  console.error('\nPROBE ABORTED:', e.message)
  if (e.code) console.error('  code:', e.code, e.capability ? ('capability: ' + e.capability) : '')
  process.exit(1)
})
