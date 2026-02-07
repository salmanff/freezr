// freezr.info - Modern ES6 Module - Register API Controller - registerApiController.mjs
// Handles API requests for registration (first setup, self-registration, etc.)
//
// Architecture Pattern:
// - Controller handles HTTP concerns (request/response)
// - Uses async/await for modern async patterns
// - Gets context from res.locals.freezr (set by middleware)
// - Uses req.params.action to determine which action to perform

import bcrypt from 'bcryptjs'
import { User } from '../../../common/misc/userObj.mjs'
import { sendApiSuccess, sendFailure, sendAuthFailure } from '../../../adapters/http/responses.mjs'
import { randomText, startsWith, emailIsValid } from '../../../common/helpers/utils.mjs'
import { userIdFromUserInput, userIdIsValid, USER_DB_OAC, PARAMS_OAC, APP_TOKEN_OAC } from '../../../common/helpers/config.mjs'
import { generateAppToken } from '../../../middleware/tokens/tokenHandler.mjs'
import { checkFS, checkDB, checkAndCleanFs, checkAndCleanDb } from '../../../adapters/datastore/environmentDefaults.mjs'
import { DEFAULT_PREFS } from '../../admin/services/adminConfigService.mjs'
import {
  parseSetupToken,
  tokenExpired,
  safeEqual,
  reAddConfidentialInfoToInitialEnvironment,
  encryptParams,
  computeEnvChecksum
} from '../services/registerServices.mjs'

const EXPIRY_DEFAULT = 2 * 24 * 60 * 60 * 1000 // 2 days in milliseconds
const SETUP_TOKEN_ENV = 'FREEZR_SETUP_TOKEN'

