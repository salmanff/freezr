// freezr.info - Modern ES6 Module - Page Loader Adapter
// Modern page rendering that replicates file_handler functionality
// 
// Architecture: Adapter layer - provides clean interface for page rendering
// Replicates load_data_html_and_page and load_page_html without legacy dependencies

import fs from 'fs' 
import path from 'path'
import { fileURLToPath } from 'url'
import { sendContent, sendFailure } from '../http/responses.mjs'
import { devAssert, devAssertType, devAssertNotNull, devTime } from '../../middleware/devAssertions.mjs'
import { randomText, startsWith } from '../../common/helpers/utils.mjs'
import { isSystemApp } from '../../common/helpers/config.mjs'

// Get current directory for ES6 modules
// TODO-LATER: When Node.js 20+ becomes minimum requirement, replace with:
// const skeletonPath = import.meta.resolve('../../html_skeleton_public.html')
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Constants from file_handler.js
const FREEZR_CORE_CSS = '<link rel="stylesheet" href="/app/info.freezr.public/public/freezr_core.css" type="text/css" />'
const FREEZR_CORE_JS = '<script src="/app/info.freezr.public/public/freezrApiV2.js" type="text/javascript"></script>'
// const FREEZR_CORE_JS = '<script src="public/app/@public/info.freezr.public/public/freezrApiV2.js" type="text/javascript"></script>'

/**
 * Modern page loader that replicates load_data_html_and_page functionality
 * 
 * @param {object} appFS - App filesystem (from res.locals.freezr.appFS)
 * @param {object} res - Express response object
 * @param {object} options - Page options (title, css, scripts, etc.)
 * @returns {Promise} Express response
 */
export const loadDataHtmlAndPage = async (appFS, res, options) => {
  // onsole.log(` 📖 loadDataHtmlAndPage: Loading page ${options.page_url} for app ${options.app_name}`)
  
  // Development assertions for input validation
  devAssertNotNull(appFS, 'appFS')
  devAssertType(appFS, 'object', 'appFS')
  devAssertType(appFS.readAppFile, 'function', 'appFS.readAppFile')
  devAssertNotNull(options, 'options')
  devAssertType(options, 'object', 'options')
  devAssertNotNull(options.page_url, 'options.page_url')
  devAssertNotNull(options.app_name, 'options.app_name')
  
  try {
    // onsole.log('load_data_html_and_page for ' + JSON.stringify(options.page_url))
    
    // Read the HTML content from appFS using native async method
    let htmlContent
    try {
      htmlContent = await appFS.readAppFile(options.page_url, null) // await devTime('appFS.readAppFile', () => appFS.readAppFile(options.page_url, null))
      
      // Development assertions for content validation
      devAssertNotNull(htmlContent, 'htmlContent after successful read')
      devAssertType(htmlContent, 'string', 'htmlContent')
      devAssert(htmlContent.length > 0, 'htmlContent should not be empty')
      
    } catch (err) {
      console.error('load_data_html_and_page got err reading:', { user: options.user_id, app: options.app_name, page: options.page_url, error: err })
      // Fallback to file not found page
      const fallbackPath = path.join(__dirname, '../../systemapps/info.freezr.public/public/pageNotFound.html')
      htmlContent = fs.readFileSync(fallbackPath, 'utf8')
      
      // Development assertion for fallback content
      devAssertNotNull(htmlContent, 'fallback htmlContent')
    }
    
    // Handle Mustache templating if queryresults provided
    let finalHtmlContent = htmlContent
    if (options.queryresults) {
      const Mustache = await import('../../common/misc/mustache.mjs')
      finalHtmlContent = Mustache.default.render(htmlContent, options.queryresults)
    }
    
    // Set the page HTML and call load_page_html
    options.page_html = finalHtmlContent
    return loadPageHtml(res, options)
    
  } catch (error) {
    console.error('Error in loadDataHtmlAndPage:', error)
    sendFailure(res, 'systemError', { function: 'loadDataHtmlAndPage', redirectUrl: '/public?error=System Error', error }, 500 )
  }
}

/**
 * Modern page loader that replicates load_page_html functionality
 * 
 * @param {object} appFS - App filesystem (from res.locals.freezr.appFS)
 * @param {object} res - Express response object
 * @param {object} options - Page options (title, css, scripts, etc.)
 * @returns {Promise} Express response
 */
