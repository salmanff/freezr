// freezr.info - nodejs system files - perm_handler

exports.version = '0.0.200'

/* global User */

const helpers = require('./helpers.js')
const async = require('async')

// dsManager.getorInitDb({app_table: 'info.freezr.account.app_list', owner: freezrAttributes.owner_user_id}, {}, function(err, requesteeAppListDB) {})

exports.readWriteUserData = function (req, res, dsManager, next) {
  // assume token info in in req.freezrTokenInfo => {userId, appName, loggedIn}
  fdlog('readWriteUserData ')

  var freezrAttributes = {
    permission_name: null,
    owner_user_id: null,
    requestor_app: null,
    requestor_user_id: null,
    own_record: false, // ie not permitted
    record_is_permitted: false,
    grantedPerms: []
  }

  freezrAttributes.requestor_app = req.freezrTokenInfo.app_name
  freezrAttributes.requestor_user_id = req.freezrTokenInfo.requestor_id
  freezrAttributes.owner_user_id = req.freezrTokenInfo.owner_id

  if (!req.params) req.params = {}
  if (!req.query) req.query = {}
  freezrAttributes.permission_name = req.params.permission_name /* for files get */ || req.query.permission_name /* for CEPS get */

const requestFile = helpers.startsWith(req.path, '/feps/getuserfiletoken') ||  helpers.startsWith(req.path, '/feps/upload/')// /feps/getuserfiletoken
  if (requestFile) {
    req.params.app_table = req.params.app_name + '.files'
    freezrAttributes.owner_user_id = req.params.user_id
  }

  if (!freezrAttributes.owner_user_id) freezrAttributes.owner_user_id = freezrAttributes.requestor_user_id

  // for admin
  if (req.body.appName === 'info.freezr.admin' && req.session.logged_in_as_admin && helpers.SYSTEM_ADMIN_APPTABLES.indexOf(req.params.app_table) > -1) freezrAttributes.requestor_user_id = 'fradmin'

  const getDbTobeRead = function () {
    fdlog('getDbTobeRead ', { freezrAttributes })
    dsManager.getorInitDb({ app_table: req.params.app_table, owner: freezrAttributes.owner_user_id }, {}, function (err, freezrRequesteeDB) {
      if (err) {
        helpers.error('Could not access main user AOC db - read_by_id_perms')
        res.sendStatus(401)
      } else if (!freezrRequesteeDB || !freezrRequesteeDB.read_by_id) {
        helpers.error('Could not access requested db - err for ' + req.params.app_tablep)
        res.sendStatus(401)
      } else {
        req.freezrRequesteeDB = freezrRequesteeDB
        req.freezrAttributes = freezrAttributes
        next()
      }
    })
  }

  fdlog('pre attributes ', freezrAttributes, 'req.params.app_table ' + req.params.app_table)
  if (!req.params.app_table || !freezrAttributes.requestor_app || !freezrAttributes.requestor_user_id) {
    helpers.error('Missing parameters for permissions - read_by_id_perms')
    felog('perm_handler.js', 'Missing parameters', { freezrAttributes })
    res.sendStatus(401)
  } else if (helpers.startsWith(req.params.app_table, freezrAttributes.requestor_app) && freezrAttributes.requestor_user_id === freezrAttributes.owner_user_id) {
    freezrAttributes.own_record = true
    freezrAttributes.record_is_permitted = true
    getDbTobeRead()
  } else if ((helpers.startsWith(req.path, '/ceps/query') || helpers.startsWith(req.path, '/feps/query') || helpers.startsWith(req.params.app_table, 'dev.ceps')) &&
    req.freezrTokenInfo.app_name === 'info.freezr.account' && req.session.logged_in_user_id === freezrAttributes.owner_user_id &&
    (req.body.appName || helpers.startsWith(req.params.app_table, 'dev.ceps'))) {
    // backuprequest: special case for query from accounts folder for "view or backup data"
    freezrAttributes.requestor_app = req.body.appName || req.params.app_table // eithr query or aq ceps.dev
    freezrAttributes.own_record = true
    freezrAttributes.record_is_permitted = true
    getDbTobeRead()
  } else if (['dev.ceps.messages.got', 'dev.ceps.messages.sent'].includes(req.params.app_table)  &&
    ((helpers.startsWith(req.path, '/feps/query') && req.body.q && req.body.q.app_id && req.body.q.app_id && req.body.q.app_id === req.freezrTokenInfo.app_name) ||
     (helpers.startsWith(req.path, '/ceps/query') && req.query && req.query.app_id && req.query.app_id === req.freezrTokenInfo.app_name))) {
    // Each app can query its own messages. (For other app messages, a permission is required)
    freezrAttributes.own_record = true
    freezrAttributes.record_is_permitted = true
    getDbTobeRead()
  } else {
    dsManager.getUserPerms(freezrAttributes.owner_user_id, function (err, permDB) {
      if (err) {
        helpers.error('Error in getting perms - getUserPerms')
        res.sendStatus(401)
      } else {
        const dbQuery = {
          table_id: req.params.app_table,
          requestor_app: freezrAttributes.requestor_app,
          granted: true
        }
        if (freezrAttributes.permission_name) {
          dbQuery.permission_name = freezrAttributes.permission_name
        }

        permDB.query(dbQuery, {}, function (err, grantedPerms) {
          if (err) {
            helpers.error('Error doing query -  read_by_id_perms')
            res.sendStatus(401)
          } else {
            // [2021 - groups] freezrAttributes.reader
            fdlog('permDB dbQuery ', { dbQuery, grantedPerms })
            // console.log('todo - here check for each requestee or the groups they are in... also see if permission name will be used')
            freezrAttributes.grantedPerms = grantedPerms
            getDbTobeRead()
          }
        })
      }
    })
  }
}

