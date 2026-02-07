// freezr.info - Modern ES6 Module - Public Context Middleware
// Middleware for handling public (no-cookie) routes
// Sets up public databases and context in res.locals.freezr

import { 
  PUBLIC_RECORDS_OAC,
  PUBLIC_MANIFESTS_OAC,
  PRIVATE_FEED_OAC,
  userPERMS_OAC
} from '../../../common/helpers/config.mjs'
import { sendFailure } from '../../../adapters/http/responses.mjs'
import { createBaseFreezrContextForResLocals } from '../../../common/helpers/context.mjs'
import { endsWith } from '../../../common/helpers/utils.mjs'
import { isSystemApp } from '../../../common/helpers/config.mjs'

/**
 * Middleware to add public records databases
 * Gets public records DB, private feed DB, and public manifests DB
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @returns {Function} Express middleware function
 */
export const createAddPublicRecordsDB = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
    
    try {
      // Ensure res.locals.freezr is initialized
      if (!res.locals.freezr) {
        res.locals.freezr = createBaseFreezrContextForResLocals(req, dsManager, freezrPrefs, freezrStatus)
      }

      // Get public records database
      const publicRecordsDb = await dsManager.getorInitDb(PUBLIC_RECORDS_OAC, { freezrPrefs })
      
      if (!publicRecordsDb) {
        console.error('❌ Could not get publicRecordsDb')
        return sendFailure(res, 'Could not access public records database', 'addPublicRecordsDb', 500)
      }

      // Get private feed database (optional - wrap in try/catch)
      const userId = res.locals.freezr?.tokenInfo?.requestor_id
      let privateFeedDb = null
      try {
        privateFeedDb = await dsManager.getorInitDb(PRIVATE_FEED_OAC, { freezrPrefs })
        if (!privateFeedDb) {
          console.warn('⚠️  Could not get privateFeedDb (optional)')
        }
      } catch (error) {
        console.warn('⚠️  Error getting privateFeedDb (optional, continuing):', error.message)
        // Continue without it - it's optional
      }

      // Ensure public manifests DB is also available (may already be set by addPublicManifestsDb)
      if (!res.locals.freezr.publicManifestsDb) {
        try {
          const publicManifestsDb = await dsManager.getorInitDb(PUBLIC_MANIFESTS_OAC, { freezrPrefs })
          if (publicManifestsDb) {
            res.locals.freezr.publicManifestsDb = publicManifestsDb
          }
        } catch (error) {
          console.warn('⚠️  Error getting publicManifestsDb (optional, continuing):', error.message)
          // Continue without it - it's optional
        }
      }

      res.locals.freezr.publicRecordsDb = publicRecordsDb
      if (privateFeedDb) {
        res.locals.freezr.privateFeedDb = privateFeedDb
      }
      
      // onsole.log('✅ Public records DBs set up in res.locals.freezr, proceeding to next middleware')
      next()
      
    } catch (error) {
      console.error('❌ Error in addPublicRecordsDB middleware:', error)
      // For ENOENT errors (database doesn't exist yet), continue anyway
      if (error.code === 'ENOENT') {
        console.warn('⚠️  Database not found (ENOENT), continuing anyway')
        next()
      } else {
        sendFailure(res, error, 'addPublicRecordsDb', 500)
      }
    }
  }
}

/**
 * Middleware to add user permissions database for a specific user (from params)
 * Used for routes with user_id to check if user has made items public
 * Prevents sniffing if a user has installed an app even if they haven't made items public
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @returns {Function} Express middleware function
 */
export const createAddUserPermsDbForParamsUser = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
    try {
      const userId = req.params.user_id
      
      // Only add if user_id is in params and it's not 'public'
      if (!userId || userId === 'public') {
        return next()
      }

      // Ensure res.locals.freezr is initialized
      if (!res.locals.freezr) {
        res.locals.freezr = createBaseFreezrContextForResLocals(req, dsManager, freezrPrefs, freezrStatus)
      }

      // Get permissions database for the user from params
      const permsOac = userPERMS_OAC(userId)
      const userPermsDb = await dsManager.getorInitDb(permsOac, { freezrPrefs })

      if (!userPermsDb) {
        console.warn('⚠️  Could not get userPermsDb for user:', userId)
        // Continue without it - we'll check public records instead
        return next()
      }

      res.locals.freezr.userPermsDb = userPermsDb
      
      next()
      
    } catch (error) {
      console.error('❌ Error in addUserPermsDbForParamsUser middleware:', error)
      // Continue anyway - we'll check public records instead
      next()
    }
  }
}

/**
 * Middleware to add the user's appFS for public user files so they can be served
 * Looks up the public record and if it's a file record, sets up the user's appFS
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @returns {Function} Express middleware function
 */
