// Validation for the app names the creator API is asked to act on.
//
// Creator handlers turn an app name straight into a folder path —
// users_freezr/<owner>/apps/<app_name>/… — via userDS.getorInitAppFS, which does no name
// validation of its own. The per-file traversal guard (endpathIsConfined, userDsMgr.mjs) builds its
// base FROM the app name, so an app name like "../../someoneelse" moves the base itself and passes
// that check. Every app name must therefore be validated before it reaches the file system.
//
// validAppName is the right bar: it is enforced at install, create and rename, so every installed
// app already satisfies it, and it rejects system apps, "..", "/" and "\". The creator UI never
// targets system apps (getUserApps / installed_apps_context filter them out).

import { isSystemApp, validAppName } from '../../../common/helpers/config.mjs'
import { sendFailure } from '../../../adapters/http/responses.mjs'

// Returns { ok: true } or { ok: false, status, error }.
export const assertTargetApp = (appName) => {
  if (typeof appName !== 'string' || !appName) return { ok: false, status: 400, error: 'App name is required' }
  if (isSystemApp(appName)) return { ok: false, status: 403, error: 'System apps are not available here' }
  if (!validAppName(appName)) return { ok: false, status: 400, error: 'Invalid app name' }
  return { ok: true }
}

// Request fields that name an app whose files a creator handler will touch.
const TARGET_APP_KEYS = ['app_name', 'target_app', 'source_app']

// Middleware for the /creatorapi routes: rejects any request whose query or JSON body names an
// invalid app in one of TARGET_APP_KEYS. An absent or empty field passes — handlers report
// "required" themselves. Multipart routes are NOT covered (multer parses their body after this
// runs), so those handlers must call assertTargetApp directly.
export const rejectInvalidTargetApps = (req, res, next) => {
  for (const source of [req.query, req.body]) {
    if (!source || typeof source !== 'object') continue
    for (const key of TARGET_APP_KEYS) {
      const value = source[key]
      if (value === undefined || value === null || value === '') continue
      const check = assertTargetApp(value)
      if (!check.ok) return sendFailure(res, check.error + ' (' + key + ')', 'rejectInvalidTargetApps', check.status)
    }
  }
  next()
}
