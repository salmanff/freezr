// freezr.info - Mail connector: IMAP + SMTP (generic; tuned defaults for Yahoo)
// Pure data-API wrapper for any IMAP/SMTP mailbox. Mirrors the gmail.mjs connector
// surface 1:1 so the mail app (and third-party apps) see the SAME normalized shapes
// regardless of provider — see adapters/connections/gmail.mjs for the canonical shape
// docs. The ONLY public-contract difference is the first argument:
//
//   gmail.mjs    →  connector.fn(accessToken: string, ...)
//   imap.mjs     →  connector.fn(credentials: object, ...)
//
// mailService.mjs special-cases provider==='imap' and passes the decrypted
// credentials object instead of an OAuth access token (IMAP app-password auth has
// no token to refresh). credentials shape:
//
//   {
//     imap: { host, port, secure, user, pass },   // IMAP login (app password for Yahoo)
//     smtp: { host, port, secure, user, pass },   // SMTP login for sending
//     email: 'me@yahoo.com'                        // the account address (From: header)
//   }
//
// ---------------------------------------------------------------------------
// AUTH: app password, NOT OAuth. Yahoo's OAuth/XOAUTH2 requires a signed
// Commercial Access Agreement (see freezr_mail_plan_v1.md §4c / §2), so the
// realistic path for a personal Yahoo account is a Yahoo-generated app password.
// Static credentials → no refresh, no token_expired cascade.
//
// RATE-LIMIT / TRANSPORT: the §4d HTTP transport contract (runConcurrent +
// fetchWithRetry in _shared.mjs) is HTTP-only and does NOT apply here — imapflow
// owns its own connection/reconnect. Each connector call opens one short-lived
// IMAP connection, does its work under a mailbox lock, and logs out (withImap()).
// This is stateless-feeling and correct under freezr's current on-demand, single-
// user load; a future pooled/IDLE connection is a separate optimization.
//
// ---------------------------------------------------------------------------
// v1 SCOPE LIMITATIONS (intentional — keeps the first cut tractable; tracked in
// freezr_mail_plan_v1.md):
//   - listMessages / searchMessages / getNewer operate on a SINGLE folder,
//     defaulting to INBOX. (options.labelIds[0] / params.labels[0] selects another
//     folder, but there is no cross-folder "all mail" view — IMAP has no global
//     mailbox delta.) listFolders still returns every folder.
//   - getNewer detects ADDITIONS only (new UIDs in the watched folder). It does
//     NOT surface provider-side deletions or flag changes the way Gmail history
//     does. uidValidity change → { expired: true } so the caller re-seeds.
//   - searchMessages ignores hasAttachments (no reliable IMAP server-side filter).
//   - No threads in IMAP: threadId is always null. Reply threading rides on the
//     RFC-822 Message-ID via In-Reply-To / References (see sendMessage).
//
// IDs: IMAP UIDs are folder-scoped and only meaningful alongside the folder's
// UIDVALIDITY. So a normalized message `id` is `<b64url(folder)>:<uidvalidity>:<uid>`.
// Every per-message call decodes that, opens the folder, and verifies UIDVALIDITY
// still matches (throws a clear error if the folder was reset under us).

import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'

// Special-use folder flags we treat as "system" folders (RFC 6154).
const SPECIAL_USE_SYSTEM = new Set(['\\Inbox', '\\Sent', '\\Drafts', '\\Trash', '\\Junk', '\\Archive', '\\All', '\\Flagged'])

// ---------- credentials / connection lifecycle ----------

const imapConfig = (creds) => {
  const c = creds?.imap
  if (!c || !c.host || !c.user || !c.pass) {
    const err = new Error('imap connector: credentials.imap requires host, user and pass')
    err.code = 'imap_no_credentials'
    throw err
  }
  return {
    host: c.host,
    port: c.port || 993,
    secure: c.secure !== false, // default to implicit TLS (993)
    auth: { user: c.user, pass: c.pass },
    logger: false,
    // Yahoo (and most providers) are fine with a modest timeout; a hung socket
    // shouldn't pin the request forever.
    socketTimeout: 60 * 1000,
    greetingTimeout: 20 * 1000
  }
}

