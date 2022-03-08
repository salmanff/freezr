// freezr.info - nodejs system files
// Checks to see if file systems and DBs are available for the first set up
// for fsParams - process.env is checked
// for dbParams - process.env is checked to see if fs exists...
// Currently set up for:
//   - A local mongo server running
// Needs to be checked for:
//   - Openshift (Also affects port and ip address)
//   - Google App Enging (GAE)

/* 2021 todos
  - Do checkDb on each environment available
  - ENV_PARAMS should be pushed to another file
*/

exports.version = '0.0.200'

/* test / debugging parameters
  console.error('FOR DEBUGGING ON LOCALHOST - REMOVE THESE')
  if (!process.env) process.env = {}
  process.env.FREEZR_DB = 'mongodb' // 'nedb'
  process.env.MONGO_STR = ''
  process.env.FREEZR_FS = 'dropbox'
  process.env.FS_TOKEN = '-'
*/

const PARAMS_OAC = {
  owner: 'fradmin',
  app_name: 'info.freezr.admin',
  collection_name: 'params'
}

// const path = require('path')
const fs = require('fs')
const async = require('async')
const helpers = require('../helpers.js')

const fileHandler = require('../file_handler.js')

// DEFAULTS
exports.ENV_PARAMS = {
  FS: {
    local: {
      type: 'local',
      label: "Server's file system",
      msg: 'You are using your local file system.',
      warning: 'Note that most cloud servers delete their local file system when they restart - ie periodically. Make sure you know what you are doing when you choose this option.',
      forPages: ['firstSetUp']
    },
    sysDefault: {
      type: 'system',
      label: 'System Default',
      msg: 'The admin has offered to use the default system settings to store your files.',
      forPages: ['firstSetUp', 'newParams'] // , 'unRegisteredUser' todo - add back and fix
    },
    dropbox: {
      type: 'dropbox',
      label: 'Dropbox',
      msg: 'You can use your dropbox as your file system.',
      warning: '',
      forPages: ['unRegisteredUser', 'newParams'],
      fields: [
        { name: 'accessToken', display: 'Access Token:', optional: true },
        { name: 'code', display: 'Authorization Code:', optional: true },
        { name: 'clientId', display: 'Authenticator Client Id:', optional: true },
        { name: 'refreshToken', display: 'Refresh Token:', optional: true },
        { name: 'codeChallenge', display: 'Code Challenge:', optional: true },
        { name: 'codeVerifier', display: 'Code Verifier:', optional: true },
        { name: 'redirecturi', display: 'redirect Uri:', optional: true }],
      oauth: true
    },
    googleDrive: {
      type: 'googleDrive',
      label: 'Google Drive',
      msg: 'Use your your google drive as your file system. Press authenticate or manage your options below.',
      warning: '',
      forPages: ['unRegisteredUser', 'newParams'],
      fields: [
        { name: 'accessToken', display: 'Access Token:', optional: true },
        { name: 'code', display: 'Authorization Code:', optional: true },
        { name: 'refreshToken', display: 'Refresh Token:', optional: true },
        { name: 'expiry', display: 'Expiry Date:', optional: true },
        { name: 'clientId', display: 'Authenticator Client Id:', optional: true },
        { name: 'secret', display: 'Authenticator Secret:', optional: true },
        { name: 'redirecturi', display: 'redirect Uri:', optional: true }],
      oauth: true
    },
    fdsFairOs: {
      type: 'fdsFairOs',
      label: 'Fairdrive (Ethereum Swarm)',
      msg: 'Use ethereum swarm as your storage, via the Fair Data Society fairdrive gateway. Enter your credentials or create an account <a href="https://app.fairdrive.fairdatasociety.org/register">here</a>.<br><br>',
      warning: '',
      forPages: ['unRegisteredUser', 'newParams'],
      fields: [
        { name: 'fdsGateway', display: 'Gateway url:' },
        { name: 'userName', display: 'Fairdrive username:' },
        { name: 'fdsPass', display: 'Fairdrive password:', type: 'password' },
        { name: 'podname', hide: true, display: 'pod Name:', optional: true, default: 'freezrPod01' },
        { name: 'tempLocalFolder', hide: true, display: 'local temp Folder:', optional: true, default: 'tempfolder' }
      ],
      oauth: false
    },
    aws: {
      type: 'aws',
      label: 'AWS (Amazon)',
      msg: 'You can use Amazon S3 storage as your file system. Please obtain an access token an enter it here.',
      forPages: ['unRegisteredUser', 'newParams'],
      fields: [
        { name: 'accessKeyId', display: 'Access Key Id:' },
        { name: 'secretAccessKey', display: 'Secret Access Key:' },
        { name: 'region', display: 'Region:' }
      ]
    }
  },
  DB: {
    sysDefault: {
      type: 'system',
      label: 'System Default',
      msg: 'The admin has offered to use the default system settings to store your database.',
      forPages: ['firstSetUp', 'newParams']
    },
    nedb: {
      type: 'nedb',
      label: 'Use files as database',
      msg: 'You can use your local file system as a database, with NEDB.',
      warning: 'Note that if you want to store more than a few thousand records, a more enterprise-scale database like mongo may be needed.',
      forPages: ['firstSetUp', 'unRegisteredUser', 'newParams']
    },
    mongoLocal: {
      type: 'mongodb',
      label: 'Local Mongo Server',
      msg: 'You have a local instance of mongo running.',
      forPages: ['firstSetUp', 'newParams'] // Not always true
    },
    mongoString: {
      type: 'mongodb',
      label: 'MongoDB - Connection String',
      msg: 'You can enter a full url of a mongo database. Mongo Atlas provides this for you, or you can set up your own.',
      fields: [{ name: 'mongoString', display: 'Full Mongo URL:' }],
      forPages: ['firstSetUp', 'unRegisteredUser', 'newParams']
    },
    mongoDetails: {
      type: 'mongodb',
      label: 'MongoDB - Full Details',
      msg: 'You can enter the individual parameters of mongodb database. ',
      fields: [
        { name: 'user', display: 'Database User:' },
        { name: 'password', display: 'Database Password:', type: 'password' },
        { name: 'host', display: 'Database Host:' },
        { name: 'port', display: 'Database Port:' },
        { name: 'user', display: 'Database User:' }
      ],
      forPages: ['firstSetUp', 'unRegisteredUser', 'newParams']
    }
  }
}
exports.FS_AUTH_URL = {
  dropbox: function (options) {
    // fdlog('getting auth url for ', { options })
    // need options => codeChallenge, state and clientId
    if (!options.codeChallenge || !options.state || !options.clientId) {
      return null
    } else {
      return 'https://www.dropbox.com/oauth2/authorize?client_id=' + options.clientId + '&redirect_uri=' + encodeURIComponent(options.redirecturi) + '&response_type=code&token_access_type=offline&state=' + options.state + '&code_challenge_method=S256&code_challenge=' + options.codeChallenge
    }
  },
  googleDrive: function (options) {
    // fdlog('getting google auth url for ', { options })
    const { google } = require('googleapis')

    const oauth2Client = new google.auth.OAuth2(
      options.clientId,
      options.secret,
      options.redirecturi
    )

    const scopes = [
      'https://www.googleapis.com/auth/drive'
    ]

    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      code_challenge_method: 'S256',
      prompt: 'consent', // asks for auth again and thus generates refresh_token https://github.com/googleapis/google-api-nodejs-client/issues/750
      code_challenge: options.codeChallenge,
      // next params are redundant - added here for clarity
      response_type: 'code',
      client_id: options.clientId,
      redirect_uri: options.redirecturi
    })

    return url + '&state=' + options.state
  }
}