/**
 * Handle check-resource action - checks FS or DB availability
 * Used during first setup or third-party setup to validate credentials
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const handleCheckResource = async (req, res) => {
  try {
    const { isSetup, freezrInitialEnvCopy, freezrPrefs } = res.locals.freezr || {}
  
    // Check for restricted operations
    if (isSetup && req.body.resource === 'FS' && req.body.params?.type === 'local') {
      return sendFailure(res, new Error('not permitted'), 'registerApiController.handleCheckResource', 403)
    }
    if (isSetup && req.body.resource === 'DB' && req.body.params?.choice === 'mongoLocal') {
      return sendFailure(res, new Error('not permitted'), 'registerApiController.handleCheckResource', 403)
    }

    // Process initial environment (handles server tokens and sysDefault)
    reAddConfidentialInfoToInitialEnvironment(req, freezrInitialEnvCopy, freezrPrefs)

    const resource = req.body.resource
    const options = {}

    // console.log('handleCheckResource - req.body.env', { env: req.body.env, isSetup, options })
    
    if (req.body.getRefreshToken) options.getRefreshToken = true
    if (!isSetup) options.okToCheckOnLocal = true

    let testResults
    if (resource === 'FS') {
      testResults = await checkFS(req.body.env, options)
    } else if (resource === 'DB') {
      testResults = await checkDB(req.body.env, options)
    } else {
      return sendFailure(res, new Error('Invalid resource type'), 'registerApiController.handleCheckResource', 400)
    }

    if (testResults && testResults.refreshToken) {
      testResults.checkpassed = true
    }

    if (!res.locals.freezr) res.locals.freezr = {}
    res.locals.freezr.permGiven = true

    return sendApiSuccess(res, testResults)
  } catch (error) {
    console.error('❌ Error in handleCheckResource:', error)
    return sendFailure(res, error, 'registerApiController.handleCheckResource', 500)
  }
}

/**
 * Handle first-setup action - initial server setup
 * Creates the first admin user and initializes the system
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const handleFirstSetUp = async (req, res) => {
  try {
    const { dsManager, isSetup, freezrInitialEnvCopy, freezrPrefs, freezrStatus } = res.locals.freezr
    
    const { password } = req.body
    const userId = userIdFromUserInput(req.body.userId)

    // console.log('firstSetUp - first time register (or resetting of parameters) for ' + userId + ' withfreezrInitialEnvCopy: ', freezrInitialEnvCopy)
    
    // Validation
    if (isSetup) {
      return sendAuthFailure(res, {
        error: 'System is already initiated.',
        type: 'auth-initedAlready',
        message: 'System is already initiated.',
        statusCode: 403
      })
    }
    
    if (!userId) {
      return sendFailure(res, new Error('user id is required'), 'registerApiController.handleFirstSetUp', 400)
    }
    
    if (!userIdIsValid(userId)) {
      return sendAuthFailure(res, {
        error: 'Valid user id needed to initiate.',
        type: 'auth-invalidUserId',
        message: 'Valid user id needed to initiate.',
        statusCode: 400
      })
    }
    
    if (!password) {
      return sendFailure(res, new Error('password is required'), 'registerApiController.handleFirstSetUp', 400)
    }

    const isDev = process?.env?.NODE_ENV === 'development'
    if (!isDev) {
      const envTokenRaw = process.env[SETUP_TOKEN_ENV]
      if (!envTokenRaw) {
        return sendAuthFailure(res, {
          error: 'Setup token is required (env missing).',
          type: 'auth-setupTokenMissing',
          message: 'Setup token is required (env missing).',
          statusCode: 403
        })
      }
      const envToken = parseSetupToken(envTokenRaw)
      if (!envToken) {
        return sendFailure(
          res,
          new Error('Invalid FREEZR_SETUP_TOKEN format. Use <token>.<YYYY-MM-DD>'),
          'registerApiController.handleFirstSetUp',
          500
        )
      }

      const reqTokenRaw = req.body?.setupToken
      const reqToken = parseSetupToken(reqTokenRaw)
      if (!reqTokenRaw || !reqToken) {
        return sendAuthFailure(res, {
          error: 'Missing or invalid setup token.',
          type: 'auth-setupTokenInvalid',
          message: 'Missing or invalid setup token.',
          statusCode: 401
        })
      }
      if (tokenExpired(envToken.expires)) {
        return sendAuthFailure(res, {
          error: 'Setup token expired.',
          type: 'auth-setupTokenExpired',
          message: 'Setup token expired.',
          statusCode: 401
        })
      }
      if (!safeEqual(reqTokenRaw, envTokenRaw)) {
        return sendAuthFailure(res, {
          error: 'Setup token does not match.',
          type: 'auth-setupTokenMismatch',
          message: 'Setup token does not match.',
          statusCode: 401
        })
      }
    }
    
    // Process initial environment (handles server tokens and sysDefault)
    reAddConfidentialInfoToInitialEnvironment(req, freezrInitialEnvCopy, freezrPrefs)
    
    // Process fsParams for initial user
    const fsParams = req.body?.env?.fsParams
      ? (req.body.env.fsParams.choice === 'sysDefault'
          ? freezrInitialEnvCopy?.fsParams
          : checkAndCleanFs(req.body.env.fsParams, freezrInitialEnvCopy)
        )
      : null
    
    // Process dbParams
    const dbParams = req.body?.env?.dbParams
      ? (req.body.env.dbParams.choice === 'sysDefault'
          ? freezrInitialEnvCopy?.dbParams
          : checkAndCleanDb(req.body.env.dbParams, freezrInitialEnvCopy)
        )
      : null

    if (process?.env?.UNIFIED_DB_NAME) dbParams.unifiedDbName = process.env.UNIFIED_DB_NAME

    if (!fsParams) {
      // console.error('handleFirstSetUp - no fsParams', { reslocals: res.locals, reqBody: req.body })
      const errorMsg = (req.body && req.body.env && req.body.env.fsParams)
        ? 'Invalid fs parameters.'
        : 'fsParams is required'
      return sendFailure(res, {
        error: errorMsg,
        type: 'auth-invalidFsparams',
        message: 'Invalid fs parameters.',
        statusCode: 400
      })
    }
    
    if (!dbParams) {
      // console.error('handleFirstSetUp - no dbParams', { reslocals: res.locals })
      const errorMsg = (req.body && req.body.env && req.body.env.dbParams)
        ? 'Invalid db parameters.'
        : 'dbParams is required'
      return sendFailure(res, {
        error: errorMsg,
        type: 'auth-invalidDbparams',
        message: 'Invalid db parameters.',
        statusCode: 400
      })
    }

    // Check FS
    console.log('firstsetUp - start')
    const fsPassed = await checkFS({ fsParams, dbParams }, {})
    console.log('firstsetUp - fsPassed')
    if (!fsPassed) {
      return sendFailure(res, new Error('File system parameters did NOT pass checkup'), 'registerApiController.handleFirstSetUp', 400)
    }
    freezrStatus.can_write_to_user_folder = true

    // Check DB
    const dbPassed = await checkDB({ fsParams, dbParams }, { okToCheckOnLocal: true })
    console.log('firstsetUp - dbPassed')
    if (!dbPassed) {
      return sendFailure(res, new Error('Database parameters did NOT pass checkup'), 'registerApiController.handleFirstSetUp', 400)
    }
    freezrStatus.can_read_write_to_db = true
    dsManager.systemEnvironment = { fsParams, dbParams }

    // Initialize admin DBs
    console.log('firstsetUp - initAdminDBs')
    await dsManager.initAdminDBs({ fsParams, dbParams }, freezrPrefs || DEFAULT_PREFS)
    
    // Check for existing users
    console.log('firstsetUp - inited dbs')
    const allUsersDb = dsManager.getDB(USER_DB_OAC)
    const existingUsers = await allUsersDb.query({}, null)
    console.log('firstsetUp - existingUsers')
    if (existingUsers && existingUsers.length > 0) {
      return sendAuthFailure(res, {
        error: 'Users Already Exist - Cannot Re-Initiate.',
        type: 'auth-usersExist',
        message: 'Users Already Exist - Cannot Re-Initiate.',
        statusCode: 403
      })
    }

    // Get fradmin app FS
    console.log('firstsetUp - app fs')
    const appFS = await dsManager.getOrInitUserAppFS('fradmin', 'info.freezr.admin', {})
    // Check if freezr_environment.js already exists
    try {
      let envOnFile = await appFS.readUserFile('freezr_environment.js', null)
      if (startsWith(envOnFile, 'exports.params=')) {
        envOnFile = envOnFile.slice('exports.params='.length)
      }
      const parsedEnv = JSON.parse(envOnFile)
      if (parsedEnv.firstUser) {
        return sendAuthFailure(res, {
          error: 'env on file already exists',
          type: 'auth-usersExist',
          message: 'env on file already exists',
          statusCode: 403
        })
      }
    } catch (err) {
      // File doesn't exist, which is fine for first setup
    }

    // Create DB entry (pending state)
    console.log('firstsetUp - get fradmin db')
    const theFradminDb = dsManager.getDB(PARAMS_OAC)
    const port = dsManager.initialEnvironment.port
    const storedFsParams = encryptParams(fsParams)
    const storedDbParams = encryptParams(dbParams)
    const pendingEnv = {
      fsParams: storedFsParams,
      dbParams: storedDbParams,
      port,
      firstUser: userId,
      freezrIsSetup: false,
      setup_state: 'pending'
    }
    pendingEnv.env_checksum = computeEnvChecksum(pendingEnv)
    await theFradminDb.create('freezr_environment', pendingEnv, null)
    
    console.log('firstsetUp - created fradmin db')
    await theFradminDb.create('main_prefs', DEFAULT_PREFS, null)

    // Create user
    console.log('firstsetUp - to create user')
    const hash = await bcrypt.hash(password, 10)
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
    const createdUser = await allUsersDb.create(userId, userInfo, null)
    console.log('firstsetUp - user created')
    
    const userObj = new User(createdUser.entity)
    await dsManager.getOrSetUserDS(userId, { freezrPrefs: freezrPrefs || DEFAULT_PREFS })
    const theFradminFS = await dsManager.getOrInitUserAppFS('fradmin', 'info.freezr.admin', { freezrPrefs })

    // Write environment file (pending state)
    const envToWritePending = 'exports.params=' + JSON.stringify(pendingEnv)
    await theFradminFS.writeToUserFiles('freezr_environment.js', envToWritePending, null)
    
    // Update environment in DB
    const completeEnv = {
      ...pendingEnv,
      freezrIsSetup: true,
      setup_state: 'complete'
    }
    completeEnv.env_checksum = computeEnvChecksum(completeEnv)
    await theFradminDb.update('freezr_environment', completeEnv, { replaceAllFields: true })
    const envToWriteComplete = 'exports.params=' + JSON.stringify(completeEnv)
    await theFradminFS.writeToUserFiles('freezr_environment.js', envToWriteComplete, null)

    // Create app token
    const tokendb = dsManager.getDB(APP_TOKEN_OAC)
    const appName = 'info.freezr.admin'
    const deviceCode = randomText(20)
    const nowTime = new Date().getTime()
    const appToken = generateAppToken(userId, appName, deviceCode)
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
    await tokendb.create(null, write, null)

    // Create indices if needed
    if (dbParams.choice === 'cosmosForMongoString') {
      await addIndecesToAdminDatabases({ allUsersDb })
    }

    // Set up session
    const freezrPrefsTempPw = randomText(20)
    dsManager.freezrIsSetup = true
    dsManager.firstUser = userId
    dsManager.systemEnvironment.firstUser = userId
    dsManager.freezrPrefsTempPw = { pw: freezrPrefsTempPw, timestamp: new Date().getTime() }

    req.session.logged_in = true
    req.session.logged_in_user_id = userId
    req.session.logged_in_date = new Date().getTime()
    req.session.logged_in_as_admin = true
    req.session.device_code = deviceCode
    req.session.freezrPrefsTempPw = freezrPrefsTempPw

    res.cookie('app_token_' + userId, appToken, { path: '/admin' })
    res.cookie('app_token_' + userId, appToken, { path: '/account' })

    res.locals.freezr.permGiven = true

    return sendApiSuccess(res, { user: userObj.response_obj(), freezrStatus })
  } catch (error) {
    console.error('❌ Error in handleFirstSetUp:', error)
    return sendFailure(res, error, 'registerApiController.handleFirstSetUp', 500)
  }
}


/**
 * Helper function to add indices to admin databases (for Cosmos DB)
 * @param {Object} dbs - Database objects
 * @param {Object} dbs.allUsersDb - All users database
 */
