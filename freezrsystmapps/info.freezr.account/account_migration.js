// freezr - account_migration.js
// Migration status page for BOTH file-system and database migration.
//  - While a migration is mid-copy (locked) the page is a full-screen status takeover (offline).
//  - Otherwise it shows two tabs (Migrate Files / Migrate Database); each tab's panel reflects
//    THAT resource's own state: a start form when idle, or the awaiting / failed actions. This
//    lets a user start (say) a file-system migration while a database migration is still
//    awaiting confirmation (old database not yet deleted), and vice-versa.
// Polls once on load, then only repeats while a migration is actively progressing. Wording is
// kind-aware ("file system" vs "database"), with notes for the files-as-db (nedb) case.

/* global freezr */

const IN_PROGRESS = ['queued', 'preparing', 'copying', 'verifying', 'rolling_back', 'cleaning_up']
const ENDPOINT = { fs: '/acctapi/fsMigration/', db: '/acctapi/dbMigration/' }
const OPTIONS_ACTION = { fs: 'fsOptions', db: 'dbOptions' }

let pollTimer = null
let ACTIVE_KIND = 'fs' // the kind the on-screen actions target (locked kind, or selected tab)
let START_KIND = 'fs' // selected tab
let tabInitialised = false
const OPTIONS = { fs: null, db: null } // cached provider field definitions per kind
let CURRENT = { fs: '…', db: '…', dbIsNedb: false } // current systems, from the latest status
let STATE = { fs: { status: 'none' }, db: { status: 'none' } } // latest status of each kind

function nounFor (kind) { return kind === 'db' ? 'database' : 'file system' }

freezr.initPageScripts = function () {
  document.addEventListener('click', function (evt) {
    const args = (evt.target.id || '').split('_')
    if (args.length < 2) return
    if (args[0] === 'tab') { selectTab(args[1]); return }
    if (args[0] === 'click') {
      switch (args[1]) {
        case 'start': startMigration(); break
        case 'abort': abortMigration(); break
        case 'rollback': rollback(); break
        case 'confirmDelete': confirmDelete(); break
        case 'retry': retryMigration(); break
        case 'reenter': reenterMigration(); break
        default: break
      }
    }
  })
  poll() // once on load; poll() decides whether to keep polling
}

