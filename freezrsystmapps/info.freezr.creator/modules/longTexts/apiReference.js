export const API_REFERENCE = `
## freezr API Reference (freezrApiV2.js)

This file is automatically included in your app. Do NOT modify it.
The global \`freezr\` object and \`freezrMeta\` are available in all module scripts.
\`freezr.initPageScripts()\` (async) is called automatically on window load — app scripts should use it as their entry point or handle their own initialisation after it resolves.

\`freezrMeta\` properties: \`appName\`, \`userId\`, \`serverAddress\`, \`appToken\`, \`serverVersion\`.
Additional booleans: \`freezr.adminUser\`, \`freezr.publisherUser\`.

---

### Core CRUD

\`\`\`javascript
// Create a new record. Returns { _id, ... }.
await freezr.create(collectionOrAppTable, data, options?)
// options: { appToken, host, data_object_id, upsert, permission_name, owner_id, requestee_app }
// The function returns the _id and the _date_modified

// Read a single record by ID. Returns the record object.
await freezr.read(collectionOrAppTable, id, options?)
// options: { appToken, host, permission_name, owner_id, requestee_app }

// Query records. Returns an array of matching records.
await freezr.query(collectionOrAppTable, query?, options?)
// query: MongoDB-compatible filter object (e.g. { status: 'active' })
// options: { appToken, count, skip, sort, permission_name, owner_id, requestee_app }
// The function returns an array of records (not an object, unless there is an error).
// INDEXING: only _date_modified (auto-set on every record) and _id are reliably indexed on all
// backends. For "recent records" prefer sort: { _date_modified: -1 }. Filtering/sorting on other
// fields works on some backends but fails where indexing is enforced — if you must, tell the user
// they need to create an index for that field/table manually.

// Replace an entire record by ID.
await freezr.update(collectionOrAppTable, id, data, options?)
// options: { appToken, host, permission_name, owner_id }

// Partial update — set only specific fields.
await freezr.updateFields(collectionOrAppTable, idOrQuery, fields, options?)
// idOrQuery: a string ID or a query object to match records
// fields: object of field names and new values
// options: { appToken, host, permission_name, owner_id }

// Delete a record by ID, or multiple records matching a query object.
await freezr.delete(collectionOrAppTable, idOrQuery, options?)
// options: { appToken, host, permission_name, owner_id }
\`\`\`

\`collectionOrAppTable\` can be a simple collection name (e.g. \`'posts'\`) or a full app_table with dots (e.g. \`'com.example.myapp.posts'\`). Simple names are auto-prefixed with the current app name.

---

### Public Queries

\`\`\`javascript
// Query publicly shared records (no login required).
// Returns an array of public records.
await freezr.publicquery(options)
// options: { app_table, owner, host, appToken, ...query parameters }
\`\`\`

---

### Collection Factory

\`\`\`javascript
// Returns an object with bound create/read/query/update/updateFields/delete methods.
const posts = freezr.collection('posts')
await posts.create(data)
await posts.query({ status: 'draft' })
\`\`\`

---

### File Operations

How file storage works in freezr: every uploaded file has TWO parts that stay in sync —
(1) the file bytes, stored on disk at a path you choose, and (2) a record in the app's special
\`files\` collection. The record's \`_id\` IS the file's path. You do NOT need a separate
collection to track files or their metadata: put your own fields in \`options.data\` and they are
merged onto that same \`files\` record. Read/query them like any collection (e.g.
\`freezr.collection('files')\`, \`freezr.query('files', { _file_extension: 'pdf' })\`).

\`\`\`javascript
// Upload a file. Returns { _id } — the _id is the file's path within the app's files area.
await freezr.upload(file, options?)
// file: a browser File object
// options:
//   targetFolder   // optional folder path, e.g. 'invoices/2026'. THIS is how you choose folders.
//                  //   Nest as deep as you like with '/'. The record _id becomes
//                  //   targetFolder + '/' + fileName. Folders are created as needed.
//   fileName       // optional single file name; defaults to the File object's own name.
//   data           // optional object of YOUR OWN metadata, merged onto the files record.
//   doNotOverWrite // default false; if true, fail instead of overwriting an existing file
//   convertPict    // optional image-resize/convert options
//   appToken, host // advanced / cross-host

// Get a URL for a file (synchronous). Returns a URL string. fileId is the record _id (the path).
freezr.getFileUrl(fileId, options?)
// options: { requestee_app, permission_name, requestee_user_id }

// Delete an uploaded file (removes both the bytes and the files record). fileId is the record _id.
await freezr.deleteFile(fileId, options?)
\`\`\`

**Choosing the folder / path.** The path comes ONLY from \`options.targetFolder\` (+ \`options.fileName\`)
— NOT from slashes inside the file name. \`fileName\` must be a single segment: '/' (and '\\\\') are
rejected. Both \`targetFolder\` segments and \`fileName\` may use only letters, digits, spaces, and
\`. _ -\`. There is no \`options.path\` or \`options.folder\` — use \`targetFolder\`.

\`\`\`javascript
// File goes to <files>/invoices/2026/march.pdf ; record _id is 'invoices/2026/march.pdf'
await freezr.upload(file, { targetFolder: 'invoices/2026', fileName: 'march.pdf' })
\`\`\`

**Attaching & querying metadata.** Pass an \`options.data\` OBJECT — there is no \`options.meta\`.
Its keys are merged as TOP-LEVEL fields on the files record (not nested under a \`meta\` key), so you
query them directly. Keep your field names un-prefixed (the \`_\`-prefixed ones are reserved/system).

\`\`\`javascript
await freezr.upload(file, {
  targetFolder: 'attachments',
  data: { message_id: 'msg_123', caption: 'Q1 report', tags: ['finance'] }
})
// Query by your metadata — top-level field, NOT 'meta.message_id':
const recs = await freezr.query('files', { message_id: 'msg_123' })
// (If you prefer a nested shape, pass data: { meta: { message_id } } and query
//  freezr.query('files', { 'meta.message_id': 'msg_123' }) — but that nesting is your choice,
//  the framework does not add a 'meta' wrapper.)
\`\`\`

The \`files\` record that freezr writes for every upload contains:

\`\`\`javascript
{
  _id: 'invoices/2026/march.pdf', // the file path = targetFolder + '/' + fileName
  ...yourDataFields,              // whatever you passed in options.data
  _mime_type: 'application/pdf',  // set automatically from the upload
  _file_extension: 'pdf',         // set automatically (lower-case, no dot)
  _file_size: 184320,             // set automatically (bytes actually written)
  _UploadStatus: 'complete',      // 'wip' while uploading, 'complete' when done
  _date_created, _date_modified   // set automatically
}
\`\`\`

The \`_mime_type\`, \`_file_extension\`, \`_file_size\` and other \`_\`-prefixed fields are
system-managed — freezr sets them on upload, so anything you put in \`options.data\` cannot
overwrite them. Use them to filter or display files (e.g. show a PDF icon, sort by size) without
storing that info yourself.

**Displaying PRIVATE files in \`<img>\` / \`<video>\` (important).** \`freezr.getFileUrl(id)\` returns the
bare \`/feps/userfiles/...\` path. A native \`<img>\`/\`<video>\`/CSS load can't send an auth header, so a
private file needs a **fileToken** appended to the URL — and so does a \`fetch()\`/\`XHR\` of one, since
that route accepts no other credential. Without it the request fails with \`401 file token missing\`.
Use these helpers (all \`async\`):

\`\`\`javascript
// Best for <img>/<video>/<source> src, and CSS background-image (a URL works either way) —
// appends a short-lived ?fileToken=
img.src = await freezr.utils.tokenizedFileUrl('photos/beach.png')
el.style.backgroundImage = \`url(\${await freezr.utils.tokenizedFileUrl('photos/beach.png')})\`

// Fetching a private file's CONTENT — tokenize the URL first; a bare fetch gets a 401.
const text = await (await fetch(await freezr.utils.tokenizedFileUrl('notes/day1.html'))).text()

// One call after rendering: scan the DOM and tokenize every <img>/<video>/<audio>/<source>
// whose src points at a userfiles URL. Re-callable; pass { force: true } to refresh before the
// token expires (~10 min) on a long-lived page.
await freezr.utils.refreshFileTokens()
// Auto-tokenize images added later too (returns a MutationObserver you can .disconnect()):
const obs = freezr.utils.observeFileTokens()

// Just the raw token (advanced): freezr.utils.getFileToken(fileId, { permission_name })
\`\`\`

Guidance: for \`<img>\`/\`<video>\` tags and CSS backgrounds, set the URL via \`tokenizedFileUrl\` (or call
\`freezr.utils.refreshFileTokens()\` once after you render a batch). Do NOT rely on the browser sending
a cookie — that path is retired; an untokenized private-file load will fail. (For a genuinely PUBLIC
file, share it publicly instead and use its public URL — no token needed.)

---

### Permissions

\`\`\`javascript
// Get all permissions for the current app.
// Returns an array of permission objects with { name, type, granted, ... }.
await freezr.perms.getAppPermissions(options?)

// Check if a specific permission is granted. Returns boolean.
await freezr.perms.isGranted(permissionName)

// Share records publicly or with specific users.
await freezr.perms.shareRecords(idOrQuery, options)
// idOrQuery (precedence):
//   1. string                  → original record _id (DEFAULT)
//   2. array of strings        → bulk by original _ids
//   3. object                  → query_criteria; pass { publicid } when only the publicid is known
// options: { name, table_id, grantees, action, publicid?, pubDate?, doNotList?,
//            forcePublicIdTakeover?,   // grant: clobber a conflicting orphan public record
//            forcePublicIdCleanup? }   // deny: delete an orphan public record when source is gone
// grantees: array — use ['_public'] for public sharing, usernames, or 'app:<appName>' to share
//           with another app of the same user (eg ['app:com.example.otherapp'])
// action: 'grant' or 'deny'
// An app reading records another app shared with it passes requestee_app (query) and
// permission_name (the sharing app's permission) in the read/query options.

// Share an individual file publicly.
await freezr.perms.shareFilePublicly(fileId, options?)
// fileId is the file's record _id for both grant AND revoke.
// options: { name, action, grant, fileStructure?, publicid?, meta?,
//            forcePublicIdTakeover?,
//            byPublicId?,              // revoke: treat fileId as the publicid (legacy / orphan flow)
//            forcePublicIdCleanup? }

// Revoke by publicid only — when the source record's _id / _accessibles entry isn't available.
await freezr.perms.unshareByPublicId(publicid, options)
// options: { name, table_id, grantees?, forcePublicIdCleanup? }

// Validate access to another app's data. Returns { 'access-token': '...' }.
// MUST be called before reading/writing another app's collections.
await freezr.perms.validateDataOwner(options)
// options: { data_owner_user, table_id, permission, app_id?, data_owner_host? }
\`\`\`

---

### Messages

\`\`\`javascript
// Send a message/shared record to another user (or to yourself, eg app-to-app).
await freezr.messages.send(message, options?)
// message: { recipient_id or recipients, messaging_permission, table_id, record_id,
//            recipient_app? (address the message to another app's inbox),
//            contact_permission? (optional) }

// Mark messages as read.
await freezr.messages.markRead(messageIds, markAll?)
// messageIds: array of message IDs, or null if markAll is true

// Get the app's messages: ones it sent plus ones addressed to it via recipient_app.
// options: { count?, skip?, unread_only? } — returns { messages: [...] }
await freezr.messages.getAppMessages(options?)
\`\`\`

---

### LLM (AI)

\`\`\`javascript
// Check if the user has LLM keys configured.
// Returns { success, exists, defaultProvider, defaultFamily, providers, imageProviders?, pricingMeta }
// defaultProvider is the user's default provider name (e.g. 'Claude', 'ChatGPT')
// defaultFamily is the default model family for that provider (e.g. 'sonnet', 'mini')
// providers[name] is an array of { id, family, provider, version, latest, pricing }
// imageProviders[name] is an array of image models (when available)
// latest is true for the newest model in each family
// pricing is { input, output, other? } (cost per M tokens) or null
await freezr.llm.ping(options?)

// Send a prompt to an LLM.
await freezr.llm.ask(prompt, options?)
// prompt: a string, or an array of { role, content } messages for conversation
// options: { context, provider, family, model, max_tokens, responseType, thinking, cache, files, streamBack, onDelta, onThinking, appToken, host }
// Fallback chain: model -> family -> defaultFamily of defaultProvider
//
// cache (prompt caching): true for the provider's default 5-minute TTL, or { ttl: '1h' }.
// Marks the END of the request's messages as a cache breakpoint, so a follow-up call whose
// messages re-send the same prefix and only APPEND turns (e.g. repeated Q&A over one large
// document sent as the first message) bills the cached span at ~10% of the input rate instead
// of full price. The prefix must be byte-identical between calls. Claude only today; ignored
// by providers that cache automatically (ChatGPT). Cached-token counts and their cost are
// reported in meta.tokensUsed.other.
// EXPLICIT placement — use when the LAST turn changes on every call (a fresh email, a new record):
// automatic placement would cache-WRITE that turn every time (1.25x, 2x at 1h) and rarely read it
// back. Give the STABLE turn a content-block array whose last block carries cache_control; the
// server then adds only the system-prompt breakpoint and sends your turns exactly as given:
//   [{ role: 'user', content: [{ type: 'text', text: stableDoc, cache_control: { type: 'ephemeral', ttl: '1h' } }] },
//    { role: 'user', content: theVaryingPart }]
// A 1h marker makes the system breakpoint 1h too (a 5-minute entry may not precede a 1-hour one).
//
// Returns:
// {
//   success: boolean,
//   response: string,
//   thinking?: string,
//   meta: {
//     provider: string,        // e.g. 'Claude', 'ChatGPT'
//     model: string,           // full model name used
//     modelFamily: string,     // e.g. 'sonnet', 'o3-mini'
//     rawUsage: object,        // raw provider usage object
//     tokensUsed: {
//       input:  { qtty: number, cost: number },
//       output: { qtty: number, cost: number },
//       other:  { qtty: number, cost: number }   // e.g. cache reads
//     },
//     cost: {
//       totalTokens: number,   // input + output + other token count
//       totalCost: number,     // total USD cost of the request
//       inputCost: number,
//       outputCost: number,
//       otherCost: number
//     },
//     pricing: object,
//     availableFamilies: string[],
//     hasKey: boolean
//   }
// }
//
// Streaming — receive chunks as they arrive:
// await freezr.llm.ask(prompt, {
//   streamBack: true,
//   onDelta: (text) => { /* append text chunk to UI */ },
//   onThinking: (text) => { /* append thinking/reasoning chunk */ },
//   ...otherOptions
// })
// When streamBack is true, onDelta fires for each text chunk and
// onThinking fires for each reasoning chunk (if thinking is enabled).
// The final resolved value is the same { success, response, meta } object.
// When streamBack is false (default), the response is collected internally
// and returned as a single result — no callbacks needed.
\`\`\`

---

### Mail (Connections)

The \`freezr.connections.mail.*\` namespace is available ONLY when the app's manifest declares a \`use_mail\` permission (see permissionInstructions.md for the manifest shape). On apps without that permission, \`freezr.connections\` is undefined.

Apps NEVER see the user's OAuth tokens. The freezr server holds them, refreshes them transparently, and returns a structured \`token_expired\` error if re-auth is needed (handle it with \`freezr.connections.mail.handleTokenExpired(err)\`).

Gmail, Microsoft Graph (Outlook / Microsoft 365) and IMAP/SMTP connectors are all wired up behind the same normalized API.

\`\`\`javascript
// List the connections this app is allowed to see (filtered server-side by
// the granted use_mail permission). Returns { accounts: [{ connectionName,
// provider, account_email, services, access, status }, ...] }.
// access.mail is 'read' or 'readwrite' — gates write operations user-side.
await freezr.connections.mail.listAccounts(options?)

// List folders/labels for one connection. Returns { folders: [{ id, name, type }] }
// where type is 'system' (INBOX, SENT, DRAFT, TRASH, SPAM, ...) or 'user'.
// On Gmail, "folder" IDs are label IDs — message can have multiple.
await freezr.connections.mail.listFolders({ connectionName })

// Paginated message metadata (newest first). Returns
// { messages: [...], nextPageToken: string|null }.
// Each message: { id, threadId, from: {address, name}, to, cc, subject,
//                 receivedAt (ms), snippet, isRead, hasAttachments, labels }.
// Bodies are NOT returned by listMessages — use getMessage for those.
await freezr.connections.mail.listMessages({
  connectionName,
  labelIds: ['INBOX'],           // omit / empty = all labels
  limit: 20,                     // 1..100
  pageToken,                     // opaque cursor from a prior call
  q,                             // provider-native search (Gmail syntax today)
  includeAttachments             // when true, each row gets an attachments[] manifest (no bodies)
})

// Structured search — provider-agnostic. Translates to Gmail q today;
// will translate to Graph $search/$filter and IMAP SEARCH when those land.
// Returns same shape as listMessages.
await freezr.connections.mail.searchMessages({
  connectionName,
  text, from, to,                // string fragments
  since, before,                 // unix ms
  labels,                        // string[]
  isRead, hasAttachments,        // boolean
  limit, pageToken
})

// Full message including bodies + attachment metadata.
// Returns { message: { ... + bodyText, bodyHtml, attachments: [{ id, filename, mimeType, sizeBytes }] } }.
// SECURITY: NEVER pass bodyHtml directly to .innerHTML. See "Rendering email
// safely" in the use_mail permission section.
await freezr.connections.mail.getMessage({ connectionName, messageId })

// Fetch raw attachment bytes. Defaults to Blob; pass responseType: 'arrayBuffer'
// for binary. The browser's native PDF viewer handles application/pdf when
// opened via URL.createObjectURL + window.open.
await freezr.connections.mail.getAttachment({
  connectionName, messageId, attachmentId,
  filename, mimeType,            // used for Content-Disposition
  responseType                   // 'blob' (default) or 'arrayBuffer'
})

// Incremental sync. Omit lastToken on the first call — the server returns
// changes: [] + a fresh nextToken to seed. Subsequent calls return only
// deltas. Returns { changes, nextToken, expired }.
// changes[]: { type: 'messageAdded', message } | { type: 'messageDeleted', messageId }
//          | { type: 'labelAdded'|'labelRemoved', messageId, labels }
// expired: true means the provider's delta window elapsed (Gmail ~7 days);
// fall back to listMessages and seed a new token.
await freezr.connections.mail.getNewer({ connectionName, lastToken, limit })

// Send a message. Requires 'write' scope in the granted use_mail permission
// AND connection.access.mail === 'readwrite'. Returns { messageId, threadId }.
// Attachments are inline base64 — keep total payload under ~20 MB.
// For replies: pass threadId from the parent's getMessage result.
await freezr.connections.mail.sendMessage({
  connectionName,
  to,                            // string | string[] | [{ address, name }]
  cc, bcc,                       // optional
  subject,
  bodyText, bodyHtml,            // either or both (both -> multipart/alternative)
  attachments,                   // [{ filename, mimeType, contentBase64 }]
  threadId,                      // for replies (Gmail-side threading)
  inReplyTo, references          // RFC 822 Message-ID headers for cross-client threading
})

// Save a draft on the provider. Same args as sendMessage.
// Returns { draftId, messageId, threadId }.
await freezr.connections.mail.createDraft({ connectionName, ...sendArgs })

// Mutations — all require 'write' scope + readwrite connection access.
// Each returns { messageId, ... }.
await freezr.connections.mail.markRead({ connectionName, messageId, isRead })
await freezr.connections.mail.moveMessage({ connectionName, messageId, targetFolder })  // folder/label id
await freezr.connections.mail.trashMessage({ connectionName, messageId })   // recoverable
await freezr.connections.mail.deleteMessage({ connectionName, messageId })  // permanent

// Token-expiry helper. Pass any thrown error OR successful body that contains
// { error: 'token_expired', ... }. If detected, navigates to the connection's
// reauth URL and returns true — caller should bail out of normal handling.
freezr.connections.mail.handleTokenExpired(resOrErr)

// CANONICAL ERROR-HANDLING PATTERN — use this around every mail call:
try {
  const res = await freezr.connections.mail.listMessages({ connectionName })
  // ... use res ...
} catch (err) {
  if (freezr.connections.mail.handleTokenExpired(err)) return  // already redirected
  showError(err.message)
}
\`\`\`

---

### Messaging APIs — freezr.connections.messaging

The \`freezr.connections.messaging.*\` namespace is available ONLY when the app's manifest declares a \`use_messaging\` permission (see the use_messaging section below). Slack is the first provider; the API is provider-neutral — no Slack-shaped parameters, so code written against it will work when other providers land.

\`\`\`javascript
// List messaging-enabled connections this app may use.
await freezr.connections.messaging.listAccounts()
// accounts[i]: { connectionName, provider, account_email, services, access, status, live }
// access.messaging: 'read' | 'readwrite' — gates writes user-side.
// live: true when the user opted this connection into socket-fed live updates.

// Conversations the connected user is a member of (channels, private channels,
// group DMs, DMs), paginated.
await freezr.connections.messaging.listConversations({ connectionName, limit, cursor, types, includeArchived })
// → { conversations: [{ id, name, type, isMember, isArchived, topic, purpose,
//      memberCount, counterpartUserId }], nextCursor }
// type: 'channel' | 'private_channel' | 'group_dm' | 'dm'.
// DMs have name: null — resolve counterpartUserId via getUsers. Group-DM names
// are machine strings — resolve members via getConversationMembers + getUsers.

// Messages in one conversation, NEWEST FIRST; the cursor pages OLDER.
await freezr.connections.messaging.getMessages({ connectionName, conversationId, limit, cursor, oldest, latest })
// → { messages, nextCursor }
// message: { id, conversationId, threadParentId, sender: { id, type: 'user'|'bot' },
//   sentAt /* ms */, text, replyCount, edited, subtype,
//   reactions: [{ name, count }], files: [{ id, filename, mimeType, sizeBytes }] }
// \`id\` is the provider's message id (Slack: its ts string) — treat it as OPAQUE
// and pass it back verbatim (threads, markRead, delete). \`text\` is raw provider
// markup (Slack mrkdwn: <@U123>, <#C1|general>, <https://url|label>) — resolve
// user mentions via getUsers before display.
// IMPORTANT: thread REPLIES do not appear in getMessages — only the parent (with
// replyCount > 0). Fetch replies per-thread:
await freezr.connections.messaging.getThread({ connectionName, conversationId, threadId, limit, cursor })
// threadId = the parent message's id. Returns parent + replies, oldest first.

// Per-conversation incremental sync (first call without lastToken seeds and
// returns { messages: [], nextToken }).
await freezr.connections.messaging.getNewer({ connectionName, conversationId, lastToken, limit })
// → { messages, nextToken, expired }

// Resolve user ids to names — paged directory, or batch by ids (array/CSV, ≤100).
await freezr.connections.messaging.getUsers({ connectionName, limit, cursor, ids })
// → { users: [{ id, name, displayName, realName, email, isBot, deleted, avatar }], nextCursor }

await freezr.connections.messaging.getConversationMembers({ connectionName, conversationId, limit, cursor })
// → { memberIds, nextCursor }

// The connected account's own identity — sender.id === profile.userId identifies
// the user's own messages.
await freezr.connections.messaging.getProfile({ connectionName })
// → { profile: { userId, teamId, teamName, email, displayName } }

// LIVE UPDATES — the socket-fed activity index. Answers "which conversations
// changed since X?" without polling them all. Metadata only, NEVER message
// content: follow up with getNewer/getMessages using the user's own access.
await freezr.connections.messaging.getChanges({ connectionName, since /* ms */ })
// → { changes: [{ conversationId, lastActivityTs, lastEventAt,
//       edited: [{ id, at }], deleted: [{ id, at }], changesOverflowed }],
//     gaps: [{ from, to /* null = ongoing */ }], gapSince, complete, retentionMs }
// lastActivityTs: newest message id in the conversation (monotonic high-water mark).
// lastEventAt: ms when the server indexed the last event.
// edited/deleted: message ids changed after \`since\`, each with WHEN (\`at\`) —
//   tombstone deleted ids; re-fetch edited ones (getMessages with
//   oldest=id, latest=id, inclusive:true fetches exactly one message).
// complete: false → the index cannot be trusted for your window (socket downtime
//   gap, since older than ~30d retention, or an overflowed change list). The
//   remedy is always a wider getNewer sweep. gapSince non-null → socket down NOW.

// Writes — need 'write' scope AND connection access.messaging === 'readwrite':
await freezr.connections.messaging.sendMessage({ connectionName, conversationId, text, threadId })
// threadId (a parent message id) replies in-thread.
await freezr.connections.messaging.markRead({ connectionName, conversationId, ts })
// Read state is a per-conversation CURSOR: marks everything at/before ts as read.
// There is no per-message unread flag.
await freezr.connections.messaging.deleteMessage({ connectionName, conversationId, messageId })
// Providers only allow deleting the user's OWN messages — anything else throws
// with err.data.providerError set (e.g. Slack's 'cant_delete_message').

freezr.connections.messaging.handleTokenExpired(resOrErr) // same pattern as mail
\`\`\`

**RECOMMENDED background-sync pattern** — check the live-updates capability first, fall back to polling:

\`\`\`javascript
const status = await freezr.utils.ping()
const live = status.capabilities?.messaging_live
if (live?.active && live.live_connections.includes(connectionName)) {
  // Efficient path: ask what changed, fetch only that.
  const res = await freezr.connections.messaging.getChanges({ connectionName, since: lastSyncMs })
  const targets = res.complete
    ? res.changes.map(c => c.conversationId)   // exactly what changed
    : myTrackedConversationIds                 // index untrustworthy for window → wider sweep
  for (const conversationId of targets) { /* getNewer({ connectionName, conversationId, lastToken }) */ }
  /* also: tombstone res.changes[].deleted ids; re-fetch res.changes[].edited ids */
} else {
  // Sockets not set up on this server / connection not opted in: plain polling
  // of the conversations the user chose to track.
  for (const conversationId of myTrackedConversationIds) { /* getNewer(...) */ }
}
lastSyncMs = Date.now()
\`\`\`

**Messaging pitfalls — please respect:**
- Rate limits are shared per Slack app per workspace (~50 history calls/min on internal apps). Sync a bounded set of conversations; never "all channels every cycle."
- Message ids look like timestamps (Slack) but MUST be treated as opaque strings.
- An edit/delete of an OLD message never shows up in getNewer — that is exactly what getChanges' edited/deleted lists are for.
- \`complete: false\` from getChanges is normal after server downtime — handle it with the wider sweep, don't treat it as an error.

---

### Utilities

\`\`\`javascript
freezr.utils.parse(dataString)            // Safe JSON.parse; returns parsed object or { data: string }
freezr.utils.getCookie(name)              // Get a browser cookie value
freezr.utils.startsWith(longer, check)    // String prefix check (boolean)
freezr.utils.longDateFormat(dateNum)      // Format a timestamp as "date time" string
freezr.utils.publicPathFromId(fileId, requesteeApp, userId) // Build a public URL path for a file
freezr.utils.appFilePathFrom(relativePath) // Build an app file URL from a relative path

await freezr.utils.getManifest(appName?)  // Fetch an app's manifest.json
await freezr.utils.ping(options?)         // Ping the server — see below
await freezr.utils.getHtml(partPath, appName?) // Fetch an HTML file as text
await freezr.utils.getAllAppList()         // Get list of all installed apps
await freezr.utils.getPrefs()             // Get user preferences
await freezr.utils.getAppResourceUsage(appName?) // Get storage/usage stats for an app
\`\`\`

**freezr.utils.ping()** — one call that tells the app where it stands. Anonymous callers get
\`{ logged_in: false, server_type, server_version }\`. Logged-in callers also get
\`logged_in_as_admin\`, \`user_id\` and \`storageLimits\`. When the call carries the app's token
(the default inside an app), the response ALSO includes the app's permissions — each annotated
with whether the server can actually honor it right now — plus a capability summary:

\`\`\`javascript
const status = await freezr.utils.ping()
// status.app_name      — the calling app
// status.permissions[] — this app's permission grants, each:
//   { name, type, granted,
//     usable,       // granted AND the server has what it needs to run it right now
//     blocked_by }  // null when usable, else why not:
//                   //   'not_granted'            — user hasn't granted (or revoked) it
//                   //   'no_llm_keys'            — use_llm but no LLM API key in Account Resources
//                   //   'no_compute_credential'  — job/function needs the user's cloud but no
//                   //                              serverless credential is set up
//                   //   'job_not_trusted'        — grant says run locally but admin hasn't trusted the job
//                   //   'no_job_runtime'         — job location 'auto' but neither local trust nor compute
//                   //   'no_matching_connection' — use_mail/contacts/calendar/messaging but no covered connection
//                   //   'socket_not_admitted'    — socket_connect granted but not admin-admitted (not yet executable)
//   // plus type-specific fields when present: table_id(s), job_name, location, connection_names, scopes
// status.capabilities  — grant-independent facts about the user's setup:
//   { llm: { available }, compute: { available },
//     connections: { mail, contacts, calendar, messaging },  // counts of working connections
//     messaging_live: {          // is the push-based messaging sync WORKING right now?
//       active,                  // the full setup chain is in place for ≥1 connection
//       blocked_by,              // null when active, else the FIRST missing link:
//                                //   'server_sockets_not_enabled' — admin prefs switch off   } ask the
//                                //   'no_provider_admitted'       — no /admin/sockets grant  } server
//                                //   'sockets_not_running'        — manager not started      } admin
//                                //   'no_live_connections'        — USER fix: turn on "Live updates"
//                                //                                  on the connection at /account/resources
//       sockets_running,         // the server currently holds provider socket(s)
//       prefs_enabled,           // the admin master switch
//       admitted_providers,      // e.g. ['slack']
//       live_connections } }     // connectionNames opted into live updates
\`\`\`

When \`messaging_live.active\` is false, show the user the right fix from \`blocked_by\` — the first
three need the server admin; only \`no_live_connections\` is something the user fixes themselves.

Use \`permissions[].usable\` (not just \`granted\`) to decide whether to enable a feature:
a granted \`use_llm\` with no LLM key, or a granted \`run_job\` with nowhere to run, will fail at
call time. When \`usable\` is false, use \`blocked_by\` to show the user the right fix (grant the
permission in Settings, add an LLM key or compute credential in Account Resources, connect an
account, or ask the admin to trust the job). For deeper, feature-specific detail keep using
\`freezr.llm.ping()\` (models/pricing) and \`freezr.jobs.ping()\` (per-job schedule state).

---

### Background Jobs

Run server-side code without a server in your app. A **job** is a module at \`jobs/<name>/index.mjs\`
exporting \`export async function handler (freezr, params)\`. Inside it, \`freezr\` is the SAME client API
(freezr.create / query / llm / …) — a job is just an API client that runs outside the browser. freezr
resolves WHERE it runs — locally (in-process, admin-"trusted") or on the user's own serverless cloud
(e.g. AWS Lambda) — and the handler is identical either way.

Declare jobs + their permissions in the manifest:

\`\`\`jsonc
"jobs": [
  { "name": "process_inbox", "schedule": "daily", "maxRuntime": "30s" }   // schedule: hourly|daily|weekly (minutely in dev)
],
"permissions": [
  { "type": "run_job",      "name": "run_inbox",      "job_name": "process_inbox" },  // run on demand
  { "type": "schedule_job", "name": "schedule_inbox", "job_name": "process_inbox" }   // run on a recurring schedule
]
\`\`\`

\`run_job\` and \`schedule_job\` are INDEPENDENT consents (on-demand vs recurring); the user also chooses
WHERE the job runs (auto / this server / their cloud) when they grant each one.

\`\`\`javascript
// What can this app do right now? Per job: is each permission granted, is the job admin-trusted (so it
// can run locally), is it currently scheduled, and is the user's serverless cloud available?
await freezr.jobs.ping(options?)
// Returns { has_compute, jobs: { <jobName>: { run_job_granted, schedule_job_granted, trusted, scheduled, location } } }

// Run a job ON DEMAND. name = your own job's name, or a fully-qualified third-party job
// '<ownerApp>.jobs.<job>'. params is passed to the handler. (run_job required for third-party.)
await freezr.jobs.run(name, params?, options?)
// options: { location: 'local'|'cloud' (dev override, honored only when the user's grant is 'auto'),
//            maxRuntime (e.g. '300s'), memoryMb (cloud function memory — raise for memory-heavy jobs),
//            redeploy (force a fresh code/config upload), appToken, host }
// Returns { ok, result, error, durationMs, usage?, location }

// START the recurring schedule for your own job. Granting schedule_job is CONSENT only — it does not
// start the schedule; the app calls this when scheduling is meaningful. Requires the schedule_job grant.
await freezr.jobs.schedule(name, options?)

// STOP the recurring schedule for your own job.
await freezr.jobs.unschedule(name, options?)
\`\`\`

Dependencies: ship a pre-built \`node_modules\` inside the job folder — freezr copies it, it never runs
\`npm install\`. (The legacy \`freezr.serverless.*\` API is deprecated; use \`freezr.jobs\`.)

**To SCAFFOLD a background job, create ALL of these together:**

1. The handler file at \`jobs/<name>/index.mjs\`:
\`\`\`javascript
// jobs/<name>/index.mjs — runs server-side; \`freezr\` is the full client API (create/query/llm/…).
export async function handler (freezr, params) {
  // ... do the work; return a JSON-serialisable result.
  // Best practice: don't hard-fail if a freezr call is unavailable — return a partial result + warning.
  return { ok: true }
}
\`\`\`
2. A \`jobs\` entry in \`manifest.json\` (add the array if absent): \`{ "name": "<name>", "schedule": "daily", "maxRuntime": "30s" }\` (\`schedule\` optional; omit for run-on-demand-only).
3. Permission(s) in \`manifest.json\` \`permissions\`: a \`run_job\` (on demand) and/or \`schedule_job\` (recurring), each with a unique \`name\` (alphanumeric/._- — NO spaces) and \`job_name: "<name>"\`.
4. If the job uses npm packages: add \`jobs/<name>/package.json\` and a pre-built \`jobs/<name>/node_modules/\`.

Then the app calls \`freezr.jobs.run('<name>')\` (and, for recurring, \`freezr.jobs.schedule('<name>')\` once it's meaningful).

---

### Low-Level Request

\`\`\`javascript
// Make a custom API request to any freezr endpoint.
await freezr.apiRequest(method, path, body?, options?)
// method: 'GET', 'POST', 'PUT', 'DELETE'
// options: { appToken, uploadFile, textResponse }
\`\`\`
`
