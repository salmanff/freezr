# Cache System Integration Guide (Updated with UserCache)

## Files Created

```
freezr_system/
  cache/
    cacheConfig.mjs         # Configuration constants
    cacheManager.mjs        # Global singleton managing all caches
    userCache.mjs           # Per-user cache intermediary
    appTableCache.mjs       # Per user:app_table wrapper
    queryMatcher.mjs        # Query hashing and filtering
```

## Architecture Summary

```
DATA_STORE_MANAGER
  └─ cacheManager (singleton)
      └─ createUserInterface(owner) → scoped interface
          └─ USER_DS (per user)
              └─ userCache (per user, uses scoped interface)
                  └─ _createAppTableInterface(appTable) → scoped interface
                      └─ AppTableCache (per app_table, uses scoped interface)
```

**Security**: Each level receives a scoped interface with owner/namespace baked in via closures. Cannot access other users' or tables' data.

## Integration Steps

### 1. Initialize CacheManager in dsManager.mjs

```javascript
// At the top of dsManager.mjs
import CacheManager from './cache/cacheManager.mjs'

function DATA_STORE_MANAGER () {
  const self = this
  
  // Add cache manager as a property
  self.cacheManager = new CacheManager()
  
  self.freezrIsSetup = false
  self.users = {}
  // ... rest of existing code
}
```

### 2. Pass Scoped Cache Interface to USER_DS

```javascript
// In dsManager.mjs, modify setSystemUserDS and getOrSetUserDS
self.setSystemUserDS = function (owner, env) {
  // ... existing validation code ...
  
  // Create scoped interface for security (owner baked in)
  const scopedInterface = self.cacheManager.createUserInterface(owner)
  self.userCaches[owner] = new UserCache(scopedInterface, owner)
  env.userCache = self.userCaches[owner]
  
  self.users[owner] = new USER_DS(owner, env)
  return self.users[owner]
}

self.getOrSetUserDS = async function (owner, options) {
  // ... existing code ...
  
  // Create scoped interface for security (owner baked in)
  if (!self.userCaches[owner]) {
    const scopedInterface = self.cacheManager.createUserInterface(owner)
    self.userCaches[owner] = new UserCache(scopedInterface, owner)
  }
  
  self.users[owner] = new USER_DS(
    owner, 
    { 
      dbParams, fsParams, slParams, 
      limits: ownerEntries[0].limits, 
      userPrefs: ownerEntries[0].userPrefs,
      userCache: self.userCaches[owner]  // Pass UserCache, not CacheManager
    }
  )
  // ... rest of code
}
```

### 3. Update USER_DS Constructor in userDsMgr.mjs

```javascript
// At top of userDsMgr.mjs
import UserCache from './cache/userCache.mjs'

function USER_DS (owner, env) {
  const self = this
  
  // ... existing validation and property setup ...
  
  this.owner = owner
  this.appcoll = {}
  this.dbPersistenceManager = { /* ... */ }
  this.appfiles = {}
  
  // USE USER CACHE from env (created at dsManager level with scoped interface)
  if (env.userCache) {
    this.userCache = env.userCache
  }
}
```

### 4. Integrate Cache in initOacDB

