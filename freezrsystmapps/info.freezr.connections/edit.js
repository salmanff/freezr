// edit.js — /connections/edit?name=<connectionName>
// View + edit a single existing connection. Saving triggers a re-auth (because any
// services/access change means new scopes). Disconnect revokes + deletes.
//
// This page runs AS info.freezr.connections — which doesn't own
// info.freezr.account.resources — so it can't query that table directly. Instead
// it goes through /feps/connections/accounts, the type-agnostic permission-mediated
// listing endpoint the home page also uses.
/* global freezr confirm */

const SERVICES = ['mail', 'calendar', 'contacts', 'messaging']
// Which services each provider can cover — rows for others are hidden on render.
const SERVICES_BY_PROVIDER = {
  google: ['mail', 'calendar', 'contacts'],
  microsoft: ['mail', 'calendar', 'contacts'],
  imap: ['mail'],
  slack: ['messaging']
}

const state = {
  doc: null
}

const showWarning = function (msg) {
  const div = document.getElementById('warnings')
  if (!div) return
  if (!msg) { div.style.display = 'none'; return }
  div.style.display = 'block'
  div.innerText = msg
  window.scrollTo(0, 0)
}

freezr.initPageScripts = async function () {
  const params = new URLSearchParams(window.location.search)
  const connectionName = params.get('name') || ''
  if (!connectionName) {
    document.getElementById('notFound').style.display = 'block'
    return
  }

  // Load through the FEPS endpoint (permission-mediated), then filter client-side.
  try {
    const res = await freezr.apiRequest('GET', '/feps/connections/accounts')
    const accounts = (res && res.accounts) ? res.accounts : []
    state.doc = accounts.find(c => c && c.connectionName === connectionName) || null
  } catch (err) {
    showWarning('Could not load connection: ' + (err?.message || err))
    return
  }

  if (!state.doc) {
    document.getElementById('notFound').style.display = 'block'
    return
  }

  renderPanel()

  document.getElementById('button_saveAndReconnect').onclick = function () { reconnectWith({ applyChanges: true }) }
  document.getElementById('button_reconnect').onclick = function () { reconnectWith({ applyChanges: false }) }
  document.getElementById('button_disconnect').onclick = disconnectConnection
  document.getElementById('conn_live').onchange = toggleLiveUpdates
}

// Live updates (messaging connections): applied immediately via the server —
// unlike services/access, this needs no reconnect. The endpoint registers the
// connection in the socket-routing registry (or removes it).
const toggleLiveUpdates = async function () {
  const box = document.getElementById('conn_live')
  const statusEl = document.getElementById('live_status')
  const wanted = box.checked
  statusEl.innerText = 'Saving…'
  try {
    const res = await freezr.apiRequest('POST', '/acctapi/connection_set_live', { resource_id: state.doc._id, live: wanted })
    if (res && res.error) throw new Error(res.error)
    state.doc.live = wanted
    statusEl.innerText = wanted
      ? 'On — the server tracks activity for this connection (if the admin has sockets enabled).'
      : 'Off.'
  } catch (err) {
    box.checked = !wanted // revert
    statusEl.innerText = ''
    showWarning('Could not change live updates: ' + (err?.message || err))
  }
}

const renderPanel = function () {
  const d = state.doc
  document.getElementById('navTitle').innerText = 'Edit: ' + d.connectionName
  document.getElementById('title').innerText = 'Edit ' + d.connectionName
  document.getElementById('display_connectionName').innerText = d.connectionName || '(unnamed)'
  document.getElementById('display_provider').innerText = d.provider || '(unknown)'
  document.getElementById('display_email').innerText = d.account_email || '(not set)'
  const status = (d.status || 'ok').toLowerCase()
  let statusText = status
  if (status === 'token_expired') statusText = 'needs reconnect (token expired or revoked)'
  if (status === 'ok') statusText = 'connected'
  document.getElementById('display_status').innerText = statusText

  const services = Array.isArray(d.services) ? d.services : []
  const access = d.access || {}
  const available = SERVICES_BY_PROVIDER[d.provider] || SERVICES
  SERVICES.forEach(s => {
    const row = document.getElementById('conn_service_row_' + s)
    if (row) row.style.display = available.includes(s) ? 'flex' : 'none'
    document.getElementById('conn_service_' + s).checked = services.includes(s)
    const lvl = access[s] === 'readwrite' ? 'readwrite' : 'read'
    document.getElementById('conn_access_' + s).value = lvl
  })

  // Live-updates toggle only applies to messaging connections.
  if (services.includes('messaging')) {
    document.getElementById('live_updates_section').style.display = 'block'
    document.getElementById('conn_live').checked = d.live === true
    document.getElementById('live_status').innerText = d.live === true
      ? 'On — the server tracks activity for this connection (if the admin has sockets enabled).'
      : ''
  }

  document.getElementById('editPanel').style.display = 'block'
}

const reconnectWith = function ({ applyChanges }) {
  const d = state.doc
  // If applying changes, read the current form state; else use the saved doc.
  let services, accessByService
  if (applyChanges) {
    services = []
    accessByService = {}
    SERVICES.forEach(s => {
      if (document.getElementById('conn_service_' + s).checked) {
        services.push(s)
        accessByService[s] = document.getElementById('conn_access_' + s).value
      }
    })
    if (services.length === 0) { showWarning('Pick at least one service'); return }
  } else {
    services = Array.isArray(d.services) ? d.services.slice() : ['mail']
    accessByService = Object.assign({}, d.access || {})
  }

  const regcode = 'reconn_' + Math.random().toString(36).slice(2, 12)
  const params = new URLSearchParams({
    type: d.provider || 'google',
    sender: '/account/resources',
    regcode,
    purpose: 'connection',
    connectionName: d.connectionName,
    services: services.join(',')
  })
  services.forEach(s => params.set('access_' + s, accessByService[s] || 'read'))

  try { sessionStorage.setItem('lastConnAttempt', JSON.stringify({ regcode, connectionName: d.connectionName, isReconnect: true })) } catch (_) {}
  window.location.href = '/public/oauth/oauth_start_oauth?' + params.toString()
}

const disconnectConnection = async function () {
  const d = state.doc
  if (!confirm('Disconnect "' + d.connectionName + '"? Revokes the token at the provider and removes the connection from this freezr.')) return
  try {
    const res = await freezr.apiRequest('POST', '/acctapi/connection_disconnect', { resource_id: d._id })
    if (res && res.error) throw new Error(res.error)
    window.location.href = '/account/resources'
  } catch (err) {
    showWarning(err?.message || 'Could not disconnect')
  }
}
