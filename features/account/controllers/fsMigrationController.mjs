// freezr.info - fsMigrationController.mjs
//
// HTTP handlers for user-initiated file-system migration (mounted under /acctapi).
// Orchestration lives in services/fsMigrationService.mjs; these handlers do auth,
// password gating (for the two destructive actions), and shape the JSON responses.

import { sendApiSuccess, sendFailure } from '../../../adapters/http/responses.mjs'
import User from '../../../common/misc/userObj.mjs'
import { ENV_PARAMS } from '../../../adapters/datastore/environmentDefaults.mjs'
import { SYSTEM_USER_IDS } from '../../../common/helpers/config.mjs'
import {
  startFsMigration,
  abortFsMigration,
  retryFsMigration,
  dismissFailedMigration,
  rollbackFsMigration,
  confirmDeleteOldFs,
  getFsMigrationStatus,
  IS_DEV_ENV
} from '../services/fsMigrationService.mjs'

// The host/system default is a restricted target — offered/allowed only in a dev environment
// OR for an admin (an admin/dev may want to test it on a real cloud instance).
const allowSystemTargetFor = (req) => IS_DEV_ENV || !!req.session?.logged_in_as_admin

const WHO = 'fsMigrationController'

// Verify the session user matches and (for destructive actions) the supplied password.
const checkPassword = async (req, res) => {
  const userId = req.session?.logged_in_user_id
  const allUsersDb = res.locals?.freezr?.allUsersDb
  if (!allUsersDb) { sendFailure(res, 'Users database not available', WHO, 500); return null }
  const rows = await allUsersDb.query({ user_id: userId }, null)
  if (!rows || rows.length === 0) { sendFailure(res, 'User not found', WHO, 404); return null }
  const u = new User(rows[0])
  if (!u.check_passwordSync(req.body?.oldPassword)) { sendFailure(res, 'Wrong password', WHO, 401); return null }
  return userId
}

// Actions whose handlers call checkPassword and therefore need res.locals.freezr.allUsersDb.
// The route layer uses this to attach the users db only for these actions (it is a powerful
// handle, so we avoid loading it for the read-only / unprivileged actions).
export const ACTIONS_REQUIRING_USERSDB = ['start', 'confirmDelete']

