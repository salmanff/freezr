// freezr.info - User Data Store Manager (userDsMgr.mjs)
// 
// This module contains the USER_DS class and all its methods

import config from '../../common/helpers/config.mjs'
import { removeLastPathElement } from '../../common/helpers/utils.mjs'
import { sendFile, sendStream, pipeStream } from '../http/responses.mjs'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { decryptParams } from '../../features/register/services/registerServices.mjs'


const pathSep = path.sep
// ES6 equivalent of __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const ROOT_DIR = removeLastPathElement(__dirname, 2) + pathSep
const DB_CONNECTORS_DIR = './dbConnectors/'
const FS_ENV_FILE_DIR = path.normalize(ROOT_DIR + 'node_modules' + pathSep + 'nedb-asyncfs' + pathSep + 'env' + pathSep)

// Create a require function for dynamic imports
const require = createRequire(import.meta.url)

// Used for persisting old nedb file 
const DB_PERSISTANCE_IDLE_TIME_THRESHOLD = 60 * 1000 // (= 1 minute)
const DB_CHANGE_COUNT_THRESHOLD = 50

function USER_DS (owner, env) {
  const self = this
  
  if (!env.fsParams || !env.dbParams || !owner) {
    throw new Error('Cannot initiate user data store without specifying user and ds parameters')
  }
  
  this.fsParams = decryptParams(env.fsParams)
  this.dbParams = decryptParams(env.dbParams)
  this.slParams = decryptParams(env.slParams)
  this.lmParams = decryptParams(env.lmParams)
  this.userPrefs = env.userPrefs || {
    blockMsgsToNonContacts: false,
    blockMsgsFromNonContacts: false
  }
  this.useage = {
    storageLimit: env.limits?.storage,
    calcTimer: null,
    dbWritesSinceLastCalc: 0,
    lastStorageCalcs: {},
    errorInCalculating: null
  }

  this.owner = owner
  this.appcoll = {}
  this.dbPersistenceManager = {
    timer: setTimeout(function () { persistOldFilesNow(self) }, DB_PERSISTANCE_IDLE_TIME_THRESHOLD),
    lastSave: new Date().getTime(),
    writing: false
  }
  this.appfiles = {}
  
  // USE USER CACHE from env (created at dsManager level)
  // UserCache is now passed directly, not CacheManager
  if (env.userCache) {
    this.userCache = env.userCache
  }
}

  
  USER_DS.prototype.getorInitDb = async function (OACorTableId, options = {}) {
    const OAC = typeof OACorTableId === 'string' 
      ? { owner: this.owner, app_table: OACorTableId } 
      : OACorTableId
      
    if (this.owner !== OAC.owner) throw new Error('getorInitDb SNBH - user trying to get another users info' + this.owner + ' vs ' + OAC.owner)
  
    if (this.appcoll[appTableName(OAC)] && this.appcoll[appTableName(OAC)].query) {
      if (this.appcoll[appTableName(OAC)].query && typeof this.appcoll[appTableName(OAC)].query !== 'function') {
        console.warn('🔴 SNBH - got a db with no query for ' + appTableName(OAC), typeof this.appcoll[appTableName(OAC)].db.query)
      }
      // onsole.log('ds_manager returning app coll from mem for ', appTableName(OAC))
      return this.appcoll[appTableName(OAC)]
    } else {
      // onsole.log('getorInitDb need to re-init db ', appTableName(OAC))
      return await this.initOacDB(OAC, options)
    }
  }
  
  USER_DS.prototype.initOacDB = async function (OAC, options = {}) {
    // Ensure options is never null (handles explicit null passed as argument)
    if (!options) options = {}
    
    if (this.owner !== OAC.owner) throw new Error('Cannot initiate an oacDB for another user ' + this.owner + ' vs ' + OAC.owner)
    if (!this.dbParams) throw new Error('Cannot initiate db or fs without fs and db params for user ' + this.owner)
  
    const userDs = this
    const dbParams = this.dbParams
    const fsParams = this.fsParams
    
    if (!this.dbParams.type) {
      console.warn('serious error on set up - no db or fs params', { OAC })
      throw new Error('Cannot initiate db or fs without db param details (type) for user ' + this.owner)
    }
    if (!appTableName(OAC)) throw new Error('Cannot initiate db or fs without proper OAC ' + JSON.stringify(OAC))
  
    let extraCreds = null
  
    if (!this.appcoll[appTableName(OAC)]) {
      this.appcoll[appTableName(OAC)] = {
        oac: { ...OAC },
        dbParams,
        fsParams,
        dbLastAccessed: null,
        dbOldestWrite: null,
        dbChgCount: 0
      }
    }
  
    const ds = this.appcoll[appTableName(OAC)]
  
    // CREATE APPTABLE CACHE using UserCache
    if (this.userCache) {
      // Get cache preferences from UserCache (scoped to this owner)
      const cachePrefs = this.userCache.getCachePrefsForTable(appTableName(OAC))
      
      // Options override prefs if specified
      const cacheConfig = {
        cacheAll: options.cacheAll !== undefined ? options.cacheAll : cachePrefs.cacheAll,
        cacheRecent: options.cacheRecent !== undefined ? options.cacheRecent : cachePrefs.cacheRecent,
        cachePatterns: options.cachePatterns !== undefined ? options.cachePatterns : cachePrefs.cachePatterns
      }
      
      ds.cache = this.userCache.getOrCreateAppTableCache(
        appTableName(OAC),
        cacheConfig
      )

      // Set up refresh function for cache
      ds.cache.setRefreshFunction(async (dirtyFlags) => {
        try {
          // Ensure ds.db exists before using it
          if (!ds.db || !ds.db.query_async) {
            console.warn('🔴 Cache refresh function called before ds.db is initialized')
            return
          }
          
          if (dirtyFlags.All && ds.cache.cacheAll) {
            // Refresh All cache - fetch ALL records in batches
            // onsole.log('🔄 setRefreshFunction - Refreshing All cache for', ds.cache.namespace)
            
            const allRecords = []
            let skip = 0
            const batchSize = 500
            let hasMore = true
            
            while (hasMore) {
              const batch = await ds.db.query_async({}, { skip, limit: batchSize })
              // onsole.log('🔄 Refreshing All cache for', ds.cache.namespace) // , 'batch', { len: batch?.length, skip, limit: batchSize })
              
              if (batch && batch.length > 0) {
                allRecords.push(...batch)
                skip += batch.length
                
                // If we got less than batchSize, we've reached the end
                if (batch.length < batchSize) {
                  hasMore = false
                }
              } else {
                hasMore = false
              }
            }
            
            // onsole.log(`✅ Fetched ${allRecords.length} records for All cache`)
            await ds.cache.setAll(allRecords)
          }
          
          if (dirtyFlags.Recent && ds.cache.cacheRecent) {
            // Refresh Recent cache
            const recentRecords = await ds.db.query_async({}, {
              sort: { _date_modified: -1 },
              limit: ds.cache.config.recentCount
            })
            
            // onsole.log(`✅ Refreshed Recent cache with ${recentRecords.length} records`)
            await ds.cache.setRecent(recentRecords)
          }
        } catch (err) {
          console.warn('🔴 Error in cache refresh function:', err.message)
        }
      })
    } else {
      console.warn('initOacDB - getCachePrefsForTable no userCache found', { owner: this.owner, appTable: appTableName(OAC) } )
    }
  
    try {
      // Dynamic import for ES6 modules
      const dbModule = await import(DB_CONNECTORS_DIR + 'dbApi_' + dbParams.type + '.mjs')
      const DB_CREATOR = dbModule.default
      ds.db = new DB_CREATOR({ dbParams, fsParams, extraCreds }, OAC)
    } catch (e) {
      console.warn('initoacdb creator error', { dbParams, e })
      throw e
    }
  
    // 1. Auto-promisify ds.db functions if async versions don't exist (BEFORE using them)
    const dbFunctions = ['initDB', 'read_by_id', 'create', 'query', 'update', 'delete_record', 'count', 'all', 'getAppTableNames', 'getAllAppTableNames', 'stats', 'replace_record_by_id', 'update_multi_records']
    
    dbFunctions.forEach(funcName => {
      const asyncFuncName = `${funcName}_async`
      if (!ds.db[asyncFuncName] && ds.db[funcName]) {
        // Create async version by promisifying the callback version
        ds.db[asyncFuncName] = function(...args) {
          return new Promise((resolve, reject) => {
            ds.db[funcName](...args, (err, result) => {
              if (err) reject(err)
              else resolve(result)
            })
          })
        }
      }
    })
  
    try {
      await ds.db.initDB_async()
    } catch (err) {
      if (dbParams.type === 'nedb' && err.code === 'ENOENT') {
        // should be okay hopefully as db has not been einited yet
      } else {
        console.warn('🔴 initDB Err ', ds.owner, { msg: err.message, code: err.code, name: err.name, statusCode: err.statusCode })
        throw err
      }
    }
    
    // Initialize cache immediately if cacheAll or cacheRecent is enabled
    // This must happen AFTER ds.db is initialized
    if (this.userCache && ds.cache) {
      const cachePrefs = this.userCache.getCachePrefsForTable(appTableName(OAC))
      const cacheConfig = {
        cacheAll: options.cacheAll !== undefined ? options.cacheAll : cachePrefs.cacheAll,
        cacheRecent: options.cacheRecent !== undefined ? options.cacheRecent : cachePrefs.cacheRecent
      }
      
      if (cacheConfig.cacheAll || cacheConfig.cacheRecent) {
        try {
          // onsole.log('🔄 Initializing cache on initOacDB (after db init)', { cacheAll: cacheConfig.cacheAll, cacheRecent: cacheConfig.cacheRecent })
          await ds.cache.initializeCache()
        } catch (err) {
          console.warn('🔴 Error initializing cache on initOacDB:', err.message)
          // Don't throw - allow DB to continue initializing
        }
      }
    }
    
    // READ BY ID
    ds.read_by_id = async function (id) {
      ds.dbLastAccessed = new Date().getTime()

      // onsole.log('🔄 cache - read_by_id - TRY CACHE', { id, appTableName  })
      const cached = await ds.cache.query({ _id: id })
      if (cached !== null) {
        // Cache hit - return cached results
        // onsole.log('📦 Cache hit for query for id ', id)
        return cached[0]
      } else {
        // onsole.log('📦 Cache miss for query for id ', id )
      }
      return await ds.db.read_by_id_async(id)
     }
     
    // CREATE - with cache integration
    ds.create = async function (id, entity, options = {}) {
      if (options === null || options === undefined) options = {}
      
      userDs.setTimerToRecalcStorage()
      if (!userDs.getUseageWarning().ok) {
        const error = new Error('storageLimitExceeded')
        error.useage = userDs.getUseageWarning()
        throw error
      } else if (!entity || typeof entity !== 'object' || Array.isArray(entity)) {
        console.warn('🔴 Cannot create an invalid entity type', { entity, options })
        throw new Error(('Cannot create an invalid entity type' + (typeof entity)))
      } else if (!ds.db || !ds.db.create) {
        throw new Error('Missing function "ds.db.create"')
      }
      
      ds.dbChgCount++
      ds.dbOldestWrite = ds.dbOldestWrite || new Date().getTime()
      ds.dbLastAccessed = new Date().getTime()
      resetPersistenceTimer(userDs, (ds.dbChgCount > DB_CHANGE_COUNT_THRESHOLD ? ds : null))
  
      if (!options.restoreRecord) {
        if (!options.keepReservedFields) config.RESERVED_FIELD_LIST.forEach((aReservedField) => delete entity[aReservedField])
        entity._date_created = new Date().getTime()
        entity._date_modified = new Date().getTime()
      } else {
        if (!entity._date_created) entity._date_created = new Date().getTime()
        if (!entity._date_modified) entity._date_modified = new Date().getTime()
      }
      
      const results = await ds.db.create_async(id, entity, options)
      // onsole.log('create result from userDs', { results, id: results._id })
      userDs.useage.dbWritesSinceLastCalc++
      
      // UPDATE CACHE after successful create
      if (ds.cache && results._id) {
        // onsole.log('🔄 cache - create - UPDATE CACHE after write of ', { id: results._id })
        const cachedEntity = { ...entity, _id: results._id }
        ds.cache.setByKey('_id', results._id, cachedEntity)
        ds.cache.markDirty(results._id)
      }
      
      return {
        _id: results._id,
        _date_modified: entity._date_modified,
        _date_created: entity._date_created,
        useage: userDs.getUseageWarning()
      }
    }
    
    // QUERY - with cache integration
    ds.query = async function (query, options = {}) {
      if (!options) options = {}
      // Try cache first
      // onsole.log('🔄 cache - query - TRY CACHE', { query, options, appTableName: appTableName(OAC)  })
      if (ds.cache) { 
        const cached = await ds.cache.query(query, options)
        if (cached !== null) {
          // Cache hit - return cached results
          // onsole.log('📦 Cache hit for query', { table: appTableName(OAC), query, len: cached?.length })
          return cached
        } else {
          // onsole.log('📦 Cache miss for query', { table: appTableName(OAC), query } )
        }
      }
      
      // Cache miss - hit DB
      ds.dbLastAccessed = new Date().getTime()
      const results = await ds.db.query_async(query, options)
      // onsole.log(' query result from userDs', { results, query, options })
      
      // Store in cache
      if (ds.cache && results) {
        await ds.cache.setQuery(query, results, options)
        // onsole.log('📦 Cache set for query', {query, results } )
      }
      
      return results
    }
    
    // UPDATE - with cache integration
    ds.update = async function (idOrQuery, updatesToEntity, options = {}) {
      ds.dbChgCount++
      ds.dbOldestWrite = ds.dbOldestWrite || new Date().getTime()
      ds.dbLastAccessed = new Date().getTime()
      resetPersistenceTimer(userDs, (ds.dbChgCount > DB_CHANGE_COUNT_THRESHOLD ? ds : null))
  
      userDs.setTimerToRecalcStorage()
      if (!userDs.getUseageWarning().ok) {
        const error = new Error('storageLimitExceeded')
        error.useage = userDs.getUseageWarning()
        throw error
      } else if (options.replaceAllFields) {
        userDs.useage.dbWritesSinceLastCalc++
        if (options.old_entity) {
          const entityId = (typeof idOrQuery === 'string') ? idOrQuery : options.old_entity._id
          if (!options.restoreRecord) {
            config.RESERVED_FIELD_LIST.forEach(key => {
              if (options.old_entity[key]) updatesToEntity[key] = options.old_entity[key]
            })
            updatesToEntity._date_modified = new Date().getTime()
          }
          delete updatesToEntity._id
          
          const result = await ds.db.replace_record_by_id_async(entityId, updatesToEntity)
          let nModified = (result && result.result && result.result.nModified) ? result.result.nModified : (result?.nModified || null)
          if (!nModified && typeof (result) === 'number') nModified = result
          
          // INVALIDATE CACHE
          // onsole.log('🔄 cache update - INVALIDATE CACHE', { entityId, appTableName: appTableName(OAC)  })
          if (ds.cache) {
            ds.cache.markDirty(entityId)
          }
          
          return {
            nModified,
            _id: options.old_entity._id,
            _date_created: options.old_entity._date_created,
            _date_modified: updatesToEntity._date_modified,
            useage: userDs.getUseageWarning()
          }
        } else if (!options.restoreRecord) {
          if (typeof idOrQuery === 'string') idOrQuery = { _id: idOrQuery }
          const entities = await ds.db.query_async(idOrQuery, {})
          if (!entities || entities.length === 0) {
            if (typeof idOrQuery === 'string') {
              throw new Error('no records found to update')
            } else {
              return { nModified: 0 }
            }
          } else if (entities.length > 1) {
            throw new Error('expected to replace one and got many records')
          } else {
            const oldEntity = entities[0]
            const entityId = oldEntity._id
            Object.keys(oldEntity).forEach(function (key) {
              if (updatesToEntity[key] === undefined) updatesToEntity[key] = oldEntity[key]
            })
            if (!options.restoreRecord) {
              config.RESERVED_FIELD_LIST.forEach(key => {
                if (oldEntity[key] !== undefined) updatesToEntity[key] = oldEntity[key]
              })
            }
            delete updatesToEntity._id
            updatesToEntity._date_modified = new Date().getTime()
  
            const result = await ds.db.replace_record_by_id_async(entityId, updatesToEntity)
            let nModified = (result && result.result && result.result.nModified) ? result.result.nModified : (result?.nModified || null)
            if (!nModified && typeof (result) === 'number') nModified = result
          
            // INVALIDATE CACHE
            if (ds.cache) {
              ds.cache.markDirty(entityId)
            }
            
            const returns = {
              nModified,
              _id: entityId,
              _date_created: oldEntity._date_created,
              _date_modified: updatesToEntity._date_modified,
              useage: userDs.getUseageWarning()
            }
  
            if (entities.length > 1) {
              returns.more = true
              returns.flags = 'More than one object retrieved - first object changed'
              console.warn('🔴 More than One object retrieved when updating with replaceAllFields ')
            }
            return returns
          }
        } else {
          throw new Error('restore record should always replace all fields')
        }
      } else { // if (!options.replaceAllFields)
        if (!options.newSystemParams) config.RESERVED_FIELD_LIST.forEach(key => delete updatesToEntity[key])
        updatesToEntity._date_modified = new Date().getTime()
        
        const ret = await ds.db.update_multi_records_async(idOrQuery, updatesToEntity)
        if (!ret && typeof idOrQuery === 'string' && ret?.nModified === 0) {
          throw new Error('no record found to update')
        } else {
          if (!ret) ret = {}
          ret.useage = userDs.getUseageWarning()
          
          // INVALIDATE CACHE
          if (ds.cache) {
            if (typeof idOrQuery === 'string') {
              ds.cache.markDirty(idOrQuery)
            } else if (idOrQuery._id) {
              ds.cache.markDirty(idOrQuery._id)
            } else {
              ds.cache.markDirty()  // Invalidate all for multi-record updates
            }
          }

          ret._date_modified = updatesToEntity._date_modified
          
          return ret
        }
      }
    }
    
    // REPLACE_RECORD_BY_ID - with cache integration
    ds.replace_record_by_id = async function (entityId, updatedEntity, options = {}) {
      ds.dbChgCount++
      ds.dbLastAccessed = new Date().getTime()
      resetPersistenceTimer(userDs, (ds.dbChgCount > DB_CHANGE_COUNT_THRESHOLD ? ds : null))
  
      userDs.setTimerToRecalcStorage()
      if (!userDs.getUseageWarning().ok) {
        const error = new Error('storageLimitExceeded')
        error.useage = userDs.getUseageWarning()
        throw error
      }
      
      userDs.useage.dbWritesSinceLastCalc++
      let num = await ds.db.replace_record_by_id_async(entityId, updatedEntity)
      if (typeof num !== 'number' && typeof num === 'object') {
        console.warn('todo - review this code - num is old version? Should be updated to result?')
        num = num?.result?.nModified || num?.result?.result?.nModified || null
      }
      if (num === 0) {
        throw new Error('no record found to replace')
      }
      
      // INVALIDATE CACHE
      if (ds.cache) {
        ds.cache.markDirty(entityId)
      }
      
      return {
        nModified: num,
        _id: entityId,
        _date_created: updatedEntity._date_created,
        _date_modified: updatedEntity._date_modified,
        useage: userDs.getUseageWarning()
      }
    }
    
    // UPSERT - with cache integration
    ds.upsert = async function (idOrQuery, entity) {
      let existingEntity
      if (typeof idOrQuery === 'string') {
        existingEntity = await ds.db.read_by_id_async(idOrQuery)
      } else {
        existingEntity = await ds.db.query_async(idOrQuery, {})
      }
      
      if (!existingEntity || (Array.isArray(existingEntity) && existingEntity.length === 0)) {
        const id = (typeof idOrQuery === 'string')
          ? idOrQuery
          : ((idOrQuery && idOrQuery._id) ? (idOrQuery._id + '') : null)
        const result = await ds.create(id, entity, {})
        return result
      } else if (!existingEntity || (Array.isArray(existingEntity) && existingEntity.length > 1)) {
        throw new Error('Cannot upsert more than one record')
      } else {
        if (Array.isArray(existingEntity)) {
          existingEntity = existingEntity[0]
        }
        delete entity._id
        idOrQuery = existingEntity._id.toString()
        return await ds.update(idOrQuery, entity, { replaceAllFields: true, old_entity: existingEntity })
      }
    }
    
    // DELETE_RECORD - with cache integration
    ds.delete_record = async function (idOrQuery, options = {}) {
      if (typeof idOrQuery !== 'string') throw new Error('Use delete_records to delete multiple records or pass a record id string as the argument for delete_record')
      idOrQuery = { _id: idOrQuery }
      ds.dbChgCount++
      ds.dbOldestWrite = ds.dbOldestWrite || new Date().getTime()
      ds.dbLastAccessed = new Date().getTime()
      resetPersistenceTimer(userDs, (ds.dbChgCount > DB_CHANGE_COUNT_THRESHOLD ? ds : null))
      const ret = await ds.delete_records(idOrQuery, { multi: false })
      // console.log('      🔑 usrDsMgr  delete_record ret', { ret })
      if (ret && ret.nRemoved === 0) {
        throw new Error('Record not found to delete')
      }
      
      // INVALIDATE CACHE
      if (ds.cache && idOrQuery._id) {
        ds.cache.markDirty(idOrQuery._id)
      }
      
      return ret
    }
    
    // DELETE_RECORDS - with cache integration
    ds.delete_records = async function (idOrQuery, options = {}) {
      options = options || {}
      ds.dbChgCount++
      ds.dbOldestWrite = ds.dbOldestWrite || new Date().getTime()
      ds.dbLastAccessed = new Date().getTime()
      resetPersistenceTimer(userDs, (ds.dbChgCount > DB_CHANGE_COUNT_THRESHOLD ? ds : null))
  
      const multi = options.multi === undefined ? true : options.multi
      if (typeof idOrQuery === 'string') idOrQuery = { _id: idOrQuery }
      
      const result = await ds.db.delete_record_async(idOrQuery, { multi })
      // console.log('      🔑 usrDsMgr  delete_records result', { result })
      // INVALIDATE CACHE
      if (ds.cache) {
        ds.cache.markDirty()  // Invalidate all for deletes
      }
      
      return result
    }
    
    ds.getAllAppTableNames = async function (appName) {
      return await ds.db.getAllAppTableNames_async(appName)
    }
    
    ds.getTableStats = async function () {
      return await ds.db.stats_async()
    }

    return ds
  }
  
  USER_DS.prototype.getDB = function (OAC) {
    if (this.owner !== OAC.owner) throw new Error('getdb SNBH - user trying to get another users info' + this.owner + ' vs ' + OAC.owner)
    if (!appTableName(OAC)) throw new Error('getdb SNBH - Not properly formed OAC' + JSON.stringify(OAC))
    if (!this.appcoll[appTableName(OAC)]) throw new Error('initate user and db before getting')
    return this.appcoll[appTableName(OAC)]
  }
  
  USER_DS.prototype.getorInitAppFS = async function (appName, options = {}) {
    if (this.appfiles[appName]) {
      return this.appfiles[appName]
    } else {
      return await this.initAppFS(appName, options)
    }
  }
  
  USER_DS.prototype.initAppFS = async function (appName, options = {}) {
    if (!options) options = {}
  
    if (!appName) {
      throw new Error('no app name for ' + this.owner, { options })
    } else if (!this.fsParams) {
      throw new Error('Cannot initiate db or fs without fs and db params for user ' + this.owner)
    } else {
      const userDs = this
      const owner = this.owner
      const isSystemApp = config.isSystemApp(appName)
      const fsParams = this.fsParams
      const userRootFolder = this.fsParams.rootFolder || config.FREEZR_USER_FILES_DIR
  
      if (!this.appfiles[appName]) {
        this.appfiles[appName] = {
          owner,
          appName,
          fsParams
        }
      }
      
      const ds = this.appfiles[appName]
  
      // Reuse cache from app_table (or create new one)
      if (this.userCache && !ds.cache) {
        ds.cache = this.userCache.getOrCreateAppTableCache(appName, {})
      }
  
      try {
        if (fsParams.type === 'local') {
          const { default: LocalFS } = await import('./fsConnectors/dbfs_local.mjs')
          ds.fs = LocalFS
        } else if (['azure', 'aws', 'dropbox', 'googleDrive', 'fdsFairOs'].includes(fsParams.type)) {
          const { cloudFS } = await import('./fsConnectors/dbfs_' + fsParams.type + '.mjs')
          ds.fs = new cloudFS(fsParams, { doNotPersistOnLoad: true })
        } else {
          const CustomFS = require(path.join(FS_ENV_FILE_DIR, 'dbfs_' + fsParams.type + '.js'))
          ds.fs = new CustomFS(fsParams, { doNotPersistOnLoad: true })
        }
      } catch (e) {
        console.warn('🔴 ds.initAppFS', 'ds.fs failed for ' + owner + ' using fs ' + fsParams.name, { error: e })
        throw new Error('Could not initiate dbfs file for fs type ' + fsParams.type)
      }
  
      // Auto-promisify ds.fs functions if async versions don't exist
      const fsFunctions = ['initFS', 'readFile', 'writeFile', 'unlink', 'removeFolder', 'mkdirp', 'size', 'getFileToSend', 'readdir', 'stat']
      
      fsFunctions.forEach(funcName => {
        const asyncFuncName = `${funcName}_async`
        if (!ds.fs[asyncFuncName] && ds.fs[funcName]) {
          ds.fs[asyncFuncName] = function(...args) {
            return new Promise((resolve, reject) => {
              ds.fs[funcName](...args, (err, result) => {
                if (err) reject(err)
                else resolve(result)
              })
            })
          }
        }
      })
  
      ds.pathToFile = function (endpath) {
        const pathToRead = (isSystemApp ? 'freezrsystmapps' : (userRootFolder + '/' + this.owner + '/apps')) +
          '/' + this.appName + '/' + endpath
        return pathToRead
      }
  
      // READ APP FILE - with cache
      ds.readAppFile = async function (endpath, options = {}) {
        // Check cache first (if not a system app)
        if (!isSystemApp && ds.cache && isCacheableFile(endpath)) { // sftodo - also cache systemApp files?
          const cached = ds.cache.getAppFile(endpath)
          if (cached !== null) {
            // onsole.log('📦 Cache hit for readAppFile', endpath)
            return cached
          }
        }
        
        // System app: read from local systemapps folder
        if (isSystemApp) {
          const localpath = path.normalize(ROOT_DIR + 'freezrsystmapps/' + ds.appName + '/' + endpath)
          const content = await fs.promises.readFile(localpath, options)
          return options?.doNotToString ? content : content.toString()
        }
        
        // User app: try local filesystem first, then remote fs
        const pathToRead = userRootFolder + '/' + ds.owner + '/apps/' + ds.appName + '/' + endpath
        const localpath = path.normalize(ROOT_DIR + pathToRead)
        
        if (fs.existsSync(localpath)) {
          const content = await fs.promises.readFile(localpath, options)
          const processedContent = options?.doNotToString ? content : content.toString()
          
          // Cache the file (if not too large and not a system app)
          if (!isSystemApp && ds.cache && isCacheableFile(endpath)) { // sftodo - also cache systemApp files?
            ds.cache.setAppFile(endpath, processedContent)
            // onsole.log('📦 Cache set for readAppFile', endpath)
          }
          
          return processedContent
        } else {
          const content = await new Promise((resolve, reject) => {
            ds.fs.readFile(pathToRead, options, function (err, content) {
              if (err) reject(err)
              else resolve(content)
            })
          })
          const processedContent = options?.doNotToString ? content : content.toString()
          
          // Cache the file (if not too large and not a system app)
          if (!isSystemApp && ds.cache && isCacheableFile(endpath)) {
            ds.cache.setAppFile(endpath, processedContent)
            // onsole.log('📦 Cache set for readAppFile', endpath)
          }
          
          return processedContent
        }
      }


      // Helper to determine if file is cacheable (text-based) -> 
      const isCacheableFile = (filepath) => {
        const ext = filepath.split('.').pop()?.toLowerCase()
        if (process.env.NODE_ENV === 'development') return false
        return ['js', 'css', 'html', 'htm', 'json', 'txt', 'xml', 'svg', 'mjs', 'fsx'].includes(ext)
      }
  
      ds.sendAppFile = function (endpath, res, options) {
        const isSystemApp = config.isSystemApp(this.appName)
        const partialPath = isSystemApp ? ('freezrsystmapps/' + this.appName + '/' + endpath) : (userRootFolder + '/' + this.owner + '/apps/' + appName + '/' + endpath)
        // onsole.log('🔍 sendAppFile - ', { partialPath })        
        // Helper to track local file copy (using userCache, not CacheManager directly)
        const trackLocalFileCopy = (size = 0) => {
          try {
            if (userDs.userCache) {
              userDs.userCache.trackLocalFileCopy(ds.appName, partialPath, 'appFile', size)
            }
          } catch (e) { /* ignore tracking errors */ }
        }
        
        // Helper to check if local copy is stale (for multi-server consistency)
        const isLocalCopyStale = () => {
          if (isSystemApp || !ds.cache || !userDs.userCache) return false
          try {
            const sharedModTime = ds.cache.getAppFileModTime(endpath)
            if (!sharedModTime) return false // No shared mod time = not tracking, use local
            const localCopyTime = userDs.userCache.getLocalFileCopyTime(ds.appName, partialPath)
            if (!localCopyTime) return true // No local copy time but shared exists = stale
            return sharedModTime > localCopyTime // Stale if shared is newer
          } catch (e) { return false }
        }

        if (endpath.slice(-3) === '.js') res.setHeader('content-type', 'application/javascript')
        if (endpath.slice(-4) === '.css') res.setHeader('content-type', 'text/css')

        // Check new cache first (for non-system apps and cacheable files)
        if (!isSystemApp && ds.cache && isCacheableFile(endpath)) {
          const cached = ds.cache.getAppFile(endpath)
          if (cached !== null) {
            // onsole.log('📦 Cache hit for sendAppFile', endpath)
            sendStream(res, Buffer.from(cached))
            return
          }
        }

        const localpath = path.normalize(ROOT_DIR + partialPath)
        const localFileExists = fs.existsSync(localpath)
        const shouldRefetchFromRemote = localFileExists && isLocalCopyStale()

        if (localFileExists && !shouldRefetchFromRemote) {
          // Cache the file content for text-based files
          if (!isSystemApp && ds.cache && isCacheableFile(endpath)) {
            fs.promises.readFile(localpath).then(content => {
              ds.cache.setAppFile(endpath, content.toString())
              // onsole.log('📦 Cache set for sendAppFile', endpath)
            }).catch(() => {}) // Ignore cache errors
          }
          sendFile(res, localpath)
        } else if ((this.fsParams.type === 'local' || isSystemApp) && !localFileExists) {
          // Local fs and file doesn't exist - 404
          console.warn('🔴 sendAppFile', ' - missing file in  local ' + localpath)
          res.status(404).send('file not found!')
        } else {
          // Either: file doesn't exist locally (fetch from remote)
          // Or: file exists but is stale (re-fetch from remote)
          try {
            ds.fs.getFileToSend(partialPath, null, function (err, streamOrFile) {
              if (err) {
                console.warn('sendAppFile', 'err in sendAppfile for ', { partialPath, err })
                res.status(404).send('file not found!')
                res.end()
              } else {
                if (streamOrFile.pipe) { // it is a stream
                  streamOrFile.pipe(res)
                  localCheckExistsOrCreateUserFolderSync(partialPath, true)
                  streamOrFile.pipe(fs.createWriteStream(localpath))
                  trackLocalFileCopy() // Track that we copied this file locally
                } else if (ds.fsParams?.choice === 'aws') { // handle aws v3 non streamable file
                  localCheckExistsOrCreateUserFolderSync(partialPath, true)
                  fs.writeFile(localpath, streamOrFile, null, function (err, name) {
                    if (err) {
                      console.warn('🔴 sendAppFile', ' -  error putting back in cache ' + partialPath)
                      res.status(404).send('error copying file')
                    } else {
                      // Cache the file content for text-based files
                      if (!isSystemApp && ds.cache && isCacheableFile(endpath)) {
                        ds.cache.setAppFile(endpath, streamOrFile.toString())
                        // onsole.log('📦 Cache set for sendAppFile (remote)', endpath)
                      }
                      trackLocalFileCopy(streamOrFile.length) // Track that we copied this file locally
                      sendFile(res, localpath)
                    }
                  })
                } else { // it is a file
                  sendStream(res, streamOrFile)
                  localCheckExistsOrCreateUserFolderSync(partialPath, true)
                  fs.writeFile(localpath, streamOrFile, null, function (err, name) {
                    if (err) {
                      console.warn('🔴 sendAppFile', ' -  error putting back in cache ' + partialPath)
                    } else {
                      // Cache the file content for text-based files
                      if (!isSystemApp && ds.cache && isCacheableFile(endpath)) {
                        ds.cache.setAppFile(endpath, streamOrFile.toString())
                        // onsole.log('📦 Cache set for sendAppFile (remote)', endpath)
                      }
                      trackLocalFileCopy(streamOrFile.length) // Track that we copied this file locally
                    }
                  })
                }
              }
            })
          } catch (err) {
            console.warn('🔴 sendAppFile', 'general err in sendAppfile for ', { msg: err.message })
            res.status(404).send('err getting file')
            res.end()
          }
        }
      }
  
      ds.sendPublicAppFile = function (endpath, res, options) {
        const isSystemApp = config.isSystemApp(this.appName)
        const partialPath = isSystemApp ? ('freezrsystmapps/' + this.appName + '/' + endpath) : (userRootFolder + '/' + this.owner + '/apps/' + appName + '/' + endpath)
        
        // Helper to track local file copy (using userCache, not CacheManager directly)
        const trackLocalFileCopy = (size = 0) => {
          try {
            if (userDs.userCache) {
              userDs.userCache.trackLocalFileCopy(ds.appName, partialPath, 'appFile', size)
            }
          } catch (e) { /* ignore tracking errors */ }
        }
        
        // Helper to check if local copy is stale (for multi-server consistency)
        const isLocalCopyStale = () => {
          if (isSystemApp || !ds.cache || !userDs.userCache) return false
          try {
            const sharedModTime = ds.cache.getAppFileModTime(endpath)
            if (!sharedModTime) return false
            const localCopyTime = userDs.userCache.getLocalFileCopyTime(ds.appName, partialPath)
            if (!localCopyTime) return true
            return sharedModTime > localCopyTime
          } catch (e) { return false }
        }

        if (endpath.slice(-3) === '.js') res.setHeader('content-type', 'application/javascript')
        if (endpath.slice(-4) === '.css') res.setHeader('content-type', 'text/css')

        // Check new cache first (for non-system apps and cacheable files)
        if (!isSystemApp && ds.cache && isCacheableFile(endpath)) {
          const cached = ds.cache.getAppFile(endpath)
          if (cached !== null) {
            // onsole.log('📦 Cache hit for sendPublicAppFile', endpath)
            sendStream(res, Buffer.from(cached))
            return
          }
        }

        const localpath = path.normalize(ROOT_DIR + partialPath)
        const localFileExists = fs.existsSync(localpath)
        const shouldRefetchFromRemote = localFileExists && isLocalCopyStale()
        
        if (localFileExists && !shouldRefetchFromRemote) {
          // Cache the file content for text-based files
          if (!isSystemApp && ds.cache && isCacheableFile(endpath)) {
            fs.promises.readFile(localpath).then(content => {
              ds.cache.setAppFile(endpath, content.toString())
              // onsole.log('📦 Cache set for sendPublicAppFile', endpath)
            }).catch(() => {}) // Ignore cache errors
          }
          sendFile(res, localpath)
        } else if ((this.fsParams.type === 'local' || isSystemApp) && !localFileExists) {
          res.status(404).send('file not found!')
        } else {
          try {
            this.fs.getFileToSend(partialPath, null, function (err, streamOrFile) {
              if (err) {
                res.status(404).send('file not found!')
                res.end()
              } else {
                if (streamOrFile.pipe) { // it is a stream
                  streamOrFile.pipe(res)
                  localCheckExistsOrCreateUserFolderSync(partialPath, true)
                  streamOrFile.pipe(fs.createWriteStream(localpath))
                  trackLocalFileCopy() // Track that we copied this file locally
                } else { // it is a file
                  sendStream(res, streamOrFile)
                  localCheckExistsOrCreateUserFolderSync(partialPath, true)
                  fs.writeFile(localpath, streamOrFile, null, function (err, name) {
                    if (err) {
                      console.warn('🔴 sendPublicAppFile', ' -  error putting back in cache ' + partialPath)
                    } else {
                      // Cache the file content for text-based files
                      if (!isSystemApp && ds.cache && isCacheableFile(endpath)) {
                        ds.cache.setAppFile(endpath, streamOrFile.toString())
                        // onsole.log('📦 Cache set for sendPublicAppFile (remote)', endpath)
                      }
                      trackLocalFileCopy(streamOrFile.length) // Track that we copied this file locally
                    }
                  })
                }
              }
            })
          } catch (e) {
            res.status(404).send('error getting file 23!')
            res.end()
          }
        }
      }
  
      // WRITE TO USER FILES - invalidate cache and update fileModTime
      ds.writeToUserFiles = async function (endpath, content, options = {}) {
        options = options || {}
        const pathToWrite = userRootFolder + '/' + this.owner + '/files/' + this.appName + '/' + endpath

        if (!userDs.getUseageWarning().ok) {
          throw new Error('storageLimitExceeded')
        } else {
          try {
            const name = await this.fs.writeFile_async(pathToWrite, content, options)
            
            if (!options || !options.nocache) {
              try {
                const localPath = ROOT_DIR + pathToWrite
                const localDir = path.dirname(localPath)
                await fs.promises.mkdir(localDir, { recursive: true })
                
                const writeOptions = { ...options }
                if (writeOptions.doNotOverWrite) writeOptions.doNotOverWrite = false
                
                await fs.promises.writeFile(localPath, content, writeOptions)
                
                // INVALIDATE FILE CACHE on write
                if (ds.cache) {
                  ds.cache.deleteUserFile(endpath)
                  // Update fileModTime in shared cache (for multi-server consistency)
                  ds.cache.setUserFileModTime(endpath)
                }
              } catch (err) {
                console.warn('🔴 writeToUserFiles', 'Error duplicating file in local drive for ' + this.owner + ' path: ' + ROOT_DIR + pathToWrite, err.message)
              }
            } else {
              userDs.setTimerToRecalcStorage(true)
            }
            
            return name
          } catch (err) {
            throw err
          }
        }
      }
  
      // READ USER FILE - with cache
      ds.readUserFile = async function (endpath, options = {}) {
        // Check cache first
        if (!options.nocache && ds.cache) {
          const cached = ds.cache.getUserFile(endpath)
          if (cached !== null) {
            // onsole.log('📦 Cache hit for readUserFile', endpath, { cached })
            return cached
          }
        }
        
        options = options || {}
        const pathToRead = userRootFolder + '/' + this.owner + '/files/' + this.appName + '/' + endpath
  
        const localpath = path.normalize(ROOT_DIR + pathToRead)
        if (!options.nocache && fs.existsSync(localpath)) {
          try {
            const content = await fs.promises.readFile(localpath, options)
            const contentStr = content ? content.toString() : null
            
            // Cache the file
            if (ds.cache) {
              ds.cache.setUserFile(endpath, contentStr)
              // onsole.log('📦 Cache set for readUserFile', endpath, { contentStr })
            }
            
            return contentStr
          } catch (err) {
            console.warn(err)
            throw err
          }
        } else {
          try {
            const content = await this.fs.readFile_async(pathToRead, options)
            const contentStr = content ? content.toString() : null
            
            // Cache the file locally
            try {
              let dir = localpath.split('/')
              dir.pop()
              dir = dir.join('/')
              await fs.promises.mkdir(dir, { recursive: true })
              await fs.promises.writeFile(localpath, contentStr, options)
              
              // Cache in memory
              if (ds.cache) {
                ds.cache.setUserFile(endpath, contentStr)
                // onsole.log('📦 Cache set for readUserFile', endpath, { contentStr })
              }
            } catch (err) {
              console.warn('🔴 ds readUserFile', 'Error creating directory or duplicating file in local drive for readUserFile ', { endpath, localpath, msg: err.message })
            }
            
            return contentStr
          } catch (err) {
            throw err
          }
        }
      }
  
      // READ USER DIR - list files in a directory
      ds.readUserDir = async function (endpath, options = {}) {
        options = options || {}
        const pathToRead = userRootFolder + '/' + this.owner + '/files/' + this.appName + (endpath ? ('/' + endpath) : '')
        
        // console.log('readUserDir', { pathToRead })
        try {
          const files = await ds.fs.readdir_async(pathToRead, options || null)
          return files || []
        } catch (err) {
          // If directory doesn't exist, return empty array (like local FS does)
          if (err.code === 'ENOENT' || err.message?.includes('does not exist') || err.message?.includes('no such file')) {
            return []
          }
          throw err
        }

      }
  
      // STAT USER FILE - get file metadata - cursor generated - not tested
      ds.statUserFile = async function (endpath, options = {}) {
        options = options || {}
        const pathToRead = userRootFolder + '/' + this.owner + '/files/' + this.appName + '/' + endpath
        
        const localpath = path.normalize(ROOT_DIR + pathToRead)
        if (fs.existsSync(localpath)) {
          try {
            const stat = await fs.promises.stat(localpath)
            return {
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              type: stat.isDirectory() ? 'dir' : 'file'
            }
          } catch (err) {
            throw err
          }
        } else {
          // Try remote filesystem
          try {
            const stat = await ds.fs.stat_async(pathToRead)
            return stat
          } catch (err) {
            throw err
          }
        }
      }
  
      // REMOVE FILE - invalidate cache, fileModTime, and localFileCopy registry
      ds.removeFile = async function (endpath, options = {}) {
        options = options || {}
        const pathToRead = userRootFolder + '/' + this.owner + '/files/' + this.appName + '/' + endpath

        const localpath = path.normalize(ROOT_DIR + pathToRead)
        if (fs.existsSync(localpath)) {
          fs.unlinkSync(localpath)
        }
        
        // INVALIDATE CACHE and update fileModTime (signals to other servers)
        if (ds.cache) {
          ds.cache.deleteUserFile(endpath)
          // Invalidate fileModTime (sets to current time so other servers know to re-fetch)
          ds.cache.invalidateUserFileModTime(endpath)
        }
        
        // Note: localFileCopy registry entry will be stale, cleaned up on next wipe
        
        if (this.fsParams.type === 'local') { // above temp deletion is actual deletion
          return { success: true }
        } else {
          try {
            await this.fs.unlink_async(pathToRead)
            return { success: true }
          } catch (err) {
            throw err
          }
        }
      }
  
      // REMOVE FOLDER - invalidate cache, fileModTime, and localFileCopy registry
      ds.removeFolder = async function (endpath, options = {}) {
        options = options || {}
        const pathToRead = userRootFolder + '/' + this.owner + '/files/' + this.appName + '/' + endpath

        const localpath = path.normalize(ROOT_DIR + pathToRead)
        if (fs.existsSync(localpath)) {
          fs.rmdirSync(localpath)
        }
        
        // INVALIDATE CACHE and fileModTime for all files in folder
        if (ds.cache) {
          // Delete all userFiles cache entries that start with this path
          const userFilesPattern = `^${ds.cache.namespace}:userFiles:${endpath}`
          ds.cache._interface.deletePattern(userFilesPattern)
          // Delete all userFileModTime entries that start with this path
          const modTimePattern = `^${ds.cache.namespace}:userFileModTime:${endpath}`
          ds.cache._interface.deletePattern(modTimePattern)
        }
        
        // Note: localFileCopy registry entries for files in this folder will be stale
        // They will be cleaned up on next wipe operation
        
        if (this.fsParams.type === 'local') { // above temp deletion is actual deletion
          return { success: true }
        } else {
          try {
            await this.fs.removeFolder_async(pathToRead)
            return { success: true }
          } catch (err) {
            throw err
          }
        }
      }
  
      ds.sendUserFile = function (endpath, res, options) {
        const partialPath = (userRootFolder + '/' + this.owner + '/files/' + this.appName + '/' + endpath)        
        // Helper to track local file copy (using userCache, not CacheManager directly)
        const trackLocalFileCopy = (size = 0) => {
          try {
            if (userDs.userCache) {
              userDs.userCache.trackLocalFileCopy(ds.appName, partialPath, 'userFile', size)
            }
          } catch (e) { /* ignore tracking errors */ }
        }
        
        // Helper to check if local copy is stale (for multi-server consistency)
        const isLocalCopyStale = () => {
          if (!ds.cache || !userDs.userCache) return false
          try {
            const sharedModTime = ds.cache.getUserFileModTime(endpath)
            if (!sharedModTime) return false
            const localCopyTime = userDs.userCache.getLocalFileCopyTime(ds.appName, partialPath)
            if (!localCopyTime) return true
            return sharedModTime > localCopyTime
          } catch (e) { return false }
        }

        // Check new cache first (for cacheable files)
        if (ds.cache && isCacheableFile(endpath)) {
          const cached = ds.cache.getUserFile(endpath)
          if (cached !== null) {
            // onsole.log('📦 Cache hit for sendUserFile', endpath)
            sendStream(res, Buffer.from(cached))
            return
          }
        }

        const localpath = path.normalize(ROOT_DIR + partialPath)
        const localFileExists = fs.existsSync(localpath)
        const shouldRefetchFromRemote = localFileExists && isLocalCopyStale()
        
        if (localFileExists && !shouldRefetchFromRemote) {
          // Cache the file content for text-based files
          if (ds.cache && isCacheableFile(endpath)) {
            fs.promises.readFile(localpath).then(content => {
              ds.cache.setUserFile(endpath, content.toString())
              // onsole.log('📦 Cache set for sendUserFile', endpath)
            }).catch(() => {}) // Ignore cache errors
          }
          sendFile(res, localpath)
        } else if (this.fs.getFileToSend) { // getFileToSend will be missing if a localfile is actually missing
          try {
            this.fs.getFileToSend(partialPath, null, function (err, streamOrFile) {
              if (err) {
                console.warn('🔴 sendUserFile', 'err in sendUserFile for ', partialPath)
                res.status(404).send('file not found!')
                res.end()
              } else if (streamOrFile.pipe) { // it is a stream
                streamOrFile.pipe(res)
                localCheckExistsOrCreateUserFolderSync(partialPath, true)
                streamOrFile.pipe(fs.createWriteStream(localpath))
                trackLocalFileCopy() // Track that we copied this file locally
              } else { // it is a file
                sendStream(res, streamOrFile)
                localCheckExistsOrCreateUserFolderSync(partialPath, true)
                fs.writeFile(localpath, streamOrFile, null, function (err, name) {
                  if (err) {
                    console.warn('🔴 sendUserFile', ' -  error putting back in cache ' + partialPath)
                  } else {
                    // Cache the file content for text-based files
                    if (ds.cache && isCacheableFile(endpath)) {
                      ds.cache.setUserFile(endpath, streamOrFile.toString())
                      // onsole.log('📦 Cache set for sendUserFile (remote)', endpath)
                    }
                    trackLocalFileCopy(streamOrFile.length) // Track that we copied this file locally
                  }
                })
              }
            })
          } catch (err) {
            console.warn('🔴 sendUserFile', 'err in sendUserFile 2 for ', partialPath)
            res.status(404).send('file error')
            res.end()
          }
        } else {
          res.status(404).send('file not found!')
          res.end()
        }
      }
  
      ds.getUserFile = async function (endpath, options = {}) {
        const partialPath = (userRootFolder + '/' + this.owner + '/files/' + this.appName + '/' + endpath)
        const returnBuffer = options.returnBuffer // For binary files like zips

        // Check cache first (for cacheable files) - skip cache for buffer requests
        if (!returnBuffer && ds.cache && isCacheableFile(endpath)) {
          const cached = ds.cache.getUserFile(endpath)
          if (cached !== null) {
            // onsole.log('📦 Cache hit for getUserFile', endpath)
            return cached
          }
        }

        const localpath = path.normalize(ROOT_DIR + partialPath)
        
        // Try local filesystem first
        if (fs.existsSync(localpath)) {
          try {
            const content = await fs.promises.readFile(localpath)
            
            // Return raw buffer for binary files (e.g., zip files)
            if (returnBuffer) {
              return content
            }
            
            const contentStr = content.toString()
            
            // Cache the file content for text-based files
            if (ds.cache && isCacheableFile(endpath)) {
              ds.cache.setUserFile(endpath, contentStr)
              // onsole.log('📦 Cache set for getUserFile', endpath)
            }
            
            return contentStr
          } catch (err) {
            console.warn('🔴 err in getUserFile (local)', err.message)
            throw err
          }
        }
        
        // Fall back to remote filesystem
        if (this.fs.getFileToSend_async) { // getFileToSend will be missing if a localfile is actually missing
          try {
            const content = await this.fs.getFileToSend_async(partialPath, null)
            
            // Return raw buffer for binary files
            if (returnBuffer) {
              return Buffer.isBuffer(content) ? content : Buffer.from(content)
            }
            
            // Cache the file content for text-based files
            if (ds.cache && isCacheableFile(endpath) && content) {
              const contentStr = content.toString ? content.toString() : content
              ds.cache.setUserFile(endpath, contentStr)
              // onsole.log('📦 Cache set for getUserFile (remote)', endpath)
            }
            
            return content
          } catch (err) {
            console.warn('🔴 err in getUserFile')
            throw err
          }
        } else {
          throw new Error('file not found!')
        }
      }
  
      // for non system apps and installtion....
      ds.removeAllAppFiles = async function (options = {}) {
        try {
          const appPathToDelete = userRootFolder + '/' + this.owner + '/apps/' + this.appName
          await ds.fs.removeFolder_async(appPathToDelete)
          const filesPathToDelete = userRootFolder + '/' + this.owner + '/files/' + this.appName
          await ds.fs.removeFolder_async(filesPathToDelete)
          
          // INVALIDATE ALL CACHE for this app
          if (ds.cache) {
            ds.cache.invalidateAll()
            // onsole.log('📦 Cache invalidated for removeAllAppFiles')
          }
          
          return { success: true }
        } catch (e) {
          console.warn('🔴 err in removeAllAppFiles removeAllAppFiles')
          throw e
        }
      }
  
      // WRITE TO APP FILES - invalidate cache and update fileModTime
      ds.writeToAppFiles = async function (endpath, content, options = {}) {
        const pathToWrite = userRootFolder + '/' + this.owner + '/apps/' + this.appName + '/' + endpath

        try {
          const name = await this.fs.writeFile_async(pathToWrite, content, options)
          
          // Write the file locally as well
          try {
            const localPath = ROOT_DIR + pathToWrite
            const localDir = path.dirname(localPath)
            await fs.promises.mkdir(localDir, { recursive: true })
            
            const writeOptions = { ...options }
            if (options.doNotOverWrite) writeOptions.doNotOverWrite = false
            
            await fs.promises.writeFile(localPath, content, writeOptions)
            
            // INVALIDATE APP FILE CACHE (memory cache) and update fileModTime
            if (ds.cache) {
              ds.cache.deleteAppFile(endpath)
              // Update fileModTime in shared cache (for multi-server consistency)
              ds.cache.setAppFileModTime(endpath)
            }
          } catch (err) {
            console.warn('🔴 writeToAppFiles', 'Error duplicating file in local drive for writeToAppFiles for ', this.owner, 'path ', pathToWrite, err.message)
          }
          
          return name
        } catch (err) {
          console.warn('🔴 err in writefile')
          throw err
        }
      }
  
      ds.folderSize = async function (folder) {
        // needs to be for apps and for files
        if (['apps', 'files', 'db'].includes(folder)) {
          const pathToRead = userRootFolder + '/' + this.owner + '/' + folder + '/' + this.appName
          if (this.fs.size) {
            try {
              return await this.fs.size_async(pathToRead)
            } catch (err) {
              console.warn('🔴 err in folderSize')
              throw err
            }
          } else {
            throw new Error('No size function for ' + this.fsParams.type)
          }
        } else {
          throw new Error('folderSize can only be used for apps and files directories')
        }
      }
       
      const initUserDirectories = async function (ds, owner) {
        try {
          if (!owner) throw new Error('owner is required in initUserDirectories')
          if (!ds.fs) {
            console.warn('ds.fs is not defined in initUserDirectories', { owner, appName, fsType: ds.fsParams?.type,  dsfsType: ds.fs?.params?.type})
            ds.fs = {}
          }
          if (!ds.fs.initFS_async) ds.fs.initFS_async = async function() { return Promise.resolve() }
          if (!ds.fs.mkdirp_async) ds.fs.mkdirp_async = async function(path) { return Promise.resolve() }
          
          try {
            await ds.fs.initFS_async()
            await ds.fs.mkdirp_async(userRootFolder + '/' + owner + '/apps/' + appName)
            await ds.fs.mkdirp_async(userRootFolder + '/' + owner + '/files/' + appName)
            await ds.fs.mkdirp_async(userRootFolder + '/' + owner + '/db/' + appName)
            return ds
          } catch (err) {
            console.warn('initUserDirectories - err in async operations ', { owner, appName, fsType: ds.fsParams?.type,  dsfsType: ds.fs?.params?.type, error: err.message})
            throw err
          }
        } catch (err) {
          console.warn('initUserDirectories - err ', { owner, appName, fsType: ds.fsParams?.type,  dsfsType: ds.fs?.params?.type})
          throw err
        }
      }
      
      if (ds.fs?.initFS) {
        try {
          await ds.fs.initFS_async()
          
          if (options && options.getRefreshToken) {
            return ds
          } else {
            return await initUserDirectories(ds, userDs.owner)
          }
        } catch (err) {
          console.warn('err in initfs (2) ', { owner, appName, fsType: ds.fsParams?.type,  dsfsType: ds.fs?.params?.type})
          throw err
        }
      } else {
        await initUserDirectories(ds, userDs.owner)
      }
      
      return ds
    }
  }
  
  const RECALCUATE_STORAGE_INNER_LIMIT = (6 * 1000)
  USER_DS.prototype.getUseageWarning = function () {
    if (!this.useage || !this.useage.storageLimit) return { ok: true }
    if (this.useage.errorInCalculating) console.warn('🔴 ERRR this.useage.errorInCalculating', this.useage.errorInCalculating)
    const isNotOk = this.useage.errorInCalculating ||
      (this.useage.lastStorageCalcs?.totalSize !== null && this.useage.lastStorageCalcs?.totalSize !== undefined && (this.useage.storageLimit * 1000000 < this.useage.lastStorageCalcs?.totalSize))
    const w = {
      ok: !isNotOk,
      storageLimit: this.useage.storageLimit,
      storageUse: this.useage.lastStorageCalcs?.totalSize
    }
    if (!w.ok) console.warn('🔴 not okay this.useage.errorInCalculating ', this.useage.errorInCalculating, 'this.useage.storageLimit ', this.useage.storageLimit, 'this.useage.lastStorageCalcs?.totalSize ', this.useage.lastStorageCalcs?.totalSize, { isNotOk })
    return w
  }
  USER_DS.prototype.setTimerToRecalcStorage = function (force) {
    const self = this
  
    if (!this.useage || !this.useage.storageLimit) {
      return null
    } else {
      const options = { freezrPrefs: { dbUnificationStrategy: self.dbParams.dbUnificationStrategy, useUserIdsAsDbName: self.dbParams.useUserIdsAsDbName } }
      const calculateNow = function () {
        self.getStorageUse(null, options, function (err, calcs) {
          if (err) self.useage.errorInCalculating = { error: err, time: new Date().getTime() }
          if (!err) {
            self.useage.dbWritesSinceLastCalc = 0
            self.useage.errorInCalculating = null
          }
        })
      }
      const outerLimitsPassed = function () {
        const RECALCUATE_STORAGE_OUTER_TIME_LIMIT = (6 * 60 * 60 * 1000)
        const RECALCUATE_STORAGE_OUTER_WRITE_LIMIT = 10
        return (self.useage?.lastStorageCalcs.time &&
          new Date().getTime() - self.useage?.lastStorageCalcs.time > RECALCUATE_STORAGE_OUTER_TIME_LIMIT) ||
          (self.useage?.dbWritesSinceLastCalc &&
            self.useage?.dbWritesSinceLastCalc > RECALCUATE_STORAGE_OUTER_WRITE_LIMIT) ||
          false
      }
      if (force || outerLimitsPassed()) {
        clearTimeout(self.useage.calcTimer)
        calculateNow()
      } else {
        clearTimeout(self.useage.calcTimer)
        self.useage.calcTimer = setTimeout(() => {
          calculateNow()
        }, RECALCUATE_STORAGE_INNER_LIMIT)
      }
      return null
    }
  }
  
  USER_DS.prototype.getStorageUse = async function (app, options = {}) {
    const userId = this.owner
    const userDS = this
  
    if (!options?.forceUpdate && userDS.useage.lastStorageCalcs.totalSize) {
      return userDS.useage.lastStorageCalcs
    } else {
      const oac = {
        owner: userId,
        app_name: 'info.freezr.account',
        collection_name: 'app_list'
      }
      const resources = []
  
      try {
        // 1. get db
        let appList = null
        if (!app) {
          appList = await userDS.getorInitDb(oac, options)
        }
  
        // 2. get all user apps
        let allAppsToFollow
        if (app) {
          allAppsToFollow = [{ app_name: app }]
        } else if (!appList || !appList.query) {
          console.warn('🔴 bad retrieval of db ', { appList })
          throw new Error('inccomplete or authentication malfucntion getting db for ' + userId)
        } else {
          allAppsToFollow = await appList.query({}, {})
        }
  
        // 3. process each app
        for (const appItem of allAppsToFollow) {
          let allTableNamesForApp = []
          const tableSizes = {}
          let appFS
          const folderSizes = { apps: 0, files: 0 }
  
          try {
            // Get app file system
            appFS = await userDS.getorInitAppFS(appItem.app_name, {})
            
            // Get folder sizes
            folderSizes.apps = await appFS.folderSize('apps')
            folderSizes.files = await appFS.folderSize('files')
  
            // Get database info
            const topdb = await userDS.getorInitDb({ owner: userId, app_table: appItem.app_name }, {})
            allTableNamesForApp = await topdb.getAllAppTableNames(appItem.app_name)
  
            // Add permission tables
            if (appItem && appItem.manifest && appItem.manifest.permissions && appItem.manifest.permissions.length > 0) {
              appItem.manifest.permissions.forEach(perm => {
                if (perm.table_id && !allTableNamesForApp.includes(perm.table_id)) allTableNamesForApp.push(perm.table_id)
              })
            }
  
            // Get table sizes
            for (const tableName of allTableNamesForApp) {
              try {
                const db = await userDS.getorInitDb({ owner: userId, app_table: tableName }, {})
                const stats = await db.getTableStats()
                tableSizes[tableName] = stats?.size || 0
              } catch (err) {
                console.warn('🔴 Error getting table stats for', tableName, err.message)
                tableSizes[tableName] = 0
              }
            }
  
            resources.push({ 
              appName: appItem.app_name, 
              dbNames: allTableNamesForApp, 
              dbs: tableSizes, 
              apps: folderSizes.apps, 
              files: folderSizes.files 
            })
          } catch (err) {
            console.warn('🔴 Error processing app', appItem.app_name, err.message)
            // Continue with other apps even if one fails
          }
        }
  
        // Calculate totals
        let totalSize = 0
        const allTableSizes = {}
        resources.forEach(resource => {
          totalSize += resource.apps
          totalSize += resource.files
          for (const [dbName, size] of Object.entries(resource.dbs)) {
            if (!allTableSizes[dbName]) {
              allTableSizes[dbName] = size
              totalSize += size
            }
          }
        })
  
        userDS.useage.lastStorageCalcs = { resources, totalSize, time: new Date().getTime() }
        return { resources, totalSize }
  
      } catch (err) {
        userDS.useage.calcerror = { error: err, time: new Date().getTime() }
        throw err
      }
    }
  }
  
  const appTableName = function (oac) {
    if ((!oac.app_name && !oac.app_table) || !oac.owner) {
      console.warn('🔴 DATA_STORE_MANAGER  failure - need app name or table and an owner for ' + JSON.stringify(oac))
      return null
    } else {
      if (oac.app_table) return oac.app_table.replace(/\./g, '_')
      const name = oac.app_name + (oac.collection_name ? ('_' + oac.collection_name) : '')
      return name.replace(/\./g, '_')
    }
  }
  
  const persistOldFilesNow = function (userDs, dbToPersist) {
    let persistNext = null
    if (!dbToPersist) {
      let oldestWrite = new Date().getTime()
      let dbChangeCountHasPassedThreshold = 0
      Object.keys(userDs.appcoll).forEach((key) => {
        const thresholdPassed = (userDs.appcoll[key].dbChgCount > DB_CHANGE_COUNT_THRESHOLD)
        if (userDs.appcoll[key] &&
          ((userDs.appcoll[key].dbOldestWrite && userDs.appcoll[key].dbOldestWrite < oldestWrite) ||
            thresholdPassed
          ) &&
          userDs.appcoll[key].db && userDs.appcoll[key].db.persistCachedDatabase
        ) {
          if (!thresholdPassed) oldestWrite = userDs.appcoll[key].dbOldestWrite
          if (dbChangeCountHasPassedThreshold === 0) dbToPersist = userDs.appcoll[key]
          if (thresholdPassed && dbChangeCountHasPassedThreshold === 1) persistNext = userDs.appcoll[key]
          if (thresholdPassed) dbChangeCountHasPassedThreshold++
        }
      })
    }
    if (dbToPersist && dbToPersist.db && dbToPersist.db.persistCachedDatabase) {
      dbToPersist.persistenceInProgress = true
  
      dbToPersist.db.persistCachedDatabase(function (err) {
        dbToPersist.persistenceInProgress = false
        if (!err) {
          dbToPersist.dbChgCount = 0
          dbToPersist.dbOldestWrite = null
        }
        resetPersistenceTimer(userDs, persistNext)
      })
    }
  }
  
  const resetPersistenceTimer = function (userDs, originStore) {
    clearTimeout(userDs.dbPersistenceManager.timer)
    const newtime = originStore ? 1000 : DB_PERSISTANCE_IDLE_TIME_THRESHOLD
    userDs.dbPersistenceManager.timer = setTimeout(function () { persistOldFilesNow(userDs) }, newtime)
  }
  
  const localCheckExistsOrCreateUserFolderSync = function (aPath, removeEndFile) {
    const dirs = aPath.split('/')
    if (removeEndFile) dirs.pop()
    let root = ''
  
    mkDir()
  
    function mkDir () {
      const dir = dirs.shift()
      if (dir === '') {
        root = path.normalize(ROOT_DIR)
      }
      if (!fs.existsSync(root + dir)) {
        fs.mkdirSync(root + dir)
        root += dir + pathSep
        if (dirs.length > 0) {
          mkDir()
        }
      } else {
        root += dir + pathSep
        if (dirs.length > 0) {
          mkDir()
        }
      }
    }
  }

// Interface  
export default USER_DS
export { appTableName }
