// Unit tests for the job-client fetch shim (Phase 6 — faithful Response incl. streaming body).
import { expect } from 'chai'
import { makeFetchShim, buildFreezrClient } from '../../../adapters/jobs/jobClientCore.mjs'
import { loadHostClientSources } from '../../../adapters/jobs/jobFreezrClient.mjs'

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

  it('exposes Buffer/Blob inside the vm (needed for headless base64 file I/O)', function () {
    const sources = {
      coreName: 'fake.js',
      core: 'window.freezr = { app: {}, hasBuffer: typeof Buffer !== "undefined", hasBlob: typeof Blob !== "undefined" }',
      addons: []
    }
    const client = buildFreezrClient({ transport: async () => ({ ok: true, status: 200, bodyText: '{}' }), freezrMeta: {}, sources })
    expect(client.hasBuffer, 'Buffer must be defined in the job vm').to.be.true
    expect(client.hasBlob, 'Blob must be defined in the job vm').to.be.true
  })
})

// End-to-end through the REAL client sources: prove the two binary file paths fall back to
// base64-over-JSON when headless (freezr.app.isWebBased === false, set by buildFreezrClient).
describe('jobClientCore headless file I/O (base64 over JSON)', function () {
  // A transport that records the last request and returns a canned response per path.
  const makeRecordingTransport = (responder) => {
    const calls = []
    const transport = async (method, path, body) => {
      calls.push({ method, path, body })
      return responder(method, path, body)
    }
    return { transport, calls }
  }

  const buildClient = (transport) => buildFreezrClient({
    transport,
    freezrMeta: { appName: 'com.example.test', appToken: 'tok' },
    sources: loadHostClientSources()
  })

  it('freezr.upload(Blob) sends PUT JSON with contentBase64 that decodes to the original bytes', async function () {
    const bytes = Uint8Array.from([0x00, 0xff, 0x10, 0xc3, 0x28, 0x42]) // includes invalid-UTF8 bytes
    const { transport, calls } = makeRecordingTransport(() => ({ ok: true, status: 200, bodyText: JSON.stringify({ _id: 'x' }) }))
    const freezr = buildClient(transport)
    const res = await freezr.upload(new Blob([bytes]), { fileName: 'doc.bin', targetFolder: 'attachments' })
    expect(res).to.deep.equal({ _id: 'x' })

    const call = calls.find(c => c.method === 'PUT' && String(c.path).includes('/feps/upload/'))
    expect(call, 'an upload PUT must be sent').to.exist
    expect(call.body.fileName).to.equal('doc.bin')
    expect(call.body.targetFolder).to.equal('attachments')
    expect(call.body).to.not.have.property('file') // not multipart
    const roundTrip = Buffer.from(call.body.contentBase64, 'base64')
    expect(Uint8Array.from(roundTrip)).to.deep.equal(bytes) // bytes survive intact
  })

  it('getAttachment() requests ?encoding=base64 and rebuilds a Blob with the exact bytes', async function () {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]) // PNG-ish header + binary
    const b64 = Buffer.from(bytes).toString('base64')
    const { transport, calls } = makeRecordingTransport((method, path) => {
      if (String(path).includes('/attachments/')) {
        return { ok: true, status: 200, bodyText: JSON.stringify({ success: true, mimeType: 'image/png', contentBase64: b64 }) }
      }
      return { ok: true, status: 200, bodyText: '{}' }
    })
    const freezr = buildClient(transport)
    const blob = await freezr.connections.mail.getAttachment({ connectionName: 'gmail', messageId: 'm1', attachmentId: 'a1', mimeType: 'image/png' })

    const call = calls.find(c => String(c.path).includes('/attachments/'))
    expect(call.path, 'must request the base64 encoding').to.contain('encoding=base64')
    expect(blob).to.be.instanceOf(Blob)
    expect(blob.type).to.equal('image/png')
    const out = new Uint8Array(await blob.arrayBuffer())
    expect(out).to.deep.equal(bytes)
  })

  it('getAttachment({ responseType: "base64" }) returns the raw base64 string', async function () {
    const b64 = Buffer.from(Uint8Array.from([1, 2, 3, 250])).toString('base64')
    const { transport } = makeRecordingTransport((method, path) =>
      String(path).includes('/attachments/')
        ? { ok: true, status: 200, bodyText: JSON.stringify({ success: true, mimeType: 'application/octet-stream', contentBase64: b64 }) }
        : { ok: true, status: 200, bodyText: '{}' })
    const freezr = buildClient(transport)
    const out = await freezr.connections.mail.getAttachment({ connectionName: 'g', messageId: 'm', attachmentId: 'a', responseType: 'base64' })
    expect(out).to.equal(b64)
  })

  it('llm.ask({ files }) sends filesBase64 JSON (not multipart) decoding to the original bytes', async function () {
    const bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]) // %PDF + binary
    // /feps/llm/ask replies with SSE; the shim/_streamingAsk consume it as a single chunk.
    const sse = 'data: {"type":"done","success":true,"response":"ok","meta":{}}\n\n'
    const { transport, calls } = makeRecordingTransport(() => ({ ok: true, status: 200, bodyText: sse }))
    const freezr = buildClient(transport)
    const res = await freezr.llm.ask('summarise this', {
      files: new Blob([bytes], { type: 'application/pdf' }),
      provider: 'Claude'
    })
    expect(res.success).to.be.true

    const call = calls.find(c => String(c.path).includes('/feps/llm/ask'))
    expect(call, 'an llm/ask request must be sent').to.exist
    expect(call.body).to.not.have.property('file') // not multipart
    expect(call.body.prompt).to.equal('summarise this')
    expect(call.body.options.provider).to.equal('Claude')
    expect(call.body.filesBase64).to.have.lengthOf(1)
    expect(call.body.filesBase64[0].mimeType).to.equal('application/pdf')
    const roundTrip = Buffer.from(call.body.filesBase64[0].contentBase64, 'base64')
    expect(Uint8Array.from(roundTrip)).to.deep.equal(bytes)
  })

  it('llm.ask({ files: [{ fileName, contentBase64 }] }) passes a pre-encoded file through', async function () {
    const b64 = Buffer.from(Uint8Array.from([9, 8, 7])).toString('base64')
    const sse = 'data: {"type":"done","success":true,"response":"ok","meta":{}}\n\n'
    const { transport, calls } = makeRecordingTransport(() => ({ ok: true, status: 200, bodyText: sse }))
    const freezr = buildClient(transport)
    await freezr.llm.ask('go', { files: [{ fileName: 'a.csv', mimeType: 'text/csv', contentBase64: b64 }] })
    const call = calls.find(c => String(c.path).includes('/feps/llm/ask'))
    expect(call.body.filesBase64[0]).to.deep.equal({ fileName: 'a.csv', mimeType: 'text/csv', contentBase64: b64 })
  })
})
