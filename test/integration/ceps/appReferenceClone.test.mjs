/**
 * Creator app-reference support — integration tests
 *
 * Covers the 2026-09 creator inter-app work:
 *  1. installed_apps_context exposes an app's `app_services` ({ description, contract })
 *  2. POST /creatorapi/clone_app_files copies a whole app into another app's ROOT,
 *     rewriting the source app id -> target app id in text files (manifest identifier,
 *     own table_ids, nav URLs, fallback literals), skipping dot-files, and reporting
 *     { copied, replacements, skipped, errors }
 *  3. copy_app_files places a source app's contract/manifest under imported/<app>/
 *     (the "reference" flow used by the chat's app_reference section)
 *
 * Prerequisites (same as the other ceps tests — see README.md):
 *   server in test mode (npm run devtest), user `guest1` with the creator app available.
 *   NOTE: needs a server restarted AFTER the clone_app_files endpoint landed.
 *   Run with:  npx mocha test/integration/ceps/appReferenceClone.test.mjs
 */

import { expect } from 'chai'
import { createAuthenticatedHelper, loadTestCredentials } from './testAuthHelper.mjs'

const CREATOR_APP = 'info.freezr.creator'
const SRC_APP = 'com.test.clonesource01'
const TGT_APP = 'com.test.clonetarget01'

try {
  loadTestCredentials()
} catch (error) {
  console.error('Failed to load test credentials:', error.message)
  process.exit(1)
}

const SRC_HOST = loadTestCredentials().serverUrl

const SRC_MANIFEST = {
  identifier: SRC_APP,
  version: '0.1',
  display_name: 'Clone Source',
  description: 'Source app for clone tests.',
  authorship: {
    main_author: { id: 'guest1', host: SRC_HOST, date: 1756000000000 },
    last_modified: { id: 'guest1', host: SRC_HOST, date: 1756000000000 },
    contributors: [],
    history: [{ event: 'created', by: { id: 'guest1', host: SRC_HOST }, date: 1756000000000 }]
  },
  app_services: {
    description: 'Test service: echoes requests.',
    contract: 'app-comms.md'
  },
  pages: {
    index: { page_title: 'Home', html_file: 'index.html', css_files: ['index.css'], modules: ['index.js'], Description: 'Test page.' }
  },
  app_tables: {
    things: { description: 'Test things', schema: { name: { type: 'String', description: 'A name' } } }
  },
  permissions: [
    { name: 'share_things', type: 'share_records', table_id: SRC_APP + '.things', description: 'Share things' },
    // Points at ANOTHER app — must survive the clone UNCHANGED (only the source app id is rewritten).
    { name: 'read_other', type: 'read_all', table_id: 'com.example.otherapp.records', description: 'Read other app records' }
  ]
}

const SRC_JS = [
  "const BASE = '/apps/" + SRC_APP + "/'", // nav-URL shape
  "const APP = (typeof freezrMeta !== 'undefined' && freezrMeta.appName) || '" + SRC_APP + "'", // fallback-literal shape
  "export const other = 'com.example.otherapp.records'" // other-app table id — must NOT be rewritten
].join('\n')

const SRC_CONTRACT = '# app-comms: ' + SRC_APP + '\n\nTest contract for ' + SRC_APP + '.\n'

