// freezr.info - Modern ES6 Module - App Installation Service
// Modern version of app installation using res.locals architecture
//
// Architecture Pattern:
// - Pure service functions without HTTP concerns (no req/res)
// - Uses modern async/await patterns throughout
// - Uses modern dsManager methods directly

import fs from 'fs'
import path from 'path'
import fetch from 'node-fetch'
import { 
  FREEZR_USER_FILES_DIR, 
  isSystemApp, 
  validAppName,
  constructAppIdStringFrom,
  tempAppNameFromFileName,
  APP_MANIFEST_FILE_NAME
} from '../../../common/helpers/config.mjs'

// Import modern file handler from adapters
import { 
  deleteLocalFolderAndContents,
  extractZipToLocalFolder,
  getLocalManifest,
  extractZipAndReplaceToCloudFolder,
  checkManifest,
  appFileListFromZip,
  extractNextFile,
  removeCloudAppFolder
} from '../../../adapters/datastore/fsConnectors/fileHandler.mjs'

// Import modern permission service
import { 
  updatePermissionRecordsFromManifest,
  updatePublicManifestFromManifest
} from './accountPermissionService.mjs'

/**
 * Installation logic for a single user
 * Pure service function - no req/res dependencies
 * 
 * @param {Object} context - Installation context with all required dependencies
 * @returns {Promise<Object>} Installation result
 */
export const oneUserInstallationProcess = async (context) => {
  try {
    // Step 1: Validate input
    validateInput(context)
    
    // Step 2: Extract and process zip file
    await extractAndProcessZip(context)
    
    // Step 3: Validate app name and manifest
    await validateAppAndManifest(context)
    
    // Step 4: Setup app filesystem
    await setupAppFilesystem(context)
    
    // Step 5: Extract files to destination
    await extractFilesToDestination(context)
    
    // Step 6: Process manifest and permissions
    await processManifestAndPermissions(context, true)
    
    // Step 7: Update app list
    await updateAppList(context)
    
    // Step 8: Handle local 3rd party serverless functions (3PFunctions) if needed
    await handleLocal3PFunctions(context)
    
    // Step 9: Preload databases
    await preloadDatabases(context)

    // Clean up temp folder
    await deleteLocalFolderAndContents(getTempFolderPath(context))
    
    return buildResponse(context)
  } catch (error) {
    console.error('❌ oneUserInstallationProcess - error', error)
    
    // Clean up temp folder on error
    try {
      await deleteLocalFolderAndContents(getTempFolderPath(context))
    } catch (err) {
      console.error('❌ Error deleting temp folder', err)
    }
    
    // Log error
    context.errorLogger.error('oneUserInstallationProcess - error', {
      error,
      function: 'oneUserInstallationProcess',
      appInstaled: context.realAppName,
      tempAppName: context.tempAppName
    })

    throw error
  }
}

// Step 1: Validate input
const validateInput = (context) => {
  if (!context.userId) {
    throw new Error('User ID is required')
  }
  if (!context.file) {
    throw new Error('File is required')
  }
  if (!context.file.originalname) {
    throw new Error('File name is required')
  }
  if (context.file.originalname.length < 5 || context.file.originalname.substr(-4) !== '.zip') {
    throw new Error('File must be a zip file')
  }

  const requiredProps = ['userDS', 'ownerPermsDb', 'userAppListDb']
  requiredProps.forEach(prop => {
    if (!context[prop]) {
      throw new Error(prop + ' is required')
    }
  })
}

