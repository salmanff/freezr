// mail.js — info.freezr.connections / mail page
//
// A working three-pane mail client that exercises the full freezr.connections.mail.* API:
// listAccounts, listFolders, listMessages, getMessage, getAttachment, getNewer,
// sendMessage, createDraft, markRead, trashMessage, deleteMessage.
//
// Constraints (from freezr's CSP):
//   - No inline scripts: everything wires up via JS in this file.
//   - No iframes / <embed> / <object>: HTML email bodies render into a Shadow DOM
//     for CSS isolation; PDFs / other binary attachments open in a new tab via
//     blob URL (same pattern used by the PDF tracker app).
//   - Inline styles are allowed, so the Shadow DOM injects its own <style> scope.

/* global freezr */

const LAST_ACCOUNT_KEY = 'freezr.connections.mail.lastConnection'
const LAST_FOLDER_KEY  = 'freezr.connections.mail.lastFolder'

// Gmail-style system labels we always promote to the top of the folder list.
// Order matters here — this is the displayed order. Provider-specific label IDs
// will map onto these names as we add Graph / IMAP connectors.
const SYSTEM_FOLDER_ORDER = ['INBOX', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'SPAM', 'TRASH']
const SYSTEM_FOLDER_LABEL = {
  INBOX: 'Inbox',
  STARRED: 'Starred',
  IMPORTANT: 'Important',
  SENT: 'Sent',
  DRAFT: 'Drafts',
  SPAM: 'Spam',
  TRASH: 'Trash'
}
const SYSTEM_FOLDER_ICON = {
  INBOX: '\u{1F4E5}',     // inbox tray
  STARRED: '★',
  IMPORTANT: '⚠',
  SENT: '\u{1F4E4}',      // outbox tray
  DRAFT: '\u{1F4DD}',     // memo
  SPAM: '\u{1F6AB}',
  TRASH: '\u{1F5D1}'      // wastebasket
}

const state = {
  accounts: [],              // [{ connectionName, provider, account_email, services, access, status }]
  selectedAccount: null,
  selectedAccountAccess: null, // 'read' | 'readwrite' — drives whether write actions are enabled

  folders: [],               // [{ id, name, type }] — provider-normalized
  currentFolder: 'INBOX',    // selected folder ID (a Gmail label ID for now)

  messages: [],
  nextPageToken: null,
  newerToken: null,          // delta cursor for getNewer (per account+folder)

  selectedMessageId: null,
  currentMessage: null,      // full message currently in reader

  attachmentBlobs: [],       // [{ url, revokeAt }] — kept so we can revoke on next render
  composeFiles: []           // [{ filename, mimeType, contentBase64, size }]
}

freezr.initPageScripts = async function () {
  bindUi()
  await loadAccounts()
}

// ------------------------------------------------------------------------------------
//  UI wiring
// ------------------------------------------------------------------------------------

function bindUi () {
  $('accountPicker').onchange = async (e) => {
    state.selectedAccount = e.target.value || null
    persist(LAST_ACCOUNT_KEY, state.selectedAccount)
    state.newerToken = null
    onSelectedAccountChanged()
    await loadFoldersThenMessages()
  }

  $('btnGetNew').onclick  = () => getNewer()
  $('btnCompose').onclick = () => {
    if ($('btnCompose').disabled) return
    openCompose(null)
  }
  $('btnBackToList').onclick = () => setMobileView('list')
  $('btnLoadMore').onclick = () => loadMessages({ reset: false })

  // Reader actions
  $('btnReply').onclick     = () => onReply()
  $('btnMarkRead').onclick  = () => onToggleRead()
  $('btnTrash').onclick     = () => onTrash()
  $('btnDelete').onclick    = () => onDelete()

  // Compose modal
  $('composeClose').onclick   = () => closeCompose()
  $('composeBackdrop').onclick = (e) => { if (e.target === $('composeBackdrop')) closeCompose() }
  $('composeFile').onchange   = (e) => onComposeFiles(e.target.files)
  $('btnSend').onclick        = () => onSend(false)
  $('btnSaveDraft').onclick   = () => onSend(true)
}

// ------------------------------------------------------------------------------------
//  Accounts
// ------------------------------------------------------------------------------------

