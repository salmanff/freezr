// Manual probe for the ClaudeLocal connector against the REAL claude CLI on this machine.
// Run AFTER installing and logging in the CLI (uses a tiny amount of subscription quota):
//
//   node test/manual/claude-local-cli-probe.mjs
//
// Prereqs:  curl -fsSL https://claude.ai/install.sh | bash   (installs ~/.local/bin/claude)
//           run `claude` once in a terminal and log in with your subscription
//
// What it proves: binary discovery, a non-streaming ask (JSON result parse, usage/notional
// cost fields), a streaming ask (delta -> done protocol), and that ANTHROPIC_API_KEY in the
// parent env is NOT spent (it is stripped from the child). Afterwards, check your Anthropic
// Console: these calls must NOT appear as metered API usage.

import { findClaudeBinary, ask, askStream, listModels, getPricing } from '../../adapters/llmConnectors/claudeLocal.mjs'

const log = (label, value) => console.log('\n=== ' + label + ' ===\n', typeof value === 'string' ? value : JSON.stringify(value, null, 2))

const main = async () => {
  const binaryPath = findClaudeBinary(process.argv[2] || null)
  if (!binaryPath) {
    console.error('❌ No claude CLI found. Install it and log in first (see header comments), or pass the binary path as an argument.')
    process.exit(1)
  }
  log('binary', binaryPath)
  log('listModels', await listModels({}))
  log('getPricing (should be all zeros)', await getPricing({}))

  const local = { binaryPath }

  console.log('\n--- ask (non-streaming, model: haiku) ---')
  const t0 = Date.now()
  const res = await ask({
    prompt: 'Reply with exactly: freezr local connector ok',
    context: 'You answer with exactly what is asked, nothing else.',
    model: 'haiku',
    local
  })
  log('ask result (' + (Date.now() - t0) + 'ms)', {
    response: res.response,
    model: res.model,
    family: res.family,
    tokensUsed: res.tokensUsed,
    notionalCostUsd: res.rawUsage?.notionalCostUsd
  })

  console.log('\n--- askStream (model: haiku) ---')
  let deltas = 0
  let done = null
  for await (const chunk of askStream({ prompt: 'Count from 1 to 5, one number per line.', model: 'haiku', local })) {
    if (chunk.type === 'delta') { deltas++; process.stdout.write(chunk.text) }
    if (chunk.type === 'thinking') process.stdout.write('[thinking]')
    if (chunk.type === 'done') done = chunk
  }
  log('stream summary', { deltas, response: done?.response, tokensUsed: done?.tokensUsed })

  console.log('\n✅ Probe complete. Now check https://platform.claude.com usage — these calls must NOT appear as metered API usage.')
}

main().catch(e => {
  console.error('\n❌ Probe failed:', e.code || '', e.message)
  process.exit(1)
})
