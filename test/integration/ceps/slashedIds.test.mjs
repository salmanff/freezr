/**
 * Record ids that contain '/' — integration tests
 *
 * An uploaded file's record id is its path (projects/p/draft/index.html). A plain
 * /:data_object_id route matches one path segment, so read / update / delete also accept the id as
 * /:data_object_start/* and rejoin it (dataObjectIdFromParams in cepsfepsApiController.mjs).
 * Before this, GET /ceps/read and the default PUT /ceps/update could not reach such a record at all.
 *
 * Prerequisites: server in test mode (npm run devtest). Run with:
 *   npx mocha test/integration/ceps/slashedIds.test.mjs
 */

import { expect } from 'chai'
import { createAuthenticatedHelper, loadTestCredentials } from './testAuthHelper.mjs'

let appTable
try {
  appTable = loadTestCredentials().testAppConfig.appTable
} catch (error) {
  console.error('Failed to load test credentials:', error.message)
  process.exit(1)
}

// Folders AND a space: the space is what the old req.path-based rejoin got wrong (%20).
const ID = 'slashed-id-test/sub folder/record one'
const idPath = ID.split('/').map(encodeURIComponent).join('/')

describe('Record ids containing "/"', function () {
  this.timeout(20000)
  let auth

  before(async function () {
    try {
      auth = await createAuthenticatedHelper('primary')
    } catch (error) {
      console.warn(`    ⚠ Setup failed (${error.message}) — is the server in test mode? Skipping.`)
      this.skip()
    }
    await auth.delete(`/ceps/delete/${appTable}/${idPath}`) // leftover from an interrupted run
  })

  after(async function () {
    if (!auth) return
    await auth.delete(`/ceps/delete/${appTable}/${idPath}`)
    await auth.logout()
  })

  it('writes a record with that id', async function () {
    const r = await auth.post(`/ceps/write/${appTable}?data_object_id=${encodeURIComponent(ID)}`, { label: 'first' })
    expect(r.ok, JSON.stringify(r.data)).to.be.true
    expect(r.data._id).to.equal(ID)
  })

  it('reads it back by id (GET /ceps/read)', async function () {
    const r = await auth.get(`/ceps/read/${appTable}/${idPath}`)
    expect(r.ok, JSON.stringify(r.data)).to.be.true
    expect(r.data._id).to.equal(ID)
    expect(r.data.label).to.equal('first')
  })

  it('updates it by id (PUT /ceps/update)', async function () {
    const u = await auth.put(`/ceps/update/${appTable}/${idPath}`, { label: 'second' })
    expect(u.ok, JSON.stringify(u.data)).to.be.true
    const r = await auth.get(`/ceps/read/${appTable}/${idPath}`)
    expect(r.data.label).to.equal('second')
  })

  it('deletes it by id (DELETE /ceps/delete)', async function () {
    const d = await auth.delete(`/ceps/delete/${appTable}/${idPath}`)
    expect(d.ok, JSON.stringify(d.data)).to.be.true
    const r = await auth.get(`/ceps/read/${appTable}/${idPath}`)
    expect(r.ok).to.be.false
  })
})
