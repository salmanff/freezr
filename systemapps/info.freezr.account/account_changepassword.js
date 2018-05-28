// copied from register page - need to customize to change password

freezr.initPageScripts = function() {
  document.getElementById('user_id').innerHTML = freezr_user_id;

  document.getElementById('changePassword').onsubmit = function (evt) {
    evt.preventDefault();

    var oldPassword=document.getElementById('oldPassword').value;
    var newPassword = document.getElementById('newPassword').value;
    var password2 = document.getElementById('password2').value;

    if (!oldPassword) {
      showError("Please enter your current password");
    } else if (!newPassword) {
      showError("Please enter a new password");
    } else if (!password2 || newPassword != password2) {
      showError("Passwords have to match");
    } else {
      var theInfo = { user_id: freezr_user_id,
                      oldPassword: oldPassword,
                      newPassword: newPassword 
                    };
      freezer_restricted.connect.write("/v1/account/changePassword.json", theInfo, gotChangeStatus, "jsonString");
    }
  }
}

var gotChangeStatus = function(data) {
  if (!data) {
      showError("Could not connect to server");
  } else if (data.error) {
    showError("Error Logging in :"+data.message);
  } else {
    window.location = "/account/home";
  }
}

var showError = function(errorText) {
  var errorBox=document.getElementById("errorBox");
  errorBox.innerHTML= errorText;
}

