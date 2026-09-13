// freezr.info - Messaging live-connections registry
//
// ONE server-wide (fradmin-owned) list of connections whose users opted into
// live socket-fed updates. Exists for the same stated reason as the scheduler's
// scheduled_jobs table: the socket manager must never iterate per-user
// datastores to discover work (a user on an unreachable DB must not break the
// service). See common/helpers/config.mjs MESSAGING_LIVE_OAC.
//
// Rows are written by ONE explicit path in phase 1: the user toggling "Live
// updates" on /account/resources (acctapi connection_set_live). That toggle is
// also the backfill mechanism for pre-existing connections — deliberate and
// per-user, never a bulk scan.
//
// team_id + provider_user_id are the ROUTING KEY: incoming socket events carry
// (teamId, authUserIds) and are delivered only to rows that match BOTH —
// fail-closed, so an event attributable to nobody registered is counted and
// dropped, never guessed at.

import { MESSAGING_LIVE_OAC } from '../../../../common/helpers/config.mjs'
import { decryptResourceSensitiveFields } from '../../../account/services/resourceCrypto.mjs'
import * as slackConnector from '../../../../adapters/connections/messaging/slack.mjs'

const getDb = async (dsManager, freezrPrefs) =>
  dsManager.getorInitDb(MESSAGING_LIVE_OAC, { freezrPrefs })

/**
 * All live rows — what the socket manager routes against.
 */
export const listLive = async ({ dsManager, freezrPrefs }) => {
  const db = await getDb(dsManager, freezrPrefs)
  return ((await db.query({ live: true }, {})) || [])
}

/**
 * Opt a connection IN: resolve its provider identity (team + user id) with the
 * connection's own token, then upsert the registry row. Throwing here (bad
 * token, provider down) correctly blocks the opt-in — a row we can't route is
 * worse than no row.
 *
 * @param {Object} args { dsManager, freezrPrefs, ownerId, connection (raw or decrypted) }
 */
export const registerLive = async ({ dsManager, freezrPrefs, ownerId, connection }) => {
  if (!connection || connection.provider !== 'slack') {
    const err = new Error('Live updates are only supported for slack connections today')
    err.code = 'unsupported_provider'
    throw err
  }
  const decrypted = decryptResourceSensitiveFields(connection)
  const accessToken = decrypted.oauth?.accessToken
  if (!accessToken) {
    const err = new Error('Connection has no access token')
    err.code = 'no_token'
    throw err
  }
  const profile = await slackConnector.getAccountProfile(accessToken)
  if (!profile.teamId || !profile.userId) {
    const err = new Error('Could not resolve the connection\'s workspace/user identity')
    err.code = 'no_identity'
    throw err
  }

  const db = await getDb(dsManager, freezrPrefs)
  const row = {
    owner_id: ownerId,
    connection_name: connection.connectionName,
    provider: 'slack',
    team_id: profile.teamId,
    provider_user_id: profile.userId,
    live: true
  }
  const existing = ((await db.query({ owner_id: ownerId, connection_name: connection.connectionName }, {})) || [])[0]
  if (existing) {
    await db.update(existing._id + '', row, { replaceAllFields: false })
  } else {
    await db.create(null, row, null)
  }
  return row
}

/**
 * Opt a connection OUT — delete its row so the manager stops routing to it.
 * Idempotent.
 */
export const unregisterLive = async ({ dsManager, freezrPrefs, ownerId, connectionName }) => {
  const db = await getDb(dsManager, freezrPrefs)
  const existing = ((await db.query({ owner_id: ownerId, connection_name: connectionName }, {})) || [])
  for (const row of existing) {
    await db.delete_record(row._id + '')
  }
  return { removed: existing.length }
}

export default { listLive, registerLive, unregisterLive }
