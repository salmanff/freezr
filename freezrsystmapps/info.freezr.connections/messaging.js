// messaging.js — the messaging viewer at /connections/messaging (Slack first).
//
// Conversations in a sidebar; the dialogue as chat bubbles — the connected
// user's own on the right, everyone else's on the left. Older messages page in
// on scroll (and via a button); new ones arrive through the per-conversation
// delta sync. Per-message actions: mark-unread-from-here and delete. Per-
// conversation actions: archive to Markdown, and bulk-delete what's loaded.
//
// Three provider details this file exists to smooth over:
//   1. Group DMs have machine names ("mpdm-a--b--c-1"), so we resolve their
//      members to real display names (falling back to parsing that string).
//   2. Message text is raw Slack mrkdwn — "<@U123> has joined the channel"
//      needs entity resolution to read as "Salman joined the channel".
//   3. Read state is a per-conversation cursor, not a per-message flag, so
//      "mark unread" means moving the cursor to just before a message.
/* global freezr confirm */

const PAGE_SIZE = 25
// Start a new avatar/name group when the sender changes or this much time passes.
const GROUP_GAP_MS = 5 * 60 * 1000
// Conversations are paged 200 at a time. Big workspaces run to thousands, so we
// keep paging rather than showing an arbitrary first slice — the cap is only a
// runaway guard (25 × 200 = 5000), and we say so when we hit it.
const CONVO_PAGE_SIZE = 200
const MAX_CONVO_PAGES = 25
// Each group DM needs its own members call to get real names. Past this many we
// stop and let the rest fall back to names parsed from the mpdm string, so a
// workspace with hundreds of group DMs doesn't spend minutes on lookups.
const MAX_GROUP_DM_LOOKUPS = 30
// Bulk thread fetching: pages per thread (200 replies each) — a runaway guard,
// not an expected ceiling.
const THREAD_PAGE_SIZE = 200
const MAX_THREAD_PAGES = 10

const state = {
  accounts: [],
  selectedAccount: null,
  selectedAccess: 'read',
  ownUserId: null,          // the connected user — decides which side a bubble sits on
  teamName: null,
  conversations: [],
  selectedConvo: null,
  messages: [],             // oldest → newest (render order)
  nextCursor: null,         // pages OLDER
  newerToken: null,         // delta-sync high-water mark
  users: {},                // userId → { displayName, avatar }
  readCursorTs: null,       // where "mark unread" last put the cursor (this session)
  loadingOlder: false,
  // parentMessageId → { open, loading, messages, nextCursor }. Threads render
  // inline beneath their parent rather than in a side panel: they're usually a
  // handful of replies, and expanding in place keeps the reading position.
  threads: {},
  socketTestMode: false // dialogue pane shows raw getChanges JSON instead of messages
}

let socketTestTimer = null

const $ = (id) => document.getElementById(id)

