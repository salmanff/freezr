// Account Settings page modernized v
/* global freezr, freepr, freezrMeta, alert, confirm, FormData */

freezr.initPageScripts = async function () {
  console.log('account_settings.js loaded 0')
  showError('', 10)

  const userIdEl = document.getElementById('user_id')
  if (userIdEl) userIdEl.innerHTML = '(' + freezrMeta.userId + ')'

  document.getElementById('changePassword').onsubmit = function (evt) {
    evt.preventDefault()

    const oldPassword = document.getElementById('oldPassword').value
    const newPassword = document.getElementById('newPassword').value
    const password2 = document.getElementById('password2').value

    if (!oldPassword) {
      showError('Please enter your current password')
    } else if (!newPassword) {
      showError('Please enter a new password')
    } else if (!password2 || newPassword !== password2) {
      showError('Passwords have to match')
    } else {
      const theInfo = {
        user_id: freezrMeta.userId,
        oldPassword,
        newPassword
      }
      freezr.apiRequest('PUT', '/acctapi/changePassword', theInfo)
        .then(data => gotPasswordChangeStatus(null, data))
        .catch(error => gotPasswordChangeStatus(error, null))
    }

  }

  document.getElementById('removeMe').onsubmit = function (evt) {
    evt.preventDefault()

    const oldPassword = document.getElementById('oldPasswordConfirm').value

    if (!oldPassword) {
      showError('Please enter your current password')
    } else if (freezrMeta.adminuser) {
      showError('Sorry - cannot remove admin users')
    } else {
      const theInfo = {
        user_id: freezrMeta.userId,
        oldPassword
      }
      const currentfs = document.getElementById('fsParamsType').innerText
      const currentdb = document.getElementById('dbParamsType').innerText
      if (confirm('Are you sure you want to completely remove yourself?')) {
        freezr.apiRequest('PUT', '/acctapi/removeFromFreezr', theInfo)
          .then(data => gotRemoveStatus(null, data))
          .catch(error => gotRemoveStatus(error, null))
      }
    }
  }
  
  try {
    const prefs = await freezr.utils.getPrefs()
    console.log('🔑 prefs', { prefs })
    document.getElementById('userBlockMsgsToNonContacts').checked = prefs.blockMsgsToNonContacts
    document.getElementById('userBlockMsgsFromNonContacts').checked = prefs.blockMsgsFromNonContacts
  } catch (error) {
    console.warn('error getting prefs', { error })
    showError('Error getting prefs - ' + error.message)
  }
  document.getElementById('savePrefsButt').onclick = function (evt) {
    evt.preventDefault()
    // onsole.log(evt)

    const theInfo = {
      blockMsgsToNonContacts: document.getElementById('userBlockMsgsToNonContacts').checked,
      blockMsgsFromNonContacts: document.getElementById('userBlockMsgsFromNonContacts').checked
    }

    freezr.apiRequest('PUT', '/acctapi/setPrefs', theInfo)
      .then(data => gotChangePrefsStatus(null, data))
      .catch(error => gotChangePrefsStatus(error, null))
    /// previously /v1/account/data/setPrefs.json
  }

  document.getElementById('choosePict').onclick = choosePict
  
  const profilePictDelete = document.getElementById('profilePictDelete')
  const profilePictOuter = document.getElementById('profilePictOuter')
  const profilePictInner = document.getElementById('profilePictInner')
  const profilePictPathMsg = document.getElementById('profilePictPathMsg')
  const outerGrid = document.getElementById('outerGrid')
  
  if (profilePictDelete) profilePictDelete.onclick = deletePict
  
  if (profilePictInner) {
    profilePictInner.onerror = function () {
      console.warn('No profile picture found')
      if (profilePictDelete) profilePictDelete.style.display = 'none'
      if (profilePictOuter) profilePictOuter.style.display = 'none'
      if (profilePictPathMsg) profilePictPathMsg.style.display = 'none'
      if (outerGrid) {
        outerGrid.style['grid-template-columns'] = '1fr'
        outerGrid.style.gap = '0'
      }
    }
    profilePictInner.src = '/@' + freezrMeta.userId + '/info.freezr.account.files/profilePict.jpg?timestamp=' + new Date().getTime()
  }
  if (isIos()) {
    document.getElementById('upload_area').style.display = 'none'
    document.getElementById('choosePict').innerHTML = 'Choose a Picture'
  }

  document.getElementById('uploadPictNow').onclick = async function (evt) {
    const fileInput = document.getElementById('pictUploader')
    const file = (fileInput && fileInput.files) ? fileInput.files[0] : null
    if (!fileInput || !file) {
      showError('Please Choose a file first.')
    } else {
      await uploadPictNow(file)
    }
  }
  const uploadArea = document.getElementById('upload_area')
  if (uploadArea) {
    uploadArea.ondragenter = handleDragEnter
    uploadArea.ondragover = handleDragOver
    uploadArea.ondragleave = handleDragLeave
    uploadArea.ondrop = handleDrop
  }
}

