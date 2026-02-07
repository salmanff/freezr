// freezr.info - Modern ES6 Module - Account Permission Service - accountPermissionService.mjs
// =========== FUNCTIONS HAVE NOT BEEN TESTED / REVIEWED YET - TODO-MODERNIZATION ===========
// Service layer for permission management - orchestrates database and file system operations
//
// Architecture Pattern:
// - Uses modern async/await patterns
// - Uses modern database methods directly (db.query, db.create, db.update)
// - Imports core permission logic from middleware/permissions/permissionCore.mjs
// - Handles permission lifecycle and synchronization with manifest

import { getLocalFile } from '../../../adapters/datastore/fsConnectors/fileHandler.mjs'
import {
  cleanedPermissionObjectFromManifestParams,
  cleanNewManifestAndMergeWithExistingToUpdatePermsDb,
  extractPublicManifestFilesToRead,
  createPublicManifestObjectFromManifest
} from '../../../middleware/permissions/permissionCore.mjs'

const fullPermissionName = function(requestorApp, permName) {
  return (requestorApp + '/' + permName).replace(/\./g, '_')
}
const tableIdsFromPermission = function(permission) {
  return typeof permission.table_id === 'string' ? [permission.table_id] : permission.table_ids || []
}

/* ==================   INSTALLATION OF APPS AND THEIR PERMISSIONS ================== */

/**
 * Used on install to update permission records from manifest
 * Orchestrates the synchronization of manifest permissions with the user's permission database
 * Handles permission lifecycle: pending → granted → outdated → removed
 * 
 * @param {Object} ownerPermsDb - The permissions database
 * @param {string} appName - The app name
 * @param {Object} manifest - The app manifest
 * @returns {Promise<void>} - Resolves when permissions are updated
 */
export const updatePermissionRecordsFromManifest = async (ownerPermsDb, appName, manifest) => {
  const manifestPerms = (manifest && manifest.permissions && Object.keys(manifest.permissions).length > 0) 
    ? JSON.parse(JSON.stringify(manifest.permissions)) 
    : null

  if (!manifest || !manifestPerms) {
    console.warn('⚠️ No manifest or manifestPerms for updatePermissionRecordsFromManifest', { manifest, manifestPerms })
    return // these should already have been flagged
  }

  // Clean and normalize manifest permissions
  const cleanedManifestPermList = []
  const errs = []

  if (manifestPerms && manifestPerms.length > 0) {
    manifestPerms.forEach((statedPerm) => {
      try {
        const cleanedManifestPerm = cleanedPermissionObjectFromManifestParams(appName, statedPerm)
        cleanedManifestPermList.push(cleanedManifestPerm)
      } catch (err) {
        console.error('Error in updatePermissionRecordsFromManifest:', { err, statedPerm })
        errs.push(err.message)
      }
    })
  }

  if (errs.length > 0) {
    throw new Error(errs.join('\n'))
  }

  // Get existing permissions from database
  const existingPermList = await ownerPermsDb.query({ requestor_app: appName }, {})

  // Use pure function to determine what operations to perform
  const operations = cleanNewManifestAndMergeWithExistingToUpdatePermsDb(cleanedManifestPermList, existingPermList)

  // Execute the operations
  for (const operation of operations) {
    if (operation.action === 'create') {
      await ownerPermsDb.create(null, operation.data, {})
    } else if (operation.action === 'update') {
      await ownerPermsDb.update(operation.id, operation.data, {})
    }
    // Skip operations don't need database calls
  }
}

/**
 * Used on install to update public manifest database from manifest
 * Orchestrates reading permission cards/pages and storing them in the public manifest DB
 * 
 * @param {string} userId - The user ID
 * @param {string} appName - The app name
 * @param {Object} manifest - The app manifest
 * @param {Object} publicManifestsDb - The public manifests database
 * @param {Object} options - Options object
 * @param {boolean} options.fromInstall - Whether this is from an installation (requires tempFolderPath)
 * @param {boolean} options.fromUpdateFromFiles - Whether this is from an update (requires appFS)
 * @param {string} options.tempFolderPath - Path to temp folder (required if fromInstall is true)
 * @param {Object} options.appFS - App filesystem (required if fromUpdateFromFiles is true)
 * @returns {Promise<void>} - Resolves when manifest is updated
 */
