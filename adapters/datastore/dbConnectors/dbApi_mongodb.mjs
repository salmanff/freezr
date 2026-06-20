// freezr.info - dbApi_mongodb.mjs
// API for accessing mongodb databases
//
// All methods are natively async (_async suffix). Callback versions delegate
// to the async versions for backward compatibility with the auto-promisifier
// in userDsMgr.mjs.

import { startsWith } from '../../../common/helpers/utils.mjs'
import { MongoClient, ObjectId } from 'mongodb'
import { fullOACName, hasUnifiedStrategy, getRevisedIdWithOatAdded } from './mongo_utils.mjs'
import { acquire, getStats as getRegistryStats } from './mongoClientRegistry.mjs'

export const version = '0.0.210'

const ARBITRARY_FIND_COUNT_DEFAULT = 100

// When true, falls back to old per-operation MongoClient (no registry).
// Set MONGO_DO_NOT_USE_REGISTRY=true in env to disable the registry.
const DO_NOT_USE_REGISTRY = process.env.MONGO_DO_NOT_USE_REGISTRY === 'true'
if (DO_NOT_USE_REGISTRY) console.warn('[dbApi_mongodb] Registry DISABLED — using per-operation MongoClient')

// Re-export registry stats for monitoring
export { getRegistryStats as getConnectionStats }

// -------------------------------------------------------------------------
// Constructor (unchanged)
// -------------------------------------------------------------------------
function MONGO_FOR_FREEZR (environment, ownerAppTable) {
  this.env = environment
  this.oat = ownerAppTable
  this.env.oatCopy = ownerAppTable

  if ([null, 'null', undefined, 'undefined'].indexOf(this.oat.owner) > -1) throw new Error('Cannot have null or undefined owner')
  if (!ownerAppTable) throw new Error('Mongo collection failure - need ownerAppTable')
  const appTable = ownerAppTable.app_table || (ownerAppTable.app_name + (ownerAppTable.collection_name ? ('_' + ownerAppTable.collection_name) : ''))
  if (!appTable || !ownerAppTable.owner || ownerAppTable.owner === 'null' || ownerAppTable.owner === 'undefined') {
    throw new Error('Mongo collection failure - need app name and an owner for ' + ownerAppTable.owner + '__' + ownerAppTable.app_name + '_' + ownerAppTable.collection_name)
  }
}

// -------------------------------------------------------------------------
// Async methods (native — these are the "real" implementations)
// -------------------------------------------------------------------------

MONGO_FOR_FREEZR.prototype.createIndex_async = async function (indexParams, indexOptions) {
  if (this.env.dbParams.choice !== 'cosmosForMongoString') return null
  const { coll, collName, release } = await getMongoContext(this)
  try {
    await coll.createIndex(indexParams, indexOptions)
    return null
  } catch (err) {
    console.warn('got err in createIndex in mongo db ', { collName, err })
    throw err
  } finally {
    release()
  }
}

MONGO_FOR_FREEZR.prototype.initDB_async = async function () {
  if (this.env.dbParams.choice !== 'cosmosForMongoString') return null
  const { coll, collName, release } = await getMongoContext(this)
  try {
    await coll.createIndex({ _date_modified: -1 }, { background: true, unique: false })
    return null
  } catch (err) {
    console.warn('got err in initDB in mongo db ', { collName, err })
    throw err
  } finally {
    release()
  }
}

MONGO_FOR_FREEZR.prototype.read_by_id_async = async function (id) {
  const { coll, collName, release } = await getMongoContext(this)
  try {
    if (hasUnifiedStrategy(this.env.dbParams, this.oat.owner)) {
      id = getRevisedIdWithOatAdded(id, this.oat)
    }
    const query = { _id: getRealObjectId(id) }
    if (hasUnifiedStrategy(this.env.dbParams, this.oat.owner)) {
      query.__owner = this.oat.owner
      query.__appTable = fullOACName(this.oat, false)
    }
    return await coll.findOne(query)
  } catch (err) {
    console.warn('got err in read db ', { collName, err })
    throw err
  } finally {
    release()
  }
}

