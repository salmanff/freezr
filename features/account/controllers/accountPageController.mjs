// freezr.info - Modern ES6 Module - Account Page Controller
// Handles rendering of account pages for authenticated users
//
// Architecture Pattern:
// - Controller handles HTTP concerns (request/response)
// - Uses modern page loader for rendering
// - Returns HTML pages
// - Uses functional approach with closures for dependency injection

import { loadDataHtmlAndPage } from '../../../adapters/rendering/pageLoader.mjs'
import { 
  getSystemDataPageManifest
} from '../services/accountManifestService.mjs'


/**
 * Generate account page for authenticated users
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const generateAccountPage = async (req, res) => {
  // Security: Called only after setupGuard, accountLoggedInUserPage, addUserAppsAndPermDBs,
  // console.log('🏠 generateAccountPage called with details:', {
  //   method: req.method,
  //   url: req.url,
  //   page: req.params.page,
  //   targetApp: req.params.target_app,
  //   sessionId: req.sessionID,
  //   userId: req.session.logged_in_user_id
  // })
  
  try {
    const page = req.params.page
    
    // Get appFS from res.locals (set by middleware)
    const appFS = res.locals.freezr?.appFS

    // console.log('🏠 generateAccountPage - appFS', res.locals.freezr)
    
    if (!appFS) {
      console.error('❌ appFS not found in res.locals.freezr')
      return res.status(500).send('Internal server error - appFS oe page not available')
    }
    
    // Get manifest from res.locals (set by addManifestToResLocals middleware)
    const manifest = res.locals.freezr?.manifest
    
    if (!manifest) {
      console.error('❌ Manifest not found in res.locals.freezr.manifest')
      return res.status(500).send('Internal server error - manifest not available')
    }
    
    // onsole.log('📋 Using manifest for page:', page, manifest)
    
    // Build page options for rendering using manifest
    const options = {
      page_title: manifest.page_title,
      css_files: manifest.css_files || [],
      page_url: manifest.page_url,
      app_name: manifest.app_name || 'info.freezr.account',
      script_files: manifest.script_files || [],
      modules: manifest.modules || [],
      server_name: res.locals.freezr.serverName,
      freezr_server_version: res.locals.freezr.freezrVersion,
      user_id: req.session.logged_in_user_id,
      user_is_admin: req.session.logged_in_as_admin,
      user_is_publisher: req.session.logged_in_as_publisher,
      other_variables: manifest.other_variables || '' + 'const publicLandingPage = "' +
       ((res.locals.freezr.freezrPrefs?.public_landing_page || '') + '";'),
      // Store manifest for potential use by initial_query_func in next step
      manifest: manifest
    }

    // Handle initial_query_func if present
    const isPageRequestConfirmation = req.headers['sec-fetch-mode'] === 'navigate'
    if (isPageRequestConfirmation && manifest.initial_query_func) {
      // onsole.log('🔄 Executing initial query function:', manifest.initial_query_func.name || 'anonymous')
      
      try {
        // Get userDS from res.locals
        const userDS = res.locals.freezr?.userDS
        if (!userDS) {
          throw new Error('User data store not available in res.locals.freezr.userDS')
        }
        
        // Execute the query function with userDS
        const queryResults = await manifest.initial_query_func(userDS)
        
        // Add query results to options
        options.queryresults = queryResults
        //onsole.log('✅ Initial query completed successfully')
        
      } catch (queryError) {
        console.error('❌ Error in initial query:', queryError)
        // Continue with page rendering even if query fails
        options.queryresults = { error: 'Failed to load initial data' }
      }
    } else if (manifest.initial_query_func) {
      console.warn('ℹ️ TEMPORARILY DISABLING QUERY FUNC - secFetchMode not working - need to implement nonce system 2025-11')
    }
    if (!isPageRequestConfirmation) {
      throw new Error('Not a page request')
    }

    res.cookie('app_token_' + req.session.logged_in_user_id, res.locals.freezr.tokenInfo.app_token, { path: '/account' })
    res.cookie('app_token_' + req.session.logged_in_user_id, res.locals.freezr.tokenInfo.app_token, { path: '/app/info.freezr.account' })
    res.cookie('app_token_' + req.session.logged_in_user_id, res.locals.freezr.tokenInfo.app_token, { path: '/apps/info.freezr.account' })

    // Render page using modern page loader adapter
    return loadDataHtmlAndPage(appFS, res, options)
    
  } catch (error) {
    console.error('❌ Error generating account page:', error)
    console.error('Error stack:', error.stack)
    res.status(500).send('Internal server error')
  }
}

/**
 * Generate system data page for app data management
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * NOT YET CHECKED 2025-10
 */
