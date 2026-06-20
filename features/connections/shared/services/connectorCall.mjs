// freezr.info - Shared connector-call helper
// Cross-service helper used by mail/contacts/calendar services: bridge a
// connection record → fresh OAuth token → connector call → result, with one
// retry on 401 (which forces a token refresh in case the cached expiry is
// stale and the provider invalidated the token externally).
//
// This is the "single place that knows how to talk to a connector with a
// guarantee of a fresh token." mailService.mjs / contactsService.mjs /
// calendarService.mjs all go through here so the token-refresh, token-expired
// cascade, and connection-marking behavior is identical across services.

import { ensureFreshAccessToken } from './tokenRefresh.mjs'

const RESOURCES_APP_TABLE = 'info.freezr.account.resources'

/**
 * Run a connector call with the connection's current access token. If the
 * provider returns 401 (revoked / invalidated externally), force a refresh
 * and retry once. Persistent failures bubble up as Error with `.code` set
 * to `'refresh_failed'` so the route layer can emit the structured
 * `token_expired` payload uniformly.
 *
 * @param {Object} ctx
 * @param {Object} ctx.dsManager
 * @param {Object} ctx.freezrPrefs
 * @param {string} ctx.userId
 * @param {Object} ctx.connection      The decrypted-or-encrypted connection record
 * @param {(oauth) => Promise<*>} ctx.fn  Receives decrypted oauth, returns provider result
 */
export const callWithAutoRefresh = async ({ dsManager, freezrPrefs, userId, connection, fn }) => {
  let oauth = await ensureFreshAccessToken({ dsManager, freezrPrefs, userId, connection })
  try {
    return await fn(oauth)
  } catch (err) {
    if (!err || err.status !== 401) throw err

    // Force a refresh by giving ensureFreshAccessToken a connection view with expiry=0.
    // If the refresh fails (refresh_token revoked) it'll mark status=token_expired
    // and throw code='refresh_failed' itself — let that bubble through.
    const forcedConnection = { ...connection, oauth: { ...connection.oauth, expiry: 0 } }
    oauth = await ensureFreshAccessToken({ dsManager, freezrPrefs, userId, connection: forcedConnection })

    try {
      return await fn(oauth)
    } catch (err2) {
      if (err2 && err2.status === 401) {
        // Refresh succeeded but provider still 401s with the new token — connection
        // looks revoked at the provider in a way that surfaces only on use. Mark the
        // connection so /accounts UI shows the right status, then convert to
        // refresh_failed so the route layer emits the structured payload.
        try {
          const resourcesDb = await dsManager.getorInitDb(
            { app_table: RESOURCES_APP_TABLE, owner: userId },
            { freezrPrefs }
          )
          if (resourcesDb && connection._id) {
            await resourcesDb.update(connection._id + '', { status: 'token_expired' }, { replaceAllFields: false })
          }
        } catch (markErr) {
          console.warn('callWithAutoRefresh: could not mark connection token_expired:', markErr?.message || markErr)
        }
        const e = new Error('Provider rejected access token even after refresh — connection appears revoked')
        e.code = 'refresh_failed'
        throw e
      }
      throw err2
    }
  }
}

export default { callWithAutoRefresh }
