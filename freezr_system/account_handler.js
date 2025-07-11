// freezr.info - nodejs system files - account_handler

/* global User, Flags */

/* 2021 CEPS 2.0 notes
  - table_id? use instead of app_table  for consistency?
*/
exports.version = '0.0.200'

const helpers = require('./helpers.js')
const bcrypt = require('bcryptjs')
const async = require('async')
const json = require('comment-json')
const fileHandler = require('./file_handler.js')
const fs = require('fs')

const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args))

require('./flags_obj.js')

exports.generate_login_page = function (req, res) {
  // app.get('/login', publicUserPage, accountHandler.generate_login_page) .. no longer used
  // app.get('/account/login', publicUserPage, accountHandler.generate_login_page)
  fdlog('login_page ' + JSON.stringify(req.url))
  if (req.session && req.session.logged_in_user_id && req.url === '/account/login') { // last term relevant only if freezr preferences file has been deleted
    felog('redirect to home - already logged in')
    res.redirect('/account/home')
  } else {
    // fdlog todo - need to sanitize text
    const options = {
      page_title: (req.params.app_name ? 'Freezr App Login for ' + req.params.app_name : ' Login (Freezr)'),
      css_files: './@public/info.freezr.public/public/freezr_style.css',
      initial_query: null,
      server_name: req.protocol + '://' + req.get('host'),
      freezr_server_version: req.freezr_server_version,
      app_name: (req.params.app_name ? req.params.app_name : 'info.freezr.account'),
      other_variables:
        ' var freezrServerStatus = ' + JSON.stringify(req.freezrStatus) + ';' +
        ' freezrAllowSelfReg = ' + req.freezrSelfRegOptions.allow + ';'
    }

    if (!req.session) req.session = {}
    if (!req.session.device_code) {
      req.session.device_code = helpers.randomText(20)
      // todo use randomBytes(10).toString(‘base64')
      // todo - Record device code below async-ly and keep track of all attempts to access
    }
    options.app_name = 'info.freezr.public'
    options.page_url = 'public/account_' + ((req.params.app_name && req.params.app_name !== 'info.freezr.public') ? 'app' : '') + 'login.html'
    options.script_files = ['./@public/info.freezr.public/public/account_login.js']
    options.user_id = req.session.logged_in_user_id

    fileHandler.load_data_html_and_page(req, res, options)
  }
}
exports.generateSystemDataPage = function (req, res) {
  // app.get('/account/appdata/:target_app/:action', accountLoggedInUserPage, addUserAppsAndPermDBs, accountHandler.generateSystemDataPage)

  req.params.page = 'appdata_' + req.params.action // todo sanitize text
  req.params.other_variables = "const app_name ='" + req.params.target_app + "'"
  exports.generateAccountPage(req, res)
}
exports.generateAccountPage = function (req, res) {
  // app.get('/account/:page', accountLoggedInUserPage, addUserAppsAndPermDBs, accountHandler.generateAccountPage)
  // app.get('/account/:page/:target_app', accountLoggedInUserPage, addUserAppsAndPermDBs, accountHandler.generateAccountPage)
  // assumes user's logged in status has been validated and req.AppToken

  fdlog('NEWgenerateAccountPage accountPage: ' + req.url + ' target_app: ' + req.params.target_app + ' page: ' + req.params.page)
  if (!req.params.page) {
    req.params.page = 'home'
  } else {
    req.params.page = req.params.page.toLowerCase()
  }

  const options = accountPageManifest(req.params)
  if (options) {
    fdlog('have app ', { options })
    options.app_name = 'info.freezr.account'
    options.user_id = req.session.logged_in_user_id
    options.user_is_admin = req.session.logged_in_as_admin
    options.user_is_publisher = req.session.logged_in_as_publisher
    options.server_name = req.protocol + '://' + req.get('host')
    options.other_variables = options.other_variables || req.params.other_variables // only from generateSystemDataPage

    // onsole.log(options)
    if (!req.freezrTokenInfo || !req.freezrTokenInfo.app_token || !req.session.logged_in_user_id) {
      helpers.send_failure(res, helpers.error('invalid credentials'), 'account_handler', exports.version, 'login')
    } else if (!options.initial_query_func) {
      res.cookie('app_token_' + req.session.logged_in_user_id, req.freezrTokenInfo.app_token, { path: '/account' })
      fileHandler.load_data_html_and_page(req, res, options)
    } else { // initial_query_func
      res.cookie('app_token_' + req.session.logged_in_user_id, req.freezrTokenInfo.app_token, { path: '/account' })
      req.params.internal_query_token = req.freezrTokenInfo.app_token // internal query request

      if (req.params.page === 'perms' && req.query.requestor_app) req.params.target_app = req.query.requestor_app

      req.freezrInternalCallFwd = function (err, results) {
        if (err) {
          res.redirect('/admin/public/starterror')
        } else {
          options.queryresults = results
          fileHandler.load_data_html_and_page(req, res, options)
        }
      }
      options.initial_query_func(req, res)
    }
  } else {
    // onsole.log("SNBH - accountPagemanifest - Redirecting from generateAccountPage")
    res.redirect('/account/home')
  }
}

exports.ping = function (req, res) {
  // app.get('/ceps/ping', addVersionNumber, accountHandler.ping)
  // app.get('/feps/ping', addVersionNumber, accountHandler.ping)

  // todo - could also make this token based... so check token to see if logged_in to app and what capabilities the ceps server accepts

  fdlog('ping..' + JSON.stringify(req.query))
  if (!req.session.logged_in_user_id) {
    helpers.send_success(res, { logged_in: false, server_type: 'info.freezr', server_version: req.freezr_server_version })
  } else {
    helpers.send_success(res, { logged_in: true, logged_in_as_admin: req.session.logged_in_as_admin, user_id: req.session.logged_in_user_id, server_type: 'info.freezr', server_version: req.freezr_server_version, storageLimits: req.freezrStorageLimits  })
  }
}

// PASSWORD / USER MANAGEMENT
const EXPIRY_DEFAULT = 30 * 24 * 60 * 60 * 1000 // 30 days
exports.app_password_generate_one_time_pass = function (req, res) {
  // app.get('/v1/account/apppassword/generate', accountLoggedInAPI, addAppTokenDB, accountHandler.app_password_generate_one_time_pass)

  const userId = req.session.logged_in_user_id
  const appName = (req.query && req.query.app_name) ? req.query.app_name : null
  const expiry = (req.query && req.query.expiry) ? parseInt(req.query.expiry) : (new Date().getTime() + EXPIRY_DEFAULT)
  const oneDevice = !(req.query && req.query.one_device && req.query.one_device === 'false')
  fdlog('app_password_generate_one_time_pass  ' + JSON.stringify(req.query) + ' user: ' + userId + 'app:' + appName)

  if (!userId) {
    const err = helpers.auth_failure('account_handler.js', exports.version, 'app_password_generate_one_time_pass', 'Missing user id')
    helpers.send_failure(res, err, 'account_handler', exports.version, 'app_password_generate_one_time_pass')
  } else if (!appName) {
    const err = helpers.auth_failure('account_handler.js', exports.version, 'app_password_generate_one_time_pass', 'Missing app name')
    helpers.send_failure(res, err, 'account_handler', exports.version, 'app_password_generate_one_time_pass')
  } else {
    const write = {
      logged_in: false,
      source_device: req.session.device_code,
      owner_id: userId,
      requestor_id: userId,
      app_name: appName,
      app_password: helpers.generateOneTimeAppPassword(userId, appName, req.session.device_code),
      app_token: helpers.generateAppToken(userId, appName, req.session.device_code), // create token instead
      expiry,
      one_device: oneDevice,
      user_device: null,
      date_used: null // to be replaced by date
    }
    req.freezrAppTokenDB.create(null, write, null, (err, results) => {
      if (err) {
        helpers.send_failure(res, err, 'account_handler', exports.version, 'app_password_generate_one_time_pass')
      } else {
        helpers.send_success(res, { app_password: write.app_password, app_name: appName })
      }
    })
  }
}
exports.app_password_update_params = function (req, res) {
  // app.get('/v1/account/apppassword/updateparams', accountLoggedInAPI, addAppTokenDB, accountHandler.app_password_update_params)

  fdlog('app_password_update_params  ' + JSON.stringify(req.query))
  const userId = req.session.logged_in_user_id
  const appName = (req.query && req.query.app_name) ? req.query.app_name : null
  const expiry = (req.query && req.query.expiry) ? parseInt(req.query.expiry) : null
  const oneDevice = !(req.query && req.query.one_device && req.query.one_device === 'false')
  const params = { expiry, oneDevice }
  const password = (req.query && req.query.password) ? req.query.password : null

  // todo later - should also check if there are open ones and clean up expired ones

  if (!userId) {
    const err = helpers.auth_failure('account_handler.js', exports.version, 'app_password_update_params', 'Missing user id')
    helpers.send_failure(res, err, 'account_handler', exports.version, 'app_password_update_params')
  } else if (!appName) {
    const err = helpers.auth_failure('account_handler.js', exports.version, 'app_password_update_params', 'Missing app name')
    helpers.send_failure(res, err, 'account_handler', exports.version, 'app_password_update_params')
  } else if (!password) {
    const err = helpers.auth_failure('account_handler.js', exports.version, 'app_password_update_params', 'Missing app password')
    helpers.send_failure(res, err, 'account_handler', exports.version, 'app_password_update_params')
  } else if (!req.query.expiry && !req.query.one_device && !(req.query.one_device === false)) {
    const err = helpers.auth_failure('account_handler.js', exports.version, 'app_password_update_params', 'failure on device expiry?')
    helpers.send_failure(res, err, 'account_handler', exports.version, 'app_password_update_params')
  } else {
    req.freezrAppTokenDB.query({ app_password: password }, null,
      (err, results) => {
        if (err) {
          helpers.send_failure(res, err, 'account_handler', exports.version, 'app_password_update_params')
        } else if (!results || results.length === 0) {
          err = helpers.error('no_results', 'expected record but found none (app_password_update_params)')
          helpers.send_failure(res, err, 'account_handler', exports.version, 'app_password_update_params')
        } else {
          const record = results[0] // todo - theoretically there could be multiple and the right one need to be found
          if (record.requestor_id !== userId || record.owner_id !== userId || record.app_name !== appName) {
            err = helpers.error('no_results', 'app_name or user_id do not match expected value(app_password_update_params)')
            helpers.send_failure(res, err, 'account_handler', exports.version, 'app_password_update_params')
          } else if (helpers.expiry_date_passed(record.expiry)) {
            err = helpers.error('password_expired', 'One time password has expired.')
            helpers.send_failure(res, err, 'account_handler', exports.version, 'app_password_update_params')
          } else if (record.date_used) {
            err = helpers.error('password_used', 'Cannot change parameters after password has been used')
            helpers.send_failure(res, err, 'account_handler', exports.version, 'app_password_update_params')
          } else {
            const changes = {}
            if (expiry) changes.expiry = expiry
            if (oneDevice || oneDevice === false) changes.one_device = params.oneDevice
            req.freezrAppTokenDB.update((record._id + ''), changes, { replaceAllFields: false }, function (err, results) {
              if (err) {
                helpers.send_failure(res, err, 'account_handler', exports.version, 'app_password_update_params')
              } else {
                helpers.send_success(res, { success: true })
              }
            })
          }
        }
      })
  }
}
exports.changePassword = function (req, res) {
  // app.put('/v1/account/changePassword.json', accountLoggedInAPI, addAllUsersDb, accountHandler.changePassword)
  // req.freezrUserDS
  // onsole.log("Changing password  "+JSON.stringify(req.body));

  const userId = req.body.user_id
  let u = null
  async.waterfall([
    // 1. basic checks
    function (cb) {
      if (!userId) {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'changePassword', 'Missing user id'))
      } else if (!req.session.logged_in_user_id || userId !== req.session.logged_in_user_id) {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'changePassword', 'user not logged in'))
      } else if (!req.body.oldPassword) {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'changePassword', 'Missing old password'))
      } else if (!req.body.newPassword) {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'changePassword', 'Missing new password'))
      } else {
        cb(null)
      }
    },

    // 2. get user
    function (cb) {
      req.allUsersDb.query({ user_id: userId }, null, cb)
    },

    // 3. check the password
    function (results, cb) {
      require('./user_obj.js')
      u = new User(results[0])
      if (!results || results.length === 0) {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'changePassword', 'funky error'))
      } else if (results.length > 1) {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'changePassword', 'getting too many users'))
      } else if (u.check_passwordSync(req.body.oldPassword)) {
        bcrypt.hash(req.body.newPassword, 10, cb)
      } else {
        fdlog('need to limit number of wring passwords - set a file in the datastore ;) ')
        cb(helpers.auth_failure('account_handler.js', exports.version, 'changePassword', 'Wrong password'))
      }
    },

    // 3. change pw for the user.
    function (hash, cb) {
      req.allUsersDb.update(
        { user_id: userId },
        { password: hash },
        { replaceAllFields: false },
        cb)
    }

  ],
  function (err, returns) {
    if (err) {
      helpers.send_failure(res, err, 'account_handler', exports.version, 'changePassword')
    } else if (!returns || !returns.nModified || returns.nModified === 0) {
      helpers.send_failure(res, helpers.error('change error - was not able to change any passwords: ' + JSON.stringify(returns)), 'account_handler', exports.version, 'changePassword')
    } else {
      if (returns.nModified !== 1) felog('changePassword', 'error in changing user records - to investigate why more than 1 modified ', returns)
      helpers.send_success(res, { user: u.response_obj() })
    }
  })
}

