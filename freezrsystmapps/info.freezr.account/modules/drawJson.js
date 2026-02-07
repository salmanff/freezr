// drawJson.js
// Renders JSON objects with collapsible sections, type-aware display, and editing capabilities
/* global */

// Constants
const COLLAPSE_THRESHOLD = {
  arrayLength: 5,
  objectKeys: 8,
  stringLength: 200
}

const SYSTEM_DATE_FIELDS = ['_date_modified', '_date_created']

// Mode types
const MODES = {
  VIEW: 'view',      // Normal view/edit mode (viewdata page)
  RESTORE: 'restore' // Restore mode (restoredata page) - no save/delete, just confirm edits
}

/**
 * Creates a visual representation of a record/object
 * @param {Object} record - The data object to display
 * @param {Object} options - Configuration options
 * @param {boolean} options.isTopLevel - Whether this is the root record
 * @param {boolean} options.editable - Whether editing is enabled
 * @param {string} options.mode - 'view' or 'restore' (default: 'view')
 * @param {Object} options.appTableManifest - Manifest with field type definitions
 * @param {Function} options.updateRecord - Callback for saving updates (view mode)
 * @param {Function} options.deleteRecord - Callback for deleting record (view mode)
 * @param {Function} options.onIgnore - Callback when ignoring record (restore mode)
 * @param {Function} options.onRecordUpdated - Callback when record is edited (restore mode)
 * @returns {HTMLElement} The rendered DOM element
 */
function createObjectDiv (record, options = {}) {
  const { isTopLevel, appTableManifest } = options
  
  // Default to view mode
  if (!options.mode) options.mode = MODES.VIEW

  if (isTopLevel) {
    return createTopLevelRecord(record, options)
  }

  return createNestedObject(record, { appTableManifest })
}

/**
 * Creates the top-level record container with action buttons
 */
function createTopLevelRecord (record, options) {
  const { editable, appTableManifest, mode } = options

  const container = document.createElement('div')
  container.className = 'json-record'
  container.setAttribute('data-record-id', record._id || '')

  // Store original record for reset
  container._originalRecord = JSON.parse(JSON.stringify(record))
  container._currentRecord = record
  container._options = options

  // Warning/status area at top (visible for errors/success messages)
  const statusDiv = document.createElement('div')
  statusDiv.className = 'json-status'
  container.appendChild(statusDiv)

  // Fields container
  const fieldsDiv = document.createElement('div')
  fieldsDiv.className = 'json-fields'

  // Action buttons - positioned absolutely top-right
  if (editable) {
    const actionsDiv = createActionsBar(container, record, options)
    fieldsDiv.appendChild(actionsDiv)
  }

  // Sort keys: system fields first (_id, _date_*), then alphabetical
  const sortedKeys = getSortedKeys(record)

  sortedKeys.forEach(key => {
    const fieldDiv = createFieldRow(key, record[key], {
      appTableManifest,
      isSystemField: key.startsWith('_'),
      recordId: record._id
    })
    fieldsDiv.appendChild(fieldDiv)
  })

  container.appendChild(fieldsDiv)

  return container
}

/**
 * Creates the action buttons bar
 */