MONGO_FOR_FREEZR.prototype.create_async = async function (id, entity, options) {
  // Apply unified strategy if needed
  if (hasUnifiedStrategy(this.env.dbParams, this.oat.owner) && id) {
    id = getRevisedIdWithOatAdded(id, this.oat)
  }
  if (id) entity._id = getRealObjectId(id)
  if (hasUnifiedStrategy(this.env.dbParams, this.oat.owner)) {
    entity.__owner = this.oat.owner
    entity.__appTable = fullOACName(this.oat, false)
  }

  let retryAttempted = Boolean(options?.secondtry)
  while (true) {
    const { coll, collName, release } = await getMongoContext(this)
    try {
      const response = await coll.insertOne(entity)
      return { success: true, _id: response?.insertedId }
    } catch (err) {
      if (this.env.dbParams.choice === 'cosmosForMongoString' &&
          !retryAttempted &&
          err?.errmsg?.indexOf('because it would have increased the total throughput') > -1) {
        console.warn('azure throughput issue - trying second time')
        retryAttempted = true
        await wait(2000)
        continue
      }
      console.warn('got err in write db 1 ', { collName, err, id, entity })
      throw err
    } finally {
      release()
    }
  }
}

MONGO_FOR_FREEZR.prototype.update_multi_records_async = async function (idOrQuery, updatesToEntity) {
  let updateMultiple = true
  if (typeof idOrQuery === 'string') {
    updateMultiple = false
    if (hasUnifiedStrategy(this.env.dbParams, this.oat.owner)) {
      idOrQuery = getRevisedIdWithOatAdded(idOrQuery, this.oat)
    }
    idOrQuery = { _id: getRealObjectId(idOrQuery) }
  } else if (ObjectId.isValid(idOrQuery)) {
    updateMultiple = false
    idOrQuery = { _id: idOrQuery }
  } else if (idOrQuery._id) {
    updateMultiple = false
    if (!ObjectId.isValid(idOrQuery._id)) {
      if (typeof idOrQuery._id === 'string') {
        if (hasUnifiedStrategy(this.env.dbParams, this.oat.owner)) {
          idOrQuery._id = getRevisedIdWithOatAdded(idOrQuery._id, this.oat)
        }
        idOrQuery._id = getRealObjectId(idOrQuery._id)
      } else {
        console.warn('Can only have objectids and strings when querying _id')
      }
    }
  } else if (idOrQuery.$and || idOrQuery.$or) {
    console.warn('currently cannot do $and and $or of _ids - need to add objectIds iteratively')
  }

  const { coll, collName, release } = await getMongoContext(this)
  try {
    if (hasUnifiedStrategy(this.env.dbParams, this.oat.owner)) {
      idOrQuery.__owner = this.oat.owner
      idOrQuery.__appTable = fullOACName(this.oat, false)
      delete updatesToEntity.__owner
      delete updatesToEntity.__appTable
    }
    if (updateMultiple) {
      const response = await coll.updateMany(idOrQuery, { $set: updatesToEntity }, { safe: true })
      return { success: true, nModified: response?.modifiedCount }
    } else {
      const response = await coll.updateOne(idOrQuery, { $set: updatesToEntity }, { safe: true })
      return { success: true, nModified: response?.modifiedCount }
    }
  } catch (err) {
    console.warn('got err in update in mongo db ', { collName, idOrQuery, err })
    throw err
  } finally {
    release()
  }
}

MONGO_FOR_FREEZR.prototype.replace_record_by_id_async = async function (id, updatedEntity) {
  const { coll, collName, release } = await getMongoContext(this)
  try {
    if (hasUnifiedStrategy(this.env.dbParams, this.oat.owner)) {
      id = getRevisedIdWithOatAdded(id, this.oat)
    }
    const query = { _id: getRealObjectId(id) }
    if (hasUnifiedStrategy(this.env.dbParams, this.oat.owner)) {
      query.__owner = this.oat.owner
      query.__appTable = fullOACName(this.oat, false)
      updatedEntity.__owner = this.oat.owner
      updatedEntity.__appTable = fullOACName(this.oat, false)
    }
    const response = await coll.replaceOne(query, updatedEntity, { safe: true })
    return { success: true, nModified: response?.modifiedCount }
  } catch (err) {
    console.warn('got err in replace_record_by_id in mongo db ', { collName, err })
    throw err
  } finally {
    release()
  }
}

