// freezr.info - Modern ES6 Module - Password Service
// Handles password change business logic
//
// Architecture Pattern:
// - Pure functions for business logic
// - Data access functions that take dependencies
// - No HTTP concerns - only business logic and data operations

import bcrypt from 'bcryptjs'
import User from '../../../common/misc/userObj.mjs'
import { generateOneTimeAppPassword } from '../../../common/helpers/config.mjs'

/**
 * Change user password
 * Validates old password, hashes new password, and updates database
 * 
 * @param {Object} allUsersDb - All users database instance
 * @param {string} userId - User ID
 * @param {string} oldPassword - Current password
 * @param {string} newPassword - New password
 * @returns {Promise<Object>} Updated user object
 */
export const changeUserPassword = async (allUsersDb, userId, oldPassword, newPassword) => {
  console.log('🔐 changeUserPassword called for userId:', userId)
  
  if (!userId) {
    throw new Error('Missing user id')
  }
  if (!oldPassword) {
    throw new Error('Missing old password')
  }
  if (!newPassword) {
    throw new Error('Missing new password')
  }
  if (!allUsersDb || !allUsersDb.query) {
    throw new Error('Users database not available')
  }

  try {
    // Get user from database (async, no Promise wrapper needed)
    const users = await allUsersDb.query({ user_id: userId }, {})
    
    if (!users || users.length === 0) {
      throw new Error('User not found')
    }
    if (users.length > 1) {
      console.warn('⚠️  Multiple users found for user_id:', userId)
    }

    const user = new User(users[0])

    // Check old password
    if (!user.check_passwordSync(oldPassword)) {
      console.warn('⚠️  Wrong password attempt for userId:', userId)
      throw new Error('Wrong password')
    }

    // Hash new password
    const hash = await bcrypt.hash(newPassword, 10)

    // Update password in database (async, no Promise wrapper needed)
    const updateResult = await allUsersDb.update(
      { user_id: userId },
      { password: hash },
      { replaceAllFields: false }
    )

    if (!updateResult || !updateResult.nModified || updateResult.nModified === 0) {
      throw new Error('Could not update password')
    }

    if (updateResult.nModified !== 1) {
      console.warn('⚠️  Updated more than one user record:', updateResult)
    }

    console.log('✅ changeUserPassword completed successfully')
    return { user: user.response_obj() }
  } catch (error) {
    console.error('❌ Error in changeUserPassword:', error)
    throw error
  }
}


/**
 * Set user password as admin (no old password check, no session changes).
 * Used for admin "Reset Password" only.
 *
 * @param {Object} allUsersDb - All users database instance
 * @param {string} userId - User ID to reset
 * @param {string} newPassword - New password to set
 * @returns {Promise<Object>} Result with user summary (no session)
 */
export const setUserPasswordAsAdmin = async (allUsersDb, userId, newPassword) => {
  if (!userId) throw new Error('Missing user id')
  if (!newPassword) throw new Error('Missing new password')
  if (!allUsersDb?.query) throw new Error('Users database not available')

  const users = await allUsersDb.query({ user_id: userId }, {})
  if (!users?.length) throw new Error('User not found')
  if (users.length > 1) console.warn('⚠️  Multiple users found for user_id:', userId)

  const hash = await bcrypt.hash(newPassword, 10)
  await allUsersDb.update(
    { user_id: userId },
    { password: hash },
    { replaceAllFields: false }
  )
  console.log('✅ setUserPasswordAsAdmin completed for userId:', userId)
  return { userId, message: 'Password reset successfully' }
}

/**
 * Delete all app tokens for a user (e.g. after admin password reset).
 * Deletes records so they cannot be extended; expiry-only updates are not used.
 *
 * @param {Object} tokenDb - Token database instance (APP_TOKEN_OAC)
 * @param {string} userId - User ID whose tokens to delete
 * @returns {Promise<{ deletedCount: number }>}
 */
export const deleteAllAppTokensForUser = async (tokenDb, userId) => {
  if (!userId) throw new Error('Missing user id')
  if (!tokenDb?.delete_records) throw new Error('Token database not available (need delete_records)')

  const result = await tokenDb.delete_records({ owner_id: userId }, { multi: true })
  const n = result?.nRemoved ?? 0
  if (n > 0) {
    console.log('✅ deleteAllAppTokensForUser: deleted', n, 'token(s) for userId:', userId)
  }
  return { deletedCount: n }
}

const EXPIRY_DEFAULT_FOR_APPS = 6 * 30 * 24 * 60 * 60 * 1000 // 6 months