/**
 * Open one IMAP connection, run `fn(client)`, and always log out. Auth failures
 * are tagged with `.code = 'imap_auth_failed'` so the service/route layer can
 * map them to a re-enter-credentials prompt later if desired.
 */
const withImap = async (creds, fn) => {
  const client = new ImapFlow(imapConfig(creds))
  try {
    await client.connect()
  } catch (err) {
    const e = new Error('IMAP connection/login failed: ' + (err?.message || err))
    e.code = (err?.authenticationFailed || /auth/i.test(err?.message || '')) ? 'imap_auth_failed' : 'imap_connect_failed'
    e.status = e.code === 'imap_auth_failed' ? 401 : 502
    throw e
  }
  try {
    return await fn(client)
  } finally {
    try { await client.logout() } catch (_) { try { client.close() } catch (_) { /* ignore */ } }
  }
}

/**
 * Open one IMAP connection and hold a mailbox lock on `folder` for `fn(client, lock)`.
 * Releases the lock and logs out in all cases. Verifies UIDVALIDITY when the caller
 * passed one (per-message ops decoded from a message id).
 */
const withMailbox = async (creds, folder, fn, { expectUidValidity = null } = {}) =>
  withImap(creds, async (client) => {
    const lock = await client.getMailboxLock(folder)
    try {
      const mailbox = client.mailbox
      if (expectUidValidity != null && mailbox && String(mailbox.uidValidity) !== String(expectUidValidity)) {
        const e = new Error('IMAP UIDVALIDITY changed for folder "' + folder + '" — message id is stale; re-list to get fresh ids')
        e.code = 'imap_uidvalidity_changed'
        throw e
      }
      return await fn(client, mailbox)
    } finally {
      lock.release()
    }
  })

// ---------- id codec (folder + uidvalidity + uid) ----------

const encodeId = (folder, uidValidity, uid) =>
  Buffer.from(folder, 'utf8').toString('base64url') + ':' + uidValidity + ':' + uid

const decodeId = (id) => {
  if (!id || typeof id !== 'string') {
    const e = new Error('imap connector: invalid message id'); e.code = 'imap_bad_id'; throw e
  }
  const parts = id.split(':')
  if (parts.length < 3) {
    const e = new Error('imap connector: malformed message id "' + id + '"'); e.code = 'imap_bad_id'; throw e
  }
  const uid = parts.pop()
  const uidValidity = parts.pop()
  const folder = Buffer.from(parts.join(':'), 'base64url').toString('utf8')
  return { folder, uidValidity, uid: Number(uid) }
}

// ---------- normalization helpers ----------

// Map an imapflow envelope address [{ name, address }] to the shared { address, name }.
const mapAddr = (a) => (a && a.address) ? { address: a.address, name: a.name || null } : null
const mapAddrList = (arr) => Array.isArray(arr) ? arr.map(mapAddr).filter(Boolean) : []

// Walk an imapflow bodyStructure tree and collect attachment metadata. Bodies
// (the primary text/plain + text/html parts) are NOT attachments. We surface the
// IMAP part number as `id` so getAttachment can fetch the raw bytes by part later.
const collectAttachments = (node, out = []) => {
  if (!node) return out
  if (Array.isArray(node.childNodes) && node.childNodes.length > 0) {
    node.childNodes.forEach(child => collectAttachments(child, out))
    return out
  }
  const mime = (node.type || '').toLowerCase()
  const disposition = (node.disposition || '').toLowerCase()
  const filename = node.dispositionParameters?.filename || node.parameters?.name || null
  const isBodyText = (mime === 'text/plain' || mime === 'text/html') && disposition !== 'attachment' && !filename
  if (isBodyText) return out
  // Anything else with a part number is an attachment (or an inline image).
  if (node.part) {
    const contentId = (node.id || '').replace(/^</, '').replace(/>$/, '').trim() || null
    out.push({
      id: node.part,
      filename: filename || '(unnamed)',
      mimeType: node.type || 'application/octet-stream',
      sizeBytes: node.size || 0,
      contentId,
      inline: disposition === 'inline' || !!contentId
    })
  }
  return out
}