function createActionsBar (container, record, options) {
  const { mode, updateRecord, deleteRecord, onIgnore, onRecordUpdated, hideEditButton } = options
  const isRestoreMode = mode === MODES.RESTORE

  const actionsDiv = document.createElement('div')
  actionsDiv.className = 'json-actions'

  // Edit button (can be hidden for read-only scenarios like public records)
  if (!hideEditButton) {
    const editBtn = document.createElement('button')
    editBtn.className = 'json-btn json-btn-edit'
    editBtn.textContent = 'Edit'
    editBtn.onclick = () => enterEditMode(container)
    actionsDiv.appendChild(editBtn)
  }

  if (isRestoreMode) {
    // Restore mode: Ignore button - discards edits and returns to view
    const ignoreBtn = document.createElement('button')
    ignoreBtn.className = 'json-btn json-btn-ignore'
    ignoreBtn.textContent = 'Ignore Edits'
    ignoreBtn.onclick = () => {
      // Reset to original record and exit edit mode
      container._currentRecord = JSON.parse(JSON.stringify(container._originalRecord))
      if (onIgnore) onIgnore(container._currentRecord)
    }
    actionsDiv.appendChild(ignoreBtn)

    // Confirm button (hidden initially) - for confirming edits without saving to DB
    const confirmBtn = document.createElement('button')
    confirmBtn.className = 'json-btn json-btn-confirm'
    confirmBtn.textContent = 'Confirm Edit'
    confirmBtn.style.display = 'none'
    confirmBtn.onclick = () => confirmEditForRestore(container, onRecordUpdated)
    actionsDiv.appendChild(confirmBtn)
  } else {
    // View mode: Delete button
    const deleteBtn = document.createElement('button')
    deleteBtn.className = 'json-btn json-btn-delete'
    deleteBtn.textContent = 'Delete'
    deleteBtn.onclick = () => confirmDelete(container, record, deleteRecord)
    actionsDiv.appendChild(deleteBtn)

    // Save button (hidden initially)
    const saveBtn = document.createElement('button')
    saveBtn.className = 'json-btn json-btn-save'
    saveBtn.textContent = 'Save'
    saveBtn.style.display = 'none'
    saveBtn.onclick = () => confirmSave(container, updateRecord)
    actionsDiv.appendChild(saveBtn)
  }

  // Cancel button (hidden initially) - common to both modes
  const cancelBtn = document.createElement('button')
  cancelBtn.className = 'json-btn json-btn-cancel'
  cancelBtn.textContent = 'Cancel'
  cancelBtn.style.display = 'none'
  cancelBtn.onclick = () => exitEditMode(container)
  actionsDiv.appendChild(cancelBtn)

  return actionsDiv
}

/**
 * Creates a single field row (key: value)
 */
function createFieldRow (key, value, options = {}) {
  const { appTableManifest, isSystemField, recordId } = options

  const fieldDiv = document.createElement('div')
  fieldDiv.className = 'json-field' + (isSystemField ? ' json-field-system' : '')
  fieldDiv.setAttribute('data-field-key', key)

  // Key label
  const keySpan = document.createElement('span')
  keySpan.className = 'json-key'
  keySpan.textContent = key + ':'
  fieldDiv.appendChild(keySpan)

  // Value display
  const valueContainer = document.createElement('div')
  valueContainer.className = 'json-value-container'

  const fieldType = getFieldType(key, value, appTableManifest)
  const valueEl = createValueElement(value, {
    key,
    fieldType,
    appTableManifest,
    depth: 0
  })

  valueContainer.appendChild(valueEl)
  fieldDiv.appendChild(valueContainer)

  return fieldDiv
}

/**
 * Creates the value element based on type
 */
function createValueElement (value, options = {}) {
  const { key, fieldType, appTableManifest, depth = 0 } = options

  // Handle null/undefined
  if (value === null || value === undefined) {
    return createPrimitiveValue(value, 'null')
  }

  // Handle dates
  if (fieldType === 'date' || SYSTEM_DATE_FIELDS.includes(key)) {
    return createDateValue(value)
  }

  // Handle primitives
  if (typeof value === 'string') {
    return createStringValue(value)
  }

  if (typeof value === 'number') {
    return createPrimitiveValue(value, 'number')
  }

  if (typeof value === 'boolean') {
    return createPrimitiveValue(value, 'boolean')
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return createArrayValue(value, { key, appTableManifest, depth })
  }

  // Handle objects
  if (typeof value === 'object') {
    return createObjectValue(value, { key, appTableManifest, depth })
  }

  // Fallback
  return createPrimitiveValue(JSON.stringify(value), 'unknown')
}

/**
 * Creates a primitive value span
 */
