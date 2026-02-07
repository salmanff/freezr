// freezr.info - dbApi_nedb.mjs
// API for accessing nedb databases (MODERNIZED TO ES6 MODULES)

// todo - add createDb to add db paramters (as per CEPS)

import Datastore from 'nedb-asyncfs'
import config from '../../../common/helpers/config.mjs'
import { startsWith, removeLastPathElement } from '../../../common/helpers/utils.mjs'

export const version = '0.0.200'

const ARBITRARY_FIND_COUNT_DEFAULT = 100

// Helper functions (temporary - should be moved to common helpers)
const error = (message) => {
  throw new Error(message)
}

function NEDB_FOR_FREEZR (environment, ownerAppTable) {
  // Note: environment must have dbParams and fsParams - eg
  // fsParams: "type":"local","userRoot":null
  // fsParams: "fsParams":{"type":"aws","region":"eu-central-1","accessKeyId":"XXXXX","secretAccessKey":"XXXX","bucket":"XXX"}
  // dbParams: "type":"nedb","db_path":"userDB"
  // nedb make sure nedb takes a new userRoot to figure out directory to install in

  // ('todo - need to do checks to make sure oat exists and env exists')

  this.env = environment
  this.oat = ownerAppTable
}

NEDB_FOR_FREEZR.prototype.initDB = function (callback) {
  // called after initiation at the user level. returns a db object if need be. (not all systems need it and not all return an object. Object is stored in userDS as unififedDb)
  const { dbParams, fsParams, extraCreds } = this.env

  const self = this
  let customFS = null
  // const type =

  // Use async IIFE to handle dynamic imports
  ;(async () => {
    try {
      if (fsParams.type !== 'local') {
        // Use modern ES6 dynamic import for cloud file systems
        const { cloudFS } = await import('../fsConnectors/dbfs_' + fsParams.type + '.mjs')
        customFS = new cloudFS(fsParams, { doNotPersistOnLoad: true, extraCreds })
      }

      if (fsParams.type !== 'local' && !customFS) {
        throw new Error('Error retrieving environment for nedb-asyncfs, using storage of type ' + fsParams.type)
      } else {
        const filename = (dbParams.db_path ? (dbParams.db_path + '/') : '') +
        (fsParams.rootFolder || config.FREEZR_USER_FILES_DIR) + '/' +
        self.oat.owner + '/db/' + fullName(self.oat) + '.db'

        // onsole.log('NEDB_FOR_FREEZR ', { dbParams, fsParams, filename, havecystomfs: !!customFS }, 'oat:', self.oat)

        self.db = new Datastore({ filename, customFS }, { doNotPersistOnLoad: true })
        if (self.db.customFS.initFS) {
          self.db.customFS.initFS(function (err) {
            if (err) {
              console.error('Error initialising nedb-asyncfs - code: ', err?.code, ' - err.message:', err.message, ' - name ', err?.name )
              callback(err)
            } else {
              return self.db.loadDatabase(callback)
            }
          })
        } else {
          return self.db.loadDatabase(callback)
        }
      }
    } catch (err) {
      console.error('Error in initDB async logic:', err)
      callback(err)
    }
  })()
}
NEDB_FOR_FREEZR.prototype.read_by_id = function (id, callback) {
  // called after initiation for some systems. Drobox doesnt need This
  this.db.find({ _id: id }, (err, results) => {
    let object = null
    if (err) {
      // TO helpers.error
      console.warn('read_by_id', 'error getting object for ' + this.ownerAppTable.app_name + ' or ' + this.ownerAppTable.app_table + ' id:' + id + ' in read_by_id')
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
  // log('nedb query ', query)
  this.db.find(query)
    .sort(options.sort || null)
    .limit(options.count || options.limit || ARBITRARY_FIND_COUNT_DEFAULT)
    .skip(options.skip || 0)
    .exec(cb)
    // .exec(function (err, results) {
    //   console.log('got nedb_for_frezr  ', { err, reslen: results.length })
    //   cb(err, results)
    // })
}
NEDB_FOR_FREEZR.prototype.update_multi_records = function (idOrQuery, updatesToEntity, cb) {
  if (typeof idOrQuery === 'string') idOrQuery = { _id: idOrQuery }
  this.db.update(idOrQuery, { $set: updatesToEntity }, { safe: true, multi: true }, function (err, num) {
    // console.log('new_db_nedb update results ', { err, num, updatesToEntity })
    cb(err, { nModified: num })
  })
}
NEDB_FOR_FREEZR.prototype.replace_record_by_id = function (entityId, updatedEntity, callback) {
  this.db.update({ _id: entityId }, updatedEntity, { safe: true, multi: false }, callback)
}
NEDB_FOR_FREEZR.prototype.delete_record = function (idOrQuery, options = {}, cb) {
  if (typeof idOrQuery === 'string') idOrQuery = { _id: idOrQuery }
  // console.log('      🔑 nedb for freezr - delete record', { idOrQuery, options })
  this.db.remove(idOrQuery, { multi: true }, function (err, num) {
    cb(err, { nRemoved: num })
  })
}
NEDB_FOR_FREEZR.prototype.createIndex = function (indexParams, indexOptions, callback) {
  // FOR TESTIG ONLY
  callback(null)
}
NEDB_FOR_FREEZR.prototype.getAllAppTableNames = function (appOrTableNameOrNames, callback) {
  // console.log('getAllAppTableNames nedb ', appOrTableNameOrNames)
  const userId = this.oat.owner
  const dbPath = (this.env.fsParams.rootFolder || config.FREEZR_USER_FILES_DIR) + '/' + userId + '/db'
  let list = []
  if (typeof appOrTableNameOrNames === 'string') appOrTableNameOrNames = [appOrTableNameOrNames]
  this.db.customFS.readdir(dbPath, null, (err, files) => {
    // console.log('read fs ', { files, err })
    if (!err) {
      files.forEach(file => {
        if (file.indexOf('/') > 0) { // dropbox??
          const parts = file.split('/')
          parts.shift()
          parts.shift()
          parts.shift()
          file = parts.join('/')
        }
        if (appOrTableNameOrNames) {
          appOrTableNameOrNames.forEach(name => {
            name = name.replace(/\./g, '_')
            const hasdb = file.substring(file.length - 3) === '.db'
            if (startsWith(file, name)) {
              list.push(file.slice(0, file.length - (hasdb ? 3 : 0)).replace(/_/g, '.'))
            } else if (startsWith(file, '~' + name)) {
              list.push(file.substring(1, file.length - (hasdb ? 3 : 0)).replace(/_/g, '.'))
            }
            // https://stackoverflow.com/questions/1960473/get-all-unique-values-in-a-javascript-array-remove-duplicates
          })
        } else {
          list.push(file)
        }
      })
    }
    list = list.filter((v, i, a) => a.indexOf(v) === i)
    callback(null, list)
  })
}
NEDB_FOR_FREEZR.prototype.stats = function (callback) {
  // console.log('nedb for freezr - stats ')
  const { dbParams, fsParams } = this.env
  const self2 = this
  const filePath = (dbParams.db_path ? (dbParams.db_path + '/') : '') +
    (fsParams.rootFolder || config.FREEZR_USER_FILES_DIR) + '/' +
    this.oat.owner + '/db/' + fullName(this.oat) + '.db'
  self2.db.customFS.size(filePath, function (err, size) {
    if (err) size = 'n/a'
    callback(err, { size, originalStats: null })
    // if (self2.db.count) {
    // self2.db.count({}, function (err, count) {
    //     if (err|| !count) count = 'n/a'
    //     callback(err, { size, count, originalStats: null })
    //   })
    // } else {
    //   callback(null, { size, count: 'n/a', originalStats: null })
    // }
  })
}

NEDB_FOR_FREEZR.prototype.persistCachedDatabase = function (cb) {
  this.db.persistence.persistCachedDatabase(cb)
}
const fullName = function (ownerAppTable) {
  // console.log("fullName ownerAppTable ", ownerAppTable)
  if (!ownerAppTable) throw error('NEDB collection failure - need ownerAppTable ')
  const appTable = ownerAppTable.app_table || (ownerAppTable.app_name + (ownerAppTable.collection_name ? ('_' + ownerAppTable.collection_name) : ''))
  if (!appTable || !ownerAppTable.owner) throw error('NEDB collection failure - need app name and an owner for ' + ownerAppTable.owner + '__' + ownerAppTable.app_name + '_' + ownerAppTable.collection_name)
  return appTable.replace(/\./g, '_')
}

// Interface
export default NEDB_FOR_FREEZR