// Extract the References header from the raw header block returned by an
// imapflow `headers: [...]` fetch. Folded continuation lines are joined first;
// the value is kept as the raw space-separated Message-ID list (angle brackets
// included), matching what sendMessage accepts as `references`.
const parseReferences = (headersBuf) => {
  if (!headersBuf) return null
  const unfolded = headersBuf.toString('utf8').replace(/\r?\n[ \t]+/g, ' ')
  const m = unfolded.match(/^references:[ \t]*(.+)$/im)
  return m ? m[1].trim() : null
}

// Normalize an imapflow fetch message object to the shared row shape.
//   normalizeMessage(msg, folder, uidValidity)                  — metadata + attachments
//   normalizeMessage(msg, folder, uidValidity, { body })        — + bodyText/bodyHtml
// `body` is { text, html } decoded by getFullMessage (via imapflow's download(),
// which already decodes transfer-encoding and converts text parts to UTF-8).
const normalizeMessage = (msg, folder, uidValidity, { body = null } = {}) => {
  const env = msg.envelope || {}
  const flags = msg.flags || new Set()
  const attachments = collectAttachments(msg.bodyStructure)
  const receivedAt = msg.internalDate
    ? new Date(msg.internalDate).getTime()
    : (env.date ? new Date(env.date).getTime() : null)

  const base = {
    id: encodeId(folder, uidValidity, msg.uid),
    threadId: null, // IMAP has no threads; reply threading rides on messageId/references
    messageId: env.messageId || null, // RFC-822 Message-ID — used as inReplyTo on replies
    inReplyTo: env.inReplyTo || null, // RFC-822 In-Reply-To (from the IMAP envelope)
    references: parseReferences(msg.headers), // RFC-822 References (via FETCH_META headers)
    from: mapAddr((env.from || [])[0]),
    to: mapAddrList(env.to),
    cc: mapAddrList(env.cc),
    subject: env.subject || '(no subject)',
    receivedAt,
    snippet: '', // IMAP exposes no server-side snippet; left empty (filled by getFullMessage callers if they want)
    isRead: flags.has('\\Seen'),
    hasAttachments: attachments.length > 0,
    labels: [folder],
    attachments
  }

  if (body) {
    base.bodyText = body.text || null
    base.bodyHtml = body.html || null
    if (!base.snippet && body.text) base.snippet = body.text.replace(/\s+/g, ' ').trim().slice(0, 200)
  }
  return base
}

const FETCH_META = { uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true, headers: ['references'] }

// Walk a bodyStructure tree to find the part numbers of the primary text/plain and
// text/html bodies (the first of each that isn't an attachment). A single-part
// message has no childNodes and no part number — imapflow's download() maps part
// '1' to the message TEXT in that case, so we default to '1'.
const findBodyParts = (node, found = { text: null, html: null }) => {
  if (!node) return found
  if (Array.isArray(node.childNodes) && node.childNodes.length > 0) {
    node.childNodes.forEach(child => findBodyParts(child, found))
    return found
  }
  const mime = (node.type || '').toLowerCase()
  const disposition = (node.disposition || '').toLowerCase()
  const filename = node.dispositionParameters?.filename || node.parameters?.name
  if (disposition === 'attachment' || filename) return found
  const part = node.part || '1'
  if (mime === 'text/plain' && !found.text) found.text = part
  else if (mime === 'text/html' && !found.html) found.html = part
  return found
}