```javascript
USER_DS.prototype.initOacDB = async function (OAC, options = {}) {
  // ... existing code up to where ds object is created ...
  
  const ds = this.appcoll[appTableName(OAC)]
  
  // CREATE APPTABLE CACHE using UserCache
  if (this.userCache) {
    // Get cache preferences (includes cachePatterns)
    const cachePrefs = this.userCache.getCachePrefsForTable(appTableName(OAC))
    const cacheConfig = {
      cacheAll: options.cacheAll !== undefined ? options.cacheAll : cachePrefs.cacheAll,
      cacheRecent: options.cacheRecent !== undefined ? options.cacheRecent : (cachePrefs.cacheRecent !== false),
      cachePatterns: options.cachePatterns !== undefined ? options.cachePatterns : cachePrefs.cachePatterns
    }
    
    ds.cache = this.userCache.getOrCreateAppTableCache(
      appTableName(OAC),
      cacheConfig
    )
    
    // Set up refresh function for cache
    ds.cache.setRefreshFunction(async (dirtyFlags) => {
      try {
        if (dirtyFlags.All && ds.cache.cacheAll) {
          // Refresh All cache
          const allRecords = await ds.db.query_async({}, {})
          await ds.cache.setAll(allRecords)
        }
        
        if (dirtyFlags.Recent && ds.cache.cacheRecent) {
          // Refresh Recent cache
          const recentRecords = await ds.db.query_async({}, {
            sort: { _date_modified: -1 },
            limit: ds.cache.config.recentCount
          })
          await ds.cache.setRecent(recentRecords)
        }
      } catch (err) {
        console.warn('Error in cache refresh function:', err.message)
      }
    })
  }
  
  // ... existing db initialization code ...
  
  // WRAP QUERY METHOD
  const originalQueryAsync = ds.db.query_async
  ds.query = async function (query, options = {}) {
    // Try cache first
    if (ds.cache) {
      const cached = await ds.cache.query(query, options)
      if (cached !== null) {
        return cached
      }
    }
    
    // Cache miss - hit DB
    ds.dbLastAccessed = new Date().getTime()
    const results = await originalQueryAsync.call(ds.db, query, options)
    
    // Store in cache
    if (ds.cache && results) {
      await ds.cache.setQuery(query, results, options)
    }
    
    return results
  }
  
  // WRAP CREATE METHOD
  const originalCreate = ds.create
  ds.create = async function (id, entity, options = {}) {
    const result = await originalCreate.call(ds, id, entity, options)
    
    // Update caches
    if (ds.cache && result._id) {
      const cachedEntity = { ...entity, _id: result._id }
      ds.cache.setByKey('_id', result._id, cachedEntity)
      ds.cache.markDirty(result._id)
    }
    
    return result
  }
  
  // WRAP UPDATE METHOD
  const originalUpdate = ds.update
  ds.update = async function (idOrQuery, updatesToEntity, options = {}) {
    const result = await originalUpdate.call(ds, idOrQuery, updatesToEntity, options)
    
    // Invalidate cache
    if (ds.cache) {
      if (typeof idOrQuery === 'string') {
        ds.cache.markDirty(idOrQuery)
      } else if (idOrQuery._id) {
        ds.cache.markDirty(idOrQuery._id)
      } else {
        ds.cache.markDirty()  // Invalidate all
      }
    }
    
    return result
  }
  
  // WRAP DELETE METHODS
  const originalDeleteRecord = ds.delete_record
  ds.delete_record = async function (idOrQuery, options = {}) {
    const result = await originalDeleteRecord.call(ds, idOrQuery, options)
    
    // Invalidate cache
    if (ds.cache && typeof idOrQuery === 'object' && idOrQuery._id) {
      ds.cache.markDirty(idOrQuery._id)
    }
    
    return result
  }
  
  const originalDeleteRecords = ds.delete_records
  ds.delete_records = async function (idOrQuery, options = {}) {
    const result = await originalDeleteRecords.call(ds, idOrQuery, options)
    
    if (ds.cache) {
      ds.cache.markDirty()  // Invalidate all on multi-delete
    }
    
    return result
  }
  
  // ... rest of existing code ...
  
  return ds
}
```

### 5. Integrate File Caching in initAppFS

```javascript
USER_DS.prototype.initAppFS = async function (appName, options = {}) {
  // ... existing code up to where ds object is created ...
  
  const ds = this.appfiles[appName]
  
  // Reuse cache from app_table (or create new one)
  if (this.userCache && !ds.cache) {
    ds.cache = this.userCache.getOrCreateAppTableCache(appName, {})
  }
  
  // ... existing fs initialization code ...
  
  ds.readAppFile = async function (endpath, options = {}) {
    // Check cache first (if not a system app)
    if (!isSystemApp && ds.cache) {
      const cached = ds.cache.getFile(endpath)
      if (cached !== null) {
        return cached
      }
    }
    
    // ... existing file read logic ...
    const content = // ... your existing read logic
    
    // Cache the file (if not too large and not a system app)
    if (!isSystemApp && ds.cache && content) {
      ds.cache.setFile(endpath, content)
    }
    
    return content
  }
  
  ds.writeToUserFiles = async function (endpath, content, options = {}) {
    // ... existing write logic ...
    
    // Invalidate cache on write
    if (ds.cache) {
      ds.cache.deleteFile(endpath)
    }
    
    return name
  }
  
  // Similarly for other file methods (removeFile, writeToAppFiles, etc.)
  // Add ds.cache.deleteFile(endpath) calls on writes/deletes
  
  // ... rest of existing code ...
}
```

