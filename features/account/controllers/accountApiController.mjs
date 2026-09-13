// freezr.info - Modern ES6 Module - Account API Controller
// Implements API endpoints for account actions (JSON), separate from page rendering

import fs from 'fs'
import path from 'path'
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
import { OAUTH_PROVIDERS } from '../../oauth/services/providers/index.mjs'
import { ensureContextDoc } from '../../creator/controllers/creatorApiController.mjs'
import { identityOf, stampEdit } from '../../../common/helpers/provenance.mjs'
import { decryptResourceSensitiveFields } from '../services/resourceCrypto.mjs'
import { queryTallies, summarizeTallies, resolveRange } from '../services/usageTallyService.mjs'

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
    if (isSystemApp(appName)) {
      return sendFailure(res, 'Cannot generate app password for a system app', 'accountApiController.generateAppPassword', 403)
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

const DEV_ACCESS_FILE_NAME = '.freezr-access.local.json'

/**
 * Generate a long-lived dev app token and write it into the app folder's
 * .freezr-access.local.json, for programmatic verification by dev tools
 * (e.g. Claude Code) working inside the app repo. Local file systems only.
 * Also ensures the file is listed in the app folder's .gitignore.
 *
 * Uses the same token machinery as generateAppPassword (expiry:null → server
 * cap, currently 6 months). The freshly minted app_token is directly usable
 * as a Bearer token on /ceps and /feps data routes.
 *
 * Dependencies expected from middleware chain:
 * - req.session.logged_in_user_id, req.session.device_code
 * - res.locals.freezr.appTokenDb (from addTokenDb)
 * - res.locals.freezr.userDS (from createAddUserDSAndAppFS)
 */
const generateDevAccessFileController = async (req, res) => {
  try {
    const userId = req.session?.logged_in_user_id
    if (!userId) {
      return sendFailure(res, 'Missing user id', 'accountApiController.generateDevAccessFile', 401)
    }
    const appName = req.body?.app_name
    if (!appName) {
      return sendFailure(res, 'Missing app name', 'accountApiController.generateDevAccessFile', 400)
    }
    if (!validAppName(appName) || isSystemApp(appName)) {
      return sendFailure(res, 'Cannot generate dev access tokens for this app name', 'accountApiController.generateDevAccessFile', 403)
    }

    const tokenDb = res.locals?.freezr?.appTokenDb
    if (!tokenDb) {
      return sendFailure(res, 'App token database not available', 'accountApiController.generateDevAccessFile', 500)
    }
    const userDS = res.locals?.freezr?.userDS
    if (!userDS) {
      return sendFailure(res, 'User data store not available', 'accountApiController.generateDevAccessFile', 500)
    }

    const appFS = await userDS.getorInitAppFS(appName, {})
    const fsType = appFS?.fsParams?.type
    if (fsType !== 'local' && fsType !== 'glitch') {
      return sendFailure(res, 'Dev access files can only be written for apps stored on the local file system', 'accountApiController.generateDevAccessFile', 400)
    }

    const appPath = (appFS.fsParams.rootFolder || FREEZR_USER_FILES_DIR) + '/' + userId + '/apps/' + appName
    try {
      const stat = await fs.promises.stat(appPath)
      if (!stat.isDirectory()) throw new Error('not a directory')
    } catch (e) {
      return sendFailure(res, 'App folder not found: ' + appPath, 'accountApiController.generateDevAccessFile', 404)
    }

    // Mint via the existing token path; expiry null → server cap (max allowed)
    const { app_password: appPassword } = await generateAndSaveAppPasswordForUser(tokenDb, userId, appName, {
      deviceCode: req.session.device_code,
      expiry: null,
      oneDevice: false
    })
    const tokenRecords = await tokenDb.query({ app_password: appPassword }, {})
    if (!tokenRecords || tokenRecords.length === 0 || !tokenRecords[0].app_token) {
      return sendFailure(res, 'Could not retrieve newly created app token', 'accountApiController.generateDevAccessFile', 500)
    }
    const appToken = tokenRecords[0].app_token
    const appTokenExpires = new Date(tokenRecords[0].expiry).toISOString()

    const baseUrl = (startsWithOneOf(req.headers.host, ['localhost']) ? 'http' : 'https') + '://' + req.headers.host
    const exampleTable = appName + '.<collection>'

    // Preserve any custom fields if the file already exists
    const accessFilePath = path.join(appPath, DEV_ACCESS_FILE_NAME)
    let existing = {}
    try {
      existing = JSON.parse(await fs.promises.readFile(accessFilePath, 'utf8'))
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) existing = {}
    } catch (e) { /* no existing file or unparseable - start fresh */ }

    const fileContent = {
      ...existing,
      _comment: 'Local dev access tokens for programmatic verification (e.g. Claude Code). NEVER commit - this file must stay gitignored.',
      baseUrl,
      userId,
      appName,
      appToken,
      appTokenExpires,
      accountsToken: null, // account-path actions (app reinstall) are session-cookie-only; see examples.updateAppFromCode
      accountsTokenExpires: null,
      examples: {
        queryTable: 'curl -s -X POST "' + baseUrl + '/ceps/query/' + exampleTable + '" -H "Authorization: Bearer ' + appToken + '" -H "Content-Type: application/json" -d \'{"count":5}\'',
        writeRecord: 'curl -s -X POST "' + baseUrl + '/ceps/write/' + exampleTable + '" -H "Authorization: Bearer ' + appToken + '" -H "Content-Type: application/json" -d \'{"exampleField":"exampleValue"}\'',
        updateAppFromCode: 'manual only - open ' + baseUrl + '/account/home?devUpdateApp=' + appName + ' in a logged-in browser (pre-selects this app on the Dev tab), then press "Regenerate App from Files"'
      },
      howToRegenerate: 'Open ' + baseUrl + '/account/home in a logged-in browser (user ' + userId + '), go to "Install Existing Apps" > Dev tab, select ' + appName + ' and press "Regenerate Tokens for App". That overwrites this file with fresh tokens (max expiry is set by the server, currently 6 months).'
    }
    await fs.promises.writeFile(accessFilePath, JSON.stringify(fileContent, null, 2) + '\n')

    // Ensure the access file is gitignored in the app folder
    const gitignorePath = path.join(appPath, '.gitignore')
    let gitignoreUpdated = false
    let gitignoreContent = ''
    try {
      gitignoreContent = await fs.promises.readFile(gitignorePath, 'utf8')
    } catch (e) { /* no .gitignore yet */ }
    const gitignoreLines = gitignoreContent.split('\n').map(l => l.trim())
    if (!gitignoreLines.includes(DEV_ACCESS_FILE_NAME)) {
      const newContent = gitignoreContent.length > 0
        ? gitignoreContent.replace(/\n*$/, '\n') + DEV_ACCESS_FILE_NAME + '\n'
        : DEV_ACCESS_FILE_NAME + '\n'
      await fs.promises.writeFile(gitignorePath, newContent)
      gitignoreUpdated = true
    }

    // Token itself is deliberately NOT returned - it lives in the file only
    return sendApiSuccess(res, {
      success: true,
      appName,
      filePath: accessFilePath,
      appTokenExpires,
      gitignoreUpdated
    })
  } catch (error) {
    console.error('❌ Error in generateDevAccessFile:', error)
    return sendFailure(res, error, 'accountApiController.generateDevAccessFile', 500)
  }
}

