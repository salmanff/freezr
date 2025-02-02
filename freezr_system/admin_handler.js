// freezr.info - nodejs system files - admin_handler.js

/* global User */

/* todo 2021
  - later do:
      - oAuth... and connect to first-reg (done?)
      - redo other variables so it is an object not a string
*/

exports.version = '0.0.200'

const USER_DB_OAC = {
  app_name: 'info.freezr.admin',
  collection_name: 'users',
  owner: 'fradmin'
}
const PARAMS_OAC = {
  owner: 'fradmin',
  app_name: 'info.freezr.admin',
  collection_name: 'params'
}
const APP_TOKEN_OAC = {
  app_name: 'info.freezr.admin',
  collection_name: 'app_tokens',
  owner: 'fradmin'
}
const EXPIRY_DEFAULT = 30 * 24 * 60 * 60 * 1000 // 30 days
exports.dbUnificationStrategy = process?.env?.DB_UNIFICATION || 'db' // alts are collection, db or user
exports.DEFAULT_PREFS = {
  log_visits: true,
  log_details: { each_visit: true, daily_db: true, include_sys_files: false, log_app_files: false },
  redirect_public: false,
  public_landing_page: '',
  public_landing_app: '',
  allowSelfReg: false,
  allowAccessToSysFsDb: false,
  selfRegDefaultMBStorageLimit: null,
  dbUnificationStrategy: exports.dbUnificationStrategy,
  useUnifiedCollection: exports.dbUnificationStrategy === 'collection',
  blockMsgsFromNonContacts: false
}
const helpers = require('./helpers.js')
const bcrypt = require('bcryptjs')
const crypto = require('crypto')
// const userObjFile = require('./user_obj.js') // eslint-disable-line
const async = require('async')
const Encoder = require('util').TextEncoder

const fileHandler = require('./file_handler.js')
const environmentDefaults = require('../freezr_system/environment/environment_defaults.js')

exports.generatePublicAdminPage = function (req, res) {
  fdlog('public adminPage: ' + req.url)
  // todo - distinguish http & https [?]

  let scriptFiles = null
  let cssFiles = null
  let pageTitle = null
  let otherVariables = ''
  switch (req.params.sub_page) {
    case 'oauth_start_oauth': // public
      scriptFiles = ['./public/info.freezr.public/public/oauth_start_oauth.js']
      pageTitle = 'freezr.info - o-auth - starting process'
      cssFiles = './@public/info.freezr.public/public/freezr_style.css'
      break
    case 'oauth_validate_page': // public
      scriptFiles = ['./@public/info.freezr.public/public/oauth_validate_page.js']
      pageTitle = 'freezr.info - o-auth validating page'
      cssFiles = './@public/info.freezr.public/public/freezr_style.css'
      break
    case 'starterror': // public
      pageTitle = 'Fatal Error (Freezr)'
      scriptFiles = ['./@public/info.freezr.public/public/starterror.js']
      cssFiles = './@public/info.freezr.public/public/freezr_style.css'
      otherVariables = 'var startup_errors = ' + JSON.stringify(req.freezrStatus)
      break
    default:
      scriptFiles = ['./@public/info.freezr.admin/' + req.params.sub_page + '.js']
      cssFiles = ['./@public/info.freezr.public/public/freezr_style.css', './@public/info.freezr.admin/' + req.params.sub_page + '.css']
      break
  }

  const options = {
    page_title: pageTitle || ('Admin ' + req.params.sub_page.replace('_', ' ') + ' (Freezr)'),
    css_files: cssFiles,
    page_url: 'public/' + req.params.sub_page + '.html',
    app_name: 'info.freezr.admin',
    script_files: scriptFiles,
    other_variables: otherVariables,
    freezr_server_version: req.freezr_server_version,
    server_name: (helpers.startsWith(req.get('host'), 'localhost') ? 'http' : 'https') + '://' + req.get('host')
  }

  if (req.params.sub_page === 'firstSetUp') { // just in case
    felog('generatePublicAdminPage', 'req.params.sub_page === firstSetUp - snbh')
    res.redirect('/')
  } else {
    fileHandler.load_data_html_and_page(req, res, options)
  }
}
exports.generateAdminPage = function (req, res) {
  fdlog('adminPage: ' + req.url + ' sub page: ' + req.params.sub_page)
  // todo - distinguish http & https [?]

  let scriptFiles = null
  let cssFiles = null
  let pageTitle = null
  let initialQuery = null
  let initialQueryFunc = null
  let otherVariables = null
  let modules = null
  if (!req.params.sub_page) req.params.sub_page = 'home'
  // Note adminLoggedInAPI rechecks user credentials as admin, so should not use intiial queries on adminLoggedInUserPage
  switch (req.params.sub_page) {
    case 'home':
      pageTitle = 'freezr.info - Admin'
      cssFiles = ['./@public/info.freezr.admin/public/firstSetUp.css', './@public/info.freezr.public/public/freezr_style.css']
      break
    case 'list_users':
      pageTitle = 'freezr.info - User list'
      cssFiles = './@public/info.freezr.public/public/freezr_style.css'
      scriptFiles = ['list_users.js']
      initialQuery = { url: '/v1/admin/user_list.json' }
      initialQueryFunc = listAllUsers
      break
    case 'prefs':
      scriptFiles = ['./info.freezr.admin/prefs.js']
      pageTitle = 'freezr.info - Main Preferences'
      cssFiles = './@public/info.freezr.public/public/freezr_style.css'
      initialQueryFunc = getMainPrefsToShow
      break
    case 'addsystemextension':
      scriptFiles = ['./info.freezr.admin/addsystemextension.js']
      pageTitle = 'freezr.info - Main Preferences'
      cssFiles = ['./@public/info.freezr.public/public/freezr_style.css', './info.freezr.admin/addsystemextension.css']
      initialQueryFunc = getMainPrefsToShow
      break
    case 'register':
      scriptFiles = ['./info.freezr.admin/register.js']
      pageTitle = 'freezr.info - Register'
      cssFiles = './@public/info.freezr.public/public/freezr_style.css'
      break
    case 'oauth_serve_setup':
      pageTitle = 'freezr.info - Set up your freezr as an oauth server'
      cssFiles = ['oauth_serve_setup.css', './@public/info.freezr.public/public/freezr_style.css']
      scriptFiles = ['oauth_serve_setup.js']
      initialQueryFunc = listAllOauths
      break
    case 'visits':
      // scriptFiles = ['./info.freezr.admin/visits.js']
      modules = ['./info.freezr.admin/visits.js']
      pageTitle = 'freezr.info - Visit View'
      cssFiles = './@public/info.freezr.public/public/freezr_style.css'
      // initialQueryFunc = getMainPrefsToShow
      break
    /*
    case 'hack':
      pageTitle = 'Hack (Freezr)'
      initialQueryFunc = hackingStuff
      break
    */
    default:
      scriptFiles = ['./info.freezr.admin/' + req.params.sub_page + '.js']
      cssFiles = ['./@public/info.freezr.public/public/freezr_style.css', './info.freezr.admin/' + req.params.sub_page + '.css']
      break
  }

  fdlog('admin req.params.sub_page ' + req.params.sub_page + ' req.freezrVisitLogs ' + req.freezrVisitLogs)

  let otherVarsScript = ' var freezrServerStatus = ' + JSON.stringify(req.freezrStatus) + ';'
  otherVarsScript += (req.params.userid ? ('var userid="' + req.params.userid + '";') : '')
  if (req.params.sub_page === 'visits') otherVarsScript += req.freezrVisitLogs ? ('const currentVisits = ' + JSON.stringify(req.freezrVisitLogs) + ';') : ''

  const options = {
    page_title: pageTitle || ('Admin ' + req.params.sub_page.replace('_', ' ') + ' (Freezr)'),
    css_files: cssFiles,
    page_url: req.params.sub_page + '.html',
    app_name: 'info.freezr.admin',
    initial_query: initialQuery,
    user_id: req.session.logged_in_user_id,
    user_is_admin: Boolean(req.session.logged_in_as_admin),
    user_is_publisher: Boolean(req.session.logged_in_as_publisher),
    script_files: scriptFiles,
    other_variables: otherVarsScript,
    modules: modules,
    freezr_server_version: req.freezr_server_version,
    server_name: (helpers.startsWith(req.get('host'), 'localhost') ? 'http' : 'https') + '://' + req.get('host')
  }
  fdlog('todo admin page shuld show freezrStatus in case of err')

  if (
    req.params.sub_page === 'firstSetUp') {
    res.redirect('/')
  } else {
    res.cookie('app_token_' + req.session.logged_in_user_id, req.freezrTokenInfo.app_token, { path: '/admin' })
    if (!initialQueryFunc) {
      fileHandler.load_data_html_and_page(req, res, options)
    } else {
      req.params.internal_query_token = req.freezrTokenInfo.app_token // internal query request
      req.freezrInternalCallFwd = function (err, results) {
        if (err) {
          options.success = false
          options.error = err
        } else {
          options.queryresults = results
        }
        fileHandler.load_data_html_and_page(req, res, options)
      }
      initialQueryFunc(req, res)
    }
  }
}
exports.generateFirstSetUpPage = function (req, res) {
  fdlog('generateFirstSetUpPage: ' + req.url)
  // todo - distinguish http & https
  // onsole.log('??? req.headers.referer.split(':')[0]'+req.headers.referer);
  // onsole.log('??? req.secure '+req.secure)
  // onsole.log('??? req.protocol'+req.protocol)
  // NEED to separate out publicAdmin Pages and first_registration

  req.params.sub_page = 'firstSetUp'

  const tempEnvironment = req.freezrInitialEnvCopy
  if (tempEnvironment.dbParams && tempEnvironment.dbParams.pass) {
    tempEnvironment.dbParams.pass = null
    tempEnvironment.dbParams.has_password = true
  }
  if (tempEnvironment.dbParams && tempEnvironment.dbParams.connectionString) {
    tempEnvironment.dbParams.connectionString = null
    tempEnvironment.dbParams.has_password = true
  }
  fdlog('todo - should do this for all otherDBs and otherFSs as well')

  if (tempEnvironment.fsParams && (tempEnvironment.fsParams.accessToken || tempEnvironment.fsParams.refreshToken)) { // todo - need to also check code-verifier etc
    tempEnvironment.fsParams.accessToken = null
    tempEnvironment.fsParams.TokenIsOnServer = true
  }

  const options = {
    page_title: 'Freeezr Set Up',
    css_files: ['./@public/info.freezr.public/public/firstSetUp.css', './@public/info.freezr.public/public/freezr_style.css'],
    page_url: 'public/selfregister.html',
    script_files: ['./@public/info.freezr.public/public/selfregister.js'],
    app_name: 'info.freezr.public',
    other_variables: ' var freezrServerStatus = ' + JSON.stringify(req.freezrStatus) + ';' +
      ' const thisPage = "firstSetUp";' +
      ' const freezrEnvironment = ' + JSON.stringify(tempEnvironment) + ';' +
      ' const ENV_PARAMS = ' + JSON.stringify(environmentDefaults.ENV_PARAMS) + ';',
    freezr_server_version: req.freezr_server_version,
    server_name: (helpers.startsWith(req.get('host'), 'localhost') ? 'http' : 'https') + '://' + req.get('host')
  }

  fdlog(' goig to egnerate first page ' + options.app_name + '  = ' + options.page_url)
  fileHandler.load_data_html_and_page(req, res, options)
}
exports.generate_UserSelfRegistrationPage = function (req, res) {
  // app.get('/admin/selfregister', loggedInOrNotForSetUp, publicUserPage, adminHandler.generate_UserSelfRegistrationPage)
  // app.get('/admin/SimpleSelfregister', loggedInOrNotForSetUp, publicUserPage, adminHandler.generate_UserSelfRegistrationPage)

  fdlog('generate_UserSelfRegistrationPage: ' + req.url)
  // todo - distinguish http & https & localhost

  const isSimplePage = req.path.toLowerCase() === '/admin/simpleselfregister'

  // onsole.log('selfreg ', req.url, { isSimplePage }, req.path)

  const envParams = environmentDefaults.ENV_PARAMS
  if (!req.freezrAllowAccessToSysFsDb) {
    delete envParams.FS.sysDefault
    delete envParams.DB.sysDefault
  }

  const options = {
    page_title: 'Freeezr Account Set Up',
    css_files: ['./@public/info.freezr.public/public/firstSetUp.css', './@public/info.freezr.public/public/freezr_style.css'],
    page_url: (isSimplePage ? 'public/simpleselfregister.html' : 'public/selfregister.html'),
    script_files: ['./@public/info.freezr.public/public/selfregister.js'],
    app_name: 'info.freezr.public',
    other_variables: 'const thisPage = "' + req.freezrSetUpStatus + '"; ' +
      'const freezrEnvironment = {}; ' +
      'const freezrServerStatus = null; ' +
      ('const userId = "' + (req.session.logged_in_user_id || '') + '"; ') +
      ' ENV_PARAMS = ' + JSON.stringify(envParams) + ';' +
      ' const freezrSelfRegOptions = ' + JSON.stringify(req.freezrSelfRegOptions) + ';',
    freezr_server_version: req.freezr_server_version,
    server_name: (helpers.startsWith(req.get('host'), 'localhost') ? 'http' : 'https') + '://' + req.get('host')
  }

  fdlog(' going to egnerate selfregister page ' + options.app_name + '  = ' + options.page_url)
  fileHandler.load_data_html_and_page(req, res, options)
}

