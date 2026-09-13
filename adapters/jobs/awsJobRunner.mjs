// freezr.info — AwsRunner (the Lambda member of the JobRunner family, plan §9) awsJobRunner.mjs (r0)
//
// Ships a job to AWS Lambda and invokes it. Mined from the legacy slConnectors/serverless.mjs
// (which used these same AWS SDK v3 calls) but rebuilt around the clean jobs model:
//   - deploy(): assemble the bundle (serverlessBundle.mjs) + zip + Create/UpdateFunctionCode.
//   - invoke(): InvokeCommand with only { baseUrl, token, params } in the payload (capability model —
//               creds + params, NOT data); the function PULLS what it needs back over HTTP.
//   - usage  : parse the REPORT tail into normalized billing (awsCostParser.mjs, §9.1).
// Runtime bumped nodejs16.x → nodejs20.x (16 is EOL on Lambda); arm64 (cheaper); Handler index.handler.
//
// Created PER compute-credential (the user's own AWS account — their spend). For testability the
// Lambda/IAM clients can be injected; otherwise they're constructed from the credential.
//
// NOTE: methods take the full { ownerId, app, name } triple (not just app/name) because the Lambda
// function name is owner-scoped (jobFunctionName). The location-agnostic invoker passes all three.

import {
  LambdaClient, LogType, InvokeCommand, CreateFunctionCommand, UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand, GetFunctionCommand, DeleteFunctionCommand,
  Architecture, PackageType, Runtime
} from '@aws-sdk/client-lambda'
import { IAMClient, CreateRoleCommand, GetRoleCommand } from '@aws-sdk/client-iam'
import { jobFunctionName, normalizeRunResult } from './jobRunner.mjs'
import { assembleJobBundle, zipBundleFiles } from './serverlessBundle.mjs'
import { parseLambdaReport } from './awsCostParser.mjs'

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const DEFAULT_REGION = 'eu-central-1'
const RUNTIME = Runtime.nodejs20x
const ROLE_NAME = 'freezrLambdaRole'
const TIMEOUT_SECONDS = 60 // fallback when a job declares no maxRuntime
const LAMBDA_MAX_TIMEOUT_SECONDS = 900 // AWS hard ceiling for any function
// Lambda defaults a new function to 128MB — far too small for jobs that buffer mail bodies +
// attachments in memory (each attachment is read as a Blob and base64-encoded for the HTTP upload),
// which OOMs the runtime ("signal: killed"). Default higher; memory also scales the vCPU share, so
// this speeds jobs up too. Overridable per compute-credential via credentials.memoryMb.
const DEFAULT_MEMORY_MB = 512

// maxRuntimeMs (a job's declared budget) → a valid Lambda Timeout in whole seconds, clamped to AWS's
// [1, 900] range. null/invalid falls back to the default.
function timeoutSecondsFrom (maxRuntimeMs) {
  const secs = Math.ceil(Number(maxRuntimeMs) / 1000)
  if (!Number.isFinite(secs) || secs < 1) return TIMEOUT_SECONDS
  return Math.min(secs, LAMBDA_MAX_TIMEOUT_SECONDS)
}

// Turn a raw Lambda FunctionError into a clear, actionable message + a stable errorCode the app can
// branch on. AWS reports OOM/timeout only as cryptic strings ("signal: killed", "Task timed out"),
// so without this the app just sees noise. Returns { code, message }.
function describeLambdaError ({ errorType, raw, memoryMb }) {
  const text = String(raw == null ? '' : raw)
  const isOOM = errorType === 'Runtime.OutOfMemory' ||
    /signal:\s*killed|out ?of ?memory|heap out of memory/i.test(text)
  if (isOOM) {
    const mem = memoryMb ? (memoryMb + 'MB') : 'its memory limit'
    return {
      code: 'OUT_OF_MEMORY',
      message: 'job ran out of memory (exceeded ' + mem + ' on the serverless function). ' +
        'Reduce the work per run (smaller batch_size, or strip attachments) or raise the function memory.'
    }
  }
  const isTimeout = errorType === 'Sandbox.Timedout' || /task timed out/i.test(text)
  if (isTimeout) {
    return {
      code: 'TIMEOUT',
      message: 'job timed out on the serverless function before finishing. ' +
        'Reduce the work per run (smaller batch_size) or raise the job maxRuntime.'
    }
  }
  return { code: null, message: text || 'job failed on the serverless function' }
}

