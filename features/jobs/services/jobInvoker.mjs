// freezr.info — Shared job invoker - jobInvoker.mjs (r1)
//
// The one place that turns "(ownerApp, jobName, user)" into an actual run: resolve location
// (trusted-job + audience + resolver + the user's compute credential), then run AS THE OWNER app —
// locally (in-process) or on the user's cloud (AwsRunner). Used by the scheduler and run-now. Per
// the freezr db-handle principle, the caller passes the opened db handles + a localRunner — never
// dsManager.
//
//   - token omitted → mint a fresh short-lived session-less token for (user, ownerApp).
//   - token given   → use it (run-now's own-job path passes the caller's own token).
//
// Cloud path needs: resourcesDb (to read the user's compute credential — the cloud-cost gate) and
// baseUrl (the public freezr URL the deployed function calls back to). makeCloudRunner is injectable
// for testing; it defaults to the real AwsRunner. resourceUsageDb (optional) receives a §9.2 cost row.

import { getTrustedJob } from './trustedJobService.mjs'
import { mintJobToken } from './jobTokenService.mjs'
import { resolveJobLocation } from './jobLocationResolver.mjs'
import { userHasComputeCredential, getUserComputeCredential } from './computeCredentialService.mjs'
import { recordResourceUsage } from './resourceUsageService.mjs'
import { makeCloudRunnerForProvider } from '../../../adapters/jobs/cloudRunnerRegistry.mjs'
import { jobDeployIdentity } from '../../../adapters/jobs/serverlessBundle.mjs'
import { parseDurationMs } from '../../../adapters/jobs/localJobRunner.mjs'
import { bjLog } from '../../../common/debug/consoleFlags.mjs'

const notRunnable = (error, location = null) => ({ ok: false, notRunnable: true, error, durationMs: 0, location })

/**
 * @returns { ok, result?, error?, errorCode?, durationMs, location?, usage?, notRunnable? }
 */
