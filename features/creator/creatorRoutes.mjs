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
import { createAccountApiController } from '../account/controllers/accountApiController.mjs'
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

  return router
}

const addCreatorAppAsReqParam = (req, res, next) => {
  req.params.app_name = 'info.freezr.creator'
  next()
}

const VALID_GET_ACTIONS = { user_apps: 'getUserApps', read_folder: 'readFolder', read_app_file: 'readAppFile', read_all_files: 'readAllFiles' }
const VALID_POST_ACTIONS = { create_new_app: 'createBlankApp', write_app_file: 'writeAppFile', sync_context: 'syncContext' }

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

  router.post('/publish_app', ...sharedMiddleware, addPublicRecordsDb, creatorApiController.publishApp)
  router.post('/unpublish_app', ...sharedMiddleware, addPublicRecordsDb, creatorApiController.unpublishApp)
  router.get('/published_versions', ...sharedMiddleware, addPublicRecordsDb, creatorApiController.getPublishedVersions)

  const upload = multer({ storage: multer.memoryStorage() })
  router.post('/upload_app_file', ...sharedMiddleware, upload.single('file'), creatorApiController.uploadAppFile)

  router.get('/:action', ...sharedMiddleware, createRouteDispatcher(VALID_GET_ACTIONS, creatorApiController))
  router.post('/:action', ...sharedMiddleware, createRouteDispatcher(VALID_POST_ACTIONS, creatorApiController))

  return router
}

export default { createCreatorPageRoutes, createCreatorApiRoutes }