function createPrimitiveValue (value, type) {
  const span = document.createElement('span')
  span.className = `json-value json-value-${type}`
  span.setAttribute('data-type', type)
  span.setAttribute('data-raw', JSON.stringify(value))

  if (value === null) {
    span.textContent = 'null'
  } else if (value === undefined) {
    span.textContent = 'undefined'
  } else if (typeof value === 'boolean') {
    span.textContent = value ? 'true' : 'false'
  } else {
    span.textContent = String(value)
  }

  return span
}

/**
 * Creates a string value with potential truncation
 */
function createStringValue (value) {
  const span = document.createElement('span')
  span.className = 'json-value json-value-string'
  span.setAttribute('data-type', 'string')
  span.setAttribute('data-raw', JSON.stringify(value))

  if (value.length > COLLAPSE_THRESHOLD.stringLength) {
    span.classList.add('json-truncated')
    span.textContent = `"${value.substring(0, COLLAPSE_THRESHOLD.stringLength)}..."`
    span.title = 'Click to expand'
    span.onclick = (e) => {
      if (span.classList.contains('json-truncated')) {
        span.textContent = `"${value}"`
        span.classList.remove('json-truncated')
        span.title = ''
      }
      e.stopPropagation()
    }
  } else {
    span.textContent = `"${value}"`
  }

  return span
}

/**
 * Creates a date value display
 */
function createDateValue (value) {
  const span = document.createElement('span')
  span.className = 'json-value json-value-date'
  span.setAttribute('data-type', 'date')
  span.setAttribute('data-raw', JSON.stringify(value))

  if (typeof value === 'number' && value > 0) {
    const date = new Date(value)
    span.textContent = date.toLocaleString()
    span.title = `Epoch: ${value}`
  } else {
    span.textContent = String(value)
  }

  return span
}

/**
 * Creates a collapsible array display
 */
function createArrayValue (arr, options = {}) {
  const { key, appTableManifest, depth } = options

  const container = document.createElement('div')
  container.className = 'json-array'
  container.setAttribute('data-type', 'array')
  container.setAttribute('data-raw', JSON.stringify(arr))

  if (arr.length === 0) {
    container.innerHTML = '<span class="json-value json-value-array">[]</span>'
    return container
  }

  // Check if simple array (primitives only)
  const isSimpleArray = arr.every(item =>
    item === null || ['string', 'number', 'boolean'].includes(typeof item)
  )

  if (isSimpleArray && arr.length <= COLLAPSE_THRESHOLD.arrayLength) {
    const span = document.createElement('span')
    span.className = 'json-value json-value-array'
    span.textContent = JSON.stringify(arr)
    container.appendChild(span)
    return container
  }

  // Collapsible array
  const shouldCollapse = arr.length > COLLAPSE_THRESHOLD.arrayLength || depth > 0

  const header = document.createElement('div')
  header.className = 'json-collapse-header'
  header.innerHTML = `<span class="json-collapse-icon">${shouldCollapse ? '▶' : '▼'}</span> Array[${arr.length}]`

  const content = document.createElement('div')
  content.className = 'json-collapse-content json-nested'
  if (shouldCollapse) content.style.display = 'none'

  arr.forEach((item, index) => {
    const itemDiv = document.createElement('div')
    itemDiv.className = 'json-array-item'

    const indexSpan = document.createElement('span')
    indexSpan.className = 'json-array-index'
    indexSpan.textContent = `[${index}]`
    itemDiv.appendChild(indexSpan)

    const valueEl = createValueElement(item, {
      key: `${key}[${index}]`,
      appTableManifest,
      depth: depth + 1
    })
    itemDiv.appendChild(valueEl)

    content.appendChild(itemDiv)
  })

  header.onclick = () => toggleCollapse(header, content)
  container.appendChild(header)
  container.appendChild(content)

  return container
}

/**
 * Creates a collapsible object display
 */
