# Admin Cache Management Guide

Quick reference for administrators managing the Freezr cache system.

## Viewing Cache Statistics

### Global Overview
```javascript
const stats = dsManager.cacheManager.getStats()

console.log('Cache Type:', stats.cacheType)  // 'memory' or 'redis'
console.log('Total Keys:', stats.totalKeys)
console.log('Hit Rate:', (stats.hitRate * 100).toFixed(1) + '%')
console.log('Cache Hits:', stats.hits)
console.log('DB Hits:', stats.dbHits)

if (stats.memory) {
  console.log('Cache Size:', stats.memory.cacheSizeMB + ' MB')
  console.log('Heap Used:', stats.memory.heapUsedPercent)
  console.log('Cache % of Heap:', stats.memory.cachePercentOfHeap)
}
```

### Users with Cached Data
```javascript
const users = dsManager.cacheManager.listUsers()

users.forEach(user => {
  console.log(`${user.owner}: ${user.entryCount} entries, ${user.totalSizeMB} MB`)
})
```

### Specific Entry Inspection
```javascript
const entry = dsManager.cacheManager.inspectEntry('alice:blog_posts:byKey:_id:abc123')

if (entry.found) {
  console.log('Type:', entry.type)
  console.log('Size:', entry.sizeMB + ' MB')
  console.log('Access Count:', entry.accessCount)
  console.log('Last Accessed:', entry.lastAccessed)
  console.log('Age:', entry.ageMinutes + ' minutes')
}
```

## Managing Cache Preferences

### View Current Preferences
```javascript
const prefs = dsManager.cacheManager.getCachePrefs()

console.log('All Users Settings:', prefs.ALL_USERS)
console.log('User-Specific Settings:', prefs.USER_SPECIFIC)
```

### Get Preferences for Specific Table
```javascript
const tablePrefs = dsManager.cacheManager.getCachePrefsForTable('alice', 'blog_posts')

console.log('Cache All:', tablePrefs.cacheAll)
console.log('Cache Recent:', tablePrefs.cacheRecent)
```

### Update Preferences
```javascript
// Add a global preference for all users
dsManager.cacheManager.updateCachePrefs({
  ALL_USERS: {
    'info_freezr_account_permissions': { cacheAll: true }
  }
})

// Add user-specific preference
dsManager.cacheManager.updateCachePrefs({
  USER_SPECIFIC: {
    'alice': {
      'custom_app_settings': { cacheAll: true }
    }
  }
})
```

### Edit Default Preferences File

Edit `freezr_system/cache/defaultCachePrefs.json`:

```json
{
  "ALL_USERS": {
    "info_freezr_account_app_list": { "cacheAll": true },
    "info_freezr_account_permissions": { "cacheAll": true }
  },
  "USER_SPECIFIC": {
    "fradmin": {
      "info_freezr_admin_users": { "cacheAll": true }
    }
  }
}
```

**Options**:
- `cacheAll: true` - Cache entire dataset (for small collections)
- `cacheRecent: false` - Disable recent cache (default is true)
- `cachePatterns: ["field1", "field2", ["field1", "field2"]]` - Declare which query patterns to cache
  - Single fields like `"category"` → cached as byKey
  - Compound patterns like `["category", "author"]` → cached as Query
  - Only simple equality queries matching patterns are cached (no operators, no options)

## Cache Clearing Operations

### Clear Everything (Nuclear Option)
```javascript
dsManager.cacheManager.clearAll()
console.log('All caches cleared')
```

### Clear Specific User
```javascript
dsManager.cacheManager.clearUser('alice')
console.log('Cleared all caches for alice')
```

### Clear Specific Table
```javascript
dsManager.cacheManager.clearNamespace('alice:blog_posts')
console.log('Cleared cache for alice:blog_posts')
```

### Delete Specific Entry
```javascript
dsManager.cacheManager.adminDelete('alice:blog_posts:byKey:_id:abc123')
console.log('Deleted specific cache entry')
```

### Via User-Level Operations
```javascript
const userDS = await dsManager.getOrSetUserDS('alice', options)

// Clear all caches for this user
userDS.userCache.clearAll()

// Clear specific app_table
userDS.userCache.clearAppTable('blog_posts')

// Get user stats
const userStats = userDS.userCache.getStats()
console.log(userStats)

// List app_tables with cached data
const appTables = userDS.userCache.listAppTables()
console.log(appTables)
```

## Monitoring Health

### Check Memory Usage
```javascript
const stats = dsManager.cacheManager.getStats()

if (parseFloat(stats.memory.heapUsedPercent) > 80) {
  console.warn('⚠️ Memory usage high!')
  console.log('Consider:')
  console.log('- Reducing TTL values')
  console.log('- Disabling All cache on large collections')
  console.log('- Reducing maxFileSize')
}

if (parseFloat(stats.memory.cachePercentOfHeap) > 30) {
  console.warn('⚠️ Cache using >30% of heap')
  console.log('Cache size:', stats.memory.cacheSizeMB + ' MB')
}
```

