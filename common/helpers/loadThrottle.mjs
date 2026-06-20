// freezr.info - loadThrottle.mjs
//
// A tiny shared helper for long-running, throughput-y background work (e.g. the
// file-system migration copy loop) to *yield* to normal request traffic when the
// server is under pressure. Call `await yieldUnderLoad()` between work items: it
// returns immediately when the box is idle, and inserts a graduated back-off delay
// (or a brief pause + re-check) when it isn't.
//
// There is NO existing server-load mechanism in the codebase to reuse — the jobs
// scheduler only enforces a maxRuntime timeout + a single-tick re-entrancy guard.
// This helper is modelled on two patterns that DO exist:
//   - the cache manager's heap check via process.memoryUsage()  (cacheManager.mjs)
//   - the API rate-limiter's graduated delay                    (apiRateLimiter.mjs)
//
// Signals sampled (each normalised to a 0..1 "pressure" where 0 = soft threshold,
// 1 = hard threshold), and the worst one wins:
//   - event-loop lag (perf_hooks.monitorEventLoopDelay) — the most direct signal
//     that the process is starving request handling
//   - heap usage (process.memoryUsage heapUsed/heapTotal)
//   - OS load average per CPU (os.loadavg()[0] / cpuCount) — coarse, may be 0 on some platforms

import { monitorEventLoopDelay } from 'perf_hooks'
import os from 'os'

const CPU_COUNT = Math.max(1, os.cpus()?.length || 1)

// Tunable thresholds. soft = start throttling; hard = pause and re-check.
export const DEFAULT_THRESHOLDS = {
  eventLoopLagMs: { soft: 50, hard: 250 }, // mean event-loop delay over the sampling window
  heapUsedRatio: { soft: 0.80, hard: 0.93 }, // heapUsed / heapTotal
  loadPerCpu: { soft: 0.90, hard: 1.75 } // 1-min load average / cpu count
}

// Delay behaviour
const MAX_SOFT_DELAY_MS = 500 // delay when pressure is just under "hard"
const HARD_PAUSE_MS = 1500 // pause length when at/above "hard"
const MAX_HARD_RECHECKS = 4 // give up pausing after this many hard cycles (never block forever)

// A single shared event-loop-delay histogram, started once.
let eld = null
try {
  eld = monitorEventLoopDelay({ resolution: 20 })
  eld.enable()
} catch (e) {
  // perf_hooks.monitorEventLoopDelay unavailable — fall back to the other signals only
  eld = null
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// Returns each signal's raw value plus its normalised pressure (0 at soft, 1 at hard).
export const getLoadSnapshot = (thresholds = DEFAULT_THRESHOLDS) => {
  const norm = (value, { soft, hard }) => {
    if (hard <= soft) return value >= hard ? 1 : 0
    return (value - soft) / (hard - soft) // <0 below soft, >1 above hard
  }

  // event-loop lag (mean since last sample); reset so the next call measures a fresh window
  let lagMs = 0
  if (eld) {
    lagMs = eld.mean / 1e6 // ns -> ms
    eld.reset()
  }

  const mem = process.memoryUsage()
  const heapRatio = mem.heapTotal > 0 ? mem.heapUsed / mem.heapTotal : 0

  // os.loadavg() returns [0,0,0] on Windows — treat as no signal there
  const loadPerCpu = (os.loadavg()[0] || 0) / CPU_COUNT

  const pressures = {
    eventLoopLag: norm(lagMs, thresholds.eventLoopLagMs),
    heapUsed: norm(heapRatio, thresholds.heapUsedRatio),
    load: norm(loadPerCpu, thresholds.loadPerCpu)
  }

  const pressure = Math.max(pressures.eventLoopLag, pressures.heapUsed, pressures.load)

  return { lagMs, heapRatio, loadPerCpu, pressures, pressure }
}

/**
 * Sleep proportionally to current server pressure. Call between work items.
 *  - pressure <= 0 (idle, below all soft thresholds): returns ~immediately
 *  - 0 < pressure < 1: sleeps a delay scaling 0 -> MAX_SOFT_DELAY_MS
 *  - pressure >= 1 (at/above a hard threshold): sleeps HARD_PAUSE_MS and re-checks,
 *    up to MAX_HARD_RECHECKS times, so we never block a migration forever.
 *
 * @param {Object} [options]
 * @param {Object} [options.thresholds] - override DEFAULT_THRESHOLDS
 * @returns {Promise<{ sleptMs: number, snapshot: object }>}
 */
export const yieldUnderLoad = async (options = {}) => {
  const thresholds = options.thresholds || DEFAULT_THRESHOLDS
  let sleptMs = 0

  let snapshot = getLoadSnapshot(thresholds)
  if (snapshot.pressure <= 0) return { sleptMs, snapshot }

  // Soft zone: one graduated delay.
  if (snapshot.pressure < 1) {
    const delay = Math.round(Math.min(snapshot.pressure, 1) * MAX_SOFT_DELAY_MS)
    if (delay > 0) { await sleep(delay); sleptMs += delay }
    return { sleptMs, snapshot }
  }

  // Hard zone: pause and re-check a bounded number of times.
  for (let i = 0; i < MAX_HARD_RECHECKS && snapshot.pressure >= 1; i++) {
    await sleep(HARD_PAUSE_MS)
    sleptMs += HARD_PAUSE_MS
    snapshot = getLoadSnapshot(thresholds)
  }
  return { sleptMs, snapshot }
}

export default { yieldUnderLoad, getLoadSnapshot, DEFAULT_THRESHOLDS }
