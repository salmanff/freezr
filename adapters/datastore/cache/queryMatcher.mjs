// freezr.info - Query Matching and Filtering
// Handles query hashing, in-memory filtering, and query type detection

import crypto from 'crypto'

/**
 * Create a deterministic hash for a query
 * Used as the cache key for Query type caches
 */
export function hashQuery(query, options = {}) {
  // Sort keys for deterministic ordering
  const normalized = {
    query: sortObject(query),
    options: sortObject(options)
  }
  
  const str = JSON.stringify(normalized)
  return crypto.createHash('md5').update(str).digest('hex').substring(0, 16)
}

/**
 * Detect if this is a _date_modified $gt/$gte query
 * These can be answered definitively by Recent cache
 */
export function isDateModifiedGtQuery(query) {
  if (!query || typeof query !== 'object') return { isDateQuery: false }
  
  // Check for { _date_modified: { $gt: timestamp } }
  if (query._date_modified && 
      typeof query._date_modified === 'object' && 
      query._date_modified.$gt !== undefined) {
    return {
      isDateQuery: true,
      timestamp: query._date_modified.$gt,
      hasOtherConditions: Object.keys(query).length > 1
    }
  }
  
  // Check for { _date_modified: { $gte: timestamp } }
  if (query._date_modified && 
      typeof query._date_modified === 'object' && 
      query._date_modified.$gte !== undefined) {
    return {
      isDateQuery: true,
      timestamp: query._date_modified.$gte,
      hasOtherConditions: Object.keys(query).length > 1
    }
  }
  
  return { isDateQuery: false }
}

/**
 * Check if a value is a valid cacheable value (string or number only)
 */
export function isCacheableValue(value) {
  return typeof value === 'string' || typeof value === 'number'
}

/**
 * Check if query is a simple single-field equality check
 * E.g., { _id: 'value' }, { status: 'active' }, { user_id: 'alice' }
 * Value must be string or number (not boolean or other types)
 */
export function isSimpleQuery(query, options = {}) {
  if (!query || typeof query !== 'object') return { isSimple: false }
  // easy route of getting rid of any sort or limit - but this van be refined to cehck for smaller limits etc
  if (options && (options.limit || options.count || options.sort || options.skip)) return { isSimple: false }
  
  const keys = Object.keys(query)
  
  // Must have exactly one key
  if (keys.length !== 1) return { isSimple: false }
  
  const field = keys[0]
  const value = query[field]
  
  // Value must be string or number (cacheable types)
  if (!isCacheableValue(value)) {
    return { isSimple: false }
  }
  
  // Valid simple query
  return { 
    isSimple: true, 
    field,
    value
  }
}

/**
 * Check if query matches a compound cache pattern (multi-field equality)
 * Patterns are arrays like ['category', 'author'] meaning query must have exactly those fields
 * with string/number values and no options
 * 
 * @param {Object} query - The query object
 * @param {Array} patterns - Array of patterns, e.g., [['category', 'author'], ['status', 'type']]
 * @param {Object} options - Query options (sort, skip, limit, etc.)
 * @returns {Object} { matches: boolean, pattern: Array|null }
 */
export function matchesCompoundPattern(query, patterns, options = {}) {
  if (!query || typeof query !== 'object') return { matches: false, pattern: null }
  
  // Reject queries with options - we don't cache those
  if (options && (options.limit || options.count || options.sort || options.skip)) {
    return { matches: false, pattern: null }
  }
  
  const queryFields = Object.keys(query).sort()
  
  // Check each compound pattern (arrays with 2+ fields)
  for (const pattern of patterns) {
    // Skip single-field patterns (those are handled by isSimpleQuery/byKey)
    if (!Array.isArray(pattern) || pattern.length < 2) continue
    
    const patternFields = [...pattern].sort()
    
    // Check if query fields match pattern fields exactly
    if (queryFields.length !== patternFields.length) continue
    if (!queryFields.every((f, i) => f === patternFields[i])) continue
    
    // Check all values are cacheable (string or number)
    let allCacheable = true
    for (const field of queryFields) {
      if (!isCacheableValue(query[field])) {
        allCacheable = false
        break
      }
    }
    
    if (allCacheable) {
      return { matches: true, pattern }
    }
  }
  
  return { matches: false, pattern: null }
}

/**
 * Build a query object from a record based on a pattern
 * Used for invalidation - extract pattern fields from record to build cache key
 * 
 * @param {Object} record - The record object
 * @param {Array} pattern - Pattern array, e.g., ['category', 'author']
 * @returns {Object|null} Query object or null if any field is missing/not cacheable
 */
export function buildQueryFromPattern(record, pattern) {
  if (!record || !pattern) return null
  
  const fields = Array.isArray(pattern) ? pattern : [pattern]
  const query = {}
  
  for (const field of fields) {
    const value = record[field]
    // Skip if field is missing or not cacheable
    if (value === undefined || !isCacheableValue(value)) {
      return null
    }
    query[field] = value
  }
  
  return query
}

