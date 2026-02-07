// freezr.info - Modern ES6 Module - App Feature Context Middleware
// Middleware for loading app-related context data

import { sendApiSuccess, sendFailure } from '../../../adapters/http/responses.mjs'
import { isSystemApp } from '../../../common/helpers/config.mjs'
import { startsWith, endsWith } from '../../../common/helpers/utils.mjs'
import { APP_TOKEN_OAC, VALIDATION_TOKEN_OAC, userContactsOAC, userPERMS_OAC } from '../../../common/helpers/config.mjs'
import { createBaseFreezrContextForResLocals } from '../../../common/helpers/context.mjs'

/**
 * Middleware to add user app list database
 * Gets the app_list database for the user and adds it to res.locals.freezr
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @returns {Function} Express middleware function
 */
export const createAddUserAppList = (dsManager, freezrPrefs) => {
  return async (req, res, next) => {
    // console.log('📋 addUserAppList middleware called')
    
    try {
      const ownerId = res.locals.freezr?.tokenInfo?.owner_id || req.session.logged_in_user_id
      
      if (!ownerId) {
        throw new Error('User ID not found')
      }
      
      // Get app_list database
      const userAppListDb = await dsManager.getorInitDb(
        { app_table: 'info.freezr.account.app_list', owner: ownerId },
        { freezrPrefs }
      )
      
      if (!userAppListDb || !userAppListDb.query) {
        console.error('❌ Could not get userAppListDb')
        throw new Error('Could not access app list database')
      }
      
      // Preserve existing res.locals.freezr if it exists
      const existingFreezr = res.locals.freezr || {}
      
      res.locals.freezr = {
        ...existingFreezr, // Preserve tokenInfo from tokenGuard
        ...createBaseFreezrContextForResLocals(req, dsManager, freezrPrefs, {}),
        userAppListDb
      }
      
      // console.log('✅ User app list DB set up in res.locals.freezr, proceeding to next middleware')
      next()
      
    } catch (error) {

      console.error('❌ Error in addUserAppList middleware:', { url: req.originalUrl, error })
      return sendFailure(res, error, 'createAddUserAppList', 500)

    }
  }
}

/**
 * Middleware to get target manifest (modernizes getManifest from access_handler.js)
 * Gets manifest for the app specified in token or query parameter
 * Sets manifest, warnings, and offThreadStatus in res.locals.freezr
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @returns {Function} Express middleware function
 */
