// freezr.info - Connections Routes
//
// Mounts dedicated routes for the info.freezr.connections umbrella app:
//   GET /connections           → index page (account list)
//   GET /connections/:page     → specific page (mail today; calendar/contacts later)
//
// Pattern mirrors features/creator/creatorRoutes.mjs.
//
// A future cross-cutting cleanup (§8 route consolidation in freezr_mail_phase1.md)
// will replace this and the similar per-app routers (account, admin, creator) with
// a single generic alias mechanism driven by config. For now, this is the smallest
// dedicated layer that gives /connections/mail the same first-class feel as
// /creator and /account/*.

import { Router } from 'express'
import { createSetupGuard, createAuthGuard, createOrUpdateTokenGuardFromPage } from '../../middleware/auth/basicAuth.mjs'
import { createAddUserDSAndAppFS } from '../account/middleware/accountContext.mjs'
import { createConnectionsPageController } from './controllers/connectionsPageController.mjs'

export const createConnectionsPageRoutes = ({ dsManager, freezrPrefs, freezrStatus }) => {
  const router = Router()

  const setupGuard = createSetupGuard(dsManager)
  const loggedInGuard = createAuthGuard('/account/login')
  // Force the page token to bind to info.freezr.connections regardless of what
  // app the user previously had a session for. Same trick creator uses.
  const pageTokenGuard = createOrUpdateTokenGuardFromPage(dsManager, { forceAppName: 'info.freezr.connections' })
  const addUserDSAndAppFS = createAddUserDSAndAppFS(dsManager, freezrPrefs, freezrStatus)

  const setConnectionsAppName = (req, res, next) => {
    req.params.app_name = 'info.freezr.connections'
    next()
  }

  const controller = createConnectionsPageController()

  // /connections → index page
  router.get('/',
    setupGuard,
    loggedInGuard,
    setConnectionsAppName,
    pageTokenGuard,
    addUserDSAndAppFS,
    (req, res, next) => { req.params.page = 'index'; next() },
    controller.generateConnectionsPage
  )

  // /connections/<page> — mail today, more pages later
  router.get('/:page',
    setupGuard,
    loggedInGuard,
    setConnectionsAppName,
    pageTokenGuard,
    addUserDSAndAppFS,
    controller.generateConnectionsPage
  )

  return router
}

export default { createConnectionsPageRoutes }