exports.FS_getRefreshToken = {
  googleDrive: function (options, callback) {
    fdlog('getting google FS_getRefreshToken for ', { options })
    const { google } = require('googleapis')

    const oauth2Client = new google.auth.OAuth2(
      options.clientId,
      options.secret,
      options.redirecturi
    )

    const googOptions = {
      code: options.code,
      codeVerifier: options.codeVerifier,
      // next params are redundant - added here for clarity
      client_id: options.clientId,
      redirect_uri: options.redirecturi
    }

    oauth2Client.getToken(googOptions, (err, token) => {
      fdlog('FS_getRefreshToken return ', { err, token })
      if (err) felog('FS_getRefreshToken return ', err)
      callback(err, token)
    })
  },
  dropbox: function (options, callback) {
    fdlog('FS_getRefreshToken dropbox ', { options })
    const { Dropbox } = require('dropbox')
    const fetch = require('node-fetch')
    const dbx = new Dropbox({ fetch, clientId: options.clientId })

    try {
      dbx.auth.codeChallenge = options.codeChallenge
      dbx.auth.codeVerifier = options.codeVerifier

      return dbx.auth.getAccessTokenFromCode(options.redirecturi, options.code)
        .then(token => {
          fdlog(`got dropbox FS Token Result:${JSON.stringify(token)}`)
          if (token && token.result && token.result) {
            return callback(null, token.result)
          } else {
            return callback(new Error('could not get token for dropbox'))
          }
        })
        .catch(err => {
          felog('FS_getRefreshToken', 'error getting tokens ', err)
          return callback(err)
        })
    } catch (e) {
      felog('FS_getRefreshToken', 'uncaught err in promise , err', e)
      callback(new Error('could not get access token from auth - ' + e.message))
    }
  }
}

