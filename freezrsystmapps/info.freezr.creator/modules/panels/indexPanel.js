/* global freezr */
import { labelForAction } from '../historyActions.js'
import { renderFileTree, fetchFileContent } from '../fileTree.js'
import { openComp, openSnapshotCompare } from './filePanel.js'
import { showError } from '../showError.js'
import { formatCost, formatTokens } from '../priceService.js'
import { escHtml, authorTag } from '../utils.js'
import { refreshSnapshotsInState, takeSnapshot, performRestore, updateSnapshot, deleteSnapshot, snapshotForChat, reasonLabel, formatSnapshotTs } from '../snapshotActions.js'
import { renderMarkdownLite } from '../changeReview.js'

// "user @ host" tag for an entry written by someone else or on another server (see utils.authorTag).
const authorHtml = (entry) => {
  const tag = authorTag(entry?.author)
  return tag ? `<span class="idx-author-tag" title="Written by ${escHtml(tag)}">${escHtml(tag)}</span>` : ''
}

// Entries that bracket a folder rewrite (upload, restore) carry the two snapshot ids: one click
// opens the compare view on exactly that change.
const reviewLinkHtml = (entry) => (entry?.beforeSnapshotId && entry?.afterSnapshotId)
  ? `<span class="idx-review-link" data-review-before="${escHtml(entry.beforeSnapshotId)}" data-review-after="${escHtml(entry.afterSnapshotId)}">↔ review changes</span>`
  : ''

const reviewBodyHtml = (entry) => (entry?.action === 'change_review' && entry.review)
  ? `<details class="idx-review-body"><summary>Show the AI review${entry.llmModel ? ' (' + escHtml(entry.llmModel) + ')' : ''}</summary>${renderMarkdownLite(entry.review)}</details>`
  : ''

const isMobile = () => {
  const root = document.querySelector('.creator-root')
  return root ? root.classList.contains('is-mobile') : false
}

const formatTimestamp = (ts) => {
  if (!ts) return '—'
  try {
    const d = new Date(ts)
    return d.toLocaleString()
  } catch (e) {
    return String(ts)
  }
}

const buildChronologicalSegments = (history) => {
  const chronological = [...history].reverse()
  const segments = []
  const chatIdOccurrences = new Map()

  for (const entry of chronological) {
    const last = segments.length > 0 ? segments[segments.length - 1] : null

    if (entry.chatId) {
      if (last && last.chatId === entry.chatId) {
        last.entries.push(entry)
        if (entry.thread) last.thread = entry.thread
      } else {
        const segIndex = (chatIdOccurrences.get(entry.chatId) || 0)
        chatIdOccurrences.set(entry.chatId, segIndex + 1)
        segments.push({
          chatId: entry.chatId,
          entries: [entry],
          thread: entry.thread || null,
          segmentIndex: segIndex,
          isContinuation: segIndex > 0
        })
      }
    } else {
      segments.push({ chatId: null, entries: [entry], thread: null, segmentIndex: 0, isContinuation: false })
    }
  }

  const chatIdFinalIndex = new Map()
  for (const seg of segments) {
    if (seg.chatId) chatIdFinalIndex.set(seg.chatId, seg.segmentIndex)
  }
  for (const seg of segments) {
    seg.hasMoreBelow = seg.chatId ? seg.segmentIndex < chatIdFinalIndex.get(seg.chatId) : false
  }

  return segments
}

