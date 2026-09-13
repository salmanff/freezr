// account_resourceusage.js — the Resource Usage page, shared by /account/resourceusage and
// (via the admin manifest) /admin/resourceusage?user=<id>.
//
// Two tabs, each responsible for its own data:
//   AI & LLM costs — info.freezr.account.usageTallies, via /acctapi/getUsageTallies or the
//                    admin twin /adminapi/get_usage_tallies. Cheap; loads first, and is the
//                    default tab.
//   Storage        — userDS.getStorageUse(), which walks the whole store and can take many
//                    seconds. It is never allowed to hold up the page: the fetch starts only
//                    after the LLM view has rendered, or immediately if the user opens the
//                    Storage tab before that. (The page also has no initial_query_func, so
//                    the same calculation no longer runs server-side before the HTML is sent.)

/* global freezr, location */

const state = {
  targetUser: null,
  storagePromise: null
}

function getUrlUser () {
  const params = new URLSearchParams((typeof location !== 'undefined' && location.search) || '')
  return params.get('user') || null
}

// ===== tiny DOM helper =====
// el('div', { class, text, html, title, style, attrs }, [children])
function el (tag, opts, children) {
  const node = document.createElement(tag)
  const o = opts || {}
  if (o.class) node.className = o.class
  if (o.text !== undefined) node.textContent = o.text
  if (o.html !== undefined) node.innerHTML = o.html
  if (o.title) node.title = o.title
  if (o.style) { for (const [k, v] of Object.entries(o.style)) node.style[k] = v }
  if (o.attrs) { for (const [k, v] of Object.entries(o.attrs)) node.setAttribute(k, v) }
  if (o.onClick) node.addEventListener('click', o.onClick)
  ;(children || []).forEach(child => { if (child) node.appendChild(child) })
  return node
}

function showSpinner (container) {
  if (!container) return
  const wrap = el('div', { class: 'freezr-spinner-overlay', attrs: { 'data-resource-spinner': '1' } }, [
    el('div', { class: 'freezr-spinner' })
  ])
  container.appendChild(wrap)
}

function removeSpinner (container) {
  if (!container) return
  const found = container.querySelector('[data-resource-spinner="1"]')
  if (found) found.remove()
}

function emptyState (title, detail) {
  return el('div', { class: 'fz-empty-state' }, [
    el('div', { class: 'fz-empty-title', text: title }),
    detail ? el('div', { text: detail }) : null
  ])
}

