/* global freezr */
import { CHAT_PROMPT } from './longTexts/chatPrompt.js'
import { PERMISSION_PROMPT } from './longTexts/permissionPrompt.js'
import { API_REFERENCE } from './longTexts/apiReference.js'
import { fetchAppHistory } from './historyActions.js'
import { fetchFolderTree } from './fileTree.js'
import { setManifestFromObject } from './panels/manifestRenderer.js'
import { calculateProjectCost } from './priceService.js'
import { saveFileToBackend, updateAppFromFiles } from './utils.js'
import { flushEditorIfDirty } from './panels/filePanel.js'

// --- Incremental stream display parser ---
// Parses the raw streamed text as it grows, extracting display text and file status.
// Explanations are shown; file contents are replaced with "Updating {path}" indicators;
// summary sections are hidden.

export const extractStreamDisplay = (rawText) => {
  let display = ''
  const files = []
  let pos = 0

  while (pos < rawText.length) {
    const startTag = rawText.indexOf('<<<FREEZR_START', pos)
    if (startTag < 0) {
      display += rawText.slice(pos)
      break
    }

    const textBefore = rawText.slice(pos, startTag).trim()
    if (textBefore) display += (display ? '\n\n' : '') + textBefore

    const tagEnd = rawText.indexOf('>>>', startTag + 15)
    if (tagEnd < 0) break

    const tagContent = rawText.slice(startTag + 15, tagEnd).trim()
    const typeMatch = tagContent.match(/type="([^"]*)"/)
    const pathMatch = tagContent.match(/path="([^"]*)"/)
    const actionMatch = tagContent.match(/action="([^"]*)"/)
    const type = typeMatch?.[1]
    const contentStart = tagEnd + 3
    const endTag = rawText.indexOf('<<<FREEZR_END>>>', contentStart)

    if (type === 'explanation') {
      if (endTag >= 0) {
        const sectionText = rawText.slice(contentStart, endTag).trim()
        if (sectionText) display += (display ? '\n\n' : '') + sectionText
        pos = endTag + 16
      } else {
        const partial = rawText.slice(contentStart).trim()
        if (partial) display += (display ? '\n\n' : '') + partial
        break
      }
    } else if (type === 'file') {
      const filePath = pathMatch?.[1] || 'file'
      const action = actionMatch?.[1] || 'upsert'
      const done = endTag >= 0
      const content = done ? rawText.slice(contentStart, endTag).trim() : rawText.slice(contentStart).trim()
      files.push({ path: filePath, action, done, content })
      if (done) {
        pos = endTag + 16
      } else {
        break
      }
    } else if (type === 'image') {
      const filePath = pathMatch?.[1] || 'static/image.png'
      const done = endTag >= 0
      const statusLabel = done ? 'Generating' : 'Preparing'
      files.push({ path: filePath, action: 'image', done: false })
      display += (display ? '\n\n' : '') + `*${statusLabel} image: ${filePath}...*`
      if (done) {
        pos = endTag + 16
      } else {
        break
      }
    } else if (type === 'summary') {
      if (endTag >= 0) {
        pos = endTag + 16
      } else {
        break
      }
    } else {
      pos = tagEnd + 3
    }
  }

  return { displayText: display.trim(), files }
}

// --- Response parser ---

export const parseFreezrResponse = (responseText) => {
  const result = { explanation: '', files: [], images: [], summary: null, parseErrors: [], hasSections: false }
  const sectionRegex = /<<<FREEZR_START\s([^>]*)>>>([\s\S]*?)<<<FREEZR_END>>>/g
  const explanationParts = []
  let lastIndex = 0
  let match

  while ((match = sectionRegex.exec(responseText)) !== null) {
    result.hasSections = true

    const textBefore = responseText.slice(lastIndex, match.index).trim()
    if (textBefore) explanationParts.push(textBefore)
    lastIndex = match.index + match[0].length

    const attributeStr = match[1].trim()
    const content = match[2].trim()
    const attrRegex = /(\w+)="([^"]*)"/g
    const attrs = {}
    let attrMatch
    while ((attrMatch = attrRegex.exec(attributeStr)) !== null) {
      attrs[attrMatch[1]] = attrMatch[2]
    }

    switch (attrs.type) {
      case 'explanation':
        explanationParts.push(content)
        break
      case 'file':
        if (!attrs.path) {
          result.parseErrors.push('File section missing path attribute: ' + attributeStr)
          break
        }
        result.files.push({ path: attrs.path, action: attrs.action || 'upsert', content })
        break
      case 'image':
        if (!attrs.path) {
          result.parseErrors.push('Image section missing path attribute: ' + attributeStr)
          break
        }
        result.images.push({ path: attrs.path, prompt: content })
        break
      case 'summary':
        try {
          result.summary = JSON.parse(content)
        } catch (e) {
          result.parseErrors.push('Failed to parse summary JSON: ' + e.message)
        }
        break
      default:
        result.parseErrors.push('Unknown section type: "' + attrs.type + '"')
    }
  }

  const trailing = responseText.slice(lastIndex).trim()
  if (trailing) explanationParts.push(trailing)

  result.explanation = explanationParts.join('\n\n')
  return result
}

