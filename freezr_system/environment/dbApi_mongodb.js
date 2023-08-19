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

  // this.dbname = fullOACName(ownerAppTable) + '.db'
}

MONGO_FOR_FREEZR.prototype.initDB = function (callback) {
  callback(null)
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
  coll.findOne({ _id: getRealObjectId(id) })
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
  coll.insertOne(entity)
    .then(response => {
      const theId = response?.insertedId
      return callback(null, { success: true, _id: theId })
    })
    .catch(err => {
      console.warn('got err in write db ', { collName, err })
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
  // } else if (ObjectID.isValid(idOrQuery)) {
  //   updateMultiple = false
  //   idOrQuery = { _id: getRealObjectId(idOrQuery) }
  } else if (idOrQuery._id && typeof idOrQuery._id === 'string') { // nb also ignores additional conditions in query
    updateMultiple = false
    idOrQuery._id = getRealObjectId(idOrQuery._id)
  } else if (idOrQuery.$and || idOrQuery.$or) {
    felog('currently cannot do $and and $or of _ids - need to add objectIds iteratively [???]')
  }
  const [collName, client, coll] = getCollFrom(this)
  fdlog('in update_multi_records gort collName ', { collName })
  if (updateMultiple) {
    coll.updateMany(idOrQuery, { $set: updatesToEntity }, { safe: true })
      .then(response => {
        return callback(null, { success: true, nModified: response?.modifiedCount })
      })
      .catch(err => {
        console.warn('got err in write db ', { collName, err })
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
  coll.replaceOne({ _id: getRealObjectId(id) }, updatedEntity, { safe: true })
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
  const [collName, client, coll] = getCollFrom(this)
  if (findMultiple) {
    coll.find(idOrQuery, options).sort(options.sort || null).limit(options.count || ARBITRARY_FIND_COUNT_DEFAULT).skip(options.skip || 0).toArray()
      .then(response => {
        if (findMultiple) {
          return callback(null, response)
        } else {
          return callback(null, (response ? [response] : []))
        }
      })
      .catch(err => {
        console.warn('got err in query in mongodb db ', { collName, err })
        return callback(err)
      })
      .finally(() => {
        client.close()
      })
  } else {
    coll.findOne(idOrQuery, options)
      .then(response => {
        return callback(null, (response ? [response] : []))
      })
      .catch(err => {
        console.warn('got err in query in mongodb db ', { collName, err })
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
  fdlog('app getAllAppTableNames in mongo')

  const uri = dbConnectionString(this.env)
  const client = new MongoClient(uri)
  const dbName = uri.slice(uri.lastIndexOf('/') + 1, (uri.indexOf('?') >= 0 ? uri.indexOf('?') : uri.length)) || this.oat.owner
  const database = client.db(dbName)
  const userId = this.oat.owner

  fdlog('getAllAppTableNames mongo ', { userId, appOrTableNameOrNames})
  if (typeof appOrTableNameOrNames === 'string') appOrTableNameOrNames = [appOrTableNameOrNames]

  // database.getCollectionNames()
  database.listCollections().toArray()
    .then(dbObjects => {
      let list = []
      fdlog(' got db objects ' + JSON.stringify(dbObjects))
      dbObjects.forEach(dbObject => {
        let collName = dbObject.name.replace(/\_/g, '.')
        if (helpers.startsWith(collName, userId)) {
          collName = collName.slice(userId.length + 2)
          if (appOrTableNameOrNames) {
            appOrTableNameOrNames.forEach(requiredName => {
              if (helpers.startsWith(collName, requiredName)) list.push(collName)
            })
          } else {
            list.push(collName)
          }
        }
      })
      list = list.filter((v, i, a) => a.indexOf(v) === i)
      return callback(null, list)
    })
    .catch(err => {
      console.warn('got err in getCollectionNames in mongo db ', { err })
      return callback(err)
    })
    .finally(() => {
      client.close()
    })
}
MONGO_FOR_FREEZR.prototype.stats = function (callback) {
  fdlog('mongo for freezr - stats ')
  const [collName, client, coll] = getCollFrom(this)
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
}

MONGO_FOR_FREEZR.prototype.persistCachedDatabase = function (cb) {
  cb(null)
}

const fullOACName = function (ownerAppTable, unifiedDb) {
  fdlog('mongo - fullOACName ownerAppTable ', ownerAppTable)

  if (!ownerAppTable) throw felog('fullOACName', 'NEDB collection failure - need ownerAppTable')
  const appTable = ownerAppTable.app_table || (ownerAppTable.app_name + (ownerAppTable.collection_name ? ('_' + ownerAppTable.collection_name) : ''))
  if (!appTable || !ownerAppTable.owner) throw helpers.error('NEDB collection failure - need app name and an owner for ' + ownerAppTable.owner + '__' + ownerAppTable.app_name + '_' + ownerAppTable.collection_name)
  return ((unifiedDb ? (ownerAppTable.owner + '__') : '') + appTable).replace(/\./g, '_')
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
      notAddAuth: true,
      unifiedDbName: null
    }
  }

  // const DEFAULT_UNIFIED_DB_NAME = 'freezrdb'
  // const unfiedDbName = envParams.dbParams.unifiedDbName || DEFAULT_UNIFIED_DB_NAME

  // console.log('NEED TO Check maxIdleTimeMS todo?')
  if (envParams.dbParams.connectionString) {
    return envParams.dbParams.connectionString + '&authSource=admin&ssl=true&maxIdleTimeMS=30000' // &useUnifiedTopology=true
  } else if (envParams.dbParams.mongoString) {
    return envParams.dbParams.mongoString + '&authSource=admin&ssl=true&maxIdleTimeMS=30000' // &useUnifiedTopology=true
  } else {
    let connectionString = 'mongodb://'
    if (envParams.dbParams.user) connectionString += envParams.dbParams.user + ':' + envParams.dbParams.pass + '@'
    connectionString += envParams.dbParams.host + ':' + (envParams.dbParams.host === 'localhost' ? '' : envParams.dbParams.port)
    connectionString += '/' + (envParams.dbParams.notAddAuth ? '?' : '?authSource=admin&')
    connectionString += 'ssl=true&maxIdleTimeMS=30000'
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
const getCollFrom = function (self) {
  const uri = dbConnectionString(self.env)
  const client = new MongoClient(uri)
  const forceNonUnifiedDbName = self.env?.dbParams?.useIdsAsDbName
  const unifiedDbName = forceNonUnifiedDbName ? null : uri.slice(uri.lastIndexOf('/') + 1, (uri.indexOf('?') >= 0 ? uri.indexOf('?') : uri.length))
  const dbName = unifiedDbName || self.oat.owner
  const database = client.db(dbName)
  const collName = fullOACName(self.oat, unifiedDbName)
  return [collName, client, database.collection(collName)]
}
// Logger
const LOG_ERRORS = true
const felog = function (...args) { if (LOG_ERRORS) helpers.warning('dbApi_mongodb.js', exports.version, ...args) }
const LOG_DEBUGS = false
const fdlog = function (...args) { if (LOG_DEBUGS) console.log(...args) }

// Interface
module.exports = MONGO_FOR_FREEZR
