// freezr.info - Mail feature: service-layer orchestrator
// The single place that knows how to bridge: connection record → fresh token →
// the right mail connector → normalized result. Routes call into this; the
// connectors stay pure data-API wrappers.
//
// Token-refresh + 401-retry behavior lives in the shared callWithAutoRefresh
// helper at features/connections/shared/services/connectorCall.mjs, so
// contacts/calendar services get the identical handling for free.

import * as gmailConnector from '../../../../adapters/connections/gmail.mjs'
import { callWithAutoRefresh } from '../../shared/services/connectorCall.mjs'

// Provider-to-connector dispatch. New providers (Microsoft Graph in Phase 2, IMAP in Phase 4)
// register here.
const CONNECTORS = {
  google: gmailConnector
}

const getConnector = (provider) => {
  const c = CONNECTORS[provider]
  if (!c) {
    const err = new Error('No mail connector for provider: ' + provider)
    err.code = 'no_connector'
    throw err
  }
  return c
}

/**
 * List messages for a connection, paginated. Phase 2 shape: returns
 * { messages, nextPageToken }. The route caller passes `options` straight
 * through (limit, pageToken, labelIds, q).
 */
export const listMessages = async ({ dsManager, freezrPrefs, userId, connection, options = {} }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.listMessages(oauth.accessToken, options)
  })
}

/**
 * Get one full message.
 */
export const getMessage = async ({ dsManager, freezrPrefs, userId, connection, messageId }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.getFullMessage(oauth.accessToken, messageId)
  })
}

/**
 * Fetch a single attachment's raw bytes (filename/mimeType not returned —
 * the route caller pulls those from query params/known metadata).
 */
export const getAttachment = async ({ dsManager, freezrPrefs, userId, connection, messageId, attachmentId }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.getAttachment(oauth.accessToken, messageId, attachmentId)
  })
}

/**
 * Get the connected account's profile (email + mailbox stats).
 * Mostly used at connect time to populate connection.account_email.
 */
export const getAccountProfile = async ({ dsManager, freezrPrefs, userId, connection }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.getAccountProfile(oauth.accessToken)
  })
}

/**
 * List folders/labels for a connection. Returns [{ id, name, type }].
 */
export const listFolders = async ({ dsManager, freezrPrefs, userId, connection }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.listFolders(oauth.accessToken)
  })
}

/**
 * Structured search (text, from, to, since, before, labels, isRead,
 * hasAttachments). Returns the same shape as listMessages.
 */
export const searchMessages = async ({ dsManager, freezrPrefs, userId, connection, params = {} }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.searchMessages(oauth.accessToken, params)
  })
}

/**
 * Incremental sync. Returns { changes, nextToken, expired }.
 */
export const getNewer = async ({ dsManager, freezrPrefs, userId, connection, lastToken, limit }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.getNewer(oauth.accessToken, lastToken, { limit })
  })
}

/**
 * Send a message. Returns { messageId, threadId }.
 */
export const sendMessage = async ({ dsManager, freezrPrefs, userId, connection, params }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.sendMessage(oauth.accessToken, params)
  })
}

/**
 * Create a draft. Returns { draftId, messageId, threadId }.
 */
export const createDraft = async ({ dsManager, freezrPrefs, userId, connection, params }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.createDraft(oauth.accessToken, params)
  })
}

/**
 * Mark a message read/unread. Returns { messageId, isRead }.
 */
export const markRead = async ({ dsManager, freezrPrefs, userId, connection, messageId, isRead }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.markRead(oauth.accessToken, messageId, isRead)
  })
}

/**
 * Move a message to a target folder/label.
 */
export const moveMessage = async ({ dsManager, freezrPrefs, userId, connection, messageId, targetFolder }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.moveMessage(oauth.accessToken, messageId, targetFolder)
  })
}

/**
 * Send a message to Trash (recoverable).
 */
export const trashMessage = async ({ dsManager, freezrPrefs, userId, connection, messageId }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.trashMessage(oauth.accessToken, messageId)
  })
}

/**
 * Permanently delete a message (skips Trash). Irreversible.
 */
export const deleteMessage = async ({ dsManager, freezrPrefs, userId, connection, messageId }) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => connector.deleteMessage(oauth.accessToken, messageId)
  })
}

export default {
  listMessages, getMessage, getAttachment, getAccountProfile,
  listFolders, searchMessages, getNewer,
  sendMessage, createDraft, markRead, moveMessage, trashMessage, deleteMessage
}
