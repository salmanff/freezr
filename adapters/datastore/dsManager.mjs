// freezr.info - Modern Data Store Manager (WITH USERCACHE) 
// 
// Updated to pass UserCache instances to USER_DS instead of full CacheManager

import USER_DS, { appTableName } from './userDsMgr.mjs'
import { SYSTEM_USER_IDS, FREEZR_ADMIN_DBs } from '../../common/helpers/config.mjs'
import { removeLastPathElement } from '../../common/helpers/utils.mjs'
import CacheManager from './cache/cacheManager.mjs'
import UserCache from './cache/userCache.mjs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dsmDir = path.dirname(fileURLToPath(import.meta.url)) // adapters/datastore
const ROOT_DIR = removeLastPathElement(__dsmDir, 2) + path.sep // repo root

function DATA_STORE_MANAGER () {
  const self = this

  self.freezrIsSetup = false
  self.users = {} // each a USER_DS
  
  // Initialize global cache manager (singleton)
  self.cacheManager = new CacheManager()
  
  // Track UserCache instances per user
  self.userCaches = {}

  self.getOrSetUserDS = async function (owner, options) {
    if (!options || !options.freezrPrefs) throw new Error('No options passed to getorsetuserprefs ' + JSON.stringify(options))
  
    if (self.users[owner]) {
      return self.users[owner]
    } else {
      const userOac = { owner: 'fradmin', app_name: 'info.freezr.admin', collection_name: 'users' }
      const allUsersDb = self.getDB(userOac)
      
      if (!allUsersDb) {
        throw new Error('Could not get users database - this needs to be initialized on startup')
      }
      
      const ownerEntries = await allUsersDb.query({ user_id: owner }, {})
      
      if (!ownerEntries || ownerEntries.length === 0) {
        console.warn('ds.getOrSetUserDS', 'no user in ds for' + owner)
        throw new Error('no user ' + owner)
      } else {
        if (ownerEntries.length > 1) console.error('🔴 SERIOUS ERROR - More than one user found in users db')
        
        const rawDbParams = ownerEntries[0].dbParams
        const rawFsParams = ownerEntries[0].fsParams
        const rawSlParams = ownerEntries[0].slParams
        const rawLmParams = ownerEntries[0].lmParams

        // Shallow-clone the shared systemEnvironment params: the decoration below
        // (systemDb / useUserIdsAsDbName / dbUnificationStrategy / systemFs) sets
        // top-level keys, and without a copy every system user would mutate the one
        // shared systemEnvironment object in place.
        const dbParams = rawDbParams
          ? (rawDbParams?.type === 'system'
              ? { ...self.systemEnvironment.dbParams }
              : rawDbParams)
          : null
        const fsParams = rawFsParams
          ? (rawFsParams?.type === 'system'
              ? { ...self.systemEnvironment.fsParams }
              : rawFsParams)
          : null
        if (dbParams && rawDbParams?.type === 'system') {
          dbParams.systemDb = true
          dbParams.useUserIdsAsDbName = options?.freezrPrefs?.useUserIdsAsDbName
          dbParams.dbUnificationStrategy = options?.freezrPrefs?.dbUnificationStrategy
        }
        if (fsParams && rawFsParams?.type === 'system') {
          fsParams.systemFs = true
        }
        const slParams = rawSlParams
        const lmParams = rawLmParams

        if (fsParams && fsParams.type && dbParams && dbParams.type) {
          // Create or get UserCache for this owner (with scoped interface for security)
          if (!self.userCaches[owner]) {
            const scopedInterface = self.cacheManager.createUserInterface(owner)
            self.userCaches[owner] = new UserCache(scopedInterface, owner)
          }
          
          // Pass UserCache in env.userCache
          self.users[owner] = new USER_DS(owner, { 
            dbParams, 
            fsParams, 
            slParams, 
            lmParams,
            limits: ownerEntries[0].limits, 
            userPrefs: ownerEntries[0].userPrefs,
            userCache: self.userCaches[owner]  // Pass UserCache, not CacheManager
          })
          // Surface the migration lock status for the migrationLockGuard fast-path (both
          // FS and DB migrations lock the user via the same chokepoint gate).
          self.users[owner].fsMigrationStatus = ownerEntries[0].fsMigration?.status || null
          self.users[owner].dbMigrationStatus = ownerEntries[0].dbMigration?.status || null

          // Storage recalc is triggered lazily on first write operation (create/update/delete)
          // rather than on USER_DS creation, to avoid initializing all tables when
          // the DS is created from a public/unauthenticated context
          // ie removed this:
          // if (ownerEntries[0].limits && ownerEntries[0].limits.storage) {
          //   self.users[owner].setTimerToRecalcStorage()
          // }
          return self.users[owner]
        } else {
          console.warn('🔴 ds.getOrSetUserDS', 'incomplete user ' + owner)
          throw new Error('user incomplete')
        }
      }
    }
  }

  self.setSystemUserDS = function (owner, env) {
    if (!owner) {
      throw new Error('no owner for setSystemUserDS')
    } else if (owner === 'undefined') {
      throw new Error('undefined string owner for setSystemUserDS - SNBH')
    } else if (!env || !env.fsParams || !env.dbParams) {
      throw new Error('undefined env params for user - SNBH')
    } else if (!SYSTEM_USER_IDS.includes(owner)) {
      console.warn('setSystemUserDS only used for system uses - cannot initiate for ', { owner })
      throw new Error('setSystemUserDS only used for system uses - cannot initiate for ' + owner)
    } else {
      // Create or get UserCache for this owner (with scoped interface for security)
      if (!self.userCaches[owner]) {
        const scopedInterface = self.cacheManager.createUserInterface(owner)
        self.userCaches[owner] = new UserCache(scopedInterface, owner)
      }
      
      // Pass UserCache in env
      env.userCache = self.userCaches[owner]
      self.users[owner] = new USER_DS(owner, env)
      return self.users[owner]
    }
  }
  
  // Build a USER_DS for `owner` from explicit, ALREADY-RESOLVED params (system markers resolved
  // to concrete params, unification flags applied) WITHOUT caching it in self.users. Used by the
  // DB-migration worker to open the source and target databases side by side for the SAME user.
  // Callers must pass { noCache: true, bypassMigrationLock: true } to its getorInitDb calls, and
  // should clearTimeout(ds.dbPersistenceManager.timer) when finished with it.
  self.createTransientUserDS = function (owner, env) {
    if (!owner || !env || !env.fsParams || !env.dbParams) {
      throw new Error('createTransientUserDS needs an owner and fs + db params')
    }
    return new USER_DS(owner, env)
  }

  self.getDB = function (OAC) {
    if (self.users && self.users[OAC.owner] && self.users[OAC.owner].appcoll) {
      return self.users[OAC.owner].appcoll[appTableName(OAC)]
    } else {
      console.warn('🔴 ds_manager getDB', 'could not find user DB', OAC.owner)
      return null
    }
  }

  self.getUserPerms = async function (owner, options) {
    try {
      const ownerDS = await self.getOrSetUserDS(owner, options)
      const permOAC = {
        app_name: 'info.freezr.account',
        collection_name: 'permissions',
        owner
      }
      return await ownerDS.getorInitDb(permOAC, {})
    } catch (err) {
      console.warn('🔴 getUserPerms', 'err for ' + owner, err.message)
      throw err
    }
  }
  
  self.initOacDB = async function (OAC, options = {}) {
    const ownerDS = self.users[OAC.owner]
    if (!ownerDS) throw new Error('Cannot intiiate user db without a user object. (Initiate user first.)')
    return await ownerDS.initOacDB(OAC, options)
  }

  // Migration lock is enforced inside USER_DS.getorInitDb / getorInitAppFS (the single
  // chokepoint for all data access, incl. direct userDS.* callers). See userDsMgr.mjs.
  
  self.getorInitDb = async function (OAC, options) {
    if (!OAC || !OAC.owner) {
      throw new Error('cannot get db without AOC')
    } else {
      try {
        const userDS = await self.getOrSetUserDS(OAC.owner, options)
        return await userDS.getorInitDb(OAC, options)
      } catch (err) {
        if (err.code !== 'MIGRATION_LOCK') console.warn('🔴 getorInitDb err for ' + OAC.owner, err)
        throw err
      }
    }
  }
  
  self.getorInitDbs = async function (OAC, options) {
    if (!OAC || !OAC.owner || (!OAC.app_table && !OAC.app_tables)) {
      throw new Error('cannot get db without a properly formed AOC')
    } else {
      try {
        const userDS = await self.getOrSetUserDS(OAC.owner, options)

        if (OAC.app_tables && Array.isArray((OAC.app_tables))) {
          const list = []
          for (const tableName of OAC.app_tables) {
            const db = await userDS.getorInitDb({ owner: OAC.owner, app_table: tableName }, options)
            if (db) list.push(db)
          }
          return list
        } else {
          return await userDS.getorInitDb(OAC, options)
        }
      } catch (err) {
        if (err.code !== 'MIGRATION_LOCK') console.warn('🔴 getorInitDb err for ' + OAC.owner, err.message)
        throw err
      }
    }
  }

  self.initAdminDBs = async function (env, freezrPrefs) {
    const adminOACs = FREEZR_ADMIN_DBs.map(coll => {
      return {
        owner: 'fradmin',
        app_name: 'info.freezr.admin',
        collection_name: coll
      }
    })

    if (!env?.dbParams || !freezrPrefs) console.warn('initAdminDBs', { adminOACs, env, freezrPrefs })
    // onsole.warn('initAdminDBs', { db: env.dbParams?.type, fs: env.fsParams?.type })
    if (!env?.dbParams || !freezrPrefs) throw new Error('cannot init admin dbs without an env or admin db')
    
    self.setSystemUserDS('public', env)
    self.setSystemUserDS('fradmin', env)
    
    for (const oac of adminOACs) {
      try {
        await self.getOrSetUserDS(oac.owner, { freezrPrefs })
        await self.initOacDB(oac, { addCache: true })
      } catch (err) {
        console.warn('🔴 initAdminDBs', 'err for ' + oac.owner, { err })
        throw err
      }
    }
  }

  self.initUserAppFSToGetCredentials = async function (user, appName, options = {}) {
    const ownerDS = self.users[user]
    if (!ownerDS) throw new Error('Cannot intitiate user fs without a user object. (Initiate user first.) ' + user)

    const appFS = await ownerDS.initAppFS(appName, options)
    if (!appFS || !appFS.fs || !appFS.fs.credentials) {
      throw new Error('could not get app fs credentials  in initalising')
    } else {
      return appFS.fs.credentials
    }
  }
  
  self.getOrInitUserAppFS = async function (user, appName, options = {}) {
    const ownerDS = self.users[user]
    if (!ownerDS) {
      throw new Error('Cannot intitiate user fs without a user object. (Initiate user first.) ' + user)
    }
    return await ownerDS.getorInitAppFS(appName, options)
  }

  self.getUserSlParams = async function (owner, options) {
    try {
      const ownerDS = await self.getOrSetUserDS(owner, options)
      return ownerDS.slParams
    } catch (err) {
      console.warn('🔴 getUserSlParams', 'err for ' + owner, { err })
      throw err
    }
  }

  // Return the cached USER_DS if already loaded, else null (no DB read). Used by the
  // migration lock guard's fast-path.
  self.getLoadedUserDS = function (owner) {
    return self.users[owner] || null
  }

  /**
   * Quiesce a user and force all live state down to their (current) source FS, then drop
   * the cached USER_DS so the next access rebuilds from the (updated) user record.
   * Used by the FS migration at lock-time (clean source for the copy) and at cutover
   * (so reads after the switch hit the new FS, not a stale cache). Best-effort: it never
   * throws — it returns a result object including any persist errors for the caller to
   * decide on (a persist failure before copy should abort the migration).
   *
   * Steps: (1) persist every nedb table to the source FS, (2) stop the persistence timer,
   * (3) clear the in-memory user cache, (4) wipe the registry-tracked local-disk file copy,
   * (5) drop self.users[owner] + self.userCaches[owner].
   * @param {string} owner
   * @returns {Promise<{persisted:number, persistErrors:Array, cacheCleared:number, localWiped:object|null, evicted:boolean}>}
   */
  self.flushAndEvictUserDS = async function (owner) {
    const result = { persisted: 0, persistErrors: [], cacheCleared: 0, localWiped: null, evicted: false }
    const userDS = self.users[owner]

    if (userDS) {
      // 1. Persist every nedb table to the source FS (no-op for mongo tables).
      for (const key of Object.keys(userDS.appcoll || {})) {
        const ds = userDS.appcoll[key]
        if (ds && ds.db && typeof ds.db.persistCachedDatabase === 'function') {
          try {
            await new Promise((resolve, reject) => {
              ds.db.persistCachedDatabase(err => err ? reject(err) : resolve())
            })
            result.persisted++
          } catch (err) {
            console.warn('🔴 flushAndEvictUserDS', 'persist err for ' + owner + ' / ' + key, err.message)
            result.persistErrors.push({ table: key, message: err.message })
          }
        }
      }
      // 2. Stop the background persistence timer so nothing writes after eviction.
      try { if (userDS.dbPersistenceManager?.timer) clearTimeout(userDS.dbPersistenceManager.timer) } catch (e) {}
    }

    // 3. Clear in-memory caches for this user.
    try { result.cacheCleared = self.cacheManager.clearUser(owner) } catch (e) {
      console.warn('🔴 flushAndEvictUserDS', 'clearUser err for ' + owner, e.message)
    }
    // 4. Wipe the registry-tracked local-disk file copies (best-effort).
    try { result.localWiped = await self.cacheManager.wipeLocalFileCacheForUser(owner, ROOT_DIR) } catch (e) {
      console.warn('🔴 flushAndEvictUserDS', 'wipeLocalFileCacheForUser err for ' + owner, e.message)
    }
    // 5. Drop the cached USER_DS + UserCache.
    delete self.users[owner]
    delete self.userCaches[owner]
    result.evicted = true
    return result
  }
}

export default DATA_STORE_MANAGER