exports.user_register = function (req, res) {
  // performed by admin
  // onsole.log('Registering '+req.body.user_id);

  const allUsersDb = req.freezrFradminDS.getDB(USER_DB_OAC)

  const registerType = req.body.register_type // must be 'normal' for the moment
  const rawPassword = req.body.password
  const userId = helpers.userIdFromUserInput(req.body.user_id)

  const userInfo = {
    user_id: userId,
    email_address: req.body.email_address,
    full_name: req.body.full_name,
    deleted: false,
    isAdmin: (req.body.isAdmin),
    isPublisher: (req.body.isPublisher),
    _created_by_user: req.session.logged_in_user_id, // because registerType === 'normal'
    dbParams: (req.body.useSysFsDb ? { type: 'system' } : null),
    fsParams: (req.body.useSysFsDb ? { type: 'system' } : null),
    slParams: (req.body.useSysFsDb ? { type: 'system' } : null)
  }

  function registerAuthError (message) { return helpers.auth_failure('admin_handler.js', exports.version, 'register', message) }
  async.waterfall([
    function (cb) {
      if (req.session && req.session.logged_in_as_admin && registerType === 'normal') {
        cb(null)
      } else {
        cb(registerAuthError('Missing Admin preivelages'))
      }
    },

    function (cb) {
      if (userInfo.email_address && !helpers.email_is_valid(userInfo.email_address)) {
        cb(helpers.invalid_email_address())
      } else if (!userId) {
        cb(registerAuthError('Missing user id'))
      } else if (!helpers.user_id_is_valid(userId)) {
        cb(registerAuthError('Invalid user id'))
      } else if (!rawPassword) {
        cb(registerAuthError('Missing password'))
      } else if (!registerType) {
        cb(registerAuthError('Missing register type'))
      } else if (registerType !== 'normal') {
        cb(registerAuthError('Mismatch of register type'))
      } else {
        bcrypt.hash(rawPassword, 10, cb)
      }
    },

    // 2. check if person already exists
    function (hash, cb) {
      userInfo.password = hash
      allUsersDb.read_by_id(userId, cb)
    },

    // 3. register the user.
    function (existingUser, cb) {
      if (existingUser) {
        cb(registerAuthError('User exists'))
      } else {
        allUsersDb.create(userId, userInfo, null, cb)
      }
    }
  ],
  function (err, createReturns) {
    if (err) {
      helpers.send_failure(res, err, 'admin_handler', exports.version, 'user_register')
    } else if (!createReturns) {
      helpers.send_failure(res, new Error('error creting user'), 'admin_handler', exports.version, 'user_register')
    } else {
      helpers.send_success(res, { success: true, user_id: userId })
    }
  })
}

