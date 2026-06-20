// freezr.info — Jobs scheduler (deliberately boring)
//
// A single slow heartbeat (one timer, not one-per-job). Each tick: find due, not-locked jobs and
// run them SEQUENTIALLY (concurrency 1). After each run: advance that job's next_run_at
// (skip-don't-catch-up), record status, bump/reset consecutive_failures, auto-disable after K
// failures. A self-overlap lock + a process-level re-entrancy guard keep ticks from overlapping.
//
// Location-agnostic: it just calls invokeJob, which resolves local vs serverless. Scheduled runs
// have no live session, so a fresh short-lived session-less token is minted per run (jobTokenService).
//
// Single-scheduler-instance assumption: with one instance + sequential runs there is no race. If
// multiple freezr instances ever share a DB, the claim should become an atomic conditional update.
//
// On by default: startup calls start() (except when FREEZR_SCHEDULER_HEARTBEAT_OFF is set, which
// the test runner uses so tests drive tick() deterministically). The admin can pause scheduling via the main pref
// scheduler_disabled=true (checked each tick — no restart needed). The scheduler holds dsManager
// (it's infrastructure, like a route factory) and opens the db handles it needs, passing handles
// to the leaf services.

import { createLocalJobRunner } from '../../adapters/jobs/localJobRunner.mjs'
import { invokeJob } from './services/jobInvoker.mjs'
import { loadJobCodeFromAppFS, loadJobIdentitySource, readDeployedId, writeDeployedId } from './services/cloudJobSource.mjs'
import { listDueJobs, claimJob, recordRunResult, disableJob } from './services/scheduledJobsService.mjs'
import { isUserAdmin } from './services/userAdminStatus.mjs'
import { SCHEDULED_JOBS_OAC, userPERMS_OAC, TRUSTED_JOBS_OAC, APP_TOKEN_OAC, USER_DB_OAC } from '../../common/helpers/config.mjs'

