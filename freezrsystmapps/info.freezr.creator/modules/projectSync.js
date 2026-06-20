/* global freezr */

// Keeps the creator in sync with the app folder when the app is (re)opened.
//
// Two related jobs run on open:
//  1. Context doc — ensure the app folder has a fresh copy of freezr-context.md
//     (the server compares a hash of the shipped source against the copy's header).
//     When it is created/updated we record a history entry + file snapshot and
//     surface a visible "Update made" notice.
//  2. External changes — files can be edited outside the creator (e.g. editing the
//     app folder directly with VS Code / Claude Code on localhost). The latest
//     `fileUpdates` snapshot per path is what the creator last knew the file to be,
//     so we diff the live folder against that baseline. Any modified / added /
//     deleted files become a single "Changed outside Creator" history entry plus
//     fresh snapshots (so the change is visible, diffable, and not re-detected).

import { fetchAppHistory, updateHistoryEntry } from './historyActions.js'
import { fetchFolderTree } from './fileTree.js'
import { showError } from './showError.js'
import { tsOf } from './utils.js'

const CONTEXT_DOC_NAME = 'freezr-context.md'
// Paths managed/injected by freezr itself — never treated as user app content.
const IGNORED_PATHS = new Set([CONTEXT_DOC_NAME, '__freezrApiV2.js'])

const fetchDiskFiles = async (appName) => {
  const result = await freezr.apiRequest('GET', '/creatorapi/read_all_files?app_name=' + encodeURIComponent(appName))
  if (!result || result.error) return []
  return (result.files || []).filter((f) =>
    !f.readOnly && !IGNORED_PATHS.has(f.path) && f.content !== null && f.content !== undefined
  )
}

// Latest fileUpdates snapshot per path = the creator's last-known baseline.
const latestSnapshotPerPath = async (appName) => {
  const updates = await freezr.query('fileUpdates', { appName }, { sort: { _date_modified: -1 }, count: 2000 })
  const map = new Map()
  if (Array.isArray(updates)) {
    updates.sort((a, b) => tsOf(b) - tsOf(a))
    for (const u of updates) {
      if (!u.path) continue
      if (!map.has(u.path)) map.set(u.path, u) // first seen = newest
    }
  }
  return map
}

const summaryFor = (modified, added, deleted) => {
  const parts = []
  if (modified.length) parts.push(modified.length + ' modified')
  if (added.length) parts.push(added.length + ' added')
  if (deleted.length) parts.push(deleted.length + ' deleted')
  return 'Changed outside Creator (' + parts.join(', ') + ')'
}

const refreshHistory = async (appName, setState) => {
  const [history, fileTree] = await Promise.all([fetchAppHistory(appName), fetchFolderTree(appName)])
  setState((next) => {
    if (!next.index) next.index = {}
    next.index.history = history
    next.index.fileTree = fileTree
    if (next.project && history.length > 0) next.project.lastUpdate = history[0]
    return next
  })
}

const syncContextDoc = async (appName, setState) => {
  const result = await freezr.apiRequest('POST', '/creatorapi/sync_context', { app_name: appName })
  if (!result || result.error) return
  if (result.action !== 'created' && result.action !== 'updated') return

  const timestamp = new Date().toISOString()
  const summary = CONTEXT_DOC_NAME + (result.action === 'created' ? ' added' : ' updated')

  let entryId = null
  try {
    const hist = await freezr.create('appUpdates', {
      appName,
      action: 'context_updated',
      summary,
      thread: summary,
      filesChanged: [CONTEXT_DOC_NAME],
      timestamp
    })
    entryId = hist?._id || hist?.id || null
  } catch (err) {
    console.warn('Could not record context_updated history entry:', err)
  }

  if (entryId && typeof result.content === 'string') {
    try {
      await freezr.create('fileUpdates', { appName, path: CONTEXT_DOC_NAME, action: 'upsert', content: result.content, historyId: entryId, timestamp })
    } catch (err) {
      console.warn('Could not record context fileUpdate:', err)
    }
  }

  showError('Update made: freezr reference doc (' + CONTEXT_DOC_NAME + ') refreshed.', { timeoutMs: 6000 })
  await refreshHistory(appName, setState)
}

