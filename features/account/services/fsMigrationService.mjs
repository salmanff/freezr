// freezr.info - fsMigrationService.mjs
//
// File-system migration state machine. Copies a user's whole subtree from their current
// ("source") FS to a new ("target") FS, cuts over atomically, retains the old FS behind a
// flag until the user confirms (rollback or delete), and is crash-resumable.
//
// Authoritative status + retained credentials live on the user record's `fsMigration`
// field (info.freezr.admin.users). Live progress + cancel + heartbeat live in the
// server-wide fs_migrations table (FS_MIGRATIONS_OAC). See FS_MIGRATION_PLAN.md.
//
// Execution: in-process worker, governed by a concurrency cap (semaphore below) and a
// load-adaptive throttle (yieldUnderLoad) so it never starves request traffic.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { FS_MIGRATIONS_OAC, USER_DB_OAC, FS_MIGRATION_LOCKED_STATES, FREEZR_USER_FILES_DIR } from '../../../common/helpers/config.mjs'
import { removeLastPathElement } from '../../../common/helpers/utils.mjs'
import { encryptParams, decryptParams } from '../../register/services/registerServices.mjs'
import { checkFSAsync, describeFsDbParams } from '../../../adapters/datastore/environmentDefaults.mjs'
import { createRawFs, userSubtreeBase } from '../../../adapters/datastore/fsConnectors/fsRawFactory.mjs'
import { enumerate, copyTree, verifyTree } from '../../../adapters/datastore/fsConnectors/fsTreeCopy.mjs'
import { yieldUnderLoad } from '../../../common/helpers/loadThrottle.mjs'

const __dir = path.dirname(fileURLToPath(import.meta.url)) // features/account/services
const ROOT_DIR = removeLastPathElement(__dir, 3) + path.sep // repo root

// Migrating TO the host/system default is only offered in a development environment (npm run dev),
// as a testing convenience — system accounts can face restrictions a migration-into-system would
// need extra checks for, so it stays blocked in production.
export const IS_DEV_ENV = process.env.NODE_ENV === 'development'

export const STATUS = {
  NONE: 'none',
  QUEUED: 'queued',
  PREPARING: 'preparing',
  COPYING: 'copying',
  VERIFYING: 'verifying',
  AWAITING: 'awaiting_confirmation',
  ROLLING_BACK: 'rolling_back',
  ROLLED_BACK: 'rolled_back',
  CLEANING_UP: 'cleaning_up',
  COMPLETE: 'complete',
  FAILED: 'failed'
}
// States in which the user is fully offline-locked (shared with the dsManager gate).
export const LOCKED_STATES = FS_MIGRATION_LOCKED_STATES
// States that block starting a new migration.
const BUSY_STATES = [STATUS.QUEUED, STATUS.PREPARING, STATUS.COPYING, STATUS.VERIFYING, STATUS.AWAITING, STATUS.ROLLING_BACK, STATUS.CLEANING_UP]
// States of the OTHER migration kind that block starting this one. Excludes awaiting_confirmation
// (and failed): once a migration has cut over, the user is live on the new provider and can
// migrate the other resource while the old one waits to be confirmed/deleted. Only a genuinely
// in-flight (locked / transient) migration of the other kind blocks concurrency.
const CONCURRENT_BLOCKING = [STATUS.QUEUED, STATUS.PREPARING, STATUS.COPYING, STATUS.VERIFYING, STATUS.ROLLING_BACK, STATUS.CLEANING_UP]
const FORWARD_RESUMABLE = [STATUS.QUEUED, STATUS.PREPARING, STATUS.COPYING, STATUS.VERIFYING]

const PHASE_LABEL = {
  [STATUS.QUEUED]: 'Waiting to start…',
  [STATUS.PREPARING]: 'Preparing',
  [STATUS.COPYING]: 'Copying your data',
  [STATUS.VERIFYING]: 'Verifying',
  [STATUS.AWAITING]: 'Ready — please test your account',
  [STATUS.ROLLING_BACK]: 'Rolling back',
  [STATUS.ROLLED_BACK]: 'Rolled back to old storage',
  [STATUS.CLEANING_UP]: 'Deleting old storage',
  [STATUS.COMPLETE]: 'Migration complete',
  [STATUS.FAILED]: 'Migration failed'
}

