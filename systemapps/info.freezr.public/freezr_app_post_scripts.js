// freezr_app_post_scripts.js

// info.freezr.public - updated 2021
/*
  This file is used for stand alone apps that do not run on the freezr server.
  for electron - script file to be included after freezr_app_init.js and manifest.js .
*/
/* global freezr, freezerRestricted, freezrMeta, alert, confirm */

freezr.app.isWebBased = false
document.addEventListener('DOMContentLoaded', function () {
  if (freezr.initPageScripts) freezr.initPageScripts()
})

freezerRestricted.menu.add_standAloneApp_login_dialogue = function (divToInsertInId) {
  var divToInsertIn = document.getElementById(divToInsertInId)

  const introText = freezr.app.offlineCredentialsExpired ? 'Your credentials are expired. Please re-enter your PDS auth URL or press next to enter your password' : 'Log in to freezr or any  <br/> CEPS-compatible Personal Data Store (PDS)'

  var cont = ''
  cont += '<div align="center">'
  cont += '<div id="freezr_server_pds_name_area">'
  cont += '  <div class="freezer_dialogue_topTitle" id="freezr_serverAddress_title" style="padding:20px;" >' + introText + '</div>'
  cont += '    <div><div class="appLogin_name">Paste your PDS authentication url here: </div> <div contenteditable class="appLogin_input" id="freezr_server_name_input" ></div></div>'
  cont += '  <div style="display:inline-block">'
  cont += '     <span class="freezer_butt_pressed freezer_server_butt_notfloat" id="freezr_pingprelogin_butt">next</span>'
  cont += '     <span class="freezer_butt_pressed freezer_server_butt_notfloat" id="freezr_authurl_login_butt">Login</span>'
  cont += '  </div>'
  cont += '</div>'

  cont += '<div id="freezr_server_login_name_area" style="display:none">'
  cont += ' <div id="freezr_login_username_title">Please enter your user name and one-time app password to log into <span id="freezr_server_name_in_loginname_page"></span></div>'
  cont += ' <div id="freezr_login_username_area"><div class="appLogin_name" style="font-weight:bold">User Name: </div> <div contenteditable class="appLogin_input" id="freezr_login_username" >' + (freezrMeta.userId ? freezrMeta.userId : '') + '</div></div>'
  cont += '  <div><div class="appLogin_name" style="font-weight:bold">One-time App Password:<br>(Please get a one time app password from your Personal Server App.) </div><input contenteditable class="appLogin_input" id="freezr_login_pw" type="password"></input></div>'
  cont += '  <br><div style="display:inline-block"><span class="appLogin_name"></span><span class="freezer_butt" id="freezr_server_login_butt">log in to your PDS</span></div>'
  cont += '</div>'
  cont += '<br/>'
  cont += '<div id="freezr_login_message" style="text-align:left"></div>'
  cont += '</div>'
  divToInsertIn.innerHTML = cont

  freezerRestricted.menu.reset_login_butt_colors()
  document.getElementById('freezr_server_name_input').onkeypress = function (evt) {
    freezerRestricted.menu.reset_login_butt_colors()
    if (evt.keyCode === 13) {
      evt.preventDefault()
      freezerRestricted.menu.loginmovesstep1()
    }
  }

  document.getElementById('freezr_server_name_input').onpaste = function (evt) {
    setTimeout(function () {
      evt.target.innerHTML = evt.target.innerText
      freezerRestricted.menu.reset_login_butt_colors()
    }, 5)
  }
  freezerRestricted.menu.loginmovesstep1 = function () {
    const [hasHttp, hasLoginParams, server, userName, authPassword] = freezerRestricted.menu.reset_login_butt_colors()

    if (!hasLoginParams && !hasHttp && !freezrMeta.serverAddress) {
      document.getElementById('freezr_login_message').innerText = 'You have enterred an invalid url.'
    } else {
      if (server) freezrMeta.serverAddress = server
      if (freezrMeta.serverAddress.slice(freezrMeta.serverAddress.length - 1) === '/') freezrMeta.serverAddress = freezrMeta.serverAddress.slice(0, freezrMeta.serverAddress.length - 1)

      const messageDiv = document.getElementById('freezr_login_message')
      messageDiv.innerHTML = '<br/><div align="center">.<img src="freezr/static/ajaxloaderBig.gif"/></div>'
      freezr.utils.ping(null, function (error, resp) {
        if (!resp || error) {
          console.warn(error)
          messageDiv.innerHTML = 'Your PDS is unavailable, or the URL is badly configured. Please try later, or correct the url.'
        } else if (!hasLoginParams) {
          messageDiv.innerHTML = ''

          document.getElementById('freezr_server_pds_name_area').style.display = 'none'
          document.getElementById('freezr_server_login_name_area').style.display = 'block'
          document.getElementById('freezr_server_name_in_loginname_page').innerText = freezrMeta.serverAddress

          if (resp.logged_in) {
            document.getElementById('freezr_login_username').innerText = resp.user_id
            document.getElementById('freezr_login_pw').focus()
          } else {
            document.getElementById('freezr_login_username').focus()
          }
        } else {
          freezerRestricted.menu.loginmovesstep2({ server, userName, authPassword })
        }
      }, freezrMeta.appName)
    }
  }
  document.getElementById('freezr_pingprelogin_butt').onclick = freezerRestricted.menu.loginmovesstep1
  document.getElementById('freezr_authurl_login_butt').onclick = freezerRestricted.menu.loginmovesstep1

  freezerRestricted.menu.loginmovesstep2 = function (options = {}) {
    // if options are present then login is being done using the app_auth url
    freezrMeta.userId = options.userName || document.getElementById('freezr_login_username').innerText
    var password = options.authPassword || document.getElementById('freezr_login_pw').value
    var messageDiv = document.getElementById('freezr_login_message')

    if (freezrMeta.userId && freezrMeta.userId.length > 0 && password && password.length > 0 && freezrMeta.serverAddress && freezrMeta.serverAddress.length > 0) {
      var theInfo = { username: freezrMeta.userId, password: password, client_id: freezrMeta.appName, grant_type: 'password' }
      if (!freezrMeta.appName) {
        alert('developer error: variable freezrMeta.appName needs to be defined')
      } else {
        messageDiv.innerHTML = '<br/><div align="center">.<img src="freezr/static/ajaxloaderBig.gif"/></div>'
        freezerRestricted.connect.ask('/oauth/token', theInfo, function (error, resp) {
          resp = freezr.utils.parse(resp)
          if (error || (resp && resp.error)) {
            messageDiv.innerHTML = 'Error logging you in: ' + (error || resp.error)
            freezr.app.loginCallback ? freezr.app.loginCallback(resp) : console.warn('Error ' + JSON.stringify(resp))
          } else if (!resp.access_token) {
            messageDiv.innerHTML = 'Error logging you in. The server gave an invalid response.'
            freezr.app.loginCallback ? freezr.app.loginCallback(resp) : console.warn('Error ' + JSON.stringify(resp))
          } else if (resp.app_name === freezrMeta.appName) {
            freezerRestricted.menu.close()
            freezrMeta.appToken = resp.access_token
            freezr.serverVersion = resp.freezr_server_version
            freezr.app.offlineCredentialsExpired = false
            freezr.app.loginCallback ? freezr.app.loginCallback(null, freezrMeta) : console.warn('Warning: Set freezr.app.loginCallback to handle log in response: ' + JSON.stringify(resp))
          } else {
            messageDiv.innerHTML = 'developper error  2 - inputs are not correct.'
          }
        })
      }
    } else {
      messageDiv.innerHTML = 'Invalid server or user name or password'
    }
  }

  document.getElementById('freezr_login_username').onkeypress = function (evt) {
    if (evt.keyCode === 13) { evt.preventDefault(); document.getElementById('freezr_login_pw').focus() }
  }
  document.getElementById('freezr_login_pw').onkeypress = function (evt) {
    if (evt.keyCode === 13) { evt.preventDefault(); freezerRestricted.menu.loginmovesstep2() }
  }
  document.getElementById('freezr_server_login_butt').onclick = freezerRestricted.menu.loginmovesstep2
}