const renderHistoryEntry = (entry) => {
  let label = entry.summary || labelForAction(entry.action)
  if ((entry.action === 'published' || entry.action === 'unpublished') && entry.version) {
    label += ' v' + entry.version
  }
  if (entry.action === 'renamed') {
    if (entry.previousAppName && entry.appName) {
      label += ': ' + entry.previousAppName + ' → ' + entry.appName
    } else if (entry.previousAppName) {
      label += ' from ' + entry.previousAppName
    }
  }
  const historyId = entry.turnId || entry._id || ''
  const filesHtml = entry.filesChanged?.length
    ? `<div class="idx-files-changed">${entry.filesChanged.map((f) =>
        `<span class="idx-file-tag" data-file-path="${escHtml(f)}" data-chat-id="${escHtml(entry.chatId || '')}" data-history-id="${escHtml(historyId)}">${escHtml(f)}</span>`
      ).join(' ')}</div>`
    : ''

  let detailHtml = ''
  if (entry.action === 'published') {
    const parts = []
    if (entry.release_notes) parts.push('"' + entry.release_notes + '"')
    if (entry.fileName) parts.push(entry.fileName)
    if (parts.length > 0) {
      detailHtml = `<div class="idx-entry-detail">${escHtml(parts.join(' · '))}</div>`
    }
  } else if (entry.action === 'unpublished' && entry.version) {
    detailHtml = `<div class="idx-entry-detail">Version ${escHtml(entry.version)} unpublished</div>`
  }

  const usageParts = []
  if (entry.llmModel) usageParts.push(escHtml(entry.llmModel))
  const tokenTotal = entry.tokensUsed
    ? ((entry.tokensUsed.input?.qtty || 0) + (entry.tokensUsed.output?.qtty || 0) + (entry.tokensUsed.other?.qtty || 0))
    : 0
  if (entry.cost) {
    usageParts.push(formatTokens(entry.cost.totalTokens) + ' tokens')
    const costStr = formatCost(entry.cost)
    if (costStr) usageParts.push(costStr)
  } else if (tokenTotal > 0) {
    usageParts.push(formatTokens(tokenTotal) + ' tokens')
  }
  const usageHtml = usageParts.length > 0
    ? `<div class="idx-entry-usage">${usageParts.join(' · ')}</div>`
    : ''
  const promptHtml = entry.userPrompt
    ? `<div class="idx-user-prompt" title="${escHtml(entry.userPrompt)}">${escHtml(entry.userPrompt)}</div>`
    : ''
  return `<div class="idx-entry">
    ${promptHtml}
    <div class="idx-entry-summary">${escHtml(label)}${authorHtml(entry)}</div>
    ${detailHtml}
    ${reviewLinkHtml(entry)}
    ${reviewBodyHtml(entry)}
    <div class="idx-entry-meta">
      <span class="idx-entry-date">${escHtml(formatTimestamp(entry.timestamp || entry._date_created))}</span>
      ${usageHtml}
    </div>
    ${filesHtml}
  </div>`
}