// Step 2: Extract and process zip file
const extractAndProcessZip = async (context) => {
  context.tempAppName = tempAppNameFromFileName(context.file.originalname)
  const tempFolderPath = getTempFolderPath(context)
  
  // Clean and extract to temp folder
  await deleteLocalFolderAndContents(tempFolderPath)
  await extractZipToLocalFolder(context.file.buffer, tempFolderPath, context.tempAppName)
  
  // Get manifest from temp folder
  try {
    context.manifest = await getLocalManifest(tempFolderPath)
    if (!context.manifest) {
      context.warnings.push({ 
        code: 'manifest_missing', 
        message: 'This app does not have a configuration file (manifest)' 
      })
    }
  } catch (error) {
    console.error('❌ extractAndProcessZip - error getting local manifest', error)
    context.warnings.push({ 
      code: 'manifest_error', 
      error, 
      message: 'The manifest file is NOT readable / parseable. Please contact the app creator to fix the manifest' 
    })
  }
}

// Step 3: Validate app name and manifest
const validateAppAndManifest = async (context) => {
  context.realAppName = (context.manifest && context.manifest.identifier) 
    ? context.manifest.identifier 
    : context.tempAppName
  
  if (context.realAppName !== context.tempAppName) {
    context.warnings.push({
      code: 'app_name_different',
      message: `App name in manifest (${context.realAppName}) differs from file name (${context.tempAppName})`
    })
  }

  // Validate app name
  if (!context.realAppName || context.realAppName.length < 1) {
    throw new Error('App name missing - that is the name of the app zip file name before any spaces.')
  }
  
  if (isSystemApp(context.realAppName) || !validAppName(context.realAppName)) {
    console.error('❌ validateAppAndManifest - app name not allowed', { realAppName: context.realAppName, issyss: isSystemApp(context.realAppName), isvalid: validAppName(context.realAppName) })
    throw new Error('App name not allowed: ' + context.realAppName)
  }
}

// Step 4: Setup app filesystem
const setupAppFilesystem = async (context) => {
  if (!context.userDS) {
    throw new Error('UserDS is not initialized')
  }
  
  if (!context.userDS.appfiles) {
    console.warn('UserDS.appfiles is undefined, initializing it')
    context.userDS.appfiles = {}
  }
  
  // Clear cache if app already exists
  if (context.userDS.appfiles[context.realAppName]) {
    context.userDS.appfiles[context.realAppName] = null
  }
  
  // Get app filesystem (modern async method)
  context.appFS = await context.userDS.getorInitAppFS(context.realAppName, {})
  
  // Clear cache
  context.appFS.cache = context.appFS.cache || {}
  context.appFS.cache.appfiles = {}
}

// Step 5: Extract files to destination
const extractFilesToDestination = async (context) => {
  const realAppPath = getRealAppPath(context)
  
  // Extract to local folder first
  await extractZipToLocalFolder(context.file.buffer, realAppPath, context.tempAppName)

  // Check if static/logo.png exists and if so set context.hasLogo to true
  const logoPath = realAppPath + '/static/logo.png';
  try {
    // With fs.promises.access, if the file doesn't exist, it throws, so we use try/catch:
    await fs.promises.access(logoPath)
    context.hasLogo = true
  } catch (e) {
    console.error('❌ extractFilesToDestination - error checking logo path', {e, thepath: realAppPath + '/static/logo.png' })
    // If checking fails, just skip setting hasLogo
  }
  
  // Handle cloud storage extraction
  if (context.appFS.fsParams.type === 'local' || context.appFS.fsParams.type === 'glitch') {
    // Already copied to local above
  } else if (shouldUseOffThreadExtraction(context)) {
    // Handle off-thread extraction for cloud storage (fire and forget)
    handleOffThreadExtraction(context)
  } else {
    await extractZipAndReplaceToCloudFolder(context.file.buffer, context.file.originalname, context.appFS)
  }
  
  // Clean up temp folder
  const tempFolderPath = getTempFolderPath(context)
  await deleteLocalFolderAndContents(tempFolderPath)
}

