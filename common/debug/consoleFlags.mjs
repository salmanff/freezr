// freezr.info - Runtime console-log category toggles (in-memory, non-persistent)
//
// A single shared object that gates categories of debug console.logs at runtime.
// Mutating freezrConsole.flags from one importer (e.g. the admin API) is visible to
// every other importer (e.g. the cache adapters) because ES modules are singletons.
// State is intentionally NOT persisted - it resets to all-off on every server restart.
// serverStartedAt makes that reset moment visible in the admin UI.

export const freezrConsole = {
  serverStartedAt: new Date().toISOString(), // stamped on first import ≈ server start
  flags: {
    cachemgmt: false, // gates the C-M cache-management logs
    backgroundjoblog: false // gates the TMPJOBLOG background-job logs
    // add future categories here, and to CONSOLE_CATEGORIES below
  }
}

// Category metadata for the admin UI (label + description per flag)
export const CONSOLE_CATEGORIES = [
  { key: 'cachemgmt', label: 'Cache management', description: 'C-M cache hit/miss/invalidate trace' },
  { key: 'backgroundjoblog', label: 'Background jobs', description: 'TMPJOBLOG job deploy/trust/materialize trace' }
]

// Helper used by the cache adapters - no-op unless the cachemgmt flag is on
export function cmLog (...args) {
  if (freezrConsole.flags.cachemgmt) console.log(...args)
}

// Helper used by the background-job code - no-op unless the backgroundjoblog flag is on
export function bjLog (...args) {
  if (freezrConsole.flags.backgroundjoblog) console.log(...args)
}
