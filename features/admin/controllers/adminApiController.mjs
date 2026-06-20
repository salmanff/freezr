// freezr.info - Modern ES6 Module - Admin API Controller - adminApiController.mjs
// Handles JSON API requests for admin feature
//
// Architecture Pattern:
// - Controller handles HTTP concerns (request/response)
// - Uses switch statement to route to specific action handlers
// - Returns JSON responses
// - Uses functional approach with closures for dependency injection

import { sendApiSuccess, sendFailure, sendAuthFailure } from '../../../adapters/http/responses.mjs'
import { escapeRegex } from '../../../common/helpers/utils.mjs'
import { oneUserInstallationProcess } from '../../account/services/appInstallService.mjs'
import { setUserPasswordAsAdmin, deleteAllAppTokensForUser } from '../../account/services/passwordService.mjs'
import { removeUserFromServer } from '../../account/services/accountRemoveService.mjs'
import { userPERMS_OAC, userAppListOAC, PUBLIC_MANIFESTS_OAC, PUBLIC_RECORDS_OAC, USER_DB_OAC, APP_TOKEN_OAC, PARAMS_OAC, TRUSTED_JOBS_OAC, SCHEDULED_JOBS_OAC } from '../../../common/helpers/config.mjs'
import User from '../../../common/misc/userObj.mjs'
import { getOrSetPrefs, DEFAULT_PREFS } from '../services/adminConfigService.mjs'
import { getConnectionStats } from '../../../adapters/datastore/dbConnectors/dbApi_mongodb.mjs'
import { listTrustedJobs, trustJob, untrustJob } from '../../jobs/services/trustedJobService.mjs'
import { jobCodePath } from '../../../adapters/jobs/localJobRunner.mjs'
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { materializeJobToCache } from '../../jobs/services/localJobCache.mjs'
import { jobCodeIdentity } from '../../jobs/services/cloudJobSource.mjs'
import { freezrConsole, CONSOLE_CATEGORIES, bjLog } from '../../../common/debug/consoleFlags.mjs'

