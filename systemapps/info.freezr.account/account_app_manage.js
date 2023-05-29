// account app Management

/* global freezr, freezerRestricted, FormData, freezrMeta, history, Mustache */
let doShowDevoptions = false
let userHasIntiatedAcions = false
const DEFAULT_EXPIRY_DAYS = 90// days

freezr.initPageScripts = function () {
  document.addEventListener('click', function (evt) {
    if (evt.target.id && freezr.utils.startsWith(evt.target.id, 'button_')) {
      const parts = evt.target.id.split('_')
      const args = evt.target.id.split('_')
      args.splice(0, 2).join('_')
      console.log(args)
      if (buttons[parts[1]]) buttons[parts[1]](args, evt.target)
    }
  })

  buttons.tabs(['featured'])

  const uploadArea = document.getElementById('upload_area')
  if (uploadArea) {
    uploadArea.ondragenter = handleDragEnter
    uploadArea.ondragover = handleDragOver
    uploadArea.ondragleave = handleDragLeave
    uploadArea.ondrop = handleDrop
  }

  const tabcontent = document.getElementsByClassName('tabcontent')
  for (let i = 0; i < tabcontent.length; i++) {
    tabcontent[i].ondragenter = function (e) {
      preventDefaults(e)
      buttons.tabs(['upload'])
    }
  }

  if (document.getElementById('appUrl')) {
    document.getElementById('appUrl').addEventListener('keyup', function () {
      if (document.getElementById('appNameFromUrl')) document.getElementById('appNameFromUrl').innerText = getAppFromUrl(document.getElementById('appUrl').innerText)
    })
  }

  if (!freezrMeta.adminUser) {
    document.getElementById('freezer_admin_butt').style.display = 'none'
    setTimeout(function () {
      if (document.getElementById('button_showDevOptions')) document.getElementById('button_showDevOptions').style.display = 'none'
      if (document.getElementById('freezer_users_butt')) document.getElementById('freezer_users_butt').style.display = 'none'
    }, 300)
  }
  if (freezrMeta.adminUser && window.location.search.indexOf('dev=true') > 0) doShowDevoptions = true
  showDevOptions()
}

const showDevOptions = function () {
  buttons.updateAppList()
  if (doShowDevoptions && freezrMeta.adminUser) {
    document.getElementById('addFileTable').style.display = 'block'
    document.getElementById('button_showDevOptions').style.display = 'none'
  }
}

