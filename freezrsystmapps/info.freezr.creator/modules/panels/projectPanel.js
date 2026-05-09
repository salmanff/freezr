/* global freezr, freezrMeta */
import { clearError, showError } from '../showError.js'
import { createInitialCreatorState } from '../initState.js'
import { fetchAppHistory, updateHistoryEntry, addHistoryEntry } from '../historyActions.js'
import { fetchFolderTree } from '../fileTree.js'
import { renderManifestEditor, loadManifestForApp } from './manifestRenderer.js'
import { calculateProjectCost, calculateEntryCost, formatCost, formatTokens } from '../priceService.js'
import { escHtml } from '../utils.js'
import { sendChatMessage } from '../chatService.js'

const ACCOUNT_RESOURCES_LINK = '/account/resources'
const formatAppNameForHeader = (name) => escHtml(name || 'Project').replace(/\./g, '.<wbr>')

const checkAppName = (appName) => {
  const value = (appName || '').trim()
  if (!value) return { ok: false, error: 'Enter an app name.' }
  if (value.length < 3) return { ok: false, error: 'App name must be at least 3 characters.' }
  if (value.indexOf('.') === -1) {
    if (!freezrMeta?.serverAddress || !freezrMeta?.userId) return { ok: false, error: 'Server address or user ID not found.' }
    let serverAddress = freezrMeta?.serverAddress.startsWith('http://localhost') ? 'local.host' : (freezrMeta?.serverAddress || '').replace(/^https?:\/\//, '')
    if (serverAddress.endsWith('/')) serverAddress = serverAddress.slice(0, -1)
    if (serverAddress.startsWith('www.')) serverAddress = serverAddress.slice(4)
    const reversedParts = serverAddress.split('.').reverse()
    const fullValue = reversedParts.join('.') + '.user.' + freezrMeta.userId + '.' + value
    if (validAppName(fullValue)) return { ok: true, value: fullValue, suggestion: fullValue }
    return { ok: false, suggestion: fullValue, error: 'Auto-expanded name (' + fullValue + ') is not valid.' }
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    return { ok: false, error: 'Use only letters, numbers, dots, underscores, or dashes.' }
  }
  return { ok: validAppName(value), value }
}

// same as config.js but isSystemApp replaced with explicit info.freezr check
const MAX_USER_NAME_LEN = 35
export const validFilename = (fn) => {
  if (!fn || typeof fn !== 'string') return false
  // Basic validation - no path separators, no null bytes, reasonable length
  if (fn.includes('/') || fn.includes('\\') || fn.includes('\0')) return false
  if (fn.length > 255 || fn.length < 1) return false
  // Check for valid characters (alphanumeric, dots, dashes, underscores, spaces)
  const validPattern = /^[a-zA-Z0-9._\-\s]+$/
  return validPattern.test(fn)
}
export const startsWithOneOf = (theText, stringArray) => {
  return stringArray.some(str => theText.startsWith(str))
}
const validAppName = (appName) => {
  if (!appName) return false
  if (appName.length < 1) return false
  if (appName.length > MAX_USER_NAME_LEN) return false
  if (!validFilename(appName)) return false
  if (startsWithOneOf(appName, ['.', '-', '\\', 'system'])) return false
  if ((appName.startsWith('info.freezr') || appName.startsWith('ceps.dev')) && !appName.startsWith('info.freezr.user.')) return false
  if (appName.includes('_')) return false
  if (appName.includes(' ')) return false
  if (appName.includes('$')) return false
  if (appName.includes('"')) return false
  if (appName.includes('/')) return false
  if (appName.includes('@')) return false
  if (appName.includes('\\')) return false
  if (appName.includes('{')) return false
  if (appName.includes('}')) return false
  if (appName.includes('..')) return false
  if (appName.endsWith('.')) return false

  const appSegments = appName.split('.')
  if (appSegments.length < 3) return false
  
  return true
}

const createApp = async (appName) => {
  const result = await freezr.apiRequest('POST', '/creatorapi/create_new_app', { app_name: appName })
  if (!result || result.error) {
    throw new Error(result?.error || 'Create app failed.')
  }
  try {
    const histResult = await freezr.create('appUpdates', { appName, action: 'created', timestamp: new Date().toISOString() })
    result._historyId = histResult?._id || histResult?.id || null
  } catch (err) {
    console.warn('Could not record appUpdates entry:', err)
  }
  return { success: true, appName: result.app_name || appName }
}

const setUrlAppParam = (appName) => {
  try {
    const url = new URL(window.location.href)
    if (appName) {
      url.searchParams.set('app', appName)
    } else {
      url.searchParams.delete('app')
    }
    window.history.replaceState(null, '', url.toString())
  } catch (e) { /* noop */ }
}

export const switchToAppChooser = async (setState, getState) => {
  clearError()
  setUrlAppParam(null)
  const currentTheme = getState?.()?.project?.ui?.theme || null
  setState((next) => {
    if (!next.loading) next.loading = {}
    next.loading.active = true
    next.loading.text = 'Resetting app state...'
    return next
  })

  try {
    const resetState = await createInitialCreatorState()
    if (currentTheme) resetState.project.ui.theme = currentTheme
    setState(resetState)
  } catch (error) {
    setState((next) => {
      if (!next.loading) next.loading = {}
      next.loading.active = false
      next.loading.text = ''
      return next
    })
    showError(error?.message || 'Could not reset app state.')
  }
}

export const loadApp = async (appName, setState) => {
  setState((next) => {
    if (!next.loading) next.loading = {}
    next.loading.active = true
    next.loading.text = `Loading app ${appName}...`
    return next
  })

  try {
    const [history, fileTree] = await Promise.all([
      fetchAppHistory(appName),
      fetchFolderTree(appName)
    ])
    const lastUpdate = history.length > 0 ? history[0] : null

    setUrlAppParam(appName)

    setState((next) => {
      if (!next.loading) next.loading = {}
      next.appName = appName
      next.project.mode = 'app'
      next.project.lastUpdate = lastUpdate
      if (!next.index) next.index = {}
      next.index.history = history
      next.index.fileTree = fileTree
      next.index.activeTab = 'history'
      if (!next.file) next.file = {}
      next.file.openFilePath = null
      next.file.openFileContent = null
      calculateAndStoreProjectCost(next, history)
      next.loading.active = false
      next.loading.text = ''
      activateAllPanels(next)
      return next
    })

    loadManifestForApp(appName, setState)
  } catch (error) {
    setState((next) => {
      if (!next.loading) next.loading = {}
      next.loading.active = false
      next.loading.text = ''
      return next
    })
    showError(error?.message || 'Could not load app.')
  }
}

const activateAllPanels = (next) => {
  const panelIds = ['project', 'index', 'chat', 'file']
  panelIds.forEach((panelId) => {
    if (!next[panelId]) next[panelId] = {}
    if (!next[panelId].ui) next[panelId].ui = {}
    next[panelId].ui.enabled = true
    next[panelId].ui.visible = panelId !== 'file'
  })
}

const getProviderModels = (providers, provider) => {
  if (!providers || !provider) return []
  return providers[provider] || []
}

const getFamiliesFromModels = (models) => {
  return [...new Set((models || []).map(m => m.family))]
}

const getStoredProjectCost = (state) => state.llm?.projectCost || null

const calculateAndStoreProjectCost = (next, history = next.index?.history || []) => {
  if (!next.llm) next.llm = {}
  next.llm.projectCost = calculateProjectCost(history)
}

const formatProjectCostEstimate = (projectCost) => {
  if (!projectCost) return 'Estimate: n/a'
  if (projectCost.pricedItems > 0) return 'Estimate: ' + formatCost({ totalCost: projectCost.totalCost })
  if (projectCost.unpricedItems > 0) return 'Estimate: no pricing'
  return 'Estimate: none yet'
}

const formatProjectCostDetails = (projectCost) => {
  if (!projectCost) return 'No history found.'
  if (projectCost.pricedItems === 0 && projectCost.unpricedItems === 0) {
    return 'No chat history with usage data.'
  }

  const parts = []
  parts.push(formatTokens(projectCost.totalTokens) + ' total tokens')
  if (projectCost.pricedItems > 0) {
    parts.push(formatCost({ totalCost: projectCost.totalCost }) + ' total cost')
    parts.push(projectCost.pricedItems + ' priced')
  }
  if (projectCost.unpricedItems > 0) {
    parts.push(projectCost.unpricedItems + ' without pricing')
  }
  return parts.join(' · ')
}

const renderLlmSettings = (state) => {
  const llm = state.llm || {}
  const expanded = llm.settingsExpanded || false
  const provider = llm.provider || 'Unknown'
  const model = llm.model || ''
  const cacheControl = llm.options?.cacheControl || false
  const maxTokens = llm.options?.maxTokens || ''
  const availableProviders = Object.keys(llm.providers || {})
  const providerModels = getProviderModels(llm.providers, provider)
  const models = getFamiliesFromModels(providerModels)

  const uniqueProviders = [...new Set(availableProviders)]
  const summaryLine = model ? (provider + ' / ' + model) : provider
  const fetchingPricing = llm.fetchingPricing || false
  const toolsExpanded = llm.toolsExpanded || false
  const projectCost = getStoredProjectCost(state) || calculateProjectCost(state.index?.history || [])
  const projectCostLabel = formatProjectCostEstimate(projectCost)
  const projectCostDetails = formatProjectCostDetails(projectCost)
  const pricingMetaForProvider = (llm.pricingMeta || {})[provider] || null
  const pricingLabel = pricingMetaForProvider?.lastUpdated
    ? `Updated ${new Date(pricingMetaForProvider.lastUpdated).toLocaleString()}${pricingMetaForProvider.refreshNeeded ? ' · refresh recommended' : ''}`
    : (providerModels.length > 0 ? 'No pricing cached yet' : '')

  const providerOptions = uniqueProviders.map(p =>
    `<option value="${escHtml(p)}" ${p === provider ? 'selected' : ''}>${escHtml(p)}</option>`
  ).join('')

  const modelOptions = fetchingPricing
    ? '<option value="" disabled selected>Loading models…</option>'
    : [
        '<option value="" ' + (!model ? 'selected' : '') + '>Use provider default</option>',
        ...models.map(m =>
          `<option value="${escHtml(m)}" ${m === model ? 'selected' : ''}>${escHtml(m)}</option>`
        )
      ].join('')

  const expandedHtml = expanded ? `
    <div class="llm-settings-body">
      <div class="llm-settings-row">
        <label>Provider</label>
        <select id="llmProviderSelect">${providerOptions}</select>
      </div>
      <div class="llm-settings-row">
        <label>Model</label>
        <select id="llmModelSelect" ${fetchingPricing ? 'disabled' : ''}>${modelOptions}</select>
      </div>
      <div class="llm-settings-row">
        <label>Max tokens</label>
        <input type="number" id="llmMaxTokens" placeholder="Default" value="${escHtml(String(maxTokens))}" min="1" step="1">
      </div>
      <label class="llm-checkbox-label">
        <input type="checkbox" id="llmCacheControl" ${cacheControl ? 'checked' : ''}>
        <span>Use cache control</span>
      </label>
      <div class="llm-settings-actions-row">
        ${pricingLabel ? `<span class="llm-settings-note">${escHtml(pricingLabel)}</span>` : '<span class="llm-settings-note"></span>'}
        <button class="panel-cta panel-cta-sm llm-settings-tools-toggle" data-action="toggle-llm-tools">${toolsExpanded ? 'Hide Tools' : 'Show Tools'}</button>
        ${toolsExpanded ? `
          <button class="panel-cta panel-cta-sm" data-action="refresh-pricing">Refresh Pricing</button>
          <button class="panel-cta panel-cta-sm" data-action="calculate-project-cost">Refresh Cost</button>
        ` : ''}
      </div>
      <div id="llmProjectCostResult" class="llm-cost-result">${escHtml(projectCostDetails)}</div>
    </div>
  ` : ''

  return `
    <div class="llm-settings-section">
      <div class="llm-settings-header" data-action="toggle-llm-settings">
        <span class="llm-settings-heading">
          <span class="llm-settings-toggle">${expanded ? '▼' : '▶'}</span>
          <span class="llm-settings-summary">LLM: ${escHtml(summaryLine)}</span>
        </span>
        <span class="llm-settings-estimate">${escHtml(projectCostLabel)}</span>
      </div>
      ${expandedHtml}
    </div>
  `
}

const bindLlmSettingsEvents = (container, state, setState) => {
  const toggleHeader = container.querySelector('[data-action="toggle-llm-settings"]')
  if (toggleHeader) {
    toggleHeader.onclick = () => {
      setState((next) => {
        if (!next.llm) next.llm = {}
        next.llm.settingsExpanded = !next.llm.settingsExpanded
        return next
      }, { sourcePanel: 'project' })
    }
  }

  const toggleToolsButton = container.querySelector('[data-action="toggle-llm-tools"]')
  if (toggleToolsButton) {
    toggleToolsButton.onclick = (event) => {
      event.stopPropagation()
      setState((next) => {
        if (!next.llm) next.llm = {}
        next.llm.toolsExpanded = !next.llm.toolsExpanded
        return next
      }, { sourcePanel: 'project' })
    }
  }

  const providerSelect = container.querySelector('#llmProviderSelect')
  if (providerSelect) {
    providerSelect.onchange = async () => {
      const newProvider = providerSelect.value

      setState((next) => {
        if (!next.llm) next.llm = {}
        next.llm.provider = newProvider
        next.llm.fetchingPricing = true
        next.llm.model = ''
        return next
      }, { sourcePanel: 'project' })

      try {
        let pingResult = await freezr.llm.ping({ provider: newProvider })
        const providerMeta = pingResult?.pricingMeta?.[newProvider]
        if (providerMeta?.refreshNeeded) {
          pingResult = await freezr.llm.ping({ provider: newProvider, refresh: true })
        }
        setState((next) => {
          if (!next.llm) next.llm = {}
          next.llm.provider = newProvider
          next.llm.providers = pingResult?.providers || next.llm.providers || {}
          next.llm.pricingMeta = pingResult?.pricingMeta || next.llm.pricingMeta || {}
          next.llm.model = ''
          next.llm.fetchingPricing = false
          return next
        }, { sourcePanel: 'project' })
      } catch (e) {
        console.warn('Could not fetch pricing for ' + newProvider + ':', e)
        setState((next) => {
          if (!next.llm) next.llm = {}
          next.llm.fetchingPricing = false
          return next
        }, { sourcePanel: 'project' })
      }
      clearError()
    }
  }

  const modelSelect = container.querySelector('#llmModelSelect')
  if (modelSelect) {
    modelSelect.onchange = () => {
      setState((next) => {
        if (!next.llm) next.llm = {}
        next.llm.model = modelSelect.value
        return next
      }, { sourcePanel: 'project' })
    }
  }

  const cacheCheckbox = container.querySelector('#llmCacheControl')
  if (cacheCheckbox) {
    cacheCheckbox.onchange = () => {
      setState((next) => {
        if (!next.llm) next.llm = {}
        if (!next.llm.options) next.llm.options = {}
        next.llm.options.cacheControl = cacheCheckbox.checked
        return next
      }, { rerender: false })
    }
  }

  const maxTokensInput = container.querySelector('#llmMaxTokens')
  if (maxTokensInput) {
    maxTokensInput.onchange = () => {
      const val = maxTokensInput.value ? parseInt(maxTokensInput.value, 10) : null
      setState((next) => {
        if (!next.llm) next.llm = {}
        if (!next.llm.options) next.llm.options = {}
        next.llm.options.maxTokens = (val && val > 0) ? val : null
        return next
      }, { rerender: false })
    }
  }

  const refreshBtn = container.querySelector('[data-action="refresh-pricing"]')
  if (refreshBtn) {
    refreshBtn.onclick = async () => {
      const currentProvider = state.llm?.provider
      refreshBtn.disabled = true
      refreshBtn.textContent = 'Refreshing...'
      try {
        const pingResult = await freezr.llm.ping({ provider: currentProvider, refresh: true })
        setState((next) => {
          if (!next.llm) next.llm = {}
          next.llm.providers = pingResult?.providers || next.llm.providers || {}
          next.llm.pricingMeta = pingResult?.pricingMeta || next.llm.pricingMeta || {}
          return next
        }, { sourcePanel: 'project' })
      } catch (e) {
        showError('Failed to refresh pricing: ' + (e.message || e))
      } finally {
        refreshBtn.disabled = false
        refreshBtn.textContent = 'Refresh Pricing'
      }
    }
  }

  const calcCostBtn = container.querySelector('[data-action="calculate-project-cost"]')
  if (calcCostBtn) {
    calcCostBtn.onclick = async () => {
      const appName = state.appName
      if (!appName) return
      const resultDiv = container.querySelector('#llmProjectCostResult')
      if (!resultDiv) return

      calcCostBtn.disabled = true
      calcCostBtn.textContent = 'Fetching history...'
      resultDiv.innerHTML = ''

      try {
        const fullHistory = await fetchAppHistory(appName, { count: 10000 })

        calcCostBtn.textContent = 'Recalculating costs...'
        const costUpdates = []
        for (const entry of fullHistory) {
          if (entry.action !== 'chat' || entry.cost || !entry._id) continue
          const recalculated = calculateEntryCost(entry, { recalculateFromTokens: true })
          if (recalculated) {
            costUpdates.push({ id: entry._id, cost: recalculated })
            entry.cost = recalculated
          }
        }

        if (costUpdates.length > 0) {
          calcCostBtn.textContent = 'Saving recalculated costs...'
          for (const update of costUpdates) {
            await updateHistoryEntry(update.id, { cost: update.cost }, { preserveTimestamp: true })
          }
        }

        const result = calculateProjectCost(fullHistory)
        setState((next) => {
          if (!next.index) next.index = {}
          next.index.history = fullHistory
          calculateAndStoreProjectCost(next, fullHistory)
          return next
        }, { sourcePanel: 'all' })

        resultDiv.textContent = formatProjectCostDetails(result)
      } catch (e) {
        resultDiv.textContent = 'Error: ' + (e.message || 'Could not fetch history')
      } finally {
        calcCostBtn.disabled = false
        calcCostBtn.textContent = 'Refresh Cost'
      }
    }
  }
}

const renameApp = async (oldAppName, newAppName, setState, options = {}) => {
  const body = {
    old_app_name: oldAppName,
    new_app_name: newAppName,
    delete_data: options.deleteData || false,
    confirmed: options.confirmed || false
  }
  const result = await freezr.apiRequest('POST', '/creatorapi/rename_app', body)
  if (!result || result.error) {
    throw new Error(result?.error || 'Rename failed.')
  }
  return result
}

const fetchPublishedVersions = async (appName, setState, manifestVersion) => {
  setState((next) => {
    if (!next) next = {}
    if (!next.project) next.project = {}
    if (!next.project.appSettings) next.project.appSettings = {}
    next.project.appSettings.publishLoading = true
    return next
  }, { rerender: false })
  try {
    const result = await freezr.apiRequest('GET', '/creatorapi/published_versions?app_name=' + encodeURIComponent(appName))
    const versions = (result && result.versions) || []
    const latestPublished = versions.find(v => v.isLatest)
    const needsVersionBump = latestPublished && manifestVersion && compareVersionsFrontend(manifestVersion, latestPublished.version) <= 0
    setState((next) => {
      if (!next) next = {}
      if (!next.project) next.project = {}
      if (!next.project.appSettings) next.project.appSettings = {}
      next.project.appSettings.publishedVersions = versions
      next.project.appSettings.publishFetched = true
      next.project.appSettings.publishLoading = false
      next.project.appSettings.needsVersionBump = needsVersionBump
      next.project.appSettings.latestPublishedVersion = latestPublished ? latestPublished.version : null
      if (needsVersionBump) {
        next.project.appSettings.suggestedVersion = incrementVersion(latestPublished.version)
      }
      return next
    }, { sourcePanel: 'project' })
  } catch (e) {
    setState((next) => {
      if (!next) next = {}
      if (!next.project) next.project = {}
      if (!next.project.appSettings) next.project.appSettings = {}
      next.project.appSettings.publishFetched = true
      next.project.appSettings.publishLoading = false
      next.project.appSettings.publishedVersions = []
      return next
    }, { sourcePanel: 'project' })
  }
}

const compareVersionsFrontend = (a, b) => {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0
    const nb = pb[i] || 0
    if (na !== nb) return na - nb
  }
  return 0
}

