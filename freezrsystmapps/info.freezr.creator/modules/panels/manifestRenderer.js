/* global freezr */
import { showError, clearError } from '../showError.js'
import { addHistoryEntry, updateHistoryEntry, fetchAppHistory } from '../historyActions.js'
import { fetchFolderTree } from '../fileTree.js'
import { calculateProjectCost } from '../priceService.js'
import { escHtml, updateAppFromFiles } from '../utils.js'

const MANIFEST_PATH = 'manifest.json'
const PERMISSION_TYPES_PATH = 'modules/panels/permissionTypes.json'
const PERMISSION_TYPES_FALLBACK = [
  { value: 'share_records', label: 'Share Records' },
  { value: 'read_all', label: 'Read All Records' },
  { value: 'write_all', label: 'Write All Records' },
  { value: 'write_own', label: 'Write Own Records' },
  { value: 'upload_pages', label: 'Upload Pages' },
  { value: 'use_llm', label: 'Use LLM' },
  { value: 'external_scripts', label: 'External Scripts' },
  { value: 'external_fetch', label: 'External Fetch' },
  { value: 'unsafe_eval', label: 'Unsafe Eval' },
  { value: 'use_serverless', label: 'Use Serverless' },
  { value: 'use_3pFunction', label: 'Use 3P Function' }
]
const TYPES_WITH_TABLE = new Set(['share_records', 'read_all', 'write_all', 'write_own'])
const formatTableIdPreview = (value) => escHtml(value || '').replace(/\./g, '.<wbr>')

const hasLogoInTree = (fileTree) => {
  if (!Array.isArray(fileTree)) return false
  const staticFolder = fileTree.find(n => n.type === 'folder' && n.name === 'static')
  if (!staticFolder || !staticFolder.children) return false
  return staticFolder.children.some(n => n.type === 'file' && (n.name === 'logo.png' || n.name === 'logo.svg'))
}

const defaultFields = () => ({
  display_name: '',
  description: ''
})

const defaultPermissionUi = () => ({
  name: '',
  type: 'read_all',
  targetApp: '',
  targetTable: '',
  table_id: ''
})

const deriveFields = (manifest) => ({
  display_name: manifest?.display_name || '',
  description: manifest?.description || ''
})

const splitTableId = (tableId) => {
  const value = String(tableId || '')
  const splitAt = value.lastIndexOf('.')
  if (splitAt <= 0 || splitAt >= value.length - 1) return { appName: '', tableName: '' }
  return {
    appName: value.slice(0, splitAt),
    tableName: value.slice(splitAt + 1)
  }
}

const mapPermissionToUi = (permission) => {
  const base = defaultPermissionUi()
  if (!permission || typeof permission !== 'object') return base
  const parsed = splitTableId(permission.table_id)
  return {
    name: permission.name || '',
    type: permission.type || base.type,
    targetApp: parsed.appName,
    targetTable: parsed.tableName,
    table_id: permission.table_id || ''
  }
}

const normalizePermissionTypes = (list) => {
  if (!Array.isArray(list)) return PERMISSION_TYPES_FALLBACK
  const normalized = list
    .map((entry) => ({
      value: String(entry?.value || '').trim(),
      label: String(entry?.label || '').trim()
    }))
    .filter((entry) => entry.value && entry.label)
  return normalized.length > 0 ? normalized : PERMISSION_TYPES_FALLBACK
}

const readManifest = async (appName) => {
  const url = '/creatorapi/read_app_file?app_name=' + encodeURIComponent(appName) + '&file_path=' + encodeURIComponent(MANIFEST_PATH)
  const result = await freezr.apiRequest('GET', url)
  if (!result || result.error) throw new Error(result?.error || 'Could not read manifest.json.')
  return result.content
}

