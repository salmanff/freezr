// freezr.info - Modern ES6 Module - Permission Checkers
// Middleware functions for permission validation checks
//
// Architecture Pattern:
// - Pure validation middleware functions
// - Reusable across different routes
// - Consistent error handling

import { sendFailure } from '../../adapters/http/responses.mjs'

/**
 * NB - NOT CLEAR IF THIS WAS USING OLD LOGIC - REVIEW 2025-12-15 - 
 * Middleware to check if the requestor app is a system app or matches the target app
 * Validates that the token's app_name matches the target_app OR is a system app
 * 
 * Allowed apps:
 * - The target app itself (tokenInfo.app_name === targetApp)
 * - info.freezr.account (system account app)
 * - info.freezr.admin (system admin app)
 * 
 * Dependencies expected from middleware chain:
 * - req.params.target_app - Target app name from route parameter
 * - res.locals.freezr.tokenInfo (from createGetAppTokenInfoFromheaderForApi) - Token information with app_name
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
export const systemAppOrTargetAppRequest = (req, res, next) => {
  
  // Get token info from middleware
  const tokenInfo = res.locals?.freezr?.tokenInfo
  if (!tokenInfo) {
    console.error('auth error - systemAppOrTargetAppRequest 1', { tokenInfo, targetApp, requestorApp: req.params.requestor_app })
    return sendFailure(res, 'Token info not found', 'permissionCheckers.systemAppOrTargetAppRequest', 401)
  }

  const targetApp = req.params.target_app //  || tokenInfo.app_name - removed 2025-12 as this seemd dangerous - why in?
  if (!targetApp) console.warn('SNBH? Why nt warget_app -? should set in advance 2025-12-07')

  if (!targetApp) {
    console.error('auth error - systemAppOrTargetAppRequest 2', { tokenInfo, targetApp, requestorApp: req.params.requestor_app })
    return sendFailure(res, 'No target app requested', 'permissionCheckers.systemAppOrTargetAppRequest', 401)
  }

  // Check tokenInfo - must match target app or be a system app
  if (tokenInfo.app_name !== req.params.app_name) {
    console.error('auth error - systemAppOrTargetAppRequest 3', { tokenInfo, targetApp, appName: req.params.app_name, requestorApp: req.params.requestor_app })
    return sendFailure(res, new Error('auth error - systemAppOrTargetAppRequest'), 'permissionCheckers.systemAppOrTargetAppRequest', 403)
  }

  // TODO - HANDLE PERMISSIONS BETTER
  if (tokenInfo.app_name === targetApp // target app is the same as the requestor app
    || (tokenInfo.app_name === 'info.freezr.account' && targetApp !== 'info.freezr.admin') // account has right to get non admin files
    // Add other app to app permissions here
    ) { 

    res.locals.freezr.permGiven = true
    next()
  } else {
    console.error('all other app2pp permissions to be dealt with here. not implemented yet 2025-12-13')
    return sendFailure(res, new Error('auth error - systemAppOrTargetAppRequest'), 'permissionCheckers.systemAppOrTargetAppRequest', 403)
  }
  
  // Validation passed, continue to next middleware
}

/**
 * NB - NOT CLEAR IF THIS WAS USING OLD LOGIC - REVIEW 2025-12-15 - 
 * Middleware to check if the requestor app is a system app or matches the target app
 * Validates that the token's app_name matches the target_app OR is a system app
 * 
 * Allowed apps:
 * - The target app itself (tokenInfo.app_name === targetApp)
 * - info.freezr.account (system account app)
 * - info.freezr.admin (system admin app)
 * 
 * Dependencies expected from middleware chain:
 * - req.params.target_app - Target app name from route parameter
 * - res.locals.freezr.tokenInfo (from createGetAppTokenInfoFromheaderForApi) - Token information with app_name
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
export const tokenUserHasFullAppApiRights = (req, res, next) => {
  
  // Get token info from middleware
  const tokenInfo = res.locals?.freezr?.tokenInfo
  if (!tokenInfo) {
    console.error('auth error - systemAppOrTargetAppRequest 1', { tokenInfo, targetApp, requestorApp: req.params.requestor_app })
    return sendFailure(res, 'Token info not found', 'permissionCheckers.systemAppOrTargetAppRequest', 401)
  }

  const targetApp = req.params.target_app //  || tokenInfo.app_name - removed 2025-12 as this seemd dangerous - why in?
  if (!targetApp) {
    console.error('auth error - systemAppOrTargetAppRequest 2', { tokenInfo, targetApp, requestorApp: req.params.requestor_app })
    return sendFailure(res, 'No target app requested', 'permissionCheckers.systemAppOrTargetAppRequest', 401)
  }

  // TODO - HANDLE PERMISSIONS BETTER
  if (tokenInfo.app_name === targetApp // target app is the same as the requestor app
    || (tokenInfo.app_name === 'info.freezr.account' && targetApp !== 'info.freezr.admin') // account has right to get non admin files
    // Add other app to app permissions here
    ) { 

    res.locals.freezr.permGiven = true
    next()
  } else {
    console.error('all other app2pp permissions to be dealt with here. not implemented yet 2025-12-13')
    return sendFailure(res, new Error('auth error - systemAppOrTargetAppRequest'), 'permissionCheckers.systemAppOrTargetAppRequest', 403)
  }
  
  // Validation passed, continue to next middleware
}

/**
 * Middleware to check that the request is from a logged-in user using the account app
 * Validates that:
 * - tokenInfo.logged_in is true
 * - tokenInfo.app_name is 'info.freezr.account'
 * - tokenInfo.requestor_id matches req.session.logged_in_user_id
 * 
 * Dependencies expected from middleware chain:
 * - res.locals.freezr.tokenInfo (from createGetAppTokenInfoFromheaderForApi) - Token information
 * - req.session.logged_in_user_id - Logged-in user ID from session
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
export const isLoggedInAccountAppRequest = (req, res, next) => {
  // Get token info from middleware
  const tokenInfo = res.locals?.freezr?.tokenInfo
  if (!tokenInfo) {
    return sendFailure(res, 'Token info not found', 'permissionCheckers.isLoggedInAccountAppRequest', 401)
  }

  // Check that token is for a logged-in user
  if (!tokenInfo.logged_in) {
    return sendFailure(res, 'Token is not for a logged-in user', 'permissionCheckers.isLoggedInAccountAppRequest', 401)
  }

  // Check that the app is the account app
  if (tokenInfo.app_name !== 'info.freezr.account') {
    return sendFailure(res, 'Request must be from account app', 'permissionCheckers.isLoggedInAccountAppRequest', 403)
  }

  // Get logged-in user ID from session
  const loggedInUserId = req.session?.logged_in_user_id
  if (!loggedInUserId) {
    return sendFailure(res, 'User not logged in', 'permissionCheckers.isLoggedInAccountAppRequest', 401)
  }

  // Check that token's user_id matches the logged-in user ID
  if (tokenInfo.requestor_id !== loggedInUserId) { //user_id??
    console.warn('❌ auth error - user ID mismatch', { tokenInfo, loggedInUserId })
    return sendFailure(res, new Error('auth error - user ID mismatch'), 'permissionCheckers.isLoggedInAccountAppRequest', 403)
  }

  res.locals.freezr.permGiven = true
  // Validation passed, continue to next middleware
  next()
}

/**
 * Middleware to check that the request is from a logged-in user using the account or admin apps
 * Validates that:
 * - tokenInfo.logged_in is true
 * - tokenInfo.app_name is 'info.freezr.account'
 * - tokenInfo.requestor_id matches req.session.logged_in_user_id
 * 
 * Dependencies expected from middleware chain:
 * - res.locals.freezr.tokenInfo (from createGetAppTokenInfoFromheaderForApi) - Token information
 * - req.session.logged_in_user_id - Logged-in user ID from session
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
export const isLoggedInAccountorAdminAppRequest = (req, res, next) => {
  // Get token info from middleware
  const tokenInfo = res.locals?.freezr?.tokenInfo
  if (!tokenInfo) {
    return sendFailure(res, 'Token info not found', 'permissionCheckers.isLoggedInAccountAppRequest', 401)
  }

  // Check that token is for a logged-in user
  if (!tokenInfo.logged_in) {
    return sendFailure(res, 'Token is not for a logged-in user', 'permissionCheckers.isLoggedInAccountAppRequest', 401)
  }

  // Check that the app is the account app
  if (tokenInfo.app_name !== 'info.freezr.account' && tokenInfo.app_name !== 'info.freezr.admin') {
    return sendFailure(res, 'Request must be from account app', 'permissionCheckers.isLoggedInAccountAppRequest', 403)
  }

  // Get logged-in user ID from session
  const loggedInUserId = req.session?.logged_in_user_id
  if (!loggedInUserId) {
    return sendFailure(res, 'User not logged in', 'permissionCheckers.isLoggedInAccountAppRequest', 401)
  }

  // Check that token's user_id matches the logged-in user ID
  if (tokenInfo.requestor_id !== loggedInUserId) { //user_id??
    console.warn('❌ auth error - user ID mismatch', { tokenInfo, loggedInUserId })
    return sendFailure(res, new Error('auth error - user ID mismatch'), 'permissionCheckers.isLoggedInAccountAppRequest', 403)
  }

  res.locals.freezr.permGiven = true
  // Validation passed, continue to next middleware
  next()
}

export const noCheckNeeded = (req, res, next) => {
  if (!res.locals.freezr) res.locals.freezr = {}
  // console.log('🔐 noCheckNeeded - setting permGiven to true', { reslocalsfreezr: res.locals.freezr })
  res.locals.freezr.permGiven = true
  // for login and log out
  if (!res.locals.freezr.tokenInfo) res.locals.freezr.tokenInfo = {app_name: 'info.freezr.account'}
  next()
}


export const tokenUserHasAppTableRights = (tokenInfo, tableId) => {
  if (!tokenInfo) {
    return false
  }
  const userIsOwner = tokenInfo.data_owner_id === tokenInfo.requestor_id 
  const requestorAppIsTargetApp = tokenInfo.app_name === tokenInfo.target_app


}