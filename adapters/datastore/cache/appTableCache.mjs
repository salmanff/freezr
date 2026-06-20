// freezr.info - AppTable Cache
// Per user:app_table cache wrapper with query intelligence and write debouncing
//
// SECURITY: This class receives a scoped interface from UserCache
// that only allows access to this specific owner:appTable namespace.
// It cannot access other tables' or users' data even if it tries.

import cacheConfig from './cacheConfig.mjs'
import { cmLog } from '../../../common/debug/consoleFlags.mjs'
import {
  hashQuery,
  isDefaultSort,
  isDateModifiedGtQuery,
  isSimpleQuery,
  isCacheableValue,
  matchesCompoundPattern,
  buildQueryFromPattern,
  filterRecords,
  isRecentCacheComplete
} from './queryMatcher.mjs'
import { hasUnifiedStrategy, getRevisedIdWithOatAdded } from '../dbConnectors/mongo_utils.mjs'

class AppTableCache {
  /**
   * @param {Object} scopedInterface - Scoped cache interface from UserCache._createAppTableInterface()
   * @param {string} owner - The user ID (for reference, actual scoping is in the interface)
   * @param {string} appTable - The app_table name (for reference, actual scoping is in the interface)
   * @param {Object} config - Cache configuration
   */
  constructor(scopedInterface, owner, appTable, config = {}) { 
    // Store the scoped interface - NOT the full UserCache
    this._interface = scopedInterface
    this.owner = owner
    this.appTable = appTable
    this.namespace = `${owner}:${appTable}`
    this.config = { ...cacheConfig, ...config }
    
    // Unified DB support: store OAC and dbParams so we can revise _id in queries
    // In unified DB mode, the DB adapter prefixes manual _id values with owner__appTable__
    // but the application queries with the original _id. The cache needs to know how to
    // translate between the two.
    this._oac = config.oac || null
    this._dbParams = config.dbParams ? { dbUnificationStrategy: config.dbParams.dbUnificationStrategy } : null
    this._hasUnifiedStrategy = (this._oac && this._dbParams) 
      ? hasUnifiedStrategy(this._dbParams, this._oac.owner) 
      : false
    
    // Write debouncing
    this.invalidationTimer = null
    
    // Dirty and WIP flags are stored in the shared cache (not local memory)
    // so they are visible across all server instances sharing the same cache.
    // A Proxy intercepts reads/writes and delegates to the cache interface.
    this.dirtyFlags = this._createSharedFlags('dirty')
    this.wipFlags = this._createSharedFlags('wip')
    
    // Cache configuration flags
    this.cacheAll = config.cacheAll || false  // Opt-in for All cache
    this.cacheRecent = config.cacheRecent !== false  // Default true
    
    // Cache patterns for selective invalidation
    // Single fields like 'category' are cached as byKey
    // Compound patterns like ['category', 'author'] are cached as Query
    // Only equality queries with string/number values are cached
    this.cachePatterns = config.cachePatterns || []
    
    // Stats for this specific cache
    this.stats = {
      queries: 0,
      cacheHits: 0,
      dbHits: 0
    }
  }
  
  /**
   * Build a namespaced cache key
   */
  _buildKey(type, ...parts) {
    return `${this.namespace}:${type}:${parts.join(':')}`
  }
  
  /**
   * Create a Proxy-backed flags object that stores values in the shared cache.
   * Reads/writes to .All and .Recent are transparently redirected to cache keys
   * like "owner:appTable:_flags:dirty:All". This makes flags visible across
   * all server instances sharing the same cache backend (e.g. Redis).
   */
  _createSharedFlags(prefix) {
    const cache = this
    return new Proxy({}, {
      get (target, prop) {
        if (prop === 'All' || prop === 'Recent') {
          const key = cache._buildKey('_flags', prefix, prop)
          return cache._interface.get(key) || false
        }
        return undefined
      },
      set (target, prop, value) {
        if (prop === 'All' || prop === 'Recent') {
          const key = cache._buildKey('_flags', prefix, prop)
          if (value) {
            cache._interface.set(key, true, {
              type: '_flags',
              namespace: cache.namespace,
              ttl: 0
            })
          } else {
            cache._interface.delete(key)
          }
          return true
        }
        return true
      }
    })
  }
  
  /**
   * Strip unified DB fields (__owner, __appTable) from a query and
   * revise _id to match the prefixed format used in the DB.
   * In unified DB mode the DB connector injects __owner/__appTable into every query
   * and prefixes manual _id values with owner__appTable__. The cache is already scoped
   * by owner:appTable via the namespace, so __owner/__appTable are redundant.
   * But _id needs to be revised so cache lookups match the DB-stored _id values.
   */
  _stripUnifiedDbFields(query) {
    if (!query || typeof query !== 'object') return query
    
    const needsOwnerStrip = query.__owner || query.__appTable
    const needsIdRevise = this._hasUnifiedStrategy && query._id && typeof query._id === 'string'
    
    if (!needsOwnerStrip && !needsIdRevise) return query
    
    const cleaned = { ...query }
    delete cleaned.__owner
    delete cleaned.__appTable
    
    // In unified DB mode, revise _id to match the prefixed format stored in the DB
    // e.g. 'userId_appName' → 'userId__info_freezr_account_app_list__userId_appName'
    if (needsIdRevise) {
      cleaned._id = getRevisedIdWithOatAdded(cleaned._id, this._oac)
    }
    
    return cleaned
  }
  
