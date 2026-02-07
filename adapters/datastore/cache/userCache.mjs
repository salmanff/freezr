// freezr.info - User Cache
// Intermediary cache layer for a specific user (owner)
// Sits between CacheManager (global) and AppTableCache (per app_table)
// 
// SECURITY: This class receives a scoped interface from CacheManager
// that only allows access to this owner's data. It cannot access
// other users' data even if it tries.

import AppTableCache from './appTableCache.mjs'

class UserCache { 
  /**
   * @param {Object} scopedInterface - Scoped cache interface from CacheManager.createUserInterface()
   * @param {string} owner - The user ID (for reference only, actual scoping is in the interface)
   */
  constructor(scopedInterface, owner) {
    // Store the scoped interface - NOT the full CacheManager
    this._interface = scopedInterface
    this.owner = owner
    
    // Track all AppTableCache instances for this user
    this.appTableCaches = new Map()
  }
  
  /**
   * Get or create an AppTableCache for a specific app_table
   */
  getOrCreateAppTableCache(appTable, config = {}) {
    if (this.appTableCaches.has(appTable)) {
      return this.appTableCaches.get(appTable)
    }
    
    // Create scoped interface for this app_table
    const appTableInterface = this._createAppTableInterface(appTable)
    
    // Create new AppTableCache with scoped interface
    const appTableCache = new AppTableCache(
      appTableInterface,   // Pass scoped interface, not full UserCache
      this.owner,
      appTable,
      config
    )
    
    this.appTableCaches.set(appTable, appTableCache)
    return appTableCache
  }
  
  /**
   * Create a scoped interface for a specific app_table
   * Returns an object with closure functions that have namespace (owner:appTable) baked in
   * This prevents AppTableCache from accessing other tables' data
   * 
   * @param {string} appTable - The app_table to scope to
   * @returns {Object} Scoped cache interface for the app_table
   */
  _createAppTableInterface(appTable) {
    const namespace = `${this.owner}:${appTable}`
    const namespacePrefix = `${namespace}:`
    const userInterface = this._interface
    
    // Helper to validate key belongs to this namespace
    const validateKey = (key) => {
      if (!key.startsWith(namespacePrefix)) {
        throw new Error(`Security violation: key "${key}" does not belong to namespace "${namespace}"`)
      }
    }
    
    return Object.freeze({
      owner: this.owner,       // Read-only
      appTable,                // Read-only
      namespace,               // Read-only
      
      get: (key) => {
        validateKey(key)
        return userInterface.get(key)
      },
      
      set: (key, value, metadata) => {
        validateKey(key)
        // Ensure namespace in metadata matches
        if (metadata?.namespace && metadata.namespace !== namespace) {
          throw new Error(`Security violation: metadata namespace "${metadata.namespace}" does not match "${namespace}"`)
        }
        return userInterface.set(key, value, metadata)
      },
      
      delete: (key) => {
        validateKey(key)
        return userInterface.delete(key)
      },
      
      deletePattern: (pattern) => {
        // Force pattern to only match this namespace
        let scopedPattern
        if (pattern.startsWith('^')) {
          const patternAfterCaret = pattern.slice(1)
          if (!patternAfterCaret.startsWith(namespacePrefix)) {
            throw new Error(`Security violation: pattern "${pattern}" does not match namespace "${namespace}"`)
          }
          scopedPattern = pattern
        } else {
          if (!pattern.startsWith(namespacePrefix)) {
            throw new Error(`Security violation: pattern "${pattern}" does not match namespace "${namespace}"`)
          }
          scopedPattern = `^${pattern}`
        }
        return userInterface.deletePattern(scopedPattern)
      },
      
      getKeys: (pattern) => {
        let scopedPattern
        if (pattern) {
          if (!pattern.startsWith(namespacePrefix) && !pattern.startsWith(`^${namespacePrefix}`)) {
            throw new Error(`Security violation: pattern "${pattern}" does not match namespace "${namespace}"`)
          }
          scopedPattern = pattern.startsWith('^') ? pattern : `^${pattern}`
        } else {
          scopedPattern = `^${namespacePrefix}`
        }
        return userInterface.getKeys(scopedPattern)
      }
    })
  }
  
  /**
   * Get an existing AppTableCache (without creating)
   */
  getAppTableCache(appTable) {
    return this.appTableCaches.get(appTable) || null
  }
  
  /**
   * Clear all caches for this user
   */
  clearAll() {
    const deleted = this._interface.clearAll()
    console.log(`Cleared ${deleted} cache entries for user: ${this.owner}`)
    
    // Clear local tracking
    this.appTableCaches.clear()
    
    return deleted
  }
  
  /**
   * Clear cache for a specific app_table
   */
  clearAppTable(appTable) {
    const namespace = `${this.owner}:${appTable}`
    const deleted = this._interface.clearNamespace(namespace)
    
    // Remove from local tracking
    this.appTableCaches.delete(appTable)
    
    return deleted
  }
  