/**
 * Handle get user app resources action
 * Modern version of getAppResources from admin_handler.js
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const handleGetUserAppResources = async (req, res) => {
  try {
    const user = req.query?.user

    if (!user) {
      return sendFailure(res, 'User parameter is required', 'handleGetUserAppResources', 400)
    }

    const dsManager = res.locals.freezr?.dsManager
    const freezrPrefs = res.locals.freezr?.freezrPrefs

    if (!dsManager || !freezrPrefs) {
      return sendFailure(res, 'dsManager or freezrPrefs not available', 'handleGetUserAppResources', 500)
    }

    // Get userDS for the specified user
    const userDS = await dsManager.getOrSetUserDS(user, { freezrPrefs })

    // Get storage use information
    const sizeJson = await userDS.getStorageUse(null, { forceUpdate: true })

    return sendApiSuccess(res, sizeJson)

  } catch (error) {
    console.error('❌ Error in handleGetUserAppResources:', error)
    return sendFailure(res, error, 'handleGetUserAppResources', 500)
  }
}

/**
 * Handle list users action - returns a batch of users with skip/limit for pagination
 * GET /adminapi/list_users?skip=0&limit=20 (uses default db sort)
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const handleListUsers = async (req, res) => {
  try {
    const skip = parseInt(req.query?.skip, 10) || 0
    const limit = Math.min(parseInt(req.query?.limit, 10) || 20, 100)
    const search = typeof req.query?.search === 'string' ? req.query.search.trim() : ''

    const dsManager = res.locals.freezr?.dsManager
    const freezrPrefs = res.locals.freezr?.freezrPrefs

    if (!dsManager || !freezrPrefs) {
      return sendFailure(res, 'dsManager or freezrPrefs not available', 'handleListUsers', 500)
    }

    const theDb = await dsManager.getorInitDb(
      { owner: 'fradmin', app_table: 'info.freezr.admin.users' },
      { freezrPrefs }
    )
    if (!theDb || !theDb.query) {
      return sendFailure(res, 'Admin users database not available', 'handleListUsers', 500)
    }

    const query = search
      ? { user_id: new RegExp(escapeRegex(search), 'i') }
      : {}
    const results = await theDb.query(query, { skip, count: limit })

    return sendApiSuccess(res, { users: results || [], skip, limit })
  } catch (error) {
    console.error('❌ Error in handleListUsers:', error)
    return sendFailure(res, error, 'handleListUsers', 500)
  }
}

/**
 * Handle admin reset user password (no old password check, no session changes)
 * POST /adminapi/reset_user_password body: { user_id, newPassword }
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const handleResetUserPassword = async (req, res) => {
  try {
    const userId = req.body?.user_id
    const newPassword = req.body?.newPassword
    const sessionUserId = req.session?.logged_in_user_id

    if (!userId) {
      return sendFailure(res, 'Missing user_id', 'handleResetUserPassword', 400)
    }
    if (!newPassword) {
      return sendFailure(res, 'Missing newPassword', 'handleResetUserPassword', 400)
    }
    if (userId === sessionUserId) {
      return sendFailure(res, 'Cannot reset your own password. Use Account settings to change password.', 'handleResetUserPassword', 400)
    }
    if (!req.session?.logged_in_as_admin) {
      return sendFailure(res, 'Only admin users can reset passwords', 'handleResetUserPassword', 403)
    }

    const dsManager = res.locals?.freezr?.dsManager
    const freezrPrefs = res.locals?.freezr?.freezrPrefs
    if (!dsManager || !freezrPrefs) {
      return sendFailure(res, 'dsManager or freezrPrefs not available', 'handleResetUserPassword', 500)
    }
    const allUsersDb = await dsManager.getorInitDb(USER_DB_OAC, { freezrPrefs })
    if (!allUsersDb?.query) {
      return sendFailure(res, 'Users database not available', 'handleResetUserPassword', 500)
    }
    const tokenDb = await dsManager.getorInitDb(APP_TOKEN_OAC, { freezrPrefs })
    if (!tokenDb?.delete_records) {
      return sendFailure(res, 'Token database not available', 'handleResetUserPassword', 500)
    }

    const result = await setUserPasswordAsAdmin(allUsersDb, userId, newPassword)
    const deleted = await deleteAllAppTokensForUser(tokenDb, userId)
    let sessionsDestroyed = 0
    if (req.sessionStore && typeof req.sessionStore.destroyAllForUserId === 'function') {
      sessionsDestroyed = await req.sessionStore.destroyAllForUserId(userId)
    }
    return sendApiSuccess(res, { ...result, tokensDeleted: deleted.deletedCount, sessionsDestroyed })
  } catch (error) {
    console.error('❌ Error in handleResetUserPassword:', error)
    return sendFailure(res, error, 'handleResetUserPassword', 500)
  }
}

/**
 * Handle update user limits action
 * POST /adminapi/update_user_limits body: { user_id, limits: { storage: number } }
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const handleUpdateUserLimits = async (req, res) => {
  try {
    const userId = req.body?.user_id
    const newLimits = req.body?.limits

    if (!userId) {
      return sendFailure(res, 'Missing user_id', 'handleUpdateUserLimits', 400)
    }
    if (!newLimits || typeof newLimits !== 'object') {
      return sendFailure(res, 'Missing or invalid limits object', 'handleUpdateUserLimits', 400)
    }
    if (!req.session?.logged_in_as_admin) {
      return sendFailure(res, 'Only admin users can update limits', 'handleUpdateUserLimits', 403)
    }

    const dsManager = res.locals?.freezr?.dsManager
    const freezrPrefs = res.locals?.freezr?.freezrPrefs
    if (!dsManager || !freezrPrefs) {
      return sendFailure(res, 'dsManager or freezrPrefs not available', 'handleUpdateUserLimits', 500)
    }
    const allUsersDb = await dsManager.getorInitDb(USER_DB_OAC, { freezrPrefs })
    if (!allUsersDb?.query) {
      return sendFailure(res, 'Users database not available', 'handleUpdateUserLimits', 500)
    }

    // Get user
    const users = await allUsersDb.query({ user_id: userId }, null)
    if (!users || users.length === 0) {
      return sendFailure(res, 'User not found', 'handleUpdateUserLimits', 404)
    }
    if (users.length > 1) {
      return sendFailure(res, 'Multiple users found - contact administrator', 'handleUpdateUserLimits', 500)
    }

    const user = users[0]
    const existingLimits = user.limits || {}
    const updatedLimits = { ...existingLimits, ...newLimits }
    // console.log('updateLimits', { userId, existingLimits, newLimits, updatedLimits })
    
    // Update user record in database
    await allUsersDb.update(userId, { limits: updatedLimits }, { replaceAllFields: false })

    // Update in-memory userDs useage limits if the user DS is loaded
    const userDs = dsManager.users?.[userId]
    if (userDs && userDs.useage) {
      userDs.useage.storageLimit = updatedLimits.storage
    }

    return sendApiSuccess(res, { success: true, userId, limits: updatedLimits })
  } catch (error) {
    console.error('❌ Error in handleUpdateUserLimits:', error)
    return sendFailure(res, error, 'handleUpdateUserLimits', 500)
  }
}

/**
 * Handle change user rights action
 * POST /adminapi/change_user_rights body: { user_id, isAdmin: boolean, isPublisher: boolean }
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const handleChangeUserRights = async (req, res) => {
  try {
    const userId = req.body?.user_id
    const isAdmin = !!req.body?.isAdmin
    const isPublisher = !!req.body?.isPublisher

    if (!userId) {
      return sendFailure(res, 'Missing user_id', 'handleChangeUserRights', 400)
    }
    if (!req.session?.logged_in_as_admin) {
      return sendFailure(res, 'Only admin users can change rights', 'handleChangeUserRights', 403)
    }

    const dsManager = res.locals?.freezr?.dsManager
    const freezrPrefs = res.locals?.freezr?.freezrPrefs
    if (!dsManager || !freezrPrefs) {
      return sendFailure(res, 'dsManager or freezrPrefs not available', 'handleChangeUserRights', 500)
    }
    const allUsersDb = await dsManager.getorInitDb(USER_DB_OAC, { freezrPrefs })
    if (!allUsersDb?.query) {
      return sendFailure(res, 'Users database not available', 'handleChangeUserRights', 500)
    }
    const tokenDb = await dsManager.getorInitDb(APP_TOKEN_OAC, { freezrPrefs })
    if (!tokenDb?.delete_records) {
      return sendFailure(res, 'Token database not available', 'handleChangeUserRights', 500)
    }

    // Get user
    const users = await allUsersDb.query({ user_id: userId }, null)
    if (!users || users.length === 0) {
      return sendFailure(res, 'User not found', 'handleChangeUserRights', 404)
    }
    if (users.length > 1) {
      return sendFailure(res, 'Multiple users found - contact administrator', 'handleChangeUserRights', 500)
    }

    const user = users[0]
    console.log('handleChangeUserRights', { user, isAdmin, isPublisher })
    // Guard: cannot grant admin rights through this method (can only revoke)
    if (isAdmin && !user.isAdmin) {
      return sendFailure(res, 'Cannot grant admin rights through this method. Use the registration process to create admin users.', 'handleChangeUserRights', 403)
    }

    // Update user record
    await allUsersDb.update(userId, { isAdmin, isPublisher }, { replaceAllFields: false })

    // Invalidate all sessions and app tokens so the user must re-login with updated rights
    const deleted = await deleteAllAppTokensForUser(tokenDb, userId)
    let sessionsDestroyed = 0
    if (req.sessionStore && typeof req.sessionStore.destroyAllForUserId === 'function') {
      sessionsDestroyed = await req.sessionStore.destroyAllForUserId(userId)
    }

    return sendApiSuccess(res, { success: true, userId, isAdmin, isPublisher, tokensDeleted: deleted.deletedCount, sessionsDestroyed })
  } catch (error) {
    console.error('❌ Error in handleChangeUserRights:', error)
    return sendFailure(res, error, 'handleChangeUserRights', 500)
  }
}

/**
 * Handle delete users action (admin delete selected)
 * POST /adminapi/delete_users body: { user_ids: string[] }
 * Excludes current admin. For each user calls removeUserDataAndRecord (apps, system tables, tokens, sessions, user row).
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const handleDeleteUsers = async (req, res) => {
  try {
    const sessionUserId = req.session?.logged_in_user_id
    let userIds = req.body?.user_ids
    if (!Array.isArray(userIds)) {
      userIds = req.body?.user_ids ? [req.body.user_ids] : []
    }
    userIds = userIds.filter(Boolean).map(String)

    if (userIds.length === 0) {
      return sendFailure(res, 'Missing or empty user_ids', 'handleDeleteUsers', 400)
    }
    if (!req.session?.logged_in_as_admin) {
      return sendFailure(res, 'Only admin users can delete users', 'handleDeleteUsers', 403)
    }

    const dsManager = res.locals?.freezr?.dsManager
    const freezrPrefs = res.locals?.freezr?.freezrPrefs
    if (!dsManager || !freezrPrefs) {
      return sendFailure(res, 'dsManager or freezrPrefs not available', 'handleDeleteUsers', 500)
    }

    const allUsersDb = await dsManager.getorInitDb(USER_DB_OAC, { freezrPrefs })
    if (!allUsersDb?.query) {
      return sendFailure(res, 'Users database not available', 'handleDeleteUsers', 500)
    }
    const tokenDb = await dsManager.getorInitDb(APP_TOKEN_OAC, { freezrPrefs })
    const publicManifestsDb = await dsManager.getorInitDb(PUBLIC_MANIFESTS_OAC, { freezrPrefs })
    const publicRecordsDb = await dsManager.getorInitDb(PUBLIC_RECORDS_OAC, { freezrPrefs })
    const sessionStore = req.sessionStore

    // Admin can choose whether to also wipe each user's public posts (default: yes).
    const removePublicPosts = req.body?.removePublicPosts !== false

    const deleted = []
    const failed = []
    const skipped = []

    for (const userId of userIds) {
      if (userId === sessionUserId) {
        skipped.push({ userId, reason: 'Cannot delete your own account' })
        continue
      }
      try {
        const userDS = await dsManager.getOrSetUserDS(userId, { freezrPrefs })
        // Shared removal logic: classifies by the user's fs — a system/host user is fully
        // deleted (data + record); a cloud user is detached (record/credentials removed, their
        // cloud data left intact). Same behaviour as the user-facing /account/remove flow.
        const result = await removeUserFromServer({
          dsManager,
          userId,
          allUsersDb,
          userDS,
          freezrPrefs,
          publicRecordsDb,
          publicManifestsDb,
          tokenDb,
          sessionStore,
          removePublicPosts
        })
        console.log('🗑️  admin delete_users: removed ' + userId + ' (mode: ' + result.mode + ')')
        deleted.push(userId)
      } catch (error) {
        console.error('❌ handleDeleteUsers failed for', userId, error)
        failed.push({ userId, error: error.message || String(error) })
      }
    }

    return sendApiSuccess(res, {
      deleted,
      failed,
      skipped,
      summary: {
        deletedCount: deleted.length,
        failedCount: failed.length,
        skippedCount: skipped.length
      }
    })
  } catch (error) {
    console.error('❌ Error in handleDeleteUsers:', error)
    return sendFailure(res, error, 'handleDeleteUsers', 500)
  }
}

/**
 * Create context and install app for multiple users
 * Follows the pattern from installAppFromZipFile in accountApiController.mjs
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Array<string>} userIds - Array of user IDs to install the app for
 * @returns {Promise<Object>} Results object with success/failure details
 */