freezerRestricted.menu.reset_login_butt_colors = function () {
  const fullText = document.getElementById('freezr_server_name_input').innerText
  const [hasHttp, hasLoginParams, server, userName, authPassword] = freezerRestricted.menu.parse_pds_name(fullText)
  document.getElementById('freezr_pingprelogin_butt').className = ((hasHttp || freezrMeta.serverAddress) && !hasLoginParams) ? 'freezer_butt freezer_server_butt_notfloat' : 'freezer_butt_pressed freezer_server_butt_notfloat'
  document.getElementById('freezr_authurl_login_butt').className = (hasLoginParams) ? 'freezer_butt freezer_server_butt_notfloat' : 'freezer_butt_pressed freezer_server_butt_notfloat'
  return [hasHttp, hasLoginParams, server, userName, authPassword]
}
freezr.utils.applogin = function (authUrl, cb) {
  const [hasHttp, hasLoginParams, server, userName, authPassword] = freezerRestricted.menu.parse_pds_name(authUrl)
  if (!hasLoginParams || !hasHttp || !userName || userName.length === 0 || !authPassword || authPassword.length === 0 || !server || server.length === 0) {
    cb(new Error('You have enterred an invalid url.'))
  } else if (!freezrMeta.appName) {
    cb (new Error('developer error: variable freezrMeta.appName needs to be defined') )
  } else {
    freezrMeta.userId = userName
    freezrMeta.serverAddress = server
    if (freezrMeta.serverAddress.slice(freezrMeta.serverAddress.length - 1) === '/') freezrMeta.serverAddress = freezrMeta.serverAddress.slice(0, freezrMeta.serverAddress.length - 1)
    freezr.utils.ping(null, function (error, resp) {
      if (!resp || error) {
        cb(new Error('Your PDS is unavailable, or the URL is badly configured. Please try later, or correct the url.'))
        console.warn(error)
      } else {
        var theInfo = { username: freezrMeta.userId, password: authPassword, client_id: freezrMeta.appName, grant_type: 'password' }
        freezerRestricted.connect.ask('/oauth/token', theInfo, function (error, resp) {
          resp = freezr.utils.parse(resp)
          if (error || (resp && resp.error)) {
            console.warn(error || resp.error)
            cb(error || resp.error)
          } else if (!resp.access_token) {
            cb(new Error ( 'Error logging you in. The server gave an invalid response.' ) )
          } else if (resp.app_name !== freezrMeta.appName) {
            cb(new Error ( 'Error - loggedin_app_name[??] is not correct.'))
          } else {
            freezrMeta.appToken = resp.access_token
            freezr.serverVersion = resp.freezr_server_version
            freezr.app.offlineCredentialsExpired = false
            cb(null, freezrMeta)
          }
        })
      }
    }, freezrMeta.appName)
  }
}
freezerRestricted.menu.parse_pds_name = function (fullText) {
  let hasLoginParams = false
  let server = ''
  let userName = ''
  let authPassword = ''
  fullText = fullText || ''
  const hasHttp = fullText.indexOf('http') === 0 && (fullText.indexOf('.') > 8 || fullText.indexOf('localhost:') > 6)
  const serverparts = fullText.split('?')
  server = serverparts[0]
  // let haspath = server.slice(8).indexOf('/')>0
  // let path = haspath? server.slice((9+server.slice(8).indexOf('/'))):''
  // server = haspath? server.slice(0,(8+server.slice(8).indexOf('/'))):server
  const queries = (serverparts.length > 1) ? serverparts[1].split('&') : null
  if (queries && queries.length > 0) {
    queries.forEach(query => {
      if (query.split('=')[0] === 'user') userName = query.split('=')[1]
      if (query.split('=')[0] === 'password') authPassword = query.split('=')[1]
    })
  }
  hasLoginParams = (hasHttp && server && userName && authPassword) || false
  // onsole.log({hasHttp, hasLoginParams, server, userName, authPassword})
  return [hasHttp, hasLoginParams, server, userName, authPassword]
}