exports.checkAndCleanDb = function (dbParams, freezrInitialEnvCopy) {
  // console.log('todo - TO IMPLEMENT checkAndCleanDb ', dbParams)
  if (!dbParams) return null
  if (dbParams.choice === 'sysDefault') {
    return freezrInitialEnvCopy.dbParams
  }
  return dbParams
}
exports.checkAndCleanFs = function (fsParams, freezrInitialEnvCopy) {
  // returns null if invalid for any reason
  fdlog('checkAndCleanDb', { fsParams, freezrInitialEnvCopy }, JSON.stringify(freezrInitialEnvCopy))
  if (!fsParams) return null
  if (!fsParams.choice) fsParams.choice = fsParams.type
  const VALID_FS_CHOICES = ['system', 'sysDefault', 'local', 'dropbox', 'googleDrive', 'fdsFairOs', 'glitch']
  fdlog('checking fs type choice ', { fsParams })
  if (!VALID_FS_CHOICES.includes(fsParams.choice)) felog('checkAndCleanFs', 'error - invalid fs choice ', fsParams)
  if (!fsParams.choice || !VALID_FS_CHOICES.includes(fsParams.choice)) return null
  if (fsParseCreds[fsParams.choice]) {
    fsParams = fsParseCreds[fsParams.choice](fsParams, freezrInitialEnvCopy)
  } else {
    felog('checkAndCleanFs', 'WARNING for developers - it is best to implement checkAndCleanFs for fs choice ' + fsParams.choice)
  }
  fdlog('cleaned and checked params - now are: ', fsParams)
  return fsParams
}
const fsParseCreds = {
  local: function (credentials) {
    fdlog('fsParseCreds credentials', credentials) // isglitch
    if (!credentials) {
      console.warn('fsParseCreds  without any credentials ???????? SNBH')
      credentials = {}
    }
    var final = {
      type: 'local',
      choice: (credentials.choice || 'local'),
      rootFolder: (credentials.rootFolder || 'users_freezr')
    }
    return final
  },
  sysDefault: function (credentials, freezrInitialEnvCopy) {
    return freezrInitialEnvCopy ? freezrInitialEnvCopy.fsParams : { choice: 'system', type: 'system' }
  },
  system: function (credentials) {
    return { choice: 'system', type: 'system' }
  },
  dropbox: function (credentials) {
    var newCreds = {
      choice: 'dropbox',
      type: 'dropbox',
      clientId: credentials.clientId,
      codeChallenge: credentials.codeChallenge,
      codeVerifier: credentials.codeVerifier,
      redirecturi: credentials.redirecturi
    }
    // recheck - do we need codeChallenge, codeVerifier?
    if (credentials.refreshToken) {
      newCreds.refreshToken = credentials.refreshToken
    } else if (credentials.accessToken) {
      newCreds.accessToken = credentials.accessToken
    } else {
      newCreds = null
    }
    return newCreds
  },
  googleDrive: function (credentials) {
    var newCreds = {
      choice: 'googleDrive',
      type: 'googleDrive',
      accessToken: credentials.accessToken,
      clientId: credentials.clientId,
      codeChallenge: credentials.codeChallenge,
      codeVerifier: credentials.codeVerifier,
      redirecturi: credentials.redirecturi,
      expiry: credentials.expiry,
      secret: credentials.secret, // NEEDED??
      code: credentials.code
    }
    felog('does secret need to bne kept?')
    // recheck - do we need codeChallenge, codeVerifier?
    if (credentials.refreshToken) {
      newCreds.refreshToken = credentials.refreshToken
    }
    if (!credentials.accessToken && !credentials.refreshToken) {
      newCreds = null
    }
    return newCreds
  },
  fdsFairOs: function (credentials) {
    if (!credentials.podname) credentials.podname = 'freezrPod01'
    if (!credentials.tempLocalFolder) credentials.tempLocalFolder = 'tempfolder'
    if (helpers.startsWith(credentials.fdsGateway, 'https://')) credentials.fdsGateway = credentials.fdsGateway.substring(0, 8)
    return credentials
  }
}