function createObjectValue (obj, options = {}) {
  const { key, appTableManifest, depth } = options

  const container = document.createElement('div')
  container.className = 'json-object'
  container.setAttribute('data-type', 'object')
  container.setAttribute('data-raw', JSON.stringify(obj))

  const keys = Object.keys(obj)

  if (keys.length === 0) {
    container.innerHTML = '<span class="json-value json-value-object">{}</span>'
    return container
  }

  // Collapsible object
  const shouldCollapse = keys.length > COLLAPSE_THRESHOLD.objectKeys || depth > 0

  const header = document.createElement('div')
  header.className = 'json-collapse-header'
  header.innerHTML = `<span class="json-collapse-icon">${shouldCollapse ? '▶' : '▼'}</span> Object{${keys.length}}`

  const content = document.createElement('div')
  content.className = 'json-collapse-content json-nested'
  if (shouldCollapse) content.style.display = 'none'

  const nestedManifest = appTableManifest?.field_names?.[key] || null

  keys.sort().forEach(k => {
    const fieldDiv = document.createElement('div')
    fieldDiv.className = 'json-nested-field'

    const keySpan = document.createElement('span')
    keySpan.className = 'json-key'
    keySpan.textContent = k + ':'
    fieldDiv.appendChild(keySpan)

    const valueEl = createValueElement(obj[k], {
      key: k,
      appTableManifest: nestedManifest,
      depth: depth + 1
    })
    fieldDiv.appendChild(valueEl)

    content.appendChild(fieldDiv)
  })

  header.onclick = () => toggleCollapse(header, content)
  container.appendChild(header)
  container.appendChild(content)

  return container
}

/**
 * Creates a nested object without collapse (used internally)
 */
function createNestedObject (obj, options = {}) {
  const container = document.createElement('div')
  container.className = 'json-nested-object'

  Object.keys(obj).sort().forEach(key => {
    const fieldDiv = createFieldRow(key, obj[key], {
      appTableManifest: options.appTableManifest,
      isSystemField: false
    })
    container.appendChild(fieldDiv)
  })

  return container
}

// ============================================
// EDIT MODE FUNCTIONS
// ============================================

/**
 * Enters edit mode - shows JSON in textarea for editing
 */
function enterEditMode (container) {
  const record = container._currentRecord
  const options = container._options
  const isRestoreMode = options?.mode === MODES.RESTORE
  const fieldsDiv = container.querySelector('.json-fields')
  const actionsDiv = container.querySelector('.json-actions')

  // Hide field rows but keep actions visible
  const fieldRows = fieldsDiv.querySelectorAll('.json-field')
  fieldRows.forEach(row => row.style.display = 'none')

  // Create edit area
  const editArea = document.createElement('div')
  editArea.className = 'json-edit-area'

  // Warning message
  const warning = document.createElement('div')
  warning.className = 'json-edit-warning'
  if (isRestoreMode) {
    warning.innerHTML = '⚠️ <strong>Edit Record:</strong> Modify the JSON below. Click "Confirm Edit" to apply changes before adding.'
  } else {
    warning.innerHTML = '⚠️ <strong>Warning:</strong> Editing raw JSON is dangerous. Ensure valid JSON before saving. ' +
      'Booleans, numbers, and dates will be preserved based on their type.'
  }
  editArea.appendChild(warning)

  // Textarea for JSON editing
  const textarea = document.createElement('textarea')
  textarea.className = 'json-edit-textarea'
  textarea.value = JSON.stringify(record, null, 2)
  textarea.spellcheck = false
  editArea.appendChild(textarea)

  // Validation status
  const validationDiv = document.createElement('div')
  validationDiv.className = 'json-validation'
  editArea.appendChild(validationDiv)

  // Real-time validation
  textarea.oninput = () => {
    try {
      JSON.parse(textarea.value)
      validationDiv.textContent = '✓ Valid JSON'
      validationDiv.className = 'json-validation json-validation-valid'
    } catch (e) {
      validationDiv.textContent = '✗ Invalid JSON: ' + e.message
      validationDiv.className = 'json-validation json-validation-invalid'
    }
  }
  textarea.oninput() // Initial validation

  // Insert edit area in fields div
  fieldsDiv.appendChild(editArea)

  // Toggle buttons based on mode
  actionsDiv.querySelector('.json-btn-edit').style.display = 'none'
  actionsDiv.querySelector('.json-btn-cancel').style.display = 'inline-block'
  
  if (isRestoreMode) {
    // Keep Ignore visible in edit mode (it discards edits)
    const confirmBtn = actionsDiv.querySelector('.json-btn-confirm')
    if (confirmBtn) confirmBtn.style.display = 'inline-block'
  } else {
    const deleteBtn = actionsDiv.querySelector('.json-btn-delete')
    const saveBtn = actionsDiv.querySelector('.json-btn-save')
    if (deleteBtn) deleteBtn.style.display = 'none'
    if (saveBtn) saveBtn.style.display = 'inline-block'
  }

  container._editArea = editArea
  container._textarea = textarea
}

