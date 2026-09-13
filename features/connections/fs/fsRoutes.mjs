// freezr.info - fs connections feature: FEPS routes
// Mounted at /feps/connections/fs by froutes/index.mjs.
//
// File-store access for apps holding a granted use_file_sys permission. Stores are
// connection records (services ['fs']) in info.freezr.account.resources — a local
// folder (admins on localhost servers only) or, in phase 3, a cloud drive.
//
// Reads (markReadOnly — scope 'read' is enough):
//   GET    /:connectionName/list?path=&depth=     one level (default) or a depth-
//                                                 limited tree of { name, type, size, mtimeMs }
//   GET    /:connectionName/stat?path=            one entry's metadata
//   GET    /:connectionName/read?path=&encoding=  file bytes (or base64-in-JSON)
//
// Writes (no markReadOnly — fsContext enforces granted.scopes includes 'write' AND
// connection.access.fs === 'readwrite'):
//   PUT    /:connectionName/write                 body { path, content | contentBase64, overwrite }
//   DELETE /:connectionName/remove?path=          remove one FILE (no folder removal)
//
// Every route goes through fsContext (perm + connection load; see fsContext.mjs) and
// localFsGate (the admin/localhost gate for local stores). Handlers read from
// res.locals.freezr and never touch permGiven themselves. Path confinement is
// fsService's job — handlers pass the app-supplied path through untouched.

import { Router } from 'express'
import path from 'node:path'
import { createSetupGuard, createGetAppTokenInfoFromheaderForApi } from '../../../middleware/auth/basicAuth.mjs'
import { isLoggedInAccountAppRequest } from '../../../middleware/permissions/permissionCheckers.mjs'
import { sendApiSuccess, sendFailure } from '../../../adapters/http/responses.mjs'
import { createFsContext, createLocalFsGate, markReadOnly, isLocalhostRequest } from './middleware/fsContext.mjs'
import { openFsHandle, resolveLocalRootOrThrow, MAX_TREE_DEPTH } from './services/fsService.mjs'

// Minimal extension map for the read route's Content-Type; anything else is
// octet-stream (apps get faithful bytes either way).
const MIME_BY_EXT = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.xml': 'application/xml', '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4'
}