  /**
   * Check if query is empty or just a date sort (equivalent to Recent)
   * Only descending _date_modified sorts can be answered by Recent cache —
   * Recent only holds the newest N records, so ascending ("oldest first")
   * queries must fall through to All cache or DB.
   */
  _isEmptyOrDateSort(query, options) {
    // Empty query
    if (!query || Object.keys(query).length === 0) {
      if (!options?.sort) return true
      if (options?.sort &&
          Object.keys(options.sort).length === 1 &&
          options.sort._date_modified === -1) {
        return true
      }
    }

    return false
  }
  
  /**
   * Check if cache is work-in-progress and optionally wait
   * Returns true if WIP, false if ready
   */
  async _checkWIP(options = {}) {
    if (!options) options = {}
    const waitForInit = options.waitForInit !== false  // Default true
    const maxWaitMs = options.maxWaitMs || 5000  // Default 5 seconds
    
    if (!this.wipFlags.All && !this.wipFlags.Recent) {
      return false  // Not WIP
    }
    
    if (!waitForInit) {
      return true  // WIP and not waiting
    }
    
    // Wait a bit for initialization to complete
    const startTime = Date.now()
    const checkInterval = 50  // Check every 50ms
    
    while ((Date.now() - startTime) < maxWaitMs) {
      if (!this.wipFlags.All && !this.wipFlags.Recent) {
        // onsole.log('📦 Cache WIP cleared after wait', { waitedMs: Date.now() - startTime })
        return false  // WIP cleared
      }
      await new Promise(resolve => setTimeout(resolve, checkInterval))
    }
    
    // Still WIP after waiting - return true to query DB directly
    // onsole.log('📦 Cache still WIP after wait - querying DB directly', { waitedMs: Date.now() - startTime })
    return true
  }
  
  /**
   * Query with intelligent cache lookup
   * Returns cached results or null (caller should hit DB)
   */
  async query(query, options = {}) {
    this.stats.queries++
    
    // Strip unified DB fields - cache is already scoped by owner:appTable
    query = this._stripUnifiedDbFields(query)
    
    // Check WIP status - if still WIP after optional wait, query DB directly
    const isWIP = await this._checkWIP(options)
    if (isWIP) {
      this.stats.dbHits++
      // console.warn('🔴 Cache WIP - cahche filling is taking too long for', { query, owner: this.owner, appTable: this.appTable } )
      cmLog('C-M ⏳⏳⏳⏳⏳ CACHE WIP - cache filling taking too long, going to DB', { table: this.appTable, query })
      return null
    }
    
    // Check if this is empty query or just date sort
    if (this._isEmptyOrDateSort(query, options)) {
      // onsole.log('📦 Cache - got an empty or date sort query', { query, options } )
      return await this._queryEmptyOrDateSort(query, options)
    }
    
    // Check if this is a simple query (single field equality)
    const simpleCheck = isSimpleQuery(query)
    if (simpleCheck.isSimple) {
      // onsole.log('📦 Cache - got a simple query and returning from byKey query ', { field: simpleCheck.field, value: simpleCheck.value, query } )
      return await this._queryByKey(simpleCheck.field, simpleCheck.value, query, options)
    }
    
    // Check if this is a _date_modified $gt query
    const dateCheck = isDateModifiedGtQuery(query)
    if (dateCheck.isDateQuery && !dateCheck.hasOtherConditions) {
      // onsole.log('📦 Cache - got a simple date query', { query, options } )
      return await this._queryByDate(dateCheck.timestamp, query, options)
    }
    
    // General query
    const gq = await this._queryGeneral(query, options)
    // onsole.log('📦 Cache - returning general query', { query, options, gqlen: gq?.length } )
    return gq
  }
  
  /**
   * Query for empty queries or date sorts
   * Flow: Recent → All → null
   */
  async _queryEmptyOrDateSort(query, options) {
    // Check WIP flags - if cache is being populated, query DB directly
    if (this.wipFlags.Recent || (this.cacheAll && this.wipFlags.All)) {
      // onsole.log('📦 Cache WIP - querying DB directly for empty/date sort query', { wipRecent: this.wipFlags.Recent, wipAll: this.wipFlags.All })
      cmLog('C-M ⏳⏳⏳⏳⏳ CACHE WIP - empty/date query going to DB', { table: this.appTable, wipRecent: this.wipFlags.Recent, wipAll: this.wipFlags.All, owner: this.owner })
      this.stats.dbHits++
      return null
    }
    
    // 1. Check Recent cache first (fast, already sorted)
    const recentRecords = this._getRecentCache()
    if (recentRecords !== null) {
      const filtered = filterRecords(recentRecords, query, options)
      this.stats.cacheHits++
      cmLog('C-M 🟢🟢🟢🟢🟢 CACHE HIT (Recent) - empty/date query', { table: this.appTable, resultCount: filtered?.length, owner: this.owner })
      return filtered
    }
    
    // 2. Check All cache if Recent doesn't exist
    if (this.cacheAll) {
      const allRecords = this._getAllCache()
      if (allRecords !== null) {
        const filtered = filterRecords(allRecords, query, options)
        this.stats.cacheHits++
        cmLog('C-M 🟢🟢🟢🟢🟢 CACHE HIT (All) - empty/date query', { table: this.appTable, resultCount: filtered?.length })
        return filtered
      }
    }
    
    // 3. Cache miss - caller should hit DB
    this.stats.dbHits++
    cmLog('C-M 🔵🔵🔵🔵🔵 CACHE MISS - empty/date query going to DB', { table: this.appTable })
    return null
  }
  
