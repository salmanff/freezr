// Unit tests for freezrsystmapps/info.freezr.public/public/freezrProbe.js — the consent page served
// in place of an app's page for ?freezr_probe=. It is a self-running browser script, so it is run
// here in a vm sandbox with a minimal fake DOM, a fake freezr SDK and a fake opener window.
import { expect } from 'chai'
import fs from 'fs'
import path from 'path'
import vm from 'vm'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = fs.readFileSync(path.join(__dirname, '../../../freezrsystmapps/info.freezr.public/public/freezrProbe.js'), 'utf8')
const APP = 'com.example.expenses'
const ORIGIN = 'https://freezr.example'

class FakeEl {
  constructor (tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.textContent = ''; this.className = ''; this._html = ''; this.disabled = false; this.onclick = null }
  appendChild (c) { this.children.push(c); return c }
  setAttribute (k, v) { this.attrs[k] = v }
  set innerHTML (v) { this._html = v; this.children = [] }
  get innerHTML () { return this._html }
}
const allText = (el) => [el.textContent, ...el.children.map(allText)].join(' ')
const findAll = (el, pred, out = []) => { if (pred(el)) out.push(el); el.children.forEach((c) => findAll(c, pred, out)); return out }
const button = (root, cls) => findAll(root, (e) => e.tagName === 'button' && e.className === cls)[0]

