export const PERMISSION_PROMPT = `
## Permission Instructions

When a user asks to share records publicly, send data to other users, use AI/LLM features, or access another app's data, you need to:
1. Add the appropriate permission to the "permissions" array in manifest.json
2. Use the relevant freezr API calls in your JavaScript code
3. If the permission involves making items public, add a "public_pages" section and a pcard template file

The user must grant permissions from their freezr Settings page before the app can use them. Your code should handle the case where a permission has not yet been granted.

Below are the main permission types and how to use them.

---

### share_records — Sharing Records Publicly or With Specific Users

Use this when the app needs to make database records accessible to other users or to the public.

**Manifest — permission entry:**
\`\`\`json
{
  "permissions": [
    {
      "name": "publish_posts",
      "type": "share_records",
      "description": "Publish your posts publicly",
      "table_id": "com.example.myapp.posts",
      "return_fields": ["title", "body", "author", "_owner", "summaryText"],
      "search_fields": ["title", "body"]
    }
  ]
}
\`\`\`

Key fields:
- **name**: A unique identifier for this permission (no spaces, use underscores).
- **type**: Must be "share_records".
- **table_id**: The full app_table identifier: "app_name.collection_name" (e.g. "com.example.myapp.posts"). You can also use "table_ids" (with an 's') as an array to cover multiple tables under one permission — the server normalizes both forms internally.
- **description**: A human-readable description shown to the user when granting.
- **return_fields**: Optional array of field names that will be visible to recipients. Only include fields you want shared — sensitive fields should be omitted.
- **search_fields**: Optional array of field names that can be searched by recipients. These are indexed for the public feed search.

**Manifest — app_tables display settings (pcard and ppage):**

Display settings for shared records can be set in \`app_tables\`, pcard for the preview card, and ppage for the full page view.

\`\`\`json
{
  "app_tables": {
    "posts": {
      "description": "Blog posts",
      "schema": { ... },
      "pcard": "postcard.html",
      "ppage": {
        "page_title": "Blog Post",
        "html_file": "post_page.html",
        "css_files": ["public.css"],
        "script_files": ["post_page.js"],
        "header_map": {
          "title": { "field_name": "title" },
          "description": { "field_name": "summaryText" },
          "og:title": { "field_name": "title" },
          "og:description": { "field_name": "summaryText" },
          "og:site_name":         {"text": "Freezr Blog"},
          "og:type":              {"text": "article"},
          "og:image": { "field_name": "mainImageUrl" },
          "twitter:card": { "field_name": "twitterCard" },
          "twitter:title": { "field_name": "title" },
          "twitter:description": { "field_name": "summaryText" }
        }
      }
    }
  }
}
\`\`\`

- **pcard**: Filename of a card template HTML file in the \`public/\` folder. Used to render preview cards in the public feed. Uses Mustache-style \`{{fieldName}}\` templating with inline CSS only. See "Card Templates" below.
- **ppage**: An object defining the full-page template for viewing an individual shared record. Files are served from \`public/\`. The \`header_map\` maps HTML meta tags (for SEO / social sharing) to record fields or text values. When a user visits the record's public URL, this page is rendered with the record's data via Mustache.

#### Card Templates (pcard)

When making records public, create a card template HTML file in the app's \`public/\` folder. The \`pcard\` value in the manifest is just the filename — the server automatically prepends \`public/\` when reading it.

The card template must be a valid HTML file, and must be inline CSS only. 

The template uses Mustache syntax to render a preview of each shared record:

\`\`\`html
<div id="{{_id}}" style="padding: 10px; font-family: sans-serif;">
  <h3>{{title}}</h3>
  <p>{{summaryText}}</p>
  {{#image}}
  <img src="{{image}}" style="max-width: 100%; border-radius: 8px;">
  {{/image}}
</div>
\`\`\`

Template syntax:
- \`{{fieldName}}\` — insert a field value
- \`{{#fieldName}}...{{/fieldName}}\` — conditional block (renders only if field exists/is truthy)
- \`{{^fieldName}}...{{/fieldName}}\` — inverted block (renders only if field is falsy)

System fields available in templates (added by the server when rendering):
- \`{{_data_owner}}\` — the record owner's username
- \`{{_app_name}}\` — the app name
- \`{{__date_published}}\` — formatted publish date string (e.g. "3/18/2026")
- \`{{_date_published}}\` — raw publish date timestamp
- \`{{_date_modified}}\` — raw modification timestamp
- \`{{_original_id}}\` — the original record's _id from the app's collection

The public feed automatically adds the _data_owner, _app_name, and _date_published fields to the template. However if you are using the card in other pages, you would have to do that yourself.

#### Public Pages (ppage)

To display a full-page view of shared records, add a "public_pages" section to the manifest. Each key becomes a URL path. The "ppage" field in the permission references one of these keys.

All files referenced in public_pages are served from the app's \`public/\` folder — the server automatically prepends \`public/\` to all paths (html_file, css_files, script_files, modules). So \`"html_file": "post_page.html"\` serves \`public/post_page.html\`.

\`\`\`json
{
  "public_pages": {
    "post": {
      "page_title": "Blog Post",
      "html_file": "post_page.html",
      "css_files": ["post_page.css"],
      "script_files": ["post_page.js"],
      "header_map": {
        "title": { "field_name": "title" },
        "description": { "field_name": "summaryText" },
        "image": { "field_name": "mainImageUrl" },
        "author": { "field_name": "_data_owner", "text": "By:" },
        "og:title": { "field_name": "title" },
        "og:description": { "field_name": "summaryText" },
        "og:image": { "field_name": "mainImageUrl" },
        "twitter:card": { "field_name": "title" },
        "twitter:title": { "field_name": "title" },
        "twitter:description": { "field_name": "summaryText" }
      }
    },
    "index": {
      "page_title": "All Posts",
      "html_file": "public_index.html",
      "css_files": ["public_index.css"],
      "script_files": ["public_index.js"]
    }
  }
}
\`\`\`

The "header_map" maps HTML meta tags (for SEO and social sharing) to record fields. The public page script can use \`freezr.publicquery\` to fetch shared records.

#### API Usage for share_records

**Making a record public (visible to anyone):**
\`\`\`javascript
const record = await freezr.create('posts', { title: 'Hello', body: 'World' })

await freezr.perms.shareRecords(record._id, {
  name: 'publish_posts',
  table_id: 'com.example.myapp.posts',
  grantees: ['_public'],
  action: 'grant',
  pubDate: new Date().getTime()
})
\`\`\`

You can optionally set a custom \`publicid\` for a friendlier URL, but it must start with \`@username/appName\`:
\`\`\`javascript
await freezr.perms.shareRecords(record._id, {
  name: 'publish_posts',
  table_id: 'com.example.myapp.posts',
  grantees: ['_public'],
  action: 'grant',
  publicid: '@' + freezrMeta.userId + '/' + freezrMeta.appName + '/my-post-slug',
  pubDate: new Date().getTime()
})
\`\`\`

If you omit \`publicid\`, the server auto-generates one as \`@userId/appTable/recordId\`.
The publicid IS the full URL path — the public URL is simply \`serverUrl/{publicid}\` (e.g. \`https://myserver.com/@alice/com.example.myapp.posts/abc123\`). Do NOT prepend an extra userId or path segment to the publicid — it already contains the full path starting with \`@\`.
Only admin or publisher users can set publicids which are in a different format. You can see if a user is one of these by inspecting the booleans freezr.adminUser and freezr.publisherUser.

**Removing public access (unpublishing):**
When a record is published, freezr copies it into a separate \`public_records\` collection (under the 'public' user) so all public records live in one place. This copy reflects the record at the time of publishing, which may differ from the latest version.

To unpublish, you **must** call \`shareRecords\` with \`action: 'deny'\` — this removes the copy from \`public_records\`. Simply deleting the original record does NOT unpublish it. Always unpublish first, then delete the original if needed.

The default and recommended pattern is to identify the record by its **original \`_id\`**:
\`\`\`javascript
// Step 1: Unpublish (removes from public_records)
await freezr.perms.shareRecords(record._id, {
  name: 'publish_posts',
  table_id: 'com.example.myapp.posts',
  grantees: ['_public'],
  action: 'deny'
})
// Step 2: Optionally delete the original record
await freezr.delete('posts', record._id)
\`\`\`

**Identifier precedence for share / unshare:**
1. \`record_id\` (string or array of strings) — the original record \`_id\`. **DEFAULT.**
2. \`object_id_list\` — bulk by original ids.
3. \`query_criteria: { publicid }\` — when only the publicid is known (e.g. share-link UI, or the source \`_accessibles\` entry has been lost).
4. \`query_criteria: { ...mongoQuery }\` — arbitrary owner-side query.

\`\`\`

**Creating a private link (accessible only with a code):**
Use \`_privatelink\` as the grantee. The server returns a code in the response — your app should store this code, as the link is only accessible at \`publicid?code={returnedCode}\`. The code is also stored in the record's \`_accessibles\` entry under the \`codes\` array for the granted permission, so it can be recovered later.
\`\`\`javascript
const result = await freezr.perms.shareRecords(record._id, {
  name: 'publish_posts',
  table_id: 'com.example.myapp.posts',
  grantees: ['_privatelink'],
  action: 'grant'
})
const code = result.code // store this to share the private link
// Private link URL: serverUrl/{publicid}?code={code}
\`\`\`

**Sharing with specific users (by username):**
\`\`\`javascript
await freezr.perms.shareRecords(record._id, {
  name: 'publish_posts',
  table_id: 'com.example.myapp.posts',
  grantees: ['alice', 'bob@https://otherserver.com'],
  action: 'grant'
})
\`\`\`

**Sharing multiple records by ID list:**
\`\`\`javascript
await freezr.perms.shareRecords(['id1', 'id2', 'id3'], {
  name: 'publish_posts',
  table_id: 'com.example.myapp.posts',
  grantees: ['_public'],
  action: 'grant'
})
\`\`\`

**Sharing uploaded files publicly (e.g. images in a post):**
When sharing supporting files (like images), use a separate permission for the files table and set \`doNotList: true\` so they don't appear as standalone items in the public feed — they remain accessible by direct URL but are hidden from feed listings:
\`\`\`javascript
await freezr.perms.shareRecords(imageFileIds, {
  name: 'publish_picts',
  table_id: 'com.example.myapp.files',
  grantees: ['_public'],
  action: 'grant',
  table_id: 'com.example.myapp.files',
  doNotList: true
})
\`\`\`

You can also share an individual file publicly using \`shareFilePublicly\`:
\`\`\`javascript
await freezr.perms.shareFilePublicly(fileId, { action: 'grant' })
\`\`\`
you can use the freezr.publicPathFromId function to get the public URL for a file.
to fetch a private file within the html page, see the 'self' permission below.

**Checking publication status on a record:**
When a record is shared, freezr adds an \`_accessibles\` array to it. Each entry represents a grant to a specific grantee. To check if a record is published:
\`\`\`javascript
const pubEntry = record._accessibles?.find(
  a => a.grantee === '_public' && a.permission_name === 'publish_posts'
)
if (pubEntry?.granted) {
  console.log('Published on:', pubEntry._date_published)
  console.log('Public URL:', pubEntry.public_id)
}
\`\`\`

Each entry in the \`_accessibles\` array has this shape:
\`\`\`javascript
{
  grantee: '_public', // or '_privatelink', or a username
  requestor_app: 'com.example.myapp',
  permission_name: 'publish_posts',
  granted: true,
  public_id: '@user/com.example.myapp.posts/recordId',
  _date_published: 1710000000000,
  codes: [ /* present for _privatelink grants — array of access codes */ ]
}
\`\`\`
Note: The \`public_id\` is the full URL path. The public URL is \`serverUrl/{public_id}\` — do not add extra path segments before it.

**Reading public records (no login required):**
\`\`\`javascript
const publicPosts = await freezr.publicquery({
  app_table: 'com.example.myapp.posts',
  owner: 'username'
})
\`\`\`

**Checking if a permission is granted before using it:**
\`\`\`javascript
const perms = await freezr.perms.getAppPermissions()
const sharePermission = perms.find(p => p.name === 'publish_posts')
if (sharePermission && sharePermission.granted) {
  // Permission is granted, safe to share
} else {
  // Show a message asking user to grant the permission in Settings
}
\`\`\`

---

### use_llm — Using AI / LLM Features

Use this when the app needs to send prompts to an LLM (like Claude or ChatGPT) via the user's stored API keys.

**Manifest entry:**
\`\`\`json
{
  "permissions": [
    {
      "name": "ai_access",
      "type": "use_llm",
      "description": "Use your LLM API keys to generate AI responses"
    }
  ]
}
\`\`\`

Key fields:
- **name**: A unique identifier for this permission.
- **type**: Must be "use_llm".
- **description**: Explain to the user why the app needs LLM access.
- No table_id is required for this permission type.

**Sending a simple prompt:**
\`\`\`javascript
const result = await freezr.llm.ask('Summarize this text: ...')
if (result.success) {
  console.log(result.response)
}
\`\`\`

**Using conversation history (multi-turn):**
\`\`\`javascript
const messages = [
  { role: 'user', content: 'What is 2+2?' },
  { role: 'assistant', content: '4' },
  { role: 'user', content: 'Multiply that by 10' }
]
const result = await freezr.llm.ask(messages, {
  context: 'You are a helpful math tutor.',
  model: 'sonnet'
})
\`\`\`

**Available options for freezr.llm.ask:**
- **context**: System message / persona instructions (e.g. "You are a helpful assistant").
- **provider**: Preferred provider — "Claude" or "ChatGPT".
- **model**: Model shorthand like "sonnet", "o3-mini", or a full model name.
- **max_tokens**: Maximum tokens in the response.
- **responseType**: Set to "json" to auto-parse JSON from the LLM response.
- **thinking**: Enable extended thinking — true for default, or { budget_tokens: N } for Claude / { effort: 'low'|'medium'|'high' } for ChatGPT.
- **files**: One or more File objects to include with the request (for multimodal models).

**Checking if LLM is available:**
\`\`\`javascript
try {
  const pingResult = await freezr.llm.ping()
  // pingResult.exists — true if LLM keys are configured
  // pingResult.defaultProvider — default provider name (e.g. 'Claude', 'ChatGPT')
  // pingResult.defaultFamily — default model family (e.g. 'sonnet', 'mini')
  // pingResult.providers — { providerName: [{ id, family, provider, version, latest, pricing }] }
  // pingResult.imageProviders — image models by provider (when available)
} catch (e) {
  // No LLM keys configured — show a message to the user
}
\`\`\`

---

### run_job & schedule_job — Background jobs (server-side code)

Use these when the app needs server-side code — a **job** at \`jobs/<name>/index.mjs\` exporting
\`async function handler (freezr, params)\`. A job runs either on this server (in-process, if an admin has
"trusted" it) or on the user's own serverless cloud; freezr resolves which, and the user picks the
location when granting. Two INDEPENDENT permissions:
- **run_job** — run the job ON DEMAND (button / app-invoked / test).
- **schedule_job** — run it AUTOMATICALLY on the recurring schedule declared in the manifest's jobs[].

Each permission's **name** is its own unique key (no spaces — alphanumeric / . _ - only); **job_name**
ties it to the job. **Manifest entry:**
\`\`\`json
{
  "jobs": [ { "name": "process_inbox", "schedule": "daily", "maxRuntime": "30s" } ],
  "permissions": [
    { "name": "run_inbox",      "type": "run_job",      "job_name": "process_inbox", "description": "Run the inbox job when you press the button" },
    { "name": "schedule_inbox", "type": "schedule_job", "job_name": "process_inbox", "description": "Run the inbox job automatically every day" }
  ]
}
\`\`\`

**Run on demand:**
\`\`\`javascript
const res = await freezr.jobs.run('process_inbox', { since: lastRun })
if (res.ok) console.log(res.result)
\`\`\`

**Scheduling is app-driven** — granting schedule_job is consent only; START it when it makes sense:
\`\`\`javascript
await freezr.jobs.schedule('process_inbox')    // begin recurring runs
await freezr.jobs.unschedule('process_inbox')  // stop them
\`\`\`

**Check availability before offering job features:**
\`\`\`javascript
const info = await freezr.jobs.ping()
// info.has_compute — true if the user has a serverless (cloud) credential
// info.jobs.process_inbox — { run_job_granted, schedule_job_granted, trusted, scheduled, location }
\`\`\`

Notes:
- Inside the handler, \`freezr\` is the full client API (create / query / llm / …) — a job IS an API client.
- Dependencies: ship a pre-built \`node_modules\` in the job folder; freezr never runs npm install.
- The legacy \`use_serverless\` / \`use_3pFunction\` permissions and \`freezr.serverless.*\` are deprecated.

---

### use_mail — Reading and sending mail via connected accounts

Use this when the app needs to read messages, search mail, sync incrementally, send / draft, or modify mail (mark-read, move, trash, delete) on the user's connected accounts. The full API surface lives at \`freezr.connections.mail.*\` and is documented in apiReference.md under "Mail (Connections)".

Tokens are never visible client-side — the freezr server holds the OAuth grant and refreshes it. Today only the Gmail connector is wired up; Microsoft Graph and IMAP/SMTP are planned and the API won't change when they land.

**Manifest entry — read-only:**
\`\`\`json
{
  "permissions": [
    {
      "name": "mail_read",
      "type": "use_mail",
      "description": "Read messages from your connected mail accounts.",
      "connection_names": ["*"],
      "scopes": ["read"]
    }
  ]
}
\`\`\`

**Manifest entry — read + send / modify:**
\`\`\`json
{
  "permissions": [
    {
      "name": "mail_full",
      "type": "use_mail",
      "description": "Read and send mail (mark-read, trash, delete, compose).",
      "connection_names": ["*"],
      "scopes": ["read", "write"]
    }
  ]
}
\`\`\`

Key fields:
- **name**: A unique identifier for this permission.
- **type**: Must be "use_mail".
- **description**: Plain-English reason shown to the user in the grant dialog.
- **connection_names**: Array of specific connection names (e.g. \`["gmailWork", "gmailPersonal"]\`) OR \`["*"]\` for any current or future mail-enabled connection. The user can narrow the list further at grant time.
- **scopes**: \`["read"]\` for read-only consumers, \`["read", "write"]\` to send / mark-read / move / trash / delete. Request only what you need — users will accept read-only grants faster than full grants.
- No table_id is required for this permission type.

**Two-level permission model — important.** Mail access is gated on two independent levels and BOTH must allow the operation:

1. **App-side** (this permission). Declares the maximum the app may ask for. The user accepts or denies at install time.
2. **Connection-side** (\`connection.access.mail\`). Set per-connection by the user at \`/account/resources\`. Values: \`'read'\` or \`'readwrite'\`. A connection set to \`'read'\` rejects every write call even when the granting app holds \`'write'\` scope.

The practical consequence: if your app sends mail, check \`access.mail\` from \`listAccounts()\` BEFORE opening compose. Grey out the Compose UI with a clear message ("This connection is set to read-only at /account/resources") rather than letting the user type a long message that fails on send.

**Listing the connections an app may use:**
\`\`\`javascript
const { accounts } = await freezr.connections.mail.listAccounts()
// accounts[i]: { connectionName, provider, account_email, services, access, status }
// access.mail: 'read' | 'readwrite' — gates writes user-side
\`\`\`

**Reading the inbox:**
\`\`\`javascript
try {
  const { messages, nextPageToken } = await freezr.connections.mail.listMessages({
    connectionName: 'gmailWork',
    labelIds: ['INBOX'],
    limit: 25
  })
  // messages[i]: { id, threadId, from, to, subject, receivedAt, snippet,
  //               isRead, hasAttachments, labels }
} catch (err) {
  if (freezr.connections.mail.handleTokenExpired(err)) return  // redirected
  // ... other error handling
}
\`\`\`

**Fetching one message with body:**
\`\`\`javascript
const { message } = await freezr.connections.mail.getMessage({
  connectionName, messageId
})
// message.bodyHtml / message.bodyText / message.attachments[]
\`\`\`

**Incremental sync (cheap re-checks):**
\`\`\`javascript
// First call seeds — returns changes: [] + a fresh nextToken
const seed = await freezr.connections.mail.getNewer({ connectionName })
saveTokenSomewhere(seed.nextToken)

// Later, fetch deltas
const res = await freezr.connections.mail.getNewer({
  connectionName,
  lastToken: loadSavedToken()
})
if (res.expired) {
  // Provider's delta window elapsed (Gmail ~7 days). Fall back:
  await freezr.connections.mail.listMessages({ connectionName })  // full reload
  // Re-seed by calling getNewer with no lastToken again.
}
saveTokenSomewhere(res.nextToken)
res.changes.forEach(applyChangeToLocalView)
// changes[i]: { type: 'messageAdded', message }
//           | { type: 'messageDeleted', messageId }
//           | { type: 'labelAdded'|'labelRemoved', messageId, labels }
\`\`\`

**Sending (needs scopes: ["read", "write"] AND access.mail === 'readwrite'):**
\`\`\`javascript
await freezr.connections.mail.sendMessage({
  connectionName,
  to: ['recipient@example.com'],
  subject: 'Hello',
  bodyText: 'Plain-text body.',
  // For replies: pass parent.threadId from getMessage()
  threadId: parent?.threadId
})
\`\`\`

**Attachments inline (base64):**
\`\`\`javascript
function fileToBase64 (file) {
  return new Promise(resolve => {
    const r = new FileReader()
    r.onload = () => resolve(r.result.split('base64,')[1])
    r.readAsDataURL(file)
  })
}
const contentBase64 = await fileToBase64(fileInput.files[0])
await freezr.connections.mail.sendMessage({
  connectionName, to, subject, bodyText,
  attachments: [{
    filename: fileInput.files[0].name,
    mimeType: fileInput.files[0].type,
    contentBase64
  }]
})
// Keep total payload under ~20 MB.
\`\`\`

**Opening an attachment in a new tab (PDF / image / any binary):**
\`\`\`javascript
const blob = await freezr.connections.mail.getAttachment({
  connectionName, messageId, attachmentId: att.id,
  filename: att.filename, mimeType: att.mimeType
})
const url = URL.createObjectURL(blob)
window.open(url, '_blank', 'noopener')
// PDFs render in the browser's native viewer. Images render inline.
// Other types trigger a download.
// NOTE: freezr CSP blocks <iframe>, <embed>, <object> — opening in a new tab
// via blob URL is the supported pattern.
\`\`\`

**Rendering email body HTML safely — MUST follow this pattern.**

An email's HTML body is untrusted external content. NEVER pass \`message.bodyHtml\` directly to \`.innerHTML\` on the page. The safe pattern is sanitize + Shadow DOM:

\`\`\`javascript
function renderBody (host, m) {
  if (m.bodyHtml) {
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML =
      '<style>a{color:#2563eb} img{max-width:100%}</style>' +
      sanitize(m.bodyHtml)
    // Make all links open in a new tab so the email can't navigate the app away
    shadow.querySelectorAll('a[href]').forEach(a => {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
    })
  } else if (m.bodyText) {
    const pre = document.createElement('pre')
    pre.style.whiteSpace = 'pre-wrap'
    pre.textContent = m.bodyText   // never .innerHTML for plain text
    host.appendChild(pre)
  }
}

function sanitize (html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const kill = ['script','iframe','object','embed','link','meta','base','frame','frameset']
  kill.forEach(t => doc.querySelectorAll(t).forEach(n => n.remove()))
  doc.querySelectorAll('*').forEach(el => {
    [...el.attributes].forEach(a => {
      const n = a.name.toLowerCase()
      const v = String(a.value).toLowerCase().trim()
      if (n.startsWith('on')) el.removeAttribute(a.name)
      if ((n === 'href' || n === 'src' || n === 'poster' ||
           n === 'formaction' || n === 'xlink:href') &&
          (v.startsWith('javascript:') || v.startsWith('vbscript:') ||
           v.startsWith('data:text/html'))) {
        el.removeAttribute(a.name)
      }
    })
  })
  return doc.body ? doc.body.innerHTML : ''
}
\`\`\`

Shadow DOM scopes the email's \`<style>\` so it can't override the app's CSS. The sanitizer strips \`<script>\` / \`<iframe>\` / \`<object>\` / \`<embed>\` / \`<link>\` / \`<meta>\` / \`<base>\`, every \`on*\` event-handler attribute, and \`javascript:\` / \`vbscript:\` / \`data:text/html\` URLs. For production-grade sanitization, swap the inline function for DOMPurify.

**Common pitfalls — please respect:**
- Always wrap mail calls in try/catch and check \`handleTokenExpired(err)\` FIRST in the catch.
- Gmail labels are NOT folders. A message can carry multiple labels. \`moveMessage\` on Gmail is an approximation (adds target label, removes INBOX). Don't assume "I moved it" means "it left every other folder."
- The provider's \`q\` syntax is Gmail-specific. Use \`searchMessages\` with structured params for code that will keep working when Graph/IMAP land.
- Treat \`attachment.mimeType\` as untrusted (sender-controlled). If you care about correctness, sniff the first few bytes of the buffer.
- Don't store messages in your app's db just to "speed things up." The provider is the source of truth — sync errors and missed deletes are correctness liabilities. Cache for UI snappiness only.
- The Gmail history stream is mailbox-wide. If you show one folder, filter \`messageAdded\` events by checking \`message.labels.includes(currentFolderId)\`.

---

### read_all / write_all — Accessing Another App's Data

Use read_all when the app needs to read records from a collection belonging to another app. Use write_all when it needs to write to another app's collection. These are powerful permissions — the user must explicitly grant them.

Because you are accessing another app's data, you must first obtain an access token using \`freezr.perms.validateDataOwner\`, then pass that token in subsequent API calls.

**Manifest entry for read_all:**
\`\`\`json
{
  "permissions": [
    {
      "name": "read_contacts",
      "type": "read_all",
      "description": "Read contacts to find users to share with",
      "table_id": "dev.ceps.contacts"
    }
  ]
}
\`\`\`
Also note that the dev.ceps.contacts app_table is a useful system level table for social apps.


**Manifest entry for write_all:**
\`\`\`json
{
  "permissions": [
    {
      "name": "manage_contacts",
      "type": "write_all",
      "description": "Read and write contacts",
      "table_id": "dev.ceps.contacts"
    }
  ]
}
\`\`\`

**Covering multiple tables under one permission:**
You can use either "table_id" with a single string or "table_ids" with an array — the server normalizes both to an array internally:
\`\`\`json
{
  "permissions": [
    {
      "name": "access_all_data",
      "type": "read_all",
      "description": "Read all app data",
      "table_ids": ["com.example.app.table1", "com.example.app.table2", "com.example.app.table3"]
    }
  ]
}
\`\`\`

**Manifest entry for write_own (write only your own records in another app's collection):**
\`\`\`json
{
  "permissions": [
    {
      "name": "my_groups",
      "type": "write_own",
      "description": "Manage your own groups",
      "table_id": "dev.ceps.groups"
    }
  ]
}
\`\`\`

Key fields:
- **name**: A unique identifier for this permission.
- **type**: "read_all", "write_all", or "write_own".
- **table_id**: The full app_table of the other app's collection you want to access (e.g. "other.app.collection"). Use "table_ids" (array) for multiple tables.
- **description**: Explain why access is needed.

**Step 1 — Validate and get an access token:**
\`\`\`javascript
const accessResult = await freezr.perms.validateDataOwner({
  data_owner_user: 'public',
  table_id: 'dev.ceps.contacts',
  permission: 'read_contacts'
})
const accessToken = accessResult['access-token']
\`\`\`

The \`data_owner_user\` is typically "public" for shared system tables, or a specific username if you're accessing another user's data. The \`permission\` field should match the permission name from your manifest.

**Step 2 — Use the access token to query data:**
\`\`\`javascript
const contacts = await freezr.query('dev.ceps.contacts', {}, {
  appToken: accessToken,
  permission_name: 'read_contacts',
  data_owner_user: 'public',
  app_id: freezrMeta.appName
})
\`\`\`

**Step 2 (alternative) — Write data with the access token:**
\`\`\`javascript
await freezr.create('dev.ceps.contacts', { name: 'Alice', email: 'alice@example.com' }, {
  appToken: accessToken,
  permission_name: 'manage_contacts'
})
\`\`\`

**Full pattern — check permission, validate, then query:**
\`\`\`javascript
const perms = await freezr.perms.getAppPermissions()
const readPerm = perms.find(p => p.name === 'read_contacts')

if (readPerm && readPerm.granted) {
  const accessResult = await freezr.perms.validateDataOwner({
    data_owner_user: 'bob',
    table_id: 'dev.ceps.contacts',
    permission: 'read_contacts'
  })

  const contacts = await freezr.query('dev.ceps.contacts', {}, {
    appToken: accessResult['access-token'],
    permission_name: 'read_contacts',
    data_owner_user: 'bob',
    app_id: freezrMeta.appName
  })
  // Use contacts...
} else {
  // Prompt user to grant permission in Settings
}
\`\`\`

---

### Summary of Permission Types

| Type | Category | Needs table_id | Purpose |
|------|----------|----------------|---------|
| share_records | Sharing | Yes | Share specific records with users or make public |
| message_records | Sharing | Yes | Send records as messages to other users |
| read_all | Database Access | Yes | Read all records in another app's collection |
| write_all | Database Access | Yes | Read and write any records in another app's collection |
| write_own | Database Access | Yes | Write only your own records in another app's collection |
| upload_pages | Sharing | No | Upload and serve public HTML pages |
| use_llm | App Capabilities | No | Use the user's LLM API keys for AI requests |
| use_mail | App Capabilities | No | Read / send mail via the user's connected mail accounts. Requires connection_names + scopes fields; gated by both app-side scope AND connection-side access.mail. |
| external_scripts | App Capabilities | No | Load JavaScript from external domains (relaxes script-src CSP) |
| external_fetch | App Capabilities | No | Send/receive data to/from external domains (relaxes connect-src CSP) |
| unsafe_eval | App Capabilities | No | Allow eval() and dynamic code execution (adds unsafe-eval to script-src CSP) |
| run_job | App Capabilities | No | Run a background job ON DEMAND (carries job_name + user-set location auto/local/cloud) |
| schedule_job | App Capabilities | No | Run a background job AUTOMATICALLY on a recurring schedule (independent of run_job; app starts it via freezr.jobs.schedule) |

### Important Notes
- The table_id must be the full "app_name.collection_name" format (e.g. "cards.hiper.freezr.marks"). You can use either "table_id" (string) or "table_ids" (array) — the server normalizes both.
- Permission names must be unique within the app and should use underscores, not spaces.
- Always check if a permission is granted before attempting to use it, and provide a helpful message if it isn't.
- When adding a permission, always update the manifest.json "permissions" array AND write the code that uses it.
- When making records public, create a pcard template file in the \`public/\` folder and add a "public_pages" entry so records render correctly on public URLs. All public_pages files must also be in the \`public/\` folder.
- Include the new permission name in the summary's "newPermissions" array so the system can prompt the user to grant it.
`