const writeManifest = async (appName, content) => {
  const result = await freezr.apiRequest('POST', '/creatorapi/write_app_file', {
    app_name: appName,
    file_path: MANIFEST_PATH,
    content,
    action: 'upsert'
  })
  if (!result || result.error) throw new Error(result?.error || 'Could not save manifest.json.')
}

const setManifestState = (setState, updater, options = {}) => {
  setState((next) => {
    if (!next.project) next.project = {}
    if (!next.project.manifestEditor) next.project.manifestEditor = {}
    updater(next.project.manifestEditor, next)
    return next
  }, { sourcePanel: 'project', ...options })
}

const readPermissionTypes = async () => {
  try {
    const response = await fetch(PERMISSION_TYPES_PATH, { cache: 'no-store' })
    if (!response.ok) return PERMISSION_TYPES_FALLBACK
    const raw = await response.json()
    return normalizePermissionTypes(raw?.permissionTypes)
  } catch (error) {
    return PERMISSION_TYPES_FALLBACK
  }
}

const readAppTables = async (appName, currentAppName, currentManifestObject) => {
  if (!appName) return []
  if (appName === currentAppName && currentManifestObject) {
    return Object.keys(currentManifestObject.app_tables || {})
  }
  const raw = await readManifest(appName)
  const parsed = JSON.parse(raw)
  return Object.keys(parsed?.app_tables || {})
}

const getExistingAppNames = (state) => {
  const list = state.project?.existingApps || []
  return list
    .map((item) => (typeof item === 'string' ? item : item?.app_name))
    .filter(Boolean)
}

const applyManifestToState = (appName, parsed, setState) => {
  const fields = deriveFields(parsed)
  const permissions = Array.isArray(parsed.permissions) ? parsed.permissions.map(mapPermissionToUi) : []
  const appTablesByApp = { [appName]: Object.keys(parsed?.app_tables || {}) }
  setManifestState(setState, (editor) => {
    editor.loading = false
    editor.error = ''
    editor.loadedForApp = appName
    editor.manifestObject = parsed
    editor.fields = fields
    editor.permissionsUi = permissions
    editor.appTablesByApp = appTablesByApp
    editor.loadingTablesByApp = {}
    editor.saveStatus = ''
  })
}

export const loadManifestForApp = async (appName, setState) => {
  setManifestState(setState, (ed) => {
    ed.loading = true
    ed.error = ''
    ed.saveStatus = ''
  })

  try {
    const raw = await readManifest(appName)
    const parsed = JSON.parse(raw)
    applyManifestToState(appName, parsed, setState)
  } catch (error) {
    setManifestState(setState, (ed) => {
      ed.loading = false
      ed.error = error?.message || 'Could not load manifest.json.'
      ed.loadedForApp = appName
      ed.manifestObject = null
      ed.fields = defaultFields()
      ed.permissionsUi = []
      ed.appTablesByApp = {}
      ed.loadingTablesByApp = {}
      ed.saveStatus = ''
    })
    showError(error?.message || 'Could not load manifest.json.')
  }
}

export const setManifestFromObject = (appName, manifestObject, setState) => {
  applyManifestToState(appName, manifestObject, setState)
}

const recordManualFileUpdate = async (appName, content, existingFileUpdateId) => {
  const timestamp = new Date().toISOString()
  const data = { appName, path: 'manifest.json', action: 'upsert', content, timestamp }
  try {
    if (existingFileUpdateId) {
      await freezr.update('fileUpdates', existingFileUpdateId, data)
      return existingFileUpdateId
    }
    const result = await freezr.create('fileUpdates', data)
    return result?._id || result?.id || null
  } catch (error) {
    console.warn('Could not record fileUpdate:', error)
    return existingFileUpdateId || null
  }
}