freezr.onFreezrMenuClose = function (hasChanged) {
  // freezerRestricted.menu.resetDialogueBox(true)
  if (userHasIntiatedAcions) buttons.updateAppList()
  // setTimeout(function () {freezerRestricted.menu.resetDialogueBox(true)},300)
}
const buttons = {
  tabs: function (args, evt) {
    // onsole.log({ args })
    const tabName = args[0]

    const tabcontent = document.getElementsByClassName('tabcontent')
    for (let i = 0; i < tabcontent.length; i++) {
      tabcontent[i].style.display = 'none'
    }

    const tablinks = document.getElementsByClassName('tablinks')
    for (let i = 0; i < tablinks.length; i++) {
      tablinks[i].className = tablinks[i].className.replace(' active', '')
    }

    // for app_management
    if (document.getElementById('tab_' + tabName)) document.getElementById('tab_' + tabName).style.display = 'block'
    if (document.getElementById('button_tabs_' + tabName)) document.getElementById('button_tabs_' + tabName).className += ' active'
    // evt.currentTarget.className += ' active'
  },
  showDevOptions: function (args) {
    doShowDevoptions = true
    showDevOptions()
    history.pushState(null, null, '?dev=true')
  },
  goto: function (args) {
    //
    freezerRestricted.menu.close()
    window.open('/apps/' + args[1] + '/index.html', '_self')
  },
  installApp: function (args) {
    userHasIntiatedAcions = true
    window.open('/apps/' + args[0], '_self')
  },
  reinstallApp: function (args) {
    userHasIntiatedAcions = true
    window.open('/apps/' + args[0], '_self')
  },
  removeAppFromHomePage: function (args) {
    userHasIntiatedAcions = true
    freezerRestricted.connect.ask('/v1/account/appMgmtActions.json', { action: 'removeAppFromHomePage', app_name: args[0] }, removeAppCallback)
  },
  deleteApp: function (args) {
    userHasIntiatedAcions = true
    freezerRestricted.connect.ask('/v1/account/appMgmtActions.json', { action: 'deleteApp', app_name: args[0] }, deleteAppCallback)
  },
  uploadZipFileApp: function (args) { // OLD STYLE UPLOAD
    userHasIntiatedAcions = true
    const fileInput = document.getElementById('app_zipfile2')
    const file = (fileInput && fileInput.files) ? fileInput.files[0] : null

    const parts = file.name.split('.')
    if (endsWith(parts[(parts.length - 2)], '-master')) parts[(parts.length - 2)] = parts[(parts.length - 2)].slice(0, -7)
    if (startsWith((parts[(parts.length - 2)]), '_v_')) {
      parts.splice(parts.length - 2, 2)
    } else {
      parts.splice(parts.length - 1, 1)
    }
    let appName = parts.join('.')
    appName = appName.split(' ')[0]

    if (!fileInput || !file) {
      showError('Please Choose a file first.')
    } else if (file.name.substr(-4) !== '.zip') {
      document.getElementById('errorBox').innerHTML = 'The app file uploaded must be a zipped file. (File name represents the app name.)'
    } else if (!validAppName(appName)) {
      document.getElementById('errorBox').innerHTML = 'Invalid app name - please make sure the zip file conforms to freezr app name guidelines'
    } else {
      const uploadData = new FormData()
      uploadData.append('file', file)
      uploadData.append('app_name', appName)
      const url = '/v1/account/app_install_from_zipfile.json'
      freezerRestricted.menu.resetDialogueBox(true)
      if (file.size > 500000) document.getElementById('freezer_dialogueInnerText').innerHTML = '<br/>You are uploading a large file. This might take a little while. Please be patient.<br/>' + document.getElementById('freezer_dialogueInnerText').innerHTML
      freezerRestricted.connect.send(url, uploadData, function (error, returndata) {
        if (error || returndata.err) {
          writeErrorsToFreezrDialogue(returndata)
        } else {
          ShowAppUploadErrors(returndata.flags, 'uploadZipFileApp', uploadSuccess)
        }
      }, 'PUT', null)
    }
  },
  addAppViaUrl: function () {
    userHasIntiatedAcions = true
    let appUrl = document.getElementById('appUrl').innerText
    const appName = document.getElementById('appNameFromUrl').innerText

    if (!appUrl) {
      showError('Please enter a url to a zip file')
    } else if (appUrl === 'https://github.com/user/repo') {
      showError('Please enter an actual github user and repository or point to a zip file url.')
    } else if (!validAppName(appName)) {
      showError('Invalid app name - please correct the app name')
    } else {
      appUrl = normliseGithubUrl(appUrl)
      freezerRestricted.menu.resetDialogueBox(true)
      freezerRestricted.connect.ask('/v1/account/app_install_from_url.json', { app_url: appUrl, app_name: appName }, function (error, returndata) {
        if (error || (returndata && returndata.err)) {
          writeErrorsToFreezrDialogue(returndata)
        } else {
          ShowAppUploadErrors(returndata.flags, 'addAppViaUrl', uploadSuccess)
        }
      })
    }
  },
  feature: function (args, targetEl) {
    const appName = targetEl.id.split('_')[2]
    document.getElementById('appUrl').innerText = 'https://github.com/salmanff/' + appName
    document.getElementById('appNameFromUrl').innerText = appName
    buttons.addAppViaUrl()
  },
  addBlankApp: function () {
    userHasIntiatedAcions = true
    const appName = document.getElementById('appNameForBlankApp').innerText
    const servedUrl = document.getElementById('appUrlForBlankApp').innerText || null
    const displayName = document.getElementById('appDisplayNameForBlankApp').innerText || null
    console.log({ appName, servedUrl, displayName })
    // later grab logo and manifest to populate...

    if (!validAppName(appName) && !servedUrl) {
      showError('Invalid app name - please correct the app name')
    } else if (!validAppName(appName) && servedUrl && !validUrl(servedUrl)) {
      showError('Invalid app url - please correct the app url or leave blank if not needed')
    } else {
      freezerRestricted.menu.resetDialogueBox(true)
      freezerRestricted.connect.ask('/v1/account/app_install_blank', { app_name: appName, served_url: servedUrl, app_display_name: displayName }, function (error, returndata) {
        // onsole.log(returndata)
        returndata.isBlankOfflineApp = true
        if (error || (returndata && returndata.err)) {
          writeErrorsToFreezrDialogue(returndata)
        } else {
          ShowAppUploadErrors(returndata.flags, 'addBlankApp', uploadSuccess)
        }
      })
    }
  },
  updateApp: function (args) {
    userHasIntiatedAcions = true
    window.scrollTo(0, 0)
    freezerRestricted.menu.resetDialogueBox(true)
    document.getElementById('freezer_dialogue_closeButt').style.display = 'none'
    document.getElementById('freezer_dialogue_homeButt').style.display = 'none'
    document.getElementById('freezer_dialogueScreen').onclick = null
    freezerRestricted.connect.ask('/v1/account/appMgmtActions.json', { action: 'updateApp', app_name: args[0] }, function (error, returndata) {
      document.getElementById('freezer_dialogue_closeButt').style.display = 'block'
      document.getElementById('freezer_dialogue_homeButt').style.display = 'block'
      console.log('error' + JSON.stringify(error))
      if (error || returndata.error || returndata.errors) {
        if (error) returndata.error = JSON.stringify(error)
        if (!returndata.error) returndata.error = returndata.errors[0].text
        if (document.getElementById('freezer_dialogueInnerText')) document.getElementById('freezer_dialogueInnerText').innerHTML = '<br/>' + JSON.stringify(returndata.error)
      } else {
        ShowAppUploadErrors(returndata, 'updateApp', showDevOptions)
      }
      buttons.updateAppList()
    })
  },
  genAppPassword: function (args, elClicked) {
    const noticeDiv = document.getElementById('perms_dialogue')
    const rect = elClicked.getBoundingClientRect()
    noticeDiv.style.left = (rect.left) + 'px'
    noticeDiv.style.width = (window.innerWidth - (2 * rect.left) + 50) + 'px'
    noticeDiv.style.top = (rect.top + window.scrollY - 15) + 'px'
    noticeDiv.style.display = 'block'
    document.getElementById('spinner').style.display = 'block'
    document.getElementById('perms_text').style.display = 'none'
    document.getElementById('numdaysvalid').value = DEFAULT_EXPIRY_DAYS
    document.getElementById('one_device').checked = false
    document.getElementById('appNameForApp').innerHTML = args[0]
    document.getElementById('perm_warning').style.display = 'none'
    document.getElementById('button_savePermsChanges').style.display = 'none'
    elClicked.parentElement.style = 'padding-bottom:60px'

    const didChange = function () { document.getElementById('button_savePermsChanges').style.display = 'block' }
    document.getElementById('numdaysvalid').onchange = didChange
    document.getElementById('numdaysvalid').oninput = didChange
    document.getElementById('one_device').onchange = didChange

    const appName = args[0]
    let expiry = new Date().getTime()
    expiry += DEFAULT_EXPIRY_DAYS * 24 * 3600 * 1000
    const oneDevice = false
    const options = { app_name: appName, expiry, one_device: oneDevice }

    const url = '/v1/account/apppassword/generate'
    // onsole.log('sending genAppPassword options',options)

    freezerRestricted.connect.read(url, options, (error, resp) => {
      resp = freezr.utils.parse(resp)
      // onsole.log(resp)
      if (error) console.warn(error)
      document.getElementById('spinner').style.display = 'none'
      document.getElementById('appPasswordForApp').innerHTML = resp.app_password
      document.getElementById('appAuthUrlForApp').innerHTML = freezrMeta.serverAddress + '?user=' + freezrMeta.userId + '&password=' + resp.app_password
      document.getElementById('perms_text').style.display = 'block'
    })
  },
  closePermsDialogue: function () {
    document.getElementById('perms_dialogue').style.display = 'none'
  },
  savePermsChanges: function () {
    let expiry = new Date().getTime()
    expiry += parseInt(document.getElementById('numdaysvalid').value) * 24 * 3600 * 1000
    const oneDevice = document.getElementById('one_device').checked
    const appName = document.getElementById('appNameForApp').innerText
    const password = document.getElementById('appPasswordForApp').innerText
    const options = { app_name: appName, expiry, one_device: oneDevice, password }
    const url = '/v1/account/apppassword/updateparams'

    // onsole.log('sending savePermsChanges options',options)
    freezerRestricted.connect.read(url, options, (error, resp) => {
      resp = freezr.utils.parse(resp)
      // onsole.log(resp)
      if (error) console.warn(error)
      document.getElementById('button_savePermsChanges').style.display = 'none'
      document.getElementById('perm_warning').style.display = 'block'
      document.getElementById('perm_warning').innerHTML = (resp.success ? 'Changes were saved successfully' : 'There was an error saving your changes. Try again later')
      setTimeout(function () { document.getElementById('perm_warning').style.display = 'none' }, 15000)
    })
    // save changes to perm
    // make sure cookie toggle works
    // copytext do
  },
  gotoAppData: function (args) {
    const url = '/account/appdata/' + args[0] + '/view'
    window.open(url, '_self')
  },
  gotoAppPerms: function (args) {
    const url = '/account/perms/' + args[0]
    window.open(url, '_self')
  },
  addAppInFolder: function () {
    userHasIntiatedAcions = true
    const appName = document.getElementById('appNameFromFolder').value
    if (!appName) {
      showError('Please enter an app name')
    } else {
      buttons.updateApp([appName])
    }
  },
  updateAppList: function () {
    freezr.utils.getAllAppList(function (error, returndata) {
      const theData = returndata
      const theEl = document.getElementById('app_list')
      if (!theData) {
        theEl.innerHTML = 'No Apps have been installed'
      } else if (error || theData.err || theData.error) {
        console.warn(error)
        theEl.innerHTML = 'ERROR RETRIEVING APP LIST'
      } else {
        freezr.utils.getHtml('app_mgmt_list.html', null, function (error, theHtml) {
          if (error) console.warn(error)
          theEl.innerHTML = Mustache.to_html(theHtml, theData)
          const imglist = document.getElementsByClassName('logo_img')
          const imglistener = function (evt) {
            this.src = '/app_files/info.freezr.public/public/static/freezer_logo_empty.png'
            this.removeEventListener('error', imglistener)
          }
          for (let i = 0; i < imglist.length; i++) {
            imglist[i].addEventListener('error', imglistener)
          }
          const wipels = document.getElementsByClassName('installdate')
          for (let i = 0; i < wipels.length; i++) {
            const lapseMinutes = ((new Date().getTime()) - Number(wipels[i].innerText)) / (1000 * 60)
            if (lapseMinutes < 60) {
              wipels[i].innerText = 'Installation commenced ' + Math.round(lapseMinutes) + ' minutes ago.'
            } else {
              wipels[i].style.color = 'indianred'
              wipels[i].style.emphasis = 'bold'
              wipels[i].innerText = 'There seems to be an error. ' + Math.round(lapseMinutes / 60) + 'hours have passed since installation started. You may want to try re-installing the app.'
            }
          }
          if (doShowDevoptions && freezrMeta.adminUser) Array.prototype.forEach.call(document.getElementsByClassName('dev_option'), function (el, index) { el.style.display = 'block' })
        })
      }
    })
  },
  chooseFile: function () {
    // document.getElementById('buttons_uploadZipFileApp').style.display ='block'
    document.getElementById('app_zipfile2').click()
    document.getElementById('button_uploadZipFileApp').style.display = 'block'
  },
  closeMenu: function () {
    freezr.utils.freezrMenuClose()
    // setTimeout(function () {freezerRestricted.menu.resetDialogueBox(true)},300)
  }

}

