// freezr  firstSetUp

/* global thisPage, userId, freezr, freezrServerStatus, freezrEnvironment, freezerRestricted , ENV_PARAMS */
// thisPage is passed as 'firstSetUp' or unRegisteredUser (when self-registering) or newParams when registered but user doesnt have fs  and db params defined

freezr.initPageScripts = function () {
  const fstype = (freezrEnvironment && freezrEnvironment.fsParams) ? (freezrEnvironment.fsParams.choice || freezrEnvironment.fsParams.type) : null
  const dbtype = (freezrEnvironment && freezrEnvironment.dbParams) ? (freezrEnvironment.dbParams.choice || freezrEnvironment.dbParams.type) : null
  createSelector('FS', fstype)
  createSelector('DB', dbtype)
  hideDivs(['click_goAuthFS', 'click_showOauthOptions', 'oauth_elements_FS'])

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

  hideClass('freezr_hiders')
  showClass(thisPage)
  hideDiv('errorBox')

  if (thisPage === 'firstSetUp') {
    document.getElementById('password2').addEventListener('keypress', function (e) { if (e.keyCode === 13) launch() })
  } else if (thisPage === 'newParams') {
    document.getElementById('loggedInUserId').innerText = userId
  }
  // add oauth issues here
  populateErrorMessage(freezrServerStatus, true)

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
  window.history.pushState({ }, 'Freezr - set up', '/admin/' + (thisPage === 'firstSetUp' ? 'firstSetUp' : 'selfRegister'))

  setTimeout(function () { window.scrollTo({ top: 0, behavior: 'smooth' }) }, 10)
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
    if (resource === 'FS' && choice === 'local' && document.location.host.includes('localhost')) document.getElementById('warning_' + resource).innerHTML = ''
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
      document.getElementById('warning_' + resource).innerText = ''
      if (params.fields && params.fields.length > 0) {
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
          input.setAttribute('size', '40')
          input.setAttribute('name', (choice + '_' + item.name))
          input.id = choice + '_' + item.name
          col2.appendChild(input)
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
    window.history.pushState({ }, 'Freezr - set up', '/admin/selfRegister')
    window.localStorage.removeItem('params')
    return false
  } else {
    window.localStorage.removeItem('params')
    return false
  }
}
const checkResource = function (resource, options, callback) {
  showError('checking ' + (resource === 'DB' ? 'database' : 'file system') + ' . . .')
  if (!callback) callback = gotCheckStatus
  const [err, choice, params] = getFormData(resource)
  if (err) {
    showError(err)
  } else if (choice === 'sysDefault') {
    showError('Cannot test system defaults')
  } else if (thisPage !== 'firstSetUp' && resource === 'DB' && choice === 'nedb' && document.getElementById('selector_FS').value === 'local') {
    showError('Cannot check nedb with local file system (except when setting up the system)')
  } else {
    var toSend = { resource, env: {}, action: 'checkresource' }
    toSend.env[(resource === 'FS' ? 'fsParams' : 'dbParams')] = params
    if (resource === 'DB' && params.type === 'nedb') {
      const [, , fsParams] = getFormData('FS')
      toSend.env.fsParams = fsParams
    }

    if (options && options.getRefreshToken) toSend.getRefreshToken = true

    freezerRestricted.connect.send('/v1/admin/self_register', JSON.stringify(toSend), callback, 'POST', 'application/json')
  }
}

function gotCheckStatus (err, data) {
  // if (err || (data && data.err) || (data && !data.checkpassed))
  // onsole.log('gotCheckStatus ', { err, data })
  if (err) {
    showError(err.message)
  } else if (data.err) {
    showError(data.err)
  } else if (!data.checkpassed) {
    showError('Unsuccessful attempt to check ' + (data.resource === 'FS' ? 'file system.' : 'database.'))
  } else {
    showError('Your ' + (data.resource === 'FS' ? 'file system' : 'database') + ' works!')
  }
}

const getAllFormsData = function () {
  const [fsErr, , fsParams] = getFormData('FS')
  const [dbErr, , dbParams] = getFormData('DB')
  var ids = {}
  if (['firstSetUp', 'unRegisteredUser'].includes(thisPage)) {
    const ID_LIST = ['userId', 'password', 'password2']
    ID_LIST.forEach(item => {
      ids[item] = document.getElementById(item).value
    })
  } else {
    ids.userId = userId
  }
  return { fsErr, fsParams, dbErr, dbParams, ids }
}

const launch = function () {
  showError('Checking paramdeters to launch freezr. . . . ')
  const { fsErr, fsParams, dbErr, dbParams, ids } = getAllFormsData()
  /*
  const [fsErr, , fsParams] = getFormData('FS')
  const [dbErr, , dbParams] = getFormData('DB')
  var ids = {}
  if (['firstSetUp', 'unRegisteredUser'].includes(thisPage)) {
    const ID_LIST = ['userId', 'password', 'password2']
    ID_LIST.forEach(item => {
      ids[item] = document.getElementById(item).value
    })
  } else {
    ids.userId = userId
  }
  */

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
  } else {
    showError('')
    var theInfo = { action: thisPage, userId: ids.userId, password: ids.password, env: { fsParams, dbParams } }
    // freezerRestricted.menu.resetDialogueBox(true);
    document.getElementById('click_launch').style.display = 'none'
    document.getElementById('launch_spinner').style.display = 'block'
    freezerRestricted.connect.send('/v1/admin/self_register', JSON.stringify(theInfo), gotRegisterStatus, 'POST', 'application/json')
  }
}

const gotRegisterStatus = function (error, data) {
  //onsole.log(error, data)
  if (error || !data) {
    document.getElementById('click_launch').style.display = 'block'
    document.getElementById('launch_spinner').style.display = 'none'
    showError(error ? ('Error: ' + error.message) : 'No data was sent ferom server - refresh to see status')
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
  var inner = ''
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
var showError = function (errorText) {
  var errorBox = document.getElementById('errorBox')
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
  for (var i = 0; i < els.length; i++) {
    els[i].style.display = 'none'
  }
}
const showClass = function (theClass) {
  const els = document.getElementsByClassName(theClass)
  for (var i = 0; i < els.length; i++) {
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
