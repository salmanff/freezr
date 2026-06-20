import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { zipSync } from 'fflate'
import { sendApiSuccess, sendFailure } from '../../../adapters/http/responses.mjs'
import { userAppListOAC, userPERMS_OAC, constructAppIdStringFrom, isSystemApp, validAppName } from '../../../common/helpers/config.mjs'
import { listAllUserApps } from '../../account/services/accountQueryService.mjs'
import { deleteApp } from '../../account/services/appMgmtService.mjs'

import { fileURLToPath } from 'url'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const buildFolderTree = async (dirPath, relativeTo) => {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
  const tree = []
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    const relPath = path.relative(relativeTo, fullPath)
    if (entry.isDirectory()) {
      tree.push({ name: entry.name, path: relPath, type: 'folder', children: await buildFolderTree(fullPath, relativeTo) })
    } else {
      tree.push({ name: entry.name, path: relPath, type: 'file' })
    }
  }
  tree.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return tree
}

const collectFilePaths = (tree, out = []) => {
  for (const node of tree) {
    if (node.type === 'file') out.push(node.path)
    else if (node.children) collectFilePaths(node.children, out)
  }
  return out
}

const TEXT_EXTENSIONS = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'md', 'txt', 'svg', 'xml', 'csv', 'yaml', 'yml'])
const isTextFile = (filePath) => {
  const ext = filePath.split('.').pop().toLowerCase()
  return TEXT_EXTENSIONS.has(ext)
}

const FREEZR_API_PATH = path.resolve(__dirname, '../../../freezrsystmapps/info.freezr.public/public/freezrApiV2.js')

// freezr-context.md is shipped into every app folder so that opening the folder
// in an external editor (VS Code / Claude Code / etc.) carries the context of how
// freezr works, and so a published app's source is self-documenting. The copy is
// stamped with a hash of the source on the first line so we can tell when the
// freezr-shipped source has changed and the copy needs refreshing.
const FREEZR_CONTEXT_PATH = path.resolve(__dirname, '../../../freezrsystmapps/info.freezr.public/public/freezr-context.md')
const CONTEXT_DOC_NAME = 'freezr-context.md'

const sha256 = (str) => crypto.createHash('sha256').update(str, 'utf-8').digest('hex')

const buildContextDoc = (sourceContent, hash) => {
  const date = new Date().toISOString().slice(0, 10)
  const header = `<!-- freezr-context source-sha=${hash} generated=${date} — auto-managed by freezr creator, do not edit this line -->`
  return header + '\n' + sourceContent
}

const parseContextHash = (copyContent) => {
  if (!copyContent) return null
  const firstLine = copyContent.slice(0, copyContent.indexOf('\n') >= 0 ? copyContent.indexOf('\n') : copyContent.length)
  const m = firstLine.match(/source-sha=([0-9a-f]+)/)
  return m ? m[1] : null
}

// Ensures the app folder has an up-to-date copy of freezr-context.md.
// Returns { action: 'created'|'updated'|'uptodate'|'skipped', content?, hash? }.
const ensureContextDoc = async (appFS) => {
  if (!appFS || !appFS.writeToAppFiles) return { action: 'skipped', reason: 'no-appfs' }

  let sourceContent
  try {
    sourceContent = await fs.promises.readFile(FREEZR_CONTEXT_PATH, 'utf-8')
  } catch (err) {
    console.warn('ensureContextDoc: could not read source context:', err.message)
    return { action: 'skipped', reason: 'no-source' }
  }
  const hash = sha256(sourceContent)

  let copyContent = null
  try {
    copyContent = await appFS.readAppFile(CONTEXT_DOC_NAME)
  } catch (err) { /* missing copy is expected on create */ }

  const doc = buildContextDoc(sourceContent, hash)

  if (copyContent === null || copyContent === undefined) {
    await appFS.writeToAppFiles(CONTEXT_DOC_NAME, doc, { doNotOverWrite: false })
    return { action: 'created', content: doc, hash }
  }

  if (parseContextHash(copyContent) === hash) {
    return { action: 'uptodate', hash }
  }

  await appFS.writeToAppFiles(CONTEXT_DOC_NAME, doc, { doNotOverWrite: false })
  return { action: 'updated', content: doc, hash }
}

const BLANK_INDEX_HTML = `<div id="app">
  <h1>Hello App Creator!</h1>
  <p>Welcome to your new app - ask the chat agent what you want in your app.</p>
</div>
`

const BLANK_INDEX_CSS = `#app {
  font-family: sans-serif;
  max-width: 600px;
  margin: 40px auto;
  padding: 20px;
}
`

const BLANK_INDEX_JS = `console.log('App loaded.')
`

