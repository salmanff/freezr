// freezr.info - Admin Configuration Service - adminConfigService.mjs
// Handles preference and configuration management for admin features

import { newVersionNumberIsHigher } from '../../../common/helpers/utils.mjs'
import { PARAMS_OAC } from '../../../common/helpers/config.mjs'
import { doUpdates as runServerUpdates } from './serverUpdates.mjs'

/**
 * Get or set preferences in the params database
 * Modern async version of get_or_set_prefs from admin_handler.js
 * 
 * @param {Object} paramsDb - The params database instance
 * @param {string} prefName - Name of the preference (e.g., 'main_prefs')
 * @param {Object} prefsToSet - Preferences object to set (if doSet is true)
 * @param {boolean} doSet - Whether to set (true) or just get (false)
 * @returns {Promise<Object>} The preferences object from database
 */
export const getOrSetPrefs = async (paramsDb, prefName, prefsToSet, doSet) => {
  try {
    // Read existing preferences
    const prefOnDb = await paramsDb.read_by_id(prefName)
    
    if (!doSet && prefOnDb) {
      // Just getting preferences
      return prefOnDb
    } else if (doSet && prefsToSet) {
      // Setting preferences
      if (prefOnDb) {
        // Update existing preferences
        // Treat missing dbUnificationStrategy on either side as 'db' so
        // legacy main_prefs rows (written before the field existed) are
        // still locked in to their original strategy. Changing strategy
        // requires manual data migration (see
        // xplanations/review_security_internal_2_authorization_audit.md).
        if (prefName === 'main_prefs') {
          const oldStrat = prefOnDb.dbUnificationStrategy || 'db'
          const newStrat = prefsToSet.dbUnificationStrategy || 'db'
          if (oldStrat !== newStrat) {
            throw new Error('Cannot change dbUnificationStrategy once it has been set (was ' + oldStrat + ', got ' + newStrat + ')')
          }
        }
        console.log('🔄 Updating preferences', { prefName, prefsToSet })
        await paramsDb.update(prefName, prefsToSet, { replaceAllFields: true, multi: false })
        return prefsToSet
      } else {
        // Create new preferences
        console.log('🔄 Creating new preferences', { prefName, prefsToSet })
        prefsToSet._id = prefName
        await paramsDb.create(prefName, prefsToSet, null)
        return prefsToSet
      }
    } else if (doSet && !prefsToSet) {
      throw new Error('doSet is true but no preferences provided to set')
    } else {
      return null
    }
  } catch (error) {
    console.error('Error in getOrSetPrefs:', error)
    throw error
  }
}

/**
 * Default system preferences
 * These are applied when no preferences exist or as fallback values
 */
export const DEFAULT_PREFS = {
  log_visits: true,
  log_details: { each_visit: true, daily_db: true, include_sys_files: false, log_app_files: false },
  redirect_public: false,
  public_landing_page: '',
  public_landing_app: '',
  allowSelfReg: false,
  allowAccessToSysFsDb: false,
  selfRegDefaultMBStorageLimit: null,
  dbUnificationStrategy: process?.env?.DB_UNIFICATION || 'db',
  blockMsgsFromNonContacts: false,
  scheduler_disabled: false, // scheduled jobs run by default; admin can pause them on the prefs page
  // (a DISABLE flag so existing servers — where the field is absent/null — keep scheduling ON)
  serverless_callback_url: '' // public freezr base URL a deployed serverless job calls back to
  // (e.g. https://my.freezr.me). Empty => cloud jobs without a request-derived URL can't run.
}


const VERSION_NUMS_KEY = 'versionNums'

/**
 * Check server version and implement any necessary updates
 * Modern async version of check_server_version_and_implement_updates from admin_handler.js
 * 
 * @param {Object} dsManager - The data store manager instance
 * @param {string} currentVersion - Current server version string (e.g., '0.0.212')
 * @returns {Promise<void>}
 */
export const checkServerVersionAndUpdate = async (dsManager, currentVersion) => {
  try {
    // Get the params database
    const paramsDb = dsManager.getDB(PARAMS_OAC)
    if (!paramsDb) {
      throw new Error('Could not get params database for version check')
    }
    
    // Read current version from database
    const versionRecord = await paramsDb.read_by_id(VERSION_NUMS_KEY)
    
    if (!versionRecord) {
      // First time - create version record
      await paramsDb.create(VERSION_NUMS_KEY, { serverVersion: currentVersion }, null)
      console.log(`📦 Server version initialized: ${currentVersion}`)
      return
    }
    
    const oldVersion = versionRecord.serverVersion
    
    // Check if we need to run updates
    if (newVersionNumberIsHigher(oldVersion, currentVersion)) {
      console.log(`🔄 Server update detected: ${oldVersion} → ${currentVersion}`)
      
      // Run applicable updates from serverUpdates.mjs
      const updateResults = await runServerUpdates(dsManager, oldVersion, currentVersion)
      
      if (!updateResults.success) {
        console.error('❌ Some server updates failed:', updateResults.errors)
        // Note: We still update the version record even if some updates failed
        // This prevents repeated attempts at the same failed updates
      }
      
      if (updateResults.updatesRun > 0) {
        console.log(`✅ Ran ${updateResults.updatesRun} server update(s)`)
      }
      
      // Update version record
      await paramsDb.update(VERSION_NUMS_KEY, { serverVersion: currentVersion }, { replaceAllFields: false, multi: false })
      console.log(`📦 Server version updated to: ${currentVersion}`)
    } else {
      // Version is current or older
      if (oldVersion !== currentVersion) {
        console.log(`📦 Server version: ${currentVersion} (db has ${oldVersion})`)
      }
    }
  } catch (error) {
    console.error('Error in checkServerVersionAndUpdate:', error)
    throw error
  }
}

export default {
  getOrSetPrefs,
  DEFAULT_PREFS,
  checkServerVersionAndUpdate
}

