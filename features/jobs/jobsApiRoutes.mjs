// freezr.info — Jobs API routes (production) JobsApiRoutes.mjs (r1)
//
//   POST /jobs/run/:name   — run-now: run a trusted local job with the caller's token,
//                            gated by the trusted-job + audience + location resolver.
//
// Test-only helpers (/jobs/selftest/*) live in jobsTestRoutes.mjs and are mounted at /jobs
// ONLY when FREEZR_TEST_MODE (see froutes). Nothing test-related is registered in production.

import { Router } from 'express'
import { createSetupGuard, createGetAppTokenInfoFromheaderForApi } from '../../middleware/auth/basicAuth.mjs'
import { apiRateLimit } from '../../middleware/auth/apiRateLimiter.mjs'
import { addDataOwnerToContext, createAddUserAppList } from '../apps/middleware/appContext.mjs'
import { createaddOwnerPermsDb } from '../../middleware/permissions/permissionContext.mjs'
import { sendApiSuccess, sendFailure } from '../../adapters/http/responses.mjs'
import { createLocalJobRunner } from '../../adapters/jobs/localJobRunner.mjs'
import { invokeJob } from './services/jobInvoker.mjs'
import { loadJobCodeFromAppFS, loadJobIdentitySource, readDeployedId, writeDeployedId } from './services/cloudJobSource.mjs'
import { getTrustedJob } from './services/trustedJobService.mjs'
import { enableJob, disableJob, isValidSchedule } from './services/scheduledJobsService.mjs'
import { userHasComputeCredential } from './services/computeCredentialService.mjs'
import { isUserAdmin } from './services/userAdminStatus.mjs'
import { USER_DB_OAC } from '../../common/helpers/config.mjs'
import { createAddTrustedJobsDb, createAddAppTokenDb, createAddComputeResourcesDb, createAddResourceUsageDb, createAddScheduledJobsDb } from './middleware/jobsContext.mjs'

// Public freezr base URL the deployed serverless function calls back to: the admin pref if set,
// else the request's own host (fine for local/same-network; real Lambda needs the public pref).
const serverlessCallbackUrl = (req, freezrPrefs) =>
  (freezrPrefs && freezrPrefs.serverless_callback_url) || (req.protocol + '://' + req.get('host'))

// NOTE (future refactor): the handler bodies below (parseJobId, runNow, etc.) are the controller
// layer, not route wiring. The rest of the codebase splits these out (e.g. accountApiController vs
// accountApiRoutes); it may be cleaner to move them to a jobsApiController.mjs for consistency. Kept
// inline for now so the whole jobs surface reads in one place.

// A job is addressed like a collection: <ownerApp>.jobs.<jobName> (the "jobs" segment is
// reserved). A bare name (no dots) is the CALLER's own job → owner = caller. A dotted name is a
// fully-qualified THIRD-PARTY job. Returns null if malformed.
const JOBS_SEG = '.jobs.'
const parseJobId = (raw, callerApp) => {
  if (!raw || typeof raw !== 'string') return null
  if (raw.includes('.')) {
    const i = raw.indexOf(JOBS_SEG)
    if (i <= 0) return null // has dots but not the <app>.jobs.<name> convention
    const ownerApp = raw.slice(0, i)
    const jobName = raw.slice(i + JOBS_SEG.length)
    if (!/^[a-zA-Z0-9._-]+$/.test(ownerApp) || ownerApp.includes('..')) return null
    if (!/^[a-zA-Z0-9_-]+$/.test(jobName)) return null // single segment, no further dots
    return { ownerApp, jobName, qualifiedId: raw, isThirdParty: ownerApp !== callerApp }
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(raw)) return null
  return { ownerApp: callerApp, jobName: raw, qualifiedId: callerApp + JOBS_SEG + raw, isThirdParty: false }
}

