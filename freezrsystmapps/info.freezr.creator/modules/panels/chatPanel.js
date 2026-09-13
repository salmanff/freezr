/* global freezr */
import { sendChatMessage, grantDataAccess, denyDataAccess } from '../chatService.js'
import { showError, clearError } from '../showError.js'
import { fetchFileContent } from '../fileTree.js'
import { formatCost, formatTokens } from '../priceService.js'
import { escHtml, tsOf, saveChatDraft, clearChatDraft, saveWebSearchPref } from '../utils.js'
import { checkVoiceSupport, isRecording, startDictation, stopDictationAndTranscribe, cancelDictation } from '../voiceDictation.js'

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

const REFACTOR_DISMISS_REGROW = 200

const visibleRefactorBanners = (chatState) => {
  const largeFiles = chatState.largeFiles || []
  const dismissed = chatState.refactorBannerDismissed || {}
  return largeFiles.filter((f) => {
    const prev = dismissed[f.path]
    if (typeof prev !== 'number') return true
    return f.lineCount >= prev + REFACTOR_DISMISS_REGROW
  })
}

const renderRefactorBanner = (chatState) => {
  const visible = visibleRefactorBanners(chatState)
  if (visible.length === 0) return ''
  const items = visible.map((f) => `<div class="chat-refactor-banner-item">
    <div class="chat-refactor-banner-text"><strong>${escHtml(f.path)}</strong> is ${f.lineCount} lines. Refactor into smaller modules before continuing?</div>
    <div class="chat-refactor-banner-actions">
      <button class="panel-cta panel-cta-sm" data-action="refactor-yes" data-file-path="${escHtml(f.path)}" data-line-count="${f.lineCount}">Yes, refactor</button>
      <button class="panel-cta panel-cta-sm panel-cta-secondary" data-action="refactor-dismiss" data-file-path="${escHtml(f.path)}" data-line-count="${f.lineCount}">Not now</button>
    </div>
  </div>`).join('')
  return `<div class="chat-refactor-banner">${items}</div>`
}

