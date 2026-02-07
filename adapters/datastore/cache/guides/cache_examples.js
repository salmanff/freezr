// freezr.info - Cache System Usage Examples
// These examples show how the cache system works after integration

import CacheManager from './cache/cacheManager.mjs'
import AppTableCache from './cache/appTableCache.mjs'

// ============================================================================
// Example 1: Basic Setup (what happens in dsManager.mjs)
// ============================================================================

async function example1_BasicSetup() {
  console.log('\n=== Example 1: Basic Setup ===')
  
  // Create singleton cache manager (done once in dsManager)
  const cacheManager = new CacheManager()
  
  // Create cache for a specific user:app_table (done in initOacDB)
  const blogCache = new AppTableCache(
    cacheManager,
    'alice',
    'blog_posts',
    { cacheRecent: true, cacheAll: false }
  )
  
  console.log('Cache created for:', blogCache.namespace)
  console.log('Stats:', blogCache.getStats())
}

// ============================================================================
// Example 2: Query Flow - Cache Miss → DB → Cache
// ============================================================================

async function example2_QueryFlow() {
  console.log('\n=== Example 2: Query Flow ===')
  
  const cacheManager = new CacheManager()
  const cache = new AppTableCache(cacheManager, 'alice', 'blog_posts')
  
  // Simulate a query
  const query = { status: 'published' }
  const options = {}
  
  // First query - cache miss
  console.log('First query (cache miss):')
  let result = await cache.query(query, options)
  console.log('  Result:', result)  // null - cache miss
  
  // Simulate DB query and cache the result
  const dbResults = [
    { _id: '1', title: 'Post 1', status: 'published', _date_modified: Date.now() },
    { _id: '2', title: 'Post 2', status: 'published', _date_modified: Date.now() }
  ]
  
  await cache.setQuery(query, dbResults, options)
  console.log('  Cached DB results')
  
  // Second query - cache hit
  console.log('\nSecond query (cache hit):')
  result = await cache.query(query, options)
  console.log('  Result:', result)
  console.log('  Cache stats:', cache.getStats())
}

// ============================================================================
// Example 3: byKey Caching
// ============================================================================

async function example3_ByKeyCache() {
  console.log('\n=== Example 3: ByKey Cache ===')
  
  const cacheManager = new CacheManager()
  const cache = new AppTableCache(cacheManager, 'alice', 'blog_posts')
  
  // Set a record by key
  const record = { 
    _id: 'post123', 
    title: 'My Post', 
    status: 'published',
    _date_modified: Date.now()
  }
  
  cache.setByKey('_id', 'post123', record)
  console.log('Cached record with _id: post123')
  
  // Query by _id - should hit byKey cache
  const query = { _id: 'post123' }
  const result = await cache.query(query, {})
  console.log('Query result:', result)
  
  // Delete from cache
  cache.deleteByKey('_id', 'post123')
  console.log('Deleted from cache')
  
  // Query again - should miss
  const result2 = await cache.query(query, {})
  console.log('Query after delete:', result2)  // null - cache miss
}

// ============================================================================
// Example 4: Recent Cache with Date Queries
// ============================================================================

async function example4_RecentCache() {
  console.log('\n=== Example 4: Recent Cache ===')
  
  const cacheManager = new CacheManager()
  const cache = new AppTableCache(cacheManager, 'alice', 'blog_posts')
  
  // Simulate 1000 recent records
  const recentRecords = []
  const now = Date.now()
  for (let i = 0; i < 1000; i++) {
    recentRecords.push({
      _id: `post${i}`,
      title: `Post ${i}`,
      _date_modified: now - (i * 60000)  // Each post 1 minute older
    })
  }
  
  await cache.setRecent(recentRecords)
  console.log('Set Recent cache with 1000 records')
  
  // Query for recent posts (last 10 minutes)
  const tenMinutesAgo = now - (10 * 60000)
  const query = { _date_modified: { $gt: tenMinutesAgo } }
  
  const result = await cache.query(query, {})
  console.log(`Query for posts > 10 min ago: ${result ? result.length : 0} results`)
  console.log('Recent cache was authoritative:', result !== null)
  
  // Query for very old posts (should not be in Recent)
  const veryOld = now - (2000 * 60000)  // Older than our oldest record
  const oldQuery = { _date_modified: { $gt: veryOld } }
  
  const oldResult = await cache.query(oldQuery, {})
  console.log(`Query for posts > 2000 min ago: ${oldResult ? oldResult.length : 0} results`)
  console.log('Recent cache was authoritative:', oldResult !== null)
}

// ============================================================================
// Example 5: All Cache (Authoritative)
// ============================================================================

async function example5_AllCache() {
  console.log('\n=== Example 5: All Cache (Authoritative) ===')
  
  const cacheManager = new CacheManager()
  const cache = new AppTableCache(cacheManager, 'alice', 'settings_prefs', {
    cacheAll: true  // Enable All cache
  })
  
  // Simulate loading all records into All cache
  const allRecords = [
    { _id: '1', key: 'theme', value: 'dark', _date_modified: Date.now() },
    { _id: '2', key: 'language', value: 'en', _date_modified: Date.now() },
    { _id: '3', key: 'notifications', value: true, _date_modified: Date.now() }
  ]
  
  await cache.setAll(allRecords)
  console.log('Set All cache with 3 records')
  
  // Query for existing record
  const result1 = await cache.query({ key: 'theme' }, {})
  console.log('Query for theme:', result1)
  
  // Query for non-existent record - All cache is authoritative
  const result2 = await cache.query({ key: 'nonexistent' }, {})
  console.log('Query for nonexistent:', result2)  // Empty array, not null
  console.log('All cache prevented DB query:', Array.isArray(result2))
  
  console.log('Cache stats:', cache.getStats())
}

