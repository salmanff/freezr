// data store manager - ds_manager.js

const async = require('async')
const helpers = require('./helpers.js')
const path = require('path')
const fs = require('fs')
const mkdirp = require('mkdirp')

exports.version = '0.0.200'

// const SYSTEM_COLLS = ['params','users','app_tokens','visit_log_daysum']
// const SYSTEM_APPS = SYSTEM_COLLS.map(coll => 'fradmin__info_freezr_admin_'+coll)

const DB_PERSISTANCE_IDLE_TIME_THRESHOLD = 60 * 1000 // (= 1 minute)
const DB_CHANGE_COUNT_THRESHOLD = 50

function DATA_STORE_MANAGER () {
  this.freezrIsSetup = false
  this.users = {} // each a USER_DS
}
function USER_DS (owner, env) {
  const self = this
  // fdlog({ owner, env })
  if (!env.fsParams || !env.dbParams || !owner) {
    throw new Error('Cannot initiate user data store without specifying user and ds parameters')
  }
  fdlog('todonow need to make sure defaultparams can be used.')
  this.fsParams = env.fsParams
  this.dbParams = env.dbParams

  this.owner = owner
  this.appcoll = {
    // app_coll_name: {fsObject, dbObject, fsParams, dbParams}
  }
  this.dbPersistenceManager = {
    timer: setTimeout(function () { persistOldFilesNow(self) }, DB_PERSISTANCE_IDLE_TIME_THRESHOLD),
    lastSave: new Date().getTime(),
    writing: false
  }
  this.appfiles = {
    // app_name : {fsObject, dbObject, fsParams}
  }
}