// --- Edit-mode utilities ---

const parseEditBlocks = (content) => {
  const edits = []
  const regex = /<<<SEARCH>>>([\s\S]*?)<<<REPLACE>>>([\s\S]*?)<<<END_REPLACE>>>/g
  let match
  while ((match = regex.exec(content)) !== null) {
    edits.push({ search: match[1].trim(), replace: match[2].trim() })
  }
  return edits
}

const findMatch = (text, search, fromOffset) => {
  const exactIdx = text.indexOf(search, fromOffset)
  if (exactIdx >= 0) return { idx: exactIdx, len: search.length }

  const searchLines = search.split('\n')
  const textLines = text.split('\n')

  let startLine = 0
  if (fromOffset > 0) {
    let charCount = 0
    for (let i = 0; i < textLines.length; i++) {
      if (charCount >= fromOffset) { startLine = i; break }
      charCount += textLines[i].length + 1
    }
  }

  const normalizers = [l => l.trimEnd(), l => l.trim()]
  for (const norm of normalizers) {
    const normSearch = searchLines.map(norm)
    for (let i = startLine; i <= textLines.length - searchLines.length; i++) {
      let matched = true
      for (let j = 0; j < searchLines.length; j++) {
        if (norm(textLines[i + j]) !== normSearch[j]) { matched = false; break }
      }
      if (matched) {
        let pos = 0
        for (let k = 0; k < i; k++) pos += textLines[k].length + 1
        let matchLen = 0
        for (let j = 0; j < searchLines.length; j++) {
          matchLen += textLines[i + j].length
          if (j < searchLines.length - 1) matchLen += 1
        }
        return { idx: pos, len: matchLen }
      }
    }
  }
  return { idx: -1, len: 0 }
}

const applyEdits = (originalContent, edits) => {
  let result = originalContent
  for (const edit of edits) {
    if (!edit.search) throw new Error('Empty search block')
    const { idx, len } = findMatch(result, edit.search, 0)
    if (idx === -1) {
      throw new Error('Search block not found: "' + edit.search.slice(0, 80).replace(/\n/g, '\\n') + '…"')
    }
    const { idx: secondIdx } = findMatch(result, edit.search, idx + 1)
    if (secondIdx !== -1) {
      throw new Error('Search block matches multiple locations (ambiguous): "' + edit.search.slice(0, 80).replace(/\n/g, '\\n') + '…"')
    }
    result = result.slice(0, idx) + edit.replace + result.slice(idx + len)
  }
  return result
}

const isValidJS = (filePath, code) => {
  if (!filePath.endsWith('.js') && !filePath.endsWith('.mjs')) return true
  if (/^\s*(import\s|export\s)/m.test(code)) return true
  try {
    new Function(code)
    return true
  } catch (e) {
    return !(e instanceof SyntaxError)
  }
}

const resolveEditFiles = (parsedFiles, allFiles) => {
  const allFilesMap = {}
  for (const f of allFiles) allFilesMap[f.path] = f

  const resolved = []
  const warnings = []

  for (const file of parsedFiles) {
    if (file.action !== 'edit') {
      resolved.push(file)
      continue
    }
    const original = allFilesMap[file.path]
    if (!original) {
      warnings.push({ path: file.path, error: 'File not found for editing' })
      continue
    }
    try {
      const editBlocks = parseEditBlocks(file.content)
      if (editBlocks.length === 0) {
        warnings.push({ path: file.path, error: 'No valid search/replace blocks found' })
        continue
      }
      const content = applyEdits(original.content || '', editBlocks)
      if (!isValidJS(file.path, content)) {
        warnings.push({ path: file.path, error: 'Syntax error after applying edits' })
        continue
      }
      resolved.push({ path: file.path, action: 'upsert', content })
    } catch (e) {
      warnings.push({ path: file.path, error: e.message })
    }
  }
  return { resolved, warnings }
}