export const createPrepUserDSsForPublicFiles = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
    try {
      const publicRecordsDb = res.locals.freezr?.publicRecordsDb
      
      if (!publicRecordsDb) {
        // No public records DB available -  (will be handled by controller)
        return next()
      }

      // Build public ID from the path
      const publicId = req.path.startsWith('/') ? req.path.substring(1) : req.path
      
      if (!publicId) { //  (will be handled by controller)
        return next()
      }

      // Look up the public record
      const publicRecord = await publicRecordsDb.read_by_id(publicId)
      
      if (!publicRecord) {
        // Record not found, continue anyway (will be handled by controller)
        return next()
      }

      // Store the public record and publicId in res.locals.freezr
      res.locals.freezr.publicRecord = publicRecord
      res.locals.freezr.publicid = publicId

      // onsole.log('prepUserDSsForPublicFiles middleware', { publicRecord, publicId })

      // Check if this is a file record (app_table ends with .files)
      if (endsWith(publicRecord.original_app_table, '.files')) {
        const dataOwner = publicRecord.data_owner
        const appTable = publicRecord.original_app_table
        const appName = appTable.substring(0, appTable.lastIndexOf('.'))

        // Get the user's appFS
        try {
          // onsole.log('prepUserDSsForPublicFiles middleware - getting userDS', { dataOwner, appName })
          const userDS = await dsManager.getOrSetUserDS(dataOwner, { freezrPrefs })
          const appFS = await userDS.getorInitAppFS(appName, { freezrPrefs })
          if (appFS) {
            res.locals.freezr.appFS = appFS
          } else {
            console.warn('⚠️  Could not get appFS for public file:', { dataOwner, appName })
          }
        } catch (error) {
          console.error('❌ Error in prepUserDSsForPublicFiles middleware:', error)
          // Continue anyway - controller will handle missing data
        }
      }

      next()
      
    } catch (error) {
      console.error('❌ Error in prepUserDSsForPublicFiles middleware:', error)
      // Continue anyway - controller will handle missing data
      next()
    }
  }
}

/**
 * Middleware to get manifest for public app pages
 * Gets manifest for a specific user and app from their app_list database
 * Sets manifest in res.locals.freezr
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @returns {Function} Express middleware function
 */
export const createGetPublicAppManifest = (dsManager, freezrPrefs) => {
  return async (req, res, next) => {
    try {
      const userId = req.params.user_id
      const appName = req.params.app_name
      
      if (!userId || !appName) {
        return sendFailure(res, 'User ID and app name are required', 'createGetPublicAppManifest', 400)
      }
      
      // Ensure res.locals.freezr is initialized
      if (!res.locals.freezr) {
        res.locals.freezr = createBaseFreezrContextForResLocals(req, dsManager, freezrPrefs, {})
      }
      
      // Get userDS for the specified user
      const userDS = await dsManager.getOrSetUserDS(userId, { freezrPrefs })
      
      // Get app_list database
      const appListDb = await userDS.getorInitDb(
        { app_table: 'info.freezr.account.app_list', owner: userId },
        { freezrPrefs }
      )
      
      if (!appListDb || !appListDb.query) {
        return sendFailure(res, 'Could not access app list database', 'createGetPublicAppManifest', 500)
      }
      
      // Query for the app
      const list = await appListDb.query({ app_name: appName }, {})
      
      let manifest = null
      let warnings = null
      let offThreadStatus = null
      let appInstalled = null
      let appUpdated = null
      let hasLogo = null
      
      if (!list || list.length === 0 || !list[0].manifest) {
        // No manifest found
        return sendFailure(res, 'App not found or manifest not available', 'createGetPublicAppManifest', 404)
      } else if (list.length > 1) {
        // Multiple manifests - delete older one and use newer one
        const itemToDelete = (list[0]._date_created < list[1]._date_created) ? 0 : 1
        const itemToKeep = (itemToDelete === 0) ? 1 : 0
        
        console.warn('⚠️ DOUBLE MANIFEST ERROR - deleting older one', { appName, userId })
        
        await appListDb.delete_record(list[itemToDelete]._id, {})
        
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
        targetAppName: appName,
        appName: appName,
        publicAppOwner: userId
      }
      
      next()
      
    } catch (error) {
      console.error('❌ Error in createGetPublicAppManifest middleware:', error)
      sendFailure(res, error, 'createGetPublicAppManifest', 500)
    }
  }
}

/**
 * Middleware to add appFS for public app pages
 * Gets appFS for a specific user and app
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @returns {Function} Express middleware function
 */
export const createAddPublicAppFS = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
    try {
      if (!freezrPrefs) throw new Error('‼️❌‼️ no freezrPrefs in createAddPublicAppFS')
      
      const userId = req.params.user_id
      const appName = req.params.app_name
      
      if (!userId || !appName) {
        return sendFailure(res, 'User ID and app name are required', 'createAddPublicAppFS', 400)
      }
      
      // Get userDS for the specified user
      const userDS = await dsManager.getOrSetUserDS(userId, { freezrPrefs })
      
      // Get appFS (system apps use fradmin's DS)
      const theDs = isSystemApp(appName) 
        ? dsManager.users.fradmin 
        : userDS

      const appFS = await theDs.getorInitAppFS(appName, {})
      
      // Preserve existing res.locals.freezr if it exists
      const existingFreezr = res.locals.freezr || {}
      
      res.locals.freezr = {
        ...createBaseFreezrContextForResLocals(req, dsManager, freezrPrefs, freezrStatus),
        ...existingFreezr, // Preserve existing properties (like manifest)
        appFS
      }
      
      next()
      
    } catch (error) {
      console.error('❌ Error in createAddPublicAppFS middleware:', error)
      sendFailure(res, error, 'createAddPublicAppFS', 500)
    }
  }
}

