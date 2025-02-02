// freezr.info - nodejs system files - access_handler

exports.version = '0.0.200'

/* global User */

const async = require('async')
const helpers = require('./helpers.js')
const userObj = require('./user_obj.js') // eslint-disable-line
const visitLogger = require('./visit_logger.js')

const APP_TOKEN_OAC = {
  app_name: 'info.freezr.admin',
  collection_name: 'app_tokens',
  owner: 'fradmin'
}
const USER_DB_OAC = {
  app_name: 'info.freezr.admin',
  collection_name: 'users',
  owner: 'fradmin'
}
const EXPIRY_DEFAULT = 30 * 24 * 60 * 60 * 1000 // 30 days

/*
freezrTokenInfo (related to requestor):
  {userId, appName, loggedIn:}
*/

const sendFailureOrRedirect = function (res, req, newUrl) {
  const isSendingAppFile = helpers.startsWith(req.originalUrl, '/app_files/') ||
    helpers.startsWith(req.originalUrl, '/app_files/') ||
    helpers.startsWith(req.originalUrl, '/papp_files/')
  if (isSendingAppFile) {
    res.sendStatus(401)
  } else {
    res.redirect(newUrl)
  }
}
exports.loggedInPingInfo = function (req, res, dsManager, next) {
  const owner = req.session.logged_in_user_id
  if (!owner) {
    next()
  } else {
    dsManager.getOrSetUserDS(owner, { freezrPrefs: req.freezrPrefs }, function (err, userDS) {
      if (!err && userDS) {
        req.freezrStorageLimits = userDS.getUseageWarning()
      }
      next()
    })
  }
}

exports.loggedInUserPage = function (req, res, dsManager, next) {
  // all access to apps and accounts pass through this to get an app token, if logged in session
  // check logged in
  // get or set app token
  // addAccountDS and perms ds
  // add user status
  fdlog('loggedInUserPage dsManager.freezrIsSetup', dsManager.freezrIsSetup, 'user', req.session.logged_in_user_id)
  if (!dsManager.freezrIsSetup || !req.session || !req.session.logged_in_user_id) {
    if (dsManager.freezrIsSetup) helpers.auth_warning('server.js', exports.version, 'accountLoggedIn', 'accountLoggedIn- Unauthorized attempt to access data ' + req.url + ' without login ')
    sendFailureOrRedirect(res, req, '/account/login?fwdTo=' + req.url)
  } else if (req.params.app_name === 'info.freezr.admin' && !req.session.logged_in_as_admin) {
    visitLogger.addNewFailedAuthAttempt(dsManager, req, { source: 'cred', accessPt: 'token' })
    sendFailureOrRedirect(res, req, '/account/home?redirect=adminOnly')
  } else {
    req.freezr_server_version = exports.version
    const owner = req.session.logged_in_user_id

    getOrSetAppTokenForLoggedInUser(dsManager.getDB(APP_TOKEN_OAC), req, function (err, tokenInfo) {
      fdlog('loggedInUserPage ', { err, tokenInfo })
      if (!tokenInfo || !tokenInfo.app_token || !owner || err) {
        visitLogger.addNewFailedAuthAttempt(dsManager, req, { source: 'cred', accessPt: 'token' })
        sendFailureOrRedirect(res, req, '/account/login?redirect=missing_token')
      } else if (!tokenInfo.logged_in || tokenInfo.requestor_id !== req.session.logged_in_user_id) {
        felog('loggedInUserPage ', 'auth error - trying to access user account with wrong user', req.session.logged_in_user_id, { tokenInfo })
        visitLogger.addNewFailedAuthAttempt(dsManager, req, { source: 'cred', accessPt: 'token' })
        sendFailureOrRedirect(res, req, '/account/home?redirect=access_mismatch')
      } else {
        req.freezrTokenInfo = tokenInfo
        dsManager.getOrSetUserDS(owner, { freezrPrefs: req.freezrPrefs }, function (err, userDS) {
          if (err) felog('loggedInUserPage', err)
          if (err && err.message === 'user incomplete') {
            felog('loggedInUserPage ', 'redirecting to /admin/selfregister')
            req.freezrSetUpStatus = 'newParams'
            res.redirect('/admin/selfregister')
          } else if (err) {
            sendFailureOrRedirect(res, req, '/account/login?redirect=internalError')
          } else {
            req.freezrUserDS = userDS
            const theDs = (helpers.is_system_app(req.params.app_name)) ? dsManager.users.fradmin : userDS
            // fdlog('userDS in access_handler for owner ', { owner }) // userDS
            theDs.getorInitAppFS(req.params.app_name, {}, function (err, appFS) {
              if (err) {
                felog('loggedInUserPage ', 'err get-setting app-fs')
                visitLogger.addNewFailedAuthAttempt(dsManager, req, { source: 'internal', accessPt: 'other' })
                res.sendStatus(401)
              } else {
                req.freezrAppFS = appFS
                visitLogger.recordLoggedInVisit(dsManager, req, { visitType: (req.freezrVisitType || 'pages') })
                next()
              }
            })
          }
        })
      }
    })
  }
}
exports.validatedOutsideUserAppPage = function (req, res, dsManager, next) {
  // todo - only works for others logged into the same app right noew
  fdlog('validatedOutsideUserAppPage user', req.session.logged_in_user_id, ' app ', req.params.app_name)

  const deviceCode = req.session.device_code
  const userId = req.session.logged_in_user_id
  const appName = req.params.app_name
  const owner = req.params.user_id
  // onsole.log('validatedOutsideUserAppPage ', { owner, appName, userId, deviceCode })
  if (!appName || !userId || !deviceCode) {
    // onsole.log('NO DATA to get token - need to be creating ', { appName, userId})
    validateLoggedInUserOutsideAppAccessAndAddAppFs(req, res, dsManager, next)
  } else {
    const tokendb = dsManager.getDB(APP_TOKEN_OAC)
    tokendb.query({ owner_id: owner, requestor_id: userId, app_name: appName, user_device: deviceCode }, null,
      (err, tokenInfo) => {
      // getAppTokenParams(dsManager.getDB(APP_TOKEN_OAC), req, function (err, tokenInfo) {
      // {userId, appName, loggedIn}
        fdlog('validatedOutsideUserAppPage tokenInfo for ' + req.url, { tokenInfo })
        fdlog('validatedOutsideUserAppPage req.header(Authorization)', req.header('Authorization'))
        if (!err && tokenInfo.length > 0) {
          fdlog('validatedOutsideUserAppPage got token info ', tokenInfo)
          // check freezrTokenInfo for app_name owner_id requestor_id
          req.freezrTokenInfo = recordWithOldestExpiry(tokenInfo)
          visitLogger.recordLoggedInVisit(dsManager, req, { visitType: 'pages' })
          addAppFs(req, res, dsManager, next)
        } else {
          if (req.session.logged_in_user_id) {
            if (err && err.message === 'Token has expired.' && tokenInfo && tokenInfo.length > 0) {
              req.freezrOldTokenInfo = tokenInfo[0]
            }
            validateLoggedInUserOutsideAppAccessAndAddAppFs(req, res, dsManager, next)
          } else {
            console.warn('Cannot validate outside users yet - this is todo')
          }
        }
      })
  }
}

