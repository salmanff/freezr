/**
 * Jobs — in-process API client integration test (Phase 1 vertical slice)
 *
 * Proves that adapters/jobs/internalApiClient.mjs can replay the real CEPS
 * middleware + controllers in-process and do a write → read → query round-trip
 * using an offline app token, AND that the result agrees with the normal HTTP
 * /ceps path.
 *
 * Driven over HTTP exactly like the CEPS tests: a running server (npm run devtest,
 * FREEZR_TEST_MODE=true) exposes PUT /jobs/selftest/inprocess, which runs the
 * in-process client server-side and returns what it captured.
 *
 * Prerequisites (same as CEPS tests):
 *   1. Server running on the configured URL with FREEZR_TEST_MODE=true (npm run devtest)
 *   2. Test users exist (users_freezr/test_credentials/testUserCreds.json)
 *   3. Run with: npm run test:jobs
 */

import { expect } from 'chai'
import { mkdir, writeFile, rm, cp } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createAuthenticatedHelper, loadTestCredentials, TestAuthHelper } from '../ceps/testAuthHelper.mjs'
import { assembleJobBundle } from '../../../adapters/jobs/serverlessBundle.mjs'

// Allow pointing the test at an alternate server (e.g. a second devtest instance on
// another port that shares the same DB) without editing the creds file.
const SERVER_URL_OVERRIDE = process.env.FREEZR_TEST_SERVER_URL || null

let appTable
let creds

try {
  creds = loadTestCredentials()
  appTable = creds.testAppConfig.appTable
} catch (error) {
  console.error('Failed to load test credentials:', error.message)
  process.exit(1)
}

// Build an authenticated helper, honoring the server-URL override when set.
async function authFor (userKey = 'primary') {
  if (!SERVER_URL_OVERRIDE) return createAuthenticatedHelper(userKey)
  const user = creds.users[userKey]
  const appName = creds.testAppConfig.appName
  const auth = new TestAuthHelper(SERVER_URL_OVERRIDE)
  const result = await auth.loginAndSetupApp(user.user_id, user.password, appName)
  if (!result.success) throw new Error('auth setup failed: ' + (result.error || JSON.stringify(result)))
  return auth
}

describe('Jobs in-process API client (write → read → query)', function () {
  this.timeout(15000)

  let auth

  before(async function () {
    try {
      auth = await authFor('primary')
    } catch (error) {
      console.error('\n⚠️  Could not authenticate. Is the server running with `npm run devtest`?\n', error.message)
      throw error
    }
  })

  it('writes, reads and queries a record in-process and returns _id + data', async function () {
    const stamp = 's' + Date.now()
    const res = await auth.put('/jobs/selftest/inprocess', {
      app_table: appTable, stamp, val: 7, msg: 'hello-from-job'
    })

    expect(res.status, JSON.stringify(res.data)).to.equal(200)
    expect(res.ok).to.be.true
    expect(res.data).to.be.an('object')

    // write captured an _id
    expect(res.data.written).to.be.an('object')
    expect(res.data.written._id).to.exist

    // read returned the same record with our payload
    expect(res.data.read).to.be.an('object')
    expect(res.data.read._id).to.equal(res.data.written._id)
    expect(res.data.read.val).to.equal(7)
    expect(res.data.read.msg).to.equal('hello-from-job')
    expect(res.data.read.stamp).to.equal(stamp)

    // query found exactly the record we just wrote (stamp is unique per run)
    expect(res.data.queried).to.be.an('array')
    const found = res.data.queried.find(r => r._id === res.data.written._id)
    expect(found, 'written record should be returned by in-process query').to.exist
    expect(found.stamp).to.equal(stamp)
  })

  it('agrees with the HTTP /ceps path: a record written in-process is readable over HTTP', async function () {
    const stamp = 's' + Date.now() + '-x'
    const res = await auth.put('/jobs/selftest/inprocess', {
      app_table: appTable, stamp, val: 99, msg: 'cross-check'
    })
    expect(res.status, JSON.stringify(res.data)).to.equal(200)
    const id = res.data.written._id

    // Read the same record back through the ordinary HTTP CEPS route.
    const httpRead = await auth.get(`/ceps/read/${appTable}/${id}`)
    expect(httpRead.status, JSON.stringify(httpRead.data)).to.equal(200)
    expect(httpRead.data._id).to.equal(id)
    expect(httpRead.data.val).to.equal(99)
    expect(httpRead.data.msg).to.equal('cross-check')
    expect(httpRead.data.stamp).to.equal(stamp)
  })

  // NOTE: the bundled-client + handler path is now covered end-to-end by the run-now suite
  // below (it loads a real job file and runs handler(freezr, params) through createJobFreezrClient),
  // so the dedicated selftest/handler endpoint + test were removed as redundant.

  it('rejects an unauthenticated call (no token)', async function () {
    const bare = await authFor('primary')
    // wipe the token to simulate no auth
    bare.appTokens = {}
    const res = await bare.put('/jobs/selftest/inprocess', { app_table: appTable, stamp: 'noauth' })
    expect(res.ok).to.be.false
    expect(res.status).to.be.oneOf([401, 400])
  })
})

