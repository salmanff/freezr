// freezr.info - Modern ES6 Module - Permission Handlers
// HTTP request handlers for permission-related endpoints
// Modernized version of account_handler.allRequestorAppPermissions

import { sendApiSuccess, sendFailure } from '../../adapters/http/responses.mjs'
// import { groupPermissions } from './permissionCore.mjs'

/**
 * Get all permissions for a requestor app
 * Modernized version of account_handler.allRequestorAppPermissions
 *
 * Dependencies expected from middleware chain:
 * - req.params.target_app - App name to get permissions for
 * - req.query.groupall - Optional query parameter to group permissions
 * - res.locals.freezr.tokenInfo (from createGetAppTokenInfoFromheaderForApi) - Token information with app_name
 * - res.locals.freezr.ownerPermsDb (from createAddOwnerPermsDbForLoggedInuser) - User permissions database
 *
 * Optional internal call forwarding:
 * - req.freezrIntermediateCallFwd - Callback for intermediate forwarding
 * - req.freezrInternalCallFwd - Callback for internal forwarding
 */
export const allRequestorAppPermissions = async (req, res) => {
  try {
    // console.log('🔐 allRequestorAppPermissions called')
    
    const targetApp = req.params.target_app
    // console.log('🔐 Target app:', targetApp, 'target_app:', req.params.target_app)

    if (!targetApp || targetApp === 'info.freezr.account' || targetApp === 'info.freezr.admin') {
      // console.log('🔐 account or admin need to request a real app', { targetApp, tokenInfo })
      // this can be mdofied to send a fake manifest if needed
      return sendFailure(res, 'No real target app requested', 'permissionHandlers.allRequestorAppPermissions', 401)
    }
    
    // Get permissions database from middleware
    const ownerPermsDb = res.locals?.freezr?.ownerPermsDb
    if (!ownerPermsDb) {
      return sendFailure(res, 'User permissions database not available in allRequestorAppPermissions', 'permissionHandlers.allRequestorAppPermissions', 500)
    }
    
    // Query permissions for the requestor app (excluding removed ones)
    const returnPerms = await ownerPermsDb.query(
      { requestor_app: targetApp, status: { $ne: 'removed' } },
      {}
    )
    
    // console.log('🔐 allRequestorAppPermissions query result:', { targetApp, count: returnPerms?.length })
    
    // Deprecated - now done on client side in AppSettings.js - Check if grouping is requested when there's an internal call forward
    const shouldGroup = false // req.query?.groupall || req.freezrIntermediateCallFwd || req.freezrInternalCallFwd
    
    if (shouldGroup) { // no longer used
      // const ret = {}
      // ret[targetApp] = groupPermissions(returnPerms, targetApp)
      // ret[targetApp].app_name = '' // todo get app name and display name [later: why blank?]
      // ret[targetApp].app_display_name = targetApp
      
      // // Handle internal call forwarding
      // if (req.freezrIntermediateCallFwd) {
      //   console.warn('⚠️ Have req.freezrIntermediateCallFwd - this is the old system - need to put into res.locals or other')
      //   // req.freezrIntermediateCallFwd(null, ret)
      //   // return // Don't send response, callback handles it
      // } else if (req.freezrInternalCallFwd) {
      //   console.warn('⚠️ Have req.freezrInternalCallFwd - this is the old system - need to put into res.locals or other')
      //   // req.freezrInternalCallFwd(null, ret)
      //   // return // Don't send response, callback handles it
      // } else {
      //   console.log('✅ allRequestorAppPermissions completed successfully (grouped)') 
      // }
      
      // // Normal response with grouped permissions
      // return sendApiSuccess(res, ret)
      
    } else {
      // Return permissions as-is (not grouped)
      // console.log('✅ allRequestorAppPermissions completed successfully (ungrouped)')
      return sendApiSuccess(res, returnPerms)
    }
    
  } catch (error) {
    console.error('❌ Error in allRequestorAppPermissions:', error)
    return sendFailure(res, error, 'permissionHandlers.allRequestorAppPermissions', 500)
  }
}

export const currentAppPermissions = async (req, res) => {
  try {
    // console.log('🔐 allRequestorAppPermissions called')
    
    const targetApp = res.locals?.freezr?.tokenInfo?.app_name
    // console.log('🔐 Target app:', targetApp)

    if (!targetApp) {
      return sendFailure(res, 'No real target app requested', 'permissionHandlers.currentAppPermissions', 401)
    }
    
    // Get permissions database from middleware
    const ownerPermsDb = res.locals.freezr.ownerPermsDb
    if (!ownerPermsDb) {
      console.error('❌ Error in currentAppPermissions:', { localsfreezr: res.locals.freezr })
      return sendFailure(res, 'User permissions database not available for current', 'permissionHandlers.currentAppPermissions', 500)
    }
    
    // Query permissions for the requestor app (excluding removed ones)
    const returnPerms = await ownerPermsDb.query(
      { requestor_app: targetApp, status: { $ne: 'removed' } },
      {}
    )
    res.locals.freezr.permGiven = true
    return sendApiSuccess(res, returnPerms)
  } catch (error) {
    console.error('❌ Error in allRequestorAppPermissions:', error)
    return sendFailure(res, error, 'permissionHandlers.allRequestorAppPermissions', 500)
  }
}
