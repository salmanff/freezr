// Unit tests for features/creator/services/appSnapshotService.mjs — the pure helpers behind the
// creator's whole-app snapshots (hashing, diffing, retention, manifest alignment).
import { expect } from 'chai'
import {
  normalizeFileMap, hashFileMap, diffFileMaps, selectSnapshotsToPrune, alignManifestIdentifier,
  snapshotZipPath, newSnapshotId, isTextPath, MAX_UNPINNED_SNAPSHOTS
} from '../../../features/creator/services/appSnapshotService.mjs'

const b = (s) => Buffer.from(s, 'utf8')

describe('appSnapshotService', () => {
  describe('normalizeFileMap', () => {
    it('drops folder entries, __MACOSX and dot-files, and normalises slashes', () => {
      const out = normalizeFileMap({
        'index.html': b('a'),
        'sub/': b(''),
        '/lead/slash.js': b('x'),
        'win\\style.css': b('y'),
        '__MACOSX/._index.html': b('junk'),
        '.DS_Store': b('junk'),
        'sub/.git/config': b('junk')
      })
      expect(Object.keys(out).sort()).to.deep.equal(['index.html', 'lead/slash.js', 'win/style.css'])
    })
  })

  describe('hashFileMap', () => {
    it('is order-independent and content-sensitive', () => {
      const h1 = hashFileMap({ 'a.js': b('1'), 'b.js': b('2') })
      const h2 = hashFileMap({ 'b.js': b('2'), 'a.js': b('1') })
      const h3 = hashFileMap({ 'a.js': b('1'), 'b.js': b('3') })
      const h4 = hashFileMap({ 'a.js': b('1'), 'c.js': b('2') })
      expect(h1).to.equal(h2)
      expect(h1).to.not.equal(h3)
      expect(h1).to.not.equal(h4)
    })

    it('accepts Uint8Array values as well as Buffers', () => {
      expect(hashFileMap({ 'a.js': new Uint8Array([49]) })).to.equal(hashFileMap({ 'a.js': b('1') }))
    })
  })

  describe('diffFileMaps', () => {
    it('classifies added / modified / deleted / unchanged going from a to b', () => {
      const a = { 'same.js': b('s'), 'mod.js': b('old'), 'gone.js': b('g'), 'logo.png': b('\x89PNG1') }
      const bb = { 'same.js': b('s'), 'mod.js': b('new'), 'new.js': b('n'), 'logo.png': b('\x89PNG2') }
      const { files, counts } = diffFileMaps(a, bb)
      const byPath = Object.fromEntries(files.map((f) => [f.path, f]))
      expect(byPath['same.js'].status).to.equal('unchanged')
      expect(byPath['mod.js'].status).to.equal('modified')
      expect(byPath['gone.js'].status).to.equal('deleted')
      expect(byPath['new.js'].status).to.equal('added')
      expect(byPath['logo.png'].status).to.equal('modified')
      expect(counts).to.deep.equal({ modified: 2, added: 1, deleted: 1, unchanged: 1 })
    })

    it('includes text contents only for changed text files, never for binaries', () => {
      const { files } = diffFileMaps({ 'mod.js': b('old'), 'x.png': b('1') }, { 'mod.js': b('new'), 'x.png': b('2') })
      const byPath = Object.fromEntries(files.map((f) => [f.path, f]))
      expect(byPath['mod.js'].a).to.equal('old')
      expect(byPath['mod.js'].b).to.equal('new')
      expect(byPath['x.png'].binary).to.equal(true)
      expect(byPath['x.png']).to.not.have.property('a')
      expect(byPath['x.png'].aSize).to.equal(1)
    })

    it('omits contents when includeContent is false', () => {
      const { files } = diffFileMaps({ 'a.js': b('1') }, { 'a.js': b('2') }, { includeContent: false })
      expect(files[0]).to.not.have.property('a')
      expect(files[0].status).to.equal('modified')
    })

    it('reports null content for the missing side of an add or delete', () => {
      const { files } = diffFileMaps({}, { 'n.js': b('n') })
      expect(files[0].a).to.equal(null)
      expect(files[0].b).to.equal('n')
    })
  })

  describe('selectSnapshotsToPrune', () => {
    const rec = (i, extra = {}) => ({ _id: 's' + i, timestamp: new Date(2026, 0, 1, 0, i).toISOString(), ...extra })

    it('keeps everything under the cap', () => {
      const recs = Array.from({ length: MAX_UNPINNED_SNAPSHOTS }, (_, i) => rec(i))
      expect(selectSnapshotsToPrune(recs)).to.deep.equal([])
    })

    it('prunes the middle: keeps the oldest and the newest N, never pinned or published', () => {
      const recs = [
        ...Array.from({ length: 8 }, (_, i) => rec(i)),
        rec(100, { pinned: true }),
        rec(101, { reason: 'published' })
      ]
      const victims = selectSnapshotsToPrune(recs, 3)
      // unpinned sorted: s0..s7 → keep s0 (oldest) + s5,s6,s7 (newest 3) → prune s1..s4
      expect(victims.map((v) => v._id)).to.deep.equal(['s1', 's2', 's3', 's4'])
    })

    it('works when given records in any order', () => {
      const recs = [rec(3), rec(0), rec(2), rec(1), rec(4)]
      expect(selectSnapshotsToPrune(recs, 2).map((v) => v._id)).to.deep.equal(['s1', 's2'])
    })
  })

  describe('alignManifestIdentifier', () => {
    it('rewrites a stale identifier to the current app name', () => {
      const out = alignManifestIdentifier({ 'manifest.json': b(JSON.stringify({ identifier: 'com.old.app', version: '1' })) }, 'com.new.app')
      expect(JSON.parse(out['manifest.json'].toString()).identifier).to.equal('com.new.app')
    })

    it('leaves a matching or unparseable manifest alone', () => {
      const same = { 'manifest.json': b(JSON.stringify({ identifier: 'com.x.y' })) }
      expect(alignManifestIdentifier(same, 'com.x.y')).to.equal(same)
      const broken = { 'manifest.json': b('{ not json') }
      expect(alignManifestIdentifier(broken, 'com.x.y')).to.equal(broken)
      expect(alignManifestIdentifier({ 'a.js': b('x') }, 'com.x.y')).to.deep.equal({ 'a.js': b('x') })
    })
  })

  describe('misc', () => {
    it('builds the zip path under snapshots/<app>/', () => {
      expect(snapshotZipPath('com.a.b', 'id1')).to.equal('snapshots/com.a.b/id1.zip')
    })
    it('mints sortable unique ids', () => {
      const a = newSnapshotId()
      const bId = newSnapshotId()
      expect(a).to.match(/^\d{14}-[0-9a-f]{8}$/)
      expect(a).to.not.equal(bId)
    })
    it('knows text from binary by extension', () => {
      expect(isTextPath('x/y.MJS')).to.equal(true)
      expect(isTextPath('x/y.png')).to.equal(false)
      expect(isTextPath('LICENSE')).to.equal(false)
    })
  })
})