export const updatePublicManifestFromManifest = async (userId, appName, manifest, publicManifestsDb, options = {}) => {
  const { fromInstall = false, fromUpdateFromFiles = false, tempFolderPath, appFS } = options
  console.log('updatePublicManifestFromManifest 1', { userId, appName, manifest, publicManifestsDb, options })
  // Validate explicit flags and required dependencies
  if (fromInstall && !tempFolderPath) {
    throw new Error('tempFolderPath is required when fromInstall is true')
  }
  if (fromUpdateFromFiles && !appFS) {
    throw new Error('appFS is required when fromUpdateFromFiles is true')
  }

  try {
    // Use pure function to determine what files need to be read
    const { cardsToRead, pagesToRead } = extractPublicManifestFilesToRead(manifest)

    const cards = {}
    const ppages = {}

    // Read cards based on the source (orchestration layer)
    if (fromInstall && tempFolderPath) {
      console.log('updatePublicManifestFromManifest 2 - fromInstall and tempFolderPath')
      // Read from temp folder during installation
      for (const { permName, path } of cardsToRead) {
        try {
          const theCard = await getLocalFile(tempFolderPath, path)
          if (theCard) {
            cards[permName] = theCard
          }
        } catch (err) {
          console.error('Error reading card for permission:', permName, err)
          // Continue processing other cards
        }
      }

      // Read pages from temp folder
      // for (const { permName, path } of pagesToRead) {
      //   try {
      //     const thePage = await getLocalFile(tempFolderPath, path)
      //     if (thePage) {
      //       ppages[permName] = thePage
      //     }
      //   } catch (err) {
      //     console.error('Error reading public page for permission:', permName, err)
      //     // Continue processing other pages
      //   }
      // }
    } else if (fromUpdateFromFiles && appFS) {
      console.log('updatePublicManifestFromManifest 3 - fromUpdateFromFiles and appFS - cardsToRead', cardsToRead)
      // Read from appFS during update
      for (const { permName, path } of cardsToRead) {
        try {
          const theCard = await appFS.readAppFile(path, {})
          if (theCard) {
            cards[permName] = theCard
          }
        } catch (err) {
          console.error('Error reading card for permission:', permName, err)
          // Continue processing other cards
        }
      }

      // Read pages from appFS
      // for (const { permName, path } of pagesToRead) {
      //   try {
      //     const thePage = await appFS.readAppFile(path, {})
      //     if (thePage) {
      //       ppages[permName] = thePage
      //     }
      //   } catch (err) {
      //     console.error('Error reading public page for permission:', permName, err)
      //     // Continue processing other pages
      //   }
      // }
    } else {
      console.log('updatePublicManifestFromManifest 4 - no cardsToRead')
    }

    // Query existing record to get existing permissions
    const results = await publicManifestsDb.query({ user_id: userId, app_name: appName }, {})
    const existingPermissions = (results && results[0]) ? (results[0].permissions || []) : []
    console.log('updatePublicManifestFromManifest 5 - cards', cards)
    // Use pure function to build the public manifest object
    const publicManifestObject = createPublicManifestObjectFromManifest(
      userId, 
      appName, 
      manifest, 
      cards, 
      ppages, 
      existingPermissions
    )

    console.log('updatePublicManifestFromManifest 6 - publicManifestObject', publicManifestObject)
    console.log('updatePublicManifestFromManifest 6A - publicManifestObject.cards', publicManifestObject.cards)
    if (results && results[0]) {
      // Update existing record
      const recId = results[0]._id
      await publicManifestsDb.update(recId, publicManifestObject, { replaceAllFields: true })
    } else {
      // Create new record
      await publicManifestsDb.create(null, publicManifestObject, null)
    }

  } catch (err) {
    console.error('Error in updatePublicManifestFromManifest:', err)
    throw err
  }
}

