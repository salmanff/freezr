/**
 * Inspection Token Integration Tests (freezr_creator_selfcheck_plan_v1.md Part A)
 *
 * Tests:
 *   POST /creatorapi/create_inspection_token  - Mint files (+ optional read-only data) tokens
 *   GET  /creator/inspect/:app_name/*         - Serve app source files to inspect-token holders
 *   read_only enforcement                     - Data token can read /ceps but not write
 *
 * Prerequisites:
 *   1. Server running with `npm run devtest` (NOT `npm run dev`).
 *      FREEZR_TEST_MODE=true switches OFF the auth rate limiter (middleware/requestLogger.mjs).
 *      Several tests here deliberately send bad/absent credentials, and each such rejection counts
 *      toward the 20-failures-per-minute-per-IP limit; against a normal-mode server those add up
 *      and later requests come back 429, which surfaces as unrelated-looking assertion failures
 *      ("expected false to be true", "expected 429 to equal 401").
 *   2. Test users exist (users_freezr/test_credentials/testUserCreds.json)
 *   3. The primary user has the test app (testAppConfig.appName) installed with a manifest.json
 *   4. Run with: mocha test/integration/creator/inspectToken.test.mjs
 */

import { expect } from 'chai'
import fetch from 'node-fetch' // the auth helper's parseCookies expects node-fetch Headers (.raw())
import { TestAuthHelper, loadTestCredentials } from '../ceps/testAuthHelper.mjs'

let testConfig
let serverUrl
let appName
let appTable

try {
  testConfig = loadTestCredentials()
  serverUrl = testConfig.serverUrl
  appName = testConfig.testAppConfig.appName
  appTable = testConfig.testAppConfig.appTable
} catch (error) {
  console.error('Failed to load test credentials:', error.message)
  process.exit(1)
}

const CREATOR_APP = 'info.freezr.creator'