MONGO_FOR_FREEZR.prototype.query_async = async function (idOrQuery, options = {}) {
  let findMultiple = true
  if (!idOrQuery) {
    idOrQuery = {}
  } else if (typeof idOrQuery === 'string') {
    if (hasUnifiedStrategy(this.env.dbParams, this.oat.owner)) {
      idOrQuery = getRevisedIdWithOatAdded(idOrQuery, this.oat)
    }
    idOrQuery = { _id: getRealObjectId(idOrQuery) }
    findMultiple = false
  } else if (idOrQuery._id) {
    if (typeof idOrQuery._id === 'string') {
      if (hasUnifiedStrategy(this.env.dbParams, this.oat.owner)) {
        idOrQuery._id = getRevisedIdWithOatAdded(idOrQuery._id, this.oat)
      }
      idOrQuery._id = getRealObjectId(idOrQuery._id)
    }
    findMultiple = false
  }
  if (hasUnifiedStrategy(this.env.dbParams, this.oat.owner)) {
    idOrQuery.__owner = this.oat.owner
    idOrQuery.__appTable = fullOACName(this.oat, false)
  }

  const { coll, collName, release } = await getMongoContext(this)
  try {
    if (findMultiple) {
      let response = await coll.find(idOrQuery, options)
        .sort(options.sort || null)
        .limit(options.count || options.limit || ARBITRARY_FIND_COUNT_DEFAULT)
        .skip(options.skip || 0)
        .toArray()
      const origLen = response.length
      if (hasUnifiedStrategy(this.env.dbParams, this.oat.owner)) {
        response = response.filter(r => r.__owner === this.oat.owner && r.__appTable === fullOACName(this.oat, false))
      }
      if (hasUnifiedStrategy(this.env.dbParams, this.oat.owner) && origLen !== response.length) {
        throw new Error('fetched other peoples data ;( ')
      }
      return response
    } else {
      const response = await coll.findOne(idOrQuery, options)
      if (response && hasUnifiedStrategy(this.env.dbParams, this.oat.owner) &&
          (response?.__owner !== this.oat.owner || response?.__appTable !== fullOACName(this.oat, false))) {
        throw new Error('mismatch of __owner or __appTable')
      }
      return response ? [response] : []
    }
  } catch (err) {
    console.warn('got err in query in mongodb db ', { collName, idOrQuery, err })
    throw err
  } finally {
    release()
  }
}

MONGO_FOR_FREEZR.prototype.delete_record_async = async function (idOrQuery, options = {}) {
  let deleteMultiple = true
  if (typeof idOrQuery === 'string') {
    if (hasUnifiedStrategy(this.env.dbParams, this.oat.owner)) {
      idOrQuery = getRevisedIdWithOatAdded(idOrQuery, this.oat)
    }
    idOrQuery = { _id: getRealObjectId(idOrQuery) }
    deleteMultiple = false
  } else if (idOrQuery._id && typeof idOrQuery._id === 'string') {
    if (hasUnifiedStrategy(this.env.dbParams, this.oat.owner)) {
      idOrQuery._id = getRevisedIdWithOatAdded(idOrQuery._id, this.oat)
    }
    idOrQuery._id = getRealObjectId(idOrQuery._id)
    deleteMultiple = false
  }

  const { coll, collName, release } = await getMongoContext(this)
  try {
    if (hasUnifiedStrategy(this.env.dbParams, this.oat.owner)) {
      idOrQuery.__owner = this.oat.owner
      idOrQuery.__appTable = fullOACName(this.oat, false)
    }
    if (deleteMultiple) {
      const response = await coll.deleteMany(idOrQuery, {})
      return { success: true, nModified: response?.deletedCount }
    } else {
      const response = await coll.deleteOne(idOrQuery, {})
      return { success: true, nModified: response?.deletedCount }
    }
  } catch (err) {
    console.warn('got err in delete in mongo db ', { collName, err })
    throw err
  } finally {
    release()
  }
}

MONGO_FOR_FREEZR.prototype.getAllAppTableNames_async = async function (appOrTableNameOrNames) {
  const userId = this.oat.owner
  if (typeof appOrTableNameOrNames === 'string') appOrTableNameOrNames = [appOrTableNameOrNames]

  const { coll, collName, dbName, database, release } = await getMongoContext(this)
  try {
    if (hasUnifiedStrategy(this.env.dbParams, this.oat.owner)) {
      const response = await coll.distinct('__appTable', { __owner: this.oat.owner })
      return appTablesFilter(response, appOrTableNameOrNames, userId)
    } else {
      let response = await database.listCollections().toArray()
      response = response.map(r => r.name)
      return appTablesFilter(response, appOrTableNameOrNames, userId)
    }
  } catch (err) {
    console.warn('got err in getAllAppTableNames in mongo db ', { dbName, collName, err })
    throw err
  } finally {
    release()
  }
}