DATA_STORE_MANAGER.prototype.setSystemUserDS = function (owner, env) {
  if (!owner) {
    throw new Error('no owner for setSystemUserDS')
  } else if (owner === 'undefined') {
    throw new Error('undefined string owner for setSystemUserDS - SNBH') // fdlog temporary debug todo remvoe?
  } else if (!env || !env.fsParams || !env.dbParams) {
    throw new Error('undefined env params for user - SNBH') // fdlog temporary debug todo remvoe?
  } else if (!['test', 'public', 'fradmin'].includes(owner)) {
    throw new Error('setSystemUserDS only used for system uses - cannot initiate for ' + owner)
  } else {
    this.users[owner] = new USER_DS(owner, env)
    // fdlog('todo - add allowUsersToUseAdminDs to freezr_environment params on set up')

    // if (!env && !this.allowUsersToUseAdminDs to freezr_environment params on set up) throw new Error ('Users need to set their own datastores')
    return this.users[owner]
  }
}
DATA_STORE_MANAGER.prototype.getDB = function (OAC) {
  // fdlog('getDB for ', OAC.owner, 'table: ', appTableName(OAC))
  if (this.users && this.users[OAC.owner] && this.users[OAC.owner].appcoll) {
    return this.users[OAC.owner].appcoll[appTableName(OAC)]
  } else {
    felog('ds_manager getDB', 'could not find user DB', OAC.owner)
    return null
  }
}
DATA_STORE_MANAGER.prototype.getOrSetUserDS = function (owner, callback) {
  if (this.users[owner]) {
    // fdlog('getOrSetUserDS userds exists - sending link to ', owner)
    callback(null, this.users[owner])
  } else {
    const self = this
    const userOac = { owner: 'fradmin', app_name: 'info.freezr.admin', collection_name: 'users' }
    const allUsersDb = self.getDB(userOac)
    allUsersDb.query({ user_id: owner }, null, function (err, ownerEntries) {
      // fdlog('getOrSetUserDS - going to reset - got users in getOrSetUserDS ', { ownerEntries, owner, err })
      if (err) throw err
      // reduce user and add params
      if (!ownerEntries || ownerEntries.length === 0) {
        felog('ds.getOrSetUserDS', 'no user in ds for c' + owner)
        callback(new Error(('no user ' + owner)))
      } else {
        fdlog('todonow need to make sure it has rights to use the default params', { ownerEntries })
        const dbParams = ownerEntries[0].dbParams
          ? (ownerEntries[0].dbParams.type === 'system'
            ? self.systemEnvironment.dbParams
            : ownerEntries[0].dbParams)
          : null
        const fsParams = ownerEntries[0].fsParams
          ? (ownerEntries[0].fsParams.type === 'system'
            ? self.systemEnvironment.fsParams : ownerEntries[0].fsParams)
          : null

        // fdlog('nowdec30 - todo if system and not nedb, pass unified db')

        if (fsParams && fsParams.type && dbParams && dbParams.type) {
          self.users[owner] = new USER_DS(owner, { dbParams, fsParams })
          callback(null, self.users[owner])
        } else {
          fdlog('ds.getOrSetUserDS', 'incomplete user ' + owner)
          callback(new Error('user incomplete'))
        }
      }
    })
  }
}
DATA_STORE_MANAGER.prototype.getUserPerms = function (owner, callback) {
  // const self = this
  this.getOrSetUserDS(owner, function (err, ownerDS) {
    if (err) {
      felog('getUserPerms', 'err for ' + owner, err)
      callback(err)
    } else {
      const permOAC = {
        app_name: 'info.freezr.account',
        collection_name: 'permissions',
        owner: owner
      }
      ownerDS.getorInitDb(permOAC, {}, callback)
      // old ownerDS.initOacDB(permOAC, {}, callback)
    }
  })
}
DATA_STORE_MANAGER.prototype.initOacDB = function (OAC, options = {}, callback) {
  // options: env - if want to use a special env for that ACO
  const ownerDS = this.users[OAC.owner]
  if (!ownerDS) throw new Error('Cannot intiiate user db without a user object. (Initiate user first.)')
  fdlog('pre init db store', { ownerDS })

  ownerDS.initOacDB(OAC, options = {}, callback)
}
DATA_STORE_MANAGER.prototype.getorInitDb = function (OAC, options, callback) {
  if (!OAC || !OAC.owner) {
    callback(new Error('cannot get db without AOC'))
  } else {
    this.getOrSetUserDS(OAC.owner, function (err, userDS) {
      if (err) {
        felog('getorInitDb err for ' + OAC.owner, err)
        callback(err)
      } else {
        userDS.getorInitDb(OAC, options, callback)
      }
    })
  }
}
USER_DS.prototype.getorInitDb = function (OAC, options, callback) {
  if (this.owner !== OAC.owner) throw new Error('getorInitDb SNBH - user trying to get another users info' + this.owner + ' vs ' + OAC.owner)

  if (this.appcoll[appTableName(OAC)]) {
    return callback(null, this.appcoll[appTableName(OAC)])
  } else {
    fdlog('getorInitDb need to re-init db ', appTableName(OAC))
    this.initOacDB(OAC, options = {}, callback)
  }
}
USER_DS.prototype.initOacDB = function (OAC, options = {}, callback) {
  if (this.owner !== OAC.owner) throw new Error('Cannot initiate an oacDB for another user ' + this.owner + ' vs ' + OAC.owner)
  if (!this.dbParams) throw new Error('Cannot initiate db or fs without fs and db params for user ' + this.owner)

  const userDs = this
  const dbParams = this.dbParams
  const fsParams = this.fsParams

  if (!this.appcoll[appTableName(OAC)]) {
    this.appcoll[appTableName(OAC)] = {
      oac: { ...OAC },
      dbParams,
      fsParams,
      dbLastAccessed: null,
      dbOldestWrite: null,
      dbChgCount: 0
      // tempCounter: 0,
      // tempreadbyidcounter:0
    }
  }

  // if (options && options.addCache)
  this.appcoll[appTableName(OAC)].cache = {}

  const ds = this.appcoll[appTableName(OAC)]

  // fdlog('initOacDB ' + this.owner, { dbParams, fsParams, OAC })

  const DB_CREATOR = require('../freezr_system/environment/dbApi_' + dbParams.type + '.js')
  ds.db = new DB_CREATOR({ dbParams, fsParams }, OAC)

  ds.db.initDB(function (err) {
    if (err) {
      felog('initDB Err ', ds.owner, err)
      callback(err)
    } else {
      fdlog('todo - ds.initDB - need to make sure ds has all required functions')

      ds.read_by_id = function (id, cb) {
        fdlog('ds.initDB - need to add checks - see "create"')

        ds.dbLastAccessed = new Date().getTime()
        // ds.tempreadbyidcounter++
        // fdlog('tempreadbyidcounter ',ds.tempreadbyidcounter)
        ds.db.read_by_id(id, cb)
      }
      ds.create = function (id, entity, options, cb) {
        // options are restore_record: true
        if (!options) options = {}
        if (!entity || typeof entity !== 'object' || Array.isArray(entity)) {
          cb(new Error('Cannot create an invalid entity type' + (typeof entity)))
        } else if (!ds.db || !ds.db.create) {
          cb(new Error('Missing function "ds.db.create"'))
        } else {
          if (!cb) {
            helpers.state_error('ds_manager', exports.version, 'create', err, 'No cb passed on to db function')
            cb = function (err, ret) { felog('ds.create', 'no cb passed to create', { err }) }
          }
          // fdlog('ds.create chges ', ds.dbChgCount, entity)
          ds.dbChgCount++
          ds.dbOldestWrite = ds.dbOldestWrite || new Date().getTime()
          ds.dbLastAccessed = new Date().getTime()
          resetPersistenceTimer(userDs, (ds.dbChgCount > DB_CHANGE_COUNT_THRESHOLD ? ds : null))

          if (!options.restore_record) {
            if (!options.keepReservedFields) helpers.RESERVED_FIELD_LIST.forEach((aReservedField) => delete entity[aReservedField])
            entity._date_created = new Date().getTime()
            entity._date_modified = new Date().getTime()
          }
          ds.db.create(id, entity, options, function (err, results) {
            fdlog('ds manager create ', { err, results })
            if (err) {
              cb(err)
            } else {
              cb(null, {
                _id: results._id,
                _date_modified: entity._date_modified,
                _date_created: entity._date_created
              })
            }
          })
        }
      }
      ds.query = function (query, options, cb) {
        // ds.tempCounter = ds.tempCounter+1

        ds.dbLastAccessed = new Date().getTime()
        if (!options) options = {}
        ds.db.query(query, options, cb)
      }
      ds.update = function (idOrQuery, updatesToEntity, options, cb) {
        // assumes rights to make the update and that appcollowner is well formed
        // IMPORTANT: db_update cannot insert new entities - just update existign ones
        //  options: replaceAllFields - replaces all object rather than specific keys
        //   In replaceAllFields: _date_created taken from previous version  and add it here
        //   if old_entity is specified then it is done automatically... this assumes system generates the old_entity, not the user
        // restore_record:
        // newSystemParams: used for updating system params

        ds.dbChgCount++
        ds.dbOldestWrite = ds.dbOldestWrite || new Date().getTime()
        ds.dbLastAccessed = new Date().getTime()
        resetPersistenceTimer(userDs, (ds.dbChgCount > DB_CHANGE_COUNT_THRESHOLD ? ds : null))
        if (!options) options = {}
        fdlog('ds.update - need to add checks - see "create"')

        if (options.replaceAllFields) {
          // fdlog('ds.update replaceAllFields going to update entity with new updates ',{idOrQuery, updatesToEntity})
          if (options.old_entity) { // assumes system has found old_entity and so skip one extra find
            const entityId = (typeof idOrQuery === 'string') ? idOrQuery : options.old_entity._id
            helpers.RESERVED_FIELD_LIST.forEach(key => {
              if (options.old_entity[key]) updatesToEntity[key] = options.old_entity[key]
            })
            delete updatesToEntity._id
            updatesToEntity._date_modified = new Date().getTime()
            // fdlog('going to replace_record_by_id ', {entityId, updatesToEntity })
            ds.db.replace_record_by_id(entityId, updatesToEntity, (err, result) => {
              const nModified = (result && result.result && result.result.nModified) ? result.result.nModified : null
              const returns = err ? null : {
                nModified,
                _id: options.old_entity._id,
                _date_created: options.old_entity._date_created,
                _date_modified: updatesToEntity._date_modified
              }
              fdlog('dsmanager update 1 ', { err, result, returns })
              cb(err, returns)
            })
          } else {
            // fdlog('ds.update GOING TO FIND OLD ENTITY update entity with new updates ',{idOrQuery, updatesToEntity})
            if (typeof idOrQuery === 'string') idOrQuery = { _id: idOrQuery }
            ds.db.query(idOrQuery, {}, (err, entities) => {
              if (err) {
                cb(err)
              } else if (!entities || entities.length === 0) {
                if (typeof idOrQuery === 'string') {
                  cb(new Error('no records found to update'))
                } else {
                  cb(null, { nModified: 0 })
                }
              } else if (entities.length > 1) {
                cb(helpers.error('expected to replace one and got many records'))
              } else {
                const oldEntity = entities[0]
                const entityId = oldEntity._id
                Object.keys(oldEntity).forEach(function (key) {
                  if (updatesToEntity[key] === undefined) updatesToEntity[key] = oldEntity[key]
                })
                if (!options.restore_record) {
                  helpers.RESERVED_FIELD_LIST.forEach(key => {
                    if (oldEntity[key] !== undefined) updatesToEntity[key] = oldEntity[key]
                  })
                }
                delete updatesToEntity._id
                updatesToEntity._date_modified = new Date().getTime()

                // fdlog('dsManager - will update to new ',{ updatesToEntity })
                ds.db.replace_record_by_id(entityId, updatesToEntity, (err, result) => {
                  const nModified = (result && result.result && result.result.nModified) ? result.result.nModified : null
                  var returns = err ? null : {
                    nModified,
                    _id: entityId,
                    _date_created: oldEntity._date_created,
                    _date_modified: updatesToEntity._date_modified
                  }
                  fdlog('dsmanager update 2 ', { err, result, returns })

                  if (entities.length > 1) {
                    returns.more = true
                    returns.flags = 'More than one object retrieved - first object changed'
                    felog('More than One object retrieved when updating with replaceAllFields ')
                  }
                  if (err) felog('ds.update', 'returns from replace_record_by_id ', { updatesToEntity, err, result })
                  cb(err, returns)
                })
              }
            })
          }
        } else { // if (!options.replaceAllFields)
          // fdlog('replace !NOT ALL -  ', { idOrQuery, updatesToEntity, options })
          if (!options.newSystemParams) helpers.RESERVED_FIELD_LIST.forEach(key => delete updatesToEntity[key])
          updatesToEntity._date_modified = new Date().getTime()
          // note todo - keeping default mongo return params pendign ceps definition
          ds.db.update_multi_records(idOrQuery, updatesToEntity, function (err, ret) {
            if (!err && typeof idOrQuery === 'string' && ret.nModified === 0) {
              cb(new Error('no record found to update'))
            } else {
              cb(err, ret)
            }
          })
        }
      }
      ds.replace_record_by_id = function (entityId, updatedEntity, options, cb) {
        fdlog('ds.replace_record_by_id: todo - review - should this be called or should it just be in ds.db - also need to add checks - see "create"')

        ds.dbChgCount++
        ds.dbLastAccessed = new Date().getTime()
        resetPersistenceTimer(userDs, (ds.dbChgCount > DB_CHANGE_COUNT_THRESHOLD ? ds : null))
        if (options) fdlog('todo - need to implement options on update')
        ds.db.replace_record_by_id(entityId, updatedEntity, function (err, num) {
          if (err) {
            cb(err)
          } else if (num === 0) {
            cb(new Error('no record found to replace'))
          } else {
            cb(null, {
              nModified: num,
              _id: entityId,
              _date_created: updatedEntity._date_created,
              _date_modified: updatedEntity._date_modified
            })
          }
        })
      }
      ds.upsert = function (idOrQuery, entity, cb) {
        fdlog('ds.upsert - todo - need to add checks - see "create"')

        function callFwd (err, existingEntity) {
          // fdlog('In db_handler upsert callFwd', existingEntity, 'Will replace with new entity', entity)
          if (err) {
            helpers.state_error('ds_manager', exports.version, 'upsert', err, 'error reading db')
            cb(err)
          } else if (!existingEntity || (Array.isArray(existingEntity) && existingEntity.length === 0)) {
            const id = (typeof idOrQuery === 'string') ? idOrQuery : (
              (idOrQuery && idOrQuery._id) ? (idOrQuery._id + '') : null
            )
            ds.create(id, entity, null, (err, result) => {
              cb(err, ((result && result.entity) ? result.entity : null))
            })
          } else if (!existingEntity || (Array.isArray(existingEntity) && existingEntity.length > 1)) {
            cb(new Error('Cannot upsert more than one record'))
          } else {
            if (Array.isArray(existingEntity)) {
              existingEntity = existingEntity[0]
            }
            delete entity._id
            idOrQuery = existingEntity._id + ''
            exports.update(idOrQuery, entity, { replaceAllFields: true, old_entity: existingEntity }, cb)
          }
        };

        if (typeof idOrQuery === 'string') {
          ds.db.read_by_id(idOrQuery, callFwd)
        } else {
          fdlog(' todo - should upsert work with a query returning more than 1 item?')
          ds.db.query(idOrQuery, {}, callFwd)
        }
      }
      ds.delete_record = function (idOrQuery, options = {}, cb) {
        fdlog('ds.delete_record - todo need to add checks - see "create"')

        if (typeof idOrQuery !== 'string') throw new Error('Use delete_records to delete multiple records or pass a record id string as the argument for delete_record')
        idOrQuery = { _id: idOrQuery }
        ds.dbChgCount++
        ds.dbOldestWrite = ds.dbOldestWrite || new Date().getTime()
        ds.dbLastAccessed = new Date().getTime()
        resetPersistenceTimer(userDs, (ds.dbChgCount > DB_CHANGE_COUNT_THRESHOLD ? ds : null))
        ds.delete_records(idOrQuery, { multi: false }, function (err, ret) {
          if (ret && ret.nRemoved === 0) {
            cb(new Error('Record not found to delete'))
          } else {
            cb(err, ret)
          }
        })
      }
      ds.delete_records = function (idOrQuery, options = {}, cb) {
        fdlog('ds.delete_records - todo need to add checks - see "create"')

        options = options || {}
        ds.dbChgCount++
        ds.dbOldestWrite = ds.dbOldestWrite || new Date().getTime()
        ds.dbLastAccessed = new Date().getTime()
        resetPersistenceTimer(userDs, (ds.dbChgCount > DB_CHANGE_COUNT_THRESHOLD ? ds : null))

        const multi = options.multi === undefined ? true : options.multi
        if (typeof idOrQuery === 'string') idOrQuery = { _id: idOrQuery }
        ds.db.delete_record(idOrQuery, { multi }, cb)
      }

      ds.getAllAppTableNames = function (appName, callback) {
        fdlog('ds.getAllAppTableNames - todo need to add checks - see "create"')
        ds.db.getAllAppTableNames(appName, callback)
      }

      callback(null, ds)
    }
  })
}
USER_DS.prototype.getDB = function (OAC) {
  if (this.owner !== OAC.owner) throw new Error('getdb SNBH - user trying to get another users info' + this.owner + ' vs ' + OAC.owner)
  if (!this.appcoll[appTableName(OAC)]) throw new Error('initate user and db before getting')
  return this.appcoll[appTableName(OAC)]
}
DATA_STORE_MANAGER.prototype.initAdminDBs = function (OACs, options = {}, callback) {
  const self = this
  async.forEach(OACs, function (oac, cb) {
    self.initOacDB(oac, options, cb)
  },
  callback)
}
DATA_STORE_MANAGER.prototype.initUserAppFSToGetCredentials = function (user, appName, options = {}, callback) {
  // options: env - if want to use a special env for that ACO
  const ownerDS = this.users[user]
  if (!ownerDS) throw new Error('Cannot intitiate user fs without a user object. (Initiate user first.) ' + user)

  ownerDS.initAppFS(appName, options, (err, appFS) => {
    // fdlog('got returns appfs for initUserAppFSToGetCredentials ', { err }, 'creds: ', appFS.fs.credentials)
    if (err || !appFS || !appFS.fs || !appFS.fs.credentials) {
      callback((err || new Error('could not get app fs credentials  in initalising')))
    } else {
      callback(null, appFS.fs.credentials)
    }
  })
}

