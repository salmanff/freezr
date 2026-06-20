// index.js — info.freezr.connections home page.
// Lists the user's connected accounts. Per-service viewers (mail, future
// calendar / contacts) live at /connections/<service>.
//
// Account listing goes through /feps/connections/accounts (type-agnostic,
// returns any connection the calling app has any use_* perm for).
/* global freezr */

const escapeHtml = function (s) {
  if (s === null || s === undefined) return ''
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

const showLoading = function (yes) {
  const loader = document.getElementById('loader')
  if (loader) loader.style.display = yes ? 'block' : 'none'
}

const showWarning = function (msg) {
  const div = document.getElementById('warnings')
  if (!div) return
  if (!msg) { div.style.display = 'none'; return }
  div.style.display = 'block'
  div.innerText = msg
}

freezr.initPageScripts = async function () {
  showLoading(true)
  try {
    const res = await freezr.apiRequest('GET', '/feps/connections/accounts')
    const accounts = (res && res.accounts) ? res.accounts : []
    renderConnections(accounts)
  } catch (err) {
    // 403 typically means use_mail isn't granted (shouldn't happen for the
    // system app via systemPermissions.json, but be defensive).
    if (err && (err.status === 403 || /use_mail/i.test(err.message || ''))) {
      renderConnections([])
      showWarning('Could not load connections — permission missing. Open Account Settings → Apps → info.freezr.connections and grant access.')
    } else if (err && err.data && err.data.error === 'token_expired') {
      // Surface the reauth link inline rather than a bare error message.
      showWarning('One of your connections needs to be reconnected: ' + (err.data.connectionName || '') + '. Go to /account/resources to reauthorize.')
      renderConnections([])
    } else {
      showWarning(err?.message || String(err))
      renderConnections([])
    }
  } finally {
    showLoading(false)
  }
}

const renderConnections = function (accounts) {
  const list = document.getElementById('connectionsList')
  list.innerHTML = ''

  if (!accounts || accounts.length === 0) {
    list.innerHTML =
      '<p>No connections yet. ' +
      '<a href="/account/resources">Connect a Google account at /account/resources</a> ' +
      'to get started.</p>'
    return
  }

  accounts.forEach(a => {
    const row = document.createElement('div')
    row.style.cssText = 'display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 0.75rem; padding: 0.75rem 0; border-bottom: 1px solid #e2e8f0;'

    const info = document.createElement('div')

    const nameSpan = document.createElement('span')
    nameSpan.style.fontWeight = '600'
    nameSpan.innerText = a.connectionName || '(unnamed)'
    info.appendChild(nameSpan)

    const providerBadge = document.createElement('span')
    providerBadge.style.cssText = 'display: inline-block; margin-left: 0.5rem; padding: 0.1rem 0.5rem; background: #1e40af; color: white; border-radius: 4px; font-size: 0.75rem;'
    providerBadge.innerText = a.provider || 'unknown'
    info.appendChild(providerBadge)

    const status = (a.status || 'ok').toLowerCase()
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
    const services = Array.isArray(a.services) ? a.services : []
    const access = a.access || {}
    const servicesText = services.length > 0
      ? services.map(s => s + ' (' + (access[s] === 'readwrite' ? 'read+write' : 'read') + ')').join(', ')
      : 'no services enabled'
    const emailText = a.account_email ? (a.account_email + ' · ') : ''
    details.innerText = emailText + servicesText
    info.appendChild(details)

    row.appendChild(info)

    // Per-service action links. Each per-service page picks the connection
    // itself via /feps/connections/accounts — the link is just a navigation
    // hint and we surface one per service the connection actually has.
    const actions = document.createElement('div')
    actions.style.cssText = 'display: flex; gap: 0.5rem; flex-wrap: wrap;'

    if (services.includes('mail')) {
      const openMail = document.createElement('a')
      openMail.className = 'smallTextButt'
      openMail.href = '/connections/mail'
      openMail.innerText = 'Open Mail'
      actions.appendChild(openMail)
    }
    if (services.includes('contacts')) {
      const openContacts = document.createElement('a')
      openContacts.className = 'smallTextButt'
      openContacts.href = '/connections/contacts'
      openContacts.innerText = 'Open Contacts'
      actions.appendChild(openContacts)
    }
    if (services.includes('calendar')) {
      const openCal = document.createElement('a')
      openCal.className = 'smallTextButt'
      openCal.href = '/connections/calendar'
      openCal.innerText = 'Open Calendar'
      actions.appendChild(openCal)
    }

    if (status === 'token_expired') {
      const reconnect = document.createElement('a')
      reconnect.className = 'smallTextButt'
      reconnect.style.color = '#dc2626'
      reconnect.href = '/account/resources?focus=' + encodeURIComponent(a.connectionName || '')
      reconnect.innerText = 'Reconnect'
      actions.appendChild(reconnect)
    }

    row.appendChild(actions)
    list.appendChild(row)
  })
}
