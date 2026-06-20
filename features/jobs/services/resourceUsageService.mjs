// freezr.info — Resource usage/cost sink (plan §9.2)
//
// One shared table, info.freezr.resourceUsage, keyed by (owner_id, app_name), for ALL metered
// resources — serverless job runs (this phase) and LLM queries (retrofit later). Whenever freezr
// computes a cost it writes a row here; management (rollups / caps / dashboard) is out of scope but
// unblocked by having the rows from day one. Handle-based: the caller opens the db and passes it.
//
//   row: { owner_id, app_name, resource:'serverless_job'|'llm', ref, usage, estCost, currency, at }

/**
 * Append a usage row. Non-fatal by contract — returns { written:false } if no db handle.
 * @param {Object} resourceUsageDb  opened info.freezr.resourceUsage handle (user-owned)
 */
export async function recordResourceUsage (resourceUsageDb, { ownerId, appName, resource, ref = null, usage = {}, estCost = null, currency = null, at = Date.now() } = {}) {
  if (!resourceUsageDb) return { written: false }
  if (!ownerId || !appName || !resource) throw new Error('recordResourceUsage: ownerId, appName, resource required')
  const row = { owner_id: ownerId, app_name: appName, resource, ref, usage: usage || {}, estCost, currency, at }
  const created = await resourceUsageDb.create(null, row, {})
  return { written: true, _id: created && created._id }
}

export default { recordResourceUsage }
