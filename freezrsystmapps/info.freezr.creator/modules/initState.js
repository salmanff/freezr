/* global freezr */

const LLM_PING_TIMEOUT_MS = 15000

const tryLlmPing = async () => {
  try {
    const result = await Promise.race([
      freezr.llm.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('LLM ping timed out')), LLM_PING_TIMEOUT_MS))
    ])
    return result
  } catch (error) {
    return { success: false, error: error?.message || 'Ping failed' }
  }
}

const fetchRecentApps = async () => {
  try {
    const results = await freezr.query('appUpdates', {}, { sort: { timestamp: -1 }, count: 200 })
    if (!results || !Array.isArray(results)) return []
    const seen = new Set()
    const unique = []
    for (const entry of results) {
      const name = entry.appName
      if (name && !seen.has(name)) {
        seen.add(name)
        unique.push(name)
      }
    }
    return unique
  } catch (error) {
    console.warn('Could not fetch recent apps:', error)
    return []
  }
}

const fetchAllApps = async () => {
  try {
    const result = await freezr.apiRequest('GET', '/creatorapi/user_apps')
    if (result && Array.isArray(result.apps)) return result.apps
    if (result && Array.isArray(result.app_names)) return result.app_names.map((n) => ({ app_name: n }))
    return []
  } catch (error) {
    console.warn('Could not fetch all apps:', error)
    return []
  }
}

export const createInitialCreatorState = async () => {
  const [pingResult, recentApps, existingApps] = await Promise.all([
    tryLlmPing(),
    fetchRecentApps(),
    fetchAllApps()
  ])
  const llmAvailable = Boolean(pingResult?.success && (pingResult?.exists ?? true))

  const defaultProvider = pingResult?.defaultProvider || pingResult?.defaultFamily || null
  const defaultModel = ''

  const state = {
    appName: null,
    loading: {
      active: false,
      text: ''
    },
    llm: {
      provider: defaultProvider,
      providers: pingResult?.providers || {},
      pricingMeta: pingResult?.pricingMeta || {},
      model: defaultModel,
      settingsExpanded: false,
      toolsExpanded: false,
      projectCost: null,
      options: {
        cacheControl: false,
        maxTokens: null
      }
    },
    project: {
      ui: { enabled: true, visible: true, widthPct: null, theme: (() => { try { return window.localStorage.getItem('freezr_creator_theme') || 'dark' } catch (e) { return 'dark' } })() },
      mode: 'choose',
      llmAvailable,
      llmPing: pingResult,
      newAppText: '',
      manifestEditor: {
        loading: false,
        saving: false,
        error: '',
        loadedForApp: null,
        manifestObject: null,
        fields: {
          display_name: '',
          description: ''
        },
        permissionsUi: [],
        appTablesByApp: {},
        loadingTablesByApp: {},
        saveStatus: ''
      },
      recentApps,
      existingApps
    },
    index: {
      ui: { enabled: false, visible: false, widthPct: null },
      activeTab: 'history',
      history: [],
      fileTree: []
    },
    chat: {
      ui: { enabled: false, visible: false, widthPct: null },
      chatId: null,
      messages: [],
      draftMessage: '',
      sending: false,
      error: null
    },
    file: {
      ui: { enabled: true, visible: false, widthPct: null },
      instructions: true,
      editorDirty: false,
      editorSaving: false,
      editorSaveStatus: '',
      editorHistoryId: null,
      editorFileUpdateId: null
    }
  }

  return state
}
