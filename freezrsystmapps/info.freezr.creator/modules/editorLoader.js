let cmModule = null

const loadCodeMirror = async () => {
  if (cmModule) return cmModule
  cmModule = await import('./vendor/codemirror-bundle.js')
  return cmModule
}

const LANG_MAP = {
  javascript: 'javascript',
  css: 'css',
  html: 'html',
  json: 'json'
}

const getLangExtension = (cm, language) => {
  const key = LANG_MAP[language]
  if (!key || typeof cm[key] !== 'function') return []
  return [cm[key]()]
}

export const createEditor = async (parentElement, { content, language, onChange }) => {
  const cm = await loadCodeMirror()

  const langExtension = getLangExtension(cm, language)

  const updateListener = cm.EditorView.updateListener.of((update) => {
    if (update.docChanged && typeof onChange === 'function') {
      onChange(update.state.doc.toString())
    }
  })

  const state = cm.EditorState.create({
    doc: content || '',
    extensions: [
      cm.basicSetup,
      cm.keymap.of([cm.indentWithTab]),
      ...langExtension,
      cm.oneDark,
      cm.EditorView.lineWrapping,
      updateListener
    ]
  })

  const view = new cm.EditorView({ state, parent: parentElement })

  return {
    view,
    getContent: () => view.state.doc.toString(),
    setContent: (newContent) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: newContent }
      })
    },
    destroy: () => view.destroy()
  }
}
