// Unit tests for the CodexLocal connector (adapters/llmConnectors/codexLocal.mjs).
//
// Same approach as claudeLocal.test.mjs: the connector shells out to the `codex` CLI, so
// these drive it against a FAKE `codex` — a shell script that records its invocation (args,
// env, cwd, stdin) and emits canned JSONL events. That proves argument construction, env
// stripping (the billing guarantee), sandbox cwd, event parsing (item.* / turn.completed),
// the delta/done stream protocol, and error mapping — without a ChatGPT subscription. The
// real-CLI path is exercised by test/manual/codex-local-cli-probe.mjs.

import { expect } from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as connector from '../../../adapters/llmConnectors/codexLocal.mjs'

const EVENTS_OK = [
  { type: 'thread.started', thread_id: 't1' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'thinking about it' } },
  { type: 'item.updated', item: { id: 'i1', type: 'agent_message', text: 'Hello ' } },
  { type: 'item.updated', item: { id: 'i1', type: 'agent_message', text: 'Hello world' } },
  { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'Hello world' } },
  { type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 8, output_tokens: 6 } }
]

let fakeDir = null
let capturePath = null
let fakeBinary = null

// Paths are BAKED IN at creation rather than passed through the environment: the connector
// now gives its child an allowlisted env (localCliEnv.mjs), so arbitrary variables — a test
// harness's included — deliberately no longer reach it. The capture records the child's full
// env key list so the allowlist itself can be asserted.
const makeFakeScript = (capturePath, stdoutPath) => `#!/bin/bash
STDIN_TEXT=$(cat)
export STDIN_TEXT
node -e '
  const fs = require("fs")
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
    args: process.argv.slice(1),
    cwd: process.cwd(),
    stdin: process.env.STDIN_TEXT,
    envKeys: Object.keys(process.env),
    hasOpenaiKey: "OPENAI_API_KEY" in process.env,
    hasCodexKey: "CODEX_API_KEY" in process.env,
    // the schema file is read HERE, while the scratch dir still exists — it is gone after the call
    outputSchema: (() => { const i = process.argv.indexOf("--output-schema"); return i >= 0 ? fs.readFileSync(process.argv[i + 1], "utf8") : null })()
  }))
' -- "$@"
cat ${JSON.stringify(stdoutPath)}
exit 0
`

const readCapture = () => JSON.parse(fs.readFileSync(capturePath, 'utf8'))

const setFakeEvents = (events) => {
  fs.writeFileSync(path.join(fakeDir, 'stdout.txt'), events.map(e => JSON.stringify(e)).join('\n') + '\n')
}

