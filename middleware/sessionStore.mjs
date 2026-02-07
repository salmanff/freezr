// freezr.info - sessionStore.mjs
// Cached file-based session store for Express middleware - built by Clause 2025-10, customized by cursor
// Extends express-session Store for proper compatibility

import { Store } from 'express-session'

/**
 * A session store that keeps an in-memory cache backed by fradminAdminFs
 * Compatible with express-session
 */
class FreezrSessionStore extends Store {
  constructor(options = {}) {
    super(options)
    
    // fradminAdminFs interface
    this.fradminAdminFs = options.fradminAdminFs
    this.prefix = options.prefix || 'session_'
    
    // Configuration
    this.ttl = options.ttl || 15552000000 // 6 months in milliseconds
    this.maxCacheSize = options.maxCacheSize || 1000 // Max sessions in memory
    this.syncInterval = options.syncInterval || 60000 // Sync to disk every minute
    this.cleanupInterval = options.cleanupInterval || 300000 // Cleanup every 5 minutes
    this.maxCleanupFiles = options.maxCleanupFiles || 100 // Max files to clean per run
    this.enableFileCleanup = options.enableFileCleanup !== false // Enable file cleanup by default
    
    // In-memory cache (Map maintains insertion order)
    this.cache = new Map()
    this.dirty = new Set() // Track which sessions need to be written
    
    // Initialize
    this._startSyncTimer()
    this._startCleanupTimer()
  }

  /**
   * Get session by ID
   */
  async get(sid, callback) {
    try {
      // Check cache first
      if (this.cache.has(sid)) {
        const session = this.cache.get(sid)
        
        // Check if expired
        if (session.expires && session.expires < Date.now()) {
          await this.destroy(sid)
          return callback(null, null)
        }
        
        // Move to end (LRU)
        this.cache.delete(sid)
        this.cache.set(sid, session)
        
        return callback(null, session.data)
      }
      
      if (!this.fradminAdminFs) {
        console.error('❌ no fradminAdminFs in sessionStore in get- IGNRING POTENTIALLY DANGEROUS NON LOGGED ERROR - SHOULD ONLY HAPPEN IN STARTUP', { function: 'get' })
        return callback(null, null)
      }
      
      // Load from fradminAdminFs in sessions subdirectory
      const filename = `sessions/${this._generateFilenameFromSessionId(sid)}`
      
      try {
        const data = await this.fradminAdminFs.readUserFile(filename, {})
        const session = JSON.parse(data.toString())
        
        // Check if expired
        if (session.expires && session.expires < Date.now()) {
          this.destroy(sid, () => {})
          return callback(null, null)
        }
        
        // Add to cache
        this._addToCache(sid, session)
        callback(null, session.data)
      } catch (err) {
        if (err.code === 'ENOENT' || err.message?.includes('not found')) {
          return callback(null, null) // Session not found
        }
        callback(err)
      }
    } catch (err) {
      callback(err)
    }
  }

  /**
   * Save session
   */
  async set(sid, session, callback) {
    try {
      const expires = this._getExpiry(session)
      const sessionObj = {
        data: session,
        expires: expires
      }
      
      // Update cache
      this._addToCache(sid, sessionObj)
      if (!this.fradminAdminFs) {
        console.error('❌ no fradminAdminFs in sessionStore in set -  IGNRING POTENTIALLY DANGEROUS NON LOGGED ERROR - SHOULD ONLY HAPPEN IN STARTUP', { function: 'get' })
        return callback(null)
      }
      
      this.dirty.add(sid)
      
      // Write to fradminAdminFs in sessions subdirectory
      const filename = `sessions/${this._generateFilenameFromSessionId(sid)}`
      
      await this.fradminAdminFs.writeToUserFiles(filename, JSON.stringify(sessionObj, null, 2), { doNotOverWrite: false })
      this.dirty.delete(sid)
      callback(null)
    } catch (err) {
      callback(err)
    }
  }

  /**
   * Destroy session
   */
  async destroy(sid, callback) {
    try {
      // Remove from cache
      this.cache.delete(sid)
      this.dirty.delete(sid)
      
      if (!this.fradminAdminFs) {
        console.error('❌ no fradminAdminFs in sessionStore in destroy -  IGNRING POTENTIALLY DANGEROUS NON LOGGED ERROR - SHOULD ONLY HAPPEN IN STARTUP', { function: 'get' })
        return callback(null)
      }
      
      // Remove from fradminAdminFs
      const filename = `sessions/${this._generateFilenameFromSessionId(sid)}`
      
      try {
        await this.fradminAdminFs.removeFile(filename, {})
      } catch (err) {
        // Ignore "not found" errors - file may not exist
        if (err && !err.message?.includes('not found')) {
          throw err
        }
      }
      callback(null)
    } catch (err) {
      callback(err)
    }
  }

