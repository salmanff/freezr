// Account Settings page
/* global freezr, freepr, freezrMeta, alert, confirm, FormData */
// tofdo seaprate out arnrole and also guard against submitting ***...

freezr.initPageScripts = function () {
  const userIdEl = document.getElementById('user_id')
  if (userIdEl) userIdEl.innerHTML = freezrMeta.userId

  document.getElementById('submitAllButt').onclick = function (evt) {
    evt.preventDefault()
    console.warn('submitting ', evt)

    const type = document.getElementById('slParamsType').value
    const region = document.getElementById('slRegion').value
    const accessKeyId = document.getElementById('accessKeyId').value
    const secretAccessKey = document.getElementById('secretAccessKey').value
    const arnRole = document.getElementById('arnRole').value || null

    if (!type) {
      showError('Type is required')
    } else if (type !== 'aws') {
      showError('Only AWS is supported at this time')
    } else if (!region || !accessKeyId || !secretAccessKey) {
      showError('region, accessKeyId and secretAccessKey are required')
    } else {
      const theInfo = {
        type,
        region,
        accessKeyId,
        secretAccessKey,
        arnRole
      }
      freezr.apiRequest('PUT', '/acctapi/setServicesParams', theInfo)
        .then(data => gotChangeParams(null, data))
        .catch(error => gotChangeParams(error, null))
    }
  }
}

const showError = function (errorText) {
  const errorBox = document.getElementById('errorBox')
  errorBox.style.display = 'block'
  errorBox.innerText = errorText
}

const gotChangeParams = function (error, data) {
  console.log('gotChangeParams', error, data)
  if (error) {
    showError('Error setting params -  ' + error.message)
  } else if (!data) {
    showError('Could not connect to server')
  } else {
    showError('Parameters Saved!! ')
  }
}
