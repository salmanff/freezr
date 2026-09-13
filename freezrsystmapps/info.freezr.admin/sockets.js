/* global freezr, document */
// Admin "Messaging Sockets" page: the phase-1 manual lifecycle (start/stop) plus a
// live status readout that doubles as the hosted probe — event counts by channel
// type, reconnect rate (the host-stability signal), routed vs unrouted events
// (the multi-user attribution signal), and the three start-gates at a glance.

function esc (s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

function ago (ms) {
  if (!ms) return '—'
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 90) return s + 's ago'
  if (s < 5400) return Math.round(s / 60) + ' min ago'
  return Math.round(s / 3600) + ' h ago'
}

const START_REASONS = {
  sockets_disabled_in_prefs: 'Master switch is OFF — enable "messaging sockets" on the <a href="/admin/prefs">Preferences page</a>.',
  no_enabled_admission_for_slack: 'No enabled admission for slack — enable it in the Admissions table below.',
  no_app_token_on_slack_oauth_config: 'No app-level token — add the <code>xapp-…</code> token to the slack row on the <a href="/admin/oauth_serve_setup">OAuth setup page</a>.',
  already_running: 'Already running.',
  not_running: 'Not running.'
}

async function render () {
  const statusEl = document.getElementById('skt-status')
  const admEl = document.getElementById('skt-admissions')
  const gatesEl = document.getElementById('skt-gates')
  let data
  try {
    data = await freezr.apiRequest('GET', '/adminapi/get_socket_status')
  } catch (e) {
    statusEl.innerHTML = 'Error loading status: ' + esc(e && e.message)
    return
  }
  const st = data.status || {}

  gatesEl.innerHTML = (st.running
    ? '🟢 <b>Sockets are running</b>'
    : '⚪ Sockets are stopped') +
    ' · master switch: ' + (st.prefsEnabled ? '✅ on' : '⛔ off') +
    ' · routing keys: ' + (st.routes || 0) +
    (st.lastStartError ? ('<br>⚠ last start refused: ' + (START_REASONS[st.lastStartError] || esc(st.lastStartError))) : '')

  const c = st.counters || {}
  const sockets = st.sockets || []
  if (!sockets.length) {
    statusEl.innerHTML = '<p style="color:#666">No sockets open.' + (st.running ? '' : ' Press <b>Start sockets</b> (all three gates must be in place).') + '</p>'
  } else {
    const rows = sockets.map(s => {
      const bt = s.byChannelType || {}
      const bk = s.byKind || {}
      const hours = s.startedAt ? Math.max((Date.now() - s.startedAt) / 3600000, 0.01) : 0
      return '<tr>' +
        '<td style="padding:6px 10px">' + esc(s.provider) + '<br><small style="color:#888">' + esc(s.appToken) + '</small></td>' +
        '<td style="padding:6px 10px">' + (s.connected ? '<span style="color:#138000">connected</span>' : '<span style="color:#a00">disconnected</span>') +
          (s.gaveUp ? '<br><small style="color:#a00">gave up — check credentials, then Stop + Start</small>' : '') +
          (s.lastDisconnectReason ? ('<br><small style="color:#888">last: ' + esc(s.lastDisconnectReason) + '</small>') : '') +
          (s.appConnectionCount > 1
            ? '<br><small style="color:#a00">⚠ ' + s.appConnectionCount + ' sockets open for this Slack app (dev server / probe still running?) — Slack splits events RANDOMLY between them, so this instance will miss some</small>'
            : '') + '</td>' +
        '<td style="padding:6px 10px">' + (s.events || 0) +
          '<br><small style="color:#888">ch ' + (bt.channel || 0) + ' · priv ' + (bt.group || 0) + ' · dm ' + (bt.im || 0) + ' · grp-dm ' + (bt.mpim || 0) + '</small>' +
          '<br><small style="color:#888">new ' + (bk.message || 0) + ' · edits ' + (bk.edited || 0) + ' · deletes ' + (bk.deleted || 0) + '</small></td>' +
        '<td style="padding:6px 10px">' + (s.reconnects || 0) +
          (hours > 0.5 ? ('<br><small style="color:#888">~' + (s.reconnects / hours).toFixed(1) + '/h</small>') : '') + '</td>' +
        '<td style="padding:6px 10px">' + ago(s.lastEventAt) + '</td>' +
        '</tr>'
    }).join('')
    statusEl.innerHTML =
      '<table style="border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;font-size:14px">' +
      '<tr style="background:#f7fafc"><th style="padding:6px 10px;text-align:left">socket</th><th style="padding:6px 10px;text-align:left">state</th><th style="padding:6px 10px;text-align:left">events</th><th style="padding:6px 10px;text-align:left">reconnects</th><th style="padding:6px 10px;text-align:left">last event</th></tr>' +
      rows + '</table>' +
      '<p style="color:#666;font-size:14px;margin-top:8px">routed events: <b>' + (c.routedEvents || 0) + '</b>' +
      ' · unrouted (no matching live connection — fail-closed drop): <b>' + (c.unrouted || 0) + '</b>' +
      ' · write errors: ' + (c.writeErrors || 0) +
      '<br><small>A high unrouted count with users opted in = attribution mismatch — the thing to watch when a second user authorizes the Slack app.</small></p>'
  }

  const admissions = data.admissions || []
  admEl.innerHTML = !admissions.length
    ? '<p style="color:#666">No admissions yet — no provider may open sockets. Enable one below.</p>'
    : '<table style="border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;font-size:14px">' +
      '<tr style="background:#f7fafc"><th style="padding:6px 10px;text-align:left">provider</th><th style="padding:6px 10px;text-align:left">enabled</th><th style="padding:6px 10px;text-align:left">max sockets</th></tr>' +
      admissions.map(a => '<tr><td style="padding:6px 10px">' + esc(a.provider) + '</td>' +
        '<td style="padding:6px 10px">' + (a.enabled ? '<span style="color:#138000">enabled</span>' : '<span style="color:#a00">disabled</span>') + '</td>' +
        '<td style="padding:6px 10px">' + (a.maxSockets || '—') + '</td></tr>').join('') +
      '</table>'
}

async function action (name, body) {
  const out = document.getElementById('skt-action-result')
  out.textContent = '…'
  try {
    const resp = await freezr.apiRequest('POST', '/adminapi/' + name, body || {})
    if (resp && resp.reason) {
      out.innerHTML = START_REASONS[resp.reason] || esc(resp.reason)
    } else {
      out.textContent = 'done'
    }
  } catch (e) {
    out.textContent = 'error: ' + (e && e.message)
  }
  await render()
}

let autoTimer = null

freezr.initPageScripts = function () {
  document.getElementById('skt-start').onclick = () => action('sockets_start')
  document.getElementById('skt-stop').onclick = () => action('sockets_stop')
  document.getElementById('skt-refresh').onclick = render
  document.getElementById('skt-adm-enable').onclick = () => action('set_socket_admission', {
    provider: document.getElementById('skt-adm-provider').value,
    enabled: true,
    maxSockets: parseInt(document.getElementById('skt-adm-max').value, 10) || 3
  })
  document.getElementById('skt-adm-disable').onclick = () => action('set_socket_admission', {
    provider: document.getElementById('skt-adm-provider').value,
    enabled: false
  })
  document.getElementById('skt-auto').onchange = function () {
    if (this.checked) autoTimer = setInterval(render, 5000)
    else if (autoTimer) { clearInterval(autoTimer); autoTimer = null }
  }
  render()
}