const MARKER_FILE = '.freezr_migration.json'

// ----- module context + concurrency semaphore ------------------------------------------
let CTX = null // { dsManager, freezrPrefs }
const activeWorkers = new Set()
const queue = []
// per-run cached cancel flag (refreshed by the heartbeat), keyed by userId
const cancelCache = new Map()

export const initFsMigrationService = (ctx) => { CTX = ctx }
const maxConcurrent = () => Math.max(1, CTX?.freezrPrefs?.maxConcurrentFsMigrations || 2)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
// Optional artificial delay between file copies. Lets an operator watch the status page
// during a test run. 0 = off (production). Set via env FREEZR_FSMIG_DELAY_MS or the
// freezrPrefs.fsMigrationInterFileDelayMs admin pref.
const interFileDelayMs = () => Number(process.env.FREEZR_FSMIG_DELAY_MS || CTX?.freezrPrefs?.fsMigrationInterFileDelayMs || 0)

const requireCtx = () => {
  if (!CTX || !CTX.dsManager) throw new Error('fsMigrationService not initialised (call initFsMigrationService)')
  return CTX
}

// ----- db helpers ----------------------------------------------------------------------
const migrationsDb = async () => {
  const { dsManager, freezrPrefs } = requireCtx()
  return dsManager.getorInitDb(FS_MIGRATIONS_OAC, { freezrPrefs })
}
const usersDb = async () => {
  const { dsManager, freezrPrefs } = requireCtx()
  return dsManager.getorInitDb(USER_DB_OAC, { freezrPrefs })
}
const readUser = async (userId) => {
  const db = await usersDb()
  const rows = await db.query({ user_id: userId }, {})
  return (rows && rows[0]) || null
}
const updateUserMigration = async (userId, fsMigration, extra = {}) => {
  const db = await usersDb()
  await db.update(userId, { fsMigration, ...extra }, { replaceAllFields: false })
}
const readRow = async (userId) => {
  const db = await migrationsDb()
  try { return await db.read_by_id(userId) } catch (e) { return null }
}
const writeRow = async (userId, fields) => {
  const db = await migrationsDb()
  const existing = await readRow(userId)
  const now = Date.now()
  if (existing) {
    await db.update(userId, { ...fields, updatedAt: now }, { replaceAllFields: false })
  } else {
    await db.create(userId, { user_id: userId, cancelRequested: false, ...fields, createdAt: now, updatedAt: now }, {})
  }
}

// Resolve a user's source fsParams/dbParams, substituting the system env for type 'system'.
const resolveParams = (rawParams, kind) => {
  const { dsManager } = requireCtx()
  if (rawParams?.type === 'system') {
    return kind === 'fs' ? dsManager.systemEnvironment?.fsParams : dsManager.systemEnvironment?.dbParams
  }
  return decryptParams(rawParams)
}

// When the FS migrates AWAY from the system fs, a dbParams of 'system' becomes misleading:
// 'system' means "use the host default", which is irrelevant once the user is on their own fs.
// If the system db is nedb (files-as-db), the database physically rides with the fs, so it must
// be re-labelled as a concrete 'nedb'. Returns the new dbParams to store, or null for no change
// (e.g. the system db is mongo — an external server unaffected by an fs move — or db isn't 'system').
const concretizeDbForFsMigration = (rawDbParams) => {
  const { dsManager } = requireCtx()
  if (rawDbParams?.type !== 'system') return null
  const resolvedDb = dsManager.systemEnvironment?.dbParams
  if (resolvedDb?.type === 'nedb') return { type: 'nedb' }
  return null
}

// ----- validation ----------------------------------------------------------------------
/**
 * Throw if migrating a user with these (resolved) dbParams to this target FS is unsafe.
 * Hard rule: nedb (files-as-db) does not work on Dropbox. Google Drive nedb is untested.
 */
export const assertFsDbCompatible = (resolvedDbParams, targetFsParams, options = {}) => {
  const usesFilesAsDb = resolvedDbParams?.type === 'nedb'
  if (!usesFilesAsDb) return
  if (targetFsParams?.type === 'dropbox') {
    const e = new Error('Your database is stored as files (nedb), and that is not supported on Dropbox. Choose a different storage provider, or migrate your database type first.')
    e.code = 'FS_DB_INCOMPATIBLE'
    throw e
  }
  if (targetFsParams?.type === 'googleDrive' && !options.allowUntested) {
    const e = new Error('Using files as a database on Google Drive is not yet tested. An administrator can override this.')
    e.code = 'FS_DB_UNTESTED'
    throw e
  }
}

