// Regression tests for the "server gets stuck shortly after startup" hang.
//
// A nedb store whose loadDatabase failed used to be cached forever with an
// executor stuck at ready=false. Every later operation on it was parked in
// executor.buffer and never called back, so the request awaited a promise that
// could never settle - hanging forever and parking the browser connection it
// arrived on. Six of those exhaust a browser's per-origin connection pool and
// the whole app appears frozen while the server is otherwise healthy.

import { expect } from 'chai'
import Datastore from 'nedb-asyncfs'
import NEDB_FOR_FREEZR from '../../../adapters/datastore/dbConnectors/dbApi_nedb.mjs'
import USER_DS from '../../../adapters/datastore/userDsMgr.mjs'

// customFS that reports the table file as missing - what a cloud fs connector
// does for a table that has never been written. nedb-asyncfs discards the errors
// from mkdirp and ensureDatafileIntegrity, so the failure only surfaces at read.
const missingFileFS = () => ({
  doNotPersistOnLoad: true,
  mkdirp: (dir, cb) => cb(null),
  isPresent: (file, cb) => cb(null, false),
  writeNedbTableFile: (p, d, o, cb) => { const e = new Error('ENOENT'); e.code = 'ENOENT'; cb(e) },
  readNedbTableFile: (p, enc, cb) => { const e = new Error('ENOENT: no such file ' + p); e.code = 'ENOENT'; cb(e) }
})

const settlesWithin = (ms, executor) => new Promise(resolve => {
  const timer = setTimeout(() => resolve({ settled: false }), ms)
  executor(result => { clearTimeout(timer); resolve({ settled: true, result }) })
})

describe('nedb store whose load failed', function () {
  it('reports its executor as not ready, and parks operations instead of calling back', async function () {
    const db = new Datastore({ filename: 'x/y.db', customFS: missingFileFS() })
    await new Promise(resolve => db.loadDatabase(() => resolve()))

    expect(db.executor.ready).to.equal(false)

    // The shape of the original bug: the callback simply never comes.
    const outcome = await settlesWithin(300, done => db.find({}).exec(() => done()))
    expect(outcome.settled).to.equal(false)
    expect(db.executor.buffer.length).to.equal(1)
  })

  it('is detectable and recoverable through the connector helpers', async function () {
    const store = new NEDB_FOR_FREEZR(
      { dbParams: { type: 'nedb' }, fsParams: { type: 'local' } },
      { owner: 'u1', app_table: 'com.x.y' }
    )
    // Stand in for initDB's Datastore, with a load that fails.
    store.db = new Datastore({ filename: 'x/y.db', customFS: missingFileFS() })
    await new Promise(resolve => store.db.loadDatabase(() => resolve()))

    expect(store.executorIsReady()).to.equal(false)

    store.releaseExecutorBuffer()

    expect(store.executorIsReady()).to.equal(true)
    const outcome = await settlesWithin(1000, done => store.query({}, {}, (err, res) => done({ err, res })))
    expect(outcome.settled, 'query must now answer instead of hanging').to.equal(true)
    expect(outcome.result.err).to.equal(null)
    expect(outcome.result.res).to.deep.equal([])
  })
})

describe('USER_DS.getorInitDb concurrent init', function () {
  const env = { fsParams: { type: 'local' }, dbParams: { type: 'nedb' } }
  const OAC = { owner: 'u1', app_table: 'com.x.y' }

  it('runs one init for a burst of concurrent callers and hands them all the same ds', async function () {
    const userDs = new USER_DS('u1', env)
    clearTimeout(userDs.dbPersistenceManager.timer)

    let initCount = 0
    userDs.initOacDB = async function (oac) {
      initCount++
      await new Promise(resolve => setTimeout(resolve, 40)) // the window the race used to live in
      this.appcoll['com.x.y'] = { oac, query: async () => [] }
      return this.appcoll['com.x.y']
    }

    const results = await Promise.all(Array.from({ length: 6 }, () => userDs.getorInitDb(OAC, {})))

    expect(initCount, 'each concurrent caller used to start its own init').to.equal(1)
    results.forEach(ds => expect(ds).to.equal(results[0]))
    expect(userDs.appcollInit['com.x.y'], 'in-flight entry must be cleared').to.equal(undefined)
  })

  it('does not remember a failed init - the next caller retries', async function () {
    const userDs = new USER_DS('u1', env)
    clearTimeout(userDs.dbPersistenceManager.timer)

    let attempts = 0
    userDs.initOacDB = async function (oac) {
      attempts++
      if (attempts === 1) throw new Error('storage blip')
      this.appcoll['com.x.y'] = { oac, query: async () => [] }
      return this.appcoll['com.x.y']
    }

    let firstErr = null
    try { await userDs.getorInitDb(OAC, {}) } catch (e) { firstErr = e }
    expect(firstErr).to.be.an('error')
    expect(userDs.appcollInit['com.x.y']).to.equal(undefined)

    const ds = await userDs.getorInitDb(OAC, {})
    expect(attempts).to.equal(2)
    expect(ds.query).to.be.a('function')
  })
})
