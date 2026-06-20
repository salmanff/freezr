// freezr.info - accountResetController.mjs
//
// /account/reset = "refresh storage credentials". Lets a user re-enter the keys/credentials for
// their CURRENT cloud storage provider (same provider — not a switch; that's migration) and save
// them in place. Only meaningful for cloud FS/DB; local/system/nedb have no credentials, so the
// page shows a generic message for those.

import { sendApiSuccess, sendFailure } from '../../../adapters/http/responses.mjs'
import User from '../../../common/misc/userObj.mjs'
import { decryptParams, encryptParams } from '../../register/services/registerServices.mjs'
import { checkFS, checkDB, describeFsDbParams, ENV_PARAMS } from '../../../adapters/datastore/environmentDefaults.mjs'

const WHO = 'accountResetController'

// Field names that hold secrets — never prefilled back to the page (left blank to re-enter; if
// left blank on save, the current stored value is kept).
const SECRET_FIELDS = new Set([
  'secretAccessKey', 'password', 'accessToken', 'refreshToken', 'code',
  'codeVerifier', 'codeChallenge', 'secret', 'msConnectioNString', 'connectionString'
])

// Build the refreshable-field descriptor for a resource ('FS' or 'DB') from the user's current
// (decrypted) params. Refreshable === the provider definition has credential fields.
const describeRefreshable = (resource, params) => {
  const p = params || {}
  const choice = p.choice || p.type
  const def = choice ? (ENV_PARAMS[resource] || {})[choice] : null
  const label = describeFsDbParams(p, resource).display
  if (!def || !def.fields || def.fields.length === 0 || choice === 'sysDefault') {
    return { refreshable: false, choice: choice || null, type: p.type || null, label }
  }
  const fields = def.fields.map(f => {
    const out = {
      name: f.name,
      display: f.display || f.name,
      type: f.type || 'text',
      optional: !!f.optional,
      secret: SECRET_FIELDS.has(f.name)
    }
    if (f.name === 'unifyData') {
      // Reflect the current data layout, but lock it: switching unified ⇄ per-app
      // in place would orphan existing records — that requires a DB migration.
      out.value = (p.dbUnificationStrategy === 'all')
      out.locked = true
      out.note = 'To change your data layout, use “Migrate database”.'
    } else {
      out.value = out.secret ? '' : (p[f.name] || '') // prefill non-secrets for convenience
    }
    return out
  })
  return { refreshable: true, choice, type: p.type, label, fields }
}