const incrementVersion = (version) => {
  const parts = String(version).split('.')
  const last = parseInt(parts[parts.length - 1] || '0', 10)
  parts[parts.length - 1] = String(last + 1).padStart(parts[parts.length - 1].length, '0')
  return parts.join('.')
}

const bindPublishEvents = (container, state, setState, appName) => {
  const publishBtn = container.querySelector('[data-action="publish-app"]')
  if (publishBtn) {
    publishBtn.onclick = async () => {
      clearError()
      const manifestObj = state.project?.manifestEditor?.manifestObject || {}
      const manifestVersion = manifestObj.version || '0.01'
      const appSettings = state.project?.appSettings || {}
      const versionInput = container.querySelector('#publishVersionInput')

      let version = appSettings.needsVersionBump
        ? (versionInput?.value || '').trim()
        : manifestVersion

      const releaseNotesInput = container.querySelector('#publishReleaseNotes')
      const releaseNotes = (releaseNotesInput?.value || '').trim()

      if (!version) {
        showError('Version is required.')
        return
      }

      // Update manifest if version or app_url changed
      const appUrl = (freezrMeta.serverAddress || '') + '/@' + freezrMeta.userId + '/app/' + appName
      const needsManifestSave = version !== manifestVersion || manifestObj.app_url !== appUrl

      if (needsManifestSave) {
        setState((next) => {
          if (!next.project.appSettings) next.project.appSettings = {}
          next.project.appSettings.publishStatus = 'Updating manifest before publish...'
          next.project.appSettings.publishBusy = true
          return next
        }, { sourcePanel: 'project' })

        try {
          const updatedManifest = { ...manifestObj, version, app_url: appUrl }
          const saveResult = await freezr.apiRequest('POST', '/creatorapi/write_app_file', {
            app_name: appName,
            file_path: 'manifest.json',
            content: JSON.stringify(updatedManifest, null, 2)
          })
          if (!saveResult || saveResult.error) throw new Error(saveResult?.error || 'Could not save manifest.')
          setState((next) => {
            if (next.project?.manifestEditor) {
              next.project.manifestEditor.manifestObject = updatedManifest
            }
            return next
          }, { rerender: false })
          if (version !== manifestVersion) {
            addHistoryEntry(appName, 'manual_update', {
              summary: 'Version bumped to ' + version + ' (for publish)',
              filesChanged: ['manifest.json']
            })
          }
        } catch (error) {
          setState((next) => {
            if (!next.project.appSettings) next.project.appSettings = {}
            next.project.appSettings.publishStatus = ''
            next.project.appSettings.publishBusy = false
            return next
          }, { sourcePanel: 'project' })
          showError(error?.message || 'Could not update manifest.')
          return
        }
      }

      setState((next) => {
        if (!next.project.appSettings) next.project.appSettings = {}
        next.project.appSettings.publishBusy = true
        return next
      }, { sourcePanel: 'project' })

      try {
        const result = await freezr.apiRequest('POST', '/creatorapi/publish_app', {
          app_name: appName,
          version,
          release_notes: releaseNotes
        })
        if (!result || result.error) throw new Error(result?.error || 'Publish failed.')

        setState((next) => {
          if (!next.project.appSettings) next.project.appSettings = {}
          next.project.appSettings.publishBusy = false
          next.project.appSettings.publishFetched = false
          next.project.appSettings.needsVersionBump = false
          next.project.appSettings.lastPublishResult = result
          return next
        }, { sourcePanel: 'project' })

        fetchPublishedVersions(appName, setState, version)
      } catch (error) {
        setState((next) => {
          if (!next.project.appSettings) next.project.appSettings = {}
          next.project.appSettings.publishBusy = false
          next.project.appSettings.publishStatus = ''
          return next
        }, { sourcePanel: 'project' })
        showError(error?.message || 'Could not publish app.')
      }
    }
  }

  const unpublishBtns = container.querySelectorAll('[data-action="unpublish-version"]')
  unpublishBtns.forEach(btn => {
    btn.onclick = async () => {
      clearError()
      const version = btn.dataset.version
      if (!window.confirm('Unpublish version ' + version + '?')) return

      try {
        const result = await freezr.apiRequest('POST', '/creatorapi/unpublish_app', {
          app_name: appName,
          version
        })
        if (!result || result.error) throw new Error(result?.error || 'Unpublish failed.')

        setState((next) => {
          if (!next.project.appSettings) next.project.appSettings = {}
          next.project.appSettings.publishFetched = false
          next.project.appSettings.publishStatus = 'Unpublished v' + version
          next.project.appSettings.lastPublishResult = null
          return next
        }, { sourcePanel: 'project' })

        const mv = state.project?.manifestEditor?.manifestObject?.version || '0.01'
        fetchPublishedVersions(appName, setState, mv)
      } catch (error) {
        showError(error?.message || 'Could not unpublish version.')
      }
    }
  })
}

