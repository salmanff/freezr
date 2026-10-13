// Regression tests for the Recent cache answering paginated empty queries.
//
// An empty query sorted { _date_modified: -1 } is served from the Recent cache,
// which holds at most recentCount rows. Two bugs made pagination over it lie:
//  - a cache-miss fetch for a page (eg count 100, or no count → adapter default
//    of 100) was stored AS the Recent cache, so every later read, whatever its
//    count, was answered from those ~100 rows;
//  - a page beyond what Recent holds (skip + count > rows held) was sliced from
//    Recent and came back short or empty although the rows exist in the DB.

import { expect } from 'chai'
import AppTableCache from '../../../adapters/datastore/cache/appTableCache.mjs'
import { filterRecords } from '../../../adapters/datastore/cache/queryMatcher.mjs'

const RECENT_COUNT = 50 // small cap so the tests stay readable

const fakeInterface = () => {
  const store = new Map()
  return {
    get: (k) => store.has(k) ? store.get(k) : null,
    set: (k, v) => { store.set(k, v); return true },
    delete: (k) => store.delete(k),
    deletePattern: (re) => { for (const k of [...store.keys()]) if (new RegExp(re).test(k)) store.delete(k) },
    getKeys: () => [...store.keys()],
    _store: store
  }
}

// n records, newest first: _date_modified = n, n-1, ... 1
const makeRecords = (n) => Array.from({ length: n }, (_, i) => ({ _id: 'r' + (n - i), _date_modified: n - i, i: n - i }))

const newCache = () => new AppTableCache(fakeInterface(), 'alice', 'app_tbl', { recentCount: RECENT_COUNT })

// A fake DB with `tableSize` rows that honours count/limit/skip/sort like the adapters do
const fakeDb = (tableSize) => {
  const all = makeRecords(tableSize)
  const calls = []
  return {
    calls,
    query_async: async (query, options = {}) => {
      calls.push({ query, options })
      const count = options.count || options.limit || 100 // ARBITRARY_FIND_COUNT_DEFAULT
      return filterRecords(all, query, { ...options, count })
    }
  }
}

// Mirrors ds.query in userDsMgr: cache → (expand) → db → setQuery → slice back
const dsQuery = async (cache, db, query, options = {}) => {
  const cached = await cache.query(query, options)
  if (cached !== null) return { rows: cached, fromCache: true }
  const expandInfo = cache.shouldExpandForCache(query, options)
  const dbOptions = expandInfo.expand ? expandInfo.expandedOptions : options
  const results = await db.query_async(query, dbOptions)
  await cache.setQuery(query, results, dbOptions)
  return { rows: expandInfo.expand ? filterRecords(results, {}, options) : results, fromCache: false }
}

const SORT = { sort: { _date_modified: -1 } }

