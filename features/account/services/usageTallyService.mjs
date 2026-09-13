// freezr.info — Metered-resource usage tallies — usageTallyService.mjs
//
// One record per (user, app, API key, upstream vendor, UTC day) in the user-owned table
// info.freezr.account.usageTallies. Whenever freezr spends a metered resource on a user's
// behalf it adds to that day's record; the account/admin resource-usage page reads them
// back. Handle-based: the caller opens the db and passes it (see llmContext.mjs).
//
// Why the key is the API KEY and not the provider: a user can hold several type:'llm'
// resources, and two Claude keys usually means two budgets (personal vs work, a key per
// project). Merging them would erase exactly the distinction the user set up.
//
// Why VENDOR is in the key and not only in `models`: an aggregator key (OpenRouter) spans
// anthropic/*, openai/*, google/*, so the key alone is not a vendor. With vendor at row
// level, byKey / byVendor / byApp are all one-line rollups over rows, and a direct Claude
// key simply has vendor === provider.
//
//   row: { resource, owner_id, app_name, resource_id, resource_name, provider, vendor,
//          date, month, requests, errors, aborted, unpriced_requests, unmetered_requests,
//          tokens:{input,output,other,total}, cost:{input,output,other,total}, currency,
//          cost_source, kinds:{<kind>:n}, models:[{model,requests,tokens,cost}],
//          first_at, last_at, version }
//
// `models` is an ARRAY, not a keyed map like info.freezr.account.llmpricing: model ids
// contain '.' (gpt-4.1) and, via aggregators, '/' (anthropic/claude-sonnet-4.5). Mongo
// field names cannot hold a '.', and llmpricing's '_' -> '.' un-sanitize is lossy for any
// id that already contains '_'. An array stores ids verbatim.

const TALLY_VERSION = 1
const QUERY_PAGE_SIZE = 500
const DEFAULT_CURRENCY = 'USD'

export const COST_SOURCE_ESTIMATE = 'freezr_pricetable'
export const COST_SOURCE_REPORTED = 'provider_reported'
export const COST_SOURCE_MIXED = 'mixed'

/** UTC calendar day, 'YYYY-MM-DD'. UTC (not server-local) so tallies don't shift if the host moves. */
export const utcDay = (at) => new Date(at).toISOString().slice(0, 10)

const zeroBuckets = () => ({ input: 0, output: 0, other: 0, total: 0 })

const addBuckets = (target, add) => {
  target.input += add.input || 0
  target.output += add.output || 0
  target.other += add.other || 0
  target.total += add.total || 0
  return target
}

/**
 * Pull the four token counts and four dollar amounts out of the shapes the LLM controller
 * already has in hand: `tokensUsed` ({input:{qtty,cost},output,other}) and the `cost`
 * summary from buildCostSummary ({inputTokens..., inputCost..., totalCost}).
 */
const extractUsage = (tokensUsed, cost) => {
  const tokens = {
    input: tokensUsed?.input?.qtty || 0,
    output: tokensUsed?.output?.qtty || 0,
    other: tokensUsed?.other?.qtty || 0,
    total: 0
  }
  tokens.total = tokens.input + tokens.output + tokens.other

  const hasCost = !!cost && Number.isFinite(Number(cost.totalCost))
  const costs = hasCost
    ? {
        input: Number(cost.inputCost) || 0,
        output: Number(cost.outputCost) || 0,
        other: Number(cost.otherCost) || 0,
        total: Number(cost.totalCost) || 0
      }
    : zeroBuckets()

  return { tokens, costs, hasTokens: tokens.total > 0, hasCost }
}

// ---------------------------------------------------------------------------
// Write serialization.
//
// The datastore layer has no atomic increment: ds.update is $set-only and mongo's upsert
// flag is never used anywhere in freezr, so every tally write is a read-modify-write and
// two concurrent LLM calls on the same key would lose one of the two updates. freezr runs
// as a single instance (see CLAUDE.md), so chaining writes per tally key in-process is
// enough. Multi-instance deployments would need real $inc support in adapters/datastore.
// ---------------------------------------------------------------------------
const writeChains = new Map()