// TESTS
const DS_MANAGER = require('../ds_manager.js')
exports.checkDB = function (env, options, callback) {
  fdlog('checkdb ', { env, options })
  // options : { okToCheckOnLocal}
  const TEST_OAC = {
    owner: 'test',
    app_name: 'info.freezr.admin',
    collection_name: 'params'
  }
  if (!options) options = {}
  if (!env || !env.dbParams) {
    callback(new Error('No paramters found.'))
  } else if (env.dbParams.type === 'nedb' && !env.fsParams) {
    callback(new Error('Need file sysem parameters to check nedb.'))
  } else if (env.dbParams.type === 'sysDefault') {
    callback(new Error('Cannot check sysatem default settings'))
  } else if (env.dbParams.type === 'nedb' && env.fsParams.type === 'local' && !options.okToCheckOnLocal) {
    callback(new Error('Cannot check on nedb in regular operations.'))
  } else {
    if (!env.fsParams && env.dbParams.type !== 'nedb') env.fsParams = {} // trick to get past setSystemUserDS and test the db
    const tempTestManager = new DS_MANAGER()
    tempTestManager.setSystemUserDS('test', env)
    tempTestManager.initOacDB(TEST_OAC, null, (err, testDB) => {
      if (err) {
        callback(null, false)
      } else {
        testDB.read_by_id('test_write_id', (err2, savedData) => {
          if (err2) {
            felog('checkDB', 'got err in checkDB - testDb 1 ', err2)
            callback(null, { checkpassed: false, resource: 'DB' })
          } else if (savedData) {
            fdlog({ tempTestManager })
            testDB.update('test_write_id', { foo: 'updated bar' }, { replaceAllFields: false }, (err2, results) => {
              if (err2) felog('checkDB', 'got err in checkDB - testDb 2 ', err2)
              callback(null, { checkpassed: (!err2), resource: 'DB' })
            })
          } else {
            testDB.create('test_write_id', { foo: 'bar' }, null, (err3, results) => {
              if (err) felog('checkDB', 'got err in checkDB - testDb 3 ', err3)
              callback(null, { checkpassed: (!err2), resource: 'DB' })
            })
          }
        })
      }
    })
  }
}
exports.checkFS = function (env, options, callback) {
  const tempTestManager = new DS_MANAGER()
  if (!env.dbParams) env.dbParams = {}

  fdlog('checkFS env ', env)
  fdlog('checkFS options ', options)
  // onsole.log('checkFS  ', { env, options })

  if (!env || !env.fsParams) {
    callback(new Error('No paramters found.'))
  } else if (env.fsParams.type === 'sysDefault') {
    callback(new Error('Cannot check sysatem default settings'))
  } else if (options && options.getRefreshToken) {
    tempTestManager.setSystemUserDS('test', env)
    tempTestManager.initUserAppFSToGetCredentials('test', 'info.freezr.admin', options, (err, creds) => {
      if (creds) {
        fdlog('checkFS a2', creds)
        callback(err, creds)
      } else {
        callback((err || new Error('could not get filesystem credentials in checkFS')))
      }
    })
  } else {
    tempTestManager.setSystemUserDS('test', env)
    tempTestManager.getOrInitUserAppFS('test', 'info.freezr.admin', options, (err, userAppFS) => {
      if (err) {
        var toSend = { checkpassed: false, resource: 'FS' }
        if (options && options.getRefreshToken && userAppFS && userAppFS.credentials) toSend.refreshToken = userAppFS.credentials.refreshToken
        callback(err, toSend)
      } else {
        // fdlog('userAppFS tested userAppFS.credentials', userAppFS.credentials)
        var returns = { checkpassed: false, resource: 'FS' }
        if (options && options.getRefreshToken && userAppFS.credentials) returns.refreshToken = userAppFS.credentials.refreshToken
        const TEST_TEXT = 'Testing write via dsManager on server !!'
        userAppFS.writeToUserFiles('test_write.txt', TEST_TEXT, { doNotOverWrite: false, nocache: true }, function (err, ret) {
          if (err) {
            felog('checkFS', 'failure to write to NEW user folder - ' + userAppFS.owner + ' - ' + userAppFS.appName + ' -err : ' + err)
            callback(err, returns)
          } else {
            userAppFS.readUserFile('test_write.txt', { nocache: true }, (err2, filecontent) => {
              fdlog('read file too ', filecontent)
              if (!err && filecontent !== TEST_TEXT) {
                felog('checkFS', 'text inconsistency error snbh :' + filecontent + '')
              } else if (!err) {
                returns.checkpassed = true
              }
              options = options || {}
              const userId = options.userId || 'test'
              userAppFS.fs.mkdirp(((userAppFS.fsParams.rootFolder || helpers.FREEZR_USER_FILES_DIR) + '/' + userId + '/db'), function (err) {
                fdlog('Made directory : ', (userAppFS.fsParams.rootFolder || helpers.FREEZR_USER_FILES_DIR) + '/' + userAppFS.owner + '/db')
                if (err) {
                  callback(err)
                } else {
                  callback(err, returns)
                }
              })
            })
          }
        })
      }
    })
  }
}
const checkDbAndGetEnvIfExists = function (tempParams, callback) {
  exports.checkDB(tempParams, { okToCheckOnLocal: true }, (err, dbWorks) => {
    if (err || !dbWorks) {
      felog('checkDbAndGetEnvIfExists', 'COULD NOT USE NEDB FILE SYSTEM FOR DB - REVIEW CODE', { err, dbWorks, tempParams })
      callback(err, dbWorks, null)
    } else {
      const tempTestManager = new DS_MANAGER()
      tempTestManager.setSystemUserDS('fradmin', tempParams)
      tempTestManager.initOacDB(PARAMS_OAC, null, (err, fradminDb) => {
        if (err) {
          felog('checkDbAndGetEnvIfExists', 'SNBH - DB should be working above')
          callback(err, false, null)
        } else {
          fradminDb.read_by_id('freezr_environment', (err, envOnDb) => {
            callback(err, dbWorks, envOnDb)
          })
        }
      })
    }
  })
}

