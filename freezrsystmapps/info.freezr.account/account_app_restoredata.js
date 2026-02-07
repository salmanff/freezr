// account_app_restoredata.js
// Restore backup data to freezr
/* global freezr, freezrMeta */

import { createObjectDiv } from './modules/drawJson.js'

// Constants
const RETRY_DELAYS = [400, 800, 1200] // Increasing delays for rate limit retries
const SUPPORTED_SCHEMA_VERSIONS = ['1.0.0']

// Restore mode descriptions
const MODE_DESCRIPTIONS = {
  create: 'Creates new records with new IDs, ignoring the original _id.',
  update: 'Updates existing records only. Fails if record does not exist.',
  upsert: 'Creates new record if _id not found, otherwise updates existing.'
}

// Application state
const state = {
  files: [],
  currentFileIndex: -1,
  currentRecordIndex: -1,
  parsedBackup: null,
  
  // First file's table becomes the expected table for all files
  expectedAppTable: null,
  
  // Restore mode: 'create', 'update', or 'upsert'
  restoreMode: 'create',
  
  // Processing flags
  processAllRecords: false,
  processAllFiles: false,
  
  // Override flags for mismatches
  overrides: {
    tableMismatch: false,
    userMismatch: false
  },
  
  // Statistics
  stats: {
    uploaded: 0,
    updated: 0,
    errors: 0,
    total: 0
  },
  
  // Retry state
  retryCount: 0
}
window.state = state

// DOM element cache
const elements = {}

// Initialize page
freezr.initPageScripts = function () {
  cacheElements()
  setupEventListeners()
}

function cacheElements () {
  const ids = [
    'warnings', 'uploadCard', 'fileUploader', 'selectedFiles',
    'uploadAndRestoreData', 'loading', 'backupInfoCard', 'backupInfo',
    'currentFileName', 'restoreMode', 'modeDescription', 'restoreModeLabel',
    'progressCard', 'statUploaded', 'statUpdated', 'statErrors',
    'statRemaining', 'progressBar', 'restoreLog', 'reviewCard',
    'currentRecordInfo', 'currentRecord', 'skipRecord', 'addRecord',
    'addAllRecords', 'addAllFiles', 'confirmDialog', 'dialogTitle',
    'dialogContent', 'dialogCancel', 'dialogConfirm'
  ]
  ids.forEach(id => {
    elements[id] = document.getElementById(id)
  })
}

function setupEventListeners () {
  elements.fileUploader.addEventListener('change', handleFileSelection)
  elements.uploadAndRestoreData.addEventListener('click', startRestore)
  elements.skipRecord.addEventListener('click', () => processNextRecord(true))
  elements.addRecord.addEventListener('click', () => uploadCurrentRecord())
  elements.addAllRecords.addEventListener('click', () => {
    state.processAllRecords = true
    uploadCurrentRecord()
  })
  elements.addAllFiles.addEventListener('click', () => {
    state.processAllRecords = true
    state.processAllFiles = true
    uploadCurrentRecord()
  })
  
  // Restore mode dropdown
  elements.restoreMode.addEventListener('change', (e) => {
    state.restoreMode = e.target.value
    elements.modeDescription.textContent = MODE_DESCRIPTIONS[state.restoreMode]
    updateRestoreModeLabel()
  })
}

function updateRestoreModeLabel () {
  const labels = {
    create: 'RESTORE MODE: CREATE NEW',
    update: 'RESTORE MODE: UPDATE',
    upsert: 'RESTORE MODE: UPSERT'
  }
  elements.restoreModeLabel.textContent = labels[state.restoreMode]
  elements.restoreModeLabel.className = 'restore-mode-label mode-' + state.restoreMode
  elements.dialogCancel.addEventListener('click', hideDialog)
}

// File selection handling
function handleFileSelection () {
  const files = elements.fileUploader.files
  elements.selectedFiles.innerHTML = ''

  if (files.length === 0) return

  Array.from(files).forEach(file => {
    const fileDiv = document.createElement('div')
    fileDiv.className = 'selected-file'
    fileDiv.innerHTML = `
      <span class="file-name">${file.name}</span>
      <span class="file-size">${formatFileSize(file.size)}</span>
    `
    elements.selectedFiles.appendChild(fileDiv)
  })
}

