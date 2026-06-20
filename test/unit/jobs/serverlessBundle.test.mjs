// Unit tests for serverless bundle assembly (Phase 6.2) — no server needed.
// Uses the real host client sources (reads the browser client files from the repo).
import { expect } from 'chai'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'
import { assembleJobBundle, zipBundleFiles, ENTRYPOINT_SRC, looksLikeZip, looksLikeJobSource } from '../../../adapters/jobs/serverlessBundle.mjs'

describe('serverlessBundle.looksLikeZip / looksLikeJobSource (reject error stubs from a remote fs)', function () {
  it('accepts a real zip (PK signature) and rejects an HTML/blank stub', function () {
    const realZip = zipSync({ 'index.mjs': strToU8('export const x = 1') })
    expect(looksLikeZip(realZip)).to.be.true
    expect(looksLikeZip(new Uint8Array(Buffer.from('<!DOCTYPE html><html>not found</html>')))).to.be.false
    expect(looksLikeZip(new Uint8Array())).to.be.false
    expect(looksLikeZip(null)).to.be.false
  })

  it('accepts an empty-archive zip (PK\\x05\\x06) signature', function () {
    expect(looksLikeZip(new Uint8Array([0x50, 0x4B, 0x05, 0x06, 0, 0]))).to.be.true
  })

  it('treats JS as job source but rejects an HTML stub or empty string', function () {
    expect(looksLikeJobSource('export async function handler () {}')).to.be.true
    expect(looksLikeJobSource('   \n// a job\nexport default {}')).to.be.true
    expect(looksLikeJobSource('<!DOCTYPE html><html>error</html>')).to.be.false
    expect(looksLikeJobSource('   <html>')).to.be.false
    expect(looksLikeJobSource('')).to.be.false
    expect(looksLikeJobSource(null)).to.be.false
  })
})

const HANDLER_SRC = "export async function handler (freezr, params) { return { ok: true, n: params.n } }\n"

