// modMperms.js

/* global freezr, freezerRestricted, freezrMeta, screen */

import { dg } from './dgelements.js'

const showPermsIn = async function (originalAppName) {
  const res = await fetch('/v1/permissions/getall/' + originalAppName, {
    headers: { Authorization: ('Bearer ' + freezr.utils.getCookie('app_token_' + freezrMeta.userId)) }
  })
  const allPerms = await res.json()
  console.log({ allPerms })
  return createPermissionsDiv(allPerms, originalAppName)
}

const replaceWithFreezrEmptyLogo = function (evt) {
  this.src = '/app_files/info.freezr.public/public/static/freezer_logo_empty.png'
  this.removeEventListener('error', replaceWithFreezrEmptyLogo)
}

const appHeaderFor = async function (manifest) { // Logo and name / description of app
  console.log({ manifest })
  const LOGO_SIZE = 60
  const hasDisplayName = Boolean(manifest.display_name)

  return dg.div( // grid with..
    {
      style: { display: 'grid', 'grid-template-columns': (LOGO_SIZE + 'px 2fr'), cursor: 'pointer' },
      onclick: function () { window.location = ('/apps/' + manifest.identifier)}
    },

    dg.img({ // logo to the left
      width: LOGO_SIZE,
      height: LOGO_SIZE,
      src: '/app_files/' + manifest.identifier + '/static/logo.png',
      eventListener: { event: 'error', func: replaceWithFreezrEmptyLogo }
    }),

    dg.div( // Name and description to the right
      { style: { 'padding-left': '10px' } },
      dg.div(
        { style: { padding: '0', margin: '0' }, class: 'freezer_dialogue_topTitle' },
        (hasDisplayName ? manifest.display_name : manifest.identifier)
      ),
      (hasDisplayName
        ? dg.div(
          {
            class: 'smallText', style: { 'font-style': 'italic' }
          },
          manifest.identifier)
        : null
      ),
      (manifest.description
        ? dg.div(
          {
            class: 'smallText'
          },
          manifest.description)
        : null
      ),
      dg.br()
    )
  )
}

