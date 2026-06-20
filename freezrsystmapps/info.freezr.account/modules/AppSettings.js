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
// UI-only label (not a server action). On a granted job permission, the Deny button morphs to this
// when the user edits the location dropdown away from the saved value; clicking it re-grants with the
// new location (the action sent to the server is still ACCEPT). Reverting the dropdown restores Deny.
const UPDATE = 'Update location'

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

    // Optional action link on a warning (e.g. "Review trusted jobs →" pointing at /admin/trustedjobs).
    // link/linkText come from the server (fixed strings), so building the anchor via innerHTML is safe.
    if (warning.link) {
      const linkDiv = dg.div({ style: { fontSize: '14px', marginTop: '6px', fontWeight: 'bold' } })
      linkDiv.innerHTML = '<a href="' + warning.link + '">' + (warning.linkText || warning.link) + '</a>'
      warningElement.appendChild(linkDiv)
    }

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
const CAPABILITY_TYPES = ['external_scripts', 'external_fetch', 'unsafe_eval', 'use_serverless', 'use_llm', 'use_mail', 'use_3pFunction', 'auto_update_local_3pFunction', 'allow_self_frames', 'run_job', 'schedule_job']
// Job permissions show a "where should this run?" location picker on grant (like use_mail's scopes).
const JOB_PERM_TYPES = ['run_job', 'schedule_job']
const RESOURCES_TABLE = 'info.freezr.account.resources'
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

  } else if (aPerm.type === 'use_mail') {
    // Describe scope based on whatever the manifest declared (or the user has narrowed via the picker).
    // connection_names: missing / empty / ['*'] all mean "all the user's mail-enabled connections".
    const connNames = aPerm.connection_names || []
    const all = connNames.length === 0 || connNames.includes('*')
    const scopes = aPerm.scopes || ['read']
    const canWrite = scopes.includes('write')
    const accessText = canWrite ? '<b>read and write</b>' : '<b>read</b>'
    const targetText = all
      ? '<b>all your connected mail accounts</b>'
      : ('the following mail accounts: <b>' + connNames.join(', ') + '</b>')
    sentence += accessText + ' messages from ' + targetText + '.'
    if (canWrite) {
      risk = 'The app will be able to modify and send mail using your credentials.'
    }

  } else if (aPerm.type === 'run_job') {
    const jn = aPerm.job_name || aPerm.name
    sentence += 'run the job <b>' + jn + '</b> <b>on demand</b> (when you or the app trigger it). This does not allow scheduled/background runs.'
    risk = 'You choose below where it runs. Running on your own cloud uses your compute and may incur costs.'

  } else if (aPerm.type === 'schedule_job') {
    const jn = aPerm.job_name || aPerm.name
    sentence += 'run the job <b>' + jn + '</b> <b>automatically on a recurring schedule</b>, in the background.'
    risk = 'This runs on its own, without you present. You choose below where it runs; your own cloud may incur costs.'

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

  // For use_mail, an inline picker lets the user narrow which mail accounts and the
  // access level before clicking Accept. The picker reads existing values from the
  // permission record and seeds the controls; changePermission below reads back the
  // current control state at submit time.
  const extraControls = permissionObject.type === 'use_mail'
    ? buildUseMailPicker(permissionObject)
    : (JOB_PERM_TYPES.includes(permissionObject.type) ? buildLocationPicker(permissionObject) : null)

  // On a granted job permission, let the user change where it runs: when the location dropdown
  // differs from the saved value, morph the Deny button into "Update location" (re-grants with the
  // new location, stays granted); reverting the dropdown restores Deny. querySelector works on this
  // still-detached subtree (the row is appended/replaced into the DOM after this function returns).
  const isGrantedJob = JOB_PERM_TYPES.includes(permissionObject.type) && permissionObject.granted && !permissionObject.outDated
  if (isGrantedJob && extraControls) {
    const sel = extraControls.querySelector('select')
    const savedLoc = permissionObject.location || 'auto'
    if (sel) sel.addEventListener('change', function () { acceptButt.textContent = (sel.value !== savedLoc) ? UPDATE : DENY })
  }

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
    ...(extraControls ? [extraControls] : []),
    dg.div({ style: { color: 'red', 'font-size': '16px' } }, message) // message after granting / revoking

  )
}