// Download one bodystructure part and return it as a UTF-8 string. imapflow's
// download() runs the full decode pipeline (base64/quoted-printable → binary,
// format=flowed, and non-UTF-8 charset → UTF-8 for text parts), so the bytes we
// concat here are already decoded text — no mailparser needed.
const downloadPartToString = async (client, uid, part) => {
  const dl = await client.download(String(uid), part, { uid: true })
  if (!dl || !dl.content) return null
  const chunks = []
  for await (const chunk of dl.content) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const folderFromOptions = (labelsOrLabelIds) =>
  (Array.isArray(labelsOrLabelIds) && labelsOrLabelIds[0]) ? labelsOrLabelIds[0] : 'INBOX'

// Resolve a special-use folder (e.g. '\\Sent', '\\Trash') to its real path, with
// a list of fallback names if the server doesn't advertise special-use.
const resolveSpecialFolder = async (client, specialUse, fallbackNames) => {
  const list = await client.list()
  const byUse = list.find(f => f.specialUse === specialUse)
  if (byUse) return byUse.path
  const lowerFallbacks = fallbackNames.map(n => n.toLowerCase())
  const byName = list.find(f => lowerFallbacks.includes((f.name || '').toLowerCase()) || lowerFallbacks.includes((f.path || '').toLowerCase()))
  return byName ? byName.path : null
}

// ---------- public API: listing / fetch ----------

/**
 * List messages in one folder (default INBOX), newest first, paginated by UID.
 *
 * Pagination: `pageToken` is the lowest UID returned by the previous page; the
 * next page returns UIDs strictly below it. `nextPageToken` is null on the last page.
 *
 * @param {object} creds
 * @param {object} [options]
 * @param {number} [options.limit=20]
 * @param {string} [options.pageToken]            Lowest UID from the prior page
 * @param {string[]} [options.labelIds]           [folder] — only the first is used (v1)
 * @param {boolean} [options.includeAttachments]  Kept for shape-parity; IMAP always
 *                                                 returns attachments[] metadata anyway.
 * @returns {Promise<{ messages: Array, nextPageToken: string|null }>}
 */
export const listMessages = async (creds, options = {}) => {
  const limit = Math.max(1, Math.min(100, options.limit || 20))
  const folder = folderFromOptions(options.labelIds)
  const beforeUid = options.pageToken ? Number(options.pageToken) : null
  return withMailbox(creds, folder, async (client, mailbox) => {
    const uidValidity = mailbox.uidValidity
    // All UIDs in the folder, ascending. For a personal mailbox this is a list of
    // ints — cheap. (A huge mailbox would want a range search; deferred.)
    let uids = await client.search({ all: true }, { uid: true })
    if (!Array.isArray(uids)) uids = []
    if (beforeUid != null) uids = uids.filter(u => u < beforeUid)
    uids.sort((a, b) => a - b)
    const pageUids = uids.slice(-limit) // newest `limit`
    const nextPageToken = uids.length > pageUids.length ? String(pageUids[0]) : null
    if (pageUids.length === 0) return { messages: [], nextPageToken: null }

    const rows = []
    for await (const msg of client.fetch(pageUids.join(','), FETCH_META, { uid: true })) {
      rows.push(normalizeMessage(msg, folder, uidValidity))
    }
    rows.sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0)) // newest first
    return { messages: rows, nextPageToken }
  })
}

/**
 * Get one full message including decoded bodies + attachment metadata.
 * Reads the IMAP bodyStructure (one round-trip), then downloads the primary
 * text/plain and text/html parts via imapflow's download() — which decodes
 * transfer-encoding and converts text to UTF-8 for us. Attachment part numbers
 * come from the same bodyStructure so a later getAttachment(messageId,
 * attachmentId) can fetch the bytes.
 */
export const getFullMessage = async (creds, messageId) => {
  const { folder, uidValidity, uid } = decodeId(messageId)
  return withMailbox(creds, folder, async (client) => {
    const msg = await client.fetchOne(String(uid), FETCH_META, { uid: true })
    if (!msg) {
      const e = new Error('Message not found: ' + messageId); e.code = 'imap_not_found'; e.status = 404; throw e
    }
    const parts = findBodyParts(msg.bodyStructure)
    const text = parts.text ? await downloadPartToString(client, uid, parts.text) : null
    const html = parts.html ? await downloadPartToString(client, uid, parts.html) : null
    return normalizeMessage(msg, folder, uidValidity, { body: { text, html } })
  }, { expectUidValidity: uidValidity })
}

/**
 * Fetch one attachment's raw bytes by IMAP part number.
 * @returns {Promise<{ buffer: Buffer, sizeBytes: number|null }>}
 */
export const getAttachment = async (creds, messageId, attachmentId) => {
  if (!attachmentId) { const e = new Error('attachmentId (IMAP part number) is required'); e.code = 'imap_bad_part'; throw e }
  const { folder, uidValidity, uid } = decodeId(messageId)
  return withMailbox(creds, folder, async (client) => {
    const dl = await client.download(String(uid), attachmentId, { uid: true })
    if (!dl || !dl.content) {
      const e = new Error('Empty attachment payload from IMAP'); e.code = 'imap_no_attachment'; e.status = 404; throw e
    }
    const chunks = []
    for await (const chunk of dl.content) chunks.push(chunk)
    const buffer = Buffer.concat(chunks)
    return { buffer, sizeBytes: buffer.length }
  }, { expectUidValidity: uidValidity })
}

