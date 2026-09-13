// freezr.info - LLM Context Middleware - llmContext.mjs
// Middleware for LLM-related permission checks and context setup
// Simplified version of serverlessContext.mjs

import { sendFailure } from '../../../adapters/http/responses.mjs'
import { decryptResourceSensitiveFields } from '../../account/services/resourceCrypto.mjs'
import { getSystemPermissionsFor } from '../../../common/helpers/systemPermissions.mjs'
import { isUserAdmin } from '../../jobs/services/userAdminStatus.mjs'
import { USER_DB_OAC } from '../../../common/helpers/config.mjs'
import { localAgentsAllowedForApp } from '../../../common/helpers/localAgentPolicy.mjs'

/**
 * Middleware to check use_llm permissions and set up LLM context
 * Verifies the requesting app has a granted use_llm permission,
 * then loads the user's LLM resource keys from info.freezr.account.resources.
 * 
 * Sets up on res.locals.freezr:
 * - permission: the granted permission record
 * - llmResources: array of LLM resource records for this user
 * - llmPricingDb: info.freezr.account.llmpricing (cached per-provider model prices)
 * - usageTallyDb: info.freezr.account.usageTallies (per app/key/vendor/day cost meter)
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

      // Layer in any system-app exceptions for (requestor_app, use_llm). For
      // info.freezr.creator this surfaces the legacy auto-grant that used to
      // live inline here — now declared in common/systemPermissions.json.
      perms.push(...getSystemPermissionsFor(requestorApp, 'use_llm'))

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
        const raw = await resourcesDb.query({ type: 'llm' }, {}) || []
        // Decrypt sensitive fields (`key`) before downstream consumers see them.
        // Handles all three storage shapes (plain string, { value }, { __enc }) — see resourceCrypto.mjs.
        llmResources = raw.map(decryptResourceSensitiveFields)

        // Whether ANY stored record holds the default — read BEFORE the local-CLI gate below,
        // so a gated-out default (e.g. the master pref toggled off while a localCli resource
        // is default) does not look like "no default" and get a second default written.
        const anyStoredDefault = llmResources.some(r => r.default)

        // Local-CLI resources (localCli: true — the ClaudeLocal connector, which spends the
        // server owner's Claude SUBSCRIPTION via the machine's logged-in `claude` binary) are
        // use-time gated HERE, the one choke point every LLM route passes through. The record
        // itself is inert user data anyone could write via the SDK; what makes it usable is:
        //   1. the admin master pref `local_llm_cli_enabled` (off by default), AND
        //   2. the requesting user being an admin (the isAdmin flag on their record —
        //      these are bearer-token routes, so there is no session flag to reuse), AND
        //   3. the REQUESTING APP being allowed to use local agents at all — by default only
        //      the creator app, because these connectors spend the owner's subscription and
        //      (for Codex) run an agent that untrusted app content could try to steer. See
        //      common/helpers/localAgentPolicy.mjs; SHOW_LOCAL_AGENT_IN_APPS=true lifts it.
        // Filtering the resource out (rather than erroring) means non-eligible users simply
        // never see the provider — in ping, in selection, anywhere.
        if (llmResources.some(r => r.localCli)) {
          let localCliAllowed = false
          if (freezrPrefs?.local_llm_cli_enabled && localAgentsAllowedForApp(requestorApp)) {
            try {
              localCliAllowed = await isUserAdmin(dsManager.getDB(USER_DB_OAC), ownerUserId)
            } catch (e) {
              console.warn('Could not resolve admin status for local-CLI LLM gate:', e.message)
            }
          }
          if (!localCliAllowed) llmResources = llmResources.filter(r => !r.localCli)
        }

        const withKeys = llmResources.filter(r => r.key || r.localCli)
        if (withKeys.length > 0 && !anyStoredDefault) {
          try {
            withKeys[0].default = true
            // updateFields-style partial update on `default` only — does NOT touch the
            // encrypted `key` field on the stored record, so no re-encryption needed.
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

      // Cost/usage meter for this user (info.freezr.account.usageTallies). Opened here
      // because this middleware already resolves the paying user and runs on every LLM
      // route; non-fatal, exactly like llmPricingDb — accounting must never block a call.
      let usageTallyDb = null
      try {
        usageTallyDb = await dsManager.getorInitDb(
          { app_table: 'info.freezr.account.usageTallies', owner: ownerUserId },
          { freezrPrefs }
        )
      } catch (e) {
        console.warn('Could not init usageTallyDb:', e.message)
      }

      res.locals.freezr = {
        ...res.locals.freezr,
        permissions: perms,
        llmResources,
        llmPricingDb,
        usageTallyDb
      }

      next()
    } catch (error) {
      console.error('❌ Error in createGetLlmPerms middleware:', error)
      return sendFailure(res, error, 'createGetLlmPerms', 500)
    }
  }
}

export default { createGetLlmPerms }
