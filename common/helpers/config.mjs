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
  '_accessible', // old format
  '_accessibles',
  '_publicid',
  '_date_accessibility_mod'
]

// Reserved user IDs that cannot be used
export const RESERVED_IDS = ['fradmin', 'test', 'public', 'admin', 'freezr', 'freezrdb', 'undefined', 'system', 'account', 'accounts', 'self', 'group', 'logged_in', 'loggedIn', 'login']
export const SYSTEM_USER_IDS = ['fradmin', 'test', 'public']

// Maximum length for user names and app names
export const MAX_USER_NAME_LEN = 35

// Reserved collection names. 'jobs' is reserved because a job is addressed as <app>.jobs.<name>
// (parallel to data's <app>.<collection>) — an app must not have a data collection that collides.
export const RESERVED_COLLECTION_NAMES = ['field_permissions', 'accessible_objects', 'jobs']

// System apps that are part of Freezr core
export const SYSTEM_APPS = ['info.freezr', 'dev.ceps']
// info.freezr.user is an exception to the system app rule

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

// Default federated OAuth provider — used when this freezr has no admin-registered
// oauth_serve_setup row for a connection-purpose provider type. Lets users on a brand-new
// freezr instance connect Gmail without first asking their admin to register a Google
// OAuth client; instead the auth dance is delegated to this URL.
// Admins can override this by registering their own oauth_serve_setup row.
// See freezr_mail_phase1.md §2.9 (federated OAuth).
export const FREEZR_DEFAULT_AUTH_PROVIDER = 'https://www.salmanff.com'

// Permission types and groups
export const PERMITTED_TYPES = {
  groups_for_objects: ['user', 'logged_in', 'public'],
  type_names: ['object_delegate', 'db_query']
}

// Validation functions
export const isSystemApp = (appName) => {
  if (!appName) return false
  
  const normalizedAppName = appName.replace(/\./g, '_')

  const InfoFreezrUserApp = 'info_freezr_user_'
  if (normalizedAppName.startsWith(InfoFreezrUserApp) && normalizedAppName.length > InfoFreezrUserApp.length + 3) return false
  
  return SYSTEM_APPS.some(systemApp => {
    const normalizedSystemApp = systemApp.replace(/\./g, '_')
    return normalizedAppName.startsWith(normalizedSystemApp)
  })
}

// Ask-apps (LLM-generated data pages — see freezr_askapps_plan_v1.md) live in the reserved
// reverse-domain namespace `ask-app.`. A ask-app IS a normal app: it satisfies validAppName and
// installs through the normal pipeline. isAskAppName is a *flag* (used to keep the app name and
// the manifest's app_type:'askapp' consistent), NOT a validity gate. The reservation is enforced
// where it matters, not in validAppName: the user-facing "create app" flow refuses ask-app.*
// names, and the installer warns if the name and app_type disagree. `ask-app` can never collide
// with a real TLD (delegated TLDs are letters-only ASCII or xn-- IDN — never an internal hyphen).
export const ASK_APP_PREFIX = 'ask-app.'
export const isAskAppName = (appName) => typeof appName === 'string' && appName.startsWith(ASK_APP_PREFIX)

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
  if (appName.endsWith('.')) return false

  const appSegments = appName.split('.')
  if (appSegments.length < 3) return false

  return true
}

