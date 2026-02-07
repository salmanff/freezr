// freezr.info - Auth Rate Limiter AuthRateLimiter.mjs
// Tracks failed authentication attempts by IP, device, and user
// Provides rate limiting to prevent brute force attacks
//
// Architecture:
// - Pluggable storage: defaults to in-memory, can use CacheManager for multi-server
// - Pre-bound request guards via createRequestGuard() for clean controller API
// - Used for login, token validation, and API auth attempts

export class AuthRateLimiter {
  constructor(options = {}) {
    // Rate limiting rules (can be updated via setRules)
    this.rules = {
      maxAttemptsPerIp: options.maxAttemptsPerIp || 5,
      maxAttemptsPerDevice: options.maxAttemptsPerDevice || 5,
      maxAttemptsPerUser: options.maxAttemptsPerUser || 10,
      windowMs: options.windowMs || 60 * 1000,                    // 1 minute window
      blockDurationMs: options.blockDurationMs || 5 * 60 * 1000,  // 5 minute block
    }
    
    // PLUGGABLE STORAGE: use provided store or default to in-memory
    // Store interface: { get(key), set(key, value, opts), delete(key) }
    // Compatible with CacheManager for multi-server setups
    this.store = options.store || this._createInMemoryStore()
    this.keyPrefix = options.keyPrefix || 'authRate:'
    
    // Optional callback for logging failures (can hook into FLogger)
    this.onFailure = options.onFailure || null
    this.onBlock = options.onBlock || null
    
    // Cleanup timer reference (for shutdown)
    this._cleanupTimer = null
  }

  /**
   * Create a simple in-memory store with TTL support
   * Used when no external store (like CacheManager) is provided
   */
  _createInMemoryStore() {
    const map = new Map()
    const ttls = new Map()
    
    // Periodic cleanup of expired entries (every 60 seconds)
    this._cleanupTimer = setInterval(() => {
      const now = Date.now()
      for (const [key, expiry] of ttls) {
        if (now > expiry) {
          map.delete(key)
          ttls.delete(key)
        }
      }
    }, 60000)
    
    // Don't let cleanup timer prevent process exit
    if (this._cleanupTimer.unref) {
      this._cleanupTimer.unref()
    }
    
    return {
      get: (key) => {
        const expiry = ttls.get(key)
        if (expiry && Date.now() > expiry) {
          map.delete(key)
          ttls.delete(key)
          return null
        }
        return map.get(key) || null
      },
      set: (key, value, opts = {}) => {
        map.set(key, value)
        if (opts.ttl) {
          // ttl is in seconds, convert to ms for expiry timestamp
          ttls.set(key, Date.now() + (opts.ttl * 1000))
        }
      },
      delete: (key) => {
        map.delete(key)
        ttls.delete(key)
      }
    }
  }

  // Key generation for different tracking types
  _ipKey(ip) { return `${this.keyPrefix}ip:${ip}` }
  _deviceKey(device) { return `${this.keyPrefix}device:${device}` }
  _userKey(user) { return `${this.keyPrefix}user:${user}` }
  _blockKey(type, id) { return `${this.keyPrefix}block:${type}:${id}` }