async function loadAccounts () {
  setListBusy(true)
  try {
    const res = await freezr.connections.mail.listAccounts()
    state.accounts = (res && res.accounts) ? res.accounts : []
    if (state.accounts.length === 0) {
      renderFolders([])
      showInfo('No mail accounts connected yet. <a href="/account/resources">Connect one at /account/resources</a> and pick "Mail" as the service.')
      $('messageList').innerHTML = ''
      return
    }
    populateAccountPicker()
    onSelectedAccountChanged()
    await loadFoldersThenMessages()
  } catch (err) {
    if (err && (err.status === 403 || /use_mail/i.test(err.message || ''))) {
      showWarn('This app needs use_mail permission. Open /account/resources and grant access.')
    } else {
      showError(err?.message || String(err))
    }
  } finally {
    setListBusy(false)
  }
}

function populateAccountPicker () {
  const sel = $('accountPicker')
  sel.innerHTML = ''
  const sorted = state.accounts.slice().sort((a, b) => (a.connectionName || '').localeCompare(b.connectionName || ''))
  sorted.forEach(a => {
    const o = document.createElement('option')
    o.value = a.connectionName
    o.textContent = a.connectionName + (a.account_email ? ' (' + a.account_email + ')' : '')
    sel.appendChild(o)
  })
  const preferred = read(LAST_ACCOUNT_KEY)
  const exists = preferred && state.accounts.some(a => a.connectionName === preferred)
  state.selectedAccount = exists ? preferred : sorted[0]?.connectionName || null
  if (state.selectedAccount) sel.value = state.selectedAccount
}

function onSelectedAccountChanged () {
  const a = state.accounts.find(x => x.connectionName === state.selectedAccount)
  state.selectedAccountAccess = (a && a.access && a.access.mail === 'readwrite') ? 'readwrite' : 'read'
  $('accountMeta').innerText = a
    ? (a.provider + ' · ' + (a.account_email || '') + ' · ' + (state.selectedAccountAccess === 'readwrite' ? 'read+write' : 'read-only'))
    : ''
  applyWritePermissionUi()
}

// Reflect the current connection's mail access in every write-capable UI control.
// Read-only connections grey out Compose + all reader-pane actions and give a
// hover tooltip explaining how to enable write access.
function applyWritePermissionUi () {
  const writable = state.selectedAccountAccess === 'readwrite'
  const tooltip = writable
    ? ''
    : 'This connection is read-only. Switch it to read+write at /account/resources to send and modify mail.'
  const composeBtn = $('btnCompose')
  if (composeBtn) {
    composeBtn.disabled = !writable
    composeBtn.title = writable ? 'Compose a new message' : tooltip
  }
  // Reader-pane buttons are re-evaluated whenever a message is opened (in
  // renderReader); also update them here so the state is correct between
  // account switches when a message is already open.
  ;['btnReply', 'btnMarkRead', 'btnTrash', 'btnDelete'].forEach(id => {
    const btn = $(id)
    if (!btn) return
    btn.disabled = !writable
    if (!writable) btn.title = tooltip
  })
}

// ------------------------------------------------------------------------------------
//  Folders
// ------------------------------------------------------------------------------------

async function loadFoldersThenMessages () {
  if (!state.selectedAccount) return
  hideReauth()
  hideError()
  try {
    const res = await freezr.connections.mail.listFolders({ connectionName: state.selectedAccount })
    if (handleTokenExpired(res)) return
    state.folders = (res && res.folders) ? res.folders : []
    // Restore last folder if it still exists for this account.
    const prefFolder = read(LAST_FOLDER_KEY)
    const hasPref = prefFolder && state.folders.some(f => f.id === prefFolder)
    state.currentFolder = hasPref ? prefFolder : 'INBOX'
    renderFolders(state.folders)
    await loadMessages({ reset: true })
  } catch (err) {
    if (handleTokenExpired(err)) return
    showError('Could not load folders: ' + (err?.message || String(err)))
  }
}

function renderFolders (folders) {
  const list = $('folderList')
  list.innerHTML = ''

  // Bucket: declared system order first, then "other system" (e.g. CATEGORY_*), then user.
  const byId = new Map(folders.map(f => [f.id, f]))
  const renderedIds = new Set()

  // Section: standard system folders
  SYSTEM_FOLDER_ORDER.forEach(id => {
    if (byId.has(id)) {
      list.appendChild(folderLi(byId.get(id), SYSTEM_FOLDER_LABEL[id], SYSTEM_FOLDER_ICON[id]))
      renderedIds.add(id)
    }
  })

  // Section: other system folders (Gmail CATEGORY_*, etc.)
  const otherSystem = folders.filter(f => f.type === 'system' && !renderedIds.has(f.id))
  if (otherSystem.length > 0) {
    const h = document.createElement('li')
    h.className = 'mail-folder-group'
    h.textContent = 'Categories'
    list.appendChild(h)
    otherSystem.forEach(f => list.appendChild(folderLi(f, prettySystemName(f), '\u{1F4C2}')))
  }

  // Section: user labels
  const userLabels = folders.filter(f => f.type === 'user').sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  if (userLabels.length > 0) {
    const h = document.createElement('li')
    h.className = 'mail-folder-group'
    h.textContent = 'Labels'
    list.appendChild(h)
    userLabels.forEach(f => list.appendChild(folderLi(f, f.name, '\u{1F516}')))
  }
}

