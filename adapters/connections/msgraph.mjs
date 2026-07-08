// freezr.info - Mail connector: Microsoft Graph (Outlook / Microsoft 365 / personal MS accounts)
// Pure data-API wrapper for Microsoft Graph mail. No OAuth flow, no persistence, no
// resource record — takes an already-refreshed accessToken (first arg, same as gmail.mjs)
// and returns the SAME normalized shapes as gmail.mjs / imap.mjs. See gmail.mjs for the
// canonical shape docs.
//
// Rate-limit contract (see adapters/connections/_shared.mjs):
//   - Every Graph HTTP call goes through fetchWithRetry (retries 429/5xx/network,
//     honors Retry-After; Graph's x-ms-retry-after-ms is checked first when present).
//   - Per-item fan-out is capped at MAX_PARALLEL = 4 — Outlook enforces a hard limit
//     of 4 concurrent requests per mailbox.
//
// Graph-vs-Gmail mapping notes:
//   - id           → Graph message id (mutable! Graph reassigns ids when a message
//                    moves folders — including draft→Sent Items on send. Callers should
//                    re-list after moveMessage/sendMessage, same caveat as imap.mjs.)
//   - threadId     → conversationId
//   - messageId    → internetMessageId (RFC-822 — used for reply threading)
//   - labels       → [parentFolderId] (Graph has folders, not labels — parity with imap.mjs)
//   - snippet      → bodyPreview
//   - listMessages returns full metadata in ONE call (no per-id fan-out like Gmail).
//   - getFullMessage returns bodyHtml OR bodyText, not both — Graph exposes a single
//     body with a contentType discriminator.
//   - Custom In-Reply-To headers can't be set via Graph (only x- headers allowed), so
//     replies resolve the parent by internetMessageId and go through /createReply to
//     preserve threading. If the parent isn't found the mail still sends, unthreaded.
//   - sendMessage/createDraft build a draft first (attachments POSTed per item — v1
//     supports attachments up to ~3 MB each; larger files need Graph upload sessions,
//     deferred), because /sendMail returns 202 with no body → no ids for the caller.
//   - getNewer uses per-folder /messages/delta (default inbox — Graph has no global
//     mailbox delta). Changed messages (e.g. read-status flips) arrive identically to
//     new ones, so both are emitted as { type: 'messageAdded' } — upsert semantics.
//     410 Gone (sync state expired) → { expired: true }, caller re-lists and re-seeds.

import { runConcurrent, fetchWithRetry } from './_shared.mjs'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

// Outlook allows max 4 concurrent requests per mailbox — cap fan-out at exactly that.
const MAX_PARALLEL = 4

// Metadata field set for list/delta rows (parity with gmail.mjs format=metadata).
const SELECT_META = 'id,conversationId,internetMessageId,from,toRecipients,ccRecipients,' +
  'subject,receivedDateTime,bodyPreview,isRead,hasAttachments,parentFolderId'

// Well-known folder names Graph resolves server-side. Used to tag listFolders rows
// as 'system' (v1.0 mailFolder has no wellKnownName property to read directly).
const WELL_KNOWN_FOLDERS = ['inbox', 'drafts', 'sentitems', 'deleteditems', 'junkemail', 'archive', 'outbox']

// ---------- transport ----------

const authHeaders = (accessToken) => ({
  Authorization: 'Bearer ' + accessToken,
  Accept: 'application/json'
})