exports.addUserAppsAndPermDBs = function (req, res, dsManager, next) {
  // user_apps - used for account APIs
  dsManager.getorInitDb({ app_table: 'info.freezr.account.app_list', owner: req.session.logged_in_user_id }, {}, function (err, freezrUserAppListDB) {
    if (err) {
      felog('addUserAppsAndPermDBs', 'Could not access main freezrUserAppListDB - addUserAppsAndPermDBs - redirect', err)
      res.redirect('/admin/public/starterror?error=couldNotAccessADb&errSource=userAppList&errorDetail=' + err)
    } else {
      req.freezrUserAppListDB = freezrUserAppListDB
      dsManager.getorInitDb({ app_table: 'info.freezr.account.permissions', owner: req.session.logged_in_user_id }, {}, function (err, freezrUserPermsDB) {
        if (err) {
          felog('addUserAppsAndPermDBs', 'Could not access main freezrUserPermsDB - addUserAppsAndPermDBs - 401', err)
          res.sendStatus(401)
        } else {
          req.freezrUserPermsDB = freezrUserPermsDB
          req.freezrUserDS = dsManager.users[req.session.logged_in_user_id] // nb no need for callback as already got db
          next()
        }
      })
    }
  })
}
exports.addUserPermDBs = function (req, res, dsManager, next) {
  // used for getall permission /v1/permissions/getall/:app_name and /v1/permissions/gethtml/:app_name'
  dsManager.getorInitDb({ app_table: 'info.freezr.account.permissions', owner: req.freezrTokenInfo.owner_id }, {}, function (err, freezrUserPermsDB) {
    if (err) {
      helpers.state_error('Could not access main freezrUserPermsDB - addUserAppsAndPermDBs')
      res.sendStatus(401)
    } else {
      req.freezrUserPermsDB = freezrUserPermsDB
      next()
    }
  })
}
const APP_TOKEN_OAC = {
  app_name: 'info.freezr.admin',
  collection_name: 'app_tokens',
  owner: 'fradmin'
}
exports.addAppTokenDB = function (req, res, dsManager, next) {
  // used for getall permission /v1/permissions/getall/:app_name and /v1/permissions/gethtml/:app_name'
  dsManager.getorInitDb(APP_TOKEN_OAC, {}, function (err, freezrAppTokenDB) {
    if (err) {
      helpers.state_error('Could not access main freezrAppTokenDB - addAppTokenDB')
      res.sendStatus(401)
    } else {
      req.freezrAppTokenDB = freezrAppTokenDB
      next()
    }
  })
}
const VALIDATION_TOKEN_OAC = {
  app_table: 'dev.ceps.perms.validations',
  // app_name: 'info.freezr.admin',
  // collection_name: 'validationTokens',
  owner: 'fradmin'
}
exports.addValidationDBs = function (req, res, dsManager, next) {
  // used for getall permission /v1/permissions/getall/:app_name and /v1/permissions/gethtml/:app_name'
  if (req.params.action === 'set' || req.params.action === 'verify') {
    dsManager.getorInitDb(VALIDATION_TOKEN_OAC, {}, function (err, freezrValidationTokenDB) {
      if (err) {
        helpers.state_error('Could not access main validationTokenDB - addValidationTokenDB')
        res.sendStatus(401)
      } else {
        req.freezrValidationTokenDB = freezrValidationTokenDB
        next()
      }
    })
  } else if (req.params.action === 'validate') {
    const owner = req.query.data_owner_user
    if (!owner) {
      felog('No owner sent to validate')
      res.sendStatus(401)
    } else {
      // todo - also check in system db if the person exists
      dsManager.getorInitDb({ app_table: 'dev.ceps.contacts', owner }, {}, function (err, cepsContacts) {
        if (err) {
          helpers.state_error('Could not access cepsContacts - addValidationDBs')
          res.sendStatus(401)
        } else {
          req.freezrCepsContacts = cepsContacts
          dsManager.getorInitDb({ app_table: 'info.freezr.account.permissions', owner }, {}, function (err, freezrUserPermsDB) {
            if (err) {
              helpers.state_error('Could not access main freezrUserPermsDB - addUserAppsAndPermDBs')
              res.sendStatus(401)
            } else {
              req.freezrUserPermsDB = freezrUserPermsDB
              // VALIDATION_TOKEN_OAC used for internal verification (ie data)_owner_host same as requestor_host)
              dsManager.getorInitDb(VALIDATION_TOKEN_OAC, {}, function (err, freezrValidationTokenDB) {
                if (err) {
                  helpers.state_error('Could not access main validationTokenDB - addValidationTokenDB')
                  res.sendStatus(401)
                } else {
                  req.freezrValidationTokenDB = freezrValidationTokenDB
                  exports.addAppTokenDB(req, res, dsManager, next)
                }
              })
            }
          })
        }
      })
    }
  } else {
    felog('Invalid validation query ', req.query)
    res.sendStatus(401)
  }
}