exports.self_register = function (req, res) {
  // app.post('/v1/admin/self_register', selfRegisterChecks, selfRegAdds, adminHandler.self_register)
  fdlog('self_register', req.body.action, req.freezrInitialEnvCopy)
  const options = {} // for checkresource

  if ((req.freezrIsSetup && req.body.resource === 'FS' && req.body.params.type === 'local') ||
    (req.freezrIsSetup && req.body.resource === 'DB' && req.body.params.choice === 'mongoLocal')) {
    helpers.send_failure(res, new Error('not permitted'), 'admin_handler', exports.version, 'self_register')
  } else {
    const initialEnv = req.freezrInitialEnvCopy // Only gets passed if it is the firstSetUp
    if (initialEnv && req.body && req.body.env) {
      let { fsParams, dbParams } = req.body.env
      if (fsParams && fsParams.useServerToken && fsParams.type === initialEnv.fsParams.type) {
        req.body.env.fsParams = initialEnv.fsParams
      } else if (fsParams && fsParams.choice === 'sysDefault' && (req.body.action === firstSetUp || req.freezrAllowAccessToSysFsDb)) {
        fsParams = initialEnv.fsParams
      }
      if (dbParams && dbParams.useServerToken && dbParams.type === initialEnv.dbParams.type) {
        req.body.env.dbParams = initialEnv.dbParams
      }
    }

    switch (req.body.action) {
      case 'checkresource':
        // checkFS and checkDB
        if (req.body.getRefreshToken) options.getRefreshToken = true
        if (!req.freezrIsSetup) options.okToCheckOnLocal = true
        environmentDefaults['check' + req.body.resource](req.body.env, options, (err, testResults) => {
          if (err) felog('self_register', 'self_register chjecked', { err, testResults })
          if (testResults && testResults.refreshToken) {
            testResults.checkpassed = true
          }
          helpers.send_success(res, testResults)
        })
        break
      case 'firstSetUp':
        firstSetUp(req, res)
        break
      case 'unRegisteredUser':
        setupNewUserParams(req, res)
        break
      case 'updateReAuthorisedFsParams':
        updateExistingFsParams(req, res)
        break
      case 'newParams': // for user created by admin but with no credentials
        setupNewUserParams(req, res)
        break
      default:
        console.warn('unknown action - ' + req.body.action)
        helpers.send_failure(res, new Error('unknown action'), 'admin_handler', exports.version, 'self_register')
        break
    }
  }
}

exports.data_actions = function (req, res) {
  // app.get('/v1/admin/data/:action', adminLoggedInAPI, addDsManager, adminHandler.data_actions)
  switch (req.params.action) {
    case 'app_resource_use.json':
      getAppResources(req, res)
      break
    default:
      helpers.send_failure(res, new Error('invalid page'), 'account_handler', exports.version, req.params.action)
      break
  }
}
const getAppResources = function (req, res) {
  // app.get('/v1/admin/data/app_resource_use.json', adminLoggedInAPI, addDsManager, adminHandler.data_actions)

  fdlog('account_handler get_app_resources')
  const user = req.query?.user

  req.freezrDsManager.getOrSetUserDS(user, { freezrPrefs: req.freezrPrefs }, function (err, userDS) {
    if (err) {
      felog('getUserPermsgetAppresources fro admin', 'err for ' + user, err)
      helpers.send_failure(res, err, 'admin_handler', exports.version, 'get_app_resources')
    } else {
      userDS.getStorageUse(null, { forceUpdate: true }, function (err, sizeJson) {
        if (err) {
          helpers.send_failure(res, err, 'admin_handler', exports.version, 'get_app_resources')
        } else {
          helpers.send_success(res, sizeJson)
        }
      })
    }
  })
}

