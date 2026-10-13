// Controller-level tests for features/creator/controllers/snapshotController.mjs, driving the
// handlers with in-memory fakes for the user datastore (app FS, creator user files, creator DB
// collections). Covers take/dedup/prune, list (incl. legacy publishes), compare, whole and partial
// restore with its history bookkeeping, pin/rename/delete rules. The re-install step
// (updateAppFromFiles) has no context here and is expected to surface as `installWarning`.
import { expect } from 'chai'
import { unzipSync } from 'fflate'
import { createSnapshotController } from '../../../features/creator/controllers/snapshotController.mjs'
import { MAX_UNPINNED_SNAPSHOTS } from '../../../features/creator/services/appSnapshotService.mjs'

const b = (s) => Buffer.from(s, 'utf8')
const APP = 'com.test.snapapp'
const CREATOR = 'info.freezr.creator'

// ---- fakes ---------------------------------------------------------------------------------
const makeDb = () => {
  const rows = new Map()
  let auto = 0
  const matches = (row, q) => Object.entries(q || {}).every(([k, v]) => row[k] === v)
  return {
    rows,
    async query (q) { return [...rows.values()].filter((r) => matches(r, q)).map((r) => ({ ...r })) },
    async read_by_id (id) { return rows.has(id) ? { ...rows.get(id) } : null },
    async create (id, entity) { const _id = id || ('auto' + (++auto)); rows.set(_id, { ...entity, _id }); return { _id } },
    async update (id, patch, opts) {
      const cur = rows.get(id)
      if (!cur) throw new Error('not found')
      rows.set(id, opts?.replaceAllFields === false ? { ...cur, ...patch } : { ...patch, _id: id })
      return { nModified: 1 }
    },
    async delete_record (id) { if (!rows.delete(id)) throw new Error('Record not found to delete'); return { nRemoved: 1 } }
  }
}

const makeAppFS = (files) => ({
  files, // { relPath: Buffer }
  fsParams: { type: 'fake-cloud' }, // non-local → listAppFilePaths goes through readAppDir
  async readAppDir () { return Object.keys(files) },
  async readAppFile (p, opts) {
    if (!(p in files)) throw new Error('ENOENT ' + p)
    return opts?.doNotToString ? files[p] : files[p].toString('utf8')
  },
  async writeToAppFiles (p, content) { files[p] = Buffer.from(content) },
  async deleteAppFile (p) { delete files[p] }
})

const makeCreatorFS = () => {
  const userFiles = {}
  return {
    userFiles,
    async writeToUserFiles (p, content) { userFiles[p] = Buffer.from(content); return p },
    async getUserFile (p, opts) {
      if (!(p in userFiles)) throw new Error('file not found!')
      return opts?.returnBuffer ? userFiles[p] : userFiles[p].toString()
    },
    async removeFile (p) { delete userFiles[p] }
  }
}

const makeWorld = (files) => {
  const dbs = {}
  const appFS = makeAppFS(files)
  const creatorFS = makeCreatorFS()
  const userDS = {
    async getorInitAppFS (name) { return name === CREATOR ? creatorFS : (name === APP ? appFS : null) },
    async getorInitDb (oac) {
      const k = oac.app_name + '/' + oac.collection_name
      if (!dbs[k]) dbs[k] = makeDb()
      return dbs[k]
    }
  }
  const ctl = createSnapshotController()
  const call = async (handler, { body, query, file } = {}) => {
    const res = {
      locals: { flogger: { track () {}, error () {} }, freezr: { userDS, freezrPrefs: {}, permGiven: true } },
      headersSent: false,
      statusCode: 200,
      body: null
    }
    res.status = (c) => { res.statusCode = c; return res }
    res.headers = {}
    res.setHeader = (k, v) => { res.headers[k] = v }
    res.send = (d) => { res.body = d; res.headersSent = true; return res }
    res.json = (d) => { res.body = d; res.headersSent = true; return res }
    await handler({ body: body || {}, query: query || {}, file: file || undefined, session: { logged_in_user_id: 'tester' }, protocol: 'http', get: () => 'localhost' }, res)
    return res
  }
  const db = (c) => dbs[CREATOR + '/' + c]
  return { appFS, creatorFS, userDS, dbs, ctl, call, db }
}