const encode = (payload) => Buffer.from(JSON.stringify(payload)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// Runs the page. opener: 'creator' | 'other-app' | 'none'. Returns handles to inspect.
const runPage = async ({ request, opener = 'creator', queryResult = [], files = {} }) => {
  const root = new FakeEl('div')
  const calls = { query: [], apiRequest: [], fetch: [], posted: [], closed: 0 }
  const openerWindow = opener === 'none' ? null : {
    closed: false,
    location: { origin: ORIGIN, pathname: opener === 'creator' ? '/creator' : '/apps/com.evil.app/index' },
    postMessage: (data, targetOrigin) => calls.posted.push({ data, targetOrigin })
  }
  const freezr = {
    // Like the server: a query on the files collection by _id finds the record whatever its path.
    query: async (table, filter, options) => {
      calls.query.push({ table, filter, options })
      if (table === 'files') return files[filter._id] ? [files[filter._id]] : []
      return queryResult
    },
    // Like the real route, a read cannot address an id containing '/'.
    read: async (collection, id) => { if (String(id).includes('/')) throw new Error('404'); return files[id] || null },
    apiRequest: async (method, url) => { calls.apiRequest.push(url); return { fileToken: 'tok123' } }
  }
  // Like a browser: the script runs in <head> while the document is still loading, so #freezr-probe
  // does not exist until DOMContentLoaded.
  let parsed = false
  const readyListeners = []
  const document = {
    get readyState () { return parsed ? 'interactive' : 'loading' },
    getElementById: (id) => (parsed && id === 'freezr-probe' ? root : null),
    createElement: (t) => new FakeEl(t),
    addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') readyListeners.push(fn) }
  }
  const context = vm.createContext({
    document,
    window: { opener: openerWindow, close: () => { calls.closed++ } },
    location: { search: '?freezr_probe=' + encode(request), origin: ORIGIN },
    freezr,
    freezrMeta: { appName: APP, userId: 'alice' },
    URLSearchParams,
    TextDecoder,
    atob,
    fetch: async (url) => { calls.fetch.push(url); return { ok: true, blob: async () => new Blob(['hello text']) } }
  })
  vm.runInContext(SCRIPT, context)
  parsed = true
  readyListeners.forEach((fn) => fn())
  await new Promise((resolve) => setTimeout(resolve, 20))
  return { root, calls }
}

describe('freezrProbe.js (probe consent page)', () => {
  it('does nothing unless opened by the creator — no query, nothing posted', async () => {
    for (const opener of ['none', 'other-app']) {
      const { root, calls } = await runPage({ opener, request: { probeId: 'p1', requests: [{ table: 'expenses' }] } })
      expect(calls.query, opener).to.have.length(0)
      expect(allText(root), opener).to.include('Nothing to show')
      expect(calls.posted, opener).to.have.length(0)
    }
  })

  it('clamps the count and drops unsupported filter operators, whatever the URL asks', async () => {
    const { calls, root } = await runPage({
      request: { probeId: 'p1', requests: [{ table: 'expenses', count: 500, filter: { amount: { $gt: 5, $regex: 'x' }, $where: 'evil()', cat: 'food' } }] }
    })
    expect(calls.query).to.have.length(1)
    expect(calls.query[0].table).to.equal(APP + '.expenses') // bare name qualified to this app
    expect(calls.query[0].options.count).to.equal(10)
    expect(calls.query[0].filter).to.deep.equal({ amount: { $gt: 5 }, cat: 'food' })
    expect(allText(root)).to.include('dropped unsupported operator')
  })

  it('shows the prompt-injection warning and the exact rows, without grant lists', async () => {
    const { root } = await runPage({
      request: { probeId: 'p1', why: 'check amounts', requests: [{ table: 'expenses' }] },
      queryResult: [{ _id: 'r1', amount: '12.50', _accessibles: [{ grantee: 'bob' }], long: 'x'.repeat(3000) }]
    })
    const text = allText(root)
    expect(text).to.include('Prompt injection risk')
    expect(text).to.include('"amount": "12.50"')
    expect(text).to.not.include('_accessibles')
    expect(text).to.include('truncated, 3000 chars')
  })

  it('on Share, posts the results to the creator only (same origin) and closes', async () => {
    const { root, calls } = await runPage({ request: { probeId: 'p1', requests: [{ table: 'expenses' }] }, queryResult: [{ a: 1 }] })
    button(root, 'fp-share').onclick()
    expect(calls.posted).to.have.length(1)
    expect(calls.posted[0].targetOrigin).to.equal(ORIGIN)
    expect(calls.posted[0].data).to.include({ type: 'freezr-probe-result', probeId: 'p1', declined: false })
    expect(calls.posted[0].data.results[0].rows).to.deep.equal([{ a: 1 }])
    expect(calls.closed).to.equal(1)
  })

  it('on Don\'t share, posts a decline and no data', async () => {
    const { root, calls } = await runPage({ request: { probeId: 'p1', requests: [{ table: 'expenses' }] }, queryResult: [{ a: 1 }] })
    button(root, 'fp-cancel').onclick()
    expect(calls.posted[0].data).to.deep.include({ probeId: 'p1', declined: true })
    expect(calls.posted[0].data.results).to.equal(undefined)
  })

  it('reads an uploaded file with a token scoped to that one file, and never shares the token', async () => {
    const { root, calls } = await runPage({
      request: { probeId: 'p1', requests: [{ file: 'notes/a.txt' }] },
      files: { 'notes/a.txt': { _mime_type: 'text/plain', _file_size: 10 } }
    })
    expect(calls.apiRequest[0]).to.equal('/feps/getuserfiletoken/self/' + APP + '/alice?file=' + encodeURIComponent('notes/a.txt'))
    button(root, 'fp-share').onclick()
    const shared = JSON.stringify(calls.posted[0].data)
    expect(shared).to.include('hello text')
    expect(shared).to.not.include('tok123')
  })

  it('finds a file whose path has several folders (the record id contains slashes)', async () => {
    const deck = 'projects/freezr-pitch-2026/draft/index.html'
    const { root, calls } = await runPage({
      request: { probeId: 'p1', requests: [{ file: deck }] },
      files: { [deck]: { _mime_type: 'text/html', _file_size: 1360 } }
    })
    expect(calls.query[0]).to.deep.include({ table: 'files', filter: { _id: deck } })
    expect(allText(root)).to.not.include('no uploaded file')
    expect(calls.fetch[0]).to.include('/feps/userfiles/' + APP + '/alice/' + deck + '?fileToken=')
  })

  it('answers one result per request, in order, including failures (the creator maps them back by index)', async () => {
    const { root, calls } = await runPage({
      request: { probeId: 'p1', requests: [{ table: 'a' }, { file: 'missing.png' }, { table: 'b' }] },
      queryResult: [{ x: 1 }]
    })
    button(root, 'fp-share').onclick()
    const results = calls.posted[0].data.results
    expect(results.map((r) => [r.kind, r.ok])).to.deep.equal([['table', true], ['file', false], ['table', true]])
  })

  it('refuses traversal paths, unknown files and unsupported types without reading anything', async () => {
    const { root, calls } = await runPage({
      request: { probeId: 'p1', requests: [{ file: '../other/secret.txt' }, { file: 'missing.png' }] },
      files: {}
    })
    expect(calls.apiRequest).to.have.length(0)
    expect(calls.fetch).to.have.length(0)
    const text = allText(root)
    expect(text).to.include('invalid file path')
    expect(text).to.include('no uploaded file with that path')

    const odd = await runPage({ request: { probeId: 'p2', requests: [{ file: 'a.exe' }] }, files: { 'a.exe': { _mime_type: 'application/x-msdownload', _file_size: 5 } } })
    expect(allText(odd.root)).to.include('cannot be sent to a model')
    expect(odd.calls.fetch).to.have.length(0)
  })
})
