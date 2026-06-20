// freezr.info - Modern ES6 Module - Permission Core Logic
// Core permission schema, validation, and pure functions
// This module contains framework-agnostic permission logic that can be used anywhere

import { objectContentIsSame, startsWith } from '../../common/helpers/utils.mjs'
import { isAllowedPermissionType, hasRequiredFields, PERMISSION_FIELD_TYPES, PERMISSION_FIELD_EXCEPTIONS_BY_TYPE, getPermissionFieldTypeErrors, cleanTableIds } from './permissionDefinitions.mjs'
import { bjLog } from '../../common/debug/consoleFlags.mjs'

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

  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error('checkPermValidity: permission name must contain only alphanumeric characters, dots, underscores, and hyphens: ' + name)
  }

  // Validate table_id entries have safe characters (table_id is already cleaned to array by cleanTableIds)
  if (statedPerm.table_id && Array.isArray(statedPerm.table_id)) {
    for (const tid of statedPerm.table_id) {
      if (typeof tid !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(tid)) {
        throw new Error('checkPermValidity: table_id must contain only alphanumeric characters, dots, underscores, and hyphens: ' + tid)
      }
    }
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
 * Compares a manifest permission against an existing (possibly granted) permission to decide whether
 * an app re-install changed it (→ re-prompt) or not (→ keep the grant). Pure function.
 *
 * Runtime fields (granted/status/dates/etc.) are always ignored. CRUCIALLY, an optional per-type
 * field is ALSO ignored UNLESS the manifest declares it — because many optional fields are set by the
 * USER at accept time (run_job/schedule_job `location`; use_mail `connection_names`/`scopes`) and never
 * appear in the manifest. Without this, a re-install would see the user's accepted `location` as a
 * "change", mark the permission outdated, and drop the grant. If the manifest DOES declare an optional
 * field (e.g. `job_name`, or an app shipping default scopes) and it changed, that's a real change and
 * still re-prompts. (The enforced value lives on the granted record regardless, so ignoring an
 * undeclared field here can never let an app silently widen access.)
 *
 * @param {Object} manifestPerm - The (cleaned) permission from the app manifest
 * @param {Object} existingPerm - The existing permission record from the DB
 * @returns {boolean} - True if they are the same (so a granted permission stays accepted)
 */
export const permissionsAreSame = (manifestPerm, existingPerm) => {
  const ignore = [
    'granted', 'status', 'grantees', 'outDated', 'revokeIsWip',
    'previousGrantees', '_date_created', '_date_modified', '_id',
    '__owner', '__appTable', 'hasPublic'
  ]
  const isDeclared = (v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)
  const exceptionFields = (PERMISSION_FIELD_EXCEPTIONS_BY_TYPE[manifestPerm?.type] || []).map(e => e.field)
  const ignoredOptional = []
  for (const f of exceptionFields) {
    if (!isDeclared(manifestPerm?.[f])) { ignore.push(f); ignoredOptional.push(f) } // user-set / undeclared optional field — don't treat as a change
  }
  const result = objectContentIsSame(manifestPerm, existingPerm, ignore)
  // 🔎 TEMP DEBUG (review aid — remove after verifying #2): the run_job/schedule_job comparison.
  if (manifestPerm?.type === 'run_job' || manifestPerm?.type === 'schedule_job') {
    bjLog('🔎 [TMPJOBLOG - PERM-SAME] ' + manifestPerm.type + ' "' + manifestPerm.name + '"' +
      ' manifest.job_name=' + manifestPerm.job_name + ' existing.job_name=' + existingPerm?.job_name +
      ' existing.location=' + existingPerm?.location + ' ignored-optional=[' + ignoredOptional.join(',') + ']' +
      ' → same=' + result + (result ? ' (grant kept)' : ' (→ outdated, re-consent)'))
  }
  return result
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
      console.log('cleanNewManifestAndMergeWithExistingToUpdatePermsDb: Creating new permission', permissionName)
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
      console.log('cleanNewManifestAndMergeWithExistingToUpdatePermsDb: Permission removed from manifest - mark as removed', permissionName)
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
      console.log('cleanNewManifestAndMergeWithExistingToUpdatePermsDb: Permissions are the same and granted - check if status needs updating', permissionName)
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
        console.log('cleanNewManifestAndMergeWithExistingToUpdatePermsDb: No change needed', permissionName)
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
    ppages, // legacy — ppages are no longer cached but kept for backward compatibility
    user_id: userId,
    app_name: appName,
    permissions: existingPermissions
  }
}

/**
 * Extracts the list of pcard files that need to be read for public manifest
 * Checks both permission-level pcards (overrides) and app_table-level pcards (defaults)
 * ppages are NOT cached — they are read at render time from appFS
 * 
 * @param {Object} manifest - The app manifest
 * @returns {Object} Object with cardsToRead array
 *   - cardsToRead: Array of { permName, path } where permName is either
 *     the permission name (for permission-level pcards) or '_table:tableKey'
 *     (for table-level pcards)
 */
export const extractPublicManifestFilesToRead = (manifest) => {
  const cardsToRead = []

  if (!manifest) {
    return { cardsToRead }
  }

  // 1. Check permissions for pcard overrides
  if (manifest.permissions) {
    for (const [permName, permObj] of Object.entries(manifest.permissions)) {
      if (!permObj.pcard) continue

      const name = permObj.name || permName
      cardsToRead.push({
        permName: name,
        path: 'public/' + permObj.pcard
      })
    }
  }

  // 2. Check app_tables for default pcards
  if (manifest.app_tables) {
    for (const [tableKey, tableObj] of Object.entries(manifest.app_tables)) {
      if (tableObj.pcard) {
        cardsToRead.push({
          permName: '_table:' + tableKey,
          path: 'public/' + tableObj.pcard
        })
      }
    }
  }

  return { cardsToRead }
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