const bindRenameEvents = (container, state, setState) => {
  const renameBtn = container.querySelector('[data-action="rename-app"]')
  const renameInput = container.querySelector('#renameAppInput')
  if (!renameBtn || !renameInput) return

  const doRename = async () => {
    clearError()
    const rawName = (renameInput.value || '').trim()
    const oldName = state.appName

    if (!rawName || !oldName) return

    const nameCheck = checkAppName(rawName)
    if (!nameCheck.ok) {
      if (nameCheck.suggestion) {
        renameInput.value = nameCheck.suggestion
        showError('App name needs a domain prefix. We filled in the full name — click Rename again to confirm.')
      } else {
        showError(nameCheck.error || 'Invalid app name.')
      }
      return
    }

    setState((next) => {
      if (!next.project.appSettings) next.project.appSettings = {}
      next.project.appSettings.renameText = rawName
      next.project.appSettings.renameStatus = 'Checking...'
      return next
    }, { sourcePanel: 'project' })

    try {
      // Phase 1: pre-confirmation check
      const preCheck = await renameApp(oldName, nameCheck.value, setState, { confirmed: false })

      if (preCheck.needs_confirmation) {
        let msg = 'Rename "' + oldName + '" to "' + nameCheck.value + '"?'
        if (preCheck.has_granted_permissions) {
          msg += '\n\nWarning: This app has granted permissions that will be removed. You will need to re-grant them in the account settings page after renaming.'
        }
        msg += '\n\nNote: App data (database collections and user files) will NOT be carried over to the renamed app.'

        if (!window.confirm(msg)) {
          setState((next) => {
            if (!next.project.appSettings) next.project.appSettings = {}
            next.project.appSettings.renameStatus = ''
            return next
          }, { sourcePanel: 'project' })
          return
        }
      }

      // Phase 2: confirmed rename
      setState((next) => {
        if (!next.project.appSettings) next.project.appSettings = {}
        next.project.appSettings.renameStatus = 'Renaming...'
        return next
      }, { sourcePanel: 'project' })

      const result = await renameApp(oldName, nameCheck.value, setState, { confirmed: true, deleteData: false })

      if (result.success) {
        const warning = result.warning || null
        setState((next) => {
          if (!next.project.appSettings) next.project.appSettings = {}
          next.project.appSettings.renameStatus = ''
          next.project.appSettings.renameText = ''
          return next
        }, { rerender: false })

        if (warning) {
          showError(warning)
        }

        loadApp(result.new_app_name, setState)
      } else {
        throw new Error('Rename did not return success.')
      }
    } catch (error) {
      setState((next) => {
        if (!next.project.appSettings) next.project.appSettings = {}
        next.project.appSettings.renameStatus = ''
        return next
      }, { sourcePanel: 'project' })
      showError(error?.message || 'Could not rename app.')
    }
  }

  renameBtn.onclick = doRename
  renameInput.onkeydown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      doRename()
    }
  }
}

