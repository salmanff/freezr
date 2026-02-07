// account_app_viewdata.js
// View and backup app data
/* global targetApp, freezr, freezrMeta, Blob */

import { createObjectDiv } from './modules/drawJson.js'
import { saveAs } from './FileSaver.js'
import Mustache from '/app/info.freezr.public/public/mustache.mjs'

// Constants
const VIEW_RETRIEVE_COUNT = 50
const BACKUP_RETRIEVE_COUNT = 500
const FILE_SIZE_MAX = 10000000 // 10MB per backup file
const BACKUP_SCHEMA_VERSION = '1.0.0'

// Application state
const state = {
  meta: {
    user: null,
    appName: null,
    date: new Date().getTime(),
    source: 'app_viewdata',
    appTables: [],
    manifest: null
  },
  collection: {
    name: null,
    records: [],
    retrieved: 0,
    retrievedAll: false,
    currentPage: 1,
    queryFilter: null, // Stores the current query filter as string
    manifest: null
  },
  cardView: {
    enabled: false,
    template: null,
    cardPath: null
  },
  backup: {
    name: '',
    firstRetrievedDate: null,
    lastRetrievedDate: null,
    data: [],
    part: 1,
    retrievedAll: false
  }
}
window.state = state
// DOM element cache
const elements = {}

// Initialize page
freezr.initPageScripts = function () {
  cacheElements()
  setupEventListeners()
  initializeState()
  loadAppTables()
}

function cacheElements () {
  const ids = [
    'app_name', 'appSettings', 'collection_names', 'getCollectionData',
    'backUpData', 'loading', 'paginationControls', 'all_data',
    'bottomPagination', 'backup_status', 'warnings', 'headerChooser',
    'pageInfo', 'pageInfoBottom', 'recordCount', 'pageNumbers',
    'prevPage', 'nextPage', 'prevPageBottom', 'nextPageBottom', 'fetchMore',
    'queryFilter', 'queryError', 'toggleCardView'
  ]
  ids.forEach(id => {
    elements[id] = document.getElementById(id)
  })
}

function setupEventListeners () {
  elements.collection_names.addEventListener('change', handleCollectionChange)
  elements.getCollectionData.addEventListener('click', fetchCollectionData)
  elements.backUpData.addEventListener('click', startBackup)
  elements.prevPage.addEventListener('click', () => navigatePage(-1))
  elements.nextPage.addEventListener('click', () => navigatePage(1))
  elements.prevPageBottom.addEventListener('click', () => navigatePage(-1))
  elements.nextPageBottom.addEventListener('click', () => navigatePage(1))
  elements.fetchMore.addEventListener('click', fetchMoreData)
  elements.toggleCardView.addEventListener('click', toggleCardView)
  
  // Validate query filter on input
  elements.queryFilter.addEventListener('input', validateQueryFilter)
}

function validateQueryFilter () {
  const queryText = elements.queryFilter.value.trim()
  elements.queryError.textContent = ''
  
  if (!queryText) {
    elements.queryFilter.classList.remove('invalid')
    updateButtonVisibility()
    return true
  }
  
  try {
    JSON.parse(queryText)
    elements.queryFilter.classList.remove('invalid')
    updateButtonVisibility()
    return true
  } catch (e) {
    elements.queryFilter.classList.add('invalid')
    elements.queryError.textContent = 'Invalid JSON'
    return false
  }
}

function updateButtonVisibility () {
  const hasData = state.collection.records.length > 0
  const hasQueryFilter = elements.queryFilter.value.trim() !== ''
  
  if (!hasData) {
    // No data yet - show Fetch, hide Backup
    elements.getCollectionData.style.display = 'inline-block'
    elements.backUpData.style.display = 'none'
  } else if (hasQueryFilter) {
    // Has data and query filter - show Fetch (for new queries), hide Backup
    elements.getCollectionData.style.display = 'inline-block'
    elements.backUpData.style.display = 'none'
  } else {
    // Has data, no query filter - hide Fetch, show Backup
    elements.getCollectionData.style.display = 'none'
    elements.backUpData.style.display = 'inline-block'
  }
}

