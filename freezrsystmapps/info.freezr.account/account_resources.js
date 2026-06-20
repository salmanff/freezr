// account_resources.js - LLM key management + Connected Accounts (mail/calendar/contacts)
// account/resources
/* global freezr freezrMeta */
/* global confirm */

const TABLE_NAME = 'info.freezr.account.resources'
let llmTable, connectionTable, computeTable

const state = {
  resources: [],     // LLM resources (legacy name kept for minimal diff)
  connections: [],   // Connection records (type: 'connection')
  compute: []        // Compute credentials (type: 'compute')
}

freezr.initPageScripts = async function () {
  llmTable = document.getElementById('llmGridDetails')
  connectionTable = document.getElementById('connectionGridDetails')
  computeTable = document.getElementById('computeGridDetails')

  // LLM overlay wiring (unchanged behavior)
  const overlay = document.getElementById('overlay')
  const overlayClose = document.getElementById('overlay_close')
  if (overlayClose) overlayClose.onclick = function () { if (overlay) overlay.style.display = 'none' }
  if (overlay) overlay.onclick = function (e) { if (e.target === overlay) overlay.style.display = 'none' }

  document.getElementById('button_addnew_llm').onclick = function () {
    clearForm()
    document.getElementById('llmFormTitle').innerText = 'Add a New LLM Key'
    document.getElementById('button_llmSave').innerText = 'Save'
    document.getElementById('button_llmDelete').style.display = 'none'
    if (overlay) overlay.style.display = 'flex'
  }
  document.getElementById('button_llmSave').onclick = saveLlm
  document.getElementById('button_llmDelete').onclick = deleteLlm

  // Compute (serverless) overlay wiring
  const computeOverlay = document.getElementById('compute_overlay')
  const computeOverlayClose = document.getElementById('compute_overlay_close')
  if (computeOverlayClose) computeOverlayClose.onclick = function () { if (computeOverlay) computeOverlay.style.display = 'none' }
  if (computeOverlay) computeOverlay.onclick = function (e) { if (e.target === computeOverlay) computeOverlay.style.display = 'none' }
  document.getElementById('button_addnew_compute').onclick = function () {
    clearComputeForm()
    document.getElementById('computeFormTitle').innerText = 'Add AWS Credentials'
    document.getElementById('button_computeSave').innerText = 'Save'
    document.getElementById('button_computeDelete').style.display = 'none'
    if (computeOverlay) computeOverlay.style.display = 'flex'
  }
  document.getElementById('button_computeSave').onclick = saveCompute
  document.getElementById('button_computeDelete').onclick = deleteCompute
  document.getElementById('button_compute_createRole').onclick = createComputeRole

  // Connect / Edit are now full-page navigations to /connections/new and
  // /connections/edit?name=<name>. The modal that used to live here has been removed.

  // Load all resources in a single query (per the doc note: prefer simple queries + filter client-side).
  try {
    const results = await freezr.query(TABLE_NAME) || []
    state.resources = results.filter(r => r && r.type === 'llm')
    state.connections = results.filter(r => r && r.type === 'connection')
    state.compute = results.filter(r => r && r.type === 'compute')

    // Auto-set default LLM if there are LLM resources but none is marked default.
    const llms = state.resources.filter(r => r.type === 'llm' && r.key)
    if (llms.length > 0 && !llms.some(r => r.default)) {
      llms[0].default = true
      try {
        await freezr.updateFields(TABLE_NAME, llms[0]._id, { default: true })
      } catch (e) {
        console.warn('Could not auto-set default LLM resource:', e)
      }
    }

    redrawList()
    redrawConnectionList()
    redrawComputeList()
  } catch (err) {
    showWarning(err?.message || err)
  }

  // Handle OAuth callback success + focus deep links after the initial render.
  handleUrlParams()
}

