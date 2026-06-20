/* global freezr */
import { PROJECT_INSTRUCTIONS } from '../longTexts/projectInstructions.js'
import { createEditor } from '../editorLoader.js'
import { addHistoryEntry, updateHistoryEntry } from '../historyActions.js'
import { fetchFileContent, fetchFolderTree } from '../fileTree.js'
import { showError } from '../showError.js'
import { escHtml, saveFileToBackend, updateAppFromFiles, tsOf } from '../utils.js'

const extensionLanguage = (filePath) => {
  const ext = (filePath || '').split('.').pop().toLowerCase()
  const map = { js: 'javascript', mjs: 'javascript', css: 'css', html: 'html', json: 'json', md: 'markdown', txt: 'text' }
  return map[ext] || 'text'
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'])
const TEXT_EXTENSIONS = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'md', 'txt', 'svg', 'xml', 'csv', 'yaml', 'yml'])

const isImageFile = (filePath) => {
  const ext = (filePath || '').split('.').pop().toLowerCase()
  return IMAGE_EXTENSIONS.has(ext)
}

const isTextFile = (filePath) => {
  const ext = (filePath || '').split('.').pop().toLowerCase()
  return TEXT_EXTENSIONS.has(ext)
}

const rawFileUrl = (appName, filePath) =>
  '/app/info.freezr.creator/app2app/' + encodeURIComponent(appName) + '/' + filePath

const createEditorSession = () => ({
  editor: null,
  appName: null,
  filePath: null,
  autoSaveTimer: null,
  savedContent: null
})
let editorSession = createEditorSession()

const AUTO_SAVE_DELAY = 3000

export const flushEditorIfDirty = async () => {
  if (!editorSession.editor || !editorSession.appName || !editorSession.filePath) return
  const content = editorSession.editor.getContent()
  if (content === editorSession.savedContent) return
  if (editorSession.autoSaveTimer) {
    clearTimeout(editorSession.autoSaveTimer)
    editorSession.autoSaveTimer = null
  }
  await saveFileToBackend(editorSession.appName, editorSession.filePath, content)
  editorSession.savedContent = content
}

const destroyEditor = () => {
  if (editorSession.autoSaveTimer) {
    clearTimeout(editorSession.autoSaveTimer)
  }
  if (editorSession.editor) {
    editorSession.editor.destroy()
  }
  editorSession = createEditorSession()
}


const recordFileUpdate = async (appName, filePath, content, historyId) => {
  const timestamp = new Date().toISOString()
  const data = { appName, path: filePath, action: 'upsert', content, timestamp }
  if (historyId) data.historyId = historyId
  try {
    const result = await freezr.create('fileUpdates', data)
    return result?._id || result?.id || null
  } catch (error) {
    console.warn('Could not record fileUpdate:', error)
    return null
  }
}

const mergeFilesChanged = (existing, newPath) => {
  const set = new Set(existing || [])
  set.add(newPath)
  return [...set]
}

const findExistingEditHistoryId = (state) => {
  if (state.file?.editorHistoryId) return state.file.editorHistoryId
  const history = state.index?.history || []
  if (history.length > 0 && history[0].action === 'file_edit' && history[0]._id) {
    return history[0]._id
  }
  return null
}

const recordEditHistory = async (appName, filePath, content, state, setState) => {
  const existingHistoryId = findExistingEditHistoryId(state)

  try {
    if (existingHistoryId) {
      await recordFileUpdate(appName, filePath, content, existingHistoryId)

      const history = state.index?.history || []
      const existingEntry = history.find((e) => e._id === existingHistoryId)
      const mergedFiles = mergeFilesChanged(existingEntry?.filesChanged, filePath)
      const summary = mergedFiles.length === 1
        ? mergedFiles[0] + ' edited'
        : mergedFiles.length + ' files edited'

      await updateHistoryEntry(existingHistoryId, {
        summary,
        filesChanged: mergedFiles
      })

      setState((next) => {
        if (!next.file) next.file = {}
        next.file.editorHistoryId = existingHistoryId
        if (!next.index) next.index = {}
        const hist = next.index.history || []
        const idx = hist.findIndex((e) => e._id === existingHistoryId)
        if (idx >= 0) {
          hist[idx] = { ...hist[idx], summary, filesChanged: mergedFiles, timestamp: new Date().toISOString() }
          next.index.history = [...hist]
        }
      }, { rerender: false })
      return
    }

    const entry = await addHistoryEntry(appName, 'file_edit', {
      summary: filePath + ' edited',
      filesChanged: [filePath]
    })
    if (entry) {
      await recordFileUpdate(appName, filePath, content, entry._id)
      setState((next) => {
        if (!next.file) next.file = {}
        next.file.editorHistoryId = entry._id
        if (!next.index) next.index = {}
        next.index.history = [entry, ...(next.index.history || [])]
      }, { rerender: false })
    }
  } catch (error) {
    console.warn('Could not record edit history:', error)
  }
}