function getQueryFilter () {
  const queryText = elements.queryFilter.value.trim()
  if (!queryText) return {}
  
  try {
    return JSON.parse(queryText)
  } catch (e) {
    return {}
  }
}

function initializeState () {
  state.meta.appName = targetApp
  state.meta.user = freezrMeta.userId
  elements.app_name.textContent = targetApp
  elements.appSettings.href = '/account/app/settings/' + targetApp
}

async function loadAppTables () {
  try {
    // Special case for info.freezr.public - only show privatefeeds
    if (targetApp === 'info.freezr.public') {
      state.meta.manifest = null
      state.meta.appTables = ['info.freezr.public.public_records', 'dev.ceps.privatefeeds.codes'] //, ]
      state.meta.isPublicApp = true
      populateTableDropdown(state.meta.appTables)
      freezr.testState = state
      return
    }

    const result = await freezr.utils.getManifest(targetApp)

    if (result.error) {
      showError('Error connecting to server: ' + result.error)
      return
    }

    state.meta.manifest = result.manifest
    state.meta.appTables = result.app_tables || []

    if (state.meta.appTables.length > 0) {
      populateTableDropdown(state.meta.appTables)
    } else {
      showError('No data tables found in this app')
      elements.headerChooser.style.display = 'none'
    }

    // For debugging
    freezr.testState = state
  } catch (error) {
    console.error('Error loading app tables:', error)
    showError('Error connecting to server')
  }
}

function populateTableDropdown (tables) {
  elements.collection_names.innerHTML = tables
    .map(table => `<option value="${table}">${table}</option>`)
    .join('')
}

function handleCollectionChange () {
  // Clear previous data when changing tables
  clearDataDisplay()
  resetCollectionState()

  // Update collection name but don't fetch - wait for button click
  state.collection.name = elements.collection_names.value

  // Show fetch button, hide backup button
  elements.getCollectionData.style.display = 'inline-block'
  elements.backUpData.style.display = 'none'
}

function resetCollectionState () {
  state.collection = {
    name: elements.collection_names.value,
    queryFilter: null,
    records: [],
    retrieved: 0,
    retrievedAll: false,
    currentPage: 1
  }
}

function clearDataDisplay () {
  elements.all_data.innerHTML = ''
  elements.paginationControls.style.display = 'none'
  elements.bottomPagination.style.display = 'none'
  showError() // Clear any errors
}

async function fetchCollectionData () {
  const collectionName = elements.collection_names.value
  if (!collectionName) {
    showError('Please select a table')
    return
  }

  // Get query filter from text input
  const queryFilter = getQueryFilter()
  const queryFilterStr = JSON.stringify(queryFilter)

  // Reset if table or query filter changed
  const tableChanged = state.collection.name !== collectionName
  const queryChanged = state.collection.queryFilter !== queryFilterStr

  if (!state.collection.name || tableChanged || queryChanged) {
    resetCollectionState()
    state.collection.name = collectionName
    state.collection.queryFilter = queryFilterStr
  }

  showLoading(true)

  const queryOptions = {
    count: VIEW_RETRIEVE_COUNT,
    skip: state.collection.retrieved
  }
  
  console.log('fetchCollectionData - querying with options:', queryOptions, 'filter:', queryFilter)

  try {
    let data
    
    // Special case for info.freezr.public - use feps query with owner_id
    if (state.meta.isPublicApp) {
      // Build the full app_table name from dropdown value
      const appTable = collectionName
      queryOptions.owner_id = 'public'
      console.log('fetchCollectionData - public app query:', appTable, queryOptions)
      data = await freezr.query(appTable, queryFilter, queryOptions)
      // data = await freezr.query(appTable, {}, queryOptions)
    } else {
      data = await freezr.query(collectionName, queryFilter, queryOptions)
      // data = await freezr.query(collectionName, {}, queryOptions)
    }

    console.log('fetchCollectionData - received data:', {
      isArray: Array.isArray(data),
      length: Array.isArray(data) ? data.length : data?.results?.length,
      hasResults: !!data?.results,
      totalRetrievedBefore: state.collection.retrieved
    })

    showLoading(false)
    showError()

    // Handle both array and object with results property
    const records = Array.isArray(data) ? data : (data?.results || [])

    if (records.length === 0) {
      console.log('fetchCollectionData - no records returned, marking as retrievedAll')
      if (state.collection.records.length === 0) {
        showError('No data found in this table')
        // Clear any previous results from the page
        elements.all_data.innerHTML = ''
      }
      state.collection.retrievedAll = true
      updatePaginationUI()
      return
    }

    // Update state
    state.collection.records = state.collection.records.concat(records)
    state.collection.retrieved += records.length
    state.collection.retrievedAll = records.length < VIEW_RETRIEVE_COUNT

    console.log('fetchCollectionData - updated state:', {
      totalRecords: state.collection.records.length,
      retrieved: state.collection.retrieved,
      retrievedAll: state.collection.retrievedAll,
      recordsInThisBatch: records.length
    })

    // Get manifest info for the collection
    const collKey = collectionName.slice(state.meta.appName.length + 1)
    state.collection.manifest = state.meta.manifest?.app_tables?.[collKey] || null

    // Check if this table has a card template
    const cardPath = state.collection.manifest?.card
    if (cardPath) {
      elements.toggleCardView.style.display = 'inline-block'
      // Reset card view state for new collection
      if (state.cardView.cardPath !== cardPath) {
        state.cardView.cardPath = cardPath
        state.cardView.template = null
        state.cardView.enabled = false
        elements.toggleCardView.textContent = 'Show Card'
      }
    } else {
      elements.toggleCardView.style.display = 'none'
      state.cardView.enabled = false
    }

    // Update button visibility based on query filter state
    updateButtonVisibility()

    // Navigate to the latest page with new data
    const totalPages = getTotalPages()
    showPage(totalPages)
  } catch (error) {
    showLoading(false)
    console.error('Error fetching data:', error)
    showError('Error fetching data: ' + (error.message || 'Unknown error'))
  }
}

