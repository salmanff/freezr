// Account Settings page
/* global freezr, freepr, freezerRestricted,  freezrMeta, alert, confirm, FormData */

freezr.initPageScripts = function () {
  document.getElementById('user_id').innerHTML = freezrMeta.userId

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
      freezerRestricted.connect.write('/v1/account/changePassword.json', theInfo, gotPasswordChangeStatus, 'jsonString')
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
      if (['local', 'glitch', 'system'].indexOf(currentfs) > -1 || ['local', 'system'].indexOf(currentdb) > -1) {
        showError('this only works if you are using your own file system, not the main system fs')
      } else if (confirm('Are you sure you want to completely remove yourself?')) {
        freezerRestricted.connect.write('/v1/account/removeFromFreezr.json', theInfo, gotRemoveStatus, 'jsonString')
      }
    }
  }

  freezr.utils.getPrefs(function (err, prefs) {
    // onsole.log({ err, prefs })
    document.getElementById('userBlockMsgsToNonContacts').checked = prefs.blockMsgsToNonContacts
    document.getElementById('userBlockMsgsFromNonContacts').checked = prefs.blockMsgsFromNonContacts
  })
  document.getElementById('savePrefsButt').onclick = function (evt) {
    evt.preventDefault()
    // onsole.log(evt)

    const theInfo = {
      blockMsgsToNonContacts: document.getElementById('userBlockMsgsToNonContacts').checked,
      blockMsgsFromNonContacts: document.getElementById('userBlockMsgsFromNonContacts').checked
    }

    console.log({ theInfo })

    freezerRestricted.connect.write('/v1/account/data/setPrefs.json', theInfo, gotChangePrefsStatus, 'jsonString')
  }

  document.getElementById('choosePict').onclick = choosePict
  document.getElementById('profilePictDelete').onclick = deletePict
  document.getElementById('profilePictInner').onerror = function () {
    console.log('error on pict')
    document.getElementById('profilePictDelete').style.display = 'none'
    document.getElementById('profilePictOuter').style.display = 'none'
    document.getElementById('profilePictPathMsg').style.display = 'none'
    document.getElementById('outerGrid').style['grid-template-columns'] = '1fr'
  }
  document.getElementById('profilePictInner').src = '/publicfiles/' + freezrMeta.userId + '/info.freezr.account/profilePict.jpg?timestamp=' + new Date().getTime()
  if (isIos()) {
    document.getElementById('upload_area').style.display = 'none'
    document.getElementById('choosePict').innerHTML = 'Choose a Picture'
  }

  document.getElementById('uploadPictNow').onclick = function (evt) {
    const fileInput = document.getElementById('pictUploader')
    const file = (fileInput && fileInput.files) ? fileInput.files[0] : null
    if (!fileInput || !file) {
      showError('Please Choose a file first.')
    } else {
      uploadPictNow(file)
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
  console.log(' gotChangePrefsStatus ', { error, data })
  data = freezr.utils.parse(data)
  if (error) {
    showError('Error changing prefs -  ' + error.message)
  } else if (!data) {
    showError('Could not connect to server')
  } else {
    showError('prefs Saved !! ')
  }
}
const gotPasswordChangeStatus = function (error, data) {
  data = freezr.utils.parse(data)
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
  console.log('gotRemoveStatus', { error, data })
  console.log('gotRemoveStatus', JSON.stringify(data))
  data = freezr.utils.parse(data)
  window.scrollTo({ top: 0, behavior: 'smooth' })
  if (error) {
    showError('there was an error removing you -  ' + error.message)
  } else if (data.error) {
    showError('there was an error removing you -  ' + data.message)
  } else if (!data) {
    showError('Could not connect to server')
  } else {
    alert('You have been removed from this server')
    window.location = '/account/logout'
  }
}

const showError = function (errorText) {
  const errorBox = document.getElementById('errorBox')
  errorBox.innerText = errorText
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
  if (!target.className.includes('drop-area')) console.log('akkkhhh - should iterate')
  return target
}
const choosePict = function (evt) {
  document.getElementById('pictUploader').click()
  document.getElementById('pictUploader').style.display = 'block'
  document.getElementById('uploadNowOuter').style.display = 'block'
}
const uploadPictNow = function (file) {
  const parts = file.name.split('.')
  console.log('file name ', file.name, { parts })

  const uploadData = new FormData()
  uploadData.append('file', file)
  uploadData.append('file_name', 'profilePict.jpg')
  uploadData.append('options', JSON.stringify({ overwrite: true, fileName: 'profilePict.jpg' }))
  const url = '/feps/upload/info.freezr.account'

  freezerRestricted.connect.send(url, uploadData, function (error, returndata) {
    console.log({ error, returndata })
    if (error || returndata.err) {
      console.warn({ error, returndata })
      showError(error && error.message ? error.message : returndata.err)
    } else {
      document.getElementById('profilePictDelete').style.display = 'block'
      document.getElementById('profilePictOuter').style.display = 'block'
      document.getElementById('profilePictPathMsg').style.display = 'block'
      document.getElementById('outerGrid').style['grid-template-columns'] = '2fr 2fr 1fr'
      document.getElementById('profilePictInner').src = '/publicfiles/' + freezrMeta.userId + '/info.freezr.account/profilePict.jpg?timestamp=' + new Date().getTime()
      showError('new profile picture uploaded')
    }
  }, 'PUT', null)
}
const deletePict = async function () {
  const delInfo = await freepr.feps.delete('profilePict.jpg', { app_table: 'info.freezr.account.files' })
  console.log({ delInfo })
  document.getElementById('profilePictInner').src = '/publicfiles/' + freezrMeta.userId + '/info.freezr.account/profilePict.jpg?timestamp=' + new Date().getTime()
  showError('Profile picture removed')
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
