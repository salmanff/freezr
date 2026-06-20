// freezr.info — Trusted Job service (the local-trust gate, plan §4.2/§4.3)
//
// A "trusted job" is one an admin has approved to run IN-PROCESS on the server, with an
// audience (who may use it). This is a server-wide registry (the TRUSTED_JOBS_OAC db, owned
// by fradmin), distinct from the per-user run_job permission grant. resolveJobLocation()
// consumes these records as the `localTrust` gate.
//
// PRINCIPLE: these functions receive the already-opened `trustedJobsDb` handle — NOT dsManager.
// Choosing which db to open is the caller's job (a context middleware, or the admin controller
// which legitimately holds dsManager), so a leaf service can never reach beyond its one table.
//
// This module manages the trust RECORDS only. Copying the job's code from its app into
// users_jobs/<app>/<name>/ is done by the admin install flow.

/**
 * @returns the trust record { app_name, job_name, audience, trusted } or null.
 */
export async function getTrustedJob (trustedJobsDb, appName, jobName) {
  if (!trustedJobsDb || !appName || !jobName) return null
  const recs = await trustedJobsDb.query({ app_name: appName, job_name: jobName }, {})
  const rec = recs && recs[0]
  return (rec && rec.trusted) ? rec : null
}

export async function listTrustedJobs (trustedJobsDb) {
  if (!trustedJobsDb) return []
  return (await trustedJobsDb.query({}, {})) || []
}

/**
 * Trust (or re-trust) a job for in-process execution.
 * @param {Object} trustedJobsDb  the opened TRUSTED_JOBS_OAC db handle
 * @param {Object} args
 * @param {string} args.appName
 * @param {string} args.jobName
 * @param {('admins'|'all_users'|string[])} [args.audience='admins']  who may use it (conservative default)
 * @param {string} [args.installedBy]  admin user id
 * @param {string} [args.codeId]  content identity of the trusted code (to detect later changes)
 */
export async function trustJob (trustedJobsDb, { appName, jobName, audience = 'admins', installedBy = null, codeId = null }) {
  if (!trustedJobsDb) throw new Error('trustJob: trustedJobsDb handle required')
  if (!appName || !jobName) throw new Error('trustJob: appName and jobName required')
  const record = {
    app_name: appName,
    job_name: jobName,
    audience,
    trusted: true,
    installed_by: installedBy,
    code_id: codeId, // identity of the approved code; a later re-install with a different id disables trust
    disabled_reason: null,
    _date_trusted: Date.now()
  }
  const existing = await trustedJobsDb.query({ app_name: appName, job_name: jobName }, {})
  if (existing && existing[0]) {
    await trustedJobsDb.update(existing[0]._id, record, { replaceAllFields: true })
    return { ...record, _id: existing[0]._id }
  }
  const created = await trustedJobsDb.create(null, record, {})
  return { ...record, _id: created?._id }
}

/**
 * DISABLE a trusted job (set trusted:false) without deleting the record — so the admin page can show
 * it as "needs re-trust" and the audience is preserved. getTrustedJob returns null for it (→ the local
 * gate treats it as untrusted). Used when a re-install changes an already-trusted job's code.
 */
export async function disableTrustedJob (trustedJobsDb, appName, jobName, reason = 'code_changed') {
  if (!trustedJobsDb || !appName || !jobName) return { disabled: 0 }
  const existing = await trustedJobsDb.query({ app_name: appName, job_name: jobName }, {})
  if (!existing || !existing[0]) return { disabled: 0 }
  await trustedJobsDb.update(existing[0]._id, { trusted: false, disabled_reason: reason, _date_disabled: Date.now() }, { replaceAllFields: false })
  return { disabled: 1 }
}

export async function untrustJob (trustedJobsDb, appName, jobName) {
  if (!trustedJobsDb || !appName || !jobName) return { deletedCount: 0 }
  const result = await trustedJobsDb.delete_records({ app_name: appName, job_name: jobName }, { multi: true })
  return { deletedCount: result?.nRemoved ?? 0 }
}

export default { getTrustedJob, listTrustedJobs, trustJob, disableTrustedJob, untrustJob }
