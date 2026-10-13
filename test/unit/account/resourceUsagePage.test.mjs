// The Resource Usage page's browser JS, driven headlessly.
//
// Two reasons this exists rather than being left to a click-through:
//   1. The page is fed by summarizeTallies(), so the fixtures here are built by the REAL
//      usageTallyService. If the summary shape ever changes without the page following
//      (byAppKeyVendor renamed, a bucket dropped), these fail instead of the page quietly
//      rendering an empty panel.
//   2. The load sequencing is the whole point of the tab split: storage is the slow call
//      (userDS.getStorageUse walks the store), so it must not be issued until the LLM view
//      has rendered — or until the user opens the Storage tab, whichever comes first — and
//      never twice.
//
// The DOM stub below implements only what the page actually uses.
import { expect } from 'chai'
import vm from 'vm'
import fs from 'fs'
import path from 'path'
import { recordUsage, queryTallies, summarizeTallies } from '../../../features/account/services/usageTallyService.mjs'

const PAGE_JS = path.join(process.cwd(), 'freezrsystmapps/info.freezr.account/account_resourceusage.js')
const IDS = ['resource_usage_user_label', 'usage_range', 'metered_usage', 'app_list',
  'button_tabs_llm', 'button_tabs_storage', 'tab_llm', 'tab_storage']

// ===== DOM stub =====
const makeDom = () => {
  const all = []
  const mkNode = (tag) => {
    const node = {
      tagName: tag.toUpperCase(),
      children: [],
      parent: null,
      style: {},
      attrs: {},
      listeners: {},
      title: '',
      className: '',
      _text: '',
      _html: '',
      classList: {
        add (c) { const cs = node.className.split(' ').filter(Boolean); if (!cs.includes(c)) cs.push(c); node.className = cs.join(' ') },
        remove (c) { node.className = node.className.split(' ').filter(Boolean).filter(x => x !== c).join(' ') }
      },
      get textContent () { return this._text },
      set textContent (v) { this._text = String(v); this.children = [] },
      get innerHTML () { return this._html },
      set innerHTML (v) { this._html = String(v); if (v === '') this.children = [] },
      setAttribute (k, v) { this.attrs[k] = v },
      addEventListener (evt, fn) { (this.listeners[evt] = this.listeners[evt] || []).push(fn) },
      click () { (this.listeners.click || []).forEach(fn => fn()) },
      change () { (this.listeners.change || []).forEach(fn => fn()) },
      appendChild (child) {
        if (!child) throw new Error('appendChild(null) — a render path produced no node')
        child.parent = this
        this.children.push(child)
        return child
      },
      remove () { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this) },
      querySelector (sel) {
        const m = /^\[([^=]+)="([^"]+)"\]$/.exec(sel)
        const walk = (n) => {
          for (const c of n.children) {
            if (m && c.attrs[m[1]] === m[2]) return c
            const found = walk(c)
            if (found) return found
          }
          return null
        }
        return walk(this)
      }
    }
    all.push(node)
    return node
  }
  const byId = {}
  IDS.forEach(id => { byId[id] = mkNode('div'); byId[id].attrs.id = id })
  // classes the real HTML carries
  byId.tab_llm.className = 'tabcontent'
  byId.tab_storage.className = 'tabcontent'
  byId.button_tabs_llm.className = 'tablinks'
  byId.button_tabs_storage.className = 'tablinks'
  byId.usage_range.value = '30'
  return {
    byId,
    document: {
      createElement: mkNode,
      getElementById: (id) => byId[id] || null,
      getElementsByClassName: (cls) => all.filter(n => n.className.split(' ').includes(cls))
    }
  }
}

const walk = (node, test, out = []) => {
  if (test(node)) out.push(node)
  node.children.forEach(c => walk(c, test, out))
  return out
}
const withClass = (node, cls) => walk(node, n => n.className.split(' ').includes(cls))
const textsOf = (node) => walk(node, () => true).map(n => n._text).filter(Boolean)
const tag = (node, name) => walk(node, n => n.tagName === name)

