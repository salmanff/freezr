// freezr.info - accountRemoveController.mjs
//
// HTTP handlers for the user-facing /account/remove page. The actual removal logic is shared
// with the admin delete-users flow in services/accountRemoveService.mjs. These handlers do auth,
// password + username-confirmation gating, and shape the responses.

import { sendApiSuccess, sendFailure } from '../../../adapters/http/responses.mjs'
import User from '../../../common/misc/userObj.mjs'
import { SYSTEM_USER_IDS } from '../../../common/helpers/config.mjs'
import { decryptParams } from '../../register/services/registerServices.mjs'
import { describeFsDbParams } from '../../../adapters/datastore/environmentDefaults.mjs'
import { classifyRemoval, describeRemoval, removeUserFromServer } from '../services/accountRemoveService.mjs'

const WHO = 'accountRemoveController'

export const createAccountRemoveController = ({ dsManager, freezrPrefs } = {}) => {
  // Tells the page which mode applies (full delete vs detach) and what storage the user is on.
  const handleRemoveInfo = async (req, res) => {
    try {
      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'Not logged in', WHO, 401)
      const allUsersDb = res.locals?.freezr?.allUsersDb
      if (!allUsersDb) return sendFailure(res, 'Users database not available', WHO, 500)
      const rows = await allUsersDb.query({ user_id: userId }, null)
      const user = rows?.[0]
      if (!user) return sendFailure(res, 'User not found', WHO, 404)

      const fs = decryptParams(user.fsParams) || {}
      const db = decryptParams(user.dbParams) || {}
      // A user gets a CHOICE (detach vs full) whenever ANY of their data is on their own
      // storage — their own cloud FS, their own mongo DB, or both. Users entirely on the
      // host (system/local FS + system/nedb DB) can only fully delete. `keptNoun` adapts the
      // wording: "your files", "your database", or "your files and your database".
      const removal = describeRemoval(user.fsParams, user.dbParams)
      return sendApiSuccess(res, {
        success: true,
        userId,
        hasChoice: removal.hasChoice,
        isCloud: removal.hasChoice, // back-compat alias
        ownsFs: removal.ownsFs,
        ownsDb: removal.ownsDb,
        keptNoun: removal.keptNoun,
        defaultMode: removal.mode,
        isSystemAccount: SYSTEM_USER_IDS.includes(userId),
        fsType: fs.type || null,
        fsLabel: describeFsDbParams(fs, 'FS')?.display || fs.type || 'unknown',
        dbLabel: describeFsDbParams(db, 'DB')?.display || db.type || 'unknown'
      })
    } catch (error) {
      return sendFailure(res, error.message, WHO + '.info', 500)
    }
  }

  const handleRemove = async (req, res) => {
    try {
      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'Not logged in', WHO, 401)
      // System accounts (fradmin/test/public) back the server's own state — never removable here.
      if (SYSTEM_USER_IDS.includes(userId)) return sendFailure(res, 'System accounts cannot be removed', WHO, 403)

      const allUsersDb = res.locals?.freezr?.allUsersDb
      const userDS = res.locals?.freezr?.userDS
      const publicRecordsDb = res.locals?.freezr?.publicRecordsDb
      const publicManifestsDb = res.locals?.freezr?.publicManifestsDb
      const tokenDb = res.locals?.freezr?.appTokenDb
      if (!allUsersDb || !userDS) return sendFailure(res, 'Required resources not available', WHO, 500)

      const { password, confirmUsername, removePublicPosts, mode: requestedMode } = req.body || {}
      if (!password) return sendFailure(res, 'Password is required', WHO, 400)
      if (!confirmUsername || String(confirmUsername).trim().toLowerCase() !== userId) {
        return sendFailure(res, 'Please type your exact user id to confirm removal', WHO, 400)
      }

      const rows = await allUsersDb.query({ user_id: userId }, null)
      const user = rows?.[0]
      if (!user) return sendFailure(res, 'User not found', WHO, 404)
      if (!new User(user).check_passwordSync(password)) return sendFailure(res, 'Wrong password', WHO, 401)

      // Determine the effective mode (don't trust the client blindly):
      //  - host/system users (classify 'full') can ONLY full-delete — detach is meaningless there.
      //  - cloud users (classify 'detach') choose: 'full' (wipe cloud data + account) or 'detach' (keep data).
      const classification = classifyRemoval(user.fsParams, user.dbParams)
      const mode = (classification === 'full') ? 'full' : (requestedMode === 'full' ? 'full' : 'detach')

      const result = await removeUserFromServer({
        dsManager,
        userId,
        freezrPrefs,
        allUsersDb,
        userDS,
        publicRecordsDb,
        publicManifestsDb,
        tokenDb,
        sessionStore: req.sessionStore,
        removePublicPosts: !!removePublicPosts,
        mode,
        userRecord: user
      })

      res.locals.freezr.userDS = null
      return sendApiSuccess(res, { success: true, ...result })
    } catch (error) {
      console.error('❌ accountRemove.handleRemove:', error.message)
      return sendFailure(res, error.message, WHO + '.remove', 500)
    }
  }

  return { handleRemoveInfo, handleRemove }
}

export default { createAccountRemoveController }
