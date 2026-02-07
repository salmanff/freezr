// manage_users – batched fetch, pagination, client-side sort

/* global freezr */

const BATCH_SIZE = 20
const PAGE_SIZE = 10

let selectedUsers = new Set()
let allUsers = []
let currentPage = 1
let sortKey = 'user_id'
let sortDir = 1
let loading = false
let currentSearch = ''

freezr.initPageScripts = function () {
  initSearch()
  initSortableHeaders()
  initUserSelection()
  initPagination()
  initFetchMore()
  initResetPassword()
  initDeleteSelected()
  initUpdateLimits()
  initChangeRights()
  initializeFileDropArea()
  initializeUsageUpdates()
  initializeRefreshButton()
  fetchFirstBatch()
}

function getNested (obj, path) {
  return path.split('.').reduce((o, p) => (o && o[p]), obj)
}

function getSortedUsers () {
  const key = sortKey
  const dir = sortDir
  return [...allUsers].sort((a, b) => {
    let va = getNested(a, key)
    let vb = getNested(b, key)
    if (va == null) va = ''
    if (vb == null) vb = ''
    if (typeof va === 'string') va = va.toLowerCase()
    if (typeof vb === 'string') vb = vb.toLowerCase()
    if (va < vb) return -dir
    if (va > vb) return dir
    return 0
  })
}

function getPageRows () {
  const sorted = getSortedUsers()
  const start = (currentPage - 1) * PAGE_SIZE
  return sorted.slice(start, start + PAGE_SIZE)
}

function totalPages () {
  return Math.max(1, Math.ceil(getSortedUsers().length / PAGE_SIZE))
}

function updateSortIndicators () {
  document.querySelectorAll('.sort-indicator').forEach(el => { el.textContent = '' })
  const ind = document.getElementById('sortIndicator_' + sortKey.replace(/\./g, '\\.'))
  if (ind) ind.textContent = sortDir === 1 ? '↑' : '↓'
}

function buildListUsersUrl (skip, limit) {
  const url = '/adminapi/list_users?skip=' + skip + '&limit=' + limit
  if (currentSearch) return url + '&search=' + encodeURIComponent(currentSearch)
  return url
}

function runSearchOnServer () {
  const input = document.getElementById('searchUserInput')
  const q = (input?.value || '').trim()
  currentSearch = q
  allUsers = []
  selectedUsers.clear()
  currentPage = 1
  updateSelectedCount()
  updateFetchMoreBar()
  if (!q) {
    fetchFirstBatch()
    return
  }
  loading = true
  updateFetchMoreBar()
  ;(async function () {
    try {
      const res = await freezr.apiRequest('GET', buildListUsersUrl(0, 50))
      const list = (res && res.users) ? res.users : []
      allUsers = list
      updateSortIndicators()
      renderTable()
    } catch (err) {
      console.error('searchOnServer', err)
      allUsers = []
      renderTable()
    } finally {
      loading = false
      updateFetchMoreBar()
    }
  })()
}

function initSearch () {
  const input = document.getElementById('searchUserInput')
  const btn = document.getElementById('btnSearchOnServer')
  btn?.addEventListener('click', runSearchOnServer)
  input?.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      runSearchOnServer()
    }
  })
}

function initSortableHeaders () {
  document.querySelectorAll('.grid-header .sortable').forEach(el => {
    el.addEventListener('click', () => {
      const key = el.getAttribute('data-sort')
      if (!key) return
      if (sortKey === key) sortDir = -sortDir
      else { sortKey = key; sortDir = 1 }
      updateSortIndicators()
      renderTable()
    })
  })
}