function prettySystemName (f) {
  if (!f || !f.name) return f?.id || ''
  // Gmail's CATEGORY_PROMOTIONS / CATEGORY_SOCIAL come through with their raw names.
  // Strip "CATEGORY_" and Title-Case the rest. Other system IDs we recognize by name.
  return String(f.name).replace(/^CATEGORY_/, '').replace(/_/g, ' ').toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase())
}

function folderLi (folder, label, icon) {
  const li = document.createElement('li')
  li.className = 'mail-folder' + (folder.id === state.currentFolder ? ' is-active' : '')
  li.innerHTML = '<span class="mail-folder-icon">' + escapeHtml(icon || '') + '</span><span>' + escapeHtml(label || folder.id) + '</span>'
  li.onclick = () => {
    if (folder.id === state.currentFolder) return
    state.currentFolder = folder.id
    persist(LAST_FOLDER_KEY, folder.id)
    // Keep state.newerToken — Gmail's historyId is mailbox-wide. Get-new still
    // works after a folder switch; we just filter the returned events to the
    // new currentFolder when applying them.
    renderFolders(state.folders) // re-highlight active
    $('currentFolderLabel').innerText = label || folder.id
    loadMessages({ reset: true })
  }
  if (folder.id === state.currentFolder) $('currentFolderLabel').innerText = label || folder.id
  return li
}

// ------------------------------------------------------------------------------------
//  Message list
// ------------------------------------------------------------------------------------

async function loadMessages ({ reset = true } = {}) {
  if (!state.selectedAccount) return
  setListBusy(true)
  if (reset) {
    state.messages = []
    state.nextPageToken = null
    $('messageList').innerHTML = ''
    $('loadMoreWrap').style.display = 'none'
  }
  try {
    const res = await freezr.connections.mail.listMessages({
      connectionName: state.selectedAccount,
      labelIds: state.currentFolder ? [state.currentFolder] : undefined,
      limit: 25,
      pageToken: reset ? undefined : state.nextPageToken
    })
    if (handleTokenExpired(res)) return
    const fetched = (res && res.messages) ? res.messages : []
    state.messages = reset ? fetched : state.messages.concat(fetched)
    state.nextPageToken = res?.nextPageToken || null
    renderMessageList()
    // If this is the first page after switching account/folder, seed the
    // getNewer cursor opportunistically (one extra call, but cheap).
    if (reset && !state.newerToken) {
      seedNewerToken().catch(() => { /* non-fatal */ })
    }
  } catch (err) {
    if (handleTokenExpired(err)) return
    showError('Could not load messages: ' + (err?.message || String(err)))
  } finally {
    setListBusy(false)
  }
}

async function seedNewerToken () {
  // First call with no lastToken: server returns nextToken with changes:[] — perfect for seeding.
  const res = await freezr.connections.mail.getNewer({ connectionName: state.selectedAccount })
  if (handleTokenExpired(res)) return
  state.newerToken = res?.nextToken || null
}

