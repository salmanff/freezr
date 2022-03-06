// freezr  firstSetUp

/* global freezr, freezerRestricted  */


// NOTE THIS IS NOW JUST COPED FROM reauthorise.js -> WIP - needs to be completed

let receivedParams = {}
const AUTH_FS_TYPES = ['dropbox', 'googleDrive']

const checkFsInputs = function () {
  const type = document.getElementById('fsParamsType').value
  if (AUTH_FS_TYPES.indexOf(type) < 0) {
    showError('Invalid file system indicated ' + type)
    return false
  }
  return true
}

freezr.initPageScripts = function () {
  hideDivs(['passEnterDiv'])
  checkFsInputs()

  document.addEventListener('click', function (evt) {
    const args = evt.target.id.split('_')
    if (args && args.length > 1 && args[0] === 'click') {
      switch (args[1]) {
        case 'recordAuthParams':
          recordAuthParams()
          break
        default:
          console.warn('undefined click ?')
          break
      }
    }
  })

  hideDiv('errorBox')

  setTimeout(function () { document.body.scrollTop = 0 }, 20)

  const gotAuthValidation = populateFormsFromParams()
  // see if has done oauth and if so, give error if no state
  if (gotAuthValidation) {
    window.localStorage.removeItem('params')
    hideDiv('click_goAuthFS')
    showError('You were re-authenticated successfully - now checking....')
    checkResource({})
  }
}

const populateFormsFromParams = function () {
  let storedParams
  try {
    storedParams = JSON.parse(window.localStorage.getItem('params'))
  } catch (e) {
    storedParams = null
  }

  const urlQueries = new URLSearchParams(window.location.search)
  const regcode = urlQueries.get('regcode')
  const type = urlQueries.get('type')

  if (regcode && storedParams && regcode === storedParams.regcode && storedParams.type === type) {
    ['code', 'accessToken', 'clientId', 'codeChallenge', 'codeVerifier', 'redirecturi', 'refreshToken', 'expiry', 'secret'].forEach(key => {
      const value = urlQueries.get(key)
      if (value && value !== 'null') {
        storedParams[key] = value
      }
    })
    receivedParams = storedParams
    // console.log(receivedParams)
    window.localStorage.removeItem('params')
    return true
  } else if (regcode) {
    window.localStorage.removeItem('params')
    showError('Inrternal Error - url parameters are NOT matching - please retry ')
    window.localStorage.removeItem('params')
    return false
  } else {
    window.localStorage.removeItem('params')
    return false
  }
}

const checkResource = function (options, callback) {
  const resource = 'FS'
  if (!callback) callback = gotCheckStatus
  const typesCorrect = checkFsInputs()
  if (typesCorrect) {
    var toSend = { resource, env: { fsParams: receivedParams }, action: 'checkresource' }
    freezerRestricted.connect.send('/v1/admin/self_register', JSON.stringify(toSend), callback, 'POST', 'application/json')
  }
}

function gotCheckStatus (err, data) {
  if (err) {
    showError(err.message)
  } else if (data.err) {
    showError(data.err)
  } else if (!data.checkpassed) {
    showError('Unsuccessful attempt to check file system. Try again later')
  } else {
    showError('Your file system works! Enter your password to reset parameters on the server.')
    showDiv('passEnterDiv')
    hideDiv('click_goAuthFS')
  }
}

const getAllFormsData = function () {
  const type = document.getElementById('fsParamsType').value
  const authServer = document.getElementById('fs_auth_Server').value
  const userId = document.getElementById('userId').innerText

  return { type, authServer, userId }
}

const recordAuthParams = function () {
  showError('recording Auth Params to re-launch freezr. . . . ')

  const userId = document.getElementById('userId').innerText
  const password = document.getElementById('password').value

  if (!password) {
    showError('Please enter your password')
  } else if (!receivedParams.accessToken) {
    showError('Something went wrong. Access token missing')
  } else {
    hideDivs(['passEnterDiv', 'click_goAuthFS'])
    var theInfo = { action: 'updateReAuthorisedFsParams', userId, password, env: { fsParams: receivedParams } }
    freezerRestricted.connect.send('/v1/admin/self_register', JSON.stringify(theInfo), gotRegisterStatus, 'POST', 'application/json')
  }
}

const gotRegisterStatus = function (error, data) {
  if (error) {
    showDivs(['passEnterDiv', 'click_goAuthFS'])
    showError('Error: ' + error.message)
  } else if (!data) {
    showDivs(['passEnterDiv', 'click_goAuthFS'])
    showError('No data was sent ferom server - refresh to see status')
  } else {
    window.location = '/account/home?show=welcome&source=reAuthed'
  }
}

// O-AUTH
const goAuthFS = function () {
  let oauthorUrl = document.getElementById('fs_auth_Server').value
  if (!oauthorUrl) {
    showError('need to enter an authenticator url')
  } else {
    const currentParams = getAllFormsData()

    currentParams.regcode = randomText(20)

    window.localStorage.setItem('params', JSON.stringify(currentParams))

    oauthorUrl = oauthorUrl + '?type=' + currentParams.type + '&regcode=' + currentParams.regcode + '&sender=' + encodeURIComponent(window.location.origin + window.location.pathname)
    // onsole.log('opening authenticator site as first step in oauth process: ' + oauthorUrl)
    hideDiv('click_goAuthFS')
    showError('Going to authenticate...')
    window.open(oauthorUrl, '_self')
  }
}

// Generics
var showError = function (errorText) {
  var errorBox = document.getElementById('errorBox')
  errorBox.innerHTML = errorText
  if (errorText) { showDiv('errorBox') } else { hideDiv('errorBox') }
  // errorBox.scrollIntoView()
}
const showDiv = function (divId) {
  const theEl = document.getElementById(divId)
  if (theEl) theEl.style.display = 'block'
}
const hideDiv = function (divId) {
  const theEl = document.getElementById(divId)
  if (theEl) theEl.style.display = 'none'
}
const hideDivs = function (theDivs) {
  if (theDivs && theDivs.length > 0) {
    for (var i = 0; i < theDivs.length; i++) {
      hideDiv(theDivs[i])
    }
  }
}
const showDivs = function (theDivs) {
  if (theDivs && theDivs.length > 0) {
    for (var i = 0; i < theDivs.length; i++) {
      showDiv(theDivs[i])
    }
  }
}
const randomText = function (textlen) {
  // http://stackoverflow.com/questions/1349404/generate-a-string-of-5-random-characters-in-javascript
  let text = ''
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  if (!textlen) textlen = 20
  for (let i = 0; i < textlen; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length))
  }
  return text
}