const renderHistoryTab = (history, snapshots) => {
  if (!history || history.length === 0) {
    return '<p class="idx-empty">No chat history yet.</p>'
  }

  const segments = buildChronologicalSegments(history)
  let html = ''

  for (const seg of segments) {
    if (!seg.chatId) {
      const entry = seg.entries[0]
      let label = entry.thread || entry.summary || labelForAction(entry.action)
      if ((entry.action === 'published' || entry.action === 'unpublished') && entry.version) {
        label += ' v' + entry.version
      }
      if (entry.action === 'renamed') {
        if (entry.previousAppName && entry.appName) {
          label += ': ' + entry.previousAppName + ' → ' + entry.appName
        } else if (entry.previousAppName) {
          label += ' from ' + entry.previousAppName
        }
      }
      const hasFiles = entry.filesChanged?.length > 0
      const historyId = entry._id || ''

      let detailParts = []
      if (entry.action === 'published') {
        if (entry.release_notes) detailParts.push('"' + entry.release_notes + '"')
        if (entry.fileName) detailParts.push(entry.fileName)
      }
      const detailHtml = detailParts.length > 0
        ? `<div class="idx-entry-detail">${escHtml(detailParts.join(' · '))}</div>`
        : ''

      const usageParts = []
      if (entry.llmModel) usageParts.push(escHtml(entry.llmModel))
      const tokenTotal = entry.tokensUsed
        ? ((entry.tokensUsed.input?.qtty || 0) + (entry.tokensUsed.output?.qtty || 0) + (entry.tokensUsed.other?.qtty || 0))
        : 0
      if (entry.cost) {
        usageParts.push(formatTokens(entry.cost.totalTokens) + ' tokens')
        const costStr = formatCost(entry.cost)
        if (costStr) usageParts.push(costStr)
      } else if (tokenTotal > 0) {
        usageParts.push(formatTokens(tokenTotal) + ' tokens')
      }
      const usageHtml = usageParts.length > 0
        ? `<div class="idx-entry-usage">${usageParts.join(' · ')}</div>`
        : ''

      const promptHtml = entry.userPrompt
        ? `<div class="idx-user-prompt" title="${escHtml(entry.userPrompt)}">${escHtml(entry.userPrompt)}</div>`
        : ''
      const reviewLink = reviewLinkHtml(entry)
      const reviewBody = reviewBodyHtml(entry)
      const author = authorHtml(entry)
      const hasExpandableContent = hasFiles || usageHtml || detailHtml || promptHtml || reviewLink || reviewBody
      if (hasExpandableContent) {
        const extAttr = entry.action === 'external_change' ? ' data-external="1"' : ''
        const filesHtml = hasFiles
          ? entry.filesChanged.map((f) =>
              `<span class="idx-file-tag" data-file-path="${escHtml(f)}" data-history-id="${escHtml(historyId)}"${extAttr}>${escHtml(f)}</span>`
            ).join(' ')
          : ''
        html += `<div class="idx-history-group idx-group-collapsed-init">
          <div class="idx-group-header">
            <span class="idx-group-toggle">▶</span>
            <div class="idx-group-header-text">
              <div class="idx-item-thread">${escHtml(label)}${author}</div>
              <div class="idx-item-date">${escHtml(formatTimestamp(entry.timestamp || entry._date_created))}</div>
            </div>
          </div>
          <div class="idx-group-children idx-group-collapsed">
            <div class="idx-entry">
              ${promptHtml}
              ${detailHtml}
              ${reviewLink}
              ${reviewBody}
              ${filesHtml ? `<div class="idx-files-changed">${filesHtml}</div>` : ''}
              ${usageHtml}
            </div>
          </div>
        </div>`
      } else {
        html += `<div class="idx-history-item">
          <div class="idx-item-thread">${escHtml(label)}${author}</div>
          <div class="idx-item-date">${escHtml(formatTimestamp(entry.timestamp || entry._date_created))}</div>
        </div>`
      }
      continue
    }

    const threadText = seg.thread || 'Chat session'
    const lastEntry = seg.entries[seg.entries.length - 1]
    const latestTs = lastEntry?.timestamp || lastEntry?._date_created
    const segClasses = ['idx-history-group', 'idx-group-collapsed-init']
    if (seg.hasMoreBelow) segClasses.push('idx-group-continued')

    const continuationHtml = seg.isContinuation
      ? `<div class="idx-continuation-label">continued</div>`
      : ''
    const moreHtml = seg.hasMoreBelow
      ? `<div class="idx-continuation-footer">continued below ↓</div>`
      : ''

    const innerHtml = seg.entries.map(renderHistoryEntry).join('')

    // The whole-app snapshot taken before this chat first changed files (see chatService) — one
    // click restores the app to that point.
    const chatSnap = seg.isContinuation ? null : snapshotForChat(snapshots, seg.chatId)
    const restoreHtml = chatSnap
      ? `<span class="idx-chat-restore" data-restore-chat="${escHtml(seg.chatId)}" title="Restore the whole app to how it was before this chat changed anything (${escHtml(formatSnapshotTs(chatSnap.timestamp))})">↩ restore to before this chat</span>`
      : ''

    html += `<div class="${segClasses.join(' ')}" data-chat-id="${escHtml(seg.chatId)}">
      ${continuationHtml}
      <div class="idx-group-header">
        <span class="idx-group-toggle">▶</span>
        <div class="idx-group-header-text">
          <div class="idx-thread-label" data-chat-id="${escHtml(seg.chatId)}">${escHtml(threadText)}${seg.isContinuation ? ' (cont.)' : ''}${authorHtml(seg.entries[0])}</div>
          <div class="idx-item-date">${escHtml(formatTimestamp(latestTs))}</div>
        </div>
      </div>
      ${restoreHtml}
      <div class="idx-group-children idx-group-collapsed">${innerHtml}</div>
      ${moreHtml}
    </div>`
  }

  return `<div class="idx-history-list">${html}<div class="idx-history-spacer"></div></div>`
}

