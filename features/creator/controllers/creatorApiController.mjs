import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { zipSync } from 'fflate'
import { sendApiSuccess, sendFailure } from '../../../adapters/http/responses.mjs'
import { userAppListOAC, userPERMS_OAC, constructAppIdStringFrom, isSystemApp, validAppName, isAskAppName, askAppSlug, ASK_APP_PREFIX, MAX_USER_NAME_LEN } from '../../../common/helpers/config.mjs'
import { listAllUserApps } from '../../account/services/accountQueryService.mjs'
import { deleteApp } from '../../account/services/appMgmtService.mjs'
import { generateAndSaveAppPasswordForUser } from '../../account/services/passwordService.mjs'
import { inspectTokenStore } from '../../../middleware/tokens/inspectTokenStore.mjs'
import { validateAppFiles as runFileValidation } from '../services/appValidationService.mjs'
import { askAppManifestSkeleton, askAppScaffoldFiles, askAppProtectedScaffoldFiles, ASKAPP_INDEX_MODULES, PROBE_HOOK_STUB } from '../askAppTemplate.mjs'
import { identityOf, stampCreated, stampFork } from '../../../common/helpers/provenance.mjs'

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

// On cloud hosts (Azure/AWS/…) the local disk under the repo root is a NON-authoritative, per-instance
// cache — files an app owns live in the cloud store, and may be absent locally (fresh instance, eviction,
// a best-effort local write that failed). So listing/zipping an app's files by reading the local FS
// (fs.promises) silently misses files. These helpers read via the CONNECTOR (dsManager) for cloud
// backends, falling back to the local FS only for the 'local'/'glitch' backends where the disk IS
// authoritative. See freezr_askapp_sharing_summary.md (Azure file-visibility fix).
const usesLocalDisk = (appFS) => {
  const type = appFS && appFS.fsParams && appFS.fsParams.type
  return !type || type === 'local' || type === 'glitch'
}

// Build a nested folder tree (same shape as buildFolderTree) from a FLAT list of relative file paths.
const buildTreeFromPaths = (paths) => {
  const root = []
  const dirIndex = new Map() // relDir -> children array
  const ensureDir = (relDir) => {
    if (!relDir) return root
    if (dirIndex.has(relDir)) return dirIndex.get(relDir)
    const parts = relDir.split('/')
    const parent = ensureDir(parts.slice(0, -1).join('/'))
    const children = []
    parent.push({ name: parts[parts.length - 1], path: relDir, type: 'folder', children })
    dirIndex.set(relDir, children)
    return children
  }
  for (const p of (paths || [])) {
    if (!p) continue
    const norm = String(p).replace(/\\/g, '/').replace(/^\/+/, '')
    if (!norm) continue
    const parts = norm.split('/')
    ensureDir(parts.slice(0, -1).join('/')).push({ name: parts[parts.length - 1], path: norm, type: 'file' })
  }
  const sortTree = (nodes) => {
    nodes.sort((a, b) => (a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name)))
    for (const n of nodes) if (n.children) sortTree(n.children)
    return nodes
  }
  return sortTree(root)
}

// All app file paths (relative), authoritative: connector for cloud, local FS for local/glitch.
const listAppFilePaths = async (appFS) => {
  if (!usesLocalDisk(appFS) && typeof appFS.readAppDir === 'function') {
    const entries = await appFS.readAppDir('') // cloud connectors return a flat recursive list
    return (entries || []).map((e) => String(e).replace(/\\/g, '/').replace(/^\/+/, '')).filter(Boolean)
  }
  const rootAbsPath = path.resolve(appFS.pathToFile(''))
  if (!fs.existsSync(rootAbsPath)) return []
  return collectFilePaths(await buildFolderTree(rootAbsPath, rootAbsPath)).map((p) => p.replace(/\\/g, '/'))
}

// All app files as {relPath: Uint8Array} for zipping — bytes read via readAppFile (connector-backed).
const collectAppFileBuffers = async (appFS) => {
  const result = {}
  for (const rel of await listAppFilePaths(appFS)) {
    try {
      const buf = await appFS.readAppFile(rel, { doNotToString: true })
      if (buf != null) result[rel] = new Uint8Array(Buffer.isBuffer(buf) ? buf : Buffer.from(buf))
    } catch (e) { console.warn('collectAppFileBuffers: could not read', rel, e.message) }
  }
  return result
}

const TEXT_EXTENSIONS = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'md', 'txt', 'svg', 'xml', 'csv', 'yaml', 'yml'])
const isTextFile = (filePath) => {
  const ext = filePath.split('.').pop().toLowerCase()
  return TEXT_EXTENSIONS.has(ext)
}