function renderTable () {
  const body = document.getElementById('usersGridBody')
  const rows = getPageRows()
  if (!body) return

  body.innerHTML = rows.map(u => {
    const limits = u.limits || {}
    const limitsMB = limits.totalSizeMB != null ? limits.totalSizeMB + 'MB' : ''
    const limitsStr = limits.totalSize != null ? limitsMB : 'Not updated'
    const timeStr = limits.timeString ? `<span class="time-info">${limits.timeString}</span>` : ''
    const storageLimitMB = (limits.storage != null && limits.storage > 0) ? limits.storage + ' MB' : '—'
    const badges = []
    if (u.isAdmin) badges.push('<span class="badge badge-admin">admin</span>')
    if (u.isPublisher) badges.push('<span class="badge badge-pub">pub</span>')
    const fsType = (u.fsParams && u.fsParams.type) ? u.fsParams.type : ''
    const dbType = (u.dbParams && u.dbParams.type) ? u.dbParams.type : ''
    const checked = selectedUsers.has(u.user_id) ? ' checked' : ''
    return `
      <div class="user-row" data-user-id="${escapeHtml(u.user_id)}">
        <div class="checkbox-col">
          <input type="checkbox" class="user-checkbox" value="${escapeHtml(u.user_id)}"${checked}/>
        </div>
        <div class="name-col">${escapeHtml(u.user_id)} ${badges.join(' ')}</div>
        <div class="email-col">${escapeHtml(u.email_address || '')}</div>
        <div class="fs-col">${escapeHtml(fsType)}</div>
        <div class="db-col">${escapeHtml(dbType)}</div>
        <div class="storage-limit-col">${escapeHtml(storageLimitMB)}</div>
        <div class="limits-col">
          <span class="limitsForUsers" id="limitsAreaFor_${escapeHtml(u.user_id)}">
            <span id="limitNumberFor_${escapeHtml(u.user_id)}">${escapeHtml(limitsStr)}</span>
            <span id="click_UpdatelimitsFor_${escapeHtml(u.user_id)}" class="update-link">(update)</span>
            ${timeStr}
            <a href="/admin/resourceusage?user=${encodeURIComponent(u.user_id)}">(details)</a>
          </span>
        </div>
      </div>
    `
  }).join('')

  updatePagination()
  updateSelectAllState()
  updateSelectedCount()
}

function escapeHtml (s) {
  if (s == null) return ''
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}

function updatePagination () {
  const total = totalPages()
  const prevBtn = document.getElementById('btnPrevPage')
  const nextBtn = document.getElementById('btnNextPage')
  const infoEl = document.getElementById('paginationInfo')
  if (prevBtn) {
    prevBtn.disabled = currentPage <= 1
  }
  if (nextBtn) {
    nextBtn.disabled = currentPage >= total
  }
  if (infoEl) {
    infoEl.textContent = `Page ${currentPage} of ${total}`
  }
}

function updateFetchMoreBar (hideFetchMoreButton = false) {
  const countEl = document.getElementById('usersFetchedCount')
  const btn = document.getElementById('btnFetchMore')
  const bar = document.querySelector('.fetch-more-bar')
  if (countEl) countEl.textContent = `${allUsers.length} users fetched`
  if (btn) btn.disabled = loading
  btn.style.display = hideFetchMoreButton ? 'none' : 'block'
  // if (bar) bar.classList.toggle('fetch-more-hidden', allUsers.length === 0)
}

function initUserSelection () {
  const selectAll = document.getElementById('selectAllUsers')
  const body = document.getElementById('usersGridBody')
  if (!body) return

  body.addEventListener('change', function (e) {
    if (!e.target.classList.contains('user-checkbox')) return
    const cb = e.target
    if (cb.checked) selectedUsers.add(cb.value)
    else selectedUsers.delete(cb.value)
    updateSelectAllState()
    updateSelectedCount()
  })

  if (selectAll) {
    selectAll.addEventListener('change', function () {
    const rows = getPageRows()
    const checkboxes = body.querySelectorAll('.user-checkbox')
    const isChecked = this.checked
    checkboxes.forEach((cb, i) => {
      cb.checked = isChecked
      const uid = rows[i] && rows[i].user_id
      if (uid) {
        if (isChecked) selectedUsers.add(uid)
        else selectedUsers.delete(uid)
      }
    })
    updateSelectedCount()
    })
  }
}

function updateSelectAllState () {
  const selectAll = document.getElementById('selectAllUsers')
  const body = document.getElementById('usersGridBody')
  if (!selectAll || !body) return
  const checkboxes = body.querySelectorAll('.user-checkbox')
  const checked = Array.from(checkboxes).filter(cb => cb.checked).length
  selectAll.checked = checkboxes.length > 0 && checked === checkboxes.length
  selectAll.indeterminate = checked > 0 && checked < checkboxes.length
}

