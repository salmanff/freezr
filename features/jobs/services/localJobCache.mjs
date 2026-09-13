// freezr.info — Local job cache (users_jobs) materialization
//
// `users_jobs/<app>/<name>/` is a FAST LOCAL CACHE that the in-process runner dynamic-`import()`s — it
// is NOT the source of truth and is wiped on a server restart / Heroku redeploy. The permanent,
// ADMIN-APPROVED copy lives in the installing admin's appFS (written when the admin trusts the job).
//
// SECURITY: local = in-process = full host trust, so the cache must be rebuilt from the ADMIN's appFS
// (the reviewed copy), NEVER the end user's — otherwise a user could swap in un-reviewed code after
// trust. So both the trust action and the startup rebuild source from the admin's appFS.

import { mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises'
import { join, dirname, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'
import { jobsBaseDir } from '../../../adapters/jobs/localJobRunner.mjs'
import { loadJobCodeFromAppFS } from './cloudJobSource.mjs'
import { listTrustedJobs } from './trustedJobService.mjs'
import { TRUSTED_JOBS_OAC } from '../../../common/helpers/config.mjs'
import { bjLog } from '../../../common/debug/consoleFlags.mjs'

// Each materialize writes into a CONTENT-STAMPED dir — users_jobs/<app>/<name>@<stamp>/ — and flips
// a pointer file (users_jobs/<app>/<name>.current) to the new stamp. Node's ESM module cache is
// keyed by URL and has NO eviction API, so re-importing an edited job in place can never refresh
// its sibling modules: only index.mjs was cache-busted (?v=<mtime>), while its static imports
// (./reconcile.js, …) resolved to query-less URLs already in the cache — stale code with no error.
// A brand-new dir per content change gives EVERY file in the bundle a never-imported URL, so the
// whole import graph loads fresh. Same content → same stamp → same dir → warm cache reused.
const contentStamp = (bytesOrString) => createHash('sha256').update(bytesOrString).digest('hex').slice(0, 12)
const stampOk = (s) => typeof s === 'string' && /^[a-f0-9]{8,64}$/.test(s)

// Flip <name>.current to the new stamp, then GC: keep the new dir plus its immediate predecessor
// (a run that resolved the old path just before this materialize may still be mid-import from it;
// it gets collected on the NEXT materialize, so at most 2 versions ever accumulate). The legacy
// unversioned <name>/ dir and anything older go. Deleting dirs a running job already imported is
// safe — Node holds those modules in memory.
async function activateStamp (appDir, name, stamp) {
  let prev = null
  try { prev = (await readFile(join(appDir, name + '.current'), 'utf8')).trim() } catch (e) { /* first materialize */ }
  await writeFile(join(appDir, name + '.current'), stamp, 'utf8')
  const keep = new Set([name + '@' + stamp])
  if (stampOk(prev)) keep.add(name + '@' + prev)
  let entries = []
  try { entries = await readdir(appDir) } catch (e) { return }
  for (const n of entries) {
    if (n === name || (n.startsWith(name + '@') && !keep.has(n))) {
      await rm(join(appDir, n), { recursive: true, force: true }).catch(() => {})
    }
  }
}

/**
 * Materialize one job into the local users_jobs cache from `appFS` (the ADMIN's appFS — the approved
 * copy). Full bundle (zip) → unzip the whole folder incl. node_modules; single file → write index.mjs.
 * @returns {Promise<{ok:boolean, usedZip:boolean, files:number, stamp?:string}>}
 */
export async function materializeJobToCache ({ appFS, app, name }) {
  const appDir = join(jobsBaseDir(), app)
  const code = await loadJobCodeFromAppFS(appFS, name)
  bjLog('🔎 TMPJOBLOG [MATERIALIZE] ' + app + '/' + name + ' from appFS → ' +
    (code ? (code.zip ? 'bundle .zip' : 'index.mjs source') : 'NO code'))

  if (code && code.zip) {
    const stamp = contentStamp(code.zip)
    const destDir = join(appDir, name + '@' + stamp)
    const destRoot = resolve(destDir)
    const entries = unzipSync(code.zip)
    let files = 0
    for (const [rel, bytes] of Object.entries(entries)) {
      if (rel.endsWith('/') || rel.startsWith('__MACOSX')) continue
      const abs = join(destDir, rel)
      if (!resolve(abs).startsWith(destRoot + sep)) continue // zip-slip guard
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, Buffer.from(bytes))
      files++
    }
    if (entries['index.mjs']) {
      await activateStamp(appDir, name, stamp)
      bjLog('🔎 TMPJOBLOG [MATERIALIZE] ' + app + '/' + name + ' → ' + destDir)
      return { ok: true, usedZip: true, files, stamp }
    }
    // zip without index.mjs → discard the unusable dir, fall through to the single-file attempt
    await rm(destDir, { recursive: true, force: true }).catch(() => {})
  }

  if (code && code.source) {
    const stamp = contentStamp(code.source)
    const destDir = join(appDir, name + '@' + stamp)
    await mkdir(destDir, { recursive: true })
    await writeFile(join(destDir, 'index.mjs'), code.source, 'utf8')
    await activateStamp(appDir, name, stamp)
    bjLog('🔎 TMPJOBLOG [MATERIALIZE] ' + app + '/' + name + ' → ' + destDir)
    return { ok: true, usedZip: false, files: 1, stamp }
  }

  return { ok: false, usedZip: false, files: 0 }
}

/**
 * Remove EVERY local-cache trace of a job: the pointer file, all <name>@<stamp> dirs and the legacy
 * unversioned dir. Used by the admin un-trust flow. Best-effort — missing paths are fine.
 */
export async function removeLocalJobCache (app, name) {
  const appDir = join(jobsBaseDir(), app)
  let entries = []
  try { entries = await readdir(appDir) } catch (e) { return }
  for (const n of entries) {
    if (n === name || n === name + '.current' || n.startsWith(name + '@')) {
      await rm(join(appDir, n), { recursive: true, force: true }).catch(() => {})
    }
  }
}

/**
 * Startup "job install on restart": rebuild the users_jobs cache for EVERY trusted job from the
 * INSTALLING ADMIN's appFS. The cache is wiped on restart/redeploy; without this, admin-trusted LOCAL
 * jobs would 404 until re-trusted. Non-fatal per job. @returns {Promise<{rebuilt,failed,total}>}
 */
export async function rematerializeTrustedJobs ({ dsManager, freezrPrefs, flogger = null }) {
  const log = (m) => { if (flogger && flogger.info) flogger.info(m); else console.log(m) }
  let trusted = []
  try {
    const trustedJobsDb = await dsManager.getorInitDb(TRUSTED_JOBS_OAC, { freezrPrefs })
    trusted = await listTrustedJobs(trustedJobsDb) || []
  } catch (e) {
    log('🗂️  trusted-job cache rebuild skipped (no registry yet): ' + (e && e.message))
    return { rebuilt: 0, failed: 0, total: 0 }
  }
  if (!trusted.length) return { rebuilt: 0, failed: 0, total: 0 }

  let rebuilt = 0
  let failed = 0
  for (const t of trusted) {
    const adminId = t.installed_by
    if (!adminId || !t.app_name || !t.job_name) {
      failed++
      log('🗂️  ⚠️ cannot rebuild ' + (t.app_name || '?') + '/' + (t.job_name || '?') + ' — no installing admin recorded (re-trust to fix)')
      continue
    }
    try {
      const adminDS = await dsManager.getOrSetUserDS(adminId, { freezrPrefs })
      const appFS = await adminDS.getorInitAppFS(t.app_name, {})
      const r = await materializeJobToCache({ appFS, app: t.app_name, name: t.job_name })
      if (r.ok) rebuilt++
      else { failed++; log('🗂️  ⚠️ no code in admin ' + adminId + ' appFS for ' + t.app_name + '/' + t.job_name) }
    } catch (e) {
      failed++
      log('🗂️  ⚠️ rebuild failed for ' + t.app_name + '/' + t.job_name + ': ' + (e && e.message))
    }
  }
  log('🗂️  trusted-job local cache rebuilt: ' + rebuilt + ' ok, ' + failed + ' failed (of ' + trusted.length + ')')
  return { rebuilt, failed, total: trusted.length }
}

export default { materializeJobToCache, rematerializeTrustedJobs, removeLocalJobCache }
