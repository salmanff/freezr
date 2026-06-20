// new.js — dedicated /connections/new page. Replaces the connect modal that
// used to live on /account/resources. Builds the OAuth-start URL with the
// user's per-connection choice of auth provider (default / this-freezr / custom).
//
// Like edit.js, this page runs AS info.freezr.connections which doesn't own
// info.freezr.account.resources. Existing-name collision check goes through
// /feps/connections/accounts (permission-mediated). See edit.js for the same caveat.
/* global freezr */

const CONNECTION_NAME_RX = /^[A-Za-z0-9_-]+$/
const SERVICES = ['mail', 'calendar', 'contacts']

const state = {
  existingConnections: [],
  hasLocalProvider: false  // becomes true if admin has registered a direct google oauth row
}

freezr.initPageScripts = async function () {
  document.getElementById('button_connConnect').onclick = submit
  document.querySelectorAll('input[name="conn_auth_choice"]').forEach(r => {
    r.addEventListener('change', syncCustomEnabled)
  })

  // Preload existing connections so we can block name collisions client-side.
  // Goes through the FEPS endpoint (permission-mediated) — see edit.js note.
  try {
    const res = await freezr.apiRequest('GET', '/feps/connections/accounts')
    state.existingConnections = (res && res.accounts) ? res.accounts : []
  } catch (e) {
    console.warn('Could not preload existing connections (collision check disabled):', e)
  }

  // We don't have direct introspection of admin oauth config from a normal logged-in user,
  // so for now the "This freezr's own credentials" radio is always enabled. If the admin
  // hasn't registered one, the OAuth flow will fall back to the default provider at runtime
  // (see FREEZR_DEFAULT_AUTH_PROVIDER). Future polish: expose an /acctapi endpoint that
  // returns whether a direct google client is registered.
  syncCustomEnabled()
}

const syncCustomEnabled = function () {
  const chosen = document.querySelector('input[name="conn_auth_choice"]:checked')?.value
  document.getElementById('conn_custom_url').disabled = (chosen !== 'custom')
}

const showWarning = function (msg) {
  const div = document.getElementById('warnings')
  if (!div) return
  if (!msg) { div.style.display = 'none'; return }
  div.style.display = 'block'
  div.innerText = msg
  window.scrollTo(0, 0)
}

const submit = function () {
  showWarning('')
  const provider = document.getElementById('conn_provider').value
  const connectionName = document.getElementById('conn_name').value.trim()

  if (!connectionName) { showWarning('Connection name is required'); return }
  if (!CONNECTION_NAME_RX.test(connectionName)) {
    showWarning('Connection name: letters, digits, underscore and dash only')
    return
  }
  if (state.existingConnections.find(c => c.connectionName === connectionName)) {
    showWarning('A connection named "' + connectionName + '" already exists. Pick a different name, or edit the existing one at /connections/edit?name=' + encodeURIComponent(connectionName))
    return
  }

  const services = []
  const accessByService = {}
  SERVICES.forEach(s => {
    if (document.getElementById('conn_service_' + s).checked) {
      services.push(s)
      accessByService[s] = document.getElementById('conn_access_' + s).value
    }
  })
  if (services.length === 0) { showWarning('Pick at least one service'); return }

  // Auth provider choice → delegate_to_override query param on the OAuth start.
  // Default and "local" both omit the override (server picks based on its own config).
  // "custom" passes the user-supplied URL through.
  const authChoice = document.querySelector('input[name="conn_auth_choice"]:checked')?.value
  let delegateOverride = null
  if (authChoice === 'custom') {
    const customUrl = document.getElementById('conn_custom_url').value.trim()
    if (!customUrl) { showWarning('Enter a custom freezr URL or pick a different option'); return }
    try {
      const u = new URL(customUrl)
      if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
        showWarning('Custom URL must use HTTPS (or localhost for dev)'); return
      }
    } catch (_) {
      showWarning('Custom URL is not a valid URL'); return
    }
    delegateOverride = customUrl
  } else if (authChoice === 'local') {
    // Force a non-delegated flow: prefer admin's direct google config row (if any) over
    // any delegate_to default. Server reads this hint and skips delegation.
    delegateOverride = '__local__'
  }

  const regcode = 'conn_' + Math.random().toString(36).slice(2, 12)
  const params = new URLSearchParams({
    type: provider,
    sender: '/account/resources',
    regcode,
    purpose: 'connection',
    connectionName,
    services: services.join(',')
  })
  services.forEach(s => params.set('access_' + s, accessByService[s]))
  if (delegateOverride) params.set('delegate_to_override', delegateOverride)

  try { sessionStorage.setItem('lastConnAttempt', JSON.stringify({ regcode, connectionName })) } catch (_) {}
  window.location.href = '/public/oauth/oauth_start_oauth?' + params.toString()
}
