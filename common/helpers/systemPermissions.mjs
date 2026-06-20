// freezr.info - System permissions registry helper
//
// Reads common/systemPermissions.json once at module load and exposes a small
// lookup API. Used by middleware (llmContext, mailContext, future others) to
// find auto-granted permission shortcuts for system apps.
//
// Design intent (see freezr_system_apps_design.md and the JSON file's
// _documentation block): each entry mirrors the shape of a freezr permission
// record so middleware can layer them on top of DB-loaded perms without any
// adapter logic. The fabricated records are in-memory only; nothing is written
// to the user's permissions DB.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REGISTRY_PATH = path.resolve(__dirname, '../systemPermissions.json')

let registry = null

const loadRegistry = () => {
  if (registry !== null) return registry
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    registry = Array.isArray(parsed?.exceptions) ? parsed.exceptions : []
  } catch (e) {
    console.error('systemPermissions: failed to load registry at', REGISTRY_PATH, '—', e.message)
    registry = []
  }
  return registry
}

/**
 * Return all system-permission exception records that match the given
 * (requestor_app, type) pair. Each returned record is shaped like a freezr
 * permission record (granted: true, plus any per-type fields like
 * connection_names / scopes), with system_perm: true as a marker.
 *
 * Callers should treat the returned array as read-only — it's the actual
 * registry slice, not a copy.
 *
 * @param {string} requestorApp
 * @param {string} permType
 * @returns {Array<Object>}
 */
export const getSystemPermissionsFor = (requestorApp, permType) => {
  if (!requestorApp || !permType) return []
  return loadRegistry().filter(
    e => e.requestor_app === requestorApp && e.type === permType
  )
}

/**
 * Return all system-permission exception records for a given app (any type).
 * Useful for audits + future install-pipeline integration.
 */
export const getAllSystemPermissionsForApp = (requestorApp) => {
  if (!requestorApp) return []
  return loadRegistry().filter(e => e.requestor_app === requestorApp)
}

/**
 * Force a reload of the registry from disk. Useful in tests; production code
 * picks up edits only on server restart.
 */
export const reloadSystemPermissionsRegistry = () => {
  registry = null
  return loadRegistry()
}

export default { getSystemPermissionsFor, getAllSystemPermissionsForApp, reloadSystemPermissionsRegistry }
