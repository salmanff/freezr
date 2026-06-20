// freezr.info — Local job cache (users_jobs) materialization
//
// `users_jobs/<app>/<name>/` is a FAST LOCAL CACHE that the in-process runner dynamic-`import()`s — it
// is NOT the source of truth and is wiped on a server restart / Heroku redeploy. The permanent,
// ADMIN-APPROVED copy lives in the installing admin's appFS (written when the admin trusts the job).
//
// SECURITY: local = in-process = full host trust, so the cache must be rebuilt from the ADMIN's appFS
// (the reviewed copy), NEVER the end user's — otherwise a user could swap in un-reviewed code after
// trust. So both the trust action and the startup rebuild source from the admin's appFS.

import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join, dirname, resolve, sep } from 'node:path'
import { unzipSync } from 'fflate'
import { jobsBaseDir } from '../../../adapters/jobs/localJobRunner.mjs'
import { loadJobCodeFromAppFS } from './cloudJobSource.mjs'
import { listTrustedJobs } from './trustedJobService.mjs'
import { TRUSTED_JOBS_OAC } from '../../../common/helpers/config.mjs'
import { bjLog } from '../../../common/debug/consoleFlags.mjs'

/**
 * Materialize one job into the local users_jobs cache from `appFS` (the ADMIN's appFS — the approved
 * copy). Full bundle (zip) → unzip the whole folder incl. node_modules; single file → write index.mjs.
 * @returns {Promise<{ok:boolean, usedZip:boolean, files:number}>}
 */
export async function materializeJobToCache ({ appFS, app, name }) {
  const destDir = join(jobsBaseDir(), app, name)
  const destRoot = resolve(destDir)
  const code = await loadJobCodeFromAppFS(appFS, name)
  bjLog('🔎 TMPJOBLOG [MATERIALIZE] ' + app + '/' + name + ' from appFS → ' +
    (code ? (code.zip ? 'bundle .zip' : 'index.mjs source') : 'NO code') + ' → ' + destDir)

  if (code && code.zip) {
    const entries = unzipSync(code.zip)
    await rm(destDir, { recursive: true, force: true }).catch(() => {}) // clear any stale copy first
    let files = 0
    for (const [rel, bytes] of Object.entries(entries)) {
      if (rel.endsWith('/') || rel.startsWith('__MACOSX')) continue
      const abs = join(destDir, rel)
      if (!resolve(abs).startsWith(destRoot + sep)) continue // zip-slip guard
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, Buffer.from(bytes))
      files++
    }
    if (entries['index.mjs']) return { ok: true, usedZip: true, files }
    // zip without index.mjs → fall through to the single-file attempt
  }

  if (code && code.source) {
    await mkdir(destDir, { recursive: true })
    await writeFile(join(destDir, 'index.mjs'), code.source, 'utf8')
    return { ok: true, usedZip: false, files: 1 }
  }

  return { ok: false, usedZip: false, files: 0 }
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

export default { materializeJobToCache, rematerializeTrustedJobs }
