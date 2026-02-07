// registerContext.mjs
// freezr.info - Modern ES6 Module - Register Context Middleware
// Middleware for handling register-specific context and data loading
//
// Architecture Pattern:
// - Modern version puts data in res.locals (not req parameters)
// - Replicates legacy addFradminDs functionality

import { createBaseFreezrContextForResLocals } from '../../../common/helpers/context.mjs'
import DATA_STORE_MANAGER from '../../../adapters/datastore/dsManager.mjs'  

/**
 * Middleware to add dsManager to request
 * Simple middleware that adds dsManager to res.locals
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @returns {Function} Express middleware function
 */
export const createAddFreezrStatusAndDsManagerForFirstSetup = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {

    const existingFreezr = res.locals.freezr || {}
      res.locals.freezr = {
      ...createBaseFreezrContextForResLocals(req, dsManager, freezrPrefs, freezrStatus),
      ...existingFreezr, // Preserve existing properties
      freezrSetUpStatus: 'firstSetUp',
      dsManager: dsManager,
      freezrInitialEnvCopy: JSON.parse(JSON.stringify(dsManager.initialEnvironment))
    }
    
    next()
  }
}
/**
 * Middleware to add dsManager to request
 * Simple middleware that adds dsManager to res.locals
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @returns {Function} Express middleware function
 */
export const createAddFreezrContextForSelfRegisteredNewUser = (dsManager, freezrPrefs, freezrStatus, source) => {
  return async (req, res, next) => {
    let freezrSetUpStatus = 'unRegisteredUser'
    if (source === 'checkResource' && !dsManager.freezrIsSetup) freezrSetUpStatus = 'firstSetUp'

    const existingFreezr = res.locals.freezr || {}
      res.locals.freezr = {
      ...createBaseFreezrContextForResLocals(req, dsManager, freezrPrefs, freezrStatus),
      ...existingFreezr, // Preserve existing properties
      freezrSetUpStatus,
      freezrInitialEnvCopy: JSON.parse(JSON.stringify(dsManager.initialEnvironment)),
      selfRegOptions: createSelfRegOptions(freezrPrefs),
    }
    
    next()
  }
}

const createSelfRegOptions = (freezrPrefs) => {
  return {
    allow: freezrPrefs?.allowSelfReg || false,
    allowAccessToSysFsDb: freezrPrefs?.allowAccessToSysFsDb || false,
    defaultMBStorageLimit: freezrPrefs?.selfRegDefaultMBStorageLimit || 100,
    dbUnificationStrategy: freezrPrefs?.dbUnificationStrategy || 'user_db',
    hasNotbeenSave: true
  }
}

export const addLocalManagerForFirstSetup = async (req, res, next) => {
  const localManager = new DATA_STORE_MANAGER()
  localManager.setSystemUserDS('fradmin', { dbParams: {}, fsParams: { type: 'local' } })
  // res.locals.freezr.localManager = localManager
  const localsAppFS = await localManager.getOrInitUserAppFS('fradmin', 'info.freezr.register', { freezrPrefs: {} })
  res.locals.freezr.localsAppFS = localsAppFS
  next()
}