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

\`\`\`javascript
// Upload a file. Returns { _id, ... } with the file record.
await freezr.upload(file, options?)
// file: a browser File object
// options: { doNotOverWrite, host, appToken }

// Get a URL for a file (synchronous). Returns a URL string.
freezr.getFileUrl(fileId, options?)
// options: { requestee_app, permission_name, requestee_user_id }

// Delete an uploaded file.
await freezr.deleteFile(fileId, options?)
\`\`\`

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

### Serverless Functions

\`\`\`javascript
await freezr.serverless.invokeCloud(options)    // Invoke a cloud serverless function
await freezr.serverless.invokeLocal(options)    // Invoke a local serverless function
await freezr.serverless.createInvokeCloud(options)
await freezr.serverless.upsertCloud(options)
await freezr.serverless.updateCloud(options)
await freezr.serverless.deleteCloud(options)
await freezr.serverless.roleCreateCloud(options)
await freezr.serverless.deleteRole(options)
await freezr.serverless.upsertLocal(options)
await freezr.serverless.deleteLocal(options)
await freezr.serverless.getAllLocalFunctions(options)
// All accept options: { task (auto-set), host, appToken, file, ...custom params }
\`\`\`

---

### Low-Level Request

\`\`\`javascript
// Make a custom API request to any freezr endpoint.
await freezr.apiRequest(method, path, body?, options?)
// method: 'GET', 'POST', 'PUT', 'DELETE'
// options: { appToken, uploadFile, textResponse }
\`\`\`
`