// ---- Versions tab: whole-app snapshots (see snapshotActions.js / snapshotController.mjs) ----
const renderVersionsTab = (indexState, appName) => {
  if (!appName) return '<p class="idx-empty">Select an app to see its versions.</p>'
  if (indexState.snapshotsError) return `<p class="idx-empty">${escHtml(indexState.snapshotsError)}</p>`
  const snaps = indexState.snapshots
  if (!snaps) return '<p class="idx-empty">Loading versions…</p>'

  const selection = indexState.versionSelection || []
  const currentHash = indexState.snapshotsHash || null
  const compareLabel = selection.length === 2 ? 'Compare selected' : (selection.length === 1 ? 'Compare with current' : 'Compare')
  const toolbar = `<div class="idx-ver-toolbar">
      <button class="panel-cta panel-cta-sm" data-action="snapshot-now" title="Save the app as it is now as a named version">📸 Save version</button>
      <button class="panel-cta panel-cta-sm panel-cta-secondary" data-action="compare-selected" ${selection.length ? '' : 'disabled'}>${compareLabel}</button>
      <div class="idx-ver-hint">Whole-app versions are saved automatically before a chat first changes files, before a manual edit session, before any restore, and on publish. Published and pinned (★) versions are always kept; of the rest, the latest 20 and the oldest are kept.</div>
    </div>`
  if (!snaps.length) return toolbar + '<p class="idx-empty">No saved versions yet.</p>'

  const rows = snaps.map((s) => {
    const id = s._id
    const isCurrent = !!(currentHash && s.contentHash && s.contentHash === currentHash)
    const checked = selection.includes(id) ? 'checked' : ''
    const canEdit = !s.legacy
    const canDelete = !s.legacy && s.reason !== 'published'
    const canUnpin = canEdit && s.reason !== 'published'
    const aliases = (s.aliases || []).map((a) => a.label).filter(Boolean)
    const metaBits = [
      `<span>${escHtml(formatSnapshotTs(s.timestamp))}</span>`,
      `<span class="idx-ver-badge${s.reason === 'published' ? ' idx-ver-badge-published' : ''}">${escHtml(reasonLabel(s))}</span>`,
      isCurrent ? '<span class="idx-ver-badge idx-ver-badge-current">current</span>' : '',
      s.fileCount ? `<span>${s.fileCount} files</span>` : ''
    ].filter(Boolean).join('')
    const pinTitle = s.pinned
      ? (canUnpin ? 'Pinned — always kept. Click to unpin.' : 'Published versions are always kept')
      : 'Pin to keep this version'
    return `<div class="idx-ver-row${isCurrent ? ' idx-ver-current' : ''}" data-snapshot-id="${escHtml(id)}">
      <input type="checkbox" data-ver-select="${escHtml(id)}" ${checked} title="Select to compare">
      <div class="idx-ver-main">
        <div class="idx-ver-label">${escHtml(s.label || reasonLabel(s))}</div>
        <div class="idx-ver-meta">${metaBits}</div>
        ${aliases.length ? `<div class="idx-ver-aliases">same files as: ${escHtml(aliases.join(' · '))}</div>` : ''}
        <div class="idx-ver-actions">
          <button class="panel-cta panel-cta-xs" data-ver-action="compare-current" data-id="${escHtml(id)}">Diff vs current</button>
          <button class="panel-cta panel-cta-xs" data-ver-action="restore" data-id="${escHtml(id)}" ${isCurrent ? 'disabled title="Already the current files"' : ''}>Restore</button>
          ${canEdit ? `<button class="panel-cta panel-cta-xs" data-ver-action="rename" data-id="${escHtml(id)}">Rename</button>` : ''}
          ${canDelete ? `<button class="panel-cta panel-cta-xs" data-ver-action="delete" data-id="${escHtml(id)}">Delete</button>` : ''}
        </div>
      </div>
      <button class="idx-ver-pin${s.pinned ? ' is-pinned' : ''}" data-ver-action="pin" data-id="${escHtml(id)}" ${canUnpin ? '' : 'disabled'} title="${escHtml(pinTitle)}">${s.pinned ? '★' : '☆'}</button>
    </div>`
  }).join('')

  return toolbar + `<div class="idx-history-list">${rows}</div>`
}

