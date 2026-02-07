// freezr.info - Modern ES6 Module - Public Routes
// All routes for the public feature (no-cookie routes)

import { Router } from 'express'
import { createHasAtLeastOnePublicRecord } from './middleware/publicGuards.mjs'
import { createSetupGuard } from '../../middleware/auth/basicAuth.mjs'
import { createAddPublicRecordsDB, createPrepUserDSsForPublicFiles, createGetPublicAppManifest, createAddPublicAppFS } from './middleware/publicContext.mjs'
import { createPublicApiController } from './controllers/publicApiController.mjs'
import { createPublicPageController } from './controllers/publicPageController.mjs'
import { createPublicAppPageController } from './controllers/publicAppPageController.mjs'

// Helper middleware to add request query to response locals
const addReqQueryToResLocals = (req, res, next) => {
  res.locals.reqquery = req.query
  next()
}

/**
 * Middleware to prevent ALL cookies from being set on public routes
 * Intercepts res.cookie(), res.setHeader('set-cookie'), and res.append('set-cookie')
 * to prevent any cookies from being sent to the client
 * 
 * This does NOT remove existing cookies from the browser, only prevents new ones
 */
const preventCookiesOnPublicRoutes = (req, res, next) => {
  // Store original methods
  const originalSetHeader = res.setHeader.bind(res)
  const originalAppend = res.append ? res.append.bind(res) : null
  const originalCookie = res.cookie.bind(res)
  
  // Intercept res.cookie() to prevent ALL cookie setting
  res.cookie = function(name, value, options) {
    // Block all cookies on public routes
    return res // Don't set any cookies
  }
  
  // Intercept res.setHeader() to block all Set-Cookie headers
  res.setHeader = function(name, value) {
    if (name.toLowerCase() === 'set-cookie') {
      // Block all cookies - don't set the header at all
      return res
    }
    return originalSetHeader(name, value)
  }
  
  // Intercept res.append() if it exists (Express 4.16+)
  if (originalAppend) {
    res.append = function(name, value) {
      if (name.toLowerCase() === 'set-cookie') {
        // Block all cookies - don't append
        return res
      }
      return originalAppend(name, value)
    }
  }
  
  // Also intercept res.end() to ensure all cookies are removed from final headers
  const originalEnd = res.end.bind(res)
  res.end = function(chunk, encoding, callback) {
    // Only remove headers if they haven't been sent yet
    if (!res.headersSent) {
      res.removeHeader('set-cookie')
    }
    return originalEnd(chunk, encoding, callback)
  }
  
  next()
}

/**
 * Create public API routes with dependency injection
 * Handles JSON API endpoints for public feature
 * 
 * @param {object} dependencies - Required dependencies
 * @param {object} dependencies.dsManager - Data store manager
 * @param {object} dependencies.freezrPrefs - Freezr preferences
 * @param {object} dependencies.freezrStatus - Freezr status
 * @returns {Router} Express router with public API routes
 */