const validateLoggedInUserOutsideAppAccessAndAddAppFs = function (req, res, dsManager, next) {
  const requestor = req.session.logged_in_user_id
  const owner = req.params.user_id
  const appToken = helpers.generateAppToken(requestor, req.params.app_name, req.session.deviceCode)
  fdlog('validateLoggedInUserOutsideAppAccessAndAddAppFs user ', req.originalUrl, req.freezrTokenInfo)

  req.freezr_server_version = exports.version

  async.waterfall([
    // 1 make sure requestor has app installed
    function (cb) {
      if (visitLogger.tooManyFailedAuthAttempts(dsManager.visitLogs, req, 'outsideAccessToken')) {
        // get list of amdin users and allow them in gradually
        cb(new Error('authentication'))
      } else {
        dsManager.getorInitDb({ app_table: 'info.freezr.account.app_list', owner: req.session.logged_in_user_id }, { freezrPrefs: req.freezrPrefs }, cb)
      }
    },
    function (requestorAppDb, cb) {
      requestorAppDb.query({ app_name: req.params.app_name }, {}, cb) // todonow -> add "outside app"
    },
    function (requestorApps, cb) {
      // onsole.log({requestorApps })
      // todo  - make sure it exists (other wise could be used as an attack vector??)
      cb()
    },

    // 2 Make sure owner has granted permission
    function (cb) {
      dsManager.getUserPerms(owner, { freezrPrefs: req.freezrPrefs }, cb)
    },
    function (ownerPermsDB, cb) {
      const dbQuery = {
        requestor_app: req.params.app_name,
        type: 'use_app',
        granted: true,
        grantees: requestor
      }
      ownerPermsDB.query(dbQuery, {}, cb)
    },
    function (grantedPerms, cb) {
      if (grantedPerms.length === 0) {
        cb(new Error('perm not granted'))
      } else {
        cb()
      }
    },

    // 3 Generate App token
    function (cb) {
      dsManager.getorInitDb(APP_TOKEN_OAC, { freezrPrefs: req.freezrPrefs }, cb)
    },
    function (tokendb, cb) {
      const write = {
        logged_in: null,
        source_device: req.session.device_code,
        requestor_id: requestor,
        owner_id: owner,
        app_name: req.params.app_name,
        app_password: null,
        app_token: appToken, // create token instead
        expiry: (new Date().getTime() + EXPIRY_DEFAULT), // + 100000), // todonow - change back to default
        user_device: req.session.device_code,
        date_used: new Date().getTime() - 1000
      }
      if (!tokendb.cache.byToken) tokendb.cache.byToken = {}
      tokendb.cache.byToken[write.app_token] = write
      if (!tokendb.cache.byOwnerDeviceApp) tokendb.cache.byOwnerDeviceApp = {}
      if (!tokendb.cache.byOwnerDeviceApp[owner]) tokendb.cache.byOwnerDeviceApp[owner] = {}
      if (!tokendb.cache.byOwnerDeviceApp[owner][req.session.device_code][req.params.app_name]) tokendb.cache.byOwnerDeviceApp[owner][req.session.device_code][req.params.app_name] = {}
      tokendb.cache.byOwnerDeviceApp[owner][req.session.device_code][req.params.app_name] = write
      if (req.freezrOldTokenInfo) {
        tokendb.update(req.freezrOldTokenInfo._id, write, { replaceAllFields: true }, cb)
      } else {
        tokendb.create(null, write, null, cb)
      }
    },
    function (results, cb) {
      // temp
      req.freezrTokenInfo = {
        app_name: req.params.app_name,
        owner_id: owner,
        app_token: appToken
      }
      cb()
    }
  ], function (err) {
    if (err) {
      console.warn('err getting page ' + req.originalUrl, { err })
      visitLogger.addNewFailedAuthAttempt(dsManager, req, { accessPt: 'outsideAccessToken', source: 'todo-creds or too many?' })
      res.redirect('/')
    } else {
      visitLogger.recordLoggedInVisit(dsManager, req, { visitType: 'pages' })
      addAppFs(req, res, dsManager, next)
    }
  })
}
const addAppFs = function (req, res, dsManager, next) {
  fdlog('addAppFs', req.freezrAttributes)
  const owner = req.params.user_id

  req.freezr_server_version = exports.version

  async.waterfall([
    // Get  AppFS to pass on to next()
    function (cb) {
      dsManager.getOrSetUserDS(owner, { freezrPrefs: req.freezrPrefs }, cb)
    },
    function (userDS, cb) {
      userDS.getorInitAppFS(req.params.app_name, {}, cb)
    },
    function (appFS, cb) {
      req.freezrAppFS = appFS
      cb()
    }

  ], function (err) {
    if (err) {
      if (req.freezrAppFsIsApi) {
        console.warn('error getting app FS')
        req.freezrAppFS = null
        req.freezrAppFSError = err
        next()
      } else {
        console.warn('err in adappfs', { err })
        res.redirect('/')
      }
    } else {
      next()
    }
  })
}
exports.addAppFsForApi = function (req, res, dsManager, next) {
  req.freezrAppFsIsApi = true
  addAppFs(req, res, dsManager, next)
}
exports.addPublicFsForSystemExtensions = function (req, res, dsManager, next) {
  const owner = 'public'

  req.freezr_server_version = exports.version

  async.waterfall([
    // Get  AppFS to pass on to next()
    function (cb) {
      if (req.session.logged_in_as_admin) { // redundant but adding again just in case
        cb(null)
      } else {
        cb(new Error('Cannot get public fs for logged in user'))
      }
    },
    function (cb) {
      dsManager.getOrSetUserDS(owner, { freezrPrefs: req.freezrPrefs }, cb)
    },
    function (userDS, cb) {
      userDS.getorInitAppFS('SystemExtensions', {}, cb)
    },
    function (appFS, cb) {
      req.freezrPublicSystemExtensionsFS = appFS
      cb()
    }

  ], function (err) {
    if (err) {
      console.warn('err in addPublicFsForSystemExtensions ', { err })
      res.sendStatus(401)
    } else {
      next()
    }
  })
}