describe('Jobs run-now (local executor loads a job by convention)', function () {
  this.timeout(15000)

  // app name = the test app; job lives at users_jobs/<app>/<jobName>/index.mjs
  const appName = creds.testAppConfig.appName
  const jobName = '__jobs_test_runnow__'
  const collection = appTable.split('.').pop() // 'table1' — exercises buildAppTable(appName + '.' + collection)
  const jobDir = join(process.cwd(), 'users_jobs', appName, jobName)

  // A Tier-1 job (no deps): one file exporting handler(freezr, params).
  const JOB_SRC = [
    'export async function handler (freezr, params) {',
    "  const written = await freezr.create('" + collection + "', { _job: true, stamp: params.stamp, val: params.val })",
    "  const queried = await freezr.query('" + collection + "', { stamp: params.stamp })",
    '  return { writtenId: written._id, count: queried.length, stamp: params.stamp }',
    '}',
    ''
  ].join('\n')

  let auth

  before(async function () {
    if (SERVER_URL_OVERRIDE) {
      // sanity: this test writes the job under the repo's users_jobs and relies on the
      // server resolving the same path (default DEFAULT_JOBS_DIR = repo/users_jobs).
    }
    await mkdir(jobDir, { recursive: true })
    await writeFile(join(jobDir, 'index.mjs'), JOB_SRC, 'utf8')
    auth = await authFor('primary')
  })

  after(async function () {
    // remove the trust record so the untrusted-negative test is reliable across runs
    await auth.delete('/jobs/selftest/trust/' + jobName).catch(() => {})
    await rm(join(process.cwd(), 'users_jobs', appName, jobName), { recursive: true, force: true })
  })

  it('refuses to run an untrusted job (403)', async function () {
    const res = await auth.post('/jobs/run/__untrusted_' + Date.now() + '__', { params: {} })
    expect(res.ok).to.be.false
    expect(res.status).to.equal(403)
  })

  it('runs the job once an admin has trusted it (audience all_users), returns its output', async function () {
    // Trust the job (test helper; real flow is the admin Trusted Jobs page).
    const t = await auth.put('/jobs/selftest/trust/' + jobName, { audience: 'all_users' })
    expect(t.status, JSON.stringify(t.data)).to.equal(200)

    const stamp = 'rn' + Date.now()
    const res = await auth.post('/jobs/run/' + jobName, { params: { stamp, val: 33 } })

    expect(res.status, JSON.stringify(res.data)).to.equal(200)
    expect(res.data.ok, JSON.stringify(res.data)).to.be.true
    expect(res.data.result).to.be.an('object')
    expect(res.data.result.writtenId).to.exist
    expect(res.data.result.count).to.be.at.least(1)
    expect(res.data.result.stamp).to.equal(stamp)
    expect(res.data.durationMs).to.be.a('number')

    // The handler's freezr.create really wrote via the in-process client — confirm over HTTP.
    const httpRead = await auth.get(`/ceps/read/${appTable}/${res.data.result.writtenId}`)
    expect(httpRead.status).to.equal(200)
    expect(httpRead.data.val).to.equal(33)
    expect(httpRead.data._job).to.equal(true)
  })

  it('403s a job that does not exist and is not trusted', async function () {
    const res = await auth.post('/jobs/run/__no_such_job__', { params: {} })
    expect(res.ok).to.be.false
    // trust gate runs before the existence check, so an untrusted unknown job is 403 (no existence leak)
    expect(res.status).to.equal(403)
  })
})

