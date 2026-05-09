// freezr Accunts page account_home.js

/* global freezr, freezrMeta, freezerRestricted, FormData */

freezr.initPageScripts = function () {
  console.log('hello from account_home.js')

  renderNotificationsBanner()

  document.addEventListener('click', function (evt) {
    if (evt.target.id && freezr.utils.startsWith(evt.target.id, 'button_')) {
      const parts = evt.target.id.split('_')
      const args = evt.target.id.split('_')
      args.splice(0, 2).join('_')
      if (buttons[parts[1]]) buttons[parts[1]](args, evt.target)
    }
  })

  buttons.tabs(['featured'])
  
  // Drag-drop on upload area
  const uploadArea = document.getElementById('upload_area')
  if (uploadArea) {
    uploadArea.ondragenter = handleDragEnter
    uploadArea.ondragover = handleDragOver
    uploadArea.ondragleave = handleDragLeave
    uploadArea.ondrop = handleDrop
  }

  // Drag anywhere on install dialogue switches to upload tab
  const installBox = document.getElementById('installDialogueBox')
  if (installBox) {
    installBox.ondragenter = function (e) {
      preventDefaults(e)
      buttons.tabs(['upload'])
    }
    installBox.ondragover = preventDefaults
  }

  // File chooser: show selected filename
  const fileInput = document.getElementById('app_zipfile2')
  if (fileInput) {
    fileInput.addEventListener('change', function () {
      const nameSpan = document.getElementById('chosen_file_name')
      const uploadBtn = document.getElementById('button_uploadZipFileApp')
      if (fileInput.files && fileInput.files.length > 0) {
        nameSpan.textContent = fileInput.files[0].name
        uploadBtn.style.display = 'inline-block'
      } else {
        nameSpan.textContent = ''
        uploadBtn.style.display = 'none'
      }
    })
  }

  if (publicLandingPage) {
    document.getElementById('publicEntry').href = '/' + publicLandingPage
  } else {
    document.getElementById('publicEntry').style.display = 'none'
  }

  // Grab url params and show error if present, then remove error param from url
  const urlParams = new URLSearchParams(window.location.search);
  const errorMsg = urlParams.get('error');
  if (errorMsg) {
    showError(errorMsg);
    urlParams.delete('error');
    const baseUrl = window.location.origin + window.location.pathname;
    const newParams = urlParams.toString();
    const newUrl = baseUrl + (newParams ? '?' + newParams : '');
    window.history.replaceState({}, document.title, newUrl);
  }

  setTimeout(function () {
    const imglist = document.getElementsByClassName('fBoxImg')
    for (let i = 0; i < imglist.length; i++) {
      if (!imglist[i].complete || imglist[i].naturalHeight === 0) {
        console.warn('📱 account_home - Missinf logo:', imglist[i].src)
        // imglist[i].src = '/app/info.freezr.public/public/static/freezer_logo_empty.png'
      }
    }
  }, 1000)

  document.getElementById('appUrl').addEventListener('keyup', function () {
    document.getElementById('appNameFromUrl').innerText = getAppFromUrl(document.getElementById('appUrl').innerText)
  })
  if (!freezrMeta.adminUser) { document.getElementById('freezer_admin_butt').style.display = 'none' }
  if (freezrMeta.adminUser) document.getElementById('button_tabs_dev').style.display = 'block'

  const searchParams = new URLSearchParams(window.location.search)
  if (searchParams.get('show') === 'welcome') {
    document.getElementById('welcomeMsg').style.display = 'block'
    document.getElementById('app_list').firstElementChild.style.display = 'none'
    window.history.pushState(null, 'Welcome to freezr', '/')
  }
}

// Install progress feedback
const showInstallProgress = function (appName) {
  // Switch to upload tab
  buttons.tabs(['upload'], { force: true })

  // Freeze all tab buttons
  const tablinks = document.getElementsByClassName('tablinks')
  for (let i = 0; i < tablinks.length; i++) {
    tablinks[i].classList.add('tab-disabled')
  }

  // Hide normal upload content, show progress area
  const normalContent = document.getElementById('uploadNormalContent')
  const progressArea = document.getElementById('installProgressArea')
  const resultArea = document.getElementById('installResultArea')
  const spinner = document.getElementById('installSpinner')
  const title = document.getElementById('installProgressTitle')
  const subtitle = document.getElementById('installProgressSubtitle')

  if (normalContent) normalContent.style.display = 'none'
  if (progressArea) progressArea.style.display = 'block'
  if (resultArea) resultArea.style.display = 'none'
  if (spinner) spinner.style.display = 'block'
  if (title) title.innerText = 'Installing ' + (appName || 'app') + '...'
  if (subtitle) {
    subtitle.innerText = 'Please wait while the app is being installed.'
    subtitle.style.display = 'block'
  }
}

