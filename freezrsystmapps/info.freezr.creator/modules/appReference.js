/* global freezr */
// Resolves an app_reference section emitted by the chat model (see chatPrompt.js "Output Format").
// The model emits app_reference when the user's request involves another of the user's apps and it
// lacks that app's details; this module fetches what it asked for and returns a follow-up user
// message for the next LLM pass. Three shapes:
//   { need: "app_list" }                          -> send back the trimmed installed-apps context
//   { apps: [{ app, want: [contract|manifest|fork], files: [...] }] } -> import (or fork) those apps
// Imported contract/manifest/files are ALSO copied into imported/<app>/ (server-side copy) so they
// stay in the project's file context on every later turn — the import happens once per relationship.
import { updateAppFromFiles } from './utils.js'

const apiGet = async (path) => {
  const result = await freezr.apiRequest('GET', path)
  if (!result || result.error) throw new Error(result?.error || 'Request failed: ' + path)
  return result
}
const apiPost = async (path, body) => {
  const result = await freezr.apiRequest('POST', path, body)
  if (!result || result.error) throw new Error(result?.error || 'Request failed: ' + path)
  return result
}

const MAX_APPS_PER_REFERENCE = 3
const MAX_FILES_PER_APP = 10
// Source/text files are capped: another app's folder can hold vendored bundles far too big for any
// context window (observed in real apps: tui-grid.js 1.25MB, pdf-worker-min.js 1.09MB,
// xlsx.full.min.js 909KB) and one such request would fail the whole turn. The cap is per REQUEST,
// and the model is told the real size so it can ask for more (up to MAX_FILE_CHARS_OVERRIDE) —
// a bounded override rather than a silent ceiling.
const MAX_FILE_CHARS = 100000
const MAX_FILE_CHARS_OVERRIDE = 400000
// STRUCTURED data is never truncated — cutting JSON mid-structure yields unparseable text, which is
// worse than not sending it (this is exactly how a 134KB manifest reached the model as broken JSON).
// Manifests go through the server's reference projection instead; any other oversized JSON is
// omitted with its size stated.
const isStructured = (filePath) => /\.json$/i.test(String(filePath || ''))
// Minified/bundled vendor code is never worth reading — huge, and unintelligible to a model.
const isMinifiedBundle = (filePath) => /(\.min\.(js|css)|-min\.js|bundle\.js)$/i.test(String(filePath || ''))

const fileBlock = (path, content, note) =>
  '--- FILE: ' + path + ' (READ-ONLY reference' + (note ? ' — ' + note : '') + ') ---\n' + content + '\n--- END FILE ---'

// Reads one file for reference. `maxChars` lets a follow-up request pull more of a truncated file.
// Returns { content, note } for text, or { skipped, reason } when the file should not be sent.
const readSourceFile = async (appName, filePath, { maxChars = MAX_FILE_CHARS } = {}) => {
  if (isMinifiedBundle(filePath)) {
    return { skipped: true, reason: 'minified/bundled vendor file — not readable source, not sent' }
  }
  const r = await apiGet('/creatorapi/read_app_file?app_name=' + encodeURIComponent(appName) + '&file_path=' + encodeURIComponent(filePath))
  const full = r.content == null ? '' : String(r.content)
  const cap = Math.min(Math.max(Number(maxChars) || MAX_FILE_CHARS, 1), MAX_FILE_CHARS_OVERRIDE)

  if (full.length <= cap) return { content: full, note: null }

  if (isStructured(filePath)) {
    return {
      skipped: true,
      reason: 'structured file is ' + full.length + ' chars (over the ' + cap + ' limit) and is NOT truncated, ' +
        'because partial JSON would be unparseable. Ask for the specific part you need.'
    }
  }
  return {
    content: full.slice(0, cap),
    note: 'TRUNCATED: showing the first ' + cap + ' of ' + full.length + ' chars. To see more, ask again for this ' +
      'file in an app_reference and say how much you need (up to ' + MAX_FILE_CHARS_OVERRIDE + ' chars)'
  }
}