// Non-text app files (images, PDFs, fonts, media) are never part of the LLM's text context, so the
// model has always been blind to them — including images it generated itself, which made "make that
// logo bluer" impossible. These are inventoried (path + type + size) so the model KNOWS they exist
// and can ask to SEE the ones it can actually read: the LLM APIs accept images and PDFs as input
// (Claude: image / document blocks), so those are `viewable`. Video is NOT an accepted input on any
// current model — a video asset is listed but flagged unviewable so the model doesn't ask for it.
const ASSET_MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', pdf: 'application/pdf',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', zip: 'application/zip'
}
const VIEWABLE_ASSET_MIMES = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/
// Inventory only files we can actually name a type for, and never dot-files/dot-folders — otherwise
// the list fills with .DS_Store and extension-less junk (LICENSE etc.), which is pure context noise.
const assetInfo = (filePath) => {
  const segments = String(filePath).split('/')
  if (segments.some((seg) => seg.startsWith('.'))) return null
  const name = segments[segments.length - 1]
  if (!name.includes('.')) return null
  const mime = ASSET_MIME_BY_EXT[name.split('.').pop().toLowerCase()]
  if (!mime) return null
  return { mime, viewable: VIEWABLE_ASSET_MIMES.test(mime) }
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
// Exported for the account Dev tab's "(re)Generate context file for LLMs" button.
export const ensureContextDoc = async (appFS) => {
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

// Creates a new app's app_list record + a blank file scaffold (manifest + index.html/css/js +
// context doc). Shared by createBlankApp and createAskApp. Throws an Error with code 'EXISTS'
// if the app already exists so callers can retry with a different name. Does NOT validate the
// app name — the caller does that (validAppName for ordinary apps, validAskAppName (removed) — validAppName for ask-apps).
const persistNewApp = async ({ userDS, userId, freezrPrefs, appName, appDisplayName, manifest, extraEntityFields, scaffoldFiles }) => {
  const userAppListDb = await userDS.getorInitDb(userAppListOAC(userId), { freezrPrefs })
  if (!userAppListDb) throw new Error('Could not access app list database.')

  const appNameId = constructAppIdStringFrom(userId, appName)
  const existingEntity = await userAppListDb.read_by_id(appNameId)
  if (existingEntity) {
    const err = new Error('App already exists: ' + appName)
    err.code = 'EXISTS'
    throw err
  }

  const appEntity = {
    app_name: appName,
    app_display_name: appDisplayName || appName,
    manifest,
    warnings: [],
    installed: new Date().toISOString(),
    removed: false,
    ...(extraEntityFields || {})
  }
  await userAppListDb.create(appNameId, appEntity, null)

  const appFS = await userDS.getorInitAppFS(appName, {})
  if (!appFS || !appFS.writeToAppFiles) throw new Error('Could not initialise app filesystem.')

  await appFS.writeToAppFiles('manifest.json', JSON.stringify(manifest, null, 2), { doNotOverWrite: false })
  if (Array.isArray(scaffoldFiles) && scaffoldFiles.length) {
    // Caller-provided scaffold (e.g. the ask-app shell + base files) instead of the blank defaults.
    for (const f of scaffoldFiles) await appFS.writeToAppFiles(f.path, f.content || '', { doNotOverWrite: false })
  } else {
    await appFS.writeToAppFiles('index.html', BLANK_INDEX_HTML, { doNotOverWrite: false })
    await appFS.writeToAppFiles('index.css', BLANK_INDEX_CSS, { doNotOverWrite: false })
    await appFS.writeToAppFiles('index.js', BLANK_INDEX_JS, { doNotOverWrite: false })
  }

  try {
    await ensureContextDoc(appFS)
  } catch (err) {
    console.warn('persistNewApp: could not write context doc:', err.message)
  }

  return { appFS, appEntity }
}

// Trims one installed app's embedded manifest down to what the ask-app builder's Stage-1 routing
// LLM needs to pick relevant apps: names, description, table field descriptions, and a permission
// summary — NO source code, NO full field schemas. See freezr_askapps_plan_v1.md §5d.
const projectAppForContext = (app) => {
  const manifest = app.manifest || {}

  const appTables = {}
  if (manifest.app_tables && typeof manifest.app_tables === 'object') {
    for (const [tableName, tableDef] of Object.entries(manifest.app_tables)) {
      const fields = {}
      // Manifests define columns under either `field_names` or `schema` — support both (previously only
      // field_names, so schema-based apps like vcTracker were sent with EMPTY field info).
      const fieldDefs = (tableDef && (tableDef.field_names || tableDef.schema)) || {}
      for (const [fieldName, fieldDef] of Object.entries(fieldDefs)) {
        fields[fieldName] = (fieldDef && (fieldDef.description || fieldDef.type)) || ''
      }
      // Keep the table-level description too — it usually explains what the entity is and how it relates
      // to the others, which the model needs to query the right table.
      appTables[tableName] = (tableDef && tableDef.description) ? { description: tableDef.description, fields } : { fields }
    }
  }

  const permissions = Array.isArray(manifest.permissions)
    ? manifest.permissions
        .filter((p) => p && p.type)
        .map((p) => ({ name: p.name, type: p.type, table_id: p.table_id }))
    : []

  // A flat list of the app's source files (path + one-line description) so the Stage-1 routing LLM
  // can request specific files to reuse. Drawn from manifest.files (the app's documented list) plus
  // the file references in each page. No file contents — just paths.
  const files = []
  const seen = new Set()
  const addFile = (path, description) => {
    if (path && !seen.has(path)) { seen.add(path); files.push({ path, description: description || '' }) }
  }
  // Some manifests store a page's file refs as a bare string rather than an array — coerce.
  const asArray = (v) => (Array.isArray(v) ? v : (v ? [v] : []))
  if (Array.isArray(manifest.files)) manifest.files.forEach((f) => f && addFile(f.path, f.description))
  if (manifest.pages && typeof manifest.pages === 'object') {
    for (const page of Object.values(manifest.pages)) {
      if (!page) continue
      addFile(page.html_file, 'page html')
      asArray(page.modules).forEach((m) => addFile(m, 'page module'))
      asArray(page.script_files).forEach((m) => addFile(m, 'page script'))
      asArray(page.css_files).forEach((m) => addFile(m, 'page css'))
    }
  }

  return {
    app_name: app.app_name,
    app_type: app.app_type || null,
    _date_modified: app._date_modified || null,
    display_name: manifest.display_name || app.app_display_name || app.app_name,
    description: manifest.description || '',
    version: manifest.version || null,
    // Authorship (who first built it) — surfaced as "by: X" in the app list. See freezr_askapp_sharing_summary.md §3.
    authorship: manifest.authorship || null,
    // Optional per-app guidance for LLMs building pages against this app's data (e.g. how to decrypt
    // encrypted fields, which module to copy). Sent to both routing and build stages. See §"special_instructions".
    special_instructions: manifest.special_instructions || null,
    // Services this app offers to other apps: { description, contract } where contract is the
    // path of its contract doc (usually app-comms.md). Lets routing/reference LLMs know the app
    // can be interacted with, not just read.
    app_services: manifest.app_services || null,
    app_tables: appTables,
    files,
    permissions
  }
}

// A MUCH leaner projection for "which of the user's apps does this request refer to?" — the only
// question the creator chat's app_reference app_list pass has to answer. Table NAMES + descriptions,
// no field schemas, no file list. The full projectAppForContext runs ~165KB over ~30 apps (≈41k
// tokens) because it carries every field of every table plus every file description; injected as a
// follow-up message that alone could exhaust the model's output budget (observed: an empty response
// with stopReason 'max_tokens'). This is ~16KB for the same apps. The /ask Stage-1 router keeps the
// full projection — it needs field-level detail to route a DATA question.
const projectAppForSummary = (app) => {
  const manifest = app.manifest || {}
  const tables = {}
  if (manifest.app_tables && typeof manifest.app_tables === 'object') {
    for (const [tableName, tableDef] of Object.entries(manifest.app_tables)) {
      tables[tableName] = String((tableDef && tableDef.description) || '').slice(0, 200)
    }
  }
  return {
    app_name: app.app_name,
    app_type: app.app_type || null,
    display_name: manifest.display_name || app.app_display_name || app.app_name,
    description: String(manifest.description || '').slice(0, 400),
    // Services this app offers to OTHER apps (the whole point of the app_list pass for inter-app
    // work): the summary + where its contract doc lives.
    app_services: manifest.app_services || null,
    offers_services: !!manifest.app_services,
    tables
  }
}

// The manifest projection a REQUESTER app needs, for the app_reference "manifest" want.
// A full manifest is mostly irrelevant to another app AND can be enormous (superlazy: 134KB, of
// which 51% is per-file descriptions and 9% is page defs) — big enough that it used to be cut by
// the client's file-size cap, which left the model with UNPARSEABLE JSON. So:
//   - drop `pages` and `files` entirely (this app's internal structure/docs)
//   - keep full schemas ONLY for tables this app EXPOSES to other apps (those named in its
//     share_records / message_records / read_all / write_all / write_own permissions) — for
//     superlazy that resolves to exactly inputs / email_bodies / subscription_deliveries, the
//     tables its own contract tells requesters to read
//   - keep name + description for every other table, so the model knows they exist
// Returns { manifest_reference, omitted } — `omitted` is reported to the model so it can ask for a
// specific key or table if it genuinely needs more (bounded override rather than a silent cap).
const KEYS_KEPT_FOR_REFERENCE = ['identifier', 'version', 'display_name', 'description', 'app_services', 'authorship', 'jobs', 'permissions', 'special_instructions']
const PERM_TYPES_EXPOSING_TABLES = new Set(['share_records', 'message_records', 'read_all', 'write_all', 'write_own'])

export const projectManifestForReference = (manifest) => {
  const m = manifest || {}
  const ref = {}
  for (const key of KEYS_KEPT_FOR_REFERENCE) {
    if (m[key] !== undefined && m[key] !== null) ref[key] = m[key]
  }

  // Which of this app's own tables are reachable by another app?
  const exposedTables = new Set()
  for (const perm of (Array.isArray(m.permissions) ? m.permissions : [])) {
    if (!perm || !PERM_TYPES_EXPOSING_TABLES.has(perm.type)) continue
    const tableIds = [...(perm.table_id ? [perm.table_id] : []), ...(Array.isArray(perm.table_ids) ? perm.table_ids : [])]
    for (const tableId of tableIds) {
      if (typeof tableId === 'string' && tableId) exposedTables.add(tableId.split('.').pop())
    }
  }

  const appTables = {}
  const summarizedTables = []
  for (const [tableName, tableDef] of Object.entries((m.app_tables && typeof m.app_tables === 'object') ? m.app_tables : {})) {
    if (exposedTables.has(tableName)) {
      appTables[tableName] = tableDef // full schema — a requester can actually read this one
    } else {
      appTables[tableName] = { description: (tableDef && tableDef.description) || null }
      summarizedTables.push(tableName)
    }
  }
  if (Object.keys(appTables).length) ref.app_tables = appTables

  const omitted = []
  if (m.pages && Object.keys(m.pages).length) omitted.push('pages (' + Object.keys(m.pages).length + ' page definitions — internal to that app)')
  if (Array.isArray(m.files) && m.files.length) omitted.push('files (' + m.files.length + ' per-file descriptions — internal to that app)')
  if (summarizedTables.length) omitted.push('full field schemas for ' + summarizedTables.length + ' table(s) not exposed to other apps (name + description kept): ' + summarizedTables.join(', '))

  return { manifest_reference: ref, omitted }
}

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

      // The user-facing create flow refuses the reserved ask-app. namespace (ask-apps are made
      // via createAskApp). validAppName itself accepts ask-app.* — they are valid app names.
      if (isSystemApp(appName) || isAskAppName(appName) || !validAppName(appName)) {
        return sendFailure(res, 'App name not allowed: ' + appName, 'creatorApiController.createBlankApp', 400)
      }

      const userDS = res.locals?.freezr?.userDS
      if (!userDS) {
        return sendFailure(res, 'User data store not available.', 'creatorApiController.createBlankApp', 500)
      }

      const freezrPrefs = res.locals?.freezr?.freezrPrefs

      const manifest = { identifier: appName, version: '0.01', pages: { index: { html_file: 'index.html', css_files: 'index.css', script_files: 'index.js', 'page_title': 'Welcome to ' + appName } } }
      // Provenance: stamp authorship at creation (host derived like freezrMeta.serverAddress, so the
      // creator's own later edits match main_author). See common/helpers/provenance.mjs for the schema.
      const selfHost = res.locals?.freezr?.serverName || (req.protocol + '://' + req.get('host'))
      stampCreated(manifest, identityOf(userId, selfHost))

      try {
        await persistNewApp({ userDS, userId, freezrPrefs, appName, appDisplayName: appName, manifest })
      } catch (err) {
        if (err && err.code === 'EXISTS') {
          return sendFailure(res, 'App already exists: ' + appName, 'creatorApiController.createBlankApp', 400)
        }
        throw err
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

  // Creates a ask-app (an LLM-generated data page — see freezr_askapps_plan_v1.md). Unlike
  // createBlankApp, the caller supplies a free-text display name / question rather than an app
  // name; the server generates a unique `ask-app.{slug}.{suffix}` name in the reserved namespace
  // and stamps app_type:'askapp' on the app-list record. The generated files are blank placeholders
  // that the builder's LLM pipeline (Slice 2) overwrites.
  const createAskApp = async (req, res) => {
    try {
      const userId = req.session?.logged_in_user_id
      if (!userId) {
        return sendFailure(res, 'User not logged in.', 'creatorApiController.createAskApp', 401)
      }

      const displayName = (req.body?.display_name || req.body?.query || '').toString().trim()
      if (!displayName) {
        return sendFailure(res, 'A display name or query is required.', 'creatorApiController.createAskApp', 400)
      }

      const userDS = res.locals?.freezr?.userDS
      if (!userDS) {
        return sendFailure(res, 'User data store not available.', 'creatorApiController.createAskApp', 500)
      }
      const freezrPrefs = res.locals?.freezr?.freezrPrefs

      // Fit `ask-app.{slug}.{suffix}` within MAX_USER_NAME_LEN.
      const SUFFIX_LEN = 4
      const maxSlug = MAX_USER_NAME_LEN - ASK_APP_PREFIX.length - 1 - SUFFIX_LEN
      const slug = (askAppSlug(displayName).slice(0, maxSlug).replace(/-+$/, '')) || 'app'

      // Stamp authorship at creation (robust — not reliant on the first client build). Host is derived
      // the same way freezrMeta.serverAddress is (context.mjs serverName = protocol + host), so the
      // creator's own later edits match main_author and are NOT recorded as a foreign contributor.
      // See freezr_askapp_sharing_summary.md §3 (Manifest authorship schema).
      const selfHost = res.locals?.freezr?.serverName || (req.protocol + '://' + req.get('host'))
      const author = { id: userId, host: selfHost, date: Date.now() }

      let appName = null
      let lastErr = null
      for (let attempt = 0; attempt < 5 && !appName; attempt++) {
        const suffix = crypto.randomBytes(4).toString('hex').slice(0, SUFFIX_LEN)
        const candidate = ASK_APP_PREFIX + slug + '.' + suffix
        // A ask-app is a normal app in the reserved namespace: it must be a valid app name AND
        // carry the ask-app. prefix (true by construction here — belt and suspenders).
        if (!isAskAppName(candidate) || !validAppName(candidate)) {
          lastErr = new Error('Generated an invalid ask-app name: ' + candidate)
          continue
        }
        const manifest = {
          identifier: candidate,
          version: '0.01',
          app_type: 'askapp',
          display_name: displayName,
          ...askAppManifestSkeleton(displayName)
        }
        stampCreated(manifest, author) // authorship { main_author, last_modified, contributors, history }
        try {
          await persistNewApp({ userDS, userId, freezrPrefs, appName: candidate, appDisplayName: displayName, manifest, extraEntityFields: { app_type: 'askapp' }, scaffoldFiles: askAppScaffoldFiles() })
          appName = candidate
        } catch (err) {
          if (err && err.code === 'EXISTS') { lastErr = err; continue }
          throw err
        }
      }

      if (!appName) {
        return sendFailure(res, lastErr || 'Could not allocate a unique ask-app name.', 'creatorApiController.createAskApp', 500)
      }

      return sendApiSuccess(res, { success: true, app_name: appName, app_type: 'askapp', display_name: displayName })
    } catch (error) {
      console.error('creatorApiController.createAskApp error:', error)
      return sendFailure(res, error, 'creatorApiController.createAskApp', 500)
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

  // Stage-1 context for the ask-app builder: a trimmed projection of EVERY installed app's manifest
  // (names, description, table field descriptions, permission summary) so the routing LLM can pick
  // which app(s) a question is about. Excludes system apps and removed apps. See §5d / Phase 1.3.
  const getInstalledAppsContext = async (req, res) => {
    try {
      const userDS = res.locals?.freezr?.userDS
      if (!userDS) {
        return sendFailure(res, 'User data store not available.', 'creatorApiController.getInstalledAppsContext', 500)
      }

      const { user_apps, error } = await listAllUserApps(userDS, { includeManifest: true })
      if (error) {
        return sendFailure(res, error, 'creatorApiController.getInstalledAppsContext', 500)
      }

      // detail=summary → the LEAN projection (app identity + services + table names only), for the
      // creator chat's app_reference app_list pass, where the only question is WHICH app is meant.
      // Default stays the full projection: /ask Stage-1 routes DATA questions and needs field detail.
      const wantSummary = (req.query?.detail || req.body?.detail) === 'summary'
      const apps = (user_apps || [])
        .filter((app) => !isSystemApp(app.app_name) && !app.removed)
        .map(wantSummary ? projectAppForSummary : projectAppForContext)

      return sendApiSuccess(res, { success: true, apps, detail: wantSummary ? 'summary' : 'full' })
    } catch (error) {
      console.error('creatorApiController.getInstalledAppsContext error:', error)
      return sendFailure(res, error, 'creatorApiController.getInstalledAppsContext', 500)
    }
  }

  // The reference view of ONE app's manifest, for the creator chat's app_reference flow: a
  // purpose-built projection (see projectManifestForReference) instead of a raw manifest that can be
  // 130KB+ and mostly irrelevant to a requester app. Read from the app's manifest.json on disk (the
  // authoritative copy the developer edits), NOT the app-list record.
  const getManifestReference = async (req, res) => {
    const FUNC = 'creatorApiController.getManifestReference'
    try {
      const appName = req.query?.app_name || req.body?.app_name
      if (!appName || String(appName).includes('..')) {
        return sendFailure(res, 'app_name is required.', FUNC, 400)
      }
      const userDS = res.locals?.freezr?.userDS
      if (!userDS) return sendFailure(res, 'User data store not available.', FUNC, 500)

      const appFS = await userDS.getorInitAppFS(appName, {})
      if (!appFS || !appFS.readAppFile) return sendFailure(res, 'Could not access app filesystem.', FUNC, 500)

      let raw = null
      try {
        raw = await appFS.readAppFile('manifest.json')
      } catch (err) {
        return sendFailure(res, 'Could not read manifest.json for ' + appName + ': ' + err.message, FUNC, 404)
      }
      if (!raw) return sendFailure(res, 'No manifest.json found for ' + appName, FUNC, 404)

      let manifest = null
      try {
        manifest = JSON.parse(raw)
      } catch (err) {
        return sendFailure(res, 'manifest.json for ' + appName + ' is not valid JSON: ' + err.message, FUNC, 422)
      }

      const { manifest_reference: manifestReference, omitted } = projectManifestForReference(manifest)
      // The contract doc's path, so the caller can fetch it without re-parsing the manifest.
      const contractPath = (manifest.app_services && manifest.app_services.contract) || null
      return sendApiSuccess(res, {
        success: true,
        app_name: appName,
        manifest_reference: manifestReference,
        omitted,
        contract_path: contractPath,
        full_manifest_chars: String(raw).length
      })
    } catch (error) {
      console.error(FUNC + ' error:', error)
      return sendFailure(res, error, FUNC, 500)
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

      // Cloud backends: list via the connector (authoritative). Local/glitch: read the local disk.
      let tree
      if (!usesLocalDisk(appFS) && typeof appFS.readAppDir === 'function') {
        tree = buildTreeFromPaths(await appFS.readAppDir(''))
      } else {
        const rootAbsPath = path.resolve(appFS.pathToFile(''))
        tree = fs.existsSync(rootAbsPath) ? await buildFolderTree(rootAbsPath, rootAbsPath) : []
      }
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

      const files = []
      const assets = [] // non-text files: inventory only (path/type/size), never content
      const filePaths = await listAppFilePaths(appFS) // connector for cloud, local FS for local/glitch
      const localDisk = usesLocalDisk(appFS)
      for (const filePath of filePaths) {
        if (!isTextFile(filePath)) {
          const info = assetInfo(filePath)
          if (!info) continue // unrecognised / dot-file — not an asset worth telling the model about
          const { mime, viewable } = info
          let size = null
          // Size is a nicety (it tells the model whether an asset is worth requesting), so only take
          // it where it is free — a local stat. Never read the bytes just to measure them.
          if (localDisk && appFS.pathToFile) {
            try { size = (await fs.promises.stat(path.resolve(appFS.pathToFile(filePath)))).size } catch (e) { /* size unknown */ }
          }
          assets.push({ path: filePath, mime, viewable, size })
          continue
        }
        try {
          const content = await appFS.readAppFile(filePath)
          files.push({ path: filePath, content })
        } catch (err) {
          files.push({ path: filePath, content: null, error: err.message })
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

      return sendApiSuccess(res, { success: true, files, assets })
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
        // Delete via the connector (authoritative backend + local cache) — NOT just the local disk,
        // else the cloud copy survives and the file reappears. Guard root/traversal.
        if (!filePath || filePath === '/' || filePath === '.') return sendFailure(res, 'Invalid file path.', 'creatorApiController.writeAppFile', 400)
        if (typeof appFS.deleteAppFile === 'function') await appFS.deleteAppFile(filePath)
        else { const absPath = path.resolve(appFS.pathToFile(filePath)); if (fs.existsSync(absPath)) await fs.promises.unlink(absPath) }
        return sendApiSuccess(res, { success: true, file_path: filePath, action: 'deleted' })
      }

      if (action === 'delete_folder') {
        // Confine to the app dir (traversal/root guard), then delete via the connector.
        const absPath = path.resolve(appFS.pathToFile(filePath))
        const rootAbs = path.resolve(appFS.pathToFile(''))
        if (absPath === rootAbs || !absPath.startsWith(rootAbs + path.sep)) {
          return sendFailure(res, 'Cannot delete root or paths outside app.', 'creatorApiController.writeAppFile', 400)
        }
        if (typeof appFS.deleteAppFolder === 'function') await appFS.deleteAppFolder(filePath)
        else if (fs.existsSync(absPath)) await fs.promises.rm(absPath, { recursive: true, force: true })
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

  // Server-side copy of unchanged source files (e.g. an app's decryption/render modules) straight into
  // the target app's imported/<source_app>/<path>. Used by the ask-app builder so large reusable files
  // are copied on disk rather than regenerated by the LLM and re-uploaded — a big time/token saving.
  const copyAppFiles = async (req, res) => {
    const FUNC = 'creatorApiController.copyAppFiles'
    try {
      const targetApp = req.body?.target_app
      const sources = req.body?.sources // [{ app, path }]
      if (!targetApp || !Array.isArray(sources)) {
        return sendFailure(res, 'target_app and sources[] are required.', FUNC, 400)
      }
      const userDS = res.locals?.freezr?.userDS
      if (!userDS) return sendFailure(res, 'User data store not available.', FUNC, 500)

      const targetFS = await userDS.getorInitAppFS(targetApp, {})
      if (!targetFS || !targetFS.writeToAppFiles) {
        return sendFailure(res, 'Could not access target app filesystem.', FUNC, 500)
      }

      const copied = []
      const errors = []
      const srcFSCache = {}
      for (const s of sources) {
        if (!s || !s.app || !s.path || String(s.app).includes('..') || String(s.path).includes('..')) {
          errors.push({ ...(s || {}), error: 'invalid source' }); continue
        }
        try {
          if (!srcFSCache[s.app]) srcFSCache[s.app] = await userDS.getorInitAppFS(s.app, {})
          const srcFS = srcFSCache[s.app]
          if (!srcFS || !srcFS.readAppFile) { errors.push({ app: s.app, path: s.path, error: 'no source filesystem' }); continue }
          const content = await srcFS.readAppFile(s.path)
          const destPath = 'imported/' + s.app + '/' + s.path
          await targetFS.writeToAppFiles(destPath, content, { doNotOverWrite: false })
          copied.push({ app: s.app, path: s.path, dest: destPath })
        } catch (err) {
          errors.push({ app: s.app, path: s.path, error: err.message })
        }
      }
      return sendApiSuccess(res, { success: true, copied, errors })
    } catch (error) {
      console.error(FUNC + ' error:', error)
      return sendFailure(res, error, FUNC, 500)
    }
  }

  // Fork: copy EVERY file of source_app into target_app's ROOT (not imported/), rewriting every
  // occurrence of the source app id to the target app id in text files — so the copy runs against
  // its own tables and pages (nav URLs, fallback literals, manifest identifier + own table_ids all
  // carry the full app id; other apps' table_ids are naturally untouched). Skips dot-files/folders
  // (.git, .DS_Store, .freezr-access.local.json) and freezr-context.md (the target keeps its own).
  // Used by the creator chat's app_reference "fork" flow ("build an app like X").
  const cloneAppFiles = async (req, res) => {
    const FUNC = 'creatorApiController.cloneAppFiles'
    try {
      const sourceApp = req.body?.source_app
      const targetApp = req.body?.target_app
      if (!sourceApp || !targetApp || String(sourceApp).includes('..') || String(targetApp).includes('..')) {
        return sendFailure(res, 'source_app and target_app are required.', FUNC, 400)
      }
      if (sourceApp === targetApp) return sendFailure(res, 'source and target are the same app.', FUNC, 400)
      const userDS = res.locals?.freezr?.userDS
      if (!userDS) return sendFailure(res, 'User data store not available.', FUNC, 500)

      const srcFS = await userDS.getorInitAppFS(sourceApp, {})
      if (!srcFS || !srcFS.readAppFile) return sendFailure(res, 'Could not access source app filesystem.', FUNC, 500)
      const targetFS = await userDS.getorInitAppFS(targetApp, {})
      if (!targetFS || !targetFS.writeToAppFiles) return sendFailure(res, 'Could not access target app filesystem.', FUNC, 500)

      const allPaths = await listAppFilePaths(srcFS)
      const isDotPath = (p) => p.split('/').some((seg) => seg.startsWith('.'))
      const toCopy = allPaths.filter((p) => !isDotPath(p) && p !== CONTEXT_DOC_NAME)
      const skipped = allPaths.filter((p) => isDotPath(p) || p === CONTEXT_DOC_NAME)
      if (toCopy.length > 3000) return sendFailure(res, 'Source app has too many files to clone (' + toCopy.length + ').', FUNC, 400)

      const copied = []
      const replacements = [] // [{ path, count }] — occurrences of the source app id rewritten
      const errors = []
      let sourceManifestRaw = null // pre-replace source manifest, for the provenance fork stamp below
      let targetManifestText = null
      for (const rel of toCopy) {
        try {
          if (isTextFile(rel)) {
            let content = await srcFS.readAppFile(rel)
            content = content == null ? '' : String(content)
            if (rel === 'manifest.json') sourceManifestRaw = content
            const parts = content.split(sourceApp)
            if (parts.length > 1) {
              replacements.push({ path: rel, count: parts.length - 1 })
              content = parts.join(targetApp)
            }
            if (rel === 'manifest.json') targetManifestText = content
            await targetFS.writeToAppFiles(rel, content, { doNotOverWrite: false })
          } else {
            const buf = await srcFS.readAppFile(rel, { doNotToString: true })
            if (buf != null) await targetFS.writeToAppFiles(rel, buf, { doNotOverWrite: false })
          }
          copied.push(rel)
        } catch (err) {
          errors.push({ path: rel, error: err.message })
        }
      }

      // Provenance: the cloner owns the fork (main_author); the source app + its main_author are
      // credited in authorship.forked_from, and the source's history travels along (see provenance.mjs).
      // Stamped AFTER the id rewrite so forked_from.app keeps the SOURCE app id. Non-fatal.
      let provenance = null
      if (targetManifestText) {
        try {
          const targetManifest = JSON.parse(targetManifestText)
          let sourceManifest = null
          try { sourceManifest = JSON.parse(sourceManifestRaw) } catch (e) { /* unparseable source manifest — fork stamp proceeds without source authorship */ }
          const selfHost = res.locals?.freezr?.serverName || (req.protocol + '://' + req.get('host'))
          const userId = req.session?.logged_in_user_id
          stampFork(targetManifest, { by: identityOf(userId, selfHost), sourceApp, sourceManifest })
          await targetFS.writeToAppFiles('manifest.json', JSON.stringify(targetManifest, null, 2), { doNotOverWrite: false })
          provenance = targetManifest.authorship
        } catch (e) {
          console.warn(FUNC + ': could not stamp fork provenance:', e.message)
        }
      }

      return sendApiSuccess(res, {
        success: true,
        source_app: sourceApp,
        target_app: targetApp,
        copied: copied.length,
        files: copied,
        replacements,
        skipped,
        errors,
        provenance
      })
    } catch (error) {
      console.error(FUNC + ' error:', error)
      return sendFailure(res, error, FUNC, 500)
    }
  }

  // Re-apply the current protected scaffold to an existing ask-app: rewrites askapp-base.*/boot/probe with
  // the latest template, ensures the probe hook exists (without clobbering the model's), and migrates the
  // manifest's index modules to the boot dispatcher (file + app-list record). Lets scaffold fixes reach
  // apps built earlier without recreating them. Ask-apps only.
  const refreshAskAppScaffold = async (req, res) => {
    const FUNC = 'creatorApiController.refreshAskAppScaffold'
    try {
      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'User not logged in.', FUNC, 401)
      const appName = req.body?.app_name
      if (!appName || !isAskAppName(appName)) return sendFailure(res, 'An ask-app name is required.', FUNC, 400)
      const userDS = res.locals?.freezr?.userDS
      if (!userDS) return sendFailure(res, 'User data store not available.', FUNC, 500)
      const freezrPrefs = res.locals?.freezr?.freezrPrefs
      const appFS = await userDS.getorInitAppFS(appName, {})
      if (!appFS || !appFS.writeToAppFiles) return sendFailure(res, 'Could not access app filesystem.', FUNC, 500)

      // 1. Overwrite the protected scaffold files with the current template.
      for (const f of askAppProtectedScaffoldFiles()) await appFS.writeToAppFiles(f.path, f.content, { doNotOverWrite: false })
      // 2. Ensure the probe hook exists (never overwrite the model's version).
      try { await appFS.readAppFile('askapp-probe-hook.js') } catch (e) { await appFS.writeToAppFiles('askapp-probe-hook.js', PROBE_HOOK_STUB, { doNotOverWrite: false }) }
      // 3. Migrate the manifest's index modules to the boot dispatcher, drop any stale separate probe page.
      let manifest = null
      try {
        manifest = JSON.parse(await appFS.readAppFile('manifest.json'))
        if (!manifest.pages) manifest.pages = {}
        if (!manifest.pages.index) manifest.pages.index = { html_file: 'index.html', css_files: ['askapp-base.css', 'app.css'], page_title: manifest.display_name || appName }
        manifest.pages.index.modules = ASKAPP_INDEX_MODULES.slice()
        if (manifest.pages.probe) delete manifest.pages.probe
        await appFS.writeToAppFiles('manifest.json', JSON.stringify(manifest, null, 2), { doNotOverWrite: false })
      } catch (e) { /* leave manifest as-is if unreadable */ }
      // 4. Keep the app-list record's embedded manifest in step (page routing uses it).
      if (manifest) {
        try {
          const userAppListDb = await userDS.getorInitDb(userAppListOAC(userId), { freezrPrefs })
          const appId = constructAppIdStringFrom(userId, appName)
          const entity = userAppListDb && await userAppListDb.read_by_id(appId)
          if (entity) await userAppListDb.update(appId, { manifest }, { replaceAllFields: false })
        } catch (e) { /* best effort */ }
      }
      return sendApiSuccess(res, { success: true, app_name: appName })
    } catch (error) {
      console.error(FUNC + ' error:', error)
      return sendFailure(res, error, FUNC, 500)
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

      // writeToAppFiles writes to the connector (authoritative) + local cache, creating the local dir
      // itself — no need to pre-mkdir a (CWD-based) local folder here.
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

      // Copy every file from old → new via the CONNECTOR (authoritative). Reading the local disk here
      // would miss files on cloud hosts (per-instance cache), producing an empty/broken renamed app.
      const filePaths = await listAppFilePaths(oldAppFS)
      for (const filePath of filePaths) {
        try {
          const content = await oldAppFS.readAppFile(filePath, { doNotToString: true })
          if (content != null) await newAppFS.writeToAppFiles(filePath, content, { doNotOverWrite: false })
        } catch (err) {
          console.warn('Could not copy file ' + filePath + ':', err.message)
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

      // Phase 3b: Check for logo in copied files (via connector — local disk may be incomplete on cloud)
      let hasLogo = oldAppEntity.hasLogo || false
      try {
        const logo = await newAppFS.readAppFile('static/logo.png', { doNotToString: true })
        if (logo != null) hasLogo = true
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

      // 3. Zip the app folder — read files via the connector (authoritative on cloud; local disk is a
      // per-instance cache that can be incomplete). See listAppFilePaths / collectAppFileBuffers.
      const fileBuffers = await collectAppFileBuffers(appFS)
      if (!Object.keys(fileBuffers).length) return sendFailure(res, 'App has no files to publish.', FUNC, 404)
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
      let logoBuffer = null
      try {
        const rawLogo = await appFS.readAppFile('static/logo.png', { doNotToString: true }) // via connector
        if (rawLogo != null) logoBuffer = Buffer.isBuffer(rawLogo) ? rawLogo : Buffer.from(rawLogo)
      } catch (e) { /* no logo */ }
      if (!logoBuffer) logoNote = 'No logo found at static/logo.png'
      if (logoBuffer) {
        try {
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

  // Package an ask-app into info.freezr.creator.files for a PRIVATE person-to-person share (no public
  // record — unlike publishApp). Zips the app, writes the zip to the creator's user files, and creates
  // a `.files` record carrying the share metadata + a trimmed manifest_snapshot. The client then
  // freezr.messages.send()s the record_id to recipients; that message's _accessibles stamping is what
  // grants each same-host recipient the grantee file-fetch. See freezr_askapp_sharing_summary.md §2-3.
  const packageAskAppForShare = async (req, res) => {
    const FUNC = 'creatorApiController.packageAskAppForShare'
    try {
      const appName = req.body?.app_name
      if (!appName) return sendFailure(res, 'app_name is required.', FUNC, 400)
      if (!isAskAppName(appName)) return sendFailure(res, 'Only ask-apps can be shared this way.', FUNC, 400)

      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'User not logged in.', FUNC, 401)

      const userDS = res.locals?.freezr?.userDS
      const freezrPrefs = res.locals?.freezr?.freezrPrefs
      if (!userDS) return sendFailure(res, 'User data store not available.', FUNC, 500)

      // 1. Read manifest (version / authorship / permissions / description all come from it)
      const appFS = await userDS.getorInitAppFS(appName, {})
      if (!appFS || !appFS.readAppFile) return sendFailure(res, 'Could not access app filesystem.', FUNC, 500)

      let manifest
      try {
        manifest = JSON.parse(await appFS.readAppFile('manifest.json'))
      } catch (e) {
        return sendFailure(res, 'Could not read or parse manifest.json: ' + e.message, FUNC, 500)
      }

      const version = manifest.version || '0.01'
      const appDisplayName = manifest.display_name || appName
      const appDescription = manifest.description || ''
      const authorship = manifest.authorship || null

      // A trimmed snapshot so the recipient can preview what the app needs & grants BEFORE downloading
      // the zip: its permissions (which name the source tables), description, and the source tables.
      const perms = Array.isArray(manifest.permissions) ? manifest.permissions : []
      const sourceTables = [...new Set(perms.flatMap(p => Array.isArray(p.table_id) ? p.table_id : (p.table_id ? [p.table_id] : [])))]
      const manifestSnapshot = {
        display_name: appDisplayName,
        description: appDescription,
        version,
        permissions: perms,
        source_tables: sourceTables
      }

      // 2. Zip the app folder — read files via the connector (authoritative on cloud; the local disk is
      // a per-instance cache that can be incomplete). See listAppFilePaths / collectAppFileBuffers.
      const fileBuffers = await collectAppFileBuffers(appFS)
      if (!Object.keys(fileBuffers).length) return sendFailure(res, 'App has no files to share.', FUNC, 404)
      const zipBuffer = Buffer.from(zipSync(fileBuffers, { level: 6 }))

      // 3. Write the zip to the creator's user files. Follows the main-app convention where everything
      // AFTER the first space is metadata (here the version), so the app identity is the part before the
      // space and each version is retained as its own file (re-sharing a version overwrites; distinct
      // versions accumulate → a version history the recipient/sender can re-install from). The recipient's
      // grantee fetch URL-encodes this record_id, so the space is safe. See freezr_askapp_sharing_summary.md §4.
      const zipFileName = appName + ' v' + version + '.zip'
      const creatorAppFS = await userDS.getorInitAppFS('info.freezr.creator', {})
      if (!creatorAppFS || !creatorAppFS.writeToUserFiles) return sendFailure(res, 'Could not access creator user files.', FUNC, 500)
      await creatorAppFS.writeToUserFiles(zipFileName, zipBuffer, { doNotOverWrite: false })

      // 4. Create/update the private .files record (NO public record)
      const creatorOac = { owner: userId, app_name: 'info.freezr.creator' }
      const creatorFilesDb = await userDS.getorInitDb({ ...creatorOac, collection_name: 'files' }, { freezrPrefs })
      if (!creatorFilesDb) return sendFailure(res, 'Could not access info.freezr.creator.files.', FUNC, 500)

      const fileRecord = {
        record_type: 'app',
        app_type: 'ask',
        sharedAppName: appName,
        display_name: appDisplayName,
        description: appDescription,
        version,
        authorship,
        manifest_snapshot: manifestSnapshot,
        fileName: zipFileName,
        timestamp: new Date().toISOString(),
        isSharedApp: true,
        _UploadStatus: 'complete'
      }
      try {
        const existing = await creatorFilesDb.read_by_id(zipFileName)
        if (existing) await creatorFilesDb.update(zipFileName, fileRecord, { replaceAllFields: false })
        else await creatorFilesDb.create(zipFileName, fileRecord, {})
      } catch (e) {
        await creatorFilesDb.create(zipFileName, fileRecord, {})
      }

      return sendApiSuccess(res, {
        success: true,
        record_id: zipFileName,
        fileName: zipFileName,
        record_type: 'app',
        app_type: 'ask',
        app_name: appName,
        display_name: appDisplayName,
        version,
        authorship,
        manifest_snapshot: manifestSnapshot
      })
    } catch (error) {
      console.error(FUNC + ' error:', error)
      return sendFailure(res, error, FUNC, 500)
    }
  }

  /**
   * GET /creatorapi/validate_app_files?app_name=... — freezr_creator_selfcheck_plan_v1.md B1.
   *
   * Would these files actually load? PARSE-ONLY: JS syntax (acorn), JSON, and relative-import
   * resolution. Nothing generated is ever executed. CSS/HTML are not load-breaking (both are
   * error-tolerant by spec) and are checked advisorily in the browser instead.
   */
  const validateAppFiles = async (req, res) => {
    const FUNC = 'creatorApiController.validateAppFiles'
    try {
      const appName = req.query?.app_name
      if (!appName) return sendFailure(res, 'app_name is required.', FUNC, 400)

      const userDS = res.locals?.freezr?.userDS
      if (!userDS) return sendFailure(res, 'User data store not available.', FUNC, 500)

      const appFS = await userDS.getorInitAppFS(appName, {})
      if (!appFS || !appFS.readAppFile) return sendFailure(res, 'Could not access app filesystem.', FUNC, 500)

      const files = []
      for (const filePath of await listAppFilePaths(appFS)) {
        if (!isTextFile(filePath)) {
          files.push({ path: filePath, content: null }) // present for import resolution, not parsed
          continue
        }
        try {
          files.push({ path: filePath, content: await appFS.readAppFile(filePath) })
        } catch (err) {
          files.push({ path: filePath, content: null })
        }
      }

      const result = runFileValidation(files)
      return sendApiSuccess(res, { success: true, appName, ...result })
    } catch (error) {
      console.error(FUNC + ' error:', error)
      return sendFailure(res, error, FUNC, 500)
    }
  }

  /**
   * POST /creatorapi/create_inspection_token — freezr_creator_selfcheck_plan_v1.md Part A.
   *
   * Mints a short-lived inspection token the user hands to an LLM/agent (or that the builder
   * uses on its behalf) so it can check the app's work on a hosted freezr:
   *  - files scope (default on): random token in inspectTokenStore, honored ONLY by
   *    GET /creator/inspect/:app_name/* (page/source files, read-only).
   *  - data scope (opt-in via body.include_data): a real app token. `data_access: 'read'`
   *    (default) mints it read_only:true so mutating routes 403; `data_access: 'write'` mints a
   *    normal token that can also write — only ever granted through an explicit user consent
   *    click in the creator UI.
   *
   * Body: { app_name, include_files?: bool (default true), include_data?: bool,
   *         data_access?: 'read'|'write', ttl_minutes?: number (default 30, max 60) }
   * Tokens are returned to the browser for display/use — never written to server disk.
   */
  const createInspectionToken = async (req, res) => {
    const FUNC = 'creatorApiController.createInspectionToken'
    try {
      const userId = req.session?.logged_in_user_id
      if (!userId) return sendFailure(res, 'Missing user id', FUNC, 401)

      const appName = req.body?.app_name
      if (!appName) return sendFailure(res, 'Invalid app name', FUNC, 400)
      if (isSystemApp(appName)) return sendFailure(res, 'Cannot create inspection tokens for system apps', FUNC, 403)
      if (!validAppName(appName)) return sendFailure(res, 'Invalid app name', FUNC, 400)

      const includeFiles = req.body?.include_files !== false // default on
      const includeData = req.body?.include_data === true
      const dataAccess = req.body?.data_access === 'write' ? 'write' : 'read'
      let ttlMinutes = parseInt(req.body?.ttl_minutes, 10)
      if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) ttlMinutes = 30
      ttlMinutes = Math.min(ttlMinutes, 60)
      const expiry = Date.now() + ttlMinutes * 60 * 1000

      // The app must actually exist for this user (every installed app has a manifest.json).
      const userDS = res.locals?.freezr?.userDS
      if (!userDS) return sendFailure(res, 'User data store not available', FUNC, 500)
      const targetAppFS = await userDS.getorInitAppFS(appName, {})
      try {
        await targetAppFS.readAppFile('manifest.json')
      } catch (e) {
        return sendFailure(res, 'App not found: ' + appName, FUNC, 404)
      }

      // Files scope — cache-only token, dies on expiry or restart, never in the app_tokens DB.
      let filesToken = null
      if (includeFiles) {
        filesToken = crypto.randomBytes(32).toString('hex')
        inspectTokenStore.set(filesToken, { app_name: appName, owner_id: userId, expiry })
      }

      // Data scope (opt-in) — a real app token; read_only unless write was explicitly consented to.
      let dataToken = null
      if (includeData) {
        const tokenDb = res.locals?.freezr?.appTokenDb
        if (!tokenDb) return sendFailure(res, 'App token database not available', FUNC, 500)
        const { app_password: appPassword } = await generateAndSaveAppPasswordForUser(tokenDb, userId, appName, {
          deviceCode: req.session.device_code,
          expiry,
          oneDevice: false,
          readOnly: (dataAccess !== 'write')
        })
        const tokenRecords = await tokenDb.query({ app_password: appPassword }, {})
        dataToken = (tokenRecords && tokenRecords[0] && tokenRecords[0].app_token) || null
        if (!dataToken) return sendFailure(res, 'Could not retrieve newly created data token', FUNC, 500)
      }

      const baseUrl = (req.headers.host && req.headers.host.startsWith('localhost') ? 'http' : 'https') + '://' + req.headers.host
      const expiresAt = new Date(expiry).toISOString()
      const examples = {}
      if (filesToken) {
        examples.readMainPage = 'curl "' + baseUrl + '/creator/inspect/' + appName + '/index.html?inspectToken=' + filesToken + '"'
        examples.readAppJs = 'curl "' + baseUrl + '/creator/inspect/' + appName + '/index.js?inspectToken=' + filesToken + '"'
        examples.readManifest = 'curl "' + baseUrl + '/creator/inspect/' + appName + '/manifest.json?inspectToken=' + filesToken + '"'
      }
      if (dataToken) {
        examples.queryData = 'curl -s -X POST "' + baseUrl + '/ceps/query/' + appName + '.<collection>" -H "Authorization: Bearer ' + dataToken + '" -H "Content-Type: application/json" -d \'{"count":5}\''
        if (dataAccess === 'write') {
          examples.writeData = 'curl -s -X POST "' + baseUrl + '/ceps/write/' + appName + '.<collection>" -H "Authorization: Bearer ' + dataToken + '" -H "Content-Type: application/json" -d \'{"field":"value"}\''
        }
      }

      // Tokens are truncated: enough to correlate with the validation logs, never the full secret.

      return sendApiSuccess(res, {
        success: true,
        appName,
        baseUrl,
        filesToken,
        dataToken,
        dataAccess: dataToken ? dataAccess : null,
        readOnly: dataToken ? (dataAccess !== 'write') : true,
        ttlMinutes,
        expiresAt,
        examples
      })
    } catch (error) {
      console.error(FUNC + ' error:', error)
      return sendFailure(res, error, FUNC, 500)
    }
  }

  return {
    createBlankApp,
    createAskApp,
    packageAskAppForShare,
    getUserApps,
    getInstalledAppsContext,
    getManifestReference,
    readFolder,
    readAppFile,
    readAllFiles,
    writeAppFile,
    copyAppFiles,
    cloneAppFiles,
    refreshAskAppScaffold,
    syncContext,
    uploadAppFile,
    renameApp,
    publishApp,
    getPublishedVersions,
    unpublishApp,
    createInspectionToken,
    validateAppFiles
  }
}

export default { createCreatorApiController }
