// freezr - account_remove.js
// Drives the /account/remove page: fetches which removal mode applies (full delete vs detach),
// renders the matching explanation, and performs the password + username-confirmed removal.

/* global freezr, freezrMeta */

let HAS_CHOICE = false
let KEPT_NOUN = 'your data'

freezr.initPageScripts = function () {
  document.addEventListener('click', function (evt) {
    const args = (evt.target.id || '').split('_')
    if (args.length > 1 && args[0] === 'click' && args[1] === 'remove') removeAccount()
  })
  loadRemoveInfo()
}

function loadRemoveInfo () {
  freezr.apiRequest('GET', '/acctapi/account/removeInfo')
    .then(function (data) {
      HAS_CHOICE = !!(data && (data.hasChoice || data.isCloud))
      KEPT_NOUN = (data && data.keptNoun) || 'your data'
      text('userIdHint', data && data.userId ? data.userId : (freezrMeta && freezrMeta.userId) || '')
      if (HAS_CHOICE) {
        show('cloudChoice'); hide(['hostExplain'])
        text('keptNounIntro', KEPT_NOUN)
        text('keptNounChoice', KEPT_NOUN)
      } else {
        show('hostExplain'); hide(['cloudChoice'])
        text('fsLabelHost', (data && data.fsLabel) || 'host storage')
      }
    })
    .catch(function (err) { showError('Could not load account info: ' + (err.message || err)) })
}

// Host-only users always full-delete; users with their own data pick via the radio (default detach).
function selectedMode () {
  if (!HAS_CHOICE) return 'full'
  const checked = document.querySelector('input[name="removeMode"]:checked')
  return (checked && checked.value === 'full') ? 'full' : 'detach'
}

function removeAccount () {
  const confirmUsername = document.getElementById('confirmUsername').value
  const password = document.getElementById('removePassword').value
  const removePublicPosts = document.getElementById('removePublicPosts').checked
  const mode = selectedMode()

  if (!confirmUsername) return showError('Please type your user id to confirm.')
  if (!password) return showError('Please enter your password.')

  const warn = (mode === 'full')
    ? 'This permanently DELETES all your data' + (HAS_CHOICE ? ' (including ' + KEPT_NOUN + ')' : '') + ' and your account. This cannot be undone. Continue?'
    : 'This removes your account and credentials from this server but keeps ' + KEPT_NOUN + '. Continue?'
  if (!window.confirm(warn)) return

  showError('Removing your account…')
  freezr.apiRequest('PUT', '/acctapi/account/remove', {
    confirmUsername: confirmUsername,
    password: password,
    removePublicPosts: removePublicPosts,
    mode: mode
  })
    .then(function () {
      // Account is gone (or detached) — the session is invalid; send them out.
      window.location = '/account/logout'
    })
    .catch(function (err) { showError('Could not remove account: ' + (err.message || err)) })
}

// ---- tiny dom helpers ----
function text (id, t) { const el = document.getElementById(id); if (el) el.textContent = t }
function show (id) { const el = document.getElementById(id); if (el) el.style.display = 'block' }
function hide (ids) { ids.forEach(function (id) { const el = document.getElementById(id); if (el) el.style.display = 'none' }) }
function showError (t) {
  const el = document.getElementById('errorBox')
  if (!el) return
  el.innerHTML = t || ''
  el.style.display = t ? 'block' : 'none'
}
