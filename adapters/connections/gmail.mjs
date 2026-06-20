// freezr.info - Mail connector: Gmail
// Pure data-API wrapper for Gmail. No OAuth flow, no persistence, no resource record —
// just takes an already-refreshed accessToken and returns NORMALIZED data so the mail
// app (and future third-party apps) sees the same shape regardless of provider.
//
// Rate-limit contract (see adapters/connections/_shared.mjs for full text):
//   - Per-item fan-out is capped via runConcurrent(items, MAX_PARALLEL, fn).
//   - Every Gmail HTTP call goes through fetchWithRetry, which retries 429/5xx/network
//     with exponential backoff and honors Retry-After.
//   - Graph and IMAP connectors will follow the same contract with provider-tuned values.
//
// Normalized shapes (also see freezr_mail_phase2.md):
//
//   listMessages -> {
//     messages: [{
//       id, threadId,
//       from: { address, name },
//       to:   [{ address, name }],
//       cc:   [{ address, name }],
//       subject,
//       receivedAt,         // ms timestamp (Gmail internalDate)
//       snippet,
//       isRead,
//       hasAttachments,
//       labels              // string[] — Gmail labels pass through; Graph folders flatten here later
//       // when options.includeAttachments === true:
//       attachments: [{ id, filename, mimeType, sizeBytes }]
//       // (bodyText / bodyHtml are NEVER returned by listMessages — see normalizeMessage)
//     }],
//     nextPageToken         // string|null — opaque Gmail cursor; null when no more pages
//   }
//
//   getFullMessage -> the listMessages row shape + bodyText, bodyHtml, attachments[].
//
//   getAccountProfile -> { email, displayName?, messagesTotal?, threadsTotal? }
//
//   getAttachment -> { buffer: Buffer, sizeBytes: number|null }
//
// Internal normalize flags:
//   normalizeMessage(gm)                                    — metadata only
//   normalizeMessage(gm, { includeAttachments: true })      — metadata + attachments[],
//                                                             bodies NOT decoded (memory win)
//   normalizeMessage(gm, { includeAttachments: true,
//                          includeBodies: true })           — full shape
//
// Uses native fetch (via fetchWithRetry). No googleapis SDK dependency on this path.

import { runConcurrent, fetchWithRetry } from './_shared.mjs'

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

// Cap parallel per-item fetches well below Gmail's per-user concurrent quota.
const MAX_PARALLEL = 5

// ---------- helpers ----------

const authHeaders = (accessToken) => ({
  Authorization: 'Bearer ' + accessToken,
  Accept: 'application/json'
})

/**
 * Gmail HTTP wrapper. Defaults to GET; pass `{ method, body }` for writes.
 * If `body` is an object it's JSON-encoded and Content-Type is set. Pass a
 * pre-stringified string when the caller needs full control of the payload
 * (e.g. Gmail's send/import endpoints sometimes accept raw RFC 822 directly,
 * but we use the standard JSON-wrapped `{ raw, threadId }` form here).
 *
 * 204 No Content (used by Gmail's DELETE /messages/{id}) returns null.
 */