/* =====================================================================
 *  LLM keys section (Phase 0.5)
 * =================================================================== */

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
  // The stored key may be encrypted ({__enc} or {value}) — clients never see plaintext.
  // Always blank the field on edit; user re-enters only if they want to change it.
  document.getElementById('llm_key').value = ''
  document.getElementById('llm_key').placeholder = 'Leave blank to keep existing key'
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
  if (!existingId && !key) { showWarning('API key is required'); return }

  try {
    showLoading(true)

    if (isDefault) {
      for (const res of state.resources) {
        if (res.default && res._id !== existingId) {
          await freezr.updateFields(TABLE_NAME, res._id, { default: false })
          res.default = false
        }
      }
    }

    if (existingId) {
      if (key) {
        const params = { type: 'llm', name, provider, key, default: isDefault }
        const result = await freezr.update(TABLE_NAME, existingId, params)
        if (!result || result.error) throw new Error(result?.error || 'Error updating key')
        state.resources = state.resources.map(r => r._id === existingId
          ? { ...r, type: 'llm', name, provider, default: isDefault, _keyJustSet: true }
          : r)
      } else {
        await freezr.updateFields(TABLE_NAME, existingId, { name, provider, default: isDefault })
        state.resources = state.resources.map(r => r._id === existingId
          ? { ...r, name, provider, default: isDefault }
          : r)
      }
    } else {
      const params = { type: 'llm', name, provider, key, default: isDefault }
      const existingLlms = state.resources.filter(r => r.type === 'llm')
      if (existingLlms.length === 0) params.default = true
      const result = await freezr.create(TABLE_NAME, params)
      if (!result || result.error) throw new Error(result?.error || 'Error creating key')
      state.resources.push({ _id: result._id, type: 'llm', name, provider, default: params.default, _keyJustSet: true })
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
        await freezr.updateFields(TABLE_NAME, res._id, { default: false })
        res.default = false
      }
    }
    await freezr.updateFields(TABLE_NAME, doc._id, { default: true })
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
    const maskedKey = (typeof doc.key === 'string' && doc.key) ? '***' + doc.key.slice(-4) : '***'
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

/* =====================================================================
 *  Compute providers (serverless) section (Phase 6)
 *  Credentials live in the SAME resources table as type:'compute' with a `secret`
 *  sub-object ({accessKeyId, secretAccessKey, arnRole}) encrypted server-side on write.
 * =================================================================== */

const clearComputeForm = function () {
  document.getElementById('compute_name').value = ''
  document.getElementById('compute_region').value = 'eu-central-1'
  document.getElementById('compute_accessKeyId').value = ''
  document.getElementById('compute_secretAccessKey').value = ''
  document.getElementById('compute_arnRole').value = ''
  document.getElementById('compute_default').checked = false
  document.getElementById('compute__id').value = ''
}

const openComputeEditForm = function (doc) {
  document.getElementById('computeFormTitle').innerText = 'Edit AWS Credentials'
  document.getElementById('button_computeSave').innerText = 'Update'
  document.getElementById('button_computeDelete').style.display = 'block'
  document.getElementById('compute_name').value = doc.name || ''
  document.getElementById('compute_region').value = doc.region || 'eu-central-1'
  // accessKeyId is non-secret (shown); secretAccessKey is never returned in cleartext to the client.
  const secret = doc.secret && typeof doc.secret === 'object' ? doc.secret : {}
  document.getElementById('compute_accessKeyId').value = (typeof secret.accessKeyId === 'string' ? secret.accessKeyId : '') || ''
  document.getElementById('compute_secretAccessKey').value = ''
  document.getElementById('compute_secretAccessKey').placeholder = 'Leave blank to keep existing'
  document.getElementById('compute_arnRole').value = (typeof secret.arnRole === 'string' ? secret.arnRole : '') || ''
  document.getElementById('compute_default').checked = !!doc.default
  document.getElementById('compute__id').value = doc._id || ''
  const overlay = document.getElementById('compute_overlay')
  if (overlay) overlay.style.display = 'flex'
}

const createComputeRole = async function () {
  const accessKeyId = document.getElementById('compute_accessKeyId').value.trim()
  const secretAccessKey = document.getElementById('compute_secretAccessKey').value.trim()
  const region = document.getElementById('compute_region').value.trim() || 'eu-central-1'
  if (!accessKeyId || !secretAccessKey) { showWarning('Enter the Access Key ID and Secret Access Key first, then create the role.'); return }
  try {
    showLoading(true)
    const r = await freezr.apiRequest('POST', '/jobs/compute/create_role', { accessKeyId, secretAccessKey, region })
    if (!r || r.error || !r.arn) throw new Error((r && r.error) || 'no ARN returned')
    document.getElementById('compute_arnRole').value = r.arn
    showSuccess(r.alreadyExists ? 'Found existing Lambda role.' : 'Created Lambda role.')
  } catch (e) {
    showWarning('Could not create the role: ' + (e.message || e))
  } finally {
    showLoading(false)
  }
}