// =======================================================================================
//  PUBLIC API
// =======================================================================================

/**
 * Begin a migration. Password must already be verified by the controller.
 * @param {Object} args { userId, targetFsParams, allowUntested }
 * @returns {Promise<{status:string}>}
 */
export const startFsMigration = async ({ userId, targetFsParams, allowUntested = false, confirmContinue = false, allowSystemTarget = IS_DEV_ENV }) => {
  const { dsManager } = requireCtx()
  if (!userId) throw new Error('startFsMigration: userId required')
  if (!targetFsParams || !targetFsParams.type) throw new Error('startFsMigration: targetFsParams.type required')

  const user = await readUser(userId)
  if (!user) throw new Error('User not found: ' + userId)

  // Already migrating? (FS or DB — the two are mutually exclusive: each locks the same user
  // chokepoint and evicts the same cached USER_DS, so they must never run concurrently.)
  if (user.fsMigration && BUSY_STATES.includes(user.fsMigration.status)) {
    const e = new Error('A migration is already in progress for this account.')
    e.code = 'MIGRATION_IN_PROGRESS'
    throw e
  }
  if (user.dbMigration && CONCURRENT_BLOCKING.includes(user.dbMigration.status)) {
    const e = new Error('A database migration is currently running for this account; please wait for it to finish before migrating your storage.')
    e.code = 'MIGRATION_IN_PROGRESS'
    throw e
  }

  const resolvedSource = resolveParams(user.fsParams, 'fs')
  const resolvedDb = resolveParams(user.dbParams, 'db')
  if (!resolvedSource || !resolvedSource.type) throw new Error('Could not resolve current file-system params')

  // Migrating TO the host/system default is a restricted, test-oriented path: allowed only in a
  // dev environment OR for an admin (the controller passes `allowSystemTarget = dev || isAdmin`).
  // For a system target we resolve to the host's real fs for the connection test + copy, but store
  // a {type:'system'} marker on the record (like a system-fs user).
  const targetIsSystem = targetFsParams.choice === 'sysDefault' || targetFsParams.type === 'system'
  if (targetIsSystem && !allowSystemTarget) {
    const e = new Error('Migrating your storage to the host/system default is not supported. Please choose a specific storage provider.')
    e.code = 'TARGET_SYSTEM_NOT_ALLOWED'
    throw e
  }
  const resolvedTarget = targetIsSystem ? dsManager.systemEnvironment?.fsParams : targetFsParams
  if (!resolvedTarget || !resolvedTarget.type) throw new Error('Could not resolve the target file-system params')

  // The FS root folder is always the freezr default for now (different-folder edge cases deferred).
  if (!targetIsSystem) targetFsParams.rootFolder = FREEZR_USER_FILES_DIR

  // Compatibility + isolation invariants (checked against the RESOLVED target type).
  assertFsDbCompatible(resolvedDb, resolvedTarget, { allowUntested })
  if (resolvedSource.type === 'local' && resolvedTarget.type === 'local') {
    const e = new Error('That target is the same local storage you already use — there is nothing to migrate (the file-system root is always "' + FREEZR_USER_FILES_DIR + '").')
    e.code = 'LOCAL_TO_LOCAL'
    throw e
  }

  // Confirm the new FS works (real write/read/delete). The host/system fs is already known-good.
  if (!targetIsSystem) {
    if (!targetFsParams.choice) targetFsParams.choice = targetFsParams.type
    const check = await checkFSAsync({ fsParams: targetFsParams })
    if (!check || !check.checkpassed) {
      const e = new Error('The new storage did not pass the connection test: ' + (check?.err || check?.error || 'unknown error'))
      e.code = 'FS_CHECK_FAILED'
      throw e
    }
  }

  // Pre-check: does the target already hold data for this user (a previous attempt, or a folder
  // the user created)? Ask for explicit confirmation rather than silently merging. The copy is
  // idempotent (identical files skipped; differing files overwritten) — we keep it simple and do
  // not deep-compare, so confirming on genuinely-different data is the user's call.
  if (!confirmContinue) {
    try {
      const probeFs = await createRawFs(resolvedTarget)
      const existing = await enumerate(probeFs, userSubtreeBase(resolvedTarget, userId))
      const meaningful = existing.filter(e => e.relPath !== MARKER_FILE)
      if (meaningful.length > 0) {
        const e = new Error('The new storage already contains ' + meaningful.length + ' file(s) for "' + userId + '" (perhaps from a previous attempt, or a folder you created). Continue and merge/overwrite them?')
        e.code = 'TARGET_NOT_EMPTY'
        e.fileCount = meaningful.length
        throw e
      }
    } catch (e) {
      if (e.code === 'TARGET_NOT_EMPTY') throw e
      console.warn('fsMigration: target pre-check listing failed (continuing):', e.message)
    }
  }

  const now = Date.now()
  const pendingFsParams = targetIsSystem ? { type: 'system' } : encryptParams(targetFsParams)

  // Authoritative status on the user record (engages the lock).
  await updateUserMigration(userId, {
    status: STATUS.PREPARING,
    startedAt: now,
    updatedAt: now,
    pendingFsParams
  })
  await writeRow(userId, {
    status: STATUS.PREPARING,
    cancelRequested: false,
    sourceType: resolvedSource.type,
    targetType: targetIsSystem ? 'system' : targetFsParams.type,
    filesCopied: 0,
    filesSkipped: 0,
    bytesCopied: 0,
    totalFiles: 0,
    totalBytes: 0,
    currentPath: null,
    error: null,
    startedAt: now
  })

  // Pre-flight: persist nedb, clear caches, evict the cached USER_DS.
  const flush = await dsManager.flushAndEvictUserDS(userId)
  if (flush.persistErrors && flush.persistErrors.length) {
    await fail(userId, 'Could not persist your database before migrating: ' + JSON.stringify(flush.persistErrors), 'preparing')
    const e = new Error('Pre-flight persist failed')
    e.code = 'PREFLIGHT_FAILED'
    throw e
  }

  scheduleWorker(userId)
  return { status: STATUS.PREPARING }
}