exports.addMessageDb = function (req, res, dsManager, next) {
  // used for getall permission /v1/permissions/getall/:app_name and /v1/permissions/gethtml/:app_name'
  if (req.params.action === 'initiate') { // client to server
    // make sure app has sharing permission and conctact permission
    // record message in 'messages sent'
    // communicate it to the other person's server
    // ceps/messages/transmit
    const owner = req.freezrTokenInfo.requestor_id
    dsManager.getorInitDb({ app_table: 'dev.ceps.messages.sent', owner }, {}, function (err, sentMessages) {
      if (err) {
        helpers.state_error('Could not access sentMessages - addMessageDb')
        res.sendStatus(401)
      } else {
        req.freezrSentMessages = sentMessages
        if (req.body.recipient_host === req.body.sender_host) {
          getGotMessagesAndContactsFor(dsManager, req.body.recipient_id, function (err, gotMessagesDB, contactsDB) {
            if (err) {
              helpers.state_error('Could not access gotMessages - addMessageDb')
              res.sendStatus(401)
            } else {
              req.freezrOtherPersonGotMsgs = gotMessagesDB
              req.freezrOtherPersonContacts = contactsDB
              exports.addUserPermsAndRequesteeDB(req, res, dsManager, next)
            }
          })
        } else {
          exports.addUserPermsAndRequesteeDB(req, res, dsManager, next)
        }
      }
    })
  } else if (req.params.action === 'transmit') { // sender server to receipient server
    // see if is in contact db and if so can get the details
    // see if sender is in contacts - decide to keep it or not and to verify or not
    // record message in 'messages got'
    const owner = req.body.recipient_id
    dsManager.getorInitDb({ app_table: 'dev.ceps.messages.got', owner }, {}, function (err, gotMessages) {
      if (err) {
        helpers.state_error('Could not access sentMessages - addMessageDb')
        res.sendStatus(401)
      } else {
        req.freezrGotMessages = gotMessages
        dsManager.getorInitDb({ app_table: 'dev.ceps.contacts', owner }, {}, function (err, contactsDb) {
          if (err) {
            helpers.state_error('Could not access sentMessages - addMessageDb')
            res.sendStatus(401)
          } else {
            req.freezrCepsContacts = contactsDb
            next()
          }
        })
      }
    })
  } else if (req.params.action === 'verify') { // recipoient server to sender server
    // verify by pinging the sender server of the nonce and getting the info
    const owner = req.body.sender_id
    dsManager.getorInitDb({ app_table: 'dev.ceps.messages.sent', owner }, {}, function (err, sentMessages) {
      if (err) {
        helpers.state_error('Could not access sentMessages - addMessageDb')
        res.sendStatus(401)
      } else {
        req.freezrSentMessages = sentMessages
        next()
      }
    })
  } else if (req.params.action === 'get') { // client to server
    // get own messages
    const owner = req.freezrTokenInfo.requestor_id
    dsManager.getorInitDb({ app_table: 'dev.ceps.messages.got', owner }, {}, function (err, gotMessages) {
      if (err) {
        helpers.state_error('Could not access sentMessages - addMessageDb')
        res.sendStatus(401)
      } else {
        req.freezrGotMessages = gotMessages
        next()
      }
    })
  } else {
    felog('Invalid addMessageDb param ' + req.params.action)
    res.sendStatus(401)
  }
}
const getGotMessagesAndContactsFor = function (dsManager, owner, callback) {
  let gotMessageDb = null
  dsManager.getorInitDb({ app_table: 'dev.ceps.messages.got', owner }, {}, function (err, gotMessages) {
    if (err) {
      callback(err)
    } else {
      gotMessageDb = gotMessages
      dsManager.getorInitDb({ app_table: 'dev.ceps.contacts', owner }, {}, function (err, contactsDB) {
        if (err) {
          callback(err)
        } else {
          callback(null, gotMessageDb, contactsDB)
        }
      })
    }
  })
}
exports.addUserPermsAndRequesteeDB = function (req, res, dsManager, next) {
  // For changeNamedPermissions and shareRecords

  fdlog('perm handler addUserPermsAndRequesteeDB ', req.path)

  var requesteeAppTable, owner
  if (req.path.indexOf('permissions/change') > 0) {
    fdlog('req.body.changeList[0] ', req.body.changeList[0])
    requesteeAppTable = req.body.changeList[0].table_id
    owner = req.session.logged_in_user_id
  } else if (req.path.indexOf('perms/share_records') > 0) {
    requesteeAppTable = req.body.table_id
    owner = req.freezrTokenInfo.owner_id
  } else if (req.path.indexOf('ceps/message/initiate') > 0) {
    requesteeAppTable = req.body.table_id
    owner = req.freezrTokenInfo.requestor_id
  }

  fdlog('addUserPermsAndRequesteeDB ', { requesteeAppTable, owner })
  dsManager.getorInitDb({ app_table: requesteeAppTable, owner }, {}, function (err, freezrRequesteeDB) {
    if (err) {
      felog('addUserPermsAndRequesteeDB', 'Could not access main freezrRequesteeDB  - addUserPermsAndRequesteeDB', err)
      res.sendStatus(401)
    } else if (!freezrRequesteeDB || !freezrRequesteeDB.read_by_id) {
      console.error('Could not access requested db in addUserPermsAndRequesteeDB- err for ' + requesteeAppTable + ' and owner ' + owner)
      res.sendStatus(401)
    } else {
      req.freezrRequesteeDB = freezrRequesteeDB

      dsManager.getorInitDb({ app_table: 'info.freezr.account.permissions', owner }, {}, function (err, freezrUserPermsDB) {
        if (err) {
          felog('addUserPermsAndRequesteeDB', 'Could not access main freezrUserPermsDB db - addUserPermsAndRequesteeDB', err)
          res.sendStatus(401)
        } else {
          req.freezrUserPermsDB = freezrUserPermsDB

          dsManager.getorInitDb({ app_table: 'dev.ceps.contacts', owner }, {}, function (err, cepsContacts) {
            if (err) {
              felog('addUserPermsAndRequesteeDB', 'Could not access main cepsContacts  - addUserPermsAndRequesteeDB', err)
              res.sendStatus(401)
            } else {
              req.freezrCepsContacts = cepsContacts
              dsManager.getorInitDb({ app_table: 'dev.ceps.groups', owner }, {}, function (err, cepsGroups) {
                if (err) {
                  felog('addUserPermsAndRequesteeDB', 'Could not access main cepsGroups  - addUserPermsAndRequesteeDB', err)
                  res.sendStatus(401)
                } else {
                  req.freezrCepsGroups = cepsGroups
                  next()
                }
              })
            }
          })
        }
      })
    }
  })
}

