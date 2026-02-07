// freezr.info - Permission Definitions
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
  }]
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
  // App Capabilities
  {
    type: 'outside_scripts',
    category: 'App Capabilities',
    description: 'Allow app to use outside scripts',
    requiredFields: []
  },
  {
    type: 'use_serverless',
    category: 'App Capabilities',
    description: 'Allow access to user serverlesss params to run 3rd party functions on the cloud.',
    requiredFields: []
  },
  {
    type: 'use_3pFunction',
    category: 'App Capabilities',
    description: 'Allow app to use a 3P Function already installed on the server',
    requiredFields: [] // functionName is required but perm name is assumed to be the function otherwise
  },
  {
    type: 'auto_update_local_3pFunction',
    category: 'App Capabilities',
    description: 'Allow app to auto-update a local 3rd party function for all users (admin only)',
    requiredFields: [] // functionName is required but perm name is assumed to be the function otherwise
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
      if (statedPerm[exception.field] && typeof statedPerm[exception.field] !== exception.type) {
        errKeys += statedPerm.type + ' '
      } else if (!statedPerm[exception.field] && exception.required) {
        errKeys += statedPerm.type + ' '
      }
    }
  }
  return errKeys.trim()
}

