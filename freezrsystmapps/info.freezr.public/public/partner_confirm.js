// partner_confirm.js — provider-side confirmation page for federated OAuth.
//
// Reads state from URL, fetches display info from /oauth/transfer_info, renders the
// confirmation card. On Continue, calls /oauth/transfer_proceed to get the Google URL
// and navigates there.
/* global freezr */

const escapeHtml = (s) => {
  if (s === null || s === undefined) return ''
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

const showError = (msg) => {
  const box = document.getElementById('errorBox')
  if (box) {
    box.style.display = 'block'
    box.innerText = msg
  }
  document.getElementById('loadingState').style.display = 'none'
}

const providerDisplayName = (type) => {
  if (type === 'google') return 'Google'
  if (type === 'microsoft') return 'Microsoft'
  if (type === 'dropbox') return 'Dropbox'
  if (type === 'googleDrive') return 'Google Drive'
  return type || 'the provider'
}

freezr.initPageScripts = async function () {
  const urlQueries = new URLSearchParams(window.location.search)
  const state = urlQueries.get('state')
  if (!state) {
    showError('Missing state parameter. This page is only valid as part of a freezr-to-freezr OAuth flow.')
    return
  }

  let info
  try {
    info = await freezr.apiRequest('GET', '/oauth/transfer_info?state=' + encodeURIComponent(state))
  } catch (err) {
    showError('Could not load transfer info: ' + (err?.message || 'unknown error'))
    return
  }

  // Render the panel
  document.getElementById('loadingState').style.display = 'none'
  const panel = document.getElementById('confirmPanel')
  panel.style.display = 'block'

  const providerName = providerDisplayName(info.provider)
  document.getElementById('providerName').innerText = providerName
  document.getElementById('providerName2').innerText = providerName

  // Show only the origin part of the consumer URL — full URL is too noisy.
  let consumerHost = info.redirect_back || ''
  try { consumerHost = new URL(info.redirect_back).origin } catch (_) {}
  document.getElementById('consumerHost').innerText = consumerHost
  document.getElementById('connectionName').innerText = info.connectionName || '(unnamed)'

  // Services + access lines
  const services = info.services || []
  const access = info.access || {}
  const servicesList = document.getElementById('servicesList')
  if (services.length === 0) {
    servicesList.innerHTML = '<em>None</em>'
  } else {
    servicesList.innerHTML = services
      .map(s => '• <b>' + escapeHtml(s) + '</b> — ' + (access[s] === 'readwrite' ? 'read + write' : 'read only'))
      .join('<br/>')
  }

  // Warning banner — two visual variants
  const banner = document.getElementById('warningBanner')
  if (info.is_whitelisted_consumer) {
    banner.style.background = '#ecfdf5'
    banner.style.border = '1px solid #10b981'
    banner.style.color = '#065f46'
    banner.innerHTML = '✓ This freezr has been <b>pre-approved</b> by the operator of this server.'
    banner.style.display = 'block'
    document.getElementById('trustDisclaimer').innerText = ''
  } else {
    banner.style.background = '#fef2f2'
    banner.style.border = '2px solid #dc2626'
    banner.style.color = '#991b1b'
    banner.style.fontSize = '1.1em'
    banner.innerHTML = '⚠️ <b>WARNING:</b> This freezr is <b>NOT pre-approved</b> by the operator of this server. ' +
      'Anyone could have set up this URL. Continue ONLY if you fully trust the operator of <code style="font-family:monospace;">' + escapeHtml(consumerHost) + '</code>.'
    banner.style.display = 'block'
    document.getElementById('trustDisclaimer').innerHTML =
      '<b style="color: #dc2626;">This server has not verified the requesting freezr.</b> Be sure before continuing.'
  }

  // Wire buttons
  document.getElementById('btnContinue').onclick = async function () {
    document.getElementById('btnContinue').disabled = true
    document.getElementById('btnContinue').innerText = 'Loading…'
    try {
      const res = await freezr.apiRequest('GET', '/oauth/transfer_proceed?state=' + encodeURIComponent(state))
      if (!res || !res.redirecturi) {
        showError('Server did not return a continue URL.')
        document.getElementById('btnContinue').disabled = false
        document.getElementById('btnContinue').innerText = 'Continue'
        return
      }
      window.location.href = res.redirecturi
    } catch (err) {
      showError('Failed to proceed: ' + (err?.message || 'unknown error'))
      document.getElementById('btnContinue').disabled = false
      document.getElementById('btnContinue').innerText = 'Continue'
    }
  }

  document.getElementById('btnCancel').onclick = function () {
    window.location.href = info.redirect_back
      ? (info.redirect_back + (info.redirect_back.includes('?') ? '&' : '?') + 'cancelled=true')
      : '/'
  }
}
