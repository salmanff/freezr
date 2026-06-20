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
// grantees: array — use ['_public'] for public sharing, or usernames
// action: 'grant' or 'deny'

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
// Send a message/shared record to another user.
await freezr.messages.send(message, options?)
// message: { recipient_id or recipients, sharing_permission or messaging_permission,
//            contact_permission, table_id, record_id }

// Mark messages as read.
await freezr.messages.markRead(messageIds, markAll?)
// messageIds: array of message IDs, or null if markAll is true

// Get messages for the current app.
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
// options: { context, provider, family, model, max_tokens, responseType, thinking, files, streamBack, onDelta, onThinking, appToken, host }
// Fallback chain: model -> family -> defaultFamily of defaultProvider
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

Today only the Gmail connector is wired up; Microsoft Graph and IMAP/SMTP are planned and the API surface won't change when they land.

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

### Utilities

\`\`\`javascript
freezr.utils.parse(dataString)            // Safe JSON.parse; returns parsed object or { data: string }
freezr.utils.getCookie(name)              // Get a browser cookie value
freezr.utils.startsWith(longer, check)    // String prefix check (boolean)
freezr.utils.longDateFormat(dateNum)      // Format a timestamp as "date time" string
freezr.utils.publicPathFromId(fileId, requesteeApp, userId) // Build a public URL path for a file
freezr.utils.appFilePathFrom(relativePath) // Build an app file URL from a relative path

await freezr.utils.getManifest(appName?)  // Fetch an app's manifest.json
await freezr.utils.ping(options?)         // Ping the server; returns { server_type, ... }
await freezr.utils.getHtml(partPath, appName?) // Fetch an HTML file as text
await freezr.utils.getAllAppList()         // Get list of all installed apps
await freezr.utils.getPrefs()             // Get user preferences
await freezr.utils.getAppResourceUsage(appName?) // Get storage/usage stats for an app
\`\`\`

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
// options: { location: 'local'|'cloud' (dev override, honored only when the user's grant is 'auto'), appToken, host }
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