// Graph sometimes sends x-ms-retry-after-ms instead of (or alongside) Retry-After.
const graphRetryAfter = (res) => {
  const ms = Number(res.headers.get('x-ms-retry-after-ms'))
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

/**
 * Graph HTTP wrapper. Defaults to GET; pass `{ method, body }` for writes.
 * Objects are JSON-encoded. 202/204 (sendMail, DELETE, move variants) return null.
 */
const graphFetch = async (url, accessToken, { method = 'GET', body } = {}) => {
  const headers = authHeaders(accessToken)
  const init = { method, headers }
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json'
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
  }
  const res = await fetchWithRetry(url, init, {
    parseProviderRetryAfter: graphRetryAfter,
    onRetry: ({ status, attempt, delayMs }) => {
      console.warn('Graph ' + (status || 'network') + ' — retrying in ' + delayMs + 'ms (attempt ' + attempt + ')')
    }
  })
  if (res.status === 204 || res.status === 202) return null
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch (_) { /* leave null */ }
  if (!res.ok) {
    const err = new Error('Graph ' + res.status + ': ' + (data?.error?.message || text || res.statusText))
    err.status = res.status
    err.graphError = data?.error || null
    throw err
  }
  return data
}

// ---------- normalization ----------

// Graph recipient { emailAddress: { address, name } } → shared { address, name }.
const mapRecipient = (r) => {
  const e = r?.emailAddress
  return (e && e.address) ? { address: e.address, name: e.name || null } : null
}
const mapRecipientList = (arr) => Array.isArray(arr) ? arr.map(mapRecipient).filter(Boolean) : []

// Extract a header value (case-insensitive) from Graph's internetMessageHeaders array.
const headerValue = (headers, name) => {
  if (!Array.isArray(headers)) return null
  const lower = name.toLowerCase()
  for (const h of headers) {
    if (h && h.name && h.name.toLowerCase() === lower) return h.value
  }
  return null
}

// Graph attachment row → shared attachment shape. contentId is only present when the
// attachments fetch managed to $select it (see fetchAttachmentRows fallback).
const mapAttachment = (a) => ({
  id: a.id,
  filename: a.name || '(unnamed)',
  mimeType: a.contentType || 'application/octet-stream',
  sizeBytes: a.size || 0,
  contentId: a.contentId || null,
  inline: !!a.isInline || !!a.contentId
})

// Normalize a Graph message resource to the shared row shape.
//   normalizeMessage(g)                          — metadata (+ attachments if g.attachments present)
//   normalizeMessage(g, { includeBodies: true }) — + bodyText/bodyHtml from g.body
const normalizeMessage = (g, { includeBodies = false } = {}) => {
  const headers = g.internetMessageHeaders || null
  const base = {
    id: g.id,
    threadId: g.conversationId || null,
    messageId: g.internetMessageId || null,
    inReplyTo: headerValue(headers, 'In-Reply-To'),
    references: headerValue(headers, 'References'),
    from: mapRecipient(g.from),
    to: mapRecipientList(g.toRecipients),
    cc: mapRecipientList(g.ccRecipients),
    subject: g.subject || '(no subject)',
    receivedAt: g.receivedDateTime ? Date.parse(g.receivedDateTime) : null,
    snippet: g.bodyPreview || '',
    isRead: !!g.isRead,
    hasAttachments: !!g.hasAttachments,
    labels: g.parentFolderId ? [g.parentFolderId] : []
  }

  if (Array.isArray(g.attachments)) {
    base.attachments = g.attachments.map(mapAttachment)
    if (base.attachments.length > 0) base.hasAttachments = true
  }

  if (includeBodies) {
    const contentType = (g.body?.contentType || '').toLowerCase()
    base.bodyText = contentType === 'text' ? (g.body?.content || null) : null
    base.bodyHtml = contentType === 'html' ? (g.body?.content || null) : null
  }

  return base
}

// Escape a single-quoted OData $filter literal.
const odataQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'"

// Messages collection URL for a folder scope. `folder` is a folder id from
// listFolders or a well-known name (inbox, sentitems, ...); null = all mail.
const messagesUrl = (folder) => folder
  ? GRAPH_BASE + '/me/mailFolders/' + encodeURIComponent(folder) + '/messages'
  : GRAPH_BASE + '/me/messages'

// Validate an opaque pageToken/nextToken really is a Graph URL before fetching it —
// tokens round-trip through clients, so never fetch an arbitrary caller-supplied URL.
const assertGraphUrl = (url, what) => {
  if (typeof url !== 'string' || !url.startsWith(GRAPH_BASE + '/')) {
    const err = new Error('msgraph connector: ' + what + ' is not a valid Graph cursor')
    err.code = 'msgraph_bad_token'
    throw err
  }
}