export const createGetTargetManifest = (dsManager, freezrPrefs) => {
  return async (req, res, next) => {
    
    try {
      const freezr = res.locals.freezr
      const tokenInfo = freezr?.tokenInfo
      
      if (!tokenInfo) {
        throw new Error('Token info not found')
      }
            
      if (!freezr?.userAppListDb) {
        res.locals.flogger.error('❌ App list database not available in res.locals.freezr - please add addUserAppList middleware via createAddUserAppList')
        return res.status(500).json({ error: 'App list database not available' })
      }
      
      // Determine app name from tokenInfo or request
      const requestedAppName = req.params.target_app // || req.body.targetApp

      if (tokenInfo.app_name !== requestedAppName && tokenInfo.app_name !== 'info.freezr.account' && tokenInfo.app_name !== 'info.freezr.admin') {
        res.locals.flogger.warn('❌ todo-modernization review if this should be permission based - ie allow others to access', { tokenInfo, requestedAppName })
        return res.status(403).json({ error: 'Unauthorized to access manofest' })
      }
      
      const ownerId = tokenInfo.owner_id
      
      const appDb = res.locals.freezr.userAppListDb
      
      // Query for the app
      res.locals.flogger.debug('📦 getTargetManifest - querying for app:', { requestedAppName })
      const list = await appDb.query({ app_name: requestedAppName }, {})
      
      let manifest = null
      let warnings = null
      let offThreadStatus = null
      let appInstalled = null
      let appUpdated = null
      let hasLogo = null
      
      if (!list || list.length === 0 || !list[0].manifest) {
        // No manifest - create blank manifest
        manifest = { identifier: requestedAppName, pages: {} }
        // onsole.log('📦 Created blank manifest for app:', requestedAppName)
      } else if (list.length > 1) {
        // Multiple manifests - delete older one and use newer one
        const itemToDelete = (list[0]._date_created < list[1]._date_created) ? 0 : 1
        const itemToKeep = (itemToDelete === 0) ? 1 : 0
        
        console.warn('⚠️ DOUBLE MANIFEST ERROR - deleting older one', { requestedAppName, ownerId })
        
        await appDb.delete_record(list[itemToDelete]._id, {})
        
        manifest = list[itemToKeep].manifest
        warnings = list[itemToKeep].warnings
        hasLogo = list[itemToKeep].hasLogo
        offThreadStatus = list[itemToKeep].offThreadStatus
      } else {
        // Single manifest - use it
        manifest = list[0].manifest
        warnings = list[0].warnings
        offThreadStatus = list[0].offThreadStatus
        appInstalled = list[0].installed
        hasLogo = list[0].hasLogo
        appUpdated = list[0].updated
      }
      
      // Preserve existing res.locals.freezr
      const existingFreezr = res.locals.freezr || {}
      
      res.locals.freezr = {
        ...existingFreezr,
        manifest,
        warnings,
        offThreadStatus,
        appInstalled,
        appUpdated,
        hasLogo,
        targetAppName: requestedAppName,
        appName: requestedAppName
      }
      
      // console.log('✅ Manifest retrieved and set in res.locals.freezr:', { requestedAppName, hasManifest: !!manifest })
      next()
      
    } catch (error) {
      console.error('❌ Error in getTargetManifest middleware:', { url: req.originalUrl, error })
      return sendFailure(res, error, 'getTargetManifest', 500)
    }
  }
}

/**
 * Middleware to add appFS for target_app only (no userDS)
 * Gets appFS for the target_app specified in req.params.target_app
 * TODO _ needs to be adapted to take in different users too
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @returns {Function} Express middleware function
 */
export const createAddTargetAppFS = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
    try {
      if (!freezrPrefs) throw new Error('‼️❌‼️ no freezrPrefs in createAddTargetAppFS')
      
      const targetAppName = req.params.target_app
      if (!targetAppName) {
        return res.status(400).json({ error: 'target_app parameter is required' })
      }
      
      const owner = req.session.logged_in_user_id
      if (!owner) {
        return res.status(401).json({ error: 'User not authenticated' })
      }
      
      // Get userDS (needed to get appFS, but we don't add it to res.locals)
      const userDS = await dsManager.getOrSetUserDS(owner, { freezrPrefs })
      
      // Get appFS (system apps use fradmin's DS)
      const theDs = isSystemApp(targetAppName) 
        ? dsManager.users.fradmin 
        : userDS

      const appFS = await theDs.getorInitAppFS(targetAppName, {})
      
      // Preserve existing res.locals.freezr if it exists (e.g., tokenInfo from tokenGuard)
      const existingFreezr = res.locals.freezr || {}
      
      res.locals.freezr = {
        ...createBaseFreezrContextForResLocals(req, dsManager, freezrPrefs, freezrStatus),
        ...existingFreezr, // Preserve existing properties (like tokenInfo)
        appFS
        // Note: userDS is NOT added here - only appFS
      }
      
      next()
      
    } catch (error) {
      console.error('❌ Error in createAddTargetAppFS middleware:', error)
      res.status(500).json({ error: 'Could not access app file system', details: error.message })
    }
  }
}


/**
 * Middleware to add system appFS for system target_app only (no userDS)
 * Gets appFS for the target_app specified in req.params.target_app
 * TODO _ needs to be adapted to take in different users too
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @returns {Function} Express middleware function
 */