function updateSelectedCount () {
  const el = document.getElementById('selectedCount')
  if (el) el.textContent = selectedUsers.size
  const btnReset = document.getElementById('btnResetPassword')
  if (btnReset) {
    const currentUserId = (typeof freezrMeta !== 'undefined' && freezrMeta.userId) ? freezrMeta.userId : null
    const oneSelected = selectedUsers.size === 1
    const selectedId = oneSelected ? Array.from(selectedUsers)[0] : null
    const isSelf = currentUserId && selectedId === currentUserId
    btnReset.disabled = !oneSelected || isSelf
  }
  const btnDelete = document.getElementById('btnDeleteSelected')
  if (btnDelete) {
    btnDelete.disabled = selectedUsers.size === 0
    btnDelete.style.opacity = selectedUsers.size === 0 ? '0.6' : '1'
  }
  const btnLimits = document.getElementById('btnUpdateLimits')
  if (btnLimits) {
    btnLimits.disabled = selectedUsers.size !== 1
  }
  const btnRights = document.getElementById('btnChangeRights')
  if (btnRights) {
    btnRights.disabled = selectedUsers.size !== 1
  }
}

function initResetPassword () {
  const btnReset = document.getElementById('btnResetPassword')
  const dialog = document.getElementById('resetPasswordDialog')
  const backdrop = dialog?.querySelector('.reset-password-dialog-backdrop')
  const input = document.getElementById('resetPasswordNewPassword')
  const btnCancel = document.getElementById('btnResetPasswordCancel')
  const btnSubmit = document.getElementById('btnResetPasswordSubmit')
  const btnGenerate = document.getElementById('btnGeneratePassword')
  const errorEl = document.getElementById('resetPasswordError')

  const generatedDisplay = document.getElementById('resetPasswordGeneratedDisplay')
  const generatedText = document.getElementById('resetPasswordGeneratedText')

  function closeDialog () {
    if (dialog) dialog.style.display = 'none'
    if (input) input.value = ''
    if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = '' }
    if (generatedDisplay) generatedDisplay.style.display = 'none'
    if (generatedText) generatedText.textContent = ''
  }

  function openDialog (userId) {
    const nameEl = document.getElementById('resetPasswordUserName')
    if (nameEl) nameEl.textContent = userId
    if (input) { input.value = ''; input.focus() }
    if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = '' }
    if (generatedDisplay) generatedDisplay.style.display = 'none'
    if (generatedText) generatedText.textContent = ''
    if (dialog) dialog.style.display = 'flex'
  }

  btnReset?.addEventListener('click', function () {
    if (selectedUsers.size !== 1) return
    const userId = Array.from(selectedUsers)[0]
    if (typeof freezrMeta !== 'undefined' && freezrMeta.userId === userId) {
      alert('You cannot reset your own password here. Use Account settings to change your password.')
      return
    }
    openDialog(userId)
  })

  backdrop?.addEventListener('click', closeDialog)
  btnCancel?.addEventListener('click', closeDialog)

  btnGenerate?.addEventListener('click', async function () {
    const pw = generateRandomPassword()
    if (input) input.value = pw
    if (generatedText) generatedText.textContent = pw
    if (generatedDisplay) generatedDisplay.style.display = 'block'
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(pw)
      } else {
        copyToClipboardFallback(pw)
      }
    } catch (e) {
      copyToClipboardFallback(pw)
    }
  })

  btnSubmit?.addEventListener('click', async function () {
    const userId = document.getElementById('resetPasswordUserName')?.textContent
    const newPassword = input?.value?.trim()
    if (!userId || !newPassword) {
      if (errorEl) { errorEl.textContent = 'Please enter a new password.'; errorEl.style.display = 'block' }
      return
    }
    if (typeof freezrMeta !== 'undefined' && freezrMeta.userId === userId) {
      if (errorEl) { errorEl.textContent = 'You cannot reset your own password here. Use Account settings.'; errorEl.style.display = 'block' }
      return
    }
    if (errorEl) errorEl.style.display = 'none'
    try {
      await freezr.apiRequest('POST', '/adminapi/reset_user_password', { user_id: userId, newPassword })
      closeDialog()
      alert('Password reset successfully for ' + userId + '.')
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = err.message || 'Failed to reset password.'
        errorEl.style.display = 'block'
      }
    }
  })
}

