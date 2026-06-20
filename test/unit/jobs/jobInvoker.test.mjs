// Unit tests for invokeJob's location branching incl. the cloud path (Phase 6.6) — no AWS, no server.
// All collaborators are injected as fakes: trust db, resources db, local runner, cloud runner.
import { expect } from 'chai'
import { invokeJob } from '../../../features/jobs/services/jobInvoker.mjs'

const trustedDb = (trusted = true, audience = 'all_users') => ({
  async query (q) { return trusted ? [{ app_name: q.app_name, job_name: q.job_name, audience, trusted: true }] : [] }
})
const computeDb = (has = true) => ({
  async query (q) {
    if (q.type !== 'compute') return []
    return has ? [{ type: 'compute', provider: 'aws', region: 'eu-central-1', secret: { accessKeyId: 'A', secretAccessKey: 'B', arnRole: 'arn:role' } }] : []
  }
})
const localRunner = ({ exists = true, runOut = { ok: true, result: { local: true }, durationMs: 3 } } = {}) => ({
  async exists () { return exists },
  async run () { return runOut }
})
const base = { appTokenDb: {}, ownerApp: 'com.example.incrementer', jobName: 'increment', userId: 'salman', token: 'pretok' }

describe('invokeJob — location branching', function () {
  it('runs LOCAL when admin-trusted (audience allows), returns location:local', async function () {
    const out = await invokeJob({ ...base, trustedJobsDb: trustedDb(true), localRunner: localRunner(), hint: 'auto' })
    expect(out.ok).to.be.true
    expect(out.location).to.equal('local')
    expect(out.result).to.deep.equal({ local: true })
  })

  it('is notRunnable when neither local-trusted nor a compute credential exists', async function () {
    const out = await invokeJob({ ...base, trustedJobsDb: trustedDb(false), resourcesDb: computeDb(false), localRunner: localRunner(), hint: 'auto' })
    expect(out.ok).to.be.false
    expect(out.notRunnable).to.be.true
  })

  it('is notRunnable (not a crash) when the code is missing on the host', async function () {
    const out = await invokeJob({ ...base, trustedJobsDb: trustedDb(true), localRunner: localRunner({ exists: false }) })
    expect(out.ok).to.be.false
    expect(out.notRunnable).to.be.true
    expect(out.error).to.match(/not installed/)
  })

  it("hint:'cloud' runs on the cloud runner when the user has a compute credential", async function () {
    let invokedWith = null
    const fakeRunner = {
      invoke: async (args) => { invokedWith = args; return { ok: true, result: { cloud: true }, durationMs: 9, usage: { billedMs: 100, memoryMb: 128, estCost: 0.0000002, currency: 'USD' } } }
    }
    const usageRows = []
    const out = await invokeJob({
      ...base,
      hint: 'cloud',
      trustedJobsDb: trustedDb(false),
      resourcesDb: computeDb(true),
      resourceUsageDb: { async create (_id, row) { usageRows.push(row); return { _id: 'u1' } } },
      baseUrl: 'https://my.freezr',
      localRunner: localRunner(),
      makeCloudRunner: ({ credentials }) => { expect(credentials.accessKeyId).to.equal('A'); return fakeRunner }
    })
    expect(out.ok, JSON.stringify(out)).to.be.true
    expect(out.location).to.equal('cloud')
    expect(out.result).to.deep.equal({ cloud: true })
    // the cloud runner was handed the run essentials (capability model)
    expect(invokedWith.baseUrl).to.equal('https://my.freezr')
    expect(invokedWith.token).to.equal('pretok')
    expect(invokedWith.ownerId).to.equal('salman')
    expect(invokedWith.app).to.equal('com.example.incrementer')
    // a resourceUsage row was written from the returned cost
    expect(usageRows).to.have.length(1)
    expect(usageRows[0].resource).to.equal('serverless_job')
    expect(usageRows[0].estCost).to.equal(0.0000002)
  })

  it("hint:'cloud' now runs WITHOUT a callback URL (passes it through; a job may not call freezr)", async function () {
    let captured
    const fakeRunner = { invoke: async (args) => { captured = args; return { ok: true, result: {}, durationMs: 1, usage: {} } } }
    const out = await invokeJob({ ...base, hint: 'cloud', trustedJobsDb: trustedDb(false), resourcesDb: computeDb(true), localRunner: localRunner(), baseUrl: null, makeCloudRunner: () => fakeRunner })
    expect(out.ok, JSON.stringify(out)).to.be.true
    expect(out.location).to.equal('cloud')
    expect(captured.baseUrl).to.equal(null)
  })

  it('CLOUD runs from the user-app source even when NOT admin-trusted (no users_jobs copy)', async function () {
    let captured
    const fakeRunner = { invoke: async (args) => { captured = args; return { ok: true, result: { cloud: true }, durationMs: 1, usage: {} } } }
    const out = await invokeJob({
      ...base, hint: 'cloud',
      trustedJobsDb: trustedDb(false),               // NOT admin-trusted
      resourcesDb: computeDb(true),
      localRunner: localRunner({ exists: false }),    // NOT in users_jobs
      baseUrl: 'https://my.freezr',
      loadCloudSource: async () => ({ source: 'export async function handler () { return 1 }' }),
      makeCloudRunner: () => fakeRunner
    })
    expect(out.ok, JSON.stringify(out)).to.be.true
    expect(out.location).to.equal('cloud')
    expect(captured.handlerSource, 'the user-app source is handed to the runner').to.match(/export async function handler/)
  })

  it('CLOUD prefers the pre-built per-job ZIP (Tier-2) from the user app over a single file', async function () {
    let captured
    const fakeRunner = { invoke: async (args) => { captured = args; return { ok: true, result: { cloud: true }, durationMs: 1, usage: {} } } }
    const fakeZip = new Uint8Array([1, 2, 3]) // opaque to invokeJob — it just forwards it
    const out = await invokeJob({
      ...base, hint: 'cloud',
      trustedJobsDb: trustedDb(false),
      resourcesDb: computeDb(true),
      localRunner: localRunner({ exists: false }),
      baseUrl: 'https://my.freezr',
      loadCloudSource: async () => ({ zip: fakeZip }),
      makeCloudRunner: () => fakeRunner
    })
    expect(out.ok, JSON.stringify(out)).to.be.true
    expect(captured.jobZip, 'the per-job zip is handed to the runner').to.equal(fakeZip)
    expect(captured.handlerSource).to.equal(null)
  })

  it('CLOUD is notRunnable when there is neither app source nor a trusted copy', async function () {
    const out = await invokeJob({
      ...base, hint: 'cloud',
      trustedJobsDb: trustedDb(false),
      resourcesDb: computeDb(true),
      localRunner: localRunner({ exists: false }),
      baseUrl: 'https://my.freezr',
      loadCloudSource: async () => null,
      makeCloudRunner: () => ({ invoke: async () => ({ ok: true }) })
    })
    expect(out.ok).to.be.false
    expect(out.notRunnable).to.be.true
    expect(out.error).to.match(/job code not found/)
  })

  it('CLOUD selects the runner by the credential provider — unsupported provider → clean notRunnable', async function () {
    // No makeCloudRunner injected → the real registry dispatcher runs; a 'gcp' credential has no runner
    // yet, so construction throws and invokeJob must surface a structured notRunnable (never crash).
    const out = await invokeJob({
      ...base, hint: 'cloud',
      trustedJobsDb: trustedDb(false),
      resourcesDb: { async query (q) { return q.type === 'compute' ? [{ type: 'compute', provider: 'gcp', region: 'x', secret: { accessKeyId: 'A', secretAccessKey: 'B' } }] : [] } },
      localRunner: localRunner(),
      baseUrl: 'https://my.freezr',
      loadCloudSource: async () => ({ source: 'export async function handler () { return 1 }' })
    })
    expect(out.ok).to.be.false
    expect(out.notRunnable).to.be.true
    expect(out.location).to.equal('cloud')
    expect(out.error).to.match(/no cloud job runner for provider "gcp"/)
  })

  it("hint:'cloud' is notRunnable when the user has no compute credential (gate)", async function () {
    const out = await invokeJob({ ...base, hint: 'cloud', trustedJobsDb: trustedDb(false), resourcesDb: computeDb(false), localRunner: localRunner(), baseUrl: 'https://my.freezr' })
    expect(out.ok).to.be.false
    expect(out.notRunnable).to.be.true
  })

  it("'auto' prefers LOCAL even when a compute credential also exists", async function () {
    const out = await invokeJob({ ...base, hint: 'auto', trustedJobsDb: trustedDb(true), resourcesDb: computeDb(true), localRunner: localRunner(), baseUrl: 'https://my.freezr' })
    expect(out.location).to.equal('local')
  })

  it("'auto' falls back to CLOUD when not locally trusted but a compute credential exists", async function () {
    const fakeRunner = { invoke: async () => ({ ok: true, result: { cloud: true }, durationMs: 1, usage: {} }) }
    const out = await invokeJob({ ...base, hint: 'auto', trustedJobsDb: trustedDb(false), resourcesDb: computeDb(true), localRunner: localRunner(), baseUrl: 'https://my.freezr', makeCloudRunner: () => fakeRunner })
    expect(out.ok).to.be.true
    expect(out.location).to.equal('cloud')
  })

  it('NEVER throws — an unexpected collaborator error becomes a structured JOB_ERROR', async function () {
    const blowsUp = { async query () { throw new Error('db blew up') } }
    const out = await invokeJob({ ...base, trustedJobsDb: blowsUp, localRunner: localRunner() })
    expect(out.ok).to.be.false
    expect(out.errorCode).to.equal('JOB_ERROR')
    expect(out.error).to.match(/db blew up/)
  })

  it('propagates a cloud run failure as ok:false with location:cloud (clean message)', async function () {
    const fakeRunner = { invoke: async () => ({ ok: false, error: 'freezr callback fetch failed (ECONNREFUSED) → https://my.freezr/ceps/write/..', errorCode: 'Unhandled', durationMs: 5, usage: {} }) }
    const out = await invokeJob({ ...base, hint: 'cloud', trustedJobsDb: trustedDb(false), resourcesDb: computeDb(true), localRunner: localRunner(), baseUrl: 'https://my.freezr', makeCloudRunner: () => fakeRunner })
    expect(out.ok).to.be.false
    expect(out.location).to.equal('cloud')
    expect(out.error).to.match(/callback fetch failed/)
  })

  // Deploy-identity marker: a freezr/job-code change re-ships the function; an unchanged run skips it
  // (no manual Lambda delete needed). identity is computed from the real freezr files + the injected
  // identity source, and stamped via writeDeployedId — so we assert RELATIVE behaviour (load counts).
  it('CLOUD redeploys on first run + identity change, SKIPS the bundle when unchanged', async function () {
    let marker = null
    let loads = 0
    const invokes = []
    const fakeRunner = {
      exists: async () => true, // the function already exists — so only the marker decides redeploy
      invoke: async (a) => { invokes.push(a.redeploy); return { ok: true, result: {}, durationMs: 1, usage: {} } }
    }
    const common = {
      ...base, hint: 'cloud', trustedJobsDb: trustedDb(false), resourcesDb: computeDb(true),
      localRunner: localRunner(), baseUrl: 'https://f',
      loadCloudSource: async () => { loads++; return { source: 'export async function handler () { return 1 }' } },
      readDeployedId: async () => marker,
      writeDeployedId: async (id) => { marker = id },
      loadIdentitySource: async () => 'IDSRC-A',
      makeCloudRunner: () => fakeRunner
    }
    // 1) first run: no marker → deploy (load once), marker now stamped
    let out = await invokeJob(common)
    expect(out.ok, JSON.stringify(out)).to.be.true
    expect(loads).to.equal(1)
    expect(invokes[0]).to.be.true // ran a (re)deploy
    expect(marker).to.be.a('string')
    // 2) second run, same identity → SKIP the bundle entirely (no extra load), invoke without redeploy
    out = await invokeJob(common)
    expect(out.ok).to.be.true
    expect(loads, 'unchanged identity must not re-read the bundle').to.equal(1)
    expect(invokes[1]).to.be.false
    // 3) identity changes (job code/deps edited) → redeploy again
    out = await invokeJob({ ...common, loadIdentitySource: async () => 'IDSRC-B' })
    expect(out.ok).to.be.true
    expect(loads, 'a changed identity must re-ship the bundle').to.equal(2)
    expect(invokes[2]).to.be.true
  })

  it('CLOUD deploys when the function is ABSENT even if a (stale) marker matches', async function () {
    let loads = 0
    const fakeRunner = { exists: async () => false, invoke: async () => { return { ok: true, result: {}, durationMs: 1, usage: {} } } }
    const out = await invokeJob({
      ...base, hint: 'cloud', trustedJobsDb: trustedDb(false), resourcesDb: computeDb(true),
      localRunner: localRunner(), baseUrl: 'https://f',
      loadCloudSource: async () => { loads++; return { source: 'export async function handler () { return 1 }' } },
      readDeployedId: async () => 'whatever-matches-nothing-real',
      loadIdentitySource: async () => 'IDSRC-A',
      makeCloudRunner: () => fakeRunner
    })
    expect(out.ok).to.be.true
    expect(loads, 'absent function must deploy regardless of the marker').to.equal(1)
  })
})
