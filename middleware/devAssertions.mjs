// freezr.info - Development Assertions Utility devAssertions.mjs
// Provides development-only assertions for debugging and validation
// 
// Architecture: Utility module for development debugging
// Only runs in development mode - completely removed in production

/**
 * Development assertion helper
 * Only runs when NODE_ENV === 'development'
 * 
 * @param {boolean} condition - Condition to assert
 * @param {string} message - Error message if assertion fails
 */
export const devAssert = (condition, message) => {
  if (process.env.NODE_ENV === 'development') {
    console.assert(condition, `[DEV-ASSERT] ${message}`)
  }
}

/**
 * Development type assertion helper
 * Validates that a value has the expected type
 * 
 * @param {any} value - Value to check
 * @param {string} expectedType - Expected type ('string', 'object', 'function', etc.)
 * @param {string} name - Name of the variable for error messages
 */
export const devAssertType = (value, expectedType, name) => {
  if (process.env.NODE_ENV === 'development') {
    const actualType = typeof value
    console.assert(
      actualType === expectedType, 
      `[DEV-ASSERT] ${name} should be ${expectedType}, got ${actualType}`
    )
  }
}

/**
 * Development non-null assertion helper
 * Validates that a value is not null or undefined
 * 
 * @param {any} value - Value to check
 * @param {string} name - Name of the variable for error messages
 */
export const devAssertNotNull = (value, name) => {
  if (process.env.NODE_ENV === 'development') {
    console.assert(value != null, `[DEV-ASSERT] ${name} should not be null or undefined`)
  }
}

/**
 * Development array assertion helper
 * Validates that a value is an array with expected length
 * 
 * @param {any} value - Value to check
 * @param {number} expectedLength - Expected array length (optional)
 * @param {string} name - Name of the variable for error messages
 */
export const devAssertArray = (value, expectedLength, name) => {
  if (process.env.NODE_ENV === 'development') {
    console.assert(Array.isArray(value), `[DEV-ASSERT] ${name} should be an array`)
    if (expectedLength !== undefined) {
      console.assert(
        value.length === expectedLength, 
        `[DEV-ASSERT] ${name} should have length ${expectedLength}, got ${value.length}`
      )
    }
  }
}

/**
 * Development object property assertion helper
 * Validates that an object has required properties
 * 
 * @param {object} obj - Object to check
 * @param {string[]} requiredProps - Array of required property names
 * @param {string} name - Name of the object for error messages
 */
export const devAssertProps = (obj, requiredProps, name) => {
  if (process.env.NODE_ENV === 'development') {
    console.assert(obj && typeof obj === 'object', `[DEV-ASSERT] ${name} should be an object`)
    requiredProps.forEach(prop => {
      console.assert(
        obj.hasOwnProperty(prop), 
        `[DEV-ASSERT] ${name} should have property '${prop}'`
      )
    })
  }
}

/**
 * Development timing helper
 * Measures and logs execution time in development mode
 * 
 * @param {string} label - Label for the timing measurement
 * @param {function} fn - Function to measure
 * @returns {any} Result of the function
 */
export const devTime = async (label, fn) => {
  if (process.env.NODE_ENV === 'development') {
    const start = Date.now()
    const result = await fn()
    const duration = Date.now() - start
    console.log(`[DEV-TIME] ${label} took ${duration}ms`)
    return result
  }
  return await fn()
}

/**
 * Development environment info
 * Logs current environment and assertion status
 */
export const devLogEnvironment = () => {
  if (process.env.NODE_ENV === 'development') {
    console.log(`[DEV-INFO] Running in ${process.env.NODE_ENV} mode`)
    console.log(`[DEV-INFO] Development assertions are ENABLED`)
  } else {
    console.log(`[DEV-INFO] Running in ${process.env.NODE_ENV || 'production'} mode`)
    console.log(`[DEV-INFO] Development assertions are DISABLED`)
  }
}

export default {
  devAssert,
  devAssertType,
  devAssertNotNull,
  devAssertArray,
  devAssertProps,
  devTime,
  devLogEnvironment
}
