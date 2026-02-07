/**
 * Account Page Manifest Service accountManifestService.mjs
 * 
 * Provides configuration for different account pages including:
 * - Page titles
 * - CSS files
 * - Script files
 * - Page URLs
 * - Other page-specific variables
 * - Initial query functions for data loading
 * 
 * This modernizes the old accountPageManifest function from account_handler.js
 */

import { getQueryFunction } from './accountQueryService.mjs'

/**
 * Get account page manifest configuration
 * @param {Object} params - Page parameters
 * @param {string} params.page - The page name (home, settings, etc.)
 * @param {string} [params.sub_page] - Sub-page for app management pages
 * @param {string} [params.target_app] - Target app for app-specific pages
 * @returns {Object|null} Page configuration object or null if page not found
 */
export const getAccountPageManifest = (params) => {
  // Set default sub_page for app management
  if (params.page === 'app' && !params.sub_page) {
    params.sub_page = 'manage'
  }

  const manifests = {
    home: {
      page_title: 'Accounts Home (Freezr)',
      css_files: [
        '/app/info.freezr.public/public/freezr_style.css',
        'account_home.css'
      ],
      page_url: 'account_home.html',
      app_name: 'info.freezr.account',
      script_files: ['account_home.js'],
      initial_query_func: 'listAllUserApps'
    },

    settings: {
      page_title: 'Account Settings (freezr)',
      css_files: [
        '/app/info.freezr.public/public/freezr_style.css',
        'account_home.css'
      ],
      page_url: 'account_settings.html',
      app_name: 'info.freezr.account',
      script_files: ['account_settings.js'],
      initial_query_func: 'getAccountSettings'
    },

    contacts: {
      page_title: 'CEPS Contacts',
      page_url: 'account_contacts.html',
      css_files: [
        '/app/info.freezr.public/public/freezr_style.css',
        'account_home.css',
        'account_contacts.css'
      ],
      script_files: ['account_contacts.js'],
      app_name: 'info.freezr.account',
      initial_query_func: null
    },

    serverless: {
      page_title: 'Account Services Settings (freezr)',
      css_files: [
        '/app/info.freezr.public/public/freezr_style.css',
        'account_home.css'
      ],
      page_url: 'account_serverless.html',
      app_name: 'info.freezr.account',
      script_files: ['account_serverless.js'],
      initial_query_func: 'getServerlessSettings'
    },

    app: {
      page_title: 'Apps (freezr)' + (params.sub_page ? ' - ' + params.sub_page : ''),
      css_files: [
        '/app/info.freezr.public/public/freezr_style.css',
        'account_home.css'
      ],
      page_url: 'account_app_' + params.sub_page + '.html',
      app_name: 'info.freezr.account',
      script_files: ['/app/info.freezr.public/public/mustache.js'],
      modules: ['account_app_' + params.sub_page + '.js'],
      other_variables: params.target_app 
        ? `const targetApp = "${params.target_app}"; let transformRecord`
        : 'let transformRecord',
      initial_query_func: null // Will be implemented in next step
    },

    resourceusage: {
      page_title: 'Resource Usage (freezr)',
      css_files: [
        '/app/info.freezr.public/public/freezr_style.css',
        'account_home.css'
      ],
      page_url: 'account_resourceusage.html',
      app_name: 'info.freezr.account',
      script_files: [
        'account_resourceusage.js',
        '/app/info.freezr.public/public/mustache.js'
      ],
      initial_query_func: 'getAppResources'
    },

    logviewer: {
      page_title: 'Log Viewer (freezr)',
      css_files: [
        '/app/info.freezr.public/public/freezr_style.css',
        'account_home.css',
        'account_logviewer.css'
      ],
      page_url: 'account_logviewer.html',
      app_name: 'info.freezr.account',
      script_files: [
        'account_logviewer.js'
      ]
    },

    reauthorise: {
      page_title: 'Account Recovery (freezr)',
      css_files: [
        '/app/info.freezr.public/public/freezr_style.css',
        'account_home.css'
      ],
      page_url: 'account_reauthorise.html',
      app_name: 'info.freezr.account',
      script_files: ['account_reauthorise.js'],
      initial_query_func: 'getReauthorizeData'
    },

    reset: {
      page_title: 'Account Reset (freezr)',
      css_files: [
        '/app/info.freezr.public/public/freezr_style.css',
        'account_home.css'
      ],
      page_url: 'account_reset.html',
      app_name: 'info.freezr.account',
      script_files: ['account_reset.js'],
      initial_query_func: 'getResetData'
    }

    // perms: {
    //   page_title: 'Permissions (freezr)',
    //   css_files: [
    //     '/app/info.freezr.public/public/freezr_style.css',
    //     '/app/info.freezr.public/public/firstSetUp.css'
    //   ],
    //   page_url: 'account_perm.html',
    //   app_name: 'info.freezr.account',
    //   script_files: ['account_perm.js'],
    //   initial_query_func: 'generatePermissionHTML'
    // }

    // confirmperm: {
    //   page_title: 'Apps (freezr)' + (params.sub_page ? ' - ' + params.sub_page : ''),
    //   css_files: [
    //     '/app/info.freezr.public/public/freezr_style.css',
    //     'account_app_management.css'
    //   ],
    //   page_url: 'account_confirmperm.html',
    //   app_name: 'info.freezr.account',
    //   modules: ['account_confrimperm.js'],
    //   initial_query_func: null // Will be implemented in next step
    // },

    // autoclose: {
    //   page_title: 'Autoclose tab (freezr)',
    //   page_url: 'account_autoclose.html',
    //   app_name: 'info.freezr.account',
    //   script_files: ['account_autoclose.js'],
    //   initial_query_func: null
    // },

  }

  const manifest = manifests[params.page] || null
  
  // Resolve initial_query_func if it's a string reference
  if (manifest && manifest.initial_query_func && typeof manifest.initial_query_func === 'string') {
    manifest.initial_query_func = getQueryFunction(manifest.initial_query_func)
  }
  if (params.page === 'app' && (params.sub_page === 'viewdata' || params.sub_page === 'restoredata')) {
    manifest.css_files.push('account_app_' + params.sub_page + '.css')
    manifest.css_files.push('modules/drawJson.css')
  }
  
  return manifest
}

