// freezr.info - Modern ES6 Module - Admin Context Middleware
// Middleware for handling admin-specific context and data loading
//
// Architecture Pattern:
// - Modern version puts data in res.locals (not req parameters)
// - Replicates legacy addFradminDs functionality

import { USER_DB_OAC } from '../../../common/helpers/config.mjs'
import { sendFailure, sendAuthFailure } from '../../../adapters/http/responses.mjs'
import { createBaseFreezrContextForResLocals } from '../../../common/helpers/context.mjs'
import { User } from '../../../common/misc/userObj.mjs'
import DS_MANAGER from '../../../adapters/datastore/dsManager.mjs'

/**
 * Middleware to add fradmin DS (replicates addFradminDs)
 * Gets fradmin's userDS and puts it in res.locals (modern approach)
 * Also verifies user is admin
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @returns {Function} Express middleware function
 */
export const createAddFradminDs = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
    try {
      const userId = req.session.logged_in_user_id
      
      // Verify user is authenticated and is admin
      if (!userId || !req.session.logged_in_as_admin) {
        return sendAuthFailure(res, {
          type: 'adminAccessRequired',
          message: 'Admin access required',
          path: req.path,
          url: req.url,
          error: 'Admin access required - createAddFradminDs middleware',
          statusCode: 403
        })
      }
      
      // Verify tokenInfo exists and matches session user
      const tokenInfo = res.locals.freezr?.tokenInfo
      if (!tokenInfo || tokenInfo.requestor_id !== userId) {
        return sendAuthFailure(res, {
          type: 'adminAccessRequired',
          message: 'Admin access required',
          path: req.path,
          url: req.url,
          error: 'Admin access required - tokenInfo error in createAddFradminDs middleware',
          statusCode: 403
        })
      }
      
      // Get user database to verify admin status (redundant check just in case)
      const userDb = await dsManager.getorInitDb(USER_DB_OAC, { freezrPrefs })
      const users = await userDb.query({ user_id: userId }, null)
      
      if (!users || users.length === 0 || users.length > 1) {
        return sendAuthFailure(res, {
          type: 'adminAccessRequired',
          message: 'Admin access required',
          path: req.path,
          url: req.url,
          error: 'Admin access required - user missing error in createAddFradminDs middleware',
          statusCode: 403
        })
      }
      
      const user = new User(users[0])
      if (!user.isAdmin) {
        console.error('❌ Non-admin user trying to access admin tasks:', userId)
        return sendAuthFailure(res, {
          type: 'adminAccessRequired',
          message: 'Admin access required',
          path: req.path,
          url: req.url,
          error: 'Admin access required - non-admin user trying to access admin tasks in createAddFradminDs middleware',
          statusCode: 403
        })
      }
      
      // Get fradmin's userDS
      const owner = 'fradmin'
      const fradminDS = await dsManager.getOrSetUserDS(owner, { freezrPrefs })
      
      // Preserve existing res.locals.freezr if it exists
      const existingFreezr = res.locals.freezr || {}
      
      res.locals.freezr = {
        ...createBaseFreezrContextForResLocals(req, dsManager, freezrPrefs, freezrStatus),
        ...existingFreezr, // Preserve existing properties (like tokenInfo)
        fradminDS
      }
      
      next()
      
    } catch (error) {
      console.error('❌ Error in createAddFradminDs middleware:', error)
      sendFailure(res, error, 'createAddFradminDs', 500)
    }
  }
}

/**
 * Middleware to add dsManager to request
 * Simple middleware that adds dsManager to res.locals
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @returns {Function} Express middleware function
 */
export const createAddDsManagerAndFreezrPrefsStatus = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
    // Preserve existing res.locals.freezr if it exists
    const existingFreezr = res.locals.freezr || {}

    // console.log('🔄 createAddDsManagerAndFreezrPrefsStatus - freezrPrefs:', { freezrPrefs })
    
    res.locals.freezr = {
      ...existingFreezr,
      dsManager,
      freezrStatus,
      freezrPrefs
    }
    
    next()
  }
}

export default {
  createAddFradminDs,
  createAddDsManagerAndFreezrPrefsStatus
}