  /**
   * Query by simple field (e.g., _id, status, etc.)
   * Flow: byKey → All (authoritative) → Recent → Query cache → null
   */
  async _queryByKey(field, value, query, options) {
    // Check WIP flags - if All cache is being populated, don't trust it yet
    if (this.cacheAll && this.wipFlags.All) {
      // onsole.log('📦 Cache WIP - querying DB directly for byKey query', { field, value, wipAll: this.wipFlags.All })
      cmLog('C-M ⏳⏳⏳⏳⏳ CACHE WIP - byKey query going to DB', { table: this.appTable, field, value })
      
      this.stats.dbHits++
      return null
    }
    
    // 1. Check byKey cache
    // The cached array is the canonical record set in default order.
    // Re-apply caller's sort/skip/count in memory. If the request reaches
    // beyond the cached window, fall through to DB (cache may be saturated
    // at cacheCountMax with more rows behind it).
    const byKeyResult = this.getByKey(field, value)
    if (byKeyResult !== null) {
      const skip = options?.skip || 0
      const count = options?.count || options?.limit || 0
      if (count && (skip + count > byKeyResult.length)) {
        cmLog('C-M 🔵🔵🔵🔵🔵 CACHE INSUFFICIENT (byKey) - have', byKeyResult.length, 'need', skip + count, { table: this.appTable, field, value })
      } else {
        this.stats.cacheHits++
        cmLog('C-M 🟢🟢🟢🟢🟢 CACHE HIT (byKey)', { table: this.appTable, field, value, resultCount: Array.isArray(byKeyResult) ? byKeyResult.length : 1 })
        return filterRecords(byKeyResult, {}, options)
      }
    }
    
    // 2. Check All cache (if exists, it's authoritative)
    if (this.cacheAll) {
      const allRecords = this._getAllCache()
      if (allRecords !== null) {
        const filtered = filterRecords(allRecords, query, options)
        // onsole.log('📦 Cache - got a simple query byKey miss - All cache', { field, value, query, allRecordsLen: allRecords?.length, filteredLen: filtered?.length } )
        this.stats.cacheHits++
        cmLog('C-M 🟢🟢🟢🟢🟢 CACHE HIT (All) - byKey fallback', { table: this.appTable, field, value, resultCount: filtered?.length })
        return filtered  // If All exists and no match, return empty (don't check DB)
      }
    }
    
    // 3. Check Recent cache
    // Recent only holds the newest N records, so it can only answer
    // queries whose sort is compatible with that natural order
    // (no sort, or _date_modified: -1). Ascending or other sorts must skip Recent.
    const recentRecords = this._getRecentCache()
    const count = options?.count || options?.limit || (this.config.cacheCountMax || 1000)
    if (!options?.count && !options?.limit) console.warn('NO OPTIONS COUNT OR LIMIT ', { options })
    if (recentRecords !== null && isDefaultSort(options?.sort)) {
      const filtered = filterRecords(recentRecords, query, options)
      if (filtered.length >= count) {
        this.stats.cacheHits++
        cmLog('C-M 🟢🟢🟢🟢🟢 CACHE HIT (Recent) - byKey fallback', { table: this.appTable, field, value, resultCount: filtered.length, owner: this.owner })
        return filtered
      }
      // If not in Recent, continue to Query cache (might be older record)
    }
    
    // 4. Check Query cache
    const queryResult = this._getQueryCache(query, options)
    if (queryResult !== null) {
      this.stats.cacheHits++
      // onsole.log('📦 Cache query Query - this should have been caufght by key query key snbh ?? ', { query, options, queryResult } )
      cmLog('C-M 🟢🟢🟢🟢🟢 CACHE HIT (Query) - byKey fallback', { table: this.appTable, field, value, owner: this.owner })
      
      return queryResult
    }
    
    // 5. Cache miss - caller should hit DB
    this.stats.dbHits++
    cmLog('C-M 🔵🔵🔵🔵🔵 CACHE MISS - byKey query going to DB', { table: this.appTable, field, value })
    return null
  }
  