describe('Jobs run-now error scaffolding (a failed job → standard error)', function () {
  this.timeout(15000)

  const appName = creds.testAppConfig.appName
  const jobName = '__jobs_test_fails__'
  const jobDir = join(process.cwd(), 'users_jobs', appName, jobName)
  // A job whose handler throws (stand-in for "the write failed" inside the handler).
  const JOB_SRC = "export async function handler () { throw new Error('the write failed') }\n"

  let auth

  before(async function () {
    await mkdir(jobDir, { recursive: true })
    await writeFile(join(jobDir, 'index.mjs'), JOB_SRC, 'utf8')
    auth = await authFor('primary')
    await auth.put('/jobs/selftest/trust/' + jobName, { audience: 'all_users' })
  })

  after(async function () {
    await auth.delete('/jobs/selftest/trust/' + jobName).catch(() => {})
    await rm(jobDir, { recursive: true, force: true })
  })

  it('returns a standard error response (not a 200 ok:false envelope) carrying the failure message', async function () {
    const res = await auth.post('/jobs/run/' + jobName, { params: {} })
    expect(res.ok, JSON.stringify(res.data)).to.be.false
    expect(res.status).to.equal(500) // local job failure
    expect(res.data.success).to.equal(false)
    expect(String(res.data.error)).to.match(/the write failed/)
  })
})

describe('Jobs composition — a job can run another job, bounded by maxRuntime', function () {
  this.timeout(20000)

  const appName = creds.testAppConfig.appName
  const outer = '__jobs_test_outer__'
  const inner = '__jobs_test_inner__'
  const sleeper = '__jobs_test_sleeper__'
  const dir = (n) => join(process.cwd(), 'users_jobs', appName, n)

  const INNER_SRC = ['export async function handler (freezr, params) {', '  return { fromInner: true, got: params.x }', '}', ''].join('\n')
  const OUTER_SRC = [
    'export async function handler (freezr, params) {',
    '  const r = await freezr.jobs.run("' + inner + '", { x: params.x })',
    '  return { innerOk: r.ok, innerVal: r.result }',
    '}', ''
  ].join('\n')
  const SLEEPER_SRC = ['export async function handler () { await new Promise(r => setTimeout(r, 5000)); return { slept: true } }', ''].join('\n')

  let auth
  before(async function () {
    for (const [n, src] of [[outer, OUTER_SRC], [inner, INNER_SRC], [sleeper, SLEEPER_SRC]]) {
      await mkdir(dir(n), { recursive: true })
      await writeFile(join(dir(n), 'index.mjs'), src, 'utf8')
    }
    auth = await authFor('primary')
    for (const n of [outer, inner, sleeper]) await auth.put('/jobs/selftest/trust/' + n, { audience: 'all_users' })
  })
  after(async function () {
    for (const n of [outer, inner, sleeper]) {
      await auth.delete('/jobs/selftest/trust/' + n).catch(() => {})
      await rm(dir(n), { recursive: true, force: true })
    }
  })

  it('a job runs another job (freezr.jobs.run) and receives its result', async function () {
    const res = await auth.post('/jobs/run/' + outer, { params: { x: 42 } })
    expect(res.status, JSON.stringify(res.data)).to.equal(200)
    expect(res.data.ok, JSON.stringify(res.data)).to.be.true
    expect(res.data.result.innerOk).to.be.true
    expect(res.data.result.innerVal).to.deep.equal({ fromInner: true, got: 42 })
  })

  it('a job is bounded by its maxRuntime (so each composition level is too)', async function () {
    const t0 = Date.now()
    const res = await auth.post('/jobs/run/' + sleeper, { maxRuntime: '500ms' })
    const elapsed = Date.now() - t0
    expect(res.ok, JSON.stringify(res.data)).to.be.false // ran past its limit → standard error
    expect(elapsed, 'should be cut at ~maxRuntime, not the 5s sleep').to.be.lessThan(3000)
  })
})