// Step 6: Process manifest and permissions
const processManifestAndPermissions = async (context, isUpdateFromFiles = false) => {
  // Normalize manifest
  if (!context.manifest) {
    context.warnings.push({
      code: 'manifest_missing',
      message: 'App does not have a configuration file (manifest)',
      appName: context.realAppName
    })
    context.manifest = {}
  }
  
  if (!context.manifest.identifier) context.manifest.identifier = context.realAppName
  if (!context.manifest.display_name) context.manifest.display_name = context.realAppName
  if (!context.manifest.version) context.manifest.version = 0

  // Check manifest using modern file handler
  const manifestCheckResult = checkManifest(context.manifest, context.realAppName, context.manifest.version)
  
  // Add warnings from manifest check
  if (manifestCheckResult && manifestCheckResult.warnings) {
    manifestCheckResult.warnings.forEach(warning => {
      context.warnings.push({
        code: warning.code,
        message: warning.message,
        appName: context.realAppName,
        severity: warning.severity,
        ...warning
      })
    })
  }

  // Update permissions (using modern service)
  await updatePermissionRecordsFromManifest(context.ownerPermsDb, context.realAppName, context.manifest)

  // Update public manifest (using modern service)
  // Determine if this is an install or update based on context
  if (isUpdateFromFiles) {
    // Update flow: use appFS )(This happends in dev mode when the manifest is beign upfdated from teh appFS caus the appFS from changed manually)
    await updatePublicManifestFromManifest(
      context.userId, 
      context.realAppName, 
      context.manifest, 
      context.publicManifestsDb, 
      { fromUpdateFromFiles: true, appFS: context.appFS }
    )
  } else {
    // Install flow: use tempFolderPath
    await updatePublicManifestFromManifest(
      context.userId, 
      context.realAppName, 
      context.manifest, 
      context.publicManifestsDb, 
      { fromUpdateFromFiles: false, tempFolderPath: getTempFolderPath(context) }
    )
  }
}

// Step 7: Update app list
const updateAppList = async (context) => {
  const customEnv = null // todo to be added later
  
  context.installInfo = await createOrUpdateUserAppList(context, customEnv)
}

// Create or update user app list
const createOrUpdateUserAppList = async (context, customEnv) => {
  const { userAppListDb, manifest, warnings, hasLogo } = context
  const appNameId = constructAppIdStringFrom(context.userId, context.realAppName)

  let appExists = false
  let appEntity = null

  const appName = manifest.identifier || null
  const appDisplayName = manifest.display_name || manifest.identifier

  // Validate input
  if (!appNameId) {
    throw new Error('appNameId is required')
  } else if (!appName) {
    throw new Error('app_name is required')
  } else if (!validAppName(appName)) {
    throw new Error('app_name is invalid: ' + appName)
  }

  // Check if app exists (using modern async method)
  const existingEntity = await userAppListDb.read_by_id(appNameId)
  
  // Create or update the app in the database
  if (existingEntity) {
    appExists = true
    appEntity = existingEntity
    appEntity.manifest = manifest
    appEntity.removed = false
    appEntity.warnings = warnings
    appEntity.app_name = appName
    appEntity.customEnv = customEnv
    appEntity.app_display_name = appDisplayName
    appEntity.updated = new Date().toISOString()
    appEntity.hasLogo = hasLogo
    const res = await userAppListDb.update(appNameId, appEntity, { replaceAllFields: true })
  } else {
    appEntity = { 
      app_name: appName, 
      app_display_name: appDisplayName, 
      served_url: manifest.served_url, 
      manifest, 
      warnings,
      hasLogo,
      installed: new Date().toISOString(),
      customEnv, 
      removed: false 
    }
    await userAppListDb.create(appNameId, appEntity, null)
  }

  return { isUpdate: appExists }
}

