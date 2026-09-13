/* global freezr, freezrMeta */
// Admin Console Logs - toggle runtime console-log categories (in-memory, non-persistent)

// Transport diagnostic for long-running SSE responses (e.g. /feps/llm/ask dying on Azure).
// Call from this page's browser console — no curl needed, the page's session/token authenticates:
//   freezrSseStreamTest()                 // 5-min padded run: should tick every ~15s and finish
//   freezrSseStreamTest({ pad: false })   // control run with tiny unpadded ticks
// Reading the results:
//   - padded run SURVIVES, ticks ~15s apart          -> transport fixed; long llm calls will hold
//   - pad:false run DROPS at ~230s (or ~4 min)       -> host kills idle streams + buffers small
//                                                       chunks: confirms the heartbeat-padding fix
//   - padded run drops too, or ticks arrive in one   -> something still buffers whole responses
//     burst at the end                                  (e.g. iisnode on Windows App Service) —
//                                                       padding can't fix that layer; report back
window.freezrSseStreamTest = async function ({ secs = 300, pad = true } = {}) {
  const token = freezr.utils.getCookie('app_token_' + freezrMeta.userId)
  const t0 = Date.now()
  const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1) + 's'
  console.log('sseTest: starting a ' + secs + 's stream (pad=' + pad + ') — expect a tick every ~15s')
  const resp = await fetch('/adminapi/sse_stream_test?secs=' + secs + '&pad=' + pad, {
    headers: token ? { Authorization: 'Bearer ' + token } : {}
  })
  if (!resp.ok || !resp.body) {
    console.error('sseTest: request failed with status ' + resp.status)
    return
  }
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let lastArrival = Date.now()
  let maxGapMs = 0
  let sawDone = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const gapMs = Date.now() - lastArrival
      lastArrival = Date.now()
      if (gapMs > maxGapMs) maxGapMs = gapMs
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith('data:')) continue // skip padding comments
        try {
          const data = JSON.parse(line.slice(5))
          if (data.type === 'tick') {
            console.log('sseTest +' + elapsed() + ': tick ' + data.n +
              ' (gap since previous bytes: ' + (gapMs / 1000).toFixed(1) + 's)')
          } else if (data.type === 'done') {
            sawDone = true
          }
        } catch (e) { /* partial line — ignored */ }
      }
    }
  } catch (e) {
    console.error('sseTest +' + elapsed() + ': stream errored — ' + (e.message || e))
  }
  console.log('sseTest RESULT: ' + (sawDone
    ? 'SURVIVED the full ' + secs + 's — transport OK (max quiet gap ' + (maxGapMs / 1000).toFixed(1) + 's)'
    : 'CONNECTION DROPPED at +' + elapsed() + ' before the server finished — an intermediary killed the stream (max gap ' + (maxGapMs / 1000).toFixed(1) + 's)'))
}

freezr.initPageScripts = function () {
  loadFlags()
  document.getElementById('saveFlags').onclick = saveFlags
}

const loadFlags = async function () {
  try {
    const data = await freezr.apiRequest('GET', '/adminapi/get_console_flags')
    renderFlags(data.categories || [], data.flags || {}, data.serverStartedAt)
    showError('')
  } catch (error) {
    showError('Could not load console flags: ' + (error?.message || error))
  }
}

const renderFlags = function (categories, flags, serverStartedAt) {
  document.getElementById('serverStartedAt').textContent = serverStartedAt || 'unknown'

  const list = document.getElementById('categoryList')
  list.innerHTML = ''
  categories.forEach(function (cat) {
    const row = document.createElement('label')
    row.style.cssText = 'display: flex; align-items: flex-start; gap: 0.6rem; margin-bottom: 1rem; cursor: pointer;'

    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.id = 'flag_' + cat.key
    checkbox.checked = !!flags[cat.key]
    checkbox.style.marginTop = '0.2rem'

    const text = document.createElement('div')
    text.innerHTML = '<strong>' + cat.label + '</strong><br/>' +
      '<span style="color: var(--freezr-text-muted); font-size: 14px;">' + (cat.description || '') + '</span>'

    row.appendChild(checkbox)
    row.appendChild(text)
    list.appendChild(row)
  })
}

const saveFlags = async function () {
  const flags = {}
  document.querySelectorAll('#categoryList input[type="checkbox"]').forEach(function (cb) {
    flags[cb.id.replace('flag_', '')] = cb.checked
  })
  try {
    await freezr.apiRequest('POST', '/adminapi/set_console_flags', { flags })
    setStatus('Saved.')
    loadFlags() // re-fetch to reflect the server's applied state
  } catch (error) {
    showError('Could not save console flags: ' + (error?.message || error))
  }
}

const setStatus = function (text) {
  const el = document.getElementById('statusMsg')
  if (el) el.textContent = text || ''
}

const showError = function (text) {
  const errorBox = document.getElementById('errorBox')
  if (!errorBox) return
  errorBox.style.display = text ? 'block' : 'none'
  errorBox.innerHTML = text || ''
}
