// freezr.info - Modern ES6 Module - Account Routes
// All routes for the account feature
//
// Architecture Pattern:
// 1. Guards (auth checks with redirects) - from ./middleware/accountGuards.mjs
// 2. Context (feature data loading) - from ./middleware/accountContext.mjs
// 3. Controllers (request handling) - from ./controllers/*.mjs

import { Router } from 'express'
import multer from 'multer'
import { createSetupGuard, createAuthGuard, createOrUpdateTokenGuardFromPage, createGetAppTokenInfoFromheaderForApi, createAddAppTokenInfo } from '../../middleware/auth/basicAuth.mjs'
import { createNoAuthGuard, createSystemAppGuard } from './middleware/accountGuards.mjs'
import { createLogoutAction } from './controllers/accountLogoutController.mjs'
import { createContextForLogin } from './middleware/loginContext.mjs'
import {  
  createAddUserDSAndAppFS, 
  createAddTokenDb, 
  createAddAllUsersDb, 
  createAddPublicManifestsDb, 
  createAddLogManager } from './middleware/accountContext.mjs'
import { createAddPublicRecordsDB } from '../public/middleware/publicContext.mjs'
import { createAddOwnerPermsDbForLoggedInuser } from '../../middleware/permissions/permissionContext.mjs'
import { isLoggedInAccountAppRequest, isLoggedInAccountorAdminAppRequest, noCheckNeeded } from '../../middleware/permissions/permissionCheckers.mjs'
import { createAddUserDs } from '../../features/apps/middleware/appContext.mjs'
import { createAddTrustedJobsDbIfAdmin } from '../jobs/middleware/jobsContext.mjs'
import { generateLoginPage } from './controllers/loginController.mjs'
import { createLoginApiController } from './controllers/loginApiController.mjs'
// import { createLoginPageController } from './controllers/loginPageController.mjs' // Using existing loginController.mjs instead
import { createAccountPageController } from './controllers/accountPageController.mjs'
import { createAccountApiController, createConnectionDisconnectHandler } from './controllers/accountApiController.mjs'
import { createFsMigrationController, ACTIONS_REQUIRING_USERSDB } from './controllers/fsMigrationController.mjs'
import { createDbMigrationController } from './controllers/dbMigrationController.mjs'
import { createAccountRemoveController } from './controllers/accountRemoveController.mjs'
import { createAccountResetController } from './controllers/accountResetController.mjs'
import { createMigrationLockGuard } from './middleware/migrationLockGuard.mjs'
import { 
  getAccountPageManifest, 
  validatePageParams,
  getDefaultPageManifest 
} from './services/accountManifestService.mjs'

/**
 * Create account PAGE routes with dependency injection
 * Handles HTML page rendering for account feature
 * 
 * @param {object} dependencies - Required dependencies
 * @param {object} dependencies.dsManager - Data store manager
 * @param {object} dependencies.freezrPrefs - Freezr preferences
 * @param {object} dependencies.freezrStatus - Freezr status
 * @returns {Router} Express router with account page routes
 */
