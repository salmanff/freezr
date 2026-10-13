// Unit tests for the LLM/metered-resource cost meter (info.freezr.account.usageTallies).
//
// The two things worth guarding here are structural, not arithmetic:
//   1. The row identity. It is (resource, day, app, API KEY, upstream vendor). Two keys on
//      one provider must not merge (they are two budgets), and one aggregator key spanning
//      two vendors must not merge (that is the whole point of the OpenRouter case).
//   2. Lost updates. freezr's datastore has no atomic $inc — every tally write is a
//      read-modify-write — so concurrent LLM calls on one key are only correct because the
//      service serializes writes per key. The concurrency test fails if that goes away.
import { expect } from 'chai'
import { recordUsage, queryTallies, summarizeTallies, resolveRange, utcDay } from '../../../features/account/services/usageTallyService.mjs'

// Minimal stand-in for an opened ds handle: query / create / update with replaceAllFields,
// matching the subset of the real contract the service uses (incl. $gte/$lte on `date`).
const fakeDb = ({ latency = 0 } = {}) => {
  const rows = []
  let nextId = 1
  const pause = () => (latency ? new Promise(resolve => setTimeout(resolve, latency)) : Promise.resolve())
  const matches = (row, query) => Object.entries(query).every(([field, want]) => {
    const got = row[field]
    if (want && typeof want === 'object' && !Array.isArray(want)) {
      if (want.$gte !== undefined && !(String(got) >= want.$gte)) return false
      if (want.$lte !== undefined && !(String(got) <= want.$lte)) return false
      return true
    }
    return got === want
  })
  return {
    rows,
    calls: { query: 0, create: 0, update: 0 },
    async query (query, options = {}) {
      this.calls.query++
      await pause()
      const hits = rows.filter(r => matches(r, query))
      const skip = options.skip || 0
      const count = options.count || options.limit || 100
      return hits.slice(skip, skip + count).map(r => ({ ...r }))
    },
    async create (id, entity) {
      this.calls.create++
      await pause()
      const row = { ...entity, _id: id || String(nextId++) }
      rows.push(row)
      return { _id: row._id }
    },
    async update (id, entity, options = {}) {
      this.calls.update++
      await pause()
      const i = rows.findIndex(r => String(r._id) === String(id))
      if (i < 0) throw new Error('no records found to update')
      rows[i] = { ...entity, _id: rows[i]._id }
      return { nModified: 1 }
    }
  }
}

const usage = (input, output, other = 0) => ({
  input: { qtty: input, cost: 0 },
  output: { qtty: output, cost: 0 },
  other: { qtty: other, cost: 0, details: {} }
})
const priced = (inputCost, outputCost, otherCost = 0) => ({
  inputTokens: 0, outputTokens: 0, otherTokens: 0, totalTokens: 0,
  inputCost, outputCost, otherCost, totalCost: inputCost + outputCost + otherCost
})

const claudeKey = {
  ownerId: 'salman',
  appName: 'info.freezr.creator',
  resourceId: 'key1',
  resourceName: 'personal claude',
  provider: 'Claude',
  vendor: 'anthropic',
  model: 'claude-sonnet-4-5-20260101',
  kind: 'ask'
}
const AT = Date.UTC(2026, 8, 4, 10, 0, 0) // 2026-09-04

