// freezr.info - Modern ES6 Module - Account Logout Controller accountLogoutController.mjs
// Handles logout and token invalidation for account feature

import { loadDataHtmlAndPage } from '../../../adapters/rendering/pageLoader.mjs'
import { APP_TOKEN_OAC } from '../../../common/helpers/config.mjs'
import { getAndCheckCookieTokenForLoggedInUser } from '../../../middleware/tokens/tokenHandler.mjs'


/**
 * Account-specific logout action
 * Handles logout and token invalidation for account feature
 */
export const createLogoutAction = (dsManager) => {
  return async (req, res, next) => {
    const tokenDb = dsManager.getDB(APP_TOKEN_OAC)

    try {
      const tokenInfo = await getAndCheckCookieTokenForLoggedInUser(
        tokenDb,
        req.session,
        req.cookies // , optional for logout only
        // true
      )
      
      if (!tokenInfo || !tokenInfo.app_token) {
        res.locals.flogger.error('Token not found on log out, or user mismatch', { function: 'createLogoutAction', error: 'Token not found or user mismatch' })
      } else {
        await tokenDb.update({ app_token: tokenInfo.app_token }, { expiry: new Date().getTime() - 1000 }, { replaceAllFields: false })
      }
    } catch (error) {
      res.locals.flogger.error('Error updating token - logging out in any case', { function: 'createLogoutAction', error })
      // Continue logout even if token update fails
    }
      
    const deviceCode = req.session.device_code
    
    // Regenerate session for security (ensures clean app logout)
    req.session.regenerate(async (regenerateErr) => {
      if (regenerateErr) {
        res.locals.flogger.error('Error regenerating session after log out', { function: 'createLogoutAction', error: regenerateErr })
        // Continue with logout even if regeneration fails
      }
      if (res.headersSent) {
        console.error('Headers already sent in createLogoutAction - investigate!', { function: 'createLogoutAction' })
        return
      }
      req.session.device_code = deviceCode
      // return res.redirect('/account/login')

      const theDs = dsManager.users.fradmin 

      const appFS = await theDs.getorInitAppFS('info.freezr.account', {})
    
      if (!appFS) {
        console.error('❌ appFS not found ...')
        return res.status(500).send('Internal server error - appFS oe page not available')
      }      
      // onsole.log('📋 Using manifest for page:', page, manifest)

      
      
      // Build page options for rendering using manifest
      const options = {
        page_title: 'logout',
        page_url: 'account_logout.html',
        app_name: 'info.freezr.account',
        script_files:  [ '/app/info.freezr.public/public/redirectToLogin.js' ],
        css_files:  [ '/app/info.freezr.public/public/freezr_style.css' ],
        modules: [],
        server_name: res.locals.freezr.serverName,
        freezr_server_version: res.locals.freezr.freezrVersion,
      }
      
      // Render page using modern page loader adapter
      return loadDataHtmlAndPage(appFS, res, options)

    })
  }
}