// devAppActions.js
// The three developer actions offered for an app that is served from a local
// folder - shared by the Dev tab on the account home page and the Developer
// Options card on the app settings page, so the two stay in step.
//
// account_app_settings.js is loaded as a module and imports this statically.
// account_home.js is loaded as a classic script (script_files, not modules) so it
// pulls this in with a dynamic import() of its absolute /app/... url - allowed by
// the page CSP because it is same-origin ('self').
/* global freezr, freezrMeta, confirm, document */

// Dev options are for admin users - the same gate as the Dev tab on the home page.
// The server does its own checks anyway (the app must be on a local file system,
// and the user must own it).
export const devOptionsAvailable = function () {
  return Boolean(freezrMeta && freezrMeta.adminUser)
}

// Descriptions shown next to each button - kept here so both pages say the same thing
export const DEV_ACTION_DESCRIPTIONS = {
  updateAppFromFiles: 'Adds the app folder to your Apps list, or re-installs an existing app from its files (re-reads manifest.json, permissions and pages).',
  regenerateDevTokens: 'Writes a long-lived API token into the app folder (.freezr-access.local.json) so dev tools and AI coding agents can read and write this app\'s data. <b>Warning: This gives full access to your app\'s data.</b>',
  generateContextFile: 'Copies the latest freezr-context.md into the app folder — the guidance doc that teaches AI coding assistants (Claude, Cursor, ChatGPT...) how to build freezr apps.'
}

// Fills any <span id="devDesc_<action>"> on the page with the description above,
// so the wording lives in one place. Both dev pages use these ids.
export const fillDevActionDescriptions = function () {
  Object.keys(DEV_ACTION_DESCRIPTIONS).forEach(action => {
    const el = document.getElementById('devDesc_' + action)
    if (el) el.innerHTML = DEV_ACTION_DESCRIPTIONS[action]
  })
}

export const DEV_TOKEN_CONFIRM_TEXT = function (appName) {
  return 'This writes a long-lived access token into the app folder (' + appName +
    '/.freezr-access.local.json). Any tool that can read that folder - including an LLM or AI coding agent working on the app - gets FULL READ AND WRITE ACCESS to this app\'s data on your freezr until the token expires or is revoked.\n\nContinue?'
}

// How to attach freezr-context.md to each AI assistant - mirrors the "How to use
// this file" section at the top of the generated freezr-context.md itself.
export const CONTEXT_FILE_INSTRUCTIONS_HTML = '<div style="margin-top:0.5rem; font-weight:bold;">To make your AI coding assistant use it:</div>' +
  '<ul style="margin:0.25rem 0 0 1.25rem; padding:0;">' +
  '<li><b>Claude Code:</b> create a CLAUDE.md file at the app folder root containing one line &mdash; <code>@freezr-context.md</code>. It is auto-loaded every session.</li>' +
  '<li><b>Cursor:</b> save a copy as <code>.cursor/rules/freezr.mdc</code>, or add a rule pointing to <code>freezr-context.md</code>.</li>' +
  '<li><b>GitHub Copilot / Codex / other agents:</b> rename or symlink the file to <code>AGENTS.md</code> at the folder root.</li>' +
  '<li><b>ChatGPT (web):</b> upload <code>freezr-context.md</code> to your conversation or Project files and tell it to follow the file when writing freezr app code.</li>' +
  '</ul>'

// Each action returns { ok, message, isHtml } so the calling page can display it
// in whichever message box it uses. options.onStart, where given, is called once
// the action is really going ahead - ie after the user accepts any confirmation -
// so a page can show its "working..." message at the right moment.

export const regenerateDevTokens = async function (appName, options = {}) {
  if (!confirm(DEV_TOKEN_CONFIRM_TEXT(appName))) return { ok: false, cancelled: true }
  if (options.onStart) options.onStart()
  try {
    const returndata = await freezr.apiRequest('POST', '/acctapi/generateDevAccessFile', { app_name: appName })
    if (returndata.error || returndata.errors) {
      console.warn({ returndata })
      return { ok: false, message: 'Error generating tokens: ' + (returndata.error || returndata.errors) }
    }
    return {
      ok: true,
      message: 'Dev tokens for ' + appName + ' written to ' + returndata.filePath +
        ' (expires ' + (returndata.appTokenExpires || '?').slice(0, 10) + ').' +
        (returndata.gitignoreUpdated ? ' Added the file to the app\'s .gitignore.' : '')
    }
  } catch (error) {
    console.warn({ error })
    return { ok: false, message: 'Error generating tokens: ' + error.message }
  }
}

export const generateContextFile = async function (appName, options = {}) {
  if (options.onStart) options.onStart()
  try {
    const returndata = await freezr.apiRequest('POST', '/acctapi/generateDevContextFile', { app_name: appName })
    if (returndata.error || returndata.errors) {
      console.warn({ returndata })
      return { ok: false, message: 'Error generating context file: ' + (returndata.error || returndata.errors) }
    }
    const actionText = { created: 'was created in', updated: 'was updated in', uptodate: 'is already up to date in' }[returndata.action] || 'was written to'
    // Static instruction strings only - safe for innerHTML
    return {
      ok: true,
      isHtml: true,
      message: 'freezr-context.md ' + actionText + ' the ' + appName + ' app folder.' + CONTEXT_FILE_INSTRUCTIONS_HTML
    }
  } catch (error) {
    console.warn({ error })
    return { ok: false, message: 'Error generating context file: ' + error.message }
  }
}

// returndata is passed back raw as well, for the home page's install-progress display
export const updateAppFromFiles = async function (appName, options = {}) {
  if (options.onStart) options.onStart()
  try {
    const returndata = await freezr.apiRequest('POST', '/acctapi/updateAppFromFiles', { app_name: appName })
    if (returndata.error || returndata.errors) {
      console.warn({ returndata })
      return { ok: false, returndata, message: 'Error updating app: ' + (returndata.error || JSON.stringify(returndata.errors)) }
    }
    return { ok: true, returndata, message: appName + ' was re-installed from its files.' }
  } catch (error) {
    console.warn({ error })
    return { ok: false, message: 'Error updating app! ' + error.message }
  }
}