const createContextAndInstallForManyUsers = async (req, res, userIds) => {
  console.log('📦 createContextAndInstallForManyUsers - starting installation for', userIds.length, 'users')
  
  // Validate file upload
  if (!req.file) {
    throw new Error('Missing file upload')
  }

  // Validate file is a zip
  if (!req.file.originalname || !req.file.originalname.endsWith('.zip')) {
    throw new Error('File must be a zip file')
  }

  // Get dependencies from res.locals.freezr
  const dsManager = res.locals?.freezr?.dsManager
  const freezrPrefs = res.locals?.freezr?.freezrPrefs
  
  if (!dsManager || !freezrPrefs) {
    throw new Error('dsManager or freezrPrefs not available or admin privileges required')
  }

  // Get or create publicManifestsDb
  let publicManifestsDb = res.locals?.freezr?.publicManifestsDb
  if (!publicManifestsDb) {
    publicManifestsDb = await dsManager.getorInitDb(PUBLIC_MANIFESTS_OAC, { freezrPrefs })
    if (!publicManifestsDb) {
      throw new Error('Public manifests database not available')
    }
  }

  const adminUserId = req.session?.logged_in_user_id
  const installSource = `installAppForMultipleUsers-ByAdmin-${adminUserId}`

  // Initialize results tracking
  const results = {
    totalUsers: userIds.length,
    successful: [],
    failed: [],
    summary: {
      successCount: 0,
      failureCount: 0,
      totalWarnings: 0
    }
  }

  // Process each user sequentially to avoid overwhelming the system
  for (const userId of userIds) {
    try {
      console.log('📦 Installing app for user:', userId)
      
      // Get userDS for this user
      const userDS = await dsManager.getOrSetUserDS(userId, { freezrPrefs })
      if (!userDS) {
        throw new Error('Could not access user data store')
      }

      // Get user's permissions database
      const permsOac = userPERMS_OAC(userId)
      const ownerPermsDb = await dsManager.getorInitDb(permsOac, { freezrPrefs })
      if (!ownerPermsDb) {
        throw new Error('Could not access user permissions database')
      }

      // Get user's app list database
      const userAppListDb = await userDS.getorInitDb(userAppListOAC(userId), { freezrPrefs })
      if (!userAppListDb) {
        throw new Error('Could not access app list database')
      }

      // Create installation context (following pattern from installAppFromZipFile)
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
        errorLogger: res.locals.flogger,
        file: req.file,
        installSource,
        
        // State that will be populated during installation
        tempAppName: null,
        realAppName: null,
        manifest: null,
        appFS: null,
        warnings: [],
        installInfo: { isUpdate: false }
      }

      // Call service function directly
      const installResult = await oneUserInstallationProcess(context)

      // Add to successful results
      results.successful.push({
        userId: userId,
        appName: installResult.appName,
        isUpdate: installResult.isUpdate,
        message: installResult.message,
        warnings: installResult.warnings || []
      })
      
      results.summary.successCount++
      results.summary.totalWarnings += (installResult.warnings?.length || 0)
      
      console.log('✅ Successfully installed app for user:', userId)
      
    } catch (error) {
      console.error('❌ Failed to install app for user:', userId, error)
      
      // Add to failed results
      results.failed.push({
        userId: userId,
        error: {
          message: error.message || 'Unknown error',
          code: error.code || 'unknown_error'
        }
      })
      
      results.summary.failureCount++
      
      // Log the error for this specific user
      res.locals.flogger.error('createContextAndInstallForManyUsers - user installation failed', {
        userId: userId,
        action: 'createContextAndInstallForManyUsers',
        appName: req.file?.originalname,
        bulkOperation: true,
        error: error.message
      })
    }
  }

  // Build final response
  const response = {
    success: results.summary.failureCount === 0,
    message: `Installation completed. ${results.summary.successCount} successful, ${results.summary.failureCount} failed.`,
    results: results,
    summary: results.summary
  }

  console.log('✅ createContextAndInstallForManyUsers - completed with summary:', response.summary)
  return response
}

