// Unit tests for web access in the Anthropic connector (adapters/llmConnectors/anthropic.mjs).
//
// The load-bearing claim of this design is that freezr NEVER maintains a table of which model
// supports which feature — support is read from the provider or learned by trying. These tests
// pin the "learned by trying" half:
//   - the tool-version ladder tries the newer variant, then the older one, then gives up;
//   - a paused server-tool turn resumes by re-sending the assistant turn with NO added user
//     message (adding one corrupts the resume);
//   - a server-tool ERROR arrives as a normal 200 whose `content` is an OBJECT where success
//     is an ARRAY — reading it without branching would throw or silently produce nothing.
import { expect } from 'chai'
import {
  buildWebTools, isWebToolRejection, streamAndCollect, runWithDegrades, makeBlockRebuilder,
  buildThinkingConfig, applyOutputConfig, isStructuredOutputRejection, classifyStructuredRejection
} from '../../../adapters/llmConnectors/anthropic.mjs'

// Minimal fake of the streaming client: each element of `scripts` is one create() call, so a
// script array of length 2 means "the first attempt then the retry/resume".
const fakeClient = (scripts) => {
  const calls = []
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(JSON.parse(JSON.stringify(params)))
        const script = scripts[calls.length - 1]
        if (!script) throw new Error('fake client: unexpected extra call #' + calls.length)
        if (script instanceof Error) throw script
        return (async function * () { for (const c of script) yield c })()
      }
    }
  }
}

const textChunks = (text, stopReason = 'end_turn') => [
  { type: 'message_start', message: { usage: { input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } }
]

describe('anthropic web tools — definitions', () => {
  it('web:true declares both tools at the newest variant', () => {
    const tools = buildWebTools({ search: true, fetch: true })
    expect(tools.map(t => t.type)).to.deep.equal(['web_search_20260209', 'web_fetch_20260209'])
    expect(tools.map(t => t.name)).to.deep.equal(['web_search', 'web_fetch'])
  })

  it('falls back to the older variant pair by index, not by model id', () => {
    const tools = buildWebTools({ search: true, fetch: true }, 1)
    expect(tools.map(t => t.type)).to.deep.equal(['web_search_20250305', 'web_fetch_20250910'])
  })

  it('declares only the half that was asked for', () => {
    expect(buildWebTools({ search: true, fetch: false }).map(t => t.name)).to.deep.equal(['web_search'])
    expect(buildWebTools({ search: false, fetch: true }).map(t => t.name)).to.deep.equal(['web_fetch'])
  })

  it('never declares code_execution alongside the web tools', () => {
    // The _20260209 tools run it internally for dynamic filtering; a second execution
    // environment confuses the model.
    const tools = buildWebTools({ search: true, fetch: true })
    expect(tools.some(t => String(t.type).includes('code_execution'))).to.equal(false)
  })

  it('prefers the allow-list over the block-list (they are mutually exclusive)', () => {
    const [search] = buildWebTools({ search: { allowedDomains: ['a.com'], blockedDomains: ['b.com'] } })
    expect(search.allowed_domains).to.deep.equal(['a.com'])
    expect(search).to.not.have.property('blocked_domains')
  })

  it('turns fetch citations on by default, since sources are the audit trail', () => {
    const [fetch] = buildWebTools({ fetch: true })
    expect(fetch.citations).to.deep.equal({ enabled: true })
  })

  it('passes every per-request cost control through to the provider', () => {
    // These are how an app bounds its own spend. A live { web: true } question cost $0.57
    // (282k input tokens from 6 searches + 16 fetches) — maxContentTokens is the lever on
    // that, since fetched page bodies, not search fees, are what floods the context.
    const [search, fetch] = buildWebTools({
      search: { maxUses: 3, allowedDomains: ['wikipedia.org'] },
      fetch: { maxUses: 2, maxContentTokens: 4000 }
    })
    expect(search.max_uses).to.equal(3)
    expect(search.allowed_domains).to.deep.equal(['wikipedia.org'])
    expect(fetch.max_uses).to.equal(2)
    expect(fetch.max_content_tokens).to.equal(4000)
  })

  it('hands the raw escape hatch straight through, unvalidated', () => {
    // Documented as provider-specific: an app using it has opted out of freezr translating.
    const raw = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 99 }]
    expect(buildWebTools({ search: true, raw: { anthropic: raw } })).to.deep.equal(raw)
  })

  it('returns null when nothing was requested', () => {
    expect(buildWebTools(null)).to.equal(null)
    expect(buildWebTools({ search: false, fetch: false })).to.equal(null)
  })
})

