// freezr.info - Messaging feature: FEPS routes
// Mounted at /feps/connections/messaging by froutes/index.mjs.
//
// Endpoint catalogue:
//
// Reads (mounted with markReadOnly — granted use_messaging with scope 'read' is enough):
//   GET    /:connectionName/conversations
//          ?limit&cursor&types=channel,dm&includeArchived
//   GET    /:connectionName/conversations/:conversationId/messages
//          ?limit&cursor&oldest&latest
//   GET    /:connectionName/conversations/:conversationId/threads/:threadId
//          ?limit&cursor
//   GET    /:connectionName/conversations/:conversationId/newer
//          ?lastToken&limit                          (delta sync — first call seeds)
//   GET    /:connectionName/conversations/:conversationId/members
//          ?limit&cursor
//   GET    /:connectionName/users
//          ?limit&cursor  |  ?ids=U1,U2              (ids → batch resolve, no paging)
//   GET    /:connectionName/profile                  (connected account's identity)
//   GET    /:connectionName/changes
//          ?since=<ms>                               (socket-fed activity index —
//                                                     which conversations changed)
//
// Writes (no markReadOnly — messagingContext enforces granted.scopes.includes('write')
// AND connection.access.messaging === 'readwrite'):
//   POST   /:connectionName/conversations/:conversationId/send      body { text, threadId? }
//   POST   /:connectionName/conversations/:conversationId/markread  body { ts }
//   DELETE /:connectionName/conversations/:conversationId/messages/:messageId
//
// The type-agnostic listing endpoint (GET /feps/connections/accounts) lives one
// level up in features/connections/connectionsApiRoutes.mjs.
//
// All routes go through messagingContext — the single place that loads
// use_messaging perms and the decrypted connection record from :connectionName.

import { Router } from 'express'
import { createSetupGuard, createGetAppTokenInfoFromheaderForApi } from '../../../middleware/auth/basicAuth.mjs'
import { sendApiSuccess, sendFailure } from '../../../adapters/http/responses.mjs'
import { createMessagingContext, markReadOnly } from './middleware/messagingContext.mjs'
import {
  listConversations, getMessages, getThread, getNewer,
  getConversationMembers, getUsers, getUsersByIds, getAccountProfile,
  sendMessage, markRead, deleteMessage
} from './services/messagingService.mjs'
import { readChanges } from './services/activityIndex.mjs'

// Return the structured token_expired payload uniformly across routes.
const sendTokenExpired = (req, res) => res.status(401).json({
  success: false,
  error: 'token_expired',
  connectionName: req.params.connectionName,
  reauth_url: '/account/resources?focus=' + encodeURIComponent(req.params.connectionName)
})

const isTokenDead = (error) => error?.code === 'refresh_failed' || error?.code === 'no_refresh_token'

const parseLimit = (raw, max, fallback) => {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.floor(n)) : fallback
}

const strOrUndef = (v) => (typeof v === 'string' && v ? v : undefined)

