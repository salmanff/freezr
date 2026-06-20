// freezr.info — Job token service (Phase 4) jobTokenService.mjs
//
// Mints SHORT-LIVED, session-less app tokens for Jobs that run with NO live user session
// (the scheduler, run-now, or any server-driven run). Reuses the offline-app token mechanism:
// a token record with logged_in:false and token_type !== 'browser' validates through the SAME
// getAppTokenFromHeaderAndDoMinimalChecks path with session binding skipped (tokenHandler.mjs:219).
// No special-case auth branch.
//
// LIFETIME: a token only needs to outlive ONE run (the run is hard-killed at maxRuntime). So the
// token is sized to the run — maxRuntime + a small grace — defaulting to 5 minutes when no
// maxRuntime is declared. We mint a fresh token PER RUN (no long-lived or reused tokens): minimal
// blast radius, auto-expires, and a serverless token that crosses the network is near-useless once
// the run ends. (The server is trusted to mint on the user's behalf because the job was enabled/
// trusted for that (user, app); no stored credential is needed.)
//
// Scope = the app's own permissions (the token inherits them). Revocation is also free:
// deleteAppTokensForUserAndApp deletes by { owner_id, app_name } regardless of type.

import { generateOneTimeAppPassword } from '../../../common/helpers/config.mjs'

const TOKEN_TYPE = 'job'
const GRACE_MS = 60 * 1000          // headroom beyond maxRuntime (delays, clock skew, final write)
const DEFAULT_TTL_MS = 5 * 60 * 1000 // used when no maxRuntime is declared

/**
 * Mint a fresh short-lived session-less job token; returns the token string.
 * @param {Object}  tokenDb               opened APP_TOKEN_OAC db handle
 * @param {Object}  args
 * @param {string}  args.userId
 * @param {string}  args.appName
 * @param {number}  [args.maxRuntimeMs]   the job's declared max runtime (ms); token = this + grace,
 *                                        or DEFAULT_TTL_MS (5 min) when not provided.
 */
export async function mintJobToken (tokenDb, { userId, appName, maxRuntimeMs } = {}) {
  if (!tokenDb || !tokenDb.create) throw new Error('jobTokenService: tokenDb with create() required')
  if (!userId || !appName) throw new Error('jobTokenService: userId and appName required')

  const ttlMs = (typeof maxRuntimeMs === 'number' && maxRuntimeMs > 0)
    ? maxRuntimeMs + GRACE_MS
    : DEFAULT_TTL_MS

  const appToken = generateOneTimeAppPassword(userId, appName)
  const record = {
    logged_in: false,
    token_type: TOKEN_TYPE,
    source_device: null,
    owner_id: userId,
    requestor_id: userId,
    app_name: appName,
    app_password: null,
    app_token: appToken,
    expiry: Date.now() + ttlMs,
    is_job: true,
    user_device: null,
    date_used: null
  }
  await tokenDb.create(null, record, {})
  return appToken
}

export default { mintJobToken }