export async function invokeJob ({
  trustedJobsDb, appTokenDb, localRunner,
  ownerApp, jobName, userId,
  params = {}, maxRuntime = '30s', hint = 'auto', isAdmin = false, token = null, flogger = null,
  // cloud path
  resourcesDb = null, resourceUsageDb = null, baseUrl = null, jobsDir = null, redeploy = false,
  // composition time budget: absolute ms deadline inherited from an outer job (null = top-level)
  deadline = null,
  // loadCloudSource: async () => the job code from the USER's own installed app, as
  //   { zip: Uint8Array }  — the pre-built per-job bundle (preferred; carries Tier-2 node_modules), or
  //   { source: string }   — just jobs/<name>/index.mjs (Tier-1 fallback), or
  //   null                 — not available (fall back to an admin-trusted local copy).
  // Lets a serverless run use the user's own app code WITHOUT an admin-trusted users_jobs copy
  // (serverless = the user's own compute; admin trust gates only LOCAL/in-process execution).
  // Called LAZILY — only when we actually (re)deploy, so a no-change invoke never loads a heavy zip.
  loadCloudSource = null,
  // Deploy-identity check (cloud): when these are supplied, a job re-ships ONLY if freezr's bundle code
  // or the job's own source/deps changed since the last deploy — otherwise the existing function is
  // invoked untouched (no manual Lambda delete needed after a freezr upgrade). All three optional;
  // without them, behaviour is unchanged (deploy only if absent or `redeploy` is forced).
  //   loadIdentitySource: async () => string  (the job's index.mjs + package.json/lockfile text)
  //   readDeployedId:     async () => string|null  (the marker stamped at last deploy)
  //   writeDeployedId:    async (id) => void       (stamp the marker after a successful deploy)
  loadIdentitySource = null, readDeployedId = null, writeDeployedId = null,
  // Selects the cloud runner for the user's compute credential by its provider (aws/google/azure).
  // Injectable for tests. The default dispatches through the provider registry — NOT hardcoded to AWS.
  makeCloudRunner = ({ provider, credentials, jobsDir: jd }) => makeCloudRunnerForProvider(provider, { credentials, jobsDir: jd })
}) {
  // Outer guard: invokeJob ALWAYS resolves to a structured result, never throws. Any unexpected
  // failure anywhere below (gate lookups, token mint, runner construction, the cloud call) becomes
  // a clean { ok:false, error, errorCode } the caller can return as a standard error.
  try {
    return await _runInvoke()
  } catch (e) {
    return { ok: false, error: 'job execution error: ' + (e && (e.message || String(e))), errorCode: 'JOB_ERROR', durationMs: 0 }
  }

  async function _runInvoke () {
  const trusted = await getTrustedJob(trustedJobsDb, ownerApp, jobName)
  const hasComputeToken = resourcesDb ? await userHasComputeCredential(resourcesDb) : false
  const decision = resolveJobLocation({
    hint,
    localTrust: trusted ? { audience: trusted.audience } : null,
    hasComputeToken,
    requestorId: userId,
    isAdmin
  })
  // notRunnable = a transient/config reason (not yet trusted, no compute, code absent) — distinct
  // from an actual run that errored. The scheduler treats notRunnable as "waiting" (no failure count).
  if (!decision.ok) return notRunnable(decision.reason || 'job not runnable here')

  const runToken = token || await mintJobToken(appTokenDb, { userId, appName: ownerApp, maxRuntimeMs: parseDurationMs(maxRuntime) })

  if (decision.location === 'local') {
    // LOCAL: requires the admin-trusted copy in users_jobs (in-process = full host trust → admin gate).
    if (!await localRunner.exists(ownerApp, jobName)) {
      return notRunnable('job code not installed (an admin must trust it for local runs): ' + ownerApp + '/' + jobName, 'local')
    }
    const out = await localRunner.run({ app: ownerApp, name: jobName, token: runToken, params, maxRuntime, flogger, deadline })
    return { ...out, location: 'local' }
  }

  // ── cloud (serverless) ───────────────────────────────────────────────────────────────────────
  // No admin trust required — it's the user's own compute. Source the code from the user's installed
  // app (loadCloudSource → appFS); fall back to a trusted local copy if present. baseUrl is OPTIONAL:
  // a job that never calls freezr.* runs without one (the transport errors only if a call is made).
  // Any provider the user has (not pinned to AWS) — the runner is then chosen by cred.provider.
  const cred = await getUserComputeCredential(resourcesDb, { provider: null })
  if (!cred) return notRunnable('no compute credential for serverless execution', 'cloud')

  let runner
  try {
    runner = makeCloudRunner({ provider: cred.provider, credentials: cred.credentials, jobsDir })
  } catch (e) {
    return { ok: false, notRunnable: true, error: e.message || String(e), durationMs: 0, location: 'cloud' }
  }

  // Decide whether to (re)deploy BEFORE loading any code, so a no-change invoke never reads a heavy
  // bundle. Redeploy when: explicitly forced, OR the deploy-identity changed since last deploy (freezr
  // upgraded or the job's source/deps changed), OR the function isn't there yet.
  let willDeploy = !!redeploy
  let currentId = null
  let stamped = null
  let fnExists = null
  let reason = redeploy ? 'forced (redeploy flag)' : null
  if (loadIdentitySource) {
    try {
      currentId = jobDeployIdentity({ jobIdentitySource: await loadIdentitySource() })
      stamped = readDeployedId ? await readDeployedId() : null
      if (!willDeploy && stamped !== currentId) { willDeploy = true; reason = stamped ? 'identity CHANGED' : 'no marker yet' }
    } catch (e) { /* identity unavailable → fall back to existence-based deploy below */ }
  }
  if (!willDeploy) {
    fnExists = false
    try { fnExists = (typeof runner.exists === 'function') ? await runner.exists({ ownerId: userId, app: ownerApp, name: jobName }) : false } catch (e) { fnExists = false }
    if (!fnExists) { willDeploy = true; reason = 'function ABSENT' }
  }
  if (!reason) reason = 'unchanged → invoke existing, SKIP deploy'
  // 🔎 TEMP DEBUG (review aid — remove after verifying): the redeploy decision for this cloud run.
  bjLog('🔎 [TMPJOBLOG JOB-DEPLOY] ' + ownerApp + '/' + jobName + ' provider=' + cred.provider +
    ' id=' + (currentId ? currentId.slice(0, 12) : 'n/a') + ' stamped=' + (stamped ? stamped.slice(0, 12) : 'none') +
    (fnExists !== null ? ' fnExists=' + fnExists : '') + ' → willDeploy=' + willDeploy + ' (' + reason + ')')

  // Source the job code only when we're actually shipping it (lazy — the expensive read).
  let jobZip = null
  let handlerSource = null
  if (willDeploy && loadCloudSource) {
    try {
      const cc = await loadCloudSource()
      if (cc && cc.zip) jobZip = cc.zip
      else if (cc && cc.source) handlerSource = cc.source
    } catch (e) { /* fall back to a trusted local copy */ }
  }
  if (willDeploy && !jobZip && !handlerSource && !await localRunner.exists(ownerApp, jobName)) {
    return notRunnable('job code not found for ' + ownerApp + '/' + jobName + ' (install the app, or have an admin trust it)', 'cloud')
  }

  const out = await runner.invoke({ ownerId: userId, app: ownerApp, name: jobName, baseUrl, token: runToken, params, redeploy: willDeploy, handlerSource, jobZip })

  // Stamp the deploy-identity marker after a successful (re)deploy, so the next run can skip it.
  if (willDeploy && out && out.ok && currentId && writeDeployedId) {
    try { await writeDeployedId(currentId) } catch (e) { /* non-fatal */ }
  }

  // Persist usage/cost (§9.2) — non-fatal; only when the runner reported a cost.
  if (resourceUsageDb && out && out.usage && out.usage.estCost != null) {
    try {
      await recordResourceUsage(resourceUsageDb, {
        ownerId: userId, appName: ownerApp, resource: 'serverless_job', ref: jobName,
        usage: out.usage, estCost: out.usage.estCost, currency: out.usage.currency
      })
    } catch (e) {
      if (flogger && flogger.warn) flogger.warn('resourceUsage write failed: ' + (e && e.message))
    }
  }

  return { ...out, location: 'cloud' }
  }
}

export default { invokeJob }