MONGO_FOR_FREEZR.prototype.count_async = async function (idOrQuery = {}) {
  const { coll, collName, release } = await getMongoContext(this)
  try {
    const filter = { ...(idOrQuery || {}) }
    if (hasUnifiedStrategy(this.env.dbParams, this.oat.owner)) {
      filter.__owner = this.oat.owner
      filter.__appTable = fullOACName(this.oat, false)
    }
    return await coll.countDocuments(filter)
  } catch (err) {
    console.warn('got err in count in mongo db ', { collName, err })
    throw err
  } finally {
    release()
  }
}

MONGO_FOR_FREEZR.prototype.stats_async = async function () {
  const { coll, collName, release } = await getMongoContext(this)
  try {
    if (hasUnifiedStrategy(this.env.dbParams, this.oat.owner)) {
      const idOrQuery = { __owner: this.oat.owner, __appTable: fullOACName(this.oat, false) }
      return await getCollectionScanStats(coll, idOrQuery)
    } else if (coll.stats) {
      const response = await coll.stats()
      return { size: response.storageSize, originalStats: response }
    } else {
      return await getCollectionScanStats(coll, {})
    }
  } catch (err) {
    console.warn('got err in stats for mongo db ', { collName, err })
    throw err
  } finally {
    release()
  }
}

MONGO_FOR_FREEZR.prototype.persistCachedDatabase = function (cb) {
  cb(null)
}

// -------------------------------------------------------------------------
// Callback wrappers (backward compat — auto-promisifier in userDsMgr.mjs
// skips these because the _async versions already exist on the prototype)
// -------------------------------------------------------------------------

MONGO_FOR_FREEZR.prototype.createIndex = function (indexParams, indexOptions, callback) {
  this.createIndex_async(indexParams, indexOptions).then(r => callback(null, r)).catch(callback)
}
MONGO_FOR_FREEZR.prototype.initDB = function (callback) {
  this.initDB_async().then(r => callback(null, r)).catch(callback)
}
MONGO_FOR_FREEZR.prototype.read_by_id = function (id, callback) {
  this.read_by_id_async(id).then(r => callback(null, r)).catch(callback)
}
MONGO_FOR_FREEZR.prototype.create = function (id, entity, options, callback) {
  this.create_async(id, entity, options).then(r => callback(null, r)).catch(callback)
}
MONGO_FOR_FREEZR.prototype.update_multi_records = function (idOrQuery, updatesToEntity, callback) {
  this.update_multi_records_async(idOrQuery, updatesToEntity).then(r => callback(null, r)).catch(callback)
}
MONGO_FOR_FREEZR.prototype.replace_record_by_id = function (id, updatedEntity, callback) {
  this.replace_record_by_id_async(id, updatedEntity).then(r => callback(null, r)).catch(callback)
}
MONGO_FOR_FREEZR.prototype.query = function (idOrQuery, options, callback) {
  this.query_async(idOrQuery, options).then(r => callback(null, r)).catch(callback)
}
MONGO_FOR_FREEZR.prototype.delete_record = function (idOrQuery, options, callback) {
  this.delete_record_async(idOrQuery, options).then(r => callback(null, r)).catch(callback)
}
MONGO_FOR_FREEZR.prototype.getAllAppTableNames = function (appOrTableNameOrNames, callback) {
  this.getAllAppTableNames_async(appOrTableNameOrNames).then(r => callback(null, r)).catch(callback)
}
MONGO_FOR_FREEZR.prototype.stats = function (callback) {
  this.stats_async().then(r => callback(null, r)).catch(callback)
}

// -------------------------------------------------------------------------
// Internal helpers
// -------------------------------------------------------------------------

const UNIFIED_COLLECTION_NAME = 'allUserAppData'
const DEFAULT_UNIFIED_DB_NAME = 'freezr'

