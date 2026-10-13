// Unit tests for the ?freezr_probe= branch of appPageController.generateAppPage: the data-probe
// consent page must be served INSTEAD of the app's page — none of the app's html, css or js — while
// keeping the app's ordinary page token (cookie), so the probe's reads use the app's own permissions.
import { expect } from 'chai'
import { createAppPageController } from '../../../features/apps/controllers/appPageController.mjs'

const APP = 'com.example.expenses'
const { generateAppPage } = createAppPageController()

const run = async ({ probe }) => {
  const reads = []
  const res = {
    headers: {}, cookies: [], body: null, statusCode: 200, headersSent: false,
    locals: {
      flogger: { track () {}, error () {}, debug () {} },
      freezr: {
        permGiven: true,
        freezrVersion: 'test',
        serverName: 'test',
        tokenInfo: { app_token: 'APP_TOKEN', owner_id: 'alice', app_name: APP },
        manifest: {
          pages: { index: { html_file: 'index.html', css_files: ['app.css'], modules: ['index.js'], script_files: ['lib.js'] } },
          permissions: []
        },
        appFS: { readAppFile: async (p) => { reads.push(p); return '<div id="app-html">APP OWN HTML</div>' } }
      }
    },
    setHeader (k, v) { this.headers[k.toLowerCase()] = v },
    status (c) { this.statusCode = c; return this },
    send (b) { this.body = b; this.headersSent = true; return this },
    json (b) { this.body = b; this.headersSent = true; return this },
    type () { return this },
    cookie (name, value, opts) { this.cookies.push({ name, value, path: opts && opts.path }) }
  }
  const req = {
    headers: { 'sec-fetch-mode': 'navigate' },
    params: { app_name: APP, page: 'index' },
    query: probe ? { freezr_probe: 'eyJ4IjoxfQ' } : {},
    session: { logged_in_user_id: 'alice' },
    originalUrl: '/apps/' + APP + '/index' + (probe ? '?freezr_probe=eyJ4IjoxfQ' : '')
  }
  await generateAppPage(req, res)
  return { res, reads }
}

describe('generateAppPage — ?freezr_probe= (data probe page)', () => {
  it('serves freezr\'s probe page and none of the app\'s own html, css or js', async () => {
    const { res, reads } = await run({ probe: true })
    const html = String(res.body)
    expect(html).to.include('/app/info.freezr.public/public/freezrProbe.js')
    expect(html).to.include('/app/info.freezr.public/public/freezrProbe.css')
    expect(html).to.include('<div id="freezr-probe"></div>')
    expect(html).to.not.include('APP OWN HTML')
    expect(html).to.not.include('index.js')
    expect(html).to.not.include('app.css')
    expect(html).to.not.include('lib.js')
    expect(reads, 'no file is read from the app').to.have.length(0)
  })

  it('keeps the app\'s ordinary page token, so reads use the app\'s own permissions', async () => {
    const { res } = await run({ probe: true })
    expect(res.cookies.find((c) => c.path === '/apps/' + APP)).to.deep.include({ name: 'app_token_alice', value: 'APP_TOKEN' })
  })

  it('leaves the normal app page unchanged without the parameter', async () => {
    const { res, reads } = await run({ probe: false })
    const html = String(res.body)
    expect(html).to.include('APP OWN HTML')
    expect(html).to.include('index.js')
    expect(html).to.not.include('freezrProbe.js')
    expect(reads).to.deep.equal(['index.html'])
  })
})
