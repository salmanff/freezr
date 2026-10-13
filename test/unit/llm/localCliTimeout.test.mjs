// Local-CLI connectors — per-request timeout resolution.
//
// The local connectors hold ONE slot (MAX_CONCURRENT 1 / MAX_QUEUED 1), so a caller that has
// given up must not leave a CLI running against it: every later /feps/llm/ask is refused 429
// "busy" until the budget expires. A caller must therefore always be able to ask to wait LESS.
//
// Asking for MORE is where the two connectors now differ. claudeLocal separates the DEFAULT
// (what an unbudgeted call gets) from the CEILING (what bounds the slot), so an app that knows
// its prompt runs long can say so and be believed up to the ceiling; codexLocal still has one
// number doing both jobs. These tests pin each, plus the controller-side resolution (explicit
// ask vs the calling job's remaining budget).
import { expect } from 'chai'
import { resolveTimeoutMs as claudeResolve } from '../../../adapters/llmConnectors/claudeLocal.mjs'
import { resolveTimeoutMs as codexResolve } from '../../../adapters/llmConnectors/codexLocal.mjs'
import { resolveAskTimeoutMs } from '../../../features/apps/controllers/cepsfepsApiController.mjs'

const DEFAULT = 5 * 60 * 1000
const FLOOR = 5 * 1000
const CONNECTORS = [
  // [name, resolve, ceiling] — ceiling is the most a caller may ask for
  ['claudeLocal', claudeResolve, 20 * 60 * 1000],
  ['codexLocal', codexResolve, DEFAULT]
]

for (const [name, resolve, ceiling] of CONNECTORS) {
  describe(name + ' — resolveTimeoutMs clamp', function () {
    it('defaults to the default when nothing is requested', function () {
      expect(resolve(undefined)).to.equal(DEFAULT)
      expect(resolve(null)).to.equal(DEFAULT)
      expect(resolve(0)).to.equal(DEFAULT)
      expect(resolve('nonsense')).to.equal(DEFAULT)
      expect(resolve(-1)).to.equal(DEFAULT)
    })

    it('honours a SHORTER request (the whole point — frees the slot early)', function () {
      expect(resolve(90 * 1000)).to.equal(90 * 1000)
      // superlazy's case: a step ceiling of 4 min, asking for slightly less
      expect(resolve(3.5 * 60 * 1000)).to.equal(3.5 * 60 * 1000)
    })

    it('never lets a caller ask for MORE than the ceiling', function () {
      expect(resolve(Number.MAX_SAFE_INTEGER)).to.equal(ceiling)
      expect(resolve(ceiling + 60 * 1000)).to.equal(ceiling)
    })

    it('honours a LONGER-than-default request up to the ceiling', function () {
      // On codexLocal ceiling === DEFAULT, so this is still the clamp; on claudeLocal it is
      // the app that knows its prompt takes 10 minutes being believed.
      expect(resolve(10 * 60 * 1000)).to.equal(Math.min(10 * 60 * 1000, ceiling))
    })

    it('floors an implausibly small value instead of failing instantly', function () {
      expect(resolve(1)).to.equal(FLOOR)
      expect(resolve(100)).to.equal(FLOOR)
    })

    it('accepts a numeric string (bodies arrive as JSON from apps)', function () {
      expect(resolve('60000')).to.equal(60000)
    })
  })
}

describe('llmAsk — resolveAskTimeoutMs (caller ask vs job budget)', function () {
  const noJob = (body = {}) => ({ body, headers: {} })
  const withDeadline = (msFromNow, body = {}) => ({ body, headers: { 'x-freezr-job-deadline': String(Date.now() + msFromNow) } })
  const near = (actual, expected, tol = 1500) => Math.abs(actual - expected) <= tol

  it('undefined when neither a request nor a job deadline applies (connector default)', function () {
    expect(resolveAskTimeoutMs(noJob(), {})).to.equal(undefined)
  })

  it('uses an explicit options.timeoutMs', function () {
    expect(resolveAskTimeoutMs(noJob(), { timeoutMs: 90000 })).to.equal(90000)
  })

  it('also accepts timeoutMs at the top level of the body', function () {
    expect(resolveAskTimeoutMs(noJob({ timeoutMs: 45000 }), {})).to.equal(45000)
  })

  it('derives the wait from the job deadline with NO app change', function () {
    const out = resolveAskTimeoutMs(withDeadline(120000), {})
    expect(near(out, 120000), 'got ' + out).to.equal(true)
  })

  it('takes whichever is SOONER — job budget shorter than the ask', function () {
    const out = resolveAskTimeoutMs(withDeadline(30000), { timeoutMs: 200000 })
    expect(near(out, 30000), 'got ' + out).to.equal(true)
  })

  it('takes whichever is SOONER — ask shorter than the job budget', function () {
    const out = resolveAskTimeoutMs(withDeadline(200000), { timeoutMs: 30000 })
    expect(out).to.equal(30000)
  })

  it('a deadline already past yields 1ms, which connectors floor (fail fast, not a fresh budget)', function () {
    const out = resolveAskTimeoutMs(withDeadline(-60000), {})
    expect(out).to.equal(1)
    expect(claudeResolve(out), 'connector floors it rather than granting the ceiling').to.equal(FLOOR)
  })

  it('ignores a junk deadline header rather than shortening the wait', function () {
    expect(resolveAskTimeoutMs({ body: {}, headers: { 'x-freezr-job-deadline': 'soon' } }, {})).to.equal(undefined)
  })

  it('passes a long explicit request through; each connector clamps it to its own ceiling', function () {
    const out = resolveAskTimeoutMs(noJob(), { timeoutMs: 10 * 60 * 1000 })
    expect(out).to.equal(10 * 60 * 1000)
    // claudeLocal believes an app that says its prompt runs long; codexLocal still caps at 5 min.
    expect(claudeResolve(out)).to.equal(10 * 60 * 1000)
    expect(codexResolve(out)).to.equal(DEFAULT)
  })
})
