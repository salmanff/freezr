
// admin/prefs.js

/* global freezr, freezerRestricted */

let isFirstSetup = false
freezr.initPageScripts = function () {
  const searchParams = new URLSearchParams(window.location.search)
  isFirstSetup = searchParams.has('firstSetUp')
  if (isFirstSetup) {
    showClass('setup')
    hideClass('changeNormal')
    document.getElementById('submitButt').value = 'Set Preferences'
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
    //onsole.log(allApps.user_apps)
    oldChoice = document.getElementById('oldChoice').innerHTML;
    if (allApps.user_apps && allApps.user_apps.length>0) {
      allApps.user_apps.forEach(anAppObj => {
        let anOption = document.createElement("option");
        anOption.value = anAppObj.app_name;
        anOption.innerHTML = anAppObj.app_display_name || anAppObj.app_name
        document.getElementById("defaultPublicAppId").appendChild(anOption);
        if (oldChoice == anAppObj.app_name) document.getElementById("defaultPublicAppId").value=oldChoice
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
        allowAccessToSysFsDb: document.getElementById('allowAccessToSysFsDbId').checked,
        log_visits: document.getElementById('logVisitsId').checked,
        redirect_public: document.getElementById('redirectPublicId').checked,
        public_landing_page: document.getElementById('defaultPublicAppId').value,
        password: password
      }

      freezerRestricted.connect.write('/v1/admin/change_main_prefs', theInfo, gotChangeStatus, 'jsonString')
    }
  }
}

var gotChangeStatus = function(error, data) {
  if (data) data = freezr.utils.parse(data);
  if (error) {
    showError("Error. "+error.message);
  } else if (!data) {
    showError("Could not connect to server");
  } else {
    window.location = 'account/home?show=welcome'
  }
}

var showError = function(errorText) {
  var errorBox=document.getElementById("errorBox");
  errorBox.innerHTML= errorText;
  window.scrollTo(0,0);
}

const hideClass = function (theClass) {
  const els = document.getElementsByClassName(theClass)
  for (var i = 0; i < els.length; i++) {
    els[i].style.display = 'none'
  }
}
const showClass = function (theClass) {
  const els = document.getElementsByClassName(theClass)
  for (var i = 0; i < els.length; i++) {
    els[i].style.display = 'block'
  }
}