  /**
   * Query by _date_modified $gt
   * Flow: Recent (if complete, authoritative) → All → null
   */
  async _queryByDate(timestamp, query, options) {
    // Check WIP flags - if cache is being populated, query DB directly
    if (this.wipFlags.Recent || (this.cacheAll && this.wipFlags.All)) {
      // onsole.log('📦 Cache WIP - querying DB directly for date query', { wipRecent: this.wipFlags.Recent, wipAll: this.wipFlags.All })
      cmLog('C-M ⏳⏳⏳⏳⏳ CACHE WIP - date query going to DB', { table: this.appTable, timestamp })
      
      this.stats.dbHits++
      return null
    }
    
    // 1. Check Recent cache - it can be authoritative for date queries
    const recentRecords = this._getRecentCache()
    if (recentRecords !== null) {
      // Check if Recent cache is complete AND covers this timestamp
      if (isRecentCacheComplete(recentRecords, timestamp)) {
        // Recent cache is complete - can answer definitively
        const filtered = filterRecords(recentRecords, query, options)
        this.stats.cacheHits++
        cmLog('C-M 🟢🟢🟢🟢🟢 CACHE HIT (Recent-complete) - date query', { table: this.appTable, timestamp, resultCount: filtered?.length })
        return filtered
      }
      // Recent cache exists but doesn't cover this timestamp
      // Still return what we have if it matches
      const filtered = filterRecords(recentRecords, query, options)
      if (filtered.length > 0) {
        this.stats.cacheHits++
        cmLog('C-M 🟢🟢🟢🟢🟢 CACHE HIT (Recent-partial) - date query', { table: this.appTable, timestamp, resultCount: filtered.length })
        return filtered
      }
    }
    
    // 2. Check All cache if Recent doesn't have it
    if (this.cacheAll) {
      const allRecords = this._getAllCache()
      if (allRecords !== null) {
        const filtered = filterRecords(allRecords, query, options)
        this.stats.cacheHits++
        cmLog('C-M 🟢🟢🟢🟢🟢 CACHE HIT (All) - date query', { table: this.appTable, timestamp, resultCount: filtered?.length })
        return filtered  // All is authoritative
      }
    }
    
    // 3. Cache miss - caller should hit DB
    this.stats.dbHits++
    cmLog('C-M 🔵🔵🔵🔵🔵 CACHE MISS - date query going to DB', { table: this.appTable, timestamp })
    return null
  }
  
  /**
   * General query
   * Flow: Query cache → All (authoritative) → null
   */
  async _queryGeneral(query, options) {
    // CRITICAL: Check WIP flag - if All cache is being populated, query DB directly
    // This prevents querying a partially populated All cache
    if (!options) options = {}
    if (this.cacheAll && this.wipFlags.All) {
      // onsole.log('📦 Cache WIP - querying DB directly for general query (All cache being populated)', { wipAll: this.wipFlags.All })
      cmLog('C-M ⏳⏳⏳⏳⏳ CACHE WIP - general query going to DB', { table: this.appTable, query })
      
      this.stats.dbHits++
      return null
    }
    
    // 1. Check Query cache
    const queryResult = this._getQueryCache(query, options)
    if (queryResult !== null) {
      this.stats.cacheHits++
      cmLog('C-M 🟢🟢🟢🟢🟢 CACHE HIT (Query) - general query', { table: this.appTable, query })
      return queryResult
    }
    
    // 2. Check All cache (if exists, it's authoritative)
    if (this.cacheAll) {
      const allRecords = this._getAllCache()
      if (allRecords !== null) {
        const filtered = filterRecords(allRecords, query, options)
        this.stats.cacheHits++
        cmLog('C-M 🟢🟢🟢🟢🟢 CACHE HIT (All) - general query', { table: this.appTable, resultCount: filtered?.length })
        return filtered  // All is authoritative - don't check DB
      }
    }
    
    // 3. Cache miss - caller should hit DB
    this.stats.dbHits++
    cmLog('C-M 🔵🔵🔵🔵🔵 CACHE MISS - general query going to DB', { table: this.appTable, query })
    return null
  }
  
  /**
   * Store query results in cache
   * If empty query, store in Recent instead of Query cache
   * Only caches queries that match declared cachePatterns
   */
  async setQuery(query, results, options = {}) {
    // Strip unified DB fields - cache is already scoped by owner:appTable
    query = this._stripUnifiedDbFields(query)

    // Don't cache results from non-default-sort or skip>0 fetches.
    // The cache stores canonical record sets in default order; a sliced or
    // re-ordered result would poison future reads for this key.
    if (!isDefaultSort(options?.sort) || (options?.skip || 0) > 0) {
      cmLog('C-M ⚪⚪⚪⚪⚪ CACHE SKIP - non-default sort or skip>0', { table: this.appTable, sort: options?.sort, skip: options?.skip })
      return false
    }

    // Check if this is an empty query or date sort - store in Recent
    if (this._isEmptyOrDateSort(query, options)) {
      await this.setRecent(results)
      return true
    }

    // Check for simple single-field equality query (stored as byKey)
    const simpleCheck = isSimpleQuery(query, options)
    if (simpleCheck.isSimple) {
      // Only cache if field is in cachePatterns (as single field, not in array)
      // onsole.log('📦 Cache setQuery Simple - cachePatterns', { cachePatterns: this.cachePatterns, field: simpleCheck.field, table: this.namespace })
      const fieldPattern = this.cachePatterns.find(p => p === simpleCheck.field)
      if (fieldPattern) {
        // onsole.log('📦 Cache has fieldPattern setQuery Simple (byKey)', { field: simpleCheck.field, value: simpleCheck.value })
        cmLog('C-M 📦📦📦📦📦 CACHE SET (byKey from query)', { table: this.appTable, field: simpleCheck.field, value: simpleCheck.value, resultCount: results?.length })
        await this.setByKey(simpleCheck.field, simpleCheck.value, results)
        return true
      } else {
        // onsole.log('📦 Cache setQuery Simple - field not in cachePatterns, skipping', { field: simpleCheck.field, cachePatterns: this.cachePatterns })
        cmLog('C-M ⚪⚪⚪⚪⚪ CACHE SKIP - field not in cachePatterns', { table: this.appTable, fieldPattern, field: simpleCheck.field, allPatterns: this.cachePatterns, owner: this.owner })
        return false
      }
    }
    
    // Check for compound pattern match (multi-field equality query)
    const patternCheck = matchesCompoundPattern(query, this.cachePatterns, options)
    if (patternCheck.matches) {
      // onsole.log('📦 Cache setQuery Compound', { pattern: patternCheck.pattern, query })
      cmLog('C-M 📦📦📦📦📦 CACHE SET (Query compound)', { table: this.appTable, pattern: patternCheck.pattern, resultCount: results?.length })
      // Key uses separate query hash + sort hash so invalidation can match by query alone
      const queryHash = hashQuery(query, {})
      const sortHash = options?.sort ? hashQuery({}, { sort: options.sort }) : 'nosort'
      const key = this._buildKey('Query', queryHash, sortHash)
      
      this._interface.set(key, results, {
        type: 'Query',
        namespace: this.namespace,
        ttl: this.config.ttl.Query
      })
      return true
    }
    
    // Query doesn't match any pattern - don't cache
    // onsole.log('📦 Cache setQuery - no matching pattern, skipping', { query, cachePatterns: this.cachePatterns })
    cmLog('C-M ⚪⚪⚪⚪⚪ CACHE SKIP - no matching pattern (3)', { table: this.appTable, query, cachePatterns: this.cachePatterns, owner: this.owner })
    return false
  }
  