/**
 * Refresh the app folder's copy of freezr-context.md (LLM/dev guidance doc)
 * from the freezr-shipped master. Used by the Dev tab's "(re)Generate context
 * file for LLMs" button. Works on any app FS type (uses appFS read/write).
 *
 * Dependencies expected from middleware chain:
 * - req.session.logged_in_user_id
 * - res.locals.freezr.userDS (from createAddUserDSAndAppFS)
 */
const generateDevContextFileController = async (req, res) => {
  try {
    const userId = req.session?.logged_in_user_id
    if (!userId) {
      return sendFailure(res, 'Missing user id', 'accountApiController.generateDevContextFile', 401)
    }
    const appName = req.body?.app_name
    if (!appName) {
      return sendFailure(res, 'Missing app name', 'accountApiController.generateDevContextFile', 400)
    }
    if (!validAppName(appName) || isSystemApp(appName)) {
      return sendFailure(res, 'Cannot generate a context file for this app name', 'accountApiController.generateDevContextFile', 403)
    }
    const userDS = res.locals?.freezr?.userDS
    if (!userDS) {
      return sendFailure(res, 'User data store not available', 'accountApiController.generateDevContextFile', 500)
    }

    const appFS = await userDS.getorInitAppFS(appName, {})
    const result = await ensureContextDoc(appFS)
    if (result.action === 'skipped') {
      return sendFailure(res, 'Could not write context file: ' + (result.reason || 'unknown reason'), 'accountApiController.generateDevContextFile', 500)
    }
    return sendApiSuccess(res, { success: true, appName, action: result.action })
  } catch (error) {
    console.error('❌ Error in generateDevContextFile:', error)
    return sendFailure(res, error, 'accountApiController.generateDevContextFile', 500)
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
 * - req.params.getAction (getAppList, getUserPrefs, getAppResourceUsage, getUsageTallies, getlogs)
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
      case 'getUsageTallies':
        return await handleGetUsageTallies(req, res)
      case 'getlogs':
        return await handleGetLogs(req, res)
      case 'getLocalLlmCliStatus':
        return await handleGetLocalLlmCliStatus(req, res)
      default:
        return sendFailure(res, 'Invalid action', 'accountApiController.handleGettingAccountInfo', 400)
    }
  } catch (error) {
    return sendFailure(res, error, 'accountApiController.handleGettingAccountInfo', 500)
  }
}