// Creating Permission HTML
const DENY = 'Deny'
const ACCEPT = 'Accept'
const createPermissionsDiv = function (outerPermissions, currentAppName) {
  if (outerPermissions && outerPermissions.length > 0) {
    const outer = dg.div(
      { id: 'freezrPermsDiv', 'data-appName': currentAppName },
      dg.div({ class: 'freezer_dialogue_topTitle', id: 'permissions' }, 'App Permissions to Access Modify and Share Data')
    )

    if (outerPermissions.length > 1 && freezrMeta.appName === 'info.freezr.account') { // show "Accept ALL" and "Deny All" buttons
      let acceptedSum = 0
      let notAcceptedSum = 0
      const ACCEPT_ALL = 'Accept All Permissions'
      outerPermissions.forEach(permissionObject => { if (permissionObject.granted) { acceptedSum++ } else { notAcceptedSum++ } })
      const acceptorDenyAllDiv = dg.div({ style: { width: '100%', 'text-align': 'center' } })
      const doAllButtChars = {
        class: 'freezer_butt',
        style: { display: 'inline-block', margin: '10px' },
        onclick: async function (e) {
          const acceptAll = (e.target.innerText === ACCEPT_ALL)
          e.target.onclick = null
          let errors = 0
          e.target.innerHTML = '<img src="/app_files/public/info.freezr.public/public/static/ajaxloaderBig.gif" alt="">'
          for (const permissionObject of outerPermissions) {
            if ((acceptAll && !permissionObject.granted) || (!acceptAll && permissionObject.granted)) {
              const change = {
                requestor_app: permissionObject.requestor_app,
                table_id: permissionObject.table_id,
                action: (acceptAll ? ACCEPT : DENY),
                name: permissionObject.name
              }
              const res = await fetch('/v1/permissions/change', {
                method: 'PUT',
                body: JSON.stringify({ change, targetApp: currentAppName }),
                headers: {
                  Authorization: ('Bearer ' + freezr.utils.getCookie('app_token_' + freezrMeta.userId)),
                  'Content-type': 'application/json'
                }
              })
              const oneResult = await res.json()
              if (oneResult.error) {
                console.warn({ oneResult })
                errors++
              }
            }
          }
          if (errors > 0) {
            dg.el('message', { top: true }).innerHTML = 'There were some errors. Please try again'
          } else {
            window.open(('/account/app/settings/com.salmanff.poster?message=All Permissions have been ' + (acceptAll ? 'accepted.' : 'denied.')), '_self')
          }
          // refreshDiv()
        }
      }
      if (acceptedSum > 0) {
        acceptorDenyAllDiv.appendChild(dg.div(doAllButtChars, 'Deny All Permissions'))
      }
      if (notAcceptedSum > 0) {
        acceptorDenyAllDiv.appendChild(dg.div(doAllButtChars, ACCEPT_ALL))
      }
      outer.appendChild(acceptorDenyAllDiv)
    }

    const groupedPermissions = groupPermissions(outerPermissions, currentAppName)


    const writeForGroup = function (recordObj, type, currentAppName) {
      const recordList = recordObj[type]
      if (recordList && recordList.length > 0) {
        const outer = dg.div(
          dg.div({ class: 'freezer_dialogueTitle freezr_dialogueBordered' }, IntroText[type])
        )
        recordList.forEach(permissionObject => {
          outer.appendChild(makePermissionElementFrom(permissionObject, currentAppName))
        })
        return outer
      } else {
        return dg.div()
      }
    }

    const GROUPS = ['thisAppToThisApp', 'otherAppsToThisApp', 'thisAppToOtherApps', 'unknowns']
    GROUPS.forEach(group => {
      outer.appendChild(writeForGroup(groupedPermissions, group, currentAppName))
    })

    return outer
  } else {
    return dg.div('This App is not asking for any permissions.')
  }
}
function groupPermissions (permList, appName) {
  const groupedPermissions = {
    outside_scripts: [],
    thisAppToThisApp: [],
    thisAppToOtherApps: [],
    otherAppsToThisApp: [],
    unknowns: []
  }

  if (permList && permList.length > 0) {
    permList.forEach(aPerm => {
      if (['share_records', 'message_records', 'db_query'].indexOf(aPerm.type) > -1 && aPerm.requestor_app === appName && startsWith(aPerm.table_id, appName)) {
        groupedPermissions.thisAppToThisApp.push(aPerm)
      } else if (['upload_pages'].indexOf(aPerm.type) > -1 && aPerm.requestor_app === appName) {
        groupedPermissions.thisAppToThisApp.push(aPerm)
      } else if (['share_records', 'read_all', 'message_records', 'write_own', 'write_all', 'db_query'].indexOf(aPerm.type) > -1 && aPerm.requestor_app !== appName && startsWith(aPerm.table_id, appName)) {
        groupedPermissions.otherAppsToThisApp.push(aPerm)
      } else if (['share_records', 'read_all', 'write_all', 'message_records', 'write_own', 'db_query'].indexOf(aPerm.type) > -1 && aPerm.requestor_app === appName && !startsWith(aPerm.table_id, appName)) {
        groupedPermissions.thisAppToOtherApps.push(aPerm)
      } else {
        groupedPermissions.unknowns.push(aPerm)
        console.warn('groupPermissions', 'ERROR - why this . uknown permission ' + JSON.stringify(aPerm))
      }
    })
  }
  return groupedPermissions
}
const IntroText = {
  thisAppToThisApp: 'Permission to share data from this app:',
  thisAppToOtherApps: 'Permissions to access and / or modify data from other apps:',
  otherAppsToThisApp: 'Other apps are asking for permission to see your data from this app:',
  unkowns: 'These permissions are uknkown to freezr'
}
const getPermSentence = function (aPerm, currentAppName) {
  let sentence = ''
  const hasBeenAccepted = (aPerm.granted && !aPerm.outDated)
  const otherApp = currentAppName !== aPerm.requestor_app
  const otherTable = !startsWith(aPerm.table_id, currentAppName)
  const accessWord = otherApp ? ('read ' + (aPerm.type === 'write_all' ? 'write ' : (aPerm.type === 'write_own' ? 'write (own) ' : '')) + 'and share') : 'share'
  sentence += otherApp ? ('The app, <b style="color:purple;">' + aPerm.requestor_app + '</b>,') : 'This app'
  sentence += hasBeenAccepted ? ' is able to ' : ' wants to be able to '
  if (aPerm.type === 'db_query') {
    sentence += accessWord + ': ' + (aPerm.return_fields ? (aPerm.return_fields.join(', ')) : 'ERROR') + ' with the following groups: ' + aPerm.sharable_groups.join(' ') + '.<br/>'
  } else if (aPerm.type === 'object_delegate') {
    sentence += accessWord + ' individual data records from the table <b ' + (otherTable ? 'style="color:purple;")' : '') + '>' + aPerm.table_id + '</b>, with ' + (aPerm.sharable_groups ? ('the following groups:  ' + aPerm.sharable_groups.join(' ')) : 'others') + '.<br/>'
  } else if (aPerm.type === 'read_all') {
    sentence += accessWord + ' individual data records from the table <b ' + (otherTable ? 'style="color:purple;")' : '') + '>' + aPerm.table_id + '</b>, with  ' + (aPerm.sharable_groups ? ('the following groups:  ' + aPerm.sharable_groups.join(' ')) : 'others') + '.<br/>'
  } else if (aPerm.type === 'write_all') {
    sentence += accessWord + ' individual data records from the table <b ' + (otherTable ? 'style="color:purple;")' : '') + '>' + aPerm.table_id + '</b>, with  ' + (aPerm.sharable_groups ? ('the following groups:  ' + aPerm.sharable_groups.join(' ')) : 'others') + '.<br/> This permission gives full read and <b>WRITE</b> permission on the table.'
  } else if (aPerm.type === 'write_own') {
    sentence += accessWord + ' individual data records from the table <b ' + (otherTable ? 'style="color:purple;")' : '') + '>' + aPerm.table_id + '</b>, with  ' + (aPerm.sharable_groups ? ('the following groups:  ' + aPerm.sharable_groups.join(' ')) : 'others') + '.<br/> This permission gives full read permission and will allow the app to <b>WRITE</b> new records and edit the records it has created.'
  } else if (aPerm.type === 'message_records') {
    sentence += accessWord + ' individual data records from the table <b ' + (otherTable ? 'style="color:purple;")' : '') + '>' + aPerm.table_id + '</b>, with  ' + (aPerm.sharable_groups ? ('the following groups:  ' + aPerm.sharable_groups.join(' ')) : 'others') + '.<br/> This allows the app to send specific records and related messgaes to third parties.'
  } else if (aPerm.type === 'share_records') {
    sentence += accessWord + ' individual data records from the table <b ' + (otherTable ? 'style="color:purple;")' : '') + '>' + aPerm.table_id + '</b>, with  ' + (aPerm.sharable_groups ? ('the following groups:  ' + aPerm.sharable_groups.join(' ')) : 'others') + '.<br/> This allows the app to give access to any third party to specific records even after they change.'
  } else {
    sentence += accessWord + ' some records - UNKNOWN SCOPE'
  }
  if (aPerm.outDated) sentence += 'This permission was previously granted but the permission paramteres have changed to you would need to re-authorise it.<br/>'
  return sentence
}
const makePermissionElementFrom = function (permissionObject, currentAppName, message) {
  // onsole.log('permissionObject', { permissionObject })

  const acceptButt = dg.div(
    {
      class: 'freezer_butt',
      id: 'freezerperm_' + permissionObject.requestee_app_table + '_' + permissionObject.requestor_app + '_' + (permissionObject.granted ? 'Deny' : 'Accept') + '_' + permissionObject.permission_name,
      onclick: function (e) {
        if (freezrMeta.appName === 'info.freezr.account') {
          acceptButt.innerHTML = '<img src="/app_files/public/info.freezr.public/public/static/ajaxloaderBig.gif" alt="">'
          changePermission(e, permissionObject, currentAppName, changePermissionCallBack)
        } else {
          openPermConfirmationWindow(e, permissionObject)
        }
      }
    },
    (permissionObject.granted && !permissionObject.outDated) ? DENY : ACCEPT
  )

  const detailText = dg.div(
    { class: 'freezer_butt_Text',
      id: ('sentence_' + permissionObject.requestee_app + '_' + permissionObject.requestor_app + '_' + permissionObject.permission_name),
      html: getPermSentence(permissionObject, currentAppName)
    }
  )

  return dg.div(
    dg.div( // header
      { class: 'freezer_BoxTitle' },
      (currentAppName + ' is asking to: "' + (permissionObject.description ? (permissionObject.description + '" (' + permissionObject.name + ')') : (permissionObject.name + '"')))
    ),
    dg.div( // button and description
      { style: { display: 'grid', 'grid-template-columns': '100px 2fr' } },
      acceptButt, detailText
    ),
    dg.div({ style: { color: 'red', 'font-size': '16px' } }, message) // message after granting / revoking

  )
}