describe('usageTallyService — recordUsage', function () {
  it('creates one row and fills in identity, tokens, cost and model detail', async function () {
    const db = fakeDb()
    await recordUsage(db, { ...claudeKey, tokensUsed: usage(100, 50), cost: priced(0.001, 0.002), at: AT })

    expect(db.rows).to.have.length(1)
    const row = db.rows[0]
    expect(row).to.include({
      resource: 'llm', owner_id: 'salman', app_name: 'info.freezr.creator',
      resource_id: 'key1', resource_name: 'personal claude', provider: 'Claude',
      vendor: 'anthropic', date: '2026-09-04', month: '2026-09', requests: 1
    })
    expect(row.tokens).to.deep.equal({ input: 100, output: 50, other: 0, total: 150 })
    expect(row.cost.total).to.be.closeTo(0.003, 1e-12)
    expect(row.kinds).to.deep.equal({ ask: 1 })
    expect(row.models).to.have.length(1)
    expect(row.models[0].model).to.equal('claude-sonnet-4-5-20260101')
    expect(row.models[0].requests).to.equal(1)
    expect(row.cost_source).to.equal('freezr_pricetable')
    expect(row.first_at).to.equal(AT)
    expect(row.last_at).to.equal(AT)
  })

  it('merges a second call of the same day into the same row', async function () {
    const db = fakeDb()
    await recordUsage(db, { ...claudeKey, tokensUsed: usage(100, 50), cost: priced(0.001, 0.002), at: AT })
    await recordUsage(db, { ...claudeKey, tokensUsed: usage(10, 5), cost: priced(0.0001, 0.0002), at: AT + 60000 })

    expect(db.rows).to.have.length(1)
    const row = db.rows[0]
    expect(row.requests).to.equal(2)
    expect(row.tokens).to.deep.equal({ input: 110, output: 55, other: 0, total: 165 })
    expect(row.cost.total).to.be.closeTo(0.0033, 1e-12)
    expect(row.models).to.have.length(1)
    expect(row.models[0].requests).to.equal(2)
    expect(row.first_at).to.equal(AT)
    expect(row.last_at).to.equal(AT + 60000)
  })

  it('starts a new row on the next UTC day', async function () {
    const db = fakeDb()
    await recordUsage(db, { ...claudeKey, tokensUsed: usage(1, 1), cost: priced(1, 1), at: Date.UTC(2026, 8, 4, 23, 59) })
    await recordUsage(db, { ...claudeKey, tokensUsed: usage(1, 1), cost: priced(1, 1), at: Date.UTC(2026, 8, 5, 0, 1) })
    expect(db.rows.map(r => r.date)).to.deep.equal(['2026-09-04', '2026-09-05'])
  })

  it('keeps two API keys of the SAME provider in separate rows', async function () {
    const db = fakeDb()
    await recordUsage(db, { ...claudeKey, tokensUsed: usage(100, 0), cost: priced(1, 0), at: AT })
    await recordUsage(db, { ...claudeKey, resourceId: 'key2', resourceName: 'work claude', tokensUsed: usage(200, 0), cost: priced(2, 0), at: AT })

    expect(db.rows).to.have.length(2)
    expect(db.rows.map(r => r.resource_id)).to.deep.equal(['key1', 'key2'])
    expect(db.rows.map(r => r.tokens.input)).to.deep.equal([100, 200])
  })

  it('splits ONE aggregator key across vendors (the OpenRouter case)', async function () {
    const db = fakeDb()
    const orKey = {
      ownerId: 'salman', appName: 'info.freezr.creator', resourceId: 'or1',
      resourceName: 'my openrouter', provider: 'OpenRouter', kind: 'ask'
    }
    await recordUsage(db, { ...orKey, vendor: 'anthropic', model: 'anthropic/claude-sonnet-4.5', tokensUsed: usage(100, 10), cost: priced(0.5, 0.1), at: AT })
    await recordUsage(db, { ...orKey, vendor: 'openai', model: 'openai/gpt-5.5', tokensUsed: usage(200, 20), cost: priced(0.2, 0.05), at: AT })
    await recordUsage(db, { ...orKey, vendor: 'anthropic', model: 'anthropic/claude-haiku-4.5', tokensUsed: usage(5, 5), cost: priced(0.01, 0.01), at: AT })

    expect(db.rows).to.have.length(2)
    const byVendor = Object.fromEntries(db.rows.map(r => [r.vendor, r]))
    expect(byVendor.anthropic.requests).to.equal(2)
    expect(byVendor.anthropic.models.map(m => m.model)).to.deep.equal(['anthropic/claude-sonnet-4.5', 'anthropic/claude-haiku-4.5'])
    expect(byVendor.openai.requests).to.equal(1)
    // Model ids with '.' and '/' survive verbatim — the reason `models` is an array.
    expect(byVendor.openai.models[0].model).to.equal('openai/gpt-5.5')
  })

  it('refreshes the key label on merge without splitting the row', async function () {
    const db = fakeDb()
    await recordUsage(db, { ...claudeKey, tokensUsed: usage(1, 1), cost: priced(1, 1), at: AT })
    await recordUsage(db, { ...claudeKey, resourceName: 'renamed claude', tokensUsed: usage(1, 1), cost: priced(1, 1), at: AT })
    expect(db.rows).to.have.length(1)
    expect(db.rows[0].resource_name).to.equal('renamed claude')
    expect(db.rows[0].requests).to.equal(2)
  })

  it('counts unmetered, unpriced, error and aborted calls distinctly', async function () {
    const db = fakeDb()
    // provider reported no usage at all (e.g. the OpenAI Assistants file path)
    await recordUsage(db, { ...claudeKey, tokensUsed: null, cost: null, at: AT })
    // tokens known but no price found for the model
    await recordUsage(db, { ...claudeKey, tokensUsed: usage(10, 10), cost: null, at: AT })
    await recordUsage(db, { ...claudeKey, tokensUsed: usage(1, 1), cost: priced(1, 1), outcome: 'error', at: AT })
    await recordUsage(db, { ...claudeKey, tokensUsed: null, cost: null, outcome: 'aborted', at: AT })

    const row = db.rows[0]
    expect(row.requests).to.equal(4)
    expect(row.unmetered_requests).to.equal(2)
    expect(row.unpriced_requests).to.equal(1)
    expect(row.errors).to.equal(1)
    expect(row.aborted).to.equal(1)
    expect(row.tokens.total).to.equal(22)
  })

  it('marks cost_source mixed when estimates and reported charges land in one row', async function () {
    const db = fakeDb()
    await recordUsage(db, { ...claudeKey, tokensUsed: usage(1, 1), cost: priced(1, 0), at: AT })
    expect(db.rows[0].cost_source).to.equal('freezr_pricetable')
    await recordUsage(db, { ...claudeKey, tokensUsed: usage(1, 1), cost: priced(1, 0), costSource: 'provider_reported', at: AT })
    expect(db.rows[0].cost_source).to.equal('mixed')
  })

  it('never mutates the record handed back by the db (a cache may share it)', async function () {
    const db = fakeDb()
    await recordUsage(db, { ...claudeKey, tokensUsed: usage(100, 50), cost: priced(1, 1), at: AT })
    // Simulate a caching ds.query that returns the stored object itself rather than a copy.
    const stored = db.rows[0]
    const snapshot = JSON.parse(JSON.stringify(stored))
    db.query = async () => [stored]
    await recordUsage(db, { ...claudeKey, tokensUsed: usage(1, 1), cost: priced(1, 1), at: AT })
    expect(stored.tokens).to.deep.equal(snapshot.tokens)
    expect(stored.models[0].tokens).to.deep.equal(snapshot.models[0].tokens)
    expect(stored.cost).to.deep.equal(snapshot.cost)
  })

  it('is a no-op without a db handle, and rejects a call with no owner', async function () {
    expect(await recordUsage(null, claudeKey)).to.deep.equal({ written: false })
    let threw = null
    try { await recordUsage(fakeDb(), { ...claudeKey, ownerId: null }) } catch (e) { threw = e }
    expect(threw).to.be.an('error')
  })

  it('does not lose updates when 20 calls on one key overlap', async function () {
    // Latency in the fake widens the read-modify-write window: without per-key
    // serialization every one of these would read the same row and 19 writes would vanish.
    const db = fakeDb({ latency: 2 })
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      recordUsage(db, { ...claudeKey, tokensUsed: usage(10, 5), cost: priced(0.001, 0.002), at: AT + i })
    ))

    expect(db.rows).to.have.length(1)
    const row = db.rows[0]
    expect(row.requests).to.equal(20)
    expect(row.tokens).to.deep.equal({ input: 200, output: 100, other: 0, total: 300 })
    expect(row.cost.total).to.be.closeTo(0.06, 1e-9)
    expect(row.models[0].requests).to.equal(20)
  })

  it('still parallelizes across different keys', async function () {
    const db = fakeDb({ latency: 2 })
    await Promise.all([
      recordUsage(db, { ...claudeKey, tokensUsed: usage(1, 0), cost: priced(1, 0), at: AT }),
      recordUsage(db, { ...claudeKey, resourceId: 'key2', tokensUsed: usage(1, 0), cost: priced(1, 0), at: AT }),
      recordUsage(db, { ...claudeKey, appName: 'other.app', tokensUsed: usage(1, 0), cost: priced(1, 0), at: AT })
    ])
    expect(db.rows).to.have.length(3)
    expect(db.rows.every(r => r.requests === 1)).to.be.true
  })
})

