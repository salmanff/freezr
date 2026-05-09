// freezr.info - Cache Configuration
// Centralized configuration for the caching system

export default {
  // Global cache settings
  enabled: true,
  type: 'memory',  // 'memory' or 'redis' (redis not yet implemented)
  
  // Redis configuration (when type: 'redis')
  redis: {
    host: 'localhost',
    port: 6379,
    password: undefined,
    db: 0,
    keyPrefix: 'freezr:'
  },
  
  // Memory management
  memoryThreshold: 0.8,           // Trigger eviction at 80% heap usage
  memoryCheckInterval: 30000,     // Check memory every 30 seconds
  
  // File caching limits
  maxFileSize: 1024 * 1024,       // Don't cache files larger than 1MB
  
  // TTL (time to live) in seconds for each cache type
  ttl: {
    appFiles: 3600,               // 1 hour for app files
    userFiles: 3600,              // 1 hour for user files
    appFileModTime: 0,            // No TTL - file mod times persist until invalidated
    userFileModTime: 0,           // No TTL - file mod times persist until invalidated
    byKey: 3600,                  // 30 minutes for individual records
    Query: 300,                   // 5 minutes for query results (short!)
    Recent: 86400 * 7,            // 7 days for Recent cache
    All: 86400 * 7                // 7 days for All cache
  },
  
  // Cache population settings
  recentCount: 1000,              // Number of records in Recent cache
  cacheCountMax: 1000,            // Max records to cache for patterned/simple queries
                                  // When caching, we fetch up to this many from DB
                                  // On read, if skip + count > this, bypass cache
  
  // Write debouncing
  invalidationDelay: 1000,        // Wait 1 second after last write before refreshing
  
  // Eviction priority (higher = keep longer)
  evictionPriority: {
    All: 100,                     // Highest - keep as long as possible
    Recent: 90,                   // High priority
    appFileModTime: 80,           // High - needed for multi-server consistency
    userFileModTime: 80,          // High - needed for multi-server consistency
    appFiles: 50,                 // Medium priority
    userFiles: 50,                // Medium priority
    byKey: 40,                    // Lower priority
    Query: 10                     // Lowest - evict first under memory pressure
  },
  
  // Max cache sizes (number of entries)
  maxEntries: {
    All: 10000,                   // Max records in All cache
    Recent: 1000,                 // Max records in Recent cache
    Query: 100,                   // Max different queries to cache
    byKey: 5000,                  // Max individual records
    appFiles: 1000,               // Max app files
    userFiles: 1000,              // Max user files
    appFileModTime: 5000,         // Max app file mod times to track
    userFileModTime: 5000         // Max user file mod times to track
  },
  
  // Access tracking for LRU eviction
  trackAccess: true,
  accessCountWeight: 0.3,         // Weight of access count vs. recency in eviction
  
  // Logging
  logCacheHits: false,            // Set to true for debugging
  logCacheMisses: false,
  logEvictions: true
}
