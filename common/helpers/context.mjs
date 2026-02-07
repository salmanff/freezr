// freezr.info - Common Context Helpers
// Shared context creation functions used across features

/**
 * Creates base freezr context for res.locals
 * Sets up basic server info (no user/session data)
 * 
 * @param {Object} req - Express request object
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @returns {Object} Base freezr context object
 */
export const createBaseFreezrContextForResLocals = (req, dsManager, freezrPrefs, freezrStatus) => {
  return {
    serverName: req.protocol + '://' + req.get('host'),
    freezrVersion: freezrPrefs.version || '0.0.20',
    freezrStatus: freezrStatus,
    isSetup: dsManager.freezrIsSetup,
    freezrPrefs: freezrPrefs
  }
}

