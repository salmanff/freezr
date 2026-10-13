// "Explain changes": send two versions of an app to the model and get back a plain-language account
// of what changed, including a security review. Works on any pair the compare view can show (two
// snapshots, or a snapshot against the current files); the upload flow is just one way in.
//
// This module is deliberately free of browser globals at the top level so its prompt builder and
// diff helpers can be unit-tested in node. `runChangeReview` receives the LLM call and the record
// writer as parameters for the same reason.
//
// Collaboration note: the review is saved as a history entry (action 'change_review'), so it is
// exported with the chat and visible to whoever the history is shared with. Nothing here depends on
// a user clicking — a future automation can call runChangeReview with the same inputs.

// Files whose both sides together fit under this are sent in full; larger ones go as a unified diff.
export const FULL_FILE_LIMIT = 12000
// Hard ceiling on the file material in one prompt; beyond it, files are summarised by status only.
export const PROMPT_BUDGET = 160000
const DIFF_CONTEXT = 3

// --- line diff → unified hunks ----------------------------------------------------------------
// Same greedy line matcher the file panel uses for display; good enough for a model to read.
export const lineDiff = (oldText, newText) => {
  const oldLines = String(oldText || '').split('\n')
  const newLines = String(newText || '').split('\n')
  const out = []
  let oi = 0
  let ni = 0
  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      out.push({ type: 'same', text: oldLines[oi], oldNum: oi + 1, newNum: ni + 1 })
      oi++; ni++
      continue
    }
    let found = false
    const lookAhead = Math.min(40, Math.max(oldLines.length - oi, newLines.length - ni))
    for (let d = 1; d <= lookAhead && !found; d++) {
      if (ni + d < newLines.length && oldLines[oi] === newLines[ni + d]) {
        for (let k = 0; k < d; k++) out.push({ type: 'add', text: newLines[ni + k], newNum: ni + k + 1 })
        ni += d
        found = true
      } else if (oi + d < oldLines.length && oldLines[oi + d] === newLines[ni]) {
        for (let k = 0; k < d; k++) out.push({ type: 'remove', text: oldLines[oi + k], oldNum: oi + k + 1 })
        oi += d
        found = true
      }
    }
    if (!found) {
      if (oi < oldLines.length) { out.push({ type: 'remove', text: oldLines[oi], oldNum: oi + 1 }); oi++ }
      if (ni < newLines.length) { out.push({ type: 'add', text: newLines[ni], newNum: ni + 1 }); ni++ }
    }
  }
  return out
}

export const unifiedDiff = (oldText, newText, context = DIFF_CONTEXT) => {
  const lines = lineDiff(oldText, newText)
  const keep = new Array(lines.length).fill(false)
  lines.forEach((l, i) => {
    if (l.type === 'same') return
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = true
  })
  const out = []
  let inHunk = false
  lines.forEach((l, i) => {
    if (!keep[i]) { inHunk = false; return }
    if (!inHunk) {
      out.push('@@ old line ' + (l.oldNum || '?') + ' / new line ' + (l.newNum || '?') + ' @@')
      inHunk = true
    }
    out.push((l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' ') + l.text)
  })
  return out.join('\n')
}

// --- prompt ------------------------------------------------------------------------------------
const manifestOf = (compare, side) => {
  const m = (compare.files || []).find((f) => f.path === 'manifest.json')
  if (!m) return null
  return side === 'b' ? (m.b ?? null) : (m.a ?? null)
}

const permissionSummary = (manifestText) => {
  try {
    const m = JSON.parse(manifestText || '{}')
    const perms = Array.isArray(m.permissions) ? m.permissions : []
    return perms.map((p) => (p.name || '?') + ': ' + (p.type || '?') + (p.table_id ? ' on ' + [].concat(p.table_id).join(', ') : '')).join('\n') || '(none)'
  } catch (e) {
    return '(manifest not parseable)'
  }
}

