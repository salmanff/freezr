// freezr.info — JobRunner family contract + shared helpers (plan §9)
//
// A JobRunner is the swappable "where does the job actually execute" boundary. The
// location-agnostic invoker (features/jobs/services/jobInvoker.mjs) and the scheduler call the
// SAME methods regardless of which runner backs a job — they never know it's local vs Lambda.
//
//   interface JobRunner {
//     packaging: 'inprocess' | 'prebuilt' | 'source'   // how the deployable unit must arrive
//     exists(app, name)            -> Promise<boolean>          // is the job's code present?
//     deploy(job, bundle)          -> Promise<{ ref } | { error }>   // create/update the unit (cloud only)
//     remove(job)                  -> Promise<{ ok } | { error }>
//     invoke({ app, name, token, params, maxRuntime, flogger })
//                                  -> Promise<{ ok, result, error, errorCode, durationMs, usage?, logs? }>
//   }
//
// - LocalRunner (adapters/jobs/localJobRunner.mjs): packaging 'inprocess'; deploy/remove are no-ops
//   (code already lives under users_jobs/); invoke runs the handler in-process. usage = { durationMs }.
// - AwsRunner  (adapters/jobs/awsJobRunner.mjs):     packaging 'prebuilt'; deploy assembles+ships a
//   zip to Lambda; invoke calls the function over HTTPS; usage = normalized billing (§9.1).
// - GoogleRunner / AzureRunner: future stubs ('source' — the cloud installs deps in the USER's cloud,
//   consistent with "freezr never installs").
//
// The normalized usage shape (filled per-adapter from each cloud's own log/response):
//   { durationMs, billedMs?, memoryMb?, estCost?, currency? }

import { createHash } from 'node:crypto'

const sanitize = (s) => String(s == null ? '' : s).replace(/[^a-zA-Z0-9-_]/g, '_')

// AWS Lambda function names are limited to 64 chars of [a-zA-Z0-9-_]. The legacy code did
// `(...).slice(0, 64)`, which silently COLLIDES for two long usernames sharing a 64-char prefix.
// Instead: keep a readable head and append a short stable hash of the FULL name, so distinct
// (owner, app, job) triples always map to distinct function names. Computed in ONE place (plan §9).
export function jobFunctionName ({ ownerId, appName, jobName, prefix = 'freezr' }) {
  if (!ownerId || !appName || !jobName) throw new Error('jobFunctionName: ownerId, appName, jobName required')
  const full = [prefix, ownerId, appName, jobName].map(sanitize).join('_')
  if (full.length <= 64) return full
  const hash = createHash('sha256').update(full).digest('hex').slice(0, 8)
  return full.slice(0, 64 - 9) + '_' + hash // 55 + '_' + 8 = exactly 64
}

// Normalize whatever a runner returns into the invoker's canonical result shape, so the scheduler
// and run-now path see one shape across local/cloud. (durationMs is always present.)
export function normalizeRunResult (out = {}) {
  return {
    ok: !!out.ok,
    result: out.result ?? null,
    error: out.error ? (out.error.message || String(out.error)) : null,
    errorCode: out.errorCode || out.error?.code || null,
    durationMs: typeof out.durationMs === 'number' ? out.durationMs : 0,
    usage: out.usage || null,
    logs: out.logs || null
  }
}

export default { jobFunctionName, normalizeRunResult }
