// freezr.info - dbMigrationService.mjs
//
// Database migration state machine — the DB analogue of fsMigrationService. Moves a user's
// database from one provider to another (nedb→mongo, mongo→mongo across servers/layouts,
// mongo→nedb), cuts over atomically, retains the old DB behind a flag until the user confirms
// (rollback or delete), and is crash-resumable.
//
// The copy runs THROUGH USER_DS objects: a transient USER_DS on the source dbParams and one on
// the target dbParams (both for the same user), so each connector applies its own physical
// layout and _id rules. Records are canonicalised on read and written via the target USER_DS
// with { restoreRecord: true } (see dbConnectors/dbRecordCopy.mjs).
//
// Authoritative status + retained credentials live on the user record's `dbMigration` field.
// Live progress + cancel + heartbeat live in the server-wide db_migrations table.
// Mutually exclusive with FS migration (both lock the same user chokepoint). See DB_MIGRATION_PLAN.md.

import { DB_MIGRATIONS_OAC, USER_DB_OAC, FS_MIGRATION_LOCKED_STATES } from '../../../common/helpers/config.mjs'
import { encryptParams, decryptParams } from '../../register/services/registerServices.mjs'
import { checkDB, checkAndCleanDb, describeFsDbParams } from '../../../adapters/datastore/environmentDefaults.mjs'
import { hasUnifiedStrategy } from '../../../adapters/datastore/dbConnectors/mongo_utils.mjs'
import { dbConnectionString } from '../../../adapters/datastore/dbConnectors/dbApi_mongodb.mjs'
import { listUserTables, copyTable, wipeTable, verifyTable } from '../../../adapters/datastore/dbConnectors/dbRecordCopy.mjs'
import { createRawFs, userSubtreeBase } from '../../../adapters/datastore/fsConnectors/fsRawFactory.mjs'
import { yieldUnderLoad } from '../../../common/helpers/loadThrottle.mjs'

// Migrating TO the host/system database is a restricted, test-oriented path (dev or admin only).
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
export const LOCKED_STATES = FS_MIGRATION_LOCKED_STATES
const BUSY_STATES = [STATUS.QUEUED, STATUS.PREPARING, STATUS.COPYING, STATUS.VERIFYING, STATUS.AWAITING, STATUS.ROLLING_BACK, STATUS.CLEANING_UP]
// States of the OTHER migration kind that block starting this one (excludes awaiting_confirmation
// / failed — see fsMigrationService for the rationale).
const CONCURRENT_BLOCKING = [STATUS.QUEUED, STATUS.PREPARING, STATUS.COPYING, STATUS.VERIFYING, STATUS.ROLLING_BACK, STATUS.CLEANING_UP]
const FORWARD_RESUMABLE = [STATUS.QUEUED, STATUS.PREPARING, STATUS.COPYING, STATUS.VERIFYING]

const PHASE_LABEL = {
  [STATUS.QUEUED]: 'Waiting to start…',
  [STATUS.PREPARING]: 'Preparing',
  [STATUS.COPYING]: 'Copying your database',
  [STATUS.VERIFYING]: 'Verifying',
  [STATUS.AWAITING]: 'Ready — please test your account',
  [STATUS.ROLLING_BACK]: 'Rolling back',
  [STATUS.ROLLED_BACK]: 'Rolled back to old database',
  [STATUS.CLEANING_UP]: 'Deleting old database',
  [STATUS.COMPLETE]: 'Migration complete',
  [STATUS.FAILED]: 'Migration failed'
}

const ACCESS = { noCache: true, bypassMigrationLock: true }

// ----- module context + concurrency semaphore ------------------------------------------
let CTX = null // { dsManager, freezrPrefs }
const activeWorkers = new Set()
const queue = []
const cancelCache = new Map()

export const initDbMigrationService = (ctx) => { CTX = ctx }
const maxConcurrent = () => Math.max(1, CTX?.freezrPrefs?.maxConcurrentDbMigrations || 2)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
// Optional artificial per-record delay so an operator can watch the status page in a test run.
const interRecordDelayMs = () => Number(process.env.FREEZR_DBMIG_DELAY_MS || CTX?.freezrPrefs?.dbMigrationInterRecordDelayMs || 0)