const saveCompute = async function () {
  const name = document.getElementById('compute_name').value.trim()
  const region = document.getElementById('compute_region').value.trim() || 'eu-central-1'
  const accessKeyId = document.getElementById('compute_accessKeyId').value.trim()
  const secretAccessKey = document.getElementById('compute_secretAccessKey').value.trim()
  const arnRole = document.getElementById('compute_arnRole').value.trim()
  const isDefault = document.getElementById('compute_default').checked
  const existingId = document.getElementById('compute__id').value

  if (!name) { showWarning('Name is required'); return }
  if (!accessKeyId) { showWarning('Access Key ID is required'); return }
  if (!existingId && !secretAccessKey) { showWarning('Secret Access Key is required'); return }

  try {
    showLoading(true)
    // Keep a single default.
    if (isDefault) {
      for (const c of state.compute) {
        if (c.default && c._id !== existingId) {
          await freezr.updateFields(TABLE_NAME, c._id, { default: false })
          c.default = false
        }
      }
    }

    const secret = { accessKeyId, arnRole }
    if (secretAccessKey) secret.secretAccessKey = secretAccessKey

    if (existingId) {
      if (secretAccessKey) {
        // full replace of the secret (new secret key provided)
        await freezr.update(TABLE_NAME, existingId, { type: 'compute', provider: 'aws', name, region, secret, default: isDefault })
      } else {
        // keep the stored secret key; update the non-secret fields + accessKeyId/arnRole only.
        // (Server re-encrypts whatever `secret` we send; without the secretAccessKey we'd lose it,
        //  so when blank we update only the plain fields and leave the existing record's secret.)
        await freezr.updateFields(TABLE_NAME, existingId, { name, region, default: isDefault })
      }
      state.compute = state.compute.map(c => c._id === existingId ? { ...c, name, region, default: isDefault, secret: { ...(c.secret || {}), accessKeyId, arnRole } } : c)
    } else {
      const params = { type: 'compute', provider: 'aws', name, region, secret, default: state.compute.length === 0 ? true : isDefault }
      const result = await freezr.create(TABLE_NAME, params)
      if (!result || result.error) throw new Error(result?.error || 'Error creating credential')
      state.compute.push({ _id: result._id, type: 'compute', provider: 'aws', name, region, default: params.default, secret: { accessKeyId, arnRole } })
    }

    showLoading(false)
    const overlay = document.getElementById('compute_overlay')
    if (overlay) overlay.style.display = 'none'
    redrawComputeList()
  } catch (e) {
    showLoading(false)
    showWarning(e.message || 'Error saving')
  }
}

const deleteCompute = async function () {
  const theId = document.getElementById('compute__id').value
  if (!theId) return
  if (!confirm('Delete this compute credential? Serverless jobs using it will stop running until you add another.')) return
  try {
    showLoading(true)
    await freezr.delete(TABLE_NAME, theId, {})
    state.compute = state.compute.filter(c => c._id !== theId)
    showLoading(false)
    const overlay = document.getElementById('compute_overlay')
    if (overlay) overlay.style.display = 'none'
    redrawComputeList()
  } catch (err) {
    showLoading(false)
    showWarning(err?.message || 'Error deleting credential')
  }
}

const setComputeDefault = async function (doc) {
  try {
    showLoading(true)
    for (const c of state.compute) {
      if (c.default && c._id !== doc._id) { await freezr.updateFields(TABLE_NAME, c._id, { default: false }); c.default = false }
    }
    await freezr.updateFields(TABLE_NAME, doc._id, { default: true })
    doc.default = true
    showLoading(false)
    redrawComputeList()
  } catch (err) {
    showLoading(false)
    showWarning(err?.message || 'Error setting default')
  }
}