// ===== fixtures, built through the real service =====
const fakeDb = () => {
  const rows = []
  let n = 1
  const matches = (row, q) => Object.entries(q).every(([f, want]) => {
    const got = row[f]
    if (want && typeof want === 'object') {
      if (want.$gte !== undefined && !(String(got) >= want.$gte)) return false
      if (want.$lte !== undefined && !(String(got) <= want.$lte)) return false
      return true
    }
    return got === want
  })
  return {
    async query (q, o = {}) {
      const hits = rows.filter(r => matches(r, q))
      const skip = o.skip || 0
      return hits.slice(skip, skip + (o.count || 100)).map(r => ({ ...r }))
    },
    async create (id, e) { const r = { ...e, _id: id || String(n++) }; rows.push(r); return { _id: r._id } },
    async update (id, e) { const i = rows.findIndex(r => String(r._id) === String(id)); rows[i] = { ...e, _id: rows[i]._id }; return { nModified: 1 } }
  }
}
const tok = (i, o, other = 0) => ({ input: { qtty: i, cost: 0 }, output: { qtty: o, cost: 0 }, other: { qtty: other, cost: 0, details: {} } })
const cst = (t) => ({ inputTokens: 0, outputTokens: 0, otherTokens: 0, totalTokens: 0, inputCost: t, outputCost: 0, otherCost: 0, totalCost: t })

const buildLlmData = async () => {
  const db = fakeDb()
  const day = (d) => Date.UTC(2026, 7, d, 12)
  const claude = { ownerId: 'salman', appName: 'info.freezr.creator', resourceId: 'key1', resourceName: 'personal claude', provider: 'Claude', vendor: 'anthropic', kind: 'ask' }
  const openrouter = { ownerId: 'salman', appName: 'info.freezr.creator', resourceId: 'or1', resourceName: 'my openrouter', provider: 'OpenRouter', kind: 'ask' }
  await recordUsage(db, { ...claude, model: 'claude-sonnet-4-5-20260101', tokensUsed: tok(120000, 4000, 80000), cost: cst(0.4), at: day(3) })
  await recordUsage(db, { ...claude, model: 'claude-sonnet-4-5-20260101', tokensUsed: tok(120000, 4000, 80000), cost: cst(0.4), at: day(4) })
  await recordUsage(db, { ...claude, model: 'claude-haiku-4-5', tokensUsed: tok(9000, 500), cost: cst(0.004), at: day(9) })
  await recordUsage(db, { ...openrouter, vendor: 'anthropic', model: 'anthropic/claude-sonnet-4.5', tokensUsed: tok(3000, 900), cost: cst(0.011), at: day(15) })
  await recordUsage(db, { ...openrouter, vendor: 'openai', model: 'openai/gpt-5.5', tokensUsed: tok(1200, 300), cost: cst(0.0007), at: day(15) })
  // an unpriced call: tokens known, no price for the model
  await recordUsage(db, { ...claude, appName: 'com.example.notes', model: 'claude-haiku-4-5', tokensUsed: tok(500, 100), cost: null, at: day(22) })
  const rows = await queryTallies(db, {})
  return { rows, summary: summarizeTallies(rows), from: '2026-08-01', to: '2026-08-30', resource: 'llm' }
}

const STORAGE = {
  totalSize: 5300000,
  time: Date.UTC(2026, 7, 30),
  resources: [
    { appName: 'info.freezr.creator', apps: 1200000, files: 900000, dbs: { 'info.freezr.creator.askAppChats': 300000, 'info.freezr.creator.askLearnings': 40000 } },
    { appName: 'com.example.notes', apps: 200000, files: 0, dbs: { 'com.example.notes.notes': 15000 } }
  ]
}

// ===== harness =====
const SRC = fs.readFileSync(PAGE_JS, 'utf8')
const settle = () => new Promise(resolve => setTimeout(resolve, 15))