const recordManualUpdate = async (appName, manifestContent, state, setState) => {
  const history = state.index?.history || []
  const lastEntry = history.length > 0 ? history[0] : null

  try {
    if (lastEntry && lastEntry.action === 'manual_update' && lastEntry._id) {
      const fileUpdateId = await recordManualFileUpdate(appName, manifestContent, lastEntry.fileUpdateId || null)
      const ok = await updateHistoryEntry(lastEntry._id, {
        summary: 'Manifest updated manually',
        filesChanged: ['manifest.json']
      })
      if (ok) {
        const updatedEntry = { ...lastEntry, timestamp: new Date().toISOString(), summary: 'Manifest updated manually', filesChanged: ['manifest.json'], fileUpdateId }
        setState((next) => {
          if (!next.index) next.index = {}
          const hist = next.index.history || []
          next.index.history = [updatedEntry, ...hist.slice(1)]
          return next
        }, { rerender: false })
        return updatedEntry
      }
    }

    const fileUpdateId = await recordManualFileUpdate(appName, manifestContent, null)
    const entry = await addHistoryEntry(appName, 'manual_update', {
      summary: 'Manifest updated manually',
      filesChanged: ['manifest.json'],
      fileUpdateId
    })
    if (entry) {
      setState((next) => {
        if (!next.index) next.index = {}
        next.index.history = [entry, ...(next.index.history || [])]
        return next
      }, { rerender: false })
    }
    return entry
  } catch (error) {
    console.warn('Could not record manual update:', error)
    return null
  }
}