DATA_STORE_MANAGER.prototype.getOrInitUserAppFS = function (user, appName, options = {}, callback) {
  // options: env - if want to use a special env for that ACO
  const ownerDS = this.users[user]
  if (!ownerDS) throw new Error('Cannot intitiate user fs without a user object. (Initiate user first.) ' + user)

  ownerDS.getorInitAppFS(appName, options, callback)
}
USER_DS.prototype.getorInitAppFS = function (appName, options, callback) {
  if (this.appfiles[appName]) {
    return callback(null, this.appfiles[appName])
  } else {
    this.initAppFS(appName, options, callback)
  }
}
const ENV_FILE_DIR = 'freezr_system/forked_modules/nedb-async/env/'
USER_DS.prototype.initAppFS = function (appName, options = {}, callback) {
  fdlog('initAppFS for app ' + appName + 'for owner ' + this.owner, options)

  const userDs = this
  const owner = this.owner
  const isSystemApp = helpers.is_system_app(appName)
  const fsParams = this.fsParams

  if (!this.fsParams) throw new Error('Cannot initiate db or fs without fs and db params for user ' + this.owner)

  if (!this.appfiles[appName]) {
    this.appfiles[appName] = {
      owner,
      appName,
      fsParams
    }
  }
  // if (options && options.addCache)
  this.appfiles[appName].cache = {}

  const ds = this.appfiles[appName]

  try {
    if (fsParams.type === 'local' || fsParams.type === 'glitch') {
      ds.fs = require('../' + ENV_FILE_DIR + 'dbfs_local.js')
    } else {
      const CustomFS = require('../' + ENV_FILE_DIR + 'dbfs_' + fsParams.type + '.js')
      ds.fs = new CustomFS(fsParams, { doNotPersistOnLoad: true })
    }
  } catch (e) {
    felog('ds.initAppFS', 'ds.fs failed for ' + owner + ' using fs ' + fsParams.name, e)
    callback(new Error('Could not initiate dbfs file for fs type ' + fsParams.type))
  }

  ds.pathToFile = function (endpath) {
    const pathToRead = (isSystemApp ? 'systemapps' : (helpers.FREEZR_USER_FILES_DIR + '/' + this.owner + '/apps')) +
      '/' + this.appName + '/' + endpath
    return pathToRead
  }

  ds.readAppFile = function (endpath, options = {}, cb) {
    fdlog('readAppFile ', { endpath })
    if (!this.cache.appfiles) this.cache.appfiles = {}
    if (!this.cache.appfiles[endpath]) this.cache.appfiles[endpath] = {}
    const theCache = this.cache.appfiles

    if (isSystemApp) {
      const localpath = path.normalize(__dirname.replace('freezr_system', '') + 'systemapps/' + this.appName + '/' + endpath)
      // fdlog('going to read local system fiule ', localpath)
      fs.readFile(localpath, options, function (err, content) {
        content = content ? content.toString() : null
        cb(err, content)
      })
    } else if (theCache[endpath].content) {
      theCache[endpath].fsLastAccessed = new Date().getTime()
      // fdlog('fscache reading fromc cache ' + endpath)
      cb(null, theCache[endpath].content)
    } else {
      const pathToRead = helpers.FREEZR_USER_FILES_DIR + '/' + this.owner + '/apps/' + this.appName + '/' + endpath
      // fdlog('ds.readAppFile and add to fscache  ' + pathToRead)
      const localpath = path.normalize(__dirname.replace('freezr_system', '') + pathToRead)

      if (fs.existsSync(localpath)) {
        // this is included because of offthreadinstalls - may be more long-term efficient to add to cache upon install
        fs.readFile(localpath, options, function (err, content) {
          content = content ? content.toString() : null
          if (!err && content) {
            theCache[endpath] = { content, fsLastAccessed: new Date().getTime() }
          }
          cb(err, content)
        })
      } else {
        this.fs.readFile(pathToRead, options, function (err, content) {
          // fdlog('setting fscache - will it persist ', { err, content })
          content = content ? content.toString() : null
          if (!err && content) {
            theCache[endpath] = { content, fsLastAccessed: new Date().getTime() }
          }
          // todo fdlog('need a cache flush or a check on whether the size is too big')
          // todo fdlog('also need to flush cache on refresh of apps or re-installs')
          cb(err, content)
        })
      }
    }
  }

  ds.sendAppFile = function (endpath, res, options) {
    fdlog('sendAppFile ', { endpath })
    const isSystemApp = helpers.is_system_app(this.appName)
    const partialPath = isSystemApp ? ('systemapps/' + this.appName + '/' + endpath) : (helpers.FREEZR_USER_FILES_DIR + '/' + this.owner + '/apps/' + appName + '/' + endpath)

    const self = this
    if (!self.cache.appfiles) self.cache.appfiles = {}
    if (!self.cache.appfiles[endpath]) self.cache.appfiles[endpath] = {}
    // note cache is a bit redundant here as existsSync is checked. however, cache makes it faster as te check is not needed

    // fdlog('in ds. sendAppFile' + endpath + 'type ' + this.fsParams.type + '  app ' + this.appName)

    if (endpath.slice(-3) === '.js') res.setHeader('content-type', 'application/javascript')
    if (endpath.slice(-4) === '.css') res.setHeader('content-type', 'text/css')

    const localpath = path.normalize(__dirname.replace('freezr_system', '') + partialPath)

    if (fs.existsSync(localpath)) {
      self.cache.appfiles[endpath] = { fsLastAccessed: new Date().getTime() }
      res.sendFile(localpath)
    } else if (this.fsParams.type === 'local' || isSystemApp) {
      felog('sendAppFile', ' - missing file in  local ' + localpath)
      res.status(404).send('file not found!')
    } else {
      ds.fs.getFileToSend(partialPath, function (err, streamOrFile) {
        if (err) {
          felog('sendAppFile', 'err in sendAppfile for ', { partialPath, err })
          res.status(404).send('file not found!')
          res.end()
        } else {
          // fdlog('sendAppFile -  putting back in cache ' + partialPath)
          if (streamOrFile.pipe) { // it is a stream
            streamOrFile.pipe(res)
            localCheckExistsOrCreateUserFolderSync(partialPath, true)
            streamOrFile.pipe(fs.createWriteStream(localpath))
            self.cache.appfiles[endpath] = { fsLastAccessed: new Date().getTime() }
          } else { // it is a file
            res.send(streamOrFile)
            localCheckExistsOrCreateUserFolderSync(partialPath, true)
            fs.writeFile(localpath, streamOrFile, null, function (err, name) {
              if (err) {
                felog('sendAppFile', ' -  error putting back in cache ' + partialPath)
              } else {
                // fdlog('sendAppFile -  SUCCESS putting back in cache ' + partialPath)
                self.cache.appfiles[endpath] = { fsLastAccessed: new Date().getTime() }
              }
            })
          }
        }
      })
    }
  }

  ds.sendPublicAppFile = function (endpath, res, options) {
    const isSystemApp = helpers.is_system_app(this.appName)
    const partialPath = isSystemApp ? ('systemapps/' + this.appName + '/' + endpath) : (helpers.FREEZR_USER_FILES_DIR + '/' + this.owner + '/apps/' + appName + '/' + endpath)

    const self = this
    if (!self.cache.appfiles) self.cache.appfiles = {}
    if (!self.cache.appfiles[endpath]) self.cache.appfiles[endpath] = {}
    fdlog('in ds sendPublicAppFile ', { endpath, partialPath })

    if (endpath.slice(-3) === '.js') res.setHeader('content-type', 'application/javascript')
    if (endpath.slice(-4) === '.css') res.setHeader('content-type', 'text/css')

    const localpath = path.normalize(__dirname.replace('freezr_system', '') + partialPath)
    if (fs.existsSync(localpath)) {
      // fdlog('sendPublicAppFile - sending from local ' + partialPath + 'existsSync? ' + fs.existsSync(localpath))
      self.cache.appfiles[endpath] = { fsLastAccessed: new Date().getTime() }
      res.sendFile(localpath)
    } else if (this.fsParams.type === 'local' || isSystemApp) {
      // fdlog('sendPublicAppFile - missing file in  local ' + localpath)
      res.status(404).send('file not found!')
    } else {
      this.fs.getFileToSend(partialPath, function (err, streamOrFile) {
        if (err) {
          fdlog('sendPublicAppFile', 'err in sendPublicAppFile for ' + partialPath)
          res.status(404).send('file not found!')
          res.end()
        } else {
          if (streamOrFile.pipe) { // it is a stream
            streamOrFile.pipe(res)
            localCheckExistsOrCreateUserFolderSync(partialPath, true)
            streamOrFile.pipe(fs.createWriteStream(localpath))
            self.cache.appfiles[endpath] = { fsLastAccessed: new Date().getTime() }
          } else { // it is a file
            res.send(streamOrFile)
            localCheckExistsOrCreateUserFolderSync(partialPath, true)
            fs.writeFile(localpath, streamOrFile, null, function (err, name) {
              if (err) {
                felog('sendAppFile', ' -  error putting back in cache ' + partialPath)
              } else {
                // fdlog('sendAppFile -  SUCCESS putting back in cache ' + partialPath)
                self.cache.appfiles[endpath] = { fsLastAccessed: new Date().getTime() }
              }
            })
          }
        }
      })
    }
  }
  ds.writeToUserFiles = function (endpath, content, options, cb) {
    options = options || {} // options: doNotOverWrite, nocache
    const pathToWrite = helpers.FREEZR_USER_FILES_DIR + '/' + this.owner + '/files/' + this.appName + '/' + endpath
    // fdlog('ds.writeToUserFiles  ' + pathToWrite)

    const self = this
    if (!self.cache.userfiles) self.cache.userfiles = {}
    if (!self.cache.userfiles[endpath]) self.cache.userfiles[endpath] = {}

    this.fs.writeFile(pathToWrite, content, options, function (err, name) {
      if (err) {
        cb(err)
      } else if (!options || !options.nocache) {
        fs.writeFile(pathToWrite, content, options, function (err, name) {
          if (err) felog('writeToUserFiles', 'Error duplicating file in local drive for ' + this.owner + ' path: ' + pathToWrite)
          if (!err) self.cache.userfiles[endpath] = { fsLastAccessed: new Date().getTime() }
          cb(null, name)
        })
      } else {
        cb(null, name)
      }
    })
  }
  ds.readUserFile = function (endpath, options, cb) {
    options = options || {} // options: nocache
    const pathToRead = helpers.FREEZR_USER_FILES_DIR + '/' + this.owner + '/files/' + this.appName + '/' + endpath
    const self = this
    if (!self.cache.userfiles) self.cache.userfiles = {}
    if (!self.cache.userfiles[endpath]) self.cache.userfiles[endpath] = {}

    const localpath = path.normalize(__dirname.replace('freezr_system', '') + pathToRead)
    if (!options.nocache && fs.existsSync(localpath)) {
      self.cache.userfiles[endpath] = { fsLastAccessed: new Date().getTime() }
      fs.readFile(localpath, options, (err, content) => {
        content = content ? content.toString() : null
        cb(err, content)
      })
    } else {
      this.fs.readFile(pathToRead, options, function (err, content) {
        if (err) {
          cb(err)
        } else {
          content = content ? content.toString() : null
          let dir = localpath.split('/')
          dir.pop()
          dir = dir.join('/')
          mkdirp(dir, function (err) {
            if (err) {
              if (err) felog('ds readUserFile', 'Error creating directory to store local copy of file for readUserFile ', { dir, localpath, err })
              cb(null, content)
            } else {
              fs.writeFile(localpath, content, options, function (err, name) {
                if (err) felog('ds readUserFile', 'Error duplicating file in local drive for readUserFile ', { endpath, localpath, err })
                if (!err) self.cache.userfiles[endpath] = { fsLastAccessed: new Date().getTime() }
                cb(null, content)
              })
            }
          })
        }
      })
    }
  }

  ds.sendUserFile = function (endpath, res, options) {
    const partialPath = (helpers.FREEZR_USER_FILES_DIR + '/' + this.owner + '/files/' + this.appName + '/' + endpath)

    const self = this
    if (!self.cache.userfiles) self.cache.userfiles = {}
    if (!self.cache.userfiles[endpath]) self.cache.userfiles[endpath] = {}

    // fdlog('in ds sending user endpath ' + { endpath, partialPath})

    const localpath = path.normalize(__dirname.replace('freezr_system', '') + partialPath)
    if (fs.existsSync(localpath)) {
      // fdlog('sendUserFile - sending from local ' + partialPath)
      res.sendFile(localpath)
    } else {
      this.fs.getFileToSend(partialPath, function (err, stream) {
        if (err) {
          felog('sendUserFile', 'err in sendUserFile for ', partialPath)
          res.status(404).send('file not found!')
          res.end()
        } else {
          stream.pipe(res)
          localCheckExistsOrCreateUserFolderSync(localpath, true)
          stream.pipe(fs.createWriteStream(localpath))
          self.cache.userfiles[endpath] = { fsLastAccessed: new Date().getTime() }
        }
      })
    }
  }

  if (!isSystemApp) {
    ds.removeAllAppFiles = function (options = {}, cb) {
      const pathToDelete = helpers.FREEZR_USER_FILES_DIR + '/' + this.owner + '/apps/' + this.appName
      // fdlog('ds.removeAllAppFiles  ' + pathToDelete)
      this.fs.removeFolder(pathToDelete, cb)
    }
    ds.writeToAppFiles = function (endpath, content, options = {}, cb) {
      const pathToWrite = helpers.FREEZR_USER_FILES_DIR + '/' + this.owner + '/apps/' + this.appName + '/' + endpath

      const self = this
      if (!self.cache.appfiles) self.cache.appfiles = {}
      if (!self.cache.appfiles[endpath]) self.cache.appfiles[endpath] = {}

      // fdlog('ds.writeToAppFiles  ' + pathToWrite)
      this.fs.writeFile(pathToWrite, content, options, function (err, name) {
        if (err) {
          cb(err)
        } else {
          fs.writeFile(pathToWrite, content, options, function (err, name) {
            if (err) felog('writeToAppFiles', 'Error duplicating file in local drive for writeToAppFiles for ', this.owner, 'path ', pathToWrite, err)
            if (!err) self.cache.appfiles[endpath] = { fsLastAccessed: new Date().getTime() }
            cb(null, name)
          })
        }
      })
    }
  }

  const initUserDirectories = function (ds, owner, cb) {
    ds.fs.mkdirp(helpers.FREEZR_USER_FILES_DIR + '/' + owner + '/apps/' + appName, function (err) {
      if (err) {
        cb(err)
      } else {
        ds.fs.mkdirp((helpers.FREEZR_USER_FILES_DIR + '/' + owner + '/files/' + appName), function (err) {
          if (err) {
            cb(err)
          } else {
            ds.fs.mkdirp((helpers.FREEZR_USER_FILES_DIR + '/' + owner + '/db/' + appName), function (err) {
              if (err) {
                cb(err)
              } else {
                cb(err, ds)
              }
            })
          }
        })
      }
    })
  }

  if (ds.fs.initFS) {
    ds.fs.initFS(function (err) {
      if (err) felog('ds.initAppFS', ' err initing fs', err)
      if (options && options.getRefreshToken) {
        // fdlog('ds.initAppFS', ' retururns ds.fs - ds.fs.credentials ', ds.fs.credentials, 'ds.credentials:', ds.credentials)
        callback(null, ds)
      } else {
        initUserDirectories(ds, userDs.owner, callback)
      }
    })
  } else {
    initUserDirectories(ds, userDs.owner, callback)
  }
}