const saveFileFromEditor = async (appName, filePath, getState, setState) => {
  if (!editorSession.editor) return

  const content = editorSession.editor.getContent()
  if (content === editorSession.savedContent) return

  setState((next) => {
    if (!next.file) next.file = {}
    next.file.editorSaving = true
    next.file.editorSaveStatus = 'Saving...'
  }, { rerender: false })

  updateSaveStatusUI('Saving...', 'fp-status-saving')

  try {
    await saveFileToBackend(appName, filePath, content)

    try {
      await updateAppFromFiles(appName)
    } catch (err) {
      console.warn('Could not update app from files:', err)
    }

    const currentState = typeof getState === 'function' ? getState() : null
    if (currentState) {
      await recordEditHistory(appName, filePath, content, currentState, setState)
    }

    editorSession.savedContent = content

    setState((next) => {
      if (!next.file) next.file = {}
      next.file.editorSaving = false
      next.file.editorSaveStatus = 'Saved'
      next.file.editorDirty = false
      next.file.openFileContent = content
    }, { rerender: false })

    updateSaveStatusUI('Saved', 'fp-status-saved')
    updateDirtyDot(false)

    setTimeout(() => {
      updateSaveStatusUI('', '')
    }, 2500)
  } catch (error) {
    setState((next) => {
      if (!next.file) next.file = {}
      next.file.editorSaving = false
      next.file.editorSaveStatus = 'Save failed'
    }, { rerender: false })

    updateSaveStatusUI('Save failed', 'fp-status-error')
    console.warn('File save failed:', error)
  }
}

const updateSaveStatusUI = (text, className) => {
  const el = document.querySelector('.fp-save-status')
  if (!el) return
  el.textContent = text
  el.className = 'fp-save-status' + (className ? ' ' + className : '')
}

const updateDirtyDot = (dirty) => {
  const el = document.querySelector('.fp-dirty-dot')
  if (el) el.classList.toggle('fp-clean', !dirty)
  const saveBtn = document.querySelector('.fp-save-btn')
  const launchLink = document.querySelector('.fp-launch-link')
  if (saveBtn) saveBtn.hidden = !dirty
  if (launchLink) launchLink.hidden = dirty
}

const openPopup = (appName) => {
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

const computeLineDiff = (oldText, newText) => {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const result = []
  let oi = 0
  let ni = 0

  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      result.push({ type: 'same', text: oldLines[oi], oldNum: oi + 1, newNum: ni + 1 })
      oi++
      ni++
    } else {
      let foundMatch = false
      const lookAhead = Math.min(20, Math.max(oldLines.length - oi, newLines.length - ni))
      for (let d = 1; d <= lookAhead && !foundMatch; d++) {
        if (ni + d < newLines.length && oldLines[oi] === newLines[ni + d]) {
          for (let k = 0; k < d; k++) {
            result.push({ type: 'add', text: newLines[ni + k], newNum: ni + k + 1 })
          }
          ni += d
          foundMatch = true
        } else if (oi + d < oldLines.length && oldLines[oi + d] === newLines[ni]) {
          for (let k = 0; k < d; k++) {
            result.push({ type: 'remove', text: oldLines[oi + k], oldNum: oi + k + 1 })
          }
          oi += d
          foundMatch = true
        }
      }
      if (!foundMatch) {
        if (oi < oldLines.length) {
          result.push({ type: 'remove', text: oldLines[oi], oldNum: oi + 1 })
          oi++
        }
        if (ni < newLines.length) {
          result.push({ type: 'add', text: newLines[ni], newNum: ni + 1 })
          ni++
        }
      }
    }
  }
  return result
}