// Step 8: Handle 3rd party local serverless functions (3PFunctions)
const handleLocal3PFunctions = async (context) => {
  const manifestPerms = getManifestPermissions(context)
  
  if (manifestPerms && manifestPerms.length > 0 && manifestPerms.filter(perm => perm.type === 'auto_update_local_3pFunction').length > 0) {

    for (const manifestPerm of manifestPerms) {
      if (manifestPerm.type === 'auto_update_local_3pFunction') {
        const grantedPerms = await context.ownerPermsDb.query({ requestor_app: context.realAppName, name: manifestPerm.name, granted: true, type: 'auto_update_local_3pFunction' }, {})
        if (grantedPerms.length === 0) {
          console.warn('auto_update_local_3pFunction permission not yet granted for ' + manifestPerm.name)
          context.warnings.push({
            code: 'auto_update_local_3pFunction_permission_not_granted',
            message: 'auto_update_local_3pFunction permission not yet granted for ' + manifestPerm.name,
            appName: context.realAppName
          })
        } else {
          console.warn('auto_update_local_3pFunction permission FOUND for ' + manifestPerm.name + '. Going to update!!')
          
          const { upsertServerlessFuncsOnInstall } = await import('../../../adapters/datastore/slConnectors/serverless.mjs')
          const realAppPath = getRealAppPath(context)
          
          const installed = await upsertServerlessFuncsOnInstall(context, manifestPerms, realAppPath)
          
          if (installed.error) {
            const warningMessage = 'Failed to install 3rd party local serverless functions (3PFunctions)'
            
            context.errorLogger.error(warningMessage, {
              function: 'handleLocal3PFunctions',
              warning: 'local3PFunctions_install_failed',
              appInstalName: context.realAppName,
              error: installed.error
            })
            
            
            context.warnings.push({
              code: 'local3PFunctions_install_failed',
              message: warningMessage,
              appName: context.realAppName,
              error: installed.error
            })
          }
        }
      }
    }
  }
  return
}

// Step 9: Preload databases
const preloadDatabases = async (context) => {
  if (!context.manifest) {
    console.warn('No manifest for ' + context.realAppName + '- creating one - SNBH')
    context.manifest = { app_tables: {} }
    context.manifest.app_tables[context.realAppName] = {}
  }
  
  if (context.manifest.app_tables && Object.keys(context.manifest.app_tables).length > 0 && context.manifest.app_tables.constructor === Object) {
    const preloadPromises = Object.keys(context.manifest.app_tables).map(appTable => 
      preloadDatabase(context, appTable)
    )
    
    await Promise.allSettled(preloadPromises)
  }
}

// Helper function to preload a single database
const preloadDatabase = async (context, appTable) => {
  const oac = {
    owner: context.userId,
    app_name: context.realAppName,
    collection_name: appTable
  }
  
  try {
    const aDb = await context.userDS.getorInitDb(oac, { freezrPrefs: context.freezrPrefs })
    
    if (!aDb || !aDb.query) {
      console.warn('preloadDatabase - err in initiating installed app db - no db present')
      return
    }
    // db fake query for init (using modern async method)
    await aDb.query(null, { count: 1 })
  } catch (err) {
    console.warn('preloadDatabase - err in initiating installed app db ', err)
  }
}

// Build response object
const buildResponse = (context) => {
  return { 
    error: null, 
    success: true,
    appName: context.realAppName,
    isUpdate: context.installInfo.isUpdate,
    message: context.installInfo.isUpdate ? 'App updated successfully' : 'App installed successfully',
    warnings: context.warnings,
    flags: { 
      meta: { 
        app_name: context.realAppName, 
        didwhat: context.installInfo.isUpdate ? 'updated' : 'uploaded' 
      } 
    }
  }
}

// Helper functions
const getTempFolderPath = (context) => {
  return (context.userDS.fsParams.rootFolder || FREEZR_USER_FILES_DIR) + '/' + context.userId + '/tempapps/' + context.tempAppName
}

const getRealAppPath = (context) => {
  return (context.appFS.fsParams.rootFolder || FREEZR_USER_FILES_DIR) + '/' + context.userId + '/apps/' + context.realAppName
}

/**
 * Download file from URL and return as buffer
 * @param {string} fileUrl - URL to download from
 * @returns {Promise<Buffer>} File buffer
 */
