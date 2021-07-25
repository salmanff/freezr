// oauth_validate_page.js
// v 0.0.200

/* global freezr, freezerRestricted */

freezr.initPageScripts = function () {
  // onsole.log('nav to ', window.location)
  const urlQueries = new URLSearchParams(window.location.search)
  const state = urlQueries.get('state')
  const code = urlQueries.get('code')
  const accessToken = urlQueries.get('access_token')

  if (!accessToken && !code) {
    showError('Error - No access token or code')
  } else if (!state) {
    showError('Error - No state')
  } else {
    const options = { state, code, accessToken }
    freezerRestricted.connect.read('/v1/admin/oauth/public/validate_state', options, function (error, jsonString) {
      // onsole.log('validate_state jsonString: ', jsonString)
      if (error) {
        showError('validate_state err:' + JSON.stringify(error))
      } else {
        jsonString = freezr.utils.parse(jsonString)
        let regUrl = jsonString.sender // + jsonString.accessToken + '&code=' + jsonString.code + '&type=' + jsonString.type + '&regcode=' + jsonString.regcode + '&clientId=' + jsonString.clientId + '&codeChallenge=' + jsonString.codeChallenge + '&codeVerifier=' + jsonString.codeVerifier + '&refreshToken=' + jsonString.refreshToken + '&expiry=' + jsonString.expiry + '&redirecturi=' + encodeURIComponent(jsonString.redirecturi)
        let hadOne = 0
        for (const [key, value] of Object.entries(jsonString)) {
          if (key !== 'sender') {
            regUrl += ((hadOne++) ? '&' : '?') + key + '=' + value
          }
        }
        window.open(regUrl, '_self')
      }
    })
  }
}

var showError = function (errorText) {
  // todo:  move the scroll to the bottom')
  document.body.scrollTop = 0
  var errorBox = document.getElementById('errorBox')
  errorBox.innerHTML = errorText
}