const mountPage = ({ llm, storage, targetUser = null, holdLlm = false }) => {
  const { document, byId } = makeDom()
  const calls = []
  let releaseLlm = null
  const gate = holdLlm ? new Promise(resolve => { releaseLlm = resolve }) : null
  const answer = async (what, value) => {
    calls.push(what)
    if (what === 'llm' && gate) await gate
    if (value instanceof Error) throw value
    return value
  }
  const sandbox = {
    document,
    location: { search: targetUser ? '?user=' + targetUser : '' },
    URLSearchParams,
    console: { log () {}, warn () {}, error () {} },
    Date,
    Math,
    Object,
    Number,
    JSON,
    Array,
    isNaN,
    encodeURIComponent,
    freezr: {
      apiRequest: async (method, path) => {
        if (path.indexOf('sageTallies') > -1 || path.indexOf('usage_tallies') > -1) return answer('llm', llm)
        return answer('storage', storage)
      },
      utils: { getAppResourceUsage: async () => answer('storage', storage) }
    }
  }
  vm.runInNewContext(SRC, sandbox, { filename: 'account_resourceusage.js' })
  return { byId, calls, sandbox, releaseLlm }
}

describe('resource usage page — load sequencing', function () {
  it('shows the LLM tab first and issues only the LLM request', async function () {
    const page = mountPage({ llm: await buildLlmData(), storage: STORAGE, holdLlm: true })
    const done = page.sandbox.freezr.initPageScripts()
    await settle()

    expect(page.calls).to.deep.equal(['llm']) // storage NOT requested yet
    expect(page.byId.tab_llm.style.display).to.equal('block')
    expect(page.byId.tab_storage.style.display).to.equal('none')
    expect(page.byId.button_tabs_llm.className).to.contain('active')
    expect(page.byId.button_tabs_storage.className).to.not.contain('active')

    page.releaseLlm()
    await done
  })

  it('requests storage in the background only once the LLM view has rendered', async function () {
    const page = mountPage({ llm: await buildLlmData(), storage: STORAGE })
    await page.sandbox.freezr.initPageScripts()
    await settle()
    expect(page.calls).to.deep.equal(['llm', 'storage'])
    expect(withClass(page.byId.app_list, 'fz-table')).to.have.length(1)
  })

  it('loads storage immediately if the user opens that tab while the LLM call is in flight', async function () {
    const page = mountPage({ llm: await buildLlmData(), storage: STORAGE, holdLlm: true })
    const done = page.sandbox.freezr.initPageScripts()
    await settle()

    page.byId.button_tabs_storage.click()
    await settle()
    expect(page.calls).to.deep.equal(['llm', 'storage'])
    expect(page.byId.tab_storage.style.display).to.equal('block')
    expect(page.byId.tab_llm.style.display).to.equal('none')
    expect(page.byId.button_tabs_storage.className).to.contain('active')

    page.releaseLlm()
    await done
    await settle()
    // the background prefetch must not fetch it a second time
    expect(page.calls.filter(c => c === 'storage')).to.have.length(1)
  })

  it('never re-fetches storage however often the tabs are clicked', async function () {
    const page = mountPage({ llm: await buildLlmData(), storage: STORAGE })
    await page.sandbox.freezr.initPageScripts()
    await settle()
    page.byId.button_tabs_storage.click()
    page.byId.button_tabs_llm.click()
    page.byId.button_tabs_storage.click()
    await settle()
    expect(page.calls.filter(c => c === 'storage')).to.have.length(1)
  })

  it('changing the period re-requests only the LLM data', async function () {
    const page = mountPage({ llm: await buildLlmData(), storage: STORAGE })
    await page.sandbox.freezr.initPageScripts()
    await settle()
    page.byId.usage_range.value = '90'
    page.byId.usage_range.change()
    await settle()
    expect(page.calls).to.deep.equal(['llm', 'storage', 'llm'])
  })
})

