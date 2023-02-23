// freezr.info - nodejs system files - main file: server.js
const VERSION = '0.0.211'

// todo: const visitLogger = require('./freezr_system/visit_logger.js')

// testing that files do not have errors
// console.log('dirname ' + __dirname)
// const tester1 = require(__dirname + '/node_modules/nedb-asyncfs/env/dbfs_googleDrive.js')

// INITALISATION / APP / EXPRESS
console.log('=========================  VERSION Jan 2023  =======================')
const express = require('express')
const bodyParser = require('body-parser')
const multer = require('multer')
const upload = multer().single('file')
const cookieParser = require('cookie-parser')
const cookieSession = require('cookie-session')
const session = require('express-session')
const async = require('async')
const app = express()

const accessHandler = require('./freezr_system/access_handler.js')
const adminHandler = require('./freezr_system/admin_handler.js')
const accountHandler = require('./freezr_system/account_handler.js')
const helpers = require('./freezr_system/helpers.js')
const environmentDefaults = require('./freezr_system/environment/environment_defaults.js')
const appHandler = require('./freezr_system/app_handler.js')
const permHandler = require('./freezr_system/perm_handler.js')
const publicHandler = require('./freezr_system/public_handler.js')
const DS_MANAGER = require('./freezr_system/ds_manager.js')

// LOGGING
const LOG_ERRORS = true
const felog = function (...args) { if (LOG_ERRORS) helpers.warning('server.js', exports.version, ...args) }
const LOG_DEBUGS = false
const fdlog = function (...args) { if (LOG_DEBUGS) console.log(...args) }

// SET UP
app.use(bodyParser.json({ limit: 1024 * 1024 * 3, type: 'application/json' }))
// stackoverflow.com/questions/26287968/meanjs-413-request-entity-too-large
app.use(bodyParser.urlencoded({ extended: true, limit: 1024 * 1024 * 3, type: 'application/x-www-form-urlencoding' }))
app.use(cookieParser())
app.enable('trust proxy') // for heroku -

const DEFAULT_PREFS = adminHandler.DEFAULT_PREFS
const dsManager = new DS_MANAGER()
let freezrPrefs = {}
const freezrSelfRegPrefs = function () {
  return {
    allow: freezrPrefs.allowSelfReg,
    allowAccessToSysFsDb: freezrPrefs.allowAccessToSysFsDb,
    defaultMBStorageLimit: freezrPrefs.selfRegDefaultMBStorageLimit
  }
}
// ACCESS AND PERMISSION FUNCTIONS
function uploadFile (req, res) {
  felog('server.js', 'uploadFile needs to be updated with dsManager')
  upload(req, res, function (err) {
    if (err) {
      helpers.send_failure(res, err, 'server.js', VERSION, 'uploadFile')
    } else {
      appHandler.create_file_record(req, res)
    }
  })
}
function installAppFromZipFile (req, res) {
  // part updated - to recheck
  upload(req, res, function (err) {
    if (err) {
      helpers.send_failure(res, err, 'server.js', VERSION, 'installAppFromZipFile')
    }
    accountHandler.install_app(req, res)
  })
}