// STARTUP
exports.tryGettingEnvFromautoConfig = function (callback) {
  var r = { autoConfig: null, envOnFile: null, params: {}, environments_match: null }

  var tempDsManager = new DS_MANAGER()

  async.waterfall([
    function (cb) {
      // 0 Read freezr_environment from file and use that if it exists - if not read ther autoConfig
      r.envOnFile = fileHandler.getEnvParamsFromLocalFileSystem()
      if (!r.envOnFile) {
        getAutoConfigParams(cb)
      } else {
        cb(null, null)
      }
    },
    // 1 if envOnFile doesnt exist, use autogonfigs to create a temporary ds_manager and read the file on the fs
    function (autoConfig, cb) {
      r.autoConfig = autoConfig
      if ((!r.envOnFile || !r.envOnFile.freezrIsSetup /* in case a temp file had been written */) && autoConfig && autoConfig.fsParams) {
        // note tempting to also add && autoConfig.fsParams.type!='local' but then glitch wouldnt work
        tempDsManager.setSystemUserDS('fradmin', { fsParams: autoConfig.fsParams, dbParams: {} })
        tempDsManager.getOrInitUserAppFS('fradmin', 'info.freezr.admin', null, function (err, oacFs) {
          if (err) {
            felog('tryGettingEnvFromautoConfig', { err })
            cb(null)
          } else {
            oacFs.readUserFile('freezr_environment.js', null, (err, envFromAutoConfigFileSys) => {
              fdlog({ envFromAutoConfigFileSys }) // nn
              // console.log(' todo todonow - if error is not file not found, then should throw error - security')
              if (err) {
                cb(null)
              } else {
                if (envFromAutoConfigFileSys) {
                  fdlog('1b -  tryGettingEnvFromautoConfig - using file from env from autoConfig fs')
                  if (helpers.startsWith(envFromAutoConfigFileSys, 'exports.params=')) envFromAutoConfigFileSys = envFromAutoConfigFileSys.slice('exports.params='.length)
                  try {
                    envFromAutoConfigFileSys = JSON.parse(envFromAutoConfigFileSys)
                    r.envOnFile = envFromAutoConfigFileSys
                    cb(null)
                  } catch (e) {
                    felog('error parsing envFromAutoConfigFileSys to get initial environment')
                    cb(e)
                  }
                } else {
                  cb(null)
                }
              }
            })
          }
        })
      } else {
        cb(null)
      }
    },

    // Get params from the db
    function (cb) {
      const fsParams = (r.envOnFile && r.envOnFile.fsParams) ? r.envOnFile.fsParams : r.autoConfig.fsParams
      const dbParams = (r.envOnFile && r.envOnFile.dbParams) ? r.envOnFile.dbParams : r.autoConfig.dbParams
      fdlog('using autoconfig dbparmams is', dbParams)
      fdlog('using autoconfig fsParams is', fsParams)
      const fradminOwner = tempDsManager.setSystemUserDS('fradmin', { fsParams, dbParams })
      fradminOwner.initOacDB(PARAMS_OAC, null, cb)
    },
    function (fradminDb, cb) {
      fradminDb.read_by_id('freezr_environment', cb)
    },
    function (envOnDb, cb) {
      fdlog('r.envOnFile ', r.envOnFile)
      fdlog('envOnDb ', envOnDb)
      if (r.envOnFile && r.envOnFile.freezrIsSetup) { // if there was an env on file, use that
        if (!envOnDb) {
          felog('tryGettingEnvFromautoConfig', '2 - WARNING -  freezr_environment is NOT stored on DB')
        } else if (!helpers.variables_are_similar(r.envOnFile, envOnDb)) {
          felog('tryGettingEnvFromautoConfig', 'STARTUP MISMATCH - freezr_environment on server different from one on db')
          r.environments_match = false
        } else {
          r.environments_match = true
        }
      } else if (envOnDb) { // other wise use the environment from the db
        r.envOnFile = envOnDb
      } else { // use the autocnfig as a temporary
        r.envOnFile = r.autoConfig
        r.envOnFile.freezrIsSetup = false
        r.envOnFile.firstUser = null
        fdlog('tryGettingEnvFromautoConfig - freezr NOT Set Up')
      }
      cb(null)
    }
  ], function (err) {
    fdlog('end of startup waterfall envOnFile', r.envOnFile)
    callback(err, r)
  })
}
const getAutoConfigParams = function (callback) {
  var autoConfig = {
    ipaddress: autoIpAddress(),
    port: autoPort(),
    dbParams: null, // {oneDb , addAuth}
    fsParams: fsParams() //
  }
  autoDbParams((err, params) => {
    autoConfig.dbParams = params.main
    autoConfig.otherDBs = params.other
    callback(err, autoConfig)
  })
}
var autoIpAddress = function () {
  if (process && process.env && process.env.DATABASE_SERVICE_NAME && process.env.OPENSHIFT_NODEJS_IP) {
    return process.env.OPENSHIFT_NODEJS_IP // openshift v3
  } /* add other platforms here */ else {
    return null
  }
}
var autoPort = function () {
  if (process && process.env && process.env.DATABASE_SERVICE_NAME) {
    return 8080 // openshift v3
  } else if (process && process.env && process.env.PORT) { // aws
    // onsole.log("auto port exists (AWS & other..)",    process.env.PORT)
    return process.env.PORT
  } /* add other platforms here */ else {
    return 3000
  }
}
var autoDbParams = function (callback) {
  let foundDbParams = {}
  let haveWorkingDb = false
  let otherOptions = {
    MONGO_EXTERNAL: {
      vars_exist: false,
      functioning: false,
      env_on_db: false,
      params: null
    },
    MONGO_OPENSHIFT: {
      vars_exist: false,
      functioning: false,
      env_on_db: false,
      params: null
    },
    MONGO_LOCAL: {
      functioning: false,
      env_on_db: false,
      params: null
    },
    NEDB_LOCAL: {
      functioning: false,
      env_on_db: false,
      params: null
    },
    GAE: {
      functioning: false,
      env_on_db: false,
      gaeApiRunning: false,
      gaeProjectId: (process && process.env) ? process.env.GOOGLE_CLOUD_PROJECT : null,
      params: {}
    }
  }

  if (process && process.env && process.env.FREEZR_DB && process.env.FREEZR_DB.toLowerCase() === 'nedb') {
    foundDbParams = {
      type: 'nedb'
    }
  }

  async.waterfall([
    // 1 MONGO_EXTERNAL check for environment variables being set at process.env for mongo
    function (cb) {
      if (process && process.env && process.env.FREEZR_DB && process.env.FREEZR_DB.toLowerCase() === 'mongodb' &&
        process.env.DB_HOST && process.env.DB_PASS && process.env.DB_USER) {
        // manually set env variables for mongo
        otherOptions.MONGO_EXTERNAL.vars_exist = true
        otherOptions.MONGO_EXTERNAL.params = {
          type: process.env.FREEZR_DB.toLowerCase(), // should be Mondodb
          choice: 'mongoDetails',
          user: process.env.DB_USER,
          pass: process.env.DB_PASS,
          host: process.env.DB_HOST,
          port: process.env.DB_PORT,
          addAuth: (process.env.ADD_AUTH || false),
          oneDb: (!(process.env.ONE_DB && process.env.ONE_DB === false)), // "false"?? to check
          unifiedDbName: process.env.UNIFIED_DB_NAME || 'sampledb'
        }
        if (!haveWorkingDb) foundDbParams = otherOptions.MONGO_EXTERNAL.params
        haveWorkingDb = true
        cb(null)
      } else if (process && process.env && process.env && process.env.FREEZR_DB && process.env.FREEZR_DB.toLowerCase() === 'mongodb' && process.env.MONGO_STR) {
        otherOptions.MONGO_EXTERNAL.vars_exist = true
        otherOptions.MONGO_EXTERNAL.params = {
          type: 'mongodb',
          choice: 'mongoDetails',
          connectionString: process.env.MONGO_STR,
          mongoString: process.env.MONGO_STR // temp todo - fix
        }
        if (!haveWorkingDb) foundDbParams = otherOptions.MONGO_EXTERNAL.params
        haveWorkingDb = true
        cb(null)
      } else {
        cb(null)
      }
    },
    // 2. MONGO_REDHAT
    function (cb) {
      if (process && process.env && // Redhat openshift v3
        // from https://github.com/openshift/nodejs-ex/blob/master/server.js
        process.env.DATABASE_SERVICE_NAME &&
        process.env.MONGODB_USER &&
        process.env.MONGODB_PASSWORD) {
        var mongoServiceName = process.env.DATABASE_SERVICE_NAME.toUpperCase()
        otherOptions.MONGO_OPENSHIFT.vars_exist = true
        otherOptions.MONGO_OPENSHIFT.params = {
          type: 'mongodb',
          choice: 'mongoRedHat',
          user: process.env.MONGODB_USER,
          pass: process.env.MONGODB_PASSWORD,
          host: process.env[mongoServiceName + '_SERVICE_HOST'],
          port: process.env[mongoServiceName + '_SERVICE_PORT'],
          addAuth: false,
          oneDb: true,
          unifiedDbName: 'freezrdb'
        }
        cb(null)
      } else { cb(null) }
    },
    // 3. GAE
    function (cb) {
      // let isGaeServer = (process && process.env && process.env.GOOGLE_CLOUD_PROJECT)
      let ds
      try {
        const { Datastore } = require('@google-cloud/datastore')
        ds = new Datastore()
        otherOptions.GAE.gaeApiRunning = true
      } catch (e) {
        // no GAE API
      }
      // To use GAE datastore without running the GAE server, place the keyfile under environment, and name it gaeDatastoreKeyfile.json
      if (otherOptions.GAE.gaeApiRunning) {
        otherOptions.GAE.params.type = 'gaeCloudDatastore'
        otherOptions.GAE.params.choice = 'gaeCloudDatastore'
        try {
          let keyfile = fs.readFileSync('./freezr_system/environment/gaeDatastoreKeyfile.json')
          keyfile = JSON.parse(keyfile)
          if (keyfile) {
            otherOptions.GAE.params.gaeProjectId = keyfile.project_id
            otherOptions.GAE.params.gaeKeyFile = true
          }
        } catch (e) {
          fdlog('autoDbParams', 'could not get GAE ds ', ds)
          // No GAE filekey
        }
      }
      /* to review and redo?
      if ( otherOptions.GAE.gaeApiRunning && (otherOptions.GAE.gaeKeyFile || isGaeServer)) {    // Google App Engine
        db_handler.re_init_environment_sync({dbParams:otherOptions.GAE.params})
        db_handler.check_db({dbParams:otherOptions.GAE.params}, (err,env_on_db)=>{
            if (!err) {
              if (env_on_db) otherOptions.GAE.env_on_db=env_on_db
              otherOptions.GAE.functioning = true;
              if (!haveWorkingDb) foundDbParams = otherOptions.GAE.params
              haveWorkingDb=true;
            }
            cb(null)
        })
      } else {cb(null)}
      */
      cb(null)
    },

    // 4. MONGO_LOCAL
    function (cb) {
      otherOptions.MONGO_LOCAL.params = { // default local
        type: 'mongodb',
        user: null,
        pass: null,
        host: 'localhost',
        port: '27017',
        addAuth: false,
        oneDb: false
      }
      /* to review and redo?
      db_handler.re_init_environment_sync({dbParams:otherOptions.MONGO_LOCAL.params, startuptest:true})
      db_handler.check_db({dbParams:otherOptions.MONGO_LOCAL.params, startuptest:true}, (err,env_on_db)=>{
          if (!err) {
            if (env_on_db) otherOptions.MONGO_LOCAL.env_on_db=env_on_db
            otherOptions.MONGO_LOCAL.functioning = true;
            if (!haveWorkingDb) foundDbParams = otherOptions.MONGO_LOCAL.params
            haveWorkingDb=true;
          } else {
            felog("GOT ERR FOR MONGO_LOCAL")
          }
          cb(null)
      })
      */
      cb(null)
    },

    // 5. NEDB
    function (cb) {
      otherOptions.NEDB_LOCAL.params = { // default local
        type: 'nedb'
      }
      const tempParams = {
        fsParams: fsParams(),
        port: autoPort(),
        ipaddress: autoIpAddress(),
        dbParams: otherOptions.NEDB_LOCAL.params
      }
      checkDbAndGetEnvIfExists(tempParams, (err, dbWorks, envOnDb) => {
        fdlog('checkDbAndGetEnvIfExists ', { err, dbWorks, envOnDb })
        otherOptions.NEDB_LOCAL = {
          functioning: dbWorks,
          params: tempParams.dbParams
        }
        if (dbWorks && envOnDb) otherOptions.NEDB_LOCAL.env_on_db = envOnDb
        if (!haveWorkingDb) foundDbParams = otherOptions.NEDB_LOCAL.params
        haveWorkingDb = true
        cb(null)
      })
    },
    // 6. OTHER - ADD
    function (cb) {
      cb(null)
    }],
  function (err) {
    fdlog('AUTO DB Options ', otherOptions, 'Current DB (foundDbParams):', foundDbParams)
    if (err) felog('autoDbParams', err)
    otherOptions = JSON.parse(JSON.stringify(otherOptions))
    callback(null, { main: foundDbParams, other: otherOptions })
  })
}
var fsParams = function () {
  if (process && process.env && process.env.FREEZR_FS && process.env.FREEZR_FS === 'dropbox') {
    return {
      type: process.env.FREEZR_FS,
      accessToken: process.env.FS_TOKEN,
      refreshToken: process.env.FS_REFRESH_TOKEN,
      clientId: process.env.FS_CLIENTID,
      redirecturi: process.env.FS_REDIR,
      codeChallenge: process.env.FS_C_CHALL,
      codeVerifier: process.env.FS_C_VER
    }
  } else if (isGlitch()) {
    return {
      type: 'local',
      choice: 'glitch',
      rootFolder: GLITCH_USER_ROOT
    }
  } else {
    return {
      type: 'local',
      userRoot: null
    }
  }
}
function isGlitch () {
  return (process && process.env && process.env.API_SERVER_EXTERNAL && process.env.API_SERVER_EXTERNAL.indexOf('glitch') > 0)
}
const GLITCH_USER_ROOT = '.data/users_freezr'

// Loggers
const LOG_ERRORS = true
const felog = function (...args) { if (LOG_ERRORS) helpers.warning('environment_defaults.js', exports.version, ...args) }
const LOG_DEBUGS = false
const fdlog = function (...args) { if (LOG_DEBUGS) console.log(...args) }