freezerRestricted.menu.showOfflinePermissions = function (error, outerPermissions) {
  outerPermissions = freezerRestricted.utils.parse(outerPermissions)

  var innerElText = document.getElementById('freezer_dialogueInnerText')

  document.getElementById('freezer_dialogueOuter').style.display = 'block'
  freezerRestricted.menu.addLoginInfoToDialogue('freezer_dialogueInnerText')

  if (error || !outerPermissions || outerPermissions.error || !outerPermissions[freezrMeta.appName]) {
    innerElText.innerHTML += '<br/><br/>Error connecting to freezr to get permissions'
  } else {
    innerElText.innerHTML += '<div class="freezer_dialogue_topTitle">App Permissions to Access Data</div>'
    const groupedPermissions = outerPermissions[freezrMeta.appName]

    const IntroText = {
      thisAppToThisApp: 'This app is asking for permission to share data from this app:',
      thisAppToOtherApps: 'This app is asking for permissions to access data from other apps:',
      otherAppsToThisApp: 'Other apps are asking for permission to see your data from this app:',
      unkowns: 'These permissions are uknkown to freezr'
    }
    const addpermSentence = function (aPerm) {
      let sentence = ''
      const hasBeenAccepted = (aPerm.granted && !aPerm.outDated)
      const otherApp = aPerm.requestee_app !== aPerm.requestor_app
      const accessWord = otherApp ? 'access and share' : 'share'
      sentence += otherApp ? ('The app, <b style="color:purple;">' + aPerm.requestor_app + '</b>,') : 'This app'
      sentence += hasBeenAccepted ? ' is able to ' : ' wants to be able to '
      if (aPerm.type === 'db_query') {
        sentence += accessWord + ': ' + (aPerm.return_fields ? (aPerm.return_fields.join(', ')) : 'ERROR') + ' with the following groups: ' + aPerm.sharable_groups.join(' ') + '.<br/>'
      } else if (aPerm.type === 'object_delegate') {
        sentence += accessWord + ' individual data records with the following groups:  ' + (aPerm.sharable_groups ? aPerm.sharable_groups.join(' ') : 'None') + '.<br/>'
      }
      if (aPerm.outDated) sentence += 'This permission was previously granted but the permission paramteres have changed to you would need to re-authorise it.<br/>'
      aPerm.sentence = sentence
      aPerm.action = hasBeenAccepted ? 'Deny' : 'Accept'
      return aPerm
    }

    var makePermissionElementFrom = function (permissionObject) {
      // onsole.log('permissionObject',permissionObject)
      var permEl = document.createElement('div')
      permEl.className = 'freezer_BoxTitle'
      permEl.innerHTML = (permissionObject.description ? (permissionObject.description + ' (' + permissionObject.permission_name + ')') : permissionObject.permission_name)

      var acceptButt = document.createElement('div')
      acceptButt.className = 'freezer_butt'
      acceptButt.id = 'freezerperm_' + permissionObject.requestee_app_table + '_' + permissionObject.requestor_app + '_' + (permissionObject.granted ? 'Deny' : 'Accept') + '_' + permissionObject.permission_name
      acceptButt.innerHTML = (permissionObject.granted && !permissionObject.outDated) ? 'Deny' : 'Accept'

      var detailText = document.createElement('div')
      detailText.className = 'freezer_butt_Text'
      detailText.id = 'sentence_' + permissionObject.requestee_app + '_' + permissionObject.requestor_app + '_' + permissionObject.permission_name
      permissionObject = addpermSentence(permissionObject)
      detailText.innerHTML = permissionObject.sentence

      var boxOuter = document.createElement('div')
      boxOuter.appendChild(permEl)
      boxOuter.appendChild(acceptButt)
      boxOuter.appendChild(detailText)
      return boxOuter
    }

    var writePermissions = function (recordList, type, altText) {
      const titleDiv = document.createElement('div')
      titleDiv.className = 'freezer_dialogueTitle freezr_dialogueBordered'
      if (recordList && recordList.length > 0) {
        titleDiv.innerHTML = IntroText[type]
        innerElText.appendChild(titleDiv)
        for (var i = 0; i < recordList.length; i++) {
          innerElText.appendChild(makePermissionElementFrom(recordList[i]))
        }
      } else if (altText) {
        titleDiv.innerHTML = altText + '<br/><br/>'
        innerElText.appendChild(titleDiv)
      }
    }

    if (groupedPermissions.thisAppToThisApp.length + groupedPermissions.thisAppToOtherApps.length + groupedPermissions.otherAppsToThisApp.length === 0) {
      writePermissions([], null, 'This app is not asking for any sharing permissions.')
    }

    writePermissions(groupedPermissions.thisAppToThisApp, 'thisAppToThisApp')
    writePermissions(groupedPermissions.otherAppsToThisApp, 'otherAppsToThisApp')
    writePermissions(groupedPermissions.thisAppToOtherApps, 'thisAppToOtherApps')
    writePermissions(groupedPermissions.unknowns, 'unknowns')
  }
}

freezr.utils.logout = function (logoutCallback) {
  freezerRestricted.connect.ask('/v1/account/applogout', null, function (error, resp) {
    // console.log({error, resp})
    freezerRestricted.menu.close()
    if (!error || !resp.error || confirm('There was an error logging you out or connecting to the server. Do you want your login credentials removed?')) {
      document.cookie = 'app_token_' + freezrMeta.userId + '= null'
      freezrMeta.reset()
      if (logoutCallback) {
        logoutCallback(resp)
      } else if (freezr.app.logoutCallback) {
        freezr.app.logoutCallback(resp)
      }
    }
  })
}
