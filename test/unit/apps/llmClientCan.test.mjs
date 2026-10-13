// Unit tests for freezr.llm.can() in the browser SDK
// (freezrsystmapps/info.freezr.public/public/freezrApiV2.llm.js).
//
// can() traverses the ping's capability map in browser JS, which cannot import the server's
// resolver — so it is a hand-written second implementation of the same rules, and the place
// the two would silently diverge. These tests pin can() to the SAME semantics that
// llmCapabilities.test.mjs pins on the server side, in particular:
//   - a capability the provider is silent about is 'unknown' (= try it), never false;
//   - 'supported in general' says nothing about a specific half, so that is 'unknown' too.
// The suite loads the real SDK file into a sandbox with a stubbed freezr core, so it tests
// the shipped source rather than a copy.
import { expect } from 'chai'
import { readFileSync } from 'fs'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SDK = path.join(here, '../../../freezrsystmapps/info.freezr.public/public/freezrApiV2.llm.js')

// Load the real file with a minimal freezr core, and hand back the llm namespace with
// ping() replaced by a stub returning the given snapshot.
const loadLlmSdk = (pingSnapshot) => {
  let pingCalls = 0
  const freezr = {
    app: { isWebBased: true },
    utils: { getCookie: () => 'token' },
    apiRequest: async () => ({})
  }
  const sandbox = {
    freezr,
    freezrMeta: { userId: 'u', serverAddress: '', appToken: 't' },
    console: { log: () => {}, error: () => {}, warn: () => {} },
    fetch: async () => { throw new Error('not used') },
    Blob: class {},
    FormData: class {},
    TextDecoder: class {},
    Buffer
  }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(SDK, 'utf8'), sandbox)

  freezr.llm.ping = async () => { pingCalls++; return pingSnapshot }
  return { llm: freezr.llm, pingCalls: () => pingCalls }
}

const SNAPSHOT = {
  success: true,
  defaultProvider: 'Claude',
  capabilities: {
    Claude: { web: { search: true, fetch: true }, vision: true, voice: false },
    ChatGPT: { web: false, vision: true, voice: false }
  }
}

describe('freezr.llm.can()', () => {
  it('confirms a capability the default provider has', async () => {
    const { llm } = loadLlmSdk(SNAPSHOT)
    expect(await llm.can('web')).to.equal(true)
    expect(await llm.can('web.search')).to.equal(true)
  })

  it('denies one the provider definitively lacks', async () => {
    const { llm } = loadLlmSdk(SNAPSHOT)
    expect(await llm.can('web', { provider: 'ChatGPT' })).to.equal(false)
    expect(await llm.can('voice')).to.equal(false)
  })

  it("treats a capability outside the provider's map as unsupported", async () => {
    const { llm } = loadLlmSdk(SNAPSHOT)
    expect(await llm.can('embeddings')).to.equal(false)
  })

  it("reports 'unknown' — not false — when the provider was silent", async () => {
    const { llm } = loadLlmSdk({
      defaultProvider: 'Claude',
      capabilities: { Claude: { web: 'unknown' } }
    })
    expect(await llm.can('web')).to.equal('unknown')
    expect(await llm.can('web.search')).to.equal('unknown')
  })

  it("reports 'unknown' for a half of a capability known only in general", async () => {
    const { llm } = loadLlmSdk({ defaultProvider: 'Claude', capabilities: { Claude: { web: true } } })
    expect(await llm.can('web.search')).to.equal('unknown')
  })

  it("reports 'unknown' when the ping carries no map for that provider", async () => {
    const { llm } = loadLlmSdk({ defaultProvider: 'Claude', capabilities: {} })
    expect(await llm.can('web')).to.equal('unknown')
  })

  it('an all-false detail object is false', async () => {
    const { llm } = loadLlmSdk({
      defaultProvider: 'Claude',
      capabilities: { Claude: { web: { search: false, fetch: false } } }
    })
    expect(await llm.can('web')).to.equal(false)
  })

  it('memoizes the ping so building a screen is one request, not one per question', async () => {
    const { llm, pingCalls } = loadLlmSdk(SNAPSHOT)
    await llm.can('web')
    await llm.can('vision')
    await llm.can('voice')
    expect(pingCalls()).to.equal(1)
  })

  it('re-pings on refresh', async () => {
    const { llm, pingCalls } = loadLlmSdk(SNAPSHOT)
    await llm.can('web')
    await llm.can('web', { refresh: true })
    expect(pingCalls()).to.equal(2)
  })
})