// perm_handler and  access_handler (Adding relevant dcManagers)
const userLoginHandler = function (req, res, next) {
  accessHandler.userLoginHandler(req, res, dsManager, next)
}
const appTokenLoginHandler = function (req, res, next) {
  accessHandler.appTokenLoginHandler(req, res, dsManager, next)
}
const accountLoggedInUserPage = function (req, res, next) {
  req.params.app_name = 'info.freezr.account'
  req.freezrStatus = freezrStatus
  fdlog('todo - add freezrstatus to account main page and give status')
  accessHandler.loggedInUserPage(req, res, dsManager, next)
}
const accountLoggedInAPI = function (req, res, next) {
  req.params.app_name = 'info.freezr.account'
  accessHandler.accountLoggedInAPI(req, res, dsManager, next)
}
const adminLoggedInUserPage = function (req, res, next) {
  req.params.app_name = 'info.freezr.admin'
  accessHandler.loggedInUserPage(req, res, dsManager, next)
}
const adminLoggedInAPI = function (req, res, next) {
  req.params.app_name = 'info.freezr.admin'
  req.freezrPrefsTempPw = dsManager.freezrPrefsTempPw
  accessHandler.accountLoggedInAPI(req, res, dsManager, next)
}
const addAllUsersDb = function (req, res, next) {
  permHandler.addAllUsersDb(req, res, dsManager, next)
}
const loggedInUserPage = function (req, res, next) {
  if (req.params.app_name === 'info.freezr.public') {
    // fdlog('loggedInUserPage public ' + req.originalUrl)
    accessHandler.publicUserPage(req, res, dsManager, next)
  } else {
    // fdlog('loggedInUserPage private ' + req.originalUrl)
    accessHandler.loggedInUserPage(req, res, dsManager, next)
  }
}
const loggedInOrNotForSetUp = function (req, res, next) {
  req.params.app_name = 'info.freezr.public'
  req.freezrAllowSelfReg = freezrPrefs.allowSelfReg
  req.freezrAllowAccessToSysFsDb = freezrPrefs.allowAccessToSysFsDb
  // delete above
  req.freezrSelfRegOptions = freezrSelfRegPrefs()
  accessHandler.loggedInOrNotForSetUp(req, res, dsManager, next)
}
const publicUserPage = function (req, res, next) {
  if (!req.params.app_name) req.params.app_name = 'info.freezr.public' // todo - where is this used
  // add req.freezrAppFS
  accessHandler.publicUserPage(req, res, dsManager, next)
}
const checkSetUp = function (req, res, next) {
  if (dsManager.freezrIsSetup) {
    req.freezrAllowSelfReg = freezrPrefs.allowSelfReg
    // delete above
    req.freezrSelfRegOptions = freezrSelfRegPrefs()
    next()
  } else {
    res.redirect('/info.freezr.admin/public/starterror.html')
  }
}
const checkFirstSetUp = function (req, res, next) {
  if (dsManager.freezrIsSetup) {
    felog('server.js', 'first set up not created yet ')
    res.sendStatus(401)
  } else {
    fdlog('todo - ALSO CHECK THERE ARE NO USERS IN DB? - dsManager.initialEnvironment ' + JSON.stringify(dsManager.initialEnvironment))
    console.log('todo - ALSO CHECK THERE ARE NO USERS IN DB? - dsManager.initialEnvironment ' + JSON.stringify(dsManager.initialEnvironment))
    req.freezrStatus = freezrStatus
    req.freezrInitialEnvCopy = JSON.parse(JSON.stringify(dsManager.initialEnvironment))
    const localManager = new DS_MANAGER()
    localManager.setSystemUserDS('fradmin', { dbParams: {}, fsParams: { type: 'local' } })
    localManager.getOrInitUserAppFS('fradmin', 'info.freezr.public', {}, (err, localAppFS) => {
      if (err) felog('server.js', 'Serious error in fs of localManager - this should not happen!!!', err)
      req.freezrAppFS = localAppFS
      console.log('got fradmin')
      next()
    })
  }
}
const selfRegisterChecks = function (req, res, next) {
  if (!dsManager.freezrIsSetup) {
    // fdlog('will check checkFirstSetUp selfRegisterChecks')
    checkFirstSetUp(req, res, next)
  } else if (req.session.logged_in_user_id) {
    // for adding your own parameters
    req.params.app_name = 'info.freezr.admin'

    req.freezrAllowSelfReg = freezrPrefs.allowSelfReg
    req.freezrAllowAccessToSysFsDb = freezrPrefs.allowAccessToSysFsDb
    // delete above
    fdlog('current initial env ', dsManager.initialEnvironment)
    if (req.freezrAllowAccessToSysFsDb) req.freezrInitialEnvCopy = dsManager.initialEnvironment
    next()
  } else if (freezrPrefs.allowSelfReg) {
    req.freezrAllowSelfReg = true
    req.freezrAllowAccessToSysFsDb = freezrPrefs.allowAccessToSysFsDb
    // delete above
    // req.freezrSelfRegOptions = freezrSelfRegPrefs()
    next()
  } else {
    res.sendStatus(401)
  }
}
const addSelfRegOptions = function (req, res, next) {
  req.freezrSelfRegOptions = freezrSelfRegPrefs()
  next()
}

const redirectToIndex = function (req, res, next) {
  res.redirect('/apps/' + req.params.app_name + '/index.html')
}
const userAPIRights = function (req, res, next) {
  accessHandler.userAPIRights(req, res, dsManager, next)
}
const possibleUserAPIForMessaging = function (req, res, next) {
  // for ceps/message/:action
  if (['initiate'].includes(req.params.action)) {
    accessHandler.userAPIRights(req, res, dsManager, next)
  } else {
    next()
  }
}
const getTargetManifest = function (req, res, next) {
  // Gets manifest for itself unless it is logged in under account
  accessHandler.getManifest(req, res, dsManager, next)
}
const getManifest = function (req, res, next) {
  // fdlog('getManifest')
  accessHandler.getManifest(req, res, dsManager, next)
}
const userAppLogOut = function (req, res, next) {
  // used to log out of apps
  accessHandler.userAppLogOut(req, res, dsManager, next)
}
const userLogOut = function (req, res, next) {
  // used to log out
  accessHandler.userLogOut(req, res, dsManager, next)
}
const readWriteUserData = function (req, res, next) {
  permHandler.readWriteUserData(req, res, dsManager, next)
}
const addUserAppsAndPermDBs = function (req, res, next) {
  permHandler.addUserAppsAndPermDBs(req, res, dsManager, next)
}
const addPublicRecordsDB = function (req, res, next) {
  permHandler.addPublicRecordsDB(req, res, dsManager, next)
}
const addPublicRecordAndIfFileFileFS = function (req, res, next) {
  permHandler.addPublicRecordAndIfFileFileFS(req, res, dsManager, next)
}

const addUserFsFromTokenInfo = function (req, res, next) {
  permHandler.addUserFsFromTokenInfo(req, res, dsManager, next)
}
const addPublicUserFs = function (req, res, next) {
  permHandler.addPublicUserFs(req, res, dsManager, next)
}
const addUserFs = function (req, res, next) {
  permHandler.addUserFs(req, res, dsManager, next)
}