describe('resource usage page — LLM rendering', function () {
  let byId

  before(async function () {
    const page = mountPage({ llm: await buildLlmData(), storage: STORAGE })
    await page.sandbox.freezr.initPageScripts()
    await settle()
    byId = page.byId
  })

  it('renders the headline stats from the real summary', function () {
    const values = withClass(byId.metered_usage, 'fz-stat-value').map(n => n._text)
    expect(values[0]).to.equal('$0.8157') // 0.4 + 0.4 + 0.004 + 0.011 + 0.0007
    expect(values[1]).to.equal('6') // requests
    expect(values[3]).to.equal('2') // distinct API keys
    const labels = withClass(byId.metered_usage, 'fz-stat-label').map(n => n._text)
    expect(labels).to.deep.equal(['Estimated cost', 'Requests', 'Tokens', 'API keys used'])
  })

  it('says the costs are estimates, and flags the unpriced request', function () {
    const notes = withClass(byId.metered_usage, 'fz-note').map(n => n._text)
    expect(notes.join(' ')).to.contain('estimated from freezr')
    expect(notes.join(' ')).to.contain('1 request could not be priced')
  })

  it('draws one bar per calendar day in the range, marking quiet days', function () {
    const bars = withClass(byId.metered_usage, 'fz-daybar')
    expect(bars).to.have.length(30) // 2026-08-01 .. 2026-08-30 inclusive
    expect(bars[0].title).to.contain('2026-08-01')
    expect(bars[0].className).to.contain('fz-daybar-empty')
    expect(bars[2].title).to.contain('2026-08-03')
    expect(bars[2].className).to.not.contain('fz-daybar-empty')
    expect(bars[2].title).to.contain('1 requests')
  })

  it('gives the aggregator key a vendor split and the direct key none', function () {
    const keys = withClass(byId.metered_usage, 'fz-key')
    expect(keys).to.have.length(2)
    const named = keys.map(k => withClass(k, 'fz-key-name')[0]._text)
    expect(named).to.have.members(['personal claude', 'my openrouter'])

    const or = keys[named.indexOf('my openrouter')]
    const chips = withClass(or, 'fz-chip').map(c => c._text)
    expect(chips.length).to.equal(2)
    expect(chips.join(' ')).to.contain('anthropic')
    expect(chips.join(' ')).to.contain('openai')

    const direct = keys[named.indexOf('personal claude')]
    expect(withClass(direct, 'fz-chip')).to.have.length(0)
  })

  it('shows the vendor column only because an aggregator key is present', function () {
    const headers = tag(byId.metered_usage, 'TH').map(h => h._text)
    expect(headers).to.deep.equal(['App', 'Key', 'Vendor', 'Requests', 'In', 'Out', 'Other', 'Cost'])
  })

  it('shows an unknown cost as a dash rather than $0', function () {
    const rows = withClass(byId.metered_usage, 'fz-clickable')
    const notesRow = rows.find(r => textsOf(r).some(t => t.indexOf('com.example.notes') > -1))
    const cells = tag(notesRow, 'TD').map(c => c._text)
    expect(cells[cells.length - 1]).to.equal('—')
    const costCell = tag(notesRow, 'TD').pop()
    expect(costCell.title).to.contain('No price found')
  })

  it('expands and collapses a row to show the models it used', function () {
    const row = withClass(byId.metered_usage, 'fz-clickable')[0]
    const detail = withClass(byId.metered_usage, 'fz-detail')[0]
    const caret = withClass(row, 'fz-caret')[0]

    expect(detail.style.display).to.equal('none')
    expect(caret._text).to.equal('▸')
    row.click()
    expect(detail.style.display).to.equal('table-row')
    expect(caret._text).to.equal('▾')
    expect(textsOf(detail).join(' ')).to.contain('claude-sonnet-4-5-20260101')
    row.click()
    expect(detail.style.display).to.equal('none')
    expect(caret._text).to.equal('▸')
  })

  it('totals the table in a footer', function () {
    const foot = tag(byId.metered_usage, 'TFOOT')[0]
    expect(foot).to.not.equal(undefined)
    const cells = tag(foot, 'TD').map(c => c._text)
    expect(cells[0]).to.equal('Total')
    expect(cells[cells.length - 1]).to.equal('$0.8157')
  })
})