async function getNewer () {
  if (!state.selectedAccount) return
  if (!state.newerToken) {
    // No baseline yet — seed silently and tell the user.
    await seedNewerToken()
    showInfo('Synced. Click "Get new" again later to fetch what arrives after this point.')
    return
  }
  setListBusy(true)
  try {
    const res = await freezr.connections.mail.getNewer({
      connectionName: state.selectedAccount,
      lastToken: state.newerToken
    })
    if (handleTokenExpired(res)) return
    if (res?.expired) {
      // Provider's delta window elapsed — fall back to a full reload + reseed.
      showInfo('Delta window expired — reloading the folder.')
      state.newerToken = null
      await loadMessages({ reset: true })
      return
    }
    state.newerToken = res?.nextToken || state.newerToken

    const added = (res?.changes || []).filter(c => c.type === 'messageAdded').map(c => c.message)
    const deletedIds = new Set((res?.changes || []).filter(c => c.type === 'messageDeleted').map(c => c.messageId))

    // Filter added to current folder (Gmail's history.list is mailbox-wide).
    const addedHere = added.filter(m => Array.isArray(m.labels) && m.labels.includes(state.currentFolder))

    // Apply label changes inline so unread/labels stay fresh.
    ;(res?.changes || []).forEach(c => {
      if (c.type !== 'labelAdded' && c.type !== 'labelRemoved') return
      const existing = state.messages.find(m => m.id === c.messageId)
      if (!existing) return
      const labels = new Set(Array.isArray(existing.labels) ? existing.labels : [])
      ;(c.labels || []).forEach(l => c.type === 'labelAdded' ? labels.add(l) : labels.delete(l))
      existing.labels = Array.from(labels)
      existing.isRead = !labels.has('UNREAD')
    })

    // Splice: prepend new in-folder messages, drop deleted, dedupe by id.
    const seen = new Set()
    const merged = []
    addedHere.forEach(m => { if (!seen.has(m.id)) { merged.push(m); seen.add(m.id) } })
    state.messages.forEach(m => {
      if (deletedIds.has(m.id)) return
      if (seen.has(m.id)) return
      merged.push(m)
      seen.add(m.id)
    })
    state.messages = merged

    renderMessageList()
    const addedCount = addedHere.length
    const deletedCount = deletedIds.size
    showInfo(addedCount === 0 && deletedCount === 0
      ? 'No new messages.'
      : (addedCount + ' new, ' + deletedCount + ' removed.'))
  } catch (err) {
    if (handleTokenExpired(err)) return
    showError('Get new failed: ' + (err?.message || String(err)))
  } finally {
    setListBusy(false)
  }
}

function renderMessageList () {
  const list = $('messageList')
  list.innerHTML = ''
  if (state.messages.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'mail-list-empty'
    empty.textContent = 'No messages in this folder.'
    list.appendChild(empty)
  } else {
    state.messages.forEach(m => list.appendChild(messageRowLi(m)))
  }
  $('loadMoreWrap').style.display = state.nextPageToken ? 'block' : 'none'
}

function messageRowLi (m) {
  const li = document.createElement('li')
  li.className = 'mail-row'
  if (!m.isRead) li.classList.add('is-unread')
  if (m.id === state.selectedMessageId) li.classList.add('is-selected')

  const fromText = (m.from && (m.from.name || m.from.address)) || '(unknown sender)'
  const attachIcon = m.hasAttachments ? '<span class="mail-attach-icon" title="Has attachments">\u{1F4CE}</span>' : ''

  li.innerHTML =
    '<div class="mail-row-from">' + attachIcon + escapeHtml(fromText) + '</div>' +
    '<div class="mail-row-date">' + escapeHtml(formatDateShort(m.receivedAt)) + '</div>' +
    '<div class="mail-row-subject">' + escapeHtml(m.subject || '(no subject)') + '</div>' +
    '<div class="mail-row-snippet">' + escapeHtml(m.snippet || '') + '</div>'

  li.onclick = () => openMessage(m.id)
  return li
}

// ------------------------------------------------------------------------------------
//  Reading pane
// ------------------------------------------------------------------------------------

async function openMessage (messageId) {
  state.selectedMessageId = messageId
  state.currentMessage = null
  renderMessageList() // re-renders with the new is-selected highlight

  $('readerEmpty').style.display = 'none'
  $('readerView').style.display = 'flex'
  $('readerStatus').innerText = 'Loading…'
  $('readerSubject').innerText = ''
  $('readerMeta').innerHTML = ''
  $('readerBody').innerHTML = ''
  $('readerAttachments').style.display = 'none'
  setMobileView('reader')

  try {
    const res = await freezr.connections.mail.getMessage({
      connectionName: state.selectedAccount,
      messageId
    })
    if (handleTokenExpired(res)) {
      $('readerEmpty').style.display = 'flex'
      $('readerView').style.display = 'none'
      return
    }
    const m = res && res.message
    if (!m) {
      $('readerStatus').innerText = 'Message unavailable'
      return
    }
    state.currentMessage = m

    // Auto-mark-as-read on open (only if currently unread, only if write granted, only on Gmail labels).
    if (!m.isRead && state.selectedAccountAccess === 'readwrite') {
      freezr.connections.mail.markRead({
        connectionName: state.selectedAccount,
        messageId: m.id,
        isRead: true
      }).then(() => {
        const row = state.messages.find(x => x.id === m.id)
        if (row) row.isRead = true
        renderMessageList()
      }).catch(() => { /* best-effort; ignore */ })
    }

    renderReader(m)
  } catch (err) {
    if (handleTokenExpired(err)) return
    $('readerStatus').innerText = 'Error'
    $('readerBody').innerText = err?.message || String(err)
  }
}