export const createAddPublicSystemAppFS = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
    try {
      if (!freezrPrefs) throw new Error('‼️❌‼️ no freezrPrefs in createAddTargetAppFS')
      
      const targetAppName = req.params.target_app
      if (!isSystemApp(targetAppName)) {
        return sendFailure(res, 'Non System app not allowed', { function: 'createAddPublicSystemAppFS', targetAppName }, 403 )
      }
      if (targetAppName !== req.path.split('/')[1]) {
        // if (!res.locals.flogger) res.locals.flogger = console
        res.locals.flogger.error('❌ target app mismatch - not throwing error', { targetAppName, paramTaregtApp: req.params.target_app, path: req.path, url: req.originalUrl })
      }

      if (!dsManager.users.fradmin && !dsManager.freezrIsSetup) { 
        // only situation where fradmin is not set up is on first set up - should throw error otherwise
        dsManager.setSystemUserDS('fradmin', dsManager.initialEnvironment, { freezrPrefs })
        dsManager.setSystemUserDS('public', dsManager.initialEnvironment, { freezrPrefs })

        // const results = await dsManager.users.fradmin.getorInitDb({ app_table: 'info.freezr.admin.users', owner: 'fradmin' }, { freezrPrefs })  
        // console.log('🔄 getorInitDb - result:', results)
        // console.log('🔄 getorInitDb - fradmin set up', { fradmin: dsManager.users.fradmin })
      }
      const theDs = dsManager.users.fradmin 
      const appFS = await theDs.getorInitAppFS(targetAppName, {})
      
      // Preserve existing res.locals.freezr if it exists (e.g., tokenInfo from tokenGuard)
      const existingFreezr = res.locals.freezr || {}
      
      res.locals.freezr = {
        ...createBaseFreezrContextForResLocals(req, dsManager, freezrPrefs, freezrStatus),
        ...existingFreezr, // Preserve existing properties (like tokenInfo)
        appFS
        // Note: userDS is NOT added here - only appFS
      }
      
      next()
      
    } catch (error) {
      console.error('❌ Error in createAddTargetAppFS middleware:', error)
      res.status(500).json({ error: 'Could not access app file system', details: error.message })
    }
  }
}

/**
 * Middleware to add user data store (modernizes addUserDs)
 * Gets userDS based on token owner_id and sets it on res.locals.freezr
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @returns {Function} Express middleware function
 */
export const createAddUserDs = (dsManager, freezrPrefs) => {
  if (!freezrPrefs) throw new Error('no freezrPrefs in createAddUserDs')
  return async (req, res, next) => {
    // onsole.log('💾 addUserDs middleware called')
    
    try {
      const tokenInfo = res.locals.freezr?.tokenInfo
      if (!tokenInfo || !tokenInfo.owner_id) {
        return res.status(401).json({ error: 'Token info or owner_id not found' })
      }
      
      const owner = tokenInfo.owner_id
      
      // Get userDS
      const userDS = await dsManager.getOrSetUserDS(owner, { freezrPrefs })
      
      if (!userDS) {
        return res.status(500).json({ error: 'Could not get user data store' })
      }
      
      // Preserve existing res.locals.freezr
      const existingFreezr = res.locals.freezr || {}
      
      res.locals.freezr = {
        ...existingFreezr, // Preserve tokenInfo, manifest, etc.
        ...createBaseFreezrContextForResLocals(req, dsManager, freezrPrefs, {}),
        userDS,
        requesting_owner_id: owner
      }
      
      // console.log('✅ User DS set up in res.locals.freezr, proceeding to next middleware')
      next()
      
    } catch (error) {
      console.error('❌ Error in addUserDs middleware:', error)
      res.status(500).json({ error: 'Could not access user data store' })
    }
  }
}

/**
 * Middleware to add user data store (modernizes addUserDs)
 * Gets userDS based on token owner_id and sets it on res.locals.freezr
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @returns {Function} Express middleware function
 */