// --- Prompt builder ---

const flattenTreeToText = (tree, indent = '') => {
  let out = ''
  for (const node of tree) {
    if (node.type === 'folder') {
      out += indent + node.name + '/\n'
      if (node.children) out += flattenTreeToText(node.children, indent + '  ')
    } else {
      out += indent + node.name + '\n'
    }
  }
  return out
}

const fetchAllFiles = async (appName) => {
  const result = await freezr.apiRequest('GET', '/creatorapi/read_all_files?app_name=' + encodeURIComponent(appName))
  if (!result || result.error) throw new Error(result?.error || 'Could not read files.')
  return result.files || []
}

const EXCLUDED_FROM_CONTEXT = new Set(['freezrApiV2.js'])

const REFACTOR_LINE_THRESHOLD = 600

const buildFilesContext = (files) => {
  return files
    .filter((f) => !EXCLUDED_FROM_CONTEXT.has(f.path))
    .map((f) => {
      if (f.readOnly) return '--- FILE: ' + f.path + ' (READ-ONLY reference) ---\n' + f.content + '\n--- END FILE ---'
      return '--- FILE: ' + f.path + ' ---\n' + (f.content || '') + '\n--- END FILE ---'
    }).join('\n\n')
}

const computeLargeFiles = (files) => (files || [])
  .filter((f) => !f.readOnly && f.content && !EXCLUDED_FROM_CONTEXT.has(f.path))
  .map((f) => ({ path: f.path, lineCount: (f.content || '').split('\n').length }))
  .filter((f) => f.lineCount > REFACTOR_LINE_THRESHOLD)

export const detectLargeFiles = async (appName, setState) => {
  if (!appName) return
  try {
    const files = await fetchAllFiles(appName)
    const largeFiles = computeLargeFiles(files)
    setState((next) => {
      if (!next.chat) next.chat = {}
      next.chat.largeFiles = largeFiles
      return next
    }, { rerender: true, sourcePanel: 'chat' })
  } catch (error) {
    console.warn('Could not detect large files for', appName, error)
  }
}

const PERMISSION_TYPES_WITH_TARGET_MANIFEST = new Set(['read_all', 'write_all', 'write_own'])

const getAppNameFromTableId = (tableId) => {
  const value = String(tableId || '').trim()
  const splitAt = value.lastIndexOf('.')
  if (splitAt <= 0 || splitAt >= value.length - 1) return ''
  return value.slice(0, splitAt)
}

const collectPermissionTargetApps = (manifestObject, currentAppName) => {
  const targetApps = new Set()
  const permissions = Array.isArray(manifestObject?.permissions) ? manifestObject.permissions : []

  for (const permission of permissions) {
    if (!PERMISSION_TYPES_WITH_TARGET_MANIFEST.has(permission?.type)) continue
    const tableIds = []
    if (permission?.table_id) tableIds.push(permission.table_id)
    if (Array.isArray(permission?.table_ids)) tableIds.push(...permission.table_ids)

    for (const tableId of tableIds) {
      const targetApp = getAppNameFromTableId(tableId)
      if (targetApp && targetApp !== currentAppName) targetApps.add(targetApp)
    }
  }

  return [...targetApps]
}

const collectMentionedTargetApps = (text, currentAppName) => {
  const targetApps = new Set()
  const tableIdMatches = String(text || '').match(/\b[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2,}\b/g) || []

  for (const tableId of tableIdMatches) {
    const targetApp = getAppNameFromTableId(tableId)
    if (targetApp && targetApp !== currentAppName) targetApps.add(targetApp)
  }

  return [...targetApps]
}

const getExistingAppManifestContent = (existingApps, targetAppName) => {
  const matchedApp = (existingApps || []).find((app) => {
    const name = typeof app === 'string' ? app : app?.app_name
    return name === targetAppName
  })

  const manifest = matchedApp && typeof matchedApp === 'object' ? matchedApp.manifest : null
  if (!manifest) return null
  if (typeof manifest === 'string') return manifest

  try {
    return JSON.stringify(manifest, null, 2)
  } catch (error) {
    console.warn('Could not stringify cached manifest for prompt context:', targetAppName, error)
    return null
  }
}