describe('usageTallyService — queryTallies', function () {
  it('filters by resource, date range and app', async function () {
    const db = fakeDb()
    await recordUsage(db, { ...claudeKey, tokensUsed: usage(1, 1), cost: priced(1, 1), at: Date.UTC(2026, 8, 1) })
    await recordUsage(db, { ...claudeKey, tokensUsed: usage(1, 1), cost: priced(1, 1), at: Date.UTC(2026, 8, 10) })
    await recordUsage(db, { ...claudeKey, appName: 'other.app', tokensUsed: usage(1, 1), cost: priced(1, 1), at: Date.UTC(2026, 8, 10) })

    expect(await queryTallies(db, { from: '2026-09-05', to: '2026-09-30' })).to.have.length(2)
    expect(await queryTallies(db, { from: '2026-09-01', to: '2026-09-01' })).to.have.length(1)
    expect(await queryTallies(db, { appName: 'other.app' })).to.have.length(1)
    expect(await queryTallies(db, { resource: 'serverless_job' })).to.have.length(0)
    expect(await queryTallies(null, {})).to.deep.equal([])
  })

  it('pages past the connectors 100-record query cap', async function () {
    const db = fakeDb()
    // 150 distinct days => 150 rows, more than one page of the underlying db default.
    for (let i = 0; i < 150; i++) {
      await recordUsage(db, { ...claudeKey, tokensUsed: usage(1, 0), cost: priced(1, 0), at: Date.UTC(2026, 0, 1) + i * 86400000 })
    }
    const rows = await queryTallies(db, { from: '2026-01-01', to: '2026-12-31' })
    expect(rows).to.have.length(150)
    expect(rows[0].date).to.equal('2026-01-01')
    expect(rows[149].date > rows[0].date).to.be.true
  })
})

