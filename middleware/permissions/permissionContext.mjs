// freezr.info - Modern ES6 Module - Permission Context Middleware
// Middleware for adding permission-related context to requests
// Handles permission database initialization and access

import { userPERMS_OAC, SYSTEM_PERMS } from '../../common/helpers/config.mjs' 
import { startsWith, endsWith } from '../../common/helpers/utils.mjs'
import { sendFailure } from '../../adapters/http/responses.mjs'

/**
 * Middleware factory to add user permissions database to res.locals
 * Gets or initializes the user permissions database for the logged-in user
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @returns {Function} Express middleware function
 */
export const createAddOwnerPermsDbForLoggedInuser = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
    // onsole.log('🔐 addOwnerPermsDb middleware called')
    
    try {
      const userId = req.session.logged_in_user_id
      if (!userId) {
        return res.status(401).json({ error: 'User not logged in' })
      }

      // Get permissions database
      const permsOac = userPERMS_OAC(userId)
      const ownerPermsDb = await dsManager.getorInitDb(permsOac, { freezrPrefs })

      if (!ownerPermsDb) {
        console.error('❌ Could not get ownerPermsDb')
        return res.status(500).json({ error: 'Could not access permissions database' })
      }

      res.locals.freezr.ownerPermsDb = ownerPermsDb
      
      // onsole.log('✅ User permissions DB set up in res.locals.freezr, proceeding to next middleware')
      next()
      
    } catch (error) {
      console.error('❌ Error in addOwnerPermsDb middleware:', error)
      res.status(500).json({ error: 'Could not access permissions database' })
    }
  }
}


/**
 * Middleware factory to add user permissions database to res.locals
 * Gets or initializes the user permissions database for the logged-in user
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @returns {Function} Express middleware function
 */
export const createaddOwnerPermsDb = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
    // onsole.log('🔐 addOwnerPermsDb middleware called')
    // addDataOwnerToContext must have been called
    
    try {
      const dataOwnerId = res.locals.freezr?.data_owner_id // || res.locals.freezr?.tokenInfo?.requestor_id
      if (!dataOwnerId) {
        return sendFailure(res, 'data_owner_user not set')
      }

      // Get permissions database
      const permsOac = userPERMS_OAC(dataOwnerId)
      const ownerPermsDb = await dsManager.getorInitDb(permsOac, { freezrPrefs })

      if (!ownerPermsDb) {
        console.error('❌ Could not get ownerPermsDb')
        return res.status(500).json({ error: 'Could not access permissions database' })
      }

      res.locals.freezr.ownerPermsDb = ownerPermsDb
      
      // onsole.log('✅ owner permissions DB set up in res.locals.freezr, proceeding to next middleware')
      next()
      
    } catch (error) {
      console.error('❌ Error in ownerPermsDb middleware:', error)
      res.status(500).json({ error: 'Could not access permissions database' })
    }
  }
}


