/* global freezr, document, alert */
// Admin "Trusted Jobs" page: lists the admin's installed apps that declare jobs and lets the
// admin trust (install for in-process execution) or untrust each, with an audience.

function esc (s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

async function render () {
  const root = document.getElementById('tj-root')
  root.innerHTML = 'Loading…'
  let data
  try {
    data = await freezr.apiRequest('GET', '/adminapi/list_app_jobs')
  } catch (e) {
    root.innerHTML = 'Error loading jobs: ' + esc(e && e.message)
    return
  }
  const apps = (data && data.apps) || []
  if (!apps.length) {
    root.innerHTML = '<p>None of your installed apps declare any jobs.</p>'
    return
  }
  root.innerHTML = ''
  apps.forEach(app => {
    const sec = document.createElement('div')
    sec.style.cssText = 'margin:16px 0;padding:12px 16px;border:1px solid #e2e8f0;border-radius:8px'
    sec.innerHTML = '<h3 style="margin:0 0 8px">' + esc(app.display_name) +
      ' <span style="color:#999;font-weight:400;font-size:13px">' + esc(app.app_name) + '</span></h3>'

    app.jobs.forEach(job => {
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;align-items:center;gap:10px;margin:10px 0;flex-wrap:wrap'

      const label = document.createElement('div')
      label.style.cssText = 'flex:1;min-width:220px'
      label.innerHTML = '<b>' + esc(job.name) + '</b>' +
        (job.maxRuntime ? ' <span style="color:#999">· max ' + esc(job.maxRuntime) + '</span>' : '') +
        (job.description ? '<br><small style="color:#666">' + esc(job.description) + '</small>' : '') +
        '<br><small>' + (job.trusted ? '✅ trusted · audience: ' + esc(job.audience) : '— not trusted') + '</small>'
      row.appendChild(label)

      const sel = document.createElement('select')
      ;['admins', 'all_users'].forEach(a => {
        const o = document.createElement('option')
        o.value = a; o.textContent = a
        if (job.audience === a) o.selected = true
        sel.appendChild(o)
      })
      row.appendChild(sel)

      const trustBtn = document.createElement('button')
      trustBtn.textContent = job.trusted ? 'Re-trust' : 'Trust'
      trustBtn.onclick = async () => {
        trustBtn.disabled = true
        try {
          await freezr.apiRequest('POST', '/adminapi/trust_job', { app_name: app.app_name, job_name: job.name, audience: sel.value })
          await render()
        } catch (e) { alert('Trust failed: ' + (e && e.message)); trustBtn.disabled = false }
      }
      row.appendChild(trustBtn)

      if (job.trusted) {
        const un = document.createElement('button')
        un.textContent = 'Untrust'
        un.onclick = async () => {
          un.disabled = true
          try {
            await freezr.apiRequest('POST', '/adminapi/untrust_job', { app_name: app.app_name, job_name: job.name })
            await render()
          } catch (e) { alert('Untrust failed: ' + (e && e.message)); un.disabled = false }
        }
        row.appendChild(un)
      }

      sec.appendChild(row)
    })
    root.appendChild(sec)
  })
}

freezr.initPageScripts = async function () {
  await render()
}