const renderDiffHtml = (diffLines) => {
  let hunkIdx = -1
  let prevWasChange = false
  return diffLines.map((line) => {
    const isChange = line.type === 'add' || line.type === 'remove'
    if (isChange && !prevWasChange) hunkIdx++
    prevWasChange = isChange
    const num = line.oldNum || line.newNum || ''
    const cls = line.type === 'add' ? 'fp-diff-add' : line.type === 'remove' ? 'fp-diff-remove' : 'fp-diff-same'
    const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '
    const hunkAttr = isChange ? ` data-hunk="${hunkIdx}"` : ''
    return `<div class="${cls}"${hunkAttr}><span class="fp-diff-num">${num}</span><span class="fp-diff-prefix">${prefix}</span>${escHtml(line.text)}</div>`
  }).join('')
}

const attachDiffNavigation = (container) => {
  const diffView = container.querySelector('.fp-diff-view')
  const scrollParent = container.querySelector('.fp-historical-body')
  const upBtn = container.querySelector('[data-action="diff-prev"]')
  const downBtn = container.querySelector('[data-action="diff-next"]')
  const counterEl = container.querySelector('.fp-diff-counter')
  if (!diffView || !scrollParent || !upBtn || !downBtn) return

  const firstElements = []
  const seen = new Set()
  diffView.querySelectorAll('[data-hunk]').forEach((el) => {
    const h = el.dataset.hunk
    if (!seen.has(h)) {
      seen.add(h)
      firstElements.push(el)
    }
  })

  const totalHunks = firstElements.length
  if (totalHunks === 0) {
    upBtn.disabled = true
    downBtn.disabled = true
    if (counterEl) counterEl.textContent = 'no changes'
    return
  }

  let currentIdx = -1

  const updateCounter = () => {
    if (counterEl) counterEl.textContent = `${currentIdx + 1}/${totalHunks}`
  }

  const scrollToHunk = (idx) => {
    if (idx < 0 || idx >= totalHunks) return
    currentIdx = idx
    firstElements[idx].scrollIntoView({ behavior: 'smooth', block: 'center' })
    updateCounter()
  }

  downBtn.onclick = () => scrollToHunk(currentIdx < totalHunks - 1 ? currentIdx + 1 : 0)
  upBtn.onclick = () => scrollToHunk(currentIdx > 0 ? currentIdx - 1 : totalHunks - 1)

  if (counterEl) counterEl.textContent = `${totalHunks} change${totalHunks !== 1 ? 's' : ''}`
}

const CURRENT_VERSION_ID = '__current__'

const fetchFileVersions = async (appName, filePath, history) => {
  const updates = await freezr.query('fileUpdates', { appName, path: filePath }, { sort: { _date_modified: -1 }, count: 100 })
  if (!updates || !Array.isArray(updates)) return []
  updates.sort((a, b) => tsOf(b) - tsOf(a))

  const historyMap = {}
  for (const e of (history || [])) {
    if (e.turnId) historyMap[e.turnId] = e
    if (e._id) historyMap[e._id] = e
  }

  return updates.map((u) => {
    const related = historyMap[u.historyId] || null
    return {
      id: u._id || u.id,
      timestamp: u.timestamp,
      content: u.content || '',
      label: related?.thread || related?.summary || (u.chatId ? 'Chat update' : 'Manual edit'),
      chatId: u.chatId || null,
      historyId: u.historyId || null
    }
  })
}