/* ==================   GRANTING OF PERMISSIONS ================== */

/**
 * Accepts a named permission for a user
 * Updates the permission record to granted status and updates public manifest
 * 
 * @param {string} permName - The permission name
 * @param {string} requestorApp - The requesting app name
 * @param {Object} locals - The locals object containing databases and manifest
 * @param {Object} locals.ownerPermsDb - The user permissions database
 * @param {Object} locals.publicManifestsDb - The public manifests database
 * @param {Object} locals.manifest - The app manifest
 * @returns {Promise<Object>} - Returns { success: true } or { success: false, error: Error }
 */
export const acceptNamedPermissions = async (permName, requestorApp, locals) => {
  try {
    const { ownerPermsDb, publicManifestsDb, manifest } = locals

    if (!ownerPermsDb) {
      return { success: false, error: new Error('User permissions database not available') }
    }

    // Query for the permission
    const permQuery = { name: permName, requestor_app: requestorApp }
    const results = await ownerPermsDb.query(permQuery, {})

    if (results.length === 0) {
      console.error('❌ acceptNamedPermissions - ', { permQuery, results })
      return { success: false, error: new Error('permission record not found - try re-installing app') }
    }

    let permission
    if (results.length > 1) { // CLEAN UP IN CASE OF ERRORED DUPLICATE CREATION
      // Sort results by _date_modified descending (newest first)
      results.sort((a, b) => (b._date_modified || 0) - (a._date_modified || 0));
      // Delete the older one(s)
      for (let i = 1; i < results.length; i++) {
        await ownerPermsDb.delete_record(results[i]._id, {});
      }
      // Set permission to the newest one
      permission = results[0];
    } else {
      permission = results[0];
    }
    const permId = permission._id

    // Update the permission to granted status
    const updateData = {
      outDated: false,
      granted: true,
      revokeIsWip: false,
      status: 'granted'
    }

    await ownerPermsDb.update(permId, updateData, { replaceAllFields: false })

    return { success: true, name: permName, action: 'Accept', flags: null }
  } catch (error) {
    console.error('Error in acceptNamedPermissions:', error)
    return { success: false, error }
  }
}

/**
 * Denies a named permission for a user
 * Updates the permission record to declined status and revokes access from all records
 * 
 * @param {string} permName - The permission name
 * @param {string} requestorApp - The requesting app name
 * @param {Object} locals - The locals object containing databases
 * @param {Object} locals.ownerPermsDb - The user permissions database
 * @param {Object} locals.userDS - The user data store
 * @param {Object} locals.publicRecordsDb - The public records database
 * @returns {Promise<Object>} - Returns { success: true } or { success: false, error: Error }
 */
