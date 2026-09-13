// Unit tests for publicId resolution on the public (@-URL) routes.
//
// Background: a published file is stored under a publicid built from its real path, so a file
// named "hipercards screenshot.png" is stored with a literal space. The browser, however, must
// percent-encode that space, and Express's `req.path` — unlike `req.params` — hands the path back
// still encoded. Looking the record up with the raw path therefore searched for "…%20…" and never
// matched, so a correctly published file 404d. Any published file whose name contains a space hit
// this, which is most screenshots.
import { expect } from 'chai'
import { createPrepUserDSsForPublicFiles } from '../../../features/public/middleware/publicContext.mjs'

const STORED_ID = '@saladmin/com.salmanff.orbit.files/projects/freezr-pitch-2026/public/assets/hipercards screenshot.png'

const makeContext = (urlPath, storedIds) => {
  const reads = []
  const publicRecordsDb = {
    read_by_id: async (id) => {
      reads.push(id)
      return storedIds.includes(id) ? { _id: id, data_owner: 'saladmin', requestor_app: 'com.salmanff.orbit' } : null
    }
  }
  const req = { path: urlPath }
  const res = { locals: { freezr: { publicRecordsDb } } }
  return { req, res, reads }
}

// dsManager is only used once a record is found; a stub that fails loudly is enough to prove the
// lookup happened without dragging a real datastore into a unit test.
const dsManager = {
  getOrSetUserDS: async () => ({ getorInitAppFS: async () => null })
}
const middleware = createPrepUserDSsForPublicFiles(dsManager, {}, {})

describe('public route publicId encoding', function () {
  it('finds a published file whose name contains a space', async function () {
    const { req, res } = makeContext('/' + encodeURI(STORED_ID), [STORED_ID])
    expect(req.path).to.contain('%20') // the browser really does send it encoded
    await middleware(req, res, () => {})
    expect(res.locals.freezr.publicRecord, 'record found').to.not.equal(undefined)
    expect(res.locals.freezr.publicid).to.equal(STORED_ID)
  })

  it('leaves an ordinary unencoded publicId untouched', async function () {
    const plain = '@saladmin/com.salmanff.orbit.files/projects/deck/public/index.html'
    const { req, res, reads } = makeContext('/' + plain, [plain])
    await middleware(req, res, () => {})
    expect(res.locals.freezr.publicid).to.equal(plain)
    expect(reads).to.deep.equal([plain], 'one lookup, no wasted round trip')
  })

  it('falls back to the raw path when only the encoded form is stored', async function () {
    // Defensive: a publicid that genuinely contains a '%' must still resolve.
    const encodedStored = '@saladmin/app.files/a%20b.png'
    const { req, res, reads } = makeContext('/' + encodedStored, [encodedStored])
    await middleware(req, res, () => {})
    expect(res.locals.freezr.publicid).to.equal(encodedStored)
    expect(reads).to.deep.equal(['@saladmin/app.files/a b.png', encodedStored])
  })

  it('does not throw on a malformed escape sequence', async function () {
    const { req, res } = makeContext('/@saladmin/app.files/100%.png', [])
    let nexted = false
    await middleware(req, res, () => { nexted = true })
    expect(nexted, 'passed through to the controller').to.equal(true)
    expect(res.locals.freezr.publicRecord).to.equal(undefined)
  })

  it('passes through cleanly when nothing matches', async function () {
    const { req, res } = makeContext('/@saladmin/app.files/missing.png', [STORED_ID])
    let nexted = false
    await middleware(req, res, () => { nexted = true })
    expect(nexted).to.equal(true)
    expect(res.locals.freezr.publicRecord).to.equal(undefined)
  })
})
