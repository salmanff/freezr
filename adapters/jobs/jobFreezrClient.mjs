// freezr.info — Bundled "freezr" API client handed to a Job's handler(freezr, params)
//
// SINGLE SOURCE OF TRUTH, ZERO CHANGES TO THE BROWSER CLIENT.
// Loads the real browser client — freezrApiV2.js + its addons (freezrApiV2.connections.js,
// freezrApiV2.llm.js) — in a node sandbox (see jobClientCore.mjs) and supplies its OWN `fetch`.
// The browser client ultimately calls `fetch`, so swapping fetch redirects EVERY call (CRUD,
// freezr.llm.*, freezr.connections.*) without touching any browser file.
//
//   - in-process (local job) → the fetch shim forwards to the injected transport, which routes
//                              into internalApiClient.dispatch
//   - http (serverless job)  → the transport is real fetch to the base URL (see httpJobTransport.mjs);
//                              that path runs inside the deployed bundle, sources loaded from the
//                              bundle's clientSources.json — NOT through this host-only module.
//
// This module is the HOST side: it knows where the client files live on disk and which ones to
// load (from common/freezrApiClient.manifest.json, shared with pageLoader + sdkAddons so it can't
// drift). The portable vm/fetch logic lives in jobClientCore.mjs and is reused by both sides.
//
// CAVEAT: two addon helpers read a streaming/binary Response (llm _streamingAsk, connection binary
// downloads). The fetch shim returns a JSON-style Response, so those two paths aren't supported
// in-process yet (everything else — all CRUD, non-streaming llm.ask, connection metadata — is).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { jobClientSources } from '../../common/helpers/freezrApiClientManifest.mjs'
import { buildFreezrClient } from './jobClientCore.mjs'

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../freezrsystmapps/info.freezr.public/public')

// Read the core + addon client files from disk, per the shared manifest. Cached (files don't
// change at runtime). Returns the { coreName, core, addons:[{name,src}] } shape buildFreezrClient
// and the serverless bundler both consume — so the bytes shipped to Lambda are the SAME the host
// runs locally.
let _cachedSrc = null
export const loadHostClientSources = () => {
  if (_cachedSrc) return _cachedSrc
  const { core, addons } = jobClientSources()
  _cachedSrc = {
    coreName: core,
    core: readFileSync(join(PUBLIC_DIR, core), 'utf8'),
    addons: addons.map(f => ({ name: f, src: readFileSync(join(PUBLIC_DIR, f), 'utf8') }))
  }
  return _cachedSrc
}

/**
 * Build a job-side `freezr` client backed by the given transport (host path).
 * @param {Object}   args
 * @param {Function} args.transport  (method, path, body, options) => Promise<result>
 * @param {Object}   [args.freezrMeta]  { appName, userId, ... } (serverAddress/appToken defaulted)
 * @returns the real freezr client (freezr.create/read/query/..., freezr.llm.*, freezr.connections.*)
 */
export function createJobFreezrClient ({ transport, freezrMeta = {} }) {
  return buildFreezrClient({ transport, freezrMeta, sources: loadHostClientSources() })
}

export default { createJobFreezrClient, loadHostClientSources }
