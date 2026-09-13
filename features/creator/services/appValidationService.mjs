// App file validation (freezr_creator_selfcheck_plan_v1.md B1).
//
// Answers one question: would the files the LLM just wrote actually load? It only ever PARSES —
// nothing here executes a single line of generated code, so a malicious or broken file can do
// no more than produce an error message.
//
// Scope is deliberately the load-breaking class:
//   - JS syntax        — a syntax error means a blank page (the import silently rejects)
//   - manifest JSON    — an unparseable manifest breaks install
//   - relative imports — importing a file that was never written also means a blank page
// CSS and HTML are NOT checked here: both are error-tolerant by specification (the browser drops
// an invalid rule / repairs bad nesting and carries on), so they cannot produce the blank-page
// failure. They are checked advisorily in the browser, where the real parsers live.
//
// PARSER: acorn is used when available — it is a pure-JS parser (no V8 codegen, no execution
// path at all) and it understands ES modules, which is what the creator writes. It is present in
// node_modules as a transitive dependency rather than a declared one, so this module treats it as
// OPTIONAL and degrades to Node's built-in vm.Script (compile-only; also never executes) for
// non-module files. Nothing new is installed either way.

import vm from 'vm'

let acornParse = null
try {
  const acorn = await import('acorn')
  acornParse = acorn.parse || (acorn.default && acorn.default.parse) || null
} catch (e) {
  console.warn('appValidationService: acorn unavailable — ES module files will not be syntax-checked')
}

// Files the model never writes; skipping them keeps a broken vendor bundle from being blamed on the LLM.
const SKIP_PREFIXES = ['imported/', 'REFERENCE/', 'vendor/', '__']
const MAX_FILE_BYTES = 1024 * 1024 // parser DoS guard; real app files are far smaller

const isSkipped = (p) => SKIP_PREFIXES.some((pre) => p.startsWith(pre))
const isJs = (p) => p.endsWith('.js') || p.endsWith('.mjs')
const looksLikeModule = (code) => /^\s*(import\s|import\(|export\s|export\{)/m.test(code)

/**
 * Syntax-check one JS file. Returns null when fine, else { path, line, column, message }.
 */
export const checkJsSyntax = (filePath, code) => {
  // Guard the file type here as well as in the caller: this is exported, so it must be safe to
  // hand any path. A non-JS file is "not applicable", not "no error found".
  if (!isJs(filePath)) return null
  if (typeof code !== 'string' || !code.trim()) return null
  if (code.length > MAX_FILE_BYTES) {
    return { path: filePath, message: 'File is too large to validate (' + code.length + ' bytes)' }
  }
  if (acornParse) {
    try {
      // sourceType 'module' also accepts plain scripts, so one pass covers both.
      acornParse(code, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true })
      return null
    } catch (e) {
      return {
        path: filePath,
        line: e.loc?.line ?? null,
        column: e.loc?.column ?? null,
        message: e.message.replace(/\s*\(\d+:\d+\)\s*$/, '')
      }
    }
  }
  // Fallback: vm.Script COMPILES without running, but cannot parse import/export.
  if (looksLikeModule(code)) return null
  try {
    new vm.Script(code, { filename: filePath }) // eslint-disable-line no-new
    return null
  } catch (e) {
    if (!(e instanceof SyntaxError)) return null
    return { path: filePath, line: e.lineNumber ?? null, column: null, message: e.message }
  }
}

/**
 * Collect the relative specifiers this file imports / references, with line numbers.
 * Regex-based on purpose: it must work on a file that does NOT parse, so the report can say both
 * "line 12 is a syntax error" and "./missing.js was never written".
 */
const relativeRefsOf = (filePath, code) => {
  const refs = []
  const add = (spec, index) => {
    if (!spec || !spec.startsWith('.')) return // bare/absolute/URL — not ours to resolve
    const line = code.slice(0, index).split('\n').length
    refs.push({ spec, line })
  }
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g, // import x from './y.js'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // await import('./y.js')
    /\bimport\s+['"]([^'"]+)['"]/g // import './y.js'
  ]
  if (filePath.endsWith('.html')) {
    patterns.push(/<script[^>]+src\s*=\s*['"]([^'"]+)['"]/gi, /<link[^>]+href\s*=\s*['"]([^'"]+)['"]/gi)
  }
  for (const re of patterns) {
    let m
    while ((m = re.exec(code)) !== null) add(m[1], m.index)
  }
  return refs
}

// Resolve './x.js' or '../lib/x.js' against the importing file's directory.
const resolveRelative = (fromPath, spec) => {
  const base = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : ''
  const parts = (base ? base.split('/') : []).concat(spec.split('/'))
  const out = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') { out.pop(); continue }
    out.push(part)
  }
  return out.join('/')
}

/**
 * Validate a set of app files.
 * @param {Array<{path: string, content: string}>} files
 * @returns {{ errors: Array, checked: number, parser: string }}
 */
export const validateAppFiles = (files = []) => {
  const errors = []
  const present = new Set(files.map((f) => f.path))
  let checked = 0

  for (const file of files) {
    const { path: p, content } = file
    if (!p || isSkipped(p) || typeof content !== 'string') continue

    if (isJs(p)) {
      checked++
      const syntax = checkJsSyntax(p, content)
      if (syntax) errors.push({ type: 'js_syntax', ...syntax })
    }

    if (p === 'manifest.json' || p.endsWith('.json')) {
      checked++
      try {
        JSON.parse(content)
      } catch (e) {
        errors.push({ type: 'json_parse', path: p, message: e.message })
      }
    }

    // Unresolved relative references (JS imports, and script/link tags in HTML).
    if (isJs(p) || p.endsWith('.html')) {
      for (const ref of relativeRefsOf(p, content)) {
        const target = resolveRelative(p, ref.spec)
        if (!target) continue
        const candidates = [target]
        // Extensionless import → try the usual endings before calling it missing.
        if (!/\.[a-z0-9]+$/i.test(target)) candidates.push(target + '.js', target + '.mjs', target + '/index.js')
        if (!candidates.some((c) => present.has(c))) {
          errors.push({
            type: 'missing_import',
            path: p,
            line: ref.line,
            message: 'References "' + ref.spec + '" which resolves to "' + target + '" — no such file in this app'
          })
        }
      }
    }
  }

  return { errors, checked, parser: acornParse ? 'acorn' : 'vm.Script (non-module only)' }
}

export default { validateAppFiles, checkJsSyntax }
