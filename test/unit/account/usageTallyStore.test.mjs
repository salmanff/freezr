// The tally meter against a REAL datastore (nedb on a temp dir), not a fake handle.
//
// usageTallyService.test.mjs covers the merge logic with an injected fake db. What it
// cannot cover is the bit most likely to break silently: whether the freezr `ds` contract
// behaves as the service assumes — create(null, row) with a native id, a field query to
// find the row again, and update(id, merged, { replaceAllFields: true, old_entity }) to
// replace it while the reserved fields survive. Those go through USER_DS wrappers and a db
// connector, so they are worth exercising for real. No server, no network: same real-nedb
// approach as test/unit/datastore/dbInitHang.test.mjs.
import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'
import USER_DS from '../../../adapters/datastore/userDsMgr.mjs'
import { recordUsage, queryTallies, summarizeTallies } from '../../../features/account/services/usageTallyService.mjs'

const OWNER = 'tallystoretester'
const AT = Date.UTC(2026, 8, 4, 10, 0, 0)

const tokensUsed = (input, output) => ({
  input: { qtty: input, cost: 0 },
  output: { qtty: output, cost: 0 },
  other: { qtty: 0, cost: 0, details: {} }
})
const cost = (total) => ({
  inputTokens: 0, outputTokens: 0, otherTokens: 0, totalTokens: 0,
  inputCost: total, outputCost: 0, otherCost: 0, totalCost: total
})
const claudeKey = {
  ownerId: OWNER,
  appName: 'info.freezr.creator',
  resourceId: 'key1',
  resourceName: 'personal claude',
  provider: 'Claude',
  vendor: 'anthropic',
  model: 'claude-sonnet-4-5-20260101',
  kind: 'ask'
}

describe('usageTallies on a real nedb store', function () {
  let dbPath, userDs, ds

  beforeEach(async function () {
    dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'freezr-tally-'))
    userDs = new USER_DS(OWNER, {
      dbParams: { type: 'nedb', db_path: dbPath },
      fsParams: { type: 'local', rootFolder: 'files' }
    })
    if (userDs.dbPersistenceManager && userDs.dbPersistenceManager.timer) clearTimeout(userDs.dbPersistenceManager.timer)
    ds = await userDs.initOacDB({ owner: OWNER, app_table: 'info.freezr.account.usageTallies' }, {})
  })

  afterEach(function () {
    if (userDs && userDs.useage && userDs.useage.calcTimer) clearTimeout(userDs.useage.calcTimer)
    if (userDs && userDs.dbPersistenceManager && userDs.dbPersistenceManager.timer) clearTimeout(userDs.dbPersistenceManager.timer)
    fs.rmSync(dbPath, { recursive: true, force: true })
  })

  it('creates the row with a native _id and finds it again by field query', async function () {
    const written = await recordUsage(ds, { ...claudeKey, tokensUsed: tokensUsed(100, 50), cost: cost(0.003), at: AT })
    expect(written.written).to.equal(true)
    expect(written.created).to.equal(true)
    expect(written._id).to.be.a('string').and.not.empty

    const rows = await queryTallies(ds, { from: '2026-09-01', to: '2026-09-30' })
    expect(rows).to.have.length(1)
    expect(rows[0]._id).to.equal(written._id) // native id, not one we composed
    expect(rows[0].tokens.total).to.equal(150)
    expect(rows[0].models[0].model).to.equal('claude-sonnet-4-5-20260101')
  })

  it('merges a second call into the same stored row (update, not insert)', async function () {
    const first = await recordUsage(ds, { ...claudeKey, tokensUsed: tokensUsed(100, 50), cost: cost(0.003), at: AT })
    const second = await recordUsage(ds, { ...claudeKey, tokensUsed: tokensUsed(10, 5), cost: cost(0.0003), at: AT + 60000 })
    expect(second.created).to.equal(false)
    expect(second._id).to.equal(first._id)

    const rows = await queryTallies(ds, {})
    expect(rows).to.have.length(1)
    expect(rows[0].requests).to.equal(2)
    expect(rows[0].tokens).to.deep.equal({ input: 110, output: 55, other: 0, total: 165 })
    expect(rows[0].cost.total).to.be.closeTo(0.0033, 1e-9)
    expect(rows[0].models).to.have.length(1)
    expect(rows[0].models[0].requests).to.equal(2)
    // replaceAllFields + old_entity must preserve the reserved fields
    expect(rows[0]._date_created).to.be.a('number')
    expect(rows[0]._date_modified).to.be.a('number')
  })

  it('keeps two keys and two vendors in separate stored rows', async function () {
    await recordUsage(ds, { ...claudeKey, tokensUsed: tokensUsed(100, 0), cost: cost(1), at: AT })
    await recordUsage(ds, { ...claudeKey, resourceId: 'key2', resourceName: 'work claude', tokensUsed: tokensUsed(200, 0), cost: cost(2), at: AT })
    const orKey = { ownerId: OWNER, appName: 'info.freezr.creator', resourceId: 'or1', resourceName: 'my openrouter', provider: 'OpenRouter', kind: 'ask' }
    await recordUsage(ds, { ...orKey, vendor: 'anthropic', model: 'anthropic/claude-sonnet-4.5', tokensUsed: tokensUsed(10, 0), cost: cost(0.1), at: AT })
    await recordUsage(ds, { ...orKey, vendor: 'openai', model: 'openai/gpt-5.5', tokensUsed: tokensUsed(20, 0), cost: cost(0.2), at: AT })

    const rows = await queryTallies(ds, {})
    expect(rows).to.have.length(4)
    const summary = summarizeTallies(rows)
    expect(summary.byKey.map(k => k.resource_id).sort()).to.deep.equal(['key1', 'key2', 'or1'])
    expect(summary.byVendor.map(v => v.vendor).sort()).to.deep.equal(['anthropic', 'openai'])
    expect(summary.total.cost.total).to.be.closeTo(3.3, 1e-9)
    // model ids with '.' and '/' round-trip through the store unchanged
    const orRows = rows.filter(r => r.resource_id === 'or1')
    expect(orRows.flatMap(r => r.models.map(m => m.model)).sort())
      .to.deep.equal(['anthropic/claude-sonnet-4.5', 'openai/gpt-5.5'])
  })

  it('survives concurrent writes on one key through the real store', async function () {
    await Promise.all(Array.from({ length: 12 }, (_, i) =>
      recordUsage(ds, { ...claudeKey, tokensUsed: tokensUsed(10, 5), cost: cost(0.001), at: AT + i })
    ))
    const rows = await queryTallies(ds, {})
    expect(rows).to.have.length(1)
    expect(rows[0].requests).to.equal(12)
    expect(rows[0].tokens.total).to.equal(180)
    expect(rows[0].cost.total).to.be.closeTo(0.012, 1e-9)
  })

  it('reads back a range spanning many days', async function () {
    for (let i = 0; i < 40; i++) {
      await recordUsage(ds, { ...claudeKey, tokensUsed: tokensUsed(1, 1), cost: cost(0.01), at: Date.UTC(2026, 7, 1) + i * 86400000 })
    }
    const all = await queryTallies(ds, { from: '2026-08-01', to: '2026-09-30' })
    expect(all).to.have.length(40)
    const narrow = await queryTallies(ds, { from: '2026-08-01', to: '2026-08-05' })
    expect(narrow).to.have.length(5)
    expect(summarizeTallies(all).byDay).to.have.length(40)
  })
})