const requireCtx = () => {
  if (!CTX || !CTX.dsManager) throw new Error('dbMigrationService not initialised (call initDbMigrationService)')
  return CTX
}

// ----- db helpers ----------------------------------------------------------------------
const migrationsDb = async () => {
  const { dsManager, freezrPrefs } = requireCtx()
  return dsManager.getorInitDb(DB_MIGRATIONS_OAC, { freezrPrefs })
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
const updateUserMigration = async (userId, dbMigration, extra = {}) => {
  const db = await usersDb()
  await db.update(userId, { dbMigration, ...extra }, { replaceAllFields: false })
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

// ----- param resolution ----------------------------------------------------------------
// Resolve raw dbParams to concrete connection params. A 'system' marker resolves to a CLONE of
// the host's db params decorated with the server's unification prefs (exactly like
// dsManager.getOrSetUserDS, but on a copy so the shared systemEnvironment is never mutated).
// BYO params are decrypted verbatim — the server's prefs are NEVER injected into them.
const resolveDbParams = (rawParams) => {
  const { dsManager, freezrPrefs } = requireCtx()
  if (rawParams?.type === 'system') {
    const sys = { ...(dsManager.systemEnvironment?.dbParams || {}) }
    sys.systemDb = true
    sys.useUserIdsAsDbName = freezrPrefs?.useUserIdsAsDbName
    sys.dbUnificationStrategy = freezrPrefs?.dbUnificationStrategy
    return sys
  }
  return decryptParams(rawParams)
}
const resolveUserFs = (user) => {
  const { dsManager } = requireCtx()
  if (user.fsParams?.type === 'system') return dsManager.systemEnvironment?.fsParams
  return decryptParams(user.fsParams)
}
const clearTransientTimer = (ds) => { try { clearTimeout(ds?.dbPersistenceManager?.timer) } catch (e) {} }

// ----- validation ----------------------------------------------------------------------
// True if both sides are the SAME physical mongo database+layout (so there is nothing to move).
const isSameMongoTarget = (src, tgt) => {
  if (src?.type !== 'mongodb' || tgt?.type !== 'mongodb') return false
  let sUri, tUri
  try { sUri = dbConnectionString({ dbParams: { ...src } }); tUri = dbConnectionString({ dbParams: { ...tgt } }) } catch (e) { return false }
  if (sUri !== tUri) return false
  const dbName = (p) => p.unifiedDbName || (p.useUserIdsAsDbName ? '__peruser__' : 'freezr')
  const strat = (p) => p.dbUnificationStrategy || 'db'
  return dbName(src) === dbName(tgt) && strat(src) === strat(tgt) && !!src.useUserIdsAsDbName === !!tgt.useUserIdsAsDbName
}

/** Throw if migrating these (resolved) params is unsafe/pointless. */
export const assertDbMigrationAllowed = (resolvedSource, resolvedTarget, resolvedFs) => {
  if (resolvedTarget.type === 'nedb' && resolvedSource.type === 'nedb') {
    const e = new Error('Your database already lives on your file system (nedb). To move it, migrate your file system instead.')
    e.code = 'NEDB_TO_NEDB'
    throw e
  }
  if (resolvedTarget.type === 'nedb' && resolvedFs?.type === 'dropbox') {
    const e = new Error('A files-as-database (nedb) is not supported on Dropbox, which is your current file system. Choose a mongo database, or migrate your file system first.')
    e.code = 'DB_FS_INCOMPATIBLE'
    throw e
  }
  if (isSameMongoTarget(resolvedSource, resolvedTarget)) {
    const e = new Error('That target is the same mongo database and layout you already use — there is nothing to migrate.')
    e.code = 'SAME_DB'
    throw e
  }
}

// =======================================================================================
//  PUBLIC API
// =======================================================================================

/** Begin a DB migration. Password must already be verified by the controller. */
export const startDbMigration = async ({ userId, targetDbParams, confirmContinue = false, allowSystemTarget = IS_DEV_ENV }) => {
  const { dsManager } = requireCtx()
  if (!userId) throw new Error('startDbMigration: userId required')
  if (!targetDbParams || !targetDbParams.type) throw new Error('startDbMigration: targetDbParams.type required')

  const user = await readUser(userId)
  if (!user) throw new Error('User not found: ' + userId)

  // Mutual exclusion with both kinds of migration.
  if (user.dbMigration && BUSY_STATES.includes(user.dbMigration.status)) {
    const e = new Error('A database migration is already in progress for this account.'); e.code = 'MIGRATION_IN_PROGRESS'; throw e
  }
  if (user.fsMigration && CONCURRENT_BLOCKING.includes(user.fsMigration.status)) {
    const e = new Error('A file-system migration is currently running for this account; please wait for it to finish before migrating your database.'); e.code = 'MIGRATION_IN_PROGRESS'; throw e
  }

  // Normalise/validate the submitted target params (whitelist fields, map password→pass,
  // translate + validate the unified-collection choice). Same cleaner registration uses.
  const cleanedTarget = checkAndCleanDb({ ...targetDbParams })
  if (!cleanedTarget || !cleanedTarget.type) {
    const e = new Error('The target database parameters are invalid.'); e.code = 'DB_PARAMS_INVALID'; throw e
  }

  const targetIsSystem = cleanedTarget.choice === 'sysDefault' || cleanedTarget.type === 'system'
  if (targetIsSystem && !allowSystemTarget) {
    const e = new Error('Migrating your database to the host/system default is not supported. Please choose a specific database.'); e.code = 'TARGET_SYSTEM_NOT_ALLOWED'; throw e
  }

  const resolvedSource = resolveDbParams(user.dbParams)
  const resolvedTarget = targetIsSystem ? resolveDbParams({ type: 'system' }) : cleanedTarget
  const resolvedFs = resolveUserFs(user)
  if (!resolvedSource?.type) throw new Error('Could not resolve your current database params')
  if (!resolvedTarget?.type) throw new Error('Could not resolve the target database params')

  assertDbMigrationAllowed(resolvedSource, resolvedTarget, resolvedFs)

  // Confirm the target works (real write/read) unless it's the known-good host db.
  if (!targetIsSystem) {
    const check = await checkDB({ dbParams: resolvedTarget, fsParams: resolvedFs }, { okToCheckOnLocal: true })
    if (!check || !check.checkpassed) {
      const e = new Error('The target database did not pass the connection test: ' + (check?.err || 'unknown error')); e.code = 'DB_CHECK_FAILED'; throw e
    }
    // Best-effort: remove the row checkDB just wrote (owner 'test', params table).
    try {
      const t = dsManager.createTransientUserDS('test', { dbParams: resolvedTarget, fsParams: resolvedFs })
      const tdb = await t.getorInitDb({ owner: 'test', app_name: 'info.freezr.admin', collection_name: 'params' }, ACCESS)
      try { await tdb.delete_record('test_write_id') } catch (e) {}
      clearTransientTimer(t)
    } catch (e) {}
  }

  // Pre-check: does the target already hold tables for this user?
  if (!confirmContinue) {
    try {
      const probe = dsManager.createTransientUserDS(userId, { dbParams: resolvedTarget, fsParams: resolvedFs })
      const tables = await listUserTables(probe, userId)
      let total = 0
      for (const t of tables) { try { const d = await probe.getorInitDb({ owner: userId, app_table: t }, ACCESS); total += await d.db.count_async({}) } catch (e) {} }
      clearTransientTimer(probe)
      if (total > 0) {
        const e = new Error('The target database already contains ' + total + ' record(s) for "' + userId + '" (perhaps from a previous attempt). Continue and overwrite them?')
        e.code = 'TARGET_NOT_EMPTY'; e.recordCount = total; throw e
      }
    } catch (e) {
      if (e.code === 'TARGET_NOT_EMPTY') throw e
      console.warn('dbMigration: target pre-check failed (continuing):', e.message)
    }
  }

  const now = Date.now()
  const pendingDbParams = targetIsSystem ? { type: 'system' } : encryptParams(cleanedTarget)

  await updateUserMigration(userId, { status: STATUS.PREPARING, startedAt: now, updatedAt: now, pendingDbParams })
  await writeRow(userId, {
    status: STATUS.PREPARING,
    cancelRequested: false,
    sourceType: resolvedSource.type,
    targetType: targetIsSystem ? 'system' : cleanedTarget.type,
    tablesDone: [],
    totalTables: 0,
    totalRecords: 0,
    recordsCopied: 0,
    currentTable: null,
    error: null,
    startedAt: now
  })

  // Pre-flight: persist nedb journal to the source, clear caches, evict the cached USER_DS so the
  // gate reads the fresh (locked) status and the worker reads a clean source.
  const flush = await dsManager.flushAndEvictUserDS(userId)
  if (flush.persistErrors && flush.persistErrors.length) {
    await fail(userId, 'Could not persist your database before migrating: ' + JSON.stringify(flush.persistErrors), STATUS.PREPARING)
    const e = new Error('Pre-flight persist failed'); e.code = 'PREFLIGHT_FAILED'; throw e
  }

  scheduleWorker(userId)
  return { status: STATUS.PREPARING }
}

export const abortDbMigration = async (userId) => {
  const user = await readUser(userId)
  const status = user?.dbMigration?.status
  if (!status || !FORWARD_RESUMABLE.includes(status)) throw new Error('No cancellable migration in progress.')
  await writeRow(userId, { cancelRequested: true })
  cancelCache.set(userId, true)
  if (!activeWorkers.has(userId)) {
    const idx = queue.indexOf(userId); if (idx >= 0) queue.splice(idx, 1)
    await abortCleanup(userId)
  }
  return { status: 'cancelling' }
}

export const retryDbMigration = async (userId) => {
  const { dsManager } = requireCtx()
  const user = await readUser(userId)
  const dm = user?.dbMigration
  if (!dm || dm.status !== STATUS.FAILED) throw new Error('No failed migration to retry.')
  if (!dm.pendingDbParams) throw new Error('Cannot retry — the target details are no longer available. Please re-enter them.')
  await updateUserMigration(userId, { ...dm, status: STATUS.PREPARING, error: null, updatedAt: Date.now() })
  await writeRow(userId, { status: STATUS.PREPARING, cancelRequested: false, error: null })
  await dsManager.flushAndEvictUserDS(userId)
  scheduleWorker(userId)
  return { status: STATUS.PREPARING }
}

export const dismissFailedDbMigration = async (userId) => {
  const user = await readUser(userId)
  const dm = user?.dbMigration
  if (!dm || dm.status !== STATUS.FAILED) throw new Error('No failed migration to clear.')
  await abortCleanup(userId)
  return { status: STATUS.NONE }
}

export const rollbackDbMigration = async (userId) => {
  const user = await readUser(userId)
  const dm = user?.dbMigration
  if (!dm || (dm.status !== STATUS.AWAITING && dm.status !== STATUS.ROLLING_BACK)) {
    throw new Error('Nothing to roll back (account is not awaiting confirmation).')
  }
  await doRollback(userId)
  return { status: STATUS.ROLLED_BACK }
}

export const confirmDeleteOldDb = async (userId) => {
  const user = await readUser(userId)
  const dm = user?.dbMigration
  if (!dm || (dm.status !== STATUS.AWAITING && dm.status !== STATUS.CLEANING_UP)) {
    throw new Error('Nothing to delete (account is not awaiting confirmation).')
  }
  await doCleanup(userId)
  return { status: STATUS.COMPLETE }
}

export const getDbMigrationStatus = async (userId) => {
  const user = await readUser(userId)
  const dm = user?.dbMigration || { status: STATUS.NONE }
  const row = await readRow(userId)
  const status = dm.status || STATUS.NONE
  const totalRecords = row?.totalRecords || 0
  const recordsCopied = row?.recordsCopied || 0
  let percent = 0
  if (status === STATUS.COPYING) percent = totalRecords > 0 ? 5 + Math.round((recordsCopied / totalRecords) * 90) : 5
  else if (status === STATUS.VERIFYING) percent = 96
  else if ([STATUS.AWAITING, STATUS.COMPLETE, STATUS.ROLLED_BACK].includes(status)) percent = 100
  else if (status === STATUS.PREPARING) percent = 3
  const currentFs = describeFsDbParams(decryptParams(user?.fsParams) || {}, 'FS').display
  const currentDb = describeFsDbParams(decryptParams(user?.dbParams) || {}, 'DB').display
  const dbIsNedb = resolveDbParams(user?.dbParams || {})?.type === 'nedb'
  return {
    status,
    locked: LOCKED_STATES.includes(status),
    phaseLabel: PHASE_LABEL[status] || status,
    percent,
    currentFs,
    currentDb,
    dbIsNedb,
    tablesDone: (row?.tablesDone || []).length,
    totalTables: row?.totalTables || 0,
    recordsCopied,
    totalRecords,
    currentTable: row?.currentTable || null,
    sourceType: row?.sourceType || null,
    targetType: row?.targetType || null,
    cutoverAt: dm.cutoverAt || null,
    error: dm.error || row?.error || null
  }
}

export const recoverOnStartup = async () => {
  try {
    const db = await migrationsDb()
    const rows = await db.query({}, {})
    let resumed = 0
    for (const row of (rows || [])) {
      const user = await readUser(row.user_id)
      const status = user?.dbMigration?.status
      if (!status) continue
      if (FORWARD_RESUMABLE.includes(status)) { scheduleWorker(row.user_id); resumed++ }
      else if (status === STATUS.ROLLING_BACK) { doRollback(row.user_id).catch(e => console.warn('recover db rollback', row.user_id, e.message)); resumed++ }
      else if (status === STATUS.CLEANING_UP) { doCleanup(row.user_id).catch(e => console.warn('recover db cleanup', row.user_id, e.message)); resumed++ }
    }
    if (resumed) console.log('🔁 dbMigration: resumed ' + resumed + ' migration(s) after startup')
    return { resumed }
  } catch (e) {
    console.warn('🔴 dbMigration.recoverOnStartup', e.message)
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
      .catch(err => console.warn('🔴 dbMigration worker error for ' + userId, err.message))
      .finally(() => { activeWorkers.delete(userId); cancelCache.delete(userId); pump() })
  }
}

const runForwardWorker = async (userId) => {
  const user = await readUser(userId)
  const dm = user?.dbMigration
  if (!dm || !FORWARD_RESUMABLE.includes(dm.status)) return

  const resolvedTarget = resolveDbParams(dm.pendingDbParams)
  const resolvedSource = resolveDbParams(user.dbParams)
  const resolvedFs = resolveUserFs(user)
  if (!resolvedTarget?.type || !resolvedSource?.type) { await fail(userId, 'Missing source/target params', dm.status); return }

  const srcDs = requireCtx().dsManager.createTransientUserDS(userId, { dbParams: resolvedSource, fsParams: resolvedFs })
  const tgtDs = requireCtx().dsManager.createTransientUserDS(userId, { dbParams: resolvedTarget, fsParams: resolvedFs })
  const sourceIsUnified = hasUnifiedStrategy(resolvedSource, userId)
  const targetIsUnified = hasUnifiedStrategy(resolvedTarget, userId)
  const targetIsNedb = resolvedTarget.type === 'nedb'

  cancelCache.set(userId, false)
  const heartbeat = setInterval(async () => {
    try {
      const row = await readRow(userId)
      if (row?.cancelRequested) cancelCache.set(userId, true)
      await writeRow(userId, { heartbeatAt: Date.now() })
    } catch (e) {}
  }, 7000)

  const delayMs = interRecordDelayMs()
  const throttle = async () => { await yieldUnderLoad(); if (delayMs > 0) await sleep(delayMs) }
  const shouldCancel = () => cancelCache.get(userId) === true

  try {
    await setStatus(userId, STATUS.COPYING)
    const tables = await listUserTables(srcDs, userId)
    let totalRecords = 0
    for (const t of tables) { try { const d = await srcDs.getorInitDb({ owner: userId, app_table: t }, ACCESS); totalRecords += await d.db.count_async({}) } catch (e) {} }
    await writeRow(userId, { totalTables: tables.length, totalRecords, status: STATUS.COPYING })

    const startRow = await readRow(userId)
    const tablesDone = startRow?.tablesDone || []
    let recordsCopied = startRow?.recordsCopied || 0
    let lastWrite = 0; let sinceWrite = 0

    for (const tableName of tables) {
      if (tablesDone.includes(tableName)) continue
      if (shouldCancel()) break
      await writeRow(userId, { currentTable: tableName })
      // Always wipe-then-copy a not-yet-done table: a no-op on a fresh empty target, and the
      // crash-safe resume / target-not-empty path (avoids duplicate-_id on re-insert).
      await wipeTable({ tgtDs, owner: userId, tableName })
      const res = await copyTable({
        srcDs, tgtDs, owner: userId, tableName, sourceIsUnified, targetIsNedb, shouldCancel, throttle,
        onProgress: (p) => {
          recordsCopied++
          sinceWrite++
          const nowT = Date.now()
          if (sinceWrite >= 50 || (nowT - lastWrite) > 2000) {
            lastWrite = nowT; sinceWrite = 0
            writeRow(userId, { recordsCopied, currentTable: p.currentTable }).catch(() => {})
          }
        }
      })
      if (res.cancelled) { clearInterval(heartbeat); cleanupTransients(srcDs, tgtDs); await abortCleanup(userId, { resolvedTarget, resolvedFs }); return }
      tablesDone.push(tableName)
      await writeRow(userId, { tablesDone, recordsCopied })
    }

    if (shouldCancel()) { clearInterval(heartbeat); cleanupTransients(srcDs, tgtDs); await abortCleanup(userId, { resolvedTarget, resolvedFs }); return }

    // VERIFYING — counts + sample compare; recopy a table once if its count drifted (eg an
    // account-table write slipped through the exemption during the copy), else fail.
    await setStatus(userId, STATUS.VERIFYING)
    for (const tableName of tables) {
      let v = await verifyTable({ srcDs, tgtDs, owner: userId, tableName, sourceIsUnified, targetIsUnified, targetIsNedb })
      if (!v.ok && v.reason === 'count_mismatch') {
        await wipeTable({ tgtDs, owner: userId, tableName })
        await copyTable({ srcDs, tgtDs, owner: userId, tableName, sourceIsUnified, targetIsNedb, shouldCancel: () => false, throttle })
        v = await verifyTable({ srcDs, tgtDs, owner: userId, tableName, sourceIsUnified, targetIsUnified, targetIsNedb })
      }
      if (!v.ok) {
        clearInterval(heartbeat); cleanupTransients(srcDs, tgtDs)
        await fail(userId, 'Verification failed for table "' + tableName + '" (' + v.reason + ').', STATUS.VERIFYING, { table: tableName, reason: v.reason })
        return
      }
    }

    clearInterval(heartbeat)
    cleanupTransients(srcDs, tgtDs)
    await cutover(userId, { resolvedSource })
  } catch (err) {
    clearInterval(heartbeat)
    cleanupTransients(srcDs, tgtDs)
    await fail(userId, err.message, STATUS.COPYING)
  }
}

const cleanupTransients = (...dss) => { dss.forEach(clearTransientTimer) }

const cutover = async (userId, { resolvedSource }) => {
  const { dsManager } = requireCtx()
  const now = Date.now()
  const user = await readUser(userId)
  await updateUserMigration(userId, {
    status: STATUS.AWAITING,
    startedAt: user.dbMigration?.startedAt,
    cutoverAt: now,
    updatedAt: now,
    retiredDbParams: encryptParams(resolvedSource), // resolved source, for cleanup/rollback connector
    retiredDbParamsOriginal: user.dbParams, // original (may be {type:'system'}) for clean rollback
    pendingDbParams: null
  }, { dbParams: user.dbMigration.pendingDbParams }) // <-- the switch
  await dsManager.flushAndEvictUserDS(userId)
  await writeRow(userId, { status: STATUS.AWAITING, currentTable: null })
}

const doRollback = async (userId) => {
  const { dsManager } = requireCtx()
  const user = await readUser(userId)
  const dm = user.dbMigration
  const now = Date.now()

  await updateUserMigration(userId, { ...dm, status: STATUS.ROLLING_BACK, updatedAt: now })
  await writeRow(userId, { status: STATUS.ROLLING_BACK })
  await dsManager.flushAndEvictUserDS(userId)

  const discardedDbParams = user.dbParams // currently the target
  await updateUserMigration(userId, {
    status: STATUS.ROLLED_BACK,
    rolledBackAt: now,
    updatedAt: now,
    discardedDbParams,
    retiredDbParams: dm.retiredDbParams
  }, { dbParams: dm.retiredDbParamsOriginal })
  await dsManager.flushAndEvictUserDS(userId) // rebuild on source; status unlocked

  // Best-effort: discard the data written to the (now-abandoned) target.
  try {
    const resolvedTarget = resolveDbParams(discardedDbParams)
    const resolvedFs = resolveUserFs(user)
    await discardDbData(resolvedTarget, resolvedFs, userId)
  } catch (e) { console.warn('dbMigration: discard target on rollback', e.message) }

  await updateUserMigration(userId, { status: STATUS.NONE })
  await dsManager.flushAndEvictUserDS(userId)
}

const doCleanup = async (userId) => {
  const { dsManager } = requireCtx()
  const user = await readUser(userId)
  const dm = user.dbMigration
  const now = Date.now()

  await updateUserMigration(userId, { ...dm, status: STATUS.CLEANING_UP, updatedAt: now })
  await writeRow(userId, { status: STATUS.CLEANING_UP })

  try {
    const resolvedSource = resolveDbParams(dm.retiredDbParams)
    const resolvedFs = resolveUserFs(user)
    await discardDbData(resolvedSource, resolvedFs, userId)
  } catch (e) { console.warn('dbMigration: cleanup old db', e.message) }

  await writeRow(userId, { status: STATUS.COMPLETE })
  await updateUserMigration(userId, { status: STATUS.NONE })
  await dsManager.flushAndEvictUserDS(userId)
}

// Empty every table of a (resolved) database for this user, and for nedb remove its db folder.
const discardDbData = async (resolvedDbParams, resolvedFs, userId) => {
  const { dsManager } = requireCtx()
  const ds = dsManager.createTransientUserDS(userId, { dbParams: resolvedDbParams, fsParams: resolvedFs })
  try {
    const tables = await listUserTables(ds, userId)
    for (const t of tables) { try { await wipeTable({ tgtDs: ds, owner: userId, tableName: t }) } catch (e) {} }
  } finally { clearTransientTimer(ds) }
  if (resolvedDbParams.type === 'nedb' && resolvedFs?.type) {
    try {
      const raw = await createRawFs(resolvedFs)
      await raw.removeFolder_async(userSubtreeBase(resolvedFs, userId) + '/db')
    } catch (e) { console.warn('dbMigration: remove nedb db folder', e.message) }
  }
}

// Abort a pre-cutover migration: discard the partial target data, clear migration, unlock.
const abortCleanup = async (userId, ctx) => {
  const { dsManager } = requireCtx()
  try {
    const user = await readUser(userId)
    const dm = user?.dbMigration
    if (dm?.pendingDbParams) {
      const resolvedTarget = ctx?.resolvedTarget || resolveDbParams(dm.pendingDbParams)
      const resolvedFs = ctx?.resolvedFs || resolveUserFs(user)
      await discardDbData(resolvedTarget, resolvedFs, userId)
    }
  } catch (e) { console.warn('dbMigration: abort cleanup', e.message) }
  await updateUserMigration(userId, { status: STATUS.NONE })
  await writeRow(userId, { status: STATUS.NONE, cancelRequested: false, currentTable: null })
  await dsManager.flushAndEvictUserDS(userId)
}

// ----- small status writers ------------------------------------------------------------
const setStatus = async (userId, status) => {
  const user = await readUser(userId)
  await updateUserMigration(userId, { ...(user.dbMigration || {}), status, updatedAt: Date.now() })
  await writeRow(userId, { status })
}
const fail = async (userId, message, phase, extra = {}) => {
  const { dsManager } = requireCtx()
  const user = await readUser(userId)
  const error = { message, phase, at: Date.now(), ...extra }
  await updateUserMigration(userId, { status: STATUS.FAILED, error, pendingDbParams: user.dbMigration?.pendingDbParams || null })
  await writeRow(userId, { status: STATUS.FAILED, error: message })
  try { await dsManager.flushAndEvictUserDS(userId) } catch (e) {}
}

export default {
  initDbMigrationService,
  startDbMigration,
  abortDbMigration,
  retryDbMigration,
  dismissFailedDbMigration,
  rollbackDbMigration,
  confirmDeleteOldDb,
  getDbMigrationStatus,
  recoverOnStartup,
  assertDbMigrationAllowed,
  STATUS,
  LOCKED_STATES,
  IS_DEV_ENV
}