const formatVersionTs = (ts) => {
  if (!ts) return ''
  try {
    const d = new Date(ts)
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch (e) {
    return String(ts)
  }
}

export const openComp = async (appName, filePath, state, setState, preSelectHint) => {
  try {
    const [versions, currentContent] = await Promise.all([
      fetchFileVersions(appName, filePath, state.index?.history || []),
      // A deleted (externally removed) file has no live content — treat as empty
      // so the diff renders as a full removal rather than failing.
      fetchFileContent(appName, filePath).catch(() => '')
    ])

    let preSelectB = versions.length > 0 ? versions[0].id : null
    if (preSelectB && versions.length > 1 && versions[0].content === currentContent) {
      preSelectB = versions[1].id
    }
    if (preSelectHint?.chatId) {
      const match = versions.find((v) => v.chatId === preSelectHint.chatId)
      if (match) preSelectB = match.id
    } else if (preSelectHint?.content !== undefined) {
      const match = versions.find((v) => v.content === preSelectHint.content)
      if (match) preSelectB = match.id
    }

    setState((next) => {
      if (!next.file) next.file = {}
      next.file.compDiff = {
        filePath,
        versions,
        currentContent,
        preSelectA: CURRENT_VERSION_ID,
        preSelectB
      }
      return next
    }, { sourcePanel: 'file' })
  } catch (error) {
    console.warn('Could not open comparison:', error)
  }
}

const renderCompDiffView = ({ container, filePath, versions, currentContent, setState, preSelectA, preSelectB }) => {
  destroyEditor()

  const allVersions = [
    { id: CURRENT_VERSION_ID, timestamp: new Date().toISOString(), content: currentContent, label: 'Current file (live)' },
    ...versions
  ]

  let selectedA = preSelectA || CURRENT_VERSION_ID
  let selectedB = preSelectB || (versions.length > 0 ? versions[0].id : null)
  if (!allVersions.find((v) => v.id === selectedA)) selectedA = CURRENT_VERSION_ID
  if (!allVersions.find((v) => v.id === selectedB)) selectedB = versions.length > 0 ? versions[0].id : null

  const getVersion = (id) => allVersions.find((v) => v.id === id) || null

  container.innerHTML = `
    <div class="fp-editor-outer">
      <div class="fp-header">
        <h2>📄 ${escHtml(filePath)} <span class="fp-historical-badge">compare</span>
          <span class="fp-diff-nav fp-diff-nav-hidden">
            <button class="fp-diff-nav-btn" data-action="diff-prev" title="Previous change">▲</button>
            <button class="fp-diff-nav-btn" data-action="diff-next" title="Next change">▼</button>
            <span class="fp-diff-counter"></span>
          </span>
        </h2>
        <div class="fp-header-actions">
          <button class="panel-cta panel-cta-sm" data-action="toggle-picker">Comp</button>
          <button class="panel-cta panel-cta-sm" data-action="back">Back</button>
        </div>
      </div>
      <div class="fp-comp-picker"></div>
      <div class="fp-historical-body">
        <div class="fp-comp-placeholder">Select two versions and click Show Diff.</div>
      </div>
    </div>
  `

  const pickerEl = container.querySelector('.fp-comp-picker')
  const bodyEl = container.querySelector('.fp-historical-body')
  const navEl = container.querySelector('.fp-diff-nav')
  let pickerOpen = true

  const renderPicker = () => {
    if (!pickerOpen) {
      pickerEl.innerHTML = ''
      pickerEl.hidden = true
      return
    }
    pickerEl.hidden = false

    const rows = allVersions.map((v) => {
      const checked = (v.id === selectedA || v.id === selectedB) ? 'checked' : ''
      return `<label class="fp-comp-row">
        <input type="checkbox" data-vid="${escHtml(v.id)}" ${checked}>
        <span class="fp-comp-label">${escHtml(v.label)}</span>
        <span class="fp-comp-date">${escHtml(formatVersionTs(v.timestamp))}</span>
      </label>`
    }).join('')

    pickerEl.innerHTML = `
      <div class="fp-comp-picker-body">
        <div class="fp-comp-list">${rows}</div>
        <div class="fp-comp-actions">
          <button class="panel-cta panel-cta-sm" data-action="show-diff">Show Diff</button>
          <button class="panel-cta panel-cta-sm" data-action="cancel-picker">Cancel</button>
        </div>
      </div>
    `

    pickerEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.onchange = () => {
        const id = cb.dataset.vid
        if (cb.checked) {
          if (selectedA && selectedB) {
            selectedA = selectedB
            selectedB = id
          } else if (selectedA) {
            selectedB = id
          } else {
            selectedA = id
          }
        } else {
          if (id === selectedA) { selectedA = selectedB; selectedB = null }
          else if (id === selectedB) { selectedB = null }
        }
        pickerEl.querySelectorAll('input[type="checkbox"]').forEach((c) => {
          c.checked = (c.dataset.vid === selectedA || c.dataset.vid === selectedB)
        })
      }
    })

    pickerEl.querySelector('[data-action="show-diff"]').onclick = () => {
      if (!selectedA || !selectedB || selectedA === selectedB) return
      setState((next) => {
        if (next.file?.compDiff) {
          next.file.compDiff.preSelectA = selectedA
          next.file.compDiff.preSelectB = selectedB
        }
      }, { rerender: false })
      pickerOpen = false
      renderPicker()
      showDiff()
    }

    pickerEl.querySelector('[data-action="cancel-picker"]').onclick = () => {
      pickerOpen = false
      renderPicker()
    }
  }

  const showDiff = () => {
    const vA = getVersion(selectedA)
    const vB = getVersion(selectedB)
    if (!vA || !vB) return

    const scrollTop = bodyEl.scrollTop
    const diff = computeLineDiff(vB.content, vA.content)
    bodyEl.innerHTML = `<div class="fp-diff-view">${renderDiffHtml(diff)}</div>`
    bodyEl.scrollTop = scrollTop

    navEl.classList.remove('fp-diff-nav-hidden')
    attachDiffNavigation(container)
  }

  container.querySelector('[data-action="toggle-picker"]').onclick = () => {
    pickerOpen = !pickerOpen
    renderPicker()
  }

  container.querySelector('[data-action="back"]').onclick = () => {
    setState((next) => {
      if (!next.file) next.file = {}
      next.file.compDiff = null
      return next
    }, { sourcePanel: 'file' })
  }

  renderPicker()
}