exports.loggedInOrNotForSetUp = function (req, res, dsManager, next) {
  // used for self registration
  // app.get('/admin/selfregister', loggedInOrNotForSetUp, publicUserPage, adminHandler.generate_UserSelfRegistrationPage)
  req.params.app_name = 'info.freezr.public'

  fdlog('loggedInOrNotForSetUp ', dsManager.freezrIsSetup, 'user', req.session.logged_in_user_id)

  if (!dsManager.freezrIsSetup) {
    if (dsManager.freezrIsSetup) helpers.auth_warning('server.js', exports.version, 'accountLoggedIn', 'accountLoggedIn- Unauthorized attempt to access data ' + req.url + ' without login ')
    // visitLogger.record(req, freezr_environment, freezr_prefs, {source:'userLoggedInRights', auth_error:true});
    res.redirect('/')
  } else if (!req.session || !req.session.logged_in_user_id) {
    req.freezr_server_version = exports.version
    if (req.freezrSelfRegOptions.allow) {
      req.freezrSetUpStatus = 'unRegisteredUser'
      next()
    } else {
      res.redirect('/')
    }
  } else {
    req.freezr_server_version = exports.version
    // visitLogger.record(req, freezr_environment, freezr_prefs, {source:'userLoggedInRights'});
    const owner = req.session.logged_in_user_id
    getOrSetAppTokenForLoggedInUser(dsManager.getDB(APP_TOKEN_OAC), req, function (err, tokenInfo) {
      if (!tokenInfo || !tokenInfo.app_token || !owner || err) {
        visitLogger.addNewFailedAuthAttempt(dsManager, req, { accessPt: 'token', source: 'creds' })
        felog('loggedInOrNotForSetUp', { err, tokenInfo })
        sendFailureOrRedirect(res, req, '/account/login?redirect=missing_token')
      } else if (!tokenInfo.logged_in || tokenInfo.requestor_id !== req.session.logged_in_user_id) {
        visitLogger.addNewFailedAuthAttempt(dsManager, req, { accessPt: 'token', source: 'creds' })
        felog('loggedInOrNotForSetUp', 'auth error - trying to access user account with wrong user', req.session.logged_in_user_id, { tokenInfo })
        sendFailureOrRedirect(res, req, '/account/home?redirect=access_mismatch')
      } else {
        req.freezrTokenInfo = tokenInfo
        dsManager.getOrSetUserDS(owner, { freezrPrefs: req.freezrPrefs }, function (err, userDS) {
          fdlog('getOrSetUserDS get err type here', (err ? err.message : ''))
          visitLogger.recordLoggedInVisit(dsManager, req, { visitType: 'pages' })
          if (err && err.message === 'user incomplete') {
            req.freezrSetUpStatus = 'newParams'
            next()
          } else if (err) {
            felog('loggedInOrNotForSetUp', 'err get-setting user')
            res.redirect('/account/login?redirect=internalError2')
          } else {
            req.freezrSetUpStatus = 'paramsExist'
            res.redirect('/admin/public/starterror?error=cannotResetParams')
          }
        })
      }
    })
  }
}

exports.publicUserPage = function (req, res, dsManager, next) {
  fdlog('publicUserPage dsManager.freezrIsSetup')

  req.freezr_server_version = exports.version
  // visitLogger.record(req, freezr_environment, freezr_prefs, {source:'userLoggedInRights'});
  fdlog('publicUserPage', 'access_handler.publicUserPage for ' + req.originalUrl)
  visitLogger.recordLoggedInVisit(dsManager, req, { userId: 'public', visitType: (req.freezrVisitType || 'pages') })

  if (!dsManager.freezrIsSetup &&
    !helpers.startsWith(req.originalUrl, '/app_files/info.freezr.public/public/') &&
    !helpers.startsWith(req.originalUrl, '/app_files/info.freezr.admin/public/') &&
    req.params.app_name !== 'info.freezr.public'
  ) {
    sendFailureOrRedirect(res, req, '/admin/firstSetUp')
  } else if (helpers.is_system_app(req.params.app_name)) {
    if (!dsManager.freezrIsSetup) {
      const userDS = dsManager.setSystemUserDS('public', { fsParams: { type: 'local' }, dbParams: {} })
      if (userDS) {
        userDS.getorInitAppFS(req.params.app_name, {}, function (err, appFS) {
          if (err) {
            felog('publicUserPage ', 'Could not get appFS')
            sendFailureOrRedirect(res, req, '/')
          } else {
            req.freezrAppFS = appFS
            next()
          }
        })
      } else {
        sendFailureOrRedirect(res, req, '/')
      }
    } else {
      dsManager.getOrSetUserDS('public', { freezrPrefs: req.freezrPrefs }, function (err, userDS) {
        if (err) {
          felog('publicUserPage ', 'Could not get appFS')
          sendFailureOrRedirect(res, req, '/')
        } else if (userDS && userDS.getorInitAppFS) {
          userDS.getorInitAppFS(req.params.app_name, {}, function (err, appFS) {
            if (err) {
              felog('publicUserPage ', 'Could not get appFS')
              sendFailureOrRedirect(res, req, '/')
            } else {
              req.freezrAppFS = appFS
              next()
            }
          })
        } else {
          sendFailureOrRedirect(res, req, '/')
        }
      })
    }
  } else if (req.params.user_id) {
    const userId = helpers.startsWith(req.params.user_id, '@') ? req.params.user_id.slice(1) : req.params.user_id
    dsManager.getOrSetUserDS(userId, { freezrPrefs: req.freezrPrefs }, function (err, userDS) {
      if (err) felog('publicUserPage', err)
      if (err) {
        sendFailureOrRedirect(res, req, '/account/login?redirect=internalError')
      } else {
        userDS.getorInitAppFS(req.params.app_name, {}, function (err, appFS) {
          if (err) {
            felog('publicUserPage ', 'err get-setting app-fs')
            res.sendStatus(401)
          } else {
            req.freezrAppFS = appFS
            next()
          }
        })
      }
    })
  } else { // if (!req.params.user_id) -> ie this is a dbquery? or a publicid
    // No AppFS is required as this is a a db query????
    next()
  }
}

