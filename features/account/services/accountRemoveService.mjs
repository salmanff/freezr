// freezr.info - accountRemoveService.mjs
//
// Single shared service for removing a user from this server, used by BOTH the user-facing
// /account/remove flow AND the admin "delete users" flow. Two modes:
//
//   - 'full'   (user is on the host/system storage): delete all their data + their account.
//   - 'detach' (user is on their OWN cloud storage): remove their account/credentials/tokens
//              from this server but LEAVE their data where it lives (they can reconnect elsewhere).
//
// Classification is by FS location: a system/local (host) fs ⇒ full; a cloud fs ⇒ detach.
// In both modes a `removePublicPosts` flag controls whether the user's public posts (on this
// server's public store) are also removed.

import { deleteApp } from './appMgmtService.mjs'
import { deleteAllAppTokensForUser } from './passwordService.mjs'
import { decryptParams } from '../../register/services/registerServices.mjs'
import { userAppListOAC } from '../../../common/helpers/config.mjs'
import { createRawFs, userSubtreeBase } from '../../../adapters/datastore/fsConnectors/fsRawFactory.mjs'

// freezr's own per-user system tables (not represented in the app_list) that hold user data.
const SYSTEM_APP_TABLES = [
  'info.freezr.account.user_devices',
  'info.freezr.account.permissions',
  'dev.ceps.privatefeeds',
  'dev.ceps.privatefeeds.codes',
  'dev.ceps.messages.got',
  'dev.ceps.messages.sent',
  'dev.ceps.groups',
  'dev.ceps.contacts'
]

// Is the file system the user's OWN (cloud) storage, vs the host's (system/local)?
const fsIsOwn = (fsType) => !!fsType && fsType !== 'system' && fsType !== 'local'
// Is the database the user's OWN external server (mongo)? nedb lives on the FS, so it is
// not an independently-detachable store (its fate follows the FS); a system DB is the host's.
const dbIsOwn = (dbType) => !!dbType && dbType !== 'system' && dbType !== 'nedb'

/**
 * Describe how a user can be removed, considering BOTH where their files AND their database
 * live. A user has a real choice (detach vs full) whenever ANY of their data is on their own
 * storage — their own cloud FS, their own mongo DB, or both.
 * @param {Object} rawFsParams - the user record's fsParams ({type:'system'}, encrypted cloud, etc.)
 * @param {Object} [rawDbParams] - the user record's dbParams ({type:'system'|'nedb'|'mongodb'}, ...)
 * @returns {{fsType, dbType, ownsFs, ownsDb, hasChoice, keptNoun, mode}}
 */
export const describeRemoval = (rawFsParams, rawDbParams) => {
  const fsType = decryptParams(rawFsParams)?.type
  const dbType = decryptParams(rawDbParams)?.type
  const ownsFs = fsIsOwn(fsType)
  const ownsDb = dbIsOwn(dbType)
  const hasChoice = ownsFs || ownsDb
  // What the user gets to KEEP if they detach (used for the page wording).
  let keptNoun = 'your data'
  if (ownsFs && ownsDb) keptNoun = 'your files and your database'
  else if (ownsDb) keptNoun = 'your database'
  else if (ownsFs) keptNoun = 'your files'
  return { fsType, dbType, ownsFs, ownsDb, hasChoice, keptNoun, mode: hasChoice ? 'detach' : 'full' }
}

/**
 * Classify how a user should be removed, by where their files AND database live.
 * @param {Object} rawFsParams - the user record's fsParams
 * @param {Object} [rawDbParams] - the user record's dbParams
 * @returns {'full'|'detach'}  'detach' (choice available) if any data is the user's own.
 */
export const classifyRemoval = (rawFsParams, rawDbParams) => describeRemoval(rawFsParams, rawDbParams).mode

// Remove the user's public posts from THIS server's public store (best-effort).
const removePublicPostsForUser = async (userId, publicRecordsDb, publicManifestsDb) => {
  try {
    if (publicRecordsDb?.delete_records) await publicRecordsDb.delete_records({ data_owner: userId }, null)
    if (publicManifestsDb?.delete_records) await publicManifestsDb.delete_records({ user_id: userId }, null)
  } catch (e) {
    console.warn('accountRemove: public posts removal (non-fatal):', e.message)
  }
}

