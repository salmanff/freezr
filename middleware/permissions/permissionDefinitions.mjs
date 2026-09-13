// freezr.info - Permission Definitions - permissionDefinitions.mjs
// Centralized definition of all permission types with their categories and required fields

/**
 * Permission field types and their expected data types
 * Defines the schema for permission objects
 */
export const PERMISSION_FIELD_TYPES = {
  requestor_app: 'string',
  table_id: 'array',      // See: cleanTableIds - this can be a string in the the orginal version but is converted to an array prior to being checked
  // table_ids: 'array', see cleanTableIds -this can be passed on from the orginal version but is converted to  table_id array prior to being checked
  type: 'string',
  name: 'string',
  description: 'string',
  return_fields: 'array',
  search_fields: 'array'
  // Added by freezr at runtime:
  // granted: 'bool',
  // status: 'string',
}
/**
 * Permission types where access control is per-record via the _accessibles array.
 *
 * Freezr uses two access-control models for cross-user/cross-app permissions:
 *
 * 1. RECORD-MARKED types (listed here): The permission record just needs granted:true
 *    to enable the sharing mechanism. Individual access is controlled by the _accessibles
 *    array on each record, which lists {grantee, requestor_app, permission_name, granted}.
 *    The grantees field on the permission record is NOT used for access checks.
 *    The controller checks _accessibles at read time (readRecordById, dbQuery).
 *
 * 2. TABLE-LEVEL types (read_all, write_all, write_own, db_query): Access is controlled
 *    by the grantees array on the permission record itself. The addRightsToTable middleware
 *    verifies that the requestor is in perm.grantees before granting table-wide rights.
 *    No per-record marking is needed.
 *
 * This distinction matters in addRightsToTable (permissionContext.mjs): only table-level
 * types check perm.grantees; record-marked types skip the grantee check since their
 * access control happens later at the record level.
 */
export const PERMISSION_TYPES_FOR_WHICH_RECORDS_ARE_MARKED = ['share_records', 'message_records', 'upload_pages']
export const PERMISSION_FIELD_EXCEPTIONS_BY_TYPE = {
  use_3pFunction: [{
    field: 'function_name',
    type: 'string',
    required: false
  }],
  use_serverless: [{
    field: 'function_name',
    type: 'string',
    required: false
  }],
  // Job permissions carry job_name (which job, app-declared in the manifest) and location
  // (where it runs — USER-set at grant time, default 'auto' | 'local' | 'cloud'; narrows within the
  // consent gates, never overrides them). The perm's own `name` is its unique key (NOT the job).
  // See freezr-jobs-plan.md §4 and features/jobs/services/jobLocationResolver.mjs.
  run_job: [
    // job_name MUST stay here: this list is what PERSISTS app-declared fields onto the saved permission
    // (cleanedPermissionObjectFromManifestParams), and run-now authorizes by job_name. It also drives
    // re-grant-on-change — permissionsAreSame compares declared exception fields, so changing job_name
    // already invalidates the grant. (It is NOT an "ignorable" field; see permissionsAreSame.)
    { field: 'job_name', type: 'string', required: false },
    { field: 'location', type: 'string', required: false }
  ],
  schedule_job: [
    { field: 'job_name', type: 'string', required: false },
    { field: 'location', type: 'string', required: false }
  ],
  use_mail: [
    // Optional scoping fields on a use_mail permission record.
    // connection_names: array of connectionName values (matches records of type 'connection' in
    //   info.freezr.account.resources). Missing / empty denies (fail-closed); ['*'] grants
    //   all the user's mail-enabled connections, current and future.
    // scopes: ['read'] (default if missing) or ['read', 'write'].
    // The runtime middleware (mailContext.mjs) reads these fields off the permission record
    // and enforces both app-side scopes AND the per-connection access cap.
    { field: 'connection_names', type: 'array', required: false },
    { field: 'scopes', type: 'array', required: false }
  ],
  use_contacts: [
    // Same shape as use_mail. connection_names matches connection records that have
    // 'contacts' in their services[] array. Missing/empty denies; ['*'] grants all.
    { field: 'connection_names', type: 'array', required: false },
    { field: 'scopes', type: 'array', required: false }
  ],
  use_calendar: [
    // Same shape as use_mail. connection_names matches connection records that have
    // 'calendar' in their services[] array. Missing/empty denies; ['*'] grants all.
    { field: 'connection_names', type: 'array', required: false },
    { field: 'scopes', type: 'array', required: false }
  ],
  use_messaging: [
    // Same shape as use_mail. connection_names matches connection records that have
    // 'messaging' in their services[] array. Missing/empty denies; ['*'] grants all.
    { field: 'connection_names', type: 'array', required: false },
    { field: 'scopes', type: 'array', required: false }
  ],
  use_file_sys: [
    // Same shape as use_mail. connection_names matches connection records that have
    // 'fs' in their services[] array (file-store resources: a local folder, or later a
    // cloud drive). Missing/empty denies (fail-closed); ['*'] grants all fs stores.
    // scopes: ['read'] (default if missing — list/stat/read) or ['read', 'write']
    // (adds file write and file delete). Enforced by fsContext.mjs + fsRoutes.mjs.
    { field: 'connection_names', type: 'array', required: false },
    { field: 'scopes', type: 'array', required: false }
  ],
  socket_connect: [
    // App-declared server-held sockets (VOCABULARY REGISTERED; execution not yet
    // built). domains: the external hosts the server may hold a socket to on the
    // app's behalf — missing/empty denies (fail-closed, same convention as
    // connection_names; no wildcard). Granting is necessary but NOT sufficient:
    // the admin must also admit the (app, domain) pair on /admin/sockets, else
    // the capability ping reports blocked_by 'socket_not_admitted'.
    { field: 'domains', type: 'array', required: false },
    { field: 'scopes', type: 'array', required: false }
  ],
  // Delegation carries which of the user's OTHER apps to borrow access from (delegate_app) and which
  // of that app's permissions (delegate_permission, by name). The tables/scope come from that
  // referenced permission — never duplicated here. See freezr_askapps_plan_v1.md.
  delegate: [
    { field: 'delegate_app', type: 'string', required: true },
    { field: 'delegate_permission', type: 'string', required: true }
  ]
}
/**
 * Permission definitions array
 * Each permission object defines:
 * - type: The permission type name
 * - category: The category this permission belongs to
 * - description: Description of what this permission allows
 * - requiredFields: Array of required field names (e.g., ['table_id'])
 *    - It is assumed that all permissions have type and name at least
 *                                              ====     ====
 * 
 */