/** Request cancellation of an in-flight (pre-cutover) migration. */
export const abortFsMigration = async (userId) => {
  const user = await readUser(userId)
  const status = user?.fsMigration?.status
  if (!status || !FORWARD_RESUMABLE.includes(status)) {
    throw new Error('No cancellable migration in progress.')
  }
  await writeRow(userId, { cancelRequested: true })
  cancelCache.set(userId, true)
  // If no worker is actually running (e.g. queued), clean up directly.
  if (!activeWorkers.has(userId)) {
    const idx = queue.indexOf(userId)
    if (idx >= 0) queue.splice(idx, 1)
    await abortCleanup(userId)
  }
  return { status: 'cancelling' }
}

/** Retry a FAILED migration reusing the same (stored) target credentials. */
export const retryFsMigration = async (userId) => {
  const { dsManager } = requireCtx()
  const user = await readUser(userId)
  const fm = user?.fsMigration
  if (!fm || fm.status !== STATUS.FAILED) throw new Error('No failed migration to retry.')
  if (!fm.pendingFsParams) throw new Error('Cannot retry — the new-storage details are no longer available. Please re-enter them.')
  const now = Date.now()
  await updateUserMigration(userId, { ...fm, status: STATUS.PREPARING, error: null, updatedAt: now })
  await writeRow(userId, { status: STATUS.PREPARING, cancelRequested: false, error: null })
  await dsManager.flushAndEvictUserDS(userId)
  scheduleWorker(userId)
  return { status: STATUS.PREPARING }
}

/** Clear a FAILED migration (delete the partial target copy) so the user can start fresh. */
export const dismissFailedMigration = async (userId) => {
  const user = await readUser(userId)
  const fm = user?.fsMigration
  if (!fm || fm.status !== STATUS.FAILED) throw new Error('No failed migration to clear.')
  await abortCleanup(userId) // removes the partial target, clears the record, unlocks
  return { status: STATUS.NONE }
}

