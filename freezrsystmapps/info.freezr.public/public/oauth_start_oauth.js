// oauth_start_oauth.js
// Public page script to start OAuth flow
// Calls the OAuth API to get a state and redirect URL, then redirects to the third party OAuth provider

/* global freezr */

freezr.initPageScripts = async function () {
  const urlQueries = new URLSearchParams(window.location.search)
  const type = urlQueries.get('type')
  const sender = urlQueries.get('sender')
  const regcode = urlQueries.get('regcode')

  console.log('OAuth start:', { type, sender, regcode })

  if (!type) {
    showError('Error - Missing type parameter')
    return
  }
  
  if (!sender) {
    showError('Error - Missing sender parameter')
    return
  }
  
  if (!regcode) {
    showError('Error - Missing regcode parameter')
    return
  }

  try {
    // Build URL with query parameters
    const queryParams = new URLSearchParams()
    queryParams.set('type', type)
    queryParams.set('sender', sender)
    queryParams.set('regcode', regcode)
    
    const url = '/oauth/get_new_state?' + queryParams.toString()
    
    // Call the OAuth API to get a new state and redirect URL
    const response = await freezr.apiRequest('GET', url)
    
    console.log('OAuth start response:', response)
    
    if (response.error) {
      showError('Error: ' + (response.message || response.error))
    } else if (!response.redirecturi) {
      showError('Could not get a redirect URL. Please try again later.')
    } else {
      // Redirect to the third party OAuth provider
      console.log('Redirecting to:', response.redirecturi)
      window.location.href = response.redirecturi
    }
  } catch (error) {
    console.error('OAuth start error:', error)
    showError('Could not connect to the OAuth server: ' + (error.message || 'Unknown error'))
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