const downloadFileFromUrl = async (fileUrl) => {
  try {
    const response = await fetch(fileUrl)
    if (!response.ok) {
      throw new Error(`Failed to fetch: ${response.statusText} (${response.status})`)
    }
    
    // Handle different fetch implementations
    // node-fetch v2: response.buffer()
    // node-fetch v3: response.arrayBuffer() then Buffer.from()
    // Built-in fetch (Node 18+): response.arrayBuffer() then Buffer.from()
    let buffer
    if (typeof response.buffer === 'function') {
      // node-fetch v2
      buffer = await response.buffer()
    } else {
      // node-fetch v3 or built-in fetch
      const arrayBuffer = await response.arrayBuffer()
      buffer = Buffer.from(arrayBuffer)
    }
    
    return buffer
  } catch (error) {
    console.error('❌ downloadFileFromUrl - error', error)
    throw new Error(`Failed to download file from URL: ${error.message}`)
  }
}

/**
 * Install app from URL
 * Downloads the zip file from URL and installs it using oneUserInstallationProcess
 * 
 * @param {Object} context - Installation context with all required dependencies
 * @param {string} context.appUrl - URL to download the zip file from
 * @param {string} context.appName - Name of the app (used for temp file naming)
 * @returns {Promise<Object>} Installation result
 */
export const installAppFromUrl = async (context) => {
  try {
    // Validate URL and app name
    if (!context.appUrl) {
      throw new Error('App URL is required')
    }
    if (!context.appName) {
      throw new Error('App name is required')
    }

    // Download file from URL
    // console.log('📥 installAppFromUrl service - Downloading app from URL:', context.appUrl)
    const fileBuffer = await downloadFileFromUrl(context.appUrl)
    // console.log('📥 installAppFromUrl service - File downloaded, size:', fileBuffer.length, 'bytes')

    // Create file object for installation process
    context.file = {
      originalname: context.appName + '.zip',
      buffer: fileBuffer
    }
    context.installSource = 'installAppFromUrl'

    // Call the standard installation process
    const result = await oneUserInstallationProcess(context)

    context.errorLogger.log('install app success', {
      function: 'installAppFromUrl',
      appUrl: context.appUrl,
      appInstalName: context.appName
    })
    return result

  } catch (error) {
    console.error('❌ installAppFromUrl - error', error)
    
    // Log error
    context.errorLogger.error('installAppFromUrl - error', {
      error,
      function: 'installAppFromUrl',
      appUrl: context.appUrl,
      appInstalName: context.appName
    })
    
    throw error
  }
}

const shouldUseOffThreadExtraction = (context) => {
  const should = context.installSource === 'installAppFromUrl' && 
  ['dropbox', 'googleDrive', 'fdsFairOs'].includes(context.appFS.fsParams.type)
  console.log('🔍 shouldUseOffThreadExtraction', { installSource: context.installSource, type: context.appFS.fsParams.type, should })
  return context.installSource === 'installAppFromUrl' && 
         ['dropbox', 'googleDrive', 'fdsFairOs'].includes(context.appFS.fsParams.type)
}

// Off-thread extraction for cloud storage
const TRY_THRESHOLD = 5