export const createPublicRoutes = ({ dsManager, freezrPrefs, freezrStatus }) => {
  const router = Router()

  // Apply cookie prevention middleware to all public routes
  router.use(preventCookiesOnPublicRoutes)

  // ===== CREATE MIDDLEWARE INSTANCES =====
  
  const setupGuard = createSetupGuard(dsManager)
  const addPublicRecordsDB = createAddPublicRecordsDB(dsManager, freezrPrefs, freezrStatus)
  // const addUserPermsDbForParamsUser = createAddUserPermsDbForParamsUser(dsManager, freezrPrefs, freezrStatus)
  const hasAtLeastOnePublicRecord = createHasAtLeastOnePublicRecord(dsManager, freezrPrefs, freezrStatus)

  // ===== CREATE CONTROLLERS =====
  
  const publicApiController = createPublicApiController()
  const publicPageController = createPublicPageController()
  const publicAppPageController = createPublicAppPageController()

  // ===== API ROUTES =====
  
  /**
   * GET /public/readobject/@:user_id/:app_table/:data_object_id
   * Returns a single public object as JSON
   * Replaces: /v1/pobject/@:user_id/:requestee_app_table/:data_object_id
   */
  router.get('/readobject/@:user_id/:app_table/:data_object_id',
    setupGuard,
    addPublicRecordsDB,
    publicApiController.readObject
  )

  /**
   * GET /public/query
   * GET /public/query/@:user_id
   * GET /public/query/@:user_id/:app_name
   * Queries public database with optional filters
   * Query params: published_before, published_after, search, skip, count
   * Replaces: /v1/pdbq, /v1/pdbq/@:user_id/:requestee_app, /v1/pdbq/:requestee_app
   */
  router.get('/query',
    setupGuard,
    addPublicRecordsDB,
    publicApiController.query
  )

  router.get('/query/@:user_id',
    setupGuard,
    addPublicRecordsDB,
    publicApiController.query
  )

  router.get('/query/@:user_id/:app_name',
    setupGuard,
    addPublicRecordsDB,
    publicApiController.query
  )

  router.post('/query',
    setupGuard,
    addPublicRecordsDB,
    publicApiController.query
  )

  // ===== PAGE ROUTES =====

  /**
   * GET /public/objectpage/:publicid
   * GET /public/objectpage/@:user_id/:app_table/:data_object_id
   * Renders a public object page using the pcard template from manifest
   * Replaces: /@:user_id/:app_table/:data_object_id for public pages
   */
  router.get('/objectpage/:publicid',
    setupGuard,
    addPublicRecordsDB,
    publicPageController.objectPage
  )

  router.get('/objectpage/@:user_id/:app_table/:data_object_id',
    setupGuard,
    addPublicRecordsDB,
    publicPageController.objectPage
  )

    /**
   * GET /@:user_id/:app_table/:data_object_id
   * Catch-all for legacy public ID routes
   * Checks publicDb and renders object page if found
   */
    router.get('/notfound',
      setupGuard,
      publicPageController.pageNotFound
    )
  

  /**
   * GET /public/objectcard/:publicid
   * GET /public/objectcard/@:user_id/:app_table/:data_object_id
   * Returns just the card HTML without page wrapper
   * Useful for embedding or AJAX loading
   */
  router.get('/objectcard/:publicid',
    setupGuard,
    addPublicRecordsDB,
    publicPageController.objectCard
  )

  router.get('/objectcard/@:user_id/:app_table/:data_object_id',
    setupGuard,
    addPublicRecordsDB,
    publicPageController.objectCard
  )

  /** 
   * GET /public/oauth/:getwhat
  */
  router.get('/oauth/:getwhat',
    setupGuard,
    publicPageController.oauthActions
  )

  /**
   * GET /public
   * Renders the public feed page showing all public records
   * Query params: owner, app, search, skip, count, error, message
   */
  router.get('/',
    setupGuard,
    addPublicRecordsDB,
    publicPageController.feedPage
  )

  /**
   * GET /public/rss
   * Generates an RSS feed of public records
   * Query params: owner, app, search, skip, count (same as /public)
   */
  router.get('/rss',
    setupGuard,
    addPublicRecordsDB,
    publicPageController.rssFeed
  )

  // ===== PUBLIC APP PAGE ROUTES =====
  
  // Create middleware instances for public app pages
  const getPublicAppManifest = createGetPublicAppManifest(dsManager, freezrPrefs)
  const addPublicAppFS = createAddPublicAppFS(dsManager, freezrPrefs, freezrStatus)
  
  /**
   * Helper middleware to extract resource path from wildcard
   * Converts req.params[0] (from wildcard route) to req.params.resource
   */
  const extractPublicAppResourcePath = (req, res, next) => {
    // If resource is not set but we have a wildcard match (req.params[0])
    if (!req.params.resource && req.params[0] !== undefined) {
      req.params.resource = req.params[0]
    }
    next()
  }
  
  /**
   * Middleware to redirect to index page for public app
   */
  const redirectToPublicAppIndex = (req, res) => {
    console.log('redirectToPublicAppIndex', req.path)
    const userId = req.params.user_id
    const appName = req.params.app_name
    res.redirect(`/public/app/@${userId}/${appName}/index`)
  }

  /**
   * GET /public/app/@:user_id/:app_name
   * Redirect to index page for the public app
   */
  router.get('/app/@:user_id/:app_name',
    setupGuard,
    redirectToPublicAppIndex
  )

  /**
   * GET /public/app/@:user_id/:app_name/:page
   * Display public app page for a specific page
   * 
   * Middleware chain:
   * 1. setupGuard - Verify freezr is configured
   * 2. getPublicAppManifest - Load manifest for the user's app
   * 3. addPublicAppFS - Load appFS for the user's app
   * 4. hasAtLeastOnePublicRecord - Check if there is at least one public record for the app
   * 5. Route handler - Render page
   */
  router.get('/app/@:user_id/:app_name/:page',
    setupGuard,
    getPublicAppManifest,
    addPublicAppFS,
    hasAtLeastOnePublicRecord,
    publicAppPageController.generatePublicAppPage
  )

  /**
   * GET /public/app/@:user_id/:app_name/*
   * Display public app page or serve public app file
   * Supports both single-segment paths and multi-segment paths
   * 
   * Middleware chain:
   * 1. setupGuard - Verify freezr is configured
   * 2. extractPublicAppResourcePath - Extract resource path from wildcard
   * 3. getPublicAppManifest - Load manifest for the user's app
   * 4. addPublicAppFS - Load appFS for the user's app
   * 5. hasAtLeastOnePublicRecord - Check if there is at least one public record for the app
   * 6. Route handler - Render page or serve file
   */
  router.get('/app/@:user_id/:app_name/*',
    setupGuard,
    extractPublicAppResourcePath,
    getPublicAppManifest,
    addPublicAppFS,
    hasAtLeastOnePublicRecord,
    publicAppPageController.servePublicPageOrFile
  )
  
  return router
}