describe('AppTableCache - Recent cache and paginated empty queries', function () {
  describe('reading from a full Recent cache (table larger than recentCount)', function () {
    let cache
    beforeEach(async () => {
      cache = newCache()
      await cache.setRecent(makeRecords(RECENT_COUNT)) // newest recentCount rows of a bigger table
    })

    it('serves a page that lies inside Recent', async () => {
      const rows = await cache.query({}, { ...SORT, skip: 10, count: 20 })
      expect(rows).to.have.length(20)
      expect(rows[0]._date_modified).to.equal(RECENT_COUNT - 10)
    })

    it('goes to the DB (returns null) for a page that reaches beyond Recent', async () => {
      expect(await cache.query({}, { ...SORT, skip: 40, count: 20 })).to.equal(null)
      expect(await cache.query({}, { ...SORT, skip: RECENT_COUNT, count: 20 })).to.equal(null)
      expect(await cache.query({}, { ...SORT, count: RECENT_COUNT + 1 })).to.equal(null)
    })

    it('treats no-sort empty queries the same way', async () => {
      expect(await cache.query({}, { skip: 0, count: 20 })).to.have.length(20)
      expect(await cache.query({}, { skip: RECENT_COUNT, count: 20 })).to.equal(null)
    })
  })

  describe('reading from a complete Recent cache (whole table fits)', function () {
    it('answers any page, including an empty one past the end', async () => {
      const cache = newCache()
      await cache.setRecent(makeRecords(30))
      expect(await cache.query({}, { ...SORT, skip: 25, count: 20 })).to.have.length(5)
      expect(await cache.query({}, { ...SORT, skip: 100, count: 20 })).to.have.length(0)
    })
  })

  describe('setQuery seeding Recent', function () {
    it('does not seed Recent from a page smaller than recentCount', async () => {
      const cache = newCache()
      await cache.setQuery({}, makeRecords(20), { ...SORT, count: 20 })
      expect(cache._getRecentCache()).to.equal(null)
    })

    it('does not seed Recent from a fetch with no count (adapter-capped page)', async () => {
      const cache = newCache()
      await cache.setQuery({}, makeRecords(100), SORT)
      expect(cache._getRecentCache()).to.equal(null)
    })

    it('seeds Recent from a fetch of recentCount rows', async () => {
      const cache = newCache()
      await cache.setQuery({}, makeRecords(RECENT_COUNT), { ...SORT, count: RECENT_COUNT })
      expect(cache._getRecentCache()).to.have.length(RECENT_COUNT)
    })

    it('seeds Recent from a short page, which means the table is complete', async () => {
      const cache = newCache()
      await cache.setQuery({}, makeRecords(7), { ...SORT, count: 20 })
      expect(cache._getRecentCache()).to.have.length(7)
    })
  })

  describe('shouldExpandForCache for empty queries', function () {
    it('widens a page request to the newest recentCount rows', () => {
      const cache = newCache()
      const info = cache.shouldExpandForCache({}, { count: 10 })
      expect(info.expand).to.equal(true)
      expect(info.expandedOptions).to.deep.include({ count: RECENT_COUNT, skip: 0, sort: { _date_modified: -1 } })
    })

    it('does not widen a page Recent could never serve', () => {
      const cache = newCache()
      expect(cache.shouldExpandForCache({}, { skip: RECENT_COUNT, count: 10 }).expand).to.equal(false)
    })

    it('does not widen non-default sorts', () => {
      const cache = newCache()
      expect(cache.shouldExpandForCache({}, { sort: { _date_modified: 1 }, count: 10 }).expand).to.equal(false)
    })
  })

  describe('end to end through the ds.query flow', function () {
    it('pages through a table larger than recentCount without losing rows', async () => {
      const TABLE = 130
      const cache = newCache()
      const db = fakeDb(TABLE)
      const seen = []
      for (let skip = 0; skip < TABLE + 20; skip += 20) {
        const { rows } = await dsQuery(cache, db, {}, { ...SORT, skip, count: 20 })
        seen.push(...rows.map(r => r._id))
      }
      expect(seen).to.have.length(TABLE)
      expect(new Set(seen).size).to.equal(TABLE)
      // first fetch seeded a full Recent; pages inside it were cache hits
      expect(cache._getRecentCache()).to.have.length(RECENT_COUNT)
      expect(db.calls[0].options.count).to.equal(RECENT_COUNT)
    })

    it('a first read with the default (no) count does not shrink later bigger reads', async () => {
      const cache = newCache()
      const db = fakeDb(500)
      const first = await dsQuery(cache, db, {}, SORT)
      expect(first.rows.length).to.be.at.least(1)
      const second = await dsQuery(cache, db, {}, { ...SORT, count: 200 })
      expect(second.rows).to.have.length(200)
      const third = await dsQuery(cache, db, {}, { ...SORT, skip: 300, count: 100 })
      expect(third.rows).to.have.length(100)
      expect(third.rows[0]._date_modified).to.equal(200)
    })
  })

  describe('_date_modified $gt queries against a partial Recent', function () {
    it('falls through when the page reaches beyond what Recent holds', async () => {
      const cache = newCache()
      // Recent holds rows 100..51 (newest 50 of a 100 row table); query asks for everything newer than 0
      await cache.setRecent(makeRecords(100).slice(0, RECENT_COUNT))
      expect(await cache.query({ _date_modified: { $gt: 0 } }, { ...SORT, count: 20 })).to.have.length(20)
      expect(await cache.query({ _date_modified: { $gt: 0 } }, { ...SORT, skip: 40, count: 20 })).to.equal(null)
    })
  })
})
