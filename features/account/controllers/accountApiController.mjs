// freezr.info - Modern ES6 Module - Account API Controller
// Implements API endpoints for account actions (JSON), separate from page rendering

import { sendApiSuccess, sendFailure } from '../../../adapters/http/responses.mjs'
import { generateAndSaveAppPasswordForUser, changeUserPassword, invalidateAppToken, deleteAllAppTokensForUser } from '../services/passwordService.mjs'
import { getStructuredAppListForUser } from '../services/accountQueryService.mjs'
import { removeAppFromHomePage, deleteApp } from '../services/appMgmtService.mjs'
import { oneUserInstallationProcess, updateAppFromFiles, installAppFromUrl } from '../services/appInstallService.mjs'
import { acceptNamedPermissions, denyNamedPermissions } from '../services/accountPermissionService.mjs'
import User from '../../../common/misc/userObj.mjs'
import { createAwsRole } from '../../../adapters/datastore/slConnectors/serverless.mjs'
import { userPERMS_OAC, userAppListOAC, constructAppIdStringFrom, isSystemApp, validAppName, FREEZR_USER_FILES_DIR } from '../../../common/helpers/config.mjs'
import { startsWithOneOf } from '../../../common/helpers/utils.mjs'
import { deleteLocalFolderAndContents } from '../../../adapters/datastore/fsConnectors/fileHandler.mjs'

/**
 * Generate a one-time app password and corresponding app token
 * Modernized version of account_handler.app_password_generate_one_time_pass
 *
 * Dependencies expected from middleware chain:
 * - req.session.logged_in_user_id
 * - req.session.device_code
 * - res.locals.freezr.userDS (from createAddUserDSAndAppFS)
 */
const generateAppPassword = async (req, res) => {
  try {
    // onsole.log('🔑 generateAppPassword called with details called')
    const userId = req.session?.logged_in_user_id
    const appName = req.query?.app_name || null
    const expiry = req.query?.expiry ? parseInt(req.query.expiry) : null
    // 2025-10 removed - const oneDevice = !(req.query && req.query.one_device && req.query.one_device === 'false')

    if (!userId) {
      return sendFailure(res, 'Missing user id', 'accountApiController.generateAppPassword', 401)
    }
    if (!appName) {
      return sendFailure(res, 'Missing app name', 'accountApiController.generateAppPassword', 400)
    }

    // Get token database from middleware
    const tokenDb = res.locals?.freezr?.appTokenDb
    if (!tokenDb) {
      return sendFailure(res, 'App token database not available', 'accountApiController.generateAppPassword', 500)
    }

    // Use token service for business logic
    const result = await generateAndSaveAppPasswordForUser(tokenDb, userId, appName, {
      deviceCode: req.session.device_code,
      expiry,
      oneDevice: false
    })

    // onsole.log('🔑 generateAppPassword result:', result, { oac: tokenDb.oac})
    // onsole.log('🔑 generateAppPassword completed successfully ', { oac: tokenDb.oac})
  return sendApiSuccess(res, result)
  } catch (error) {
    return sendFailure(res, error, 'accountApiController.generateAppPassword', 500)
  }
}

/**
 * Handle account actions (setPrefs, setServicesParams) // setServicesItem used?
 * Modernized version of account_handler.accountActions
 *
 * Dependencies expected from middleware chain:
 * - req.session.logged_in_user_id
 * - req.params.action (setPrefs, setServicesParams)
 * - res.locals.freezr.allUsersDb (from createAddAllUsersDb)
 * - res.locals.freezr.userDS (from createAddUserDSAndAppFS)
 */
const handleAccountActions = async (req, res) => {
  try {
    const action = req.params.action
    
    if (action === 'setPrefs') {
      return await handleSetPrefs(req, res)
    } else if (action === 'setServicesParams') { //  || action === 'setServicesItem'
      return await handleSetServicesParams(req, res)
    } else if (action === 'changePassword') {
      return await handleChangePassword(req, res)
    } else if (action === 'removeFromFreezr') {
      return await handleRemoveFromFreezr(req, res)
    } else {
      return sendFailure(res, 'Invalid account action', 'accountApiController.handleAccountActions', 400)
    }
  } catch (error) {
    return sendFailure(res, error, 'accountApiController.handleAccountActions', 500)
  }
}

/**
 * Handle set preferences action
 * Modernized version of account_handler.accountActionSetPrefs
 */
const handleSetPrefs = async (req, res) => {
  // onsole.log('⚙️  setPrefs called, body:', req.body)
  
  const userId = req.session?.logged_in_user_id
  if (!userId) {
    console.error('❌ User not logged in', 'accountApiController.handleSetPrefs', 401)
    return sendFailure(res, 'User not logged in', 'accountApiController.handleSetPrefs', 401)
  }

  const allUsersDb = res.locals?.freezr?.allUsersDb
  if (!allUsersDb) {
    return sendFailure(res, 'Users database not available', 'accountApiController.handleSetPrefs', 500)
  }

  try {
    // Get user
    const users = await allUsersDb.query({ user_id: userId })

    if (!users || users.length === 0) {
      return sendFailure(res, 'User not found', 'accountApiController.handleSetPrefs', 404)
    }
    if (users.length > 1) {
      console.warn('❌ Multiple users found for user_id:', userId)
    }

    const user = new User(users[0])

    // Update user preferences
    const userPrefs = {
      blockMsgsToNonContacts: Boolean(req.body.blockMsgsToNonContacts),
      blockMsgsFromNonContacts: Boolean(req.body.blockMsgsFromNonContacts)
    }

    const updateResult = await allUsersDb.update(
        { user_id: userId },
        { userPrefs },
        { replaceAllFields: false })

    if (!updateResult || !updateResult.nModified || updateResult.nModified === 0) {
      return sendFailure(res, 'Could not update preferences', 'accountApiController.handleSetPrefs', 500)
    }

    if (updateResult.nModified !== 1) {
      console.warn('⚠️  Updated more than one user record:', updateResult)
    }

    // Update userDS in res.locals if available
    res.locals.freezr.userDS.userPrefs = userPrefs

    // onsole.log('✅ setPrefs completed successfully')
    return sendApiSuccess(res, { user: user.response_obj() })
  } catch (error) {
    console.error('❌ Error in handleSetPrefs:', error)
    return sendFailure(res, error, 'accountApiController.handleSetPrefs', 500)
  }
}

/**
 * Handle set services parameters action
 * Modernized version of account_handler.accountActionSetServicesParams
 */
