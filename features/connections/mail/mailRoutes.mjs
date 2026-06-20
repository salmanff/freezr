// freezr.info - Mail feature: FEPS routes
// Mounted at /feps/connections/mail by froutes/index.mjs.
//
// Endpoint catalogue:
//
// Reads (mounted with markReadOnly — granted use_mail with scope 'read' is enough):
//   GET    /:connectionName/messages
//          ?limit&pageToken&labelIds=A,B&q&includeAttachments
//   GET    /:connectionName/messages/:messageId
//   GET    /:connectionName/messages/:messageId/attachments/:attachmentId
//          ?filename&mimeType                       (raw binary)
//   GET    /:connectionName/folders
//   GET    /:connectionName/search
//          ?text&from&to&since&before&labels=A,B&isRead&hasAttachments&limit&pageToken
//   GET    /:connectionName/newer
//          ?lastToken&limit                          (delta sync — first call seeds)
//
// Writes (no markReadOnly — mailContext enforces granted.scopes.includes('write')
// AND connection.access.mail === 'readwrite'):
//   POST   /:connectionName/messages/send
//   POST   /:connectionName/drafts
//   POST   /:connectionName/messages/:messageId/markread       body { isRead }
//   POST   /:connectionName/messages/:messageId/move           body { targetFolder }
//   POST   /:connectionName/messages/:messageId/trash
//   DELETE /:connectionName/messages/:messageId               (permanent delete)
//
// The type-agnostic listing endpoint (GET /feps/connections/accounts) lives one
// level up in features/connections/connectionsApiRoutes.mjs — it crosses all
// services, so it doesn't belong inside any one service folder.
//
// All routes go through mailContext, which is the single place that loads use_mail
// perms (DB + system shortcuts) and loads the decrypted connection record from
// :connectionName. Route handlers read from res.locals.freezr — they don't do
// their own perm queries and they don't touch permGiven.

import { Router } from 'express'
import { createSetupGuard, createGetAppTokenInfoFromheaderForApi } from '../../../middleware/auth/basicAuth.mjs'
import { sendApiSuccess, sendFailure } from '../../../adapters/http/responses.mjs'
import { createMailContext, markReadOnly } from './middleware/mailContext.mjs'
import {
  listMessages, getMessage, getAttachment,
  listFolders, searchMessages, getNewer,
  sendMessage, createDraft, markRead, moveMessage, trashMessage, deleteMessage
} from './services/mailService.mjs'

// Return the structured token_expired payload uniformly across routes.
const sendTokenExpired = (req, res) => res.status(401).json({
  success: false,
  error: 'token_expired',
  connectionName: req.params.connectionName,
  reauth_url: '/account/resources?focus=' + encodeURIComponent(req.params.connectionName)
})

