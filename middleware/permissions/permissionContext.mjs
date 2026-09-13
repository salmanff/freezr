// freezr.info - Modern ES6 Module - Permission Context Middleware
// Middleware for adding permission-related context to requests
// Handles permission database initialization and access

import { userPERMS_OAC, SYSTEM_PERMS } from '../../common/helpers/config.mjs'
import { startsWith, endsWith, isStorageAccessError } from '../../common/helpers/utils.mjs'
import { sendFailure } from '../../adapters/http/responses.mjs'
import { PERMISSION_TYPES_FOR_WHICH_RECORDS_ARE_MARKED } from './permissionDefinitions.mjs'
import { getAllSystemPermissionsForApp } from '../../common/helpers/systemPermissions.mjs'

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
      const userId = req.session?.logged_in_user_id
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
      if (isStorageAccessError(error)) {
        return res.status(502).json({ error: 'resource_access_error', message: 'Could not access your resources (file system or database) — your credentials may be invalid or expired. Refresh them under Account → Refresh Credentials.', fixUrl: '/account/reset' })
      }
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
        console.error('❌ data_owner_id not set in createaddOwnerPermsDb')
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
      if (isStorageAccessError(error)) {
        return res.status(502).json({ error: 'resource_access_error', message: 'Could not access the data owner\'s resources (file system or database) — their credentials may be invalid or expired.', fixUrl: '/account/reset' })
      }
      res.status(500).json({ error: 'Could not access permissions database' })
    }
  }
}