export const buildPrompt = async (userMessage, state) => {
  const appName = state.appName
  const fileTree = state.index?.fileTree || []
  const chatMessages = state.chat?.messages || []
  const existingApps = state.project?.existingApps || []

  const allFiles = await fetchAllFiles(appName)
  const manifestFile = allFiles.find((file) => file.path === 'manifest.json')
  let manifestObject = null
  if (manifestFile?.content) {
    try {
      manifestObject = JSON.parse(manifestFile.content)
    } catch (error) {
      console.warn('Could not parse current manifest.json for prompt context:', error)
    }
  }

  const contextParts = []
  contextParts.push('## Current file structure\n' + flattenTreeToText(fileTree))
  contextParts.push('## Current file contents\n' + buildFilesContext(allFiles))
  contextParts.push('--- FILE: REFERENCE/apiReference.md (READ-ONLY reference) ---\n' + API_REFERENCE + '\n--- END FILE ---')
  contextParts.push('--- FILE: REFERENCE/permissionInstructions.md (READ-ONLY reference) ---\n' + PERMISSION_PROMPT + '\n--- END FILE ---')

  const targetApps = new Set([
    ...collectPermissionTargetApps(manifestObject, appName),
    ...collectMentionedTargetApps(userMessage, appName)
  ])

  if (targetApps.size > 0) {
    const referencedManifests = [...targetApps].map((targetApp) => {
      const manifestContent = getExistingAppManifestContent(existingApps, targetApp)
      if (manifestContent) {
        return '--- FILE: REFERENCE/' + targetApp + '/manifest.json (READ-ONLY permission target manifest) ---\n' + manifestContent + '\n--- END FILE ---'
      }
      return '--- FILE: REFERENCE/' + targetApp + '/manifest.json (READ-ONLY permission target manifest) ---\n[Manifest not found in creatorState.project.existingApps for ' + targetApp + '.]\n--- END FILE ---'
    })
    contextParts.push('## Referenced app manifests\n' + referencedManifests.join('\n\n'))
  }

  const contextMessage = contextParts.join('\n\n')

  const messages = []

  messages.push({ role: 'user', content: contextMessage })
  messages.push({ role: 'assistant', content: 'I have reviewed the project files, structure, and reference documents. What would you like me to do?' })

  for (const msg of chatMessages) {
    messages.push({ role: msg.role, content: msg.content })
  }

  messages.push({ role: 'user', content: userMessage })
  messages.push({ role: 'user', content: 'RULES REMINDER: No inline <script> tags. Use validateDataOwner two-step pattern for cross-app data. Follow the output format exactly.' })

  return { messages, context: CHAT_PROMPT, allFiles }
}

// --- File saving ---

// --- Main orchestrator ---

