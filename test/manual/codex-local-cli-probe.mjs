// Manual probe for the CodexLocal connector against the REAL codex CLI on this machine.
// Run AFTER installing and logging in the CLI (uses a small amount of ChatGPT-plan quota):
//
//   node test/manual/codex-local-cli-probe.mjs
//
// Prereqs:  npm i -g @openai/codex   (or: npm i -g --prefix ~/.local @openai/codex)
//           codex login              (sign in with your ChatGPT account, NOT an API key)
//
// What it proves: binary discovery, a non-streaming ask (JSONL event parse, usage fields),
// a streaming ask (delta -> done protocol), and that OPENAI_API_KEY in the parent env is NOT
// spent (it is stripped from the child). Afterwards, check platform.openai.com usage: these
// calls must NOT appear as metered API usage.

import { findCodexBinary, ask, askStream, listModels, getPricing } from '../../adapters/llmConnectors/codexLocal.mjs'

const log = (label, value) => console.log('\n=== ' + label + ' ===\n', typeof value === 'string' ? value : JSON.stringify(value, null, 2))

const main = async () => {
  const binaryPath = findCodexBinary(process.argv[2] || null)
  if (!binaryPath) {
    console.error('❌ No codex CLI found. Install it and run `codex login` first (see header comments), or pass the binary path as an argument.')
    process.exit(1)
  }
  log('binary', binaryPath)
  log('listModels', await listModels({}))
  log('getPricing (should be all zeros)', await getPricing({}))

  const local = { binaryPath }

  console.log('\n--- ask (non-streaming, model: gpt-5.6-luna) ---')
  const t0 = Date.now()
  const res = await ask({
    prompt: 'Reply with exactly: freezr codex connector ok',
    context: 'You answer with exactly what is asked, nothing else.',
    model: 'gpt-5.6-luna',
    local
  })
  log('ask result (' + (Date.now() - t0) + 'ms)', {
    response: res.response,
    model: res.model,
    family: res.family,
    tokensUsed: res.tokensUsed
  })

  console.log('\n--- askStream (model: gpt-5.6-luna) ---')
  let deltas = 0
  let done = null
  for await (const chunk of askStream({ prompt: 'Count from 1 to 5, one number per line.', model: 'gpt-5.6-luna', local })) {
    if (chunk.type === 'delta') { deltas++; process.stdout.write(chunk.text) }
    if (chunk.type === 'thinking') process.stdout.write('[thinking]')
    if (chunk.type === 'done') done = chunk
  }
  log('stream summary', { deltas, response: done?.response, tokensUsed: done?.tokensUsed })

  console.log('\n✅ Probe complete. Now check platform.openai.com usage — these calls must NOT appear as metered API usage.')
}

main().catch(e => {
  console.error('\n❌ Probe failed:', e.code || '', e.message)
  process.exit(1)
})