// ===== formatting =====
// Sub-cent amounts are the norm for one app on one day, so 2dp would render every real
// cost as $0.00 — hence the extra precision at the small end.
const showUsd = function (amount) {
  const num = Number(amount) || 0
  if (num === 0) return '$0'
  if (num < 0.01) return '$' + num.toFixed(5)
  if (num < 1) return '$' + num.toFixed(4)
  return '$' + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
const showCount = function (num) {
  return (Number(num) || 0).toLocaleString()
}
const pluralRequests = function (num) {
  return showCount(num) + (Number(num) === 1 ? ' request' : ' requests')
}
const showCompact = function (num) {
  const n = Number(num) || 0
  if (n >= 1000000) return (Math.round(n / 100000) / 10).toLocaleString() + 'M'
  if (n >= 10000) return Math.round(n / 1000).toLocaleString() + 'k'
  return n.toLocaleString()
}
const showSize = function (bytes) {
  if (!bytes) return '0'
  if (isNaN(bytes)) return bytes
  if (bytes >= 1000000) return ((Math.round(bytes / 10000) / 100).toLocaleString() + 'Mbs')
  if (bytes >= 1000) return ((Math.round(bytes / 100) / 10).toLocaleString() + 'kbs')
  return bytes.toLocaleString() + 'b'
}
const getNum = function (bytes) {
  if (!bytes) return 0
  if (isNaN(bytes)) return 0
  return bytes
}

// ===== page entry =====
freezr.initPageScripts = async function () {
  state.targetUser = getUrlUser()

  const userLabelEl = document.getElementById('resource_usage_user_label')
  if (state.targetUser && userLabelEl) {
    userLabelEl.style.display = 'block'
    userLabelEl.textContent = 'Viewing usage for: ' + state.targetUser
  }

  setUpTabs()

  const rangeEl = document.getElementById('usage_range')
  if (rangeEl) rangeEl.addEventListener('change', () => loadMeteredUsage(rangeEl.value))

  // LLM first (it is the visible tab and the cheap query), then storage in the background.
  await loadMeteredUsage(rangeEl ? rangeEl.value : '30')
  ensureStorageLoaded()
}

function setUpTabs () {
  const openTab = (name) => {
    const panes = document.getElementsByClassName('tabcontent')
    for (let i = 0; i < panes.length; i++) panes[i].style.display = 'none'
    const links = document.getElementsByClassName('tablinks')
    for (let i = 0; i < links.length; i++) links[i].classList.remove('active')
    const pane = document.getElementById('tab_' + name)
    const button = document.getElementById('button_tabs_' + name)
    if (pane) pane.style.display = 'block'
    if (button) button.classList.add('active')
    // Opening Storage is what triggers its fetch if the background prefetch has not run yet.
    if (name === 'storage') ensureStorageLoaded()
  }

  const llmButton = document.getElementById('button_tabs_llm')
  const storageButton = document.getElementById('button_tabs_storage')
  if (llmButton) llmButton.addEventListener('click', () => openTab('llm'))
  if (storageButton) storageButton.addEventListener('click', () => openTab('storage'))
  openTab('llm')
}

// ===== AI & LLM costs =====
const meteredUsageQuery = function (range) {
  if (range === 'month') {
    return 'from=' + new Date().toISOString().slice(0, 8) + '01'
  }
  return 'days=' + encodeURIComponent(range || '30')
}

const loadMeteredUsage = async function (range) {
  const container = document.getElementById('metered_usage')
  if (!container) return
  container.innerHTML = ''
  showSpinner(container)
  try {
    const query = meteredUsageQuery(range)
    const data = state.targetUser
      ? await freezr.apiRequest('GET', '/adminapi/get_usage_tallies?user=' + encodeURIComponent(state.targetUser) + '&' + query)
      : await freezr.apiRequest('GET', '/acctapi/getUsageTallies?' + query)
    removeSpinner(container)
    container.innerHTML = ''
    drawMeteredUsage(container, data)
  } catch (error) {
    removeSpinner(container)
    console.error('[resourceusage] getUsageTallies error', error)
    container.innerHTML = ''
    container.appendChild(emptyState('Could not read usage tallies', error && error.message ? error.message : ''))
  }
}

const drawMeteredUsage = function (container, data) {
  const summary = data && data.summary
  const rangeLabel = (data && data.from) ? (data.from + ' → ' + data.to + ', UTC days') : ''

  if (!summary || !summary.total || !summary.total.requests) {
    container.appendChild(emptyState(
      'No AI usage recorded in this period',
      'Tallies appear here as soon as an app makes an LLM call with one of your API keys.'))
    if (rangeLabel) container.appendChild(el('div', { class: 'fz-note', style: { 'text-align': 'center' }, text: rangeLabel }))
    return
  }

  const total = summary.total
  const perRequest = total.requests ? (total.cost.total / total.requests) : 0

  // --- headline stats
  container.appendChild(el('div', { class: 'fz-stat-row' }, [
    statTile(showUsd(total.cost.total), 'Estimated cost', rangeLabel, true),
    statTile(showCount(total.requests), 'Requests', showUsd(perRequest) + ' per request'),
    statTile(showCompact(total.tokens.total), 'Tokens', showCompact(total.tokens.input) + ' in / ' + showCompact(total.tokens.output) + ' out'),
    statTile(showCount((summary.byKey || []).length), (summary.byKey || []).length === 1 ? 'API key used' : 'API keys used',
      (summary.byVendor || []).map(v => v.vendor).join(', '))
  ]))

  // --- caveats, only when they apply
  const notes = []
  if (total.cost_source === 'provider_reported') {
    notes.push({ text: 'Costs as reported by the provider.' })
  } else if (total.cost_source === 'mixed') {
    notes.push({ text: 'Some costs are provider-reported, others estimated from freezr\'s cached price table.' })
  } else {
    notes.push({ text: 'Costs are estimated from freezr\'s cached price table, not billed amounts.' })
  }
  if (total.unpriced_requests) notes.push({ warn: true, text: pluralRequests(total.unpriced_requests) + ' could not be priced — no price was found for the model, so the cost shows as unknown.' })
  if (total.unmetered_requests) notes.push({ warn: true, text: pluralRequests(total.unmetered_requests) + ' reported no token usage, so ' + (total.unmetered_requests === 1 ? 'it is' : 'they are') + ' counted but add no cost.' })
  if (total.errors) notes.push({ warn: true, text: pluralRequests(total.errors) + ' failed.' })
  if (total.aborted) notes.push({ warn: true, text: pluralRequests(total.aborted) + ' ' + (total.aborted === 1 ? 'was' : 'were') + ' cancelled mid-answer.' })
  notes.forEach(note => container.appendChild(el('div', { class: 'fz-note' + (note.warn ? ' fz-note-warn' : ''), text: note.text })))

  // --- day by day
  const byDay = summary.byDay || []
  if (byDay.length > 0 && data.from && data.to) {
    container.appendChild(el('div', { class: 'fz-section-title', text: 'Cost per day' }))
    container.appendChild(dayBars(byDay, data.from, data.to))
  }

  // --- per API key. The question multiple keys exist to answer; for an aggregator key
  // (one key, several upstream vendors) this is also where the vendor split shows up.
  const groups = summary.byAppKeyVendor || []
  const byKey = summary.byKey || []
  if (byKey.length > 0) {
    container.appendChild(el('div', { class: 'fz-section-title', text: byKey.length === 1 ? 'API key' : 'By API key' }))
    const maxKeyCost = Math.max.apply(null, byKey.map(k => k.cost.total).concat([0]))
    const keyWrap = el('div', { class: 'fz-keys' })
    byKey.forEach(key => {
      const vendors = vendorSplitFor(groups, key.resource_id)
      keyWrap.appendChild(el('div', { class: 'fz-key' }, [
        el('div', { class: 'fz-key-name', text: key.resource_name || key.provider || ('key ' + (key.resource_id || 'unknown')) }),
        el('div', { class: 'fz-key-provider', text: key.provider || '' }),
        el('div', { class: 'fz-key-cost', text: showUsd(key.cost.total) }),
        el('div', { class: 'fz-note', text: showCount(key.requests) + ' requests · ' + showCompact(key.tokens.total) + ' tokens' }),
        bar(key.cost.total, maxKeyCost),
        vendors.length > 1
          ? el('div', { class: 'fz-chips' }, vendors.map(v => el('span', { class: 'fz-chip', text: v.vendor + ' ' + showUsd(v.cost) })))
          : null
      ]))
    })
    container.appendChild(keyWrap)
  }

  // --- the table: one line per app + key + vendor, expandable to its models
  if (groups.length > 0) {
    const showVendor = byKey.some(key => vendorSplitFor(groups, key.resource_id).length > 1)
    container.appendChild(el('div', { class: 'fz-section-title', text: 'By app and key' }))
    container.appendChild(usageTable(groups, total, showVendor))
    container.appendChild(el('div', { class: 'fz-note', text: 'Click a row to see the models it used.' }))
  }
}

// A zero cost means two different things: nothing was spent, or nothing could be priced.
// Showing '$0' for the second is misleading, so an unpriced/unmetered row reads as unknown.
const costCell = function (group) {
  const unknown = group.cost.total === 0 && (group.unpriced_requests || group.unmetered_requests)
  if (!unknown) return el('td', { text: showUsd(group.cost.total) })
  return el('td', {
    text: '—',
    title: group.unpriced_requests
      ? 'No price found for this model, so the cost is unknown.'
      : 'The provider reported no token usage, so the cost is unknown.'
  })
}

const statTile = function (value, label, sub, accent) {
  return el('div', { class: 'fz-stat' }, [
    el('div', { class: 'fz-stat-value' + (accent ? ' fz-accent' : ''), text: value }),
    el('div', { class: 'fz-stat-label', text: label }),
    sub ? el('div', { class: 'fz-stat-sub', text: sub }) : null
  ])
}

const bar = function (value, max) {
  const pct = (max > 0) ? Math.max(2, Math.round((value / max) * 100)) : 0
  return el('div', { class: 'fz-bar' }, [el('div', { class: 'fz-bar-fill', style: { width: pct + '%' } })])
}

const vendorSplitFor = function (groups, resourceId) {
  const totals = {}
  groups
    .filter(g => String(g.resource_id) === String(resourceId))
    .forEach(g => { totals[g.vendor] = (totals[g.vendor] || 0) + g.cost.total })
  return Object.entries(totals)
    .map(([vendor, cost]) => ({ vendor, cost }))
    .sort((a, b) => b.cost - a.cost)
}

// A bar per calendar day across the whole range, so quiet days read as gaps rather than
// being silently dropped (only days with usage have a tally row).
const MAX_DAY_BARS = 120
const dayBars = function (byDay, from, to) {
  const costs = {}
  const requests = {}
  byDay.forEach(day => {
    costs[day.date] = day.cost.total
    requests[day.date] = day.requests
  })
  // Stepped in whole UTC days: a fixed 24h step is exact in UTC (no DST to trip over).
  const DAY_MS = 24 * 60 * 60 * 1000
  const days = []
  const endMs = Date.parse(to + 'T00:00:00.000Z')
  for (let ms = Date.parse(from + 'T00:00:00.000Z'); ms <= endMs && days.length < MAX_DAY_BARS; ms += DAY_MS) {
    days.push(new Date(ms).toISOString().slice(0, 10))
  }
  const max = Math.max.apply(null, Object.values(costs).concat([0]))

  const bars = el('div', { class: 'fz-daybars' }, days.map(date => {
    const cost = costs[date] || 0
    const height = (max > 0 && cost > 0) ? Math.max(4, Math.round((cost / max) * 60)) : 1
    return el('div', {
      class: 'fz-daybar' + (cost > 0 ? '' : ' fz-daybar-empty'),
      style: { height: height + 'px' },
      title: date + (cost > 0 ? (' · ' + showUsd(cost) + ' · ' + showCount(requests[date]) + ' requests') : ' · no usage')
    })
  }))

  return el('div', null, [
    bars,
    el('div', { class: 'fz-axis' }, [
      el('span', { text: days[0] || from }),
      el('span', { text: 'peak day ' + showUsd(max) }),
      el('span', { text: days[days.length - 1] || to })
    ])
  ])
}

const usageTable = function (groups, total, showVendor) {
  const headers = [{ label: 'App', left: true }, { label: 'Key', left: true }]
  if (showVendor) headers.push({ label: 'Vendor', left: true })
  headers.push({ label: 'Requests' }, { label: 'In' }, { label: 'Out' }, { label: 'Other' }, { label: 'Cost' })

  const table = el('table', { class: 'fz-table' })
  const thead = el('thead', null, [el('tr', null, headers.map(h =>
    el('th', { class: h.left ? 'fz-l' : '', text: h.label })))])
  table.appendChild(thead)

  const tbody = el('tbody')
  groups.forEach(group => {
    const models = group.models || []
    const caret = el('span', { class: 'fz-caret', text: models.length ? '▸' : '' })

    const cells = [
      el('td', { class: 'fz-l' }, [caret, el('span', { text: ' ' + group.app_name })]),
      el('td', { class: 'fz-l', text: group.resource_name || group.provider || ('key ' + (group.resource_id || '?')) })
    ]
    if (showVendor) cells.push(el('td', { class: 'fz-l', text: group.vendor || '' }))
    cells.push(
      el('td', { text: showCount(group.requests) }),
      el('td', { text: showCompact(group.tokens.input) }),
      el('td', { text: showCompact(group.tokens.output) }),
      el('td', { text: showCompact(group.tokens.other) }),
      costCell(group)
    )

    const detail = el('tr', { class: 'fz-detail', style: { display: 'none' } }, [
      el('td', { attrs: { colspan: String(headers.length) } },
        models.length
          ? models.map(model => el('div', { class: 'fz-detail-line' }, [
            el('span', { class: 'fz-mono', text: model.model }),
            el('span', { text: showCount(model.requests) + ' × · ' + showCompact(model.tokens.total) + ' tokens · ' + showUsd(model.cost.total) })
          ]))
          : [el('div', { text: 'No per-model detail recorded.' })])
    ])

    const row = el('tr', {
      class: models.length ? 'fz-clickable' : '',
      onClick: models.length
        ? () => {
            const open = detail.style.display !== 'none'
            detail.style.display = open ? 'none' : 'table-row'
            caret.textContent = open ? '▸' : '▾'
          }
        : null
    }, cells)

    tbody.appendChild(row)
    tbody.appendChild(detail)
  })
  table.appendChild(tbody)

  if (groups.length > 1) {
    const footCells = [el('td', { class: 'fz-l', text: 'Total' }), el('td')]
    if (showVendor) footCells.push(el('td'))
    footCells.push(
      el('td', { text: showCount(total.requests) }),
      el('td', { text: showCompact(total.tokens.input) }),
      el('td', { text: showCompact(total.tokens.output) }),
      el('td', { text: showCompact(total.tokens.other) }),
      el('td', { text: showUsd(total.cost.total) })
    )
    table.appendChild(el('tfoot', null, [el('tr', null, footCells)]))
  }

  return el('div', { class: 'fz-table-wrap' }, [table])
}

// ===== Storage =====
// Started at most once, either by the background prefetch after the LLM view renders or by
// the user opening the Storage tab — whichever happens first.
function ensureStorageLoaded () {
  if (!state.storagePromise) state.storagePromise = loadStorageUsage()
  return state.storagePromise
}

const loadStorageUsage = async function () {
  const container = document.getElementById('app_list')
  if (!container) return
  container.innerHTML = ''
  showSpinner(container)
  try {
    const data = state.targetUser
      ? await freezr.apiRequest('GET', '/adminapi/getuserappresources?user=' + encodeURIComponent(state.targetUser))
      : await freezr.utils.getAppResourceUsage(null)
    removeSpinner(container)
    container.innerHTML = ''
    drawStorageUsage(container, data)
  } catch (error) {
    removeSpinner(container)
    console.error('[resourceusage] getAppResourceUsage error', error)
    container.innerHTML = ''
    container.appendChild(emptyState('Could not calculate storage use', error && error.message ? error.message : ''))
  }
}

const drawStorageUsage = function (container, data) {
  const resources = (data && data.resources) || []
  if (resources.length === 0) {
    container.appendChild(emptyState(
      'No app storage in use',
      state.targetUser ? 'This user has no app resources yet.' : 'Install an app and its storage will show up here.'))
    return
  }

  const rows = resources.map(resource => {
    const dbs = Object.entries(resource.dbs || {}).map(([name, size]) => ({ name, size: getNum(size) }))
    const dbTotal = dbs.reduce((sum, db) => sum + db.size, 0)
    return {
      appName: resource.appName,
      apps: getNum(resource.apps),
      files: getNum(resource.files),
      dbs: dbs.sort((a, b) => b.size - a.size),
      dbTotal,
      total: getNum(resource.apps) + getNum(resource.files) + dbTotal
    }
  }).sort((a, b) => b.total - a.total)

  const grandTotal = rows.reduce((sum, row) => sum + row.total, 0)
  container.appendChild(el('div', { class: 'fz-stat-row' }, [
    statTile(showSize(data.totalSize || grandTotal), 'Total stored', '', true),
    statTile(showCount(rows.length), rows.length === 1 ? 'App' : 'Apps'),
    statTile(showCount(rows.reduce((sum, row) => sum + row.dbs.length, 0)), 'Database tables'),
    statTile(showSize(rows.reduce((sum, row) => sum + row.files, 0)), 'App files')
  ]))

  const table = el('table', { class: 'fz-table' })
  table.appendChild(el('thead', null, [el('tr', null, [
    el('th', { class: 'fz-l', text: 'App' }),
    el('th', { text: 'App size' }),
    el('th', { text: 'Files' }),
    el('th', { text: 'Databases' }),
    el('th', { text: 'Total' })
  ])]))

  const tbody = el('tbody')
  rows.forEach(row => {
    const caret = el('span', { class: 'fz-caret', text: row.dbs.length ? '▸' : '' })
    const detail = el('tr', { class: 'fz-detail', style: { display: 'none' } }, [
      el('td', { attrs: { colspan: '5' } }, row.dbs.map(db => el('div', { class: 'fz-detail-line' }, [
        el('span', { class: 'fz-mono', text: db.name }),
        el('span', { text: showSize(db.size) })
      ])))
    ])
    const tr = el('tr', {
      class: row.dbs.length ? 'fz-clickable' : '',
      onClick: row.dbs.length
        ? () => {
            const open = detail.style.display !== 'none'
            detail.style.display = open ? 'none' : 'table-row'
            caret.textContent = open ? '▸' : '▾'
          }
        : null
    }, [
      el('td', { class: 'fz-l' }, [caret, el('span', { text: ' ' + row.appName })]),
      el('td', { text: showSize(row.apps) }),
      el('td', { text: showSize(row.files) }),
      el('td', { text: showSize(row.dbTotal) + (row.dbs.length ? (' (' + row.dbs.length + ')') : '') }),
      el('td', { text: showSize(row.total) })
    ])
    tbody.appendChild(tr)
    tbody.appendChild(detail)
  })
  table.appendChild(tbody)
  container.appendChild(el('div', { class: 'fz-table-wrap' }, [table]))

  container.appendChild(el('div', { class: 'fz-note', text: 'Tables may appear under more than one app, so app totals can overlap.' }))
  if (data && data.time) {
    container.appendChild(el('div', { class: 'fz-note', text: 'Last calculated ' + new Date(data.time).toLocaleString() }))
  }
}