export const loadPageHtml = async (res, options) => {
  try {
    // console.log('load page html ', options.page_url)
      
    // Read the HTML skeleton
    const skeletonFile = (options.isPublic && !options.use_non_public_skeleton) ? 'html_skeleton_public.html' : 'html_skeleton.html'
    const skeletonPath = path.join(__dirname, skeletonFile)
    
    let contents
    try {
      const buffer = await fs.promises.readFile(skeletonPath)
      contents = buffer.toString('utf8')
    } catch (err) {
      console.error('err reading skeleton file', skeletonFile, err)
      throw err
    }
    
    // Set defaults
    if (!options.app_name) {
      options.app_name = 'info.freezr.public'
      options.page_url = options.page_url || 'pageNotFound.html'
    }
    
    // Generate favicon link tag - use app logo if available, otherwise default
    // Cache-busting query param (app name) ensures browser loads correct favicon on navigation
    const faviconUrl = options.hasLogo
      ? `/app/info.freezr.account/app2app/${options.app_name}/static/logo.png?app=${options.app_name}`
      : '/app/info.freezr.public/public/static/favicon.ico?app=system'
    const faviconType = options.hasLogo ? 'image/png' : 'image/x-icon'
    const faviconHtml = `<link rel="icon" type="${faviconType}" href="${faviconUrl}">`
    
    // Replace template variables
    let finalContents = contents
      .replace('{{PAGE_TITLE}}', options.page_title ? options.page_title : 'app - freezr')
      .replace('{{PAGE_URL}}', partUrlPathTo(options.user_id, options.app_name, options.page_url))
      .replace('{{APP_CODE}}', options.app_code ? options.app_code : '')
      .replace('{{APP_NAME}}', options.app_name)
      .replace('{{APP_VERSION}}', options.app_version || '')
      .replace('{{APP_DISPLAY_NAME}}', options.app_display_name ? options.app_display_name : options.app_name)
      .replace('{{USER_ID}}', options.user_id ? options.user_id : '')
      .replace('{{USER_IS_ADMIN}}', Boolean(options.user_is_admin))
      .replace('{{USER_IS_PUBLISHER}}', Boolean(options.user_is_publisher))
      .replace('{{FREEZR_SERVER_VERSION}}', options.freezr_server_version ? options.freezr_server_version : 'N/A')
      .replace('{{SERVER_NAME}}', options.server_name || '')
      .replace('{{FREEZR_CORE_CSS}}', FREEZR_CORE_CSS)
      .replace('{{FREEZR_CORE_JS}}', FREEZR_CORE_JS)
      .replace('{{META_TAGS}}', options.meta_tags ? options.meta_tags : '')
      .replace('{{FAVICON}}', faviconHtml)
      .replace('{{NO_COMMS_CSP}}', "connect-src 'self'; object-src 'none';") //
      // .replace('{{NO_COMMS_CSP}}', "") // connect-src 'self'; default-src 'self';

      // Add nonce for security
    const nonce = randomText(10)
    finalContents = finalContents.replace(/{{FREEEZR-SCRIPT-NONCE}}/g, nonce)
    
    // Process CSS files
    let cssFiles = ''
    const userId = isSystemApp(options.app_name) ? null : options.owner_id
    if (options.css_files) {
      const cssArray = Array.isArray(options.css_files) ? options.css_files : [options.css_files]
      cssArray.forEach(file => {
        if (typeof file === 'string') {
          // startsWith(file, '/') s trick to handle public file paths
          const thePath = (startsWith(file, 'http') || startsWith(file, '/')) ? file : partUrlPathToLoggedInPathResource(userId, options.app_name, file)
          if (fileExt(thePath) === 'css') {
            cssFiles += ` <link rel="stylesheet" href="${thePath}" type="text/css" />`
          } else {
            console.error('ERROR - NON CSS FILE BEING USED FOR CSS for:', options.owner_id, 'app:', options.app_name, 'page:', options.page_url)
          }
        }
      })
    }
    finalContents = finalContents.replace('{{CSS_FILES}}', cssFiles)
    
    // Process script files
    let scriptFiles = ''
    if (options.script_files) {
      const scriptArray = Array.isArray(options.script_files) ? options.script_files : [options.script_files]
      scriptArray.forEach(file => {
        if (typeof file === 'string') {
          // helpers.startsWith(file, '/') s trick to handle public file paths
          const thePath = (startsWith(file, 'http') || startsWith(file, '/')) ? file : partUrlPathToLoggedInPathResource(userId, options.app_name, file)
          scriptFiles += ` <script src="${thePath}" type="text/javascript"></script>`
        }
      })
    }
    if (options.modules) {
      options.modules.forEach(pathToFile => {
        if (typeof pathToFile === 'string') {
          const outsideScript = startsWith(pathToFile.publicid, 'http')
          const thePath = outsideScript ? pathToFile : partUrlPathToLoggedInPathResource(userId, options.app_name, pathToFile)
          scriptFiles = scriptFiles + '<script src="' + thePath + '"' + (outsideScript ? ('nonce-' + nonce) : ' ') + ' type="module"></script>'
        } else if (pathToFile?.publicid) {
          // 2025- untested moved from old system
          console.log('processing module - 2025 NOT TESTED ',{ pathToFile, userId, app: options.app_name})
          const outsideScript = startsWith(pathToFile.publicid, 'http')
          scriptFiles = scriptFiles + '<script src="/' + pathToFile.publicid + '"' + (outsideScript ? ('nonce-' + nonce) : ' ') + ' type="module"></script>'
        } else {
          console.warn('UNKNOWN MODULE FILE TYPE', { pathToFile })
        }
      })
    }
    finalContents = finalContents.replace('{{SCRIPT_FILES}}', scriptFiles)
    
    // Add other variables
    if (options.other_variables) {
      finalContents = finalContents.replace('{{OTHER_VARIABLES}}', options.other_variables)
    } else {
      finalContents = finalContents.replace('{{OTHER_VARIABLES}}', 'null')
    }
    
    // Add messages
    finalContents = finalContents.replace('{{MESSAGES}}', JSON.stringify(options.messages || {}))
    
    // Add page HTML content
    finalContents = finalContents.replace('{{HTML-BODY}}', options.page_html || 'Page Not found')
    
    // Send the final HTML
    sendContent(res, finalContents)
    
  } catch (error) {
    console.error('Error in loadPageHtml:', error)
    return res.status(500).send('Internal server error')
  }
}