function renderReader (m) {
  $('readerStatus').innerText = ''
  $('readerSubject').innerText = m.subject || '(no subject)'

  const fromText = m.from ? (m.from.name ? (m.from.name + ' <' + m.from.address + '>') : m.from.address) : '(unknown)'
  const toText   = (m.to || []).map(addressDisplay).filter(Boolean).join(', ')
  const ccText   = (m.cc || []).map(addressDisplay).filter(Boolean).join(', ')

  const labelsHtml = Array.isArray(m.labels) && m.labels.length
    ? m.labels.map(l => '<span class="mail-label-chip">' + escapeHtml(l) + '</span>').join('')
    : ''

  $('readerMeta').innerHTML =
    '<div><b>From:</b> ' + escapeHtml(fromText) + '</div>' +
    (toText ? '<div><b>To:</b> ' + escapeHtml(toText) + '</div>' : '') +
    (ccText ? '<div><b>Cc:</b> ' + escapeHtml(ccText) + '</div>' : '') +
    '<div><b>Date:</b> ' + escapeHtml(formatDateFull(m.receivedAt)) + '</div>' +
    (labelsHtml ? '<div><b>Labels:</b> ' + labelsHtml + '</div>' : '')

  $('btnMarkRead').innerText = m.isRead ? 'Mark unread' : 'Mark read'
  $('readerActionStatus').innerText = ''

  // Reader actions' enabled state mirrors the connection's write access — same
  // logic as Compose. applyWritePermissionUi() also runs on account switch.
  applyWritePermissionUi()

  renderAttachments(m)
  renderBody(m)
}

function addressDisplay (a) {
  if (!a || !a.address) return ''
  return a.name ? (a.name + ' <' + a.address + '>') : a.address
}

// ------------------------------------------------------------------------------------
//  Attachments
// ------------------------------------------------------------------------------------

function renderAttachments (m) {
  const wrap = $('readerAttachments')
  const atts = Array.isArray(m.attachments) ? m.attachments : []
  if (atts.length === 0) {
    wrap.style.display = 'none'
    wrap.innerHTML = ''
    return
  }

  // Revoke any blob URLs from the previous message.
  state.attachmentBlobs.forEach(b => { try { URL.revokeObjectURL(b.url) } catch (_) {} })
  state.attachmentBlobs = []

  wrap.style.display = 'flex'
  wrap.innerHTML = ''
  atts.forEach(att => {
    const chip = document.createElement('button')
    chip.className = 'mail-attachment-chip'
    chip.type = 'button'
    chip.innerHTML =
      '<span>\u{1F4CE}</span>' +
      '<span>' + escapeHtml(att.filename || 'attachment') + '</span>' +
      '<span class="mail-attachment-size">' + formatBytes(att.sizeBytes) + '</span>'
    chip.onclick = () => openAttachment(m.id, att)
    wrap.appendChild(chip)
  })
}

async function openAttachment (messageId, att) {
  try {
    const blob = await freezr.connections.mail.getAttachment({
      connectionName: state.selectedAccount,
      messageId,
      attachmentId: att.id,
      filename: att.filename,
      mimeType: att.mimeType,
      responseType: 'blob'
    })
    if (handleTokenExpired(blob)) return
    const url = URL.createObjectURL(blob)
    state.attachmentBlobs.push({ url })
    // Open in a new tab. The browser's native PDF viewer kicks in for application/pdf;
    // other types either render natively (images, text) or trigger a download.
    window.open(url, '_blank', 'noopener')
  } catch (err) {
    if (handleTokenExpired(err)) return
    showError('Could not load attachment: ' + (err?.message || String(err)))
  }
}

function formatBytes (n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return ''
  const v = Number(n)
  if (v < 1024) return v + ' B'
  if (v < 1024 * 1024) return Math.round(v / 1024) + ' KB'
  return (v / (1024 * 1024)).toFixed(1) + ' MB'
}

// ------------------------------------------------------------------------------------
//  HTML body rendering — Shadow DOM + sanitization
// ------------------------------------------------------------------------------------