const offThreadExtraction = async (params) => {
  const appNameId = constructAppIdStringFrom(params.userId, params.appFS.appName)

  if (!params?.userId || !params?.appFS?.appName) {
    console.error('❌ offThreadExtraction - missing params', { userId: params.userId, appName: params.appFS?.appName })
    throw new Error('missing params')
  }

  if (params.init) {
    // INIT phase: Get file list and set up app record
    const [err, fileList] = appFileListFromZip(params.file)
    if (err) {
      console.error('❌ offThreadExtraction - error getting file list from zip:', err)
      throw err
    }

    // Flag the app list DB as being WIP
    const offThreadStatus = {
      installFileUrl: params.fileUrl,
      offThreadParams: {
        tryNum: 1,
        versionDate: params.versionDate,
        filesRemaining: fileList
      },
      offThreadWip: true
    }

    try {
      // Check if app record exists (using modern async method)
      const record = await params.userAppListDb.read_by_id(appNameId)
      
      if (!record) {
        // Create new app record
        await params.userAppListDb.create(appNameId, {
          app_name: params.appFS.appName,
          app_display_name: params.appFS.appName,
          manifest: null,
          removed: false,
          offThreadStatus
        }, null)
        
        // Schedule next extraction in 10s
        params.init = false
        params.tryNum = 1
        params.filesRemaining = fileList
        setTimeout(() => {
          offThreadExtraction(params).catch(err => {
            console.error('handleOffThreadExtraction: Error in background extraction:', err)
            params.errorLogger.error('handleOffThreadExtraction: Error in background extraction:', {
              error: err,
              function: 'handleOffThreadExtraction',
              appInstalName: params.appFS.appName,
              background: true
            })
          })
        }, 10000)
      } else {
        // Update existing app record
        await params.userAppListDb.update(appNameId, { offThreadStatus }, { replaceAllFields: false })
        
        // Remove cloud folder and schedule extraction
        params.init = false
        params.tryNum = 1
        params.filesRemaining = fileList
        setTimeout(() => {
          removeCloudAppFolder(params.appFS, (err) => {
            if (err) {
              console.warn('offThreadExtraction err in removeCloudAppFolder - (Will try installing in any case) ', err)
            }
            // Call offThreadExtraction in background (fire and forget)
            offThreadExtraction(params).catch(err => {
              console.error('handleOffThreadExtraction: Error in background extraction:', err)
              params.errorLogger.error('handleOffThreadExtraction: Error in background extraction:', {
                error: err,
                function: 'handleOffThreadExtraction',
                appInstalName: params.appFS.appName,
                background: true
              })
            })
          })
        }, 2000)
      }
    } catch (err) {
      console.error('❌ offThreadExtraction - error reading/updating app record:', err)
      throw err
    }
  } else if (params.tryNum > TRY_THRESHOLD) {
    console.warn('⚠️ offThreadExtraction - tried installing app maximum times ', params.tryNum)
    return
  } else {
    // Extraction phase: Process files one by one
    try {
      const appRecord = await params.userAppListDb.read_by_id(appNameId)
      
      if (!appRecord) {
        params.tryNum++
        console.warn('⚠️ offThreadExtraction - NO APP RECORD', { appNameId, params })
        setTimeout(() => {
          offThreadExtraction(params).catch(err => {
            console.error('handleOffThreadExtraction: Error in background extraction:', err)
          })
        }, params.tryNum * 2000)
        return
      }
      
      if (!appRecord.offThreadStatus || !appRecord.offThreadStatus.offThreadParams || !appRecord.offThreadStatus.offThreadParams.tryNum) {
        params.tryNum++
        console.warn('⚠️ offThreadExtraction - missing offThreadStatus', { appNameId, appRecord, params })
        setTimeout(() => {
          offThreadExtraction(params).catch(err => {
            console.error('handleOffThreadExtraction: Error in background extraction:', err)
          })
        }, params.tryNum * 2000)
        return
      }
      
      if (appRecord.offThreadStatus.offThreadParams.versionDate !== params.versionDate) {
        console.warn('⚠️ offThreadExtraction - version date mismatch', { appRecord, params })
        // New installation process has begun - abort this one
        return
      }
      
      if (appRecord.offThreadStatus.offThreadWip === false) {
        // Extraction already complete
        return
      }
      
      // Process next file
      params.appRecord = appRecord
      params.filesRemaining = appRecord.offThreadStatus.offThreadParams.filesRemaining || []
      
      extractNextFile(params, (err, newFileList) => {
        if (err) {
          console.error('❌ offThreadExtraction - error extracting file:', err)
          params.tryNum++
          setTimeout(() => {
            offThreadExtraction(params).catch(err => {
              console.error('handleOffThreadExtraction: Error in background extraction:', err)
            })
          }, params.tryNum * 2000)
          return
        }
        
        // Handle async operations in callback using Promise
        ;(async () => {
          if (newFileList.length === 0) {
            // All files extracted successfully
            const offThreadStatus = {
              offThreadParams: null,
              offThreadWip: false
            }
            try {
              await params.userAppListDb.update(appNameId, { offThreadStatus }, { replaceAllFields: false })
            } catch (err) {
              console.warn('⚠️ offThreadExtraction - error updating final status:', err)
            }
          } else {
            // Continue with remaining files
            params.tryNum = 1
            params.filesRemaining = newFileList
            const offThreadStatus = {
              offThreadParams: {
                tryNum: 1,
                versionDate: params.versionDate,
                filesRemaining: newFileList,
                currentUpdateTime: new Date().getTime()
              }
            }
            
            try {
              await params.userAppListDb.update(appNameId, { offThreadStatus }, { replaceAllFields: false })
            } catch (err) {
              console.warn('⚠️ offThreadExtraction - error updating status:', err)
              params.tryNum++
            }
            
            // Schedule next extraction in 5s
            setTimeout(() => {
              offThreadExtraction(params).catch(err => {
                console.error('handleOffThreadExtraction: Error in background extraction:', err)
              })
            }, 5000)
          }
        })().catch(err => {
          console.error('❌ offThreadExtraction - error in async callback:', err)
        })
      })
    } catch (err) {
      console.error('❌ offThreadExtraction - error reading app record during extraction:', err)
      params.tryNum++
      setTimeout(() => {
        offThreadExtraction(params).catch(err => {
          console.error('handleOffThreadExtraction: Error in background extraction:', err)
        })
      }, params.tryNum * 2000)
    }
  }
}

