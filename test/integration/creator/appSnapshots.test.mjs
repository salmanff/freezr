/**
 * Creator whole-app snapshots — integration tests for features/creator/controllers/snapshotController.mjs
 *
 *   POST /creatorapi/snapshot_app        take (dedups identical states as aliases)
 *   GET  /creatorapi/app_snapshots       list + current content hash
 *   POST /creatorapi/compare_snapshots   file-by-file diff (snapshot|current vs snapshot|current)
 *   POST /creatorapi/restore_snapshot    whole app or a subset of paths; takes a pre-restore snapshot
 *   POST /creatorapi/update_snapshot     pin / rename
 *   POST /creatorapi/delete_snapshot
 *
 * Prerequisites (same as inspectToken.test.mjs):
 *   1. Server running with `npm run devtest` (FREEZR_TEST_MODE=true) — started AFTER these routes
 *      were added, or the snapshot endpoints 404.
 *   2. Test users exist (users_freezr/test_credentials/testUserCreds.json)
 *   3. The primary user has the test app (testAppConfig.appName) installed with a manifest.json
 *   4. Run with: mocha test/integration/creator/appSnapshots.test.mjs
 *
 * The test writes one scratch file (__snaptest/hello.txt) into the test app and removes it again by
 * restoring the first snapshot it took; every snapshot it creates (including the automatic
 * pre-restore ones) is deleted in `after`.
 */

import { expect } from 'chai'
import fetch from 'node-fetch'
import { TestAuthHelper, loadTestCredentials } from '../ceps/testAuthHelper.mjs'

let testConfig
let serverUrl
let appName

try {
  testConfig = loadTestCredentials()
  serverUrl = testConfig.serverUrl
  appName = testConfig.testAppConfig.appName
} catch (error) {
  console.error('Failed to load test credentials:', error.message)
  process.exit(1)
}

const CREATOR_APP = 'info.freezr.creator'
const SCRATCH_PATH = '__snaptest/hello.txt'

