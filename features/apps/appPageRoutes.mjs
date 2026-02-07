// freezr.info - Modern ES6 Module - App Page Routes
// All routes for the app page feature
/* 
* 2025-12 -> Public and App to app not included
*/
//
// Architecture Pattern:
// 1. Guards (auth checks) - from ../../middleware/auth/basicAuth.mjs
// 2. Context (feature data loading) - from ./middleware/appContext.mjs and ../../features/account/middleware/accountContext.mjs
// 3. Controllers (request handling) - from ./controllers/*.mjs

import { Router } from 'express'
import { createSetupGuard, createAuthGuard, createOrUpdateTokenGuardFromPage, createGetAppTokenInfoFromCookieForFiles } from '../../middleware/auth/basicAuth.mjs'
import { createAddUserDSAndAppFS } from '../account/middleware/accountContext.mjs'
import { createAddUserAppList, createGetTargetManifest, createAddTargetAppFS, createAddPublicSystemAppFS } from './middleware/appContext.mjs'
import { systemAppOrTargetAppRequest } from '../../middleware/permissions/permissionCheckers.mjs'
import { createAppPageController } from './controllers/appPageController.mjs'
import { createAppFileController } from './controllers/appFileController.mjs'
import { sendFailure } from '../../adapters/http/responses.mjs'
import { isPageRequest } from '../../common/helpers/utils.mjs'

/**
 * Create app page routes with dependency injection
 * Handles HTML page rendering for app feature
 * 
 * @param {object} dependencies - Required dependencies
 * @param {object} dependencies.dsManager - Data store manager
 * @param {object} dependencies.freezrPrefs - Freezr preferences
 * @param {object} dependencies.freezrStatus - Freezr status
 * @returns {Router} Express router with app page routes
 */