export function createScheduler ({ dsManager, freezrPrefs, freezrStatus, logManager, heartbeatMs = 60 * 1000, maxFailures = 5, lockMs = 5 * 60 * 1000 } = {}) {
  const localRunner = createLocalJobRunner({ dsManager, freezrPrefs, freezrStatus, logManager })
  let timer = null
  let runningTick = false // re-entrancy guard: never let two ticks overlap

  // One pass: run all currently-due jobs, sequentially. Returns a summary (handy for tests/logs).
  async function tick () {
    // Admin off-switch (live, no restart): main pref scheduler_disabled === true pauses scheduling.
    // A DISABLE flag → existing servers (field absent/null) keep scheduling ON by default.
    if (freezrPrefs && freezrPrefs.scheduler_disabled === true) return { skipped: 'scheduler disabled by admin pref', ran: [] }
    if (runningTick) return { skipped: 'tick already in progress', ran: [] }
    runningTick = true
    const ran = []
    try {
      // ONE server-wide schedule collection (fradmin/reliable). We never iterate per-user
      // datastores — a user on an unreachable DB must not break the heartbeat. A user's own DB is
      // opened only for a job that is actually due (the grant check + the run itself).
      const scheduledJobsDb = await dsManager.getorInitDb(SCHEDULED_JOBS_OAC, { freezrPrefs })
      const trustedJobsDb = await dsManager.getorInitDb(TRUSTED_JOBS_OAC, { freezrPrefs })
      const appTokenDb = dsManager.getDB(APP_TOKEN_OAC)
      const usersDb = dsManager.getDB(USER_DB_OAC) // to resolve the owner's admin status (audience gate)

      const due = await listDueJobs(scheduledJobsDb)
      if (due.length) console.log('🗓️  scheduler tick: ' + due.length + ' due job(s)')
      for (const job of due) {
        await claimJob(scheduledJobsDb, job, lockMs)
        try {
          // A schedule row must have the user's SCHEDULE_JOB consent. If it's gone (revoked, or a
          // stale row from before scheduling was app-driven), DISABLE the row — don't spin "waiting"
          // forever. run_job is on-demand only and is NOT consulted here.
          const userPermsDb = await dsManager.getorInitDb(userPERMS_OAC(job.owner_id), { freezrPrefs })
          const grants = await userPermsDb.query({ requestor_app: job.app_name, type: 'schedule_job', job_name: job.job_name, granted: true }, {})
          if (!grants || !grants.length) {
            await disableJob(scheduledJobsDb, { userId: job.owner_id, appName: job.app_name, jobName: job.job_name })
            console.log('🗓️  ✗ disabled ' + job.owner_id + '/' + job.app_name + '/' + job.job_name + ' — schedule_job not granted')
            ran.push({ user: job.owner_id, app: job.app_name, job: job.job_name, ok: false, disabled: true, error: 'schedule_job not granted' })
            continue
          }
          // Resolve the owner's REAL admin status (the 'admins' audience gate) — not a session flag.
          const isAdmin = await isUserAdmin(usersDb, job.owner_id)
          // Cloud path needs the user's compute credential + a callback URL. No request here, so
          // baseUrl comes only from the admin pref; a cloud job without it lands 'waiting' (not failed).
          const resourcesDb = await dsManager.getorInitDb({ app_table: 'info.freezr.account.resources', owner: job.owner_id }, { freezrPrefs })
          const resourceUsageDb = await dsManager.getorInitDb({ app_table: 'info.freezr.account.resourceUsage', owner: job.owner_id }, { freezrPrefs })
          const out = await invokeJob({
            trustedJobsDb, appTokenDb, localRunner,
            resourcesDb, resourceUsageDb,
            baseUrl: (freezrPrefs && freezrPrefs.serverless_callback_url) || null,
            ownerApp: job.app_name, jobName: job.job_name, userId: job.owner_id,
            maxRuntime: job.maxRuntime || '30s',
            hint: grants[0].location || 'auto',
            isAdmin,
            // CLOUD: source the job code + deploy-identity from the owner-user's own installed app (no
            // admin trust), via the shared loader (base64-text bundle → binary → single index.mjs, and
            // the marker that re-ships the function only when freezr's code or the job changed). All
            // share a memoized appFS, built only when a cloud callback actually fires.
            ...(() => {
              let _appFS = null
              const appFSFor = async () => {
                if (!_appFS) { const uds = await dsManager.getOrSetUserDS(job.owner_id, { freezrPrefs }); _appFS = await uds.getorInitAppFS(job.app_name, {}) }
                return _appFS
              }
              return {
                loadCloudSource: async () => loadJobCodeFromAppFS(await appFSFor(), job.job_name),
                loadIdentitySource: async () => loadJobIdentitySource(await appFSFor(), job.job_name),
                readDeployedId: async () => readDeployedId(await appFSFor(), job.job_name),
                writeDeployedId: async (id) => writeDeployedId(await appFSFor(), job.job_name, id)
              }
            })()
          })
          const res = await recordRunResult(scheduledJobsDb, job, { ok: !!out.ok, error: out.error, notRunnable: !!out.notRunnable, maxFailures })
          const tag = out.ok ? '✓ ran' : (out.notRunnable ? '⏳ waiting' : '✗ error')
          console.log('🗓️  ' + tag + ' ' + job.owner_id + '/' + job.app_name + '/' + job.job_name + (out.error ? ' — ' + out.error : '') + (res.autoDisabled ? ' (auto-disabled)' : ''))
          ran.push({ user: job.owner_id, app: job.app_name, job: job.job_name, ok: !!out.ok, waiting: !!res.waiting, autoDisabled: !!res.autoDisabled, error: out.error || null })
        } catch (e) {
          console.error('🗓️  scheduler job error ' + job.app_name + '/' + job.job_name + ':', e && e.message)
          try { await recordRunResult(scheduledJobsDb, job, { ok: false, error: e && (e.message || String(e)), maxFailures }) } catch (e2) { /* best effort */ }
          ran.push({ user: job.owner_id, app: job.app_name, job: job.job_name, ok: false, error: e && (e.message || String(e)) })
        }
      }
    } finally {
      runningTick = false
    }
    return { ran }
  }

  function start () {
    if (!timer) timer = setInterval(() => { tick().catch(e => console.error('scheduler tick error:', e)) }, heartbeatMs)
    return scheduler
  }
  function stop () { if (timer) { clearInterval(timer); timer = null } }

  const scheduler = { tick, start, stop }
  return scheduler
}

export default { createScheduler }