  /**
   * Check if a request is rate limited
   * Call this BEFORE attempting authentication
   * 
   * @param {string} ip - IP address
   * @param {string} deviceCode - Device identifier (from session)
   * @param {string} accessPoint - e.g., 'login', 'tokenRefresh', 'apiToken'
   * @returns {{ allowed: boolean, retryAfter?: number, reason?: string }}
   */
  check(ip, deviceCode, accessPoint) {
    const now = Date.now()
    
    // Check if explicitly blocked (IP)
    const ipBlock = this.store.get(this._blockKey('ip', ip))
    if (ipBlock && now < ipBlock) {
      return { 
        allowed: false, 
        retryAfter: Math.ceil((ipBlock - now) / 1000), 
        reason: 'ip_blocked' 
      }
    }
    
    // Check if explicitly blocked (device)
    if (deviceCode) {
      const deviceBlock = this.store.get(this._blockKey('device', deviceCode))
      if (deviceBlock && now < deviceBlock) {
        return { 
          allowed: false, 
          retryAfter: Math.ceil((deviceBlock - now) / 1000), 
          reason: 'device_blocked' 
        }
      }
    }
    
    // Count recent attempts within window
    const windowStart = now - this.rules.windowMs
    
    // Check IP attempts
    const ipAttempts = this._getRecentAttempts(this._ipKey(ip), windowStart)
    if (ipAttempts >= this.rules.maxAttemptsPerIp) {
      return { 
        allowed: false, 
        retryAfter: Math.ceil(this.rules.windowMs / 1000), 
        reason: 'too_many_ip_attempts' 
      }
    }
    
    // Check device attempts
    if (deviceCode) {
      const deviceAttempts = this._getRecentAttempts(this._deviceKey(deviceCode), windowStart)
      if (deviceAttempts >= this.rules.maxAttemptsPerDevice) {
        return { 
          allowed: false, 
          retryAfter: Math.ceil(this.rules.windowMs / 1000), 
          reason: 'too_many_device_attempts' 
        }
      }
    }
    
    return { allowed: true }
  }

  /**
   * Get count of recent attempts from stored array
   */
  _getRecentAttempts(key, windowStart) {
    const attempts = this.store.get(key) || []
    return attempts.filter(ts => ts >= windowStart).length
  }

  /**
   * Record a failed authentication attempt
   * Call this AFTER a failed authentication
   * 
   * @param {string} accessPoint - e.g., 'login', 'tokenRefresh', 'apiToken'
   * @param {Object} metaData - Request metadata (reqIp, device, user, etc.)
   */
  recordFailure(accessPoint, metaData) {
    const ip = metaData.reqIp
    const deviceCode = metaData.device
    const userId = metaData.user
    
    const now = Date.now()
    // TTL should cover window + block duration to ensure data persists long enough
    const ttlSeconds = Math.ceil((this.rules.windowMs + this.rules.blockDurationMs) / 1000)
    
    // Record IP attempt
    const ipAttempts = this.store.get(this._ipKey(ip)) || []
    ipAttempts.push(now)
    // Clean old attempts while we're here
    const windowStart = now - this.rules.windowMs - this.rules.blockDurationMs
    const cleanedIpAttempts = ipAttempts.filter(ts => ts >= windowStart)
    this.store.set(this._ipKey(ip), cleanedIpAttempts, { ttl: ttlSeconds })
    
    // Record device attempt
    if (deviceCode) {
      const deviceAttempts = this.store.get(this._deviceKey(deviceCode)) || []
      deviceAttempts.push(now)
      const cleanedDeviceAttempts = deviceAttempts.filter(ts => ts >= windowStart)
      this.store.set(this._deviceKey(deviceCode), cleanedDeviceAttempts, { ttl: ttlSeconds })
    }
    
    // Record user attempt (for tracking patterns, not blocking)
    if (userId) {
      const userAttempts = this.store.get(this._userKey(userId)) || []
      userAttempts.push(now)
      const cleanedUserAttempts = userAttempts.filter(ts => ts >= windowStart)
      this.store.set(this._userKey(userId), cleanedUserAttempts, { ttl: ttlSeconds })
    }
    
    // Check if should block
    this._maybeBlock(metaData, now)
    
    // Optional logging callback (passes metaData for consistent logging context)
    if (this.onFailure) {
      this.onFailure(metaData, { accessPoint, timestamp: now })
    }
  }