export const createAccountPageRoutes = ({ dsManager, freezrPrefs, freezrStatus }) => {
  const router = Router()
  
  // ===== CREATE MIDDLEWARE INSTANCES =====
  
  // Guards (use pure checks from basicAuth.mjs + generic guard creators)
  // setupGuard - Verify freezr is configured
  const setupGuard = createSetupGuard(dsManager)
  // notLoggedInGuard - Redirect if already logged in
  const notLoggedInGuard = createNoAuthGuard('/account/home')  // For public login & register - Redirect if already logged in
  // loggedInGuard - Redirect to login if not authenticated
  const loggedInGuard = createAuthGuard('/account/login')  
  // Feature-specific context (sets res.locals.freezr)
  const loginContext = createContextForLogin(dsManager, freezrPrefs, freezrStatus)
  // getAppTokenInfo - Token validation
  const pageTokenGuard = createOrUpdateTokenGuardFromPage(dsManager, { forceAppName: 'info.freezr.account' })
  // logOutAction - Logout action
  const logOutAction = createLogoutAction(dsManager)
  // addUserDSAndAppFS - Get appFS and set up res.locals.freezr
  const addUserDSAndAppFS = createAddUserDSAndAppFS(dsManager, freezrPrefs, freezrStatus) // previous addUserAppsAndPermDBs
  // migrationLockGuard (page mode) - while a migration locks the account, redirect every
  // page except the status page to /account/migration
  const pageLockGuard = createMigrationLockGuard(dsManager, freezrPrefs, { mode: 'page' })

  // ===== CREATE CONTROLLERS =====
  
  // Page Controllers
  const accountPageController = createAccountPageController()

  // ===== MIDDLEWARE =====
  
  /**
   * Middleware to add page manifest to res.locals.freezr.manifest
   * Replicates functionality from accountPageController lines 50-65
   */
  const addAccountManifestToResLocals = (req, res, next) => {
    const page = req.params.page
    
    // Get page manifest configuration
    const pageParams = {
      page: page.toLowerCase(),
      sub_page: req.params.sub_page,
      target_app: req.params.target_app
    }
    
    // Validate page parameters
    const validation = validatePageParams(pageParams)
    if (!validation.isValid) {
      console.error('❌ Invalid page parameters:', validation.error)
      return res.redirect('/account/home')
    }
    
    // Get manifest configuration
    let manifest = getAccountPageManifest(pageParams)
    
    // If no manifest found, try to get default or redirect to home
    if (!manifest) {
      console.warn('⚠️ No manifest found for page:', page, '- using default or redirecting')
      manifest = getDefaultPageManifest(page)
    }
    
    // onsole.log('📋 Using manifest for page:', page, manifest)
    
    // Ensure res.locals.freezr exists
    if (!res.locals.freezr) {
      res.locals.freezr = {}
    }
    
    // Add manifest to res.locals
    res.locals.freezr.manifest = manifest
    
    next()
  }

  // ===== PAGE ROUTES =====

  router.get('/login', pageTokenGuard, notLoggedInGuard, setupGuard, loginContext, noCheckNeeded, generateLoginPage)
  router.get('/logout', noCheckNeeded, logOutAction)

  // From here on, a locked (migrating) account is redirected to the status page.
  router.use(pageLockGuard)

  router.get('/app/:sub_page', setupGuard, loggedInGuard, (req, res, next) => { req.params.page = 'app'; next() }, addAccountManifestToResLocals, pageTokenGuard, addUserDSAndAppFS, isLoggedInAccountAppRequest, accountPageController.generateAccountPage)
  router.get('/app/:sub_page/:target_app', setupGuard, loggedInGuard, (req, res, next) => { req.params.page = 'app'; next() }, addAccountManifestToResLocals, pageTokenGuard, addUserDSAndAppFS, isLoggedInAccountAppRequest, accountPageController.generateAccountPage)

  router.get('/:page', setupGuard, loggedInGuard, addAccountManifestToResLocals, pageTokenGuard, addUserDSAndAppFS, isLoggedInAccountAppRequest, accountPageController.generateAccountPage)
  
  return router
}



/**
 * acctapi
 * Create account API routes with dependency injection
 * Handles JSON API endpoints for account feature
 * 
 * @param {object} dependencies - Required dependencies
 * @param {object} dependencies.dsManager - Data store manager
 * @param {object} dependencies.freezrPrefs - Freezr preferences
 * @param {object} dependencies.freezrStatus - Freezr status
 * @returns {Router} Express router with account API routes
 */
