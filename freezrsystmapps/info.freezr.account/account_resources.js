// account_resources.js - LLM key management
// account/resources
/* global freezr freezrMeta */
/* global confirm */

const TABLE_NAME = 'info.freezr.account.resources'
let llmTable

const state = {
  resources: []
}

freezr.initPageScripts = async function () {
  llmTable = document.getElementById('llmGridDetails')

  const overlay = document.getElementById('overlay')
  const overlayClose = document.getElementById('overlay_close')
  if (overlayClose) {
    overlayClose.onclick = function () {
      if (overlay) overlay.style.display = 'none'
    }
  }
  if (overlay) {
    overlay.onclick = function (e) {
      if (e.target === overlay) overlay.style.display = 'none'
    }
  }

  document.getElementById('button_addnew_llm').onclick = function () {
    clearForm()
    document.getElementById('llmFormTitle').innerText = 'Add a New LLM Key'
    document.getElementById('button_llmSave').innerText = 'Save'
    document.getElementById('button_llmDelete').style.display = 'none'
    if (overlay) overlay.style.display = 'flex'
  }

  document.getElementById('button_llmSave').onclick = saveLlm
  document.getElementById('button_llmDelete').onclick = deleteLlm

  try {
    const results = await freezr.query(TABLE_NAME, { type: 'llm' })
    state.resources = (results && results.length > 0) ? results : []

    // Auto-set default if there are LLM resources but none is marked default
    const llms = state.resources.filter(r => r.type === 'llm' && r.key)
    if (llms.length > 0 && !llms.some(r => r.default)) {
      llms[0].default = true
      try {
        await freezr.update(TABLE_NAME, llms[0]._id, { ...llms[0], default: true })
      } catch (e) {
        console.warn('Could not auto-set default LLM resource:', e)
      }
    }

    redrawList()
  } catch (err) {
    showWarning(err?.message || err)
  }
}

const clearForm = function () {
  document.getElementById('llm_name').value = ''
  document.getElementById('llm_provider').value = 'Claude'
  document.getElementById('llm_key').value = ''
  document.getElementById('llm_default').checked = false
  document.getElementById('llm__id').value = ''
}

const openEditForm = function (doc) {
  document.getElementById('llmFormTitle').innerText = 'Edit LLM Key'
  document.getElementById('button_llmSave').innerText = 'Update'
  document.getElementById('button_llmDelete').style.display = 'block'

  document.getElementById('llm_name').value = doc.name || ''
  document.getElementById('llm_provider').value = doc.provider || 'Claude'
  document.getElementById('llm_key').value = doc.key || ''
  document.getElementById('llm_default').checked = !!doc.default
  document.getElementById('llm__id').value = doc._id || ''

  const overlay = document.getElementById('overlay')
  if (overlay) overlay.style.display = 'flex'
}

const saveLlm = async function () {
  const name = document.getElementById('llm_name').value.trim()
  const provider = document.getElementById('llm_provider').value
  const key = document.getElementById('llm_key').value.trim()
  const isDefault = document.getElementById('llm_default').checked
  const existingId = document.getElementById('llm__id').value

  if (!name) { showWarning('Name is required'); return }
  if (!key) { showWarning('API key is required'); return }

  const params = { type: 'llm', name, provider, key, default: isDefault }

  // Auto-set as default if this will be the only LLM resource
  if (!existingId) {
    const existingLlms = state.resources.filter(r => r.type === 'llm')
    if (existingLlms.length === 0) params.default = true
  }

  try {
    showLoading(true)

    // If marking as default, unset any other defaults first
    if (params.default) {
      for (const res of state.resources) {
        if (res.default && res._id !== existingId) {
          await freezr.update(TABLE_NAME, res._id, { ...res, default: false })
          res.default = false
        }
      }
    }

    if (existingId) {
      const result = await freezr.update(TABLE_NAME, existingId, params)
      if (!result || result.error) throw new Error(result?.error || 'Error updating key')
      state.resources = state.resources.map(r => r._id === existingId ? { ...params, _id: existingId } : r)
    } else {
      const result = await freezr.create(TABLE_NAME, params)
      if (!result || result.error) throw new Error(result?.error || 'Error creating key')
      params._id = result._id
      state.resources.push(params)
    }

    showLoading(false)
    const overlay = document.getElementById('overlay')
    if (overlay) overlay.style.display = 'none'
    redrawList()
  } catch (e) {
    showLoading(false)
    showWarning(e.message || 'Error saving')
  }
}

