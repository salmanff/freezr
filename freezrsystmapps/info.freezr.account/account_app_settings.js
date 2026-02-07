// 

/* global freezr, freepr, targetApp, freezrMeta, freezerRestricted, confirm, alert, history */
console.log('account_app_settings.js loaded 1')
import { showPermsIn, appHeaderFor, replaceWithFreezrEmptyLogo, createWarningsDiv } from './modules/AppSettings.js'
import { makeBox } from './modules/freezrbox.js'
import { dg } from './modules/dgelements.js'



let hasSetPermissions = false
let refreshIntervalId = null

console.log('account_app_settings.js loaded')

const getManifestAndRefreshWarnings = async function () {
  let manOuter = null
  try {
    manOuter = await freezr.utils.getManifest(targetApp)
    console.log('getManifest 1 ', { targetApp, manOuter })
  } catch (err) {
    console.warn({ err })
    if (err?.message?.toLowerCase() === 'unauthorized') {
      // Get current path and add it as a query param to the redirect
      var currentPath = window.location.pathname // + window.location.search + window.location.hash;
      window.location.href = '/account/login?redirect=' + encodeURIComponent(currentPath);
    }
    dg.el('appHeader', { clear: true }).innerText = 'Error getting manifest'
    // Clear any existing interval if there's an error
    if (refreshIntervalId) {
      clearInterval(refreshIntervalId)
      refreshIntervalId = null
    }
    return
  }

  const header = await appHeaderFor(manOuter.manifest, {
    version: manOuter.manifest?.version,
    appInstalled: manOuter.appInstalled,
    appUpdated: manOuter.appUpdated,
    hasLogo: manOuter.hasLogo
  })
  dg.el('appHeader', { clear: true }, header)

  const StandAloneApps = await drawStandAloneApps(manOuter.manifest)
  dg.el('standAloneApps', { clear: true }, StandAloneApps)

  const searchParams = new URLSearchParams(window.location.search)
  const code = searchParams.get('code')
  if (code === 'newinstall') showDeviceInstallOnTop(manOuter.manifest)

  // Only set permissions once
  if (!hasSetPermissions) {
    setTimeout(async () => {
      const permsDiv = await showPermsIn(targetApp)
      dg.el('perms', { clear: true }, permsDiv)
      hasSetPermissions = true
    }, 5)
  }

  if (manOuter.offThreadStatus) {
    console.log('offThreadStatus ', manOuter.offThreadStatus)
    if (!manOuter.warnings || manOuter.warnings.length === 0) manOuter.warnings = []
    const seemsToHaveStopped = manOuter.offThreadStatus.offThreadParams.currentUpdateTime < new Date().getTime() - 30000
    manOuter.warnings.push({
      message: seemsToHaveStopped ?
        'Your files were being updated, most recently at ' + new Date(manOuter.offThreadStatus.offThreadParams.currentUpdateTime).toLocaleTimeString() + '. But there seems to have been an error. So please try installing again' :
        'Your files are being copied to your storage. ' + manOuter.offThreadStatus.offThreadParams.filesRemaining.length + ' files remaining.',
      severity: 'warning',
      type: 'warning'
    })
    
    if (seemsToHaveStopped) {
      // Clear any existing interval and stop updating
      if (refreshIntervalId) {
        clearInterval(refreshIntervalId)
        refreshIntervalId = null
      }
    } else if (!refreshIntervalId) {
      // Start periodic updates every 10 seconds if not already running
      refreshIntervalId = setInterval(async () => await getManifestAndRefreshWarnings(), 10000)
    }
  } else {
    // No offThreadStatus, so clear any existing interval
    if (refreshIntervalId) {
      clearInterval(refreshIntervalId)
      refreshIntervalId = null
    }
  }

  // Display warnings if any exist
  if (manOuter.warnings && manOuter.warnings.length > 0) {
    const warningsDiv = createWarningsDiv(manOuter.warnings, targetApp)
    dg.el('warnings', { clear: true }, warningsDiv)
  }

}

freezr.initPageScripts = async function () {
  const searchParams = new URLSearchParams(window.location.search)
  const messageEl = dg.el('message')
  if (messageEl) messageEl.innerHTML = searchParams.get('message') || ''
  const appNameEl = dg.el('app_name')
  if (appNameEl) appNameEl.innerHTML = targetApp
  
  console.log('account_app_settings.js loaded 3')
  // Initial call to get manifest and set up warnings
  await getManifestAndRefreshWarnings()
  
  history.pushState(null, null, '?')
}