/** From awaiting_confirmation: roll back to the old FS (discarding changes since cutover). */
export const rollbackFsMigration = async (userId) => {
  const user = await readUser(userId)
  const fm = user?.fsMigration
  if (!fm || (fm.status !== STATUS.AWAITING && fm.status !== STATUS.ROLLING_BACK)) {
    throw new Error('Nothing to roll back (account is not awaiting confirmation).')
  }
  await doRollback(userId)
  return { status: STATUS.ROLLED_BACK }
}

/** From awaiting_confirmation: delete the old storage (irreversible). Password pre-checked. */
export const confirmDeleteOldFs = async (userId) => {
  const user = await readUser(userId)
  const fm = user?.fsMigration
  if (!fm || (fm.status !== STATUS.AWAITING && fm.status !== STATUS.CLEANING_UP)) {
    throw new Error('Nothing to delete (account is not awaiting confirmation).')
  }
  await doCleanup(userId)
  return { status: STATUS.COMPLETE }
}

/** UI status object. */
export const getFsMigrationStatus = async (userId) => {
  const user = await readUser(userId)
  const fm = user?.fsMigration || { status: STATUS.NONE }
  const row = await readRow(userId)
  const status = fm.status || STATUS.NONE
  const totalBytes = row?.totalBytes || 0
  const bytesCopied = row?.bytesCopied || 0
  // byte-based bar, scaled 5..95 during copy; verify->100
  let percent = 0
  if (status === STATUS.COPYING) percent = totalBytes > 0 ? 5 + Math.round((bytesCopied / totalBytes) * 90) : 5
  else if (status === STATUS.VERIFYING) percent = 96
  else if ([STATUS.AWAITING, STATUS.COMPLETE, STATUS.ROLLED_BACK].includes(status)) percent = 100
  else if (status === STATUS.PREPARING) percent = 3
  // Current (live) storage, so the UI can always show what the user is on. Described from the
  // raw user record (decrypted) — a {type:'system'} pointer reads as "Host system".
  const currentFs = describeFsDbParams(decryptParams(user?.fsParams), 'FS').display
  const currentDb = describeFsDbParams(decryptParams(user?.dbParams), 'DB').display
  // Whether the database is files-as-db (nedb), which rides with the file system on an FS migration.
  const dbIsNedb = (resolveParams(user?.dbParams || {}, 'db'))?.type === 'nedb'
  return {
    status,
    locked: LOCKED_STATES.includes(status),
    phaseLabel: PHASE_LABEL[status] || status,
    percent,
    currentFs,
    currentDb,
    dbIsNedb,
    filesCopied: row?.filesCopied || 0,
    filesSkipped: row?.filesSkipped || 0,
    totalFiles: row?.totalFiles || 0,
    bytesCopied,
    totalBytes,
    currentPath: row?.currentPath || null,
    sourceType: row?.sourceType || null,
    targetType: row?.targetType || null,
    cutoverAt: fm.cutoverAt || null,
    error: fm.error || row?.error || null
  }
}

/** On server startup, re-claim and resume any migration left mid-flight. */
export const recoverOnStartup = async () => {
  try {
    const db = await migrationsDb()
    const rows = await db.query({}, {})
    let resumed = 0
    for (const row of (rows || [])) {
      const user = await readUser(row.user_id)
      const status = user?.fsMigration?.status
      if (!status) continue
      if (FORWARD_RESUMABLE.includes(status)) { scheduleWorker(row.user_id); resumed++ }
      else if (status === STATUS.ROLLING_BACK) { doRollback(row.user_id).catch(e => console.warn('recover rollback err', row.user_id, e.message)); resumed++ }
      else if (status === STATUS.CLEANING_UP) { doCleanup(row.user_id).catch(e => console.warn('recover cleanup err', row.user_id, e.message)); resumed++ }
    }
    if (resumed) console.log('🔁 fsMigration: resumed ' + resumed + ' migration(s) after startup')
    return { resumed }
  } catch (e) {
    console.warn('🔴 fsMigration.recoverOnStartup', e.message)
    return { resumed: 0, error: e.message }
  }
}

// =======================================================================================
//  WORKER + PHASES
// =======================================================================================

const scheduleWorker = (userId) => {
  if (!queue.includes(userId) && !activeWorkers.has(userId)) queue.push(userId)
  pump()
}
const pump = () => {
  while (activeWorkers.size < maxConcurrent() && queue.length) {
    const userId = queue.shift()
    activeWorkers.add(userId)
    runForwardWorker(userId)
      .catch(err => console.warn('🔴 fsMigration worker error for ' + userId, err.message))
      .finally(() => { activeWorkers.delete(userId); cancelCache.delete(userId); pump() })
  }
}