/**
 * Exits edit mode without saving
 */
function exitEditMode (container) {
  const options = container._options
  const isRestoreMode = options?.mode === MODES.RESTORE
  const fieldsDiv = container.querySelector('.json-fields')
  const actionsDiv = container.querySelector('.json-actions')

  // Remove edit area
  if (container._editArea) {
    container._editArea.remove()
    delete container._editArea
    delete container._textarea
  }

  // Show field rows
  const fieldRows = fieldsDiv.querySelectorAll('.json-field')
  fieldRows.forEach(row => row.style.display = '')

  // Toggle buttons based on mode
  actionsDiv.querySelector('.json-btn-edit').style.display = 'inline-block'
  actionsDiv.querySelector('.json-btn-cancel').style.display = 'none'

  if (isRestoreMode) {
    const ignoreBtn = actionsDiv.querySelector('.json-btn-ignore')
    const confirmBtn = actionsDiv.querySelector('.json-btn-confirm')
    if (ignoreBtn) ignoreBtn.style.display = 'inline-block'
    if (confirmBtn) confirmBtn.style.display = 'none'
  } else {
    const deleteBtn = actionsDiv.querySelector('.json-btn-delete')
    const saveBtn = actionsDiv.querySelector('.json-btn-save')
    if (deleteBtn) deleteBtn.style.display = 'inline-block'
    if (saveBtn) saveBtn.style.display = 'none'
  }

  // Clear status
  setStatus(container, '')
}

/**
 * Confirms edit in restore mode - updates the record in memory without saving to DB
 */
function confirmEditForRestore (container, onRecordUpdated) {
  const textarea = container._textarea
  if (!textarea) return

  // Validate JSON
  let newRecord
  try {
    newRecord = JSON.parse(textarea.value)
  } catch (e) {
    setStatus(container, 'Cannot confirm: Invalid JSON - ' + e.message, 'error')
    return
  }

  // Apply type coercion
  const manifest = container._options?.appTableManifest
  newRecord = coerceTypes(newRecord, manifest)

  // Update container's current record
  container._currentRecord = newRecord
  
  // Also update the original record reference if it was passed by reference
  const options = container._options
  if (options && options.record) {
    Object.keys(options.record).forEach(key => delete options.record[key])
    Object.assign(options.record, newRecord)
  }

  // Notify parent component
  if (onRecordUpdated) {
    onRecordUpdated(newRecord)
  }

  // Refresh display
  refreshRecordDisplay(container)
  setStatus(container, 'Edit confirmed - record updated', 'success')
  setTimeout(() => setStatus(container, ''), 2000)
}

/**
 * Shows confirmation and saves changes
 */