export const createAddAppTableFromBodyAndCheckTokenOwner = (dsManager, freezrPrefs) => {
  if (!freezrPrefs) throw new Error('no freezrPrefs in createAddUserDs')
  return async (req, res, next) => {
    // onsole.log('💾 addUserDs middleware called')

    const appTable = req.body.table_id

    if (!appTable) {
      return next()
    }
    
    try {
      const tokenInfo = res.locals.freezr?.tokenInfo
      if (!tokenInfo || !tokenInfo.requestor_id) {
        return sendFailure(res, 'Token info or requestor_id not found')
      }
      
      const requestorId = tokenInfo.requestor_id
      const requestorApp = tokenInfo.app_name

      if (!startsWith(appTable, requestorApp)) {
        return sendFailure(res, 'Can currently only share records for own app', 'createAddAppTableFromBodyAndCheckTokenOwner', 403)
      }

      res.locals.freezr.rightsToTable = { own_record: true }
      
      // Get userDS
      const appTableDb = await dsManager.getorInitDb({ app_table: appTable, owner: requestorId }, { freezrPrefs })
      
      if (!appTableDb) {
          return sendFailure(res, 'Could not get user data store' )
      }

      const userPrefs = await dsManager.users[requestorId].userPrefs
      if (!userPrefs) {
        return sendFailure(res, 'Could not get user prefs' )
      }

      if (endsWith(appTable, '.files')) {
        const userDS = await dsManager.getOrSetUserDS(requestorId, { freezrPrefs })
        res.locals.freezr.userAppFS = await userDS.getorInitAppFS(appTable.substring(0, appTable.lastIndexOf('.')), { freezrPrefs })
      }
      
      // Preserve existing res.locals.freezr
      const existingFreezr = res.locals.freezr || {}
      res.locals.freezr = {
        ...existingFreezr, // Preserve tokenInfo, manifest, etc.
        rightsToTable: { own_record: true },
        appTableDb,
        userPrefs,
        permGiven: true /// res.locals?.freezr?.permGiven
      }


      
      next()
      
    } catch (error) {
      console.error('❌ Error in addUserDs middleware:', error)
      res.status(500).json({ error: 'Could not access user data store' })
    }
  }
}

export const createAddStorageLimits = (dsManager, freezrPrefs) => {
  if (!freezrPrefs) throw new Error('no freezrPrefs in createAddUserDs')
  return async (req, res, next) => {
    // onsole.log('💾 addUserDs middleware called')
    
    try {
      const owner = req.session.logged_in_user_id

      if (!owner) {
        return next()
      }
      
      // Get userDS
      const userDS = await dsManager.getOrSetUserDS(owner, { freezrPrefs })
      
      if (!userDS) {
        return next()
      }
            
      res.locals.freezr = {
        ...res.locals.freezr,
        freezrStorageLimits: userDS.getUseageWarning()
      }
      
      next()
      
    } catch (error) {
      console.error('❌ Error in addUserDs middleware:', error)
      res.status(500).json({ error: 'Could not access user data store' })
    }
  }
}

/**
 * Middleware to add data owner to context - for ceps and feps
 * Either the request scpecifies a owner_id in query or bidy, or it is assumed that the tokenInfo requestor_id is getting its own
 * 
 */
export const addDataOwnerToContext = function (req, res, next) {
  const owner = req.body.owner_id || req.query.owner_id || res.locals.freezr?.tokenInfo?.owner_id
  // console.log('addDataOwnerToContext', { owner, tokenInfo: res.locals.freezr?.tokenInfo, req: req.body, query: req.query, freezr: res.locals.freezr })
  if (!owner || !res.locals.freezr?.tokenInfo) {
    return sendFailure(res, 'owner_id or tokenInfo not set')
  }
  res.locals.freezr.data_owner_id = owner
  next()
}
/**
 * Middleware to add requestor as data owner - Removes ptions of query and body to specify owner
 * 
 */
