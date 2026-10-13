/* global freezr, freezrMeta */
// freezr data probe — the consent page the /creator assistant uses to look at the user's data.
//
// Served by the server IN PLACE OF an app's own page when the app URL carries ?freezr_probe=
// (appPageController.generateAppPage). None of the app's html, css or js is loaded, so nothing the
// app (or an LLM that wrote it) contains can run here, read what is shown, or press a button.
//
// It runs as the app: the page holds the app's ordinary page token, so every read goes through the
// app's own granted permissions — nothing is widened and no new credential is minted for reads.
// The user sees the exact queries and the exact rows/files, and only an explicit "Share" sends them
// back to the creator window that opened this one (window.opener.postMessage). A plain script, not
// a module: the page loader only takes absolute system paths through script_files.
(function () {
  const MAX_REQUESTS = 3
  const MAX_FILES = 2
  const DEFAULT_RECORDS = 3
  const MAX_RECORDS = 10
  const MAX_CHARS_PER_TABLE = 5000
  const MAX_FIELD_CHARS = 2000
  const MAX_FILE_BYTES = 5 * 1024 * 1024
  const MAX_TEXT_CHARS = 6000
  const ALLOWED_OPERATORS = ['$in', '$nin', '$gt', '$gte', '$lt', '$lte', '$ne', '$or', '$and']
  const VIEWABLE_MIME_RE = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/
  const TEXT_MIME_RE = /^(text\/|application\/json$)/
  const MESSAGE_TYPE = 'freezr-probe-result'

  // Set once the document is parsed (see the bottom): this script sits in <head>, where the body
  // — and #freezr-probe — does not exist yet.
  let root = null
  const appName = freezrMeta.appName
  const userId = freezrMeta.userId

  const el = (tag, cls, text) => {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text !== undefined && text !== null) e.textContent = text
    return e
  }
  const show = (...nodes) => { root.innerHTML = ''; nodes.forEach((n) => root.appendChild(n)) }

  // Only the creator may open this page. A crafted link opened any other way does nothing, and the
  // result is only ever posted back to a same-origin /creator window.
  const openerIsCreator = () => {
    try {
      return !!(window.opener && !window.opener.closed &&
        window.opener.location.origin === location.origin &&
        window.opener.location.pathname.indexOf('/creator') === 0)
    } catch (e) { return false } // cross-origin opener: reading its location throws
  }

  const decodeRequest = (raw) => {
    const b64 = String(raw || '').replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(b64 + '==='.slice((b64.length + 3) % 4)), (c) => c.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes))
  }

  // Structured filters only — the same whitelist the assistant is told about. Anything else is
  // dropped (and noted) rather than sent. /ceps/query blocks dangerous operators server-side too.
  const sanitizeFilter = (filter, notes) => {
    const cleanValue = (value) => {
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value
      if (Array.isArray(value)) return value.filter((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
      if (typeof value === 'object') {
        const out = {}
        for (const [op, v] of Object.entries(value)) {
          if (ALLOWED_OPERATORS.includes(op) && op !== '$or' && op !== '$and') out[op] = cleanValue(v)
          else notes.push('dropped unsupported operator ' + op)
        }
        return out
      }
      return undefined
    }
    const clean = (f) => {
      const out = {}
      if (!f || typeof f !== 'object' || Array.isArray(f)) return out
      for (const [key, value] of Object.entries(f)) {
        if (key === '$or' || key === '$and') {
          if (Array.isArray(value)) out[key] = value.map(clean)
        } else if (key.charAt(0) === '$') {
          notes.push('dropped unsupported operator ' + key)
        } else {
          const v = cleanValue(value)
          if (v !== undefined) out[key] = v
        }
      }
      return out
    }
    return clean(filter)
  }

  // A bare collection name is this app's; a dotted name is taken as given (the server decides).
  const qualifyTable = (table) => {
    const t = String(table || '').trim()
    if (!t || t.length > 200 || !/^[A-Za-z0-9._-]+$/.test(t)) return null
    return t.includes('.') ? t : appName + '.' + t
  }

  const validFilePath = (p) => typeof p === 'string' && p.length > 0 && p.length < 500 &&
    p.charAt(0) !== '/' && p.indexOf('\0') < 0 && !p.split('/').some((seg) => seg === '..')

  // Grant lists name other users and their grants; keep them out of what is shown and shared.
  const stripInternal = (row) => {
    const out = {}
    for (const [k, v] of Object.entries(row || {})) {
      if (k === '_accessibles' || k === '_accessible' || k.indexOf('__') === 0) continue
      out[k] = (typeof v === 'string' && v.length > MAX_FIELD_CHARS)
        ? v.slice(0, MAX_FIELD_CHARS) + '… (truncated, ' + v.length + ' chars)'
        : v
    }
    return out
  }
  const capRows = (rows) => {
    const kept = rows.map(stripInternal)
    let dropped = 0
    while (kept.length > 1 && JSON.stringify(kept).length > MAX_CHARS_PER_TABLE) { kept.pop(); dropped++ }
    return { rows: kept, dropped }
  }

  const runTable = async (request) => {
    const notes = []
    const table = qualifyTable(request.table)
    if (!table) return { kind: 'table', table: String(request.table || ''), ok: false, error: 'invalid table name' }
    const filter = sanitizeFilter(request.filter || {}, notes)
    const count = Math.min(Math.max(parseInt(request.count, 10) || DEFAULT_RECORDS, 1), MAX_RECORDS)
    const query = { table, filter, count }
    try {
      const found = await freezr.query(table, filter, { count })
      const { rows, dropped } = capRows((Array.isArray(found) ? found : []).slice(0, count))
      if (dropped) notes.push(dropped + ' record(s) left out to stay within the size limit')
      return { kind: 'table', table, query, ok: true, rows, notes }
    } catch (e) {
      return { kind: 'table', table, query, ok: false, notes, error: (e && e.message) || 'query failed' }
    }
  }

  // Reads one of THIS app's uploaded files. The file token is scoped to that one file (?file=),
  // used here, and never leaves this page — the bytes themselves are what get shared.
  const runFile = async (request) => {
    const path = request.file
    if (!validFilePath(path)) return { kind: 'file', path: String(path || ''), ok: false, error: 'invalid file path' }
    // Look the record up by query, not freezr.read: read puts the id in the URL path, and a file
    // path's slashes then break the route (/ceps/read/:app_table/:data_object_id is ONE segment).
    let record = null
    try {
      const found = await freezr.query('files', { _id: path }, { count: 1 })
      record = Array.isArray(found) && found.length ? found[0] : null
    } catch (e) { record = null }
    if (!record) return { kind: 'file', path, ok: false, error: 'no uploaded file with that path in this app' }
    const mime = record._mime_type || ''
    const size = record._file_size || 0
    const isText = TEXT_MIME_RE.test(mime)
    if (!VIEWABLE_MIME_RE.test(mime) && !isText) {
      return { kind: 'file', path, mime, size, ok: false, error: 'this file type (' + (mime || 'unknown') + ') cannot be sent to a model' }
    }
    if (size > MAX_FILE_BYTES) return { kind: 'file', path, mime, size, ok: false, error: 'too large to share (limit 5MB)' }
    try {
      const tokenResp = await freezr.apiRequest('GET', '/feps/getuserfiletoken/self/' + encodeURIComponent(appName) + '/' +
        encodeURIComponent(userId) + '?file=' + encodeURIComponent(path))
      const token = tokenResp && tokenResp.fileToken
      if (!token) throw new Error('could not get access to the file')
      const url = '/feps/userfiles/' + appName + '/' + userId + '/' + path + '?fileToken=' + encodeURIComponent(token)
      const resp = await fetch(url)
      if (!resp.ok) throw new Error('could not read the file (' + resp.status + ')')
      const blob = await resp.blob()
      if (blob.size > MAX_FILE_BYTES) throw new Error('too large to share (limit 5MB)')
      if (isText) {
        const full = await blob.text()
        const text = full.length > MAX_TEXT_CHARS ? full.slice(0, MAX_TEXT_CHARS) + '\n… (truncated, ' + full.length + ' chars)' : full
        return { kind: 'file', path, mime, size, ok: true, text }
      }
      return { kind: 'file', path, mime, size, ok: true, blob, previewUrl: VIEWABLE_MIME_RE.test(mime) && mime !== 'application/pdf' ? url : null }
    } catch (e) {
      return { kind: 'file', path, mime, size, ok: false, error: (e && e.message) || 'could not read the file' }
    }
  }

  const reply = (payload) => {
    if (openerIsCreator()) window.opener.postMessage(Object.assign({ type: MESSAGE_TYPE }, payload), location.origin)
    window.close()
  }

  const renderResult = (r) => {
    const box = el('div', 'fp-result')
    if (r.kind === 'table') {
      box.appendChild(el('div', 'fp-result-title', r.ok
        ? r.rows.length + ' record' + (r.rows.length === 1 ? '' : 's') + ' from ' + r.table
        : 'Could not read ' + r.table))
      if (r.query) box.appendChild(el('div', 'fp-query', 'Query: ' + JSON.stringify(r.query)))
      if (r.ok) box.appendChild(el('pre', 'fp-pre', JSON.stringify(r.rows, null, 2)))
      else box.appendChild(el('div', 'fp-error', r.error))
    } else {
      box.appendChild(el('div', 'fp-result-title', r.ok ? 'File: ' + r.path : 'Could not read file ' + r.path))
      if (r.mime) box.appendChild(el('div', 'fp-query', r.mime + (r.size ? ' · ' + Math.round(r.size / 1024) + 'KB' : '')))
      if (!r.ok) box.appendChild(el('div', 'fp-error', r.error))
      else if (r.text !== undefined) box.appendChild(el('pre', 'fp-pre', r.text))
      else if (r.previewUrl) { const img = el('img', 'fp-thumb'); img.src = r.previewUrl; img.alt = r.path; box.appendChild(img) }
      else box.appendChild(el('div', 'fp-muted', 'Will be attached as a document.'))
    }
    ;(r.notes || []).forEach((n) => box.appendChild(el('div', 'fp-muted', 'Note: ' + n)))
    return box
  }

  const renderGate = (request, results) => {
    const title = el('h1', 'fp-title', 'Share this with the assistant?')
    const why = el('p', 'fp-why', request.why ? '“' + request.why + '”' : 'The assistant asked to look at some of your data.')
    const warning = el('div', 'fp-warning')
    warning.appendChild(el('strong', null, '⚠️ Prompt injection risk — only share data you entered yourself, or have read with your own eyes.'))
    warning.appendChild(el('div', null, 'Anything the assistant reads becomes text it may treat as instructions. This is called prompt injection: ' +
      'a record that came from somewhere else — a shared record, an imported feed, a message, anything synced from outside — ' +
      'can contain wording crafted to redirect the assistant.'))
    const list = el('div', 'fp-results')
    results.forEach((r) => list.appendChild(renderResult(r)))
    const dest = el('p', 'fp-muted', 'This is exactly what will be sent to the assistant. It stays in that conversation and is re-sent with every later message.')
    const bar = el('div', 'fp-actions')
    const share = el('button', 'fp-share', 'Share with the assistant')
    const cancel = el('button', 'fp-cancel', "Don't share")
    share.onclick = () => {
      share.disabled = true; cancel.disabled = true
      // previewUrl carries a file token — it is for this page only and never sent.
      reply({ probeId: request.probeId, declined: false, results: results.map((r) => { const c = Object.assign({}, r); delete c.previewUrl; return c }) })
    }
    cancel.onclick = () => { share.disabled = true; cancel.disabled = true; reply({ probeId: request.probeId, declined: true }) }
    bar.appendChild(share); bar.appendChild(cancel)
    show(title, why, warning, list, dest, bar)
  }

  const run = async () => {
    if (!openerIsCreator()) {
      show(el('h1', 'fp-title', 'Nothing to show'),
        el('p', 'fp-why', 'This page is opened by the freezr creator when its assistant asks to look at your data. You can close this window.'))
      return
    }
    let request
    try { request = decodeRequest(new URLSearchParams(location.search).get('freezr_probe')) } catch (e) { request = null }
    if (!request || !Array.isArray(request.requests) || !request.requests.length) {
      show(el('h1', 'fp-title', 'Nothing to look up'), el('p', 'fp-why', 'The request was empty or unreadable.'))
      return
    }
    show(el('p', 'fp-muted', 'Looking up your data…'))
    const requests = request.requests.slice(0, MAX_REQUESTS)
    let files = 0
    const results = []
    for (const r of requests) {
      if (r && r.file !== undefined) {
        if (++files > MAX_FILES) { results.push({ kind: 'file', path: String(r.file), ok: false, error: 'only ' + MAX_FILES + ' files per look' }); continue }
        results.push(await runFile(r))
      } else {
        results.push(await runTable(r || {}))
      }
    }
    renderGate(request, results)
  }

  // script_files load as plain scripts in <head>, before <body> is parsed — unlike app modules, which
  // the browser defers. So wait for the document before touching #freezr-probe.
  const start = () => {
    root = document.getElementById('freezr-probe')
    if (root) run()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()