const addUserPermsAndRequesteeDB = function (req, res, next) {
  permHandler.addUserPermsAndRequesteeDB(req, res, dsManager, next)
}
const addUserPermDBs = function (req, res, next) {
  permHandler.addUserPermDBs(req, res, dsManager, next)
}
const addAppTokenDB = function (req, res, next) {
  permHandler.addAppTokenDB(req, res, dsManager, next)
}
const addUserDs = function (req, res, next) {
  permHandler.addUserDs(req, res, dsManager, next)
}
const addFradminDs = function (req, res, next) {
  req.freezrPrefs = freezrPrefs
  permHandler.addFradminDs(req, res, dsManager, next)
}
const addUserFilesDb = function (req, res, next) {
  if (!req.params.user_id && req.session.logged_in_user_id) req.params.user_id = req.session.logged_in_user_id // for uploading
  permHandler.addUserFilesDb(req, res, dsManager, next)
}
const addValidationDBs = function (req, res, next) {
  permHandler.addValidationDBs(req, res, dsManager, next)
}

const addMessageDb = function (req, res, next) {
  permHandler.addMessageDb(req, res, dsManager, next)
}
const selfRegAdds = function (req, res, next) {
  permHandler.selfRegAdds(req, res, dsManager, next)
}

const authStatesStore = {}
const addoAuthers = function (req, res, next) {
  req.authStatesStore = authStatesStore
  permHandler.addoAuthers(req, res, dsManager, next)
}
const addVersionNumber = function (req, res, next) {
  fdlog('need to redo addVersionNumber for public access')
  req.freezr_server_version = VERSION
  req.freezrIsSetup = dsManager.freezrIsSetup
  next()
}
const toReviewAndRedo = function (req, res, next) {
  felog('server.js', 'This need to be redone')
  next()
}

