// freezr.info - Modern Data Store Manager (WITH USERCACHE)
// 
// Updated to pass UserCache instances to USER_DS instead of full CacheManager

import USER_DS, { appTableName } from './userDsMgr.mjs'
import { SYSTEM_USER_IDS, FREEZR_ADMIN_DBs } from '../../common/helpers/config.mjs'
import CacheManager from './cache/cacheManager.mjs'
import UserCache from './cache/userCache.mjs'

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

        const dbParams = rawDbParams
          ? (rawDbParams?.type === 'system'
              ? self.systemEnvironment.dbParams
              : rawDbParams)
          : null
        const fsParams = rawFsParams
          ? (rawFsParams?.type === 'system'
              ? self.systemEnvironment.fsParams
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
          
          if (ownerEntries[0].limits && ownerEntries[0].limits.storage) {
            self.users[owner].setTimerToRecalcStorage()
          }
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
  
  self.getorInitDb = async function (OAC, options) {
    if (!OAC || !OAC.owner) {
      throw new Error('cannot get db without AOC')
    } else {
      try {
        const userDS = await self.getOrSetUserDS(OAC.owner, options)
        return await userDS.getorInitDb(OAC, options)
      } catch (err) {
        console.warn('🔴 getorInitDb err for ' + OAC.owner, err)
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
        console.warn('🔴 getorInitDb err for ' + OAC.owner, err.message)
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
}

export default DATA_STORE_MANAGER
