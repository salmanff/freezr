// Cosmos _date_modified index: create it once per collection per process, and
// never let its failure fail a table open.
//
// createIndex on an existing index does not rebuild it, so repeat calls are only
// metadata round trips - but on Cosmos those draw on a system-reserved budget
// that provisioning more RU/s does not raise, so a cold start opening many
// tables can throttle. Before this, a throttled call also THREW, which made
// initOacDB fail the table open for a collection that already had the index.

import { expect } from 'chai'
import MONGO_FOR_FREEZR, { ensureDateModifiedIndex, __indexMemoInternals } from '../../../adapters/datastore/dbConnectors/dbApi_mongodb.mjs'

const { indexMemoKey, targetNamesFor } = __indexMemoInternals

const COSMOS_URI = 'mongodb://acct:SUPERSECRETKEY@acct.mongo.cosmos.azure.com:10255/?ssl=true'
const OTHER_URI = 'mongodb://other:OTHERSECRET@other.mongo.cosmos.azure.com:10255/?ssl=true'

const store = (strategy, appTable, uri = COSMOS_URI) => new MONGO_FOR_FREEZR(
  {
    dbParams: {
      choice: 'cosmosForMongoString',
      type: 'mongodb',
      mongoString: uri,
      dbUnificationStrategy: strategy,
      useUserIdsAsDbName: true
    },
    fsParams: { type: 'local' }
  },
  { owner: 'sal', app_table: appTable }
)

describe('cosmos index memo key', function () {
  it("collapses to ONE key for the whole install under the 'all' strategy", function () {
    // Everything lands in the single unified collection, so after the first call
    // every other table-open is redundant.
    const a = indexMemoKey(store('all', 'com.x.one'))
    const b = indexMemoKey(store('all', 'com.y.two'))
    expect(targetNamesFor(store('all', 'com.x.one')).collName)
      .to.equal(targetNamesFor(store('all', 'com.y.two')).collName)
    expect(a).to.equal(b)
  })

  it("stays per-collection under the 'db' strategy, so dynamically created tables still get indexed", function () {
    const a = indexMemoKey(store('db', 'com.x.one'))
    const b = indexMemoKey(store('db', 'com.y.two'))
    expect(a).to.not.equal(b)
  })

  it('separates different connections, so one BYO user cannot suppress another', function () {
    const mine = indexMemoKey(store('all', 'com.x.one', COSMOS_URI))
    const theirs = indexMemoKey(store('all', 'com.x.one', OTHER_URI))
    expect(mine).to.not.equal(theirs)
  })

  it('does not carry the credentialed URI around in the memo', function () {
    const key = indexMemoKey(store('all', 'com.x.one'))
    expect(key).to.not.include('SUPERSECRETKEY')
    expect(key).to.not.include('mongodb://')
  })
})

describe('ensureDateModifiedIndex', function () {
  it('reports success when the index is created', async function () {
    const calls = []
    const coll = { createIndex: async (spec, opts) => { calls.push({ spec, opts }); return 'ok' } }
    expect(await ensureDateModifiedIndex(coll, 'allUserAppData')).to.equal(true)
    expect(calls[0].spec).to.deep.equal({ _date_modified: -1 })
  })

  it('swallows a throttle instead of failing the table open', async function () {
    const throttle = Object.assign(new Error('Request rate is large'), { code: 16500 })
    const coll = { createIndex: async () => { throw throttle } }
    let threw = null
    let result
    try { result = await ensureDateModifiedIndex(coll, 'allUserAppData') } catch (e) { threw = e }
    expect(threw, 'must not propagate - the collection works fine without the index').to.equal(null)
    expect(result).to.equal(false)
  })

  it('reports failure so the caller does not memoise it (next table-open retries)', async function () {
    const coll = { createIndex: async () => { throw new Error('boom') } }
    expect(await ensureDateModifiedIndex(coll, 'c')).to.equal(false)
  })
})
