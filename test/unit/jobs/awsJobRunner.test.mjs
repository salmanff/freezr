// Unit tests for AwsRunner + Lambda cost parsing (Phase 6.4) — no AWS.
// The runner's Lambda client is injected with a fake that records commands and returns canned
// responses, so deploy/invoke/remove orchestration is fully covered without touching AWS.
import { expect } from 'chai'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLambdaReport } from '../../../adapters/jobs/awsCostParser.mjs'
import { createAwsJobRunner } from '../../../adapters/jobs/awsJobRunner.mjs'

const SAMPLE_REPORT =
  'START RequestId: abc Version: $LATEST\nEND RequestId: abc\n' +
  'REPORT RequestId: abc\tDuration: 12.34 ms\tBilled Duration: 100 ms\tMemory Size: 128 MB\tMax Memory Used: 70 MB\t\n'

describe('awsCostParser.parseLambdaReport', function () {
  it('parses billed duration, memory and max memory from a REPORT line', function () {
    const u = parseLambdaReport(SAMPLE_REPORT)
    expect(u.billedMs).to.equal(100)
    expect(u.memoryMb).to.equal(128)
    expect(u.maxMemoryMb).to.equal(70)
  })

  it('computes a positive USD cost estimate', function () {
    const u = parseLambdaReport(SAMPLE_REPORT)
    expect(u.currency).to.equal('USD')
    expect(u.estCost).to.be.a('number').greaterThan(0)
    // 128MB for 100ms => 0.0125 GB-s * arm price + per-request; sanity bound
    expect(u.estCost).to.be.lessThan(0.001)
  })

  it('returns empty for logs with no REPORT line', function () {
    expect(parseLambdaReport('just some logs')).to.deep.equal({})
    expect(parseLambdaReport('')).to.deep.equal({})
    expect(parseLambdaReport(null)).to.deep.equal({})
  })
})

function makeFakeLambda ({ exists = false, invokeResult = { ok: true, n: 1 }, functionError = null, report = SAMPLE_REPORT } = {}) {
  const calls = []
  let _exists = exists
  return {
    calls,
    async send (cmd) {
      const name = cmd.constructor.name
      calls.push({ name, input: cmd.input })
      if (name === 'GetFunctionCommand') {
        if (_exists) return { Configuration: { FunctionName: cmd.input.FunctionName } }
        const e = new Error('not found'); e.name = 'ResourceNotFoundException'; throw e
      }
      if (name === 'CreateFunctionCommand') { _exists = true; return { FunctionArn: 'arn:create' } }
      if (name === 'UpdateFunctionCodeCommand') { return { FunctionArn: 'arn:update' } }
      if (name === 'DeleteFunctionCommand') {
        if (!_exists) { const e = new Error('nf'); e.name = 'ResourceNotFoundException'; throw e }
        _exists = false; return {}
      }
      if (name === 'InvokeCommand') {
        return {
          Payload: new TextEncoder().encode(JSON.stringify(invokeResult)),
          LogResult: Buffer.from(report).toString('base64'),
          FunctionError: functionError
        }
      }
      return {}
    }
  }
}

const CREDS = { accessKeyId: 'AKIA', secretAccessKey: 'secret', region: 'eu-central-1', arnRole: 'arn:aws:iam::1:role/freezrLambdaRole' }
const triple = { ownerId: 'salman', app: 'com.example.incrementer', name: 'increment' }

