/**
 * Job-runtime sender identity — integration tests
 *
 * Covers the 2026-09 messageActions change that lets BACKGROUND JOBS send messages: the job
 * client's minimal freezrMeta has no userId/serverAddress, so its messages arrive with NO
 * sender_id and an empty sender_host. The server now:
 *   1. defaults a missing sender_id from the token (a supplied one must still match — 401)
 *   2. treats sender_host as optional for same-server sends (empty string normalized to absent)
 *   3. REFUSES cross-server sends without sender_host (the recipient server authenticates via a
 *      callback to <sender_host>/ceps/message/verify, so they cannot work) — clear 400
 *
 * The test posts to /ceps/message/initiate directly (no SDK), emulating exactly what the job
 * runtime's stamped-from-empty-freezrMeta requests look like.
 *
 * Prerequisites: same as appScopedSharing.test.mjs — server in test mode (npm run devtest),
 * guest1 with com.salmanff.apitester + com.salmanff.apitestgrantee installed, and a server
 * restarted AFTER the sender-identity change landed.
 *   Run with:  npx mocha test/integration/ceps/jobSenderIdentity.test.mjs
 */

import { expect } from 'chai'
import { createAuthenticatedHelper, loadTestCredentials } from './testAuthHelper.mjs'

const APP_A = 'com.salmanff.apitester'
const APP_B = 'com.salmanff.apitestgrantee'
const TABLE = 'com.salmanff.apitester.table1'
const MSG_PERM = 'message_link'

try {
  loadTestCredentials()
} catch (error) {
  console.error('Failed to load test credentials:', error.message)
  process.exit(1)
}

describe('Job-runtime sender identity (sender_id from token; sender_host optional same-server)', function () {
  this.timeout(30000)

  let auth
  let recordId = null

  // Reading APP_B's inbox needs a token for APP_B registered on the helper — the helper only holds
  // the app it logged in with. Same pattern as appScopedSharing.test.mjs.
  async function mintExtraAppToken (helper, appName) {
    const pw = await helper.generateAppPassword(appName, 90)
    const tok = await helper.exchangeAppPasswordForToken(pw.app_password, appName)
    helper.setAppToken(helper.userId, appName, tok.access_token)
    return tok.access_token
  }

  before(async function () {
    try {
      auth = await createAuthenticatedHelper('primary')
      await mintExtraAppToken(auth, APP_B)
    } catch (error) {
      console.warn(`    ⚠ Setup failed (${error.message}) — is the server running in test mode? Skipping.`)
      this.skip()
    }
  })

  after(async function () {
    if (!auth) return
    try { if (recordId) await auth.delete(`/ceps/delete/${TABLE}/${recordId}`, { app: APP_A }) } catch (e) { /* ignore */ }
    await auth.logout()
  })

  it('same-user send with NO sender_id and EMPTY sender_host succeeds (the job-runtime shape)', async function () {
    const write = await auth.post(`/ceps/write/${TABLE}`, { title: 'job-identity-target ' + Date.now() }, { app: APP_A })
    expect(write.ok, JSON.stringify(write.data)).to.be.true
    recordId = write.data._id

    const resp = await auth.post('/ceps/message/initiate', {
      // NO app_id (defaults from token), NO sender_id (defaults from token),
      // sender_host: '' — exactly what the job SDK stamps from freezrMeta.serverAddress
      sender_host: '',
      type: 'message_records',
      recipient_id: auth.userId,
      recipient_app: APP_B,
      table_id: TABLE,
      record_id: recordId,
      messaging_permission: MSG_PERM,
      record: { title: 'job-identity-target' },
      message: 'sent as a background job would send it'
    }, { app: APP_A })

    expect(resp.ok, JSON.stringify(resp.data)).to.be.true
    expect(resp.data.recipientsSuccessfullysentTo, JSON.stringify(resp.data)).to.have.length(1)
    console.log('      ✓ initiate accepted without sender_id / with empty sender_host')
  })

  it('the delivered message carries the token-derived sender_id', async function () {
    const resp = await auth.post('/ceps/query/dev.ceps.messages.got', { q: { recipient_app: APP_B } }, { app: APP_B })
    expect(resp.ok, JSON.stringify(resp.data)).to.be.true
    const msg = resp.data.find(m => m.record_id === recordId)
    expect(msg, 'message should be in APP_B inbox').to.exist
    expect(msg.sender_id).to.equal(auth.userId) // derived from the token, not the (absent) client claim
    expect(msg.app_id).to.equal(APP_A)
    console.log('      ✓ sender_id=' + msg.sender_id + ' stamped from the token')
  })

  it('a SUPPLIED sender_id that does not match the token is still rejected (401)', async function () {
    const resp = await auth.post('/ceps/message/initiate', {
      sender_id: 'someoneelse',
      type: 'message_records',
      recipient_id: auth.userId,
      recipient_app: APP_B,
      table_id: TABLE,
      record_id: recordId,
      messaging_permission: MSG_PERM,
      record: { title: 'spoof attempt' }
    }, { app: APP_A })
    expect(resp.ok).to.be.false
    expect(resp.status).to.equal(401)
    console.log('      ✓ spoofed sender_id rejected (' + resp.status + ')')
  })

  it('a CROSS-SERVER recipient without sender_host is refused with a clear 400', async function () {
    const resp = await auth.post('/ceps/message/initiate', {
      // no sender_host — and a recipient on another server
      type: 'message_records',
      recipients: [{ recipient_id: 'guest2', recipient_host: 'https://example.com' }],
      table_id: TABLE,
      record_id: recordId,
      messaging_permission: MSG_PERM,
      record: { title: 'cross-server attempt' }
    }, { app: APP_A })
    expect(resp.ok).to.be.false
    expect(resp.status).to.equal(400)
    expect(JSON.stringify(resp.data)).to.include('sender_host is required for cross-server')
    console.log('      ✓ cross-server send without sender_host refused loudly')
  })
})
