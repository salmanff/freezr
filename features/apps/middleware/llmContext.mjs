// freezr.info - LLM Context Middleware - llmContext.mjs
// Middleware for LLM-related permission checks and context setup
// Simplified version of serverlessContext.mjs

import { sendFailure } from '../../../adapters/http/responses.mjs'

/**
 * Middleware to check use_llm permissions and set up LLM context
 * Verifies the requesting app has a granted use_llm permission,
 * then loads the user's LLM resource keys from info.freezr.account.resources.
 * 
 * Sets up on res.locals.freezr:
 * - permission: the granted permission record
 * - llmResources: array of LLM resource records for this user
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @returns {Function} Express middleware function
 */
export const createGetLlmPerms = (dsManager, freezrPrefs) => {
  return async (req, res, next) => {
    try {
      const tokenInfo = res.locals.freezr?.tokenInfo
      if (!tokenInfo) {
        return sendFailure(res, 'Token info not available', 'createGetLlmPerms', 401)
      }

      const requestorApp = tokenInfo.app_name
      const ownerUserId = tokenInfo.requestor_id

      const permDb = await dsManager.getorInitDb(
        { app_table: 'info.freezr.account.permissions', owner: ownerUserId },
        { freezrPrefs }
      )
      if (!permDb) {
        return sendFailure(res, 'Could not access permissions database', 'createGetLlmPerms', 500)
      }

      const perms = await permDb.query({
        requestor_app: requestorApp,
        granted: true,
        type: 'use_llm'
      }, {})

      // system app exception
      if (requestorApp === 'info.freezr.creator') {
        perms.push ({ type: 'use_llm', granted: true, system_perm: true})
      }

      if (!perms || perms.length === 0) {
        console.warn('No use_llm permission found', { requestorApp, ownerUserId })
        return sendFailure(res, 'No use_llm permission found for this app', 'createGetLlmPerms', 403)
      }

      // Load LLM resources for this user
      const resourcesDb = await dsManager.getorInitDb(
        { app_table: 'info.freezr.account.resources', owner: ownerUserId },
        { freezrPrefs }
      )

      let llmResources = []
      if (resourcesDb) {
        llmResources = await resourcesDb.query({ type: 'llm' }, {}) || []
        const withKeys = llmResources.filter(r => r.key)
        const hasDefault = withKeys.some(r => r.default)
        if (withKeys.length > 0 && !hasDefault) {
          try {
            withKeys[0].default = true
            await resourcesDb.update(withKeys[0]._id, { default: true }, { replaceAllFields: false })
          } catch (e) {
            console.warn('Could not auto-set default LLM resource:', e.message)
          }
        }
      }

      let llmPricingDb = null
      try {
        llmPricingDb = await dsManager.getorInitDb(
          { app_table: 'info.freezr.account.llmpricing', owner: ownerUserId },
          { freezrPrefs }
        )
      } catch (e) {
        console.warn('Could not init llmPricingDb:', e.message)
      }

      res.locals.freezr = {
        ...res.locals.freezr,
        permissions: perms,
        llmResources,
        llmPricingDb
      }

      next()
    } catch (error) {
      console.error('❌ Error in createGetLlmPerms middleware:', error)
      return sendFailure(res, error, 'createGetLlmPerms', 500)
    }
  }
}

export default { createGetLlmPerms }