exports.accountActions = function (req, res) {
  if (req.params.action === 'setPrefs.json' || req.params.action === 'setPrefs') {
    accountActionSetPrefs(req, res)
  } else if (req.params.action === 'setServicesParams' || req.params.action === 'setServicesItem') {
    accountActionSetServicesParams(req, res)
  } else {
    helpers.send_failure(res, new Error('invalid account action page'), 'account_handler', exports.version, req.params.action)
  }
  // accountHandler.setPrefs setPrefs.json
}

const accountActionSetPrefs = function (req, res) {
  // app.put('/v1/account/data/setPrefs.json', accountLoggedInAPI, addAllUsersDb, accountHandler.setPrefs)
  // todo later -> merge this endpoint with changePassword and others

  fdlog('setprefs, ', req.body)

  const userId = req.session.logged_in_user_id
  const userPrefs = {}
  let u = null
  async.waterfall([
    // 1. basic checks
    function (cb) {
      if (!userId) {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'setPrefs', 'user not logged in'))
      } else {
        cb(null)
      }
    },

    // 2. get user
    function (cb) {
      req.allUsersDb.query({ user_id: userId }, null, cb)
    },

    // 3. check the password
    function (results, cb) {
      require('./user_obj.js')
      u = new User(results[0])
      if (!results || results.length === 0) {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'setPrefs', 'funky error'))
      } else if (results.length > 1) {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'setPrefs', 'getting too many users'))
      } else {
        cb(null)
      }
    },

    // 3. change prefs for the user.
    function (cb) {
      userPrefs.blockMsgsToNonContacts = Boolean(req.body.blockMsgsToNonContacts)
      userPrefs.blockMsgsFromNonContacts = Boolean(req.body.blockMsgsFromNonContacts)
      req.allUsersDb.update(
        { user_id: userId },
        { userPrefs },
        { replaceAllFields: false },
        cb)
    }

  ],
  function (err, returns) {
    fdlog('userPrefs ', { err, returns })
    if (err) {
      helpers.send_failure(res, err, 'account_handler', exports.version, 'setPrefs')
    } else if (!returns || !returns.nModified || returns.nModified === 0) {
      helpers.send_failure(res, helpers.error('change error - was not able to change setPrefs: ' + JSON.stringify(returns)), 'account_handler', exports.version, 'setPrefs')
    } else {
      req.freezrUserDS.userPrefs = userPrefs
      if (returns.nModified !== 1) felog('setPrefs', 'error in changing user records - to investigate why more than 1 modified ', returns)
      helpers.send_success(res, { user: u.response_obj() })
    }
  })
}
const accountActionSetServicesParams = function (req, res) {
  // app.put('/v1/account/data/setServices', accountLoggedInAPI, addAllUsersDb, accountHandler.setPrefs)
  // app.put('/v1/account/data/setServicesItem', accountLoggedInAPI, addAllUsersDb, accountHandler.setPrefs)
  // todo later -> merge this endpoint with changePassword and others
  // nb -> not sure setServicesItem is a good idea - perhjaps just change to update role

  fdlog('accountActionSetServicesParams, body ', req.body)

  let slParams = { // used for setServicesParams - reset below for setServicesItem
    type: req.body.type,
    region: req.body.region,
    accessKeyId: req.body.accessKeyId,
    secretAccessKey: req.body.secretAccessKey,
    arnRole: req.body.arnRole
  }

  const userId = req.session.logged_in_user_id
  const userPrefs = {}
  let u = null
  async.waterfall([
    // 1. basic checks
    function (cb) {
      if (!userId) {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'accountActionSetServicesParams', 'user not logged in'))
      } else if (req.params.action === 'setServicesParams' && (!slParams.type || !slParams.region || !slParams.accessKeyId || !slParams.secretAccessKey)) {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'accountActionSetServicesParams', 'need all params to update'))
      } else if (req.params.action === 'setServicesItem' && (!slParams.type || (!slParams.region && !slParams.accessKeyId || !slParams.secretAccessKey))) {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'accountActionSetServicesParams', 'need all params to update'))
      } else {
        cb(null)
      }
    },

    async () => {
      const microservices = require('./microservices.js')
      if (req.params.action === 'setServicesParams' && slParams.type === 'aws' && !slParams.arnRole) {
        const role = await microservices.createAwsRole(slParams)
        if (role.error || !role.Arn) {
          console.warn('error setting role ', role)
          console.warn('error setting role - code is ', role?.error?.Error?.Code)
          return [helpers.error(role?.error?.Error?.Code || 'error creating role'), null]
        } else {
          slParams.arnRole = role.Arn
          return [null, null]
        }
      } else {
        // todo need to check valifity of credentials even if role is not added
        return [null, null]
      }
    },
    ([err, val], cb) => {
      if (err) {
        cb(err)
      } else {
        cb(null)
      }
    },

    // 3. get user
    function (cb) {
      req.allUsersDb.query({ user_id: userId }, null, cb)
    },

    // 4. check the password
    function (results, cb) {
      require('./user_obj.js')
      u = new User(results[0])
      if (req.params.action === 'setServicesItem') {
        // todo -> nb thisd should really only be used for arnRole. perhaps restrict when add other types
        slParams = results[0].slParams
        if (req.body.type) slParams.type = req.body.type
        if (req.body.region) slParams.region = req.body.region
        if (req.body.accessKeyId) slParams.accessKeyId = req.body.accessKeyId
        if (req.body.secretAccessKey) slParams.secretAccessKey = req.body.secretAccessKey
        if (req.body.arnRole) slParams.arnRole = req.body.arnRole
      }
      if (!results || results.length === 0) {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'accountActionSetServicesParams', 'funky error'))
      } else if (results.length > 1) {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'accountActionSetServicesParams', 'getting too many users'))
      } else {
        cb(null)
      }
    },

    // 5. change prefs for the user.
    function (cb) {
      req.allUsersDb.update(
        { user_id: userId },
        { slParams },
        { replaceAllFields: false },
        cb)
    }

  ],
  function (err, returns) {
    fdlog('accountActionSetServicesParams', { err, returns })
    if (err) {
      helpers.send_failure(res, err, 'account_handler', exports.version, 'accountActionSetServicesParams')
    } else if (!returns || !returns.nModified || returns.nModified === 0) {
      helpers.send_failure(res, helpers.error('change error - was not able to change accountActionSetServicesParams: ' + JSON.stringify(returns)), 'account_handler', exports.version, 'accountActionSetServicesParams')
    } else {
      req.freezrUserDS.userPrefs = userPrefs
      if (returns.nModified !== 1) felog('accountActionSetServicesParams', 'error in changing user records - to investigate why more than 1 modified ', returns)
      helpers.send_success(res, { user: u.response_obj() })
    }
  })
}
exports.removeFromFreezr = function (req, res) {
  // app.put('/v1/account/changePassword.json', accountLoggedInAPI, addAllUsersDb, accountHandler.changePassword)
  // req.freezrUserDS
  // onsole.log("Changing password  "+JSON.stringify(req.body));

  const userId = req.body.user_id
  let u = null
  async.waterfall([
    // 1. basic checks
    function (cb) {
      if (!userId) {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'removeFromFreezr', 'Missing user id'))
      } else if (!req.session.logged_in_user_id || userId !== req.session.logged_in_user_id) {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'removeFromFreezr', 'user not logged in'))
      } else if (!req.body.oldPassword) {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'removeFromFreezr', 'Missing old password'))
      } else if (req.session.logged_in_as_admin) {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'removeFromFreezr', 'Cannot remove admins'))
      } else {
        cb(null)
      }
    },

    // 2. get user
    function (cb) {
      req.allUsersDb.query({ user_id: userId }, null, cb)
    },

    // 3. check the password
    function (results, cb) {
      require('./user_obj.js')
      u = new User(results[0])
      if (!results || results.length === 0) {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'removeFromFreezr', 'funky error'))
      } else if (results.length > 1) {
        cb(helpers.auth_failure('account_handler.js', exports.version, 'removeFromFreezr', 'getting too many users'))
      } else if (u.check_passwordSync(req.body.oldPassword)) {
        cb(null)
      } else {
        fdlog('need to limit number of wrong passwords - set a file in the datastore ;) ')
        cb(helpers.auth_failure('account_handler.js', exports.version, 'removeFromFreezr', 'Wrong password'))
      }
    },

    // 3. remove the user
    function (cb) {
      if (!req.session.logged_in_as_admin && (['fdsFairOs', 'dropbox', 'googleDrive'].indexOf(req.freezrUserDS.fsParams.type) > -1)) {
        req.allUsersDb.delete_record(userId, null, cb)
      } else {
        cb(new Error('A user cannot delete itdslef if it is admin or is using system resources.'))
      }
    },

    // remove public posts
    function (returns, cb) {
      req.freezrPublicRecordsDB.query({ data_owner: req.session.logged_in_user_id }, {}, cb)
    },
    function (publicRecords, cb) {
      if (!publicRecords || publicRecords.length === 0) {
        cb(null)
      } else {
        async.forEach(publicRecords, function (rec, cb2) {
          req.freezrPublicRecordsDB.delete_record(rec._id, null, cb2)
        }, cb)
      }
    }
  ],
    function (err) {
      if (err) {
        helpers.send_failure(res, err, 'account_handler', exports.version, 'removeFromFreezr')
      } else {
        helpers.send_success(res, { success: true })
      }
    })
}

// Data retreival
const listAllUserApps = function (req, res) {
  // from get_account_data => app.get('/v1/account/data/:action', accountLoggedInAPI, accountHandler.get_account_data) // app_list.json, app_resource_use.json

  fdlog('account_handler listAllUserApps')

  const userId = req.session.logged_in_user_id
  const userDS = req.freezrUserDS
  const oac = {
    owner: userId,
    app_name: 'info.freezr.account',
    collection_name: 'app_list'
  }

  const removedApps = []
  const userApps = []

  async.waterfall([
    // 1. get db
    function (cb) {
      userDS.getorInitDb(oac, { freezrPrefs: req.freezrPrefs }, cb)
    },

    // 2. get all user apps
    function (appList, cb) {
      if (!appList || !appList.query) {
        felog('bad retrieval of db ', { appList })
        cb(new Error('inccomplete or authentication malfucntion getting db for ' + userId))
      } else {
        appList.query({}, null, cb)
      }
    },

    function (results, cb) {
      if (results && results.length > 0) {
        results = results.map(app => {
          return {
            app_name: app.app_name,
            removed: app.removed,
            served_url: app.served_url,
            _date_modified: app._date_modified,
            _id: app._id,
            app_display_name:
              app.app_display_name,
            offThreadWip: ((app.offThreadStatus && app.offThreadStatus.offThreadWip) ? app.offThreadStatus.offThreadWip : false),
            offThreadParams: ((app.offThreadStatus && app.offThreadStatus.offThreadParams) ? app.offThreadStatus.offThreadParams : null)
          }
        })
        for (let i = 0; i < results.length; i++) {
          if (results[i].app_name && results[i].app_name === results[i].app_display_name) { results[i].app_display_name = results[i].app_display_name.replace(/\./g, '. ') }
          const appOwnerAndNameForLogo = function (url) {
            if (!url) return null
            const parts = url.split('/')
            const idx = parts.indexOf('oapp')
            if (idx < 0 || parts.length < idx + 3) return null
            return parts[idx + 1] + '/' + parts[idx + 2]
          }
          results[i].logo = '/app_files/' + (appOwnerAndNameForLogo(results[i].served_url) || results[i].app_name) + '/static/logo.png'
          if (results[i].removed) {
            removedApps.push(results[i])
          } else {
            userApps.push(results[i])
          }
        }
      }
      cb(null)
    }
  ],
  function (err) {
    if (err) {
      felog('listAllUserApps', 'ERROR in listAllUserApps ', err)
      if (req.freezrInternalCallFwd) {
        req.freezrInternalCallFwd(err, null)
      } else {
        helpers.send_failure(res, err, 'account_handler', exports.version, 'listAllUserApps')
      }
    } else {
      // onsole.log(" results",{ removedApps, userApps })
      if (req.freezrInternalCallFwd) {
        req.freezrInternalCallFwd(null, { removed_apps: removedApps, user_apps: userApps })
      } else {
        helpers.send_success(res, { removed_apps: removedApps, user_apps: userApps })
      }
    }
  })
}
const getAppResources = function (app, req, res) {
  // from get_account_data => app.get('/v1/account/data/:action', accountLoggedInAPI, accountHandler.get_account_data) // app_list.json, app_resource_use.json

  fdlog('account_handler getAppResources')
  const userDS = req.freezrUserDS

  userDS.getStorageUse(null, { freezrPrefs: req.freezrPrefs }, function (err, sizeJson) {
    if (req.freezrInternalCallFwd) {
      req.freezrInternalCallFwd(err, sizeJson)
    } else if (err) {
      helpers.send_failure(res, err, 'account_handler', exports.version, 'getAppResources')
    } else {
      helpers.send_success(res, sizeJson)
    }
  })
}
exports.get_account_data = function (req, res) {
  // app.get('/v1/account/data/:action', accountLoggedInAPI, accountHandler.get_account_data) // app_list.json, app_resource_use.json
  switch (req.params.action) {
    case 'app_list.json':
      listAllUserApps(req, res)
      break
    case 'app_resource_use.json':
      getAppResources(req.query?.app_name, req, res)
      break
    case 'user_prefs.json':
      helpers.send_success(res, req.freezrUserDS.userPrefs)
      break
    default:
      helpers.send_failure(res, new Error('invalid page'), 'account_handler', exports.version, req.params.action)
      break
  }
}

