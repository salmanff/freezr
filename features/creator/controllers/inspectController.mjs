// freezr.info - Inspect Controller (freezr_creator_selfcheck_plan_v1.md Part A, §A3)
//
// Serves ONE app's page/source files (html/js/css/manifest) to the holder of a short-lived
// inspection token, so an external LLM/agent can check the app's files on a hosted freezr.
//
// Deliberately a dedicated route family (GET /creator/inspect/:app_name/*) rather than a token
// branch on the real /apps pages: those routes sit behind loggedInGuard and mint real long-lived
// app tokens on page GETs (createOrUpdateTokenGuardFromPage) — an inspect token must never reach
// credential-minting code. This path is additive, GET-only, and read-only; a bug here is bounded
// by "someone read this one app's source until the token expired".

import { sendApiSuccess, sendFailure } from '../../../adapters/http/responses.mjs'
import { userPERMS_OAC } from '../../../common/helpers/config.mjs'
import { inspectTokenStore } from '../../../middleware/tokens/inspectTokenStore.mjs'

export const createInspectController = ({ dsManager, freezrPrefs }) => {
  // Token accepted as ?inspectToken= or a Cookie (inspectToken=...) — the cookie carrier makes
  // curl/agent use trivial and is acceptable here because these routes are static reads for one
  // named app and never set or mint anything (plan §A3 / C2).
  const getInspectTokenInfo = (req, res, next) => {
    const fromQuery = typeof req.query?.inspectToken === 'string' && req.query.inspectToken
    const fromCookie = typeof req.cookies?.inspectToken === 'string' && req.cookies.inspectToken
    const token = fromQuery || fromCookie || null
    if (!token) {
      return sendFailure(res, 'inspect token required', 'getInspectTokenInfo', 401)
    }
    const rec = inspectTokenStore.get(token) // null if missing OR expired
    if (!rec) {
      return sendFailure(res, 'invalid or expired inspect token', 'getInspectTokenInfo', 401)
    }
    if (rec.app_name !== req.params.app_name) {
      return sendFailure(res, 'inspect token scope mismatch', 'getInspectTokenInfo', 403)
    }
    if (!res.locals.freezr) res.locals.freezr = {}
    res.locals.freezr.inspectTokenInfo = rec
    next()
  }

  const sendInspectAppFile = async (req, res) => {
    try {
      const rec = res.locals.freezr?.inspectTokenInfo
      if (!rec) return sendFailure(res, 'inspect token not validated', 'sendInspectAppFile', 500)

      // Empty path → the app's main page source.
      let endpath = req.params[0] || 'index.html'
      // Decode BEFORE the traversal check so encoded dots can't slip past it
      // (appFS.sendAppFile re-checks with endpathIsConfined as defence in depth).
      try {
        endpath = decodeURIComponent(endpath)
      } catch (e) {
        return sendFailure(res, 'file not found', 'sendInspectAppFile', 404)
      }
      if (endpath.includes('..') || endpath.startsWith('/') || endpath.includes('\0')) {
        return sendFailure(res, 'file not found', 'sendInspectAppFile', 404)
      }

      const userDS = await dsManager.getOrSetUserDS(rec.owner_id, { freezrPrefs })
      if (!userDS) return sendFailure(res, 'owner not found', 'sendInspectAppFile', 404)
      const appFS = await userDS.getorInitAppFS(rec.app_name, {})
      if (!appFS) return sendFailure(res, 'app not found', 'sendInspectAppFile', 404)

      // The validated inspect token IS the permission grant for these read-only source files;
      // the send* helpers refuse to serve unless permGiven is set (checkPermGiven → 400 otherwise).
      res.locals.freezr.permGiven = true
      // sendAppFile applies its own endpathIsConfined guard and 404s on missing files.
      return appFS.sendAppFile(endpath, res, {})
    } catch (error) {
      console.error('❌ Error in sendInspectAppFile:', error)
      return sendFailure(res, 'error serving file', 'sendInspectAppFile', 500)
    }
  }

  /**
   * GET /creator/inspect/:app_name/__permissions
   *
   * Which permissions this app DECLARES (from its manifest) versus which the user has actually
   * GRANTED. Rides the files token — it exposes no records, only permission metadata — so an
   * assistant checking its own work can tell "the code is wrong" apart from "the user never
   * granted this permission", which is the more common cause of an app reading nothing.
   */
  const sendInspectPermissions = async (req, res) => {
    try {
      const rec = res.locals.freezr?.inspectTokenInfo
      if (!rec) return sendFailure(res, 'inspect token not validated', 'sendInspectPermissions', 500)

      const userDS = await dsManager.getOrSetUserDS(rec.owner_id, { freezrPrefs })
      if (!userDS) return sendFailure(res, 'owner not found', 'sendInspectPermissions', 404)

      // Declared permissions come from the app's own manifest.
      let declared = []
      try {
        const appFS = await userDS.getorInitAppFS(rec.app_name, {})
        const manifestText = await appFS.readAppFile('manifest.json')
        const manifest = JSON.parse(typeof manifestText === 'string' ? manifestText : manifestText.toString())
        declared = (manifest?.permissions || []).map((p) => ({
          name: p.name, type: p.type, table_id: p.table_id, description: p.description
        }))
      } catch (e) {
        declared = []
      }

      // Granted state comes from the user's own permissions DB — the same rows /ceps consults.
      const permsDb = await dsManager.getorInitDb(userPERMS_OAC(rec.owner_id), { freezrPrefs })
      if (!permsDb) return sendFailure(res, 'permissions database not available', 'sendInspectPermissions', 500)
      const rows = await permsDb.query({ requestor_app: rec.app_name }, {}) || []
      const granted = rows.map((p) => ({
        name: p.name, type: p.type, table_id: p.table_id, granted: !!p.granted, grantees: p.grantees || []
      }))

      const grantedNames = granted.filter((p) => p.granted).map((p) => p.name)
      const notGranted = declared.filter((d) => !grantedNames.includes(d.name)).map((d) => d.name)

      res.locals.freezr.permGiven = true
      return sendApiSuccess(res, {
        app_name: rec.app_name,
        declared,
        granted,
        not_granted: notGranted,
        note: notGranted.length
          ? 'These declared permissions are NOT granted by the user; data reads relying on them will return nothing until the user grants them in the app\'s permissions screen.'
          : 'All declared permissions are granted.'
      })
    } catch (error) {
      console.error('❌ Error in sendInspectPermissions:', error)
      return sendFailure(res, 'error reading permissions', 'sendInspectPermissions', 500)
    }
  }

  return { getInspectTokenInfo, sendInspectAppFile, sendInspectPermissions }
}

export default { createInspectController }
