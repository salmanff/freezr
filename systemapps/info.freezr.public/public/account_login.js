// used for /account/login and account/applogin/login/appname
// Can also be sed for device apps... Device app should listen to change in url and close if reach /account/applogin/results, and get the app_code
//
/* global confirm, freezerRestricted */

freezr.initPageScripts = function () {
	document.getElementById('loginButt').onclick = logIn

	try {
		 if (warnings && warnings=="setupfile-resave") showError("There has been a potentially serious error as a key file is missing from your system. If you are a developer, and you have deleted, that's okay. Other wise, this may be a more serious problem.")
		} catch(e) {}
	document.getElementById("freezr_server").innerHTML = window.location.href.slice(0,window.location.href.indexOf("/account"))
	if (login_for_app_name && document.getElementById("freezr_app_name") ) document.getElementById("freezr_app_name").innerHTML = login_for_app_name;
  document.getElementById('password').addEventListener('keypress', function (e) { if (e.keyCode === 13) logIn(e) })

  if (freezrAllowSelfReg) document.getElementById('self_register_link').style.display = 'block'
}

const logIn = function (evt) {
  evt.preventDefault()
  const userId = document.getElementById('user_id').value
  const password = document.getElementById('password').value

  if (!userId || !password) {
    showError('You need a name and password to log in')
  } else {
    if (window.location.protocol === 'https:' || window.location.host.split(':')[0] === 'localhost' || confirm('Are you sure you want to send your passord through with an https - You will expose your password')) {
      const theInfo = { user_id: userId, password, login_for_app_name: null }
      freezerRestricted.connect.ask('/v1/account/login', theInfo, gotLoginStatus)
    }
  }
}

var gotLoginStatus = function(error, data) {
  // console.log('login status ', { error, data })
 	if (error) {
		showError("Error Logging in :" + error.message);
	} else if (data.error) {
    showError(data.message || 'Error : Could not log you in')
	} else if (!data) {
  		showError("Could not connect to server");
	} else if (loginAction && loginAction=="autoclose"){
		window.location = "/account/autoclose";
	} else if (login_for_app_name && login_for_app_name != 'info.freezr.public') {
    var results = data;
		window.location = "/account/applogin/results?login_for_app_name="+login_for_app_name
	} else {
    window.location = '/account/home'
	}
}

var showError = function(errorText) {
  var errorBox=document.getElementById("errorBox");
  errorBox.innerHTML= errorText;
}