const handleSetServicesParams = async (req, res) => {
  //onsole.log('⚙️  accountActionSetServicesParams called, body:', req.body)
  
  const userId = req.session?.logged_in_user_id
  if (!userId) {
    return sendFailure(res, 'User not logged in', 'accountApiController.handleSetServicesParams', 401)
  }

  const allUsersDb = res.locals?.freezr?.allUsersDb
  if (!allUsersDb) {
    return sendFailure(res, 'Users database not available', 'accountApiController.handleSetServicesParams', 500)
  }

  const action = req.params.action

  if (!action || action !== 'setServicesParams') {
    return sendFailure(res, 'Invalid action - only setServicesParams is supported', 'accountApiController.handleSetServicesParams', 400)
  }

  let slParams = {
    type: req.body.type,
    region: req.body.region,
    accessKeyId: req.body.accessKeyId,
    secretAccessKey: req.body.secretAccessKey,
    arnRole: req.body.arnRole
  }

  // Validation
  if (action === 'setServicesParams' && (!slParams.type || !slParams.region || !slParams.accessKeyId || !slParams.secretAccessKey)) {
    return sendFailure(res, 'Need all params to update (type, region, accessKeyId, secretAccessKey)', 'accountApiController.handleSetServicesParams', 400)
  }
  // if (action === 'setServicesItem' && (!slParams.type || (!slParams.region && !slParams.accessKeyId || !slParams.secretAccessKey))) {
  //   return sendFailure(res, 'Need all params to update', 'accountApiController.handleSetServicesParams', 400)
  // }

  try {
    // Create AWS role if needed
    if (action === 'setServicesParams' && slParams.type === 'aws' && !slParams.arnRole) {
      const role = await createAwsRole(slParams)
      if (role.error || !role.Arn) {
        console.warn('⚠️  Error setting role:', role)
        console.warn('⚠️  Error code:', role?.error?.Error?.Code)
        return sendFailure(res, role?.error?.Error?.Code || 'Error creating role', 'accountApiController.handleSetServicesParams', 500)
      } else {
        slParams.arnRole = role.Arn
      }
    }

    // Get user
    const users = await allUsersDb.query({ user_id: userId })

    if (!users || users.length === 0) {
      return sendFailure(res, 'User not found', 'accountApiController.handleSetServicesParams', 404)
    }
    if (users.length > 1) {
      console.warn('⚠️  Multiple users found for user_id:', userId)
    }

    const user = new User(users[0])

    // For setServicesItem, merge with existing slParams
    // if (action === 'setServicesItem') {
    //   slParams = users[0].slParams || {}
    //   if (req.body.type) slParams.type = req.body.type
    //   if (req.body.region) slParams.region = req.body.region
    //   if (req.body.accessKeyId) slParams.accessKeyId = req.body.accessKeyId
    //   if (req.body.secretAccessKey) slParams.secretAccessKey = req.body.secretAccessKey
    //   if (req.body.arnRole) slParams.arnRole = req.body.arnRole
    // }

    // Update slParams
    const updateResult = await allUsersDb.update(
        { user_id: userId },
        { slParams },
        { replaceAllFields: false })

    if (!updateResult || !updateResult.nModified || updateResult.nModified === 0) {
      return sendFailure(res, 'Could not update service parameters', 'accountApiController.handleSetServicesParams', 500)
    }

    if (updateResult.nModified !== 1) {
      console.warn('⚠️  Updated more than one user record:', updateResult)
    }

    res.locals.freezr.userDS.slParams = slParams

    return sendApiSuccess(res, { user: user.response_obj() })
  } catch (error) {
    console.error('❌ Error in handleSetServicesParams:', error)
    return sendFailure(res, error, 'accountApiController.handleSetServicesParams', 500)
  }
}

/**
 * Handle change password action
 * Modernized version of account_handler.changePassword
 */
const handleChangePassword = async (req, res) => {
  // onsole.log('🔐 changePassword called')
  
  const userId = req.body?.user_id
  const sessionUserId = req.session?.logged_in_user_id
  const deviceCode = req.session.device_code
  
  // Validate user ID matches session
  if (!userId) {
    return sendFailure(res, 'Missing user id', 'accountApiController.handleChangePassword', 400)
  }
  if (!deviceCode) {
    return sendFailure(res, 'Missing deviceCode', 'accountApiController.handleChangePassword', 400)
  }
  if (!sessionUserId || userId !== sessionUserId) {
    return sendFailure(res, 'User not logged in or user id mismatch', 'accountApiController.handleChangePassword', 401)
  }

  const allUsersDb = res.locals?.freezr?.allUsersDb
  if (!allUsersDb) {
    return sendFailure(res, 'Users database not available', 'accountApiController.handleChangePassword', 500)
  }

  const oldPassword = req.body?.oldPassword
  const newPassword = req.body?.newPassword

  if (!oldPassword) {
    return sendFailure(res, 'Missing old password', 'accountApiController.handleChangePassword', 400)
  }
  if (!newPassword) {
    return sendFailure(res, 'Missing new password', 'accountApiController.handleChangePassword', 400)
  }

  try {
    // Use service function to change password
    const result = await changeUserPassword(allUsersDb, userId, oldPassword, newPassword)

    // Get user data for session update
    const user = result.user
    let error = false
    
    // Regenerate session for security (prevents session hijacking after password change)
    await new Promise((resolve, reject) => {
      req.session.regenerate((regenerateErr) => {
        if (regenerateErr) {
          error = true
          console.error('❌ Session regeneration error during password change:', regenerateErr)
          resolve() // Don't reject, just log the error
        } else {
          // Update session with user data on new session BEFORE saving
          req.session.logged_in = true
          req.session.logged_in_user_id = userId
          req.session.logged_in_date = new Date().getTime()
          req.session.logged_in_as_admin = Boolean(user.isAdmin)
          req.session.logged_in_as_publisher = Boolean(user.isPublisher)
          req.session.device_code = deviceCode
          
          // Save session with all properties set
          req.session.save((saveErr) => {
            if (saveErr) {
              error = true
              console.error('❌ Session save error:', saveErr)
            }
            resolve() 
          })
        }
      })
    })

    if (error) {
      return sendFailure(res, 'Password change failed - session regenerate or save error', 'accountApiController.handleChangePassword', 500)
    }
    
    return sendApiSuccess(res, result)
  } catch (error) {
    console.error('❌ Error in handleChangePassword:', error)
    
    // Handle specific error messages
    if (error.message === 'Wrong password') {
      return sendFailure(res, error, 'accountApiController.handleChangePassword', 401)
    }
    
    return sendFailure(res, error, 'accountApiController.handleChangePassword', 500)
  }
}

/**
 * Handle getting account info (app list, user prefs, app resource usage)
 * Modernized version of account_handler.get_account_data
 *
 * Dependencies expected from middleware chain:
 * - req.session.logged_in_user_id
 * - req.params.getAction (getAppList, getUserPrefs, or getAppResourceUsage)
 * - res.locals.freezr.userDS (from createAddUserDs)
 * - res.locals.freezr.freezrPrefs (from middleware)
 */
