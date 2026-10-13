// claudeLocal — the streaming timeout is SILENCE, not total time.
//
// A wall-clock budget kills a model that is actively answering, and throws away the tokens it
// already spent producing the answer: the symptom that prompted this — "timed out after 300s"
// on prompts that were still streaming. While stream-json events keep arriving the CLI is
// demonstrably alive, so output pushes the deadline out (up to the hard ceiling).
//
// The invariant that must NOT be lost: a call the caller budgeted explicitly keeps a flat
// deadline. That number is usually a JOB DEADLINE, and a CLI outliving its job holds this
// connector's single slot while every later /feps/llm/ask is refused 429 "busy".
//
// These are timing tests against a fake CLI that trickles, so they run in seconds rather than
// milliseconds. The connector reads its budgets from the environment at module load, hence the
// env-then-dynamic-import dance below.
import { expect } from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RESULT_LINE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'trickled',
  usage: { input_tokens: 1, output_tokens: 1 }
})

// Emits `count` delta lines 400ms apart, then the result event. Unbuffered: each line must
// actually reach the parent as it is written, or there is no liveness signal to test.
const makeTricklingScript = (count, emitResult) => `#!/bin/bash
for i in $(seq 1 ${count}); do
  echo '${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '.' } } })}'
  sleep 0.4
done
${emitResult ? "echo '" + RESULT_LINE + "'" : ''}
exit 0
`

describe('claudeLocal askStream — live output extends the deadline', function () {
  this.timeout(40000)

  let dir = null
  let connector = null

  before(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-trickle-'))
    // Set INSIDE before(), immediately around the import: at module scope these would still be
    // set when a sibling test file first imports the unsuffixed connector, shrinking its budgets
    // too. The ?keepalive query gives this file its own module instance, which reads them here.
    process.env.FREEZR_LOCAL_CLI_TIMEOUT_MS = '1000' // default budget: 1s of silence
    process.env.FREEZR_LOCAL_CLI_STALL_MS = '1000' // each burst of output buys 1s more
    connector = await import('../../../adapters/llmConnectors/claudeLocal.mjs?keepalive')
    delete process.env.FREEZR_LOCAL_CLI_TIMEOUT_MS
    delete process.env.FREEZR_LOCAL_CLI_STALL_MS
  })

  after(function () {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) { /* best effort */ }
  })

  const fakeCli = (name, count, emitResult = true) => {
    const p = path.join(dir, name, 'claude') // findClaudeBinary requires the name `claude`
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, makeTricklingScript(count, emitResult), { mode: 0o755 })
    return p
  }

  it('survives well past the flat budget while it is still producing output', async function () {
    // 6 deltas x 400ms = ~2.4s of work against a 1s budget: the old flat deadline killed this.
    const binaryPath = fakeCli('alive', 6)
    const startedAt = Date.now()
    const chunks = []
    for await (const chunk of connector.askStream({ prompt: 'x', local: { binaryPath } })) chunks.push(chunk)
    const elapsed = Date.now() - startedAt
    expect(elapsed, 'ran past the 1s flat budget').to.be.greaterThan(1500)
    expect(chunks.filter(c => c.type === 'delta')).to.have.length(6)
    expect(chunks[chunks.length - 1].type).to.equal('done')
    expect(chunks[chunks.length - 1].response).to.equal('trickled')
  })

  it('still kills a CLI that goes SILENT for longer than the stall budget', async function () {
    // One delta, then 20s of nothing: liveness must expire, not renew forever.
    const binaryPath = path.join(dir, 'silent', 'claude')
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true })
    fs.writeFileSync(binaryPath, `#!/bin/bash
echo '${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '.' } } })}'
sleep 20
exit 0
`, { mode: 0o755 })

    const startedAt = Date.now()
    let caught = null
    try {
      for await (const chunk of connector.askStream({ prompt: 'x', local: { binaryPath } })) { void chunk }
    } catch (e) { caught = e }
    const elapsed = Date.now() - startedAt
    expect(caught, 'should have timed out').to.not.equal(null)
    expect(caught.code).to.equal('local_cli_timeout')
    expect(caught.message).to.match(/no output for/)
    expect(elapsed, 'died on silence, not on the 20s sleep').to.be.lessThan(8000)
  })

  it('does NOT extend a deadline the caller set explicitly (job budgets must bind)', async function () {
    // 40 deltas x 400ms = ~16s of continuous output against an explicit 5s budget. Extending
    // this is the orphaned-CLI bug: the job gave up at 5s, the CLI would hold the slot to 16s.
    const binaryPath = fakeCli('explicit', 40)
    const startedAt = Date.now()
    let caught = null
    try {
      for await (const chunk of connector.askStream({ prompt: 'x', local: { binaryPath }, timeoutMs: 5000 })) { void chunk }
    } catch (e) { caught = e }
    const elapsed = Date.now() - startedAt
    expect(caught, 'should have timed out at the budget it was given').to.not.equal(null)
    expect(caught.code).to.equal('local_cli_timeout')
    expect(elapsed, 'stopped at ~5s, not at the CLI\'s own ~16s').to.be.lessThan(9000)
  })
})
