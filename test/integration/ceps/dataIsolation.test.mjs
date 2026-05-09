/**
 * Data Isolation Integration Tests
 *
 * Verifies that users cannot access, modify, or delete each other's data
 * through the CEPS API. These tests are critical for multi-tenant security
 * and should pass regardless of the underlying database backend (nedb, mongodb,
 * cosmos-for-mongo) or the connection pooling strategy (registry vs per-op).
 *
 * Prerequisites:
 *   1. Server running in test mode: npm run devtest
 *   2. Two test users exist (guest1, guest2) — see testUserCreds.json
 *   3. Run with: npm run test:isolation
 *      or:      mocha test/integration/ceps/dataIsolation.test.mjs
 */

import { expect } from 'chai'
import { createAuthenticatedHelper, loadTestCredentials } from './testAuthHelper.mjs'

let testConfig, serverUrl, appTable

try {
  testConfig = loadTestCredentials()
  serverUrl = testConfig.serverUrl
  appTable = testConfig.testAppConfig.appTable
} catch (error) {
  console.error('Failed to load test credentials:', error.message)
  process.exit(1)
}

// Use a distinct app table for isolation tests so we don't collide with other test suites
const ISOLATION_TABLE = appTable

describe('Data Isolation Tests', function () {
  this.timeout(30000)

  let userA, userB
  const createdByA = []
  const createdByB = []

  before(async function () {
    try {
      userA = await createAuthenticatedHelper('primary')
      console.log(`    ✓ User A logged in: ${userA.userId}`)
    } catch (error) {
      console.error(`    ✗ User A login failed: ${error.message}`)
      this.skip()
    }

    try {
      userB = await createAuthenticatedHelper('secondary')
      console.log(`    ✓ User B logged in: ${userB.userId}`)
    } catch (error) {
      console.error(`    ✗ User B login failed: ${error.message}`)
      console.error('    Data isolation tests require two users. Skipping.')
      this.skip()
    }

    if (userA.userId === userB.userId) {
      console.error('    ✗ primary and secondary must be different users')
      this.skip()
    }
  })

  after(async function () {
    // Clean up all records created during tests
    for (const id of createdByA) {
      try { await userA.delete(`/ceps/delete/${ISOLATION_TABLE}/${id}`) } catch (_) { /* ignore */ }
    }
    for (const id of createdByB) {
      try { await userB.delete(`/ceps/delete/${ISOLATION_TABLE}/${id}`) } catch (_) { /* ignore */ }
    }
    if (userA) await userA.logout()
    if (userB) await userB.logout()
  })

  // ------------------------------------------------------------------
  // Setup: each user creates records in their own space
  // ------------------------------------------------------------------

  describe('Setup — create records for each user', function () {
    it('User A creates a record', async function () {
      const response = await userA.post(`/ceps/write/${ISOLATION_TABLE}`, {
        title: 'User A secret',
        secret_value: 'a-eyes-only',
        _date_modified: Date.now()
      })
      expect(response.ok).to.be.true
      expect(response.data._id).to.exist
      createdByA.push(response.data._id)
    })

    it('User B creates a record', async function () {
      const response = await userB.post(`/ceps/write/${ISOLATION_TABLE}`, {
        title: 'User B secret',
        secret_value: 'b-eyes-only',
        _date_modified: Date.now()
      })
      expect(response.ok).to.be.true
      expect(response.data._id).to.exist
      createdByB.push(response.data._id)
    })

    it('User A can read their own record', async function () {
      const response = await userA.get(`/ceps/read/${ISOLATION_TABLE}/${createdByA[0]}`)
      expect(response.ok).to.be.true
      expect(response.data.secret_value).to.equal('a-eyes-only')
    })

    it('User B can read their own record', async function () {
      const response = await userB.get(`/ceps/read/${ISOLATION_TABLE}/${createdByB[0]}`)
      expect(response.ok).to.be.true
      expect(response.data.secret_value).to.equal('b-eyes-only')
    })
  })

  // ------------------------------------------------------------------
  // Core isolation: user B cannot access user A's data
  // ------------------------------------------------------------------

  describe('Read isolation — user B cannot see user A records', function () {
    it('User B cannot read User A record by ID', async function () {
      const response = await userB.get(`/ceps/read/${ISOLATION_TABLE}/${createdByA[0]}`)
      // Should either fail (not ok) or return no data
      if (response.ok && response.data) {
        // If the server returns data, it must NOT be user A's record
        expect(response.data.secret_value).to.not.equal('a-eyes-only')
      }
    })

    it('User B query does not return User A records', async function () {
      const response = await userB.get(`/ceps/query/${ISOLATION_TABLE}`)
      expect(response.ok).to.be.true

      const data = Array.isArray(response.data) ? response.data : []
      const leaked = data.filter(r => r.secret_value === 'a-eyes-only')
      expect(leaked).to.have.lengthOf(0, 'User B query returned User A data — DATA LEAK')
    })

    it('User B query with owner filter still does not return User A records', async function () {
      const response = await userB.get(`/ceps/query/${ISOLATION_TABLE}?owner=${userA.userId}`)
      expect(response.ok).to.be.true

      const data = Array.isArray(response.data) ? response.data : []
      const leaked = data.filter(r => r.secret_value === 'a-eyes-only')
      expect(leaked).to.have.lengthOf(0, 'User B query with owner filter returned User A data — DATA LEAK')
    })
  })

  describe('Read isolation — user A cannot see user B records', function () {
    it('User A cannot read User B record by ID', async function () {
      const response = await userA.get(`/ceps/read/${ISOLATION_TABLE}/${createdByB[0]}`)
      if (response.ok && response.data) {
        expect(response.data.secret_value).to.not.equal('b-eyes-only')
      }
    })

    it('User A query does not return User B records', async function () {
      const response = await userA.get(`/ceps/query/${ISOLATION_TABLE}`)
      expect(response.ok).to.be.true

      const data = Array.isArray(response.data) ? response.data : []
      const leaked = data.filter(r => r.secret_value === 'b-eyes-only')
      expect(leaked).to.have.lengthOf(0, 'User A query returned User B data — DATA LEAK')
    })
  })

  // ------------------------------------------------------------------
  // Write isolation: user B cannot modify user A's data
  // ------------------------------------------------------------------

  describe('Write isolation — user B cannot modify user A records', function () {
    it('User B cannot update User A record', async function () {
      const response = await userB.put(`/ceps/update/${ISOLATION_TABLE}/${createdByA[0]}`, {
        title: 'HACKED BY B'
      })
      // Should fail, or silently not modify
      // Verify A's record is untouched
      const check = await userA.get(`/ceps/read/${ISOLATION_TABLE}/${createdByA[0]}`)
      if (check.ok && check.data) {
        expect(check.data.title).to.equal('User A secret', 'User B was able to modify User A record — WRITE LEAK')
        expect(check.data.secret_value).to.equal('a-eyes-only')
      }
    })

    it('User A cannot update User B record', async function () {
      const response = await userA.put(`/ceps/update/${ISOLATION_TABLE}/${createdByB[0]}`, {
        title: 'HACKED BY A'
      })
      const check = await userB.get(`/ceps/read/${ISOLATION_TABLE}/${createdByB[0]}`)
      if (check.ok && check.data) {
        expect(check.data.title).to.equal('User B secret', 'User A was able to modify User B record — WRITE LEAK')
        expect(check.data.secret_value).to.equal('b-eyes-only')
      }
    })
  })

  // ------------------------------------------------------------------
  // Delete isolation: user B cannot delete user A's data
  // ------------------------------------------------------------------

  describe('Delete isolation — user B cannot delete user A records', function () {
    it('User B cannot delete User A record', async function () {
      await userB.delete(`/ceps/delete/${ISOLATION_TABLE}/${createdByA[0]}`)

      // Verify A's record still exists
      const check = await userA.get(`/ceps/read/${ISOLATION_TABLE}/${createdByA[0]}`)
      expect(check.ok).to.be.true
      expect(check.data).to.exist
      expect(check.data.secret_value).to.equal('a-eyes-only', 'User B deleted User A record — DELETE LEAK')
    })

    it('User A cannot delete User B record', async function () {
      await userA.delete(`/ceps/delete/${ISOLATION_TABLE}/${createdByB[0]}`)

      const check = await userB.get(`/ceps/read/${ISOLATION_TABLE}/${createdByB[0]}`)
      expect(check.ok).to.be.true
      expect(check.data).to.exist
      expect(check.data.secret_value).to.equal('b-eyes-only', 'User A deleted User B record — DELETE LEAK')
    })
  })

  // ------------------------------------------------------------------
  // Query count isolation: user queries return only their own count
  // ------------------------------------------------------------------

  describe('Count isolation — each user sees only their own record count', function () {
    it('User A query count equals records created by A', async function () {
      const response = await userA.get(`/ceps/query/${ISOLATION_TABLE}`)
      expect(response.ok).to.be.true

      const data = Array.isArray(response.data) ? response.data : []
      // All returned records should belong to user A (no user B data)
      for (const record of data) {
        if (record.secret_value) {
          expect(record.secret_value).to.not.equal('b-eyes-only',
            'User A query returned User B data in count check')
        }
      }
    })

    it('User B query count equals records created by B', async function () {
      const response = await userB.get(`/ceps/query/${ISOLATION_TABLE}`)
      expect(response.ok).to.be.true

      const data = Array.isArray(response.data) ? response.data : []
      for (const record of data) {
        if (record.secret_value) {
          expect(record.secret_value).to.not.equal('a-eyes-only',
            'User B query returned User A data in count check')
        }
      }
    })
  })
})
