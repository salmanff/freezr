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
