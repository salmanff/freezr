
// admin/cache_prefs.js

/* global freezr */

let currentPrefs = { ALL_USERS: {}, USER_SPECIFIC: {} }
let userSectionCounter = 0

freezr.initPageScripts = function () {
  document.getElementById('addAllUsersBtn').addEventListener('click', function () { addAllUsersRow('', {}) })
  document.getElementById('addUserSectionBtn').addEventListener('click', function () { addUserSection('', {}) })
  document.getElementById('saveButt').addEventListener('click', saveCachePrefs)
  document.getElementById('refreshStatsBtn').addEventListener('click', loadCacheStats)
  document.getElementById('clearAllCacheBtn').addEventListener('click', clearAllCaches)
  loadCachePrefs()
}

// ===== LOAD =====
async function loadCachePrefs () {
  try {
    const data = await freezr.apiRequest('GET', '/adminapi/get_cache_prefs', null)
    const parsed = freezr.utils.parse(data)
    if (parsed && parsed.cachePrefs) {
      currentPrefs = parsed.cachePrefs
    } else if (parsed && parsed.ALL_USERS) {
      currentPrefs = parsed
    }
    renderAllUsersEntries()
    renderUserSpecificEntries()
    loadCacheStats()
  } catch (err) {
    showError('Error loading cache preferences: ' + err.message)
  }
}

async function loadCacheStats () {
  try {
    const data = await freezr.apiRequest('GET', '/adminapi/get_cache_stats', null)
    const parsed = freezr.utils.parse(data)
    document.getElementById('cacheStatsArea').textContent = JSON.stringify(parsed?.stats || parsed, null, 2)
  } catch (err) {
    document.getElementById('cacheStatsArea').textContent = 'Could not load cache stats'
  }
}

async function clearAllCaches () {
  if (!confirm('Are you sure you want to clear all caches? They will be repopulated on next access.')) return
  try {
    var data = await freezr.apiRequest('POST', '/adminapi/clear_all_caches', {})
    var parsed = freezr.utils.parse(data)
    showError('All caches cleared.')
    document.getElementById('cacheStatsArea').textContent = JSON.stringify(parsed?.stats || parsed, null, 2)
  } catch (err) {
    showError('Error clearing caches: ' + err.message)
  }
}

// ===== RENDER ALL_USERS =====
function renderAllUsersEntries () {
  var container = document.getElementById('allUsersEntries')
  container.innerHTML = ''
  var tables = currentPrefs.ALL_USERS || {}
  Object.keys(tables).forEach(function (tableName) {
    addAllUsersRow(tableName, tables[tableName])
  })
}

function createRemoveBtn () {
  var btn = document.createElement('button')
  btn.className = 'remove-btn'
  btn.textContent = '\u00D7'
  btn.title = 'Remove'
  btn.addEventListener('click', function () {
    btn.parentElement.remove()
  })
  return btn
}

function addAllUsersRow (tableName, entry) {
  if (!entry) entry = {}
  var container = document.getElementById('allUsersEntries')
  var row = document.createElement('div')
  row.className = 'cache-row'

  var tableInput = document.createElement('input')
  tableInput.type = 'text'
  tableInput.className = 'au-table'
  tableInput.value = tableName || ''
  tableInput.placeholder = 'app_table_name'
  tableInput.style.width = '220px'

  var cacheAllLabel = document.createElement('label')
  var cacheAllCb = document.createElement('input')
  cacheAllCb.type = 'checkbox'
  cacheAllCb.className = 'au-cacheAll'
  cacheAllCb.checked = !!entry.cacheAll
  cacheAllLabel.appendChild(cacheAllCb)
  cacheAllLabel.appendChild(document.createTextNode(' cacheAll'))

  var cacheRecentLabel = document.createElement('label')
  var cacheRecentCb = document.createElement('input')
  cacheRecentCb.type = 'checkbox'
  cacheRecentCb.className = 'au-cacheRecent'
  cacheRecentCb.checked = entry.cacheRecent !== false
  cacheRecentLabel.appendChild(cacheRecentCb)
  cacheRecentLabel.appendChild(document.createTextNode(' cacheRecent'))

  var patternsInput = document.createElement('input')
  patternsInput.type = 'text'
  patternsInput.className = 'au-patterns patterns-input'
  patternsInput.value = formatPatterns(entry.cachePatterns)
  patternsInput.placeholder = 'cachePatterns (comma sep)'

  row.appendChild(tableInput)
  row.appendChild(cacheAllLabel)
  row.appendChild(cacheRecentLabel)
  row.appendChild(patternsInput)
  row.appendChild(createRemoveBtn())
  container.appendChild(row)
}

// ===== RENDER USER_SPECIFIC =====
function renderUserSpecificEntries () {
  var container = document.getElementById('userSpecificEntries')
  container.innerHTML = ''
  var users = currentPrefs.USER_SPECIFIC || {}
  Object.keys(users).forEach(function (userName) {
    addUserSection(userName, users[userName])
  })
}