const firstSetUp = function (req, res) {
  fdlog('firstSetUp - first time register (or resetting of parameters) for body:', req.body, ' req.freezrInitialEnvCopy: ', req.freezrInitialEnvCopy)
  const { password } = req.body
  const userId = helpers.userIdFromUserInput(req.body.userId)
  const fsParams = req.body?.env?.fsParams
    ? (req.body.env.fsParams.choice === 'sysDefault'
        ? req.freezrInitialEnvCopy.fsParams
        : environmentDefaults.checkAndCleanFs(req.body.env.fsParams, req.freezrInitialEnvCopy)
      )
    : null
  const dbParams = (req.body?.env?.fsParams
    ? (req.body.env.dbParams.choice === 'sysDefault'
        ? req.freezrInitialEnvCopy.dbParams
        : environmentDefaults.checkAndCleanDb(req.body.env.dbParams, req.freezrInitialEnvCopy)
      )
    : null)
  if (process?.env?.UNIFIED_DB_NAME && dbParams.type === 'mongodb') dbParams.unifiedDbName = process?.env?.UNIFIED_DB_NAME
  if (process?.env?.DB_UNIFICATION === 'collection' && dbParams.type === 'mongodb') dbParams.useUnifiedCollection = true
  // dbParams.systemDb = true

  function regAuthFail (message, errCode) { helpers.auth_failure('admin_handler', exports.version, 'firstSetUp', message, errCode) }

  const deviceCode = helpers.randomText(10)
  let theFradminDb
  let theFradminFS
  let allUsersDb
  let appToken
  let userObj
  const port = req.freezrDsManager.initialEnvironment.port
  const envToWrite = 'exports.params=' + JSON.stringify({ fsParams, dbParams, firstUser: userId, freezrIsSetup: true, port })

  async.waterfall([
    // 1 Do basic checks
    function (cb) {
      if (req.freezrDsManager.freezrIsSetup) {
        cb(regAuthFail('System is already initiated.', 'auth-initedAlready'))
      } else if (!userId) {
        cb(helpers.missing_data('user id'))
      } else if (!helpers.user_id_is_valid(userId)) {
        cb(regAuthFail('Valid user id needed to initiate.', 'auth-invalidUserId'))
      } else if (!req.body.password) {
        cb(helpers.missing_data('password'))
      } else if (!fsParams) {
        cb((req.body && req.body.env && req.body.env.fsParams) ? regAuthFail('Invalid fs parameters.', 'auth-invalidFsparams') : helpers.missing_data('fsParams'))
      } else if (!dbParams) {
        cb((req.body && req.body.env && req.body.env.dbParams) ? regAuthFail('Invalid db parameters.', 'auth-invalidDbparams') : helpers.missing_data('dbParams'))
      } else {
        cb(null)
      }
    },
    // check the FS and DB work - removed 2024 as redundant and hanging
    // function (cb) {
    //   if (fsParams.choice === 'sysDefault') {
    //     fsParams = req.freezrInitialEnvCopy.fsParams
    //   } else {
    //     cb(null)
    //   }
    // },
    function (cb) {
      console.log('firstsetUp - start')
      environmentDefaults.checkFS({ fsParams, dbParams }, null, cb)
    },
    function (fsPassed, cb) {
      console.log('firstsetUp - fsPassed')
      if (!fsPassed) {
        cb(new Error('File system parameters did NOT pass checkup'))
      } else {
        req.freezrStatus.can_write_to_user_folder = true
        environmentDefaults.checkDB({ fsParams, dbParams }, { okToCheckOnLocal: true }, cb)
      }
    },
    function (dbPassed, cb) {
      console.log('firstsetUp - dbPassed')
      if (!dbPassed) {
        cb(new Error('Database parameters did NOT pass checkup'))
      } else {
        req.freezrStatus.can_read_write_to_db = true
        req.freezrDsManager.systemEnvironment = { fsParams, dbParams }
        cb(null)
      }
    },

    // set up db and fs and see if freezr_environment exists in either
    function (cb) {
      console.log('firstsetUp - initAdminDBs')
      req.freezrDsManager.initAdminDBs({ fsParams, dbParams }, req.freezrPrefs, cb)
      // req.freezrDsManager.setSystemUserDS('fradmin', { fsParams, dbParams })
      // req.freezrDsManager.setSystemUserDS('public', { fsParams, dbParams })
      // req.freezrDsManager.initOacDB(USER_DB_OAC, null, cb)
    },
    function (cb) {
      console.log('firstsetUp - inited dbs')
      allUsersDb = req.freezrDsManager.getDB(USER_DB_OAC)
      allUsersDb.query({}, null, cb)
    },
    function (existingUsers, cb) {
      console.log('firstsetUp - existingUsers')
      if (existingUsers && existingUsers.length > 0) {
        cb(regAuthFail('Users Already Exist - Cannot Re-Initiate.', 'auth-usersExist'))
      } else {
        cb(null)
        // req.freezrDsManager.initOacDB(PARAMS_OAC, null, cb)
      }
    },
    function (cb) {
      console.log('firstsetUp - app fs')
      req.freezrDsManager.getOrInitUserAppFS('fradmin', 'info.freezr.admin', {}, cb)
    },
    function (fradminFs, cb) {
      console.log('firstsetUp - fradminFs')
      theFradminFS = fradminFs
      theFradminFS.readUserFile('freezr_environment.js', null, (err, envOnFile) => {
        if (err) {
          cb(null)
        } else {
          if (helpers.startsWith(envOnFile, 'exports.params=')) envOnFile = envOnFile.slice('exports.params='.length)
          envOnFile = JSON.parse(envOnFile)
          if (envOnFile.firstUser) {
            cb(regAuthFail('env on file already exists', 'auth-usersExist'))
          } else {
            cb(null)
          }
        }
      })
    },

    // create db entry with no users...
    function (cb) {
      console.log('firstsetUp - get fradmin db')
      theFradminDb = req.freezrDsManager.getDB(PARAMS_OAC) // fradminDb
      theFradminDb.create('freezr_environment', { fsParams, dbParams, port, firstUser: userId }, null, cb)
    },
    function (created, cb) {
      console.log('firstsetUp - created fradmin db')
      theFradminDb = req.freezrDsManager.getDB(PARAMS_OAC) // fradminDb
      req.freezrPrefs = exports.DEFAULT_PREFS
      theFradminDb.create('main_prefs', exports.DEFAULT_PREFS, null, cb)
    },

    // cretae user
    function (created, cb) {
      bcrypt.hash(password, 10, cb)
    },
    function (hash, cb) {
      const userInfo = {
        user_id: userId,
        password: hash,
        email_address: null,
        full_name: null,
        deleted: false,
        isAdmin: true,
        fsParams: { type: 'system' },
        dbParams: { type: 'system' },
        _created_by_user: '_self_'
      }
      console.log('firstsetUp - to create user')
      allUsersDb.create(userId, userInfo, null, cb)
    },
    function (createdUser, cb) {
      console.log('firstsetUp -  user creaeted')
      userObj = new User(createdUser.entity)
      req.freezrDsManager.getOrSetUserDS(userId, { freezrPrefs: req.freezrPrefs }, cb)
    },

    //
    function (userds, cb) {
      theFradminFS.writeToUserFiles('freezr_environment.js', envToWrite, null, cb)
    },
    function (created, cb) {
      theFradminDb.update('freezr_environment', { fsParams, dbParams, firstUser: userId, freezrIsSetup: true }, { replaceAllFields: true }, cb)
    },
    function (created, cb) {
      cb(null)
    },
    // function (cb) {
    //   req.freezrDsManager.initOacDB(APP_TOKEN_OAC, null, cb)
    // },
    function (cb) {
      const tokendb = req.freezrDsManager.getDB(APP_TOKEN_OAC)
      const appName = 'info.freezr.admin'
      const deviceCode = helpers.randomText(20)
      const nowTime = new Date().getTime()
      appToken = helpers.generateAppToken(userId, appName, deviceCode)
      const write = {
        logged_in: true,
        source_device: deviceCode,
        user_id: userId,
        app_name: appName,
        app_password: null,
        app_token: appToken,
        expiry: (nowTime + EXPIRY_DEFAULT),
        user_device: deviceCode,
        date_used: nowTime
      }
      tokendb.create(null, write, null, cb)
    },
    function (results, cb) {
      cb(null)
    },

    // create indeces
    function (cb) {
      if (dbParams.choice === 'cosmosForMongoString') {
        // if other choices also need indeces, can add a indecesNeeded property to dbParams in evironment_defaults
        addIndecesToAdminDatabases({ allUsersDb } , cb)
      } else {
        cb(null)
      }
    }
  ], function (err) {
    if (err) {
      felog('firstSetUp', 'registration end err?', { code: err.code, msg: err.message, statusCode: err.statusCode, name: err.name })
      helpers.send_failure(res, err, 'admin_handler', exports.version, 'oauth_make:item does not exist')
    } else {
      const freezrPrefsTempPw = helpers.randomText(20)

      req.freezrDsManager.freezrIsSetup = true
      req.freezrDsManager.firstUser = userId
      req.freezrDsManager.systemEnvironment.firstUser = userId
      req.freezrDsManager.freezrPrefsTempPw = { pw: freezrPrefsTempPw, timestamp: new Date().getTime() }

      req.session.logged_in = true
      req.session.logged_in_user_id = userId
      req.session.logged_in_date = new Date().getTime()
      req.session.logged_in_as_admin = true
      req.session.device_code = deviceCode
      req.session.freezrPrefsTempPw = freezrPrefsTempPw

      res.cookie('app_token_' + userId, appToken, { path: '/admin' })

      helpers.send_success(res, { user: userObj.response_obj(), freezrStatus: req.freezrStatus })
    }
  })
}

