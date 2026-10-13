// Unit tests for the ClaudeLocal connector (adapters/llmConnectors/claudeLocal.mjs).
//
// The connector shells out to the `claude` CLI, so these tests drive it against a FAKE
// `claude` — a shell script that records how it was invoked (args, env, cwd, stdin) and
// emits canned CLI output. That proves the load-bearing behavior without a subscription:
// argument construction, env stripping (the billing guarantee), sandbox cwd, JSON and
// stream-json parsing, the done-chunk protocol, and error mapping. The real-CLI path is
// exercised by test/manual/claude-local-cli-probe.mjs against a logged-in binary.

import { expect } from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as connector from '../../../adapters/llmConnectors/claudeLocal.mjs'

const RESULT_EVENT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Hello from fake claude',
  session_id: 'fake-session',
  total_cost_usd: 0.0123,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
  modelUsage: { 'claude-sonnet-5-20260101': { outputTokens: 5 } }
}

let fakeDir = null
let capturePath = null
let fakeBinary = null

// The fake reads stdin fully, dumps its invocation as JSON to the capture file, then prints
// the canned payload from the stdout file.
//
// Paths are BAKED IN at creation rather than passed through the environment: the connector
// now gives its child an allowlisted env (localCliEnv.mjs), so arbitrary variables — including
// a test harness's own — deliberately no longer reach it. The capture records the child's full
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
    hasApiKey: "ANTHROPIC_API_KEY" in process.env,
    hasAuthToken: "ANTHROPIC_AUTH_TOKEN" in process.env
  }))
