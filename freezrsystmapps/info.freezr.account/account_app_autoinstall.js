// account_app_autoinstall.js

/* global freezr, freezerRestricted */

freezr.initPageScripts = function () {
  const searchParams = new URLSearchParams(window.location.search)
  const autoInstallUrl = normliseGithubUrl(searchParams.get('autoInstallUrl'))
  const action = normliseGithubUrl(searchParams.get('action'))
  const autoInstallApp = searchParams.get('autoInstallApp')
  console.log({ autoInstallApp, autoInstallUrl })
  if (!autoInstallUrl || !autoInstallApp) window.location = '/account/app/manage'
  document.getElementById('message').innerHTML = searchParams.get('message')
  document.getElementById('app_name').innerHTML = autoInstallApp
  document.getElementById('app_url').innerHTML = autoInstallUrl
  document.getElementById('app_name2').innerHTML = autoInstallApp
  document.getElementById('install').onclick = function () {
    document.getElementById('install').style.display = 'none'
    document.getElementById('spinner').style.display = 'block'
    freezerRestricted.connect.ask('/acctapi/app_install_from_url.json', {
      app_url: autoInstallUrl,
      app_name: autoInstallApp
    }, function (error, returndata) {
      const d = freezr.utils.parse(returndata)
      if (error || d.err) {
        showError(error.message || d.err || 'Error installing!')
        document.getElementById('spinner').style.display = 'none'
      } else {
        window.location = '/account/app/settings/' + autoInstallApp + '?' + (action ? ('action=' + action + '&') : '') + 'code=newinstall&message=You successfully installed the app.'
      }
    })
  }
}

const normliseGithubUrl = function (aUrl) {
  if (startsWith(aUrl, 'https://github.com/') && (aUrl.match(/\//g) || []).length === 4 && !endsWith(aUrl, '.zip')) {
    aUrl = aUrl + '/archive/main.zip'
  }
  return aUrl
}
const startsWith = function (longertext, checktext) {
  if (!longertext || !checktext || !(typeof longertext === 'string') || !(typeof checktext === 'string')) return false
  if (checktext.length > longertext.length) return false
  return (checktext === longertext.slice(0, checktext.length))
}
const endsWith = function (longertext, checktext) {
  if (!checktext || !longertext || checktext.length > longertext.length) return false
  return (checktext === longertext.slice((longertext.length - checktext.length)))
}
let timer = null
const showError = function (errorText) {
  clearTimeout(timer)
  timer = null
  const errorBox = document.getElementById('errorBox')
  errorBox.innerHTML = errorText || ' &nbsp '
  if (errorText) {
    timer = setTimeout(function () {
      showError()
    }, 5000)
  }
}
