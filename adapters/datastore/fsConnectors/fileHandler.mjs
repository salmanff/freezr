// freezr.info - nodejs system files - fileHandler.mjs
// Modern file handling functions for gradual modernization

// Import Node.js standard modules using ES module syntax
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// Import fflate for ZIP operations
import { unzip, unzipSync } from 'fflate'

// Import new modular helpers - use ES module imports for new .mjs files
import { validAppName, isSystemApp, FREEZR_USER_FILES_DIR } from '../../../common/helpers/config.mjs'
import { startsWith, endsWith } from '../../../common/helpers/utils.mjs'

// Utility function to ensure directory exists
const ensureDirectoryExists = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

// Get path separator (replicating sep function from file_handler.js)
const sep = () => path.sep

// Remove start and end slashes (replicating removeStartAndEndSlashes from file_handler.js)
const removeStartAndEndSlashes = (aUrl) => {
  if (startsWith(aUrl, '/')) aUrl = aUrl.slice(1)
  if (aUrl.slice(aUrl.length - 1) === '/') aUrl = aUrl.slice(0, aUrl.length - 1)
  return aUrl
}

// Get system path - returns project root directory
const systemPath = () => {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  // Navigate up from adapters/datastore/fsConnectors to project root
  return path.normalize(path.join(__dirname, '..', '..', '..'))
}

// Get full local path (replicating fullLocalPathTo from file_handler.js)
const fullLocalPathTo = (partialPath) => {
  if (partialPath) {
    return path.normalize(systemPath() + path.sep + removeStartAndEndSlashes(partialPath))
  } else {
    return systemPath()
  }
}

// Delete local folder and contents
const deleteLocalFolderAndContents = async (folderPath) => {
  if (!folderPath) {
    throw new Error('Folder path is required')
  }

  return new Promise((resolve, reject) => {
    if (!fs.existsSync(folderPath)) {
      resolve() // Folder doesn't exist, nothing to delete
      return
    }

    const deleteRecursive = (dirPath) => {
      if (fs.existsSync(dirPath)) {
        fs.readdirSync(dirPath).forEach((file) => {
          const curPath = path.join(dirPath, file)
          if (fs.lstatSync(curPath).isDirectory()) {
            deleteRecursive(curPath)
          } else {
            fs.unlinkSync(curPath)
          }
        })
        fs.rmdirSync(dirPath)
      }
    }

    try {
      deleteRecursive(folderPath)
      resolve()
    } catch (error) {
      reject(new Error(`Failed to delete folder ${folderPath}: ${error.message}`))
    }
  })
}

// Extract zip to local folder
const extractZipToLocalFolder = async (zipBuffer, targetPath, appName) => {
  if (!zipBuffer) {
    throw new Error('Zip buffer is required')
  }
  if (!targetPath) {
    throw new Error('Target path is required')
  }
  if (!appName) {
    throw new Error('App name is required')
  }

  try {
    // Ensure target directory exists
    ensureDirectoryExists(targetPath)

    // Extract zip using fflate
    const unzipped = unzipSync(zipBuffer)

    for (const [fileName, content] of Object.entries(unzipped)) {
      if (fileName.endsWith('/') || startsWith(fileName, '__MACOSX')) {
        continue
      }

      let targetFileName = fileName
      
      // Remove leading slash if present
      if (startsWith(fileName, '/')) {
        targetFileName = targetFileName.slice(1)
      }
      
      // Handle double header folders - remove app name prefix if present
      if (startsWith(fileName, appName)) {
        targetFileName = targetFileName.slice(targetFileName.indexOf('/') + 1)
      }
      
      // Get the directory path for this file
      const lastSlashIndex = targetFileName.lastIndexOf('/')
      const targetDir = lastSlashIndex > 0 ? targetFileName.slice(0, lastSlashIndex) : ''
      const fullTargetPath = path.join(targetPath, targetDir)
      
      // Ensure directory exists
      if (targetDir) {
        await fs.promises.mkdir(fullTargetPath, { recursive: true })
      }
      
      // Write the file
      const fullFilePath = path.join(targetPath, targetFileName)
      await fs.promises.writeFile(fullFilePath, content)
    }
  } catch (error) {
    console.error('extractZipToLocalFolder error', { targetPath, appName, error })
    throw new Error(`Failed to extract zip to ${targetPath}: ${error.message}`)
  }
}

