// freezr.info — Scheduled jobs store (the schedule table)
//
// One row per enabled (user, app, job). The scheduler heartbeat reads it to find due jobs.
// Handle-based (the caller opens SCHEDULED_JOBS_OAC and passes the db handle) per the freezr
// principle. Coarse frequencies only — no cron. 'minutely' is a dev/test convenience (allowed
// only when NODE_ENV !== 'production'); hourly/daily/weekly are always valid.

const SCHEDULE_MS = {
  minutely: 60 * 1000, // test-only
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000
}

// 'minutely' is a dev/test convenience (so the scheduler is observable without waiting hours);
// it is NOT allowed in production. hourly/daily/weekly are always valid.
export const minutelyAllowed = () => process.env.NODE_ENV !== 'production'
export const isValidSchedule = (s) =>
  Object.prototype.hasOwnProperty.call(SCHEDULE_MS, s) && (s !== 'minutely' || minutelyAllowed())

export const scheduleIntervalMs = (s) => SCHEDULE_MS[s] || null

// Skip-don't-catch-up: the next slot is always interval-from-now, so missed runs are never replayed.
// (Anchored to run-time, not a clock grid, so a minutely job effectively lands every ~60-120s
// depending on heartbeat phase — fine for coarse scheduling.)
export const computeNextRunAt = (schedule, fromMs = Date.now()) =>
  fromMs + (SCHEDULE_MS[schedule] || SCHEDULE_MS.daily)

/** Enable (or re-enable / update) a scheduled job. Returns the record. */
export async function enableJob (db, { userId, appName, jobName, schedule, maxRuntime = null, nextRunAt, location = 'auto' }) {
  if (!db) throw new Error('scheduledJobsService: db handle required')
  if (!userId || !appName || !jobName || !schedule) throw new Error('enableJob: userId, appName, jobName, schedule required')
  const record = {
    owner_id: userId,
    app_name: appName,
    job_name: jobName,
    schedule,
    maxRuntime,
    location, // where scheduled runs go (auto|local|cloud) — the user's choice on the schedule_job grant
    enabled: true,
    next_run_at: (typeof nextRunAt === 'number') ? nextRunAt : computeNextRunAt(schedule),
    last_run_at: null,
    last_status: null,
    last_error: null,
    consecutive_failures: 0,
    locked_until: null
  }
  const existing = await db.query({ owner_id: userId, app_name: appName, job_name: jobName }, {})
  if (existing && existing[0]) {
    const merged = { ...existing[0], ...record }
    await db.update(existing[0]._id, merged, { replaceAllFields: true })
    return merged
  }
  const created = await db.create(null, record, {})
  return { ...record, _id: created?._id }
}

export async function disableJob (db, { userId, appName, jobName }) {
  const existing = await db.query({ owner_id: userId, app_name: appName, job_name: jobName }, {})
  if (!existing || !existing[0]) return { disabled: false }
  await db.update(existing[0]._id, { ...existing[0], enabled: false, locked_until: null }, { replaceAllFields: true })
  return { disabled: true }
}

/** Jobs that are enabled, due (next_run_at <= now), and not currently locked. */
export async function listDueJobs (db, nowMs = Date.now()) {
  const all = await db.query({ enabled: true }, {})
  return (all || []).filter(j =>
    (j.next_run_at ?? 0) <= nowMs && (!j.locked_until || j.locked_until <= nowMs)
  )
}

/** Self-overlap lock: mark the job locked so a later tick won't double-run it (expires on its own). */
export async function claimJob (db, job, lockMs) {
  await db.update(job._id, { ...job, locked_until: Date.now() + lockMs }, { replaceAllFields: true })
}

/**
 * Record the outcome of a run: advance next_run_at (skip-don't-catch-up), set status, bump/reset
 * consecutive_failures, clear the lock, and auto-disable after maxFailures consecutive failures.
 * Returns the changed fields.
 */
export async function recordRunResult (db, job, { ok, error = null, notRunnable = false, maxFailures = 5 }) {
  // "Waiting": the job is due but not yet runnable (run_job not granted, not trusted, no compute,
  // code absent). Not a failure — advance to the next slot, keep enabled, don't count toward
  // auto-disable. It'll start on its own once it becomes runnable.
  if (notRunnable) {
    const changes = {
      last_run_at: Date.now(),
      last_status: 'waiting',
      last_error: error || null,
      next_run_at: computeNextRunAt(job.schedule),
      locked_until: null
    }
    await db.update(job._id, { ...job, ...changes }, { replaceAllFields: true })
    return { ...changes, waiting: true }
  }
  const consecutive = ok ? 0 : ((job.consecutive_failures || 0) + 1)
  const autoDisabled = !ok && consecutive >= maxFailures
  const changes = {
    last_run_at: Date.now(),
    last_status: ok ? 'ok' : 'error',
    last_error: ok ? null : (error || 'error'),
    consecutive_failures: consecutive,
    next_run_at: computeNextRunAt(job.schedule),
    locked_until: null,
    enabled: autoDisabled ? false : (job.enabled !== false)
  }
  await db.update(job._id, { ...job, ...changes }, { replaceAllFields: true })
  return { ...changes, autoDisabled }
}

/**
 * Permission-change trigger for **schedule_job**. Granting it is CONSENT only — it does NOT start the
 * schedule (the app decides when, via freezr.jobs.schedule → POST /jobs/schedule/:name; e.g. many
 * jobs make no sense until the app has set things up). REVOKING it stops any active schedule. No-op
 * for any other perm type. (run_job is on-demand only and never touches scheduling.)
 *
 * @param {Object} scheduledJobsDb  opened SCHEDULED_JOBS_OAC handle
 * @param {Object} args  { userId, appName, permType, jobName, granted }
 */
export async function syncScheduleForPermissionChange (scheduledJobsDb, { userId, appName, permType, jobName, granted }) {
  if (permType !== 'schedule_job' || !jobName) return { changed: false }
  if (granted) {
    // Consent recorded — but DON'T enrol the schedule. The app starts it on its own terms.
    return { changed: false, consentOnly: true }
  }
  // Revoked → stop any running schedule for this job immediately.
  const r = await disableJob(scheduledJobsDb, { userId, appName, jobName })
  if (r.disabled) console.log('🗓️  unscheduled ' + appName + '/' + jobName + ' for ' + userId + ' (schedule_job revoked)')
  return { changed: !!r.disabled, disabled: !!r.disabled }
}

export default { isValidSchedule, scheduleIntervalMs, computeNextRunAt, enableJob, disableJob, listDueJobs, claimJob, recordRunResult, syncScheduleForPermissionChange }