const showInstallResult = function (returndata) {
  const spinner = document.getElementById('installSpinner')
  const title = document.getElementById('installProgressTitle')
  const subtitle = document.getElementById('installProgressSubtitle')
  const resultArea = document.getElementById('installResultArea')
  const resultMessage = document.getElementById('installResultMessage')
  const warningsDiv = document.getElementById('installWarnings')
  const actionsDiv = document.getElementById('installResultActions')
  const launchAppLink = document.getElementById('installResultLaunchApp')
  const goToAppLink = document.getElementById('installResultGoToApp')

  // Hide spinner and subtitle
  if (spinner) spinner.style.display = 'none'
  if (subtitle) subtitle.style.display = 'none'

  if (resultArea) resultArea.style.display = 'block'

  const isError = returndata?.error || returndata?.errors
  const appName = returndata?.flags?.meta?.app_name || returndata?.meta?.app_name
  const servedUrl = returndata?.flags?.meta?.served_url || returndata?.meta?.served_url

  if (isError) {
    // Error result
    if (title) title.innerText = 'Installation failed'
    if (resultMessage) {
      resultMessage.className = 'install-error'
      resultMessage.innerText = returndata.error || returndata.errors || 'An unknown error occurred during installation.'
    }
    if (actionsDiv) actionsDiv.style.display = 'flex'
    if (launchAppLink) launchAppLink.style.display = 'none'
    if (goToAppLink) goToAppLink.style.display = 'none'
  } else {
    // Success result
    const wasUpdate = returndata?.flags?.meta?.didwhat === 'updated'
    if (title) title.innerText = wasUpdate ? 'App Updated!' : 'App Installed!'
    if (resultMessage) {
      resultMessage.className = 'install-success'
      resultMessage.innerText = (appName || 'App') + ' was successfully ' + (wasUpdate ? 'updated' : 'installed') + '.'
    }
    if (actionsDiv) actionsDiv.style.display = 'flex'
    if (launchAppLink) {
      launchAppLink.style.display = 'inline-block'
      launchAppLink.href = servedUrl || ('/apps/' + appName)
    }
    if (goToAppLink) {
      goToAppLink.style.display = 'inline-block'
      goToAppLink.href = '/account/app/settings/' + appName
    }
  }

  // Show warnings if any
  const warnings = returndata?.flags?.warnings || returndata?.warnings
  if (warningsDiv) {
    if (warnings && ((Array.isArray(warnings) && warnings.length > 0) || (typeof warnings === 'string' && warnings.length > 0))) {
      warningsDiv.style.display = 'block'
      if (Array.isArray(warnings)) {
        const msgs = warnings.map(w => (typeof w === 'object' && w.message) ? w.message : String(w))
        warningsDiv.innerHTML = '<strong>Warnings:</strong><br>' + msgs.join('<br>')
      } else {
        warningsDiv.innerHTML = '<strong>Warning:</strong> ' + ((typeof warnings === 'object' && warnings.message) ? warnings.message : warnings)
      }
    } else {
      warningsDiv.style.display = 'none'
    }
  }

  // Re-enable tab buttons
  const tablinks = document.getElementsByClassName('tablinks')
  for (let i = 0; i < tablinks.length; i++) {
    tablinks[i].classList.remove('tab-disabled')
  }
}

const resetInstallArea = function () {
  const normalContent = document.getElementById('uploadNormalContent')
  const progressArea = document.getElementById('installProgressArea')
  if (normalContent) normalContent.style.display = 'block'
  if (progressArea) progressArea.style.display = 'none'
}