describe('resource usage page — storage rendering', function () {
  it('sorts apps by total size and expands to per-table sizes', async function () {
    const page = mountPage({ llm: await buildLlmData(), storage: STORAGE })
    await page.sandbox.freezr.initPageScripts()
    await settle()

    const rows = withClass(page.byId.app_list, 'fz-clickable')
    expect(rows).to.have.length(2)
    expect(textsOf(rows[0]).join(' ')).to.contain('info.freezr.creator') // biggest first

    const detail = withClass(page.byId.app_list, 'fz-detail')[0]
    expect(detail.style.display).to.equal('none')
    rows[0].click()
    expect(detail.style.display).to.equal('table-row')
    expect(textsOf(detail).join(' ')).to.contain('info.freezr.creator.askAppChats')

    const stats = withClass(page.byId.app_list, 'fz-stat-value').map(n => n._text)
    expect(stats[0]).to.equal('5.3Mbs')
  })
})

describe('resource usage page — edge cases', function () {
  it('renders an empty state for a period with no usage', async function () {
    const page = mountPage({
      llm: { rows: [], summary: summarizeTallies([]), from: '2026-08-01', to: '2026-08-30' },
      storage: { resources: [] }
    })
    await page.sandbox.freezr.initPageScripts()
    await settle()
    expect(withClass(page.byId.metered_usage, 'fz-empty-title')[0]._text).to.contain('No AI usage')
    expect(withClass(page.byId.app_list, 'fz-empty-title')[0]._text).to.contain('No app storage')
  })

  it('shows an error state per tab without breaking the other', async function () {
    const page = mountPage({ llm: new Error('tallies unavailable'), storage: STORAGE })
    await page.sandbox.freezr.initPageScripts()
    await settle()
    expect(withClass(page.byId.metered_usage, 'fz-empty-title')[0]._text).to.contain('Could not read usage tallies')
    expect(textsOf(page.byId.metered_usage).join(' ')).to.contain('tallies unavailable')
    // storage still loaded and rendered
    expect(withClass(page.byId.app_list, 'fz-table')).to.have.length(1)
  })

  it('uses the admin endpoints and labels the user when opened as ?user=<id>', async function () {
    const paths = []
    const { document, byId } = makeDom()
    const sandbox = {
      document,
      location: { search: '?user=someone' },
      URLSearchParams,
      console: { log () {}, warn () {}, error () {} },
      Date,
      Math,
      Object,
      Number,
      JSON,
      Array,
      isNaN,
      encodeURIComponent,
      freezr: {
        apiRequest: async (method, p) => {
          paths.push(p)
          return p.indexOf('usage_tallies') > -1
            ? { rows: [], summary: summarizeTallies([]), from: '2026-08-01', to: '2026-08-30' }
            : STORAGE
        },
        utils: { getAppResourceUsage: async () => { throw new Error('must not use the account path in admin mode') } }
      }
    }
    vm.runInNewContext(SRC, sandbox, { filename: 'account_resourceusage.js' })
    await sandbox.freezr.initPageScripts()
    await settle()

    expect(paths[0]).to.contain('/adminapi/get_usage_tallies?user=someone')
    expect(paths[1]).to.contain('/adminapi/getuserappresources?user=someone')
    expect(byId.resource_usage_user_label.style.display).to.equal('block')
    expect(byId.resource_usage_user_label._text).to.contain('someone')
  })

  it('asks for a calendar month when the period is "This month"', async function () {
    const paths = []
    const page = mountPage({ llm: { rows: [], summary: summarizeTallies([]) }, storage: STORAGE })
    page.sandbox.freezr.apiRequest = async (method, p) => {
      paths.push(p)
      return p.indexOf('sageTallies') > -1 ? { rows: [], summary: summarizeTallies([]) } : STORAGE
    }
    await page.sandbox.freezr.initPageScripts()
    page.byId.usage_range.value = 'month'
    page.byId.usage_range.change()
    await settle()
    expect(paths.some(p => /from=\d{4}-\d{2}-01/.test(p))).to.equal(true)
  })
})