const serializeByKey = (key, fn) => {
  const prev = writeChains.get(key) || Promise.resolve()
  const run = prev.then(fn, fn)
  const settled = run.catch(() => {})
  writeChains.set(key, settled)
  settled.then(() => { if (writeChains.get(key) === settled) writeChains.delete(key) })
  return run
}

/** Number of tally keys with a write in flight — for tests/diagnostics only. */
export const pendingWriteCount = () => writeChains.size

/**
 * Add one metered call to its day's tally. Non-fatal by contract: returns { written:false }
 * when there is no db handle, and callers are expected to try/catch the rest — an
 * accounting failure (including storageLimitExceeded when the user is over quota) must
 * never break the response it is accounting for.
 *
 * @param {Object} tallyDb   opened info.freezr.account.usageTallies handle (user-owned)
 * @param {string} outcome   'ok' | 'error' | 'aborted'
 */
export async function recordUsage (tallyDb, {
  ownerId,
  appName,
  resource = 'llm',
  resourceId = null,
  resourceName = null,
  provider = null,
  vendor = null,
  model = null,
  kind = null,
  tokensUsed = null,
  cost = null,
  costSource = COST_SOURCE_ESTIMATE,
  currency = DEFAULT_CURRENCY,
  outcome = 'ok',
  at = Date.now()
} = {}) {
  if (!tallyDb) return { written: false }
  if (!ownerId || !appName || !resource) throw new Error('recordUsage: ownerId, appName, resource required')

  const date = utcDay(at)
  const resolvedVendor = vendor || provider || 'unknown'
  const key = {
    resource,
    date,
    app_name: appName,
    resource_id: resourceId ? String(resourceId) : null,
    vendor: resolvedVendor
  }

  return serializeByKey([resource, date, appName, key.resource_id, resolvedVendor].join('|'), async () => {
    const existing = await tallyDb.query(key, { count: 2 })
    const row = (existing && existing[0]) ? existing[0] : null
    if (existing && existing.length > 1) {
      console.warn('usageTallies: more than one row for', JSON.stringify(key), '- rollups sum them, but this should not happen on a single instance')
    }

    // Every nested object is copied, never aliased: a cached ds.query can hand back the
    // stored record itself, and adding into its buckets in place would corrupt the cache.
    const merged = row
      ? {
          ...row,
          tokens: { ...zeroBuckets(), ...(row.tokens || {}) },
          cost: { ...zeroBuckets(), ...(row.cost || {}) },
          kinds: { ...(row.kinds || {}) },
          models: Array.isArray(row.models)
            ? row.models.map(m => ({
              ...m,
              tokens: { ...zeroBuckets(), ...(m.tokens || {}) },
              cost: { ...zeroBuckets(), ...(m.cost || {}) }
            }))
            : []
        }
      : {
          ...key,
          owner_id: ownerId,
          requests: 0,
          errors: 0,
          aborted: 0,
          unpriced_requests: 0,
          unmetered_requests: 0,
          tokens: zeroBuckets(),
          cost: zeroBuckets(),
          currency,
          cost_source: null,
          kinds: {},
          models: [],
          month: date.slice(0, 7),
          first_at: at,
          version: TALLY_VERSION
        }

    // Labels are refreshed on every merge so a renamed key shows its current name, while a
    // deleted key keeps the name it had when it was spent.
    if (resourceName) merged.resource_name = resourceName
    if (provider) merged.provider = provider

    const { tokens, costs, hasTokens, hasCost } = extractUsage(tokensUsed, cost)

    merged.requests = (merged.requests || 0) + 1
    if (outcome === 'error') merged.errors = (merged.errors || 0) + 1
    if (outcome === 'aborted') merged.aborted = (merged.aborted || 0) + 1
    if (!hasTokens) merged.unmetered_requests = (merged.unmetered_requests || 0) + 1
    else if (!hasCost) merged.unpriced_requests = (merged.unpriced_requests || 0) + 1

    addBuckets(merged.tokens, tokens)
    addBuckets(merged.cost, costs)
    if (kind) merged.kinds[kind] = (merged.kinds[kind] || 0) + 1
    merged.last_at = at

    if (hasCost) {
      merged.cost_source = (!merged.cost_source || merged.cost_source === costSource)
        ? costSource
        : COST_SOURCE_MIXED
    }

    if (model) {
      let entry = merged.models.find(m => m.model === model)
      if (!entry) {
        entry = { model, requests: 0, tokens: zeroBuckets(), cost: zeroBuckets() }
        merged.models.push(entry)
      }
      entry.requests += 1
      addBuckets(entry.tokens, tokens)
      addBuckets(entry.cost, costs)
    }

    if (row) {
      await tallyDb.update(String(row._id), merged, { replaceAllFields: true, old_entity: row })
      return { written: true, _id: row._id, created: false }
    }
    const created = await tallyDb.create(null, merged, {})
    return { written: true, _id: created && created._id, created: true }
  })
}

