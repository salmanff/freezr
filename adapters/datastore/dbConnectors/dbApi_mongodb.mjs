// freezr.info - dbApi_mongodb.mjs
// API for accessing mongodb databases
//
// All methods are natively async (_async suffix). Callback versions delegate
// to the async versions for backward compatibility with the auto-promisifier
// in userDsMgr.mjs.

import crypto from 'crypto'
import { startsWith } from '../../../common/helpers/utils.mjs'
import { MongoClient, ObjectId } from 'mongodb'
import { fullOACName, hasUnifiedStrategy, getRevisedIdWithOatAdded } from './mongo_utils.mjs'
import { acquire, getStats as getRegistryStats } from './mongoClientRegistry.mjs'

export const version = '0.0.210'

const ARBITRARY_FIND_COUNT_DEFAULT = 100

// Collections whose _date_modified index this PROCESS has already created.
//
// createIndex on an index that already exists does NOT rebuild it - mongo skips
// the recreate - so a repeat call is only a metadata round trip. That is cheap
// on real mongo, but on Cosmos metadata operations are charged against a
// SYSTEM-RESERVED budget that raising the collection's RU/s does not increase,
// so a burst of them (a cold start opening many tables at once) can throttle.
// Microsoft's guidance for exactly this is to do such initialisation once per
// application lifetime; the same pattern is why mongoose recommends autoIndex:
// false in production.
//
// Keyed by connection + database + collection, NOT by app table, which gives
// the right behaviour for both unification strategies without special-casing:
//   - 'all'  -> every table resolves to the one UNIFIED_COLLECTION_NAME, so the
//               whole install makes ONE call per process instead of one per
//               table-open.
//   - 'db'   -> each table is its own collection, so each still gets its one
//               call. That matters: freezr creates app tables dynamically and
//               table-open is the only hook there is.
// The connection is part of the key so one BYO user's index can never suppress
// the call for another user's separate database. It is hashed so a credentialed
// URI is not held in a long-lived set.
const indexedCollections = new Set()

const indexMemoKey = function (self) {
  const { dbName, collName } = targetNamesFor(self)
  const uriFingerprint = crypto.createHash('sha256')
    .update(dbConnectionString(self.env))
    .digest('hex')
    .slice(0, 16)
  return uriFingerprint + '|' + dbName + '|' + collName
}

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

/**
 * Create the _date_modified index, treating failure as non-fatal.
 *
 * The index is an OPTIMISATION, not a precondition: the collection reads and
 * writes correctly without it - only that sort stops being served from an index.
 * This used to rethrow, which made initOacDB treat it as a failed table open, so
 * a throttled metadata call against a collection that ALREADY HAD the index
 * failed a user request that had nothing wrong with it. Throttling also arrives
 * in bursts, so a cold start opening many tables produced a wave of them at once.
 *
 * Split out from initDB_async so it can be tested without a live connection.
 * @returns {Promise<boolean>} true if the index is now known to exist
 */
export const ensureDateModifiedIndex = async function (coll, collName) {
  try {
    await coll.createIndex({ _date_modified: -1 }, { background: true, unique: false })
    return true
  } catch (err) {
    console.warn('could not create the _date_modified index - continuing without it ',
      { collName, message: err?.message, code: err?.code })
    return false
  }
}

MONGO_FOR_FREEZR.prototype.initDB_async = async function () {
  if (this.env.dbParams.choice !== 'cosmosForMongoString') return null

  // Already done for this collection in this process - skip the whole round trip.
  const memoKey = indexMemoKey(this)
  if (indexedCollections.has(memoKey)) return null

  // NOTE: getMongoContext is deliberately OUTSIDE the tolerant path below. Not
  // being able to connect means the store genuinely cannot serve anything, and
  // that must still fail the table open - same distinction as the nedb executor
  // guard: "cannot execute" fails loudly, "an optional extra didn't happen" does not.
  const { coll, collName, release } = await getMongoContext(this)
  try {
    // Only memoised on success, so a throttled attempt is retried by the next
    // table-open rather than being silently skipped for the life of the process.
    if (await ensureDateModifiedIndex(coll, collName)) indexedCollections.add(memoKey)
    return null
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

  const { dbName, collName } = targetNamesFor(self)
  const database = client.db(dbName)
  return { client, release, collName, coll: database.collection(collName), dbName, database }
}

// Which physical database + collection this OAC resolves to. Extracted from
// getMongoContext so the index memo can compute the same target WITHOUT opening
// a connection - the whole point is to skip the round trip.
const targetNamesFor = function (self) {
  const useUnifiedDbName = hasUnifiedStrategy(self.env.dbParams, self.oat.owner) || self.env.dbParams.unifiedDbName || !self.env.dbParams.useUserIdsAsDbName
  const dbName = useUnifiedDbName
    ? (process?.env?.UNIFIED_DB_NAME || self.env.dbParams.unifiedDbName || DEFAULT_UNIFIED_DB_NAME)
    : self.oat.owner
  const useUnifiedCollName = hasUnifiedStrategy(self.env.dbParams, self.oat.owner)
  const collName = useUnifiedCollName
    ? UNIFIED_COLLECTION_NAME
    : fullOACName(self.oat, useUnifiedDbName)
  return { dbName, collName, useUnifiedDbName }
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

// Exposed for unit tests only - see test/unit/datastore/cosmosIndexMemo.test.mjs
export const __indexMemoInternals = { indexedCollections, indexMemoKey, targetNamesFor }

// Interface
export default MONGO_FOR_FREEZR
