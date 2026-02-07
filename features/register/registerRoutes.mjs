// freezr.info - Modern ES6 Module - Register Routes
// All routes for the registration feature
//
// Architecture Pattern:
// 1. Guards (auth checks with redirects) - from ./middleware/registerGuards.mjs
// 2. Context (feature data loading) - from ./middleware/registerContext.mjs
// 3. Controllers (request handling) - from ./controllers/*.mjs

import { Router } from 'express'
import { createSetupGuard, createAuthGuard } from '../../middleware/auth/basicAuth.mjs'
import { createFirstSetupGuard, createAdminAuthGuardForApi } from '../admin/middleware/adminGuards.mjs'
import { createAddPublicRecordsDB } from '../public/middleware/publicContext.mjs'
import { createAddAllUsersDb, createAddUserDSAndAppFS, createAddSystemAppFS } from '../account/middleware/accountContext.mjs'
import { createRegisterPageController } from './controllers/registerPageController.mjs'
import { createRegisterApiController } from './controllers/registerApiController.mjs'
import { createAddFreezrStatusAndDsManagerForFirstSetup, 
  addLocalManagerForFirstSetup, 
  createAddFreezrContextForSelfRegisteredNewUser 
} from './controllers/registerContext.mjs' 

/**
 * Create register PAGE routes with dependency injection
 * Handles HTML page rendering for registration feature
 * 
 * @param {object} dependencies - Required dependencies
 * @param {object} dependencies.dsManager - Data store manager
 * @param {object} dependencies.freezrPrefs - Freezr preferences
 * @param {object} dependencies.freezrStatus - Freezr status
 * @returns {Router} Express router with register page routes
 */
export const createRegisterPageRoutes = ({ dsManager, freezrPrefs, freezrStatus }) => {
  const router = Router()
  
  // ===== CREATE MIDDLEWARE INSTANCES =====
  
  // Guards
  const setupGuard = createSetupGuard(dsManager)
  const firstSetupGuard = createFirstSetupGuard(dsManager)
  const loggedInGuard = createAuthGuard('/account/login')
  
  // Context middleware
  const addSystemAppFS = createAddSystemAppFS(dsManager, freezrPrefs, freezrStatus)
  const addPublicRecordsDB = createAddPublicRecordsDB(dsManager, freezrPrefs, freezrStatus)
  const addAllUsersDb = createAddAllUsersDb(dsManager, freezrPrefs, freezrStatus)
  const addUserDSAndAppFS = createAddUserDSAndAppFS(dsManager, freezrPrefs, freezrStatus)

  const addFreezrStatusAndDsManagerForFirstSetup = createAddFreezrStatusAndDsManagerForFirstSetup(dsManager, freezrPrefs, freezrStatus)
  const addFreezrStatusForUnRegisteredUser = createAddFreezrContextForSelfRegisteredNewUser(dsManager, freezrPrefs, freezrStatus, 'unRegisteredUser')
  const addFreezrStatusForCheckResouce = createAddFreezrContextForSelfRegisteredNewUser(dsManager, freezrPrefs, freezrStatus, 'checkResource')

  // ===== CREATE CONTROLLERS =====
  
  const registerPageController = createRegisterPageController()
  const registerApiController = createRegisterApiController()
  

  // ===== PAGE ROUTES =====
  
  /**
   * GET /register/firstSetUp
   * First setup page - only accessible if freezr is NOT set up
   */
  router.get('/firstSetUp', firstSetupGuard, addFreezrStatusAndDsManagerForFirstSetup, addLocalManagerForFirstSetup, registerPageController.generateFirstSetUpPage)

  /**
   * GET /register/newparams
   * New params page - only accessible if user is incomplete
   * currently not active
   */
  // router.get('/newparams', firstSetupGuard, (req, res, next) => { 
  //   req.params.app_name = 'info.freezr.register'; next();
  // }, addUserDSAndAppFS, registerPageController.generateNewParamsPage)


  /**
   * GET /register
   * User self registration page - accessible whether logged in or not
   */
  router.get('/self', setupGuard, addFreezrStatusForUnRegisteredUser, addSystemAppFS, addPublicRecordsDB, registerPageController.generateUserSelfRegistrationPage)
  
  /**
   * GET /register/simple
   * Simple user self registration page - accessible whether logged in or not
   */
  router.get('/simple', setupGuard, addFreezrStatusForUnRegisteredUser, addSystemAppFS, addPublicRecordsDB, registerPageController.generateUserSelfRegistrationPage)


  // ===== API ROUTES =====
  // Each route has its own dedicated middleware chain for clarity and maintainability
  
  /**
   * POST /register/api/firstSetUp
   * Initial server setup - only accessible if freezr is NOT set up
   * Creates the first admin user and initializes the system
   */
  router.post('/api/firstSetUp', 
    firstSetupGuard,
    addFreezrStatusAndDsManagerForFirstSetup,
    registerApiController.handleFirstSetUp
  )

    /**
   * POST /register/api/checkresource
   * Check FS or DB resource availability
   * Used during first setup or third-party setup to validate credentials
   */
    router.post('/api/checkresource', 
      addFreezrStatusForCheckResouce, 
      registerApiController.handleCheckResource)
  
  /**
   * POST /register/api/newUserViaAdmin
   * Admin registers a new user
   * Requires: Admin authentication, freezr must be set up
   */
  router.post('/api/newUserViaAdmin',
    createAdminAuthGuardForApi(),
    addAllUsersDb,
    registerApiController.handleViaAdmin
  )

  /**
   * POST /register/api/unRegisteredUser
   * User self-registration
   * Accessible whether logged in or not (if self-registration is enabled)
   */
    router.post('/api/newselfreg',
      setupGuard,
      addFreezrStatusForUnRegisteredUser,
      addAllUsersDb,
      registerApiController.handleSelfRegister
    )

  
// ******************** NOT TESTED - UNREGISTERED USER ROUTES ********************

  /**
   * POST /register/api/newParams
   * User sets FS/DB parameters (for users created by admin but with no credentials)
   * Requires: User must be logged in - currently this gets blocked and so the chain needs to be reworked..
   * . potentially as part of a migration service to help people mvoe to their own infrastructure
   * .. so copying their data to the new infrastructure should be added to make this useful
   */
  router.post('/api/newParams',
    setupGuard,
    loggedInGuard,
    (req, res, next) => {
      console.warn('THIS HAS NOT BEEN TESTED AT ALL - TODO - register/api/newParams middleware')
      next()
    },
    addFreezrStatusForUnRegisteredUser,
    addAllUsersDb,
    registerApiController.handleNewParams
  )
  
  /**
   * POST /register/api/updateReAuthorisedFsParams
   * Re-authenticate OAuth tokens for file system (e.g., Dropbox)
   * Requires: User must be logged in
   */
  router.post('/api/updateReAuthorisedFsParams',
    setupGuard,
    loggedInGuard,
    (req, res, next) => {
      console.warn('THIS HAS NOT BEEN TESTED AT ALL - TODO - register/api/updateReAuthorisedFsParams middleware')
      next()
    },
    addAllUsersDb,
    addUserDSAndAppFS,
    registerApiController.handleReauthorizeFs
  )
    
  return router
}

export default {
  createRegisterPageRoutes
}