exports.accountLoggedInAPI = function (req, res, dsManager, next) {
  fdlog('accountLoggedInAPI  ' + req.originalUrl)

  const owner = req.session.logged_in_user_id
  if (visitLogger.tooManyFailedAuthAttempts(dsManager.visitLogs, req, 'login')) {
    // get list of amdin users and allow them in gradually
    visitLogger.addNewFailedAuthAttempt(dsManager, req, { source: 'tooMany', accessPt: 'api' })
    res.sendStatus(401)
  } else if (!dsManager.freezrIsSetup || !req.session || !req.session.logged_in_user_id) {
    felog('accountLoggedInAPI', 'unauthorised access to logged in API')
    visitLogger.addNewFailedAuthAttempt(dsManager, req, { source: 'cred', accessPt: 'token' })
    res.sendStatus(401)
  } else if (req.params.app_name === 'info.freezr.admin' && !req.session.logged_in_as_admin) {
    felog('accountLoggedInAPI', 'unauthorised access to admin API')
    visitLogger.addNewFailedAuthAttempt(dsManager, req, { source: 'cred', accessPt: 'token' })
    res.sendStatus(401)
  } else if (owner && dsManager.freezrIsSetup && req.session && req.header('Authorization')) {
    fdlog('accountLoggedInAPI', owner, dsManager.freezrIsSetup)
    // visitLogger.record(req, freezr_environment, freezr_prefs, {source:'userDataAccessRights'});
    getAppTokenParams(dsManager.getDB(APP_TOKEN_OAC), req, function (err, tokenInfo) {
      // {userId, appName, loggedIn}
      // onsole.log('here ', { err, tokenInfo })
      if (!tokenInfo || !owner || err) {
        felog('accountLoggedInAPI', 'err in getAppTokenParams', err)
        visitLogger.addNewFailedAuthAttempt(dsManager, req, { source: 'cred', accessPt: 'token' })
        console.warn('error with token : ', { err })
        res.sendStatus(401)
      } else if (!['info.freezr.account', 'info.freezr.admin'].includes(tokenInfo.app_name) && !['info.freezr.account', 'info.freezr.admin'].includes(req.params.app_name)) {
        visitLogger.addNewFailedAuthAttempt(dsManager, req, { source: 'cred', accessPt: 'token' })
        felog('accountLoggedInAPI', 'auth error - trying to access account with non account token')
        res.sendStatus(401)
      } else if (!tokenInfo.logged_in || tokenInfo.requestor_id !== req.session.logged_in_user_id) {
        visitLogger.addNewFailedAuthAttempt(dsManager, req, { source: 'cred', accessPt: 'token' })
        felog('accountLoggedInAPI', 'auth error 1 - trying to access user account with wrong user', req.session.logged_in_user_id, { tokenInfo })
        res.sendStatus(401)
      } else {
        req.freezrTokenInfo = tokenInfo
        fdlog('accountLoggedInAPI', 'got tokenInfo - next ', req.freezrTokenInfo)
        dsManager.getOrSetUserDS(owner, { freezrPrefs: req.freezrPrefs }, function (err, userDS) {
          if (err) felog('accountLoggedInAPI', 'err getting user ', owner)
          req.freezrUserDS = userDS
          visitLogger.recordLoggedInVisit(dsManager, req, { visitType: 'apis' })
          next()
        })
      }
    })
  } else {
    felog('accountLoggedInAPI', 'reject accountLoggedInAPI')
    visitLogger.addNewFailedAuthAttempt(dsManager, req, { source: 'cred', accessPt: 'token' })
    // visitLogger.record(req, freezr_environment, freezr_prefs, {source:'userDataAccessRights', auth_error:true});
    res.sendStatus(401)
  }
}

