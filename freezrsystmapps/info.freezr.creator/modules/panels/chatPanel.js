/* global freezr */
import { sendChatMessage } from '../chatService.js'
import { showError, clearError } from '../showError.js'
import { fetchFileContent } from '../fileTree.js'
import { formatCost, formatTokens } from '../priceService.js'
import { escHtml } from '../utils.js'

const isMobile = () => {
  const root = document.querySelector('.creator-root')
  return root ? root.classList.contains('is-mobile') : false
}

const formatTime = (ts) => {
  if (!ts) return ''
  try {
    const d = new Date(ts)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch (e) {
    return ''
  }
}

const renderExplanation = (text) => {
  if (!text) return ''
  return escHtml(text)
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="chat-code"><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code class="chat-inline-code">$1</code>')
    .replace(/\n/g, '<br>')
}

const parseEditBlocksForDisplay = (content) => {
  if (!content) return []
  const edits = []
  const regex = /<<<SEARCH>>>([\s\S]*?)<<<REPLACE>>>([\s\S]*?)<<<END_REPLACE>>>/g
  let match
  let lastIndex = 0
  while ((match = regex.exec(content)) !== null) {
    edits.push({ search: match[1].trim(), replace: match[2].trim(), complete: true })
    lastIndex = match.index + match[0].length
  }
  const remaining = content.slice(lastIndex)
  const partialSearch = remaining.match(/<<<SEARCH>>>([\s\S]*)$/)
  if (partialSearch) {
    const afterSearch = partialSearch[1]
    const replaceIdx = afterSearch.indexOf('<<<REPLACE>>>')
    if (replaceIdx >= 0) {
      edits.push({
        search: afterSearch.slice(0, replaceIdx).trim(),
        replace: afterSearch.slice(replaceIdx + 14).trim(),
        complete: false
      })
    } else {
      edits.push({ search: afterSearch.trim(), replace: null, complete: false })
    }
  }
  return edits
}

const renderFileContentBlocks = (content, action) => {
  if (!content) return ''
  if (action === 'edit' || action === 'edit_failed') {
    const edits = parseEditBlocksForDisplay(content)
    if (edits.length === 0) return `<pre class="chat-edit-pre">${escHtml(content)}</pre>`
    return edits.map((edit) => {
      const searchHtml = `<div class="chat-edit-section">
        <div class="chat-edit-label">Replacing this code…</div>
        <pre class="chat-edit-pre chat-edit-search">${escHtml(edit.search)}</pre>
      </div>`
      const replaceHtml = edit.replace !== null
        ? `<div class="chat-edit-section">
            <div class="chat-edit-label">…with this new code${edit.complete ? '' : ' (streaming…)'}</div>
            <pre class="chat-edit-pre chat-edit-replace">${escHtml(edit.replace)}</pre>
          </div>`
        : ''
      return `<div class="chat-edit-block">${searchHtml}${replaceHtml}</div>`
    }).join('')
  }
  return `<pre class="chat-edit-pre">${escHtml(content)}</pre>`
}

const scrollEditPreBlocksToBottom = (container) => {
  container.querySelectorAll('.chat-edit-pre').forEach((pre) => {
    pre.scrollTop = pre.scrollHeight
  })
}

const renderFileList = (files) => {
  if (!files || files.length === 0) return ''
  const items = files.map((f) => {
    const tag = `<span class="chat-file-tag chat-file-${escHtml(f.action)}" data-file-path="${escHtml(f.path)}">${escHtml(f.path)}</span>`
    if (f.rawContent && (f.action === 'edit' || f.action === 'edit_failed' || f.action === 'upsert')) {
      const errorHtml = f.error
        ? `<div class="chat-edit-error">${escHtml(f.error)}</div>`
        : ''
      const contentHtml = renderFileContentBlocks(f.rawContent, f.action)
      const failedLabel = f.action === 'edit_failed' ? ' <span class="chat-edit-failed-label">failed</span>' : ''
      const failedCls = f.action === 'edit_failed' ? ' chat-file-edits-failed' : ''
      return `<details class="chat-file-edits-block${failedCls}">
        <summary>${tag}${failedLabel}</summary>
        ${errorHtml}
        <div class="chat-file-edits-content">${contentHtml}</div>
      </details>`
    }
    return tag
  }).join(' ')
  return `<div class="chat-file-list">${items}</div>`
}

const renderStreamingFiles = (files) => {
  if (!files || files.length === 0) return ''
  const items = files.map((f) => {
    const icon = f.done ? '✓' : ''
    const cls = f.done ? 'stream-file-done' : 'stream-file-active'
    const spinner = f.done ? '' : '<span class="chat-spinner-inline"></span>'
    const statusText = `${spinner}${icon} Updating <strong>${escHtml(f.path)}</strong>`
    const contentHtml = f.content ? renderFileContentBlocks(f.content, f.action) : ''
    if (contentHtml) {
      return `<details class="chat-file-edits-block ${cls}" ${!f.done ? 'open' : ''}>
        <summary class="stream-file-summary">${statusText}</summary>
        <div class="chat-file-edits-content">${contentHtml}</div>
      </details>`
    }
    return `<div class="stream-file-item ${cls}">${statusText}</div>`
  }).join('')
  return `<div class="stream-file-list" id="chatStreamingFiles">${items}</div>`
}

const renderUsageInfo = (msg) => {
  const parts = []
  if (msg.llmModel) parts.push(escHtml(msg.llmModel))
  const tokenTotal = msg.tokensUsed
    ? ((msg.tokensUsed.input?.qtty || 0) + (msg.tokensUsed.output?.qtty || 0) + (msg.tokensUsed.other?.qtty || 0))
    : 0
  if (msg.cost) {
    parts.push(formatTokens(msg.cost.totalTokens) + ' tokens')
    const costStr = formatCost(msg.cost)
    if (costStr) parts.push(costStr)
  } else if (tokenTotal > 0) {
    parts.push(formatTokens(tokenTotal) + ' tokens')
  }
  if (parts.length === 0) return ''
  return `<div class="chat-msg-usage">${parts.join(' · ')}</div>`
}

const renderMessage = (msg) => {
  if (msg.role === 'user') {
    return `<div class="chat-msg chat-msg-user">
      <div class="chat-msg-content">${escHtml(msg.content)}</div>
      <div class="chat-msg-time">${formatTime(msg.timestamp)}</div>
    </div>`
  }

  const parsed = msg.parsedResponse
  const usageHtml = renderUsageInfo(msg)
  const thinkingHtml = msg.thinking
    ? `<details class="chat-thinking-block"><summary>Thought Process</summary><pre class="chat-thinking-pre">${escHtml(msg.thinking)}</pre></details>`
    : ''

  if (parsed) {
    return `<div class="chat-msg chat-msg-assistant">
      ${thinkingHtml}
      <div class="chat-msg-content">${renderExplanation(parsed.explanation)}</div>
      ${renderFileList(parsed.files)}
      ${parsed.summary?.summary ? `<div class="chat-msg-summary">${escHtml(parsed.summary.summary)}</div>` : ''}
      <div class="chat-msg-footer">
        ${usageHtml}
        <div class="chat-msg-time">${formatTime(msg.timestamp)}</div>
      </div>
    </div>`
  }

  return `<div class="chat-msg chat-msg-assistant">
    ${thinkingHtml}
    <div class="chat-msg-content">${renderExplanation(msg.content)}</div>
    <div class="chat-msg-footer">
      ${usageHtml}
      <div class="chat-msg-time">${formatTime(msg.timestamp)}</div>
    </div>
  </div>`
}

const loadChatFromHistory = async (chatId, appName, setState) => {
  try {
    const updates = await freezr.query('appUpdates', { chatId, appName }, { sort: { timestamp: 1 }, count: 200 })
    if (!updates || !Array.isArray(updates) || updates.length === 0) {
      setState((next) => {
        if (!next.chat) next.chat = {}
        next.chat.loadFromHistory = false
        next.chat.error = 'No history found for this chat.'
        return next
      })
      return
    }

    const messages = []
    for (const entry of updates) {
      if (entry.userPrompt) {
        messages.push({
          role: 'user',
          content: entry.userPrompt,
          timestamp: entry.timestamp,
          fromHistory: true
        })
      }
      if (entry.summary || entry.explanation) {
        messages.push({
          role: 'assistant',
          content: '',
          timestamp: entry.timestamp,
          fromHistory: true,
          parsedResponse: {
            explanation: entry.explanation || entry.summary,
            files: (entry.filesChanged || []).map((f) => ({ path: f, action: 'upsert' })),
            summary: { summary: entry.summary || '' }
          },
          llmProvider: entry.llmProvider || undefined,
          llmModel: entry.llmModel || undefined,
          usage: entry.usage || undefined,
          tokensUsed: entry.tokensUsed || undefined,
          cost: entry.cost || undefined,
          thinking: entry.thinking || undefined
        })
      }
    }

    setState((next) => {
      if (!next.chat) next.chat = {}
      next.chat.loadFromHistory = false
      next.chat.messages = messages
      return next
    })
  } catch (error) {
    setState((next) => {
      if (!next.chat) next.chat = {}
      next.chat.loadFromHistory = false
      next.chat.error = error?.message || 'Could not load chat history.'
      return next
    })
  }
}

export const renderChatPanel = ({ container, state, setState, renderOptions }) => {
  const chatState = state.chat || {}
  const messages = chatState.messages || []
  const draftMessage = chatState.draftMessage || ''
  const sending = chatState.sending || false
  const chatError = chatState.error || null
  const appName = state.appName || ''
  const streamingContent = chatState.streamingContent || null
  const streamingThinking = chatState.streamingThinking || null
  const streamingFiles = chatState.streamingFiles || null

  if (renderOptions?.streamOnly) {
    const streamEl = container.querySelector('#chatStreamingContent')
    if (!streamEl) {
      // Streaming elements don't exist yet (DOM still has the "Thinking..." placeholder).
      // Fall through to a full render so the streaming template gets created.
    } else {
      const thinkEl = container.querySelector('#chatStreamingThinking')
      const filesEl = container.querySelector('#chatStreamingFiles')
      if (thinkEl && streamingThinking) {
        thinkEl.innerHTML = escHtml(streamingThinking)
        thinkEl.parentElement.hidden = false
      }
      streamEl.innerHTML = streamingContent ? renderExplanation(streamingContent) : ''
      if (filesEl) {
        filesEl.outerHTML = renderStreamingFiles(streamingFiles)
      } else if (streamingFiles && streamingFiles.length > 0) {
        streamEl.insertAdjacentHTML('afterend', renderStreamingFiles(streamingFiles))
      }
      const msgContainer = container.querySelector('#chatMessages')
      if (msgContainer) {
        const nearBottom = (msgContainer.scrollHeight - msgContainer.scrollTop - msgContainer.clientHeight) < 80
        if (nearBottom) msgContainer.scrollTop = msgContainer.scrollHeight
      }
      scrollEditPreBlocksToBottom(container)
      return
    }
  }

  if (chatState.loadFromHistory && chatState.chatId && appName) {
    container.innerHTML = `
      <div class="chat-wrapper">
        <div class="chat-header">
          <span class="chat-header-title">💬 Chat</span>
        </div>
        <div class="chat-messages"><div class="chat-msg chat-msg-loading"><div class="chat-spinner"></div> Loading chat history...</div></div>
      </div>
    `
    loadChatFromHistory(chatState.chatId, appName, setState)
    return
  }

  if (!appName) {
    container.innerHTML = `
      <div class="chat-wrapper">
        <div class="chat-empty">Select or create an app to start chatting.</div>
      </div>
    `
    return
  }

  const prevMsgContainer = container.querySelector('#chatMessages')
  const wasNearBottom = !prevMsgContainer ||
    (prevMsgContainer.scrollHeight - prevMsgContainer.scrollTop - prevMsgContainer.clientHeight) < 80

  const messagesHtml = messages.map(renderMessage).join('')
  const hasMessages = messages.length > 0
  const showNewChat = hasMessages || sending

  const launchBtnHtml = (hasMessages && appName && !sending)
    ? `<div class="launch-app-footer"><a href="/app/${encodeURIComponent(appName)}" target="_blank" class="panel-cta" data-action="launch-app">Launch App 🚀</a></div>`
    : ''

  const inputAreaHtml = `<div class="chat-input-area">
        <textarea id="chatInput" class="chat-input" placeholder="Describe what you want..." rows="2" ${sending ? 'disabled' : ''}>${escHtml(draftMessage)}</textarea>
        <button class="panel-cta chat-send-btn" data-action="send" ${sending ? 'disabled' : ''}>Send</button>
      </div>`

  container.innerHTML = `
    <div class="chat-wrapper${hasMessages ? '' : ' chat-wrapper-empty'}">
      <div class="chat-header${showNewChat ? ' chat-header-with-action' : ''}">
        <span class="chat-header-title">💬 Chat</span>
        ${showNewChat ? `<button class="panel-cta panel-cta-sm" data-action="new-chat" ${sending ? 'disabled' : ''}>New Chat</button>` : ''}
      </div>
      ${hasMessages ? '' : inputAreaHtml}
      <div class="chat-messages" id="chatMessages">
        ${messagesHtml}
        ${sending
          ? (streamingContent || streamingThinking || streamingFiles)
            ? `<div class="chat-msg chat-msg-assistant chat-msg-streaming">`
              + `<details class="chat-thinking-block"${streamingThinking && !streamingContent ? ' open' : ''} ${streamingThinking ? '' : 'hidden'}><summary>Thinking…</summary><pre class="chat-thinking-pre" id="chatStreamingThinking">${streamingThinking ? escHtml(streamingThinking) : ''}</pre></details>`
              + `<div class="chat-msg-content" id="chatStreamingContent">${streamingContent ? renderExplanation(streamingContent) : ''}</div>`
              + renderStreamingFiles(streamingFiles)
              + `<div class="chat-spinner-inline"></div></div>`
            : '<div class="chat-msg chat-msg-assistant chat-msg-loading"><div class="chat-spinner"></div> Thinking...</div>'
          : ''}
        ${chatError ? `<div class="chat-error-wrap"><div class="chat-error">${escHtml(chatError)}</div>${chatState.lastFailedMessage ? '<button class="panel-cta panel-cta-sm chat-retry-btn" data-action="retry">Retry</button>' : ''}</div>` : ''}
        ${launchBtnHtml}
      </div>
      ${hasMessages ? inputAreaHtml : ''}
    </div>
  `

  const msgContainer = container.querySelector('#chatMessages')
  if (msgContainer && wasNearBottom) {
    msgContainer.scrollTop = msgContainer.scrollHeight
  }
  scrollEditPreBlocksToBottom(container)

  container.querySelectorAll('.chat-file-tag[data-file-path]').forEach((tag) => {
    tag.onclick = async () => {
      const filePath = tag.dataset.filePath
      if (!filePath || !appName) return
      tag.classList.add('ft-file-loading')
      try {
        const content = await fetchFileContent(appName, filePath)
        const mobile = isMobile()
        setState((next) => {
          if (!next.file) next.file = {}
          if (!next.file.ui) next.file.ui = {}
          if (!next.chat.ui) next.chat.ui = {}
          if (mobile) next.chat.ui.visible = false
          next.file.ui.visible = true
          next.file.openFilePath = filePath
          next.file.openFileContent = content
          next.file.openFolderPath = null
          next.file.fileUpdateInfo = null
          return next
        }, { sourcePanel: 'file' })
      } catch (err) {
        showError(err?.message || 'Could not read file.')
      } finally {
        tag.classList.remove('ft-file-loading')
      }
    }
  })

  const chatLaunchBtn = container.querySelector('.launch-app-footer [data-action="launch-app"]')
  if (chatLaunchBtn) {
    chatLaunchBtn.onclick = (e) => {
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

  const input = container.querySelector('#chatInput')
  const sendBtn = container.querySelector('[data-action="send"]')
  const newChatBtn = container.querySelector('[data-action="new-chat"]')

  const syncDraftMessage = (value) => {
    setState((next) => {
      if (!next.chat) next.chat = {}
      next.chat.draftMessage = value
      return next
    }, { rerender: false })
  }

  const doSend = async () => {
    if (!input || sending) return
    const text = input.value.trim()
    if (!text) return

    clearError()
    setState((next) => {
      if (!next.chat) next.chat = {}
      next.chat.error = null
      next.chat.draftMessage = ''
      return next
    }, { rerender: false })

    const currentState = { ...state }
    currentState.chat = { ...(state.chat || {}), error: null }

    await sendChatMessage(text, currentState, setState)
  }

  if (sendBtn) sendBtn.onclick = doSend
  if (input) {
    const autoResize = () => {
      input.style.height = 'auto'
      input.style.height = Math.min(input.scrollHeight, 200) + 'px'
    }
    input.oninput = () => {
      syncDraftMessage(input.value)
      autoResize()
    }
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        doSend()
      }
    }
    autoResize()
  }

  if (newChatBtn) {
    newChatBtn.onclick = () => {
      setState((next) => {
        if (!next.chat) next.chat = {}
        next.chat.chatId = crypto.randomUUID()
        next.chat.messages = []
        next.chat.draftMessage = ''
        next.chat.sending = false
        next.chat.error = null
        next.chat.lastFailedMessage = null
        return next
      })
    }
  }

  const retryBtn = container.querySelector('[data-action="retry"]')
  if (retryBtn) {
    retryBtn.onclick = async () => {
      const failedMsg = chatState.lastFailedMessage
      if (!failedMsg || sending) return

      clearError()
      setState((next) => {
        if (!next.chat) next.chat = {}
        next.chat.error = null
        next.chat.lastFailedMessage = null
        return next
      }, { rerender: false })

      const currentState = { ...state }
      currentState.chat = { ...(state.chat || {}), error: null, lastFailedMessage: null }

      await sendChatMessage(failedMsg, currentState, setState)
    }
  }
}