const redrawComputeList = function () {
  if (!computeTable) return
  computeTable.innerHTML = ''
  if (state.compute.length === 0) {
    computeTable.innerHTML = '<p>No compute credentials yet. Click "Add AWS Credentials" to enable serverless jobs.</p>'
    return
  }
  state.compute.forEach(doc => {
    const row = document.createElement('div')
    row.className = 'gridlist'
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
    const akid = (doc.secret && typeof doc.secret.accessKeyId === 'string') ? doc.secret.accessKeyId : ''
    const maskedKey = akid ? (akid.slice(0, 4) + '…' + akid.slice(-4)) : 'key set'
    details.innerText = (doc.provider || 'aws') + ' · ' + (doc.region || '?') + ' · ' + maskedKey
    info.appendChild(details)
    row.appendChild(info)

    const actions = document.createElement('div')
    actions.style.cssText = 'display: flex; gap: 0.5rem; flex-wrap: wrap;'
    if (!doc.default) {
      const defaultBtn = document.createElement('span')
      defaultBtn.className = 'smallTextButt'
      defaultBtn.innerText = 'Set Default'
      defaultBtn.onclick = function () { setComputeDefault(doc) }
      actions.appendChild(defaultBtn)
    }
    const editBtn = document.createElement('span')
    editBtn.className = 'smallTextButt'
    editBtn.innerText = 'Edit'
    editBtn.onclick = function () { openComputeEditForm(doc) }
    actions.appendChild(editBtn)
    row.appendChild(actions)
    computeTable.appendChild(row)
  })
}

/* =====================================================================
 *  Connected Accounts section (Phase 1 Step 3)
 * =================================================================== */

// Create / edit moved to dedicated pages /connections/new and /connections/edit?name=...
// This file now only handles the LIST view + Disconnect action + URL-param banners.

const disconnectConnection = async function (doc) {
  if (!confirm('Disconnect "' + (doc.connectionName || 'this account') + '"? This will revoke the token and remove the connection from freezr. Any future apps trying to use it will fail until you reconnect.')) {
    return
  }
  try {
    showLoading(true)
    // Best-effort: server-side revoke + delete. We don't block on revoke failure — the local
    // record gets deleted either way so the user is "disconnected" from their perspective.
    const result = await freezr.apiRequest('POST', '/acctapi/connection_disconnect', { resource_id: doc._id })
    if (result && result.error) throw new Error(result.error)

    state.connections = state.connections.filter(c => c._id !== doc._id)
    redrawConnectionList()
    showSuccess('Disconnected ' + (doc.connectionName || 'account'))
  } catch (err) {
    console.warn('disconnect failed:', err)
    showWarning(err?.message || 'Could not disconnect — try refreshing the page.')
  } finally {
    showLoading(false)
  }
}

const redrawConnectionList = function () {
  if (!connectionTable) return
  connectionTable.innerHTML = ''

  const conns = state.connections

  if (conns.length === 0) {
    connectionTable.innerHTML = '<p>No connected accounts yet. Click "Connect Account" to authorize Gmail (and later, calendar/contacts on the same grant).</p>'
    return
  }

  conns.forEach(doc => {
    const row = document.createElement('div')
    row.className = 'gridlist'
    row.id = 'connRow_' + (doc.connectionName || doc._id)
    row.style.cssText = 'display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 0.75rem; padding: 0.75rem 0; border-bottom: 1px solid #e2e8f0;'

    const info = document.createElement('div')

    const nameSpan = document.createElement('span')
    nameSpan.style.fontWeight = '600'
    nameSpan.innerText = doc.connectionName || '(unnamed)'
    info.appendChild(nameSpan)

    const providerBadge = document.createElement('span')
    providerBadge.style.cssText = 'display: inline-block; margin-left: 0.5rem; padding: 0.1rem 0.5rem; background: #1e40af; color: white; border-radius: 4px; font-size: 0.75rem;'
    providerBadge.innerText = doc.provider || 'unknown'
    info.appendChild(providerBadge)

    const status = (doc.status || 'ok').toLowerCase()
    const statusBadge = document.createElement('span')
    if (status === 'ok') {
      statusBadge.style.cssText = 'display: inline-block; margin-left: 0.5rem; padding: 0.1rem 0.5rem; background: #059669; color: white; border-radius: 4px; font-size: 0.75rem;'
      statusBadge.innerText = 'connected'
    } else if (status === 'token_expired') {
      statusBadge.style.cssText = 'display: inline-block; margin-left: 0.5rem; padding: 0.1rem 0.5rem; background: #dc2626; color: white; border-radius: 4px; font-size: 0.75rem;'
      statusBadge.innerText = 'needs reconnect'
    } else {
      statusBadge.style.cssText = 'display: inline-block; margin-left: 0.5rem; padding: 0.1rem 0.5rem; background: #6b7280; color: white; border-radius: 4px; font-size: 0.75rem;'
      statusBadge.innerText = status
    }
    info.appendChild(statusBadge)

    const details = document.createElement('div')
    details.style.cssText = 'font-size: 0.85em; color: #64748b; margin-top: 0.25rem;'
    const services = Array.isArray(doc.services) ? doc.services : []
    const access = doc.access || {}
    const servicesText = services.length > 0
      ? services.map(s => s + ' (' + (access[s] === 'readwrite' ? 'read+write' : 'read') + ')').join(', ')
      : 'no services enabled'
    const emailText = doc.account_email ? (doc.account_email + ' · ') : ''
    details.innerText = emailText + servicesText
    info.appendChild(details)

    row.appendChild(info)

    const actions = document.createElement('div')
    actions.style.cssText = 'display: flex; gap: 0.5rem; flex-wrap: wrap;'

    const editLink = document.createElement('a')
    editLink.className = 'smallTextButt'
    editLink.innerText = (status === 'token_expired') ? 'Reconnect' : 'Edit'
    editLink.href = '/connections/edit?name=' + encodeURIComponent(doc.connectionName || '')
    actions.appendChild(editLink)

    const disconnectBtn = document.createElement('span')
    disconnectBtn.className = 'smallTextButt'
    disconnectBtn.style.color = '#dc2626'
    disconnectBtn.innerText = 'Disconnect'
    disconnectBtn.onclick = function () { disconnectConnection(doc) }
    actions.appendChild(disconnectBtn)

    row.appendChild(actions)
    connectionTable.appendChild(row)
  })
}