// ---------- public API: listing / fetch ----------

/**
 * List messages with metadata, paginated. One Graph call per page — the list
 * endpoint returns full metadata (no per-id fan-out like Gmail).
 *
 * @param {string} accessToken
 * @param {Object} [options]
 * @param {number} [options.limit=20]              1..100, mapped to $top
 * @param {string} [options.pageToken]             Opaque cursor (@odata.nextLink)
 * @param {string[]} [options.labelIds]            [folderId] — only the first is used
 *                                                 (Graph folders are exclusive, like IMAP)
 * @param {string} [options.q]                     Provider-native search ($search, KQL)
 * @param {boolean} [options.includeAttachments]   Adds attachments[] per row via $expand
 * @returns {Promise<{ messages: Array, nextPageToken: string|null }>}
 */
export const listMessages = async (accessToken, options = {}) => {
  let url
  if (options.pageToken) {
    assertGraphUrl(options.pageToken, 'pageToken')
    url = options.pageToken // nextLink carries all original query params
  } else {
    const limit = Math.max(1, Math.min(100, options.limit || 20))
    const folder = (Array.isArray(options.labelIds) && options.labelIds[0]) || null
    const params = ['$top=' + limit, '$select=' + SELECT_META]
    if (options.includeAttachments) {
      params.push('$expand=' + encodeURIComponent('attachments($select=id,name,contentType,size,isInline)'))
    }
    if (options.q) {
      // $search can't combine with $orderby; Graph returns best-match order.
      params.push('$search=' + encodeURIComponent('"' + String(options.q).replace(/"/g, '\\"') + '"'))
    } else {
      params.push('$orderby=' + encodeURIComponent('receivedDateTime desc'))
    }
    url = messagesUrl(folder) + '?' + params.join('&')
  }

  const data = await graphFetch(url, accessToken)
  const rows = Array.isArray(data?.value) ? data.value : []
  return {
    messages: rows.map(g => normalizeMessage(g)),
    nextPageToken: data?.['@odata.nextLink'] || null
  }
}

// Fetch a message's attachment metadata rows (no contentBytes). Tries to $select
// contentId (a fileAttachment-only property — needed for cid: inline-image
// re-linking); some Graph endpoints reject derived-type properties in $select,
// so fall back to the base property set on a 400.
const fetchAttachmentRows = async (accessToken, messageId) => {
  const base = GRAPH_BASE + '/me/messages/' + encodeURIComponent(messageId) + '/attachments'
  try {
    const data = await graphFetch(base + '?$select=id,name,contentType,size,isInline,contentId', accessToken)
    return Array.isArray(data?.value) ? data.value : []
  } catch (err) {
    if (err?.status !== 400) throw err
    const data = await graphFetch(base + '?$select=id,name,contentType,size,isInline', accessToken)
    return Array.isArray(data?.value) ? data.value : []
  }
}

/**
 * Get one full message including body and attachment metadata.
 * Graph returns a single body (contentType 'html' or 'text'), so exactly one of
 * bodyHtml/bodyText is populated. internetMessageHeaders supply inReplyTo/references.
 */
export const getFullMessage = async (accessToken, messageId) => {
  if (!messageId) throw new Error('messageId is required')
  const url = GRAPH_BASE + '/me/messages/' + encodeURIComponent(messageId) +
    '?$select=' + SELECT_META + ',body,internetMessageHeaders'
  const data = await graphFetch(url, accessToken)
  const row = normalizeMessage(data, { includeBodies: true })
  row.attachments = data.hasAttachments
    ? (await fetchAttachmentRows(accessToken, messageId)).map(mapAttachment)
    : []
  if (row.attachments.length > 0) row.hasAttachments = true
  return row
}

/**
 * Fetch a single attachment's raw bytes. Only fileAttachments carry bytes —
 * itemAttachment (attached emails/events) and referenceAttachment (OneDrive
 * links) have none and throw a clear error.
 *
 * @returns {Promise<{ buffer: Buffer, sizeBytes: number|null }>}
 */
export const getAttachment = async (accessToken, messageId, attachmentId) => {
  if (!messageId) throw new Error('messageId is required')
  if (!attachmentId) throw new Error('attachmentId is required')
  const url = GRAPH_BASE + '/me/messages/' + encodeURIComponent(messageId) +
    '/attachments/' + encodeURIComponent(attachmentId)
  const data = await graphFetch(url, accessToken)
  if (!data?.contentBytes) {
    const err = new Error('Attachment has no downloadable bytes (type: ' + (data?.['@odata.type'] || 'unknown') + ')')
    err.code = 'msgraph_no_bytes'
    err.status = 404
    throw err
  }
  const buffer = Buffer.from(data.contentBytes, 'base64')
  return { buffer, sizeBytes: typeof data.size === 'number' ? data.size : buffer.length }
}

/**
 * Get the authenticated account's profile. `email` prefers the mailbox address
 * (mail) over the sign-in name (userPrincipalName). messagesTotal is best-effort
 * from the inbox folder counts.
 */
export const getAccountProfile = async (accessToken) => {
  const me = await graphFetch(GRAPH_BASE + '/me?$select=mail,userPrincipalName,displayName', accessToken)
  let messagesTotal = 0
  try {
    const inbox = await graphFetch(GRAPH_BASE + '/me/mailFolders/inbox?$select=totalItemCount', accessToken)
    messagesTotal = inbox?.totalItemCount || 0
  } catch (_) { /* non-fatal */ }
  return {
    email: me?.mail || me?.userPrincipalName || null,
    displayName: me?.displayName || null,
    messagesTotal
  }
}

/**
 * List folders → [{ id, name, type }]. Graph's /mailFolders returns top-level
 * folders; one level of children is expanded and flattened as 'Parent/Child'
 * (deeper nesting deferred). `type` is 'system' for the well-known folders
 * (Inbox, Drafts, Sent Items, Deleted Items, Junk, Archive, Outbox), resolved
 * by id since v1.0 folders don't expose wellKnownName.
 */
export const listFolders = async (accessToken) => {
  const wellKnownIds = new Set()
  await runConcurrent(WELL_KNOWN_FOLDERS, MAX_PARALLEL, async (wk) => {
    try {
      const f = await graphFetch(GRAPH_BASE + '/me/mailFolders/' + wk + '?$select=id', accessToken)
      if (f?.id) wellKnownIds.add(f.id)
    } catch (_) { /* folder may not exist (e.g. archive) — skip */ }
  })

  const url = GRAPH_BASE + '/me/mailFolders?$top=200&$select=id,displayName' +
    '&$expand=' + encodeURIComponent('childFolders($select=id,displayName)')
  const data = await graphFetch(url, accessToken)
  const out = []
  ;(Array.isArray(data?.value) ? data.value : []).forEach(f => {
    out.push({ id: f.id, name: f.displayName, type: wellKnownIds.has(f.id) ? 'system' : 'user' })
    ;(f.childFolders || []).forEach(c => {
      out.push({ id: c.id, name: f.displayName + '/' + c.displayName, type: wellKnownIds.has(c.id) ? 'system' : 'user' })
    })
  })
  return out
}

// ---------- search ----------

/**
 * Structured search. Graph can't combine $search with $filter, so:
 *   - text / from / to present → KQL $search (from:/to:/received>= terms);
 *     isRead + hasAttachments are ignored in this mode (no reliable KQL parity).
 *   - otherwise → $filter on receivedDateTime / isRead / hasAttachments.
 * Results come back in Graph's default order (newest first for $filter,
 * best-match for $search). Same result shape as listMessages.
 */
export const searchMessages = async (accessToken, params = {}) => {
  if (params.pageToken) return listMessages(accessToken, { pageToken: params.pageToken })

  const limit = Math.max(1, Math.min(100, params.limit || 20))
  const folder = (Array.isArray(params.labels) && params.labels[0]) || null
  const query = ['$top=' + limit, '$select=' + SELECT_META]
  if (params.includeAttachments) {
    query.push('$expand=' + encodeURIComponent('attachments($select=id,name,contentType,size,isInline)'))
  }

  const useSearch = !!(params.text || params.from || params.to)
  if (useSearch) {
    const kql = []
    if (params.text) kql.push(String(params.text).replace(/"/g, '\\"'))
    if (params.from) kql.push('from:"' + String(params.from).replace(/"/g, '\\"') + '"')
    if (params.to) kql.push('to:"' + String(params.to).replace(/"/g, '\\"') + '"')
    if (params.since != null) kql.push('received>=' + new Date(Number(params.since)).toISOString().slice(0, 10))
    if (params.before != null) kql.push('received<=' + new Date(Number(params.before)).toISOString().slice(0, 10))
    query.push('$search=' + encodeURIComponent('"' + kql.join(' ') + '"'))
  } else {
    const filters = []
    if (params.since != null) filters.push('receivedDateTime ge ' + new Date(Number(params.since)).toISOString())
    if (params.before != null) filters.push('receivedDateTime lt ' + new Date(Number(params.before)).toISOString())
    if (params.isRead === true) filters.push('isRead eq true')
    else if (params.isRead === false) filters.push('isRead eq false')
    if (params.hasAttachments === true) filters.push('hasAttachments eq true')
    if (filters.length > 0) query.push('$filter=' + encodeURIComponent(filters.join(' and ')))
  }

  const data = await graphFetch(messagesUrl(folder) + '?' + query.join('&'), accessToken)
  const rows = Array.isArray(data?.value) ? data.value : []
  return {
    messages: rows.map(g => normalizeMessage(g)),
    nextPageToken: data?.['@odata.nextLink'] || null
  }
}

// ---------- delta sync (one folder) ----------

/**
 * Incremental sync via per-folder /messages/delta (default inbox — Graph has no
 * whole-mailbox delta). Returns { changes, nextToken, expired }.
 *
 * `lastToken` is the @odata.deltaLink (or mid-round nextLink) from a prior call.
 * First call (no token) seeds with `$filter=receivedDateTime ge now` so the
 * initial round is empty, and returns the deltaLink as nextToken with changes:[].
 *
 * Change shape (Graph can't distinguish new from updated, so both upsert):
 *   { type: 'messageAdded',   message: <metadata-only normalized row> }
 *   { type: 'messageDeleted', messageId }
 *
 * 410 Gone (sync state expired) → { expired: true }; caller re-lists and re-seeds.
 */
export const getNewer = async (accessToken, lastToken, options = {}) => {
  const limit = Math.max(1, Math.min(500, options.limit || 100))
  const folder = (Array.isArray(options.labelIds) && options.labelIds[0]) || 'inbox'

  // Drain one delta round: follow nextLinks until a deltaLink appears or `cap`
  // messages have been consumed (then return the pending nextLink as the cursor).
  const drain = async (startUrl, cap, collect) => {
    let url = startUrl
    let count = 0
    while (url) {
      const data = await graphFetch(url, accessToken)
      const rows = Array.isArray(data?.value) ? data.value : []
      for (const row of rows) {
        if (collect) collect(row)
        count++
      }
      if (data?.['@odata.deltaLink']) return { token: data['@odata.deltaLink'], done: true }
      url = data?.['@odata.nextLink'] || null
      if (url && collect && count >= cap) return { token: url, done: false }
    }
    return { token: null, done: true }
  }

  if (!lastToken) {
    const seedUrl = GRAPH_BASE + '/me/mailFolders/' + encodeURIComponent(folder) + '/messages/delta' +
      '?$select=' + SELECT_META +
      '&$filter=' + encodeURIComponent('receivedDateTime ge ' + new Date().toISOString())
    const { token } = await drain(seedUrl, Infinity, null)
    return { changes: [], nextToken: token, expired: false }
  }

  assertGraphUrl(lastToken, 'lastToken')
  const changes = []
  let result
  try {
    result = await drain(lastToken, limit, (row) => {
      if (row['@removed']) {
        if (row.id) changes.push({ type: 'messageDeleted', messageId: row.id })
      } else {
        changes.push({ type: 'messageAdded', message: normalizeMessage(row) })
      }
    })
  } catch (err) {
    if (err?.status === 410) return { changes: [], nextToken: null, expired: true }
    throw err
  }
  return { changes, nextToken: result.token || lastToken, expired: false }
}

// ---------- send / drafts ----------

// Unified params → Graph message payload (no attachments — those POST separately).
// Graph messages carry ONE body: bodyHtml wins when both are supplied.
const toRecipients = (raw) => {
  if (!raw) return []
  const arr = Array.isArray(raw) ? raw : [raw]
  return arr.map(item => {
    if (typeof item === 'string') return { emailAddress: { address: item.trim() } }
    if (item && item.address) {
      const emailAddress = { address: item.address }
      if (item.name) emailAddress.name = item.name
      return { emailAddress }
    }
    return null
  }).filter(Boolean)
}

const buildGraphMessage = (params) => {
  const msg = {
    subject: params.subject || '',
    body: params.bodyHtml
      ? { contentType: 'HTML', content: params.bodyHtml }
      : { contentType: 'Text', content: params.bodyText || '' },
    toRecipients: toRecipients(params.to)
  }
  if (params.cc) msg.ccRecipients = toRecipients(params.cc)
  if (params.bcc) msg.bccRecipients = toRecipients(params.bcc)
  return msg
}

// Find a message's Graph id by its RFC-822 internetMessageId (for reply threading).
const findByInternetMessageId = async (accessToken, internetMessageId) => {
  if (!internetMessageId) return null
  try {
    const url = GRAPH_BASE + '/me/messages?$top=1&$select=id,conversationId' +
      '&$filter=' + encodeURIComponent('internetMessageId eq ' + odataQuote(internetMessageId))
    const data = await graphFetch(url, accessToken)
    return (Array.isArray(data?.value) && data.value[0]) || null
  } catch (_) {
    return null // threading is best-effort; the send must not fail on lookup
  }
}

// Create a draft: a /createReply draft off the parent when inReplyTo resolves
// (preserves conversation threading — Graph forbids setting In-Reply-To directly),
// else a fresh draft. Caller's recipients/subject/body always overwrite the
// prefilled reply values. Attachments POST one-by-one (Graph rejects >~3 MB per
// inline fileAttachment; larger needs upload sessions — deferred).
const buildDraft = async (accessToken, params) => {
  const payload = buildGraphMessage(params)
  let draft = null

  if (params.inReplyTo) {
    const parent = await findByInternetMessageId(accessToken, params.inReplyTo)
    if (parent) {
      draft = await graphFetch(
        GRAPH_BASE + '/me/messages/' + encodeURIComponent(parent.id) + '/createReply',
        accessToken, { method: 'POST' })
      draft = await graphFetch(
        GRAPH_BASE + '/me/messages/' + encodeURIComponent(draft.id),
        accessToken, { method: 'PATCH', body: payload })
    }
  }
  if (!draft) {
    draft = await graphFetch(GRAPH_BASE + '/me/messages', accessToken, { method: 'POST', body: payload })
  }

  const attachments = Array.isArray(params.attachments) ? params.attachments : []
  for (const att of attachments) {
    const body = {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: att.filename || 'attachment',
      contentType: att.mimeType || 'application/octet-stream',
      contentBytes: att.contentBase64 || ''
    }
    if (att.contentId) { body.contentId = att.contentId; body.isInline = true }
    await graphFetch(
      GRAPH_BASE + '/me/messages/' + encodeURIComponent(draft.id) + '/attachments',
      accessToken, { method: 'POST', body })
  }
  return draft
}

/**
 * Send a message. Returns { messageId, threadId } — the draft's Graph id and
 * conversationId. NOTE: Graph reassigns the message id when the sent copy lands
 * in Sent Items, so messageId is transient (re-list to get the durable id);
 * threadId (conversationId) is stable and correct for threading.
 *
 * For replies pass `inReplyTo` (parent RFC-822 Message-ID) — threading is
 * resolved via /createReply. `threadId`/`references` params are accepted for
 * contract parity but unused (Graph derives the conversation itself).
 */
export const sendMessage = async (accessToken, params = {}) => {
  if (!params.to) throw new Error('sendMessage: to is required')
  const draft = await buildDraft(accessToken, params)
  await graphFetch(GRAPH_BASE + '/me/messages/' + encodeURIComponent(draft.id) + '/send',
    accessToken, { method: 'POST' })
  return { messageId: draft.id, threadId: draft.conversationId || null }
}

/**
 * Create a draft (synced to Outlook's Drafts folder). Same params as sendMessage;
 * returns { draftId, messageId, threadId }.
 */
export const createDraft = async (accessToken, params = {}) => {
  const draft = await buildDraft(accessToken, params)
  return {
    draftId: draft.id,
    messageId: draft.id,
    threadId: draft.conversationId || null
  }
}

// ---------- mutations ----------

/**
 * Mark a message read or unread.
 */
export const markRead = async (accessToken, messageId, isRead) => {
  if (!messageId) throw new Error('markRead: messageId is required')
  await graphFetch(GRAPH_BASE + '/me/messages/' + encodeURIComponent(messageId),
    accessToken, { method: 'PATCH', body: { isRead: isRead !== false } })
  return { messageId, isRead: isRead !== false }
}

/**
 * Move a message to a target folder (true move — folder id or well-known name).
 * NOTE: Graph assigns a NEW message id in the destination (same caveat as
 * imap.mjs) — callers should re-list the target folder for fresh ids.
 */
export const moveMessage = async (accessToken, messageId, targetFolder) => {
  if (!messageId) throw new Error('moveMessage: messageId is required')
  if (!targetFolder) throw new Error('moveMessage: targetFolder is required')
  await graphFetch(GRAPH_BASE + '/me/messages/' + encodeURIComponent(messageId) + '/move',
    accessToken, { method: 'POST', body: { destinationId: targetFolder } })
  return { messageId }
}

/**
 * Move a message to Deleted Items (recoverable).
 */
export const trashMessage = async (accessToken, messageId) => {
  if (!messageId) throw new Error('trashMessage: messageId is required')
  await graphFetch(GRAPH_BASE + '/me/messages/' + encodeURIComponent(messageId) + '/move',
    accessToken, { method: 'POST', body: { destinationId: 'deleteditems' } })
  return { messageId }
}

/**
 * Permanently delete a message (skips Deleted Items). Uses /permanentDelete;
 * if the tenant doesn't support it (older sovereign clouds → 400/405/501),
 * falls back to DELETE, which moves to Deleted Items — the closest available.
 */
export const deleteMessage = async (accessToken, messageId) => {
  if (!messageId) throw new Error('deleteMessage: messageId is required')
  const base = GRAPH_BASE + '/me/messages/' + encodeURIComponent(messageId)
  try {
    await graphFetch(base + '/permanentDelete', accessToken, { method: 'POST' })
  } catch (err) {
    if (err?.status === 400 || err?.status === 405 || err?.status === 501) {
      await graphFetch(base, accessToken, { method: 'DELETE' })
    } else {
      throw err
    }
  }
  return { messageId }
}

export default {
  listMessages,
  getFullMessage,
  getAttachment,
  getAccountProfile,
  listFolders,
  searchMessages,
  getNewer,
  sendMessage,
  createDraft,
  markRead,
  moveMessage,
  trashMessage,
  deleteMessage
}