/**
 * Account profile — email + INBOX message count. (No history cursor for IMAP.)
 */
export const getAccountProfile = async (creds) => {
  return withImap(creds, async (client) => {
    let messagesTotal = 0
    try {
      const status = await client.status('INBOX', { messages: true })
      messagesTotal = status?.messages || 0
    } catch (_) { /* non-fatal */ }
    return { email: creds?.email || creds?.imap?.user || null, messagesTotal }
  })
}

/**
 * List folders → [{ id, name, type }]. `type` is 'system' for special-use folders
 * (INBOX/Sent/Trash/Drafts/Junk/Archive) else 'user'. `id` is the full IMAP path
 * (use it as labelIds[0] / targetFolder).
 */
export const listFolders = async (creds) => {
  return withImap(creds, async (client) => {
    const list = await client.list()
    return (list || []).map(f => {
      const isInbox = (f.path || '').toUpperCase() === 'INBOX'
      const isSystem = isInbox || (f.specialUse && SPECIAL_USE_SYSTEM.has(f.specialUse))
      return { id: f.path, name: f.name || f.path, type: isSystem ? 'system' : 'user' }
    })
  })
}

// ---------- search ----------

// Translate the unified search params to an imapflow SEARCH query (one folder).
const buildImapSearch = (params) => {
  const q = {}
  if (params.text) q.or = [{ subject: params.text }, { body: params.text }, { from: params.text }]
  if (params.from) q.from = params.from
  if (params.to) q.to = params.to
  if (params.since !== undefined && params.since !== null) q.since = new Date(Number(params.since))
  if (params.before !== undefined && params.before !== null) q.before = new Date(Number(params.before))
  if (params.isRead === true) q.seen = true
  else if (params.isRead === false) q.seen = false
  // params.hasAttachments: no reliable server-side IMAP filter — ignored in v1.
  if (Object.keys(q).length === 0) q.all = true
  return q
}

/**
 * Structured search in one folder (default INBOX). Same result shape as listMessages.
 */
export const searchMessages = async (creds, params = {}) => {
  const limit = Math.max(1, Math.min(100, params.limit || 20))
  const folder = folderFromOptions(params.labels)
  const beforeUid = params.pageToken ? Number(params.pageToken) : null
  const query = buildImapSearch(params)
  return withMailbox(creds, folder, async (client, mailbox) => {
    const uidValidity = mailbox.uidValidity
    let uids = await client.search(query, { uid: true })
    if (!Array.isArray(uids)) uids = []
    if (beforeUid != null) uids = uids.filter(u => u < beforeUid)
    uids.sort((a, b) => a - b)
    const pageUids = uids.slice(-limit)
    const nextPageToken = uids.length > pageUids.length ? String(pageUids[0]) : null
    if (pageUids.length === 0) return { messages: [], nextPageToken: null }
    const rows = []
    for await (const msg of client.fetch(pageUids.join(','), FETCH_META, { uid: true })) {
      rows.push(normalizeMessage(msg, folder, uidValidity))
    }
    rows.sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0))
    return { messages: rows, nextPageToken }
  })
}

// ---------- delta sync (additions only, one folder) ----------

const encodeToken = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')
const decodeToken = (token) => {
  try { return JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) } catch (_) { return null }
}

/**
 * Incremental sync for one folder (default INBOX). Returns { changes, nextToken, expired }.
 *
 * `lastToken` is an opaque base64url cursor produced by a prior call (encodes
 * `{ folder, uidValidity, lastUid }`). First call (no token) seeds: returns the
 * current high-water UID with changes:[]. Subsequent calls return new messages
 * (UID > lastUid) as `{ type: 'messageAdded', message }`.
 *
 * v1 caveat: additions only. If UIDVALIDITY changed, returns `{ expired: true }`
 * so the caller re-lists and re-seeds (mirrors Gmail history expiry).
 */
