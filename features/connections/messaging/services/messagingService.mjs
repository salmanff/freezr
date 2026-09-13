// freezr.info - Messaging feature: service-layer orchestrator
// The single place that knows how to bridge: connection record → fresh token →
// the right messaging connector → normalized result. Routes call into this; the
// connectors stay pure data-API wrappers.
//
// Token-refresh + 401-retry behavior lives in the shared callWithAutoRefresh
// helper at features/connections/shared/services/connectorCall.mjs — identical
// handling to mail/contacts/calendar. (Slack user tokens don't expire unless
// the Slack app enables token rotation; the connect flow stores a far-future
// expiry in that case so the refresh path never triggers.)

import * as slackConnector from '../../../../adapters/connections/messaging/slack.mjs'
import { callWithAutoRefresh } from '../../shared/services/connectorCall.mjs'

// Provider-to-connector dispatch. New messaging providers register here.
const CONNECTORS = {
  slack: slackConnector
}

const getConnector = (provider) => {
  const c = CONNECTORS[provider]
  if (!c) {
    const err = new Error('No messaging connector for provider: ' + provider)
    err.code = 'no_connector'
    throw err
  }
  return c
}

// All current messaging providers are OAuth-based; go through the shared
// fresh-token + 401-retry wrapper. (A future non-OAuth provider would branch
// here, the way mailService special-cases IMAP.)
const runConnector = ({ dsManager, freezrPrefs, userId, connection }, callConnector) => {
  const connector = getConnector(connection.provider)
  return callWithAutoRefresh({
    dsManager, freezrPrefs, userId, connection,
    fn: (oauth) => callConnector(connector, oauth.accessToken)
  })
}

/**
 * List conversations (channels / private channels / group DMs / DMs) the
 * connected user is a member of. Returns { conversations, nextCursor }.
 */
export const listConversations = async ({ dsManager, freezrPrefs, userId, connection, options = {} }) =>
  runConnector({ dsManager, freezrPrefs, userId, connection },
    (connector, cred) => connector.listConversations(cred, options))

/**
 * Fetch messages from one conversation, newest first, paginated.
 * Returns { messages, nextCursor }.
 */
export const getMessages = async ({ dsManager, freezrPrefs, userId, connection, args = {} }) =>
  runConnector({ dsManager, freezrPrefs, userId, connection },
    (connector, cred) => connector.getMessages(cred, args))

/**
 * Fetch a thread (parent + replies, oldest first). Returns { messages, nextCursor }.
 */
export const getThread = async ({ dsManager, freezrPrefs, userId, connection, args = {} }) =>
  runConnector({ dsManager, freezrPrefs, userId, connection },
    (connector, cred) => connector.getThread(cred, args))

/**
 * Incremental sync for one conversation. Returns { messages, nextToken, expired }.
 */
export const getNewer = async ({ dsManager, freezrPrefs, userId, connection, args = {} }) =>
  runConnector({ dsManager, freezrPrefs, userId, connection },
    (connector, cred) => connector.getNewer(cred, args))

/**
 * List one conversation's member ids. Returns { memberIds, nextCursor }.
 */
export const getConversationMembers = async ({ dsManager, freezrPrefs, userId, connection, args = {} }) =>
  runConnector({ dsManager, freezrPrefs, userId, connection },
    (connector, cred) => connector.getConversationMembers(cred, args))

/**
 * List workspace users (paginated) — for resolving sender ids to names.
 * Returns { users, nextCursor }.
 */
export const getUsers = async ({ dsManager, freezrPrefs, userId, connection, options = {} }) =>
  runConnector({ dsManager, freezrPrefs, userId, connection },
    (connector, cred) => connector.getUsers(cred, options))

/**
 * Batch-resolve specific user ids. Returns { users }.
 */
export const getUsersByIds = async ({ dsManager, freezrPrefs, userId, connection, userIds = [] }) =>
  runConnector({ dsManager, freezrPrefs, userId, connection },
    (connector, cred) => connector.getUsersByIds(cred, userIds))

/**
 * The connected account's identity. Returns { email, displayName, userId, teamId, teamName, teamUrl }.
 */
export const getAccountProfile = async ({ dsManager, freezrPrefs, userId, connection }) =>
  runConnector({ dsManager, freezrPrefs, userId, connection },
    (connector, cred) => connector.getAccountProfile(cred))

/**
 * Send a message (optionally into a thread). Returns { messageId, conversationId, threadParentId }.
 */
export const sendMessage = async ({ dsManager, freezrPrefs, userId, connection, params = {} }) =>
  runConnector({ dsManager, freezrPrefs, userId, connection },
    (connector, cred) => connector.sendMessage(cred, params))

/**
 * Move the read cursor in a conversation. Returns { conversationId, ts }.
 */
export const markRead = async ({ dsManager, freezrPrefs, userId, connection, params = {} }) =>
  runConnector({ dsManager, freezrPrefs, userId, connection },
    (connector, cred) => connector.markRead(cred, params))

/**
 * Delete one message. Returns { conversationId, messageId }.
 */
export const deleteMessage = async ({ dsManager, freezrPrefs, userId, connection, params = {} }) =>
  runConnector({ dsManager, freezrPrefs, userId, connection },
    (connector, cred) => connector.deleteMessage(cred, params))

export default {
  listConversations, getMessages, getThread, getNewer,
  getConversationMembers, getUsers, getUsersByIds, getAccountProfile,
  sendMessage, markRead, deleteMessage
}