const deleteChatHistory = async (appName) => {
  const errors = []
  try {
    await freezr.delete('appUpdates', { appName })
  } catch (e) {
    errors.push('appUpdates: ' + (e.message || e))
  }
  try {
    await freezr.delete('fileUpdates', { appName })
  } catch (e) {
    errors.push('fileUpdates: ' + (e.message || e))
  }
  if (errors.length > 0) throw new Error(errors.join('; '))
}

const bindDeleteEvents = (container, state, setState, getState) => {
  const appName = state.appName
  if (!appName) return
  const shortName = appName.split('.').pop()

  const confirmInput = container.querySelector('#deleteConfirmInput')
  const statusDiv = container.querySelector('#deleteStatus')

  const showDeleteStatus = (text) => {
    if (!statusDiv) return
    statusDiv.textContent = text
    statusDiv.style.display = text ? '' : 'none'
  }

  const checkConfirmation = () => {
    if (!confirmInput) return false
    const typed = (confirmInput.value || '').trim()
    if (typed !== shortName) {
      showDeleteStatus('Please type "' + shortName + '" to confirm.')
      return false
    }
    return true
  }

  const deleteChatBtn = container.querySelector('[data-action="delete-chat-history"]')
  if (deleteChatBtn) {
    deleteChatBtn.onclick = async () => {
      clearError()
      if (!checkConfirmation()) return
      if (!window.confirm('Delete ALL chat history and file update records for "' + appName + '"? This cannot be undone.')) return

      deleteChatBtn.disabled = true
      showDeleteStatus('Deleting chat history...')
      try {
        await deleteChatHistory(appName)
      } catch (e) {
        showError(e.message || 'Could not delete chat history.')
      }
      await switchToAppChooser(setState, getState)
    }
  }

  const deleteAppBtn = container.querySelector('[data-action="delete-app-and-history"]')
  if (deleteAppBtn) {
    deleteAppBtn.onclick = async () => {
      clearError()
      if (!checkConfirmation()) return
      if (!window.confirm('Delete the app "' + appName + '" AND all its chat history? This will remove all app files, data, and creator records. This cannot be undone.')) return

      deleteAppBtn.disabled = true
      showDeleteStatus('Deleting chat history...')
      try {
        await deleteChatHistory(appName)
      } catch (e) {
        showError(e.message || 'Could not delete chat history.')
      }
      showDeleteStatus('Deleting app...')
      try {
        const ret = await freezr.apiRequest('POST', '/acctapi/appMgmtActions', {
          action: 'deleteApp', app_name: appName
        })
        if (ret?.error) throw new Error(ret.error)
      } catch (e) {
        showError(e.message || 'Could not delete app.')
      }
      await switchToAppChooser(setState, getState)
    }
  }
}