export const createMessagingApiRoutes = ({ dsManager, freezrPrefs, freezrStatus }) => {
  const router = Router()

  const setupGuard = createSetupGuard(dsManager)
  // Any app token will do — messagingContext does the use_messaging check itself.
  const getAppTokenInfo = createGetAppTokenInfoFromheaderForApi(dsManager)
  const messagingContext = createMessagingContext(dsManager, freezrPrefs)

  /**
   * GET /feps/connections/messaging/:connectionName/conversations
   *   ?limit=N (1..200, default 100)
   *   &cursor=...                       (opaque cursor, optional)
   *   &types=channel,private_channel,group_dm,dm   (CSV, default all)
   *   &includeArchived=true|false       (default false)
   * Returns: { connectionName, conversations, nextCursor }
   */
  router.get('/:connectionName/conversations', setupGuard, getAppTokenInfo, markReadOnly, messagingContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.messagingConnection

      const types = typeof req.query.types === 'string' && req.query.types.length > 0
        ? req.query.types.split(',').map(s => s.trim()).filter(Boolean)
        : undefined

      const options = {
        limit: parseLimit(req.query.limit, 200, 100),
        cursor: strOrUndef(req.query.cursor),
        types,
        includeArchived: req.query.includeArchived === 'true' || req.query.includeArchived === '1'
      }

      const { conversations, nextCursor } = await listConversations({ dsManager, freezrPrefs, userId, connection, options })
      return sendApiSuccess(res, { connectionName: connection.connectionName, conversations, nextCursor })
    } catch (error) {
      if (isTokenDead(error)) return sendTokenExpired(req, res)
      console.error('❌ Error in messaging/:connectionName/conversations:', error)
      return sendFailure(res, error, 'messaging/listConversations', 500)
    }
  })

  /**
   * GET /feps/connections/messaging/:connectionName/conversations/:conversationId/messages
   *   ?limit=N (1..200, default 25)   — newest first
   *   &cursor=...                     (opaque cursor — pages OLDER)
   *   &oldest=<messageId>&latest=<messageId>
   * Returns: { connectionName, conversationId, messages, nextCursor }
   */
  router.get('/:connectionName/conversations/:conversationId/messages', setupGuard, getAppTokenInfo, markReadOnly, messagingContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.messagingConnection
      const conversationId = req.params.conversationId

      const args = {
        conversationId,
        limit: parseLimit(req.query.limit, 200, 25),
        cursor: strOrUndef(req.query.cursor),
        oldest: strOrUndef(req.query.oldest),
        latest: strOrUndef(req.query.latest)
      }

      const { messages, nextCursor } = await getMessages({ dsManager, freezrPrefs, userId, connection, args })
      return sendApiSuccess(res, { connectionName: connection.connectionName, conversationId, messages, nextCursor })
    } catch (error) {
      if (isTokenDead(error)) return sendTokenExpired(req, res)
      console.error('❌ Error in messaging/.../messages:', error)
      return sendFailure(res, error, 'messaging/getMessages', 500)
    }
  })

  /**
   * GET /feps/connections/messaging/:connectionName/conversations/:conversationId/threads/:threadId
   *   ?limit=N (1..200, default 50)&cursor=...
   * Returns: { connectionName, conversationId, threadId, messages, nextCursor }
   */
  router.get('/:connectionName/conversations/:conversationId/threads/:threadId', setupGuard, getAppTokenInfo, markReadOnly, messagingContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.messagingConnection
      const { conversationId, threadId } = req.params

      const args = {
        conversationId,
        threadId,
        limit: parseLimit(req.query.limit, 200, 50),
        cursor: strOrUndef(req.query.cursor)
      }

      const { messages, nextCursor } = await getThread({ dsManager, freezrPrefs, userId, connection, args })
      return sendApiSuccess(res, { connectionName: connection.connectionName, conversationId, threadId, messages, nextCursor })
    } catch (error) {
      if (isTokenDead(error)) return sendTokenExpired(req, res)
      console.error('❌ Error in messaging/.../threads/:threadId:', error)
      return sendFailure(res, error, 'messaging/getThread', 500)
    }
  })

  /**
   * GET /feps/connections/messaging/:connectionName/conversations/:conversationId/newer
   *   ?lastToken=...    (omit on first call — server returns a fresh nextToken)
   *   &limit=N          (1..500, default 100)
   * Returns: { connectionName, conversationId, messages, nextToken, expired }
   */
  router.get('/:connectionName/conversations/:conversationId/newer', setupGuard, getAppTokenInfo, markReadOnly, messagingContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.messagingConnection
      const conversationId = req.params.conversationId

      const args = {
        conversationId,
        lastToken: strOrUndef(req.query.lastToken),
        limit: parseLimit(req.query.limit, 500, 100)
      }

      const result = await getNewer({ dsManager, freezrPrefs, userId, connection, args })
      return sendApiSuccess(res, { connectionName: connection.connectionName, conversationId, ...result })
    } catch (error) {
      if (isTokenDead(error)) return sendTokenExpired(req, res)
      console.error('❌ Error in messaging/.../newer:', error)
      return sendFailure(res, error, 'messaging/getNewer', 500)
    }
  })

  /**
   * GET /feps/connections/messaging/:connectionName/conversations/:conversationId/members
   *   ?limit=N (1..200, default 100)&cursor=...
   * Returns: { connectionName, conversationId, memberIds, nextCursor }
   */
  router.get('/:connectionName/conversations/:conversationId/members', setupGuard, getAppTokenInfo, markReadOnly, messagingContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.messagingConnection
      const conversationId = req.params.conversationId

      const args = {
        conversationId,
        limit: parseLimit(req.query.limit, 200, 100),
        cursor: strOrUndef(req.query.cursor)
      }
      const { memberIds, nextCursor } = await getConversationMembers({ dsManager, freezrPrefs, userId, connection, args })
      return sendApiSuccess(res, { connectionName: connection.connectionName, conversationId, memberIds, nextCursor })
    } catch (error) {
      if (isTokenDead(error)) return sendTokenExpired(req, res)
      console.error('❌ Error in messaging/.../members:', error)
      return sendFailure(res, error, 'messaging/getConversationMembers', 500)
    }
  })

  /**
   * GET /feps/connections/messaging/:connectionName/profile
   * The connected account's identity — used by clients to tell the user's own
   * messages apart from everyone else's.
   * Returns: { connectionName, profile: { email, displayName, userId, teamId, teamName, teamUrl } }
   */
  router.get('/:connectionName/profile', setupGuard, getAppTokenInfo, markReadOnly, messagingContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.messagingConnection
      const profile = await getAccountProfile({ dsManager, freezrPrefs, userId, connection })
      return sendApiSuccess(res, { connectionName: connection.connectionName, profile })
    } catch (error) {
      if (isTokenDead(error)) return sendTokenExpired(req, res)
      console.error('❌ Error in messaging/:connectionName/profile:', error)
      return sendFailure(res, error, 'messaging/getAccountProfile', 500)
    }
  })

  /**
   * GET /feps/connections/messaging/:connectionName/changes
   *   ?since=<ms>   (default 0 — everything the index holds)
   *
   * The socket-fed activity index: which conversations changed after `since`,
   * plus per-conversation lists of edited/deleted message ids ({id, at},
   * filtered to at > since). Contains NO message content — apps follow up with
   * getNewer/getMessages using the user's own token, so the provider enforces
   * visibility.
   *
   * `complete: false` means the index cannot be trusted for the caller's
   * window (socket gap, retention horizon, or an overflowed change list) —
   * the remedy is a wider getNewer sweep. `gapSince` non-null means the
   * socket is DOWN right now.
   *
   * Returns: { connectionName, since, changes: [{ conversationId,
   *   lastActivityTs, lastEventAt, edited: [{id,at}], deleted: [{id,at}],
   *   changesOverflowed }], gapSince, complete, retentionMs }
   */
  router.get('/:connectionName/changes', setupGuard, getAppTokenInfo, markReadOnly, messagingContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.messagingConnection
      const since = Number(req.query.since)

      const result = await readChanges({
        dsManager,
        freezrPrefs,
        ownerId: userId,
        connectionName: connection.connectionName,
        since: Number.isFinite(since) && since > 0 ? since : 0
      })
      return sendApiSuccess(res, {
        connectionName: connection.connectionName,
        since: Number.isFinite(since) && since > 0 ? since : 0,
        ...result
      })
    } catch (error) {
      if (isTokenDead(error)) return sendTokenExpired(req, res)
      console.error('❌ Error in messaging/:connectionName/changes:', error)
      return sendFailure(res, error, 'messaging/getChanges', 500)
    }
  })

  /**
   * GET /feps/connections/messaging/:connectionName/users
   *   ?limit=N (1..200, default 200)&cursor=...   — paged directory listing
   *   ?ids=U1,U2,U3                               — batch resolve (no paging; max 100)
   * Returns: { connectionName, users, nextCursor }  (nextCursor null in ids mode)
   */
  router.get('/:connectionName/users', setupGuard, getAppTokenInfo, markReadOnly, messagingContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.messagingConnection

      if (typeof req.query.ids === 'string' && req.query.ids.length > 0) {
        const userIds = req.query.ids.split(',').map(s => s.trim()).filter(Boolean).slice(0, 100)
        const { users } = await getUsersByIds({ dsManager, freezrPrefs, userId, connection, userIds })
        return sendApiSuccess(res, { connectionName: connection.connectionName, users, nextCursor: null })
      }

      const options = {
        limit: parseLimit(req.query.limit, 200, 200),
        cursor: strOrUndef(req.query.cursor)
      }
      const { users, nextCursor } = await getUsers({ dsManager, freezrPrefs, userId, connection, options })
      return sendApiSuccess(res, { connectionName: connection.connectionName, users, nextCursor })
    } catch (error) {
      if (isTokenDead(error)) return sendTokenExpired(req, res)
      console.error('❌ Error in messaging/:connectionName/users:', error)
      return sendFailure(res, error, 'messaging/getUsers', 500)
    }
  })

  // ============================================
  // WRITE-SIDE ROUTES (no markReadOnly → messagingContext enforces write gate)
  // ============================================

  /**
   * POST /feps/connections/messaging/:connectionName/conversations/:conversationId/send
   *   body: { text: string, threadId?: string }
   * Returns: { connectionName, messageId, conversationId, threadParentId }
   */
  router.post('/:connectionName/conversations/:conversationId/send', setupGuard, getAppTokenInfo, messagingContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.messagingConnection
      const conversationId = req.params.conversationId
      const text = req.body?.text
      if (!text || typeof text !== 'string') {
        return sendFailure(res, 'sendMessage: text is required', 'messaging/sendMessage', 400)
      }
      const params = { conversationId, text, threadId: strOrUndef(req.body?.threadId) }
      const result = await sendMessage({ dsManager, freezrPrefs, userId, connection, params })
      return sendApiSuccess(res, { connectionName: connection.connectionName, ...result })
    } catch (error) {
      if (isTokenDead(error)) return sendTokenExpired(req, res)
      console.error('❌ Error in messaging/.../send:', error)
      return sendFailure(res, error, 'messaging/sendMessage', 500)
    }
  })

  /**
   * POST /feps/connections/messaging/:connectionName/conversations/:conversationId/markread
   *   body: { ts: string }   — message id to move the read cursor to
   * Returns: { connectionName, conversationId, ts }
   */
  router.post('/:connectionName/conversations/:conversationId/markread', setupGuard, getAppTokenInfo, messagingContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.messagingConnection
      const conversationId = req.params.conversationId
      const ts = req.body?.ts
      if (!ts || typeof ts !== 'string') {
        return sendFailure(res, 'markRead: ts (message id) is required', 'messaging/markRead', 400)
      }
      const result = await markRead({ dsManager, freezrPrefs, userId, connection, params: { conversationId, ts } })
      return sendApiSuccess(res, { connectionName: connection.connectionName, ...result })
    } catch (error) {
      if (isTokenDead(error)) return sendTokenExpired(req, res)
      console.error('❌ Error in messaging/.../markread:', error)
      return sendFailure(res, error, 'messaging/markRead', 500)
    }
  })

  /**
   * DELETE /feps/connections/messaging/:connectionName/conversations/:conversationId/messages/:messageId
   *
   * Providers generally only allow deleting the user's OWN messages. A refusal
   * on someone else's message comes back as 403 with `providerError` set (e.g.
   * Slack's `cant_delete_message`), so a caller deleting in bulk can report
   * which ones were skipped instead of treating it as a hard failure.
   *
   * Returns: { connectionName, conversationId, messageId }
   */
  router.delete('/:connectionName/conversations/:conversationId/messages/:messageId', setupGuard, getAppTokenInfo, messagingContext, async (req, res) => {
    try {
      const userId = res.locals.freezr.tokenInfo.requestor_id
      const connection = res.locals.freezr.messagingConnection
      const { conversationId, messageId } = req.params
      const result = await deleteMessage({ dsManager, freezrPrefs, userId, connection, params: { conversationId, ts: messageId } })
      return sendApiSuccess(res, { connectionName: connection.connectionName, ...result })
    } catch (error) {
      if (isTokenDead(error)) return sendTokenExpired(req, res)
      if (error?.slackError) {
        return res.status(403).json({
          success: false,
          error: error.message,
          providerError: error.slackError,
          conversationId: req.params.conversationId,
          messageId: req.params.messageId
        })
      }
      console.error('❌ Error in messaging DELETE .../messages/:messageId:', error)
      return sendFailure(res, error, 'messaging/deleteMessage', 500)
    }
  })

  return router
}

export default { createMessagingApiRoutes }
