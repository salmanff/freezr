// freezr.info - Modern ES6 Module - OAuth Context Middleware
// Middleware for handling OAuth-specific context and data loading

import { sendFailure, sendAuthFailure } from '../../../adapters/http/responses.mjs'
import { createBaseFreezrContextForResLocals } from '../../../common/helpers/context.mjs'

/**
 * OAuth database collection configuration
 */
export const OAUTH_DB_OAC = {
  app_name: 'info.freezr.admin',
  collection_name: 'oauthors',
  owner: 'fradmin'
}

/**
 * Middleware to add OAuth database to res.locals
 * Gets the oauthors collection from fradmin's data store
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @returns {Function} Express middleware function
 */
export const createAddOauthDb = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
    try {
      // Get or initialize the oauthors database
      const oauthorDb = await dsManager.getorInitDb(OAUTH_DB_OAC, { freezrPrefs })
      
      // Ensure res.locals.freezr exists
      if (!res.locals.freezr) {
        res.locals.freezr = createBaseFreezrContextForResLocals(req, dsManager, freezrPrefs, freezrStatus)
      }
      
      res.locals.freezr.oauthorDb = oauthorDb
      
      next()
    } catch (error) {
      console.error('❌ Error in createAddOauthDb middleware:', error)
      sendFailure(res, error, 'createAddOauthDb', 500)
    }
  }
}

/**
 * Combined middleware to add cache manager
 * cache manager only used for publicApiActions
 * 
 * @param {Object} dsManager - Data store manager (provides cacheManager)
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @returns {Function} Express middleware function
 */
export const createAddCacheManager = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
    try {
      // Ensure res.locals.freezr exists
      if (!res.locals.freezr) {
        res.locals.freezr = createBaseFreezrContextForResLocals(req, dsManager, freezrPrefs, freezrStatus)
      }

      // 
      res.locals.freezr.cacheManager = dsManager.cacheManager
      
      next()
    } catch (error) {
      console.error('❌ Error in createAddCacheManager middleware:', error)
      sendFailure(res, error, 'createAddCacheManager', 500)
    }
  }
}

export default {
  createAddOauthDb,
  createAddCacheManager,
  OAUTH_DB_OAC
}