// Get local file from extracted folder
export const getLocalFile = async (folderPath, partialPath) => {
  if (!folderPath) {
    throw new Error('Folder path is required')
  }
  if (!partialPath) {
    throw new Error('Partial path is required')
  }

  const fullPath = path.join(folderPath, partialPath)
  
  try {
    // Read file content using async fs.readFile
    const fileContent = await fs.promises.readFile(fullPath, 'utf8')
    return fileContent
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null // No file found
    }
    throw new Error(`Failed to read file from ${fullPath}: ${error.message}`)
  }
}

// Get local manifest from extracted folder
const getLocalManifest = async (folderPath) => {
  if (!folderPath) {
    throw new Error('Folder path is required')
  }

  try {
    const manifestContent = await getLocalFile(folderPath, 'manifest.json')
    if (!manifestContent) {
      return null // No manifest found
    }
    
    const manifest = JSON.parse(manifestContent)
    return manifest
  } catch (error) {
    throw new Error(`Failed to parse manifest: ${error.message}`)
  }
}

// Extract zip and replace to cloud folder
const extractZipAndReplaceToCloudFolder = async (zipBuffer, originalName, appFS) => {
  if (!zipBuffer) {
    throw new Error('Zip buffer is required')
  }
  if (!originalName) {
    throw new Error('Original name is required')
  }
  if (!appFS) {
    throw new Error('App filesystem is required')
  }

  try {
    // Step 1: Remove the existing folder
    const appPath = (appFS.fsParams.rootFolder || FREEZR_USER_FILES_DIR) + '/' + appFS.owner + '/apps/' + appFS.appName
    // onsole.log('extractZipAndReplaceToCloudFolder', appPath)

    if (appFS.removeFolder) {
      await appFS.removeFolder(appPath)
    } else {
      throw new Error('removeFolder not available... debug')
    }
    
    // Step 2: Create the folder again
    if (appFS.fs.mkdirp_async) { /// 2025-11 temp todo-moddernization - need to review this - was fsMkdirp_async
      await appFS.fs.mkdirp_async(appPath)
    } else if (appFS.mkdirp) { 
      console.warn('2025-11 temp todo-moddernization - need to review this - was fsMkdirp SNBH?')
      await appFS.fsMkdirp(appPath)
    } else {
      throw new Error('fsMkdirp not available.. debug')
    }
    
    // Step 3: Extract zip to cloud folder
    await extractZipToCloudFolder(zipBuffer, originalName, appFS)
  } catch (error) {
    console.error('extractZipAndReplaceToCloudFolder', error)
    throw new Error(`Failed to extract zip and replace to cloud folder: ${error.message}`)
  }
}

// Extract zip to cloud folder
const extractZipToCloudFolder = async (zipfile, originalname, appFS) => {
  try {
    // Extract zip using fflate
    const unzipped = unzipSync(zipfile)
    
    // Detect directory structure (similar to original logic)
    let gotDirectoryWithAppName = null
    for (const fileName of Object.keys(unzipped)) {
      if (fileName.endsWith('/')) {
        // This is for case of compressing a zip file which includes a root folder with the app names
        if (!gotDirectoryWithAppName && startsWith(fileName, appFS.appName) && fileName.indexOf('/') > 1) {
          gotDirectoryWithAppName = fileName.slice(0, fileName.indexOf('/') + 1)
        }
        if (!gotDirectoryWithAppName && fileName === originalname + '/') { 
          gotDirectoryWithAppName = originalname + '/' 
        }
      }
    }

    // Process each file
    for (const [fileName, content] of Object.entries(unzipped)) {
      if (fileName.endsWith('/') || startsWith(fileName, '__MACOSX')) {
        continue
      }
      
      const parts = fileName.split('/')
      if (startsWith(parts[parts.length - 1], '.')) {
        continue
      }
      
      let targetFileName = fileName
      if (gotDirectoryWithAppName && startsWith(fileName, gotDirectoryWithAppName)) {
        targetFileName = fileName.substring(gotDirectoryWithAppName.length)
      } else if (gotDirectoryWithAppName) {
        continue
      }
      
      // Validate content before writing
      if (content === undefined) {
        console.error('extractZipToCloudFolder: Content is undefined for file:', fileName)
        throw new Error(`Content is undefined for file: ${fileName}`)
      }
      
      // Write to cloud storage using appFS.async
      try {
        if (appFS.writeToAppFiles) {
          await appFS.writeToAppFiles(targetFileName, content, { doNotOverWrite: false })
        } else {
          // Fallback for system apps or when writeToAppFiles is not available
          throw new Error(`writeToAppFiles not available - debug: ${targetFileName}`)
        }
      } catch (err) {
        console.error('extractZipToCloudFolder', 'Error writing file ' + targetFileName + ' to cloud', err)
        throw err
      }
    }
  } catch (error) {
    throw new Error(`Failed to extract zip to cloud folder: ${error.message}`)
  }
}

