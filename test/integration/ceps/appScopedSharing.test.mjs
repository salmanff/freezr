/**
 * App-scoped messaging + sharing integration tests
 *
 * Covers the 2026-08/09 changes:
 *  1. dev.ceps messaging with recipient_app (same-user app-to-app) and optional contact_permission
 *  2. share_records with app grantees (grantees: ['app:<appName>']) → _accessibles grantee_app
 *  3. app-scoped FILE sharing via getuserfiletoken (previously a blanket cross-app 403)
 *  4. legacy user-scoped grants (no grantee_app) behave exactly as before
 *  5. deny removes ONLY the matching (grantee, grantee_app, requestor_app, permission_name) entry
 *
 *   App A = com.salmanff.apitester       (sender / granting app; owns table1 + its .files)
 *   App B = com.salmanff.apitestgrantee  (recipient / consuming app)
 *   App C = com.salmanff.apitestthird    (bystander app — must never get access)
 *
 * Prerequisites (same shape as the other ceps tests — see README.md):
 *   1. Server running in test mode:  npm run devtest
 *   2. guest1 exists with com.salmanff.apitester + com.salmanff.apitestgrantee installed
 *   3. guest2 exists with com.salmanff.apitester installed (for the cross-user legacy tests)
 *
 *   Run with:  npx mocha test/integration/ceps/appScopedSharing.test.mjs
 */

import { expect } from 'chai'
import { createAuthenticatedHelper, loadTestCredentials } from './testAuthHelper.mjs'

const APP_A = 'com.salmanff.apitester'
const APP_B = 'com.salmanff.apitestgrantee'
const APP_C = 'com.salmanff.apitestthird'
const TABLE = 'com.salmanff.apitester.table1'
const FILES_TABLE = APP_A + '.files'
const MSG_PERM = 'message_link'
const SHARE_PERM = 'public_link_test'
const FILE_SHARE_PERM = 'file_share_perm'

let serverUrl
try {
  serverUrl = loadTestCredentials().serverUrl
} catch (error) {
  console.error('Failed to load test credentials:', error.message)
  process.exit(1)
}

// Mint a token for an extra app on an already-logged-in helper and register it,
// so helper.get/post(..., { app: appName }) uses it.
async function mintExtraAppToken (auth, appName) {
  const pw = await auth.generateAppPassword(appName, 90)
  const tok = await auth.exchangeAppPasswordForToken(pw.app_password, appName)
  auth.setAppToken(auth.userId, appName, tok.access_token)
  return tok.access_token
}

