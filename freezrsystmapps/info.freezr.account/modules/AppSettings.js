// AppSettings.js

/* global freezr, freezerRestricted, freezrMeta, screen */

import { dg } from './dgelements.js'


const showPermsIn = async function (originalAppName) {
  console.log('showPermsIn using cookie ' + freezrMeta.userId + ' ' + freezr.utils.getCookie('app_token_' + freezrMeta.userId))
  const fetchResponse = await fetch('/feps/permissions/getall/' + originalAppName, {
    headers: { Authorization: ('Bearer ' + freezr.utils.getCookie('app_token_' + freezrMeta.userId)) }
  })
  const allPerms = await fetchResponse.json()
  console.log({ allPerms })
  return createPermissionsDiv(allPerms, originalAppName)
}

const replaceWithFreezrEmptyLogo = function (evt) {
  // this.src = '/app_files/info.freezr.public/public/static/freezer_logo_empty.png'
  // this.removeEventListener('error', replaceWithFreezrEmptyLogo)
}

const appHeaderFor = async function (manifest, versionInfo = {}) { // Logo and name / description of app
  console.log({ manifest })
  const LOGO_SIZE = 80
  const hasDisplayName = Boolean(manifest.display_name)

  // Format date helper
  const formatDate = (dateValue) => {
    if (!dateValue) return 'N/A'
    const date = typeof dateValue === 'number' ? new Date(dateValue) : new Date(dateValue)
    return date.toLocaleDateString()
  }

  return dg.div( // grid with..
    {
      className: 'appHeaderGrid',
      style: {
        display: 'grid',
        'grid-template-columns': (LOGO_SIZE + 'px 1fr auto'),
        gap: '1rem',
        'align-items': 'center'
      }
    },

    dg.img({ // logo to the left
      className: 'appHeaderLogo',
      width: LOGO_SIZE,
      height: LOGO_SIZE,
      style: { 'border-radius': '8px' },
      src: versionInfo.hasLogo ? '/app/info.freezr.account/app2app/' + manifest.identifier + '/static/logo.png' : '/app/info.freezr.public/public/static/freezer_logo_empty.png',
      eventListener: {} // { event: 'error', func: replaceWithFreezrEmptyLogo }
    }),

    dg.div( // Name and description in the middle
      dg.div(
        { style: { 'font-size': '1.25rem', 'font-weight': '600', color: 'var(--freezr-text)', 'margin-bottom': '0.25rem' } },
        (hasDisplayName ? manifest.display_name : manifest.identifier)
      ),
      (hasDisplayName
        ? dg.div(
          {
            style: { 'font-size': '13px', color: 'var(--freezr-text-muted)', 'font-style': 'italic', 'margin-bottom': '0.25rem' }
          },
          manifest.identifier)
        : null
      ),
      (manifest.description
        ? dg.div(
          {
            style: { 'font-size': '14px', color: 'var(--freezr-text-muted)', 'margin-bottom': '0.5rem' }
          },
          manifest.description)
        : null
      ),
      // Version information
      (() => {
        const versionParts = []
        if (versionInfo.version) {
          versionParts.push('v' + versionInfo.version)
        }
        if (versionInfo.appInstalled) {
          versionParts.push('Installed: ' + formatDate(versionInfo.appInstalled))
        }
        if (versionInfo.appUpdated) {
          versionParts.push('Updated: ' + formatDate(versionInfo.appUpdated))
        }
        return versionParts.length > 0
          ? dg.div(
              {
                style: { 'font-size': '12px', color: 'var(--freezr-text-muted)' }
              },
              versionParts.join(' • ')
            )
          : null
      })()
    ),

    dg.div(
      { 
        className: 'freezrButt',
        style: { cursor: 'pointer' },
        onclick: function () { window.location = ('/apps/' + manifest.identifier) }
      }, 
      'Launch App'
    )
  )
}

// Creating Permission HTML
const DENY = 'Deny'
const ACCEPT = 'Accept'