const gotChangePrefsStatus = function (error, data) {
  console.log('🔑 gotChangePrefsStatus', { error, data })
  if (error) {
    showError('Error changing prefs -  ' + error.message)
  } else if (!data) {
    showError('Could not connect to server')
  } else {
    showError('prefs Saved !! ')
  }
}
const gotPasswordChangeStatus = function (error, data) {
  if (error) {
    showError('Error changing password -  ' + error.message)
  } else if (!data) {
    showError('Could not connect to server')
  } else {
    showError('Password Changed !! ')
    document.getElementById('changePasswordOuter').style.display = 'none'
  }
}

const gotRemoveStatus = function (error, data) {
  window.scrollTo({ top: 0, behavior: 'smooth' })
  if (error) {
    showError('there was an error removing you -  ' + error.message)
  } else if (data?.error) {
    showError('there was an error removing you -  ' + data.message)
  } else if (!data) {
    showError('Could not connect to server')
  } else {
    alert('You have been removed from this server')
    window.location = '/account/logout'
  }
}

const showError = function (errorText, timer) {
  const errorBox = document.getElementById('errorBox')
  if (!errorBox) errorText = ''
  errorBox.innerText = errorText
  errorBox.style.display = errorText ? 'block' : 'none'
  if (!timer) timer = 5000
  if (timer) {
    setTimeout(function () {
      showError()
    }, timer)
  }
}

// Hanlding dropped files
//  credit to https://www.smashingmagazine.com/2018/01/drag-drop-file-uploader-vanilla-js/ and https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API/File_drag_and_drop
const handleDragEnter = function (e) {
  preventDefaults(e)
  highlight(e)
}
const handleDragOver = function (e) {
  preventDefaults(e)
  highlight(e)
}
const handleDragLeave = function (e) {
  preventDefaults(e)
  unhighlight(e)
}
const handleDrop = function (e) {
  preventDefaults(e)
  unhighlight(e)
  const items = e.dataTransfer.items
  // let files = dt.files
  // const dropId = targetDropArea(e).id

  const file = (items && items.length > 0) ? items[0].getAsFile() : null
  if (items && items.length > 1) {
    document.getElementById('errorBox').innerHTML = 'Please upload one zip file only.'
  } else if (!items || !file) {
    showError('Please Choose a file first.')
  } else {
    uploadPictNow(file)
  }
}
const preventDefaults = function (e) {
  e.preventDefault()
  e.stopPropagation()
}
const highlight = function (e) {
  targetDropArea(e).classList.add('highlight')
}
const unhighlight = function (e) {
  targetDropArea(e).classList.remove('highlight')
}
const targetDropArea = function (e) {
  let target = e.target
  if (!target.className.includes('drop-area')) {
    target = target.parentElement
  }
  if (!target.className.includes('drop-area')) console.warn('akkkhhh - todo - should iterate')
  return target
}
const choosePict = function (evt) {
  document.getElementById('pictUploader').click()
}