  /**
   * Get from Query cache
   * Hash by query only (no options) to match setQuery behavior.
   * Apply sort/skip/limit in memory from cached full result set.
   */
  _getQueryCache(query, options = {}) {
    // Key uses separate query hash + sort hash (matches setQuery structure)
    const queryHash = hashQuery(query, {})
    const sortHash = options?.sort ? hashQuery({}, { sort: options.sort }) : 'nosort'
    const key = this._buildKey('Query', queryHash, sortHash)
    const cached = this._interface.get(key)
    if (cached === null) return null

    // Check if cached results can satisfy this request
    const skip = options.skip || 0
    const count = options.count || options.limit || 0
    if (count && (skip + count > cached.length)) {
      // Not enough cached data to serve this request
      cmLog('C-M 🔵🔵🔵🔵🔵 CACHE INSUFFICIENT - Query cache has', cached.length, 'but need', skip + count, { table: this.appTable, owner: this.owner })
      return null
    }

    // Apply sort/skip/limit in memory
    return filterRecords(cached, {}, options)
  }
  
  /**
   * Get a record by key (e.g., _id, status, etc.)
   */
  getByKey(keyName, keyValue) {
    const key = this._buildKey('byKey', keyName, keyValue)
    return this._interface.get(key)
  }
  
  /**
   * Set a record by key
   * Only accepts string or number values (cacheable types)
   */
  setByKey(keyName, keyValue, record) {
    // Validate keyValue is cacheable (string or number)
    if (!isCacheableValue(keyValue)) {
      // onsole.log('📦 Cache setByKey - value not cacheable, skipping', { keyName, keyValueType: typeof keyValue })
      return false
    }
    
    const key = this._buildKey('byKey', keyName, keyValue)
    this._interface.set(key, record, {
      type: 'byKey',
      namespace: this.namespace,
      ttl: this.config.ttl.byKey
    })
    return true
  }
  
  /**
   * Delete a record by key
   */
  deleteByKey(keyName, keyValue) {
    const key = this._buildKey('byKey', keyName, keyValue)
    this._interface.delete(key)
    return true
  }
  
  /**
   * Get All cache
   * Returns null if cache is disabled, dirty, or not found
   */
  _getAllCache() {
    if (!this.cacheAll) return null
    if (this.dirtyFlags.All) return null  // Don't return stale data
    const key = this._buildKey('All')
    return this._interface.get(key)
  }
  
  /**
   * Set All cache
   */
  async setAll(records) {
    if (!this.cacheAll) return false
    
    const key = this._buildKey('All')
    this._interface.set(key, records, {
      type: 'All',
      namespace: this.namespace,
      ttl: this.config.ttl.All,
      priority: this.config.evictionPriority.All
    })
    
    // Clear WIP and dirty flags after All cache is populated
    this.wipFlags.All = false
    this.dirtyFlags.All = false
    // onsole.log('✅ All cache populated and WIP flag cleared for ' + this.namespace, { recordCount: records?.length })
    cmLog('C-M 📦📦📦📦📦 CACHE POPULATED (All)', { table: this.appTable, recordCount: records?.length, owner: this.owner })

    return true
  }
  
  /**
   * Get Recent cache
   * Returns null if cache is disabled, dirty, or not found
   */
  _getRecentCache() {
    if (!this.cacheRecent) return null
    if (this.dirtyFlags.Recent) return null  // Don't return stale data
    const key = this._buildKey('Recent')
    return this._interface.get(key)
  }
  