const detectExternalChanges = async (appName, setState) => {
  const [diskFiles, baseline] = await Promise.all([
    fetchDiskFiles(appName),
    latestSnapshotPerPath(appName)
  ])
  const diskMap = new Map(diskFiles.map((f) => [f.path, f.content]))

  // First open of an un-baselined app: this is true for a freshly created app and
  // for any app that pre-dates this feature (its chat/edit snapshots use action
  // 'upsert', never 'baseline'). We can only meaningfully flag changes once we have
  // a known-good baseline, so the first scan silently records the current folder as
  // the baseline (action 'baseline') rather than flagging untracked files as "added".
  const everSynced = [...baseline.values()].some((rec) => rec.action === 'baseline')
  if (!everSynced) {
    const ts = new Date().toISOString()
    for (const [path, content] of diskMap) {
      try {
        await freezr.create('fileUpdates', { appName, path, action: 'baseline', content, timestamp: ts })
      } catch (err) {
        console.warn('Could not record baseline snapshot for ' + path + ':', err)
      }
    }
    return
  }

  const isAbsent = (rec) => !rec || rec.action === 'delete'
  const modified = []
  const added = []
  const deleted = []

  for (const [path, content] of diskMap) {
    const rec = baseline.get(path)
    if (isAbsent(rec)) added.push(path)
    else if ((rec.content || '') !== content) modified.push(path)
  }
  for (const [path, rec] of baseline) {
    if (IGNORED_PATHS.has(path) || isAbsent(rec)) continue
    if (!diskMap.has(path)) deleted.push(path)
  }

  const changed = [...modified, ...added, ...deleted]
  if (changed.length === 0) return

  const ts = new Date().toISOString()

  // If the most recent activity was itself an off-app change (nothing in the creator
  // since — no chat, no manual edit), fold this into that same history item rather
  // than starting a new thread, mirroring how consecutive manual edits coalesce.
  const latestHistory = await fetchAppHistory(appName, { count: 1 })
  const last = latestHistory[0] || null
  const mergeInto = last && last.action === 'external_change' && last._id ? last : null

  let entryId = null

  if (mergeInto) {
    const prev = mergeInto.externalChange || {}
    const cats = {
      modified: new Set(prev.modified || []),
      added: new Set(prev.added || []),
      deleted: new Set(prev.deleted || [])
    }
    // Latest categorisation wins for any file touched again in this scan.
    const place = (path, cat) => {
      cats.modified.delete(path)
      cats.added.delete(path)
      cats.deleted.delete(path)
      cats[cat].add(path)
    }
    modified.forEach((p) => place(p, 'modified'))
    added.forEach((p) => place(p, 'added'))
    deleted.forEach((p) => place(p, 'deleted'))

    const mModified = [...cats.modified]
    const mAdded = [...cats.added]
    const mDeleted = [...cats.deleted]
    const mergedChanged = [...new Set([...mModified, ...mAdded, ...mDeleted])]
    const mergedSummary = summaryFor(mModified, mAdded, mDeleted)

    // updateHistoryEntry merges over the existing record, but we re-send the
    // identity fields (appName/action) too as a safeguard against a failed read.
    const ok = await updateHistoryEntry(mergeInto._id, {
      appName: mergeInto.appName,
      action: 'external_change',
      summary: mergedSummary,
      thread: mergedSummary,
      filesChanged: mergedChanged,
      externalChange: { modified: mModified, added: mAdded, deleted: mDeleted }
    })
    if (ok) entryId = mergeInto._id
  }

  if (!entryId) {
    try {
      const summary = summaryFor(modified, added, deleted)
      const hist = await freezr.create('appUpdates', {
        appName,
        action: 'external_change',
        summary,
        thread: summary,
        filesChanged: changed,
        externalChange: { modified, added, deleted },
        timestamp: ts
      })
      entryId = hist?._id || hist?.id || null
    } catch (err) {
      console.warn('Could not record external_change history entry:', err)
    }
  }

  // Record fresh snapshots so the change is diffable and not re-detected next open.
  for (const path of [...modified, ...added]) {
    try {
      await freezr.create('fileUpdates', { appName, path, action: 'upsert', content: diskMap.get(path), historyId: entryId, timestamp: ts })
    } catch (err) {
      console.warn('Could not record snapshot for ' + path + ':', err)
    }
  }
  for (const path of deleted) {
    try {
      await freezr.create('fileUpdates', { appName, path, action: 'delete', content: '', historyId: entryId, timestamp: ts })
    } catch (err) {
      console.warn('Could not record delete snapshot for ' + path + ':', err)
    }
  }

  showError('Update made: ' + changed.length + ' file(s) changed outside Creator — see History.', { timeoutMs: 7000 })
  await refreshHistory(appName, setState)
}

export const syncProjectOnOpen = async (appName, setState) => {
  if (!appName) return
  try {
    await syncContextDoc(appName, setState)
  } catch (err) {
    console.warn('syncContextDoc failed:', err)
  }
  try {
    await detectExternalChanges(appName, setState)
  } catch (err) {
    console.warn('detectExternalChanges failed:', err)
  }
}
