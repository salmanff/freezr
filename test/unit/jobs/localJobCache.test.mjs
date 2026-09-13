// Unit tests for the users_jobs local-cache materialization (rebuilt from the ADMIN's appFS).
//
// Materialization writes each build into a CONTENT-STAMPED dir (<name>@<stamp>/) and flips a
// <name>.current pointer file — Node's ESM cache can't be evicted, so only a never-imported dir
// guarantees a re-materialized job's sibling modules load fresh (not just index.mjs).
import { expect } from 'chai'
import { mkdtemp, rm, readFile, access, readdir, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'

let tmp
let materializeJobToCache, rematerializeTrustedJobs, removeLocalJobCache

before(async function () {
  tmp = await mkdtemp(join(tmpdir(), 'freezr-usersjobs-'))
  process.env.FREEZR_JOBS_DIR = tmp // jobsBaseDir() reads this at call time
  const mod = await import('../../../features/jobs/services/localJobCache.mjs')
  materializeJobToCache = mod.materializeJobToCache
  rematerializeTrustedJobs = mod.rematerializeTrustedJobs
  removeLocalJobCache = mod.removeLocalJobCache
})
after(async function () {
  delete process.env.FREEZR_JOBS_DIR
  if (tmp) await rm(tmp, { recursive: true, force: true })
})

// appFS whose readAppFile honours doNotToString (binary) vs text, like the real one.
function fakeAppFS (files = {}) {
  return {
    async readAppFile (p, opts = {}) {
      if (!(p in files)) { const e = new Error('no such file'); e.code = 'ENOENT'; throw e }
      const v = files[p]
      if (opts && opts.doNotToString) return (v instanceof Uint8Array) ? v : new Uint8Array(Buffer.from(v))
      return (v instanceof Uint8Array) ? Buffer.from(v).toString() : v
    }
  }
}
const exists = async (p) => { try { await access(p); return true } catch (e) { return false } }
// The live build dir: <app>/<name>@<stamp>, where <stamp> comes from the <name>.current pointer.
const currentDir = async (app, name) => {
  const stamp = (await readFile(join(tmp, app, name + '.current'), 'utf8')).trim()
  return join(tmp, app, name + '@' + stamp)
}
const stampDirsOf = async (app, name) =>
  (await readdir(join(tmp, app))).filter(n => n.startsWith(name + '@')).sort()

describe('localJobCache.materializeJobToCache', function () {
  it('unzips a full bundle (incl. node_modules) into a stamped users_jobs dir + pointer', async function () {
    const zip = zipSync({
      'index.mjs': strToU8('export async function handler () { return 1 }'),
      'package.json': strToU8('{"name":"x"}'),
      'node_modules/dep/index.js': strToU8('module.exports = 1')
    })
    const out = await materializeJobToCache({ appFS: fakeAppFS({ 'jobs/doit.zip': zip }), app: 'com.x', name: 'doit' })
    expect(out).to.deep.include({ ok: true, usedZip: true })
    expect(out.stamp).to.match(/^[a-f0-9]{12}$/)
    const dir = await currentDir('com.x', 'doit')
    expect(dir).to.include('doit@' + out.stamp)
    expect(await exists(join(dir, 'index.mjs'))).to.be.true
    expect(await exists(join(dir, 'node_modules', 'dep', 'index.js'))).to.be.true
    expect(await readFile(join(dir, 'index.mjs'), 'utf8')).to.match(/export async function handler/)
  })

  it('writes single-file index.mjs when only source is available (Tier-1)', async function () {
    const out = await materializeJobToCache({ appFS: fakeAppFS({ 'jobs/solo/index.mjs': 'export async function handler () { return 2 }' }), app: 'com.x', name: 'solo' })
    expect(out).to.deep.include({ ok: true, usedZip: false, files: 1 })
    expect(await readFile(join(await currentDir('com.x', 'solo'), 'index.mjs'), 'utf8')).to.match(/return 2/)
  })

  it('returns ok:false when the admin appFS has no usable code', async function () {
    const out = await materializeJobToCache({ appFS: fakeAppFS({}), app: 'com.x', name: 'missing' })
    expect(out.ok).to.be.false
  })

  it('same content → same stamp; changed content → new stamp dir', async function () {
    const src = 'export async function handler () { return "a" }'
    const one = await materializeJobToCache({ appFS: fakeAppFS({ 'jobs/stable/index.mjs': src }), app: 'com.x', name: 'stable' })
    const two = await materializeJobToCache({ appFS: fakeAppFS({ 'jobs/stable/index.mjs': src }), app: 'com.x', name: 'stable' })
    expect(two.stamp).to.equal(one.stamp)
    const three = await materializeJobToCache({ appFS: fakeAppFS({ 'jobs/stable/index.mjs': src + ' // edited' }), app: 'com.x', name: 'stable' })
    expect(three.stamp).to.not.equal(one.stamp)
    expect((await readFile(join(tmp, 'com.x', 'stable.current'), 'utf8')).trim()).to.equal(three.stamp)
  })

  it('GC keeps only the current build and its immediate predecessor', async function () {
    const appFSv = (v) => fakeAppFS({ 'jobs/gcjob/index.mjs': 'export async function handler () { return ' + v + ' }' })
    const a = await materializeJobToCache({ appFS: appFSv(1), app: 'com.gc', name: 'gcjob' })
    const b = await materializeJobToCache({ appFS: appFSv(2), app: 'com.gc', name: 'gcjob' })
    const c = await materializeJobToCache({ appFS: appFSv(3), app: 'com.gc', name: 'gcjob' })
    const dirs = await stampDirsOf('com.gc', 'gcjob')
    expect(dirs).to.have.lengthOf(2)
    expect(dirs).to.include('gcjob@' + c.stamp)
    expect(dirs).to.include('gcjob@' + b.stamp)
    expect(dirs).to.not.include('gcjob@' + a.stamp)
  })

  it('GC removes a legacy unversioned dir but never a sibling job', async function () {
    await mkdir(join(tmp, 'com.legacy', 'oldjob'), { recursive: true })
    await writeFile(join(tmp, 'com.legacy', 'oldjob', 'index.mjs'), 'export async function handler () { return 0 }')
    await mkdir(join(tmp, 'com.legacy', 'oldjob_other'), { recursive: true })
    await materializeJobToCache({ appFS: fakeAppFS({ 'jobs/oldjob/index.mjs': 'export async function handler () { return 1 }' }), app: 'com.legacy', name: 'oldjob' })
    expect(await exists(join(tmp, 'com.legacy', 'oldjob'))).to.be.false
    expect(await exists(join(tmp, 'com.legacy', 'oldjob_other'))).to.be.true
  })
})

describe('localJobCache.removeLocalJobCache', function () {
  it('removes pointer, stamped dirs and legacy dir for the job only', async function () {
    await materializeJobToCache({ appFS: fakeAppFS({ 'jobs/gone/index.mjs': 'export async function handler () { return 1 }' }), app: 'com.rm', name: 'gone' })
    await materializeJobToCache({ appFS: fakeAppFS({ 'jobs/kept/index.mjs': 'export async function handler () { return 2 }' }), app: 'com.rm', name: 'kept' })
    await removeLocalJobCache('com.rm', 'gone')
    const left = await readdir(join(tmp, 'com.rm'))
    expect(left.filter(n => n.startsWith('gone'))).to.have.lengthOf(0)
    expect(left.some(n => n.startsWith('kept@'))).to.be.true
    expect(left).to.include('kept.current')
  })
})

describe('localJobRunner + stamped cache (stale-sibling regression)', function () {
  it('a re-materialized job reloads its SIBLING modules, not just index.mjs', async function () {
    // The original bug: ?v=<mtime> cache-busted index.mjs only — its static ./sib.js import
    // resolved query-less to an URL already in the ESM cache, so sibling edits never took effect
    // until a server restart. Stamped dirs give every file a fresh URL per content change.
    const { createLocalJobRunner } = await import('../../../adapters/jobs/localJobRunner.mjs')
    const runner = createLocalJobRunner({ jobsDir: tmp })
    const bundle = (val) => zipSync({
      'index.mjs': strToU8("import { VAL } from './sib.js'\nexport async function handler () { return VAL }"),
      'sib.js': strToU8("export const VAL = '" + val + "'")
    })
    await materializeJobToCache({ appFS: fakeAppFS({ 'jobs/sibs.zip': bundle('OLD') }), app: 'com.sib', name: 'sibs' })
    const first = await runner.run({ app: 'com.sib', name: 'sibs', token: 't' })
    expect(first.result).to.equal('OLD')
    await materializeJobToCache({ appFS: fakeAppFS({ 'jobs/sibs.zip': bundle('NEW') }), app: 'com.sib', name: 'sibs' })
    const second = await runner.run({ app: 'com.sib', name: 'sibs', token: 't' })
    expect(second.result).to.equal('NEW')
  })

  it('exists() and run() still work for a hand-placed legacy (unversioned) job', async function () {
    await mkdir(join(tmp, 'com.hand', 'devjob'), { recursive: true })
    await writeFile(join(tmp, 'com.hand', 'devjob', 'index.mjs'), 'export async function handler () { return 42 }')
    const { createLocalJobRunner } = await import('../../../adapters/jobs/localJobRunner.mjs')
    const runner = createLocalJobRunner({ jobsDir: tmp })
    expect(await runner.exists('com.hand', 'devjob')).to.be.true
    const out = await runner.run({ app: 'com.hand', name: 'devjob', token: 't' })
    expect(out.result).to.equal(42)
  })
})

describe('localJobCache.rematerializeTrustedJobs', function () {
  it('rebuilds each trusted job from the INSTALLING ADMIN appFS', async function () {
    const zip = zipSync({ 'index.mjs': strToU8('export async function handler () { return 9 }') })
    const adminApps = { admin1: fakeAppFS({ 'jobs/rebuilt.zip': zip }) }
    const dsManager = {
      async getorInitDb () { return { async query () { return [{ app_name: 'com.y', job_name: 'rebuilt', installed_by: 'admin1', trusted: true }] } } },
      async getOrSetUserDS (uid) { return { async getorInitAppFS () { return adminApps[uid] } } }
    }
    const out = await rematerializeTrustedJobs({ dsManager, freezrPrefs: {}, flogger: { info () {} } })
    expect(out).to.deep.include({ rebuilt: 1, failed: 0, total: 1 })
    expect(await exists(join(await currentDir('com.y', 'rebuilt'), 'index.mjs'))).to.be.true
  })

  it('counts a job with no installing-admin record as failed (not a crash)', async function () {
    const dsManager = {
      async getorInitDb () { return { async query () { return [{ app_name: 'com.z', job_name: 'orphan', trusted: true }] } } },
      async getOrSetUserDS () { throw new Error('should not be called') }
    }
    const out = await rematerializeTrustedJobs({ dsManager, freezrPrefs: {}, flogger: { info () {} } })
    expect(out).to.deep.include({ rebuilt: 0, failed: 1, total: 1 })
  })
})
