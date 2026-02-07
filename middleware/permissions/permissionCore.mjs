// freezr.info - Modern ES6 Module - Permission Core Logic
// Core permission schema, validation, and pure functions
// This module contains framework-agnostic permission logic that can be used anywhere

import { objectContentIsSame, startsWith } from '../../common/helpers/utils.mjs'
import { isAllowedPermissionType, hasRequiredFields, PERMISSION_FIELD_TYPES, PERMISSION_FIELD_EXCEPTIONS_BY_TYPE, getPermissionFieldTypeErrors, cleanTableIds } from './permissionDefinitions.mjs'

/**
 * Validates a permission object from manifest parameters
 * Pure function - no side effects, no DB access
 * 
 * @param {Object} statedPerm - The permission object from manifest
 * @throws {Error} - If the permission object is invalid
 */
export const checkPermValidity = (statedPerm) => {
  const name = statedPerm?.name
  
  if (!statedPerm || typeof statedPerm !== 'object') {
    throw new Error('checkPermValidity: cannot make permission without a proper permission object for ' + name)
  }
  
  if (!name) {
    throw new Error('checkPermValidity: cannot make permission without a permissionname for ' + name)
  }
  
  if (!hasRequiredFields(statedPerm.type, statedPerm)) {
    throw new Error('checkPermValidity: cannot make permission without a table or ' + name)
  }
  
  if (!statedPerm.type || !isAllowedPermissionType(statedPerm.type)) {
    throw new Error('checkPermValidity: permission type is not allowed for ' + name)
  }

  const errKeys = getPermissionFieldTypeErrors(statedPerm)
  
  if (errKeys) {
    throw new Error('checkPermValidity: Wrong types for permission ' + name + ': ' + errKeys)
  }
}

/**
 * Creates a normalized permission object from manifest parameters
 * Pure function - transforms input to output without side effects
 * 
 * @param {string} appName - The app name
 * @param {Object} statedPerm - The permission object from manifest
 * @returns {Object} - Cleaned permission object
 */
export const cleanedPermissionObjectFromManifestParams = (appName, statedPerm) => {
  if (!appName) {
    throw new Error('cleanedPermissionObjectFromManifestParams: cannot make permission without an app name')
  }

  // Create a copy to avoid mutating the original
  const permCopy = { ...statedPerm }
  
  // Clean and normalize table_id fields (converts string to array, table_ids to table_id)
  cleanTableIds(permCopy)
  
  // Validate the permission
  checkPermValidity(permCopy)
  
  // Convert null types into correct types
  const returnpermission = {}
  Object.entries(PERMISSION_FIELD_TYPES).forEach(([key, prop]) => {
    switch (prop) {
      case 'array':
        returnpermission[key] = permCopy[key] || []
        break
      case 'string':
        returnpermission[key] = permCopy[key] || ''
        break
    }
  })
  const exceptionList = PERMISSION_FIELD_EXCEPTIONS_BY_TYPE[permCopy.type]
  if (exceptionList && exceptionList.length > 0) {
    for (const exception of exceptionList) {
      if (permCopy[exception.field]) {
        returnpermission[exception.field] = permCopy[exception.field]
      }
    }
  }
  
  
  // Add name and requestor_app
  returnpermission.name = permCopy.name
  returnpermission.requestor_app = appName

  return returnpermission
}

/**
 * Compares two permission objects to see if they are the same
 * Pure function - returns boolean based on comparison
 * 
 * @param {Object} p1 - First permission object
 * @param {Object} p2 - Second permission object
 * @returns {boolean} - True if permissions are the same (ignoring runtime fields)
 */
export const permissionsAreSame = (p1, p2) => {
  return objectContentIsSame(p1, p2, [
    'granted', 'status', 'grantees', 'outDated', 'revokeIsWip', 
    'previousGrantees', '_date_created', '_date_modified', '_id'
  ])
}

/**
 * Used on INSTALL to determine what operations to perform to sync manifest permissions with existing permissions
 * Pure function - returns operations without performing them
 * 
 * @param {Array} cleanedManifestPermList - Cleaned permissions from manifest
 * @param {Array} existingPermList - Existing permissions from database
 * @returns {Array<Object>} Array of operations: { action: 'create'|'update'|'skip', permissionName, data }
 */
export const cleanNewManifestAndMergeWithExistingToUpdatePermsDb = (cleanedManifestPermList, existingPermList) => {
  const operations = []
  
  // Get all unique permission names
  const allPermissionNames = []
  cleanedManifestPermList.forEach(perm => {
    if (!allPermissionNames.includes(perm.name)) {
      allPermissionNames.push(perm.name)
    }
  })
  existingPermList.forEach(perm => {
    if (!allPermissionNames.includes(perm.name)) {
      allPermissionNames.push(perm.name)
    }
  })

  // Determine operation for each permission
  for (const permissionName of allPermissionNames) {
    const cleanedManifestPerm = cleanedManifestPermList.find(perm => perm.name === permissionName)
    const existingPermFromDb = existingPermList.find(perm => perm.name === permissionName)

    if (!existingPermFromDb) {
      // Create new permission
      operations.push({
        action: 'create',
        permissionName,
        data: {
          ...cleanedManifestPerm,
          granted: false,
          status: 'pending',
          grantees: []
        }
      })
    } else if (!cleanedManifestPerm) {
      // Permission removed from manifest - mark as removed
      operations.push({
        action: 'update',
        permissionName,
        id: existingPermFromDb._id,
        data: {
          ...existingPermFromDb,
          status: 'removed',
          granted: false
        }
      })
    } else if (
      permissionsAreSame(cleanedManifestPerm, existingPermFromDb) && 
      !existingPermFromDb.outDated && 
      !existingPermFromDb.revokeIsWip && 
      existingPermFromDb.granted
    ) {
      // Permissions are the same and granted - check if status needs updating
      if (existingPermFromDb.status === 'removed' || existingPermFromDb.status === 'outdated') {
        operations.push({
          action: 'update',
          permissionName,
          id: existingPermFromDb._id,
          data: {
            ...existingPermFromDb,
            status: 'pending' // ie no longer removed
          }
        })
      } else {
        // No change needed
        operations.push({
          action: 'skip',
          permissionName
        })
      }
    } else {
      // Permissions are NOT same - update to outdated
      console.log('cleanNewManifestAndMergeWithExistingToUpdatePermsDb: Permissions are NOT same - update to outdated', { cleanedManifestPerm, existingPermFromDb })
      operations.push({
        action: 'update',
        permissionName,
        id: existingPermFromDb._id,
        data: {
          ...cleanedManifestPerm,
          status: 'outdated',
          granted: false,
          previousGrantees: existingPermFromDb.grantees,
          grantees: []
        }
      })
    }
  }

  return operations
}

