// Unit tests for the Responses-API port of the OpenAI connector
// (adapters/llmConnectors/openai.mjs).
//
// The connector moved off Chat Completions, which is what let it declare `web` and
// `thinking.text` at all. The claims worth pinning are the ones that would fail SILENTLY:
//   - `store: false` on every request — the Responses API defaults it to TRUE, and forgetting
//     it means 30 days of the user's prompts retained at OpenAI with nothing in the response
//     to say so;
//   - OpenAI's ONE web tool splits into freezr's search/fetch halves by the ACTION type, not
//     by a tool name, so the counts that drive billing come from the right place;
//   - an option this provider cannot honour (maxUses, blockedDomains) is NAMED BACK to the
//     caller rather than dropped — an app using maxUses as a spend cap has no cap here;
//   - reasoning support is settled by the API, not by a /^gpt-5/ test on the model id.
import { expect } from 'chai'
import {
  buildWebTools, webUnavailableOptions, isWebToolRejection, isResponsesUnsupported,
  streamAndCollect, runWithDegrades, makeWebCollector, rememberProbe, buildResponseParams,
  getServerToolPrices, responsesParamsToChat, isStructuredOutputRejection, classifyStructuredRejection,
  getCapabilities
} from '../../../adapters/llmConnectors/openai.mjs'

// Minimal fake of the streaming client: each element of `scripts` is one create() call, so a
// script array of length 2 means "the first attempt, then the retry".
const fakeClient = (scripts, { chatScripts = [] } = {}) => {
  const calls = []
  const chatCalls = []
  const serve = (list, log) => async (params) => {
    log.push(JSON.parse(JSON.stringify(params)))
    const script = list[log.length - 1]
    if (!script) throw new Error('fake client: unexpected extra call #' + log.length)
    if (script instanceof Error) throw script
    return (async function * () { for (const c of script) yield c })()
  }
  return {
    calls,
    chatCalls,
    responses: { create: serve(scripts, calls) },
    chat: { completions: { create: serve(chatScripts, chatCalls) } }
  }
}

const err = (message, status) => Object.assign(new Error(message), { status })