## Usage Examples

### Basic Query (will use cache automatically)

```javascript
const db = await dsManager.getorInitDb({ 
  owner: 'alice', 
  app_name: 'blog', 
  collection_name: 'posts' 
})

// This will check cache, then DB if needed
const posts = await db.query({ status: 'published' })
```

### Enable All Cache for Small Collections

```javascript
const db = await dsManager.initOacDB({ 
  owner: 'alice', 
  app_name: 'settings', 
  collection_name: 'preferences' 
}, { 
  cacheAll: true  // Enable All cache for this collection
})
```

### View Cache Statistics

```javascript
// Global stats
const globalStats = dsManager.cacheManager.getStats()
console.log('Global cache stats:', globalStats)

// User-level stats
const userDS = await dsManager.getOrSetUserDS('alice', options)
const userStats = userDS.userCache.getStats()
console.log('Alice cache stats:', userStats)

// Per-table stats
const db = await dsManager.getorInitDb({ 
  owner: 'alice', 
  app_name: 'blog', 
  collection_name: 'posts' 
})
const tableStats = db.cache.getStats()
console.log('Table cache stats:', tableStats)
```

### Admin Functions

```javascript
// List all users with cached data
const users = dsManager.cacheManager.listUsers()

// List cache entries for specific user
const entries = dsManager.cacheManager.listCacheEntries({
  owner: 'alice',
  limit: 50
})

// Clear all caches for a user
dsManager.cacheManager.clearUser('alice')

// Or via UserCache
const userDS = await dsManager.getOrSetUserDS('alice', options)
userDS.userCache.clearAll()

// Clear specific app_table
userDS.userCache.clearAppTable('blog_posts')

// Clear everything
dsManager.cacheManager.clearAll()
```

### Manual Cache Control

```javascript
const db = await dsManager.getorInitDb({ ... })

// Invalidate all caches for this table
db.cache.invalidateAll()

// Set a specific record in cache
db.cache.setByKey('_id', 'abc123', recordData)

// Get a specific record from cache
const record = db.cache.getByKey('_id', 'abc123')
```

## Configuration

Modify `cache/cacheConfig.mjs` to adjust:
- TTL values per cache type
- Memory threshold
- File size limits
- Eviction priorities
- Recent cache size
- Max entries per type

## Security Guarantees

- **Scoped Interface Architecture**: CacheManager creates scoped interfaces with owner/namespace baked in via closures
- Each USER_DS gets its own UserCache (uses scoped interface, cannot access other owners)
- Each UserCache creates scoped interfaces for AppTableCache (cannot access other tables)
- Each AppTableCache uses scoped interface (cannot access other namespaces)
- All cache operations validate keys match the scoped namespace
- Security violations throw errors if attempting to access unauthorized data
- No way for one user to access another user's cache, even with buggy code

## Memory Management

- Automatic eviction when heap usage exceeds 80%
- LRU eviction with priority weighting (All/Recent kept longest)
- Memory checked every 30 seconds
- Query caches evicted first under pressure
- Count limits per cache type prevent unbounded growth

## Next Steps

1. Add the integration code to dsManager.mjs and userDsMgr.mjs
2. Test with a simple query to verify cache hit/miss
3. Monitor cache stats during operation
4. Adjust TTL and size limits based on usage patterns
5. Gradually enable All cache for appropriate collections

## Full Example Integration

See the complete files:
- `dsManager.mjs (with cache integration)` - Shows CacheManager initialization
- `userDsMgr.mjs (with cache - KEY CHANGES ONLY)` - Shows UserCache and AppTableCache integration

These files are in the artifacts panel and show exactly where to add the cache code.
