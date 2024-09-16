// autoInstall

/* global freezr, freepr, targetApp, freezrMeta, freezerRestricted, confirm, alert, history */

import { showPermsIn, appHeaderFor, replaceWithFreezrEmptyLogo } from '../info.freezr.public/public/modules/AppSettings.js'
import { makeBox } from '../info.freezr.public/public/modules/freezrbox.js'
import { dg } from '../info.freezr.public/public/modules/dgelements.js'

freezr.initPageScripts = function () {
  const searchParams = new URLSearchParams(window.location.search)
  dg.el('message').innerHTML = searchParams.get('message')
  dg.el('app_name').innerHTML = targetApp
  freezr.utils.getManifest(targetApp, async function (err, manOuter) {
    // onsole.log({ err, manOuter })
    if (err || !manOuter || !manOuter.manifest) {
      console.warn({ err, manOuter })
      dg.el('appHeader', { clear: true }).innerText = 'Error getting manifest'
    } else {
      const header = await appHeaderFor(manOuter.manifest)
      header.style['background-color'] = '#E2E2E2'
      header.style['border-radius'] = '5px'
      header.style.padding = '5px'
      dg.el('appHeader', { clear: true }, header)

      const StandAloneApps = await drawStandAloneApps(manOuter.manifest)
      dg.el('standAloneApps', { clear: true }, StandAloneApps)

      setTimeout(async () => {
        const permsDiv = await showPermsIn(targetApp)
        dg.el('perms', { clear: true }, permsDiv, dg.hr())
      }, 5)
    }
  })
  history.pushState(null, null, '?')
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
  const otherFuncsDiv = dg.div({ style: { display: 'flex', 'flex-wrap': 'wrap', 'align-items': 'center', 'justify-content': 'center' } })
  const messages = dg.div({ id: 'freezrAppSettingsMessages', style: { 'font-size': '12px' } })

  const outer = dg.div(
    dg.h2({ id: 'updates' }, ('App Credentials, Updates and Removals ')),
    otherFuncsDiv,
    messages
  )

  const genPasswordAndwrite = function (e) {
    genAppPassword(manifest.identifier, 180, function (err, resp) {
      if (err) {
        e.target.innerText = 'Error getting code.'
      } else {
        e.target.innerText = 'Your login url has been copied to the clipboard'
      }
      e.target.style.color = 'black'
      e.target.style.cursor = 'default'
      e.target.onclick = null
      messages.innerHTML = 'An app code was created for your app: ' + resp.app_password + '. Your login url is <div id ="freezrNewLoginUrl">' + resp.full_url + '</div>'
    })
  }

  otherFuncsDiv.appendChild(makeBox({
    mainTextHTML: 'Click here to create and copy a (CEPS) login url for stand-alone apps',
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
        imgSrc: '/app_files/@public/info.freezr.public/public/static/Chrome_Web_Store_logo_2012-2015.svg.png',
        imgFunc: goToChromeWebStore
      })
      chromeExtInstallLink.id = 'freezrChromeExtInstallLink'
      otherFuncsDiv.appendChild(chromeExtInstallLink)
    }
    if ((manifest.standAloneApps['chrome-extension'] && isChromiumBrowser())) {
      const refreshChromeCreds = makeBox({
        mainTextHTML: 'Click to refresh credentials',
        mainTextFunc: genPasswordAndwrite,
        imgSrc: '/app_files/' + manifest.identifier + '/static/logo.png',
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
      const genPasswordAndSendToIos = function (e) {
        genAppPassword(manifest.identifier, 180, function (err, resp) {
          if (err) {
            console.warn(err)
            messages.innerHTL = 'Error trying to get password.'
          } else {
            // onsole.log({ manifest })
            window.open(manifest.standAloneApps.ios.link + '?url=' + resp.full_url, '_self')
          }
        })
      }
      otherFuncsDiv.appendChild(makeBox({
        mainTextHTML: 'Add your credentials to this device',
        mainTextFunc: genPasswordAndSendToIos,
        imgSrc: '/app_files/@public/info.freezr.public/public/static/ios_logo.png',
        imgFunc: genPasswordAndSendToIos

      }))
    }
    // otherFuncsDiv.appendChild(makeBox({ mainTextHTML: 'on android' }))
  }
  if (manifest.app_url) {
    const updateAppFromUrl = function () {
      const appUrl = normliseGithubUrl(manifest.app_url)
      freezerRestricted.connect.ask('/v1/account/app_install_from_url.json', { app_url: appUrl, app_name: manifest.identifier }, function (error, returndata) {
        if (error || returndata.err) {
          messages.innerHTL = 'Error trying to get password.'
        } else {
          messages.innerHTL = 'App Updated'
        }
      })
    }
    otherFuncsDiv.appendChild(makeBox({
      mainTextHTML: 'Update App',
      mainTextFunc: updateAppFromUrl,
      imgSrc: '/app_files/@public/info.freezr.public/public/static/update_logo.png',
      // imgSrc: '/app_files/' + manifest.identifier + '/static/logo.png',
      imgFunc: updateAppFromUrl
    }))
  }

  otherFuncsDiv.appendChild(makeBox({
    mainTextHTML: 'Review / backup raw app data',
    mainTextFunc: function () { window.open('/account/app/viewdata/' + manifest.identifier, '_self') },
    imgSrc: '/app_files/@public/info.freezr.public/public/static/disk_logo.png',
    imgFunc: function () { window.open('/account/app/viewdata/' + manifest.identifier, '_self') }
  }))

  // otherFuncsDiv.appendChild(makeBox({
  //   mainTextHTML: 'Restore backed-up raw app data',
  //   mainTextFunc: function () { window.open('/account/app/restoredata', '_self') },
  //   imgSrc: '/app_files/@public/info.freezr.public/public/static/disk_logo.png',
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
      // onsole.log({ gotErrs })
      if (gotErrs.length > 0) {
        alert('There were problems deleting yoru app data. Try later')
      } else {
        freezerRestricted.connect.ask('/v1/account/appMgmtActions.json', {
          action: 'deleteApp', app_name: manifest.identifier
        }, function (err, ret) {
          // onsole.log('deleteing app ', { err, ret })
          const msg = err ? 'Error trying to delete.' : 'App Deleted'
          if (confirm(msg + ' Press okay to go to your home page. ')) {
            window.open('/', '_self')
          }
        })
      }
    }
  }
  otherFuncsDiv.appendChild(makeBox({
    mainTextHTML: 'Delete App',
    mainTextFunc: deleteApp,
    imgSrc: '/app_files/@public/info.freezr.public/public/static/trash_logo.png',
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

const genAppPassword = function (appName, daysExpiry, callback) {
  const DEFAULT_EXPIRY_DAYS = 90// days

  const expiry = new Date().getTime() + ((daysExpiry || DEFAULT_EXPIRY_DAYS) * 24 * 3600 * 1000) // 60 * 1000 // 60 seconds for testing
  // console.log('temp setting expiry to ', new Date(expiry).toLocaleTimeString())
  const options = { app_name: appName, expiry, one_device: false }
  const url = '/v1/account/apppassword/generate'
  // onsole.log("sending genAppPassword options",options)

  freezerRestricted.connect.read(url, options, (error, resp) => {
    resp.full_url = freezrMeta.serverAddress + '?user=' + freezrMeta.userId + '&password=' + resp.app_password
    navigator.clipboard.writeText(resp.full_url)
    if (callback) callback(error, resp)
  })
}
