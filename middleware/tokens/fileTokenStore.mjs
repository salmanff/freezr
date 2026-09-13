// Store for short-lived, scoped fileTokens (freezr_file_access_plan_v1.md §4b).
//
// Backed by the freezr CacheManager (a process-wide singleton — memory today, Redis-capable for
// multi-server later). Routing file-token storage through CacheManager means it rides the same path
// as the rest of freezr's caching and gains multi-server support for free when CacheManager does.
// The cache enforces TTL, so there is NO cleanup job; and because tokens live only in the cache
// (never a token DB), a URL-visible fileToken can never be replayed as an app/validation token.

import CacheManager from '../../adapters/datastore/cache/cacheManager.mjs'

const NS = 'fileToken:' // key namespace within the shared cache

// CacheManager is a singleton; dsManager constructs it at startup, so by request time `new CacheManager()`
// returns that already-initialised instance (memory or redis). Lazy → no import-time side effect.
const cache = () => new CacheManager()

export const fileTokenStore = {
  // `rec` must carry an `expiry` (epoch ms); the cache TTL is derived from it (seconds).
  set (token, rec) {
    if (!token || !rec) return
    const ttlSec = rec.expiry ? Math.max(1, Math.ceil((rec.expiry - Date.now()) / 1000)) : 600
    cache().set(NS + token, rec, { ttl: ttlSec, type: 'fileToken', namespace: 'fileTokens' })
  },
  // Returns the record if present AND unexpired, else null. The cache expires by TTL; the explicit
  // expiry re-check is belt-and-suspenders (and defends if a backend ever under-honours TTL).
  get (token) {
    if (!token) return null
    const rec = cache().get(NS + token) // null on miss / TTL-expired
    if (!rec) return null
    if (rec.expiry && rec.expiry < Date.now()) { cache().delete(NS + token); return null }
    return rec
  }
}