const handleGettingAccountInfo = async (req, res) => {
  try {
    const action = req.params.getAction

    switch (action) {
      case 'getAppList':
        return await handleGetAppList(req, res)
      case 'getUserPrefs':
        return await handleGetUserPrefs(req, res)
      case 'getAppResourceUsage':
        return await handleGetAppResourceUsage(req, res)
      case 'getlogs':
        return await handleGetLogs(req, res)
      default:
        return sendFailure(res, 'Invalid action', 'accountApiController.handleGettingAccountInfo', 400)
    }
  } catch (error) {
    return sendFailure(res, error, 'accountApiController.handleGettingAccountInfo', 500)
  }
}

/**
 * Get log viewer
 * Modernized version of account_handler.getLogViewer
 */
const handleGetLogs = async (req, res) => {
  if (!res.locals?.freezr?.logManager) {
    return sendFailure(res, 'Log manager not available', 'accountApiController.handleGetLogs', 500)
  }
  if (!res.locals?.freezr?.tokenInfo) {
    return sendFailure(res, 'Token info not available', 'accountApiController.handleGetLogs', 500)
  }
  // if (!req.session?.logged_in_as_admin) {
  //   return sendFailure(res, 'User not logged in as admin', 'accountApiController.handleGetLogs', 401)
  // }
  const user = req.session?.logged_in_as_admin ? null : res.locals?.freezr?.tokenInfo?.owner_id
  const logManager = res.locals?.freezr?.logManager
  const logs = await logManager.getDays(req.query.startDate, req.query.endDate, { user })

  return sendApiSuccess(res, { logs })
}

/**
 * Get list of all user apps
 * Modernized version of account_handler.listAllUserApps
 */
const handleGetAppList = async (req, res) => {
  // onsole.log('📱 getAppList called')
  
  const userId = req.session?.logged_in_user_id
  if (!userId) {
    return sendFailure(res, 'User not logged in', 'accountApiController.handleGetAppList', 401)
  }

  const userDS = res.locals?.freezr?.userDS
  if (!userDS) {
    return sendFailure(res, 'User data store not available', 'accountApiController.handleGetAppList', 500)
  }

  const freezrPrefs = res.locals?.freezr?.freezrPrefs

  try {
    // Get app_list database (async, no Promise wrapper needed)
    const appListDb = await userDS.getorInitDb(userAppListOAC(userId), { freezrPrefs })

    if (!appListDb || !appListDb.query) {
      return sendFailure(res, 'Could not get app list database', 'accountApiController.handleGetAppList', 500)
    }

    // Process apps using service function
    const result = await getStructuredAppListForUser(appListDb, userId)

    return sendApiSuccess(res, result)
  } catch (error) {
    console.error('❌ Error in handleGetAppList:', error)
    return sendFailure(res, error, 'accountApiController.handleGetAppList', 500)
  }
}

/**
 * Get user preferences
 * Modernized version of account_handler.get_account_data for user_prefs.json
 */
const handleGetUserPrefs = async (req, res) => {
  // onsole.log('⚙️  getUserPrefs called')
  
  const userDS = res.locals?.freezr?.userDS
  if (!userDS) {
    return sendFailure(res, 'User data store not available', 'accountApiController.handleGetUserPrefs', 500)
  }

  try {
    const userPrefs = userDS.userPrefs || {}
    // onsole.log('✅ getUserPrefs completed successfully')
    return sendApiSuccess(res, userPrefs)
  } catch (error) {
    console.error('❌ Error in handleGetUserPrefs:', error)
    return sendFailure(res, error, 'accountApiController.handleGetUserPrefs', 500)
  }
}

/**
 * Get app resource usage
 * Modernized version of account_handler.getAppResources
 */
const handleGetAppResourceUsage = async (req, res) => {
  // onsole.log('💾 getAppResourceUsage called')
  
  const appName = req.query?.app_name || null
  const userDS = res.locals?.freezr?.userDS
  if (!userDS) {
    return sendFailure(res, 'User data store not available', 'accountApiController.handleGetAppResourceUsage', 500)
  }

  const freezrPrefs = res.locals?.freezr?.freezrPrefs

  try {
    const sizeJson = await userDS.getStorageUse(null, { freezrPrefs })

    return sendApiSuccess(res, sizeJson)
  } catch (error) {
    console.error('❌ Error in handleGetAppResourceUsage:', error)
    return sendFailure(res, error, 'accountApiController.handleGetAppResourceUsage', 500)
  }
}

/**
 * Handle app logout (invalidate app token)
 * Modernized version of access_handler.userAppLogOut
 *
 * Dependencies expected from middleware chain:
 * - res.locals.freezr.appTokenDb (from createAddAppTokenInfo)
 * - res.locals.freezr.appToken (from createAddAppTokenInfo)
 */
const userAppLogOut = async (req, res) => {
  try {
    // onsole.log('🔐 userAppLogOut called')
    
    // Get token database and app token from middleware
    const tokenDb = res.locals?.freezr?.appTokenDb
    const appToken = res.locals?.freezr?.appToken

    if (!tokenDb) {
      return sendFailure(res, 'App token database not available', 'accountApiController.userAppLogOut', 500)
    }
    if (!appToken) {
      return sendFailure(res, 'App token not found', 'accountApiController.userAppLogOut', 401)
    }

    // Invalidate the token using service function
    await invalidateAppToken(tokenDb, appToken)

    // // Record visit => TODO-MODERNIZATION -> need to pass logger without all of dsManager
    // const dsManager = res.locals?.freezr?.dsManager
    // if (dsManager) {
    //   visitLogger.recordLoggedInVisit(dsManager, req, { visitType: 'apis' })
    // }

    const deviceCode = req.session.device_code || 

    // Regenerate session for security (ensures clean app logout)
    req.session.regenerate((regenerateErr) => {
      if (regenerateErr) {
        req.session.device_code = deviceCode
        console.error('Session regeneration error during app logout:', regenerateErr)
        // Continue with logout even if regeneration fails
      }
      
      return sendApiSuccess(res, { success: true })
    })

  } catch (error) {
    console.error('❌ Error in userAppLogOut:', error)
    return sendFailure(res, error, 'accountApiController.userAppLogOut', 500)
  }
}

/**
 * Handle app management actions (removeAppFromHomePage, deleteApp, updateApp)
 * Modernized version of account_handler.appMgmtActions
 *
 * Dependencies expected from middleware chain:
 * - req.session.logged_in_user_id
 * - req.body.action (removeAppFromHomePage, deleteApp, or updateApp)
 * - req.body.app_name
 * - res.locals.freezr.userDS (from createAddUserDSAndAppFS)
 * - res.locals.freezr.freezrPrefs (from middleware)
 */
