// freezr.info - dbApi_mongodb,js
// API for accessing mongodb databases

// todo - add createDb to add db paramters (as per CEPS)

exports.version = '0.0.200'

const helpers = require('../helpers.js')
const MongoClient = require('mongodb').MongoClient
const ObjectID = require('mongodb').ObjectID
const async = require('async')

const ARBITRARY_FIND_COUNT_DEFAULT = 100

function MONGO_FOR_FREEZR (environment, ownerAppTable) {
  // Note: environment must have dbParams
  fdlog('MONGO_FOR_FREEZR ', { environment, ownerAppTable })
  fdlog('todo - need to do checks to make sure oat exists and env exists')

  this.env = environment
  this.oat = ownerAppTable

  this.dbname = fullOACName(ownerAppTable) + '.db'
}

MONGO_FOR_FREEZR.prototype.initDB = function (callback) {
  fdlog('in mongo db', this.env)
  const mongoFreezr = this
  var dbName = fullOACName(this.oat)
  async.waterfall([
    // open database connection
    function (cb) {
      MongoClient.connect(dbConnectionString(mongoFreezr.env), cb)
    },
    // create a collection for users user_installed_app_list, user_devices, permissions.
    function (theclient, cb) {
      const unifiedDb = theclient.db(theclient.s.options.dbName)
      unifiedDb.collection(dbName, cb)
    }
  ], function (err, collection) {
    if (err) felog('initDB', 'error getting ' + dbName + ' in initDb for mongo', err)
    mongoFreezr.db = collection
    callback(err)
  })
}
MONGO_FOR_FREEZR.prototype.read_by_id = function (id, callback) {
  this.db.find({ _id: getRealObjectId(id) }).toArray((err, results) => {
    let object = null
    if (err) {
      felog('read_by_id', 'error getting object for ' + this.ownerAppTable.app_name + ' or ' + this.ownerAppTable.app_table + ' id:' + id + ' in read_by_id')
      helpers.state_error('dbApi_mongodb', exports.version, 'read_by_id', err, 'error getting object for ' + this.oat.app_name + ' / ' + this.oat.app_table + ' id:' + id + ' in read_by_id')
    } else if (results && results.length > 0) {
      object = results[0]
    }
    fdlog('mongo read by id results ', { results, object })
    callback(err, object)
  })
}
MONGO_FOR_FREEZR.prototype.create = function (id, entity, options, cb) {
  fdlog('dbApi_mongodb Create entity ', { entity } )
  if (id) entity._id = getRealObjectId(id)
  this.db.insert(entity, { w: 1, safe: true }, (err, returns) => {
    // newDoc is the newly inserted document, including its _id
    fdlog('check returns from mongo ', { returns })
    if (err) {
      cb(err)
    } else {
      const _id = (returns && returns.insertedIds && returns.insertedIds['0']) ? returns.insertedIds['0'] : null
      cb(null, { success: true, _id })
    }
  })
}
MONGO_FOR_FREEZR.prototype.query = function (query, options = {}, cb) {
  fdlog('mongo query ', query)
  if (!query) {
    query = {}
  } else if (typeof query === 'string') {
    query = { _id: getRealObjectId(query) }
  } else if (query._id && typeof (query._id) === 'string') {
    query._id = getRealObjectId(query._id)
  }
  this.db.find(query)
    .sort(options.sort || null)
    .limit(options.count || ARBITRARY_FIND_COUNT_DEFAULT)
    .skip(options.skip || 0)
    .toArray(cb)
}
MONGO_FOR_FREEZR.prototype.update_multi_records = function (idOrQuery, updatesToEntity, cb) {
  if (typeof idOrQuery === 'string') {
    idOrQuery = { _id: getRealObjectId(idOrQuery) }
  } else if (ObjectID.isValid(idOrQuery)) {
    idOrQuery = { _id: getRealObjectId(idOrQuery) }
  } else if (idOrQuery._id && typeof idOrQuery._id === 'string') {
    idOrQuery._id = getRealObjectId(idOrQuery._id)
  } else if (idOrQuery.$and || idOrQuery.$or) {
    felog('currently cannot do $and and $or of _ids - need to add objectIds iteratively')
  }
  this.db.update(idOrQuery, { $set: updatesToEntity }, { safe: true, multi: true }, function (err, rets) {
    const num = (rets && rets.result && rets.result.nModified) ? rets.result.nModified : null
    fdlog('Mongo update results ', { err, num, updatesToEntity })
    if (err) felog('Mongo update results - errb', { err, num, updatesToEntity })
    cb(err, { nModified: num })
  })
}
MONGO_FOR_FREEZR.prototype.replace_record_by_id = function (id, updatedEntity, cb) {
  this.db.update({ _id: getRealObjectId(id) }, updatedEntity, { safe: true, multi: false }, function (err, rets) {
    const num = (rets && rets.result && rets.result.nModified) ? rets.result.nModified : null
    fdlog('Mongo replace_record_by_id results', { err, num, updatedEntity })
    if (err) felog('Mongo replace_record_by_id results - ', { err, num, updatedEntity })
    cb(err, { nModified: num })
  })
}

