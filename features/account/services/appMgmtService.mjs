// freezr.info - Modern ES6 Module - App Management Service
// Handles app management business logic (remove, delete, update)
//
// Architecture Pattern:
// - Pure functions for business logic
// - Data access functions that take dependencies
// - No HTTP concerns - only business logic and data operations

import { FREEZR_USER_FILES_DIR, constructAppIdStringFrom } from '../../../common/helpers/config.mjs'
import { deleteLocalFolderAndContents } from '../../../adapters/datastore/fsConnectors/fileHandler.mjs'
import { userAppListOAC, userPERMS_OAC } from '../../../common/helpers/config.mjs'

/**
 * Remove app from home page (mark as removed)
 * 
 * @param {Object} userAppListDb - App list database instance
 * @param {string} userId - User ID
 * @param {string} appName - App name
 * @returns {Promise<Object>} Result with success status
 */
export const removeAppFromHomePage = async (userAppListDb, userId, appName) => {
  // onsole.log('📱 removeAppFromHomePage called for:', { userId, appName })
  
  if (!userId) {
    throw new Error('Missing user id')
  }
  if (!appName) {
    throw new Error('Missing app name')
  }
  if (!userAppListDb) {
    throw new Error('App list database not available')
  }

  try {
    const appNameId = constructAppIdStringFrom(userId, appName)
    
    const updateResult = await userAppListDb.update(
      appNameId,
      { removed: true },
      { replaceAllFields: false }
    )

    if (!updateResult || !updateResult.nModified || updateResult.nModified === 0) {
      throw new Error('Could not mark app as removed')
    }

    return { success: true }
  } catch (error) {
    console.error('❌ Error in removeAppFromHomePage:', error)
    throw error
  }
}

/**
 * Delete app completely (remove from database, delete files)
 * 
 * @param {Object} userAppListDb - App list database instance
 * @param {Object} permsDb - Permissions database instance
 * @param {Object} userDS - User data store
 * @param {string} userId - User ID
 * @param {string} appName - App name
 * @returns {Promise<Object>} Result with success status
 */
export const deleteApp = async (params) => {
  // onsole.log('🗑️  deleteApp called for:', { userId, appName })
  const { userDS, userId, appName, freezrPrefs, publicManifestsDb, publicRecordsDb } = params

  if (!userId) {
    throw new Error('Missing user id')
  }
  if (!userDS) {
    throw new Error('User data store not available')
  }
  if (!appName) {
    throw new Error('Missing app name')
  }
  if (!freezrPrefs) {
    throw new Error('Missing freezr preferences')
  }
  if (!publicManifestsDb) {
    throw new Error('public manifests database not available')
  }
  if (!publicRecordsDb) {
    throw new Error('Permissions database not available')
  }

  try {
    const appListDb = await userDS.getorInitDb(userAppListOAC(userId), { freezrPrefs })
    if (!appListDb) {
      throw new Error('Could not access app list database')
    }
    const permsOac = userPERMS_OAC(userId)
    const permsDb = await userDS.getorInitDb(permsOac, { freezrPrefs })
    if (!permsDb || !permsDb.delete_records) {
      return sendFailure(res, 'Could not access permissions database', 'accountApiController.handleDeleteApp', 500)
    }
        
    // Step 1: Delete permission records
    await permsDb.delete_records({ requestor_app: appName }, null)

    // Step 2: Delete from public databases
    await publicManifestsDb.delete_records({ user_id: userId, app_name: appName }, null)
    await publicRecordsDb.delete_records({ data_owner: userId, requestor_app: appName }, null)
    
    // step 3 - remove all app files
    const appFS = await userDS.getorInitAppFS(appName, { freezrPrefs })
    await appFS.removeAllAppFiles(null)

    // step 4 - get all tables and delete all data from all tables
    const topdb = await userDS.getorInitDb({ owner: userId, app_table: appName }, {})
    const allTableNamesForApp = await topdb.getAllAppTableNames(appName)

    // Get table sizes
    let gotErrors =  []
    for (const tableName of allTableNamesForApp) {
      try {
        const db = await userDS.getorInitDb({ owner: userId, app_table: tableName }, {})
        await db.delete_records({}, null)
      } catch (err) {
        gotErrors.push({ err, tableName })
      }
    }
    if (gotErrors.length > 0) {
      throw new Error('Error getting table stats for some tables: ' + JSON.stringify(gotErrors))
    }

    // Step 4: Delete local folder (if exists)
    const folderPath = (userDS.fsParams?.rootFolder || FREEZR_USER_FILES_DIR) + '/' + userId + '/apps/' + appName
    try {
      await deleteLocalFolderAndContents(folderPath)
    } catch (err) {
      // Ignore errors if folder doesn't exist
      if (!err?.message?.includes('ENOENT')) {
        res.locals.flogger.error('⚠️  Error deleting local folder in delete app process :', { error: err, function: 'deleteApp' })
        console.warn('⚠️  Error deleting local folder - will still continue process :', err)
      }
    }

    // Step 5: Delete from app list database
    // onsole.log('🗑️  deleteApp: Step 7: Deleting from app list database, appNameId:', appNameId)
    const appNameId = constructAppIdStringFrom(userId, appName)
    const userAppListDb = await userDS.getorInitDb(userAppListOAC(userId), { freezrPrefs })
    await userAppListDb.delete_record(appNameId, null)

    return { success: true }
  } catch (error) {
    console.error('❌ Error in deleteApp:', error)
    throw error
  }
}


