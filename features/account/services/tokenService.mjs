//


// DELETE FILE -> MOVED TO passwordService.mjs


// freezr.info - Modern ES6 Module - Token Service
// Handles token generation and management business logic
//
// Architecture Pattern:
// - Pure functions for business logic
// - Data access functions that take dependencies
// - No HTTP concerns - only business logic and data operations

// import { generateOneTimeAppPassword } from '../../../common/helpers/config.mjs'

// // 30 days in ms
// const EXPIRY_DEFAULT_MS = 2 * 60 * 60 * 1000 // 2 ours for testing // 30 * 24 * 60 * 60 * 1000

// /**
//  * Generate app password and token, then persist to database
//  * Main orchestrator function
//  * 
//  * @param {Object} tokenDb - Token database instance
//  * @param {string} userId - User ID
//  * @param {string} appName - Application name
//  * @param {Object} options - Additional options
//  * @param {string} options.deviceCode - Device code
//  * @param {number} [options.expiry] - Expiry timestamp (defaults to 30 days from now)
//  * @param {boolean} [options.oneDevice=true] - Whether password is for one device only
//  * @returns {Promise<Object>} Result with app_password and app_name
//  */
// export const generateAndSaveAppPasswordForUser = async (tokenDb, userId, appName, options = {}) => {
//   console.log('🔑 generateAndSaveAppPasswordForUser called with details:', { tokenDb, userId, appName, options })
//   if (EXPIRY_DEFAULT_MS < 24 * 60 * 60 * 1000) {
//     console.warn('⚠️  EXPIRY_DEFAULT_MS is LOW hours for testing')
//   }
//   const {
//     deviceCode,
//     expiry = new Date().getTime() + EXPIRY_DEFAULT_MS,
//     oneDevice = false
//   } = options

//   if (!userId) {
//     throw new Error('Missing user id')
//   }
//   if (!appName) {
//     throw new Error('Missing app name')
//   }
//   if (!deviceCode) {
//     throw new Error('Missing device code')
//   }

//   // Generate password and token
//   const app_password = generateOneTimeAppPassword(userId, appName, deviceCode)
//   const app_token = generateOneTimeAppPassword(userId, appName, deviceCode)

//   // Prepare record data
//   const recordData = {
//     logged_in: false,
//     source_device: deviceCode,
//     owner_id: userId,
//     requestor_id: userId,
//     app_name: appName,
//     app_password,
//     app_token,
//     expiry,
//     one_device: oneDevice,
//     user_device: null,
//     date_used: null
//   }

//   // Persist to database
//   try {
//     await tokenDb.create(null, recordData, null)
//   } catch (error) {
//     console.error('🔑 Error creating app password record:', error)
//     throw error
//   }

//   // onsole.log('🔑 returning generateAndSaveAppPasswordForUser result:', { app_password, app_name: appName })
//   return {
//     app_password,
//     app_name: appName
//   }
// }

// // Factory function if needed elsewhere
// // export const createTokenService = () => {
// //   return {
// //     generateAndSaveAppPasswordForUser
// //   }
// // }

// export default generateAndSaveAppPasswordForUser