MONGO_FOR_FREEZR.prototype.delete_record = function (idOrQuery, options = {}, cb) {
  if (typeof idOrQuery === 'string') {
    idOrQuery = { _id: getRealObjectId(idOrQuery) }
  } else if (idOrQuery._id && typeof idOrQuery._id === 'string') {
    idOrQuery._id = getRealObjectId(idOrQuery._id)
  }
  this.db.remove(idOrQuery, { multi: true }, cb)
}

MONGO_FOR_FREEZR.prototype.getAllAppTableNames = function (appOrTableNameOrNames, callback) {
  fdlog('todo - mongo - need to make this consistent across mongo and nedb - appOrTableNameOrNames NEEDS TO BE A LIST')
  const userId = this.oat.owner
  const mongoFreezr = this
  var theMongoClient
  async.waterfall([
    // open database connection
    function (cb) {
      if (!appOrTableNameOrNames || appOrTableNameOrNames.length === 0) {
        cb(new Error('cannot get colelction list for empty field'))
      } else {
        MongoClient.connect(dbConnectionString(mongoFreezr.env), cb)
      }
    },
    // create collections for users user_installed_app_list, user_devices, permissions.
    function (theclient, cb) {
      theMongoClient = theclient
      const unifiedDb = theclient.db(theclient.s.options.dbName)
      unifiedDb.listCollections().toArray(cb)
    }
  ], function (err, nameObjList) {
    if (err) felog('getAllAppTableNames', 'error getting nameObjList in initDb for mongo', err)

    var collectionNames = []

    if (!err && nameObjList && nameObjList.length > 0) {
      theMongoClient.close()
      if (typeof appOrTableNameOrNames === 'string') appOrTableNameOrNames = [appOrTableNameOrNames]

      nameObjList.forEach(function (mongoNameObj) {
        const mongoFileName = mongoNameObj.name
        if (mongoFileName && mongoFileName !== 'system') {
          appOrTableNameOrNames.forEach(appTableName => {
            if (appTableName) {
              appTableName = appTableName.replace(/\./g, '_')
              if (helpers.startsWith(mongoFileName, userId + '__' + appTableName)) {
                // fdlog('adding mongoFileName ', mongoFileName, mongoFileName.slice(userId.length + 2).replace(/_/g, '.'))
                collectionNames.push(mongoFileName.slice(userId.length + 2).replace(/_/g, '.'))
              }
            }
          })
        }
      })
    }
    callback(err, collectionNames)
  })
}

MONGO_FOR_FREEZR.prototype.persistCachedDatabase = function (cb) {
  cb(null)
}

const fullOACName = function (ownerAppTable) {
  fdlog('mongo - fullOACName ownerAppTable ', ownerAppTable)

  if (!ownerAppTable) throw felog('fullOACName', 'NEDB collection failure - need ownerAppTable')
  const appTable = ownerAppTable.app_table || (ownerAppTable.app_name + (ownerAppTable.collection_name ? ('_' + ownerAppTable.collection_name) : ''))
  if (!appTable || !ownerAppTable.owner) throw helpers.error('NEDB collection failure - need app name and an owner for ' + ownerAppTable.owner + '__' + ownerAppTable.app_name + '_' + ownerAppTable.collection_name)
  return (ownerAppTable.owner + '__' + appTable).replace(/\./g, '_')
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
  const DEFAULT_UNIFIED_DB_NAME = 'freezrdb'
  const unfiedDbName = envParams.dbParams.unifiedDbName || DEFAULT_UNIFIED_DB_NAME

  // console.log('NEED TO Check maxIdleTimeMS')
  if (envParams.dbParams.connectionString) {
    return envParams.dbParams.connectionString + '&authSource=admin&useUnifiedTopology=true&maxIdleTimeMS=30000'
  } else if (envParams.dbParams.mongoString) {
    return envParams.dbParams.mongoString + '&authSource=admin&useUnifiedTopology=true&maxIdleTimeMS=30000'
  } else {
    let connectionString = 'mongodb://'
    if (envParams.dbParams.user) connectionString += envParams.dbParams.user + ':' + envParams.dbParams.pass + '@'
    connectionString += envParams.dbParams.host + ':' + (envParams.dbParams.host === 'localhost' ? '' : envParams.dbParams.port)
    connectionString += '/' + unfiedDbName + (envParams.dbParams.notAddAuth ? '' : '?authSource=admin&maxIdleTimeMS=30000')
    return connectionString
  }
}
const getRealObjectId = function (objectId) {
  // called after initiation for some systems. neb doesnt need This
  var realId = objectId
  if (typeof objectId === 'string') {
    try {
      realId = new ObjectID(objectId)
    } catch (e) {
      fdlog('getRealObjectId', 'Could not get mongo real_id - using text id for ' + objectId)
    }
  }
  return realId
}

// Logger
const LOG_ERRORS = true
const felog = function (...args) { if (LOG_ERRORS) helpers.warning('dbApi_mongodb.js', exports.version, ...args) }
const LOG_DEBUGS = false
const fdlog = function (...args) { if (LOG_DEBUGS) console.log(...args) }

// Interface
module.exports = MONGO_FOR_FREEZR
