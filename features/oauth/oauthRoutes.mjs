// freezr.info - Modern ES6 Module - OAuth Routes
// All routes for the OAuth feature
//
// Architecture Pattern:
// 1. Guards (auth checks) - from ../../middleware/auth/basicAuth.mjs
// 2. Context (feature data loading) - from ./middleware/oauthContext.mjs
// 3. Controllers (request handling) - from ./controllers/oauthApiController.mjs

import { Router } from 'express'
import { createSetupGuard, createAuthGuard, createGetAppTokenInfoFromheaderForApi } from '../../middleware/auth/basicAuth.mjs'
import { createAdminAuthGuardForApi } from '../admin/middleware/adminGuards.mjs'
import { createAddFradminDs } from '../admin/middleware/adminContext.mjs'
import { createAddOauthDb, createAddCacheManager } from './middleware/oauthContext.mjs'
import { createOauthApiController, createAppTokenLoginHandler } from './controllers/oauthApiController.mjs'

/**
 * Create OAuth API routes with dependency injection
 * Handles JSON API endpoints for OAuth feature
 * 
 * Routes:
 * - GET /oauth/privateapi/list_oauths - List all OAuth configurations (admin only)
 * - PUT /oauth/privateapi/oauth_perm - Create or update OAuth configuration (admin only)
 * - GET /oauth/:dowhat - Public OAuth operations (get_new_state, validate_state)
 * 
 * @param {object} dependencies - Required dependencies
 * @param {object} dependencies.dsManager - Data store manager
 * @param {object} dependencies.freezrPrefs - Freezr preferences
 * @param {object} dependencies.freezrStatus - Freezr status
 * @returns {Router} Express router with OAuth API routes
 */
export const createOauthApiRoutes = ({ dsManager, freezrPrefs, freezrStatus }) => {
  const router = Router()

  // ===== CREATE MIDDLEWARE INSTANCES =====
  
  // Guards
  const setupGuard = createSetupGuard(dsManager)
  const loggedInGuard = createAuthGuard()
  const adminAuthGuardForApi = createAdminAuthGuardForApi()
  
  // Token guard for admin API (requires admin app token)
  const getAndCheckAdminAppTokenInfo = createGetAppTokenInfoFromheaderForApi(dsManager, { ensureAppName: 'info.freezr.admin' })
  
  // Context middleware
  const addFradminDs = createAddFradminDs(dsManager, freezrPrefs, freezrStatus)
  const addOauthDb = createAddOauthDb(dsManager, freezrPrefs, freezrStatus)
  const addCacheManager = createAddCacheManager(dsManager, freezrPrefs, freezrStatus)
  
  // ===== CREATE CONTROLLERS =====
  
  const oauthApiController = createOauthApiController()
  
  // ===== ADMIN ROUTES (require authentication) =====
  
  /**
   * GET /oauth/privateapi/list_oauths
   * List all OAuth configurations
   * Admin only - used by oauth_serve_setup page
   * 
   * Middleware chain:
   * 1. setupGuard - Verify freezr is configured
   * 2. loggedInGuard - Verify user is authenticated
   * 3. adminAuthGuardForApi - Verify user is admin
   * 4. getAndCheckAdminAppTokenInfo - Verify and get admin app token
   * 5. addFradminDs - Add fradmin DS and verify admin status
   * 6. addOauthDb - Add OAuth database
   * 7. Controller - Handle the request
   */
  router.get('/privateapi/list_oauths',
    setupGuard,
    loggedInGuard,
    adminAuthGuardForApi,
    getAndCheckAdminAppTokenInfo,
    addFradminDs,
    addOauthDb,
    oauthApiController.listOauths
  )
  
  /**
   * PUT /oauth/privateapi/oauth_perm
   * Create or update OAuth configuration
   * Admin only
   */
  router.put('/privateapi/oauth_perm',
    setupGuard,
    loggedInGuard,
    adminAuthGuardForApi,
    getAndCheckAdminAppTokenInfo,
    addFradminDs,
    addOauthDb,
    oauthApiController.oauthPermMake
  )

  // ===== PUBLIC ROUTES (no authentication required) =====
  
  /**
   * POST /oauth/token
   * Exchange app password for access token
   * OAuth 2.0 password grant flow for freezr apps
   * 
   * Request body:
   * - username: User ID
   * - password: App password (from /acctapi/generateAppPassword)
   * - client_id: App name
   * - grant_type: 'password'
   * 
   * Response:
   * - access_token: The app token for API calls
   * - user_id: User ID
   * - app_name: App name
   * - expires_in: Token expiry timestamp
   */
  const appTokenLoginHandler = createAppTokenLoginHandler({ dsManager, freezrPrefs })
  
  router.post('/token',
    setupGuard,
    appTokenLoginHandler
  )
  
  /**
   * GET /oauth/:dowhat
   * Public OAuth operations
   * - get_new_state: Start OAuth flow, returns redirect URL
   * - validate_state: Validate OAuth callback and return credentials
   * 
   * Middleware chain:
   * 1. setupGuard - Verify freezr is configured
   * 2. addOauthDb - Add OAuth database 
   * 3. addCacheManager - Add OAuth database and cache manager
   * 4. Controller - Handle the request
   */
  router.get('/:dowhat',
    setupGuard,
    addOauthDb,
    addCacheManager,
    oauthApiController.publicApiActions
  )
  
  return router
}

export default {
  createOauthApiRoutes
}
