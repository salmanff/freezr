// freezr.info — Cloud job source + deploy-identity helpers (Tier-2 reliability + hash-redeploy)
//
// Guards against two storage/deploy realities:
//
//  1) THE BUNDLE IS BINARY — it lives in the user's appFS (permanent backend); the local-disk copy is
//     just a fast cache. It MUST be read binary-safe (readAppFile doNotToString → the connector's
//     getFileToSend), or the connector text-decodes it and corrupts it. We still validate the bytes
//     with looksLikeZip and fall back to the single index.mjs, so a missing-file stub never crashes.
//
//  2) STALE DEPLOYS — a freezr upgrade or a job-code edit must re-ship the deployed function. We stamp
//     a small "deploy identity" marker (jobs/<name>.deployed, TEXT) at deploy time and compare it on
//     the next run; redeploy only on a mismatch, otherwise invoke the existing function untouched.
//     The identity excludes node_modules, so the check is cheap regardless of dependency size.

import { createHash } from 'node:crypto'
import { looksLikeZip, looksLikeJobSource } from '../../../adapters/jobs/serverlessBundle.mjs'

const isTextStub = (s) => typeof s === 'string' && s.trimStart()[0] === '<' // HTML/blank error stub

/**
 * Read a job's deployable code from the user's appFS. Order of preference:
 *   1) jobs/<name>.zip       — the per-job bundle, read binary-safe (carries Tier-2 node_modules)
 *   2) jobs/<name>/index.mjs — single-file source (Tier-1 only; no node_modules)
 * @returns {Promise<{zip:Uint8Array}|{source:string}|null>}
 */
export async function loadJobCodeFromAppFS (appFS, jobName) {
  // 1) the binary bundle (doNotToString → binary-safe read)
  try {
    const zip = await appFS.readAppFile('jobs/' + jobName + '.zip', { doNotToString: true })
    if (looksLikeZip(zip)) return { zip: zip instanceof Uint8Array ? zip : new Uint8Array(zip) }
  } catch (e) { /* fall through */ }
  // 2) single-file source
  try {
    const code = await appFS.readAppFile('jobs/' + jobName + '/index.mjs', {})
    if (looksLikeJobSource(code)) return { source: String(code) }
  } catch (e) { /* none */ }
  return null
}

/**
 * The job's identity inputs for the deploy hash: its source + dependency manifest (index.mjs +
 * package.json + lockfile TEXT). Deliberately NOT the installed node_modules tree — a dep change is
 * reflected in package.json/lockfile, so this stays cheap. Missing/stub parts contribute ''.
 * @returns {Promise<string>}
 */
export async function loadJobIdentitySource (appFS, jobName) {
  const read = async (p) => {
    try { const c = await appFS.readAppFile(p, {}); return (typeof c === 'string' && !isTextStub(c)) ? c : '' } catch (e) { return '' }
  }
  const [index, pkg, lock] = await Promise.all([
    read('jobs/' + jobName + '/index.mjs'),
    read('jobs/' + jobName + '/package.json'),
    read('jobs/' + jobName + '/package-lock.json')
  ])
  return index + '\u0000' + pkg + '\u0000' + lock
}

/**
 * A stable content identity of a job's CODE (index.mjs + package.json/lockfile text — deterministic,
 * not the zip bytes which aren't). Used by admin-trust to detect when a re-installed job's code has
 * changed so the trust can be disabled until re-reviewed. Returns a hex hash, or null if no code.
 */
export async function jobCodeIdentity (appFS, jobName) {
  const src = await loadJobIdentitySource(appFS, jobName)
  // loadJobIdentitySource joins parts with separators; if nothing but separators/whitespace remains,
  // there's no actual code (index.mjs/package.json) → no identity.
  if (!src || !src.replace(/[\s\u0000]+/g, '')) return null
  return createHash('sha256').update(src).digest('hex').slice(0, 40)
}

const markerPath = (jobName) => 'jobs/' + jobName + '.deployed'

/** Read the deploy-identity marker last stamped for this job (null if absent/stub). */
export async function readDeployedId (appFS, jobName) {
  try {
    const v = await appFS.readAppFile(markerPath(jobName), {})
    return (typeof v === 'string' && !isTextStub(v) && v.trim()) ? v.trim() : null
  } catch (e) { return null }
}

/** Stamp the deploy-identity marker after a successful (re)deploy. Non-fatal on failure. */
export async function writeDeployedId (appFS, jobName, id) {
  try { await appFS.writeToAppFiles(markerPath(jobName), String(id), {}) } catch (e) { /* non-fatal */ }
}

export default { loadJobCodeFromAppFS, loadJobIdentitySource, jobCodeIdentity, readDeployedId, writeDeployedId }