describe('codexLocal connector (against a fake codex CLI)', function () {
  before(function () {
    fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-'))
    capturePath = path.join(fakeDir, 'capture.json')
    fakeBinary = path.join(fakeDir, 'codex') // findCodexBinary requires the name `codex`
    fs.writeFileSync(fakeBinary, makeFakeScript(capturePath, path.join(fakeDir, 'stdout.txt')), { mode: 0o755 })
    // make the env checks meaningful: these ARE set in the parent env
    process.env.OPENAI_API_KEY = 'sk-test-should-be-stripped'
    process.env.CODEX_API_KEY = 'ck-test-should-be-stripped'
    process.env.FREEZR_ENV_KEY = 'master-key-should-not-reach-child'
    process.env.NODE_OPTIONS_TESTONLY = 'x'
  })

  after(function () {
    delete process.env.OPENAI_API_KEY
    delete process.env.CODEX_API_KEY
    delete process.env.FREEZR_ENV_KEY
    delete process.env.NODE_OPTIONS_TESTONLY
    if (fakeDir) fs.rmSync(fakeDir, { recursive: true, force: true })
  })

  describe('contract statics', function () {
    it('lists known model ids, all latest, provider CodexLocal', async function () {
      const models = await connector.listModels({})
      // The live catalogue for ChatGPT-subscription auth (`codex debug models`). A bare 'gpt-5.6'
      // is NOT in it and is rejected by the API for these accounts — it must never come back.
      expect(models.map(m => m.id)).to.deep.equal(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'])
      expect(models.map(m => m.id), 'a bare gpt-5.6 is rejected for ChatGPT accounts').to.not.include('gpt-5.6')
      for (const m of models) {
        expect(m.provider).to.equal('CodexLocal')
        expect(m.latest).to.equal(true)
      }
    })

    it('prices every model at zero (subscription — $0 is the real price)', async function () {
      const pricing = await connector.getPricing({})
      expect(pricing.source).to.equal('subscription_zero_cost')
      for (const m of Object.values(pricing.models)) {
        expect(m).to.deep.equal({ input: 0, output: 0, cachedInput: 0 })
      }
    })

    it('declares no web/vision/files capability (the CLI transport does not carry them)', async function () {
      const caps = await connector.getCapabilities({})
      expect(caps.web).to.deep.equal({ search: false, fetch: false })
      expect(caps.vision).to.equal(false)
      expect(caps.documents).to.equal(false)
    })

    it('declares structuredOutput — the CLI enforces a schema natively via --output-schema', async function () {
      const caps = await connector.getCapabilities({})
      expect(caps.structuredOutput).to.equal(true)
    })
  })

  describe('findCodexBinary', function () {
    it('accepts an explicit executable named codex', function () {
      expect(connector.findCodexBinary(fakeBinary)).to.equal(fakeBinary)
    })

    it('rejects an executable not named codex (no run-anything primitive)', function () {
      const impostor = path.join(fakeDir, 'not-codex')
      fs.writeFileSync(impostor, '#!/bin/bash\n', { mode: 0o755 })
      expect(connector.findCodexBinary(impostor)).to.not.equal(impostor)
    })
  })

  describe('ask (non-streaming)', function () {
    it('returns the contract result shape off the JSONL events', async function () {
      setFakeEvents(EVENTS_OK)
      const res = await connector.ask({
        prompt: 'say hello',
        context: 'be brief',
        model: 'gpt-5.6-luna',
        local: { binaryPath: fakeBinary }
      })
      expect(res.response).to.equal('Hello world')
      expect(res.thinking).to.equal('thinking about it')
      expect(res.provider).to.equal('CodexLocal')
      expect(res.model).to.equal('gpt-5.6-luna')
      expect(res.stopReason).to.equal('end_turn')
      // OpenAI convention: cached tokens are INCLUDED in input and re-priced via details
      expect(res.tokensUsed).to.deep.equal({
        input: { qtty: 20, cost: 0 },
        output: { qtty: 6, cost: 0 },
        other: { qtty: 0, cost: 0, details: { cachedPromptTokens: 8 } }
      })
      expect(res.rawUsage.subscription).to.equal(true)
    })

    it('strips OPENAI_API_KEY / CODEX_API_KEY from the child env and runs in a scratch cwd', async function () {
      setFakeEvents(EVENTS_OK)
      await connector.ask({ prompt: 'x', local: { binaryPath: fakeBinary } })
      const cap = readCapture()
      expect(cap.hasOpenaiKey).to.equal(false)
      expect(cap.hasCodexKey).to.equal(false)
      expect(cap.cwd).to.include('freezr-codex-local-')
      expect(fs.existsSync(cap.cwd)).to.equal(false) // sandbox dir cleaned up after the call
    })

    it('passes exec --json with containment flags and the sandbox as working root', async function () {
      setFakeEvents(EVENTS_OK)
      await connector.ask({ prompt: 'x', model: 'gpt-5.6-sol', local: { binaryPath: fakeBinary } })
      const { args, cwd } = readCapture()
      expect(args[0]).to.equal('exec')
      expect(args).to.include.members(['--json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules'])
      expect(args[args.indexOf('-m') + 1]).to.equal('gpt-5.6-sol')
      expect(args[args.indexOf('-s') + 1]).to.equal('read-only')
      // fs.realpath vs the raw tmpdir path can differ by a /private prefix on macOS
      expect(cwd).to.include(args[args.indexOf('-C') + 1].replace(/^\/private/, '').replace(/^\//, ''))
    })

    it('passes a structuredOutput schema to the CLI as --output-schema, written inside the scratch dir', async function () {
      setFakeEvents(EVENTS_OK)
      const schema = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false }
      await connector.ask({ prompt: 'x', local: { binaryPath: fakeBinary }, structuredOutput: { name: 's', schema } })
      const { args, cwd, outputSchema } = readCapture()
      const i = args.indexOf('--output-schema')
      expect(i, 'the flag is passed').to.be.above(0)
      // the file sits in the sandbox (the CLI's -C root), so the read-only sandbox can read it
      expect(args[i + 1].replace(/^\/private/, '')).to.include(cwd.replace(/^\/private/, ''))
      expect(JSON.parse(outputSchema), 'the CLI saw exactly the caller\'s schema').to.deep.equal(schema)
      expect(fs.existsSync(args[i + 1]), 'and it died with the scratch dir').to.equal(false)
    })

    it('a request WITHOUT structuredOutput carries no --output-schema (the additive rule)', async function () {
      setFakeEvents(EVENTS_OK)
      await connector.ask({ prompt: 'x', local: { binaryPath: fakeBinary } })
      const { args, outputSchema } = readCapture()
      expect(args).to.not.include('--output-schema')
      expect(outputSchema).to.equal(null)
    })

    // Containment regression guard. These flags ARE the security posture for a connector that
    // is fed untrusted third-party text; losing one silently is the failure mode that matters.
    it('passes the containment flags — shell execution OFF, read-only kept underneath', function () {
      const { args } = readCapture()
      const disabled = args.reduce((acc, a, i) => (a === '--disable' ? acc.concat(args[i + 1]) : acc), [])
      // THE primary control: no command execution at all (features.shell_tool=false).
      expect(disabled, 'shell execution must be disabled').to.include('shell_tool')
      expect(disabled, 'the other execution surface').to.include('unified_exec')
      for (const feature of ['apps', 'plugins', 'remote_plugin', 'hooks', 'multi_agent', 'browser_use', 'computer_use', 'image_generation']) {
        expect(disabled, 'feature surface ' + feature).to.include(feature)
      }
      // -s read-only stays as the backstop: shell_tool=false is NOT a proven complete
      // boundary, so the coarse sandbox must remain underneath it.
      expect(args[args.indexOf('-s') + 1]).to.equal('read-only')
      expect(args, 'a wrong -c key must error loudly, not be ignored').to.include('--strict-config')
      const cfgs = args.reduce((acc, a, i) => (a === '-c' ? acc.concat(args[i + 1]) : acc), [])
      expect(cfgs).to.include('shell_environment_policy.inherit=none')
      expect(cfgs, 'we advertise CAPABILITIES.web=false — tell the CLI too').to.include('web_search="disabled"')
      expect(cfgs, 'nothing can answer an approval prompt in a server context').to.include('approval_policy="never"')
    })

    it('rides context at the top of the prompt on stdin (no system-prompt flag in exec)', async function () {
      setFakeEvents(EVENTS_OK)
      await connector.ask({ prompt: 'the question', context: 'sys context here', local: { binaryPath: fakeBinary } })
      const { stdin } = readCapture()
      expect(stdin).to.include('<instructions>')
      expect(stdin).to.include('sys context here')
      expect(stdin.indexOf('sys context here')).to.be.lessThan(stdin.indexOf('the question'))
    })

    it('maps a usage-limit failure to code subscription_limit', async function () {
      setFakeEvents([{ type: 'error', message: 'You have hit your usage limit' }])
      try {
        await connector.ask({ prompt: 'x', local: { binaryPath: fakeBinary } })
        throw new Error('should have thrown')
      } catch (e) {
        expect(e.code).to.equal('subscription_limit')
        expect(e.status).to.equal(429)
      }
    })

    it('maps a logged-out failure to local_cli_not_authenticated', async function () {
      setFakeEvents([{ type: 'error', message: 'Not logged in — run codex login' }])
      try {
        await connector.ask({ prompt: 'x', local: { binaryPath: fakeBinary } })
        throw new Error('should have thrown')
      } catch (e) {
        expect(e.code).to.equal('local_cli_not_authenticated')
      }
    })

    it('refuses file attachments loudly rather than dropping them', async function () {
      try {
        await connector.ask({ prompt: 'x', files: [{ originalname: 'a.pdf', buffer: Buffer.from('x') }], local: { binaryPath: fakeBinary } })
        throw new Error('should have thrown')
      } catch (e) {
        expect(e.code).to.equal('capability_unsupported')
      }
    })
  })

  describe('askStream', function () {
    it('yields suffix deltas off item.updated, thinking, and a terminal done chunk', async function () {
      setFakeEvents(EVENTS_OK)
      const chunks = []
      for await (const chunk of connector.askStream({ prompt: 'x', local: { binaryPath: fakeBinary } })) {
        chunks.push(chunk)
      }
      expect(chunks.map(c => c.type)).to.deep.equal(['thinking', 'delta', 'delta', 'done'])
      expect(chunks[1].text).to.equal('Hello ')
      expect(chunks[2].text).to.equal('world') // suffix of the running text, not a repeat
      const done = chunks[chunks.length - 1]
      expect(done.response).to.equal('Hello world')
      expect(done.provider).to.equal('CodexLocal')
      expect(done.tokensUsed.input.qtty).to.equal(20)
    })

    it('throws (not silent EOF) when the stream ends without a completed turn', async function () {
      setFakeEvents([{ type: 'thread.started', thread_id: 't1' }])
      try {
        // eslint-disable-next-line no-unused-vars
        for await (const chunk of connector.askStream({ prompt: 'x', local: { binaryPath: fakeBinary } })) { /* drain */ }
        throw new Error('should have thrown')
      } catch (e) {
        expect(e.code).to.equal('local_cli_error')
      }
    })
  })
})
