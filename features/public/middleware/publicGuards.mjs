// freezr.info - Modern ES6 Module - Public Guards
// Route-specific validation guards for public routes

import { sendFailure } from '../../../adapters/http/responses.mjs'
import { PUBLIC_RECORDS_OAC } from '../../../common/helpers/config.mjs'

/**
 * Guard to check that a user has at least one public record
 * Prevents sniffing if a user has installed an app even if they haven't made items public
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @returns {Function} Express middleware function
 */
export const createHasAtLeastOnePublicRecord = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
    const userId = req.params.user_id
    const appName = req.params.app_name || req.params.requestee_app
    
    // // Skip check for 'public' user or if no user_id
    // if (!userId || userId === 'public') {
    //   return next()
    // }

    // // Skip check for account app
    // if (appName === 'info.freezr.account') {
    //   return next()
    // }
    if (!appName || !userId) {
      return sendFailure(res, 'User ID and app name are required', 'hasAtLeastOnePublicRecord', 400)
    }

    try {
      // Get public records database
      const publicRecordsDb = await dsManager.getorInitDb(PUBLIC_RECORDS_OAC, { freezrPrefs })

      if (!publicRecordsDb) {
        console.error('❌ Could not get publicRecordsDb')
        return sendFailure(res, 'Could not access public records database', 'addPublicRecordsDb', 500)
      }
      
      const query = { isPublic: true, data_owner: userId.toLowerCase(), requestor_app: appName.toLowerCase() }

      // Query for at least one public record
      const results = await publicRecordsDb.query(query, { count: 1 })

      if (!results || results.length === 0) {
        // User has no public records - return 401 to prevent sniffing
        return sendFailure(res, 'No public records found', 'hasAtLeastOnePublicRecord', 401)
      }

      next()
      
    } catch (error) {
      console.error('❌ Error in hasAtLeastOnePublicRecord guard:', error)
      return sendFailure(res, error, 'hasAtLeastOnePublicRecord', 500)
    }
  }
}