export const sendChatMessage = async (userMessage, state, setState) => {
  const appName = state.appName
  const chatId = state.chat?.chatId || crypto.randomUUID()
  const timestamp = new Date().toISOString()

  setState((next) => {
    if (!next.chat) next.chat = {}
    next.chat.chatId = chatId
    next.chat.sending = true
    next.chat.error = null
    next.chat.draftMessage = ''
    next.chat.messages = [...(next.chat.messages || []), { role: 'user', content: userMessage, timestamp }]
    return next
  }, { rerender: true, sourcePanel: 'chat' })

  try {
    await flushEditorIfDirty()

    const currentState = { ...state, chat: { ...state.chat, chatId, messages: [...(state.chat?.messages || []), { role: 'user', content: userMessage, timestamp }] } }
    const { messages, context, allFiles } = await buildPrompt(userMessage, currentState)

    const largeFiles = computeLargeFiles(allFiles)
    setState((next) => {
      if (!next.chat) next.chat = {}
      next.chat.largeFiles = largeFiles
      return next
    }, { rerender: false })

    console.log('messages', messages)
    const requestedModel = state.llm?.model || null
    const askOptions = { context, streamBack: true, thinking: true }
    if (requestedModel) askOptions.model = requestedModel
    if (state.llm?.provider) askOptions.provider = state.llm.provider
    if (state.llm?.options?.maxTokens) askOptions.max_tokens = state.llm.options.maxTokens

    let streamedText = ''
    let streamedThinking = ''
    let lastRenderTime = 0
    const RENDER_INTERVAL_MS = 80

    const pushStreamRender = () => {
      const now = Date.now()
      if (now - lastRenderTime < RENDER_INTERVAL_MS) return
      lastRenderTime = now
      const parsed = extractStreamDisplay(streamedText)
      const thinkingSnapshot = streamedThinking
      setState((next) => {
        if (!next.chat) next.chat = {}
        next.chat.streamingContent = parsed.displayText || null
        next.chat.streamingFiles = parsed.files.length > 0 ? parsed.files : null
        next.chat.streamingThinking = thinkingSnapshot || null
        return next
      }, { rerender: true, sourcePanel: 'chat', streamOnly: true })
    }

    askOptions.onDelta = (text) => {
      streamedText += text
      pushStreamRender()
    }
    askOptions.onThinking = (text) => {
      streamedThinking += text
      pushStreamRender()
    }

    const llmResult = await freezr.llm.ask(messages, askOptions)

    setState((next) => {
      if (!next.chat) next.chat = {}
      next.chat.streamingContent = null
      next.chat.streamingFiles = null
      next.chat.streamingThinking = null
      return next
    }, { rerender: false })

    console.log('llmResult', llmResult)

    if (!llmResult?.success || !llmResult?.response) {
      throw new Error(llmResult?.error || 'LLM returned no response.')
    }

    const rawResponse = llmResult.response
    const llmMeta = llmResult.meta || {}
    const llmUsage = llmMeta.rawUsage || null
    const llmProvider = llmMeta.provider || null
    const llmModel = llmMeta.model || null
    const llmModelFamily = llmMeta.modelFamily || null
    const tokensUsed = llmMeta.tokensUsed || null
    const costInfo = llmMeta.cost || null

    const parsed = parseFreezrResponse(rawResponse)
    const shouldUseStructuredResponse = parsed.hasSections

    if (parsed.parseErrors.length > 0) {
      console.warn('Parse warnings:', parsed.parseErrors)
    }

    let filesToSave = parsed.files
    let editWarnings = []
    const turnId = crypto.randomUUID()

    if (shouldUseStructuredResponse) {
      const editResult = resolveEditFiles(parsed.files, allFiles)
      filesToSave = editResult.resolved
      editWarnings = editResult.warnings

      if (editWarnings.length > 0) {
        console.warn('Edit warnings:', editWarnings)
        parsed.explanation = (parsed.explanation || '') +
          '\n\n⚠️ Edit application failed for:\n' +
          editWarnings.map(w => '• ' + w.path + ': ' + w.error).join('\n') +
          '\nPlease ask to resend the full file content.'
      }

      for (const file of filesToSave) {
        try {
          await saveFileToBackend(appName, file.path, file.content, file.action)
        } catch (err) {
          console.warn('Failed to save file ' + file.path + ':', err)
        }

        try {
          await freezr.create('fileUpdates', {
            appName,
            chatId,
            historyId: turnId,
            path: file.path,
            action: file.action,
            content: file.content,
            timestamp
          })
        } catch (err) {
          console.warn('Could not record fileUpdates entry:', err)
        }
      }
    }

    if (shouldUseStructuredResponse && parsed.images && parsed.images.length > 0) {
      for (const img of parsed.images) {
        try {
          const imgOptions = { outputFormat: 'png' }
          if (state.llm?.provider) imgOptions.provider = state.llm.provider
          const genResult = await freezr.llm.generateImage(img.prompt, imgOptions)
          if (genResult?.success && genResult.b64Data) {
            const binary = atob(genResult.b64Data)
            const bytes = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
            const blob = new Blob([bytes], { type: 'image/png' })
            const file = new File([blob], img.path.split('/').pop() || 'image.png', { type: 'image/png' })

            const formData = new FormData()
            formData.append('file', file)
            formData.append('app_name', appName)
            formData.append('file_path', img.path)
            await freezr.apiRequest('POST', '/creatorapi/upload_app_file', formData, { uploadFile: true })
            filesToSave.push({ path: img.path, action: 'image_generated' })
          } else {
            console.warn('Image generation returned no data for', img.path, genResult?.error)
          }
        } catch (err) {
          console.warn('Failed to generate image for ' + img.path + ':', err)
        }
      }
    }

    const hasFileChanges = shouldUseStructuredResponse && (filesToSave.length > 0 || (parsed.images && parsed.images.length > 0))

    if (hasFileChanges) {
      try {
        await updateAppFromFiles(appName)
      } catch (err) {
        console.warn('Could not update app from files:', err)
      }
    }

    const summaryText = shouldUseStructuredResponse
      ? (parsed.summary?.summary || 'Chat update')
      : 'Assistant reply'
    const threadText = shouldUseStructuredResponse
      ? (parsed.summary?.thread || 'Chat update')
      : 'Assistant reply'
    const allChangedFiles = [
      ...filesToSave.map((f) => f.path),
      ...(parsed.images || []).map((img) => img.path)
    ]
    const filesChanged = shouldUseStructuredResponse
      ? (parsed.summary?.filesChanged || allChangedFiles)
      : []
    const explanationText = shouldUseStructuredResponse ? (parsed.explanation || '') : rawResponse

    let chatHistoryEntry = null
    try {
      const updateRecord = {
        appName,
        action: 'chat',
        chatId,
        turnId,
        userPrompt: userMessage,
        explanation: explanationText,
        summary: summaryText,
        thread: threadText,
        filesChanged,
        timestamp,
        llmProvider: llmProvider || undefined,
        llmModel: llmModel || undefined,
        llmModelFamily: llmModelFamily || undefined
      }
      if (streamedThinking) updateRecord.thinking = streamedThinking
      if (llmUsage) updateRecord.usage = llmUsage
      if (tokensUsed) updateRecord.tokensUsed = tokensUsed
      if (costInfo) updateRecord.cost = costInfo

      const histResult = await freezr.create('appUpdates', updateRecord)
      const _id = histResult?._id || histResult?.id || null
      chatHistoryEntry = { ...updateRecord, _id }
    } catch (err) {
      console.warn('Could not record appUpdates entry:', err)
    }

    const fetches = [fetchAppHistory(appName)]
    if (hasFileChanges) fetches.push(fetchFolderTree(appName))

    const [history, fileTree] = await Promise.all(fetches)

    const assistantTimestamp = new Date().toISOString()

    const manifestFile = shouldUseStructuredResponse ? filesToSave.find((f) => f.path === 'manifest.json') : null
    let newManifestObject = null
    if (manifestFile) {
      try { newManifestObject = JSON.parse(manifestFile.content) } catch (e) { /* ignore parse errors */ }
    }

    setState((next) => {
      if (!next.chat) next.chat = {}
      next.chat.sending = false
      next.chat.messages = [
        ...(next.chat.messages || []),
        {
          role: 'assistant',
          content: rawResponse,
          timestamp: assistantTimestamp,
          parsedResponse: shouldUseStructuredResponse
            ? {
                explanation: parsed.explanation,
                files: [
                  ...parsed.files.map((f) => {
                    const warning = editWarnings.find(w => w.path === f.path)
                    return {
                      path: f.path,
                      action: warning ? 'edit_failed' : f.action,
                      rawContent: f.content,
                      error: warning?.error
                    }
                  }),
                  ...filesToSave
                    .filter(f => !parsed.files.some(pf => pf.path === f.path))
                    .map(f => ({ path: f.path, action: f.action }))
                ],
                summary: parsed.summary
              }
            : null,
          llmProvider: llmProvider || undefined,
          llmModel: llmModel || undefined,
          llmModelFamily: llmModelFamily || undefined,
          usage: llmUsage || undefined,
          tokensUsed: tokensUsed || undefined,
          cost: costInfo || undefined,
          thinking: streamedThinking || undefined
        }
      ]
      if (!next.index) next.index = {}
      next.index.history = history
      if (hasFileChanges) next.index.fileTree = fileTree
      if (!next.llm) next.llm = {}
      next.llm.projectCost = calculateProjectCost(history)
      if (!next.file) next.file = {}
      next.file.editorHistoryId = null
      next.file.editorFileUpdateId = null
      if (shouldUseStructuredResponse && next.file.openFilePath) {
        const modifiedFile = filesToSave.find((f) => f.path === next.file.openFilePath)
        if (modifiedFile) {
          next.file.openFileContent = modifiedFile.content
        }
      }
      return next
    }, { sourcePanel: 'all' })

    if (newManifestObject) {
      setManifestFromObject(appName, newManifestObject, setState)
    }
  } catch (error) {
    setState((next) => {
      if (!next.chat) next.chat = {}
      next.chat.sending = false
      next.chat.error = error?.message || 'Chat failed.'
      const msgs = next.chat.messages || []
      if (msgs.length > 0 && msgs[msgs.length - 1].role === 'user') {
        next.chat.lastFailedMessage = msgs[msgs.length - 1].content
        next.chat.messages = msgs.slice(0, -1)
      }
      return next
    })
  }
}