  /**
   * Destroy all sessions for a given user id (e.g. after admin password reset).
   * Lists session files, reads each, and destroys those where data.logged_in_user_id === userId.
   * @param {string} userId - User ID whose sessions to destroy
   * @returns {Promise<number>} Number of sessions destroyed
   */
  async destroyAllForUserId(userId) {
    if (!userId) return 0
    if (!this.fradminAdminFs) {
      console.warn('⚠️ destroyAllForUserId: no fradminAdminFs')
      return 0
    }
    let destroyed = 0
    try {
      const sessionFiles = await this._listSessionFiles()
      for (const filename of sessionFiles) {
        try {
          const sessionObj = await this._readSessionFile(filename)
          const sessionUserId = sessionObj?.data?.logged_in_user_id
          if (sessionUserId === userId) {
            const sid = filename.replace(/^session_/, '').replace(/\.json$/, '')
            await new Promise((resolve, reject) => {
              this.destroy(sid, (err) => (err ? reject(err) : resolve()))
            })
            destroyed++
          }
        } catch (err) {
          if (err && !err.message?.includes('not found')) {
            console.warn('⚠️ destroyAllForUserId: error reading/destroying session file', filename, err.message)
          }
        }
      }
      if (destroyed > 0) {
        console.log('✅ destroyAllForUserId: destroyed', destroyed, 'session(s) for userId:', userId)
      }
    } catch (err) {
      console.warn('⚠️ destroyAllForUserId error:', err.message)
    }
    return destroyed
  }

  /**
   * Touch session (update expiry)
   */
  async touch(sid, session, callback) {
    try {
      if (this.cache.has(sid)) {
        const cached = this.cache.get(sid)
        cached.expires = this._getExpiry(session)
        this.dirty.add(sid)
      }
      callback(null)
    } catch (err) {
      callback(err)
    }
  }

  /**
   * Get all session IDs
   */
  async all(callback) {
    try {
      // This would require listing files in fradminAdminFs
      // For now, return empty array
      callback(null, [])
    } catch (err) {
      callback(err)
    }
  }

  /**
   * Get session count
   */
  async length(callback) {
    try {
      // This would require listing files in fradminAdminFs
      // For now, return cache size
      callback(null, this.cache.size)
    } catch (err) {
      callback(err)
    }
  }

  /**
   * Clear all sessions
   */
  async clear(callback) {
    try {
      this.cache.clear()
      this.dirty.clear()
      
      // Note: This would require listing and removing all session files
      // For now, just clear the cache
      callback(null)
    } catch (err) {
      callback(err)
    }
  }

  /**
   * Graceful shutdown - sync all dirty sessions
   */
  async close() {
    if (this.syncTimer) clearInterval(this.syncTimer)
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    await this._syncDirty()
  }

  // Private methods

  _getExpiry(session) {
    if (session && session.cookie && session.cookie.expires) {
      return new Date(session.cookie.expires).getTime()
    }
    return Date.now() + this.ttl
  }

  _addToCache(sid, session) {
    // Implement LRU eviction
    if (this.cache.size >= this.maxCacheSize && !this.cache.has(sid)) {
      const firstKey = this.cache.keys().next().value
      
      // Write evicted session if dirty
      if (this.dirty.has(firstKey)) {
        this._writeSession(firstKey, this.cache.get(firstKey)).catch(() => {})
        this.dirty.delete(firstKey)
      }
      
      this.cache.delete(firstKey)
    }
    
    this.cache.set(sid, session)
  }


  async _writeSession(sid, session) {
    const filename = `sessions/${this._generateFilenameFromSessionId(sid)}`
    // writeToUserFiles is async
    await this.fradminAdminFs.writeToUserFiles(filename, JSON.stringify(session, null, 2), { doNotOverWrite: false })
    this.dirty.delete(sid)
  }

  async _syncDirty() {
    const promises = []
    
    for (const sid of this.dirty) {
      if (this.cache.has(sid)) {
        promises.push(this._writeSession(sid, this.cache.get(sid)))
      }
    }
    
    await Promise.allSettled(promises)
  }

  async _cleanup() {
    const now = Date.now()
    
    // Cleanup cache
    for (const [sid, session] of this.cache.entries()) {
      if (session.expires && session.expires < now) {
        this.cache.delete(sid)
        this.dirty.delete(sid)
      }
    }
      
    // Cleanup expired session files from fradminAdminFs
    await this._cleanupExpiredFiles(now)
  }