exports.userLoginHandler = function (req, res, dsManager, next) {
  //   app.post('/v1/account/login', userLoginHandler)
  // check logged in
  // get or set app token
  // addAccountDS and perms ds
  // add user status
  fdlog('userLoginHandler')
  const userId = (req.body && req.body.user_id) ? helpers.userIdFromUserInput(req.body.user_id) : null

  if (!dsManager.freezrIsSetup) {
    felog('userLoginHandler', 'Unauthorized attempt to server without being set up')
    res.sendStatus(401)
  } else if (visitLogger.tooManyFailedAuthAttempts(dsManager.visitLogs, req, 'login')) {
    // get list of amdin users and allow them in gradually
    visitLogger.addNewFailedAuthAttempt(dsManager, req, { source: 'tooMany', accessPt: 'login', userId })
    res.sendStatus(401)
  } else {
    req.freezr_server_version = exports.version
    const userDb = dsManager.getDB(USER_DB_OAC)

    async.waterfall([
      function (cb) {
        if (!userId) {
          cb(helpers.auth_failure('access_handler.js', exports.version, 'userLoginHandler', 'Missing user id'))
        } else if (!helpers.user_id_is_valid(userId)) {
          cb(helpers.auth_failure('access_handler.js', exports.version, 'userLoginHandler', 'invalid user id'))
        } else if (!req.body.password) {
          cb(helpers.auth_failure('access_handler.js', exports.version, 'userLoginHandler', 'Missing password'))
        } else {
          cb(null)
        }
      },

      // 1. get userId
      function (cb) {
        userDb.query({ user_id: userId }, null, cb)
      },

      // 2. check the password
      function (results, cb) {
        const u = new User(results[0])
        if (!results || results.length === 0) {
          cb(helpers.auth_failure('access_handler.js', exports.version, 'userLoginHandler', 'Wrong credentials'))
        } else if (results.length > 1) {
          cb(helpers.auth_failure('access_handler.js', exports.version, 'userLoginHandler', 'funky error getting too many users'))
        } else if (u.check_passwordSync(req.body.password)) {
          req.session.logged_in = true
          req.session.logged_in_user_id = userId
          req.session.logged_in_date = new Date().getTime()
          req.session.logged_in_as_admin = u.isAdmin
          req.session.logged_in_as_publisher = u.isPublisher
          cb(null)
        } else {
          felog('userLoginHandler', 'wrong password - need to limit number of wring passwords - set a file in the datastore ;) ')
          cb(helpers.auth_failure('access_handler.js', exports.version, 'userLoginHandler', 'Wrong credentials'))
        }
      },

      // 3. Set or update app code
      function (cb) {
        req.params.app_name = 'info.freezr.account' // used to trick getOrSetAppTokenForLoggedInUser
        getOrSetAppTokenForLoggedInUser(dsManager.getDB(APP_TOKEN_OAC), req, cb)
      },
      function (tokenInfo, cb) {
        // todo maybe - consider setting accounts cookie only from login page... and require password to go to admin functions
        if (!tokenInfo || !tokenInfo.app_token) {
          console.error('could not set app token', { tokenInfo })
          cb(helpers.error('could not set app token'))
        } else {
          res.cookie('app_token_' + req.session.logged_in_user_id, tokenInfo.app_token, { path: '/account' })
          cb(null)
        }
      }
    ],
    function (err) {
      if (err) console.warn('login error - msg -> ', err.message)
      if (!err) {
        visitLogger.recordLoggedInVisit(dsManager, req, { userId, visitType: 'apis' })
        helpers.send_success(res, { logged_in: true, user_id: userId })
      } else if (err.message === 'Authentication error: Wrong credentials') {
        const tooManyLogins = visitLogger.tooManyFailedAuthAttempts(dsManager.visitLogs, req, 'login')
        visitLogger.addNewFailedAuthAttempt(dsManager, req, { source: (tooManyLogins ? 'tooMany' : 'creds'), accessPt: 'login', userId })
        if (tooManyLogins) {
          console.warn('userLoginHandler: too many logins attempted ', { userId })
          helpers.send_failure(res, helpers.auth_failure('access_handler.js', exports.version, 'userLoginHandler', 'Wrong credentials'), 'access_handler', exports.version, 'login')
        } else {
          helpers.send_failure(res, err, 'access_handler', exports.version, 'login')
        }
      } else {
        visitLogger.addNewFailedAuthAttempt(dsManager, req, { source: 'other', accessPt: 'login', userId })
        helpers.send_failure(res, err, 'access_handler', exports.version, 'login')
      }
    })
  }
}

exports.appTokenLoginHandler = function (req, res, dsManager, next) {
  //   app.post('/oauth/token', appTokenLoginHandler)
  if (!dsManager.freezrIsSetup) {
    helpers.auth_warning('server.js', exports.version, 'userLoginHandler', 'Unauthorized attempt to server without being set up')
    res.sendStatus(401)
  } else {
    req.freezr_server_version = exports.version
  }
  // onsole.log('appTokenLoginHandler req.body', req.body)

  const password = req.body.password
  const expiry = req.body.expiry
  const userId = req.body.username
  const appName = req.body.client_id
  const tokendb = dsManager.getDB(APP_TOKEN_OAC)
  let appToken = null
  let expiresIn = null

  async.waterfall([
    // 0. check all variables are present and set device_code
    // note: device code is set via cookie while token is sent via req/res - ensures both are present
    function (cb) {
      if (!dsManager.freezrIsSetup) {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'appTokenLoginHandler', 'Unauthorized attempt to server without being set up'))
      } else if (visitLogger.tooManyFailedAuthAttempts(dsManager.visitLogs, req, 'appTokenLogin')) {
        // get list of amdin users and allow them in gradually
        cb(helpers.auth_failure('account_handler.js', exports.version, 'appTokenLoginHandler', 'Auth failure'))
        res.sendStatus(401)
      } else if (!userId) {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'appTokenLoginHandler', 'Missing user id'))
      } else if (!appName) {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'appTokenLoginHandler', 'Missing app name'))
      } else if (!password) {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'appTokenLoginHandler', 'Missing password'))
      } else if (req.body.grant_type !== 'password') {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'appTokenLoginHandler', 'Wrong grant type - onlt password accepted'))
      } else if (!req.session.device_code) {
        req.session.device_code = helpers.randomText(20)
        const write = {
          device_code: req.session.device_code,
          user_id: userId,
          single_app: appName,
          user_agent: req.headers['user-agent']
        }
        const devicesAoc = {
          app_name: 'info.freezr.account',
          collection_name: 'user_devices',
          owner: userId
        }
        dsManager.getorInitDb(devicesAoc, { freezrPrefs: req.freezrPrefs }, function (err, devicesDb) {
          if (err) {
            cb(err)
          } else {
            devicesDb.upsert(
              { device_code: req.session.device_code, user_id: userId, single_app: appName },
              write, cb)
          }
        })
      } else {
        cb(null, null)
      }
    },

    // 1. set the version and get the tokendb
    function (results, cb) {
      req.freezr_server_version = exports.version
      tokendb.query({ app_password: password }, null, cb)
    },

    // 1. get the password record
    function (results, cb) {
      if (!results || results.length === 0) {
        cb(helpers.error('no_results', 'expected record but found none (get_app_token_record_using_pw)'))
      } else {
        const record = results[0] // todo - theoretically there could be multiple and the right one need to be found
        // onsole.log(record,"user_id", user_id, "app_name", app_name)
        if (record.owner_id !== userId || record.requestor_id !== userId || record.app_name !== appName) {
          cb(helpers.error('mismatch', 'app_name or user_id no not match expected value (appTokenLoginHandler)'))
        } else if (record.date_used) {
          cb(helpers.error('password_used', 'One time password already in use.'))
        } else if (helpers.expiry_date_passed(record.expiry)) {
          cb(helpers.error('password_expired', 'One time password has expired.'))
        } else {
          appToken = record.app_token
          expiresIn = results[0].expiry
          if (expiry && expiry < expiresIn) expiresIn = expiry
          tokendb.update(
            (record._id + ''),
            { date_used: (new Date().getTime()), user_device: req.session.device_code, expiry: expiresIn },
            {}, cb)
        }
      }
    }
  ],
  function (err, results) {
    // onsole.log("end of appTokenLoginHandler - got token",app_token)
    if (err) {
      felog('appTokenLoginHandler', err)
      visitLogger.addNewFailedAuthAttempt(dsManager, req, { source: (visitLogger.tooManyFailedAuthAttempts(dsManager.visitLogs, req, 'appTokenLogin') ? 'too many' : 'creds'), accessPt: 'appTokenLogin', userId })
      helpers.send_failure(res, err, 'account_handler', exports.version, 'appTokenLoginHandler')
    } else if (!appToken) {
      helpers.send_failure(res, helpers.error('Could not get app token for ' + appName), 'account_handler', exports.version, 'appTokenLoginHandler')
    } else {
      visitLogger.recordLoggedInVisit(dsManager, req, { userId, visitType: 'apis' })
      helpers.send_success(res, { access_token: appToken, user_id: userId, app_name: appName, expires_in: expiresIn })
    }
  })
}