function renderBody (m) {
  const body = $('readerBody')
  body.innerHTML = ''

  if (m.bodyHtml) {
    const host = document.createElement('div')
    host.className = 'mail-body-html-host'
    body.appendChild(host)
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML =
      '<style>' +
      ':host{display:block;color:#0f172a;font-size:0.92rem;line-height:1.5;}' +
      'a{color:#2563eb;}' +
      'img{max-width:100%;height:auto;}' +
      'table{max-width:100%;}' +
      'blockquote{border-left:3px solid #cbd5e1;margin:0;padding:0.2em 1em;color:#475569;}' +
      'pre{white-space:pre-wrap;word-wrap:break-word;}' +
      '</style>' +
      sanitizeEmailHtml(m.bodyHtml)
    // Make all links open in a new tab (CSP can't stop them; we just want sensible defaults).
    shadow.querySelectorAll('a[href]').forEach(a => {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
    })
  } else if (m.bodyText) {
    const pre = document.createElement('pre')
    pre.className = 'mail-body-text'
    pre.textContent = m.bodyText
    body.appendChild(pre)
  } else {
    body.innerHTML = '<div style="color:#64748b;">(no body)</div>'
  }
}

/**
 * Conservative HTML sanitizer for rendering email bodies inside a Shadow DOM.
 * Strips elements and attributes that can execute JS or load active content:
 *   - <script>, <iframe>, <object>, <embed>, <link>, <meta>, <base> elements
 *   - any attribute beginning with `on`
 *   - href / src / poster / formaction / xlink:href values that start with javascript:
 *   - style attributes with `expression(` (legacy IE), `behavior:`, or `@import`
 *
 * Keeps <style> (Shadow DOM scopes it so it can't leak), keeps <img> (browser
 * blocks JS in img src anyway and our CSP allows img-src *).
 */
function sanitizeEmailHtml (html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html')
  const dangerousTags = ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'frame', 'frameset']
  dangerousTags.forEach(tag => {
    doc.querySelectorAll(tag).forEach(el => el.remove())
  })

  const isUnsafeUrl = (v) => {
    if (!v) return false
    const trimmed = String(v).trim().toLowerCase()
    return trimmed.startsWith('javascript:') ||
           trimmed.startsWith('vbscript:') ||
           trimmed.startsWith('data:text/html')
  }

  doc.querySelectorAll('*').forEach(el => {
    // Strip on* event handlers and dangerous URL-bearing attributes.
    Array.from(el.attributes).forEach(attr => {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) { el.removeAttribute(attr.name); return }
      if ((name === 'href' || name === 'src' || name === 'poster' ||
           name === 'formaction' || name === 'xlink:href') && isUnsafeUrl(attr.value)) {
        el.removeAttribute(attr.name)
      }
      if (name === 'style') {
        const v = String(attr.value || '').toLowerCase()
        if (v.includes('expression(') || v.includes('behavior:') || v.includes('@import') ||
            v.includes('javascript:')) {
          el.removeAttribute(attr.name)
        }
      }
    })
  })

  return doc.body ? doc.body.innerHTML : ''
}

// ------------------------------------------------------------------------------------
//  Message actions: mark read/unread, trash, delete, reply
// ------------------------------------------------------------------------------------

async function onToggleRead () {
  if (!state.currentMessage) return
  const targetIsRead = !state.currentMessage.isRead
  $('readerActionStatus').innerText = targetIsRead ? 'Marking read…' : 'Marking unread…'
  try {
    await freezr.connections.mail.markRead({
      connectionName: state.selectedAccount,
      messageId: state.currentMessage.id,
      isRead: targetIsRead
    })
    state.currentMessage.isRead = targetIsRead
    const row = state.messages.find(m => m.id === state.currentMessage.id)
    if (row) row.isRead = targetIsRead
    renderMessageList()
    $('btnMarkRead').innerText = targetIsRead ? 'Mark unread' : 'Mark read'
    $('readerActionStatus').innerText = ''
  } catch (err) {
    if (handleTokenExpired(err)) return
    $('readerActionStatus').innerText = 'Failed: ' + (err?.message || String(err))
  }
}

async function onTrash () {
  if (!state.currentMessage) return
  $('readerActionStatus').innerText = 'Moving to Trash…'
  try {
    await freezr.connections.mail.trashMessage({
      connectionName: state.selectedAccount,
      messageId: state.currentMessage.id
    })
    removeFromListAndCloseReader(state.currentMessage.id, 'Moved to Trash.')
  } catch (err) {
    if (handleTokenExpired(err)) return
    $('readerActionStatus').innerText = 'Trash failed: ' + (err?.message || String(err))
  }
}

