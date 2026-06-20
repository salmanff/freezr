/* global freezr */
// Admin Console Logs - toggle runtime console-log categories (in-memory, non-persistent)

freezr.initPageScripts = function () {
  loadFlags()
  document.getElementById('saveFlags').onclick = saveFlags
}

const loadFlags = async function () {
  try {
    const data = await freezr.apiRequest('GET', '/adminapi/get_console_flags')
    renderFlags(data.categories || [], data.flags || {}, data.serverStartedAt)
    showError('')
  } catch (error) {
    showError('Could not load console flags: ' + (error?.message || error))
  }
}

const renderFlags = function (categories, flags, serverStartedAt) {
  document.getElementById('serverStartedAt').textContent = serverStartedAt || 'unknown'

  const list = document.getElementById('categoryList')
  list.innerHTML = ''
  categories.forEach(function (cat) {
    const row = document.createElement('label')
    row.style.cssText = 'display: flex; align-items: flex-start; gap: 0.6rem; margin-bottom: 1rem; cursor: pointer;'

    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.id = 'flag_' + cat.key
    checkbox.checked = !!flags[cat.key]
    checkbox.style.marginTop = '0.2rem'

    const text = document.createElement('div')
    text.innerHTML = '<strong>' + cat.label + '</strong><br/>' +
      '<span style="color: var(--freezr-text-muted); font-size: 14px;">' + (cat.description || '') + '</span>'

    row.appendChild(checkbox)
    row.appendChild(text)
    list.appendChild(row)
  })
}

const saveFlags = async function () {
  const flags = {}
  document.querySelectorAll('#categoryList input[type="checkbox"]').forEach(function (cb) {
    flags[cb.id.replace('flag_', '')] = cb.checked
  })
  try {
    await freezr.apiRequest('POST', '/adminapi/set_console_flags', { flags })
    setStatus('Saved.')
    loadFlags() // re-fetch to reflect the server's applied state
  } catch (error) {
    showError('Could not save console flags: ' + (error?.message || error))
  }
}

const setStatus = function (text) {
  const el = document.getElementById('statusMsg')
  if (el) el.textContent = text || ''
}

const showError = function (text) {
  const errorBox = document.getElementById('errorBox')
  if (!errorBox) return
  errorBox.style.display = text ? 'block' : 'none'
  errorBox.innerHTML = text || ''
}