// Remove cloud app folder (replicating removeCloudAppFolder from file_handler.js)
const removeCloudAppFolder = async (appFS, callback) => {
  // console.log - think through - should this really be in ds_manager?
  const appPath = (appFS.fsParams.rootFolder || FREEZR_USER_FILES_DIR) + '/' + appFS.owner + '/apps/' + appFS.appName
  
  try {
    // Step 1: Remove the folder
    if (appFS.removeFolder) {
      await appFS.removeFolder(appPath, null)
    } else {
      throw new Error('removeFolder not available, skipping folder removal')
    }
    
    // Step 2: Create the folder again
    if (appFS.fs.mkdirp_async) { /// 2025-11 temp todo-moddernization - need to review this - was fsMkdirp_async
      await appFS.fs.mkdirp_async(appPath)
    } else if (appFS.mkdirp) { 
      console.warn('2025-11 temp todo-moddernization - need to review this - was fsMkdirp SNBH?')
      await appFS.fsMkdirp(appPath)
    } else {
      throw new Error('fsMkdirp not available, skipping folder creation')
    }
    
    callback(null)
  } catch (err) {
    callback(err)
  }
}


// Get list of files from zip (replicating appFileListFromZip from file_handler.js)
const appFileListFromZip = (zipfile) => {
  try {
    const unzipped = unzipSync(zipfile)
    const fileList = []
    
    for (const fileName of Object.keys(unzipped)) {
      if (!fileName.endsWith('/') && !startsWith(fileName, '__MACOSX')) {
        fileList.push(fileName)
      }
    }
    
    return [null, fileList]
  } catch (e) {
    console.error('appFileListFromZip error:', e)
    return [e]
  }
}


// Extract next file from zip 
const extractNextFile = async (params, callback) => {
  /* params:
      file: req.file.buffer,
      name: req.file.originalname,
      appFS,
      freezrUserAppListDB: req.freezrUserAppListDB,
      fileUrl: req.body.app_url,
      versionDate: new Date().getTime(),
      init: true
      // appRecord: [record from freezrUserAppListDB]
      // params.filesRemaining = fileList
  */
  const fileList = [...params.filesRemaining]
  
  try {
    // Extract zip using fflate
    const unzipped = unzipSync(params.file)
    
    // Detect directory structure (similar to original logic)
    let gotDirectoryWithAppName = null
    for (const fileName of Object.keys(unzipped)) {
      
        // This is for case of compressing a zip file which includes a root folder with the app names
        if (!gotDirectoryWithAppName && startsWith(fileName, params.appFS.appName) && fileName.indexOf('/') > 1) {
          gotDirectoryWithAppName = fileName.slice(0, fileName.indexOf('/') + 1)
        }
        if (!gotDirectoryWithAppName && fileName === params.name + '/') { 
          gotDirectoryWithAppName = params.name + '/' 
        }
      }
    

    // Find the next file to extract
    let foundFileName = null
    let fileListIndex = -1

    for (let i = fileList.length - 1; i >= 0; i--) {
      const fileName = fileList[i]
      if (unzipped.hasOwnProperty(fileName)) {
        foundFileName = fileName
        fileListIndex = i
        fileList.splice(fileListIndex, 1)
        break
      }
    }

    let dowrite = true
    if (!foundFileName) dowrite = false

    if (foundFileName && endsWith(foundFileName, '/')) {
      dowrite = false
    } else if (foundFileName) {
      const parts = foundFileName.split('/')
      if (startsWith(parts[parts.length - 1], '.')) {
        dowrite = false
      }
    }
    
    // Store the original filename for content lookup (before any modifications)
    const originalFileName = foundFileName
    
    if (dowrite) {
      if (gotDirectoryWithAppName && startsWith(foundFileName, gotDirectoryWithAppName)) {
        foundFileName = foundFileName.substring(gotDirectoryWithAppName.length)
      } else if (gotDirectoryWithAppName) {
        dowrite = false
      } // else { fileName = fileName; }
    }

    if (dowrite) {
      const content = unzipped[originalFileName]
      
      // Validate content before writing
      if (content === undefined) {
        console.error('extractNextFile: Content is undefined for file:', originalFileName)
        callback(new Error(`Content is undefined for file: ${originalFileName}`), params.filesRemaining)
        return
      }
      
      // Write to cloud storage using appFS.async
      try {
        if (params.appFS.writeToAppFiles) {
          await params.appFS.writeToAppFiles(foundFileName, content, { doNotOverWrite: false })
          callback(null, fileList)
        } else {
          // Fallback for system apps or when writeToAppFiles is not available
          throw new Error(`writeToAppFiles not available - debug: ${foundFileName}`)
          callback(null, fileList)
        }
      } catch (err) {
        console.error('extractNextFile: Error writing file ' + foundFileName + ' to cloud', err)
        callback(err, params.filesRemaining)
      }
    } else {
      callback(null, fileList)
    }
  } catch (e) {
    console.error('extractNextFile error:', e)
    callback(new Error('extractNextFile: error extracting from zip file ' + JSON.stringify(e)), fileList)
  }
}