const handleAppMgmtActions = async (req, res) => {
  try {
    const action = req.body?.action
    const appName = req.body?.app_name
    
    if (!action) {
      return sendFailure(res, 'Missing action', 'accountApiController.handleAppMgmtActions', 400)
    }
    if (!appName) {
      return sendFailure(res, 'Missing app name', 'accountApiController.handleAppMgmtActions', 400)
    }
    
    const userId = req.session?.logged_in_user_id
    if (!userId) {
      return sendFailure(res, 'User not logged in', 'accountApiController.handleAppMgmtActions', 401)
    }

    const userDS = res.locals?.freezr?.userDS
    if (!userDS) {
      return sendFailure(res, 'User data store not available', 'accountApiController.handleAppMgmtActions', 500)
    }

    const freezrPrefs = res.locals?.freezr?.freezrPrefs

    const appFS = res.locals?.freezr?.appFS
    if (!appFS) {
      return sendFailure(res, 'App file system not available', 'accountApiController.handleAppMgmtActions', 500)
    }

    // Get required databases
    const appListDb = await userDS.getorInitDb(userAppListOAC(userId), { freezrPrefs })
    
    if (!appListDb || !appListDb.query) {
      return sendFailure(res, 'Could not access app list database', 'accountApiController.handleAppMgmtActions', 500)
    }

    // Route to specific handler based on action
    if (action === 'removeAppFromHomePage') {
      return await handleRemoveAppFromHomePage(req, res, appListDb, userId, appName)
    } else if (action === 'deleteApp') {
      return await handleDeleteApp(req, res, userId, appName)
    } else {
      return sendFailure(res, 'Unknown action', 'accountApiController.handleAppMgmtActions', 400)
    }
  } catch (error) {
    console.error('❌ Error in handleAppMgmtActions:', error)
    return sendFailure(res, error, 'accountApiController.handleAppMgmtActions', 500)
  }
}

/**
 * Handle removeAppFromHomePage action
 */
const handleRemoveAppFromHomePage = async (req, res, appListDb, userId, appName) => {
  try {
    // onsole.log('📱 handleRemoveAppFromHomePage called')
    const result = await removeAppFromHomePage(appListDb, userId, appName)
    return sendApiSuccess(res, result)
  } catch (error) {
    console.error('❌ Error in handleRemoveAppFromHomePage:', error)
    return sendFailure(res, error, 'accountApiController.handleRemoveAppFromHomePage', 500)
  }
}

/**
 * Handle deleteApp action
 */
const handleDeleteApp = async (req, res, userId, appName) => {
  try {
    // onsole.log('🗑️  handleDeleteApp called')

    const userDS = res.locals?.freezr?.userDS
    const freezrPrefs = res.locals?.freezr?.freezrPrefs
    const publicManifestsDb = res.locals?.freezr?.publicManifestsDb
    const publicRecordsDb = res.locals?.freezr?.publicRecordsDb
    

    
    const result = await deleteApp({ userDS, userId, appName, freezrPrefs, publicManifestsDb, publicRecordsDb})
    return sendApiSuccess(res, result)
  } catch (error) {
    console.error('❌ Error in handleDeleteApp:', error)
    return sendFailure(res, error, 'accountApiController.handleDeleteApp', 500)
  }
}

/**
 * Remove a user's data and record (apps, system tables, app tokens, sessions, user row).
 * Callable by account API (self-remove) or admin API (delete selected). No auth/password checks.
 *
 * @param {Object} options
 * @param {string} options.userId - User ID to remove
 * @param {Object} options.allUsersDb - All users database
 * @param {Object} options.userDS - User data store for the user being removed
 * @param {Object} options.freezrPrefs - Freezr preferences
 * @param {Object} options.publicRecordsDb - Public records database
 * @param {Object} options.publicManifestsDb - Public manifests database
 * @param {Object} [options.tokenDb] - App token database (optional); if provided, deletes user's app tokens
 * @param {Object} [options.sessionStore] - Session store with destroyAllForUserId (optional); if provided, destroys user's sessions
 * @returns {Promise<{ tokensDeleted?: number, sessionsDestroyed?: number }>}
 */
export const removeUserDataAndRecord = async (options) => {
  const {
    userId,
    allUsersDb,
    userDS,
    freezrPrefs,
    publicRecordsDb,
    publicManifestsDb,
    tokenDb,
    sessionStore
  } = options

  const failures = []
  const oac = {
    owner: userId,
    app_name: 'info.freezr.account',
    collection_name: 'app_list'
  }
  const appList = await userDS.getorInitDb(oac)
  const allApps = await appList.query({}, {})

  for (const appItem of allApps) {
    const appName = appItem.app_name
    try {
      await deleteApp({ userDS, userId, appName, freezrPrefs, publicManifestsDb, publicRecordsDb })
    } catch (error) {
      console.error('❌ Error in removeUserDataAndRecord (deleteApp):', error)
      failures.push({ error, appName })
    }
  }
  if (failures.length > 0) {
    throw new Error(JSON.stringify({ error: 'Errors deleting some apps', failures }))
  }

  const systemAppTables = [
    'info.freezr.account.user_devices',
    'info.freezr.account.permissions',
    'dev.ceps.privatefeeds',
    'dev.ceps.privatefeeds.codes',
    'dev.ceps.messages.got',
    'dev.ceps.messages.sent',
    'dev.ceps.groups',
    'dev.ceps.contacts'
  ]
  for (const appTable of systemAppTables) {
    try {
      const sysApp = await userDS.getorInitDb({ owner: userId, app_table: appTable }, { freezrPrefs })
      sysApp.delete_records({}, null)
    } catch (error) {
      console.error('❌ Error in removeUserDataAndRecord (system app):', error)
      failures.push({ error, appTable })
    }
  }
  if (failures.length > 0) {
    throw new Error(JSON.stringify({ error: 'Errors deleting some system apps', failures }))
  }

  let tokensDeleted = 0
  let sessionsDestroyed = 0
  if (tokenDb && typeof tokenDb.delete_records === 'function') {
    const result = await deleteAllAppTokensForUser(tokenDb, userId)
    tokensDeleted = result?.deletedCount ?? 0
  }
  if (sessionStore && typeof sessionStore.destroyAllForUserId === 'function') {
    sessionsDestroyed = await sessionStore.destroyAllForUserId(userId)
  }

  await allUsersDb.delete_record(userId, null)
  return { tokensDeleted, sessionsDestroyed }
}

/**
 * Handle remove from freezr action (self-remove with password check).
 * Grabs vars from req/res, validates, checks password, then calls removeUserDataAndRecord.
 *
 * Dependencies expected from middleware chain:
 * - res.locals.freezr.allUsersDb, userDS, publicRecordsDb, publicManifestsDb, freezrPrefs
 * - res.locals.freezr.appTokenDb (optional; add addTokenDb to route for token/session cleanup)
 * - req.sessionStore (optional; for destroying user sessions)
 */