const escapeHtml = function (s) {
  if (s === null || s === undefined) return ''
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/* =====================================================================
 *  Banners / chrome
 * =================================================================== */

const showWarn = function (msg) {
  const div = $('warnBanner')
  div.style.display = msg ? 'block' : 'none'
  div.innerText = msg || ''
}

let infoTimer = null
const showInfo = function (msg, ms) {
  const div = $('infoBanner')
  div.style.display = msg ? 'block' : 'none'
  div.innerText = msg || ''
  if (infoTimer) clearTimeout(infoTimer)
  if (msg) infoTimer = setTimeout(() => { div.style.display = 'none' }, ms || 5000)
}

const showReauth = function (payload) {
  const div = $('reauthBanner')
  const url = (payload && payload.reauth_url) || '/account/resources'
  div.style.display = 'block'
  div.innerHTML = 'This connection needs to be reauthorized. <a href="' + escapeHtml(url) + '">Reconnect</a>'
}

// True (and banner shown) when the error is the structured token_expired payload.
const handleTokenExpired = function (resOrErr) {
  const payload = resOrErr?.data?.error === 'token_expired' ? resOrErr.data
    : (resOrErr?.error === 'token_expired' ? resOrErr : null)
  if (!payload) return false
  showReauth(payload)
  return true
}

const setBusy = function (yes) { $('spinner').style.display = yes ? 'inline' : 'none' }

const fail = function (prefix, err) {
  if (!handleTokenExpired(err)) showWarn(prefix + ': ' + (err?.message || err))
}

/* =====================================================================
 *  Slack mrkdwn → HTML
 *
 *  Slack sends entities as real angle brackets (<@U123>, <#C1|general>,
 *  <https://x|label>) while escaping user-typed &, < and > as HTML entities.
 *  So we tokenize on the entity pattern FIRST, then decode-and-escape the
 *  plain segments between them — escaping the whole string up front would
 *  mangle the entities, and escaping after would double-escape user text.
 * =================================================================== */

const SLACK_ENTITY_RX = /<([^<>]+)>/g

const decodeSlackEscapes = (s) => s
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&') // last, so "&amp;lt;" survives as literal "&lt;"

// Inline markdown on ALREADY-ESCAPED text: `code`, *bold*, _italic_, ~strike~.
const applyInlineMarkdown = (escaped) => escaped
  .replace(/```([\s\S]+?)```/g, (m, code) => '<pre>' + code + '</pre>')
  .replace(/`([^`\n]+)`/g, '<code>$1</code>')
  .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<b>$2</b>')
  .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<i>$2</i>')
  .replace(/(^|[\s(])~([^~\n]+)~/g, '$1<s>$2</s>')

const plainSegment = (raw) => applyInlineMarkdown(escapeHtml(decodeSlackEscapes(raw)))

const userLabel = function (userId) {
  const u = state.users[userId]
  return (u && u.displayName) ? u.displayName : userId
}

// Render one <...> entity. Returns HTML.
const renderEntity = function (inner) {
  const pipe = inner.indexOf('|')
  const head = pipe === -1 ? inner : inner.slice(0, pipe)
  const label = pipe === -1 ? null : inner.slice(pipe + 1)

  if (head.startsWith('@')) {
    const id = head.slice(1)
    return '<span class="msgr-mention">@' + escapeHtml(label || userLabel(id)) + '</span>'
  }
  if (head.startsWith('#')) {
    const id = head.slice(1)
    return '<span class="msgr-mention">#' + escapeHtml(label || id) + '</span>'
  }
  if (head.startsWith('!')) {
    // <!here>, <!channel>, <!everyone>, <!date^...>
    return '<span class="msgr-mention">@' + escapeHtml(label || head.slice(1).split('^')[0]) + '</span>'
  }
  // Otherwise a link. Only http(s) and mailto are turned into anchors.
  const safe = /^(https?:|mailto:)/i.test(head)
  if (!safe) return escapeHtml(label || head)
  return '<a href="' + escapeHtml(head) + '" target="_blank" rel="noopener noreferrer">' +
    escapeHtml(label || head) + '</a>'
}

const formatSlackText = function (text) {
  if (!text) return ''
  let out = ''
  let lastIndex = 0
  SLACK_ENTITY_RX.lastIndex = 0
  let m
  while ((m = SLACK_ENTITY_RX.exec(text)) !== null) {
    out += plainSegment(text.slice(lastIndex, m.index))
    out += renderEntity(m[1])
    lastIndex = m.index + m[0].length
  }
  out += plainSegment(text.slice(lastIndex))
  return out
}

// Same, but flattened to plain text — used for the Markdown export.
const slackTextToPlain = function (text) {
  if (!text) return ''
  return decodeSlackEscapes(String(text).replace(SLACK_ENTITY_RX, (full, inner) => {
    const pipe = inner.indexOf('|')
    const head = pipe === -1 ? inner : inner.slice(0, pipe)
    const label = pipe === -1 ? null : inner.slice(pipe + 1)
    if (head.startsWith('@')) return '@' + (label || userLabel(head.slice(1)))
    if (head.startsWith('#')) return '#' + (label || head.slice(1))
    if (head.startsWith('!')) return '@' + (label || head.slice(1).split('^')[0])
    return label ? (label + ' (' + head + ')') : head
  }))
}

/* =====================================================================
 *  Message classification
 * =================================================================== */

// Subtypes that still carry a real user message; everything else with a
// subtype (channel_join, channel_topic, …) renders as a system line.
const CONTENT_SUBTYPES = new Set(['bot_message', 'me_message', 'thread_broadcast', 'file_share', 'file_comment'])
const isSystemMessage = (m) => !!m.subtype && !CONTENT_SUBTYPES.has(m.subtype)
const isOwnMessage = (m) => !!state.ownUserId && m.sender && m.sender.id === state.ownUserId

/* =====================================================================
 *  Init
 * =================================================================== */

freezr.initPageScripts = async function () {
  $('accountPicker').onchange = onAccountChanged
  $('convoFilter').addEventListener('input', renderConversations)
  $('btnGetOlder').onclick = () => getOlder()
  $('btnGetNew').onclick = getNew
  $('btnGetThreads').onclick = loadAllThreads
  $('btnExport').onclick = exportConversation
  $('btnSocketTest').onclick = enterSocketTest
  $('btnDeleteAll').onclick = deleteLoadedMessages
  $('btnSend').onclick = sendCurrent
  $('composeText').addEventListener('keydown', e => { if (e.key === 'Enter') sendCurrent() })

  // Scrolling to the top pulls in the previous page — the button stays as the
  // explicit affordance, this just makes it feel like a normal chat client.
  $('messagesPane').addEventListener('scroll', function () {
    if (this.scrollTop < 40) getOlder()
  })

  await loadAccounts()
}

const loadAccounts = async function () {
  setBusy(true)
  try {
    const res = await freezr.connections.messaging.listAccounts()
    const all = (res && res.accounts) ? res.accounts : []
    state.accounts = all.filter(a => Array.isArray(a.services) && a.services.includes('messaging'))
    const picker = $('accountPicker')
    picker.innerHTML = ''
    if (state.accounts.length === 0) {
      showWarn('No messaging connections yet. Add one at /connections/new (provider: Slack).')
      return
    }
    state.accounts.forEach(a => {
      const opt = document.createElement('option')
      opt.value = a.connectionName
      opt.innerText = a.connectionName + (a.account_email ? (' (' + a.account_email + ')') : '')
      picker.appendChild(opt)
    })
    await onAccountChanged()
  } catch (err) {
    fail('Could not load accounts', err)
  } finally {
    setBusy(false)
  }
}

const onAccountChanged = async function () {
  showWarn('')
  const name = $('accountPicker').value
  const account = state.accounts.find(a => a.connectionName === name)
  if (!account) return

  state.selectedAccount = name
  state.selectedAccess = account.access?.messaging === 'readwrite' ? 'readwrite' : 'read'
  state.ownUserId = null
  state.teamName = null
  state.users = {}
  state.conversations = []
  clearDialogue()

  $('accountMeta').innerText = (account.provider || '') + ' · ' + state.selectedAccess

  // Identity first: without it every bubble would render as "someone else".
  try {
    const res = await freezr.connections.messaging.getProfile({ connectionName: name })
    state.ownUserId = res.profile?.userId || null
    state.teamName = res.profile?.teamName || null
    if (state.ownUserId) {
      state.users[state.ownUserId] = {
        displayName: res.profile.displayName || 'You',
        avatar: null
      }
    }
    $('accountMeta').innerText = (account.provider || '') +
      (state.teamName ? (' · ' + state.teamName) : '') + ' · ' + state.selectedAccess
  } catch (err) {
    if (handleTokenExpired(err)) return
    console.warn('Could not load profile (own messages will not be highlighted):', err?.message || err)
  }

  await loadConversations()
}

const clearDialogue = function () {
  exitSocketTest()
  state.selectedConvo = null
  state.messages = []
  state.nextCursor = null
  state.newerToken = null
  state.readCursorTs = null
  state.threads = {}
  $('currentConvoLabel').innerText = 'Pick a conversation'
  $('currentConvoSub').innerText = ''
  $('btnGetNew').style.display = 'none'
  $('btnGetThreads').style.display = 'none'
  $('btnExport').style.display = 'none'
  $('btnDeleteAll').style.display = 'none'
  $('composer').style.display = 'none'
  $('messagesEmpty').style.display = 'block'
  $('messagesList').innerHTML = ''
  $('olderWrap').style.display = 'none'
}

/* =====================================================================
 *  Conversations
 * =================================================================== */

// Page through EVERY conversation the user belongs to. The provider returns at
// most 200 per call in no documented order, so stopping at the first page shows
// an effectively arbitrary subset — on a large workspace that looks like
// "channels are missing". Each page is painted as it arrives.
const loadConversations = async function () {
  setBusy(true)
  const connectionName = state.selectedAccount
  try {
    state.conversations = []
    let cursor = null
    let pages = 0
    do {
      const res = await freezr.connections.messaging.listConversations({
        connectionName, limit: CONVO_PAGE_SIZE, cursor: cursor || undefined
      })
      if (connectionName !== state.selectedAccount) return // account switched mid-load
      state.conversations = state.conversations.concat(res.conversations || [])
      cursor = res.nextCursor || null
      pages++
      renderConversations()
      if (cursor) showInfo('Loading conversations… ' + state.conversations.length + ' so far', 60000)
    } while (cursor && pages < MAX_CONVO_PAGES)

    if (cursor) {
      showWarn('Stopped at ' + state.conversations.length + ' conversations (safety limit). ' +
        'Everything loaded is listed; there are more on the workspace.')
    } else {
      showInfo(state.conversations.length + ' conversations loaded.')
    }
    renderConversations()
    // DM and group-DM names need user lookups; fill them in after the list is
    // on screen so the sidebar is usable immediately.
    resolveConversationNames()
  } catch (err) {
    fail('Could not load conversations', err)
  } finally {
    setBusy(false)
  }
}

// "mpdm-salman--raphaelle--richard-1" → ['salman','raphaelle','richard'].
// Used as an immediate label and as the fallback if member lookup fails.
const parseMpdmHandles = function (name) {
  if (!name || !name.startsWith('mpdm-')) return []
  return name.replace(/^mpdm-/, '').replace(/-\d+$/, '').split('--').filter(Boolean)
}

const titleCase = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s

// Resolve DM counterparts and group-DM members to real display names.
// Group DMs need a members call each, so they're done one at a time and the
// sidebar is repainted once at the end.
const resolveConversationNames = async function () {
  const connectionName = state.selectedAccount
  try {
    const dmIds = state.conversations
      .filter(c => c.type === 'dm' && c.counterpartUserId)
      .map(c => c.counterpartUserId)
    if (dmIds.length > 0) await resolveUserIds(dmIds)

    const groupDms = state.conversations.filter(c => c.type === 'group_dm').slice(0, MAX_GROUP_DM_LOOKUPS)
    for (const convo of groupDms) {
      if (connectionName !== state.selectedAccount) return // account switched mid-flight
      try {
        const res = await freezr.connections.messaging.getConversationMembers({
          connectionName, conversationId: convo.id, limit: 20
        })
        const ids = (res.memberIds || []).filter(id => id !== state.ownUserId)
        await resolveUserIds(ids)
        convo.memberNames = ids.map(id => userLabel(id))
      } catch (e) {
        console.warn('Could not resolve members for ' + convo.id + ':', e?.message || e)
      }
    }
    renderConversations()
  } catch (err) {
    console.warn('Conversation name resolution failed (non-fatal):', err?.message || err)
  }
}

const convoDisplayName = function (c) {
  if (c.type === 'dm') return state.users[c.counterpartUserId]?.displayName || c.counterpartUserId || 'Direct message'
  if (c.type === 'group_dm') {
    if (c.memberNames && c.memberNames.length) return c.memberNames.join(', ')
    const handles = parseMpdmHandles(c.name)
    if (handles.length) return handles.map(titleCase).join(', ')
    return c.name || 'Group message'
  }
  return c.name || c.id
}

const convoIcon = function (c) {
  if (c.type === 'dm') return '👤'
  if (c.type === 'group_dm') return '👥'
  if (c.type === 'private_channel') return '🔒'
  return '#'
}

const renderConversations = function () {
  const list = $('convoList')
  list.innerHTML = ''
  const needle = ($('convoFilter').value || '').trim().toLowerCase()
  const sections = [
    { label: 'Channels', types: ['channel', 'private_channel'] },
    { label: 'Direct messages', types: ['dm', 'group_dm'] }
  ]
  let shown = 0
  sections.forEach(sec => {
    // The provider returns conversations in no useful order, so sort by the
    // name actually displayed — otherwise a long list is impossible to scan.
    const convos = state.conversations
      .filter(c => sec.types.includes(c.type))
      .map(c => ({ c, label: convoDisplayName(c) }))
      .filter(x => !needle || x.label.toLowerCase().includes(needle))
      .sort((a, b) => a.label.localeCompare(b.label))
    if (convos.length === 0) return
    const head = document.createElement('div')
    head.className = 'msgr-convo-section'
    head.innerText = sec.label + ' (' + convos.length + ')'
    list.appendChild(head)
    shown += convos.length
    convos.forEach(({ c }) => {
      const btn = document.createElement('button')
      btn.className = 'msgr-convo' + (c.id === state.selectedConvo ? ' is-selected' : '')
      btn.title = c.topic || c.purpose || ''
      const icon = document.createElement('span')
      icon.className = 'msgr-convo-icon'
      icon.innerText = convoIcon(c)
      const nameEl = document.createElement('span')
      nameEl.className = 'msgr-convo-name'
      nameEl.innerText = convoDisplayName(c)
      btn.appendChild(icon)
      btn.appendChild(nameEl)
      btn.onclick = () => openConversation(c.id)
      list.appendChild(btn)
    })
  })
  if (shown === 0) {
    list.innerHTML = '<div class="msgr-convo-section">' +
      (needle ? 'No matches for that filter' : 'No conversations found') + '</div>'
  }
}

/* =====================================================================
 *  User resolution
 * =================================================================== */

const resolveUserIds = async function (ids) {
  const unknown = [...new Set((ids || []).filter(id => id && !state.users[id]))]
  if (unknown.length === 0) return
  try {
    const res = await freezr.connections.messaging.getUsers({
      connectionName: state.selectedAccount, ids: unknown.slice(0, 100)
    })
    ;(res.users || []).forEach(u => {
      state.users[u.id] = { displayName: u.displayName || u.name || u.id, avatar: u.avatar || null }
    })
  } catch (e) {
    console.warn('Could not resolve users (non-fatal):', e?.message || e)
  }
}

// Every id a set of messages needs: the senders plus anyone they @-mention.
const resolveUsersInMessages = async function (messages) {
  const ids = []
  ;(messages || []).forEach(m => {
    if (m.sender && m.sender.type === 'user' && m.sender.id) ids.push(m.sender.id)
    const text = m.text || ''
    const rx = /<@([A-Z0-9]+)(\|[^>]*)?>/g
    let match
    while ((match = rx.exec(text)) !== null) ids.push(match[1])
  })
  await resolveUserIds(ids)
}

/* =====================================================================
 *  Socket test — the dialogue pane shows the raw getChanges JSON so anyone
 *  deploying live updates can verify the whole socket pipeline from here:
 *  post / edit / delete in Slack, refresh, watch the index change. Exits when
 *  a conversation is opened or the account changes.
 * =================================================================== */

const stopSocketTestTimer = function () {
  if (socketTestTimer) { clearInterval(socketTestTimer); socketTestTimer = null }
}

const exitSocketTest = function () {
  state.socketTestMode = false
  stopSocketTestTimer()
}

const enterSocketTest = function () {
  if (!state.selectedAccount) return
  showWarn('')
  state.socketTestMode = true
  state.selectedConvo = null
  renderConversations() // clear any selection highlight
  $('currentConvoLabel').innerText = '⚡ Socket test — ' + state.selectedAccount
  $('currentConvoSub').innerText = 'The live-updates activity index (metadata only — message content is never stored). Post, edit or delete in Slack, then Refresh.'
  $('btnGetNew').style.display = 'none'
  $('btnGetThreads').style.display = 'none'
  $('btnExport').style.display = 'none'
  $('btnDeleteAll').style.display = 'none'
  $('composer').style.display = 'none'
  $('messagesEmpty').style.display = 'none'
  $('olderWrap').style.display = 'none'
  runSocketTest()
}

const runSocketTest = async function () {
  if (!state.socketTestMode) return
  setBusy(true)
  let result = null
  let errText = null
  try {
    result = await freezr.connections.messaging.getChanges({ connectionName: state.selectedAccount })
  } catch (err) {
    if (handleTokenExpired(err)) { setBusy(false); return }
    errText = err?.message || String(err)
  } finally {
    setBusy(false)
  }
  if (!state.socketTestMode) return // user navigated away mid-fetch
  renderSocketTest(result, errText)
}

const socketTestVerdict = function (r) {
  const n = (r.changes || []).length
  if (r.gapSince) {
    return { cls: 'warn', text: '⚠ Socket appears DOWN — gap open since ' + socketTestDate(r.gapSince) + '. Events since then are not being indexed. Start it on /admin/sockets (admin).' }
  }
  if (!r.complete) {
    // complete is relative to the QUERIED window (this test asks since:0 = all
    // history), so any past gap keeps it false here. Say which gap, so a human
    // can tell "dropped just now" from "I stopped it during testing last week" —
    // and that apps querying since after the gap's end get complete:true.
    const gaps = r.gaps || []
    const last = gaps.length ? gaps[gaps.length - 1] : null
    const gapText = last
      ? 'Last downtime: ' + socketTestDate(last.from) + ' → ' + (last.to ? socketTestDate(last.to) : 'ongoing') + '. '
      : ''
    return {
      cls: 'warn',
      text: '⚠ complete: false for this all-history window. ' + gapText +
        'New events ARE being indexed now. An app asking "changes since <after that gap>" gets complete: true — the flag heals as sync windows move past the gap.'
    }
  }
  if (n === 0) {
    return { cls: 'ok', text: 'No indexed activity yet. If sockets are running and this connection has Live updates ON, post a message in Slack and press Refresh. Otherwise: /admin/sockets (admin) and the Live updates toggle on /account/resources.' }
  }
  return { cls: 'ok', text: '✓ ' + n + ' conversation(s) with indexed activity, no gaps — the socket pipeline is working.' }
}

// Human-readable dates for the JSON's two clocks: lastEventAt is a ms epoch
// (when freezr processed the event); lastActivityTs is the provider message id
// (Slack: seconds.decimals — ×1000 for the message's own send time).
const socketTestDate = function (ms) {
  if (!ms || !Number.isFinite(ms)) return '—'
  const d = new Date(ms)
  const secs = Math.round((Date.now() - ms) / 1000)
  const rel = secs < 0 ? '' : secs < 90 ? secs + 's ago' : secs < 5400 ? Math.round(secs / 60) + ' min ago' : Math.round(secs / 3600) + ' h ago'
  return d.toLocaleString() + (rel ? ' (' + rel + ')' : '')
}

const socketTestSummary = function (result) {
  const changes = result.changes || []
  if (changes.length === 0) return ''
  const rows = changes.slice(0, 8).map(c => {
    const convo = state.conversations.find(x => x.id === c.conversationId)
    const name = convo ? convoDisplayName(convo) : c.conversationId
    return '<tr>' +
      '<td style="padding:2px 10px 2px 0;">' + escapeHtml(name) + '</td>' +
      '<td style="padding:2px 10px 2px 0;">' + escapeHtml(socketTestDate(c.lastEventAt)) + '</td>' +
      '<td style="padding:2px 0;">' + escapeHtml(socketTestDate(parseFloat(c.lastActivityTs) * 1000)) + '</td>' +
      '</tr>'
  }).join('')
  return '<table style="font-size:0.8rem; color:var(--msgr-muted); margin-bottom:0.6rem; border-collapse:collapse;">' +
    '<tr style="text-align:left;"><th style="padding:2px 10px 2px 0;">conversation</th>' +
    '<th style="padding:2px 10px 2px 0;">last event indexed</th>' +
    '<th style="padding:2px 0;">latest message sent</th></tr>' +
    rows +
    (changes.length > 8 ? ('<tr><td colspan="3" style="padding:2px 0;">… and ' + (changes.length - 8) + ' more (see JSON)</td></tr>') : '') +
    '</table>'
}

const renderSocketTest = function (result, errText) {
  const list = $('messagesList')
  const controls =
    '<div class="msgr-json-controls">' +
    '<button class="msgr-btn msgr-btn-primary" id="btnSocketTestRefresh">↻ Refresh</button>' +
    '<label><input type="checkbox" id="socketTestAuto"' + (socketTestTimer ? ' checked' : '') + '/> auto-refresh (5s)</label>' +
    '<span>freezr.connections.messaging.getChanges(…)</span>' +
    '</div>'

  if (errText) {
    list.innerHTML = controls + '<div class="msgr-json-verdict warn">✗ getChanges failed: ' + escapeHtml(errText) + '</div>'
  } else {
    const v = socketTestVerdict(result)
    list.innerHTML = controls +
      '<div class="msgr-json-verdict ' + v.cls + '">' + escapeHtml(v.text) + '</div>' +
      socketTestSummary(result) +
      '<div class="msgr-json"><pre>' + escapeHtml(JSON.stringify(result, null, 2)) + '</pre></div>'
  }

  $('btnSocketTestRefresh').onclick = runSocketTest
  $('socketTestAuto').onchange = function () {
    stopSocketTestTimer()
    if (this.checked) socketTestTimer = setInterval(runSocketTest, 5000)
  }
}

/* =====================================================================
 *  Loading messages
 * =================================================================== */

const openConversation = async function (conversationId) {
  exitSocketTest()
  showWarn('')
  state.selectedConvo = conversationId
  state.messages = []
  state.nextCursor = null
  state.newerToken = null
  state.readCursorTs = null
  state.threads = {}
  renderConversations()

  const convo = state.conversations.find(c => c.id === conversationId)
  $('currentConvoLabel').innerText = convo ? (convoIcon(convo) + ' ' + convoDisplayName(convo)) : conversationId
  $('currentConvoSub').innerText = convo ? (convo.topic || convo.purpose || '') : ''
  $('btnGetNew').style.display = 'inline-flex'
  $('btnGetThreads').style.display = 'inline-flex'
  $('btnExport').style.display = 'inline-flex'
  $('btnDeleteAll').style.display = state.selectedAccess === 'readwrite' ? 'inline-flex' : 'none'
  $('composer').style.display = state.selectedAccess === 'readwrite' ? 'flex' : 'none'
  $('messagesEmpty').style.display = 'none'

  setBusy(true)
  try {
    const res = await freezr.connections.messaging.getMessages({
      connectionName: state.selectedAccount, conversationId, limit: PAGE_SIZE
    })
    // The API returns newest-first; the dialogue reads oldest → newest.
    state.messages = (res.messages || []).slice().reverse()
    state.nextCursor = res.nextCursor || null
    state.newerToken = state.messages.length ? state.messages[state.messages.length - 1].id : null
    await resolveUsersInMessages(state.messages)
    renderMessages({ scroll: 'bottom' })
  } catch (err) {
    fail('Could not load messages', err)
  } finally {
    setBusy(false)
  }
}

const getOlder = async function () {
  if (!state.nextCursor || !state.selectedConvo || state.loadingOlder) return
  state.loadingOlder = true
  setBusy(true)
  try {
    const res = await freezr.connections.messaging.getMessages({
      connectionName: state.selectedAccount,
      conversationId: state.selectedConvo,
      limit: PAGE_SIZE,
      cursor: state.nextCursor
    })
    const older = (res.messages || []).slice().reverse()
    state.messages = older.concat(state.messages)
    state.nextCursor = res.nextCursor || null
    await resolveUsersInMessages(older)
    renderMessages({ scroll: 'anchor' })
  } catch (err) {
    fail('Could not load older messages', err)
  } finally {
    state.loadingOlder = false
    setBusy(false)
  }
}

const getNew = async function () {
  if (!state.selectedConvo) return
  setBusy(true)
  try {
    const res = await freezr.connections.messaging.getNewer({
      connectionName: state.selectedAccount,
      conversationId: state.selectedConvo,
      lastToken: state.newerToken || undefined
    })
    const fresh = (res.messages || []).slice().reverse()
    if (fresh.length > 0) {
      const known = new Set(state.messages.map(m => m.id))
      const additions = fresh.filter(m => !known.has(m.id))
      if (additions.length > 0) {
        state.messages = state.messages.concat(additions)
        await resolveUsersInMessages(additions)
        renderMessages({ scroll: 'bottom' })
        showInfo(additions.length + ' new message' + (additions.length === 1 ? '' : 's') + '.')
      }
    } else {
      showInfo('No new messages.')
    }
    state.newerToken = res.nextToken || state.newerToken
  } catch (err) {
    fail('Could not check for new messages', err)
  } finally {
    setBusy(false)
  }
}

/* =====================================================================
 *  Rendering the dialogue
 * =================================================================== */

const formatTime = function (ms) {
  if (!ms) return ''
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const formatDay = function (ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const today = new Date()
  const yesterday = new Date(today.getTime() - 86400000)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
}

const initialsFor = function (name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2)
  return parts[0][0] + parts[1][0]
}

const buildAvatar = function (userId, name) {
  const wrap = document.createElement('div')
  wrap.className = 'msgr-avatar'
  wrap.innerText = initialsFor(name)
  const url = state.users[userId]?.avatar
  if (url) {
    // If the provider's image CDN is blocked (CSP) or the URL 404s, drop the
    // <img> and leave the initials showing underneath.
    const img = document.createElement('img')
    img.alt = ''
    img.onerror = function () { img.remove() }
    img.src = url
    wrap.appendChild(img)
  }
  return wrap
}

const senderNameOf = function (m) {
  if (!m.sender || !m.sender.id) return 'Unknown'
  if (m.sender.type === 'bot') return state.users[m.sender.id]?.displayName || 'Bot'
  return userLabel(m.sender.id)
}

/**
 * Repaint the dialogue.
 * @param {Object} opts
 * @param {'bottom'|'anchor'|'keep'} opts.scroll
 *   bottom — jump to the newest message (open, send, get-new)
 *   anchor — hold the current message still while older ones prepend above it
 *   keep   — leave the viewport exactly where it is (thread expand, delete)
 */
const renderMessages = function ({ scroll }) {
  const pane = $('messagesPane')
  const list = $('messagesList')
  const prevHeight = pane.scrollHeight
  const prevTop = pane.scrollTop
  list.innerHTML = ''
  $('olderWrap').style.display = state.nextCursor ? 'block' : 'none'

  if (state.messages.length === 0) {
    list.innerHTML = '<div class="msgr-empty">No messages in this conversation yet.</div>'
    return
  }

  let lastDay = null
  let prev = null
  state.messages.forEach((m, i) => {
    const day = formatDay(m.sentAt)
    if (day !== lastDay) {
      const sep = document.createElement('div')
      sep.className = 'msgr-system'
      sep.innerText = day
      list.appendChild(sep)
      lastDay = day
      prev = null // always restart grouping after a day break
    }

    if (state.readCursorTs && prev && prev.id === state.readCursorTs) {
      const div = document.createElement('div')
      div.className = 'msgr-unread-divider'
      div.innerText = 'Unread from here'
      list.appendChild(div)
    }

    if (isSystemMessage(m)) {
      list.appendChild(buildSystemRow(m))
      prev = m
      return
    }

    const own = isOwnMessage(m)
    const grouped = prev && !isSystemMessage(prev) &&
      prev.sender?.id === m.sender?.id &&
      isOwnMessage(prev) === own &&
      (m.sentAt - prev.sentAt) < GROUP_GAP_MS

    list.appendChild(buildMessageRow(m, i, { own, grouped }))
    // An expanded thread hangs directly off its parent message.
    const thread = state.threads[m.id]
    if (thread && thread.open) list.appendChild(buildThreadBlock(m, thread))
    prev = m
  })

  if (scroll === 'bottom') {
    pane.scrollTop = pane.scrollHeight
  } else if (scroll === 'anchor') {
    pane.scrollTop = prevTop + (pane.scrollHeight - prevHeight)
  } else {
    pane.scrollTop = prevTop
  }
}

const buildSystemRow = function (m) {
  const div = document.createElement('div')
  div.className = 'msgr-system'
  // channel_join etc. read as "<@U123> has joined the channel" — formatting
  // resolves the mention, which is the whole point of rendering these.
  div.innerHTML = formatSlackText(m.text) || escapeHtml(m.subtype || 'event')
  return div
}

const buildMessageRow = function (m, index, { own, grouped, inThread }) {
  const row = document.createElement('div')
  row.className = 'msgr-row' + (own ? ' is-own' : '') + (inThread ? ' is-reply' : '')

  const name = senderNameOf(m)
  if (grouped) {
    const spacer = document.createElement('div')
    spacer.className = 'msgr-avatar-spacer'
    row.appendChild(spacer)
  } else {
    row.appendChild(buildAvatar(m.sender?.id, name))
  }

  const wrap = document.createElement('div')
  wrap.className = 'msgr-bubble-wrap'

  if (!grouped) {
    const senderEl = document.createElement('div')
    senderEl.className = 'msgr-sender'
    senderEl.innerText = own ? 'You' : name
    wrap.appendChild(senderEl)
  }

  const bubble = document.createElement('div')
  bubble.className = 'msgr-bubble'

  const textEl = document.createElement('div')
  textEl.className = 'msgr-text'
  textEl.innerHTML = formatSlackText(m.text) || '<i>(no text)</i>'
  bubble.appendChild(textEl)

  if (m.files && m.files.length > 0) {
    const files = document.createElement('div')
    files.className = 'msgr-files'
    files.innerText = '📎 ' + m.files.map(f => f.filename).join(', ')
    bubble.appendChild(files)
  }

  if (m.reactions && m.reactions.length > 0) {
    const reactions = document.createElement('div')
    reactions.className = 'msgr-reactions'
    reactions.innerText = m.reactions.map(r => ':' + r.name + ': ' + r.count).join('  ')
    bubble.appendChild(reactions)
  }

  wrap.appendChild(bubble)

  const foot = document.createElement('div')
  foot.className = 'msgr-bubble-foot'
  const time = document.createElement('span')
  time.innerText = formatTime(m.sentAt) + (m.edited ? ' (edited)' : '')
  foot.appendChild(time)

  if (m.replyCount > 0) {
    const open = state.threads[m.id] && state.threads[m.id].open
    const thread = document.createElement('button')
    thread.className = 'msgr-act msgr-thread-note'
    thread.innerText = (open ? '▾ ' : '💬 ') + m.replyCount +
      (m.replyCount === 1 ? ' reply' : ' replies')
    thread.title = open ? 'Hide thread' : 'Show thread'
    thread.onclick = () => toggleThread(m)
    foot.appendChild(thread)
  }

  if (state.selectedAccess === 'readwrite' && !inThread) {
    const actions = document.createElement('div')
    actions.className = 'msgr-actions'

    const unreadBtn = document.createElement('button')
    unreadBtn.className = 'msgr-act'
    unreadBtn.innerText = 'mark unread'
    unreadBtn.title = 'Move the read cursor to just before this message'
    unreadBtn.onclick = () => markUnreadFrom(index)
    actions.appendChild(unreadBtn)

    const delBtn = document.createElement('button')
    delBtn.className = 'msgr-act danger'
    delBtn.innerText = 'delete'
    delBtn.onclick = () => deleteOneMessage(m)
    actions.appendChild(delBtn)

    foot.appendChild(actions)
  }

  wrap.appendChild(foot)
  row.appendChild(wrap)
  return row
}

/* =====================================================================
 *  Threads — rendered inline under the parent message
 *
 *  A side panel is what Slack itself does, but this page already spends a
 *  column on the conversation list, and most threads are a handful of short
 *  replies. Expanding in place keeps the parent and the surrounding dialogue
 *  visible and doesn't disturb the reading position.
 * =================================================================== */

const toggleThread = async function (parent) {
  const existing = state.threads[parent.id]
  if (existing && existing.open) {
    existing.open = false
    renderMessages({ scroll: 'keep' })
    return
  }
  if (!existing) {
    state.threads[parent.id] = { open: true, loading: true, messages: [], nextCursor: null }
  } else {
    existing.open = true
  }
  renderMessages({ scroll: 'keep' }) // show the loading state immediately
  if (state.threads[parent.id].messages.length === 0) await loadThread(parent.id)
}

/**
 * Fetch a page of replies. The provider returns the PARENT as the first item
 * followed by its replies, so the parent is filtered out — it's already on
 * screen directly above.
 */
const loadThread = async function (parentId, cursor) {
  const thread = state.threads[parentId]
  if (!thread) return
  thread.loading = true
  renderMessages({ scroll: 'keep' })
  try {
    const res = await freezr.connections.messaging.getThread({
      connectionName: state.selectedAccount,
      conversationId: state.selectedConvo,
      threadId: parentId,
      limit: PAGE_SIZE,
      cursor
    })
    const replies = (res.messages || []).filter(m => m.id !== parentId)
    const known = new Set(thread.messages.map(m => m.id))
    thread.messages = thread.messages.concat(replies.filter(m => !known.has(m.id)))
    thread.nextCursor = res.nextCursor || null
    await resolveUsersInMessages(replies)
  } catch (err) {
    fail('Could not load thread', err)
  } finally {
    thread.loading = false
    renderMessages({ scroll: 'keep' })
  }
}

/**
 * Fetch EVERY page of one thread. Unlike loadThread this doesn't repaint per
 * page — the bulk loader repaints once at the end — and it replaces rather than
 * appends, so calling it on an already-part-loaded thread is safe.
 */
const fetchWholeThread = async function (parentId) {
  const thread = state.threads[parentId] ||
    { open: false, loading: false, messages: [], nextCursor: null }
  state.threads[parentId] = thread

  const collected = []
  let cursor = null
  let pages = 0
  do {
    const res = await freezr.connections.messaging.getThread({
      connectionName: state.selectedAccount,
      conversationId: state.selectedConvo,
      threadId: parentId,
      limit: THREAD_PAGE_SIZE,
      cursor: cursor || undefined
    })
    // The provider echoes the parent as the first item — it's already on screen.
    collected.push(...(res.messages || []).filter(m => m.id !== parentId))
    cursor = res.nextCursor || null
    pages++
  } while (cursor && pages < MAX_THREAD_PAGES)

  thread.messages = collected
  thread.nextCursor = cursor
  thread.loading = false
  return collected
}

/**
 * Fetch every thread hanging off the loaded messages, so Archive can include
 * them. Threads stay collapsed — this is about having the data, and expanding
 * hundreds of replies would bury the conversation — but they now open instantly.
 * Sequential, because each thread is its own request and the provider's history
 * endpoints are the rate-limited ones.
 */
const loadAllThreads = async function () {
  if (!state.selectedConvo) return
  const parents = state.messages.filter(m => m.replyCount > 0)
  if (parents.length === 0) {
    showInfo('No threads in the loaded messages.')
    return
  }

  setBusy(true)
  let done = 0
  let replies = 0
  let failed = 0
  const allReplies = []

  for (const parent of parents) {
    if (!state.selectedConvo) break // conversation changed under us
    try {
      const got = await fetchWholeThread(parent.id)
      allReplies.push(...got)
      replies += got.length
      // Keep the parent's count honest if the provider's was stale.
      parent.replyCount = got.length || parent.replyCount
    } catch (err) {
      if (handleTokenExpired(err)) break
      failed++
    }
    done++
    showInfo('Fetching threads… ' + done + '/' + parents.length, 60000)
  }

  await resolveUsersInMessages(allReplies)
  renderMessages({ scroll: 'keep' })
  setBusy(false)
  showInfo('Fetched ' + (done - failed) + ' of ' + parents.length + ' threads (' +
    replies + ' replies)' + (failed ? ('; ' + failed + ' failed') : '') +
    '. They are included in Archive — click a reply count to read one.', 9000)
}

const buildThreadBlock = function (parent, thread) {
  const block = document.createElement('div')
  block.className = 'msgr-thread'

  if (thread.messages.length === 0 && thread.loading) {
    const loading = document.createElement('div')
    loading.className = 'msgr-thread-status'
    loading.innerText = 'Loading replies…'
    block.appendChild(loading)
    return block
  }

  if (thread.nextCursor) {
    const moreWrap = document.createElement('div')
    moreWrap.className = 'msgr-thread-status'
    const moreBtn = document.createElement('button')
    moreBtn.className = 'msgr-act'
    moreBtn.innerText = thread.loading ? 'Loading…' : '↑ Load more replies'
    moreBtn.disabled = !!thread.loading
    moreBtn.onclick = () => loadThread(parent.id, thread.nextCursor)
    moreWrap.appendChild(moreBtn)
    block.appendChild(moreWrap)
  }

  let prev = null
  thread.messages.forEach((m, i) => {
    if (isSystemMessage(m)) {
      block.appendChild(buildSystemRow(m))
      prev = m
      return
    }
    const own = isOwnMessage(m)
    const grouped = prev && !isSystemMessage(prev) &&
      prev.sender?.id === m.sender?.id &&
      isOwnMessage(prev) === own &&
      (m.sentAt - prev.sentAt) < GROUP_GAP_MS
    // Replies get no per-message actions: mark-unread is a conversation-level
    // cursor (meaningless mid-thread) and deleting is offered on the main list.
    block.appendChild(buildMessageRow(m, i, { own, grouped, inThread: true }))
    prev = m
  })

  if (state.selectedAccess === 'readwrite') {
    const replyRow = document.createElement('div')
    replyRow.className = 'msgr-thread-reply'
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'input'
    input.placeholder = 'Reply in thread…'
    const btn = document.createElement('button')
    btn.className = 'msgr-btn'
    btn.innerText = 'Reply'
    const send = () => sendThreadReply(parent.id, input)
    btn.onclick = send
    input.addEventListener('keydown', e => { if (e.key === 'Enter') send() })
    replyRow.appendChild(input)
    replyRow.appendChild(btn)
    block.appendChild(replyRow)
  }

  return block
}

const sendThreadReply = async function (parentId, input) {
  const text = input.value.trim()
  if (!text) return
  setBusy(true)
  try {
    await freezr.connections.messaging.sendMessage({
      connectionName: state.selectedAccount,
      conversationId: state.selectedConvo,
      text,
      threadId: parentId
    })
    input.value = ''
    // Re-fetch the thread from scratch so the new reply appears in order.
    const thread = state.threads[parentId]
    if (thread) { thread.messages = []; thread.nextCursor = null }
    await loadThread(parentId)
    // Keep the parent's reply count honest without a full conversation reload.
    const parent = state.messages.find(m => m.id === parentId)
    if (parent && thread) parent.replyCount = thread.messages.length
    renderMessages({ scroll: 'keep' })
    showInfo('Reply sent.')
  } catch (err) {
    fail('Could not send reply', err)
  } finally {
    setBusy(false)
  }
}

/* =====================================================================
 *  Per-message actions
 * =================================================================== */

// Slack models read state as a per-conversation cursor, so "unread from here"
// means moving the cursor to the message BEFORE this one. At the very top of
// what's loaded there is no previous message to point at, so we say so rather
// than guessing a timestamp.
const markUnreadFrom = async function (index) {
  const prev = state.messages[index - 1]
  if (!prev) {
    showWarn('Load older messages first — marking unread needs the message just before this one.')
    return
  }
  setBusy(true)
  try {
    await freezr.connections.messaging.markRead({
      connectionName: state.selectedAccount,
      conversationId: state.selectedConvo,
      ts: prev.id
    })
    state.readCursorTs = prev.id
    renderMessages({ scroll: 'keep' })
    showInfo('Marked unread from this message — it will show as unread in Slack.')
  } catch (err) {
    fail('Could not mark unread', err)
  } finally {
    setBusy(false)
  }
}

const deleteOneMessage = async function (m) {
  if (!confirm('Delete this message? This cannot be undone.\n\n' + (slackTextToPlain(m.text) || '(no text)').slice(0, 200))) return
  setBusy(true)
  try {
    await freezr.connections.messaging.deleteMessage({
      connectionName: state.selectedAccount,
      conversationId: state.selectedConvo,
      messageId: m.id
    })
    state.messages = state.messages.filter(x => x.id !== m.id)
    renderMessages({ scroll: 'keep' })
    showInfo('Message deleted.')
  } catch (err) {
    // Slack refuses other people's messages — say which, rather than "failed".
    const provider = err?.data?.providerError
    if (provider === 'cant_delete_message' || provider === 'message_not_found') {
      showWarn('Slack would not delete that message — you can normally only delete your own.')
    } else {
      fail('Could not delete message', err)
    }
  } finally {
    setBusy(false)
  }
}

/* =====================================================================
 *  Conversation actions
 * =================================================================== */

const currentConvoName = function () {
  const convo = state.conversations.find(c => c.id === state.selectedConvo)
  return convo ? convoDisplayName(convo) : (state.selectedConvo || 'conversation')
}

// Archive what's loaded as Markdown. Everything needed is already in memory,
// so this is a pure client-side download — no extra provider calls.
const exportConversation = function () {
  if (!state.selectedConvo || state.messages.length === 0) {
    showWarn('Nothing to archive — load a conversation first.')
    return
  }
  const name = currentConvoName()
  const threadedReplies = Object.values(state.threads)
    .reduce((n, t) => n + (t.messages ? t.messages.length : 0), 0)
  const threadsWithoutData = state.messages
    .filter(m => m.replyCount > 0 && !(state.threads[m.id] && state.threads[m.id].messages.length)).length

  const lines = []
  lines.push('# ' + name)
  lines.push('')
  lines.push('- Workspace: ' + (state.teamName || state.selectedAccount))
  lines.push('- Exported: ' + new Date().toLocaleString())
  lines.push('- Messages: ' + state.messages.length +
    (state.nextCursor ? ' (loaded so far — older messages exist)' : ' (full history loaded)'))
  if (threadedReplies > 0) lines.push('- Thread replies included: ' + threadedReplies)
  if (threadsWithoutData > 0) {
    lines.push('- Note: ' + threadsWithoutData + ' thread(s) were not fetched and are ' +
      'summarised by reply count only — use "Get all threads" before archiving to include them.')
  }
  lines.push('')
  lines.push('---')
  lines.push('')

  let lastDay = null
  state.messages.forEach(m => {
    const day = formatDay(m.sentAt)
    if (day !== lastDay) {
      lines.push('## ' + day)
      lines.push('')
      lastDay = day
    }
    const text = slackTextToPlain(m.text)
    if (isSystemMessage(m)) {
      lines.push('_' + (text || m.subtype) + '_')
      lines.push('')
      return
    }
    lines.push('**' + senderNameOf(m) + '** · ' + formatTime(m.sentAt) + (m.edited ? ' (edited)' : ''))
    lines.push('')
    // Quote the body so multi-line messages stay visually attached to it.
    lines.push(text ? text.split('\n').map(l => '> ' + l).join('\n') : '> _(no text)_')
    if (m.files && m.files.length > 0) {
      lines.push('> ')
      lines.push('> Attachments: ' + m.files.map(f => f.filename).join(', '))
    }
    lines.push('')

    // Thread replies, nested under their parent as an indented list. Fetched
    // ones are written out in full; unfetched ones keep the old count-only note.
    const thread = state.threads[m.id]
    if (thread && thread.messages.length > 0) {
      lines.push('_↳ Thread — ' + thread.messages.length +
        ' repl' + (thread.messages.length === 1 ? 'y' : 'ies') + '_')
      lines.push('')
      thread.messages.forEach(r => {
        const rText = slackTextToPlain(r.text)
        if (isSystemMessage(r)) {
          lines.push('  - _' + (rText || r.subtype) + '_')
          return
        }
        lines.push('  - **' + senderNameOf(r) + '** · ' + formatTime(r.sentAt) + (r.edited ? ' (edited)' : ''))
        // Four-space indent keeps the quote inside the list item.
        const body = rText ? rText.split('\n') : ['_(no text)_']
        body.forEach(l => lines.push('    > ' + l))
        if (r.files && r.files.length > 0) {
          lines.push('    > Attachments: ' + r.files.map(f => f.filename).join(', '))
        }
      })
      lines.push('')
    } else if (m.replyCount > 0) {
      lines.push('_↳ ' + m.replyCount + ' repl' + (m.replyCount === 1 ? 'y' : 'ies') +
        ' in thread (not fetched)_')
      lines.push('')
    }
  })

  const safeName = name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'conversation'
  const stamp = new Date().toISOString().slice(0, 10)
  downloadFile(safeName + '-' + stamp + '.md', lines.join('\n'), 'text/markdown')
  showInfo('Archived ' + state.messages.length + ' messages' +
    (threadedReplies > 0 ? (' and ' + threadedReplies + ' thread replies') : '') + ' to Markdown.')
}

const downloadFile = function (filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType + ';charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Delete every loaded message. Slack only permits deleting your own, so this
// is best-effort: it reports how many were removed and how many were skipped
// rather than stopping at the first refusal. Sequential to stay inside the
// provider's write rate limits.
const deleteLoadedMessages = async function () {
  if (!state.selectedConvo || state.messages.length === 0) {
    showWarn('Nothing to delete — load a conversation first.')
    return
  }
  const deletable = state.messages.filter(m => !isSystemMessage(m))
  const ownCount = deletable.filter(isOwnMessage).length
  const warning =
    'Delete the ' + deletable.length + ' loaded message(s) in "' + currentConvoName() + '"?\n\n' +
    'Slack only allows deleting your own messages' +
    (state.ownUserId ? (' — about ' + ownCount + ' of these look like yours; the rest will be skipped.') : '.') +
    '\n\nThis cannot be undone, and it deletes them in Slack itself, not just here.'
  if (!confirm(warning)) return
  if (!confirm('Last check: permanently delete ' + deletable.length + ' message(s) from Slack?')) return

  setBusy(true)
  let deleted = 0
  let skipped = 0
  let failed = 0
  const removedIds = new Set()

  for (const m of deletable) {
    try {
      await freezr.connections.messaging.deleteMessage({
        connectionName: state.selectedAccount,
        conversationId: state.selectedConvo,
        messageId: m.id
      })
      removedIds.add(m.id)
      deleted++
    } catch (err) {
      if (handleTokenExpired(err)) break
      const provider = err?.data?.providerError
      if (provider === 'cant_delete_message' || provider === 'message_not_found') skipped++
      else failed++
    }
    showInfo('Deleting… ' + (deleted + skipped + failed) + '/' + deletable.length, 60000)
  }

  state.messages = state.messages.filter(m => !removedIds.has(m.id))
  renderMessages({ scroll: 'keep' })
  setBusy(false)
  showInfo('Deleted ' + deleted + '; skipped ' + skipped + ' (not yours)' +
    (failed > 0 ? ('; ' + failed + ' failed') : '') + '.', 9000)
}

/* =====================================================================
 *  Sending
 * =================================================================== */

const sendCurrent = async function () {
  const input = $('composeText')
  const text = input.value.trim()
  if (!text || !state.selectedConvo) return
  setBusy(true)
  try {
    await freezr.connections.messaging.sendMessage({
      connectionName: state.selectedAccount,
      conversationId: state.selectedConvo,
      text
    })
    input.value = ''
    // Pull the sent message (and anything else new) back through the delta path.
    await getNew()
  } catch (err) {
    fail('Could not send', err)
  } finally {
    setBusy(false)
  }
}