const buttons = {
  installDone: function () {
    resetInstallArea()
    // Re-enable tabs in case they're still disabled
    const tablinks = document.getElementsByClassName('tablinks')
    for (let i = 0; i < tablinks.length; i++) {
      tablinks[i].classList.remove('tab-disabled')
    }
  },
  tabs: function (args, options) {
    // Don't allow tab switching while install is in progress (unless forced)
    if (!options?.force) {
      const progressArea = document.getElementById('installProgressArea')
      if (progressArea && progressArea.style.display === 'block') return
    }

    const tabName = args[0]

    const tabcontent = document.getElementsByClassName('tabcontent')
    for (let i = 0; i < tabcontent.length; i++) {
      tabcontent[i].style.display = 'none'
    }

    const tablinks = document.getElementsByClassName('tablinks')
    for (let i = 0; i < tablinks.length; i++) {
      tablinks[i].className = tablinks[i].className.replace(' active', '')
    }

    document.getElementById('tab_' + tabName).style.display = 'block'
    document.getElementById('button_tabs_' + tabName).className += ' active'
  },
  feature: function (args, targetEl) {
    const appName = targetEl.id.split('_')[2]
    document.getElementById('appUrl').innerText = 'https://github.com/salmanff/' + appName
    document.getElementById('appNameFromUrl').innerText = appName
    buttons.addAppViaUrl()
  },
  addAppViaUrl: function () {
    let appUrl = document.getElementById('appUrl').innerText
    const appName = document.getElementById('appNameFromUrl').innerText

    if (!appUrl) {
      showError('Please enter a url to a zip file')
    } else if (appUrl === 'https://github.com/user/repo') {
      showError('Please enter an actual github user and repository or point to a zip file url.')
    } else if (!isValidAppName(appName)) {
      showError('Invalid app name - please correct the app name')
    } else {
      showInstallProgress(appName)

      appUrl = normliseGithubUrl(appUrl)
      // Using new V2 API
      freezr.apiRequest('POST', '/acctapi/app_install_from_url', { app_url: appUrl, app_name: appName })
        .then(returndata => {
          if (returndata.error) {
            console.warn({ returndata })
          }
          showInstallResult(returndata)
        })
        .catch(error => {
          console.warn({ error })
          showInstallResult({ error: error.message || 'Error installing app.' })
        })
    }
  },
  chooseFile: function () {
    document.getElementById('app_zipfile2').click()
    // File input stays hidden; the change event handler shows the filename and upload button
  },
  uploadZipFileApp: function (args) {
    const fileInput = document.getElementById('app_zipfile2')
    const file = (fileInput && fileInput.files) ? fileInput.files[0] : null

    if (!fileInput || !file) {
      showError('Please Choose a file first.')
    } else {
      const parts = file.name.split('.')
      if (endsWith(parts[(parts.length - 2)], '-master')) parts[(parts.length - 2)] = parts[(parts.length - 2)].slice(0, -7)
      if (startsWith((parts[(parts.length - 2)]), '_v_')) {
        parts.splice(parts.length - 2, 2)
      } else {
        parts.splice(parts.length - 1, 1)
      }
      const appNameJoined = parts.join('.')
      const appName = appNameJoined.split(' ')[0]

      if (file.name.substr(-4) !== '.zip') {
        showError('The app file uploaded must be a zipped file. (File name represents the app name.)')
      } else if (!isValidAppName(appName)) {
        showError('Invalid app name - please make sure the zip file conforms to freezr app name guidelines')
      } else {
        showInstallProgress(appName)

        const uploadData = new FormData()
        uploadData.append('file', file)
        uploadData.append('app_name', appName)
        const url = '/acctapi/app_install_from_zipfile'

        // Using new V2 API
        freezr.apiRequest('PUT', url, uploadData, { uploadFile: true })
          .then(returndata => {
            if (returndata?.error) {
              console.warn({ returndata })
            }
            console.log('🔄 uploadZipFileApp result:', returndata)
            showInstallResult(returndata)
          })
          .catch(error => {
            console.warn({ error })
            showInstallResult({ error: error.message || error.code || 'Error installing app.' })
          })
      }
    }
  },
  addServedApp: function () {
    const appName = document.getElementById('appNameForServedApp').innerText
    const servedUrl = document.getElementById('appUrlForServedApp').innerText || null
    const displayName = document.getElementById('appDisplayNameForServedApp').innerText || null
    // later grab logo and manifest to populate...

    if (!isValidAppName(appName) && !servedUrl) {
      showError('Invalid app name 2- please correct the app name')
    } else if (!isValidAppName(appName) && servedUrl && !isValidUrl(servedUrl)) {
      showError('Invalid app url - please correct the app url or leave blank if not needed')
    } else {
      showInstallProgress(appName)
      // Using new V2 API
      freezr.apiRequest('POST', '/acctapi/app_install_served', { app_name: appName, served_url: servedUrl, app_display_name: displayName })
        .then(returndata => {
          if (returndata.error) {
            console.warn({ returndata })
          }
          showInstallResult(returndata)
        })
        .catch(error => {
          console.warn({ error })
          showInstallResult({ error: 'Error updating app! ' + error.message })
        })
    }
  },
  updateAppFromFiles: function () {
    const appName = document.getElementById('appNameFromFolder').innerText
    if (!appName) {
      showError('Please enter an app name')
    } else if (!isValidAppName(appName)) {
      showError('Invalid app name 3 - please correct the app name')
    } else {
      showInstallProgress(appName)
      // Using new V2 API
      freezr.apiRequest('POST', '/acctapi/updateAppFromFiles', { app_name: appName })
        .then(returndata => {
          if (returndata.error || returndata.errors) {
            console.warn({ returndata })
          }
          showInstallResult(returndata)
        })
        .catch(error => {
          console.warn({ error })
          showInstallResult({ error: 'Error updating app! ' + error.message })
        })
    }
  }
}
const installSuccessProcess = function (returndata) {
  // Legacy fallback - now handled by showInstallResult
  showInstallResult(returndata)
}
const isValidUrl = function (appName) {
  if (!appName) return false
  if (appName.length < 1) return false
  if (!startsWithOneOf(appName, ['/', 'https://', 'http://'])) return false
  if (appName.indexOf('/oapp/') < -1) return false
  return true
}
// same as config.js but isSystemApp replaced with explicit info.freezr check
const isValidAppName = function (appName) {
  if (!appName) return false
  if (appName.length < 1) return false
  if (!isValidFilename(appName)) return false
  if (startsWithOneOf(appName, ['.', '-', '\\', 'system'])) return false
  if ((startsWith(appName, 'info.freezr') || startsWith(appName, 'ceps.dev')) && !startsWith(appName, 'info.freezr.user.')) return false
  if (SYSTEM_APPS.indexOf(appName) > -1) return false
  if (appName.indexOf('_') > -1) return false
  if (appName.indexOf(' ') > -1) return false
  if (appName.indexOf('$') > -1) return false
  if (appName.indexOf('"') > -1) return false
  if (appName.indexOf('/') > -1) return false
  if (appName.indexOf('\\') > -1) return false
  if (appName.indexOf('{') > -1) return false
  if (appName.indexOf('}') > -1) return false
  if (appName.indexOf('..') > -1) return false
  if (appName.endsWith('.')) return false
  const appSegements = appName.split('.')
  if (appSegements.length < 3) return false
  return true
}
const isValidFilename = function (fn) {
  const re = /[^.a-zA-Z0-9-_ ]/
  // @"^[\w\-. ]+$" http://stackoverflow.com/questions/11794144/regular-expression-for-valid-filename
  return typeof fn === 'string' && fn.length > 0 && !(fn.match(re))
}
const startsWithOneOf = function (thetext, stringArray) {
  for (let i = 0; i < stringArray.length; i++) {
    if (startsWith(thetext, stringArray[i])) return true
  }
  return false
}

