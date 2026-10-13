/* global freezr */

// Whole-app snapshots (the History panel's Versions tab) — client side of
// features/creator/controllers/snapshotController.mjs.
//
// Snapshots are the unit of ROLLBACK: a zip of every file in the app, taken lazily before the first
// file-writing turn of a chat, before a manual edit session, before any restore, on publish, and on
// demand. The per-file `fileUpdates` log stays as the change trace and the external-change baseline;
// a restore writes fresh fileUpdates records (server side) so the two never disagree.
//
// Every history record carries a creator-owned `uid` (see utils.newRecordUid); chat export/import
// dedups on it, falling back to the datastore _id only for records that predate the field.

import { fetchAppHistory } from './historyActions.js'
import { fetchFolderTree, fetchFileContent } from './fileTree.js'
import { showError } from './showError.js'

export const SNAPSHOT_REASON_LABELS = {
  chat_start: 'Before chat',
  pre_edit: 'Before manual edit',
  pre_restore: 'Before restore',
  pre_upload: 'Before upload',
  upload: 'Uploaded',
  manual: 'Checkpoint',
  published: 'Published'
}

const api = async (method, url, body) => {
  const result = body === undefined ? await freezr.apiRequest(method, url) : await freezr.apiRequest(method, url, body)
  if (!result || result.error) throw new Error(result?.error || 'Request failed.')
  return result
}

export const fetchSnapshots = (appName) =>
  api('GET', '/creatorapi/app_snapshots?app_name=' + encodeURIComponent(appName)) // { snapshots, currentHash }

export const takeSnapshot = (appName, { reason, label, chatId, historyId, pinned } = {}) =>
  api('POST', '/creatorapi/snapshot_app', { app_name: appName, reason, label, chat_id: chatId || null, history_id: historyId || null, pinned: pinned === true })

export const compareSnapshots = (appName, a, b) =>
  api('POST', '/creatorapi/compare_snapshots', { app_name: appName, a, b })

export const restoreSnapshotApi = (appName, snapshotId, paths) =>
  api('POST', '/creatorapi/restore_snapshot', { app_name: appName, snapshot_id: snapshotId, paths: paths && paths.length ? paths : undefined })

export const updateSnapshot = (appName, snapshotId, patch) =>
  api('POST', '/creatorapi/update_snapshot', { app_name: appName, snapshot_id: snapshotId, ...patch })

export const deleteSnapshot = (appName, snapshotId) =>
  api('POST', '/creatorapi/delete_snapshot', { app_name: appName, snapshot_id: snapshotId })

export const deleteAppSnapshots = (appName) =>
  api('POST', '/creatorapi/delete_app_snapshots', { app_name: appName })

// Best-effort pre-change snapshot: never blocks the change it protects. Returns the server result
// ({ created, record }) or null.
export const snapshotBeforeChange = async (appName, opts) => {
  try {
    return await takeSnapshot(appName, opts)
  } catch (err) {
    console.warn('Pre-change snapshot failed (continuing):', err)
    return null
  }
}

// The snapshot that marks the start of a chat — either taken for it, or an identical earlier
// state that the chat start was recorded against as an alias.
export const snapshotForChat = (snapshots, chatId) => {
  if (!chatId) return null
  return (snapshots || []).find((s) => s.chatId === chatId || (s.aliases || []).some((a) => a.chatId === chatId)) || null
}

export const reasonLabel = (snapshot) => {
  if (!snapshot) return ''
  if (snapshot.reason === 'published' && snapshot.version) return 'Published v' + snapshot.version
  return SNAPSHOT_REASON_LABELS[snapshot.reason] || snapshot.reason || 'Snapshot'
}

export const formatSnapshotTs = (ts) => {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch (e) {
    return String(ts)
  }
}