const handleOffThreadExtraction = (context) => {
  // Fire and forget - start the off-thread extraction without waiting
  offThreadExtraction({
    file: context.file.buffer,
    name: context.file.originalname,
    userId: context.userId,
    appFS: context.appFS,
    userAppListDb: context.userAppListDb,
    fileUrl: context.fileUrl,
    versionDate: new Date().getTime(),
    init: true,
    errorLogger: context.errorLogger
  }).catch(err => {
    console.error('handleOffThreadExtraction: Error in background extraction:', err)
    // Log error but don't throw - this is fire-and-forget
    context.errorLogger.error('handleOffThreadExtraction: Error in background extraction:', {
      error: err,
      function: 'handleOffThreadExtraction',
      appInstalName: context.realAppName,
      background: true
    })
  })
}

const getManifestPermissions = (context) => {
  return (context.manifest && context.manifest.permissions && Object.keys(context.manifest.permissions).length > 0) 
    ? JSON.parse(JSON.stringify(context.manifest.permissions)) 
    : null
}

/**
 * Update app from existing files (refresh manifest, update permissions)
 * Pure service function - no req/res dependencies
 * 
 * @param {Object} context - Update context with all required dependencies
 * @returns {Promise<Object>} Update result
 */
export const updateAppFromFiles = async (context) => {
  try {
    // Step 1: Validate input
    validateUpdateInput(context)
    
    // Step 2: Setup app filesystem
    await setupAppFilesystemForUpdate(context)
    
    // Step 3: Clean local folder if using cloud storage
    await cleanLocalFolderIfNeeded(context)
    
    // Step 4: Read and process manifest
    await readAndProcessManifest(context)
    
    // Step 5: Process manifest and permissions
    await processManifestAndPermissions(context, true)
    
    // Step 6: Update app list
    await updateAppList(context)
    
    return { 
      error: null, 
      success: true,
      appName: context.realAppName,
      isUpdate: true,
      message: 'App updated successfully',
      warnings: context.warnings,
      flags: { 
        meta: { 
          app_name: context.realAppName, 
          didwhat: 'updated' 
        } 
      }
    }
  } catch (error) {
    console.error('❌ updateAppFromFiles - error', error)
    
    // Log error
    context.errorLogger.error('updateAppFromFiles - error', {
      error,
      function: 'updateAppFromFiles',
      appInstalName: context.realAppName
    })
    
    throw error
  }
}

