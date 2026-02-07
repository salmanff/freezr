// freezr.info - Modern ES6 Module - Login Page Controller
// Handles the account login page rendering
// 
// Architecture: Controller layer - orchestrates calls to services
// Receives context from middleware via res.locals (no req mutation)

import { ensureDeviceCode } from '../../../middleware/auth/sessionUtils.mjs'
import { loadDataHtmlAndPage } from '../../../adapters/rendering/pageLoader.mjs'
import { devAssert, devAssertType, devAssertProps } from '../../../middleware/devAssertions.mjs'
import helpers from '../../../common/helpers/utils.mjs'

/**
 * Modern login page controller
 * Renders the login page for unauthenticated users
 * 
 * Prerequisites (handled by middleware):
 * - setupCheck: Freezr is configured
 * - loginRedirect: User is not already logged in
 * - publicAccountContext: res.locals.freezr is populated
 * 
 * Context received from middleware (in res.locals.freezr):
 * - freezrVersion: Freezr version
 * - isSetup: Whether freezr is configured
 * - appName: App requesting login
 * - appFS: Public user's app filesystem
 * - selfRegOptions: Self-registration settings
 * - serverName: Protocol + host
 * 
 * @param {object} req - Express request
 * @param {object} res - Express response
 */
export const generateLoginPage = async (req, res) => {
  res.locals.flogger.debug(`login ✅ [${req.id}] 🔐 generateLoginPage: Starting login page generation`)
  
  // Development assertions for request validation
  // Note: req.id might not exist in transitional route, so we'll skip that assertion
  if (req.id) {
    devAssert(req.id, 'Request should have an ID')
  }
  devAssertType(res.locals.freezr, 'object', 'res.locals.freezr')
  devAssertProps(res.locals.freezr, ['appFS', 'serverName', 'freezrVersion', 'selfRegOptions'], 'res.locals.freezr')
  

  
  // Ensure session exists
  if (!req.session) {
    res.locals.flogger.debug('login 🔑 generateLoginPage: Session does not exist, creating new session')
    req.session = {}
  }
  if (!req.session.device_code) {
    res.locals.flogger.debug('login 🔑 generateLoginPage: Device code does not exist, creating new device code')
    req.session.device_code = helpers.randomText(20)
  }
  res.locals.flogger.debug('login 🔑 generateLoginPage: Device code:', req.session.device_code)
  // onsole.log('login 🔑 generateLoginPage: Device code:', req.session.device_code)
  
  // Ensure device code exists in session
  // ensureDeviceCode(req.session, helpers)
  
  // Build page options for rendering
  const options = {
    page_title: 'Login (Freezr)',
    css_files: ['/app/info.freezr.public/public/freezr_style.css'],
    initial_query: null,
    server_name: res.locals.freezr.serverName,
    freezr_server_version: res.locals.freezr.freezrVersion,
    app_name: 'info.freezr.public',
    page_url: 'public/account_login.html',
    script_files: ['public/account_login.js'],
    other_variables:
      ' var freezrServerStatus = ' + JSON.stringify(res.locals.freezr.freezrStatus) + ';' +
      ' var freezrAllowSelfReg = ' + res.locals.freezr.allowSelfReg + ';'
  }
  
  // Development assertions for options validation
  devAssertType(options, 'object', 'options')
  devAssertProps(options, ['page_title', 'page_url', 'app_name'], 'options')
  devAssertType(res.locals.freezr.appFS, 'object', 'res.locals.freezr.appFS')
  
  // Render page using modern page loader adapter
  // console.log(`[${req.id}] 📄 generateLoginPage: Rendering page with appFS for app: ${options.app_name}`)
  return loadDataHtmlAndPage(res.locals.freezr.appFS, res, options)
}

export default {
  generateLoginPage
}

