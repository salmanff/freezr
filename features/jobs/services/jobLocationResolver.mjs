// freezr.info — Job location resolver (Phase 5) jobLocationResolver.mjs (r0)
//
// Decides WHERE a job runs — local (in-process, admin-trusted) vs serverless (the
// user's cloud) — hidden from the app. Implements the model agreed in
// freezr-jobs-plan.md §4: one `run_job` permission with an optional `location` hint,
// subordinate to two consent gates owned by different authorities:
//   - local-trust gate  : ADMIN — may this job's code run in-process on the host?
//                          (and an audience: who may use the locally-installed copy)
//   - cloud-cost gate    : USER — does the user have a compute token (their cloud spend)?
//
// The app's `location` hint ('auto' | 'local' | 'cloud') only narrows the choice within
// what the gates already allow; it never overrides them.
//
// This is a PURE function — the caller supplies the gate facts (localTrust, hasComputeToken)
// from their own sources (admin trust store, the user's compute resources). It has no I/O.

/**
 * @param {Object} audience  admin's audience for the locally-installed job:
 *   'all_users' | 'admins' | string[] (allowed user ids). Undefined => 'admins' (conservative).
 */
export function audienceAllows (audience, { requestorId = null, isAdmin = false } = {}) {
  if (audience === 'all_users') return true
  if (Array.isArray(audience)) return !!requestorId && audience.includes(requestorId)
  // undefined / 'admins' / anything else => admins only (conservative default, plan §4.3)
  return !!isAdmin
}

/**
 * @param {Object}  args
 * @param {string}  [args.hint='auto']        'auto' | 'local' | 'cloud' (from the run_job perm)
 * @param {Object}  [args.localTrust=null]    admin trust record { audience } if the job is
 *                                            installed+trusted locally; null if not.
 * @param {boolean} [args.hasComputeToken=false]  does the user have a compute credential?
 * @param {string}  [args.requestorId=null]
 * @param {boolean} [args.isAdmin=false]
 * @returns {{ ok: boolean, location: 'local'|'cloud'|null, reason?: string }}
 */
export function resolveJobLocation ({ hint = 'auto', localTrust = null, hasComputeToken = false, requestorId = null, isAdmin = false } = {}) {
  const canLocal = !!localTrust && audienceAllows(localTrust.audience, { requestorId, isAdmin })
  const canCloud = !!hasComputeToken
  const h = hint || 'auto'

  if (h === 'local') {
    return canLocal
      ? { ok: true, location: 'local' }
      : { ok: false, location: null, reason: 'local execution not available (job not admin-trusted for this user)' }
  }
  if (h === 'cloud') {
    // Explicit cloud opt-out of local: do NOT silently fall back to local.
    return canCloud
      ? { ok: true, location: 'cloud' }
      : { ok: false, location: null, reason: 'no compute token for serverless execution' }
  }
  // auto: local-first (cheaper/faster for the user), else cloud, else error.
  if (canLocal) return { ok: true, location: 'local' }
  if (canCloud) return { ok: true, location: 'cloud' }
  return { ok: false, location: null, reason: 'no execution location available for this job' }
}

export default { resolveJobLocation, audienceAllows }
