// freezr.info - Modern ES6 Module - Admin Routes
// All routes for the admin feature
//
// Architecture Pattern:
// 1. Guards (auth checks with redirects) - from ./middleware/adminGuards.mjs
// 2. Context (feature data loading) - from ./middleware/adminContext.mjs
// 3. Controllers (request handling) - from ./controllers/*.mjs

import { Router } from 'express'
import { createSetupGuard, createAuthGuard, createOrUpdateTokenGuardFromPage } from '../../middleware/auth/basicAuth.mjs'
import { createAdminAuthGuard } from './middleware/adminGuards.mjs'
import { createAddFradminDs, createAddDsManagerAndFreezrPrefsStatus } from './middleware/adminContext.mjs'
import { createAdminPageController } from './controllers/adminPageController.mjs'
import { 
  getAdminPageManifest,
  getDefaultAdminPageManifest 
} from './services/adminManifestService.mjs'

/**
 * Create admin PAGE routes with dependency injection
 * Handles HTML page rendering for admin feature
 * 
 * @param {object} dependencies - Required dependencies
 * @param {object} dependencies.dsManager - Data store manager
 * @param {object} dependencies.freezrPrefs - Freezr preferences
 * @param {object} dependencies.freezrStatus - Freezr status
 * @returns {Router} Express router with admin page routes
 */
export const createAdminPageRoutes = ({ dsManager, freezrPrefs, freezrStatus }) => {
  const router = Router()
  
  // ===== CREATE MIDDLEWARE INSTANCES =====
  
  // Guards
  const setupGuard = createSetupGuard(dsManager)
  const adminAuthGuard = createAdminAuthGuard()
  const loggedInGuard = createAuthGuard()

  // Context middleware
  const addFradminDs = createAddFradminDs(dsManager, freezrPrefs, freezrStatus)
  const addDsManagerMiddleware = createAddDsManagerAndFreezrPrefsStatus(dsManager, freezrPrefs, freezrStatus)
  
  // Token guard for admin pages (requires admin app token)
  const pageTokenGuard = createOrUpdateTokenGuardFromPage(dsManager, { forceAppName: 'info.freezr.admin' })
  
  // ===== CREATE CONTROLLERS =====
  
  const adminPageController = createAdminPageController()
  
  // ===== MIDDLEWARE =====
  
  /**
   * Middleware to add admin page manifest to res.locals.freezr.manifest
   * Similar to addAccountManifestToResLocals in accountRoutes.mjs
   */
  const addAdminManifestToResLocals = (req, res, next) => {
    const subPage = req.params.sub_page || 'home'
    
    // Get page manifest configuration
    const pageParams = {
      sub_page: subPage,
      freezrStatus: freezrStatus,
      freezrVisitLogs: res.locals.freezr?.freezrVisitLogs,
      userid: req.params.userid
    }
    
    // Validate page parameters -> Currently all are valid

    // Get manifest configuration
    let manifest = getAdminPageManifest(pageParams, freezrStatus, res.locals.freezr.freezrPrefs)
    
    // If no manifest found, try to get default
    if (!manifest) {
      console.warn('⚠️ No manifest found for sub_page:', subPage, '- using default')
      manifest = getDefaultAdminPageManifest(subPage)
    }
    
    // Ensure res.locals.freezr exists
    if (!res.locals.freezr) {
      res.locals.freezr = {}
    }
    
    // Add manifest to res.locals
    res.locals.freezr.manifest = manifest
    
    next()
  }
  
  // ===== PAGE ROUTES =====
  
  /**
   * GET /admin
   * Default admin page (home) - must come before /:sub_page to avoid matching issues
   */
  router.get('/', setupGuard, loggedInGuard, adminAuthGuard, pageTokenGuard, addFradminDs, (req, res, next) => {
    // Set sub_page to 'home' for root admin route
    req.params.sub_page = 'home'
    next()
  }, addAdminManifestToResLocals, adminPageController.generateAdminPage)
  
  /**
   * GET /admin/:sub_page
   * Admin pages for authenticated admin users
   * Must come after specific routes like /, etc.
   */
  router.get('/:sub_page', setupGuard, loggedInGuard, adminAuthGuard, pageTokenGuard, addFradminDs, addDsManagerMiddleware, addAdminManifestToResLocals, adminPageController.generateAdminPage)
  
  return router
}

export default {
  createAdminPageRoutes
}