// App Installation and Updating
exports.get_file_from_url_to_install_app = function (req, res) {
  // app.post('/v1/account/app_install_from_url.json', accountLoggedInUserPage, addUserAppsAndPermDBs, accountHandler.get_file_from_url_to_install_app)
  // onsole.log("get_file_from_url_to_install_app",req.body)
  // todo 2020-07 this needs to be redone so that it saves to a temp file and then [??]

  const download = (fileUrl, outputPath, cb) => {
    fetch(fileUrl)
      .then(response => {
        if (!response.ok) {
          throw new Error(`Failed to fetch ${response.statusText}`)
        }
        const fileStream = fs.createWriteStream(outputPath)
        response.body.pipe(fileStream)
        response.body.on('error', (err) => {
          console.error('Download failed:', err)
          throw new Error(`Failed to fownload file`)
        })
        fileStream.on('finish', () => {
          // onsole.log('File downloaded successfully.')
          return cb(null)
        })
      })
      .catch(err => {
        return cb(err)
      })
  }
  
  const tempAppName = req.body.app_name
  const tempFolderPath = (req.freezrUserDS.fsParams.rootFolder || helpers.FREEZR_USER_FILES_DIR) + '/' + req.session.logged_in_user_id + '/tempapps/' + tempAppName

  fileHandler.mkdirp(tempFolderPath, function (err) {
    if (err) {
      helpers.send_success(res, { success: false, err, flags: null, text: '' })
    } else {
      const zipFilePath = tempFolderPath + '/' + tempAppName + '.zip'
      download(req.body.app_url, zipFilePath, function (err) {
        if (err) felog('err', err)
        if (!err && req.body.app_name) {
          req.app_name = req.body.app_name
          req.file = {}
          req.file.originalname = req.body.app_name + '.zip'
          fs.readFile(fileHandler.fullLocalPathTo(zipFilePath), null, function (err, content) {
            if (err) {
              felog('account_handler get_file_from_url_to_install_app ', err)
              helpers.send_success(res, { success: false, err, flags: null, text: '' })
            } else {
              req.file.buffer = content
              req.installsource = 'get_file_from_url_to_install_app'
              exports.install_app(req, res)
            }
          })

          // req.file.buffer = zipFilePath
          // req.installsource = 'get_file_from_url_to_install_app'
          // exports.install_app(req, res)
          // fdlog? todonow  delete tempfile... determine name ... put file under user / files
        } else { // err or missing app name
          const flags = new Flags({})
          flags.meta.app_name = req.body.app_name
          if (!err) err = { code: 'Missing App name', message: 'app name is required to create an app.' }
          if (!err.code) err.code = 'err_unknown'
          if (!err.message) err.message = 'Could not connect to the requested URL'
          flags.add('errors', err.code, { function: 'install_app', text: err.message })

          helpers.send_success(res, { success: false, err, flags: null, text: '' })
        }
      })
    }
  })
}
const appIdFrom = function (userId, appName) {
  return userId + '_' + appName
}
exports.install_blank_app = function (req, res) {
  // app.post('/v1/account/app_install_blank', accountLoggedInUserPage, addUserAppsAndPermDBs, accountHandler.install_blank_app)

  // from access_handler and perm_handler
  fdlog('install_blank_app ')
  const appName = req.body.app_name
  const servedUrl = req.body.served_url
  const appDisplayName = req.body.app_display_name

  const manifest = {
    identifier: appName,
    served_url: servedUrl,
    display_name: appDisplayName || appName,
    version: 0
  }
  const validUrl = function (appUrl) {
    if (!appUrl) return false
    if (appUrl.length < 1) return false
    if (!helpers.starts_with_one_of(servedUrl, ['/', 'https://', 'http://'])) return false
    if (appUrl.indexOf('/oapp/') < -1) return false
    return true
  }
  const appNameId = appIdFrom(req.session.logged_in_user_id, appName)
  const flags = new Flags({ app_name: appName, didwhat: 'installed' })

  async.waterfall([
    // 1. make sure data and file names exist and appName is valid
    function (cb) {
      if (!req.session.logged_in_user_id) {
        cb(helpers.missing_data('user_id'))
      } else if (!appName || appName.length < 1) {
        cb(helpers.invalid_data('app name missing - that is the name of the app zip file name before any spaces.', 'account_handler', exports.version, 'install_blank_app'))
      } else if (helpers.is_system_app(appName) || !helpers.valid_appName(appName)) {
        cb(helpers.invalid_data('app name not allowed: ' + appName, 'account_handler', exports.version, 'install_blank_app'))
      } else if (servedUrl && !validUrl(servedUrl)) {
        cb(helpers.invalid_data('url invalid: ' + servedUrl, 'account_handler', exports.version, 'install_blank_app'))
      } else {
        req.freezrUserAppListDB.read_by_id(appNameId, cb)
      }
    },

    // see if entity exists
    function (existingEntity, cb) {
      if (existingEntity) {
        cb(helpers.invalid_data('app already exists ' + appName, 'account_handler', exports.version, 'install_blank_app'))
      } else {
        // console.log('todo - update permissions?')
        createOrUpdateUserAppList(req.freezrUserAppListDB, appNameId, manifest, null, cb)
      }
    },
    // get appfs to delete local app files for cloud storage
    function (info, cb) {
      req.freezrUserDS.getorInitAppFS(appName, {}, cb)
    },
    // delete previous version of cache (or real folder if local)
    function (appFS, cb) {
      if (appFS.fsParams.type === 'local' || appFS.fsParams.type === 'glitch') {
        cb(null) // local files are the main files - dont delete
      } else {
        appFS.cache.appfiles = {}
        const realAppPath = (appFS.fsParams.rootFolder || helpers.FREEZR_USER_FILES_DIR) + '/' + req.session.logged_in_user_id + '/apps/' + appName
        fileHandler.deleteLocalFolderAndContents(realAppPath, cb)
      }
    }
  ],
  function (err) {
    if (err) {
      console.warn('install_blank_app', { user: req.session.logged_in_user_id, err })
      if (!err.code) err.code = 'err_unknown'
      flags.add('errors', err.code, { function: 'install_blank_app', text: err.message })
    }
    helpers.send_success(res, { err, flags: flags.sentencify() })
  })
}
exports.install_app = function (req, res) {
  // installAppFromZipFile =>    app.put('/v1/account/app_install_from_zipfile.json', accountLoggedInUserPage, addUserAppsAndPermDBs, installAppFromZipFile)
  // onsole.log("install_app file.originalname ",req.file.originalname,"app_name ",req.app_name)

  fdlog('install_app ' + req.file.name + (req.installsource || ''))

  // from access_handler and perm_handler
  const userDS = req.freezrUserDS
  let appFS // ds generated from userAppFs

  const tempAppName = tempAppNameFromFileName(req.file.originalname)
  const tempFolderPath = (userDS.fsParams.rootFolder || helpers.FREEZR_USER_FILES_DIR) + '/' + req.session.logged_in_user_id + '/tempapps/' + tempAppName

  let manifest = null
  let realAppName
  let realAppPath
  let flags = new Flags({})

  async.waterfall([
    // 1. make sure data and file names exist and tempAppName is correct
    function (cb) {
      if (!req.session.logged_in_user_id) {
        cb(helpers.missing_data('user_id'))
      } else if (!req.file) {
        cb(helpers.missing_data('file', 'account_handler', exports.version, 'install_app'))
      } else if (!req.file.originalname) {
        cb(helpers.missing_data('file name', 'account_handler', exports.version, 'install_app'))
      } else if (req.file.originalname.length < 5 || req.file.originalname.substr(-4) !== '.zip') {
        cb(helpers.invalid_data('file name not zip: ' + req.file.originalname, 'account_handler', exports.version, 'install_app'))
      } else {
        cb(null)
      }
    },

    // REMOVE THE LOCAL temp DIRECTORY and extract zip files to it to read the manifest
    function (cb) {
      fileHandler.deleteLocalFolderAndContents(tempFolderPath, cb)
    },
    function (cb) {
      // if (req.installsource === 'get_file_from_url_to_install_app') {
      //  cb(null)
      // } else {
      fileHandler.extractZipToLocalFolder(req.file.buffer, tempFolderPath, tempAppName, cb)
      // }
    },

    // get the manifest file and the real name and check it
    function (cb) {
      fileHandler.getLocalManifest(tempFolderPath, cb)
    },
    function (manifestFromFile, cb) {
      fdlog('gort manifest ', { manifestFromFile })
      manifest = manifestFromFile
      realAppName = (manifest && manifest.identifier) ? manifest.identifier : tempAppName
      flags = new Flags({ app_name: realAppName, didwhat: 'installed' })
      if (realAppName !== tempAppName) flags.add('notes', 'app_name_different')

      if (!realAppName || realAppName.length < 1) {
        fileHandler.deleteLocalFolderAndContents(tempFolderPath, function (err) {
          if (err) felog('install_app', 'error deleting local folder after app name missing ')
          cb(helpers.invalid_data('app name missing - that is the name of the app zip file name before any spaces.', 'account_handler', exports.version, 'install_app'))
        })
      } else if (helpers.is_system_app(realAppName) || !helpers.valid_appName(realAppName)) {
        fileHandler.deleteLocalFolderAndContents(tempFolderPath, function (err) {
          if (err) felog('install_app', 'error deleting local folder 2 after app name not allowed ')
          cb(helpers.invalid_data('app name not allowed: ' + tempAppName, 'account_handler', exports.version, 'install_app'))
        })
      } else {
        cb(null)
      }
    },
    // get appfs to eextract app files
    function (cb) {
      userDS.getorInitAppFS(realAppName, {}, cb)
    },
    // delete previous version of cache (or real folder if local)
    function (userAppFS, cb) {
      appFS = userAppFS
      // todo fdlog - add glitch prefix to folder
      realAppPath = (appFS.fsParams.rootFolder || helpers.FREEZR_USER_FILES_DIR) + '/' + req.session.logged_in_user_id + '/apps/' + realAppName
      appFS.cache.appfiles = {}
      fileHandler.deleteLocalFolderAndContents(realAppPath, cb)
    },
    // extract to local folder
    function (cb) {
      fileHandler.extractZipToLocalFolder(req.file.buffer, realAppPath, tempAppName, cb)
    },
    // extract to actual location (except when it is a local system - ie it already exists)
    function (cb) {
      if (appFS.fsParams.type === 'local' || appFS.fsParams.type === 'glitch') {
        cb(null) // already copied to local above
      } else if (req.installsource === 'get_file_from_url_to_install_app' && ['dropbox', 'googleDrive', 'fdsFairOs'].includes(appFS.fsParams.type)) {
        // console.log todo - fds dropbox and google drive should have an offline isntall parameter that should be used instead of the includes above
        offThreadExtraction({
          file: req.file.buffer,
          name: req.file.originalname,
          userId: req.session.logged_in_user_id,
          appFS,
          freezrUserAppListDB: req.freezrUserAppListDB,
          fileUrl: req.body.app_url,
          versionDate: new Date().getTime(),
          init: true
        }, cb)
      } else {
        fileHandler.extractZipAndReplaceToCloudFolder(req.file.buffer, req.file.originalname, appFS, cb)
      }
    },
    function (cb) { // remove the temprary file
      fileHandler.deleteLocalFolderAndContents(tempFolderPath, cb)
    },

    // 5. check manifest (populate app_version and app_display_name and permissons)
    function (cb) {
      if (!manifest) flags.add('notes', 'manifest_missing')
      if (!manifest) manifest = {}
      if (!manifest.identifier) manifest.identifier = realAppName
      if (!manifest.display_name) manifest.display_name = realAppName
      if (!manifest.version) manifest.version = 0

      flags = fileHandler.checkManifest(manifest, realAppName, manifest.version, flags)

      updatePermissionRecordsFromManifest(req.freezrUserPermsDB, realAppName, manifest, cb)
    },

    // 6. Update the app list
    function (cb) {
      const customEnv = null // todo to be added later
      const appNameId = appIdFrom(req.session.logged_in_user_id, realAppName)
      createOrUpdateUserAppList(req.freezrUserAppListDB, appNameId, manifest, customEnv, cb)
    },

    // 7. If app already exists, flag it as an update
    function (info, cb) {
      if (info.isUpdate) {
        flags.add('notes', 'app_updated_msg')
        flags.meta.didwhat = 'updated'
      } else {
        flags.meta.didwhat = 'uploaded'
      }
      cb(null)
    },

    // 8. if update has a microservices perm then update 
    async () => {
      const manifestPerms = (manifest && manifest.permissions && Object.keys(manifest.permissions).length > 0) ? JSON.parse(JSON.stringify(manifest.permissions)) : null
      if (manifestPerms && manifestPerms.length > 0 && manifestPerms.filter(perm => perm.type === 'use_microservice').length > 0) {
        const microservices = require('./microservices.js')
        const installed = await microservices.upsertServerlessFuncsOnInstall(req, realAppName, manifestPerms, realAppPath)
        if (installed.error) {
          console.log('Todo - temp - need to send warning back that microservices were not installed .. error installing serverless -> installed setting perms ', installed)
          return [null, null]
          // return [helpers.error(installed.error || 'error creating microservices perm'), null]
        } else {
          return [null, null]
        }
      } else {
        return [null, null]
      }
    },
    ([err, val], cb) => {
      if (err) {
        cb(err)
      } else {
        cb(null)
      }
    }

    // todo later (may be) - also check manifest permissions (as per changeNamedPermissions) to warn of any issues
  ],
  function (error, dummy) {
    // todo: if there is an error in a new manifest the previous one gets wied out but the ap still runs (as it was instaled before successfully), so it should be marked with an error.
    // todo: also better to wipe out old files so old files dont linger if they dont exist in new version
    flags.meta.app_name = realAppName
    if (error) {
      flags.add('errors', error.code, { function: 'install_app', text: error.message })
    }
    // onsole.log(flags.sentencify())
    helpers.send_success(res, { error: (error?.message), flags: flags.sentencify() })

    // preload databases
    if (!manifest) {
      felog('No manifest for ' + realAppName + '- creating one - SNBH')
      manifest = { app_tables: {} }
      manifest.app_tables[realAppName] = {}
    }
    if (!error && manifest.app_tables && Object.keys(manifest.app_tables).length > 0 && manifest.app_tables.constructor === Object) {
      for (const appTable in manifest.app_tables) {
        const oac = {
          owner: req.session.logged_in_user_id,
          app_name: realAppName,
          app_table: appTable
        }
        req.freezrUserDS.getorInitDb(oac, { freezrPrefs: req.freezrPrefs }, function (err, aDb) {
          if (err) {
            felog('install_app - err in initiating installed app db ', err)
          } else if (!aDb || !aDb.query) {
            felog('install_app - err in initiating installed app db - no db present')
          } else {
            aDb.query(null, { count: 1 }, function (err, results) {
              if (err) felog('install_app - err in querying installed app db ', err)
              fdlog('db fake query for init - query results ', results)
            })
          }
        })
      }
    } else {
      fdlog('no pre-loading')
    }
  })
}
const tempAppNameFromFileName = function (originalname) {
  let name = ''
  const parts = originalname.split('.')
  if (helpers.endsWith(parts[(parts.length - 2)], '-main')) parts[(parts.length - 2)] = parts[(parts.length - 2)].slice(0, -7)
  parts.splice(parts.length - 1, 1)
  name = parts.join('.')
  name = name.split(' ')[0]
  return name
}
const TRY_THRESHOLD = 5
const offThreadExtraction = function (params, callback) {
  fdlog('offThreadExtraction ', { params })
  /* file: req.file.buffer,
      name: req.file.originalname,
      appFS,
      userId: req.params.logged_in_user_id,      
      freezrUserAppListDB: req.freezrUserAppListDB,
      fileUrl: req.body.app_url,
      versionDate: new Date().getTime(),
      init: true
      // appRecord: [record from freezrUserAppListDB]
      // params.filesRemaining = fileList
  */
  // Note params and appRecord both retain fileList for redundancy on error count
  // and also to allow this to be added as a scheduled task, where params variable is lost
  // and the appRecord alone is relied on

  const appNameId = appIdFrom(params.userId, params.appFS.appName)

  if (!params?.userId || !params?.appFS?.appName) {
    felog('offThreadExtraction - missing params ', { params })
    callback(new Error('missing params'))
  } else if (params.init) {
    const [err, fileList] = fileHandler.appFileListFromZip(params.file)
    if (err) {
      felog('offThreadExtraction err in appFileListFromZip', { params, err })
      callback(err)
    } else {
      // flag the freezrUserAppListDB as being WIP and
      const offThreadStatus = {
        installFileUrl: params.fileUrl,
        offThreadParams: {
          tryNum: 1,
          versionDate: params.versionDate,
          filesRemaining: fileList
        },
        offThreadWip: true
      }
      params.freezrUserAppListDB.read_by_id(appNameId, function (err, record) {
        if (err) {
          felog('offThreadExtraction err in read_by_id', { params, err })
          callback(err)
        } else if (!record) {
          params.freezrUserAppListDB.create(appNameId, { app_name: params.appFS.appName, app_display_name: params.appFS.appName, manifest: null, removed: false, offThreadStatus }, null, function (err) {
            if (err) {
              callback(err)
            } else {
              params.init = false
              params.tryNum = 1
              params.filesRemaining = fileList
              setTimeout(function () {
                offThreadExtraction(params)
              }, 10000)
              callback()
            }
          })
        } else {
          params.freezrUserAppListDB.update(appNameId, { offThreadStatus }, { replaceAllFields: false }, function (err, result) {
            if (err) {
              felog('offThreadExtraction err in freezrUserAppListDB', { params, err })
              callback(err)
            } else {
              params.init = false
              params.tryNum = 1
              params.filesRemaining = fileList
              setTimeout(function () {
                fileHandler.removeCloudAppFolder(params.appFS, function (err) {
                  if (err) felog('offThreadExtraction err in removeCloudAppFolder - (Will try installing in any case) ', err)
                  offThreadExtraction(params)
                })
              }, 2000)
              callback()
            }
          })
        }
      })
    }
  } else if (params.tryNum > TRY_THRESHOLD) {
    // donnothing
    felog('offThreadExtraction - tried installing app maximum times ', params.tryNum)
  } else {
    params.freezrUserAppListDB.read_by_id(appNameId, function (err, appRecord) {
      if (err) {
        felog('offThreadExtraction - freezrUserAppListDB.read_by_id err ', { params, err })
        params.tryNum++
        setTimeout(function () { offThreadExtraction(params) }, params.tryNum * 2000)
      } else if (!appRecord || !appRecord.offThreadStatus || !appRecord.offThreadStatus.offThreadParams || !appRecord.offThreadStatus.offThreadParams.tryNum) {
        params.tryNum++
        felog('offThreadExtraction - freezrUserAppListDB.read_by_id  NO APP RECORD ', { params, err })
        setTimeout(function () { offThreadExtraction(params) }, params.tryNum * 2000)
      } else if (appRecord.offThreadStatus.offThreadParams.versionDate !== params.versionDate) {
        felog('offThreadExtraction - vefsion date mismatch', { appRecord, params, err })
        // new installation process has begun - abort installation
      } else if (appRecord.offThreadStatus.offThreadWip === false) {
        felog('offThreadExtraction - fileList was emptied SNBH')
      } else {
        params.appRecord = appRecord
        fileHandler.extractNextFile(params, function (err, newFileList) {
          if (err) {
            params.tryNum++
            setTimeout(function () { offThreadExtraction(params) }, params.tryNum * 2000)
          } else if (newFileList.length === 0) {
            const offThreadStatus = {
              offThreadParams: null,
              offThreadWip: false
            }
            params.freezrUserAppListDB.update(appNameId, { offThreadStatus }, { replaceAllFields: false }, function (err, result) {
              if (err) felog('offThreadExtraction -  all done but error at end', { params })
            })
          } else {
            params.tryNum = 1
            params.filesRemaining = newFileList
            const offThreadStatus = {
              offThreadParams: {
                tryNum: 1,
                versionDate: params.versionDate,
                filesRemaining: newFileList
              }
            }
            params.freezrUserAppListDB.update(appNameId, { offThreadStatus }, { replaceAllFields: false }, function (err, result) {
              if (err) {
                felog('offThreadWip freezrUserAppListDB - updating status interrupted ', { err, result })
                params.tryNum++
              }
              setTimeout(function () {
                offThreadExtraction(params)
              }, 5000)
            })
          }
        })
      }
    })
  }
}
exports.appMgmtActions = function (req, res) /* deleteApp updateApp */ {
  //   app.post('/v1/account/appMgmtActions.json', accountLoggedInAPI, addUserAppsAndPermDBs, accountHandler.appMgmtActions)
  // onsole.log("At app mgmt actions "+JSON.stringify(req.body));

  const action = (req.body && req.body.action) ? req.body.action : null
  const appName = (req.body && req.body.app_name) ? req.body.app_name : null

  const appNameId = appIdFrom(req.session.logged_in_user_id, appName)

  if (action === 'removeAppFromHomePage') {
    req.freezrUserAppListDB.update(appNameId, { removed: true }, { replaceAllFields: false }, function (err, result) {
      if (err) {
        felog('appMgmtActions', 'removeAppFromHomePage err for ' + appName, err)
        helpers.send_failure(res, err, 'account_handler', exports.version, '', 'could not mark as removed')
      } else {
        helpers.send_success(res, { success: true })
      }
    })
  } else if (action === 'deleteApp') {
    async.waterfall([
      function (cb) {
        req.freezrUserAppListDB.delete_record(appNameId, null, cb)
      },
      function (result, cb) {
        req.freezrUserPermsDB.delete_records({ requestor_app: appName }, null, cb)
      },
      function (results, cb) {
        const folderPath = (req.freezrUserDS.fsParams.rootFolder || helpers.FREEZR_USER_FILES_DIR) + '/' + req.session.logged_in_user_id + '/apps/' + appName
        fileHandler.deleteLocalFolderAndContents(folderPath, cb)
      },
      function (cb) {
        req.freezrUserDS.getorInitAppFS(appName, {}, cb)
      },
      function (appFS, cb) {
        appFS.removeAllAppFiles(null, function (err) {
          if (!err || helpers.startsWith(err?.message, 'ENOENT: no such file or directory')) { // !err || added 2023008 - creates new errs? todo review
            cb(null)
          } else {
            cb(err)
          }
        })
      }
    ], function (err) {
      if (err) {
        console.warn('error deletign app ', { user: req.session.logged_in_user_id, err })
        helpers.send_internal_err_failure(res, 'account_handler', exports.version, 'appMgmtActions - deleteApp', 'Internal error trying to delete app. ')
      } else {
        // onsole.log("success in deleting app")
        helpers.send_success(res, { success: true })
      }
    })
  } else if (action === 'updateApp') {
    fdlog('going to updateApp ', appName)

    let flags = new Flags({ app_name: appName })
    const realAppName = appName
    const userDS = req.freezrUserDS
    let manifest = null
    let appFS
    const realAppPath = (userDS.fsParams.rootFolder || helpers.FREEZR_USER_FILES_DIR) + '/' + req.session.logged_in_user_id + '/apps/' + realAppName

    async.waterfall([
      // updateApp 1. make sure data and file names exist
      function (cb) {
        if (!req.session.logged_in_user_id) {
          cb(helpers.missing_data('user_id'))
        } else if (!helpers.valid_appName(realAppName)) {
          cb(helpers.invalid_data('app name: ' + realAppName, 'account_handler', exports.version, 'appMgmtActions'))
        } else if (!realAppName || realAppName.length < 1) {
          cb(helpers.invalid_data('app name missing - ', '', exports.version, 'install_app'))
        } else if (helpers.is_system_app(realAppName) || !helpers.valid_appName(realAppName)) {
          cb(helpers.invalid_data('app name not allowed: ' + appName, 'account_handler', exports.version, 'install_app'))
        } else if (!userDS) {
          cb(helpers.missing_data('userDS'))
        } else {
          cb(null)
        }
      },

      // get appFS and delete the local folder (if using cloud storage)
      function (cb) {
        userDS.getorInitAppFS(realAppName, {}, cb)
      },
      function (userAppFS, cb) {
        appFS = userAppFS
        if (appFS.fsParams.type === 'local' || appFS.fsParams.type === 'glitch') {
          cb(null)
        } else {
          fileHandler.deleteLocalFolderAndContents(realAppPath, cb)
        }
      },

      // reset cache and read app manifest and update perms and app record
      function (cb) {
        appFS.cache.appfiles = {}

        appFS.readAppFile(helpers.APP_MANIFEST_FILE_NAME, {}, function (err, readManifest) {
          if (err) { // assume missing manifest
            flags.add('notes', 'manifest_missing')
          } else {
            if (readManifest) {
              try {
                manifest = json.parse(readManifest)
              } catch (e) {
                felog('error parsing manifest ', e)
                flags.add('notes', 'manifest_read_err')
              }
            } else {
              flags.add('notes', 'manifest_missing')
            }
          }
          if (!manifest) manifest = {}
          if (!manifest.identifier) manifest.identifier = realAppName
          if (!manifest.display_name) manifest.display_name = realAppName
          if (!manifest.version) manifest.version = 0
          flags = fileHandler.checkManifest(manifest, realAppName, manifest.version, flags)
          updatePermissionRecordsFromManifest(req.freezrUserPermsDB, realAppName, manifest, cb)
        })
      },

      function (cb) {
        const appNameId = appIdFrom(req.session.logged_in_user_id, realAppName)
        createOrUpdateUserAppList(req.freezrUserAppListDB, appNameId, manifest, null, cb)
      }
    ],
    function (err, info) {
      // onsole.log({ err, info })
      flags.meta.app_name = realAppName
      if (err) {
        flags.add('errors', 'err_unknown', { function: 'appMgmtActions update', text: JSON.stringify(err) })
      } else if (info.isUpdate) {
        flags.add('notes', 'app_updated_msg')
        flags.meta.didwhat = 'updated'
      } else {
        flags.meta.didwhat = 'uploaded'
      }
      helpers.send_success(res, flags.sentencify())
    })
  } else {
    helpers.send_failure(res, new Error('unknown action'), 'account_handler', exports.version, 'appMgmtActions')
  }
}