describe('anthropic web tools — result collection', () => {
  it('collects queries, sources and the search request count', async () => {
    const client = fakeClient([[
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', name: 'web_search', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"freezr' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ' news"}' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'web_search_tool_result', content: [{ url: 'https://x.com/a', title: 'A' }, { url: 'https://y.com/b', title: 'B' }] }
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Here you go' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }
    ]])

    const out = await streamAndCollect(client, { messages: [], model: 'claude-opus-5' })
    expect(out.textResponse).to.equal('Here you go')
    expect(out.toolsUsed.webSearch.requests).to.equal(1)
    expect(out.toolsUsed.webSearch.queries).to.deep.equal(['freezr news'])
    expect(out.toolsUsed.webSearch.sources).to.deep.equal([
      { url: 'https://x.com/a', title: 'A' }, { url: 'https://y.com/b', title: 'B' }
    ])
  })

  it('treats a server-tool error object as an error, not as a list of results', async () => {
    // Success `content` is an ARRAY; an error `content` is an OBJECT. Indexing without
    // branching is the bug this pins.
    const client = fakeClient([[
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', name: 'web_search' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', content: { error_code: 'max_uses_exceeded' } } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    ]])

    const out = await streamAndCollect(client, { messages: [] })
    expect(out.toolsUsed.errors).to.deep.equal([{ tool: 'web_search', code: 'max_uses_exceeded' }])
    expect(out.toolsUsed.webSearch.sources).to.deep.equal([])
  })

  it('records fetched URLs so what left the conversation is auditable', async () => {
    const client = fakeClient([[
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', name: 'web_fetch' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'web_fetch_tool_result', content: { url: 'https://example.com/page' } } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    ]])

    const out = await streamAndCollect(client, { messages: [] })
    expect(out.toolsUsed.webFetch).to.deep.equal({ requests: 1, urls: ['https://example.com/page'] })
  })

  it('collects citations from citations_delta', async () => {
    const client = fakeClient([[
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Claimed' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { url: 'https://src', title: 'Src', cited_text: 'because' } } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    ]])

    const out = await streamAndCollect(client, { messages: [] })
    expect(out.citations).to.deep.equal([{ url: 'https://src', title: 'Src', citedText: 'because' }])
  })

  it('emits streaming tool events so a UI can show "searching…"', async () => {
    const client = fakeClient([[
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', name: 'web_search' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"q"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', content: [{ url: 'https://z' }] } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    ]])

    const events = []
    await streamAndCollect(client, { messages: [] }, { onEvent: e => events.push(e) })
    const toolEvents = events.filter(e => e.type === 'tool')
    // 'started' fires as soon as the tool call opens so the UI can react immediately; the
    // query only becomes readable once its input JSON has finished streaming, which is why
    // 'searching' (carrying the query) lands after it and before the result.
    expect(toolEvents.map(e => e.status)).to.deep.equal(['started', 'searching', 'result'])
    expect(toolEvents.find(e => e.status === 'searching').query).to.equal('q')
  })
})

describe('anthropic web tools — pause_turn resume', () => {
  it('resumes by re-sending the assistant turn with NO added user message', async () => {
    const client = fakeClient([
      [
        { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', name: 'web_search' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"a"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'pause_turn' } }
      ],
      textChunks(' finished')
    ])

    const out = await streamAndCollect(client, { messages: [{ role: 'user', content: 'hi' }] })
    expect(client.calls).to.have.length(2)

    const resumed = client.calls[1].messages
    expect(resumed).to.have.length(2)
    expect(resumed[0]).to.deep.equal({ role: 'user', content: 'hi' })
    expect(resumed[1].role).to.equal('assistant')
    // The trailing server_tool_use block is what tells the API to continue.
    expect(resumed[1].content[0].type).to.equal('server_tool_use')
    expect(resumed[1].content[0].input).to.deep.equal({ query: 'a' })
    // No 'Continue.' turn was appended.
    expect(resumed.filter(m => m.role === 'user')).to.have.length(1)
    expect(out.textResponse).to.equal(' finished')
    expect(out.stopReason).to.equal('end_turn')
  })

  it('caps resumes and reports the answer as partial rather than looping', async () => {
    const paused = [{ type: 'message_delta', delta: { stop_reason: 'pause_turn' } }]
    const client = fakeClient([paused, paused, paused, paused])
    const out = await streamAndCollect(client, { messages: [] })
    expect(client.calls).to.have.length(4) // initial + MAX_PAUSE_TURN_RESUMES(3)
    expect(out.stopReason).to.equal('pause_turn')
  })
})

describe('anthropic web tools — the try-and-degrade ladder (tier 3)', () => {
  it('recognises a tool rejection', () => {
    expect(isWebToolRejection(new Error('web_search_20260209 is not supported'))).to.equal(true)
    expect(isWebToolRejection(new Error('tool type is unsupported for this model'))).to.equal(true)
    expect(isWebToolRejection(new Error('credit balance too low'))).to.equal(false)
  })

  it('retries with the older tool variant before giving up', async () => {
    const client = fakeClient([
      new Error('web_search_20260209 is not supported by this model'),
      textChunks('ok')
    ])
    const params = { messages: [], model: 'some-older-model', tools: buildWebTools({ search: true, fetch: true }) }
    const out = await runWithDegrades(client, params, { web: { search: true, fetch: true }, model: 'some-older-model' })

    expect(client.calls[0].tools[0].type).to.equal('web_search_20260209')
    expect(client.calls[1].tools[0].type).to.equal('web_search_20250305')
    expect(out.textResponse).to.equal('ok')
    expect(out.webDropped).to.equal(false)
  })

  it('hard-fails with a capability error when no variant works', async () => {
    const client = fakeClient([
      new Error('web_search is not supported'),
      new Error('web_search is not supported')
    ])
    const params = { messages: [], model: 'ancient', tools: buildWebTools({ search: true, fetch: true }) }
    let caught = null
    try {
      await runWithDegrades(client, params, { web: { search: true, fetch: true }, model: 'ancient' })
    } catch (e) { caught = e }

    expect(caught).to.not.equal(null)
    expect(caught.code).to.equal('capability_unsupported_on_model')
    expect(caught.capability).to.equal('web')
  })

  it('drops the tools and continues when the caller passed optional', async () => {
    const client = fakeClient([
      new Error('web_search is not supported'),
      new Error('web_search is not supported'),
      textChunks('answered without the web')
    ])
    const params = { messages: [], model: 'ancient', tools: buildWebTools({ search: true, fetch: true }) }
    const out = await runWithDegrades(client, params, {
      web: { search: true, fetch: true, optional: true }, model: 'ancient'
    })

    expect(out.textResponse).to.equal('answered without the web')
    expect(out.webDropped).to.equal(true)
    expect(client.calls[2]).to.not.have.property('tools')
  })

  it('still degrades thinking and effort as it did before', async () => {
    const client = fakeClient([
      new Error('output_config.effort is not supported'),
      textChunks('fine')
    ])
    const params = { messages: [], model: 'm', output_config: { effort: 'max' } }
    const out = await runWithDegrades(client, params, { model: 'm' })
    expect(client.calls[1]).to.not.have.property('output_config')
    expect(out.textResponse).to.equal('fine')
  })

  it('re-throws an unrelated error rather than degrading blindly', async () => {
    const client = fakeClient([new Error('credit balance is too low')])
    let caught = null
    try {
      await runWithDegrades(client, { messages: [], model: 'm', tools: buildWebTools({ search: true }) }, { web: { search: true }, model: 'm' })
    } catch (e) { caught = e }
    expect(caught && caught.message).to.contain('credit balance')
  })
})

describe('anthropic block rebuilder', () => {
  it('reassembles streamed tool input into parsed JSON', () => {
    const r = makeBlockRebuilder()
    r.start(0, { type: 'server_tool_use', name: 'web_search' })
    r.delta(0, { type: 'input_json_delta', partial_json: '{"que' })
    r.delta(0, { type: 'input_json_delta', partial_json: 'ry":"x"}' })
    const block = r.stop(0)
    expect(block.input).to.deep.equal({ query: 'x' })
    expect(block).to.not.have.property('_partialJson')
  })

  it('KEEPS an input that arrived whole on content_block_start', () => {
    // Regression: stop() used to blank `input` to {} whenever no input_json_delta had
    // streamed. Observed live with the dynamic-filtering web tools — it emptied
    // toolsUsed.webSearch.queries, and would also corrupt a pause_turn resume, which
    // re-sends this very block to the API.
    const r = makeBlockRebuilder()
    r.start(0, { type: 'server_tool_use', name: 'web_search', input: { query: 'arrived whole' } })
    expect(r.stop(0).input).to.deep.equal({ query: 'arrived whole' })
  })

  it('leaves no _partialJson scratch field on a block sent back to the API', () => {
    const r = makeBlockRebuilder()
    r.start(0, { type: 'server_tool_use', name: 'web_search', input: { query: 'x' } })
    expect(r.stop(0)).to.not.have.property('_partialJson')
  })

  it('survives malformed partial JSON without throwing', () => {
    const r = makeBlockRebuilder()
    r.start(0, { type: 'server_tool_use', name: 'web_search' })
    r.delta(0, { type: 'input_json_delta', partial_json: '{"query":' })
    expect(() => r.stop(0)).to.not.throw()
  })
})

describe('thinking shape — the provider answers, the regex is only a fallback', () => {
  // The exact shape the live Models API returns (verified 2026-09).
  const ADAPTIVE_ONLY = { thinking: { supported: true, types: { enabled: { supported: false }, adaptive: { supported: true } } } }
  const BUDGET_MODEL = { thinking: { supported: true, types: { enabled: { supported: true }, adaptive: { supported: false } } } }

  it('uses adaptive when the tree says the legacy budget form is unsupported', () => {
    expect(buildThinkingConfig('claude-opus-5', true, 30000, ADAPTIVE_ONLY)).to.deep.equal({ type: 'adaptive' })
  })

  it('uses the budget form when the tree says that is what the model takes', () => {
    const cfg = buildThinkingConfig('claude-haiku-4-5', true, 30000, BUDGET_MODEL)
    expect(cfg.type).to.equal('enabled')
    expect(cfg.budget_tokens).to.be.a('number')
  })

  it('believes the TREE over the model name', () => {
    // A name the fallback regex would read as adaptive-only, with a tree that says otherwise.
    // If this returns 'adaptive', the regex is still in charge and the fix regressed.
    expect(buildThinkingConfig('claude-opus-5', true, 30000, BUDGET_MODEL).type).to.equal('enabled')
    // …and the reverse: a name the regex would call budget-only, tree says adaptive.
    expect(buildThinkingConfig('claude-haiku-4-5', true, 30000, ADAPTIVE_ONLY)).to.deep.equal({ type: 'adaptive' })
  })

  it('falls back to the version regex when no tree is available', () => {
    // Offline / cold cache / a model missing from the list — behaviour is unchanged from before.
    expect(buildThinkingConfig('claude-opus-5', true, 30000, null)).to.deep.equal({ type: 'adaptive' })
    expect(buildThinkingConfig('claude-haiku-4-5', true, 30000, null).type).to.equal('enabled')
  })

  it('a tree that is silent about thinking also falls back', () => {
    expect(buildThinkingConfig('claude-opus-5', true, 30000, { image_input: { supported: true } }))
      .to.deep.equal({ type: 'adaptive' })
  })

  it('explicit false still means "do not think", by whichever route', () => {
    expect(buildThinkingConfig('claude-opus-5', false, 30000, ADAPTIVE_ONLY)).to.deep.equal({ type: 'disabled' })
    expect(buildThinkingConfig('claude-haiku-4-5', false, 30000, BUDGET_MODEL)).to.equal(null)
  })
})

describe('hitting the caller\'s own cap', () => {
  it('flags limitReached, distinct from a page simply being unreachable', async () => {
    // maxUses exceeded means the answer is shallower than it could be and the caller can
    // act on it. url_not_accessible means a page was blocked and there is nothing to do.
    // An app must be able to tell them apart without parsing provider error codes.
    const client = fakeClient([[
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', name: 'web_search' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', content: { error_code: 'max_uses_exceeded' } } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'server_tool_use', name: 'web_fetch' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'content_block_start', index: 3, content_block: { type: 'web_fetch_tool_result', content: { error_code: 'url_not_accessible' } } },
      { type: 'content_block_stop', index: 3 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    ]])
    const out = await streamAndCollect(client, { messages: [] })
    expect(out.toolsUsed.limitReached).to.deep.equal({ search: true, fetch: false })
    expect(out.toolsUsed.errors).to.have.length(2) // both still reported
  })

  it('omits limitReached entirely when no cap was hit', async () => {
    const client = fakeClient([[
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', name: 'web_search' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', content: [{ url: 'https://a' }] } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    ]])
    const out = await streamAndCollect(client, { messages: [] })
    expect(out.toolsUsed).to.not.have.property('limitReached')
  })
})

describe('server-tool billing', () => {
  it('counts a search that arrived whole, so its query is not lost', async () => {
    // The end-to-end shape that produced `queries: []` against the live API.
    const client = fakeClient([[
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', name: 'web_search', input: { query: 'wikipedia api' } } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', content: [{ url: 'https://w', title: 'W' }] } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    ]])
    const out = await streamAndCollect(client, { messages: [] })
    expect(out.toolsUsed.webSearch.queries).to.deep.equal(['wikipedia api'])
  })

  it('reconciles fetch errors against successful URLs', async () => {
    // 3 fetches: 2 blocked, 1 through — the live run's 16/14/2 pattern in miniature.
    const client = fakeClient([[
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', name: 'web_fetch' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'web_fetch_tool_result', content: { error_code: 'url_not_in_prior_context' } } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'server_tool_use', name: 'web_fetch' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'content_block_start', index: 3, content_block: { type: 'web_fetch_tool_result', content: { error_code: 'url_not_accessible' } } },
      { type: 'content_block_stop', index: 3 },
      { type: 'content_block_start', index: 4, content_block: { type: 'server_tool_use', name: 'web_fetch' } },
      { type: 'content_block_stop', index: 4 },
      { type: 'content_block_start', index: 5, content_block: { type: 'web_fetch_tool_result', content: { url: 'https://en.wikipedia.org/wiki/API' } } },
      { type: 'content_block_stop', index: 5 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    ]])
    const out = await streamAndCollect(client, { messages: [] })
    expect(out.toolsUsed.webFetch.requests).to.equal(3)
    expect(out.toolsUsed.webFetch.urls).to.deep.equal(['https://en.wikipedia.org/wiki/API'])
    expect(out.toolsUsed.errors.map(e => e.code)).to.deep.equal(['url_not_in_prior_context', 'url_not_accessible'])
  })
})

describe('anthropic structured output (additive, 2026-09-19)', () => {
  // `effort` and the response schema share ONE box, output_config, and the ladder used to throw
  // that whole box away on any rejection. These pin that the two now have separate fates: effort
  // can still be dropped and retried, the schema is never dropped — and the effort-only case
  // (the only one that existed before) ends in exactly the state it always did.
  const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false }
  const format = { type: 'json_schema', schema }

  it('builds output_config from whichever of the two was asked for', () => {
    expect(applyOutputConfig({}, { effort: 'low' }).output_config).to.deep.equal({ effort: 'low' })
    expect(applyOutputConfig({}, { structuredOutput: { schema } }).output_config).to.deep.equal({ format })
    expect(applyOutputConfig({}, { effort: 'low', structuredOutput: { schema } }).output_config).to.deep.equal({ effort: 'low', format })
    expect(applyOutputConfig({}, {})).to.not.have.property('output_config')
    expect(applyOutputConfig({}, { structuredOutput: null }), 'null option = nothing asked').to.not.have.property('output_config')
  })

  it('an effort rejection drops ONLY effort and keeps the schema', async () => {
    const client = fakeClient([new Error('output_config.effort is not supported'), textChunks('{"a":"b"}')])
    const params = { messages: [], model: 'm-so1', output_config: { effort: 'max', format } }
    const out = await runWithDegrades(client, params, { model: 'm-so1' })
    expect(client.calls[1].output_config, 'the schema must survive the effort retry').to.deep.equal({ format })
    expect(out.textResponse).to.equal('{"a":"b"}')
  })

  it('a schema rejection is a capability error — never a retry without the schema', async () => {
    const client = fakeClient([new Error('output_config.format: structured outputs are not supported on this model')])
    let caught = null
    try {
      await runWithDegrades(client, { messages: [], model: 'm-so2', output_config: { format } }, { model: 'm-so2' })
    } catch (e) { caught = e }
    expect(caught && caught.code).to.equal('capability_unsupported_on_model')
    expect(caught.capability).to.equal('structuredOutput')
    expect(client.calls.length, 'must NOT retry without the schema').to.equal(1)
  })

  it('a generic output_config rejection WITH a schema present fails rather than answering unconstrained', async () => {
    // We cannot tell which part offended, so stripping the box would be a silent contract break.
    const client = fakeClient([new Error('output_config is not a valid parameter for this model')])
    let caught = null
    try {
      await runWithDegrades(client, { messages: [], model: 'm-so3', output_config: { effort: 'low', format } }, { model: 'm-so3' })
    } catch (e) { caught = e }
    // ambiguous wording: we cannot tell the model from the schema, so it fails WITHOUT being
    // remembered against the model — the safe side of the two possible mistakes
    expect(caught && caught.code).to.equal('structured_output_schema_rejected')
    expect(client.calls.length).to.equal(1)
  })

  it('a SCHEMA the provider rejects is the caller\'s error, verbatim, and not a verdict on the model', async () => {
    const client = fakeClient([new Error("output_config.format.schema: 'minItems' is not a supported keyword")])
    let caught = null
    try {
      await runWithDegrades(client, { messages: [], model: 'm-so5', output_config: { format } }, { model: 'm-so5' })
    } catch (e) { caught = e }
    expect(caught && caught.code).to.equal('structured_output_schema_rejected')
    expect(caught.status).to.equal(400)
    expect(caught.message, 'the provider\'s sentence is the fix').to.contain("'minItems' is not a supported keyword")
    expect(client.calls.length, 'never retried without the schema').to.equal(1)
  })

  it('tells a model refusal from a bad schema by the provider\'s wording', () => {
    expect(classifyStructuredRejection(new Error('output_config.format: structured outputs are not supported on this model'))).to.equal('model')
    expect(classifyStructuredRejection(new Error("output_config.format.schema: 'minItems' is not a supported keyword"))).to.equal('schema')
    expect(classifyStructuredRejection(new Error('output_config is not a valid parameter for this model')), 'ambiguous → the side that cannot poison the memo').to.equal('schema')
  })

  it('the effort-only case behaves exactly as before (regression pin for every existing caller)', async () => {
    const client = fakeClient([new Error('output_config.effort is not supported'), textChunks('fine')])
    const params = { messages: [], model: 'm-so4', output_config: { effort: 'max' } }
    const out = await runWithDegrades(client, params, { model: 'm-so4' })
    expect(client.calls[1], 'an emptied output_config is removed, as it always was').to.not.have.property('output_config')
    expect(out.textResponse).to.equal('fine')
  })

  it('classifies schema rejections and leaves unrelated errors alone', () => {
    expect(isStructuredOutputRejection(new Error('output_config.format is invalid'))).to.equal(true)
    expect(isStructuredOutputRejection(new Error('json_schema: unsupported keyword'))).to.equal(true)
    expect(isStructuredOutputRejection(new Error('output_config.effort is not supported'))).to.equal(false)
    expect(isStructuredOutputRejection(new Error('credit balance is too low'))).to.equal(false)
  })
})