const addIndecesToAdminDatabases = async ({ allUsersDb }) => {
  return new Promise((resolve, reject) => {
    allUsersDb.db.createIndex({ user_id: 1 }, { background: true, unique: false }, (err, result) => {
      if (err) reject(err)
      else resolve(result)
    })
  })
}

/**
 * Handle via-admin action - admin registers a new user
 * Based on old user_register function
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const handleViaAdmin = async (req, res) => {
  try {
    const { dsManager, freezrPrefs } = res.locals.freezr
    const allUsersDb = res.locals.freezr?.allUsersDb 
    
    const registerType = req.body.register_type // must be 'normal' for the moment
    const rawPassword = req.body.password
    const userId = userIdFromUserInput(req.body.user_id)

    // Validation
    if (!req.session.logged_in_as_admin || registerType !== 'normal') {
      return sendAuthFailure(res, {
        error: 'Missing Admin privileges',
        type: 'auth-adminRequired',
        message: 'Missing Admin privileges',
        statusCode: 403
      })
    }

    if (req.body.email_address && !emailIsValid(req.body.email_address)) {
      return sendFailure(res, new Error('Invalid email address'), 'registerApiController.handleViaAdmin', 400)
    }

    if (!userId) {
      return sendAuthFailure(res, {
        error: 'Missing user id',
        type: 'auth-missingUserId',
        message: 'Missing user id',
        statusCode: 400
      })
    }

    if (!userIdIsValid(userId)) {
      return sendAuthFailure(res, {
        error: 'Invalid user id',
        type: 'auth-invalidUserId',
        message: 'Invalid user id',
        statusCode: 400
      })
    }

    if (!rawPassword) {
      return sendAuthFailure(res, {
        error: 'Missing password',
        type: 'auth-missingPassword',
        message: 'Missing password',
        statusCode: 400
      })
    }

    if (!registerType) {
      return sendAuthFailure(res, {
        error: 'Missing register type',
        type: 'auth-missingRegisterType',
        message: 'Missing register type',
        statusCode: 400
      })
    }

    // Check if user already exists
    const existingUser = await allUsersDb.read_by_id(userId, null)
    if (existingUser) {   
      return sendAuthFailure(res, {
        error: 'User exists',
        type: 'auth-userExists',
        message: 'User exists',
        statusCode: 409
      })
    }

    if (!req.body.useSysFsDb) {
      console.warn('handleViaAdmin - not using system resources - this is DISABLED AT THIS POINT - New Paams page needs to be updated and corrected for this to work')
    }

    // Hash password and create user
    const hash = await bcrypt.hash(rawPassword, 10)
    const userInfo = {
      user_id: userId,
      password: hash,
      email_address: req.body.email_address,
      full_name: req.body.full_name,
      deleted: false,
      isAdmin: req.body.isAdmin || false,
      isPublisher: req.body.isPublisher || false,
      _created_by_user: req.session.logged_in_user_id,
      // No encryption for system params (no credentials)
      dbParams: { type: 'system' }, // (req.body.useSysFsDb ? { type: 'system' } : null),
      fsParams: { type: 'system' } // (req.body.useSysFsDb ? { type: 'system' } : null),
      // slParams: { type: 'system' } // (req.body.useSysFsDb ? { type: 'system' } : null)
    }

    const createReturns = await allUsersDb.create(userId, userInfo, null)
    
    if (!createReturns) {
      return sendFailure(res, new Error('error creating user'), 'registerApiController.handleViaAdmin', 500)
    }

    res.locals.freezr.permGiven = true

    return sendApiSuccess(res, { success: true, user_id: userId })
  } catch (error) {
    console.error('❌ Error in handleViaAdmin:', error)
    return sendFailure(res, error, 'registerApiController.handleViaAdmin', 500)
  }
}

/**
 * Handle self-register action - user self-registration
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const handleSelfRegister = async (req, res) => {
  return await handleSetupNewUserParams(req, res, 'unRegisteredUser')
}

/**
 * Handle new-params action - user sets FS/DB parameters
 * For users created by admin but with no credentials
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const handleNewParams = async (req, res) => {
  return await handleSetupNewUserParams(req, res, 'newParams')
}

/**
 * Handle setupNewUserParams - internal handler for unRegisteredUser or newParams
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {string} action - Either 'unRegisteredUser' or 'newParams'
 */
