/**
 * Creator data access — integration tests (xplanations/freezr_creator_data_access_plan.md)
 *
 *   - /creatorapi rejects an app name that would move a handler's base folder (traversal, system apps)
 *   - /apps/<app>?freezr_probe=… keeps its query string through the redirect to /index
 *   - the probe URL serves freezr's consent page INSTEAD of the app's own page
 *
 * The probe page's own logic (opener check, caps, filter whitelist, sharing) is unit-tested in
 * test/unit/creator/freezrProbePage.test.mjs; it runs in a browser and is not exercised here.
 *
 * Prerequisites: server in test mode (npm run devtest); primary test user with the creator app and
 * com.salmanff.apitester installed. Run with:  npx mocha test/integration/creator/creatorDataAccess.test.mjs
 */

import { expect } from 'chai'
import { createAuthenticatedHelper, loadTestCredentials } from '../ceps/testAuthHelper.mjs'

const CREATOR_APP = 'info.freezr.creator'
const SOURCE_APP = 'com.salmanff.apitester'
let serverUrl
try {
  serverUrl = loadTestCredentials().serverUrl
} catch (error) {
  console.error('Failed to load test credentials:', error.message)
  process.exit(1)
}

describe('Creator data access', function () {
  this.timeout(30000)

  let auth

  before(async function () {
    try {
      auth = await createAuthenticatedHelper('primary')
      await auth.visitAppPage(CREATOR_APP)
    } catch (error) {
      console.warn(`    ⚠ Setup failed (${error.message}) — is the server in test mode with creator installed? Skipping.`)
      this.skip()
    }
  })

  after(async function () {
    if (auth) await auth.logout()
  })

  describe('app-name validation on /creatorapi', function () {
    const traversal = encodeURIComponent('../../fradmin')

    it('still serves a valid app', async function () {
      const r = await auth.get('/creatorapi/read_app_file?app_name=' + SOURCE_APP + '&file_path=manifest.json', { app: CREATOR_APP })
      expect(r.ok, JSON.stringify(r.data)).to.be.true
    })

    it('rejects a traversal app_name on every read', async function () {
      for (const url of [
        '/creatorapi/read_app_file?app_name=' + traversal + '&file_path=manifest.json',
        '/creatorapi/read_folder?app_name=' + traversal,
        '/creatorapi/read_all_files?app_name=' + traversal,
        '/creatorapi/manifest_reference?app_name=' + traversal
      ]) {
        const r = await auth.get(url, { app: CREATOR_APP })
        expect(r.status, url).to.equal(400)
      }
    })

    it('rejects a traversal app name on writes and copies', async function () {
      const write = await auth.post('/creatorapi/write_app_file', { app_name: '../../fradmin', file_path: 'x.txt', content: 'x' }, { app: CREATOR_APP })
      expect(write.status).to.equal(400)
      const copy = await auth.post('/creatorapi/copy_app_files', { target_app: '../x.y.z', sources: [] }, { app: CREATOR_APP })
      expect(copy.status).to.equal(400)
    })

    it('refuses system apps with 403', async function () {
      const r = await auth.get('/creatorapi/read_app_file?app_name=info.freezr.admin&file_path=manifest.json', { app: CREATOR_APP })
      expect(r.status).to.equal(403)
    })
  })

  describe('data probe page', function () {
    it('keeps ?freezr_probe= through the redirect from the bare app URL', async function () {
      const response = await fetch(`${serverUrl}/apps/${SOURCE_APP}?freezr_probe=abc123`, {
        headers: { Cookie: auth.getCookieHeader() },
        redirect: 'manual'
      })
      expect(response.status).to.be.within(300, 399)
      expect(response.headers.get('location')).to.equal(`/apps/${SOURCE_APP}/index?freezr_probe=abc123`)
    })

    it('serves freezr\'s probe page instead of the app\'s own page', async function () {
      const manifest = JSON.parse((await auth.get('/creatorapi/read_app_file?app_name=' + SOURCE_APP + '&file_path=manifest.json', { app: CREATOR_APP })).data.content)
      const indexPage = (manifest.pages && manifest.pages.index) || {}
      const appOwnFiles = [].concat(indexPage.modules || [], indexPage.script_files || [], indexPage.css_files || [])

      const response = await fetch(`${serverUrl}/apps/${SOURCE_APP}/index?freezr_probe=abc123`, {
        headers: { Cookie: auth.getCookieHeader() }
      })
      expect(response.status).to.equal(200)
      const html = await response.text()
      expect(html).to.include('/app/info.freezr.public/public/freezrProbe.js')
      expect(html).to.include('id="freezr-probe"')
      for (const f of appOwnFiles) expect(html, 'app file ' + f).to.not.include('/' + f + '"')
    })

    it('serves the probe script itself', async function () {
      const response = await fetch(`${serverUrl}/app/info.freezr.public/public/freezrProbe.js`)
      expect(response.status).to.equal(200)
      expect(await response.text()).to.include('freezr-probe-result')
    })
  })
})
