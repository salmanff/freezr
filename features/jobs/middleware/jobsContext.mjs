// freezr.info — Jobs context middleware - jobsContext.mjs
//
// Follows the freezr principle: dsManager stays in the chain/context layer; it opens the
// specific db and hands the leaf handlers/services only the db handle they need.

import { TRUSTED_JOBS_OAC, APP_TOKEN_OAC, SCHEDULED_JOBS_OAC, USER_DB_OAC } from '../../../common/helpers/config.mjs'
import { sendFailure } from '../../../adapters/http/responses.mjs'
import { isUserAdmin } from '../services/userAdminStatus.mjs'

/**
 * Opens the trusted-jobs registry db and sets res.locals.freezr.trustedJobsDb.
 * Handlers then use that handle (and pass it to trustedJobService) — they never see dsManager.
 */
export const createAddTrustedJobsDb = (dsManager, freezrPrefs) => {
  return async (req, res, next) => {
    try {
      if (!res.locals.freezr) res.locals.freezr = {}
      res.locals.freezr.trustedJobsDb = await dsManager.getorInitDb(TRUSTED_JOBS_OAC, { freezrPrefs })
      next()
    } catch (error) {
      console.error('❌ Error in addTrustedJobsDb middleware:', error)
      return sendFailure(res, 'Could not access trusted jobs database', 'addTrustedJobsDb', 500)
    }
  }
}

/**
 * Like createAddTrustedJobsDb but ADMIN-GATED and NON-FATAL: sets res.locals.freezr.trustedJobsDb ONLY
 * when the requester is an admin; otherwise leaves it unset and proceeds. For the INSTALL/UPDATE routes,
 * where a controller copies the handle into the install context so a re-install can disable the trust of
 * a CHANGED local job (admin re-review). The trusted-jobs table is fradmin-owned and powerful, so a
 * non-admin install never receives the handle, and dsManager itself is never passed downstream.
 */
export const createAddTrustedJobsDbIfAdmin = (dsManager, freezrPrefs) => {
  return async (req, res, next) => {
    try {
      if (!res.locals.freezr) res.locals.freezr = {}
      const userId = req.session?.logged_in_user_id
      const isAdmin = !!req.session?.logged_in_as_admin || (userId ? await isUserAdmin(dsManager.getDB(USER_DB_OAC), userId) : false)
      if (isAdmin) res.locals.freezr.trustedJobsDb = await dsManager.getorInitDb(TRUSTED_JOBS_OAC, { freezrPrefs })
    } catch (error) {
      console.warn('⚠️  addTrustedJobsDbIfAdmin (non-fatal — change-detection just won\'t run): ' + (error && error.message))
    }
    next()
  }
}

/**
 * Opens the app-token db and sets res.locals.freezr.appTokenDb (for minting job tokens).
 * Same principle: jobTokenService receives this handle, never dsManager.
 */
export const createAddAppTokenDb = (dsManager) => {
  return (req, res, next) => {
    try {
      if (!res.locals.freezr) res.locals.freezr = {}
      res.locals.freezr.appTokenDb = dsManager.getDB(APP_TOKEN_OAC)
      next()
    } catch (error) {
      console.error('❌ Error in addAppTokenDb middleware:', error)
      return sendFailure(res, 'Could not access app token database', 'addAppTokenDb', 500)
    }
  }
}

/**
 * Opens the (server-wide, fradmin) scheduled-jobs table and sets res.locals.freezr.scheduledJobsDb.
 */
export const createAddScheduledJobsDb = (dsManager, freezrPrefs) => {
  return async (req, res, next) => {
    try {
      if (!res.locals.freezr) res.locals.freezr = {}
      res.locals.freezr.scheduledJobsDb = await dsManager.getorInitDb(SCHEDULED_JOBS_OAC, { freezrPrefs })
      next()
    } catch (error) {
      console.error('❌ Error in addScheduledJobsDb middleware:', error)
      return sendFailure(res, 'Could not access scheduled jobs database', 'addScheduledJobsDb', 500)
    }
  }
}

/**
 * Opens the acting user's resources db (info.freezr.account.resources) — where compute credentials
 * live — and sets res.locals.freezr.computeResourcesDb. The cloud-cost gate reads it. Owner = the
 * token's owner_id (the user who pays for the run, §14.1). No-op if no token yet.
 */
export const createAddComputeResourcesDb = (dsManager, freezrPrefs) => {
  return async (req, res, next) => {
    try {
      if (!res.locals.freezr) res.locals.freezr = {}
      const userId = res.locals.freezr?.tokenInfo?.owner_id
      if (userId) {
        res.locals.freezr.computeResourcesDb = await dsManager.getorInitDb({ app_table: 'info.freezr.account.resources', owner: userId }, { freezrPrefs })
      }
      next()
    } catch (error) {
      console.error('❌ Error in addComputeResourcesDb middleware:', error)
      return sendFailure(res, 'Could not access resources database', 'addComputeResourcesDb', 500)
    }
  }
}

/**
 * Opens the acting user's resource-usage meter (info.freezr.account.resourceUsage) and sets
 * res.locals.freezr.resourceUsageDb. Cost rows for serverless runs (and LLM later) land here (§9.2).
 */
export const createAddResourceUsageDb = (dsManager, freezrPrefs) => {
  return async (req, res, next) => {
    try {
      if (!res.locals.freezr) res.locals.freezr = {}
      const userId = res.locals.freezr?.tokenInfo?.owner_id
      if (userId) {
        res.locals.freezr.resourceUsageDb = await dsManager.getorInitDb({ app_table: 'info.freezr.account.resourceUsage', owner: userId }, { freezrPrefs })
      }
      next()
    } catch (error) {
      console.error('❌ Error in addResourceUsageDb middleware:', error)
      return sendFailure(res, 'Could not access resource usage database', 'addResourceUsageDb', 500)
    }
  }
}

export default { createAddTrustedJobsDb, createAddTrustedJobsDbIfAdmin, createAddAppTokenDb, createAddScheduledJobsDb, createAddComputeResourcesDb, createAddResourceUsageDb }