/**
 * Filter an array of records by a query in memory
 * Supports basic MongoDB-style queries
 */
export function filterRecords(records, query, options = {}) {
  if (!records || !Array.isArray(records)) return []
  if (!query || Object.keys(query).length === 0) {
    // Empty query - just apply options
    return applyOptions(records, options)
  }
  
  let filtered = records.filter(record => matchesQuery(record, query))
  return applyOptions(filtered, options)
}

/**
 * Apply options (sort, skip, limit) to records
 */
function applyOptions(records, options) {
  let result = records
  
  // Apply sorting if specified in options
  if (options.sort) {
    result = applySorting(result, options.sort)
  }
  
  // Apply skip and limit
  if (options.skip) {
    result = result.slice(options.skip)
  }
  if (options.count || options.limit) {
    const limit = options.count || options.limit
    result = result.slice(0, limit)
  }
  
  return result
}

/**
 * Check if a single record matches a query
 */
function matchesQuery(record, query) {
  for (const [key, value] of Object.entries(query)) {
    if (!matchQueryPart(record, key, value)) {
      return false
    }
  }
  return true
}

/**
 * Check whether 'things' are equal (nedb-compatible deep equality)
 * Things are defined as any native types (string, number, boolean, null, date) and objects
 * In the case of object, we check deep equality
 */
function areThingsEqual(a, b) {
  // Strings, booleans, numbers, null
  if (a === null || typeof a === 'string' || typeof a === 'boolean' || typeof a === 'number' ||
      b === null || typeof b === 'string' || typeof b === 'boolean' || typeof b === 'number') {
    return a === b
  }

  // Dates
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  }

  // Arrays (no match since arrays are used as a $in)
  // undefined (no match since they mean field doesn't exist and can't be serialized)
  if ((!(Array.isArray(a) && Array.isArray(b)) && (Array.isArray(a) || Array.isArray(b))) || 
      a === undefined || b === undefined) {
    return false
  }

  // General objects (check for deep equality)
  try {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    
    if (aKeys.length !== bKeys.length) return false
    
    for (let i = 0; i < aKeys.length; i++) {
      if (bKeys.indexOf(aKeys[i]) === -1) return false
      if (!areThingsEqual(a[aKeys[i]], b[aKeys[i]])) return false
    }
    return true
  } catch (e) {
    return false
  }
}

/**
 * Check that two values are comparable (nedb-compatible)
 */
function areComparable(a, b) {
  if (typeof a !== 'string' && typeof a !== 'number' && !(a instanceof Date) &&
      typeof b !== 'string' && typeof b !== 'number' && !(b instanceof Date)) {
    return false
  }

  if (typeof a !== typeof b) return false

  return true
}

/**
 * Array-specific comparison functions (nedb-compatible)
 */
const arrayComparisonFunctions = {
  $size: true,
  $elemMatch: true
}

/**
 * Comparison functions (nedb-compatible)
 */
const comparisonFunctions = {
  $lt: function(a, b) {
    return areComparable(a, b) && a < b
  },
  $lte: function(a, b) {
    return areComparable(a, b) && a <= b
  },
  $gt: function(a, b) {
    return areComparable(a, b) && a > b
  },
  $gte: function(a, b) {
    return areComparable(a, b) && a >= b
  },
  $ne: function(a, b) {
    if (a === undefined) return true
    return !areThingsEqual(a, b)
  },
  $in: function(a, b) {
    if (!Array.isArray(b)) {
      throw new Error("$in operator called with a non-array")
    }
    for (let i = 0; i < b.length; i++) {
      if (areThingsEqual(a, b[i])) return true
    }
    return false
  },
  $nin: function(a, b) {
    if (!Array.isArray(b)) {
      throw new Error("$nin operator called with a non-array")
    }
    return !comparisonFunctions.$in(a, b)
  },
  $regex: function(a, b) {
    if (!(b instanceof RegExp)) {
      throw new Error("$regex operator called with non regular expression")
    }
    if (typeof a !== 'string') {
      return false
    } else {
      return b.test(a)
    }
  },
  $exists: function(value, exists) {
    // This will be true for all values of exists except false, null, undefined and 0
    // That's strange behaviour (we should only use true/false) but that's the way Mongo does it...
    if (exists || exists === '') {
      exists = true
    } else {
      exists = false
    }

    if (value === undefined) {
      return !exists
    } else {
      return exists
    }
  },
  $size: function(obj, value) {
    if (!Array.isArray(obj)) return false
    if (value % 1 !== 0) {
      throw new Error("$size operator called without an integer")
    }
    return obj.length == value
  },
  $elemMatch: function(obj, value) {
    if (!Array.isArray(obj)) return false
    for (let i = 0; i < obj.length; i++) {
      if (matchQueryPart({ k: obj[i] }, 'k', value)) {
        return true
      }
    }
    return false
  }
}

