/**
 * Cross-App write_own + read-own Integration Tests
 *
 * Validates the permission mechanic the ask-apps feature depends on (freezr_askapps_plan_v1.md §5c):
 * an app granted `write_own` on ANOTHER app's table can create records it owns, read those
 * records back (scoped to its own `_created_by_*`), but cannot see records other apps created
 * in the same table.
 *
 *   App A  = com.salmanff.apitestgrantee   (ask-app stand-in; granted write_own on the table below)
 *   App B  = com.salmanff.apitester        (owns the table)
 *   TABLE  = com.salmanff.apitester.table1
 *
 * Prerequisites (same shape as the other ceps tests — see README.md):
 *   1. Server running in test mode:  npm run devtest
 *   2. Test user `guest1` exists with apps `com.salmanff.apitester` and `com.salmanff.apitestgrantee` installed
 *   3. apitestgrantee's manifest declares a write_own permission named `chat_write_test` on the table:
 *        { "name": "chat_write_test", "type": "write_own", "table_id": "com.salmanff.apitester.table1" }
 *      (before() re-syncs it from files and grants it, so no manual grant is needed.)
 *
 *   Run with:  npx mocha test/integration/ceps/crossAppWriteOwn.test.mjs
 */

import { expect } from 'chai'
import { createAuthenticatedHelper, loadTestCredentials } from './testAuthHelper.mjs'

const GRANTEE_APP = 'com.salmanff.apitestgrantee'  // App A
const OWNER_APP = 'com.salmanff.apitester'         // App B
const TABLE = 'com.salmanff.apitester.table1'
const PERM_NAME = 'chat_write_test'

let serverUrl
try {
  serverUrl = loadTestCredentials().serverUrl
} catch (error) {
  console.error('Failed to load test credentials:', error.message)
  process.exit(1)
}

describe('Cross-App write_own + read-own', function () {
  this.timeout(30000)

  let auth
  let granteeRecordId // record App A creates (its own)
  let ownerRecordId   // record App B creates (foreign to App A)

  before(async function () {
    try {
      auth = await createAuthenticatedHelper('primary')
      console.log(`    ✓ Logged in as ${auth.userId}`)
    } catch (error) {
      console.warn(`    ⚠ Login failed (${error.message}) — is the server running in test mode? Skipping.`)
      this.skip()
    }

    // Re-sync App A's manifest from files so the write_own perm record exists, then grant it.
    try {
      const accountToken = await auth.getAccountToken()
      const resync = await fetch(`${serverUrl}/acctapi/updateAppFromFiles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accountToken}`,
          Cookie: auth.getCookieHeader()
        },
        body: JSON.stringify({ app_name: GRANTEE_APP })
      })
      if (!resync.ok) {
        console.warn(`    ⚠ updateAppFromFiles returned ${resync.status}; grant may fail if perm record is missing.`)
      }

      await auth.changePermission(PERM_NAME, TABLE, GRANTEE_APP, GRANTEE_APP, true)
      console.log(`    ✓ Granted ${PERM_NAME} (write_own) to ${GRANTEE_APP} on ${TABLE}`)
    } catch (error) {
      console.warn(`    ⚠ Could not set up the write_own grant (${error.message}).`)
      console.warn(`      Ensure ${GRANTEE_APP}'s manifest declares a write_own perm "${PERM_NAME}" on ${TABLE}. Skipping.`)
      this.skip()
    }
  })

  after(async function () {
    if (!auth) return
    try { await auth.visitAppPage(GRANTEE_APP); if (granteeRecordId) await auth.delete(`/ceps/delete/${TABLE}/${granteeRecordId}`) } catch (e) { /* ignore */ }
    try { await auth.visitAppPage(OWNER_APP); if (ownerRecordId) await auth.delete(`/ceps/delete/${TABLE}/${ownerRecordId}`) } catch (e) { /* ignore */ }
    await auth.logout()
  })

  it('App A can WRITE its own record into App B\'s table via write_own', async function () {
    if (!auth) this.skip()
    await auth.visitAppPage(GRANTEE_APP)

    const response = await auth.post(`/ceps/write/${TABLE}`, {
      role: 'user',
      msg: 'hello from grantee',
      marker: 'GRANTEE_OWN'
    })

    expect(response.ok, JSON.stringify(response.data)).to.be.true
    expect(response.data._id).to.exist
    granteeRecordId = response.data._id
    console.log(`      ✓ App A wrote record ${granteeRecordId}`)
  })

  it('App A can READ BACK its own record via query, tagged with its own app id (read-own scoping)', async function () {
    if (!auth || !granteeRecordId) this.skip()
    await auth.visitAppPage(GRANTEE_APP)

    const response = await auth.get(`/ceps/query/${TABLE}`)
    expect(response.status).to.equal(200)
    expect(response.data).to.be.an('array')

    const own = response.data.find(r => r._id === granteeRecordId)
    expect(own, 'App A should see its own record in the query').to.exist
    expect(own._created_by_app).to.equal(GRANTEE_APP)
    expect(own._created_by_user).to.equal(auth.userId)
    // Every returned record must be App A's own — read-own must not surface anything else.
    response.data.forEach(r => expect(r._created_by_app).to.equal(GRANTEE_APP))
    console.log(`      ✓ Query returned ${response.data.length} record(s), all tagged ${GRANTEE_APP}`)
  })

  it('App A can READ its own record by id', async function () {
    if (!auth || !granteeRecordId) this.skip()
    await auth.visitAppPage(GRANTEE_APP)

    const response = await auth.get(`/ceps/read/${TABLE}/${granteeRecordId}`)
    expect(response.ok, JSON.stringify(response.data)).to.be.true
    expect(response.data.marker).to.equal('GRANTEE_OWN')
  })

  it('sets up a foreign record: App B writes its own record to the same table', async function () {
    if (!auth) this.skip()
    await auth.visitAppPage(OWNER_APP)

    const response = await auth.post(`/ceps/write/${TABLE}`, {
      role: 'system',
      msg: 'owned by apitester',
      marker: 'OWNER_APP_REC'
    })
    expect(response.ok, JSON.stringify(response.data)).to.be.true
    ownerRecordId = response.data._id
    console.log(`      ✓ App B wrote foreign record ${ownerRecordId}`)
  })

  it('App A CANNOT read App B\'s record by id (denied)', async function () {
    if (!auth || !ownerRecordId) this.skip()
    await auth.visitAppPage(GRANTEE_APP)

    const response = await auth.get(`/ceps/read/${TABLE}/${ownerRecordId}`)
    expect(response.ok, 'reading a foreign record must be denied').to.be.false
    expect(response.status).to.equal(401)
    console.log(`      ✓ Denied (${response.status}) as expected`)
  })

  it('App A\'s query does NOT leak App B\'s records', async function () {
    if (!auth || !ownerRecordId) this.skip()
    await auth.visitAppPage(GRANTEE_APP)

    const response = await auth.get(`/ceps/query/${TABLE}`)
    expect(response.status).to.equal(200)
    expect(response.data).to.be.an('array')

    const leaked = response.data.some(r => r._id === ownerRecordId || r.marker === 'OWNER_APP_REC')
    expect(leaked, 'App B\'s record must not appear in App A\'s query results').to.be.false
    console.log(`      ✓ No leak — query returned only App A's own ${response.data.length} record(s)`)
  })
})
