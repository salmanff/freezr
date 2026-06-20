// contacts.js — info.freezr.connections / contacts viewer.
// Phase-1 read-only viewer for the user's contacts on a chosen connection.
// Backed by freezr.connections.contacts.*; structure mirrors mail.js but kept
// minimal (single list + detail pane, no folder/labels concept).
/* global freezr */

const escapeHtml = function (s) {
  if (s === null || s === undefined) return ''
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

const state = {
  accounts: [],
  currentConnection: null,
  contacts: [],
  nextPageToken: null,
  searchQuery: ''
}

const showLoading = (yes) => {
  const el = document.getElementById('loader')
  if (el) el.style.display = yes ? 'block' : 'none'
}

const showWarning = (msg) => {
  const div = document.getElementById('warnings')
  if (!div) return
  if (!msg) { div.style.display = 'none'; div.innerText = ''; return }
  div.style.display = 'block'
  div.innerText = msg
}

const showReauth = (connectionName) => {
  const div = document.getElementById('reauthBanner')
  if (!div) return
  div.innerHTML = ''
  const span = document.createElement('span')
  span.innerText = 'Connection "' + (connectionName || '') + '" needs to be reconnected. '
  div.appendChild(span)
  const a = document.createElement('a')
  a.href = '/account/resources?focus=' + encodeURIComponent(connectionName || '')
  a.innerText = 'Reconnect'
  div.appendChild(a)
  div.style.display = 'block'
}

// ---- Lifecycle ----

freezr.initPageScripts = async function () {
  document.getElementById('btnReload').addEventListener('click', () => reload())
  document.getElementById('btnSearch').addEventListener('click', () => doSearch())
  document.getElementById('btnLoadMore').addEventListener('click', () => loadMore())
  document.getElementById('accountPicker').addEventListener('change', (e) => {
    state.currentConnection = e.target.value
    reload()
  })
  document.getElementById('searchBox').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch()
  })

  showLoading(true)
  try {
    const res = await freezr.apiRequest('GET', '/feps/connections/accounts')
    const all = (res && res.accounts) ? res.accounts : []
    // Only accounts whose connection has 'contacts' in services[].
    state.accounts = all.filter(a => Array.isArray(a.services) && a.services.includes('contacts'))
    populateAccountPicker()
    if (state.currentConnection) await reload()
    else renderList()
  } catch (err) {
    handleError(err, 'load accounts')
  } finally {
    showLoading(false)
  }
}

const populateAccountPicker = () => {
  const sel = document.getElementById('accountPicker')
  sel.innerHTML = ''
  if (state.accounts.length === 0) {
    const opt = document.createElement('option')
    opt.value = ''
    opt.innerText = '(no contacts-enabled accounts)'
    sel.appendChild(opt)
    state.currentConnection = null
    return
  }
  state.accounts.forEach((a, i) => {
    const opt = document.createElement('option')
    opt.value = a.connectionName
    opt.innerText = a.connectionName + (a.account_email ? ' (' + a.account_email + ')' : '')
    sel.appendChild(opt)
    if (i === 0 && !state.currentConnection) state.currentConnection = a.connectionName
  })
  sel.value = state.currentConnection
}

const reload = async () => {
  if (!state.currentConnection) return
  state.contacts = []
  state.nextPageToken = null
  state.searchQuery = ''
  document.getElementById('searchBox').value = ''
  await fetchPage()
}

const fetchPage = async () => {
  showLoading(true)
  try {
    const res = await freezr.connections.contacts.listContacts({
      connectionName: state.currentConnection,
      pageToken: state.nextPageToken || undefined,
      limit: 100
    })
    const got = (res && res.contacts) ? res.contacts : []
    state.contacts = state.contacts.concat(got)
    state.nextPageToken = res?.nextPageToken || null
    renderList()
  } catch (err) {
    handleError(err, 'list contacts')
  } finally {
    showLoading(false)
  }
}

