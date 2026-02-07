// consoleFlogger.mjs - Fallback logger that uses console when FLogger isn't available
// This ensures logging always works, even during early startup or on errors

export const consoleFlogger = {
  info: (...args) => console.log('[INFO]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  auth: (...args) => console.log('[AUTH]', ...args),
  track: (...args) => console.log('[TRACK] consoleFlogger', ...args),
  debug: (...args) => console.log('[DEBUG]', ...args),
  setTokenParams: (appName) => console.log('[SET APP]', appName)  
}

// Helper to get an active logger, falling back to console
export function getLogger (flogger) {
  return flogger || consoleFlogger
}

