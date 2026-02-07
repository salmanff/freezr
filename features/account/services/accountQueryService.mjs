/**
 * Account Query Service
 * 
 * Provides initial query functions for account pages that need to load data
 * before rendering. These functions are called by the account page controller
 * to fetch data that will be passed to the page template.
 * 
 * This modernizes the initial_query_func functionality from account_handler.js
 */

/**
 * List all user apps for the account home page
 * @param {Object} userDS - User data store
 * @returns {Promise<Object>} Promise that resolves to app data
 */
export const listAllUserApps = async (userDS) => {
  try {    
    if (!userDS) {
      throw new Error('User data store not available')
    }
    
    const userId = userDS?.owner
    const oac = {
      owner: userId,
      app_name: 'info.freezr.account',
      collection_name: 'app_list'
    }
    
    const removedApps = []
    const userApps = []
        
    // Get the app list database
    const appList = await userDS.getorInitDb(oac)
    
    if (!appList || !appList.query) {
      throw new Error('Incomplete or authentication malfunction getting db for ' + userId)
    }
    
    // Query all user apps
    const results = await appList.query({}, {})
    
    if (results && results.length > 0) {
      const processedResults = results.map(app => {
        const processedApp = {
          app_name: app.app_name,
          removed: app.removed,
          served_url: app.served_url,
          _date_modified: app._date_modified,
          _id: app._id,
          app_display_name: app.app_display_name,
          offThreadWip: ((app.offThreadStatus && app.offThreadStatus.offThreadWip) ? app.offThreadStatus.offThreadWip : false),
          offThreadParams: ((app.offThreadStatus && app.offThreadStatus.offThreadParams) ? app.offThreadStatus.offThreadParams : null)
        }
        
        // Format display name
        if (processedApp.app_name && processedApp.app_name === processedApp.app_display_name) {
          processedApp.app_display_name = processedApp.app_display_name.replace(/\./g, '. ')
        }
        
        // Generate logo path
        const appOwnerAndNameForLogo = (url) => {
          if (!url) return null
          const parts = url.split('/')
          const idx = parts.indexOf('oapp')
          if (idx < 0 || parts.length < idx + 3) return null
          return parts[idx + 1] + '/' + parts[idx + 2]
        }
        // onsole.log('📱 listAllUserApps - processedApp:', processedApp.app_name, { hasLogo: processedApp.hasLogo })
        processedApp.logo = app.hasLogo 
          ? '/app/info.freezr.account/app2app/' + processedApp.app_name + '/static/logo.png' // (appOwnerAndNameForLogo(processedApp.served_url) || processedApp.app_name)
          : '/app/info.freezr.public/public/static/freezer_logo_empty.png'
        
        return processedApp
      })
      
      // Separate removed and active apps
      processedResults.forEach(app => {
        if (app.removed) {
          removedApps.push(app)
        } else {
          userApps.push(app)
        }
      })
    }
    
    return { removed_apps: removedApps, user_apps: userApps }
    
  } catch (error) {
    console.error('❌ Error in listAllUserApps:', error)
    
    // Return empty results instead of throwing to prevent page from breaking
    console.warn('📱 listAllUserApps - returning empty results due to error')
    return { removed_apps: [], user_apps: [], error: error.message }
  }
}

/**
 * Get account settings data
 * @param {Object} userDS - User data store
 * @returns {Promise<Object>} Promise that resolves to settings data
 */
export const getAccountSettings = async (userDS) => {
  // onsole.log('⚙️ getAccountSettings called')
  
  try {
    if (!userDS || !userDS.fsParams || !userDS.dbParams) {
      return { owner: null, error: 'no user ds found' }
    }
    
    const settingsData = {
      owner: userDS.owner,
      fsParamsType: userDS.fsParams.type,
      systemFs: userDS.fsParams.systemFs,
      dbParamsType: userDS.dbParams.type,
      systemDb: userDS.dbParams.systemDb,
      slParamsType: userDS.slParams?.type
    }
    
    // onsole.log('⚙️ getAccountSettings completed:', settingsData)
    return settingsData
    
  } catch (error) {
    console.error('❌ Error in getAccountSettings:', error)
    throw error
  }
}

/**
 * Get serverless settings data
 * @param {Object} userDS - User data store
 * @returns {Promise<Object>} Promise that resolves to serverless data
 */
export const getServerlessSettings = async (userDS) => {
  //onsole.log('☁️ getServerlessSettings called')
  
  try {
    if (!userDS) {
      return { owner: null, error: 'no user ds found' }
    }
    
    const serverlessData = {
      slParamsType: userDS.slParams?.type,
      slRegion: userDS.slParams?.region,
      accessKeyId: userDS.slParams?.accessKeyId ? ('***' + userDS.slParams.accessKeyId.slice(-3)) : null,
      secretAccessKey: userDS.slParams?.secretAccessKey ? ('***' + userDS.slParams.secretAccessKey.slice(-3)) : null,
      arnRole: userDS.slParams?.arnRole ? ('***' + userDS.slParams.arnRole.slice(-3)) : null
    }
    
    console.log('☁️ getServerlessSettings completed:', serverlessData)
    return serverlessData
    
  } catch (error) {
    console.error('❌ Error in getServerlessSettings:', error)
    throw error
  }
}

/**
 * Get reauthorization data
 * @param {Object} userDS - User data store
 * @returns {Promise<Object>} Promise that resolves to reauthorization data
 */
export const getReauthorizeData = async (userDS) => {
  console.log('🔄 getReauthorizeData called')
  
  try {
    if (!userDS || !userDS.owner || !userDS.fsParams || !userDS.fsParams.type) {
      return { owner: null, error: 'no user ds found' }
    }
    
    const reauthData = {
      owner: userDS.owner,
      fsParamsType: userDS.fsParams.type
    }
    
    console.log('🔄 getReauthorizeData completed:', reauthData)
    return reauthData
    
  } catch (error) {
    console.error('❌ Error in getReauthorizeData:', error)
    throw error
  }
}