// Step 1: Validate input for update
const validateUpdateInput = (context) => {
  if (!context.userId) {
    throw new Error('User ID is required')
  }
  if (!context.realAppName) {
    throw new Error('App name is required')
  }
  if (!validAppName(context.realAppName)) {
    throw new Error('App name is invalid: ' + context.realAppName)
  }
  if (isSystemApp(context.realAppName)) {
    throw new Error('Cannot update system app: ' + context.realAppName)
  }
  if (!context.userDS) {
    throw new Error('User data store is required')
  }
  if (!context.ownerPermsDb) {
    throw new Error('User permissions database is required')
  }
  if (!context.publicManifestsDb) {
    throw new Error('Public manifests database is required')
  }
  if (!context.userAppListDb) {
    throw new Error('User app list database is required')
  }
}

// Step 2: Setup app filesystem for update
const setupAppFilesystemForUpdate = async (context) => {
  if (!context.userDS.appfiles) {
    context.userDS.appfiles = {}
  }
  
  // Clear cache if app already exists
  if (context.userDS.appfiles[context.realAppName]) {
    context.userDS.appfiles[context.realAppName] = null
  }
  
  // Get app filesystem (modern async method)
  context.appFS = await context.userDS.getorInitAppFS(context.realAppName, {})
  
  // Reset cache
  context.appFS.cache = context.appFS.cache || {}
  context.appFS.cache.appfiles = {}
}

// Step 3: Clean local folder if using cloud storage
const cleanLocalFolderIfNeeded = async (context) => {
  const realAppPath = getRealAppPath(context)

  // Check if static/logo.png exists and if so set context.hasLogo to true
  try {
    const logoPath = path.join(realAppPath, 'static', 'logo.png');
    await fs.promises.access(logoPath)
    context.hasLogo = true 
  } catch (e) {
    // If checking fails, just skip setting hasLogo
  }
  
  // Only delete local folder if using cloud storage (not local or glitch)
  if (context.appFS.fsParams.type !== 'local' && context.appFS.fsParams.type !== 'glitch') {
    await deleteLocalFolderAndContents(realAppPath)
  }
}

// Step 4: Read and process manifest
const readAndProcessManifest = async (context) => {
  try {
    // Read manifest from appFS (modern async method)
    const readManifest = await context.appFS.readAppFile(APP_MANIFEST_FILE_NAME, {})
    
    if (!readManifest) {
      context.warnings.push({
        code: 'manifest_missing',
        message: 'App does not have a configuration file (manifest)',
        appName: context.realAppName
      })
      context.manifest = {}
    } else {
      try {
        context.manifest = JSON.parse(readManifest)
      } catch (e) {
        console.error('❌ Error parsing manifest:', e)
        context.warnings.push({
          code: 'manifest_read_err',
          message: 'Error parsing manifest file',
          appName: context.realAppName,
          error: e.message
        })
        context.manifest = {}
      }
    }
  } catch (error) {
    // Assume missing manifest if read fails
    context.warnings.push({
      code: 'manifest_missing',
      message: 'App does not have a configuration file (manifest)',
      appName: context.realAppName
    })
    context.manifest = {}
  }

  // console.log('🔍 readAndProcessManifest - manifest', { manifest: context.manifest })
  
  // Normalize manifest
  if (!context.manifest.identifier) {
    context.manifest.identifier = context.realAppName
  }
  if (!context.manifest.display_name) {
    context.manifest.display_name = context.realAppName
  }
  if (!context.manifest.version) {
    context.manifest.version = 0
  }
  
  // Check manifest using modern file handler
  const manifestCheckResult = checkManifest(context.manifest, context.realAppName, context.manifest.version)
  
  // Add warnings from manifest check
  if (manifestCheckResult && manifestCheckResult.warnings) {
    manifestCheckResult.warnings.forEach(warning => {
      context.warnings.push({
        code: warning.code,
        message: warning.message,
        appName: context.realAppName,
        severity: warning.severity,
        ...warning
      })
    })
  }
}