// APP PAGES AND FILE OPERATIONS
const addAppUses = function (cookieSecrets) {
  // headers and cookies
  app.use(cookieSession(
    // fdlog ('todolater - move to a method (if possible) to be able to reset coookie secret programmatically?')
    {
      secret: cookieSecrets.session_cookie_secret,
      maxAge: 15552000000,
      store: new session.MemoryStore() // todo review updates
    }
  ))
  app.use(function (req, res, next) {
    // stackoverflow.com/questions/22535058/including-cookies-on-a-ajax-request-for-cross-domain-request-using-pure-javascri
    res.header('Access-Control-Allow-Credentials', 'true')
    res.header('Access-Control-Allow-Origin', null)
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Origin, Accept')
    res.header('Access-Control-Allow-Methods', 'PUT, POST, GET, OPTIONS')
    next()
  })

  // app pages and files
  // New updated
  app.get('/apps/:app_name', redirectToIndex)
  app.get('/apps/:app_name/:page', loggedInUserPage, getManifest, appHandler.generatePage)

  // todo - to redo
  app.get('/favicon.ico', publicUserPage, servePublicAppFile)

  app.get('/app_files/:user_id/:app_name/public/static/:file', publicUserPage, servePublicAppFile)
  app.get('/app_files/:user_id/:app_name/public/:file', publicUserPage, servePublicAppFile)
  app.get('/app_files/:user_id/:app_name/public/static/:file', publicUserPage, servePublicAppFile)
  app.get('/app_files/:app_name/public/static/:file', loggedInUserPage, servePublicAppFile) // since there is no user id, iser must be logged in
  // console.log todo review - why .use and not .get on below
  app.use('/app_files/:app_name/static/:file', loggedInUserPage, serveAppFile)
  app.use('/app_files/:user_id/:app_name/:file', loggedInUserPage, serveAppFile)
  app.use('/app_files/:app_name/:file', loggedInUserPage, serveAppFile)
  app.get('/apps/:user_id/:app_name/public/static/:file', publicUserPage, serveAppFile)
  app.get('/apps/:app_name/static/:file', loggedInUserPage, serveAppFile)
  app.get('/apps/:user_id/:app_name/static/:file', loggedInUserPage, serveAppFile)

  // public todo fdlog('to review')
  app.get('/pcard/:user_id/:requestor_app/:permission_name/:app_name/:collection_name/:data_object_id', publicUserPage, addPublicRecordsDB, addPublicUserFs, publicHandler.generatePublicPage)
  app.get('/pcard/:user_id/:app_name/:collection_name/:data_object_id', publicUserPage, addPublicRecordsDB, addPublicUserFs, publicHandler.generatePublicPage)

  app.get('/papp/:user_id/:app_name/:page', publicUserPage, addPublicRecordsDB, addPublicUserFs, publicHandler.generatePublicPage)
  app.get('/papp/:user_id/:app_name', publicUserPage, addPublicRecordsDB, addPublicUserFs, publicHandler.generatePublicPage)
  app.get('/ppage/:user_id/:app_table/:data_object_id', publicUserPage, addPublicRecordAndIfFileFileFS, publicHandler.generateSingleObjectPage)
  // app.get('/ppage/:user_id/:partial_public_id', publicUserPage, addPublicRecordsDB, publicHandler.generatePublicObjectPage)
  app.get('/ppage/:object_public_id', publicUserPage, addPublicRecordAndIfFileFileFS, publicHandler.generateSingleObjectPage)
  app.get('/ppage', publicUserPage, addPublicRecordsDB, publicHandler.generatePublicPage)
  app.get('/rss.xml', publicUserPage, addPublicRecordsDB, publicHandler.generatePublicPage)
  app.get('/papp_files/:user_id/:app_name/public/static/:file', addPublicRecordsDB, addPublicUserFs, servePublicAppFile) // Note changed dec 2021 from "/apps",,, to review todo console.log
  app.get('/v1/pdbq', addPublicRecordsDB, publicHandler.dbp_query)
  app.get('/v1/pdbq/:app_name', addPublicRecordsDB, publicHandler.dbp_query)
  app.post('/v1/pdbq', addPublicRecordsDB, publicHandler.dbp_query)
  app.get('/v1/pobject/:user_id/:requestee_app_table/:data_object_id', addPublicRecordsDB, publicHandler.generatePublicPage)

  app.get('/v1/publicfiles/:user_id/:app_name/*', addPublicRecordsDB, addUserFilesDb, addPublicUserFs, publicHandler.old_get_public_file) // legacy
  app.get('/publicfiles/:app_name/:user_id/*', addPublicRecordsDB, addUserFilesDb, addPublicUserFs, publicHandler.get_public_file)

  // UPLOADED PUBLIC PAGES ... gets them from the personal page // publicpages
  app.get('/papp/:user_id/:app_name/:page', publicUserPage, addPublicRecordsDB, addPublicUserFs, publicHandler.generatePublicPage)

  // developer utilities
  app.get('/v1/developer/manifest', userAPIRights, getTargetManifest, addUserDs, appHandler.getManifest)

  // account pages
  app.get('/login', publicUserPage, accountHandler.generate_login_page)
  app.get('/account/login', checkSetUp, publicUserPage, accountHandler.generate_login_page)
  app.get('/account/logout', userLogOut)
  app.get('/account/reauthorise', accountLoggedInUserPage, function (req, res, next) { req.params.page = 'reauthorise'; next() }, accountHandler.generateAccountPage)
  app.get('/account/app/:sub_page/:target_app', accountLoggedInUserPage, addUserAppsAndPermDBs, (req, res, next) => { req.params.page = 'app'; next() }, accountHandler.generateAccountPage)
  app.get('/account/app/:sub_page', accountLoggedInUserPage, addUserAppsAndPermDBs, (req, res, next) => { req.params.page = 'app'; next() }, accountHandler.generateAccountPage)
  // todo recorg the below
  app.get('/account/appdata/:target_app/:action', accountLoggedInUserPage, addUserAppsAndPermDBs, accountHandler.generateSystemDataPage)
  app.get('/account/:page/:target_app', accountLoggedInUserPage, addUserAppsAndPermDBs, accountHandler.generateAccountPage) // for page = 'perms'
  app.get('/account/:page', accountLoggedInUserPage, addUserAppsAndPermDBs, accountHandler.generateAccountPage)

  app.get('/v1/account/data/:action', accountLoggedInAPI, accountHandler.get_account_data) // app_list.json, app_resource_use.json
  app.post('/v1/account/login', userLoginHandler)
  app.post('/v1/account/applogout', userAppLogOut)

  app.post('/v1/account/appMgmtActions.json', accountLoggedInAPI, addUserAppsAndPermDBs, accountHandler.appMgmtActions)
  app.put('/v1/account/data/setPrefs.json', accountLoggedInAPI, addAllUsersDb, addUserAppsAndPermDBs, accountHandler.setPrefs)
  app.put('/v1/account/changePassword.json', accountLoggedInAPI, addAllUsersDb, accountHandler.changePassword)
  app.get('/v1/account/apppassword/generate', accountLoggedInAPI, addAppTokenDB, accountHandler.app_password_generate_one_time_pass)
  app.get('/v1/account/apppassword/updateparams', accountLoggedInAPI, addAppTokenDB, accountHandler.app_password_update_params)
  app.put('/v1/account/removeFromFreezr.json', accountLoggedInAPI, addAllUsersDb, addPublicRecordsDB, accountHandler.removeFromFreezr)

  app.put('/v1/account/app_install_from_zipfile.json', accountLoggedInUserPage, addUserAppsAndPermDBs, installAppFromZipFile)
  app.post('/v1/account/app_install_from_url.json', accountLoggedInUserPage, addUserAppsAndPermDBs, accountHandler.get_file_from_url_to_install_app)
  app.post('/v1/account/app_install_blank', accountLoggedInUserPage, addUserAppsAndPermDBs, accountHandler.install_blank_app)

  // admin pages
  app.get('/admin/firstSetUp', checkFirstSetUp, adminHandler.generateFirstSetUpPage)
  app.get('/admin/selfregister', loggedInOrNotForSetUp, publicUserPage, adminHandler.generate_UserSelfRegistrationPage)
  app.get('/admin/SimpleSelfregister', loggedInOrNotForSetUp, publicUserPage, adminHandler.generate_UserSelfRegistrationPage)
  app.get('/admin/public/:sub_page', publicUserPage, adminHandler.generatePublicAdminPage)
  app.get('/admin/:sub_page', adminLoggedInUserPage, addFradminDs, adminHandler.generateAdminPage)
  app.get('/admin', adminLoggedInUserPage, addFradminDs, adminHandler.generateAdminPage)

  app.post('/v1/admin/self_register', selfRegisterChecks, addSelfRegOptions, selfRegAdds, adminHandler.self_register)
  app.put('/v1/admin/user_register', adminLoggedInAPI, addSelfRegOptions, addFradminDs, adminHandler.user_register)
  app.put('/v1/admin/change_main_prefs', adminLoggedInAPI, addFradminDs, adminHandler.change_main_prefs, function (req, res) {
    freezrPrefs = req.freezrPrefs
    helpers.send_success(res, { success: true, newPrefs: req.freezrPrefs })
  })

  // admin pages - NOT UPDATED
  app.post('/v1/admin/dbquery/:collection_name', toReviewAndRedo, adminLoggedInAPI) // old: adminHandler.dbquery)

  // Auth
  app.put('/v1/admin/oauth_perm', adminLoggedInAPI, addoAuthers, adminHandler.oauth_perm_make)

  app.get('/v1/admin/oauth/public/:dowhat', addoAuthers, adminHandler.oauth_do)

  app.post('/oauth/token', appTokenLoginHandler)

  // CEPS
  app.post('/ceps/write/:app_table', userAPIRights, readWriteUserData, appHandler.write_record)
  app.get('/ceps/read/:app_table/:data_object_id', userAPIRights, readWriteUserData, appHandler.read_record_by_id)
  app.get('/ceps/query/:app_table', userAPIRights, readWriteUserData, appHandler.db_query)
  app.put('/ceps/update/:app_table/:data_object_id', userAPIRights, readWriteUserData, appHandler.write_record)
  app.delete('/ceps/delete/:app_table/:data_object_id', userAPIRights, readWriteUserData, appHandler.delete_record)
  app.get('/ceps/ping', addVersionNumber, accountHandler.ping)

  // Permissions
  app.get('/ceps/perms/view/:app_name', (req, res) => res.redirect('/account/perms/' + req.params.app_name +
    (req.query.name ? ('?permission_name=' + req.query.name) : '')))
  app.get('/ceps/perms/get', userAPIRights, addUserPermDBs, accountHandler.CEPSrequestorAppPermissions)
  app.get('/ceps/perms/validationtoken/:action', addValidationDBs, accountHandler.CEPSValidator) // for actions validate, verify
  app.post('/ceps/perms/validationtoken/:action', userAPIRights, addValidationDBs, accountHandler.CEPSValidator) // for action set

  // TO UPDATE - userfiles - NOT checked for updates to dsManager
  app.post('/ceps/perms/share_records', userAPIRights, addUserPermsAndRequesteeDB, addPublicRecordsDB, appHandler.shareRecords)
  app.post('/feps/perms/share_records', userAPIRights, addUserPermsAndRequesteeDB, addPublicRecordsDB, addUserFsFromTokenInfo, appHandler.shareRecords)
  app.post('/ceps/message/:action', possibleUserAPIForMessaging, addUserPermsAndRequesteeDB, addMessageDb, appHandler.messageActions)
  // app.get('/ceps/message/:action' /* action = get */, possibleUserAPIForMessaging, addMessageDb, appHandler.messageActions)

  // updated feps
  app.get('/feps/ping', addVersionNumber, accountHandler.ping)
  app.get('/feps/read/:app_table/:data_object_id', userAPIRights, readWriteUserData, appHandler.read_record_by_id)
  app.get('/feps/query/:app_table', userAPIRights, readWriteUserData, appHandler.db_query)
  app.post('/feps/query/:app_table', userAPIRights, readWriteUserData, appHandler.db_query)
  app.post('/feps/write/:app_table', userAPIRights, readWriteUserData, appHandler.write_record)
  app.post('/feps/write/:app_table/:data_object_id', userAPIRights, readWriteUserData, appHandler.write_record)
  app.put('/feps/update/:app_table/:data_object_id', userAPIRights, readWriteUserData, appHandler.write_record)
  app.put('/feps/update/:app_table/:data_object_start/*', userAPIRights, readWriteUserData, appHandler.write_record)
  app.put('/feps/update/:app_table', userAPIRights, readWriteUserData, appHandler.write_record)
  app.post('/feps/upsert/:app_table', userAPIRights, readWriteUserData, appHandler.write_record)
  app.post('/feps/restore/:app_table', userAPIRights, readWriteUserData, appHandler.restore_record)
  app.delete('/feps/delete/:app_table', userAPIRights, readWriteUserData, addUserFsFromTokenInfo, appHandler.delete_record)
  app.delete('/feps/delete/:app_table/:data_object_id', userAPIRights, readWriteUserData, addUserFsFromTokenInfo, appHandler.delete_record)
  app.delete('/feps/delete/:app_table/:data_object_start/*', userAPIRights, readWriteUserData, addUserFsFromTokenInfo, appHandler.delete_record)

  app.put('/feps/upload/:app_name', userAPIRights, readWriteUserData, addUserFilesDb, addUserFs, uploadFile)
  app.get('/feps/getuserfiletoken/:permission_name/:app_name/:user_id/*', userAPIRights, readWriteUserData, addUserFilesDb, appHandler.read_record_by_id) // collection_name is files
  app.get('/feps/userfiles/:app_name/:user_id/*', addUserFs, appHandler.sendUserFileWithFileToken) // collection_name is files
  app.get('/feps/fetchuserfiles/:app_name/:user_id/*', userAPIRights, addUserFs, appHandler.sendUserFileWithAppToken) // collection_name is files
  // app.get('/v1/developer/fileListUpdate/:app_name', toReviewAndRedo, userAPIRights, appHandler.updateFileList);
  // app.get('/v1/developer/fileListUpdate/:app_name/:folder_name', toReviewAndRedo, userAPIRights, appHandler.updateFileList);

  // permissions
  app.get('/v1/permissions/gethtml/:app_name', userAPIRights, addUserPermDBs, accountHandler.generatePermissionHTML)
  app.get('/v1/permissions/getall/:app_name', userAPIRights, addUserPermDBs, accountHandler.allRequestorAppPermissions)
  app.put('/v1/permissions/change', accountLoggedInAPI, getTargetManifest, addUserPermsAndRequesteeDB, addPublicRecordsDB, accountHandler.changeNamedPermissions)
  // app.put('/v1/permissions/change/:requestee_app_table', accountLoggedInAPI, getTargetManifest, addUserPermsAndRequesteeDB, addPublicRecordsDB, accountHandler.changeNamedPermissions)

  // default redirects
  function getPublicUrlFromPrefs () {
    // fdlog('getPublicUrlFromPrefs dsManager.freezrIsSetup ' + dsManager.freezrIsSetup)
    if (!dsManager.freezrIsSetup) return '/admin/firstSetUp'
    if (!freezrPrefs || !freezrPrefs.redirect_public) return '/account/login'
    if (!freezrPrefs.public_landing_page && !freezrPrefs.public_landing_app) return '/ppage'
    if (freezrPrefs.public_landing_page) return '/' + freezrPrefs.public_landing_page
    return '/papp/' + freezrPrefs.public_landing_app
  }
  app.get('/feps*', function (req, res) {
    fdlog('feps', 'unknown feps api url ' + req.url)
    helpers.send_failure(res, helpers.error('invalid api url: ', req.path), 'server.js', VERSION, 'server')
  })
  app.get('/ceps*', function (req, res) {
    fdlog('ceps', 'Unknown feps api url ' + req.url)
    helpers.send_failure(res, helpers.error('invalid api url: ', req.path), 'server.js', VERSION, 'server')
  })
  app.get('/v1/*', function (req, res) {
    fdlog('/v1/*', 'unknown api url ' + req.url)
    helpers.send_failure(res, helpers.error('invalid api url:', req.path), 'server.js', VERSION, 'server')
  })
  app.get('/public', function (req, res) {
    res.redirect(getPublicUrlFromPrefs())
    res.end()
  })
  app.get('/', function (req, res) {
    // if allows public people coming in, then move to public page
    const redirectUrl = (req.session && req.session.logged_in_user_id) ? '/account/home' : getPublicUrlFromPrefs()
    fdlog(req, 'home url redirect')
    res.redirect(redirectUrl)
    res.end()
  })
  app.get('*', publicUserPage, addPublicRecordAndIfFileFileFS, publicHandler.generateSingleObjectPage)
}
const serveAppFile = function (req, res, next) {
  fdlog((new Date()) + ' serveAppFile - url' + req.originalUrl + `for user ${req.params.user_id} and app ${req.params.app_name} - is logged in ${req.session.logged_in_user_id} - file is ${req.params.file}`)
  if (req.params.app_name === 'info.freezr.public') {
    servePublicAppFile(req, res, next)
  } else {
    let fileUrl = req.originalUrl
    fileUrl = fileUrl.split('?')[0]
    const countToEnd = req.params.user_id ? 4 : 3
    let parts = fileUrl.split('/')
    parts = parts.slice(countToEnd)
    const endpath = parts.join('/')
    fdlog('serveAppFile - endpath of ' + endpath + ' from ' + fileUrl, 'req.freezrAppFS  is ', req.freezrAppFS)
    req.freezrAppFS.sendAppFile(endpath, res, {})
  }
}
const servePublicAppFile = function (req, res, next) {
  let fileUrl = req.originalUrl
  fileUrl = fileUrl.split('?')[0]
  const countToEnd = req.params.user_id ? 4 : 3
  let parts = fileUrl.split('/')
  parts = parts.slice(countToEnd)
  let endpath = parts.join('/')

  fdlog('servePublicAppFile - endpath of ' + endpath + ' from ' + fileUrl + ' app name is ' + req.params.app_name)

  // favicon exception
  if (fileUrl.slice(1) === 'favicon.ico') {
    endpath = 'public/static/favicon.ico'
  }

  fdlog('servePublicAppFile - endpath of ' + endpath + ' from ' + fileUrl + ' app name is ' + req.params.app_name)
  req.freezrAppFS.sendPublicAppFile(endpath, res, {})
}

