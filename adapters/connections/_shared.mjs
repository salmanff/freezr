// freezr.info - Shared transport helpers for mail connectors
//
// Provider-agnostic primitives that every mail connector (Gmail, future Graph, future
// IMAP) composes with its own provider-tuned configuration. Two helpers:
//
//   - runConcurrent(items, limit, fn)
//       Process `items` through async `fn` with at most `limit` in flight at once.
//       Returns results in input order. Throws on first error.
//
//   - fetchWithRetry(url, init, retryConfig)
//       Wraps native fetch with retry on transient errors (429, 5xx, network).
//       Honors Retry-After when present; otherwise exponential backoff with jitter.
//       After exhausting attempts, throws an Error carrying { status, body? } so
//       callers can preserve their existing error-shape handling.
//
// =====================================================================================
// RATE-LIMIT CONTRACT (mail connectors)
// =====================================================================================
// All mail connectors must:
//   1. Use `runConcurrent(items, MAX_PARALLEL, fn)` for per-item fan-out, where
//      MAX_PARALLEL is conservative (default 5).
//   2. Use `fetchWithRetry(...)` for every outbound HTTP call (HTTP connectors only —
//      IMAP wraps its own equivalent at the imapflow layer).
//   3. Surface non-retryable failures as Error objects with `.status` set.
//
// Provider tunings live in each connector — not here.
// =====================================================================================

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Process `items` through `fn` with at most `limit` in flight at once.
 * Preserves input order in the returned array. Throws on first error.
 *
 * @template T, U
 * @param {T[]} items
 * @param {number} limit       Concurrency cap, >= 1.
 * @param {(item: T, index: number) => Promise<U>} fn
 * @returns {Promise<U[]>}
 */
export const runConcurrent = async (items, limit, fn) => {
  if (!Array.isArray(items)) throw new TypeError('runConcurrent: items must be an array')
  if (typeof limit !== 'number' || limit < 1) throw new TypeError('runConcurrent: limit must be >= 1')
  const out = new Array(items.length)
  let cursor = 0
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * Parse a Retry-After header value to milliseconds.
 * Accepts either delta-seconds or an HTTP-date. Returns null if unparseable.
 *
 * Provider-specific headers (e.g. Microsoft Graph's `x-ms-retry-after-ms`) can be
 * fed in here too — the value is just a string.
 *
 * @param {string|null|undefined} value
 * @returns {number|null}
 */
export const parseRetryAfter = (value) => {
  if (!value) return null
  const trimmed = String(value).trim()
  if (!trimmed) return null
  // Try integer seconds first.
  const asInt = Number(trimmed)
  if (Number.isFinite(asInt) && asInt >= 0) return Math.floor(asInt * 1000)
  // Try HTTP-date.
  const asDate = Date.parse(trimmed)
  if (Number.isFinite(asDate)) {
    const delta = asDate - Date.now()
    return delta > 0 ? delta : 0
  }
  return null
}

const DEFAULT_RETRY = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  // Per-attempt timeout. If a single fetch hangs longer than this, AbortController
  // cancels it and we retry (an abort counts as a network error). 0 disables.
  // 30s is generous for Gmail/Graph — most calls finish in <1s.
  timeoutMs: 30000,
  retryStatuses: new Set([429, 500, 502, 503, 504]),
  // Hook for providers with non-standard retry headers (e.g. Graph's x-ms-retry-after-ms).
  // Receives the Response; returns ms to wait, or null to fall back to Retry-After / backoff.
  parseProviderRetryAfter: null,
  // Optional log hook so connectors can record retries without coupling to console.
  onRetry: null
}

// Run an optional callback without letting its exceptions escape.
const safeCall = (fn, arg) => {
  if (!fn) return
  try { fn(arg) } catch (_) { /* swallow — callback shouldn't break the worker */ }
}

/**
 * Wraps native fetch with retry-on-transient logic and a per-attempt timeout.
 *
 * @param {string|URL} url
 * @param {RequestInit} [init]
 * @param {Partial<typeof DEFAULT_RETRY>} [retryConfig]
 * @returns {Promise<Response>}
 */
export const fetchWithRetry = async (url, init, retryConfig) => {
  const cfg = { ...DEFAULT_RETRY, ...(retryConfig || {}) }
  if (retryConfig?.retryStatuses) cfg.retryStatuses = new Set(retryConfig.retryStatuses)

  let attempt = 0
  let lastError = null

  while (attempt < cfg.maxAttempts) {
    attempt++

    // Per-attempt AbortController so a hung connection can't pin a worker forever.
    // If the caller already supplied a signal, prefer abort-on-either using a small
    // AbortSignal.any-style adapter so we honor both.
    const controller = new AbortController()
    const callerSignal = init && init.signal
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason)
      else callerSignal.addEventListener('abort', () => controller.abort(callerSignal.reason), { once: true })
    }
    const timeoutId = cfg.timeoutMs > 0
      ? setTimeout(() => {
          try { controller.abort(new Error('fetchWithRetry: per-attempt timeout (' + cfg.timeoutMs + 'ms) exceeded')) }
          catch (_) { /* ignore */ }
        }, cfg.timeoutMs)
      : null

    try {
      const res = await fetch(url, { ...init, signal: controller.signal })
      if (!cfg.retryStatuses.has(res.status)) return res

      // Retryable status — work out backoff.
      if (attempt >= cfg.maxAttempts) return res // out of attempts; return as-is, caller throws

      const providerHint = cfg.parseProviderRetryAfter ? cfg.parseProviderRetryAfter(res) : null
      const headerHint = parseRetryAfter(res.headers.get('Retry-After'))
      const delay = providerHint ?? headerHint ?? backoffDelay(cfg, attempt)

      safeCall(cfg.onRetry, { url: String(url), attempt, status: res.status, delayMs: delay })
      // Drain response body to free the socket cleanly.
      try { await res.arrayBuffer() } catch (_) { /* ignore */ }
      await sleep(delay)
    } catch (err) {
      // Network / fetch error / our own timeout-abort — all treated as transient.
      // If the caller supplied an external abort signal and IT fired, don't retry.
      if (callerSignal && callerSignal.aborted) throw err
      lastError = err
      if (attempt >= cfg.maxAttempts) throw err
      const delay = backoffDelay(cfg, attempt)
      safeCall(cfg.onRetry, { url: String(url), attempt, status: null, delayMs: delay, error: err })
      await sleep(delay)
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
    }
  }

  // Shouldn't reach — loop returns or throws above.
  if (lastError) throw lastError
  throw new Error('fetchWithRetry: exhausted attempts without response')
}

const backoffDelay = (cfg, attempt) => {
  const exp = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * Math.pow(2, attempt - 1))
  const jitter = exp * 0.25 * (Math.random() * 2 - 1) // ±25%
  return Math.max(0, Math.floor(exp + jitter))
}

export default { runConcurrent, fetchWithRetry, parseRetryAfter }