// Sanitize a filename for HTTP Content-Disposition. ASCII-safe; we also emit
// a `filename*=UTF-8''<percent-encoded>` companion for unicode safety per RFC 5987.
const buildContentDisposition = (rawName) => {
  const fallback = (rawName || 'attachment')
    .replace(/[\r\n"]/g, '')
    .replace(/[^\x20-\x7E]/g, '_') // strip non-ASCII for the basic param
    .slice(0, 200) || 'attachment'
  const utf8 = encodeURIComponent(rawName || 'attachment')
  return 'attachment; filename="' + fallback + '"; filename*=UTF-8\'\'' + utf8
}

export const createMailApiRoutes = ({ dsManager, freezrPrefs, freezrStatus }) => {
  const router = Router()

  const setupGuard = createSetupGuard(dsManager)
  // Any app token will do — mailContext does the use_mail check itself.
  const getAppTokenInfo = createGetAppTokenInfoFromheaderForApi(dsManager)
  const mailContext = createMailContext(dsManager, freezrPrefs)

  /**
   * GET /feps/connections/mail/:connectionName/messages
   *   ?limit=N (1..100, default 20)
   *   &pageToken=...     (opaque cursor, optional)
   *   &labelIds=A,B,C    (CSV, default = all labels — empty/missing = no filter)
   *   &q=...             (provider-specific search; Gmail syntax today)
   *
   * Returns: { connectionName, messages: [...], nextPageToken: string|null }
   */
  router.get('/:connectionName/messages', setupGuard, getAppTokenInfo, markReadOnly, mailContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.mailConnection

      const rawLimit = Number(req.query.limit)
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(100, Math.floor(rawLimit)) : 20

      const labelIds = typeof req.query.labelIds === 'string' && req.query.labelIds.length > 0
        ? req.query.labelIds.split(',').map(s => s.trim()).filter(Boolean)
        : []

      const includeAttachments = req.query.includeAttachments === 'true' || req.query.includeAttachments === '1'

      const options = {
        limit,
        pageToken: typeof req.query.pageToken === 'string' && req.query.pageToken ? req.query.pageToken : undefined,
        labelIds,
        q: typeof req.query.q === 'string' && req.query.q ? req.query.q : undefined,
        includeAttachments
      }

      const { messages, nextPageToken } = await listMessages({ dsManager, freezrPrefs, userId, connection, options })
      return sendApiSuccess(res, { connectionName: connection.connectionName, messages, nextPageToken })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in mail/:connectionName/messages:', error)
      return sendFailure(res, error, 'mail/messages', 500)
    }
  })

  /**
   * GET /feps/connections/mail/:connectionName/messages/:messageId
   * Returns one full message (with bodies + attachment metadata).
   */
  router.get('/:connectionName/messages/:messageId', setupGuard, getAppTokenInfo, markReadOnly, mailContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.mailConnection
      const messageId = req.params.messageId

      const message = await getMessage({ dsManager, freezrPrefs, userId, connection, messageId })
      return sendApiSuccess(res, { connectionName: connection.connectionName, message })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in mail/:connectionName/messages/:messageId:', error)
      return sendFailure(res, error, 'mail/getMessage', 500)
    }
  })

  /**
   * GET /feps/connections/mail/:connectionName/messages/:messageId/attachments/:attachmentId
   *   ?filename=...   URL-encoded; used for Content-Disposition
   *   &mimeType=...   optional; falls back to application/octet-stream
   *
   * Returns: raw binary, with Content-Type / Content-Length / Content-Disposition headers.
   */
  router.get('/:connectionName/messages/:messageId/attachments/:attachmentId',
    setupGuard, getAppTokenInfo, markReadOnly, mailContext, async (req, res) => {
      try {
        const userId = res.locals.freezr.tokenInfo.requestor_id
        const connection = res.locals.freezr.mailConnection
        const { messageId, attachmentId } = req.params

        const filenameHint = typeof req.query.filename === 'string' && req.query.filename
          ? req.query.filename
          : 'attachment-' + attachmentId
        const mimeType = typeof req.query.mimeType === 'string' && req.query.mimeType
          ? req.query.mimeType
          : 'application/octet-stream'

        const { buffer } = await getAttachment({ dsManager, freezrPrefs, userId, connection, messageId, attachmentId })

        res.setHeader('Content-Type', mimeType)
        res.setHeader('Content-Length', buffer.length)
        res.setHeader('Content-Disposition', buildContentDisposition(filenameHint))
        res.setHeader('Cache-Control', 'private, max-age=0, no-store')
        return res.end(buffer)
      } catch (error) {
        if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
          return sendTokenExpired(req, res)
        }
        console.error('❌ Error in mail/.../attachments/:attachmentId:', error)
        return sendFailure(res, error, 'mail/getAttachment', 500)
      }
    })

  // ============================================
  // READ-SIDE ROUTES (markReadOnly — no write scope required)
  // ============================================

  /**
   * GET /feps/connections/mail/:connectionName/folders
   * Returns: { connectionName, folders: [{ id, name, type }] }
   */
  router.get('/:connectionName/folders', setupGuard, getAppTokenInfo, markReadOnly, mailContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.mailConnection
      const folders = await listFolders({ dsManager, freezrPrefs, userId, connection })
      return sendApiSuccess(res, { connectionName: connection.connectionName, folders })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in mail/:connectionName/folders:', error)
      return sendFailure(res, error, 'mail/listFolders', 500)
    }
  })

  /**
   * GET /feps/connections/mail/:connectionName/search
   *   ?text=...&from=...&to=...&since=<ms>&before=<ms>
   *   &labels=A,B&isRead=true|false&hasAttachments=true|false
   *   &limit=N&pageToken=...
   * Returns: { connectionName, messages, nextPageToken }
   */
  router.get('/:connectionName/search', setupGuard, getAppTokenInfo, markReadOnly, mailContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.mailConnection

      const rawLimit = Number(req.query.limit)
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(100, Math.floor(rawLimit)) : 20

      const labels = typeof req.query.labels === 'string' && req.query.labels.length > 0
        ? req.query.labels.split(',').map(s => s.trim()).filter(Boolean)
        : undefined

      const parseBool = (v) => v === 'true' ? true : (v === 'false' ? false : undefined)
      const parseNum = (v) => {
        const n = Number(v)
        return Number.isFinite(n) ? n : undefined
      }

      const params = {
        text: typeof req.query.text === 'string' && req.query.text ? req.query.text : undefined,
        from: typeof req.query.from === 'string' && req.query.from ? req.query.from : undefined,
        to: typeof req.query.to === 'string' && req.query.to ? req.query.to : undefined,
        since: parseNum(req.query.since),
        before: parseNum(req.query.before),
        labels,
        isRead: parseBool(req.query.isRead),
        hasAttachments: parseBool(req.query.hasAttachments),
        limit,
        pageToken: typeof req.query.pageToken === 'string' && req.query.pageToken ? req.query.pageToken : undefined
      }

      const { messages, nextPageToken } = await searchMessages({ dsManager, freezrPrefs, userId, connection, params })
      return sendApiSuccess(res, { connectionName: connection.connectionName, messages, nextPageToken })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in mail/:connectionName/search:', error)
      return sendFailure(res, error, 'mail/searchMessages', 500)
    }
  })

  /**
   * GET /feps/connections/mail/:connectionName/newer
   *   ?lastToken=...    (omit on first call — server returns a fresh nextToken)
   *   &limit=N          (1..500, default 100)
   * Returns: { connectionName, changes, nextToken, expired }
   * `expired: true` → caller must do a full re-fetch via listMessages and seed.
   */
  router.get('/:connectionName/newer', setupGuard, getAppTokenInfo, markReadOnly, mailContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.mailConnection

      const lastToken = typeof req.query.lastToken === 'string' && req.query.lastToken ? req.query.lastToken : undefined
      const rawLimit = Number(req.query.limit)
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(500, Math.floor(rawLimit)) : undefined

      const result = await getNewer({ dsManager, freezrPrefs, userId, connection, lastToken, limit })
      return sendApiSuccess(res, { connectionName: connection.connectionName, ...result })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in mail/:connectionName/newer:', error)
      return sendFailure(res, error, 'mail/getNewer', 500)
    }
  })

  // ============================================
  // WRITE-SIDE ROUTES (no markReadOnly → mailContext enforces write gate)
  //
  // mailContext (fail-closed default) requires BOTH:
  //   - granted.scopes includes 'write' on the use_mail permission, AND
  //   - connection.access.mail === 'readwrite' on the connection record.
  // ============================================

  /**
   * POST /feps/connections/mail/:connectionName/messages/send
   *   body: { to, cc, bcc, subject, bodyText, bodyHtml, attachments, inReplyTo, threadId, references }
   * Returns: { messageId, threadId }
   */
  router.post('/:connectionName/messages/send', setupGuard, getAppTokenInfo, mailContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.mailConnection
      const params = req.body || {}
      if (!params.to) {
        return sendFailure(res, 'sendMessage: at least one recipient (to) is required', 'mail/sendMessage', 400)
      }
      const result = await sendMessage({ dsManager, freezrPrefs, userId, connection, params })
      return sendApiSuccess(res, { connectionName: connection.connectionName, ...result })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in mail/:connectionName/messages/send:', error)
      return sendFailure(res, error, 'mail/sendMessage', 500)
    }
  })

  /**
   * POST /feps/connections/mail/:connectionName/drafts
   *   body: same shape as send
   * Returns: { draftId, messageId, threadId }
   */
  router.post('/:connectionName/drafts', setupGuard, getAppTokenInfo, mailContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.mailConnection
      const params = req.body || {}
      const result = await createDraft({ dsManager, freezrPrefs, userId, connection, params })
      return sendApiSuccess(res, { connectionName: connection.connectionName, ...result })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in mail/:connectionName/drafts:', error)
      return sendFailure(res, error, 'mail/createDraft', 500)
    }
  })

  /**
   * POST /feps/connections/mail/:connectionName/messages/:messageId/markread
   *   body: { isRead: boolean }   (defaults true if missing)
   * Returns: { messageId, isRead }
   */
  router.post('/:connectionName/messages/:messageId/markread', setupGuard, getAppTokenInfo, mailContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.mailConnection
      const { messageId } = req.params
      const isRead = req.body?.isRead !== false
      const result = await markRead({ dsManager, freezrPrefs, userId, connection, messageId, isRead })
      return sendApiSuccess(res, { connectionName: connection.connectionName, ...result })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in mail/.../markread:', error)
      return sendFailure(res, error, 'mail/markRead', 500)
    }
  })

  /**
   * POST /feps/connections/mail/:connectionName/messages/:messageId/move
   *   body: { targetFolder: string }
   * Returns: { messageId }
   */
  router.post('/:connectionName/messages/:messageId/move', setupGuard, getAppTokenInfo, mailContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.mailConnection
      const { messageId } = req.params
      const targetFolder = req.body?.targetFolder
      if (!targetFolder) {
        return sendFailure(res, 'moveMessage: targetFolder is required', 'mail/moveMessage', 400)
      }
      const result = await moveMessage({ dsManager, freezrPrefs, userId, connection, messageId, targetFolder })
      return sendApiSuccess(res, { connectionName: connection.connectionName, ...result })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in mail/.../move:', error)
      return sendFailure(res, error, 'mail/moveMessage', 500)
    }
  })

  /**
   * POST /feps/connections/mail/:connectionName/messages/:messageId/trash
   * Returns: { messageId }
   */
  router.post('/:connectionName/messages/:messageId/trash', setupGuard, getAppTokenInfo, mailContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.mailConnection
      const { messageId } = req.params
      const result = await trashMessage({ dsManager, freezrPrefs, userId, connection, messageId })
      return sendApiSuccess(res, { connectionName: connection.connectionName, ...result })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in mail/.../trash:', error)
      return sendFailure(res, error, 'mail/trashMessage', 500)
    }
  })

  /**
   * DELETE /feps/connections/mail/:connectionName/messages/:messageId
   * Permanently delete (skips Trash). Returns: { messageId }
   */
  router.delete('/:connectionName/messages/:messageId', setupGuard, getAppTokenInfo, mailContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.mailConnection
      const { messageId } = req.params
      const result = await deleteMessage({ dsManager, freezrPrefs, userId, connection, messageId })
      return sendApiSuccess(res, { connectionName: connection.connectionName, ...result })
    } catch (error) {
      if (error?.code === 'refresh_failed' || error?.code === 'no_refresh_token') {
        return sendTokenExpired(req, res)
      }
      console.error('❌ Error in mail DELETE messages/:messageId:', error)
      return sendFailure(res, error, 'mail/deleteMessage', 500)
    }
  })

  return router
}

export default { createMailApiRoutes }