export const createCreatorApiController = () => {
  const createBlankApp = async (req, res) => {
    try {
      const appName = req.body?.app_name
      if (!appName || appName.length < 1) {
        return sendFailure(res, 'App name is required.', 'creatorApiController.createBlankApp', 400)
      }

      const userId = req.session?.logged_in_user_id
      if (!userId) {
        return sendFailure(res, 'User not logged in.', 'creatorApiController.createBlankApp', 401)
      }

      if (isSystemApp(appName) || !validAppName(appName)) {
        return sendFailure(res, 'App name not allowed: ' + appName, 'creatorApiController.createBlankApp', 400)
      }

      const userDS = res.locals?.freezr?.userDS
      if (!userDS) {
        return sendFailure(res, 'User data store not available.', 'creatorApiController.createBlankApp', 500)
      }

      const freezrPrefs = res.locals?.freezr?.freezrPrefs

      const userAppListDb = await userDS.getorInitDb(userAppListOAC(userId), { freezrPrefs })
      if (!userAppListDb) {
        return sendFailure(res, 'Could not access app list database.', 'creatorApiController.createBlankApp', 500)
      }

      const appNameId = constructAppIdStringFrom(userId, appName)
      const existingEntity = await userAppListDb.read_by_id(appNameId)
      if (existingEntity) {
        return sendFailure(res, 'App already exists: ' + appName, 'creatorApiController.createBlankApp', 400)
      }

      const manifest = { identifier: appName, version: '0.01', pages: { index: { html_file: 'index.html', css_files: 'index.css', script_files: 'index.js', 'page_title': 'Welcome to ' + appName } } }

      const appEntity = {
        app_name: appName,
        app_display_name: appName,
        manifest,
        warnings: [],
        installed: new Date().toISOString(),
        removed: false
      }

      await userAppListDb.create(appNameId, appEntity, null)

      const appFS = await userDS.getorInitAppFS(appName, {})
      if (!appFS || !appFS.writeToAppFiles) {
        return sendFailure(res, 'Could not initialise app filesystem.', 'creatorApiController.createBlankApp', 500)
      }

      const manifestJson = JSON.stringify(manifest, null, 2)
      await appFS.writeToAppFiles('manifest.json', manifestJson, { doNotOverWrite: false })
      await appFS.writeToAppFiles('index.html', BLANK_INDEX_HTML, { doNotOverWrite: false })
      await appFS.writeToAppFiles('index.css', BLANK_INDEX_CSS, { doNotOverWrite: false })
      await appFS.writeToAppFiles('index.js', BLANK_INDEX_JS, { doNotOverWrite: false })

      try {
        await ensureContextDoc(appFS)
      } catch (err) {
        console.warn('createBlankApp: could not write context doc:', err.message)
      }

      return sendApiSuccess(res, {
        success: true,
        app_name: appName,
        manifest
      })
    } catch (error) {
      console.error('creatorApiController.createBlankApp error:', error)
      return sendFailure(res, error, 'creatorApiController.createBlankApp', 500)
    }
  }

  const getUserApps = async (req, res) => {
    try {
      const userDS = res.locals?.freezr?.userDS
      if (!userDS) {
        return sendFailure(res, 'User data store not available.', 'creatorApiController.getUserApps', 500)
      }

      const { user_apps, removed_apps, error } = await listAllUserApps(userDS, { includeManifest: true })
      if (error) {
        return sendFailure(res, error, 'creatorApiController.getUserApps', 500)
      }

      const apps = (user_apps || [])
        .filter((app) => !isSystemApp(app.app_name))

      return sendApiSuccess(res, { success: true, apps, app_names: apps.map((app) => app.app_name) })
    } catch (error) {
      console.error('creatorApiController.getUserApps error:', error)
      return sendFailure(res, error, 'creatorApiController.getUserApps', 500)
    }
  }

  const readFolder = async (req, res) => {
    try {
      const appName = req.query?.app_name || req.body?.app_name
      if (!appName) {
        return sendFailure(res, 'app_name is required.', 'creatorApiController.readFolder', 400)
      }

      const userId = req.session?.logged_in_user_id
      if (!userId) {
        return sendFailure(res, 'User not logged in.', 'creatorApiController.readFolder', 401)
      }

      const userDS = res.locals?.freezr?.userDS
      if (!userDS) {
        return sendFailure(res, 'User data store not available.', 'creatorApiController.readFolder', 500)
      }

      const appFS = await userDS.getorInitAppFS(appName, {})
      if (!appFS || !appFS.pathToFile) {
        return sendFailure(res, 'Could not access app filesystem.', 'creatorApiController.readFolder', 500)
      }

      const rootRelPath = appFS.pathToFile('')
      const rootAbsPath = path.resolve(rootRelPath)

      if (!fs.existsSync(rootAbsPath)) {
        return sendApiSuccess(res, { success: true, tree: [] })
      }

      const tree = await buildFolderTree(rootAbsPath, rootAbsPath)
      return sendApiSuccess(res, { success: true, tree })
    } catch (error) {
      console.error('creatorApiController.readFolder error:', error)
      return sendFailure(res, error, 'creatorApiController.readFolder', 500)
    }
  }

  const readAppFile = async (req, res) => {
    try {
      const appName = req.query?.app_name
      const filePath = req.query?.file_path
      if (!appName || !filePath) {
        return sendFailure(res, 'app_name and file_path are required.', 'creatorApiController.readAppFile', 400)
      }

      if (filePath.includes('..')) {
        return sendFailure(res, 'Invalid file path.', 'creatorApiController.readAppFile', 400)
      }

      const userDS = res.locals?.freezr?.userDS
      if (!userDS) {
        return sendFailure(res, 'User data store not available.', 'creatorApiController.readAppFile', 500)
      }

      const appFS = await userDS.getorInitAppFS(appName, {})
      if (!appFS || !appFS.readAppFile) {
        return sendFailure(res, 'Could not access app filesystem.', 'creatorApiController.readAppFile', 500)
      }

      const content = await appFS.readAppFile(filePath)
      return sendApiSuccess(res, { success: true, file_path: filePath, content })
    } catch (error) {
      console.error('creatorApiController.readAppFile error:', error)
      return sendFailure(res, error, 'creatorApiController.readAppFile', 500)
    }
  }

  const readAllFiles = async (req, res) => {
    try {
      const appName = req.query?.app_name
      if (!appName) {
        return sendFailure(res, 'app_name is required.', 'creatorApiController.readAllFiles', 400)
      }

      const userDS = res.locals?.freezr?.userDS
      if (!userDS) {
        return sendFailure(res, 'User data store not available.', 'creatorApiController.readAllFiles', 500)
      }

      const appFS = await userDS.getorInitAppFS(appName, {})
      if (!appFS || !appFS.pathToFile || !appFS.readAppFile) {
        return sendFailure(res, 'Could not access app filesystem.', 'creatorApiController.readAllFiles', 500)
      }

      const rootRelPath = appFS.pathToFile('')
      const rootAbsPath = path.resolve(rootRelPath)
      const files = []

      if (fs.existsSync(rootAbsPath)) {
        const tree = await buildFolderTree(rootAbsPath, rootAbsPath)
        const filePaths = collectFilePaths(tree)

        for (const filePath of filePaths) {
          if (!isTextFile(filePath)) continue
          try {
            const content = await appFS.readAppFile(filePath)
            files.push({ path: filePath, content })
          } catch (err) {
            files.push({ path: filePath, content: null, error: err.message })
          }
        }
      }

      let freezrApiContent = null
      try {
        freezrApiContent = await fs.promises.readFile(FREEZR_API_PATH, 'utf-8')
      } catch (err) {
        console.warn('Could not read freezrApiV2.js:', err.message)
      }
      if (freezrApiContent) {
        files.push({ path: '__freezrApiV2.js', content: freezrApiContent, readOnly: true })
      }

      return sendApiSuccess(res, { success: true, files })
    } catch (error) {
      console.error('creatorApiController.readAllFiles error:', error)
      return sendFailure(res, error, 'creatorApiController.readAllFiles', 500)
    }
  }

  const writeAppFile = async (req, res) => {
    try {
      const appName = req.body?.app_name
      const filePath = req.body?.file_path
      const content = req.body?.content
      const action = req.body?.action || 'upsert'

      if (!appName || !filePath) {
        return sendFailure(res, 'app_name and file_path are required.', 'creatorApiController.writeAppFile', 400)
      }
      if (filePath.includes('..')) {
        return sendFailure(res, 'Invalid file path.', 'creatorApiController.writeAppFile', 400)
      }

      const userDS = res.locals?.freezr?.userDS
      if (!userDS) {
        return sendFailure(res, 'User data store not available.', 'creatorApiController.writeAppFile', 500)
      }

      const appFS = await userDS.getorInitAppFS(appName, {})
      if (!appFS) {
        return sendFailure(res, 'Could not access app filesystem.', 'creatorApiController.writeAppFile', 500)
      }

      if (action === 'delete') {
        const absPath = path.resolve(appFS.pathToFile(filePath))
        if (fs.existsSync(absPath)) {
          await fs.promises.unlink(absPath)
        }
        return sendApiSuccess(res, { success: true, file_path: filePath, action: 'deleted' })
      }

      if (action === 'delete_folder') {
        const absPath = path.resolve(appFS.pathToFile(filePath))
        const rootAbs = path.resolve(appFS.pathToFile(''))
        if (absPath === rootAbs || !absPath.startsWith(rootAbs + path.sep)) {
          return sendFailure(res, 'Cannot delete root or paths outside app.', 'creatorApiController.writeAppFile', 400)
        }
        if (fs.existsSync(absPath)) {
          const stat = await fs.promises.stat(absPath)
          if (!stat.isDirectory()) {
            return sendFailure(res, 'Path is not a folder.', 'creatorApiController.writeAppFile', 400)
          }
          await fs.promises.rm(absPath, { recursive: true, force: true })
        }
        return sendApiSuccess(res, { success: true, file_path: filePath, action: 'folder_deleted' })
      }

      if (!appFS.writeToAppFiles) {
        return sendFailure(res, 'Write not supported.', 'creatorApiController.writeAppFile', 500)
      }

      await appFS.writeToAppFiles(filePath, content || '', { doNotOverWrite: false })
      return sendApiSuccess(res, { success: true, file_path: filePath, action: 'written' })
    } catch (error) {
      console.error('creatorApiController.writeAppFile error:', error)
      return sendFailure(res, error, 'creatorApiController.writeAppFile', 500)
    }
  }

  const syncContext = async (req, res) => {
    try {
      const appName = req.query?.app_name || req.body?.app_name
      if (!appName) {
        return sendFailure(res, 'app_name is required.', 'creatorApiController.syncContext', 400)
      }

      const userDS = res.locals?.freezr?.userDS
      if (!userDS) {
        return sendFailure(res, 'User data store not available.', 'creatorApiController.syncContext', 500)
      }

      const appFS = await userDS.getorInitAppFS(appName, {})
      if (!appFS) {
        return sendFailure(res, 'Could not access app filesystem.', 'creatorApiController.syncContext', 500)
      }

      const result = await ensureContextDoc(appFS)
      return sendApiSuccess(res, { success: true, ...result })
    } catch (error) {
      console.error('creatorApiController.syncContext error:', error)
      return sendFailure(res, error, 'creatorApiController.syncContext', 500)
    }
  }

  const uploadAppFile = async (req, res) => {
    try {
      const appName = req.body?.app_name
      const filePath = req.body?.file_path
      const file = req.file

      if (!appName || !filePath) {
        return sendFailure(res, 'app_name and file_path are required.', 'creatorApiController.uploadAppFile', 400)
      }
      if (filePath.includes('..')) {
        return sendFailure(res, 'Invalid file path.', 'creatorApiController.uploadAppFile', 400)
      }
      if (!file || !file.buffer) {
        return sendFailure(res, 'No file provided.', 'creatorApiController.uploadAppFile', 400)
      }

      const userDS = res.locals?.freezr?.userDS
      if (!userDS) {
        return sendFailure(res, 'User data store not available.', 'creatorApiController.uploadAppFile', 500)
      }

      const appFS = await userDS.getorInitAppFS(appName, {})
      if (!appFS || !appFS.writeToAppFiles) {
        return sendFailure(res, 'Could not access app filesystem.', 'creatorApiController.uploadAppFile', 500)
      }

      const destDir = path.dirname(filePath)
      if (destDir && destDir !== '.') {
        const dirAbsPath = path.resolve(appFS.pathToFile(destDir))
        await fs.promises.mkdir(dirAbsPath, { recursive: true })
      }

      await appFS.writeToAppFiles(filePath, file.buffer, { doNotOverWrite: false })
      return sendApiSuccess(res, { success: true, file_path: filePath, action: 'uploaded', originalName: file.originalname })
    } catch (error) {
      console.error('creatorApiController.uploadAppFile error:', error)
      return sendFailure(res, error, 'creatorApiController.uploadAppFile', 500)
    }
  }

  const renameApp = async (req, res) => {
    const FUNC = 'creatorApiController.renameApp'
    try {
      const oldAppName = req.body?.old_app_name
      const newAppName = req.body?.new_app_name
      const deleteData = req.body?.delete_data === true
      const confirmed = req.body?.confirmed === true

      if (!oldAppName || !newAppName) {
        return sendFailure(res, 'old_app_name and new_app_name are required.', FUNC, 400)
      }

      const userId = req.session?.logged_in_user_id
      if (!userId) {
        return sendFailure(res, 'User not logged in.', FUNC, 401)
      }

      if (isSystemApp(oldAppName)) {
        return sendFailure(res, 'Cannot rename a system app.', FUNC, 403)
      }
      if (isSystemApp(newAppName) || !validAppName(newAppName)) {
        return sendFailure(res, 'New app name is not valid: ' + newAppName, FUNC, 400)
      }
      if (oldAppName === newAppName) {
        return sendFailure(res, 'New name is the same as the old name.', FUNC, 400)
      }

      const userDS = res.locals?.freezr?.userDS
      const freezrPrefs = res.locals?.freezr?.freezrPrefs

      if (!userDS) return sendFailure(res, 'User data store not available.', FUNC, 500)

      const userAppListDb = await userDS.getorInitDb(userAppListOAC(userId), { freezrPrefs })
      if (!userAppListDb) return sendFailure(res, 'Could not access app list database.', FUNC, 500)

      const oldAppId = constructAppIdStringFrom(userId, oldAppName)
      const oldAppEntity = await userAppListDb.read_by_id(oldAppId)
      if (!oldAppEntity) {
        return sendFailure(res, 'App not found: ' + oldAppName, FUNC, 404)
      }

      const newAppId = constructAppIdStringFrom(userId, newAppName)
      const existingNew = await userAppListDb.read_by_id(newAppId)
      if (existingNew) {
        return sendFailure(res, 'An app with the new name already exists: ' + newAppName, FUNC, 400)
      }

      // Check for granted permissions and warn (pre-confirmation phase)
      const permsOac = userPERMS_OAC(userId)
      const permsDb = await userDS.getorInitDb(permsOac, { freezrPrefs })
      let grantedPerms = []
      if (permsDb) {
        try {
          const allPerms = await permsDb.query({ requestor_app: oldAppName }, {})
          grantedPerms = (allPerms || []).filter(p => p.granted)
        } catch (e) { /* no perms is ok */ }
      }

      if (!confirmed) {
        return sendApiSuccess(res, {
          needs_confirmation: true,
          old_app_name: oldAppName,
          new_app_name: newAppName,
          granted_permissions: grantedPerms.map(p => ({ name: p.name, type: p.type })),
          has_granted_permissions: grantedPerms.length > 0
        })
      }

      // --- Confirmed: proceed with rename ---

      // Phase 1: Mark migration in progress on old app
      try {
        await userAppListDb.update(oldAppId, { migration_in_progress: 'renaming_to:' + newAppName }, { replaceAllFields: false })
      } catch (e) {
        return sendFailure(res, 'Could not mark old app as migrating.', FUNC, 500)
      }

      // Phase 2: Copy app files to new folder
      const oldAppFS = await userDS.getorInitAppFS(oldAppName, {})
      if (!oldAppFS || !oldAppFS.pathToFile) {
        return sendFailure(res, 'Could not access old app filesystem.', FUNC, 500)
      }

      const newAppFS = await userDS.getorInitAppFS(newAppName, {})
      if (!newAppFS || !newAppFS.writeToAppFiles) {
        return sendFailure(res, 'Could not initialise new app filesystem.', FUNC, 500)
      }

      const oldRootRel = oldAppFS.pathToFile('')
      const oldRootAbs = path.resolve(oldRootRel)
      if (fs.existsSync(oldRootAbs)) {
        const tree = await buildFolderTree(oldRootAbs, oldRootAbs)
        const filePaths = collectFilePaths(tree)
        for (const filePath of filePaths) {
          try {
            const absFilePath = path.join(oldRootAbs, filePath)
            const content = await fs.promises.readFile(absFilePath)
            const destDir = path.dirname(filePath)
            if (destDir && destDir !== '.') {
              const dirAbsPath = path.resolve(newAppFS.pathToFile(destDir))
              await fs.promises.mkdir(dirAbsPath, { recursive: true })
            }
            await newAppFS.writeToAppFiles(filePath, content, { doNotOverWrite: false })
          } catch (err) {
            console.warn('Could not copy file ' + filePath + ':', err.message)
          }
        }
      }

      // Phase 3: Update manifest.json identifier in new app
      try {
        const manifestContent = await newAppFS.readAppFile('manifest.json')
        const manifest = JSON.parse(manifestContent)
        manifest.identifier = newAppName
        await newAppFS.writeToAppFiles('manifest.json', JSON.stringify(manifest, null, 2), { doNotOverWrite: false })
      } catch (e) {
        console.warn('Could not update manifest identifier:', e.message)
      }

      // Phase 3b: Check for logo in copied files
      let hasLogo = oldAppEntity.hasLogo || false
      try {
        const newRootRel = newAppFS.pathToFile('')
        const logoPath = path.join(path.resolve(newRootRel), 'static', 'logo.png')
        await fs.promises.access(logoPath)
        hasLogo = true
      } catch (e) {
        // no logo file present
      }

      // Phase 4: Create new app list entry
      const newManifest = oldAppEntity.manifest ? JSON.parse(JSON.stringify(oldAppEntity.manifest)) : {}
      newManifest.identifier = newAppName
      if (!newManifest.display_name || newManifest.display_name === oldAppName) {
        newManifest.display_name = newAppName
      }
      const oldDisplayName = oldAppEntity.app_display_name
      const newDisplayName = (!oldDisplayName || oldDisplayName === oldAppName) ? newAppName : oldDisplayName
      const newAppEntity = {
        app_name: newAppName,
        app_display_name: newDisplayName,
        manifest: newManifest,
        warnings: oldAppEntity.warnings || [],
        hasLogo,
        installed: new Date().toISOString(),
        removed: false,
        migration_in_progress: 'renamed_from:' + oldAppName
      }
      await userAppListDb.create(newAppId, newAppEntity, null)

      // Phase 5: Migrate creator records (fileUpdates and appUpdates)
      const creatorOac = { owner: userId, app_name: 'info.freezr.creator' }
      let migratedFileUpdates = 0
      let migratedAppUpdates = 0

      try {
        const fileUpdatesDb = await userDS.getorInitDb({ ...creatorOac, collection_name: 'fileUpdates' }, { freezrPrefs })
        if (fileUpdatesDb) {
          const allFileUpdates = await fileUpdatesDb.query({ appName: oldAppName }, {})
          if (allFileUpdates && allFileUpdates.length > 0) {
            allFileUpdates.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''))
            for (const record of allFileUpdates) {
              if (record._id) {
                await fileUpdatesDb.update(record._id, { appName: newAppName }, { replaceAllFields: false })
                migratedFileUpdates++
              }
            }
          }
        }
      } catch (e) {
        console.warn('Error migrating fileUpdates:', e.message)
      }

      try {
        const appUpdatesDb = await userDS.getorInitDb({ ...creatorOac, collection_name: 'appUpdates' }, { freezrPrefs })
        if (appUpdatesDb) {
          const allAppUpdates = await appUpdatesDb.query({ appName: oldAppName }, {})
          if (allAppUpdates && allAppUpdates.length > 0) {
            allAppUpdates.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''))
            for (const record of allAppUpdates) {
              if (record._id) {
                await appUpdatesDb.update(record._id, { appName: newAppName }, { replaceAllFields: false })
                migratedAppUpdates++
              }
            }
          }
        }
      } catch (e) {
        console.warn('Error migrating appUpdates:', e.message)
      }

      // Phase 6: Add rename history entry under new app name
      try {
        const appUpdatesDb = await userDS.getorInitDb({ ...creatorOac, collection_name: 'appUpdates' }, { freezrPrefs })
        if (appUpdatesDb) {
          await appUpdatesDb.create(null, {
            appName: newAppName,
            action: 'renamed',
            previousAppName: oldAppName,
            timestamp: new Date().toISOString()
          }, {})
        }
      } catch (e) {
        console.warn('Could not record rename history entry:', e.message)
      }

      // Phase 7: Delete old app (permissions, public manifests/records, files, data, app list entry)
      try {
        await deleteApp({ userDS, userId, appName: oldAppName, freezrPrefs, doNotDeletePublics: true })
      } catch (e) {
        console.error('Error deleting old app during rename:', e)
        // Old app deletion failed but new app exists - clear migration flag on new, warn user
        try {
          await userAppListDb.update(newAppId, { migration_in_progress: null }, { replaceAllFields: false })
        } catch (_) { /* best effort */ }
        return sendApiSuccess(res, {
          success: true,
          warning: 'Rename completed but old app could not be fully removed. Please delete it manually from account settings.',
          new_app_name: newAppName,
          old_app_name: oldAppName,
          migrated_file_updates: migratedFileUpdates,
          migrated_app_updates: migratedAppUpdates
        })
      }

      // Phase 8: Clear migration flag on new app
      try {
        await userAppListDb.update(newAppId, { migration_in_progress: null }, { replaceAllFields: false })
      } catch (e) {
        console.warn('Could not clear migration flag on new app:', e.message)
      }

      return sendApiSuccess(res, {
        success: true,
        new_app_name: newAppName,
        old_app_name: oldAppName,
        migrated_file_updates: migratedFileUpdates,
        migrated_app_updates: migratedAppUpdates,
        data_deleted: deleteData,
        granted_permissions_removed: grantedPerms.length
      })
    } catch (error) {
      console.error(FUNC + ' error:', error)
      return sendFailure(res, error, FUNC, 500)
    }
  }

  const compareVersions = (a, b) => {
    const pa = String(a).split('.').map(Number)
    const pb = String(b).split('.').map(Number)
    const len = Math.max(pa.length, pb.length)
    for (let i = 0; i < len; i++) {
      const na = pa[i] || 0
      const nb = pb[i] || 0
      if (na !== nb) return na - nb
    }
    return 0
  }

  const collectAllFileBuffers = async (dirPath, relativeTo) => {
    const result = {}
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      const relPath = path.relative(relativeTo, fullPath).replace(/\\/g, '/')
      if (entry.isDirectory()) {
        const sub = await collectAllFileBuffers(fullPath, relativeTo)
        Object.assign(result, sub)
      } else {
        result[relPath] = new Uint8Array(await fs.promises.readFile(fullPath))
      }
    }
    return result
  }

  const publishApp = async (req, res) => {
    const FUNC = 'creatorApiController.publishApp'
    try {
      const appName = req.body?.app_name
      const requestedVersion = req.body?.version
      const releaseNotes = (req.body?.release_notes || '').trim()

      // onsole.log('publishApp received body keys:', Object.keys(req.body || {}), 'release_notes:', JSON.stringify(req.body?.release_notes), 'trimmed:', JSON.stringify(releaseNotes))

      if (!appName) return sendFailure(res, 'app_name is required.', FUNC, 400)

      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'User not logged in.', FUNC, 401)

      const userDS = res.locals?.freezr?.userDS
      const freezrPrefs = res.locals?.freezr?.freezrPrefs
      if (!userDS) return sendFailure(res, 'User data store not available.', FUNC, 500)

      // 1. Read manifest - display_name and description always come from manifest
      const appFS = await userDS.getorInitAppFS(appName, {})
      if (!appFS || !appFS.readAppFile) return sendFailure(res, 'Could not access app filesystem.', FUNC, 500)

      let manifest
      try {
        const rawManifest = await appFS.readAppFile('manifest.json')
        manifest = JSON.parse(rawManifest)
      } catch (e) {
        return sendFailure(res, 'Could not read or parse manifest.json: ' + e.message, FUNC, 500)
      }

      const version = requestedVersion || manifest.version || '0.01'
      const appDisplayName = manifest.display_name || appName
      const appDescription = manifest.description || ''

      // 2. Check published versions and validate version is higher
      const creatorOac = { owner: userId, app_name: 'info.freezr.creator' }
      const creatorFilesDb = await userDS.getorInitDb({ ...creatorOac, collection_name: 'files' }, { freezrPrefs })

      let previousVersions = []
      if (creatorFilesDb) {
        try {
          const existing = await creatorFilesDb.query({ publishedAppName: appName }, {})
          previousVersions = (existing || []).sort((a, b) => compareVersions(b.version, a.version))
        } catch (e) { /* first publish */ }
      }

      if (previousVersions.length > 0) {
        const latestVersion = previousVersions[0].version
        if (compareVersions(version, latestVersion) <= 0) {
          return sendFailure(res, `Version ${version} must be higher than the last published version ${latestVersion}. Please increment the version.`, FUNC, 400)
        }
      }

      // 3. Zip the app folder
      const rootRelPath = appFS.pathToFile('')
      const rootAbsPath = path.resolve(rootRelPath)
      if (!fs.existsSync(rootAbsPath)) return sendFailure(res, 'App folder does not exist.', FUNC, 404)

      const fileBuffers = await collectAllFileBuffers(rootAbsPath, rootAbsPath)
      const zipped = zipSync(fileBuffers, { level: 6 })
      const zipBuffer = Buffer.from(zipped)

      // 4. Write zip to user files for info.freezr.creator
      const now = new Date()
      const dateStr = now.toISOString().slice(0, 10)
      const zipFileName = `${appName} v${version} ${dateStr}.zip`

      const creatorAppFS = await userDS.getorInitAppFS('info.freezr.creator', {})
      if (!creatorAppFS || !creatorAppFS.writeToUserFiles) {
        return sendFailure(res, 'Could not access creator user files.', FUNC, 500)
      }
      await creatorAppFS.writeToUserFiles(zipFileName, zipBuffer, { doNotOverWrite: false })

      // 5. Create DB entry in info.freezr.creator.files
      const fileRecordId = zipFileName
      const fileRecord = {
        publishedAppName: appName,
        version,
        display_name: appDisplayName,
        description: appDescription,
        release_notes: releaseNotes,
        fileName: zipFileName,
        timestamp: now.toISOString(),
        isPublished: true,
        _UploadStatus: 'complete'
      }

      if (creatorFilesDb) {
        try {
          const existingRecord = await creatorFilesDb.read_by_id(fileRecordId)
          if (existingRecord) {
            console.log('existingRecord for new file - SNBH!!! TODO Add to Flogger!', fileRecordId)
            await creatorFilesDb.update(fileRecordId, fileRecord, { replaceAllFields: false })
          } else {
            await creatorFilesDb.create(fileRecordId, fileRecord, {})
          }
        } catch (e) {
          await creatorFilesDb.create(fileRecordId, fileRecord, {})
        }
      }

      // 6. Manage public records (versioning)
      const publicRecordsDb = res.locals?.freezr?.publicRecordsDb
      if (!publicRecordsDb) return sendFailure(res, 'Could not access public records database.', FUNC, 500)

      const mainPublicId = '@' + userId + '/app/' + appName
      const existingPublicRecord = await publicRecordsDb.read_by_id(mainPublicId)

      // If republishing, move old record to versioned URL
      if (existingPublicRecord && existingPublicRecord.data_owner === userId) {
        const oldVersion = existingPublicRecord.original_record?.version
        if (oldVersion) {
          const versionedPublicId = mainPublicId + '/v/' + oldVersion
          const existingVersioned = await publicRecordsDb.read_by_id(versionedPublicId)
          if (!existingVersioned) {
            const versionedRecord = { ...existingPublicRecord }
            delete versionedRecord._id
            delete versionedRecord._date_created
            delete versionedRecord._date_modified
            try {
              await publicRecordsDb.create(versionedPublicId, versionedRecord, {})
            } catch (e) {
              console.warn('Could not archive old version to ' + versionedPublicId + ':', e.message)
            }
          }
        }
      }

      // Create/update main public record
      const publicRecord = {
        data_owner: userId,
        original_app_table: 'info.freezr.creator.files',
        requestor_app: 'info.freezr.creator',
        permission_name: 'publish_app',
        original_record_id: zipFileName,
        original_record: {
          version,
          display_name: appDisplayName,
          description: appDescription,
          release_notes: releaseNotes,
          publishedAppName: appName,
          fileName: zipFileName,
          _id: fileRecordId
        },
        _date_published: now.getTime(),
        isPublic: true,
        search_words: [appName, appDisplayName, appDescription].filter(Boolean).join(' ')
      }

      try {
        if (existingPublicRecord) {
          await publicRecordsDb.update(mainPublicId, publicRecord, {})
        } else {
          await publicRecordsDb.create(mainPublicId, publicRecord, {})
        }
      } catch (e) {
        return sendFailure(res, 'Could not create public record: ' + e.message, FUNC, 500)
      }

      // 7. Publish logo if it exists - copy to user files as {appName}.logo.png
      let logoPublished = false
      let logoNote = null
      const logoPath = path.join(rootAbsPath, 'static', 'logo.png')
      try {
        await fs.promises.access(logoPath)
      } catch (e) {
        logoNote = 'No logo found at static/logo.png'
      }
      if (!logoNote) {
        try {
          const logoBuffer = await fs.promises.readFile(logoPath)

          const logoFileName = appName + '.logo.png'
          await creatorAppFS.writeToUserFiles(logoFileName, logoBuffer, { doNotOverWrite: false })

          const logoDbRecord = {
            publishedAppName: appName,
            isLogo: true,
            fileName: logoFileName,
            _UploadStatus: 'complete'
          }
          if (creatorFilesDb) {
            try {
              const existingLogo = await creatorFilesDb.read_by_id(logoFileName)
              if (existingLogo) {
                await creatorFilesDb.update(logoFileName, logoDbRecord, { replaceAllFields: false })
              } else {
                await creatorFilesDb.create(logoFileName, logoDbRecord, {})
              }
            } catch (e) {
              await creatorFilesDb.create(logoFileName, logoDbRecord, {})
            }
          }

          const logoPublicId = mainPublicId + '/logo'
          const logoPublicRecord = {
            data_owner: userId,
            original_app_table: 'info.freezr.creator.files',
            requestor_app: 'info.freezr.creator',
            permission_name: 'publish_app',
            original_record_id: logoFileName,
            original_record: { _id: logoFileName, publishedAppName: appName, isLogo: true },
            _date_published: now.getTime(),
            doNotList: true,
            isPublic: true
          }

          try {
            const existingLogoPublic = await publicRecordsDb.read_by_id(logoPublicId)
            if (existingLogoPublic) {
              await publicRecordsDb.update(logoPublicId, logoPublicRecord, {})
            } else {
              await publicRecordsDb.create(logoPublicId, logoPublicRecord, {})
            }
            logoPublished = true
          } catch (e) {
            logoNote = 'Logo file saved but could not create public record: ' + e.message
            console.warn('Could not publish logo:', e.message)
          }
        } catch (e) {
          logoNote = 'Error processing logo: ' + e.message
          console.warn('Error in logo publishing:', e.message)
        }
      }

      // 8. Create appUpdates entry
      const pcardUrl = '/publicapps/@' + userId + '/' + appName + '/pcard'
      const downloadUrl = '/' + mainPublicId
      try {
        const appUpdatesDb = await userDS.getorInitDb({ ...creatorOac, collection_name: 'appUpdates' }, { freezrPrefs })
        if (appUpdatesDb) {
          await appUpdatesDb.create(null, {
            appName,
            action: 'published',
            version,
            display_name: appDisplayName,
            description: appDescription,
            release_notes: releaseNotes,
            downloadUrl,
            fileName: zipFileName,
            timestamp: now.toISOString()
          }, {})
        }
      } catch (e) {
        console.warn('Could not record publish history entry:', e.message)
      }

      return sendApiSuccess(res, {
        success: true,
        version,
        downloadUrl,
        pcardUrl,
        fileName: zipFileName,
        logoPublished,
        logoNote: logoNote || undefined,
        previousVersionCount: previousVersions.length
      })
    } catch (error) {
      console.error(FUNC + ' error:', error)
      return sendFailure(res, error, FUNC, 500)
    }
  }

  const getPublishedVersions = async (req, res) => {
    const FUNC = 'creatorApiController.getPublishedVersions'
    try {
      const appName = req.query?.app_name
      if (!appName) return sendFailure(res, 'app_name is required.', FUNC, 400)

      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'User not logged in.', FUNC, 401)

      const userDS = res.locals?.freezr?.userDS
      const freezrPrefs = res.locals?.freezr?.freezrPrefs
      if (!userDS) return sendFailure(res, 'User data store not available.', FUNC, 500)

      const creatorOac = { owner: userId, app_name: 'info.freezr.creator' }
      const creatorFilesDb = await userDS.getorInitDb({ ...creatorOac, collection_name: 'files' }, { freezrPrefs })

      let versions = []
      if (creatorFilesDb) {
        try {
          const records = await creatorFilesDb.query({ publishedAppName: appName }, {})
          versions = (records || [])
            .filter(r => r.version && !r.isLogo)
            .sort((a, b) => compareVersions(b.version, a.version))
        } catch (e) { /* no versions yet */ }
      }

      const publicRecordsDb = res.locals?.freezr?.publicRecordsDb

      const mainPublicId = '@' + userId + '/app/' + appName
      let latestIsPublic = false
      let latestPublicVersion = null

      if (publicRecordsDb) {
        try {
          const mainRecord = await publicRecordsDb.read_by_id(mainPublicId)
          if (mainRecord) {
            latestIsPublic = true
            latestPublicVersion = mainRecord.original_record?.version
          }
        } catch (e) { /* not published */ }

        for (const v of versions) {
          if (v.version === latestPublicVersion) {
            v.isLatest = true
            v.isPublic = latestIsPublic
            v.publicId = mainPublicId
          } else {
            const versionedId = mainPublicId + '/v/' + v.version
            try {
              const vRecord = await publicRecordsDb.read_by_id(versionedId)
              v.isPublic = !!vRecord
              v.publicId = vRecord ? versionedId : null
            } catch (e) {
              v.isPublic = false
            }
          }
        }
      }

      return sendApiSuccess(res, {
        success: true,
        versions: versions.map(v => ({
          version: v.version,
          display_name: v.display_name,
          description: v.description,
          fileName: v.fileName,
          timestamp: v.timestamp,
          isPublished: v.isPublished !== false,
          isPublic: v.isPublic || false,
          isLatest: v.isLatest || false,
          publicId: v.publicId || null
        })),
        mainPublicId,
        latestIsPublic,
        latestPublicVersion
      })
    } catch (error) {
      console.error(FUNC + ' error:', error)
      return sendFailure(res, error, FUNC, 500)
    }
  }

  const unpublishApp = async (req, res) => {
    const FUNC = 'creatorApiController.unpublishApp'
    try {
      const appName = req.body?.app_name
      const version = req.body?.version

      if (!appName) return sendFailure(res, 'app_name is required.', FUNC, 400)

      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'User not logged in.', FUNC, 401)

      const userDS = res.locals?.freezr?.userDS
      const freezrPrefs = res.locals?.freezr?.freezrPrefs
      if (!userDS) return sendFailure(res, 'User data store not available.', FUNC, 500)

      const publicRecordsDb = res.locals?.freezr?.publicRecordsDb
      if (!publicRecordsDb) return sendFailure(res, 'Could not access public records database.', FUNC, 500)

      const mainPublicId = '@' + userId + '/app/' + appName
      let targetPublicId

      if (version) {
        const mainRecord = await publicRecordsDb.read_by_id(mainPublicId)
        if (mainRecord && mainRecord.original_record?.version === version) {
          targetPublicId = mainPublicId
        } else {
          targetPublicId = mainPublicId + '/v/' + version
        }
      } else {
        targetPublicId = mainPublicId
      }

      const record = await publicRecordsDb.read_by_id(targetPublicId)
      if (!record) return sendFailure(res, 'No published version found at ' + targetPublicId, FUNC, 404)
      if (record.data_owner !== userId) return sendFailure(res, 'Permission denied.', FUNC, 403)

      // Delete public record entirely (following shareRecords ungrant pattern)
      try {
        await publicRecordsDb.delete_record(targetPublicId, {})
      } catch (e) {
        return sendFailure(res, 'Could not delete public record: ' + e.message, FUNC, 500)
      }

      // Also delete logo public record if unpublishing latest
      if (targetPublicId === mainPublicId) {
        const logoPublicId = mainPublicId + '/logo'
        try {
          const logoRecord = await publicRecordsDb.read_by_id(logoPublicId)
          if (logoRecord) {
            await publicRecordsDb.delete_record(logoPublicId, {})
          }
        } catch (e) { /* no logo record */ }
      }

      // Update the creator files DB to mark this version as unpublished
      const creatorOac = { owner: userId, app_name: 'info.freezr.creator' }
      const creatorFilesDb = await userDS.getorInitDb({ ...creatorOac, collection_name: 'files' }, { freezrPrefs })
      const unpublishedVersion = version || record.original_record?.version
      if (creatorFilesDb && record.original_record?.fileName) {
        try {
          await creatorFilesDb.update(record.original_record.fileName, { isPublished: false }, { replaceAllFields: false })
        } catch (e) {
          console.warn('Could not update creator files DB:', e.message)
        }
      }

      // Create appUpdates entry
      try {
        const appUpdatesDb = await userDS.getorInitDb({ ...creatorOac, collection_name: 'appUpdates' }, { freezrPrefs })
        if (appUpdatesDb) {
          await appUpdatesDb.create(null, {
            appName,
            action: 'unpublished',
            version: unpublishedVersion,
            timestamp: new Date().toISOString()
          }, {})
        }
      } catch (e) {
        console.warn('Could not record unpublish history entry:', e.message)
      }

      return sendApiSuccess(res, {
        success: true,
        unpublishedId: targetPublicId,
        version: unpublishedVersion
      })
    } catch (error) {
      console.error(FUNC + ' error:', error)
      return sendFailure(res, error, FUNC, 500)
    }
  }

  return {
    createBlankApp,
    getUserApps,
    readFolder,
    readAppFile,
    readAllFiles,
    writeAppFile,
    syncContext,
    uploadAppFile,
    renameApp,
    publishApp,
    getPublishedVersions,
    unpublishApp
  }
}

export default { createCreatorApiController }
