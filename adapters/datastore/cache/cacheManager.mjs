// freezr.info - Cache Manager
// Singleton that manages all caches, memory monitoring, and eviction

import cacheConfig from './cacheConfig.mjs'
import NodeCache from 'node-cache'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

class CacheManager {
  constructor(config = {}) {
    if (CacheManager.instance) {
      return CacheManager.instance
    }
    
    this.config = { ...cacheConfig, ...config } 
    
    // Load cache preferences (for determining cacheAll, cacheRecent per app_table)
    this.cachePrefs = config.cachePrefs || this._loadDefaultCachePrefs()
    
    // Underlying cache storage
    this.cache = null
    this.cacheType = this.config.type || 'memory'
    
    // Initialize cache based on type
    this._initializeCache()
    
    // Track cache metadata for eviction decisions (only for memory cache)
    this.metadata = new Map()
    
    // Memory monitoring (only for memory cache)
    this.memoryCheckTimer = null
    if (this.cacheType === 'memory') {
      this.startMemoryMonitoring()
    }
    
    // LOCAL FILE COPY REGISTRY
    // Tracks files copied locally from remote storage so they can servied more quick;y -
    // Note this would be turned off in multi server instances as consitency cannot be guaranteed
    // Structure: { "owner:appName": { "partialPath": { lastAccessed, size, fileType } } }
    this.localFileCopyRegistry = new Map()
    
    // Stats
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      memoryEvictions: 0
    }
    
