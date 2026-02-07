// freezr.info - Modern ES6 Module - Public App Page Controller
// Handles rendering of public app pages (no authentication required)
//
// Architecture Pattern:
// - Controller handles HTTP concerns (request/response)
// - Uses modern page loader for rendering
// - Returns HTML pages
// - Uses public_pages from manifest instead of pages
// - Prepends 'public/' to file paths when serving files

import { loadDataHtmlAndPage, fileExt } from '../../../adapters/rendering/pageLoader.mjs'
import { endsWith } from '../../../common/helpers/utils.mjs'
import { sendFailure } from '../../../adapters/http/responses.mjs'

/**
 * Generate public app page
 * Similar to generateAppPage but uses public_pages from manifest
 * and prepends 'public/' to file paths
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const generatePublicAppPage = async (req, res) => {
  try {
    const isTestMode = process.env.FREEZR_TEST_MODE === 'true'
    const isPageRequestConfirmation = req.headers['sec-fetch-mode'] === 'navigate'
    
    // In test mode, allow non-browser requests
    if (!isPageRequestConfirmation && !isTestMode) {
      return sendFailure(res, 'unauthorzed page access', { function: 'public.generatePublicAppPage', redirectUrl: '/public?error=unnauthorized access' }, 500 )
    }
    
    // Get manifest from res.locals (set by getPublicAppManifest middleware)
    const manifest = res.locals.freezr?.manifest || {}
    
    // Get app name and user ID from params
    const appName = req.params.app_name
    const userId = req.params.user_id
    
    // Determine page name (default to 'index' if not provided)
    let pageName = req.params.page || 'index'
    
    // Remove .html extension if present
    if (endsWith(pageName, '.html')) {
      pageName = pageName.slice(0, -5)
    }
    

    // normally any public app should have a manifest to declare public objects and publish them but leaving htis in, in case of future adhic requests outside of manifest
    // Use public_pages instead of pages
    if (!manifest.public_pages) {
      manifest.public_pages = {}
    }

    // If page doesn't exist in manifest, create default entry
    if (!manifest.public_pages[pageName]) {
      manifest.public_pages[pageName] = {
        html_file: pageName + '.html',
        css_files: pageName + '.css',
        script_files: [pageName + '.js']
      }
    }
    
    // Set default page title if not present
    if (!manifest.public_pages[pageName].page_title) {
      manifest.public_pages[pageName].page_title = pageName
    }
    
    const pageParams = manifest.public_pages[pageName]
    
    // Get appFS from res.locals (set by middleware)
    const appFS = res.locals.freezr?.appFS
    
    if (!appFS) {
      return sendFailure(res, 'missingSystemAppFS', { function: 'public.generatePublicAppPage', redirectUrl: '/public?error=AppFS is Unavailable' }, 500 )
    }
    
    // Build page options for rendering
    const options = {
      use_non_public_skeleton: true,
      page_title: pageParams.page_title + ' - freezr.info',
      page_url: pageParams.html_file,
      css_files: [],
      script_files: [],
      modules: [],
      messages: { showOnStart: false },
      user_id: userId,
      owner_id: userId,
      user_is_admin: false,
      user_is_publisher: false,
      app_name: appName,
      app_display_name: (manifest && manifest.display_name) ? manifest.display_name : appName,
      app_version: (manifest && manifest.version) ? manifest.version : 'N/A',
      other_variables: null,
      freezr_server_version: res.locals.freezr.freezrVersion,
      server_name: res.locals.freezr.serverName,
      queryresults: null,
      isPublic: true
    }
    
    // Process CSS files - prepend 'public/' to paths and make absolute
    if (pageParams.css_files) {
      const cssFiles = typeof pageParams.css_files === 'string' 
        ? [pageParams.css_files] 
        : pageParams.css_files
      
      cssFiles.forEach((cssFile) => {
        if (fileExt(cssFile) === 'css') {
          // Prepend 'public/' if not already present
          const publicPath = cssFile.startsWith('public/') ? cssFile : 'public/' + cssFile
          // Make absolute path for public app pages
          const absolutePath = `/public/app/@${userId}/${appName}/${publicPath}`
          options.css_files.push(absolutePath)
        } else {
          console.error('❌ Cannot have non-css file used as css:', cssFile, 'for app:', appName)
        }
      })
    }
    
    // Process script files - prepend 'public/' to paths and make absolute
    if (pageParams.script_files) {
      const scriptFiles = typeof pageParams.script_files === 'string' 
        ? [pageParams.script_files] 
        : pageParams.script_files
      
      scriptFiles.forEach((jsFile) => {
        if (fileExt(jsFile) === 'js') {
          // Prepend 'public/' if not already present
          const publicPath = jsFile.startsWith('public/') ? jsFile : 'public/' + jsFile
          // Make absolute path for public app pages
          const absolutePath = `/public/app/@${userId}/${appName}/${publicPath}`
          options.script_files.push(absolutePath)
        } else {
          console.error('❌ Cannot have non-js file used as js:', jsFile, 'for app:', appName)
        }
      })
    }
    
    // Process modules - prepend 'public/' to paths and make absolute
    if (pageParams.modules) {
      const modules = typeof pageParams.modules === 'string' 
        ? [pageParams.modules] 
        : pageParams.modules
      
      modules.forEach((jsFile) => {
        if (fileExt(jsFile) === 'js' || fileExt(jsFile) === 'mjs') {
          // Prepend 'public/' if not already present
          const publicPath = jsFile.startsWith('public/') ? jsFile : 'public/' + jsFile
          // Make absolute path for public app pages
          const absolutePath = `/public/app/@${userId}/${appName}/${publicPath}`
          options.modules.push(absolutePath)
        } else {
          console.error('❌ Cannot have non-js file used as a js module:', jsFile, 'for app:', appName)
        }
      })
    }
    
    // Prepend 'public/' to html_file path
    if (pageParams.html_file) {
      options.page_url = pageParams.html_file.startsWith('public/') 
        ? pageParams.html_file 
        : 'public/' + pageParams.html_file
    }
    
    // Render page using modern page loader adapter
    res.locals.freezr.permGiven = true
    return loadDataHtmlAndPage(appFS, res, options)
    
  } catch (error) {
    sendFailure(res, 'systemError', { function: 'public.generatePublicAppPage', redirectUrl: '/public?error=System Error', error }, 500 )
  }
}

/**
 * Serve public app file
 * Prepends 'public/' to the file path before serving
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const servePublicAppFile = (req, res) => {
  const resource = req.params.resource
  if (!resource) {
    return sendFailure(res, 'Resource path is required', 'publicAppPageController', 400)
  }

  // It's a file - prepend 'public/' to the path
  const appFS = res.locals.freezr?.appFS
  if (!appFS) {
    return sendFailure(res, 'appFS not found', 'publicAppPageController', 500)
  }
  
  res.locals.freezr.permGiven = true
  res.locals.flogger?.track('file')
  
  // Prepend 'public/' if not already present
  const publicPath = resource.startsWith('public/') ? resource : 'public/' + resource
  
  res.locals.freezr.permGiven = true
  return appFS.sendPublicAppFile(publicPath, res, {})
}

/**
 * Route handler for public app resources (pages and files)
 * Determines if the resource is a page or file and calls the appropriate handler
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const servePublicPageOrFile = (req, res) => {
  const resource = req.params.resource
  if (!resource) {
    return sendFailure(res, 'Resource path is required', 'publicAppPageController', 400)
  }

  // Check if it's a page request (ends with .html or has no extension)
  const isPage = resource.endsWith('.html') || !resource.includes('.')
  
  if (isPage) {
    // It's a page - set page param and call generatePublicAppPage
    req.params.page = resource
    return generatePublicAppPage(req, res)
  } else {
    // It's a file - serve it
    return servePublicAppFile(req, res)
  }
}

/**
 * Factory function to create public app page controller
 * Returns an object with handler functions
 * 
 * @returns {Object} Controller with handler functions
 */
export const createPublicAppPageController = () => {
  return {
    generatePublicAppPage,
    servePublicAppFile,
    servePublicPageOrFile
  }
}

export default createPublicAppPageController