export const buildChangeReviewPrompt = ({ appName, compare, note, manifestB, fullFileLimit = FULL_FILE_LIMIT, budget = PROMPT_BUDGET }) => {
  const changed = (compare.files || []).filter((f) => f.status !== 'unchanged')
  const labelA = compare.a?.label || compare.a?.id || 'A'
  const labelB = compare.b?.label || compare.b?.id || 'B'
  const parts = []
  parts.push('# Change review request')
  parts.push('App: ' + appName)
  parts.push('Version A (before): ' + labelA + (compare.a?.timestamp ? ' — ' + compare.a.timestamp : ''))
  parts.push('Version B (after): ' + labelB + (compare.b?.timestamp ? ' — ' + compare.b.timestamp : ''))
  const c = compare.counts || {}
  parts.push('Changed files: ' + changed.length + ' (' + [c.modified && c.modified + ' modified', c.added && c.added + ' added', c.deleted && c.deleted + ' deleted'].filter(Boolean).join(', ') + ')')
  if (note && note.trim()) parts.push('\n## Note from the person asking\n' + note.trim())

  const manifestTextB = manifestB ?? manifestOf(compare, 'b')
  const manifestTextA = manifestOf(compare, 'a')
  if (manifestTextB) {
    parts.push('\n## manifest.json of version B (complete)\n```json\n' + manifestTextB + '\n```')
    parts.push('Permissions in B:\n' + permissionSummary(manifestTextB))
    if (manifestTextA !== null && manifestTextA !== undefined && manifestTextA !== manifestTextB) {
      parts.push('Permissions in A (for comparison):\n' + permissionSummary(manifestTextA))
    }
  }

  parts.push('\n## Changed files')
  let used = parts.join('\n').length
  const omitted = []
  for (const f of changed) {
    const header = '\n### ' + f.path + ' — ' + f.status.toUpperCase() + (f.binary ? ' (binary, ' + (f.aSize ?? 0) + ' → ' + (f.bSize ?? 0) + ' bytes; contents not shown)' : '')
    if (f.binary) { parts.push(header); used += header.length; continue }
    const a = f.a ?? ''
    const b = f.b ?? ''
    let body
    if (f.status === 'added') body = '```\n' + b + '\n```'
    else if (f.status === 'deleted') body = '(deleted; it was ' + a.length + ' chars)\n```\n' + a + '\n```'
    else if (a.length + b.length <= fullFileLimit) body = 'BEFORE:\n```\n' + a + '\n```\nAFTER:\n```\n' + b + '\n```'
    else body = 'Unified diff (file too large to send whole):\n```diff\n' + unifiedDiff(a, b) + '\n```'
    if (used + header.length + body.length > budget) { omitted.push(f.path + ' (' + f.status + ')'); continue }
    parts.push(header + '\n' + body)
    used += header.length + body.length
  }
  if (omitted.length) parts.push('\n### Not included (prompt size limit): ' + omitted.join(', ') + '. Say that these were not reviewed.')

  parts.push(`
## What to return
Write for the app's owner, who may not be a programmer, in Markdown with exactly these sections:

1. **Summary** — two or three sentences on what this change does overall.
2. **What changed, file by file** — one short bullet per file: the user-visible effect first, then the technical change.
3. **Manifest and permissions** — any change to permissions, tables, app name/version, jobs, or anything else in manifest.json; say "No manifest changes" if none.
4. **Security review** — check for and report, with a severity (high / medium / low / none found) and the file and line or snippet:
   - new or changed network calls, external URLs, or third-party scripts/CDNs
   - data leaving the app (to other apps, servers, or into messages/exports)
   - eval, new Function, innerHTML/outerHTML/document.write with non-constant input, or inline scripts
   - handling of tokens, passwords, keys, or other credentials
   - anything that widens what the app can read or write (permissions, table access, file access)
   - obfuscated or unexplained code
   If nothing is concerning, say so plainly.
5. **Questions or things to verify** — anything you could not determine from the files.

Be concrete and quote short snippets where it helps. Do not speculate about files you were not shown.`)

  return parts.join('\n')
}

// --- rendering (small Markdown subset, safe) -------------------------------------------------
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const renderMarkdownLite = (md) => {
  if (!md) return ''
  const blocks = []
  let text = escapeHtml(md).replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => {
    blocks.push('<pre class="chat-code"><code>' + code + '</code></pre>')
    return '\u0000' + (blocks.length - 1) + '\u0000'
  })
  text = text
    .replace(/`([^`\n]+)`/g, '<code class="chat-inline-code">$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  const lines = text.split('\n')
  const out = []
  let inList = false
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    const li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line)
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true }
      out.push('<li>' + li[1] + '</li>')
      continue
    }
    if (inList) { out.push('</ul>'); inList = false }
    if (h) { out.push('<h' + (h[1].length + 2) + '>' + h[2] + '</h' + (h[1].length + 2) + '>'); continue }
    if (!line.trim()) { out.push(''); continue }
    out.push('<p>' + line + '</p>')
  }
  if (inList) out.push('</ul>')
  return out.join('\n').replace(/\u0000(\d+)\u0000/g, (m, i) => blocks[Number(i)])
}

// --- run ---------------------------------------------------------------------------------------
// ask:        (messages, options) => llmResult   (freezr.llm.ask, injected)
// saveEntry:  (entry) => created record          (freezr.create('appUpdates', …), injected)
export const runChangeReview = async ({ appName, compare, note, askOptions, ask, saveEntry, recordMeta }) => {
  const prompt = buildChangeReviewPrompt({ appName, compare, note })
  const messages = [
    { role: 'user', content: 'You are reviewing a change to a small web app built on the freezr platform. Answer only from the material provided.' },
    { role: 'assistant', content: 'Understood. Send the change.' },
    { role: 'user', content: prompt }
  ]
  const result = await ask(messages, askOptions || {})
  if (!result || result.error || !result.success && !result.content && !result.text) {
    throw new Error(result?.error || 'The model returned no review.')
  }
  const text = typeof result.content === 'string' ? result.content : (result.text || result.response || '')
  const meta = result.meta || {}
  const entry = {
    ...(recordMeta ? recordMeta() : {}),
    appName,
    action: 'change_review',
    summary: 'AI review: ' + (compare.a?.label || 'A') + ' → ' + (compare.b?.label || 'B'),
    thread: 'AI change review',
    review: text,
    compared: {
      a: { id: compare.a?.id || null, label: compare.a?.label || null, timestamp: compare.a?.timestamp || null },
      b: { id: compare.b?.id || null, label: compare.b?.label || null, timestamp: compare.b?.timestamp || null }
    },
    filesChanged: (compare.files || []).filter((f) => f.status !== 'unchanged').map((f) => f.path),
    note: note && note.trim() ? note.trim() : undefined,
    llmProvider: meta.provider || undefined,
    llmModel: meta.model || undefined,
    llmModelFamily: meta.modelFamily || undefined,
    usage: meta.rawUsage || undefined,
    tokensUsed: meta.tokensUsed || undefined,
    cost: meta.cost || undefined,
    promptChars: prompt.length,
    timestamp: new Date().toISOString()
  }
  let saved = null
  if (saveEntry) {
    try { saved = await saveEntry(entry) } catch (e) { console.warn('Could not save change review:', e) }
  }
  return { text, entry: { ...entry, _id: saved?._id || saved?.id || null }, meta }
}