export const renderIndexPanel = ({ container, state, setState }) => {
  const indexState = state.index || {}
  const activeTab = indexState.activeTab || 'history'
  const history = indexState.history || []
  const fileTree = indexState.fileTree || []
  const appName = state.appName || ''

  const historyActive = activeTab === 'history'
  const filesActive = activeTab === 'files'
  const versionsActive = activeTab === 'versions'

  const chatSending = state.chat?.sending || false
  const footerButtonsHtml = appName
    ? `<div class="launch-app-footer">
        <button class="panel-cta" data-action="new-chat" ${chatSending ? 'disabled' : ''}>💬 New Chat</button>
        <a href="/app/${encodeURIComponent(appName)}" target="_blank" class="panel-cta${chatSending ? ' is-disabled' : ''}" data-action="launch-app">Launch App 🚀</a>
      </div>`
    : ''

  container.innerHTML = `
    <div class="idx-panel-shell">
      <div class="idx-panel-sticky-top">
        <h2>🗂️ History</h2>
        <div class="idx-tabs">
          <button class="idx-tab ${historyActive ? 'idx-tab-active' : ''}" data-tab="history">Chat History</button>
          <button class="idx-tab ${filesActive ? 'idx-tab-active' : ''}" data-tab="files">Files</button>
          <button class="idx-tab ${versionsActive ? 'idx-tab-active' : ''}" data-tab="versions">Versions</button>
        </div>
      </div>
      <div class="idx-tab-content">
        ${historyActive ? renderHistoryTab(history, indexState.snapshots) : ''}
        ${filesActive ? renderFileTree(fileTree) : ''}
        ${versionsActive ? renderVersionsTab(indexState, appName) : ''}
      </div>
      ${footerButtonsHtml}
    </div>
  `

  container.querySelectorAll('.idx-tab').forEach((btn) => {
    btn.onclick = () => {
      const tab = btn.dataset.tab
      if (tab === activeTab) return
      setState((next) => {
        if (!next.index) next.index = {}
        next.index.activeTab = tab
        return next
      })
      if (tab === 'versions' && appName && !indexState.snapshotsLoading && (!indexState.snapshots || indexState.snapshotsFor !== appName)) {
        refreshSnapshotsInState(appName, setState)
      }
    }
  })

  if (historyActive) {
    container.querySelectorAll('.idx-chat-restore[data-restore-chat]').forEach((el) => {
      el.onclick = async (e) => {
        e.stopPropagation()
        const snap = snapshotForChat(indexState.snapshots, el.dataset.restoreChat)
        if (snap) await performRestore(appName, snap, setState)
      }
    })
    container.querySelectorAll('.idx-review-link[data-review-before]').forEach((el) => {
      el.onclick = async (e) => {
        e.stopPropagation()
        if (!appName) return
        if (isMobile()) {
          setState((next) => {
            if (next.index?.ui) next.index.ui.visible = false
            if (next.chat?.ui) next.chat.ui.visible = false
            return next
          }, { rerender: false })
        }
        await openSnapshotCompare(appName, el.dataset.reviewBefore, el.dataset.reviewAfter, setState)
      }
    })
    // The review text is markup inside a collapsed group; let clicks on it through without
    // toggling anything else.
    container.querySelectorAll('.idx-review-body').forEach((el) => { el.onclick = (e) => e.stopPropagation() })
  }

  if (versionsActive && appName) {
    const snaps = indexState.snapshots || []
    const byId = (id) => snaps.find((s) => s._id === id) || null
    const openCompare = async (a, b) => {
      if (isMobile()) {
        setState((next) => {
          if (next.index?.ui) next.index.ui.visible = false
          if (next.chat?.ui) next.chat.ui.visible = false
          return next
        }, { rerender: false })
      }
      await openSnapshotCompare(appName, a, b, setState)
    }

    const snapBtn = container.querySelector('[data-action="snapshot-now"]')
    if (snapBtn) {
      snapBtn.onclick = async () => {
        const label = window.prompt('Name this version (optional):', '')
        if (label === null) return
        snapBtn.disabled = true
        try {
          const result = await takeSnapshot(appName, { reason: 'manual', label: label.trim() || undefined, pinned: true })
          showError(result.created
            ? 'Version saved.'
            : 'No file changes since "' + (result.record?.label || 'the last version') + '" — that version was kept (and pinned) instead.',
          { timeoutMs: 6000 })
          await refreshSnapshotsInState(appName, setState)
        } catch (err) {
          showError(err?.message || 'Could not save version.')
          snapBtn.disabled = false
        }
      }
    }

    container.querySelectorAll('input[data-ver-select]').forEach((cb) => {
      cb.onchange = () => {
        const id = cb.dataset.verSelect
        setState((next) => {
          if (!next.index) next.index = {}
          const sel = (next.index.versionSelection || []).filter((x) => x !== id)
          if (cb.checked) {
            sel.push(id)
            while (sel.length > 2) sel.shift()
          }
          next.index.versionSelection = sel
          return next
        }, { sourcePanel: 'index' })
      }
    })

    const cmpBtn = container.querySelector('[data-action="compare-selected"]')
    if (cmpBtn) {
      cmpBtn.onclick = () => {
        const sel = (indexState.versionSelection || []).map(byId).filter(Boolean)
        if (sel.length === 2) {
          const [older, newer] = [...sel].sort((x, y) => String(x.timestamp || '').localeCompare(String(y.timestamp || '')))
          openCompare(older._id, newer._id)
        } else if (sel.length === 1) {
          openCompare(sel[0]._id, 'current')
        }
      }
    }

    container.querySelectorAll('[data-ver-action]').forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation()
        const snap = byId(btn.dataset.id)
        if (!snap) return
        const action = btn.dataset.verAction
        try {
          if (action === 'compare-current') {
            await openCompare(snap._id, 'current')
          } else if (action === 'restore') {
            await performRestore(appName, snap, setState)
          } else if (action === 'rename') {
            const label = window.prompt('Version name:', snap.label || '')
            if (label === null || !label.trim()) return
            await updateSnapshot(appName, snap._id, { label: label.trim() })
            await refreshSnapshotsInState(appName, setState)
          } else if (action === 'pin') {
            await updateSnapshot(appName, snap._id, { pinned: !snap.pinned })
            await refreshSnapshotsInState(appName, setState)
          } else if (action === 'delete') {
            if (!window.confirm('Delete the saved version "' + (snap.label || '') + '"? This cannot be undone.')) return
            await deleteSnapshot(appName, snap._id)
            await refreshSnapshotsInState(appName, setState)
          }
        } catch (err) {
          showError(err?.message || 'Action failed.')
        }
      }
    })
  }

  const launchBtn = container.querySelector('.launch-app-footer [data-action="launch-app"]')
  if (launchBtn) {
    launchBtn.onclick = (e) => {
      e.preventDefault()
      const width = 900
      const height = 700
      const left = window.screenX + (window.outerWidth - width) / 2
      const top = window.screenY + (window.outerHeight - height) / 2
      window.open(
        '/app/' + encodeURIComponent(appName),
        'app_popup',
        `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
      )
    }
  }

  const newChatBtn = container.querySelector('.launch-app-footer [data-action="new-chat"]')
  if (newChatBtn) {
    newChatBtn.onclick = () => {
      setState((next) => {
        if (!next.index) next.index = {}
        if (!next.index.ui) next.index.ui = {}
        if (!next.chat) next.chat = {}
        if (!next.chat.ui) next.chat.ui = {}
        next.index.ui.visible = false
        next.chat.ui.visible = true
        next.chat.chatId = crypto.randomUUID()
        next.chat.messages = []
        next.chat.draftMessage = ''
        next.chat.loadFromHistory = false
        next.chat.sending = false
        next.chat.error = null
        return next
      }, { sourcePanel: 'chat' })
    }
  }

  if (historyActive) {
    container.querySelectorAll('.idx-group-toggle').forEach((toggle) => {
      toggle.onclick = (e) => {
        e.stopPropagation()
        const group = toggle.closest('.idx-history-group')
        if (!group) return
        const children = group.querySelector('.idx-group-children')
        if (!children) return
        const collapsed = children.classList.toggle('idx-group-collapsed')
        toggle.textContent = collapsed ? '▶' : '▼'
      }
    })

    container.querySelectorAll('.idx-thread-label').forEach((label) => {
      label.onclick = () => {
        const chatId = label.dataset.chatId
        if (!chatId) return
        const mobile = isMobile()
        setState((next) => {
          if (!next.chat) next.chat = {}
          if (!next.index?.ui) next.index.ui = {}
          if (!next.chat.ui) next.chat.ui = {}
          if (mobile) next.index.ui.visible = false
          next.chat.ui.visible = true
          next.chat.chatId = chatId
          next.chat.messages = []
          next.chat.draftMessage = ''
          next.chat.loadFromHistory = true
          next.chat.sending = false
          next.chat.error = null
          return next
        }, { sourcePanel: 'chat' })
      }
    })

    container.querySelectorAll('.idx-file-tag[data-file-path]').forEach((tag) => {
      tag.onclick = async () => {
        const filePath = tag.dataset.filePath
        const historyId = tag.dataset.historyId || null
        const chatId = tag.dataset.chatId || null
        const isExternal = tag.dataset.external === '1'
        if (!filePath || !appName) return

        tag.classList.add('ft-file-loading')
        try {
          const mobile = isMobile()

          // External-change files: open the full compare view (live vs the
          // creator's last-known snapshot) rather than a single-version view.
          if (isExternal) {
            setState((next) => {
              if (!next.file) next.file = {}
              if (!next.file.ui) next.file.ui = {}
              if (mobile) {
                if (next.index?.ui) next.index.ui.visible = false
                if (next.chat?.ui) next.chat.ui.visible = false
              }
              next.file.ui.visible = true
              return next
            }, { sourcePanel: 'file' })
            await openComp(appName, filePath, state, setState)
            return
          }

          if (historyId || chatId) {
            const query = historyId ? { historyId, path: filePath } : { chatId, path: filePath }
            const updates = await freezr.query('fileUpdates', query, { sort: { _date_modified: -1 }, count: 1 })
            const historicalContent = (updates && updates.length > 0) ? (updates[0].content || '') : null

            if (historicalContent !== null) {
              const currentContent = await fetchFileContent(appName, filePath)
              const isCurrent = currentContent === historicalContent

              if (isCurrent) {
                setState((next) => {
                  if (!next.file) next.file = {}
                  if (!next.file.ui) next.file.ui = {}
                  if (!next.index?.ui) next.index.ui = {}
                  if (!next.chat) next.chat = {}
                  if (!next.chat.ui) next.chat.ui = {}
                  if (mobile) {
                    next.index.ui.visible = false
                    next.chat.ui.visible = false
                  }
                  next.file.ui.visible = true
                  next.file.openFilePath = filePath
                  next.file.openFileContent = currentContent
                  next.file.openFolderPath = null
                  next.file.historicalView = null
                  next.file.compDiff = null
                  next.file.editorDirty = false
                  next.file.editorSaving = false
                  next.file.editorSaveStatus = ''
                  next.file.editorFileUpdateId = null
                  return next
                }, { sourcePanel: 'file' })
              } else {
                setState((next) => {
                  if (!next.file) next.file = {}
                  if (!next.file.ui) next.file.ui = {}
                  if (!next.index?.ui) next.index.ui = {}
                  if (!next.chat) next.chat = {}
                  if (!next.chat.ui) next.chat.ui = {}
                  if (mobile) {
                    next.index.ui.visible = false
                    next.chat.ui.visible = false
                  }
                  next.file.ui.visible = true
                  next.file.openFilePath = null
                  next.file.openFileContent = null
                  next.file.openFolderPath = null
                  next.file.historicalView = { chatId, filePath, content: historicalContent }
                  next.file.compDiff = null
                  next.file.editorDirty = false
                  next.file.editorSaving = false
                  next.file.editorSaveStatus = ''
                  next.file.editorFileUpdateId = null
                  return next
                }, { sourcePanel: 'file' })
              }
              return
            }
          }

          const content = await fetchFileContent(appName, filePath)
          setState((next) => {
            if (!next.file) next.file = {}
            if (!next.file.ui) next.file.ui = {}
            if (!next.index?.ui) next.index.ui = {}
            if (!next.chat) next.chat = {}
            if (!next.chat.ui) next.chat.ui = {}
            if (mobile) {
              next.index.ui.visible = false
              next.chat.ui.visible = false
            }
            next.file.ui.visible = true
            next.file.openFilePath = filePath
            next.file.openFileContent = content
            next.file.openFolderPath = null
            next.file.historicalView = null
            next.file.compDiff = null
            next.file.editorDirty = false
            next.file.editorSaving = false
            next.file.editorSaveStatus = ''
            next.file.editorFileUpdateId = null
            return next
          }, { sourcePanel: 'file' })
        } catch (error) {
          showError(error?.message || 'Could not read file.')
        } finally {
          tag.classList.remove('ft-file-loading')
        }
      }
    })

    const tabContent = container.querySelector('.idx-tab-content')
    if (tabContent) tabContent.scrollTop = tabContent.scrollHeight
  }

  if (filesActive) {
    container.querySelectorAll('.ft-toggle').forEach((toggle) => {
      toggle.onclick = () => {
        const targetPath = toggle.dataset.togglePath
        const children = container.querySelector(`[data-children-path="${targetPath}"]`)
        if (!children) return
        const collapsed = children.classList.toggle('ft-collapsed')
        toggle.textContent = collapsed ? '▶' : '▼'
      }
    })

    container.querySelectorAll('.ft-folder-label').forEach((label) => {
      label.onclick = () => {
        const folderPath = label.dataset.path
        if (folderPath === undefined || folderPath === null) return
        const mobile = isMobile()
        setState((next) => {
          if (!next.file) next.file = {}
          if (!next.file.ui) next.file.ui = {}
          if (!next.index?.ui) next.index.ui = {}
          if (!next.chat) next.chat = {}
          if (!next.chat.ui) next.chat.ui = {}
          if (mobile) {
            next.index.ui.visible = false
            next.chat.ui.visible = false
          }
          next.file.ui.visible = true
          next.file.openFilePath = null
          next.file.openFileContent = null
          next.file.openFolderPath = folderPath
          return next
        }, { sourcePanel: 'file' })
      }
    })

    container.querySelectorAll('.ft-file').forEach((fileEl) => {
      fileEl.onclick = async () => {
        const filePath = fileEl.dataset.path
        if (!filePath || !appName) return

        fileEl.classList.add('ft-file-loading')
        try {
          const content = await fetchFileContent(appName, filePath)
          const mobile = isMobile()
          setState((next) => {
            if (!next.file) next.file = {}
            if (!next.file.ui) next.file.ui = {}
            if (!next.index?.ui) next.index.ui = {}
            if (!next.chat) next.chat = {}
            if (!next.chat.ui) next.chat.ui = {}
            if (mobile) {
              next.index.ui.visible = false
              next.chat.ui.visible = false
            }
            next.file.ui.visible = true
            next.file.openFilePath = filePath
            next.file.openFileContent = content
            next.file.openFolderPath = null
            next.file.historicalView = null
            next.file.compDiff = null
            next.file.editorDirty = false
            next.file.editorSaving = false
            next.file.editorSaveStatus = ''
            next.file.editorFileUpdateId = null
            return next
          }, { sourcePanel: 'file' })
        } catch (error) {
          showError(error?.message || 'Could not read file.')
        } finally {
          fileEl.classList.remove('ft-file-loading')
        }
      }
    })
  }
}