/**
 * Handle install app for users action
 * Modern version of installAppForMultipleUsers from admin_handler.js
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const handleInstallAppForUsers = async (req, res) => {
  console.log('✅ installAppForMultipleUsers - request body:', req.body)
  // console.log('✅ installAppForMultipleUsers - file:', req.file)

  try {
    // Get userIds from FormData - multer parses array notation (userIds[]) as an array
    let userIds = []
    if (req.body.userIds) {
      // Multer parses array notation (userIds[]) as an array automatically
      userIds = Array.isArray(req.body.userIds) ? req.body.userIds : [req.body.userIds]
      // console.log('✅ installAppForMultipleUsers - userIds:', userIds)
    } else {
      console.error('No userIds field in request body')
      return sendFailure(res, 'No userIds provided', 'handleInstallAppForUsers', 400)
    }

    // Validate userIds
    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return sendFailure(res, 'No valid user IDs provided', 'handleInstallAppForUsers', 400)
    }

    // Call the installation function
    const results = await createContextAndInstallForManyUsers(req, res, userIds)
    
    return sendApiSuccess(res, results)
  } catch (error) {
    console.error('❌ Error in handleInstallAppForUsers:', error)
    return sendFailure(res, error, 'handleInstallAppForUsers', 500)
  }
}

/**
 * Handle change main preferences action
 * Modern async version of change_main_prefs from admin_handler.js
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const handleChangeMainPrefs = async (req, res) => {
  // console.log('✅ change_main_prefs - request body:', req.body)
  
  try {
    const userId = req.session.logged_in_user_id
    const dsManager = res.locals?.freezr?.dsManager
    const fradminDS = res.locals?.freezr?.fradminDS
    const currentPrefs = res.locals?.freezr?.freezrPrefs
    
    // 1. Basic authentication checks    
    if (!dsManager || !fradminDS || !currentPrefs) {
      return sendFailure(res, 'Required resources not available', 'handleChangeMainPrefs', 500)
    }
    
    // 2. Check if password or temporary setup token is provided
    // freezrPrefsTempPw is used during initial setup to allow changing prefs without re-entering password
    // It's valid for 10 minutes after first registration
    const hasTempToken = req.freezrPrefsTempPw && req.session.freezrPrefsTempPw
    const hasPassword = req.body.password
    
    if (!hasPassword && !hasTempToken) {
      return sendFailure(res, 'Password or setup token is required', 'handleChangeMainPrefs', 400)
    }
    
    // 3. Validate authentication (either temp token or password)
    if (hasTempToken) {
      const timeConstraint = 10 * 60 * 1000 // 10 minutes
      const tokenValid = req.freezrPrefsTempPw.pw === req.session.freezrPrefsTempPw &&
                        req.freezrPrefsTempPw.timestamp > (new Date().getTime() - timeConstraint)
      
      if (!tokenValid) {
        return sendAuthFailure(res, {
          type: 'invalidTempToken',
          message: 'Temporary setup token is invalid or expired',
          path: req.path,
          url: req.url,
          error: 'Invalid temporary setup token in handleChangeMainPrefs',
          statusCode: 401
        })
      }
      
      // Clear the temp token after use
      req.freezrPrefsTempPw = null
      req.session.freezrPrefsTempPw = null
    } else {
      // Validate password
      const allUsersDb = fradminDS.getDB(USER_DB_OAC)
      if (!allUsersDb) {
        return sendFailure(res, 'Users database not available', 'handleChangeMainPrefs', 500)
      }
      
      const userInfo = await allUsersDb.query({ user_id: userId }) // .read_by_id(userId)
      if (!userInfo || userInfo.length === 0) {
        return sendAuthFailure(res, {
          type: 'userNotFound',
          message: 'User not found',
          path: req.path,
          url: req.url,
          error: 'User not found in handleChangeMainPrefs',
          statusCode: 404
        })
      }

      const user = new User(userInfo[0])
      if (!user.check_passwordSync(req.body.password)) {
        return sendAuthFailure(res, {
          type: 'invalidPassword',
          message: 'Invalid password',
          path: req.path,
          url: req.url,
          error: 'Invalid password in handleChangeMainPrefs',
          statusCode: 401
        })
      } else if (!user.isAdmin) {
        return sendAuthFailure(res, {
          type: 'onlyAdminUsersCanChangePreferences',
          message: 'Only admin users can change preferences',
          path: req.path,
          url: req.url,
          error: 'Only admin users can change preferences in handleChangeMainPrefs',
          statusCode: 403
        })
      }
    }
    
    // 4. Sanitize and prepare new preferences
    const newPrefs = {}
    Object.keys(DEFAULT_PREFS).forEach((key) => {
      newPrefs[key] = req.body[key] !== undefined ? req.body[key] : DEFAULT_PREFS[key]
    })
    
    // Trim string fields
    if (newPrefs.public_landing_page) {
      newPrefs.public_landing_page = newPrefs.public_landing_page.trim()
    }
    if (newPrefs.public_landing_app) {
      newPrefs.public_landing_app = newPrefs.public_landing_app.trim()
    }
    
    // 5. Save preferences to database
    const paramsDb = fradminDS.getDB(PARAMS_OAC)
    if (!paramsDb) {
      return sendFailure(res, 'Params database not available', 'handleChangeMainPrefs', 500)
    }
    
    await getOrSetPrefs(paramsDb, 'main_prefs', newPrefs, true)
    
    // 6. Check if dbUnificationStrategy changed - if so, reinitialize databases
    if (newPrefs.dbUnificationStrategy !== currentPrefs.dbUnificationStrategy) {
      console.log('🔄 dbUnificationStrategy changed - reinitializing databases')
      
      // Clear all user datastores to force re-initialization with new strategy
      dsManager.users = {}
      
      // Reinitialize admin databases with new preferences
      await dsManager.initAdminDBs(dsManager.systemEnvironment, newPrefs)
      
      // Reinitialize the current user's datastore
      await dsManager.getOrSetUserDS(userId, { freezrPrefs: newPrefs })
    }
    
    // 7. Update response locals with new preferences
    newPrefs.freezrVersion = newPrefs.freezrVersion
    
    // Clear existing properties and copy new ones (mutate in place)

    // Object.assign(res.locals.freezrPrefs, newPrefs)
    Object.keys(res.locals.freezr.freezrPrefs).forEach(key => {
      delete res.locals.freezr.freezrPrefs[key]
    })
    Object.assign(res.locals.freezr.freezrPrefs, newPrefs)
    
    res.locals.freezr.permGiven = true

    // console.log('🔄 handleChangeMainPrefs - newPrefs:', {newPrefs, check: res.locals.freezr.freezrPrefs})
    
    return sendApiSuccess(res, { 
      message: 'Main preferences changed successfully',
      preferences: res.locals.freezr.freezrPrefs
    })
    
  } catch (error) {
    console.error('❌ Error in handleChangeMainPrefs:', error)
    return sendFailure(res, error, 'handleChangeMainPrefs', 500)
  }
}

/**
 * Handle get cache preferences action
 * GET /adminapi/get_cache_prefs
 */