// PERMISSIONS
// format: {requestor_app, name, table_id, type, description, 'returnFields', 'search_fields'}
exports.CEPSrequestorAppPermissions = function (req, res) {
  // app.get('/ceps/perms/get', userAPIRights, addUserPermDBs, accountHandler.CEPSrequestorAppPermissions)

  const requestorId = req.freezrTokenInfo.requestor_id // requestor and requestee are the same
  const requestorApp = req.freezrTokenInfo.app_name

  req.freezrUserPermsDB.query({ requestor_app: requestorApp, status: { $ne: 'removed' } }, {}, function (err, returnPerms) {
    fdlog('CEPSrequestorAppPermissions ', { requestorApp, returnPerms })
    if (err) {
      helpers.send_failure(res, err, 'account_handler', exports.version, 'requestorApp')
    } else {
      fdlog({ returnPerms })
      if (req.query?.owner && req.query?.owner !== req.freezrTokenInfo.requestor_id && req.freezrDataOwnerPermsDB) {
        // NOTE : Thgis is not yet in CEPS
        req.freezrDataOwnerPermsDB.query({ requestor_app: requestorApp, grantees: req.freezrTokenInfo.requestor_id, status: { $ne: 'removed' }, granted: true, outdated: { $ne: true }, revokeIsWip: { $ne: true } }, {}, function (err, returnOwnerPerms) {
          if (err) {
            helpers.send_failure(res, err, 'account_handler', exports.version, 'requestorApp')
          } else {
            if (returnOwnerPerms && returnOwnerPerms.length > 0) {
              returnOwnerPerms.forEach(perm => {
                const permCopy = {}
                permCopy.owner_id = req.query?.owner
                permCopy.requestor_app = perm.requestor_app
                permCopy.name = perm.name
                permCopy.table_id = perm.table_id
                permCopy.type = perm.type
                permCopy.description = perm.description
                returnPerms.push(permCopy)
              })
            }
            helpers.send_success(res, returnPerms)
          }
        })
      } else {
        helpers.send_success(res, returnPerms)
      }
    }
  })
}
exports.allRequestorAppPermissions = function (req, res) {
  // app.get('/v1/permissions/getall/:app_name', userAPIRights, addUserPermDBs, accountHandler.allRequestorAppPermissions)
  // optional query: groupall
  // groupall and having a call forward (req.freezrInternalCallFwd) groups the items in various categories

  const requestorApp = req.params.target_app || req.params.app_name // target_app for account/perms
  fdlog('allRequestorAppPermissions for requestorApp ' + requestorApp + ' target_app is' + req.params.target_app) // + 'req.freezrTokenInfo', req.freezrTokenInfo)
  if (req.freezrTokenInfo.app_name !== req.params.app_name && req.freezrTokenInfo.app_name !== 'info.freezr.account') {
    felog('allRequestorAppPermissions', 'auth error', req.freezrTokenInfo.app_name, req.params.app_name, ' - tocken info: ', req.freezrTokenInfo)
    helpers.send_failure(res, new Error('auth error - allRequestorAppPermissions'), 'account_handler', exports.version, 'disallowed')
  } else {
    req.freezrUserPermsDB.query({ requestor_app: requestorApp, status: { $ne: 'removed' } }, {}, function (err, returnPerms) {
      fdlog('allRequestorAppPermissions : req.query: ', { requestorApp, returnPerms })
      if (err) {
        helpers.send_failure(res, err, 'account_handler', exports.version, 'requestorApp')
      } else if ((req.query && req.query.groupall) || req.freezrIntermediateCallFwd || req.freezrInternalCallFwd) {
        const ret = {}
        ret[requestorApp] = groupPermissions(returnPerms, requestorApp)
        ret[requestorApp].app_name = '' // todo get app name and display name [later: why blank?]
        ret[requestorApp].app_display_name = requestorApp

        if (req.freezrIntermediateCallFwd) { /* ie coming from internal request for perm */
          fdlog('have freezrIntermediateCallFwd', { ret })
          req.freezrIntermediateCallFwd(null, ret)
        } else if (req.freezrInternalCallFwd) { /* ie coming from internal request for perm */
          fdlog('have freezrInternalCallFwd', { ret })
          req.freezrInternalCallFwd(null, ret)
        } else {
          // fdlog('sending success - allRequestorAppPermissions - NO freezrIntermediateCallFwd')
          helpers.send_success(res, ret)
        }
      } else {
        // fdlog({ returnPerms })
        helpers.send_success(res, returnPerms)
      }
    })
  }
}
function groupPermissions(returnPermissions, appName) {
  const groupedPermissions = {
    thisAppToThisApp: [],
    thisAppToOtherApps: [],
    otherAppsToThisApp: [],
    unknowns: []
  }

  if (!returnPermissions || returnPermissions.length === 0) {
    return groupedPermissions
  } else {
    let aPerm
    for (let i = 0; i < returnPermissions.length; i++) {
      aPerm = returnPermissions[i]
      if (['share_records', 'message_records', 'db_query'].indexOf(aPerm.type) > -1 && aPerm.requestor_app === appName && helpers.startsWith(aPerm.table_id, appName)) {
        groupedPermissions.thisAppToThisApp.push(aPerm)
      } else if (['upload_pages'].indexOf(aPerm.type) > -1 && aPerm.requestor_app === appName) {
        groupedPermissions.thisAppToThisApp.push(aPerm)
      } else if (['share_records', 'read_all', 'message_records', 'write_own', 'write_all', 'db_query', 'use_app'].indexOf(aPerm.type) > -1 && aPerm.requestor_app !== appName && helpers.startsWith(aPerm.table_id, appName)) {
        groupedPermissions.otherAppsToThisApp.push(aPerm)
      } else if (['share_records', 'read_all', 'write_all', 'message_records', 'write_own', 'db_query'].indexOf(aPerm.type) > -1 && aPerm.requestor_app === appName && !helpers.startsWith(aPerm.table_id, appName)) {
        groupedPermissions.thisAppToOtherApps.push(aPerm)
      } else {
        groupedPermissions.unknowns.push(aPerm)
        felog('groupPermissions', 'ERROR - why this . uknown permission ' + JSON.stringify(aPerm))
      }
    }
    // onsole.log("returning groupedPermissions", groupedPermissions)
    return groupedPermissions
  }
}
exports.generatePermissionHTML = function (req, res) {
  // app.get('/v1/permissions/gethtml/:app_name', userAPIRights, addUserPermDBs, accountHandler.generatePermissionHTML)
  fdlog('generatePermissionHTML ' + req.url, 'req.params', req.params)

  if (!req.freezrTokenInfo) fdlog('generatePermissionHTML Missing req.freezrTokenInfo')
  // fdlog('generatePermissionHTML req.params', req.params, 'req.query', req.query, 'switch? ' + (req.path.indexOf('/account/perms') === 0) + '  ' + req.path.indexOf('/account/perms'))
  if (req.query.table_id && req.path.indexOf('/account/perms') === 0) { // ie parameters are under query
    fdlog('switch fpr account/perms') // todo - review
    // req.params.app_name = req.params.target_app
    // req.params.requestee_app = req.query.requestor_app
  }
  req.freezrIntermediateCallFwd = function (err, results) {
    if (err) felog('generatePermissionHTML', 'err in generatePermissionHTML - freezrIntermediateCallFwd ', err)
    fdlog('freezrIntermediateCallFwd results ', JSON.stringify(results))
    const Mustache = require('mustache')
    // todo add option to wrap pcard in html header
    fileHandler.getLocalSystemAppFileContent('systemapps/info.freezr.account/account_permobject.html', function (err, htmlForPermGroup) {
      let htmlContent = ''
      if (err || !htmlForPermGroup) {
        felog('generatePermissionHTML', 'file missing', 'html file missing')
        htmlContent = 'error - unable to retrieve html'
      } else {
        htmlForPermGroup = htmlForPermGroup.toString()
        Object.keys(results).forEach(function (appName, i) {
          const appObj = results[appName]
          htmlContent += '<table class="app_container" width="100%"><tbody><tr><td width="40px"><br><br><img src="/app_files/' + appName + '/static/logo.png" width="40px" class="logo_img"></td>'
          htmlContent += '<td><div class="freezer_dialogue_topTitle">' + appObj.app_display_name + '</div><span class="small_text">' + appName + '</span><br></td></tr></tbody></table>'

          htmlContent += '<div id="freezer_InnerLoginInfo"></div>'

          const IntroText = {
            thisAppToThisApp: 'This app is asking for permission to share data from this app:',
            thisAppToOtherApps: 'This app is asking for permissions to access data from other apps:',
            otherAppsToThisApp: 'Other apps are asking for permission to see your data from this app:',
            unkowns: 'These permissions are uknkown to freezr'
          }
          const addPermSentence = function (aPerm) {
            let sentence = ''
            const hasBeenAccepted = (aPerm.granted && !aPerm.outDated)
            const otherApp = !helpers.startsWith(aPerm.table_id, aPerm.requestor_app)
            const accessWord = otherApp ? 'access and share' : 'share'

            sentence += hasBeenAccepted ? 'This app is able to ' : 'This app wants to be able to '
            if (aPerm.type === 'share_records') {
              sentence += accessWord + ' individual data records from the table ' + '<b' + (otherApp ? " style='color:purple;'>" : '>') + aPerm.table_id + '</b>,' + ' with the your contacts and the public.<br/>'
            } else if (aPerm.type === 'message_records') {
              sentence += accessWord + ' send messages to other servers, containing any text or records<br/>'
            } else if (aPerm.type === 'read_all') {
              sentence += accessWord + ' read all the records in the table: ' + "<b style='color:purple;'>" + aPerm.table_id + '</b>,' + '.<br/>'
            } else if (aPerm.type === 'write_all') {
              sentence += accessWord + ' read and write all the records in the table: ' + "<b style='color:purple;'>" + aPerm.table_id + '</b>,' + '.<br/>'
            } else if (aPerm.type === 'write_own') {
              sentence += accessWord + ' read all the records, and write / edit new records in the table: ' + "<b style='color:purple;'>" + aPerm.table_id + '</b>,' + '.<br/>'
            } else if (aPerm.type === 'upload_pages') {
              sentence += accessWord + ' individual files with the public.<br/>'
            } else if (aPerm.type === 'use_app') {
              sentence += ' allow other people to access the app itself.<br/>'
            } else if (aPerm.type === 'db_query') {
              sentence += accessWord + 'query the table: ' + "<b style='color:purple;'>" + aPerm.table_id + '</b>,' + '.<br/>'
            }
            if (aPerm.outDated) sentence += 'This permission was previously granted but the permission paramteres have changed to you would need to re-authorise it.<br/>'
            aPerm.sentence = sentence
            aPerm.action = hasBeenAccepted ? 'Deny' : 'Accept'
            return aPerm
          }

          let permCount = 0
          Object.keys(appObj).forEach(function (permType, i) {
            if (permType !== 'app_name' && permType !== 'app_display_name') {
              const toRender = {
                perm_grouping_intro: IntroText[permType],
                perm_list: appObj[permType],
                perm_type: permType
              }
              if (toRender.perm_list.length > 0) {
                // toRender.perm_list =
                permCount++
                toRender.perm_list.map(addPermSentence)
                // fdlog('permobject - toRender for key: ', permType, ' for toRender.perm_list: ', toRender.perm_list)
                htmlContent += Mustache.render(htmlForPermGroup, toRender)
              }
            }
          })
          if (permCount === 0) htmlContent += '<div class="freezer_dialogueTitle">There are no requests to share data related to this app.</div>'
        })
      }
      if (req.freezrInternalCallFwd) {
        req.freezrInternalCallFwd(err, { all_perms_in_html: htmlContent })
      } else {
        helpers.send_success(res, { all_perms_in_html: htmlContent })
      }
    })
  }
  exports.allRequestorAppPermissions(req, res)
}
exports.changeNamedPermissions = function (req, res) {
  // app.put('/v1/permissions/change/:requestee_app_table', accountLoggedInAPI, addUserPermsAndRequesteeDB, addPublicRecordsDB, accountHandler.changeNamedPermissions)

  fdlog('changePermissions ' + JSON.stringify(req.body))
  if (req.body.change && req.body.change.name && req.body.change.action && req.body.change.table_id && req.body.change.requestor_app) {
    const list = req.body.change

    const permQuery = { name: list.name, table_id: list.table_id, requestor_app: list.requestor_app }
    req.freezrUserPermsDB.query(permQuery, {}, function (err, results) {
      if (err) {
        felog('changeNamedPermissions', err)
        helpers.send_failure(res, helpers.error('error getting permissions from db'), 'account_handler', exports.version, 'changeNamedPermissions')
      } else if (results.length === 0) {
        helpers.send_failure(res, helpers.error('permission record not found - try re-installing app'), 'account_handler', exports.version, 'changeNamedPermissions')
      } else if (results.length > 1) {
        req.freezrUserPermsDB.delete(results[1]._id, function (err, ret) {
          if (err) { felog('changeNamedPermissions', 'could not delete extra permission') } else { felog('changeNamedPermissions', 'extra permission SNBH') }
          helpers.send_failure(res, helpers.error('SNBH - more than one permission record'), 'account_handler', exports.version, 'changeNamedPermissions')
        })
      } else if (list.action === 'Accept' || list.action === 'Deny') {
        fdlog('changeNamedPermissions - going to accept or deny:', list.action)
        // update and also
        const granted = (list.action === 'Accept')
        const change = { outDated: false, granted, revokeIsWip: (!granted), status: (granted ? 'granted' : 'declined') }
        // const change = { outDated: false, granted, revokeIsWip: (!granted) }
        const oldGrantees = results[0].grantees || []
        const permId = results[0]._id
        req.freezrUserPermsDB.update(results[0]._id, change, { replaceAllFields: false }, function (err, results) {
          if (err) {
            felog('changeNamedPermissions', 'ERR in update freezrUserPermsDB', err)
            helpers.send_failure(res, err, 'account_handler', exports.version, 'changeNamedPermissions')
          } else if (!granted) {
            const fullPermName = (permQuery.requestor_app + '/' + permQuery.name).replace(/\./g, '. ')
            // todo - this function needs to scale - in case of too many records, split in chunks
            // Get all records with grantee permissions and remove the permission
            async.forEach(oldGrantees, function (grantee, cb2) {
              // console.log('THIS NEEDS TO BE UPDATED!!!??? 2021')
              if (req.freezrRequesteeDB) req.freezrRequesteeDBs = [req.freezrRequesteeDB]
              const thequery = {}
              thequery['_accessible.' + grantee + '.' + fullPermName + '.granted'] = true

              async.forEach(req.freezrRequesteeDBs, function (freezrRequesteeDB, cb3) {
                freezrRequesteeDB.query(thequery, {}, function (err, recs) {
                  if (err) felog('changeNamedPermissions', 'ERR in freezrRequesteeDB query ', thequery, ' err: ', err)
                  fdlog('todo - also need to update freezrPublicPermDB if there are no more public permissions')
                  async.forEach(recs, function (rec, cb4) {
                    const accessible = rec._accessible
                    const publicid = (accessible[grantee] && accessible[grantee][fullPermName] && accessible[grantee][fullPermName].publicid) ? accessible[grantee][fullPermName].publicid : null
                    if (accessible[grantee] && accessible[grantee][fullPermName]) delete accessible[grantee][fullPermName]
                    if (helpers.isEmpty(accessible[grantee])) delete accessible[grantee]
                    freezrRequesteeDB.update(rec._id, { accessible }, { replaceAllFields: false }, function (err) {
                      if (err) felog('changeNamedPermissions', 'ERR in freezrRequesteeDB update ', rec._id, 'err: ', err)
                      if (grantee !== '_public') {
                        cb4(err)
                      } else {
                        // accessiblesQuery = {permissionName: permQuery.name, table_id: permQuery.table_id, requestor_app:permQuery.requestor_app, dataOwner:req.session.logged_in_user_id,  originalRecordId:}
                        req.freezrPublicRecordsDB.delete_record(publicid, cb4)
                      }
                    })
                  }, cb3)
                })
              },
                cb2)
            }, function (err) {
              if (err) felog('changeNamedPermissions', 'if error, the perm update should be added to a clean up list')
              if (err) {
                helpers.send_failure(res, helpers.invalid_data('Could not affect chenge throughout freezr.', 'account_handler'), 'account_handler', exports.version, 'changeNamedPermissions')
              } else {
                req.freezrUserPermsDB.update(permId, { revokeIsWip: false, grantees: [] }, { replaceAllFields: false }, function (err) {
                  if (err) {
                    felog('changeNamedPermissions', 'freezrUserPermsDB ERR in update permId ', permId, ' err: ', err)
                    helpers.send_failure(res, helpers.invalid_data('Could not affect chenge throughout freezr.', 'account_handler'), 'account_handler', exports.version, 'changeNamedPermissions')
                  } else {
                    helpers.send_success(res, { success: true, name: permQuery.name, action: list.action, flags: null })
                  }
                })
              }
            })
          } else { // granted
            fdlog('todo freezrPublicPermDB functionality needs to be tested')
            req.freezrPublicManifestsDb.query({ user_id: req.session.logged_in_user_id, app_name: list.requestor_app }, null, (err, results) => {
              if (err) {
                felog('changeNamedPermissions', 'error setting freezrPublicPermDB - also flag below needs to be set correctly')
                helpers.send_success(res, { success: true, name: permQuery.name, action: list.action, flags: ['freezrPublicPermDB - error reading record'] })
              } else {
                fdlog('todo - need to get each card as well')
                let permissions = [list.name]
                let recId = null
                if (results && results[0]) {
                  recId = results[0]._id
                  permissions = helpers.addToListAsUnique(results[0].permissions, list.name)
                }
                const write = {
                  manifest: req.freezrRequestorManifest,
                  cards: req.freezrPublicCards,
                  ppages: req.freezrPublicPages,
                  user_id: req.session.logged_in_user_id,
                  app_name: list.requestor_app,
                  permissions
                }
                const sendResult = function (err, result) {
                  const flags = err ? ['freezrPublicPermDB - error setting record'] : null
                  helpers.send_success(res, { success: true, name: permQuery.name, action: list.action, flags })
                }
                if (results && results[0]) {
                  req.freezrPublicManifestsDb.update(recId, write, { replaceAllFields: true }, sendResult)
                } else {
                  req.freezrPublicManifestsDb.create(recId, write, null, sendResult)
                }
              }
            })
          }
        })
      } else {
        helpers.send_failure(res, helpers.invalid_data('action needs to be Deny or Accept.', 'account_handler'), 'account_handler', exports.version, 'changeNamedPermissions')
      }
    })
  } else {
    helpers.send_failure(res, helpers.invalid_data('One request at a time can be accepted.', 'account_handler'), 'account_handler', exports.version, 'changeNamedPermissions')
  }
}