describe('serverlessBundle.assembleJobBundle', function () {
  let root
  const app = 'com.example.bundletest'
  const name = 'doit'

  before(async function () {
    root = await mkdtemp(join(tmpdir(), 'freezr-bundle-'))
    await mkdir(join(root, app, name), { recursive: true })
    await writeFile(join(root, app, name, 'index.mjs'), HANDLER_SRC, 'utf8')
  })

  after(async function () {
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('assembles the expected file layout (Tier-1)', async function () {
    const { files, tier, fileCount } = await assembleJobBundle({ app, name, jobsDir: root })
    expect(tier).to.equal(1)
    expect(fileCount).to.be.at.least(5)
    expect(files).to.have.property('index.mjs')
    expect(files).to.have.property('_freezr/jobClientCore.mjs')
    expect(files).to.have.property('_freezr/httpJobTransport.mjs')
    expect(files).to.have.property('_freezr/clientSources.json')
    expect(files).to.have.property('job/index.mjs')
    // no Tier-2 artifacts
    expect(files).to.not.have.property('job/package.json')
  })

  it('ships the developer handler unchanged', async function () {
    const { files } = await assembleJobBundle({ app, name, jobsDir: root })
    expect(strFromU8(files['job/index.mjs'])).to.equal(HANDLER_SRC)
  })

  it('generates an entrypoint that exports a handler and bridges to the dev job', async function () {
    const { files } = await assembleJobBundle({ app, name, jobsDir: root })
    const entry = strFromU8(files['index.mjs'])
    expect(entry).to.equal(ENTRYPOINT_SRC)
    expect(entry).to.match(/export const handler\s*=/)
    expect(entry).to.include("from './job/index.mjs'")
    expect(entry).to.include('makeHttpTransport')
    expect(entry).to.include('buildFreezrClient')
  })

  it('embeds the real client sources (core + addons) as parseable JSON', async function () {
    const { files } = await assembleJobBundle({ app, name, jobsDir: root })
    const sources = JSON.parse(strFromU8(files['_freezr/clientSources.json']))
    expect(sources).to.have.property('coreName')
    expect(sources.core).to.be.a('string').with.length.greaterThan(100)
    expect(sources.addons).to.be.an('array')
    // the core really is the browser client (defines the freezr object onto window)
    expect(sources.core).to.include('window.freezr')
  })

  it('zips to a non-empty archive that round-trips back to the same files', async function () {
    const { files } = await assembleJobBundle({ app, name, jobsDir: root })
    const zip = zipBundleFiles(files)
    expect(zip).to.be.an.instanceof(Uint8Array)
    expect(zip.length).to.be.greaterThan(0)
    const back = unzipSync(zip)
    expect(Object.keys(back).sort()).to.deep.equal(Object.keys(files).sort())
    expect(strFromU8(back['job/index.mjs'])).to.equal(HANDLER_SRC)
  })

  it('detects Tier-2 and copies the pre-built node_modules + package.json under job/', async function () {
    const t2 = 'withdeps'
    await mkdir(join(root, app, t2, 'node_modules', 'leftpad'), { recursive: true })
    await writeFile(join(root, app, t2, 'index.mjs'), HANDLER_SRC, 'utf8')
    await writeFile(join(root, app, t2, 'package.json'), '{"name":"withdeps","version":"1.0.0"}', 'utf8')
    await writeFile(join(root, app, t2, 'node_modules', 'leftpad', 'index.js'), 'module.exports = 1\n', 'utf8')

    const { files, tier } = await assembleJobBundle({ app, name: t2, jobsDir: root })
    expect(tier).to.equal(2)
    expect(files).to.have.property('job/package.json')
    expect(files).to.have.property('job/node_modules/leftpad/index.js')
  })

  it('coerces an explicit null jobsDir to the default (no "path must be a string" crash)', async function () {
    // invokeJob passes jobsDir through and may hand us null; default params only fill undefined,
    // so the function must coerce null → jobsBaseDir(). With null it falls back to the repo
    // users_jobs (where this temp app doesn't live) → a CLEAN "job code not found", NOT the old
    // TypeError "The path argument must be of type string. Received null".
    let err
    try { await assembleJobBundle({ app, name, jobsDir: null, clientSources: null }) } catch (e) { err = e }
    expect(err, 'should throw a clean not-found, not succeed').to.exist
    expect(err.message).to.match(/job code not found/)
    expect(err.message).to.not.match(/path/i)
  }).timeout(5000)

  it('uses supplied handlerSource (the user-app/no-trust path) without reading from disk', async function () {
    const supplied = "export async function handler () { return { fromAppFS: true } }\n"
    // name points at a job that does NOT exist on disk — proves it used the supplied source.
    const { files, tier } = await assembleJobBundle({ app, name: 'not-on-disk', jobsDir: root, handlerSource: supplied })
    expect(tier).to.equal(1)
    expect(strFromU8(files['job/index.mjs'])).to.equal(supplied)
    expect(files).to.have.property('index.mjs')
    expect(files).to.have.property('_freezr/clientSources.json')
  })

  it('uses a pre-built jobZip (the install-time bundle) and detects Tier-2 from node_modules', async function () {
    const jobZip = zipSync({
      'index.mjs': strToU8("import dep from 'leftpad'\nexport async function handler () { return dep }\n"),
      'package.json': strToU8('{"name":"withdeps","version":"1.0.0"}'),
      'node_modules/leftpad/index.js': strToU8('module.exports = 1\n')
    }, { level: 6 })
    const { files, tier } = await assembleJobBundle({ app, name: 'zipped', jobZip })
    expect(tier).to.equal(2)
    expect(files).to.have.property('job/index.mjs')
    expect(files).to.have.property('job/package.json')
    expect(files).to.have.property('job/node_modules/leftpad/index.js')
    expect(files).to.have.property('index.mjs') // the generated entrypoint is still there
  })

  it('throws when a jobZip has no index.mjs', async function () {
    const bad = zipSync({ 'readme.txt': strToU8('hi') }, { level: 6 })
    let threw = false
    try { await assembleJobBundle({ app, name: 'bad', jobZip: bad }) } catch (e) { threw = true }
    expect(threw).to.be.true
  })

  it('throws when the job code is missing', async function () {
    let threw = false
    try { await assembleJobBundle({ app, name: 'nope', jobsDir: root }) } catch (e) { threw = true }
    expect(threw).to.be.true
  })
})