export const createAccountResetController = ({ dsManager, freezrPrefs } = {}) => {
  // Tells the page which (if any) of FS/DB can have their credentials refreshed, with the field defs.
  const handleResetInfo = async (req, res) => {
    try {
      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'Not logged in', WHO, 401)
      const allUsersDb = res.locals?.freezr?.allUsersDb
      if (!allUsersDb) return sendFailure(res, 'Users database not available', WHO, 500)
      const rows = await allUsersDb.query({ user_id: userId }, null)
      const user = rows?.[0]
      if (!user) return sendFailure(res, 'User not found', WHO, 404)

      return sendApiSuccess(res, {
        success: true,
        userId,
        fs: describeRefreshable('FS', decryptParams(user.fsParams)),
        db: describeRefreshable('DB', decryptParams(user.dbParams))
      })
    } catch (error) {
      return sendFailure(res, error.message, WHO + '.info', 500)
    }
  }

  // Re-enter + save credentials for the current provider of one resource (FS or DB).
  const handleRefresh = async (req, res) => {
    try {
      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'Not logged in', WHO, 401)
      const allUsersDb = res.locals?.freezr?.allUsersDb
      if (!allUsersDb) return sendFailure(res, 'Users database not available', WHO, 500)

      const resource = req.body?.resource
      if (resource !== 'FS' && resource !== 'DB') return sendFailure(res, 'Invalid resource', WHO, 400)
      const password = req.body?.password
      if (!password) return sendFailure(res, 'Password is required', WHO, 400)
      const submitted = req.body?.params || {}

      const rows = await allUsersDb.query({ user_id: userId }, null)
      const user = rows?.[0]
      if (!user) return sendFailure(res, 'User not found', WHO, 404)
      if (!new User(user).check_passwordSync(password)) return sendFailure(res, 'Wrong password', WHO, 401)

      const current = decryptParams(resource === 'FS' ? user.fsParams : user.dbParams) || {}
      const choice = current.choice || current.type
      const def = choice ? (ENV_PARAMS[resource] || {})[choice] : null
      if (!def || !def.fields || def.fields.length === 0 || choice === 'sysDefault') {
        return sendFailure(res, 'This storage has no credentials to refresh', WHO, 400)
      }

      // Build the new params for the SAME provider. Blank field ⇒ keep the current value
      // (so the user can change only what they need, and need not re-type secrets they keep).
      const newParams = { type: def.type, choice }
      for (const f of def.fields) {
        if (f.name === 'unifyData') continue // data-layout, not a credential — handled below
        const v = (submitted[f.name] != null && String(submitted[f.name]).trim() !== '')
          ? String(submitted[f.name]).trim()
          : current[f.name]
        if (v != null && v !== '') newParams[f.name] = v
      }
      for (const f of def.fields) {
        if (f.name === 'unifyData') continue
        if (!f.optional && (newParams[f.name] == null || newParams[f.name] === '')) {
          return sendFailure(res, 'Missing required field: ' + (f.display || f.name), WHO, 400)
        }
      }

      // Data layout (unified collection vs per-app) can't be switched here: a credential
      // refresh does not move data, and flipping the strategy in place would orphan the
      // user's existing records. Keep the current strategy; reject any attempted change
      // (the UI also disables the checkbox) and point the user at DB migration.
      if (resource === 'DB' && def.fields.some(f => f.name === 'unifyData')) {
        const currentStrategy = current.dbUnificationStrategy === 'all' ? 'all' : 'db'
        const submittedUnify = submitted.unifyData === true || submitted.unifyData === 'true'
        if ((submittedUnify ? 'all' : 'db') !== currentStrategy) {
          return sendFailure(res, 'To change whether your app data is stored in one unified collection, use “Migrate database” — it safely re-shapes your existing records. A credential refresh keeps your current layout.', WHO, 400)
        }
        if (current.dbUnificationStrategy) newParams.dbUnificationStrategy = current.dbUnificationStrategy
      }

      // Validate the new credentials actually work before saving (so we never lock the user out).
      if (resource === 'FS') {
        const r = await checkFS({ fsParams: newParams })
        if (!r || !r.checkpassed) return sendFailure(res, 'The credentials did not pass the connection test: ' + (r?.err || r?.error || 'unknown'), WHO, 400)
      } else {
        const r = await checkDB({ dbParams: newParams, fsParams: decryptParams(user.fsParams) }, { okToCheckOnLocal: true })
        if (!r || !r.checkpassed) return sendFailure(res, 'The credentials did not pass the connection test: ' + (r?.err || r?.error || 'unknown'), WHO, 400)
      }

      const enc = encryptParams(newParams)
      await allUsersDb.update(userId, resource === 'FS' ? { fsParams: enc } : { dbParams: enc }, { replaceAllFields: false })
      // Drop the cached USER_DS so the new credentials take effect on the next access.
      if (dsManager?.flushAndEvictUserDS) await dsManager.flushAndEvictUserDS(userId)

      return sendApiSuccess(res, { success: true, resource, choice })
    } catch (error) {
      console.error('❌ accountReset.handleRefresh:', error.message)
      return sendFailure(res, error.message, WHO + '.refresh', 500)
    }
  }

  return { handleResetInfo, handleRefresh }
}

export default { createAccountResetController }
