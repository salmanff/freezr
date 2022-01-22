// freezr.info - dbApi_mongodb,js
// API for accessing nedb databases

// todo - add createDb to add db paramters (as per CEPS)

exports.version = '0.0.200'

const Datastore = require('nedb-asyncfs')
const helpers = require('../helpers.js')

const ARBITRARY_FIND_COUNT_DEFAULT = 100

function NEDB_FOR_FREEZR (environment, ownerAppTable) {
  // Note: environment must have dbParams and fsParams - eg
  // fsParams: "type":"local","userRoot":null
  // fsParams: "fsParams":{"type":"aws","region":"eu-central-1","accessKeyId":"XXXXX","secretAccessKey":"XXXX","bucket":"XXX"}
  // dbParams: "type":"nedb","db_path":"userDB"
  // nedb make sure nedb takes a new userRoot to figure out directory to install in

  fdlog('NEDB_FOR_FREEZR ', { environment, ownerAppTable })
  fdlog('todo - need to do checks to make sure oat exists and env exists')

  this.env = environment
  this.oat = ownerAppTable
}

NEDB_FOR_FREEZR.prototype.initDB = function (callback) {
  // called after initiation at the user level. returns a db object if need be. (not all systems need it and not all return an object. Object is stored in userDS as unififedDb)
  const { dbParams, fsParams } = this.env

  const self = this
  var customFS = null
  // const type =

  if (fsParams.type !== 'local') {
    const envdir = helpers.removeLastpathElement(__dirname, 2) + '/node_modules/nedb-asyncfs/env/'
    const CustomFS = require(envdir + 'dbfs_' + fsParams.type + '.js')
    customFS = new CustomFS(fsParams, { doNotPersistOnLoad: true })
  }
  if (fsParams.type !== 'local' && !customFS) {
    throw new Error('Error retrieving environment for nedb-asyncfs, using storage of type ' + fsParams.type)
  } else {
    const filename = (dbParams.db_path ? (dbParams.db_path + '/') : '') +
      (fsParams.rootFolder || helpers.FREEZR_USER_FILES_DIR) + '/' +
      this.oat.owner + '/db/' + fullName(this.oat) + '.db'

    fdlog('NEDB_FOR_FREEZR ', { dbParams, fsParams, filename }, 'oat:', this.oat)

    self.db = new Datastore({ filename, customFS }, { doNotPersistOnLoad: true })
    self.db.loadDatabase(function (err) {
      if (err) {
        return callback(err)
      } else {
        if (self.db.customFS.initFS) {
          return self.db.customFS.initFS(callback)
        } else {
          return callback(null)
        }
      }
    })
  }
}
NEDB_FOR_FREEZR.prototype.read_by_id = function (id, callback) {
  // called after initiation for some systems. Drobox doesnt need This
  this.db.find({ _id: id }, (err, results) => {
    let object = null
    if (err) {
      // TO helpers.error
      felog('read_by_id', 'error getting object for ' + this.ownerAppTable.app_name + ' or ' + this.ownerAppTable.app_table + ' id:' + id + ' in read_by_id')
    } else if (results && results.length > 0) {
      object = results[0]
    }
    callback(err, object)
  })
}
NEDB_FOR_FREEZR.prototype.create = function (id, entity, options, cb) {
  // onsole.log('db_env_nedb Create entity',new Date().toLocaleTimeString() + " : " + new Date().getMilliseconds())
  if (id) entity._id = id
  this.db.insert(entity, function (err, returns) {
    if (err) {
      cb(err)
    } else {
      const _id = (returns && returns._id) ? returns._id : null
      cb(null, { success: true, _id })
    }
  })
}
NEDB_FOR_FREEZR.prototype.query = function (query, options = {}, cb) {
  fdlog('nedb query ', query)
  this.db.find(query)
    .sort(options.sort || null)
    .limit(options.count || ARBITRARY_FIND_COUNT_DEFAULT)
    .skip(options.skip || 0)
    .exec(cb)
}
NEDB_FOR_FREEZR.prototype.update_multi_records = function (idOrQuery, updatesToEntity, cb) {
  if (typeof idOrQuery === 'string') idOrQuery = { _id: idOrQuery }
  this.db.update(idOrQuery, { $set: updatesToEntity }, { safe: true, multi: true }, function (err, num) {
    // fdlog('new_db_nedb update results ', { err, num, updatesToEntity })
    cb(err, { nModified: num })
  })
}