const runForwardWorker = async (userId) => {
  const user = await readUser(userId)
  const fm = user?.fsMigration
  if (!fm || !FORWARD_RESUMABLE.includes(fm.status)) return // nothing to do / already past

  const targetStored = decryptParams(fm.pendingFsParams)
  // A {type:'system'} marker resolves to the host's shared fs for the actual copy.
  const target = (targetStored?.type === 'system') ? resolveParams({ type: 'system' }, 'fs') : targetStored
  const source = resolveParams(user.fsParams, 'fs')
  if (!target?.type || !source?.type) { await fail(userId, 'Missing source/target params', fm.status); return }

  const srcFs = await createRawFs(source)
  const tgtFs = await createRawFs(target)
  const srcBase = userSubtreeBase(source, userId)
  const tgtBase = userSubtreeBase(target, userId)

  // heartbeat: refresh heartbeatAt + cancel flag every 7s
  cancelCache.set(userId, false)
  const heartbeat = setInterval(async () => {
    try {
      const row = await readRow(userId)
      if (row?.cancelRequested) cancelCache.set(userId, true)
      await writeRow(userId, { heartbeatAt: Date.now() })
    } catch (e) { /* non-fatal */ }
  }, 7000)

  try {
    // COPYING
    await setStatus(userId, STATUS.COPYING)
    const rawManifest = await enumerate(srcFs, srcBase)
    // Copy the critical/small data first (db, then user files, then app code), so it lands
    // and is visible sooner; skip the per-FS migration marker (we write fresh markers at cutover).
    const groupRank = (rel) => rel.startsWith('db/') ? 0 : rel.startsWith('files/') ? 1 : rel.startsWith('apps/') ? 2 : 3
    const manifest = rawManifest
      .filter(e => e.relPath !== MARKER_FILE)
      .sort((a, b) => groupRank(a.relPath) - groupRank(b.relPath))
    const totalFiles = manifest.length
    const totalBytes = manifest.reduce((a, e) => a + (e.size || 0), 0)
    await writeRow(userId, { totalFiles, totalBytes, status: STATUS.COPYING })

    let lastWrite = 0
    let sinceWrite = 0
    const delayMs = interFileDelayMs()
    const result = await copyTree({
      srcFs, tgtFs, srcBase, tgtBase, manifest,
      shouldCancel: () => cancelCache.get(userId) === true,
      throttle: async () => { await yieldUnderLoad(); if (delayMs > 0) await sleep(delayMs) },
      onProgress: (s) => {
        sinceWrite++
        const now = Date.now()
        if (sinceWrite >= 25 || (now - lastWrite) > 2000) {
          lastWrite = now; sinceWrite = 0
          writeRow(userId, {
            filesCopied: s.filesCopied, filesSkipped: s.filesSkipped,
            bytesCopied: s.bytesCopied, currentPath: s.currentPath
          }).catch(() => {})
        }
      }
    })
    await writeRow(userId, { filesCopied: result.filesCopied, filesSkipped: result.filesSkipped, bytesCopied: result.bytesCopied })

    if (result.cancelled) {
      clearInterval(heartbeat)
      await abortCleanup(userId, { source, target, srcFs, tgtFs, srcBase, tgtBase })
      return
    }

    // VERIFYING
    await setStatus(userId, STATUS.VERIFYING)
    const verify = await verifyTree({ tgtFs, tgtBase, manifest })
    if (!verify.ok) {
      clearInterval(heartbeat)
      await fail(userId, 'Verification failed: ' + verify.mismatches.length + ' file(s) did not match (e.g. ' + (verify.mismatches[0]?.relPath || '') + ').', STATUS.VERIFYING, { mismatches: verify.mismatches.slice(0, 20) })
      return
    }

    // CUTOVER
    clearInterval(heartbeat)
    await cutover(userId, { source, target, srcFs, tgtFs, srcBase, tgtBase })
  } catch (err) {
    clearInterval(heartbeat)
    await fail(userId, err.message, 'copying')
  }
}

