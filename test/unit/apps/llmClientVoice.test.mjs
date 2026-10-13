// Unit tests for freezr.llm.transcribe() / speak() in the browser SDK
// (freezrsystmapps/info.freezr.public/public/freezrApiV2.llm.js).
//
// WHY THIS FILE EXISTS, specifically. The first working version of transcribe() passed
// `{ isFormData: true }` to freezr.apiRequest — which is the option name used by _streamingAsk,
// the LLM add-on's OWN helper a few dozen lines above it. The core apiRequest gates FormData
// pass-through on `uploadFile` instead. Nothing errored: apiRequest JSON.stringified the
// FormData into "{}", the server received an empty body, multer found no file, and the whole
// thing surfaced three layers away as "No audio provided" with nothing pointing at the cause.
//
// A test that reads the request the SDK actually builds is the only place that mistake is
// visible, so that is what these do. They load the shipped file into a sandbox and record what
// reaches apiRequest.
import { expect } from 'chai'
import { readFileSync } from 'fs'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SDK = path.join(here, '../../../freezrsystmapps/info.freezr.public/public/freezrApiV2.llm.js')

// A FormData stand-in that records what was appended, so a test can read the parts back.
class FakeFormData {
  constructor () { this.parts = [] }
  append (name, value) { this.parts.push({ name, value }) }
  get (name) { return this.parts.find(p => p.name === name)?.value }
}

// ask() does NOT go through apiRequest — it streams over fetch — so the file-bearing ask is
// only observable by recording the fetch. Replays a one-event SSE body so the call completes.
const sseFetch = (fetches) => async (url, init) => {
  fetches.push({ url, init })
  const event = 'data: ' + JSON.stringify({ type: 'done', success: true, response: 'ok', meta: {} }) + '\n\n'
  const bytes = new TextEncoder().encode(event)
  let sent = false
  return {
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true, value: undefined }
          sent = true
          return { done: false, value: bytes }
        }
      })
    }
  }
}

const loadLlmSdk = ({ isWebBased = true } = {}) => {
  const calls = []
  const fetches = []
  const freezr = {
    app: { isWebBased },
    utils: { getCookie: () => 'token' },
    apiRequest: async (method, url, body, options) => {
      calls.push({ method, url, body, options })
      return { success: true, text: 'transcribed words', meta: {} }
    }
  }
  const sandbox = {
    freezr,
    freezrMeta: { userId: 'u', serverAddress: '', appToken: 't' },
    console: { log: () => {}, error: () => {}, warn: () => {} },
    fetch: sseFetch(fetches),
    Blob: class {},
    FormData: FakeFormData,
    TextDecoder,
    Buffer
  }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(SDK, 'utf8'), sandbox)
  return { llm: freezr.llm, calls, fetches }
}

