// freezr.info - Modern ES6 Module - Account Feature Context
// Feature-specific middleware that sets account-related data in res.locals
// 
// Architecture: Each feature has its own context file that populates res.locals
// This keeps feature-specific logic isolated and makes it scalable

import { devAssert, devAssertType, devAssertNotNull } from '../../../middleware/devAssertions.mjs'

/**
 * Creates middleware to set public user context
 * Loads public user's app filesystem and sets in res.locals.freezr
 * Used for public account pages (login, register, etc.)
 * 
 * @param {object} dsManager - Data store manager
 * @param {object} freezrPrefs - Freezr preferences
 * @returns {function} Express middleware
 */
export const createContextForLogin = (dsManager, freezrPrefs, freezrStatus) => {
  if (!freezrPrefs) throw new Error('no freezrPrefs in createPublicUserContext')
  return async (req, res, next) => {
    try {
      // Development assertions for middleware validation
      devAssertNotNull(dsManager, 'dsManager')
      devAssertNotNull(freezrPrefs, 'freezrPrefs')
      // devAssert(Object.isFrozen(freezrPrefs), 'freezrPrefs should be frozen')
      
      if (!res.locals.freezr) {
        res.locals.freezr = {}
      }
      
      // Set basic server info
      res.locals.freezr.isSetup = dsManager.freezrIsSetup
      res.locals.freezr.serverName = req.protocol + '://' + req.get('host')
      res.locals.freezr.freezrStatus = freezrStatus

      res.locals.freezr.allowSelfReg = freezrPrefs?.allowSelfReg || false
      res.locals.freezr.allowAccessToSysFsDb = freezrPrefs?.allowAccessToSysFsDb || false 
      
      // Get app name (default to info.freezr.public for public pages)
      const appName = req.params.app_name
        || (req.originalUrl && req.originalUrl.startsWith('/register') ? 'info.freezr.register' : 'info.freezr.public')
      res.locals.freezr.appName = appName

      console.log('createPublicUserContext - appName', appName, 'from url', req.originalUrl)
      
      // Load public user's app filesystem
      if (!dsManager.freezrIsSetup) {
        // During initial setup, use local filesystem
        const userDS = dsManager.setSystemUserDS('public', { 
          fsParams: { type: 'local' }, 
          dbParams: {} 
        })
        
        if (userDS) {
          const appFS = await userDS.getorInitAppFS(appName, {})
          res.locals.freezr.appFS = appFS
        }
      } else {
        // Normal operation - get public user DS
        const userDS = await dsManager.getOrSetUserDS('public', { freezrPrefs })
        
        if (userDS && userDS.getorInitAppFS) {
          const appFS = await userDS.getorInitAppFS(appName, {})
          res.locals.freezr.appFS = appFS
        }
      }
      
      // Development assertions for middleware completion
      devAssertNotNull(res.locals.freezr.appFS, 'res.locals.freezr.appFS should be set')
      devAssertType(res.locals.freezr.appFS, 'object', 'res.locals.freezr.appFS')
      
      next()
    } catch (error) {
      console.error('Error in createPublicUserContext:', error)
      res.redirect('/register/firstSetUp')
    }
  }
}

export default {
  createContextForLogin
}