const gmailFetch = async (url, accessToken, { method = 'GET', body } = {}) => {
  const headers = authHeaders(accessToken)
  let init = { method, headers }
  if (body !== undefined && body !== null) {
    if (typeof body === 'string') {
      init.body = body
    } else {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
  }
  const res = await fetchWithRetry(url, init, {
    onRetry: ({ status, attempt, delayMs }) => {
      console.warn('Gmail ' + (status || 'network') + ' — retrying in ' + delayMs + 'ms (attempt ' + attempt + ')')
    }
  })
  if (res.status === 204) return null
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch (_) { /* leave null */ }
  if (!res.ok) {
    const err = new Error('Gmail ' + res.status + ': ' + (data?.error?.message || text || res.statusText))
    err.status = res.status
    err.gmailError = data?.error || null
    throw err
  }
  return data
}

// Parse an RFC-822 address like '"Salman" <salman@gmail.com>' or 'salman@gmail.com'
// into { address, name }. Returns null for empty/malformed input.
const parseAddress = (raw) => {
  if (!raw || typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const m = trimmed.match(/^"?([^"<]*?)"?\s*<\s*([^>]+)\s*>\s*$/)
  if (m) {
    return { address: m[2].trim(), name: m[1].trim() || null }
  }
  return { address: trimmed, name: null }
}

// Parse a comma-separated address list. Returns [] for empty input.
// Naive split — adequate for inbox metadata; full parsing would need to handle
// commas inside quoted display names, but Gmail rarely emits those in the To header.
const parseAddressList = (raw) => {
  if (!raw || typeof raw !== 'string') return []
  return raw.split(',').map(parseAddress).filter(Boolean)
}

// Extract a header value (case-insensitive) from a Gmail payload.headers array.
const headerValue = (headers, name) => {
  if (!Array.isArray(headers)) return null
  const lower = name.toLowerCase()
  for (const h of headers) {
    if (h && h.name && h.name.toLowerCase() === lower) return h.value
  }
  return null
}

// Decode a base64url-encoded body part to a UTF-8 string.
const decodeBase64Url = (data) => {
  if (!data) return ''
  // Gmail returns base64url; Buffer.from handles base64; convert first.
  const padded = data.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(padded, 'base64').toString('utf8')
}

// Decode a base64url-encoded body part to a raw Buffer.
const decodeBase64UrlToBuffer = (data) => {
  if (!data) return Buffer.alloc(0)
  const padded = data.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(padded, 'base64')
}

// Walk a Gmail payload tree. Always returns the attachments[] array; only decodes
// body data when `decodeBodies` is true. Splitting these two responsibilities lets
// "metadata + attachments" callers skip the UTF-8 string allocation entirely — Gmail
// still ships `body.data` over the wire (no `format=metadata-plus-parts` exists), but
// we don't pay the JS cost of decoding it.
//
// @param {Object} payload   Gmail message.payload tree
// @param {Object} [opts]
// @param {boolean} [opts.decodeBodies]  When true, populate bodyText/bodyHtml
// @returns {{ bodyText: string|null, bodyHtml: string|null, attachments: Array }}
const walkPayload = (payload, { decodeBodies = false } = {}) => {
  let bodyText = null
  let bodyHtml = null
  const attachments = []

  const walk = (part) => {
    if (!part) return
    const mime = (part.mimeType || '').toLowerCase()
    const filename = part.filename || ''
    const attachmentId = part.body?.attachmentId || null

    if (attachmentId || filename) {
      // It's an attachment, not an inline body
      attachments.push({
        id: attachmentId || null,
        filename: filename || '(unnamed)',
        mimeType: part.mimeType || 'application/octet-stream',
        sizeBytes: part.body?.size || 0
      })
    } else if (decodeBodies && mime === 'text/plain' && part.body?.data && bodyText === null) {
      bodyText = decodeBase64Url(part.body.data)
    } else if (decodeBodies && mime === 'text/html' && part.body?.data && bodyHtml === null) {
      bodyHtml = decodeBase64Url(part.body.data)
    }

    if (Array.isArray(part.parts)) {
      part.parts.forEach(walk)
    }
  }
  walk(payload)
  return { bodyText, bodyHtml, attachments }
}

// Normalize a Gmail message resource to the shared shape.
//
// Three call modes (matches the connector's three call sites):
//   {}                                      — metadata only (no parts walk).
//   { includeAttachments: true }             — metadata + attachments[]. Bodies NOT decoded.
//   { includeAttachments: true,
//     includeBodies: true }                  — metadata + attachments[] + bodyText/bodyHtml.
//
// Calling with includeBodies but not includeAttachments is not supported (every
// Gmail format that gives us bodies also gives us attachments; no reason to split).
const normalizeMessage = (gm, { includeAttachments = false, includeBodies = false } = {}) => {
  const payload = gm.payload || {}
  const headers = payload.headers || []
  const labels = gm.labelIds || []
  const isRead = !labels.includes('UNREAD')
  // For format=metadata we infer from the HAS_ATTACHMENT label; when we walk parts
  // ourselves we set it definitively below.
  const hasAttachments = labels.includes('HAS_ATTACHMENT')

  const base = {
    id: gm.id,
    threadId: gm.threadId,
    from: parseAddress(headerValue(headers, 'From')),
    to: parseAddressList(headerValue(headers, 'To')),
    cc: parseAddressList(headerValue(headers, 'Cc')),
    subject: headerValue(headers, 'Subject') || '(no subject)',
    receivedAt: gm.internalDate ? Number(gm.internalDate) : null,
    snippet: gm.snippet || '',
    isRead,
    hasAttachments,
    labels
  }

  if (includeAttachments) {
    const { bodyText, bodyHtml, attachments } = walkPayload(payload, { decodeBodies: includeBodies })
    base.attachments = attachments
    if (attachments.length > 0) base.hasAttachments = true
    if (includeBodies) {
      base.bodyText = bodyText
      base.bodyHtml = bodyHtml
    }
  }

  return base
}

// ---------- public API ----------

/**
 * List Gmail messages with metadata, paginated.
 *
 * Two-call shape: messages.list returns IDs (newest first) + nextPageToken, then
 * messages.get is called per ID with concurrency capped at MAX_PARALLEL (see
 * rate-limit contract in the file header).
 *
 * @param {string} accessToken
 * @param {Object} [options]
 * @param {number} [options.limit=20]              1..100, mapped to Gmail maxResults
 * @param {string} [options.pageToken]             Opaque cursor from a prior call
 * @param {string[]} [options.labelIds]            Default []: no label filter. Gmail uses
 *                                                 repeated `labelIds=` query params (intersection).
 * @param {string} [options.q]                     Provider-native search (Gmail syntax)
 * @param {boolean} [options.includeAttachments]   When true, each row carries an
 *                                                 attachments[] array (and bodies are stripped).
 *                                                 Under the hood uses format=full per message.
 *                                                 Contract is the same for future Graph/IMAP.
 * @returns {Promise<{ messages: Array, nextPageToken: string|null }>}
 */
export const listMessages = async (accessToken, options = {}) => {
  const limit = Math.max(1, Math.min(100, options.limit || 20))
  const params = ['maxResults=' + limit]
  if (options.pageToken) params.push('pageToken=' + encodeURIComponent(options.pageToken))
  if (Array.isArray(options.labelIds)) {
    options.labelIds.forEach(lbl => {
      if (lbl) params.push('labelIds=' + encodeURIComponent(lbl))
    })
  }
  if (options.q) params.push('q=' + encodeURIComponent(options.q))

  const listUrl = GMAIL_BASE + '/messages?' + params.join('&')
  const listData = await gmailFetch(listUrl, accessToken)

  const ids = (listData?.messages || []).map(m => m.id).filter(Boolean)
  const nextPageToken = listData?.nextPageToken || null

  if (ids.length === 0) return { messages: [], nextPageToken }

  const wantAttachments = !!options.includeAttachments
  // Gmail has no "metadata + parts" format — to get the attachments tree at all we
  // need format=full over the wire. We pay the wire-bytes cost but skip the body
  // decode in normalizeMessage so no UTF-8 strings get allocated. See §2.6 of
  // freezr_mail_phase2.md for the cross-provider design.
  const perMessageQuery = wantAttachments
    ? '?format=full'
    : '?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject'

  // Parallel-fetch capped at MAX_PARALLEL — Gmail's per-user concurrent-quota safety.
  const messages = await runConcurrent(ids, MAX_PARALLEL, async (id) => {
    const url = GMAIL_BASE + '/messages/' + encodeURIComponent(id) + perMessageQuery
    const data = await gmailFetch(url, accessToken)
    return normalizeMessage(data, { includeAttachments: wantAttachments })
  })

  // Gmail's list endpoint returns newest-first; runConcurrent preserves input order.
  return { messages, nextPageToken }
}

/**
 * Get one full message including bodies and attachment metadata.
 *
 * @param {string} accessToken
 * @param {string} messageId
 * @returns {Promise<Object>} Normalized message + bodyText/bodyHtml/attachments
 */
export const getFullMessage = async (accessToken, messageId) => {
  if (!messageId) throw new Error('messageId is required')
  const url = GMAIL_BASE + '/messages/' + encodeURIComponent(messageId) + '?format=full'
  const data = await gmailFetch(url, accessToken)
  return normalizeMessage(data, { includeAttachments: true, includeBodies: true })
}

/**
 * Fetch a single attachment's raw bytes. Filename + MIME type are not returned
 * by this endpoint — the caller must already know them from a prior getFullMessage.
 *
 * @param {string} accessToken
 * @param {string} messageId
 * @param {string} attachmentId
 * @returns {Promise<{ buffer: Buffer, sizeBytes: number|null }>}
 */
export const getAttachment = async (accessToken, messageId, attachmentId) => {
  if (!messageId) throw new Error('messageId is required')
  if (!attachmentId) throw new Error('attachmentId is required')
  const url = GMAIL_BASE + '/messages/' + encodeURIComponent(messageId) +
    '/attachments/' + encodeURIComponent(attachmentId)
  const data = await gmailFetch(url, accessToken)
  if (!data?.data) {
    const err = new Error('Empty attachment payload from Gmail')
    err.gmailError = data?.error || null
    throw err
  }
  return {
    buffer: decodeBase64UrlToBuffer(data.data),
    sizeBytes: typeof data.size === 'number' ? data.size : null
  }
}

/**
 * Get the authenticated account's profile (email + mailbox stats + historyId).
 * Used on first connect to populate connection.account_email, and by getNewer
 * as a way to seed the delta cursor on the first call.
 *
 * @param {string} accessToken
 * @returns {Promise<{email:string, messagesTotal?:number, threadsTotal?:number, historyId?:string}>}
 */
export const getAccountProfile = async (accessToken) => {
  const url = GMAIL_BASE + '/profile'
  const data = await gmailFetch(url, accessToken)
  return {
    email: data?.emailAddress || null,
    messagesTotal: data?.messagesTotal || 0,
    threadsTotal: data?.threadsTotal || 0,
    historyId: data?.historyId || null
  }
}

// ============================================
// LISTING / SEARCH / DELTA-SYNC
// ============================================

// Gmail system labels that round-trip to the unified `type: 'system'` shape.
// User-created labels come back as `type: 'user'`. Everything else (e.g.
// CATEGORY_* labels which are Gmail's built-in inbox tabs) is reported with
// its own `labelType` from Gmail so callers can decide what to surface.
const SYSTEM_LABEL_IDS = new Set([
  'INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM', 'IMPORTANT', 'STARRED', 'UNREAD',
  'CHAT', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS',
  'CATEGORY_UPDATES', 'CATEGORY_FORUMS'
])

/**
 * List folders/labels. Returns `[{ id, name, type }]` where `type` is
 * `'system'` or `'user'`. Gmail uses labels (not folders) so the unified
 * "folder" maps directly to a Gmail label id; the `name` is the human-readable
 * label string (nested labels come through as `Parent/Child`).
 *
 * @param {string} accessToken
 * @returns {Promise<Array<{id:string, name:string, type:string}>>}
 */
export const listFolders = async (accessToken) => {
  const data = await gmailFetch(GMAIL_BASE + '/labels', accessToken)
  const labels = Array.isArray(data?.labels) ? data.labels : []
  return labels.map(l => ({
    id: l.id,
    name: l.name,
    type: (l.type === 'system' || SYSTEM_LABEL_IDS.has(l.id)) ? 'system' : 'user'
  }))
}

// Format a unix-ms timestamp to Gmail's `after:`/`before:` accepted form (epoch seconds).
const toEpochSeconds = (ms) => {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.floor(n / 1000)
}

// Translate unified search params to Gmail `q` syntax. Other connectors map
// the same params to their own languages ($search/$filter for Graph, IMAP
// SEARCH for IMAP).
const buildGmailQuery = (params) => {
  const parts = []
  if (params.text) parts.push(params.text)
  if (params.from) parts.push('from:' + JSON.stringify(params.from))
  if (params.to) parts.push('to:' + JSON.stringify(params.to))
  const sinceSec = params.since !== undefined ? toEpochSeconds(params.since) : null
  const beforeSec = params.before !== undefined ? toEpochSeconds(params.before) : null
  if (sinceSec !== null) parts.push('after:' + sinceSec)
  if (beforeSec !== null) parts.push('before:' + beforeSec)
  if (params.hasAttachments === true) parts.push('has:attachment')
  if (params.isRead === true) parts.push('is:read')
  else if (params.isRead === false) parts.push('is:unread')
  return parts.join(' ').trim()
}

/**
 * Structured search across messages. Builds a Gmail `q` from unified params
 * (text, from, to, since, before, isRead, hasAttachments) and a `labels` array
 * that maps onto Gmail labelIds (intersection). Delegates the actual fetch to
 * listMessages so result shape + pagination are identical.
 */
export const searchMessages = async (accessToken, params = {}) => {
  const q = buildGmailQuery(params)
  return listMessages(accessToken, {
    q: q || undefined,
    labelIds: Array.isArray(params.labels) && params.labels.length > 0 ? params.labels : undefined,
    limit: params.limit,
    pageToken: params.pageToken,
    includeAttachments: params.includeAttachments
  })
}

/**
 * Incremental sync via Gmail `users.history.list`. Returns
 * `{ changes, nextToken, expired }`.
 *
 * `lastToken` is a Gmail `historyId` returned by a prior call (or by
 * `getAccountProfile` on first connect). When absent we seed by returning
 * the current historyId with `changes: []`.
 *
 * When Gmail's history window has elapsed (~7 days) it responds 404 with
 * `error.code === 404` / `errors[0].reason === 'notFound'`; we surface that as
 * `expired: true` so the caller knows to do a full re-fetch via listMessages
 * and seed a fresh token.
 *
 * Change shape:
 *   { type: 'messageAdded',   message: <metadata-only normalized row> }
 *   { type: 'messageDeleted', messageId }
 *   { type: 'labelAdded',     messageId, labels }
 *   { type: 'labelRemoved',   messageId, labels }
 */
export const getNewer = async (accessToken, lastToken, options = {}) => {
  if (!lastToken) {
    const profile = await getAccountProfile(accessToken)
    return { changes: [], nextToken: profile.historyId || null, expired: false }
  }

  const limit = Math.max(1, Math.min(500, options.limit || 100))
  const params = ['startHistoryId=' + encodeURIComponent(lastToken), 'maxResults=' + limit]
  // historyTypes filters which event types Gmail returns. Including all four
  // keeps the connector's normalize layer simple — drop unknown types in the
  // switch below.
  ;['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'].forEach(t => {
    params.push('historyTypes=' + t)
  })
  const url = GMAIL_BASE + '/history?' + params.join('&')

  let data
  try {
    data = await gmailFetch(url, accessToken)
  } catch (err) {
    if (err?.status === 404) return { changes: [], nextToken: null, expired: true }
    throw err
  }

  const history = Array.isArray(data?.history) ? data.history : []
  const nextToken = data?.historyId || lastToken
  const changes = []

  // Collect the set of newly-added message IDs so we can fetch their metadata
  // in a single concurrency-capped batch (matches listMessages' approach).
  const addedIds = new Set()
  history.forEach(h => {
    (h.messagesAdded || []).forEach(ma => { if (ma?.message?.id) addedIds.add(ma.message.id) })
  })

  // Fetch metadata for added messages in parallel (capped at MAX_PARALLEL).
  // We use format=metadata: enough to populate the normalized row without the
  // wire-bytes overhead of format=full.
  const addedById = new Map()
  if (addedIds.size > 0) {
    const ids = Array.from(addedIds)
    const fetched = await runConcurrent(ids, MAX_PARALLEL, async (id) => {
      try {
        const url2 = GMAIL_BASE + '/messages/' + encodeURIComponent(id) +
          '?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject'
        const gm = await gmailFetch(url2, accessToken)
        return { id, message: normalizeMessage(gm) }
      } catch (err) {
        // A message can be deleted between the history call and the per-message
        // fetch — surface it as messageDeleted instead of failing the whole batch.
        if (err?.status === 404) return { id, deletedRace: true }
        throw err
      }
    })
    fetched.forEach(r => { addedById.set(r.id, r) })
  }

  history.forEach(h => {
    (h.messagesAdded || []).forEach(ma => {
      const id = ma?.message?.id
      if (!id) return
      const row = addedById.get(id)
      if (row?.deletedRace) {
        changes.push({ type: 'messageDeleted', messageId: id })
      } else if (row?.message) {
        changes.push({ type: 'messageAdded', message: row.message })
      }
    })
    ;(h.messagesDeleted || []).forEach(md => {
      const id = md?.message?.id
      if (id) changes.push({ type: 'messageDeleted', messageId: id })
    })
    ;(h.labelsAdded || []).forEach(la => {
      const id = la?.message?.id
      if (id) changes.push({ type: 'labelAdded', messageId: id, labels: la.labelIds || [] })
    })
    ;(h.labelsRemoved || []).forEach(lr => {
      const id = lr?.message?.id
      if (id) changes.push({ type: 'labelRemoved', messageId: id, labels: lr.labelIds || [] })
    })
  })

  return { changes, nextToken, expired: false }
}

// ============================================
// SEND / DRAFTS — RFC 822 MIME construction
// ============================================
//
// Gmail accepts a base64url-encoded RFC 822 message in `raw`. For replies pass
// the parent's `threadId` alongside in the request body — Gmail uses that to
// attach the new message to the existing thread. In-Reply-To + References
// headers are needed for proper threading both on Gmail's side and for
// downstream clients (Outlook, Apple Mail).
//
// MIME shapes built by buildMime():
//   - text only                 → text/plain; charset=utf-8 (base64)
//   - html only                 → text/html;  charset=utf-8 (base64)
//   - text + html               → multipart/alternative
//   - body + attachments        → multipart/mixed wrapping the body part(s)
//
// Boundary tokens use a randomized 32-char suffix so they can't collide with
// any base64 of the body content.

const randomBoundary = (prefix) => prefix + '-' + Math.random().toString(36).slice(2, 12) +
  Math.random().toString(36).slice(2, 12)

// Encode a UTF-8 string for an RFC 2047 header. Non-ASCII goes to
// `=?UTF-8?B?<base64>?=`. Pure ASCII passes through.
const encodeHeader = (value) => {
  if (value == null) return ''
  const s = String(value)
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?='
}

// Format an address list for a To/Cc/Bcc header. Accepts a string, an array of
// strings, or an array of `{ address, name }` objects.
const formatAddressList = (raw) => {
  if (!raw) return ''
  const arr = Array.isArray(raw) ? raw : [raw]
  return arr.map(item => {
    if (typeof item === 'string') return item.trim()
    if (item && item.address) {
      return item.name
        ? `"${encodeHeader(item.name).replace(/"/g, '\\"')}" <${item.address}>`
        : item.address
    }
    return null
  }).filter(Boolean).join(', ')
}

// Wrap a base64 string at 76 chars per line (RFC 2045 §6.8).
const wrapBase64 = (b64) => b64.match(/.{1,76}/g)?.join('\r\n') || ''

// Base64-encode a UTF-8 body for a single MIME part.
const encodeBodyPart = (mimeType, content) => {
  const b64 = Buffer.from(content || '', 'utf8').toString('base64')
  return [
    'Content-Type: ' + mimeType + '; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(b64)
  ].join('\r\n')
}

// Build a single attachment MIME part. `contentBase64` is the raw base64 (no
// wrapping — we wrap it here).
const encodeAttachmentPart = (att) => {
  const filename = att.filename || 'attachment'
  const mime = att.mimeType || 'application/octet-stream'
  const safeFilename = filename.replace(/"/g, '\\"')
  return [
    `Content-Type: ${mime}; name="${encodeHeader(safeFilename)}"`,
    `Content-Disposition: attachment; filename="${encodeHeader(safeFilename)}"`,
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(att.contentBase64 || '')
  ].join('\r\n')
}

// Build the full RFC 822 message. Returns a UTF-8 string ready to be
// base64url-encoded for Gmail's `raw` field.
const buildMime = ({ to, cc, bcc, subject, bodyText, bodyHtml, attachments, inReplyTo, references, fromHeader }) => {
  const headers = []
  if (fromHeader) headers.push('From: ' + fromHeader)
  headers.push('To: ' + formatAddressList(to))
  if (cc) headers.push('Cc: ' + formatAddressList(cc))
  if (bcc) headers.push('Bcc: ' + formatAddressList(bcc))
  headers.push('Subject: ' + encodeHeader(subject || ''))
  if (inReplyTo) headers.push('In-Reply-To: ' + inReplyTo)
  if (references) headers.push('References: ' + references)
  headers.push('MIME-Version: 1.0')
  headers.push('Date: ' + new Date().toUTCString())

  const hasText = !!bodyText
  const hasHtml = !!bodyHtml
  const hasAttach = Array.isArray(attachments) && attachments.length > 0

  // No attachments — single part or multipart/alternative
  if (!hasAttach) {
    if (hasText && hasHtml) {
      const alt = randomBoundary('alt')
      headers.push(`Content-Type: multipart/alternative; boundary="${alt}"`)
      const body = [
        '--' + alt,
        encodeBodyPart('text/plain', bodyText),
        '--' + alt,
        encodeBodyPart('text/html', bodyHtml),
        '--' + alt + '--',
        ''
      ].join('\r\n')
      return headers.join('\r\n') + '\r\n\r\n' + body
    }
    if (hasHtml) {
      const part = encodeBodyPart('text/html', bodyHtml)
      // The Content-Type for a single-part message goes in the message headers,
      // not as a separate part header. Split + re-emit.
      const lines = part.split('\r\n')
      // lines[0] = Content-Type, lines[1] = CTE, lines[2] = '', body...
      headers.push(lines[0])
      headers.push(lines[1])
      return headers.join('\r\n') + '\r\n\r\n' + lines.slice(3).join('\r\n')
    }
    const part = encodeBodyPart('text/plain', bodyText || '')
    const lines = part.split('\r\n')
    headers.push(lines[0])
    headers.push(lines[1])
    return headers.join('\r\n') + '\r\n\r\n' + lines.slice(3).join('\r\n')
  }

  // With attachments — multipart/mixed wrapping body (single part or alternative)
  const mixed = randomBoundary('mix')
  headers.push(`Content-Type: multipart/mixed; boundary="${mixed}"`)

  let bodyPart
  if (hasText && hasHtml) {
    const alt = randomBoundary('alt')
    bodyPart = [
      `Content-Type: multipart/alternative; boundary="${alt}"`,
      '',
      '--' + alt,
      encodeBodyPart('text/plain', bodyText),
      '--' + alt,
      encodeBodyPart('text/html', bodyHtml),
      '--' + alt + '--'
    ].join('\r\n')
  } else if (hasHtml) {
    bodyPart = encodeBodyPart('text/html', bodyHtml)
  } else {
    bodyPart = encodeBodyPart('text/plain', bodyText || '')
  }

  const parts = ['--' + mixed, bodyPart]
  attachments.forEach(att => {
    parts.push('--' + mixed)
    parts.push(encodeAttachmentPart(att))
  })
  parts.push('--' + mixed + '--')
  parts.push('')

  return headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n')
}

// Base64url encoding (Gmail requirement): standard base64 with `+→-`, `/→_`,
// and `=` padding stripped.
const toBase64Url = (buf) => buf.toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * Send a message. Returns `{ messageId, threadId }`.
 *
 * Pass `inReplyTo` (the parent message's RFC822 Message-ID) AND `threadId`
 * (Gmail's thread id) to attach the reply to an existing thread. References
 * defaults to `inReplyTo` if not provided.
 *
 * @param {string} accessToken
 * @param {Object} params
 * @param {string|Array} params.to
 * @param {string|Array} [params.cc]
 * @param {string|Array} [params.bcc]
 * @param {string} params.subject
 * @param {string} [params.bodyText]
 * @param {string} [params.bodyHtml]
 * @param {Array}  [params.attachments]  [{ filename, mimeType, contentBase64 }]
 * @param {string} [params.inReplyTo]    Parent RFC822 Message-ID.
 * @param {string} [params.references]   Defaults to inReplyTo.
 * @param {string} [params.threadId]     Gmail thread id for replies.
 */
export const sendMessage = async (accessToken, params = {}) => {
  if (!params.to) throw new Error('sendMessage: to is required')
  const mime = buildMime({
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: params.subject,
    bodyText: params.bodyText,
    bodyHtml: params.bodyHtml,
    attachments: params.attachments,
    inReplyTo: params.inReplyTo,
    references: params.references || params.inReplyTo
  })
  const raw = toBase64Url(Buffer.from(mime, 'utf8'))
  const body = { raw }
  if (params.threadId) body.threadId = params.threadId
  const data = await gmailFetch(GMAIL_BASE + '/messages/send', accessToken, { method: 'POST', body })
  return { messageId: data?.id || null, threadId: data?.threadId || null }
}

/**
 * Create a draft. Same params as sendMessage; returns
 * `{ draftId, messageId, threadId }`. The draft is synced back to the
 * provider (visible in Gmail web UI).
 */
export const createDraft = async (accessToken, params = {}) => {
  const mime = buildMime({
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: params.subject,
    bodyText: params.bodyText,
    bodyHtml: params.bodyHtml,
    attachments: params.attachments,
    inReplyTo: params.inReplyTo,
    references: params.references || params.inReplyTo
  })
  const raw = toBase64Url(Buffer.from(mime, 'utf8'))
  const message = { raw }
  if (params.threadId) message.threadId = params.threadId
  const data = await gmailFetch(GMAIL_BASE + '/drafts', accessToken, {
    method: 'POST',
    body: { message }
  })
  return {
    draftId: data?.id || null,
    messageId: data?.message?.id || null,
    threadId: data?.message?.threadId || null
  }
}

// ============================================
// MUTATIONS — markRead / move / trash / delete
// ============================================

/**
 * Mark a message read or unread. Gmail toggles the UNREAD label.
 */
export const markRead = async (accessToken, messageId, isRead) => {
  if (!messageId) throw new Error('markRead: messageId is required')
  const body = isRead === false
    ? { addLabelIds: ['UNREAD'] }
    : { removeLabelIds: ['UNREAD'] }
  const url = GMAIL_BASE + '/messages/' + encodeURIComponent(messageId) + '/modify'
  await gmailFetch(url, accessToken, { method: 'POST', body })
  return { messageId, isRead: isRead !== false }
}

/**
 * Move a message to a target folder/label.
 *
 * Gmail's data model is labels, not folders. To approximate folder-move
 * semantics we:
 *   - Add the target label.
 *   - Remove INBOX if the target isn't INBOX itself (the common "move out of
 *     inbox to a folder" case). User-applied labels are left alone — they're
 *     non-exclusive by design.
 *
 * Graph and IMAP implementations of this same call will be true moves
 * (parentFolderId change / IMAP COPY+EXPUNGE) — same unified contract,
 * provider-specific mechanics.
 */
export const moveMessage = async (accessToken, messageId, targetFolder) => {
  if (!messageId) throw new Error('moveMessage: messageId is required')
  if (!targetFolder) throw new Error('moveMessage: targetFolder is required')
  const body = { addLabelIds: [targetFolder] }
  if (targetFolder !== 'INBOX') body.removeLabelIds = ['INBOX']
  const url = GMAIL_BASE + '/messages/' + encodeURIComponent(messageId) + '/modify'
  await gmailFetch(url, accessToken, { method: 'POST', body })
  return { messageId }
}

/**
 * Send a message to Trash (recoverable). Gmail: POST /messages/{id}/trash.
 */
export const trashMessage = async (accessToken, messageId) => {
  if (!messageId) throw new Error('trashMessage: messageId is required')
  const url = GMAIL_BASE + '/messages/' + encodeURIComponent(messageId) + '/trash'
  await gmailFetch(url, accessToken, { method: 'POST' })
  return { messageId }
}

/**
 * Permanently delete a message (skips Trash). Gmail returns 204 No Content.
 */
export const deleteMessage = async (accessToken, messageId) => {
  if (!messageId) throw new Error('deleteMessage: messageId is required')
  const url = GMAIL_BASE + '/messages/' + encodeURIComponent(messageId)
  await gmailFetch(url, accessToken, { method: 'DELETE' })
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