function initDeleteSelected () {
  const btnDelete = document.getElementById('btnDeleteSelected')
  btnDelete?.addEventListener('click', async function () {
    if (selectedUsers.size === 0) return
    const currentUserId = (typeof freezrMeta !== 'undefined' && freezrMeta.userId) ? freezrMeta.userId : null
    const toDelete = Array.from(selectedUsers)
    const skipSelf = currentUserId && toDelete.includes(currentUserId)
    const n = toDelete.length
    const msg = skipSelf
      ? `Delete ${n} user(s)? Your own account will be skipped. This cannot be undone.`
      : `Delete ${n} user(s)? This cannot be undone.`
    if (!confirm(msg)) return
    showActionStatus('Deleting users', toDelete)
    try {
      const response = await freezr.apiRequest('POST', '/adminapi/delete_users', { user_ids: toDelete })
      hideActionStatus()
      showDeleteResults(response)
      const deleted = response.deleted || []
      deleted.forEach(uid => {
        allUsers = allUsers.filter(u => u.user_id !== uid)
        selectedUsers.delete(uid)
      })
      updateSortIndicators()
      renderTable()
      updatePaginationBar()
      updateFetchMoreBar()
      updateSelectedCount()
    } catch (err) {
      hideActionStatus()
      showActionResults('Delete Users', err, null)
    }
  })
}

function showDeleteResults (response) {
  const actionResults = document.getElementById('actionResults')
  const resultsContent = document.getElementById('resultsContent')
  const resultsTitleElement = document.getElementById('resultsTitle')
  resultsTitleElement.textContent = 'Delete Users Results'
  const deleted = response.deleted || []
  const failed = response.failed || []
  const skipped = response.skipped || []
  const summary = response.summary || {}
  let html = ''
  if (deleted.length) {
    html += `<div class="result-summary success">✅ Deleted: ${deleted.join(', ')}</div>`
  }
  if (skipped.length) {
    html += `<div class="result-section"><h4>⏭ Skipped</h4><ul class="result-list">`
    skipped.forEach(s => {
      html += `<li>${s.userId}: ${s.reason || 'skipped'}</li>`
    })
    html += '</ul></div>'
  }
  if (failed.length) {
    html += '<div class="result-section"><h4>❌ Failed</h4><ul class="result-list">'
    failed.forEach(f => {
      html += `<li class="failure">${f.userId}: ${f.error || 'Unknown error'}</li>`
    })
    html += '</ul></div>'
  }
  html += `<div class="result-details"><div class="result-section"><h4>Summary</h4><ul class="result-list">
    <li>Deleted: ${summary.deletedCount ?? deleted.length}</li>
    <li>Failed: ${summary.failedCount ?? failed.length}</li>
    <li>Skipped: ${summary.skippedCount ?? skipped.length}</li>
  </ul></div></div>`
  resultsContent.innerHTML = html
  actionResults.style.display = 'block'
  selectedUsers.clear()
  document.querySelectorAll('.user-checkbox').forEach(cb => { cb.checked = false })
  const selectAll = document.getElementById('selectAllUsers')
  if (selectAll) { selectAll.checked = false; selectAll.indeterminate = false }
  updateSelectedCount()
}

