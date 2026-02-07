// freezr  firstSetUp

/* global thisPage, userId, freezr, freezrServerStatus, freezrEnvironment, freezerRestricted , ENV_PARAMS, freezrSelfRegOptions */
// thisPage is passed as 'firstSetUp' or unRegisteredUser (when self-registering) or newParams when registered but user doesnt have fs  and db params defined

freezr.initPageScripts = function () {
  // if (!document.location.host.includes('localhost')) delete ENV_PARAMS.FS.local
  // onsole.log(isSimpleRegPage(), { thisPage })

  if (!isSimpleRegPage()) {
    const fstype = thisPage === 'firstSetUp' ? 'sysDefault' : ((freezrEnvironment && freezrEnvironment.fsParams) ? (freezrEnvironment.fsParams.choice || freezrEnvironment.fsParams.type) : null)
    const dbtype = thisPage === 'firstSetUp' ? 'sysDefault' : ((freezrEnvironment && freezrEnvironment.dbParams) ? (freezrEnvironment.dbParams.choice || freezrEnvironment.dbParams.type) : null)
    createSelector('FS', fstype)
    createSelector('DB', dbtype)
    hideDivs(['click_goAuthFS', 'click_showOauthOptions', 'oauth_elements_FS'])
    hideClass('freezr_hiders')
    showClass(thisPage)
  } else {
    document.getElementById('freezer_img_button').style.display = 'none'
    if (!freezrSelfRegOptions.allow || !freezrSelfRegOptions.allowAccessToSysFsDb) window.location = '/register/self'
    document.getElementById('storageCapacity').innerHTML = '(' + freezrSelfRegOptions.defaultMBStorageLimit + 'MBs)'
    if (simplePageAutoInstallApp()) {
      document.getElementById('appInatllMessage').innerHTML = 'Launching freezr will register you as a user. You can then accept to install ' + simplePageAutoInstallApp()
    }
  }

  hideDiv('errorBox')

  document.addEventListener('click', function (evt) {
    const args = evt.target.id.split('_')
    if (args && args.length > 1 && args[0] === 'click') {
      switch (args[1]) {
        case 'launch':
          launch()
          break
        case 'checkResource':
          checkResource(args[2])
          break
        case 'goAuthFS':
          goAuthFS()
          break
        case 'showOauthOptions':
          hideDiv('click_showOauthOptions')
          showDivs(['table_elements_FS', 'oauth_elements_FS'])
          break
        default:
          console.warn('undefined click ?')
          break
      }
    }
  })

  if (thisPage === 'firstSetUp') {
    document.getElementById('password2').addEventListener('keypress', function (e) { if (e.keyCode === 13) launch() })
  } else if (thisPage === 'newParams') {
    document.getElementById('loggedInUserId').innerText = userId
  }
  // add oauth issues here
  populateErrorMessage(freezrStatus, true)

  const gotAuthValidation = populateFormsFromParams()
  // see if has done oauth and if so, give error if no state
  if (gotAuthValidation) {
    window.localStorage.removeItem('params')
    document.getElementById('warning_FS').innerText = ' You were authenticated! Now choose your database and you are good to go.'
    hideDiv('click_goAuthFS')
    hideDiv('table_elements_FS')

    /* old version delete after adjusting dropbox
    checkResource('FS', { getRefreshToken: true }, function (err, data) {
      if (err || !data.checkpassed) {
        showError('the authentication process failed. ' + ((err && err.error) ? err.error : ''))
      } else {
        if (data && data.refreshToken) {
          const choice = document.getElementById('selector_FS').value
          const formField = document.getElementById(choice + '_refreshToken')
          formField.value = data.refreshToken
        }
        document.getElementById('warning_FS').innerText = ' You were authenticated! Now choose your database and you are good to go.'
        hideDiv('click_goAuthFS')
        hideDiv('table_elements_FS')
      }
      window.localStorage.removeItem('params')
    })
    */
  }
  if (!isSimpleRegPage()) window.history.pushState({ }, 'Freezr - set up', '/register/' + (thisPage === 'firstSetUp' ? 'firstSetUp' : 'self'))

  setTimeout(function () { window.scrollTo({ top: 0, behavior: 'smooth' }) }, 10)
}

