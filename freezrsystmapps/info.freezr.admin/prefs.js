
// admin/prefs.js

/* global freezr, freezrServerStatus */

let isFirstSetup = false
freezr.initPageScripts = function () {
  const searchParams = new URLSearchParams(window.location.search)
  isFirstSetup = searchParams.has('firstSetUp')
  if (isFirstSetup) {
    showClass('setup')
    hideClass('changeNormal')
    document.getElementById('submitButt').value = 'Save and Launch Freezr'
  } else {
    showClass('changeNormal')
    hideClass('setup')
  }
  document.getElementById('defaultPublicAppId').onchange = function () {
    document.getElementById('redirectPublicId').checked = true
  }
  freezr.utils.getAllAppList(function (error, allApps) {
    if (error) console.log(error) // need to handle
    if (allApps) allApps = freezr.utils.parse(allApps)
    // onsole.log(allApps.user_apps)
    const oldChoice = document.getElementById('oldChoice').innerHTML
    if (allApps.user_apps && allApps.user_apps.length > 0) {
      allApps.user_apps.forEach(anAppObj => {
        const anOption = document.createElement('option')
        anOption.value = anAppObj.app_name
        anOption.innerHTML = anAppObj.app_display_name || anAppObj.app_name
        document.getElementById('defaultPublicAppId').appendChild(anOption)
        if (oldChoice === anAppObj.app_name) document.getElementById('defaultPublicAppId').value = oldChoice
      })
    }
  })

  document.getElementById('changePrefs').onsubmit = function (evt) {
    evt.preventDefault()
    const password = document.getElementById('password').value
    if (!password && !isFirstSetup) {
      showError('You need re-enter  your password to change preferences')
    } else {
      const theInfo = {
        allowSelfReg: document.getElementById('allowSelfRegId').checked,
        useUserIdsAsDbName: document.getElementById('useUserIdsAsDbNameId').checked,
        useUnifiedCollection: document.getElementById('useUnifiedCollectionId').checked,
        selfRegDefaultMBStorageLimit: (document.getElementById('selfRegDefaultMBStorageLimit').value ? parseInt(document.getElementById('selfRegDefaultMBStorageLimit').value) : null),
        allowAccessToSysFsDb: document.getElementById('allowAccessToSysFsDbId').checked,
        log_visits: document.getElementById('logVisitsId').checked,
        scheduler_disabled: document.getElementById('schedulerDisabledId').checked,
        serverless_callback_url: (document.getElementById('serverlessCallbackUrlId') ? document.getElementById('serverlessCallbackUrlId').value.trim() : ''),
        redirect_public: document.getElementById('redirectPublicId').checked,
        public_landing_app: document.getElementById('defaultPublicAppId').value,
        public_landing_page: document.getElementById('defaultLandingUrl').value,
        hasNotbeenSave: false,
        password
      }
      if (isNaN(theInfo.selfRegDefaultMBStorageLimit)) {
        showError('storage limit needs to be a number or left blank')
      } else {
        (async () => {
          try {
            const data = await freezr.apiRequest('POST', '/adminapi/change_main_prefs', theInfo)
            console.log('🔄 gotChangeStatus - data:', {theInfo, data})
            gotChangeStatus(null, data)
          } catch (error) {
            console.log('🔄 gotChangeStatus - data:', {theInfo, error})
            gotChangeStatus(error, null)
          }
        })()
      }
    }
  }

  // Serverless callback URL: auto-capture the address the admin is using now (window.location.origin).
  // First setup / never set → pre-fill it (editable). Already set but DIFFERENT from what we detect →
  // flag it and offer a one-click "use detected URL", in case the saved value is stale/wrong.
  const slUrlField = document.getElementById('serverlessCallbackUrlId')
  if (slUrlField) {
    const detected = window.location.origin
    const saved = (slUrlField.value || '').trim()
    const note = document.getElementById('serverlessCallbackUrlNote')
    if (!saved) {
      slUrlField.value = detected
      if (note) {
        note.style.display = 'block'
        note.style.color = '#64748b'
        note.textContent = 'Auto-detected from this page: ' + detected + '. Edit if your public URL differs.'
      }
    } else if (saved !== detected && note) {
      note.style.display = 'block'
      note.style.color = '#b7791f'
      note.textContent = '⚠️ Saved URL differs from the address you are using now (' + detected + '). '
      const useBtn = document.createElement('span')
      useBtn.className = 'smallTextButt'
      useBtn.style.cursor = 'pointer'
      useBtn.textContent = 'Use detected URL'
      useBtn.onclick = function () { slUrlField.value = detected; note.style.display = 'none' }
      note.appendChild(useBtn)
    }
  }

  if (document.getElementById('allowSelfRegId').checked) document.getElementById('selfRegOptionsArea').style.display = 'block'

  document.getElementById('allowSelfRegId').onchange = function (e) {
    document.getElementById('selfRegOptionsArea').style.display = 'block'
  }

  if (freezrServerStatus?.dbType !== 'mongodb') {
    document.getElementById('mongoArea').style.display = 'none'
  } else {
    if (document.getElementById('useUnifiedCollectionId').checked) {
      document.getElementById('mongotextArea').innerText = 'You have chosen to keep all user data in one collections... this is helpful if you expect many many users on your server.'
    } else if (document.getElementById('useUserIdsAsDbNameId').checked) {
      document.getElementById('mongotextArea').innerText = "You have chosen to keep each user's data in its own database. This is useful if you want to keep each user completely seprate but can be cumbersome of you have  many users or many servers using the same workspace."
    } else {
      document.getElementById('mongotextArea').innerText = 'Mongo default position is to keep all useer data in one database, and each table in its own collection. You can aggregate ir disaggregate this setting only on set up by setting environment variables.'
    }
  }
}

const gotChangeStatus = function (error, data) {
  if (data) data = freezr.utils.parse(data)
  if (error) {
    console.warn('found err ', { error, data })
    showError('Error. ' + error.message)
  } else if (!data) {
    showError('ould not connect to server')
  } else {
    showError('Preferences Saved')
    if (isFirstSetup) {
      window.location = '/account/home?show=welcome'
    }
  }
}

const showError = function (errorText) {
  const errorBox = document.getElementById('errorBox')
  errorBox.innerHTML = errorText
  window.scrollTo(0, 0)
}

const hideClass = function (theClass) {
  const els = document.getElementsByClassName(theClass)
  for (let i = 0; i < els.length; i++) {
    els[i].style.display = 'none'
  }
}
const showClass = function (theClass) {
  const els = document.getElementsByClassName(theClass)
  for (let i = 0; i < els.length; i++) {
    els[i].style.display = 'block'
  }
}