const getDbs = function (dsManager, dbsToGet, callback) {
  // dbsToGet is an object of key = db name to be added to req,
  // .. and value: {owner, app_table}
  console.log('this is not wroking - to fix')
  // NOTE - NEEDS TO BE DEBUGGED
  var dblist = []
  var gottenDBs = {}
  for (const key in dbsToGet) dblist.push(key)
  async.forEach(dblist, function (key, cb2) {
    dsManager.getorInitDb(dbsToGet[key], {}, function (err, theDB) {
      if (err) {
        felog('getDbs', 'Could not access db', key, err)
        // cb2(err)
      } else {
        gottenDBs[key] = theDB
        // cb2()
      }
    }, function (err) {
      callback(err, gottenDBs)
    })
  })
}

exports.addUserDs = function (req, res, dsManager, next) {
  const owner = req.freezrTokenInfo.owner_id

  dsManager.getOrSetUserDS(owner, function (err, userDS) {
    if (err) felog('addUserDs', 'addUserOrAdmin err for ' + owner, err)
    req.freezrUserDS = userDS
    req.freezrAttributes = { requesting_owner_id: owner }
    next()
  })
}
exports.addFradminDs = function (req, res, dsManager, next) {
  const userId = req.session.logged_in_user_id
  if (req.session.logged_in_as_admin && userId && userId === req.freezrTokenInfo.requestor_id) {
    // todo recheck user list to make sure owner is actually an admin
    const owner = 'fradmin'

    const userDb = dsManager.getDB(USER_DB_OAC)

    async.waterfall([
      // 1. get userId
      function (cb) {
        userDb.query({ user_id: userId }, null, cb)
      },

      // 2. check the password
      function (results, cb) {
        var u = new User(results[0])
        // fdlog('got user ', u)
        if (!results || results.length === 0 || results.length > 1) {
          cb(helpers.auth_failure('perm_handler.js', exports.version, 'addFradminDs', 'funky error'))
        } else if (!u.isAdmin) {
          felog('addFradminDs', 'non admin user tryong to access admin tasks user ' + userId)
          cb(helpers.auth_failure('perm_handler.js', exports.version, 'addFradminDs', 'non admin trying to conduct admin tasks'))
        } else {
          cb(null)
        }
      },
      function (cb) {
        dsManager.getOrSetUserDS(owner, cb)
      }
    ], function (err, userDS) {
      if (err) {
        felog('addFradminDs', 'err for ' + owner, err)
      } else {
        req.freezrFradminDS = userDS
        req.freezrAttributes = { requesting_owner_id: req.freezrTokenInfo.owner_id }
        next()
      }
    })
  } else {
    res.sendStatus(401)
  }
}
const USER_DB_OAC = {
  app_name: 'info.freezr.admin',
  collection_name: 'users',
  owner: 'fradmin'
}
exports.addAllUsersDb = function (req, res, dsManager, next) {
  req.allUsersDb = dsManager.getDB(USER_DB_OAC)
  next()
}