export const addRightsToTable = async (req, res, next) => {
  // console.log('addRightsToTable req', { bodt: req.body, query: req.query, params: req.params })

  const tokenInfo = res.locals.freezr?.tokenInfo

  if (!tokenInfo) {
    return res.status(401).json({ error: 'Token info not found' })
  }

  res.locals.freezr.rightsToTable = {
    own_record: false,
    can_read: false,
    // read_all: false,
    share_records: false,
    can_write: false,
    write_own: false,
    grantedPerms: []
  }

  const requestorUserId = tokenInfo.requestor_id
  const requestorApp = tokenInfo.app_name
  const ownerUserId = res.locals.freezr?.data_owner_id
  const appTable = req.params.app_table

  // Section not tested yet -  2025-12-20
  // if (!req.params) req.params = {}
  // if (!req.query) req.query = {}
  const permissionName = req.params.permission_name /* for files get */ || req.body.permission_name /* for CEPS get */
  const requestFile = startsWith(req.path, '/feps/getuserfiletoken') || startsWith(req.path, '/feps/upload/')// /feps/getuserfiletoken
  if (requestFile) {
    appTable = req.params.app_name + '.files'
    // freezrAttributes.owner_user_id = req.params.user_id // 2025 -> to check 
  }
  // // for admin
  // if (req.body.appName === 'info.freezr.admin' && req.session.logged_in_as_admin && helpers.SYSTEM_ADMIN_APPTABLES.indexOf(req.params.app_table.replace(/\./g, '_')) > -1) freezrAttributes.requestor_user_id = 'fradmin'
  // // todo - clean up so the permissions are more structures (2023) - also on readpremissions in app_handler
  // if (req.session.logged_in_as_admin && helpers.SYSTEM_ADMIN_APPTABLES.indexOf(req.params.app_table.replace(/\./g, '_')) > -1) freezrAttributes.owner_user_id = 'fradmin'
  
  if (!appTable || !ownerUserId || !requestorApp || !requestorUserId) {
    console.error('Missing parameters for permissions for table operations', { appTable, ownerUserId, requestorApp, requestorUserId })
    sendFailure(res, 'Missing parameters for permissions for table operations', 'addRightsToTable', 401)
  } else if (requestorUserId === ownerUserId && 
    (startsWith(appTable, requestorApp) || requestorApp === 'info.freezr.account')) {
    res.locals.freezr.rightsToTable.own_record = true
    next()
  // not tested yet - accounts query done under accounts?? 2025-12-20
  // } else if (
  //   (startsWith(req.path, '/ceps/query') || startsWith(req.path, '/ceps/query') || startsWith(req.path, '/ceps/read') || startsWith(req.params.app_table, 'dev.ceps')) &&
  //   (req.freezrTokenInfo.app_name === 'info.freezr.account' || req.freezrTokenInfo.requestor_app === 'info.freezr.account') && req.session.logged_in_user_id === freezrAttributes.owner_user_id &&
  //   (req.body.appName || startsWith(req.params.app_table, 'dev.ceps'))) {
  //   // backuprequest: special case for query from accounts folder for "view or backup data"
  //   freezrAttributes.actualRequester = 'info.freezr.account'
  //   freezrAttributes.requestor_app = req.body.appName || req.params.app_table // eithr query or aq ceps.dev
  //   freezrAttributes.own_record = true
  //   freezrAttributes.record_is_permitted = true
  //   console.log('own record - backuprequest: special case for query from accounts folder for "view or backup data"')
  //   getDbTobeRead()
  } else if (['dev.ceps.messages.got', 'dev.ceps.messages.sent'].indexOf(appTable) > -1 &&
    ((startsWith(req.originalUrl, '/ceps/query') && (req.body?.q?.app_id === requestorApp)) || // Post query
     (startsWith(req.originalUrl, '/ceps/query') && req.query?.app_id === requestorApp)) // get query
    && (requestorUserId === ownerUserId)) {
    // Each app can query its own messages. (For other app messages, a permission is required)
    res.locals.freezr.rightsToTable.can_read = true
    next()
  } else if (
    ['dev.ceps.contacts', 'dev.ceps.groups', 'dev.ceps.messages.got', 'dev.ceps.messages.sent'].includes(appTable) &&
    requestorApp === 'info.freezr.account' && 
    (requestorUserId === ownerUserId)
  ){
    res.locals.freezr.rightsToTable.can_read = true
    res.locals.freezr.rightsToTable.can_write = true
    next()
  } else if (['dev.ceps.privatefeeds.codes'].indexOf(appTable) > -1 && 
      requestorApp === 'info.freezr.account' && 
      ownerUserId === 'public') {
    res.locals.freezr.rightsToTable.write_own = true
    if ('dev.ceps.privatefeeds.codes' === appTable) res.locals.freezr.rightsToTable.grantedPerms = [SYSTEM_PERMS.privateCodes]
    next()
  } else if (appTable === 'info.freezr.public.public_records' && ownerUserId === 'public' && requestorApp === 'info.freezr.account'){
    res.locals.freezr.rightsToTable.write_own_inner = true
    res.locals.freezr.rightsToTable.grantedPerms = [SYSTEM_PERMS.writeOwnPublicRecords]
    next()
  } else {
    const dbQuery = {
      table_id: appTable,
      requestor_app: requestorApp,
      granted: true
    }
    if (permissionName) dbQuery.name = permissionName // todo   2025-12-20 -> Should permission name always be stated? see forcePermName below

    // Section not tested yet -  2025-12-20 - needed?
    // if (freezrAttributes.owner_user_id === 'public') {
    //   freezrAttributes.grantedPerms = []
    //   SYSTEM_PERMS.forEach(sysPerm => {
    //     if (appTable === sysPerm.table_id && (!sysPerm.requestor_app || sysPerm.requestor_app === freezrAttributes.requestor_app)) freezrAttributes.grantedPerms.push(sysPerm)
    //   })
    //   getDbTobeRead()
    // } else {

    try {
      const permsDb = res.locals.freezr.ownerPermsDb || res.locals.freezr.ownerPermsDb
      const grantedPerms = await permsDb.query(dbQuery, {})
      // console.log('addRightsToTable grantedPerms', { index: ['dev.ceps.messages.got', 'dev.ceps.messages.sent'].indexOf(appTable) > -1, hasceps: (startsWith(req.originalUrl, '/ceps/query') && (req.body?.q?.app_id === requestorApp)) })
      // console.log('addRightsToTable grantedPerms', { requestorApp, appTable, permissionName, requestorUserId, grantedPerms, dbQuery, permsDb: permsDb.oac.app_table, reqquery: req.query, reqbody: req.body, originalUrl: req.originalUrl, path: req.path })
      // if (!grantedPerms || grantedPerms.length === 0) {
      //   const allPerms = await permsDb.query({ requestor_app: 'cards.hiper.freezr' }, {})
      //   console.log('addRightsToTable allPerms', { allPerms })
      // }
      res.locals.freezr.rightsToTable.grantedPerms = grantedPerms
      grantedPerms.forEach(perm => {
        // if (
        //     perm.grantees.includes(requestorUserId) ||
        //     perm.grantees.includes('_public') || // console.log: todo: || includes valid group names [2021 - groups]
        //     perm.grantees.includes('_allUsers')
        // ) {
          // if (perm.name === permissionName || !forcePermName) { //  || // todo   2025-12-20 -> Should forcePermName be used?
            // res.locals.freezr.rightsToTable.grantedPerms.push(perm)
        if (perm.type === 'write_all') {
          res.locals.freezr.rightsToTable.can_write = true
        } else if (perm.type === 'write_own') {
          res.locals.freezr.rightsToTable.write_own = true // ie need to find record to determine if can write
        } else if (perm.type === 'read_all') {
          res.locals.freezr.rightsToTable.can_read = true
        } else if (perm.type === 'share_records') {
          res.locals.freezr.rightsToTable.share_records = true // ie need to find record to determine if it has been shared
        }
          // }
        // }
      })
      // console.log('addRightsToTable rightsToTable', { appTable,requestorApp, ownerUserId, requestorUserId, originalUrl: req.originalUrl, path: req.path, query: req.query, params: req.params, rightsToTable: res.locals.freezr.rightsToTable })
      next()
    } catch (error) {
      console.error('❌ Error in addRightsToTable:', error)
      sendFailure(res, error, 'addRightsToTable', 500)
    }
  }
}