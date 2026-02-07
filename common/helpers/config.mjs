// freezr.info - nodejs system files - config.mjs
// Configuration constants and validation functions

import { startsWithOneOf, endsWith, randomText } from './utils.mjs'
import crypto from 'crypto'
import path from 'path'

// Reserved field names that cannot be used by apps
export const RESERVED_FIELD_LIST = [
  '_id', 
  '_date_created', 
  '_date_modified',
  '_accessible',
  '_publicid',
  '_date_accessibility_mod'
]

// Reserved user IDs that cannot be used
export const RESERVED_IDS = ['fradmin', 'test', 'public', 'admin', 'freezr', 'freezrdb', 'undefined', 'system', 'account', 'accounts', 'self', 'group', 'logged_in', 'loggedIn', 'login']
export const SYSTEM_USER_IDS = ['fradmin', 'test', 'public']

// Maximum length for user names and app names
export const MAX_USER_NAME_LEN = 35

// Reserved collection names
export const RESERVED_COLLECTION_NAMES = ['field_permissions', 'accessible_objects']

// System apps that are part of Freezr core
export const SYSTEM_APPS = ['info.freezr', 'dev.ceps']

// Freezr admin database names (used in dsManager)
export const FREEZR_ADMIN_DBs = ['permissions', 'users', 'oauthors', 'app_tokens', 'params']

// System admin collections
const ALL_SYSTEM_ADMIN_COLLS = [
  'users', 
  'permissions', 
  'visitAuthFailures', 
  'visitLogs', 
  'params', 
  'oauth_permissions', 
  'app_tokens'
]
// System permissions - to be expanded
export const SYSTEM_PERMS = {
  profilePict: {
    name: 'profilePict',
    type: 'share_records',
    description: 'Share profile picture with all users',
    table_id: 'info.freezr.account.files',
    grantees: ['_public'],
    granted: true
  },
  privateCodes: {
    name: 'privateCodes',
    type: 'write_own',
    description: 'Access to privatefeed codes table',
    table_id: 'dev.ceps.privatefeeds.codes',
    grantees: ['_allUsers'],
    granted: true
  },
  writeOwnPublicRecords: {
    name: 'writeOwnPublicRecords',
    type: 'write_own_inner',
    description: 'Access to public records table to edit the inner part of the record, not the outer meta data',
    table_id: 'info.freezr.public.public_records',
    grantees: ['_allUsers'],
    granted: true
  }
}
// System admin app tables (derived from collections)
export const SYSTEM_ADMIN_APPTABLES = ALL_SYSTEM_ADMIN_COLLS.map(coll => `info_freezr_admin_${coll}`)

// File and directory constants
export const APP_MANIFEST_FILE_NAME = 'manifest.json'
export const FREEZR_USER_FILES_DIR = 'users_freezr'

// Permission types and groups
export const PERMITTED_TYPES = {
  groups_for_objects: ['user', 'logged_in', 'public'],
  type_names: ['object_delegate', 'db_query']
}

// Validation functions
export const isSystemApp = (appName) => {
  if (!appName) return false
  
  const normalizedAppName = appName.replace(/\./g, '_')
  
  return SYSTEM_APPS.some(systemApp => {
    const normalizedSystemApp = systemApp.replace(/\./g, '_')
    return normalizedAppName.startsWith(normalizedSystemApp)
  })
}

export const validAppName = (appName) => {
  if (!appName) return false
  if (appName.length < 1) return false
  if (appName.length > MAX_USER_NAME_LEN) return false
  if (!validFilename(appName)) return false
  if (startsWithOneOf(appName, ['.', '-', '\\', 'system'])) return false
  if (isSystemApp(appName)) return false
  if (appName.includes('_')) return false
  if (appName.includes(' ')) return false
  if (appName.includes('$')) return false
  if (appName.includes('"')) return false
  if (appName.includes('/')) return false
  if (appName.includes('@')) return false
  if (appName.includes('\\')) return false
  if (appName.includes('{')) return false
  if (appName.includes('}')) return false
  if (appName.includes('..')) return false
  
  const appSegments = appName.split('.')
  if (appSegments.length < 3) return false
  
  return true
}