  /**
   * Check if thresholds are exceeded and set blocks
   */
  _maybeBlock(metaData, now) {
    const ip = metaData.reqIp
    const deviceCode = metaData.device

    const windowStart = now - this.rules.windowMs
    const blockUntil = now + this.rules.blockDurationMs
    const ttlSeconds = Math.ceil(this.rules.blockDurationMs / 1000)
    
    // Check and block IP
    const ipAttempts = this._getRecentAttempts(this._ipKey(ip), windowStart)
    if (ipAttempts >= this.rules.maxAttemptsPerIp) {
      this.store.set(this._blockKey('ip', ip), blockUntil, { ttl: ttlSeconds })
      if (this.onBlock) {
        this.onBlock(metaData, { type: 'ip', id: ip, until: blockUntil })
      }
    }
    
    // Check and block device
    if (deviceCode) {
      const deviceAttempts = this._getRecentAttempts(this._deviceKey(deviceCode), windowStart)
      if (deviceAttempts >= this.rules.maxAttemptsPerDevice) {
        this.store.set(this._blockKey('device', deviceCode), blockUntil, { ttl: ttlSeconds })
        if (this.onBlock) {
          this.onBlock(metaData, { type: 'device', id: deviceCode, until: blockUntil })
        }
      }
    }
  }

  /**
   * Check only if IP/device is explicitly blocked (not attempt counts)
   * Used at middleware level for early rejection of blocked IPs/devices
   * 
   * @param {string} ip - IP address
   * @param {string} deviceCode - Device identifier
   * @returns {{ allowed: boolean, retryAfter?: number, reason?: string }}
   */
  checkBlock(ip, deviceCode) {
    const now = Date.now()
    
    // Check if IP is explicitly blocked
    const ipBlock = this.store.get(this._blockKey('ip', ip))
    if (ipBlock && now < ipBlock) {
      // console.log('ip_blocked checkBlock called ', ip, ipBlock, now)
      return { 
        allowed: false, 
        retryAfter: Math.ceil((ipBlock - now) / 1000), 
        reason: 'ip_blocked' 
      }
    }
    
    // Check if device is explicitly blocked
    if (deviceCode) {
      const deviceBlock = this.store.get(this._blockKey('device', deviceCode))
      if (deviceBlock && now < deviceBlock) {
        return { 
          allowed: false, 
          retryAfter: Math.ceil((deviceBlock - now) / 1000), 
          reason: 'device_blocked' 
        }
      }
    }
    
    return { allowed: true }
  }

  /**
   * Create a request-scoped guard with request metadata pre-bound
   * This is what gets attached to res.locals.authGuard
   * 
   * @param {Object} metaData - Request metadata (same as FLogger metadata)
   * @param {string} metaData.reqId - Request ID
   * @param {string} metaData.reqIp - IP address
   * @param {string} metaData.method - HTTP method
   * @param {string} metaData.path - Request path
   * @param {string} metaData.user - Logged in user ID (if any)
   * @param {string} metaData.device - Device code from session
   * @returns {{ check: Function, checkBlock: Function, recordFailure: Function }}
   */
  createRequestGuard(metaData) {
    const ip = metaData.reqIp
    const deviceCode = metaData.device
    
    return {
      /**
       * Check if IP/device is explicitly blocked (middleware-level check)
       * @returns {{ allowed: boolean, retryAfter?: number, reason?: string }}
       */
      checkBlock: () => this.checkBlock(ip, deviceCode),
      
      /**
       * Check if rate limited for this access point (includes block check + attempt counts)
       * @param {string} accessPoint - e.g., 'login', 'tokenRefresh'
       * @returns {{ allowed: boolean, retryAfter?: number, reason?: string }}
       */
      check: (accessPoint) => this.check(ip, deviceCode, accessPoint),
      
      /**
       * Record a failed attempt
       * @param {string} accessPoint - e.g., 'login', 'tokenRefresh'
       */
      recordFailure: (accessPoint) => this.recordFailure(accessPoint, metaData)
    }
  }

  /**
   * Update rate limiting rules (for admin configuration)
   * @param {Object} newRules - Partial rules to update
   */
  setRules(newRules) {
    this.rules = { ...this.rules, ...newRules }
  }

  /**
   * Get current rules (for admin display)
   */
  getRules() {
    return { ...this.rules }
  }

  /**
   * Clear all rate limiting data (admin function)
   */
  clearAll() {
    // This only works for in-memory store
    // For CacheManager, would need to implement pattern-based deletion
    console.log('[AuthRateLimiter] Clearing all rate limit data')
  }

  /**
   * Shutdown - clean up timers
   */
  shutdown() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer)
      this._cleanupTimer = null
    }
  }
}

export default AuthRateLimiter

