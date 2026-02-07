// freezr.info - Modern ES6 Module - CEPS API Routes
// All routes for the CEPS (Cross-Entity Permission System) API
//
// Architecture Pattern:
// 1. Guards (auth checks) - from ./middleware/auth/basicAuth.mjs
// 2. Context (feature data loading) - from legacy middleware (to be modernized)
// 3. Controllers (request handling) - from ./controllers/*.mjs

import { Router } from 'express'
import { createSetupGuard, createGetAppTokenInfoFromheaderForApi } from '../../middleware/auth/basicAuth.mjs'
import { createaddOwnerPermsDb, addRightsToTable } from '../../middleware/permissions/permissionContext.mjs'
import { createCepsApiController } from './controllers/cepsfepsApiController.mjs'
import { currentAppPermissions } from '../../middleware/permissions/permissionHandlers.mjs'
import { createAddUserContactsDb, createAddMessageDb } from '../account/middleware/accountContext.mjs'
import { createAddPublicRecordsDB } from '../public/middleware/publicContext.mjs'
import { createAddAppTableFromBodyAndCheckTokenOwner, addDataOwnerToContext, addRequestorAsDataOwner, createAddAppTableDbAndFsIfNeedbe, createAddStorageLimits, createAddValidationDbs } from './middleware/appContext.mjs'
import { sendFailure } from '../../adapters/http/responses.mjs'

 /**
 * /ceps
 * Create CEPS API routes with dependency injection
 * Handles JSON API endpoints for Cross-Entity Permission System
 * 
 * @param {object} dependencies - Required dependencies
 * @param {object} dependencies.dsManager - Data store manager
 * @param {object} dependencies.freezrPrefs - Freezr preferences
 * @param {object} dependencies.freezrStatus - Freezr status
 * @param {object} dependencies.logManager - Log manager (optional)
 * @returns {Router} Express router with CEPS API routes
 */
