// Unit tests for the users_jobs local-cache materialization (rebuilt from the ADMIN's appFS).
import { expect } from 'chai'
import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'

let tmp
let materializeJobToCache, rematerializeTrustedJobs

before(async function () {
  tmp = await mkdtemp(join(tmpdir(), 'freezr-usersjobs-'))
  process.env.FREEZR_JOBS_DIR = tmp // jobsBaseDir() reads this at call time
  const mod = await import('../../../features/jobs/services/localJobCache.mjs')
  materializeJobToCache = mod.materializeJobToCache
  rematerializeTrustedJobs = mod.rematerializeTrustedJobs
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

describe('localJobCache.materializeJobToCache', function () {
  it('unzips a full bundle (incl. node_modules) into users_jobs', async function () {
    const zip = zipSync({
      'index.mjs': strToU8('export async function handler () { return 1 }'),
      'package.json': strToU8('{"name":"x"}'),
      'node_modules/dep/index.js': strToU8('module.exports = 1')
    })
    const out = await materializeJobToCache({ appFS: fakeAppFS({ 'jobs/doit.zip': zip }), app: 'com.x', name: 'doit' })
    expect(out).to.deep.include({ ok: true, usedZip: true })
    expect(await exists(join(tmp, 'com.x', 'doit', 'index.mjs'))).to.be.true
    expect(await exists(join(tmp, 'com.x', 'doit', 'node_modules', 'dep', 'index.js'))).to.be.true
    expect(await readFile(join(tmp, 'com.x', 'doit', 'index.mjs'), 'utf8')).to.match(/export async function handler/)
  })

  it('writes single-file index.mjs when only source is available (Tier-1)', async function () {
    const out = await materializeJobToCache({ appFS: fakeAppFS({ 'jobs/solo/index.mjs': 'export async function handler () { return 2 }' }), app: 'com.x', name: 'solo' })
    expect(out).to.deep.include({ ok: true, usedZip: false, files: 1 })
    expect(await readFile(join(tmp, 'com.x', 'solo', 'index.mjs'), 'utf8')).to.match(/return 2/)
  })

  it('returns ok:false when the admin appFS has no usable code', async function () {
    const out = await materializeJobToCache({ appFS: fakeAppFS({}), app: 'com.x', name: 'missing' })
    expect(out.ok).to.be.false
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
    expect(await exists(join(tmp, 'com.y', 'rebuilt', 'index.mjs'))).to.be.true
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
