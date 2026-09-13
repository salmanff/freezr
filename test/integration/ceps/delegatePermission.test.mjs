/**
 * Cross-user Delegate Permission Integration Tests (freezr_askapps_plan_v1.md)
 *
 * Scenario: Alice (guest2) owns data in apitester and has granted Bob (guest1) read access.
 * Bob wants ANOTHER of his apps (apitestgrantee, the ask-app stand-in) to reuse that access.
 * The `delegate` permission lets Bob authorize apitestgrantee to act via apitester's grant —
 * without Alice re-consenting, and never exceeding what Bob already has (the underlying grant is
 * re-verified on every read).
 *
 * Prerequisites (see README.md): server in test mode; guest1 + guest2 both exist with
 * com.salmanff.apitester installed; guest1 has com.salmanff.apitestgrantee; and the fixture
 * manifests declare (guest2/apitester) a read_all `del_shared` on table1, and
 * (guest1/apitestgrantee) a `delegate` `del_use_apitester` -> { apitester, del_shared }.
 * Run with:  npx mocha test/integration/ceps/delegatePermission.test.mjs
 */

import { expect } from 'chai'
import { createAuthenticatedHelper, loadTestCredentials } from './testAuthHelper.mjs'

const OWNER_APP = 'com.salmanff.apitester'          // Alice owns data here; grants Bob read_all
const DELEGATE_APP = 'com.salmanff.apitestgrantee'  // Bob's app that delegates to apitester
const TABLE = 'com.salmanff.apitester.table1'
const SHARED_PERM = 'del_shared'                    // apitester read_all perm Alice grants Bob
const DELEGATE_PERM = 'del_use_apitester'           // apitestgrantee's delegate perm

let serverUrl
try { serverUrl = loadTestCredentials().serverUrl } catch (e) { console.error(e.message); process.exit(1) }

// Cross-user read: POST /ceps/query with owner_id + q in the body (the working path — matches
// vcTracker's postquery). A GET with owner_id in the URL does NOT return the owner's records.
const crossQuery = (auth, ownerId, perm, app) =>
  auth.post(`/ceps/query/${TABLE}`, { q: {}, owner_id: ownerId, permission_name: perm }, { app })

describe('Cross-user delegate permission', function () {
  this.timeout(60000)
  let alice, bob, recordId

  const resync = async (auth, app) => {
    const t = await auth.getAccountToken()
    const r = await fetch(`${serverUrl}/acctapi/updateAppFromFiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, Cookie: auth.getCookieHeader() },
      body: JSON.stringify({ app_name: app })
    })
    return r.ok
  }

  before(async function () {
    try {
      bob = await createAuthenticatedHelper('primary')      // guest1 (Bob)
      alice = await createAuthenticatedHelper('secondary')  // guest2 (Alice)
    } catch (e) {
      console.warn(`    ⚠ login failed (${e.message}); skipping delegate tests`)
      this.skip()
    }
    if (!alice || !alice.userId || !bob || !bob.userId) this.skip()

    try {
      // Alice: sync apitester, accept the read_all, share it with Bob (adds Bob to grantees), write data.
      await resync(alice, OWNER_APP)
      await alice.changePermission(SHARED_PERM, TABLE, OWNER_APP, OWNER_APP, true)
      await alice.visitAppPage(OWNER_APP)
      await alice.post('/ceps/perms/share_records', { name: SHARED_PERM, table_id: TABLE, grantees: [bob.userId], grant: true }, { app: OWNER_APP })
      const wr = await alice.post(`/ceps/write/${TABLE}`, { marker: 'ALICE_DELEGATE_DATA', secret: 42 }, { app: OWNER_APP })
      recordId = wr.data && wr.data._id

      // Bob: sync apitestgrantee so the delegate perm exists, and DENY it to reset any grant left
      // over from a previous run (grants persist) — so the negative test starts ungranted.
      await resync(bob, DELEGATE_APP)
      try { await bob.changePermission(DELEGATE_PERM, null, DELEGATE_APP, DELEGATE_APP, false) } catch (e) { /* fine if already denied */ }
    } catch (e) {
      console.warn(`    ⚠ cross-user setup failed (${e.message}); skipping delegate tests`)
      this.skip()
    }
  })

  after(async function () {
    try { if (alice && recordId) { await alice.visitAppPage(OWNER_APP); await alice.delete(`/ceps/delete/${TABLE}/${recordId}`, { app: OWNER_APP }) } } catch (e) { /* ignore */ }
    try { if (alice) await alice.logout() } catch (e) { /* */ }
    try { if (bob) await bob.logout() } catch (e) { /* */ }
  })

  it('baseline: Bob\'s apitester (the granted app) CAN read Alice\'s data', async function () {
    if (!bob) this.skip()
    await bob.visitAppPage(OWNER_APP)
    const r = await crossQuery(bob, alice.userId, SHARED_PERM, OWNER_APP)
    expect(r.status, JSON.stringify(r.data)).to.equal(200)
    expect(r.data).to.be.an('array')
    const rec = r.data.find(x => x.marker === 'ALICE_DELEGATE_DATA')
    expect(rec, 'apitester should see Alice\'s shared record').to.exist
    console.log('      ✓ baseline cross-user read_all works')
  })

  it('WITHOUT the delegate granted, Bob\'s apitestgrantee CANNOT read Alice\'s data', async function () {
    if (!bob) this.skip()
    await bob.visitAppPage(DELEGATE_APP)
    const r = await crossQuery(bob, alice.userId, SHARED_PERM, DELEGATE_APP)
    // No delegate → apitestgrantee has no grant of its own → denied.
    expect(r.ok, 'a non-granted app must not read via a non-existent delegate: ' + JSON.stringify(r.data)).to.be.false
    console.log(`      ✓ denied without delegate (status ${r.status})`)
  })

  it('after Bob grants the delegate, apitestgrantee CAN read Alice\'s data (via apitester\'s grant)', async function () {
    if (!bob) this.skip()
    await bob.changePermission(DELEGATE_PERM, null, DELEGATE_APP, DELEGATE_APP, true)

    await bob.visitAppPage(DELEGATE_APP)
    const r = await crossQuery(bob, alice.userId, SHARED_PERM, DELEGATE_APP)
    expect(r.status, JSON.stringify(r.data)).to.equal(200)
    expect(r.data).to.be.an('array')
    const rec = r.data.find(x => x.marker === 'ALICE_DELEGATE_DATA')
    expect(rec, 'apitestgrantee should now see Alice\'s data via the delegate').to.exist
    expect(rec.secret).to.equal(42)
    console.log('      ✓ delegate grants apitestgrantee exactly apitester\'s access')
  })
})
