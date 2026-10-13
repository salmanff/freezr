/* global freezr */

export const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Records are fetched sorted by _date_modified (the Azure/Cosmos-indexed field),
// then re-sorted locally by the creator's logical `timestamp` (ISO string) to
// preserve app ordering. Falls back to _date_modified when timestamp is missing.
// Creator-owned identity for every history record (appUpdates / fileUpdates). The datastore _id is
// not fully ours (unified-db setups qualify ids with app/user), so chat export/import dedups on
// this instead and only falls back to _id for records that predate it.
export const newRecordUid = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12)))

// uid + author for a new history record. Author is WHO wrote it and WHERE (user + server), kept
// across export/import so a merged history shows whose entries are whose.
export const recordMeta = () => ({
  uid: newRecordUid(),
  author: {
    user: (typeof freezrMeta !== 'undefined' && freezrMeta && freezrMeta.userId) || null,
    server: (typeof freezrMeta !== 'undefined' && freezrMeta && freezrMeta.serverAddress) || (typeof window !== 'undefined' ? window.location.origin : null)
  }
})

// Short "user @ host" for an author object; empty when it is the current user on this server.
export const authorTag = (author) => {
  if (!author || !author.user) return ''
  const me = (typeof freezrMeta !== 'undefined' && freezrMeta) ? freezrMeta : {}
  const here = me.serverAddress || (typeof window !== 'undefined' ? window.location.origin : '')
  const sameUser = author.user === me.userId
  const sameServer = !author.server || !here || String(author.server).replace(/\/$/, '') === String(here).replace(/\/$/, '')
  if (sameUser && sameServer) return ''
  const host = author.server ? String(author.server).replace(/^https?:\/\//, '').replace(/\/$/, '') : ''
  return author.user + (host && !sameServer ? ' @ ' + host : '')
}

export const tsOf = (r) => {
  const t = Date.parse(r && r.timestamp)
  return Number.isNaN(t) ? ((r && r._date_modified) || 0) : t
}

// Chat-draft persistence. The user's unsent prompt is mirrored to localStorage (keyed per app)
// so it survives a full shutdown — laptop closed mid-send, browser crash, accidental close —
// not just a transient send failure (which is recovered in-memory via chat.draftMessage).
// Cleared on a successful send and on New Chat.
const DRAFT_KEY = (appName) => 'freezr_creator_draft_' + (appName || '_')
export const saveChatDraft = (appName, text) => {
  try {
    if (text) window.localStorage.setItem(DRAFT_KEY(appName), text)
    else window.localStorage.removeItem(DRAFT_KEY(appName))
  } catch (e) { /* localStorage unavailable — non-fatal */ }
}
export const loadChatDraft = (appName) => {
  try { return window.localStorage.getItem(DRAFT_KEY(appName)) || '' } catch (e) { return '' }
}
export const clearChatDraft = (appName) => {
  try { window.localStorage.removeItem(DRAFT_KEY(appName)) } catch (e) { /* non-fatal */ }
}

// --- Web search (freezr.llm.ask `web` option) ---
//
// OFF BY DEFAULT, and that is a cost decision, not a preference. Measured on sonnet-5:
// declaring the web tools costs ~7,200 input tokens on EVERY call even when the model never
// searches (16 tokens -> 7,190 for the same prompt), and a single question that did search
// ran to 282,732 input tokens / $0.57. So creator never turns it on speculatively.
//
// Sticky per app once the user turns it on: a follow-up to a web-answered question usually
// needs the web too, and re-ticking a box every message gets old fast. It stays visible.
const WEB_KEY = (appName) => 'freezr_creator_web_' + (appName || '_')
export const loadWebSearchPref = (appName) => {
  try { return window.localStorage.getItem(WEB_KEY(appName)) === '1' } catch (e) { return false }
}
export const saveWebSearchPref = (appName, on) => {
  try {
    if (on) window.localStorage.setItem(WEB_KEY(appName), '1')
    else window.localStorage.removeItem(WEB_KEY(appName))
  } catch (e) { /* localStorage unavailable — non-fatal */ }
}

// Caps for a creator web call. Page BODIES are what cost money (the $10/1,000 search fee was
// $0.06 of that $0.57 run), so maxContentTokens is the important one. When a cap bites, the
// response carries meta.toolsUsed.limitReached and the UI offers to re-ask without it —
// nobody has to predict up front how much research a question needs.
export const CREATOR_WEB_OPTIONS = {
  search: { maxUses: 3 },
  fetch: { maxUses: 3, maxContentTokens: 5000 }
}
export const creatorWebOption = (uncapped) => (uncapped ? true : { ...CREATOR_WEB_OPTIONS })

/**
 * One place to log what an LLM call did, so web results can actually be inspected.
 * Collapsed group — open it in the console to see sources, fetched URLs and tool errors.
 */
export const logLlmResult = (label, result) => {
  const meta = result?.meta || {}
  const tools = meta.toolsUsed
  try {
    console.groupCollapsed(
      '%c[creator]%c ' + label +
      ' · ' + (meta.model || '?') +
      ' · $' + (meta.cost?.totalCost != null ? meta.cost.totalCost.toFixed(4) : '?') +
      ' · ' + (meta.cost?.totalTokens ?? '?') + ' tok' +
      (tools ? ' · 🌐 ' + ((tools.webSearch?.requests || 0) + ' searches, ' + (tools.webFetch?.requests || 0) + ' fetches') : ''),
      'color:#888', 'color:inherit')
    console.log('full result', result)
    if (tools) {
      if (tools.webSearch) {
        console.log('searches:', tools.webSearch.requests, tools.webSearch.queries)
        console.table((tools.webSearch.sources || []).map(s => ({ title: s.title, url: s.url })))
      }
      if (tools.webFetch) console.log('fetched URLs:', tools.webFetch.urls)
      if (tools.errors?.length) console.warn('tool errors:', tools.errors)
      if (tools.limitReached) console.warn('hit creator\'s own cap:', tools.limitReached)
    }
    if (meta.citations?.length) console.table(meta.citations)
    if (meta.capabilities?.unavailable?.length) console.warn('unavailable:', meta.capabilities.unavailable)
    console.groupEnd()
  } catch (e) {
    console.log('[creator] ' + label, result) // console.group/table missing — never break a send
  }
}

// --- AI access to this app (freezr_creator_selfcheck_plan_v1.md Part A/B) ---
//
// No token is ever put in a prompt: a token in a model's context is one injected web_fetch away
// from leaking, and the connectors cannot fetch URLs anyway (self-check plan, B4). The chat
// assistant looks at data through a data probe (dataProbe.js) and is given this app's permission
// state as text (fetchGrantedMap). Inspection tokens remain for the manual "AI Inspection Token"
// panel (a credential the user deliberately hands to an external agent) and for reading the
// sample behind a write access_request, where the token never leaves the function that mints it.
// See xplanations/freezr_creator_data_access_plan.md.

// Mint a short-lived inspection token. `dataAccess` is 'read' | 'write'.
export const mintInspectionToken = async (appName, { includeFiles = true, includeData = false, dataAccess = 'read', ttlMinutes } = {}) => {
  const body = { app_name: appName, include_files: includeFiles, include_data: includeData, data_access: dataAccess }
  if (ttlMinutes) body.ttl_minutes = ttlMinutes
  const result = await freezr.apiRequest('POST', '/creatorapi/create_inspection_token', body)
  if (!result || result.error) throw new Error(result?.error || 'Could not create access token.')
  return result
}

// Pings the app's permission status (which of its declared permissions the user has granted).
// Returns a map name -> granted(bool). A permission that is outdated/removed counts as NOT granted.
// Ordinary creator auth — no token for the model involved.
export const fetchGrantedMap = async (appName) => {
  const r = await freezr.apiRequest('GET', '/feps/permissions/getall/' + encodeURIComponent(appName))
  const list = Array.isArray(r) ? r : ((r && (r.perms || r.permissions || r.data)) || [])
  const map = {}
  for (const rec of list) {
    const n = rec && (rec.name || rec.permission_name)
    if (n) map[n] = !!rec.granted && rec.status !== 'removed' && !rec.outDated
  }
  return map
}

export const saveFileToBackend = async (appName, filePath, content, action = 'upsert') => {
  return freezr.apiRequest('POST', '/creatorapi/write_app_file', {
    app_name: appName,
    file_path: filePath,
    content,
    action
  })
}

export const updateAppFromFiles = async (appName) => {
  return freezr.apiRequest('POST', '/creatorapi/update_app_from_files', { app_name: appName })
}
