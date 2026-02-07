// freezr.info - Modern ES6 Module - Register Page Controller
// Handles rendering of registration pages
//
// Architecture Pattern:
// - Controller handles HTTP concerns (request/response)
// - Uses modern page loader for rendering
// - Returns HTML pages
// - Uses functional approach with closures for dependency injection

import { loadDataHtmlAndPage } from '../../../adapters/rendering/pageLoader.mjs'
import { ENV_PARAMS } from '../../../adapters/datastore/environmentDefaults.mjs'

/**
 * Generate first setup page
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const generateFirstSetUpPage = async (req, res) => {
  try {
    // console.log('🔄 generateFirstSetUpPage - res.locals.freezr:', { freezr: res.locals.freezr })
    // For first setup, we use a local manager with fradmin's public appFS
    // This is set up in the checkFirstSetUp middleware
    const appFS = res.locals.freezr?.localsAppFS
    
    if (!appFS) {
      console.error('❌ appFS not found for first setup page')
      return res.status(500).send('Internal server error - appFS not available (5)')
    }

    const tempEnvironment = res.locals.freezr?.freezrInitialEnvCopy
    if (tempEnvironment.dbParams && tempEnvironment.dbParams.pass) {
      tempEnvironment.dbParams.pass = null
      tempEnvironment.dbParams.has_password = true
    }
    if (tempEnvironment.dbParams && tempEnvironment.dbParams.connectionString) {
      tempEnvironment.dbParams.connectionString = null
      tempEnvironment.dbParams.has_password = true
    }
    // console.log('todo - should do this for all otherDBs and otherFSs as well')

    // move secret codes out and leave a note that the secret tokens are on the server
    if (tempEnvironment.fsParams && (tempEnvironment.fsParams.accessToken || tempEnvironment.fsParams.refreshToken)) { // todo - need to also check code-verifier etc
      tempEnvironment.fsParams.accessToken = null
      tempEnvironment.fsParams.TokenIsOnServer = true
    }

    
    // Build page options for rendering
    const options = {
      page_title: 'First Setup',
      css_files: ['/app/info.freezr.public/public/freezr_style.css', 'public/firstSetUp.css'],
      page_url: 'public/firstSetUp.html',
      app_name: 'info.freezr.register',
      script_files: ['public/firstSetUp.js'],
      modules: [],
      server_name: req.protocol + '://' + req.get('host'),
      freezr_server_version: res.locals.freezr.freezrPrefs.version,
      user_id: null,
      user_is_admin: false,
      user_is_publisher: false,
      other_variables: `var freezrSetUpStatus = ${JSON.stringify(res.locals.freezr.freezrSetUpStatus)};
        const freezrEnvironment = ${JSON.stringify(tempEnvironment)};
        const freezrServerStatus = ${JSON.stringify(res.locals.freezr.freezrStatus)};
        const ENV_PARAMS_2 = ${JSON.stringify(ENV_PARAMS)};
        const freezrIsDev = ${process?.env?.NODE_ENV === 'development'};
        const thisPage = "firstSetUp"; `
      // initial_environment: tempEnvironment
    }
    // res.locals.flogger = {
    //   error: console.error,
    //   track: console.log
    // }
    res.locals.freezr.permGiven = true
    // Render page using modern page loader adapter
    return loadDataHtmlAndPage(appFS, res, options)
    
  } catch (error) {
    console.error('❌ Error generating first setup page:', error)
    console.error('Error stack:', error.stack)
    res.status(500).send('Internal server error')
  }
}

// const generateNewParamsPage = async (req, res) => {
//   try {
//     const appFS = res.locals.freezr?.appFS
    
//     if (!appFS) {
//       console.error('❌ appFS not found for public admin page')
//       return res.status(500).send('Internal server error - appFS not available (6)')
//     }
    
//     // Get manifest from res.locals (set by addPublicAdminManifestToResLocals middleware)
//     const manifest = res.locals.freezr?.manifest
    
//     if (!manifest) {
//       console.error('❌ Manifest not found in res.locals.freezr.manifest')
//       return res.status(500).send('Internal server error - manifest not available')
//     }
    
//     // Build page options for rendering using manifest
//     const options = {
//       page_title: manifest.page_title,
//       css_files: manifest.css_files || [],
//       page_url: manifest.page_url,
//       app_name: manifest.app_name || 'info.freezr.public',
//       script_files: manifest.script_files || [],
//       modules: manifest.modules || [],
//       server_name: res.locals.freezr.serverName,
//       freezr_server_version: res.locals.freezr.freezrVersion,
//       user_id: req.session?.logged_in_user_id || null,
//       user_is_admin: req.session?.logged_in_as_admin || false,
//       user_is_publisher: req.session?.logged_in_as_publisher || false,
//       other_variables: manifest.other_variables || '',
//       sub_page: subPage
//     }

//     res.locals.freezr.permGiven = true
//     // Render page using modern page loader adapter
//     return loadDataHtmlAndPage(appFS, res, options)
    
//   } catch (error) {
//     console.error('❌ Error generating public admin page:', error)
//     console.error('Error stack:', error.stack)
//     res.status(500).send('Internal server error')
//   }
// }

const freezrSelfRegPrefs = function (freezrPrefs) {
  return {
    allow: freezrPrefs.allowSelfReg,
    allowAccessToSysFsDb: freezrPrefs.allowAccessToSysFsDb,
    defaultMBStorageLimit: freezrPrefs.selfRegDefaultMBStorageLimit,
    // useUserIdsAsDbName: freezrPrefs.useUserIdsAsDbName,
    dbUnificationStrategy: freezrPrefs.dbUnificationStrategy,
    // useUnifiedCollection: freezrPrefs.useUnifiedCollection,
    hasNotbeenSave: true
  }
}

/**
 * Generate user self registration page
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const generateUserSelfRegistrationPage = async (req, res) => {
  try {
    // For self registration, we use public's appFS
    // appFS should already be set by publicAccountContext middleware
    const appFS = res.locals.freezr?.appFS
    
    if (!appFS) { 
      console.error('❌ appFS not found for self registration page')
      return res.status(500).send('Internal server error - appFS not available (7)')
    }
    
    // Get self-registration options from context (set by publicAccountContext)
    const selfRegOptions = res.locals.freezr?.selfRegOptions || {}
    
    // Use environment defaults from ES6 module
    const envParams = ENV_PARAMS

    // console.log('setting page url to ', req.url + '.html') 
    // Build page options for rendering
    const options = {
      page_title: 'User Self Registration',
      css_files: ['/app/info.freezr.public/public/freezr_style.css', 'public/firstSetUp.css'],
      page_url: req.url + '.html',
      app_name: 'info.freezr.register',
      script_files: ['public/selfregister.js'],
      modules: [],
      server_name: res.locals.freezr.serverName,
      freezr_server_version: res.locals.freezr.freezrVersion,
      user_id: req.session?.logged_in_user_id || null,
      user_is_admin: req.session?.logged_in_as_admin || false,
      user_is_publisher: req.session?.logged_in_as_publisher || false,
      other_variables: `const thisPage = ${JSON.stringify(res.locals.freezr.freezrSetUpStatus)};
              const freezrEnvironment = {};
              const freezrStatus = ${JSON.stringify(res.locals.freezr.freezrStatus)};
              const freezrServerStatus = ${JSON.stringify(res.locals.freezr.freezrSetUpStatus)};
              const userId = "";
              const ENV_PARAMS = ${JSON.stringify(envParams)};
              const freezrSelfRegOptions = ${JSON.stringify(freezrSelfRegPrefs(res.locals.freezr.freezrPrefs))};`,
      self_reg_options: selfRegOptions
    }
    
    // Render page using modern page loader adapter
    res.locals.freezr.permGiven = true
    return loadDataHtmlAndPage(appFS, res, options)
    
  } catch (error) {
    console.error('❌ Error generating self registration page:', error)
    console.error('Error stack:', error.stack)
    res.status(500).send('Internal server error')
  }
}

/**
 * Factory function to create register page controller
 * Returns an object with handler functions
 * 
 * @returns {Object} Controller with handler functions
 */
export const createRegisterPageController = () => {
  return {
    generateFirstSetUpPage,
    // generateNewParamsPage,
    // generatePublicAuthPage,
    generateUserSelfRegistrationPage
  }
}

export default createRegisterPageController