const permissionObjectFromManifestParams = function (requestorApp, manifestPerm) {
  const ALLOWED_PERMISSION_TYPES = ['upload_pages', 'share_records', 'read_all', 'message_records', 'write_own', 'write_all', 'db_query', 'use_app', 'use_microservice']
  const PERMISSION_FIELD_TYPES = {
    requestor_app: 'string',
    table_id: 'string', // but can also store an array, if table_ids is declared
    table_ids: 'array',
    type: 'string',
    name: 'string',
    description: 'string',
    return_fields: 'array',
    search_fields: 'array'
    // Added by freezr
    // granted: 'bool',
    // status: 'string',
  }
  let err = ''
  let returnpermission = null
  const name = manifestPerm.name
  if (!manifestPerm || typeof manifestPerm !== 'object' || !requestorApp) {
    felog('permissionObjectFromManifestParams', 'cannot make permission without a proper permission object ', { requestorApp, name })
    err = 'Cannot make permission without a proper permission object.'
  }
  if (!err && !name) {
    felog('permissionObjectFromManifestParams', 'cannot make permission without a name ', { requestorApp, name })
    err = 'Cannot make permission without a name.'
  }
  const DONT_NEED_TABLES = ['use_app', 'upload_pages', 'use_microservice']
  if (!manifestPerm.table_id && !manifestPerm.table_ids && !DONT_NEED_TABLES.includes(manifestPerm.type)) {
    felog('permissionObjectFromManifestParams', 'cannot make permission without a table ', { manifestPerm, requestorApp, name })
    err = (err ? ' And ' : name + ': ') + 'Cannot make permission without a table_id or type. '
  }
  if (!manifestPerm.type || ALLOWED_PERMISSION_TYPES.indexOf(manifestPerm.type) < 0) {
    felog('permissionObjectFromManifestParams', 'permission type is not allowed', { manifestPerm, requestorApp, name })
    err = (err ? ' And ' : name + ': ') + 'Permission type ' + manifestPerm.type + ' is not valid.'
  }

  if (!err) {
    returnpermission = {}
    Object.entries(PERMISSION_FIELD_TYPES).forEach(([key, prop]) => {
      switch (prop) {
        case 'bool':
          err += key + ' '
          break
        case 'array':
          if (!manifestPerm[key]) {
            returnpermission[key] = []
          } else if (Array.isArray(manifestPerm[key])) {
            returnpermission[key] = [...manifestPerm[key]]
            // todo - all data within array must be strings
          } else {
            err += key + ' '
          }
          break
        case 'string':
          if (!manifestPerm[key]) {
            returnpermission[key] = ''
          } else if (typeof manifestPerm[key] === 'string') {
            returnpermission[key] = manifestPerm[key]
          } else {
            err += key + ' '
          }
          break
        default:
          err += key + ' '
      }
    })
    if (err) {
      err = name + ': Wrong types send for ' + err
      felog('permissionObjectFromManifestParams', 'cWrong types for permission ', { manifestPerm, requestorApp, name })
      returnpermission = null
    } else {
      returnpermission.name = name
      returnpermission.requestor_app = requestorApp
      if (returnpermission.table_ids && !returnpermission.table_id) {
        returnpermission.table_id = returnpermission.table_ids
      }
      delete returnpermission.table_ids
    }
  }

  return [err, returnpermission]
}
const updatePermissionRecordsFromManifest = function (freezrUserPermsDB, appName, manifest, callback) {
  const manifestPerms = (manifest && manifest.permissions && Object.keys(manifest.permissions).length > 0) ? JSON.parse(JSON.stringify(manifest.permissions)) : null

  if (!manifest || !manifestPerms) {
    // these should already have been flagged
    callback(null)
  } else {
    // make a list of the schemas to re-iterate later and add blank permissions
    const cleanedManifestPermList = []
    const allPermissionNames = []
    const errs = []

    if (manifestPerms && manifestPerms.length > 0) {
      manifestPerms.forEach((statedPerm, i) => {
        const [err, cleanedManifestPerm] = permissionObjectFromManifestParams(appName, statedPerm)
        if (err) {
          errs.push(err)
        } else {
          cleanedManifestPermList.push(cleanedManifestPerm)
          allPermissionNames.push(statedPerm.name)
        }
      })
    }

    if (errs.length > 0) {
      callback(new Error(errs.join('\n')))
    } else {
      freezrUserPermsDB.query({ requestor_app: appName }, {}, function (err, existingPermList) {
        if (err) {
          callback(err)
        } else {
          existingPermList.forEach((perm) => {
            if (!allPermissionNames.includes(perm.name)) allPermissionNames.push(perm.name)
          })
        }

        async.forEach(allPermissionNames, function (permissionName, cb) { // get perms
          const cleanedManifestPerm = objectFromList(cleanedManifestPermList, 'name', permissionName)
          const existingPermFromDb = objectFromList(existingPermList, 'name', permissionName)

          if (!existingPermFromDb) { // create new perm: cleanedManifestPerm.name for aUser
            cleanedManifestPerm.granted = false
            cleanedManifestPerm.status = 'pending'
            cleanedManifestPerm.grantees = []
            freezrUserPermsDB.create(null, cleanedManifestPerm, {}, cb)
          } else if (!cleanedManifestPerm) { // permission has been removed so it must be outdated
            existingPermFromDb.status = 'removed'
            existingPermFromDb.granted = false
            freezrUserPermsDB.update(existingPermFromDb._id, existingPermFromDb, {}, cb)
          } else if (permissionsAreSame(cleanedManifestPerm, existingPermFromDb)) { // leave as is
            if (existingPermFromDb.status === 'removed' || existingPermFromDb.status === 'outdated') {
              existingPermFromDb.status = 'pending' // ie no longer removed
              freezrUserPermsDB.update(existingPermFromDb._id, existingPermFromDb, {}, cb)
            } else {
              cb(null)
            }
          } else {
            cleanedManifestPerm.status = 'outdated'
            cleanedManifestPerm.granted = false
            cleanedManifestPerm.previousGrantees = existingPermFromDb.grantees
            cleanedManifestPerm.grantees = []
            freezrUserPermsDB.update(existingPermFromDb._id, cleanedManifestPerm, {}, cb)
          }
        },
        function (err) {
          callback(err)
        })
      })
    }
  }
}
const objectFromList = function (objectList, param, value) {
  let foundObject = null
  objectList.forEach((anObject, i) => {
    if (anObject[param] === value) {
      foundObject = anObject
    }
  })
  return foundObject
}