const deleteLlm = async function () {
  const theId = document.getElementById('llm__id').value
  if (!theId) return
  if (!confirm('Are you sure you want to delete this LLM key?')) return

  try {
    showLoading(true)
    await freezr.delete(TABLE_NAME, theId, {})
    state.resources = state.resources.filter(r => r._id !== theId)
    showLoading(false)
    const overlay = document.getElementById('overlay')
    if (overlay) overlay.style.display = 'none'
    redrawList()
  } catch (err) {
    showLoading(false)
    showWarning(err?.message || 'Error deleting key')
  }
}

const setAsDefault = async function (doc) {
  try {
    showLoading(true)
    for (const res of state.resources) {
      if (res.default && res._id !== doc._id) {
        await freezr.update(TABLE_NAME, res._id, { ...res, default: false })
        res.default = false
      }
    }
    await freezr.update(TABLE_NAME, doc._id, { ...doc, default: true })
    doc.default = true
    showLoading(false)
    redrawList()
  } catch (err) {
    showLoading(false)
    showWarning(err?.message || 'Error setting default')
  }
}

const redrawList = function () {
  if (!llmTable) return
  llmTable.innerHTML = ''

  const llms = state.resources.filter(r => r.type === 'llm')

  if (llms.length === 0) {
    llmTable.innerHTML = '<p>No LLM keys added yet. Click "Add LLM Key" to get started.</p>'
    return
  }

  llms.forEach(doc => {
    const row = document.createElement('div')
    row.className = 'gridlist'
    row.id = 'llmRow_' + doc._id
    row.style.cssText = 'display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 0.75rem; padding: 0.75rem 0; border-bottom: 1px solid #e2e8f0;'

    const info = document.createElement('div')

    const nameSpan = document.createElement('span')
    nameSpan.style.fontWeight = '600'
    nameSpan.innerText = doc.name || '(unnamed)'
    info.appendChild(nameSpan)

    if (doc.default) {
      const badge = document.createElement('span')
      badge.style.cssText = 'display: inline-block; margin-left: 0.5rem; padding: 0.1rem 0.5rem; background: #059669; color: white; border-radius: 4px; font-size: 0.75rem;'
      badge.innerText = 'default'
      info.appendChild(badge)
    }

    const details = document.createElement('div')
    details.style.cssText = 'font-size: 0.85em; color: #64748b; margin-top: 0.25rem;'
    const maskedKey = doc.key ? '***' + doc.key.slice(-4) : '***'
    details.innerText = doc.provider + ' · ' + maskedKey
    info.appendChild(details)

    row.appendChild(info)

    const actions = document.createElement('div')
    actions.style.cssText = 'display: flex; gap: 0.5rem; flex-wrap: wrap;'

    if (!doc.default) {
      const defaultBtn = document.createElement('span')
      defaultBtn.className = 'smallTextButt'
      defaultBtn.innerText = 'Set Default'
      defaultBtn.onclick = function () { setAsDefault(doc) }
      actions.appendChild(defaultBtn)
    }

    const editBtn = document.createElement('span')
    editBtn.className = 'smallTextButt'
    editBtn.innerText = 'Edit'
    editBtn.onclick = function () { openEditForm(doc) }
    actions.appendChild(editBtn)

    row.appendChild(actions)
    llmTable.appendChild(row)
  })
}

const showLoading = function (doShow) {
  const loader = document.getElementById('loader')
  if (loader) loader.style.display = doShow ? 'block' : 'none'
}

const showWarning = function (msg, timing) {
  if (msg) console.log('WARNING : ' + JSON.stringify(msg))
  const warnDiv = document.getElementById('warnings')
  if (!warnDiv) return
  window.scrollTo(0, 0)
  if (!msg) {
    warnDiv.innerText = ''
    warnDiv.style.display = 'none'
  } else {
    warnDiv.style.display = 'block'
    warnDiv.innerText = msg
    if (!timing) timing = 5000
    setTimeout(function () { showWarning() }, timing)
  }
}