exports.userAPIRights = function (req, res, dsManager, next) {
  // onsole.log("userDataAccessRights sess "+(req.session?"Y":"N")+"  loggin in? "+req.session.logged_in_user_id+" param id"+req.params.userid);
  if (dsManager.freezrIsSetup && req.session && req.header('Authorization')) {
    fdlog('userPAI rights appToken', getAppTokenFromHeader(req))
    getAppTokenParams(dsManager.getDB(APP_TOKEN_OAC), req, function (err, tokenInfo) {
      // {userId, appName, loggedIn}
      fdlog('userAPIRights tokenInfo for ' + req.url, { tokenInfo })
      fdlog('userAPIRights req.header(Authorization)', req.header('Authorization'))
      if (err) {
        if (err.message === 'Token has expired.') {
          fdlog('expired token in userAPI rights ', tokenInfo)
          visitLogger.addNewFailedAuthAttempt(dsManager, req, { source: 'expired', accessPt: 'userApi', userId: tokenInfo.userId })
          helpers.send_failure(res, err, 'access_handler', exports.version, 'userAPIRights')
        } else {
          visitLogger.addNewFailedAuthAttempt(dsManager, req, { source: 'creds', accessPt: 'userApi' })
          felog(' userAPIRights', 'err in getAppTokenParams', err)
          res.sendStatus(401)
        }
      } else {
        fdlog('got token info ', tokenInfo)
        req.freezrTokenInfo = tokenInfo
        visitLogger.recordLoggedInVisit(dsManager, req, { visitType: 'apis' })
        next()
      }
    })
  } else {
    felog('userAPIRights', 'rejected ')
    visitLogger.addNewFailedAuthAttempt(dsManager, req, { source: 'creds', accessPt: 'userApi' })
    // visitLogger.record(req, freezr_environment, freezr_prefs, {source:'userDataAccessRights', auth_error:true});
    res.sendStatus(401)
  }
}
exports.userAppLogOut = function (req, res, dsManager, next) {
  fdlog('userAppLogOut not tested')
  if (!dsManager.freezrIsSetup) {
    const err = helpers.auth_failure('access_handler.js', exports.version, 'userAppLogOut', 'Unauthorized attempt to server without being set up')
    helpers.send_failure(res, err, 'access_handler', exports.version, 'userAppLogOut')
  } else if (!req.header('Authorization')) {
    const err = helpers.auth_failure('access_handler.js', exports.version, 'userAppLogOut', 'Unauthorized attempt to logout')
    visitLogger.addNewFailedAuthAttempt(dsManager, req, { source: 'creds', accessPt: 'appToken' })
    helpers.send_failure(res, err, 'access_handler', exports.version, 'userAppLogOut')
  } else {
    const appToken = getAppTokenFromHeader(req)

    const tokendb = dsManager.getDB(APP_TOKEN_OAC)
    const nowTime = new Date().getTime()

    if (tokendb.cache?.byToken && tokendb.cache.byToken[appToken]) {
      delete tokendb.cache.byOwnerDeviceApp[tokendb.cache[appToken].owner_id][tokendb.cache[appToken].user_device][tokendb.cache[appToken].app_name]
      delete tokendb.cache.byToken[appToken]
    }
    tokendb.update({ app_token: appToken }, { expiry: nowTime }, { replaceAllFields: false }, function (err) {
      visitLogger.recordLoggedInVisit(dsManager, req, { visitType: 'apis' })
      helpers.send_success(res, { success: !err })
    })
  }
}
exports.userLogOut = function (req, res, dsManager, next) {
  fdlog('userLogout')

  const tokendb = dsManager.getDB(APP_TOKEN_OAC)

  function endLogout (err, ops) {
    if (err) felog('userLogout', 'err logging out ', err)
    req.session.logged_in = false
    req.session.logged_in_user_id = null
    req.session.logged_in_date = null
    req.session.logged_in_as_admin = false
    res.redirect('/account/login' + (err ? ('error=' + err) : ''))
  }

  if (!dsManager.freezrIsSetup) {
    endLogout(new Error('freezr not set up'))
  } else {
    if (tokendb.cache?.byToken) {
      Object.keys(tokendb.cache).forEach((appToken, i) => {
        if (tokendb.cache[appToken].requestor_id === req.session.logged_in_user_id && tokendb.cache[appToken].user_device === req.session.device_code) {
          delete tokendb.cache.byOwnerDeviceApp[req.session.logged_in_user_id][tokendb.cache.byToken[appToken].device_code]
          delete tokendb.cache.byToken[appToken]
        }
      })
    }

    const nowTime = new Date().getTime() - 1000
    const thequery = { user_device: req.session.device_code, requestor_id: req.session.logged_in_user_id }
    visitLogger.recordLoggedInVisit(dsManager, req, { visitType: 'apis' })
    tokendb.update(thequery, { expiry: nowTime }, { replaceAllFields: false }, endLogout)
  }
}