describe('appSnapshotService — chat import records', async () => {
  const { importableRecord, importKeyOf, derivedRecordId } = await import('../../../features/creator/services/appSnapshotService.mjs')

  it('keys on uid first, then the exported _id, and never keeps system fields', () => {
    const withUid = importableRecord({ _id: 'db1', uid: 'u-1', _date_created: 1, appName: 'com.old', action: 'chat' }, 'com.new')
    expect(withUid.key).to.equal('u-1')
    expect(withUid.sourceId).to.equal('db1')
    expect(withUid.record).to.deep.equal({ uid: 'u-1', appName: 'com.new', action: 'chat' })

    const legacy = importableRecord({ _id: 'db2', appName: 'com.old', action: 'chat', turnId: 't1' }, 'com.new')
    expect(legacy.key).to.equal('db2') // pre-uid record: the exported _id is the identity …
    expect(legacy.record.uid).to.equal('db2') // … and the imported copy carries it as uid from now on
    expect(legacy.record).to.not.have.property('_id')
    expect(importKeyOf({ uid: 'u', _id: 'x' })).to.equal('u')
    expect(importKeyOf({ _id: 'x' })).to.equal('x')
    expect(importKeyOf({})).to.equal(null)
  })

  it('derives a stable key for a record with neither uid nor _id, independent of appName and key order', () => {
    const a = importableRecord({ appName: 'com.old', action: 'chat', timestamp: '2026-01-01T00:00:00.000Z', summary: 's' }, 'com.new')
    const b = importableRecord({ summary: 's', timestamp: '2026-01-01T00:00:00.000Z', action: 'chat', appName: 'com.elsewhere' }, 'com.new')
    expect(a.key).to.match(/^imp-[0-9a-f]{24}$/)
    expect(a.key).to.equal(b.key)
    expect(a.record.uid).to.equal(a.key)
    const c = importableRecord({ action: 'chat', timestamp: '2026-01-01T00:00:00.000Z', summary: 'different' }, 'com.new')
    expect(c.key).to.not.equal(a.key)
    expect(derivedRecordId({ x: 1 })).to.equal(derivedRecordId({ x: 1, appName: 'ignored', uid: 'ignored' }))
  })

  it('rejects non-records', () => {
    expect(importableRecord(null, 'a')).to.equal(null)
    expect(importableRecord('str', 'a')).to.equal(null)
    expect(importableRecord([1], 'a')).to.equal(null)
    expect(importableRecord({ _id: 'only-system' }, 'a')).to.equal(null)
  })
})