/**
 * FULL removal: delete every app (data + files + per-app publics), the per-user system tables,
 * app tokens, sessions, and finally the user record. With removePublicPosts=false the public
 * posts are kept (deleteApp called with doNotDeletePublics).
 */
export const removeUserDataAndRecord = async (options) => {
  const {
    userId, allUsersDb, userDS, freezrPrefs,
    publicRecordsDb, publicManifestsDb, tokenDb, sessionStore,
    removePublicPosts = true
  } = options

  const failures = []
  const appList = await userDS.getorInitDb(userAppListOAC(userId), { freezrPrefs })
  const allApps = await appList.query({}, {})

  for (const appItem of allApps) {
    try {
      await deleteApp({ userDS, userId, appName: appItem.app_name, freezrPrefs, publicManifestsDb, publicRecordsDb, doNotDeletePublics: !removePublicPosts })
    } catch (error) {
      console.error('❌ removeUserDataAndRecord (deleteApp):', error)
      failures.push({ error: error.message, appName: appItem.app_name })
    }
  }
  if (failures.length > 0) throw new Error(JSON.stringify({ error: 'Errors deleting some apps', failures }))

  for (const appTable of SYSTEM_APP_TABLES) {
    try {
      const sysApp = await userDS.getorInitDb({ owner: userId, app_table: appTable }, { freezrPrefs })
      await sysApp.delete_records({}, null)
    } catch (error) {
      console.error('❌ removeUserDataAndRecord (system app):', error)
      failures.push({ error: error.message, appTable })
    }
  }
  if (failures.length > 0) throw new Error(JSON.stringify({ error: 'Errors deleting some system apps', failures }))

  // Sweep any remaining public posts not tied to a deleted app.
  if (removePublicPosts) await removePublicPostsForUser(userId, publicRecordsDb, publicManifestsDb)

  let tokensDeleted = 0
  let sessionsDestroyed = 0
  if (tokenDb && typeof tokenDb.delete_records === 'function') {
    const result = await deleteAllAppTokensForUser(tokenDb, userId)
    tokensDeleted = result?.deletedCount ?? 0
  }
  if (sessionStore && typeof sessionStore.destroyAllForUserId === 'function') {
    sessionsDestroyed = await sessionStore.destroyAllForUserId(userId)
  }

  await allUsersDb.delete_record(userId, null)
  return { tokensDeleted, sessionsDestroyed }
}

/**
 * DETACH: remove the user's account, app tokens and sessions from this server (and optionally
 * their public posts), but DO NOT touch their data — it stays on their own cloud storage.
 */
export const detachUserFromServer = async (options) => {
  const { userId, allUsersDb, tokenDb, sessionStore, publicRecordsDb, publicManifestsDb, removePublicPosts = false } = options

  if (removePublicPosts) await removePublicPostsForUser(userId, publicRecordsDb, publicManifestsDb)

  let tokensDeleted = 0
  let sessionsDestroyed = 0
  if (tokenDb && typeof tokenDb.delete_records === 'function') {
    const result = await deleteAllAppTokensForUser(tokenDb, userId)
    tokensDeleted = result?.deletedCount ?? 0
  }
  if (sessionStore && typeof sessionStore.destroyAllForUserId === 'function') {
    sessionsDestroyed = await sessionStore.destroyAllForUserId(userId)
  }

  await allUsersDb.delete_record(userId, null)
  return { tokensDeleted, sessionsDestroyed }
}

// Remove the user's entire FS subtree (apps/, files/, and any nedb db/) on whichever fs they
// use; resolves a 'system' fs to the host's fs. Best-effort (never throws).
const removeFsSubtree = async (dsManager, rawFsParams, userId) => {
  try {
    const fsType = decryptParams(rawFsParams)?.type
    const resolvedFs = (fsType === 'system') ? dsManager?.systemEnvironment?.fsParams : decryptParams(rawFsParams)
    if (resolvedFs?.type) {
      const rawConn = await createRawFs(resolvedFs)
      await rawConn.removeFolder_async(userSubtreeBase(resolvedFs, userId))
    }
  } catch (e) {
    console.warn('removeUserFromServer: fs subtree cleanup (non-fatal) for ' + userId + ':', e.message)
  }
}