const handleRemoveFromFreezr = async (req, res) => {
  try {
    const userId = req.body?.user_id
    const oldPassword = req.body?.oldPassword
    const allUsersDb = res.locals?.freezr?.allUsersDb
    const userDS = res.locals?.freezr?.userDS
    const publicRecordsDb = res.locals?.freezr?.publicRecordsDb
    const publicManifestsDb = res.locals?.freezr?.publicManifestsDb
    const freezrPrefs = res.locals?.freezr?.freezrPrefs
    const tokenDb = res.locals?.freezr?.appTokenDb
    const sessionStore = req.sessionStore

    if (!userId) {
      return sendFailure(res, 'Missing user id', 'accountApiController.handleRemoveFromFreezr', 400)
    }
    if (!req.session?.logged_in_user_id || userId !== req.session.logged_in_user_id) {
      return sendFailure(res, 'User cannot remove other users ;)', 'accountApiController.handleRemoveFromFreezr', 401)
    }
    if (!oldPassword) {
      return sendFailure(res, 'Missing old password', 'accountApiController.handleRemoveFromFreezr', 400)
    }
    if (req.session?.logged_in_as_admin) {
      return sendFailure(res, 'Cannot remove admins', 'accountApiController.handleRemoveFromFreezr', 403)
    }
    if (!allUsersDb) {
      return sendFailure(res, 'Users database not available', 'accountApiController.handleRemoveFromFreezr', 500)
    }
    if (!freezrPrefs) {
      return sendFailure(res, 'Freezr preferences not available', 'accountApiController.handleRemoveFromFreezr', 500)
    }
    if (!publicRecordsDb) {
      return sendFailure(res, 'Public records database not available', 'accountApiController.handleRemoveFromFreezr', 500)
    }
    if (!publicManifestsDb) {
      return sendFailure(res, 'Public manifests database not available', 'accountApiController.handleRemoveFromFreezr', 500)
    }
    if (!userDS) {
      return sendFailure(res, 'User data store not available', 'accountApiController.handleRemoveFromFreezr', 500)
    }

    const results = await allUsersDb.query({ user_id: userId }, null)
    if (!results || results.length === 0) {
      return sendFailure(res, 'User not found', 'accountApiController.handleRemoveFromFreezr', 404)
    }
    if (results.length > 1) {
      return sendFailure(res, 'Getting too many users - contact the administrator!', 'accountApiController.handleRemoveFromFreezr', 500)
    }

    const u = new User(results[0])
    if (!u.check_passwordSync(oldPassword)) {
      console.warn('removeFromFreezr: wrong password – consider limiting attempts (e.g. datastore flag)')
      return sendFailure(res, 'Wrong password', 'accountApiController.handleRemoveFromFreezr', 401)
    }

    const result = await removeUserDataAndRecord({
      userId,
      allUsersDb,
      userDS,
      freezrPrefs,
      publicRecordsDb,
      publicManifestsDb,
      tokenDb,
      sessionStore
    })

    res.locals.freezr.userDS = null
    return sendApiSuccess(res, { success: true, ...result })
  } catch (error) {
    console.error('❌ Error in handleRemoveFromFreezr:', error)
    return sendFailure(res, error, 'accountApiController.handleRemoveFromFreezr', 500)
  }
}



/**
 * Handle update app from files (refresh manifest, update permissions)
 * Modernized version of account_handler.appMgmtActions with action=updateApp
 *
 * Dependencies expected from middleware chain:
 * - req.session.logged_in_user_id
 * - req.body.app_name
 * - res.locals.freezr.userDS (from createAddUserDSAndAppFS)
 * - res.locals.freezr.ownerPermsDb (from createAddOwnerPermsDbForLoggedInuser)
 * - res.locals.freezr.publicManifestsDb (from createAddPublicRecordsDB)
 * - res.locals.freezr.freezrPrefs (from middleware)
 */
const updateAppFromFilesController = async (req, res) => {
  try {
    // onsole.log('🔄 updateAppFromFilesController called')
    
    const userId = req.session?.logged_in_user_id
    if (!userId) {
      return sendFailure(res, 'User not logged in', 'accountApiController.updateAppFromFiles', 401)
    }

    const appName = req.body?.app_name
    if (!appName) {
      return sendFailure(res, 'Missing app name', 'accountApiController.updateAppFromFiles', 400)
    }

    // Get dependencies from res.locals.freezr
    const userDS = res.locals?.freezr?.userDS
    if (!userDS) {
      return sendFailure(res, 'User data store not available', 'accountApiController.updateAppFromFiles', 500)
    }

    const ownerPermsDb = res.locals?.freezr?.ownerPermsDb
    if (!ownerPermsDb) {
      return sendFailure(res, 'User permissions database not available', 'accountApiController.updateAppFromFiles', 500)
    }

    const publicManifestsDb = res.locals?.freezr?.publicManifestsDb
    if (!publicManifestsDb) {
      return sendFailure(res, 'Public manifests database not available', 'accountApiController.updateAppFromFiles', 500)
    }

    const freezrPrefs = res.locals?.freezr?.freezrPrefs

    // Get app list database
    const userAppListDb = await userDS.getorInitDb(userAppListOAC(userId), { freezrPrefs })
    
    if (!userAppListDb) {
      return sendFailure(res, 'Could not access app list database', 'accountApiController.updateAppFromFiles', 500)
    }

    // Get error logger from req (should be attached by server middleware)
    const errorLogger = res.locals?.flogger || {
      log: (msg, context) => { console.log('Error logger not available, using console.log:', msg, context) },
      error: (msg, context) => { console.error('Error logger not available, using console.error:', msg, context) },
      warn: (msg, context) => { console.error('Error logger not available, using console.warn:', msg, context) }
    }

    // Create update context
    const context = {
      userId,
      realAppName: appName,
      userDS,
      ownerPermsDb,
      publicManifestsDb,
      userAppListDb,
      freezrPrefs,
      errorLogger, // todo-modernization - not clear this is still needed as 
      
      // State that will be populated during update
      appFS: null,
      manifest: null,
      warnings: [],
      installInfo: { isUpdate: true }
    }

    // Call service function
    const result = await updateAppFromFiles(context)

    return sendApiSuccess(res, result)

  } catch (error) {
    console.error('❌ Error in updateAppFromFiles:', error)
    return sendFailure(res, error, 'accountApiController.updateAppFromFiles', 500)
  }
}

/**
 * Handle install app from zip file
 * Modernized version of account_handler.install_app_modern
 *
 * Dependencies expected from middleware chain:
 * - req.file (from multer middleware - must be added to route)
 * - ... ie requires multipart/form-data with 'file' field containing zip file
 * - req.session.logged_in_user_id
 * - res.locals.freezr.userDS (from createAddUserDSAndAppFS)
 * - res.locals.freezr.ownerPermsDb (from createAddOwnerPermsDbForLoggedInuser)
 * - res.locals.freezr.publicManifestsDb (from createAddPublicRecordsDB)
 * - res.locals.freezr.freezrPrefs (from middleware)
 */
