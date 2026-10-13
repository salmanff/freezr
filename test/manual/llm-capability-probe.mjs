// Manual probe: what does Anthropic's Models API actually say each model can do?
//
// WHY THIS EXISTS. freezr resolves LLM capabilities in three tiers (see the note in
// common/helpers/llmCapabilities.mjs): tier 1 is hardcoded about our own adapter, tier 2 is
// READ LIVE from the provider's per-model `capabilities` tree, and tier 3 is learned by
// trying. Tier 2 needs to know what that tree actually names things — and the published
// examples only show image_input / thinking / effort / structured_outputs / context_management,
// with no web-tool leaf documented. Run this against a real key to find out.
//
// Whatever it prints, the code already works: a leaf we can read is tier 2, and a leaf that
// isn't there falls to tier 3 (probe on first use, memoized for an hour). This just tells us
// which branch is carrying web access, and lets us tighten CAPABILITY_TREE_PATHS if the tree
// does publish one.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... node test/manual/llm-capability-probe.mjs
//   node test/manual/llm-capability-probe.mjs sk-ant-...        (key as an argument)
//
// Read-only: lists models and reads their capability trees. It sends NO prompts and costs
// nothing.

import Anthropic from '@anthropic-ai/sdk'
import { CAPABILITY_TREE_PATHS, readCapabilityLeaf, summarizeModelCapabilities } from '../../adapters/llmConnectors/anthropic.mjs'

const apiKey = process.argv[2] || process.env.ANTHROPIC_API_KEY
if (!apiKey) {
  console.error('No key. Pass one as an argument or set ANTHROPIC_API_KEY.')
  console.error('Your freezr key is under Account > Resources (it is stored encrypted, so this script cannot read it for you).')
  process.exit(1)
}

const client = new Anthropic({ apiKey })

console.log('Fetching models…\n')
const { data: models } = await client.models.list({ limit: 100 })
console.log('Found ' + models.length + ' models.\n')

// 1. Does the LIST response carry capabilities, or only the per-model retrieve?
const listHasTree = models.some(m => m.capabilities)
console.log('models.list() includes a capabilities tree: ' + (listHasTree ? 'YES' : 'NO'))
if (!listHasTree) {
  console.log('  -> tier 2 would need a per-model retrieve; getCapabilities currently reads')
  console.log('     the cached list, so it will fall through to tier 3 (probe). Still correct,')
  console.log('     just one extra first-use round trip per model.\n')
}

// 2. Dump one full tree so we can see every key the provider publishes.
const sample = models.find(m => /opus-5|opus-4-8|sonnet-5/.test(m.id)) || models[0]
console.log('\n=== FULL capability tree for ' + sample.id + ' ===')
const full = sample.capabilities || (await client.models.retrieve(sample.id)).capabilities
console.log(JSON.stringify(full, null, 2))

// 3. The question this script exists to answer.
console.log('\n=== Web-tool leaves ===')
console.log('Paths tried for web.search: ' + CAPABILITY_TREE_PATHS['web.search'].join(', '))
console.log('Paths tried for web.fetch:  ' + CAPABILITY_TREE_PATHS['web.fetch'].join(', '))
console.log('web.search resolves to: ' + JSON.stringify(readCapabilityLeaf(full, CAPABILITY_TREE_PATHS['web.search'])))
console.log('web.fetch  resolves to: ' + JSON.stringify(readCapabilityLeaf(full, CAPABILITY_TREE_PATHS['web.fetch'])))

const topLevelKeys = Object.keys(full || {})
const webish = topLevelKeys.filter(k => /web|search|fetch|tool/i.test(k))
console.log('\nTop-level keys that look web/tool related: ' + (webish.length ? webish.join(', ') : '(none)'))
if (!webish.length) {
  console.log('  -> the tree says nothing about web tools, so web access resolves as UNKNOWN')
  console.log('     and is settled by tier 3 (try it, then remember). That is the designed path.')
} else {
  console.log('  -> add the right spelling to CAPABILITY_TREE_PATHS in adapters/llmConnectors/anthropic.mjs')
  console.log('     to promote web access from tier 3 to tier 2.')
}

console.log('\nAll top-level capability keys: ' + topLevelKeys.join(', '))

// 4. What freezr would publish per model in a ping.
console.log('\n=== What ping would report per model ===')
for (const m of models.slice(0, 12)) {
  const tree = m.capabilities
  console.log('  ' + m.id.padEnd(34) + (tree ? JSON.stringify(summarizeModelCapabilities(tree)) : '(no tree in list response)'))
}