// Hanlding dropped files
//  credit to https://www.smashingmagazine.com/2018/01/drag-drop-file-uploader-vanilla-js/ and https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API/File_drag_and_drop
const handleDragEnter = function (e) {
  preventDefaults(e)
  highlight(e)
}
const handleDragOver = function (e) {
  preventDefaults(e)
  highlight(e)
}
const handleDragLeave = function (e) {
  preventDefaults(e)
  unhighlight(e)
}
const handleDrop = function (e) {
  preventDefaults(e)
  unhighlight(e)
  const items = e.dataTransfer.items
  // let files = dt.files
  // const dropId = targetDropArea(e).id

  const extFromFileName = function (fileName) {
    return fileName.split('.').pop()
  }

  const file = (items && items.length > 0) ? items[0].getAsFile() : ''
  const ext = extFromFileName(file.name)

  const parts = file.name.split('.')
  if (endsWith(parts[(parts.length - 2)], '-master')) parts[(parts.length - 2)] = parts[(parts.length - 2)].slice(0, -7)
  if (endsWith(parts[(parts.length - 2)], '-main')) parts[(parts.length - 2)] = parts[(parts.length - 2)].slice(0, -5)
  parts.splice(parts.length - 1, 1)
  let appName = parts.join('.')
  appName = appName.split(' ')[0]

  if (!items || !file) {
    showError('Please Choose a file first.')
  } else if (items.length > 1) {
    showError('Please upload one zip file only.')
  } else if (ext !== 'zip') {
    showError('The app file uploaded must be a zipped file. (File name represents the app name.)')
  } else if (!isValidAppName(appName)) {
    showError('Invalid app name - please make sure the zip file conforms to freezr app name guidelines')
  } else {
    showInstallProgress(appName)

    const uploadData = new FormData()
    uploadData.append('file', file)
    uploadData.append('app_name', appName)
    const url = '/acctapi/app_install_from_zipfile'

    // Using new V2 API
    freezr.apiRequest('PUT', url, uploadData, { uploadFile: true })
      .then(returndata => {
        if (returndata.error) {
          console.warn({ returndata })
        }
        showInstallResult(returndata)
      })
      .catch(error => {
        console.warn({ error })
        showInstallResult({ error: 'There was an error installing the app: ' + (error?.message || 'unknown error') + '.' })
      })
  }
}
const preventDefaults = function (e) {
  e.preventDefault()
  e.stopPropagation()
}
const highlight = function (e) {
  targetDropArea(e).classList.add('highlight')
}
const unhighlight = function (e) {
  targetDropArea(e).classList.remove('highlight')
}
const targetDropArea = function (e) {
  let target = e.target
  if (!target.className.includes('drop-area')) {
    target = target.parentElement
  }
  if (!target.className.includes('drop-area')) console.log('akkkhhh - should iterate')
  return target
}

