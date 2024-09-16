// admin/register
/* global freezerRestricted, freezr */

freezr.initPageScripts = function () {
  document.getElementById('register').onsubmit = function (evt) {
    evt.preventDefault()
    const userId = document.getElementById('user_id').value
    const password = document.getElementById('password').value
    const password2 = document.getElementById('password2').value

    if (!userId || !password) {
      showError('You need a name and password to log in')
    } else if (userId.indexOf('_') > -1 || userId.indexOf(' ') > -1 || userId.indexOf('/') > -1) {
      showError("user id's cannot have '/' or '_' or spaces in them")
    } else if (!password2 || password !== password2) {
      showError('Passwords have to match')
    } else {
      const theInfo = {
        register_type: 'normal',
        isAdmin: (document.getElementById('isAdminId').checked),
        isPublisher: (document.getElementById('isPublisherId').checked),
        useSysFsDb: (document.getElementById('useSysFsDbId').checked),
        email_address: document.getElementById('email_address').value,
        user_id: userId,
        full_name: document.getElementById('full_name').value,
        password
      }
      freezerRestricted.connect.write('/v1/admin/user_register', theInfo, gotRegisterStatus, 'jsonString')
    }
  }
}

const gotRegisterStatus = function (error, data) {
  if (data) data = freezr.utils.parse(data)
  if (error) {
    showError(error)
  } else if (data.error) {
    showError('Error. ' + data.message)
  } else if (!data) {
    showError('Could not connect to server')
  } else {
    window.location = '/admin/list_users'
  }
}

const showError = function (errorText) {
  const errorBox = document.getElementById('errorBox')
  errorBox.innerHTML = errorText
  window.scrollTo(0, 0)
}