export const createAppPageRoutes = ({ dsManager, freezrPrefs, freezrStatus }) => {
  const router = Router()
  
  // ===== CREATE MIDDLEWARE INSTANCES =====
  
  // Guards (use pure checks from basicAuth.mjs + generic guard creators)
  // setupGuard - Verify freezr is configured
  const setupGuard = createSetupGuard(dsManager)
  // loggedInGuard - Redirect to login if not authenticated
  const loggedInGuard = createAuthGuard('/account/login')
  // createorUpdateTokenForPage - Token validation for pages (creates/updates token if needed)
  const createorUpdateTokenForPage = createOrUpdateTokenGuardFromPage(dsManager)
  // getAppTokenInfo - Gets token info for app from cookie (for API-like access / files)
  const getAppTokenInfo = createGetAppTokenInfoFromCookieForFiles(dsManager)
  
  // Context middleware - loads app list, manifest, and appFS
  // Order matters: need app list first, then manifest, then appFS
  const addUserAppList = createAddUserAppList(dsManager, freezrPrefs)
  const getTargetManifest = createGetTargetManifest(dsManager, freezrPrefs)
  const addUserDSAndAppFS = createAddUserDSAndAppFS(dsManager, freezrPrefs, freezrStatus)
  const addTargetAppFS = createAddTargetAppFS(dsManager, freezrPrefs, freezrStatus)
  const addPublicSystemAppFS = createAddPublicSystemAppFS(dsManager, freezrPrefs, freezrStatus)

  // ===== CREATE CONTROLLERS =====
  
  // Page Controllers
  const appPageController = createAppPageController()
  // File Controllers
  const appFileController = createAppFileController()
  
  // ===== HELPER MIDDLEWARE =====
  
  /**
   * Middleware to redirect to index page
   * Replicates redirectToIndex from server.js
   */
  const redirectToIndex = (req, res) => {
    console.log('redirectToIndex', req.path)
    res.redirect('/apps' + req.path + '/index')
  }
  
  /**
   * Middleware to set app_name from params for getTargetManifest
   * This ensures the manifest is loaded for the correct app
   */
  const setTargetAppFromParams = (req, res, next) => {
    // Set target_app from app_name param so getTargetManifest can use it
    req.params.target_app = req.params.app_name
    next()
  }

  /**
   * Middleware to extract resource path from wildcard
   * Converts req.params[0] (from wildcard route) to req.params.resource
   * For non-wildcard routes, req.params.resource is already set, so this is a no-op
   */
  const extractResourcePath = (req, res, next) => {
    // If resource is not set but we have a wildcard match (req.params[0])
    if (!req.params.resource && req.params[0] !== undefined) {
      req.params.resource = req.params[0]
    }
    next()
  }
    /**
   * Middleware to extract public resource path from wildcard
   * Converts req.params[0] (from wildcard route) to req.params.resource
   * For non-wildcard routes, req.params.resource is already set, so this is a no-op
   */
    const extractPublicResourcePath = (req, res, next) => {
      // If resource is not set but we have a wildcard match (req.params[0])
      if (!req.params.resource && req.params[0] !== undefined) {
        req.params.resource = 'public/' +req.params[0]
      }
      next()
    }

  /**
   * Conditional token guard middleware
   * Uses createorUpdateTokenForPage for pages, getAppTokenInfo for files
   */
  const conditionalTokenGuard = (req, res, next) => {
    const resource = req.params.resource
    if (!resource) {
      return sendFailure(res, 'Resource path is required', 'appPageRoutes.mjs', 400)
    }
    // Check if it's a page request
    if (isPageRequest(resource)) {
      // It's a page - use createorUpdateTokenForPage
      return createorUpdateTokenForPage(req, res, next)
    } else {
      // It's a file - use getAppTokenInfo
      return getAppTokenInfo(req, res, next)
    }
  }

  /**
   * Route handler for app resources (pages and files)
   * Determines if the resource is a page or file and calls the appropriate controller
   * 
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  const servePageOrFile = (req, res) => {
    // console.log('servePageOrFile', req.originalUrl)
    const resource = req.params.resource
    if (!resource) {
      return sendFailure(res, 'Resource path is required', 'appPageRoutes.mjs', 400)
    }

    if (isPageRequest(resource)) {
      // It's a page - set page param and call generateAppPage
      req.params.page = resource
      return appPageController.generateAppPage(req, res)
    } else {
      return serveTargetAppFile(req, res)
      // // It's a file - set file param and call serveAppFile
      // const appFS = res.locals.freezr?.appFS
      // res.locals.freezr.permGiven = true
      // req.params.file = resource
      // return appFS.sendAppFile(resource, res, {})

      // return appFileController.serveAppFile(req, res)
    }
  }

  /**
   * Route handler for app resources (to serve target app files)
   * 
   * @param {Object} req - Express request object
   * @param {Object} res - Express response object
   */
  const serveTargetAppFile = (req, res) => {
    const resource = req.params.resource
    if (!resource) {
      return sendFailure(res, 'Resource path is required', 'appPageRoutes.mjs', 400)
    }

    // console.log('serveTargetAppFile', { resource })
    // It's a file - set file param and call serveAppFile
    const appFS = res.locals.freezr?.appFS
    res.locals.freezr.permGiven = true
    req.params.file = resource
    res.locals.flogger?.track?.('file'); // "?" needed for when freezr is not set up

    return appFS.sendAppFile(resource, res, {})

  }
  
  // ===== PAGE ROUTES =====
  


  // GET /apps/info.freezr.public...
  router.get('/info.freezr.public/*',
    setupGuard,
    extractResourcePath,
    setTargetAppFromParams,
    (req, res, next) => {
      req.params.target_app = 'info.freezr.public'
      next()
    },
    addPublicSystemAppFS, 
    serveTargetAppFile
  )
  router.get('/info.freezr.register/*',
    setupGuard,
    extractResourcePath,
    setTargetAppFromParams,
    (req, res, next) => {
      req.params.target_app = 'info.freezr.register'
      next()
    },
    addPublicSystemAppFS, 
    serveTargetAppFile
  )


  /**
   * GET /apps/:app_name or /app/:app_name
   * Redirect to index page for the app
   * Modernizes: app.get('/apps/:app_name', redirectToIndex)
   */
  router.get('/:app_name', setupGuard, loggedInGuard, redirectToIndex)

  /**
   * GET /app/:app_name/app2app/:target_app/*
   * App-to-app resource access with requestee user specified
   * 
   * Middleware chain:
   * 1. setupGuard - Verify freezr is configured
   * 2. loggedInGuard - Verify user is authenticated (redirects to login if not)
   * 3. setTargetAppFromParams - Set target_app from requesteee_app param
   * 4. extractResourcePath - Extract resource path from wildcard
   * 5. conditionalTokenGuard - Uses createorUpdateTokenForPage for pages, getAppTokenInfo for files
   * 6. addUserAppList - Load user's app list database
   * 7. getTargetManifest - Load manifest for the target app (requesteee_app)
   * 8. addUserDSAndAppFS - Load userDS and appFS for the app
   * 9. systemAppOrTargetAppRequest - Verify permissions
   * 10. Route handler - Render page or serve file
   */
  router.get('/:app_name/app2app/:target_app/*', 
    setupGuard, 
    loggedInGuard, 
    extractResourcePath, // Extract resource path from req.params[0] to req.params.resource
    conditionalTokenGuard, // Uses createorUpdateTokenForPage for pages, getAppTokenInfo for files
    // addUserAppList, // ONLY BE USEFUL FOR PAGES - REMOVED FOR NOW 2025-12-13
    // getTargetManifest, // used for manifest - ONLY BE USEFUL FOR PAGES - REMOVED FOR NOW 2025-12-13
    systemAppOrTargetAppRequest, 
    addTargetAppFS, 
    serveTargetAppFile
    // servePageOrFile // currently only file
  )

  /** MOST COMMON USE - Logged in user accessing own apps
   * GET /apps/:app_name/:resource or /apps/:app_name/*
   * Display app page or serve app file for authenticated users
   * Supports both single-segment paths (/:app_name/:resource) and multi-segment paths (/:app_name/*)
   * Modernizes: app.get('/apps/:app_name/:page', loggedInUserPage, getManifest, appHandler.generatePage)
   * 
   * Middleware chain:
   * 1. setupGuard - Verify freezr is configured
   * 2. loggedInGuard - Verify user is authenticated (redirects to login if not)
   * 3. setTargetAppFromParams - Set target_app from app_name param
   * 4. extractResourcePath - Extract resource path from wildcard if needed
   * 5. conditionalTokenGuard - Uses createorUpdateTokenForPage for pages, getAppTokenInfo for files
   * 6. addUserAppList - Load user's app list database
   * 7. getTargetManifest - Load manifest for the target app
   * 8. addUserDSAndAppFS - Load userDS and appFS for the app
   * 9. systemAppOrTargetAppRequest - Verify permissions
   * 10. Route handler - Render page or serve file
   */
  // Route for single-segment paths (e.g., /apps/myapp/index)
  // router.get('/:app_name/:resource', 
  //   setupGuard, 
  //   loggedInGuard, 
  //   setTargetAppFromParams, // sed for manifest
  //   extractResourcePath, // Extract resource path (no-op for this route, but keeps middleware chain consistent)
  //   conditionalTokenGuard, // Uses createorUpdateTokenForPage for pages, getAppTokenInfo for files
  //   addUserAppList, 
  //   getTargetManifest, // used for manifest
  //   addUserDSAndAppFS, // mostly used for appFS
  //   systemAppOrTargetAppRequest, 
  //   servePageOrFile
  // )
  // Route for multi-segment paths (e.g., /apps/myapp/folder/subfolder/file.js)
  router.get('/:app_name/*', 
    setupGuard, 
    loggedInGuard, 
    setTargetAppFromParams, // sed for manifest
    extractResourcePath, // Extract resource path from req.params[0] to req.params.resource
    conditionalTokenGuard, // Uses createorUpdateTokenForPage for pages, getAppTokenInfo for files
    addUserAppList, 
    getTargetManifest, // used for manifest
    addUserDSAndAppFS, // mostly used for appFS
    systemAppOrTargetAppRequest, 
    servePageOrFile
  )

  return router
}

export default {
  createAppPageRoutes
}

