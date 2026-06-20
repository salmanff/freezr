// calendar.js — info.freezr.connections / calendar viewer.
// Phase-1 read-only viewer for upcoming events on a chosen connection +
// calendar. Backed by freezr.connections.calendar.*; structure mirrors mail.js.
/* global freezr */

const state = {
  accounts: [],
  currentConnection: null,
  calendars: [],
  currentCalendar: 'primary',
  events: [],
  nextPageToken: null,
  rangeDays: 30
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
  document.getElementById('btnLoadMore').addEventListener('click', () => loadMore())
  document.getElementById('accountPicker').addEventListener('change', async (e) => {
    state.currentConnection = e.target.value
    await loadCalendars()
    await reload()
  })
  document.getElementById('calendarPicker').addEventListener('change', (e) => {
    state.currentCalendar = e.target.value
    reload()
  })
  document.getElementById('rangePicker').addEventListener('change', (e) => {
    state.rangeDays = Number(e.target.value) || 30
    reload()
  })

  showLoading(true)
  try {
    const res = await freezr.apiRequest('GET', '/feps/connections/accounts')
    const all = (res && res.accounts) ? res.accounts : []
    state.accounts = all.filter(a => Array.isArray(a.services) && a.services.includes('calendar'))
    populateAccountPicker()
    if (state.currentConnection) {
      await loadCalendars()
      await reload()
    } else {
      renderList()
    }
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
    opt.innerText = '(no calendar-enabled accounts)'
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

const loadCalendars = async () => {
  if (!state.currentConnection) return
  const sel = document.getElementById('calendarPicker')
  sel.innerHTML = ''
  try {
    const res = await freezr.connections.calendar.listCalendars({ connectionName: state.currentConnection })
    state.calendars = (res && res.calendars) ? res.calendars : []
    if (state.calendars.length === 0) {
      const opt = document.createElement('option')
      opt.value = 'primary'
      opt.innerText = 'primary'
      sel.appendChild(opt)
      state.currentCalendar = 'primary'
      return
    }
    state.calendars.forEach(c => {
      const opt = document.createElement('option')
      opt.value = c.id || 'primary'
      opt.innerText = (c.name || c.id || 'primary') + (c.isPrimary ? ' ★' : '')
      sel.appendChild(opt)
    })
    const primary = state.calendars.find(c => c.isPrimary)
    state.currentCalendar = (primary && primary.id) || state.calendars[0].id || 'primary'
    sel.value = state.currentCalendar
  } catch (err) {
    handleError(err, 'list calendars')
  }
}

const reload = async () => {
  if (!state.currentConnection) return
  state.events = []
  state.nextPageToken = null
  await fetchPage()
}

const fetchPage = async () => {
  showLoading(true)
  try {
    const now = Date.now()
    const before = now + state.rangeDays * 24 * 3600 * 1000
    const res = await freezr.connections.calendar.listEvents({
      connectionName: state.currentConnection,
      calendarId: state.currentCalendar,
      since: now,
      before,
      limit: 50,
      pageToken: state.nextPageToken || undefined
    })
    const got = (res && res.events) ? res.events : []
    state.events = state.events.concat(got)
    state.nextPageToken = res?.nextPageToken || null
    renderList()
  } catch (err) {
    handleError(err, 'list events')
  } finally {
    showLoading(false)
  }
}

const loadMore = () => fetchPage()

const renderList = () => {
  const list = document.getElementById('eventsList')
  list.innerHTML = ''
  if (!state.currentConnection) {
    list.innerHTML = '<p style="color:#64748b;">Pick an account.</p>'
    document.getElementById('loadMoreCard').style.display = 'none'
    return
  }
  if (state.events.length === 0) {
    list.innerHTML = '<p style="color:#64748b;">No upcoming events in this range.</p>'
    document.getElementById('loadMoreCard').style.display = 'none'
    return
  }
  state.events.forEach(ev => {
    const row = document.createElement('div')
    row.style.cssText = 'padding: 0.5rem 0.25rem; border-bottom: 1px solid #e2e8f0; cursor: pointer;'

    const title = document.createElement('div')
    title.style.fontWeight = '600'
    title.innerText = ev.title || '(no title)'
    row.appendChild(title)

    const when = document.createElement('div')
    when.style.cssText = 'font-size: 0.85em; color: #475569;'
    when.innerText = formatWhen(ev)
    row.appendChild(when)

    if (ev.location) {
      const loc = document.createElement('div')
      loc.style.cssText = 'font-size: 0.8em; color: #64748b;'
      loc.innerText = ev.location
      row.appendChild(loc)
    }

    row.addEventListener('click', () => showDetail(ev))
    list.appendChild(row)
  })
  document.getElementById('loadMoreCard').style.display = state.nextPageToken ? 'block' : 'none'
}

const formatWhen = (ev) => {
  if (!ev.startAt) return ''
  if (ev.isAllDay) {
    const d = new Date(ev.startAt)
    return d.toLocaleDateString() + ' (all day)'
  }
  return freezr.utils.longDateFormat(ev.startAt)
}

const showDetail = (ev) => {
  const det = document.getElementById('eventDetail')
  det.innerHTML = ''
  const h = document.createElement('h3')
  h.style.marginTop = '0'
  h.innerText = ev.title || '(no title)'
  det.appendChild(h)

  const when = document.createElement('div')
  when.style.cssText = 'color: #475569; margin-bottom: 0.5rem;'
  when.innerText = formatWhen(ev) + (ev.endAt && !ev.isAllDay ? ' → ' + freezr.utils.longDateFormat(ev.endAt) : '')
  det.appendChild(when)

  if (ev.location) {
    const loc = document.createElement('div')
    loc.style.cssText = 'margin-bottom: 0.5rem;'
    loc.innerHTML = '<strong>Where:</strong> '
    loc.appendChild(document.createTextNode(ev.location))
    det.appendChild(loc)
  }

  if (ev.organizer && (ev.organizer.address || ev.organizer.name)) {
    const org = document.createElement('div')
    org.style.cssText = 'margin-bottom: 0.5rem;'
    org.innerHTML = '<strong>Organizer:</strong> '
    org.appendChild(document.createTextNode([ev.organizer.name, ev.organizer.address].filter(Boolean).join(' <')))
    det.appendChild(org)
  }

  if (Array.isArray(ev.attendees) && ev.attendees.length > 0) {
    const t = document.createElement('div')
    t.style.cssText = 'font-weight: 600; margin-top: 0.5rem;'
    t.innerText = 'Attendees'
    det.appendChild(t)
    const ul = document.createElement('ul')
    ul.style.cssText = 'margin: 0.25rem 0; padding-left: 1.25rem;'
    ev.attendees.forEach(a => {
      const li = document.createElement('li')
      const parts = [a.name, a.address].filter(Boolean).join(' · ')
      li.innerText = parts + (a.responseStatus ? ' (' + a.responseStatus + ')' : '')
      ul.appendChild(li)
    })
    det.appendChild(ul)
  }

  if (ev.description) {
    const dh = document.createElement('div')
    dh.style.cssText = 'font-weight: 600; margin-top: 0.5rem;'
    dh.innerText = 'Description'
    det.appendChild(dh)
    const desc = document.createElement('pre')
    desc.style.cssText = 'white-space: pre-wrap; word-break: break-word; background: #f8fafc; padding: 0.5rem; border-radius: 4px;'
    desc.innerText = ev.description
    det.appendChild(desc)
  }

  if (ev.htmlLink) {
    const a = document.createElement('a')
    a.href = ev.htmlLink
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    a.innerText = 'Open in provider'
    a.style.display = 'inline-block'
    a.style.marginTop = '0.75rem'
    det.appendChild(a)
  }
}

const handleError = (err, label) => {
  if (freezr.connections.handleTokenExpired && freezr.connections.handleTokenExpired(err)) return
  if (err && err.data && err.data.error === 'token_expired') {
    showReauth(err.data.connectionName)
    return
  }
  console.error('calendar error (' + label + '):', err)
  showWarning((err && err.message) || String(err))
}
