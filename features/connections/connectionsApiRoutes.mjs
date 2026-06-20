// freezr.info - Connections feature: type-agnostic FEPS routes
// Mounted at /feps/connections by froutes/index.mjs.
//
// Lives outside the per-service subdirs (mail/, future calendar/, contacts/)
// because /accounts crosses all services: it lists every connection the calling
// app has *any* use_* permission for, so the right home is here at the umbrella
// layer rather than inside any one service folder.
//
// Phase 1 endpoints:
//   GET /feps/connections/accounts   List user's connections the caller can see
//
// Visibility rule: a connection shows up if the caller has at least one granted
// use_<service> perm AND one of that perm's connection_names covers this
// connection. Coverage is explicit: ['*'] means "all", a populated list means
// "those names". Missing/empty connection_names covers nothing (fails closed —
// same as matchesConnection in mailContext). DB perms are layered with any
// system-app shortcuts from common/systemPermissions.json.

import { Router } from 'express'
import { createSetupGuard, createGetAppTokenInfoFromheaderForApi } from '../../middleware/auth/basicAuth.mjs'
import { sendApiSuccess, sendFailure } from '../../adapters/http/responses.mjs'
import { getSystemPermissionsFor } from '../../common/helpers/systemPermissions.mjs'

const RESOURCES_APP_TABLE = 'info.freezr.account.resources'
const PERMS_APP_TABLE = 'info.freezr.account.permissions'

// (permType, service) pairs the listing endpoint knows about. Each pair is one
// "connection-scoped" permission type that controls visibility of connection
// records with the matching `services[]` entry. New service types add a row here.
const KNOWN_CONNECTION_PERMS = [
  { permType: 'use_mail', service: 'mail' },
  { permType: 'use_contacts', service: 'contacts' },
  { permType: 'use_calendar', service: 'calendar' }
]

export const createConnectionsApiRoutes = ({ dsManager, freezrPrefs }) => {
  const router = Router()

  const setupGuard = createSetupGuard(dsManager)
  const getAppTokenInfo = createGetAppTokenInfoFromheaderForApi(dsManager)

  /**
   * GET /feps/connections/accounts
   * Returns the caller-visible connections (no tokens). Each entry includes
   * _id so a caller (e.g. /connections/edit) can reference the record for
   * management ops like disconnect without a separate lookup endpoint.
   */
  router.get('/accounts', setupGuard, getAppTokenInfo, async (req, res) => {
    try {
      const tokenInfo = res.locals.freezr?.tokenInfo
      if (!tokenInfo) return sendFailure(res, 'Token info not available', 'connections/accounts', 401)
      const requestorApp = tokenInfo.app_name
      const ownerUserId = tokenInfo.requestor_id

      const permDb = await dsManager.getorInitDb({ app_table: PERMS_APP_TABLE, owner: ownerUserId }, { freezrPrefs })
      if (!permDb) return sendFailure(res, 'Could not access permissions database', 'connections/accounts', 500)

      // Build per-service visibility: { service -> { allowAll, names: Set } }.
      const visibility = {}
      let anyPermFound = false
      for (const { permType, service } of KNOWN_CONNECTION_PERMS) {
        const dbPerms = await permDb.query({ requestor_app: requestorApp, granted: true, type: permType }, {})
        const perms = (dbPerms || []).concat(getSystemPermissionsFor(requestorApp, permType))
        if (perms.length === 0) continue
        anyPermFound = true
        let allowAll = false
        const names = new Set()
        for (const p of perms) {
          const list = p.connection_names
          // Fail closed: a perm without an explicit list covers nothing. Wildcard must be ['*'].
          if (!Array.isArray(list) || list.length === 0) continue
          if (list.includes('*')) { allowAll = true; break }
          list.forEach(n => names.add(n))
        }
        visibility[service] = { allowAll, names }
      }

      if (!anyPermFound) {
        return sendFailure(res, 'No use_* connection permissions granted to this app', 'connections/accounts', 403)
      }

      // Perm check passed — mark permGiven so the downstream response pipeline doesn't
      // flag a "perm Not set up - dev error". Same role mailContext plays for /feps/connections/mail/*.
      res.locals.freezr = { ...res.locals.freezr, permGiven: true }

      const resourcesDb = await dsManager.getorInitDb({ app_table: RESOURCES_APP_TABLE, owner: ownerUserId }, { freezrPrefs })
      if (!resourcesDb) return sendFailure(res, 'Could not access user resources database', 'connections/accounts', 500)

      const all = await resourcesDb.query({ type: 'connection' }, {})
      const visible = (all || []).filter(c => {
        const services = Array.isArray(c.services) ? c.services : []
        return services.some(s => {
          const v = visibility[s]
          if (!v) return false
          return v.allowAll || v.names.has(c.connectionName)
        })
      })

      // Public view: never expose oauth / refresh_lock_at to the app.
      const out = visible.map(c => ({
        _id: c._id + '',
        connectionName: c.connectionName,
        provider: c.provider,
        account_email: c.account_email,
        services: c.services,
        access: c.access,
        status: c.status || 'ok'
      }))

      return sendApiSuccess(res, { accounts: out })
    } catch (error) {
      console.error('❌ Error in connections/accounts:', error)
      return sendFailure(res, error, 'connections/accounts', 500)
    }
  })

  return router
}

export default { createConnectionsApiRoutes }