function initUpdateLimits () {
  const btnLimits = document.getElementById('btnUpdateLimits')
  const dialog = document.getElementById('updateLimitsDialog')
  const backdrop = dialog?.querySelector('.reset-password-dialog-backdrop')
  const input = document.getElementById('updateLimitsStorageInput')
  const btnCancel = document.getElementById('btnUpdateLimitsCancel')
  const btnSubmit = document.getElementById('btnUpdateLimitsSubmit')
  const errorEl = document.getElementById('updateLimitsError')

  function closeDialog () {
    if (dialog) dialog.style.display = 'none'
    if (input) input.value = ''
    if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = '' }
  }

  function openDialog (userId) {
    const nameEl = document.getElementById('updateLimitsUserName')
    if (nameEl) nameEl.textContent = userId
    // Pre-fill with current limit if available
    const user = allUsers.find(u => u.user_id === userId)
    const currentLimit = user?.limits?.storage
    if (input) {
      input.value = currentLimit != null && currentLimit > 0 ? currentLimit : ''
      input.focus()
    }
    if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = '' }
    if (dialog) dialog.style.display = 'flex'
  }

  btnLimits?.addEventListener('click', function () {
    if (selectedUsers.size !== 1) return
    const userId = Array.from(selectedUsers)[0]
    openDialog(userId)
  })

  backdrop?.addEventListener('click', closeDialog)
  btnCancel?.addEventListener('click', closeDialog)

  btnSubmit?.addEventListener('click', async function () {
    const userId = document.getElementById('updateLimitsUserName')?.textContent
    const storageValue = input?.value?.trim()
    const storageMB = storageValue === '' ? 0 : parseInt(storageValue, 10)
    if (isNaN(storageMB) || storageMB < 0) {
      if (errorEl) { errorEl.textContent = 'Please enter a valid number (0 or greater).'; errorEl.style.display = 'block' }
      return
    }
    if (errorEl) errorEl.style.display = 'none'
    try {
      const response = await freezr.apiRequest('POST', '/adminapi/update_user_limits', { user_id: userId, limits: { storage: storageMB } })
      console.log('updateLimits', { response })
      closeDialog()
      // Update local user data
      const user = allUsers.find(u => u.user_id === userId)
      if (user) {
        if (!user.limits) user.limits = {}
        user.limits.storage = storageMB
      }
      renderTable()
      alert('Storage limit updated successfully for ' + userId + '.')
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = err.message || 'Failed to update limits.'
        errorEl.style.display = 'block'
      }
    }
  })
}

function initChangeRights () {
  const btnRights = document.getElementById('btnChangeRights')
  const dialog = document.getElementById('changeRightsDialog')
  const backdrop = dialog?.querySelector('.reset-password-dialog-backdrop')
  const checkAdmin = document.getElementById('changeRightsIsAdmin')
  const checkPublisher = document.getElementById('changeRightsIsPublisher')
  const btnCancel = document.getElementById('btnChangeRightsCancel')
  const btnSubmit = document.getElementById('btnChangeRightsSubmit')
  const errorEl = document.getElementById('changeRightsError')

  function closeDialog () {
    if (dialog) dialog.style.display = 'none'
    if (checkAdmin) { checkAdmin.checked = false; checkAdmin.disabled = false }
    if (checkPublisher) checkPublisher.checked = false
    if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = '' }
  }

  function openDialog (userId) {
    const nameEl = document.getElementById('changeRightsUserName')
    if (nameEl) nameEl.textContent = userId
    // Pre-fill with current rights
    const user = allUsers.find(u => u.user_id === userId)
    const userIsAdmin = !!user?.isAdmin
    if (checkAdmin) {
      checkAdmin.checked = userIsAdmin
      // Guard: cannot grant admin rights through this method (can only revoke)
      // If user is not admin, disable the checkbox so it can't be checked
      checkAdmin.disabled = !userIsAdmin
    }
    if (checkPublisher) checkPublisher.checked = !!user?.isPublisher
    if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = '' }
    if (dialog) dialog.style.display = 'flex'
  }

  btnRights?.addEventListener('click', function () {
    if (selectedUsers.size !== 1) return
    const userId = Array.from(selectedUsers)[0]
    openDialog(userId)
  })

  backdrop?.addEventListener('click', closeDialog)
  btnCancel?.addEventListener('click', closeDialog)

  btnSubmit?.addEventListener('click', async function () {
    const userId = document.getElementById('changeRightsUserName')?.textContent
    const isAdmin = checkAdmin?.checked || false
    const isPublisher = checkPublisher?.checked || false
    if (errorEl) errorEl.style.display = 'none'
    try {
      await freezr.apiRequest('POST', '/adminapi/change_user_rights', { user_id: userId, isAdmin, isPublisher })
      closeDialog()
      // Update local user data
      const user = allUsers.find(u => u.user_id === userId)
      if (user) {
        user.isAdmin = isAdmin
        user.isPublisher = isPublisher
      }
      renderTable()
      alert('Rights updated successfully for ' + userId + '.')
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = err.message || 'Failed to update rights.'
        errorEl.style.display = 'block'
      }
    }
  })
}

