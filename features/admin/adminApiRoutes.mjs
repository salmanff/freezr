// freezr.info - Modern ES6 Module - Admin API Routes
// All API routes for the admin feature
//
// Architecture Pattern:
// 1. Guards (auth checks) - from ./middleware/adminGuards.mjs and ../../middleware/auth/basicAuth.mjs
// 2. Context (feature data loading) - from ./middleware/adminContext.mjs
// 3. Controllers (request handling) - from ./controllers/*.mjs

import { Router } from 'express'
import multer from 'multer'
import { createSetupGuard, createAuthGuard, createGetAppTokenInfoFromheaderForApi } from '../../middleware/auth/basicAuth.mjs'
import { createAdminAuthGuardForApi } from './middleware/adminGuards.mjs'
import { createAddFradminDs, createAddDsManagerAndFreezrPrefsStatus } from './middleware/adminContext.mjs'
import { createAdminApiController } from './controllers/adminApiController.mjs'

/**
 * Create admin API routes with dependency injection
 * Handles JSON API endpoints for admin feature
 * 
 * @param {object} dependencies - Required dependencies
 * @param {object} dependencies.dsManager - Data store manager
 * @param {object} dependencies.freezrPrefs - Freezr preferences (mutable object)
 * @param {object} dependencies.freezrStatus - Freezr status
 * @param {object} [dependencies.logManager] - Log manager (optional)
 * @returns {Router} Express router with admin API routes
 */
export const createAdminApiRoutes = ({ dsManager, freezrPrefs, freezrStatus, logManager }) => {
  const router = Router()

  // ===== CREATE MIDDLEWARE INSTANCES =====
  
  // Guards
  const setupGuard = createSetupGuard(dsManager)
  const loggedInGuard = createAuthGuard() // Returns 401 for API, not redirect
  const adminAuthGuardForApi = createAdminAuthGuardForApi() // Returns 401 for API, not redirect
  
  // Token guard for admin API (requires admin app token)
  const getAndCheckAdminAppTokenInfo = createGetAppTokenInfoFromheaderForApi(dsManager, { ensureAppName: 'info.freezr.admin' })
  
  // Context middleware
  const addFradminDs = createAddFradminDs(dsManager, freezrPrefs, freezrStatus)
  const addDsManagerMiddleware = createAddDsManagerAndFreezrPrefsStatus(dsManager, freezrPrefs, freezrStatus)
  
  // Multer middleware for file uploads (FormData parsing)
  const upload = multer().single('file')
  
  // Conditional upload middleware - only applies multer for file upload actions
  const uploadIfNeeded = (req, res, next) => {
    // Only use multer for install_app_for_users action (which sends FormData)
    if (req.params.action === 'install_app_for_users') {
      upload(req, res, (err) => {
        if (err) {
          console.warn('multer error:', err)
          return res.status(400).json({ success: false, error: err.message })
        }
        next()
      })
    } else {
      // For other actions, skip multer
      next()
    }
  }
  
  // ===== CREATE CONTROLLERS =====
  
  const adminApiController = createAdminApiController()
  
  // ===== API ROUTES =====
  
  /**
   * GET /adminapi/:action -> getuserappresources 
   * Admin API endpoints for various actions
   * 
   * Middleware chain:
   * 1. setupGuard - Verify freezr is configured
   * 2. loggedInGuard - Verify user is authenticated (returns 401 if not)
   * 3. adminAuthGuardForApi - Verify user is admin (returns 401 if not)
   * 4. getAndCheckAdminAppTokenInfo - Verify and get admin app token
   * 5. addFradminDs - Add fradmin DS and verify admin status
   * 6. addDsManagerMiddleware - Add dsManager and freezrPrefs/Status to context
   * 7. Controller - Handle the specific action
   */
  router.get('/:action',
    (req, res, next) => {
      const allowed = ['getuserappresources', 'list_users']
      if (!allowed.includes(req.params.action)) {
        return res.status(400).json({ success: false, error: 'Invalid admin GET action - internal error' })
      }
      next()
    },
    setupGuard, 
    loggedInGuard, 
    adminAuthGuardForApi, 
    getAndCheckAdminAppTokenInfo, 
    addFradminDs, 
    addDsManagerMiddleware, 
    adminApiController.handleAdminAction
  )

  /**
 * POST /adminapi/:action -> change_main_prefs, reset_user_password
 */
  router.post('/:action', 
    (req, res, next) => {
      const allowed = ['change_main_prefs', 'reset_user_password', 'update_user_limits', 'change_user_rights', 'delete_users']
      if (!allowed.includes(req.params.action)) {
        return res.status(400).json({ success: false, error: 'Invalid admin POST action - internal error' })
      }
      next()
    },
    setupGuard, 
    loggedInGuard, 
    adminAuthGuardForApi, 
    getAndCheckAdminAppTokenInfo, 
    addFradminDs, 
    addDsManagerMiddleware,
    uploadIfNeeded, // Conditionally applies multer for FormData parsing (file goes to req.file, other fields to req.body)
    adminApiController.handleAdminAction
  )
  
  
  /**
   * PUT /adminapi/:action -> install_app_for_users
   * Admin API endpoints for PUT actions
   * Note: For install_app_for_users, multer middleware is needed to parse FormData
   */
  router.put('/:action', 
    (req, res, next) => {
      if (req.params.action !== 'install_app_for_users') {
        return res.status(400).json({ success: false, error: 'Invalid admin PUT action - internal error' })
      }
      next()
    },
    setupGuard, 
    loggedInGuard, 
    adminAuthGuardForApi, 
    getAndCheckAdminAppTokenInfo, 
    addFradminDs, 
    addDsManagerMiddleware,
    uploadIfNeeded, // Conditionally applies multer for FormData parsing (file goes to req.file, other fields to req.body)
    adminApiController.handleAdminAction
  )
  
  /**
   * DELETE /adminapi/:action -> Not used yet
   * Admin API endpoints for DELETE actions
   */
  router.delete('/:action', 
    (req, res, next) => {
      return res.status(400).json({ success: false, error: 'Delete action not implemented yet' })
    },
    setupGuard, 
    loggedInGuard, 
    adminAuthGuardForApi, 
    getAndCheckAdminAppTokenInfo, 
    addFradminDs, 
    addDsManagerMiddleware, 
    adminApiController.handleAdminAction
  )
  
  return router
}

export default {
  createAdminApiRoutes
}