/**
 * Show a message in the freezrAppSettingsMessages div (errorBox/successBox style).
 * @param {string} message - Text or HTML to display
 * @param {boolean} [isError] - If true, use errorBox style (red); otherwise successBox (green)
 */
const showAppSettingsMessage = function (message, isError) {
  const el = dg.el('freezrAppSettingsMessages')
  if (!el) return
  el.classList.remove('successBox', 'errorBox')
  el.classList.add(isError ? 'errorBox' : 'successBox')
  el.style.display = ''
  el.innerHTML = message
}

/**
 * Enable/disable a freezrBox and show/hide a spinner overlay.
 * @param {Element|null} box - The .freezrBox element (from e.target.closest('.freezrBox'))
 * @param {boolean} loading - True to show spinner and disable, false to remove
 */
const setBoxLoading = function (box, loading) {
  if (!box) return
  const overlayClass = 'freezr-spinner-overlay'
  const loadingClass = 'freezr-box-loading'
  if (loading) {
    box.classList.add(loadingClass)
    if (!box.querySelector('.' + overlayClass)) {
      const overlay = dg.div({ className: overlayClass })
      const spinner = dg.div({ className: 'freezr-spinner' })
      overlay.appendChild(spinner)
      box.appendChild(overlay)
    }
  } else {
    box.classList.remove(loadingClass)
    const overlay = box.querySelector('.' + overlayClass)
    if (overlay) overlay.remove()
  }
}