const installAppFromZipFile = async (req, res) => {
  try {
    // onsole.log('📦 installAppFromZipFile called')
    
    // Validate file upload
    if (!req.file) {
      return sendFailure(res, 'Missing file upload', 'accountApiController.installAppFromZipFile', 400)
    }

    // Validate file is a zip
    if (!req.file.originalname || !req.file.originalname.endsWith('.zip')) {
      return sendFailure(res, 'File must be a zip file', 'accountApiController.installAppFromZipFile', 400)
    }

    const userId = req.session?.logged_in_user_id
    if (!userId) {
      return sendFailure(res, 'User not logged in', 'accountApiController.installAppFromZipFile', 401)
    }

    // Get dependencies from res.locals.freezr
    const userDS = res.locals?.freezr?.userDS
    if (!userDS) {
      return sendFailure(res, 'User data store not available', 'accountApiController.installAppFromZipFile', 500)
    }

    const ownerPermsDb = res.locals?.freezr?.ownerPermsDb
    if (!ownerPermsDb) {
      return sendFailure(res, 'User permissions database not available', 'accountApiController.installAppFromZipFile', 500)
    }

    const publicManifestsDb = res.locals?.freezr?.publicManifestsDb
    if (!publicManifestsDb) {
      return sendFailure(res, 'Public manifests database not available', 'accountApiController.installAppFromZipFile', 500)
    }

    const freezrPrefs = res.locals?.freezr?.freezrPrefs

    // Get app list database
    const userAppListDb = await userDS.getorInitDb(userAppListOAC(userId), { freezrPrefs })
    
    if (!userAppListDb) {
      return sendFailure(res, 'Could not access app list database', 'accountApiController.installAppFromZipFile', 500)
    }

    // Get error logger from req (should be attached by server middleware)
    const errorLogger = res.locals?.coreLogger || {
      log: (msg, context) => { console.log('Error logger not available, using console.log:', msg, context) },
      error: (msg, context) => { console.error('Error logger not available, using console.error:', msg, context) },
      warn: (msg, context) => { console.error('Error logger not available, using console.warn:', msg, context) }
    }

    // Create installation context
    const context = {
      userId,
      userDS,
      freezrUserDS: userDS, // Alias for serverless (& 3PFunctions) compatibility
      ownerPermsDb,
      freezrUserPermsDB: ownerPermsDb, // Alias for serverless (& 3PFunctions)  compatibility
      userAppListDb,
      freezrUserAppListDB: userAppListDb, // Alias for serverless (& 3PFunctions)  compatibility
      publicManifestsDb,
      freezrPublicManifestsDb: publicManifestsDb, // Alias for serverless (& 3PFunctions)  compatibility
      freezrPrefs,
      errorLogger,
      file: req.file,
      installSource: req.body?.installsource || 'installAppFromZipFile',
      
      // State that will be populated during installation
      tempAppName: null,
      realAppName: null,
      manifest: null,
      appFS: null,
      warnings: [],
      installInfo: { isUpdate: false }
    }

    // Call service function directly
    const result = await oneUserInstallationProcess(context)

    return sendApiSuccess(res, result)

  } catch (error) {
    console.error('❌ Error in installAppFromZipFile:', error)
    return sendFailure(res, error, 'accountApiController.installAppFromZipFile', 500)
  }
}

/**
 * Handle install app from URL
 * Modernized version of account_handler.get_file_from_url_to_install_app_modern
 *
 * Dependencies expected from middleware chain:
 * - req.body.app_url - URL to download zip file from
 * - req.body.app_name - Name of the app
 * - req.session.logged_in_user_id
 * - res.locals.freezr.userDS (from createAddUserDSAndAppFS)
 * - res.locals.freezr.ownerPermsDb (from createAddOwnerPermsDbForLoggedInuser)
 * - res.locals.freezr.publicManifestsDb (from createAddPublicRecordsDB)
 * - res.locals.freezr.freezrPrefs (from middleware)
 */
const installAppFromUrlController = async (req, res) => {
  try {
    // onsole.log('📥 installAppFromUrlController called Request body:', { app_url: req.body?.app_url, app_name: req.body?.app_name })
    
    // Validate input
    const appUrl = req.body?.app_url
    if (!appUrl) {
      return sendFailure(res, 'Missing app URL', 'accountApiController.installAppFromUrl', 400)
    }

    const appName = req.body?.app_name
    if (!appName) {
      return sendFailure(res, 'Missing app name', 'accountApiController.installAppFromUrl', 400)
    }

    const userId = req.session?.logged_in_user_id
    if (!userId) {
      return sendFailure(res, 'User not logged in', 'accountApiController.installAppFromUrl', 401)
    }

    // Get dependencies from res.locals.freezr
    const userDS = res.locals?.freezr?.userDS
    if (!userDS) {
      return sendFailure(res, 'User data store not available', 'accountApiController.installAppFromUrl', 500)
    }

    const ownerPermsDb = res.locals?.freezr?.ownerPermsDb
    if (!ownerPermsDb) {
      return sendFailure(res, 'User permissions database not available', 'accountApiController.installAppFromUrl', 500)
    }

    const publicManifestsDb = res.locals?.freezr?.publicManifestsDb
    if (!publicManifestsDb) {
      return sendFailure(res, 'Public manifests database not available', 'accountApiController.installAppFromUrl', 500)
    }

    const freezrPrefs = res.locals?.freezr?.freezrPrefs

    // Get app list database
    const userAppListDb = await userDS.getorInitDb(userAppListOAC(userId), { freezrPrefs })
    
    if (!userAppListDb) {
      return sendFailure(res, 'Could not access app list database', 'accountApiController.installAppFromUrl', 500)
    }

    // Get error logger from req (should be attached by server middleware)
    const errorLogger = res.locals?.coreLogger || {
      log: (msg, context) => { console.log('Error logger not available, using console.log:', msg, context) },
      error: (msg, context) => { console.error('Error logger not available, using console.error:', msg, context) },
      warn: (msg, context) => { console.error('Error logger not available, using console.warn:', msg, context) }
    }

    // Create installation context
    const context = {
      userId,
      userDS,
      freezrUserDS: userDS, // Alias for serverless (& 3PFunctions) compatibility
      ownerPermsDb,
      freezrUserPermsDB: ownerPermsDb, // Alias for serverless (& 3PFunctions) compatibility
      userAppListDb,
      freezrUserAppListDB: userAppListDb, // Alias for serverless (& 3PFunctions) compatibility
      publicManifestsDb,
      freezrPublicManifestsDb: publicManifestsDb, // Alias for serverless (& 3PFunctions) compatibility
      freezrPrefs,
      errorLogger,
      appUrl,
      appName,
      
      // State that will be populated during installation
      tempAppName: null,
      realAppName: null,
      manifest: null,
      appFS: null,
      warnings: [],
      installInfo: { isUpdate: false }
    }

    // Call service function
    const result = await installAppFromUrl(context)

    errorLogger.log('install app success 2', {
      function: 'installAppFromUrl',
      appUrl: context.appUrl,
      appInstalName: context.appName
    })
    return sendApiSuccess(res, result)

  } catch (error) {
    console.error('❌ Error in installAppFromUrl:', error)
    return sendFailure(res, error, 'accountApiController.installAppFromUrl', 500)
  }
}