export const PERMISSION_DEFINITIONS = [
  // DataBase Access
  {
    type: 'share_records',
    category: 'DataBase Access',
    description: 'Allow sharing specific records with other users',
    requiredFields: ['table_id']
  },
  {
    type: 'read_all',
    category: 'DataBase Access',
    description: 'Read all records in a collection',
    requiredFields: ['table_id']
  },
  {
    type: 'write_own',
    category: 'DataBase Access',
    description: 'Write only records created by this user/app',
    requiredFields: ['table_id']
  },
  {
    type: 'write_all',
    category: 'DataBase Access',
    description: 'Write any records in a collection',
    requiredFields: ['table_id']
  },
  {
    type: 'db_query',
    category: 'DataBase Access',
    description: 'Execute database queries (need to better define parameters and use case)',
    requiredFields: ['table_id']
  },
  // Sharing
  {
    type: 'message_records',
    category: 'Sharing',
    description: 'Send messages about records',
    requiredFields: ['table_id']
  },
  {
    type: 'use_app',
    category: 'Sharing',
    description: 'Grant access to use an app (Never Used - Have not redeployed use case from modernization)',
    requiredFields: []
  },
  {
    type: 'upload_pages',
    category: 'Sharing',
    description: 'Allow app to upload/serve pages',
    requiredFields: []
  },
  {
    type: 'delegate',
    category: 'Sharing',
    // Bob-only delegation: lets THIS app reuse the data access the user has already granted to ANOTHER
    // of their apps, by referencing that app's permission by name. The app sees exactly what that
    // permission covers — the underlying grant is re-checked on every read — so it can never exceed what
    // the user already has. e.g. an ask-app reusing the read access another user shared with VC Tracker.
    description: "Let this app reuse data access you've already granted to another of your apps (it references that app's permission by name).",
    requiredFields: ['delegate_app', 'delegate_permission']
  },
  // App Capabilities
  {
    type: 'external_scripts',
    category: 'App Capabilities',
    description: 'Allow app to load JavaScript from external domains (relaxes script-src CSP)',
    requiredFields: []
  },
  {
    type: 'external_fetch',
    category: 'App Capabilities',
    description: 'Allow app to send/receive data to/from external domains (relaxes connect-src CSP)',
    requiredFields: []
  },
  {
    type: 'unsafe_eval',
    category: 'App Capabilities',
    description: 'Allow app to use eval() and dynamic code execution (adds unsafe-eval to script-src CSP)',
    requiredFields: []
  },
  {
    type: 'use_llm',
    category: 'App Capabilities',
    // Names web access and speech explicitly because both send the user's own content to a
    // third party under this one grant and there is no separate permission for either yet:
    // web searches carry prompt-derived queries out, and transcribe() uploads recorded audio.
    // A description that says only "AI requests" does not describe that. See TODO.md — the
    // per-app cost/scope constraints on this permission are still to be built.
    description: 'Allow app to use the user\'s LLM API keys to make AI requests, which may include web searches and sending audio for speech recognition.',
    requiredFields: []
  },
  {
    type: 'allow_self_frames',
    category: 'App Capabilities',
    description: 'Relax Content-Security-Policy frame-src/child-src for this app so it may embed same-origin or blob iframes (e.g. page preview).',
    requiredFields: []
  },
  {
    type: 'use_mail',
    category: 'App Capabilities',
    description: "Allow app to read (and optionally write) the user's connected mail accounts.",
    // connection_names and scopes are optional and declared in PERMISSION_FIELD_EXCEPTIONS_BY_TYPE.
    // Missing/empty connection_names denies (fail-closed); use ['*'] to grant all.
    requiredFields: []
  },
  {
    type: 'use_contacts',
    category: 'App Capabilities',
    description: "Allow app to read (and optionally write) the user's connected contacts.",
    // connection_names and scopes mirror use_mail; see PERMISSION_FIELD_EXCEPTIONS_BY_TYPE.
    requiredFields: []
  },
  {
    type: 'use_calendar',
    category: 'App Capabilities',
    description: "Allow app to read (and optionally write) the user's connected calendars.",
    // connection_names and scopes mirror use_mail; see PERMISSION_FIELD_EXCEPTIONS_BY_TYPE.
    requiredFields: []
  },
  {
    type: 'use_messaging',
    category: 'App Capabilities',
    description: "Allow app to read (and optionally write) the user's connected messaging accounts (e.g. Slack).",
    // connection_names and scopes mirror use_mail; see PERMISSION_FIELD_EXCEPTIONS_BY_TYPE.
    requiredFields: []
  },
  {
    type: 'use_file_sys',
    category: 'App Capabilities',
    // File-store access rides on connection records with services ['fs'] — a named local
    // folder (admins on localhost servers only; see fsContext.mjs) or, later, a cloud
    // drive (Dropbox etc.). The grant names which stores via connection_names and how
    // deep via scopes — same fail-closed contract as use_mail.
    description: "Allow app to browse and read (and optionally write) files on the user's connected file stores (e.g. a shared local folder or a cloud drive).",
    requiredFields: []
  },
  {
    type: 'socket_connect',
    category: 'App Capabilities',
    description: 'Allow the server to hold a persistent connection (socket) to a named external service on your behalf, delivering its data to this app. Also requires explicit admin admission on this server.',
    // domains declared in PERMISSION_FIELD_EXCEPTIONS_BY_TYPE (fail-closed).
    // Execution (the governed pipe) is not yet built — grants surface
    // blocked_by 'socket_not_admitted' until it is.
    requiredFields: []
  },
  {
    type: 'run_job',
    category: 'App Capabilities',
    description: "Allow the app to run this job ON DEMAND (when the app or you trigger it). Does NOT allow scheduled/background runs — that is the separate 'schedule_job' permission. The job runs with the app's own data permissions; you choose where it runs (auto / on this server / your own cloud) when you grant it.",
    requiredFields: [] // job_name (which job) + location declared in PERMISSION_FIELD_EXCEPTIONS_BY_TYPE; the perm's own `name` is its unique key
  },
  {
    type: 'schedule_job',
    category: 'App Capabilities',
    description: "Allow the app to run this job AUTOMATICALLY on a recurring schedule (e.g. hourly / daily / weekly) in the background. You choose where it runs (auto / on this server / your own cloud) when you grant it. Independent of 'run_job'.",
    requiredFields: []
  },
    {
    type: 'auto_update_local_3pFunction',
    category: 'App Capabilities',
    description: 'Allow app to auto-update a local 3rd party function for all users (admin only)',
    requiredFields: [] // functionName is required but perm name is assumed to be the function otherwise
  },
    {
    type: 'use_3pFunction',
    category: 'App Capabilities',
    description: 'Allow app to use a 3P Function already installed on the server',
    requiredFields: [] // functionName is required but perm name is assumed to be the function otherwise
  },
    {
    type: 'use_serverless',
    category: 'App Capabilities',
    description: 'Allow access to user serverlesss params to run 3rd party functions on the cloud.',
    requiredFields: []
  }
]

