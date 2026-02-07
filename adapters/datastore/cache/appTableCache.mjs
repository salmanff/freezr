// freezr.info - AppTable Cache
// Per user:app_table cache wrapper with query intelligence and write debouncing
//
// SECURITY: This class receives a scoped interface from UserCache
// that only allows access to this specific owner:appTable namespace.
// It cannot access other tables' or users' data even if it tries.

import cacheConfig from './cacheConfig.mjs'
import {
  hashQuery,
  isDateModifiedGtQuery,
  isSimpleQuery,
  isCacheableValue,
  matchesCompoundPattern,
  buildQueryFromPattern,
  filterRecords,
  isRecentCacheComplete
} from './queryMatcher.mjs'

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
    
    // Write debouncing
    this.invalidationTimer = null
    this.dirtyFlags = {
      All: false,
      Recent: false
    }
    
    // Work In Progress flags - track when cache is being populated
    this.wipFlags = {
      All: false,      // Set to true when All cache is being populated
      Recent: false    // Set to true when Recent cache is being populated
    }
    
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
   * Check if query is empty or just a date sort (equivalent to Recent)
   */
  _isEmptyOrDateSort(query, options) {
    // Empty query
    if (!query || Object.keys(query).length === 0) {
      if (!options?.sort) return true
      // Only has _date_modified sort
      if (options?.sort && 
          Object.keys(options.sort).length === 1 &&
          options.sort._date_modified) {
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
    
    // Check WIP status - if still WIP after optional wait, query DB directly
    const isWIP = await this._checkWIP(options)
    if (isWIP) {
      this.stats.dbHits++
      console.warn('🔴 Cache WIP - cahche filling is taking too long for', { query, owner: this.owner, appTable: this.appTable } )
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
      this.stats.dbHits++
      return null
    }
    
    // 1. Check Recent cache first (fast, already sorted)
    const recentRecords = this._getRecentCache()
    if (recentRecords !== null) {
      const filtered = filterRecords(recentRecords, query, options)
      this.stats.cacheHits++
      return filtered
    }
    
    // 2. Check All cache if Recent doesn't exist
    if (this.cacheAll) {
      const allRecords = this._getAllCache()
      if (allRecords !== null) {
        const filtered = filterRecords(allRecords, query, options)
        this.stats.cacheHits++
        return filtered
      }
    }
    
    // 3. Cache miss - caller should hit DB
    this.stats.dbHits++
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
      this.stats.dbHits++
      return null
    }
    
    // 1. Check byKey cache
    const byKeyResult = this.getByKey(field, value)
    if (byKeyResult !== null) {
      this.stats.cacheHits++
      // onsole.log('📦 Cache - got a simple query byKey hit', { field, value, query, reslen: byKeyResult?.length } )
      return byKeyResult  // Return as array to match query format
    } else {
      // onsole.log('📦 Cache - got a simple query byKey miss', { field, value, query } )
    }
    
    // 2. Check All cache (if exists, it's authoritative)
    if (this.cacheAll) {
      const allRecords = this._getAllCache()
      if (allRecords !== null) {
        const filtered = filterRecords(allRecords, query, options)
        // onsole.log('📦 Cache - got a simple query byKey miss - All cache', { field, value, query, allRecordsLen: allRecords?.length, filteredLen: filtered?.length } )
        this.stats.cacheHits++
        return filtered  // If All exists and no match, return empty (don't check DB)
      }
    }
    
    // 3. Check Recent cache
    const recentRecords = this._getRecentCache()
    if (recentRecords !== null) {
      const filtered = filterRecords(recentRecords, query, options)
      if (filtered.length > 0) {
        this.stats.cacheHits++
        return filtered
      }
      // If not in Recent, continue to Query cache (might be older record)
    }
    
    // 4. Check Query cache
    const queryResult = this._getQueryCache(query, options)
    if (queryResult !== null) {
      this.stats.cacheHits++
      // onsole.log('📦 Cache query Query - this should have been caufght by key query key snbh ?? ', { query, options, queryResult } )
      return queryResult
    }
    
    // 5. Cache miss - caller should hit DB
    this.stats.dbHits++
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
        return filtered
      }
      // Recent cache exists but doesn't cover this timestamp
      // Still return what we have if it matches
      const filtered = filterRecords(recentRecords, query, options)
      if (filtered.length > 0) {
        this.stats.cacheHits++
        return filtered
      }
    }
    
    // 2. Check All cache if Recent doesn't have it
    if (this.cacheAll) {
      const allRecords = this._getAllCache()
      if (allRecords !== null) {
        const filtered = filterRecords(allRecords, query, options)
        this.stats.cacheHits++
        return filtered  // All is authoritative
      }
    }
    
    // 3. Cache miss - caller should hit DB
    this.stats.dbHits++
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
      this.stats.dbHits++
      return null
    }
    
    // 1. Check Query cache
    const queryResult = this._getQueryCache(query, options)
    if (queryResult !== null) {
      this.stats.cacheHits++
      return queryResult
    }
    
    // 2. Check All cache (if exists, it's authoritative)
    if (this.cacheAll) {
      const allRecords = this._getAllCache()
      if (allRecords !== null) {
        const filtered = filterRecords(allRecords, query, options)
        this.stats.cacheHits++
        return filtered  // All is authoritative - don't check DB
      }
    }
    
    // 3. Cache miss - caller should hit DB
    this.stats.dbHits++
    return null
  }
  
  /**
   * Store query results in cache
   * If empty query, store in Recent instead of Query cache
   * Only caches queries that match declared cachePatterns
   */
  async setQuery(query, results, options = {}) {
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
        await this.setByKey(simpleCheck.field, simpleCheck.value, results)
        return true
      } else {
        // onsole.log('📦 Cache setQuery Simple - field not in cachePatterns, skipping', { field: simpleCheck.field, cachePatterns: this.cachePatterns })
        return false
      }
    }
    
    // Check for compound pattern match (multi-field equality query)
    const patternCheck = matchesCompoundPattern(query, this.cachePatterns, options)
    if (patternCheck.matches) {
      // onsole.log('📦 Cache setQuery Compound', { pattern: patternCheck.pattern, query })
      const queryHash = hashQuery(query, {})  // No options in hash
      const key = this._buildKey('Query', queryHash)
      
      this._interface.set(key, results, {
        type: 'Query',
        namespace: this.namespace,
        ttl: this.config.ttl.Query
      })
      return true
    }
    
    // Query doesn't match any pattern - don't cache
    // onsole.log('📦 Cache setQuery - no matching pattern, skipping', { query, cachePatterns: this.cachePatterns })
    return false
  }
  
  /**
   * Get from Query cache
   */
  _getQueryCache(query, options = {}) {
    const queryHash = hashQuery(query, options)
    const key = this._buildKey('Query', queryHash)
    return this._interface.get(key)
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
   * Get file tokens for a specific file path
   * Returns an object mapping tokens to their creation timestamps
   * @param {string} filePath - The file path (dataObjectId)
   * @returns {Object|null} - Object with token:timestamp mappings or null if not found
   */
  getFileTokens(filePath) {
    const key = this._buildKey('fileTokens', filePath)
    return this._interface.get(key)
  }
  
  /**
   * Set a file token for a specific file path
   * Stores tokens as { token: timestamp } mapping
   * Multiple tokens can exist per file (for different clients/sessions)
   * @param {string} filePath - The file path (dataObjectId)
   * @param {string} token - The token string
   * @param {number} timestamp - The creation timestamp (defaults to now)
   * @returns {boolean} - True if successful
   */
  setFileToken(filePath, token, timestamp = Date.now()) {
    const key = this._buildKey('fileTokens', filePath)
    let tokens = this._interface.get(key) || {}
    
    // Add new token
    tokens[token] = timestamp
    
    // Clean up expired tokens (older than 24 hours)
    const FILE_TOKEN_EXPIRY = 24 * 3600 * 1000 // 24 hours in ms
    const now = Date.now()
    Object.keys(tokens).forEach(t => {
      if (now - tokens[t] > FILE_TOKEN_EXPIRY) {
        delete tokens[t]
      }
    })
    
    // If no tokens left, don't store empty object
    if (Object.keys(tokens).length === 0) {
      this._interface.delete(key)
      return false
    }
    
    this._interface.set(key, tokens, {
      type: 'fileTokens',
      namespace: this.namespace,
      ttl: this.config.ttl.fileTokens
    })

    // console.log('      🔑 fileTokens setFileToken setFileToken ', { filePath, token, timestamp })
    
    return true
  }
  
  /**
   * Delete a specific file token
   * @param {string} filePath - The file path (dataObjectId)
   * @param {string} token - The token to delete
   * @returns {boolean} - True if token was found and deleted
   */
  deleteFileToken(filePath, token) {
    const key = this._buildKey('fileTokens', filePath)
    const tokens = this._interface.get(key)
    
    if (!tokens || !tokens[token]) {
      return false
    }
    
    delete tokens[token]
    
    // If no tokens left, delete the entire entry
    if (Object.keys(tokens).length === 0) {
      this._interface.delete(key)
    } else {
      this._interface.set(key, tokens, {
        type: 'fileTokens',
        namespace: this.namespace,
        ttl: this.config.ttl.fileTokens
      })
    }
    
    return true
  }
  
  /**
   * Delete all file tokens for a specific file path
   * @param {string} filePath - The file path (dataObjectId)
   * @returns {boolean} - True if successful
   */
  deleteAllFileTokens(filePath) {
    const key = this._buildKey('fileTokens', filePath)
    this._interface.delete(key)
    return true
  }
  
  /**
   * Validate a file token and return its timestamp if valid
   * @param {string} filePath - The file path (dataObjectId)
   * @param {string} token - The token to validate
   * @returns {number|null} - Token creation timestamp if valid, null otherwise
   */
  validateFileToken(filePath, token) {
    // console.log('      🔑 validateFileToken fileTokens getFileTokens', { filePath, token })
    const tokens = this.getFileTokens(filePath)
    if (!tokens || !tokens[token]) {
      return null
    }
    
    const tokenTime = tokens[token]
    const FILE_TOKEN_EXPIRY = 24 * 3600 * 1000 // 24 hours in ms
    const now = Date.now()
    
    // Check if token is expired
    if (now - tokenTime > FILE_TOKEN_EXPIRY) {
      // Token expired - clean it up
      this.deleteFileToken(filePath, token)
      return null
    }
    
    return tokenTime
  }
  
  /**
   * Get or create a file token (with reuse logic)
   * Returns existing valid token if available, otherwise creates new one
   * @param {string} filePath - The file path (dataObjectId)
   * @param {Function} tokenGenerator - Function to generate new token (defaults to randomText)
   * @returns {string} - The file token
   */
  getOrSetFileToken(filePath, tokenGenerator = null) {
    const FILE_TOKEN_KEEP = 18 * 3600 * 1000 // 18 hours - reuse window
    const now = Date.now()
    
    const tokens = this.getFileTokens(filePath)
    if (tokens) {
      // Look for a valid token within the reuse window
      for (const [token, timestamp] of Object.entries(tokens)) {
        if (now - timestamp < FILE_TOKEN_KEEP) {
          return token // Reuse existing token
        }
      }
    }
    
    // No valid token found - create new one
    // Import randomText if not provided
    if (!tokenGenerator) {
      // We'll need to import this in the controller, so pass it in
      throw new Error('tokenGenerator function is required')
    }
    
    const newToken = tokenGenerator(20)
    this.setFileToken(filePath, newToken, now)
    return newToken
  }
  
  // ==================== END FILE TOKEN METHODS ====================
  
  /**
   * Invalidate cache entries for a specific record based on cachePatterns
   * Called with old and/or new record data to precisely invalidate affected caches
   * 
   * @param {Object} oldRecord - The record before update (null for creates)
   * @param {Object} newRecord - The record after update (null for deletes)
   */
  invalidateForRecord(oldRecord, newRecord) {
    console.log('🔄 cache invalidateForRecord', { table: this.namespace, hasOld: !!oldRecord, hasNew: !!newRecord })
    
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
            toInvalidate.queries.add(queryHash)
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
    
    // Delete all collected Query entries
    for (const queryHash of toInvalidate.queries) {
      const key = this._buildKey('Query', queryHash)
      this._interface.delete(key)
      // onsole.log('🔄 invalidateForRecord - deleted query cache', { key })
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
    // onsole.log('🔄 cache markDirty from appTableCache.mjs', { table: this.namespace, recordId, hasOld: !!oldRecord, hasNew: !!newRecord })
    
    // If we have cachePatterns and record data, use precise invalidation
    if (this.cachePatterns.length > 0 && (oldRecord || newRecord)) {
      this.invalidateForRecord(oldRecord, newRecord)
    } else {
      // Fallback: delete by recordId if provided
      if (recordId) {
        this.deleteByKey('_id', recordId)
      }
      
      // Conservative: invalidate all Query caches when no pattern info available
      if (this.cachePatterns.length === 0) {
        const pattern = `^${this.namespace}:Query:`
        this._interface.deletePattern(pattern)
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
        await this.refreshFunction(this.dirtyFlags)
        this.dirtyFlags.All = false
        this.dirtyFlags.Recent = false
      } catch (err) {
        console.warn('🔄 cache - Error refreshing cache:', err.message)
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
      }
      if (needsRecent) {
        this.wipFlags.Recent = true
        this.dirtyFlags.Recent = true
        // onsole.log('🔄 Initializing Recent cache - WIP flag set')
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
