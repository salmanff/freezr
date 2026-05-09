// account_login.js used for /account/login
//
/* global freezr, confirm, warnings, freezrAllowSelfReg */

let fwdToUrl = null

freezr.initPageScripts = function () {
  document.getElementById('loginButt').onclick = logIn
  console.log('hello from account_login.js')

  // Check if page is being viewed in an in-app browser (WebView)
  // eg Facebook, Instagram, Twitter, TikTok, Snapchat, LinkedIn, etc.
  if (isInAppBrowser()) {
    const warningEl = document.getElementById('inAppSecurityWarning')
    if (warningEl) warningEl.style.display = 'block'
    console.warn('Login page opened in an in-app browser - security warning shown')
  }

  try {
    if (warnings && warnings === 'setupfile-resave') showError("There has been a potentially serious error as a key file is missing from your system. If you are a developer, and you have deleted, that's okay. Other wise, this may be a more serious problem.")
  } catch (e) {
    console.warn('internal check on warnings')
  }
  document.getElementById('freezr_server').innerHTML = window.location.protocol + '//' + window.location.host

  document.getElementById('password').addEventListener('keypress', function (e) { if (e.key === 'Enter') logIn(e) })

  const searchParams = new URLSearchParams(window.location.search)
  const rawFwdTo = searchParams.get('fwdTo')
  fwdToUrl = isSafeRelativeUrl(rawFwdTo) ? rawFwdTo : null

  const proposedUser = searchParams.get('userId') || searchParams.get('user')
  if (proposedUser) document.getElementById('user_id').value = proposedUser

  if (freezrAllowSelfReg) document.getElementById('self_register_link').style.display = 'block'
}

const logIn = function (evt) {
  console.log('hello from account_login.js logIn clicked')
  evt.preventDefault()
  const userId = document.getElementById('user_id').value
  const password = document.getElementById('password').value

  if (!userId || !password) {
    showError('You need a name and password to log in')
  } else {
    if (window.location.protocol === 'https:' || window.location.host.split(':')[0] === 'localhost' || confirm('Are you sure you want to send your passord through with an https - You will expose your password')) {
      const theInfo = { user_id: userId, password }
      document.getElementById('launch_spinner').style.display = 'block'
      document.getElementById('loginButt').style.display = 'none'
      document.getElementById('self_register_link').style.display = 'none'
      didNotReturnFromLogin = true
      setTimeout(function () { if (didNotReturnFromLogin) document.getElementById('launchspintext').style.display = 'block' }, 1000)
      
      freezr.apiRequest('POST', '/acctapi/login', theInfo)
        .then(data => gotLoginStatus(null, data))
        .catch(error => gotLoginStatus(error, null))
    }
  }
}
let didNotReturnFromLogin = false
const gotLoginStatus = function (error, data) {
  // console.log('login status ', { error, data })
  didNotReturnFromLogin = false
  const gotErrShowHides = function () {
    document.getElementById('launch_spinner').style.display = 'none'
    document.getElementById('launchspintext').style.display = 'none'
    document.getElementById('loginButt').style.display = 'block'
  }

  if (error) {
    showError('Error Logging in :' + error.message)
    gotErrShowHides()
  } else if (data.error) {
    showError(data.error)
    gotErrShowHides()
  } else if (!data) {
    showError('Could not connect to server')
    gotErrShowHides()
  } else if (fwdToUrl) {
    window.location = fwdToUrl
  } else {
    window.location = '/account/home'
  }
}

const showError = function (errorText) {
  if (typeof errorText !== 'string') errorText = JSON.stringify(errorText)
  const errorBox = document.getElementById('errorBox')
  errorBox.innerHTML = errorText
}

// Same-origin relative URL guard: rejects protocol-relative (//evil),
// absolute (http://…), and pseudo-protocol (javascript:) values that an
// attacker could plant in the fwdTo query parameter.
const isSafeRelativeUrl = function (url) {
  if (typeof url !== 'string' || url.length === 0) return false
  if (url[0] !== '/') return false
  if (url.startsWith('//')) return false
  if (url.indexOf('\\') !== -1) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false
  return true
}

const isInAppBrowser = function () {
  const ua = navigator.userAgent || navigator.vendor || ''
  // Android WebView includes 'wv' token
  if (/Android/.test(ua) && /\bwv\b/.test(ua)) return true
  // iOS WebView: has AppleWebKit but no Safari token
  if (/(iPhone|iPod|iPad).*AppleWebKit/i.test(ua) && !/Safari/i.test(ua)) return true
  // Common in-app browsers by app identifier
  if (/FBAN|FBAV|Instagram|Twitter|Snapchat|TikTok|LinkedIn|Line\//i.test(ua)) return true
  return false
}