// Consent card for a data access_request. Nothing is minted or read until Allow is clicked;
// write requests are visually distinct because they can change the user's stored records.
const renderAccessRequestCard = (chatState) => {
  const req = chatState.pendingAccessRequest
  if (!req) return ''
  const isWrite = req.access === 'write'
  const tables = (req.tables || []).filter(Boolean)
  const what = isWrite ? 'CHANGE' : 'read'
  return `<div class="chat-access-banner${isWrite ? ' chat-access-banner-write' : ''}">
    <div class="chat-access-banner-text">
      <strong>${isWrite ? '⚠️ ' : ''}The assistant is asking to ${what} your data.</strong>
      ${tables.length ? `<div class="chat-access-tables">${tables.map(escHtml).join(', ')}</div>` : ''}
      ${req.reason ? `<div class="chat-access-reason">“${escHtml(req.reason)}”</div>` : ''}
      <div class="chat-access-note">${isWrite
        ? 'Allowing lets it modify real records in this app for the next 30 minutes.'
        : 'Allowing shares up to ' + (Math.min(Math.max(parseInt(req.count, 10) || 3, 1), 50)) +
          ' record(s) per table, read-only, for the next 30 minutes.'}</div>
    </div>
    <div class="chat-access-banner-actions">
      <button class="panel-cta panel-cta-sm${isWrite ? ' panel-cta-danger' : ''}" data-action="access-allow">Allow ${isWrite ? 'changes' : 'read'}</button>
      <button class="panel-cta panel-cta-sm panel-cta-secondary" data-action="access-deny">Don't allow</button>
    </div>
  </div>`
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
    // displayContent: a short stand-in for machine-generated turns (e.g. a data-access grant,
    // whose real content carries a token and sample records).
    return `<div class="chat-msg chat-msg-user">
      <div class="chat-msg-content">${escHtml(msg.displayContent || msg.content)}</div>
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
    const updates = await freezr.query('appUpdates', { chatId, appName }, { sort: { _date_modified: 1 }, count: 200 })
    if (updates && Array.isArray(updates)) updates.sort((a, b) => tsOf(a) - tsOf(b))
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

  // The two evidence-triggered escalations. Neither asks the user to predict anything: one
  // fires because the MODEL said it needed the web, the other because our own cap actually bit.
  const renderWebPrompt = (cs) => {
    const wp = cs.webPrompt
    if (!wp || cs.sending) return ''
    if (wp.kind === 'needs_web') {
      const why = wp.reason ? `: <em>${escHtml(wp.reason)}</em>` : ''
      return `<div class="chat-web-prompt"><span>🌐 The assistant says it needs the web to answer this${why}</span>` +
        '<button class="panel-cta panel-cta-sm" data-action="retry-with-web">Search the web and retry</button></div>'
    }
    return '<div class="chat-web-prompt"><span>🌐 Search limit reached — the answer may be incomplete.</span>' +
      '<button class="panel-cta panel-cta-sm" data-action="retry-uncapped">Search more</button></div>'
  }

  const messagesHtml = messages.map(renderMessage).join('')
  const hasMessages = messages.length > 0
  const showNewChat = hasMessages || sending

  const launchBtnHtml = (hasMessages && appName && !sending)
    ? `<div class="launch-app-footer"><a href="/app/${encodeURIComponent(appName)}" target="_blank" class="panel-cta" data-action="launch-app">Launch App 🚀</a></div>`
    : ''

  // Web search toggle. OFF by default and deliberately visible rather than buried in settings:
  // turning it on adds ~7,200 input tokens to EVERY call in this conversation (measured), so the
  // user should be able to see at a glance that it is costing them.
  const webOn = chatState.webSearch === true
  const webToggleHtml = `<button type="button"
        class="chat-web-toggle${webOn ? ' chat-web-toggle-on' : ''}"
        data-action="toggle-web"
        aria-pressed="${webOn ? 'true' : 'false'}"
        title="${webOn
          ? 'Web search is ON for this app — the assistant can search and read pages. Adds cost to every message.'
          : 'Web search is OFF. Turn it on to let the assistant look things up (adds cost to every message).'}"
        ${sending ? 'disabled' : ''}>🌐${webOn ? ' Web on' : ''}</button>`

  // Dictation. Absent until checkVoiceSupport() has answered, rather than rendered-then-hidden:
  // voice is ChatGPT-only, so for a Claude-only user this button must never appear at all.
  // recordingState is 'idle' | 'recording' | 'transcribing'.
  const voiceReady = chatState.voiceSupported === true
  const recordingState = chatState.recording || 'idle'
  const micLabel = { idle: '🎤', recording: '⏺ Listening…', transcribing: '… Transcribing' }[recordingState]
  // Name the key that will be spent. Only one provider does speech today, so this is often NOT
  // the provider selected in the model settings — worth saying before it appears on a bill.
  const voiceProvider = chatState.voiceProvider || null
  const micTitle = 'Hold to dictate. The text lands in the box for you to check before sending.' +
    (voiceProvider ? ' Speech uses your ' + voiceProvider + ' key.' : '')
  const micHtml = voiceReady
    ? `<button type="button"
        class="chat-mic-btn${recordingState !== 'idle' ? ' chat-mic-btn-live' : ''}"
        data-action="dictate"
        title="${escHtml(micTitle)}"
        ${sending || recordingState === 'transcribing' ? 'disabled' : ''}>${micLabel}</button>`
    : ''

  const inputAreaHtml = `<div class="chat-input-area">
        <textarea id="chatInput" class="chat-input" placeholder="Describe what you want..." rows="2" ${sending ? 'disabled' : ''}>${escHtml(draftMessage)}</textarea>
        <div class="chat-input-actions">
          ${micHtml}
          ${webToggleHtml}
          <button class="panel-cta chat-send-btn" data-action="send" ${sending ? 'disabled' : ''}>Send</button>
        </div>
      </div>`

  container.innerHTML = `
    <div class="chat-wrapper${hasMessages ? '' : ' chat-wrapper-empty'}">
      <div class="chat-header${showNewChat ? ' chat-header-with-action' : ''}">
        <span class="chat-header-title">💬 Chat</span>
        ${showNewChat ? `<button class="panel-cta panel-cta-sm" data-action="new-chat" ${sending ? 'disabled' : ''}>New Chat</button>` : ''}
      </div>
      ${hasMessages ? '' : inputAreaHtml}
      ${renderRefactorBanner(chatState)}
      <div class="chat-messages" id="chatMessages">
        ${messagesHtml}
        ${renderAccessRequestCard(chatState)}
        ${sending
          ? (streamingContent || streamingThinking || streamingFiles)
            ? `<div class="chat-msg chat-msg-assistant chat-msg-streaming">`
              + `<details class="chat-thinking-block"${streamingThinking && !streamingContent ? ' open' : ''} ${streamingThinking ? '' : 'hidden'}><summary>Thinking…</summary><pre class="chat-thinking-pre" id="chatStreamingThinking">${streamingThinking ? escHtml(streamingThinking) : ''}</pre></details>`
              + `<div class="chat-msg-content" id="chatStreamingContent">${streamingContent ? renderExplanation(streamingContent) : ''}</div>`
              + renderStreamingFiles(streamingFiles)
              + `<div class="chat-spinner-inline"></div></div>`
            : '<div class="chat-msg chat-msg-assistant chat-msg-loading"><div class="chat-spinner"></div> Thinking...</div>'
          : ''}
        ${renderWebPrompt(chatState)}
        ${chatError ? `<div class="chat-error-wrap"><div class="chat-error">${escHtml(chatError)}</div>${chatState.lastFailedMessage ? '<button class="panel-cta panel-cta-sm chat-retry-btn" data-action="retry">Retry</button>' : ''}</div>` : ''}
        ${launchBtnHtml}
      </div>
      ${hasMessages ? inputAreaHtml : ''}
    </div>
  `

  const msgContainer = container.querySelector('#chatMessages')
  // forceScrollToBottom: set when a prompt was just sent, so the new prompt is visible regardless
  // of where the user had scrolled. Otherwise only auto-scroll if they were already near the bottom.
  const forceScrollToBottom = !!chatState.scrollToBottom
  if (msgContainer && (wasNearBottom || forceScrollToBottom)) {
    msgContainer.scrollTop = msgContainer.scrollHeight
  }
  if (forceScrollToBottom) {
    setState((next) => {
      if (next.chat) next.chat.scrollToBottom = false
      return next
    }, { rerender: false })
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
  const webBtn = container.querySelector('[data-action="toggle-web"]')
  const retryWebBtn = container.querySelector('[data-action="retry-with-web"]')
  const retryUncappedBtn = container.querySelector('[data-action="retry-uncapped"]')

  if (webBtn) {
    webBtn.onclick = () => {
      const turningOn = !(state.chat?.webSearch === true)
      // Sticky per app: a follow-up to a web-answered question usually needs the web too.
      saveWebSearchPref(state.appName, turningOn)
      setState((next) => {
        if (!next.chat) next.chat = {}
        next.chat.webSearch = turningOn
        if (!turningOn) next.chat.webUncapped = false
        next.chat.webPrompt = null
        return next
      }, { rerender: true, sourcePanel: 'chat' })
    }
  }

  // Re-ask the SAME message with the web enabled. The user has now seen why it is needed, which
  // is the whole point of not turning it on speculatively.
  const resendWith = async ({ uncapped }) => {
    const wp = state.chat?.webPrompt
    if (!wp || !wp.message) return
    saveWebSearchPref(state.appName, true)
    setState((next) => {
      if (!next.chat) next.chat = {}
      next.chat.webSearch = true
      next.chat.webUncapped = uncapped === true
      next.chat.webPrompt = null
      next.chat.error = null
      return next
    }, { rerender: false })

    const currentState = { ...state }
    currentState.chat = { ...(state.chat || {}), webSearch: true, webUncapped: uncapped === true, webPrompt: null, error: null }
    await sendChatMessage(wp.message, currentState, setState)
  }

  if (retryWebBtn) retryWebBtn.onclick = () => resendWith({ uncapped: false })
  if (retryUncappedBtn) retryUncappedBtn.onclick = () => resendWith({ uncapped: true })

  const syncDraftMessage = (value) => {
    // Mirror to localStorage as the user types so an abrupt shutdown doesn't lose the prompt.
    saveChatDraft(state.appName, value)
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

  // Ask once per session whether voice is usable, then re-render so the mic can appear. Doing
  // this here rather than at startup keeps it off the critical path — the chat is usable
  // immediately and the button arrives a moment later.
  if (chatState.voiceSupported === undefined) {
    checkVoiceSupport().then(({ supported, provider }) => {
      setState((next) => {
        if (!next.chat) next.chat = {}
        next.chat.voiceSupported = supported
        next.chat.voiceProvider = provider
        return next
      })
    })
  }

  const micBtn = container.querySelector('[data-action="dictate"]')
  if (micBtn) {
    // The recording state is painted DIRECTLY onto the button, with rerender:false, instead of
    // going through a normal setState. A full rerender here would rebuild the input area in the
    // middle of a press-and-hold: the textarea would be recreated (losing the caret), and the
    // mousedown would have landed on an element that no longer exists by the time the user
    // lets go. The state is still recorded so a later, unrelated rerender paints it correctly.
    const MIC_LABELS = { idle: '🎤', recording: '⏺ Listening…', transcribing: '… Transcribing' }
    const setRecording = (value) => {
      micBtn.textContent = MIC_LABELS[value]
      micBtn.classList.toggle('chat-mic-btn-live', value !== 'idle')
      micBtn.disabled = value === 'transcribing'
      setState((next) => {
        if (!next.chat) next.chat = {}
        next.chat.recording = value
        return next
      }, { rerender: false })
    }

    const begin = async (e) => {
      e.preventDefault() // stop a touch from also firing the mouse handlers
      if (isRecording() || sending) return
      try {
        await startDictation()
        setRecording('recording')
      } catch (err) {
        // Overwhelmingly a denied mic permission. Say which, because "failed" sends people
        // looking in the wrong place.
        showError(err?.name === 'NotAllowedError'
          ? 'Microphone access was blocked. Allow it in your browser to dictate.'
          : 'Could not start recording: ' + (err?.message || 'unknown error'))
        setRecording('idle')
      }
    }

    const finish = async () => {
      if (!isRecording()) return
      setRecording('transcribing')
      try {
        const text = await stopDictationAndTranscribe()
        if (text) {
          // APPEND rather than replace: dictating twice, or dictating after typing, should add
          // to what is there. And it goes in the box, never straight to send — see voiceDictation.js.
          const current = container.querySelector('#chatInput')
          const merged = current && current.value.trim() ? current.value.replace(/\s*$/, '') + ' ' + text : text
          if (current) {
            current.value = merged
            // The textarea auto-grows on input; a programmatic value change fires no input
            // event, so a dictated paragraph would sit in a two-row box without this.
            current.style.height = 'auto'
            current.style.height = Math.min(current.scrollHeight, 200) + 'px'
          }
          syncDraftMessage(merged)
        }
      } catch (err) {
        showError('Could not transcribe: ' + (err?.message || 'unknown error'))
      }
      setRecording('idle')
      const restored = container.querySelector('#chatInput')
      if (restored) restored.focus()
    }

    // Hold to talk: press starts, release anywhere ends it. `mouseleave` matters — releasing
    // outside the button would otherwise leave the mic open indefinitely.
    micBtn.onmousedown = begin
    micBtn.onmouseup = finish
    micBtn.onmouseleave = () => { if (isRecording()) finish() }
    micBtn.ontouchstart = begin
    micBtn.ontouchend = (e) => { e.preventDefault(); finish() }
    micBtn.ontouchcancel = () => { cancelDictation(); setRecording('idle') }
  }

  if (newChatBtn) {
    newChatBtn.onclick = () => {
      cancelDictation() // never leave the mic open across a chat reset
      clearChatDraft(state.appName)
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

  // Data-access consent. Allow mints a short-lived token (read-only unless the request was for
  // write) and resumes the conversation; Don't allow resumes it with a refusal.
  const accessAllowBtn = container.querySelector('[data-action="access-allow"]')
  if (accessAllowBtn) {
    accessAllowBtn.onclick = async () => {
      accessAllowBtn.disabled = true
      clearError()
      const currentState = { ...state, chat: { ...(state.chat || {}), error: null } }
      await grantDataAccess(currentState, setState)
    }
  }
  const accessDenyBtn = container.querySelector('[data-action="access-deny"]')
  if (accessDenyBtn) {
    accessDenyBtn.onclick = async () => {
      accessDenyBtn.disabled = true
      clearError()
      const currentState = { ...state, chat: { ...(state.chat || {}), error: null } }
      await denyDataAccess(currentState, setState)
    }
  }

  container.querySelectorAll('[data-action="refactor-yes"]').forEach((btn) => {
    btn.onclick = () => {
      const filePath = btn.dataset.filePath
      if (!filePath) return
      const prompt = 'Please refactor `' + filePath + '` into smaller modules grouped by concern (data, UI, helpers, etc.). Keep behavior unchanged. Update manifest.json\'s `modules` array and `files` list so each new file is registered with a one-sentence Description.'
      setState((next) => {
        if (!next.chat) next.chat = {}
        next.chat.draftMessage = prompt
        if (next.chat.largeFiles) {
          next.chat.largeFiles = next.chat.largeFiles.filter((f) => f.path !== filePath)
        }
        return next
      }, { sourcePanel: 'chat' })
    }
  })

  container.querySelectorAll('[data-action="refactor-dismiss"]').forEach((btn) => {
    btn.onclick = () => {
      const filePath = btn.dataset.filePath
      const lineCount = parseInt(btn.dataset.lineCount, 10)
      if (!filePath || !Number.isFinite(lineCount)) return
      setState((next) => {
        if (!next.chat) next.chat = {}
        if (!next.chat.refactorBannerDismissed) next.chat.refactorBannerDismissed = {}
        next.chat.refactorBannerDismissed[filePath] = lineCount
        return next
      }, { sourcePanel: 'chat' })
    }
  })

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