export const addRequestorAsDataOwner = function (req, res, next) {
  const owner = res.locals.freezr?.tokenInfo?.requestor_id
  // onsole.log('addDataOwnerToContext', { owner, tokenInfo: res.locals.freezr?.tokenInfo })
  if (!owner || !res.locals.freezr?.tokenInfo) {
    return sendFailure(res, 'owner_id or tokenInfo not set')
  }
  res.locals.freezr.data_owner_id = owner
  next()
}
/**
 * Middleware to convert app_name to app_table
 * 
 */
export const defineFileAppTableFromAppName = function (req, res, next) {
  const appName = req.params.app_name
  if (!appName) {
    return sendFailure(res, 'app_name not set')
  }
  req.params.app_table = appName + '.files'
  next()
}



/**
 * Handler function to get manifest and app tables
 * Modernizes getAllAppAppTablesAndSendWithManifest from app_handler.js
 * Uses async userDS functions
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const getAllAppAppTablesAndSendWithManifest = async (req, res) => {
  console.log('🔍 getAllAppAppTablesAndSendWithManifest handler called')
  
  try {
    const freezr = res.locals.freezr
    
    if (!freezr.userDS) {
      console.error('❌ No userDS found in res.locals.freezr')
      return sendFailure(res, new Error('no user data store found'), 'getAllAppAppTablesAndSendWithManifest', 500)
    }
    
    if (!freezr?.manifest) {
      console.warn('⚠️ No manifest found in res.locals.freezr')
      // return sendFailure(res, new Error('no manifest found'), 'getAllAppAppTablesAndSendWithManifest', 500)
    }
    
    const userDS = freezr.userDS
    const owner = req.session.logged_in_user_id
    const tokenInfo = freezr.tokenInfo

    if (!tokenInfo) {
      console.error('❌ No tokenInfo found in res.locals.freezr')
      return sendFailure(res, new Error('token info not found'), 'getAllAppAppTablesAndSendWithManifest', 401)
    }

    const appNameFromTokenInfoOrPath = (tokenInfo, req) => {
      // handles /feps/manifest/:target_app and /feps/manifest from the target_app
      return req.params.target_app || tokenInfo.app_name
    }

    // Determine app name from tokenInfo or request
    const requestedAppName = appNameFromTokenInfoOrPath(tokenInfo, req) // target_app
    
    if (requestedAppName !== tokenInfo.app_name && tokenInfo.app_name !== 'info.freezr.account' && tokenInfo.app_name !== 'info.freezr.admin') {
      console.error('❌ App name mismatch', { requestedAppName, tokenInfo })
      return sendFailure(res, new Error('app name mismatch'), 'getAllAppAppTablesAndSendWithManifest', 403)
    }
    
    // Get the database for the app
    const topdb = await userDS.getorInitDb(
      { owner, app_table: requestedAppName },
      { freezrPrefs: freezr.freezrPrefs }
    )
    
    if (!topdb) {
      console.error('❌ Could not get database for app:', requestedAppName)
      return sendFailure(res, new Error('could not get database for app'), 'getAllAppAppTablesAndSendWithManifest', 500)
    }
    
    // Get all app table names
    const appTables = await topdb.getAllAppTableNames(requestedAppName)
    
    // Send success response
    sendApiSuccess(res, {
      manifest: freezr.manifest,
      appInstalled: freezr.appInstalled || null,
      appUpdated: freezr.appUpdated || null,
      hasLogo: freezr.hasLogo || null,
      app_tables: appTables || [],
      warnings: freezr.warnings || null,
      offThreadStatus: freezr.offThreadStatus || null
    })
    
  } catch (error) {
    console.error('❌ Error in getAllAppAppTablesAndSendWithManifest:', error)
    sendFailure(res, error, 'getAllAppAppTablesAndSendWithManifest', 500)
  }
}

/**
 * Middleware to add public manifests database
 * Gets the public manifests database and puts it in res.locals (modern approach)
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @returns {Function} Express middleware function
 */