export const denyNamedPermissions = async (permName, requestorApp, locals) => {
  const { ownerPermsDb, userDS, publicRecordsDb } = locals

  if (!ownerPermsDb || !userDS) {
    return { success: false, error: new Error('User permissions database or user data store not available') }
  }

  // Query for the permission
  const permQuery = { name: permName, requestor_app: requestorApp }
  const results = await ownerPermsDb.query(permQuery, {})

  console.log('🔐 denyNamedPermissions results', { permQuery, results })

  if (results.length === 0) {
    return { success: false, error: new Error('permission record not found - try re-installing app') }
  }
  let flags = []
  let permUpdated = false

  try {

    let permission
    if (results.length > 1) { // CLEAN UP IN CASE OF ERRORED DUPLICATE CREATION
      // Sort results by _date_modified descending (newest first)
      results.sort((a, b) => (b._date_modified || 0) - (a._date_modified || 0));
      // Delete the older one(s)
      for (let i = 1; i < results.length; i++) {
        await ownerPermsDb.delete_record(results[i]._id, {});
      }
      // Set permission to the newest one
      permission = results[0];
    } else {
      permission = results[0];
    }
    const permId = permission._id

    // Update the permission to declined status
    const updateData = {
      outDated: false,
      granted: false,
      revokeIsWip: true,
      status: 'declined'
    }

    console.log('🔐 denyNamedPermissions 2 ')

    await ownerPermsDb.update(permId, updateData, { replaceAllFields: false })
    permUpdated = true

    // Revoke access from all records
    const fullPermName = fullPermissionName(requestorApp, permName)
    const tableIds = tableIdsFromPermission(permission)
    console.log('🔐 denyNamedPermissions 3 ')

    for (const tableId of tableIds) {
      const requesteeDb = await userDS.getorInitDb(tableId)
      console.log('🔐 denyNamedPermissions 4 ')
      // Get all records with the permission
      const theQuery = { _accessible: { $elemMatch: { fullPermName: { $eq: fullPermName } } } }
      const recs = await requesteeDb.query(theQuery, {})
      const publicIds = []

      // traverse all records and remove the permission (and record public_id if present)
      for (const rec of recs) {
        for (let i = rec._accessible.length -1; i >= 0; i--) {
          const grantObj = rec._accessible[i].grantee
          if (grantObj.fullPermName === fullPermName) {
            if (grantObj.public_id) publicIds.push(grantObj.public_id)
            rec._accessible.splice(i, 1)
          }
        }
        await requesteeDb.update(rec._id, { _accessible: rec._accessible }, { replaceAllFields: false })

        // If public grantee, delete from public records
        if (publicIds.length > 0) {
          for (const publicId of publicIds) {
            try {
              await publicRecordsDb.delete_record(publicId, {})
            } catch (err) {
              console.error('Error deleting public record:', err)
            }
          }
        }
      }
      console.log('🔐 denyNamedPermissions 5 ')


      // Mark revoke as complete
      const permUpdated = await ownerPermsDb.update(permId, { revokeIsWip: false }, { replaceAllFields: false })
      console.log('🔐 denyNamedPermissions permUpdated', { permQuery, results, permUpdated })

    }
    return { success: true, name: permQuery.name, action: 'Deny', flags: null }

  } catch (error) {
    console.error('Error in denyNamedPermissions:', error)
    return { success: false, error, flags: permUpdated ? ['Permission was revoked but some errors were encountered so records may still be accessible'] : [] }
  }
}

// Update public manifest to include this permission - This was removed from chageNamesPermsiision and needs to be called when a public permission is given
// note that this should only update the first time so we should cache it somehow
// TODO-MODERNIZATION - this has NOT BEEN TESTED / ms t test when testing granting access
export const updatePublicManifestToIncludePermission = async function(userId, requestorApp, permName, publicManifestsDb, manifest) {
  console.warn('updatePublicManifestToIncludePermission - this has NOT BEEN TESTED / ms to test when testing granting access')
  try {
    
    const existingResults = await publicManifestsDb.query({ user_id: userId, app_name: requestorApp }, {})
    
    let permissions = [permName]
    let recId = null

    if (existingResults && existingResults.length > 1) {
      console.error('SNBH - more than one public manifest record with the same user_id and app_name')
    }

    if (existingResults && existingResults[0]) {
      recId = existingResults[0]._id
      permissions = [...(existingResults[0].permissions || []), permName]
      // Remove duplicates
      permissions = [...new Set(permissions)]
    }

    // Preserve existing cards and pages if updating
    const existingCards = (existingResults && existingResults[0]) ? (existingResults[0].cards || {}) : {}
    const existingPages = (existingResults && existingResults[0]) ? (existingResults[0].ppages || {}) : {}
    
    const write = {
      manifest: manifest || {},
      cards: existingCards,
      ppages: existingPages,
      user_id: userId,
      app_name: requestorApp,
      permissions
    }

    if (recId) {
      await publicManifestsDb.update(recId, write, { replaceAllFields: true })
    } else {
      await publicManifestsDb.create(null, write, null)
    }
  } catch (err) {
    console.error('Error updating public manifest:', err)
    // Continue anyway - permission was granted even if public manifest update failed
  }
}