const cutover = async (userId, { source, target, srcFs, tgtFs, srcBase, tgtBase }) => {
  const { dsManager } = requireCtx()
  const now = Date.now()

  // Marker files (best-effort).
  try {
    await tgtFs.writeFile_async(tgtBase + '/' + MARKER_FILE, JSON.stringify({ role: 'active_target', migratedFrom: source.type, migratedAt: now }), {})
  } catch (e) { console.warn('fsMigration: could not write target marker', e.message) }
  try {
    await srcFs.writeFile_async(srcBase + '/' + MARKER_FILE, JSON.stringify({ role: 'retired_source', retiredAt: now, newProvider: target.type, note: 'safe to delete once new FS confirmed' }), {})
  } catch (e) { console.warn('fsMigration: could not write source marker', e.message) }

  // Atomic commit: point the user at the new FS, retain the old.
  const user = await readUser(userId)

  // If the db was 'system' (host default) and that default is nedb, the database rides with the
  // fs onto the new storage, so re-label it as concrete 'nedb' (a 'system' tag is meaningless once
  // the user is on their own fs). Keep the original so rollback can restore it.
  const newDbParams = concretizeDbForFsMigration(user.dbParams)

  const recordChanges = { fsParams: user.fsMigration.pendingFsParams } // <-- the fs switch
  if (newDbParams) recordChanges.dbParams = newDbParams // <-- concretise the db label

  await updateUserMigration(userId, {
    status: STATUS.AWAITING,
    startedAt: user.fsMigration?.startedAt,
    cutoverAt: now,
    updatedAt: now,
    retiredFsParams: encryptParams(source), // resolved source, for cleanup/rollback connector
    retiredFsParamsOriginal: user.fsParams, // original (may be {type:'system'}) for clean rollback
    retiredDbParamsOriginal: user.dbParams, // original db label, to restore on rollback
    pendingFsParams: null
  }, recordChanges)

  // Rebuild the USER_DS on the new FS; clear stale caches.
  await dsManager.flushAndEvictUserDS(userId)
  await writeRow(userId, { status: STATUS.AWAITING, currentPath: null })
}

const doRollback = async (userId) => {
  const { dsManager } = requireCtx()
  const user = await readUser(userId)
  const fm = user.fsMigration
  const now = Date.now()

  await updateUserMigration(userId, { ...fm, status: STATUS.ROLLING_BACK, updatedAt: now })
  await writeRow(userId, { status: STATUS.ROLLING_BACK })
  await dsManager.flushAndEvictUserDS(userId) // quiesce target

  const discardedFsParams = user.fsParams // currently the target
  // Restore the original source params (preserves a 'system' pointer if that's what it was), and
  // restore the original db label too (undo any 'system'→'nedb' concretisation done at cutover).
  const restoreChanges = { fsParams: fm.retiredFsParamsOriginal }
  if (fm.retiredDbParamsOriginal !== undefined) restoreChanges.dbParams = fm.retiredDbParamsOriginal
  await updateUserMigration(userId, {
    status: STATUS.ROLLED_BACK,
    rolledBackAt: now,
    updatedAt: now,
    discardedFsParams,
    retiredFsParams: fm.retiredFsParams
  }, restoreChanges)
  await dsManager.flushAndEvictUserDS(userId) // rebuild on source; status not locked -> unlocked
  await writeRow(userId, { status: STATUS.ROLLED_BACK })

  // Best-effort: delete the discarded target data + its marker (resolve 'system' to its real fs).
  try {
    const target = resolveParams(discardedFsParams, 'fs')
    const tgtFs = await createRawFs(target)
    await tgtFs.removeFolder_async(userSubtreeBase(target, userId))
  } catch (e) { console.warn('fsMigration: could not delete discarded target', e.message) }
  // Restore source marker to active (best-effort).
  try {
    const source = resolveParams(fm.retiredFsParamsOriginal, 'fs')
    const srcFs = await createRawFs(source)
    await srcFs.writeFile_async(userSubtreeBase(source, userId) + '/' + MARKER_FILE, JSON.stringify({ role: 'active', restoredAt: now }), {})
  } catch (e) { /* non-fatal */ }

  // Terminal: clear back to none so the account is fully normal again.
  await updateUserMigration(userId, { status: STATUS.NONE })
  await dsManager.flushAndEvictUserDS(userId)
}