/**
 * Get reset data
 * @param {Object} userDS - User data store
 * @returns {Promise<Object>} Promise that resolves to reset data
 */
export const getResetData = async (userDS) => {
  console.log('🔄 getResetData called')
  
  try {
    if (!userDS || !userDS.owner || !userDS.fsParams || !userDS.fsParams.type) {
      return { owner: null, error: 'no user ds found' }
    }
    
    const resetData = {
      owner: userDS.owner,
      fsParamsType: userDS.fsParams.type
    }
    
    console.log('🔄 getResetData completed:', resetData)
    return resetData
    
  } catch (error) {
    console.error('❌ Error in getResetData:', error)
    throw error
  }
}

/**
 * Generate permission HTML for permissions page
 * This is a complex function that generates HTML content for permissions
 * @param {Object} userDS - User data store
 * @returns {Promise<Object>} Promise that resolves to permission HTML data
 */
export const generatePermissionHTML = async (userDS) => {
  console.log('🔐 generatePermissionHTML called')
  
  try {
    // This function is complex and involves multiple steps:
    // 1. Get permissions data
    // 2. Generate HTML content using Mustache templates
    // 3. Return the HTML content
    
    // For now, we'll implement a simplified version
    // The full implementation would need access to:
    // - req.freezrUserPermsDB
    // - Mustache templating
    // - File system access for HTML templates
    
    const permissionData = {
      all_perms_in_html: '<div class="permissions-placeholder">Permissions HTML will be generated here</div>'
    }
    
    console.log('🔐 generatePermissionHTML completed (simplified)')
    return permissionData
    
  } catch (error) {
    console.error('❌ Error in generatePermissionHTML:', error)
    throw error
  }
}

/**
 * Process app list from database and return specifically structured objects in lists of user_apps and removed_apps for display in home page for example
 * Takes appListDb and processes the apps, returning structured results
 * Used by API controllers that have already obtained the database
 * 
 * @param {Object} appListDb - App list database instance
 * @param {string} userId - User ID (for logging/debugging)
 * @returns {Promise<Object>} Promise that resolves to { removed_apps, user_apps }
 */
export const getStructuredAppListForUser = async (appListDb, userId) => {
  // console.log('📱 getStructuredAppListForUser called for userId:', userId)
  
  try {
    if (!appListDb || !appListDb.query) {
      throw new Error('App list database not available')
    }
    
    // Query all apps from database (async, no Promise wrapper needed)
    const results = await appListDb.query({}, {})
    // console.log('📱 getStructuredAppListForUser - query success, apps count:', results?.length || 0)
    
    const removedApps = []
    const userApps = []
    
    if (results && results.length > 0) {
      const processedApps = results.map(app => {
        const appOwnerAndNameForLogo = (url) => {
          if (!url) return null
          const parts = url.split('/')
          const idx = parts.indexOf('oapp')
          if (idx < 0 || parts.length < idx + 3) return null
          return parts[idx + 1] + '/' + parts[idx + 2]
        }
        
        let app_display_name = app.app_display_name
        if (app.app_name && app.app_name === app_display_name) {
          app_display_name = app_display_name.replace(/\./g, '. ')
        }

        // console.log('📱 getStructuredAppListForUser - app:', app.app_name, { hasLogo: app.hasLogo })
        
        return {
          app_name: app.app_name,
          removed: app.removed,
          served_url: app.served_url,
          _date_modified: app._date_modified,
          _id: app._id,
          app_display_name,
          offThreadWip: (app.offThreadStatus && app.offThreadStatus.offThreadWip) || false,
          offThreadParams: (app.offThreadStatus && app.offThreadStatus.offThreadParams) || null,
          logo: app.hasLogo 
            ? '/app/info.freezr.account/app2app/' + (appOwnerAndNameForLogo(app.served_url) || app.app_name) + '/static/logo.png'
            : '/app/info.freezr.public/public/static/freezer_logo_empty.png'
        }
      })
      
      // Separate removed and active apps
      for (const app of processedApps) {
        if (app.removed) {
          removedApps.push(app)
        } else {
          userApps.push(app)
        }
      }
    }
    
    // console.log('📱 getStructuredAppListForUser completed:', { userApps: userApps.length, removedApps: removedApps.length })
    return { removed_apps: removedApps, user_apps: userApps }
    
  } catch (error) {
    console.error('❌ Error in getStructuredAppListForUser:', error)
    throw error
  }
}

/**
 * Get app resources data for resource usage page
 * @param {Object} userDS - User data store
 * @returns {Promise<Object>} Promise that resolves to resource usage data
 */
export const getAppResources = async (userDS) => {
  console.log('📊 getAppResources called')
  
  try {
    if (!userDS) {
      throw new Error('User data store not available')
    }
    
    // Get storage usage data
    const sizeJson = await userDS.getStorageUse(null)
    
    console.log('📊 getAppResources completed')
    return sizeJson
    
  } catch (error) {
    console.error('❌ Error in getAppResources:', error)
    throw error
  }
}

/**
 * Get query function by name
 * @param {string} queryName - Name of the query function
 * @returns {Function|null} Query function or null if not found
 */
export const getQueryFunction = (queryName) => {
  const queryFunctions = {
    listAllUserApps,
    getAccountSettings,
    getServerlessSettings,
    getReauthorizeData,
    getResetData,
    generatePermissionHTML,
    getAppResources
  }
  
  return queryFunctions[queryName] || null
}
