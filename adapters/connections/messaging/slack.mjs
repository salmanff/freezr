// freezr.info - Messaging connector: Slack
// Pure data-API wrapper for the Slack Web API. No OAuth flow, no persistence, no
// resource record — takes an already-valid user access token (xoxp) and returns
// NORMALIZED data so apps see the same shape regardless of messaging provider.
//
// Token type matters: freezr Slack connections use USER tokens (xoxp), not bot
// tokens. A user token sees what the user sees (all channels they're in, their
// DMs), can send as the user, and is the only token type conversations.mark
// (mark-as-read) accepts.
//
// Rate-limit contract (see adapters/connections/_shared.mjs for full text):
//   - Per-item fan-out is capped via runConcurrent(items, MAX_PARALLEL, fn).
//   - Every Slack HTTP call goes through fetchWithRetry (retries 429/5xx/network,
//     honors Retry-After — Slack sends Retry-After on 429).
//   - Slack also signals errors as HTTP 200 + { ok: false, error } — slackFetch
//     converts those to Error objects with `.status` mapped so the shared
//     401-retry / token_expired cascade works unchanged.
//
// Normalized shapes (the cross-provider messaging contract — a future Teams/
// Matrix/Discord connector must return these same shapes):
//
//   listConversations -> {
//     conversations: [{
//       id,                  // provider conversation id (Slack: C…/G…/D…)
//       name,                // human name; null for DMs (resolve via getUsers)
//       type,                // 'channel' | 'private_channel' | 'group_dm' | 'dm'
//       isMember,            // the connected user is a member
//       isArchived,
//       topic, purpose,      // strings ('' when unset)
//       memberCount,         // number|null
//       counterpartUserId    // DMs only: the other user's id, else null
//     }],
//     nextCursor             // string|null — opaque cursor; null when no more pages
//   }
//
//   getMessages / getThread / getNewer -> {
//     messages: [{
//       id,                  // provider message id (Slack: the ts string — needed
//                            // verbatim for threads / markRead, so never parsed away)
//       conversationId,
//       threadParentId,      // null for top-level; parent message id for replies
//       sender: { id, type },// type 'user' | 'bot'; resolve names via getUsers
//       sentAt,              // ms timestamp (number)
//       text,                // raw provider markup (Slack mrkdwn: <@U…>, <#C…|name>…)
//       replyCount,          // number of thread replies (top-level messages only)
//       edited,              // boolean
//       subtype,             // provider subtype ('channel_join', …) or null
//       reactions: [{ name, count }],
//       files: [{ id, filename, mimeType, sizeBytes }]
//     }],
//     nextCursor | nextToken // see each fn
//   }
//
//   getUsers -> { users: [{ id, name, displayName, realName, email, isBot,
//                           deleted, avatar }], nextCursor }
//
//   getAccountProfile -> { email, displayName, userId, teamId, teamName, teamUrl }
//
//   sendMessage -> { messageId, conversationId, threadParentId }
//   markRead    -> { conversationId, ts }

import { runConcurrent, fetchWithRetry } from '../_shared.mjs'

const SLACK_BASE = 'https://slack.com/api'

// Conservative cap for per-item fan-out (Slack Web API tiers are per-method;
// history-class methods on internal apps allow ~50/min — see file header).
const MAX_PARALLEL = 3

// Slack signals auth/permission problems inside a 200 body. Map the ones that
// mean "this token is dead" to 401 so callWithAutoRefresh → token_expired
// behaves exactly as with OAuth mail providers.
const AUTH_DEAD_ERRORS = new Set([
  'not_authed', 'invalid_auth', 'token_revoked', 'token_expired',
  'account_inactive', 'no_permission', 'missing_scope'
])

// ---------- helpers ----------

/**
 * Slack HTTP wrapper. GET with query params by default; pass { method: 'POST',
 * body } for writes (JSON-encoded; Slack requires charset in Content-Type).
 * Throws Error with `.status` and `.slackError` on HTTP failure or ok:false.
 */
