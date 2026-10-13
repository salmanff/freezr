// Local-CLI connectors — process hardening.
//
// Covers the three failure modes that turn a bad subprocess into a bad SERVER:
//   1. an unlistened EPIPE on the child's stdin is an uncaught exception → whole-process crash;
//   2. a throw between acquireSlot() and the try block strands the slot → with MAX_CONCURRENT 1
//      the connector is bricked for every later call until restart;
//   3. the child inheriting the server's environment → FREEZR_ENV_KEY (which decrypts every
//      stored credential), DB_PASS, FS_MS_CONNECTION_STRING reachable from a subprocess — and
//      for codex, reachable by a prompt injection, since it runs model-generated shell commands.
import { expect } from 'chai'
import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildLocalCliEnv, LOCAL_CLI_ENV_ALLOWLIST } from '../../../adapters/llmConnectors/localCliEnv.mjs'
import { ask } from '../../../adapters/llmConnectors/claudeLocal.mjs'

describe('local CLI — child environment allowlist', function () {
  const SECRETS = {
    FREEZR_ENV_KEY: 'sentinel-master-key',
    COOKIE_SECRET: 'sentinel-cookie',
    DB_PASS: 'sentinel-db',
    DB_USER: 'sentinel-dbuser',
    FS_MS_CONNECTION_STRING: 'sentinel-azure',
    FS_SECRET_ACCESS_KEY: 'sentinel-aws',
    ANTHROPIC_API_KEY: 'sk-ant-sentinel',
    ANTHROPIC_BASE_URL: 'https://attacker.example',
    OPENAI_API_KEY: 'sk-sentinel',
    NODE_OPTIONS: '--require /tmp/evil.js'
  }
  const saved = {}

  before(function () {
    for (const [k, v] of Object.entries(SECRETS)) { saved[k] = process.env[k]; process.env[k] = v }
  })
  after(function () {
    for (const k of Object.keys(SECRETS)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('passes NONE of the server secrets to the child', function () {
    const env = buildLocalCliEnv(['CODEX_HOME', 'CLAUDE_CONFIG_DIR'])
    for (const key of Object.keys(SECRETS)) {
      expect(env, key + ' must not reach the child').to.not.have.property(key)
    }
  })

  it('blocks the two that a provider-key blocklist would miss', function () {
    const env = buildLocalCliEnv()
    // would redirect the owner's OAuth-authenticated requests to another host
    expect(env).to.not.have.property('ANTHROPIC_BASE_URL')
    // codex is a `#!/usr/bin/env node` script — this injects code into it
    expect(env).to.not.have.property('NODE_OPTIONS')
  })

  it('is an allowlist, so a NEW server secret is private by default', function () {
    process.env.SOME_FUTURE_FREEZR_SECRET = 'sentinel-future'
    try {
      expect(buildLocalCliEnv()).to.not.have.property('SOME_FUTURE_FREEZR_SECRET')
    } finally { delete process.env.SOME_FUTURE_FREEZR_SECRET }
  })

  it('still passes what the CLIs genuinely need', function () {
    const env = buildLocalCliEnv(['CODEX_HOME'])
    expect(env.HOME, 'HOME carries ~/.claude and ~/.codex auth').to.equal(process.env.HOME)
    // PATH is passed THROUGH, not hardcoded: codex is a node script and needs `node` on PATH,
    // which a minimal /usr/bin:/bin would not provide on a typical machine.
    expect(env.PATH).to.equal(process.env.PATH)
    expect(LOCAL_CLI_ENV_ALLOWLIST).to.include('HOME').and.to.include('PATH')
  })

  it('omits allowlisted keys that are not set rather than inventing empties', function () {
    delete process.env.LC_ALL
    expect(buildLocalCliEnv()).to.not.have.property('LC_ALL')
  })
})

describe('local CLI — binary path must be absolute', function () {
  it('refuses a relative path (it would resolve against the freezr tree)', async function () {
    const { findClaudeBinary } = await import('../../../adapters/llmConnectors/claudeLocal.mjs')
    // A relative candidate is skipped; with no absolute fallback present this yields null
    // rather than silently executing something resolved from the server's cwd.
    expect(findClaudeBinary('some/relative/claude')).to.not.equal('some/relative/claude')
  })

  it('deliberately does NOT reject on ownership/permissions', async function () {
    // Homebrew, npm-global and service-user installs all vary in ownership, so an ownership
    // check would refuse legitimate binaries. This asserts the decision, so a future change
    // that adds such a check has to come here and reconsider it on purpose.
    const src = nodeFs.readFileSync('adapters/llmConnectors/claudeLocal.mjs', 'utf8')
    const fn = src.slice(src.indexOf('export const findClaudeBinary'), src.indexOf('const resolveModelArg'))
    expect(fn).to.not.match(/\buid\b|world-writable check|statSync\(/)
  })
})

describe('local CLI — a broken child must not break the server', function () {
  this.timeout(20000)
  let dir, binaryPath

  before(function () {
    dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'frzr-cli-hard-'))
    binaryPath = path.join(dir, 'claude')
    // Exits immediately WITHOUT reading stdin: writing the prompt then raises EPIPE.
    nodeFs.writeFileSync(binaryPath, '#!/usr/bin/env node\nprocess.exit(1)\n')
    nodeFs.chmodSync(binaryPath, 0o755)
  })
  after(function () {
    try { nodeFs.rmSync(dir, { recursive: true, force: true }) } catch (e) { /* best effort */ }
  })

  // A big prompt guarantees the write spans ticks, so the child's exit lands mid-write and the
  // EPIPE is real rather than a race that usually doesn't fire.
  const bigPrompt = 'x'.repeat(2 * 1024 * 1024)

  it('surfaces an EPIPE as a normal rejection, never an uncaught exception', async function () {
    const uncaught = []
    const onUncaught = (e) => uncaught.push(e)
    process.on('uncaughtException', onUncaught)
    process.on('unhandledRejection', onUncaught)
    try {
      await ask({ prompt: bigPrompt, local: { binaryPath } }).then(
        () => { throw new Error('should have failed') },
        () => { /* expected: the CLI exited 1 */ }
      )
      await new Promise(resolve => setTimeout(resolve, 300)) // let a stray async error land
      expect(uncaught.map(e => e.message || String(e)), 'an EPIPE here would kill the server').to.deep.equal([])
    } finally {
      process.removeListener('uncaughtException', onUncaught)
      process.removeListener('unhandledRejection', onUncaught)
    }
  })

  it('a flood is stopped LOUDLY, never truncated into a corrupt response', async function () {
    // The failure mode this guards: a naive cap clips the buffer mid-JSON, JSON.parse fails,
    // and a long-but-VALID answer surfaces as a confusing "no result". The cap must instead
    // kill the child and raise a specific, diagnosable error.
    const floodDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'frzr-flood-'))
    const flood = path.join(floodDir, 'claude')
    // Emits far past the 64MB cap, and never a valid result event.
    nodeFs.writeFileSync(flood, '#!/usr/bin/env node\n' +
      'const chunk = "x".repeat(1024 * 1024)\n' +
      'for (let i = 0; i < 80; i++) process.stdout.write(chunk)\n' +
      'setTimeout(() => {}, 5000)\n')
    nodeFs.chmodSync(flood, 0o755)
    try {
      const err = await ask({ prompt: 'hi', local: { binaryPath: flood } }).then(() => null, e => e)
      expect(err, 'should fail').to.be.an('error')
      expect(err.code, 'must name the real problem, not a parse failure').to.equal('local_cli_output_too_large')
      expect(err.message).to.match(/malfunctioning CLI/)
    } finally {
      try { nodeFs.rmSync(floodDir, { recursive: true, force: true }) } catch (e) { /* best effort */ }
    }
  })

  it('releases the slot on every failure — repeated failures must not brick the connector', async function () {
    // MAX_CONCURRENT is 1: if any failing call stranded the slot, the NEXT call would reject
    // with the 429 "busy" message instead of reaching the CLI at all.
    for (let i = 0; i < 3; i++) {
      const err = await ask({ prompt: 'hi', local: { binaryPath } }).then(() => null, e => e)
      expect(err, 'call ' + i + ' should fail (the fake CLI exits 1)').to.be.an('error')
      expect(err.message, 'slot was stranded by an earlier failure').to.not.match(/busy with another request/)
    }
  })
})