describe('can({ anyProvider }) — for a capability only ONE provider has', () => {
  // Voice is ChatGPT-only, which is the first time a user's DEFAULT provider can be the wrong
  // one to ask. A Claude-default user who also holds a ChatGPT key can transcribe — the server
  // picks the capable key for voice calls — so a mic button gated on the default alone would
  // be hidden from someone it would have worked for.
  const twoProviders = {
    defaultProvider: 'Claude',
    capabilities: {
      Claude: { web: { search: true, fetch: true }, voice: false },
      ChatGPT: { web: { search: true, fetch: true }, voice: { stt: true, tts: true } }
    }
  }

  it('answers for the default provider unless asked otherwise', () => {
    const { llm } = loadLlmSdk(twoProviders)
    return llm.can('voice.stt').then(answer => expect(answer).to.equal(false))
  })

  it('finds the capable provider when asked across all of them', async () => {
    const { llm } = loadLlmSdk(twoProviders)
    expect(await llm.can('voice.stt', { anyProvider: true })).to.equal(true)
    expect(await llm.can('voice.tts', { anyProvider: true })).to.equal(true)
  })

  it('still says no when NO provider can', async () => {
    const { llm } = loadLlmSdk({
      defaultProvider: 'Claude',
      capabilities: { Claude: { voice: false }, ChatGPT: { voice: false } }
    })
    expect(await llm.can('voice.stt', { anyProvider: true })).to.equal(false)
  })

  it("prefers a definite yes over another provider's 'unknown'", async () => {
    const { llm } = loadLlmSdk({
      defaultProvider: 'Claude',
      capabilities: { Claude: { vision: 'unknown' }, ChatGPT: { vision: true } }
    })
    expect(await llm.can('vision', { anyProvider: true })).to.equal(true)
  })

  it("returns 'unknown' when nothing said yes but something said 'try it'", async () => {
    // Rounding this to false would hide a feature on every model the provider has not
    // documented — the exact failure the tri-state exists to prevent.
    const { llm } = loadLlmSdk({
      defaultProvider: 'Claude',
      capabilities: { Claude: { vision: false }, ChatGPT: { vision: 'unknown' } }
    })
    expect(await llm.can('vision', { anyProvider: true })).to.equal('unknown')
  })

  it('shares the one memoized ping with plain can()', async () => {
    const { llm, pingCalls } = loadLlmSdk(twoProviders)
    await llm.can('voice.stt')
    await llm.can('voice.stt', { anyProvider: true })
    await llm.can('web')
    expect(pingCalls()).to.equal(1)
  })
})

describe('capabilities() — the snapshot behind can()', () => {
  it('shares can()\'s memoized ping instead of making a second one', async () => {
    // A ping lists every text, image and voice model and reads pricing for each, so an app
    // that needs both a yes/no AND the provider name must not pay for it twice.
    const { llm, pingCalls } = loadLlmSdk(SNAPSHOT)
    await llm.can('web')
    const snap = await llm.capabilities()
    expect(pingCalls()).to.equal(1)
    expect(snap.defaultProvider).to.equal('Claude')
    expect(snap.capabilities.ChatGPT).to.deep.equal(SNAPSHOT.capabilities.ChatGPT)
  })

  it('returns empty shapes rather than undefined when the ping says nothing', async () => {
    const { llm } = loadLlmSdk({ success: true })
    expect(await llm.capabilities()).to.deep.equal({ capabilities: {}, defaultProvider: null })
  })
})