async function fetchMoreData () {
  await fetchCollectionData()
}

function getTotalPages () {
  return Math.ceil(state.collection.records.length / VIEW_RETRIEVE_COUNT)
}

function showPage (pageNum) {
  const totalPages = getTotalPages()
  pageNum = Math.max(1, Math.min(pageNum, totalPages))
  state.collection.currentPage = pageNum

  renderRecords(pageNum)
  updatePaginationUI()
}

function navigatePage (delta) {
  showPage(state.collection.currentPage + delta)
  // Scroll to top of data
  elements.all_data.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function renderRecords (pageNum) {
  const startIndex = (pageNum - 1) * VIEW_RETRIEVE_COUNT
  const endIndex = Math.min(startIndex + VIEW_RETRIEVE_COUNT, state.collection.records.length)

  elements.all_data.innerHTML = ''

  // Check if we should render as cards
  if (state.cardView.enabled && state.cardView.template) {
    renderCardsView(startIndex, endIndex)
    return
  }

  // For public app, disable editing (can only delete with appToken)
  const isPublicApp = state.meta.isPublicApp
  const canEdit = !isPublicApp

  for (let i = startIndex; i < endIndex; i++) {
    const record = state.collection.records[i]
    const recordDiv = createObjectDiv(record, {
      isTopLevel: true,
      editable: true,
      hideEditButton: !canEdit, // Hide edit for public app
      appTableManifest: state.collection.manifest,
      updateRecord: canEdit ? handleUpdateRecord : null,
      deleteRecord: handleDeleteRecord
    })
    elements.all_data.appendChild(recordDiv)
  }
}

function renderCardsView (startIndex, endIndex) {
  const isPublicApp = state.meta.isPublicApp
  const canEdit = !isPublicApp

  for (let i = startIndex; i < endIndex; i++) {
    const record = state.collection.records[i]
    
    // Create container with actions bar
    const container = document.createElement('div')
    container.className = 'card-view-item'
    container.setAttribute('data-record-id', record._id || '')
    
    // Actions bar
    const actionsDiv = document.createElement('div')
    actionsDiv.className = 'card-actions'
    
    if (canEdit) {
      const editBtn = document.createElement('button')
      editBtn.className = 'card-btn card-btn-edit'
      editBtn.textContent = 'Edit'
      editBtn.onclick = () => editCardRecord(record, container)
      actionsDiv.appendChild(editBtn)
    }
    
    const deleteBtn = document.createElement('button')
    deleteBtn.className = 'card-btn card-btn-delete'
    deleteBtn.textContent = 'Delete'
    deleteBtn.onclick = () => deleteCardRecord(record, container)
    actionsDiv.appendChild(deleteBtn)
    
    container.appendChild(actionsDiv)
    
    // Card content
    const cardContent = document.createElement('div')
    cardContent.className = 'card-content'
    cardContent.innerHTML = Mustache.render(state.cardView.template, record)
    container.appendChild(cardContent)
    
    elements.all_data.appendChild(container)
  }
}

function editCardRecord (record, container) {
  // Switch to JSON view for editing this record
  state.cardView.enabled = false
  elements.toggleCardView.textContent = 'Show Card'
  showPage(state.collection.currentPage)
  
  // Scroll to the record being edited
  setTimeout(() => {
    const recordDiv = document.querySelector(`[data-record-id="${record._id}"]`)
    if (recordDiv) {
      recordDiv.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, 100)
}

function deleteCardRecord (record, container) {
  if (!window.confirm(`Delete this record?\n\nID: ${record._id}\n\nThis cannot be undone!`)) {
    return
  }
  
  if (!window.confirm('FINAL WARNING: Permanently delete this record?')) {
    return
  }
  
  handleDeleteRecord(record._id, (err, result) => {
    if (err || result?.error) {
      showError('Error deleting: ' + (err?.message || result?.error))
    } else {
      container.innerHTML = '<div class="card-deleted">Record deleted</div>'
      setTimeout(() => container.remove(), 1500)
    }
  })
}

async function toggleCardView () {
  if (state.cardView.enabled) {
    // Switch back to JSON view
    state.cardView.enabled = false
    elements.toggleCardView.textContent = 'Show Card'
    showPage(state.collection.currentPage)
    return
  }

  // Switch to card view - need to load template first if not cached
  if (!state.cardView.template && state.cardView.cardPath) {
    try {
      showLoading(true)
      // const templateUrl = `/app/${state.meta.appName}/${state.cardView.cardPath}`
      const templateUrl = `/app/info.freezr.account/app2app/${state.meta.appName}/${state.cardView.cardPath}`
      const response = await fetch(templateUrl)
      if (!response.ok) {
        throw new Error(`Failed to load template: ${response.status}`)
      }
      state.cardView.template = await response.text()
      showLoading(false)
    } catch (error) {
      showLoading(false)
      showError('Failed to load card template: ' + error.message)
      return
    }
  }

  state.cardView.enabled = true
  elements.toggleCardView.textContent = 'Show JSON'
  showPage(state.collection.currentPage)
}

function updatePaginationUI () {
  const totalPages = getTotalPages()
  const { currentPage, retrievedAll, records } = state.collection

  if (records.length === 0) {
    elements.paginationControls.style.display = 'none'
    elements.bottomPagination.style.display = 'none'
    return
  }

  elements.paginationControls.style.display = 'flex'
  elements.bottomPagination.style.display = totalPages > 1 ? 'flex' : 'none'

  // Update page info text
  const pageInfoText = `Page ${currentPage} of ${retrievedAll ? totalPages : totalPages + '+'}`
  elements.pageInfo.textContent = pageInfoText
  elements.pageInfoBottom.textContent = pageInfoText

  // Update record count
  const startRecord = (currentPage - 1) * VIEW_RETRIEVE_COUNT + 1
  const endRecord = Math.min(currentPage * VIEW_RETRIEVE_COUNT, records.length)
  elements.recordCount.textContent = `Showing ${startRecord}-${endRecord} of ${retrievedAll ? records.length : records.length + '+'} records`

  // Update navigation buttons
  elements.prevPage.disabled = currentPage <= 1
  elements.nextPage.disabled = currentPage >= totalPages
  elements.prevPageBottom.disabled = currentPage <= 1
  elements.nextPageBottom.disabled = currentPage >= totalPages

  // Show/hide fetch more button
  elements.fetchMore.style.display = retrievedAll ? 'none' : 'inline-block'

  // Render page numbers
  renderPageNumbers(currentPage, totalPages)
}

function renderPageNumbers (currentPage, totalPages) {
  const container = elements.pageNumbers
  container.innerHTML = ''

  if (totalPages <= 1) return

  const maxVisible = 7
  const pages = []

  if (totalPages <= maxVisible) {
    // Show all pages
    for (let i = 1; i <= totalPages; i++) pages.push(i)
  } else {
    // Smart pagination with ellipsis
    pages.push(1)

    if (currentPage > 3) {
      pages.push('...')
    }

    const start = Math.max(2, currentPage - 1)
    const end = Math.min(totalPages - 1, currentPage + 1)

    for (let i = start; i <= end; i++) {
      if (!pages.includes(i)) pages.push(i)
    }

    if (currentPage < totalPages - 2) {
      pages.push('...')
    }

    if (!pages.includes(totalPages)) pages.push(totalPages)
  }

  pages.forEach(page => {
    const span = document.createElement('span')
    span.className = 'page-num'

    if (page === '...') {
      span.className += ' ellipsis'
      span.textContent = '...'
    } else {
      span.textContent = page
      if (page === currentPage) {
        span.className += ' active'
      } else {
        span.addEventListener('click', () => showPage(page))
      }
    }

    container.appendChild(span)
  })
}

async function handleUpdateRecord (record, callback) {
  const options = {
    app_table: state.collection.name,
    app_name: state.meta.appName,
    KeepUpdateIds: true,
    updateRecord: true,
    data_object_id: record._id
  }

  const recordCopy = { ...record }
  delete recordCopy._id

  try {
    const url = '/feps/restore/' + state.collection.name
    const result = await freezr.apiRequest('POST', url, { record: recordCopy, options })
    callback(null, result)
  } catch (error) {
    callback(error)
  }
}

async function handleDeleteRecord (recordId, callback) {
  try {
    const options = {}
    let appTable = state.collection.name
    
    if (state.meta.isPublicApp) {
      options.owner_id = 'public'
      // Build full app_table name for public app
      appTable = 'info.freezr.public.' + state.collection.name
    }
    
    await freezr.delete(appTable, recordId, options)
    
    // Remove from local state
    const index = state.collection.records.findIndex(r => r._id === recordId)
    if (index !== -1) {
      state.collection.records.splice(index, 1)
      state.collection.retrieved--
    }
    
    callback(null, { success: true })
  } catch (error) {
    callback(error)
  }
}

// Backup functionality
function startBackup () {
  // Hide data view elements
  elements.headerChooser.style.display = 'none'
  elements.paginationControls.style.display = 'none'
  elements.bottomPagination.style.display = 'none'
  elements.all_data.innerHTML = ''

  // Initialize backup state
  state.backup = {
    name: state.collection.name,
    firstRetrievedDate: Date.now(),
    lastRetrievedDate: Date.now(),
    data: [],
    part: 1,
    retrievedAll: false
  }

  // Clear collection state
  state.collection = {
    name: null,
    records: [],
    retrieved: 0,
    retrievedAll: false,
    currentPage: 1
  }

  // Show backup status
  elements.backup_status.style.display = 'block'
  elements.backup_status.innerHTML = `
    <h2>Backing Up: ${state.backup.name}</h2>
    <div class="backup-log" id="backupLog"></div>
  `

  addBackupLog('Starting backup...')
  retrieveBackupData()
}

async function retrieveBackupData () {
  try {
    const query = { _date_modified: { $lt: state.backup.lastRetrievedDate } }
    const options = { count: BACKUP_RETRIEVE_COUNT }

    // Build proper app table name
    let appTable = state.backup.name
    if (state.meta.isPublicApp) {
      options.owner_id = 'public'
      appTable = 'info.freezr.public.' + state.backup.name
    }

    const data = await freezr.query(appTable, query, options)
    
    handleBackupData(null, data)
  } catch (error) {
    handleBackupData(error, null)
  }
}

function handleBackupData (error, returnData) {
  // Handle wrapped results - support both array and object with results
  const records = Array.isArray(returnData) ? returnData : (returnData?.results || returnData || [])

  if (error || !records) {
    addBackupLog('Error - could not retrieve data', 'error')
    return
  }

  if (!Array.isArray(records) || records.length === 0) {
    if (state.backup.data.length === 0) {
      addBackupLog('No data found in this table', 'error')
      addBackupLog('Refresh page to try again')
    } else {
      finishBackup()
    }
    return
  }

  // Update backup state
  state.backup.retrievedAll = records.length < BACKUP_RETRIEVE_COUNT
  
  // Track the newest date (max) for the first batch in each file part
  if (state.backup.data.length === 0) {
    state.backup.firstRetrievedDate = getMaxDate(records, 0)
  }
  
  // Track the oldest date (min) for querying older records
  state.backup.lastRetrievedDate = getMinDate(records, state.backup.lastRetrievedDate)
  state.backup.data = state.backup.data.concat(records)

  addBackupLog(`Retrieved ${records.length} records (total: ${state.backup.data.length})`)

  // Check if we need to save a file
  if (state.backup.retrievedAll || JSON.stringify(state.backup.data).length > FILE_SIZE_MAX) {
    const fileName = saveBackupFile()
    const lastDate = new Date(state.backup.lastRetrievedDate)
    const firstDate = new Date(state.backup.firstRetrievedDate)

    addBackupLog(`Created file: "${fileName}"`, 'success')
    addBackupLog(`Data range: ${lastDate.toLocaleDateString()} ${lastDate.toLocaleTimeString()} to ${firstDate.toLocaleDateString()} ${firstDate.toLocaleTimeString()}`)

    // Reset for next file part - firstRetrievedDate will be set from next batch
    state.backup.part++
    state.backup.data = []
  }

  if (!state.backup.retrievedAll) {
    retrieveBackupData()
  } else {
    finishBackup()
  }
}

function finishBackup () {
  addBackupLog('Backup complete!', 'success')
  addBackupLog('Refresh page to perform another backup or view data.')
}

function saveBackupFile () {
  const now = new Date()
  // ISO format without colons for filename safety: 20250130T153000Z
  const isoDate = now.toISOString().replace(/[:.]/g, '').slice(0, 15) + 'Z'

  const backupData = {
    // Schema identification for future compatibility
    schema: {
      version: BACKUP_SCHEMA_VERSION,
      type: 'freezr_table_backup'
    },

    // Backup metadata
    backup: {
      created_at: now.toISOString(),
      server_url: freezrMeta.serverAddress || null,
      server_version: freezrMeta.serverVersion || null,
      source: 'app_viewdata',
      part: state.backup.part,
      total_parts: state.backup.retrievedAll ? state.backup.part : null
    },

    // Table information
    table: {
      app_name: state.meta.appName,
      app_table: state.backup.name,
      user_id: freezrMeta.userId,
      record_count: state.backup.data.length,
      date_range: {
        oldest: new Date(state.backup.lastRetrievedDate).toISOString(),
        newest: new Date(state.backup.firstRetrievedDate).toISOString()
      }
    },

    // The actual data
    records: state.backup.data
  }

  // Include manifest only in part 1
  if (state.backup.part === 1 && state.meta.manifest) {
    backupData.manifest = state.meta.manifest
  }

  const text = JSON.stringify(backupData, null, 2)
  const filename = `freezr_backup_${state.backup.name}_${freezrMeta.userId}_${isoDate}_part${state.backup.part}.json`

  const blob = new Blob([text], { type: 'application/json' })
  saveAs(blob, filename)

  return filename
}

function getMinDate (list, currentMin) {
  return list.reduce((min, item) => {
    return Math.min(min, item._date_modified || min)
  }, currentMin || Date.now())
}

function getMaxDate (list, currentMax) {
  return list.reduce((max, item) => {
    return Math.max(max, item._date_modified || 0)
  }, currentMax || 0)
}

function addBackupLog (message, type = '') {
  const logContainer = document.getElementById('backupLog')
  if (!logContainer) return

  const entry = document.createElement('div')
  entry.className = 'backup-log-entry' + (type ? ` ${type}` : '')
  entry.textContent = message
  logContainer.appendChild(entry)
}

// Utility functions
function showLoading (show) {
  elements.loading.style.display = show ? 'flex' : 'none'
}

function showError (message) {
  elements.warnings.innerHTML = message || ''
  elements.warnings.style.display = message ? 'block' : 'none'
}