const setupNewUserParams = function (req, res) {
  // req.freezrAllowSelfReg = freezrPrefs.allowSelfReg
  // req.freezrAllowAccessToSysFsDb = freezrPrefs.allowAccessToSysFsDb
  // req.allUsersDb = dsManager.getDB(USER_DB_OAC)

  const uid = req.session.logged_in_user_id || helpers.userIdFromUserInput(req.body.userId)
  const { password, action, email } = req.body
  const fsParams = environmentDefaults.checkAndCleanFs(req.body.env.fsParams, req.freezrInitialEnvCopy)
  const dbParams = environmentDefaults.checkAndCleanDb(req.body.env.dbParams, req.freezrInitialEnvCopy)

  fdlog('setupNewUserParams', 'setupParams - esetting of parameters for user :', req.body, { fsParams, dbParams })

  function regAuthFail (message, errCode) { helpers.auth_failure('admin_handler', exports.version, 'setupNewUserParams', message, errCode) }

  const deviceCode = helpers.randomText(10)
  // let appToken
  let userObj
  let hash
  const userLimits = {}
  fdlog('todo - deal with passwords etc already in environment - eg if dropbox password is in the heroku env')

  async.waterfall([
    // do basic checks
    function (cb) {
      if (!uid) {
        cb(helpers.missing_data('user id'))
      } else if (!helpers.user_id_is_valid(uid)) {
        cb(regAuthFail('Valid user id needed to initiate.', 'auth-invalidUserId'))
      } else if (!fsParams || !dbParams) {
        cb(new Error('Need fsParams and dbparams to write'))
      } else if (!req.freezrAllowAccessToSysFsDb && (['local', 'system'].includes(fsParams.type) || ['local', 'system'].includes(dbParams.type))) {
        cb(regAuthFail('Not allowed to use system resources', 'auth-Not-freezrAllowAccessToSysFsDb'))
      } else if (!req.freezrSelfRegOptions.allow && !req.session.logged_in_user_id) {
        cb(regAuthFail('Not allowed to self-register', 'auth-Not-freezrAllowSelfReg'))
      } else if (action === 'unRegisteredUser') {
        // to do
        if (!password) {
          cb(helpers.missing_data('password'))
        } else if (req.session.logged_in_user_id) {
          cb(regAuthFail('Cannot re-register as logged in user', 'auth-invalidUserId'))
        } else {
          bcrypt.hash(password, 10, cb)
        }
      } else if (action === 'newParams') {
        if (!req.session.logged_in_user_id) {
          cb(regAuthFail('Need to be logged in to set params - SNBH', 'auth-invalidUserId'))
        } else {
          cb(null, null)
        }
      } else {
        cb(regAuthFail('internal error - need to action unRegisteredUser or newParams - SNBH', 'auth-invalidUserId'))
      }
    },

    // set passwrod hash and check the FS and DB work
    function (ahash, cb) {
      hash = ahash
      if (action === 'unRegisteredUser' && !hash) {
        cb(new Error('Could not get hash'))
      } else if (fsParams.type === 'system') {
        if (req.freezrSelfRegOptions.allow) {
          userLimits.storage = req.freezrSelfRegOptions.defaultMBStorageLimit
          cb(null, true)
        } else {
          cb(new Error('Server does not allow self-registeredd users to use its file system.'), false)
        }
      } else {
        environmentDefaults.checkFS({ fsParams, dbParams }, { userId: uid }, cb)
      }
    },
    function (fsPassed, cb) {
      if (!fsPassed) {
        cb(new Error('File system parameters did NOT pass checkup'))
      } else if (dbParams.type === 'system') {
        if (req.freezrSelfRegOptions.useUserIdsAsDbName) {
          dbParams.useUserIdsAsDbName = true
        }
        if (req.freezrSelfRegOptions.useUnifiedCollection) {
          dbParams.useUnifiedCollection = true
        }
        if (req.freezrSelfRegOptions.allow) {
          userLimits.storage = req.freezrSelfRegOptions.defaultMBStorageLimit
          cb(null, true)
        } else {
          cb(new Error('Server does not allow self-registeredd users to use its file system.'), false)
        }
      } else {
        setTimeout(function () {
          environmentDefaults.checkDB({ fsParams, dbParams }, { okToCheckOnLocal: true }, cb)
        }, 1000) // googledrive hack to void two dirs
      }
    },
    function (dbPassed, cb) {
      if (!dbPassed) {
        cb(new Error('Database parameters did NOT pass checkup'))
      } else {
        cb(null)
      }
    },

    // Check if any users exist
    function (cb) {
      req.freezrAllUsersDb.query({ user_id: uid }, null, cb)
    },
    function (existingUsers, cb) {
      if (action === 'unRegisteredUser') {
        if (existingUsers && existingUsers.length > 0) {
          cb(new Error('user already exists'))
        } else {
          const userInfo = {
            user_id: uid,
            password: hash,
            email,
            full_name: null,
            deleted: false,
            isAdmin: false,
            fsParams,
            dbParams,
            _created_by_user: '_self_',
            limits: userLimits
          }
          req.freezrAllUsersDb.create(uid, userInfo, null, cb)
        }
        // err if exists else create new user
      } else { // action === newParams
        if (existingUsers && existingUsers.length === 1) {
          const theUser = existingUsers[0]
          if (theUser.fsParams && theUser.dbParams) { // should be || or but in case there was a right err in one
            cb(new Error('User Params already exist! cannot re-write'))
          } else {
            req.freezrAllUsersDb.update(uid, { fsParams, dbParams }, { replaceAllFields: false }, cb)
          }
        } else {
          cb(new Error('internal error accessing database of users to update resources'))
        }
      }
    }
  ], function (err, results) {
    if (err) {
      felog('setupNewUserParams', 'registration for ' + uid + ' end err', err)
      helpers.send_failure(res, err, 'admin_handler', exports.version, 'oauth_make:item does not exist')
    } else if (action === 'newParams') {
      helpers.send_success(res, { success: true })
    } else { // action === 'unRegisteredUser'
      userObj = new User(results.entity)
      req.session.logged_in = true
      req.session.logged_in_user_id = uid
      req.session.logged_in_date = new Date().getTime()
      req.session.logged_in_as_admin = false
      req.session.device_code = deviceCode

      // res.cookie('app_token_' + userId, appToken, { path: '/admin' })

      helpers.send_success(res, { success: true, user: userObj.response_obj() })
    }
  })
}
const updateExistingFsParams = function (req, res) {
  // req.freezrAllowSelfReg = freezrPrefs.allowSelfReg
  // req.freezrAllowAccessToSysFsDb = freezrPrefs.allowAccessToSysFsDb
  // req.allUsersDb = dsManager.getDB(USER_DB_OAC)

  // fdlog('setupNewUserParams', 'setupParams - esetting of parameters for user :', req.body)
  const uid = req.session.logged_in_user_id
  const { password } = req.body
  const fsParams = environmentDefaults.checkAndCleanFs(req.body.env.fsParams, req.freezrInitialEnvCopy)

  function regAuthFail (message, errCode) { helpers.auth_failure('admin_handler', exports.version, 'updateExistingParams', message, errCode) }

  fdlog('todo - deal with passwords etc already in environment - eg if dropbox password is in the heroku env')

  async.waterfall([
    // do basic checks
    function (cb) {
      if (!uid) {
        cb(helpers.missing_data('user id'))
      } else if (uid !== req.body.userId) {
        cb(regAuthFail('You can only re-authenticate youyrself.', 'auth-invalidUserId'))
      } else if (!req.freezrAllowAccessToSysFsDb && (['local', 'system'].includes(fsParams.type))) {
        cb(regAuthFail('Not allowed to use system resources', 'auth-Not-freezrAllowAccessToSysFsDb'))
      } else if (!password) {
        cb(helpers.missing_data('password'))
      } else if (!req.body || !req.body.env || !req.body.env.fsParams) {
        cb(helpers.missing_data('environment'))
      } else {
        cb(null)
      }
    },

    // set passwrod hash and check the FS and DB work
    function (cb) {
      environmentDefaults.checkFS({ fsParams, dbParams: null }, { userId: uid }, cb)
    },
    function (fsPassed, cb) {
      if (!fsPassed) {
        cb(new Error('File system parameters did NOT pass checkup'))
      } else {
        cb(null)
      }
    },

    // Get the user
    function (cb) {
      req.freezrAllUsersDb.query({ user_id: uid }, null, cb)
    },
    function (results, cb) {
      const u = new User(results[0])
      // fdlog('got user ', u)
      if (!results || results.length === 0 || results.length > 1) {
        cb(helpers.auth_failure('admin_handler.js', exports.version, 'updateExistingParams', 'funky error'))
      } else if (!u.check_passwordSync(req.body.password)) {
        felog('updateExistingParams', 'Wrong password for ' + uid + '. Canot update params')
        cb(helpers.auth_failure('admin_handler.js', exports.version, 'updateExistingParams', 'rying to update params without a password'))
      } else {
        req.freezrAllUsersDb.update(uid, { fsParams }, { replaceAllFields: false }, cb)
      }
    }
  ], function (err, results) {
    if (err) {
      felog('updateExistingParams', 'registration end err', err)
      helpers.send_failure(res, err, 'admin_handler', exports.version, 'oauth_make:item does not exist')
    } else {
      req.freezrUserDS.fsParams = fsParams
      const tables = []
      for (const table in req.freezrUserDS.appcoll) { tables.push(table) }
      async.forEach(tables, function (table, cb) {
        req.freezrUserDS.initOacDB({ app_table: table, owner: req.freezrUserDS.owner }, null, cb)
      },
      function (err) {
        const ret = err ? { error: err } : { success: true }
        helpers.send_success(res, ret)
      })
    }
  })
}