' -- "$@"
cat ${JSON.stringify(stdoutPath)}
exit 0
`

const readCapture = () => JSON.parse(fs.readFileSync(capturePath, 'utf8'))

const setFakeOutput = (text) => {
  fs.writeFileSync(path.join(fakeDir, 'stdout.txt'), text)
}

describe('claudeLocal connector (against a fake claude CLI)', function () {
  before(function () {
    fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'))
    capturePath = path.join(fakeDir, 'capture.json')
    fakeBinary = path.join(fakeDir, 'claude') // findClaudeBinary requires the name `claude`
    fs.writeFileSync(fakeBinary, makeFakeScript(capturePath, path.join(fakeDir, 'stdout.txt')), { mode: 0o755 })
    // make sure the env checks are meaningful: these ARE set in the parent env
    process.env.ANTHROPIC_API_KEY = 'sk-test-should-be-stripped'
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok-should-be-stripped'
    process.env.FREEZR_ENV_KEY = 'master-key-should-not-reach-child'
  })

  after(function () {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    delete process.env.FREEZR_ENV_KEY
    delete process.env.STDIN_TEXT
    if (fakeDir) fs.rmSync(fakeDir, { recursive: true, force: true })
  })

  describe('contract statics', function () {
    it('lists the CLI model aliases, all latest, provider ClaudeLocal', async function () {
      const models = await connector.listModels({})
      expect(models.map(m => m.id)).to.deep.equal(['sonnet', 'opus', 'haiku'])
      for (const m of models) {
        expect(m.provider).to.equal('ClaudeLocal')
        expect(m.latest).to.equal(true)
      }
    })

    it('prices every model at zero (subscription — $0 is the real price)', async function () {
      const pricing = await connector.getPricing({})
      expect(pricing.source).to.equal('subscription_zero_cost')
      for (const alias of ['sonnet', 'opus', 'haiku']) {
        expect(pricing.models[alias]).to.deep.equal({ input: 0, output: 0, cachedInput: 0 })
      }
    })

    it('parses alias and full model ids into families', function () {
      expect(connector.parseModelId('sonnet').family).to.equal('sonnet')
      expect(connector.getFamilyFromModelId('claude-sonnet-5-20260101')).to.equal('sonnet-5')
    })

    it('declares no web/vision/files capability (the CLI transport does not carry them)', async function () {
      const caps = await connector.getCapabilities({})
      expect(caps.web).to.deep.equal({ search: false, fetch: false })
      expect(caps.vision).to.equal(false)
      expect(caps.documents).to.equal(false)
    })
  })

  describe('findClaudeBinary', function () {
    it('accepts an explicit executable named claude', function () {
      expect(connector.findClaudeBinary(fakeBinary)).to.equal(fakeBinary)
    })

    it('rejects an executable not named claude (no run-anything primitive)', function () {
      const impostor = path.join(fakeDir, 'not-claude')
      fs.writeFileSync(impostor, '#!/bin/bash\n', { mode: 0o755 })
      expect(connector.findClaudeBinary(impostor)).to.not.equal(impostor)
    })
  })

  describe('ask (non-streaming)', function () {
    it('returns the contract result shape off the CLI json output', async function () {
      setFakeOutput(JSON.stringify(RESULT_EVENT))
      const res = await connector.ask({
        prompt: 'say hello',
        context: 'be brief',
        model: 'sonnet',
        local: { binaryPath: fakeBinary }
      })
      expect(res.response).to.equal('Hello from fake claude')
      expect(res.provider).to.equal('ClaudeLocal')
      expect(res.model).to.equal('claude-sonnet-5-20260101') // from modelUsage, not the alias
      expect(res.family).to.equal('sonnet-5')
      expect(res.stopReason).to.equal('end_turn')
      expect(res.tokensUsed).to.deep.equal({
        input: { qtty: 10, cost: 0 },
        output: { qtty: 5, cost: 0 },
        other: { qtty: 5, cost: 0, details: { cacheReadTokens: 3, cacheCreationTokens: 2 } }
      })
      expect(res.rawUsage.notionalCostUsd).to.equal(0.0123)
      expect(res.rawUsage.subscription).to.equal(true)
    })

    it('gives the child an ALLOWLISTED env (no keys, no server secrets) and a scratch cwd', async function () {
      setFakeOutput(JSON.stringify(RESULT_EVENT))
      await connector.ask({ prompt: 'x', local: { binaryPath: fakeBinary } })
      const cap = readCapture()
      expect(cap.hasApiKey).to.equal(false)
      expect(cap.hasAuthToken).to.equal(false)
      // The billing guarantee is now a consequence of the allowlist rather than two deletes:
      // nothing outside it reaches the child, including secrets nobody thought to strip.
      expect(cap.envKeys, 'the master decryption key must never reach a subprocess').to.not.include('FREEZR_ENV_KEY')
      expect(cap.envKeys).to.not.include('ANTHROPIC_BASE_URL') // would redirect authenticated requests
      expect(cap.envKeys).to.not.include('NODE_OPTIONS') // would inject code into a node-based CLI
      expect(cap.envKeys, 'HOME must survive — the CLI finds its credentials there').to.include('HOME')
      expect(cap.cwd).to.not.equal(process.cwd())
      expect(cap.cwd).to.include('freezr-claude-local-')
      expect(fs.existsSync(cap.cwd)).to.equal(false) // sandbox dir cleaned up after the call
    })

    it('passes the hardening flags and system prompt, never --bare', async function () {
      setFakeOutput(JSON.stringify(RESULT_EVENT))
      await connector.ask({ prompt: 'x', context: 'sys here', model: 'opus', effort: 'low', local: { binaryPath: fakeBinary } })
      const { args } = readCapture()
      expect(args).to.include.members(['-p', '--strict-mcp-config', '--restricted', '--no-session-persistence'])
      expect(args).to.not.include('--bare')
      expect(args[args.indexOf('--output-format') + 1]).to.equal('json')
      expect(args[args.indexOf('--model') + 1]).to.equal('opus')
      expect(args[args.indexOf('--system-prompt') + 1]).to.equal('sys here')
      expect(args[args.indexOf('--effort') + 1]).to.equal('low')
      expect(args[args.indexOf('--tools') + 1]).to.equal('') // all tools disabled
    })

    it('flattens a messages-array prompt to a labeled transcript on stdin', async function () {
      setFakeOutput(JSON.stringify(RESULT_EVENT))
      await connector.ask({
        prompt: [
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: 'first answer' },
          { role: 'user', content: 'follow-up' }
        ],
        local: { binaryPath: fakeBinary }
      })
      // NOTE: stdin travels through the fake via $(cat) -> env, so spaces survive but the
      // capture proves content ordering, which is what matters here.
      const { stdin } = readCapture()
      expect(stdin).to.include('User: first question')
      expect(stdin).to.include('Assistant: first answer')
      expect(stdin.indexOf('first answer')).to.be.lessThan(stdin.indexOf('follow-up'))
    })

    it('keeps a normal-sized context in --system-prompt and adds nothing to stdin', async function () {
      setFakeOutput(JSON.stringify(RESULT_EVENT))
      await connector.ask({ prompt: 'the question', context: 'be brief', local: { binaryPath: fakeBinary } })
      const { args, stdin } = readCapture()
      expect(args[args.indexOf('--system-prompt') + 1]).to.equal('be brief')
      expect(stdin).to.not.include('Your instructions')
    })

    it('moves an OVERSIZE context out of argv and onto the head of stdin', async function () {
      // argv is the only part of the call with a hard size limit; stdin has none. Past the cap the
      // context must still REACH the model — never truncated, never a 400.
      setFakeOutput(JSON.stringify(RESULT_EVENT))
      const big = 'RULE-' + 'x'.repeat(40000)
      await connector.ask({ prompt: 'the question', context: big, local: { binaryPath: fakeBinary } })
      const { args, stdin } = readCapture()
      const sys = args[args.indexOf('--system-prompt') + 1]
      expect(sys).to.have.length.below(500)              // a pointer, not the payload
      expect(sys).to.include('Your instructions')
      expect(args.join(' ')).to.not.include('RULE-')     // the payload left argv entirely
      expect(stdin).to.include('RULE-')                  // …and arrived on stdin
      expect(stdin.indexOf('RULE-')).to.be.lessThan(stdin.indexOf('the question'))
    })

    it('the fold is exported and pure, so the boundary can be reasoned about', function () {
      const under = connector.foldOversizeContext('short')
      expect(under).to.deep.equal({ context: 'short', preface: '' })
      expect(connector.foldOversizeContext('')).to.deep.equal({ context: null, preface: '' })
      const over = connector.foldOversizeContext('y'.repeat(32001))
      expect(over.context).to.include('Your instructions')
      expect(over.preface).to.include('y'.repeat(100))
      expect(over.preface.startsWith('## Your instructions')).to.equal(true)
    })

    it('parses a JSON responseType response', async function () {
      setFakeOutput(JSON.stringify({ ...RESULT_EVENT, result: '{"a": 1}' }))
      const res = await connector.ask({ prompt: 'x', responseType: 'json', local: { binaryPath: fakeBinary } })
      expect(res.response).to.deep.equal({ a: 1 })
    })

    it('maps a usage-limit failure to code subscription_limit', async function () {
      setFakeOutput(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'You have hit your usage limit — resets at 3pm' }))
      try {
        await connector.ask({ prompt: 'x', local: { binaryPath: fakeBinary } })
        throw new Error('should have thrown')
      } catch (e) {
        expect(e.code).to.equal('subscription_limit')
        expect(e.status).to.equal(429)
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
    it('yields deltas, thinking and a terminal done chunk off stream-json', async function () {
      const lines = [
        JSON.stringify({ type: 'system', subtype: 'init' }),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } }),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } } }),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } }),
        JSON.stringify({ ...RESULT_EVENT, result: 'Hello world' })
      ]
      setFakeOutput(lines.join('\n') + '\n')

      const chunks = []
      for await (const chunk of connector.askStream({ prompt: 'x', local: { binaryPath: fakeBinary } })) {
        chunks.push(chunk)
      }
      expect(chunks.map(c => c.type)).to.deep.equal(['thinking', 'delta', 'delta', 'done'])
      const done = chunks[chunks.length - 1]
      expect(done.response).to.equal('Hello world')
      expect(done.provider).to.equal('ClaudeLocal')
      expect(done.tokensUsed.input.qtty).to.equal(10)
      const { args } = readCapture()
      expect(args[args.indexOf('--output-format') + 1]).to.equal('stream-json')
      expect(args).to.include.members(['--include-partial-messages', '--verbose'])
    })

    it('throws (not silent EOF) when the stream ends without a result event', async function () {
      setFakeOutput(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n')
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