/**
 * Helper function to create URL paths (replicated from file_handler.js)
 */
const partUrlPathTo = (userId, appName, filePath) => {
  if (startsWith(filePath, 'http')) {
    return filePath
  }
  // if (startsWith(filePath, './')) return '/app_files' + (userId ? ('/@' + userId) : '') + fileName.slice(1)
  
  if (startsWith(filePath, '/app_files/')) {
    // todo make this proper path detection - currently assumes it is onyl one path level deep
    return filePath
  } else if (isSystemApp(appName)) {
    return `/app/${appName}/${filePath}`
  } else {
    return `/app_files/@${userId}/${appName}/${filePath}`
  }
}

/**
 * Helper function to create URL paths (replicated from file_handler.js)
 */
const partUrlPathToLoggedInPathResource = (userId, appName, filePath) => {
  if (startsWith(filePath, 'http')) {
    return filePath
  }
  // if (startsWith(filePath, './')) return '/app_files' + (userId ? ('/@' + userId) : '') + fileName.slice(1)
  
  if (startsWith(filePath, '/app_files/') || startsWith(filePath, '/app/')) {
    // todo make this proper path detection - currently assumes it is onyl one path level deep
    return filePath
  } else if (isSystemApp(appName)) {
    return `/app/${appName}/${filePath}`
  } else {
    // console.log('partUrlPathToLoggedInPathResource', {userId, appName, filePath})
    return `${filePath}`
  }
}


/**
 * Helper function to get file extension (replicated from file_handler.js)
 */
export const fileExt = (filePath) => {
  return path.extname(filePath).toLowerCase().substring(1)
}

/**
 * Modern page loader factory
 * Creates a page loader with pre-configured appFS
 * 
 * @param {object} appFS - App filesystem
 * @returns {object} Page loader functions
 */
export const createPageLoader = (appFS) => {
  return {
    loadDataHtmlAndPage: (res, options) => loadDataHtmlAndPage(appFS, res, options),
    loadPageHtml: (res, options) => loadPageHtml(appFS, res, options)
  }
}

export default {
  loadDataHtmlAndPage,
  loadPageHtml,
  createPageLoader,
  fileExt
}