  async _cleanupExpiredFiles(now) {
    if (!this.enableFileCleanup) {
      return // File cleanup is disabled
    }

    try {
      // List all session files in the sessions directory
      const sessionFiles = await this._listSessionFiles()
      
      if (sessionFiles.length === 0) {
        return // No session files to clean
      }

      console.log(`🧹 Starting cleanup of ${sessionFiles.length} session files...`)
      
      let cleanedCount = 0
      let processedCount = 0
      
      // Convert current time to YYYYMMDD format for comparison
      const currentDateStr = this._formatDateForFilename(now)
      
      for (const filename of sessionFiles) {
        // console.log('🧹 Processing session file #: ' + processedCount + ' of ' + sessionFiles.length + ' - ' + filename)

        // Limit the number of files processed per cleanup run
        if (processedCount >= this.maxCleanupFiles) {
          console.log(`🧹 Reached max cleanup limit (${this.maxCleanupFiles}), stopping cleanup after cleaning ${cleanedCount} files`)
          break
        }
        
        processedCount++
        
        // Extract expiry date from filename (format: session_YYYYMMDD_xxxxx.json)
        const expiryDateStr = this._extractExpiryFromFilename(filename)
        
        if (expiryDateStr && expiryDateStr < currentDateStr) {
          // Session is expired based on filename, remove the file
          try {
            await this._removeSessionFile(filename)
            cleanedCount++
            console.log(`🧹 Cleaned up expired session file: ${filename}`)
          } catch (removeErr) {
            console.warn(`⚠️ Could not remove session file ${filename}:`, removeErr.message)
          }
        }
      }
      
      if (cleanedCount > 0) {
        console.log(`🧹 Cleanup completed: removed ${cleanedCount} expired session files`)
      }
    } catch (err) {
      console.warn('⚠️ Session file cleanup error:', err.message)
    }
  }

  async _listSessionFiles() {
    try {
      const files = await this.fradminAdminFs.readUserDir('sessions/', {}) // not listFiles
      
      // Filter for session files with our prefix
      const sessionFiles = files.filter(file => 
        file.startsWith(this.prefix) && file.endsWith('.json')
      )
      
      // Sort by expiry date (oldest first)
      sessionFiles.sort((a, b) => {
        const dateA = this._extractExpiryFromFilename(a)
        const dateB = this._extractExpiryFromFilename(b)
        
        if (dateA && dateB) {
          return dateA.localeCompare(dateB)
        }
        return a.localeCompare(b)
      })
      
      return sessionFiles
    } catch (err) {
      console.warn('⚠️ Error listing session files:', err.message)
      return []
    }
  }

  async _readSessionFile(filename) {
    // readUserFile is async
    const data = await this.fradminAdminFs.readUserFile(`sessions/${filename}`, {})
    return JSON.parse(data.toString())
  }

  async _removeSessionFile(filename) {
    // removeFile is async (from modern dsManager)
    await this.fradminAdminFs.removeFile(`sessions/${filename}`, {})
  }

  /**
   * Format a timestamp to YYYYMMDD format for filename
   */
  _formatDateForFilename(timestamp) {
    const date = new Date(timestamp)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}${month}${day}`
  }

  /**
   * Extract expiry date from filename (format: session_YYYYMMDD_xxxxx.json)
   */
  _extractExpiryFromFilename(filename) {
    // Expected format: session_YYYYMMDD_xxxxx.json
    const match = filename.match(/^session_(\d{8})_/)
    return match ? match[1] : null
  }

  /**
   * Generate a session ID with expiry date prefix
   */
  generateSessionId(expires) {
    const expiryDateStr = this._formatDateForFilename(expires)
    const randomId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
    return `${expiryDateStr}_${randomId}`
  }

  /**
   * Extract expiry date from session ID
   */
  _extractExpiryFromSessionId(sid) {
    // Expected format: YYYYMMDD_xxxxxxxxxxxxxx
    const match = sid.match(/^(\d{8})_/)
    return match ? match[1] : null
  }

  /**
   * Generate filename from session ID (which already contains expiry date)
   */
  _generateFilenameFromSessionId(sid) {
    return `${this.prefix}${sid}.json`
  }

  /**
   * Override session ID generation to include expiry date
   * This is called by express-session when creating new sessions
   */
  generate(session) {
    const expires = this._getExpiry(session)
    return this.generateSessionId(expires)
  }

  _startSyncTimer() {
    this.syncTimer = setInterval(() => {
      this._syncDirty().catch(err => {
        console.error('Session sync error:', err)
      })
    }, this.syncInterval)
  }

  _startCleanupTimer() {
    this.cleanupTimer = setInterval(() => {
      this._cleanup().catch(err => {
        console.error('Session cleanup error:', err)
      })
    }, this.cleanupInterval)
  }

}

export default FreezrSessionStore