describe('usageTallyService — summarizeTallies', function () {
  const rowsFor = async () => {
    const db = fakeDb()
    const orKey = { ownerId: 'salman', appName: 'info.freezr.creator', resourceId: 'or1', resourceName: 'my openrouter', provider: 'OpenRouter', kind: 'ask' }
    await recordUsage(db, { ...claudeKey, tokensUsed: usage(100, 10), cost: priced(0.1, 0.2), at: AT })
    await recordUsage(db, { ...orKey, vendor: 'anthropic', model: 'anthropic/claude-sonnet-4.5', tokensUsed: usage(10, 1), cost: priced(0.01, 0.02), at: AT })
    await recordUsage(db, { ...orKey, vendor: 'openai', model: 'openai/gpt-5.5', tokensUsed: usage(20, 2), cost: priced(0.03, 0.04), at: AT + 86400000 })
    await recordUsage(db, { ...claudeKey, appName: 'other.app', tokensUsed: usage(5, 5), cost: priced(0.5, 0.5), at: AT + 86400000 })
    return queryTallies(db, {})
  }

  it('rolls up totals and every grouping', async function () {
    const s = summarizeTallies(await rowsFor())

    expect(s.total.requests).to.equal(4)
    expect(s.total.cost.total).to.be.closeTo(0.1 + 0.2 + 0.01 + 0.02 + 0.03 + 0.04 + 0.5 + 0.5, 1e-9)
    expect(s.total.tokens.total).to.equal(110 + 11 + 22 + 10)

    expect(s.byApp.map(a => a.app_name).sort()).to.deep.equal(['info.freezr.creator', 'other.app'])
    expect(s.byKey.map(k => k.resource_id).sort()).to.deep.equal(['key1', 'or1'])
    expect(s.byVendor.map(v => v.vendor).sort()).to.deep.equal(['anthropic', 'openai'])
    expect(s.byProvider.map(p => p.provider).sort()).to.deep.equal(['Claude', 'OpenRouter'])
    expect(s.byDay.map(d => d.date)).to.deep.equal(['2026-09-04', '2026-09-05'])
    // byModel keeps vendor, so the same model id via two vendors never collapses
    expect(s.byModel.map(m => m.model)).to.include('openai/gpt-5.5')
  })

  it('groups the table grain (app + key + vendor) with its own model breakdown', async function () {
    const s = summarizeTallies(await rowsFor())
    // creator+key1+anthropic, creator+or1+anthropic, creator+or1+openai, other.app+key1+anthropic
    expect(s.byAppKeyVendor).to.have.length(4)
    const orAnthropic = s.byAppKeyVendor.find(g => g.resource_id === 'or1' && g.vendor === 'anthropic')
    expect(orAnthropic.provider).to.equal('OpenRouter')
    expect(orAnthropic.resource_name).to.equal('my openrouter')
    expect(orAnthropic.models.map(m => m.model)).to.deep.equal(['anthropic/claude-sonnet-4.5'])
    // one key, two vendors, two lines — never merged
    expect(s.byAppKeyVendor.filter(g => g.resource_id === 'or1')).to.have.length(2)
  })

  it('merges the same model across days inside a table group', function () {
    const base = {
      resource: 'llm', app_name: 'a', resource_id: 'k', vendor: 'anthropic', provider: 'Claude',
      requests: 1, tokens: { input: 1, output: 0, other: 0, total: 1 }, cost: { input: 1, output: 0, other: 0, total: 1 }
    }
    const s = summarizeTallies([
      { ...base, date: '2026-09-04', models: [{ model: 'x', requests: 1, tokens: { input: 1, output: 0, other: 0, total: 1 }, cost: { input: 1, output: 0, other: 0, total: 1 } }] },
      { ...base, date: '2026-09-05', models: [{ model: 'x', requests: 2, tokens: { input: 3, output: 0, other: 0, total: 3 }, cost: { input: 2, output: 0, other: 0, total: 2 } }] }
    ])
    expect(s.byAppKeyVendor).to.have.length(1)
    expect(s.byAppKeyVendor[0].models).to.have.length(1)
    expect(s.byAppKeyVendor[0].models[0].requests).to.equal(3)
    expect(s.byAppKeyVendor[0].models[0].cost.total).to.equal(3)
  })

  it('sorts groups by cost and days chronologically', async function () {
    const s = summarizeTallies(await rowsFor())
    expect(s.byApp[0].app_name).to.equal('other.app') // $1.00 beats $0.40
    for (let i = 1; i < s.byDay.length; i++) expect(s.byDay[i].date > s.byDay[i - 1].date).to.be.true
  })

  it('sums duplicate rows for one tally key instead of picking one', async function () {
    const row = {
      resource: 'llm', app_name: 'a', resource_id: 'k', vendor: 'anthropic', provider: 'Claude',
      date: '2026-09-04', requests: 1, tokens: { input: 1, output: 1, other: 0, total: 2 },
      cost: { input: 1, output: 1, other: 0, total: 2 }, models: []
    }
    const s = summarizeTallies([row, { ...row }])
    expect(s.total.requests).to.equal(2)
    expect(s.total.cost.total).to.equal(4)
    expect(s.byKey).to.have.length(1)
  })

  it('handles an empty range', function () {
    const s = summarizeTallies([])
    expect(s.total.requests).to.equal(0)
    expect(s.total.cost.total).to.equal(0)
    expect(s.byApp).to.deep.equal([])
  })
})

