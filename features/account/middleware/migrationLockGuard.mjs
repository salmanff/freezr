// freezr.info - migrationLockGuard.mjs
//
// Enforces the FS-migration offline lock. While a logged-in user's account is in a
// locked migration state (preparing/copying/verifying/rolling_back):
//   - page requests are redirected to a single status page (/account/migration)
//   - API requests get 503 { error: 'migration_in_progress' } so client apps can detect it
//
// The lock is read authoritatively from the user record's fsMigration.status (a single
// indexed lookup on the fradmin users db), with a short in-process TTL cache to avoid a
// query on every request. Reading authoritatively keeps the lock correct across multiple
// server instances (per-process USER_DS caches are not coherent).

import { USER_DB_OAC } from '../../../common/helpers/config.mjs'
import { LOCKED_STATES } from '../services/fsMigrationService.mjs'

const STATUS_PAGE = '/account/migration'
const TTL_MS = 3000
const cache = new Map() // userId -> { status, at }

const readMigrationStatus = async (dsManager, freezrPrefs, userId) => {
  const hit = cache.get(userId)
  const now = Date.now()
  if (hit && (now - hit.at) < TTL_MS) return hit.status
  let status = null
  try {
    const db = await dsManager.getorInitDb(USER_DB_OAC, { freezrPrefs })
    const rows = await db.query({ user_id: userId }, {})
    const row = rows && rows[0]
    // Locked if EITHER an FS or a DB migration is in a locked state (same status values).
    const fsS = row?.fsMigration?.status
    const dbS = row?.dbMigration?.status
    status = LOCKED_STATES.includes(fsS) ? fsS : (LOCKED_STATES.includes(dbS) ? dbS : null)
  } catch (e) {
    console.warn('⚠️  migrationLockGuard read (non-fatal):', e.message)
    status = null
  }
  cache.set(userId, { status, at: now })
  return status
}

// Allow callers to clear the cache promptly when status changes (optional).
export const clearMigrationLockCache = (userId) => { if (userId) cache.delete(userId); else cache.clear() }

/**
 * @param {object} dsManager
 * @param {object} freezrPrefs
 * @param {object} [opts] { mode: 'page'|'api' }
 */
export const createMigrationLockGuard = (dsManager, freezrPrefs, opts = {}) => {
  const mode = opts.mode || 'api'
  return async (req, res, next) => {
    const userId = req.session?.logged_in_user_id
    if (!userId) return next() // not logged in -> nothing to lock

    const status = await readMigrationStatus(dsManager, freezrPrefs, userId)
    if (!status || !LOCKED_STATES.includes(status)) return next()

    if (mode === 'page') {
      // Let the status page itself through; redirect everything else.
      const page = (req.params?.page || '').toLowerCase()
      if (page === 'migration' || req.path === STATUS_PAGE || req.path.endsWith('/migration')) return next()
      return res.redirect(STATUS_PAGE)
    }
    // api mode
    res.set('Retry-After', '10')
    return res.status(503).json({ error: 'migration_in_progress', message: 'Your account is being migrated to new storage. Please wait until it completes.' })
  }
}

export default { createMigrationLockGuard, clearMigrationLockCache }