export const getNewer = async (creds, lastToken, options = {}) => {
  const limit = Math.max(1, Math.min(500, options.limit || 100))
  const folder = (options.labelIds && options.labelIds[0]) || 'INBOX'
  return withMailbox(creds, folder, async (client, mailbox) => {
    const uidValidity = String(mailbox.uidValidity)
    const highUid = (mailbox.uidNext || 1) - 1

    if (!lastToken) {
      return { changes: [], nextToken: encodeToken({ folder, uidValidity, lastUid: highUid }), expired: false }
    }
    const prev = decodeToken(lastToken)
    if (!prev || prev.folder !== folder) {
      return { changes: [], nextToken: encodeToken({ folder, uidValidity, lastUid: highUid }), expired: true }
    }
    if (String(prev.uidValidity) !== uidValidity) {
      return { changes: [], nextToken: null, expired: true }
    }
    const lastUid = Number(prev.lastUid) || 0
    if (highUid <= lastUid) {
      return { changes: [], nextToken: encodeToken({ folder, uidValidity, lastUid }), expired: false }
    }
    // New UIDs are (lastUid+1 .. *). Search to get the actual set, cap at limit.
    let uids = await client.search({ uid: (lastUid + 1) + ':*' }, { uid: true })
    if (!Array.isArray(uids)) uids = []
    uids = uids.filter(u => u > lastUid).sort((a, b) => a - b).slice(0, limit)
    const changes = []
    let newHigh = lastUid
    if (uids.length > 0) {
      for await (const msg of client.fetch(uids.join(','), FETCH_META, { uid: true })) {
        changes.push({ type: 'messageAdded', message: normalizeMessage(msg, folder, uidValidity) })
        if (msg.uid > newHigh) newHigh = msg.uid
      }
    }
    return { changes, nextToken: encodeToken({ folder, uidValidity, lastUid: newHigh }), expired: false }
  })
}

// ---------- send / drafts (SMTP + IMAP APPEND) ----------

const smtpTransport = (creds) => {
  const s = creds?.smtp
  if (!s || !s.host || !s.user || !s.pass) {
    const err = new Error('imap connector: credentials.smtp requires host, user and pass to send'); err.code = 'smtp_no_credentials'; throw err
  }
  return nodemailer.createTransport({
    host: s.host,
    port: s.port || 465,
    secure: s.secure !== false, // 465 implicit TLS by default; set secure:false for 587 STARTTLS
    auth: { user: s.user, pass: s.pass }
  })
}

// Normalize the unified attachment shape [{ filename, mimeType, contentBase64 }]
// to nodemailer's [{ filename, content: Buffer, contentType }].
const toNodemailerAttachments = (attachments) =>
  (Array.isArray(attachments) ? attachments : []).map(a => ({
    filename: a.filename || 'attachment',
    content: Buffer.from(a.contentBase64 || '', 'base64'),
    contentType: a.mimeType || 'application/octet-stream',
    cid: a.contentId || undefined
  }))

// Compose a message to a raw RFC-822 Buffer WITHOUT sending (nodemailer stream
// transport, buffered). Returns { raw, messageId, envelope }. We reuse the raw
// bytes for both the SMTP send and the IMAP APPEND so the Sent/Drafts copy is
// byte-identical to what went out.
const composeRaw = async (creds, params) => {
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' })
  const mailOptions = {
    from: creds?.email || creds?.smtp?.user,
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: params.subject || '',
    text: params.bodyText || undefined,
    html: params.bodyHtml || undefined,
    attachments: toNodemailerAttachments(params.attachments),
    inReplyTo: params.inReplyTo || undefined,
    references: params.references || params.inReplyTo || undefined
  }
  const info = await composer.sendMail(mailOptions)
  return { raw: info.message, messageId: info.messageId, envelope: info.envelope }
}

// Best-effort APPEND of a raw message to a special-use folder (Sent / Drafts).
const appendToFolder = async (creds, specialUse, fallbackNames, raw, flags) => {
  return withImap(creds, async (client) => {
    const path = await resolveSpecialFolder(client, specialUse, fallbackNames)
    if (!path) return null
    try {
      const res = await client.append(path, raw, flags)
      return (res && res.uid && res.uidValidity) ? { path, uid: res.uid, uidValidity: res.uidValidity } : { path }
    } catch (e) {
      return null // APPEND is best-effort; failing it shouldn't fail the send
    }
  })
}

