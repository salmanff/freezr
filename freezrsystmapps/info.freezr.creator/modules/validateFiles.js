/* global freezr, CSSStyleSheet, DOMParser */
// Post-build validation (freezr_creator_selfcheck_plan_v1.md B1).
//
// Two halves, split by what can actually break a page:
//  - SERVER (/creatorapi/validate_app_files): JS syntax, JSON, unresolved relative imports. These
//    are the load-breaking class — a syntax error means the import silently rejects and the user
//    gets a blank page.
//  - BROWSER (here): CSS and HTML, using the engine's own parsers. Neither can break a load —
//    both are error-tolerant by specification — so these are ADVISORY. The value is that the
//    browser is the authority on what it would silently discard.
//
// Nothing here executes generated code: replaceSync() parses a stylesheet without applying it to
// the page, and DOMParser never runs scripts or fetches subresources.

// Split CSS into top-level rules without a parser: track strings, comments and brace depth.
const splitTopLevelRules = (css) => {
  const rules = []
  let depth = 0
  let start = 0
  let inString = null
  let inComment = false
  for (let i = 0; i < css.length; i++) {
    const c = css[i]
    const next = css[i + 1]
    if (inComment) {
      if (c === '*' && next === '/') { inComment = false; i++ }
      continue
    }
    if (inString) {
      if (c === '\\') { i++; continue }
      if (c === inString) inString = null
      continue
    }
    if (c === '/' && next === '*') { inComment = true; i++; continue }
    if (c === '"' || c === "'") { inString = c; continue }
    if (c === '{') { depth++; continue }
    if (c === '}') {
      depth--
      if (depth === 0) {
        const text = css.slice(start, i + 1).trim()
        if (text) rules.push(text)
        start = i + 1
      }
    }
  }
  const tail = css.slice(start).trim()
  if (tail) rules.push(tail) // e.g. a truncated final rule, or a stray @import
  return rules
}

/**
 * CSS rules the engine would silently DROP. The parser does not throw on bad CSS — it discards
 * the offending rule — so detection is a round trip: parse each rule alone and see if it survives.
 */
export const findDroppedCssRules = (cssText) => {
  if (typeof CSSStyleSheet !== 'function') return []
  let probe
  try {
    probe = new CSSStyleSheet()
  } catch (e) {
    return [] // constructable stylesheets unavailable — skip rather than guess
  }
  const dropped = []
  for (const rule of splitTopLevelRules(cssText)) {
    try {
      probe.replaceSync(rule)
      if (probe.cssRules.length === 0) dropped.push(rule.slice(0, 120))
    } catch (e) {
      dropped.push(rule.slice(0, 120))
    }
  }
  return dropped
}

/**
 * Advisory HTML checks: structure the parser had to repair, and ids the app's JS looks for but
 * that no element defines.
 */
export const checkHtml = (htmlText, jsSources = []) => {
  const notes = []
  if (typeof DOMParser !== 'function') return notes
  let doc
  try {
    doc = new DOMParser().parseFromString(htmlText, 'text/html')
  } catch (e) {
    return notes
  }
  const parserErrors = doc.querySelectorAll('parsererror')
  if (parserErrors.length) notes.push('HTML parser reported an error in the markup')

  // getElementById targets that do not exist in the document.
  const definedIds = new Set([...doc.querySelectorAll('[id]')].map((el) => el.id))
  const wanted = new Set()
  for (const src of jsSources) {
    const re = /getElementById\(\s*['"]([^'"]+)['"]\s*\)/g
    let m
    while ((m = re.exec(src)) !== null) wanted.add(m[1])
  }
  for (const id of wanted) {
    if (!definedIds.has(id)) notes.push('JS calls getElementById("' + id + '") but no element has that id')
  }
  return notes
}

/**
 * Validate the app after install: server-side load-breaking checks plus browser-side advisory ones.
 * @returns {{ errors: Array, advisories: Array, parser: string|null }}
 */
export const validateApp = async (appName, allFiles = []) => {
  let errors = []
  let parser = null
  try {
    const result = await freezr.apiRequest('GET', '/creatorapi/validate_app_files?app_name=' + encodeURIComponent(appName))
    if (result && !result.error) {
      errors = result.errors || []
      parser = result.parser || null
    } else if (result?.error) {
      console.warn('validate_app_files failed (continuing):', result.error)
    }
  } catch (e) {
    console.warn('validate_app_files threw (continuing):', e)
  }

  const advisories = []
  const jsSources = allFiles.filter((f) => /\.(js|mjs)$/.test(f.path) && f.content).map((f) => f.content)
  for (const file of allFiles) {
    if (!file.content || file.path.startsWith('imported/')) continue
    if (file.path.endsWith('.css')) {
      for (const rule of findDroppedCssRules(file.content)) {
        advisories.push({ type: 'css_dropped', path: file.path, message: 'This rule would be ignored by the browser: ' + rule })
      }
    } else if (file.path.endsWith('.html')) {
      for (const note of checkHtml(file.content, jsSources)) {
        advisories.push({ type: 'html', path: file.path, message: note })
      }
    }
  }

  return { errors, advisories, parser }
}

// One line per problem, for feeding back to the model.
export const formatValidationForModel = ({ errors = [], advisories = [] }) => {
  const lines = []
  for (const e of errors) {
    lines.push('• ' + e.path + (e.line ? ' line ' + e.line : '') + ' — ' + e.message)
  }
  for (const a of advisories) {
    lines.push('• (advisory) ' + a.path + ' — ' + a.message)
  }
  return lines.join('\n')
}

export default { validateApp, formatValidationForModel, findDroppedCssRules, checkHtml }