const handleSetupNewUserParams = async (req, res, action) => {
  try {
    const { freezrInitialEnvCopy, freezrPrefs, selfRegOptions, allUsersDb } = res.locals.freezr || {}
    
    // Process initial environment (handles server tokens and sysDefault)
    reAddConfidentialInfoToInitialEnvironment(req, freezrInitialEnvCopy, freezrPrefs)
    
    const uid = req.session.logged_in_user_id || userIdFromUserInput(req.body.userId)
    const { password, email } = req.body
    const fsParams = checkAndCleanFs(req.body.env.fsParams, freezrInitialEnvCopy)
    const dbParams = checkAndCleanDb(req.body.env.dbParams, freezrInitialEnvCopy)

    // console.log('setupNewUserParams', 'setupParams - setting of parameters for user :', req.body, { fsParams, dbParams })

    // Validation
    if (!uid) {
      return sendFailure(res, new Error('user id is required'), 'registerApiController.handleSetupNewUserParams', 400)
    }
    
    if (!userIdIsValid(uid)) {
      return sendAuthFailure(res, {
        error: 'Valid user id needed to initiate.',
        message: 'auth-invalidUserId',
        statusCode: 400
      })
    }
    
    if (!fsParams || !dbParams) {
      return sendFailure(res, new Error('Need fsParams and dbParams to write'), 'registerApiController.handleSetupNewUserParams', 400)
    }
    
    if (!freezrPrefs?.allowAccessToSysFsDb && (['local', 'system'].includes(fsParams.type) || ['local', 'system'].includes(dbParams.type))) {
      return sendAuthFailure(res, {
        error: 'Not allowed to use system resources',
        message: 'auth-Not-freezrAllowAccessToSysFsDb',
        statusCode: 403
      })
    }
    
    if (!selfRegOptions?.allow && !req.session.logged_in_user_id) {
      return sendAuthFailure(res, {
        error: 'Not allowed to self-register',
        message: 'auth-Not-freezrAllowSelfReg',
        statusCode: 403
      })
    }

    let hash = null
    if (action === 'unRegisteredUser') {
      if (!password) {
        return sendFailure(res, new Error('password is required'), 'registerApiController.handleSetupNewUserParams', 400)
      }
      if (req.session.logged_in_user_id) {
        return sendAuthFailure(res, {
          error: 'Cannot re-register as logged in user',
          message: 'auth-invalidUserId',
          statusCode: 403
        })
      }
      hash = await bcrypt.hash(password, 10)
    } else if (action === 'newParams') {
      if (!req.session.logged_in_user_id) {
        return sendAuthFailure(res, {
          error: 'Need to be logged in to set params - SNBH',
          message: 'auth-invalidUserId',
          statusCode: 401
        })
      }
    } else {
      return sendAuthFailure(res, {
        error: 'internal error - need to action unRegisteredUser or newParams - SNBH',
        message: 'auth-invalidUserId',
        statusCode: 400
      })
    }

    const deviceCode = randomText(10)
    const userLimits = {}

    // Check FS
    let fsPassed
    if (fsParams.type === 'system') {
      if (selfRegOptions?.allow) {
        userLimits.storage = selfRegOptions.defaultMBStorageLimit
        fsPassed = true
      } else {
        return sendFailure(res, new Error('Server does not allow self-registered users to use its file system.'), 'registerApiController.handleSetupNewUserParams', 403)
      }
    } else {
      fsPassed = await checkFS({ fsParams, dbParams }, { userId: uid })
    }
    
    if (!fsPassed) {
      return sendFailure(res, new Error('File system parameters did NOT pass checkup'), 'registerApiController.handleSetupNewUserParams', 400)
    }

    // Check DB
    let dbPassed
    if (dbParams.type === 'system') {
      if (selfRegOptions?.dbUnificationStrategy) {
        dbParams.dbUnificationStrategy = 'all' // currently not allowing allbutAdmin - that would need to be set manually
      }
      if (selfRegOptions?.allow) {
        userLimits.storage = selfRegOptions.defaultMBStorageLimit
        dbPassed = true
      } else {
        return sendFailure(res, new Error('Server does not allow self-registered users to use its file system.'), 'registerApiController.handleSetupNewUserParams', 403)
      }
    } else {
      // Google Drive hack - delay to avoid two dirs
      await new Promise(resolve => setTimeout(resolve, 1000))
      dbPassed = await checkDB({ fsParams, dbParams }, { okToCheckOnLocal: true })
    }
    
    if (!dbPassed) {
      return sendFailure(res, new Error('Database parameters did NOT pass checkup'), 'registerApiController.handleSetupNewUserParams', 400)
    }

    const storedFsParams = encryptParams(fsParams)
    const storedDbParams = encryptParams(dbParams)

    // Check if user exists
    const existingUsers = await allUsersDb.query({ user_id: uid }, null)
    
    if (action === 'unRegisteredUser') {
      if (existingUsers && existingUsers.length > 0) {
        return sendFailure(res, new Error('user already exists'), 'registerApiController.handleSetupNewUserParams', 409)
      }
      
      // Create new user
      const userInfo = {
        user_id: uid,
        password: hash,
        email,
        full_name: null,
        deleted: false,
        isAdmin: false,
        isPublisher: false,
        fsParams: storedFsParams,
        dbParams: storedDbParams,
        _created_by_user: '_self_',
        limits: userLimits
      }
      const createdUser = await allUsersDb.create(uid, userInfo, null)
      const userObj = new User(createdUser.entity)
      
      req.session.logged_in = true
      req.session.logged_in_user_id = uid
      req.session.logged_in_date = new Date().getTime()
      req.session.logged_in_as_admin = false
      req.session.logged_in_as_publisher = false
      req.session.device_code = deviceCode

      res.locals.freezr.permGiven = true

      return sendApiSuccess(res, { success: true, user: userObj.response_obj() })
    } else { // action === 'newParams'
      if (existingUsers && existingUsers.length === 1) {
        const theUser = existingUsers[0]
        if (theUser.fsParams && theUser.dbParams) {
          return sendFailure(res, new Error('User Params already exist! cannot re-write'), 'registerApiController.handleSetupNewUserParams', 409)
        }
        await allUsersDb.update(uid, { fsParams: storedFsParams, dbParams: storedDbParams }, { replaceAllFields: false })
        return sendApiSuccess(res, { success: true })
      } else {
        return sendFailure(res, new Error('internal error accessing database of users to update resources'), 'registerApiController.handleSetupNewUserParams', 500)
      }
    }
  } catch (error) {
    console.error('❌ Error in handleSetupNewUserParams:', error)
    return sendFailure(res, error, 'registerApiController.handleSetupNewUserParams', 500)
  }
}