function confirmSave (container, updateCallback) {
  const textarea = container._textarea
  if (!textarea) return

  // Validate JSON
  let newRecord
  try {
    newRecord = JSON.parse(textarea.value)
  } catch (e) {
    setStatus(container, 'Cannot save: Invalid JSON - ' + e.message, 'error')
    return
  }

  // Ensure _id is preserved
  const originalId = container._originalRecord._id
  if (newRecord._id !== originalId) {
    setStatus(container, 'Warning: _id was modified. Restoring original _id.', 'warning')
    newRecord._id = originalId
    textarea.value = JSON.stringify(newRecord, null, 2)
  }

  // Apply type coercion based on manifest and known fields
  const manifest = container._options?.appTableManifest
  newRecord = coerceTypes(newRecord, manifest)

  // Confirm save
  if (!window.confirm('Are you sure you want to save these changes? This action modifies the database directly.')) {
    return
  }

  setStatus(container, 'Saving...', 'info')

  if (updateCallback) {
    updateCallback(newRecord, (err, result) => {
      if (err || result?.error) {
        setStatus(container, 'Error saving: ' + (err?.message || result?.error), 'error')
      } else {
        // Success - refresh the display
        container._currentRecord = newRecord
        container._originalRecord = JSON.parse(JSON.stringify(newRecord))
        refreshRecordDisplay(container)
        setStatus(container, 'Saved successfully!', 'success')
        setTimeout(() => setStatus(container, ''), 3000)
      }
    })
  } else {
    container._currentRecord = newRecord
    refreshRecordDisplay(container)
    setStatus(container, 'Changes applied (no save callback provided)', 'warning')
  }
}

/**
 * Shows confirmation and deletes record
 */
function confirmDelete (container, record, deleteCallback) {
  if (!deleteCallback) {
    setStatus(container, 'Delete not available', 'warning')
    return
  }

  const confirmMsg = `Are you sure you want to DELETE this record?\n\nID: ${record._id}\n\nThis action CANNOT be undone!`

  if (!window.confirm(confirmMsg)) {
    return
  }

  // Double confirm for safety
  if (!window.confirm('FINAL WARNING: This will permanently delete the record. Continue?')) {
    return
  }

  setStatus(container, 'Deleting...', 'info')

  deleteCallback(record._id, (err, result) => {
    if (err || result?.error) {
      setStatus(container, 'Error deleting: ' + (err?.message || result?.error), 'error')
    } else {
      container.innerHTML = '<div class="json-deleted">Record deleted</div>'
    }
  })
}

/**
 * Refreshes the record display after edit
 */