const getMongoContext = async function (self) {
  const uri = dbConnectionString(self.env)
  let client, release

  if (DO_NOT_USE_REGISTRY) {
    // Fallback: per-operation client (old behavior)
    client = new MongoClient(uri)
    await client.connect()
    release = () => { client.close().catch(() => {}) }
  } else {
    const kind = self.env.dbParams.systemDb ? 'system' : 'byo'
    const acquired = await acquire(uri, { kind })
    client = acquired.client
    release = acquired.release
  }

  const useUnifiedDbName = hasUnifiedStrategy(self.env.dbParams, self.oat.owner) || self.env.dbParams.unifiedDbName || !self.env.dbParams.useUserIdsAsDbName
  const dbName = useUnifiedDbName
    ? (process?.env?.UNIFIED_DB_NAME || self.env.dbParams.unifiedDbName || DEFAULT_UNIFIED_DB_NAME)
    : self.oat.owner
  const database = client.db(dbName)
  const useUnifiedCollName = hasUnifiedStrategy(self.env.dbParams, self.oat.owner)
  const collName = useUnifiedCollName
    ? UNIFIED_COLLECTION_NAME
    : fullOACName(self.oat, useUnifiedDbName)
  return { client, release, collName, coll: database.collection(collName), dbName, database }
}

const dbConnectionString = function (envParams) {
  if (envParams.dbParams.choice === 'mongoLocal') {
    envParams.dbParams = {
      type: 'mongoLocal',
      port: '27017',
      host: 'localhost',
      pass: null,
      user: null,
      notAddAuth: true
    }
  }

  if (envParams.dbParams.connectionString) {
    let connectionString = envParams.dbParams.connectionString + '&authSource=admin'
    if (connectionString.indexOf('ssl=true') < 0) connectionString += '&ssl=true'
    if (connectionString.indexOf('maxIdleTimeMS') < 0) connectionString += '&maxIdleTimeMS=30000'
    return connectionString
  } else if (envParams.dbParams.mongoString) {
    let connectionString = envParams.dbParams.mongoString + '&authSource=admin'
    if (connectionString.indexOf('ssl=true') < 0) connectionString += '&ssl=true'
    if (connectionString.indexOf('maxIdleTimeMS') < 0) connectionString += '&maxIdleTimeMS=30000'
    return connectionString
  } else {
    let connectionString = 'mongodb://'
    if (envParams.dbParams.user) connectionString += envParams.dbParams.user + ':' + envParams.dbParams.pass + '@'
    connectionString += envParams.dbParams.host + ':' + (envParams.dbParams.host === 'localhost' ? '' : envParams.dbParams.port)
    connectionString += '/' + (envParams.dbParams.notAddAuth ? '?' : '?authSource=admin&')
    if (envParams.dbParams.choice === 'mongoLocal') connectionString += 'ssl=true&'
    connectionString += 'maxIdleTimeMS=30000'
    return connectionString
  }
}

const getRealObjectId = function (objectId) {
  let realId = objectId
  if (typeof objectId === 'string') {
    try {
      realId = new ObjectId(objectId)
    } catch (e) {
      // Could not convert to ObjectId - using text id
    }
  }
  return realId
}

const appTablesFilter = function (dbList, appOrTableNameOrNames, userId) {
  let list = []
  dbList.forEach(name => {
    let collName = name?.replace(/_/g, '.')
    if (name && startsWith(collName, userId)) {
      collName = collName.slice(userId.length + 2)
    }
    if (appOrTableNameOrNames) {
      appOrTableNameOrNames.forEach(requiredName => {
        if (startsWith(collName, requiredName)) list.push(collName)
      })
    } else {
      list.push(collName)
    }
  })
  list = list.filter((v, i, a) => a.indexOf(v) === i)
  return list
}

const getCollectionScanStats = async function (coll, idOrQuery = {}) {
  const LIMIT = 1000
  let size = 0
  let count = 0
  while (true) {
    const response = await coll.find(idOrQuery).limit(LIMIT).skip(count).toArray()
    size += Buffer.byteLength(JSON.stringify(response), 'utf8')
    count += response.length
    if (response.length < LIMIT) {
      return { count, size }
    }
  }
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// Exposed for the DB-migration service's "same physical database" guard (mongo→mongo).
export { dbConnectionString }

// Interface
export default MONGO_FOR_FREEZR