function formatFileSize (bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

// Start restore process
function startRestore () {
  state.files = Array.from(elements.fileUploader.files)

  if (state.files.length === 0) {
    showWarning('Please select backup files to restore')
    return
  }

  // Reset state
  state.currentFileIndex = -1
  state.expectedAppTable = null
  state.processAllRecords = false
  state.processAllFiles = false
  state.overrides = { tableMismatch: false, userMismatch: false }
  state.stats = { uploaded: 0, updated: 0, errors: 0, total: 0 }

  // Hide upload card, show progress
  elements.uploadCard.style.display = 'none'
  elements.progressCard.style.display = 'block'

  processNextFile()
}

// File processing
async function processNextFile () {
  state.currentFileIndex++
  state.currentRecordIndex = -1
  state.processAllRecords = state.processAllFiles
  state.retryCount = 0

  const file = state.files[state.currentFileIndex]

  if (!file) {
    // All files processed
    finishRestore()
    return
  }

  addLog(`Processing file: ${file.name}`, 'info')
  showLoading(true)

  try {
    const content = await readFileAsText(file)
    const rawBackup = JSON.parse(content)
    
    // Parse and normalize the backup (handles both legacy and new formats)
    state.parsedBackup = normalizeBackup(rawBackup)

    showLoading(false)
    showBackupInfo(state.parsedBackup, file.name)

    // Validate table consistency
    if (!state.expectedAppTable) {
      state.expectedAppTable = state.parsedBackup.table.app_table
    } else if (state.expectedAppTable !== state.parsedBackup.table.app_table && !state.overrides.tableMismatch) {
      showWarning(`File "${file.name}" is for a different table (${state.parsedBackup.table.app_table}). Expected: ${state.expectedAppTable}`)
      addLog('Stopped: table mismatch', 'error')
      return
    }

    // Check user mismatch
    if (freezrMeta.userId !== state.parsedBackup.table.user_id && !state.overrides.userMismatch) {
      const confirmed = await showConfirmDialog(
        'User Mismatch',
        `This backup was created by user <span class="highlight">${state.parsedBackup.table.user_id}</span> ` +
        `but you are restoring as <span class="highlight">${freezrMeta.userId}</span>.<br><br>` +
        `The data will be owned by <span class="warning-text">${freezrMeta.userId}</span> after restore. Continue?`
      )

      if (!confirmed) {
        addLog('Restore cancelled by user', 'warning')
        showWarning('Restore cancelled')
        return
      }
      state.overrides.userMismatch = true
    }

    // Update total count
    state.stats.total += state.parsedBackup.records.length
    updateProgressUI()

    // Start processing records
    askToProcessNextRecord()

  } catch (error) {
    showLoading(false)
    console.error('Error parsing file:', error)
    addLog(`Error parsing file: ${error.message}`, 'error')
    showWarning(`Could not parse file "${file.name}". Is it a valid backup file?`)
  }
}

function readFileAsText (file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = e => resolve(e.target.result)
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsText(file, 'UTF-8')
  })
}

// Backup format normalization
function normalizeBackup (rawBackup) {
  // Check for new schema format
  if (rawBackup.schema?.version) {
    if (!SUPPORTED_SCHEMA_VERSIONS.includes(rawBackup.schema.version)) {
      console.warn(`Unknown backup schema version: ${rawBackup.schema.version}. Attempting to parse anyway.`)
    }

    // New format - already normalized
    return {
      schema: rawBackup.schema,
      table: rawBackup.table,
      records: rawBackup.records || [],
      manifest: rawBackup.manifest || null,
      backup: rawBackup.backup || {},
      isLegacy: false
    }
  }

  // Legacy format - normalize to new structure
  console.log('Detected legacy backup format (no schema version)')
  
  return {
    schema: { version: 'legacy', type: 'freezr_table_backup' },
    table: {
      app_table: rawBackup.saved_coll?.name || null,
      app_name: rawBackup.meta?.app_name || null,
      user_id: rawBackup.meta?.user || null,
      record_count: rawBackup.saved_coll?.data?.length || 0
    },
    records: rawBackup.saved_coll?.data || [],
    manifest: null,
    backup: {
      source: rawBackup.meta?.source || 'unknown',
      created_at: rawBackup.meta?.date ? new Date(rawBackup.meta.date).toISOString() : null
    },
    isLegacy: true
  }
}

