// freezr.info - dbApi_mongodb,js
// API for accessing mongodb databases

// todo - add createDb to add db paramters (as per CEPS)

exports.version = '0.0.200'

const helpers = require('../helpers.js')

const { MongoClient } = require('mongodb')
const { ObjectId } = require('mongodb')

const ARBITRARY_FIND_COUNT_DEFAULT = 100

function MONGO_FOR_FREEZR (environment, ownerAppTable) {
  // Note: environment must have dbParams
  fdlog('MONGO_FOR_FREEZR ', { environment, ownerAppTable })
  fdlog('todo - need to do checks to make sure oat exists and env exists')

  this.env = environment
  this.oat = ownerAppTable

  if (this.env.dbParams.systemDb && this.env.dbParams.useUnifiedCollection && [null, 'null', undefined, 'undefined'].indexOf(this.oat.owner) > -1) throw helpers.error('Cannot have null or undefined owner')
  if (!ownerAppTable) throw helpers.error('Mongo collection failure - need ownerAppTable')
  const appTable = ownerAppTable.app_table || (ownerAppTable.app_name + (ownerAppTable.collection_name ? ('_' + ownerAppTable.collection_name) : ''))
  if (!appTable || !ownerAppTable.owner || ownerAppTable.owner === 'null' || ownerAppTable.owner === 'undefined') throw helpers.error('Mongo collection failure - need app name and an owner for ' + ownerAppTable.owner + '__' + ownerAppTable.app_name + '_' + ownerAppTable.collection_name)

  fdlog('setting mongo ', { processstrat: process?.env?.DB_UNIFICATION, dbparamsUnif: this.env.dbParams.useUnifiedCollection })
  if (this.env.dbParams.systemDb && process?.env?.DB_UNIFICATION === 'collection' && !this.env.dbParams.useUnifiedCollection) throw helpers.error('unifiedColl Mismatch 1')
  if (this.env.dbParams.systemDb && process?.env?.DB_UNIFICATION !== 'collection' && this.env.dbParams.useUnifiedCollection) throw helpers.error('unifiedColl Mismatch 2')
  // todo make similar checks for dbUnificationStrategy = db and user
}