/**
 * Handle reauthorize-fs action - re-authenticate OAuth tokens for file system
 * Used when user needs to update their FS credentials (e.g., Dropbox token expired)
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const handleReauthorizeFs = async (req, res) => {
  try {
    const { dsManager, freezrInitialEnvCopy, freezrPrefs, userDS } = res.locals.freezr || {}
    const allUsersDb = res.locals.freezr?.allUsersDb || dsManager.getDB(USER_DB_OAC)
    
    const uid = req.session.logged_in_user_id
    const { password } = req.body
    const fsParams = checkAndCleanFs(req.body.env.fsParams, freezrInitialEnvCopy)

    // Validation
    if (!uid) {
      return sendFailure(res, new Error('user id is required'), 'registerApiController.handleUpdateExistingFsParams', 400)
    }
    
    if (uid !== req.body.userId) {
      return sendAuthFailure(res, {
        error: 'You can only re-authenticate yourself.',
        message: 'auth-invalidUserId',
        statusCode: 403
      })
    }
    
    if (!freezrPrefs?.allowAccessToSysFsDb && (['local', 'system'].includes(fsParams.type))) {
      return sendAuthFailure(res, {
        error: 'Not allowed to use system resources',
        message: 'auth-Not-freezrAllowAccessToSysFsDb',
        statusCode: 403
      })
    }
    
    if (!password) {
      return sendFailure(res, new Error('password is required'), 'registerApiController.handleUpdateExistingFsParams', 400)
    }
    
    if (!req.body || !req.body.env || !req.body.env.fsParams) {
      return sendFailure(res, new Error('environment is required'), 'registerApiController.handleUpdateExistingFsParams', 400)
    }

    // Check FS
    const fsPassed = await checkFS({ fsParams, dbParams: null }, { userId: uid })
    if (!fsPassed) {
      return sendFailure(res, new Error('File system parameters did NOT pass checkup'), 'registerApiController.handleUpdateExistingFsParams', 400)
    }

    // Get user and verify password
    const results = await allUsersDb.query({ user_id: uid }, null)
    if (!results || results.length === 0 || results.length > 1) {
      return sendAuthFailure(res, {
        error: 'funky error',
        message: 'auth-error',
        statusCode: 500
      })
    }
    
    const u = new User(results[0])
    const passwordValid = await new Promise((resolve, reject) => {
      u.check_password(password, (err, result) => {
        if (err) reject(err)
        else resolve(result)
      })
    })
    if (!passwordValid) {
      return sendAuthFailure(res, {
        error: 'Wrong password. Cannot update params',
        message: 'auth-invalidPassword',
        statusCode: 401
      })
    }

    // Update user FS params
    const storedFsParams = encryptParams(fsParams)
    await allUsersDb.update(uid, { fsParams: storedFsParams }, { replaceAllFields: false })
    
    // Update userDS and reinitialize app tables
    userDS.fsParams = fsParams
    const tables = []
    for (const table in userDS.appcoll) {
      tables.push(table)
    }
    
    // Reinitialize all app tables
    for (const table of tables) {
      await userDS.initOacDB({ app_table: table, owner: userDS.owner }, null)
    }

    return sendApiSuccess(res, { success: true })
  } catch (error) {
    console.error('❌ Error in handleUpdateExistingFsParams:', error)
    return sendFailure(res, error, 'registerApiController.handleUpdateExistingFsParams', 500)
  }
}

/**
 * Factory function to create register API controller
 * Returns an object with handler functions
 * 
 * @returns {Object} Controller with handler functions
 */
export const createRegisterApiController = () => {
  return {
    handleFirstSetUp,
    handleViaAdmin,
    handleSelfRegister,
    handleNewParams,
    handleReauthorizeFs,
    handleCheckResource
  }
}

export default createRegisterApiController