// Display backup information
function showBackupInfo (backup, fileName) {
  elements.backupInfoCard.style.display = 'block'

  // Show file name at top
  elements.currentFileName.innerHTML = `<strong>File:</strong> ${fileName}`

  const schemaInfo = backup.isLegacy
    ? '<span class="info-value legacy">Legacy (pre-1.0.0)</span>'
    : `<span class="info-value">${backup.schema.version}</span>`

  // Format date range if available
  let dateRangeHtml = ''
  if (backup.table?.date_range) {
    const oldest = backup.table.date_range.oldest
    const newest = backup.table.date_range.newest
    if (oldest) {
      dateRangeHtml += `
        <div class="info-item">
          <div class="info-label">Oldest Record</div>
          <div class="info-value">${new Date(oldest).toLocaleString()}</div>
        </div>
      `
    }
    if (newest) {
      dateRangeHtml += `
        <div class="info-item">
          <div class="info-label">Most Recent</div>
          <div class="info-value">${new Date(newest).toLocaleString()}</div>
        </div>
      `
    }
  }

  elements.backupInfo.innerHTML = `
    <div class="info-item">
      <div class="info-label">Schema Version</div>
      ${schemaInfo}
    </div>
    <div class="info-item">
      <div class="info-label">Table</div>
      <div class="info-value">${backup.table.app_table || 'Unknown'}</div>
    </div>
    <div class="info-item">
      <div class="info-label">Original User</div>
      <div class="info-value${backup.table.user_id !== freezrMeta.userId ? ' warning' : ''}">${backup.table.user_id || 'Unknown'}</div>
    </div>
    <div class="info-item">
      <div class="info-label">Records</div>
      <div class="info-value">${backup.records.length}</div>
    </div>
    ${dateRangeHtml}
    ${backup.backup?.created_at ? `
    <div class="info-item">
      <div class="info-label">Backup Date</div>
      <div class="info-value">${new Date(backup.backup.created_at).toLocaleString()}</div>
    </div>
    ` : ''}
  `
}

// Record processing
function askToProcessNextRecord () {
  state.currentRecordIndex++
  state.retryCount = 0

  const record = getCurrentRecord()

  if (!record) {
    // No more records in this file
    addLog(`Completed file ${state.currentFileIndex + 1} of ${state.files.length}`, 'success')
    processNextFile()
    return
  }

  // Apply transform hook
  const transformedRecord = transformRecord(record)
  if (transformedRecord) {
    state.parsedBackup.records[state.currentRecordIndex] = transformedRecord
  }

  if (state.processAllRecords) {
    uploadCurrentRecord()
  } else {
    showRecordForReview()
  }
}

function getCurrentRecord () {
  return state.parsedBackup?.records?.[state.currentRecordIndex] || null
}

function showRecordForReview () {
  const record = getCurrentRecord()
  if (!record) return

  elements.reviewCard.style.display = 'block'

  elements.currentRecordInfo.innerHTML = `
    <span>Record <strong>${state.currentRecordIndex + 1}</strong> of <strong>${state.parsedBackup.records.length}</strong></span>
    <span>File <strong>${state.currentFileIndex + 1}</strong> of <strong>${state.files.length}</strong></span>
    ${record._id ? `<span>ID: <strong>${record._id}</strong></span>` : ''}
  `

  elements.currentRecord.innerHTML = ''
  elements.currentRecord.appendChild(createObjectDiv(record, {
    isTopLevel: true,
    editable: true,
    mode: 'restore',
    record: record, // Pass reference so edits update the actual record
    onIgnore: () => {
      // Discard edits and redisplay the record (reset is done in drawJson)
      showRecordForReview()
    },
    onRecordUpdated: (updatedRecord) => {
      // Update the record in the backup data
      state.parsedBackup.records[state.currentRecordIndex] = updatedRecord
    },
    appTableManifest: state.parsedBackup.manifest?.app_tables?.[getCollectionKey()] || null
  }))
}

function getCollectionKey () {
  const appTable = state.parsedBackup.table.app_table
  const appName = state.parsedBackup.table.app_name
  if (appTable && appName) {
    return appTable.slice(appName.length + 1)
  }
  return null
}

// Record upload
async function uploadCurrentRecord () {
  elements.reviewCard.style.display = 'none'

  const record = getCurrentRecord()
  if (!record) {
    processNextFile()
    return
  }

  const appTable = state.parsedBackup.table.app_table
  const options = {
    app_table: appTable,
    app_name: state.parsedBackup.table.app_name
  }

  // Clone record for upload
  const uploadableRecord = JSON.parse(JSON.stringify(record))
  const uploadable = { record: uploadableRecord, options: {} }
  
  // Handle restore mode
  if (state.restoreMode === 'update') {
    // Update mode: requires existing record
    if (record._id) {
      uploadable.options.data_object_id = record._id
      uploadable.options.updateRecord = true
    } else {
      addLog(`Record ${state.currentRecordIndex + 1} has no _id - cannot update`, 'error')
      state.stats.errors++
      processNextRecord(false)
      return
    }
  } else if (state.restoreMode === 'upsert') {
    // Upsert mode: create or update based on _id
    if (record._id) {
      uploadable.options.data_object_id = record._id
      uploadable.options.upsertRecord = true
    }
    // If no _id, it will create a new record
  }
  // For 'create' mode, remove _id to let server assign new one
  if (state.restoreMode === 'create') {
    delete uploadable._id
  }

  // Apply delay for retries (rate limiting)
  const delay = state.retryCount > 0 ? RETRY_DELAYS[Math.min(state.retryCount - 1, RETRY_DELAYS.length - 1)] : 0
  if (delay > 0) {
    await new Promise(resolve => setTimeout(resolve, delay))
  }

  try {
    const url = '/feps/restore/' + appTable
    console.log('uploadCurrentRecord - url: ', {url, uploadable })
    const returnData = await freezr.apiRequest('POST', url, uploadable)
    
    // Success
    state.retryCount = 0
    state.stats.uploaded++
    if (returnData?.success) {
      state.stats.updated++
    }

    updateProgressUI()
    processNextRecord(false)

  } catch (error) {
    state.retryCount++

    if (state.retryCount <= RETRY_DELAYS.length) {
      // Retry with increasing delay
      addLog(`Retrying record ${state.currentRecordIndex + 1} (attempt ${state.retryCount + 1})...`, 'warning')
      uploadCurrentRecord()
      return
    }

    // Max retries exceeded
    state.stats.errors++
    addLog(`Error uploading record ${state.currentRecordIndex + 1}: ${error.message || 'Unknown error'}`, 'error')
    state.processAllRecords = false // Stop auto-processing on error
    updateProgressUI()
    
    // Show record for manual decision
    showRecordForReview()
  }
}

