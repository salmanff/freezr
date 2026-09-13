/**
 * Ask-App Scaffold Integration Tests (Slice 1 — backend skeleton)
 *
 * Validates that the ask-app builder backend can create a ask-app:
 *   - POST /creatorapi/create_ask_app generates a `ask-app.{slug}.{suffix}` name
 *   - the app-list record is stamped app_type:'askapp'
 *   - the generated page is served at /apps/{name}/index
 *   - GET /creator/ask serves the builder page
 *
 * Prerequisites (see README.md): server in test mode (npm run devtest); user `guest1` exists with
 * the creator app available. Run with:  npx mocha test/integration/ceps/askAppScaffold.test.mjs
 */

import { expect } from 'chai'
import { createAuthenticatedHelper, loadTestCredentials } from './testAuthHelper.mjs'

const CREATOR_APP = 'info.freezr.creator'
let serverUrl
try {
  serverUrl = loadTestCredentials().serverUrl
} catch (error) {
  console.error('Failed to load test credentials:', error.message)
  process.exit(1)
}

describe('Ask-App Scaffold (Slice 1)', function () {
  this.timeout(30000)

  let auth
  let createdAppName
  let grantTestApp

  before(async function () {
    try {
      auth = await createAuthenticatedHelper('primary')
      // Switch the active app token to the creator app (creatorapi requires a creator token).
      await auth.visitAppPage(CREATOR_APP)
      console.log(`    ✓ Logged in as ${auth.userId}, creator token acquired`)
    } catch (error) {
      console.warn(`    ⚠ Setup failed (${error.message}) — is the server in test mode with creator installed? Skipping.`)
      this.skip()
    }
  })

  after(async function () {
    if (!auth) return
    // Best-effort cleanup of the created ask-app.
    try {
      await auth.getAccountToken() // stores the account token under the account app key
      for (const name of [createdAppName, grantTestApp]) {
        if (name) await auth.post('/acctapi/appMgmtActions', { action: 'deleteApp', app_name: name }, { app: 'info.freezr.account' })
      }
    } catch (e) { /* ignore — leftover test apps are harmless */ }
    await auth.logout()
  })

  it('GET /creator/ask serves the builder page', async function () {
    if (!auth) this.skip()
    const response = await fetch(`${serverUrl}/creator/ask`, {
      method: 'GET',
      headers: { Cookie: auth.getCookieHeader() },
      redirect: 'manual'
    })
    expect(response.status).to.equal(200)
    const body = await response.text()
    expect(body).to.include('askForm')
    console.log('      ✓ /creator/ask rendered the ask shell')
  })

  it('POST /creatorapi/create_ask_app generates a ask-app.{slug}.{suffix} name tagged app_type:askapp', async function () {
    if (!auth) this.skip()
    await auth.visitAppPage(CREATOR_APP)

    const response = await auth.post('/creatorapi/create_ask_app', {
      display_name: 'Show my Top Artists!'
    })
    expect(response.ok, JSON.stringify(response.data)).to.be.true
    expect(response.data.app_name).to.be.a('string')
    createdAppName = response.data.app_name

    // ask-app.show-my-top-artists.<4hex>  (slug truncated to fit 35 chars)
    expect(createdAppName).to.match(/^ask-app\.[a-z0-9-]+\.[a-z0-9]{4}$/)
    expect(createdAppName.length).to.be.at.most(35)
    expect(createdAppName.split('.').length).to.be.at.least(3)
    expect(response.data.app_type).to.equal('askapp')
    console.log(`      ✓ Created ${createdAppName}`)
  })

  it('the normal create flow refuses ask-app.* names (reservation)', async function () {
    if (!auth) this.skip()
    await auth.visitAppPage(CREATOR_APP)
    const response = await auth.post('/creatorapi/create_new_app', { app_name: 'ask-app.sneaky.x1y2' })
    expect(response.ok).to.be.false
    expect(response.status).to.equal(400)
    console.log('      ✓ create_new_app rejected a ask-app.* name')
  })

  it('records the ask-app in the app list with app_type:askapp (account getAppList)', async function () {
    if (!auth || !createdAppName) this.skip()
    // Exercises the account-side projection (getStructuredAppListForUser). The helper now stores a
    // distinct token per app, so we can call the account endpoint right after creator-context calls.
    await auth.getAccountToken()
    const response = await auth.get('/acctapi/getAppList', { app: 'info.freezr.account' })
    expect(response.ok, JSON.stringify(response.data)).to.be.true
    const apps = response.data.user_apps || []
    const entry = apps.find(a => a.app_name === createdAppName)
    expect(entry, 'created ask-app should appear in the account app list').to.exist
    expect(entry.app_type).to.equal('askapp')
    console.log('      ✓ getAppList entry carries app_type:askapp')
  })

  it('also surfaces app_type via the creator user_apps listing', async function () {
    if (!auth || !createdAppName) this.skip()
    const response = await auth.get('/creatorapi/user_apps', { app: CREATOR_APP })
    expect(response.ok, JSON.stringify(response.data)).to.be.true
    const entry = (response.data.apps || []).find(a => a.app_name === createdAppName)
    expect(entry, 'created ask-app should appear in the creator user_apps listing').to.exist
    expect(entry.app_type).to.equal('askapp')
  })

  it('installed_apps_context returns trimmed manifest projections (Stage-1 data)', async function () {
    if (!auth) this.skip()
    const response = await auth.get('/creatorapi/installed_apps_context', { app: CREATOR_APP })
    expect(response.ok, JSON.stringify(response.data)).to.be.true
    const apps = response.data.apps
    expect(apps).to.be.an('array').that.is.not.empty

    // Shape: each app carries name/display/description/app_tables/permissions and NO source code.
    for (const app of apps) {
      expect(app).to.have.property('app_name')
      expect(app).to.have.property('display_name')
      expect(app).to.have.property('app_tables')
      expect(app).to.have.property('permissions')
      expect(app).to.not.have.property('manifest') // trimmed — not the full manifest
      // System apps must be excluded (creator/account/etc.)
      expect(app.app_name.startsWith('info.freezr.')).to.be.false
    }
    // The known test app should appear with its declared permissions.
    const apitester = apps.find(a => a.app_name === 'com.salmanff.apitester')
    expect(apitester, 'apitester should be in the context').to.exist
    expect(apitester.permissions.map(p => p.type)).to.include('share_records')
    console.log(`      ✓ installed_apps_context returned ${apps.length} apps (trimmed)`)
  })

  it('creator can read a source app\'s file (copy-in capability)', async function () {
    if (!auth) this.skip()
    const response = await auth.get('/creatorapi/read_app_file?app_name=com.salmanff.apitester&file_path=manifest.json', { app: CREATOR_APP })
    expect(response.ok, JSON.stringify(response.data)).to.be.true
    expect(response.data.content).to.be.a('string')
    expect(response.data.content).to.include('com.salmanff.apitester')
    console.log('      ✓ creator read a source app manifest for copy-in')
  })

  it('creator refuses a path-traversal read', async function () {
    if (!auth) this.skip()
    const response = await auth.get('/creatorapi/read_app_file?app_name=com.salmanff.apitester&file_path=../../../etc/passwd', { app: CREATOR_APP })
    expect(response.ok).to.be.false
    console.log('      ✓ traversal read rejected')
  })

  it('creator can grant a ask-app\'s permission inline (feps/permissions/change with creator token)', async function () {
    if (!auth) this.skip()
    await auth.visitAppPage(CREATOR_APP)

    // Create a ask-app and give its manifest a read_all permission on a source table.
    const created = await auth.post('/creatorapi/create_ask_app', { display_name: 'Perm Grant Test' }, { app: CREATOR_APP })
    expect(created.ok, JSON.stringify(created.data)).to.be.true
    grantTestApp = created.data.app_name

    const manifest = {
      identifier: grantTestApp,
      app_type: 'askapp',
      version: '0.02',
      display_name: 'Perm Grant Test',
      special_instructions: 'Test guidance: decrypt rows before use.',
      pages: { index: { html_file: 'index.html', css_files: [], modules: ['index.js'], page_title: 'Perm Grant Test' } },
      permissions: [{ name: 'read_src', type: 'read_all', table_id: 'com.salmanff.apitester.table1', description: 'read source data' }]
    }
    await auth.post('/creatorapi/write_app_file', { app_name: grantTestApp, file_path: 'manifest.json', content: JSON.stringify(manifest, null, 2), action: 'upsert' }, { app: CREATOR_APP })
    // Sync manifest -> pending permission records (creator route, creator token).
    const synced = await auth.post('/creatorapi/update_app_from_files', { app_name: grantTestApp }, { app: CREATOR_APP })
    expect(synced.ok, JSON.stringify(synced.data)).to.be.true

    // Grant the pending permission using the CREATOR token (the fundamentals change under test).
    const grant = await auth.put('/feps/permissions/change', {
      change: { name: 'read_src', action: 'Accept', table_id: 'com.salmanff.apitester.table1', requestor_app: grantTestApp }
    }, { app: CREATOR_APP })
    expect(grant.ok, 'creator should be allowed to grant: ' + JSON.stringify(grant.data)).to.be.true
    console.log('      ✓ creator granted a ask-app permission inline')

    // special_instructions surfaces in installed_apps_context (the feature that feeds it to the LLM).
    const ctx = await auth.get('/creatorapi/installed_apps_context', { app: CREATOR_APP })
    const entry = (ctx.data.apps || []).find(a => a.app_name === grantTestApp)
    expect(entry, 'app should appear in context').to.exist
    expect(entry.special_instructions).to.equal('Test guidance: decrypt rows before use.')
    console.log('      ✓ special_instructions surfaced in installed_apps_context')
  })

  it('serves the generated ask-app page at /apps/{name}/index', async function () {
    if (!auth || !createdAppName) this.skip()
    // Visiting the app page requires the user session; the page-token guard mints the app token.
    const response = await fetch(`${serverUrl}/apps/${createdAppName}`, {
      method: 'GET',
      headers: { Cookie: auth.getCookieHeader() },
      redirect: 'manual'
    })
    // Either a direct 200, or a redirect to the index page — both mean the app name was accepted
    // and served (a reserved/blocked name would 4xx here).
    expect([200, 301, 302]).to.include(response.status)
    console.log(`      ✓ /apps/${createdAppName} served (status ${response.status})`)
  })
})
