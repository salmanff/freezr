import { initCreatorUi } from './modules/uiMechanism.js'
import { createInitialCreatorState } from './modules/initState.js'
import { renderProjectPanel, loadApp, switchToAppChooser } from './modules/panels/projectPanel.js'
import { renderIndexPanel } from './modules/panels/indexPanel.js'
import { renderChatPanel } from './modules/panels/chatPanel.js'
import { renderFilePanel } from './modules/panels/filePanel.js'

const getUrlAppParam = () => {
  try {
    const params = new URLSearchParams(window.location.search)
    return params.get('app') || null
  } catch (e) { return null }
}

const startCreator = async () => {
  let creatorState = await createInitialCreatorState()
  const exposeState = () => {
    try { window.creatorState = creatorState } catch (e) { /* noop */ }
  }
  exposeState()
  let renderUi = () => {}

  const setState = (updater, options = {}) => {
    const nextState = structuredClone(creatorState)
    const updated = typeof updater === 'function' ? updater(nextState) : updater
    creatorState = updated || nextState
    exposeState()
    if (options.rerender !== false) {
      renderUi({ dirtyFrom: options.sourcePanel || null, streamOnly: options.streamOnly || false })
    }
  }

  renderUi = initCreatorUi({
    getState: () => creatorState,
    setState,
    panelRenderers: {
      project: renderProjectPanel,
      index: renderIndexPanel,
      chat: renderChatPanel,
      file: renderFilePanel
    },
    onStateChange: () => {},
    onRefreshApp: async () => {
      await switchToAppChooser(setState, () => creatorState)
    }
  })

  renderUi()

  const urlApp = getUrlAppParam()
  if (urlApp) {
    loadApp(urlApp, setState)
  }
}

startCreator()