function generateRandomPassword (length = 14) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%'
  let pw = ''
  for (let i = 0; i < length; i++) {
    pw += chars[Math.floor(Math.random() * chars.length)]
  }
  return pw
}

function copyToClipboardFallback (text) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.left = '-9999px'
  ta.style.top = '0'
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  try {
    document.execCommand('copy')
  } catch (e) {
    /* ignore */
  }
  document.body.removeChild(ta)
}

function initPagination () {
  document.getElementById('btnPrevPage')?.addEventListener('click', () => {
    if (currentPage <= 1) return
    currentPage--
    renderTable()
  })
  document.getElementById('btnNextPage')?.addEventListener('click', () => {
    if (currentPage >= totalPages()) return
    currentPage++
    renderTable()
  })
}

function initFetchMore () {
  document.getElementById('btnFetchMore')?.addEventListener('click', fetchMoreUsers)
}

async function fetchFirstBatch () {
  if (loading) return
  currentSearch = ''
  const searchInput = document.getElementById('searchUserInput')
  if (searchInput) searchInput.value = ''
  loading = true
  updateFetchMoreBar()
  try {
    const res = await freezr.apiRequest('GET', buildListUsersUrl(0, BATCH_SIZE))
    const list = (res && res.users) ? res.users : []
    allUsers = list
    currentPage = 1
    updateSortIndicators()
    renderTable()
  } catch (err) {
    console.error('fetchFirstBatch', err)
    allUsers = []
    renderTable()
  } finally {
    loading = false
    updateFetchMoreBar()
  }
}

async function fetchMoreUsers () {
  if (loading) return
  loading = true
  updateFetchMoreBar()
  let noneFetched = false
  try {
    const res = await freezr.apiRequest('GET', buildListUsersUrl(allUsers.length, BATCH_SIZE))
    const list = (res && res.users) ? res.users : []
    console.log('fetchMoreUsers', { list, allUsers })
    noneFetched = list.length === 0
    allUsers = allUsers.concat(list)
    updateFetchMoreBar()
    renderTable()
  } catch (err) {
    console.error('fetchMoreUsers', err)
  } finally {
    loading = false
    updateFetchMoreBar(noneFetched)
  }
}

const initializeFileDropArea = function () {
  const dropArea = document.getElementById('appInstallDropArea')
  const fileInput = document.getElementById('appFileInput')

  dropArea?.addEventListener('click', function () { fileInput?.click() })
  fileInput?.addEventListener('change', function (e) {
    if (e.target.files?.length) handleFileDrop(e.target.files[0])
  })
  dropArea?.addEventListener('dragover', function (e) {
    e.preventDefault()
    this.classList.add('drag-over')
  })
  dropArea?.addEventListener('dragleave', function (e) {
    e.preventDefault()
    this.classList.remove('drag-over')
  })
  dropArea?.addEventListener('drop', function (e) {
    e.preventDefault()
    this.classList.remove('drag-over')
    if (e.dataTransfer?.files?.length) handleFileDrop(e.dataTransfer.files[0])
  })
}

const handleFileDrop = function (file) {
  if (selectedUsers.size === 0) {
    alert('Please select at least one user before dropping a file.')
    return
  }
  showActionStatus('Installing app for', Array.from(selectedUsers))
  const formData = new FormData()
  formData.append('file', file)
  Array.from(selectedUsers).forEach(userId => { formData.append('userIds[]', userId) })
  ;(async () => {
    try {
      const response = await freezr.apiRequest('PUT', '/adminapi/install_app_for_users', formData, { uploadFile: true })
      hideActionStatus()
      showActionResults('Installation Results', null, response)
    } catch (err) {
      hideActionStatus()
      showActionResults('Installation Results', err, null)
    }
  })()
}

