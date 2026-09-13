// Store for short-lived inspection tokens (freezr_creator_selfcheck_plan_v1.md Part A).
//
// An inspection token lets an external agent (e.g. an LLM the user hands it to) READ one app's
// page/source files via GET /creator/inspect/:app_name/* — nothing else. It is a deliberate
// SIBLING of fileTokenStore, not an extension of it: separate namespace, separate routes, so a
// leaked fileToken can never read app source and a leaked inspect token can never read user data
// files. Like fileTokens, these live only in the cache (never the app_tokens DB), so a URL- or
// cookie-visible inspect token can never be replayed as an app/validation token.
//
// Backed by the freezr CacheManager (process-wide singleton — memory today, Redis-capable later).
// The cache enforces TTL, so there is NO cleanup job; tokens also die on server restart.

import CacheManager from '../../adapters/datastore/cache/cacheManager.mjs'

const NS = 'inspectToken:' // key namespace within the shared cache

// CacheManager is a singleton; dsManager constructs it at startup, so by request time `new CacheManager()`
// returns that already-initialised instance (memory or redis). Lazy → no import-time side effect.
const cache = () => new CacheManager()

export const inspectTokenStore = {
  // `rec` must carry: { app_name, owner_id, expiry } (expiry in epoch ms; TTL derived from it).
  set (token, rec) {
    if (!token || !rec) return
    const ttlSec = rec.expiry ? Math.max(1, Math.ceil((rec.expiry - Date.now()) / 1000)) : 1800
    cache().set(NS + token, rec, { ttl: ttlSec, type: 'inspectToken', namespace: 'inspectTokens' })
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
