// Local-CLI connectors — client-disconnect abort.
//
// Drives the REAL connector against a fake `claude` binary that emits one chunk then goes
// silent, and asserts that aborting the signal kills the child and frees the slot promptly
// instead of waiting out the 5-minute ceiling. This is the case the connectors' single slot
// (MAX_CONCURRENT 1 / MAX_QUEUED 1) makes expensive: a held slot 429s every later call.
//
// Why a signal and not just gen.return(): an async generator's return() is QUEUED and only
// lands when the generator next suspends AT A YIELD — it cannot interrupt an internal await.
// A CLI that has gone quiet mid-answer never reaches a yield, so return() alone can never stop
// it; the child has to be killed out-of-band, which is what the signal does.
import { expect } from 'chai'
import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { askStream } from '../../../adapters/llmConnectors/claudeLocal.mjs'

// A stand-in `claude` that streams one text delta, then sleeps far past any test timeout.
const FAKE_CLI = `#!/usr/bin/env node
process.stdin.resume()
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
emit({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'hello' } } })
setTimeout(() => { emit({ type: 'result', subtype: 'success', result: 'hello world', usage: {} }) }, 15000)
`

describe('claudeLocal — abort on client disconnect', function () {
  this.timeout(20000)
  let dir, binaryPath

  before(function () {
    dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'frzr-cli-abort-'))
    binaryPath = path.join(dir, 'claude') // findClaudeBinary only accepts a file named `claude`
    nodeFs.writeFileSync(binaryPath, FAKE_CLI)
    nodeFs.chmodSync(binaryPath, 0o755)
  })

  after(function () {
    try { nodeFs.rmSync(dir, { recursive: true, force: true }) } catch (e) { /* best effort */ }
  })

  const drain = async (gen) => {
    const chunks = []
    for await (const chunk of gen) chunks.push(chunk)
    return chunks
  }

  it('aborting the signal ends the stream promptly and frees the slot for the next call', async function () {
    const ac = new AbortController()
    const started = Date.now()
    const gen = askStream({ prompt: 'hi', local: { binaryPath }, signal: ac.signal })

    // read the first delta so we know the CLI is up and the slot is held
    const first = await gen.next()
    expect(first.value?.type, JSON.stringify(first.value)).to.equal('delta')

    setTimeout(() => ac.abort(), 200)
    try { await drain(gen) } catch (e) { /* the killed CLI surfaces as a connector error */ }
    const elapsed = Date.now() - started
    expect(elapsed, 'must not wait out the 5-minute ceiling').to.be.lessThan(10000)

    // The real proof: the single slot is free, so a second call can start immediately
    // (a held slot rejects with 429 "busy" via acquireSlot).
    const ac2 = new AbortController()
    const gen2 = askStream({ prompt: 'again', local: { binaryPath }, signal: ac2.signal })
    const firstOfSecond = await gen2.next()
    expect(firstOfSecond.value?.type, 'slot was not released — second call was refused').to.equal('delta')
    ac2.abort()
    try { await drain(gen2) } catch (e) { /* expected */ }
  })

  it('an already-aborted signal kills the child immediately', async function () {
    const ac = new AbortController()
    ac.abort()
    const started = Date.now()
    const gen = askStream({ prompt: 'hi', local: { binaryPath }, signal: ac.signal })
    try { await drain(gen) } catch (e) { /* expected */ }
    expect(Date.now() - started).to.be.lessThan(10000)
  })

  // Regression guard for the bug this work uncovered: a SIGKILLed child reports code === null,
  // and the read loop used `exited` as its "has it finished?" sentinel. Recording null there made
  // a dead process look like a running one, so the loop parked on until the 5-minute deadline —
  // defeating BOTH the abort above and the connector's own timeout kill.
  it('treats a signal-killed child as exited (code === null must not read as "still running")', async function () {
    const ac = new AbortController()
    const gen = askStream({ prompt: 'hi', local: { binaryPath }, signal: ac.signal })
    await gen.next()
    ac.abort()
    // NB: no Promise.race here — the loser of a race keeps running, and an undrained
    // generator keeps its child process alive, which holds the whole mocha run open.
    const started = Date.now()
    try { await drain(gen) } catch (e) { /* killed CLI surfaces as an error */ }
    expect(Date.now() - started, 'a killed child must end the stream at once').to.be.lessThan(5000)
  })
})

describe('codexLocal — abort on client disconnect', function () {
  this.timeout(20000)
  let dir, binaryPath

  before(function () {
    dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'frzr-codex-abort-'))
    binaryPath = path.join(dir, 'codex') // findCodexBinary only accepts a file named `codex`
    nodeFs.writeFileSync(binaryPath, '#!/usr/bin/env node\nprocess.stdin.resume()\nsetTimeout(() => {}, 15000)\n')
    nodeFs.chmodSync(binaryPath, 0o755)
  })

  after(function () {
    try { nodeFs.rmSync(dir, { recursive: true, force: true }) } catch (e) { /* best effort */ }
  })

  it('an aborted signal ends the call instead of holding the slot to the ceiling', async function () {
    const { askStream: codexAskStream } = await import('../../../adapters/llmConnectors/codexLocal.mjs')
    const ac = new AbortController()
    const started = Date.now()
    const gen = codexAskStream({ prompt: 'hi', local: { binaryPath }, signal: ac.signal })
    setTimeout(() => ac.abort(), 200)
    try { for await (const chunk of gen) void chunk } catch (e) { /* killed CLI surfaces as an error */ }
    expect(Date.now() - started, 'must not wait out the ceiling').to.be.lessThan(10000)

    // Slot released: a second call can acquire it (otherwise acquireSlot rejects with 429).
    const ac2 = new AbortController()
    ac2.abort()
    const gen2 = codexAskStream({ prompt: 'again', local: { binaryPath }, signal: ac2.signal })
    try { for await (const chunk of gen2) void chunk } catch (e) {
      expect(e.message, 'slot was not released').to.not.match(/busy with another request/)
    }
  })
})
