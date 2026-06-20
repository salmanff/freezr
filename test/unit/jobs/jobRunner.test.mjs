// Unit tests for JobRunner shared helpers (Phase 6) — pure, no server needed.
import { expect } from 'chai'
import { jobFunctionName, normalizeRunResult } from '../../../adapters/jobs/jobRunner.mjs'

describe('jobRunner.jobFunctionName', function () {
  it('builds a readable freezr_<owner>_<app>_<job> name, dots sanitized', function () {
    const n = jobFunctionName({ ownerId: 'salman', appName: 'com.example.incrementer', jobName: 'increment' })
    expect(n).to.equal('freezr_salman_com_example_incrementer_increment')
  })

  it('only ever uses Lambda-legal characters [a-zA-Z0-9-_]', function () {
    const n = jobFunctionName({ ownerId: 'user@host', appName: 'a.b.c', jobName: 'do-it' })
    expect(n).to.match(/^[a-zA-Z0-9-_]+$/)
  })

  it('never exceeds 64 chars (AWS Lambda limit)', function () {
    const n = jobFunctionName({ ownerId: 'x'.repeat(200), appName: 'com.example.app', jobName: 'job' })
    expect(n.length).to.equal(64)
  })

  it('does NOT collide for long names sharing a 64-char prefix (the legacy slice bug)', function () {
    const base = 'z'.repeat(80)
    const a = jobFunctionName({ ownerId: base + 'AAA', appName: 'app', jobName: 'job' })
    const b = jobFunctionName({ ownerId: base + 'BBB', appName: 'app', jobName: 'job' })
    expect(a).to.not.equal(b)
    expect(a.length).to.equal(64)
    expect(b.length).to.equal(64)
  })

  it('is deterministic (same inputs => same name)', function () {
    const args = { ownerId: 'u'.repeat(90), appName: 'app', jobName: 'job' }
    expect(jobFunctionName(args)).to.equal(jobFunctionName(args))
  })

  it('throws when a required part is missing', function () {
    expect(() => jobFunctionName({ appName: 'a', jobName: 'b' })).to.throw()
    expect(() => jobFunctionName({ ownerId: 'a', jobName: 'b' })).to.throw()
    expect(() => jobFunctionName({ ownerId: 'a', appName: 'b' })).to.throw()
  })
})

describe('jobRunner.normalizeRunResult', function () {
  it('fills the canonical shape with defaults', function () {
    expect(normalizeRunResult({})).to.deep.equal({
      ok: false, result: null, error: null, errorCode: null, durationMs: 0, usage: null, logs: null
    })
  })

  it('stringifies an Error and lifts its code', function () {
    const e = new Error('boom'); e.code = 'X'
    const r = normalizeRunResult({ ok: false, error: e, durationMs: 5 })
    expect(r.error).to.equal('boom')
    expect(r.errorCode).to.equal('X')
    expect(r.durationMs).to.equal(5)
  })

  it('passes through ok result + usage + logs', function () {
    const r = normalizeRunResult({ ok: true, result: { n: 1 }, durationMs: 12, usage: { billedMs: 800 }, logs: 'REPORT...' })
    expect(r).to.deep.equal({ ok: true, result: { n: 1 }, error: null, errorCode: null, durationMs: 12, usage: { billedMs: 800 }, logs: 'REPORT...' })
  })
})