// Change permsission
const changePermission = function (evt, permissionObject, currentAppName, callback) {
  const url = '/v1/permissions/change' // + permissionObject.requestee_app_table
  const change = {
    requestor_app: permissionObject.requestor_app,
    table_id: permissionObject.table_id,
    action: (permissionObject.granted ? DENY : ACCEPT),
    name: permissionObject.name
  }
  const data = { change, targetApp: currentAppName }
  freezerRestricted.connect.write(url, data, function (error, returnJson) {
    callback(error, returnJson, permissionObject, currentAppName, evt)
  })
}

const changePermissionCallBack = function (error, returnJson, permissionObject, currentAppName, evt) {
  // onsole.log({ returnJson, error })
  let message = ''
  if (error) {
    console.warn(error)
    message = 'There was an error granting permissions.'
  } else {
    permissionObject.granted = !permissionObject.granted
    message = permissionObject.granted
      ? 'You have granted this permission'
      : 'Permission has been DENIED!'
  }
  const parentEl = evt.target.parentElement.parentElement
  parentEl.innerHTML = ''
  parentEl.appendChild(makePermissionElementFrom(permissionObject, currentAppName, message))
}

const openPermConfirmationWindow = function (e, permissionObject) {
  const getTopLeft = function (w, h) { // stackoverflow.com/questions/43913396/how-can-i-get-a-popup-to-be-a-relative-size
    const dualScreenLeft = window.screenLeft !== undefined ? window.screenLeft : window.screenX
    const dualScreenTop = window.screenTop !== undefined ? window.screenTop : window.screenY
    const width = window.innerWidth ? window.innerWidth : document.documentElement.clientWidth ? document.documentElement.clientWidth : screen.width
    const height = window.innerHeight ? window.innerHeight : document.documentElement.clientHeight ? document.documentElement.clientHeight : screen.height
    const systemZoom = width / window.screen.availWidth
    return [((height - h) / 2 / systemZoom + dualScreenTop), ((width - w) / 2 / systemZoom + dualScreenLeft)]
  }
  const [top, left] = getTopLeft(600, 350)
  let url = '/account/confirmPerm?requestor_app=' + permissionObject.requestor_app + '&name=' + permissionObject.name + '&table_id=' + permissionObject.table_id + '&type=' + permissionObject.type + '&action=' + (permissionObject.granted ? DENY : ACCEPT)
  if (!freezr.app.isWebBased) url = freezrMeta.serverAddress + url
  window.addEventListener('focus', refreshAndRemoveListener)
  window.open(url, 'window', 'width=600, height=350, toolbar=0, menubar=0, left =' + left + ', top=' + top)
}

const refreshAndRemoveListener = function (e) {
  window.removeEventListener('focus', refreshAndRemoveListener, false)
  refreshDiv()
}
const refreshDiv = async function () {
  const divParent = document.getElementById('freezrPermsDiv').parentElement
  const currentAppName = document.getElementById('freezrPermsDiv').getAttribute('data-appName')

  divParent.innerHTML = ''
  const innerHTML = await showPermsIn(currentAppName)
  divParent.appendChild(innerHTML)
}
const startsWith = function (longertext, checktext) {
  if (!longertext || !checktext || !(typeof longertext === 'string') || !(typeof checktext === 'string')) return false
  if (checktext.length > longertext.length) return false
  return (checktext === longertext.slice(0, checktext.length))
}

export { showPermsIn, appHeaderFor, groupPermissions, getPermSentence, changePermission, replaceWithFreezrEmptyLogo, ACCEPT, DENY }