### Check Hit Rate
```javascript
const stats = dsManager.cacheManager.getStats()

if (stats.hitRate < 0.5) {
  console.warn('⚠️ Low hit rate:', (stats.hitRate * 100).toFixed(1) + '%')
  console.log('Consider:')
  console.log('- Enabling All cache for frequently queried tables')
  console.log('- Increasing TTL values')
  console.log('- Reviewing query patterns')
}
```

### Review Evictions
```javascript
const stats = dsManager.cacheManager.getStats()

if (stats.memoryEvictions > 0) {
  console.warn(`⚠️ Memory evictions occurred: ${stats.memoryEvictions}`)
  console.log('Total evictions:', stats.evictions)
  console.log('This indicates memory pressure')
}
```

## Recommended Cache Settings

### Small Collections (< 1000 records)
```json
{
  "cacheAll": true,
  "cacheRecent": true,
  "cachePatterns": ["status", "category", ["status", "category"]]
}
```
**Examples**: Settings, preferences, user metadata

### Medium Collections (1000-10,000 records)
```json
{
  "cacheAll": false,
  "cacheRecent": true
}
```
**Examples**: User posts, comments, moderate activity

### Large Collections (> 10,000 records)
```json
{
  "cacheAll": false,
  "cacheRecent": true
}
```
**Examples**: Logs, analytics, high-volume data

### Frequently Changing Data
```json
{
  "cacheAll": false,
  "cacheRecent": false
}
```
**Examples**: Real-time data, temporary data

## Redis Configuration (Optional)

### Enable Redis
Edit dsManager initialization:
```javascript
self.cacheManager = new CacheManager({
  type: 'redis',
  redis: {
    host: 'localhost',
    port: 6379,
    password: 'yourpassword',  // Optional
    db: 0,                     // Redis database number
    keyPrefix: 'freezr:'       // Prefix for all keys
  }
})
```

### Install Redis Client
```bash
npm install ioredis
```

### Check Redis Connection
```javascript
const stats = dsManager.cacheManager.getStats()
console.log('Cache Type:', stats.cacheType)

// Should see 'redis' if connected
// Will see 'memory' if fallback occurred
```

### Redis Benefits
- ✅ Distributed caching across multiple servers
- ✅ Persistent cache (survives server restarts)
- ✅ Larger cache sizes (not limited by Node.js heap)
- ⚠️ Slight latency increase (~0.5-1ms per operation)

## Troubleshooting

### Issue: Low Hit Rate
**Check**:
```javascript
const stats = dsManager.cacheManager.getStats()
console.log('By Type:', stats.byType)
```

**Solutions**:
- Enable All cache for small tables
- Increase Query TTL
- Review if queries are unique vs reused

### Issue: High Memory Usage
**Check**:
```javascript
const stats = dsManager.cacheManager.getStats()
console.log('Size by Type:', stats.sizeByType)
console.log('Size by Namespace:', stats.sizeByNamespace)
```

**Solutions**:
- Disable All cache on large collections
- Reduce `maxFileSize` in config
- Clear unused caches: `clearUser()` or `clearNamespace()`

### Issue: Stale Data
**Check**:
- Verify writes call `markDirty()`
- Check if external processes modify DB directly

**Solutions**:
- Manually clear affected caches
- Reduce TTL values
- Ensure cache integration is complete

### Issue: Cache Not Working
**Check**:
```javascript
const userDS = await dsManager.getOrSetUserDS('alice', options)
console.log('Has userCache:', !!userDS.userCache)

const db = await dsManager.getorInitDb({ owner: 'alice', app_table: 'blog_posts' })
console.log('Has cache:', !!db.cache)
```

**Solutions**:
- Verify cacheManager initialized in dsManager
- Check env.cache passed to USER_DS
- Ensure integration code is complete

## Daily Monitoring Checklist

1. **Check Global Stats**
   - Hit rate > 70%
   - Memory usage < 80%
   - Cache size reasonable for heap

2. **Review User Stats**
   - No single user consuming excessive cache
   - Distribution is reasonable

3. **Check for Warnings**
   - Memory evictions
   - High heap usage
   - Redis connection issues (if using Redis)

4. **Review Preferences**
   - All cache only on small collections
   - New tables have appropriate settings

## Configuration Files

### Cache Config
`freezr_system/cache/cacheConfig.mjs`
- TTL values
- Memory thresholds
- File size limits
- Eviction priorities

### Cache Preferences
`freezr_system/cache/defaultCachePrefs.json`
- Per-table cache settings
- User-specific overrides
- Updated via admin functions or manually