function refreshRecordDisplay (container) {
  const fieldsDiv = container.querySelector('.json-fields')
  const actionsDiv = container.querySelector('.json-actions')
  const record = container._currentRecord
  const options = container._options

  // Remove old field rows (but keep actions bar)
  const fieldRows = fieldsDiv.querySelectorAll('.json-field')
  fieldRows.forEach(row => row.remove())
  
  // Remove edit area if present
  const editArea = fieldsDiv.querySelector('.json-edit-area')
  if (editArea) editArea.remove()

  // Rebuild field rows
  const sortedKeys = getSortedKeys(record)
  sortedKeys.forEach(key => {
    const fieldDiv = createFieldRow(key, record[key], {
      appTableManifest: options?.appTableManifest,
      isSystemField: key.startsWith('_'),
      recordId: record._id
    })
    fieldsDiv.appendChild(fieldDiv)
  })

  // Reset button visibility
  if (actionsDiv) {
    const isRestoreMode = options?.mode === MODES.RESTORE
    
    const editBtn = actionsDiv.querySelector('.json-btn-edit')
    const cancelBtn = actionsDiv.querySelector('.json-btn-cancel')
    
    if (editBtn) editBtn.style.display = 'inline-block'
    if (cancelBtn) cancelBtn.style.display = 'none'
    
    if (isRestoreMode) {
      const ignoreBtn = actionsDiv.querySelector('.json-btn-ignore')
      const confirmBtn = actionsDiv.querySelector('.json-btn-confirm')
      if (ignoreBtn) ignoreBtn.style.display = 'inline-block'
      if (confirmBtn) confirmBtn.style.display = 'none'
    } else {
      const deleteBtn = actionsDiv.querySelector('.json-btn-delete')
      const saveBtn = actionsDiv.querySelector('.json-btn-save')
      if (deleteBtn) deleteBtn.style.display = 'inline-block'
      if (saveBtn) saveBtn.style.display = 'none'
    }
  }

  // Clear edit state
  delete container._editArea
  delete container._textarea
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Coerces values to their proper types based on manifest and known fields
 */
function coerceTypes (record, manifest) {
  const result = { ...record }

  for (const key in result) {
    const value = result[key]

    // Skip null/undefined
    if (value === null || value === undefined) continue

    // Get expected type from manifest or known fields
    const expectedType = getExpectedType(key, manifest)

    // Coerce based on expected type
    if (expectedType === 'number' && typeof value === 'string') {
      const num = Number(value)
      if (!isNaN(num)) result[key] = num
    } else if (expectedType === 'boolean' && typeof value === 'string') {
      if (value === 'true') result[key] = true
      else if (value === 'false') result[key] = false
    } else if (expectedType === 'date' && typeof value === 'string') {
      const timestamp = Date.parse(value)
      if (!isNaN(timestamp)) result[key] = timestamp
    }

    // Auto-detect: if value looks like a number, convert it
    if (typeof value === 'string' && !expectedType) {
      if (/^-?\d+\.?\d*$/.test(value.trim())) {
        const num = Number(value)
        if (!isNaN(num) && num.toString() === value.trim()) {
          result[key] = num
        }
      } else if (value === 'true') {
        result[key] = true
      } else if (value === 'false') {
        result[key] = false
      }
    }
  }

  return result
}

/**
 * Gets expected type for a field from manifest or known fields
 */
function getExpectedType (key, manifest) {
  // System date fields
  if (SYSTEM_DATE_FIELDS.includes(key)) {
    return 'date'
  }

  // Check manifest
  if (manifest?.field_names?.[key]?.type) {
    return manifest.field_names[key].type
  }

  return null
}

/**
 * Gets the field type for display purposes
 */
function getFieldType (key, value, manifest) {
  // System date fields
  if (SYSTEM_DATE_FIELDS.includes(key)) {
    return 'date'
  }

  // Check manifest
  if (manifest?.field_names?.[key]?.type) {
    return manifest.field_names[key].type
  }

  // Infer from value
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Sorts keys with system fields first, then alphabetically
 */
function getSortedKeys (obj) {
  const keys = Object.keys(obj)
  const systemKeys = keys.filter(k => k.startsWith('_')).sort()
  const userKeys = keys.filter(k => !k.startsWith('_')).sort()

  // Put _id first if present
  const idIndex = systemKeys.indexOf('_id')
  if (idIndex > 0) {
    systemKeys.splice(idIndex, 1)
    systemKeys.unshift('_id')
  }

  return [...systemKeys, ...userKeys]
}

/**
 * Toggles collapse state of a section
 */
function toggleCollapse (header, content) {
  const icon = header.querySelector('.json-collapse-icon')
  const isCollapsed = content.style.display === 'none'

  if (isCollapsed) {
    content.style.display = ''
    icon.textContent = '▼'
  } else {
    content.style.display = 'none'
    icon.textContent = '▶'
  }
}

/**
 * Sets status message on container
 */
function setStatus (container, message, type = '') {
  const statusDiv = container.querySelector('.json-status')
  if (!statusDiv) return

  statusDiv.textContent = message
  statusDiv.className = 'json-status' + (type ? ` json-status-${type}` : '')
}

// Legacy exports for backward compatibility
function getTopLevelObjectValueDivFrom (evt) {
  let currentEl = evt.target
  while (currentEl && currentEl.tagName !== 'BODY' && !currentEl.getAttribute('data-record-id')) {
    currentEl = currentEl.parentElement
  }
  return currentEl?.tagName !== 'BODY' ? currentEl : null
}

function getRecordOuterDivFrom (theEl) {
  return getTopLevelObjectValueDivFrom({ target: theEl })
}

export { createObjectDiv, getTopLevelObjectValueDivFrom, getRecordOuterDivFrom }