const normliseGithubUrl = function (aUrl) {
  const startsWith = function (longertext, checktext) {
    if (!longertext || !checktext || !(typeof longertext === 'string') || !(typeof checktext === 'string')) return false
    if (checktext.length > longertext.length) return false
    return (checktext === longertext.slice(0, checktext.length))
  }
  const endsWith = function (longertext, checktext) {
    if (!checktext || !longertext || checktext.length > longertext.length) return false
    return (checktext === longertext.slice((longertext.length - checktext.length)))
  }
  if (startsWith(aUrl, 'https://github.com/') && (aUrl.match(/\//g) || []).length === 4 && !endsWith(aUrl, '.zip')) {
    aUrl = aUrl + '/archive/main.zip'
  }
  return aUrl
}

const drawStandAloneApps = async function (manifest) {
  const otherFuncsDiv = dg.div({ className: 'fBoxGrid', style: { 'justify-content': 'flex-start' } })

  const outer = dg.div(otherFuncsDiv)

  const genPasswordAndwrite = async function (e) {
    const box = e.target.closest('.freezrBox')
    setBoxLoading(box, true)
    let resp = null
    try {
      resp = await genAppPassword(manifest.identifier, 180)
      if (resp?.error) {
        showAppSettingsMessage(resp.error || 'Error getting code.', true)
      } else {
        navigator.clipboard.writeText(resp.full_url) // doesnt work on ios
        e.target.innerText = 'Your login authentication url has been created'
        e.target.appendChild(dg.div({
          className: 'freezrButt',
          style: { 'min-width': 'auto' },
          onclick: function (e2) {
            navigator.clipboard.writeText(resp.full_url)
            e2.target.className = ''
            e2.target.innerText = ' .. and copied to the clipboard.'
          }
        },
        'Copy url'))
        showAppSettingsMessage('An app code was created for your app: ' + resp.app_password + '. Your login url is <div id="freezrNewLoginUrl" style="word-break: break-all;">' + resp.full_url + '</div>', false)
      }
    } catch (err) {
      console.error('🔑 genPasswordAndwrite error:', err)
      e.target.innerText = 'Error getting code.'
      showAppSettingsMessage(err?.message || 'Error getting code.', true)
    }
    e.target.style.color = 'black'
    e.target.style.cursor = 'default'
    e.target.onclick = null
    setBoxLoading(box, false)
  }

  otherFuncsDiv.appendChild(makeBox({
    mainTextHTML: 'Get a (CEPS) login authentication url for apps',
    mainTextFunc: genPasswordAndwrite
  }))

  if (manifest.standAloneApps) {
    if (manifest.standAloneApps['chrome-extension'] && manifest.standAloneApps['chrome-extension'].install && isChromiumBrowser()) {
      const goToChromeWebStore = function (e) {
        window.open(manifest.standAloneApps['chrome-extension'].install, '_blank')
      }
      const chromeExtInstallLink = makeBox({
        mainTextHTML: 'Click to install the chrome extension',
        mainTextFunc: goToChromeWebStore,
        imgSrc: '/app/info.freezr.public/public/static/Chrome_Web_Store_logo_2012-2015.svg.png',
        imgFunc: goToChromeWebStore
      })
      chromeExtInstallLink.id = 'freezrChromeExtInstallLink'
      otherFuncsDiv.appendChild(chromeExtInstallLink)
    }
    if ((manifest.standAloneApps['chrome-extension'] && isChromiumBrowser())) {
      const refreshChromeCreds = makeBox({
        mainTextHTML: 'Click to refresh credentials',
        mainTextFunc: genPasswordAndwrite,
        imgSrc: '/app/info.freezr.account/app2app/' + manifest.identifier + '/static/logo.png',
        imgFunc: genPasswordAndwrite
      })
      refreshChromeCreds.id = 'freezrChromeExtensionCredsReplace'
      refreshChromeCreds.style.display = 'none'
      refreshChromeCreds.firstChild.firstChild.addEventListener('error', replaceWithFreezrEmptyLogo)

      otherFuncsDiv.appendChild(refreshChromeCreds)
    }
    //
    // && (manifest.standAloneApps.ios || manifest.standAloneApps.android
    if (isIos() && manifest.standAloneApps.ios && manifest.standAloneApps.ios.link) {
      const genPasswordAndSendToIos = async function (e) {
        const box = e.target.closest('.freezrBox')
        setBoxLoading(box, true)
        try {
          const resp = await genAppPassword(manifest.identifier, 180)
          if (resp?.error) {
            showAppSettingsMessage(resp.error || 'Error trying to get password.', true)
          } else {
            window.open(manifest.standAloneApps.ios.link + '?url=' + resp.full_url, '_self')
          }
        } catch (err) {
          console.warn(err)
          showAppSettingsMessage(err?.message || 'Error trying to get password.', true)
        }
        setBoxLoading(box, false)
      }
      otherFuncsDiv.appendChild(makeBox({
        mainTextHTML: 'Add your credentials to this device',
        mainTextFunc: genPasswordAndSendToIos,
        imgSrc: '/app/info.freezr.public/public/static/ios_logo.png',
        imgFunc: genPasswordAndSendToIos

      }))
    }
    // otherFuncsDiv.appendChild(makeBox({ mainTextHTML: 'on android' }))
  }
  if (manifest.app_url) {
    const updateAppFromUrl = async function (e) {
      const box = e.target.closest('.freezrBox')
      setBoxLoading(box, true)
      const appUrl = normliseGithubUrl(manifest.app_url)
      try {
        const resp = await freezr.apiRequest('POST', '/acctapi/app_install_from_url', { app_url: appUrl, app_name: manifest.identifier })
        console.log('🔑 updateAppFromUrl response:', { resp })
        if (resp?.error) {
          showAppSettingsMessage(resp.error || 'Error updating app.', true)
        } else {
          showAppSettingsMessage('App Updated', false)
        }
      } catch (err) {
        console.error('🔑 updateAppFromUrl caught error:', err)
        showAppSettingsMessage(err?.message || 'Error updating app.', true)
      }
      setBoxLoading(box, false)
    }
    otherFuncsDiv.appendChild(makeBox({
      mainTextHTML: 'Update App',
      mainTextFunc: updateAppFromUrl,
      imgSrc: '/app/info.freezr.public/public/static/update_logo.png',
      // imgSrc: '/app_files/' + manifest.identifier + '/static/logo.png',
      imgFunc: updateAppFromUrl
    }))
  }

  otherFuncsDiv.appendChild(makeBox({
    mainTextHTML: 'Review / backup raw app data',
    mainTextFunc: function () { window.open('/account/app/viewdata/' + manifest.identifier, '_self') },
    imgSrc: '/app/info.freezr.public/public/static/disk_logo.png',
    imgFunc: function () { window.open('/account/app/viewdata/' + manifest.identifier, '_self') }
  }))

  // otherFuncsDiv.appendChild(makeBox({
  //   mainTextHTML: 'Restore backed-up raw app data',
  //   mainTextFunc: function () { window.open('/account/app/restoredata', '_self') },
  //   imgSrc: '/app/info.freezr.public/public/static/disk_logo.png',
  //   imgFunc: function () { window.open('/account/app/restoredata', '_self') }
  // }))

  const deleteApp = async function () {
    if (confirm('Please confirm you want to delete this app and all of its data:')) {
      const gotErrs = []
      for (const collection in manifest.app_tables) {
        const deleteSuccess = await freepr.feps.delete({}, { app_table: (manifest.identifier + '.' + collection) })
        if (deleteSuccess.error) {
          gotErrs.push(deleteSuccess)
        }
      }
      if (gotErrs.length > 0) {
        alert('There were problems deleting yoru app data. Try later')
      } else {
        try {
          const ret = await freezr.apiRequest('POST', '/acctapi/appMgmtActions', {
            action: 'deleteApp', app_name: manifest.identifier
          })
          const msg = ret?.error ? 'Error trying to delete.' : 'App Deleted'
          if (confirm(msg + ' Press okay to go to your home page. ')) {
            window.open('/', '_self')
          }
        } catch (err) {
          if (confirm('Error trying to delete. Press okay to go to your home page. ')) {
            window.open('/', '_self')
          }
        }
      }
    }
  }
  otherFuncsDiv.appendChild(makeBox({
    mainTextHTML: 'Delete App',
    mainTextFunc: deleteApp,
    imgSrc: '/app/info.freezr.public/public/static/trash_logo.png',
    imgFunc: deleteApp
  }))

  return outer
}

const isChromiumBrowser = function () {
  return (window.chrome && !window.navigator.userAgent.match('CriOS')) // chrome on ios
}
const isIos = function () {
  return [
    'iPad Simulator',
    'iPhone Simulator',
    'iPod Simulator',
    'iPad',
    'iPhone',
    'iPod'
  ].includes(navigator.platform) ||
  // iPad on iOS 13 detection
  (navigator.userAgent.includes('Mac') && 'ontouchend' in document)
}
const showDeviceInstallOnTop = function (manifest) {
  if (isIos() && manifest.standAloneApps.ios && manifest.standAloneApps.ios.link) {
    const appHeader = document.getElementById('appHeader')
    const genPasswordAndSendToIos = async function (e) {
      const box = e.target.closest('.freezrBox')
      setBoxLoading(box, true)
      try {
        const resp = await genAppPassword(manifest.identifier, 180)
        if (resp?.error) {
          showAppSettingsMessage(resp.error || 'Error trying to get password.', true)
        } else {
          window.open(manifest.standAloneApps.ios.link + '?url=' + resp.full_url, '_self')
        }
      } catch (err) {
        console.error('🔑 genPasswordAndSendToIos error:', err)
        showAppSettingsMessage(err?.message || 'Error trying to get password.', true)
      }
      setBoxLoading(box, false)
    }
    const box = makeBox({
      mainTextHTML: 'Add your credentials to the app on this device',
      mainTextFunc: genPasswordAndSendToIos,
      imgSrc: '/app/info.freezr.public/public/static/ios_logo.png',
      imgFunc: genPasswordAndSendToIos
    })
    const outer = document.createElement('center')
    outer.appendChild(box)
    appHeader.appendChild(outer)
  }
}

const genAppPassword = async function (appName, daysExpiry) {
  const DEFAULT_EXPIRY_DAYS = 90// days

  const expiry = new Date().getTime() + ((daysExpiry || DEFAULT_EXPIRY_DAYS) * 24 * 3600 * 1000) // 60 * 1000 // 60 seconds for testing
  // console.log('temp setting expiry to ', new Date(expiry).toLocaleTimeString())
  // const options = { app_name: appName, expiry, one_device: false }
  const url = '/acctapi/generateAppPassword?app_name=' + appName + '&expiry=' + expiry + '&one_device=false'
  // onsole.log("sending genAppPassword options",options)

  // apiRequest(method, path, body = null, options = {})
  try {
    const resp = await freezr.apiRequest('GET', url)
    console.log('🔑 genAppPassword response:', { resp, url })
    if (!resp || !resp.app_password) {
      console.error('🔑 genAppPassword: Missing app_password in response:', resp)
      return { error: 'Missing app_password in response' }
    }
    resp.full_url = freezrMeta.serverAddress + '?user=' + freezrMeta.userId + '&password=' + resp.app_password
    navigator.clipboard.writeText(resp.full_url)
    return resp
  } catch (error) {
    console.error('🔑 genAppPassword error:', error)
    return { error: error.message }
  }
}