const listAllUsers = function (req, res) {
  // fdlog('todo - scale and paginate for many users')

  const allUsersDb = req.freezrFradminDS.getDB(USER_DB_OAC)
  allUsersDb.query({}, null, (err, results) => {
    if (err) {
      if (req.freezrInternalCallFwd) {
        req.freezrInternalCallFwd(err, { users: [] })
      } else {
        helpers.send_internal_err_failure(res, 'admin_handler', exports.version, 'listAllUsers', 'failure to get all user list - ' + err)
      }
    } else {
      const out = []
      if (results) {
        for (let i = 0; i < results.length; i++) {
          const u = new User(results[i]).response_obj()
          if (req.freezrDsManager.users[u.user_id] && req.freezrDsManager.users[u.user_id].useage?.lastStorageCalcs?.totalSize) {
            u.limits = req.freezrDsManager.users[u.user_id].useage?.lastStorageCalcs
            u.limits.totalSizeMB = Math.round(u.limits.totalSize / 100000) / 10
            u.limits.timeString = new Date(u.limits.time).toLocaleString()
          }
          out.push(u)
        }
      }
      // onsole.log('out: ', JSON.stringify(out))
      if (req.freezrInternalCallFwd) {
        req.freezrInternalCallFwd(null, { users: out })
      } else {
        helpers.send_success(res, { users: out })
      }
    }
  })
}

const getMainPrefsToShow = function (req, res) {
  const PARAMS_APC = {
    app_name: 'info.freezr.admin',
    collection_name: 'params',
    owner: 'fradmin'
  }
  const paramsDb = req.freezrFradminDS.getDB(PARAMS_APC)
  paramsDb.read_by_id('main_prefs', (err, theprefs) => {
    if (err) {
      felog('getMainPrefsToShow', 'err reading main_prefs', err)
      if (req.freezrInternalCallFwd) {
        req.freezrInternalCallFwd(err, {})
      } else {
        helpers.send_internal_err_failure(res, 'admin_handler', exports.version, 'getMainPrefsToShow', 'failure to get all user list - ' + err)
      }
    } else {
      // if (!theprefs) the
      if (req.freezrInternalCallFwd) {
        req.freezrInternalCallFwd(null, theprefs)
      } else {
        helpers.send_success(res, theprefs)
      }
    }
  })
}
exports.get_or_set_prefs = function (paramsDb, prefName, prefsToSet, doSet, callback) {
  // fdlog('get_or_set_prefs Done for ' + prefName + 'doset?' + doSet, prefsToSet)
  let prefOnDb = {}

  const callFwd = function (err, writeResult) {
    if (err) {
      callback(err, prefsToSet)
    } else {
      callback(null, prefOnDb)
    }
  }
  paramsDb.read_by_id(prefName, (err, results) => {
    if (err) {
      callFwd(err)
    } else if (!doSet && results) {
      prefOnDb = results
      callFwd(null, prefOnDb)
    } else if (doSet && prefsToSet) {
      if (results) {
        if (prefName === 'main_prefs' && (results.dbUnificationStrategy !== prefsToSet.dbUnificationStrategy)) {
          callFwd(helpers.internal_error('fradmin_actions', exports.version, 'get_or_set_prefs', ('cannot change dbunificationstrategy once it has been set ')))
        } else {
          paramsDb.update(prefName, prefsToSet, { replaceAllFields: true, multi: false }, callFwd)
        }
      } else {
        prefsToSet._id = prefName
        paramsDb.create(prefName, prefsToSet, null, callFwd)
      }
    } else if (doSet && !prefsToSet) {
      callFwd(helpers.internal_error('fradmin_actions', exports.version, 'get_or_set_prefs', ('doset is set to true but nothing to replace prefs ' + prefName)))
    } else {
      callFwd(null)
    }
  })
}

const VERSION_NUMS = 'versionNums'
exports.check_server_version_and_implement_updates = function (dsManager, currentversion, callback) {
  const paramsDb = dsManager.getDB(PARAMS_OAC)
  paramsDb.read_by_id(VERSION_NUMS, (err, results) => {
    if (err) {
      console.warn('check_server_version_and_implement_updates - error reading previous version num')
      callback(err)
    } else if (!results) {
      paramsDb.create(VERSION_NUMS, { serverVersion: currentversion }, null, callback)
    } else {
      if (helpers.newVersionNumberIsHigher(results.serverVersion, currentversion)) {
        const serverUpdates = require('./serverUpdates.js')
        serverUpdates.doUpdates(dsManager, results.serverVersion, currentversion, (err) => {
          if (err) {
            callback(err)
          } else {
            paramsDb.update(VERSION_NUMS, { serverVersion: currentversion }, { replaceAllFields: false, multi: false }, function (err, stuff) {
              callback(err)
            })
          }
        })
        //
        // callback(null)
      } else {
        // onsole.log('new version is not higher')
        callback(null)
      }
    }
  })
}

exports.change_main_prefs = function (req, res, next) {
  fdlog('change_main_prefs :' + JSON.stringify(req.body))
  // req.freezrPrefs = freezrPrefs
  // eq.freezrFradminDS = userDS

  const userId = req.session.logged_in_user_id
  const newPrefs = {}

  // req.freezrPrefsTempPw indicates first time setup

  async.waterfall([
    // 0. checks
    function (cb) {
      if (!userId || !req.session.logged_in_as_admin) { // recheck
        cb(helpers.auth_failure('admin_handler.js', exports.version, 'change_main_prefs', 'Not admin'))
      } else if (!req.body.password && !req.freezrPrefsTempPw) {
        cb(helpers.missing_data('password or setup token'))
      } else {
        cb(null)
      }
    },

    function (cb) {
      if (req.freezrPrefsTempPw) {
        const timeConstraint = 10 * 60 * 1000 // 10 minutes
        if (req.freezrPrefsTempPw.pw === req.session.freezrPrefsTempPw &&
          req.freezrPrefsTempPw.timestamp > (new Date().getTime() - timeConstraint)) {
          cb(null, null)
        } else {
          cb(helpers.missing_data('temporary setup token invalid'))
        }
      } else {
        const allUsersDb = req.freezrFradminDS.getDB(USER_DB_OAC)
        allUsersDb.read_by_id(userId, cb)
      }
    },

    function (userInfo, cb) {
      if (req.freezrPrefsTempPw) {
        req.freezrPrefsTempPw = null
        cb(null)
      } else if (!userInfo) {
        cb(helpers.missing_data('user info'))
      } else {
        const u = new User(userInfo)
        if (u.check_passwordSync(req.body.password)) {
          cb(null)
        } else {
          cb(helpers.auth_failure('admin_handler.js', exports.version, 'change_main_prefs', 'Wrong password'))
        }
      }
    },

    // sanitize and set the prefs
    function (cb) {
      // get  check each item and then update
      // TODO CHECK AGAINST  req.freezrPrefs to see if useUnfifieds have been changed
      Object.keys(exports.DEFAULT_PREFS).forEach(function (key) {
        newPrefs[key] = req.body[key] ? req.body[key] : exports.DEFAULT_PREFS[key]
      })
      if (newPrefs.public_landing_page) newPrefs.public_landing_page = newPrefs.public_landing_page.trim()
      if (newPrefs.public_landing_app) newPrefs.public_landing_app = newPrefs.public_landing_app.trim()
      exports.get_or_set_prefs(req.freezrFradminDS.getDB(PARAMS_OAC), 'main_prefs', newPrefs, true, cb)
    },

    function (prefOnDb, cb) {
      if (newPrefs.useUnifiedCollection !== req.freezrPrefs.useUnifiedCollection) {
        req.freezrDsManager.users = {}
        // exports.initAdminOACs(req.freezrDsManager, req.freezrDsManager.initialEnvironment, newPrefs, function(err) {
        req.freezrDsManager.initAdminDBs(req.freezrDsManager.initialEnvironment, newPrefs, function (err) {
          if (err) {
            cb(err)
          } else {
            req.freezrDsManager.getOrSetUserDS(userId, { freezrPrefs: newPrefs }, cb)
          }
        })
      } else {
        cb(null)
      }
    }
  ],
  function (err) {
    if (err) {
      helpers.send_failure(res, err, 'admin_handler', exports.version, 'change_main_prefs')
    } else {
      next(newPrefs)
      // req.freezrPrefs = newPrefs
    }
  })
}