describe('Creator app snapshots (Versions)', function () {
  this.timeout(30000)

  let auth
  let creatorToken
  const startedAt = new Date().toISOString()
  const tag = 'snaptest-' + Date.now()
  let baseId = null // snapshot before the scratch file existed
  let v1Id = null // snapshot with scratch file = v1

  const api = async (method, path, body) => {
    const headers = { Authorization: `Bearer ${creatorToken}`, Cookie: auth.getCookieHeader(CREATOR_APP) }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const resp = await fetch(serverUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    let json = null
    try { json = await resp.json() } catch (e) { /* non-json */ }
    return { status: resp.status, body: json }
  }

  const readScratch = async () => api('GET', '/creatorapi/read_app_file?app_name=' + encodeURIComponent(appName) + '&file_path=' + encodeURIComponent(SCRATCH_PATH))
  const writeScratch = (content) => api('POST', '/creatorapi/write_app_file', { app_name: appName, file_path: SCRATCH_PATH, content })

  before(async function () {
    auth = new TestAuthHelper(serverUrl)
    await auth.login(testConfig.users.primary.user_id, testConfig.users.primary.password)
    auth.appName = CREATOR_APP
    const pageResp = await fetch(`${serverUrl}/creator`, { method: 'GET', headers: { Cookie: auth.getCookieHeader() }, redirect: 'manual' })
    auth.parseCookies(pageResp.headers, CREATOR_APP)
    creatorToken = auth.appTokens[auth.userId]?.[CREATOR_APP]
    if (!creatorToken) throw new Error('Could not obtain creator app token from /creator page visit')

    // Make sure no stale scratch file from an aborted run skews the baseline.
    await api('POST', '/creatorapi/write_app_file', { app_name: appName, file_path: SCRATCH_PATH, action: 'delete' })
  })

  after(async function () {
    // Remove every snapshot this run created (ours and the automatic pre-restore ones).
    const { body } = await api('GET', '/creatorapi/app_snapshots?app_name=' + encodeURIComponent(appName) + '&with_current=0')
    for (const s of (body?.snapshots || [])) {
      if (s.legacy || s.reason === 'published') continue
      const mine = (s.label || '').includes(tag) || (s.reason === 'pre_restore' && s.timestamp >= startedAt)
      if (mine) await api('POST', '/creatorapi/delete_snapshot', { app_name: appName, snapshot_id: s._id })
    }
    await api('POST', '/creatorapi/write_app_file', { app_name: appName, file_path: SCRATCH_PATH, action: 'delete' })
  })

  it('lists snapshots with a current content hash', async function () {
    const { status, body } = await api('GET', '/creatorapi/app_snapshots?app_name=' + encodeURIComponent(appName))
    expect(status).to.equal(200)
    expect(body.snapshots).to.be.an('array')
    expect(body.currentHash).to.be.a('string').with.length(64)
  })

  it('rejects a snapshot request without app_name', async function () {
    const { status } = await api('POST', '/creatorapi/snapshot_app', { reason: 'manual' })
    expect(status).to.equal(400)
  })

  it('takes a manual snapshot and dedups an identical second one as an alias', async function () {
    const first = await api('POST', '/creatorapi/snapshot_app', { app_name: appName, reason: 'manual', label: tag + ' base', pinned: true })
    expect(first.status).to.equal(200)
    expect(first.body.created).to.equal(true)
    expect(first.body.record._id).to.be.a('string')
    expect(first.body.record.fileCount).to.be.greaterThan(0)
    expect(first.body.record.pinned).to.equal(true)
    baseId = first.body.record._id

    const again = await api('POST', '/creatorapi/snapshot_app', { app_name: appName, reason: 'chat_start', chat_id: 'chat-' + tag, label: tag + ' alias' })
    expect(again.status).to.equal(200)
    expect(again.body.created).to.equal(false)
    expect(again.body.record._id).to.equal(baseId)
    expect(again.body.record.aliases.some((a) => a.chatId === 'chat-' + tag)).to.equal(true)

    const list = await api('GET', '/creatorapi/app_snapshots?app_name=' + encodeURIComponent(appName))
    const rec = list.body.snapshots.find((s) => s._id === baseId)
    expect(rec).to.exist
    expect(rec.contentHash).to.equal(list.body.currentHash) // nothing changed since → "current"
  })

  it('snapshots a new file and compares it against the current (changed) files', async function () {
    expect((await writeScratch('v1')).status).to.equal(200)
    const snap = await api('POST', '/creatorapi/snapshot_app', { app_name: appName, reason: 'pre_edit', label: tag + ' v1' })
    expect(snap.body.created).to.equal(true)
    v1Id = snap.body.record._id
    expect(v1Id).to.not.equal(baseId)

    expect((await writeScratch('v2')).status).to.equal(200)

    const cmp = await api('POST', '/creatorapi/compare_snapshots', { app_name: appName, a: v1Id, b: 'current' })
    expect(cmp.status).to.equal(200)
    expect(cmp.body.a.id).to.equal(v1Id)
    expect(cmp.body.b.id).to.equal('current')
    const f = cmp.body.files.find((x) => x.path === SCRATCH_PATH)
    expect(f.status).to.equal('modified')
    expect(f.a).to.equal('v1')
    expect(f.b).to.equal('v2')
    expect(cmp.body.counts.modified).to.be.at.least(1)

    const cmp2 = await api('POST', '/creatorapi/compare_snapshots', { app_name: appName, a: baseId, b: v1Id })
    expect(cmp2.body.files.find((x) => x.path === SCRATCH_PATH).status).to.equal('added')
  })

  it('restores a single file from a snapshot and records a pre-restore snapshot', async function () {
    const res = await api('POST', '/creatorapi/restore_snapshot', { app_name: appName, snapshot_id: v1Id, paths: [SCRATCH_PATH] })
    expect(res.status).to.equal(200)
    expect(res.body.counts.modified).to.equal(1)
    expect(res.body.files).to.deep.equal([{ path: SCRATCH_PATH, status: 'modified' }])
    expect(res.body.preRestoreSnapshot).to.be.an('object')
    expect(res.body.historyId).to.be.a('string')
    const read = await readScratch()
    expect(read.status).to.equal(200)
    expect(read.body.content).to.equal('v1')
  })

  it('reports nothing to do when the files already match', async function () {
    const res = await api('POST', '/creatorapi/restore_snapshot', { app_name: appName, snapshot_id: v1Id, paths: [SCRATCH_PATH] })
    expect(res.status).to.equal(200)
    expect(res.body.nothingToDo).to.equal(true)
  })

  it('restores the whole app to the base snapshot, deleting the added file', async function () {
    const res = await api('POST', '/creatorapi/restore_snapshot', { app_name: appName, snapshot_id: baseId })
    expect(res.status).to.equal(200)
    expect(res.body.counts.deleted).to.be.at.least(1)
    expect(res.body.files.some((f) => f.path === SCRATCH_PATH && f.status === 'deleted')).to.equal(true)
    const read = await readScratch()
    expect(read.status).to.not.equal(200)
    const list = await api('GET', '/creatorapi/app_snapshots?app_name=' + encodeURIComponent(appName))
    expect(list.body.snapshots.find((s) => s._id === baseId).contentHash).to.equal(list.body.currentHash)
  })

  it('renames, pins/unpins and refuses to touch unknown snapshots', async function () {
    const ren = await api('POST', '/creatorapi/update_snapshot', { app_name: appName, snapshot_id: v1Id, label: tag + ' v1 renamed', pinned: true })
    expect(ren.status).to.equal(200)
    expect(ren.body.snapshot.label).to.equal(tag + ' v1 renamed')
    expect(ren.body.snapshot.pinned).to.equal(true)
    const unpin = await api('POST', '/creatorapi/update_snapshot', { app_name: appName, snapshot_id: v1Id, pinned: false })
    expect(unpin.body.snapshot.pinned).to.equal(false)

    expect((await api('POST', '/creatorapi/update_snapshot', { app_name: appName, snapshot_id: 'nope', pinned: true })).status).to.equal(404)
    expect((await api('POST', '/creatorapi/restore_snapshot', { app_name: appName, snapshot_id: 'nope' })).status).to.equal(404)
    expect((await api('POST', '/creatorapi/compare_snapshots', { app_name: appName, a: 'nope', b: 'current' })).status).to.equal(404)
  })

  it('deletes a snapshot', async function () {
    const del = await api('POST', '/creatorapi/delete_snapshot', { app_name: appName, snapshot_id: v1Id })
    expect(del.status).to.equal(200)
    const list = await api('GET', '/creatorapi/app_snapshots?app_name=' + encodeURIComponent(appName) + '&with_current=0')
    expect(list.body.snapshots.find((s) => s._id === v1Id)).to.equal(undefined)
    v1Id = null
  })
})
