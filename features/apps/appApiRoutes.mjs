// freezr.info - Modern ES6 Module - App Routes
// All routes for the app/developer feature
//
// Architecture Pattern:
// 1. Guards (auth checks) - from ./middleware/appGuards.mjs
// 2. Context (feature data loading) - from ./middleware/appContext.mjs
// 3. Controllers (request handling) - from ./controllers/*.mjs

import { Router } from 'express'
import multer from 'multer'
import { createSetupGuard, createAuthGuard, createGetAppTokenInfoFromheaderForApi, createAddAppTokenInfoWithoutChecks } from '../../middleware/auth/basicAuth.mjs'
import { getAllAppAppTablesAndSendWithManifest, createAddUserDs, createGetTargetManifest, createAddUserAppList, addDataOwnerToContext, createAddAppTableDbAndFsIfNeedbe, createAddStorageLimits, createAddUserFilesDbAndAppFS, defineFileAppTableFromAppName } from './middleware/appContext.mjs'
import { createServerlessPerms, createAddAppFsFor3PFunctions, createAdd3PFunctionFS } from './middleware/serverlessContext.mjs'
import * as serverlessModule from '../../adapters/datastore/slConnectors/serverless.mjs'
import { createAddOwnerPermsDbForLoggedInuser, createaddOwnerPermsDb, addRightsToTable } from '../../middleware/permissions/permissionContext.mjs'
import { allRequestorAppPermissions } from '../../middleware/permissions/permissionHandlers.mjs'
import { isLoggedInAccountAppRequest, tokenUserHasFullAppApiRights } from '../../middleware/permissions/permissionCheckers.mjs'
import { createAddPublicRecordsDB } from '../public/middleware/publicContext.mjs'
import { createAddPublicManifestsDb } from '../account/middleware/accountContext.mjs'
import { createAccountApiController } from '../account/controllers/accountApiController.mjs'
import { createCepsApiController } from './controllers/cepsfepsApiController.mjs'
import { sendFailure } from '../../adapters/http/responses.mjs'

/**
 * /feps
 * Create app API routes with dependency injection
 * Handles JSON API endpoints for app/developer feature
 * 
 * @param {object} dependencies - Required dependencies
 * @param {object} dependencies.dsManager - Data store manager
 * @param {object} dependencies.freezrPrefs - Freezr preferences
 * @param {object} dependencies.freezrStatus - Freezr status
 * @returns {Router} Express router with app API routes
 */
