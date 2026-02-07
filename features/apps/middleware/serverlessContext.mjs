// freezr.info - Modern ES6 Module - Serverless Context Middleware - serverlessContext.mjs
// Middleware for serverless-related context data
// Separated from appContext.mjs for better organization

import { sendFailure } from '../../../adapters/http/responses.mjs'
import { isSystemApp } from '../../../common/helpers/config.mjs'

/**
 * Middleware to check microservice permissions and set up context
 * Modernized from perm_handler.js microservicePerms
 * 
 * Sets up:
 * - tokenInfo (from previous middleware)
 * - userDS with slParams (serverless params)
 * - freezrDbs (if read_collection_name is specified)
 * - permission (the granted permission record)
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @param {Object} serverlessModule - The serverless module (for LOCAL_FUNCTIONS and ADMIN_FUNCTIONS)
 * @returns {Function} Express middleware function
 */
export const createServerlessPerms = (dsManager, freezrPrefs, freezrStatus, serverlessModule) => {
  return async (req, res, next) => {
    try {
      const tokenInfo = res.locals.freezr?.tokenInfo
      if (!tokenInfo) {
        return sendFailure(res, 'Token info not available', 'createServerlessPerms', 401)
      }

      const requestorApp = tokenInfo.app_name
      const requestorUserId = tokenInfo.requestor_id
      const ownerUserId = requestorUserId
      const permissionName = req.body?.permission_name

      // For local creation functions, check admin rights
      if (!req.session.logged_in_as_admin && serverlessModule.ADMIN_FUNCTIONS.includes(req.params.task)) {
        return sendFailure(res, 'Uploading serverless can only be done by admin users', 'createServerlessPerms', 403)
      }

      // For all functions, check permissions
      // Note still need to make sure appropriate permission has been granted

      const permQuery = {
        requestor_app: requestorApp,
        granted: true,
        name: permissionName
      }

      const permDb = await dsManager.getorInitDb(
        { app_table: 'info.freezr.account.permissions', owner: ownerUserId },
        { freezrPrefs }
      )

      if (!permDb) {
        return sendFailure(res, 'Could not access permissions database', 'createServerlessPerms', 500)
      }

      const perms = await permDb.query(permQuery, {})
      if (!perms || perms.length === 0) {
        if (serverlessModule.ADMIN_FUNCTIONS.includes(req.params.task) && requestorApp === 'info.freezr.admin' && req.session.logged_in_as_admin) {
          console.log('okay for admin to upsert localservice', { permissionName, requestorApp, ownerUserId })
        } else {
          // const allPerms = await permDb.query({}, {})
          console.warn('No permission found for serverless function', { permissionName, requestorApp, ownerUserId })
          return sendFailure(res, 'No permission found for serverless function', 'createServerlessPerms', 403)
        }
      } else {
        res.locals.freezr.permission = perms[0]
        res.locals.freezr.functionName = perms[0].function_name || permissionName
      }
      // Get userDS with slParams
      const userDS = await dsManager.getOrSetUserDS(ownerUserId, { freezrPrefs })
      if (!userDS) {
        // this may not be necessary for some function but it indicates an error of sorts so might as well get it
        return sendFailure(res, 'Could not get user data store', 'createServerlessPerms', 500)
      }

      if (serverlessModule.CLOUD_FUNCTIONS.includes(req.params.task)) {
        // Add slParams to userDS if not already present (from getUserSlParams)
        if (!userDS.slParams) {
          try {
            userDS.slParams = await dsManager.getUserSlParams(ownerUserId, { freezrPrefs })
          } catch (e) {
            return sendFailure(res, 'Cloud serverless functions need sl Params', 'createServerlessPerms', 500)
          }
        }
      }

      // Handle database reads if requested
      // currently can only read own collections - rather than other apps' collections
      let freezrDbs = null
      if (req.body.read_collection_name) {
        freezrDbs = {}
        const appTableName = requestorApp + '.' + req.body.read_collection_name
        try {
          freezrDbs[req.body.read_collection_name] = await dsManager.getorInitDb(
            { app_table: appTableName, owner: ownerUserId },
            { freezrPrefs }
          )
        } catch (e) {
          console.warn('Could not get db for read_collection_name:', req.body.read_collection_name, e)
        }
      }

      // Preserve existing res.locals.freezr and add new properties
      res.locals.freezr = {
        ...res.locals.freezr,
        userDS,
        freezrDbs,
        tokenInfo: {
          ...tokenInfo,
          permission_name: permissionName
        }
      }

      next()

    } catch (error) {
      console.error('❌ Error in createServerlessPerms middleware:', error)
      return sendFailure(res, error, 'createServerlessPerms', 500)
    }
  }
}