describe('Jobs LLM-from-a-job plumbing (streaming-capable client shim)', function () {
  this.timeout(15000)

  // Proves the streaming fix: freezr.llm.ask from inside a job no longer crashes on
  // response.body.getReader() (the browser client always reads the LLM response as an SSE stream).
  // Works without an LLM key — it exercises the plumbing up to the permission gate.
  const appName = creds.testAppConfig.appName
  const jobName = '__jobs_test_llm__'
  const jobDir = join(process.cwd(), 'users_jobs', appName, jobName)
  const JOB_SRC = [
    'export async function handler (freezr) {',
    '  try {',
    "    const r = await freezr.llm.ask('hello')",
    '    return { called: true, llmOk: !!(r && r.success) }',
    '  } catch (e) {',
    '    return { called: true, llmError: e.message || String(e), llmStatus: e.status || null }',
    '  }',
    '}',
    ''
  ].join('\n')

  let auth
  before(async function () {
    await mkdir(jobDir, { recursive: true })
    await writeFile(join(jobDir, 'index.mjs'), JOB_SRC, 'utf8')
    auth = await authFor('primary')
    await auth.put('/jobs/selftest/trust/' + jobName, { audience: 'all_users' })
  })
  after(async function () {
    await auth.delete('/jobs/selftest/trust/' + jobName).catch(() => {})
    await rm(jobDir, { recursive: true, force: true })
  })

  it('captures a STREAMED (SSE) route through the in-process client — no socket crash', async function () {
    // Regression for the llm-in-a-job crash: an SSE route (flushHeaders + res.write + res.end) run
    // via the in-process client must be CAPTURED, not hit the real ServerResponse (outputData.push).
    const res = await auth.post('/jobs/selftest/sse_via_inprocess', {})
    expect(res.status, JSON.stringify(res.data)).to.equal(200)
    expect(res.data.ok).to.be.true
    expect(res.data.status).to.equal(200)
    expect(res.data.bodyText, 'streamed SSE body should be captured').to.include('"type":"done"')
    expect(res.data.bodyText).to.include('"type":"delta"')
  })

  it('captures a LONG multi-chunk SSE response intact (no truncation by length)', async function () {
    const res = await auth.post('/jobs/selftest/sse_via_inprocess', { chunks: 300 })
    expect(res.status, JSON.stringify(res.data && { ok: res.data.ok, status: res.data.status })).to.equal(200)
    expect(res.data.ok).to.be.true
    const body = res.data.bodyText || ''
    expect(body).to.include('"type":"done"')      // the final event survived
    expect(body).to.include('piece0-')             // first delta
    expect(body).to.include('piece299-')           // last delta — nothing dropped in the middle
    expect(body.length, 'a 300-chunk response is many KB').to.be.greaterThan(15000)
  })

  it('reaches the LLM endpoint through the streaming shim (no body/getReader crash)', async function () {
    const res = await auth.post('/jobs/run/' + jobName, { params: {} })
    expect(res.status, JSON.stringify(res.data)).to.equal(200)
    expect(res.data.ok, JSON.stringify(res.data)).to.be.true
    const r = res.data.result
    expect(r.called).to.be.true
    // Either it succeeded (if an LLM key is configured) or it surfaced a CLEAN API error
    // (e.g. 403 no use_llm) — NOT the old "cannot read getReader of undefined" TypeError.
    if (r.llmError) {
      expect(r.llmError, r.llmError).to.not.match(/getReader|reading .*body|undefined/i)
    }
  })
})

describe('Jobs session-less token provisioning (Phase 4)', function () {
  this.timeout(15000)

  const appName = creds.testAppConfig.appName
  const jobName = '__jobs_test_sessionless__'
  const collection = appTable.split('.').pop()
  const jobDir = join(process.cwd(), 'users_jobs', appName, jobName)

  const JOB_SRC = [
    'export async function handler (freezr, params) {',
    "  const written = await freezr.create('" + collection + "', { _job: true, stamp: params.stamp, val: params.val })",
    '  return { writtenId: written._id, stamp: params.stamp }',
    '}',
    ''
  ].join('\n')

  let auth

  before(async function () {
    await mkdir(jobDir, { recursive: true })
    await writeFile(join(jobDir, 'index.mjs'), JOB_SRC, 'utf8')
    auth = await authFor('primary')
  })

  after(async function () {
    await rm(jobDir, { recursive: true, force: true })
  })

  it('mints a fresh session-less job token and runs the job with it', async function () {
    const stamp = 'sl' + Date.now()
    const res = await auth.post('/jobs/selftest/sessionless/' + jobName, { params: { stamp, val: 44 } })

    expect(res.status, JSON.stringify(res.data)).to.equal(200)
    expect(res.data.ok, JSON.stringify(res.data)).to.be.true
    expect(res.data.result.writtenId).to.exist
    expect(res.data.result.stamp).to.equal(stamp)
    // The run used a freshly minted job token, distinct from the caller's token, with no session.
    expect(res.data.tokenType).to.equal('job')
    expect(res.data.mintedTokenDiffersFromCaller).to.be.true

    // The write really happened via the session-less token — confirm over HTTP.
    const httpRead = await auth.get(`/ceps/read/${appTable}/${res.data.result.writtenId}`)
    expect(httpRead.status).to.equal(200)
    expect(httpRead.data.val).to.equal(44)
  })
})