/**
 * Match an object against a specific { key: value } part of a query (nedb-compatible)
 * This handles arrays properly: if the field value is an array, checks if any element matches
 */
function matchQueryPart(obj, queryKey, queryValue, treatObjAsValue) {
  let objValue = obj[queryKey]
  let i, keys, firstChars, dollarFirstChars

  // Check if the value is an array if we don't force a treatment as value
  if (Array.isArray(objValue) && !treatObjAsValue) {
    // If the queryValue is an array, try to perform an exact match
    if (Array.isArray(queryValue)) {
      return matchQueryPart(obj, queryKey, queryValue, true)
    }

    // Check if we are using an array-specific comparison function
    if (queryValue !== null && typeof queryValue === 'object' && !(queryValue instanceof RegExp)) {
      keys = Object.keys(queryValue)
      for (i = 0; i < keys.length; i++) {
        if (arrayComparisonFunctions[keys[i]]) {
          return matchQueryPart(obj, queryKey, queryValue, true)
        }
      }
    }

    // If not, treat it as an array of { obj, query } where there needs to be at least one match
    for (i = 0; i < objValue.length; i++) {
      if (matchQueryPart({ k: objValue[i] }, 'k', queryValue)) {
        return true  // k here could be any string
      }
    }
    return false
  }

  // queryValue is an actual object. Determine whether it contains comparison operators
  // or only normal fields. Mixed objects are not allowed
  if (queryValue !== null && typeof queryValue === 'object' && !(queryValue instanceof RegExp) && !Array.isArray(queryValue)) {
    keys = Object.keys(queryValue)
    firstChars = keys.map(item => item[0])
    dollarFirstChars = firstChars.filter(c => c === '$')

    if (dollarFirstChars.length !== 0 && dollarFirstChars.length !== keys.length) {
      throw new Error("You cannot mix operators and normal fields")
    }

    // queryValue is an object of this form: { $comparisonOperator1: value1, ... }
    if (dollarFirstChars.length > 0) {
      for (i = 0; i < keys.length; i++) {
        if (!comparisonFunctions[keys[i]]) {
          throw new Error("Unknown comparison function " + keys[i])
        }
        if (!comparisonFunctions[keys[i]](objValue, queryValue[keys[i]])) {
          return false
        }
      }
      return true
    }
  }

  // Using regular expressions with basic querying
  if (queryValue instanceof RegExp) {
    return comparisonFunctions.$regex(objValue, queryValue)
  }

  // queryValue is either a native value or a normal object
  // Basic matching is possible
  if (!areThingsEqual(objValue, queryValue)) {
    return false
  }

  return true
}

/**
 * Check if a record field matches a query condition
 * @deprecated Use matchQueryPart instead - kept for backward compatibility
 */
function matchesCondition(recordValue, queryValue) {
  return matchQueryPart({ k: recordValue }, 'k', queryValue)
}

/**
 * Apply sorting to records
 */
function applySorting(records, sort) {
  if (!sort || typeof sort !== 'object') return records
  
  const sorted = [...records]
  const sortFields = Object.entries(sort)
  
  sorted.sort((a, b) => {
    for (const [field, direction] of sortFields) {
      const aVal = a[field]
      const bVal = b[field]
      
      if (aVal === bVal) continue
      
      const comparison = aVal > bVal ? 1 : -1
      return direction === 1 ? comparison : -comparison
    }
    return 0
  })
  
  return sorted
}

/**
 * Sort object keys recursively for deterministic hashing
 */
function sortObject(obj) {
  if (obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(sortObject)
  
  return Object.keys(obj)
    .sort()
    .reduce((sorted, key) => {
      sorted[key] = sortObject(obj[key])
      return sorted
    }, {})
}

/**
 * Check if Recent cache can definitively answer a date query
 * Returns true if Recent has records older than OR EQUAL TO the query timestamp
 * 
 * IMPORTANT: This determines if Recent cache is "authoritative" for the query
 */
export function isRecentCacheComplete(recentRecords, queryTimestamp) {
  if (!recentRecords || recentRecords.length === 0) return false
  
  // Find the oldest record in Recent cache
  const oldestDate = Math.min(...recentRecords.map(r => r._date_modified || Infinity))
  
  // If oldest record is older than or equal to query timestamp, we have everything
  // This means Recent cache covers the entire time range we're querying
  return oldestDate <= queryTimestamp
}

export default {
  hashQuery,
  isDateModifiedGtQuery,
  isSimpleQuery,
  isCacheableValue,
  matchesCompoundPattern,
  buildQueryFromPattern,
  filterRecords,
  isRecentCacheComplete
}