describe('usageTallyService — resolveRange / utcDay', function () {
  it('defaults to the last 30 days ending today, UTC', function () {
    expect(resolveRange({}, Date.UTC(2026, 8, 4))).to.deep.equal({ from: '2026-08-06', to: '2026-09-04' })
  })
  it('crosses a year boundary correctly', function () {
    expect(resolveRange({ days: 90 }, Date.UTC(2026, 0, 15))).to.deep.equal({ from: '2025-10-18', to: '2026-01-15' })
  })
  it('discards anything that is not a YYYY-MM-DD string', function () {
    // express hands over an array for a repeated query param; it must never reach the query
    expect(resolveRange({ from: ['2026-01-01', 'x'], to: { $ne: null } }, Date.UTC(2026, 8, 4)))
      .to.deep.equal({ from: '2026-08-06', to: '2026-09-04' })
    expect(resolveRange({ from: 'yesterday' }, Date.UTC(2026, 8, 4)).from).to.equal('2026-08-06')
  })
  it('clamps an absurd day count', function () {
    expect(resolveRange({ days: 99999 }, Date.UTC(2026, 8, 4)).from).to.equal('2025-08-01')
    expect(resolveRange({ days: -5 }, Date.UTC(2026, 8, 4)).from).to.equal('2026-08-06')
  })
  it('utcDay is UTC, not local', function () {
    expect(utcDay(Date.UTC(2026, 8, 4, 23, 59, 59))).to.equal('2026-09-04')
  })
})