const ShowAppUploadErrors = function (theData, type, callFwd) {
  freezr.utils.getHtml('uploaderrors.html', null, function (error, theHtml) {
    if (error) console.warn(error)

    const theEl = document.getElementById('freezer_dialogueInnerText')
    try {
      // onsole.log({ theHtml,theData })
      theEl.innerHTML = Mustache.to_html(theHtml, theData)
      if (type === 'addBlankApp') {
        document.getElementById('button_closeMenu_1').style.display = 'block'
        document.getElementById('finalise_outer').style.display = 'none'
      }
    } catch (e) {
      console.warn('mustache failed', e)
      theEl.innerHTML = JSON.stringify(theData)
    }
    if (callFwd) callFwd()
  })
}

const uploadSuccess = function () {
  buttons.updateAppList()
  // document.getElementById('freezer_dialogue_extra_title').innerHTML='Finalize Installation and Launch'.'
  // document.getElementById('freezer_dialogue_extra_title').onclick=function () {buttons.goto}
}
const removeAppCallback = function (error, data) {
  data = freezerRestricted.utils.parse(data)
  window.scrollTo(0, 0)
  if (error || data.error) {
    console.warn({ error, data })
    showError('Error removing app')
  } else if (!data || !data.success) {
    showError('Could not connect to server')
  } else {
    showError('The app was removed from your home page. Scroll down to "removed apps" section below to re-install or to delete completely.')
    buttons.updateAppList()
  }
}
const deleteAppCallback = function (error, data) {
  data = freezerRestricted.utils.parse(data)
  window.scrollTo(0, 0)
  if (error) {
    showError('Error: ' + error.message)
  } else if (!data) {
    showError('Could not connect to server')
  } else if (data && data.other_data_exists) {
    showError('Your data was deleted. But the app cannot be removed until other users have also deleted ther data.')
  } else {
    showError('The app was deleted.')
    buttons.updateAppList()
  }
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

const writeErrorsToFreezrDialogue = function (data) {
  const el = document.getElementById('freezer_dialogueInnerText')
  el.innerHTML = '<br/><h1>Error: Could not install app</h1><br/>'

  if (data.flags && data.flags.errors) {
    data.flags.errors.forEach((aflag) => {
      el.innerHTML += aflag.text + ' (' + aflag.function + ') <br/>'
    })
  }

  if (data.err) el.innerHTML += '<br/>(' + JSON.stringify(data.err) + ')'
}

const validUrl = function (appName) {
  if (!appName) return false
  if (appName.length < 1) return false
  if (!startsWithOneOf(appName, ['/', 'https://', 'http://'])) return false
  if (appName.indexOf('/oapp/') < -1) return false
  return true
}
const validAppName = function (appName) {
  if (!appName) return false
  if (appName.length < 1) return false
  if (!validFilename(appName)) return false
  if (startsWithOneOf(appName, ['.', '-', '\\', 'system'])) return false
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
  const appSegements = appName.split('.')
  if (appSegements.length < 3) return false
  return true
}
const validFilename = function (fn) {
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
const SYSTEM_APPS = ['info.freezr.account', 'info.freezr.admin', 'info.freezr.public', 'info.freezr.permissions', 'info.freezr.posts']
function getAppFromUrl (aUrl) {
  let appName = aUrl
  if (startsWith(aUrl, 'https://github.com/')) {
    appName = appName.replace('https://github.com/', '')
    appName = appName.slice(appName.indexOf('/') + 1)
    if (appName.indexOf('/') > -1) appName = appName.slice(0, appName.indexOf('/'))
  } else {
    appName = appName.slice(appName.lastIndexOf('/') + 1)
    if (appName.indexOf('.zip') > -1) appName = appName.slice(0, appName.indexOf('.zip'))
  }
  return appName
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
  userHasIntiatedAcions = true

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
    document.getElementById('errorBox').innerHTML = 'Please upload one zip file only.'
  } else if (ext !== 'zip') {
    document.getElementById('errorBox').innerHTML = 'The app file uploaded must be a zipped file. (File name represents the app name.)'
  } else if (!validAppName(appName)) {
    document.getElementById('errorBox').innerHTML = 'Invalid app name - please make sure the zip file conforms to freezr app name guidelines'
  } else {
    const uploadData = new FormData()
    uploadData.append('file', file)
    uploadData.append('app_name', appName)
    const url = '/v1/account/app_install_from_zipfile.json'
    freezerRestricted.menu.resetDialogueBox(true)
    if (file.size > 500000) document.getElementById('freezer_dialogueInnerText').innerHTML = '<br/>You are uploading a large file. This might take a little while. Please be patient.<br/>' + document.getElementById('freezer_dialogueInnerText').innerHTML
    freezerRestricted.connect.send(url, uploadData, function (error, returndata) {
      const d = freezr.utils.parse(returndata)
      if (error || d.err) {
        writeErrorsToFreezrDialogue(d)
      } else {
        ShowAppUploadErrors(d.flags, 'uploadZipFileApp', uploadSuccess)
      }
    }, 'PUT', null)
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
  const target = e.target
  if (!target.className.includes('drop-area')) {
    target = target.parentElement
  }
  if (!target.className.includes('drop-area')) console.log('akkkhhh - should iterate')
  return target
}