const appListMessage = async (currentApp) => {
  // detail=summary: identity + services + table names only. The full projection is ~10x bigger
  // (~41k tokens over ~30 apps) and answering "which app does the user mean?" never needed it.
  const ctx = await apiGet('/creatorapi/installed_apps_context?detail=summary')
  const apps = (ctx.apps || []).filter((a) => a.app_name !== currentApp)
  return 'APP LIST (system response to your app_reference request). The user\'s installed apps — identity, ' +
    'description, services offered, and their data-table NAMES (field schemas are not included here; ' +
    'ask for an app\'s "manifest" to get them). Apps with an "app_services" entry offer services to other ' +
    'apps, and their contract doc has the details:\n' +
    JSON.stringify(apps, null, 1) +
    '\n\nIdentify which app(s) the user\'s request refers to. If clear, respond with ONLY another app_reference section ' +
    'requesting what you need from it ("contract", "manifest", "fork", or specific "files"). ' +
    'If the request is ambiguous, ask the user in an explanation section instead (no app_reference). Do not build yet if you still need an app\'s contract or manifest.'
}

// Fork: server-side copy of the whole source app into the current app, with the source app id
// rewritten to the current app id in text files. Then re-install so pages/permissions register.
const forkApp = async (currentApp, sourceApp) => {
  const result = await apiPost('/creatorapi/clone_app_files', { source_app: sourceApp, target_app: currentApp })
  try { await updateAppFromFiles(currentApp) } catch (e) { console.warn('[appReference] install after fork failed:', e) }
  const replaced = (result.replacements || []).map((r) => r.path + ' (' + r.count + ')').join(', ')
  return 'FORK COMPLETE (system response to your app_reference request): copied ' + result.copied +
    ' files from ' + sourceApp + ' into this app and re-installed it. Every occurrence of "' + sourceApp +
    '" in text files was rewritten to "' + currentApp + '"' + (replaced ? ' — in: ' + replaced : '') + '.' +
    ((result.errors || []).length ? ' ERRORS: ' + JSON.stringify(result.errors) : '') +
    ' The project file context has been refreshed below to reflect the copied code. Check the manifest\'s display_name/description (they still describe the source app) and apply the differences the user asked for.'
}

