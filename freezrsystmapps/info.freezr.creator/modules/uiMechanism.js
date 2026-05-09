const PANEL_ORDER = ['project', 'index', 'chat', 'file']
const MIN_PANEL_WIDTH_PERCENT = 10
const THEME_KEY = 'freezr_creator_theme'
const MOBILE_BREAKPOINT = 800

export const initCreatorUi = ({ getState, setState, panelRenderers = {}, onStateChange, onRefreshApp }) => {
  const root = document.querySelector('.creator-root')
  const panelStack = document.getElementById('panelStack')
  const loadingOverlay = document.getElementById('creatorLoadingOverlay')
  const loadingText = document.getElementById('creatorLoadingText')
  const toggles = Array.from(document.querySelectorAll('.panel-toggle'))
  const refreshButton = document.getElementById('creatorRefreshApp')
  const launchButton = document.getElementById('creatorLaunchApp')
  const toolbarAppName = document.getElementById('creatorToolbarAppName')
  const mobileMenuToggle = document.getElementById('creatorMobileMenuToggle')
  const toolbarBackdrop = document.getElementById('creatorToolbarBackdrop')
  const panelMap = new Map()
  const panelContentMap = new Map()
  const mobileQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`)

  PANEL_ORDER.forEach((panelId) => {
    const panelElement = panelStack.querySelector(`[data-panel-id="${panelId}"]`)
    const contentElement = panelElement?.querySelector(`[data-panel-content="${panelId}"]`)
    if (panelElement) {
      panelMap.set(panelId, panelElement)
      const hideBtn = document.createElement('button')
      hideBtn.className = 'panel-hide-btn'
      hideBtn.dataset.hidePanel = panelId
      hideBtn.title = 'Hide panel'
      hideBtn.textContent = '−'
      hideBtn.addEventListener('click', () => {
        const currentState = getState()
        const ui = getPanelUi(currentState, panelId)
        if (ui.enabled === false) return
        setState((next) => {
          if (isMobileView) return next
          const visibleIds = getDesktopVisibleIds(next)
          if (visibleIds.length > 1) {
            getPanelUi(next, panelId).visible = false
          }
          return next
        }, { sourcePanel: panelId })
        notifyStateChange(panelId)
      })
      panelElement.insertBefore(hideBtn, panelElement.firstChild)
    }
    if (contentElement) panelContentMap.set(panelId, contentElement)
  })

  const safeOnStateChange = typeof onStateChange === 'function' ? onStateChange : () => {}

  let lastVisibleIds = []
  let isMobileView = mobileQuery.matches
  let isToolbarOpen = false

  const setToolbarOpen = (open) => {
    isToolbarOpen = Boolean(open) && isMobileView
    if (root) root.classList.toggle('toolbar-open', isToolbarOpen)
    if (mobileMenuToggle) mobileMenuToggle.setAttribute('aria-expanded', isToolbarOpen ? 'true' : 'false')
    if (toolbarBackdrop) toolbarBackdrop.hidden = !isToolbarOpen
  }

  const getPanelUi = (workingState, panelId) => {
    if (!workingState[panelId]) workingState[panelId] = {}
    if (!workingState[panelId].ui) workingState[panelId].ui = {}
    return workingState[panelId].ui
  }

  const notifyStateChange = (panelId = null) => {
    safeOnStateChange({ panelId, state: getState() })
  }

  const getDesktopVisibleIds = (workingState) =>
    PANEL_ORDER.filter((id) => {
      const ui = getPanelUi(workingState, id)
      return ui.enabled !== false && ui.visible !== false
    })

  const getVisibleIds = (workingState, preferredPanelId = null) => {
    const visibleIds = getDesktopVisibleIds(workingState)
    if (!isMobileView) return visibleIds
    if (visibleIds.length === 0) return []

    const preferredId = [preferredPanelId, lastVisibleIds[0], visibleIds[0]]
      .find((id) => id && visibleIds.includes(id))

    return preferredId ? [preferredId] : [visibleIds[0]]
  }

  const normalizeState = (workingState) => {
    PANEL_ORDER.forEach((panelId) => {
      const ui = getPanelUi(workingState, panelId)
      if (ui.enabled === false) ui.visible = false
    })

    const visibleIds = getDesktopVisibleIds(workingState)
    if (visibleIds.length > 0) return

    const firstEnabled = PANEL_ORDER.find((id) => getPanelUi(workingState, id).enabled !== false)
    if (firstEnabled) {
      getPanelUi(workingState, firstEnabled).visible = true
    }
  }

  const applyTheme = (workingState) => {
    if (!root) return
    const themeName = getPanelUi(workingState, 'project').theme || 'dark'
    const isLight = themeName === 'light'
    root.classList.toggle('theme-light', isLight)
    root.classList.toggle('theme-dark', !isLight)
    try {
      window.localStorage.setItem(THEME_KEY, isLight ? 'light' : 'dark')
    } catch (error) {
      // Ignore storage access errors.
    }
  }

  const applyLoading = (workingState) => {
    if (!loadingOverlay) return
    const loadingState = workingState.loading || {}
    const active = Boolean(loadingState.active)
    loadingOverlay.hidden = !active
    if (loadingText) {
      loadingText.textContent = loadingState.text || 'Loading...'
    }
  }

  const applyToolbarState = (workingState) => {
    const appName = workingState.appName || ''
    if (toolbarAppName) {
      toolbarAppName.textContent = appName
      toolbarAppName.title = appName
    }
    if (refreshButton) {
      const hasApp = Boolean(appName)
      refreshButton.disabled = !hasApp
      refreshButton.title = hasApp ? `Change app from ${appName}` : 'Select or create an app first'
    }
    if (launchButton) {
      const hasApp = Boolean(appName)
      launchButton.disabled = !hasApp
      launchButton.title = hasApp ? `Launch ${appName}` : 'Select or create an app first'
    }
  }

  const initTheme = (workingState) => {
    let themeName = 'dark'
    try {
      const savedTheme = window.localStorage.getItem(THEME_KEY)
      if (savedTheme === 'light' || savedTheme === 'dark') {
        themeName = savedTheme
      }
    } catch (error) {
      // Ignore storage access errors and keep default theme.
    }

    getPanelUi(workingState, 'project').theme = themeName
  }

  const rebalanceVisiblePanels = (workingState) => {
    if (isMobileView) return
    const visibleIds = getDesktopVisibleIds(workingState)
    if (visibleIds.length === 0) return
    const evenWidth = 100 / visibleIds.length
    visibleIds.forEach((id) => {
      getPanelUi(workingState, id).widthPct = evenWidth
    })
  }

  const updateToggleState = (workingState, visibleIds) => {
    const activeVisibleIds = new Set(visibleIds)
    toggles.forEach((toggle) => {
      const panelId = toggle.dataset.panel
      const ui = getPanelUi(workingState, panelId)
      const isDisabled = ui.enabled === false
      const isVisible = activeVisibleIds.has(panelId)
      toggle.disabled = isDisabled
      toggle.classList.toggle('is-disabled', isDisabled)
      toggle.classList.toggle('is-active', isVisible)
    })
  }

  const attachResizerHandlers = () => {
    const resizers = Array.from(panelStack.querySelectorAll('.panel-resizer'))
    resizers.forEach((resizer) => {
      resizer.onmousedown = (startEvent) => {
        startEvent.preventDefault()
        const leftPanel = resizer.dataset.leftPanel
        const rightPanel = resizer.dataset.rightPanel
        if (!leftPanel || !rightPanel) return

        const startX = startEvent.clientX
        const stackWidth = panelStack.getBoundingClientRect().width || 1
        const currentState = getState()
        const startLeft = getPanelUi(currentState, leftPanel).widthPct
        const startRight = getPanelUi(currentState, rightPanel).widthPct
        let latestLeft = startLeft
        let latestRight = startRight
        resizer.classList.add('is-dragging')

        const onMove = (moveEvent) => {
          const deltaPercent = ((moveEvent.clientX - startX) / stackWidth) * 100
          let nextLeft = startLeft + deltaPercent
          let nextRight = startRight - deltaPercent

          if (nextLeft < MIN_PANEL_WIDTH_PERCENT) {
            const correction = MIN_PANEL_WIDTH_PERCENT - nextLeft
            nextLeft += correction
            nextRight -= correction
          } else if (nextRight < MIN_PANEL_WIDTH_PERCENT) {
            const correction = MIN_PANEL_WIDTH_PERCENT - nextRight
            nextRight += correction
            nextLeft -= correction
          }

          const leftEl = panelMap.get(leftPanel)
          const rightEl = panelMap.get(rightPanel)
          if (leftEl) leftEl.style.flex = `0 0 ${nextLeft}%`
          if (rightEl) rightEl.style.flex = `0 0 ${nextRight}%`
          latestLeft = nextLeft
          latestRight = nextRight
        }

        const onUp = () => {
          resizer.classList.remove('is-dragging')
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
          setState((next) => {
            getPanelUi(next, leftPanel).widthPct = latestLeft
            getPanelUi(next, rightPanel).widthPct = latestRight
            return next
          }, { rerender: false })
          notifyStateChange('layout')
        }

        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
      }
    })
  }

  // --- Layout vs Content split ---

  const hasVisibilityChanged = (workingState, preferredPanelId = null) => {
    const currentVisible = getVisibleIds(workingState, preferredPanelId)
    if (currentVisible.length !== lastVisibleIds.length) return true
    return currentVisible.some((id, i) => id !== lastVisibleIds[i])
  }

  const renderLayout = (workingState, preferredPanelId = null) => {
    const visibleIds = getVisibleIds(workingState, preferredPanelId)

    panelStack.replaceChildren()
    panelMap.forEach((el) => el.classList.remove('is-rightmost-panel'))

    visibleIds.forEach((panelId, index) => {
      const panelEl = panelMap.get(panelId)
      if (!panelEl) return
      const width = isMobileView ? 100 : (getPanelUi(workingState, panelId).widthPct || (100 / visibleIds.length))
      panelEl.style.flex = `0 0 ${width}%`
      panelEl.style.display = ''
      if (index === visibleIds.length - 1) panelEl.classList.add('is-rightmost-panel')
      panelStack.appendChild(panelEl)

      if (!isMobileView && index < visibleIds.length - 1) {
        const resizer = document.createElement('div')
        resizer.className = 'panel-resizer'
        resizer.setAttribute('role', 'separator')
        resizer.setAttribute('aria-label', 'Resize panels')
        resizer.dataset.leftPanel = panelId
        resizer.dataset.rightPanel = visibleIds[index + 1]
        panelStack.appendChild(resizer)
      }
    })

    attachResizerHandlers()
    lastVisibleIds = visibleIds
  }

  const renderContent = (workingState, panelIds, renderOptions) => {
    panelIds.forEach((panelId) => {
      const renderer = panelRenderers[panelId]
      const container = panelContentMap.get(panelId)
      if (renderer && container) {
        const panelSetState = (updater, options = {}) => {
          if (!options.sourcePanel) options.sourcePanel = panelId
          setState(updater, options)
        }
        renderer({ container, state: workingState, getState, setState: panelSetState, renderOptions })
      }
    })
  }

  const renderUi = ({ dirtyFrom, streamOnly } = {}) => {
    const workingState = getState()

    if (streamOnly && dirtyFrom) {
      renderContent(workingState, [dirtyFrom], { streamOnly: true })
      return
    }

    normalizeState(workingState)
    applyTheme(workingState)
    applyLoading(workingState)
    applyToolbarState(workingState)

    const layoutChanged = hasVisibilityChanged(workingState, dirtyFrom)
    if (layoutChanged) {
      rebalanceVisiblePanels(workingState)
      renderLayout(workingState, dirtyFrom)
    }

    const visibleIds = layoutChanged ? lastVisibleIds : getVisibleIds(workingState, dirtyFrom)
    let panelsToRender

    if (layoutChanged || !dirtyFrom) {
      panelsToRender = visibleIds
    } else {
      const fromIndex = PANEL_ORDER.indexOf(dirtyFrom)
      panelsToRender = fromIndex >= 0
        ? visibleIds.filter((id) => PANEL_ORDER.indexOf(id) >= fromIndex)
        : visibleIds
    }

    renderContent(workingState, panelsToRender)
    updateToggleState(workingState, visibleIds)
  }

  // --- Toggle wiring ---

  toggles.forEach((toggle) => {
    toggle.addEventListener('click', () => {
      const panelId = toggle.dataset.panel
      if (!panelId || !panelMap.has(panelId)) return
      const currentState = getState()
      const ui = getPanelUi(currentState, panelId)
      if (ui.enabled === false) return

      setState((next) => {
        const panelUi = getPanelUi(next, panelId)
        if (isMobileView) {
          panelUi.visible = true
          return next
        }
        const visibleIds = getVisibleIds(next)
        const currentlyVisible = panelUi.visible !== false
        if (currentlyVisible && visibleIds.length > 1) {
          panelUi.visible = false
        } else if (!currentlyVisible) {
          panelUi.visible = true
        }
        return next
      }, { sourcePanel: panelId })
      if (isMobileView) setToolbarOpen(false)
      notifyStateChange(panelId)
    })
  })

  if (refreshButton) {
    refreshButton.addEventListener('click', () => {
      const appName = getState()?.appName
      if (!appName) return
      if (isMobileView) setToolbarOpen(false)
      if (typeof onRefreshApp === 'function') onRefreshApp(appName)
    })
  }

  if (launchButton) {
    launchButton.addEventListener('click', () => {
      const appName = getState()?.appName
      if (!appName) return
      if (isMobileView) setToolbarOpen(false)
      const width = 900
      const height = 700
      const left = window.screenX + (window.outerWidth - width) / 2
      const top = window.screenY + (window.outerHeight - height) / 2
      window.open(
        '/app/' + encodeURIComponent(appName),
        'app_popup',
        `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
      )
    })
  }

  if (mobileMenuToggle) {
    mobileMenuToggle.addEventListener('click', () => {
      if (!isMobileView) return
      setToolbarOpen(!isToolbarOpen)
    })
  }

  if (toolbarBackdrop) {
    toolbarBackdrop.addEventListener('click', () => {
      setToolbarOpen(false)
    })
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isToolbarOpen) {
      setToolbarOpen(false)
    }
  })

  const syncMobileView = () => {
    isMobileView = mobileQuery.matches
    if (root) root.classList.toggle('is-mobile', isMobileView)
    if (!isMobileView) setToolbarOpen(false)
    renderUi({ dirtyFrom: lastVisibleIds[0] || PANEL_ORDER[0] })
  }

  if (typeof mobileQuery.addEventListener === 'function') {
    mobileQuery.addEventListener('change', syncMobileView)
  } else if (typeof mobileQuery.addListener === 'function') {
    mobileQuery.addListener(syncMobileView)
  }

  // --- Init ---

  const stateAtInit = getState()
  initTheme(stateAtInit)
  normalizeState(stateAtInit)
  if (root) root.classList.toggle('is-mobile', isMobileView)
  setToolbarOpen(false)
  notifyStateChange('init')

  return renderUi
}