describe('Creator app-reference: app_services projection + clone_app_files + copy_app_files', function () {
  this.timeout(30000)

  let auth

  before(async function () {
    try {
      auth = await createAuthenticatedHelper('primary')
      await auth.visitAppPage(CREATOR_APP) // creatorapi requires a creator token
      console.log(`    ✓ Logged in as ${auth.userId}, creator token acquired`)
    } catch (error) {
      console.warn(`    ⚠ Setup failed (${error.message}) — is the server in test mode with creator installed? Skipping.`)
      this.skip()
    }
  })

  after(async function () {
    if (!auth) return
    try {
      await auth.getAccountToken()
      for (const name of [SRC_APP, TGT_APP]) {
        await auth.post('/acctapi/appMgmtActions', { action: 'deleteApp', app_name: name }, { app: 'info.freezr.account' })
      }
    } catch (e) { /* leftover test apps are harmless */ }
    await auth.logout()
  })

  it('creates and installs the source app (manifest with app_services)', async function () {
    const created = await auth.post('/creatorapi/create_new_app', { app_name: SRC_APP })
    expect(created.ok, JSON.stringify(created.data)).to.be.true

    const files = {
      'manifest.json': JSON.stringify(SRC_MANIFEST, null, 2),
      'index.js': SRC_JS,
      'app-comms.md': SRC_CONTRACT
    }
    for (const [filePath, content] of Object.entries(files)) {
      const w = await auth.post('/creatorapi/write_app_file', { app_name: SRC_APP, file_path: filePath, content })
      expect(w.ok, filePath + ': ' + JSON.stringify(w.data)).to.be.true
    }
    const installed = await auth.post('/creatorapi/update_app_from_files', { app_name: SRC_APP })
    expect(installed.ok, JSON.stringify(installed.data)).to.be.true
  })

  it('installed_apps_context exposes app_services for the source app', async function () {
    const ctx = await auth.get('/creatorapi/installed_apps_context')
    expect(ctx.ok, JSON.stringify(ctx.data)).to.be.true
    const src = (ctx.data.apps || []).find((a) => a.app_name === SRC_APP)
    expect(src, 'source app missing from installed_apps_context').to.exist
    expect(src.app_services, 'app_services missing from projection').to.be.an('object')
    expect(src.app_services.contract).to.equal('app-comms.md')
    console.log('      ✓ app_services projected:', JSON.stringify(src.app_services))
  })

  it('manifest_reference returns a projection: services + exposed-table schemas, no pages/files', async function () {
    const resp = await auth.get('/creatorapi/manifest_reference?app_name=' + encodeURIComponent(SRC_APP))
    expect(resp.ok, JSON.stringify(resp.data)).to.be.true
    const ref = resp.data.manifest_reference
    expect(ref, 'manifest_reference missing').to.be.an('object')

    // Kept: identity, services, permissions
    expect(ref.identifier).to.equal(SRC_APP)
    expect(ref.app_services.contract).to.equal('app-comms.md')
    expect(ref.permissions).to.have.length(2)

    // Dropped: this app's internal structure/docs
    expect(ref.pages, 'pages should be omitted').to.be.undefined
    expect(ref.files, 'files should be omitted').to.be.undefined

    // 'things' is exposed via the share_records permission → FULL schema kept
    expect(ref.app_tables.things.schema, 'exposed table should keep its schema').to.be.an('object')
    expect(ref.app_tables.things.schema.name).to.exist

    // The projection must report what it left out (so the model can ask for more)
    expect(resp.data.omitted).to.be.an('array')
    expect(resp.data.omitted.join(' ')).to.include('pages')
    expect(resp.data.full_manifest_chars).to.be.a('number')
    console.log('      ✓ projection omitted: ' + JSON.stringify(resp.data.omitted))
  })

  it('manifest_reference is valid JSON-serializable and never truncated', async function () {
    const resp = await auth.get('/creatorapi/manifest_reference?app_name=' + encodeURIComponent(SRC_APP))
    expect(resp.ok).to.be.true
    // The whole point of the projection: a requester always gets PARSEABLE structure back.
    const roundTripped = JSON.parse(JSON.stringify(resp.data.manifest_reference))
    expect(roundTripped.identifier).to.equal(SRC_APP)
  })

  it('installed_apps_context?detail=summary is leaner than the default and drops field schemas', async function () {
    const full = await auth.get('/creatorapi/installed_apps_context')
    const summary = await auth.get('/creatorapi/installed_apps_context?detail=summary')
    expect(full.ok && summary.ok, 'both context calls should succeed').to.be.true
    expect(summary.data.detail).to.equal('summary')

    const fullChars = JSON.stringify(full.data.apps).length
    const summaryChars = JSON.stringify(summary.data.apps).length
    expect(summaryChars, 'summary must be smaller than the full projection').to.be.lessThan(fullChars)

    const src = (summary.data.apps || []).find(a => a.app_name === SRC_APP)
    expect(src, 'source app should be listed').to.exist
    expect(src.app_services, 'services must survive the summary — it is what the pass is for').to.be.an('object')
    expect(src.offers_services).to.be.true
    expect(src.tables, 'summary carries table NAMES').to.have.property('things')
    expect(src.app_tables, 'summary must NOT carry full app_tables/field schemas').to.be.undefined
    expect(src.files, 'summary must NOT carry the file list').to.be.undefined
    console.log('      ✓ summary ' + summaryChars + ' chars vs full ' + fullChars + ' chars')
  })

  it('clone_app_files copies the source into the target root, rewriting the app id', async function () {
    const created = await auth.post('/creatorapi/create_new_app', { app_name: TGT_APP })
    expect(created.ok, JSON.stringify(created.data)).to.be.true

    const clone = await auth.post('/creatorapi/clone_app_files', { source_app: SRC_APP, target_app: TGT_APP })
    expect(clone.ok, JSON.stringify(clone.data)).to.be.true
    expect(clone.data.copied).to.be.greaterThan(2)
    expect(clone.data.errors || []).to.have.length(0)

    // Replacement report covers the files that carried the source app id
    const replacedPaths = (clone.data.replacements || []).map((r) => r.path)
    expect(replacedPaths).to.include('manifest.json')
    expect(replacedPaths).to.include('index.js')
    console.log('      ✓ replacements:', JSON.stringify(clone.data.replacements))

    // Cloned manifest: identifier + own table_id rewritten; other-app table_id untouched
    const m = await auth.get('/creatorapi/read_app_file?app_name=' + encodeURIComponent(TGT_APP) + '&file_path=manifest.json')
    expect(m.ok).to.be.true
    const cloned = JSON.parse(m.data.content)
    expect(cloned.identifier).to.equal(TGT_APP)
    expect(cloned.permissions[0].table_id).to.equal(TGT_APP + '.things')
    expect(cloned.permissions[1].table_id).to.equal('com.example.otherapp.records')

    // Cloned JS: nav URL + fallback literal rewritten; other-app table id untouched
    const j = await auth.get('/creatorapi/read_app_file?app_name=' + encodeURIComponent(TGT_APP) + '&file_path=index.js')
    expect(j.ok).to.be.true
    expect(j.data.content).to.include("/apps/" + TGT_APP + "/")
    expect(j.data.content).to.not.include(SRC_APP)
    expect(j.data.content).to.include('com.example.otherapp.records')

    // Provenance: the cloner owns the fork; the source app + its main_author are credited in
    // forked_from; the source's history travels along with a 'forked' event appended.
    const auth2 = cloned.authorship
    expect(auth2, 'cloned manifest missing authorship').to.be.an('object')
    expect(auth2.main_author.id).to.equal(auth.userId)
    expect(auth2.forked_from.app).to.equal(SRC_APP)
    expect(auth2.forked_from.author.id).to.equal('guest1')
    expect(auth2.forked_from.version).to.equal('0.1')
    const events = (auth2.history || []).map((h) => h.event)
    expect(events).to.include('created') // inherited from the source's history
    expect(events[events.length - 1]).to.equal('forked')
    console.log('      ✓ fork provenance:', JSON.stringify(auth2.forked_from))
  })

  it('update_app_from_files stamps a foreign editor (last_modified + contributors + history)', async function () {
    // Simulate an app authored by someone else that guest1 then edits: rewrite the source app's
    // manifest with a foreign main_author, re-install, and check the edit stamp.
    const foreign = { id: 'alice', host: 'https://other.example.com', date: 1750000000000 }
    const foreignManifest = { ...SRC_MANIFEST, authorship: { main_author: foreign, last_modified: foreign, contributors: [] } }
    const w = await auth.post('/creatorapi/write_app_file', { app_name: SRC_APP, file_path: 'manifest.json', content: JSON.stringify(foreignManifest, null, 2) })
    expect(w.ok).to.be.true
    const installed = await auth.post('/creatorapi/update_app_from_files', { app_name: SRC_APP })
    expect(installed.ok, JSON.stringify(installed.data)).to.be.true

    const m = await auth.get('/creatorapi/read_app_file?app_name=' + encodeURIComponent(SRC_APP) + '&file_path=manifest.json')
    const stamped = JSON.parse(m.data.content).authorship
    expect(stamped.main_author.id).to.equal('alice') // never reassigned by an edit
    expect(stamped.last_modified.id).to.equal(auth.userId)
    expect(stamped.contributors.map((c) => c.id)).to.include(auth.userId)
    expect(stamped.history[stamped.history.length - 1].event).to.equal('edited_by')
    console.log('      ✓ edit stamp:', JSON.stringify({ last_modified: stamped.last_modified.id, contributors: stamped.contributors.map((c) => c.id) }))
  })

  it('copy_app_files places contract + manifest under imported/<app>/ (reference flow)', async function () {
    const copy = await auth.post('/creatorapi/copy_app_files', {
      target_app: TGT_APP,
      sources: [
        { app: SRC_APP, path: 'manifest.json' },
        { app: SRC_APP, path: 'app-comms.md' }
      ]
    })
    expect(copy.ok, JSON.stringify(copy.data)).to.be.true
    expect((copy.data.copied || []).map((c) => c.dest)).to.include('imported/' + SRC_APP + '/app-comms.md')

    const c = await auth.get('/creatorapi/read_app_file?app_name=' + encodeURIComponent(TGT_APP) + '&file_path=' + encodeURIComponent('imported/' + SRC_APP + '/app-comms.md'))
    expect(c.ok).to.be.true
    expect(c.data.content).to.include('Test contract')
  })
})
