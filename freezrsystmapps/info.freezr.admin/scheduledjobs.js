/* global freezr, document */
// Admin "Scheduled Jobs" page: list all scheduled-job rows + force a scheduler tick (debug).

function esc (s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

function relTime (secs) {
  if (secs == null) return '—'
  if (secs <= 0) return 'due now (' + Math.abs(secs) + 's ago)'
  if (secs < 90) return 'in ' + secs + 's'
  if (secs < 5400) return 'in ' + Math.round(secs / 60) + ' min'
  return 'in ' + Math.round(secs / 3600) + ' h'
}

function statusBadge (job) {
  if (!job.enabled) return '<span style="color:#a00">disabled</span>'
  if (job.last_status === 'ok') return '<span style="color:#138000">ok</span>'
  if (job.last_status === 'waiting') return '<span style="color:#b7791f">waiting</span>'
  if (job.last_status === 'error') return '<span style="color:#a00">error</span>'
  return '<span style="color:#888">not yet run</span>'
}

async function render () {
  const root = document.getElementById('sched-root')
  const statusEl = document.getElementById('sched-status')
  root.innerHTML = 'Loading…'
  let data
  try {
    data = await freezr.apiRequest('GET', '/adminapi/list_scheduled_jobs')
  } catch (e) {
    root.innerHTML = 'Error loading scheduled jobs: ' + esc(e && e.message)
    return
  }

  statusEl.innerHTML = data.scheduler_disabled
    ? '⛔ <b>Scheduling is paused</b> (admin pref). Enable it on the Preferences page → Background Jobs.'
    : '✅ Scheduling is enabled. The heartbeat runs ~every 60s, so a due job runs within a minute or two of its scheduled time.'

  const jobs = data.jobs || []
  if (!jobs.length) {
    root.innerHTML = '<p>No scheduled jobs. A job is scheduled when a user grants its <code>run_job</code> permission and the app declares a <code>schedule</code> in its manifest.</p>'
    return
  }

  const rows = jobs.map(j => {
    const next = j.next_run_iso ? (esc(j.next_run_iso.replace('T', ' ').replace(/\..*/, '')) + ' UTC<br><small>' + relTime(j.due_in_seconds) + '</small>') : '—'
    const last = j.last_run_iso ? esc(j.last_run_iso.replace('T', ' ').replace(/\..*/, '')) : '—'
    const err = j.last_error ? '<br><small style="color:#a00">' + esc(j.last_error) + '</small>' : ''
    const fails = j.consecutive_failures ? ' <small>(' + j.consecutive_failures + ' fails)</small>' : ''
    return '<tr style="border-top:1px solid #eee">' +
      '<td style="padding:8px">' + esc(j.app) + '<br><small style="color:#999">' + esc(j.job) + '</small></td>' +
      '<td style="padding:8px">' + esc(j.user) + '</td>' +
      '<td style="padding:8px">' + esc(j.schedule) + '</td>' +
      '<td style="padding:8px">' + statusBadge(j) + fails + err + '</td>' +
      '<td style="padding:8px">' + next + '</td>' +
      '<td style="padding:8px">' + last + '</td>' +
      '</tr>'
  }).join('')

  root.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:14px">' +
    '<thead><tr style="text-align:left;color:#666">' +
    '<th style="padding:8px">App / Job</th><th style="padding:8px">User</th><th style="padding:8px">Schedule</th>' +
    '<th style="padding:8px">Last status</th><th style="padding:8px">Next run</th><th style="padding:8px">Last run</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>'
}

freezr.initPageScripts = async function () {
  document.getElementById('refresh-btn').addEventListener('click', render)
  document.getElementById('run-now-btn').addEventListener('click', async () => {
    const out = document.getElementById('run-now-result')
    out.textContent = 'Running…'
    try {
      const res = await freezr.apiRequest('POST', '/adminapi/run_scheduler_now', {})
      const ran = (res && res.ran) || []
      out.textContent = res.skipped ? ('skipped: ' + res.skipped) : (ran.length ? (ran.length + ' job(s) processed') : 'nothing was due')
      await render()
    } catch (e) {
      out.textContent = 'Error: ' + (e && e.message)
    }
  })
  await render()
}