const createOrUpdateUserAppList = function (freezrUserAppListDB, appNameId, manifest, env, callback) {
  // ??? note - currently updates the app_display_name only (and marks it as NOT removed)
  fdlog('createOrUpdateUserAppList  ', { manifest })

  let appExists = false
  let appEntity = null

  const appName = (manifest.identifier) ? manifest.identifier : null
  const appDisplayName = (manifest.display_name) ? manifest.display_name : manifest.identifier

  async.waterfall([
    // 1 make sure data exists and that app exists
    function (cb) {
      if (!appNameId) {
        cb(helpers.missing_data('appNameId', 'account_handler', exports.version, 'add_app'))
      } else if (!appName) {
        cb(helpers.missing_data('app_name', 'account_handler', exports.version, 'add_app'))
      } else if (!helpers.valid_appName(appName)) {
        cb(helpers.invalid_data('app_name: ' + appName, 'account_handler', exports.version, 'createOrUpdateUserAppList'))
      } else {
        freezrUserAppListDB.read_by_id(appNameId, cb)
      }
    },

    // 3. create or update the app in the database.
    function (existingEntity, cb) {
      if (existingEntity) {
        appExists = true
        appEntity = existingEntity
        appEntity.manifest = manifest
        appEntity.removed = false
        appEntity.app_name = appName
        appEntity.app_display_name = appDisplayName
        if (env || appEntity.env) appEntity.env = env
        freezrUserAppListDB.update(appNameId, appEntity, { replaceAllFields: true }, cb)
      } else {
        appEntity = { app_name: appName, app_display_name: appDisplayName, served_url: manifest.served_url, manifest, env, removed: false }
        freezrUserAppListDB.create(appNameId, appEntity, null, cb)
      }
    }
  ],
  function (err) {
    if (err) {
      callback(err, {})
    } else {
      callback(null, { isUpdate: appExists })
    }
  })
}
const permissionsAreSame = function (p1, p2) {
  return objectsaresame(p1, p2, ['outDated', 'revokeIsWip', 'granted', 'status', 'grantees', 'previousGrantees', '_date_created', '_date_modified', '_id'])
}
const objectsaresame = function (obj1, obj2, givenIgnorekeys = []) {
  fdlog('compare ', { obj1, obj2 })
  const ignorekeys = [...givenIgnorekeys]

  if ((obj1 === undefined || obj1 === null) && (obj2 === undefined || obj2 === null)) return true

  if (typeof obj1 !== typeof obj2) {
    return false
  }
  if (!obj1 || ['string', 'boolean', 'number'].includes(typeof obj1)) return obj1 === obj2

  let areSame = true
  for (const key in obj1) {
    if ((!ignorekeys.includes(key)) && !objectsaresame(obj1[key], obj2[key], [], false)) {
      areSame = false
    }
    ignorekeys.push(key)
  }
  if (areSame) {
    for (const key in obj2) {
      if ((!ignorekeys.includes(key)) && !objectsaresame(obj1[key], obj2[key], [])) {
        areSame = false
      }
    }
  }
  return areSame
}