const textEvents = (text, { status = 'completed', reason = null, usage = null } = {}) => [
  { type: 'response.output_text.delta', delta: text },
  {
    type: status === 'completed' ? 'response.completed' : 'response.incomplete',
    response: {
      status,
      incomplete_details: reason ? { reason } : null,
      usage: usage || { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
    }
  }
]

const searchCallItem = (query, sources) => ({
  type: 'web_search_call',
  status: 'completed',
  action: { type: 'search', query, sources: sources.map(url => ({ type: 'url', url, title: url })) }
})

describe('openai web tool — definition', () => {
  it('declares ONE tool however many halves were named', () => {
    // Anthropic declares two tools; OpenAI has a single web_search that also opens pages. A
    // caller writing `web: true` must get a working request on both.
    expect(buildWebTools({ search: true, fetch: true })).to.deep.equal([{ type: 'web_search' }])
    expect(buildWebTools({ search: true, fetch: false })).to.deep.equal([{ type: 'web_search' }])
    expect(buildWebTools({ search: false, fetch: true })).to.deep.equal([{ type: 'web_search' }])
  })

  it('declares nothing when neither half was asked for', () => {
    expect(buildWebTools(null)).to.equal(null)
    expect(buildWebTools({ search: false, fetch: false })).to.equal(null)
  })

  it('merges allowedDomains from whichever halves named one', () => {
    const tools = buildWebTools({
      search: { allowedDomains: ['a.example'] },
      fetch: { allowedDomains: ['b.example', 'a.example'] }
    })
    expect(tools[0].filters).to.deep.equal({ allowed_domains: ['a.example', 'b.example'] })
  })

  it('passes user_location through as an approximate location', () => {
    const tools = buildWebTools({ search: { userLocation: { city: 'Lisbon', country: 'PT' } }, fetch: false })
    expect(tools[0].user_location).to.deep.equal({ type: 'approximate', city: 'Lisbon', country: 'PT' })
  })

  it('never infers search_context_size from maxContentTokens', () => {
    // One is a token budget, the other a three-position dial. Deriving one from the other
    // would be freezr inventing a number and reporting it back as the caller's.
    const tools = buildWebTools({ search: true, fetch: { maxContentTokens: 5000 } })
    expect(tools[0]).to.not.have.property('search_context_size')
  })

  it('hands raw.openai through untranslated', () => {
    const raw = [{ type: 'web_search_2025_08_26', search_context_size: 'high' }]
    expect(buildWebTools({ search: true, fetch: true, raw: { openai: raw } })).to.deep.equal(raw)
  })
})

describe('openai web tool — options it cannot honour', () => {
  it('names a dropped spend cap instead of swallowing it', () => {
    // The failure this prevents: an app sets maxUses:3 believing it is capped, and finds out
    // otherwise from its bill. OpenAI's web_search has no max_uses of any kind.
    expect(webUnavailableOptions({ search: { maxUses: 3 }, fetch: false }))
      .to.deep.equal(['web.search.maxUses'])
  })

  it('names a dropped blocklist — a safety control, not just a cost one', () => {
    expect(webUnavailableOptions({ search: { blockedDomains: ['evil.example'] }, fetch: false }))
      .to.deep.equal(['web.search.blockedDomains'])
  })

  it('reports maxContentTokens and the fetch-only shape', () => {
    expect(webUnavailableOptions({ search: false, fetch: { maxContentTokens: 5000 } }))
      .to.deep.equal(['web.fetch.maxContentTokens', 'web.fetch.only'])
  })

  it('says nothing when everything asked for maps', () => {
    expect(webUnavailableOptions({ search: { allowedDomains: ['a.example'] }, fetch: true })).to.deep.equal([])
    expect(webUnavailableOptions(null)).to.deep.equal([])
  })

  it('reports nothing when the caller used raw.openai and took the wheel', () => {
    expect(webUnavailableOptions({ search: { maxUses: 3 }, fetch: false, raw: { openai: [{ type: 'web_search' }] } }))
      .to.deep.equal([])
  })
})

describe('openai web tool — collecting what it did', () => {
  it('splits ONE tool into freezr\'s two halves by the ACTION, not the tool name', () => {
    // This is where the billing counts come from, so getting the split wrong bills page opens
    // as searches or loses them entirely.
    const collector = makeWebCollector()
    collector.noteCall(searchCallItem('wikipedia api', ['https://w.example/a']))
    collector.noteCall({ type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://w.example/a' } })
    collector.noteCall({ type: 'web_search_call', status: 'completed', action: { type: 'find_in_page', url: 'https://w.example/a', pattern: 'rate limit' } })

    const summary = collector.summary()
    expect(summary.webSearch).to.deep.equal({
      requests: 1,
      queries: ['wikipedia api'],
      sources: [{ url: 'https://w.example/a', title: 'https://w.example/a' }]
    })
    expect(summary.webFetch.requests).to.equal(2)
    expect(summary.webFetch.urls).to.deep.equal(['https://w.example/a', 'https://w.example/a'])
  })

  it('treats a failed call as data, not as a thrown error', () => {
    // A tool failure arrives as a normal 200 with a failed ITEM. Reading item.action without
    // checking item.status is the bug this pins.
    const collector = makeWebCollector()
    const noted = collector.noteCall({ type: 'web_search_call', status: 'failed', error: { code: 'rate_limited' }, action: null })
    expect(noted).to.deep.equal({ tool: 'web_search', status: 'error', code: 'rate_limited' })
    expect(collector.summary()).to.deep.equal({ errors: [{ tool: 'web_search', code: 'rate_limited' }] })
  })

  it('never reports limitReached, because there is no cap to reach', () => {
    const collector = makeWebCollector()
    collector.noteCall(searchCallItem('q', []))
    expect(collector.summary()).to.not.have.property('limitReached')
  })

  it('resolves a citation quote from the indexes the annotation carries', () => {
    // OpenAI sends start/end offsets into the answer, not the quoted text, so the quote can
    // only be recovered once the text has finished streaming.
    const collector = makeWebCollector()
    collector.noteCitation({ type: 'url_citation', url: 'https://w.example/a', title: 'A', start_index: 6, end_index: 11 })
    expect(collector.citations('hello world here')).to.deep.equal([
      { url: 'https://w.example/a', title: 'A', citedText: 'world' }
    ])
  })

  it('ignores annotations that are not url citations', () => {
    const collector = makeWebCollector()
    collector.noteCitation({ type: 'file_citation', file_id: 'f_1' })
    expect(collector.citations('text')).to.deep.equal([])
  })

  it('summarises to null when the tool never ran', () => {
    expect(makeWebCollector().summary()).to.equal(null)
  })
})

describe('openai streaming — collection', () => {
  it('collects text, reasoning summary, tool progress and usage from named events', async () => {
    const events = [
      { type: 'response.output_item.added', item: { type: 'web_search_call' } },
      { type: 'response.web_search_call.searching' },
      { type: 'response.output_item.done', item: searchCallItem('wikipedia api', ['https://w.example/a']) },
      { type: 'response.reasoning_summary_text.delta', delta: 'weighing sources' },
      { type: 'response.output_text.delta', delta: 'Yes, ' },
      { type: 'response.output_text.delta', delta: 'it does.' },
      { type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', url: 'https://w.example/a', title: 'A', start_index: 0, end_index: 3 } },
      {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 7190, output_tokens: 40, total_tokens: 7230 } }
      }
    ]
    const client = fakeClient([events])
    const seen = []
    const out = await streamAndCollect(client, { model: 'gpt-5.5', input: [] }, { onEvent: e => seen.push(e) })

    expect(out.textResponse).to.equal('Yes, it does.')
    expect(out.thinkingResponse).to.equal('weighing sources')
    expect(out.stopReason).to.equal('end_turn')
    expect(out.usage.input_tokens).to.equal(7190)
    expect(out.toolsUsed.webSearch.requests).to.equal(1)
    expect(out.citations).to.deep.equal([{ url: 'https://w.example/a', title: 'A', citedText: 'Yes' }])
    expect(seen.filter(e => e.type === 'delta').map(e => e.text)).to.deep.equal(['Yes, ', 'it does.'])
    expect(seen.filter(e => e.type === 'tool').map(e => e.status)).to.deep.equal(['started', 'searching', 'result'])
  })

  it('separates reasoning summary parts instead of running them together', async () => {
    const client = fakeClient([[
      { type: 'response.reasoning_summary_text.delta', delta: 'first' },
      { type: 'response.reasoning_summary_part.added' },
      { type: 'response.reasoning_summary_text.delta', delta: 'second' },
      ...textEvents('done')
    ]])
    const out = await streamAndCollect(client, { model: 'm', input: [] })
    expect(out.thinkingResponse).to.equal('first\n\nsecond')
  })

  it('maps an incomplete response to max_tokens, keeping the raw reason', async () => {
    // Chat Completions said finish_reason 'length'; Responses says status 'incomplete' with a
    // separate reason. Apps check meta.stopReason === 'max_tokens' once, for either provider.
    const client = fakeClient([textEvents('cut off ', { status: 'incomplete', reason: 'max_output_tokens' })])
    const out = await streamAndCollect(client, { model: 'm', input: [] })
    expect(out.stopReason).to.equal('max_tokens')
    expect(out.rawStopReason).to.equal('max_output_tokens')
  })

  it('returns a refusal as the answer, flagged by its stop reason', async () => {
    const client = fakeClient([[
      { type: 'response.refusal.delta', delta: 'I cannot help with that.' },
      { type: 'response.completed', response: { status: 'completed', usage: null } }
    ]])
    const out = await streamAndCollect(client, { model: 'm', input: [] })
    expect(out.textResponse).to.equal('I cannot help with that.')
    expect(out.stopReason).to.equal('content_filter')
  })

  it('throws a response.failed event rather than returning an empty answer', async () => {
    const client = fakeClient([[
      { type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'upstream exploded' } } }
    ]])
    let thrown = null
    try { await streamAndCollect(client, { model: 'm', input: [] }) } catch (e) { thrown = e }
    expect(thrown).to.be.an('error')
    expect(thrown.message).to.equal('upstream exploded')
    expect(thrown.code).to.equal('server_error')
  })
})

