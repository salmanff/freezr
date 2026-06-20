// Unit tests for the job-client fetch shim (Phase 6 — faithful Response incl. streaming body).
import { expect } from 'chai'
import { makeFetchShim, buildFreezrClient } from '../../../adapters/jobs/jobClientCore.mjs'

const readAll = async (res) => {
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    out += dec.decode(value)
  }
  return out
}

describe('jobClientCore.makeFetchShim (faithful Response)', function () {
  it('exposes json()/text()/body.getReader() over the transport bodyText', async function () {
    const shim = makeFetchShim(async () => ({ ok: true, status: 200, bodyText: JSON.stringify({ a: 1 }) }))
    const res = await shim('/ceps/query/x', { method: 'POST' })
    expect(res.ok).to.be.true
    expect(res.status).to.equal(200)
    expect(await res.json()).to.deep.equal({ a: 1 })
    expect(await res.text()).to.equal('{"a":1}')
    expect(await readAll(res)).to.equal('{"a":1}')
  })

  it('replays an SSE body through getReader (the llm streaming path is now possible in jobs)', async function () {
    const sse = 'data: {"type":"delta","text":"Hi"}\n\ndata: {"type":"done","success":true,"response":"Hi"}\n\n'
    const shim = makeFetchShim(async () => ({ ok: true, status: 200, bodyText: sse }))
    const res = await shim('/feps/llm/ask', { method: 'PUT' })
    expect(await readAll(res)).to.equal(sse)
  })

  it('surfaces a non-2xx envelope (ok:false + status + parseable error body) — no throw', async function () {
    const shim = makeFetchShim(async () => ({ ok: false, status: 403, bodyText: JSON.stringify({ error: 'nope' }) }))
    const res = await shim('/jobs/run/x', { method: 'POST' })
    expect(res.ok).to.be.false
    expect(res.status).to.equal(403)
    expect(await res.json()).to.deep.equal({ error: 'nope' })
  })

  it('turns a thrown transport error (network / no URL) into an error Response', async function () {
    const shim = makeFetchShim(async () => { const e = new Error('boom'); e.statusCode = 502; e.body = { error: 'down' }; throw e })
    const res = await shim('/x')
    expect(res.ok).to.be.false
    expect(res.status).to.equal(502)
    expect(await res.json()).to.deep.equal({ error: 'down' })
  })

  it('back-compat: a transport returning a plain parsed object is treated as a 200 JSON body', async function () {
    const shim = makeFetchShim(async () => ({ hello: 'world' }))
    const res = await shim('/x')
    expect(res.ok).to.be.true
    expect(await res.json()).to.deep.equal({ hello: 'world' })
  })
})

describe('jobClientCore.buildFreezrClient sandbox', function () {
  it('exposes TextDecoder/TextEncoder inside the vm (needed to decode llm SSE in a job)', function () {
    // A minimal fake "core" that reports whether the stream-decoding globals exist in the sandbox.
    const sources = {
      coreName: 'fake.js',
      core: 'window.freezr = { app: {}, hasTD: typeof TextDecoder !== "undefined", hasTE: typeof TextEncoder !== "undefined" }',
      addons: []
    }
    const client = buildFreezrClient({ transport: async () => ({ ok: true, status: 200, bodyText: '{}' }), freezrMeta: {}, sources })
    expect(client.hasTD, 'TextDecoder must be defined in the job vm').to.be.true
    expect(client.hasTE, 'TextEncoder must be defined in the job vm').to.be.true
  })
})
