// freezr.info - SDK add-on detection helper
//
// freezrApiV2.js is split into a core file plus optional add-ons:
//   - freezrApiV2.connections.js — injected when app has use_mail (or future
//     use_contacts / use_calendar) permission
//   - freezrApiV2.llm.js         — injected when app has use_llm permission
//   - freezrApiV2.serverless.js  — injected when app has use_serverless or
//     use_3pFunction permission
//
// An app gets an add-on if either of these is true:
//   1. Its manifest declares a permission of that type, OR
//   2. The system-permissions registry (common/systemPermissions.json) has a
//      matching shortcut for the app (e.g. info.freezr.creator → use_llm).
//
// Same merge pattern used by mailContext.mjs / llmContext.mjs at request time.

import { getAllSystemPermissionsForApp } from './systemPermissions.mjs'
import { computeSdkAddons } from './freezrApiClientManifest.mjs'

/**
 * Decide which SDK add-ons should be injected for an app's page. The add-on list and the
 * permission types that trigger each are declared once in common/freezrApiClient.manifest.json.
 *
 * @param {string} appName
 * @param {object} manifest - the app's manifest (may be {} or missing perms)
 * @returns {{ [addonKey: string]: boolean }} e.g. { connections, llm, serverless }
 */
export const sdkAddonsForApp = (appName, manifest) => {
  const manifestPerms = Array.isArray(manifest?.permissions)
    ? manifest.permissions
    : Object.values(manifest?.permissions || {})
  const systemPerms = appName ? getAllSystemPermissionsForApp(appName) : []
  const allTypes = new Set(
    [...manifestPerms, ...systemPerms]
      .filter(p => p && typeof p.type === 'string')
      .map(p => p.type)
  )
  return computeSdkAddons(allTypes)
}

export default { sdkAddonsForApp }