exports.addPublicRecordsDB = function (req, res, dsManager, next) {
  // used by shareRecords in which case req.body.grantees.includes("public")
  // or /v1/permissions/change
  fdlog('addPublicRecordsDB for adding freezrPublicPermDB ', req.originalUrl)
  dsManager.getorInitDb({ app_table: 'info.freezr.admin.public_records', owner: 'fradmin' }, {}, function (err, freezrPublicRecordsDB) {
    if (err) {
      helpers.state_error('Could not access main freezrPublicRecordsDB db - addPublicRecordsDB')
      res.sendStatus(401)
    } else if (!freezrPublicRecordsDB || !freezrPublicRecordsDB.query) {
      helpers.state_error('Could not initiate main freezrPublicRecordsDB db - addPublicRecordsDB')
      console.warn('could not initiate ', { freezrPublicRecordsDB })
      res.sendStatus(401)
    } else {
      req.freezrPublicRecordsDB = freezrPublicRecordsDB
      dsManager.getorInitDb({ app_table: 'info.freezr.admin.public_manifests', owner: 'fradmin' }, {}, function (err, freezrPublicManifestsDB) {
        if (err) {
          helpers.state_error('Could not access main freezrPublicPermDB db - addPublicRecordsDB')
          res.sendStatus(401)
        } else if (!freezrPublicManifestsDB || !freezrPublicManifestsDB.read_by_id) {
          console.warn('error intiating freezrPublicManifestsDB')
          res.sendStatus(401)
        } else {
          // got and added freezrPublicPermDB
          // 'NOW add from manifest: meta, public pages and cards
          // this will also be used to okay accessing public files
          req.freezrPublicManifestsDb = freezrPublicManifestsDB
          if (req.path.indexOf('permissions/change') > 0) {
            // todo security above should be starts with /v1/permissions/change
            dsManager.getOrInitUserAppFS(req.session.logged_in_user_id, req.freezrRequestorManifest.identifier, {}, (err, appFs) => {
              if (err || !appFs) {
                felog('addPublicRecordsDB', 'handle error getting appFs for user ', req.session.logged_in_user_id, ' and app: ', req.freezrRequestorManifest.identifier, { err })
                next()
              } else {
                var permlist = []
                var cards = {}
                var ppages = {}
                for (const [permName, permObj] of Object.entries(req.freezrRequestorManifest.permissions)) {
                  fdlog('building card for ', { permName, permObj })
                  if (permObj.pcard || (permObj.ppage && req.freezrRequestorManifest.public_pages[permObj.ppage])) {
                    if (!permObj.name) {
                      felog('this should not happen', { permName, permObj })
                      permObj.name = permName
                    }
                    permlist.push(permObj)
                  }
                }
                // fdlog(permlist)

                async.forEach(permlist, function (aPerm, cb2) {
                  if (aPerm.pcard) {
                    appFs.readAppFile('public/' + aPerm.pcard, null, (err, theCard) => {
                      if (err) {
                        felog('addPublicRecordsDB', 'handle error reading card for ', { aPerm, err })
                      } else {
                        cards[aPerm.name] = theCard
                      }
                      cb2(null)
                    })
                  } else {
                    cb2(null)
                  }
                },
                function (err) {
                  if (err) {
                    felog('addPublicRecordsDB', 'need to handle err in creating freezrPublicManifestsDb: ' + err)
                  }
                  // fdlog('cards got, ', { cards })
                  req.freezrPublicCards = cards
                  async.forEach(permlist, function (aPerm, cb2) {
                    if (aPerm.ppage && req.freezrRequestorManifest.public_pages[aPerm.ppage] && req.freezrRequestorManifest.public_pages[aPerm.ppage].html_file) {
                      appFs.readAppFile('public/' + req.freezrRequestorManifest.public_pages[aPerm.ppage].html_file, null, (err, thePage) => {
                        if (err) {
                          felog('addPublicRecordsDB', 'handle error reading card for ', { aPerm, err })
                        } else {
                          ppages[aPerm.name] = thePage
                        }
                        cb2(null)
                      })
                    } else {
                      cb2(null)
                    }
                  },
                  function (err) {
                    if (err) {
                      felog('addPublicRecordsDB', 'need to handle err in creating freezrPublicManifestsDb: ' + err)
                    }
                    fdlog('ppages got, ', { ppages })
                    req.freezrPublicPages = ppages
                    next()
                  })
                })
              }
            })
          } else { //   'permissions/change'
            next()
          }
        }
      })
    }
  })
}
exports.addPublicRecordAndIfFileFileFS = function (req, res, dsManager, next) {
  //   app.get('/ppage/:user_id/:app_table/:data_object_id', publicUserPage, addPublicRecordAndIfFileFileFS, publicHandler.generateSingleObjectPage)
  //  app.get('/ppage/:object_public_id', publicUserPage, addPublicRecordAndIfFileFileFS, publicHandler.generateSingleObjectPage)
  // app.get('*')

  fdlog('addPublicRecordAndIfFileFileFS for adding freezrPublicPermDB ', req.originalUrl)
  if (!helpers.startsWith(req.path, '/ppage/')) { // ie path ~ '/*'
    req.params.object_public_id = decodeURI(req.path.slice(1))
  } else if (!req.params.object_public_id) { // ie path = /ppage/:user_id/:app_table/:data_object_id
    if (req.params.user_id && req.params.app_table && req.params.data_object_id) {
      req.params.object_public_id = req.params.user_id + '/' + req.params.app_table + '/' + req.params.data_object_id
    }
  }

  async.waterfall([
    // 1. get public records
    function (cb) {
      if (!req.params.object_public_id) {
        cb(new Error('invalid url'))
      } else {
        cb(null)
      }
    },
    function (cb) {
      dsManager.getorInitDb({ app_table: 'info.freezr.admin.public_records', owner: 'fradmin' }, {}, cb)
    },
    function (freezrPublicRecordsDB, cb) {
      req.freezrPublicRecordsDB = freezrPublicRecordsDB
      cb(null)
    },
    // 2. get manifests (neededed?)
    function (cb) {
      dsManager.getorInitDb({ app_table: 'info.freezr.admin.public_manifests', owner: 'fradmin' }, {}, cb)
    },
    function (freezrPublicManifestsDB, cb) {
      req.freezrPublicManifestsDb = freezrPublicManifestsDB
      cb(null)
    },
    // 3. get record
    function (cb) {
      req.freezrPublicRecordsDB.query({ _id: req.params.object_public_id }, {}, cb)
    },
    function (items, cb) {
      if (!items || items.length === 0) {
        if (helpers.endsWith(req.params.object_public_id, '.html')) {
          req.params.object_public_id = req.params.object_public_id.slice(0, -5)
          req.freezrPublicRecordsDB.query({ _id: req.params.object_public_id }, {}, function (err, items) {
            if (err) {
              cb(err)
            } else if (!items || items.length === 0) {
              cb(new Error('Public id not found'))
            } else {
              req.freezrPublicObject = items[0]
              cb(null)
            }
          })
        } else {
          cb(new Error('Public id not found'))
        }
      } else {
        req.freezrPublicObject = items[0]
        cb(null)
      }
    },

    // 4. if a file, get the file db
    function (cb) {
      if (helpers.endsWith(req.freezrPublicObject.original_app_table, '.files') && !req.freezrPublicObject.isHtmlMainPage) {
        // if isHtmlMainPage then the file content is in the record
        dsManager.getOrSetUserDS(req.freezrPublicObject.data_owner, function (err, userDS) {
          if (err) {
            cb(err)
          } else {
            let appName = req.freezrPublicObject.original_app_table.split('.')
            appName.pop() // '.files'
            appName = appName.join('.')
            userDS.getorInitAppFS(appName, {}, function (err, appFS) {
              if (err) {
                cb(err)
              } else {
                req.freezrUserFS = appFS
                cb(null)
              }
            })
          }
        })
      } else {
        cb(null)
      }
    }
  ], function (err) {
    if (err) {
      console.warn('COuld not get public page ' + req.params.object_public_id, err)
      res.redirect('/public') // redirecting here to avoidinfinite loop in case redirected public page is missing
    } else {
      next()
    }
  })
}
exports.addoAuthers = function (req, res, dsManager, next) {
  // used by shareRecords in which case req.body.grantees.includes("public")
  // or /v1/permissions/change
  fdlog('addoAuthers ', req.originalUrl)
  dsManager.getorInitDb({ app_table: 'info.freezr.admin.oauthors', owner: 'fradmin' }, {}, function (err, oAuthorDb) {
    if (err) {
      helpers.state_error('Could not access main oAuthorDb db - addoAuthers')
      res.sendStatus(401)
    } else {
      req.freezrOauthorDb = oAuthorDb
      next()
    }
  })
}
exports.addPublicFs = function (req, res, dsManager, next) {
  // this is not used 2021-10
  dsManager.getOrInitUserAppFS('public', 'info.freezr.public', {}, (err, appFs) => {
    if (err || !appFs) {
      felog('addPublicFs', 'handle error getting public appFs', { err })
      res.sendStatus(401)
    } else {
      req.freezrPublicAppFS = appFs
      next()
    }
  })
}