// Create warnings display area
const createWarningsDiv = function (warnings, currentAppName) {
  if (!warnings || warnings.length === 0) {
    return dg.div() // Return empty div if no warnings
  }

  const warningsContainer = dg.div(
    { id: 'freezrWarningsDiv', 'data-appName': currentAppName },
    dg.div({ class: 'freezer_dialogue_topTitle', id: 'warnings' }, 'App Installation Warnings')
  )

  warnings.forEach((warning, index) => {
    const warningSeverity = warning.severity || 'warning'
    const severityColor = warningSeverity === 'error' ? '#ff6b6b' : 
                         warningSeverity === 'warning' ? '#ffa726' : '#42a5f5'
    
    const warningElement = dg.div(
      { 
        style: { 
          border: `2px solid ${severityColor}`, 
          borderRadius: '5px', 
          padding: '10px', 
          margin: '10px 0',
          backgroundColor: `${severityColor}15`
        } 
      },
      dg.div(
        { style: { fontSize: '14px' } },
        warning.message
      )
    )
    
    warningsContainer.appendChild(warningElement)
  })

  return warningsContainer
}

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
          e.target.innerHTML = '<div class="freezr-logo-spinner" style="width:24px;height:24px;"></div>'
          for (const permissionObject of outerPermissions) {
            if ((acceptAll && !permissionObject.granted) || (!acceptAll && permissionObject.granted)) {
              const change = {
                requestor_app: permissionObject.requestor_app,
                table_id: permissionObject.table_id,
                action: (acceptAll ? ACCEPT : DENY),
                name: permissionObject.name
              }
              const fetchResponse = await fetch('/feps/permissions/change', {
                method: 'PUT',
                body: JSON.stringify({ change, targetApp: currentAppName }),
                headers: {
                  Authorization: ('Bearer ' + freezr.utils.getCookie('app_token_' + freezrMeta.userId)),
                  'Content-type': 'application/json'
                }
              })
              const oneResult = await fetchResponse.json()
              if (oneResult.error) {
                console.warn({ oneResult })
                errors++
              }
            }
          }
          if (errors > 0) {
            dg.el('message', { top: true }).innerHTML = 'There were some errors. Please try again'
          } else {
            const appName = document.getElementById('freezrPermsDiv').getAttribute('data-appName')
            window.open(('/account/app/settings/' + appName + '?message=All Permissions have been ' + (acceptAll ? 'accepted.' : 'denied.')), '_self')
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

    const GROUPS = ['thisAppToThisApp', 'otherAppsToThisApp', 'thisAppToOtherApps', 'appCapabilities', 'unknowns']
    GROUPS.forEach(group => {
      outer.appendChild(writeForGroup(groupedPermissions, group, currentAppName))
    })

    return outer
  } else {
    return dg.div('This App is not asking for any permissions.')
  }
}
const CAPABILITY_TYPES = ['external_scripts', 'external_fetch', 'unsafe_eval', 'use_serverless', 'use_llm', 'use_3pFunction', 'auto_update_local_3pFunction', 'allow_self_frames']
function groupPermissions (permList, appName) {
  const groupedPermissions = {
    thisAppToThisApp: [],
    thisAppToOtherApps: [],
    otherAppsToThisApp: [],
    appCapabilities: [],
    unknowns: []
  }

  if (permList && permList.length > 0) {
    permList.forEach(aPerm => {
      if (CAPABILITY_TYPES.indexOf(aPerm.type) > -1) {
        groupedPermissions.appCapabilities.push(aPerm)
      } else if (['share_records', 'message_records', 'db_query', 'upload_pages'].indexOf(aPerm.type) > -1 && aPerm.requestor_app === appName && (!aPerm.table_id || startsWith(aPerm.table_id, appName))) {
        groupedPermissions.thisAppToThisApp.push(aPerm)
      } else if (['share_records', 'read_all', 'message_records', 'write_own', 'write_all', 'db_query'].indexOf(aPerm.type) > -1 && aPerm.requestor_app !== appName && startsWith(aPerm.table_id, appName)) {
        groupedPermissions.otherAppsToThisApp.push(aPerm)
      } else if (['share_records', 'read_all', 'write_all', 'message_records', 'write_own', 'db_query'].indexOf(aPerm.type) > -1 && aPerm.requestor_app === appName && !startsWith(aPerm.table_id, appName)) {
        groupedPermissions.thisAppToOtherApps.push(aPerm)
      } else {
        groupedPermissions.unknowns.push(aPerm)
        console.warn('groupPermissions', 'unknown permission type: ' + JSON.stringify(aPerm))
      }
    })
  }
  return groupedPermissions
}
const IntroText = {
  thisAppToThisApp: 'Permissions to share data from this app:',
  thisAppToOtherApps: 'Permissions to access and/or modify data from other apps:',
  otherAppsToThisApp: 'Other apps are asking for permission to access your data from this app:',
  appCapabilities: 'App capabilities and external access:',
  unknowns: 'Other permissions:'
}
const getPermSentence = function (aPerm, currentAppName) {
  const hasBeenAccepted = (aPerm.granted && !aPerm.outDated)
  const otherApp = currentAppName !== aPerm.requestor_app
  const otherTable = !startsWith(aPerm.table_id, currentAppName)
  const tableStyle = otherTable ? ' style="color:purple;"' : ''

  const subject = otherApp
    ? ('The app <b style="color:purple;">' + aPerm.requestor_app + '</b>')
    : 'This app'
  const verb = hasBeenAccepted ? ' can ' : ' is requesting to '

  const tableRef = aPerm.table_id
    ? (' the table <b' + tableStyle + '>' + aPerm.table_id + '</b>')
    : ''
  const groupsRef = aPerm.sharable_groups
    ? (' with the following groups: ' + aPerm.sharable_groups.join(', '))
    : ''

  let sentence = subject + verb
  let risk = ''

  if (aPerm.type === 'share_records') {
    sentence += 'share individual records from' + tableRef + groupsRef + '.'
    sentence += '<br/>Shared records become accessible to the people or groups they are shared with, including publicly if shared with everyone.'

  } else if (aPerm.type === 'read_all') {
    sentence += 'read <b>all</b> records in' + tableRef + groupsRef + '.'
    if (otherApp) risk = 'This gives the app full read access to every record in this collection.'

  } else if (aPerm.type === 'write_own') {
    sentence += 'read all records and <b>write its own</b> records in' + tableRef + groupsRef + '.'
    sentence += '<br/>The app can create new records and edit records it created, but cannot modify records created by other apps.'

  } else if (aPerm.type === 'write_all') {
    sentence += 'read and <b>write any</b> record in' + tableRef + groupsRef + '.'
    risk = 'This is a powerful permission. The app can create, modify, or delete any record in this collection.'

  } else if (aPerm.type === 'db_query') {
    const fields = aPerm.return_fields ? aPerm.return_fields.join(', ') : 'all fields'
    sentence += 'run database queries on' + tableRef + ', returning: ' + fields + groupsRef + '.'

  } else if (aPerm.type === 'message_records') {
    sentence += 'send records from' + tableRef + ' as messages to other users' + groupsRef + '.'
    sentence += '<br/>This allows the app to share specific records and related messages with third parties.'

  } else if (aPerm.type === 'upload_pages') {
    sentence += 'upload and serve public HTML pages.'
    sentence += '<br/>Uploaded pages are accessible by anyone visiting your server.'

  } else if (aPerm.type === 'external_scripts') {
    sentence += 'load JavaScript from <b>external websites</b>.'
    risk = 'External scripts run with full access to the page and could read or modify your data. Only grant this if you trust the app developer and the external script sources.'

  } else if (aPerm.type === 'external_fetch') {
    sentence += 'send and receive data to/from <b>external websites</b>.'
    risk = 'The app could transmit your data to third-party servers. Only grant this if you trust the app developer and understand which external services it connects to.'

  } else if (aPerm.type === 'unsafe_eval') {
    sentence += 'use JavaScript <b>eval()</b> and dynamic code execution.'
    risk = 'This weakens browser security protections. Some JavaScript frameworks require this to function. Only grant this if the app needs it.'

  } else if (aPerm.type === 'use_serverless') {
    sentence += 'use your <b>cloud compute credentials</b> to run functions on external services.'
    risk = 'This uses your cloud account resources and may incur costs.'

  } else if (aPerm.type === 'use_llm') {
    sentence += 'use your <b>AI / LLM API keys</b> to make requests to AI services.'
    risk = 'This uses your API quota and may incur costs. The app can send prompts using your credentials.'

  } else if (aPerm.type === 'use_3pFunction') {
    const funcName = aPerm.function_name || aPerm.name
    sentence += 'run the third-party function <b>' + funcName + '</b> installed on this server.'

  } else if (aPerm.type === 'auto_update_local_3pFunction') {
    sentence += 'automatically update a local third-party function for all users. <b>Admin only.</b>'

  } else if (aPerm.type === 'allow_self_frames') {
    sentence += 'embed same-origin iframes (e.g. for page previews).'

  } else {
    sentence += 'perform an action with unknown scope (' + aPerm.type + ').'
  }

  if (risk) {
    sentence += '<br/><span style="color:#c62828;"><b>Risk:</b> ' + risk + '</span>'
  }
  if (aPerm.outDated) {
    sentence += '<br/><span style="color:#e65100;">This permission was previously granted but the parameters have changed. You need to re-authorise it.</span>'
  }
  return sentence
}
const makePermissionElementFrom = function (permissionObject, currentAppName, message) {
  // onsole.log('permissionObject', { permissionObject })

  const acceptButt = dg.div(
    {
      class: 'freezer_butt',
      id: 'freezerperm_' + permissionObject.requestee_app_table + '_' + permissionObject.requestor_app + '_' + (permissionObject.granted ? 'Deny' : 'Accept') + '_' + permissionObject.permission_name,
      style: { 'justify-self': 'start', 'align-self': 'start', 'min-width': '70px' },
      onclick: async function (e) {
        if (freezrMeta.appName === 'info.freezr.account') {
          acceptButt.innerHTML = '<div class="freezr-logo-spinner" style="width:24px;height:24px;"></div>'
          await changePermission(e, permissionObject, currentAppName, changePermissionCallBack)
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
    { className: 'permissionRow' },
    dg.div( // header
      { class: 'freezer_BoxTitle' },
      (currentAppName + ' is asking to: "' + (permissionObject.description ? (permissionObject.description + '" (' + permissionObject.name + ')') : (permissionObject.name + '"')))
    ),
    dg.div( // button and description
      { className: 'permissionGrid', style: { display: 'grid', 'grid-template-columns': 'auto 1fr', gap: '0.75rem', 'align-items': 'start' } },
      acceptButt, detailText
    ),
    dg.div({ style: { color: 'red', 'font-size': '16px' } }, message) // message after granting / revoking

  )
}

// Change permsission
const changePermission = async function (evt, permissionObject, currentAppName, callback) {
  try {
    const url = '/feps/permissions/change' // + permissionObject.requestee_app_table
    const change = {
      requestor_app: permissionObject.requestor_app,
      table_id: permissionObject.table_id,
      action: (permissionObject.granted ? DENY : ACCEPT),
      name: permissionObject.name
    }
    const data = { change, targetApp: currentAppName }
    
    const returnJson = await freezr.apiRequest('PUT', url, data)
    callback(null, returnJson, permissionObject, currentAppName, evt)
  } catch (error) {
    callback(error, null, permissionObject, currentAppName, evt)
  }
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
  const replacement = makePermissionElementFrom(permissionObject, currentAppName, message)
  parentEl.replaceWith(replacement)
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

export { showPermsIn, appHeaderFor, groupPermissions, getPermSentence, changePermission, replaceWithFreezrEmptyLogo, ACCEPT, DENY, createWarningsDiv }