export const refreshSnapshotsInState = async (appName, setState) => {
  if (!appName) return
  setState((next) => {
    if (!next.index) next.index = {}
    next.index.snapshotsLoading = true
    next.index.snapshotsError = null
    return next
  }, { rerender: false })
  try {
    const { snapshots, currentHash } = await fetchSnapshots(appName)
    setState((next) => {
      if (!next.index) next.index = {}
      if (next.appName !== appName) return next // user switched app meanwhile
      next.index.snapshots = snapshots || []
      next.index.snapshotsHash = currentHash || null
      next.index.snapshotsFor = appName
      next.index.snapshotsLoading = false
      return next
    }, { sourcePanel: 'index' })
  } catch (err) {
    // "Unknown action: app_snapshots" is the generic route dispatcher answering, i.e. a server
    // that was started before the snapshot routes existed — say so rather than echoing it.
    const raw = err?.message || ''
    const message = /Unknown action/i.test(raw)
      ? 'Versions are not available until the freezr server is restarted (it is running code from before this feature was added).'
      : (raw || 'Could not load versions.')
    setState((next) => {
      if (!next.index) next.index = {}
      next.index.snapshotsLoading = false
      next.index.snapshotsError = message
      return next
    }, { sourcePanel: 'index' })
  }
}

// Read the live state without changing it (the panels only receive setState).
const peekState = (setState) => {
  let snap = null
  setState((next) => { snap = next; return next }, { rerender: false })
  return snap
}

// After anything that rewrote the app folder outside the chat/edit paths (restore, undo): reload
// history + file tree + snapshots, drop the in-RAM undo, and refresh whatever file is open.
export const refreshAfterFolderChange = async (appName, setState, changedPaths = []) => {
  const [history, fileTree] = await Promise.all([fetchAppHistory(appName), fetchFolderTree(appName)])
  const live = peekState(setState)
  const openPath = live?.file?.openFilePath || null
  const changedSet = new Set(changedPaths || [])
  let openContent
  let openGone = false
  if (openPath && changedSet.has(openPath)) {
    try { openContent = await fetchFileContent(appName, openPath) } catch (e) { openGone = true }
  }
  setState((next) => {
    if (!next.index) next.index = {}
    next.index.history = history
    next.index.fileTree = fileTree
    if (next.project && history.length > 0) next.project.lastUpdate = history[0]
    if (!next.chat) next.chat = {}
    next.chat.undo = null
    if (!next.file) next.file = {}
    next.file.editorHistoryId = null
    next.file.editorFileUpdateId = null
    if (openPath && changedSet.has(openPath)) {
      if (openGone) {
        next.file.openFilePath = null
        next.file.openFileContent = null
      } else {
        next.file.openFileContent = openContent
      }
      next.file.editorDirty = false
    }
    return next
  }, { sourcePanel: 'all' })
  await refreshSnapshotsInState(appName, setState)
}

const countsText = (counts) => {
  if (!counts) return ''
  const parts = []
  if (counts.modified) parts.push(counts.modified + ' modified')
  if (counts.added) parts.push(counts.added + ' added')
  if (counts.deleted) parts.push(counts.deleted + ' deleted')
  return parts.join(', ')
}

// Confirm → restore (whole app, or just `paths`) → refresh. Returns the server result or null.
export const performRestore = async (appName, snapshot, setState, { paths } = {}) => {
  if (!appName || !snapshot) return null
  const what = paths && paths.length ? (paths.length === 1 ? paths[0] : paths.length + ' files') : 'the whole app'
  const when = formatSnapshotTs(snapshot.timestamp)
  const ok = window.confirm(
    'Restore ' + what + ' to "' + (snapshot.label || reasonLabel(snapshot)) + '"' + (when ? ' (' + when + ')' : '') + '?\n\n' +
    'The current files are saved first as their own restore point, so this can be reversed from the Versions tab.'
  )
  if (!ok) return null
  try {
    const result = await restoreSnapshotApi(appName, snapshot._id, paths)
    if (result.nothingToDo) {
      showError('Nothing to restore — the files already match "' + (snapshot.label || '') + '".', { timeoutMs: 5000 })
      return result
    }
    await refreshAfterFolderChange(appName, setState, (result.files || []).map((f) => f.path))
    let msg = 'Restored ' + what + ' to "' + (snapshot.label || '') + '" (' + countsText(result.counts) + ').'
    if (result.installWarning) msg += ' Warning: the app re-install reported: ' + result.installWarning
    showError(msg, { timeoutMs: 8000 })
    return result
  } catch (err) {
    showError(err?.message || 'Restore failed.')
    return null
  }
}
