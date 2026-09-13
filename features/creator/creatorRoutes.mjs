import { Router } from 'express'
import multer from 'multer'
import { createSetupGuard, createAuthGuard, createOrUpdateTokenGuardFromPage, createGetAppTokenInfoFromheaderForApi } from '../../middleware/auth/basicAuth.mjs'
import { createAddUserDSAndAppFS, createAddPublicManifestsDb } from '../account/middleware/accountContext.mjs'
import { createAddOwnerPermsDbForLoggedInuser } from '../../middleware/permissions/permissionContext.mjs'
import { createAddPublicRecordsDB } from '../public/middleware/publicContext.mjs'
import { isLoggedInCreatorAppRequest } from '../../middleware/permissions/permissionCheckers.mjs'
import { sendFailure } from '../../adapters/http/responses.mjs'
import { createCreatorPageController } from './controllers/creatorPageController.mjs'
import { createCreatorApiController } from './controllers/creatorApiController.mjs'
import { createInspectController } from './controllers/inspectController.mjs'
import { createAccountApiController } from '../account/controllers/accountApiController.mjs'
import { createAddTokenDb } from '../account/middleware/accountContext.mjs'
import { createAddTrustedJobsDbIfAdmin } from '../jobs/middleware/jobsContext.mjs'

export const createCreatorPageRoutes = ({ dsManager, freezrPrefs, freezrStatus }) => {
  const router = Router()

  const setupGuard = createSetupGuard(dsManager)
  const loggedInGuard = createAuthGuard('/account/login')
  const pageTokenGuard = createOrUpdateTokenGuardFromPage(dsManager, { forceAppName: 'info.freezr.creator' })
  const addUserDSAndAppFS = createAddUserDSAndAppFS(dsManager, freezrPrefs, freezrStatus)
  const creatorPageController = createCreatorPageController()

  router.get(
    '/',
    setupGuard,
    loggedInGuard,
    pageTokenGuard,
    addUserDSAndAppFS,
    creatorPageController.generateCreatorPage
  )

  // Ask-app builder — a lighter creator mode where the user asks a question about their data and
  // the LLM builds a small page answering it. Shares the creator app token (cookie path '/creator').
  router.get(
    '/ask',
    setupGuard,
    loggedInGuard,
    pageTokenGuard,
    addUserDSAndAppFS,
    creatorPageController.generateAskBuilderPage
  )

  // Inspection route — token-authed, NO session (freezr_creator_selfcheck_plan_v1.md §A3).
  // Serves one app's page/source files to the holder of a short-lived inspect token
  // (?inspectToken= or Cookie), minted via POST /creatorapi/create_inspection_token.
  // Deliberately its own chain: no loggedInGuard, no pageTokenGuard (which mints real tokens).
  const inspectController = createInspectController({ dsManager, freezrPrefs })
  // Declared-vs-granted permissions (metadata only, no records) — must precede the file wildcard.
  router.get(
    '/inspect/:app_name/__permissions',
    setupGuard,
    inspectController.getInspectTokenInfo,
    inspectController.sendInspectPermissions
  )
  router.get(
    '/inspect/:app_name/*',
    setupGuard,
    inspectController.getInspectTokenInfo,
    inspectController.sendInspectAppFile
  )
  router.get(
    '/inspect/:app_name',
    setupGuard,
    inspectController.getInspectTokenInfo,
    inspectController.sendInspectAppFile
  )

  return router
}

const addCreatorAppAsReqParam = (req, res, next) => {
  req.params.app_name = 'info.freezr.creator'
  next()
}

const VALID_GET_ACTIONS = { user_apps: 'getUserApps', installed_apps_context: 'getInstalledAppsContext', manifest_reference: 'getManifestReference', read_folder: 'readFolder', read_app_file: 'readAppFile', read_all_files: 'readAllFiles', validate_app_files: 'validateAppFiles' }
const VALID_POST_ACTIONS = { create_new_app: 'createBlankApp', create_ask_app: 'createAskApp', write_app_file: 'writeAppFile', copy_app_files: 'copyAppFiles', clone_app_files: 'cloneAppFiles', refresh_askapp_scaffold: 'refreshAskAppScaffold', sync_context: 'syncContext' }