const handleGetCachePrefs = async (req, res) => {
  try {
    const dsManager = res.locals?.freezr?.dsManager
    if (!dsManager || !dsManager.cacheManager) {
      return sendFailure(res, 'Cache manager not available', 'handleGetCachePrefs', 500)
    }
    const cachePrefs = dsManager.cacheManager.getCachePrefs()
    return sendApiSuccess(res, { cachePrefs })
  } catch (error) {
    console.error('Error in handleGetCachePrefs:', error)
    return sendFailure(res, error, 'handleGetCachePrefs', 500)
  }
}

/**
 * Handle get cache stats action
 * GET /adminapi/get_cache_stats
 */
const handleGetCacheStats = async (req, res) => {
  try {
    const dsManager = res.locals?.freezr?.dsManager
    if (!dsManager || !dsManager.cacheManager) {
      return sendFailure(res, 'Cache manager not available', 'handleGetCacheStats', 500)
    }
    const stats = dsManager.cacheManager.getStats()
    return sendApiSuccess(res, { stats })
  } catch (error) {
    console.error('Error in handleGetCacheStats:', error)
    return sendFailure(res, error, 'handleGetCacheStats', 500)
  }
}

/**
 * Handle set cache preferences action
 * POST /adminapi/set_cache_prefs body: { cachePrefs: { ALL_USERS: {}, USER_SPECIFIC: {} } }
 */