// Inline picker shown on use_mail permission rows. Renders synchronously with a
// "Loading…" placeholder, then async-fills with the user's mail-enabled connections.
// User selections are read back by changePermission() at submit time via stable DOM ids.
//
// Per the doc spec we query all the user's resources and filter in JS, rather than
// passing a complex query to the server.
const buildUseMailPicker = function (permissionObject) {
  const safeName = (permissionObject.name || 'unnamed').replace(/[^A-Za-z0-9_-]/g, '_')
  const containerId = 'pickerFor_' + safeName
  const allId = 'pickerAll_' + safeName
  const indClass = 'pickerConn_' + safeName
  const scopeName = 'pickerScope_' + safeName

  const container = dg.div({
    id: containerId,
    'data-perm-name': permissionObject.name,
    'data-perm-type': 'use_mail',
    style: { border: '1px solid #e2e8f0', padding: '0.75rem', margin: '0.5rem 0', 'border-radius': '4px', 'background-color': '#f8fafc' }
  })
  container.innerHTML = '<em style="color:#64748b;">Loading mail accounts…</em>'

  ;(async () => {
    let resources = []
    try {
      resources = await freezr.query(RESOURCES_TABLE) || []
    } catch (e) {
      console.warn('Could not load mail connections for picker:', e)
    }
    const mailConnections = resources.filter(r =>
      r && r.type === 'connection' && Array.isArray(r.services) && r.services.includes('mail')
    )

    const existingNames = permissionObject.connection_names || []
    const allByDefault = existingNames.length === 0 || existingNames.includes('*')
    const existingScopes = permissionObject.scopes || ['read']
    const canWriteByDefault = existingScopes.includes('write')

    const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

    let html = ''
    html += '<div style="margin-bottom:0.5rem;">'
    html += '<strong>Access level:</strong>'
    html += `<label style="margin-left:0.75rem;"><input type="radio" name="${scopeName}" value="read" ${!canWriteByDefault ? 'checked' : ''}/> Read only</label>`
    html += `<label style="margin-left:0.75rem;"><input type="radio" name="${scopeName}" value="readwrite" ${canWriteByDefault ? 'checked' : ''}/> Read + Write</label>`
    html += '</div>'

    html += '<div style="margin-bottom:0.5rem;">'
    html += `<label><input type="checkbox" id="${allId}" ${allByDefault ? 'checked' : ''}/> <b>Include all</b> mail accounts (current and future)</label>`
    html += '</div>'

    if (mailConnections.length > 0) {
      html += '<div style="margin-left:1.5rem;font-size:0.9em;">'
      for (const c of mailConnections) {
        const cn = c.connectionName || ''
        const labelExtra = c.account_email || c.provider || ''
        const checked = allByDefault || existingNames.includes(cn)
        html += `<div><label><input type="checkbox" class="${indClass}" value="${escapeHtml(cn)}" ${checked ? 'checked' : ''}/> ${escapeHtml(cn)}${labelExtra ? ' <span style="color:#64748b;">(' + escapeHtml(labelExtra) + ')</span>' : ''}</label></div>`
      }
      html += '</div>'
    } else {
      html += '<div style="margin-left:1.5rem;font-size:0.85em;color:#64748b;"><em>No mail accounts connected yet. <a href="/account/resources">Connect one</a> first to grant access to specific accounts. Granting now means &quot;all future mail accounts&quot;.</em></div>'
    }

    container.innerHTML = html

    // When "Include all" is checked, individual checkboxes are forced on + disabled.
    const allCb = container.querySelector('#' + allId)
    const indCbs = container.querySelectorAll('.' + indClass)
    const syncIndividualState = () => {
      const disable = !!allCb && allCb.checked
      indCbs.forEach(cb => {
        cb.disabled = disable
        if (disable) cb.checked = true
      })
    }
    if (allCb) allCb.addEventListener('change', syncIndividualState)
    syncIndividualState()
  })()

  return container
}

// Read the current state of the use_mail picker for a given permission record.
// Returns { connection_names, scopes } or null if no picker is present.
const readUseMailPickerState = function (permissionObject) {
  const safeName = (permissionObject.name || 'unnamed').replace(/[^A-Za-z0-9_-]/g, '_')
  const picker = document.getElementById('pickerFor_' + safeName)
  if (!picker) return null

  const allCb = picker.querySelector('#pickerAll_' + safeName)
  const scopeRadio = picker.querySelector('input[name="pickerScope_' + safeName + '"]:checked')

  let connection_names
  if (allCb && allCb.checked) {
    connection_names = ['*']
  } else {
    const indCbs = picker.querySelectorAll('.pickerConn_' + safeName + ':checked')
    connection_names = [...indCbs].map(cb => cb.value).filter(Boolean)
  }

  const scopes = (scopeRadio && scopeRadio.value === 'readwrite') ? ['read', 'write'] : ['read']
  return { connection_names, scopes }
}