describe('awsJobRunner', function () {
  let jobsDir

  before(async function () {
    jobsDir = await mkdtemp(join(tmpdir(), 'freezr-aws-'))
    await mkdir(join(jobsDir, triple.app, triple.name), { recursive: true })
    await writeFile(join(jobsDir, triple.app, triple.name, 'index.mjs'),
      'export async function handler (freezr, params) { return { ok: true } }\n', 'utf8')
  })
  after(async function () { if (jobsDir) await rm(jobsDir, { recursive: true, force: true }) })

  it('requires AWS credentials', function () {
    expect(() => createAwsJobRunner({ credentials: {} })).to.throw()
  })

  it('deploy CREATES a Lambda when absent, with the right runtime/handler/arch/role', async function () {
    const fake = makeFakeLambda({ exists: false })
    const runner = createAwsJobRunner({ credentials: CREDS, jobsDir, lambdaClient: fake })
    const r = await runner.deploy(triple)
    expect(r.error, JSON.stringify(r)).to.be.undefined
    expect(r.ref).to.equal('freezr_salman_com_example_incrementer_increment')
    expect(r.updated).to.be.false
    const create = fake.calls.find(c => c.name === 'CreateFunctionCommand')
    expect(create, 'should have created').to.exist
    expect(create.input.Handler).to.equal('index.handler')
    expect(create.input.Runtime).to.equal('nodejs20.x')
    expect(create.input.Architectures).to.deep.equal(['arm64'])
    expect(create.input.Role).to.equal(CREDS.arnRole)
    expect(create.input.Code.ZipFile).to.be.an.instanceof(Uint8Array)
    expect(create.input.Code.ZipFile.length).to.be.greaterThan(0)
  })

  it('deploy UPDATES code when the function already exists', async function () {
    const fake = makeFakeLambda({ exists: true })
    const runner = createAwsJobRunner({ credentials: CREDS, jobsDir, lambdaClient: fake })
    const r = await runner.deploy(triple)
    expect(r.updated).to.be.true
    expect(fake.calls.some(c => c.name === 'UpdateFunctionCodeCommand')).to.be.true
    expect(fake.calls.some(c => c.name === 'CreateFunctionCommand')).to.be.false
  })

  it('deploy errors clearly when the credential has no IAM role', async function () {
    const fake = makeFakeLambda({ exists: false })
    const runner = createAwsJobRunner({ credentials: { ...CREDS, arnRole: undefined }, jobsDir, lambdaClient: fake })
    const r = await runner.deploy(triple)
    expect(r.error).to.match(/IAM role/i)
  })

  it('invoke sends only { baseUrl, token, params, appName } and returns ok + parsed usage', async function () {
    const fake = makeFakeLambda({ exists: true, invokeResult: { value: 42 } })
    const runner = createAwsJobRunner({ credentials: CREDS, jobsDir, lambdaClient: fake })
    const out = await runner.invoke({ ...triple, baseUrl: 'https://my.freezr', token: 'tok123', params: { x: 1 } })
    expect(out.ok, JSON.stringify(out)).to.be.true
    expect(out.result).to.deep.equal({ value: 42 })
    expect(out.usage.billedMs).to.equal(100)
    expect(out.usage.memoryMb).to.equal(128)
    expect(out.usage.estCost).to.be.greaterThan(0)
    const inv = fake.calls.find(c => c.name === 'InvokeCommand')
    const payload = JSON.parse(inv.input.Payload)
    expect(payload).to.have.all.keys(['baseUrl', 'token', 'params', 'appName'])
    expect(payload.baseUrl).to.equal('https://my.freezr')
    expect(payload.token).to.equal('tok123')
    expect(payload.appName).to.equal(triple.app)
    // capability model: no data pushed in the payload
    expect(payload).to.not.have.property('data')
  })

  it('invoke auto-deploys when the function is absent, then invokes', async function () {
    const fake = makeFakeLambda({ exists: false, invokeResult: { ok: true } })
    const runner = createAwsJobRunner({ credentials: CREDS, jobsDir, lambdaClient: fake })
    const out = await runner.invoke({ ...triple, baseUrl: 'https://my.freezr', token: 't' })
    expect(out.ok).to.be.true
    expect(fake.calls.some(c => c.name === 'CreateFunctionCommand')).to.be.true
    expect(fake.calls.some(c => c.name === 'InvokeCommand')).to.be.true
  })

  it('invoke surfaces a Lambda FunctionError as ok:false', async function () {
    const fake = makeFakeLambda({ exists: true, functionError: 'Unhandled', invokeResult: { errorMessage: 'boom in handler' } })
    const runner = createAwsJobRunner({ credentials: CREDS, jobsDir, lambdaClient: fake })
    const out = await runner.invoke({ ...triple, baseUrl: 'https://my.freezr', token: 't' })
    expect(out.ok).to.be.false
    expect(out.error).to.equal('boom in handler')
    expect(out.errorCode).to.equal('Unhandled')
  })

  it('invoke no longer hard-requires baseUrl (a job may not call freezr) — it still runs', async function () {
    const fake = makeFakeLambda({ exists: true, invokeResult: { ok: true } })
    const runner = createAwsJobRunner({ credentials: CREDS, jobsDir, lambdaClient: fake })
    const out = await runner.invoke({ ...triple }) // no baseUrl/token
    expect(out.ok).to.be.true
    expect(fake.calls.some(c => c.name === 'InvokeCommand')).to.be.true
  })

  it('invoke retries on a transient ResourceConflictException (function still Pending)', async function () {
    let invokeAttempts = 0
    const fake = makeFakeLambda({ exists: true, invokeResult: { ok: true } })
    const realSend = fake.send
    fake.send = async (cmd) => {
      if (cmd.constructor.name === 'InvokeCommand') {
        invokeAttempts++
        if (invokeAttempts === 1) { const e = new Error('currently in the following state: Pending'); e.name = 'ResourceConflictException'; throw e }
      }
      return realSend(cmd)
    }
    const runner = createAwsJobRunner({ credentials: CREDS, jobsDir, lambdaClient: fake })
    const out = await runner.invoke({ ...triple, baseUrl: 'https://my.freezr', token: 't' })
    expect(out.ok, JSON.stringify(out)).to.be.true
    expect(invokeAttempts).to.equal(2) // first Pending, retried once
  }).timeout(8000)

  it('remove is idempotent (missing function => ok)', async function () {
    const fake = makeFakeLambda({ exists: false })
    const runner = createAwsJobRunner({ credentials: CREDS, jobsDir, lambdaClient: fake })
    const r = await runner.remove(triple)
    expect(r.ok).to.be.true
  })
})