const handleSetCachePrefs = async (req, res) => {
  try {
    const dsManager = res.locals?.freezr?.dsManager
    if (!dsManager || !dsManager.cacheManager) {
      return sendFailure(res, 'Cache manager not available', 'handleSetCachePrefs', 500)
    }

    const newPrefs = req.body?.cachePrefs
    if (!newPrefs || typeof newPrefs !== 'object') {
      return sendFailure(res, 'Missing or invalid cachePrefs object', 'handleSetCachePrefs', 400)
    }

    // Validate structure
    if (!newPrefs.ALL_USERS || typeof newPrefs.ALL_USERS !== 'object') {
      newPrefs.ALL_USERS = {}
    }
    if (!newPrefs.USER_SPECIFIC || typeof newPrefs.USER_SPECIFIC !== 'object') {
      newPrefs.USER_SPECIFIC = {}
    }

    // updateCachePrefs is now async - it writes to fradmin user files
    const updatedPrefs = await dsManager.cacheManager.updateCachePrefs(newPrefs)
    return sendApiSuccess(res, { cachePrefs: updatedPrefs })
  } catch (error) {
    console.error('Error in handleSetCachePrefs:', error)
    return sendFailure(res, error, 'handleSetCachePrefs', 500)
  }
}

/**
 * Handle get mongo connection stats action
 * GET /adminapi/get_mongo_connection_stats
 */
const handleGetMongoConnectionStats = async (req, res) => {
  try {
    const stats = getConnectionStats()
    return sendApiSuccess(res, { stats })
  } catch (error) {
    console.error('Error in handleGetMongoConnectionStats:', error)
    return sendFailure(res, error, 'handleGetMongoConnectionStats', 500)
  }
}

/**
 * Handle clear all caches action
 * POST /adminapi/clear_all_caches
 */
const handleClearAllCaches = async (req, res) => {
  try {
    const dsManager = res.locals?.freezr?.dsManager
    if (!dsManager || !dsManager.cacheManager) {
      return sendFailure(res, 'Cache manager not available', 'handleClearAllCaches', 500)
    }
    dsManager.cacheManager.clearAll()
    const stats = dsManager.cacheManager.getStats()
    return sendApiSuccess(res, { message: 'All caches cleared', stats })
  } catch (error) {
    console.error('Error in handleClearAllCaches:', error)
    return sendFailure(res, error, 'handleClearAllCaches', 500)
  }
}

/**
 * Handle get console-log flags action
 * GET /adminapi/get_console_flags
 * Returns the in-memory console-log category toggles (reset to off on restart).
 */
const handleGetConsoleFlags = async (req, res) => {
  try {
    return sendApiSuccess(res, {
      flags: freezrConsole.flags,
      serverStartedAt: freezrConsole.serverStartedAt,
      categories: CONSOLE_CATEGORIES
    })
  } catch (error) {
    console.error('Error in handleGetConsoleFlags:', error)
    return sendFailure(res, error, 'handleGetConsoleFlags', 500)
  }
}

/**
 * Handle set console-log flags action
 * POST /adminapi/set_console_flags body: { flags: { cachemgmt: true } }
 * Only known categories are applied; values are coerced to boolean. Not persisted.
 */
const handleSetConsoleFlags = async (req, res) => {
  try {
    const incoming = req.body?.flags
    if (!incoming || typeof incoming !== 'object') {
      return sendFailure(res, 'Missing or invalid flags object', 'handleSetConsoleFlags', 400)
    }
    CONSOLE_CATEGORIES.forEach(({ key }) => {
      if (Object.prototype.hasOwnProperty.call(incoming, key)) {
        freezrConsole.flags[key] = !!incoming[key]
      }
    })
    return sendApiSuccess(res, {
      flags: freezrConsole.flags,
      serverStartedAt: freezrConsole.serverStartedAt
    })
  } catch (error) {
    console.error('Error in handleSetConsoleFlags:', error)
    return sendFailure(res, error, 'handleSetConsoleFlags', 500)
  }
}

/**
 * Handle admin API action
 * Routes to specific action handlers based on action parameter
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
// ===== TRUSTED JOBS (local job install) =====

/**
 * GET /adminapi/list_app_jobs
 * Traverse the admin's installed apps and list the jobs they declare, with trust status.
 */
