// use_file_sys — path-confinement unit tests (the security-critical core of the fs feature).
// Exercises fsService's sanitize / root-vetting / confinement pure(ish) functions against a
// real temp directory tree, including symlink-escape attempts, then the full openFsHandle
// surface (list/stat/read/write/remove) on a local store. No server needed.
import { expect } from 'chai'
import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  sanitizeRelPath,
  resolveLocalRootOrThrow,
  confineLocalPath,
  openFsHandle
} from '../../../features/connections/fs/services/fsService.mjs'

describe('use_file_sys — sanitizeRelPath (lexical gate)', function () {
  it('passes plain relative paths and normalizes empties', function () {
    expect(sanitizeRelPath('')).to.equal('')
    expect(sanitizeRelPath(undefined)).to.equal('')
    expect(sanitizeRelPath('a/b/c.txt')).to.equal('a/b/c.txt')
    expect(sanitizeRelPath('a//b/./c')).to.equal('a/b/c') // empty + '.' segments collapse
    expect(sanitizeRelPath('with spaces/and (parens).pdf')).to.equal('with spaces/and (parens).pdf')
  })

  it('rejects traversal, absolute paths, null bytes and backslashes', function () {
    expect(() => sanitizeRelPath('../x')).to.throw(/\.\./)
    expect(() => sanitizeRelPath('a/../../x')).to.throw(/\.\./)
    expect(() => sanitizeRelPath('/etc/passwd')).to.throw(/relative/)
    expect(() => sanitizeRelPath('a\0b')).to.throw(/null/)
    expect(() => sanitizeRelPath('a\\b')).to.throw(/forward slashes/)
    expect(() => sanitizeRelPath(42)).to.throw(/string/)
  })
})

describe('use_file_sys — local root vetting + confinement', function () {
  let base // realpath'd sandbox holding root + an "outside" area
  let root // the mounted store root (realpath'd)

  before(function () {
    base = nodeFs.realpathSync(nodeFs.mkdtempSync(path.join(os.tmpdir(), 'frzr-fs-test-')))
    root = path.join(base, 'mount')
    nodeFs.mkdirSync(path.join(root, 'docs'), { recursive: true })
    nodeFs.writeFileSync(path.join(root, 'docs', 'a.txt'), 'hello')
    nodeFs.mkdirSync(path.join(base, 'outside'))
    nodeFs.writeFileSync(path.join(base, 'outside', 'secret.txt'), 'secret')
    // symlinks: one escaping the mount, one staying inside
    nodeFs.symlinkSync(path.join(base, 'outside', 'secret.txt'), path.join(root, 'escape-link'))
    nodeFs.symlinkSync(path.join(base, 'outside'), path.join(root, 'escape-dir'))
    nodeFs.symlinkSync(path.join(root, 'docs', 'a.txt'), path.join(root, 'inside-link'))
  })

  after(function () {
    try { nodeFs.rmSync(base, { recursive: true, force: true }) } catch (e) { /* best effort */ }
  })

  it('accepts a real directory outside the freezr tree', function () {
    expect(resolveLocalRootOrThrow(root)).to.equal(root)
  })

  it('rejects relative, missing and non-directory roots', function () {
    expect(() => resolveLocalRootOrThrow('mount')).to.throw(/absolute/)
    expect(() => resolveLocalRootOrThrow(path.join(base, 'nope'))).to.throw(/does not exist/)
    expect(() => resolveLocalRootOrThrow(path.join(root, 'docs', 'a.txt'))).to.throw(/not a directory/)
  })

  it('rejects roots overlapping the freezr tree — both directions', function () {
    const freezrRoot = path.join(base, 'outside') // stand-in freezr install dir
    // root inside freezr tree
    expect(() => resolveLocalRootOrThrow(path.join(base, 'outside'), { freezrRoot })).to.throw(/overlap/)
    // root CONTAINING the freezr tree (e.g. mounting the whole home dir)
    expect(() => resolveLocalRootOrThrow(base, { freezrRoot })).to.throw(/overlap/)
    // disjoint root is fine
    expect(resolveLocalRootOrThrow(root, { freezrRoot })).to.equal(root)
  })

  it('resolves a symlinked root to its realpath', function () {
    const link = path.join(base, 'mount-link')
    nodeFs.symlinkSync(root, link)
    expect(resolveLocalRootOrThrow(link)).to.equal(root)
  })

  it('confines normal paths and 404s missing mustExist targets', function () {
    expect(confineLocalPath({ rootReal: root, relPath: 'docs/a.txt', mustExist: true }))
      .to.equal(path.join(root, 'docs', 'a.txt'))
    expect(() => confineLocalPath({ rootReal: root, relPath: 'docs/missing.txt', mustExist: true }))
      .to.throw(/no such file/)
  })

  it('blocks symlink escapes (file and directory), allows inside-links', function () {
    expect(() => confineLocalPath({ rootReal: root, relPath: 'escape-link', mustExist: true }))
      .to.throw(/outside the file store root/)
    expect(() => confineLocalPath({ rootReal: root, relPath: 'escape-dir/secret.txt', mustExist: true }))
      .to.throw(/outside the file store root/)
    expect(confineLocalPath({ rootReal: root, relPath: 'inside-link', mustExist: true }))
      .to.equal(path.join(root, 'inside-link'))
  })

  it('vets write targets through their deepest existing ancestor', function () {
    // fine: new file under an existing real dir
    expect(confineLocalPath({ rootReal: root, relPath: 'docs/new/sub/file.txt', forWrite: true }))
      .to.equal(path.join(root, 'docs', 'new', 'sub', 'file.txt'))
    // blocked: new file whose existing ancestor symlinks outside the mount
    expect(() => confineLocalPath({ rootReal: root, relPath: 'escape-dir/new.txt', forWrite: true }))
      .to.throw(/outside the file store root/)
  })
})