const showActionStatus = function (actionText, userIds) {
  const mainContent = document.getElementById('mainContent')
  const actionStatus = document.getElementById('actionStatus')
  const actionStatusText = document.getElementById('actionStatusText')
  const userText = userIds.length === 1 ? userIds[0] : userIds.length <= 3 ? userIds.join(', ') : `${userIds.length} users`
  actionStatusText.textContent = `${actionText} ${userText}...`
  mainContent.style.display = 'none'
  actionStatus.style.display = 'block'
}

const hideActionStatus = function () {
  const actionStatus = document.getElementById('actionStatus')
  actionStatus.style.display = 'none'
}

const showActionResults = function (resultsTitle, err, response) {
  const actionResults = document.getElementById('actionResults')
  const resultsContent = document.getElementById('resultsContent')
  const resultsTitleElement = document.getElementById('resultsTitle')
  resultsTitleElement.textContent = resultsTitle
  let html = ''
  if (err) {
    html = `<div class="result-summary failure">❌ Installation failed: ${err.message || 'Unknown error'}</div>`
  } else {
    const { results } = response
    const { totalUsers, successful, failed, summary } = results
    let summaryClass = 'success'
    let summaryIcon = '✅'
    let summaryText = 'All installations completed successfully!'
    if (summary.failureCount > 0 && summary.successCount === 0) {
      summaryClass = 'failure'
      summaryIcon = '❌'
      summaryText = 'All installations failed'
    } else if (summary.failureCount > 0) {
      summaryClass = 'partial'
      summaryIcon = '⚠️'
      summaryText = 'Some installations failed'
    }
    html = `
      <div class="result-summary ${summaryClass}">${summaryIcon} ${summaryText}</div>
      <div class="result-details">
        <div class="result-section">
          <h4>Summary</h4>
          <ul class="result-list">
            <li>Total users: ${totalUsers}</li>
            <li>Successful: ${summary.successCount}</li>
            <li>Failed: ${summary.failureCount}</li>
          </ul>
        </div>
    `
    if (successful?.length) {
      html += '<div class="result-section"><h4>✅ Successful Installations</h4><ul class="result-list">'
      successful.forEach(s => {
        html += `<li class="success">${s.userId}: ${s.appName} ${s.isUpdate ? '(updated)' : '(installed)'}</li>`
      })
      html += '</ul></div>'
    }
    if (failed?.length) {
      html += '<div class="result-section"><h4>❌ Failed Installations</h4><ul class="result-list">'
      failed.forEach(f => {
        html += `<li class="failure">${f.userId}: ${f.error?.message || f.error}</li>`
      })
      html += '</ul></div>'
    }
    const allWarnings = []
    successful?.forEach(s => {
      if (s.warnings?.length) {
        s.warnings.forEach(w => allWarnings.push({ userId: s.userId, ...w }))
      }
    })
    if (allWarnings.length) {
      html += '<div class="warnings-section"><h4>⚠️ Warnings</h4>'
      allWarnings.forEach(w => {
        html += `<div class="warning-item"><strong>${w.userId}:</strong> ${w.message}${w.appName ? ' (' + w.appName + ')' : ''}</div>`
      })
      html += '</div>'
    }
    html += '</div>'
  }
  resultsContent.innerHTML = html
  actionResults.style.display = 'block'
  selectedUsers.clear()
  document.querySelectorAll('.user-checkbox').forEach(cb => { cb.checked = false })
  const selectAll = document.getElementById('selectAllUsers')
  if (selectAll) { selectAll.checked = false; selectAll.indeterminate = false }
  updateSelectedCount()
}

const initializeUsageUpdates = function () {
  document.onclick = function (e) {
    if (e.target.id?.indexOf('click') === 0) getUsage(e.target)
  }
}

const getUsage = async function (target) {
  const userId = target.id.split('_')[2]
  const url = '/adminapi/getuserappresources' + (userId ? '?user=' + userId : '')
  try {
    const resources = await freezr.apiRequest('GET', url)
    const prev = target.previousElementSibling
    if (prev) prev.innerText = resources?.totalSize ? ((Math.round(resources.totalSize / 100000) / 10) + 'MB') : ' - '
  } catch (err) {
    console.error(err)
    alert('error connecting to server ' + err.message)
  }
}

const initializeRefreshButton = function () {
  document.getElementById('refreshPageBtn')?.addEventListener('click', () => window.location.reload())
}
