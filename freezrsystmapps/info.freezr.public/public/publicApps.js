document.addEventListener('DOMContentLoaded', function () {
  const container = document.getElementById('freezr_public_apps_container')
  const loading = document.getElementById('freezr_public_apps_loading')
  const empty = document.getElementById('freezr_public_apps_empty')
  if (!container) return

  const escHtml = (s) => {
    const d = document.createElement('div')
    d.textContent = s || ''
    return d.innerHTML
  }

  const renderCard = (rec) => {
    const owner = rec._data_owner || rec.data_owner || ''
    const appName = rec.publishedAppName || ''
    const displayName = rec.display_name || appName
    const description = rec.description || ''
    const releaseNotes = rec.release_notes || ''
    const version = rec.version || ''
    const logoUrl = '/@' + owner + '/app/' + appName + '/logo'
    const downloadUrl = '/@' + owner + '/app/' + appName
    const letter = (displayName || '?').charAt(0).toUpperCase()
    const dateStr = rec._date_published ? new Date(rec._date_published).toLocaleDateString() : ''

    return '<div class="freezr_app_card">' +
      '<div class="freezr_app_card_header">' +
        '<img class="freezr_app_card_logo" src="' + escHtml(logoUrl) + '" alt="' + escHtml(displayName) + '" onerror="this.outerHTML=\'<div class=\\\'freezr_app_card_logo freezr_app_card_logo_placeholder\\\'><span>' + escHtml(letter) + '</span></div>\'">' +
        '<div class="freezr_app_card_title_block">' +
          '<h3 class="freezr_app_card_name">' + escHtml(displayName) + '</h3>' +
          '<span class="freezr_app_card_author">by @' + escHtml(owner) + '</span>' +
          (description ? '<p class="freezr_app_card_desc">' + escHtml(description) + '</p>' : '') +
        '</div>' +
      '</div>' +
      (releaseNotes ? '<p class="freezr_app_card_notes">' + escHtml(releaseNotes) + '</p>' : '') +
      '<div class="freezr_app_card_footer">' +
        '<span class="freezr_app_card_version">v' + escHtml(version) + '</span>' +
        (dateStr ? '<span class="freezr_app_card_date">' + escHtml(dateStr) + '</span>' : '') +
        '<a class="freezr_app_card_download" href="' + escHtml(downloadUrl) + '">Download</a>' +
      '</div>' +
    '</div>'
  }

  const renderVersionSummary = (rec) => {
    const version = rec.version || ''
    const releaseNotes = rec.release_notes || ''
    const dateStr = rec._date_published ? new Date(rec._date_published).toLocaleDateString() : ''
    const publicId = rec._id || ''
    const downloadUrl = publicId ? '/' + publicId : ''

    return '<div class="freezr_app_version_summary">' +
      '<span class="freezr_app_card_version">v' + escHtml(version) + '</span>' +
      (dateStr ? '<span class="freezr_app_card_date">' + escHtml(dateStr) + '</span>' : '') +
      (releaseNotes ? '<span class="freezr_app_version_notes">' + escHtml(releaseNotes) + '</span>' : '') +
      (downloadUrl ? '<a class="freezr_app_version_dl" href="' + escHtml(downloadUrl) + '">↓</a>' : '') +
    '</div>'
  }

  const fetchApps = async () => {
    const postBody = {
      q: {
        requestor_app: 'info.freezr.creator',
        permission_name: 'publish_app'
      },
      count: 500
    }
    console.log('publicApps: fetching from /public/query with body:', postBody)
    try {
      const resp = await fetch('/public/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(postBody)
      })
      console.log('publicApps: fetch response status:', resp.status, resp.statusText)
      const text = await resp.text()
      console.log('publicApps: raw response (first 500 chars):', text.substring(0, 500))
      let data
      try {
        data = JSON.parse(text)
      } catch (parseErr) {
        console.error('publicApps: failed to parse JSON:', parseErr)
        return []
      }
      console.log('publicApps: parsed data keys:', Object.keys(data))
      const results = (data && data.results) || []
      console.log('publicApps: got', results.length, 'results')
      if (results.length > 0) {
        console.log('publicApps: first result keys:', Object.keys(results[0]))
        console.log('publicApps: first result:', results[0])
      }
      return results
    } catch (e) {
      console.error('publicApps: fetch error:', e)
      return []
    }
  }

  const groupByApp = (records) => {
    const appRecords = records.filter(r => !r.isLogo)

    const groups = {}
    appRecords.forEach(rec => {
      const owner = rec._data_owner || rec.data_owner || ''
      const key = owner + '/' + (rec.publishedAppName || '')
      if (!groups[key]) groups[key] = []
      groups[key].push(rec)
    })

    Object.keys(groups).forEach(key => {
      groups[key].sort((a, b) => {
        const aDate = typeof a._date_published === 'number' ? a._date_published : new Date(a._date_published || 0).getTime()
        const bDate = typeof b._date_published === 'number' ? b._date_published : new Date(b._date_published || 0).getTime()
        return bDate - aDate
      })
    })

    const sorted = Object.entries(groups).sort((a, b) => {
      const aFirst = a[1][0]
      const bFirst = b[1][0]
      const aDate = typeof aFirst?._date_published === 'number' ? aFirst._date_published : new Date(aFirst?._date_published || 0).getTime()
      const bDate = typeof bFirst?._date_published === 'number' ? bFirst._date_published : new Date(bFirst?._date_published || 0).getTime()
      return bDate - aDate
    })
    return sorted
  }

  const render = (groups) => {
    if (groups.length === 0) {
      loading.style.display = 'none'
      empty.style.display = 'block'
      return
    }

    let html = ''
    groups.forEach(([key, versions]) => {
      const latest = versions[0]
      const older = versions.slice(1)

      html += '<div class="freezr_app_group">'
      html += renderCard(latest)

      if (older.length > 0) {
        const groupId = 'app_older_' + key.replace(/[^a-zA-Z0-9]/g, '_')
        html += '<div class="freezr_app_older_toggle" data-target="' + escHtml(groupId) + '">' +
          older.length + ' older version' + (older.length > 1 ? 's' : '') + ' ▸</div>'
        html += '<div id="' + escHtml(groupId) + '" class="freezr_app_older_list" style="display:none;">'
        older.forEach(v => { html += renderVersionSummary(v) })
        html += '</div>'
      }

      html += '</div>'
    })

    container.innerHTML = html
    loading.style.display = 'none'
    container.style.display = ''

    container.querySelectorAll('.freezr_app_older_toggle').forEach(btn => {
      btn.onclick = () => {
        const target = document.getElementById(btn.dataset.target)
        if (!target) return
        const isHidden = target.style.display === 'none'
        target.style.display = isHidden ? '' : 'none'
        btn.textContent = btn.textContent.replace(isHidden ? '▸' : '▾', isHidden ? '▾' : '▸')
      }
    })
  }

  fetchApps().then(records => {
    console.log('publicApps: total records fetched:', records.length)
    const groups = groupByApp(records)
    console.log('publicApps: grouped into', groups.length, 'apps:', groups.map(g => g[0]))
    render(groups)
  }).catch(err => {
    console.error('publicApps: unhandled error:', err)
    loading.textContent = 'Error loading apps.'
  })
})