/**
 * Create catch-all router for legacy public ID routes
 * Mounts at root level to catch /@user/app.table/objectId patterns
 * 
 * @param {object} dependencies - Required dependencies
 * @returns {Router} Express router with catch-all route
 */
export const createPublicCatchAllRoutes = ({ dsManager, freezrPrefs, freezrStatus }) => {
  const router = Router()

  // Apply cookie prevention middleware to all catch-all public routes
  router.use(preventCookiesOnPublicRoutes)

  const setupGuard = createSetupGuard(dsManager)
  const addPublicRecordsDB = createAddPublicRecordsDB(dsManager, freezrPrefs, freezrStatus)
  const prepUserDSsForPublicFiles = createPrepUserDSsForPublicFiles(dsManager, freezrPrefs, freezrStatus)
  const publicPageController = createPublicPageController()

  /**
   * GET /@:user_id/:app_table/:data_object_id(*)
   * Catch-all for legacy public ID routes
   * Checks publicDb and renders object page if found
   */
  router.get('/@:user_id/:app_table/:data_object_id(*)',
    setupGuard,
    addPublicRecordsDB,
    prepUserDSsForPublicFiles,
    addReqQueryToResLocals,
    publicPageController.catchAllPublicId
  )

  /**
   * GET /*
   * Final catch-all for any remaining paths
   * Treats the path as a publicId and attempts to render if found
   */
  router.get('/*',
    setupGuard,
    addPublicRecordsDB,
    prepUserDSsForPublicFiles,
    addReqQueryToResLocals,
    publicPageController.catchAllPublicId
  )
  
  return router
}

export default { createPublicRoutes, createPublicCatchAllRoutes }