// Delete ONLY the user's database records — every app table + the per-user system tables —
// leaving FS files untouched. Used on detach to clear items held in a host/system DATABASE
// server (eg the host's mongo) that the user cannot take with them, while keeping their own
// (cloud) files. Best-effort per table. (nedb has no separate server — its data is FS files,
// removed by removeFsSubtree — so this is only used for mongo-backed databases.)
const deleteUserDbRecordsOnly = async ({ userDS, userId, freezrPrefs }) => {
  try {
    const appList = await userDS.getorInitDb(userAppListOAC(userId), { freezrPrefs })
    const apps = await appList.query({}, {})
    for (const appItem of apps) {
      try {
        const top = await userDS.getorInitDb({ owner: userId, app_table: appItem.app_name }, { freezrPrefs })
        const tables = await top.getAllAppTableNames(appItem.app_name)
        for (const t of tables) {
          try {
            const db = await userDS.getorInitDb({ owner: userId, app_table: t }, { freezrPrefs })
            await db.delete_records({}, null)
          } catch (e) { console.warn('deleteUserDbRecordsOnly table', t, e.message) }
        }
      } catch (e) { console.warn('deleteUserDbRecordsOnly app', appItem.app_name, e.message) }
    }
    try { await appList.delete_records({}, null) } catch (e) { console.warn('deleteUserDbRecordsOnly app_list', e.message) }
  } catch (e) { console.warn('deleteUserDbRecordsOnly', e.message) }
  for (const appTable of SYSTEM_APP_TABLES) {
    try {
      const db = await userDS.getorInitDb({ owner: userId, app_table: appTable }, { freezrPrefs })
      await db.delete_records({}, null)
    } catch (e) { console.warn('deleteUserDbRecordsOnly system table', appTable, e.message) }
  }
}

/**
 * The single entry point both the user and admin flows call. Resolves the mode (full/detach)
 * from where the user's data lives unless one is supplied.
 *  - full:   delete ALL the user's data (own + host) and their account.
 *  - detach: KEEP the data on the user's OWN resources (own cloud fs and/or own mongo db), but
 *            ALWAYS delete data held on the host/system resources — the user can't take host
 *            storage with them — then remove their account.
 *
 * @param {Object} options - { dsManager, userId, freezrPrefs, allUsersDb, userDS, publicRecordsDb,
 *   publicManifestsDb, tokenDb, sessionStore, removePublicPosts, mode?, userRecord? }
 * @returns {Promise<{mode:string, tokensDeleted:number, sessionsDestroyed:number}>}
 */
export const removeUserFromServer = async (options) => {
  const { dsManager, userId, allUsersDb, freezrPrefs, userDS, removePublicPosts = false } = options

  const userRecord = options.userRecord || (await allUsersDb.query({ user_id: userId }, null))?.[0]
  if (!userRecord) throw new Error('User not found: ' + userId)
  const rawFs = userRecord.fsParams
  const desc = describeRemoval(rawFs, userRecord.dbParams)
  const mode = options.mode || desc.mode

  if (mode === 'full') {
    const result = await removeUserDataAndRecord({ ...options, removePublicPosts })
    await removeFsSubtree(dsManager, rawFs, userId) // clears leftover files/ + db/ (host or own)
    return { mode, ...result }
  }

  // DETACH — keep the user's own data, delete only the host-resident parts.
  // (a) Host file system: remove the subtree (apps/, files/, and any nedb db/ on the host).
  if (!desc.ownsFs) await removeFsSubtree(dsManager, rawFs, userId)
  // (b) Host/system DATABASE server (eg own cloud fs but data in the host's mongo): delete the
  //     user's records. Only for mongo-backed servers — nedb data is FS files (handled above).
  if (!desc.ownsDb && userDS) {
    const dbType = decryptParams(userRecord.dbParams)?.type
    const resolvedDbType = (dbType === 'system') ? dsManager?.systemEnvironment?.dbParams?.type : dbType
    if (resolvedDbType === 'mongodb') await deleteUserDbRecordsOnly({ userDS, userId, freezrPrefs })
  }
  const result = await detachUserFromServer({ ...options, removePublicPosts })
  return { mode, ...result }
}

export default { classifyRemoval, describeRemoval, removeUserDataAndRecord, detachUserFromServer, removeUserFromServer }
