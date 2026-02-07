// freezr.info - Modern ES6 Module - App Page Controller
// Handles rendering of app pages for authenticated users
//
// Architecture Pattern:
// - Controller handles HTTP concerns (request/response)
// - Uses modern page loader for rendering
// - Returns HTML pages
// - Uses functional approach with closures for dependency injection

import { loadDataHtmlAndPage, fileExt } from '../../../adapters/rendering/pageLoader.mjs'
import { endsWith } from '../../../common/helpers/utils.mjs'



/**
 * Generate app page for authenticated users
 * Modernizes appHandler.generatePage from freezr_system/app_handler.js
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const generateAppPage = async (req, res) => {
  // Security: Called only after setupGuard, loggedInGuard, getManifest, addUserDSAndAppFSand, systemAppOrTargetAppRequest
  // console.log('🏠 generateAppPage called with details:', {
  //   method: req.method,
  //   url: req.url,
  //   app_name: req.params.app_name,
  //   page: req.params.page,
  //   sessionId: req.sessionID,
  //   userId: req.session.logged_in_user_id
  // })
  
  try {
    const isTestMode = process.env.FREEZR_TEST_MODE === 'true'
    const isPageRequestConfirmation = req.headers['sec-fetch-mode'] === 'navigate'
    
    // In test mode, allow non-browser requests to get app tokens
    if (!isPageRequestConfirmation && !isTestMode) {
      throw new Error('Not a page request in app')
    }
    // Get manifest from res.locals (set by getTargetManifest middleware)
    const manifest = res.locals.freezr?.manifest || {}
    
    // Get app name from params
    const appName = req.params.app_name
    
    // Determine page name (default to 'index' if not provided)
    let pageName = req.params.page || 'index'
    
    // Remove .html extension if present
    if (endsWith(pageName, '.html')) {
      pageName = pageName.slice(0, -5)
    }
    
    // Ensure manifest.pages exists
    if (!manifest.pages) {
      manifest.pages = {}
    }
    
    // If page doesn't exist in manifest, create default entry
    if (!manifest.pages[pageName]) {
      manifest.pages[pageName] = {
        html_file: pageName + '.html',
        css_files: pageName + '.css',
        script_files: [pageName + '.js']
      }
    }
    
    // Set default page title if not present
    if (!manifest.pages[pageName].page_title) {
      manifest.pages[pageName].page_title = pageName
    }
    
    const pageParams = manifest.pages[pageName]
    
    // Get appFS from res.locals (set by middleware)
    const appFS = res.locals.freezr?.appFS
    
    if (!appFS) {
      console.error('❌ appFS not found in res.locals.freezr')
      return res.status(500).send('Internal server error - appFS not available (4)')
    }
    
    // Get token info for app token
    const tokenInfo = res.locals.freezr?.tokenInfo
    if (!tokenInfo || !tokenInfo.app_token) {
      console.error('❌ Token info or app_token not found in res.locals.freezr')
      return res.status(500).send('Internal server error - app token not available')
    }

    if (tokenInfo.owner_id !== req.session.logged_in_user_id || tokenInfo.app_name !== appName) {
      // this is redundant due to systemAppOrTargetAppRequest but checked any ways
      console.error('❌ Token info or app_name does not match the request', { tokenInfo, appName })
      return res.status(403).send('Unauthorized to access app page')
    }
    
    // Build page options for rendering
    const options = {
      page_title: pageParams.page_title + ' - freezr.info',
      page_url: pageParams.html_file || './info.freezr.public/pageNotFound.html',
      css_files: [],
      script_files: [],
      modules: [],
      messages: { showOnStart: false },
      user_id: req.session.logged_in_user_id,
      owner_id: tokenInfo.owner_id || req.session.logged_in_user_id,
      user_is_admin: req.session.logged_in_as_admin,
      user_is_publisher: req.session.logged_in_as_publisher,
      app_name: appName,
      app_display_name: (manifest && manifest.display_name) ? manifest.display_name : appName,
      app_version: (manifest && manifest.version) ? manifest.version : 'N/A',
      other_variables: null,
      freezr_server_version: res.locals.freezr.freezrVersion,
      server_name: res.locals.freezr.serverName,
      queryresults: null,
      hasLogo: res.locals.freezr?.hasLogo || false
    }
    
    // Handle initial_query if present (similar to old app_handler.js)
    if (pageParams.initial_query) {
      // Only supports type: db_query at this time
      // const queryParams = pageParams.initial_query
      // const manifestPermissionSchema = (manifest.permissions && queryParams.permission_name) 
      //   ? manifest.permissions[queryParams.permission_name] 
      //   : null
      
      // let appTable = null
      
      // if (manifestPermissionSchema) {
      //   appTable = appName + (manifestPermissionSchema.collection_name 
      //     ? ('.' + manifestPermissionSchema.collection_name) 
      //     : '')
        
      //   if (queryParams.collection_name && manifestPermissionSchema.collection_name !== queryParams.collection_name) {
      //     console.warn('⚠️ Permission schema collection inconsistent with requested collection', {
      //       requested: queryParams.collection_name,
      //       schema: manifestPermissionSchema.collection_name,
      //       app: appName
      //     })
      //   }
      // } else if (queryParams.collection_name) {
      //   appTable = appName + (queryParams.collection_name ? ('.' + queryParams.collection_name) : '')
      // } else {
      //   console.error('❌ generateAppPage: Have to define either permission_name or collection_name in initial_query of manifest')
      //   // Continue without query results
      // }
      
      // TODO: Implement db_query execution for initial_query
      // For now, we'll skip the query and render without results
      // This needs to be implemented similar to how account pages handle initial_query_func
      console.warn('⚠️ initial_query not yet fully implemented for app pages - skipping query')
    }
    
    // Sections added by cursor but not needed
    /**
     * Helper function to get file extension
     */
    // function fileExt(filePath) {
    //   if (!filePath) return ''
    //   const parts = filePath.split('.')
    //   return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : ''
    // } 
    // Process CSS files
    if (pageParams.css_files) {
      const cssFiles = typeof pageParams.css_files === 'string' 
        ? [pageParams.css_files] 
        : pageParams.css_files
      
      cssFiles.forEach((cssFile) => {
        if (fileExt(cssFile) === 'css') {
          options.css_files.push(cssFile)
        } else {
          console.error('❌ Cannot have non-css file used as css:', cssFile, 'for app:', appName)
        }
      })
    }
    
    // Process script files
    if (pageParams.script_files) {
      const scriptFiles = typeof pageParams.script_files === 'string' 
        ? [pageParams.script_files] 
        : pageParams.script_files
      
      scriptFiles.forEach((jsFile) => {
        if (fileExt(jsFile) === 'js') {
          options.script_files.push(jsFile)
        } else {
          console.error('❌ Cannot have non-js file used as js:', jsFile, 'for app:', appName)
        }
      })
    }
    
    // Process modules
    if (pageParams.modules) {
      const modules = typeof pageParams.modules === 'string' 
        ? [pageParams.modules] 
        : pageParams.modules
      
      modules.forEach((jsFile) => {
        if (fileExt(jsFile) === 'js' || fileExt(jsFile) === 'mjs') {
          options.modules.push(jsFile)
        } else {
          console.error('❌ Cannot have non-js file used as a js module:', jsFile, 'for app:', appName)
        }
      })
    }
    
    // Set cookie with app token
    let appPrefix = '/apps/'
    // appprefix2 used to trnsition from apps/app_name to app/app_name
    let appPrefix2 = '/app/'
    const parts = req.originalUrl.split('/')
    if (parts.length > 1 && parts[1] === 'oapp') {
      appPrefix = '/oapp/' + tokenInfo.owner_id + '/'
      appPrefix2 = null
    }
    
    res.cookie('app_token_' + req.session.logged_in_user_id, tokenInfo.app_token, { 
      path: appPrefix + appName 
    })
    if (appPrefix2) {
      res.cookie('app_token_' + req.session.logged_in_user_id, tokenInfo.app_token, { 
        path: appPrefix2 + appName 
      })
    }
    
    // Render page using modern page loader adapter
    return loadDataHtmlAndPage(appFS, res, options)
    
  } catch (error) {
    console.error('❌ Error generating app page:', error)
    console.error('Error stack:', error.stack)
    res.status(500).send('Internal server error')
  }
}

/**
 * Factory function to create app page controller
 * Returns an object with handler functions
 * 
 * @returns {Object} Controller with handler functions
 */
export const createAppPageController = () => {
  return {
    generateAppPage
  }
}

export default createAppPageController

