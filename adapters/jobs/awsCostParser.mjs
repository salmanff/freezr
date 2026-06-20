// freezr.info — AWS Lambda cost/usage parsing (plan §9.1)
//
// There is no "cost" field in the Invoke response, but serverless billing is deterministic and
// the inputs are in the tail logs. With LogType.Tail, the decoded LogResult ends with a REPORT
// line, e.g.:
//   REPORT RequestId: ab..  Duration: 12.34 ms  Billed Duration: 100 ms  Memory Size: 128 MB  Max Memory Used: 70 MB
// Cost = billedSeconds × memoryGB × pricePerGBSecond + perRequestCost (AWS constants). This is the
// direct analogue of the LLM token-cost calc; each adapter parses its own cloud's billing primitives
// and returns the normalized usage shape ({ billedMs, memoryMb, estCost, currency }).

// AWS Lambda pricing (arm64 / Graviton — what we deploy). Region variations are small; this is an
// estimate surfaced to the user, not an invoice. Ships as a constant so cost is available offline.
const ARM_PRICE_PER_GB_SECOND = 0.0000133334 // USD, arm64
const PRICE_PER_REQUEST = 0.20 / 1000000 // USD per invocation ($0.20 / 1M)

/**
 * Parse the Lambda REPORT tail line into normalized usage.
 * @param {string} logs  base64-decoded LogResult (the function's tail logs)
 * @returns {{ billedMs?, memoryMb?, maxMemoryMb?, estCost?, currency? }}  (empty if no REPORT line)
 */
export function parseLambdaReport (logs) {
  if (!logs || typeof logs !== 'string') return {}
  const billed = /Billed Duration:\s*([\d.]+)\s*ms/i.exec(logs)
  const mem = /Memory Size:\s*([\d.]+)\s*MB/i.exec(logs)
  const maxMem = /Max Memory Used:\s*([\d.]+)\s*MB/i.exec(logs)
  if (!billed && !mem) return {}

  const billedMs = billed ? Number(billed[1]) : null
  const memoryMb = mem ? Number(mem[1]) : null
  const out = {
    billedMs,
    memoryMb,
    maxMemoryMb: maxMem ? Number(maxMem[1]) : null
  }
  if (billedMs != null && memoryMb != null) {
    const gbSeconds = (memoryMb / 1024) * (billedMs / 1000)
    out.estCost = Number((gbSeconds * ARM_PRICE_PER_GB_SECOND + PRICE_PER_REQUEST).toFixed(8))
    out.currency = 'USD'
  }
  return out
}

export default { parseLambdaReport }