function processNextRecord (skip = false) {
  if (skip) {
    addLog(`Skipped record ${state.currentRecordIndex + 1}`, 'info')
  }
  askToProcessNextRecord()
}

// Finish restore
function finishRestore () {
  elements.reviewCard.style.display = 'none'
  elements.backupInfoCard.style.display = 'none'

  const { uploaded, updated, errors, total } = state.stats

  addLog('', 'info')
  addLog('═══════════════════════════════', 'info')
  addLog('Restore Complete!', 'success')
  addLog(`Total processed: ${uploaded} of ${total} records`, 'info')
  if (updated > 0) addLog(`Updated existing: ${updated}`, 'info')
  if (errors > 0) addLog(`Errors: ${errors}`, 'error')
  addLog('═══════════════════════════════', 'info')

  showWarning(errors > 0
    ? `Restore completed with ${errors} error(s). Check the log for details.`
    : 'Restore completed successfully!')
}

// UI Updates
function updateProgressUI () {
  const { uploaded, updated, errors, total } = state.stats
  const remaining = total - uploaded - errors

  elements.statUploaded.textContent = uploaded
  elements.statUpdated.textContent = updated
  elements.statErrors.textContent = errors
  elements.statRemaining.textContent = remaining

  const progress = total > 0 ? ((uploaded + errors) / total) * 100 : 0
  elements.progressBar.style.width = progress + '%'
}

function addLog (message, type = '') {
  const entry = document.createElement('div')
  entry.className = 'log-entry' + (type ? ` ${type}` : '')
  entry.textContent = message
  elements.restoreLog.appendChild(entry)
  elements.restoreLog.scrollTop = elements.restoreLog.scrollHeight
}

function showLoading (show) {
  elements.loading.style.display = show ? 'flex' : 'none'
}

function showWarning (message) {
  if (!message) {
    elements.warnings.innerHTML = ''
    elements.warnings.style.display = 'none'
  } else {
    elements.warnings.innerHTML = message
    elements.warnings.style.display = 'block'
  }
}

// Confirmation dialog
function showConfirmDialog (title, content) {
  return new Promise(resolve => {
    elements.dialogTitle.textContent = title
    elements.dialogContent.innerHTML = content
    elements.confirmDialog.style.display = 'flex'

    const handleConfirm = () => {
      cleanup()
      resolve(true)
    }

    const handleCancel = () => {
      cleanup()
      resolve(false)
    }

    const handleKeydown = (e) => {
      if (e.key === 'Escape') handleCancel()
      if (e.key === 'Enter') handleConfirm()
    }

    const cleanup = () => {
      elements.dialogConfirm.removeEventListener('click', handleConfirm)
      elements.dialogCancel.removeEventListener('click', handleCancel)
      document.removeEventListener('keydown', handleKeydown)
      elements.confirmDialog.style.display = 'none'
    }

    elements.dialogConfirm.addEventListener('click', handleConfirm)
    elements.dialogCancel.addEventListener('click', handleCancel)
    document.addEventListener('keydown', handleKeydown)
  })
}

function hideDialog () {
  elements.confirmDialog.style.display = 'none'
}

// Transform hook - can be customized for data migrations
// To use: modify this function or override window.transformRecord
function transformRecord (record) {
  // Placeholder for custom transformations
  // Example usage:
  // if (record.oldFieldName) {
  //   record.newFieldName = record.oldFieldName
  //   delete record.oldFieldName
  // }
  
  // Check for window override
  if (typeof window.transformRecord === 'function') {
    return window.transformRecord(record)
  }
  
  return record
}

// Expose for debugging
window.restoreState = state
