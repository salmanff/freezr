// Account Settings page
/* global freezr, freezerRestricted,  freezrMeta, alert, confirm */

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
        oldPassword: oldPassword,
        newPassword: newPassword
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
        oldPassword: oldPassword
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
}

var gotPasswordChangeStatus = function (error, data) {
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

var gotRemoveStatus = function (error, data) {
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
  var errorBox = document.getElementById('errorBox')
  errorBox.innerText = errorText
}
