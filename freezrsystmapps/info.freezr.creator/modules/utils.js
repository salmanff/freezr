/* global freezr */

export const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Records are fetched sorted by _date_modified (the Azure/Cosmos-indexed field),
// then re-sorted locally by the creator's logical `timestamp` (ISO string) to
// preserve app ordering. Falls back to _date_modified when timestamp is missing.
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
// Files access is a standing per-app setting (DEFAULT ON): when on, each chat turn is given a
// short-lived inspect token + URL so the assistant can fetch this app's page/source files
// (used by providers able to fetch, and by any external agent the user hands the token to).
// DATA access is never standing — the assistant must ask, and the user clicks Allow, per request.
//
// NOTE: deliberately NOT exposed in the UI. An app-builder assistant reading the app's own source
// is simply what building means, so offering it as a choice would confuse more than it protects
// (the meaningful consent is over DATA, which is asked for per request). The switch is kept as a
// mechanism — set localStorage 'freezr_creator_files_access_<app>' to 'off' to disable it for an
// app — so the capability can be revoked without a code change if a reason ever appears.
const FILES_ACCESS_KEY = (appName) => 'freezr_creator_files_access_' + (appName || '_')
export const getFilesAccessSetting = (appName) => {
  try { return window.localStorage.getItem(FILES_ACCESS_KEY(appName)) !== 'off' } catch (e) { return true }
}
export const setFilesAccessSetting = (appName, isOn) => {
  try {
    if (isOn) window.localStorage.removeItem(FILES_ACCESS_KEY(appName))
    else window.localStorage.setItem(FILES_ACCESS_KEY(appName), 'off')
  } catch (e) { /* non-fatal */ }
}

// Mint a short-lived inspection token. `dataAccess` is 'read' | 'write' and only ever passed
// after an explicit user consent click (see the access_request flow in chatService.js).
export const mintInspectionToken = async (appName, { includeFiles = true, includeData = false, dataAccess = 'read', ttlMinutes } = {}) => {
  const body = { app_name: appName, include_files: includeFiles, include_data: includeData, data_access: dataAccess }
  if (ttlMinutes) body.ttl_minutes = ttlMinutes
  const result = await freezr.apiRequest('POST', '/creatorapi/create_inspection_token', body)
  if (!result || result.error) throw new Error(result?.error || 'Could not create access token.')
  return result
}

// Files-only tokens are handed to the assistant on every chat turn, so reuse one until it is
// close to expiry rather than minting per turn. Data tokens are never cached — each one is
// bound to a specific consent click.
const REUSE_IF_MINUTES_LEFT = 5
const filesTokenCache = {}
export const getFilesAccessToken = async (appName) => {
  const cached = filesTokenCache[appName]
  if (cached && (new Date(cached.expiresAt).getTime() - Date.now()) > REUSE_IF_MINUTES_LEFT * 60 * 1000) {
    return cached
  }
  const minted = await mintInspectionToken(appName, { includeFiles: true, includeData: false })
  filesTokenCache[appName] = minted
  return minted
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