/**
 * Handle install served app (blank app with served URL)
 * Modernized version of account_handler.install_blank_app
 *
 * Dependencies expected from middleware chain:
 * - req.body.app_name - Name of the app
 * - req.body.served_url - URL where the app is served (optional)
 * - req.body.app_display_name - Display name for the app (optional)
 * - req.session.logged_in_user_id
 * - res.locals.freezr.userDS (from createAddUserDSAndAppFS)
 * - res.locals.freezr.ownerPermsDb (from createAddOwnerPermsDbForLoggedInuser)
 * - res.locals.freezr.publicManifestsDb (from createAddPublicRecordsDB)
 * - res.locals.freezr.freezrPrefs (from middleware)
 */
const installServedAppController = async (req, res) => {
  try {
    console.warn('⚠️ installServedAppController called - this has not been tested')
    // onsole.log('📦 Request body:', { 
    //   app_name: req.body?.app_name, 
    //   served_url: req.body?.served_url,
    //   app_display_name: req.body?.app_display_name 
    // })
    
    // Validate input
    const appName = req.body?.app_name
    if (!appName || appName.length < 1) {
      return sendFailure(res, 'app name missing - that is the name of the app zip file name before any spaces.', 'accountApiController.installServedApp', 400)
    }

    const userId = req.session?.logged_in_user_id
    if (!userId) {
      return sendFailure(res, 'User not logged in', 'accountApiController.installServedApp', 401)
    }

    // Validate app name
    if (isSystemApp(appName) || !validAppName(appName)) {
      return sendFailure(res, 'app name not allowed: ' + appName, 'accountApiController.installServedApp', 400)
    }

    const servedUrl = req.body?.served_url
    const appDisplayName = req.body?.app_display_name || appName

    // Validate served URL if provided
    if (servedUrl) {
      const validUrl = (appUrl) => {
        if (!appUrl) return false
        if (appUrl.length < 1) return false
        if (!startsWithOneOf(appUrl, ['/', 'https://', 'http://'])) return false
        // Note: Original code had `indexOf('/oapp/') < -1` which was always false (bug)
        // Fixed to check if URL contains '/oapp/' path
        if (appUrl.indexOf('/oapp/') < 0) return false
        return true
      }

      if (!validUrl(servedUrl)) {
        return sendFailure(res, 'url invalid: ' + servedUrl, 'accountApiController.installServedApp', 400)
      }
    }

    // Get dependencies from res.locals.freezr
    const userDS = res.locals?.freezr?.userDS
    if (!userDS) {
      return sendFailure(res, 'User data store not available', 'accountApiController.installServedApp', 500)
    }

    const freezrPrefs = res.locals?.freezr?.freezrPrefs

    // Get app list database
    const userAppListDb = await userDS.getorInitDb(userAppListOAC(userId), { freezrPrefs })
    
    if (!userAppListDb) {
      return sendFailure(res, 'Could not access app list database', 'accountApiController.installServedApp', 500)
    }

    // Check if app already exists
    const appNameId = constructAppIdStringFrom(userId, appName)
    const existingEntity = await userAppListDb.read_by_id(appNameId)
    
    if (existingEntity) {
      return sendFailure(res, 'app already exists ' + appName, 'accountApiController.installServedApp', 400)
    }

    // Create manifest
    const manifest = {
      identifier: appName,
      served_url: servedUrl,
      display_name: appDisplayName,
      version: 0
    }

    // Create app list entry
    const appEntity = {
      app_name: appName,
      app_display_name: appDisplayName,
      served_url: servedUrl,
      manifest,
      warnings: [],
      installed: new Date().toISOString(),
      removed: false
    }

    await userAppListDb.create(appNameId, appEntity, null)

    // Get appFS to handle local folder deletion for cloud storage
    const appFS = await userDS.getorInitAppFS(appName, {})
    
    if (appFS && appFS.fsParams) {
      // Delete previous version of cache (or real folder if local) for cloud storage
      if (appFS.fsParams.type !== 'local') { //  && appFS.fsParams.type !== 'glitch'
        appFS.cache.appfiles = {}
        const realAppPath = (appFS.fsParams.rootFolder || FREEZR_USER_FILES_DIR) + '/' + userId + '/apps/' + appName
        try {
          await deleteLocalFolderAndContents(realAppPath)
        } catch (error) {
          console.warn('⚠️  Could not delete local folder:', realAppPath, error)
          // Continue even if deletion fails
        }
      }
    }

    return sendApiSuccess(res, { 
      app_name: appName,
      app_display_name: appDisplayName,
      served_url: servedUrl,
      manifest
    })

  } catch (error) {
    console.error('❌ Error in installServedApp:', error)
    return sendFailure(res, error, 'accountApiController.installServedApp', 500)
  }
}

/**
 * Change named permissions (accept or deny)
 * Modernized version of account_handler.changeNamedPermissions
 * 
 * Dependencies expected from middleware chain:
 * - req.body.change - Object with { name, action, table_id, requestor_app }
 * - res.locals.freezr.ownerPermsDb (from createAddOwnerPermsDbForLoggedInuser) - User permissions database
 * - res.locals.freezr.userDS (from createAddUserDs) - User data store
 * - res.locals.freezr.publicRecordsDb (from createAddPublicRecordsDB) - Public records database
 * - res.locals.freezr.publicManifestsDb (from createAddPublicManifestsDb) - Public manifests database
 * - res.locals.freezr.manifest (from createGetTargetManifest) - App manifest
 * - req.session.logged_in_user_id
 */
