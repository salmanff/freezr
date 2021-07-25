// oauth_start_oauth.js
// v 0.0.200

/* global freezr, freezerRestricted */

freezr.initPageScripts = function () {
  // onsole.log("oauth_start_oauth fragments",fragments.sender+ " vs " + document.referrer, fragments)
  const urlQueries = new URLSearchParams(window.location.search)
  const type = urlQueries.get('type')
  const sender = urlQueries.get('sender')
  const regcode = urlQueries.get('regcode')

  console.log('oauthsstart', { type, sender, regcode })

  if (!type) {
    showError('Error - Missing type')
  } else if (!sender) {
    showError('Error - Missing sender')
  } else if (!regcode) {
    showError('Error - Missing regcode')
  } else {
    freezerRestricted.connect.read('/v1/admin/oauth/public/get_new_state', { type, sender, regcode }, function (error, jsonString) {
      jsonString = freezr.utils.parse(jsonString)
      console.log('retturn from get_new_state jsonString:', JSON.stringify(jsonString))
      if (error) {
        console.warn(error)
        showError('Could not connect to your freezr server. Please try again later.')
      } else if (!jsonString.redirecturi) {
        showError('Could not get a redirecturi. Please try again later.')
      } else {
        console.log(';in oauth start going to ',jsonString.redirecturi )
        window.open(jsonString.redirecturi, '_self')
      }
    })
  }
}

var showError = function (errorText) {
  document.body.scrollTop = 0
  var errorBox = document.getElementById('errorBox')
  errorBox.innerHTML = errorText
}