/**
 * Read tallies for a date range. Paginates explicitly: both db connectors silently cap a
 * query at ARBITRARY_FIND_COUNT_DEFAULT (100) records, which a 90-day range across a few
 * apps and keys will exceed.
 */
export async function queryTallies (tallyDb, { resource = 'llm', from = null, to = null, appName = null, resourceId = null, vendor = null } = {}) {
  if (!tallyDb) return []
  const query = {}
  if (resource) query.resource = resource
  if (appName) query.app_name = appName
  if (resourceId) query.resource_id = String(resourceId)
  if (vendor) query.vendor = vendor
  if (from || to) {
    query.date = {}
    if (from) query.date.$gte = from
    if (to) query.date.$lte = to
  }

  const rows = []
  let skip = 0
  for (;;) {
    const page = await tallyDb.query(query, { skip, count: QUERY_PAGE_SIZE })
    if (!page || page.length === 0) break
    rows.push(...page)
    if (page.length < QUERY_PAGE_SIZE) break
    skip += QUERY_PAGE_SIZE
  }
  return rows.sort((a, b) => String(a.date).localeCompare(String(b.date)))
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Only a literal YYYY-MM-DD string is allowed near a db query — never an array or object. */
const safeDate = (v) => ((typeof v === 'string' && DATE_RE.test(v)) ? v : null)

/**
 * Turn user-supplied ?from/?to into a validated inclusive range, defaulting to the last
 * `days` days ending today (UTC). Anything that isn't a YYYY-MM-DD string is discarded, so
 * a repeated query param (which express hands over as an array) can't reach the query.
 */
export const resolveRange = ({ from = null, to = null, days = 30 } = {}, now = Date.now()) => {
  const end = safeDate(to) || utcDay(now)
  const start = safeDate(from)
  if (start) return { from: start, to: end }
  // Garbage (negative, NaN, absurd) falls back to the 30-day default rather than to a
  // surprising one-day window; 400 days is the hard ceiling on one page load.
  const requested = parseInt(days, 10)
  const span = Math.min((Number.isFinite(requested) && requested > 0) ? requested : 30, 400)
  const d = new Date(end + 'T00:00:00.000Z')
  d.setUTCDate(d.getUTCDate() - (span - 1))
  return { from: d.toISOString().slice(0, 10), to: end }
}

const blankTotals = (extra = {}) => ({
  requests: 0,
  errors: 0,
  aborted: 0,
  unpriced_requests: 0,
  unmetered_requests: 0,
  tokens: zeroBuckets(),
  cost: zeroBuckets(),
  cost_source: null,
  ...extra
})

const addRowInto = (totals, row) => {
  totals.requests += row.requests || 0
  totals.errors += row.errors || 0
  totals.aborted += row.aborted || 0
  totals.unpriced_requests += row.unpriced_requests || 0
  totals.unmetered_requests += row.unmetered_requests || 0
  addBuckets(totals.tokens, row.tokens || {})
  addBuckets(totals.cost, row.cost || {})
  if (row.cost_source) {
    totals.cost_source = (!totals.cost_source || totals.cost_source === row.cost_source)
      ? row.cost_source
      : COST_SOURCE_MIXED
  }
  return totals
}

/** Fold a row's per-model entries into an accumulating array (same shape, ids verbatim). */
const addModelsInto = (target, row) => {
  for (const m of (row.models || [])) {
    let entry = target.find(e => e.model === m.model)
    if (!entry) {
      entry = { model: m.model, requests: 0, tokens: zeroBuckets(), cost: zeroBuckets() }
      target.push(entry)
    }
    entry.requests += m.requests || 0
    addBuckets(entry.tokens, m.tokens || {})
    addBuckets(entry.cost, m.cost || {})
  }
  return target
}

const groupBy = (rows, keyOf, labelOf, { withModels = false } = {}) => {
  const map = new Map()
  for (const row of rows) {
    const k = keyOf(row)
    if (!map.has(k)) map.set(k, blankTotals(withModels ? { ...labelOf(row), models: [] } : labelOf(row)))
    const entry = map.get(k)
    addRowInto(entry, row)
    if (withModels) addModelsInto(entry.models, row)
  }
  const out = [...map.values()].sort((a, b) => b.cost.total - a.cost.total)
  if (withModels) out.forEach(e => e.models.sort((a, b) => b.cost.total - a.cost.total))
  return out
}

/**
 * Roll rows up for display. Duplicate rows for one tally key are summed rather than
 * de-duplicated: ids are native and the row is found by field query, so a stray double row
 * (only possible across instances) should degrade to a cosmetic issue, not lost dollars.
 */
export function summarizeTallies (rows = []) {
  const total = blankTotals()
  for (const row of rows) addRowInto(total, row)

  const models = new Map()
  for (const row of rows) {
    for (const m of (row.models || [])) {
      const k = row.vendor + '|' + m.model
      if (!models.has(k)) {
        models.set(k, { model: m.model, vendor: row.vendor, provider: row.provider, requests: 0, tokens: zeroBuckets(), cost: zeroBuckets() })
      }
      const entry = models.get(k)
      entry.requests += m.requests || 0
      addBuckets(entry.tokens, m.tokens || {})
      addBuckets(entry.cost, m.cost || {})
    }
  }

  return {
    total,
    byApp: groupBy(rows, r => r.app_name, r => ({ app_name: r.app_name })),
    byKey: groupBy(rows, r => String(r.resource_id) + '|' + r.provider,
      r => ({ resource_id: r.resource_id, resource_name: r.resource_name || null, provider: r.provider || null })),
    byVendor: groupBy(rows, r => r.vendor, r => ({ vendor: r.vendor })),
    // The table grain: one line per app + key + vendor across the whole range, each
    // carrying its own model breakdown to expand.
    byAppKeyVendor: groupBy(rows,
      r => [r.app_name, r.resource_id, r.vendor].join('|'),
      r => ({
        app_name: r.app_name,
        resource_id: r.resource_id,
        resource_name: r.resource_name || null,
        provider: r.provider || null,
        vendor: r.vendor
      }),
      { withModels: true }),
    byProvider: groupBy(rows, r => r.provider, r => ({ provider: r.provider || null })),
    byModel: [...models.values()].sort((a, b) => b.cost.total - a.cost.total),
    byDay: groupBy(rows, r => r.date, r => ({ date: r.date }))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
  }
}

export default { recordUsage, queryTallies, summarizeTallies, resolveRange, utcDay, pendingWriteCount }
