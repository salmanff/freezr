// account_resources.js - LLM key management + Connected Accounts (mail/calendar/contacts)
// account/resources
/* global freezr freezrMeta */
/* global confirm */

const TABLE_NAME = 'info.freezr.account.resources'
let llmTable, connectionTable, computeTable

const state = {
  resources: [],     // LLM resources (legacy name kept for minimal diff)
  connections: [],   // Connection records (type: 'connection')
  compute: []        // Compute credentials (type: 'compute')
}

freezr.initPageScripts = async function () {
  llmTable = document.getElementById('llmGridDetails')
  connectionTable = document.getElementById('connectionGridDetails')
  computeTable = document.getElementById('computeGridDetails')

  // LLM overlay wiring (unchanged behavior)
  const overlay = document.getElementById('overlay')
  const overlayClose = document.getElementById('overlay_close')
  if (overlayClose) overlayClose.onclick = function () { if (overlay) overlay.style.display = 'none' }
  if (overlay) overlay.onclick = function (e) { if (e.target === overlay) overlay.style.display = 'none' }

  document.getElementById('button_addnew_llm').onclick = function () {
    clearForm()
    document.getElementById('llmFormTitle').innerText = 'Add a New LLM Key'
    document.getElementById('button_llmSave').innerText = 'Save'
    document.getElementById('button_llmDelete').style.display = 'none'
    if (overlay) overlay.style.display = 'flex'
  }
  document.getElementById('button_llmSave').onclick = saveLlm
  document.getElementById('button_llmDelete').onclick = deleteLlm

  // Compute (serverless) overlay wiring
  const computeOverlay = document.getElementById('compute_overlay')
  const computeOverlayClose = document.getElementById('compute_overlay_close')
  if (computeOverlayClose) computeOverlayClose.onclick = function () { if (computeOverlay) computeOverlay.style.display = 'none' }
  if (computeOverlay) computeOverlay.onclick = function (e) { if (e.target === computeOverlay) computeOverlay.style.display = 'none' }
  document.getElementById('button_addnew_compute').onclick = function () {
    clearComputeForm()
    document.getElementById('computeFormTitle').innerText = 'Add AWS Credentials'
    document.getElementById('button_computeSave').innerText = 'Save'
    document.getElementById('button_computeDelete').style.display = 'none'
    if (computeOverlay) computeOverlay.style.display = 'flex'
  }
  document.getElementById('button_computeSave').onclick = saveCompute
  document.getElementById('button_computeDelete').onclick = deleteCompute
  document.getElementById('button_compute_createRole').onclick = createComputeRole

  // OAuth Connect / Edit are full-page navigations to /connections/new and
  // /connections/edit?name=<name>. IMAP mailboxes (app-password, no OAuth) are
  // created right here via the SDK, like LLM/compute credentials — this app owns
  // the resources table; the connections app doesn't.
  const imapOverlay = document.getElementById('imap_overlay')
  const imapOverlayClose = document.getElementById('imap_overlay_close')
  if (imapOverlayClose) imapOverlayClose.onclick = function () { if (imapOverlay) imapOverlay.style.display = 'none' }
  if (imapOverlay) imapOverlay.onclick = function (e) { if (e.target === imapOverlay) imapOverlay.style.display = 'none' }
  document.getElementById('button_addnew_imap').onclick = function () {
    clearImapForm()
    applyImapPreset('yahoo')
    if (imapOverlay) {
      imapOverlay.style.display = 'flex'
      // The .overlay class isn't styled as a fixed modal on this page, so the form
      // renders in normal flow below the fold — scroll it into view so the button
      // doesn't feel like a no-op. Short delay lets layout settle after display:flex.
      setTimeout(function () { imapOverlay.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, 50)
    }
  }
  document.getElementById('imap_preset').onchange = function () { applyImapPreset(this.value) }
  document.getElementById('button_imapSave').onclick = saveImap

  // Slack token-paste connections (provider 'slack') — same direct-write pattern
  // as IMAP: no OAuth flow, the user brings a token from their own Slack app.
  const slackOverlay = document.getElementById('slacktoken_overlay')
  const slackOverlayClose = document.getElementById('slacktoken_overlay_close')
  if (slackOverlayClose) slackOverlayClose.onclick = function () { if (slackOverlay) slackOverlay.style.display = 'none' }
  if (slackOverlay) slackOverlay.onclick = function (e) { if (e.target === slackOverlay) slackOverlay.style.display = 'none' }
  document.getElementById('button_addnew_slacktoken').onclick = function () {
    clearSlackTokenForm()
    if (slackOverlay) {
      slackOverlay.style.display = 'flex'
      setTimeout(function () { slackOverlay.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, 50)
    }
  }
  document.getElementById('button_slacktokenSave').onclick = saveSlackToken

  // Claude Code (local subscription) — an LLM resource with NO key: the credential is the
  // machine's logged-in `claude` CLI. Enable flow is an attestation, not a key form. The card
  // only appears when the server says this user is eligible (admin + master pref).
  const claudeLocalOverlay = document.getElementById('claudelocal_overlay')
  const claudeLocalClose = document.getElementById('claudelocal_overlay_close')
  if (claudeLocalClose) claudeLocalClose.onclick = function () { if (claudeLocalOverlay) claudeLocalOverlay.style.display = 'none' }
  if (claudeLocalOverlay) claudeLocalOverlay.onclick = function (e) { if (e.target === claudeLocalOverlay) claudeLocalOverlay.style.display = 'none' }
  document.getElementById('button_enable_claudelocal').onclick = function () {
    document.getElementById('claudelocal_binary').value = claudeLocalState.binaryPath || ''
    if (claudeLocalOverlay) {
      claudeLocalOverlay.style.display = 'flex'
      setTimeout(function () { claudeLocalOverlay.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, 50)
    }
  }
  document.getElementById('button_claudelocalSave').onclick = saveClaudeLocal

  // OpenAI Codex (local subscription) — same localCli pattern with the codex CLI
  const codexLocalOverlay = document.getElementById('codexlocal_overlay')
  const codexLocalClose = document.getElementById('codexlocal_overlay_close')
  if (codexLocalClose) codexLocalClose.onclick = function () { if (codexLocalOverlay) codexLocalOverlay.style.display = 'none' }
  if (codexLocalOverlay) codexLocalOverlay.onclick = function (e) { if (e.target === codexLocalOverlay) codexLocalOverlay.style.display = 'none' }
  document.getElementById('button_enable_codexlocal').onclick = function () {
    document.getElementById('codexlocal_binary').value = localCliState.codexBinaryPath || ''
    if (codexLocalOverlay) {
      codexLocalOverlay.style.display = 'flex'
      setTimeout(function () { codexLocalOverlay.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, 50)
    }
  }
  document.getElementById('button_codexlocalSave').onclick = saveCodexLocal

  // File stores (services ['fs']) — the local-folder variant is admin-only and the card
  // only appears when the server says this user is eligible (admin + local-fs server).
  const fileStoreOverlay = document.getElementById('filestore_overlay')
  const fileStoreClose = document.getElementById('filestore_overlay_close')
  if (fileStoreClose) fileStoreClose.onclick = function () { if (fileStoreOverlay) fileStoreOverlay.style.display = 'none' }
  if (fileStoreOverlay) fileStoreOverlay.onclick = function (e) { if (e.target === fileStoreOverlay) fileStoreOverlay.style.display = 'none' }
  document.getElementById('button_addnew_filestore').onclick = function () {
    document.getElementById('filestore_name').value = ''
    document.getElementById('filestore_path').value = ''
    document.getElementById('filestore_access').value = 'read'
    if (fileStoreOverlay) {
      fileStoreOverlay.style.display = 'flex'
      setTimeout(function () { fileStoreOverlay.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, 50)
    }
  }
  document.getElementById('button_filestoreSave').onclick = saveFileStore

  // Load all resources in a single query (per the doc note: prefer simple queries + filter client-side).
  try {
    const results = await freezr.query(TABLE_NAME) || []
    state.resources = results.filter(r => r && r.type === 'llm')
    state.connections = results.filter(r => r && r.type === 'connection')
    state.compute = results.filter(r => r && r.type === 'compute')

    // Auto-set default LLM if there are LLM resources but none is marked default.
    // localCli resources (Claude Code / Codex — no key) count as usable AND as default
    // holders here: filtering on `key` alone once made this "repair" mark an API key
    // default while a local connector already held it, leaving TWO defaults.
    const llms = state.resources.filter(r => r.type === 'llm' && (r.key || r.localCli))
    if (llms.length > 0 && !llms.some(r => r.default)) {
      llms[0].default = true
      try {
        await freezr.updateFields(TABLE_NAME, llms[0]._id, { default: true })
      } catch (e) {
        console.warn('Could not auto-set default LLM resource:', e)
      }
    }

    redrawList()
    redrawConnectionList()
    redrawComputeList()
  } catch (err) {
    showWarning(err?.message || err)
  }

  // Handle OAuth callback success + focus deep links after the initial render.
  handleUrlParams()

  // Non-blocking: the ClaudeLocal card stays hidden unless the server reports eligibility.
  loadClaudeLocalStatus()

  // Non-blocking: the File Stores card stays hidden unless the server reports eligibility.
  loadFileStoreStatus()
}

/* =====================================================================
 *  File stores (connection records with services ['fs'])
 *  Local-folder stores are admin-only, on local-fs servers, over localhost —
 *  the server enforces all of that at use time (fsContext.mjs localFsGate);
 *  this UI mirrors the gates so the card only shows where it can work.
 * =================================================================== */

const fileStoreState = { enabled: false, isAdmin: false, systemFsIsLocal: false, onLocalhost: false }

const loadFileStoreStatus = async function () {
  try {
    const resp = await freezr.apiRequest('GET', '/feps/connections/fs/local_status')
    Object.assign(fileStoreState, resp || {})
  } catch (e) {
    return // endpoint unavailable — leave the card hidden
  }
  if (!fileStoreState.isAdmin || !fileStoreState.systemFsIsLocal) return
  redrawFileStoreCard()
}

const redrawFileStoreCard = function () {
  const card = document.getElementById('filestore_card')
  const statusEl = document.getElementById('filestore_status')
  const addButt = document.getElementById('button_addnew_filestore')
  if (!card || !statusEl || !addButt) return
  if (!fileStoreState.isAdmin || !fileStoreState.systemFsIsLocal) { card.style.display = 'none'; return }

  card.style.display = 'block'
  addButt.style.display = 'none'
  const fsStores = state.connections.filter(c => Array.isArray(c.services) && c.services.includes('fs'))

  if (!fileStoreState.enabled) {
    statusEl.innerHTML = 'Share a local folder with apps you authorize (browse / read, optionally write) — ' +
      'admin users on localhost only. To make this available, first turn on "local file-store access" in ' +
      '<a href="/admin/prefs">Admin Preferences</a>.'
  } else {
    statusEl.innerHTML = (fsStores.length > 0
      ? 'Your file stores appear in the Connected Accounts list below. Apps get access only when you grant their <code>use_file_sys</code> permission naming a store.'
      : 'No file stores yet. Add a local folder that authorized apps may browse and read — apps get access only when you grant their <code>use_file_sys</code> permission.') +
      (fileStoreState.onLocalhost ? '' : ' <b>Note:</b> you are not browsing over localhost right now — local stores only answer requests made on <code>localhost</code>.')
    addButt.style.display = 'inline-block'
  }
}

const saveFileStore = async function () {
  const connectionName = document.getElementById('filestore_name').value.trim()
  const rootPath = document.getElementById('filestore_path').value.trim()
  const access = document.getElementById('filestore_access').value === 'readwrite' ? 'readwrite' : 'read'

  if (!connectionName) { showWarning('Store name is required'); return }
  if (!CONN_NAME_RX.test(connectionName)) { showWarning('Store name: letters, digits, underscore and dash only'); return }
  if (state.connections.find(c => c.connectionName === connectionName)) { showWarning('A connection named "' + connectionName + '" already exists'); return }
  if (!rootPath) { showWarning('Folder path is required'); return }
  if (!rootPath.startsWith('/')) { showWarning('Folder path must be absolute (start with /)'); return }

  try {
    showLoading(true)
    // Server-side validation: exists, is a directory, does not overlap the freezr tree.
    // Also returns the realpath, which is what gets stored (symlink-free root).
    const check = await freezr.apiRequest('GET', '/feps/connections/fs/local_status?path=' + encodeURIComponent(rootPath))
    if (!check || check.pathValid !== true) {
      showLoading(false)
      showWarning((check && check.pathError) || 'That folder could not be validated on the server')
      return
    }
    const record = {
      type: 'connection',
      provider: 'localfs',
      connectionName,
      account_email: null,
      services: ['fs'],
      access: { fs: access },
      status: 'ok',
      fsParams: { type: 'local', rootPath: check.pathReal }
    }
    const result = await freezr.create(TABLE_NAME, record)
    if (!result || result.error) throw new Error(result?.error || 'Error creating file store')
    state.connections.push({ _id: result._id, ...record })
    showLoading(false)
    const overlay = document.getElementById('filestore_overlay')
    if (overlay) overlay.style.display = 'none'
    redrawConnectionList()
    redrawFileStoreCard()
    showSuccess('Added file store "' + connectionName + '" for ' + check.pathReal + '. Grant apps access via their use_file_sys permission on each app\'s settings page.')
  } catch (e) {
    showLoading(false)
    showWarning(e.message || 'Error saving file store')
  }
}

const removeFileStore = async function (doc) {
  if (!confirm('Remove the file store "' + (doc.connectionName || '') + '"? Apps granted access will no longer be able to use it. No files are deleted.')) return
  try {
    showLoading(true)
    await freezr.delete(TABLE_NAME, doc._id, {})
    state.connections = state.connections.filter(c => c._id !== doc._id)
    redrawConnectionList()
    redrawFileStoreCard()
    showSuccess('Removed file store ' + (doc.connectionName || ''))
  } catch (err) {
    showWarning(err?.message || 'Error removing file store')
  } finally {
    showLoading(false)
  }
}

/* =====================================================================
 *  Local CLI connectors (owner's subscription, no API key):
 *  ClaudeLocal (claude CLI) and CodexLocal (codex CLI)
 * =================================================================== */

const localCliState = { enabled: false, isAdmin: false, allowedInAllApps: false, binaryFound: false, binaryPath: null, codexBinaryFound: false, codexBinaryPath: null }

const getLocalCliResource = function (provider) {
  return state.resources.find(r => r.type === 'llm' && r.localCli && r.provider === provider)
}

const getClaudeLocalResource = function () { return getLocalCliResource('ClaudeLocal') }
const getCodexLocalResource = function () { return getLocalCliResource('CodexLocal') }

const loadClaudeLocalStatus = async function () {
  try {
    const resp = await freezr.apiRequest('GET', '/acctapi/getLocalLlmCliStatus')
    Object.assign(localCliState, resp || {})
  } catch (e) {
    return // endpoint unavailable — leave the cards hidden
  }
  // Non-admins never see the cards: the connectors are admin-only by policy (the server
  // enforces this at use time regardless of what the UI shows).
  if (!localCliState.isAdmin) return
  redrawClaudeLocalCard()
  redrawCodexLocalCard()
}

// Shared card renderer for the two local-CLI connectors — same states, different wording bits.
const redrawLocalCliCard = function (opts) {
  const card = document.getElementById(opts.cardId)
  const statusEl = document.getElementById(opts.statusId)
  const enableButt = document.getElementById(opts.buttonId)
  if (!card || !statusEl || !enableButt) return
  if (!localCliState.isAdmin) { card.style.display = 'none'; return }

  // Keep the enable-overlay disclosure honest: if SHOW_LOCAL_AGENT_IN_APPS is already set on
  // this server, the creator-only restriction is NOT in force and saying otherwise would
  // mislead someone into thinking they are protected.
  const scopeNote = document.getElementById(opts.provider === 'ClaudeLocal' ? 'claudelocal_scope_note' : 'codexlocal_scope_note')
  if (scopeNote && localCliState.allowedInAllApps) {
    scopeNote.innerHTML = '<b>Which apps can use this:</b> <b>ANY app on this server</b>. The ' +
      '<code>SHOW_LOCAL_AGENT_IN_APPS</code> environment variable is set, which lifts the default ' +
      'restriction that would otherwise limit these connectors to the Creator app. Apps handling ' +
      'other people\'s content (mail, messages) will be able to spend your subscription, and for ' +
      'Codex that content reaches an agent. Unset that variable to restore the default.'
    scopeNote.style.borderLeftColor = '#c62828'
    scopeNote.style.background = '#fef2f2'
  }

  card.style.display = 'block'
  enableButt.style.display = 'none'
  const existing = getLocalCliResource(opts.provider)

  if (!localCliState.enabled) {
    statusEl.innerHTML = 'Use your own ' + opts.subscriptionName + ' (via the <code>' + opts.cli + '</code> CLI logged in ' +
      'on this server) instead of a metered API key. To make this available, first turn on "local CLI LLM connectors" in ' +
      '<a href="/admin/prefs">Admin Preferences</a>.'
  } else if (existing) {
    const scopeNote = localCliState.allowedInAllApps
      ? '<br/><b>Note:</b> <code>SHOW_LOCAL_AGENT_IN_APPS</code> is set, so <b>any</b> app may use this. That is at your own risk — see the warning above.'
      : '<br/><b>Only the Creator app can use this.</b> Other apps will not see it, because these connectors spend your own subscription and (for Codex) run an agent that untrusted app content could try to steer. A developer who accepts that risk can set the <code>SHOW_LOCAL_AGENT_IN_APPS=true</code> environment variable on the server.'
    statusEl.innerHTML = 'Enabled — appears in your LLM keys list above as <b>' + (existing.name || opts.displayName) +
      '</b>. Calls run through <code>' + (existing.local?.binaryPath || opts.cli) + '</code> and cost $0 ' +
      '(they draw on your subscription\'s usage limits). Remove it from the list above to disable.' + scopeNote
  } else if (!opts.binaryFound) {
    statusEl.innerHTML = 'No <code>' + opts.cli + '</code> CLI was found on this server. Install it (' + opts.installHint +
      '), log in with your subscription (' + opts.loginHint + '), then reload this page. If it is installed somewhere ' +
      'unusual, you can still enable it and enter the binary path by hand.'
    enableButt.style.display = 'inline-block'
  } else {
    statusEl.innerHTML = 'A <code>' + opts.cli + '</code> CLI was found at <code>' + opts.binaryPath + '</code>. ' +
      'Use your own ' + opts.subscriptionName + ' for LLM calls instead of a metered API key — admin users only.'
    enableButt.style.display = 'inline-block'
  }
}

const redrawClaudeLocalCard = function () {
  redrawLocalCliCard({
    provider: 'ClaudeLocal',
    cardId: 'claudelocal_card',
    statusId: 'claudelocal_status',
    buttonId: 'button_enable_claudelocal',
    cli: 'claude',
    displayName: 'Claude Code (local)',
    subscriptionName: 'Claude subscription',
    installHint: '<code>curl -fsSL https://claude.ai/install.sh | bash</code>',
    loginHint: 'run <code>claude</code> once in a terminal',
    binaryFound: localCliState.binaryFound,
    binaryPath: localCliState.binaryPath
  })
}

const redrawCodexLocalCard = function () {
  redrawLocalCliCard({
    provider: 'CodexLocal',
    cardId: 'codexlocal_card',
    statusId: 'codexlocal_status',
    buttonId: 'button_enable_codexlocal',
    cli: 'codex',
    displayName: 'Codex (local)',
    subscriptionName: 'ChatGPT subscription',
    installHint: '<code>npm i -g @openai/codex</code>',
    loginHint: 'run <code>codex login</code> in a terminal',
    binaryFound: localCliState.codexBinaryFound,
    binaryPath: localCliState.codexBinaryPath
  })
}

// Shared enable flow: writes the localCli resource record with the attestation. The record
// carries NO key — the server-side gate (llmContext.mjs) is what makes it usable.
const saveLocalCli = async function (opts) {
  const binaryPath = document.getElementById(opts.binaryInputId).value.trim()
  const attOwner = document.getElementById(opts.attOwnerId).checked
  const attPersonal = document.getElementById(opts.attPersonalId).checked
  const attTerms = document.getElementById(opts.attTermsId).checked
  const isDefault = document.getElementById(opts.defaultId).checked

  if (!binaryPath) { showWarning('Enter the path to the ' + opts.cli + ' CLI binary'); return }
  if (!(new RegExp('(^|/)' + opts.cli + '$')).test(binaryPath)) { showWarning('The binary path must point to a file named "' + opts.cli + '"'); return }
  if (!attOwner || !attPersonal || !attTerms) { showWarning('All three confirmations are required to enable this connector'); return }
  if (getLocalCliResource(opts.provider)) { showWarning(opts.displayName + ' is already enabled — remove it from the LLM list first to re-configure'); return }

  try {
    showLoading(true)
    if (isDefault) {
      for (const res of state.resources) {
        if (res.default) {
          await freezr.updateFields(TABLE_NAME, res._id, { default: false })
          res.default = false
        }
      }
    }
    const params = {
      type: 'llm',
      name: opts.displayName,
      provider: opts.provider,
      localCli: true,
      local: { binaryPath },
      attestation: {
        acceptedAt: new Date().toISOString(),
        serverOwner: true,
        personalUseOnly: true,
        termsAcknowledged: true
      },
      default: isDefault
    }
    const result = await freezr.create(TABLE_NAME, params)
    if (!result || result.error) throw new Error(result?.error || 'Error enabling ' + opts.displayName)
    state.resources.push({ _id: result._id, ...params })
    showLoading(false)
    const overlay = document.getElementById(opts.overlayId)
    if (overlay) overlay.style.display = 'none'
    redrawList()
    redrawClaudeLocalCard()
    redrawCodexLocalCard()
    showSuccess(opts.displayName + ' enabled. Test it with a small request from an app — if the CLI is not logged in, the call will say so.')
  } catch (e) {
    showLoading(false)
    showWarning(e.message || ('Error enabling ' + opts.displayName))
  }
}

const saveClaudeLocal = () => saveLocalCli({
  provider: 'ClaudeLocal',
  displayName: 'Claude Code (local)',
  cli: 'claude',
  binaryInputId: 'claudelocal_binary',
  attOwnerId: 'claudelocal_att_owner',
  attPersonalId: 'claudelocal_att_personal',
  attTermsId: 'claudelocal_att_terms',
  defaultId: 'claudelocal_default',
  overlayId: 'claudelocal_overlay'
})

const saveCodexLocal = () => saveLocalCli({
  provider: 'CodexLocal',
  displayName: 'Codex (local)',
  cli: 'codex',
  binaryInputId: 'codexlocal_binary',
  attOwnerId: 'codexlocal_att_owner',
  attPersonalId: 'codexlocal_att_personal',
  attTermsId: 'codexlocal_att_terms',
  defaultId: 'codexlocal_default',
  overlayId: 'codexlocal_overlay'
})

const removeLocalCli = async function (doc) {
  if (!confirm('Disable ' + (doc.name || 'this local connector') + '? Apps will no longer be able to use it.')) return
  try {
    showLoading(true)
    await freezr.delete(TABLE_NAME, doc._id, {})
    state.resources = state.resources.filter(r => r._id !== doc._id)
    showLoading(false)
    redrawList()
    redrawClaudeLocalCard()
    redrawCodexLocalCard()
  } catch (err) {
    showLoading(false)
    showWarning(err?.message || 'Error removing local connector')
  }
}

/* =====================================================================
 *  LLM keys section (Phase 0.5)
 * =================================================================== */

const clearForm = function () {
  document.getElementById('llm_name').value = ''
  document.getElementById('llm_provider').value = 'Claude'
  document.getElementById('llm_key').value = ''
  document.getElementById('llm_default').checked = false
  document.getElementById('llm__id').value = ''
}

const openEditForm = function (doc) {
  document.getElementById('llmFormTitle').innerText = 'Edit LLM Key'
  document.getElementById('button_llmSave').innerText = 'Update'
  document.getElementById('button_llmDelete').style.display = 'block'

  document.getElementById('llm_name').value = doc.name || ''
  document.getElementById('llm_provider').value = doc.provider || 'Claude'
  // The stored key may be encrypted ({__enc} or {value}) — clients never see plaintext.
  // Always blank the field on edit; user re-enters only if they want to change it.
  document.getElementById('llm_key').value = ''
  document.getElementById('llm_key').placeholder = 'Leave blank to keep existing key'
  document.getElementById('llm_default').checked = !!doc.default
  document.getElementById('llm__id').value = doc._id || ''

  const overlay = document.getElementById('overlay')
  if (overlay) overlay.style.display = 'flex'
}

const saveLlm = async function () {
  const name = document.getElementById('llm_name').value.trim()
  const provider = document.getElementById('llm_provider').value
  const key = document.getElementById('llm_key').value.trim()
  const isDefault = document.getElementById('llm_default').checked
  const existingId = document.getElementById('llm__id').value

  if (!name) { showWarning('Name is required'); return }
  if (!existingId && !key) { showWarning('API key is required'); return }

  try {
    showLoading(true)

    if (isDefault) {
      for (const res of state.resources) {
        if (res.default && res._id !== existingId) {
          await freezr.updateFields(TABLE_NAME, res._id, { default: false })
          res.default = false
        }
      }
    }

    if (existingId) {
      if (key) {
        const params = { type: 'llm', name, provider, key, default: isDefault }
        const result = await freezr.update(TABLE_NAME, existingId, params)
        if (!result || result.error) throw new Error(result?.error || 'Error updating key')
        state.resources = state.resources.map(r => r._id === existingId
          ? { ...r, type: 'llm', name, provider, default: isDefault, _keyJustSet: true }
          : r)
      } else {
        await freezr.updateFields(TABLE_NAME, existingId, { name, provider, default: isDefault })
        state.resources = state.resources.map(r => r._id === existingId
          ? { ...r, name, provider, default: isDefault }
          : r)
      }
    } else {
      const params = { type: 'llm', name, provider, key, default: isDefault }
      const existingLlms = state.resources.filter(r => r.type === 'llm')
      if (existingLlms.length === 0) params.default = true
      const result = await freezr.create(TABLE_NAME, params)
      if (!result || result.error) throw new Error(result?.error || 'Error creating key')
      state.resources.push({ _id: result._id, type: 'llm', name, provider, default: params.default, _keyJustSet: true })
    }

    showLoading(false)
    const overlay = document.getElementById('overlay')
    if (overlay) overlay.style.display = 'none'
    redrawList()
  } catch (e) {
    showLoading(false)
    showWarning(e.message || 'Error saving')
  }
}

const deleteLlm = async function () {
  const theId = document.getElementById('llm__id').value
  if (!theId) return
  if (!confirm('Are you sure you want to delete this LLM key?')) return

  try {
    showLoading(true)
    await freezr.delete(TABLE_NAME, theId, {})
    state.resources = state.resources.filter(r => r._id !== theId)
    showLoading(false)
    const overlay = document.getElementById('overlay')
    if (overlay) overlay.style.display = 'none'
    redrawList()
  } catch (err) {
    showLoading(false)
    showWarning(err?.message || 'Error deleting key')
  }
}

const setAsDefault = async function (doc) {
  try {
    showLoading(true)
    for (const res of state.resources) {
      if (res.default && res._id !== doc._id) {
        await freezr.updateFields(TABLE_NAME, res._id, { default: false })
        res.default = false
      }
    }
    await freezr.updateFields(TABLE_NAME, doc._id, { default: true })
    doc.default = true
    showLoading(false)
    redrawList()
  } catch (err) {
    showLoading(false)
    showWarning(err?.message || 'Error setting default')
  }
}

const redrawList = function () {
  if (!llmTable) return
  llmTable.innerHTML = ''

  const llms = state.resources.filter(r => r.type === 'llm')

  if (llms.length === 0) {
    llmTable.innerHTML = '<p>No LLM keys added yet. Click "Add LLM Key" to get started.</p>'
    return
  }

  llms.forEach(doc => {
    const row = document.createElement('div')
    row.className = 'gridlist'
    row.id = 'llmRow_' + doc._id
    row.style.cssText = 'display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 0.75rem; padding: 0.75rem 0; border-bottom: 1px solid #e2e8f0;'

    const info = document.createElement('div')
    const nameSpan = document.createElement('span')
    nameSpan.style.fontWeight = '600'
    nameSpan.innerText = doc.name || '(unnamed)'
    info.appendChild(nameSpan)

    if (doc.default) {
      const badge = document.createElement('span')
      badge.style.cssText = 'display: inline-block; margin-left: 0.5rem; padding: 0.1rem 0.5rem; background: #059669; color: white; border-radius: 4px; font-size: 0.75rem;'
      badge.innerText = 'default'
      info.appendChild(badge)
    }

    const details = document.createElement('div')
    details.style.cssText = 'font-size: 0.85em; color: #64748b; margin-top: 0.25rem;'
    if (doc.localCli) {
      // local-CLI resource: no key to mask — the credential is the machine's claude login
      details.innerText = doc.provider + ' · local subscription (no API key)'
    } else {
      const maskedKey = (typeof doc.key === 'string' && doc.key) ? '***' + doc.key.slice(-4) : '***'
      details.innerText = doc.provider + ' · ' + maskedKey
    }
    info.appendChild(details)

    row.appendChild(info)

    const actions = document.createElement('div')
    actions.style.cssText = 'display: flex; gap: 0.5rem; flex-wrap: wrap;'

    if (!doc.default) {
      const defaultBtn = document.createElement('span')
      defaultBtn.className = 'smallTextButt'
      defaultBtn.innerText = 'Set Default'
      defaultBtn.onclick = function () { setAsDefault(doc) }
      actions.appendChild(defaultBtn)
    }

    if (doc.localCli) {
      // the key edit form makes no sense here — offer removal only
      const removeBtn = document.createElement('span')
      removeBtn.className = 'smallTextButt'
      removeBtn.innerText = 'Remove'
      removeBtn.onclick = function () { removeLocalCli(doc) }
      actions.appendChild(removeBtn)
    } else {
      const editBtn = document.createElement('span')
      editBtn.className = 'smallTextButt'
      editBtn.innerText = 'Edit'
      editBtn.onclick = function () { openEditForm(doc) }
      actions.appendChild(editBtn)
    }

    row.appendChild(actions)
    llmTable.appendChild(row)
  })
}

/* =====================================================================
 *  Compute providers (serverless) section (Phase 6)
 *  Credentials live in the SAME resources table as type:'compute' with a `secret`
 *  sub-object ({accessKeyId, secretAccessKey, arnRole}) encrypted server-side on write.
 * =================================================================== */

const clearComputeForm = function () {
  document.getElementById('compute_name').value = ''
  document.getElementById('compute_region').value = 'eu-central-1'
  document.getElementById('compute_accessKeyId').value = ''
  document.getElementById('compute_secretAccessKey').value = ''
  document.getElementById('compute_arnRole').value = ''
  document.getElementById('compute_default').checked = false
  document.getElementById('compute__id').value = ''
}

const openComputeEditForm = function (doc) {
  document.getElementById('computeFormTitle').innerText = 'Edit AWS Credentials'
  document.getElementById('button_computeSave').innerText = 'Update'
  document.getElementById('button_computeDelete').style.display = 'block'
  document.getElementById('compute_name').value = doc.name || ''
  document.getElementById('compute_region').value = doc.region || 'eu-central-1'
  // accessKeyId is non-secret (shown); secretAccessKey is never returned in cleartext to the client.
  const secret = doc.secret && typeof doc.secret === 'object' ? doc.secret : {}
  document.getElementById('compute_accessKeyId').value = (typeof secret.accessKeyId === 'string' ? secret.accessKeyId : '') || ''
  document.getElementById('compute_secretAccessKey').value = ''
  document.getElementById('compute_secretAccessKey').placeholder = 'Leave blank to keep existing'
  document.getElementById('compute_arnRole').value = (typeof secret.arnRole === 'string' ? secret.arnRole : '') || ''
  document.getElementById('compute_default').checked = !!doc.default
  document.getElementById('compute__id').value = doc._id || ''
  const overlay = document.getElementById('compute_overlay')
  if (overlay) overlay.style.display = 'flex'
}

const createComputeRole = async function () {
  const accessKeyId = document.getElementById('compute_accessKeyId').value.trim()
  const secretAccessKey = document.getElementById('compute_secretAccessKey').value.trim()
  const region = document.getElementById('compute_region').value.trim() || 'eu-central-1'
  if (!accessKeyId || !secretAccessKey) { showWarning('Enter the Access Key ID and Secret Access Key first, then create the role.'); return }
  try {
    showLoading(true)
    const r = await freezr.apiRequest('POST', '/jobs/compute/create_role', { accessKeyId, secretAccessKey, region })
    if (!r || r.error || !r.arn) throw new Error((r && r.error) || 'no ARN returned')
    document.getElementById('compute_arnRole').value = r.arn
    showSuccess(r.alreadyExists ? 'Found existing Lambda role.' : 'Created Lambda role.')
  } catch (e) {
    showWarning('Could not create the role: ' + (e.message || e))
  } finally {
    showLoading(false)
  }
}

const saveCompute = async function () {
  const name = document.getElementById('compute_name').value.trim()
  const region = document.getElementById('compute_region').value.trim() || 'eu-central-1'
  const accessKeyId = document.getElementById('compute_accessKeyId').value.trim()
  const secretAccessKey = document.getElementById('compute_secretAccessKey').value.trim()
  const arnRole = document.getElementById('compute_arnRole').value.trim()
  const isDefault = document.getElementById('compute_default').checked
  const existingId = document.getElementById('compute__id').value

  if (!name) { showWarning('Name is required'); return }
  if (!accessKeyId) { showWarning('Access Key ID is required'); return }
  if (!existingId && !secretAccessKey) { showWarning('Secret Access Key is required'); return }

  try {
    showLoading(true)
    // Keep a single default.
    if (isDefault) {
      for (const c of state.compute) {
        if (c.default && c._id !== existingId) {
          await freezr.updateFields(TABLE_NAME, c._id, { default: false })
          c.default = false
        }
      }
    }

    const secret = { accessKeyId, arnRole }
    if (secretAccessKey) secret.secretAccessKey = secretAccessKey

    if (existingId) {
      if (secretAccessKey) {
        // full replace of the secret (new secret key provided)
        await freezr.update(TABLE_NAME, existingId, { type: 'compute', provider: 'aws', name, region, secret, default: isDefault })
      } else {
        // keep the stored secret key; update the non-secret fields + accessKeyId/arnRole only.
        // (Server re-encrypts whatever `secret` we send; without the secretAccessKey we'd lose it,
        //  so when blank we update only the plain fields and leave the existing record's secret.)
        await freezr.updateFields(TABLE_NAME, existingId, { name, region, default: isDefault })
      }
      state.compute = state.compute.map(c => c._id === existingId ? { ...c, name, region, default: isDefault, secret: { ...(c.secret || {}), accessKeyId, arnRole } } : c)
    } else {
      const params = { type: 'compute', provider: 'aws', name, region, secret, default: state.compute.length === 0 ? true : isDefault }
      const result = await freezr.create(TABLE_NAME, params)
      if (!result || result.error) throw new Error(result?.error || 'Error creating credential')
      state.compute.push({ _id: result._id, type: 'compute', provider: 'aws', name, region, default: params.default, secret: { accessKeyId, arnRole } })
    }

    showLoading(false)
    const overlay = document.getElementById('compute_overlay')
    if (overlay) overlay.style.display = 'none'
    redrawComputeList()
  } catch (e) {
    showLoading(false)
    showWarning(e.message || 'Error saving')
  }
}

const deleteCompute = async function () {
  const theId = document.getElementById('compute__id').value
  if (!theId) return
  if (!confirm('Delete this compute credential? Serverless jobs using it will stop running until you add another.')) return
  try {
    showLoading(true)
    await freezr.delete(TABLE_NAME, theId, {})
    state.compute = state.compute.filter(c => c._id !== theId)
    showLoading(false)
    const overlay = document.getElementById('compute_overlay')
    if (overlay) overlay.style.display = 'none'
    redrawComputeList()
  } catch (err) {
    showLoading(false)
    showWarning(err?.message || 'Error deleting credential')
  }
}

const setComputeDefault = async function (doc) {
  try {
    showLoading(true)
    for (const c of state.compute) {
      if (c.default && c._id !== doc._id) { await freezr.updateFields(TABLE_NAME, c._id, { default: false }); c.default = false }
    }
    await freezr.updateFields(TABLE_NAME, doc._id, { default: true })
    doc.default = true
    showLoading(false)
    redrawComputeList()
  } catch (err) {
    showLoading(false)
    showWarning(err?.message || 'Error setting default')
  }
}

const redrawComputeList = function () {
  if (!computeTable) return
  computeTable.innerHTML = ''
  if (state.compute.length === 0) {
    computeTable.innerHTML = '<p>No compute credentials yet. Click "Add AWS Credentials" to enable serverless jobs.</p>'
    return
  }
  state.compute.forEach(doc => {
    const row = document.createElement('div')
    row.className = 'gridlist'
    row.style.cssText = 'display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 0.75rem; padding: 0.75rem 0; border-bottom: 1px solid #e2e8f0;'

    const info = document.createElement('div')
    const nameSpan = document.createElement('span')
    nameSpan.style.fontWeight = '600'
    nameSpan.innerText = doc.name || '(unnamed)'
    info.appendChild(nameSpan)
    if (doc.default) {
      const badge = document.createElement('span')
      badge.style.cssText = 'display: inline-block; margin-left: 0.5rem; padding: 0.1rem 0.5rem; background: #059669; color: white; border-radius: 4px; font-size: 0.75rem;'
      badge.innerText = 'default'
      info.appendChild(badge)
    }
    const details = document.createElement('div')
    details.style.cssText = 'font-size: 0.85em; color: #64748b; margin-top: 0.25rem;'
    const akid = (doc.secret && typeof doc.secret.accessKeyId === 'string') ? doc.secret.accessKeyId : ''
    const maskedKey = akid ? (akid.slice(0, 4) + '…' + akid.slice(-4)) : 'key set'
    details.innerText = (doc.provider || 'aws') + ' · ' + (doc.region || '?') + ' · ' + maskedKey
    info.appendChild(details)
    row.appendChild(info)

    const actions = document.createElement('div')
    actions.style.cssText = 'display: flex; gap: 0.5rem; flex-wrap: wrap;'
    if (!doc.default) {
      const defaultBtn = document.createElement('span')
      defaultBtn.className = 'smallTextButt'
      defaultBtn.innerText = 'Set Default'
      defaultBtn.onclick = function () { setComputeDefault(doc) }
      actions.appendChild(defaultBtn)
    }
    const editBtn = document.createElement('span')
    editBtn.className = 'smallTextButt'
    editBtn.innerText = 'Edit'
    editBtn.onclick = function () { openComputeEditForm(doc) }
    actions.appendChild(editBtn)
    row.appendChild(actions)
    computeTable.appendChild(row)
  })
}

/* =====================================================================
 *  Connected Accounts section (Phase 1 Step 3)
 * =================================================================== */

// OAuth create / edit moved to dedicated pages /connections/new and /connections/edit?name=...

/* =====================================================================
 *  IMAP mailbox (app-password) connections — provider 'imap'
 *  Written directly to the resources table as type:'connection'. The server
 *  encrypts the imap/smtp credential blobs on write (resourceCrypto.mjs). No
 *  OAuth, no token refresh — the mail app talks to it identically to Gmail.
 * =================================================================== */

const IMAP_PRESETS = {
  yahoo: { imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465 },
  icloud: { imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587 },
  fastmail: { imapHost: 'imap.fastmail.com', imapPort: 993, smtpHost: 'smtp.fastmail.com', smtpPort: 465 },
  gmail: { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 },
  other: { imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465 }
}
const CONN_NAME_RX = /^[A-Za-z0-9_-]+$/

const clearImapForm = function () {
  document.getElementById('imap_name').value = ''
  document.getElementById('imap_email').value = ''
  document.getElementById('imap_pass').value = ''
  document.getElementById('imap_preset').value = 'yahoo'
  document.getElementById('imap_access').value = 'readwrite'
}

const applyImapPreset = function (key) {
  const p = IMAP_PRESETS[key] || IMAP_PRESETS.other
  document.getElementById('imap_host').value = p.imapHost
  document.getElementById('imap_port').value = p.imapPort
  document.getElementById('smtp_host').value = p.smtpHost
  document.getElementById('smtp_port').value = p.smtpPort
}

const saveImap = async function () {
  const connectionName = document.getElementById('imap_name').value.trim()
  const email = document.getElementById('imap_email').value.trim()
  const pass = document.getElementById('imap_pass').value
  const imapHost = document.getElementById('imap_host').value.trim()
  const imapPort = parseInt(document.getElementById('imap_port').value, 10) || 993
  const smtpHost = document.getElementById('smtp_host').value.trim()
  const smtpPort = parseInt(document.getElementById('smtp_port').value, 10) || 465
  const access = document.getElementById('imap_access').value === 'read' ? 'read' : 'readwrite'

  if (!connectionName) { showWarning('Connection name is required'); return }
  if (!CONN_NAME_RX.test(connectionName)) { showWarning('Connection name: letters, digits, underscore and dash only'); return }
  if (state.connections.find(c => c.connectionName === connectionName)) { showWarning('A connection named "' + connectionName + '" already exists'); return }
  if (!email) { showWarning('Email address is required'); return }
  if (!pass) { showWarning('App password is required'); return }
  if (!imapHost || !smtpHost) { showWarning('IMAP and SMTP hosts are required'); return }

  // Most providers use implicit TLS on 993 (IMAP) and 465 (SMTP); STARTTLS ports
  // (143 / 587) are not implicit-TLS, so flag secure=false for those.
  const imapSecure = imapPort !== 143
  const smtpSecure = smtpPort !== 587 && smtpPort !== 25

  const record = {
    type: 'connection',
    provider: 'imap',
    connectionName,
    account_email: email,
    services: ['mail'],
    access: { mail: access },
    status: 'ok',
    sync_bodies: false,
    sync_attachments: false,
    imap: { host: imapHost, port: imapPort, secure: imapSecure, user: email, pass },
    smtp: { host: smtpHost, port: smtpPort, secure: smtpSecure, user: email, pass }
  }

  try {
    showLoading(true)
    const result = await freezr.create(TABLE_NAME, record)
    if (!result || result.error) throw new Error(result?.error || 'Error creating connection')
    // Mirror the stored shape locally minus the secrets (never keep the password in page state).
    state.connections.push({
      _id: result._id, type: 'connection', provider: 'imap', connectionName,
      account_email: email, services: ['mail'], access: { mail: access }, status: 'ok'
    })
    showLoading(false)
    const overlay = document.getElementById('imap_overlay')
    if (overlay) overlay.style.display = 'none'
    redrawConnectionList()
    showSuccess('Added IMAP mailbox "' + connectionName + '". Open it from the mail app.')
  } catch (e) {
    showLoading(false)
    showWarning(e.message || 'Error saving IMAP mailbox')
  }
}
/* =====================================================================
 *  Slack token-paste connections — provider 'slack', services ['messaging']
 *  Same direct-write pattern as IMAP: written straight to the resources table
 *  (the server encrypts the oauth blob at rest — resourceCrypto.mjs). Lets Slack
 *  be used without the OAuth flow, via the User OAuth Token (xoxp) that
 *  "Install to Workspace" shows on the app's OAuth & Permissions page.
 *
 *  This lives here rather than on /connections/new because that page runs as
 *  info.freezr.connections, which has no write access to this table.
 *
 *  Slack user tokens don't expire (unless the app enables rotation), so a
 *  far-future expiry keeps the shared token-refresh path from ever firing.
 * =================================================================== */

const SLACK_TOKEN_NON_EXPIRING_MS = 100 * 365 * 24 * 60 * 60 * 1000 // ~100 years

const clearSlackTokenForm = function () {
  document.getElementById('slacktoken_name').value = ''
  document.getElementById('slacktoken_token').value = ''
  document.getElementById('slacktoken_access').value = 'readwrite'
  document.getElementById('slacktoken_live').checked = true
}

const saveSlackToken = async function () {
  const connectionName = document.getElementById('slacktoken_name').value.trim()
  const token = document.getElementById('slacktoken_token').value.trim()
  const access = document.getElementById('slacktoken_access').value === 'read' ? 'read' : 'readwrite'

  if (!connectionName) { showWarning('Connection name is required'); return }
  if (!CONN_NAME_RX.test(connectionName)) { showWarning('Connection name: letters, digits, underscore and dash only'); return }
  if (state.connections.find(c => c.connectionName === connectionName)) { showWarning('A connection named "' + connectionName + '" already exists'); return }
  if (!token) { showWarning('Token is required'); return }
  if (!token.startsWith('xoxp-')) {
    showWarning(token.startsWith('xoxb-')
      ? 'That is a Bot token (xoxb). Use the User OAuth Token (xoxp) — a bot only sees channels it was invited to, and cannot mark messages read.'
      : 'That does not look like a Slack User OAuth Token — it should start with xoxp-.')
    return
  }

  const record = {
    type: 'connection',
    provider: 'slack',
    connectionName,
    account_email: null,
    services: ['messaging'],
    access: { messaging: access },
    status: 'ok',
    refresh_lock_at: null,
    sync_bodies: false,
    sync_attachments: false,
    oauth: {
      accessToken: token,
      refreshToken: null,
      expiry: Date.now() + SLACK_TOKEN_NON_EXPIRING_MS,
      oauthConfigName: 'manual-token'
    }
  }

  const wantLive = document.getElementById('slacktoken_live').checked

  try {
    showLoading(true)
    const result = await freezr.create(TABLE_NAME, record)
    if (!result || result.error) throw new Error(result?.error || 'Error creating connection')
    const localRow = {
      _id: result._id, type: 'connection', provider: 'slack', connectionName,
      account_email: null, services: ['messaging'], access: { messaging: access }, status: 'ok', live: false
    }

    // Live-updates opt-in as part of creation (user request: don't make it a
    // separate step people forget). Goes through the same endpoint as the
    // toggle; a failure here (dead token, sockets machinery down) keeps the
    // connection but says so — the user can retry from the Edit page.
    let liveNote = ''
    if (wantLive) {
      try {
        const liveResp = await freezr.apiRequest('POST', '/acctapi/connection_set_live', { resource_id: result._id, live: true })
        if (liveResp && liveResp.error) throw new Error(liveResp.error)
        localRow.live = true
        liveNote = ' Live updates are on (they feed apps once the admin has sockets running).'
      } catch (le) {
        liveNote = ' Connection saved, but live updates could not be enabled: ' + (le?.message || le) + ' — retry from its Edit page.'
      }
    }

    // Mirror the stored shape locally minus the secrets (never keep the token in page state).
    state.connections.push(localRow)
    showLoading(false)
    const overlay = document.getElementById('slacktoken_overlay')
    if (overlay) overlay.style.display = 'none'
    redrawConnectionList()
    showSuccess('Added Slack workspace "' + connectionName + '".' + liveNote + ' Open it at /connections/messaging.')
  } catch (e) {
    showLoading(false)
    showWarning(e.message || 'Error saving Slack connection')
  }
}

// This file now only handles the LIST view + Disconnect action + URL-param banners.

const disconnectConnection = async function (doc) {
  if (!confirm('Disconnect "' + (doc.connectionName || 'this account') + '"? This will revoke the token and remove the connection from freezr. Any future apps trying to use it will fail until you reconnect.')) {
    return
  }
  try {
    showLoading(true)
    // Best-effort: server-side revoke + delete. We don't block on revoke failure — the local
    // record gets deleted either way so the user is "disconnected" from their perspective.
    const result = await freezr.apiRequest('POST', '/acctapi/connection_disconnect', { resource_id: doc._id })
    if (result && result.error) throw new Error(result.error)

    state.connections = state.connections.filter(c => c._id !== doc._id)
    redrawConnectionList()
    showSuccess('Disconnected ' + (doc.connectionName || 'account'))
  } catch (err) {
    console.warn('disconnect failed:', err)
    showWarning(err?.message || 'Could not disconnect — try refreshing the page.')
  } finally {
    showLoading(false)
  }
}

const redrawConnectionList = function () {
  if (!connectionTable) return
  connectionTable.innerHTML = ''

  const conns = state.connections

  if (conns.length === 0) {
    connectionTable.innerHTML = '<p>No connected accounts yet. Click "Connect Account" to authorize Gmail (and later, calendar/contacts on the same grant).</p>'
    return
  }

  conns.forEach(doc => {
    const row = document.createElement('div')
    row.className = 'gridlist'
    row.id = 'connRow_' + (doc.connectionName || doc._id)
    row.style.cssText = 'display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 0.75rem; padding: 0.75rem 0; border-bottom: 1px solid #e2e8f0;'

    const info = document.createElement('div')

    const nameSpan = document.createElement('span')
    nameSpan.style.fontWeight = '600'
    nameSpan.innerText = doc.connectionName || '(unnamed)'
    info.appendChild(nameSpan)

    const providerBadge = document.createElement('span')
    providerBadge.style.cssText = 'display: inline-block; margin-left: 0.5rem; padding: 0.1rem 0.5rem; background: #1e40af; color: white; border-radius: 4px; font-size: 0.75rem;'
    providerBadge.innerText = doc.provider || 'unknown'
    info.appendChild(providerBadge)

    const status = (doc.status || 'ok').toLowerCase()
    const statusBadge = document.createElement('span')
    if (status === 'ok') {
      statusBadge.style.cssText = 'display: inline-block; margin-left: 0.5rem; padding: 0.1rem 0.5rem; background: #059669; color: white; border-radius: 4px; font-size: 0.75rem;'
      statusBadge.innerText = 'connected'
    } else if (status === 'token_expired') {
      statusBadge.style.cssText = 'display: inline-block; margin-left: 0.5rem; padding: 0.1rem 0.5rem; background: #dc2626; color: white; border-radius: 4px; font-size: 0.75rem;'
      statusBadge.innerText = 'needs reconnect'
    } else {
      statusBadge.style.cssText = 'display: inline-block; margin-left: 0.5rem; padding: 0.1rem 0.5rem; background: #6b7280; color: white; border-radius: 4px; font-size: 0.75rem;'
      statusBadge.innerText = status
    }
    info.appendChild(statusBadge)

    const details = document.createElement('div')
    details.style.cssText = 'font-size: 0.85em; color: #64748b; margin-top: 0.25rem;'
    const services = Array.isArray(doc.services) ? doc.services : []
    const access = doc.access || {}
    const servicesText = services.length > 0
      ? services.map(s => s + ' (' + (access[s] === 'readwrite' ? 'read+write' : 'read') + ')').join(', ')
      : 'no services enabled'
    const emailText = doc.account_email ? (doc.account_email + ' · ') : ''
    // Local file stores: show the folder they expose (local fsParams are stored in
    // plaintext — they hold no secret; cloud store credentials stay encrypted).
    const pathText = (doc.fsParams && doc.fsParams.rootPath) ? (doc.fsParams.rootPath + ' · ') : ''
    details.innerText = emailText + pathText + servicesText
    info.appendChild(details)

    row.appendChild(info)

    const actions = document.createElement('div')
    actions.style.cssText = 'display: flex; gap: 0.5rem; flex-wrap: wrap;'

    // Per-service action links (mirror of the /connections page). Each
    // per-service page picks the connection itself via /feps/connections/accounts;
    // the link is just a navigation hint, one per service the connection has.
    if (services.includes('mail')) {
      const openMail = document.createElement('a')
      openMail.className = 'smallTextButt'
      openMail.href = '/connections/mail'
      openMail.innerText = 'Open Mail'
      actions.appendChild(openMail)
    }
    if (services.includes('contacts')) {
      const openContacts = document.createElement('a')
      openContacts.className = 'smallTextButt'
      openContacts.href = '/connections/contacts'
      openContacts.innerText = 'Open Contacts'
      actions.appendChild(openContacts)
    }
    if (services.includes('calendar')) {
      const openCal = document.createElement('a')
      openCal.className = 'smallTextButt'
      openCal.href = '/connections/calendar'
      openCal.innerText = 'Open Calendar'
      actions.appendChild(openCal)
    }
    if (services.includes('messaging')) {
      const openMessaging = document.createElement('a')
      openMessaging.className = 'smallTextButt'
      openMessaging.href = '/connections/messaging'
      openMessaging.innerText = 'Open Messaging'
      actions.appendChild(openMessaging)

      // Live-updates opt-in (Tier-2 socket permission): user-level toggle that
      // registers/unregisters this connection for server-side socket routing.
      // Note it grants nothing alone — the admin must also have enabled sockets.
      const liveBtn = document.createElement('span')
      liveBtn.className = 'smallTextButt'
      liveBtn.innerText = doc.live ? 'Live updates: ON' : 'Live updates: off'
      liveBtn.style.color = doc.live ? '#059669' : '#6b7280'
      liveBtn.title = doc.live
        ? 'The server routes real-time activity for this connection (if the admin has sockets enabled). Click to turn off.'
        : 'Let the server track real-time activity for this connection so apps can sync efficiently. Needs admin-enabled sockets to take effect.'
      liveBtn.onclick = async function () {
        try {
          showLoading(true)
          const resp = await freezr.apiRequest('POST', '/acctapi/connection_set_live', { resource_id: doc._id, live: !doc.live })
          if (resp && resp.error) throw new Error(resp.error)
          doc.live = !doc.live
          redrawConnectionList()
          showSuccess('Live updates ' + (doc.live ? 'enabled' : 'disabled') + ' for ' + (doc.connectionName || 'connection') + '.')
        } catch (err) {
          showWarning(err?.message || 'Could not change live updates')
        } finally {
          showLoading(false)
        }
      }
      actions.appendChild(liveBtn)
    }

    // File stores are managed right here (no /connections/edit page for them, no
    // token to revoke): a plain Remove instead of Edit/Disconnect.
    const isFileStore = services.includes('fs')
    if (isFileStore) {
      const removeBtn = document.createElement('span')
      removeBtn.className = 'smallTextButt'
      removeBtn.style.color = '#dc2626'
      removeBtn.innerText = 'Remove'
      removeBtn.onclick = function () { removeFileStore(doc) }
      actions.appendChild(removeBtn)
    } else {
      const editLink = document.createElement('a')
      editLink.className = 'smallTextButt'
      editLink.innerText = (status === 'token_expired') ? 'Reconnect' : 'Edit'
      editLink.href = '/connections/edit?name=' + encodeURIComponent(doc.connectionName || '')
      actions.appendChild(editLink)

      const disconnectBtn = document.createElement('span')
      disconnectBtn.className = 'smallTextButt'
      disconnectBtn.style.color = '#dc2626'
      disconnectBtn.innerText = 'Disconnect'
      disconnectBtn.onclick = function () { disconnectConnection(doc) }
      actions.appendChild(disconnectBtn)
    }

    row.appendChild(actions)
    connectionTable.appendChild(row)
  })
}

/* =====================================================================
 *  URL param handling: OAuth success banner, focus deep link
 * =================================================================== */

const handleUrlParams = function () {
  const params = new URLSearchParams(window.location.search)

  // Success banner after returning from a connection-purpose OAuth flow.
  if (params.get('success') === 'true' && params.get('purpose') === 'connection') {
    const connectionName = params.get('connectionName') || ''
    const actualServices = params.get('services') || ''   // server returns actually-granted services
    const downgradedRaw = params.get('downgraded') || ''   // JSON string from oauth controller if any service was downgraded
    let message = 'Connected ' + connectionName + ' successfully.'
    if (actualServices) message += ' Services enabled: ' + actualServices.split(',').join(', ') + '.'
    // Surface downgrades (e.g. user requested readwrite but only granted read for some service)
    // so the user isn't confused later when an app can't write what they thought they'd granted.
    if (downgradedRaw) {
      try {
        const items = JSON.parse(downgradedRaw)
        if (Array.isArray(items) && items.length > 0) {
          const summary = items.map(d => d.service + ' (asked ' + d.requested + ', got ' + d.effective + ')').join('; ')
          showWarning('Some services were not granted at the level requested: ' + summary + '. Reconnect to retry on Google’s consent screen.', 10000)
        }
      } catch (_) { /* malformed; ignore */ }
    }
    showSuccess(message)
    cleanUrlParams(['success', 'purpose', 'resource_id', 'connectionName', 'provider', 'services', 'downgraded'])
  }

  // ?focus=<connectionName> — scroll/highlight, auto-open reconnect if token_expired.
  const focusName = params.get('focus')
  if (focusName) {
    const target = state.connections.find(c => c.connectionName === focusName)
    if (target) {
      const rowEl = document.getElementById('connRow_' + focusName)
      if (rowEl) {
        rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
        const prevBg = rowEl.style.backgroundColor
        rowEl.style.backgroundColor = '#fef3c7'
        setTimeout(() => { rowEl.style.backgroundColor = prevBg }, 2200)
      }
      if ((target.status || '').toLowerCase() === 'token_expired') {
        // Connection needs reconnect — send the user straight to the dedicated edit page.
        // Brief delay so the highlight registers before the navigation.
        setTimeout(() => { window.location.href = '/connections/edit?name=' + encodeURIComponent(target.connectionName || '') }, 600)
      }
    }
    cleanUrlParams(['focus'])
  }
}

const cleanUrlParams = function (keys) {
  try {
    const url = new URL(window.location.href)
    keys.forEach(k => url.searchParams.delete(k))
    window.history.replaceState({}, document.title, url.toString())
  } catch (_) { /* non-critical */ }
}

/* =====================================================================
 *  Shared UI helpers
 * =================================================================== */

const showLoading = function (doShow) {
  const loader = document.getElementById('loader')
  if (loader) loader.style.display = doShow ? 'block' : 'none'
}

const showWarning = function (msg, timing) {
  if (msg) console.log('WARNING : ' + JSON.stringify(msg))
  const warnDiv = document.getElementById('warnings')
  if (!warnDiv) return
  window.scrollTo(0, 0)
  if (!msg) {
    warnDiv.innerText = ''
    warnDiv.style.display = 'none'
  } else {
    warnDiv.style.display = 'block'
    warnDiv.innerText = msg
    if (!timing) timing = 5000
    setTimeout(function () { showWarning() }, timing)
  }
}

const showSuccess = function (msg, timing) {
  const div = document.getElementById('success_banner')
  if (!div) return
  if (!msg) {
    div.innerText = ''
    div.style.display = 'none'
    return
  }
  div.style.display = 'block'
  div.innerText = msg
  if (!timing) timing = 5000
  setTimeout(function () { showSuccess() }, timing)
}