export const createCepsApiRoutes = ({ dsManager, freezrPrefs, freezrStatus, logManager }) => {
  const router = Router()

  // ===== CREATE MIDDLEWARE INSTANCES =====
  // Guards (use pure checks from basicAuth.mjs + generic guard creators)
  // setupGuard - Verify freezr is configured
  const setupGuard = createSetupGuard(dsManager)
  // getAppTokenInfo - gets token for API requests and sets res.locals.freezr.tokenInfo
  const getAppTokenInfo = createGetAppTokenInfoFromheaderForApi(dsManager, freezrPrefs, freezrStatus)
  const addOwnerPermDBs = createaddOwnerPermsDb(dsManager, freezrPrefs, freezrStatus)
  const addOwnerAppTable = createAddAppTableDbAndFsIfNeedbe(dsManager, freezrPrefs, freezrStatus)
  const addStorageLimits = createAddStorageLimits(dsManager, freezrPrefs)
  const addPublicRecordsDB = createAddPublicRecordsDB(dsManager, freezrPrefs, freezrStatus)
  const addUserContactsDb = createAddUserContactsDb(dsManager, freezrPrefs, freezrStatus)
  const addAppTableFromBodyAndCheckTokenOwner = createAddAppTableFromBodyAndCheckTokenOwner(dsManager, freezrPrefs)
  const addMessageDb = createAddMessageDb(dsManager, freezrPrefs, freezrStatus)
  const addValidationDBs = createAddValidationDbs(dsManager, freezrPrefs, freezrStatus)

  // ===== CREATE CONTROLLERS =====
  const cepsApiController = createCepsApiController({ dsManager, freezrPrefs, freezrStatus })

  // ===== API ROUTES =====
  
    /**
   * GET /ceps/ping
   * Ping endpoint to check server status and authentication
   * 
   * Returns:
   * - logged_in: boolean
   * - logged_in_as_admin: boolean (if logged in)
   * - user_id: string (if logged in)
   * - server_type: 'info.freezr'
   * - server_version: string
   * - storageLimits: object (if logged in)
   */
    router.get('/ping', setupGuard, addStorageLimits, cepsApiController.ping)

  /**
   * POST /ceps/write/:app_table
   * Create a new record in the specified app table
   * 
   * Body:
   * - _entity: Object with record data (new format)
   * - OR: Direct object (old format)
   * 
   * Returns:
   * - _id: string (record ID)
   * - success: boolean
   */
  router.post('/write/:app_table', setupGuard, getAppTokenInfo, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTable, cepsApiController.writeorUpsertRecord)

  /**
   * GET /ceps/read/:app_table/:data_object_id
   * Read a record by ID from the specified app table
   * 
   * Returns:
   * - Record object
   */
  router.get('/read/:app_table/:data_object_id', setupGuard, getAppTokenInfo, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTable, cepsApiController.readRecordById)

  /**
   * GET /ceps/query/:app_table
   * Query records from the specified app table
   * 
   * Query Parameters:
   * - q: Query object (JSON stringified)
   * - sort: Sort object (JSON stringified)
   * - count: Number of records to return
   * - skip: Number of records to skip
   * 
   * Returns:
   * - Array of matching records
   */
  router.get('/query/:app_table', setupGuard, getAppTokenInfo, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTable, cepsApiController.dbQuery)

  /**
   * POST /ceps/query/:app_table
   * Query records from the specified app table (POST version)
   * 
   * Body:
   * - q: Query object
   * - sort: Sort object
   * - count: Number of records to return
   * - skip: Number of records to skip
   * 
   * Returns:
   * - Array of matching records
   */
  router.post('/query/:app_table', setupGuard, getAppTokenInfo, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTable, cepsApiController.dbQuery)
  


  /**
   * PUT /ceps/update/:app_table/:data_object_id
   * Update an existing record in the specified app table
   * 
   * Body:
   * - _entity: Object with record data (new format)
   * - OR: Direct object (old format)
   * 
   * Returns:
   * - _id: string (record ID)
   * - nModified: number
   * - success: boolean
   */
  router.put('/update/:app_table/:data_object_id', setupGuard, getAppTokenInfo, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTable, cepsApiController.updateRecord)

  /**
   * DELETE /ceps/delete/:app_table/:data_object_id
   * Delete a record from the specified app table
   * 
   * Returns:
   * - success: boolean
   */
  router.delete('/delete/:app_table/:data_object_id', setupGuard, getAppTokenInfo, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTable, addPublicRecordsDB, cepsApiController.deleteRecords)
  router.delete('/delete/:app_table/:data_object_start/*', setupGuard, getAppTokenInfo, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTable, addPublicRecordsDB, cepsApiController.deleteRecords)

  /**
   * GET /ceps/perms/get
   * Get all permissions for the requestor app
   * 
   * Query Parameters:
   * - owner: Optional owner ID to get permissions from
   * 
   * Returns:
   * - Array of permission objects
   */
  router.get('/perms/get', setupGuard, getAppTokenInfo, addDataOwnerToContext, addOwnerPermDBs, currentAppPermissions)

  /**
   * GET /ceps/perms/validationtoken/:action
   * Validate or verify a validation token (for actions: validate, verify)
   * 
   * Query Parameters:
   * - validation_token: Token to validate
   * - data_owner_user: Owner user ID
   * - data_owner_host: Owner host (optional)
   * - table_id: Table identifier
   * - permission: Permission name
   * - requestor_user: Requestor user ID
   * - requestor_host: Requestor host (optional)
   * 
   * Returns:
   * - validated: boolean (for validate)
   * - verified: boolean (for verify)
   * - access-token: string (for validate, if validated)
   * - expiry: number (for validate, if validated)
   */
  router.get('/perms/validationtoken/:action', setupGuard, addValidationDBs, cepsApiController.CEPSValidator)

  /**
   * POST /ceps/perms/validationtoken/:action
   * Set a validation token (for action: set)
   * 
   * Body:
   * - data_owner_host: Owner host URL (blank if same)
   * - data_owner_user: Owner username
   * - table_id: Table identifier
   * - requestor_user: Requestor username
   * - permission: Permission name
   * - app_id: Requesting app's ID
   * - record_id: Record ID being shared (optional)
   * 
   * Returns:
   * - validation_token: string
   * - requestor_host: string
   * - expiration: number
   */
  router.post('/perms/validationtoken/:action', setupGuard, getAppTokenInfo, addValidationDBs, cepsApiController.CEPSValidator)

  /**
   * POST /ceps/perms/share_records
   * Share records with specified grantees
   * 
   * Body:
   * - name: Permission name (OBLIGATORY)
   * - table_id: App name (defaults to app self)
   * - action: 'grant' or 'deny' (default is grant)
   * - grantees: Array of people being granted access
   * - record_id: Record ID or query criteria
   * - doNotList: Whether record should show up on feed
   * 
   * Returns:
   * - success: boolean
   * - recordsToChange: Array of affected records
   */
  router.post('/perms/share_records', setupGuard, getAppTokenInfo, addPublicRecordsDB, addUserContactsDb, addAppTableFromBodyAndCheckTokenOwner, addRequestorAsDataOwner, addOwnerPermDBs, cepsApiController.shareRecords)

  /**
   * POST /ceps/message/:action
   * Handle messaging actions (initiate, transmit, verify, mark_read)
   * 
   * Actions:
   * - initiate: Initiate a message to recipients
   * - transmit: Transmit a message (public endpoint)
   * - verify: Verify a message transmission
   * - mark_read: Mark messages as read
   * 
   * Body: Varies by action
   * 
   * Returns: Varies by action
   */
  router.post('/message/:action', setupGuard, getAppTokenInfo, addDataOwnerToContext, addOwnerPermDBs,  addUserContactsDb, addMessageDb, addAppTableFromBodyAndCheckTokenOwner, cepsApiController.messageActions)

  return router
}

export default {
  createCepsApiRoutes
}
