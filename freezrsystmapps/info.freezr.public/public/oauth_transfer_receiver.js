// oauth_transfer_receiver.js — consumer-side receiver for federated OAuth.
//
// Parses tokens from URL, POSTs to /oauth/store_transferred_credentials, redirects
// to the original sender on success. URL params are scrubbed immediately so the
// tokens aren't visible in browser history past the initial paint.
/* global freezr */

const showError = (msg) => {
  const box = document.getElementById('errorBox')
  if (box) {
    box.style.display = 'block'
    box.innerText = msg
  }
  const status = document.getElementById('status')
  if (status) status.innerText = 'Could not complete connection.'
}

freezr.initPageScripts = async function () {
  const params = new URLSearchParams(window.location.search)

  // Cancelled at the partner-confirm page
  if (params.get('cancelled') === 'true') {
    showError('You cancelled the connection on the partner server.')
    setTimeout(() => { window.location.href = '/account/resources' }, 2500)
    return
  }

  // Bail early if there's an error from the partner
  const partnerError = params.get('error')
  if (partnerError) {
    showError('Partner reported an error: ' + partnerError + (params.get('message') ? ' — ' + params.get('message') : ''))
    return
  }

  // Extract all the fields the partner forwards
  const body = {
    consumer_state: params.get('consumer_state'),
    accessToken: params.get('accessToken'),
    refreshToken: params.get('refreshToken'),
    expiry: params.get('expiry') || null,
    tokenScope: params.get('tokenScope') || '',
    connectionName: params.get('connectionName') || '',
    provider: params.get('provider') || '',
    services: params.get('services') || '',
    access: params.get('access') || '{}'
  }

  if (!body.consumer_state || !body.accessToken || !body.refreshToken) {
    showError('Missing required fields in the redirect from the partner. The connection cannot be completed.')
    return
  }

  // Scrub the URL ASAP — keep nothing token-shaped in the address bar / history.
  try { window.history.replaceState({}, document.title, window.location.pathname) } catch (_) {}

  let res
  try {
    res = await freezr.apiRequest('POST', '/oauth/store_transferred_credentials', body)
  } catch (err) {
    showError('Could not save connection: ' + (err?.message || 'unknown error'))
    return
  }

  if (!res || !res.success) {
    showError('Could not save connection: ' + (res?.error || res?.message || 'unknown error'))
    return
  }

  // Build redirect URL back to the sender (typically /account/resources) carrying the
  // same success params the direct flow uses, so the resources page shows its banner.
  const sender = res.sender || '/account/resources'
  const out = new URL(sender, window.location.origin)
  out.searchParams.set('success', 'true')
  out.searchParams.set('purpose', 'connection')
  if (res.resource_id) out.searchParams.set('resource_id', res.resource_id)
  if (res.connectionName) out.searchParams.set('connectionName', res.connectionName)
  if (res.provider) out.searchParams.set('provider', res.provider)
  if (res.services) out.searchParams.set('services', res.services.join(','))
  if (res.downgraded) out.searchParams.set('downgraded', res.downgraded)

  document.getElementById('status').innerText = 'Connection saved — redirecting…'
  window.location.href = out.toString()
}