  /**
   * Set Recent cache
   */
  async setRecent(records) {
    if (!this.cacheRecent) return false
    
    // Ensure records are sorted by _date_modified descending
    const sorted = [...records].sort((a, b) => 
      (b._date_modified || 0) - (a._date_modified || 0)
    )
    
    // Limit to configured count
    const limited = sorted.slice(0, this.config.recentCount)
    
    const key = this._buildKey('Recent')
    this._interface.set(key, limited, {
      type: 'Recent',
      namespace: this.namespace,
      ttl: this.config.ttl.Recent,
      priority: this.config.evictionPriority.Recent
    })
    
    // Clear WIP and dirty flags after Recent cache is populated
    this.wipFlags.Recent = false
    this.dirtyFlags.Recent = false
    // onsole.log('✅ Recent cache populated and WIP flag cleared', { namespace: this.namespace, recordCount: limited?.length })
    cmLog('C-M 📦📦📦📦📦 CACHE POPULATED (Recent)', { table: this.appTable, recordCount: limited?.length })
  
    return true
  }
  
  /**
   * Get an app file from cache
   */
  getAppFile(filePath) {
    const key = this._buildKey('appFiles', filePath)
    return this._interface.get(key)
  }
  
  /**
   * Set an app file in cache
   */
  setAppFile(filePath, content) {
    // Don't cache files larger than threshold
    const size = Buffer.isBuffer(content) ? content.length : 
                 typeof content === 'string' ? content.length * 2 : 0
    
    if (size > this.config.maxFileSize) {
      return false
    }
    
    const key = this._buildKey('appFiles', filePath)
    this._interface.set(key, content, {
      type: 'appFiles',
      namespace: this.namespace,
      ttl: this.config.ttl.appFiles
    })
    
    return true
  }
  
  /**
   * Delete an app file from cache
   */
  deleteAppFile(filePath) {
    const key = this._buildKey('appFiles', filePath)
    this._interface.delete(key)
    return true
  }
  
  /**
   * Get a user file from cache
   */
  getUserFile(filePath) {
    const key = this._buildKey('userFiles', filePath)
    return this._interface.get(key)
  }
  
  /**
   * Set a user file in cache
   */
  setUserFile(filePath, content) {
    // Don't cache files larger than threshold
    const size = Buffer.isBuffer(content) ? content.length : 
                 typeof content === 'string' ? content.length * 2 : 0
    
    if (size > this.config.maxFileSize) {
      return false
    }
    
    const key = this._buildKey('userFiles', filePath)
    this._interface.set(key, content, {
      type: 'userFiles',
      namespace: this.namespace,
      ttl: this.config.ttl.userFiles
    })
    
    return true
  }
  
  /**
   * Delete a user file from cache
   */
  deleteUserFile(filePath) {
    const key = this._buildKey('userFiles', filePath)
    this._interface.delete(key)
    return true
  }
  
  // ==================== FILE MOD TIME METHODS ====================
  // These track file modification times in the shared cache for multi-server consistency
  // When a file is written on one server, other servers can detect this and re-fetch
  
  /**
   * Get the modification time for an app file from shared cache
   * @param {string} filePath - The file path
   * @returns {number|null} - Timestamp or null if not found
   */
  getAppFileModTime(filePath) {
    const key = this._buildKey('appFileModTime', filePath)
    return this._interface.get(key)
  }
  
  /**
   * Set the modification time for an app file in shared cache
   * Called when a file is written or updated
   * @param {string} filePath - The file path
   * @param {number} timestamp - The modification timestamp (defaults to now)
   */
  setAppFileModTime(filePath, timestamp = Date.now()) {
    const key = this._buildKey('appFileModTime', filePath)
    this._interface.set(key, timestamp, {
      type: 'appFileModTime',
      namespace: this.namespace,
      ttl: 0  // No TTL - we want this to persist
    })
    return true
  }
  
  /**
   * Invalidate the modification time for an app file (on file removal/update)
   * Setting to current time signals to other servers that the file changed
   * @param {string} filePath - The file path
   */
  invalidateAppFileModTime(filePath) {
    // Set to current time to signal file was removed/changed
    // Other servers will re-fetch and get a 404 or updated content
    return this.setAppFileModTime(filePath, Date.now())
  }
  
  /**
   * Get the modification time for a user file from shared cache
   * @param {string} filePath - The file path
   * @returns {number|null} - Timestamp or null if not found
   */
  getUserFileModTime(filePath) {
    const key = this._buildKey('userFileModTime', filePath)
    return this._interface.get(key)
  }
  
  /**
   * Set the modification time for a user file in shared cache
   * Called when a file is written or updated
   * @param {string} filePath - The file path
   * @param {number} timestamp - The modification timestamp (defaults to now)
   */
  setUserFileModTime(filePath, timestamp = Date.now()) {
    const key = this._buildKey('userFileModTime', filePath)
    this._interface.set(key, timestamp, {
      type: 'userFileModTime',
      namespace: this.namespace,
      ttl: 0  // No TTL - we want this to persist
    })
    return true
  }
  
  /**
   * Invalidate the modification time for a user file (on file removal/update)
   * Setting to current time signals to other servers that the file changed
   * @param {string} filePath - The file path
   */
  invalidateUserFileModTime(filePath) {
    // Set to current time to signal file was removed/changed
    // Other servers will re-fetch and get a 404 or updated content
    return this.setUserFileModTime(filePath, Date.now())
  }
  
  // ==================== END FILE MOD TIME METHODS ====================
  
  // ==================== FILE TOKEN METHODS ====================
  // These manage file access tokens in the shared cache for multi-server support
  // File tokens allow secure access to user files without requiring full authentication
  // Structure: { token: timestamp } - multiple tokens per file path, with expiry
  
