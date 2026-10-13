/**
 * use_file_sys — LIVE end-to-end probe against a running freezr server.
 *
 * Proves the whole phase-1 loop on a real server (default http://localhost:3000):
 *   1. login as the admin test user (guest1 — users_freezr/test_credentials/testUserCreds.json)
 *   2. enable the `local_fs_access_enabled` admin pref if it is off (mimics a prefs-page
 *      save: current values are parsed from the rendered /admin/prefs page)
 *   3. seed a store folder at ~/freezr-fs-teststore (hello.txt, notes.md, sub/data.json, binary.bin)
 *   4. create the 'teststore' fs connection record (services ['fs'], type local) if missing
 *   5. zip + install the demo app testuserapp/com.test.filebrowser (skipped if installed)
 *   6. grant its use_file_sys (naming teststore, read+write) and use_llm permissions
 *   7. exercise /feps/connections/fs: list, tree, stat, read (raw + base64/binary),
 *      write / overwrite conflict / remove, and the fail-closed cases (traversal path,
 *      unknown store, an app with no grant)
 *   8. optionally sends one tiny /feps/llm/ask with a file's text (non-fatal)
 *
 * Run:  node test/manual/fs-store-probe.mjs        (server must be running on :3000)
 * NOTE: this ENABLES the local_fs_access_enabled pref and leaves it on, and leaves the
 * store folder + demo app + grants in place so the app can be used interactively after.
 */

import fetch from 'node-fetch' // the helper's parseCookies needs node-fetch's headers.raw()
import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { TestAuthHelper, loadTestCredentials } from '../integration/ceps/testAuthHelper.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
const APP_NAME = 'com.test.filebrowser'
const STORE_NAME = 'teststore'
const STORE_DIR = path.join(os.homedir(), 'freezr-fs-teststore')
const RESOURCES_TABLE = 'info.freezr.account.resources'
const ACCOUNT_APP = 'info.freezr.account'
const BINARY_BYTES = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x68, 0x69])

const results = []
const check = (label, cond, extra = '') => {
  results.push({ label, ok: !!cond })
  console.log((cond ? '  ✅ ' : '  ❌ ') + label + (cond || !extra ? '' : ' — ' + extra))
}
const fatal = (msg) => { console.error('\n🛑 ' + msg); process.exit(1) }

const creds = loadTestCredentials()
const SERVER = process.env.FREEZR_TEST_SERVER_URL || creds.serverUrl || 'http://localhost:3000'
const ADMIN = creds.users.admin || creds.users.primary

// ---------------------------------------------------------------- step 1: login
const auth = new TestAuthHelper(SERVER)
const login = await auth.login(ADMIN.user_id, ADMIN.password)
if (!login.success) fatal('Could not log in as ' + ADMIN.user_id + ' — is the server running at ' + SERVER + '?')
console.log('✓ logged in as ' + ADMIN.user_id)

const acctGet = (ep) => auth.get(ep, { app: ACCOUNT_APP })
const acctPost = (ep, body) => auth.post(ep, body, { app: ACCOUNT_APP })
const acctPut = (ep, body) => auth.put(ep, body, { app: ACCOUNT_APP })

// ---------------------------------------------------------------- step 2: pref
let status = (await acctGet('/feps/connections/fs/local_status')).data
if (!status || status.isAdmin !== true) fatal('Test user ' + ADMIN.user_id + ' is not an admin — cannot exercise local stores. ' + JSON.stringify(status))
if (!status.systemFsIsLocal) fatal('This server\'s system fs is not local — local stores are unavailable here by design.')