NEDB_FOR_FREEZR.prototype.replace_record_by_id = function (entityId, updatedEntity, callback) {
  this.db.update({ _id: entityId }, updatedEntity, { safe: true, multi: false }, callback)
}

NEDB_FOR_FREEZR.prototype.delete_record = function (idOrQuery, options = {}, cb) {
  if (typeof idOrQuery === 'string') idOrQuery = { _id: idOrQuery }
  // fdlog('nedb for freezr - delete record')
  this.db.remove(idOrQuery, { multi: true }, cb)
}

NEDB_FOR_FREEZR.prototype.getAllAppTableNames = function (appOrTableNameOrNames, callback) {
  fdlog('getAllAppTableNames nedb ', appOrTableNameOrNames)
  const userId = this.oat.owner
  const dbPath = (this.env.fsParams.rootFolder || helpers.FREEZR_USER_FILES_DIR) + '/' + userId + '/db'
  var list = []
  if (typeof appOrTableNameOrNames === 'string') appOrTableNameOrNames = [appOrTableNameOrNames]
  this.db.customFS.readdir(dbPath, (err, files) => {
    // fdlog('read fs ', { files, err })
    if (!err) {
      files.forEach(file => {
        if (file.indexOf('/') > 0) { // dropbox??
          var parts = file.split('/')
          parts.shift()
          parts.shift()
          parts.shift()
          file = parts.join('/')
        }
        appOrTableNameOrNames.forEach(name => {
          name = name.replace(/\./g, '_')
          const hasdb = file.substring(file.length - 3) === '.db'
          if (helpers.startsWith(file, name)) {
            list.push(file.slice(0, file.length - (hasdb ? 3 : 0)).replace(/_/g, '.'))
          } else if (helpers.startsWith(file, '~' + name)) {
            list.push(file.substring(1, file.length - (hasdb ? 3 : 0)).replace(/_/g, '.'))
          }
          // https://stackoverflow.com/questions/1960473/get-all-unique-values-in-a-javascript-array-remove-duplicates
        })
      })
    }
    list = list.filter((v, i, a) => a.indexOf(v) === i)
    callback(null, list)
  })
}

NEDB_FOR_FREEZR.prototype.persistCachedDatabase = function (cb) {
  this.db.persistence.persistCachedDatabase(cb)
}

const fullName = function (ownerAppTable) {
  // fdlog("fullName ownerAppTable ", ownerAppTable)
  if (!ownerAppTable) throw helpers.error('NEDB collection failure - need ownerAppTable ')
  const appTable = ownerAppTable.app_table || (ownerAppTable.app_name + (ownerAppTable.collection_name ? ('_' + ownerAppTable.collection_name) : ''))
  if (!appTable || !ownerAppTable.owner) throw helpers.error('NEDB collection failure - need app name and an owner for ' + ownerAppTable.owner + '__' + ownerAppTable.app_name + '_' + ownerAppTable.collection_name)
  return appTable.replace(/\./g, '_')
}

// Logger
const LOG_ERRORS = true
const felog = function (...args) { if (LOG_ERRORS) helpers.warning('dbApi_nedb.js', exports.version, ...args) }
const LOG_DEBUGS = false
const fdlog = function (...args) { if (LOG_DEBUGS) console.log(...args) }

// Interface
module.exports = NEDB_FOR_FREEZR