MONGO_FOR_FREEZR.prototype.createIndex = function (indexParams, indexOptions, callback) {
  if (this.env.dbParams.choice !== 'cosmosForMongoString') {
    callback(null)
  } else { // cosmosForMongoString
    // see if it exists and if not create indeces...
    // then on initi of app or when update manifest recreate indeces
    const [collName, client, coll] = getCollFrom(this)
    coll.createIndex(indexParams, indexOptions)
      .then(response => {
        return callback(null)
      })
      .catch(err => {
        console.warn('got err in initDB in mongo db ', { collName, err })
        return callback(err)
      })
      .finally(() => {
        client.close()
      })
  }
}
MONGO_FOR_FREEZR.prototype.initDB = function (callback) {
  if (this.env.dbParams.choice !== 'cosmosForMongoString') {
    callback(null)
  } else { // cosmosForMongoString
    // see if it exists and if not create indeces...
    // then on initi of app or when update manifest recreate indeces
    const [collName, client, coll] = getCollFrom(this)
    coll.createIndex({ _date_modified: -1 }, { background: true, unique: false })
      .then(response => {
        return callback(null)
      })
      .catch(err => {
        console.warn('got err in initDB in mongo db ', { collName, err })
        return callback(err)
      })
      .finally(() => {
        client.close()
      })
  }
}
MONGO_FOR_FREEZR.prototype.read_by_id = function (id, callback) {
  // alternate...
  // const theDb = this.db
  // setTimeout(async () => {
  //   try {
  //     const result = await theDb.findOne({ _id: getRealObjectId(id) })
  //     callback(null, result)
  //   } catch (error) {
  //     callback(error)
  //   }
  // }, 0)

  fdlog('in mongo db read_by_id ', this.env)
  const [collName, client, coll] = getCollFrom(this)
  const query = { _id: getRealObjectId(id) }

  if (this.env.dbParams.useUnifiedCollection) {
    query.__owner = this.oat.owner
    query.__appTable = fullOACName(this.oat, false)
  }
  coll.findOne(query)
    .then(response => {
      return callback(null, response)
    })
    .catch(err => {
      console.warn('got err in read db ', { collName, err })
      return callback(err)
    })
    .finally(() => {
      client.close()
    })
}
MONGO_FOR_FREEZR.prototype.create = function (id, entity, options, callback) {
  fdlog('dbApi_mongodb Create entity ', { entity })
  if (id) entity._id = getRealObjectId(id)
  const [collName, client, coll] = getCollFrom(this)
  
  if (this.env.dbParams.useUnifiedCollection) {
    entity.__owner = this.oat.owner
    entity.__appTable = fullOACName(this.oat, false)
  }
  coll.insertOne(entity)
    .then(response => {
      const theId = response?.insertedId
      return callback(null, { success: true, _id: theId })
    })
    .catch(err => {
      console.warn('got err in write db 1 ', { collName, err, id, entity })
      return callback(err)
    })
    .finally(() => {
      client.close()
    })
}
MONGO_FOR_FREEZR.prototype.update_multi_records = function (idOrQuery, updatesToEntity, callback) {
  let updateMultiple = true
  if (typeof idOrQuery === 'string') {
    updateMultiple = false
    idOrQuery = { _id: getRealObjectId(idOrQuery) }
  } else if (ObjectId.isValid(idOrQuery)) {
    updateMultiple = false
    idOrQuery = { _id: idOrQuery }
  } else if (idOrQuery._id) { // nb also ignores additional conditions in query
    updateMultiple = false
    if (!ObjectId.isValid(idOrQuery._id)) {
      if (typeof idOrQuery._id === 'string') {
        idOrQuery._id = getRealObjectId(idOrQuery._id)
      } else {
        felog('Can only hjave objectids and strings when querying _id')
      }
    }
  } else if (idOrQuery.$and || idOrQuery.$or) {
    felog('currently cannot do $and and $or of _ids - need to add objectIds iteratively [???]')
  }
  const [collName, client, coll] = getCollFrom(this)

  if (this.env.dbParams.useUnifiedCollection) {
    idOrQuery.__owner = this.oat.owner
    idOrQuery.__appTable = fullOACName(this.oat, false)
    delete updatesToEntity.__owner
    delete updatesToEntity.__appTable
  }

  fdlog('in update_multi_records gort collName ', { collName })
  // if (this.env.dbParams.useUnifiedCollection && (updatesToEntity.__owner || updatesToEntity.__appTable)) {
  //   return callback(new Error('Cannot update owner and apptable'))
  //   // todo - check for all with '_'??
  // } else 
  if (updateMultiple) {
    coll.updateMany(idOrQuery, { $set: updatesToEntity }, { safe: true })
      .then(response => {
        return callback(null, { success: true, nModified: response?.modifiedCount })
      })
      .catch(err => {
        felog('got err in write db 2  ', { collName, idOrQuery, err })
        return callback(err)
      })
      .finally(() => {
        client.close()
      })
  } else {
    coll.updateOne(idOrQuery, { $set: updatesToEntity }, { safe: true })
      .then(response => {
        return callback(null, { success: true, nModified: response?.modifiedCount })
      })
      .catch(err => {
        console.warn('got err in write in mongo db ', { collName, err })
        return callback(err)
      })
      .finally(() => {
        client.close()
      })
  }
}
MONGO_FOR_FREEZR.prototype.replace_record_by_id = function (id, updatedEntity, callback) {
  const [collName, client, coll] = getCollFrom(this)
  fdlog('in replace_record_by_id gort collName ', { collName, updatedEntity })
  const query = { _id: getRealObjectId(id) }
  if (this.env.dbParams.useUnifiedCollection) {
    query.__owner = this.oat.owner
    query.__appTable = fullOACName(this.oat, false)
    updatedEntity.__owner = this.oat.owner
    updatedEntity.__appTable = fullOACName(this.oat, false)
  }
  coll.replaceOne(query, updatedEntity, { safe: true })
    .then(response => {
      return callback(null, { success: true, nModified: response?.modifiedCount })
    })
    .catch(err => {
      console.warn('got err in replace_record_by_id in mongo db ', { collName, err })
      return callback(err)
    })
    .finally(() => {
      client.close()
    })
}
MONGO_FOR_FREEZR.prototype.query = function (idOrQuery, options = {}, callback) {
  const self = this
  fdlog('mongo query ', idOrQuery)
  let findMultiple = true
  if (!idOrQuery) {
    idOrQuery = {}
  } else if (typeof idOrQuery === 'string') {
    idOrQuery = { _id: getRealObjectId(idOrQuery) }
    findMultiple = false
  } else if (idOrQuery._id) {
    if (typeof (idOrQuery._id) === 'string') idOrQuery._id = getRealObjectId(idOrQuery._id)
    findMultiple = false
  }
  if (this.env.dbParams.useUnifiedCollection) {
    idOrQuery.__owner = this.oat.owner
    idOrQuery.__appTable = fullOACName(this.oat, false)
  }
  const [collName, client, coll] = getCollFrom(this)
  if (findMultiple) {
    coll.find(idOrQuery, options).sort(options.sort || null).limit(options.count || ARBITRARY_FIND_COUNT_DEFAULT).skip(options.skip || 0).toArray()
      .then(response => {
        const origLen = response.length
        if (self.env.dbParams.useUnifiedCollection) response = response.filter(r => { return r.__owner === self.oat.owner && r.__appTable === fullOACName(self.oat, false) })
        if (self.env.dbParams.useUnifiedCollection && origLen !== response.length) throw new Error('fetched other peoples data ;( ')
        return callback(null, response)
      })
      .catch(err => {
        console.warn('got err in query in mongodb db ', { collName, idOrQuery, err })
        return callback(err)
      })
      .finally(() => {
        client.close()
      })
  } else {
    coll.findOne(idOrQuery, options)
      .then(response => {
        if (response && self.env.dbParams.useUnifiedCollection && (response?.__owner !== self.oat.owner || response?.__appTable !== fullOACName(self.oat, false))) {
          return callback(new Error('mismach of __owner or _apptable'))
        } else {
          return callback(null, (response ? [response] : []))
        }
      })
      .catch(err => {
        console.warn('got err in query in mongodb db ', { collName, idOrQuery, err })
        return callback(err)
      })
      .finally(() => {
        client.close()
      })
  }
}
MONGO_FOR_FREEZR.prototype.delete_record = function (idOrQuery, options = {}, callback) {
  let deleteMultiple = true
  if (typeof idOrQuery === 'string') {
    idOrQuery = { _id: getRealObjectId(idOrQuery) }
    deleteMultiple = false
  } else if (idOrQuery._id && typeof idOrQuery._id === 'string') {
    idOrQuery._id = getRealObjectId(idOrQuery._id)
    deleteMultiple = false
  }
  const [collName, client, coll] = getCollFrom(this)
  if (this.env.dbParams.useUnifiedCollection) {
    idOrQuery.__owner = this.oat.owner
    idOrQuery.__appTable = fullOACName(this.oat, false)
  }
  fdlog('in delete_record got collName ', { collName })
  if (deleteMultiple) {
    coll.deleteMany(idOrQuery, { })
      .then(response => {
        return callback(null, { success: true, nModified: response?.deletedCount })
      })
      .catch(err => {
        console.warn('got err in delete in mongo db ', { collName, err })
        return callback(err)
      })
      .finally(() => {
        client.close()
      })
  } else {
    coll.deleteOne(idOrQuery, { })
      .then(response => {
        return callback(null, { success: true, nModified: response?.deletedCount })
      })
      .catch(err => {
        console.warn('got err in delete in mongo db ', { collName, err })
        return callback(err)
      })
      .finally(() => {
        client.close()
      })
  }
  // this.db.remove(idOrQuery, { multi: true }, cb)
}
MONGO_FOR_FREEZR.prototype.getAllAppTableNames = function (appOrTableNameOrNames, callback) {
  fdlog('app getAllAppTableNames in mongo' + appOrTableNameOrNames)

  const self = this
  const userId = this.oat.owner
  if (typeof appOrTableNameOrNames === 'string') appOrTableNameOrNames = [appOrTableNameOrNames]

  const appTablesFilter = function (dbList) {
    let list = []
    dbList.forEach(name => {
      let collName = name?.replace(/_/g, '.')
      if (name && helpers.startsWith(collName, userId)) {
        collName = collName.slice(userId.length + 2)
      }
      if (appOrTableNameOrNames) {
        appOrTableNameOrNames.forEach(requiredName => {
          if (helpers.startsWith(collName, requiredName)) list.push(collName)
        })
      } else {
        list.push(collName)
      }
    })
    list = list.filter((v, i, a) => a.indexOf(v) === i)
    return list
  }

  const [collName, client, coll, dbName, database] = getCollFrom(self)
  if (self.env.dbParams.useUnifiedCollection) {
    coll.distinct('__appTable', { __owner: self.oat.owner })
      .then(response => {
        return callback(null, appTablesFilter(response))
      })
      .catch(err => {
        console.warn('got err in getAllAppTableNames in mongo db ', { dbName, collName, err })
        return callback(err)
      })
      .finally(() => {
        client.close()
      })
  } else {
    // TODO _ To fix this
    fdlog('getAllAppTableNames mongo ', { userId, appOrTableNameOrNames })
    if (typeof appOrTableNameOrNames === 'string') appOrTableNameOrNames = [appOrTableNameOrNames]

    // database.getCollectionNames()
    database.listCollections().toArray()
      .then(response => {
        response = response.map(r => { return r.name })
        return callback(null, appTablesFilter(response))
      })
      .catch(err => {
        console.warn('got err in getCollectionNames in mongo db ', { err })
        return callback(err)
      })
      .finally(() => {
        client.close()
      })
  }
}
MONGO_FOR_FREEZR.prototype.stats = function (callback) {
  fdlog('mongo for freezr - stats ')
  const self = this
  const [collName, client, coll] = getCollFrom(self)
  if (this.env.dbParams.useUnifiedCollection) {
    const idOrQuery = { __owner: this.oat.owner, __appTable: fullOACName(self.oat, false) }
    const [collName, client, coll] = getCollFrom(self)
    const LIMIT = 1000
    const options = { size: 0, count: 0 }
    const iterateStats = function (options) {
      coll.find(idOrQuery).limit(LIMIT).skip(options.count).toArray()
        .then(response => {
          options.size += JSON.stringify(response).length
          options.count += response.length
          if (response.length < LIMIT) {
            client.close()
            return callback(null, { count: options.count, size: JSON.stringify(response).length })
          } else {
            return iterateStats(options)
          }
        })
        .catch(err => {
          console.warn('got err in query FOR STATS in mongodb db ', { collName, err })
          return callback(err)
        })
        // .finally(() => {
        // })
    }

    iterateStats(options)
  } else if (coll.stats) { // old versions of mongodb
    coll.stats()
      .then(response => {
        // return callback(null, response)
        fdlog('got mongo stats ', { response })
        return callback(null, { size: response.storageSize, originalStats: response })
      })
      .catch(err => {
        console.warn('got err in stats for mongo db ', { collName, err })
        return callback(err)
      })
      .finally(() => {
        client.close()
      })
  } else {
    // Code below doesnt work - need to fgure out 
    // coll.aggregate([{ $collStats: { storageStats: { } } }]).toArray()
    //   .then(stats => {
    //     console.log(stats);
    //     // You can access specific statistics like this:
    //     // For the size of the collection in bytes
    //     console.log("Size in bytes:", stats[0].storageStats.size)
    //     // For the count of documents in the collection
    //     console.log("all stats of documents:", stats[0].storageStats);
    //     return callback(null, stats[0].storageStats)
    //   }).catch(err => {
    //     console.error("An error occurred:", err);
    //   })
    //   .finally(() => {
    //     client.close()
    //   })

    //temporry inefficient method used:
    const idOrQuery = { }
    const [collName, client, coll] = getCollFrom(self)
    const LIMIT = 1000
    const options = { size: 0, count: 0 }
    const iterateStats = function (options) {
      coll.find(idOrQuery).limit(LIMIT).skip(options.count).toArray()
        .then(response => {
          options.size += JSON.stringify(response).length
          options.count += response.length
          if (response.length < LIMIT) {
            client.close()
            return callback(null, { count: options.count, size: JSON.stringify(response).length })
          } else {
            return iterateStats(options)
          }
        })
        .catch(err => {
          console.warn('got err in query FOR STATS in mongodb db ', { collName, err })
          return callback(err)
        })
        // .finally(() => {
        // })
    }

    iterateStats(options)
  }
}