async function onDelete () {
  if (!state.currentMessage) return
  if (!window.confirm('Permanently delete this message? This cannot be undone.')) return
  $('readerActionStatus').innerText = 'Deleting…'
  try {
    await freezr.connections.mail.deleteMessage({
      connectionName: state.selectedAccount,
      messageId: state.currentMessage.id
    })
    removeFromListAndCloseReader(state.currentMessage.id, 'Permanently deleted.')
  } catch (err) {
    if (handleTokenExpired(err)) return
    $('readerActionStatus').innerText = 'Delete failed: ' + (err?.message || String(err))
  }
}

function removeFromListAndCloseReader (messageId, infoMsg) {
  state.messages = state.messages.filter(m => m.id !== messageId)
  state.selectedMessageId = null
  state.currentMessage = null
  renderMessageList()
  $('readerView').style.display = 'none'
  $('readerEmpty').style.display = 'flex'
  $('readerStatus').innerText = 'No message selected'
  setMobileView('list')
  if (infoMsg) showInfo(infoMsg)
}

function onReply () {
  if (!state.currentMessage) return
  openCompose(state.currentMessage)
}

// ------------------------------------------------------------------------------------
//  Compose: send + save draft, attachments via base64
// ------------------------------------------------------------------------------------

function openCompose (replyTo) {
  state.composeFiles = []
  renderComposeAttachList()
  $('composeStatus').innerText = ''
  if (replyTo) {
    $('composeTitle').innerText = 'Reply'
    const fromAddr = replyTo.from?.address || ''
    $('composeTo').value = fromAddr
    $('composeCc').value = ''
    const subj = replyTo.subject || ''
    $('composeSubject').value = /^re:/i.test(subj) ? subj : ('Re: ' + subj)
    // Stash the Gmail threadId — the only piece we have client-side that
    // threads correctly on Gmail's side. For full cross-client threading
    // (Outlook, Apple Mail, etc.) we'd also want the parent's RFC 822
    // Message-ID header in In-Reply-To / References, but normalizeMessage
    // doesn't currently surface that. Phase 3 — Gmail-side threading only.
    $('composeBackdrop').dataset.threadId = replyTo.threadId || ''
    // Quote the original body (text preferred, fallback to a basic strip of html).
    const original = replyTo.bodyText || stripTags(replyTo.bodyHtml || '')
    const quoted = original
      ? '\n\n--- Original message ---\n' + original.split('\n').map(l => '> ' + l).join('\n')
      : ''
    $('composeBody').value = quoted
  } else {
    $('composeTitle').innerText = 'New Message'
    $('composeTo').value = ''
    $('composeCc').value = ''
    $('composeSubject').value = ''
    $('composeBody').value = ''
    delete $('composeBackdrop').dataset.threadId
  }
  $('composeBackdrop').classList.add('is-open')
  setTimeout(() => $('composeTo').focus(), 50)
}

function closeCompose () {
  $('composeBackdrop').classList.remove('is-open')
  $('composeFile').value = ''
  state.composeFiles = []
}

async function onComposeFiles (fileList) {
  if (!fileList) return
  for (const f of Array.from(fileList)) {
    try {
      const contentBase64 = await fileToBase64(f)
      state.composeFiles.push({
        filename: f.name,
        mimeType: f.type || 'application/octet-stream',
        contentBase64,
        size: f.size
      })
    } catch (err) {
      showError('Could not read file: ' + (err?.message || String(err)))
    }
  }
  $('composeFile').value = ''
  renderComposeAttachList()
}

function renderComposeAttachList () {
  const list = $('composeAttachList')
  list.innerHTML = ''
  state.composeFiles.forEach((f, idx) => {
    const chip = document.createElement('span')
    chip.className = 'mail-attachment-chip'
    chip.innerHTML =
      '<span>\u{1F4CE}</span>' +
      '<span>' + escapeHtml(f.filename) + '</span>' +
      '<span class="mail-attachment-size">' + formatBytes(f.size) + '</span>' +
      '<span style="color:#94a3b8;margin-left:0.3rem;">×</span>'
    chip.title = 'Remove attachment'
    chip.onclick = () => {
      state.composeFiles.splice(idx, 1)
      renderComposeAttachList()
    }
    list.appendChild(chip)
  })
}

function fileToBase64 (file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error('FileReader error'))
    reader.onload = () => {
      const result = reader.result || ''
      // result is "data:<mime>;base64,<payload>" — strip prefix.
      const idx = String(result).indexOf('base64,')
      resolve(idx >= 0 ? String(result).slice(idx + 7) : '')
    }
    reader.readAsDataURL(file)
  })
}

