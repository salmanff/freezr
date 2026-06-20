// freezr.info - dbRecordCopy.mjs
//
// Record-level copy + verify for DB migration. Everything goes THROUGH USER_DS objects (one
// built on the source dbParams, one on the target dbParams) so each connector applies its OWN
// physical layout (per-user-db / shared-collection / unified-collection) and its own _id rules.
// We never hand-build __owner/__appTable tags or _id prefixes: on read we canonicalise each
// record to its app-level form, and on write we hand it to the TARGET USER_DS with
// { restoreRecord: true } (which preserves _date_created/_date_modified) and let the target
// connector re-apply whatever its layout needs. See DB_MIGRATION_PLAN.md.

import { getOrigIdWithOatRemoved } from './mongo_utils.mjs'

const BATCH = 500
// Migration access never caches (avoids building huge caches / polluting the live singleton) and
// bypasses the offline-lock gate (the worker legitimately reads/writes while the user is locked).
const ACCESS = { noCache: true, bypassMigrationLock: true }

// Per-user system tables that hold data independently of the app_list (mirrors the set the
// account-remove service clears). Copied in addition to every app's own tables.
export const SYSTEM_TABLES = [
  'info.freezr.account.app_list',
  'info.freezr.account.permissions',
  'info.freezr.account.user_devices',
  'dev.ceps.privatefeeds',
  'dev.ceps.privatefeeds.codes',
  'dev.ceps.messages.got',
  'dev.ceps.messages.sent',
  'dev.ceps.groups',
  'dev.ceps.contacts'
]

// A table is an account/system table (copied LAST so the account-app exemption write-window is
// smallest, and the user's app_list lands after their app data).
export const isSystemTable = (t) => t.startsWith('info.freezr.account') || t.startsWith('dev.ceps')

/**
 * Enumerate every physical table for a user, as dotted names usable directly as `app_table`
 * (the dot⇆underscore mapping round-trips through every connector). Mirrors getStorageUse:
 * expand the app_list to each app's tables, then add the per-user system tables.
 */
export const listUserTables = async (srcDs, owner) => {
  const tables = new Set()
  try {
    const appListDs = await srcDs.getorInitDb({ owner, app_name: 'info.freezr.account', collection_name: 'app_list' }, ACCESS)
    const apps = await appListDs.query({}, {})
    for (const app of (apps || [])) {
      if (!app || !app.app_name) continue
      try {
        const top = await srcDs.getorInitDb({ owner, app_table: app.app_name }, ACCESS)
        const names = await top.getAllAppTableNames(app.app_name)
        for (const n of (names || [])) if (n) tables.add(n)
      } catch (e) { console.warn('dbRecordCopy.listUserTables app', app.app_name, e.message) }
    }
  } catch (e) { console.warn('dbRecordCopy.listUserTables app_list', e.message) }
  SYSTEM_TABLES.forEach(t => tables.add(t))
  // app data first, account/system tables last
  return [...tables].sort((a, b) => (isSystemTable(a) ? 1 : 0) - (isSystemTable(b) ? 1 : 0))
}

// Reduce a stored record to its canonical, app-level form.
//  - unified-mongo source: drop the __owner/__appTable tags and reverse the _id prefix
//  - nedb target: an ObjectId _id must become its 24-hex string (nedb keys on strings)
const canonicalize = (rec, oat, sourceIsUnified, targetIsNedb) => {
  const out = { ...rec }
  if (sourceIsUnified) {
    delete out.__owner
    delete out.__appTable
    out._id = getOrigIdWithOatRemoved(out._id, oat)
  }
  if (targetIsNedb && out._id && typeof out._id !== 'string' && typeof out._id.toString === 'function') {
    out._id = out._id.toString()
  }
  return out
}

const persistIfNedb = async (ds) => {
  if (ds && ds.db && typeof ds.db.persistCachedDatabase === 'function') {
    await new Promise((resolve) => { try { ds.db.persistCachedDatabase(() => resolve()) } catch (e) { resolve() } })
  }
}

/**
 * Copy one table from source to target, record by record (no batch insert — every write goes
 * through the target USER_DS so its rules apply). Reads in _id-sorted batches (stable because
 * the user is offline-locked). Returns { recordsCopied, cancelled }.
 */
