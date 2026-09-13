// oauth_validate_page.js
// Public page script to validate OAuth callback
// Receives code/token from third party OAuth provider and validates with the server
// Then redirects back to the original sender with the credentials

/* global freezr */

freezr.initPageScripts = async function () {
  const urlQueries = new URLSearchParams(window.location.search)
  const state = urlQueries.get('state')
  const code = urlQueries.get('code')
  const accessToken = urlQueries.get('access_token')

  console.log('OAuth validate:', { state, code: code ? '***' : null, accessToken: accessToken ? '***' : null })

  if (!accessToken && !code) {
    showError('Error - No access token or authorization code received')
    return
  }
  
  if (!state) {
    showError('Error - No state parameter received')
    return
  }

  try {
    // Strip the callback params from the address bar before calling the API.
    // Microsoft Entra auth codes are ~2-3KB; leaving them in the URL puts the
    // whole blob in the Referer header of every subsequent request (and in
    // browser history), which can trip header-size limits (431) upstream.
    window.history.replaceState(null, '', window.location.pathname)

    // POST the code in the body rather than the query string — same reason.
    const response = await freezr.apiRequest('POST', '/oauth/validate_state', { state, code, accessToken })
    
    console.log('OAuth validate response:', { 
      success: response.success, 
      type: response.type,
      sender: response.sender 
    })
    
    if (response.error) {
      showError('Validation error: ' + (response.message || response.error))
    } else if (!response.sender) {
      showError('Error - No sender URL in response')
    } else {
      // Build redirect URL with all credentials
      let redirectUrl = response.sender
      let hasParams = false
      
      for (const [key, value] of Object.entries(response)) {
        if (key !== 'sender' && value !== undefined && value !== null) {
          redirectUrl += (hasParams ? '&' : '?') + encodeURIComponent(key) + '=' + encodeURIComponent(value)
          hasParams = true
        }
      }
      
      console.log('Redirecting to sender:', response.sender)
      window.location.href = redirectUrl
    }
  } catch (error) {
    console.error('OAuth validate error:', error)
    showError('Validation error: ' + (error.message || JSON.stringify(error)))
  }
}

function showError(errorText) {
  document.body.scrollTop = 0
  const errorBox = document.getElementById('errorBox')
  if (errorBox) {
    errorBox.innerHTML = errorText
    errorBox.style.display = 'block'
  }
}