const renderHistoricalView = ({ container, state, getState, setState, historicalView }) => {
  const appName = state.appName
  const { chatId, filePath, content } = historicalView

  destroyEditor()

  if (isImageFile(filePath) || !isTextFile(filePath)) {
    const bodyHtml = isImageFile(filePath)
      ? `<div class="fp-image-preview"><img src="${escHtml(rawFileUrl(appName, filePath))}" alt="${escHtml(filePath)}"></div>
         <p class="fp-binary-note">Binary files do not have historical comparison.</p>`
      : '<p class="fp-binary-note">This file type cannot be displayed.</p>'

    container.innerHTML = `
      <div class="fp-editor-outer">
        <div class="fp-header">
          <h2>${isImageFile(filePath) ? '🖼️' : '📄'} ${escHtml(filePath)} <span class="fp-historical-badge">historical</span></h2>
          <div class="fp-header-actions">
            <button class="panel-cta panel-cta-sm" data-action="show-current">Show Current File</button>
          </div>
        </div>
        <div class="fp-historical-body">${bodyHtml}</div>
      </div>
    `

    container.querySelector('[data-action="show-current"]').onclick = () => {
      setState((next) => {
        if (!next.file) next.file = {}
        if (!next.file.ui) next.file.ui = {}
        next.file.openFilePath = filePath
        next.file.openFileContent = null
        next.file.historicalView = null
        next.file.compDiff = null
        return next
      }, { sourcePanel: 'file' })
    }
    return
  }

  const lang = extensionLanguage(filePath)
  const bodyHtml = `<pre class="fp-code"><code class="language-${lang}">${escHtml(content)}</code></pre>`

  container.innerHTML = `
    <div class="fp-editor-outer">
      <div class="fp-header">
        <h2>📄 ${escHtml(filePath)} <span class="fp-historical-badge">historical</span></h2>
        <div class="fp-header-actions">
          <button class="panel-cta panel-cta-sm" data-action="comp">Comp</button>
          <button class="panel-cta panel-cta-sm" data-action="show-current">Show Current File</button>
        </div>
      </div>
      <div class="fp-historical-body">${bodyHtml}</div>
    </div>
  `

  container.querySelector('[data-action="comp"]').onclick = () => {
    openComp(appName, filePath, state, setState, { chatId, content })
  }

  container.querySelector('[data-action="show-current"]').onclick = async () => {
    try {
      const current = await fetchFileContent(appName, filePath)
      setState((next) => {
        if (!next.file) next.file = {}
        if (!next.file.ui) next.file.ui = {}
        next.file.openFilePath = filePath
        next.file.openFileContent = current
        next.file.historicalView = null
        next.file.compDiff = null
        next.file.editorDirty = false
        next.file.editorSaving = false
        next.file.editorSaveStatus = ''
        next.file.editorFileUpdateId = null
        return next
      }, { sourcePanel: 'file' })
    } catch (error) {
      console.warn('Could not fetch current file:', error)
    }
  }
}