describe('Jobs cross-app invocation (<app>.jobs.<name>) (§14)', function () {
  this.timeout(15000)

  // The CALLER is the test app (com.salmanff.apitester); the OWNER is a different app whose
  // trusted job the caller invokes WITHOUT holding a copy of it.
  const ownerApp = 'com.test.jobowner'
  const jobName = 'sharedinc'
  const qualifiedId = ownerApp + '.jobs.' + jobName
  const ownerJobDir = join(process.cwd(), 'users_jobs', ownerApp, jobName)

  // The owner's job increments the OWNER's own counter (owner-context).
  const JOB_SRC = [
    'export async function handler (freezr, params) {',
    "  const rows = await freezr.query('counters', { name: 'main' })",
    '  const existing = rows && rows[0]',
    "  if (existing) { const value = (existing.value || 0) + 1; await freezr.update('counters', existing._id, { name: 'main', value }); return { value, _id: existing._id } }",
    "  const created = await freezr.create('counters', { name: 'main', value: 1 })",
    '  return { value: 1, _id: created && created._id }',
    '}',
    ''
  ].join('\n')

  let auth

  before(async function () {
    await mkdir(ownerJobDir, { recursive: true })
    await writeFile(join(ownerJobDir, 'index.mjs'), JOB_SRC, 'utf8')
    auth = await authFor('primary')
    // Admin trusts the OWNER app's job (audience all_users) — same record the owner app would use.
    await auth.put('/jobs/selftest/trust/' + jobName, { app_name: ownerApp, audience: 'all_users' })
  })

  after(async function () {
    await auth.delete('/jobs/selftest/trust/' + jobName + '?app_name=' + ownerApp).catch(() => {})
    await rm(ownerJobDir, { recursive: true, force: true })
  })

  it('403s a third-party job the caller has not been granted run_job for', async function () {
    // never-granted id → blocked regardless of trust
    const res = await auth.post('/jobs/run/' + ownerApp + '.jobs.nevergranted', { params: {} })
    expect(res.ok).to.be.false
    expect(res.status).to.equal(403)
  })

  it("runs another app's trusted job once granted run_job for it (job runs as the owner)", async function () {
    await auth.put('/jobs/selftest/grant/' + qualifiedId, {})

    const res1 = await auth.post('/jobs/run/' + qualifiedId, { params: {} })
    expect(res1.status, JSON.stringify(res1.data)).to.equal(200)
    expect(res1.data.ok, JSON.stringify(res1.data)).to.be.true
    expect(res1.data.result.value).to.be.at.least(1)

    // Run again: the owner's counter must advance by 1 — proving the job really persisted to the
    // OWNER app's DB (owner-context) across calls, even though the caller app cannot read it.
    const res2 = await auth.post('/jobs/run/' + qualifiedId, { params: {} })
    expect(res2.status).to.equal(200)
    expect(res2.data.result.value).to.equal(res1.data.result.value + 1)
  })
})