describe('App-scoped messaging + sharing (recipient_app / grantee_app)', function () {
  this.timeout(60000)

  let auth1 // guest1, primary — tokens for APP_A, APP_B, APP_C
  let auth2 // guest2, secondary — tokens for APP_A, APP_B
  let auth2ok = false
  let appCTokenOk = false

  let msgRecordId = null // record sent by message
  let gotMessageId = null // the message in guest1's got-inbox (addressed to APP_B)
  let sharedRecordId = null // record shared app-scoped (+ later user-scoped to guest2)
  let fileId = null // uploaded file record id (path)

  before(async function () {
    try {
      auth1 = await createAuthenticatedHelper('primary') // logs in guest1 + APP_A token
      console.log(`    ✓ Logged in as ${auth1.userId} (app ${APP_A})`)
    } catch (error) {
      console.warn(`    ⚠ Login failed (${error.message}) — is the server running in test mode? Skipping.`)
      this.skip()
    }

    // tokens for APP_B and APP_C under guest1
    await mintExtraAppToken(auth1, APP_B)
    console.log(`    ✓ Minted ${APP_B} token for ${auth1.userId}`)
    try {
      await mintExtraAppToken(auth1, APP_C)
      appCTokenOk = true
      console.log(`    ✓ Minted ${APP_C} token for ${auth1.userId}`)
    } catch (e) {
      console.warn(`    ⚠ Could not mint ${APP_C} token (${e.message}) — bystander-app tests will be skipped`)
    }

    // Re-sync APP_A's manifest so its permission rows exist, then grant the three perms used here.
    const accountToken = await auth1.getAccountToken()
    const resync = await fetch(`${serverUrl}/acctapi/updateAppFromFiles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accountToken}`,
        Cookie: auth1.getCookieHeader()
      },
      body: JSON.stringify({ app_name: APP_A })
    })
    if (!resync.ok) console.warn(`    ⚠ updateAppFromFiles returned ${resync.status}; grants may fail`)

    await auth1.changePermission(MSG_PERM, TABLE, APP_A, APP_A, true)
    await auth1.changePermission(SHARE_PERM, TABLE, APP_A, APP_A, true)
    await auth1.changePermission(FILE_SHARE_PERM, FILES_TABLE, APP_A, APP_A, true)
    console.log(`    ✓ Granted ${MSG_PERM}, ${SHARE_PERM}, ${FILE_SHARE_PERM} to ${APP_A}`)

    // guest2 (for cross-user legacy tests)
    try {
      auth2 = await createAuthenticatedHelper('secondary') // guest2 + APP_A token
      await mintExtraAppToken(auth2, APP_B)
      auth2ok = true
      console.log(`    ✓ Logged in as ${auth2.userId} with ${APP_A} + ${APP_B} tokens`)
    } catch (e) {
      console.warn(`    ⚠ Secondary user setup failed (${e.message}) — cross-user tests will be skipped`)
    }
  })

  after(async function () {
    if (auth1) {
      try { if (msgRecordId) await auth1.delete(`/ceps/delete/${TABLE}/${msgRecordId}`, { app: APP_A }) } catch (e) { /* ignore */ }
      try { if (sharedRecordId) await auth1.delete(`/ceps/delete/${TABLE}/${sharedRecordId}`, { app: APP_A }) } catch (e) { /* ignore */ }
      await auth1.logout()
    }
    if (auth2 && auth2ok) await auth2.logout()
  })

  // ==================== 1. MESSAGING with recipient_app ====================

  describe('1. messaging: recipient_app, no contact_permission', function () {
    it('App A sends a message to APP B (same user) with recipient_app and NO contact_permission', async function () {
      const write = await auth1.post(`/ceps/write/${TABLE}`, { title: 'msg-target ' + Date.now() }, { app: APP_A })
      expect(write.ok, JSON.stringify(write.data)).to.be.true
      msgRecordId = write.data._id

      const resp = await auth1.post('/ceps/message/initiate', {
        app_id: APP_A,
        sender_id: auth1.userId,
        sender_host: serverUrl,
        type: 'message_records',
        recipient_id: auth1.userId, // self-send
        recipient_app: APP_B,
        table_id: TABLE,
        record_id: msgRecordId,
        messaging_permission: MSG_PERM,
        // contact_permission deliberately OMITTED
        record: { title: 'msg-target' },
        message: 'hello app B'
      }, { app: APP_A })

      expect(resp.ok, JSON.stringify(resp.data)).to.be.true
      expect(resp.data.recipientsSuccessfullysentTo, JSON.stringify(resp.data)).to.have.length(1)
      console.log('      ✓ message initiated without contact_permission')
    })

    it('App B can query dev.ceps.messages.got by recipient_app and finds the message', async function () {
      const resp = await auth1.post('/ceps/query/dev.ceps.messages.got', { q: { recipient_app: APP_B } }, { app: APP_B })
      expect(resp.ok, JSON.stringify(resp.data)).to.be.true
      expect(resp.data).to.be.an('array')
      const msg = resp.data.find(m => m.record_id === msgRecordId)
      expect(msg, 'message addressed to APP B should be in the results').to.exist
      expect(msg.app_id).to.equal(APP_A) // app_id stays pinned to the SENDER app
      expect(msg.recipient_app).to.equal(APP_B)
      gotMessageId = msg._id
      console.log(`      ✓ App B sees message ${gotMessageId} (app_id=${msg.app_id}, recipient_app=${msg.recipient_app})`)
    })

    it('App A canNOT read the inbox via the recipient_app clause (recipient_app != itself)', async function () {
      const resp = await auth1.post('/ceps/query/dev.ceps.messages.got', { q: { recipient_app: APP_B } }, { app: APP_A })
      expect(resp.ok, 'App A should NOT be able to use recipient_app=' + APP_B).to.be.false
      console.log(`      ✓ App A blocked (${resp.status})`)
    })

    it('App A still reads its own sent copy via app_id', async function () {
      const resp = await auth1.post('/ceps/query/dev.ceps.messages.sent', { q: { app_id: APP_A } }, { app: APP_A })
      expect(resp.ok, JSON.stringify(resp.data)).to.be.true
      expect(resp.data.find(m => m.record_id === msgRecordId), 'sent copy should be visible to App A').to.exist
      console.log('      ✓ App A sees its sent copy')
    })

    it('GET /ceps/messages returns the message for App B', async function () {
      const resp = await auth1.get('/ceps/messages', { app: APP_B })
      expect(resp.ok, JSON.stringify(resp.data)).to.be.true
      expect(resp.data.messages).to.be.an('array')
      expect(resp.data.messages.find(m => m._id === gotMessageId), 'GET /ceps/messages should include the message').to.exist
      console.log(`      ✓ GET /ceps/messages returned ${resp.data.messages.length} message(s)`)
    })

    it('App B can mark_read the message addressed to it', async function () {
      const resp = await auth1.post('/ceps/message/mark_read', { message_ids: [gotMessageId] }, { app: APP_B })
      expect(resp.ok, JSON.stringify(resp.data)).to.be.true
      const requery = await auth1.post('/ceps/query/dev.ceps.messages.got', { q: { recipient_app: APP_B } }, { app: APP_B })
      const msg = requery.data.find(m => m._id === gotMessageId)
      expect(msg.marked_read).to.be.true
      console.log('      ✓ mark_read worked for App B')
    })
  })

  // ==================== 2. RECORD sharing with app grantees ====================

  describe('2. share_records with app grantee', function () {
    it('App A shares a record with grantees: [app:APP_B]', async function () {
      const write = await auth1.post(`/ceps/write/${TABLE}`, { title: 'app-scoped share target' }, { app: APP_A })
      expect(write.ok, JSON.stringify(write.data)).to.be.true
      sharedRecordId = write.data._id

      const resp = await auth1.post('/ceps/perms/share_records', {
        name: SHARE_PERM,
        table_id: TABLE,
        action: 'grant',
        grantees: ['app:' + APP_B],
        record_id: sharedRecordId
      }, { app: APP_A })
      expect(resp.ok, JSON.stringify(resp.data)).to.be.true
      console.log(`      ✓ shared ${sharedRecordId} with app:${APP_B}`)
    })

    it('the _accessibles entry is (grantee=owner, grantee_app=APP_B) — never an app alone', async function () {
      const own = await auth1.get(`/ceps/read/${TABLE}/${sharedRecordId}`, { app: APP_A })
      expect(own.ok, JSON.stringify(own.data)).to.be.true
      const entry = (own.data._accessibles || []).find(a => a.grantee_app === APP_B)
      expect(entry, '_accessibles should carry the app-scoped entry').to.exist
      expect(entry.grantee).to.equal(auth1.userId)
      expect(entry.requestor_app).to.equal(APP_A)
      expect(entry.permission_name).to.equal(SHARE_PERM)
      expect(entry.granted).to.equal(true)
      console.log('      ✓ entry:', JSON.stringify(entry))
    })

    it('App B can READ the record by id (requestee table + permission_name)', async function () {
      const resp = await auth1.get(`/ceps/read/${TABLE}/${sharedRecordId}?permission_name=${SHARE_PERM}`, { app: APP_B })
      expect(resp.ok, JSON.stringify(resp.data)).to.be.true
      expect(resp.data.title).to.equal('app-scoped share target')
      console.log('      ✓ App B read the shared record')
    })

    it('App B can QUERY the record (permission_name in body)', async function () {
      const resp = await auth1.post(`/ceps/query/${TABLE}`, { q: { title: 'app-scoped share target' }, permission_name: SHARE_PERM }, { app: APP_B })
      expect(resp.ok, JSON.stringify(resp.data)).to.be.true
      expect(resp.data.find(r => r._id === sharedRecordId), 'query should return the shared record').to.exist
      console.log(`      ✓ App B query returned the shared record`)
    })

    it('a THIRD app (APP_C) canNOT read it', async function () {
      if (!appCTokenOk) this.skip()
      const resp = await auth1.get(`/ceps/read/${TABLE}/${sharedRecordId}?permission_name=${SHARE_PERM}`, { app: APP_C })
      expect(resp.ok, 'APP_C must not read the app-scoped share: ' + JSON.stringify(resp.data)).to.be.false
      console.log(`      ✓ APP_C blocked (${resp.status})`)
    })

    it('the SAME app B under a DIFFERENT user canNOT read it', async function () {
      if (!auth2ok) this.skip()
      const resp = await auth2.get(`/ceps/read/${TABLE}/${sharedRecordId}?owner_id=${auth1.userId}&permission_name=${SHARE_PERM}`, { app: APP_B })
      expect(resp.ok, `${auth2.userId}'s APP_B must not read guest1's app-scoped share: ` + JSON.stringify(resp.data)).to.be.false
      console.log(`      ✓ ${auth2.userId}/${APP_B} blocked (${resp.status})`)
    })
  })

  // ==================== 4. LEGACY user-scoped grants unchanged ====================

  describe('4. legacy user-scoped grant (no grantee_app) behaves as before', function () {
    it('App A also shares the record user-scoped with guest2', async function () {
      if (!auth2ok) this.skip()
      const resp = await auth1.post('/ceps/perms/share_records', {
        name: SHARE_PERM,
        table_id: TABLE,
        action: 'grant',
        grantees: [auth2.userId],
        record_id: sharedRecordId
      }, { app: APP_A })
      expect(resp.ok, JSON.stringify(resp.data)).to.be.true

      // entry must have NO grantee_app
      const own = await auth1.get(`/ceps/read/${TABLE}/${sharedRecordId}`, { app: APP_A })
      const entry = (own.data._accessibles || []).find(a => a.grantee === auth2.userId)
      expect(entry, 'user-scoped entry should exist').to.exist
      expect(entry.grantee_app, 'user-scoped entry must not carry grantee_app').to.be.undefined
      console.log('      ✓ legacy entry:', JSON.stringify(entry))
    })

    it('guest2 reads it with the SAME app (legacy: consuming app = granting app)', async function () {
      if (!auth2ok) this.skip()
      const resp = await auth2.get(`/ceps/read/${TABLE}/${sharedRecordId}?owner_id=${auth1.userId}&permission_name=${SHARE_PERM}`, { app: APP_A })
      expect(resp.ok, JSON.stringify(resp.data)).to.be.true
      expect(resp.data.title).to.equal('app-scoped share target')
      console.log('      ✓ guest2/APP_A read the record (legacy path intact)')
    })

    it('guest2 canNOT read it with a DIFFERENT app (legacy pin enforced per-entry)', async function () {
      if (!auth2ok) this.skip()
      const resp = await auth2.get(`/ceps/read/${TABLE}/${sharedRecordId}?owner_id=${auth1.userId}&permission_name=${SHARE_PERM}`, { app: APP_B })
      expect(resp.ok, 'guest2/APP_B must not consume a user-scoped grant made via APP_A: ' + JSON.stringify(resp.data)).to.be.false
      console.log(`      ✓ guest2/${APP_B} blocked (${resp.status})`)
    })
  })

  // ==================== 5. DENY matches the full tuple ====================

  describe('5. deny removes only the matching tuple', function () {
    it("deny grantees: [app:APP_B] removes ONLY the app-scoped entry", async function () {
      const resp = await auth1.post('/ceps/perms/share_records', {
        name: SHARE_PERM,
        table_id: TABLE,
        action: 'deny',
        grantees: ['app:' + APP_B],
        record_id: sharedRecordId
      }, { app: APP_A })
      expect(resp.ok, JSON.stringify(resp.data)).to.be.true

      const own = await auth1.get(`/ceps/read/${TABLE}/${sharedRecordId}`, { app: APP_A })
      const accessibles = own.data._accessibles || []
      expect(accessibles.find(a => a.grantee_app === APP_B), 'app-scoped entry should be gone').to.not.exist
      if (auth2ok) {
        expect(accessibles.find(a => a.grantee === auth2.userId && !a.grantee_app), 'user-scoped entry must survive').to.exist
      }
      console.log('      ✓ remaining _accessibles:', JSON.stringify(accessibles))
    })

    it('App B can no longer read; guest2 (user-scoped) still can', async function () {
      const b = await auth1.get(`/ceps/read/${TABLE}/${sharedRecordId}?permission_name=${SHARE_PERM}`, { app: APP_B })
      expect(b.ok, 'App B should be blocked after deny: ' + JSON.stringify(b.data)).to.be.false
      if (auth2ok) {
        const g2 = await auth2.get(`/ceps/read/${TABLE}/${sharedRecordId}?owner_id=${auth1.userId}&permission_name=${SHARE_PERM}`, { app: APP_A })
        expect(g2.ok, 'guest2 user-scoped grant must be untouched: ' + JSON.stringify(g2.data)).to.be.true
      }
      console.log('      ✓ app-scoped revoked independently of user-scoped')
    })
  })

  // ==================== 3. FILE sharing app-scoped ====================

  describe('3. app-scoped FILE sharing (file token)', function () {
    it('App A uploads a file and shares it with app:APP_B', async function () {
      const form = new FormData()
      form.append('file', new Blob(['hello app-scoped file'], { type: 'text/plain' }), 'appshared_test.txt')
      form.append('options', JSON.stringify({ fileName: 'appshared_test.txt', targetFolder: 'testshare', overwrite: true }))
      const upResp = await fetch(`${serverUrl}/feps/upload/${APP_A}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${auth1.appTokens[auth1.userId][APP_A]}`,
          Cookie: auth1.getCookieHeader(APP_A)
        },
        body: form
      })
      const upData = await upResp.json().catch(() => ({}))
      expect(upResp.ok, JSON.stringify(upData)).to.be.true
      fileId = upData._id
      expect(fileId, 'upload should return the file record id').to.exist
      console.log(`      ✓ uploaded ${fileId}`)

      const share = await auth1.post('/ceps/perms/share_records', {
        name: FILE_SHARE_PERM,
        table_id: FILES_TABLE,
        action: 'grant',
        grantees: ['app:' + APP_B],
        record_id: fileId
      }, { app: APP_A })
      expect(share.ok, JSON.stringify(share.data)).to.be.true
      console.log(`      ✓ shared file with app:${APP_B}`)
    })

    it('App B gets a file token where it previously got the cross-app 403, and can fetch the file', async function () {
      if (!fileId) this.skip()
      const tokResp = await auth1.get(`/feps/getuserfiletoken/${FILE_SHARE_PERM}/${APP_A}/${auth1.userId}?file=${encodeURIComponent(fileId)}`, { app: APP_B })
      expect(tokResp.ok, 'expected a fileToken, got: ' + JSON.stringify(tokResp.data)).to.be.true
      expect(tokResp.data.fileToken).to.exist

      const fileResp = await fetch(`${serverUrl}/feps/userfiles/${APP_A}/${auth1.userId}/${fileId}?fileToken=${encodeURIComponent(tokResp.data.fileToken)}`)
      const text = await fileResp.text()
      expect(fileResp.ok, text).to.be.true
      expect(text).to.equal('hello app-scoped file')
      console.log('      ✓ App B fetched the shared file via its fileToken')
    })

    it('APP_C canNOT get a file token for it', async function () {
      if (!fileId || !appCTokenOk) this.skip()
      const tokResp = await auth1.get(`/feps/getuserfiletoken/${FILE_SHARE_PERM}/${APP_A}/${auth1.userId}?file=${encodeURIComponent(fileId)}`, { app: APP_C })
      expect(tokResp.ok, 'APP_C must not get a token: ' + JSON.stringify(tokResp.data)).to.be.false
      console.log(`      ✓ APP_C blocked (${tokResp.status})`)
    })
  })
})
