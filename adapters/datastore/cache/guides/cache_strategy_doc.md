# Freezr Cache System - Strategy and Implementation Guide

## Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Cache Types](#cache-types)
4. [Query Flow Logic](#query-flow-logic)
5. [Write Debouncing](#write-debouncing)
6. [Memory Management](#memory-management)
7. [Security Model](#security-model)
8. [Configuration](#configuration)
9. [Admin Functions](#admin-functions)
10. [Implementation Details](#implementation-details)
11. [Usage Examples](#usage-examples)
12. [Troubleshooting](#troubleshooting)

---

## Overview

The Freezr cache system is a three-layer in-memory caching solution designed to optimize database queries and file access while maintaining strict security boundaries between users and applications.

### Design Goals
- **Performance**: Reduce database queries through intelligent caching
- **Security**: Absolute isolation between users and app_tables
- **Memory Efficiency**: Automatic eviction under memory pressure
- **Flexibility**: Support both simple record caching and complex query patterns
- **Transparency**: Minimal changes to existing code

### Key Features
- Multi-tier cache hierarchy (byKey, Query, Recent, All, fileName)
- Intelligent query matching and filtering
- Write debouncing to batch cache refreshes
- LRU eviction with priority weighting
- Comprehensive admin tools for monitoring and control

---

## Architecture

### Three-Layer Hierarchy

```
┌─────────────────────────────────────────────────┐
│         CacheManager (Global Singleton)         │
│  - Memory monitoring & eviction                 │
│  - Global stats & admin functions               │
│  - Underlying storage (node-cache)              │
└─────────────────┬───────────────────────────────┘
                  │
        ┌─────────┴─────────┐
        │                   │
┌───────▼───────┐   ┌───────▼───────┐
│  UserCache    │   │  UserCache    │
│  (per owner)  │   │  (per owner)  │
│  - alice      │   │  - bob        │
└───────┬───────┘   └───────┬───────┘
        │                   │
    ┌───┴───┐           ┌───┴───┐
    │       │           │       │
┌───▼───┐ ┌─▼───────┐ ┌▼─────┐ │
│AppCache│ │AppCache│ │AppCache│ etc...
│blog_   │ │comments│ │photos_│
│posts   │ │        │ │albums │
└────────┘ └────────┘ └───────┘
```

### Component Responsibilities

**CacheManager** (Global Singleton)
- Single instance for entire server
- Manages underlying node-cache storage
- Memory monitoring every 30 seconds
- LRU eviction when heap > 80%
- Global statistics and admin functions
- Pattern-based key deletion

**UserCache** (Per User)
- One instance per owner (user)
- Locked to specific owner in constructor
- Creates and manages AppTableCache instances
- User-level statistics and operations
- Cannot access other users' caches

**AppTableCache** (Per user:app_table)
- One instance per unique user:app_table combination
- Locked to specific namespace in constructor
- Implements intelligent query routing
- Handles write debouncing
- Manages five cache types: byKey, Query, Recent, All, fileName

---

## Cache Types

The system uses five distinct cache types, each optimized for different access patterns:

### 1. byKey Cache

**Purpose**: Individual record lookups by key (typically `_id`)

**Key Pattern**: `user:app_table:byKey:keyName:keyValue`

**Example**: `alice:blog_posts:byKey:_id:abc123`

**Characteristics**:
- Short TTL (30 minutes default)
- Immediate invalidation on update/delete
- Smallest memory footprint
- Lowest eviction priority

**Use Cases**:
- Direct record access: `db.query({ _id: 'abc123' })`
- Quick lookups after create operations

### 2. Query Cache

**Purpose**: Store results of specific query patterns (pattern-based caching)

**Key Pattern**: `user:app_table:Query:hash`
  where hash is MD5 of (query) - **no options in hash**

**Example**: `alice:blog_posts:Query:a3f5b2c1d4e6f8a0`
  (for query `{ category: 'tech', author: 'claude' }`)

**Characteristics**:
- Very short TTL (5 minutes default)
- **Only caches queries matching declared `cachePatterns`**
- **Only simple equality queries** (no operators like `$in`, `$gt`, etc.)
- **No queries with options** (sort, skip, limit) are cached
- First to be evicted under pressure
- **Precise invalidation** - only invalidates matching patterns on write

**Pattern Configuration**:
```javascript
// In defaultCachePrefs.json or options
{
  "cachePatterns": [
    "category",                    // Single field → cached as byKey
    "author",                      // Single field → cached as byKey  
    ["category", "author"]         // Compound → cached as Query
  ]
}
```

**Use Cases**:
- Repeated equality queries matching declared patterns
- Compound queries with multiple equality conditions
- User-specific filters (when patterns declared)

### 3. Recent Cache

**Purpose**: Most recent 1000 records (by `_date_modified`)

**Key Pattern**: `user:app_table:Recent`

**Example**: `alice:blog_posts:Recent`

**Characteristics**:
- Long TTL (7 days default)
- High eviction priority
- Can be **authoritative** for time-based queries
- Always sorted by `_date_modified` descending

**Authoritativeness**:
If Recent cache contains records older than the query timestamp, it has ALL relevant records and can answer definitively without hitting the database.

**Use Cases**:
- Dashboard "recent items" lists
- Time-based filters: `{ _date_modified: { $gt: timestamp } }`
- Activity feeds

### 4. All Cache

**Purpose**: Complete dataset for small collections (opt-in)

**Key Pattern**: `user:app_table:All`

**Example**: `alice:settings_preferences:All`

**Characteristics**:
- Long TTL (7 days default)
- Highest eviction priority
- **Authoritative** - if exists, never queries DB
- Opt-in per app_table (via `cacheAll: true`)

**Authoritativeness**:
When All cache exists, it is the definitive dataset. If a query doesn't match anything in All cache, the record doesn't exist - no DB query needed.

**Use Cases**:
- Settings and preferences
- Small lookup tables
- User metadata
- Static or rarely-changing collections

### 5. fileName Cache

**Purpose**: File content caching (HTML, CSS, JS, images)

**Key Pattern**: `user:app_table:fileName:path/to/file`

**Example**: `alice:blog_app:fileName:public/index.html`

**Characteristics**:
- Medium TTL (1 hour default)
- Size limit (1MB default)
- Invalidated on file write
- Medium eviction priority

**Use Cases**:
- Frequently accessed files
- Static assets
- Template files
- Configuration files

---

## Query Flow Logic

The system implements intelligent query routing based on query structure. This is the **most important** part of the cache system.

### Flow 1: Query by _id

```
{ _id: 'abc123' }

1. Check byKey cache
   ├─ HIT → return [record]
   └─ MISS → continue

2. Check All cache (if enabled)
   ├─ EXISTS → filter in memory → return results
   │           (AUTHORITATIVE - don't check DB even if empty)
   └─ NOT ENABLED → continue

3. Check Recent cache
   ├─ EXISTS → filter in memory
   │  ├─ FOUND → return results
   │  └─ EMPTY → continue (might be older record)
   └─ NOT EXISTS → continue

4. Check Query cache
   ├─ HIT → return results
   └─ MISS → continue

5. Hit Database → cache result → return
```

**Key Point**: All cache is AUTHORITATIVE. If it exists and record not found, stop searching.

### Flow 2: Query by _date_modified with $gt

```
{ _date_modified: { $gt: timestamp } }

1. Check Query cache
   ├─ HIT → return results
   └─ MISS → continue

2. Check Recent cache
   ├─ EXISTS
   │  ├─ Check if COMPLETE (has records older than timestamp)
   │  │  ├─ YES (AUTHORITATIVE) → filter in memory → return
   │  │  └─ NO → filter what we have
   │  │     ├─ FOUND → return results
   │  │     └─ EMPTY → continue
   │  └─ NOT EXISTS → continue

3. Hit Database → cache result → return
```

**Key Point**: Recent cache can be AUTHORITATIVE for date queries if it contains records older than the query timestamp.

### Flow 3: General Query

```
{ status: 'published', category: 'tech' }

1. Check Query cache
   ├─ HIT → return results
   └─ MISS → continue

2. Check All cache (if enabled)
   ├─ EXISTS → filter in memory → return results
   │           (AUTHORITATIVE - don't check DB even if empty)
   └─ NOT ENABLED → continue

3. Hit Database → cache result → return
```

**Key Point**: All cache is checked for ALL queries (not just _id lookups).

### In-Memory Filtering

When All or Recent caches are used, queries are filtered in-memory using the `queryMatcher` module which supports:

- Direct equality: `{ status: 'published' }`
- Comparison operators: `$gt`, `$gte`, `$lt`, `$lte`, `$ne`
- Array operators: `$in`, `$nin`
- Existence: `$exists`
- Sorting: `{ sort: { _date_modified: -1 } }`
- Pagination: `{ skip: 10, limit: 20 }`

---

## Write Debouncing

To avoid excessive cache refreshes during bulk operations, the system implements write debouncing.

### The Problem

Without debouncing:
```javascript
// Import 100 records
for (let i = 0; i < 100; i++) {
  await db.create(record[i])
  // Triggers cache refresh immediately
}
// Result: 100 cache refreshes (expensive!)
```

### The Solution

With debouncing (1 second delay):
```javascript
// Import 100 records
for (let i = 0; i < 100; i++) {
  await db.create(record[i])
  // Marks cache as dirty, schedules refresh
  // Each new write resets the timer
}
// After last write, wait 1 second
// Result: 1 cache refresh after all writes complete
```

### Implementation

```javascript
markDirty(recordId, oldRecord, newRecord) {
  // If cachePatterns configured and record data provided:
  // - Precisely invalidates only matching patterns (byKey + Query)
  // - Invalidates both old and new values for pattern fields
  // Otherwise:
  // If cachePatterns configured and record data provided:
  if (this.cachePatterns.length > 0 && (oldRecord || newRecord)) {
    // Precise invalidation - only invalidates matching patterns
    this.invalidateForRecord(oldRecord, newRecord)
    // - Loops through cachePatterns
    // - For single fields: deletes byKey entries
    // - For compound patterns: builds query, hashes it, deletes that Query cache
    // - Invalidates both old and new values
  } else {
    // Fallback: conservative invalidation
    if (recordId) {
      this.deleteByKey('_id', recordId)
    }
    // Clear all Query caches (only if no patterns configured)
    if (this.cachePatterns.length === 0) {
      this.deletePattern(`${namespace}:Query:*`)
    }
  }
  
  // Mark All/Recent as dirty (always)
  this.dirtyFlags.All = true
  this.dirtyFlags.Recent = true
  
  // Schedule debounced refresh
  clearTimeout(this.invalidationTimer)
  this.invalidationTimer = setTimeout(() => {
    this.refreshFunction(this.dirtyFlags)
  }, 1000)  // 1 second delay
}
```

### Refresh Function

The refresh function is provided by the integration code and has access to the database:

```javascript
cache.setRefreshFunction(async (dirtyFlags) => {
  if (dirtyFlags.All && cache.cacheAll) {
    // Refresh All cache
    const allRecords = await db.query({}, {})
    await cache.setAll(allRecords)
  }
  
  if (dirtyFlags.Recent && cache.cacheRecent) {
    // Refresh Recent cache
    const recentRecords = await db.query({}, {
      sort: { _date_modified: -1 },
      limit: 1000
    })
    await cache.setRecent(recentRecords)
  }
})
```

---

## Memory Management

The system actively monitors and manages memory to prevent out-of-memory errors.

### Monitoring

- **Frequency**: Every 30 seconds (configurable)
- **Metric**: `heapUsed / heapTotal`
- **Threshold**: 80% (triggers eviction)

### Eviction Strategy

When memory threshold is exceeded:

**1. Calculate Eviction Scores**

Each cache entry gets a score based on:
- Base Priority (from cache type)
- Age (time since last access)
- Access Count (popularity)

```javascript
score = priority - ageWeight + accessWeight

where:
  ageWeight = min(ageMinutes / 60, 10)  // Max 10 points
  accessWeight = min(accessCount * 0.3, 10)  // Max 10 points
```

**2. Sort by Score (Lowest First)**

**3. Evict Bottom 20%**

With special rules:
- Keep All/Recent caches if accessed in last 24 hours
- Prefer evicting Query and byKey caches first

### Priority Values

From `cacheConfig.mjs`:
```javascript
evictionPriority: {
  All: 100,      // Highest - almost never evicted
  Recent: 90,    // High - keep as long as possible
  fileName: 50,  // Medium
  byKey: 40,     // Lower
  Query: 10      // Lowest - evict first
}
```

### Count Limits

In addition to memory-based eviction, each cache type has a maximum count:

```javascript
maxEntries: {
  All: 10000,
  Recent: 1000,
  Query: 100,     // Only keep 100 different queries
  byKey: 5000,
  fileName: 1000
}
```

When exceeded, oldest entries (by last access) are evicted.

---

## Security Model

The cache system enforces strict security boundaries using **scoped interfaces** with closure-based validation.

### Scoped Interface Architecture

**CacheManager** creates scoped interfaces with owner baked in:
```javascript
// In dsManager.mjs
const scopedInterface = cacheManager.createUserInterface(owner)
// Returns frozen object with closure functions that validate owner prefix
// All operations throw errors if attempting to access other owners' data
```

**UserCache** receives scoped interface (not full CacheManager):
```javascript
class UserCache {
  constructor(scopedInterface, owner) {
    this._interface = scopedInterface  // Scoped, not full CacheManager
    this.owner = owner
  }
  
  _createAppTableInterface(appTable) {
    // Creates scoped interface with namespace baked in
    // All operations validate namespace prefix
  }
}
```

**AppTableCache** receives scoped interface (not full UserCache):
```javascript
class AppTableCache {
  constructor(scopedInterface, owner, appTable) {
    this._interface = scopedInterface  // Scoped, not full UserCache
    this.namespace = `${owner}:${appTable}`
  }
  
  // All cache operations use this._interface which validates namespace
}
```

### Isolation Guarantees

**User-level Isolation**:
- CacheManager creates scoped interface with owner prefix baked in via closures
- Each USER_DS gets its own UserCache instance with scoped interface
- UserCache cannot access other users' data (validated in closure)
- Security violations throw errors if attempting cross-user access

**App-level Isolation**:
- UserCache creates scoped interface with namespace prefix baked in via closures
- Each app_table gets its own AppTableCache instance with scoped interface
- AppTableCache cannot access other tables' data (validated in closure)
- All cache keys automatically prefixed with `owner:app_table`
- Pattern-based operations limited to namespace

**Example**:
```javascript
// Alice's cache for blog_posts
const aliceCache = new AppTableCache(scopedInterface, 'alice', 'blog_posts')
aliceCache._interface.get('bob:blog_posts:byKey:_id:123')
// ❌ Throws: Security violation: key does not belong to namespace "alice:blog_posts"

aliceCache._interface.get('alice:blog_posts:byKey:_id:123')
// ✅ Allowed - matches namespace
```

### Admin Override

Only CacheManager (with admin access) can:
- View all caches across all users
- Clear caches for specific users
- Access any cache key directly

Regular code using AppTableCache cannot bypass namespace restrictions - validation happens in closure functions.

---

## Configuration

All configuration is centralized in `cache/cacheConfig.mjs`.

### Key Settings

```javascript
export default {
  // Memory management
  memoryThreshold: 0.8,        // 80% heap usage
  memoryCheckInterval: 30000,  // 30 seconds
  
  // File limits
  maxFileSize: 1024 * 1024,    // 1MB
  
  // TTL (seconds)
  ttl: {
    fileName: 3600,            // 1 hour
    byKey: 1800,               // 30 minutes
    Query: 300,                // 5 minutes
    Recent: 86400 * 7,         // 7 days
    All: 86400 * 7             // 7 days
  },
  
  // Sizes
  recentCount: 1000,           // Records in Recent cache
  
  // Debouncing
  invalidationDelay: 1000,     // 1 second
  
  // Eviction priorities (higher = keep longer)
  evictionPriority: {
    All: 100,
    Recent: 90,
    fileName: 50,
    byKey: 40,
    Query: 10
  },
  
  // Max entries per type
  maxEntries: {
    All: 10000,
    Recent: 1000,
    Query: 100,
    byKey: 5000,
    fileName: 1000
  }
}
```

### Per-Table Configuration

When initializing a database, you can override settings:

```javascript
await dsManager.initOacDB({ 
  owner: 'alice', 
  app_name: 'settings', 
  collection_name: 'preferences' 
}, { 
  cacheAll: true,              // Enable All cache
  cacheRecent: false           // Disable Recent cache
})
```

---

## Admin Functions

The CacheManager provides comprehensive admin functions for monitoring and control.

### Global Statistics

```javascript
const stats = dsManager.cacheManager.getStats()

// Returns:
{
  totalKeys: 15432,
  hits: 98234,
  misses: 1532,
  hitRate: 0.9845,
  evictions: 245,
  memoryEvictions: 12,
  
  memory: {
    cacheSize: 52428800,           // bytes
    cacheSizeMB: "50.00",
    heapUsed: 134217728,
    heapUsedMB: "128.00",
    heapTotal: 268435456,
    heapTotalMB: "256.00",
    heapUsedPercent: "50.0%",
    cachePercentOfHeap: "39.1%"   // Cache is 39% of heap
  },
  
  byType: {
    byKey: 5234,
    Query: 89,
    Recent: 45,
    All: 12,
    fileName: 10052
  },
  
  sizeByType: {
    byKey: 10485760,      // bytes per type
    Query: 5242880,
    // ...
  },
  
  byNamespace: {
    "alice:blog_posts": 234,
    "alice:comments": 567,
    // ...
  }
}
```

### List All Users

```javascript
const users = dsManager.cacheManager.listUsers()

// Returns:
[
  {
    owner: "alice",
    entryCount: 1234,
    totalSize: 15728640,
    totalSizeMB: "15.00"
  },
  {
    owner: "bob",
    entryCount: 567,
    totalSize: 7340032,
    totalSizeMB: "7.00"
  }
]
```

### List Cache Entries

```javascript
// List all caches for a user
const entries = dsManager.cacheManager.listCacheEntries({
  owner: 'alice',
  limit: 50
})

// List specific cache type
const queryEntries = dsManager.cacheManager.listCacheEntries({
  type: 'Query',
  limit: 100
})

// List by pattern
const blogEntries = dsManager.cacheManager.listCacheEntries({
  pattern: 'alice:blog_.*',
  limit: 100
})

// Returns:
{
  total: 1234,
  showing: 50,
  entries: [
    {
      key: "alice:blog_posts:byKey:_id:abc123",
      namespace: "alice:blog_posts",
      type: "byKey",
      size: 2048,
      sizeMB: "0.002",
      accessCount: 45,
      lastAccessed: "2025-01-15T10:30:00.000Z",
      ageMinutes: 15
    },
    // ... more entries
  ]
}
```

### Inspect Specific Entry

```javascript
const entry = dsManager.cacheManager.inspectEntry(
  'alice:blog_posts:byKey:_id:abc123'
)

// Returns:
{
  found: true,
  key: "alice:blog_posts:byKey:_id:abc123",
  namespace: "alice:blog_posts",
  type: "byKey",
  size: 2048,
  sizeMB: "0.002",
  priority: 40,
  accessCount: 45,
  createdAt: "2025-01-15T10:15:00.000Z",
  lastAccessed: "2025-01-15T10:30:00.000Z",
  ageMinutes: 15,
  ttl: 1800,
  valuePreview: '{"_id":"abc123","title":"My Post",...}'
}
```

### Clear Operations

```javascript
// Clear ALL caches (nuclear option)
dsManager.cacheManager.clearAll()

// Clear all caches for a specific user
dsManager.cacheManager.clearUser('alice')

// Clear specific namespace (user:app_table)
dsManager.cacheManager.clearNamespace('alice:blog_posts')

// Delete specific cache entry
dsManager.cacheManager.adminDelete('alice:blog_posts:byKey:_id:abc123')
```

### User-Level Operations

```javascript
// Via UserCache (if you have access to USER_DS)
const userDS = await dsManager.getOrSetUserDS('alice', options)

// Get stats for this user
const userStats = userDS.userCache.getStats()

// List app_tables with cached data
const appTables = userDS.userCache.listAppTables()

// Clear all caches for this user
userDS.userCache.clearAll()

// Clear specific app_table
userDS.userCache.clearAppTable('blog_posts')
```

---

## Implementation Details

### Key Integration Points

**1. dsManager.mjs**
```javascript
// Create global CacheManager
self.cacheManager = new CacheManager()

// Pass to USER_DS instances
self.users[owner] = new USER_DS(owner, env, self.cacheManager)
```

**2. userDsMgr.mjs - Constructor**
```javascript
function USER_DS(owner, env, cacheManager) {
  // Create UserCache for this owner
  if (cacheManager) {
    this.userCache = new UserCache(cacheManager, owner)
  }
}
```

**3. userDsMgr.mjs - initOacDB**
```javascript
// Create AppTableCache
ds.cache = this.userCache.getOrCreateAppTableCache(
  appTableName(OAC),
  { cacheAll: options.cacheAll }
)

// Set refresh function
ds.cache.setRefreshFunction(async (dirtyFlags) => {
  // Refresh logic with DB access
})

// Wrap query
ds.query = async function(query, options) {
  const cached = await ds.cache.query(query, options)
  if (cached !== null) return cached
  
  const results = await ds.db.query_async(query, options)
  await ds.cache.setQuery(query, results, options)
  return results
}

// Wrap create/update/delete to call markDirty()
```

**4. userDsMgr.mjs - initAppFS**
```javascript
// Reuse cache from app_table
ds.cache = this.userCache.getOrCreateAppTableCache(appName)

// Wrap file operations
ds.readAppFile = async function(endpath) {
  const cached = ds.cache.getFile(endpath)
  if (cached) return cached
  
  const content = // ... read file ...
  ds.cache.setFile(endpath, content)
  return content
}
```

### Query Hashing

Queries are hashed to create deterministic cache keys:

```javascript
// Input query
{
  status: 'published',
  category: 'tech',
  _date_modified: { $gt: 1704067200000 }
}

// Plus options
{ sort: { _date_modified: -1 }, limit: 10 }

// Normalized (keys sorted)
{
  query: {
    _date_modified: { $gt: 1704067200000 },
    category: 'tech',
    status: 'published'
  },
  options: {
    limit: 10,
    sort: { _date_modified: -1 }
  }
}

// Hashed to: a3f5b2c1d4e6f8a0
// Cache key: alice:blog_posts:Query:a3f5b2c1d4e6f8a0
```

This ensures identical queries (regardless of key order) hit the same cache entry.

---

## Usage Examples

### Basic Usage (Automatic)

```javascript
// Query - automatically uses cache
const posts = await db.query({ status: 'published' })

// First call: cache miss → DB query → cache result
// Second call: cache hit → return from cache
```

### Enable All Cache

```javascript
// For small, frequently-queried collections
await dsManager.initOacDB({ 
  owner: 'alice', 
  app_name: 'settings', 
  collection_name: 'preferences' 
}, { 
  cacheAll: true 
})

// Now ALL queries hit cache first
const pref = await db.query({ key: 'theme' })
// Even if empty result, won't query DB
```

### Monitor Performance

```javascript
// Get stats for specific app_table
const db = await dsManager.getorInitDb({
  owner: 'alice',
  app_name: 'blog',
  collection_name: 'posts'
})

const stats = db.cache.getStats()
console.log('Hit rate:', (stats.hitRate * 100).toFixed(1) + '%')
console.log('Cache queries:', stats.cacheHits)
console.log('DB queries:', stats.dbHits)
```

### Manual Cache Control

```javascript
// Invalidate all caches for app_table
db.cache.invalidateAll()

// Set specific record in cache
db.cache.setByKey('_id', 'post123', recordData)

// Get specific record from cache
const record = db.cache.getByKey('_id', 'post123')
```

### Admin Monitoring

```javascript
// Global overview
const globalStats = dsManager.cacheManager.getStats()
console.log('Memory usage:', globalStats.memory.heapUsedPercent)
console.log('Cache size:', globalStats.memory.cacheSizeMB + 'MB')
console.log('Hit rate:', (globalStats.hitRate * 100).toFixed(1) + '%')

// Find largest caches
const entries = dsManager.cacheManager.listCacheEntries({
  limit: 10
})
console.log('Top 10 largest caches:', entries.entries)

// Check specific user
const aliceStats = dsManager.cacheManager.listCacheEntries({
  owner: 'alice',
  limit: 50
})
```

---

## Troubleshooting

### Low Hit Rate

**Symptom**: Hit rate < 50%

**Possible Causes**:
1. Query patterns are too varied (many unique queries)
2. TTL too short for cache type
3. All/Recent caches not enabled where appropriate

**Solutions**:
- Enable All cache for small collections
- Increase Query TTL in config
- Check if queries are truly unique or similar patterns

### High Memory Usage

**Symptom**: Heap usage consistently > 80%, frequent evictions

**Possible Causes**:
1. Too many cached files or large files
2. All cache on large collections
3. Too many unique queries cached

**Solutions**:
- Reduce `maxFileSize` in config
- Disable All cache on large collections
- Reduce `maxEntries.Query` to keep fewer queries
- Reduce TTL values to expire entries faster

### Cache Not Working

**Symptom**: All queries show as cache misses

**Possible Causes**:
1. Cache not initialized (`cacheManager` not passed)
2. Cache disabled in config
3. Queries have variable options (different on each call)

**Solutions**:
- Verify `dsManager.cacheManager` exists
- Check `cacheConfig.enabled = true`
- Normalize query options (e.g., always include or exclude sort)

### Stale Data

**Symptom**: Cache returns old data after updates

**Possible Causes**:
1. Updates not calling `markDirty()`
2. External DB modifications (outside Freezr)
3. TTL too long

**Solutions**:
- Verify integration code calls `cache.markDirty()` on writes
- Manually invalidate: `db.cache.invalidateAll()`
- Reduce TTL for affected cache type

### Memory Leak Suspicion

**Symptom**: Memory grows continuously

**Diagnostic Steps**:
1. Check cache size: `dsManager.cacheManager.getStats().memory.cacheSizeMB`
2. List largest entries: `dsManager.cacheManager.listCacheEntries({ limit: 100 })`
3. Check for runaway caches: Look for namespaces with huge entry counts

**Solutions**:
- Manually clear suspect caches
- Reduce `maxEntries` for problem cache type
- Check for loops creating unlimited unique queries

---

## Best Practices

### When to Enable All Cache
✅ DO use for:
- User preferences and settings
- Lookup tables < 1000 records
- Static or rarely-changing data
- Frequently queried small collections

❌ DON'T use for:
- Large collections (> 10,000 records)
- Rapidly changing data
- User-generated content at scale

### When to Rely on Recent Cache
✅ DO use for:
- Activity feeds
- Recent posts/comments
- Time-based dashboards
- "Last 30 days" type queries

❌ DON'T use for:
- Historical data queries
- Queries spanning > 30 days
- Non-time-based filters

### Query Optimization
✅ DO:
- Use consistent query patterns
- Include standard options (sort, limit)
- Query by _id when possible
- Use time-based queries with Recent cache

❌ DON'T:
- Generate unique queries for same data
- Use random sort orders
- Skip pagination (use skip/limit)
- Mix query styles unnecessarily

### Monitoring
✅ DO:
- Check hit rates weekly
- Monitor memory usage trends
- Review largest cache entries monthly
- Test cache behavior in staging

❌ DON'T:
- Ignore low hit rates
- Let memory grow unchecked
- Deploy cache changes without testing
- Assume cache is working without verification

---

## Local File Copy Management

When using cloud storage (AWS, Azure, etc.), files are copied locally to the server for faster subsequent access. This creates a "local file copy" layer that needs management.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Request for File                        │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│              1. In-Memory Cache (text files only)           │
│              CacheManager → appFiles/userFiles              │
│              Fast: ~0.1ms                                   │
└─────────────────────────┬───────────────────────────────────┘
                          │ Miss
                          ▼
┌─────────────────────────────────────────────────────────────┐
│              2. Local Disk Copy                             │
│              Server's local filesystem                      │
│              Fast: ~1-10ms                                  │
│              Tracked in: localFileCopyRegistry              │
└─────────────────────────┬───────────────────────────────────┘
                          │ Miss or Stale
                          ▼
┌─────────────────────────────────────────────────────────────┐
│              3. Remote Storage (AWS/Azure/etc)              │
│              Primary data source                            │
│              Slower: ~50-500ms                              │
└─────────────────────────────────────────────────────────────┘
```

### Local File Copy Registry

The `localFileCopyRegistry` is a per-server, in-memory `Map` that tracks files copied from remote storage:

```javascript
// Registry structure
Map {
  'owner:appName' => Map {
    'partialPath' => {
      lastAccessed: 1702500000000,  // When last served
      lastCopied: 1702500000000,    // When copied from remote
      size: 1024,                   // File size in bytes
      fileType: 'appFile'           // 'appFile' or 'userFile'
    }
  }
}
```

### Tracking Methods

```javascript
// Track when a file is copied locally
userCache.trackLocalFileCopy(appName, partialPath, fileType, size)

// Get the timestamp when file was copied
userCache.getLocalFileCopyTime(appName, partialPath)

// Update timestamps (when file is served)
userCache.touchLocalFileCopy(appName, partialPath)

// Get info about local copies for an app
userCache.getLocalFileCopyInfo(appName)

// Wipe local copies for app (e.g., on app reinstall)
userCache.wipeLocalFileCopy(appName, rootDir, options)

// Wipe all local copies for user
userCache.wipeLocalFileCopyForUser(rootDir, options)
```

### Cleanup Options

```javascript
// Wipe all local copies for an app
await userCache.wipeLocalFileCopy('myApp', ROOT_DIR)

// Wipe copies older than 24 hours
await userCache.wipeLocalFileCopy('myApp', ROOT_DIR, {
  olderThanMs: 24 * 60 * 60 * 1000
})

// Dry run - see what would be deleted
const result = await userCache.wipeLocalFileCopy('myApp', ROOT_DIR, {
  dryRun: true
})
console.log('Would delete:', result.deleted, 'files')
console.log('Would free:', result.freedBytes, 'bytes')
```

---

## Multi-Server Consistency

When running multiple server instances with cloud storage, local file copies can become stale if another server updates the file. The system uses shared cache timestamps to detect and handle this.

### How It Works

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Server A   │     │  Server B   │     │  Server C   │
│             │     │             │     │             │
│ Local Copy  │     │ Local Copy  │     │ Local Copy  │
│ lastCopied: │     │ lastCopied: │     │ lastCopied: │
│ 10:00 AM    │     │ 10:00 AM    │     │ 10:00 AM    │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │
                           ▼
              ┌────────────────────────┐
              │    Shared Cache        │
              │    (Redis/Memory)      │
              │                        │
              │  fileModTime: 10:00 AM │
              └────────────────────────┘

═══════════════════════════════════════════════════════
After Server B updates the file at 11:00 AM:
═══════════════════════════════════════════════════════

┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Server A   │     │  Server B   │     │  Server C   │
│             │     │             │     │             │
│ Local Copy  │     │ Local Copy  │     │ Local Copy  │
│ lastCopied: │     │ lastCopied: │     │ lastCopied: │
│ 10:00 AM    │     │ 11:00 AM ✓  │     │ 10:00 AM    │
│ STALE! ⚠️   │     │ CURRENT     │     │ STALE! ⚠️   │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │
                           ▼
              ┌────────────────────────┐
              │    Shared Cache        │
              │    (Redis/Memory)      │
              │                        │
              │  fileModTime: 11:00 AM │ ← Updated by Server B
              └────────────────────────┘
```

### Staleness Detection

When serving a file, each server checks:

```javascript
const isLocalCopyStale = () => {
  // Get modification time from shared cache
  const sharedModTime = ds.cache.getAppFileModTime(endpath)
  if (!sharedModTime) return false  // Not tracked = use local
  
  // Get when this server copied the file
  const localCopyTime = userCache.getLocalFileCopyTime(appName, partialPath)
  if (!localCopyTime) return true   // No local copy time = fetch fresh
  
  // Stale if shared is newer than local copy
  return sharedModTime > localCopyTime
}
```

### File Modification Time Methods

```javascript
// In AppTableCache:

// Get modification time from shared cache
cache.getAppFileModTime(filePath)
cache.getUserFileModTime(filePath)

// Set modification time (on write)
cache.setAppFileModTime(filePath, timestamp)
cache.setUserFileModTime(filePath, timestamp)

// Invalidate (on delete - sets to current time)
cache.invalidateAppFileModTime(filePath)
cache.invalidateUserFileModTime(filePath)
```

### Key Format

File modification times use the standard key building pattern:

| Type | Key Format | Example |
|------|------------|---------|
| appFileModTime | `owner:appName:appFileModTime:path` | `alice:myApp:appFileModTime:public/app.js` |
| userFileModTime | `owner:appName:userFileModTime:path` | `alice:myApp:userFileModTime:uploads/photo.jpg` |

### Configuration

In `cacheConfig.mjs`:

```javascript
ttl: {
  // ... other TTLs ...
  appFileModTime: 0,    // No TTL - persist until invalidated
  userFileModTime: 0    // No TTL - persist until invalidated
}
```

### Important Notes

1. **Clock Synchronization**: All servers should use NTP to keep clocks synchronized. Small discrepancies (< 1 second) are acceptable.

2. **Write Operations**: When a file is written, `setAppFileModTime()` or `setUserFileModTime()` is automatically called.

3. **Delete Operations**: When a file is deleted, `invalidateAppFileModTime()` or `invalidateUserFileModTime()` is called, which sets the timestamp to current time so other servers know to re-fetch (and get a 404).

4. **In-Memory Cache Invalidation**: The in-memory content cache is also invalidated on writes. The `fileModTime` check is specifically for the local disk copies.

---

## Future Enhancements

Potential improvements for future consideration:

1. **Smart Query Matching**: Detect similar queries and reuse cached results
2. **Partial Cache Updates**: Update records in All/Recent caches instead of full refresh
3. **Cache Warming**: Pre-load important caches on server start
4. **Compression**: Compress large cached values to reduce memory
5. **Metrics Export**: Export stats to Prometheus/Grafana
6. **Cache Hints**: Allow apps to specify cache preferences via metadata
7. **Automatic Local File Cleanup**: Time-based automatic cleanup of stale local copies

---

## Summary

The Freezr cache system provides a robust, secure, and efficient caching layer with:

- ✅ Three-tier architecture (CacheManager → UserCache → AppTableCache)
- ✅ Five cache types optimized for different patterns
- ✅ Intelligent query routing with authoritative caches
- ✅ Write debouncing for bulk operations
- ✅ Automatic memory management and eviction
- ✅ Strict security boundaries
- ✅ Comprehensive admin tools
- ✅ Transparent integration

The system is production-ready and requires minimal code changes to integrate, while providing significant performance improvements for read-heavy workloads.

For questions or issues, refer to the troubleshooting section or review the implementation code in `freezr_system/cache/`.

---

**Document Version**: 2.2  
**Last Updated**: 2025-12-13  
**Authors**: Freezr Development Team