export const copyTable = async ({ srcDs, tgtDs, owner, tableName, sourceIsUnified, targetIsNedb, onProgress, shouldCancel, throttle }) => {
  const oac = { owner, app_table: tableName }
  const sdb = await srcDs.getorInitDb(oac, ACCESS)
  const tdb = await tgtDs.getorInitDb(oac, ACCESS)
  let skip = 0
  let recordsCopied = 0
  let cancelled = false

  while (true) {
    if (shouldCancel && shouldCancel()) { cancelled = true; break }
    const batch = await sdb.query({}, { sort: { _id: 1 }, skip, limit: BATCH })
    if (!batch || batch.length === 0) break
    for (const rec of batch) {
      const clean = canonicalize(rec, oac, sourceIsUnified, targetIsNedb)
      await tdb.create(clean._id, clean, { restoreRecord: true })
      recordsCopied++
      if (onProgress) onProgress({ recordsCopied, currentTable: tableName })
      if (throttle) await throttle()
    }
    skip += batch.length
    if (batch.length < BATCH) break
  }
  await persistIfNedb(tdb) // compact nedb append files into the single .db (no-op for mongo)
  return { recordsCopied, cancelled }
}

/** Empty a table on the target (used on resume to redo an incomplete table, and for a
 *  target-not-empty wipe). Works for both stores: mongo deleteMany, nedb remove-all + compact. */
export const wipeTable = async ({ tgtDs, owner, tableName }) => {
  const tdb = await tgtDs.getorInitDb({ owner, app_table: tableName }, ACCESS)
  await tdb.delete_records({}, { multi: true })
  await persistIfNedb(tdb)
}

const countTable = async (ds, owner, tableName) => {
  const d = await ds.getorInitDb({ owner, app_table: tableName }, ACCESS)
  return await d.db.count_async({})
}

// Order-independent, representation-independent string form of a record for spot-comparison.
const stableStringify = (v) => {
  if (v === null || v === undefined) return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  if (typeof v === 'object') {
    if (typeof v.toISOString === 'function') return JSON.stringify(v.toISOString()) // Date
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}'
  }
  return JSON.stringify(v)
}
const normalizeForCompare = (rec, oat, isUnified) => {
  const r = { ...rec }
  delete r.__owner; delete r.__appTable
  if (isUnified) r._id = getOrigIdWithOatRemoved(r._id, oat)
  r._id = (r._id && typeof r._id.toString === 'function') ? r._id.toString() : r._id
  return stableStringify(r)
}

/**
 * Verify a copied table: counts must match (an absent collection counts as 0), and a small
 * sample of records must be present and byte-identical (catches serialization drift, eg a
 * BSON Binary that can't survive to nedb). Returns { ok, ... }.
 */
export const verifyTable = async ({ srcDs, tgtDs, owner, tableName, sampleSize = 3, sourceIsUnified, targetIsUnified, targetIsNedb }) => {
  const srcCount = await countTable(srcDs, owner, tableName)
  const tgtCount = await countTable(tgtDs, owner, tableName)
  if (srcCount !== tgtCount) return { ok: false, reason: 'count_mismatch', tableName, srcCount, tgtCount }
  if (!srcCount) return { ok: true, tableName, count: 0 }

  const oac = { owner, app_table: tableName }
  const sdb = await srcDs.getorInitDb(oac, ACCESS)
  const tdb = await tgtDs.getorInitDb(oac, ACCESS)
  const sample = await sdb.query({}, { sort: { _id: 1 }, limit: sampleSize })
  for (const rec of (sample || [])) {
    const cleanId = canonicalize(rec, oac, sourceIsUnified, targetIsNedb)._id
    const tgt = await tdb.read_by_id(cleanId)
    if (!tgt) return { ok: false, reason: 'missing_record', tableName, id: String(cleanId) }
    if (normalizeForCompare(rec, oac, sourceIsUnified) !== normalizeForCompare(tgt, oac, targetIsUnified)) {
      return { ok: false, reason: 'record_mismatch', tableName, id: String(cleanId) }
    }
  }
  return { ok: true, tableName, count: srcCount }
}

export const countTableExport = countTable
export default { listUserTables, copyTable, wipeTable, verifyTable, SYSTEM_TABLES, isSystemTable }