// VALIDATIONS
exports.CEPSValidator = function (req, res) {
  // app.get('/ceps/perms/validationtoken', validationTokenChecks, addValidationTokenDB, accountHandler.CEPSValidator)
  // NOTE:'req.query.set' requires being logged in but others are public
  // req.query.set =>  userAPIRights => req.freezrTokenInfo
  // req.query.set and verify => req.freezrValidationTokenDB
  // req.query.validate => req.freezrCepsContacts req.freezrUserPermsDB req.freezrAppTokenDB

  if (req.params.action === 'set') {
    /*
    { data_owner_host : {host url}, // blank if same
      data_owner_user : {username},
      table_id : {table-identifier},
      requestor_user :{username of requestor on her/his own pds},
      permission : {name of permission},
      app_id: {requesting app’s id}, [-> change to requestor_app??]
      record_id : {_id of record being shared} // (optional)
    }
    */
    if (!req.freezrTokenInfo) {
      helpers.send_failure(res, helpers.error('data mismatch'), 'account_handler', exports.version, 'CEPSValidator set')
    } else if (req.body.app_id !== req.freezrTokenInfo.app_name) {
      felog('CEPSValidator mismatch - body ', req.body, ' vs token ', req.freezrTokenInfo)
      helpers.send_failure(res, helpers.error('data mismatch'), 'account_handler', exports.version, 'CEPSValidator set')
    } else if (req.freezrTokenInfo.requestor_id !== req.freezrTokenInfo.owner_id) {
      felog('auth failure ', req.freezrTokenInfo.requestor_id, ' vs token ', req.freezrTokenInfo)
      helpers.send_failure(res, helpers.error('incomplete request 1 '), 'account_handler', exports.version, 'CEPSValidator set')
    } else if (!req.body.data_owner_user) {
      felog('incomplete request 2 ', req.body, ' vs token ', req.freezrTokenInfo)
      helpers.send_failure(res, helpers.error('incomplete request 2'), 'account_handler', exports.version, 'CEPSValidator set')
    } else {
      // if (!req.body.data_owner_host) req.body.data_owner_host = req.body.requestor_host // default
      const validationtoken = helpers.randomText(30)
      const EXPIRATION_MINUTES = 5
      const expiration = new Date().getTime() + EXPIRATION_MINUTES * 60 * 1000
      const requesterHost = (helpers.startsWith(req.get('host'), 'localhost') ? 'http' : 'https') + '://' + req.headers.host
      const dataOwnerHost = req.body.data_owner_host

      const newValidator = {
        validation_token: validationtoken,
        expiration,
        requestor_user: req.freezrTokenInfo.requestor_id,
        data_owner_host: dataOwnerHost,
        data_owner_user: req.body.data_owner_user,
        permission: req.body.permission,
        table_id: req.body.table_id,
        app_id: req.freezrTokenInfo.app_name,
        record_id: req.body.record_id // {_id of record being shared} // (optional)
      }
      if (dataOwnerHost) newValidator.requestor_host = requesterHost // new 2022-12 for same host requests
      // todo - also check contqcts and user -> BlockMsgsToNonContacts
      req.freezrValidationTokenDB.create(null, newValidator, null, function (err, returns) {
        fdlog('freezrValidationTokenDB.create ', { err, returns })
        if (err) {
          felog('error in freezrValidationTokenDB ', err)
          helpers.send_failure(res, helpers.error('incomplete request 4'), 'account_handler', exports.version, 'CEPSValidator set')
        } else {
          helpers.send_success(res, { validation_token: validationtoken, requestor_host: requesterHost, expiration })
        }
      })
    }
  } else if (req.params.action === 'validate') {
    /*
    validation_token: {Same as above}
    data_owner_user : {Same as above},
    data_owner_host : {Same as above},
    table_id : {Same as above},
    permission : {Same as above},
    app_id : {Same as above},
    requestor_user : {Same as above},
    requestor_host: {Same as above,
    */
    // if (!req.query.data_owner_host) req.query.data_owner_host = req.query.requestor_host // default
    const requestor = req.query.requestor_user + (req.query.requestor_host ? ('@' + req.query.requestor_host.replace(/\./g, '_')) : '')
    const appToken = helpers.generateAppToken(requestor, req.query.app_id, null)
    const accessTokenExpiry = (new Date().getTime() + EXPIRY_DEFAULT)
    async.waterfall([
      // 1. basic checks
      function (cb) {
        if (!req.query.validation_token || !req.query.data_owner_user || !req.query.table_id || !req.query.requestor_user || (!req.query.permission && req.query.requestor_host && req.freezrTokenInfo.app_name !== 'info.freezr.account')) { // || !req.query.requestor_host  new 2022-11
          console.warn('CEPS Validator incomplete request 5 body ', req.bod, ' freezrTokenInfo ', req.freezrTokenInfo)
          cb(helpers.error('incomplete request 5'))
        } else {
          cb(null)
        }
      },

      // 2. make sure contact exists (todo - can also make sure that the person has turned on sharing. Need to create a flag in the userDS)
      function (cb) {
        // onsole.log('querying contacts of user ', req.query.requestor_user, ' - ... ', req.logged_in_user_id, { requestor }, 'req.query.data_owner_user: ', req.query.data_owner_user, '  req.query.data_owner_host: ', req.query.data_owner_host)
        req.freezrCepsContacts.query({ username: req.query.requestor_user, serverurl: req.query.requestor_host }, null, cb)
      },
      function (contacts, cb) {
        if (contacts && contacts.length > 0) {
          cb(null)
        } else if (!req.query.data_owner_host && req.query.data_owner_user === 'public') {
          // exception for 'public'
          cb(null)
        } else if (req.freezrUserPrefs && req.freezrUserPrefs.blockMsgsFromNonContacts) {
          felog('no contacts - invalid request - c')
          // onsole.log('invalid request - c ', req.query.data_owner_host, req.query.requestor_host, req.query.data_owner_user)
          cb(helpers.error('invalid request - c'))
        } else if ((!req.query.data_owner_host && req.query.requestor_host) || (req.query.data_owner_host && !req.query.requestor_host)) {
          cb(helpers.error('invalid request - d')) // 2022-12
        } else {
          cb(null)
        }
      },

      // make sure permission has been granted
      function (cb) {
        if (req.query.data_owner_user === 'public' && !req.query.data_owner_host) { // this case isdealt with in sync below
          // onsole.log('req.query.table_id ', req.query.table_id, '    req.query.permission: ', req.query.permission)
          cb(null)
        } else {
          const dbQuery = {
            table_id: req.query.table_id,
            name: req.query.permission,
            granted: true
          }
          req.freezrUserPermsDB.query(dbQuery, {}, function (err, grantedPerms) {
            if (err) {
              felog('invalid requst getting granted perms ', err)
              cb(helpers.error('invalid request 1'))
            } else if (!grantedPerms || grantedPerms.length < 1) {
              felog('invalid requst getting granted perms ', { grantedPerms })
              console.warn('invalid requst getting granted perms ', { user: req.session.logged_in_user_id, grantedPerms }, req.query)
              cb(helpers.error('invalid request 2'))
            } else {
              // [2021 - groups] freezrAttributes.reader
              let hasRight = false
              grantedPerms.forEach((item) => {
                if (item.grantees && item.grantees.includes(requestor)) hasRight = true
              })
              // console.log('todo - here check for each requestee or the groups they are in... also see if permission name will be used')
              felog('invalid request getting granted perms ', { err, requestor })
              cb(hasRight ? null : helpers.error('invalid request getting permissions granted'))
            }
          })
        }
      },

      function (cb) {
        if (!req.query.data_owner_host) { // ie requestor is samehost as owner
          if (req.query.data_owner_user === 'public') { // exception for common db's
            // onsole.log('req.query.table_id ', req.query.table_id, '    req.query.permission: ', req.query.permission)
            const perm = publicPerms[req.query.data_owner_user][req.query.permission]
            if (perm && perm.table_id === req.query.table_id && perm.granted === 'all_server_users') {
              cb(null, { verified: true })
            } else {
              felog('req.query ',req.query, { perm })
              cb(helpers.error('not verifited for internal access 1'))
            }
          } else {
            req.freezrValidationTokenDB.query(validationParamsFromQuery(req.query), null, function (err, returns) {
              if (err) {
                cb(err)
              } else if (!returns || returns.length < 1) {
                cb(helpers.error('not verifited 1'))
              } else {
                cb(null, { verified: true })
              }
            })
          }
        } else {
          // https://flaviocopes.com/node-http-post:1
          const isLocalhost = helpers.startsWith(req.query.requestor_host, 'http://localhost')
          const https = isLocalhost ? require('http') : require('https')

          let queryString = 'validation_token=' + req.query.validation_token
          queryString += '&data_owner_user=' + req.query.data_owner_user
          if (req.query.data_owner_host) queryString += '&data_owner_host=' + req.query.data_owner_host
          queryString += '&permission=' + req.query.permission
          queryString += '&table_id=' + req.query.table_id
          queryString += '&requestor_user=' + req.query.requestor_user
          if (req.query.requestor_host) queryString += '&requestor_host=' + req.query.requestor_host

          const options = {
            hostname: isLocalhost ? 'localhost' : req.query.requestor_host.slice(8),
            path: '/ceps/perms/validationtoken/verify?' + queryString,
            // protocol: isLocalhost ? 'http:' : 'https:',
            method: 'GET',
            headers: {
              'Content-Type': 'application/json'
              // 'Content-Length': data.length
            }
          }
          if (isLocalhost) options.port = req.query.requestor_host.slice(17)
          const verifyReq = https.request(options, (verifyRes) => {
            verifyRes.on('data', (returns) => {
              cb(null, returns)
            })
          })
          verifyReq.on('error', (error) => {
            felog('error in veriffy ', error)
            cb(helpers.error('incomplete validation'))
          })
          verifyReq.write('') // data
          verifyReq.end()
        }
      },

      function (otherServerReturns, cb) {
        // onsole.log({ otherServerReturns })
        // otherServerReturns = JSON.parse(otherServerReturns.toString()) // changed from tostring 2022-11 - why tostring??
        otherServerReturns = JSON.parse(JSON.stringify(otherServerReturns))
        if (otherServerReturns.verified) {
          const write = {
            logged_in: false,
            requestor_id: requestor,
            owner_id: req.query.data_owner_user,
            app_name: req.query.app_id,
            app_token: appToken, // create token instead
            expiry: accessTokenExpiry,
            one_device: null,
            user_device: null,
            date_used: null // to be replaced by date
          }
          req.freezrAppTokenDB.create(null, write, null, cb)
        } else {
          felog('invalid request getting other server returns', { otherServerReturns })
          cb(helpers.error('invalid request 3'))
        }
      }
    ],
      function (err, results) {
        fdlog('CEPSValidator validate 5 ', { results, err })
        if (err) {
          helpers.send_failure(res, err, 'account_handler', exports.version, 'CEPSValidator validate')
        } else if (!results) {
          helpers.send_failure(res, err, 'account_handler', exports.version, 'CEPSValidator validate')
        } else {
          helpers.send_success(res, { validated: true, 'access-token': appToken, expiry: accessTokenExpiry })
        }
      })
  } else if (req.params.action === 'verify') {
    if (!req.query.validation_token || !req.query.data_owner_user || !req.query.data_owner_host || !req.query.table_id || !req.query.permission || !req.query.requestor_user || !req.query.requestor_host) {
      felog('Missing verification data query:', req.query, '   url:' + req.url)
      helpers.send_failure(res, helpers.error('invalid data'), 'account_handler', exports.version, 'CEPSValidator verify')
    } else {
      req.freezrValidationTokenDB.query(validationParamsFromQuery(req.query), null, function (err, returns) {
        if (err) {
          felog('incomplete req 6 7 ', { err })
          helpers.send_failure(res, helpers.error('incomplete request 6'), 'account_handler', exports.version, 'CEPSValidator verify')
        } else if (!returns || returns.length === 0) {
          helpers.send_failure(res, helpers.error('incomplete request 7'), 'account_handler', exports.version, 'CEPSValidator verify')
        } else {
          helpers.send_success(res, { verified: true })
        }
      })
    }
  } else {
    helpers.send_failure(res, helpers.error('invalid query'), 'account_handler', exports.version, 'CEPSValidator')
  }
}
const validationParamsFromQuery = function (query) {
  const params = {
    validation_token: query.validation_token,
    data_owner_user: query.data_owner_user,
    permission: query.permission,
    table_id: query.table_id,
    requestor_user: query.requestor_user,
    expiration: { $gt: new Date().getTime() }
  }
  if (query.data_owner_host) params.data_owner_host = query.data_owner_host
  return params
}