export const createFsMigrationController = ({ freezrPrefs } = {}) => {
  const handleStart = async (req, res) => {
    try {
      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'Not logged in', WHO, 401)
      // System accounts (fradmin/test/public) are blocked: their storage backs the server's own
      // databases (the users list, the fs_migrations table, the environment), so migrating one
      // would move the very state this migration reads and writes. A server can have multiple
      // admin *users*, and they migrate their own accounts normally.
      if (SYSTEM_USER_IDS.includes(userId)) return sendFailure(res, 'System accounts cannot be migrated this way', WHO, 403)
      const verified = await checkPassword(req, res)
      if (!verified) return // checkPassword already responded

      const targetFsParams = req.body?.targetFsParams
      if (!targetFsParams || !targetFsParams.type) return sendFailure(res, 'Missing target storage parameters', WHO, 400)
      const confirmContinue = !!req.body?.confirmContinue

      const result = await startFsMigration({ userId, targetFsParams, confirmContinue, allowSystemTarget: allowSystemTargetFor(req) })
      return sendApiSuccess(res, { success: true, ...result })
    } catch (error) {
      // The target already holds data — surface as a confirmable prompt, not a hard failure.
      if (error.code === 'TARGET_NOT_EMPTY') {
        return sendApiSuccess(res, { success: true, needsConfirm: true, reason: 'target_not_empty', fileCount: error.fileCount, message: error.message })
      }
      console.error('❌ fsMigration.handleStart:', error.message)
      return sendFailure(res, error.message, WHO + '.start', error.code ? 400 : 500)
    }
  }

  // Returns the same FS provider field definitions the register page uses (ENV_PARAMS.FS),
  // limited to the choices valid as a migration target (the 'newParams' scenario, minus the
  // host-default option). The migration form renders inputs from this, identically to /register.
  const handleFsOptions = async (req, res) => {
    try {
      const FS = ENV_PARAMS.FS || {}
      const options = {}
      const add = (key) => { const p = FS[key]; if (p && p.forPages && p.forPages.includes('newParams')) options[key] = p }
      // S3 first (the recommended/default target), then S3-compatible, then the rest.
      add('aws')
      add('s3compatible')
      add('azure')
      add('googleDrive')
      add('dropbox')
      // Host/system default — restricted test target, only for dev or admins (see allowSystemTargetFor).
      if (allowSystemTargetFor(req) && FS.sysDefault) options.sysDefault = FS.sysDefault
      return sendApiSuccess(res, { success: true, fsOptions: options })
    } catch (error) {
      return sendFailure(res, error.message, WHO + '.fsOptions', 500)
    }
  }

  const handleStatus = async (req, res) => {
    try {
      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'Not logged in', WHO, 401)
      const status = await getFsMigrationStatus(userId)
      return sendApiSuccess(res, { success: true, migration: status })
    } catch (error) {
      return sendFailure(res, error.message, WHO + '.status', 500)
    }
  }

  const handleRollback = async (req, res) => {
    try {
      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'Not logged in', WHO, 401)
      const result = await rollbackFsMigration(userId)
      return sendApiSuccess(res, { success: true, ...result })
    } catch (error) {
      return sendFailure(res, error.message, WHO + '.rollback', 400)
    }
  }

  const handleConfirmDelete = async (req, res) => {
    try {
      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'Not logged in', WHO, 401)
      const verified = await checkPassword(req, res)
      if (!verified) return
      const result = await confirmDeleteOldFs(userId)
      return sendApiSuccess(res, { success: true, ...result })
    } catch (error) {
      return sendFailure(res, error.message, WHO + '.confirmDelete', 400)
    }
  }

  const handleRetry = async (req, res) => {
    try {
      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'Not logged in', WHO, 401)
      const result = await retryFsMigration(userId)
      return sendApiSuccess(res, { success: true, ...result })
    } catch (error) {
      return sendFailure(res, error.message, WHO + '.retry', 400)
    }
  }

  const handleDismiss = async (req, res) => {
    try {
      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'Not logged in', WHO, 401)
      const result = await dismissFailedMigration(userId)
      return sendApiSuccess(res, { success: true, ...result })
    } catch (error) {
      return sendFailure(res, error.message, WHO + '.dismiss', 400)
    }
  }

  const handleAbort = async (req, res) => {
    try {
      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'Not logged in', WHO, 401)
      const result = await abortFsMigration(userId)
      return sendApiSuccess(res, { success: true, ...result })
    } catch (error) {
      return sendFailure(res, error.message, WHO + '.abort', 400)
    }
  }

  // ----- dispatch ---------------------------------------------------------------------
  // Two routes (GET + PUT) on /fsMigration/:action fan out here. The maps are explicit
  // whitelists, so an unknown :action 404s rather than reaching an arbitrary method.
  const GET_ACTIONS = { status: handleStatus, fsOptions: handleFsOptions }
  const PUT_ACTIONS = { start: handleStart, rollback: handleRollback, confirmDelete: handleConfirmDelete, abort: handleAbort, retry: handleRetry, dismiss: handleDismiss }

  const handleGet = (req, res) => {
    const fn = GET_ACTIONS[req.params.action]
    if (!fn) return sendFailure(res, 'Unknown migration action: ' + req.params.action, WHO, 404)
    return fn(req, res)
  }
  const handleAction = (req, res) => {
    const fn = PUT_ACTIONS[req.params.action]
    if (!fn) return sendFailure(res, 'Unknown migration action: ' + req.params.action, WHO, 404)
    return fn(req, res)
  }

  return { handleGet, handleAction }
}

export default { createFsMigrationController }