if (!status.enabled) {
  console.log('… local_fs_access_enabled is off — enabling it (mimics an /admin/prefs save)')
  // Visiting the prefs page both renders the current values AND mints the admin-app
  // token cookie that /adminapi requires (path-scoped app_token for info.freezr.admin).
  const ADMIN_APP = 'info.freezr.admin'
  let pageResp = await fetch(SERVER + '/admin/prefs', { headers: { Cookie: auth.getCookieHeader(ACCOUNT_APP) }, redirect: 'manual' })
  auth.parseCookies(pageResp.headers, ADMIN_APP)
  if (pageResp.headers.get('location')) {
    pageResp = await fetch(SERVER + pageResp.headers.get('location'), { headers: { Cookie: auth.getCookieHeader(ADMIN_APP) }, redirect: 'manual' })
    auth.parseCookies(pageResp.headers, ADMIN_APP)
  }
  const html = await pageResp.text()
  const checkbox = (id) => {
    const m = html.match(new RegExp('<input[^>]*id="' + id + '"[^>]*>'))
    return !!(m && /\schecked[\s/>]/.test(m[0] + '>'))
  }
  const textVal = (id) => {
    const m = html.match(new RegExp('<input[^>]*id="' + id + '"[^>]*>'))
    if (!m) return ''
    const v = m[0].match(/value="([^"]*)"/)
    return v ? v[1] : ''
  }
  const prefsBody = {
    allowSelfReg: checkbox('allowSelfRegId'),
    allowAccessToSysFsDb: checkbox('allowAccessToSysFsDbId'),
    log_visits: checkbox('logVisitsId'),
    scheduler_disabled: checkbox('schedulerDisabledId'),
    sockets_enabled: checkbox('socketsEnabledId'),
    local_llm_cli_enabled: checkbox('localLlmCliEnabledId'),
    local_fs_access_enabled: true,
    redirect_public: checkbox('redirectPublicId'),
    selfRegDefaultMBStorageLimit: parseInt(textVal('selfRegDefaultMBStorageLimit')) || null,
    serverless_callback_url: textVal('serverlessCallbackUrlId'),
    apiRateLimitPerUserMinute: parseInt(textVal('apiRateLimitPerUserMinute')) || null,
    public_landing_app: textVal('defaultPublicAppId'),
    public_landing_page: textVal('defaultLandingUrl'),
    password: ADMIN.password
  }
  const prefRes = await auth.post('/adminapi/change_main_prefs', prefsBody, { app: ADMIN_APP })
  if (!prefRes.ok) fatal('Could not enable local_fs_access_enabled: ' + JSON.stringify(prefRes.data))
  status = (await acctGet('/feps/connections/fs/local_status')).data
}
check('local_status: enabled + admin + local fs + localhost',
  status.enabled && status.isAdmin && status.systemFsIsLocal && status.onLocalhost, JSON.stringify(status))

// ---------------------------------------------------------------- step 3: seed store folder
nodeFs.mkdirSync(path.join(STORE_DIR, 'sub'), { recursive: true })
nodeFs.writeFileSync(path.join(STORE_DIR, 'hello.txt'), 'hello from the freezr fs test store\n')
nodeFs.writeFileSync(path.join(STORE_DIR, 'notes.md'), '# Test notes\n\nfreezr use_file_sys demo store.\n')
nodeFs.writeFileSync(path.join(STORE_DIR, 'sub', 'data.json'), JSON.stringify({ nested: true }) + '\n')
nodeFs.writeFileSync(path.join(STORE_DIR, 'binary.bin'), BINARY_BYTES)
console.log('✓ seeded store folder ' + STORE_DIR)

// server-side validation of the candidate root
const validation = (await acctGet('/feps/connections/fs/local_status?path=' + encodeURIComponent(STORE_DIR))).data
check('local_status validates the store path', validation && validation.pathValid === true, JSON.stringify(validation))
const rootReal = validation.pathReal || STORE_DIR

// ---------------------------------------------------------------- step 4: connection record
// CEPS query bodies carry the filter under `q` (see cepsfepsApiController.dbQuery)
const existing = await acctPost('/ceps/query/' + RESOURCES_TABLE, { q: { type: 'connection', connectionName: STORE_NAME } })
const rows = Array.isArray(existing.data) ? existing.data : (existing.data?.results || [])
if (rows.length > 0) {
  console.log('✓ fs connection record "' + STORE_NAME + '" already exists (rootPath ' + (rows[0].fsParams?.rootPath || '?') + ')')
} else {
  const createRes = await acctPost('/ceps/write/' + RESOURCES_TABLE, {
    type: 'connection',
    provider: 'localfs',
    connectionName: STORE_NAME,
    account_email: null,
    services: ['fs'],
    access: { fs: 'readwrite' },
    status: 'ok',
    fsParams: { type: 'local', rootPath: rootReal }
  })
  if (!createRes.ok) fatal('Could not create fs connection record: ' + JSON.stringify(createRes.data))
  console.log('✓ created fs connection record "' + STORE_NAME + '"')
}