    CacheManager.instance = this
  }
  
  async _initializeCache() {
    if (this.cacheType === 'redis') { 
      try {
        const RedisCache = (await import('./redisCache.mjs')).default
        this.cache = new RedisCache(this.config.redis)
        const connected = await this.cache.connect()
        
        if (!connected) {
          console.warn('⚠️ Redis connection failed, falling back to memory cache')
          this.cacheType = 'memory'
          this._initMemoryCache()
        }
      } catch (err) {
        console.warn('⚠️ Redis not available, using memory cache:', err.message)
        this.cacheType = 'memory'
        this._initMemoryCache()
      }
    } else {
      this._initMemoryCache()
    }
  }
  
  _initMemoryCache() {
    this.cache = new NodeCache({
      stdTTL: 0,  // We'll manage TTL ourselves
      checkperiod: 0,  // Disable automatic check
      useClones: false  // Store references, not clones
    })
  }
  
  _loadDefaultCachePrefs() {
    try {
      const prefsPath = path.join(__dirname, 'defaultCachePrefs.json')
      const prefsData = fs.readFileSync(prefsPath, 'utf8')
      return JSON.parse(prefsData)
    } catch (err) {
      console.warn('Could not load defaultCachePrefs.json:', err.message)
      return { ALL_USERS: {}, USER_SPECIFIC: {} }
    }
  }
  
  /**
   * Get cache preferences for a specific user:app_table
   * Always returns a complete object with all properties defaulted
   */
  getCachePrefsForTable(owner, appTable) {
    const defaults = { cacheRecent: true, cacheAll: false, cachePatterns: null }

    if (!owner || !appTable) return defaults
    
    // Check user-specific first
    if (this.cachePrefs.USER_SPECIFIC[owner] && 
        this.cachePrefs.USER_SPECIFIC[owner][appTable]) {
      return { ...defaults, ...this.cachePrefs.USER_SPECIFIC[owner][appTable] }
    }
    
    // Fall back to all users
    if (this.cachePrefs.ALL_USERS[appTable]) {
      return { ...defaults, ...this.cachePrefs.ALL_USERS[appTable] }
    }
    
    return defaults
  }
  
  /**
   * Update cache preferences (admin function)
   */
  updateCachePrefs(prefs) {
    this.cachePrefs = {
      ALL_USERS: { ...this.cachePrefs.ALL_USERS, ...prefs.ALL_USERS },
      USER_SPECIFIC: { ...this.cachePrefs.USER_SPECIFIC, ...prefs.USER_SPECIFIC }
    }
    
    // Optionally save to file
    try {
      const prefsPath = path.join(__dirname, 'defaultCachePrefs.json')
      fs.writeFileSync(prefsPath, JSON.stringify(this.cachePrefs, null, 2))
      console.log('Cache preferences updated and saved')
    } catch (err) {
      console.warn('Could not save cache preferences:', err.message)
    }
    
    return this.cachePrefs
  }
  
  /**
   * Get current cache preferences (admin function)
   */
  getCachePrefs() {
    return this.cachePrefs
  }
  
  /**
   * Get a value from cache
   */
  get(key) {
    const value = this.cache.get(key)
    
    if (value !== undefined) {
      this.stats.hits++
      if (this.cacheType === 'memory') {
        this.updateAccess(key)
      }
      
      if (this.config.logCacheHits) {
        console.log('Cache HIT:', key)
      }
      
      return value
    }
    
    this.stats.misses++
    if (this.config.logCacheMisses) {
      console.log('Cache MISS:', key)
    }
    
    return null
  }
  
  /**
   * Set a value in cache with metadata
   */
  set(key, value, metadata = {}) {
    // Calculate size estimate (rough) - only for memory cache
    const size = this.cacheType === 'memory' ? this.estimateSize(value) : 0
    
    // Store in cache
    const ttl = metadata.ttl || this.config.ttl[metadata.type] || 0
    this.cache.set(key, value, ttl)
    
    // Store metadata (only for memory cache)
    if (this.cacheType === 'memory') {
      this.metadata.set(key, {
        key,
        type: metadata.type || 'unknown',
        priority: metadata.priority || this.config.evictionPriority[metadata.type] || 50,
        namespace: metadata.namespace || 'unknown',
        lastAccessed: Date.now(),
        createdAt: Date.now(),
        accessCount: 0,
        size,
        ttl
      })
      
      // Check if we need to evict due to count limits
      this.checkCountLimits(metadata.type)
    }
    
    return true
  }
  
  /**
   * Delete a value from cache
   */
  delete(key) {
    this.cache.del(key)
    if (this.cacheType === 'memory') {
      this.metadata.delete(key)
    }
    return true
  }
  
  /**
   * Delete multiple keys matching a pattern
   */
  deletePattern(pattern) {
    // onsole.log('🔄 cache deletePattern from cacheManager.mjs', { pattern })
    const keys = this.cache.keys()
    const regex = new RegExp(pattern)
    let deleted = 0
    
    keys.forEach(key => {
      if (regex.test(key)) {
        console.log('🔄 cache deletePattern from cacheManager.mjs - deleting key', { key })
        this.delete(key)
        deleted++
      } else {
        // onsole.log('🔄 cache deletePattern from cacheManager.mjs - not deleting key', { key })
      }
    })
    
    return deleted
  }
  
  /**
   * Get all keys matching a pattern
   */
  getKeys(pattern) {
    const keys = this.cache.keys()
    if (!pattern) return keys
    
    const regex = new RegExp(pattern)
    return keys.filter(key => regex.test(key))
  }
  
  /**
   * Update access metadata for LRU tracking (memory cache only)
   */
  updateAccess(key) {
    const meta = this.metadata.get(key)
    if (meta) {
      meta.lastAccessed = Date.now()
      meta.accessCount++
      this.metadata.set(key, meta)
    }
  }
  
  /**
   * Estimate size of a value in bytes
   */
  estimateSize(value) {
    if (value === null || value === undefined) return 0
    
    const type = typeof value
    
    if (type === 'string') {
      return value.length * 2  // Rough estimate: 2 bytes per char
    }
    if (type === 'number') {
      return 8
    }
    if (type === 'boolean') {
      return 4
    }
    if (Buffer.isBuffer(value)) {
      return value.length
    }
    if (Array.isArray(value)) {
      return value.reduce((sum, item) => sum + this.estimateSize(item), 0)
    }
    if (type === 'object') {
      // Rough estimate for objects
      return JSON.stringify(value).length * 2
    }
    
    return 0
  }
  
  /**
   * Calculate total cache size
   */
  getTotalCacheSize() {
    let totalSize = 0
    this.metadata.forEach(meta => {
      totalSize += meta.size
    })
    return totalSize
  }
  
  /**
   * Check if we've exceeded count limits for a cache type
   */
  checkCountLimits(type) {
    const maxEntries = this.config.maxEntries[type]
    if (!maxEntries) return
    
    // Count entries of this type
    const entries = Array.from(this.metadata.values()).filter(m => m.type === type)
    
    if (entries.length > maxEntries) {
      // Evict oldest entries of this type
      const toEvict = entries.length - maxEntries
      const sorted = entries.sort((a, b) => {
        // Sort by last accessed (LRU)
        return a.lastAccessed - b.lastAccessed
      })
      
      for (let i = 0; i < toEvict; i++) {
        this.delete(sorted[i].key)
        this.stats.evictions++
      }
      
      if (this.config.logEvictions) {
        console.log(`Evicted ${toEvict} entries of type ${type} due to count limit`)
      }
    }
  }
  
  /**
   * Start monitoring memory usage
   */
  startMemoryMonitoring() {
    if (this.memoryCheckTimer) return
    
    this.memoryCheckTimer = setInterval(() => {
      this.checkMemoryUsage()
    }, this.config.memoryCheckInterval)
  }
  
  /**
   * Stop monitoring memory usage
   */
  stopMemoryMonitoring() {
    if (this.memoryCheckTimer) {
      clearInterval(this.memoryCheckTimer)
      this.memoryCheckTimer = null
    }
  }
  
  /*
   * Check memory usage and evict if necessary
   * PRIMARY CHECK: Cache size vs maxCacheSizeMB
   * SAFETY CHECK: Heap usage (only if cache is large)
   */
  checkMemoryUsage() {
    const cacheSize = this.getTotalCacheSize()
    const cacheSizeMB = cacheSize / (1024 * 1024)
    
    // Primary check: Cache size limit
    if (cacheSizeMB > this.config.maxCacheSizeMB) {
      console.warn(`Cache size high: ${cacheSizeMB.toFixed(1)}MB / ${this.config.maxCacheSizeMB}MB - Starting eviction`)
      this.evictLowPriority()
      return
    }
    
    // Safety check: Total heap usage (only if cache is reasonably sized)
    if (cacheSizeMB > this.config.maxCacheSizeMB * 0.5) {
      const usage = process.memoryUsage()
      const heapUsedPercent = usage.heapUsed / usage.heapTotal
      
      if (heapUsedPercent > this.config.memoryThreshold) {
        console.warn(`Heap usage high: ${(heapUsedPercent * 100).toFixed(1)}% (cache: ${cacheSizeMB.toFixed(1)}MB) - Starting eviction`)
        this.evictLowPriority()
      }
    }
  }

  
  /**
   * Evict low-priority cache entries
   */
  evictLowPriority() {
    const entries = Array.from(this.metadata.values())
    
    // Calculate eviction score (lower = evict first)
    const scored = entries.map(entry => {
      const ageMs = Date.now() - entry.lastAccessed
      const ageMinutes = ageMs / 60000
      
      // Score formula: priority - (age weight) + (access count weight)
      const ageWeight = Math.min(ageMinutes / 60, 10)  // Max 10 points for age
      const accessWeight = Math.min(entry.accessCount * this.config.accessCountWeight, 10)
      
      const score = entry.priority - ageWeight + accessWeight
      
      return { ...entry, score }
    })
    
    // Sort by score (lowest first)
    scored.sort((a, b) => a.score - b.score)
    
    // Evict bottom 20%
    const toEvict = Math.max(Math.floor(scored.length * 0.2), 10)
    
    let evicted = 0
    for (let i = 0; i < toEvict && i < scored.length; i++) {
      // Don't evict All or Recent caches unless absolutely necessary
      if (scored[i].type === 'All' || scored[i].type === 'Recent') {
        const ageHours = (Date.now() - scored[i].lastAccessed) / (60 * 60 * 1000)
        if (ageHours < 24) {
          continue  // Keep All/Recent if accessed in last 24 hours
        }
      }
      
      this.delete(scored[i].key)
      evicted++
    }
    
    this.stats.evictions += evicted
    this.stats.memoryEvictions++
    
    if (this.config.logEvictions) {
      console.log(`Memory eviction: removed ${evicted} entries`)
    }
    
    return evicted
  }
  
  /**
   * Get cache statistics (includes memory usage)
   */
  getStats() {
    const keys = this.cache.keys()
    const usage = process.memoryUsage()
    const cacheSize = this.cacheType === 'memory' ? this.getTotalCacheSize() : 0
    
    // Count by type
    const typeCount = {}
    const typeSize = {}
    if (this.cacheType === 'memory') {
      this.metadata.forEach(meta => {
        typeCount[meta.type] = (typeCount[meta.type] || 0) + 1
        typeSize[meta.type] = (typeSize[meta.type] || 0) + meta.size
      })
    }
    
    // Count by namespace (user:app_table)
    const namespaceCount = {}
    const namespaceSize = {}
    if (this.cacheType === 'memory') {
      this.metadata.forEach(meta => {
        namespaceCount[meta.namespace] = (namespaceCount[meta.namespace] || 0) + 1
        namespaceSize[meta.namespace] = (namespaceSize[meta.namespace] || 0) + meta.size
      })
    }
    
    return {
      cacheType: this.cacheType,
      totalKeys: keys.length,
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: this.stats.hits / (this.stats.hits + this.stats.misses) || 0,
      evictions: this.stats.evictions,
      memoryEvictions: this.stats.memoryEvictions,
      
      // Memory information (only for memory cache)
      memory: this.cacheType === 'memory' ? {
        cacheSize,
        cacheSizeMB: (cacheSize / (1024 * 1024)).toFixed(2),
        heapUsed: usage.heapUsed,
        heapUsedMB: (usage.heapUsed / (1024 * 1024)).toFixed(2),
        heapTotal: usage.heapTotal,
        heapTotalMB: (usage.heapTotal / (1024 * 1024)).toFixed(2),
        heapUsedPercent: (usage.heapUsed / usage.heapTotal * 100).toFixed(1) + '%',
        cachePercentOfHeap: (cacheSize / usage.heapUsed * 100).toFixed(1) + '%'
      } : null,
      
      byType: typeCount,
      sizeByType: typeSize,
      byNamespace: namespaceCount,
      sizeByNamespace: namespaceSize
    }
  }
  
  /**
   * Clear all caches (ADMIN FUNCTION)
   */
  clearAll() {
    this.cache.flushAll()
    if (this.cacheType === 'memory') {
      this.metadata.clear()
    }
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      memoryEvictions: 0
    }
    console.log('ADMIN: All caches cleared')
    return true
  }
  
  /**
   * Clear caches for a specific namespace (user:app_table)
   */
  clearNamespace(namespace) {
    const pattern = `^${namespace}:`
    const deleted = this.deletePattern(pattern)
    console.log(`ADMIN: Cleared ${deleted} entries for namespace: ${namespace}`)
    return deleted
  }
  
  /**
   * Clear all caches for a specific user (ADMIN FUNCTION)
   */
  clearUser(owner) {
    const pattern = `^${owner}:`
    const deleted = this.deletePattern(pattern)
    console.log(`ADMIN: Cleared ${deleted} entries for user: ${owner}`)
    return deleted
  }
  
  /**
   * Delete specific cache entry by key (ADMIN FUNCTION)
   */
  adminDelete(key) {
    const meta = this.cacheType === 'memory' ? this.metadata.get(key) : null
    this.delete(key)
    console.log(`ADMIN: Deleted cache entry: ${key}`)
    return { success: true, meta }
  }
  
  // ==================== LOCAL FILE COPY (localFileCopyRegistry) METHODS ====================
  // Files are stored on server local disk uner users_freezr for quik access by app.. 
  // note that this should be turned off in multi server instances as consitency cannot be guaranteed
  // Rather the 
  /**
   * Track a file that was copied locally from remote storage
   * @param {string} owner - User ID
   * @param {string} appName - App name
   * @param {string} partialPath - Path relative to user root (e.g., "userapps/user/apps/app/file.js")
   * @param {string} fileType - Type of file: 'appFile' or 'userFile'
   * @param {number} size - File size in bytes (optional)
   */
  trackLocalFileCopy(owner, appName, partialPath, fileType = 'appFile', size = 0) {
    const key = `${owner}:${appName}`
    
    if (!this.localFileCopyRegistry.has(key)) {
      this.localFileCopyRegistry.set(key, new Map())
    }
    
    const appRegistry = this.localFileCopyRegistry.get(key)
    appRegistry.set(partialPath, {
      lastAccessed: Date.now(),
      lastCopied: Date.now(),  // When this server copied the file locally
      size,
      fileType
    })
    
    // console.log(`📁 Tracked local file copy: ${partialPath}`)
  }
  
  /**
   * Get the lastCopied timestamp for a locally copied file
   * Used to compare against shared cache fileModTime for multi-server consistency
   * @param {string} owner - User ID
   * @param {string} appName - App name
   * @param {string} partialPath - Path relative to user root
   * @returns {number|null} - Timestamp when file was copied locally, or null if not found
   */
  getLocalFileCopyTime(owner, appName, partialPath) {
    const key = `${owner}:${appName}`
    const appRegistry = this.localFileCopyRegistry.get(key)
    
    if (appRegistry && appRegistry.has(partialPath)) {
      const entry = appRegistry.get(partialPath)
      return entry.lastCopied || null
    }
    return null
  }
  
  /**
   * Update lastCopied time for a locally copied file (when re-fetched)
   */
  touchLocalFileCopy(owner, appName, partialPath) {
    const key = `${owner}:${appName}`
    const appRegistry = this.localFileCopyRegistry.get(key)
    
    if (appRegistry && appRegistry.has(partialPath)) {
      const entry = appRegistry.get(partialPath)
      entry.lastAccessed = Date.now()
      entry.lastCopied = Date.now()
    }
  }
  
  /**
   * Get info about locally copied files for a user/app
   * @param {string} owner - User ID
   * @param {string} appName - App name (optional, if not provided returns all apps for user)
   */
  getLocalFileCopyInfo(owner, appName = null) {
    const results = []
    
    this.localFileCopyRegistry.forEach((appRegistry, key) => {
      const [regOwner, regAppName] = key.split(':')
      
      if (regOwner !== owner) return
      if (appName && regAppName !== appName) return
      
      const files = []
      let totalSize = 0
      
      appRegistry.forEach((info, partialPath) => {
        files.push({
          path: partialPath,
          ...info,
          ageMinutes: Math.floor((Date.now() - (info.lastCopied || 0)) / 60000)
        })
        totalSize += info.size || 0
      })
      
      results.push({
        owner: regOwner,
        appName: regAppName,
        fileCount: files.length,
        totalSize,
        totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
        files
      })
    })
    
    return results
  }
  
  /**
   * Wipe locally copied files for a user/app from disk
   * Only deletes files that were cached from remote storage (tracked in registry)
   * @param {string} owner - User ID
   * @param {string} appName - App name
   * @param {string} rootDir - Root directory path (e.g., from ROOT_DIR in userDsMgr)
   * @param {Object} options - Options: { deleteAppFiles, deleteUserFiles, olderThanMs }
   * @returns {Object} Summary of deleted files
   */
  async wipeLocalFileCache(owner, appName, rootDir, options = {}) {
    const key = `${owner}:${appName}`
    const appRegistry = this.localFileCopyRegistry.get(key)
    
    if (!appRegistry || appRegistry.size === 0) {
      console.log(`📁 No local file copy to wipe for ${key}`)
      return { deleted: 0, errors: 0, skipped: 0 }
    }
    
    const deleteAppFiles = options.deleteAppFiles !== false  // Default true
    const deleteUserFiles = options.deleteUserFiles !== false  // Default true
    const olderThanMs = options.olderThanMs || 0  // Default: delete all
    
    let deleted = 0
    let errors = 0
    let skipped = 0
    const now = Date.now()
    const toDelete = []
    
    // Collect files to delete
    appRegistry.forEach((info, partialPath) => {
      // Filter by file type
      if (info.fileType === 'appFile' && !deleteAppFiles) {
        skipped++
        return
      }
      if (info.fileType === 'userFile' && !deleteUserFiles) {
        skipped++
        return
      }
      
      // Filter by age (based on when file was copied locally)
      if (olderThanMs > 0 && (now - (info.lastCopied || 0)) < olderThanMs) {
        skipped++
        return
      }
      
      toDelete.push(partialPath)
    })
    
    // Delete files
    for (const partialPath of toDelete) {
      const localPath = path.normalize(rootDir + partialPath)
      
      try {
        if (fs.existsSync(localPath)) {
          await fs.promises.unlink(localPath)
          deleted++
          // console.log(`📁 Deleted local cache file: ${localPath}`)
        } else {
          // File doesn't exist, just remove from registry
          deleted++
        }
        
        // Remove from registry
        appRegistry.delete(partialPath)
      } catch (err) {
        console.warn(`📁 Error deleting local cache file: ${localPath}`, err.message)
        errors++
      }
    }
    
    // Clean up empty registry
    if (appRegistry.size === 0) {
      this.localFileCopyRegistry.delete(key)
    }
    
    console.log(`📁 Wiped local file copy for ${key}: ${deleted} deleted, ${errors} errors, ${skipped} skipped`)
    return { deleted, errors, skipped }
  }
  
  /**
   * Wipe all locally copied files for a user (all apps)
   * @param {string} owner - User ID
   * @param {string} rootDir - Root directory path
   * @param {Object} options - Same as wipeLocalFileCache
   */
  async wipeLocalFileCacheForUser(owner, rootDir, options = {}) {
    const results = { deleted: 0, errors: 0, skipped: 0, apps: [] }
    
    // Find all apps for this user
    const appsToWipe = []
    this.localFileCopyRegistry.forEach((_, key) => {
      const [regOwner, regAppName] = key.split(':')
      if (regOwner === owner) {
        appsToWipe.push(regAppName)
      }
    })
    
    // Wipe each app
    for (const appName of appsToWipe) {
      const appResult = await this.wipeLocalFileCache(owner, appName, rootDir, options)
      results.deleted += appResult.deleted
      results.errors += appResult.errors
      results.skipped += appResult.skipped
      results.apps.push({ appName, ...appResult })
    }
    
    console.log(`📁 Wiped all local file copy for user ${owner}: ${results.deleted} total deleted`)
    return results
  }
  
  /**
   * Get list of all apps with locally copied files
   */
  listLocalFileCacheApps() {
    const apps = []
    
    this.localFileCopyRegistry.forEach((appRegistry, key) => {
      const [owner, appName] = key.split(':')
      let totalSize = 0
      appRegistry.forEach(info => {
        totalSize += info.size || 0
      })
      
      apps.push({
        owner,
        appName,
        fileCount: appRegistry.size,
        totalSize,
        totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2)
      })
    })
    
    // Sort by size
    apps.sort((a, b) => b.totalSize - a.totalSize)
    return apps
  }
  
  // ==================== END LOCAL FILE COPY METHODS ====================
  
  /**
   * Get details about a specific cache entry (ADMIN FUNCTION)
   * NOTE: Does not include value preview for security reasons
   */
  inspectEntry(key) {
    const meta = this.cacheType === 'memory' ? this.metadata.get(key) : null
    if (!meta) {
      return { found: false }
    }
    
    return {
      found: true,
      key: meta.key,
      namespace: meta.namespace,
      type: meta.type,
      size: meta.size,
      sizeMB: (meta.size / (1024 * 1024)).toFixed(3),
      priority: meta.priority,
      accessCount: meta.accessCount,
      createdAt: new Date(meta.createdAt).toISOString(),
      lastAccessed: new Date(meta.lastAccessed).toISOString(),
      ageMinutes: Math.floor((Date.now() - meta.lastAccessed) / 60000),
      ttl: meta.ttl
    }
  }
  
  /**
   * Get list of all users with cached data (ADMIN FUNCTION)
   */
  listUsers() {
    const users = new Set()
    if (this.cacheType === 'memory') {
      this.metadata.forEach(meta => {
        const owner = meta.namespace.split(':')[0]
        if (owner) users.add(owner)
      })
    }
    
    const userStats = []
    users.forEach(owner => {
      const entries = Array.from(this.metadata.values()).filter(m => 
        m.namespace.startsWith(owner + ':')
      )
      const totalSize = entries.reduce((sum, e) => sum + e.size, 0)
      
      userStats.push({
        owner,
        entryCount: entries.length,
        totalSize,
        totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2)
      })
    })
    
    // Sort by size
    userStats.sort((a, b) => b.totalSize - a.totalSize)
    
    return userStats
  }
  
  /**
   * Create a scoped interface for a specific user (owner)
   * Returns an object with closure functions that have owner baked in
   * This prevents the caller from accessing other users' data
   * 
   * @param {string} owner - The user ID to scope to
   * @returns {Object} Scoped cache interface
   */
  createUserInterface(owner) {
    const ownerPrefix = `${owner}:`
    const cacheManager = this
    
    // Helper to validate key starts with owner prefix
    const validateKey = (key) => {
      if (!key.startsWith(ownerPrefix)) {
        throw new Error(`Security violation: key "${key}" does not belong to owner "${owner}"`)
      }
    }
    
    return Object.freeze({
      owner,  // Read-only reference to owner
      
      get: (key) => {
        validateKey(key)
        return cacheManager.get(key)
      },
      
      set: (key, value, metadata) => {
        validateKey(key)
        // Ensure namespace in metadata also belongs to this owner
        if (metadata?.namespace && !metadata.namespace.startsWith(ownerPrefix)) {
          throw new Error(`Security violation: namespace "${metadata.namespace}" does not belong to owner "${owner}"`)
        }
        return cacheManager.set(key, value, metadata)
      },
      
      delete: (key) => {
        validateKey(key)
        return cacheManager.delete(key)
      },
      
      deletePattern: (pattern) => {
        // Force pattern to only match this owner's keys
        // If pattern already has ^, extract the rest and prepend owner
        let scopedPattern
        if (pattern.startsWith('^')) {
          // Validate that pattern after ^ starts with owner prefix
          const patternAfterCaret = pattern.slice(1)
          if (!patternAfterCaret.startsWith(ownerPrefix)) {
            throw new Error(`Security violation: pattern "${pattern}" does not match owner "${owner}"`)
          }
          scopedPattern = pattern
        } else {
          // Prepend ^ and owner prefix
          if (!pattern.startsWith(ownerPrefix)) {
            throw new Error(`Security violation: pattern "${pattern}" does not match owner "${owner}"`)
          }
          scopedPattern = `^${pattern}`
        }
        return cacheManager.deletePattern(scopedPattern)
      },
      
      getKeys: (pattern) => {
        // Scope pattern to this owner
        let scopedPattern
        if (pattern) {
          if (!pattern.startsWith(ownerPrefix) && !pattern.startsWith(`^${ownerPrefix}`)) {
            throw new Error(`Security violation: pattern "${pattern}" does not match owner "${owner}"`)
          }
          scopedPattern = pattern.startsWith('^') ? pattern : `^${pattern}`
        } else {
          scopedPattern = `^${ownerPrefix}`
        }
        return cacheManager.getKeys(scopedPattern)
      },
      
      clearAll: () => {
        // Only clear this owner's entries
        return cacheManager.deletePattern(`^${ownerPrefix}`)
      },
      
      clearNamespace: (namespace) => {
        // Validate namespace belongs to this owner
        if (!namespace.startsWith(ownerPrefix)) {
          throw new Error(`Security violation: namespace "${namespace}" does not belong to owner "${owner}"`)
        }
        return cacheManager.clearNamespace(namespace)
      },
      
      // Stats functions - return only this owner's data
      getMetadataEntries: () => {
        if (cacheManager.cacheType !== 'memory') return []
        const entries = []
        cacheManager.metadata.forEach((meta) => {
          if (meta.namespace && meta.namespace.startsWith(ownerPrefix)) {
            entries.push(meta)
          }
        })
        return entries
      },
      
      // Cache preferences for this owner's tables
      getCachePrefsForTable: (appTable) => {
        return cacheManager.getCachePrefsForTable(owner, appTable)
      },
      
      // LOCAL FILE COPY methods (scoped to this owner)
      trackLocalFileCopy: (appName, partialPath, fileType, size) => {
        return cacheManager.trackLocalFileCopy(owner, appName, partialPath, fileType, size)
      },
      
      getLocalFileCopyTime: (appName, partialPath) => {
        return cacheManager.getLocalFileCopyTime(owner, appName, partialPath)
      },
      
      touchLocalFileCopy: (appName, partialPath) => {
        return cacheManager.touchLocalFileCopy(owner, appName, partialPath)
      },
      
      getLocalFileCopyInfo: (appName = null) => {
        return cacheManager.getLocalFileCopyInfo(owner, appName)
      },
      
      wipeLocalFileCopy: async (appName, rootDir, options = {}) => {
        return await cacheManager.wipeLocalFileCopy(owner, appName, rootDir, options)
      },
      
      wipeLocalFileCopyForUser: async (rootDir, options = {}) => {
        return await cacheManager.wipeLocalFileCopyForUser(owner, rootDir, options)
      }
    })
  }
}

// Singleton instance
CacheManager.instance = null

export default CacheManager