/**
 * Reutns permissions that dont need a table id
 * @returns {Array<string>} - Array of permission types that don't need a table id
 */
export const permissionTypesThatDontNeedTableId = () => {
  // Return permissions that do not require 'table_id' in their requiredFields
  return PERMISSION_DEFINITIONS
    .filter(perm => !perm.requiredFields.includes('table_id'))
    //  && perm.type !== 'upload_pages'
    // upload_pages exception - technically they do not need one as it goes into files, but have kept in there
    .map(perm => perm.type)
}
/**
 * Reutns permissions that DO need a table id
 * @returns {Array<string>} - Array of permission types that need a table id
 */
export const permissionTypesThatNeedTableId = () => {
  // Return permissions that do require 'table_id' in their requiredFields
  return PERMISSION_DEFINITIONS
    .filter(perm => perm.requiredFields.includes('table_id'))
    .map(perm => perm.type)
}

/**
 * Checks if a permission type is allowed
 * Replaces the usage of ALLOWED_PERMISSION_TYPES array
 * 
 * @param {string} permissionType - The permission type to check
 * @returns {boolean} - True if the permission type is allowed
 */
export const isAllowedPermissionType = (permissionType) => {
  return PERMISSION_DEFINITIONS.some(perm => perm.type === permissionType)
}

