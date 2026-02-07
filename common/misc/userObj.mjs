// freezr.info - Modern ES6 Module - User Object
// User model for authentication and user data management
//
// Architecture Pattern:
// - ES6 class-based user model
// - Modern import/export syntax
// - Clean separation of concerns
// - Type-safe property access

import bcrypt from 'bcryptjs'

/**
 * Normalize user ID input
 * @param {string} userIdInput - Raw user ID input
 * @returns {string|null} Normalized user ID
 */
const userIdFromUserInput = (userIdInput) => {
  return userIdInput ? userIdInput.trim().toLowerCase().replace(/ /g, '_') : null
}

/**
 * User model class for authentication and user data
 */
export class User {
  /**
   * Create a new User instance
   * @param {Object} userJson - User data object
   */
  constructor(userJson = {}) {
    this.email_address = userJson.email_address || null
    this.full_name = userJson.full_name || null
    this.user_id = userJson.user_id ? userIdFromUserInput(userJson.user_id) : null
    this.password = userJson.password || null
    this.fsParams = userJson.fsParams || {}
    this.dbParams = userJson.dbParams || {}
    this.slParams = userJson.slParams || {}
    this.limits = userJson.limits || {}
    this.userPrefs = userJson.userPrefs
    this.isAdmin = userJson.isAdmin || false
    this.isPublisher = userJson.isPublisher || false
    this.first_seen_date = userJson.first_seen_date || null
    this.last_modified_date = userJson.last_modified_date || null
    this.deleted = userJson.deleted || null
  }

  /**
   * Check password asynchronously
   * @param {string} pw - Password to check
   * @param {Function} callback - Callback function (err, result)
   */
  check_password(pw, callback) {
    bcrypt.compare(pw, this.password, callback)
  }

  /**
   * Check password synchronously
   * @param {string} pw - Password to check
   * @returns {boolean} True if password matches
   */
  check_passwordSync(pw) {
    return pw && this && this.password && bcrypt.compareSync(pw, this.password)
  }

  /**
   * Get user data as response object (excludes sensitive data)
   * @returns {Object} User data for API responses
   */
  response_obj() {
    return {
      user_id: this.user_id,
      full_name: this.full_name,
      email_address: this.email_address,
      isAdmin: this.isAdmin,
      isPublisher: this.isPublisher,
      fsParams: {
        type: this.fsParams?.type,
        choice: this.fsParams?.choice
      },
      dbParams: {
        type: this.dbParams?.type,
        choice: this.dbParams?.choice
      },
      limits: this.limits,
      userPrefs: this.userPrefs,
      first_seen_date: this.first_seen_date,
      last_modified_date: this.last_modified_date
    }
  }
}

// Default export for backward compatibility
export default User
