// Unit tests for the "changed job loses trust" flow (#3): trustJob stamps a code identity,
// disableTrustedJob turns trust off (getTrustedJob then returns null), and jobCodeIdentity is a
// stable content hash that changes only when the job's source changes.
import { expect } from 'chai'
import { trustJob, disableTrustedJob, getTrustedJob } from '../../../features/jobs/services/trustedJobService.mjs'
import { jobCodeIdentity } from '../../../features/jobs/services/cloudJobSource.mjs'

// Minimal in-memory trusted_jobs db (the subset the service uses).
function fakeTrustedDb () {
  let rows = []
  let n = 0
  return {
    _rows: () => rows,
    async query (q) { return rows.filter(r => Object.entries(q).every(([k, v]) => r[k] === v)) },
    async create (_id, rec) { const r = { ...rec, _id: 'r' + (++n) }; rows.push(r); return r },
    async update (id, patch, opts) {
      rows = rows.map(r => r._id === id ? (opts && opts.replaceAllFields ? { ...patch, _id: id } : { ...r, ...patch }) : r)
    },
    async delete_records (q) { const before = rows.length; rows = rows.filter(r => !Object.entries(q).every(([k, v]) => r[k] === v)); return { nRemoved: before - rows.length } }
  }
}

// appFS whose readAppFile returns text (for jobCodeIdentity, which reads index.mjs/package.json).
const fakeAppFS = (files) => ({
  async readAppFile (p) { if (!(p in files)) { const e = new Error('nope'); e.code = 'ENOENT'; throw e } return files[p] }
})

describe('#3 — trusted job loses trust when its code changes', function () {
  it('jobCodeIdentity is stable for the same code and changes when index.mjs changes', async function () {
    const v1 = await jobCodeIdentity(fakeAppFS({ 'jobs/inc/index.mjs': 'step = 1' }), 'inc')
    const v1b = await jobCodeIdentity(fakeAppFS({ 'jobs/inc/index.mjs': 'step = 1' }), 'inc')
    const v2 = await jobCodeIdentity(fakeAppFS({ 'jobs/inc/index.mjs': 'step = 2' }), 'inc')
    expect(v1).to.equal(v1b) // deterministic
    expect(v1).to.not.equal(v2) // sensitive to a code change
    expect(await jobCodeIdentity(fakeAppFS({}), 'inc')).to.equal(null) // no code → null
  })

  it('trustJob stamps code_id; disableTrustedJob turns trust OFF without deleting the record', async function () {
    const db = fakeTrustedDb()
    await trustJob(db, { appName: 'com.x', jobName: 'inc', audience: 'all_users', installedBy: 'admin1', codeId: 'aaa111' })
    expect(await getTrustedJob(db, 'com.x', 'inc')).to.include({ code_id: 'aaa111', trusted: true })

    const r = await disableTrustedJob(db, 'com.x', 'inc', 'code_changed')
    expect(r.disabled).to.equal(1)
    expect(await getTrustedJob(db, 'com.x', 'inc'), 'disabled → gate sees untrusted').to.equal(null)
    // record still there (so the admin page can show "needs re-trust"), just trusted:false
    const raw = db._rows()[0]
    expect(raw.trusted).to.equal(false)
    expect(raw.disabled_reason).to.equal('code_changed')
    expect(raw.audience).to.equal('all_users') // preserved for re-trust
  })

  it('re-trust re-enables and updates the code identity', async function () {
    const db = fakeTrustedDb()
    await trustJob(db, { appName: 'com.x', jobName: 'inc', installedBy: 'admin1', codeId: 'old' })
    await disableTrustedJob(db, 'com.x', 'inc', 'code_changed')
    await trustJob(db, { appName: 'com.x', jobName: 'inc', installedBy: 'admin1', codeId: 'new' })
    const rec = await getTrustedJob(db, 'com.x', 'inc')
    expect(rec.trusted).to.equal(true)
    expect(rec.code_id).to.equal('new')
    expect(rec.disabled_reason).to.equal(null)
  })
})