// Show filename when file is selected
const pictUploader = document.getElementById('pictUploader')
if (pictUploader) {
  pictUploader.addEventListener('change', function () {
    const nameSpan = document.getElementById('chosen_pict_name')
    const uploadBtn = document.getElementById('uploadNowOuter')
    if (pictUploader.files && pictUploader.files.length > 0) {
      if (nameSpan) nameSpan.textContent = pictUploader.files[0].name
      if (uploadBtn) uploadBtn.style.display = 'block'
    } else {
      if (nameSpan) nameSpan.textContent = ''
      if (uploadBtn) uploadBtn.style.display = 'none'
    }
  })
}
const uploadPictNow = async function (file) {
  const parts = file.name.split('.')
  const uploadData = new FormData()
  uploadData.append('file', file)
  uploadData.append('file_name', 'profilePict.jpg')
  uploadData.append('options', JSON.stringify({ overwrite: true, fileName: 'profilePict.jpg', convertPict: { width: 500, type: 'jpg' } }))
  const url = '/feps/upload/info.freezr.account'

  try {
    const uploadReturn = await freezr.apiRequest('PUT', url, uploadData, { uploadFile: true })
    console.log('🔑 uploadReturn', { uploadReturn })
    if (uploadReturn?.err) throw new Error('Error uploading picture: ' + uploadReturn.err)
    const shareReturn = await freezr.perms.shareFilePublicly(uploadReturn._id, { name: 'profilePict' })
    
    if (shareReturn?.err) throw new Error('Error sharing file publicly: ' + shareReturn.err)
      
    const deleteBtn = document.getElementById('profilePictDelete')
    const pictOuter = document.getElementById('profilePictOuter')
    const pathMsg = document.getElementById('profilePictPathMsg')
    const grid = document.getElementById('outerGrid')
    const pictInner = document.getElementById('profilePictInner')
    
    if (deleteBtn) deleteBtn.style.display = 'block'
    if (pictOuter) pictOuter.style.display = 'block'
    if (pathMsg) pathMsg.style.display = 'block'
    if (grid) {
      grid.style['grid-template-columns'] = '1fr 1fr'
      grid.style.gap = '1.5rem'
    }

    if (pictInner) pictInner.src = '/@' + freezrMeta.userId + '/info.freezr.account.files/profilePict.jpg?timestamp=' + new Date().getTime()
    showError('new profile picture uploaded')

  } catch (error) {
    console.warn({ error })
    showError(error && error.message ? error.message : 'Error uploading picture')
  }
}
const deletePict = async function () {
  try {
    const unshareReturn = await freezr.perms.shareFilePublicly('@' + freezrMeta.userId + '/info.freezr.account.files/profilePict.jpg', { name: 'profilePict', action: 'deny' })
    console.log('🔑 unshareReturn', { unshareReturn })
  } catch (error) {
    console.warn('error unsharing picture - deleting in any case', { error })
  }
  try {
    const delInfo = await freezr.delete('info.freezr.account.files', 'profilePict.jpg')
    console.log('🔑 deletePict', { delInfo })
    document.getElementById('profilePictInner').src = '/@' + freezrMeta.userId + '/info.freezr.account.files/profilePict.jpg?timestamp=' + new Date().getTime()
    showError('Profile picture removed')
  } catch (error) {
    console.warn('error deleting picture', { error })
  }
}

// https://stackoverflow.com/questions/9038625/detect-if-device-is-ios
const isIos = function () {
  return [
    'iPad Simulator',
    'iPhone Simulator',
    'iPod Simulator',
    'iPad',
    'iPhone',
    'iPod'
  ].includes(navigator.platform) ||
  // iPad on iOS 13 detection
  (navigator.userAgent.includes('Mac') && 'ontouchend' in document)
}