const doCleanup = async (userId) => {
  const { dsManager } = requireCtx()
  const user = await readUser(userId)
  const fm = user.fsMigration
  const now = Date.now()

  await updateUserMigration(userId, { ...fm, status: STATUS.CLEANING_UP, updatedAt: now })
  await writeRow(userId, { status: STATUS.CLEANING_UP })

  // Delete the retained (old) source subtree on its FS. If this fails we must NOT report success
  // (the old data would be silently left behind, as happened with a Backblaze key lacking the
  // deleteFiles capability) — instead keep the old storage retained, return to awaiting_confirmation
  // with the reason, and let the user retry "delete old storage".
  try {
    const source = decryptParams(fm.retiredFsParams)
    const srcBase = userSubtreeBase(source, userId)
    const srcFs = await createRawFs(source)
    const result = await srcFs.removeFolder_async(srcBase)
    console.log('🗑️  fsMigration: deleted old storage for ' + userId + ' (' + JSON.stringify(result || {}) + ')')
    // Also clear the local-disk mirror — BUT only if the NEW active fs is not local, since
    // with a fixed root folder that same path IS the live data for a local target. Resolve
    // 'system' (it maps to the host's local fs) so we don't delete live data.
    const activeType = resolveParams(user.fsParams, 'fs')?.type
    if (activeType && activeType !== 'local') {
      const localMirror = path.normalize(ROOT_DIR + srcBase)
      if (fs.existsSync(localMirror)) await fs.promises.rm(localMirror, { recursive: true, force: true })
    }
  } catch (e) {
    console.warn('🔴 fsMigration: could not delete old storage for ' + userId + ':', e.message)
    const errInfo = { message: 'Could not delete old storage: ' + e.message, phase: 'cleaning_up', at: Date.now() }
    await updateUserMigration(userId, { ...fm, status: STATUS.AWAITING, updatedAt: Date.now(), error: errInfo })
    await writeRow(userId, { status: STATUS.AWAITING, error: errInfo.message })
    const err = new Error(errInfo.message)
    err.code = 'CLEANUP_FAILED'
    throw err
  }

  await writeRow(userId, { status: STATUS.COMPLETE })
  await updateUserMigration(userId, { status: STATUS.NONE })
  await dsManager.flushAndEvictUserDS(userId)
}

// Abort a pre-cutover migration: remove partial target, clear migration, unlock.
const abortCleanup = async (userId, ctx) => {
  const { dsManager } = requireCtx()
  try {
    const user = await readUser(userId)
    const fm = user?.fsMigration
    if (fm?.pendingFsParams) {
      const target = ctx?.target || decryptParams(fm.pendingFsParams)
      const tgtFs = ctx?.tgtFs || await createRawFs(target)
      await tgtFs.removeFolder_async(ctx?.tgtBase || userSubtreeBase(target, userId))
    }
  } catch (e) { console.warn('fsMigration: abort cleanup error', e.message) }
  await updateUserMigration(userId, { status: STATUS.NONE })
  await writeRow(userId, { status: STATUS.NONE, cancelRequested: false, currentPath: null })
  await dsManager.flushAndEvictUserDS(userId)
}

// ----- small status writers ------------------------------------------------------------
const setStatus = async (userId, status) => {
  const user = await readUser(userId)
  await updateUserMigration(userId, { ...(user.fsMigration || {}), status, updatedAt: Date.now() })
  await writeRow(userId, { status })
}
const fail = async (userId, message, phase, extra = {}) => {
  const { dsManager } = requireCtx()
  const user = await readUser(userId)
  const error = { message, phase, at: Date.now(), ...extra }
  // Pre-cutover failures leave the user on the (untouched) source: clear the lock.
  await updateUserMigration(userId, { status: STATUS.FAILED, error, pendingFsParams: user.fsMigration?.pendingFsParams || null })
  await writeRow(userId, { status: STATUS.FAILED, error: message })
  try { await dsManager.flushAndEvictUserDS(userId) } catch (e) {}
}

export default {
  initFsMigrationService,
  startFsMigration,
  abortFsMigration,
  retryFsMigration,
  dismissFailedMigration,
  rollbackFsMigration,
  confirmDeleteOldFs,
  getFsMigrationStatus,
  recoverOnStartup,
  assertFsDbCompatible,
  STATUS,
  LOCKED_STATES
}