export const createAcctApiRoutes = ({ dsManager, freezrPrefs, freezrStatus, logManager }) => {
  const router = Router()

  // ===== CREATE MIDDLEWARE INSTANCES =====
  const setupGuard = createSetupGuard(dsManager)
  const loggedInGuard = createAuthGuard()
  // const getAppTokenInfo = createGetAppTokenInfoFromheaderForApi(dsManager)
  const getAndCheckAccountAppTokenInfo = createGetAppTokenInfoFromheaderForApi(dsManager, { ensureAppName: 'info.freezr.account' })
  const getAndCheckAccountOrCreatorAppTokenInfo = createGetAppTokenInfoFromheaderForApi(dsManager, { ensureAppNames: ['info.freezr.account', 'info.freezr.creator'] })
  const getAndCheckAccountOrAmdinAppTokenInfo = createGetAppTokenInfoFromheaderForApi(dsManager, { ensureAppNames: ['info.freezr.account', 'info.freezr.admin'] })
  
  const addAppTokenInfo = createAddAppTokenInfo(dsManager) // for app token validation (doesn't require logged in user)
  const addUserDSAndAppFS = createAddUserDSAndAppFS(dsManager, freezrPrefs, freezrStatus) // previous addUserAppsAndPermDBs
  const addTokenDb = createAddTokenDb(dsManager, freezrPrefs, freezrStatus) // for app token operations
  const addAllUsersDb = createAddAllUsersDb(dsManager, freezrPrefs, freezrStatus) // for user database operations
  const addPublicManifestsDb = createAddPublicManifestsDb(dsManager, freezrPrefs, freezrStatus) // for public manifests database operations
  const addOwnerPermsDb = createAddOwnerPermsDbForLoggedInuser(dsManager, freezrPrefs, freezrStatus) // for user permissions database operations
  const addPublicRecordsDB = createAddPublicRecordsDB(dsManager, freezrPrefs, freezrStatus) // for public records database operations
  const addUserDs = createAddUserDs(dsManager, freezrPrefs) // for user data store operations
  const addLogManagerIfNeedBe = createAddLogManager(logManager) // for log manager operations
  // Admin-only, non-fatal: attaches the fradmin-owned trusted-jobs db so an admin re-install can
  // disable the trust of a CHANGED local job (the controller copies the handle into the install context).
  const addTrustedJobsDbIfAdmin = createAddTrustedJobsDbIfAdmin(dsManager, freezrPrefs)
  
  // Multer middleware for file uploads
  const upload = multer().single('file')

  // ===== CREATE MIDDLEWARE INSTANCES =====
    
  // ===== CREATE CONTROLLERS =====
  
  // API Controllers
  const loginApiController = createLoginApiController(dsManager)
  const accountApiController = createAccountApiController()
  const fsMigrationController = createFsMigrationController({ freezrPrefs })
  const dbMigrationController = createDbMigrationController({ freezrPrefs })
  const apiLockGuard = createMigrationLockGuard(dsManager, freezrPrefs, { mode: 'api' })

  // The users db is a powerful handle; attach it only for the fsMigration actions whose
  // handlers actually need it (the password-gated ones). Keyed off req.params.action.
  const addAllUsersDbIfNeeded = (req, res, next) => {
    if (ACTIONS_REQUIRING_USERSDB.includes(req.params.action)) return addAllUsersDb(req, res, next)
    return next()
  }

  // ===== API ROUTES =====

  router.post('/login', noCheckNeeded, loginApiController.handleLogin)
  
  router.post('/applogout', setupGuard, addAppTokenInfo, noCheckNeeded, accountApiController.userAppLogOut)

  // ===== MIGRATION ROUTES (FS + DB) =====
  // Mounted BEFORE the api lock guard so they stay reachable while the account is locked (the
  // status page polls these). GET = reads (status, fs/dbOptions); PUT = state-changing actions,
  // dispatched by :action. addAllUsersDbIfNeeded loads the users db only for the password-gated
  // actions (start, confirmDelete).
  router.get('/fsMigration/:action', setupGuard, loggedInGuard, getAndCheckAccountAppTokenInfo, isLoggedInAccountAppRequest, fsMigrationController.handleGet)
  router.put('/fsMigration/:action', setupGuard, loggedInGuard, getAndCheckAccountAppTokenInfo, addFreezrAccountAsReqParam, addAllUsersDbIfNeeded, isLoggedInAccountAppRequest, fsMigrationController.handleAction)
  router.get('/dbMigration/:action', setupGuard, loggedInGuard, getAndCheckAccountAppTokenInfo, isLoggedInAccountAppRequest, dbMigrationController.handleGet)
  router.put('/dbMigration/:action', setupGuard, loggedInGuard, getAndCheckAccountAppTokenInfo, addFreezrAccountAsReqParam, addAllUsersDbIfNeeded, isLoggedInAccountAppRequest, dbMigrationController.handleAction)

  // From here on, a locked (migrating) account gets 503 on every other acctapi call. (Previously
  // this guard sat at the very end of the router and so protected nothing.) The migration status
  // routes and login/logout above stay reachable.
  router.use(apiLockGuard)

  router.get('/generateAppPassword', setupGuard, loggedInGuard, getAndCheckAccountAppTokenInfo, addTokenDb, isLoggedInAccountAppRequest, accountApiController.generateAppPassword)

  router.post('/updateAppFromFiles', setupGuard, loggedInGuard, getAndCheckAccountAppTokenInfo, addFreezrAccountAsReqParam, addUserDSAndAppFS, addOwnerPermsDb, addPublicManifestsDb, addTrustedJobsDbIfAdmin, isLoggedInAccountAppRequest, accountApiController.updateAppFromFilesController)
  router.post('/appMgmtActions', setupGuard, loggedInGuard, getAndCheckAccountOrCreatorAppTokenInfo, addFreezrAccountAsReqParam, addUserDSAndAppFS, addPublicManifestsDb, addPublicRecordsDB, isLoggedInAccountAppRequest, accountApiController.handleAppMgmtActions)

  router.put('/app_install_from_zipfile', setupGuard, loggedInGuard, getAndCheckAccountAppTokenInfo, upload, addFreezrAccountAsReqParam, addUserDSAndAppFS, addOwnerPermsDb, addPublicRecordsDB, addTrustedJobsDbIfAdmin, isLoggedInAccountAppRequest, accountApiController.installAppFromZipFile)
  router.post('/app_install_from_url', setupGuard, loggedInGuard, getAndCheckAccountAppTokenInfo, addFreezrAccountAsReqParam, addUserDSAndAppFS, addOwnerPermsDb, addPublicRecordsDB, isLoggedInAccountAppRequest, accountApiController.installAppFromUrlController)
  router.post('/app_install_served', setupGuard, loggedInGuard, getAndCheckAccountAppTokenInfo, addFreezrAccountAsReqParam, addUserDSAndAppFS, addOwnerPermsDb, addPublicRecordsDB, isLoggedInAccountAppRequest, accountApiController.installServedAppController)

  // Connection disconnect — best-effort revoke at provider + delete resource record.
  // Mounted BEFORE the generic /:action catch-all so the specific path wins.
  const connectionDisconnectHandler = createConnectionDisconnectHandler({ dsManager, freezrPrefs })
  router.post('/connection_disconnect', setupGuard, loggedInGuard, getAndCheckAccountAppTokenInfo, addFreezrAccountAsReqParam, addUserDSAndAppFS, isLoggedInAccountAppRequest, connectionDisconnectHandler)

  router.put('/:action', setupGuard, loggedInGuard, getAndCheckAccountAppTokenInfo, addFreezrAccountAsReqParam, addAllUsersDb, addTokenDb, addUserDSAndAppFS, addPublicRecordsDB, addPublicManifestsDb, isLoggedInAccountAppRequest, accountApiController.handleAccountActions)
  router.get('/:getAction', setupGuard, loggedInGuard, getAndCheckAccountOrAmdinAppTokenInfo, addUserDs, isLoggedInAccountorAdminAppRequest, addLogManagerIfNeedBe, accountApiController.handleGettingAccountInfo)

  // ===== ACCOUNT REMOVE ROUTES =====
  // /account/remove page: removeInfo (which mode applies) + remove (password + username-confirmed).
  const accountRemoveController = createAccountRemoveController({ dsManager, freezrPrefs })
  router.get('/account/removeInfo', setupGuard, loggedInGuard, getAndCheckAccountAppTokenInfo, addFreezrAccountAsReqParam, addAllUsersDb, isLoggedInAccountAppRequest, accountRemoveController.handleRemoveInfo)
  router.put('/account/remove', setupGuard, loggedInGuard, getAndCheckAccountAppTokenInfo, addFreezrAccountAsReqParam, addAllUsersDb, addTokenDb, addUserDSAndAppFS, addPublicRecordsDB, addPublicManifestsDb, isLoggedInAccountAppRequest, accountRemoveController.handleRemove)

  // ===== ACCOUNT RESET (refresh storage credentials) ROUTES =====
  const accountResetController = createAccountResetController({ dsManager, freezrPrefs })
  router.get('/account/resetInfo', setupGuard, loggedInGuard, getAndCheckAccountAppTokenInfo, addFreezrAccountAsReqParam, addAllUsersDb, isLoggedInAccountAppRequest, accountResetController.handleResetInfo)
  router.put('/account/refreshCredentials', setupGuard, loggedInGuard, getAndCheckAccountAppTokenInfo, addFreezrAccountAsReqParam, addAllUsersDb, isLoggedInAccountAppRequest, accountResetController.handleRefresh)

  return router
}

const addFreezrAccountAsReqParam = (req, res, next) => {
  req.params.app_name = 'info.freezr.account'
  next()
}

export default { createAccountPageRoutes, createAcctApiRoutes }