export const userIdIsValid = (uid) => {
  uid = decodeURIComponent(uid)
  return (
    uid.length < MAX_USER_NAME_LEN && 
    !RESERVED_IDS.includes(uid) && !uid.startsWith('freezr') &&  !uid.includes('@') && 
    !uid.includes('_') && 
    !uid.includes('"') && 
    !uid.includes("'") && 
    !uid.includes(' ') && 
    !uid.includes('/') && 
    !uid.includes('{') && 
    !uid.includes('}') && 
    !uid.includes('(') && 
    !uid.includes(')')
  )
}

export const userIdFromUserInput = (userIdInput) => {
  return userIdInput 
    ? decodeURIComponent(userIdInput.trim().toLowerCase().replace(/ /g, '_')) 
    : null
}

export const validFilename = (fn) => {
  if (!fn || typeof fn !== 'string') return false
  // Basic validation - no path separators, no null bytes, reasonable length
  if (fn.includes(path.sep) || fn.includes('/') || fn.includes('\\') || fn.includes('\0')) return false
  if (fn.length > 255 || fn.length < 1) return false
  // Check for valid characters (alphanumeric, dots, dashes, underscores, spaces)
  const validPattern = /^[a-zA-Z0-9._\-\s]+$/
  return validPattern.test(fn)
}

export const validDirName = (dir) => {
  const re = /[^\a-zA-Z_0-9-.]/
  return typeof dir === 'string' && dir.length > 0 && !dir.match(re)
}

export const validPermissionName = (name) => {
  return !name.includes(' ') && !name.includes('/')
}

export const validCollectionName = (collectionName, isFileRecord) => {
  if (!collectionName) {
    return true
  }
  
  if (
    collectionName.includes('_') ||
    collectionName.includes('/') ||
    collectionName.includes(' ') ||
    collectionName.includes('@') ||
    startsWithOneOf(collectionName, ['.', '-', '\\'])
  ) {
    return false
  }
  
  if (RESERVED_COLLECTION_NAMES.includes(collectionName)) {
    return false
  }
  
  return true
}


// App utility functions
export const tempAppNameFromFileName = (originalname) => {
  let name = ''
  const parts = originalname.split('.')
  if (endsWith(parts[(parts.length - 2)], '-main')) {
    parts[(parts.length - 2)] = parts[(parts.length - 2)].slice(0, -7)
  }
  parts.splice(parts.length - 1, 1)
  name = parts.join('.')
  name = name.split(' ')[0]
  return name
}

/**
 * Construct app ID string from user ID and app name
 * @param {string} userId - User ID
 * @param {string} appName - App name
 * @returns {string} App ID string in format "userId_appName"
 */
export const constructAppIdStringFrom = (userId, appName) => {
  return userId + '_' + appName
}

export const generateOneTimeAppPassword = (userId, appName, deviceCode) => {
  // TODO: to be redone
  return crypto.randomBytes(32).toString('base64url')
}

// export const generateAppToken = (userId, appName, deviceCode) => {  // used generateOneTimeAppPassword instead 
//   // TODO: to be redone - jwt can be issued here too
//   return randomText(50)
// }

// Object Access Contexts or Owner AppName Collection (OACs) - Database access configurations
// OACs define the owner, app_name, and collection_name for database access

/**
 * App Token OAC - Stores app tokens for authentication
 */
export const APP_TOKEN_OAC = {
  app_name: 'info.freezr.admin',
  collection_name: 'app_tokens',
  owner: 'fradmin'
}

/**
 * User Database OAC - Stores all user records
 */
export const USER_DB_OAC = {
  app_name: 'info.freezr.admin',
  collection_name: 'users',
  owner: 'fradmin'
}

/**
 * Public Manifests OAC - Stores public app manifests
 */
export const PUBLIC_MANIFESTS_OAC = {
  app_name: 'info.freezr.admin',
  collection_name: 'public_manifests',
  owner: 'fradmin'
}

/**
 * Public Records OAC - Stores public records
 */
export const PUBLIC_RECORDS_OAC = {
  app_name: 'info.freezr.public',
  collection_name: 'public_records',
  owner: 'public'
}