const appTableName = function (oac) {
  if ((!oac.app_name && !oac.app_table) || !oac.owner) throw helpers.error('DATA_STORE_MANAGER  failure - need app name or table and an owner for ' + JSON.stringify(oac))
  if (oac.app_table) return oac.app_table.replace(/\./g, '_')
  const name = oac.app_name + (oac.collection_name ? ('_' + oac.collection_name) : '')
  return name.replace(/\./g, '_')
}

const persistOldFilesNow = function (userDs, dbToPersist) {
  fdlog('persist files now - appcoll is ', userDs.appcoll.oac)

  let persistNext = null
  if (!dbToPersist) {
    let oldestWrite = new Date().getTime()
    let dbChangeCountHasPassedThreshold = 0
    Object.keys(userDs.appcoll).forEach((key) => {
      // fdlog('persist file write for key', key)
      // If the date threshold has passed or the dbChgCount threshold have passed, persist
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
    fdlog('going to persist', dbToPersist.oac)
    dbToPersist.persistenceInProgress = true // todo later - can use this to delay create or update...

    dbToPersist.db.persistCachedDatabase(function (err) {
      dbToPersist.persistenceInProgress = false
      if (!err) {
        dbToPersist.dbChgCount = 0
        dbToPersist.dbOldestWrite = null
      }
      resetPersistenceTimer(userDs, persistNext)
    })
  } else {
    fdlog('persistOldFilesNow', 'Have presisted ALL DBs - Should close unused ones based on pre-set thresholds')
  }
}
const resetPersistenceTimer = function (userDs, originStore) {
  clearTimeout(userDs.dbPersistenceManager.timer)
  const newtime = originStore ? 1000 : DB_PERSISTANCE_IDLE_TIME_THRESHOLD
  userDs.dbPersistenceManager.timer = setTimeout(function () { persistOldFilesNow(userDs) }, newtime)
}
// do traverse to clean..

const localCheckExistsOrCreateUserFolderSync = function (aPath, removeEndFile) {
  /*
  if (!aPath) return;
  var dirs = aPath.split("/")Error duplicating file in local drive for readUserFile
  if (aPath.length == 0) return;
  var thisPath = dirs.shift();
  var fullPath =  systemPathTo (aPath);
  if (!fs.existsSync(fullPath) ) fs.mkdirSync(fullPath);
  return;
  */
  // from https://gist.github.com/danherbert-epam/3960169 modified for sync
  var pathSep = path.sep
  var dirs = aPath.split('/')
  if (removeEndFile) dirs.pop()
  var root = ''

  mkDir()

  function mkDir () {
    var dir = dirs.shift()
    if (dir === '') { // If directory starts with a /, the first path will be th root user folder.
      root = path.normalize(__dirname.replace('freezr_system', '')) + pathSep
    }
    if (!fs.existsSync(root + dir)) {
      fs.mkdirSync(root + dir)
      root += dir + pathSep
      if (dirs.length > 0) {
        mkDir()
      } // else { return }
    } else {
      root += dir + pathSep
      if (dirs.length > 0) {
        mkDir()
      } // else { return }
    }
  }
}

// Interface
module.exports = DATA_STORE_MANAGER

// Loggers
const LOG_ERRORS = true
const felog = function (...args) { if (LOG_ERRORS) helpers.warning('ds_manager.js', exports.version, ...args) }
const LOG_DEBUGS = false
const fdlog = function (...args) { if (LOG_DEBUGS) console.log(...args) }
