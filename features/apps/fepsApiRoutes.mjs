// freezr.info - Modern ES6 Module - App Routes
// All routes for the app/developer feature
//
// Architecture Pattern:
// 1. Guards (auth checks) - from ./middleware/appGuards.mjs
// 2. Context (feature data loading) - from ./middleware/appContext.mjs
// 3. Controllers (request handling) - from ./controllers/*.mjs

import { Router } from 'express'
import multer from 'multer'
import { createSetupGuard, createAuthGuard, createGetAppTokenInfoFromheaderForApi, createGetFileTokenInfo, rejectWritesForReadOnlyTokens } from '../../middleware/auth/basicAuth.mjs'
import { getAllAppAppTablesAndSendWithManifest, createAddUserDs, createGetTargetManifest, createAddUserAppList, addDataOwnerToContext, createAddAppTableDbAndFsIfNeedbe, createAddStorageLimits, createAddUserFilesDbAndAppFS, defineFileAppTableFromAppName } from './middleware/appContext.mjs'
import { createServerlessPerms, createAddAppFsFor3PFunctions, createAdd3PFunctionFS } from './middleware/serverlessContext.mjs'
import { createGetLlmPerms } from './middleware/llmContext.mjs'
import * as serverlessModule from '../../adapters/datastore/slConnectors/serverless.mjs'
import { createAddOwnerPermsDbForLoggedInuser, createaddOwnerPermsDb, addRightsToTable } from '../../middleware/permissions/permissionContext.mjs'
import { allRequestorAppPermissions } from '../../middleware/permissions/permissionHandlers.mjs'
import { isLoggedInAccountAppRequest, tokenUserHasFullAppApiRights } from '../../middleware/permissions/permissionCheckers.mjs'
import { createAddPublicRecordsDB } from '../public/middleware/publicContext.mjs'
import { createAddPublicManifestsDb, createAddTokenDb } from '../account/middleware/accountContext.mjs'
import { createAddScheduledJobsDb } from '../jobs/middleware/jobsContext.mjs'
import { createAccountApiController } from '../account/controllers/accountApiController.mjs'
import { createCepsApiController } from './controllers/cepsfepsApiController.mjs'
import { sendFailure } from '../../adapters/http/responses.mjs'
import { apiRateLimit } from '../../middleware/auth/apiRateLimiter.mjs'

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
export const createFepsApiRoutes = ({ dsManager, freezrPrefs, freezrStatus, logManager }) => {
  const router = Router()

  // ===== CREATE MIDDLEWARE INSTANCES =====
  // Guards (use pure checks from basicAuth.mjs + generic guard creators)
  // setupGuard - Verify freezr is configured
  const setupGuard = createSetupGuard(dsManager)
  // loggedInGuard - Verify user is authenticated
  const loggedInGuard = createAuthGuard('')
  // getAndCheckAccountAppTokenInfo - gets token for later validation. Accepts the account OR creator
  // app token: both are account-level system apps (isLoggedInAccountAppRequest already allows creator),
  // and the ask-app builder (creator) grants a new ask-app's permissions inline via this route.
  const getAndCheckAccountAppTokenInfo = createGetAppTokenInfoFromheaderForApi(dsManager, { ensureAppNames: ['info.freezr.account', 'info.freezr.creator'] })
  const getAppTokenInfo = createGetAppTokenInfoFromheaderForApi(dsManager)
  // Userfiles auth: a scoped ?fileToken= or an Authorization: Bearer <app_token>. The ambient
  // path-scoped cookie is NOT accepted (closes the cross-site/cross-app leak). See plan §3/§4a/§6.
  const getFileTokenInfo = createGetFileTokenInfo(dsManager)
  
  // Context middleware - loads manifest and user data store
  // Order matters: need app list first, then manifest, then userDS
  // todo Modernization - Do we use addUserAppList separately from getTargetManifest? if not combine them
  const addUserAppList = createAddUserAppList(dsManager, freezrPrefs)
  const getTargetManifest = createGetTargetManifest(dsManager, freezrPrefs)
  const addUserDs = createAddUserDs(dsManager, freezrPrefs)
  const addUserPermDBs = createAddOwnerPermsDbForLoggedInuser(dsManager, freezrPrefs, freezrStatus)
  const addPublicRecordsDB = createAddPublicRecordsDB(dsManager, freezrPrefs, freezrStatus)
  const addPublicManifestsDb = createAddPublicManifestsDb(dsManager, freezrPrefs, freezrStatus)
  const addTokenDb = createAddTokenDb(dsManager, freezrPrefs, freezrStatus) // for cascading token deletes on permission revoke
  const addScheduledJobsDb = createAddScheduledJobsDb(dsManager, freezrPrefs) // for enabling/disabling a job's schedule on run_job grant/revoke
  
  // Middleware for feps routes (similar to ceps but for logged-in users)
  const addOwnerPermDBs = createaddOwnerPermsDb(dsManager, freezrPrefs, freezrStatus)
  const addOwnerAppTableAndFsIfNeedBe = createAddAppTableDbAndFsIfNeedbe(dsManager, freezrPrefs, freezrStatus)
  const addStorageLimits = createAddStorageLimits(dsManager, freezrPrefs)
  const addUserFilesDbAndAppFS = createAddUserFilesDbAndAppFS(dsManager, freezrPrefs, freezrStatus)
  
  // Middleware for serverless (& 3PFunctions) routes
  const serverlessPerms = createServerlessPerms(dsManager, freezrPrefs, freezrStatus, serverlessModule)
  const addAppFsFor3PFunctions = createAddAppFsFor3PFunctions(dsManager, freezrPrefs, freezrStatus)
  const add3PFunctionFS = createAdd3PFunctionFS(dsManager, freezrPrefs, freezrStatus, serverlessModule)
  
  // Middleware for LLM routes
  const llmPerms = createGetLlmPerms(dsManager, freezrPrefs)
  const uploadLlm = multer().array('file')

  // Decode a base64 string strictly. Buffer.from(str, 'base64') is LENIENT — for a string it never
  // throws; it silently drops characters outside the base64 alphabet and decodes what's left. So a
  // corrupt payload would otherwise be written as a real (but wrong) file rather than rejected.
  // Re-encode and compare (ignoring whitespace and trailing '=' padding) to reject anything that
  // isn't genuine standard base64. Returns the decoded Buffer, or null if the input is not valid
  // base64. (Truncation of otherwise-valid base64 can't be caught without a length/checksum — out
  // of scope; this catches malformed/garbage input, which is the silent-corruption case.)
  const decodeBase64Strict = (str) => {
    if (typeof str !== 'string') return null
    const buffer = Buffer.from(str, 'base64')
    const norm = (s) => s.replace(/\s+/g, '').replace(/=+$/, '')
    return norm(buffer.toString('base64')) === norm(str) ? buffer : null
  }

  const uploadLlmIfNeeded = (req, res, next) => {
    const isEmpty = (obj) => { for (const prop in obj) { if (Object.hasOwn(obj, prop)) return false } return true }
    // Headless/job path: a background job has no multipart socket stream for multer, so LLM file
    // inputs arrive as base64 JSON (filesBase64: [{ fileName, mimeType, contentBase64 }]). Synthesize
    // the multer-style req.files (originalname + buffer) so the controller/connectors are unchanged.
    // `filesBase64` is therefore a RESERVED top-level body key on this route. See job-download-supplement.md.
    if (req.body && Array.isArray(req.body.filesBase64)) {
      const files = []
      for (const f of req.body.filesBase64) {
        const buffer = decodeBase64Strict((f && f.contentBase64) || '')
        if (buffer === null) return sendFailure(res, 'Invalid filesBase64: contentBase64 is not valid base64', 'uploadLlmIfNeeded', 400)
        files.push({ originalname: (f && f.fileName) || 'file', buffer, size: buffer.length, mimetype: (f && f.mimeType) || '' })
      }
      req.files = files
      delete req.body.filesBase64
      return next()
    }
    if (isEmpty(req.body)) {
      uploadLlm(req, res, (err) => {
        if (err) return sendFailure(res, err, 'uploadLlmIfNeeded', 400)
        if (req.body.options && typeof req.body.options === 'string') {
          try { req.body = JSON.parse(req.body.options) } catch (e) { return sendFailure(res, 'Invalid options JSON', 'uploadLlmIfNeeded', 400) }
        }
        next()
      })
    } else {
      next()
    }
  }
  
  // Multer middleware for file uploads
  const upload = multer().single('file')
  
  // Upload middleware — handles file upload and parses options. `acceptBase64` enables the headless/job
  // base64-JSON path (a background job has no multipart socket stream for multer): the file arrives as
  // { contentBase64, fileName, mimeType, ...options } and we synthesize the multer-style req.file so the
  // controller is unchanged. When enabled, `contentBase64` is a RESERVED top-level body key — so it is
  // enabled ONLY for /upload, NOT for /serverless, whose JSON body (e.g. inputParams) must pass through
  // untouched. Jobs never upload via /serverless; they use /upload. See job-download-supplement.md.
  const makeUploadIfNeeded = (acceptBase64) => (req, res, next) => {
    // Check if body is empty (indicating file upload)
    const isEmpty = (obj) => {
      for (const prop in obj) {
        if (Object.hasOwn(obj, prop)) {
          return false
        }
      }
      return true
    }

    if (acceptBase64 && req.body && typeof req.body === 'object' && typeof req.body.contentBase64 === 'string') {
      const buffer = decodeBase64Strict(req.body.contentBase64)
      if (buffer === null) {
        return sendFailure(res, 'Invalid contentBase64: not valid base64', 'uploadIfNeeded', 400)
      }
      req.file = {
        originalname: req.body.fileName || 'file',
        buffer,
        size: buffer.length,
        mimetype: req.body.mimeType || ''
      }
      delete req.body.contentBase64
      return next()
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
  const uploadIfNeeded = makeUploadIfNeeded(true) // /upload — base64-JSON path enabled for headless jobs
  const uploadIfNeededMultipartOnly = makeUploadIfNeeded(false) // /serverless — JSON body passes through untouched (no base64 hijack)
  
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
  router.get('/manifest/:target_app', setupGuard, loggedInGuard, getAppTokenInfo, apiRateLimit, addUserAppList, getTargetManifest, addUserDs, tokenUserHasFullAppApiRights, getAllAppAppTablesAndSendWithManifest)
  // router.get('/manifest', setupGuard, loggedInGuard, getAppTokenInfo, apiRateLimit, addUserAppList, getTargetManifest, addUserDs, systemAppOrTargetAppRequest, getAllAppAppTablesAndSendWithManifest)

  /**
   * GET /feps/permissions/getall/:app_name
   * Get all permissions for a requestor app
   * 
   * Returns:
   * - Array of permission objects (if groupall not specified)
   * Modernized version of /v1/permissions/getall/:app_name
   */
  router.get('/permissions/getall/:target_app', setupGuard, loggedInGuard, getAppTokenInfo, apiRateLimit, addUserPermDBs, tokenUserHasFullAppApiRights, allRequestorAppPermissions)
  // router.get('/permissions/gethtml/:app_name', setupGuard, loggedInGuard, getAppTokenInfo, apiRateLimit, addUserPermDBs, accountHandler.generatePermissionHTML) // no logner used

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
  router.put('/permissions/change', setupGuard, loggedInGuard, getAndCheckAccountAppTokenInfo, addUserAppList, getTargetManifest, addUserPermDBs, addUserDs, addPublicRecordsDB, addPublicManifestsDb, addTokenDb, addScheduledJobsDb, isLoggedInAccountAppRequest, accountApiController.changeNamedPermissionsHandler)
  
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
  router.post('/write/:app_table/:data_object_id', setupGuard, getAppTokenInfo, rejectWritesForReadOnlyTokens, apiRateLimit, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTableAndFsIfNeedBe, cepsApiController.writeorUpsertRecord)
  
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
  router.post('/write/:app_table', setupGuard, getAppTokenInfo, rejectWritesForReadOnlyTokens, apiRateLimit, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTableAndFsIfNeedBe, cepsApiController.writeorUpsertRecord)

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
  router.put('/update/:app_table/:data_object_id', setupGuard, getAppTokenInfo, rejectWritesForReadOnlyTokens, apiRateLimit, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTableAndFsIfNeedBe, cepsApiController.updateRecord)
  
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
  router.put('/update/:app_table/:data_object_start/*', setupGuard, getAppTokenInfo, rejectWritesForReadOnlyTokens, apiRateLimit, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTableAndFsIfNeedBe, cepsApiController.updateRecord)
  
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
  router.put('/update/:app_table', setupGuard, getAppTokenInfo, rejectWritesForReadOnlyTokens, apiRateLimit, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTableAndFsIfNeedBe, cepsApiController.updateRecord)
  
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
  router.delete('/delete/:app_table', setupGuard, loggedInGuard, getAppTokenInfo, rejectWritesForReadOnlyTokens, apiRateLimit, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTableAndFsIfNeedBe, cepsApiController.deleteRecords)
  
  /**
   * DELETE /feps/delete/:app_table/:data_object_id
   * Delete a record by ID from the specified app table
   * 
   * Returns:
   * - success: boolean
   * - deleteConfirm: object
   */
  router.delete('/delete/:app_table/:data_object_id', setupGuard, loggedInGuard, getAppTokenInfo, rejectWritesForReadOnlyTokens, apiRateLimit, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTableAndFsIfNeedBe, cepsApiController.deleteRecords)
  
  /**
   * DELETE /feps/delete/:app_table/:data_object_start/*
   * Delete a record with path-based ID
   * Handles multi-segment data_object_id paths
   * 
   * Returns:
   * - success: boolean
   * - deleteConfirm: object
   */
  router.delete('/delete/:app_table/:data_object_start/*', setupGuard, loggedInGuard, getAppTokenInfo, rejectWritesForReadOnlyTokens, apiRateLimit, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTableAndFsIfNeedBe, cepsApiController.deleteRecords)
  
    
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
  router.post('/restore/:app_table', setupGuard, loggedInGuard, getAppTokenInfo, rejectWritesForReadOnlyTokens, apiRateLimit, addDataOwnerToContext, addOwnerPermDBs, addRightsToTable, addOwnerAppTableAndFsIfNeedBe, cepsApiController.restoreRecord)
  
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
  router.put('/upload/:app_name', setupGuard, getAppTokenInfo, rejectWritesForReadOnlyTokens, apiRateLimit, uploadIfNeeded, defineFileAppTableFromAppName, addDataOwnerToContext, 
     addOwnerPermDBs, 
     addRightsToTable, 
     addUserFilesDbAndAppFS, 
     cepsApiController.uploadUserFileAndCreateRecord)
    // nb addOwnerPermDBs left in in case of future upload perms

  /**
   * POST /feps/read_user_file_tree/:app_name
   * JSON body (optional): subPath, readSubFolders, maxFiles, maxDepth, includeMetadata
   * Same user-files root as PUT /feps/upload/:app_name (users_freezr/{user}/files/{app_name}/).
   */
  router.post(
    '/read_user_file_tree/:app_name',
    setupGuard,
    getAppTokenInfo,
    defineFileAppTableFromAppName,
    addDataOwnerToContext,
    addOwnerPermDBs,
    addRightsToTable,
    addUserFilesDbAndAppFS,
    cepsApiController.readUserFileTree
  )

  /**
   * GET /feps/userfiles/:app_name/:user_id/*
   * Serve a user file, authenticated via path-scoped app_token cookie
   * 
   * Returns:
   * - File content (served directly)
   */
  router.get('/userfiles/:app_name/:user_id/*', setupGuard, defineFileAppTableFromAppName, getFileTokenInfo, async (req, res, next) => {
    res.locals.freezr = {
      ...res.locals.freezr,
      data_owner_id: req.params.user_id
    }
    next()
  
  }, addOwnerAppTableAndFsIfNeedBe, cepsApiController.sendUserFile)
  // note: 2025-12 fetchuserfiles is not used anymore - use userfiles instead

  /**
   * GET /feps/getuserfiletoken/:permission_name/:app_name/:user_id   (optional ?file=<path>)
   * Mint a short-lived, scoped fileToken (Bearer-authed as the requesting app) so native
   * <img>/<video>/CSS loads can authenticate private userfiles without the ambient cookie.
   * SELF (own app+user) or GRANTEE (another user's file, via an _accessibles grant). The owner's
   * <app>.files DB is opened (addOwnerAppTableAndFsIfNeedBe) so the grantee grant-check can read the
   * shared record. See freezr_file_access_plan_v1.md §4b/§5.
   */
  router.get('/getuserfiletoken/:permission_name/:app_name/:user_id', setupGuard, getAppTokenInfo, apiRateLimit, defineFileAppTableFromAppName, (req, res, next) => {
    res.locals.freezr = { ...res.locals.freezr, data_owner_id: req.params.user_id }
    next()
  }, addOwnerAppTableAndFsIfNeedBe, cepsApiController.getUserFileToken)

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
  router.put('/serverless/:task', setupGuard, getAppTokenInfo, rejectWritesForReadOnlyTokens, apiRateLimit, uploadIfNeededMultipartOnly, serverlessPerms, addAppFsFor3PFunctions, add3PFunctionFS, cepsApiController.serverlessTasks)
  router.get('/serverless/:task', setupGuard, getAppTokenInfo, apiRateLimit, serverlessPerms, add3PFunctionFS, cepsApiController.serverlessTasks)

  // ===== LLM ROUTES =====

  /**
   * PUT /feps/llm/ask
   * Send a prompt to an LLM using the user's stored API keys
   * Permission is resolved by type (use_llm) rather than by name.
   * 
   * Body (JSON or multipart with files):
   * - prompt: The text prompt to send
   * - options: Optional object with provider preferences, model, etc.
   * - file(s): Optional file attachments (via multipart/form-data)
   * 
   * Returns:
   * - success: boolean
   * - response: The LLM response text
   * - meta: Object with prompt echo, provider info
   */
  router.put('/llm/ask', setupGuard, getAppTokenInfo, rejectWritesForReadOnlyTokens, apiRateLimit, uploadLlmIfNeeded, llmPerms, cepsApiController.llmAsk)

  /**
   * PUT /feps/llm/generate_image
   * Generate an image using the user's stored LLM API keys.
   * Respects user's default provider via getSelectedResource.
   * OpenAI: raster PNG via dynamically-resolved image model. Anthropic: SVG via text API, converted to PNG via sharp.
   *
   * Body (JSON):
   * - prompt: Text description of the image
   * - provider: Optional provider override ('ChatGPT' or 'Claude'); defaults to user's default
   * - model: Optional model override; adapter picks default if omitted
   * - size: Optional image size (default '1024x1024')
   * - quality: Optional quality level (default 'auto')
   * - outputFormat: 'png' (default) or 'svg'
   */
  router.put('/llm/generate_image', setupGuard, getAppTokenInfo, rejectWritesForReadOnlyTokens, apiRateLimit, llmPerms, cepsApiController.llmGenerateImage)

  /**
   * PUT /feps/llm/transcribe
   * Speech to text, using the user's stored LLM API keys. ChatGPT only for now — Anthropic
   * ships no STT, so a Claude-only user gets a structured capability_unsupported naming
   * ChatGPT (checked BEFORE the provider is called, so a refused request costs nothing).
   *
   * uploadLlmIfNeeded is on this route because the audio arrives the same two ways an ask()
   * attachment does: multipart for a browser, `filesBase64` JSON for a background job.
   *
   * Body (multipart or JSON):
   * - file / filesBase64: the audio clip
   * - options: { provider, model, language, prompt }  (language and prompt are accuracy hints)
   */
  router.put('/llm/transcribe', setupGuard, getAppTokenInfo, rejectWritesForReadOnlyTokens, apiRateLimit, uploadLlmIfNeeded, llmPerms, cepsApiController.llmTranscribe)

  /**
   * PUT /feps/llm/speak
   * Text to speech, using the user's stored LLM API keys. ChatGPT only, as above.
   * Returns base64 audio, the same way generate_image returns a base64 image.
   *
   * Body (JSON):
   * - text: what to say
   * - options: { provider, model, voice, format, instructions }
   */
  router.put('/llm/speak', setupGuard, getAppTokenInfo, rejectWritesForReadOnlyTokens, apiRateLimit, llmPerms, cepsApiController.llmSpeak)

  return router
}

export default {
  createFepsApiRoutes
}