describe('use_file_sys — openFsHandle on a local store (end to end, no server)', function () {
  let base, root, handle
  const BYTES = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x68, 0x69]) // binary incl. invalid-utf8

  before(async function () {
    base = nodeFs.realpathSync(nodeFs.mkdtempSync(path.join(os.tmpdir(), 'frzr-fs-handle-')))
    root = path.join(base, 'mount')
    nodeFs.mkdirSync(path.join(root, 'docs', 'deep'), { recursive: true })
    nodeFs.writeFileSync(path.join(root, 'docs', 'a.txt'), 'hello')
    nodeFs.writeFileSync(path.join(root, 'docs', 'deep', 'b.txt'), 'world')
    nodeFs.writeFileSync(path.join(root, 'top.bin'), BYTES)
    nodeFs.mkdirSync(path.join(base, 'outside'))
    nodeFs.writeFileSync(path.join(base, 'outside', 'secret.txt'), 'secret')
    nodeFs.symlinkSync(path.join(base, 'outside', 'secret.txt'), path.join(root, 'escape-link'))
    handle = await openFsHandle({ connectionName: 't', fsParams: { type: 'local', rootPath: root } })
  })

  after(function () {
    try { nodeFs.rmSync(base, { recursive: true, force: true }) } catch (e) { /* best effort */ }
  })

  it('listDir returns normalized entries, dirs first, and skips escaping symlinks', async function () {
    const { entries, truncated } = await handle.listDir('')
    expect(truncated).to.equal(false)
    const names = entries.map(e => e.name)
    expect(names).to.include('docs').and.include('top.bin')
    expect(names, 'symlink that escapes the mount must not be listed').to.not.include('escape-link')
    expect(entries[0].type, 'dirs sort first').to.equal('dir')
    const bin = entries.find(e => e.name === 'top.bin')
    expect(bin.type).to.equal('file')
    expect(bin.size).to.equal(BYTES.length)
    expect(bin.mtimeMs).to.be.a('number')
  })

  it('listTree walks to the requested depth with counts', async function () {
    const { tree, count } = await handle.listTree('', { depth: 3 })
    const docs = tree.find(e => e.name === 'docs')
    const deep = docs.children.find(e => e.name === 'deep')
    expect(deep.children.map(e => e.name)).to.deep.equal(['b.txt'])
    expect(count).to.be.greaterThan(3)
  })

  it('statEntry 404s on missing and normalizes types', async function () {
    expect((await handle.statEntry('docs')).type).to.equal('dir')
    expect((await handle.statEntry('docs/a.txt')).type).to.equal('file')
    try {
      await handle.statEntry('nope.txt')
      throw new Error('should have thrown')
    } catch (e) { expect(e.status).to.equal(404) }
  })

  it('readFile returns faithful bytes (binary-safe) and refuses dirs + escapes', async function () {
    const { buffer } = await handle.readFile('top.bin')
    expect(Buffer.compare(buffer, BYTES)).to.equal(0)
    try {
      await handle.readFile('docs')
      throw new Error('should have thrown')
    } catch (e) { expect(e.code).to.equal('not_a_file') }
    try {
      await handle.readFile('escape-link')
      throw new Error('should have thrown')
    } catch (e) { expect(e.code).to.equal('path_escape') }
  })

  it('writeFile honors overwrite semantics and creates parent dirs', async function () {
    const res = await handle.writeFile('new/dir/c.txt', Buffer.from('created'))
    expect(res.written).to.equal(true)
    expect(nodeFs.readFileSync(path.join(root, 'new', 'dir', 'c.txt'), 'utf8')).to.equal('created')
    try {
      await handle.writeFile('new/dir/c.txt', Buffer.from('clobber'))
      throw new Error('should have thrown')
    } catch (e) { expect(e.status).to.equal(409) }
    await handle.writeFile('new/dir/c.txt', Buffer.from('clobber'), { overwrite: true })
    expect(nodeFs.readFileSync(path.join(root, 'new', 'dir', 'c.txt'), 'utf8')).to.equal('clobber')
  })

  it('removeFile removes files only — never directories', async function () {
    await handle.writeFile('togo.txt', Buffer.from('x'))
    const res = await handle.removeFile('togo.txt')
    expect(res.removed).to.equal(true)
    expect(nodeFs.existsSync(path.join(root, 'togo.txt'))).to.equal(false)
    try {
      await handle.removeFile('docs')
      throw new Error('should have thrown')
    } catch (e) { expect(e.code).to.equal('not_a_file') }
  })

  it('refuses to open a handle whose root overlaps the freezr tree', async function () {
    // process.cwd() is the freezr repo when tests run — a root inside it must throw.
    try {
      await openFsHandle({ fsParams: { type: 'local', rootPath: process.cwd() } })
      throw new Error('should have thrown')
    } catch (e) { expect(e.code).to.equal('forbidden_root') }
  })
})
