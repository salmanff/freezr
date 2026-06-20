// freezr - account_reset.js
// "Refresh storage credentials" page: re-enter the keys for the CURRENT cloud provider (FS and/or
// DB) and save them in place. Local/system/nedb storage has no credentials — shows a generic message.

/* global freezr */

let RESET_INFO = null

freezr.initPageScripts = function () {
  document.addEventListener('click', function (evt) {
    const args = (evt.target.id || '').split('_')
    if (args.length > 1 && args[0] === 'click') {
      if (args[1] === 'saveFS') saveResource('FS')
      else if (args[1] === 'saveDB') saveResource('DB')
    }
  })
  loadResetInfo()
}

function loadResetInfo () {
  freezr.apiRequest('GET', '/acctapi/account/resetInfo')
    .then(function (data) {
      RESET_INFO = data || {}
      const fs = data && data.fs
      const db = data && data.db
      let any = false
      if (fs && fs.refreshable) { any = true; text('fsLabel', fs.label || fs.choice); buildFields('fs_fields', fs.fields, 'fs'); show('fsSection') }
      if (db && db.refreshable) { any = true; text('dbLabel', db.label || db.choice); buildFields('db_fields', db.fields, 'db'); show('dbSection') }
      if (any) {
        show('passwordRow')
      } else {
        text('genericMsg', 'Your storage is on this server (local/host) or uses files-as-database (nedb), which has no credentials to refresh — there is nothing to do here.')
        show('genericMsg')
      }
    })
    .catch(function (err) { showError('Could not load storage info: ' + (err.message || err)) })
}

function buildFields (containerId, fields, prefix) {
  const el = document.getElementById(containerId)
  if (!el) return
  el.innerHTML = ''
  const table = document.createElement('table')
  ;(fields || []).forEach(function (f) {
    const row = document.createElement('tr')
    const c1 = document.createElement('td')
    c1.setAttribute('align', 'right'); c1.style.paddingRight = '8px'; c1.style.color = '#555'
    c1.innerHTML = f.display || f.name
    const c2 = document.createElement('td')
    const input = document.createElement('input')
    input.type = f.type || (f.secret ? 'password' : 'text')
    input.className = 'input'
    input.id = prefix + '_' + f.name
    if (f.type === 'checkbox') {
      input.checked = !!f.value
      if (f.locked) input.disabled = true
    } else {
      input.style.width = '300px'
      if (f.value) input.value = f.value
      if (f.secret) input.placeholder = '(leave blank to keep current)'
    }
    c2.appendChild(input)
    if (f.type === 'checkbox' && f.note) {
      const note = document.createElement('div')
      note.style.color = '#999'; note.style.fontSize = '0.85em'
      note.textContent = f.note
      c2.appendChild(note)
    }
    row.appendChild(c1); row.appendChild(c2)
    table.appendChild(row)
  })
  el.appendChild(table)
}

function saveResource (resource) {
  const info = resource === 'FS' ? (RESET_INFO && RESET_INFO.fs) : (RESET_INFO && RESET_INFO.db)
  if (!info || !info.refreshable) return
  const prefix = resource === 'FS' ? 'fs' : 'db'
  const password = document.getElementById('resetPassword').value
  if (!password) return showError('Please enter your password to save.')

  const params = {}
  ;(info.fields || []).forEach(function (f) {
    const el = document.getElementById(prefix + '_' + f.name)
    if (!el) return
    if (f.type === 'checkbox') {
      params[f.name] = el.checked
    } else {
      const v = el.value
      if (v != null && v.trim() !== '') params[f.name] = v.trim()
    }
  })

  showError('Checking and saving credentials…')
  freezr.apiRequest('PUT', '/acctapi/account/refreshCredentials', { resource: resource, params: params, password: password })
    .then(function () { showError((resource === 'FS' ? 'File-system' : 'Database') + ' credentials saved and verified.') })
    .catch(function (err) { showError('Could not save: ' + (err.message || err)) })
}

// ---- tiny dom helpers ----
function text (id, t) { const el = document.getElementById(id); if (el) el.textContent = t }
function show (id) { const el = document.getElementById(id); if (el) el.style.display = 'block' }
function showError (t) {
  const el = document.getElementById('errorBox')
  if (!el) return
  el.innerHTML = t || ''
  el.style.display = t ? 'block' : 'none'
}