exports.addPublicUserFs = function (req, res, dsManager, next) {
  fdlog('addPublicUserFs ', req.params)
  req.freezrPublicManifestsDb.query({ user_id: req.params.user_id, app_name: req.params.app_name }, null, (err, results) => {
    if (err || !results || results.length === 0) { // fdlog todo - also add results[0].granted??
      res.sendStatus(401)
    } else {
      req.freezrPublicManifest = results[0]
      dsManager.getOrSetUserDS(req.params.user_id, function (err, userDS) {
        if (err) {
          res.sendStatus(401)
        } else {
          userDS.getorInitAppFS(req.params.app_name, {}, function (err, appFS) {
            if (err) {
              felog('addPublicUserFs', 'err get-setting app-fs', err)
              res.sendStatus(401)
            } else {
              req.freezrAppFS = appFS
              next()
            }
          })
        }
      })
    }
  })
}
exports.addUserFs = function (req, res, dsManager, next) {
  fdlog('addUserFs ', req.params)
  dsManager.getOrSetUserDS(req.params.user_id, function (err, userDS) {
    if (err) {
      res.sendStatus(401)
    } else {
      userDS.getorInitAppFS(req.params.app_name, {}, function (err, appFS) {
        if (err) {
          felog('addUserFs', 'err get-setting app-fs', err)
          res.sendStatus(401)
        } else {
          req.freezrAppFS = appFS
          next()
        }
      })
    }
  })
}
exports.addUserFsFromTokenInfo = function (req, res, dsManager, next) {
  // /feps/perms/share_records
  dsManager.getOrInitUserAppFS(req.session.logged_in_user_id, req.freezrTokenInfo.app_name, {}, (err, appFs) => {
    if (err || !appFs) {
      felog('addPublicFsAnduserFs', 'handle error getting appFs for user ', req.session.logged_in_user_id, ' and app: ', req.freezrTokenInfo.app_name, { err })
      res.sendStatus(401)
    } else {
      req.freezrUserAppFS = appFs
      next()
    }
  })
}
exports.addUserFilesDb = function (req, res, dsManager, next) {
  fdlog('addUserFilesDb', 'todo - review this - not checked')
  const oat = {
    owner: req.params.user_id,
    app_table: req.params.app_name + '.files'
  }
  dsManager.getorInitDb(oat, {}, function (err, userFilesDb) {
    if (err) {
      res.sendStatus(401)
    } else if (!userFilesDb || !userFilesDb.read_by_id) {
      console.warn('error reading userFilesDb fir ', { oat })
      res.sendStatus(401)
    } else {
      req.freezruserFilesDb = userFilesDb
      next()
    }
  })
}

exports.selfRegAdds = function (req, res, dsManager, next) {
  fdlog('selfRegAdds ', req.body)
  if (req.body && req.body.action === 'checkresource') {
    next()
  } else if (dsManager.freezrIsSetup) {
    req.freezrAllUsersDb = dsManager.getDB(USER_DB_OAC)
    req.freezrIsSetup = dsManager.freezrIsSetup
    if (req.session.logged_in_user_id) { // resetting newParams for logged in user
      dsManager.getOrSetUserDS(req.session.logged_in_user_id, function (err, userDS) {
        if (!err || err.message !== 'user incomplete') {
          res.sendStatus(401)
        } else {
          req.freezrUserDS = userDS
          next()
        }
      })
    } else {
      next()
    }
  } else { // first setup
    req.freezrDsManager = dsManager
    next()
    // add fradmin => users
  }
}

// Loggers
const LOG_ERRORS = true
const felog = function (...args) { if (LOG_ERRORS) helpers.warning('perm_handler.js', exports.version, ...args) }
const LOG_DEBUGS = false
const fdlog = function (...args) { if (LOG_DEBUGS) console.log(...args) }