export const renderManifestEditor = ({ container, state, getState, setState }) => {
  const appName = state.appName
  if (!appName) {
    container.innerHTML = ''
    return
  }

  const editor = state.project?.manifestEditor || {}
  const fields = editor.fields || defaultFields()
  const hasLoadedCurrent = editor.loadedForApp === appName
  const isLoading = Boolean(editor.loading)
  const isSaving = Boolean(editor.saving)
  const permissionsUi = Array.isArray(editor.permissionsUi) ? editor.permissionsUi : []
  const appTablesByApp = editor.appTablesByApp || {}
  const loadingTablesByApp = editor.loadingTablesByApp || {}
  const permissionTypeOptions = normalizePermissionTypes(editor.permissionTypeOptions)
  const existingAppNames = getExistingAppNames(state)
  const fileTree = state.index?.fileTree || []
  const history = state.index?.history || []
  const logoExists = hasLogoInTree(fileTree)
  const hasContent = Boolean(fields.description) || history.length > 0
  const showLogoButton = !logoExists && hasContent
  const isGeneratingLogo = Boolean(editor.generatingLogo)

  if (!editor.permissionTypeOptions && !editor.loadingPermissionTypes) {
    setManifestState(setState, (nextEditor) => {
      nextEditor.loadingPermissionTypes = true
    }, { rerender: false })
    readPermissionTypes().then((types) => {
      setManifestState(setState, (nextEditor) => {
        nextEditor.permissionTypeOptions = types
        nextEditor.loadingPermissionTypes = false
      })
    })
  }

  const appsToLoad = new Set()
  permissionsUi.forEach((permission) => {
    if (!permission) return
    if (!TYPES_WITH_TABLE.has(permission.type)) return
    const effectiveTargetApp = permission.type === 'share_records' ? appName : permission.targetApp
    if (!effectiveTargetApp) return
    if (Array.isArray(appTablesByApp[effectiveTargetApp])) return
    if (loadingTablesByApp[effectiveTargetApp]) return
    appsToLoad.add(effectiveTargetApp)
  })
  appsToLoad.forEach((appNameToLoad) => {
    setManifestState(setState, (nextEditor) => {
      if (!nextEditor.loadingTablesByApp) nextEditor.loadingTablesByApp = {}
      nextEditor.loadingTablesByApp[appNameToLoad] = true
    }, { rerender: false })

    readAppTables(appNameToLoad, appName, editor.manifestObject)
      .then((tableNames) => {
        setManifestState(setState, (nextEditor) => {
          if (!nextEditor.appTablesByApp) nextEditor.appTablesByApp = {}
          if (!nextEditor.loadingTablesByApp) nextEditor.loadingTablesByApp = {}
          nextEditor.appTablesByApp[appNameToLoad] = tableNames
          nextEditor.loadingTablesByApp[appNameToLoad] = false
        })
      })
      .catch(() => {
        setManifestState(setState, (nextEditor) => {
          if (!nextEditor.appTablesByApp) nextEditor.appTablesByApp = {}
          if (!nextEditor.loadingTablesByApp) nextEditor.loadingTablesByApp = {}
          nextEditor.appTablesByApp[appNameToLoad] = []
          nextEditor.loadingTablesByApp[appNameToLoad] = false
        })
      })
  })

  if (!hasLoadedCurrent || isLoading) {
    container.innerHTML = `
      <section class="panel-section">
        <h3>Manifest</h3>
        <p>Loading manifest.json...</p>
      </section>
    `
    return
  }

  if (editor.error) {
    container.innerHTML = `
      <section class="panel-section">
        <h3>Manifest</h3>
        <p>${escHtml(editor.error)}</p>
      </section>
    `
    return
  }

  container.innerHTML = `
    <section class="panel-section">
      <h3>App Info</h3>
      <div class="manifest-form-grid">
        <label class="manifest-field manifest-field-full">
          <span>App Display Name</span>
          <input type="text" data-manifest-field="display_name" value="${escHtml(fields.display_name)}">
        </label>
        <label class="manifest-field manifest-field-full">
          <span>App Description</span>
          <textarea rows="4" data-manifest-field="description">${escHtml(fields.description)}</textarea>
        </label>
      </div>
      <div class="manifest-actions">
        <button class="panel-cta panel-cta-sm" data-action="save-manifest" ${isSaving ? 'disabled' : ''}>Save Manifest</button>
        ${showLogoButton
          ? `<button class="panel-cta panel-cta-sm" data-action="generate-logo" ${isGeneratingLogo ? 'disabled' : ''}>${isGeneratingLogo ? 'Generating...' : 'Generate Logo'}</button>`
          : ''}
        <span class="manifest-save-status">${escHtml(editor.saveStatus || '')}</span>
      </div>
    </section>
    <section class="panel-section">
      <div class="manifest-section-header">
        <h3>App Permissions</h3>
        <span class="manifest-section-header-actions">
          ${permissionsUi.length > 0 ? `<a href="/account/app/settings/${encodeURIComponent(appName)}" target="_blank" class="panel-cta panel-cta-sm manifest-settings-link">Set Permissions ⚙️</a>` : ''}
          <button class="panel-cta panel-cta-sm" data-action="add-permission" title="Add permission">+</button>
        </span>
      </div>
      ${permissionsUi.length === 0
        ? ''
        : permissionsUi.map((permission, index) => {
            const type = permission?.type || ''
            const needsTable = TYPES_WITH_TABLE.has(type)
            const targetApp = type === 'share_records' ? appName : (permission?.targetApp || '')
            const tableOptions = Array.isArray(appTablesByApp[targetApp]) ? appTablesByApp[targetApp] : []
            const targetTable = permission?.targetTable || ''
            const tableId = permission?.table_id || ((targetApp && targetTable) ? `${targetApp}.${targetTable}` : '')
            return `
              <div class="manifest-permission-card" data-permission-index="${index}">
                <div class="manifest-form-grid">
                  <label class="manifest-field manifest-field-full">
                    <span>name</span>
                    <input type="text" data-permission-field="name" data-permission-index="${index}" value="${escHtml(permission?.name || '')}">
                  </label>
                  <label class="manifest-field manifest-field-full">
                    <span>type</span>
                    <select data-permission-field="type" data-permission-index="${index}">
                      ${permissionTypeOptions.map((option) => `
                        <option value="${escHtml(option.value)}" ${option.value === type ? 'selected' : ''}>${escHtml(option.label)}</option>
                      `).join('')}
                    </select>
                  </label>
                  ${needsTable && type !== 'share_records' ? `
                    <label class="manifest-field">
                      <span>app</span>
                      <select data-permission-field="targetApp" data-permission-index="${index}">
                        <option value="">Select app...</option>
                        ${existingAppNames.map((appEntry) => `
                          <option value="${escHtml(appEntry)}" ${appEntry === targetApp ? 'selected' : ''}>${escHtml(appEntry)}</option>
                        `).join('')}
                      </select>
                    </label>
                  ` : ''}
                  ${needsTable ? `
                    <label class="manifest-field">
                      <span>table</span>
                      <select data-permission-field="targetTable" data-permission-index="${index}" ${targetApp ? '' : 'disabled'}>
                        <option value="">${loadingTablesByApp[targetApp] ? 'Loading tables...' : 'Select table...'}</option>
                        ${tableOptions.map((tableName) => `
                          <option value="${escHtml(tableName)}" ${tableName === targetTable ? 'selected' : ''}>${escHtml(tableName)}</option>
                        `).join('')}
                      </select>
                    </label>
                    <label class="manifest-field manifest-field-full">
                      <span>table_id</span>
                      <div class="manifest-table-id-preview">${tableId ? formatTableIdPreview(tableId) : 'Will be generated from selected table'}</div>
                    </label>
                  ` : ''}
                </div>
              </div>
            `
          }).join('')}
      ${permissionsUi.length > 0 ? `
      <div class="manifest-actions">
        <button class="panel-cta panel-cta-sm" data-action="save-manifest" ${isSaving ? 'disabled' : ''}>Save Manifest</button>
        <span class="manifest-save-status">${escHtml(editor.saveStatus || '')}</span>
      </div>
      ` : ''}
    </section>
  `

  container.querySelectorAll('[data-manifest-field]').forEach((input) => {
    input.oninput = () => {
      const fieldName = input.dataset.manifestField
      if (!fieldName) return
      setManifestState(setState, (nextEditor) => {
        if (!nextEditor.fields) nextEditor.fields = defaultFields()
        nextEditor.fields[fieldName] = input.value
      }, { rerender: false })
    }
  })

  const addPermissionButton = container.querySelector('[data-action="add-permission"]')
  if (addPermissionButton) {
    addPermissionButton.onclick = () => {
      setManifestState(setState, (nextEditor) => {
        if (!Array.isArray(nextEditor.permissionsUi)) nextEditor.permissionsUi = []
        nextEditor.permissionsUi.push(defaultPermissionUi())
      })
    }
  }

  container.querySelectorAll('[data-permission-field="name"]').forEach((input) => {
    input.oninput = () => {
      const index = Number(input.dataset.permissionIndex)
      if (Number.isNaN(index)) return
      setManifestState(setState, (nextEditor) => {
        if (!Array.isArray(nextEditor.permissionsUi)) return
        if (!nextEditor.permissionsUi[index]) return
        nextEditor.permissionsUi[index].name = input.value
      }, { rerender: false })
    }
  })

  container.querySelectorAll('[data-permission-field="type"]').forEach((select) => {
    select.onchange = () => {
      const index = Number(select.dataset.permissionIndex)
      if (Number.isNaN(index)) return
      const selectedType = select.value
      setManifestState(setState, (nextEditor) => {
        if (!Array.isArray(nextEditor.permissionsUi)) return
        if (!nextEditor.permissionsUi[index]) return
        const target = nextEditor.permissionsUi[index]
        target.type = selectedType
        if (selectedType === 'share_records') {
          target.targetApp = appName
          target.targetTable = ''
          target.table_id = ''
        } else if (!TYPES_WITH_TABLE.has(selectedType)) {
          target.targetApp = ''
          target.targetTable = ''
          target.table_id = ''
        }
      })
    }
  })

  container.querySelectorAll('[data-permission-field="targetApp"]').forEach((select) => {
    select.onchange = () => {
      const index = Number(select.dataset.permissionIndex)
      if (Number.isNaN(index)) return
      const selectedApp = select.value
      setManifestState(setState, (nextEditor) => {
        if (!Array.isArray(nextEditor.permissionsUi)) return
        if (!nextEditor.permissionsUi[index]) return
        const target = nextEditor.permissionsUi[index]
        target.targetApp = selectedApp
        target.targetTable = ''
        target.table_id = ''
      })
    }
  })

  container.querySelectorAll('[data-permission-field="targetTable"]').forEach((select) => {
    select.onchange = () => {
      const index = Number(select.dataset.permissionIndex)
      if (Number.isNaN(index)) return
      const selectedTable = select.value
      const permission = permissionsUi[index] || defaultPermissionUi()
      const tableId = permission.targetApp && selectedTable ? `${permission.targetApp}.${selectedTable}` : ''
      setManifestState(setState, (nextEditor) => {
        if (!Array.isArray(nextEditor.permissionsUi)) return
        if (!nextEditor.permissionsUi[index]) return
        nextEditor.permissionsUi[index].targetTable = selectedTable
        nextEditor.permissionsUi[index].table_id = tableId
      })
    }
  })

  const saveManifest = async () => {
      clearError()
      const liveState = typeof getState === 'function' ? getState() : state
      const current = liveState.project?.manifestEditor || {}
      const sourceManifest = current.manifestObject || {}
      const currentFields = {
        display_name: current.fields?.display_name || '',
        description: current.fields?.description || ''
      }
      const sourcePermissions = Array.isArray(sourceManifest.permissions) ? sourceManifest.permissions : []
      const currentPermissions = Array.isArray(current.permissionsUi) ? current.permissionsUi : []
      const nextPermissions = currentPermissions.map((permission, index) => {
        const base = sourcePermissions[index] && typeof sourcePermissions[index] === 'object' ? sourcePermissions[index] : {}
        const name = permission?.name || ''
        const type = permission?.type || ''
        const targetApp = type === 'share_records' ? appName : (permission?.targetApp || '')
        const targetTable = permission?.targetTable || ''
        const tableId = TYPES_WITH_TABLE.has(type) && targetApp && targetTable ? `${targetApp}.${targetTable}` : ''
        const nextPermission = {
          ...base,
          name,
          type
        }
        if (TYPES_WITH_TABLE.has(type) && tableId) {
          nextPermission.table_id = tableId
        } else {
          delete nextPermission.table_id
        }
        return nextPermission
      })
      const nextManifest = {
        ...sourceManifest,
        display_name: currentFields.display_name,
        description: currentFields.description,
        permissions: nextPermissions
      }

      setManifestState(setState, (nextEditor) => {
        nextEditor.saving = true
        nextEditor.saveStatus = 'Saving...'
      })

      try {
        const content = JSON.stringify(nextManifest, null, 2) + '\n'
        await writeManifest(appName, content)
        await updateAppFromFiles(appName)

        const historyEntry = await recordManualUpdate(appName, content, liveState, setState)

        setManifestState(setState, (nextEditor, next) => {
          nextEditor.saving = false
          nextEditor.manifestObject = nextManifest
          nextEditor.fields = currentFields
          nextEditor.permissionsUi = currentPermissions
          nextEditor.saveStatus = 'Saved.'
          if (next.file?.openFilePath === MANIFEST_PATH) {
            next.file.openFileContent = content
          }
        })
        setTimeout(() => {
          setManifestState(setState, (nextEditor) => {
            if (nextEditor.saveStatus === 'Saved.') nextEditor.saveStatus = ''
          })
        }, 2500)
      } catch (error) {
        setManifestState(setState, (nextEditor) => {
          nextEditor.saving = false
          nextEditor.saveStatus = 'Save failed.'
        })
        showError(error?.message || 'Could not save manifest.json.')
      }
  }

  container.querySelectorAll('[data-action="save-manifest"]').forEach((button) => {
    button.onclick = saveManifest
  })

  const generateLogoBtn = container.querySelector('[data-action="generate-logo"]')
  if (generateLogoBtn) {
    generateLogoBtn.onclick = async () => {
      setManifestState(setState, (nextEditor) => { nextEditor.generatingLogo = true })

      try {
        const liveState = typeof getState === 'function' ? getState() : state
        const description = liveState.project?.manifestEditor?.fields?.description || ''
        const liveHistory = liveState.index?.history || []
        const firstChat = liveHistory.find(h => h.action === 'chat')
        const chatContext = firstChat?.thread || firstChat?.summary || ''

        const parts = ['Create a clean, modern app logo icon.']
        if (description) parts.push('The app is: ' + description)
        if (chatContext) parts.push('Context: ' + chatContext)
        parts.push('Make it simple, iconic, and recognizable. Use bold colors. No text in the logo.')

        const logoPrompt = parts.join(' ')
        console.log('Logo generation prompt:', logoPrompt)

        const imgOptions = { outputFormat: 'png' }
        if (liveState.llm?.provider) imgOptions.provider = liveState.llm.provider
        const result = await freezr.llm.generateImage(logoPrompt, imgOptions)
        if (!result?.success || !result.b64Data) {
          throw new Error(result?.error || 'Image generation returned no data.')
        }

        const binary = atob(result.b64Data)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        const blob = new Blob([bytes], { type: 'image/png' })
        const file = new File([blob], 'logo.png', { type: 'image/png' })

        const formData = new FormData()
        formData.append('file', file)
        formData.append('app_name', appName)
        formData.append('file_path', 'static/logo.png')
        const uploadResult = await freezr.apiRequest('POST', '/creatorapi/upload_app_file', formData, { uploadFile: true })
        if (!uploadResult || uploadResult.error) throw new Error(uploadResult?.error || 'Logo upload failed.')

        try {
          await updateAppFromFiles(appName)
        } catch (e) {
          console.warn('Could not re-install app after logo generation:', e)
        }

        await addHistoryEntry(appName, 'image_generation', {
          summary: 'Logo generated',
          filesChanged: ['static/logo.png'],
          llmProvider: result.meta?.provider || undefined,
          llmModel: result.meta?.model || undefined,
          tokensUsed: result.tokensUsed || undefined,
          cost: result.cost || undefined
        })

        const [newTree, history] = await Promise.all([
          fetchFolderTree(appName),
          fetchAppHistory(appName)
        ])

        setState((next) => {
          if (!next.index) next.index = {}
          next.index.fileTree = newTree
          next.index.history = history
          if (!next.llm) next.llm = {}
          next.llm.projectCost = calculateProjectCost(history)
          if (!next.file) next.file = {}
          if (!next.file.ui) next.file.ui = {}
          next.file.ui.visible = true
          next.file.openFilePath = 'static/logo.png'
          next.file.openFileContent = null
          next.file.openFolderPath = null
          next.file.historicalView = null
          next.file.compDiff = null
          next.file.editorDirty = false
          next.file.editorSaving = false
          next.file.editorSaveStatus = ''
          next.file.editorFileUpdateId = null
          return next
        }, { sourcePanel: 'file' })

        setManifestState(setState, (nextEditor) => {
          nextEditor.generatingLogo = false
          nextEditor.saveStatus = 'Logo generated.'
        })
        setTimeout(() => {
          setManifestState(setState, (nextEditor) => {
            if (nextEditor.saveStatus === 'Logo generated.') nextEditor.saveStatus = ''
          })
        }, 3000)
      } catch (error) {
        setManifestState(setState, (nextEditor) => {
          nextEditor.generatingLogo = false
          nextEditor.saveStatus = 'Logo failed.'
        })
        showError(error?.message || 'Could not generate logo.')
      }
    }
  }
}