/**
 * Generate app password and token, then persist to database
 * Main orchestrator function
 * 
 * @param {Object} tokenDb - Token database instance
 * @param {string} userId - User ID
 * @param {string} appName - Application name
 * @param {Object} options - Additional options
 * @param {string} options.deviceCode - Device code
 * @param {number} [options.expiry] - Expiry timestamp (defaults to 30 days from now)
 * @param {boolean} [options.oneDevice=true] - Whether password is for one device only
 * @returns {Promise<Object>} Result with app_password and app_name
 */
export const generateAndSaveAppPasswordForUser = async (tokenDb, userId, appName, options = {}) => {
  // console.log('🔑 generateAndSaveAppPasswordForUser called with details:', { tokenDb, userId, appName, options })
  if (EXPIRY_DEFAULT_FOR_APPS < 24 * 60 * 60 * 1000) {
    console.warn('⚠️  EXPIRY_DEFAULT_FOR_APPS is LOW hours for testing')
  }
  const {
    deviceCode,
    expiry = new Date().getTime() + EXPIRY_DEFAULT_FOR_APPS,
    oneDevice = false
  } = options 

  if (!userId) {
    throw new Error('Missing user id')
  }
  if (!appName) {
    throw new Error('Missing app name')
  }
  if (!deviceCode && process.env.FREEZR_TEST_MODE !== 'true') {
    throw new Error('Missing device code')
  }

  // Generate password and token
  const app_password = generateOneTimeAppPassword(userId, appName, deviceCode)
  const app_token = generateOneTimeAppPassword(userId, appName, deviceCode)

  // Prepare record data
  const recordData = {
    logged_in: false,
    source_device: deviceCode,
    owner_id: userId,
    requestor_id: userId,
    app_name: appName,
    app_password,
    app_token,
    expiry,
    one_device: oneDevice,
    user_device: null,
    date_used: null
  }

  // Persist to database
  try {
    const writeResult = await tokenDb.create(null, recordData, null)
    // onsole.log('🔑 writeResult', { writeResult, oac: tokenDb.oac })

    // const readResult = await tokenDb.query({ app_password }, {})
    // onsole.log('🔑 readResult', { readResult })
  } catch (error) {
    console.error('🔑 Error creating app password record:', error)
    throw error
  }

  // onsole.log('🔑 returning generateAndSaveAppPasswordForUser result:', { app_password, app_name: appName })
  return {
    app_password,
    app_name: appName
  }
}

/**
 * Invalidate app token (logout)
 * Sets token expiry to current time and clears cache
 * 
 * @param {Object} tokenDb - Token database instance
 * @param {string} appToken - App token to invalidate
 * @returns {Promise<Object>} Result with success status
 */
export const invalidateAppToken = async (tokenDb, appToken) => {
  // onsole.log('🔐 invalidateAppToken called for appToken:', appToken?.substring(0, 10) + '...')
  
  if (!appToken) {
    throw new Error('Missing app token')
  }
  if (!tokenDb || !tokenDb.update) {
    throw new Error('Token database not available')
  }

  try {
    const nowTime = new Date().getTime()

    // // Clear cache if token exists in cache
    // if (tokenDb.cache?.byToken && tokenDb.cache.byToken[appToken]) {
    //   const cachedToken = tokenDb.cache.byToken[appToken]
      
    //   // Delete from byOwnerDeviceApp cache
    //   if (cachedToken.owner_id && cachedToken.user_device && cachedToken.app_name) {
    //     if (tokenDb.cache.byOwnerDeviceApp?.[cachedToken.owner_id]?.[cachedToken.user_device]?.[cachedToken.app_name]) {
    //       delete tokenDb.cache.byOwnerDeviceApp[cachedToken.owner_id][cachedToken.user_device][cachedToken.app_name]
    //     }
    //   }
      
    //   // Delete from byToken cache
    //   delete tokenDb.cache.byToken[appToken]
    // }

    // Update token expiry in database
    const updateResult = await tokenDb.update(
      { app_token: appToken },
      { expiry: nowTime },
      { replaceAllFields: false }
    )

    if (!updateResult || !updateResult.nModified || updateResult.nModified === 0) {
      console.warn('⚠️  Could not update token expiry - token may not exist')
      // Don't throw error - token might already be invalidated
    }

    if (updateResult.nModified > 1) {
      console.warn('⚠️  Updated more than one token record:', updateResult)
    }

    // console.log('✅ invalidateAppToken completed successfully')
    return { success: true }
  } catch (error) {
    console.error('❌ Error in invalidateAppToken:', error)
    throw error
  }
}

// Factory function if needed elsewhere
// export const createTokenService = () => {
//   return {
//     generateAndSaveAppPasswordForUser
//   }
// }
 

// export default changeUserPassword