// SET UP AND RUN APP
const freezrStatus = {
  can_write_to_user_folder: false,
  can_read_write_to_db: false
}
const canUseDbAndFs = function (aStatus) {
  return (aStatus.can_write_to_user_folder && aStatus.can_read_write_to_db)
}
function newFreezrSecrets (secrets) {
  fdlog('newFreezrSecrets ', { secrets })
  // if (secrets) fdlog('secrets.session_cookie_secret ', secrets.session_cookie_secret)
  return {
    session_cookie_secret: ((secrets && secrets.session_cookie_secret) ? secrets.session_cookie_secret : helpers.randomText(40))
  }
}

const PARAMS_OAC = {
  owner: 'fradmin',
  app_name: 'info.freezr.admin',
  collection_name: 'params'
}
const USER_DB_OAC = {
  app_name: 'info.freezr.admin',
  collection_name: 'users',
  owner: 'fradmin'
}
let fradminAdminFs = null

// setting up initialEnvironment
// Checks file on server - if so, use that but check against the version of the db and mark error if they are different
// But if file doesn't exist (it could be because of a restart in docker wiping it out) use the db. (Not an error - just warn)
async.waterfall([
  // 1 Read initialEnvironment from file and initiate environment or use defaults
  function (cb) {
    fdlog('startup waterfall - set up part 1a - detect params')
    environmentDefaults.tryGettingEnvFromautoConfig(cb)
  },

  // 2. SET FREEZR_ENV AND TRY INITIATING DB
  function (detectedParams, cb) {
    fdlog('startup waterfall - set up part 1b ', { detectedParams })
    if (detectedParams.envOnFile && detectedParams.envOnFile.freezrIsSetup) {
      if (!detectedParams.envOnFile.fsParams || !detectedParams.envOnFile.dbParams) throw new Error('freezr was initiated but envOnFile not found')
      dsManager.freezrIsSetup = true
      const systemEnv = {
        fsParams: detectedParams.envOnFile.fsParams,
        dbParams: detectedParams.envOnFile.dbParams
      }
      dsManager.setSystemUserDS('fradmin', systemEnv)
      dsManager.initialEnvironment = detectedParams.envOnFile
    } else {
      dsManager.initialEnvironment = detectedParams.autoConfig
    }
    environmentDefaults.checkDB(dsManager.initialEnvironment, { okToCheckOnLocal: true }, cb)
  },
  // See if db is working => freezrStatus.can_read_write_to_db
  function (dbWorks, cb) {
    fdlog('startup waterfall - set up part 2 - dbworks ? ', dbWorks)
    if (dbWorks) freezrStatus.can_read_write_to_db = true
    if (dbWorks && dsManager.freezrIsSetup) {
      dsManager.initOacDB(PARAMS_OAC, null, (err, adminParams) => {
        if (err) console.warn('error writing to db after test has passed - this should not happen!!! - (todo: can_read_write_to_db to false?)', err)
        cb(null)
      })
    } else {
      cb(null)
    }
  },
  function (cb) {
    fdlog('startup waterfall - set up part 2a - todo - this was added as a fix for dbx - to check if needed - to review todo')
    if (dsManager.freezrIsSetup) {
      dsManager.initOacDB(USER_DB_OAC, null, (err, userDb) => {
        if (err) felog('server.js', 'could not get USER_DB_OAC - error writing to db after test has passed - this should not happen!!! - (todo: can_read_write_to_db to false?)', err)
        cb(null)
      })
    } else {
      cb(null)
    }
  },

  function (cb) {
    fdlog('startup waterfall - set up part 3 - create user directories => freezrStatus.can_write_to_user_folder')
    const fsParamsToCheck = dsManager.initialEnvironment.envOnFile || dsManager.initialEnvironment
    environmentDefaults.checkFS(fsParamsToCheck, null, (err, fsWorks) => {
      if (!err && fsWorks) freezrStatus.can_write_to_user_folder = true
      if (dsManager.freezrIsSetup) {
        dsManager.getOrInitUserAppFS('fradmin', 'info.freezr.admin', {}, (err, userAppFS) => {
          if (err) felog('server.js', 'error writing to fs after test has passed - this should not happen!!! - (todo: can_write_to_user_folder to false?)', err)
          fradminAdminFs = userAppFS
          cb(null)
        })
      } else {
        cb(null)
      }
    })
  },

  function (cb) {
    fdlog('startup waterfall - set up part 4 - Read and write freezr secrets if doesnt exist - and run aop_uses')
    let cookieSecrets = null
    if (process && process.env && process.env.COOKIE_SECRET) { // override
      addAppUses(newFreezrSecrets({ session_cookie_secret: process.env.COOKIE_SECRET }))
      cb(null)
    } else if (!dsManager.freezrIsSetup) {
      addAppUses(newFreezrSecrets())
      cb(null)
    } else { // dsManager.freezrIsSetup
      fradminAdminFs.readUserFile('freezr_secrets.js', {}, function (err, secretsOnFile) {
        if (err) felog('server.js', 'Resetting secrets - got an err on requirefile for secrets ', err)
        if (!err && secretsOnFile && secretsOnFile.toString() !== 'null') {
          try {
            cookieSecrets = JSON.parse(secretsOnFile.toString())
          } catch (e) {
            console.warn(e)
          }
        }
        if (!secretsOnFile && freezrStatus.can_write_to_user_folder) { // write secrets
          const secrets = newFreezrSecrets()
          fradminAdminFs.writeToUserFiles('freezr_secrets.js', JSON.stringify(secrets), { doNotOverWrite: false }, function (err) {
            if (err) {
              helpers.warning('server.js', exports.version, 'startup_waterfall', 'Strange inconsistency writing files (freezr_secrets) onto server')
            }
            addAppUses(newFreezrSecrets(secrets))
            cb(null)
          })
        } else { // Adding app uses with cookiesecrets
          addAppUses(newFreezrSecrets(cookieSecrets))
          cb(null)
        }
      })
    }
  },

  function (cb) {
    fdlog('startup waterfall - set up part 5 - Get ip address for local network servers (currently not working - todo to review)')
    require('dns').lookup(require('os').hostname(), function (err, add, fam) {
      if (err) console.warn('err in dns lookup')
      // Priorities in choosing default address: 1. default ip from environmentDefaults (if written) 2. localhost if relevant 3. address looked up.
      dsManager.initialEnvironment.ipaddress = dsManager.initialEnvironment.ipaddress ? dsManager.initialEnvironment.ipaddress : add
      //  console.log('hostname currently not working - Once working: Would be running on local ip Address: ' + dsManager.initialEnvironment.ipaddress)
      cb(null)
    })
  },

  function (cb) {
    fdlog('startup waterfall - set up part 6 - Get freezr main preferences')
    if (dsManager.freezrIsSetup) {
      adminHandler.get_or_set_prefs(dsManager.getDB(PARAMS_OAC), 'main_prefs', DEFAULT_PREFS, false, function (err, mainPrefsOnDb) {
        freezrPrefs = mainPrefsOnDb
        cb(err)
      })
    } else {
      freezrPrefs = DEFAULT_PREFS
      cb(null)
    }
  },

  function (cb) {
    fdlog('startup waterfall - set up part 7 Load Admin DBs')
    if (dsManager.freezrIsSetup && freezrStatus.can_read_write_to_db) {
      const adminDBs = ['permissions', 'users', 'oauthors', 'app_tokens']
      const adminOACs = adminDBs.map(coll => {
        return {
          owner: 'fradmin',
          app_name: 'info.freezr.admin',
          collection_name: coll
        }
      })
      // adminOACs.push({
      //   owner: 'public',
      //   app_table: 'dev.ceps.privatefeeds.codes'
      // })
      dsManager.initAdminDBs(adminOACs, { addCache: true }, cb)
    } else {
      cb(null)
    }
  },

  function (cb) {
    // console.log('got oacs - !!!!', { ret })
    fdlog('startup waterfall - set up part 8 - todo - redo visit logger ')
    cb(null)
  },

  function (cb) {
    if (dsManager.freezrIsSetup) {
      dsManager.systemEnvironment = dsManager.initialEnvironment
      dsManager.setSystemUserDS('public', { dbParams: dsManager.users.fradmin.dbParams, fsParams: dsManager.users.fradmin.fsParams })
      console.log('Set up on Database   : ' + dsManager.initialEnvironment.dbParams.type)
      console.log('File System: ' + dsManager.initialEnvironment.fsParams.type)
      adminHandler.check_server_version_and_implement_updates(dsManager, VERSION, cb)
    } else {
      console.log('++++++++++++++ No initialEnvironment on db or file - FIRST REGISTRATION WILL BE TRIGGERED ++++++++++++++')
      fdlog('Initial Params   : ' + JSON.stringify(dsManager.initialEnvironment))
      cb(null)
    }
  }

], function (err) {
  freezrStatus.fundamentals_okay = canUseDbAndFs(freezrStatus)
  console.log('Startup checks complete.')
  console.log({ freezrStatus })
  // onsole.log({ freezrPrefs })
  if (err) console.log(' XXXXXXXXXXXXXXXXXXXXXXXXXXX Got err on start ups XXXXXXXXXXXXXXXXXXXXXXXXXXX ')
  if (err) helpers.warning('startup_waterfall', 'STARTUP ERR ' + JSON.stringify(err))

  // todo move to environment_defaults (short term fix in case of change in port (eg heroku)
  const theport = (process && process.env && process.env.PORT) ? process.env.PORT : dsManager.initialEnvironment.port
  app.listen(theport)

  console.log('Going to listen on port ' + theport)
  fdlog('initialEnvironment', dsManager.initialEnvironment)
})
