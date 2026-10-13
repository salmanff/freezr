// use_file_sys — localFsGate trusted-origin tests.
// The gate admits a local store only when: system fs is local, the admin pref is on, the
// user is an admin, AND the request comes from a trusted origin — a loopback request or an
// in-process (admin-trusted) job. These tests pin the origin rule, including the cases that
// must STAY refused: a remote browser, and a cloud job calling back over the network.
import { expect } from 'chai'
import { createLocalFsGate, isLocalhostRequest, inProcessJobOf } from '../../../features/connections/fs/middleware/fsContext.mjs'

// --- minimal doubles ---------------------------------------------------------------
const makeReq = ({ remote = null, host = null, job = undefined } = {}) => {
  const req = { headers: host ? { host } : {}, socket: remote ? { remoteAddress: remote } : undefined }
  if (job !== undefined) req.freezrInProcessJob = job
  return req
}

const makeRes = (fsParams = { type: 'local', rootPath: '/tmp/store' }) => ({
  locals: {
    freezr: {
      fsConnection: { connectionName: 'teststore', fsParams },
      tokenInfo: { requestor_id: 'adminuser', app_name: 'com.test.app' }
    },
    // sendFailure logs through flogger; capture instead of requiring the real logger
    flogger: { info () {}, warn () {}, error () {}, debug () {}, track () {} }
  },
  statusCode: 200,
  status (c) { this.statusCode = c; return this },
  json (b) { this.body = b; return this }
})

// dsManager double: system fs type + admin lookup are the only things the gate uses.
const makeDs = ({ systemFsType = 'local', isAdmin = true } = {}) => ({
  systemEnvironment: { fsParams: { type: systemFsType } },
  getDB: () => ({ __isAdmin: isAdmin })
})

// The gate calls isUserAdmin(db, userId); stub it via the db double it receives.
// userAdminStatus reads the user record, so intercept by module mock is overkill here —
// instead assert on the outcomes that do not depend on it, plus an admin-true path.
const runGate = async (gate, req, res) => {
  let nexted = false
  await gate(req, res, () => { nexted = true })
  return { nexted, status: res.statusCode, body: res.body }
}

describe('use_file_sys — isLocalhostRequest stays strictly about the socket', function () {
  it('true only for a loopback address AND a localhost host header', function () {
    expect(isLocalhostRequest(makeReq({ remote: '127.0.0.1', host: 'localhost:3000' }))).to.equal(true)
    expect(isLocalhostRequest(makeReq({ remote: '::1', host: '127.0.0.1:3000' }))).to.equal(true)
    // right host, remote address is not loopback → false (the address is authoritative)
    expect(isLocalhostRequest(makeReq({ remote: '203.0.113.9', host: 'localhost:3000' }))).to.equal(false)
    // loopback address but a domain Host (proxied from outside) → false
    expect(isLocalhostRequest(makeReq({ remote: '127.0.0.1', host: 'my.freezr.example' }))).to.equal(false)
  })

  it('is NOT widened by the in-process-job marker (that policy lives in the gate)', function () {
    const jobReq = makeReq({ job: { appName: 'a', jobName: 'j' } })
    expect(isLocalhostRequest(jobReq), 'a job has no socket and is not a loopback request').to.equal(false)
    expect(inProcessJobOf(jobReq)).to.deep.equal({ appName: 'a', jobName: 'j' })
  })

  it('inProcessJobOf: null when absent, {} for a bare marker', function () {
    expect(inProcessJobOf(makeReq({ remote: '127.0.0.1', host: 'localhost' }))).to.equal(null)
    expect(inProcessJobOf(makeReq({ job: true }))).to.deep.equal({})
  })
})

describe('use_file_sys — localFsGate origin rule', function () {
  const prefsOn = { local_fs_access_enabled: true }

  it('REFUSES a remote (non-loopback) browser request', async function () {
    const gate = createLocalFsGate(makeDs(), prefsOn)
    const req = makeReq({ remote: '203.0.113.9', host: 'my.freezr.example' })
    const { nexted, status, body } = await runGate(gate, req, makeRes())
    expect(nexted).to.equal(false)
    expect(status).to.equal(403)
    expect(JSON.stringify(body)).to.match(/localhost/i)
  })

  it('REFUSES a cloud job calling back over the network (real socket, no marker)', async function () {
    // A serverless job reaches the API as an ordinary remote HTTP client — it must not be
    // mistaken for an in-process job just because a job is running somewhere.
    const gate = createLocalFsGate(makeDs(), prefsOn)
    const req = makeReq({ remote: '52.1.2.3', host: 'my.freezr.example' })
    const { nexted, status } = await runGate(gate, req, makeRes())
    expect(nexted).to.equal(false)
    expect(status).to.equal(403)
  })

  it('REFUSES even a trusted job when the admin pref is off', async function () {
    const gate = createLocalFsGate(makeDs(), { local_fs_access_enabled: false })
    const req = makeReq({ job: { appName: 'com.test.app', jobName: 'analyze' } })
    const { nexted, status, body } = await runGate(gate, req, makeRes())
    expect(nexted).to.equal(false)
    expect(status).to.equal(403)
    expect(JSON.stringify(body)).to.match(/local_fs_access_enabled/)
  })

  it('REFUSES even a trusted job when the server\'s own fs is not local', async function () {
    const gate = createLocalFsGate(makeDs({ systemFsType: 'aws' }), prefsOn)
    const req = makeReq({ job: { appName: 'com.test.app', jobName: 'analyze' } })
    const { nexted, status } = await runGate(gate, req, makeRes())
    expect(nexted).to.equal(false)
    expect(status).to.equal(403)
  })

  it('passes the origin check for an in-process job (admin check is what follows)', async function () {
    // The admin lookup needs a real user db, so assert the gate got PAST the origin rule:
    // a refusal here would carry the localhost message; anything else means origin passed.
    const gate = createLocalFsGate(makeDs(), prefsOn)
    const req = makeReq({ job: { appName: 'com.test.app', jobName: 'analyze' } })
    const { body } = await runGate(gate, req, makeRes())
    expect(JSON.stringify(body || {}), 'must not be refused for origin').to.not.match(/can only be accessed from localhost/)
  })

  it('is a NO-OP for cloud stores — the gate only guards type "local"', async function () {
    const gate = createLocalFsGate(makeDs({ systemFsType: 'aws' }), { local_fs_access_enabled: false })
    const res = makeRes({ type: 'dropbox', accessToken: 'x' })
    const req = makeReq({ remote: '203.0.113.9', host: 'my.freezr.example' })
    const { nexted } = await runGate(gate, req, res)
    expect(nexted, 'a dropbox store is credential-guarded and bypasses every local rule').to.equal(true)
  })
})
