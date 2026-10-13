// Unit tests for prompt-cache breakpoint placement in the Anthropic connector
// (adapters/llmConnectors/anthropic.mjs applyCacheControl / hasCallerCacheMarkers).
//
// Two modes: AUTOMATIC (cache option, no caller markers → system + second-to-last + last message)
// and EXPLICIT (the caller placed cache_control on message blocks → system breakpoint only, the
// messages untouched). Explicit mode exists because automatic placement cache-WROTE a per-call
// volatile last turn on every request; see the connector's comment block.
import { expect } from 'chai'
import { applyCacheControl, hasCallerCacheMarkers } from '../../../adapters/llmConnectors/anthropic.mjs'

const text = (t, cc) => ({ type: 'text', text: t, ...(cc ? { cache_control: cc } : {}) })
const markers = (params) => {
  const out = { system: null, messages: [] }
  if (Array.isArray(params.system)) out.system = params.system[params.system.length - 1].cache_control || null
  for (const m of params.messages) {
    const blocks = Array.isArray(m.content) ? m.content : []
    out.messages.push(blocks.map(b => b.cache_control || null))
  }
  return out
}

describe('anthropic connector — cache breakpoint placement', function () {
  describe('automatic mode (cache option, no caller markers)', function () {
    it('marks the system prompt and the last two messages', function () {
      const params = { system: 'sys', messages: [{ role: 'user', content: 'stable' }, { role: 'user', content: 'volatile' }] }
      applyCacheControl(params, true)
      const m = markers(params)
      expect(m.system).to.deep.equal({ type: 'ephemeral' })
      expect(m.messages).to.deep.equal([[{ type: 'ephemeral' }], [{ type: 'ephemeral' }]])
    })
    it('carries the 1h TTL onto every marker it places', function () {
      const params = { system: 'sys', messages: [{ role: 'user', content: 'only' }] }
      applyCacheControl(params, { ttl: '1h' })
      const m = markers(params)
      expect(m.system).to.deep.equal({ type: 'ephemeral', ttl: '1h' })
      expect(m.messages).to.deep.equal([[{ type: 'ephemeral', ttl: '1h' }]])
    })
    it('does nothing without the cache option', function () {
      const params = { system: 'sys', messages: [{ role: 'user', content: 'x' }] }
      applyCacheControl(params, null)
      expect(params.system).to.equal('sys')
      expect(params.messages[0].content).to.equal('x')
    })
  })

  describe('explicit mode (caller placed cache_control on a message block)', function () {
    const explicit = () => ({
      system: 'sys',
      messages: [
        { role: 'user', content: [text('stable catalog', { type: 'ephemeral', ttl: '1h' })] },
        { role: 'user', content: 'a fresh email — must NOT be cache-written' }
      ]
    })
    it('is detected from the caller messages', function () {
      expect(hasCallerCacheMarkers(explicit().messages)).to.equal(true)
      expect(hasCallerCacheMarkers([{ role: 'user', content: 'plain' }])).to.equal(false)
      expect(hasCallerCacheMarkers([{ role: 'user', content: [text('array, no marker')] }])).to.equal(false)
    })
    it('adds the system breakpoint and leaves the messages exactly as given', function () {
      const params = explicit()
      applyCacheControl(params, { ttl: '1h' }, { callerPlaced: true })
      const m = markers(params)
      expect(m.system).to.deep.equal({ type: 'ephemeral', ttl: '1h' })
      expect(m.messages[0]).to.deep.equal([{ type: 'ephemeral', ttl: '1h' }])
      expect(params.messages[1].content).to.equal('a fresh email — must NOT be cache-written') // still a string: untouched
    })
    it('promotes the system breakpoint to 1h when a caller marker is 1h (5m may not precede 1h)', function () {
      const params = explicit()
      applyCacheControl(params, true, { callerPlaced: true })
      expect(markers(params).system).to.deep.equal({ type: 'ephemeral', ttl: '1h' })
    })
    it('caller markers alone imply the intent — no cache option needed for the system breakpoint', function () {
      const params = explicit()
      applyCacheControl(params, null, { callerPlaced: true })
      expect(markers(params).system).to.deep.equal({ type: 'ephemeral', ttl: '1h' })
      expect(typeof params.messages[1].content).to.equal('string')
    })
    it('an injected file block is not mistaken for a caller marker when callerPlaced was measured first', function () {
      // ask()/askStream() measure callerPlaced BEFORE injecting document blocks (which carry
      // cache_control of their own); with callerPlaced false the automatic layout still applies.
      const params = {
        system: 'sys',
        messages: [{ role: 'user', content: [{ type: 'document', source: {}, cache_control: { type: 'ephemeral' } }, text('question')] }]
      }
      applyCacheControl(params, true, { callerPlaced: false })
      const m = markers(params)
      expect(m.system).to.deep.equal({ type: 'ephemeral' })
      expect(m.messages[0][1]).to.deep.equal({ type: 'ephemeral' }) // the last block got the automatic marker
    })
  })
})