export function createAwsJobRunner ({ credentials, jobsDir, lambdaClient = null, iamClient = null } = {}) {
  if (!credentials || !credentials.accessKeyId || !credentials.secretAccessKey) {
    throw new Error('createAwsJobRunner: aws credentials (accessKeyId, secretAccessKey) required')
  }
  const region = credentials.region || DEFAULT_REGION
  const awsCreds = { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey }
  const lambda = lambdaClient || new LambdaClient({ region, credentials: awsCreds })

  // memoryMb is a per-run OPTION (threaded from the job via invokeJob), not a credential — falls back
  // to DEFAULT_MEMORY_MB. Resolved once here so deploy() and the error path agree.
  const resolveMemoryMb = (m) => (Number(m) > 0 ? Number(m) : DEFAULT_MEMORY_MB)

  const fnName = ({ ownerId, app, name }) => jobFunctionName({ ownerId, appName: app, jobName: name })

  // After UpdateFunctionCode the function is briefly "InProgress" and a config update fails with
  // ResourceConflictException — retry a few times so memory/timeout still get pushed on existing fns.
  async function updateConfigWithRetry (functionName, config) {
    for (let attempt = 0; ; attempt++) {
      try {
        await lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: functionName, ...config }))
        return
      } catch (e) {
        const transient = e && (e.name === 'ResourceConflictException' ||
          /update is in progress|in progress|currently in the following state/i.test(e.message || ''))
        if (transient && attempt < 4) { await sleep(2000); continue }
        throw e
      }
    }
  }

  async function functionExists (functionName) {
    try {
      const r = await lambda.send(new GetFunctionCommand({ FunctionName: functionName }))
      return !!(r && (r.Configuration || r.Code))
    } catch (e) {
      if (e.name === 'ResourceNotFoundException') return false
      throw e
    }
  }

  /** Assemble + zip + create/update the Lambda function. @returns { ref } | { error } */
  async function deploy ({ ownerId, app, name, jobsDir: jd, handlerSource = null, jobZip = null, maxRuntimeMs = null, memoryMb = null } = {}) {
    if (!credentials.arnRole) return { error: 'compute credential has no IAM role (arnRole); set one up first' }
    const functionName = fnName({ ownerId, app, name })
    const timeoutSec = timeoutSecondsFrom(maxRuntimeMs)
    const memMb = resolveMemoryMb(memoryMb)
    try {
      const { files, tier } = await assembleJobBundle({ app, name, jobsDir: jd || jobsDir, handlerSource, jobZip })
      const zip = zipBundleFiles(files)
      const exists = await functionExists(functionName)
      const verb = exists ? 'UpdateFunctionCode' : 'CreateFunction'
      console.log('☁️  AWS LAMBDA → ' + verb + ' "' + functionName + '" region=' + region + ' tier=' + tier + ' zip=' + zip.length + 'B (runtime ' + RUNTIME + ', arm64, mem=' + memMb + 'MB, timeout=' + timeoutSec + 's)')
      const t0 = Date.now()
      if (exists) {
        await lambda.send(new UpdateFunctionCodeCommand({
          FunctionName: functionName, ZipFile: zip, Architectures: [Architecture.arm64]
        }))
        // Keep memory/timeout in sync — a function CREATED before this (or at the old 128MB default)
        // keeps its original config across code updates, so without this it would keep OOMing.
        try {
          await updateConfigWithRetry(functionName, { MemorySize: memMb, Timeout: timeoutSec })
        } catch (e) {
          console.log('☁️  AWS LAMBDA ✗ config update (mem/timeout) FAILED "' + functionName + '": ' + (e && (e.message || String(e))))
        }
      } else {
        await lambda.send(new CreateFunctionCommand({
          FunctionName: functionName,
          Role: credentials.arnRole,
          Code: { ZipFile: zip },
          Handler: 'index.handler',
          Runtime: RUNTIME,
          PackageType: PackageType.Zip,
          Architectures: [Architecture.arm64],
          MemorySize: memMb,
          Timeout: timeoutSec
        }))
      }
      console.log('☁️  AWS LAMBDA ← ' + verb + ' OK "' + functionName + '" in ' + (Date.now() - t0) + 'ms')
      return { ref: functionName, updated: exists }
    } catch (e) {
      console.log('☁️  AWS LAMBDA ✗ deploy FAILED "' + functionName + '": ' + (e && (e.name ? e.name + ' — ' : '') + (e.message || String(e))))
      return { error: e.message || String(e) }
    }
  }

  /** Delete the Lambda function (idempotent — missing is success). */
  async function remove ({ ownerId, app, name } = {}) {
    const functionName = fnName({ ownerId, app, name })
    try {
      await lambda.send(new DeleteFunctionCommand({ FunctionName: functionName }))
      return { ok: true }
    } catch (e) {
      if (e.name === 'ResourceNotFoundException') return { ok: true }
      return { error: e.message || String(e) }
    }
  }

  /**
   * Invoke the function with the run payload (auto-deploys if absent). Returns the canonical
   * run-result shape with normalized usage parsed from the REPORT tail.
   * @returns { ok, result, error, errorCode, durationMs, usage, logs }
   */
  async function invoke ({ ownerId, app, name, baseUrl, token, params = {}, autoDeploy = true, redeploy = false, jobsDir: jd, handlerSource = null, jobZip = null, maxRuntimeMs = null, memoryMb = null } = {}) {
    const startedAt = Date.now()
    const functionName = fnName({ ownerId, app, name })
    try {
      // redeploy=true forces a fresh code upload before invoking (picks up edited job code / client);
      // otherwise we only auto-deploy when the function doesn't exist yet.
      if (redeploy) {
        console.log('☁️  AWS LAMBDA: redeploy requested for "' + functionName + '" — pushing latest code before invoke')
        const d = await deploy({ ownerId, app, name, jobsDir: jd, handlerSource, jobZip, maxRuntimeMs, memoryMb })
        if (d.error) return normalizeRunResult({ ok: false, error: 'deploy failed: ' + d.error, durationMs: Date.now() - startedAt })
      } else if (autoDeploy && !await functionExists(functionName)) {
        console.log('☁️  AWS LAMBDA: "' + functionName + '" not found — auto-deploying before invoke')
        const d = await deploy({ ownerId, app, name, jobsDir: jd, handlerSource, jobZip, maxRuntimeMs, memoryMb })
        if (d.error) return normalizeRunResult({ ok: false, error: 'deploy failed: ' + d.error, durationMs: Date.now() - startedAt })
      }
      // CALLED → (token/secret never logged; only the non-sensitive run shape).
      console.log('☁️  AWS LAMBDA → Invoke "' + functionName + '" region=' + region + ' callbackUrl=' + (baseUrl || '(none)') + ' params=' + JSON.stringify(Object.keys(params || {})))
      const sentAt = Date.now()
      // A just-created function is briefly "Pending" and Invoke fails with ResourceConflictException.
      // Retry up to 2 extra times (3s apart) on that transient state before giving up.
      let out
      for (let attempt = 0; ; attempt++) {
        try {
          out = await lambda.send(new InvokeCommand({
            FunctionName: functionName,
            Payload: JSON.stringify({ baseUrl, token, params, appName: app, userId: ownerId }),
            LogType: LogType.Tail
          }))
          break
        } catch (e) {
          const transient = e && (e.name === 'ResourceConflictException' || /\bpending\b|in progress|currently in the following state/i.test(e.message || ''))
          if (transient && attempt < 2) {
            console.log('☁️  AWS LAMBDA: "' + functionName + '" not ready yet (' + (e.name || 'pending') + ') — retry ' + (attempt + 1) + '/2 in 3s')
            await sleep(3000)
            continue
          }
          throw e
        }
      }
      const payloadStr = out.Payload ? Buffer.from(out.Payload).toString() : ''
      const logs = out.LogResult ? Buffer.from(out.LogResult, 'base64').toString() : ''
      let result = null
      try { result = payloadStr ? JSON.parse(payloadStr) : null } catch (e) { result = payloadStr }
      const usage = { durationMs: Date.now() - startedAt, ...parseLambdaReport(logs) }

      // ACK ← Lambda responded. One specific line with status, AWS StatusCode, billing + cost,
      // round-trip time, and a truncated result body, so a live run is unambiguous.
      const billed = (usage.billedMs != null) ? (usage.billedMs + 'ms billed / ' + (usage.memoryMb || '?') + 'MB') : 'billing n/a'
      const cost = (usage.estCost != null) ? (', est $' + usage.estCost) : ''
      const status = out.FunctionError ? ('✗ FunctionError=' + out.FunctionError) : ('✓ StatusCode=' + (out.StatusCode != null ? out.StatusCode : '?'))
      console.log('☁️  AWS LAMBDA ← Invoke "' + functionName + '" ' + status + ' | ' + (Date.now() - sentAt) + 'ms round-trip, ' + billed + cost)
      console.log('☁️  AWS LAMBDA ← result: ' + (payloadStr ? payloadStr.slice(0, 400) : '(empty)'))

      if (out.FunctionError) {
        // The handler threw inside Lambda — result holds AWS's { errorMessage, errorType, ... }.
        // AWS surfaces OOM / timeout only as cryptic strings ("signal: killed", "Task timed out"),
        // so translate those into a clear, actionable message + a stable errorCode for the app.
        const raw = (result && (result.errorMessage || result.message)) || out.FunctionError
        const errorType = result && result.errorType
        const { code, message } = describeLambdaError({ errorType, raw, memoryMb: usage.memoryMb || resolveMemoryMb(memoryMb) })
        return normalizeRunResult({ ok: false, error: message, errorCode: code || out.FunctionError, durationMs: usage.durationMs, usage, logs })
      }
      return normalizeRunResult({ ok: true, result, durationMs: usage.durationMs, usage, logs })
    } catch (e) {
      console.log('☁️  AWS LAMBDA ✗ Invoke FAILED "' + functionName + '": ' + (e && (e.name ? e.name + ' — ' : '') + (e.message || String(e))))
      return normalizeRunResult({ ok: false, error: e.message || String(e), durationMs: Date.now() - startedAt })
    }
  }

  async function exists ({ ownerId, app, name } = {}) {
    return functionExists(fnName({ ownerId, app, name }))
  }

  return { packaging: 'prebuilt', region, deploy, remove, invoke, exists }
}

/**
 * Create the Lambda execution role in the user's AWS account (used at compute-credential setup).
 * Returns { arn } | { error }. Mirrors the legacy createAwsRole.
 */
export async function ensureLambdaRole ({ credentials, iamClient = null } = {}) {
  if (!credentials || !credentials.accessKeyId || !credentials.secretAccessKey) {
    return { error: 'aws credentials required' }
  }
  const region = credentials.region || DEFAULT_REGION
  const iam = iamClient || new IAMClient({
    region,
    credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey }
  })
  try {
    const r = await iam.send(new CreateRoleCommand({
      RoleName: ROLE_NAME,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }]
      })
    }))
    return { arn: r && r.Role && r.Role.Arn, created: true }
  } catch (e) {
    // Already there from a prior run (or the legacy serverless) — fetch its ARN so the caller
    // always gets a usable arnRole, not just "it exists".
    if (e.name === 'EntityAlreadyExistsException') {
      try {
        const g = await iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }))
        return { arn: g && g.Role && g.Role.Arn, alreadyExists: true }
      } catch (e2) {
        return { error: e2.message || String(e2) }
      }
    }
    return { error: e.message || String(e) }
  }
}

export default { createAwsJobRunner, ensureLambdaRole }
