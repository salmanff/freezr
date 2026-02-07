// freezr.info - Modern ES6 Module - Login Service
// Business logic for user authentication
//
// Architecture Pattern:
// - Service layer handles ONLY authentication logic
// - Controller handles sessions, tokens, and logging
// - Uses modern dsManager for data access
// - Returns structured results for controllers

import User from '../../../common/misc/userObj.mjs'

/**
 * Login service for handling user authentication
 */
export class LoginService {
  constructor(dsManager) {
    this.dsManager = dsManager
  }

  /**
   * Authenticate user credentials ONLY
   * Does NOT create session, tokens, or log visits
   * 
   * @param {string} user_id - User ID
   * @param {string} password - Password
   * @returns {Promise<Object>} Authentication result with user data or error
   */
  async authenticateUser(user_id, password) {
    // onsole.log('🔐 LoginService.authenticateUser called', { user_id, hasPassword: !!password })
    
    try {
      // Validate input
      if (!user_id || !password) {
        console.log('❌ Missing credentials')
        return {
          success: false,
          error: 'Missing user_id or password',
          code: 'MISSING_CREDENTIALS',
          shouldBeAlertedToFailure: false // Don't log missing credentials
        }
      }

      // Check if freezr is set up
      if (!this.dsManager.freezrIsSetup) {
        return {
          success: false,
          error: 'Server not configured',
          code: 'SERVER_NOT_SETUP',
          shouldBeAlertedToFailure: false
        }
      }

      // Get user from database
      // onsole.log('🔍 Querying user database for user_id:', user_id)
      const userDb = this.dsManager.getDB({
        app_name: 'info.freezr.admin',
        collection_name: 'users',
        owner: 'fradmin'
      })
      
      const users = await userDb.query({ user_id })
      // console.log('🔍 Query result:', { userCount: users?.length })
      
      if (!users || users.length === 0) {
        // onsole.warn('❌ Invalid credentials - no user found')
        return {
          success: false,
          error: 'Invalid credentials',
          code: 'INVALID_CREDENTIALS',
          shouldBeAlertedToFailure: true,
          user_id
        }
      }

      if (users.length > 1) {
        return {
          success: false,
          error: 'Database error - multiple users found',
          code: 'DATABASE_ERROR',
          shouldBeAlertedToFailure: false
        }
      }

      // Verify password
      const user = new User(users[0])
      if (!user.check_passwordSync(password)) {
        // onsole.warn('❌ Invalid credentials - wrong password')
        return {
          success: false,
          error: 'Invalid credentials',
          code: 'INVALID_CREDENTIALS',
          shouldBeAlertedToFailure: true,
          user_id
        }
      }

      // Success - return user data
      // nsole.log('✅ Authentication successful for user:', user_id)
      return {
        success: true,
        user: {
          user_id: user_id,
          isAdmin: Boolean(user.isAdmin),
          isPublisher: Boolean(user.isPublisher),
          userObject: user // Full user object for session creation
        }
      }

    } catch (error) {
      console.error('LoginService.authenticateUser error:', error)
      return {
        success: false,
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
        shouldBeAlertedToFailure: false
      }
    }
  }
}

export default LoginService
