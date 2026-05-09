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

    // Lazy filename index: random-part-of-sid -> 'session_YYYYMMDD_<random>.json'
    // Lets us find a session's current filename on disk after it has been
    // renamed due to a rolling-expiry extension. Built lazily on first miss.
    this.randomToFilename = new Map()
    this.randomToFilenameBuilt = false
    
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
      
      // Resolve the current filename for this sid (may have been renamed
      // when the session was extended). Falls back to canonical session_<sid>.json.
      const filename = `sessions/${await this._findFilenameForSid(sid)}`

      try {
        // nocache: true so a corrupt entry in the in-memory or local-disk cache
        // doesn't keep poisoning every request. We re-cache below on success.
        const data = await this.fradminAdminFs.readUserFile(filename, { nocache: true })
        const dataStr = data == null ? '' : (typeof data === 'string' ? data : data.toString())

        // Empty / whitespace / "null" cache values are treated as a missing
        // session. We deliberately keep the (possibly empty) value cached so
        // we don't hammer storage on every request - express-session will just
        // generate a fresh session for this request.
        if (!dataStr || !dataStr.trim() || dataStr.trim() === 'null') {
          return callback(null, null)
        }

        let session
        try {
          session = JSON.parse(dataStr)
        } catch (parseErr) {
          // Corrupt JSON: log once at warn level, treat as missing session.
          // Express-session will generate a new session. The bad file will be
          // reaped by the date-based cleanup once its filename date passes.
          console.warn('⚠️ sessionStore.get: corrupt session JSON, treating as missing', {
            filename,
            length: dataStr.length,
            preview: dataStr.slice(0, 80),
            error: parseErr.message
          })
          return callback(null, null)
        }

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
   * 
   * PRIVACY NOTE: Sessions are only persisted when they contain authenticated user data.
   * This keeps public/anonymous visits fully stateless - no session files, no tracking.
   * Sessions are only created and persisted when a user logs in (logged_in_user_id is set).
   */
  async set(sid, session, callback) {
    try {
      // Only persist sessions with authenticated users
      // This prevents creating files for anonymous public visitors
      // and keeps public browsing fully stateless (no tracking)
      if (!session.logged_in_user_id) {
        return callback(null)
      }

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

      // Guard: never persist an empty / unserializable payload. This is what
      // produces 0-byte session files that later blow up JSON.parse on read.
      let serialized
      try {
        serialized = JSON.stringify(sessionObj, null, 2)
      } catch (serErr) {
        console.error('❌ sessionStore.set: failed to serialize session, skipping write', { sid, error: serErr.message })
        this.dirty.delete(sid)
        return callback(null)
      }
      if (!serialized || serialized.length < 2) {
        console.error('❌ sessionStore.set: refusing to write empty session payload', { sid, length: serialized ? serialized.length : 0 })
        this.dirty.delete(sid)
        return callback(null)
      }

      // Compute new filename based on the current expiry, and find the
      // previous filename (if any) so we can delete it if the date changed.
      // Filename = session_<currentExpiryDate>_<random>.json. Cleanup uses the
      // date prefix, so keeping it in sync with the actual expiry prevents
      // valid sessions from being deleted prematurely.
      const newFilenameBase = this._filenameForSidAndExpiry(sid, expires)
      const oldFilenameBase = await this._findFilenameForSid(sid)
      const newFilenameFull = `sessions/${newFilenameBase}`

      await this.fradminAdminFs.writeToUserFiles(newFilenameFull, serialized, { doNotOverWrite: false })
      this._rememberFilename(sid, newFilenameBase)
      this.dirty.delete(sid)

      // If the date prefix changed, the session was extended into a new day -
      // remove the previous file so cleanup keeps working off filename dates.
      if (oldFilenameBase && oldFilenameBase !== newFilenameBase) {
        try {
          await this.fradminAdminFs.removeFile(`sessions/${oldFilenameBase}`, {})
        } catch (rmErr) {
          if (rmErr && !rmErr.message?.includes('not found') && rmErr.code !== 'ENOENT') {
            console.warn('⚠️ sessionStore.set: failed to remove previous filename after rename', { oldFilenameBase, newFilenameBase, error: rmErr.message })
          }
        }
      }

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
      
      // Resolve the current filename - sessions may have been renamed when
      // they were extended, so we can't assume session_<sid>.json.
      const filenameBase = await this._findFilenameForSid(sid)
      const filename = `sessions/${filenameBase}`

      try {
        await this.fradminAdminFs.removeFile(filename, {})
      } catch (err) {
        // Ignore "not found" errors - file may not exist
        if (err && !err.message?.includes('not found')) {
          throw err
        }
      }
      // Drop from filename index (also try canonical, in case index was wrong)
      this._forgetFilename(sid)
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
          if (!sessionObj) continue // empty/corrupt - skip; cleanup will remove if expired
          const sessionUserId = sessionObj?.data?.logged_in_user_id
          if (sessionUserId === userId) {
            // Filename may have been renamed (date prefix updated when session
            // was extended), so we can't reconstruct the sid reliably. Delete
            // the file directly and clear any matching cache entries.
            await this._destroyByFilename(filename)
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
    // Same rename-on-extension logic as set(). session here is the
    // cached object: { data, expires }.
    const expires = session && session.expires ? session.expires : this._getExpiry(session?.data)
    const newFilenameBase = this._filenameForSidAndExpiry(sid, expires)
    const oldFilenameBase = await this._findFilenameForSid(sid)

    const serialized = JSON.stringify(session, null, 2)
    if (!serialized || serialized.length < 2) {
      console.error('❌ sessionStore._writeSession: refusing to write empty session payload', { sid })
      this.dirty.delete(sid)
      return
    }

    await this.fradminAdminFs.writeToUserFiles(`sessions/${newFilenameBase}`, serialized, { doNotOverWrite: false })
    this._rememberFilename(sid, newFilenameBase)
    this.dirty.delete(sid)

    if (oldFilenameBase && oldFilenameBase !== newFilenameBase) {
      try {
        await this.fradminAdminFs.removeFile(`sessions/${oldFilenameBase}`, {})
      } catch (rmErr) {
        if (rmErr && !rmErr.message?.includes('not found') && rmErr.code !== 'ENOENT') {
          console.warn('⚠️ sessionStore._writeSession: failed to remove previous filename after rename', { oldFilenameBase, newFilenameBase, error: rmErr.message })
        }
      }
    }
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
          // Session is expired based on filename, remove the file (and clear
          // any matching in-memory cache entries so we don't serve a stale copy)
          try {
            await this._destroyByFilename(filename)
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
    const dataStr = data == null ? '' : (typeof data === 'string' ? data : data.toString())
    if (!dataStr || !dataStr.trim() || dataStr.trim() === 'null') {
      // Empty or null payload - treat as missing rather than throwing
      console.warn('⚠️ sessionStore._readSessionFile: empty payload', { filename })
      return null
    }
    try {
      return JSON.parse(dataStr)
    } catch (parseErr) {
      console.warn('⚠️ sessionStore._readSessionFile: corrupt JSON', { filename, length: dataStr.length, preview: dataStr.slice(0, 80), error: parseErr.message })
      return null
    }
  }

  async _removeSessionFile(filename) {
    // removeFile is async (from modern dsManager)
    await this.fradminAdminFs.removeFile(`sessions/${filename}`, {})
  }

  /**
   * Remove a session by its on-disk filename. Used by cleanup and by
   * destroyAllForUserId, both of which iterate files (where the sid that's in
   * the user's cookie may not be reconstructible from the renamed filename).
   * Also clears any in-memory cache entries that match the file's random part.
   */
  async _destroyByFilename(filenameBase) {
    const m = filenameBase.match(/^session_\d{8}_(.+)\.json$/)
    const random = m ? m[1] : null

    if (random) {
      for (const [sid] of this.cache) {
        if (this._extractRandomFromSid(sid) === random) {
          this.cache.delete(sid)
          this.dirty.delete(sid)
        }
      }
      this.randomToFilename.delete(random)
    }

    try {
      await this.fradminAdminFs.removeFile(`sessions/${filenameBase}`, {})
    } catch (err) {
      if (err && !err.message?.includes('not found') && err.code !== 'ENOENT') {
        throw err
      }
    }
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
   * Generate filename from session ID (which already contains expiry date).
   * Used as the canonical fallback - the actual filename on disk may have
   * been renamed if the session was extended (see _filenameForSidAndExpiry).
   */
  _generateFilenameFromSessionId(sid) {
    return `${this.prefix}${sid}.json`
  }

  /**
   * Extract the random/non-date portion of a sid.
   * sid format: <YYYYMMDD>_<random>
   * Returns the <random> part, or the full sid if no date prefix is present.
   */
  _extractRandomFromSid(sid) {
    if (!sid) return null
    const m = sid.match(/^(\d{8})_(.+)$/)
    return m ? m[2] : sid
  }

  /**
   * Compute the filename for a sid given a specific (possibly extended) expiry.
   * Format: session_<YYYYMMDD-of-expiry>_<random>.json
   * For freshly-created sessions this equals session_<sid>.json (since the
   * sid already encodes the initial expiry). For sessions that have been
   * extended via a save, the date prefix moves forward and the file is renamed.
   */
  _filenameForSidAndExpiry(sid, expires) {
    const expiryDateStr = this._formatDateForFilename(expires)
    const random = this._extractRandomFromSid(sid)
    return `${this.prefix}${expiryDateStr}_${random}.json`
  }

  /**
   * Build a one-time random->filename index from the sessions directory.
   * Lets us find the current on-disk filename for a sid after process restart
   * without doing a directory scan on every cache miss.
   */
  async _ensureFilenameIndex() {
    if (this.randomToFilenameBuilt) return
    if (!this.fradminAdminFs) return
    try {
      const files = await this._listSessionFiles()
      this.randomToFilename.clear()
      for (const f of files) {
        const m = f.match(/^session_\d{8}_(.+)\.json$/)
        if (m) this.randomToFilename.set(m[1], f)
      }
      this.randomToFilenameBuilt = true
    } catch (err) {
      console.warn('⚠️ sessionStore: failed to build filename index, will retry', err.message)
      // Don't mark as built - next call will retry
    }
  }

  /**
   * Resolve the current on-disk filename (basename, not including 'sessions/')
   * for a sid. Falls back to canonical session_<sid>.json if no match is found.
   */
  async _findFilenameForSid(sid) {
    const random = this._extractRandomFromSid(sid)
    if (random && this.randomToFilename.has(random)) {
      return this.randomToFilename.get(random)
    }
    await this._ensureFilenameIndex()
    if (random && this.randomToFilename.has(random)) {
      return this.randomToFilename.get(random)
    }
    // Fallback to canonical - works for sessions that have never been renamed.
    return this._generateFilenameFromSessionId(sid)
  }

  _rememberFilename(sid, filenameBase) {
    const random = this._extractRandomFromSid(sid)
    if (random) this.randomToFilename.set(random, filenameBase)
  }

  _forgetFilename(sid) {
    const random = this._extractRandomFromSid(sid)
    if (random) this.randomToFilename.delete(random)
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