export const createAddAppTableDbAndFsIfNeedbe = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
    // onsole.log('📋 createAddAppTableDbAndFsIfNeedbe middleware called', { params: req.params, freezr: res.locals.freezr })
    const appTable = req.params.app_table
    const owner = res.locals.freezr?.data_owner_id

    // onsole.log('      🔑 createAddAppTableDbAndFsIfNeedbe appTable add owner', { freezr: res.locals.freezr })

    try {
      // Get app table database
      // "cannot get db without AOC"
      const appTableDb = await dsManager.getorInitDb({ app_table: appTable, owner }, { freezrPrefs })

      if (!appTableDb) {
        console.error('❌ Could not get appTableDb, ', { appTable, owner })
        return res.status(500).json({ error: 'Could not access appTable database' })
      }
            
      res.locals.freezr.appTableDb = appTableDb

      if (endsWith(appTable, '.files')) {
        const appName = appTable.substring(0, appTable.lastIndexOf('.'))
        const appFS = await dsManager.getOrInitUserAppFS(owner, appName, { freezrPrefs })
        if (!appFS) {
          console.error('❌ Could not get appFS, ', { appTable, owner })
          return res.status(500).json({ error: 'Could not access appFS' })
        }
        res.locals.freezr.appFS = appFS
      }
      
      // onsole.log('✅ Public manifests DB set up in res.locals.freezr, proceeding to next middleware')
      next()
      
    } catch (error) {
      console.error('❌ Error in createAddAppTableDbAndFsIfNeedbe middleware:', { appTable, owner,error})
      res.status(500).json({ error: 'Could not access createAddAppTableDbAndFsIfNeedbe database' })
    }
  }
}

/**
 * Middleware to add validation databases
 * Used for validation token operations (set, verify, validate)
 * Sets validation-related databases in res.locals.freezr
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @returns {Function} Express middleware function
 */
export const createAddValidationDbs = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
  // Old versions..
  // app.get('/ceps/perms/validationtoken/:action', addValidationDBs, accountHandler.CEPSValidator) // for actions validate, verify
  // app.post('/ceps/perms/validationtoken/:action', userAPIRights, addValidationDBs, accountHandler.CEPSValidator) // for action set
    
    try {
      // Ensure res.locals.freezr is initialized
      if (!res.locals.freezr) {
        res.locals.freezr = {}
      }

      if (req.params.action === 'set' || req.params.action === 'verify') {
        // onsole.log('addValidationDBs set or verify')
        const freezrValidationTokenDB = await dsManager.getorInitDb(VALIDATION_TOKEN_OAC, { freezrPrefs })
        
        if (!freezrValidationTokenDB) {
          console.error('❌ Could not access main validationTokenDB - addValidationTokenDB')
          return sendFailure(res, 'Could not access validation token database', 'createAddValidationDbs', 401)
        }
        
        res.locals.freezr.validationTokenDB = freezrValidationTokenDB
        next()
      } else if (req.params.action === 'validate') {
        const owner = req.query.data_owner_user
        if (!owner) {
          console.error('❌ No owner sent to validate')
          return sendFailure(res, 'No owner sent to validate', 'createAddValidationDbs', 401)
        }
        
        // todo - also check in system db if the person exists
        const cepsContacts = await dsManager.getorInitDb(userContactsOAC(owner), { freezrPrefs })
        
        if (!cepsContacts) {
          console.error('❌ Could not access cepsContacts - addValidationDBs')
          return sendFailure(res, 'Could not access contacts database', 'createAddValidationDbs', 401)
        }
        
        res.locals.freezr.cepsContacts = cepsContacts
        
        const freezrUserPermsDB = await dsManager.getorInitDb(userPERMS_OAC(owner), { freezrPrefs })
        
        if (!freezrUserPermsDB) {
          console.error('❌ Could not access main freezrUserPermsDB - addUserAppsAndPermDBs')
          return sendFailure(res, 'Could not access user permissions database', 'createAddValidationDbs', 401)
        }
        
        res.locals.freezr.userPermsDB = freezrUserPermsDB
        
        // VALIDATION_TOKEN_OAC used for internal verification (ie data_owner_host same as requestor_host)
        const freezrValidationTokenDB = await dsManager.getorInitDb(VALIDATION_TOKEN_OAC, { freezrPrefs })
        
        if (!freezrValidationTokenDB) {
          console.error('❌ Could not access main validationTokenDB - addValidationTokenDB')
          return sendFailure(res, 'Could not access validation token database', 'createAddValidationDbs', 401)
        }
        
        res.locals.freezr.validationTokenDB = freezrValidationTokenDB
        
        const freezrAppTokenDB = await dsManager.getorInitDb(APP_TOKEN_OAC, { freezrPrefs })
        
        if (!freezrAppTokenDB) {
          console.error('❌ Could not access main freezrAppTokenDB - addAppTokenDB')
          return sendFailure(res, 'Could not access app token database', 'createAddValidationDbs', 401)
        }
        
        res.locals.freezr.appTokenDB = freezrAppTokenDB
        next()
      } else {
        console.error('❌ Invalid validation query ', req.query)
        return sendFailure(res, 'Invalid validation query', 'createAddValidationDbs', 401)
      }
    } catch (error) {
      console.error('❌ Error in createAddValidationDbs middleware:', error)
      return sendFailure(res, error, 'createAddValidationDbs', 500)
    }
  }
}