export const renderProjectPanel = ({ container, state, getState, setState }) => {
  const project = state.project || {}
  const ui = project.ui || {}
  const appName = state.appName || ''
  const projectMode = project.mode || 'choose'
  const isDark = ui.theme !== 'light'

  if (!project.llmAvailable) {
    container.innerHTML = `
      <h2 class="welcome-title">App Creator</h2>
      <div class="panel-note panel-note-warning llm-unavailable-notice">
        <p class="llm-unavailable-main">To use App Creator, you need to have registered an LLM API key.</p>
        <p>This could also be a temporary server issue — feel free to try again later, or
          <a href="${ACCOUNT_RESOURCES_LINK}" target="_blank" rel="noreferrer">go to Account Resources to enter your API key</a>.</p>
      </div>
      <div class="llm-unavailable-help">
        <p>If you don't have an API key, you can register at
          <a href="https://console.anthropic.com/" target="_blank" rel="noreferrer">console.anthropic.com</a> or
          <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">platform.openai.com</a>,
          create an API key, and then enter it in freezr's
          <a href="${ACCOUNT_RESOURCES_LINK}" target="_blank" rel="noreferrer">Account Resources</a> page.</p>
      </div>
    `
    return
  }

  if (projectMode === 'app') {
    const appSettings = state.project.appSettings || {}
    const settingsExpanded = appSettings.expanded || false
    const renameStatus = appSettings.renameStatus || ''
    const publishBusy = appSettings.publishBusy || false
    const publishLoading = appSettings.publishLoading || false
    const publishedVersions = appSettings.publishedVersions || []
    const publishFetched = appSettings.publishFetched || false
    const manifestVersion = state.project?.manifestEditor?.manifestObject?.version || '0.01'
    const needsVersionBump = appSettings.needsVersionBump || false
    const suggestedVersion = appSettings.suggestedVersion || ''
    const lastPublishResult = appSettings.lastPublishResult || null

    const renderVersionRow = (v) => {
      const badge = v.isLatest ? ' (latest)' : ''
      const statusClass = v.isPublic ? 'version-badge-public' : 'version-badge-unpublished'
      const statusLabel = v.isPublic ? 'Public' : 'Not public'
      const dateStr = v.timestamp ? new Date(v.timestamp).toLocaleDateString() : ''
      const downloadUrl = v.isPublic && v.publicId ? '/' + v.publicId : null
      return `<div class="version-row">
        <span class="version-info">
          ${downloadUrl ? `<a href="${escHtml(downloadUrl)}" class="panel-link-sm" title="Download">↓</a>` : ''}
          <strong>v${escHtml(v.version)}${badge}</strong>
          <span class="version-badge ${statusClass}">${statusLabel}</span>
          ${dateStr ? `<span class="version-date">${escHtml(dateStr)}</span>` : ''}
          ${v.fileName ? `<span class="version-file">${escHtml(v.fileName)}</span>` : ''}
        </span>
        ${v.isPublic ? `<button class="panel-cta panel-cta-xs" data-action="unpublish-version" data-version="${escHtml(v.version)}">Unpublish</button>` : ''}
      </div>`
    }

    const releaseNotesField = `<div class="panel-inline-row publish-notes-row">
          <label class="publish-field-label">Release notes</label>
          <input id="publishReleaseNotes" type="text" placeholder="What's new in this version?" value="" ${publishBusy ? 'disabled' : ''}>
        </div>`

    const publishFormHtml = (() => {
      if (publishLoading && !publishFetched) {
        return '<div class="publish-loader">Loading published versions...</div>'
      }
      if (lastPublishResult) {
        return `<div class="publish-success">
          <div class="publish-success-msg">🎉 Published v${escHtml(lastPublishResult.version)} successfully! 🚀</div>
          <div class="publish-links">
            <span>Download: <a href="${escHtml(lastPublishResult.downloadUrl)}" target="_blank">${escHtml(lastPublishResult.fileName || 'zip')}</a></span>
          </div>
        </div>`
      }
      if (needsVersionBump) {
        return `<div class="publish-form">
          <div class="publish-version-warning">Manifest version (${escHtml(manifestVersion)}) is not higher than the last published version (${escHtml(appSettings.latestPublishedVersion || '')}). Please enter a new version number:</div>
          <div class="panel-inline-row">
            <label class="publish-field-label">New Version</label>
            <input id="publishVersionInput" type="text" placeholder="Version" value="${escHtml(suggestedVersion)}" ${publishBusy ? 'disabled' : ''}>
          </div>
          ${releaseNotesField}
          <button class="panel-cta publish-btn" data-action="publish-app" ${publishBusy ? 'disabled' : ''}>${publishBusy ? 'Publishing...' : 'Publish v' + escHtml(suggestedVersion)}</button>
        </div>`
      }
      return `<div class="publish-form">
        <div class="publish-version-info">Version from manifest: <strong>${escHtml(manifestVersion)}</strong></div>
        ${releaseNotesField}
        <button class="panel-cta publish-btn" data-action="publish-app" ${publishBusy ? 'disabled' : ''}>${publishBusy ? 'Publishing...' : 'Publish v' + escHtml(manifestVersion)}</button>
      </div>`
    })()

    container.innerHTML = `
      <h2 class="panel-app-title">🛠️ ${formatAppNameForHeader(appName)}</h2>
      <section class="panel-section">
        <h3>Project Settings</h3>
        ${renderLlmSettings(state)}
        <label class="llm-checkbox-label">
          <input id="themeToggle" type="checkbox" ${isDark ? 'checked' : ''}>
          <span>Dark mode</span>
        </label>
      </section>
      <div data-project-manifest-editor></div>
      <section class="panel-section app-settings-section">
        <div class="app-settings-header" data-action="toggle-app-settings">
          <span class="app-settings-toggle">${settingsExpanded ? '▼' : '▶'}</span>
          <h3 style="display:inline; margin:0;">App Settings</h3>
        </div>
        ${settingsExpanded ? `
          <div class="app-settings-body">
            <div class="app-settings-row">
              <label>Rename App</label>
              <div class="panel-inline-row">
                <input id="renameAppInput" type="text" placeholder="New app name" value="${escHtml(appSettings.renameText || '')}">
                <button class="panel-cta panel-cta-sm" data-action="rename-app">Rename</button>
              </div>
              <div class="app-settings-warning">User database and user files will not be copied over on rename.</div>
              ${renameStatus ? `<div class="app-settings-status">${escHtml(renameStatus)}</div>` : ''}
              <div id="renameWarnings" style="display:none;"></div>
            </div>
            <div class="app-settings-row publish-section">
              <label>Publish App</label>
              ${publishFormHtml}
              ${publishedVersions.length > 0 ? `
                <div class="version-list">
                  <label>Published Versions</label>
                  ${publishedVersions.map(renderVersionRow).join('')}
                </div>
              ` : (publishFetched ? '<div class="version-list"><label>No published versions yet.</label></div>' : '')}
            </div>
            <div class="app-settings-row delete-section">
              <label>Danger Zone</label>
              <div class="app-settings-warning">These actions are irreversible.</div>
              <div class="panel-inline-row">
                <input id="deleteConfirmInput" type="text" placeholder="Type '${escHtml(appName.split('.').pop())}' to confirm">
              </div>
              <div class="panel-inline-row" style="gap:8px; margin-top:4px;">
                <button class="panel-cta panel-cta-sm panel-cta-danger" data-action="delete-chat-history">Delete Chat History</button>
                <button class="panel-cta panel-cta-sm panel-cta-danger" data-action="delete-app-and-history">Delete App &amp; Chat History</button>
              </div>
              <div id="deleteStatus" class="app-settings-status" style="display:none;"></div>
            </div>
          </div>
        ` : ''}
      </section>
      <div class="panel-switch-app-footer">
        <button class="panel-cta" data-action="switch-app">↻ Switch App</button>
      </div>
    `

    bindLlmSettingsEvents(container, state, setState)

    const switchButton = container.querySelector('[data-action="switch-app"]')
    if (switchButton) {
      switchButton.onclick = async () => {
        await switchToAppChooser(setState, getState)
      }
    }

    const themeToggle = container.querySelector('#themeToggle')
    if (themeToggle) {
      themeToggle.onchange = () => {
        setState((next) => {
          const nextTheme = themeToggle.checked ? 'dark' : 'light'
          next.project.ui.theme = nextTheme
          return next
        })
      }
    }

    const manifestContainer = container.querySelector('[data-project-manifest-editor]')
    if (manifestContainer) {
      renderManifestEditor({ container: manifestContainer, state, getState, setState })
    }

    const settingsToggle = container.querySelector('[data-action="toggle-app-settings"]')
    if (settingsToggle) {
      settingsToggle.onclick = () => {
        const currentState = getState()
        const wasExpanded = currentState.project?.appSettings?.expanded
        const alreadyFetched = currentState.project?.appSettings?.publishFetched
        const willFetch = !wasExpanded && !alreadyFetched

        setState((next) => {
          if (!next.project) next.project = {}
          if (!next.project.appSettings) next.project.appSettings = {}
          next.project.appSettings.expanded = !wasExpanded
          if (willFetch) {
            next.project.appSettings.publishLoading = true
          }
          return next
        }, { sourcePanel: 'project' })

        if (willFetch) {
          const mv = currentState.project?.manifestEditor?.manifestObject?.version || '0.01'
          fetchPublishedVersions(appName, setState, mv)
        }
      }
    }

    bindRenameEvents(container, state, setState)
    bindPublishEvents(container, state, setState, appName)
    bindDeleteEvents(container, state, setState, getState)

    if (settingsExpanded && !publishFetched && !appSettings.publishLoading) {
      fetchPublishedVersions(appName, setState, manifestVersion)
    }

    return
  }

  container.innerHTML = `
    <h2 class="welcome-title">Create or Choose an App</h2>

    <section class="panel-section welcome-create-form">
      <label class="welcome-field-label" for="projectNewAppText">Choose an app name</label>
      <input id="projectNewAppText" type="text" class="welcome-input" placeholder="myNotes or com.example.notes" value="${escHtml(project.newAppText || '')}">
      <span class="welcome-field-hint">Alphanumeric characters and dots only, no spaces. Simple names (e.g. myNotes) get a server prefix automatically.</span>

      <label class="welcome-field-label" for="projectNewAppDescription">Describe the app you want to build</label>
      <textarea id="projectNewAppDescription" class="welcome-textarea" placeholder="e.g. A simple todo list app with categories and due dates..." rows="4">${escHtml(project.newAppDescription || '')}</textarea>

      <div class="welcome-create-btn-wrap">
        <button class="panel-cta welcome-create-btn" data-action="create-app"> Create App </button>
      </div>
    </section>

    ${project.recentApps?.length ? `
    <section class="panel-section">
      <h3>Recent Apps</h3>
      <select id="projectRecentAppSelect">
        <option value="">Select a recent app...</option>
        ${project.recentApps.map((app) => `<option value="${escHtml(app)}">${escHtml(app)}</option>`).join('')}
      </select>
    </section>
    ` : ''}

    <section class="panel-section">
      <h3>Edit any of your apps</h3>
      ${project.existingApps?.length
        ? `<select id="projectAllAppSelect">
            <option value="">Select an app...</option>
            ${project.existingApps.map((app) => {
              const name = typeof app === 'string' ? app : app.app_name
              return `<option value="${escHtml(name)}">${escHtml(name)}</option>`
            }).join('')}
          </select>`
        : '<p>No apps found.</p>'}
    </section>

    <section class="panel-section">
      <h3>Project Settings</h3>
      <label class="theme-switch" for="themeToggle">
        <input id="themeToggle" type="checkbox" ${isDark ? 'checked' : ''}>
        <span style="display:inline-block">Dark mode</span>
      </label>
    </section>
  `

  const recentAppSelect = container.querySelector('#projectRecentAppSelect')
  if (recentAppSelect) {
    recentAppSelect.onchange = () => {
      const selected = recentAppSelect.value
      if (selected) loadApp(selected, setState)
    }
  }

  const allAppSelect = container.querySelector('#projectAllAppSelect')
  if (allAppSelect) {
    allAppSelect.onchange = () => {
      const selected = allAppSelect.value
      if (selected) loadApp(selected, setState)
    }
  }

  const input = container.querySelector('#projectNewAppText')
  const descInput = container.querySelector('#projectNewAppDescription')
  const createButton = container.querySelector('[data-action="create-app"]')

  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === ' ') e.preventDefault()
    })
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\s/g, '')
    })
  }

  if (descInput) {
    descInput.oninput = () => {
      setState((next) => {
        next.project.newAppDescription = descInput.value
        return next
      }, { rerender: false })
    }
  }

  const onCreate = async () => {
    if (!input) return
    clearError()
    const rawName = (input.value || '').trim()
    const description = (descInput?.value || '').trim()

    setState((next) => {
      if (!next.loading) next.loading = {}
      next.project.newAppText = rawName
      next.project.newAppDescription = description
      next.loading.active = true
      next.loading.text = 'Your app is being created!'
      return next
    })

    let nameCheck = await checkAppName(rawName)
    if (!nameCheck.ok && nameCheck.suggestion) {
      nameCheck = await checkAppName(nameCheck.suggestion)
    }
    if (!nameCheck.ok) {
      setState((next) => {
        if (!next.loading) next.loading = {}
        next.loading.active = false
        next.loading.text = ''
        return next
      })
      showError(nameCheck.error || 'Invalid app name.')
      return
    }

    try {
      const result = await createApp(nameCheck.value)
      if (!result?.success) throw new Error('Create app failed.')

      try {
        const readResult = await freezr.apiRequest('GET', '/creatorapi/read_app_file?app_name=' + encodeURIComponent(result.appName) + '&file_path=manifest.json')
        if (readResult && !readResult.error && readResult.content) {
          const manifestObj = JSON.parse(readResult.content)
          const nameParts = result.appName.split('.')
          manifestObj.display_name = nameParts[nameParts.length - 1] || result.appName
          if (description) manifestObj.description = description
          await freezr.apiRequest('POST', '/creatorapi/write_app_file', {
            app_name: result.appName,
            file_path: 'manifest.json',
            content: JSON.stringify(manifestObj, null, 2) + '\n'
          })
        }
      } catch (e) {
        console.warn('Could not update manifest after creation:', e)
      }

      const [history, fileTree] = await Promise.all([
        fetchAppHistory(result.appName),
        fetchFolderTree(result.appName)
      ])

      setUrlAppParam(result.appName)

      setState((next) => {
        if (!next.loading) next.loading = {}
        next.appName = result.appName
        next.project.mode = 'app'
        next.project.lastUpdate = history.length > 0 ? history[0] : null
        next.project.newAppDescription = ''
        if (!next.index) next.index = {}
        next.index.history = history
        next.index.fileTree = fileTree
        next.index.activeTab = 'history'
        if (!next.file) next.file = {}
        next.file.openFilePath = null
        next.file.openFileContent = null
        calculateAndStoreProjectCost(next, history)
        next.loading.active = false
        next.loading.text = ''
        activateAllPanels(next)
        return next
      })

      loadManifestForApp(result.appName, setState)

      if (description) {
        try {
          const currentState = getState()
          await sendChatMessage(description, currentState, setState)
        } catch (e) {
          console.warn('Could not auto-send description as chat:', e)
        }
      }
    } catch (error) {
      setState((next) => {
        if (!next.loading) next.loading = {}
        next.loading.active = false
        next.loading.text = ''
        return next
      })
      showError(error?.message || 'Could not create app.')
    }
  }

  if (createButton) createButton.onclick = onCreate
  if (input) {
    input.onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        onCreate()
      }
    }
  }

  const themeToggle = container.querySelector('#themeToggle')
  if (themeToggle) {
    themeToggle.onchange = () => {
      setState((next) => {
        const nextTheme = themeToggle.checked ? 'dark' : 'light'
        next.project.ui.theme = nextTheme
        return next
      })
    }
  }
}