// Inline "where should this run?" picker for run_job / schedule_job rows. The USER chooses the
// location (it spends their host trust / their cloud), seeded from the record (default 'auto').
const buildLocationPicker = function (permissionObject) {
  const safeName = (permissionObject.name || 'unnamed').replace(/[^A-Za-z0-9_-]/g, '_')
  const selId = 'locPicker_' + safeName
  const current = permissionObject.location || 'auto'
  const opt = (v, label) => '<option value="' + v + '"' + (current === v ? ' selected' : '') + '>' + label + '</option>'
  const container = dg.div({
    id: 'locPickerFor_' + safeName,
    'data-perm-name': permissionObject.name,
    style: { border: '1px solid #e2e8f0', padding: '0.75rem', margin: '0.5rem 0', 'border-radius': '4px', 'background-color': '#f8fafc' }
  })
  container.innerHTML =
    '<label><strong>Where should this run?</strong> ' +
    '<select id="' + selId + '" style="margin-left:0.5rem;">' +
    opt('auto', 'Automatic — this server if available, otherwise your cloud') +
    opt('local', 'On this server (must be admin-approved)') +
    opt('cloud', 'Your own cloud / serverless (may incur cost)') +
    '</select></label>'
  return container
}

// Read the location picker's value for a job permission. Returns { location } or null.
const readLocationPickerState = function (permissionObject) {
  const safeName = (permissionObject.name || 'unnamed').replace(/[^A-Za-z0-9_-]/g, '_')
  const sel = document.getElementById('locPicker_' + safeName)
  if (!sel) return null
  return { location: sel.value || 'auto' }
}

// Change permsission
const changePermission = async function (evt, permissionObject, currentAppName, callback) {
  try {
    const url = '/feps/permissions/change' // + permissionObject.requestee_app_table

    // Determine the action. Normally: granted → Deny, not-granted → Accept. EXCEPTION: a granted job
    // permission whose location dropdown now differs from the saved value is a "location update" — we
    // re-ACCEPT (which keeps it granted) carrying the new location, rather than denying it. The server
    // only knows Accept/Deny; "update" is purely a client-side framing of a re-Accept.
    const isJob = JOB_PERM_TYPES.includes(permissionObject.type)
    const pickerLoc = isJob ? (readLocationPickerState(permissionObject) || {}).location : null
    const isLocationUpdate = isJob && permissionObject.granted && !permissionObject.outDated &&
      pickerLoc && pickerLoc !== (permissionObject.location || 'auto')
    const action = isLocationUpdate ? ACCEPT : (permissionObject.granted ? DENY : ACCEPT)

    const change = {
      requestor_app: permissionObject.requestor_app,
      table_id: permissionObject.table_id,
      action,
      name: permissionObject.name
    }

    // For use_mail: include the user's picker selections only on Accept actions.
    // On Deny we don't carry connection_names/scopes — the server flips granted=false
    // and the existing scoping fields stay on the record (so they're still there if
    // the user later re-accepts).
    if (permissionObject.type === 'use_mail' && action === ACCEPT) {
      const pickerState = readUseMailPickerState(permissionObject)
      if (pickerState) {
        change.connection_names = pickerState.connection_names
        change.scopes = pickerState.scopes
      }
    }

    // For run_job / schedule_job: include the user's chosen location on Accept (covers both the first
    // grant and a later location update). Defaults to 'auto' when the picker is untouched.
    if (isJob && action === ACCEPT && pickerLoc) change.location = pickerLoc

    const data = { change, targetApp: currentAppName }

    const returnJson = await freezr.apiRequest('PUT', url, data)
    callback(null, returnJson, permissionObject, currentAppName, evt, { action, location: (isJob ? pickerLoc : undefined) })
  } catch (error) {
    callback(error, null, permissionObject, currentAppName, evt, {})
  }
}

const changePermissionCallBack = function (error, returnJson, permissionObject, currentAppName, evt, info = {}) {
  // onsole.log({ returnJson, error })
  let message = ''
  if (error) {
    console.warn(error)
    message = 'There was an error changing this permission.'
  } else {
    // Set granted from the action that was performed (not a blind toggle), so a re-Accept that only
    // updates the location keeps the permission granted instead of flipping it off.
    const action = info.action || (permissionObject.granted ? DENY : ACCEPT)
    const wasGranted = permissionObject.granted
    if (action === DENY) {
      permissionObject.granted = false
      message = 'Permission has been DENIED!'
    } else {
      permissionObject.granted = true
      // Persist the chosen location onto the object so the re-render seeds the picker with the value we
      // just saved on the server — otherwise the dropdown snaps back to "Automatic" after accepting.
      if (info.location) permissionObject.location = info.location
      message = (wasGranted && info.location) ? 'Updated where this job runs.' : 'You have granted this permission'
    }
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
