// freezr.info - Modern ES6 Module - Admin Page Controller
// Handles rendering of admin pages
//
// Architecture Pattern:
// - Controller handles HTTP concerns (request/response)
// - Uses modern page loader for rendering
// - Returns HTML pages
// - Uses functional approach with closures for dependency injection

import { loadDataHtmlAndPage } from '../../../adapters/rendering/pageLoader.mjs'
import { sendAuthFailure } from '../../../adapters/http/responses.mjs'
/**
 * Generate admin page for authenticated admin users
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const generateAdminPage = async (req, res) => {
  try {
    const subPage = req.params.sub_page || 'home'
    
    // Get appFS from res.locals (set by middleware)
    // For admin pages, we use fradmin's appFS for info.freezr.admin
    const fradminDS = res.locals.freezr?.fradminDS
    const appFS = fradminDS ? await fradminDS.getorInitAppFS('info.freezr.admin', {}) : null
    
    if (!appFS) {
      console.error('❌ appFS not found in res.locals.freezr')
      return res.status(500).send('Internal server error - appFS not available (1)')
    }
    
    // Get manifest from res.locals (set by addAdminManifestToResLocals middleware)
    const manifest = res.locals.freezr?.manifest
    
    if (!manifest) {
      console.error('❌ Manifest not found in res.locals.freezr.manifest')
      return res.status(500).send('Internal server error - manifest not available')
    }
    
    // Build page options for rendering using manifest
    const options = {
      page_title: manifest.page_title,
      css_files: manifest.css_files || [],
      page_url: manifest.page_url,
      app_name: manifest.app_name || 'info.freezr.admin',
      script_files: manifest.script_files || [],
      modules: manifest.modules || [],
      server_name: res.locals.freezr.serverName,
      freezr_server_version: res.locals.freezr.freezrVersion,
      user_id: req.session.logged_in_user_id,
      user_is_admin: req.session.logged_in_as_admin,
      user_is_publisher: req.session.logged_in_as_publisher,
      other_variables: manifest.other_variables || '',
      sub_page: subPage
    }
    
    // Add initial_query if present in manifest
    if (manifest.initial_query) {
      const owner = manifest.initial_query.owner
      const appTable = manifest.initial_query.app_table
      const q = manifest.initial_query.q || {}
      const dsManager = res.locals.freezr?.dsManager
      const theDb = await dsManager.getorInitDb({ owner: owner, app_table: appTable }, { freezrPrefs: res.locals.freezr?.freezrPrefs })
      const results = await theDb.query(q, {})
      // console.log('results', results)
      options.queryresults = { data: results }
    } else if (manifest.initial_query_func) {
      // Execute the query function with userDS\

      const queryResults = await manifest.initial_query_func(res.locals.freezr?.freezrPrefs)
      options.queryresults = queryResults
      // console.log('🔄 generateAdminPage - queryresults:', { results: options.queryresults })
    }

    // one extra security check
    if (!req.session.logged_in_as_admin) {
      return sendAuthFailure(res, {
        type: 'unauthorizedAccessToAdminPage',
        message: 'Unauthorized Access to Admin Page',
        path: req.path,
        url: req.url,
        error: 'Unauthorized Access to Admin Page',
        statusCode: 403
      })
    }
    res.locals.freezr.permGiven = true

    // Set cookie for app token
    if (res.locals.freezr?.tokenInfo?.app_token) {
      res.cookie('app_token_' + req.session.logged_in_user_id, res.locals.freezr.tokenInfo.app_token, { path: '/admin' })
      res.cookie('app_token_' + req.session.logged_in_user_id, res.locals.freezr.tokenInfo.app_token, { path: '/app/info.freezr.admin' })
      res.cookie('app_token_' + req.session.logged_in_user_id, res.locals.freezr.tokenInfo.app_token, { path: '/apps/info.freezr.admin' })
    }

    
    // Render page using modern page loader adapter
    return loadDataHtmlAndPage(appFS, res, options)
    
  } catch (error) {
    console.error('❌ Error generating admin page:', error)
    console.error('Error stack:', error.stack)
    res.status(500).send('Internal server error')
  }
}

/**
 * Factory function to create admin page controller
 * Returns an object with handler functions
 * 
 * @returns {Object} Controller with handler functions
 */
export const createAdminPageController = () => {
  return {
    generateAdminPage
  }
}

export default createAdminPageController