// ============================================================================
// Example 6: Write Debouncing
// ============================================================================

async function example6_WriteDebouncing() {
  console.log('\n=== Example 6: Write Debouncing ===')
  
  const cacheManager = new CacheManager()
  const cache = new AppTableCache(cacheManager, 'alice', 'blog_posts', {
    cacheRecent: true
  })
  
  // Set up a refresh function that logs when called
  let refreshCount = 0
  cache.setRefreshFunction(async (dirtyFlags) => {
    refreshCount++
    console.log(`  Refresh called (count: ${refreshCount})`)
    console.log(`  Dirty flags:`, dirtyFlags)
  })
  
  // Simulate rapid writes
  console.log('Simulating 5 rapid writes...')
  for (let i = 0; i < 5; i++) {
    cache.markDirty(`post${i}`)
    console.log(`  Write ${i + 1}`)
    await new Promise(resolve => setTimeout(resolve, 200))  // 200ms between writes
  }
  
  // Wait for debounce to trigger
  console.log('Waiting for debounce (1 second after last write)...')
  await new Promise(resolve => setTimeout(resolve, 1500))
  
  console.log(`Total refresh calls: ${refreshCount} (should be 1)`)
}

// ============================================================================
// Example 7: File Caching
// ============================================================================

async function example7_FileCache() {
  console.log('\n=== Example 7: File Cache ===')
  
  const cacheManager = new CacheManager()
  const cache = new AppTableCache(cacheManager, 'alice', 'blog_app')
  
  // Cache a file
  const fileContent = '<html><body>Hello World</body></html>'
  cache.setFile('public/index.html', fileContent)
  console.log('Cached file: public/index.html')
  
  // Retrieve from cache
  const cached = cache.getFile('public/index.html')
  console.log('Retrieved from cache:', cached ? 'Success' : 'Miss')
  
  // Try to cache large file (should fail)
  const largeContent = 'x'.repeat(2 * 1024 * 1024)  // 2MB
  const success = cache.setFile('large.dat', largeContent)
  console.log('Large file cached:', success)  // false - exceeds limit
  
  console.log('Cache stats:', cache.getStats())
}

// ============================================================================
// Example 8: Memory Monitoring and Eviction
// ============================================================================

async function example8_MemoryEviction() {
  console.log('\n=== Example 8: Memory Monitoring ===')
  
  const cacheManager = new CacheManager({
    memoryThreshold: 0.8,
    logEvictions: true
  })
  
  // Create multiple caches
  const caches = []
  for (let i = 0; i < 5; i++) {
    caches.push(new AppTableCache(cacheManager, `user${i}`, 'data'))
  }
  
  // Fill with data (simulating load)
  console.log('Filling caches...')
  for (let i = 0; i < 5; i++) {
    const records = []
    for (let j = 0; j < 100; j++) {
      records.push({ _id: `${i}_${j}`, data: 'x'.repeat(1000) })
    }
    await caches[i].setQuery({ type: 'test' }, records)
  }
  
  // Check stats
  const stats = cacheManager.getStats()
  console.log('Global stats:', stats)
  
  // Manual eviction check
  console.log('\nChecking memory usage...')
  cacheManager.checkMemoryUsage()
}

// ============================================================================
// Example 9: Integration Pattern (How ds_manager uses it)
// ============================================================================

async function example9_IntegrationPattern() {
  console.log('\n=== Example 9: Integration Pattern ===')
  
  // This simulates the integration in userDsMgr.mjs
  
  const cacheManager = new CacheManager()
  
  // Simulated DB object
  const mockDb = {
    query_async: async (query, options) => {
      console.log('  DB query executed:', query)
      return [
        { _id: '1', title: 'Post 1', _date_modified: Date.now() }
      ]
    }
  }
  
  // Create cache
  const cache = new AppTableCache(cacheManager, 'alice', 'blog_posts')
  
  // Set refresh function (done in initOacDB)
  cache.setRefreshFunction(async (dirtyFlags) => {
    if (dirtyFlags.Recent) {
      const recent = await mockDb.query_async({}, { 
        sort: { _date_modified: -1 }, 
        limit: 1000 
      })
      await cache.setRecent(recent)
    }
  })
  
  // Wrapped query function (done in initOacDB)
  const wrappedQuery = async (query, options = {}) => {
    // Try cache first
    const cached = await cache.query(query, options)
    if (cached !== null) {
      console.log('  Cache HIT')
      return cached
    }
    
    // Cache miss - hit DB
    console.log('  Cache MISS')
    const results = await mockDb.query_async(query, options)
    
    // Store in cache
    await cache.setQuery(query, results, options)
    
    return results
  }
  
  // Test the wrapped query
  console.log('First query:')
  await wrappedQuery({ status: 'published' })
  
  console.log('\nSecond query (same):')
  await wrappedQuery({ status: 'published' })
  
  console.log('\nStats:', cache.getStats())
}

// ============================================================================
// Run All Examples
// ============================================================================

async function runAllExamples() {
  try {
    await example1_BasicSetup()
    await example2_QueryFlow()
    await example3_ByKeyCache()
    await example4_RecentCache()
    await example5_AllCache()
    await example6_WriteDebouncing()
    await example7_FileCache()
    await example8_MemoryEviction()
    await example9_IntegrationPattern()
    
    console.log('\n=== All Examples Complete ===')
  } catch (err) {
    console.error('Error running examples:', err)
  }
}

// Export for use
export {
  example1_BasicSetup,
  example2_QueryFlow,
  example3_ByKeyCache,
  example4_RecentCache,
  example5_AllCache,
  example6_WriteDebouncing,
  example7_FileCache,
  example8_MemoryEviction,
  example9_IntegrationPattern,
  runAllExamples
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllExamples()
}
