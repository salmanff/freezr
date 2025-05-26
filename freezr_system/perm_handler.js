// freezr.info - nodejs system files - perm_handler

exports.version = '0.0.200'
 
/* global User */

const helpers = require('./helpers.js')
const microservices = require('./microservices.js')
const async = require('async')

// dsManager.getorInitDb({app_table: 'info.freezr.account.app_list', owner: freezrAttributes.owner_user_id}, {}, function(err, requesteeAppListDB) {})

exports.readWriteUserData = function (req, res, dsManager, next) {
  // assume token info in in req.freezrTokenInfo => {userId, appName, loggedIn}
  fdlog('readWriteUserData ')

  const freezrAttributes = {
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
  freezrAttributes.owner_user_id = req.body.owner_id || req.freezrTokenInfo.owner_id

  if (!req.params) req.params = {}
  if (!req.query) req.query = {}
  freezrAttributes.permission_name = req.params.permission_name /* for files get */ || req.body.permission_name /* for CEPS get */

  const requestFile = helpers.startsWith(req.path, '/feps/getuserfiletoken') || helpers.startsWith(req.path, '/feps/upload/')// /feps/getuserfiletoken
  if (requestFile) {
    req.params.app_table = req.params.app_name + '.files'
    freezrAttributes.owner_user_id = req.params.user_id // 2025 -> to check 
  }

  if (!freezrAttributes.owner_user_id) freezrAttributes.owner_user_id = freezrAttributes.requestor_user_id

  // for admin
  if (req.body.appName === 'info.freezr.admin' && req.session.logged_in_as_admin && helpers.SYSTEM_ADMIN_APPTABLES.indexOf(req.params.app_table.replace(/\./g, '_')) > -1) freezrAttributes.requestor_user_id = 'fradmin'
  // todo - clean up so the permissions are more structures (2023) - also on readpremissions in app_handler
  if (req.session.logged_in_as_admin && helpers.SYSTEM_ADMIN_APPTABLES.indexOf(req.params.app_table.replace(/\./g, '_')) > -1) freezrAttributes.owner_user_id = 'fradmin'

  fdlog(' req.session.logged_in_as_admin ', req.session.logged_in_as_admin, 'req.params.app_table ', req.params.app_table, { freezrAttributes })

  const getDbTobeRead = function () {
    fdlog('getDbTobeRead ', { freezrAttributes })
    dsManager.getorInitDb({ app_table: req.params.app_table, owner: freezrAttributes.owner_user_id }, { freezrPrefs: req.freezrPrefs }, function (err, freezrRequesteeDB) {
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
    freezrAttributes.actualRequester = 'info.freezr.account'
    freezrAttributes.requestor_app = req.body.appName || req.params.app_table // eithr query or aq ceps.dev
    freezrAttributes.own_record = true
    freezrAttributes.record_is_permitted = true
    getDbTobeRead()
  } else if (['dev.ceps.messages.got', 'dev.ceps.messages.sent'].includes(req.params.app_table) &&
    ((helpers.startsWith(req.path, '/feps/query') && req.body.q && req.body.q.app_id && req.body.q.app_id && req.body.q.app_id === req.freezrTokenInfo.app_name) ||
     (helpers.startsWith(req.path, '/ceps/query') && req.query && req.query.app_id && req.query.app_id === req.freezrTokenInfo.app_name))) {
    // Each app can query its own messages. (For other app messages, a permission is required)
    freezrAttributes.own_record = true
    freezrAttributes.record_is_permitted = true
    getDbTobeRead()
  } else {
    dsManager.getUserPerms(freezrAttributes.owner_user_id, { freezrPrefs: req.freezrPrefs }, function (err, permDB) {
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
          dbQuery.name = freezrAttributes.permission_name
        }

        if (freezrAttributes.owner_user_id === 'public') {
          freezrAttributes.grantedPerms = []
          SYSTEM_PERMS.forEach(sysPerm => {
            if (req.params.app_table === sysPerm.table_id && (!sysPerm.requestor_app || sysPerm.requestor_app === freezrAttributes.requestor_app)) freezrAttributes.grantedPerms.push(sysPerm)
          })
          getDbTobeRead()
        } else {
          permDB.query(dbQuery, {}, function (err, grantedPerms) {
            if (err) {
              helpers.error('Error doing query -  read_by_id_perms')
              res.sendStatus(401)
            } else {
              // [2021 - groups] freezrAttributes.reader
              fdlog('permDB dbQuery ', { dbQuery, grantedPerms, freezrAttributes })
              freezrAttributes.grantedPerms = grantedPerms
              getDbTobeRead()
            }
          })
        }
      }
    })
  }
}

exports.microservicePerms = async function (req, res, dsManager, next) {
  // assume token info in in req.freezrTokenInfo => {requestor_id, app_name, loggedIn}
  fdlog('readWriteUserData ', { freezrTokenInfo: req.freezrTokenInfo, body: req.body })

  const freezrAttributes = { }

  freezrAttributes.requestor_app = req.freezrTokenInfo?.app_name
  freezrAttributes.requestor_user_id = req.freezrTokenInfo?.requestor_id
  freezrAttributes.owner_user_id = freezrAttributes.requestor_user_id
  freezrAttributes.permission_name = req.body?.permission_name

  // for serverless
  const permQuery = {
    requestor_app: freezrAttributes.requestor_app,
    granted: true,
    permission_name: freezrAttributes.permission_name
  }

  try {
    if (microservices.LOCAL_FUNCTIONS.includes(req.params.task)) {
      if (!req.session.logged_in_as_admin && microservices.ADMIN_FUNCTIONS.includes(req.params.action)) throw new Error('uploading microservices can only be done by admin users')
      // todo - consider adding permissions for users to invoke locally
    } else {
      const permDB = await dsManager.async.getUserPerms(freezrAttributes.owner_user_id, { freezrPrefs: req.freezrPrefs })
      // const permDB = await dsManager.asyncGetUserPerms(freezrAttributes.owner_user_id, { freezrPrefs: req.freezrPrefs })
      const perms = permDB.async.query(permQuery, {})
      if (!perms || perms.length === 0) {
        throw new Error('no permission found')
      }
      freezrAttributes.permisson = perms[0]

      freezrAttributes.slParams = await dsManager.async.getUserSlParams(freezrAttributes.owner_user_id, { freezrPrefs: req.freezrPrefs })
    } 
    // permission has been granted
    if (req.body.read_collection_name) {
      freezrAttributes.freezrDbs = {}
      // todo - should do for each collection_name in an array or object
      const appTableName = req.freezrTokenInfo.app_name + '.' + req.body.read_collection_name
      freezrAttributes.freezrDbs[req.body.read_collection_name] = await dsManager.async.getorInitDb({ app_table: appTableName, owner: freezrAttributes.owner_user_id }, { freezrPrefs: req.freezrPrefs })
      // const testqueryresults = await freezrAttributes.freezrDbs[req.body.read_collection_name].async.query({}, {})
      // console.log('testquery', { appTableName, owner: freezrAttributes.owner_user_id, testqueryresults })
    }
    req.freezrAttributes = freezrAttributes
    next()
  } catch (e) {
    felog('microservicePerms', 'error in getting db', e)
    res.sendStatus(401)
  }

}

exports.addUserAppsAndPermDBs = function (req, res, dsManager, next) {
  // user_apps - used for account APIs
  dsManager.getorInitDb({ app_table: 'info.freezr.account.app_list', owner: req.session.logged_in_user_id }, { freezrPrefs: req.freezrPrefs }, function (err, freezrUserAppListDB) {
    if (err) {
      felog('addUserAppsAndPermDBs', 'Could not access main freezrUserAppListDB - addUserAppsAndPermDBs - redirect', err)
      res.redirect('/admin/public/starterror?error=couldNotAccessADb&errSource=userAppList&errorDetail=' + err)
    } else {
      req.freezrUserAppListDB = freezrUserAppListDB
      dsManager.getorInitDb({ app_table: 'info.freezr.account.permissions', owner: req.session.logged_in_user_id }, { freezrPrefs: req.freezrPrefs }, function (err, freezrUserPermsDB) {
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
  dsManager.getorInitDb({ app_table: 'info.freezr.account.permissions', owner: req.freezrTokenInfo.owner_id }, { freezrPrefs: req.freezrPrefs }, function (err, freezrUserPermsDB) {
    if (err) {
      helpers.state_error('Could not access main freezrUserPermsDB - addUserAppsAndPermDBs')
      res.sendStatus(401)
    } else {
      req.freezrUserPermsDB = freezrUserPermsDB
      if (req.query?.owner && req.query?.owner !== req.freezrTokenInfo.requestor_id) {
        dsManager.getorInitDb({ app_table: 'info.freezr.account.permissions', owner: req.query?.owner }, { freezrPrefs: req.freezrPrefs }, function (err, freezrDataOwnerPermsDB) {
          if (err) {
            helpers.state_error('Could not access main freezrUserPermsDB - addUserAppsAndPermDBs')
            req.freezrDataOwnerPermsDB = null
            next()
          } else {
            req.freezrDataOwnerPermsDB = freezrDataOwnerPermsDB
            next()
          }
        })
      } else {
        next()
      }
    }
  })
}
const APP_TOKEN_OAC = {
  app_name: 'info.freezr.admin',
  collection_name: 'app_tokens',
  owner: 'fradmin'
}
exports.addAppTokenDB = function (req, res, dsManager, next) {
  //  app.get('/v1/account/apppassword/generate', accountLoggedInAPI, addAppTokenDB, accountHandler.app_password_generate_one_time_pass)
  //   app.get('/v1/account/apppassword/updateparams', accountLoggedInAPI, addAppTokenDB, accountHandler.app_password_update_params)
  dsManager.getorInitDb(APP_TOKEN_OAC, { freezrPrefs: req.freezrPrefs }, function (err, freezrAppTokenDB) {
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
    // onsole.log('addValidationDBs set or verify')
    dsManager.getorInitDb(VALIDATION_TOKEN_OAC, { freezrPrefs: req.freezrPrefs }, function (err, freezrValidationTokenDB) {
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
      dsManager.getorInitDb({ app_table: 'dev.ceps.contacts', owner }, { freezrPrefs: req.freezrPrefs }, function (err, cepsContacts) {
        if (err) {
          helpers.state_error('Could not access cepsContacts - addValidationDBs')
          res.sendStatus(401)
        } else {
          req.freezrCepsContacts = cepsContacts
          dsManager.getorInitDb({ app_table: 'info.freezr.account.permissions', owner }, { freezrPrefs: req.freezrPrefs }, function (err, freezrUserPermsDB) {
            if (err) {
              helpers.state_error('Could not access main freezrUserPermsDB - addUserAppsAndPermDBs')
              res.sendStatus(401)
            } else {
              req.freezrUserPermsDB = freezrUserPermsDB
              // VALIDATION_TOKEN_OAC used for internal verification (ie data)_owner_host same as requestor_host)
              dsManager.getorInitDb(VALIDATION_TOKEN_OAC, { freezrPrefs: req.freezrPrefs }, function (err, freezrValidationTokenDB) {
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
  // app.post('/ceps/message/:action', possibleUserAPIForMessaging, addMessageDb, appHandler.messageActions)
  if (req.params.action === 'initiate') { // client to server
    // make sure app has sharing permission and conctact permission
    // record message in 'messages sent'
    // communicate it to the other person's server
    // ceps/messages/transmit
    const owner = req.freezrTokenInfo.requestor_id
    dsManager.getorInitDb({ app_table: 'dev.ceps.messages.sent', owner }, { freezrPrefs: req.freezrPrefs }, function (err, sentMessages) {
      if (err) {
        helpers.state_error('Could not access sentMessages - addMessageDb')
        res.sendStatus(401)
      } else {
        req.freezrSentMessages = sentMessages
        dsManager.getorInitDb({ app_table: 'dev.ceps.messages.got', owner }, { freezrPrefs: req.freezrPrefs }, function (err, gotMessages) {
          if (err) {
            helpers.state_error('Could not access sentMessages - addMessageDb')
            res.sendStatus(401)
          } else {
            req.freezrGotMessages = gotMessages
            getGotMessagesAndContactsFor(dsManager, req.body, req.freezrCepsGroups, req.freezrPrefs, function (err, gotMessageDbs, contactsDBs, simpleRecipients, badContacts) {
              if (err) {
                helpers.state_error('Could not access gotMessages - addMessageDb')
                res.sendStatus(401)
              } else {
                req.freezrOtherPersonGotMsgs = gotMessageDbs
                req.freezrOtherPersonContacts = contactsDBs
                req.freezrMessageRecipients = simpleRecipients
                req.freezrBadContacts = badContacts
                next()
                // exports.addUserPermsAndRequesteeDB(req, res, dsManager, next)
              }
            })
          }
        })

        // if (!req.body.recipient_host) { // || req.body.recipient_host === req.body.sender_host
        //   getGotMessagesAndContactsFor(dsManager, req.body.recipient_id, function (err, gotMessagesDB, contactsDB) {
        //     if (err) {
        //       helpers.state_error('Could not access gotMessages - addMessageDb')
        //       res.sendStatus(401)
        //     } else {
        //       req.freezrOtherPersonGotMsgs = gotMessagesDB
        //       req.freezrOtherPersonContacts = contactsDB
        //       exports.addUserPermsAndRequesteeDB(req, res, dsManager, next)
        //     }
        //   })
        // } else {
        //   exports.addUserPermsAndRequesteeDB(req, res, dsManager, next)
        // }
      }
    })
  } else if (req.params.action === 'transmit') { // sender server to receipient server
    // see if is in contact db and if so can get the details
    // see if sender is in contacts - decide to keep it or not and to verify or not
    // record message in 'messages got'
    const owner = req.body.recipient_id
    dsManager.getorInitDb({ app_table: 'dev.ceps.messages.got', owner }, { freezrPrefs: req.freezrPrefs }, function (err, gotMessages) {
      if (err) {
        helpers.state_error('Could not access sentMessages - addMessageDb')
        res.sendStatus(401)
      } else {
        req.freezrGotMessages = gotMessages
        dsManager.getorInitDb({ app_table: 'dev.ceps.contacts', owner }, { freezrPrefs: req.freezrPrefs }, function (err, contactsDb) {
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
    dsManager.getorInitDb({ app_table: 'dev.ceps.messages.sent', owner }, { freezrPrefs: req.freezrPrefs }, function (err, sentMessages) {
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
    dsManager.getorInitDb({ app_table: 'dev.ceps.messages.got', owner }, { freezrPrefs: req.freezrPrefs }, function (err, gotMessages) {
      if (err) {
        helpers.state_error('Could not access gotMessages - addMessageDb')
        res.sendStatus(401)
      } else {
        req.freezrGotMessages = gotMessages
        next()
      }
    })
  } else if (req.params.action === 'mark_read') { // client to server
    // get own messages
    const owner = req.freezrTokenInfo.requestor_id
    dsManager.getorInitDb({ app_table: 'dev.ceps.messages.got', owner }, { freezrPrefs: req.freezrPrefs }, function (err, gotMessages) {
      if (err) {
        helpers.state_error('Could not access gotMessages - addMessageDb')
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
const getGotMessagesAndContactsFor = function (dsManager, body, freezrCepsGroups, freezrPrefs, callback) {
  // onsole.log('getGotMessagesAndContactsFor', { body, freezrCepsGroups })
  const nowGetDBs = function (dsManager, body, recipients, callback) {
    const gotMessageDbs = {}
    const contactsDBs = {}
    const badContacts = []
    const simpleRecipients = []
    
    async.forEach(recipients, function (recipient, cb2) {
      if (typeof recipient === 'string') {
        console.warn('currently only handling objects of receipients')
        badContacts.push({ recipient_id: recipient, err: 'Object expected and got string' })
        cb2(null)
      } else if (!recipient.recipient_id) {
        badContacts.push({ recipient_host: recipient.recipient_host, err: 'no recipient_id' })
        cb2(null)
      } else {
        // const parts = member.split('@')
        // const owner = parts[0]
        // const serverurl = parts > 1 ? parts[1] : null
        simpleRecipients.push({ recipient_id: recipient.recipient_id, recipient_host: recipient.recipient_host })

        if (!recipient.recipient_host || recipient.recipient_host === body.sender_host) {
          dsManager.getorInitDb({ app_table: 'dev.ceps.messages.got', owner: recipient.recipient_id }, { freezrPrefs }, function (err, gotMessages) {
            if (err) {
              badContacts.push({ recipient_id: recipient.recipient_id, err: (err?.message || 'unknown err getting ciotnact messages') })
              cb2(null)
            } else {
              gotMessageDbs[recipient.recipient_id] = gotMessages
              dsManager.getorInitDb({ app_table: 'dev.ceps.contacts', owner: recipient.recipient_id }, { freezrPrefs }, function (err, contactsDB) {
                if (err) {
                  badContacts.push({ recipient_id: recipient.recipient_id, err: (err?.message || 'unknown err getting ciotnact db')  })
                  cb2(null)
                } else {
                  contactsDBs[recipient.recipient_id] = contactsDB
                  cb2(null)
                }
              })
            }
          })
        } else {
          cb2(null)
        }
      }
    }, function (err) {
      if (err) {
        callback(err)
      } else {
        callback(null, gotMessageDbs, contactsDBs, simpleRecipients, badContacts)
      }
    })
  }

  if (body.recipient_id) {
    // const groupMembers = [(body.recipient_id + (body.recipient_host ? ('@' + body.recipient_host) : ''))]
    const groupMembers = [{ recipient_id: body.recipient_id, recipient_host: body.recipient_host }]
    nowGetDBs(dsManager, body, groupMembers, callback)
  } else if (body.recipients) {
    nowGetDBs(dsManager, body, body.recipients, callback)
  // } else if (body.group_members) {
  //   nowGetDBs(dsManager, body, body.group_members, callback)
  } else if (body.group_name && typeof body.group_name === 'string') {
    freezrCepsGroups.query({ name: body.group_name }, null, function (err, groups) {
      if (err) {
        callback(err)
      } else if (!groups || groups.length < 1) {
        callback(new Error('No groups found'))
      } else {
        if (groups.length > 1) { console.warn('snbh - found 2 groups of same name') }
        nowGetDBs(dsManager, body, groups[0].members, callback)
      }
    })
  } else {
    callback(new Error('Wrong member parameters'))
  }
}
exports.addUserPermsAndRequesteeDB = function (req, res, dsManager, next) {
  // For changeNamedPermissions and shareRecords

  fdlog('perm handler addUserPermsAndRequesteeDB path ', req.path, 'body ', req.body, req.freezrTokenInfo)
  
  let requesteeAppTable, owner
  let getListOfItems = false
  let mayNotNeedTableId = false
  // todo - above ugly - better way to do this

  if (req.path.indexOf('permissions/change') > 0) {
    requesteeAppTable = req.body.change.table_id
    owner = req.session.logged_in_user_id
    if (Array.isArray((requesteeAppTable))) getListOfItems = true
  } else if (req.path.indexOf('perms/share_records') > 0) {
    requesteeAppTable = req.body.table_id
    owner = req.freezrTokenInfo.owner_id
    mayNotNeedTableId = true // May not need a table if it is a read_all for example
  } else if (req.path.indexOf('ceps/message/initiate') > 0) {
    requesteeAppTable = req.body.table_id
    owner = req.freezrTokenInfo.requestor_id
  } else if (req.path.indexOf('ceps/message/transmit') > 0) {
    requesteeAppTable = 'dev.ceps.messages.got'
    owner = req.body.recipient_id
  } else if (req.path.indexOf('ceps/message/mark_read') > 0) {
    requesteeAppTable = 'dev.ceps.messages.got'
    owner = req.freezrTokenInfo.requestor_id
  } else if (req.path.indexOf('ceps/message/verify') > 0) {
    requesteeAppTable = 'dev.ceps.messages.sent'
    owner = req.body.sender_id
  }
  // onsole.log('addUserPermsAndRequesteeDB ', { requesteeAppTable, owner, path: req.path, tokeninfo: req.freezrTokenInfo })

  fdlog('addUserPermsAndRequesteeDB ', { requesteeAppTable, owner })
  const oac = getListOfItems ? { app_tables: requesteeAppTable, owner } : { app_table: requesteeAppTable, owner }
  dsManager.getorInitDbs(oac, { freezrPrefs: req.freezrPrefs }, function (err, freezrRequesteeDB) {
    if (!mayNotNeedTableId && err) {
      felog('addUserPermsAndRequesteeDB', 'Could not access main freezrRequesteeDB  - addUserPermsAndRequesteeDB', err)
      res.sendStatus(401)
    } else if (!mayNotNeedTableId && (!freezrRequesteeDB || (!freezrRequesteeDB.read_by_id && !getListOfItems))) {
      console.error('Could not access requested db in addUserPermsAndRequesteeDB- err for ' + requesteeAppTable.toString() + ' and owner ' + owner)
      res.sendStatus(401)
    } else {
      if (getListOfItems) {
        req.freezrRequesteeDBs = freezrRequesteeDB
      } else {
        req.freezrRequesteeDB = freezrRequesteeDB
      }

      dsManager.getorInitDb({ app_table: 'info.freezr.account.permissions', owner }, { freezrPrefs: req.freezrPrefs }, function (err, freezrUserPermsDB) {
        if (err) {
          felog('addUserPermsAndRequesteeDB', 'Could not access main freezrUserPermsDB db - addUserPermsAndRequesteeDB', err)
          res.sendStatus(401)
        } else {
          req.freezrUserPermsDB = freezrUserPermsDB

          dsManager.getorInitDb({ app_table: 'dev.ceps.contacts', owner }, { freezrPrefs: req.freezrPrefs }, function (err, cepsContacts) {
            if (err) {
              felog('addUserPermsAndRequesteeDB', 'Could not access main cepsContacts  - addUserPermsAndRequesteeDB', err)
              res.sendStatus(401)
            } else {
              req.freezrCepsContacts = cepsContacts
              dsManager.getorInitDb({ app_table: 'dev.ceps.groups', owner }, { freezrPrefs: req.freezrPrefs }, function (err, cepsGroups) {
                if (err) {
                  felog('addUserPermsAndRequesteeDB', 'Could not access main cepsGroups  - addUserPermsAndRequesteeDB', err)
                  res.sendStatus(401)
                } else {
                  req.freezrCepsGroups = cepsGroups
                  dsManager.getorInitDb({ app_table: 'dev.ceps.privatefeeds.codes', owner: 'public' }, { freezrPrefs: req.freezrPrefs }, function (err, cepsPrivateFeeds) {
                    if (err) {
                      felog('addUserPermsAndRequesteeDB', 'Could not access main cepsPrivateFeeds  - addUserPermsAndRequesteeDB', err)
                      res.sendStatus(401)
                    } else {
                      req.freezrCepsPrivateFeeds = cepsPrivateFeeds
                      const userDs = dsManager.users[owner]
                      req.freezrUserPrefs = userDs.userPrefs
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
  })
}

exports.addUserDs = function (req, res, dsManager, next) {
  const owner = req.freezrTokenInfo.owner_id

  dsManager.getOrSetUserDS(owner, { freezrPrefs: req.freezrPrefs }, function (err, userDS) {
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

    // const userDb = dsManager.getDB(USER_DB_OAC)

    async.waterfall([
      // 1. get userId
      function (cb) {
        dsManager.getorInitDb(USER_DB_OAC, { freezrPrefs: req.freezrPrefs }, cb)
      },
      function (userDb, cb) {
        userDb.query({ user_id: userId }, null, cb)
      },

      // 2. check the password
      function (results, cb) {
        const u = new User(results[0])
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
        dsManager.getOrSetUserDS(owner, { freezrPrefs: req.freezrPrefs }, cb)
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
  dsManager.getorInitDb({ app_table: 'info.freezr.public.public_records', owner: 'public' }, { freezrPrefs: req.freezrPrefs }, function (err, freezrPublicRecordsDB) {
    if (err) {
      if (err.code !== 'ENOENT') helpers.state_error('Could not access main freezrPublicRecordsDB db - addPublicRecordsDB') // only in nedb
      res.sendStatus(401)
    } else if (!freezrPublicRecordsDB || !freezrPublicRecordsDB.query) {
      helpers.state_error('Could not initiate main freezrPublicRecordsDB db - addPublicRecordsDB')
      res.sendStatus(401)
    } else {
      req.freezrPublicRecordsDB = freezrPublicRecordsDB
      dsManager.getorInitDb({ app_table: 'dev.ceps.privatefeeds.codes', owner: 'public' }, { freezrPrefs: req.freezrPrefs }, function (err, freezrPrivateFeedDb) {
        if (err) {
          helpers.state_error('Could not access main freezrPrivateFeedDb db - addPublicRecordsDB')
          res.sendStatus(401)
        } else {
          req.freezrPrivateFeedDb = freezrPrivateFeedDb
          dsManager.getorInitDb({ app_table: 'info.freezr.admin.public_manifests', owner: 'fradmin' }, { freezrPrefs: req.freezrPrefs }, function (err, freezrPublicManifestsDB) {
            if (err) {
              helpers.state_error('Could not access main freezrPublicPermDB db - addPublicRecordsDB')
              res.sendStatus(401)
            } else if (!freezrPublicManifestsDB || !freezrPublicManifestsDB.read_by_id) {
              console.warn('error intiating freezrPublicManifestsDB ', { user: req.session.logged_in_user_id })
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
                    const permlist = []
                    const cards = {}
                    const ppages = {}
                    if (req.freezrRequestorManifest.permissions) {
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
                    } else {
                      next()
                    }
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
  })
}
exports.hasAtLeastOnePublicRecord = function (req, res, dsManager, next) {
  const app = req.params.app_name || req.params.requestee_app
  // console.log('has atleastone ', { params: req.params })
  if (req.params.user_id === 'public' || req.session?.logged_in_user_id === req.params.user_id || app === 'info.freezr.account') {
    next()
  } else {
    const query = { data_owner: req.params.user_id }
    if (app) query.requestor_app = app
    req.freezrPublicRecordsDB.query(query, { count: 1 }, function (err, items) {
      if (err) {
        felog('err i hasAtLeastOnePublicRecord  - next', { err, params: req.params })
        res.sendStatus(401)
      } else if (!items || items.length === 0) {
        felog('no items i hasAtLeastOnePublicRecord  - next')
        res.sendStatus(401)
      } else {
        next()
      }
    })
  }
}
exports.addPublicRecordAndIfFileFileFS = function (req, res, dsManager, next) {
  // app.use('/@:user_id/:app_table/:data_object_id', toReviewAndRedo, publicUserPage, addPublicRecordAndIfFileFileFS, hasAtLeastOnePublicRecord, publicHandler.generateSingleObjectPageOrHtmlPageOrFile)
  // app.get('*')

  fdlog('addPublicRecordAndIfFileFileFS for adding freezrPublicPermDB ', { originalUrl: req.originalUrl, params: req.params })
  // if (!req.params.object_public_id && req.params.data_object_id && req.params.user_id && req.params.app_table) req.params.object_public_id = '@' + req.params.user_id + '/' + req.params.app_table + '/' + req.params.data_object_id
  if (!req.params.object_public_id && req.params.user_id && req.params.app_table && req.params.data_object_id) {
    req.params.object_public_id = '@' + req.params.user_id + '/' + req.params.app_table + '/' + req.params.data_object_id
    req.params.user_id = null
    req.params.app_table = null
    req.params.data_object_id = null
  } else { // ie path ~ '/*'
    req.params.object_public_id = decodeURI(req.path.slice(1))
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
      dsManager.getorInitDb({ app_table: 'info.freezr.public.public_records', owner: 'public' }, { freezrPrefs: req.freezrPrefs }, cb)
    },
    function (freezrPublicRecordsDB, cb) {
      req.freezrPublicRecordsDB = freezrPublicRecordsDB
      cb(null)
    },
    // 2. get manifests (neededed?)
    function (cb) {
      dsManager.getorInitDb({ app_table: 'info.freezr.admin.public_manifests', owner: 'fradmin' }, { freezrPrefs: req.freezrPrefs }, cb)
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
              // console.warn('error getting path ', req.originalUrl)
              cb(new Error('Public id not found'))
            } else {
              req.freezrPublicObject = items[0]
              cb(null)
            }
          })
        } else {
          // felog('Public id not found ', { path: req.path, pubclicID: req.params.object_public_id })
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
        dsManager.getOrSetUserDS(req.freezrPublicObject.data_owner, { freezrPrefs: req.freezrPrefs }, function (err, userDS) {
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
      if (err && err.code === 'Public id not found') {
        console.warn('Public id not found for ' + req.originalUrl)
        res.sendStatus(404)
      } else {
        console.warn('COuld not get public page ' + req.params.object_public_id) // err
        res.redirect('/public?noredirect=true') // redirecting here to avoidinfinite loop in case redirected public page is missing
      }
    } else {
      next()
    }
  })
}
exports.addoAuthers = function (req, res, dsManager, next) {
  // used by shareRecords in which case req.body.grantees.includes("public")
  // or /v1/permissions/change
  fdlog('addoAuthers ', req.originalUrl)
  dsManager.getorInitDb({ app_table: 'info.freezr.admin.oauthors', owner: 'fradmin' }, { freezrPrefs: req.freezrPrefs }, function (err, oAuthorDb) {
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
  const userId = helpers.startsWith(req.params.user_id, '@') ? req.params.user_id.slice(1) : req.params.user_id
  req.freezrPublicManifestsDb.query({ user_id: userId, app_name: req.params.app_name }, null, (err, results) => {
    if (req.params.app_name === 'info.freezr.account' && req.path === '/publicfiles/@' + req.params.user_id + '/' + req.params.app_name + '/profilePict.jpg') {
      results = [{
        fakeManifest: true,
        todo: 'need to make this exception into a public manifest of exceptions'
      }]
    }
    if (err || !results || results.length === 0) { // fdlog todo - also add results[0].granted??
      res.sendStatus(401)
    } else {
      req.freezrPublicManifest = results[0]
      dsManager.getOrSetUserDS(userId, { freezrPrefs: req.freezrPrefs }, function (err, userDS) {
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
  dsManager.getOrSetUserDS(req.params.user_id, { freezrPrefs: req.freezrPrefs }, function (err, userDS) {
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
  fdlog('addUserFilesDb', { oat })
  dsManager.getorInitDb(oat, { freezrPrefs: req.freezrPrefs }, function (err, userFilesDb) {
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
      dsManager.getOrSetUserDS(req.session.logged_in_user_id, { freezrPrefs: req.freezrPrefs }, function (err, userDS) {
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

const SYSTEM_PERMS = [
  {
    name: 'privateCodes',
    type: 'write_own',
    description: 'Access to privatefeed codes table',
    table_id: 'dev.ceps.privatefeeds.codes',
    grantees: ['_allUsers']
  }
]

// Loggers
const LOG_ERRORS = true
const felog = function (...args) { if (LOG_ERRORS) helpers.warning('perm_handler.js', exports.version, ...args) }
const LOG_DEBUGS = false
const fdlog = function (...args) { if (LOG_DEBUGS) console.log(...args) }