/**
 * Validation Tokens OAC - Stores validation tokens
 */
export const VALIDATION_TOKEN_OAC = {
  app_table: 'dev.ceps.perms.validations',
  owner: 'fradmin'
}

/**
 * Private Feed OAC - Stores private feed codes
 */
export const PRIVATE_FEED_OAC = {
  app_name: 'dev.ceps.privatefeeds',
  collection_name: 'codes',
  owner: 'public'
}

/**
 * Params OAC - Stores system parameters and preferences
 */
export const PARAMS_OAC = {
  owner: 'fradmin',
  app_name: 'info.freezr.admin',
  collection_name: 'params'
}

/**
 * Get permissions OAC for a specific user
 * @param {string} userId - User ID
 * @returns {Object} OAC object for user's permissions database
 */
export const userPERMS_OAC = (userId) => {
  return {
    owner: userId,
    app_name: 'info.freezr.account',
    collection_name: 'permissions'
  }
}

/**
 * Get app list OAC for a specific user
 * @param {string} userId - User ID
 * @returns {Object} OAC object for user's app list database
 */
export const userAppListOAC = (userId) => {
  return {
    owner: userId,
    app_name: 'info.freezr.account',
    collection_name: 'app_list'
  }
}

/**
 * Get app list OAC for a specific user
 * @param {string} userId - User ID
 * @returns {Object} OAC object for user's contact list database
 */
export const userContactsOAC = (userId) => {
  return {
    owner: userId,
    app_table: 'dev.ceps.contacts'
  }
}

/**
 * Get gropus OAC for a specific user
 * @param {string} userId - User ID
 * @returns {Object} OAC object for user's contact list database
 */
export const userGroupsOAC = (userId) => {
  return {
    owner: userId,
    app_table: 'dev.ceps.groups'
  }
}

/**
 * Get messages got OAC for a specific user
 * @param {string} userId - User ID
 * @returns {Object} OAC object for user's contact list database
 */
export const messagesGotOAC = (userId) => {
  return {
    owner: userId,
    app_table: 'dev.ceps.messages.got'
  }
}

/**
 * Get messages sent OAC for a specific user
 * @param {string} userId - User ID
 * @returns {Object} OAC object for user's contact list database
 */
export const messagesSentOAC = (userId) => {
  return {
    owner: userId,
    app_table: 'dev.ceps.messages.sent'
  }
}
// /**
//  * Get app list OAC for a specific user
//  * @param {string} userId - User ID
//  * @returns {Object} OAC object for user's contact list database
//  */
// export const userPrivateFeedsOAC = (userId) => {
//   return {
//     owner: userId,
//     app_table: 'dev.ceps.privatefeeds.codes'
//   }
// }


// Default export with all exports
export default {
  // Constants
  RESERVED_FIELD_LIST,
  RESERVED_IDS,
  SYSTEM_USER_IDS,
  MAX_USER_NAME_LEN,
  RESERVED_COLLECTION_NAMES,
  SYSTEM_APPS,
  FREEZR_ADMIN_DBs,
  SYSTEM_ADMIN_APPTABLES,
  APP_MANIFEST_FILE_NAME,
  FREEZR_USER_FILES_DIR,
  PERMITTED_TYPES,
  
  // Validation functions
  isSystemApp,
  validAppName,
  userIdIsValid,
  userIdFromUserInput,
  validFilename,
  validDirName,
  validPermissionName,
  validCollectionName,
   
  // App utility functions
  tempAppNameFromFileName,
  constructAppIdStringFrom,

  // Security utilities
  generateOneTimeAppPassword,
  
  // Object Access Contexts (OACs)
  APP_TOKEN_OAC,
  USER_DB_OAC,
  PUBLIC_MANIFESTS_OAC,
  PUBLIC_RECORDS_OAC,
  PRIVATE_FEED_OAC,
  PARAMS_OAC,
  VALIDATION_TOKEN_OAC,
  userPERMS_OAC,
  userAppListOAC,
  userContactsOAC,
  userGroupsOAC,
  SYSTEM_PERMS
  // userPrivateFeedsOAC
} 