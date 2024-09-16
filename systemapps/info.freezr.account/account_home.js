// freezr Accunts page

/* global freezr, freezrMeta, freezerRestricted, FormData */

freezr.initPageScripts = function () {
  document.addEventListener('click', function (evt) {
    if (evt.target.id && freezr.utils.startsWith(evt.target.id, 'button_')) {
      const parts = evt.target.id.split('_')
      const args = evt.target.id.split('_')
      args.splice(0, 2).join('_')
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

  setTimeout(function () {
    const imglist = document.getElementsByClassName('fBoxImg')
    for (let i = 0; i < imglist.length; i++) {
      if (!imglist[i].complete || imglist[i].naturalHeight === 0) imglist[i].src = '/app_files/info.freezr.public/public/static/freezer_logo_empty.png'
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

const buttons = {
  tabs: function (args) {
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
    buttons.tabs(['download'])
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
      document.getElementById('tabDownloadInner').style.display = 'none'
      document.getElementById('installingAppViaUrl').style.display = 'block'
      document.getElementById('installingAppViaUrlAppName').innerText = appName

      appUrl = normliseGithubUrl(appUrl)
      freezerRestricted.connect.ask('/v1/account/app_install_from_url.json', { app_url: appUrl, app_name: appName }, function (error, returndata) {
        if (error || returndata.error) {
          console.warn({ error, returndata })
          showError((error ? (error.message || 'error installing 3.') : returndata.error))
          document.getElementById('tabDownloadInner').style.display = 'block'
          document.getElementById('installingAppViaUrl').style.display = 'none'
        } else {
          installSuccessProcess(returndata)
        }
      })
    }
  },
  chooseFile: function () {
    document.getElementById('app_zipfile2').click()
    document.getElementById('app_zipfile2').style.display = 'block'
    document.getElementById('button_uploadZipFileApp').style.display = 'block'
  },
  uploadZipFileApp: function (args) { // OLD STYLE UPLOAD
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
        document.getElementById('errorBox').innerHTML = 'The app file uploaded must be a zipped file. (File name represents the app name.)'
      } else if (!isValidAppName(appName)) {
        document.getElementById('errorBox').innerHTML = 'Invalid app name - please make sure the zip file conforms to freezr app name guidelines'
      } else {
        const uploadData = new FormData()
        uploadData.append('file', file)
        uploadData.append('app_name', appName)
        const url = '/v1/account/app_install_from_zipfile.json'

        if (file.size > 1000000) showError('You are uploading a large file. This might take a little while. Please be patient.')
        freezerRestricted.connect.send(url, uploadData, function (error, returndata) {
          if (error) {
            console.warn({ error, returndata })
            showError(error.message || error.code || 'Error installing 1.')
          } else if (returndata?.error) {
            showError(returndata.error || 'Error installing 2.')
          } else {
            installSuccessProcess(returndata)
          }
        }, 'PUT', null, { uploadFile: true })
      }
    }
  },
  addBlankApp: function () {
    const appName = document.getElementById('appNameForBlankApp').innerText
    const servedUrl = document.getElementById('appUrlForBlankApp').innerText || null
    const displayName = document.getElementById('appDisplayNameForBlankApp').innerText || null
    // later grab logo and manifest to populate...

    if (!isValidAppName(appName) && !servedUrl) {
      showError('Invalid app name - please correct the app name')
    } else if (!isValidAppName(appName) && servedUrl && !isValidUrl(servedUrl)) {
      showError('Invalid app url - please correct the app url or leave blank if not needed')
    } else {
      freezerRestricted.connect.ask('/v1/account/app_install_blank', { app_name: appName, served_url: servedUrl, app_display_name: displayName }, function (error, returndata) {
        if (error || returndata.error) {
          console.warn({ error, returndata })
          showError('Error updating app!' + (error ? error.message : returndata.error))
        } else {
          installSuccessProcess(returndata)
        }
      })
    }
  },
  addAppInFolder: function () {
    const appName = document.getElementById('appNameFromFolder').innerText
    if (!appName) {
      showError('Please enter an app name')
    } else if (!isValidAppName(appName)) {
      showError('Invalid app name - please correct the app name')
    } else {
      freezerRestricted.connect.ask('/v1/account/appMgmtActions.json', { action: 'updateApp', app_name: appName }, function (error, returndata) {
        if (error || returndata.error || returndata.errors) {
          console.warn({ error, returndata })
          showError('Error updating app!' + (error ? error.message : returndata.error))
        } else {
          installSuccessProcess(returndata)
        }
      })
    }
  }
}
const installSuccessProcess = function (returndata) {
  const appName = returndata?.flags?.meta?.app_name || returndata?.meta?.app_name
  const sentencefromreturndata = function (returndata) {
    const wasUpdate = returndata?.flags?.meta?.didwhat === 'updated'
    const sentence = appName + ' was successfully ' + (wasUpdate ? 'updated' : 'created') + '.'
    return sentence
  }
  if (appName) {
    window.open('/account/app/settings/' + appName + '?message=' + sentencefromreturndata(returndata), '_self')
  } else {
    showError('Could not get appname!! ??')
  }
}
const isValidUrl = function (appName) {
  if (!appName) return false
  if (appName.length < 1) return false
  if (!startsWithOneOf(appName, ['/', 'https://', 'http://'])) return false
  if (appName.indexOf('/oapp/') < -1) return false
  return true
}
const isValidAppName = function (appName) {
  if (!appName) return false
  if (appName.length < 1) return false
  if (!isValidFilename(appName)) return false
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
    document.getElementById('errorBox').innerHTML = 'Please upload one zip file only.'
  } else if (ext !== 'zip') {
    document.getElementById('errorBox').innerHTML = 'The app file uploaded must be a zipped file. (File name represents the app name.)'
  } else if (!isValidAppName(appName)) {
    document.getElementById('errorBox').innerHTML = 'Invalid app name - please make sure the zip file conforms to freezr app name guidelines'
  } else {
    const uploadData = new FormData()
    uploadData.append('file', file)
    uploadData.append('app_name', appName)
    const url = '/v1/account/app_install_from_zipfile.json'
    freezerRestricted.menu.resetDialogueBox(true)
    if (file.size > 1000000) showError('You are uploading a large file. This might take a little while. Please be patient.')
    freezerRestricted.connect.send(url, uploadData, function (error, returndata) {
      if (error || returndata.error) {
        console.warn({ error, returndata })
        showError((error ? error.message : returndata.error))
      } else {
        installSuccessProcess(returndata)
      }
    }, 'PUT', null, { uploadFile: true })
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

// Utility
let timer = null
const showError = function (errorText) {
  clearTimeout(timer)
  const errorBox = document.getElementById('errorBox')
  errorBox.style['font-size'] = '24px'
  errorBox.innerHTML = errorText || ' &nbsp '
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