const createRouteDispatcher = (actionMap, controller) => (req, res) => {
  const action = req.params.action
  const handlerName = actionMap[action]
  if (!handlerName || !controller[handlerName]) {
    return sendFailure(res, 'Unknown action: ' + action, 'creatorApiRoutes', 404)
  }
  return controller[handlerName](req, res)
}

export const createCreatorApiRoutes = ({ dsManager, freezrPrefs, freezrStatus }) => {
  const router = Router()

  const setupGuard = createSetupGuard(dsManager)
  const loggedInGuard = createAuthGuard()
  const getAndCheckCreatorAppTokenInfo = createGetAppTokenInfoFromheaderForApi(dsManager, { ensureAppName: 'info.freezr.creator' })
  const addUserDSAndAppFS = createAddUserDSAndAppFS(dsManager, freezrPrefs, freezrStatus)
  const addOwnerPermsDb = createAddOwnerPermsDbForLoggedInuser(dsManager, freezrPrefs, freezrStatus)
  const addPublicManifestsDb = createAddPublicManifestsDb(dsManager, freezrPrefs, freezrStatus)

  const creatorApiController = createCreatorApiController()
  const accountApiController = createAccountApiController()

  const sharedMiddleware = [
    setupGuard,
    loggedInGuard,
    getAndCheckCreatorAppTokenInfo,
    addCreatorAppAsReqParam,
    addUserDSAndAppFS,
    isLoggedInCreatorAppRequest
  ]

  const addPublicRecordsDb = createAddPublicRecordsDB(dsManager, freezrPrefs, freezrStatus)
  // Admin-only, non-fatal: fradmin trusted-jobs db so an admin re-install can disable a CHANGED job's trust.
  const addTrustedJobsDbIfAdmin = createAddTrustedJobsDbIfAdmin(dsManager, freezrPrefs)

  router.post('/update_app_from_files', ...sharedMiddleware, addOwnerPermsDb, addPublicManifestsDb, addTrustedJobsDbIfAdmin, accountApiController.updateAppFromFilesController)

  router.post('/rename_app', ...sharedMiddleware, addOwnerPermsDb, creatorApiController.renameApp)

  router.post('/package_ask_app_for_share', ...sharedMiddleware, creatorApiController.packageAskAppForShare)

  router.post('/publish_app', ...sharedMiddleware, addPublicRecordsDb, creatorApiController.publishApp)
  router.post('/unpublish_app', ...sharedMiddleware, addPublicRecordsDb, creatorApiController.unpublishApp)
  router.get('/published_versions', ...sharedMiddleware, addPublicRecordsDb, creatorApiController.getPublishedVersions)

  const upload = multer({ storage: multer.memoryStorage() })
  router.post('/upload_app_file', ...sharedMiddleware, upload.single('file'), creatorApiController.uploadAppFile)

  // Receive path: install/update a shared ask-app from the zip bytes the RECIPIENT fetched client-side
  // via a grantee ?fileToken= (the browser owns the fileToken; userfiles no longer accepts Bearer, and a
  // server self-fetch was unreliable). Reuses the account install-from-zipfile pipeline under the creator
  // token, mirroring update_app_from_files. See freezr_askapp_sharing_summary.md §4.
  router.post('/install_shared_ask_app_zip', ...sharedMiddleware, upload.single('file'), addOwnerPermsDb, addPublicManifestsDb, accountApiController.installAppFromZipFile)

  // Mint a short-lived inspection token (files scope always; data scope opt-in, read-only) —
  // freezr_creator_selfcheck_plan_v1.md Part A. Needs the token DB for the data-scope mint.
  const addTokenDb = createAddTokenDb(dsManager, freezrPrefs, freezrStatus)
  router.post('/create_inspection_token', ...sharedMiddleware, addTokenDb, creatorApiController.createInspectionToken)

  router.get('/:action', ...sharedMiddleware, createRouteDispatcher(VALID_GET_ACTIONS, creatorApiController))
  router.post('/:action', ...sharedMiddleware, createRouteDispatcher(VALID_POST_ACTIONS, creatorApiController))

  return router
}

export default { createCreatorPageRoutes, createCreatorApiRoutes }
