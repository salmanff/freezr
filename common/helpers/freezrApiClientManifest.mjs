// freezr.info — Accessor for the freezr API client manifest (single source of truth).
//
// Reads common/freezrApiClient.manifest.json and exposes derived views for its three consumers:
//   - pageLoader.mjs        → clientScriptTags(sdkAddons)   (browser <script> tags)
//   - sdkAddons.mjs         → computeSdkAddons(permTypes)   (which add-ons an app gets)
//   - jobFreezrClient.mjs   → jobClientSources()            (core + addon files to vm-load)
//
// Add/rename a client file in the JSON and all three update consistently — no per-file edits.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../freezrApiClient.manifest.json'), 'utf8')
)

export const CLIENT_CORE_FILE = MANIFEST.core
export const CLIENT_ADDONS = MANIFEST.addons
export const CLIENT_PUBLIC_ROUTE = MANIFEST.publicAppRoute

/** Browser: core + the add-ons enabled for this app (sdkAddons is { connections:bool, llm:bool, ... }). */
export const clientScriptTags = (sdkAddons = {}) => {
  const tag = (f) => `<script src="${MANIFEST.publicAppRoute}${f}" type="text/javascript"></script>`
  let tags = tag(MANIFEST.core)
  for (const addon of MANIFEST.addons) {
    if (sdkAddons[addon.key]) tags += tag(addon.file)
  }
  return tags
}

/** Detection: given a Set of the app's permission types, which add-ons it gets ({ key: bool }). */
export const computeSdkAddons = (permissionTypeSet) => {
  const out = {}
  for (const addon of MANIFEST.addons) {
    out[addon.key] = addon.permissionTypes.some(t => permissionTypeSet.has(t))
  }
  return out
}

/** Node job client: the core file + the add-on files flagged loadInJobClient (core first). */
export const jobClientSources = () => ({
  core: MANIFEST.core,
  addons: MANIFEST.addons.filter(a => a.loadInJobClient).map(a => a.file)
})

export default { CLIENT_CORE_FILE, CLIENT_ADDONS, CLIENT_PUBLIC_ROUTE, clientScriptTags, computeSdkAddons, jobClientSources }
