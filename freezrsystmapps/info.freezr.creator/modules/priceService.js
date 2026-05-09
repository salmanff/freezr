const getCategoryQty = (category) => category?.qtty || 0
const getCategoryCost = (category) => category?.cost || 0

const summarizeTokensUsed = (tokensUsed) => {
  if (!tokensUsed) return null
  const inputTokens = getCategoryQty(tokensUsed.input)
  const outputTokens = getCategoryQty(tokensUsed.output)
  const otherTokens = getCategoryQty(tokensUsed.other)
  const inputCost = getCategoryCost(tokensUsed.input)
  const outputCost = getCategoryCost(tokensUsed.output)
  const otherCost = getCategoryCost(tokensUsed.other)
  return {
    inputTokens,
    outputTokens,
    otherTokens,
    totalTokens: inputTokens + outputTokens + otherTokens,
    inputCost,
    outputCost,
    otherCost,
    totalCost: inputCost + outputCost + otherCost
  }
}

// Fallback path used only when a record has token counts but no stored `cost`.
export const calculateCostFromTokensUsed = (tokensUsed) => summarizeTokensUsed(tokensUsed)

const COSTED_ACTIONS = new Set(['chat', 'image_generation'])

export const calculateEntryCost = (entry, options = {}) => {
  const recalculateFromTokens = options.recalculateFromTokens === true
  if (!entry || !COSTED_ACTIONS.has(entry.action)) return null
  if (entry.cost && entry.cost.totalCost !== undefined) return entry.cost
  if (recalculateFromTokens && entry.tokensUsed) return calculateCostFromTokensUsed(entry.tokensUsed)
  return null
}

export const calculateProjectCost = (history) => {
  if (!history || !Array.isArray(history)) return null
  let totalCost = 0
  let totalTokens = 0
  let pricedItems = 0
  let unpricedItems = 0

  for (const entry of history) {
    if (!COSTED_ACTIONS.has(entry.action)) continue
    const cost = calculateEntryCost(entry)
    if (cost) {
      totalCost += cost.totalCost
      totalTokens += cost.totalTokens || 0
      pricedItems++
    } else if (entry.tokensUsed) {
      totalTokens += summarizeTokensUsed(entry.tokensUsed)?.totalTokens || 0
      unpricedItems++
    } else {
      unpricedItems++
    }
  }

  return { totalCost, totalTokens, pricedItems, unpricedItems }
}

export const formatCost = (cost) => {
  if (!cost) return ''
  const dollars = cost.totalCost
  if (dollars < 0.01) return '$' + dollars.toFixed(4)
  return '$' + dollars.toFixed(3)
}

export const formatTokens = (count) => {
  if (!count && count !== 0) return ''
  if (count >= 1000) return (count / 1000).toFixed(1) + 'k'
  return String(count)
}
