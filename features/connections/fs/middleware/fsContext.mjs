// freezr.info - fs connections feature: per-request context + local-store gate
//
// fsContext is the shared connections context bound to service 'fs': it loads the
// caller's granted use_file_sys perms (fail-closed connection_names matching), loads
// and decrypts the connection record from :connectionName, enforces the two-level
// write gate (granted.scopes includes 'write' AND connection.access.fs ===
// 'readwrite'; read routes mount markReadOnly first), and sets
// res.locals.freezr.fsPermission / fsConnection + permGiven.
//
// localFsGate is the EXTRA gate for stores with fsParams.type 'local'. Cloud stores
// are naturally guarded — possessing the credential proves the user owns the store.
// A local store has no credential, and on a localhost config the local disk is also
// where the system fs lives, so ownership is proven structurally instead. ALL of the
// following must hold, re-checked on EVERY request (not just at store creation), so
// flipping the pref off or de-adminning a user kills access immediately:
//   1. the server's own system fs is local (a cloud-hosted server's "local" disk is
//      the server's territory, not the user's — the option must not exist there);
//   2. the admin master pref `local_fs_access_enabled` is on (off by default);
//   3. the requesting user is an admin;
//   4. the request comes from a TRUSTED ORIGIN (see below).
// Path confinement (rootPath outside the freezr tree, symlink-vetted resolution) is
// enforced separately in fsService.mjs on every operation.
//
// TRUSTED ORIGIN — exactly two recognized forms, and adding a third is a deliberate
// security decision, never a loosening of an existing check:
//   (a) a LOOPBACK REQUEST: loopback remote address AND a localhost Host header. The
//       remote address is authoritative (the Host header is client-supplied); together
//       they ensure a local-fs server that is ALSO exposed via a domain cannot reach
//       local stores from outside the machine.
//   (b) an IN-PROCESS JOB: req.freezrInProcessJob, set only by adapters/jobs/
//       internalApiClient.mjs on the synthetic req it builds. A job has no socket, so
//       (a) can never pass for one — but a job IS running on this machine, inside this
//       process, executing code an admin explicitly trusted (a job only runs in-process
//       once trusted; see TRUSTED_JOBS_OAC), for a user who must still be an admin by
//       rule 3. That is the same assurance the loopback check is a proxy for: the
//       loopback socket stands in for "the machine's operator is driving this", which
//       simply does not generalize to autonomous callers. The right question for a
//       non-browser caller is who authorized the code path, and for a job that is
//       answered by admin job-trust plus the use_file_sys grant.
//       NOTE the consequence, which is inherent to letting jobs read local files at
//       all: a REMOTE trigger can now cause a local read indirectly (someone triggers
//       a trusted job; the job reads the store and puts the data where its code says).
//       A cloud/serverless job is NOT covered — it calls back over the network with a
//       real non-loopback socket and is correctly refused by (a).

import { createConnectionsContext, createMarkReadOnly } from '../../shared/middleware/connectionsContext.mjs'
import { sendFailure } from '../../../../adapters/http/responses.mjs'
import { isUserAdmin } from '../../../jobs/services/userAdminStatus.mjs'
import { USER_DB_OAC } from '../../../../common/helpers/config.mjs'

export const markReadOnly = createMarkReadOnly('fs')

// permType override: the fs permission is 'use_file_sys', not the factory's 'use_' + service.
export const createFsContext = (dsManager, freezrPrefs) => createConnectionsContext('fs', { permType: 'use_file_sys' })(dsManager, freezrPrefs)

const LOOPBACK_ADDRS = ['127.0.0.1', '::1', '::ffff:127.0.0.1']

/**
 * Did this request arrive over a loopback socket from a localhost Host?
 * Strictly that and nothing else — an in-process job is NOT a loopback request and
 * must not be folded in here: /local_status reports this verbatim as `onLocalhost`,
 * and anything else reusing it is asking about the socket. Trusted-origin policy
 * (loopback OR in-process job) lives in localFsGate, not in this predicate.
 */
export const isLocalhostRequest = (req) => {
  const remote = req.socket?.remoteAddress
  if (!LOOPBACK_ADDRS.includes(remote)) return false
  const host = (req.headers?.host || '').toLowerCase()
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/**
 * The in-process-job trust marker, if present. Only adapters/jobs/internalApiClient.mjs
 * sets it (on a req it constructs itself, dispatched through an app no socket is bound
 * to), so it cannot be forged by a client. Returns { appName, jobName } when the runner
 * supplied identity, {} for a bare marker, or null when absent.
 */
export const inProcessJobOf = (req) => {
  const marker = req?.freezrInProcessJob
  if (!marker) return null
  return (typeof marker === 'object') ? marker : {}
}

/**
 * Mount AFTER createFsContext. No-op for cloud stores; enforces the four local-store
 * conditions above for fsParams.type 'local'.
 */
export const createLocalFsGate = (dsManager, freezrPrefs) => {
  const tag = 'localFsGate'
  return async (req, res, next) => {
    try {
      const connection = res.locals.freezr?.fsConnection
      if (!connection) return sendFailure(res, 'fs connection not loaded — localFsGate must run after fsContext', tag, 500)
      const fsParams = connection.fsParams
      if (!fsParams || typeof fsParams !== 'object' || !fsParams.type) {
        return sendFailure(res, 'file store connection has no usable fsParams', tag, 500)
      }
      if (fsParams.type !== 'local') return next()

      if (dsManager?.systemEnvironment?.fsParams?.type !== 'local') {
        return sendFailure(res, 'local file stores are only available on servers whose own file system is local', tag, 403)
      }
      if (freezrPrefs?.local_fs_access_enabled !== true) {
        return sendFailure(res, 'local file-store access is not enabled on this server (admin pref local_fs_access_enabled)', tag, 403)
      }
      // Trusted origin: a loopback request, or an in-process (admin-trusted) job. See the
      // header comment — these are the only two forms, and a cloud job is deliberately
      // neither (it calls back over the network and is refused as a remote request).
      const job = inProcessJobOf(req)
      const allowed = isLocalhostRequest(req) || !!job
      if (!allowed) {
        return sendFailure(res, 'local file stores can only be accessed from localhost (or by an in-process job on this server)', tag, 403)
      }
      const ownerUserId = res.locals.freezr?.tokenInfo?.requestor_id
      let admin = false
      try {
        admin = await isUserAdmin(dsManager.getDB(USER_DB_OAC), ownerUserId)
      } catch (e) {
        console.warn('localFsGate: could not resolve admin status:', e.message)
      }
      if (!admin) {
        return sendFailure(res, 'local file stores are restricted to admin users', tag, 403)
      }
      // A job reading the user's local disk is worth a line in the log: unlike a browser
      // read there is nobody watching it happen, so this is the only record of which job
      // touched which store.
      if (job) {
        const who = (job.appName || job.jobName)
          ? ((job.appName || '?') + '/' + (job.jobName || '?'))
          : 'unidentified in-process job'
        const line = '📂 localFsGate: in-process job ' + who + ' reading local file store "' +
          (connection.connectionName || '?') + '" (' + (fsParams.rootPath || '?') + ') for ' + ownerUserId
        if (res.locals?.flogger?.info) res.locals.flogger.info(line)
        else console.log(line)
      }
      next()
    } catch (error) {
      console.error('❌ Error in localFsGate:', error)
      return sendFailure(res, error, tag, 500)
    }
  }
}

export default { createFsContext, createLocalFsGate, markReadOnly, isLocalhostRequest, inProcessJobOf }