describe('openai degrade ladder', () => {
  it('falls back to chat completions when the endpoint has no Responses API', async () => {
    const client = fakeClient(
      [err('Unrecognized request URL (POST /v1/responses)', 404)],
      { chatScripts: [[
        { choices: [{ delta: { content: 'from chat' } }] },
        { choices: [{ finish_reason: 'stop', delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }
      ]] }
    )
    const out = await runWithDegrades(client, { model: 'proxy-model', input: [{ role: 'user', content: 'hi' }] }, { model: 'proxy-model' })
    expect(out.viaChatCompletions).to.equal(true)
    expect(out.textResponse).to.equal('from chat')
    expect(out.stopReason).to.equal('end_turn')
    // The system prompt becomes a message again on the way down.
    expect(client.chatCalls[0].messages).to.deep.equal([{ role: 'user', content: 'hi' }])
  })

  it('refuses rather than answering from stale knowledge when the fallback cannot reach the web', async () => {
    // Dropping to chat completions silently would return a confident, un-searched answer to a
    // caller who explicitly asked for the web.
    const client = fakeClient([err('Unrecognized request URL (POST /v1/responses)', 404)])
    let thrown = null
    try {
      await runWithDegrades(
        client,
        { model: 'no-responses-a', input: [], tools: [{ type: 'web_search' }] },
        { web: { search: true, fetch: true, optional: false }, model: 'no-responses-a' }
      )
    } catch (e) { thrown = e }
    expect(thrown.code).to.equal('capability_unsupported_on_model')
    expect(thrown.capability).to.equal('web')
  })

  it('refuses on the MEMOIZED route too, not just the first time', async () => {
    // The regression this exists for: the memo short-circuits straight onto the fallback
    // transport, so a web check written only inside the 404 handler would let the SECOND web
    // request through un-searched — with nothing in the response saying the web was skipped.
    rememberProbe('no-responses-b', 'responses', false)
    let thrown = null
    try {
      await runWithDegrades(
        fakeClient([]),
        { model: 'no-responses-b', input: [], tools: [{ type: 'web_search' }] },
        { web: { search: true, fetch: true, optional: false }, model: 'no-responses-b' }
      )
    } catch (e) { thrown = e }
    expect(thrown.code).to.equal('capability_unsupported_on_model')
  })

  it('drops the web tool and carries on when the caller passed optional', async () => {
    const client = fakeClient([err('web_search is not supported with this model'), textEvents('answered anyway')])
    const params = { model: 'gpt-4.1', input: [], tools: [{ type: 'web_search' }], include: ['web_search_call.action.sources'] }
    const out = await runWithDegrades(client, params, { web: { search: true, fetch: true, optional: true }, model: 'gpt-4.1' })

    expect(out.webDropped).to.equal(true)
    expect(out.textResponse).to.equal('answered anyway')
    // The retry must carry neither the tool nor the include that only makes sense with it.
    expect(client.calls[1]).to.not.have.property('tools')
    expect(client.calls[1]).to.not.have.property('include')
  })

  it('drops reasoning when the API says the model has none — the regex it replaced', async () => {
    // The old code tested /^gpt-5/ against the id and silently discarded `thinking` on
    // anything else, including every future model. Now the API answers.
    const client = fakeClient([err("Unsupported parameter: 'reasoning' is not supported with this model"), textEvents('plain answer')])
    const params = { model: 'gpt-4.1', input: [], reasoning: { effort: 'high', summary: 'auto' } }
    const out = await runWithDegrades(client, params, { model: 'gpt-4.1' })

    expect(out.textResponse).to.equal('plain answer')
    expect(client.calls[1]).to.not.have.property('reasoning')
  })

  it('re-throws an unrelated error rather than degrading blindly', async () => {
    const client = fakeClient([err('Your account has insufficient credits', 429)])
    let thrown = null
    try { await runWithDegrades(client, { model: 'm', input: [] }, { model: 'm' }) } catch (e) { thrown = e }
    expect(thrown.message).to.equal('Your account has insufficient credits')
  })

  it('remembers a verdict so the same rejection is not paid twice', async () => {
    rememberProbe('memo-model', 'responses', false)
    const client = fakeClient([], { chatScripts: [[{ choices: [{ finish_reason: 'stop', delta: { content: 'cached route' } }] }]] })
    const out = await runWithDegrades(client, { model: 'memo-model', input: [] }, { model: 'memo-model' })
    // Straight to the fallback: the Responses endpoint was never called at all.
    expect(client.calls).to.have.length(0)
    expect(out.textResponse).to.equal('cached route')
  })
})

describe('openai error classification', () => {
  it('tells a missing endpoint apart from a rejected tool', () => {
    expect(isResponsesUnsupported(err('Unrecognized request URL (POST /v1/responses)', 404))).to.equal(true)
    expect(isResponsesUnsupported(err('Your account has insufficient credits', 429))).to.equal(false)
    expect(isWebToolRejection(err('web_search is not supported with this model'))).to.equal(true)
    // The one that matters: an unrelated failure must not look like a capability limit, or
    // freezr degrades a feature the model has and reports it as unsupported.
    expect(isWebToolRejection(err('credit balance too low'))).to.equal(false)
  })
})

describe('openai request builder', () => {
  const build = (over = {}) => buildResponseParams({ model: 'gpt-5.5', prompt: 'hi', ...over })

  it('sets store:false on EVERY request', () => {
    // The Responses API defaults `store` to true, which retains the user's prompt and the
    // model's answer at OpenAI for 30 days. Nothing in the response says so, so the only place
    // this can be caught is here. freezr is a personal data server; this is not negotiable.
    expect(build().store).to.equal(false)
    expect(build({ web: { search: true, fetch: true } }).store).to.equal(false)
    expect(build({ files: [{ originalname: 'a.pdf', buffer: Buffer.from('x') }] }).store).to.equal(false)
  })

  it('puts the system prompt in instructions, not in the message list', () => {
    const params = build({ context: 'You are terse.' })
    expect(params.instructions).to.equal('You are terse.')
    expect(params.input).to.deep.equal([{ role: 'user', content: 'hi' }])
  })

  it('renames the token budget rather than passing the old field', () => {
    const params = build({ max_tokens: 500 })
    expect(params.max_output_tokens).to.equal(500)
    expect(params).to.not.have.property('max_completion_tokens')
  })

  it('lets the top-level effort win over thinking.effort', () => {
    // Both land on reasoning.effort. A caller who set both meant the newer, more specific dial.
    expect(build({ thinking: { effort: 'low' }, effort: 'high' }).reasoning)
      .to.deep.equal({ summary: 'auto', effort: 'high' })
    expect(build({ thinking: { effort: 'low' } }).reasoning)
      .to.deep.equal({ summary: 'auto', effort: 'low' })
  })

  it('asks for the reasoning summary whenever it asks for reasoning at all', () => {
    // summary:'auto' is the entire reason thinking.text can be declared true — without it the
    // model still reasons and still bills, and the caller sees none of it.
    expect(build({ thinking: true }).reasoning.summary).to.equal('auto')
  })

  it('treats thinking:false as a real instruction, not as absence', () => {
    // Reasoning models think by default and those tokens bill as output, so a caller doing
    // high-volume extraction must be able to switch it off.
    expect(build({ thinking: false }).reasoning).to.deep.equal({ effort: 'none' })
    expect(build({}).reasoning).to.equal(undefined)
  })

  it('asks for the sources include only when the web tool is declared', () => {
    // Without it the search action comes back with an empty `sources` list — which is exactly
    // the part an app renders under the answer.
    expect(build({ web: { search: true, fetch: true } }).include).to.deep.equal(['web_search_call.action.sources'])
    expect(build({}).include).to.equal(undefined)
  })

  it('attaches files as content parts on the last user message', () => {
    // The path that replaced askWithFiles(). That function uploaded each file, created an
    // Assistant, a vector store and a thread — and had gone dead: the controller streams, and
    // askStream never accepted `files` at all, so they were silently dropped.
    const params = build({
      prompt: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'read this' }],
      files: [
        { originalname: 'shot.png', buffer: Buffer.from('IMG') },
        { originalname: 'report.pdf', buffer: Buffer.from('PDF') }
      ]
    })
    expect(params.input[0]).to.deep.equal({ role: 'user', content: 'first' })
    expect(params.input[2].content).to.deep.equal([
      { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,' + Buffer.from('IMG').toString('base64') },
      { type: 'input_file', filename: 'report.pdf', file_data: 'data:application/pdf;base64,' + Buffer.from('PDF').toString('base64') },
      { type: 'input_text', text: 'read this' }
    ])
  })
})

describe('openai server-tool pricing', () => {
  it('publishes a web-search rate now that the tool is wired', () => {
    // It returned {} while this adapter had no web tool. The lesson pinned over in
    // llmCostService.test.mjs is that a MISSING rate bills searches at zero rather than
    // failing loudly, so an empty map here would silently make every ChatGPT search free.
    const prices = getServerToolPrices()
    expect(prices.webSearchPer1000).to.be.a('number').and.to.be.above(0)
    // open_page and find_in_page are actions of the same billable call, so they carry a rate
    // too — unlike Anthropic, where fetch is a separate, free-to-call tool.
    expect(prices.webFetchPer1000).to.be.a('number').and.to.be.above(0)
  })

  it('hands out a copy, so a caller cannot edit the connector\'s rates', () => {
    getServerToolPrices().webSearchPer1000 = 0
    expect(getServerToolPrices().webSearchPer1000).to.be.above(0)
  })
})

describe('openai structured output (additive, 2026-09-19)', () => {
  // What these pin: the schema reaches the wire in the provider's own spelling on BOTH
  // transports, a request without the option is byte-identical to before, and a model that
  // refuses the schema fails the call — it is never retried without the schema, which would
  // hand back unconstrained text under a structured-output success.
  const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false }
  const so = { name: 'x', description: 'd', schema, strict: true }

  it('maps the option to Responses text.format, and to nothing when absent', () => {
    const withIt = buildResponseParams({ model: 'gpt-5', prompt: 'hi', structuredOutput: so })
    expect(withIt.text).to.deep.equal({ format: { type: 'json_schema', name: 'x', description: 'd', schema, strict: true } })
    expect(withIt.store, 'store:false must survive').to.equal(false)
    expect(buildResponseParams({ model: 'gpt-5', prompt: 'hi' })).to.not.have.property('text')
  })

  it('a request WITHOUT the option is byte-identical to before (the additive rule)', () => {
    const before = buildResponseParams({ model: 'gpt-5', prompt: 'hi', effort: 'low', thinking: false })
    const after = buildResponseParams({ model: 'gpt-5', prompt: 'hi', effort: 'low', thinking: false, structuredOutput: null })
    expect(after).to.deep.equal(before)
  })

  it('carries the schema onto the Chat Completions fallback as response_format', () => {
    const chat = responsesParamsToChat(buildResponseParams({ model: 'gpt-4.1', prompt: 'hi', structuredOutput: so }))
    expect(chat.response_format).to.deep.equal({
      type: 'json_schema', json_schema: { name: 'x', description: 'd', schema, strict: true }
    })
    expect(responsesParamsToChat(buildResponseParams({ model: 'gpt-4.1', prompt: 'hi' }))).to.not.have.property('response_format')
  })

  it('a MODEL refusing the feature is a capability error — remembered, never a bare retry', async () => {
    const client = fakeClient([new Error('Structured outputs are not supported on this model')])
    const params = buildResponseParams({ model: 'gpt-so-nomodel', prompt: 'hi', structuredOutput: so })
    let caught = null
    try { await runWithDegrades(client, params, { model: 'gpt-so-nomodel' }) } catch (e) { caught = e }
    expect(caught && caught.code).to.equal('capability_unsupported_on_model')
    expect(caught.capability).to.equal('structuredOutput')
    expect(client.calls.length, 'must NOT retry without the schema').to.equal(1)
    expect((await getCapabilities({ model: 'gpt-so-nomodel' })).structuredOutput, 'the verdict is remembered').to.equal(false)
  })

  it('a SCHEMA the provider rejects is the caller\'s error — verbatim, and it must NOT poison the model\'s memo', async () => {
    // One bad schema must not make the model "incapable" for everyone for an hour. That is what
    // the first version did, and it blocked haiku server-wide during the first experiment.
    const client = fakeClient([new Error("Invalid schema for response_format 'x': In context=('properties', 'a'), 'minimum' is not permitted")])
    const params = buildResponseParams({ model: 'gpt-so-badschema', prompt: 'hi', structuredOutput: so })
    let caught = null
    try { await runWithDegrades(client, params, { model: 'gpt-so-badschema' }) } catch (e) { caught = e }
    expect(caught && caught.code).to.equal('structured_output_schema_rejected')
    expect(caught.status).to.equal(400)
    expect(caught.message, 'the provider\'s own sentence is the fix — it must travel back').to.contain("'minimum' is not permitted")
    expect(client.calls.length, 'must NOT retry without the schema').to.equal(1)
    expect((await getCapabilities({ model: 'gpt-so-badschema' })).structuredOutput, 'memo untouched').to.not.equal(false)
  })

  it('tells a model refusal from a bad schema by the provider\'s wording', () => {
    expect(classifyStructuredRejection(new Error('Structured outputs are not supported on this model'))).to.equal('model')
    expect(classifyStructuredRejection(new Error('This model does not support response_format json_schema'))).to.equal('model')
    expect(classifyStructuredRejection(new Error("Invalid schema for response_format 'x': 'minimum' is not permitted"))).to.equal('schema')
    expect(classifyStructuredRejection(new Error('text.format: additionalProperties must be false'))).to.equal('schema')
  })

  it('classifies schema rejections and leaves unrelated errors alone', () => {
    expect(isStructuredOutputRejection(new Error("Invalid schema for response_format 'x'"))).to.equal(true)
    expect(isStructuredOutputRejection(new Error('text.format is not supported by this model'))).to.equal(true)
    expect(isStructuredOutputRejection(new Error('credit balance is too low'))).to.equal(false)
  })
})