export const createAppApiRoutes = ({ dsManager, freezrPrefs, freezrStatus, logManager }) => {
  const router = Router()

  // ===== CREATE MIDDLEWARE INSTANCES =====
  // Guards (use pure checks from basicAuth.mjs + generic guard creators)
  // setupGuard - Verify freezr is configured
  const setupGuard = createSetupGuard(dsManager)
  // loggedInGuard - Verify user is authenticated
  const loggedInGuard = createAuthGuard('')
  // getAndCheckAccountAppTokenInfo - gets token for later validation
  const getAndCheckAccountAppTokenInfo = createGetAppTokenInfoFromheaderForApi(dsManager, { ensureAppName: 'info.freezr.account' })
  const getAppTokenInfo = createGetAppTokenInfoFromheaderForApi(dsManager)
  const getAppTokenInfoWithoutChecks = createAddAppTokenInfoWithoutChecks(dsManager)
  
  // Context middleware - loads manifest and user data store
  // Order matters: need app list first, then manifest, then userDS
  // todo Modernization - Do we use addUserAppList separately from getTargetManifest? if not combine them
  const addUserAppList = createAddUserAppList(dsManager, freezrPrefs)
  const getTargetManifest = createGetTargetManifest(dsManager, freezrPrefs)
  const addUserDs = createAddUserDs(dsManager, freezrPrefs)
  const addUserPermDBs = createAddOwnerPermsDbForLoggedInuser(dsManager, freezrPrefs, freezrStatus)
  const addPublicRecordsDB = createAddPublicRecordsDB(dsManager, freezrPrefs, freezrStatus)
  const addPublicManifestsDb = createAddPublicManifestsDb(dsManager, freezrPrefs, freezrStatus)
  
  // Middleware for feps routes (similar to ceps but for logged-in users)
  const addOwnerPermDBs = createaddOwnerPermsDb(dsManager, freezrPrefs, freezrStatus)
  const addOwnerAppTableAndFsIfNeedBe = createAddAppTableDbAndFsIfNeedbe(dsManager, freezrPrefs, freezrStatus)
  const addStorageLimits = createAddStorageLimits(dsManager, freezrPrefs)
  const addUserFilesDbAndAppFS = createAddUserFilesDbAndAppFS(dsManager, freezrPrefs, freezrStatus)
  
  // Middleware for serverless (& 3PFunctions) routes
  const serverlessPerms = createServerlessPerms(dsManager, freezrPrefs, freezrStatus, serverlessModule)
  const addAppFsFor3PFunctions = createAddAppFsFor3PFunctions(dsManager, freezrPrefs, freezrStatus)
  const add3PFunctionFS = createAdd3PFunctionFS(dsManager, freezrPrefs, freezrStatus, serverlessModule)
  
  // Multer middleware for file uploads
  const upload = multer().single('file')
  
  // Upload middleware - handles file upload and parses options
  const uploadIfNeeded = (req, res, next) => {
    // Check if body is empty (indicating file upload)
    const isEmpty = (obj) => {
      for (const prop in obj) {
        if (Object.hasOwn(obj, prop)) {
          return false
        }
      }
      return true
    }
    
    if (isEmpty(req.body)) {
      // File upload expected
      upload(req, res, (err) => {
        if (err) {
          console.warn('multer err ', err)
          return sendFailure(res, err, 'uploadIfNeeded', 400)
        }
        // Parse options if provided as string
        if (req.body.options && typeof req.body.options === 'string') {
          try {
            req.body = JSON.parse(req.body.options)
          } catch (e) {
            return sendFailure(res, 'Invalid options JSON', 'uploadIfNeeded', 400)
          }
        }
        next()
      })
    } else {
      // No file upload, continue
      next()
    }
  }
  
  // ===== CREATE CONTROLLERS =====
  const accountApiController = createAccountApiController()
  const cepsApiController = createCepsApiController()
  
  // ===== API ROUTES =====
  
  /**
   * GET /feps/manifest
   * Get manifest and app tables for a target app
   * Query Parameters:
   * - targetApp: Optional app name (which can be used from accounts apps - if not provided, uses app from token)
   * - TODO-modernization - May make access to app manifests a perm based thing
   * 
   * Returns:
   * - manifest: App manifest object
   * - app_tables: Array of app table names
   * - warnings: Installation warnings (if any)
   * - offThreadStatus: Off-thread status (if any)
   * 
   * TODO 
   */
  router.get('/manifest/:target_app', setupGuard, loggedInGuard, getAppTokenInfo, addUserAppList, getTargetManifest, addUserDs, tokenUserHasFullAppApiRights, getAllAppAppTablesAndSendWithManifest)
  // router.get('/manifest', setupGuard, loggedInGuard, getAppTokenInfo, addUserAppList, getTargetManifest, addUserDs, systemAppOrTargetAppRequest, getAllAppAppTablesAndSendWithManifest)

  /**
   * GET /feps/permissions/getall/:app_name
   * Get all permissions for a requestor app
   * 
   * Returns:
   * - Array of permission objects (if groupall not specified)
   * Modernized version of /v1/permissions/getall/:app_name
   */
  router.get('/permissions/getall/:target_app', setupGuard, loggedInGuard, getAppTokenInfo, addUserPermDBs, tokenUserHasFullAppApiRights, allRequestorAppPermissions)
  // router.get('/permissions/gethtml/:app_name', setupGuard, loggedInGuard, getAppTokenInfo, addUserPermDBs, accountHandler.generatePermissionHTML) // no logner used

  /**
   * PUT /permissions/change
   * Accept or deny a permission request
   * Body:
   * - change: Object with { name, action: 'Accept'|'Deny', table_id, requestor_app }
   * 
   * Returns:
   * - success: boolean
   * - name: Permission name
   * - action: Action taken ('Accept' or 'Deny')
   * - flags: Array of warning flags (if any)
   * 
   * Modernized version of /v1/permissions/change
   */
  router.put('/permissions/change', setupGuard, loggedInGuard, getAndCheckAccountAppTokenInfo, addUserAppList, getTargetManifest, addUserPermDBs, addUserDs, addPublicRecordsDB, addPublicManifestsDb, isLoggedInAccountAppRequest, accountApiController.changeNamedPermissionsHandler)
  
  // ===== FEPS ROUTES (similar to CEPS ... =====

    
  /**
   * POST /feps/write/:app_table/:data_object_id
   * Create a new record with specific ID in the specified app table
   * 
   * Body:
   * - _entity: Object with record data (new format)
   * - OR: Direct object (old format)
   * 
   * Options:
   * data_object_id, upsert, host and appToken (accesstoken) for third party servers
   * 
   * Returns:
   * - _id: string (record ID)
   * - _date_modified: date (record modified date)
   * - _date_created: date (record created date)
   */
  router.post('/write/:app_table/:data_object_id', setupGuard, getAppTokenInfo, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTableAndFsIfNeedBe, cepsApiController.writeorUpsertRecord)
  
  /**
   * POST /feps/write/:app_table
   * Create a new record in the specified app table
   * 
   * Body:
   * - _entity: Object with record data (new format)
   * - OR: Direct object (old format)
   * 
   * Options:
   * data_object_id, upsert, host and appToken (accesstoken) for third party servers
   * 
   * Returns:
   * - _id: string (record ID)
   * - _date_modified: date (record modified date)
   * - _date_created: date (record created date)
   */
  router.post('/write/:app_table', setupGuard, getAppTokenInfo, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTableAndFsIfNeedBe, cepsApiController.writeorUpsertRecord)

  /**
   * PUT /feps/update/:app_table/:data_object_id
   * Update an existing record in the specified app table
   * 
   * Body:
   * - _entity: Object with record data (new format)
   * 
   * Other options:
   * host and appToken (accesstoken) for third party servers
   * replaceAllFields
   * 
   * Returns:
   * - _id: string (record ID)
   * - nModified: number
   * - success: boolean
   */
  router.put('/update/:app_table/:data_object_id', setupGuard, getAppTokenInfo, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTableAndFsIfNeedBe, cepsApiController.updateRecord)
  
  /**
   * PUT /feps/update/:app_table/:data_object_start/*
   * Update an existing record with path-based ID
   * Handles multi-segment data_object_id paths
   * 
   * Body:
   * _entity: Object with record data (new format)
   * 
   * Options:
   * host and appToken (accesstoken) for third party servers
   * replaceAllFields
   * 
   * Returns:
   * - _id: string (record ID)
   * - nModified: number
   * - success: boolean
   */
  router.put('/update/:app_table/:data_object_start/*', setupGuard, getAppTokenInfo, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTableAndFsIfNeedBe, cepsApiController.updateRecord)
  
  /**
   * PUT /feps/update/:app_table
   * Update records by query (query-based update)
   * 
   * Body:
   * q: Query object to replace multiple entities
   *
   * Other options:
   * host and appToken (accesstoken) for third party servers
   * replaceAllFields
   * 
   * Returns:
   * - nModified: number
   * - success: boolean
   */
  router.put('/update/:app_table', setupGuard, getAppTokenInfo, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTableAndFsIfNeedBe, cepsApiController.updateRecord)
  
  /**
   * DELETE /feps/delete/:app_table
   * Delete records by query
   * 
   * Body:
   * - Query object to match records for deletion
   * 
   * Returns:
   * - success: boolean
   * - deleteConfirm: object
   */
  router.delete('/delete/:app_table', setupGuard, loggedInGuard, getAppTokenInfo, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTableAndFsIfNeedBe, cepsApiController.deleteRecords)
  
  /**
   * DELETE /feps/delete/:app_table/:data_object_id
   * Delete a record by ID from the specified app table
   * 
   * Returns:
   * - success: boolean
   * - deleteConfirm: object
   */
  router.delete('/delete/:app_table/:data_object_id', setupGuard, loggedInGuard, getAppTokenInfo, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTableAndFsIfNeedBe, cepsApiController.deleteRecords)
  
  /**
   * DELETE /feps/delete/:app_table/:data_object_start/*
   * Delete a record with path-based ID
   * Handles multi-segment data_object_id paths
   * 
   * Returns:
   * - success: boolean
   * - deleteConfirm: object
   */
  router.delete('/delete/:app_table/:data_object_start/*', setupGuard, loggedInGuard, getAppTokenInfo, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTableAndFsIfNeedBe, cepsApiController.deleteRecords)
  
    
  /**
   * POST /feps/restore/:app_table
   * Restore a deleted record
   * 
   * Body:
   * - record: Record object to restore
   * - options: Object with { data_object_id, updateRecord, upsertRecord }
   * 
   * Returns:
   * - _id: string (record ID)
   * - _date_created: number
   * - _date_modified: number
   */
  router.post('/restore/:app_table', setupGuard, loggedInGuard, getAppTokenInfo, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTableAndFsIfNeedBe, cepsApiController.restoreRecord)
  
  /**
   * PUT /feps/upload/:app_name
   * Upload a file and create a file record
   * 
   * Body (multipart/form-data):
   * - file: File to upload
   * - options: JSON string with upload options:
   *   - targetFolder: Target folder path
   *   - fileName: File name (defaults to original filename)
   *   - overwrite: set false to prevent overwriting existing files
   *   - data: JSON object with file metadata
   *   - convertPict: Object with { width, type } for image conversion
   * 
   * Returns:
   * - _id: string (file record ID - path to file)
   */
  router.put('/upload/:app_name', setupGuard, getAppTokenInfo, uploadIfNeeded, defineFileAppTableFromAppName, addDataOwnerToContext, 
     addOwnerPermDBs, 
     addRightsToTable, 
     addUserFilesDbAndAppFS, 
     cepsApiController.uploadUserFileAndCreateRecord)
    // nb addOwnerPermDBs left in in case of future upload perms

  /**
   * GET /feps/getuserfiletoken/:permission_name/:app_name/:user_id/*
   * Get a file token for accessing a user file
   * 
   * Query Parameters:
   * - permission_name: Permission name (for validation)
   * 
   * Returns:
   * - fileToken: string (token to use for file access)
   */
  router.get('/getuserfiletoken/:permission_name/:app_name/:user_id/*', setupGuard, defineFileAppTableFromAppName, getAppTokenInfo, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTableAndFsIfNeedBe, cepsApiController.getFileToken)
  
  /**
   * GET /feps/userfiles/:app_name/:user_id/*
   * Serve a user file with file token validation
   * 
   * Query Parameters:
   * - fileToken: File access token (required)
   * 
   * Returns:
   * - File content (served directly)
   * 
   * Note: No authentication required - file token is validated in controller
   */
  router.get('/userfiles/:app_name/:user_id/*', setupGuard, defineFileAppTableFromAppName, getAppTokenInfoWithoutChecks, async (req, res, next) => {
    // Set data owner for appTable
    res.locals.freezr = {
      ...res.locals.freezr,
      data_owner_id: req.params.user_id
    }
    next()
  
  }, addOwnerAppTableAndFsIfNeedBe, cepsApiController.sendUserFileWithFileorAppToken)
  // note: 2025-12 fetchuserfiles is not used anymore - use userfiles instead

  // ===== SERVERLESS ROUTES =====
  
  /**
   * PUT /feps/serverless/:task
   * Handle microservice tasks (invoke, create, update, delete serverless functions)
   * Also handles local service management (upsert, delete) for admins
   * 
   * Tasks:
   * - invokeserverless: Invoke a serverless function
   * - createserverless: Create a new serverless function
   * - updateserverless: Update an existing serverless function
   * - upsertserverless: Create or update a serverless function
   * - deleteserverless: Delete a serverless function
   * - rolecreateserverless: Create AWS IAM role for Lambda
   * - upsertlocalservice: Upload/update a local microservice (admin only)
   * - invokelocalservice: Invoke a local microservice
   * - deletelocalfunction: Delete a local microservice (admin only)
   * 
   * - getalllocalfunctions: Get a list of local microservices (uses GET)
   * 
   * Body:
   * - permission_name: Name of the permission (for invoke/serverless functions)
   * - inputParams: Input parameters for the function
   * - read_collection_name: Optional collection to read from before invocation
   * - read_query: Query for the read operation
   * - thirdPartyFunctionName: Name of the microservice (for local function service management)
   * 
   * For file uploads (upsertlocalservice):
   * - file: The zip file containing the microservice code
   */
  router.put('/serverless/:task', setupGuard, getAppTokenInfo, uploadIfNeeded, serverlessPerms, addAppFsFor3PFunctions, add3PFunctionFS, cepsApiController.serverlessTasks)
  router.get('/serverless/:task', setupGuard, getAppTokenInfo, serverlessPerms, add3PFunctionFS, cepsApiController.serverlessTasks)

  return router
}

export default {
  createAppApiRoutes
}

