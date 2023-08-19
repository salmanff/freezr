// confirmPerm => page to cinfirm granting or denying of permission - launched from within apps...

/* global freezr */

import { showPermsIn, changePermission, getPermSentence, ACCEPT } from '/app_files/public/info.freezr.account/AppSettings.js'

freezr.initPageScripts = function () {
  let confirmObject = {}
  document.addEventListener('click', function (evt) {
    if (evt.target.id && evt.target.id === 'confirm_permission') {
      changePermission(evt, confirmObject, null, changeConfirmCallCallback)
    } else if (evt.target.id && evt.target.id === 'close_window') {
      window.close()
    }
  })
  // check have all params
  // do accept and on callback give message and hide confirm box and also switch the other permissions
  const searchParams = new URLSearchParams(window.location.search)
  // let url = '/account/perms?window=popup&requestor_app=' + permissionObject.requestor_app + '&name=' + permissionObject.name + '&table_id=' + permissionObject.table_id + '&action=' + (permissionObject.granted ? DENY : ACCEPT)
  confirmObject = {
    name: searchParams.get('name'),
    table_id: searchParams.get('table_id'),
    action: searchParams.get('action'),
    type: searchParams.get('type'),
    requestor_app: searchParams.get('requestor_app')
  }

  if (confirmObject.table_id && confirmObject.requestor_app && confirmObject.action && confirmObject.name) {
    document.getElementById('confirm_title').innerHTML = (confirmObject.action === ACCEPT ? 'Are you sure you want to grant this permission?' : 'Please confirm you want revoke this permission:')
    document.getElementById('confirm_app_name').innerHTML = freezr.utils.startsWith(confirmObject.table_id, confirmObject.requestor_app)? ('App: ' + confirmObject.requestor_app) : ('"App: ' + confirmObject.requestor_app + ' is asking to access ' + confirmObject.table_id)
    document.getElementById('confirm_permission_name').innerHTML = 'Permission name: ' + confirmObject.name
    document.getElementById('confirm_perm_sentence').innerHTML = getPermSentence(confirmObject, null)
  } else {
    showError('Internal error in url - For confirmation, need requestee_app_table and permission name and action')
    console.warn(confirmObject)
  }
  resetMainperms()
  document.getElementById('freezerMenuButt').style.display = 'none'
}

const resetMainperms = async function () {
  const allPerms = document.getElementById('allperms')
  const searchParams = new URLSearchParams(window.location.search)
  allPerms.innerHTML = ''
  const innerPerms = await showPermsIn(searchParams.get('requestor_app'))
  allPerms.appendChild(innerPerms)
}

const changeConfirmCallCallback = function (error, returnJson, permissionObject, currentAppName, evt) {
  // onsole.log('changeConfirmCallCallback ', { error, returnJson, permissionObject, currentAppName })
  document.getElementById('confirm_dialogue_inner').style.display = 'none'
  if (returnJson && returnJson.success && !error) {
    showError('Permission ' + (permissionObject.action === ACCEPT ? 'accepted' : 'revoked') + ' successfully. <br> Other permissions can be managed below.')
  } else {
    showError('There was an error changing this permission - please try again later')
  }
  resetMainperms()
}

const showError = function (errorText) {
  var errorBox = document.getElementById('errorBox')
  errorBox.style['display'] = 'block'
  errorBox.innerHTML = errorText
}