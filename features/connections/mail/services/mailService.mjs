// freezr.info - Mail feature: service-layer orchestrator
// The single place that knows how to bridge: connection record → fresh token →
// the right mail connector → normalized result. Routes call into this; the
// connectors stay pure data-API wrappers.
//
// Token-refresh + 401-retry behavior lives in the shared callWithAutoRefresh
// helper at features/connections/shared/services/connectorCall.mjs, so
// contacts/calendar services get the identical handling for free.

import * as gmailConnector from '../../../../adapters/connections/mail/gmail.mjs'
import * as imapConnector from '../../../../adapters/connections/mail/imap.mjs'
import * as msgraphConnector from '../../../../adapters/connections/mail/msgraph.mjs'
import { callWithAutoRefresh } from '../../shared/services/connectorCall.mjs'
import { decryptResourceSensitiveFields } from '../../../account/services/resourceCrypto.mjs'

// Provider-to-connector dispatch. New providers register here.
const CONNECTORS = {
  google: gmailConnector,
  imap: imapConnector,
  microsoft: msgraphConnector
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

// Build the credentials object an IMAP connector call expects from a connection
// record. The connection arriving from mailContext is already decrypted, but we
// decrypt again (idempotent) so this is robust to any caller that passes a raw
// record. IMAP uses static app-password creds — there is no token to refresh.
const buildImapCredentials = (connection) => {
  const dec = decryptResourceSensitiveFields(connection)
  return { imap: dec.imap, smtp: dec.smtp, email: dec.account_email }
}

/**
 * Run a connector method, abstracting over how each provider supplies credentials:
 *   - OAuth providers (google): callWithAutoRefresh hands the connector a fresh
 *     access token (and retries once on 401). `callConnector(connector, accessToken)`.
 *   - IMAP: no OAuth/refresh — `callConnector(connector, { imap, smtp, email })`.
 *
 * `callConnector(connector, credential)` is where each service method names the
 * connector function and threads its own args; the credential's concrete type is
 * the only thing that differs per provider, and the connector treats it opaquely.
 */
const runConnector = ({ dsManager, freezrPrefs, userId, connection }, callConnector) => {
  const connector = getConnector(connection.provider)
  if (connection.provider === 'imap') {
    return callConnector(connector, buildImapCredentials(connection))
  }
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => callConnector(connector, oauth.accessToken)
  })
}

/**
 * List messages for a connection, paginated. Phase 2 shape: returns
 * { messages, nextPageToken }. The route caller passes `options` straight
 * through (limit, pageToken, labelIds, q).
 */
export const listMessages = async ({ dsManager, freezrPrefs, userId, connection, options = {} }) =>
  runConnector({ dsManager, freezrPrefs, userId, connection },
    (connector, cred) => connector.listMessages(cred, options))

/**
 * Get one full message.
 */
export const getMessage = async ({ dsManager, freezrPrefs, userId, connection, messageId }) =>
  runConnector({ dsManager, freezrPrefs, userId, connection },
    (connector, cred) => connector.getFullMessage(cred, messageId))

/**
 * Fetch a single attachment's raw bytes (filename/mimeType not returned —
 * the route caller pulls those from query params/known metadata).
 */
export const getAttachment = async ({ dsManager, freezrPrefs, userId, connection, messageId, attachmentId }) =>
  runConnector({ dsManager, freezrPrefs, userId, connection },
    (connector, cred) => connector.getAttachment(cred, messageId, attachmentId))

/**
 * Get the connected account's profile (email + mailbox stats).
 * Mostly used at connect time to populate connection.account_email.
 */
export const getAccountProfile = async ({ dsManager, freezrPrefs, userId, connection }) =>
  runConnector({ dsManager, freezrPrefs, userId, connection },
    (connector, cred) => connector.getAccountProfile(cred))

/**
 * List folders/labels for a connection. Returns [{ id, name, type }].
 */
export const listFolders = async ({ dsManager, freezrPrefs, userId, connection }) =>
  runConnector({ dsManager, freezrPrefs, userId, connection },
    (connector, cred) => connector.listFolders(cred))

/**
 * Structured search (text, from, to, since, before, labels, isRead,
 * hasAttachments). Returns the same shape as listMessages.
 */
export const searchMessages = async ({ dsManager, freezrPrefs, userId, connection, params = {} }) =>
  runConnector({ dsManager, freezrPrefs, userId, connection },
    (connector, cred) => connector.searchMessages(cred, params))

/**
 * Incremental sync. Returns { changes, nextToken, expired }.
 */
export const getNewer = async ({ dsManager, freezrPrefs, userId, connection, lastToken, limit }) =>
  runConnector({ dsManager, freezrPrefs, userId, connection },
    (connector, cred) => connector.getNewer(cred, lastToken, { limit }))

/**
 * Send a message. Returns { messageId, threadId }.
 */
export const sendMessage = async ({ dsManager, freezrPrefs, userId, connection, params }) =>
  runConnector({ dsManager, freezrPrefs, userId, connection },
    (connector, cred) => connector.sendMessage(cred, params))

/**
 * Create a draft. Returns { draftId, messageId, threadId }.
 */
export const createDraft = async ({ dsManager, freezrPrefs, userId, connection, params }) =>
  runConnector({ dsManager, freezrPrefs, userId, connection },
    (connector, cred) => connector.createDraft(cred, params))

/**
 * Mark a message read/unread. Returns { messageId, isRead }.
 */
export const markRead = async ({ dsManager, freezrPrefs, userId, connection, messageId, isRead }) =>
  runConnector({ dsManager, freezrPrefs, userId, connection },
    (connector, cred) => connector.markRead(cred, messageId, isRead))

/**
 * Move a message to a target folder/label.
 */
export const moveMessage = async ({ dsManager, freezrPrefs, userId, connection, messageId, targetFolder }) =>
  runConnector({ dsManager, freezrPrefs, userId, connection },
    (connector, cred) => connector.moveMessage(cred, messageId, targetFolder))

/**
 * Send a message to Trash (recoverable).
 */
export const trashMessage = async ({ dsManager, freezrPrefs, userId, connection, messageId }) =>
  runConnector({ dsManager, freezrPrefs, userId, connection },
    (connector, cred) => connector.trashMessage(cred, messageId))

/**
 * Permanently delete a message (skips Trash). Irreversible.
 */
export const deleteMessage = async ({ dsManager, freezrPrefs, userId, connection, messageId }) =>
  runConnector({ dsManager, freezrPrefs, userId, connection },
    (connector, cred) => connector.deleteMessage(cred, messageId))

export default {
  listMessages, getMessage, getAttachment, getAccountProfile,
  listFolders, searchMessages, getNewer,
  sendMessage, createDraft, markRead, moveMessage, trashMessage, deleteMessage
}