const baseFiles = () => ({
  'manifest.json': b(JSON.stringify({ identifier: APP, version: '0.1' })),
  'index.html': b('<h1>hello</h1>'),
  'app.js': b('console.log(1)'),
  'img/logo.png': b('\x89PNG-one')
})

// ---- tests ----------------------------------------------------------------------------------
describe('snapshotController (with in-memory fakes)', () => {
  it('takes a snapshot (zip + record), dedups an identical state as an alias, and reports it current', async () => {
    const w = makeWorld(baseFiles())
    const r1 = await w.call(w.ctl.createSnapshot, { body: { app_name: APP, reason: 'manual', label: 'first', pinned: true } })
    expect(r1.statusCode).to.equal(200)
    expect(r1.body.created).to.equal(true)
    const rec = r1.body.record
    expect(rec.fileCount).to.equal(4)
    expect(rec.pinned).to.equal(true)
    expect(rec.fileName).to.equal('snapshots/' + APP + '/' + rec._id + '.zip')
    expect(w.creatorFS.userFiles[rec.fileName]).to.be.instanceOf(Buffer)
    const unzipped = unzipSync(new Uint8Array(w.creatorFS.userFiles[rec.fileName]))
    expect(Object.keys(unzipped).sort()).to.deep.equal(['app.js', 'img/logo.png', 'index.html', 'manifest.json'])

    const r2 = await w.call(w.ctl.createSnapshot, { body: { app_name: APP, reason: 'chat_start', chat_id: 'c1', label: 'Before chat: x' } })
    expect(r2.body.created).to.equal(false)
    expect(r2.body.record._id).to.equal(rec._id)
    expect(r2.body.record.aliases).to.have.length(1)
    expect(r2.body.record.aliases[0].chatId).to.equal('c1')
    expect(Object.keys(w.creatorFS.userFiles)).to.have.length(1)

    const list = await w.call(w.ctl.listSnapshots, { query: { app_name: APP } })
    expect(list.body.snapshots).to.have.length(1)
    expect(list.body.currentHash).to.equal(rec.contentHash)

    // An unknown reason falls back to manual; 'published' cannot be claimed through the API.
    w.appFS.files['app.js'] = b('changed')
    const r3 = await w.call(w.ctl.createSnapshot, { body: { app_name: APP, reason: 'published' } })
    expect(r3.body.record.reason).to.equal('manual')
  })

  it('rejects missing app_name and an app without files', async () => {
    const w = makeWorld({})
    expect((await w.call(w.ctl.createSnapshot, { body: {} })).statusCode).to.equal(400)
    expect((await w.call(w.ctl.listSnapshots, { query: {} })).statusCode).to.equal(400)
    const r = await w.call(w.ctl.createSnapshot, { body: { app_name: APP } })
    expect(r.statusCode).to.equal(500)
    expect(r.body.error).to.match(/no files/)
  })

  it('lists legacy publishes from the files collection and can compare/restore from them', async () => {
    const w = makeWorld(baseFiles())
    // A publish from before this feature: zip in the user-files root + a `files` record, no appSnapshots row.
    const { zipSync } = await import('fflate')
    const pubFiles = { 'manifest.json': baseFiles()['manifest.json'], 'index.html': b('<h1>published</h1>') }
    const zipName = APP + ' v0.1 2026-01-01.zip'
    w.creatorFS.userFiles[zipName] = Buffer.from(zipSync(pubFiles))
    const filesDb = await w.userDS.getorInitDb({ app_name: CREATOR, collection_name: 'files' })
    await filesDb.create(zipName, { publishedAppName: APP, version: '0.1', fileName: zipName, timestamp: '2026-01-01T00:00:00.000Z' })

    const list = await w.call(w.ctl.listSnapshots, { query: { app_name: APP, with_current: '0' } })
    expect(list.body.currentHash).to.equal(null)
    const legacy = list.body.snapshots.find((s) => s.legacy)
    expect(legacy._id).to.equal('pub:' + zipName)
    expect(legacy.reason).to.equal('published')
    expect(legacy.pinned).to.equal(true)

    const cmp = await w.call(w.ctl.compareSnapshots, { body: { app_name: APP, a: legacy._id, b: 'current' } })
    expect(cmp.statusCode).to.equal(200)
    const byPath = Object.fromEntries(cmp.body.files.map((f) => [f.path, f]))
    expect(byPath['index.html'].status).to.equal('modified')
    expect(byPath['app.js'].status).to.equal('added') // present now, absent in the publish
    expect(byPath['manifest.json'].status).to.equal('unchanged')

    // Legacy publishes can't be edited or deleted through the snapshot API, but can be restored.
    expect((await w.call(w.ctl.updateSnapshot, { body: { app_name: APP, snapshot_id: legacy._id, label: 'x' } })).statusCode).to.equal(400)
    expect((await w.call(w.ctl.deleteSnapshot, { body: { app_name: APP, snapshot_id: legacy._id } })).statusCode).to.equal(400)
    const res = await w.call(w.ctl.restoreSnapshot, { body: { app_name: APP, snapshot_id: legacy._id, paths: ['index.html'] } })
    expect(res.statusCode).to.equal(200)
    expect(w.appFS.files['index.html'].toString()).to.equal('<h1>published</h1>')
    expect(w.appFS.files['app.js']).to.exist // partial restore leaves the rest alone
  })

  it('restores the whole app: writes, deletes, pre-restore snapshot, history + fileUpdates records', async () => {
    const w = makeWorld(baseFiles())
    const snap = (await w.call(w.ctl.createSnapshot, { body: { app_name: APP, reason: 'chat_start', chat_id: 'c9', label: 'Before chat' } })).body.record

    // Drift: modify text, modify binary, add, delete.
    w.appFS.files['app.js'] = b('console.log(2)')
    w.appFS.files['img/logo.png'] = b('\x89PNG-two')
    w.appFS.files['extra.css'] = b('body{}')
    delete w.appFS.files['index.html']

    const res = await w.call(w.ctl.restoreSnapshot, { body: { app_name: APP, snapshot_id: snap._id } })
    expect(res.statusCode).to.equal(200)
    expect(res.body.counts).to.deep.equal({ modified: 2, added: 1, deleted: 1, unchanged: 1 })
    expect(res.body.installWarning).to.be.a('string') // no install context in this harness
    expect(res.body.preRestoreSnapshot.created).to.equal(true)

    // Files are back exactly.
    const now = Object.fromEntries(Object.entries(w.appFS.files).map(([k, v]) => [k, v.toString()]))
    const want = Object.fromEntries(Object.entries(baseFiles()).map(([k, v]) => [k, v.toString()]))
    expect(now).to.deep.equal(want)

    // History: one 'restored' appUpdates entry naming every changed file …
    const hist = await w.db('appUpdates').query({ appName: APP })
    expect(hist).to.have.length(1)
    expect(hist[0].action).to.equal('restored')
    expect(hist[0].snapshotId).to.equal(snap._id)
    expect(hist[0].filesChanged.sort()).to.deep.equal(['app.js', 'extra.css', 'img/logo.png', 'index.html'])
    expect(res.body.historyId).to.equal(hist[0]._id)

    // … and fileUpdates rows for the TEXT files only, carrying the restored content / a delete.
    const fu = await w.db('fileUpdates').query({ appName: APP })
    const fuByPath = Object.fromEntries(fu.map((r) => [r.path, r]))
    expect(Object.keys(fuByPath).sort()).to.deep.equal(['app.js', 'extra.css', 'index.html'])
    expect(fuByPath['app.js'].action).to.equal('upsert')
    expect(fuByPath['app.js'].content).to.equal('console.log(1)')
    expect(fuByPath['index.html'].content).to.equal('<h1>hello</h1>')
    expect(fuByPath['extra.css'].action).to.equal('delete')
    expect(fu.every((r) => r.historyId === hist[0]._id)).to.equal(true)

    // The pre-restore snapshot holds the drifted state, so the restore itself is reversible.
    const snaps = await w.db('appSnapshots').query({ appName: APP })
    const pre = snaps.find((s) => s.reason === 'pre_restore')
    expect(pre).to.exist
    const preZip = unzipSync(new Uint8Array(w.creatorFS.userFiles[pre.fileName]))
    expect(Buffer.from(preZip['app.js']).toString()).to.equal('console.log(2)')
    expect(preZip['extra.css']).to.exist
    expect(preZip['index.html']).to.equal(undefined)

    // Restoring again is a no-op.
    const again = await w.call(w.ctl.restoreSnapshot, { body: { app_name: APP, snapshot_id: snap._id } })
    expect(again.body.nothingToDo).to.equal(true)
    expect(await w.db('appUpdates').query({ appName: APP })).to.have.length(1)
  })

  it('aligns a stale manifest identifier on restore (app renamed since the snapshot)', async () => {
    const w = makeWorld(baseFiles())
    w.appFS.files['manifest.json'] = b(JSON.stringify({ identifier: 'com.old.name', version: '0.1' }))
    const snap = (await w.call(w.ctl.createSnapshot, { body: { app_name: APP, reason: 'manual' } })).body.record
    w.appFS.files['manifest.json'] = b(JSON.stringify({ identifier: APP, version: '0.2' }))
    const res = await w.call(w.ctl.restoreSnapshot, { body: { app_name: APP, snapshot_id: snap._id } })
    expect(res.statusCode).to.equal(200)
    const m = JSON.parse(w.appFS.files['manifest.json'].toString())
    expect(m.identifier).to.equal(APP)
    expect(m.version).to.equal('0.1')
  })

  it('prunes unpinned snapshots past the cap, keeping the oldest and the newest N, and removes their zips', async () => {
    const w = makeWorld(baseFiles())
    const total = MAX_UNPINNED_SNAPSHOTS + 3
    const ids = []
    for (let i = 0; i < total; i++) {
      w.appFS.files['app.js'] = b('v' + i)
      const r = await w.call(w.ctl.createSnapshot, { body: { app_name: APP, reason: 'pre_edit', label: 'n' + i } })
      expect(r.body.created).to.equal(true)
      ids.push(r.body.record._id)
      await new Promise((resolve) => setTimeout(resolve, 2)) // distinct timestamps
    }
    const remaining = await w.db('appSnapshots').query({ appName: APP })
    expect(remaining).to.have.length(MAX_UNPINNED_SNAPSHOTS + 1)
    const remainingIds = new Set(remaining.map((r) => r._id))
    expect(remainingIds.has(ids[0])).to.equal(true) // oldest kept
    expect(remainingIds.has(ids[1])).to.equal(false)
    expect(remainingIds.has(ids[2])).to.equal(false)
    expect(remainingIds.has(ids[total - 1])).to.equal(true)
    expect(Object.keys(w.creatorFS.userFiles)).to.have.length(MAX_UNPINNED_SNAPSHOTS + 1) // pruned zips gone
  })

  it('pins, renames, refuses to unpin or delete published versions, deletes others, 404s unknown ids', async () => {
    const w = makeWorld(baseFiles())
    const snap = (await w.call(w.ctl.createSnapshot, { body: { app_name: APP, reason: 'manual', label: 'a' } })).body.record

    const ren = await w.call(w.ctl.updateSnapshot, { body: { app_name: APP, snapshot_id: snap._id, label: 'renamed', pinned: true } })
    expect(ren.body.snapshot.label).to.equal('renamed')
    expect(ren.body.snapshot.pinned).to.equal(true)
    expect((await w.call(w.ctl.updateSnapshot, { body: { app_name: APP, snapshot_id: snap._id } })).statusCode).to.equal(400) // nothing to update

    // A published record (as publishApp writes it) is kept whatever happens.
    const sdb = await w.userDS.getorInitDb({ app_name: CREATOR, collection_name: 'appSnapshots' })
    await sdb.create('pub-1', { appName: APP, snapshotId: 'pub-1', reason: 'published', label: 'Published v1', fileName: 'x.zip', pinned: true, timestamp: new Date().toISOString() })
    expect((await w.call(w.ctl.updateSnapshot, { body: { app_name: APP, snapshot_id: 'pub-1', pinned: false } })).statusCode).to.equal(400)
    expect((await w.call(w.ctl.deleteSnapshot, { body: { app_name: APP, snapshot_id: 'pub-1' } })).statusCode).to.equal(400)

    expect((await w.call(w.ctl.updateSnapshot, { body: { app_name: APP, snapshot_id: 'nope', pinned: true } })).statusCode).to.equal(404)
    expect((await w.call(w.ctl.restoreSnapshot, { body: { app_name: APP, snapshot_id: 'nope' } })).statusCode).to.equal(404)
    expect((await w.call(w.ctl.compareSnapshots, { body: { app_name: APP, a: 'current', b: 'nope' } })).statusCode).to.equal(404)
    // A snapshot of ANOTHER app is not reachable under this app's name.
    await sdb.create('other-1', { appName: 'com.other.app', snapshotId: 'other-1', reason: 'manual', fileName: 'y.zip', timestamp: new Date().toISOString() })
    expect((await w.call(w.ctl.restoreSnapshot, { body: { app_name: APP, snapshot_id: 'other-1' } })).statusCode).to.equal(404)

    const del = await w.call(w.ctl.deleteSnapshot, { body: { app_name: APP, snapshot_id: snap._id } })
    expect(del.statusCode).to.equal(200)
    expect(w.creatorFS.userFiles[snap.fileName]).to.equal(undefined)
    expect(await sdb.read_by_id(snap._id)).to.equal(null)

    // delete_app_snapshots clears everything but published records.
    await w.call(w.ctl.createSnapshot, { body: { app_name: APP, reason: 'manual' } })
    const all = await w.call(w.ctl.deleteAppSnapshots, { body: { app_name: APP } })
    expect(all.body.removed).to.equal(1)
    const left = await sdb.query({ appName: APP })
    expect(left.map((r) => r._id)).to.deep.equal(['pub-1'])
  })
  // ---- Backup & Transfer -------------------------------------------------------------------
  it('uploads an app zip (top folder stripped): before/after snapshots, history + fileUpdates, files replaced', async () => {
    const { zipSync } = await import('fflate')
    const w = makeWorld(baseFiles())
    const zip = zipSync({
      'myapp/manifest.json': new Uint8Array(b(JSON.stringify({ identifier: 'com.other.name', version: '0.9' }))),
      'myapp/index.html': new Uint8Array(b('<h1>uploaded</h1>')),
      'myapp/new.css': new Uint8Array(b('p{}')),
      'myapp/.DS_Store': new Uint8Array(b('junk'))
    })
    const res = await w.call(w.ctl.uploadAppZip, { body: { app_name: APP }, file: { buffer: Buffer.from(zip), originalname: 'myapp.zip' } })
    expect(res.statusCode).to.equal(200)
    expect(res.body.counts).to.deep.equal({ modified: 2, added: 1, deleted: 2, unchanged: 0 })
    expect(res.body.beforeSnapshot.created).to.equal(true)
    expect(res.body.afterSnapshot.created).to.equal(true)
    expect(Object.keys(w.appFS.files).sort()).to.deep.equal(['index.html', 'manifest.json', 'new.css'])
    expect(JSON.parse(w.appFS.files['manifest.json'].toString()).identifier).to.equal(APP) // aligned to this app
    const hist = await w.db('appUpdates').query({ appName: APP })
    expect(hist).to.have.length(1)
    expect(hist[0].action).to.equal('uploaded')
    expect(hist[0].uploadedFileName).to.equal('myapp.zip')
    const snaps = await w.db('appSnapshots').query({ appName: APP })
    expect(snaps.map((s) => s.reason).sort()).to.deep.equal(['pre_upload', 'upload'])
    expect(snaps.find((s) => s.reason === 'upload').historyId).to.equal(hist[0]._id)
    const fu = await w.db('fileUpdates').query({ appName: APP })
    expect(fu.map((r) => r.path).sort()).to.deep.equal(['app.js', 'index.html', 'manifest.json', 'new.css'])

    // Same zip again → nothing to do, no second history entry, "upload" snapshot aliased not duplicated.
    const again = await w.call(w.ctl.uploadAppZip, { body: { app_name: APP }, file: { buffer: Buffer.from(zip), originalname: 'myapp.zip' } })
    expect(again.body.nothingToDo).to.equal(true)
    expect(await w.db('appUpdates').query({ appName: APP })).to.have.length(1)
    expect(await w.db('appSnapshots').query({ appName: APP })).to.have.length(2)
  })

  it('rejects uploads that are not zips, have no manifest, or no file', async () => {
    const { zipSync } = await import('fflate')
    const w = makeWorld(baseFiles())
    expect((await w.call(w.ctl.uploadAppZip, { body: { app_name: APP } })).statusCode).to.equal(400)
    expect((await w.call(w.ctl.uploadAppZip, { body: { app_name: APP }, file: { buffer: b('x'), originalname: 'notes.txt' } })).statusCode).to.equal(400)
    const noManifest = zipSync({ 'index.html': new Uint8Array(b('x')) })
    const r = await w.call(w.ctl.uploadAppZip, { body: { app_name: APP }, file: { buffer: Buffer.from(noManifest), originalname: 'a.zip' } })
    expect(r.statusCode).to.equal(400)
    expect(r.body.error).to.match(/manifest/)
    expect(w.appFS.files['index.html'].toString()).to.equal('<h1>hello</h1>') // untouched
  })

  it('downloads the app as a zip and the chat as a JSON export', async () => {
    const w = makeWorld(baseFiles())
    const au = await w.userDS.getorInitDb({ app_name: CREATOR, collection_name: 'appUpdates' })
    await au.create('h1', { appName: APP, action: 'chat', summary: 's', timestamp: '2026-01-02T00:00:00.000Z' })
    await au.create('h0', { appName: APP, action: 'created', timestamp: '2026-01-01T00:00:00.000Z' })
    await au.create('hx', { appName: 'com.other', action: 'created', timestamp: '2026-01-01T00:00:00.000Z' })

    const z = await w.call(w.ctl.downloadAppZip, { query: { app_name: APP } })
    expect(z.statusCode).to.equal(200)
    expect(z.headers['Content-Type']).to.equal('application/zip')
    expect(z.headers['X-Freezr-Filename']).to.match(/\.zip$/)
    const unz = unzipSync(new Uint8Array(z.body))
    expect(Object.keys(unz).sort()).to.deep.equal(['app.js', 'img/logo.png', 'index.html', 'manifest.json'])

    const cjs = await w.call(w.ctl.downloadChat, { query: { app_name: APP } })
    expect(cjs.statusCode).to.equal(200)
    expect(cjs.body.format).to.equal('freezr-creator-chat')
    expect(cjs.body.appUpdates.map((r) => r._id)).to.deep.equal(['h0', 'h1']) // this app only, oldest first
    expect(cjs.body.fileUpdates).to.deep.equal([])
    expect(cjs.headers['X-Freezr-Filename']).to.match(/chat .*\.json$/)
  })

  it('imports a chat export idempotently: uid-keyed, fresh local ids, links remapped, legacy _id fallback', async () => {
    const w = makeWorld(baseFiles())
    const au = await w.userDS.getorInitDb({ app_name: CREATOR, collection_name: 'appUpdates' })
    // Local records: one legacy (no uid) whose _id the export also carries, one with a uid the export shares under a different _id.
    await au.create('shared1', { appName: APP, action: 'chat', summary: 'already here', timestamp: '2026-01-01T00:00:00.000Z' })
    await au.create('localX', { appName: APP, uid: 'u-9', action: 'chat', summary: 'local copy', timestamp: '2026-01-02T00:00:00.000Z' })
    const exportFile = {
      format: 'freezr-creator-chat',
      formatVersion: 1,
      appName: 'com.test.snapapp',
      exportedFrom: 'https://online.example',
      appUpdates: [
        { _id: 'shared1', _date_created: 1, appName: 'com.test.snapapp', action: 'chat', summary: 'remote copy', timestamp: '2026-01-01T00:00:00.000Z' },
        { _id: 'remoteX', uid: 'u-9', appName: 'com.test.snapapp', action: 'chat', summary: 'remote copy of u-9', timestamp: '2026-01-02T00:00:00.000Z' },
        { _id: 'remote2', uid: 'u-2', _date_created: 2, _date_modified: 3, appName: 'com.test.snapapp', action: 'chat', chatId: 'c1', turnId: 't1', summary: 'from online', timestamp: '2026-01-03T00:00:00.000Z' },
        { _id: 'old-h', appName: 'com.test.snapapp', action: 'file_edit', summary: 'legacy manual edit', timestamp: '2026-01-05T00:00:00.000Z' },
        { appName: 'com.test.snapapp', action: 'chat', summary: 'no ids at all → content-derived key', timestamp: '2026-01-04T00:00:00.000Z' }
      ],
      fileUpdates: [
        { _id: 'rf1', uid: 'fu-1', appName: 'com.test.snapapp', path: 'app.js', action: 'upsert', content: 'remote', historyId: 't1', timestamp: '2026-01-03T00:00:00.000Z' },
        { _id: 'rf2', appName: 'com.test.snapapp', path: 'x.js', action: 'upsert', content: 'c', historyId: 'old-h', timestamp: '2026-01-05T00:00:00.000Z' }
      ]
    }
    const file = { buffer: b(JSON.stringify(exportFile)), originalname: 'chat.json' }
    const r1 = await w.call(w.ctl.uploadChat, { body: { app_name: APP }, file })
    expect(r1.statusCode).to.equal(200)
    expect(r1.body.appUpdates).to.deep.equal({ imported: 3, skipped: 2, invalid: 0 })
    expect(r1.body.fileUpdates).to.deep.equal({ imported: 2, skipped: 0, invalid: 0 })
    expect(r1.body.historyId).to.be.a('string')

    expect((await au.read_by_id('shared1')).summary).to.equal('already here') // legacy: matched by _id, local wins
    expect((await au.read_by_id('localX')).summary).to.equal('local copy') // matched by uid, local wins
    expect(await au.read_by_id('remoteX')).to.equal(null)

    const imported = (await au.query({ appName: APP, uid: 'u-2' }))[0]
    expect(imported).to.exist
    expect(imported._id).to.not.equal('remote2') // fresh local id; identity lives in uid
    expect(imported.turnId).to.equal('t1')
    expect(imported._date_created).to.equal(undefined)

    // A legacy record (no uid) is imported with uid = its exported _id, and the fileUpdates row that
    // pointed at that _id now points at the NEW local _id.
    const legacy = (await au.query({ appName: APP, uid: 'old-h' }))[0]
    expect(legacy).to.exist
    expect(legacy._id).to.not.equal('old-h')
    const fuDb = w.db('fileUpdates')
    const fu2 = (await fuDb.query({ appName: APP, uid: 'rf2' }))[0]
    expect(fu2.historyId).to.equal(legacy._id)
    const fu1 = (await fuDb.query({ appName: APP, uid: 'fu-1' }))[0]
    expect(fu1.historyId).to.equal('t1') // a turnId link is not an _id, left as is

    // Second upload of the same file: nothing new, no extra "imported" history entry.
    const before = (await au.query({ appName: APP })).length
    const r2 = await w.call(w.ctl.uploadChat, { body: { app_name: APP }, file })
    expect(r2.body.appUpdates).to.deep.equal({ imported: 0, skipped: 5, invalid: 0 })
    expect(r2.body.fileUpdates).to.deep.equal({ imported: 0, skipped: 2, invalid: 0 })
    expect(r2.body.historyId).to.equal(null)
    expect((await au.query({ appName: APP })).length).to.equal(before)

    // Round trip: what this side exports now carries the same uids, so the other side skips them too.
    const exp = await w.call(w.ctl.downloadChat, { query: { app_name: APP } })
    const uids = exp.body.appUpdates.map((r) => r.uid)
    expect(uids).to.include('u-2')
    expect(uids).to.include('old-h')

    // Wrong format / not JSON.
    expect((await w.call(w.ctl.uploadChat, { body: { app_name: APP }, file: { buffer: b('{"format":"nope"}'), originalname: 'x.json' } })).statusCode).to.equal(400)
    expect((await w.call(w.ctl.uploadChat, { body: { app_name: APP }, file: { buffer: b('not json'), originalname: 'x.json' } })).statusCode).to.equal(400)
  })

  // ---- provenance ----------------------------------------------------------------------------
  it("stamps author on server-written records, links before/after snapshots on upload and restore", async () => {
    const { zipSync } = await import("fflate")
    const w = makeWorld(baseFiles())
    const zip = zipSync({ "manifest.json": new Uint8Array(baseFiles()["manifest.json"]), "index.html": new Uint8Array(b("<h1>v2</h1>")) })
    const up = await w.call(w.ctl.uploadAppZip, { body: { app_name: APP }, file: { buffer: Buffer.from(zip), originalname: "v2.zip" } })
    expect(up.statusCode).to.equal(200)
    const hist = await w.db("appUpdates").query({ appName: APP })
    const uploaded = hist.find((h) => h.action === "uploaded")
    expect(uploaded.author).to.deep.equal({ user: "tester", server: "http://localhost" })
    expect(uploaded.uid).to.be.a("string")
    expect(uploaded.beforeSnapshotId).to.equal(up.body.beforeSnapshot._id)
    expect(uploaded.afterSnapshotId).to.equal(up.body.afterSnapshot._id)
    const fu = await w.db("fileUpdates").query({ appName: APP })
    expect(fu.every((r) => r.author && r.author.user === "tester" && r.uid)).to.equal(true)

    const res = await w.call(w.ctl.restoreSnapshot, { body: { app_name: APP, snapshot_id: up.body.beforeSnapshot._id } })
    expect(res.statusCode).to.equal(200)
    const restored = (await w.db("appUpdates").query({ appName: APP })).find((h) => h.action === "restored")
    expect(restored.beforeSnapshotId).to.equal(res.body.preRestoreSnapshot._id)
    expect(restored.afterSnapshotId).to.equal(up.body.beforeSnapshot._id)
    expect(restored.author.user).to.equal("tester")
  })

  it("export fills a missing author with the exporter; import keeps authors and stamps importedFrom", async () => {
    const w = makeWorld(baseFiles())
    const au = await w.userDS.getorInitDb({ app_name: CREATOR, collection_name: "appUpdates" })
    await au.create("legacy", { appName: APP, action: "chat", summary: "old", timestamp: "2026-01-01T00:00:00.000Z" })
    await au.create("mine", { appName: APP, uid: "u-mine", author: { user: "tester", server: "http://localhost" }, action: "chat", summary: "new", timestamp: "2026-01-02T00:00:00.000Z" })
    const exp = await w.call(w.ctl.downloadChat, { query: { app_name: APP } })
    const byId = Object.fromEntries(exp.body.appUpdates.map((r) => [r._id, r]))
    expect(byId.legacy.author).to.deep.equal({ user: "tester", server: "http://localhost" })
    expect(byId.mine.author).to.deep.equal({ user: "tester", server: "http://localhost" })
    expect((await au.read_by_id("legacy")).author).to.equal(undefined) // nothing written back

    // Import that export into ANOTHER world as a different person on a different server.
    const w2 = makeWorld(baseFiles())
    const file = { buffer: b(JSON.stringify({ ...exp.body, exportedBy: "alice", exportedFrom: "https://alice.example" })), originalname: "alice chat.json" }
    const r = await w2.call(w2.ctl.uploadChat, { body: { app_name: APP }, file })
    expect(r.body.appUpdates.imported).to.equal(2)
    const au2 = await w2.userDS.getorInitDb({ app_name: CREATOR, collection_name: "appUpdates" })
    const imp = (await au2.query({ appName: APP, uid: "u-mine" }))[0]
    expect(imp.author).to.deep.equal({ user: "tester", server: "http://localhost" }) // original author survives
    expect(imp.importedFrom.user).to.equal("alice")
    expect(imp.importedFrom.server).to.equal("https://alice.example")
    expect(imp.importedFrom.fileName).to.equal("alice chat.json")
    const noAuthor = { format: "freezr-creator-chat", appUpdates: [{ _id: "bare", action: "chat", summary: "s", timestamp: "2026-01-03T00:00:00.000Z" }], fileUpdates: [], exportedBy: "bob", exportedFrom: "https://bob.example" }
    await w2.call(w2.ctl.uploadChat, { body: { app_name: APP }, file: { buffer: b(JSON.stringify(noAuthor)), originalname: "bob.json" } })
    const bare = (await au2.query({ appName: APP, uid: "bare" }))[0]
    expect(bare.author).to.deep.equal({ user: "bob", server: "https://bob.example" }) // falls back to the exporter
  })
})
