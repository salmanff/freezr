/* global freezr */
import { labelForAction } from '../historyActions.js'
import { renderFileTree, fetchFileContent } from '../fileTree.js'
import { openComp } from './filePanel.js'
import { showError } from '../showError.js'
import { formatCost, formatTokens } from '../priceService.js'
import { escHtml } from '../utils.js'

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
  return `<div class="idx-entry">
    <div class="idx-entry-summary">${escHtml(label)}</div>
    ${detailHtml}
    <div class="idx-entry-meta">
      <span class="idx-entry-date">${escHtml(formatTimestamp(entry.timestamp || entry._date_created))}</span>
      ${usageHtml}
    </div>
    ${filesHtml}
  </div>`
}

const renderHistoryTab = (history) => {
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

      const hasExpandableContent = hasFiles || usageHtml || detailHtml
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
              <div class="idx-item-thread">${escHtml(label)}</div>
              <div class="idx-item-date">${escHtml(formatTimestamp(entry.timestamp || entry._date_created))}</div>
            </div>
          </div>
          <div class="idx-group-children idx-group-collapsed">
            <div class="idx-entry">
              ${detailHtml}
              ${filesHtml ? `<div class="idx-files-changed">${filesHtml}</div>` : ''}
              ${usageHtml}
            </div>
          </div>
        </div>`
      } else {
        html += `<div class="idx-history-item">
          <div class="idx-item-thread">${escHtml(label)}</div>
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

    html += `<div class="${segClasses.join(' ')}" data-chat-id="${escHtml(seg.chatId)}">
      ${continuationHtml}
      <div class="idx-group-header">
        <span class="idx-group-toggle">▶</span>
        <div class="idx-group-header-text">
          <div class="idx-thread-label" data-chat-id="${escHtml(seg.chatId)}">${escHtml(threadText)}${seg.isContinuation ? ' (cont.)' : ''}</div>
          <div class="idx-item-date">${escHtml(formatTimestamp(latestTs))}</div>
        </div>
      </div>
      <div class="idx-group-children idx-group-collapsed">${innerHtml}</div>
      ${moreHtml}
    </div>`
  }

  return `<div class="idx-history-list">${html}<div class="idx-history-spacer"></div></div>`
}

export const renderIndexPanel = ({ container, state, setState }) => {
  const indexState = state.index || {}
  const activeTab = indexState.activeTab || 'history'
  const history = indexState.history || []
  const fileTree = indexState.fileTree || []
  const appName = state.appName || ''

  const historyActive = activeTab === 'history'
  const filesActive = activeTab === 'files'

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
        </div>
      </div>
      <div class="idx-tab-content">
        ${historyActive ? renderHistoryTab(history) : ''}
        ${filesActive ? renderFileTree(fileTree) : ''}
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
    }
  })

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