// Check manifest for validity and return warnings
const checkManifest = (manifest, appName, appVersion) => {
  const warnings = []
  
  if (!manifest) {
    warnings.push({
      code: 'manifest_missing',
      message: 'App does not have a configuration file (manifest)',
      severity: 'warning'
    })
    return { warnings }
  }

  // Check app name consistency
  if (manifest.identifier && manifest.identifier !== appName) {
    warnings.push({
      code: 'config_inconsistent_app_name',
      message: `The configuration file for this app states a different app name from the name of the file uploaded. The file name was used. The other name '${manifest.identifier}' was discarded.`,
      severity: 'warning',
      expectedName: manifest.identifier,
      actualName: appName
    })
  }

  // Check version consistency
  if (manifest.version && manifest.version !== appVersion) {
    warnings.push({
      code: 'config_inconsistent_version',
      message: `The configuration file for this app states a different app version from the one on the name of the file uploaded. The version on the file name was used. The other version number was ignored.`,
      severity: 'warning',
      expectedVersion: manifest.version,
      actualVersion: appVersion
    })
  }

  // Check for required fields
  if (!manifest.display_name) {
    warnings.push({
      code: 'manifest_missing_display_name',
      message: 'App manifest is missing display_name field',
      severity: 'warning'
    })
  }

  // Check for illegal app names
  if (manifest.identifier && (isSystemApp(manifest.identifier) || !validAppName(manifest.identifier))) {
    warnings.push({
      code: 'manifest_illegal_app_name',
      message: `App name '${manifest.identifier}' is not allowed`,
      severity: 'error',
      appName: manifest.identifier
    })
  }

  // Check for illegal file references
  if (manifest.app_tables) {
    Object.keys(manifest.app_tables).forEach(tableName => {
      if (tableName.includes('..') || tableName.includes('/') || tableName.includes('\\')) {
        warnings.push({
          code: 'manifest_illegal_table_name',
          message: `Table name '${tableName}' contains illegal characters`,
          severity: 'error',
          tableName: tableName
        })
      }
    })
  }

  return { warnings }
}

// ES6 Module Exports
export {
  deleteLocalFolderAndContents,
  extractZipToLocalFolder,
  getLocalManifest,
  extractZipAndReplaceToCloudFolder,
  extractZipToCloudFolder,
  removeCloudAppFolder,
  appFileListFromZip,
  extractNextFile,
  checkManifest,
  ensureDirectoryExists,
  sep,
  removeStartAndEndSlashes,
  systemPath,
  fullLocalPathTo
}

// Default export for convenience
export default {
  deleteLocalFolderAndContents,
  extractZipToLocalFolder,
  getLocalManifest,
  getLocalFile,
  extractZipAndReplaceToCloudFolder,
  extractZipToCloudFolder,
  removeCloudAppFolder,
  appFileListFromZip,
  extractNextFile,
  checkManifest,
  ensureDirectoryExists,
  sep,
  removeStartAndEndSlashes,
  systemPath,
  fullLocalPathTo
} 