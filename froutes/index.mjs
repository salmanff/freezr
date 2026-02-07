// freezr.info - Modern ES6 Module - Master Route Mounting
// Orchestrates mounting of all modern routes
//
// Architecture Pattern:
// - Single entry point for all route mounting
// - Imports and calls individual feature route mounters
// - Provides clean interface for server.js

/**
 * Mount all modern routes
 * 
 * This is the single function called from server.js to mount all modern routes.
 * It orchestrates mounting of all feature routes (account, admin, apps, etc.)
 * 
 * @param {Object} app - Express application instance
 * @param {Object} dependencies - Required dependencies
 * @param {Object} dependencies.dsManager - Data store manager
 * @param {Object} dependencies.freezrPrefs - Freezr preferences
 * @param {Object} dependencies.freezrStatus - Freezr status
 * @returns {Promise<Object>} Result object with success status and details
 */
export async function mountAllModernRoutes(app, { dsManager, freezrPrefs, freezrStatus, logManager }) {
  // onsole.log('🚀 Mounting all modern routes...')
  
  const results = {
    success: true,
    mounted: [],
    failed: []
  }
  
  try {
    // Import and mount account routes directly
    try {
      const { createAcctApiRoutes, createAccountPageRoutes } = await import('../features/account/accountRoutes.mjs')
      
      // Mount account API routes at /acctapi
      const accountApiRoutes = createAcctApiRoutes({ dsManager, freezrPrefs, freezrStatus, logManager })
      app.use('/acctapi', accountApiRoutes)
      results.mounted.push('account-api')
      // onsole.log('✅ Mounted account API routes at /acctapi')
      
      // Mount account page routes at /account
      const accountPageRoutes = createAccountPageRoutes({ dsManager, freezrPrefs, freezrStatus })
      app.use('/account', accountPageRoutes)
      results.mounted.push('account-pages')
      // onsole.log('✅ Mounted account page routes at /account')
    } catch (error) {
      console.error('❌ Failed to mount account routes:', error)
      results.failed.push({ feature: 'account', error })
    }
    
    // Import and mount app routes directly
    try {
      const { createAppApiRoutes } = await import('../features/apps/appApiRoutes.mjs')
      const { createAppPageRoutes } = await import('../features/apps/appPageRoutes.mjs')
      // const { createAppFileRoutes } = await import('../features/apps/appFileRoutes.mjs')
      
      // Mount app API routes at /feps -> TEMPRARY UNTIL ROUTE FIGURED OUT
      // todo 2025-12-19 -> shoul logManager be included in older routes too eg appApiRoutes
      const appApiRoutes = createAppApiRoutes({ dsManager, freezrPrefs, freezrStatus })
      app.use('/feps', appApiRoutes)
      results.mounted.push('app-api')
      // onsole.log('✅ Mounted app API routes at /feps')
      
      // Mount app page routes at /apps
      const appPageRoutes = createAppPageRoutes({ dsManager, freezrPrefs, freezrStatus })
      app.use('/app', appPageRoutes)
      app.use('/apps', appPageRoutes)
      results.mounted.push('app-pages')
      // onsole.log('✅ Mounted app page routes at /apps')
      
      
      // Mount app file routes at /app_files -> 2025-12 - REPLACED WITH APP/ ROUTE
      // const appFileRoutes = createAppFileRoutes({ dsManager, freezrPrefs, freezrStatus })
      // app.use('/app_files', appFileRoutes)
      // results.mounted.push('app-files')
      // onsole.log('✅ Mounted app file routes at /app_files')
    } catch (error) {
      console.error('❌ Failed to mount app routes:', error)
      results.failed.push({ feature: 'app', error })
    }
    
    // Import and mount CEPS routes
    try {
      const { createCepsApiRoutes } = await import('../features/apps/cepsApiRoutes.mjs')
      
      // Mount CEPS API routes at /ceps
      const cepsApiRoutes = createCepsApiRoutes({ dsManager, freezrPrefs, freezrStatus, logManager })
      app.use('/ceps', cepsApiRoutes)
      results.mounted.push('ceps-api')
      // onsole.log('✅ Mounted CEPS API routes at /ceps')
    } catch (error) {
      console.error('❌ Failed to mount CEPS routes:', error)
      results.failed.push({ feature: 'ceps', error })
    }

        
    // Import and mount register routes
    try {
      const { createRegisterPageRoutes } = await import('../features/register/registerRoutes.mjs')
      
      // Mount register page routes at /register
      const registerPageRoutes = createRegisterPageRoutes({ dsManager, freezrPrefs, freezrStatus })
      app.use('/register', registerPageRoutes)
      results.mounted.push('register-pages')
      // onsole.log('✅ Mounted register page routes at /register')
    } catch (error) {
      console.error('❌ Failed to mount register routes:', error)
      results.failed.push({ feature: 'register', error })
    }
    
    // Import and mount admin routes
    try {
      const { createAdminPageRoutes } = await import('../features/admin/adminRoutes.mjs')
      const { createAdminApiRoutes } = await import('../features/admin/adminApiRoutes.mjs')
      
      // Mount admin page routes at /admin
      const adminPageRoutes = createAdminPageRoutes({ dsManager, freezrPrefs, freezrStatus })
      app.use('/admin', adminPageRoutes)
      results.mounted.push('admin-pages')
      // onsole.log('✅ Mounted admin page routes at /admin')
      
      // Mount admin API routes at /adminapi
      const adminApiRoutes = createAdminApiRoutes({ dsManager, freezrPrefs, freezrStatus, logManager })
      app.use('/adminapi', adminApiRoutes)
      results.mounted.push('admin-api')
      // onsole.log('✅ Mounted admin API routes at /adminapi')
    } catch (error) {
      console.error('❌ Failed to mount admin routes:', error)
      results.failed.push({ feature: 'admin', error })
    }
    
    // Import and mount OAuth routes
    try {
      const { createOauthApiRoutes } = await import('../features/oauth/oauthRoutes.mjs')
      
      // Mount OAuth API routes at /oauth
      const oauthApiRoutes = createOauthApiRoutes({ dsManager, freezrPrefs, freezrStatus })
      app.use('/oauth', oauthApiRoutes)
      results.mounted.push('oauth-api')
      // onsole.log('✅ Mounted OAuth API routes at /oauth') // oauth/privateapi/ and oauth/:dowhat
    } catch (error) {
      console.error('❌ Failed to mount OAuth routes:', error)
      results.failed.push({ feature: 'oauth', error })
    }

    // Other
    app.get('/.well-known/appspecific/com.chrome.devtools.json', () => { /* console.log('ignore com.chrome.devtools.json') */ } )
    app.get('/login', (req, res) => { res.redirect('/account/login') } )
    
    // Import and mount public routes
    try {
      const { createPublicRoutes, createPublicCatchAllRoutes } = await import('../features/public/publicRoutes.mjs')
      
      // Mount public routes at /public
      const publicRoutes = createPublicRoutes({ dsManager, freezrPrefs, freezrStatus })
      app.use('/public', publicRoutes)
      results.mounted.push('public')
      // onsole.log('✅ Mounted public routes at /public')
      
      // Mount catch-all for legacy public ID routes at root level
      // This catches /@user/app.table/objectId patterns
      const publicCatchAllRoutes = createPublicCatchAllRoutes({ dsManager, freezrPrefs, freezrStatus })
      app.use('/', publicCatchAllRoutes)
      results.mounted.push('public-catchall')
      // onsole.log('✅ Mounted public catch-all routes at /')
    } catch (error) {
      console.error('❌ Failed to mount public routes:', error)
      results.failed.push({ feature: 'public', error })
    }

    
    // Summary
    if (results.mounted.length > 0) {
      // onsole.log(`✅ Successfully mounted ${results.mounted.length} route(s): ${results.mounted.join(', ')}`)
    }
    if (results.failed.length > 0) {
      console.warn(`⚠️  Failed to mount ${results.failed.length} route(s): ${results.failed.map(f => f.feature).join(', ')}`)
      results.success = false
    }
    
    return results
    
  } catch (error) {
    console.error('❌ Critical error mounting routes:', error)
    return {
      success: false,
      mounted: [],
      failed: [{ feature: 'all', error }]
    }
  }
}

export default {
  mountAllModernRoutes
}