export const renderFilePanel = ({ container, state, getState, setState }) => {
  const fileState = state.file || {}
  const appName = state.appName || null

  if (appName && fileState.compDiff) {
    renderCompDiffView({
      container,
      filePath: fileState.compDiff.filePath,
      versions: fileState.compDiff.versions,
      currentContent: fileState.compDiff.currentContent,
      setState,
      preSelectA: fileState.compDiff.preSelectA,
      preSelectB: fileState.compDiff.preSelectB
    })
    return
  }

  if (appName && fileState.historicalView) {
    renderHistoricalView({ container, state, getState, setState, historicalView: fileState.historicalView })
    return
  }

  if (appName && fileState.openFilePath) {
    const filePath = fileState.openFilePath

    if (isImageFile(filePath)) {
      destroyEditor()
      const imgSrc = rawFileUrl(appName, filePath)
      container.innerHTML = `
        <div class="fp-editor-outer">
          <div class="fp-header">
            <h2>🖼️ ${escHtml(filePath)}</h2>
            <div class="fp-header-actions">
              <a href="/app/${encodeURIComponent(appName)}" target="_blank" class="panel-cta panel-cta-sm fp-launch-link" data-action="launch-app">Launch App 🚀</a>
            </div>
          </div>
          <div class="fp-image-preview">
            <img src="${escHtml(imgSrc)}" alt="${escHtml(filePath)}">
          </div>
        </div>
      `
      const fpLaunchLink = container.querySelector('.fp-launch-link')
      if (fpLaunchLink) {
        fpLaunchLink.onclick = (e) => { e.preventDefault(); openPopup(appName) }
      }
      return
    }

    if (!isTextFile(filePath)) {
      destroyEditor()
      container.innerHTML = `
        <div class="fp-editor-outer">
          <div class="fp-header">
            <h2>📄 ${escHtml(filePath)}</h2>
            <div class="fp-header-actions">
              <a href="/app/${encodeURIComponent(appName)}" target="_blank" class="panel-cta panel-cta-sm fp-launch-link" data-action="launch-app">Launch App 🚀</a>
            </div>
          </div>
          <section class="panel-section">
            <p>This file type cannot be displayed in the editor.</p>
          </section>
        </div>
      `
      const fpLaunchLink = container.querySelector('.fp-launch-link')
      if (fpLaunchLink) {
        fpLaunchLink.onclick = (e) => { e.preventDefault(); openPopup(appName) }
      }
      return
    }

    const lang = extensionLanguage(filePath)
    const isDirty = fileState.editorDirty || false
    const saveStatus = fileState.editorSaveStatus || ''

    if (editorSession.appName === appName && editorSession.filePath === filePath && editorSession.editor) {
      if (fileState.openFileContent === editorSession.savedContent) return
    }

    destroyEditor()

    container.innerHTML = `
      <div class="fp-editor-outer">
        <div class="fp-header">
          <h2>📄 ${escHtml(filePath)}<span class="fp-dirty-dot ${isDirty ? '' : 'fp-clean'}"></span></h2>
          <div class="fp-header-actions">
            <span class="fp-save-status">${escHtml(saveStatus)}</span>
            <button class="panel-cta panel-cta-sm" data-action="comp">Comp</button>
            <button class="panel-cta panel-cta-sm fp-save-btn" data-action="save-file" ${isDirty ? '' : 'hidden'}>Save</button>
            <a href="/app/${encodeURIComponent(appName)}" target="_blank" class="panel-cta panel-cta-sm fp-launch-link" data-action="launch-app" ${isDirty ? 'hidden' : ''}>Launch App 🚀</a>
          </div>
        </div>
        <div class="fp-editor-wrap"></div>
      </div>
    `

    const fpSaveBtn = container.querySelector('.fp-save-btn')
    const fpLaunchLink = container.querySelector('.fp-launch-link')

    if (fpSaveBtn) {
      fpSaveBtn.onclick = () => {
        saveFileFromEditor(appName, filePath, getState, setState)
      }
    }
    if (fpLaunchLink) {
      fpLaunchLink.onclick = (e) => {
        e.preventDefault()
        openPopup(appName)
      }
    }

    container.querySelector('[data-action="comp"]').onclick = () => {
      openComp(appName, filePath, state, setState)
    }

    const editorWrap = container.querySelector('.fp-editor-wrap')
    const content = fileState.openFileContent || ''
    editorSession.savedContent = content
    editorSession.appName = appName
    editorSession.filePath = filePath

    createEditor(editorWrap, {
      content,
      language: lang,
      onChange: (newContent) => {
        const dirty = newContent !== editorSession.savedContent
        updateDirtyDot(dirty)

        setState((next) => {
          if (!next.file) next.file = {}
          next.file.editorDirty = dirty
        }, { rerender: false })

        if (editorSession.autoSaveTimer) clearTimeout(editorSession.autoSaveTimer)
        if (dirty) {
          editorSession.autoSaveTimer = setTimeout(() => {
            saveFileFromEditor(appName, filePath, getState, setState)
          }, AUTO_SAVE_DELAY)
        }
      }
    }).then((editor) => {
      editorSession.editor = editor
    }).catch((err) => {
      console.warn('Could not load editor:', err)
      editorWrap.innerHTML = `<pre class="fp-code"><code>${escHtml(content)}</code></pre>`
    })

    return
  }

  destroyEditor()

  if (appName && fileState.openFolderPath !== null && fileState.openFolderPath !== undefined) {
    const folderPath = fileState.openFolderPath
    const isRoot = folderPath === ''
    const folderLabel = isRoot ? '/ (root)' : folderPath
    const fileTree = state.index?.fileTree || []

    const findFolderChildren = (tree, targetPath) => {
      if (!targetPath) return tree
      const parts = targetPath.split('/')
      let current = tree
      for (const part of parts) {
        const folder = current.find(n => n.type === 'folder' && n.name === part)
        if (!folder || !folder.children) return []
        current = folder.children
      }
      return current
    }

    const children = findFolderChildren(fileTree, folderPath)
    const filesInFolder = children.filter(n => n.type === 'file')

    const fileListHtml = filesInFolder.length > 0
      ? filesInFolder.map((f) =>
        `<label class="fp-folder-file-row">
          <input type="checkbox" class="fp-file-check" data-file-path="${escHtml(f.path)}">
          <span class="fp-folder-file-name">${escHtml(f.name)}</span>
        </label>`
      ).join('')
      : '<p class="fp-folder-empty">No files in this folder.</p>'

    container.innerHTML = `
      <div class="fp-editor-outer">
        <div class="fp-header">
          <h2>📁 ${escHtml(folderLabel)}</h2>
          <div class="fp-header-actions">
            <button class="panel-cta panel-cta-sm" data-action="close-folder">Close</button>
            <a href="/app/${encodeURIComponent(appName)}" target="_blank" class="panel-cta panel-cta-sm fp-launch-link" data-action="launch-app">Launch App 🚀</a>
          </div>
        </div>
        <section class="panel-section">
          <div class="fp-folder-actions">
            <button class="panel-cta panel-cta-sm" data-action="upload-to-folder">Upload File</button>
            <input type="file" class="fp-folder-upload-input" style="display:none">
            <button class="panel-cta panel-cta-sm fp-delete-btn" data-action="delete-selected" disabled>Delete Selected</button>
            ${!isRoot ? '<button class="panel-cta panel-cta-sm fp-delete-btn" data-action="delete-folder">Delete Folder</button>' : ''}
            <span class="fp-folder-status"></span>
          </div>
          <div class="fp-folder-file-list">${fileListHtml}</div>
        </section>
      </div>
    `

    const launchLink = container.querySelector('.fp-launch-link')
    if (launchLink) {
      launchLink.onclick = (e) => { e.preventDefault(); openPopup(appName) }
    }

    container.querySelector('[data-action="close-folder"]').onclick = () => {
      setState((next) => {
        if (!next.file) next.file = {}
        next.file.openFolderPath = null
        return next
      })
    }

    const uploadBtn = container.querySelector('[data-action="upload-to-folder"]')
    const uploadInput = container.querySelector('.fp-folder-upload-input')
    const statusEl = container.querySelector('.fp-folder-status')
    const deleteBtn = container.querySelector('[data-action="delete-selected"]')

    const refreshFolder = async () => {
      const newTree = await fetchFolderTree(appName)
      setState((next) => {
        if (!next.index) next.index = {}
        next.index.fileTree = newTree
        return next
      }, { sourcePanel: 'index' })
    }

    if (uploadBtn && uploadInput) {
      uploadBtn.onclick = () => uploadInput.click()
      uploadInput.onchange = async () => {
        const file = uploadInput.files?.[0]
        if (!file) return
        const destPath = folderPath ? folderPath + '/' + file.name : file.name

        uploadBtn.disabled = true
        if (statusEl) statusEl.textContent = 'Uploading...'

        try {
          const formData = new FormData()
          formData.append('file', file)
          formData.append('app_name', appName)
          formData.append('file_path', destPath)

          const result = await freezr.apiRequest('POST', '/creatorapi/upload_app_file', formData, { uploadFile: true })
          if (!result || result.error) throw new Error(result?.error || 'Upload failed.')
          if (statusEl) statusEl.textContent = 'Uploaded.'
          await refreshFolder()
        } catch (error) {
          if (statusEl) statusEl.textContent = 'Upload failed.'
          showError(error?.message || 'Upload failed.')
        } finally {
          uploadBtn.disabled = false
          uploadInput.value = ''
        }
      }
    }

    const checkboxes = container.querySelectorAll('.fp-file-check')
    const updateDeleteBtn = () => {
      const anyChecked = [...checkboxes].some(cb => cb.checked)
      deleteBtn.disabled = !anyChecked
    }
    checkboxes.forEach(cb => { cb.onchange = updateDeleteBtn })

    if (deleteBtn) {
      deleteBtn.onclick = async () => {
        const selected = [...checkboxes].filter(cb => cb.checked).map(cb => cb.dataset.filePath)
        if (selected.length === 0) return
        if (!confirm('Delete ' + selected.length + ' file(s)?')) return

        deleteBtn.disabled = true
        if (statusEl) statusEl.textContent = 'Deleting...'

        try {
          for (const filePath of selected) {
            await saveFileToBackend(appName, filePath, '', 'delete')
          }
          if (statusEl) statusEl.textContent = 'Deleted.'
          await refreshFolder()
        } catch (error) {
          if (statusEl) statusEl.textContent = 'Delete failed.'
          showError(error?.message || 'Delete failed.')
        }
      }
    }

    const deleteFolderBtn = container.querySelector('[data-action="delete-folder"]')
    if (deleteFolderBtn) {
      deleteFolderBtn.onclick = async () => {
        if (!confirm('Delete folder "' + folderPath + '" and all its contents?')) return
        deleteFolderBtn.disabled = true
        if (statusEl) statusEl.textContent = 'Deleting folder...'

        try {
          await saveFileToBackend(appName, folderPath, '', 'delete_folder')
          setState((next) => {
            if (!next.file) next.file = {}
            next.file.openFolderPath = null
            return next
          })
          const newTree = await fetchFolderTree(appName)
          setState((next) => {
            if (!next.index) next.index = {}
            next.index.fileTree = newTree
            return next
          }, { sourcePanel: 'index' })
        } catch (error) {
          if (statusEl) statusEl.textContent = 'Delete failed.'
          showError(error?.message || 'Could not delete folder.')
        }
      }
    }

    return
  }

  if (appName) {
    container.innerHTML = `
      <h2>📄 File</h2>
      <section class="panel-section">
        <p>Select a file from the History panel to view it here.</p>
        <a href="/app/${encodeURIComponent(appName)}" target="_blank" class="panel-cta">Launch App 🚀</a>
      </section>
    `
    return
  }

  if (!fileState.instructions) {
    container.innerHTML = `
      <h2>📄 File</h2>
      <p>File instructions are hidden.</p>
    `
    return
  }

  container.innerHTML = `
    <h2>📄 File</h2>
    <section class="panel-section">
      <h3>Instructions</h3>
      <ul>
        ${PROJECT_INSTRUCTIONS.map((item) => `<li>${escHtml(item)}</li>`).join('')}
      </ul>
      <button class="panel-cta" data-action="hide-instructions">Hide Instructions</button>
    </section>
  `

  const hideButton = container.querySelector('[data-action="hide-instructions"]')
  if (hideButton) {
    hideButton.onclick = () => {
      setState((next) => {
        next.file.instructions = false
        return next
      })
    }
  }
}