const addIndecesToAdminDatabases = function (dbs, cb) {
  // to add allTokensDb?
  const { allUsersDb } = dbs

  allUsersDb.db.createIndex({ user_id: 1 }, { background: true, unique: false }, (err, result) => {
    cb(err)
  })
}

exports.hackingStuff = function (req, res) {
  // temporary data migration
  let publicRecDb = null
  let oldAccessibles = null
  async.waterfall([
    function (cb) {
      req.freezrFradminDS.getorInitDb({ app_table: 'info.freezr.public.public_records', owner: 'public' }, {}, cb)
    },
    function (theDb, cb) {
      publicRecDb = theDb
      req.freezrFradminDS.getorInitDb({ app_table: 'info.freezr.admin.accessibles', owner: 'fradmin' }, {}, cb)
    },
    function (theDb, cb) {
      oldAccessibles = theDb

      oldAccessibles.query({ newDbUpdate3: { $exists: false } }, { count: 20 }, cb)
    },

    function (results, cb) {
      async.forEach(results, function (item, cb2) {
        if (item.requestor_app === 'info.freezr.vulog') item.requestor_app = 'com.salmanff.vulog'
        if (item.requestee_app === 'info.freezr.vulog') item.requestee_app = 'com.salmanff.vulog'
        if (item.requestee_app === 'com.salmanff.vulog' && item.permission_name === 'publish_favorites') item.permission_name = 'link_share'
        item.original_app_table = item.requestor_app + '.' + item.collection_name
        item.original_record_id = item.data_object_id.toString()
        delete item.data_object_id
        item.original_record = item.data_object
        item._date_published = item.original_record._date_published || item.original_record._date_created
        if (item._date_modified > 1627010003783) item._date_modified = item._date_published
        delete item.data_object
        delete item.shared_with_group
        delete item.shared_with_user

        if (item.requestor_app === 'com.salmanff.poster') {
          let body = item.original_record.body
          body = body.replace('v1/publicfiles/com.salmanff.poster/salman', 'v1/publicfiles/salman/com.salmanff.poster')
          body = body.replace('v1/publicfiles/com.salmanff.poster/salman', 'v1/publicfiles/salman/com.salmanff.poster')
          body = body.replace('v1/publicfiles/com.salmanff.poster/salman', 'v1/publicfiles/salman/com.salmanff.poster')
          item.original_record.body = body
        }

        delete item.newDbUpdate
        delete item.newDbUpdate2

        const newId = item._id
        // if (item.requestee_app === 'com.salmanff.vulog') newId = item.data_owner + '/' + item.original_app_table.replace(/\./g, '_') + '/' + item._id
        // const oldId = item._id
        delete item._id

        publicRecDb.create(newId, item, { restoreRecord: true }, function (err, wrote) {
          fdlog(err, wrote)
          oldAccessibles.update(newId, { newDbUpdate3: true, newDbUpdate: null, newDbUpdate2: null }, { replaceAllFields: false, restoreRecord: true }, function (err, updated) {
            fdlog(err, updated)
            cb2(null)
          })
        })
        // add to publicRecDb.
        // review to make
      }, function (err) {
        cb(err)
      })
    }

  ], function (err) {
    if (err) console.warn(err)
    helpers.send_success(res, { success: true, err })
  })
}

// o-auth
const MAX_TIME = 30000
let cleanIntervaler = null
const listAllOauths = function (req, res) {
  fdlog('admin listAllOauths')
  const oauthenticatorsOac = {
    app_name: 'info.freezr.admin',
    collection_name: 'oauthors',
    owner: 'fradmin'
  }
  req.freezrFradminDS.initOacDB(oauthenticatorsOac, null, (err, oauthors) => {
    if (err) {
      helpers.send_internal_err_failure(res, 'admin_handler', exports.version, 'listAllOauths', 'failure to get oauthenticatorsOac' + err.message)
    } else {
      /* count: req.body.count, skip: req.body.skip */
      oauthors.query({}, { }, (err, results) => {
        if (err) {
          helpers.send_internal_err_failure(res, 'admin_handler', exports.version, 'listAllOauths', 'failure to get all user list - ' + err.message)
        } else {
          if (!results) results = []
          if (req.freezrInternalCallFwd) {
            req.freezrInternalCallFwd(null, { results })
          } else {
            helpers.send_success(res, { results })
          }
        }
      })
    }
  })
}
exports.oauth_perm_make = function (req, res) {
  fdlog('New or updated oauth for type: ' + req.body.type + ' name: ' + req.body.name)
  let update = null
  const isUpdate = Boolean(req.body._id)

  async.waterfall([
    function (cb) {
      if (isUpdate) {
        req.freezrOauthorDb.read_by_id(req.body._id, cb)
      } else {
        req.freezrOauthorDb.query({ type: req.body.type, name: req.body.name }, {}, cb)
      }
    },

    // 2. if exists update and if not write
    function (results, cb) {
      if (Array.isArray(results)) {
        if (results.length === 0) {
          results = null
        } else {
          results = results[0]
        }
      }
      const params = {
        type: req.body.type,
        name: req.body.name,
        key: req.body.key,
        redirecturi: req.body.redirecturi,
        secret: req.body.secret,
        enabled: req.body.enabled
      }
      if (!results) {
        if (isUpdate) {
          helpers.send_failure(res, helpers.error('Marked as update but no object found'), 'admin_handler', exports.version, 'oauth_make:item does not exist')
        } else {
          update = 'new'
          req.freezrOauthorDb.create(null, params, null, cb)
        }
      } else {
        update = 'update' + (isUpdate ? '' : '_unplanned')
        req.freezrOauthorDb.update((results._id + ''), params, { replaceAllFields: true }, cb)
      }
    }
  ],
  function (err, results) {
    if (err) {
      helpers.send_failure(res, err, 'admin_handler', exports.version, 'oauth_make')
    } else {
      helpers.send_success(res, { written: update })
    }
  })
}
const PKCELength = 128
const generatePKCECodes = function () {
  let codeVerifier = crypto.randomBytes(PKCELength)
  codeVerifier = codeVerifier.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
    .substr(0, 128)

  const encoder = new Encoder()
  const codeData = encoder.encode(codeVerifier)
  let codeChallenge = crypto.createHash('sha256').update(codeData).digest()
  codeChallenge = codeChallenge.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')

  return { codeChallenge, codeVerifier }
}

