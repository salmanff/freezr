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

const PARAMS_OAC = {
  owner: 'fradmin',
  app_name: 'info.freezr.admin',
  collection_name: 'params'
}

// const path = require('path')
const fs = require('fs')
const async = require('async')
// const path = require('path')
const helpers = require('../helpers.js')

const fileHandler = require('../file_handler.js')

// DEFAULTS
exports.ENV_PARAMS = {
  FS: {
    // local: {
    //   type: 'local',
    //   label: "Server's file system",
    //   msg: 'You are using your local file system.',
    //   warning: 'Note that most cloud servers delete their local file system when they restart - ie periodically. Make sure you know what you are doing when you choose this option.',
    //   forPages: []
    // },
    sysDefault: {
      type: 'local',
      label: 'Host Server Storage',
      msg: 'The admin has offered to use the default system settings to store your files.',
      forPages: ['firstSetUp', 'newParams', 'unRegisteredUser']
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
    // fdsFairOs: {
    //   type: 'fdsFairOs',
    //   label: 'Fairdrive (Ethereum Swarm)',
    //   msg: 'Use ethereum swarm as your storage, via the Fair Data Society fairdrive gateway. Enter your credentials or create an account <a href="https://app.fairdrive.fairdatasociety.org/register">here</a>.<br><br>',
    //   warning: '',
    //   forPages: ['unRegisteredUser', 'newParams'],
    //   fields: [
    //     { name: 'fdsGateway', display: 'Gateway url:' },
    //     { name: 'userName', display: 'Fairdrive username:' },
    //     { name: 'fdsPass', display: 'Fairdrive password:', type: 'password' },
    //     { name: 'podname', hide: true, display: 'pod Name:', optional: true, default: 'freezrPod01' },
    //     { name: 'tempLocalFolder', hide: true, display: 'local temp Folder:', optional: true, default: 'tempfolder' }
    //   ],
    //   oauth: false
    // },
    aws: {
      type: 'aws',
      label: 'AWS (Amazon)',
      msg: 'You can use Amazon S3 storage as your file system. Please obtain an access token an enter it here. (If you already have a bucket enter it below, or make sure the token has rights to create one.',
      forPages: ['unRegisteredUser', 'newParams'],
      fields: [
        { name: 'accessKeyId', display: 'Access Key Id:' },
        { name: 'secretAccessKey', display: 'Secret Access Key:' },
        { name: 'region', display: 'Region:' },
        { name: 'bucket', display: 'Bucket Name:', optional: true }
      ]
    },
    azure: {
      type: 'azure',
      label: 'Azure (Microsoft)',
      msg: "You can use Microsoft's Azure as storage for your file system. Storage Account Name is mandatory. If this Server is NOT running on the same Azure backend, you will need to enter conenction strings.",
      forPages: ['unRegisteredUser', 'newParams'],
      fields: [
        { name: 'storageAccountName', display: 'Storage Account Name:', optional: false },
        { name: 'msConnectioNString', display: 'Connection String:', optional: true },
        { name: 'secretAccessKey', display: 'Secret Access Key:', optional: true },
        { name: 'containerName', display: 'Container Name:', optional: true }
      ]
    }
  },
  DB: {
    sysDefault: {
      type: 'system',
      label: 'Host Database System',
      msg: 'The admin has offered to use the default system settings to store your database.',
      forPages: ['firstSetUp', 'newParams', 'unRegisteredUser']
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
      fields: [{ name: 'connectionString', display: 'Full Mongo URL:' }, { name: 'unifiedDbName', display: 'DB Name to use:' }],
      forPages: ['firstSetUp', 'unRegisteredUser', 'newParams']
    },
    cosmosForMongoString: {
      type: 'mongodb',
      label: 'MS Azure Cosmos DB for MongoDB',
      msg: 'You can enter a full connection string provided by Azure.',
      fields: [{ name: 'connectionString', display: 'Full Connection String:' }, { name: 'unifiedDbName', display: 'DB Name to use:' }],
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
        { name: 'user', display: 'Database User:' },
        { name: 'unifiedDbName', display: 'DB Name to use:' }
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
    // mod.cjs temporary solution from https://stackoverflow.com/questions/57169793/error-err-require-esm-how-to-use-es6-modules-in-node-12 and https://stackoverflow.com/questions/69041454/error-require-of-es-modules-is-not-supported-when-importing-node-fetch
    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args))
    // const fetch = require('node-fetch') //
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
  if (fsParams.choice === 'sysDefault') return { type: 'system', choice: 'sysDefault' }
  return dbParams
}
exports.checkAndCleanFs = function (fsParams, freezrInitialEnvCopy) {
  // returns null if invalid for any reason
  fdlog('checkAndCleanDb', { fsParams, freezrInitialEnvCopy }, JSON.stringify(freezrInitialEnvCopy))
  if (!fsParams) return null
  if (!fsParams.choice) fsParams.choice = fsParams.type
  if (fsParams.choice === 'sysDefault') return { type: 'system', choice: 'sysDefault' }
  const VALID_FS_CHOICES = ['system', 'sysDefault', 'local', 'dropbox', 'googleDrive', 'aws', 'azure'] // 'fdsFairOs', , 'glitch'
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
    const final = {
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
    let newCreds = {
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
    let newCreds = {
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
        try {
          testDB.read_by_id('test_write_id', (err2, savedData) => {
            if (err2) {
              felog('checkDB', 'got err in checkDB - testDb 1 ', err2)
              callback(null, { checkpassed: false, resource: 'DB', err: err2.message  })
            } else if (savedData) {
              testDB.update('test_write_id', { foo: 'updated bar' }, { replaceAllFields: false }, (err2, results) => {
                if (err2) felog('checkDB', 'got err in checkDB - testDb 2 ', err2)
                callback(err2, { checkpassed: (!err2), resource: 'DB', err: err2?.message })
              })
            } else {
              testDB.create('test_write_id', { foo: 'first bar' }, null, (err3, results) => {
                if (err3) felog('checkDB', 'got err in checkDB - testDb 3 ', err3)
                callback(err3, { checkpassed: (!err2), resource: 'DB', err: err3?.message })
              })
            }
          })
        } catch (e) {
          callback(e, { checkpassed: false, resource: 'DB', err: e?.message })
        }
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

  const returns = { checkpassed: false, resource: 'FS' }
  let userAppFS = null

  const TEST_FILE_NAME = 'test_write'
  const TEST_TEXT_1 = 'Testing write via dsManager on server !!'

  const userId = 'test' // options?.userId
  const appName = 'info.freezr.test.' + helpers.randomText(5)

  fdlog({ tempTestManager })

  let userRootFolder

  let currentTest = 'start'
  const warnings = []

  async.waterfall([
    // stat, rename, unlink… and also redo write second file(s) and get directory content and then  removefolder… and reset dir content..
    // start - get userAppFs
    function (cb) {
      if (!env || !env.fsParams) {
        cb(new Error('No paramters found.'))
      } else if (env.fsParams.type === 'sysDefault') {
        cb(new Error('Cannot check sysatem default settings'))
      } else if (options && options.getRefreshToken) {
        currentTest = 'setcredentials-getrefreshToken'
        tempTestManager.setSystemUserDS(userId, env)
        tempTestManager.initUserAppFSToGetCredentials(userId, appName, options, (err, creds) => {
          if (err) {
            cb(err)
          } else if (creds) {
            cb(new Error('Aborting waterfall - no err'), creds)
          } else {
            callback(new Error('could not get filesystem credentials in checkFS'))
          }
        })
      } else {
        currentTest = 'setcredentials'
        tempTestManager.setSystemUserDS(userId, env)
        tempTestManager.getOrInitUserAppFS(userId, appName, options, cb)
      }
    },
    function (goUserAppFS, cb) {
      userAppFS = goUserAppFS
      userRootFolder = (userAppFS.fsParams?.rootFolder || helpers.FREEZR_USER_FILES_DIR) + '/' + userId + '/' + 'files/' + appName + '/'
      if (options && options.getRefreshToken && userAppFS.credentials) returns.refreshToken = userAppFS.credentials.refreshToken
      cb(null)
    },

    // wrtie file and read file
    function (cb) {
      currentTest = 'writeToUserFiles'
      userAppFS.writeToUserFiles(TEST_FILE_NAME + '.txt', TEST_TEXT_1, { doNotOverWrite: false, nocache: true }, cb)
    },
    function (ret, cb) {
      currentTest = 'readUserFile'
      userAppFS.readUserFile(TEST_FILE_NAME + '.txt', { nocache: true }, cb)
    },
    function (filecontent, cb) {
      if (filecontent !== TEST_TEXT_1) {
        felog('checkFS', 'text inconsistency error:' + filecontent + '')
        cb(new Error('text inconsistency error:' + filecontent + ''))
      } else {
        cb(null)
      }
    },

    // ispresent
    function (cb) {
      currentTest = 'isPresent'
      userAppFS.fs.isPresent(userRootFolder + TEST_FILE_NAME + '.txt', cb)
    },
    function (ret, cb) {
      if (!ret) {
        cb(new Error('aaaa file not present after write'))
      } else {
        cb(null)
      }
    },

    // serve file
    function (cb) {
      currentTest = 'getFileToSend'
      userAppFS.fs.getFileToSend(userRootFolder + TEST_FILE_NAME + '.txt', { nocache: true }, cb)
    },
    function (filecontent, cb) {
      if (!filecontent) {
        felog('checkFS', 'Could not get file in getFileToSend ')
        cb(new Error('Could not get file in getFileToSend'))
      } else if (!filecontent.toString || filecontent?.toString() !== TEST_TEXT_1) {
        felog('checkFS', 'text inconsistency error in getFileToSend :' + filecontent + '')
        console.warn('text inconsistency error in getFileToSend :', { filecontent })
        warnings.push('getFileTestInconsistency')
        cb(null)
      } else {
        cb(null)
      }
    },

    function (cb) {
      currentTest = 'stat'
      userAppFS.fs.stat(userRootFolder + TEST_FILE_NAME + '.txt', cb)
    },
    function (stat, cb) {
      // onsole.log('got stats ', {stat})
      if (!stat) {
        cb(new Error('file not present after write'))
      } else {
        if (!stat.size) warnings.push('fileSize')
        if (!stat.mtimeMs) warnings.push('mtimeMs')
        cb(null)
      }
    },

    function (cb) {
      // onsole.log('got stats ', {stat})
      userAppFS.fs.size(userRootFolder + TEST_FILE_NAME + '.txt', function (err, size) {
        if (err || !size || size !== 40) warnings.push('fileSize')
        // if (err || !size || size !== 40) console.warn('could not get filesize')
        cb(null)
      })
    },

    // doNotOverWrite and overwrite
    function (cb) {
      currentTest = 'writeToUserFiles-doNotOverWrite'
      userAppFS.writeToUserFiles(TEST_FILE_NAME + '.txt', TEST_TEXT_1 + ' -  0', { doNotOverWrite: true, nocache: true }, function (err, ret) {
        if (err) {
          cb(null)
        } else {
          cb(new Error('should not have been able to write file'))
        }
      })
    },
    function (cb) {
      currentTest = 'writeToUserFiles-overwrite'
      userAppFS.writeToUserFiles(TEST_FILE_NAME + '.txt', TEST_TEXT_1 + ' - 2', { doNotOverWrite: false, nocache: true }, cb)
    },
    function (ret, cb) {
      userAppFS.readUserFile(TEST_FILE_NAME + '.txt', { nocache: true }, cb)
    },
    function (filecontent, cb) {
      if (filecontent !== TEST_TEXT_1 + ' - 2') {
        felog('checkFS', 'text inconsistency error snbh :' + filecontent + '')
        cb(new Error('text inconsistency error snbh :' + filecontent + ''))
      } else {
        cb(null)
      }
    },

    function (cb) {
      currentTest = 'unlink'
      userAppFS.fs.unlink(userRootFolder + TEST_FILE_NAME + '.txt', cb)
    },
    function (cb) {
      userAppFS.fs.isPresent(userRootFolder + TEST_FILE_NAME + '.txt', cb)
    },
    function (ret, cb) {
      if (ret) {
        cb(new Error('rrr file  present after delete'))
      } else {
        cb(null)
      }
    },
    function (cb) {
      currentTest = 'mkdirp'
      userAppFS.fs.mkdirp(userRootFolder + 'testFolder', cb)
    },
    function (ret, cb) {
      currentTest = 'writeInDir'
      userAppFS.writeToUserFiles('testFolder/' + TEST_FILE_NAME + '_01.txt', TEST_TEXT_1, { doNotOverWrite: false, nocache: true }, cb)
    },
    function (ret, cb) {
      userAppFS.writeToUserFiles('testFolder/' + TEST_FILE_NAME + '_02.txt', TEST_TEXT_1, { doNotOverWrite: false, nocache: true }, cb)
    },
    function (ret, cb) {
      userAppFS.writeToUserFiles('testFolder/' + TEST_FILE_NAME + '_03.txt', TEST_TEXT_1, { doNotOverWrite: false, nocache: true }, cb)
    },
    function (ret, cb) {
      userAppFS.fs.readdir(userRootFolder + 'testFolder', { maxPageSize: 2 }, cb)
    },
    function (ret, cb) {
      if (!ret || ret.length !== 3) {
        cb(new Error('Could not read files in the folder'))
      } else {
        currentTest = 'size'
        userAppFS.fs.size(userRootFolder + 'testFolder', cb)
      }
    },
    function (size, cb) {
      // onsole.log('got size ', size)
      // if (!size || size !== 120) console.warn('size error - expecting 120 and got ' + size)
      if (!size || size !== 120) warnings.push('folderSize')
      cb(null)
    },
    function (cb) {
      currentTest = 'removeFolder'
      userAppFS.fs.removeFolder(userRootFolder.slice(0, userRootFolder.length - 1), cb)
    },
    function (cb) {
      userAppFS.fs.readdir(userRootFolder + 'testFolder', { maxPageSize: 2 }, function (err, entries) {
        // nb default behavious shoukd be to not give an error if a directory exists, and directories do not exist in aws azure...
        if (!err || err.code === 'ENOENT' || err?.message?.indexOf('no such file or directory') > -1) {
          cb(null)
        } else {
          cb(err)
        }
      })
    }
  ], function (err, creds) {
    if (err && err.message === 'Aborting waterfall - no err' && creds) {
      callback(null, creds)
    } else if (err) {
      console.warn('check fs waterfall err', { currentTest, err: (err?.code || err?.message), msg: err?.message })
      const toSend = { checkpassed: false, resource: 'FS', err, failedtest: currentTest, warnings }
      if (options && options.getRefreshToken && userAppFS && userAppFS.credentials) toSend.refreshToken = userAppFS.credentials.refreshToken
      callback(err, toSend)
    } else {
      returns.checkpassed = true
      if (warnings.length > 0) returns.warnings = warnings
      callback(null, returns)
    }
  })
}

const checkDbAndGetEnvIfExists = function (tempParams, callback) {
  exports.checkDB(tempParams, { okToCheckOnLocal: true }, (err, dbWorks) => {
    if (err || !dbWorks) {
      console.warn('checkDbAndGetEnvIfExists 1 err', { dbWorks, code: err?.code, message: err?.message, statusCode: err?.statusCode })
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
exports.tryGettingEnvFromautoConfig = function (options, callback) {
  const r = { autoConfig: null, envOnFile: null, params: {}, environments_match: null }
  const { freezrPrefs } = options 

  const tempDsManager = new DS_MANAGER()

  async.waterfall([
    function (cb) {
      fdlog(' tryGettingEnvFromautoConfig 1ab ')
      // 0 Read freezr_environment from file and use that if it exists - if not read ther autoConfig
      r.envOnFile = fileHandler.getEnvParamsFromLocalFileSystem()

      if (!r.envOnFile) {
        console.log('tryGettingEnvFromautoConfig - no env on file getting auto config params')
        getAutoConfigParams(cb)
      } else {
        console.log('tryGettingEnvFromautoConfig - USING env on local file getting auto config params')
        cb(null, r.envOnFile)
      }
    },
    // 1 if envOnFile doesnt exist, use autogonfigs to create a temporary ds_manager and read the file on the fs
    function (autoConfig, cb) {
      fdlog(' tryGettingEnvFromautoConfig 1b ', { autoConfig })
      r.autoConfig = autoConfig
      if ((!r.envOnFile || !r.envOnFile.freezrIsSetup /* in case a temp file had been written */) && autoConfig && autoConfig.fsParams) {
        // note tempting to also add && autoConfig.fsParams.type!='local' but then glitch wouldnt work

        tempDsManager.setSystemUserDS('fradmin', { fsParams: autoConfig.fsParams, dbParams: {}, freezrPrefs })
        tempDsManager.getOrInitUserAppFS('fradmin', 'info.freezr.admin', null, function (err, oacFs) {
          if (err) {
            felog('tryGettingEnvFromautoConfig', { err })
            cb(null)
          } else {
            oacFs.readUserFile('freezr_environment.js', null, (err, envFromAutoConfigFileSys) => {
              fdlog({ envFromAutoConfigFileSys })
              // console.log(' todo  - if error is not file not found, then should throw error - security')
              if (err) {
                cb(null)
              } else {
                if (envFromAutoConfigFileSys) {
                  console.log('Using env from freezr_environment.js')
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
      const fradminOwner = tempDsManager.setSystemUserDS('fradmin', { fsParams, dbParams, freezrPrefs })
      fradminOwner.initOacDB(PARAMS_OAC, null, cb)
    },
    function (fradminDb, cb) {
      fradminDb.read_by_id('freezr_environment', cb)
    },
    function (envOnDb, cb) {
      console.log({ fs: envOnDb?.fsParams?.type, db: envOnDb?.dbParams?.type })
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
    if (err)console.warn({ err: err?.code, msg: err?.message, fsType: r.envOnFile?.fsParams?.type, dbType: r.envOnFile?.dbParams?.type })
    fdlog('end of startup waterfall envOnFile FS: ', r.envOnFile?.fsParams?.type + ' - DB: ' + r.envOnFile?.dbParams?.type)
    console.log('end of startup waterfall envOnFile FS: ', r.envOnFile?.fsParams?.type + ' - DB: ' + r.envOnFile?.dbParams?.type)
    fdlog('end of startup waterfall envOnFile FS: ', r.envOnFile?.fsParams?.type + ' - DB: ' + r.envOnFile?.dbParams?.type)
    console.log('end of startup waterfall autoConfig FS: ', r.autoConfig?.fsParams?.type + ' - DB: ' + r.autoConfig?.dbParams?.type)
    fdlog('end of startup waterfall envOnFile', r.envOnFile)
    callback(err, r)
  })
}
const getAutoConfigParams = function (callback) {
  const autoConfig = {
    ipaddress: autoIpAddress(),
    port: autoPort(),
    dbParams: null, // { addAuth}
    fsParams: fsParams() //
  }
  autoDbParams((err, params) => {
    autoConfig.dbParams = params.main
    autoConfig.otherDBs = params.other
    callback(err, autoConfig)
  })
}
const autoIpAddress = function () {
  if (process && process.env && process.env.DATABASE_SERVICE_NAME && process.env.OPENSHIFT_NODEJS_IP) {
    return process.env.OPENSHIFT_NODEJS_IP // openshift v3
  } else { /* add other platforms here */
    return null
  }
}
const autoPort = function () {
  if (process && process.env && process.env.DATABASE_SERVICE_NAME) {
    return 8080 // openshift v3
  } else if (process && process.env && process.env.PORT) { // aws
    // onsole.log("auto port exists (AWS & other..)",    process.env.PORT)
    return process.env.PORT
  } /* add other platforms here */ else {
    return 3000
  }
}
const autoDbParams = function (callback) {
  let foundDbParams = {}
  let haveWorkingDb = false
  let otherOptions = {
    MONGO_EXTERNAL: {
      vars_exist: false,
      functioning: false,
      env_on_db: false,
      params: null
    },
    COSMOSMONGO_EXTERNAL: {
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
          unifiedDbName: process.env.UNIFIED_DB_NAME || 'freezrDb'
        }
        if (!haveWorkingDb) foundDbParams = otherOptions.MONGO_EXTERNAL.params
        haveWorkingDb = true
        cb(null)
      } else if (process && process.env && process.env && process.env.FREEZR_DB && process.env.FREEZR_DB.toLowerCase() === 'mongodb' && process.env.MONGO_STR) {
        otherOptions.MONGO_EXTERNAL.vars_exist = true
        otherOptions.MONGO_EXTERNAL.params = {
          type: 'mongodb',
          choice: 'mongoConnectionString',
          connectionString: process.env.MONGO_STR,
          unifiedDbName: process.env.UNIFIED_DB_NAME || 'freezrDb'
        }
        if (!haveWorkingDb) foundDbParams = otherOptions.MONGO_EXTERNAL.params
        haveWorkingDb = true
        cb(null)
      } else if (process && process.env && process.env && process.env.FREEZR_DB && process.env.FREEZR_DB.toLowerCase() === 'cosmosForMongoString'.toLowerCase() && process.env.MONGO_STR) {
        otherOptions.COSMOSMONGO_EXTERNAL.vars_exist = true
        otherOptions.COSMOSMONGO_EXTERNAL.params = {
          type: 'mongodb',
          choice: 'cosmosForMongoString',
          connectionString: process.env.MONGO_STR,
          unifiedDbName: process.env.UNIFIED_DB_NAME || 'freezrDb'
        }
        if (!haveWorkingDb) foundDbParams = otherOptions.COSMOSMONGO_EXTERNAL.params
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
        const mongoServiceName = process.env.DATABASE_SERVICE_NAME.toUpperCase()
        otherOptions.MONGO_OPENSHIFT.vars_exist = true
        otherOptions.MONGO_OPENSHIFT.params = {
          type: 'mongodb',
          choice: 'mongoRedHat',
          user: process.env.MONGODB_USER,
          pass: process.env.MONGODB_PASSWORD,
          host: process.env[mongoServiceName + '_SERVICE_HOST'],
          port: process.env[mongoServiceName + '_SERVICE_PORT'],
          addAuth: false,
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
        addAuth: false
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
const fsParams = function () {
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
  } else if (process && process.env && process.env.FREEZR_FS && process.env.FREEZR_FS === 'aws') {
    return {
      type: process.env.FREEZR_FS,
      accessKeyId: process.env.FS_ACCESS_KEY_ID,
      secretAccessKey: process.env.FS_SECRET_ACCESS_KEY,
      bucket: process.env.FS_BUCKET
    }
  } else if (process?.env?.FREEZR_FS === 'azure') {
    return {
      type: process.env.FREEZR_FS,
      choice: process.env.FREEZR_FS,
      storageAccountName: process.env.FS_STORAGE_ACCOUNT_NAME,
      msConnectioNString: process.env.FS_MS_CONNECTION_STRING,
      secretAccessKey: process.env.FS_SECRET_ACCESS_KEY,
      containerName: process.env.FS_CONTAINER_NAME
    }
  } else if (isReplit()) {
    return {
      type: 'local',
      choice: 'replit'
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
      choice: 'localFileSystem',
      userRoot: null
    }
  }
}
function isGlitch () {
  return (process?.env?.API_SERVER_EXTERNAL?.indexOf('glitch') > 0)
}
const GLITCH_USER_ROOT = '.data/users_freezr'
function isReplit () {
  return (process?.env && process.env.REPL_ID)
}

// Loggers
const LOG_ERRORS = true
const felog = function (...args) { if (LOG_ERRORS) helpers.warning('environment_defaults.js', exports.version, ...args) }
const LOG_DEBUGS = false
const fdlog = function (...args) { if (LOG_DEBUGS) console.log(...args) }