async function onSend (asDraft) {
  if (!state.selectedAccount) return
  const to = parseAddressList($('composeTo').value)
  if (to.length === 0) {
    $('composeStatus').innerText = 'Add at least one recipient.'
    return
  }
  if (state.selectedAccountAccess !== 'readwrite') {
    $('composeStatus').innerText = 'This connection is read-only. Switch /account/resources to read+write.'
    return
  }
  const cc = parseAddressList($('composeCc').value)
  const subject = $('composeSubject').value.trim()
  const bodyText = $('composeBody').value
  const threadId = $('composeBackdrop').dataset.threadId || undefined

  const params = { connectionName: state.selectedAccount, to, subject, bodyText }
  if (cc.length > 0) params.cc = cc
  if (state.composeFiles.length > 0) params.attachments = state.composeFiles
  if (threadId) params.threadId = threadId

  $('composeStatus').innerText = asDraft ? 'Saving draft…' : 'Sending…'
  $('btnSend').disabled = true
  $('btnSaveDraft').disabled = true
  try {
    const res = asDraft
      ? await freezr.connections.mail.createDraft(params)
      : await freezr.connections.mail.sendMessage(params)
    if (handleTokenExpired(res)) return
    $('composeStatus').innerText = asDraft ? 'Draft saved.' : 'Sent.'
    setTimeout(() => closeCompose(), 600)
    showInfo(asDraft ? 'Draft saved.' : 'Message sent.')
  } catch (err) {
    if (handleTokenExpired(err)) return
    $('composeStatus').innerText = (asDraft ? 'Save failed: ' : 'Send failed: ') + (err?.message || String(err))
  } finally {
    $('btnSend').disabled = false
    $('btnSaveDraft').disabled = false
  }
}

function parseAddressList (raw) {
  if (!raw) return []
  // Naive split — Gmail will validate downstream.
  return String(raw).split(/[,;]/).map(s => s.trim()).filter(Boolean)
}

function stripTags (html) {
  if (!html) return ''
  const div = document.createElement('div')
  div.innerHTML = String(html)
  return (div.innerText || div.textContent || '').trim()
}

// ------------------------------------------------------------------------------------
//  Mobile view toggle (list <-> reader)
// ------------------------------------------------------------------------------------

function setMobileView (view) {
  const app = $('mailApp')
  app.dataset.mobileView = view
  $('btnBackToList').style.display = view === 'reader' && window.matchMedia('(max-width: 900px)').matches ? '' : 'none'
}

// ------------------------------------------------------------------------------------
//  Banners + helpers
// ------------------------------------------------------------------------------------

function showError (msg) { setBanner('warnBanner', msg, true) }
function hideError ()    { setBanner('warnBanner', '', false) }
function showWarn (msg)  { setBanner('reauthBanner', msg, true) }
function hideReauth ()   { setBanner('reauthBanner', '', false) }
function showInfo (msg)  {
  const b = $('infoBanner')
  if (!msg) { b.style.display = 'none'; b.innerHTML = ''; return }
  b.style.display = 'block'
  b.innerHTML = msg
  clearTimeout(showInfo._t)
  showInfo._t = setTimeout(() => { b.style.display = 'none' }, 4000)
}
function setBanner (id, msg, show) {
  const b = $(id)
  if (!msg) { b.style.display = 'none'; b.innerHTML = ''; return }
  b.innerHTML = msg
  b.style.display = show ? 'block' : 'none'
}

// Detect token_expired in either response body OR error.data, then surface the banner.
function handleTokenExpired (resOrErr) {
  if (!resOrErr) return false
  const payload = (resOrErr.error === 'token_expired') ? resOrErr
                : (resOrErr.data && resOrErr.data.error === 'token_expired') ? resOrErr.data
                : null
  if (!payload) return false
  showWarn(
    'Your connection <b>' + escapeHtml(payload.connectionName || '') + '</b> needs to be reconnected. ' +
    '<a href="' + (payload.reauth_url || '/account/resources') + '">Reconnect</a>'
  )
  return true
}

function setListBusy (busy) {
  $('listSpinner').style.display = busy ? 'inline-block' : 'none'
  $('btnGetNew').disabled = busy
}

function $ (id) { return document.getElementById(id) }

function persist (key, value) { try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key) } catch (_) {} }
function read (key) { try { return localStorage.getItem(key) } catch (_) { return null } }

function escapeHtml (s) {
  if (s === null || s === undefined) return ''
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function formatDateShort (ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function formatDateFull (ms) {
  if (!ms) return ''
  return new Date(ms).toLocaleString()
}
