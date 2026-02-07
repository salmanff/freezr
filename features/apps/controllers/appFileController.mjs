// freezr.info - Modern ES6 Module - App File Controller
// Handles serving of app files for authenticated users
//
// Architecture Pattern:
// - Controller handles HTTP concerns (request/response)
// - Uses appFS.sendAppFile for serving files
// - Returns file content with appropriate headers
// - Uses functional approach with closures for dependency injection

/**
 * Serve app file for authenticated users
 * Modernizes serveAppFile from server.js
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const serveAppFile = async (req, res) => {
  
  try {
    // Get appFS from res.locals (set by middleware)
    const appFS = res.locals.freezr?.appFS
    
    if (!appFS) {
      console.error('❌ appFS not found in res.locals.freezr')
      return res.status(500).send('Internal server error - appFS not available (2)')
    }
    
    // // Handle public app files separately
    // if (req.params.app_name === 'info.freezr.public') {
    //   return servePublicAppFile(req, res)
    // }

    res.locals.freezr.permGiven = true

    // Extract file path from URL
    // URL format: /app_files/@:user_id/:app_name/:file or /app_files/:app_name/:file
    let fileUrl = req.originalUrl
    fileUrl = fileUrl.split('?')[0] // Remove query string
    
    // Count how many path segments to skip
    // /app_files/@:user_id/:app_name/:file = 4 segments
    // /app/:app_name/:file = 3 segments

    // 2025-012 TODO -> remvoe app_file usage
    const countToEnd = req.params.user_id ? 4 : 3
    
    // Extract the file path (everything after the app_name)
    let parts = fileUrl.split('/')
    parts = parts.slice(countToEnd)
    const endpath = parts.join('/')
    
    console.log('📁 serveAppFile - endpath:', endpath, 'from URL:', fileUrl)
    
    // Serve the file using appFS
    appFS.sendAppFile(endpath, res, {})
    
  } catch (error) {
    console.error('❌ Error serving app file:', error)
    console.error('Error stack:', error.stack)
    res.status(500).send('Internal server error')
  }
}

/**
 * Serve public app file
 * Modernizes servePublicAppFile from server.js
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const servePublicAppFile = async (req, res) => {
  try {
    // Get appFS from res.locals (set by middleware)
    console.log('🔍 servePublicAppFile - NOT TESTED YET  ', { req: req.originalUrl, res: res.locals.freezr })
    const appFS = res.locals.freezr?.appFS
    
    if (!appFS) {
      console.error('❌ appFS not found in res.locals.freezr')
      return res.status(500).send('Internal server error - appFS not available (3)')
    }
    
    // Extract file path from URL
    let fileUrl = req.originalUrl
    fileUrl = fileUrl.split('?')[0] // Remove query string
    
    // Count how many path segments to skip
    const countToEnd = req.params.user_id ? 4 : 3
    
    // Extract the file path
    let parts = fileUrl.split('/')
    parts = parts.slice(countToEnd)
    let endpath = parts.join('/')
    
    // Favicon exception
    if (fileUrl.slice(1) === 'favicon.ico') {
      endpath = 'public/static/favicon.ico'
    }

    res.locals.freezr.permGiven = true
    console.log('⚠️ CHECK MAKE SURE THI SIS PUBLIC', { tokenInfo: res.locals.freezr.tokenInfo, paramsAppName: req.params.app_name })
    
    // console.log('📁 servePublicAppFile - endpath:', endpath, 'from URL:', fileUrl, 'app name:', req.params.app_name)
    
    // Serve the public file using appFS
    appFS.sendPublicAppFile(endpath, res, {})
    
  } catch (error) {
    console.error('❌ Error serving public app file:', error)
    console.error('Error stack:', error.stack)
    res.status(500).send('Internal server error')
  }
}

/**
 * Factory function to create app file controller
 * Returns an object with handler functions
 * 
 * @returns {Object} Controller with handler functions
 */
export const createAppFileController = () => {
  return {
    serveAppFile,
    servePublicAppFile
  }
}

export default createAppFileController