function ensurePolling (on) {
  if (on && !pollTimer) pollTimer = setInterval(poll, 3000)
  else if (!on && pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

function poll () {
  Promise.all([
    freezr.apiRequest('GET', ENDPOINT.fs + 'status').catch(function () { return null }),
    freezr.apiRequest('GET', ENDPOINT.db + 'status').catch(function () { return null })
  ]).then(function (results) {
    const fsM = (results[0] && results[0].migration) ? results[0].migration : { status: 'none' }
    const dbM = (results[1] && results[1].migration) ? results[1].migration : { status: 'none' }
    STATE = { fs: fsM, db: dbM }
    CURRENT = { fs: fsM.currentFs || '…', db: fsM.currentDb || '…', dbIsNedb: !!fsM.dbIsNedb }
    // Only one migration can be mid-copy at a time (mutual exclusion). If one is, take over.
    const lockedKind = IN_PROGRESS.includes(fsM.status) ? 'fs' : (IN_PROGRESS.includes(dbM.status) ? 'db' : null)
    if (lockedKind) { renderInProgress(STATE[lockedKind], lockedKind); ensurePolling(true) }
    else { renderChoose(); ensurePolling(false) }
  }).catch(function (err) { showError('Could not get status: ' + (err.message || err)) })
}

// Full-screen status while a migration is mid-copy (account offline; no tabs).
function renderInProgress (m, kind) {
  ACTIVE_KIND = kind
  hide(['chooseArea', 'startCard', 'awaitingCard', 'failedCard'])
  show('statusCard')
  text('phaseLabel', m.phaseLabel || m.status)
  bar(m.percent || 0)
  text('progressText', progressText(m, kind))
  text('currentPath', m.currentPath ? ('… ' + m.currentPath) : (m.currentTable ? ('… ' + m.currentTable) : ''))
  document.getElementById('abortRow').style.display = (['copying', 'preparing', 'queued'].includes(m.status)) ? 'block' : 'none'
}

// Tabs + the selected tab's panel.
function renderChoose () {
  hide(['statusCard'])
  show('chooseArea')
  text('tabFsCurrent', 'Currently: ' + CURRENT.fs)
  text('tabDbCurrent', 'Currently: ' + CURRENT.db)
  text('nedbNote', CURRENT.dbIsNedb
    ? 'Note: your database is stored as files (nedb), so migrating your file system moves your database with it. You can also migrate your database on its own — for example to switch to MongoDB.'
    : 'Your files and your database are stored separately, so you can migrate each one independently.')
  if (!tabInitialised) { tabInitialised = true; START_KIND = defaultTab() }
  selectTab(START_KIND)
}

// On first load, open the tab that needs attention (awaiting/failed), else Files.
function defaultTab () {
  if (['awaiting_confirmation', 'failed'].includes(STATE.db.status)) return 'db'
  if (['awaiting_confirmation', 'failed'].includes(STATE.fs.status)) return 'fs'
  return 'fs'
}

function selectTab (kind) {
  START_KIND = kind
  ACTIVE_KIND = kind // panel actions (rollback / confirmDelete / retry / reenter) target this kind
  const fsT = document.getElementById('tab_fs'); const dbT = document.getElementById('tab_db')
  if (fsT) fsT.style.opacity = (kind === 'fs') ? '1' : '0.5'
  if (dbT) dbT.style.opacity = (kind === 'db') ? '1' : '0.5'
  renderPanel(kind, STATE[kind] || { status: 'none' })
}

function renderPanel (kind, m) {
  hide(['startCard', 'awaitingCard', 'failedCard'])
  const status = m.status || 'none'
  const noun = nounFor(kind)

  if (status === 'awaiting_confirmation') {
    show('awaitingCard')
    text('awaitTitle', '✓ Your account is now running on the new ' + noun)
    text('awaitBody', 'Please test your account thoroughly. Your old ' + noun + ' is still intact as a backup — nothing has been deleted yet. You can come back any time to finish.')
    if (kind === 'fs' && m.dbIsNedb) { show('awaitNedbNote'); text('awaitNedbNote', 'Your database is stored as files (nedb), so it moved with your file system.') } else hide(['awaitNedbNote'])
    text('awaitConfirmHead', 'When you are confident the new ' + noun + ' works:')
    text('click_confirmDelete', 'Delete old ' + noun + ' (permanent)')
    text('rollbackNote', 'Note: rolling back returns you to your old ' + noun + ', discards any changes made since the switch, and deletes the copied data from the new ' + noun + '.')
    text('click_rollback', 'Roll back to old ' + noun)
  } else if (status === 'failed') {
    show('failedCard')
    text('failError', m.error ? (m.error.message || JSON.stringify(m.error)) : 'Unknown error')
    text('failFiles', progressText(m, kind))
    text('failReassure', 'Your account is unchanged and still on your original ' + noun + '.')
    text('click_retry', 'Try again (same ' + noun + ')')
  } else { // none, complete, rolled_back → start form
    show('startCard')
    text('startTitle', kind === 'db' ? 'Migrate your database' : 'Migrate your file system')
    text('startBlurb', kind === 'db'
      ? 'Copy all your database records to a new database, keeping your current one until you confirm.'
      : 'Copy all your files to a new file system, keeping your current one until you confirm.')
    loadOptions()
  }
}

function progressText (m, kind) {
  if (kind === 'db') {
    let t = ''
    if (m.totalTables) t = (m.tablesDone || 0) + ' of ' + m.totalTables + ' tables'
    if (m.totalRecords) t += (t ? '  ·  ' : '') + (m.recordsCopied || 0) + ' / ' + m.totalRecords + ' records'
    return t
  }
  let t = ''
  if (m.totalFiles) t = (m.filesCopied || 0) + ' of ' + m.totalFiles + ' files'
  if (m.totalBytes) t += (t ? '  ·  ' : '') + mb(m.bytesCopied) + ' / ' + mb(m.totalBytes) + ' MB'
  return t
}

// ---- provider form ----
function loadOptions () {
  const kind = START_KIND
  if (OPTIONS[kind]) { buildProviderSelector(); return }
  freezr.apiRequest('GET', ENDPOINT[kind] + OPTIONS_ACTION[kind])
    .then(function (data) { OPTIONS[kind] = (data && (data.fsOptions || data.dbOptions)) || {}; buildProviderSelector() })
    .catch(function (err) { showError('Could not load options: ' + (err.message || err)) })
}

function buildProviderSelector () {
  const sel = document.getElementById('selector_provider')
  if (!sel) return
  if (sel._builtKind === START_KIND && sel.options.length > 0) return // already built for this kind; don't wipe typed values
  const defs = OPTIONS[START_KIND] || {}
  sel._builtKind = START_KIND
  sel.innerHTML = ''
  Object.keys(defs).forEach(function (key) {
    const o = document.createElement('option')
    o.value = key
    o.innerHTML = defs[key].label || key
    sel.appendChild(o)
  })
  sel.onchange = changeProvider
  changeProvider()
}

function changeProvider () {
  const defs = OPTIONS[START_KIND] || {}
  const choice = document.getElementById('selector_provider').value
  const def = defs[choice] || {}
  text('msg_provider', def.msg || '')
  text('warning_provider', def.warning || (def.oauth ? 'This provider normally uses OAuth — paste the tokens/credentials below (you can obtain them via the registration flow).' : ''))
  const tabletop = document.getElementById('table_elements')
  tabletop.innerHTML = ''
  const table = document.createElement('table')
  ;(def.fields || []).forEach(function (item) {
    const row = document.createElement('tr')
    const c1 = document.createElement('td')
    c1.setAttribute('align', 'right'); c1.style.paddingRight = '8px'; c1.style.color = '#555'
    c1.innerHTML = item.display || item.name
    const c2 = document.createElement('td')
    const input = document.createElement('input')
    input.type = item.type || 'text'
    input.className = 'input'
    input.id = 'field_' + item.name
    if (item.type === 'checkbox') {
      input.checked = !!item.default
    } else {
      input.style.width = '280px'
      if (item.default) input.value = item.default
    }
    c2.appendChild(input)
    row.appendChild(c1); row.appendChild(c2)
    if (item.hide) row.style.display = 'none'
    table.appendChild(row)
  })
  tabletop.appendChild(table)
}

function getStartFormData () {
  const defs = OPTIONS[START_KIND] || {}
  const choice = document.getElementById('selector_provider').value
  if (!choice || !defs[choice]) return ['Please choose a provider', null]
  const def = defs[choice]
  const params = { type: def.type, choice: choice }
  let err = ''
  ;(def.fields || []).forEach(function (item) {
    const input = document.getElementById('field_' + item.name)
    if (item.type === 'checkbox') {
      if (input) params[item.name] = input.checked
    } else if (input && input.value && input.value.trim() !== '') {
      params[item.name] = input.value.trim()
    } else if (!item.optional) {
      err += (err ? ', ' : 'Missing: ') + (item.display || item.name)
    }
  })
  return [err, params]
}

function startMigration (confirmContinue) {
  const kind = START_KIND
  const [err, params] = getStartFormData()
  const oldPassword = document.getElementById('startPassword').value
  if (err) return showError(err)
  if (!oldPassword) return showError('Please enter your password.')
  const body = { oldPassword: oldPassword, confirmContinue: !!confirmContinue }
  if (kind === 'fs') body.targetFsParams = params; else body.targetDbParams = params
  showError('Starting migration… your account will go offline shortly.')
  freezr.apiRequest('PUT', ENDPOINT[kind] + 'start', body)
    .then(function (data) {
      if (data && data.needsConfirm) {
        showError('')
        if (window.confirm(data.message || 'The new provider already has data for this account. Continue and overwrite it?')) startMigration(true)
        return
      }
      showError(''); poll()
    })
    .catch(function (err) { showError('Could not start: ' + (err.message || err)) })
}

// ---- actions on the active/selected migration ----
function actEndpoint () { return ENDPOINT[ACTIVE_KIND || 'fs'] }

function abortMigration () {
  if (!window.confirm('Cancel the migration? Your account stays on its current ' + nounFor(ACTIVE_KIND) + '.')) return
  freezr.apiRequest('PUT', actEndpoint() + 'abort', {})
    .then(function () { poll() })
    .catch(function (err) { showError('Could not cancel: ' + (err.message || err)) })
}

function retryMigration () {
  showError('Retrying migration…')
  freezr.apiRequest('PUT', actEndpoint() + 'retry', {})
    .then(function () { showError(''); poll() })
    .catch(function (err) { showError('Could not retry: ' + (err.message || err)) })
}

function reenterMigration () {
  if (!window.confirm('Discard this attempt (and its partial copy) and enter new details?')) return
  showError('Clearing the failed attempt…')
  freezr.apiRequest('PUT', actEndpoint() + 'dismiss', {})
    .then(function () { showError(''); poll() })
    .catch(function (err) { showError('Could not clear: ' + (err.message || err)) })
}

function rollback () {
  const noun = nounFor(ACTIVE_KIND)
  if (!window.confirm('Roll back to your old ' + noun + '? Any changes made since the switch will be lost, and the data already copied will be deleted.')) return
  showError('Rolling back…')
  freezr.apiRequest('PUT', actEndpoint() + 'rollback', {})
    .then(function () { showError('Rolled back to your old ' + noun + '.'); poll() })
    .catch(function (err) { showError('Could not roll back: ' + (err.message || err)) })
}

function confirmDelete () {
  const noun = nounFor(ACTIVE_KIND)
  const oldPassword = document.getElementById('confirmPassword').value
  if (!oldPassword) return showError('Please enter your password to confirm deletion.')
  if (!window.confirm('Permanently delete your OLD ' + noun + '? This cannot be undone.')) return
  showError('Deleting old ' + noun + '…')
  freezr.apiRequest('PUT', actEndpoint() + 'confirmDelete', { oldPassword: oldPassword })
    .then(function () { showError('Old ' + noun + ' deleted. Migration complete.'); poll() })
    .catch(function (err) { showError('Could not delete: ' + (err.message || err)) })
}

// ---- tiny dom helpers ----
function mb (bytes) { return ((bytes || 0) / (1024 * 1024)).toFixed(1) }
function bar (pct) { document.getElementById('progressBar').style.width = Math.max(0, Math.min(100, pct)) + '%' }
function text (id, t) { const el = document.getElementById(id); if (el) el.textContent = t }
function show (id) { const el = document.getElementById(id); if (el) el.style.display = 'block' }
function hide (ids) { ids.forEach(function (id) { const el = document.getElementById(id); if (el) el.style.display = 'none' }) }
function showError (t) {
  const el = document.getElementById('errorBox')
  if (!el) return
  el.innerHTML = t || ''
  el.style.display = t ? 'block' : 'none'
}