const generateSystemDataPage = async (req, res) => {
  throw new Error('generateSystemDataPage needs to be redone - move getSystemDataPageManifest')
  console.log('📊 generateSystemDataPage called')
  console.log('Request details:', {
    method: req.method,
    url: req.url,
    action: req.params.action,
    targetApp: req.params.target_app,
    sessionId: req.sessionID,
    userId: req.session.logged_in_user_id
  })
  
  try {
    // Ensure user is logged in
    if (!req.session.logged_in_user_id) {
      console.log('❌ User not logged in, redirecting to /account/login')
      return res.redirect('/account/login')
    }
    
    // Get system data page manifest
    const pageParams = {
      action: req.params.action,
      target_app: req.params.target_app
    }
    
    const manifest = getSystemDataPageManifest(pageParams)
    console.log('📋 Using system data manifest:', manifest)
    
    // Get appFS from res.locals (set by middleware)
    const appFS = res.locals.freezr?.appFS
    
    if (!appFS) {
      console.error('❌ appFS not found in res.locals.freezr')
    }
    
    // Build page options for rendering using manifest
    const options = {
      page_title: manifest.page_title,
      css_files: manifest.css_files || [],
      page_url: manifest.page_url,
      app_name: manifest.app_name || 'info.freezr.account',
      script_files: manifest.script_files || [],
      modules: manifest.modules || [],
      server_name: res.locals.freezr.serverName,
      freezr_server_version: res.locals.freezr.freezrVersion,
      user_id: req.session.logged_in_user_id,
      user_is_admin: req.session.logged_in_as_admin,
      user_is_publisher: req.session.logged_in_as_publisher,
      other_variables: manifest.other_variables || '',
      manifest: manifest
    }
    
    console.log('📄 Loading system data page with options:', {
      page_title: options.page_title,
      page_url: options.page_url,
      app_name: options.app_name,
      user_id: options.user_id
    })
    
    // Handle initial_query_func if present
    if (manifest.initial_query_func) {
      console.log('🔄 Executing initial query function for system data page:', manifest.initial_query_func.name || 'anonymous')
      
      try {
        // Get userDS from res.locals
        const userDS = res.locals.freezr?.userDS
        if (!userDS) {
          throw new Error('User data store not available in res.locals.freezr.userDS')
        }
        
        // Execute the query function with userDS
        const queryResults = await manifest.initial_query_func(userDS)
        
        // Add query results to options
        options.queryresults = queryResults
        console.log('✅ Initial query completed successfully for system data page')
        
      } catch (queryError) {
        console.error('❌ Error in initial query for system data page:', queryError)
        // Continue with page rendering even if query fails
        options.queryresults = { error: 'Failed to load initial data' }
      }
    } else {
      console.log('ℹ️ No initial query function for this system data page')
    }
    
    // Render page using modern page loader adapter
    return loadDataHtmlAndPage(appFS, res, options)
    
  } catch (error) {
    console.error('❌ Error generating system data page:', error)
    console.error('Error stack:', error.stack)
    res.status(500).send('Internal server error')
  }
}

/**
 * Factory function to create account page controller
 * Returns an object with handler functions
 * 
 * @returns {Object} Controller with handler functions
 */
export const createAccountPageController = () => {
  return {
    generateAccountPage,
    generateSystemDataPage
  }
}

export default createAccountPageController