// ---------------------------------------------------------------- step 5: install demo app
const appList = await acctGet('/acctapi/getAppList')
const appInstalled = JSON.stringify(appList.data || '').includes(APP_NAME)
if (appInstalled) {
  console.log('✓ demo app ' + APP_NAME + ' already installed')
} else {
  const zipPath = path.join(os.tmpdir(), APP_NAME + '.zip')
  try { nodeFs.rmSync(zipPath) } catch (e) { /* fresh */ }
  const zipRes = spawnSync('zip', ['-r', zipPath, '.'], { cwd: path.join(REPO_ROOT, 'testuserapp', APP_NAME) })
  if (zipRes.status !== 0) fatal('zip failed: ' + zipRes.stderr)
  const form = new FormData()
  form.append('file', new Blob([nodeFs.readFileSync(zipPath)], { type: 'application/zip' }), APP_NAME + '.zip')
  const accountToken = auth.appTokens[auth.userId]?.[ACCOUNT_APP] || auth.cookies['app_token_' + auth.userId]
  // global (undici) fetch here: it natively streams FormData/Blob multipart bodies
  const installResp = await globalThis.fetch(SERVER + '/acctapi/app_install_from_zipfile', {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + accountToken, Cookie: auth.getCookieHeader(ACCOUNT_APP) },
    body: form
  })
  const installData = await installResp.json().catch(() => ({}))
  if (!installResp.ok) fatal('App install failed: ' + JSON.stringify(installData))
  console.log('✓ installed demo app ' + APP_NAME)
}

// ---------------------------------------------------------------- step 6: grants
const grant = async (permName, extra = {}) => acctPut('/feps/permissions/change', {
  change: { name: permName, requestor_app: APP_NAME, action: 'Accept', ...extra },
  targetApp: APP_NAME
})
const fsGrant = await grant('browse_store', { connection_names: [STORE_NAME], scopes: ['read', 'write'] })
check('grant use_file_sys (teststore, read+write)', fsGrant.ok, JSON.stringify(fsGrant.data))
const llmGrant = await grant('analyze_files')
check('grant use_llm', llmGrant.ok, JSON.stringify(llmGrant.data))

// app token for the demo app
const { app_password: appPw } = await auth.generateAppPassword(APP_NAME, 30)
const { access_token: appToken } = await auth.exchangeAppPasswordForToken(appPw, APP_NAME)
auth.setAppToken(auth.userId, APP_NAME, appToken)
console.log('✓ minted app token for ' + APP_NAME)
const appGet = (ep) => auth.get(ep, { app: APP_NAME })
const appPut = (ep, body) => auth.put(ep, body, { app: APP_NAME })
const appDelete = (ep) => auth.delete(ep, { app: APP_NAME })
const FS_BASE = '/feps/connections/fs/' + STORE_NAME

// ---------------------------------------------------------------- step 7: exercise the API
// capability ping
const ping = await appGet('/ceps/ping')
const fsPerm = (ping.data?.permissions || []).find(p => p.type === 'use_file_sys')
check('ping reports use_file_sys usable', fsPerm && fsPerm.usable === true, JSON.stringify(fsPerm))
check('ping capability counts include the fs store', ping.data?.capabilities?.connections?.fs >= 1,
  JSON.stringify(ping.data?.capabilities?.connections))

// list
const list = await appGet(FS_BASE + '/list')
const names = (list.data?.entries || []).map(e => e.name)
check('list root returns seeded entries', list.ok && names.includes('hello.txt') && names.includes('sub') && names.includes('binary.bin'), JSON.stringify(list.data))
check('list entries carry type/size/mtime', (list.data?.entries || []).every(e => (e.type === 'dir' || e.type === 'file') && 'size' in e && 'mtimeMs' in e))

// tree
const tree = await appGet(FS_BASE + '/list?depth=2')
const subNode = (tree.data?.tree || []).find(e => e.name === 'sub')
check('tree (depth 2) descends into sub/', !!(subNode && (subNode.children || []).some(c => c.name === 'data.json')), JSON.stringify(tree.data))

// stat
const stat = await appGet(FS_BASE + '/stat?path=' + encodeURIComponent('sub/data.json'))
check('stat returns file metadata', stat.ok && stat.data?.entry?.type === 'file' && stat.data.entry.size > 0, JSON.stringify(stat.data))

// read raw (text)
const rawRead = await appGet(FS_BASE + '/read?path=hello.txt')
check('read returns exact file text', rawRead.status === 200 && rawRead.data === 'hello from the freezr fs test store\n', JSON.stringify(rawRead.data).slice(0, 120))

// read base64 (binary fidelity)
const b64Read = await appGet(FS_BASE + '/read?path=binary.bin&encoding=base64')
check('read?encoding=base64 preserves binary bytes', b64Read.ok && b64Read.data?.contentBase64 === BINARY_BYTES.toString('base64'), JSON.stringify(b64Read.data))