  /**
   * Get statistics for all caches for this user
   */
  getStats() {
    const keys = this._interface.getKeys()
    
    // Get metadata for this user's entries
    const entries = this._interface.getMetadataEntries()
    
    // Calculate totals
    const totalSize = entries.reduce((sum, e) => sum + e.size, 0)
    
    // Count by type
    const byType = {}
    const sizeByType = {}
    entries.forEach(e => {
      byType[e.type] = (byType[e.type] || 0) + 1
      sizeByType[e.type] = (sizeByType[e.type] || 0) + e.size
    })
    
    // Count by app_table
    const byAppTable = {}
    const sizeByAppTable = {}
    entries.forEach(e => {
      const parts = e.namespace.split(':')
      const appTable = parts[1] || 'unknown'
      byAppTable[appTable] = (byAppTable[appTable] || 0) + 1
      sizeByAppTable[appTable] = (sizeByAppTable[appTable] || 0) + e.size
    })
    
    // Get stats from each AppTableCache
    const appTableStats = {}
    this.appTableCaches.forEach((cache, appTable) => {
      appTableStats[appTable] = cache.getStats()
    })
    
    return {
      owner: this.owner,
      totalKeys: keys.length,
      totalSize,
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
      byType,
      sizeByType,
      byAppTable,
      sizeByAppTable,
      appTableStats
    }
  }
  
  /**
   * Get cache preferences for a specific app_table
   * Forwarded from the scoped interface
   */
  getCachePrefsForTable(appTable) {
    return this._interface.getCachePrefsForTable(appTable)
  }
  
  /**
   * List all app_tables with cached data for this user
   */
  listAppTables() {
    const entries = this._interface.getMetadataEntries()
    const appTableMap = new Map()
    
    entries.forEach(meta => {
      const parts = meta.namespace.split(':')
      const appTable = parts[1]
      if (appTable) {
        if (!appTableMap.has(appTable)) {
          appTableMap.set(appTable, { count: 0, size: 0 })
        }
        const stats = appTableMap.get(appTable)
        stats.count++
        stats.size += meta.size
      }
    })
    
    const stats = []
    appTableMap.forEach((data, appTable) => {
      stats.push({
        appTable,
        namespace: `${this.owner}:${appTable}`,
        entryCount: data.count,
        totalSize: data.size,
        totalSizeMB: (data.size / (1024 * 1024)).toFixed(2)
      })
    })
    
    // Sort by size
    stats.sort((a, b) => b.totalSize - a.totalSize)
    
    return stats
  }
  
  // ==================== LOCAL FILE COPY METHODS ====================
  // These forward to the scoped interface (which forwards to CacheManager)
  
  /**
   * Track a file that was copied locally from remote storage
   * @param {string} appName - App name
   * @param {string} partialPath - Path relative to user root
   * @param {string} fileType - Type of file: 'appFile' or 'userFile'
   * @param {number} size - File size in bytes (optional)
   */
  trackLocalFileCopy(appName, partialPath, fileType = 'appFile', size = 0) {
    return this._interface.trackLocalFileCopy(appName, partialPath, fileType, size)
  }
  
  /**
   * Get the lastCopied timestamp for a locally copied file
   * Used to compare against shared cache fileModTime for multi-server consistency
   * @param {string} appName - App name
   * @param {string} partialPath - Path relative to user root
   * @returns {number|null} - Timestamp when file was copied locally, or null if not found
   */
  getLocalFileCopyTime(appName, partialPath) {
    return this._interface.getLocalFileCopyTime(appName, partialPath)
  }
  
  /**
   * Update lastCopied time for a locally copied file (when re-fetched)
   */
  touchLocalFileCopy(appName, partialPath) {
    return this._interface.touchLocalFileCopy(appName, partialPath)
  }
  
  /**
   * Get info about locally copied files for this user
   * @param {string} appName - App name (optional, if not provided returns all apps)
   */
  getLocalFileCopyInfo(appName = null) {
    return this._interface.getLocalFileCopyInfo(appName)
  }
  
  /**
   * Wipe locally copied files for an app from disk
   * @param {string} appName - App name
   * @param {string} rootDir - Root directory path
   * @param {Object} options - Options: { deleteAppFiles, deleteUserFiles, olderThanMs }
   */
  async wipeLocalFileCopy(appName, rootDir, options = {}) {
    return await this._interface.wipeLocalFileCopy(appName, rootDir, options)
  }
  
  /**
   * Wipe all locally copied files for this user (all apps)
   * @param {string} rootDir - Root directory path
   * @param {Object} options - Same as wipeLocalFileCopy
   */
  async wipeLocalFileCopyForUser(rootDir, options = {}) {
    return await this._interface.wipeLocalFileCopyForUser(rootDir, options)
  }
}

export default UserCache