const isSimpleRegPage = function () {
  return (window.location.pathname.toLocaleLowerCase() === '/register/simple')
}

function simplePageAutoInstallApp () {
  if (!isSimpleRegPage()) return null
  const searchParams = new URLSearchParams(window.location.search)
  if (!searchParams.get('autoInstallUrl')) return null
  return searchParams.get('autoInstallApp')
}

const createSelector = function (resource, choice) {
  /// todo - save previous values
  const selector = document.getElementById('selector_' + resource)
  selector.innerHTML = ''
  for (const [key, params] of Object.entries(ENV_PARAMS[resource])) {
    if (params.forPages.includes(thisPage)) {
      const option = document.createElement('option')
      option.setAttribute('value', key)
      option.innerHTML = params.label
      selector.appendChild(option)
    }
  }
  selector.value = choice
  changeSelector(resource)
  document.getElementById('selector_' + resource).onchange = function () { changeSelector(resource) }
}

const changeSelector = function (resource) {
  const choice = document.getElementById('selector_' + resource).value
  if (!choice) {
    showError('Please choose an item')
  } else {
    const params = ENV_PARAMS[resource][choice]
    document.getElementById('msg_' + resource).innerHTML = params.msg || ''
    document.getElementById('warning_' + resource).innerHTML = params.warning || ''
    if (resource === 'FS' && choice === 'sysDefault' && thisPage === 'firstSetUp') {
      document.getElementById('msg_FS').innerHTML = 'The system will be using the file system from ' + (freezrEnvironment?.fsParams?.choice || (freezrEnvironment?.fsParams?.type || '(error reading choice)')) 
      document.getElementById('warning_FS').innerHTML = (freezrEnvironment?.fsParams?.choice === 'localFileSystem' && !document.location.host.includes('localhost')) ? 'Note that most cloud servers delete their local file system when they restart - ie periodically. Make sure you know what you are doing when you choose this option.' : ''
    }
    const tabletop = document.getElementById('table_elements_' + resource)
    tabletop.innerHTML = ''
    const lowcapres = resource.toLowerCase()
    if (freezrEnvironment && freezrEnvironment[lowcapres + 'Params'] &&
      freezrEnvironment[lowcapres + 'Params'].TokenIsOnServer &&
      freezrEnvironment[lowcapres + 'Params'].type === choice) {
      document.getElementById('warning_' + resource).innerText = 'Your server has sent you authentication information for ' + freezrEnvironment[lowcapres + 'Params'].type
      hideDiv('click_goAuth' + resource)
      hideDiv('table_elements_' + resource)
      hideDiv('oauth_elements_' + resource)
    } else {
      if (params.fields && params.fields.length > 0) {
        document.getElementById('warning_' + resource).innerText = ''
        const table = document.createElement('table')
        params.fields.forEach(item => {
          const row = document.createElement('tr')
          const col1 = document.createElement('td')
          col1.setAttribute('width', '150px')
          col1.setAttribute('align', 'right')
          col1.innerHTML = item.display
          row.appendChild(col1)
          const col2 = document.createElement('td')
          col2.setAttribute('width', '220px')
          const input = document.createElement('input')
          input.setAttribute('type', (item.type || 'text'))
          input.className = 'inputbox'
          input.setAttribute('name', (choice + '_' + item.name))
          input.id = choice + '_' + item.name
          if (item.default) input.value = item.default
          col2.appendChild(input)
          if (item.hide) row.style.display = 'none'
          row.appendChild(col2)
          // if (item.show === 'hide') row.style = 'display: none'
          table.appendChild(row)
        })
        tabletop.appendChild(table)
      }
      if (resource === 'FS') {
        if (params.oauth) {
          showDivs(['click_goAuthFS', 'click_showOauthOptions'])
          hideDivs(['table_elements_FS', 'oauth_elements_FS'])
        } else {
          hideDivs(['click_goAuthFS', 'click_showOauthOptions', 'oauth_elements_FS'])
          showDivs(['table_elements_FS'])
        }
      }
    }
  }
}
const getFormData = function (resource) {
  const choice = document.getElementById('selector_' + resource).value
  let err = choice ? '' : 'Nothing selected'
  if (choice) {
    const type = ENV_PARAMS[resource][choice].type
    const params = { type, choice }
    const lowcapres = resource.toLowerCase()

    if (freezrEnvironment && freezrEnvironment[lowcapres + 'Params'] &&
      freezrEnvironment[lowcapres + 'Params'].TokenIsOnServer &&
      freezrEnvironment[lowcapres + 'Params'].type === choice) {
      params.useServerToken = true
    } else {
      const fields = ENV_PARAMS[resource][choice].fields
      if (fields && fields.length > 0) {
        fields.forEach((item) => {
          const input = document.getElementById(choice + '_' + item.name)
          if (input && input.value && input.value.trim() !== '') {
            params[item.name] = input.value
          } else if (!item.optional) {
            err += (err ? ',' : 'Missing parameter: ') + item.name
          }
        })
      }
    }
    return [err, choice, params]
  } else {
    showError('Choose an ' + resource + ' first.')
    return ['Nothing chosen', choice, null]
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

  if (regcode && storedParams && regcode === storedParams.regcode && storedParams.fsParams.type === type) {
    ['code', 'accessToken', 'clientId', 'codeChallenge', 'codeVerifier', 'redirecturi', 'refreshToken', 'expiry', 'secret'].forEach(key => {
      const value = urlQueries.get(key)
      if (value && value !== 'null') {
        storedParams.fsParams[key] = value
      }
    })

    if (storedParams) {
      ['FS', 'DB'].forEach(resource => {
        const resourceParamWord = resource.toLowerCase() + 'Params'
        const thisParams = storedParams[resourceParamWord]
        const choice = (thisParams && thisParams.choice) ? thisParams.choice : null
        if (choice) {
          document.getElementById('selector_' + resource).value = choice
          changeSelector(resource)
          for (const [key, details] of Object.entries(thisParams)) {
            const formField = document.getElementById(choice + '_' + key)
            if (formField) formField.value = details
          }
        } else {
          console.warn('nothing chosen')
        }
      })

      const ID_LIST = ['userId', 'password', 'password2']
      ID_LIST.forEach(item => {
        document.getElementById(item).value = (storedParams.ids[item] || '')
      })

      window.localStorage.removeItem('params')

      return true
    }
  } else if (regcode) {
    window.localStorage.removeItem('params')
    showError('Inrternal Error - url parameters are NOT matching - please retry ')
    window.history.pushState({ }, 'Freezr - set up', '/register/self')
    window.localStorage.removeItem('params')
    return false
  } else {
    window.localStorage.removeItem('params')
    return false
  }
}
const longFormOf = function (resource) {
  return (resource === 'DB' ? 'database' : (resource === 'FS' ? 'file system' : 'system'))
}
const checkResource = async function (resource, options, callback) {
  showError('checking ' + longFormOf(resource) + ' . . .')
  if (!callback) callback = gotCheckStatus
  const [err, choice, params] = getFormData(resource)
  console.log({ resource, options, callback, err, choice, params })

  if (err) {
    showError(err)
    return
  } else if (thisPage !== 'firstSetUp' && choice === 'sysDefault') {
    showError('Cannot check nedb with host default or local systems (except during first set up.')
    return
  } else {
    const toSend = { resource, env: {}, action: 'checkresource' }
    toSend.env[(resource === 'FS' ? 'fsParams' : 'dbParams')] = params
    if (params.choice === 'sysDefault' && thisPage === 'firstSetUp') {
      toSend.env.fsParams = freezrEnvironment.fsParams
      toSend.env.dbParams = freezrEnvironment.dbParams
    } else if (resource === 'DB' && params.type === 'nedb') {
      const [, , fsParams] = getFormData('FS')
      if (fsParams.choice === 'sysDefault' && thisPage !== 'firstSetUp') {
        showError('Cannot check nedb with local file system (except when setting up the system)')
        return
      }
      toSend.env.fsParams = fsParams
    }

    if (options && options.getRefreshToken) toSend.getRefreshToken = true

    try {
      const data = await freezr.apiRequest('POST', '/register/api/checkresource', toSend)
      callback(null, data)
    } catch (error) {
      callback(error, null)
    }
  }
}

function gotCheckStatus (err, data) {
  // if (err || (data && data.err) || (data && !data.checkpassed))
  console.log('gotCheckStatus ', { err, data })
  if (err || data.err) {
    showError('Sorry but your ' + longFormOf(data?.resource) + " doesnt seem to be working. Got an error: " + (err?.message || data.err || 'unknown error' ))
  } else if (!data.checkpassed) {
    showError('Unsuccessful attempt to check ' + longFormOf(data.resource) + '. Error - ' + (data?.err || 'Uknown. ;('))
  } else {
    showError('Your ' + (data.resource === 'FS' ? 'file system' : 'database') + ' works!')
  }
}

const getAllFormsData = function () {
  const [fsErr, , fsParams] = isSimpleRegPage() ? [null, null, { type: 'system', choice: 'sysDefault' }] : getFormData('FS')
  const [dbErr, , dbParams] = isSimpleRegPage() ? [null, null, { type: 'system', choice: 'sysDefault' }] : getFormData('DB')

  const ids = {}
  if (['firstSetUp', 'unRegisteredUser'].includes(thisPage)) {
    const ID_LIST = ['userId', 'password', 'password2', 'email']
    ID_LIST.forEach(item => {
      ids[item] = document.getElementById(item).value
    })
  } else {
    ids.userId = userId
  }
  return { fsErr, fsParams, dbErr, dbParams, ids }
}

const launch = async function () {
  showError('Checking paramdeters to launch freezr. . . . ')
  const { fsErr, fsParams, dbErr, dbParams, ids } = getAllFormsData()

  if (fsErr) {
    showError(fsErr)
  } else if (dbErr) {
    showError(dbErr)
  } else if (['firstSetUp', 'unRegisteredUser'].includes(thisPage) && (!ids.userId || !ids.password)) {
    showError('You need a name and password to register and launch')
  } else if (['firstSetUp', 'unRegisteredUser'].includes(thisPage) && (ids.userId.indexOf('_') > -1 || ids.userId.indexOf(' ') > -1 || ids.userId.indexOf('/') > -1)) {
    showError("user id's cannot have '/' or '_' or spaces in them")
  } else if (['firstSetUp', 'unRegisteredUser'].includes(thisPage) && (!ids.password2 || ids.password !== ids.password2)) {
    showError('Passwords have to match')
  } else if (['firstSetUp', 'unRegisteredUser'].includes(thisPage) && ids.email && !isValidEmail(ids.email)) {
    showError('email is not valid')
  } else {
    showError('')
    const theInfo = { action: thisPage, userId: ids.userId, password: ids.password, email: ids.email, env: { fsParams, dbParams } }
    // freezerRestricted.menu.resetDialogueBox(true);
    const sects = ['exp_warn_1', 'exp_warn_2', 'main_form_sections']
    sects.forEach(sect => { if (document.getElementById(sect)) document.getElementById(sect).style.display = 'none' })
    document.getElementById('launch_spinner').style.display = 'block'
    window.scrollTo({ top: 0, behavior: 'smooth' })
    try {
      const data = await freezr.apiRequest('POST', '/register/api/newselfreg', theInfo)
      gotRegisterStatus(null, data)
    } catch (error) {
      gotRegisterStatus(error, null)
    }
  }
}

const gotRegisterStatus = function (error, data) {
  if (error || !data) {
    let message =  'Error - registration unsuccessful. ' + (error ? ('Error: ' + error.message) : '')
    if (error?.message === 'auth-Not-freezrAllowAccessToSysFsDb') message += 'The system does not allow self-registered users to use its file system.'
    if (error && error.message === 'user already exists') message += 'User id is already taken. Try another id'
    document.getElementById('main_form_sections').style.display = 'block'
    document.getElementById('launch_spinner').style.display = 'none'
    showError(message)

  } else if (simplePageAutoInstallApp()) {
    const autoInstallApp = simplePageAutoInstallApp()
    const searchParams = new URLSearchParams(window.location.search)
    const autoInstallUrl = searchParams.get('autoInstallUrl')
    window.location = '/account/app/autoinstall?autoInstallApp=' + autoInstallApp + '&autoInstallUrl=' + autoInstallUrl + '&message=Congratulations - your account has been created. '
  } else {
    window.location = (thisPage === 'firstSetUp' ? '/admin/prefs?firstSetUp=true' : '/account/home?show=welcome&source=' + thisPage)
  }
}

// O-AUTH
const goAuthFS = function () {
  let oauthorUrl = document.getElementById('fs_auth_Server').value
  if (!oauthorUrl) {
    showError('need to enter an authenticator url')
  } else {
    const choice = document.getElementById('selector_FS').value
    const type = ENV_PARAMS.FS[choice].type

    const currentParams = getAllFormsData()

    currentParams.regcode = randomText(20)

    window.localStorage.setItem('params', JSON.stringify(currentParams))

    oauthorUrl = oauthorUrl + '?type=' + type + '&regcode=' + currentParams.regcode + '&sender=' + encodeURIComponent(window.location.origin + window.location.pathname)
    // onsole.log('opening authenticator site as first step in oauth process: ' + oauthorUrl)
    window.open(oauthorUrl, '_self')
  }
}

const populateErrorMessage = function (freezrServerStatus, initial) {
  // onsole.log("freezrServerStatus",freezrServerStatus)
  if (!freezrServerStatus) freezrServerStatus = { fundamentals_okay: true }
  let inner = ''
  if (!freezrServerStatus.fundamentals_okay) {
    inner = '<b>There was a serious issue with your freezr server environement.<br/>'
    if (!freezrServerStatus.can_write_to_user_folder) {
      inner += "The system cannot write on the user folder. This means you can't install any apps permanently. <br/>"
    }
    if (!freezrServerStatus.can_read_write_to_db) {
      inner += 'The system cannot access a database. (Perhaps you need to run mongo.)<br/>'
    }
    inner += 'This need to be fixed to be able to run the system. '
    inner += (initial ? 'Please review your External File System or Database for alternatives' : 'Please try resubmitting credentials.')
    inner += '<br/><br/>'
  }
  inner += (freezrServerStatus.other_errors && freezrServerStatus.other_errors.length > 0) ? ('Other issues' + freezrServerStatus.other_errors.join('<br/>')) : ''

  showError(inner)
}
// Generics
const showError = function (errorText) {
  const errorBox = document.getElementById('errorBox')
  errorBox.innerHTML = errorText
  if (errorText) {
    showDiv('errorBox')
    errorBox.scrollIntoView()
  } else {
    hideDiv('errorBox')
  }
}
const hideClass = function (theClass) {
  const els = document.getElementsByClassName(theClass)
  for (let i = 0; i < els.length; i++) {
    els[i].style.display = 'none'
  }
}
const showClass = function (theClass) {
  const els = document.getElementsByClassName(theClass)
  for (let i = 0; i < els.length; i++) {
    els[i].style.display = 'block'
  }
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
    for (let i = 0; i < theDivs.length; i++) {
      hideDiv(theDivs[i])
    }
  }
}
const showDivs = function (theDivs) {
  if (theDivs && theDivs.length > 0) {
    for (let i = 0; i < theDivs.length; i++) {
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
const isValidEmail = function (aText) {
  return aText && aText.indexOf('@') > 1 && aText.indexOf('@') < aText.indexOf('.') && aText.indexOf('.') < aText.length - 1
}