## Best Practices

✅ **DO**:
- Monitor hit rates regularly
- Use All cache for small, frequently-queried tables
- Set appropriate TTLs based on data change frequency
- Clear caches after bulk updates
- Review memory usage weekly

❌ **DON'T**:
- Enable All cache on large collections (>10K records)
- Set very long TTLs on frequently changing data
- Ignore high memory usage warnings
- Assume cache is working without verification
- Modify cache data directly (always use provided methods)

## Local File Copy Management

When using cloud storage, files are copied locally for faster access. These local copies need management to prevent disk bloat.

### View Local File Copy Info

```javascript
// Get info for specific app
const info = userDS.userCache.getLocalFileCopyInfo('myApp')

console.log('Files tracked:', info.count)
console.log('Total size:', info.totalSizeMB + ' MB')
info.files.forEach(f => {
  console.log(`  ${f.path}: ${f.ageMinutes} min old`)
})

// Get info for all apps (for this user)
const allInfo = userDS.userCache.getLocalFileCopyInfo()
```

### Clean Up Local Copies

```javascript
// Wipe all local copies for an app (e.g., on app reinstall)
const result = await userDS.userCache.wipeLocalFileCopy('myApp', ROOT_DIR)
console.log('Deleted:', result.deleted, 'files')
console.log('Freed:', (result.freedBytes / 1024 / 1024).toFixed(2), 'MB')

// Wipe only old copies (> 24 hours)
await userDS.userCache.wipeLocalFileCopy('myApp', ROOT_DIR, {
  olderThanMs: 24 * 60 * 60 * 1000
})

// Dry run - preview what would be deleted
const preview = await userDS.userCache.wipeLocalFileCopy('myApp', ROOT_DIR, {
  dryRun: true
})
console.log('Would delete:', preview.deleted, 'files')

// Wipe all local copies for a user (all apps)
await userDS.userCache.wipeLocalFileCopyForUser(ROOT_DIR)
```

### When to Clean Up

**Recommended cleanup scenarios:**
- ✅ On app reinstall/upgrade (wipe that app's local copies)
- ✅ On user account deletion (wipe user's local copies)
- ✅ Scheduled maintenance (wipe copies older than X days)
- ✅ Disk space alerts (wipe oldest copies first)

**Example: App reinstall cleanup**
```javascript
async function reinstallApp(owner, appName) {
  const userDS = await dsManager.getOrSetUserDS(owner, options)
  
  // Wipe old local copies before reinstall
  await userDS.userCache.wipeLocalFileCopy(appName, ROOT_DIR)
  
  // Clear in-memory cache too
  userDS.userCache.clearAppTable(appName)
  
  // Proceed with reinstall...
}
```

---

## Multi-Server Consistency

When running multiple server instances, local file copies can become stale. The system tracks file modification times in the shared cache to detect this.

### How It Works

1. **On file write**: Server updates `fileModTime` in shared cache
2. **On file serve**: Server compares shared `fileModTime` with local `lastCopied`
3. **If stale**: Server re-fetches from remote storage

### Check if System is Working

```javascript
// Verify fileModTime is being set on writes
const db = await dsManager.getorInitDb({ owner, app_name, collection_name })

// After a file write, check the mod time
const modTime = db.cache.getAppFileModTime('public/app.js')
console.log('File mod time:', new Date(modTime))

// Check local copy time
const localCopyTime = userDS.userCache.getLocalFileCopyTime(appName, partialPath)
console.log('Local copy time:', new Date(localCopyTime))

// Stale if: modTime > localCopyTime
console.log('Is stale:', modTime > localCopyTime)
```

### Force Re-fetch from Remote

```javascript
// Invalidate fileModTime to force re-fetch on all servers
db.cache.invalidateAppFileModTime('public/app.js')

// Or for user files
db.cache.invalidateUserFileModTime('uploads/photo.jpg')
```

### Important: Clock Synchronization

For multi-server setups, ensure all servers use NTP:

```bash
# Check NTP status (Linux)
timedatectl status

# Check time sync (macOS)
systemsetup -getusingnetworktime
```

---

## Support

For issues or questions:
1. Check troubleshooting section above
2. Review `cache_strategy_doc.md` for complete details
3. Check server logs for cache-related warnings
4. Verify configuration in `cacheConfig.mjs` and `defaultCachePrefs.json`

---

**Last Updated**: 2025-12-13  
**Version**: 2.2

## Security Architecture

The cache system uses **scoped interfaces** for security:
- `CacheManager.createUserInterface(owner)` creates a scoped interface with owner baked in
- `UserCache._createAppTableInterface(appTable)` creates a scoped interface with namespace baked in
- All operations validate keys match the scoped namespace
- Security violations throw errors if attempting to access unauthorized data
- Even buggy code cannot access other users' or tables' data