describe('Inspection Token Integration Tests', function () {
  this.timeout(10000)

  let auth
  let creatorToken
  let filesToken
  let dataToken
  let writeToken
  const createdIds = []

  before(async function () {
    auth = new TestAuthHelper(serverUrl)
    await auth.login(testConfig.users.primary.user_id, testConfig.users.primary.password)

    // Visit /creator to have the page-token guard mint a creator app token (cookie), which the
    // creator client then uses as the Bearer token for /creatorapi calls.
    auth.appName = CREATOR_APP
    const pageResp = await fetch(`${serverUrl}/creator`, {
      method: 'GET',
      headers: { Cookie: auth.getCookieHeader() },
      redirect: 'manual'
    })
    auth.parseCookies(pageResp.headers, CREATOR_APP)
    creatorToken = auth.appTokens[auth.userId]?.[CREATOR_APP]
    if (!creatorToken) throw new Error('Could not obtain creator app token from /creator page visit')
  })

  describe('Minting', function () {
    it('mints files + read-only data tokens for an installed app', async function () {
      const response = await fetch(`${serverUrl}/creatorapi/create_inspection_token`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creatorToken}`,
          Cookie: auth.getCookieHeader(CREATOR_APP),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ app_name: appName, include_data: true })
      })
      expect(response.status).to.equal(200)
      const result = await response.json()
      expect(result.filesToken).to.be.a('string').with.length(64)
      expect(result.dataToken).to.be.a('string')
      expect(result.readOnly).to.equal(true)
      expect(new Date(result.expiresAt).getTime()).to.be.greaterThan(Date.now())
      filesToken = result.filesToken
      dataToken = result.dataToken
    })

    it('mints a files-only token when include_files is the only scope', async function () {
      const response = await fetch(`${serverUrl}/creatorapi/create_inspection_token`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creatorToken}`,
          Cookie: auth.getCookieHeader(CREATOR_APP),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ app_name: appName })
      })
      expect(response.status).to.equal(200)
      const result = await response.json()
      expect(result.filesToken).to.be.a('string')
      expect(result.dataToken).to.equal(null)
    })

    it('mints a WRITE-capable data token only when data_access is write', async function () {
      const response = await fetch(`${serverUrl}/creatorapi/create_inspection_token`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creatorToken}`,
          Cookie: auth.getCookieHeader(CREATOR_APP),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ app_name: appName, include_data: true, data_access: 'write' })
      })
      expect(response.status).to.equal(200)
      const result = await response.json()
      // Assign before asserting so a mint-shape failure doesn't cascade into the write tests below.
      writeToken = result.dataToken
      expect(result.dataAccess).to.equal('write')
      expect(result.readOnly).to.equal(false)
    })

    it('rejects minting for a system app', async function () {
      const response = await fetch(`${serverUrl}/creatorapi/create_inspection_token`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creatorToken}`,
          Cookie: auth.getCookieHeader(CREATOR_APP),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ app_name: 'info.freezr.account' })
      })
      expect(response.status).to.equal(403)
    })

    it('rejects minting without a session/creator token', async function () {
      // redirect: 'manual' so an unauthenticated request surfaces as its real 302→login
      // (or 401) instead of node-fetch following the redirect to a 200 login page.
      const response = await fetch(`${serverUrl}/creatorapi/create_inspection_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_name: appName }),
        redirect: 'manual'
      })
      expect(response.status).to.be.oneOf([302, 401, 403])
      // Whatever the status, no token may be returned to an unauthenticated caller.
      const text = await response.text().catch(() => '')
      expect(text).to.not.include('filesToken')
    })
  })

  describe('GET /creator/inspect/:app_name/* (files scope)', function () {
    it('serves the app manifest with ?inspectToken= and NO session', async function () {
      const response = await fetch(`${serverUrl}/creator/inspect/${appName}/manifest.json?inspectToken=${filesToken}`)
      expect(response.status).to.equal(200)
      const text = await response.text()
      expect(() => JSON.parse(text)).to.not.throw()
    })

    it('serves files as downloads that a browser will not render or refer onward', async function () {
      const response = await fetch(`${serverUrl}/creator/inspect/${appName}/manifest.json?inspectToken=${filesToken}`)
      expect(response.status).to.equal(200)
      expect(response.headers.get('x-content-type-options')).to.equal('nosniff')
      expect(response.headers.get('content-security-policy')).to.equal('sandbox')
      expect(response.headers.get('referrer-policy')).to.equal('no-referrer')
      expect(response.headers.get('content-disposition')).to.equal('attachment')
    })

    it('serves files with the token as a Cookie', async function () {
      const response = await fetch(`${serverUrl}/creator/inspect/${appName}/manifest.json`, {
        headers: { Cookie: `inspectToken=${filesToken}` }
      })
      expect(response.status).to.equal(200)
    })

    it('rejects a different app with the same token (scope pinning)', async function () {
      const response = await fetch(`${serverUrl}/creator/inspect/com.salmanff.notery/manifest.json?inspectToken=${filesToken}`)
      expect(response.status).to.equal(403)
    })

    it('rejects a bad or missing token', async function () {
      const bad = await fetch(`${serverUrl}/creator/inspect/${appName}/manifest.json?inspectToken=${'0'.repeat(64)}`)
      expect(bad.status).to.equal(401)
      const missing = await fetch(`${serverUrl}/creator/inspect/${appName}/manifest.json`)
      expect(missing.status).to.equal(401)
    })

    it('rejects path traversal', async function () {
      const response = await fetch(`${serverUrl}/creator/inspect/${appName}/%2e%2e%2fmanifest.json?inspectToken=${filesToken}`)
      expect(response.status).to.equal(404)
    })

    it('is not accepted on /ceps routes (never a data credential)', async function () {
      const response = await fetch(`${serverUrl}/ceps/query/${appTable}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${filesToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 1 })
      })
      expect(response.status).to.equal(401)
    })
  })

  describe('Data token (read-only scope)', function () {
    it('can query /ceps headlessly (Bearer only, no session)', async function () {
      const response = await fetch(`${serverUrl}/ceps/query/${appTable}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${dataToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 1 })
      })
      expect(response.status).to.equal(200)
      const result = await response.json()
      expect(result).to.be.an('array')
    })

    it('cannot write to /ceps (403 read-only)', async function () {
      const response = await fetch(`${serverUrl}/ceps/write/${appTable}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${dataToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ shouldNeverBeWritten: true })
      })
      expect(response.status).to.equal(403)
    })

    it('cannot call the LLM route (403 read-only, before llm perms)', async function () {
      const response = await fetch(`${serverUrl}/feps/llm/ask`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${dataToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' })
      })
      expect(response.status).to.equal(403)
    })
  })

  describe('Permission boundary (a token never widens what the app itself may reach)', function () {
    it('CANNOT read another app\'s table without a granted permission', async function () {
      // The inspection data token is a normal app token for `appName`, so cross-app access goes
      // through addRightsToTable's permissions lookup exactly as it would for the app itself.
      const otherAppTable = 'com.salmanff.apitestgrantee.table1'
      const response = await fetch(`${serverUrl}/ceps/query/${otherAppTable}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${dataToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 1 })
      })
      expect(response.status).to.be.oneOf([401, 403])
    })

    it('CANNOT read a system table (account permissions) with the data token', async function () {
      const response = await fetch(`${serverUrl}/ceps/query/info.freezr.account.permissions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${dataToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 1 })
      })
      expect(response.status).to.be.oneOf([401, 403])
    })
  })

  describe('GET /creator/inspect/:app/__permissions (files scope)', function () {
    it('reports declared vs granted permissions, with no records', async function () {
      const response = await fetch(`${serverUrl}/creator/inspect/${appName}/__permissions?inspectToken=${filesToken}`)
      expect(response.status).to.equal(200)
      const result = await response.json()
      expect(result.app_name).to.equal(appName)
      expect(result.declared).to.be.an('array')
      expect(result.granted).to.be.an('array')
      expect(result.not_granted).to.be.an('array')
      // Permission metadata only — never record contents. (Keys are a SUBSET check, not exact:
      // rows for permission types without a table — e.g. schedule_job — carry no table_id, and
      // JSON.stringify drops undefined keys.)
      const allowedKeys = ['name', 'type', 'table_id', 'granted', 'grantees']
      for (const p of result.granted) {
        expect(p).to.not.have.property('_id')
        for (const key of Object.keys(p)) expect(allowedKeys).to.include(key)
      }
    })

    it('requires a valid token and matching app', async function () {
      const noTok = await fetch(`${serverUrl}/creator/inspect/${appName}/__permissions`)
      expect(noTok.status).to.equal(401)
      const wrongApp = await fetch(`${serverUrl}/creator/inspect/com.salmanff.notery/__permissions?inspectToken=${filesToken}`)
      expect(wrongApp.status).to.equal(403)
    })
  })

  describe('Data token (write scope, consent-gated)', function () {
    it('CAN write with a write-scoped token', async function () {
      const response = await fetch(`${serverUrl}/ceps/write/${appTable}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${writeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ writtenByInspectionTokenTest: true, at: Date.now() })
      })
      expect(response.status).to.equal(200)
      const result = await response.json()
      if (result?._id) createdIds.push(result._id)
    })

    it('can also still read', async function () {
      const response = await fetch(`${serverUrl}/ceps/query/${appTable}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${writeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 1 })
      })
      expect(response.status).to.equal(200)
    })
  })

  after(async function () {
    // Clean up records the write-scope test created.
    for (const id of createdIds) {
      try {
        await fetch(`${serverUrl}/ceps/delete/${appTable}/${id}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${auth.appTokens[auth.userId]?.[appName] || writeToken}`,
            Cookie: auth.getCookieHeader(appName)
          }
        })
      } catch (e) { /* best-effort cleanup */ }
    }
  })
})