/**
 * Middleware to add user files database and app file system for file operations
 * Gets the .files database and appFS for the app
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @returns {Function} Express middleware function
 */
export const createAddUserFilesDbAndAppFS = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
    try {
      const appName = req.params.app_name
      const owner = res.locals.freezr?.tokenInfo?.requestor_id
      
      if (!appName) {
        return sendFailure(res, 'App name is required', 'createAddUserFilesDbAndAppFS', 400)
      }
      
      if (!owner) {
        return sendFailure(res, 'Owner ID not found', 'createAddUserFilesDbAndAppFS', 401)
      }
      
      // Get userDS
      const userDS = await dsManager.getOrSetUserDS(owner, { freezrPrefs })
      
      // Get appFS - 2026-02-01 -> changed to use userDS always - no use case for fradmin files?
      // const theDs = isSystemApp(appName) 
      //   ? dsManager.users.fradmin 
      //   : userDS
      
      const appFS = await userDS.getorInitAppFS(appName, {})
      
      // req.params.app_table = req.params.app_name + '.files'
      // Get files database (app_name.files)
      const userFilesDb = await dsManager.getorInitDb({ app_table: req.params.app_name + '.files', owner }, { freezrPrefs })
      
      if (!userFilesDb || !appFS) {
        console.error('❌ Could not get userFilesDb or appFS', { appName, owner })
        return sendFailure(res, 'Could not access file system or database', 'createAddUserFilesDbAndAppFS', 500)
      }
      
      // Preserve existing res.locals.freezr
      const existingFreezr = res.locals.freezr || {}
      
      res.locals.freezr = {
        ...existingFreezr,
        userFilesDb,
        appFS,
        userAppFS: appFS //, // alias for compatibility - stll needed?
      }
      
      next()
      
    } catch (error) {
      console.error('❌ Error in createAddUserFilesDbAndAppFS middleware:', error)
      return sendFailure(res, error, 'createAddUserFilesDbAndAppFS', 500)
    }
  }
}

export default {
  createAddUserAppList,
  addDataOwnerToContext,
  defineFileAppTableFromAppName,
  createGetTargetManifest,
  createAddUserDs,
  createAddTargetAppFS,
  createAddAppTableDbAndFsIfNeedbe,
  getAllAppAppTablesAndSendWithManifest,
  createAddValidationDbs,
  createAddUserFilesDbAndAppFS
}