  /**
   * Invalidate cache entries for a specific record based on cachePatterns
   * Called with old and/or new record data to precisely invalidate affected caches
   * 
   * @param {Object} oldRecord - The record before update (null for creates)
   * @param {Object} newRecord - The record after update (null for deletes)
   */
  invalidateForRecord(oldRecord, newRecord) {
    // onsole.log('🔄 cache invalidateForRecord', { table: this.namespace, hasOld: !!oldRecord, hasNew: !!newRecord })
    cmLog('C-M 🗑️🗑️🗑️🗑️🗑️ CACHE INVALIDATE (record)', { table: this.appTable, hasOld: !!oldRecord, hasNew: !!newRecord })

    // Collect all values to invalidate (from both old and new records)
    const toInvalidate = {
      byKey: new Set(),   // Set of "field:value" strings
      queries: new Set()  // Set of query hashes
    }
    
    const records = [oldRecord, newRecord].filter(Boolean)
    
    for (const record of records) {
      for (const pattern of this.cachePatterns) {
        if (Array.isArray(pattern)) {
          // Compound pattern - invalidate Query cache
          const query = buildQueryFromPattern(record, pattern)
          if (query) {
            const queryHash = hashQuery(query, {})
            toInvalidate.queries.add(queryHash)  // Query hash only - will pattern-match all sort variants
            // onsole.log('🔄 invalidateForRecord - compound pattern', { pattern, query, queryHash })
          }
        } else {
          // Single field pattern - invalidate byKey cache
          const value = record[pattern]
          if (isCacheableValue(value)) {
            toInvalidate.byKey.add(`${pattern}:${value}`)
            // onsole.log('🔄 invalidateForRecord - single pattern', { field: pattern, value })
          }
        }
      }
      
      // Always invalidate _id byKey if present
      if (record._id && isCacheableValue(record._id)) {
        toInvalidate.byKey.add(`_id:${record._id}`)
      }
    }
    
    // Delete all collected byKey entries
    for (const keyStr of toInvalidate.byKey) {
      const [field, ...valueParts] = keyStr.split(':')
      const value = valueParts.join(':')  // Handle values with colons
      this.deleteByKey(field, value)
    }
    
    // Delete all collected Query entries (pattern-match to catch all sort variants)
    for (const queryHash of toInvalidate.queries) {
      const keyPrefix = this._buildKey('Query', queryHash)
      this._interface.deletePattern(`^${keyPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
      // onsole.log('🔄 invalidateForRecord - deleted query cache', { keyPrefix })
    }
    
    return {
      byKeyDeleted: toInvalidate.byKey.size,
      queriesDeleted: toInvalidate.queries.size
    }
  }
  
  /**
   * Mark cache as dirty and schedule refresh
   * Called after create/update/delete operations
   * 
   * @param {string} recordId - The record ID (optional, for backward compatibility)
   * @param {Object} oldRecord - The record before update (null for creates)
   * @param {Object} newRecord - The record after update (null for deletes)
   */
  markDirty(recordId = null, oldRecord = null, newRecord = null) {
    cmLog('C-M 🗑️🗑️🗑️🗑️🗑️ CACHE MARKED DIRTY', { table: this.appTable, recordId, hasPatterns: this.cachePatterns.length > 0 })
    
    // If we have cachePatterns and record data, use precise invalidation
    if (this.cachePatterns.length > 0 && (oldRecord || newRecord)) {
      this.invalidateForRecord(oldRecord, newRecord)
    } else {
      // Fallback: delete by recordId if provided
      if (recordId) {
        this.deleteByKey('_id', recordId)
      }
      
      // Without record data we can't do precise pattern invalidation,
      // so conservatively invalidate all Query and byKey pattern entries
      this._interface.deletePattern(`^${this.namespace}:Query:`)
      if (this.cachePatterns.length > 0) {
        this._interface.deletePattern(`^${this.namespace}:byKey:`)
      }
    }
    
    // Mark All and Recent as dirty (they need refresh regardless)
    this.dirtyFlags.All = true
    this.dirtyFlags.Recent = true
    
    // Schedule debounced refresh
    this._scheduleRefresh()
  }
  
  /**
   * Schedule a debounced refresh of All/Recent caches
   */
  _scheduleRefresh() {
    // Clear existing timer
    if (this.invalidationTimer) {
      clearTimeout(this.invalidationTimer)
    }
    
    // Set new timer
    this.invalidationTimer = setTimeout(() => {
      // onsole.log('🔄 cache _scheduleRefresh from appTableCache.mjs', { table: this.namespace, delay: this.config.invalidationDelay })
      this._executeRefresh()
    }, this.config.invalidationDelay)
  }
  
  /**
   * Execute the refresh (called after debounce delay)
   * This should be overridden by the caller to provide DB query function
   */
  async _executeRefresh() {
    // This is a placeholder - the actual refresh needs DB access
    // The caller (ds_manager integration) should provide a refreshFunction
    if (this.refreshFunction) {
      try {
        // onsole.log('🔄 cache _executeRefresh from appTableCache.mjs', { table: this.namespace, dirtyFlags: this.dirtyFlags })
        cmLog('C-M 🔄🔄🔄🔄🔄 CACHE REFRESH (debounced)', { table: this.appTable, dirtyAll: this.dirtyFlags.All, dirtyRecent: this.dirtyFlags.Recent })
        await this.refreshFunction(this.dirtyFlags)
        this.dirtyFlags.All = false
        this.dirtyFlags.Recent = false
      } catch (err) {
        console.warn('🔄 cache - Error refreshing cache:', err.message)
        console.warn('🔴 CACHE REFRESH ERROR:', err.message)
      }
    }
  }
  
  /**
   * Trigger immediate cache initialization (for cacheAll/cacheRecent on init)
   * Sets WIP flags and calls refresh function immediately
   */
  async initializeCache() {
    if (!this.refreshFunction) {
      console.warn('⚠️ Cannot initialize cache - no refreshFunction set')
      return false
    }
    
    // Mark as dirty to trigger refresh
    const needsAll = this.cacheAll && !this._getAllCache()
    const needsRecent = this.cacheRecent && !this._getRecentCache()
    
    if (needsAll || needsRecent) {
      // Set WIP flags before starting
      if (needsAll) {
        this.wipFlags.All = true
        this.dirtyFlags.All = true
        // onsole.log('🔄 Initializing All cache - WIP flag set')
        cmLog('C-M ⏳⏳⏳⏳⏳ CACHE INIT START (All)', { table: this.appTable, owner: this.owner })
      }
      if (needsRecent) {
        this.wipFlags.Recent = true
        this.dirtyFlags.Recent = true
        // onsole.log('🔄 Initializing Recent cache - WIP flag set')
        cmLog('C-M ⏳⏳⏳⏳⏳ CACHE INIT START (Recent)', { table: this.appTable, owner: this.owner })
      }
      
      // Trigger immediate refresh (no debounce)
      try {
        await this.refreshFunction(this.dirtyFlags)
        // WIP flags will be cleared in setAll/setRecent
      } catch (err) {
        console.warn('🔴 Error initializing cache:', err.message)
        // Clear WIP flags on error
        if (needsAll) this.wipFlags.All = false
        if (needsRecent) this.wipFlags.Recent = false
        throw err
      }
    }
    
    return true
  }
  
  /**
   * Check if a query should be expanded to cacheCountMax for caching.
   * Called by the query layer (userDsMgr) BEFORE hitting the DB on a cache miss.
   * If the query matches a cacheable pattern and options are within range,
   * signals the caller to fetch up to cacheCountMax so we can cache a full result set.
   * 
   * @param {Object} query - The query object (already stripped of unified DB fields)
   * @param {Object} options - The original query options
   * @returns {Object} { expand: boolean, expandedOptions: Object|null }
   */
  shouldExpandForCache(query, options = {}) {
    if (!options) options = {}
    const cacheCountMax = this.config.cacheCountMax || 1000

    // Don't expand if sort is non-default — the cached set must be in canonical
    // (default) order so future paginated reads with any sort can be served correctly.
    if (!isDefaultSort(options.sort)) {
      return { expand: false }
    }

    // Don't expand if skip + count already exceeds cacheCountMax
    const skip = options.skip || 0
    const count = options.count || options.limit || 0
    if (count && (skip + count > cacheCountMax)) {
      return { expand: false }
    }

    // Check if query matches a simple pattern (single field equality)
    const simpleCheck = isSimpleQuery(query, options)
    if (simpleCheck.isSimple) {
      const fieldPattern = this.cachePatterns.find(p => p === simpleCheck.field)
      if (fieldPattern) {
        return {
          expand: true,
          expandedOptions: { ...options, count: cacheCountMax, skip: 0 }
        }
      }
    }

    // Check if query matches a compound pattern
    const patternCheck = matchesCompoundPattern(query, this.cachePatterns, options)
    if (patternCheck.matches) {
      return {
        expand: true,
        expandedOptions: { ...options, count: cacheCountMax, skip: 0 }
      }
    }

    return { expand: false }
  }
  
  /**
   * Set the refresh function (called by ds_manager integration)
   */
  setRefreshFunction(fn) {
    // onsole.log('🔄 setRefreshFunction from appTableCache.mjs')
    this.refreshFunction = fn
  }
  
  /**
   * Invalidate entire cache for this app_table
   */
  invalidateAll() {
    cmLog('C-M 🗑️🗑️🗑️🗑️🗑️ CACHE INVALIDATE ALL', { table: this.appTable, owner: this.owner })
    this._interface.deletePattern(`^${this.namespace}:`)
    this.dirtyFlags.All = false
    this.dirtyFlags.Recent = false
    return true
  }
  
  /**
   * Get cache statistics for this app_table
   */
  getStats() {
    const allKeys = this._interface.getKeys(`^${this.namespace}:`)
    
    const byType = {
      appFiles: 0,
      userFiles: 0,
      byKey: 0,
      Query: 0,
      Recent: 0,
      All: 0
    }
    
    allKeys.forEach(key => {
      const parts = key.split(':')
      const type = parts[2]
      if (byType[type] !== undefined) {
        byType[type]++
      }
    })
    
    return {
      namespace: this.namespace,
      totalKeys: allKeys.length,
      queries: this.stats.queries,
      cacheHits: this.stats.cacheHits,
      dbHits: this.stats.dbHits,
      hitRate: this.stats.cacheHits / this.stats.queries || 0,
      byType,
      cacheAll: this.cacheAll,
      cacheRecent: this.cacheRecent,
      cachePatterns: this.cachePatterns
    }
  }
}

export default AppTableCache