const importApp = async (currentApp, entry) => {
  const appName = entry.app
  const want = Array.isArray(entry.want) && entry.want.length ? entry.want : ['contract', 'manifest']
  const parts = []
  const copySources = []

  // The manifest comes as the server's REFERENCE PROJECTION, never raw: a raw manifest is mostly
  // this app's own internals and can be far bigger than any sane context budget (superlazy: 134KB).
  // The projection keeps identity/services/permissions + full schemas for the tables this app
  // exposes to others, and reports what it left out so the model can ask for more.
  let ref = null
  try {
    ref = await apiGet('/creatorapi/manifest_reference?app_name=' + encodeURIComponent(appName))
  } catch (e) {
    return 'Could not read the manifest of ' + appName + ' (' + e.message + ') — check the app id against the app list (request { "need": "app_list" } if you have not seen it).'
  }
  const manifestReference = ref.manifest_reference || {}
  const contractPathFromManifest = ref.contract_path || null

  if (want.includes('manifest')) {
    const projectionJson = JSON.stringify(manifestReference, null, 2)
    const omittedNote = (ref.omitted && ref.omitted.length)
      ? 'reference projection of the manifest — OMITTED: ' + ref.omitted.join('; ') +
        '. Ask for a specific key or table in another app_reference if you need it'
      : 'reference projection of the manifest'
    parts.push(fileBlock('imported/' + appName + '/manifest.json', projectionJson, omittedNote))
    // Persist the PROJECTION (not the raw file) into imported/ — it stays in the project's file
    // context on every later turn, so shipping the full manifest there would re-pay its cost forever.
    try {
      await apiPost('/creatorapi/write_app_file', {
        app_name: currentApp,
        file_path: 'imported/' + appName + '/manifest.json',
        content: projectionJson
      })
    } catch (e) {
      console.warn('[appReference] could not persist manifest projection to imported/:', e)
    }
  }

  if (want.includes('contract')) {
    const contractPath = contractPathFromManifest || 'app-comms.md'
    try {
      const c = await readSourceFile(appName, contractPath)
      if (c.skipped) parts.push('NOTE: ' + appName + '/' + contractPath + ' not sent — ' + c.reason)
      else {
        parts.push(fileBlock('imported/' + appName + '/' + contractPath, c.content, c.note))
        copySources.push({ app: appName, path: contractPath })
      }
    } catch (e) {
      parts.push('NOTE: ' + appName + ' has no readable contract doc (' + contractPath + '). ' +
        (manifestReference.app_services ? 'Its manifest declares app_services but the contract file could not be read.' : 'It does not declare app_services — it does not offer inter-app services; rely on its manifest (tables/permissions) instead.'))
    }
  }

  const filesWanted = (Array.isArray(entry.files) ? entry.files : []).slice(0, MAX_FILES_PER_APP)
  const maxChars = Number(entry.max_chars) || undefined // lets a follow-up pull more of a truncated file
  for (const f of filesWanted) {
    try {
      const r = await readSourceFile(appName, f, { maxChars })
      if (r.skipped) { parts.push('NOTE: ' + appName + '/' + f + ' not sent — ' + r.reason); continue }
      parts.push(fileBlock('imported/' + appName + '/' + f, r.content, r.note))
      // Only copy files that were sent WHOLE; a truncated copy on disk would look complete later.
      if (!r.note) copySources.push({ app: appName, path: f })
    } catch (e) {
      parts.push('NOTE: could not read ' + appName + '/' + f + ' (' + e.message + ').')
    }
  }

  if (copySources.length) {
    try {
      await apiPost('/creatorapi/copy_app_files', { target_app: currentApp, sources: copySources })
    } catch (e) {
      console.warn('[appReference] copy to imported/ failed (context still sent inline):', e)
    }
  }

  return parts.join('\n\n')
}

// Main entry. Returns { followUpMessage, forked } — forked=true means the current app's files
// changed wholesale and the caller must rebuild the whole prompt (fresh file context).
export const resolveAppReference = async (appReference, { currentApp }) => {
  if (!appReference || typeof appReference !== 'object') throw new Error('Invalid app_reference payload')

  if (appReference.need === 'app_list' || !Array.isArray(appReference.apps) || appReference.apps.length === 0) {
    const followUpMessage = await appListMessage(currentApp)
    return { followUpMessage, forked: false }
  }

  const entries = appReference.apps
    .filter((e) => e && typeof e.app === 'string' && e.app && !e.app.includes('..') && e.app !== currentApp)
    .slice(0, MAX_APPS_PER_REFERENCE)
  if (!entries.length) {
    return { followUpMessage: await appListMessage(currentApp), forked: false }
  }

  const sections = []
  let forked = false
  for (const entry of entries) {
    const want = Array.isArray(entry.want) ? entry.want : []
    if (want.includes('fork')) {
      sections.push(await forkApp(currentApp, entry.app))
      forked = true
    } else {
      sections.push('APP CONTEXT for ' + entry.app + ' (system response to your app_reference request):\n\n' + await importApp(currentApp, entry))
    }
  }

  if (!forked) {
    sections.push('The files above have been copied into imported/<app>/ and will remain in your project context in later turns. ' +
      'Now fulfill the user\'s original request — follow the contract exactly (request shapes, message lifecycle, trust model) and do not emit app_reference again for these apps.')
  }
  const followUpMessage = sections.join('\n\n')
  return { followUpMessage, forked }
}
