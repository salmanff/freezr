
freezr.initPageScripts = function() {
  document.getElementById("defaultPublicAppId").onchange = function() {
    document.getElementById("redirectPublicId").checked = true;
  }
  freezr.utils.getAllAppList(function(allApps) {
    if (allApps) allApps = freezr.utils.parse(allApps);
    //onsole.log(allApps.user_apps)
    oldChoice = document.getElementById("oldChoice").innerHTML;
    if (allApps.user_apps && allApps.user_apps.length>0) {
      allApps.user_apps.forEach(anAppObj => {
        let anOption = document.createElement("option");
        anOption.value = anAppObj.app_name;
        anOption.innerHTML = anAppObj.display_name || anAppObj.app_name
        document.getElementById("defaultPublicAppId").appendChild(anOption);
        if (oldChoice == anAppObj.app_name) document.getElementById("defaultPublicAppId").value=oldChoice
      })
    }
  }) 


  document.getElementById('changePrefs').onsubmit = function (evt) {
    evt.preventDefault();
      var password = document.getElementById('password').value;
      if (!password) {
        showError("You need re-enter  your password to change preferences");
      } else {
        var theInfo = { password: password,
                        log_visits: document.getElementById("logVisitsId").checked,
                        redirect_public:document.getElementById("redirectPublicId").checked,
                        public_landing_page: document.getElementById("defaultPublicAppId").value
                      };
                      //onsole.log(theInfo)
        freezer_restricted.connect.write("/v1/admin/change_main_prefs", theInfo, gotChangeStatus, "jsonString");
      }

  }
}

var gotChangeStatus = function(data) {
  if (data) data = freezr.utils.parse(data);
  if (!data) {
    showError("Could not connect to server");
  } else if (data.error) {
    showError("Error. "+data.message);
  } else {
    showError("Preferences changed")
    // data.newPrefs -> populate again
  }
}

var showError = function(errorText) {
  var errorBox=document.getElementById("errorBox");
  errorBox.innerHTML= errorText;
  window.scrollTo(0,0);
}


