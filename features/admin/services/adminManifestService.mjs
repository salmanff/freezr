/**
 * Admin Page Manifest Service adminManifestService.mjs
 * 
 * Provides configuration for different admin pages including:
 * - Page titles
 * - CSS files
 * - Script files
 * - Page URLs
 * - Other page-specific variables
 * - Initial query functions for data loading
 * 
 * This modernizes the old admin page generation from admin_handler.js
 */

/**
 * Get admin page manifest configuration
 * @param {Object} params - Page parameters
 * @param {string} params.sub_page - The sub-page name (home, list_users, etc.)
 * @param {Object} [params.freezrStatus] - Freezr status object (for other_variables)
 * @param {Object} [params.freezrVisitLogs] - Visit logs (for visits page)
 * @param {string} [params.userid] - User ID parameter (for other_variables)
 * @returns {Object|null} Page configuration object or null if page not found
 */
export const getAdminPageManifest = (params, freezrStatus, freezrPrefs) => {
  const subPage = params.sub_page
  
  const manifests = {
    home: {
      page_title: 'Admin Home (freezr)',
      css_files: [
        '/app/info.freezr.public/public/freezr_style.css',
        '/app/info.freezr.account/account_home.css'
      ],
      page_url: 'home.html',
      app_name: 'info.freezr.admin',
      script_files: [],
      modules: []
    },

    list_users: {
      page_title: 'User List (freezr Admin)',
      css_files: [
        '/app/info.freezr.public/public/freezr_style.css',
        '/app/info.freezr.account/account_home.css'
      ],
      page_url: 'list_users.html',
      app_name: 'info.freezr.admin',
      script_files: ['list_users.js'],
      modules: [],
      initial_query: { app_table: 'info.freezr.admin.users', owner: 'fradmin', q: {} }
    },

    manage_users: {
      page_title: 'Manage Users (freezr Admin)',
      css_files: [
        '/app/info.freezr.public/public/freezr_style.css',
        '/app/info.freezr.account/account_home.css',
        'manage_users.css'
      ],
      page_url: 'manage_users.html',
      app_name: 'info.freezr.admin',
      script_files: ['manage_users.js'],
      modules: []
    },

    prefs: {
      page_title: 'System Preferences (freezr Admin)',
      css_files: [
        '/app/info.freezr.public/public/freezr_style.css',
        '/app/info.freezr.account/account_home.css'
      ],
      page_url: 'prefs.html',
      app_name: 'info.freezr.admin',
      script_files: ['prefs.js'],
      modules: [],
      initial_query_func: function () {
        return freezrPrefs  
      }
    },

    addlocalmicroservice: {
      page_title: 'Add Microservice (freezr Admin)',
      css_files: [
        '/app/info.freezr.public/public/freezr_style.css',
        '/app/info.freezr.account/account_home.css',
        'addlocalmicroservice.css'
      ],
      page_url: 'addlocalmicroservice.html',
      app_name: 'info.freezr.admin',
      script_files: ['addlocalmicroservice.js'],
      modules: []
    },

    register: {
      page_title: 'Register User (freezr Admin)',
      css_files: [
        '/app/info.freezr.public/public/freezr_style.css',
        '/app/info.freezr.account/account_home.css'
      ],
      page_url: 'register.html',
      app_name: 'info.freezr.admin',
      script_files: ['register.js'],
      modules: []
    },

    createCloudToken: {
      page_title: 'Create Cloud Token (freezr Admin)',
      css_files: [
        '/app/info.freezr.public/public/freezr_style.css',
        '/app/info.freezr.account/account_home.css',
        'createCloudToken.css'
      ],
      page_url: 'createCloudToken.html',
      app_name: 'info.freezr.admin',
      script_files: ['createCloudToken.js'],
      modules: []
    },

    oauth_serve_setup: {
      page_title: 'OAuth Server Setup (freezr Admin)',
      css_files: [
        '/app/info.freezr.public/public/freezr_style.css',
        '/app/info.freezr.account/account_home.css',
        'oauth_serve_setup.css'
      ],
      page_url: 'oauth_serve_setup.html',
      app_name: 'info.freezr.admin',
      script_files: ['oauth_serve_setup.js'],
      modules: [],
      initial_query: { 
        app_table: 'info.freezr.admin.oauthors', 
        owner: 'fradmin', 
        q: {} 
      }
    },

    resourceusage: {
      page_title: 'Resource Usage (freezr Admin)',
      css_files: [
        '/app/info.freezr.public/public/freezr_style.css',
        '/app/info.freezr.account/account_home.css'
      ],
      page_url: 'resourceusage.html',
      app_name: 'info.freezr.admin',
      script_files: ['/app/info.freezr.account/account_resourceusage.js'],
      modules: []
    }
  }

  // Get manifest or use default
  let manifest = manifests[subPage]
  
  if (!manifest) {
    // Default case - use sub_page name for file paths
    manifest = {
      page_title: 'Admin ' + subPage.replace('_', ' ') + ' (Freezr)',
      css_files: [
        '/app/info.freezr.public/public/freezr_style.css',
        subPage + '.css'
      ],
      page_url: subPage + '.html',
      app_name: 'info.freezr.admin',
      script_files: [ subPage + '.js' ],
      modules: []
    }
  }

  // Build other_variables string
  let otherVariables = 'var freezrServerStatus = ' + JSON.stringify(freezrStatus || {}) + ';'
  if (params.userid) {
    otherVariables += 'var userid="' + params.userid + '";'
  }
  // to be reviewed in light of new visit logger
  // if (subPage === 'visits' && params.freezrVisitLogs) {
  //   otherVariables += 'const currentVisits = ' + JSON.stringify(params.freezrVisitLogs) + ';'
  // }
  
  manifest.other_variables = otherVariables

  return manifest
}

/**
 * Get default page configuration for unknown pages
 * @param {string} subPage - The sub-page name
 * @returns {Object} Default page configuration
 */
export const getDefaultAdminPageManifest = (subPage) => {
  if (!subPage) subPage = 'home'
  return {
    page_title: `Admin ${subPage.charAt(0).toUpperCase() + subPage.slice(1)} (Freezr)`,
    css_files: [
      './@public/info.freezr.public/public/freezr_style.css',
      './info.freezr.admin/' + subPage + '.css'
    ],
    page_url: subPage + '.html',
    app_name: 'info.freezr.admin',
    script_files: ['./info.freezr.admin/' + subPage + '.js'],
    modules: []
  }
}