const slackFetch = async (method, accessToken, { params, body, httpMethod } = {}) => {
  const url = new URL(SLACK_BASE + '/' + method)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }
  }
  const init = {
    method: httpMethod || (body ? 'POST' : 'GET'),
    headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' }
  }
  if (body) {
    init.headers['Content-Type'] = 'application/json; charset=utf-8'
    init.body = JSON.stringify(body)
  }
  const res = await fetchWithRetry(url, init, {
    onRetry: ({ status, attempt, delayMs }) => {
      console.warn('Slack ' + method + ' ' + (status || 'network') + ' — retrying in ' + delayMs + 'ms (attempt ' + attempt + ')')
    }
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch (_) { /* leave null */ }

  if (!res.ok || !data || data.ok !== true) {
    const slackError = data?.error || null
    const err = new Error('Slack ' + method + ' failed: ' + (slackError || ('HTTP ' + res.status)))
    err.slackError = slackError
    if (!res.ok) err.status = res.status
    else if (AUTH_DEAD_ERRORS.has(slackError)) err.status = 401
    else if (slackError === 'ratelimited') err.status = 429
    else err.status = 400
    throw err
  }
  return data
}

// Slack ts ("1712345678.001200") → ms number. Returns null on bad input.
const tsToMs = (ts) => {
  const n = Number(ts)
  return Number.isFinite(n) ? Math.round(n * 1000) : null
}

// Empty-string cursors mean "no more pages" — normalize to null.
const nextCursorOf = (data) => data?.response_metadata?.next_cursor || null

const conversationType = (ch) => {
  if (ch.is_im) return 'dm'
  if (ch.is_mpim) return 'group_dm'
  if (ch.is_private) return 'private_channel'
  return 'channel'
}

const normalizeConversation = (ch) => ({
  id: ch.id,
  name: ch.name || null, // DMs have no name — counterpartUserId + getUsers resolves
  type: conversationType(ch),
  isMember: ch.is_member !== false, // users.conversations only returns memberships; default true
  isArchived: !!ch.is_archived,
  topic: ch.topic?.value || '',
  purpose: ch.purpose?.value || '',
  memberCount: Number.isFinite(ch.num_members) ? ch.num_members : null,
  counterpartUserId: ch.is_im ? (ch.user || null) : null
})

const normalizeMessage = (m, conversationId) => ({
  id: m.ts,
  conversationId,
  // thread_ts === ts marks a thread PARENT, not a reply — parent id only on replies.
  threadParentId: (m.thread_ts && m.thread_ts !== m.ts) ? m.thread_ts : null,
  sender: m.user
    ? { id: m.user, type: 'user' }
    : { id: m.bot_id || null, type: 'bot' },
  sentAt: tsToMs(m.ts),
  text: m.text || '',
  replyCount: Number.isFinite(m.reply_count) ? m.reply_count : 0,
  edited: !!m.edited,
  subtype: m.subtype || null,
  reactions: Array.isArray(m.reactions)
    ? m.reactions.map(r => ({ name: r.name, count: r.count || 0 }))
    : [],
  files: Array.isArray(m.files)
    ? m.files.map(f => ({
        id: f.id || null,
        filename: f.name || '(unnamed)',
        mimeType: f.mimetype || 'application/octet-stream',
        sizeBytes: f.size || 0
      }))
    : []
})

const normalizeUser = (u) => ({
  id: u.id,
  name: u.name || null,
  displayName: u.profile?.display_name || u.profile?.real_name || u.name || null,
  realName: u.profile?.real_name || null,
  email: u.profile?.email || null, // present only with users:read.email scope
  isBot: !!u.is_bot,
  deleted: !!u.deleted,
  avatar: u.profile?.image_72 || null
})

// ---------- public API ----------

/**
 * List the conversations the connected user is a member of (channels, private
 * channels, group DMs, DMs), paginated.
 *
 * Uses users.conversations (membership semantics: "what this user can read")
 * rather than conversations.list (workspace directory).
 *
 * @param {string} accessToken
 * @param {Object} [options]
 * @param {number} [options.limit=100]        1..200
 * @param {string} [options.cursor]           Opaque cursor from a prior call
 * @param {string[]} [options.types]          Subset of ['channel','private_channel','group_dm','dm'];
 *                                            default all four.
 * @param {boolean} [options.includeArchived] Default false
 * @returns {Promise<{ conversations: Array, nextCursor: string|null }>}
 */
export const listConversations = async (accessToken, options = {}) => {
  const TYPE_MAP = { channel: 'public_channel', private_channel: 'private_channel', group_dm: 'mpim', dm: 'im' }
  const requested = Array.isArray(options.types) && options.types.length > 0
    ? options.types.map(t => TYPE_MAP[t]).filter(Boolean)
    : Object.values(TYPE_MAP)
  const data = await slackFetch('users.conversations', accessToken, {
    params: {
      types: requested.join(','),
      limit: Math.min(200, Math.max(1, options.limit || 100)),
      cursor: options.cursor,
      exclude_archived: options.includeArchived ? 'false' : 'true'
    }
  })
  return {
    conversations: (data.channels || []).map(normalizeConversation),
    nextCursor: nextCursorOf(data)
  }
}

/**
 * Fetch messages from one conversation, newest first, paginated.
 *
 * @param {string} accessToken
 * @param {Object} args
 * @param {string} args.conversationId
 * @param {number} [args.limit=25]     1..200
 * @param {string} [args.cursor]       Opaque cursor (walks OLDER on each page)
 * @param {string} [args.oldest]       Message id (ts) — only messages after this
 * @param {string} [args.latest]       Message id (ts) — only messages before this
 * @param {boolean} [args.inclusive]   Include the oldest/latest bounds themselves.
 *                                     With oldest === latest === a message id, fetches
 *                                     exactly that one message — how an edited message
 *                                     (from a change feed) is re-fetched by id.
 * @returns {Promise<{ messages: Array, nextCursor: string|null }>}
 */
export const getMessages = async (accessToken, { conversationId, limit, cursor, oldest, latest, inclusive } = {}) => {
  if (!conversationId) throw new Error('getMessages: conversationId is required')
  const data = await slackFetch('conversations.history', accessToken, {
    params: {
      channel: conversationId,
      limit: Math.min(200, Math.max(1, limit || 25)),
      cursor,
      oldest,
      latest,
      inclusive: inclusive ? 'true' : undefined
    }
  })
  return {
    messages: (data.messages || []).map(m => normalizeMessage(m, conversationId)),
    nextCursor: nextCursorOf(data)
  }
}

/**
 * Fetch a thread: the parent message plus its replies, oldest first, paginated.
 *
 * @param {string} accessToken
 * @param {Object} args
 * @param {string} args.conversationId
 * @param {string} args.threadId       The parent message id (ts)
 * @param {number} [args.limit=50]
 * @param {string} [args.cursor]
 * @returns {Promise<{ messages: Array, nextCursor: string|null }>}
 */
export const getThread = async (accessToken, { conversationId, threadId, limit, cursor } = {}) => {
  if (!conversationId || !threadId) throw new Error('getThread: conversationId and threadId are required')
  const data = await slackFetch('conversations.replies', accessToken, {
    params: {
      channel: conversationId,
      ts: threadId,
      limit: Math.min(200, Math.max(1, limit || 50)),
      cursor
    }
  })
  return {
    messages: (data.messages || []).map(m => normalizeMessage(m, conversationId)),
    nextCursor: nextCursorOf(data)
  }
}

/**
 * Incremental sync for one conversation: everything newer than lastToken.
 * First call (no lastToken) seeds — returns the newest message id as nextToken
 * without a backfill. Mirrors the mail connectors' getNewer contract per
 * conversation (Slack has no cross-conversation delta API).
 *
 * @param {string} accessToken
 * @param {Object} args
 * @param {string} args.conversationId
 * @param {string} [args.lastToken]    Message id (ts) high-water mark from last call
 * @param {number} [args.limit=100]    Max messages per call (pages internally up to this)
 * @returns {Promise<{ messages: Array, nextToken: string|null, expired: false }>}
 */
export const getNewer = async (accessToken, { conversationId, lastToken, limit } = {}) => {
  if (!conversationId) throw new Error('getNewer: conversationId is required')
  const cap = Math.min(500, Math.max(1, limit || 100))

  if (!lastToken) {
    // Seed: newest message id becomes the high-water mark.
    const { messages } = await getMessages(accessToken, { conversationId, limit: 1 })
    return { messages: [], nextToken: messages[0]?.id || '0', expired: false }
  }

  const collected = []
  let cursor
  do {
    const data = await slackFetch('conversations.history', accessToken, {
      params: {
        channel: conversationId,
        oldest: lastToken, // exclusive by default (inclusive requires inclusive=true)
        limit: Math.min(200, cap - collected.length),
        cursor
      }
    })
    collected.push(...(data.messages || []).map(m => normalizeMessage(m, conversationId)))
    cursor = nextCursorOf(data)
  } while (cursor && collected.length < cap)

  // History arrives newest-first; high-water mark is the newest id seen.
  const nextToken = collected[0]?.id || lastToken
  return { messages: collected, nextToken, expired: false }
}

/**
 * List the member ids of one conversation, paginated.
 *
 * Mainly for group DMs: their provider `name` is a machine string
 * ("mpdm-a--b--c-1"), so the only way to a real display name is to resolve the
 * members. Feed the ids to getUsersByIds.
 *
 * @param {string} accessToken
 * @param {Object} args
 * @param {string} args.conversationId
 * @param {number} [args.limit=100]   1..200
 * @param {string} [args.cursor]
 * @returns {Promise<{ memberIds: string[], nextCursor: string|null }>}
 */
export const getConversationMembers = async (accessToken, { conversationId, limit, cursor } = {}) => {
  if (!conversationId) throw new Error('getConversationMembers: conversationId is required')
  const data = await slackFetch('conversations.members', accessToken, {
    params: {
      channel: conversationId,
      limit: Math.min(200, Math.max(1, limit || 100)),
      cursor
    }
  })
  return { memberIds: data.members || [], nextCursor: nextCursorOf(data) }
}

/**
 * List workspace users (for resolving message sender ids to names), paginated.
 *
 * @param {string} accessToken
 * @param {Object} [options]
 * @param {number} [options.limit=200]   1..200 (Slack recommends <=200)
 * @param {string} [options.cursor]
 * @returns {Promise<{ users: Array, nextCursor: string|null }>}
 */
export const getUsers = async (accessToken, options = {}) => {
  const data = await slackFetch('users.list', accessToken, {
    params: {
      limit: Math.min(200, Math.max(1, options.limit || 200)),
      cursor: options.cursor
    }
  })
  return {
    users: (data.members || []).map(normalizeUser),
    nextCursor: nextCursorOf(data)
  }
}

/**
 * Batch-resolve specific user ids (users.info per id, concurrency-capped).
 * Cheaper than paging users.list when only a handful of senders need names.
 *
 * @param {string} accessToken
 * @param {string[]} userIds
 * @returns {Promise<{ users: Array }>}   Unresolvable ids are skipped.
 */
export const getUsersByIds = async (accessToken, userIds = []) => {
  const unique = [...new Set(userIds.filter(Boolean))]
  const results = await runConcurrent(unique, MAX_PARALLEL, async (id) => {
    try {
      const data = await slackFetch('users.info', accessToken, { params: { user: id } })
      return normalizeUser(data.user)
    } catch (e) {
      if (e.status === 401) throw e // dead token must bubble to the refresh cascade
      return null // user_not_found etc. — skip
    }
  })
  return { users: results.filter(Boolean) }
}

/**
 * The connected account's identity — used at connect time to populate
 * connection.account_email / display fields.
 *
 * @param {string} accessToken
 * @returns {Promise<{ email, displayName, userId, teamId, teamName, teamUrl }>}
 */
export const getAccountProfile = async (accessToken) => {
  const auth = await slackFetch('auth.test', accessToken, {})
  let email = null
  let displayName = auth.user || null
  try {
    const info = await slackFetch('users.info', accessToken, { params: { user: auth.user_id } })
    const u = normalizeUser(info.user)
    email = u.email
    displayName = u.displayName || displayName
  } catch (_) { /* users:read may be missing — auth.test basics are enough */ }
  return {
    email,
    displayName,
    userId: auth.user_id,
    teamId: auth.team_id,
    teamName: auth.team || null,
    teamUrl: auth.url || null
  }
}

/**
 * Send a message (as the connected user), optionally into a thread.
 *
 * @param {string} accessToken
 * @param {Object} params
 * @param {string} params.conversationId
 * @param {string} params.text
 * @param {string} [params.threadId]   Parent message id (ts) to reply in-thread
 * @returns {Promise<{ messageId, conversationId, threadParentId }>}
 */
export const sendMessage = async (accessToken, { conversationId, text, threadId } = {}) => {
  if (!conversationId) throw new Error('sendMessage: conversationId is required')
  if (!text) throw new Error('sendMessage: text is required')
  const data = await slackFetch('chat.postMessage', accessToken, {
    body: {
      channel: conversationId,
      text,
      ...(threadId ? { thread_ts: threadId } : {})
    }
  })
  return {
    messageId: data.ts,
    conversationId: data.channel || conversationId,
    threadParentId: threadId || null
  }
}

/**
 * Move the user's read cursor in a conversation to a given message.
 * (Slack models read state as a per-conversation cursor, not per-message flags —
 * marking a message read marks everything at or before it.)
 *
 * @param {string} accessToken
 * @param {Object} params
 * @param {string} params.conversationId
 * @param {string} params.ts            Message id to set the cursor to
 * @returns {Promise<{ conversationId, ts }>}
 */
export const markRead = async (accessToken, { conversationId, ts } = {}) => {
  if (!conversationId || !ts) throw new Error('markRead: conversationId and ts are required')
  await slackFetch('conversations.mark', accessToken, {
    body: { channel: conversationId, ts }
  })
  return { conversationId, ts }
}

/**
 * Delete a message.
 *
 * With a user token Slack only permits deleting the user's OWN messages (a
 * workspace admin's token can delete others'). Someone else's message comes
 * back as `cant_delete_message`, surfaced as a 400 with `.slackError` set so
 * callers can report which ones were skipped rather than failing the batch.
 *
 * @param {string} accessToken
 * @param {Object} params
 * @param {string} params.conversationId
 * @param {string} params.ts            Message id to delete
 * @returns {Promise<{ conversationId, messageId }>}
 */
export const deleteMessage = async (accessToken, { conversationId, ts } = {}) => {
  if (!conversationId || !ts) throw new Error('deleteMessage: conversationId and ts are required')
  const data = await slackFetch('chat.delete', accessToken, {
    body: { channel: conversationId, ts }
  })
  return { conversationId, messageId: data.ts || ts }
}

export default {
  listConversations, getMessages, getThread, getNewer,
  getConversationMembers, getUsers, getUsersByIds, getAccountProfile,
  sendMessage, markRead, deleteMessage
}