/**
 * Used on INSTALL to builds a public manifest object from manifest and pre-read files
 * Pure function - takes already-read cards/pages and builds the structure
 * 
 * @param {string} userId - The user ID
 * @param {string} appName - The app name
 * @param {Object} manifest - The app manifest
 * @param {Object} cards - Pre-read permission cards (keyed by permission name)
 * @param {Object} ppages - Pre-read permission pages (keyed by permission name)
 * @param {Array} existingPermissions - Existing permissions array (if updating)
 * @returns {Object} Public manifest object ready to be saved
 */
export const createPublicManifestObjectFromManifest = (userId, appName, manifest, cards = {}, ppages = {}, existingPermissions = []) => {
  return {
    manifest,
    cards,
    ppages,
    user_id: userId,
    app_name: appName,
    permissions: existingPermissions
  }
}

/**
 * Extracts the list of files that need to be read for public manifest
 * Pure function - determines what files to read without reading them
 * 
 * @param {Object} manifest - The app manifest
 * @returns {Object} Object with two arrays: cardsToRead and pagesToRead
 *   - cardsToRead: Array of { permName, path }
 *   - pagesToRead: Array of { permName, path }
 */
export const extractPublicManifestFilesToRead = (manifest) => {
  const cardsToRead = []
  const pagesToRead = []

  if (!manifest || !manifest.permissions) {
    return { cardsToRead, pagesToRead }
  }

  for (const [permName, permObj] of Object.entries(manifest.permissions)) {
    // Only process permissions with pcard or ppage
    if (!permObj.pcard && !(permObj.ppage && manifest.public_pages && manifest.public_pages[permObj.ppage])) {
      continue
    }

    const name = permObj.name || permName

    // Add card to read list
    if (permObj.pcard) {
      cardsToRead.push({
        permName: name,
        path: 'public/' + permObj.pcard
      })
    }

    // Add page to read list
    if (permObj.ppage && manifest.public_pages && manifest.public_pages[permObj.ppage]?.html_file) {
      pagesToRead.push({
        permName: name,
        path: 'public/' + manifest.public_pages[permObj.ppage].html_file
      })
    }
  }

  return { cardsToRead, pagesToRead }
}

/**
 * DEPRECATED - now done on client side in AppSettings.js
 * Groups permissions into categories based on app relationships
 * Pure function - categorizes permissions without side effects
 * Modernized version of account_handler.groupPermissions
 * 
 * @param {Array} returnPermissions - Array of permission objects
 * @param {string} appName - The app name to group permissions for
 * @returns {Object} Grouped permissions object with categories:
 *   - thisAppToThisApp: Permissions from this app to its own tables
 *   - thisAppToOtherApps: Permissions from this app to other apps' tables
 *   - otherAppsToThisApp: Permissions from other apps to this app's tables
 *   - unknowns: Permissions that don't fit any category
 */
// DEPRECATED - now done on client side in AppSettings.js
// export const groupPermissions = (returnPermissions, appName) => {
//   const groupedPermissions = {
//     thisAppToThisApp: [],
//     thisAppToOtherApps: [],
//     otherAppsToThisApp: [],
//     unknowns: []
//   }

//   if (!returnPermissions || returnPermissions.length === 0) {
//     return groupedPermissions
//   }

//   for (const aPerm of returnPermissions) {
//     // Permissions from this app to its own tables
//     if (
//       (['share_records', 'message_records', 'db_query'].includes(aPerm.type) &&
//         aPerm.requestor_app === appName &&
//         startsWith(aPerm.table_id, appName)) ||
//       (['upload_pages'].includes(aPerm.type) && aPerm.requestor_app === appName)
//     ) {
//       groupedPermissions.thisAppToThisApp.push(aPerm)
//     }
//     // Permissions from other apps to this app's tables
//     else if (
//       ['share_records', 'read_all', 'message_records', 'write_own', 'write_all', 'db_query', 'use_app'].includes(aPerm.type) &&
//       aPerm.requestor_app !== appName &&
//       startsWith(aPerm.table_id, appName)
//     ) {
//       groupedPermissions.otherAppsToThisApp.push(aPerm)
//     }
//     // Permissions from this app to other apps' tables
//     else if (
//       ['share_records', 'read_all', 'write_all', 'message_records', 'write_own', 'db_query'].includes(aPerm.type) &&
//       aPerm.requestor_app === appName &&
//       !startsWith(aPerm.table_id, appName)
//     ) {
//       groupedPermissions.thisAppToOtherApps.push(aPerm)
//     }
//     // Unknown permissions
//     else {
//       groupedPermissions.unknowns.push(aPerm)
//       console.warn('groupPermissions: Unknown permission type:', JSON.stringify(aPerm))
//     }
//   }

//   return groupedPermissions
// }