/**
 * Eligibility snapshot for the ClaudeLocal (local Claude Code CLI) LLM connector, for the
 * Account Resources page: whether the admin master pref is on, whether THIS user is an
 * admin, and whether a runnable `claude` binary exists on this host. Read-only — the
 * use-time enforcement lives in llmContext.mjs regardless of what this reports.
 */
const handleGetLocalLlmCliStatus = async (req, res) => {
  const freezrPrefs = res.locals?.freezr?.freezrPrefs || {}
  let claudePath = null
  let codexPath = null
  try {
    const { findClaudeBinary } = await import('../../../adapters/llmConnectors/claudeLocal.mjs')
    claudePath = findClaudeBinary()
  } catch (e) {
    console.warn('Could not probe for claude CLI binary:', e.message)
  }
  try {
    const { findCodexBinary } = await import('../../../adapters/llmConnectors/codexLocal.mjs')
    codexPath = findCodexBinary()
  } catch (e) {
    console.warn('Could not probe for codex CLI binary:', e.message)
  }
  const { localAgentsAllowedEverywhere, LOCAL_AGENT_ALLOWED_APPS } = await import('../../../common/helpers/localAgentPolicy.mjs')
  return sendApiSuccess(res, {
    enabled: !!freezrPrefs.local_llm_cli_enabled,
    isAdmin: !!req.session?.logged_in_as_admin,
    // Which apps may actually USE these connectors (creator only by default) — so the
    // Resources page can say so rather than leaving a working-looking key that most apps
    // silently never see. See common/helpers/localAgentPolicy.mjs.
    allowedInAllApps: localAgentsAllowedEverywhere(),
    allowedApps: LOCAL_AGENT_ALLOWED_APPS,
    // claude fields keep their original flat names (the account page already reads them)
    binaryFound: !!claudePath,
    binaryPath: claudePath || null,
    codexBinaryFound: !!codexPath,
    codexBinaryPath: codexPath || null
  })
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
/**
 * Metered-resource usage (LLM cost/token tallies) for the logged-in user.
 *
 * GET /acctapi/getUsageTallies?from=YYYY-MM-DD&to=YYYY-MM-DD&resource=llm&app_name=...
 * Defaults to the last 30 days. Reads info.freezr.account.usageTallies, which the LLM
 * routes write via features/account/services/usageTallyService.mjs.
 */
const handleGetUsageTallies = async (req, res) => {
  const userDS = res.locals?.freezr?.userDS
  if (!userDS) {
    return sendFailure(res, 'User data store not available', 'accountApiController.handleGetUsageTallies', 500)
  }

  try {
    const { from, to } = resolveRange({ from: req.query?.from, to: req.query?.to, days: req.query?.days })
    const resource = (typeof req.query?.resource === 'string' && req.query.resource) ? req.query.resource : 'llm'
    const appName = (typeof req.query?.app_name === 'string' && req.query.app_name) ? req.query.app_name : null

    const tallyDb = await userDS.getorInitDb('info.freezr.account.usageTallies')
    const rows = await queryTallies(tallyDb, { resource, from, to, appName })

    return sendApiSuccess(res, { rows, summary: summarizeTallies(rows), from, to, resource })
  } catch (error) {
    console.error('❌ Error in handleGetUsageTallies:', error)
    return sendFailure(res, error, 'accountApiController.handleGetUsageTallies', 500)
  }
}

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

    // Destroy session completely - deletes session file and clears cookie
    // device_code will be regenerated at next login (stateless design)
    req.session.destroy((destroyErr) => {
      if (destroyErr) {
        console.error('Session destruction error during app logout:', destroyErr)
        // Continue with logout even if destruction fails
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
 * Can only be accessed by the account or creator apps
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

// NOTE: user/account removal now lives in features/account/services/accountRemoveService.mjs
// (removeUserFromServer / removeUserDataAndRecord / detachUserFromServer), shared by the
// /account/remove page and the admin delete-users flow. The old self-remove handler was removed.

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

    // Provenance: every re-install-from-files is an EDIT of the app — stamp authorship.last_modified
    // (and record a first-time foreign contributor) on the manifest BEFORE the install service reads
    // it, so the stamped manifest lands in the app-list record too. stampEdit only reports a change
    // when identity actually differs, so a same-author re-install causes no manifest churn. It never
    // auto-assigns main_author to a legacy authorless app (that is an explicit claim — see the
    // ask-app "Add me as author" flow). Non-fatal: any error here must not block the install.
    try {
      const appFSForStamp = await userDS.getorInitAppFS(appName, {})
      if (appFSForStamp && appFSForStamp.readAppFile && appFSForStamp.writeToAppFiles && !isSystemApp(appName)) {
        const manifestRaw = await appFSForStamp.readAppFile('manifest.json')
        if (manifestRaw) {
          const manifestObj = JSON.parse(manifestRaw)
          let restoredAuthorship = false
          if (!manifestObj.authorship || !manifestObj.authorship.main_author) {
            // A manifest rewrite (e.g. by the creator's LLM) may have dropped authorship — restore
            // the last-known stamp from the app-list record so lineage is never silently lost.
            const prevEntity = await userAppListDb.read_by_id(constructAppIdStringFrom(userId, appName))
            const prevAuthorship = prevEntity?.manifest?.authorship
            if (prevAuthorship && prevAuthorship.main_author) {
              manifestObj.authorship = prevAuthorship
              restoredAuthorship = true
            }
          }
          const selfHost = res.locals?.freezr?.serverName || (req.protocol + '://' + req.get('host'))
          if (stampEdit(manifestObj, identityOf(userId, selfHost)) || restoredAuthorship) {
            await appFSForStamp.writeToAppFiles('manifest.json', JSON.stringify(manifestObj, null, 2), { doNotOverWrite: false })
          }
        }
      }
    } catch (e) {
      console.warn('updateAppFromFiles: could not stamp edit provenance (continuing):', e.message)
    }

    // Create update context
    const context = {
      userId,
      realAppName: appName,
      userDS,
      ownerPermsDb,
      publicManifestsDb,
      userAppListDb,
      // fradmin-owned trusted-jobs handle — present ONLY for an admin installer (the middleware gates it);
      // lets a re-install disable the trust of a CHANGED local job. Absent → change-detection no-ops.
      trustedJobsDb: res.locals?.freezr?.trustedJobsDb || null,
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
      // fradmin-owned trusted-jobs handle — present ONLY for an admin installer (middleware-gated);
      // lets a re-install disable the trust of a CHANGED local job. Absent → change-detection no-ops.
      trustedJobsDb: res.locals?.freezr?.trustedJobsDb || null,
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

    console.log('🔄 installAppFromZipFile result:', result)

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

    // Collect any extra scoping fields the client included on `change` (e.g. the
    // use_mail picker sends connection_names + scopes). acceptNamedPermissions
    // filters these against PERMISSION_FIELD_EXCEPTIONS_BY_TYPE for the perm's
    // actual type — so passing arbitrary fields here is safe; unknown ones are
    // dropped on the server side.
    const KNOWN_NON_EXTRA_FIELDS = new Set(['name', 'action', 'requestor_app', 'table_id'])
    const extraFields = {}
    for (const k of Object.keys(change)) {
      if (!KNOWN_NON_EXTRA_FIELDS.has(k)) extraFields[k] = change[k]
    }

    // For Deny we also need userId so the service can cascade-delete the app's
    // offline tokens (so a revoked permission doesn't leave a usable token
    // sitting around until its natural 6-month expiry). Pass through locals.
    const denyLocals = { ...res.locals.freezr, userId }
    const result = (change.action === 'Accept')
      ? await acceptNamedPermissions(change.name, change.requestor_app, res.locals.freezr, extraFields)
      : await denyNamedPermissions(change.name, change.requestor_app, denyLocals)

    if (result?.success) {
      // Jobs: REVOKING a SCHEDULE_JOB permission stops any active schedule for that job. Granting it
      // is consent only — it does NOT start the schedule (the app starts it via freezr.jobs.schedule).
      // run_job is on-demand only and never touches scheduling. We read the changed perm by its unique
      // `name` to get its type + job_name (the sync keys on job_name, not the perm name). Non-fatal.
      if (res.locals.freezr.scheduledJobsDb && res.locals.freezr.ownerPermsDb) {
        try {
          const permRows = await res.locals.freezr.ownerPermsDb.query({ name: change.name, requestor_app: change.requestor_app }, {})
          const perm = permRows && permRows[0]
          if (perm && perm.type === 'schedule_job') {
            const { syncScheduleForPermissionChange } = await import('../../jobs/services/scheduledJobsService.mjs')
            await syncScheduleForPermissionChange(res.locals.freezr.scheduledJobsDb, {
              userId,
              appName: change.requestor_app,
              permType: perm.type,
              jobName: perm.job_name,
              granted: (change.action === 'Accept')
            })
          }
        } catch (e) {
          console.warn('⚠️  scheduled-job sync on permission change failed:', e && e.message)
        }
      }
      return sendApiSuccess(res, result)
    } else {
      return sendFailure(res, result?.error, 'accountApiController.changeNamedPermissionsHandler', 500)
    }

    // OLD??? 
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
    //       theQuery['_accessibles.' + grantee + '.' + fullPermName + '.granted'] = true

    //       const recs = await requesteeDb.query(theQuery, {})

    //       for (const rec of recs) {
    //         const accessible = rec._accessibles || {}
    //         const publicid = (accessible[grantee] && accessible[grantee][fullPermName] && accessible[grantee][fullPermName].public_id) 
    //           ? accessible[grantee][fullPermName].public_id 
    //           : null

    //         if (accessible[grantee] && accessible[grantee][fullPermName]) {
    //           delete accessible[grantee][fullPermName]
    //         }
    //         if (Object.keys(accessible[grantee] || {}).length === 0) {
    //           delete accessible[grantee]
    //         }

    //         await requesteeDb.update(rec._id, { _accessibles: accessible }, { replaceAllFields: false })

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
    generateDevAccessFileController,
    generateDevContextFileController,
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

/**
 * Factory: POST /acctapi/connection_disconnect
 *
 * Body: { resource_id }
 *
 * Best-effort revoke at the provider, then deletes the resource record from
 * info.freezr.account.resources. Revoke failures are logged but do not block
 * the local delete — the user's intent is "I'm done with this connection",
 * not "fail unless every external system confirms".
 *
 * Only the logged-in user can disconnect their own connections — enforced via
 * the route's loggedInGuard + isLoggedInAccountAppRequest middleware chain.
 */
export const createConnectionDisconnectHandler = ({ dsManager, freezrPrefs }) => {
  return async (req, res) => {
    try {
      const userId = req.session?.logged_in_user_id
      if (!userId) {
        return sendFailure(res, 'User not logged in', 'connectionDisconnect', 401)
      }
      const resourceId = req.body?.resource_id
      if (!resourceId) {
        return sendFailure(res, 'resource_id is required', 'connectionDisconnect', 400)
      }

      const resourcesDb = await dsManager.getorInitDb(
        { app_table: 'info.freezr.account.resources', owner: userId },
        { freezrPrefs }
      )
      if (!resourcesDb) {
        return sendFailure(res, 'Could not open user resources DB', 'connectionDisconnect', 500)
      }

      const record = await resourcesDb.read_by_id(resourceId).catch(() => null)
      if (!record) {
        return sendFailure(res, 'Connection not found', 'connectionDisconnect', 404)
      }
      if (record.type !== 'connection') {
        return sendFailure(res, 'Record is not a connection', 'connectionDisconnect', 400)
      }

      // Best-effort revoke at the provider. Decrypt the oauth sub-object first.
      let revoked = false
      try {
        const decrypted = decryptResourceSensitiveFields(record)
        const provider = OAUTH_PROVIDERS[record.provider]
        const tokenToRevoke = decrypted?.oauth?.refreshToken || decrypted?.oauth?.accessToken
        if (provider && typeof provider.revokeRefreshToken === 'function' && tokenToRevoke) {
          revoked = await provider.revokeRefreshToken({ token: tokenToRevoke })
        }
      } catch (e) {
        console.warn('connectionDisconnect: revoke step failed (continuing with local delete):', e?.message || e)
      }

      // Always delete the local record, even if revoke didn't succeed.
      await resourcesDb.delete_record(resourceId)

      // A disconnected connection must not keep receiving socket routing —
      // drop its live-registry row (no-op for non-messaging connections).
      try {
        const { unregisterLive } = await import('../../connections/messaging/services/messagingRegistry.mjs')
        await unregisterLive({ dsManager, freezrPrefs, ownerId: userId, connectionName: record.connectionName })
      } catch (e) {
        console.warn('connectionDisconnect: live-registry cleanup failed (non-fatal):', e?.message || e)
      }

      res.locals.freezr.permGiven = true
      return sendApiSuccess(res, { success: true, revoked, connectionName: record.connectionName })
    } catch (error) {
      console.error('❌ Error in connectionDisconnect:', error)
      return sendFailure(res, error, 'connectionDisconnect', 500)
    }
  }
}

/**
 * POST /acctapi/connection_set_live  body: { resource_id, live: boolean }
 *
 * The user-level (Tier 2) socket opt-in: toggles live socket-fed updates for
 * one of the user's own messaging connections. live:true resolves the
 * connection's provider identity (team + user id, using its own token) and
 * writes the server-wide live-registry row the socket manager routes against;
 * live:false removes it. The flag is also mirrored onto the connection record
 * so /account/resources can render state without touching fradmin tables.
 *
 * Note this toggle grants nothing by itself: events only flow once the admin
 * has ALSO enabled sockets (prefs + admission row + app token) — see
 * socketManager.mjs. Guarded like connection_disconnect (account app only).
 */
export const createConnectionSetLiveHandler = ({ dsManager, freezrPrefs }) => {
  return async (req, res) => {
    try {
      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'User not logged in', 'connectionSetLive', 401)
      const resourceId = req.body?.resource_id
      const live = req.body?.live === true
      if (!resourceId) return sendFailure(res, 'resource_id is required', 'connectionSetLive', 400)

      const resourcesDb = await dsManager.getorInitDb(
        { app_table: 'info.freezr.account.resources', owner: userId },
        { freezrPrefs }
      )
      if (!resourcesDb) return sendFailure(res, 'Could not open user resources DB', 'connectionSetLive', 500)

      const record = await resourcesDb.read_by_id(resourceId).catch(() => null)
      if (!record || record.type !== 'connection') {
        return sendFailure(res, 'Connection not found', 'connectionSetLive', 404)
      }
      if (!Array.isArray(record.services) || !record.services.includes('messaging')) {
        return sendFailure(res, 'Live updates only apply to messaging connections', 'connectionSetLive', 400)
      }

      const { registerLive, unregisterLive } = await import('../../connections/messaging/services/messagingRegistry.mjs')
      if (live) {
        // Throws on bad token / unresolvable identity — correctly blocking the
        // opt-in rather than writing a row that can't be routed.
        await registerLive({ dsManager, freezrPrefs, ownerId: userId, connection: record })
      } else {
        await unregisterLive({ dsManager, freezrPrefs, ownerId: userId, connectionName: record.connectionName })
      }
      await resourcesDb.update(resourceId, { live }, { replaceAllFields: false })

      // If the manager is running, pick up the change without a restart.
      try {
        const { getSocketManagerIfRunning } = await import('../../connections/messaging/services/socketManager.mjs')
        const mgr = getSocketManagerIfRunning()
        if (mgr && mgr.isRunning()) await mgr.refreshRoutes()
      } catch (e) {
        console.warn('connectionSetLive: route refresh failed (non-fatal):', e?.message || e)
      }

      res.locals.freezr.permGiven = true
      return sendApiSuccess(res, { success: true, connectionName: record.connectionName, live })
    } catch (error) {
      console.error('❌ Error in connectionSetLive:', error)
      return sendFailure(res, error, 'connectionSetLive', 500)
    }
  }
}

export default createAccountApiController