// Same Content-Disposition sanitizer as mailRoutes' buildContentDisposition.
const buildContentDisposition = (rawName) => {
  const fallback = (rawName || 'file')
    .replace(/[\r\n"]/g, '')
    .replace(/[^\x20-\x7E]/g, '_')
    .slice(0, 200) || 'file'
  const utf8 = encodeURIComponent(rawName || 'file')
  return 'attachment; filename="' + fallback + '"; filename*=UTF-8\'\'' + utf8
}

const statusOf = (error, fallback = 500) =>
  (Number.isInteger(error?.status) && error.status >= 400 && error.status < 600) ? error.status : fallback

export const createFsApiRoutes = ({ dsManager, freezrPrefs }) => {
  const router = Router()

  const setupGuard = createSetupGuard(dsManager)
  // Any app token will do — fsContext does the use_file_sys check itself.
  const getAppTokenInfo = createGetAppTokenInfoFromheaderForApi(dsManager)
  const fsContext = createFsContext(dsManager, freezrPrefs)
  const localFsGate = createLocalFsGate(dsManager, freezrPrefs)

  /**
   * GET /feps/connections/fs/local_status?path=
   * For the Account Resources page (account/creator app + logged-in session only):
   * the local-store eligibility snapshot — mirrors the ClaudeLocal status endpoint —
   * plus, when ?path= is given, creation-time validation of a candidate rootPath
   * (exists, is a directory, does not overlap the freezr tree). Advisory only:
   * localFsGate re-checks everything at use time regardless of what this reports.
   */
  router.get('/local_status', setupGuard, getAppTokenInfo, isLoggedInAccountAppRequest, async (req, res) => {
    try {
      const out = {
        enabled: freezrPrefs?.local_fs_access_enabled === true,
        isAdmin: !!req.session?.logged_in_as_admin,
        systemFsIsLocal: dsManager?.systemEnvironment?.fsParams?.type === 'local',
        onLocalhost: isLocalhostRequest(req)
      }
      const candidate = typeof req.query.path === 'string' ? req.query.path.trim() : ''
      if (candidate) {
        // Path probing is for eligible admins only — don't let a non-admin account
        // session use this as a directory-existence oracle for the server's disk.
        if (!out.isAdmin || !out.systemFsIsLocal) {
          return sendFailure(res, 'Only admin users on local-fs servers can validate local store paths', 'fs/local_status', 403)
        }
        try {
          out.pathValid = true
          out.pathReal = resolveLocalRootOrThrow(candidate)
        } catch (e) {
          out.pathValid = false
          out.pathError = e.message
        }
      }
      return sendApiSuccess(res, out)
    } catch (error) {
      console.error('❌ Error in fs/local_status:', error)
      return sendFailure(res, error, 'fs/local_status', 500)
    }
  })

  /**
   * GET /feps/connections/fs/:connectionName/list?path=&depth=
   * depth 1 (default): { connectionName, path, entries, truncated }
   * depth 2..MAX_TREE_DEPTH: { connectionName, path, tree, count, truncated }
   */
  router.get('/:connectionName/list', setupGuard, getAppTokenInfo, markReadOnly, fsContext, localFsGate, async (req, res) => {
    try {
      const connection = res.locals.freezr.fsConnection
      const handle = await openFsHandle(connection)
      const relPath = typeof req.query.path === 'string' ? req.query.path : ''
      const rawDepth = Number(req.query.depth)
      const depth = Number.isFinite(rawDepth) && rawDepth > 1 ? Math.min(Math.floor(rawDepth), MAX_TREE_DEPTH) : 1

      if (depth === 1) {
        const { entries, truncated } = await handle.listDir(relPath, {})
        return sendApiSuccess(res, { connectionName: connection.connectionName, path: relPath, entries, truncated })
      }
      const { tree, count, truncated } = await handle.listTree(relPath, { depth })
      return sendApiSuccess(res, { connectionName: connection.connectionName, path: relPath, tree, count, truncated })
    } catch (error) {
      if (statusOf(error) === 500) console.error('❌ Error in fs/:connectionName/list:', error)
      return sendFailure(res, error, 'fs/list', statusOf(error))
    }
  })

  /**
   * GET /feps/connections/fs/:connectionName/stat?path=
   * Returns: { connectionName, path, entry: { name, type, size, mtimeMs } }
   */
  router.get('/:connectionName/stat', setupGuard, getAppTokenInfo, markReadOnly, fsContext, localFsGate, async (req, res) => {
    try {
      const connection = res.locals.freezr.fsConnection
      const handle = await openFsHandle(connection)
      const relPath = typeof req.query.path === 'string' ? req.query.path : ''
      const entry = await handle.statEntry(relPath)
      return sendApiSuccess(res, { connectionName: connection.connectionName, path: relPath, entry })
    } catch (error) {
      if (statusOf(error) === 500) console.error('❌ Error in fs/:connectionName/stat:', error)
      return sendFailure(res, error, 'fs/stat', statusOf(error))
    }
  })

  /**
   * GET /feps/connections/fs/:connectionName/read?path=&encoding=
   * Default: raw bytes with Content-Type / Content-Disposition headers.
   * ?encoding=base64: base64-in-JSON — for transports that corrupt raw binary
   * (same convention as the mail attachment route).
   */
  router.get('/:connectionName/read', setupGuard, getAppTokenInfo, markReadOnly, fsContext, localFsGate, async (req, res) => {
    try {
      const connection = res.locals.freezr.fsConnection
      const handle = await openFsHandle(connection)
      const relPath = typeof req.query.path === 'string' ? req.query.path : ''
      const { buffer, name } = await handle.readFile(relPath)
      const mimeType = MIME_BY_EXT[path.extname(name || '').toLowerCase()] || 'application/octet-stream'

      if (req.query.encoding === 'base64') {
        return sendApiSuccess(res, {
          connectionName: connection.connectionName,
          path: relPath,
          filename: name,
          mimeType,
          sizeBytes: buffer.length,
          contentBase64: buffer.toString('base64')
        })
      }

      // Raw-bytes response bypasses sendApiSuccess, so re-assert the permGiven
      // contract explicitly (fsContext set it; this guards handler-reordering bugs).
      if (!res.locals?.freezr?.permGiven) return sendFailure(res, 'permission not established', 'fs/read', 500)
      res.setHeader('Content-Type', mimeType)
      res.setHeader('Content-Length', buffer.length)
      res.setHeader('Content-Disposition', buildContentDisposition(name))
      res.setHeader('Cache-Control', 'private, max-age=0, no-store')
      return res.end(buffer)
    } catch (error) {
      if (statusOf(error) === 500) console.error('❌ Error in fs/:connectionName/read:', error)
      return sendFailure(res, error, 'fs/read', statusOf(error))
    }
  })

  /**
   * PUT /feps/connections/fs/:connectionName/write
   * body: { path, content?: string (utf8), contentBase64?: string, overwrite?: boolean }
   * Exactly one of content / contentBase64. Returns: { connectionName, written, path, size }
   */
  router.put('/:connectionName/write', setupGuard, getAppTokenInfo, fsContext, localFsGate, async (req, res) => {
    try {
      const connection = res.locals.freezr.fsConnection
      const body = req.body || {}
      const hasText = typeof body.content === 'string'
      const hasB64 = typeof body.contentBase64 === 'string'
      if (hasText === hasB64) {
        return sendFailure(res, 'write requires exactly one of content (utf8 string) or contentBase64', 'fs/write', 400)
      }
      const buffer = hasText ? Buffer.from(body.content, 'utf8') : Buffer.from(body.contentBase64, 'base64')
      const handle = await openFsHandle(connection)
      const result = await handle.writeFile(body.path, buffer, { overwrite: body.overwrite === true })
      return sendApiSuccess(res, { connectionName: connection.connectionName, ...result })
    } catch (error) {
      if (statusOf(error) === 500) console.error('❌ Error in fs/:connectionName/write:', error)
      return sendFailure(res, error, 'fs/write', statusOf(error))
    }
  })

  /**
   * DELETE /feps/connections/fs/:connectionName/remove?path=
   * Removes one FILE. Folder removal is deliberately unsupported.
   * Returns: { connectionName, removed, path }
   */
  router.delete('/:connectionName/remove', setupGuard, getAppTokenInfo, fsContext, localFsGate, async (req, res) => {
    try {
      const connection = res.locals.freezr.fsConnection
      const handle = await openFsHandle(connection)
      const relPath = typeof req.query.path === 'string' ? req.query.path : ''
      const result = await handle.removeFile(relPath)
      return sendApiSuccess(res, { connectionName: connection.connectionName, ...result })
    } catch (error) {
      if (statusOf(error) === 500) console.error('❌ Error in fs/:connectionName/remove:', error)
      return sendFailure(res, error, 'fs/remove', statusOf(error))
    }
  })

  return router
}

export default { createFsApiRoutes }