exports.oauth_do = function (req, res) {
  // app.get('/v1/admin/oauth/:dowhat', loggedInOrNotForSetUp, addAuthStateTokens, adminHandler.oauth_do)
  // dowhat can be: get_new_state or validate_state
  fdlog('oauth_do ' + req.params.dowhat, req.query)
  if (req.params.dowhat === 'get_new_state') {
    fdlog('oauth_do get_new_state')
    // Gets a new state to start a third party authorization process
    // example is v1/admin/oauth/public/get_new_state?source=dropbox&&name=freezr&&sender=http://myfreezr.com/first_registration&&type=file_env
    if (!req.query.type || !req.query.regcode || !req.query.sender) {
      fdlog('oauth_do get_new_state', 'missign params type || regcode || sender: ', req.query)
      helpers.send_failure(res, helpers.error('Need type, regcode and sender to get a state '), 'admin_handler', exports.version, 'oauth_do:get_new_state:missing_data')
    } else if (!environmentDefaults.FS_AUTH_URL[req.query.type]) {
      felog('oauth_do get_new_state', 'missign url generator for type', req.query.type)
      helpers.send_failure(res, helpers.error('missign url generator for type' + req.query.type), 'admin_handler', exports.version, 'oauth_do:get_new_state:missing_data')
    } else {
      // create new record
      req.freezrOauthorDb.query({ type: req.query.type, enabled: true }, null, (err, records) => {
        if (err) {
          helpers.send_failure(res, err, 'admin_handler', exports.version, 'oauth not available - ' + err)
        } else if (!records || records.length === 0) {
          helpers.send_failure(res, helpers.error('No records found in oauth'), 'admin_handler', exports.version, 'oauth not available - no records')
        } else if (records[0].enabled) {
          const state = helpers.randomText(40)
          const { codeChallenge, codeVerifier } = generatePKCECodes()

          req.authStatesStore[state] = {
            ip: req.ip,
            date_created: new Date().getTime(),
            type: req.query.type,
            regcode: req.query.regcode,
            sender: req.query.sender,
            redirecturi: (helpers.startsWith(req.get('host'), 'localhost') ? 'http' : 'https') + '://' + req.headers.host + '/admin/public/oauth_validate_page',
            state,
            codeChallenge,
            codeVerifier,
            clientId: records[0].key,
            secret: records[0].secret,
            name: records[0].name
          }

          const authUrl = environmentDefaults.FS_AUTH_URL[req.query.type] ? environmentDefaults.FS_AUTH_URL[req.query.type](req.authStatesStore[state]) : null

          req.session.oauth_state = state

          helpers.send_success(res, { redirecturi: authUrl })
        } else {
          helpers.send_failure(res, helpers.error('unauthorized access to oauth'), 'admin_handler', exports.version, 'oauth unauthoried access')
        }
        cleanIntervaler = setTimeout(clearStatesTimeOut, MAX_TIME)
      })
    }
  } else if (req.params.dowhat === 'validate_state') {
    // allows third parties to validate that they have been authroized
    fdlog('oauth_do validate_state', 'looking for state ', req.query.state)
    if (req.query.accessToken === 'null') req.query.accessToken = null
    if (req.query.code === 'null') req.query.code = null
    const stateParams = req.authStatesStore[req.query.state]
    // if (!stateParams && req.query.state === 'n9JJSOq29MRh2ZOm0rwftLCnS00o1jMQbDQsqN6T') stateParams = { source: 'dropbox', name: 'testNedb', date_created: new Date().getTime() - 3000 }
    fdlog('oauth_do validate_state', 'req.session.oauth_state', req.session.oauth_state, 'req.query.state', req.query.state)
    async.waterfall([
      // 1. check oauth state
      function (cb) {
        if (!stateParams) {
          cb(helpers.auth_failure('admin_handler', exports.version, 'oauth_do:validate_state', 'No auth state presented', 'auth_error_no_state'))
        } else if (req.session.oauth_state !== req.query.state) {
          cb(helpers.auth_failure('admin_handler', exports.version, 'oauth_validate_page', 'state mismatch', 'auth_error_state_mismatch'))
        } else if (MAX_TIME < ((new Date().getTime()) - stateParams.date_created)) {
          cb(helpers.auth_failure('admin_handler', exports.version, 'oauth_validate_page', 'state time exceeded', 'auth_error_state_time_exceeded'))
        } else if (!req.query.code && !req.query.accessToken) {
          cb(helpers.auth_failure('admin_handler', exports.version, 'oauth_validate_page', 'missing code or access token', 'auth_error_state_time_exceeded'))
        } else {
          if (req.query.code) stateParams.code = req.query.code
          cb(null)
        }
      },
      // 2. get the permission
      function (cb) {
        req.freezrOauthorDb.query({ type: stateParams.type, name: stateParams.name }, null, cb)
      },
      // 3. to make sure it is still enabled
      function (records, cb) {
        if (!records || records.length === 0) {
          cb(helpers.auth_failure('admin_handler', exports.version, 'oauth_validate_page', 'auth record does not exist', 'auth_error_record_missing'))
        } else if (!records[0].enabled) {
          cb(helpers.auth_failure('admin_handler', exports.version, 'oauth_validate_page', 'auth record is not enabled', 'auth_error_record_disabled'))
        } else {
          cb(null)
        }
      },
      // get
      function (cb) {
        const refreshTokenGetter = environmentDefaults.FS_getRefreshToken[stateParams.type]
        fdlog('getting refresher for ' + stateParams.type + ' exists?  ' + environmentDefaults.FS_getRefreshToken[stateParams.type] ? 'yes ' : 'no ')
        if (!refreshTokenGetter) {
          cb(null, null)
        } else {
          refreshTokenGetter(stateParams, cb)
        }
      },
      // 5. ...
      function (token, cb) {
        if (token) {
          fdlog('recheck this for dropbox')
          stateParams.refreshToken = token.refresh_token
          stateParams.accessToken = token.access_token
          stateParams.expiry = token.expiry_date
        }
        fdlog('todo later - record the state in the db')
        cb(null)
      }
    ],
    function (err) {
      if (err) felog('oauth_do validate_state', err)
      fdlog('oauth_do validate_state', 'In future , consider sending the details to the sender server directly - weight security trade offs. - todolater')
      if (err) {
        helpers.send_failure(res, err, 'admin_handler', exports.version, 'oauth_do:get_new_state:collection')
      } else {
        const toSend = {
          code: req.query.code,
          accessToken: req.query.accessToken || stateParams.accessToken,
          regcode: stateParams.regcode,
          type: stateParams.type,
          sender: stateParams.sender,
          clientId: stateParams.clientId,
          codeChallenge: stateParams.codeChallenge,
          codeVerifier: stateParams.codeVerifier,
          redirecturi: stateParams.redirecturi,
          refreshToken: stateParams.refreshToken,
          expiry: stateParams.expiry,
          success: true
        }
        if (stateParams.type === 'googleDrive') {
          toSend.secret = stateParams.secret
          fdlog('Unfortunatley for googleDrive, the only way to authentivcate, without having to reping the authenticator server every hour is to divulge the secret. so be it. ')
        }
        delete req.authStatesStore[req.query.state]
        req.session.oauth_state = null
        helpers.send_success(res, toSend)
      }
    })
  } else {
    helpers.send_failure(res, helpers.error('no dowhat sent to auth'), 'admin_handler', exports.version, 'oauth_do:Invalid dowhat')
  }
}
const clearStatesTimeOut = function () {
  cleanUnusedStates()
  clearTimeout(cleanIntervaler)
}
const cleanUnusedStates = function () {
  fdlog(null, 'Clean out old states - todo')
}

// Loggers
const LOG_ERRORS = true
const felog = function (...args) { if (LOG_ERRORS) helpers.warning('account_handler.js', exports.version, ...args) }
const LOG_DEBUGS = false
const fdlog = function (...args) { if (LOG_DEBUGS) console.log(...args) }