MONGO_FOR_FREEZR.prototype.persistCachedDatabase = function (cb) {
  cb(null)
}

const fullOACName = function (ownerAppTable, addOwnerAtStart) { // addOwnerAtStart used for unified db
  fdlog('mongo - fullOACName ownerAppTable ', ownerAppTable)

  if (!ownerAppTable) throw felog('fullOACName', 'Mongp collection failure - need ownerAppTable')
  const appTable = ownerAppTable.app_table || (ownerAppTable.app_name + (ownerAppTable.collection_name ? ('_' + ownerAppTable.collection_name) : ''))
  if (!appTable || !ownerAppTable.owner) throw helpers.error('Mongo collection failure - need app name and an owner for ' + ownerAppTable.owner + '__' + ownerAppTable.app_name + '_' + ownerAppTable.collection_name)
  return ((addOwnerAtStart ? (ownerAppTable.owner + '__') : '') + appTable).replace(/\./g, '_')
}
const dbConnectionString = function (envParams) {
  fdlog('mongo - dbConnectionString envParams ', envParams)
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

  // const DEFAULT_UNIFIED_DB_NAME = 'freezrdb'
  // const unfiedDbName = envParams.dbParams.unifiedDbName || DEFAULT_UNIFIED_DB_NAME

  // console.log('NEED TO Check maxIdleTimeMS todo?')
  if (envParams.dbParams.connectionString) {
    let connectionString = envParams.dbParams.connectionString + '&authSource=admin'
    if (connectionString.indexOf('ssl=true') < 0) connectionString += '&ssl=true'
    if (connectionString.indexOf('maxIdleTimeMS') < 0) connectionString += '&maxIdleTimeMS=30000'
    // return envParams.dbParams.connectionString + '&authSource=admin' // &useUnifiedTopology=true
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
  // called after initiation for some systems. neb doesnt need This
  let realId = objectId
  if (typeof objectId === 'string') {
    try {
      realId = new ObjectId(objectId)
    } catch (e) {
      fdlog('getRealObjectId', 'Could not get mongo real_id - using text id for ' + objectId)
    }
  }
  return realId
}
const UNIFIED_COLLECTION_NAME = 'allUserAppData'
const DEFAULT_UNIFIED_DB_NAME = 'freezrdb'
const getCollFrom = function (self) {
  const uri = dbConnectionString(self.env)
  const client = new MongoClient(uri)
  // note self.env.dbParams.unifiedDbName is legacy and no longer used
  const useUnifiedDbName = self.env.dbParams.useUnifiedCollection || self.env.dbParams.unifiedDbName || !self.env.dbParams.useUserIdsAsDbName
  const dbName = useUnifiedDbName
    ? (process?.env?.UNIFIED_DB_NAME || self.env.dbParams.unifiedDbName || DEFAULT_UNIFIED_DB_NAME)
    : self.oat.owner
  // previously from string: uri.slice(uri.lastIndexOf('/') + 1, (uri.indexOf('?') >= 0 ? uri.indexOf('?') : uri.length))
  const database = client.db(dbName)
  const useUnifiedCollName = (self.env.dbParams.useUnifiedCollection && helpers.RESERVED_IDS.indexOf(self.oat.owner) < 0) //  !helpers.is_system_app(self.oat.app_table || self.oat.app_name))
  const collName = useUnifiedCollName
    ? UNIFIED_COLLECTION_NAME
    : fullOACName(self.oat, useUnifiedDbName) // (useUnifiedCollName ? false : (!self.env.dbParams.useUserIdsAsDbName && !helpers.is_system_app(self.oat.app_table || self.oat.app_name))))
  fdlog('got mongo uri ', { uri, OAT: self.oat, useUnifiedDbName, dbName, useUnifiedCollName, collName, systemapp: helpers.is_system_app(self.oat.app_table || self.oat.app_name) })
  return [collName, client, database.collection(collName), dbName, database]
}

// Logger
const LOG_ERRORS = true
const felog = function (...args) { if (LOG_ERRORS) helpers.warning('dbApi_mongodb.js', exports.version, ...args) }
const LOG_DEBUGS = false
const fdlog = function (...args) { if (LOG_DEBUGS) console.log(...args) }

// Interface
module.exports = MONGO_FOR_FREEZR
