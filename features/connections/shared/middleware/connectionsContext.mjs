// freezr.info - Connections feature: shared per-service middleware factory
//
// Single source of truth for use_<service> permission loading + connection-record
// loading for ALL connection-scoped services (mail, contacts, calendar, future others).
//
// Each per-service middleware is a thin wrapper: `createMailContext = (ds, prefs) =>
// createConnectionsContext('mail')(ds, prefs)`, etc. This file is where the security
// invariants live; per-service files just bind the service name.
//
// Invariants enforced here (mirror mail's mailContext.mjs prior to factoring):
//   - matchesConnection: missing/empty connection_names DENIES (fail-closed); ['*']
//     must be explicit. (C2 in mail_security_review.md.)
//   - Default mode is write-required: read routes opt out via `markReadOnly`. A
//     route that forgets to mark itself read-only gets the strict check — safer
//     default than a write route that forgets to arm a gate. (C3.)
//   - Two-level write gate: granted.scopes must include 'write' AND
//     connection.access.<service> === 'readwrite'. (C3.)
//   - Connection must list <service> in services[] (else 403, not 404).
//   - status === 'token_expired' returns the structured reauth payload up front.
//
// Sets res.locals.freezr.<service>Permission (singular — the matching granted perm)
// and res.locals.freezr.<service>Connection (decrypted), plus permGiven = true.
// Naming uses the service to keep mail/contacts/calendar separate when a single
// request somehow traversed multiple per-service middlewares (shouldn't happen,
// but defense-in-depth costs nothing).
//
// The type-agnostic listing endpoint (GET /feps/connections/accounts) lives in
// features/connections/connectionsApiRoutes.mjs and does its own perm load —
// it crosses services and has no :connectionName, so it doesn't fit this shape.

import { sendFailure } from '../../../../adapters/http/responses.mjs'
import { getSystemPermissionsFor } from '../../../../common/helpers/systemPermissions.mjs'

const PERMS_APP_TABLE = 'info.freezr.account.permissions'
const RESOURCES_APP_TABLE = 'info.freezr.account.resources'

const includesAny = (arr, ...vals) => Array.isArray(arr) && vals.some(v => arr.includes(v))

const matchesConnection = (perm, connectionName) => {
  const list = perm.connection_names
  // Missing / empty connection_names denies access — wildcard must be explicit as ['*'].
  // Fails closed so a perm record without an explicit list never silently grants all.
  if (!Array.isArray(list) || list.length === 0) return false
  if (list.includes('*')) return true
  return list.includes(connectionName)
}

/**
 * Build a per-service connection-context middleware.
 *
 * @param {string} service                  'mail' | 'contacts' | 'calendar' | …
 * @returns {(dsManager, freezrPrefs) => Function}  factory consumed by route files
 */
export const createConnectionsContext = (service) => {
  if (!service || typeof service !== 'string') {
    throw new Error('createConnectionsContext: service name is required')
  }
  const permType = 'use_' + service
  const writeRequiredKey = service + 'WriteRequired'
  const permissionKey = service + 'Permission'
  const connectionKey = service + 'Connection'
  const tag = 'createConnectionsContext(' + service + ')'

  return (dsManager, freezrPrefs) => {
    // Lazy-load the decryptor so the import graph doesn't fan out until first use.
    let decryptResourceSensitiveFields
    return async (req, res, next) => {
      try {
        if (!decryptResourceSensitiveFields) {
          ({ decryptResourceSensitiveFields } = await import('../../../account/services/resourceCrypto.mjs'))
        }

        const tokenInfo = res.locals.freezr?.tokenInfo
        if (!tokenInfo) return sendFailure(res, 'Token info not available', tag, 401)
        const requestorApp = tokenInfo.app_name
        const ownerUserId = tokenInfo.requestor_id

        // ---- Step 1: load use_<service> perms (DB + system shortcuts) ----
        const permDb = await dsManager.getorInitDb({ app_table: PERMS_APP_TABLE, owner: ownerUserId }, { freezrPrefs })
        if (!permDb) return sendFailure(res, 'Could not access permissions database', tag, 500)

        const perms = await permDb.query({ requestor_app: requestorApp, granted: true, type: permType }, {})
        // Layer in any system-app exceptions from common/systemPermissions.json. The
        // fabricated records are in-memory only; nothing is written to the user's DB.
        perms.push(...getSystemPermissionsFor(requestorApp, permType))

        if (!perms || perms.length === 0) {
          return sendFailure(res, 'No ' + permType + ' permission granted to this app', tag, 403)
        }

        const connectionName = req.params.connectionName
        if (!connectionName) {
          return sendFailure(res, tag + ' requires :connectionName in route', tag, 500)
        }

        const granted = perms.find(p => matchesConnection(p, connectionName))
        if (!granted) {
          return sendFailure(res, 'No ' + permType + ' permission covers connection: ' + connectionName, tag, 403)
        }

        // Load the connection record (decrypted)
        const resourcesDb = await dsManager.getorInitDb({ app_table: RESOURCES_APP_TABLE, owner: ownerUserId }, { freezrPrefs })
        if (!resourcesDb) return sendFailure(res, 'Could not access user resources database', tag, 500)

        const matches = await resourcesDb.query({ type: 'connection', connectionName }, {})
        if (!matches || matches.length === 0) {
          return sendFailure(res, 'Connection not found: ' + connectionName, tag, 404)
        }
        const connectionRaw = matches[0]
        if (!Array.isArray(connectionRaw.services) || !connectionRaw.services.includes(service)) {
          return sendFailure(res, 'Connection does not have ' + service + ' service enabled: ' + connectionName, tag, 403)
        }

        // If token already known-expired, return the structured reauth payload up front.
        if ((connectionRaw.status || 'ok').toLowerCase() === 'token_expired') {
          return res.status(401).json({
            success: false,
            error: 'token_expired',
            connectionName,
            reauth_url: '/account/resources?focus=' + encodeURIComponent(connectionName)
          })
        }

        // Write enforcement (default ON / fail-closed): both app-side scope AND user-side
        // access must allow it. Read routes opt out by mounting `markReadOnly` before this
        // middleware. A route that forgets to mark itself read-only gets the strict check —
        // safer default than a write route that forgets to arm a gate.
        const writeRequired = res.locals[writeRequiredKey] !== false
        if (writeRequired) {
          const appAllowsWrite = includesAny(granted.scopes || [], 'write')
          const userAllowsWrite = (connectionRaw.access && connectionRaw.access[service] === 'readwrite')
          if (!appAllowsWrite) {
            return sendFailure(res, permType + ' permission does not include write scope', tag, 403)
          }
          if (!userAllowsWrite) {
            return sendFailure(res, 'Connection is configured as read-only for ' + service, tag, 403)
          }
        }

        const decryptedConnection = decryptResourceSensitiveFields(connectionRaw)

        res.locals.freezr = {
          ...res.locals.freezr,
          [permissionKey]: granted,
          [connectionKey]: decryptedConnection,
          permGiven: true
        }
        next()
      } catch (error) {
        console.error('❌ Error in ' + tag + ':', error)
        return sendFailure(res, error, tag, 500)
      }
    }
  }
}

/**
 * Build the `markReadOnly` middleware paired with a per-service context.
 * Returns a tiny utility that flips res.locals.<service>WriteRequired = false.
 * Mount BEFORE the per-service context on read routes.
 */
export const createMarkReadOnly = (service) => {
  const key = service + 'WriteRequired'
  return (req, res, next) => {
    res.locals[key] = false
    next()
  }
}

export default { createConnectionsContext, createMarkReadOnly }
