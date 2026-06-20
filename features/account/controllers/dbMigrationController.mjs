// freezr.info - dbMigrationController.mjs
//
// HTTP handlers for user-initiated database migration (mounted under /acctapi). Orchestration
// lives in services/dbMigrationService.mjs; these handlers do auth, password gating (for the two
// destructive actions), and shape the JSON responses. Mirrors fsMigrationController.

import { sendApiSuccess, sendFailure } from '../../../adapters/http/responses.mjs'
import User from '../../../common/misc/userObj.mjs'
import { ENV_PARAMS } from '../../../adapters/datastore/environmentDefaults.mjs'
import { SYSTEM_USER_IDS } from '../../../common/helpers/config.mjs'
import {
  startDbMigration,
  abortDbMigration,
  retryDbMigration,
  dismissFailedDbMigration,
  rollbackDbMigration,
  confirmDeleteOldDb,
  getDbMigrationStatus,
  IS_DEV_ENV
} from '../services/dbMigrationService.mjs'

const WHO = 'dbMigrationController'

// The host/system default is a restricted target — dev environment or admin only.
const allowSystemTargetFor = (req) => IS_DEV_ENV || !!req.session?.logged_in_as_admin

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

export const ACTIONS_REQUIRING_USERSDB = ['start', 'confirmDelete']

// De-duplicate field definitions by name (the mongoDetails list has a duplicate `user`), and
// never echo the unify checkbox's transient form name issues — pass field defs straight through.
const dedupeFields = (fields) => {
  const seen = new Set()
  return (fields || []).filter(f => (seen.has(f.name) ? false : (seen.add(f.name), true)))
}

export const createDbMigrationController = ({ freezrPrefs } = {}) => {
  const handleStart = async (req, res) => {
    try {
      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'Not logged in', WHO, 401)
      if (SYSTEM_USER_IDS.includes(userId)) return sendFailure(res, 'System accounts cannot be migrated this way', WHO, 403)
      const verified = await checkPassword(req, res)
      if (!verified) return

      const targetDbParams = req.body?.targetDbParams
      if (!targetDbParams || !targetDbParams.type) return sendFailure(res, 'Missing target database parameters', WHO, 400)
      const confirmContinue = !!req.body?.confirmContinue

      const result = await startDbMigration({ userId, targetDbParams, confirmContinue, allowSystemTarget: allowSystemTargetFor(req) })
      return sendApiSuccess(res, { success: true, ...result })
    } catch (error) {
      if (error.code === 'TARGET_NOT_EMPTY') {
        return sendApiSuccess(res, { success: true, needsConfirm: true, reason: 'target_not_empty', recordCount: error.recordCount, message: error.message })
      }
      console.error('❌ dbMigration.handleStart:', error.message)
      return sendFailure(res, error.message, WHO + '.start', error.code ? 400 : 500)
    }
  }

  // DB provider field definitions for the migration form (same ENV_PARAMS.DB the register page
  // uses), limited to the choices valid as a migration target.
  const handleDbOptions = async (req, res) => {
    try {
      const DB = ENV_PARAMS.DB || {}
      const options = {}
      const add = (key) => {
        const p = DB[key]
        if (p && p.forPages && p.forPages.includes('newParams')) {
          options[key] = { ...p, fields: dedupeFields(p.fields) }
        }
      }
      add('mongoString')
      add('cosmosForMongoString')
      add('mongoDetails')
      add('mongoLocal')
      add('nedb')
      // Host/system default — restricted test target (dev or admin only).
      if (allowSystemTargetFor(req) && DB.sysDefault) options.sysDefault = DB.sysDefault
      return sendApiSuccess(res, { success: true, dbOptions: options })
    } catch (error) {
      return sendFailure(res, error.message, WHO + '.dbOptions', 500)
    }
  }

  const handleStatus = async (req, res) => {
    try {
      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'Not logged in', WHO, 401)
      const status = await getDbMigrationStatus(userId)
      return sendApiSuccess(res, { success: true, migration: status })
    } catch (error) {
      return sendFailure(res, error.message, WHO + '.status', 500)
    }
  }

  const handleRollback = async (req, res) => {
    try {
      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'Not logged in', WHO, 401)
      const result = await rollbackDbMigration(userId)
      return sendApiSuccess(res, { success: true, ...result })
    } catch (error) { return sendFailure(res, error.message, WHO + '.rollback', 400) }
  }

  const handleConfirmDelete = async (req, res) => {
    try {
      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'Not logged in', WHO, 401)
      const verified = await checkPassword(req, res)
      if (!verified) return
      const result = await confirmDeleteOldDb(userId)
      return sendApiSuccess(res, { success: true, ...result })
    } catch (error) { return sendFailure(res, error.message, WHO + '.confirmDelete', 400) }
  }

  const handleRetry = async (req, res) => {
    try {
      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'Not logged in', WHO, 401)
      const result = await retryDbMigration(userId)
      return sendApiSuccess(res, { success: true, ...result })
    } catch (error) { return sendFailure(res, error.message, WHO + '.retry', 400) }
  }

  const handleDismiss = async (req, res) => {
    try {
      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'Not logged in', WHO, 401)
      const result = await dismissFailedDbMigration(userId)
      return sendApiSuccess(res, { success: true, ...result })
    } catch (error) { return sendFailure(res, error.message, WHO + '.dismiss', 400) }
  }

  const handleAbort = async (req, res) => {
    try {
      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'Not logged in', WHO, 401)
      const result = await abortDbMigration(userId)
      return sendApiSuccess(res, { success: true, ...result })
    } catch (error) { return sendFailure(res, error.message, WHO + '.abort', 400) }
  }

  const GET_ACTIONS = { status: handleStatus, dbOptions: handleDbOptions }
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

export default { createDbMigrationController }