const handleListAppJobs = async (req, res) => {
  try {
    const dsManager = res.locals.freezr?.dsManager
    const freezrPrefs = res.locals.freezr?.freezrPrefs
    if (!dsManager || !freezrPrefs) return sendFailure(res, 'dsManager or freezrPrefs not available', 'handleListAppJobs', 500)
    const adminId = req.session.logged_in_user_id

    const appListDb = await dsManager.getorInitDb(userAppListOAC(adminId), { freezrPrefs })
    const apps = (await appListDb.query({}, {})) || []
    const trustedJobsDb = await dsManager.getorInitDb(TRUSTED_JOBS_OAC, { freezrPrefs })
    const trusted = await listTrustedJobs(trustedJobsDb)
    const trustedFor = (app, name) => trusted.find(t => t.app_name === app && t.job_name === name && t.trusted)

    const out = []
    for (const app of apps) {
      const jobs = app.manifest?.jobs || []
      if (!jobs.length) continue
      out.push({
        app_name: app.app_name,
        display_name: app.manifest?.display_name || app.app_name,
        jobs: jobs.map(j => {
          const t = trustedFor(app.app_name, j.name)
          return {
            name: j.name,
            schedule: j.schedule || null,
            maxRuntime: j.maxRuntime || null,
            description: j.description || null,
            trusted: !!t,
            audience: t ? t.audience : null
          }
        })
      })
    }
    return sendApiSuccess(res, { apps: out })
  } catch (error) {
    console.error('❌ Error in handleListAppJobs:', error)
    return sendFailure(res, error, 'handleListAppJobs', 500)
  }
}

/**
 * POST /adminapi/trust_job  { app_name, job_name, audience }
 * Copy the job's code from the admin's installed app into users_jobs/<app>/<name>/index.mjs
 * and write the trust record (with audience). This is the "install a trusted job" action.
 */
const handleTrustJob = async (req, res) => {
  try {
    const dsManager = res.locals.freezr?.dsManager
    const freezrPrefs = res.locals.freezr?.freezrPrefs
    if (!dsManager || !freezrPrefs) return sendFailure(res, 'dsManager or freezrPrefs not available', 'handleTrustJob', 500)
    const adminId = req.session.logged_in_user_id

    const appName = req.body?.app_name
    const jobName = req.body?.job_name
    const audience = req.body?.audience || 'admins'
    if (!appName || !jobName) return sendFailure(res, 'app_name and job_name required', 'handleTrustJob', 400)
    if (!/^[a-zA-Z0-9._-]+$/.test(jobName) || jobName.includes('..')) return sendFailure(res, 'invalid job_name', 'handleTrustJob', 400)

    // Copy the approved job code into the trusted-jobs dir the local runner loads from. Prefer the
    // per-job zip built at install (jobs/<name>.zip) — it carries the WHOLE folder (index.mjs +
    // package.json + node_modules), so a trusted Tier-2 job runs WITH its dependencies. Fall back to
    // the single index.mjs for apps installed before the zip existed.
    const userDS = await dsManager.getOrSetUserDS(adminId, { freezrPrefs })
    const appFS = await userDS.getorInitAppFS(appName, {})

    // Materialize the admin-approved copy into the local users_jobs cache (full folder incl.
    // node_modules if a bundle, else single index.mjs). Sources from THIS admin's appFS — the same
    // approved copy the startup rebuild uses, so the trust snapshot is consistent across restarts.
    const mat = await materializeJobToCache({ appFS, app: appName, name: jobName })
    if (!mat.ok) return sendFailure(res, 'job code missing or unreadable (got an empty or non-JS response from app storage — try re-installing the app)', 'handleTrustJob', 400)
    const filesWritten = mat.files
    const usedZip = mat.usedZip

    // Stamp the approved code's identity so a later re-install that CHANGES the code disables this
    // trust (the admin must re-review). Computed from the same appFS the code was materialized from.
    const codeId = await jobCodeIdentity(appFS, jobName)
    const trustedJobsDb = await dsManager.getorInitDb(TRUSTED_JOBS_OAC, { freezrPrefs })
    const rec = await trustJob(trustedJobsDb, { appName, jobName, audience, installedBy: adminId, codeId })
    bjLog('🔎 TMPJOBLOG 🔒 trusted ' + appName + '/' + jobName + ' (' + (usedZip ? 'full folder' : 'index.mjs only') + ', ' + filesWritten + ' file(s)) audience=' + rec.audience + ' codeId=' + (codeId ? codeId.slice(0, 8) : 'n/a'))
    return sendApiSuccess(res, { trusted: true, app_name: appName, job_name: jobName, audience: rec.audience, files: filesWritten, withDeps: usedZip })
  } catch (error) {
    console.error('❌ Error in handleTrustJob:', error)
    return sendFailure(res, error, 'handleTrustJob', 500)
  }
}

/**
 * POST /adminapi/untrust_job  { app_name, job_name }
 * Remove the trust record and the installed code copy.
 */
const handleUntrustJob = async (req, res) => {
  try {
    const dsManager = res.locals.freezr?.dsManager
    const freezrPrefs = res.locals.freezr?.freezrPrefs
    if (!dsManager || !freezrPrefs) return sendFailure(res, 'dsManager or freezrPrefs not available', 'handleUntrustJob', 500)
    const appName = req.body?.app_name
    const jobName = req.body?.job_name
    if (!appName || !jobName) return sendFailure(res, 'app_name and job_name required', 'handleUntrustJob', 400)

    const trustedJobsDb = await dsManager.getorInitDb(TRUSTED_JOBS_OAC, { freezrPrefs })
    await untrustJob(trustedJobsDb, appName, jobName)
    try { await rm(dirname(jobCodePath(appName, jobName)), { recursive: true, force: true }) } catch (e) { /* best effort */ }
    return sendApiSuccess(res, { untrusted: true, app_name: appName, job_name: jobName })
  } catch (error) {
    console.error('❌ Error in handleUntrustJob:', error)
    return sendFailure(res, error, 'handleUntrustJob', 500)
  }
}

// ===== SCHEDULED JOBS (visibility + manual tick) =====

