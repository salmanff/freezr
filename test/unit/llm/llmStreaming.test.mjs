// Unit tests for the SSE resilience of freezrApiV2.llm.js `_streamingAsk`.
//
// Background: "Stream ended without a done event" was the client's catch-all for a connection
// that closed cleanly before the terminal event — the single most common LLM failure in the wild,
// because every proxy between the app and the server (Heroku 55s, nginx 60s, Cloudflare 100s)
// kills an SSE stream that goes quiet during prefill or reasoning. The server now heartbeats and
// always writes a terminal event; the client tolerates re-chunking and hands back what it got.
//
// Exercised through the REAL client sources via the job sandbox, so these cover the browser and
// headless paths at once.
import { expect } from 'chai'
import { buildFreezrClient } from '../../../adapters/jobs/jobClientCore.mjs'
import { loadHostClientSources } from '../../../adapters/jobs/jobFreezrClient.mjs'

const buildClient = (responder) => {
  const calls = []
  const transport = async (method, path, body) => {
    calls.push({ method, path, body })
    return responder(calls.length, method, path, body)
  }
  const freezr = buildFreezrClient({
    transport,
    freezrMeta: { appName: 'com.example.test', appToken: 'tok' },
    sources: loadHostClientSources()
  })
  return { freezr, calls }
}

const sse = (...events) => events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('')
const DONE = { type: 'done', success: true, response: 'Hello world', meta: { model: 'x' } }

describe('freezr.llm streaming resilience', function () {
  it('ignores SSE comment lines (the server anti-idle heartbeat)', async function () {
    const body = ': hb\n\n' + sse({ type: 'delta', text: 'Hello world' }) + ': hb\n\n' + sse(DONE)
    const { freezr } = buildClient(() => ({ ok: true, status: 200, bodyText: body }))
    const deltas = []
    const res = await freezr.llm.ask('hi', { streamBack: true, onDelta: t => deltas.push(t) })
    expect(res.success).to.be.true
    expect(res.response).to.equal('Hello world')
    expect(deltas).to.deep.equal(['Hello world'])
  })

  it('reads a done event that arrives without a trailing newline', async function () {
    // Proxies re-chunk freely; the tail used to be stranded in the buffer and never parsed.
    const body = sse({ type: 'delta', text: 'Hello world' }) + 'data: ' + JSON.stringify(DONE)
    const { freezr } = buildClient(() => ({ ok: true, status: 200, bodyText: body }))
    const res = await freezr.llm.ask('hi')
    expect(res.success).to.be.true
    expect(res.response).to.equal('Hello world')
  })

  it('surfaces a server error event with its code and the partial text', async function () {
    const body = sse({ type: 'delta', text: 'Half ' }, { type: 'error', error: 'boom', code: 'no_done' })
    const { freezr } = buildClient(() => ({ ok: true, status: 200, bodyText: body }))
    let err = null
    try {
      await freezr.llm.ask('hi')
    } catch (e) { err = e }
    expect(err, 'the error event must reject the call').to.exist
    expect(err.message).to.equal('boom')
    expect(err.code).to.equal('no_done')
    expect(err.partial).to.equal('Half ')
  })

  it('retries automatically when the connection drops before any text arrived', async function () {
    const { freezr, calls } = buildClient((n) => ({
      ok: true,
      status: 200,
      bodyText: n === 1 ? '' : sse(DONE) // first attempt: clean EOF, nothing streamed
    }))
    const res = await freezr.llm.ask('hi')
    expect(res.success).to.be.true
    expect(calls.filter(c => String(c.path).includes('/feps/llm/ask'))).to.have.lengthOf(2)
  })

  it('does NOT auto-retry once text has streamed — it hands back the partial instead', async function () {
    // Re-asking here would double-bill the user and duplicate text in their UI, so the decision
    // belongs to the app: it gets `partial` and can salvage or restart deliberately.
    const body = sse({ type: 'delta', text: 'Half an answe' }) // dropped mid-answer, no done
    const { freezr, calls } = buildClient(() => ({ ok: true, status: 200, bodyText: body }))
    let err = null
    try {
      await freezr.llm.ask('hi', { streamBack: true, onDelta: () => {} })
    } catch (e) { err = e }
    expect(err).to.exist
    expect(err.code).to.equal('stream_incomplete')
    expect(err.partial).to.equal('Half an answe')
    expect(err.deltaCount).to.equal(1)
    expect(calls.filter(c => String(c.path).includes('/feps/llm/ask')), 'must not re-ask').to.have.lengthOf(1)
  })

  it('honours retries: 0', async function () {
    const { freezr, calls } = buildClient(() => ({ ok: true, status: 200, bodyText: '' }))
    let err = null
    try {
      await freezr.llm.ask('hi', { retries: 0 })
    } catch (e) { err = e }
    expect(err.code).to.equal('stream_incomplete')
    expect(err.deltaCount).to.equal(0)
    expect(calls.filter(c => String(c.path).includes('/feps/llm/ask'))).to.have.lengthOf(1)
  })
})