// write / conflict / overwrite / remove
const wr1 = await appPut(FS_BASE + '/write', { path: 'probe/probe-note.txt', content: 'written by fs-store-probe\n' })
check('write creates a file (with parent dirs)', wr1.ok && nodeFs.readFileSync(path.join(STORE_DIR, 'probe', 'probe-note.txt'), 'utf8') === 'written by fs-store-probe\n', JSON.stringify(wr1.data))
const wr2 = await appPut(FS_BASE + '/write', { path: 'probe/probe-note.txt', content: 'clobber' })
check('write without overwrite → 409', wr2.status === 409, wr2.status + ' ' + JSON.stringify(wr2.data))
const wr3 = await appPut(FS_BASE + '/write', { path: 'probe/probe-note.txt', content: 'clobber', overwrite: true })
check('write with overwrite succeeds', wr3.ok && nodeFs.readFileSync(path.join(STORE_DIR, 'probe', 'probe-note.txt'), 'utf8') === 'clobber')
const rm1 = await appDelete(FS_BASE + '/remove?path=' + encodeURIComponent('probe/probe-note.txt'))
check('remove deletes the file', rm1.ok && !nodeFs.existsSync(path.join(STORE_DIR, 'probe', 'probe-note.txt')), JSON.stringify(rm1.data))
const rm2 = await appDelete(FS_BASE + '/remove?path=' + encodeURIComponent('probe/probe-note.txt'))
check('second remove → 404', rm2.status === 404, rm2.status + '')

// fail-closed cases
const traversal = await appGet(FS_BASE + '/read?path=' + encodeURIComponent('../secret.txt'))
check('traversal path is refused (400)', traversal.status === 400, traversal.status + ' ' + JSON.stringify(traversal.data))
const wrongStore = await appGet('/feps/connections/fs/nosuchstore/list')
check('unknown / ungranted store → 403', wrongStore.status === 403, wrongStore.status + '')
const dirRemove = await appDelete(FS_BASE + '/remove?path=sub')
check('removing a directory is refused', dirRemove.status === 400, dirRemove.status + ' ' + JSON.stringify(dirRemove.data))

// an app with NO use_file_sys grant must be locked out
try {
  const OTHER_APP = creds.testAppConfig.appName
  const { app_password: otherPw } = await auth.generateAppPassword(OTHER_APP, 1)
  const { access_token: otherToken } = await auth.exchangeAppPasswordForToken(otherPw, OTHER_APP)
  auth.setAppToken(auth.userId, OTHER_APP, otherToken)
  const denied = await auth.get(FS_BASE + '/list', { app: OTHER_APP })
  check('app without use_file_sys grant → 403', denied.status === 403, denied.status + ' ' + JSON.stringify(denied.data))
} catch (e) {
  check('app without use_file_sys grant → 403', false, 'could not mint token for control app: ' + e.message)
}

// ---------------------------------------------------------------- step 8: LLM hand-off (non-fatal)
console.log('… trying the LLM hand-off (browse → read → /feps/llm/ask); non-fatal if no LLM is configured')
try {
  const fileText = rawRead.data
  const llmResp = await auth.put('/feps/llm/ask', {
    prompt: 'The following is a file from my file store. Reply with exactly its last word.\n\n' + fileText
  }, { app: APP_NAME })
  // /feps/llm/ask answers as an SSE stream — parse the data: events for the done payload
  let done = null
  const deltas = []
  if (typeof llmResp.data === 'string') {
    for (const line of llmResp.data.split('\n')) {
      if (!line.startsWith('data:')) continue
      try {
        const evt = JSON.parse(line.slice(5).trim())
        if (evt.type === 'delta' && evt.text) deltas.push(evt.text)
        if (evt.response !== undefined || evt.type === 'done') done = evt
      } catch (e) { /* keep-alive / partial line */ }
    }
  } else if (llmResp.data && typeof llmResp.data === 'object') {
    done = llmResp.data
  }
  const answer = ((done && done.response) || deltas.join('') || '').toString().trim()
  check('LLM answered about the file (browse → read → ask loop)', llmResp.ok && answer.length > 0,
    llmResp.status + ' ' + JSON.stringify(llmResp.data).slice(0, 300))
  if (answer) console.log('    LLM said: "' + answer.slice(0, 120) + '" (provider: ' + (done?.provider || '?') + ')')
} catch (e) {
  check('LLM answered about the file (browse → read → ask loop)', false, e.message)
}

// ---------------------------------------------------------------- summary
const failed = results.filter(r => !r.ok)
console.log('\n' + '='.repeat(60))
console.log(failed.length === 0
  ? '🎉 ALL ' + results.length + ' CHECKS PASSED'
  : '⚠️  ' + failed.length + ' of ' + results.length + ' checks FAILED: ' + failed.map(f => f.label).join(' | '))
console.log('Store folder: ' + STORE_DIR + '  ·  demo app: ' + SERVER + '/apps/' + APP_NAME)
process.exit(failed.length === 0 ? 0 : 1)