/**
 * Checks if a permission has the required fields
 * Replaces the usage of PERMS_THAT_DONT_NEED_TABLES
 * 
 * @param {string} permissionType - The permission type to check
 * @param {Object} fields - The fields object (should have the required fields)
 * @returns {boolean} - True if required fields are present
 */
export const hasRequiredFields = (permissionType, fields = {}) => {
  const permissionDef = PERMISSION_DEFINITIONS.find(perm => perm.type === permissionType)
  
  if (!permissionDef) {
    return false
  }
  
  // Check all required fields
  for (const requiredField of permissionDef.requiredFields) {
    if (!fields[requiredField]) {
      return false
    }
  }
  
  return true
}

/**
 * Gets a permission definition by type
 * 
 * @param {string} permissionType - The permission type type
 * @returns {Object|undefined} - The permission definition or undefined if not found
 */
export const getPermissionDefinition = (permissionType) => {
  return PERMISSION_DEFINITIONS.find(perm => perm.type === permissionType)
}

/**
 * Gets all permission names (for backward compatibility if needed)
 * 
 * @returns {Array<string>} - Array of all permission type names
 */
export const getAllPermissionTypes = () => {
  return PERMISSION_DEFINITIONS.map(perm => perm.type)
}

/**
 * Cleans and normalizes table_id fields in a permission object
 * Converts table_id string to array, and table_ids to table_id array
 * Modifies the object in place
 * 
 * @param {Object} statedPerm - The permission object to clean (modified in place)
 */
export const cleanTableIds = (statedPerm) => {
  // Convert table_id string to array
  if (statedPerm.table_id && typeof statedPerm.table_id === 'string') {
    statedPerm.table_id = [statedPerm.table_id]
  }
  // Convert table_ids to table_id if table_id doesn't exist
  if (statedPerm.table_ids && !statedPerm.table_id) {
    statedPerm.table_id = statedPerm.table_ids
  }
  // Remove table_ids after conversion
  delete statedPerm.table_ids
}

/**
 * Validates permission field types and returns error keys
 * Checks if the statedPerm object has fields with correct types according to PERMISSION_FIELD_TYPES
 * 
 * @param {Object} statedPerm - The permission object to validate
 * @returns {string} - Space-separated string of field names with incorrect types, empty string if all valid
 */
export const getPermissionFieldTypeErrors = (statedPerm) => {
  let errKeys = ''
  Object.entries(PERMISSION_FIELD_TYPES).forEach(([key, prop]) => {
    switch (prop) {
      case 'bool':
        errKeys += key + ' '
        break
      case 'array':
        if (statedPerm[key] && !Array.isArray(statedPerm[key])) {
          errKeys += key + ' '
        }
        break
      case 'string':
        if (statedPerm[key] && typeof statedPerm[key] !== 'string') {
          errKeys += key + ' '
        }
        break
      default:
        errKeys += key + ' '
    }
  })
  // Check for exceptions
  const exceptionList = PERMISSION_FIELD_EXCEPTIONS_BY_TYPE[statedPerm.type]
  if (exceptionList && exceptionList.length > 0) {
    for (const exception of exceptionList) {
      const val = statedPerm[exception.field]
      if (val !== undefined && val !== null) {
        // typeof returns 'object' for arrays — use Array.isArray when the declared
        // type is 'array'. Fall back to plain typeof for other declared types.
        const mismatched = exception.type === 'array'
          ? !Array.isArray(val)
          : typeof val !== exception.type
        if (mismatched) errKeys += statedPerm.type + ' '
      } else if (exception.required) {
        errKeys += statedPerm.type + ' '
      }
    }
  }
  return errKeys.trim()
}