describe('freezr.llm.transcribe() — the request it builds', () => {
  const audio = { fileName: 'clip.webm', mimeType: 'audio/webm', contentBase64: 'AAAA' }

  it('tells apiRequest to pass the FormData through, using the name apiRequest reads', async () => {
    // THE REGRESSION. `isFormData` is a real option name in this file — on _streamingAsk — so
    // it looks right and fails silently. Only `uploadFile` reaches the core apiRequest branch
    // that skips JSON.stringify.
    const { llm, calls } = loadLlmSdk()
    await llm.transcribe(audio)
    expect(calls).to.have.length(1)
    expect(calls[0].options.uploadFile, 'must be uploadFile, not isFormData').to.equal(true)
    expect(calls[0].options.isFormData, 'isFormData is the wrong helper\'s option').to.equal(undefined)
  })

  it('sends the audio as a real FormData, not a JSON-serialised object', async () => {
    const { llm, calls } = loadLlmSdk()
    await llm.transcribe(audio)
    expect(calls[0].body).to.be.instanceOf(FakeFormData)
    expect(calls[0].body.get('file')).to.equal(audio)
    // A JSON.stringify of FormData yields "{}" — which is exactly what the bug produced.
    expect(JSON.stringify(calls[0].body)).to.not.equal('{}')
  })

  it('puts the options in the multipart part the server unpacks', async () => {
    const { llm, calls } = loadLlmSdk()
    await llm.transcribe(audio, { language: 'en', model: 'gpt-4o-transcribe' })
    expect(JSON.parse(calls[0].body.get('options'))).to.deep.equal({ model: 'gpt-4o-transcribe', language: 'en' })
  })

  it('hits the transcribe route', async () => {
    const { llm, calls } = loadLlmSdk()
    await llm.transcribe(audio)
    expect(calls[0].method).to.equal('PUT')
    expect(calls[0].url).to.equal('/feps/llm/transcribe')
  })

  it('uses base64 JSON, NOT FormData, in a job runtime', async () => {
    // A background job has no multipart transport. The server's uploadLlmIfNeeded rebuilds
    // req.files from filesBase64, which is why the controller reads req.files either way.
    const { llm, calls } = loadLlmSdk({ isWebBased: false })
    await llm.transcribe(audio, { language: 'en' })
    expect(calls[0].options.uploadFile).to.equal(undefined)
    expect(calls[0].body.filesBase64).to.have.length(1)
    expect(calls[0].body.filesBase64[0].fileName).to.equal('clip.webm')
    expect(calls[0].body.options).to.deep.equal({ language: 'en' })
  })

  it('returns what the server said', async () => {
    const { llm } = loadLlmSdk()
    expect((await llm.transcribe(audio)).text).to.equal('transcribed words')
  })
})

describe('freezr.llm.speak() — the request it builds', () => {
  it('sends plain JSON, since there is no file going up', async () => {
    const { llm, calls } = loadLlmSdk()
    await llm.speak('Hello there', { voice: 'alloy', format: 'mp3' })
    expect(calls[0].url).to.equal('/feps/llm/speak')
    expect(calls[0].options.uploadFile).to.equal(undefined)
    expect(calls[0].body).to.deep.equal({ text: 'Hello there', options: { voice: 'alloy', format: 'mp3' } })
  })

  it('omits options the caller did not set, rather than sending undefined', async () => {
    const { llm, calls } = loadLlmSdk()
    await llm.speak('Hi')
    expect(calls[0].body.options).to.deep.equal({})
  })
})

describe('freezr.llm.ask() with files — the request it builds', () => {
  const file = { name: 'report.pdf', type: 'application/pdf' }

  it('sends the FormData itself, not a JSON-serialised "{}"', async () => {
    // THE SAME MISTAKE AS transcribe(), MIRRORED. ask() streams over fetch via _streamingAsk,
    // whose option name is `isFormData`; `uploadFile` is the CORE apiRequest name transcribe()
    // needs. Passing uploadFile here made _streamingAsk JSON.stringify the FormData to "{}", so
    // the server saw an empty body and every PDF-bearing ask failed with 'No prompt provided'.
    const { llm, fetches } = loadLlmSdk()
    await llm.ask('Extract the holdings', { files: file })
    expect(fetches).to.have.length(1)
    expect(fetches[0].init.body).to.be.instanceOf(FakeFormData)
    expect(fetches[0].init.headers['Content-Type'], 'multipart must not be forced to JSON').to.equal(undefined)
  })

  it('carries the prompt in the multipart options part the server unpacks', async () => {
    const { llm, fetches } = loadLlmSdk()
    await llm.ask('Extract the holdings', { files: file, responseType: 'json' })
    const sentOptions = JSON.parse(fetches[0].init.body.get('options'))
    expect(sentOptions.prompt).to.equal('Extract the holdings')
    expect(sentOptions.responseType).to.equal('json')
    expect(fetches[0].init.body.get('file')).to.equal(file)
  })

  it('sends plain JSON when there is no file, with the prompt at the top level', async () => {
    const { llm, fetches } = loadLlmSdk()
    await llm.ask('Just a question')
    expect(JSON.parse(fetches[0].init.body).prompt).to.equal('Just a question')
  })
})