// Render notification cards from freezrMeta.notifications. New notification
// types (messages, cron failures, etc.) flow in here automatically via the
// userDS.getNotifications() server hook — no per-id code needed below.
const renderNotificationsBanner = function () {
  const banner = document.getElementById('notificationsBanner')
  if (!banner) return
  const notifications = (window.freezrMeta && freezrMeta.notifications) || []
  banner.innerHTML = ''
  if (!notifications.length) {
    banner.style.display = 'none'
    return
  }
  banner.style.display = 'block'
  const ICON_BY_SEVERITY = { error: '⚠', warning: '⚠', info: 'ℹ' }
  notifications.forEach(function (n) {
    const card = document.createElement('div')
    card.className = 'freezr-notif-card'
    card.setAttribute('data-severity', n.severity || 'info')

    const icon = document.createElement('div')
    icon.className = 'freezr-notif-card-icon'
    icon.textContent = ICON_BY_SEVERITY[n.severity] || ICON_BY_SEVERITY.info
    card.appendChild(icon)

    const body = document.createElement('div')
    body.className = 'freezr-notif-card-body'

    const title = document.createElement('div')
    title.className = 'freezr-notif-card-title'
    title.textContent = n.title || ''
    body.appendChild(title)

    if (n.message) {
      const msg = document.createElement('div')
      msg.className = 'freezr-notif-card-msg'
      msg.textContent = n.message
      body.appendChild(msg)
    }

    if (n.action && n.action.url) {
      const a = document.createElement('a')
      a.className = 'freezr-notif-card-action'
      a.href = n.action.url
      a.textContent = n.action.label || 'View'
      body.appendChild(a)
    }

    card.appendChild(body)
    banner.appendChild(card)
  })
}

// Utility
let timer = null
const showError = function (errorText) {
  clearTimeout(timer)
  const errorBox = document.getElementById('errorBox')
  errorBox.style['font-size'] = '24px'
  errorBox.innerHTML = errorText || ' &nbsp '
  // Scroll to the error box so it's visible to the user
  if (errorBox && typeof errorBox.scrollIntoView === 'function') {
    errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' })
  } else {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  if (errorText) {
    timer = setTimeout(function () {
      showError()
    }, 5000)
  }
}
const SYSTEM_APPS = ['info.freezr.account', 'info.freezr.admin', 'info.freezr.public', 'info.freezr.permissions', 'info.freezr.posts']
const getAppFromUrl = function (aUrl) {
  let appname = aUrl
  if (startsWith(aUrl, 'https://github.com/')) {
    appname = appname.replace('https://github.com/', '')
    appname = appname.slice(appname.indexOf('/') + 1)
    if (appname.indexOf('/') > -1) appname = appname.slice(0, appname.indexOf('/'))
  } else {
    appname = appname.slice(appname.lastIndexOf('/') + 1)
    if (appname.indexOf('.zip') > -1) appname = appname.slice(0, appname.indexOf('.zip'))
  }
  return appname
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
const normliseGithubUrl = function (aUrl) {
  if (startsWith(aUrl, 'https://github.com/') && (aUrl.match(/\//g) || []).length === 4 && !endsWith(aUrl, '.zip')) {
    aUrl = aUrl + '/archive/main.zip'
  }
  return aUrl
}