/**
 * Send a message via SMTP, then APPEND a copy to the Sent folder. Returns
 * { messageId, threadId } (threadId always null for IMAP). For replies pass
 * `inReplyTo` (parent RFC-822 Message-ID); `references` defaults to it.
 */
export const sendMessage = async (creds, params = {}) => {
  if (!params.to) { const e = new Error('sendMessage: to is required'); e.code = 'imap_no_recipient'; throw e }
  const { raw, messageId, envelope } = await composeRaw(creds, params)
  const transport = smtpTransport(creds)
  try {
    await transport.sendMail({ envelope, raw })
  } finally {
    try { transport.close() } catch (_) { /* ignore */ }
  }
  await appendToFolder(creds, '\\Sent', ['Sent', 'Sent Items', 'Sent Messages'], raw, ['\\Seen'])
  return { messageId: messageId || null, threadId: null }
}

/**
 * Create a draft by APPENDing to the Drafts folder with the \Draft flag.
 * Returns { draftId, messageId, threadId }. draftId is a normal message id when
 * the server supports UIDPLUS (so it can later be fetched/deleted), else null.
 */
export const createDraft = async (creds, params = {}) => {
  const { raw, messageId } = await composeRaw(creds, params)
  const appended = await appendToFolder(creds, '\\Drafts', ['Drafts', 'Draft'], raw, ['\\Draft'])
  const draftId = (appended && appended.uid && appended.uidValidity)
    ? encodeId(appended.path, appended.uidValidity, appended.uid)
    : null
  return { draftId, messageId: messageId || null, threadId: null }
}

// ---------- mutations: markRead / move / trash / delete ----------

/**
 * Mark a message read/unread by toggling the \Seen flag.
 */
export const markRead = async (creds, messageId, isRead) => {
  const { folder, uidValidity, uid } = decodeId(messageId)
  return withMailbox(creds, folder, async (client) => {
    if (isRead === false) await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true })
    else await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true })
    return { messageId, isRead: isRead !== false }
  }, { expectUidValidity: uidValidity })
}

/**
 * Move a message to another folder (true IMAP MOVE, falls back to COPY+delete via
 * imapflow when the server lacks MOVE). `targetFolder` is a folder path from listFolders.
 * NOTE: the message's UID changes in the destination, so the returned messageId no
 * longer resolves — callers should re-list the target folder to get the new id.
 */
export const moveMessage = async (creds, messageId, targetFolder) => {
  if (!targetFolder) { const e = new Error('moveMessage: targetFolder is required'); e.code = 'imap_no_target'; throw e }
  const { folder, uidValidity, uid } = decodeId(messageId)
  return withMailbox(creds, folder, async (client) => {
    await client.messageMove(String(uid), targetFolder, { uid: true })
    return { messageId }
  }, { expectUidValidity: uidValidity })
}

/**
 * Move a message to the Trash folder (recoverable). Resolves the special-use
 * \Trash folder (fallback names 'Trash'). If none exists, throws.
 */
export const trashMessage = async (creds, messageId) => {
  const { folder, uidValidity, uid } = decodeId(messageId)
  return withImap(creds, async (client) => {
    const trash = await resolveSpecialFolder(client, '\\Trash', ['Trash', 'Deleted', 'Deleted Items', 'Deleted Messages'])
    if (!trash) { const e = new Error('No Trash folder found on this account'); e.code = 'imap_no_trash'; throw e }
    const lock = await client.getMailboxLock(folder)
    try {
      const mailbox = client.mailbox
      if (mailbox && String(mailbox.uidValidity) !== String(uidValidity)) {
        const e = new Error('IMAP UIDVALIDITY changed — message id is stale'); e.code = 'imap_uidvalidity_changed'; throw e
      }
      await client.messageMove(String(uid), trash, { uid: true })
    } finally {
      lock.release()
    }
    return { messageId }
  })
}

/**
 * Permanently delete a message (sets \Deleted + EXPUNGE). Irreversible.
 */
export const deleteMessage = async (creds, messageId) => {
  const { folder, uidValidity, uid } = decodeId(messageId)
  return withMailbox(creds, folder, async (client) => {
    await client.messageDelete(String(uid), { uid: true })
    return { messageId }
  }, { expectUidValidity: uidValidity })
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
