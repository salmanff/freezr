// Unit tests for the job location resolver (Phase 5) — pure, no server needed.
import { expect } from 'chai'
import { resolveJobLocation, audienceAllows } from '../../../features/jobs/services/jobLocationResolver.mjs'

describe('jobLocationResolver.audienceAllows', function () {
  it("'all_users' allows anyone", function () {
    expect(audienceAllows('all_users', { requestorId: 'u1', isAdmin: false })).to.be.true
  })
  it("'admins' allows only admins", function () {
    expect(audienceAllows('admins', { requestorId: 'u1', isAdmin: true })).to.be.true
    expect(audienceAllows('admins', { requestorId: 'u1', isAdmin: false })).to.be.false
  })
  it('undefined defaults to admins-only (conservative)', function () {
    expect(audienceAllows(undefined, { isAdmin: true })).to.be.true
    expect(audienceAllows(undefined, { isAdmin: false })).to.be.false
  })
  it('an explicit id list allows only listed users', function () {
    expect(audienceAllows(['a', 'b'], { requestorId: 'b' })).to.be.true
    expect(audienceAllows(['a', 'b'], { requestorId: 'c' })).to.be.false
  })
})

describe('jobLocationResolver.resolveJobLocation', function () {
  const trustAll = { audience: 'all_users' }

  describe("hint 'auto' (default)", function () {
    it('prefers local when locally trusted', function () {
      const r = resolveJobLocation({ localTrust: trustAll, hasComputeToken: true })
      expect(r).to.deep.equal({ ok: true, location: 'local' })
    })
    it('falls back to cloud when not local-trusted but has compute', function () {
      const r = resolveJobLocation({ localTrust: null, hasComputeToken: true })
      expect(r).to.deep.equal({ ok: true, location: 'cloud' })
    })
    it('errors when neither gate is open', function () {
      const r = resolveJobLocation({ localTrust: null, hasComputeToken: false })
      expect(r.ok).to.be.false
      expect(r.location).to.be.null
    })
    it('respects audience: non-admin blocked from an admins-only local job, falls back to cloud', function () {
      const r = resolveJobLocation({ localTrust: { audience: 'admins' }, hasComputeToken: true, isAdmin: false })
      expect(r).to.deep.equal({ ok: true, location: 'cloud' })
    })
  })

  describe("hint 'cloud' (app opts out of local)", function () {
    it('uses cloud when compute available', function () {
      const r = resolveJobLocation({ hint: 'cloud', localTrust: trustAll, hasComputeToken: true })
      expect(r.location).to.equal('cloud')
    })
    it('errors (does NOT silently fall back to local) when no compute', function () {
      const r = resolveJobLocation({ hint: 'cloud', localTrust: trustAll, hasComputeToken: false })
      expect(r.ok).to.be.false
      expect(r.location).to.be.null
    })
  })

  describe("hint 'local'", function () {
    it('uses local when trusted+audience permits', function () {
      const r = resolveJobLocation({ hint: 'local', localTrust: trustAll, requestorId: 'u1' })
      expect(r.location).to.equal('local')
    })
    it('errors when not locally trusted (no fallback to cloud)', function () {
      const r = resolveJobLocation({ hint: 'local', localTrust: null, hasComputeToken: true })
      expect(r.ok).to.be.false
      expect(r.location).to.be.null
    })
  })
})