// Bob-only cross-app delegation (freezr_askapps_plan_v1.md). When the requesting user (Bob) reads
// ANOTHER user's (Alice's) data, and Bob has granted the requesting app a `delegate` permission that
// references a permission of ANOTHER of Bob's apps (e.g. an ask-app delegating to vcTracker's
// 'accessAllRecords'), this substitutes that app as the EFFECTIVE requestor_app for the owner-perms
// lookup in addRightsToTable — the app identity only, never the user. Bob stays the grantee, and the
// underlying grant (Alice→vcTracker→Bob) is still re-verified there, so the app gets exactly what Bob
// already has and nothing more. Runs only on cross-user reads; must run AFTER addDataOwnerToContext.
export const createResolveRequestorDelegates = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
    try {
      const tokenInfo = res.locals.freezr?.tokenInfo
      const requestorUserId = tokenInfo?.requestor_id
      const requestorApp = tokenInfo?.app_name
      const ownerUserId = res.locals.freezr?.data_owner_id
      const appTable = req.params.app_table

      // Only cross-user reads. Own-data uses the own_record fast path — delegation is meaningless there.
      if (!requestorUserId || !requestorApp || !ownerUserId || !appTable || requestorUserId === ownerUserId) return next()

      const permissionName = req.query?.permission_name || req.body?.permission_name || null

      const requestorPermsDb = await dsManager.getorInitDb(userPERMS_OAC(requestorUserId), { freezrPrefs })
      if (!requestorPermsDb) return next()

      const delegates = await requestorPermsDb.query({ type: 'delegate', requestor_app: requestorApp, granted: true }, {})
      if (!delegates || delegates.length === 0) return next()

      // Match a delegate whose delegate_app owns the requested table, and — if a permission_name was
      // given — whose delegate_permission matches it.
      const match = delegates.find(d =>
        d.delegate_app &&
        (appTable === d.delegate_app || startsWith(appTable, d.delegate_app + '.')) &&
        (!permissionName || permissionName === d.delegate_permission)
      )
      if (match) {
        res.locals.freezr.effectiveRequestorApp = match.delegate_app
        res.locals.freezr.effectivePermissionName = match.delegate_permission
        res.locals.freezr.delegatedViaApp = requestorApp // audit: the app that actually made the request
      }
      return next()
    } catch (error) {
      console.error('❌ Error in resolveRequestorDelegates middleware:', error)
      return next() // non-fatal: fall through to normal (non-delegated) enforcement
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
    write_all: false,
    write_own: false,
    grantedPerms: []
  }

  const requestorUserId = tokenInfo.requestor_id
  const requestorApp = tokenInfo.app_name
  const ownerUserId = res.locals.freezr?.data_owner_id
  let appTable = req.params.app_table

  // On raw-record-body routes (POST /ceps/write, PUT /ceps/update) the body is the app's record
  // data, so a data field named owner_id is NOT a control parameter and must not trip the
  // mismatch check below. (Those routes pin the data owner to the requestor via
  // addRequestorAsDataOwner — CEPS has no cross-owner writes; only the wrapped /feps routes do.)
  const bodyIsRecordData = (req.method === 'POST' && startsWith(req.originalUrl, '/ceps/write')) ||
    (req.method === 'PUT' && startsWith(req.originalUrl, '/ceps/update'))
  if (!bodyIsRecordData && req.body.owner_id && req.body.owner_id !== ownerUserId) {
    // nb added 2026-02-15 as extra orpecaution - to review if there are cases where it makese sense to allow discrepancy
    return sendFailure(res, 'owner_id mismatch', 'addRightsToTable', 401)
  }

  // Section not tested yet -  2025-12-20
  // if (!req.params) req.params = {}
  // if (!req.query) req.query = {}
  const permissionName = req.params.permission_name /* for files get */ || req.body.permission_name /* for CEPS post */ || req.query?.permission_name /* for CEPS get (same source the delegate middleware reads) */
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
    return sendFailure(res, 'Missing parameters for permissions for table operations', 'addRightsToTable', 401)
  } else if (requestorUserId === ownerUserId &&
    (appTable === requestorApp || startsWith(appTable, requestorApp + '.') || requestorApp === 'info.freezr.account')) {
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
    ((startsWith(req.originalUrl, '/ceps/query') && (req.body?.q?.app_id === requestorApp || req.body?.q?.recipient_app === requestorApp)) || // Post query
     (startsWith(req.originalUrl, '/ceps/query') && (req.query?.app_id === requestorApp || req.query?.recipient_app === requestorApp))) // get query
    && (requestorUserId === ownerUserId)) {
    // Each app can query its own messages: those it sent (app_id — the sender app, pinned to the
    // token) and those addressed to it (recipient_app — optional routing field on the envelope).
    // The query's own equality constraint is the filter. (For other app messages, a permission is required)
    res.locals.freezr.rightsToTable.can_read = true
    next()
  } else if (
    ['dev.ceps.contacts', 'dev.ceps.groups', 'dev.ceps.messages.got', 'dev.ceps.messages.sent'].includes(appTable) &&
    requestorApp === 'info.freezr.account' && 
    (requestorUserId === ownerUserId)
  ){
    res.locals.freezr.rightsToTable.can_read = true
    res.locals.freezr.rightsToTable.write_all = true
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
    // Delegation (cross-user reads only): resolveRequestorDelegates may substitute the app whose grant
    // to check — the app identity ONLY. requestorUserId (the grantee check below) is unchanged, so the
    // app can only reach data the requesting user was actually granted. See createResolveRequestorDelegates.
    const effRequestorApp = res.locals.freezr.effectiveRequestorApp || requestorApp
    const effPermissionName = res.locals.freezr.effectivePermissionName || permissionName
    const dbQuery = {
      table_id: appTable,
      requestor_app: effRequestorApp,
      granted: true
    }
    if (effPermissionName) dbQuery.name = effPermissionName // todo   2025-12-20 -> Should permission name always be stated? see forcePermName below

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

      // Layer in auto-granted system-app permissions (common/systemPermissions.json) for this table, so
      // system apps (e.g. info.freezr.creator reading the user's own dev.ceps.contacts for the ask-app
      // Share tab) don't need a user-grant dialog. Matched on table_id (+ name if the request named one);
      // these are record-marked-type-agnostic and get the same grantee/type handling below as DB perms.
      // See freezr_askapp_sharing_summary.md §3 and systemPermissions.json.
      for (const sysPerm of getAllSystemPermissionsForApp(effRequestorApp)) {
        if (sysPerm.granted && sysPerm.table_id === appTable && (!effPermissionName || sysPerm.name === effPermissionName)) {
          if (!grantedPerms.some(p => p.name === sysPerm.name && p.type === sysPerm.type)) grantedPerms.push(sysPerm)
        }
      }

      // Same-user cross-app record-marked reads: when an app reads records that ANOTHER of the same
      // user's apps shared with it (an _accessibles entry with grantee_app = this app), the permission
      // row lives under the GRANTING app's name, so the caller-keyed lookup above finds nothing. Key a
      // second lookup by (table, permission name) and layer in record-marked-type rows of other apps —
      // the same effective-requestor-app substitution the delegate middleware performs for cross-user
      // reads. Restricted to record-marked types (share_records etc.), which never grant table-wide
      // rights: the controllers still require a per-record _accessibles entry whose
      // (grantee, grantee_app ?? requestor_app) matches this caller's verified (user, app) at read time.
      if (requestorUserId === ownerUserId && effPermissionName) {
        const crossAppPerms = await permsDb.query({ table_id: appTable, name: effPermissionName, granted: true }, {})
        ;(crossAppPerms || []).forEach(p => {
          if (p.requestor_app !== effRequestorApp && PERMISSION_TYPES_FOR_WHICH_RECORDS_ARE_MARKED.includes(p.type) &&
              !grantedPerms.some(g => g.name === p.name && g.requestor_app === p.requestor_app)) {
            grantedPerms.push(p)
          }
        })
      }
      // console.log('addRightsToTable grantedPerms', { index: ['dev.ceps.messages.got', 'dev.ceps.messages.sent'].indexOf(appTable) > -1, hasceps: (startsWith(req.originalUrl, '/ceps/query') && (req.body?.q?.app_id === requestorApp)) })
      // console.log('addRightsToTable grantedPerms', { requestorApp, appTable, permissionName, requestorUserId, grantedPerms, dbQuery, permsDb: permsDb.oac.app_table, reqquery: req.query, reqbody: req.body, originalUrl: req.originalUrl, path: req.path })
      // if (!grantedPerms || grantedPerms.length === 0) {
      //   const allPerms = await permsDb.query({ requestor_app: 'cards.hiper.freezr' }, {})
      //   console.log('addRightsToTable allPerms', { allPerms })
      // }
      // Freezr has two permission access-control models (see permissionDefinitions.mjs):
      // 1. Record-marked types (share_records, message_records, upload_pages):
      //    Access is per-record via the _accessibles array on each record.
      //    The permission record just needs granted:true to enable the sharing mechanism.
      //    No grantee check here -- the controller checks _accessibles at read time.
      // 2. Table-level types (read_all, write_all, write_own, db_query):
      //    Access is controlled by the grantees array on the permission record.
      //    Must verify the requestor is in grantees before granting table-wide rights.
      grantedPerms.forEach(perm => {
        const isRecordMarkedType = PERMISSION_TYPES_FOR_WHICH_RECORDS_ARE_MARKED.includes(perm.type)

        if (!isRecordMarkedType && requestorUserId !== ownerUserId) {
          const isGrantee = perm.grantees && (
            perm.grantees.includes(requestorUserId) ||
            perm.grantees.includes('_public') ||
            perm.grantees.includes('_allUsers')
          )
          if (!isGrantee) return
        }

        res.locals.freezr.rightsToTable.grantedPerms.push(perm)

        if (perm.type === 'write_all') {
          res.locals.freezr.rightsToTable.write_all = true
        } else if (perm.type === 'write_own') {
          res.locals.freezr.rightsToTable.write_own = true
        } else if (perm.type === 'read_all') {
          res.locals.freezr.rightsToTable.can_read = true
        } else if (perm.type === 'share_records') {
          res.locals.freezr.rightsToTable.share_records = true
        }
      })
      // console.log('addRightsToTable rightsToTable', { appTable,requestorApp, ownerUserId, requestorUserId, originalUrl: req.originalUrl, path: req.path, query: req.query, params: req.params, rightsToTable: res.locals.freezr.rightsToTable })
      next()
    } catch (error) {
      console.error('❌ Error in addRightsToTable:', error)
      return sendFailure(res, error, 'addRightsToTable', 500)
    }
  }
}