function addUserSection (userName, tables) {
  if (!tables) tables = {}
  var container = document.getElementById('userSpecificEntries')
  var sectionId = 'userSection_' + (userSectionCounter++)
  var section = document.createElement('div')
  section.className = 'user-section'
  section.id = sectionId

  // Header
  var header = document.createElement('div')
  header.className = 'user-section-header'
  var usernameInput = document.createElement('input')
  usernameInput.type = 'text'
  usernameInput.className = 'us-username'
  usernameInput.value = userName || ''
  usernameInput.placeholder = 'username'
  usernameInput.style.width = '180px'
  var removeUserBtn = createRemoveBtn()
  removeUserBtn.addEventListener('click', function () {
    section.remove()
  })
  header.appendChild(usernameInput)
  header.appendChild(removeUserBtn)

  // Tables container
  var tablesContainer = document.createElement('div')
  tablesContainer.className = 'us-tables'

  // Add table button
  var addTableBtn = document.createElement('button')
  addTableBtn.className = 'freezrButt small'
  addTableBtn.textContent = '+ Add Table'
  addTableBtn.style.marginTop = '0.5rem'
  addTableBtn.addEventListener('click', function () {
    addUserTableRowToContainer(tablesContainer, '', {})
  })

  section.appendChild(header)
  section.appendChild(tablesContainer)
  section.appendChild(addTableBtn)
  container.appendChild(section)

  // Add existing table rows
  Object.keys(tables).forEach(function (tableName) {
    addUserTableRowToContainer(tablesContainer, tableName, tables[tableName])
  })
}

function addUserTableRowToContainer (container, tableName, entry) {
  if (!entry) entry = {}
  var row = document.createElement('div')
  row.className = 'cache-row'

  var tableInput = document.createElement('input')
  tableInput.type = 'text'
  tableInput.className = 'us-table'
  tableInput.value = tableName || ''
  tableInput.placeholder = 'app_table_name'
  tableInput.style.width = '200px'

  var cacheAllLabel = document.createElement('label')
  var cacheAllCb = document.createElement('input')
  cacheAllCb.type = 'checkbox'
  cacheAllCb.className = 'us-cacheAll'
  cacheAllCb.checked = !!entry.cacheAll
  cacheAllLabel.appendChild(cacheAllCb)
  cacheAllLabel.appendChild(document.createTextNode(' cacheAll'))

  var cacheRecentLabel = document.createElement('label')
  var cacheRecentCb = document.createElement('input')
  cacheRecentCb.type = 'checkbox'
  cacheRecentCb.className = 'us-cacheRecent'
  cacheRecentCb.checked = entry.cacheRecent !== false
  cacheRecentLabel.appendChild(cacheRecentCb)
  cacheRecentLabel.appendChild(document.createTextNode(' cacheRecent'))

  var patternsInput = document.createElement('input')
  patternsInput.type = 'text'
  patternsInput.className = 'us-patterns patterns-input'
  patternsInput.value = formatPatterns(entry.cachePatterns)
  patternsInput.placeholder = 'cachePatterns (comma sep)'

  row.appendChild(tableInput)
  row.appendChild(cacheAllLabel)
  row.appendChild(cacheRecentLabel)
  row.appendChild(patternsInput)
  row.appendChild(createRemoveBtn())
  container.appendChild(row)
}

// ===== SAVE =====
async function saveCachePrefs () {
  var prefs = collectPrefs()
  if (!prefs) return

  try {
    var data = await freezr.apiRequest('POST', '/adminapi/set_cache_prefs', { cachePrefs: prefs })
    var parsed = freezr.utils.parse(data)
    if (parsed && (parsed.cachePrefs || parsed.ALL_USERS)) {
      currentPrefs = parsed.cachePrefs || parsed
      showError('Cache preferences saved successfully.')
    } else {
      showError('Preferences saved.')
    }
    loadCacheStats()
  } catch (err) {
    showError('Error saving cache preferences: ' + err.message)
  }
}

function collectPrefs () {
  var prefs = { ALL_USERS: {}, USER_SPECIFIC: {} }

  // Collect ALL_USERS
  var auRows = document.querySelectorAll('#allUsersEntries .cache-row')
  for (var i = 0; i < auRows.length; i++) {
    var row = auRows[i]
    var tableName = row.querySelector('.au-table').value.trim()
    if (!tableName) continue
    var entry = {}
    if (row.querySelector('.au-cacheAll').checked) entry.cacheAll = true
    if (!row.querySelector('.au-cacheRecent').checked) entry.cacheRecent = false
    var patterns = parsePatterns(row.querySelector('.au-patterns').value)
    if (patterns.length > 0) entry.cachePatterns = patterns
    prefs.ALL_USERS[tableName] = entry
  }

  // Collect USER_SPECIFIC
  var sections = document.querySelectorAll('#userSpecificEntries .user-section')
  for (var s = 0; s < sections.length; s++) {
    var section = sections[s]
    var userName = section.querySelector('.us-username').value.trim()
    if (!userName) continue

    var tables = {}
    var tableRows = section.querySelectorAll('.us-tables .cache-row')
    for (var t = 0; t < tableRows.length; t++) {
      var tRow = tableRows[t]
      var tName = tRow.querySelector('.us-table').value.trim()
      if (!tName) continue
      var tEntry = {}
      if (tRow.querySelector('.us-cacheAll').checked) tEntry.cacheAll = true
      if (!tRow.querySelector('.us-cacheRecent').checked) tEntry.cacheRecent = false
      var tPatterns = parsePatterns(tRow.querySelector('.us-patterns').value)
      if (tPatterns.length > 0) tEntry.cachePatterns = tPatterns
      tables[tName] = tEntry
    }
    if (Object.keys(tables).length > 0) {
      prefs.USER_SPECIFIC[userName] = tables
    }
  }

  return prefs
}

// ===== HELPERS =====
function parsePatterns (str) {
  if (!str || !str.trim()) return []
  return str.split(',').map(function (s) { return s.trim() }).filter(Boolean)
}

function formatPatterns (patterns) {
  if (!patterns || !Array.isArray(patterns)) return ''
  return patterns.join(', ')
}

function showError (text) {
  var box = document.getElementById('errorBox')
  box.textContent = text
  window.scrollTo(0, 0)
}