exports.getManifest = function (req, res, dsManager, next) {
  fdlog('getting getManifest in access_handler ', req.freezrTokenInfo, 'req.req.query.targetApp ', req.query.targetApp)
  const appName = (req.freezrTokenInfo.app_name === 'info.freezr.account' && (req.query.targetApp || req.body.targetApp)) ? (req.query.targetApp || req.body.targetApp) : req.freezrTokenInfo.app_name
  const ownerId = req.freezrTokenInfo.owner_id
  let appDb

  async.waterfall([
    // 0. get app config
    function (cb) {
      dsManager.getorInitDb({ app_table: 'info.freezr.account.app_list', owner: ownerId }, { freezrPrefs: req.freezrPrefs }, cb)
    },
    function (freezrUserAppListDB, cb) {
      if (!freezrUserAppListDB || !freezrUserAppListDB.query) {
        felog('getManifest err - no db at ', { freezrUserAppListDB })
        cb(new Error('could not get freezrUserAppListDB'))
      } else {
        appDb = freezrUserAppListDB
        appDb.query({ app_name: appName }, {}, cb)
      }
    },
    function (list, cb) {
      if (!list || list.length === 0 || !list[0].manifest) {
        // no manifest - Adding blank getManifest in access_handler
        req.freezrRequestorManifest = { identifier: appName, pages: {} }
        cb(null)
      } else if (list.length > 1) {
        appDb.delete_record(list[0]._id, {}, function (err, result) {
          console.warn('DOUBLE MANIFEST ERROR SNBH', { appName, ownerId, err, result }) // hopefully a legacy mistake bug fiz - this shouldnt re-occur 
          req.freezrRequestorManifest = list[1].manifest
          fdlog('will send second manifest ', req.freezrRequestorManifest)
          cb(null)
        })
      } else {
        // Adding full getManifest in access_handler
        // if (list && list[0]) fdlog('list[0].manifest', list[0].manifest)
        req.freezrRequestorManifest = list[0].manifest
        fdlog('got manifest ', req.freezrRequestorManifest)
        cb(null)
      }
    }
  ], function (err) {
    if (err) felog('getManifest', err)
    // todo handle errors by passing as a para - req.freezrError
    next()
  })
}
const getAppTokenParams = function (tokendb, req, callback) {
  const appToken = getAppTokenFromHeader(req)
  getTokenFromCacheOrDb(tokendb, appToken, (err, results) => {
    fdlog('getAppTokenParams - got cahced token getTokenFromCacheOrDb ', results)
    // const record = (results && results.length > 0) ? results[0] : null
    const record = recordWithOldestExpiry(results)
    if (err) {
      callback(err)
    } else if (results.length === 0 || !record) {
      callback(helpers.error('no_results', 'expected record but found none (check_app_token_and_params)'))
    } else if (results.length > 1) {
      callback(helpers.error('many_results', 'expected 1 record but found more than one (check_app_token_and_params)'))
    } else if (!record.requestor_id || !record.owner_id || !record.app_name) {
      callback(helpers.error('mismatch', 'parameters do not match expected value (check_app_token_and_params)'))
    } else if (record.logged_in && record.requestor_id !== req.session.logged_in_user_id) {
      console.warn('user_id does not match logged in  ', record.logged_in, ' Record.requestor_id', record.requestor_id, 'logged_in_user_id', req.session.logged_in_user_id, 'url ', req.url)
      callback(helpers.error('mismatch', 'user_id does not match logged in (check_app_token_and_params) '))
    } else if (record.one_device && record.user_device !== req.session.device_code) {
      callback(helpers.error('mismatch', 'one_device checked but device does not match (check_app_token_and_params) '))
    } else if (!record.expiry || record.expiry < new Date().getTime()) {
      // console.log('token expied ', { appToken })
      const tokenInfo = { owner_id: record.owner_id, requestor_id: record.requestor_id, app_name: record.app_name, logged_in: record.logged_in }
      callback(helpers.error('expired', 'Token has expired.'), tokenInfo)
    } else {
      const tokenInfo = { owner_id: record.owner_id, requestor_id: record.requestor_id, app_name: record.app_name, logged_in: record.logged_in }
      // onsole.log("checking device codes ..", req.session.device_code, the_user, req.params.requestor_app)
      callback(err, tokenInfo)
    }
  })
}
const recordWithOldestExpiry = function (records) {
  if (!records || records.length === 0) {
    fdlog('no records - sending null')
    return null
  }
  let newest = records[0]
  records.forEach(record => {
    if (record.expiry > newest.expiry) {
      newest = record
    }
  })
  return newest
}

