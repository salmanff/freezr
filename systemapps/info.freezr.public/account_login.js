// used for /account/login and account/applogin/login/appname
// Can also be sed for device apps... Device app should listen to change in url and close if reach /account/applogin/results, and get the app_code
// 

freezr.initPageScripts = function() {
	document.getElementById('login').onsubmit = function (evt) {
	  evt.preventDefault();
	  var user_id=document.getElementById('user_id').value;
	  var password = document.getElementById('password').value;

	  if (!user_id || !password) {
	  	showError("You need a name and password to log in");
	  } else {
		  var theInfo = { "user_id": user_id, "password": password, 'login_for_app_name':login_for_app_name};
		  freezer_restricted.connect.ask("/v1/account/login", theInfo, gotLoginStatus);
	  }
	}
	try {
		 if (warnings && warnings=="setupfile-resave") showError("There has been a potentially serious error as a key file is missing from your system. If you are a developer, and you have deleted, that's okay. Other wise, this may be a more serious problem.")
		} catch(e) {}
	document.getElementById("freezr_server").innerHTML = window.location.href.slice(0,window.location.href.indexOf("/account"))
	if (login_for_app_name && document.getElementById("freezr_app_name") ) document.getElementById("freezr_app_name").innerHTML = login_for_app_name;

}

var gotLoginStatus = function(data) {
 	//onsole.log("got login data"+ JSON.stringify(data) );
 	if (!data) {
  		showError("Could not connect to server");
	} else if (data.error) {
		showError("Error Logging in :"+data.message);
	} else if (loginAction && loginAction=="autoclose"){
		console.log("AUTO CLOSE")
		window.location = "/account/autoclose";	
	} else if (login_for_app_name) {
		var results = JSON.parse(data);
		window.location = "/account/applogin/results?login_for_app_name="+login_for_app_name+"&source_app_code="+results.source_app_code;
	} else {
		window.location = "/account/home";
	}
}

var showError = function(errorText) {
  var errorBox=document.getElementById("errorBox");
  errorBox.innerHTML= errorText;
}