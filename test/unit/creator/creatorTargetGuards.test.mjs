// Unit tests for features/creator/services/creatorTargetGuards.mjs — the app-name validation that
// stops a crafted app name (e.g. "../../someoneelse") from moving a creator handler's base folder.
import { expect } from 'chai'
import { assertTargetApp, rejectInvalidTargetApps } from '../../../features/creator/services/creatorTargetGuards.mjs'

// Minimal Express-style res that records what sendFailure sends.
const mockRes = () => {
  const res = { locals: { flogger: { error: () => {} } }, statusCode: null, body: null, headersSent: false }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (body) => { res.body = body; res.headersSent = true; return res }
  return res
}

const run = (req) => {
  const res = mockRes()
  let nextCalled = false
  rejectInvalidTargetApps(req, res, () => { nextCalled = true })
  return { res, nextCalled }
}

describe('creatorTargetGuards', () => {
  describe('assertTargetApp', () => {
    it('accepts ordinary and ask-app names', () => {
      expect(assertTargetApp('com.salmanff.apitester').ok).to.equal(true)
      expect(assertTargetApp('ask-app.top-artists.x7k2').ok).to.equal(true)
    })

    it('rejects traversal in the app name itself', () => {
      for (const name of ['../../fradmin', 'com.x.y/../../z', '..', 'com.x.y/..']) {
        const check = assertTargetApp(name)
        expect(check.ok, name).to.equal(false)
        expect(check.status, name).to.equal(400)
      }
    })

    it('rejects system apps with 403', () => {
      for (const name of ['info.freezr.admin', 'info.freezr.account', 'info.freezr.creator']) {
        const check = assertTargetApp(name)
        expect(check.ok, name).to.equal(false)
        expect(check.status, name).to.equal(403)
      }
    })

    it('rejects missing and non-string names', () => {
      expect(assertTargetApp('').ok).to.equal(false)
      expect(assertTargetApp(undefined).ok).to.equal(false)
      expect(assertTargetApp(['com.x.y', 'com.a.b']).ok).to.equal(false) // repeated query param
    })
  })

  describe('rejectInvalidTargetApps middleware', () => {
    it('passes a request with a valid app name', () => {
      const { nextCalled } = run({ query: { app_name: 'com.salmanff.apitester' }, body: {} })
      expect(nextCalled).to.equal(true)
    })

    it('passes a request with no app name (handlers report "required" themselves)', () => {
      expect(run({ query: {}, body: {} }).nextCalled).to.equal(true)
      expect(run({ query: { app_name: '' }, body: undefined }).nextCalled).to.equal(true)
    })

    it('rejects a traversal app_name in the query string', () => {
      const { res, nextCalled } = run({ query: { app_name: '../../fradmin' }, body: {} })
      expect(nextCalled).to.equal(false)
      expect(res.statusCode).to.equal(400)
      expect(res.body.error).to.include('app_name')
    })

    it('checks target_app and source_app in the body too', () => {
      expect(run({ query: {}, body: { target_app: '../x.y.z' } }).res.statusCode).to.equal(400)
      expect(run({ query: {}, body: { source_app: 'info.freezr.admin' } }).res.statusCode).to.equal(403)
    })
  })
})