/**
 * Middleware to add app file system for serverless functions
 * Gets appFS for the requestor app from token
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @returns {Function} Express middleware function
 */
export const createAddAppFsFor3PFunctions = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
    try {
      const tokenInfo = res.locals.freezr?.tokenInfo
      if (!tokenInfo) {
        return sendFailure(res, 'Token info not available', 'createAddAppFsFor3PFunctions', 401)
      }

      const ownerUserId = tokenInfo.requestor_id
      const appName = tokenInfo.app_name

      // Get appFS
      const userDS = res.locals.freezr.userDS || await dsManager.getOrSetUserDS(ownerUserId, { freezrPrefs })

      const appFS = await userDS.getorInitAppFS(appName, {})

      if (!appFS) {
        return sendFailure(res, 'Could not get app file system', 'createAddAppFsFor3PFunctions', 500)
      }

      res.locals.freezr = {
        ...res.locals.freezr,
        appFS
      }

      next()

    } catch (error) {
      console.error('❌ Error in createAddAppFsFor3PFunctions middleware:', error)
      return sendFailure(res, error, 'createAddAppFsFor3PFunctions', 500)
    }
  }
}

/**
 * Middleware to add public serverless functions file system (for admin local functions)
 * Only adds thirdPartyFunctionsFS for LOCAL_FUNCTIONS
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @param {Object} serverlessModule - The serverless functions module (for LOCAL_FUNCTIONS)
 * @returns {Function} Express middleware function
 */
export const createAdd3PFunctionFS = (dsManager, freezrPrefs, freezrStatus, serverlessModule) => {
  return async (req, res, next) => {
    try {
      // Only add public serverless functions FS for local functions
      if (!serverlessModule.LOCAL_FUNCTIONS.includes(req.params.task)) {
        return next()
      }

      // Must be admin to install public serverless functions FS
      if (!req.session.logged_in_as_admin) {
        return sendFailure(res, 'Cannot get public FS for non-admin user', 'createAdd3PFunctionFS', 403)
      }

      const owner = 'public'
      
      // Get public userDS
      const publicUserDS = await dsManager.getOrSetUserDS(owner, { freezrPrefs })
      
      if (!publicUserDS) {
        return sendFailure(res, 'Could not get public data store', 'createAdd3PFunctionFS', 500)
      }

      // Get users_3Pfunctions appFS
      const thirdPartyFunctionsFS = await publicUserDS.getorInitAppFS('thirdPartyFunctions', {})
      
      if (!thirdPartyFunctionsFS) {
        return sendFailure(res, 'Could not get public serverless file system', 'createAdd3PFunctionFS', 500)
      }

      res.locals.freezr = {
        ...res.locals.freezr,
        thirdPartyFunctionsFS
      }

      next()

    } catch (error) {
      console.error('❌ Error in createAdd3PFunctionFS middleware:', error)
      return sendFailure(res, error, 'createAdd3PFunctionFS', 500)
    }
  }
}

export default {
  createServerlessPerms,
  createAddAppFsFor3PFunctions,
  createAdd3PFunctionFS
}

