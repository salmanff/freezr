
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