export const changeNamedPermissionsHandler = async (req, res) => {
  try {
    // onsole.log('🔐 changeNamedPermissionsHandler called', JSON.stringify(req.body))
    
    const change = req.body?.change
    if (!change || !change.name || !change.action || !change.requestor_app) {
      return sendFailure(res, new Error('One request at a time can be accepted. Required fields: change.name, change.action,  change.requestor_app'), 'accountApiController.changeNamedPermissionsHandler', 400)
    }


    const requiredLocalsUserFields = ['userDS', 'ownerPermsDb', 'publicRecordsDb', 'publicManifestsDb', 'manifest']
    for (const field of requiredLocalsUserFields) {
      if (!res.locals?.freezr?.[field]) {
        console.warn('Missing field ?', {field, locals: res.locals?.freezr} )
        return sendFailure(res, new Error(`${field} not available`), 'accountApiController.changeNamedPermissionsHandler', 500)
      }
    } 

    if (change.action !== 'Accept' && change.action !== 'Deny') {
      return sendFailure(res, new Error('action needs to be Deny or Accept.'), 'accountApiController.changeNamedPermissions', 400)
    }

    const userId = req.session?.logged_in_user_id
    if (!userId) {
      return sendFailure(res, new Error('User not logged in'), 'accountApiController.changeNamedPermissionsHandler', 401)
    }

    const result = (change.action === 'Accept') 
      ? await acceptNamedPermissions(change.name, change.requestor_app, res.locals.freezr)
      : await denyNamedPermissions(change.name, change.requestor_app, res.locals.freezr)

    if (result?.success) {
      return sendApiSuccess(res, result)
    } else {
      return sendFailure(res, result?.error, 'accountApiController.changeNamedPermissionsHandler', 500)
    }

    

    // const ownerPermsDb = res.locals?.freezr?.ownerPermsDb
    // const userDs = res.locals?.freezr?.userDs
    // const publicRecordsDb = res.locals?.freezr?.publicRecordsDb
    // const publicManifestsDb = res.locals?.freezr?.publicManifestsDb
    // const manifest = res.locals?.freezr?.manifest
    // const userId = req.session.logged_in_user_id

    // if (!ownerPermsDb || !userDs) {
    //   return sendFailure(res, 'User permissions database not available', 'accountApiController.changeNamedPermissions', 500)
    // }

    // // Query for the permission
    // const permQuery = { name: change.name, requestor_app: change.requestor_app }
    // const results = await ownerPermsDb.query(permQuery, {})

    // if (results.length === 0) {
    //   return sendFailure(res, new Error('permission record not found - try re-installing app'), 'accountApiController.changeNamedPermissions', 404)
    // }

    // if (results.length > 1) {
    //   // Delete duplicate and return error
    //   await ownerPermsDb.delete_record(results[1]._id, {})
    //   console.error('SNBH - more than one permission record with the same name and requestor_app')
    //   return sendFailure(res, new Error('SNBH - more than one permission record'), 'accountApiController.changeNamedPermissions', 500)
    // }

    // const permission = results[0]
    // const permId = permission._id


    // const granted = (change.action === 'Accept')
    // const updateData = {
    //   outDated: false,
    //   granted,
    //   revokeIsWip: (!granted),
    //   status: (granted ? 'granted' : 'declined')
    // }

    // const oldGrantees = permission.grantees || []

    // // Update the permission
    // await ownerPermsDb.update(permId, updateData, { replaceAllFields: false })

    // if (!granted) {
    //   // Deny: Revoke access from all records
    //   const fullPermName = (change.requestor_app + '/' + change.name).replace(/\./g, '_')
      
    //   const tableIds = typeof permission.table_id === 'string' ? [permission.table_id] : permission.table_ids || []
      
    //   // Process each grantee
    //   for (const grantee of oldGrantees) {
    //     for (const tableId of tableIds) {

    //       const requesteeDb = await userDs.getorInitDb(tableId)

    //       const theQuery = {}
    //       theQuery['_accessible.' + grantee + '.' + fullPermName + '.granted'] = true

    //       const recs = await requesteeDb.query(theQuery, {})

    //       for (const rec of recs) {
    //         const accessible = rec._accessible || {}
    //         const publicid = (accessible[grantee] && accessible[grantee][fullPermName] && accessible[grantee][fullPermName].public_id) 
    //           ? accessible[grantee][fullPermName].public_id 
    //           : null

    //         if (accessible[grantee] && accessible[grantee][fullPermName]) {
    //           delete accessible[grantee][fullPermName]
    //         }
    //         if (Object.keys(accessible[grantee] || {}).length === 0) {
    //           delete accessible[grantee]
    //         }

    //         await requesteeDb.update(rec._id, { _accessible: accessible }, { replaceAllFields: false })

    //         // If public grantee, delete from public records
    //         if (grantee === '_public' && publicid && publicRecordsDb) {
    //           try {
    //             await publicRecordsDb.delete_record(publicid, {})
    //           } catch (err) {
    //             console.error('Error deleting public record:', err)
    //           }
    //         }
    //       }
    //     }
    //   }

    //   // Mark revoke as complete
    //   await ownerPermsDb.update(permId, { revokeIsWip: false, grantees: [] }, { replaceAllFields: false })

    //   return sendApiSuccess(res, { success: true, name: permQuery.name, action: change.action, flags: null })
    // } else {
    //   // traverse all dbs and see f there is a public grant and if som make it public
    //   // Accept: Update public manifest
    //   // if (!publicManifestsDb) {
    //   //   return sendApiSuccess(res, { success: true, name: permQuery.name, action: change.action, flags: ['freezrPublicManifestsDb - not available'] })
    //   // }

    //   // try {
    //   //   const existingResults = await publicManifestsDb.query({ user_id: userId, app_name: change.requestor_app }, {})
        
    //   //   let permissions = [change.name]
    //   //   let recId = null

    //   //   if (existingResults && existingResults[0]) {
    //   //     recId = existingResults[0]._id
    //   //     permissions = [...(existingResults[0].permissions || []), change.name]
    //   //     // Remove duplicates
    //   //     permissions = [...new Set(permissions)]
    //   //   }

    //   //   // Preserve existing cards and pages if updating
    //   //   const existingCards = (existingResults && existingResults[0]) ? (existingResults[0].cards || {}) : {}
    //   //   const existingPages = (existingResults && existingResults[0]) ? (existingResults[0].ppages || {}) : {}
        
    //   //   const write = {
    //   //     manifest: manifest || {},
    //   //     cards: existingCards,
    //   //     ppages: existingPages,
    //   //     user_id: userId,
    //   //     app_name: change.requestor_app,
    //   //     permissions
    //   //   }

    //   //   if (recId) {
    //   //     await publicManifestsDb.update(recId, write, { replaceAllFields: true })
    //   //   } else {
    //   //     await publicManifestsDb.create(null, write, null)
    //   //   }

    //     return sendApiSuccess(res, { success: true, name: permQuery.name, action: change.action, flags: null })
    //   } catch (err) {
    //     console.error('Error updating public manifest:', err)
    //     return sendApiSuccess(res, { success: true, name: permQuery.name, action: change.action, flags: ['freezrPublicManifestsDb - error setting record'] })
    //   }
    // }

  } catch (error) {
    console.error('❌ Error in changeNamedPermissionsHandler:', error)
    return sendFailure(res, error, 'accountApiController.changeNamedPermissionsHandler', 500)
  }
}

/**
 * Factory function to create the account API controller
 * Provided for symmetry with other controllers and future dependencies
 */
export const createAccountApiController = () => {
  return {
    generateAppPassword,
    handleAccountActions,
    handleGettingAccountInfo,
    userAppLogOut,
    handleAppMgmtActions,
    updateAppFromFilesController,
    installAppFromZipFile,
    installAppFromUrlController,
    installServedAppController,
    changeNamedPermissionsHandler
  }
}

export default createAccountApiController