/**
 * GET /adminapi/list_scheduled_jobs — every scheduled-jobs row (all users), for the admin
 * "Scheduled Jobs" page. Shows next-run time, last status + why a job is waiting/failing.
 */
const handleListScheduledJobs = async (req, res) => {
  try {
    const dsManager = res.locals.freezr?.dsManager
    const freezrPrefs = res.locals.freezr?.freezrPrefs
    if (!dsManager || !freezrPrefs) return sendFailure(res, 'dsManager or freezrPrefs not available', 'handleListScheduledJobs', 500)
    const db = await dsManager.getorInitDb(SCHEDULED_JOBS_OAC, { freezrPrefs })
    const rows = (await db.query({}, {})) || []
    const now = Date.now()
    const jobs = rows.map(r => ({
      user: r.owner_id,
      app: r.app_name,
      job: r.job_name,
      schedule: r.schedule,
      enabled: r.enabled !== false,
      last_status: r.last_status || null,
      last_error: r.last_error || null,
      consecutive_failures: r.consecutive_failures || 0,
      maxRuntime: r.maxRuntime || null,
      next_run_at: r.next_run_at || null,
      next_run_iso: r.next_run_at ? new Date(r.next_run_at).toISOString() : null,
      due_in_seconds: (typeof r.next_run_at === 'number') ? Math.round((r.next_run_at - now) / 1000) : null,
      last_run_iso: r.last_run_at ? new Date(r.last_run_at).toISOString() : null
    })).sort((a, b) => (a.next_run_at || 0) - (b.next_run_at || 0))
    return sendApiSuccess(res, { scheduler_disabled: !!freezrPrefs.scheduler_disabled, now, jobs })
  } catch (error) {
    console.error('❌ Error in handleListScheduledJobs:', error)
    return sendFailure(res, error, 'handleListScheduledJobs', 500)
  }
}

/**
 * POST /adminapi/run_scheduler_now — force one scheduler tick now (debug; no waiting for the
 * heartbeat). Returns what ran (incl. waiting reasons).
 */
const handleRunSchedulerNow = async (req, res) => {
  try {
    const dsManager = res.locals.freezr?.dsManager
    const freezrPrefs = res.locals.freezr?.freezrPrefs
    const freezrStatus = res.locals.freezr?.freezrStatus
    if (!dsManager || !freezrPrefs) return sendFailure(res, 'dsManager or freezrPrefs not available', 'handleRunSchedulerNow', 500)
    const { createScheduler } = await import('../../jobs/scheduler.mjs')
    const out = await createScheduler({ dsManager, freezrPrefs, freezrStatus, logManager: res.locals.freezr?.logManager }).tick()
    return sendApiSuccess(res, out)
  } catch (error) {
    console.error('❌ Error in handleRunSchedulerNow:', error)
    return sendFailure(res, error, 'handleRunSchedulerNow', 500)
  }
}

const handleAdminAction = async (req, res) => {
  try {
    const action = req.params.action
    
    if (!action) {
      return sendFailure(res, 'Action parameter is required', 'handleAdminAction', 400)
    }
    // Check if user is admin - redundant check just in case
    if (!req.session?.logged_in_user_id || !req.session.logged_in_as_admin) {
      return sendAuthFailure(res, {
        type: 'adminAccessRequired',
        message: 'Admin access required',
        path: req.path,
        url: req.url,
        error: 'Admin access required in handleAdminAction',
        statusCode: 403
      })
    }
    res.locals.freezr.permGiven = true
    // Route to specific action handler
    switch (action) {
      case 'getuserappresources':
        return await handleGetUserAppResources(req, res)
      case 'list_users':
        return await handleListUsers(req, res)
      case 'install_app_for_users':
        return await handleInstallAppForUsers(req, res)
      case 'change_main_prefs':
        return await handleChangeMainPrefs(req, res)
      case 'reset_user_password':
        return await handleResetUserPassword(req, res)
      case 'update_user_limits':
        return await handleUpdateUserLimits(req, res)
      case 'change_user_rights':
        return await handleChangeUserRights(req, res)
      case 'delete_users':
        return await handleDeleteUsers(req, res)
      case 'get_cache_prefs':
        return await handleGetCachePrefs(req, res)
      case 'get_cache_stats':
        return await handleGetCacheStats(req, res)
      case 'get_mongo_connection_stats':
        return await handleGetMongoConnectionStats(req, res)
      case 'set_cache_prefs':
        return await handleSetCachePrefs(req, res)
      case 'clear_all_caches':
        return await handleClearAllCaches(req, res)
      case 'get_console_flags':
        return await handleGetConsoleFlags(req, res)
      case 'set_console_flags':
        return await handleSetConsoleFlags(req, res)
      case 'list_app_jobs':
        return await handleListAppJobs(req, res)
      case 'trust_job':
        return await handleTrustJob(req, res)
      case 'untrust_job':
        return await handleUntrustJob(req, res)
      case 'list_scheduled_jobs':
        return await handleListScheduledJobs(req, res)
      case 'run_scheduler_now':
        return await handleRunSchedulerNow(req, res)
      default:
        return sendFailure(res, `Unknown action: ${action}`, 'handleAdminAction', 404)
    }
    
  } catch (error) {
    console.error('❌ Error in handleAdminAction:', error)
    return sendFailure(res, error, 'handleAdminAction', 500)
  }
}

/**
 * Factory function to create admin API controller
 * Returns an object with handler functions
 * 
 * @returns {Object} Controller with handler functions
 */
export const createAdminApiController = () => {
  return {
    handleAdminAction,
    handleGetUserAppResources
  }
}

export default createAdminApiController