const getTokenFromCacheOrDb = function (tokendb, appToken, callback) {
  const nowTime = new Date().getTime()
  if (!appToken) {
    callback(helpers.error('unauth', 'No appToken sent'))
  } else if (tokendb.cache?.byToken && tokendb.cache?.byToken[appToken] && tokendb.cache.byToken[appToken].expiry + (5 * 24 * 60 * 60 * 1000) > nowTime) {
    fdlog('sending cached appToken getTokenFromCacheOrDb...')
    callback(null, [tokendb.cache.byToken[appToken]])
  } else {
    tokendb.query({ app_token: appToken /* expiry: { $gt: new Date().getTime() } */ }, null, callback)
  }
}
const getOrSetAppTokenForLoggedInUser = function (tokendb, req, callback) {
  const deviceCode = req.session.device_code
  const userId = req.session.logged_in_user_id
  // const appToken = getAppTokenFromHeader(req)
  const appName = req.params.app_name
  fdlog('getOrSetAppTokenForLoggedInUser ', { appName, userId, deviceCode })
  const existingHeaderToken = getAppTokenFromHeader(req) //
  const existingCookieToken = req.cookies['app_token_' + userId]
  if (!appName || !userId || !deviceCode) {
    callback(helpers.error('no user or app for getOrSetAppTokenForLoggedInUser'))
  } else if (existingHeaderToken &&
    (!existingCookieToken || existingHeaderToken !== existingCookieToken) &&
    tokendb.cache &&
    tokendb.cache.byToken &&
    tokendb.cache.byToken[existingHeaderToken] &&
    tokendb.cache.byToken[existingHeaderToken].logged_in &&
    tokendb.cache.byToken[existingHeaderToken].requestor_id === userId &&
    tokendb.cache.byToken[existingHeaderToken].app_name === appName &&
    tokendb.cache.byToken[existingHeaderToken].user_device === deviceCode &&
    tokendb.cache.byToken[existingHeaderToken].expiry > (new Date().getTime() + (5 * 24 * 60 * 60 * 1000))) {
    return callback(null, tokendb.cache.byToken[existingHeaderToken])
  } else if (existingHeaderToken && existingCookieToken) {
    callback(helpers.error('existingHeaderToken not valid 1'))
  } else if (existingCookieToken &&
    tokendb.cache &&
    tokendb.cache.byToken &&
    tokendb.cache.byToken[existingCookieToken] &&
    tokendb.cache.byToken[existingCookieToken].logged_in &&
    tokendb.cache.byToken[existingCookieToken].requestor_id === userId &&
    tokendb.cache.byToken[existingCookieToken].app_name === appName &&
    tokendb.cache.byToken[existingCookieToken].user_device === deviceCode &&
    tokendb.cache.byToken[existingCookieToken].expiry > (new Date().getTime() + (5 * 24 * 60 * 60 * 1000))) {
    return callback(null, tokendb.cache.byToken[existingCookieToken])
  } else if (tokendb.cache &&
    tokendb.cache.byOwnerDeviceApp &&
    tokendb.cache.byOwnerDeviceApp[userId] &&
    tokendb.cache.byOwnerDeviceApp[userId][deviceCode] &&
    tokendb.cache.byOwnerDeviceApp[userId][deviceCode][appName] &&
    tokendb.cache.byOwnerDeviceApp[userId][deviceCode][appName].logged_in &&
    tokendb.cache.byOwnerDeviceApp[userId][deviceCode][appName].expiry > (new Date().getTime() + (5 * 24 * 60 * 60 * 1000))) {
    return callback(null, tokendb.cache.byOwnerDeviceApp[userId][deviceCode][appName])
  } else {
    // if (existingToken && tokendb.cache && tokendb.cache[existingToken]) console.log('got but cannot use existing cached appToken ', tokendb.cache[existingToken])
    tokendb.query({ owner_id: userId, user_device: deviceCode, source_device: deviceCode, app_name: appName }, null,
      (err, results) => {
        const nowTime = (new Date().getTime())
        if (err) {
          callback(err)
        } else if (results && results.length > 0 && results.logged_in && (results[0].expiry > (nowTime + (5 * 24 * 60 * 60 * 1000)))) { // re-issue 5 days before
          fdlog('sending old appToken...', results[0])
          tokendb.cache[results[0].app_token] = results[0]
          callback(null, results[0])
        } else {
          // fdlog('need to update token ', results[0])
          const recordId = (results && results[0] && results[0]._id) ? (results[0]._id + '') : null
          const write = {
            logged_in: true,
            source_device: deviceCode,
            requestor_id: userId,
            owner_id: userId,
            // user_id: userId,
            app_name: appName,
            app_password: null,
            app_token: recordId ? results[0].app_token : helpers.generateAppToken(userId, appName, deviceCode), // create token instead
            expiry: (nowTime + EXPIRY_DEFAULT),
            user_device: deviceCode,
            date_used: (recordId ? results[0].dateUsed : nowTime)
          }
          const writeCb = function (err, results) {
            if (!tokendb.cache.byToken) tokendb.cache.byToken = {}
            tokendb.cache.byToken[write.app_token] = write
            if (!tokendb.cache.byOwnerDeviceApp) tokendb.cache.byOwnerDeviceApp = {}
            if (!tokendb.cache.byOwnerDeviceApp[userId]) tokendb.cache.byOwnerDeviceApp[userId] = {}
            if (!tokendb.cache.byOwnerDeviceApp[userId][deviceCode]) tokendb.cache.byOwnerDeviceApp[userId][deviceCode] = {}
            if (!tokendb.cache.byOwnerDeviceApp[userId][deviceCode][appName]) tokendb.cache.byOwnerDeviceApp[userId][deviceCode][appName] = {}
            tokendb.cache.byOwnerDeviceApp[userId][deviceCode][appName] = write
            if (err) {
              fdlog('getOrSetAppTokenForLoggedInUser', 'NEED TO DEAL WITH  ERROR HERE ', err)
              callback(err)
            } else {
              callback(null, write)
            }
          }
          if (recordId) {
            // fdlog('updating appToken... ', recordId)
            tokendb.update(recordId, write, { replaceAllFields: true }, writeCb)
          } else {
            fdlog('writing new appToken...')
            tokendb.create(null, write, null, writeCb)
          }
        }
      })
  }
}
const getAppTokenFromHeader = function (req) {
  return (req.header('Authorization') && req.header('Authorization').length > 10) ? req.header('Authorization').slice(7) : null
}


// Loggers
const LOG_ERRORS = true
const felog = function (...args) { if (LOG_ERRORS) helpers.warning('access_handler.js', exports.version, ...args) }
const LOG_DEBUGS = false
const fdlog = function (...args) { if (LOG_DEBUGS) console.log(...args) }