// CONFIGS
const publicPerms = { // permissions given to all users on a server
  public: {
    privateCodes: {
      table_id: 'dev.ceps.privatefeeds.codes',
      granted: 'all_server_users'
    }
  }
}
const accountPageManifest = function (params) { // manifest parameters for accounts pages
  if (params.page === 'app' && !params.sub_page) params.sub_page = 'manage'
  const manifests = {
    home: {
      page_title: 'Accounts Home (Freezr)',
      css_files: ['./@public/info.freezr.public/public/freezr_style.css', 'account_home.css'],
      page_url: 'account_home.html',
      initial_query_func: listAllUserApps,
      app_name: 'info.freezr.account',
      script_files: ['account_home.js']
    },
    settings: {
      page_title: 'Account Settings (freezr)',
      css_files: ['./@public/info.freezr.public/public/freezr_style.css', 'account_home.css'],
      page_url: 'account_settings.html',
      initial_query_func: function (req, res) {
        if (req.freezrUserDS && req.freezrUserDS.fsParams && req.freezrUserDS.dbParams) {
          req.freezrInternalCallFwd(null, { owner: req.freezrUserDS.owner, fsParamsType: req.freezrUserDS.fsParams.type, dbParamsType: req.freezrUserDS.dbParams.type, slParamsType: req.freezrUserDS.slParams?.type })
        } else {
          req.freezrInternalCallFwd(null, { owner: null, error: 'no user ds found' })
        }
      },
      script_files: ['account_settings.js']
    },
    serverless: {
      page_title: 'Account Services Settings (freezr)',
      css_files: ['./@public/info.freezr.public/public/freezr_style.css', 'account_home.css'],
      page_url: 'account_serverless.html',
      initial_query_func: function (req, res) {
        if (req.freezrUserDS) {
          req.freezrInternalCallFwd(null, {
            slParamsType: req.freezrUserDS.slParams?.type,
            slRegion: req.freezrUserDS.slParams?.region,
            accessKeyId: req.freezrUserDS.slParams?.accessKeyId ? ('***' + req.freezrUserDS.slParams.accessKeyId.slice(-3)) : null,
            secretAccessKey: req.freezrUserDS.slParams?.secretAccessKey ? ('***' + req.freezrUserDS.slParams.secretAccessKey.slice(-3)) : null,
            arnRole: req.freezrUserDS.slParams?.arnRole ? ('***' + req.freezrUserDS.slParams.arnRole.slice(-3)) : null
          })
        } else {
          req.freezrInternalCallFwd(null, { owner: null, error: 'no user ds found' })
        }
      },
      script_files: ['account_serverless.js']
    },
    app: {
      page_title: 'Apps (freezr)' + (' - ' + params.sub_page),
      css_files: ['./@public/info.freezr.public/public/freezr_style.css', 'account_app_management.css'],
      page_url: 'account_app_' + params.sub_page + '.html',
      // initial_query_func: exports.listAllUserApps,
      other_variables: (params.target_app ? ('const targetApp = "' + params.target_app + '";') : '') + ' let transformRecord',
      script_files: ['./@public/info.freezr.public/public/mustache.js'],
      modules: ['account_app_' + params.sub_page + '.js']
    },
    confirmperm: {
      page_title: 'Apps (freezr)' + (' - ' + params.sub_page),
      css_files: ['./@public/info.freezr.public/public/freezr_style.css', 'account_app_management.css'],
      page_url: 'account_confirmperm.html',
      // initial_query_func: exports.listAllUserApps,
      // other_variables: (params.target_app ? ('const targetApp = "' + params.target_app + '"') : ''),
      modules: ['account_confrimperm.js']
    },
    resource_usage: {
      page_title: 'resource usage (freezr)',
      css_files: ['./@public/info.freezr.public/public/freezr_style.css', 'resource_usage.css'],
      page_url: 'account_resource_usage.html',
      script_files: ['account_resource_usage.js', './@public/info.freezr.public/public/mustache.js']
    },
    reauthorise: {
      page_title: 'Apps (freezr)',
      css_files: ['./@public/info.freezr.public/public/freezr_style.css', './@public/info.freezr.public/public/firstSetUp.css'],
      page_url: 'account_reauthorise.html',
      initial_query_func: function (req, res) {
        if (req.freezrUserDS && req.freezrUserDS.owner && req.freezrUserDS.fsParams && req.freezrUserDS.fsParams.type) {
          req.freezrInternalCallFwd(null, { owner: req.freezrUserDS.owner, fsParamsType: req.freezrUserDS.fsParams.type })
        } else {
          req.freezrInternalCallFwd(null, { owner: null, error: 'no user ds found' })
        }
      },
      script_files: ['reauthorise.js']
    },
    reset: {
      page_title: 'Apps (freezr)',
      css_files: ['./@public/info.freezr.public/public/freezr_style.css', './@public/info.freezr.public/public/firstSetUp.css'],
      page_url: 'account_reset.html',
      initial_query_func: function (req, res) {
        if (req.freezrUserDS && req.freezrUserDS.owner && req.freezrUserDS.fsParams && req.freezrUserDS.fsParams.type) {
          req.freezrInternalCallFwd(null, { owner: req.freezrUserDS.owner, fsParamsType: req.freezrUserDS.fsParams.type })
        } else {
          req.freezrInternalCallFwd(null, { owner: null, error: 'no user ds found' })
        }
      },
      script_files: ['reset.js']
    },
    perms: {
      page_title: 'Permissions (freezr)',
      css_files: ['./@public/info.freezr.public/public/freezr_style.css', './@public/info.freezr.public/public/firstSetUp.css'],
      page_url: 'account_perm.html',
      initial_query_func: exports.generatePermissionHTML,
      script_files: ['account_perm.js']
    },
    autoclose: {
      page_title: 'Autoclose tab (freezr)',
      page_url: 'account_autoclose.html',
      script_files: ['account_autoclose.js']
    },
    contacts: {
      page_title: 'CEPS Contacts',
      page_url: 'contacts.html',
      css_files: ['contacts.css'],
      script_files: ['contacts.js']
    }
  }
  return manifests[params.page]
}

// Loggers
const LOG_ERRORS = true
const felog = function (...args) { if (LOG_ERRORS) helpers.warning('account_handler.js', exports.version, ...args) }
const LOG_DEBUGS = false
const fdlog = function (...args) { if (LOG_DEBUGS) console.log(...args) }