const doSearch = async () => {
  const q = (document.getElementById('searchBox').value || '').trim()
  if (!q) { return reload() }
  state.searchQuery = q
  state.contacts = []
  state.nextPageToken = null
  showLoading(true)
  try {
    const res = await freezr.connections.contacts.searchContacts({
      connectionName: state.currentConnection,
      query: q,
      limit: 30
    })
    state.contacts = (res && res.contacts) ? res.contacts : []
    renderList()
  } catch (err) {
    handleError(err, 'search contacts')
  } finally {
    showLoading(false)
  }
}

const loadMore = () => fetchPage()

const renderList = () => {
  const list = document.getElementById('contactsList')
  list.innerHTML = ''
  if (!state.currentConnection) {
    list.innerHTML = '<p style="color:#64748b;">Pick an account.</p>'
    document.getElementById('loadMoreCard').style.display = 'none'
    return
  }
  if (state.contacts.length === 0) {
    list.innerHTML = '<p style="color:#64748b;">No contacts found.</p>'
    document.getElementById('loadMoreCard').style.display = 'none'
    return
  }
  state.contacts.forEach(c => {
    const row = document.createElement('div')
    row.style.cssText = 'padding: 0.5rem 0.25rem; border-bottom: 1px solid #e2e8f0; cursor: pointer;'
    row.dataset.contactId = c.id || ''
    const name = document.createElement('div')
    name.style.fontWeight = '600'
    name.innerText = c.displayName || c.givenName || c.familyName || '(no name)'
    row.appendChild(name)
    const emails = Array.isArray(c.emails) ? c.emails.map(e => e.address).filter(Boolean) : []
    if (emails.length > 0) {
      const em = document.createElement('div')
      em.style.cssText = 'font-size: 0.85em; color: #64748b;'
      em.innerText = emails.join(', ')
      row.appendChild(em)
    }
    row.addEventListener('click', () => showDetail(c))
    list.appendChild(row)
  })
  document.getElementById('loadMoreCard').style.display = (state.nextPageToken && !state.searchQuery) ? 'block' : 'none'
}

const showDetail = (c) => {
  const det = document.getElementById('contactDetail')
  det.innerHTML = ''
  const h = document.createElement('h3')
  h.style.marginTop = '0'
  h.innerText = c.displayName || c.givenName || '(no name)'
  det.appendChild(h)

  if (c.organization && (c.organization.name || c.organization.title)) {
    const o = document.createElement('div')
    o.style.cssText = 'color: #475569; margin-bottom: 0.5rem;'
    o.innerText = [c.organization.title, c.organization.name].filter(Boolean).join(' · ')
    det.appendChild(o)
  }

  const addBlock = (title, items, fmt) => {
    if (!items || items.length === 0) return
    const t = document.createElement('div')
    t.style.cssText = 'font-weight: 600; margin-top: 0.5rem;'
    t.innerText = title
    det.appendChild(t)
    const ul = document.createElement('ul')
    ul.style.cssText = 'margin: 0.25rem 0; padding-left: 1.25rem;'
    items.forEach(it => {
      const li = document.createElement('li')
      li.innerText = fmt(it)
      ul.appendChild(li)
    })
    det.appendChild(ul)
  }

  addBlock('Emails', c.emails, e => e.address + (e.type ? ' (' + e.type + ')' : '') + (e.primary ? ' ★' : ''))
  addBlock('Phones', c.phones, p => p.number + (p.type ? ' (' + p.type + ')' : '') + (p.primary ? ' ★' : ''))

  if (c.updatedAt) {
    const u = document.createElement('div')
    u.style.cssText = 'font-size: 0.8em; color: #94a3b8; margin-top: 0.75rem;'
    u.innerText = 'Last updated: ' + freezr.utils.longDateFormat(c.updatedAt)
    det.appendChild(u)
  }
}

const handleError = (err, label) => {
  if (freezr.connections.handleTokenExpired && freezr.connections.handleTokenExpired(err)) return
  if (err && err.data && err.data.error === 'token_expired') {
    showReauth(err.data.connectionName)
    return
  }
  console.error('contacts error (' + label + '):', err)
  showWarning((err && err.message) || String(err))
}