describe('Jobs serverless bundle entrypoint (Phase 6 — HTTP transport, no AWS)', function () {
  this.timeout(20000)

  // Proves the SERVERLESS code path end-to-end without a cloud: assemble the deployable bundle for
  // a real job, then run its GENERATED entrypoint in-process — handler({ baseUrl, token, params }) —
  // exactly as Lambda would. The bundled client talks to the running freezr server over real HTTP
  // (makeHttpTransport), so this covers the entrypoint + bundled client + HTTP transport. The only
  // thing not exercised here is the actual lambda.send (deploy/invoke), tested manually on real AWS.

  const appName = creds.testAppConfig.appName
  const jobName = '__jobs_test_bundle__'
  const collection = appTable.split('.').pop()
  const jobsDir = join(process.cwd(), 'users_jobs')
  const jobDir = join(jobsDir, appName, jobName)

  const JOB_SRC = [
    'export async function handler (freezr, params) {',
    "  const written = await freezr.create('" + collection + "', { _bundle: true, stamp: params.stamp, val: params.val })",
    "  const queried = await freezr.query('" + collection + "', { stamp: params.stamp })",
    '  return { writtenId: written._id, count: queried.length, stamp: params.stamp }',
    '}',
    ''
  ].join('\n')

  let auth
  let bundleDir

  before(async function () {
    await mkdir(jobDir, { recursive: true })
    await writeFile(join(jobDir, 'index.mjs'), JOB_SRC, 'utf8')
    auth = await authFor('primary')
  })

  after(async function () {
    await rm(jobDir, { recursive: true, force: true })
    if (bundleDir) await rm(bundleDir, { recursive: true, force: true })
  })

  it('assembles a bundle whose generated entrypoint runs the job over HTTP', async function () {
    // 1. Assemble the deployable bundle (deploy-time work) and lay it out on disk like the cloud would.
    const { files } = await assembleJobBundle({ app: appName, name: jobName, jobsDir })
    bundleDir = join(tmpdir(), 'freezr-bundle-run-' + Date.now())
    for (const [rel, bytes] of Object.entries(files)) {
      const abs = join(bundleDir, rel)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, bytes)
    }

    // 2. Import the GENERATED entrypoint and invoke it exactly as the cloud runtime does.
    const mod = await import(pathToFileURL(join(bundleDir, 'index.mjs')).href)
    expect(mod.handler, 'entrypoint must export a handler').to.be.a('function')

    const stamp = 'bun' + Date.now()
    const result = await mod.handler({
      baseUrl: auth.serverUrl,
      token: auth.getCurrentAppToken(),
      appName,
      params: { stamp, val: 55 }
    })

    expect(result, JSON.stringify(result)).to.be.an('object')
    expect(result.writtenId, 'job should have written a record over HTTP').to.exist
    expect(result.count).to.be.at.least(1)
    expect(result.stamp).to.equal(stamp)

    // 3. The handler's freezr.create really wrote via real HTTP — confirm over the normal CEPS path.
    const httpRead = await auth.get(`/ceps/read/${appTable}/${result.writtenId}`)
    expect(httpRead.status, JSON.stringify(httpRead.data)).to.equal(200)
    expect(httpRead.data.val).to.equal(55)
    expect(httpRead.data._bundle).to.equal(true)
    expect(httpRead.data.stamp).to.equal(stamp)
  })

  it('runs via the generated entrypoint using a MINTED session-less job token (the cloud auth path)', async function () {
    // This is the ONE code difference between localhost and the live Lambda path: the cloud invoke
    // authenticates with a freshly-minted token_type:'job' (no session), not the caller's app token.
    // Prove that token works through the bundled client over real HTTP, so only network reachability
    // is left for the online test.
    const { files } = await assembleJobBundle({ app: appName, name: jobName, jobsDir })
    const dir = join(tmpdir(), 'freezr-bundle-mint-' + Date.now())
    for (const [rel, bytes] of Object.entries(files)) {
      const abs = join(dir, rel)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, bytes)
    }
    const mint = await auth.post('/jobs/selftest/mint_job_token', { maxRuntime: '60s' })
    expect(mint.status, JSON.stringify(mint.data)).to.equal(200)
    expect(mint.data.token, 'should mint a job token').to.be.a('string')

    const mod = await import(pathToFileURL(join(dir, 'index.mjs')).href)
    const stamp = 'mint' + Date.now()
    const result = await mod.handler({ baseUrl: auth.serverUrl, token: mint.data.token, appName, params: { stamp, val: 77 } })
    expect(result.writtenId, JSON.stringify(result)).to.exist

    // The minted session-less token really authorized the write over HTTP.
    const httpRead = await auth.get(`/ceps/read/${appTable}/${result.writtenId}`)
    expect(httpRead.status).to.equal(200)
    expect(httpRead.data.val).to.equal(77)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('Jobs serverless bundle — Tier-2 (node_modules) via the generated entrypoint', function () {
  this.timeout(30000)

  // Proves a job with a real npm dependency (uuid) bundles + runs: the per-job folder's pre-built
  // node_modules is carried into the bundle and the generated entrypoint resolves `import 'uuid'`
  // when it runs the handler over HTTP. No AWS — same code path Lambda runs, minus lambda.send.

  const appName = creds.testAppConfig.appName
  const jobName = '__jobs_test_t2__'
  const collection = appTable.split('.').pop()
  let auth, jobsRoot, bundleDir

  const JOB_SRC = [
    "import { v4 as uuidv4 } from 'uuid'",
    'export async function handler (freezr, params) {',
    '  const id = uuidv4()',
    "  const written = await freezr.create('" + collection + "', { _t2: true, uuid: id, stamp: params.stamp })",
    '  return { uuid: id, writtenId: written && written._id }',
    '}',
    ''
  ].join('\n')

  before(async function () {
    auth = await authFor('primary')
    jobsRoot = join(tmpdir(), 'freezr-t2-src-' + Date.now())
    const jobDir = join(jobsRoot, appName, jobName)
    await mkdir(jobDir, { recursive: true })
    await writeFile(join(jobDir, 'index.mjs'), JOB_SRC, 'utf8')
    await writeFile(join(jobDir, 'package.json'), JSON.stringify({ type: 'module', dependencies: { uuid: '*' } }), 'utf8')
    // Ship a PRE-BUILT node_modules (copied from the stamper sample) — freezr never runs npm install.
    const uuidNodeModules = join(process.cwd(), 'testuserapp/com.example.stamper/jobs/stamp/node_modules')
    await cp(uuidNodeModules, join(jobDir, 'node_modules'), { recursive: true })
  })

  after(async function () {
    if (jobsRoot) await rm(jobsRoot, { recursive: true, force: true })
    if (bundleDir) await rm(bundleDir, { recursive: true, force: true })
  })

  it('bundles node_modules (Tier-2) and the entrypoint resolves the uuid import over HTTP', async function () {
    const { files, tier } = await assembleJobBundle({ app: appName, name: jobName, jobsDir: jobsRoot })
    expect(tier, 'should detect Tier-2 from node_modules').to.equal(2)
    expect(Object.keys(files).some(k => k.startsWith('job/node_modules/uuid/')), 'uuid must be bundled').to.be.true

    bundleDir = join(tmpdir(), 'freezr-t2-run-' + Date.now())
    for (const [rel, bytes] of Object.entries(files)) {
      const abs = join(bundleDir, rel)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, bytes)
    }

    const mod = await import(pathToFileURL(join(bundleDir, 'index.mjs')).href)
    const stamp = 't2_' + Date.now()
    const result = await mod.handler({ baseUrl: auth.serverUrl, token: auth.getCurrentAppToken(), appName, params: { stamp } })

    expect(result.uuid, JSON.stringify(result)).to.match(/^[0-9a-f-]{36}$/) // a real uuid from the dep
    expect(result.writtenId).to.exist

    // The dependency-using handler really wrote via HTTP — confirm over the normal CEPS path.
    const httpRead = await auth.get(`/ceps/read/${appTable}/${result.writtenId}`)
    expect(httpRead.status, JSON.stringify(httpRead.data)).to.equal(200)
    expect(httpRead.data.uuid).to.equal(result.uuid)
    expect(httpRead.data._t2).to.equal(true)
  })
})

describe('Jobs control endpoints — freezr.jobs ping / unschedule (app-driven scheduling)', function () {
  this.timeout(15000)

  const appName = creds.testAppConfig.appName
  const jobName = '__jobs_test_ping__'
  let auth

  before(async function () {
    auth = await authFor('primary')
    await auth.put('/jobs/selftest/trust/' + jobName, { audience: 'all_users' })
    await auth.put('/jobs/selftest/grant/' + jobName, { type: 'run_job' })
    await auth.put('/jobs/selftest/grant/' + jobName, { type: 'schedule_job' })
    await auth.put('/jobs/selftest/schedule/' + jobName, { schedule: 'minutely', nextRunAt: 0 }) // app "started" it
  })

  after(async function () {
    await auth.delete('/jobs/selftest/schedule/' + jobName).catch(() => {})
    await auth.delete('/jobs/selftest/trust/' + jobName).catch(() => {})
  })

  it('ping reports per-job grants, trust, scheduled state + compute availability', async function () {
    const res = await auth.get('/jobs/ping')
    expect(res.status, JSON.stringify(res.data)).to.equal(200)
    expect(res.data).to.have.property('has_compute')
    const j = res.data.jobs && res.data.jobs[jobName]
    expect(j, JSON.stringify(res.data.jobs)).to.exist
    expect(j.run_job_granted).to.be.true
    expect(j.schedule_job_granted).to.be.true
    expect(j.trusted).to.be.true
    expect(j.scheduled).to.be.true
  })

  it('unschedule stops the schedule (ping then shows scheduled:false)', async function () {
    const u = await auth.post('/jobs/unschedule/' + jobName, {})
    expect(u.status, JSON.stringify(u.data)).to.equal(200)
    const res = await auth.get('/jobs/ping')
    expect(res.data.jobs[jobName].scheduled).to.be.false
  })

  it('schedule endpoint 403s without a schedule_job grant', async function () {
    const res = await auth.post('/jobs/schedule/__jobs_test_ping_nogrant__', {})
    expect(res.ok).to.be.false
    expect(res.status).to.equal(403)
  })
})

describe('Jobs scheduler (heartbeat runs due jobs) (Phase 7)', function () {
  this.timeout(15000)

  const appName = creds.testAppConfig.appName // owner = caller here (an app schedules its own job)
  const jobName = '__jobs_test_sched__'
  const collection = appTable.split('.').pop()
  const jobDir = join(process.cwd(), 'users_jobs', appName, jobName)

  const JOB_SRC = [
    'export async function handler (freezr, params) {',
    "  const written = await freezr.create('" + collection + "', { _sched: true, at: " + 'Date.now()' + " })",
    '  return { writtenId: written._id }',
    '}',
    ''
  ].join('\n')

  let auth

  before(async function () {
    await mkdir(jobDir, { recursive: true })
    await writeFile(join(jobDir, 'index.mjs'), JOB_SRC, 'utf8')
    auth = await authFor('primary')
    await auth.put('/jobs/selftest/trust/' + jobName, { audience: 'all_users' }) // admin trusts it (local execution)
    await auth.put('/jobs/selftest/grant/' + jobName, { type: 'schedule_job' }) // user grants SCHEDULE_JOB (the scheduler gates on this, not run_job)
  })

  after(async function () {
    await auth.delete('/jobs/selftest/schedule/' + jobName).catch(() => {})
    await auth.delete('/jobs/selftest/trust/' + jobName).catch(() => {})
    await rm(jobDir, { recursive: true, force: true })
  })

  it('runs a due scheduled job on tick, advances next_run_at, and skips it on an immediate re-tick', async function () {
    // Enable, due immediately (next_run_at = 0).
    const en = await auth.put('/jobs/selftest/schedule/' + jobName, { schedule: 'minutely', maxRuntime: '10s', nextRunAt: 0 })
    expect(en.status, JSON.stringify(en.data)).to.equal(200)

    // First tick: the job is due → it runs.
    const t1 = await auth.post('/jobs/selftest/scheduler/tick', {})
    expect(t1.status, JSON.stringify(t1.data)).to.equal(200)
    const ran1 = t1.data.ran.find(r => r.job === jobName && r.app === appName)
    expect(ran1, 'scheduled job should have run on first tick: ' + JSON.stringify(t1.data.ran)).to.exist
    expect(ran1.ok, JSON.stringify(ran1)).to.be.true

    // Second tick immediately: next_run_at was advanced (~1 min out) → NOT due → does not run again.
    const t2 = await auth.post('/jobs/selftest/scheduler/tick', {})
    expect(t2.status).to.equal(200)
    const ran2 = t2.data.ran.find(r => r.job === jobName && r.app === appName)
    expect(ran2, 'scheduled job should be skipped on immediate re-tick (skip-don\'t-catch-up)').to.not.exist
  })

  it('run_job (on-demand) alone does NOT enable scheduling — the row is disabled, not run', async function () {
    // The core of the perm split: granting run_job must not enrol a job in the scheduler. With no
    // schedule_job consent, the scheduler disables the (stale) row rather than running it.
    const j = '__jobs_test_runjob_only__'
    await auth.put('/jobs/selftest/schedule/' + j, { schedule: 'minutely', nextRunAt: 0 })
    await auth.put('/jobs/selftest/grant/' + j, { type: 'run_job' }) // ONLY run_job, NOT schedule_job
    const t = await auth.post('/jobs/selftest/scheduler/tick', {})
    expect(t.status).to.equal(200)
    const r = t.data.ran.find(x => x.job === j && x.app === appName)
    expect(r, JSON.stringify(t.data.ran)).to.exist
    expect(r.ok).to.be.false
    expect(r.disabled, 'run_job must NOT satisfy the scheduler — only schedule_job does').to.be.true
    await auth.delete('/jobs/selftest/schedule/' + j).catch(() => {})
  })

  it('DISABLES a stale schedule row (not "waiting") when schedule_job is not granted', async function () {
    const ungranted = '__jobs_test_sched_ungranted__'
    await auth.put('/jobs/selftest/schedule/' + ungranted, { schedule: 'minutely', nextRunAt: 0 })
    const t = await auth.post('/jobs/selftest/scheduler/tick', {})
    expect(t.status).to.equal(200)
    const r = t.data.ran.find(x => x.job === ungranted && x.app === appName)
    expect(r, 'ungranted scheduled job should appear in tick results: ' + JSON.stringify(t.data.ran)).to.exist
    expect(r.ok).to.be.false
    expect(r.disabled, 'no schedule_job consent → the scheduler disables the row (not waiting forever)').to.be.true
    // a second tick must NOT see it again (it's disabled now)
    const t2 = await auth.post('/jobs/selftest/scheduler/tick', {})
    expect(t2.data.ran.find(x => x.job === ungranted && x.app === appName)).to.not.exist
    await auth.delete('/jobs/selftest/schedule/' + ungranted).catch(() => {})
  })
})