/* =====================================================================
 *  URL param handling: OAuth success banner, focus deep link
 * =================================================================== */

const handleUrlParams = function () {
  const params = new URLSearchParams(window.location.search)

  // Success banner after returning from a connection-purpose OAuth flow.
  if (params.get('success') === 'true' && params.get('purpose') === 'connection') {
    const connectionName = params.get('connectionName') || ''
    const actualServices = params.get('services') || ''   // server returns actually-granted services
    const downgradedRaw = params.get('downgraded') || ''   // JSON string from oauth controller if any service was downgraded
    let message = 'Connected ' + connectionName + ' successfully.'
    if (actualServices) message += ' Services enabled: ' + actualServices.split(',').join(', ') + '.'
    // Surface downgrades (e.g. user requested readwrite but only granted read for some service)
    // so the user isn't confused later when an app can't write what they thought they'd granted.
    if (downgradedRaw) {
      try {
        const items = JSON.parse(downgradedRaw)
        if (Array.isArray(items) && items.length > 0) {
          const summary = items.map(d => d.service + ' (asked ' + d.requested + ', got ' + d.effective + ')').join('; ')
          showWarning('Some services were not granted at the level requested: ' + summary + '. Reconnect to retry on Google’s consent screen.', 10000)
        }
      } catch (_) { /* malformed; ignore */ }
    }
    showSuccess(message)
    cleanUrlParams(['success', 'purpose', 'resource_id', 'connectionName', 'provider', 'services', 'downgraded'])
  }

  // ?focus=<connectionName> — scroll/highlight, auto-open reconnect if token_expired.
  const focusName = params.get('focus')
  if (focusName) {
    const target = state.connections.find(c => c.connectionName === focusName)
    if (target) {
      const rowEl = document.getElementById('connRow_' + focusName)
      if (rowEl) {
        rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
        const prevBg = rowEl.style.backgroundColor
        rowEl.style.backgroundColor = '#fef3c7'
        setTimeout(() => { rowEl.style.backgroundColor = prevBg }, 2200)
      }
      if ((target.status || '').toLowerCase() === 'token_expired') {
        // Connection needs reconnect — send the user straight to the dedicated edit page.
        // Brief delay so the highlight registers before the navigation.
        setTimeout(() => { window.location.href = '/connections/edit?name=' + encodeURIComponent(target.connectionName || '') }, 600)
      }
    }
    cleanUrlParams(['focus'])
  }
}

const cleanUrlParams = function (keys) {
  try {
    const url = new URL(window.location.href)
    keys.forEach(k => url.searchParams.delete(k))
    window.history.replaceState({}, document.title, url.toString())
  } catch (_) { /* non-critical */ }
}

/* =====================================================================
 *  Shared UI helpers
 * =================================================================== */

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

const showSuccess = function (msg, timing) {
  const div = document.getElementById('success_banner')
  if (!div) return
  if (!msg) {
    div.innerText = ''
    div.style.display = 'none'
    return
  }
  div.style.display = 'block'
  div.innerText = msg
  if (!timing) timing = 5000
  setTimeout(function () { showSuccess() }, timing)
}