// Turns free text (a chat question / display name) into the middle segment of a ask-app name:
// lowercase, alphanumerics and single hyphens only. Never empty. Callers cap the length so the
// full `ask-app.{slug}.{suffix}` stays within MAX_USER_NAME_LEN.
export const askAppSlug = (text) => {
  const base = String(text || '')
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'app'
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
    !uid.includes('=') && 
    !uid.includes('?') && 
    !uid.includes('&') && 
    !uid.includes('#') && 
    !uid.includes(' ') && 
    !uid.includes(' ') && 
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
  return !name.includes(' ') && !name.includes('/') && !name.includes('=') && !name.includes('?') && !name.includes('&') && !name.includes('#') && !name.includes(' ') && !name.includes('{') && !name.includes('}') && !name.includes('(') && !name.includes(')')
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
    collectionName.includes('=') ||
    collectionName.includes('?') ||
    collectionName.includes('&') ||
    collectionName.includes('#') ||
    collectionName.includes(' ') ||
    collectionName.includes('{') ||
    collectionName.includes('}') ||
    collectionName.includes('(') ||
    collectionName.includes(')') ||
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
 * Validation Tokens OAC - Stores validation tokens
 */
export const VALIDATION_TOKEN_OAC = {
  app_table: 'dev.ceps.perms.validations',
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
 * Trusted Jobs OAC - Server-wide registry of jobs an admin has approved to run
 * in-process ("trusted jobs"), with the audience allowed to use each. The local-trust
 * gate for freezr Jobs (see features/jobs/services/trustedJobService.mjs).
 */
export const TRUSTED_JOBS_OAC = {
  owner: 'fradmin',
  app_name: 'info.freezr.admin',
  collection_name: 'trusted_jobs'
}

/**
 * Scheduled Jobs OAC - ONE server-wide schedule table (fradmin-owned), one row per enabled
 * (user, app, job). The scheduler reads this single reliable collection to find due jobs across
 * all users — it does NOT iterate per-user datastores (a user on an unreachable remote DB must
 * never break the heartbeat). It only opens a user's own DB for a job that is actually due+runnable.
 * See features/jobs/services/scheduledJobsService.mjs.
 */
export const SCHEDULED_JOBS_OAC = {
  owner: 'fradmin',
  app_name: 'info.freezr.admin',
  collection_name: 'scheduled_jobs'
}

/**
 * FS Migrations OAC - ONE server-wide control/progress table (fradmin-owned), one row per
 * in-flight or recent file-system migration. Holds live progress (filesCopied/bytes),
 * the cancel flag, the worker heartbeat/claim, and the row status — driving the user's
 * status page, the concurrency semaphore, and startup recovery. The *authoritative* lock
 * and the retained credentials live on the user record's `fsMigration` field; this table
 * is the runtime/coordination side. See features/account/services/fsMigrationService.mjs.
 */
export const FS_MIGRATIONS_OAC = {
  owner: 'fradmin',
  app_name: 'info.freezr.admin',
  collection_name: 'fs_migrations'
}

/**
 * Server-wide progress/control table for DB migrations — the DB analogue of
 * FS_MIGRATIONS_OAC. One row per in-flight or recent database migration, holding live
 * progress (tablesDone/recordsCopied), the cancel flag, the worker heartbeat, and the row
 * status. The authoritative lock + retained credentials live on the user record's
 * `dbMigration` field. See features/account/services/dbMigrationService.mjs.
 */
export const DB_MIGRATIONS_OAC = {
  owner: 'fradmin',
  app_name: 'info.freezr.admin',
  collection_name: 'db_migrations'
}

/**
 * Socket Admissions OAC - the admin's EXPLICIT capability grants for server-held
 * outbound sockets (Slack Socket Mode today). Registering a provider credential
 * (e.g. the Slack app-level token on the oauth config row) deliberately does NOT
 * enable a socket — an enabled admission row here is the second, distinct act.
 * Row shape: { kind: 'provider'|'app', provider?, app_name?, enabled, maxSockets, notes }.
 * See features/connections/messaging/services/socketAdmissions.mjs.
 */
export const SOCKET_ADMISSIONS_OAC = {
  owner: 'fradmin',
  app_name: 'info.freezr.admin',
  collection_name: 'socket_admissions'
}

/**
 * Messaging Live-Connections OAC - ONE server-wide registry of connections whose
 * users opted into live (socket-fed) updates, mirroring SCHEDULED_JOBS_OAC's reason
 * for existing: the socket manager must never iterate per-user datastores to
 * discover work. One row per opted-in connection:
 * { owner_id, connection_name, provider, team_id, provider_user_id, live }.
 * team_id + provider_user_id are the ROUTING KEY events are matched against —
 * an event that matches no row is counted and dropped (fail-closed).
 * See features/connections/messaging/services/messagingRegistry.mjs.
 */
export const MESSAGING_LIVE_OAC = {
  owner: 'fradmin',
  app_name: 'info.freezr.admin',
  collection_name: 'messaging_live_connections'
}

// Migration statuses during which a user is fully offline-locked: ALL data access to
// that user's own data store (reads AND writes, via any app/route) is refused, so the
// copy gets a consistent snapshot. The account app is exempted at the gate so the
// status page can still render. Shared by dsManager (the gate) and fsMigrationService.
export const FS_MIGRATION_LOCKED_STATES = ['preparing', 'copying', 'verifying', 'rolling_back']

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
// Chat threads for ask-apps (see freezr_askapps_plan_v1.md §5c). Owned by the creator app so it
// can read/write freely; ask-apps append their own `user` records via a granted cross-app
// write_own and read their thread back via write_own's read-own scoping.
export const userAskAppChatsOAC = (userId) => {
  return {
    owner: userId,
    app_name: 'info.freezr.creator',
    collection_name: 'askAppChats'
  }
}
// Per-source-app "learnings": short notes the ask-app builder accumulates about how a user phrases
// questions about a given app's data (e.g. "best fund" usually means TVPI). Owned by the creator app.
export const userAskLearningsOAC = (userId) => {
  return {
    owner: userId,
    app_name: 'info.freezr.creator',
    collection_name: 'askLearnings'
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
  ASK_APP_PREFIX,
  isAskAppName,
  askAppSlug,
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
  userAskAppChatsOAC,
  userAskLearningsOAC,
  userContactsOAC,
  userGroupsOAC,
  SYSTEM_PERMS
  // userPrivateFeedsOAC
} 