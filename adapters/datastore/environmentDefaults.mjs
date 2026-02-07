// freezr.info - nodejs system files - environmentDefaults.mjs
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

  - TODO - MODERNIZATION-TODO - 2025 -> This file needs to be largely reviewed, cleaned up   
*/

// Import Node.js standard modules using ES module syntax
import fs from 'fs'

// Import modern ES6 modules
import DATA_STORE_MANAGER from './dsManager.mjs'

// Import modern helper utilities and config
import { startsWith, randomText, objectContentIsSame } from '../../common/helpers/utils.mjs'
import { FREEZR_USER_FILES_DIR, PARAMS_OAC } from '../../common/helpers/config.mjs'
import { fullLocalPathTo } from './fsConnectors/fileHandler.mjs'
import { decryptParams, verifyEnvChecksum } from '../../features/register/services/registerServices.mjs'


// DEFAULTS
export const ENV_PARAMS = {
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

export const FS_AUTH_URL = {
  dropbox: function (options) {
    // need options => codeChallenge, state and clientId
    if (!options.codeChallenge || !options.state || !options.clientId) {
      return null
    } else {
      return 'https://www.dropbox.com/oauth2/authorize?client_id=' + options.clientId + '&redirect_uri=' + encodeURIComponent(options.redirecturi) + '&response_type=code&token_access_type=offline&state=' + options.state + '&code_challenge_method=S256&code_challenge=' + options.codeChallenge
    }
  },
  googleDrive: async function (options) {
    const { google } = await import('googleapis')

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

export const FS_getRefreshToken = {
  googleDrive: async function (options) {
    const { google } = await import('googleapis')

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

    const { tokens } = await oauth2Client.getToken(googOptions)
    return tokens
  },
  dropbox: async function (options) {
    const { Dropbox } = await import('dropbox')
    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args))
    const dbx = new Dropbox({ fetch, clientId: options.clientId })

    dbx.auth.codeChallenge = options.codeChallenge
    dbx.auth.codeVerifier = options.codeVerifier

    const token = await dbx.auth.getAccessTokenFromCode(options.redirecturi, options.code)
    if (token && token.result) {
      return token.result
    } else {
      throw new Error('could not get token for dropbox')
    }
  }
}

export function checkAndCleanDb (dbParams, freezrInitialEnvCopy) {
  // console.log('todo - TO IMPLEMENT checkAndCleanDb ', dbParams)
  if (!dbParams) return null
  if (fsParams.choice === 'sysDefault') return { type: 'system', choice: 'sysDefault' }
  return dbParams
}

export function checkAndCleanFs (fsParams, freezrInitialEnvCopy) {
  // returns null if invalid for any reason
  // console.log('checkAndCleanDb', { fsParams, freezrInitialEnvCopy }, JSON.stringify(freezrInitialEnvCopy))
  if (!fsParams) return null
  if (!fsParams.choice) fsParams.choice = fsParams.type
  if (fsParams.choice === 'sysDefault') return { type: 'system', choice: 'sysDefault' }
  const VALID_FS_CHOICES = ['system', 'sysDefault', 'local', 'dropbox', 'googleDrive', 'aws', 'azure'] // 'fdsFairOs', , 'glitch'
  // console.log('checking fs type choice ', { fsParams })
  if (!VALID_FS_CHOICES.includes(fsParams.choice)) console.warn('checkAndCleanFs', 'error - invalid fs choice ', fsParams)
  if (!fsParams.choice || !VALID_FS_CHOICES.includes(fsParams.choice)) return null
  if (fsParseCreds[fsParams.choice]) {
    fsParams = fsParseCreds[fsParams.choice](fsParams, freezrInitialEnvCopy)
  } else {
    console.warn('checkAndCleanFs', 'WARNING for developers - it is best to implement checkAndCleanFs for fs choice ' + fsParams.choice)
  }
  // console.log('cleaned and checked params - now are: ', fsParams)
  return fsParams
}

const fsParseCreds = {
  local: function (credentials) {
    // console.log('fsParseCreds credentials', credentials)
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
    console.warn('does secret need to bne kept?')
    // recheck - do we need codeChallenge, codeVerifier?
    if (credentials.refreshToken) {
      newCreds.refreshToken = credentials.refreshToken
    }
    if (!credentials.accessToken && !credentials.refreshToken) {
      newCreds = null
    }
    return newCreds
  }
}

// TESTS
export async function checkDB (env, options = {}) {
  // console.log('checkdb ', { env, options })
  // options : { okToCheckOnLocal}
  const TEST_OAC = {
    owner: 'test',
    app_name: 'info.freezr.admin',
    collection_name: 'params'
  }
  if (!options) options = {}

  // console.log('checkDB - env', { env, options, fsParams: env.fsParams, dbParams: env.dbParams })

  if (!env || !env.dbParams) {
    throw new Error('No parameters found.')
  }
  if (env.dbParams.type === 'nedb' && !env.fsParams) {
    throw new Error('Need file system parameters to check nedb.')
  }
  if (env.dbParams.choice === 'sysDefault') {
    throw new Error('Cannot check system default settings')
  }
  if (env.dbParams.type === 'nedb' && 
      ((env.fsParams.type === 'local' || env.fsParams.choice === 'sysDefault') && !options.okToCheckOnLocal)) {
    throw new Error('New users cannot check system resources or local file system in regular operations.')
  }
  
  // trick to get past setSystemUserDS and test the db
  if (!env.fsParams && env.dbParams.type !== 'nedb') env.fsParams = {}
  
  const tempTestManager = new DATA_STORE_MANAGER()
  tempTestManager.setSystemUserDS('test', env)
  
  try {
    const testDB = await tempTestManager.initOacDB(TEST_OAC, {})
    const savedData = await testDB.read_by_id('test_write_id')
    
    if (savedData) {
      await testDB.update('test_write_id', { foo: 'updated bar' }, { replaceAllFields: false })
    } else {
      await testDB.create('test_write_id', { foo: 'first bar' }, {})
    }
    
    return { checkpassed: true, resource: 'DB' }
  } catch (err) {
    console.warn('checkDB', 'got err in checkDB - testDb ', err)
    return { checkpassed: false, resource: 'DB', err: err?.message }
  }
}

export async function checkFSAsync (env, options) {
  // console.log('🔍 [FS] checkFS: Starting...')
  // console.log('checkFSAsync - env', { env, options, fsParams: env.fsParams, dbParams: env.dbParams })

  const tempTestManager = new DATA_STORE_MANAGER()
  if (!env.dbParams) env.dbParams = {}

  const returns = { checkpassed: false, resource: 'FS' }
  const TEST_FILE_NAME = 'test_write'
  const TEST_TEXT_1 = 'Testing write via dsManager on server !!'
  const userId = 'test'
  const appName = 'info.freezr.test.' + randomText(5)
  const warnings = []
  let currentTest = 'start'
  let userAppFS = null
  let userRootFolder = null

  try {
    if (!env || !env.fsParams) {
      throw new Error('No parameters found.')
    }
    if (env.fsParams.choice === 'sysDefault') {
      throw new Error('Cannot check system default settings')
    }

    // Set up test user and get userAppFS
    currentTest = 'setcredentials'
    // console.log('🔍 [FS] checkFS: Setting up test user...')
    tempTestManager.setSystemUserDS(userId, env)
    
    if (options && options.getRefreshToken) {
      const creds = await tempTestManager.initUserAppFSToGetCredentials(userId, appName, options)
      if (creds) {
        returns.refreshToken = creds.refreshToken
        return returns
      }
      throw new Error('could not get filesystem credentials in checkFS')
    }

    userAppFS = await tempTestManager.getOrInitUserAppFS(userId, appName, options || {})
    // console.log('🔍 [FS] checkFS: getOrInitUserAppFS resolved')
    
    userRootFolder = (userAppFS.fsParams?.rootFolder || FREEZR_USER_FILES_DIR) + '/' + userId + '/' + 'files/' + appName + '/'
    if (options && options.getRefreshToken && userAppFS.credentials) {
      returns.refreshToken = userAppFS.credentials.refreshToken
    }

    // Write file and read file
    currentTest = 'writeToUserFiles'
    // console.log('🔍 [FS] checkFS: Writing test file...')
    await userAppFS.writeToUserFiles(TEST_FILE_NAME + '.txt', TEST_TEXT_1, { doNotOverWrite: false, nocache: true })
    
    currentTest = 'readUserFile'
    const filecontent = await userAppFS.readUserFile(TEST_FILE_NAME + '.txt', { nocache: true })
    if (filecontent !== TEST_TEXT_1) {
      throw new Error('text inconsistency error:' + filecontent)
    }

    // isPresent - using callback wrapper for fs methods
    currentTest = 'isPresent'
    const isPresent = await new Promise((resolve, reject) => {
      userAppFS.fs.isPresent(userRootFolder + TEST_FILE_NAME + '.txt', (err, result) => {
        if (err) reject(err)
        else resolve(result)
      })
    })
    if (!isPresent) throw new Error('file not present after write')

    // getFileToSend
    currentTest = 'getFileToSend'
    const fileToSend = await new Promise((resolve, reject) => {
      userAppFS.fs.getFileToSend(userRootFolder + TEST_FILE_NAME + '.txt', { nocache: true }, (err, result) => {
        if (err) reject(err)
        else resolve(result)
      })
    })
    if (!fileToSend) {
      throw new Error('Could not get file in getFileToSend')
    } else if (!fileToSend.toString || fileToSend?.toString() !== TEST_TEXT_1) {
      warnings.push('getFileTestInconsistency')
    }

    // stat
    currentTest = 'stat'
    const stat = await new Promise((resolve, reject) => {
      userAppFS.fs.stat(userRootFolder + TEST_FILE_NAME + '.txt', (err, result) => {
        if (err) reject(err)
        else resolve(result)
      })
    })
    if (!stat) throw new Error('file not present after write')
    if (!stat.size) warnings.push('fileSize')
    if (!stat.mtimeMs) warnings.push('mtimeMs')

    // size
    const size = await new Promise((resolve) => {
      userAppFS.fs.size(userRootFolder + TEST_FILE_NAME + '.txt', (err, size) => {
        if (err || !size || size !== 40) warnings.push('fileSize')
        resolve(size)
      })
    })

    // doNotOverWrite test
    currentTest = 'writeToUserFiles-doNotOverWrite'
    try {
      await userAppFS.writeToUserFiles(TEST_FILE_NAME + '.txt', TEST_TEXT_1 + ' -  0', { doNotOverWrite: true, nocache: true })
      throw new Error('should not have been able to write file')
    } catch (err) {
      // Expected to fail
    }

    // Overwrite test
    currentTest = 'writeToUserFiles-overwrite'
    await userAppFS.writeToUserFiles(TEST_FILE_NAME + '.txt', TEST_TEXT_1 + ' - 2', { doNotOverWrite: false, nocache: true })
    const filecontent2 = await userAppFS.readUserFile(TEST_FILE_NAME + '.txt', { nocache: true })
    if (filecontent2 !== TEST_TEXT_1 + ' - 2') {
      throw new Error('text inconsistency error snbh :' + filecontent2)
    }

    // Unlink
    currentTest = 'unlink'
    await new Promise((resolve, reject) => {
      userAppFS.fs.unlink(userRootFolder + TEST_FILE_NAME + '.txt', (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
    
    const isPresentAfterDelete = await new Promise((resolve, reject) => {
      userAppFS.fs.isPresent(userRootFolder + TEST_FILE_NAME + '.txt', (err, result) => {
        if (err) reject(err)
        else resolve(result)
      })
    })
    if (isPresentAfterDelete) throw new Error('file present after delete')

    // mkdirp
    currentTest = 'mkdirp'
    await new Promise((resolve, reject) => {
      userAppFS.fs.mkdirp(userRootFolder + 'testFolder', (err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    // Write files in dir
    currentTest = 'writeInDir'
    await userAppFS.writeToUserFiles('testFolder/' + TEST_FILE_NAME + '_01.txt', TEST_TEXT_1, { doNotOverWrite: false, nocache: true })
    await userAppFS.writeToUserFiles('testFolder/' + TEST_FILE_NAME + '_02.txt', TEST_TEXT_1, { doNotOverWrite: false, nocache: true })
    await userAppFS.writeToUserFiles('testFolder/' + TEST_FILE_NAME + '_03.txt', TEST_TEXT_1, { doNotOverWrite: false, nocache: true })

    // readdir
    const entries = await new Promise((resolve, reject) => {
      userAppFS.fs.readdir(userRootFolder + 'testFolder', { maxPageSize: 2 }, (err, result) => {
        if (err) reject(err)
        else resolve(result)
      })
    })
    if (!entries || entries.length !== 3) {
      throw new Error('Could not read files in the folder')
    }

    // folder size
    currentTest = 'size'
    const folderSize = await new Promise((resolve) => {
      userAppFS.fs.size(userRootFolder + 'testFolder', (err, size) => {
        if (!size || size !== 120) warnings.push('folderSize')
        resolve(size)
      })
    })

    // removeFolder
    currentTest = 'removeFolder'
    await new Promise((resolve, reject) => {
      userAppFS.fs.removeFolder(userRootFolder.slice(0, userRootFolder.length - 1), (err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    // Verify folder removed
    await new Promise((resolve) => {
      userAppFS.fs.readdir(userRootFolder + 'testFolder', { maxPageSize: 2 }, (err, entries) => {
        if (!err || err.code === 'ENOENT' || err?.message?.indexOf('no such file or directory') > -1) {
          resolve()
        } else {
          resolve() // Don't throw, just continue
        }
      })
    })

    // console.log('🔍 [FS] checkFS: All tests passed ✓')
    returns.checkpassed = true
    if (warnings.length > 0) returns.warnings = warnings
    return returns

  } catch (err) {
    console.warn('🔍 [FS] checkFS error:', { currentTest, err: err?.message })
    const toSend = { checkpassed: false, resource: 'FS', err, failedtest: currentTest, warnings }
    if (options && options.getRefreshToken && userAppFS && userAppFS.credentials) {
      toSend.refreshToken = userAppFS.credentials.refreshToken
    }
    return toSend
  }
}

// Export checkFS as alias to checkFSAsync for backward compatibility
export const checkFS = checkFSAsync

async function checkDbAndGetEnvIfExists (tempParams) {
  try {
    const dbWorks = await checkDB(tempParams, { okToCheckOnLocal: true })
    
    if (!dbWorks || !dbWorks.checkpassed) {
      console.warn('checkDbAndGetEnvIfExists', 'COULD NOT USE NEDB FILE SYSTEM FOR DB - REVIEW CODE', { dbWorks, tempParams })
      return { dbWorks, envOnDb: null }
    }
    
    const tempTestManager = new DATA_STORE_MANAGER()
    tempTestManager.setSystemUserDS('fradmin', tempParams)
    const fradminDb = await tempTestManager.initOacDB(PARAMS_OAC, {})
    const envOnDb = await fradminDb.read_by_id('freezr_environment')
    
    return { dbWorks, envOnDb }
  } catch (err) {
    console.warn('checkDbAndGetEnvIfExists error', { code: err?.code, message: err?.message })
    return { dbWorks: null, envOnDb: null, error: err }
  }
}
const getEnvParamsFromLocalFileSystem = function () {
  // console.log('🔍 [ENV] getEnvParamsFromLocalFileSystem: Starting...')
  const filePath = fullLocalPathTo(FREEZR_USER_FILES_DIR + '/fradmin/files/info.freezr.admin/freezr_environment.js')
  
  try {
    if (!fs.existsSync(filePath)) {
      console.warn('🔍 [ENV] getEnvParamsFromLocalFileSystem: File does not exist')
      return null
    }
    
    let fileContent = fs.readFileSync(filePath, 'utf8')
    
    // Handle both formats: "exports.params = {...}" and raw JSON
    if (startsWith(fileContent, 'exports.params=') || startsWith(fileContent, 'exports.params =')) {
      fileContent = fileContent.replace(/^exports\.params\s*=\s*/, '')
    }
    
    const envOnFile = JSON.parse(fileContent)
    const decrypted = decryptEnvParams(envOnFile)
    // console.log('🔍 [ENV] getEnvParamsFromLocalFileSystem: Success, freezrIsSetup =', envOnFile?.freezrIsSetup)
    // if (envOnFile && envOnFile.params) return envOnFile.params // ? 2026 - was this needed?
    return decrypted
  } catch (e) {
    console.warn('🔍 [ENV] getEnvParamsFromLocalFileSystem: Error:', e.message)
    return null
  }
}

const decryptEnvParams = (env) => {
  if (!env) return env
  return {
    ...env,
    fsParams: decryptParams(env.fsParams),
    dbParams: decryptParams(env.dbParams),
    slParams: decryptParams(env.slParams),
    lmParams: decryptParams(env.lmParams)
  }
}

// STARTUP
export async function tryGettingEnvFromautoConfig (options) {
  // console.log('🔍 [ENV] tryGettingEnvFromautoConfig: Starting...')
  const r = { autoConfig: null, envOnFile: null, params: {}, environments_match: null }
  const { freezrPrefs } = options 
  const tempDsManager = new DATA_STORE_MANAGER()

  try {
    // Step 0: Read freezr_environment from file and use that if it exists
    // console.log('🔍 [ENV] Step 0: Reading env from local file system...')
    r.envOnFile = getEnvParamsFromLocalFileSystem()
    // console.log('🔍 [ENV] Step 0: envOnFile result:', { hasEnvOnFile: !!r.envOnFile, freezrIsSetup: r.envOnFile?.freezrIsSetup })

    // Step 1: Get autoConfig if no env file exists
    if (!r.envOnFile) {
      // console.log('🔍 [ENV] Step 0: No env file, getting auto config params...')
      r.autoConfig = await getAutoConfigParams()
    } else {
      console.log('🔍 [ENV] Step 0: Using environment file')
      r.autoConfig = r.envOnFile
    } 
    
    // console.log('🔍 [ENV] Step 1: autoConfig received', { hasAutoConfig: !!r.autoConfig, fsType: r.autoConfig?.fsParams?.type, dbType: r.autoConfig?.dbParams?.type })

    // Step 1b: If envOnFile doesn't exist, use autoconfigs to read env from remote fs
    if ((!r.envOnFile || !r.envOnFile.freezrIsSetup) && r.autoConfig && r.autoConfig.fsParams) {
      // console.log('🔍 [ENV] Step 1: Setting up tempDsManager...')
      tempDsManager.setSystemUserDS('fradmin', { fsParams: r.autoConfig.fsParams, dbParams: {}, freezrPrefs })
      
      try {
        // console.log('🔍 [ENV] Step 1: Getting app FS...')
        const oacFs = await tempDsManager.getOrInitUserAppFS('fradmin', 'info.freezr.admin', {})
        
        // console.log('🔍 [ENV] Step 1: Reading freezr_environment.js from oacFs...')
        try {
          let envFromAutoConfigFileSys = await oacFs.readUserFile('freezr_environment.js', {})
          // console.log({ envFromAutoConfigFileSys })
          
          if (envFromAutoConfigFileSys) {
            // console.log('Using Environment from file sys - freezr_environment.js')
            if (startsWith(envFromAutoConfigFileSys, 'exports.params=')) {
              envFromAutoConfigFileSys = envFromAutoConfigFileSys.slice('exports.params='.length)
            }
            r.envOnFile = decryptEnvParams(JSON.parse(envFromAutoConfigFileSys))
          }
        } catch (readErr) {
          console.log('🔍 [ENV] Step 1: No env file in oacFs (expected for fresh install)')
        }
      } catch (fsErr) {
        console.warn('🔍 [ENV] Step 1: getOrInitUserAppFS error', { err: fsErr?.message })
      }
    } else {
      console.log('🔍 [ENV] Step 1: envOnFile exists and is setup, skipping autoConfig fs read')
    }

    // Step 2: Get params from the db
    // console.log('🔍 [ENV] Step 2: Getting params from DB...')
    const fsParamsToUse = (r.envOnFile && r.envOnFile.fsParams) ? r.envOnFile.fsParams : r.autoConfig.fsParams
    const dbParamsToUse = (r.envOnFile && r.envOnFile.dbParams) ? r.envOnFile.dbParams : r.autoConfig.dbParams
    console.log('🔍 [ENV] Step 2: fsType:', fsParamsToUse?.type, 'dbType:', dbParamsToUse?.type)
    
    const fradminOwner = tempDsManager.setSystemUserDS('fradmin', { fsParams: fsParamsToUse, dbParams: dbParamsToUse, freezrPrefs })
    // console.log('🔍 [ENV] Step 2: Calling initOacDB...')
    const fradminDb = await fradminOwner.initOacDB(PARAMS_OAC, {})
    // console.log('🔍 [ENV] Step 2: initOacDB resolved, hasDb:', !!fradminDb)

    // Step 3: Read freezr_environment from DB
    // console.log('🔍 [ENV] Step 3: Reading freezr_environment from DB...')
    const envOnDb = decryptEnvParams(await fradminDb.read_by_id('freezr_environment'))
    console.log('🔍 [ENV] Step 3: read_by_id resolved, hasEnvOnDb:', !!envOnDb)

    // Step 4: Process envOnDb
    // console.log('🔍 [ENV] Step 4: Processing envOnDb...')
    const fileChecksumOk = r.envOnFile ? verifyEnvChecksum(r.envOnFile) : null
    const dbChecksumOk = envOnDb ? verifyEnvChecksum(envOnDb) : null
    if (fileChecksumOk === false || dbChecksumOk === false) {
      console.warn('tryGettingEnvFromautoConfig', 'ENV CHECKSUM mismatch - data may be corrupted')
      r.environments_match = false
    }
    const filePending = r.envOnFile?.setup_state === 'pending'
    const dbPending = envOnDb?.setup_state === 'pending'
    if (filePending || dbPending) {
      r.envOnFile = r.envOnFile || envOnDb || r.autoConfig
      r.envOnFile.freezrIsSetup = false
      r.envOnFile.setup_state = 'pending'
      r.environments_match = false
      console.warn('tryGettingEnvFromautoConfig - setup_state pending, needs repair')
    } else if (r.envOnFile && r.envOnFile.freezrIsSetup) {
      // if there was an env on file, use that
      if (!envOnDb) {
        // no env on db - that's okay
      } else if (!objectContentIsSame(r.envOnFile, envOnDb, ['_id', '_date_created', '_date_modified'])) {
        console.warn('tryGettingEnvFromautoConfig', 'STARTUP MISMATCH - freezr_environment on server different from one on db')
        r.environments_match = false
        // If there is a msmatch we will ignire the error
        // r.envOnFile.setup_state = 'mismatch'
        // r.envOnFile.freezrIsSetup = false
      } else {
        r.environments_match = true
      }
    } else if (envOnDb) {
      // otherwise use the environment from the db
      r.envOnFile = envOnDb
    } else {
      // use the autoconfig as a temporary
      r.envOnFile = r.autoConfig
      r.envOnFile.freezrIsSetup = false
      r.envOnFile.firstUser = null
      console.warn('tryGettingEnvFromautoConfig - freezr NOT Set Up')
    }
    // console.log('🔍 [ENV] Step 4: Done processing')

    console.log('🔍 [ENV] Complete! envOnFile FS:', r.envOnFile?.fsParams?.type, 'DB:', r.envOnFile?.dbParams?.type)
    return r
    
  } catch (err) {
    console.warn('🔍 [ENV] tryGettingEnvFromautoConfig error:', { code: err?.code, msg: err?.message, fsType: r.envOnFile?.fsParams?.type, dbType: r.envOnFile?.dbParams?.type })
    throw err
  }
}

async function getAutoConfigParams () {
  const autoConfig = {
    ipaddress: autoIpAddress(),
    port: autoPort(),
    dbParams: null,
    fsParams: fsParams()
  }
  
  const params = await autoDbParams()
  autoConfig.dbParams = params.main
  autoConfig.otherDBs = params.other
  
  return autoConfig
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

async function autoDbParams () {
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
    foundDbParams = { type: 'nedb' }
  }

  // 1. MONGO_EXTERNAL - check for environment variables being set at process.env for mongo
  if (process && process.env && process.env.FREEZR_DB && process.env.FREEZR_DB.toLowerCase() === 'mongodb' &&
    process.env.DB_HOST && process.env.DB_PASS && process.env.DB_USER) {
    otherOptions.MONGO_EXTERNAL.vars_exist = true
    otherOptions.MONGO_EXTERNAL.params = {
      type: process.env.FREEZR_DB.toLowerCase(),
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
  } else if (process && process.env && process.env.FREEZR_DB && process.env.FREEZR_DB.toLowerCase() === 'mongodb' && process.env.MONGO_STR) {
    otherOptions.MONGO_EXTERNAL.vars_exist = true
    otherOptions.MONGO_EXTERNAL.params = {
      type: 'mongodb',
      choice: 'mongoConnectionString',
      connectionString: process.env.MONGO_STR,
      unifiedDbName: process.env.UNIFIED_DB_NAME || 'freezrDb'
    }
    if (!haveWorkingDb) foundDbParams = otherOptions.MONGO_EXTERNAL.params
    haveWorkingDb = true
  } else if (process && process.env && process.env.FREEZR_DB && process.env.FREEZR_DB.toLowerCase() === 'cosmosformongostring' && process.env.MONGO_STR) {
    otherOptions.COSMOSMONGO_EXTERNAL.vars_exist = true
    otherOptions.COSMOSMONGO_EXTERNAL.params = {
      type: 'mongodb',
      choice: 'cosmosForMongoString',
      connectionString: process.env.MONGO_STR,
      unifiedDbName: process.env.UNIFIED_DB_NAME || 'freezr'
    }
    if (!haveWorkingDb) foundDbParams = otherOptions.COSMOSMONGO_EXTERNAL.params
    haveWorkingDb = true
  }

  // 2. MONGO_REDHAT (Openshift v3)
  if (process && process.env && process.env.DATABASE_SERVICE_NAME &&
    process.env.MONGODB_USER && process.env.MONGODB_PASSWORD) {
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
  }

  // 3. GAE (Google App Engine)
  try {
    const { Datastore } = await import('@google-cloud/datastore')
    const ds = new Datastore()
    otherOptions.GAE.gaeApiRunning = true
    
    if (otherOptions.GAE.gaeApiRunning) {
      otherOptions.GAE.params.type = 'gaeCloudDatastore'
      otherOptions.GAE.params.choice = 'gaeCloudDatastore'
      try {
        let keyfile = fs.readFileSync('./adapters/datastore/customParameters/gaeDatastoreKeyfile.json')
        keyfile = JSON.parse(keyfile)
        if (keyfile) {
          otherOptions.GAE.params.gaeProjectId = keyfile.project_id
          otherOptions.GAE.params.gaeKeyFile = true
        }
        /* Old code related to App engine
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
      } catch (e) {
        // console.log('autoDbParams', 'could not get GAE ds ', ds)
      }
    }
  } catch (e) {
    // no GAE API - this is expected in most cases
  }

  // 4. MONGO_LOCAL
  otherOptions.MONGO_LOCAL.params = {
    type: 'mongodb',
    user: null,
    pass: null,
    host: 'localhost',
    port: '27017',
    addAuth: false
  }
      /* Old code - to review and redo?
      db_handler.re_init_environment_sync({dbParams:otherOptions.MONGO_LOCAL.params, startuptest:true})
      db_handler.check_db({dbParams:otherOptions.MONGO_LOCAL.params, startuptest:true}, (err,env_on_db)=>{
          if (!err) {
            if (env_on_db) otherOptions.MONGO_LOCAL.env_on_db=env_on_db
            otherOptions.MONGO_LOCAL.functioning = true;
            if (!haveWorkingDb) foundDbParams = otherOptions.MONGO_LOCAL.params
            haveWorkingDb=true;
          } else {
            console.warn("GOT ERR FOR MONGO_LOCAL")
          }
          cb(null)
      })
      */
  // 5. NEDB
  otherOptions.NEDB_LOCAL.params = { type: 'nedb' }
  const tempParams = {
    fsParams: fsParams(),
    port: autoPort(),
    ipaddress: autoIpAddress(),
    dbParams: otherOptions.NEDB_LOCAL.params
  }
  
  const { dbWorks, envOnDb } = await checkDbAndGetEnvIfExists(tempParams)
  // console.log('checkDbAndGetEnvIfExists ', { dbWorks, envOnDb })
  
  otherOptions.NEDB_LOCAL = {
    functioning: dbWorks?.checkpassed || false,
    params: tempParams.dbParams
  }
  if (dbWorks?.checkpassed && envOnDb) otherOptions.NEDB_LOCAL.env_on_db = envOnDb
  if (!haveWorkingDb) foundDbParams = otherOptions.NEDB_LOCAL.params
  haveWorkingDb = true

  // console.log('AUTO DB Options ', otherOptions, 'Current DB (foundDbParams):', foundDbParams)
  return { main: foundDbParams, other: JSON.parse(JSON.stringify(otherOptions)) }
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
  } else {
    return {
      type: 'local',
      choice: 'localFileSystem',
      userRoot: null
    }
  }
}

function isReplit () {
  return (process?.env && process.env.REPL_ID)
}