/**
 * Get system data page manifest (for appdata pages)
 * @param {Object} params - Page parameters
 * @param {string} params.action - The action name
 * @param {string} params.target_app - The target app name
 * @returns {Object} Page configuration object
 */
export const getSystemDataPageManifest = (params) => {
  const page = 'appdata_' + params.action
  
  return {
    page_title: `App Data - ${params.action} (freezr)`,
    css_files: [
      './@public/info.freezr.public/public/freezr_style.css',
      'account_home.css'
    ],
    page_url: `account_${page}.html`,
    app_name: 'info.freezr.account',
    script_files: [`account_${page}.js`],
    other_variables: `const app_name = '${params.target_app}'`,
    initial_query_func: null
  }
}

/**
 * Validate page parameters
 * @param {Object} params - Page parameters to validate
 * @returns {Object} Validation result with isValid and error message
 */
export const validatePageParams = (params) => {
  if (!params.page) {
    return { isValid: false, error: 'Page parameter is required' }
  }

  // Validate sub_page for app pages
  if (params.page === 'app' && !params.sub_page) {
    return { isValid: false, error: 'Sub-page parameter is required for app pages' }
  }

  return { isValid: true }
}

/**
 * Get default page configuration for unknown pages
 * @param {string} pageName - The page name
 * @returns {Object} Default page configuration
 */
export const getDefaultPageManifest = (pageName) => {
  if (!pageName) pageName = 'Not Found'
  return {
    page_title: `${pageName.charAt(0).toUpperCase() + pageName.slice(1)} (Freezr)`,
    css_files: [
      './@public/info.freezr.public/public/freezr_style.css',
      'account_home.css'
    ],
    page_url: `./@public/info.freezr.public/public/pageNotFound`,
    app_name: 'info.freezr.account',
    initial_query_func: null
  }
}