export const createJobsApiRoutes = ({ dsManager, freezrPrefs, freezrStatus, logManager }) => {
  const router = Router()

  const setupGuard = createSetupGuard(dsManager, freezrPrefs)
  const getAppTokenInfo = createGetAppTokenInfoFromheaderForApi(dsManager, freezrPrefs, freezrStatus)
  const addOwnerPermDBs = createaddOwnerPermsDb(dsManager, freezrPrefs, freezrStatus)
  const addTrustedJobsDb = createAddTrustedJobsDb(dsManager, freezrPrefs)
  const addAppTokenDb = createAddAppTokenDb(dsManager)
  const addComputeResourcesDb = createAddComputeResourcesDb(dsManager, freezrPrefs)
  const addResourceUsageDb = createAddResourceUsageDb(dsManager, freezrPrefs)
  const addUserAppList = createAddUserAppList(dsManager, freezrPrefs)
  const addScheduledJobsDb = createAddScheduledJobsDb(dsManager, freezrPrefs)
  const localRunner = createLocalJobRunner({ dsManager, freezrPrefs, freezrStatus, logManager })

  const bearerFrom = (req) => {
    const h = req.headers.authorization || ''
    return h.startsWith('Bearer ') ? h.substring(7) : null
  }

  // Cloud-source callbacks for one (user, app, job), all sharing a memoized appFS (built only when a
  // cloud callback actually fires — a local run touches none of these). Source the job code from the
  // user's OWN installed app (no admin trust); resolve/stamp the deploy-identity marker so a function
  // re-ships only when freezr's code or the job's source/deps changed. (See services/cloudJobSource.)
  const cloudSourceFor = (userId, ownerApp, jobName) => {
    let _appFS = null
    const appFSFor = async () => {
      if (!_appFS) { const uds = await dsManager.getOrSetUserDS(userId, { freezrPrefs }); _appFS = await uds.getorInitAppFS(ownerApp, {}) }
      return _appFS
    }
    return {
      loadCloudSource: async () => loadJobCodeFromAppFS(await appFSFor(), jobName),
      loadIdentitySource: async () => loadJobIdentitySource(await appFSFor(), jobName),
      readDeployedId: async () => readDeployedId(await appFSFor(), jobName),
      writeDeployedId: async (id) => writeDeployedId(await appFSFor(), jobName, id)
    }
  }

  /**
   * POST /jobs/run/:name   — run-now (local executor)
   * `:name` is a job id (see parseJobId): a bare name is the caller's OWN job; a
   * <ownerApp>.jobs.<jobName> id is a THIRD-PARTY job the caller doesn't hold a copy of.
   *
   * A job always runs AS ITS OWNER app (owner-context): it accesses the owner app's tables for
   * the current user; reaching any other data needs the normal CEPS permissions. So:
   *   - own job       → run with the caller's own token (already the owner's).
   *   - third-party   → caller must hold a granted run_job permission for the qualified id, and
   *                     freezr mints a short-lived session-less token for (user, ownerApp) so the
   *                     job runs as the owner. The caller gets to *trigger* it, not to see owner data.
   * Gates: trusted-job (admin) + audience + the location resolver. Body: { params?, maxRuntime? }.
   * Returns { ok, result, error, durationMs }.
   */
  const runNow = async (req, res) => {
   try {
    const callerApp = res.locals.freezr.tokenInfo.app_name
    const userId = res.locals.freezr.tokenInfo.owner_id
    const callerToken = bearerFrom(req)
    if (!callerToken) return sendFailure(res, 'missing token', 'jobs.runNow', 400)

    const parsed = parseJobId(req.params.name, callerApp)
    if (!parsed) return sendFailure(res, 'invalid job id: ' + req.params.name, 'jobs.runNow', 400)
    const { ownerApp, jobName, qualifiedId, isThirdParty } = parsed

    // run_job permission: REQUIRED for third-party (cross-app authorization); for an app's own
    // job it's optional and only supplies the location hint. Keyed on job_name (the job id the app
    // called with) — the perm's own `name` is just its unique label, not the job id.
    let grant = null
    try {
      const perms = await res.locals.freezr.ownerPermsDb.query({ requestor_app: callerApp, type: 'run_job', job_name: req.params.name, granted: true }, {})
      grant = perms && perms[0]
    } catch (e) { /* no perm record */ }
    if (isThirdParty && !grant) {
      return sendFailure(res, 'app ' + callerApp + ' is not permitted to run ' + qualifiedId, 'jobs.runNow', 403)
    }
    let hint = grant?.location || 'auto'
    // Dev-only convenience: when the user's grant is 'auto', the invoking app may narrow this run to
    // 'local'/'cloud' via the request body. The consent gates (trust / compute credential) still apply.
    if (hint === 'auto' && (req.body.location === 'local' || req.body.location === 'cloud')) hint = req.body.location

    // Delegate to the shared invoker: it applies the trusted-job + audience + compute gates,
    // resolves local vs cloud, mints a token when needed, and (cloud) deploys/invokes + meters cost.
    // The job runs AS ITS OWNER: own job → caller's token (already the owner's); third-party →
    // token:null so invokeJob mints a short-lived session-less token for (user, ownerApp).
    const out = await invokeJob({
      trustedJobsDb: res.locals.freezr.trustedJobsDb,
      appTokenDb: res.locals.freezr.appTokenDb,
      localRunner,
      resourcesDb: res.locals.freezr.computeResourcesDb,
      resourceUsageDb: res.locals.freezr.resourceUsageDb,
      baseUrl: serverlessCallbackUrl(req, freezrPrefs),
      ownerApp,
      jobName,
      userId,
      params: req.body.params || {},
      maxRuntime: req.body.maxRuntime || '30s',
      hint,
      // The 'admins' audience gate. Check the (trustworthy, server-set) session flag FIRST so a real
      // admin session skips the DB hit; an app-token request rarely carries it, so we then fall back to
      // the user's REAL admin status from their record. (The synthetic in-process req has an empty
      // session, so a job can't spoof this — admin then resolves solely from the DB record.)
      isAdmin: !!req.session?.logged_in_as_admin || (await isUserAdmin(dsManager.getDB(USER_DB_OAC), userId)),
      token: isThirdParty ? null : callerToken,
      // force a fresh code upload before a cloud invoke (dev iteration): body {redeploy:true} or ?redeploy=1
      redeploy: req.body.redeploy === true || req.query.redeploy === '1',
      // composition: a job calling another job carries the outer job's deadline (set by the in-process
      // transport) so the whole tree stays within the outermost maxRuntime.
      deadline: Number(req.headers['x-freezr-job-deadline']) || null,
      // For a CLOUD run, source the job code + deploy-identity from the user's OWN installed app
      // (no admin trust). The bundle is read lazily (only on (re)deploy), and the function re-ships
      // only when freezr's code or the job's source/deps changed since the last deploy.
      ...cloudSourceFor(userId, ownerApp, jobName),
      flogger: res.locals.flogger
    })

    res.locals.freezr.permGiven = true
    // notRunnable = a gate/config refusal (untrusted, audience, no compute, code absent) → 403.
    if (out.notRunnable) return sendFailure(res, out.error || 'job not runnable here', 'jobs.runNow', 403)
    // Ran but FAILED (handler threw / cloud FunctionError / transport / callback unreachable) →
    // a STANDARD error response with a clear message, not a 200 ok:false envelope. Cloud failures
    // → 502 (the user's compute backend), local → 500.
    if (!out.ok) return sendFailure(res, 'job "' + req.params.name + '" failed: ' + (out.error || 'unknown error'), 'jobs.runNow', (out.location === 'cloud' ? 502 : 500))
    return sendApiSuccess(res, out)
   } catch (e) {
     // Last-resort guard: any unexpected throw still returns a standard error, never a raw 500 stack.
     return sendFailure(res, 'job run error: ' + (e && (e.message || String(e))), 'jobs.runNow', 500)
   }
  }

  router.post('/run/:name', setupGuard, getAppTokenInfo, apiRateLimit, addDataOwnerToContext, addOwnerPermDBs, addTrustedJobsDb, addAppTokenDb, addComputeResourcesDb, addResourceUsageDb, runNow)

  /**
   * POST /jobs/compute/create_role — convenience for the account "Compute providers" UI. An execution
   * ROLE is an AWS concept (IAM Lambda role); other providers use a different model (GCP service
   * accounts, Azure managed identity) set up at credential time, so this dispatches by provider rather
   * than assuming AWS. AWS: create (or fetch) the IAM role and return its ARN. Body:
   * { provider?='aws', accessKeyId, secretAccessKey, region }; returns { arn }.
   */
  const createRole = async (req, res) => {
    const { provider = 'aws', accessKeyId, secretAccessKey, region } = req.body || {}
    if (provider !== 'aws') return sendFailure(res, "compute role setup is not required/supported for provider '" + provider + "' (only AWS uses an IAM execution role)", 'jobs.createRole', 400)
    if (!accessKeyId || !secretAccessKey) return sendFailure(res, 'accessKeyId and secretAccessKey are required', 'jobs.createRole', 400)
    const { ensureLambdaRole } = await import('../../adapters/jobs/awsJobRunner.mjs')
    const r = await ensureLambdaRole({ credentials: { accessKeyId, secretAccessKey, region } })
    res.locals.freezr.permGiven = true
    if (r.error) return sendFailure(res, r.error, 'jobs.createRole', 400)
    return sendApiSuccess(res, r)
  }

  router.post('/compute/create_role', setupGuard, getAppTokenInfo, apiRateLimit, createRole)

  /**
   * POST /jobs/schedule/:name — the APP starts the recurring schedule for its own job :name.
   * Scheduling is NOT auto-started on permission grant (the user only consents); the app decides
   * when it's meaningful to run. Requires a granted schedule_job for this job; reads the schedule
   * from the app's manifest and the location from the grant.
   */
  const scheduleNow = async (req, res) => {
    const callerApp = res.locals.freezr.tokenInfo.app_name
    const userId = res.locals.freezr.tokenInfo.owner_id
    const jobName = req.params.name
    const grants = await res.locals.freezr.ownerPermsDb.query({ requestor_app: callerApp, type: 'schedule_job', job_name: jobName, granted: true }, {})
    const grant = grants && grants[0]
    if (!grant) return sendFailure(res, 'schedule_job not granted for ' + jobName + ' — the user must grant scheduling first', 'jobs.schedule', 403)

    const appRows = await res.locals.freezr.userAppListDb.query({ app_name: callerApp }, {})
    const manifest = appRows && appRows[0] && appRows[0].manifest
    const job = ((manifest && Array.isArray(manifest.jobs)) ? manifest.jobs : []).find(j => j && j.name === jobName && j.schedule)
    if (!job) return sendFailure(res, 'job ' + jobName + ' does not declare a schedule in the app manifest', 'jobs.schedule', 400)
    if (!isValidSchedule(job.schedule)) return sendFailure(res, 'invalid schedule "' + job.schedule + '" (minutely is dev/test only)', 'jobs.schedule', 400)

    await enableJob(res.locals.freezr.scheduledJobsDb, { userId, appName: callerApp, jobName: job.name, schedule: job.schedule, maxRuntime: job.maxRuntime || null, location: grant.location || 'auto' })
    res.locals.freezr.permGiven = true
    return sendApiSuccess(res, { scheduled: true, job: jobName, schedule: job.schedule, location: grant.location || 'auto' })
  }
  router.post('/schedule/:name', setupGuard, getAppTokenInfo, apiRateLimit, addDataOwnerToContext, addOwnerPermDBs, addUserAppList, addScheduledJobsDb, scheduleNow)

  /** POST /jobs/unschedule/:name — the app stops the recurring schedule for its own job. */
  const unscheduleNow = async (req, res) => {
    const callerApp = res.locals.freezr.tokenInfo.app_name
    const userId = res.locals.freezr.tokenInfo.owner_id
    const out = await disableJob(res.locals.freezr.scheduledJobsDb, { userId, appName: callerApp, jobName: req.params.name })
    res.locals.freezr.permGiven = true
    return sendApiSuccess(res, { unscheduled: !!out.disabled, job: req.params.name })
  }
  router.post('/unschedule/:name', setupGuard, getAppTokenInfo, apiRateLimit, addDataOwnerToContext, addOwnerPermDBs, addScheduledJobsDb, unscheduleNow)

  /**
   * GET /jobs/ping — tells the app what it can do: for each job it has a run_job/schedule_job
   * permission for, whether it's granted, admin-trusted (local), currently scheduled, and the
   * resolved location; plus whether the user has a compute credential (serverless available).
   * Lets an app decide if/where to run before trying.
   */
  const ping = async (req, res) => {
    const callerApp = res.locals.freezr.tokenInfo.app_name
    const userId = res.locals.freezr.tokenInfo.owner_id
    const perms = (await res.locals.freezr.ownerPermsDb.query({ requestor_app: callerApp }, {})) || []
    const jobPerms = perms.filter(p => (p.type === 'run_job' || p.type === 'schedule_job') && p.job_name)
    const hasCompute = await userHasComputeCredential(res.locals.freezr.computeResourcesDb)

    const jobs = {}
    for (const jn of [...new Set(jobPerms.map(p => p.job_name))]) {
      const runG = jobPerms.find(p => p.type === 'run_job' && p.job_name === jn && p.granted)
      const schG = jobPerms.find(p => p.type === 'schedule_job' && p.job_name === jn && p.granted)
      const parsed = parseJobId(jn, callerApp)
      let trusted = false
      let scheduled = false
      if (parsed) {
        trusted = !!(await getTrustedJob(res.locals.freezr.trustedJobsDb, parsed.ownerApp, parsed.jobName))
        const rows = await res.locals.freezr.scheduledJobsDb.query({ owner_id: userId, app_name: parsed.ownerApp, job_name: parsed.jobName }, {})
        scheduled = !!(rows && rows[0] && rows[0].enabled !== false)
      }
      jobs[jn] = {
        run_job_granted: !!runG,
        schedule_job_granted: !!schG,
        trusted,                      // admin-trusted → can run locally (in-process)
        scheduled,                    // an active schedule row exists
        location: (schG && schG.location) || (runG && runG.location) || 'auto'
      }
    }
    res.locals.freezr.permGiven = true
    return sendApiSuccess(res, { has_compute: hasCompute, jobs })
  }
  router.get('/ping', setupGuard, getAppTokenInfo, apiRateLimit, addDataOwnerToContext, addOwnerPermDBs, addTrustedJobsDb, addScheduledJobsDb, addComputeResourcesDb, ping)

  return router
}

export default { createJobsApiRoutes }
