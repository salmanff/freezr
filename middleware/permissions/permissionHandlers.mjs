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
  // SECURITY: this endpoint must "fail closed". On ANY problem (missing app/db,
  // cross-host requestor, query error) it returns an empty list rather than an
  // error, so outsiders cannot probe for the existence of permissions. All
  // failures are logged server-side for diagnostics.
  try {
    // onsole.log('🔐 currentAppPermissions called')

    const targetApp = res.locals?.freezr?.tokenInfo?.app_name
    // console.log('🔐 Target app:', targetApp)

    if (!targetApp) {
      console.warn('⚠️ currentAppPermissions: no target app - returning []')
      return sendApiSuccess(res, [])
    }

    // Get permissions database from middleware
    const ownerPermsDb = res.locals.freezr.ownerPermsDb
    if (!ownerPermsDb) {
      console.error('❌ currentAppPermissions: no ownerPermsDb - returning []', { localsfreezr: res.locals.freezr })
      return sendApiSuccess(res, [])
    }

    const requestorId = res.locals.freezr?.tokenInfo?.requestor_id
    const dataOwnerId = res.locals.freezr?.data_owner_id
    const isOwnPerms = !dataOwnerId || dataOwnerId === requestorId

    // Cross-host grantee matching is not yet implemented. Until it is, a
    // cross-host requestor asking for another user's perms gets [] (fail closed).
    if (!isOwnPerms && requestorId && requestorId.includes('@')) {
      console.warn('⚠️ currentAppPermissions: cross-host requestor not yet supported - returning []', { requestorId, dataOwnerId })
      res.locals.freezr.permGiven = true
      return sendApiSuccess(res, [])
    }

    // Query permissions for the requestor app (excluding removed ones)
    let returnPerms = await ownerPermsDb.query(
      { requestor_app: targetApp, status: { $ne: 'removed' } },
      {}
    )

    // When querying another user's (the owner's) permissions DB, only return
    // permissions where the requestor is a grantee, and hide the co-grantees.
    // Without this the endpoint would leak the owner's full grant list (incl.
    // other grantees) to any requestor.
    if (!isOwnPerms) {
      // grantees are stored dot-normalized (see shareRecords)
      const granteeKey = (requestorId || '').replace(/\./g, '_')
      returnPerms = (returnPerms || [])
        .filter(p => Array.isArray(p.grantees) && p.grantees.includes(granteeKey))
        .map(p => {
          const { grantees, ...rest } = p
          return rest
        })
    }

    res.locals.freezr.permGiven = true
    return sendApiSuccess(res, returnPerms)
  } catch (error) {
    // Fail closed - never surface the error to the caller.
    console.error('❌ Error in currentAppPermissions - returning []:', error)
    return sendApiSuccess(res, [])
  }
}
