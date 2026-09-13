// freezr.info - OpenAI Codex local-CLI LLM Connector
// Runs prompts through the locally installed, logged-in `codex` CLI (headless `codex exec`),
// so the SERVER OWNER's ChatGPT subscription answers instead of a metered API key.
//
// POLICY BOUNDARY: OpenAI documents ChatGPT-account sign-in for Codex (all plans) and its
// non-interactive mode, and recommends — without prohibiting — API keys for automation.
// Unlike Anthropic there is no published ban on third-party wrapping, but this connector
// keeps the same conservative structure as claudeLocal.mjs anyway:
//   - never reads, stores, or transmits any credential (auth.json stays the CLI's business);
//   - the child gets an ALLOWLISTED environment (localCliEnv.mjs): no OPENAI_API_KEY /
//     CODEX_API_KEY to bill silently, no OPENAI_BASE_URL to redirect the owner's
//     authenticated requests, and no NODE_OPTIONS — which matters because this CLI is a
//     `#!/usr/bin/env node` script, so that variable would inject code into it;
//   - availability is gated upstream exactly like ClaudeLocal (admin master pref
//     `local_llm_cli_enabled` + requesting user isAdmin + owner attestation) — llmContext.mjs.
//
// Codex is an agent, not a bare model. Its `tools` config table covers only
// { web_search, experimental_request_user_input, update_plan } — but the shell is gated
// SEPARATELY, by the FEATURES system: `--disable shell_tool` (equivalently
// features.shell_tool=false) turns command execution off, verified on 0.153.4 by a run that
// produced no command_execution events at all. That flag is this connector's primary
// containment control, and it is why untrusted content in a prompt is survivable here.
//
// It is NOT proven to be a complete boundary. Nobody has established a single switch that
// makes Codex an exclusively text-only client with every other action surface removed, so the
// defences are layered: shell_tool off, the other feature surfaces disabled, -s read-only kept
// underneath, an empty scratch cwd, config isolation (--ignore-user-config --ignore-rules
// --ephemeral), an allowlisted environment, and shell_environment_policy=none so any command
// that did run would inherit nothing. Treat prompts carrying third-party text accordingly, and
// re-test containment after every CLI upgrade — see local_cli_llm_connectors.md. Same deliberate gaps as claudeLocal: no files, no web, no
// max_tokens/cache; `thinking` text is passed through when the CLI emits reasoning items.
// Pricing is an all-zeros table — subscription calls have no per-call price. (Codex events
// carry no notional dollar figure, so unlike ClaudeLocal there is no notionalCostUsd.)

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildLocalCliEnv, killProcessTree } from './localCliEnv.mjs'

export const DEFAULT_FAMILY = 'gpt-5.6-sol' // verified live on 0.153.4

export const PROVIDER_NAME = 'CodexLocal'

/** Distinct from the API connector's vendor so usage tallies keep subscription rows apart. */
export const getVendorForModel = (_modelId) => 'openai-subscription'

// The ids this CLI generation resolves (checked against the shipped binary; there is no
// models API to enumerate against, and no key to do it with). Any gpt-* id passes through.
// The live catalogue for ChatGPT-subscription auth, from `codex debug models` (2026-09-12).
// The previous list included a bare 'gpt-5.6', which the API REJECTS for a ChatGPT account
// ("not supported when using Codex with a ChatGPT account") — and it was also the default, so
// the connector's default call failed for exactly the users it exists to serve. Catalogue
// presence is not entitlement: re-check with `codex debug models` after a CLI upgrade.
const KNOWN_MODELS = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']
// Pass this as the model to omit -m entirely and let the account pick. The no--m path is the
// one that keeps working when a pinned slug is retired, so it is the safe fallback.
export const AUTO_MODEL = 'auto'

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const MIN_TIMEOUT_MS = 5 * 1000

// See claudeLocal: a timeout bounds duration, not peak memory. Cap generously and fail loud
// rather than truncating a JSONL line mid-object.
const MAX_CLI_OUTPUT_BYTES = 64 * 1024 * 1024

/**
 * Resolve a caller-requested wait against this connector's ceiling. Same contract as
 * claudeLocal.resolveTimeoutMs: a caller may ask for LESS (a background job whose own step
 * budget is shorter must not leave an orphaned CLI holding the single slot, refusing every
 * later call with 429 "busy" after the caller gave up) but never MORE, and an implausibly
 * small value is floored rather than failing instantly.
 */
export const resolveTimeoutMs = (requested) => {
  const n = Number(requested)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(n, MIN_TIMEOUT_MS), DEFAULT_TIMEOUT_MS)
}

// Same burst protection as claudeLocal: one spawn at a time, one queued.
const MAX_CONCURRENT = 1
const MAX_QUEUED = 1
let running = 0
const waiting = []

const acquireSlot = () => new Promise((resolve, reject) => {
  if (running < MAX_CONCURRENT) { running++; return resolve() }
  if (waiting.length >= MAX_QUEUED) {
    const err = new Error('The local Codex connector is busy with another request — try again in a moment')
    err.status = 429
    return reject(err)
  }
  waiting.push(resolve)
})

const releaseSlot = () => {
  const next = waiting.shift()
  if (next) next()
  else running--
}

export const getFamilyFromModelId = (id) => (id || '').toLowerCase()

export const parseModelId = (id) => ({
  id: id || '',
  family: getFamilyFromModelId(id),
  provider: PROVIDER_NAME,
  version: ''
})

export const listModels = async (_opts = {}) => KNOWN_MODELS.map(id => ({
  id,
  family: id,
  provider: PROVIDER_NAME,
  version: '',
  latest: true
}))

/** All zeros on purpose — see claudeLocal.getPricing; ZERO_COST_PROVIDERS admits them. */
export const getPricing = async ({ targetModel = null } = {}) => {
  const ids = targetModel ? [targetModel] : KNOWN_MODELS
  const models = {}
  for (const id of ids) models[id] = { input: 0, output: 0, cachedInput: 0 }
  return { models, source: 'subscription_zero_cost', sourceModel: null }
}

export const CAPABILITIES = {
  web: { search: false, fetch: false },
  vision: false,
  documents: false,
  thinking: { text: true }, // reasoning items are passed through when the CLI emits them
  effort: false,
  cache: false,
  images: { generate: false },
  voice: false
}

export const getCapabilities = async (_opts = {}) => ({ ...CAPABILITIES })

const CANDIDATE_PATHS = [
  path.join(os.homedir(), '.local', 'bin', 'codex'),
  '/usr/local/bin/codex',
  '/opt/homebrew/bin/codex'
]

/** Same rule as findClaudeBinary: only executables actually NAMED codex are accepted. */
export const findCodexBinary = (preferredPath = null) => {
  const candidates = preferredPath ? [preferredPath, ...CANDIDATE_PATHS] : CANDIDATE_PATHS
  for (const candidate of candidates) {
    if (!candidate || path.basename(candidate) !== 'codex') continue
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch (e) { /* try next */ }
  }
  return null
}

/** Returns the slug to pass to -m, or NULL meaning "omit -m and let the account default win". */
const resolveModelArg = (model) => {
  const wanted = (model || DEFAULT_FAMILY).toLowerCase()
  if (wanted === AUTO_MODEL) return null
  if (KNOWN_MODELS.includes(wanted)) return wanted
  if (wanted.startsWith('gpt-')) return wanted
  return DEFAULT_FAMILY
}

const contentToText = (content) => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(b => (b && typeof b === 'object' && typeof b.text === 'string') ? b.text : '').join('')
  }
  return String(content ?? '')
}

// Codex has no system-prompt flag in exec mode, so `context` rides at the top of the prompt;
// messages arrays are flattened to a labeled transcript like claudeLocal.
const buildPromptText = (prompt, context) => {
  let body
  if (typeof prompt === 'string' || !Array.isArray(prompt)) {
    body = String(prompt ?? '')
  } else if (prompt.length === 1) {
    body = contentToText(prompt[0].content)
  } else {
    body = prompt
      .map(m => ((m.role === 'assistant' ? 'Assistant' : 'User') + ': ' + contentToText(m.content)))
      .join('\n\n')
  }
  if (!context) return body
  return '<instructions>\n' + context + '\n</instructions>\n\n' + body
}

const buildArgs = ({ model, sandboxDir }) => {
  const modelArg = resolveModelArg(model)
  const args = [
    'exec',
    '--json',
  // Containment: read-only sandbox, empty scratch working root, no user config/rules/session
  // files. --ignore-user-config keeps auth (documented: "auth still uses CODEX_HOME").
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
  // Model-generated shell commands inherit NOTHING. Verified against this CLI: with the
  // allowlisted spawn env plus this flag, an injected `printenv DB_PASS` returns empty.
  // (Codex's own defaults only strip *KEY*/*SECRET*/*TOKEN*, which misses DB_PASS and
  // FS_MS_CONNECTION_STRING — so this is not redundant with them.)
    '-c', 'shell_environment_policy.inherit=none',
  // NO COMMAND EXECUTION. `features.shell_tool=false` is the switch that makes this a
  // text-in/text-out client; verified on 0.153.4 (a run carrying it produced no
  // command_execution events at all, and those events come from the CLI, not the model).
  // This is the PRIMARY containment control: it removes the capability rather than
  // constraining it, which is what makes untrusted content in a prompt survivable.
    '--disable', 'shell_tool',
  // Belt and braces around it. NOTE these have NOT each been independently proven to close
  // their surface — see the residual risk in local_cli_llm_connectors.md.
    '--disable', 'apps',
    '--disable', 'plugins',
    '--disable', 'remote_plugin',
    '--disable', 'hooks',
    '--disable', 'multi_agent',
    '--disable', 'browser_use',
    '--disable', 'computer_use',
    '--disable', 'image_generation',
    '--disable', 'unified_exec', // the other execution surface; only shown once not to defeat shell_tool=false
  // We advertise CAPABILITIES.web=false but never told the CLI until now.
    '-c', 'web_search="disabled"',
  // Non-interactive: never sit waiting for an approval nobody can give.
    '-c', 'approval_policy="never"',
  // Make a wrong/renamed -c key a LOUD startup error instead of silently doing nothing —
  // the dangerous failure mode for a containment flag.
    '--strict-config',
    '--color', 'never'
  ]
  // -s read-only is KEPT deliberately. A named permission profile would allow finer read
  // rules, but activating one requires DROPPING -s (they conflict — verified), and the
  // profile's scratch-only promise does not hold: `:minimal` is broader than the named
  // directory and an explicit deny on a temp path was not honoured. Trading a working coarse
  // control for a leaky fine-grained one is the wrong direction while shell_tool=false is
  // itself unproven as a COMPLETE boundary.
  args.push('-s', 'read-only', '-C', sandboxDir)
  if (modelArg) args.push('-m', modelArg)
  return args
}

const spawnCli = ({ binaryPath, model }) => {
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freezr-codex-local-'))
  // Allowlisted environment — see localCliEnv.mjs. Subsumes the old OPENAI_API_KEY /
  // CODEX_API_KEY billing guarantee, and matters more here than for claudeLocal on two
  // counts: this CLI is a `#!/usr/bin/env node` script, so NODE_OPTIONS would inject code
  // into it; and it executes model-generated shell commands, so anything left in this
  // environment is reachable by a prompt injection. CODEX_HOME is passed because the CLI's
  // auth lives there (documented: `--ignore-user-config` still uses CODEX_HOME).
  const env = buildLocalCliEnv(['CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'])
  const child = spawn(binaryPath, buildArgs({ model, sandboxDir }), { cwd: sandboxDir, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })

  // See claudeLocal: an unlistened 'error' on stdin (EPIPE when the child is already gone)
  // is an uncaught exception that kills the whole server.
  child.stdin.on('error', () => { /* child gone before it read the prompt; exit path reports it */ })
  const cleanup = () => {
    try { fs.rmSync(sandboxDir, { recursive: true, force: true }) } catch (e) { /* best effort */ }
  }
  return { child, cleanup }
}

const makeCliError = (message, { code = null, status = null } = {}) => {
  const err = new Error(message)
  if (code) err.code = code
  if (status) err.status = status
  return err
}

const mapCliFailure = ({ exitCode, errorText, stderrText }) => {
  const detail = (errorText || '').trim() ||
    (stderrText || '').trim().split('\n').slice(-3).join(' ').slice(0, 500) ||
    ('codex CLI exited with code ' + exitCode)
  if (/usage limit|rate limit|limit reached|quota/i.test(detail)) {
    return makeCliError(
      'ChatGPT subscription usage window exhausted — retry after it resets, or use an API-key resource instead. (' + detail + ')',
      { code: 'subscription_limit', status: 429 }
    )
  }
  if (/log ?in|logged out|not authenticated|authent|credential/i.test(detail)) {
    return makeCliError(
      'The local codex CLI is not logged in. Run `codex login` in a terminal on the server (sign in with ChatGPT), then retry. (' + detail + ')',
      { code: 'local_cli_not_authenticated', status: 503 }
    )
  }
  return makeCliError('Local codex CLI failed: ' + detail, { code: 'local_cli_error' })
}

// Codex convention: cached_input_tokens are INCLUDED in input_tokens (the OpenAI shape), so
// they go under details.cachedPromptTokens, which the cost service re-prices rather than adds.
const standardizeUsage = (usage) => {
  if (!usage) {
    return {
      input: { qtty: 0, cost: 0 },
      output: { qtty: 0, cost: 0 },
      other: { qtty: 0, cost: 0, details: {} }
    }
  }
  const details = {}
  if (usage.cached_input_tokens) details.cachedPromptTokens = usage.cached_input_tokens
  return {
    input: { qtty: usage.input_tokens || 0, cost: 0 },
    output: { qtty: usage.output_tokens || 0, cost: 0 },
    other: { qtty: 0, cost: 0, details }
  }
}

const rejectUnsupported = ({ files, web }) => {
  if (files && files.length > 0) {
    throw makeCliError('The local Codex connector does not support file attachments — use an API-key resource for requests with files', {
      code: 'capability_unsupported',
      status: 400
    })
  }
  if (web && (web.search || web.fetch) && !web.optional) {
    throw makeCliError('The local Codex connector does not support web access — use an API-key resource for web-informed requests', {
      code: 'capability_unsupported',
      status: 400
    })
  }
}

const resolveBinaryOrThrow = (local) => {
  const binaryPath = findCodexBinary(local?.binaryPath || null)
  if (!binaryPath) {
    throw makeCliError(
      'No codex CLI found on this server. Install it (npm i -g @openai/codex) and run `codex login`, then re-test on Account Resources.',
      { code: 'local_cli_not_found', status: 503 }
    )
  }
  return binaryPath
}

const parseJsonResponse = (text) => {
  if (typeof text !== 'string') return text
  try { return JSON.parse(text) } catch (e) { /* fall through */ }
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  if (fence) {
    try { return JSON.parse(fence[1].trim()) } catch (e) { /* fall through */ }
  }
  return text
}

const buildDoneFields = ({ model, responseText, thinkingText, usage }) => ({
  response: responseText,
  thinking: thinkingText || null,
  provider: PROVIDER_NAME,
  model,
  family: getFamilyFromModelId(model),
  stopReason: 'end_turn',
  maxTokens: null,
  toolsUsed: null,
  citations: null,
  unavailable: [],
  rawUsage: { ...(usage || {}), subscription: true },
  tokensUsed: standardizeUsage(usage)
})

/**
 * Core event pump shared by ask() and askStream(): spawns `codex exec --json`, feeds the
 * prompt on stdin, and calls onEvent for each JSONL event. Resolves with the collected
 * { responseText, thinkingText, usage } or throws a mapped error.
 *
 * Event shapes handled (tolerantly — the stream is versioned by the CLI, not by us):
 *   { type: 'item.updated'|'item.completed', item: { type: 'agent_message'|'reasoning', text } }
 *   { type: 'turn.completed', usage: { input_tokens, cached_input_tokens, output_tokens } }
 *   { type: 'turn.failed', error: { message } } / { type: 'error', message }
 */
const runExec = async ({ binaryPath, model, promptText, timeoutMs, onEvent, control, signal }) => {
  // Single clamp point for this connector — both ask() and askStream() come through here.
  const effectiveTimeoutMs = resolveTimeoutMs(timeoutMs)
  await acquireSlot()
  // spawnCli INSIDE the try below: mkdtempSync and spawn can throw, and a throw between
  // acquireSlot() and the try would skip releaseSlot() — with MAX_CONCURRENT 1 that
  // permanently bricks the connector (every later call 429 "busy") until a restart.
  let child = null
  let cleanup = null
  const killChild = () => { if (child) { killProcessTree(child) } }
  // lets askStream's finally kill the subprocess when the caller abandons the generator
  // (gen.return on client disconnect) — otherwise the CLI would run to completion unheard
  if (control) control.kill = killChild
  // Caller-driven abort (the HTTP client went away). This has to kill the child DIRECTLY: an
  // async generator's return() is queued and only lands when the generator next suspends at a
  // YIELD, so a CLI gone quiet mid-answer would otherwise keep running — and keep this
  // connector's single slot — until the timeout. Killing it settles the exec normally.
  if (signal) {
    if (signal.aborted) killChild()
    else signal.addEventListener('abort', killChild, { once: true })
  }
  try {
    ({ child, cleanup } = spawnCli({ binaryPath, model }))
    // An already-aborted signal must kill the child the moment it exists.
    if (signal?.aborted) killChild()
    child.stdin.end(promptText)
    const stderr = []
    let errBytes = 0
    child.stderr.on('data', d => {
      errBytes += d.length
      if (errBytes <= MAX_CLI_OUTPUT_BYTES) stderr.push(d)
    })

    let agentText = '' // latest full text of the agent message (updates supersede)
    const completedMessages = []
    const thinkingParts = []
    let usage = null
    let errorText = null

    let lineBuffer = ''
    const handleLine = (line) => {
      if (!line.startsWith('{')) return
      let event = null
      try { event = JSON.parse(line) } catch (e) { return }
      const type = event.type || ''
      if ((type === 'item.updated' || type === 'item.completed') && event.item) {
        if (event.item.type === 'agent_message' && typeof event.item.text === 'string') {
          if (type === 'item.completed') {
            completedMessages.push(event.item.text)
            agentText = ''
          } else {
            agentText = event.item.text
          }
        } else if (event.item.type === 'reasoning' && typeof event.item.text === 'string' && type === 'item.completed') {
          thinkingParts.push(event.item.text)
        }
      } else if (type === 'turn.completed') {
        usage = event.usage || null
      } else if (type === 'turn.failed') {
        errorText = event.error?.message || 'turn failed'
      } else if (type === 'error') {
        errorText = event.message || 'error'
      }
      if (onEvent) onEvent(event)
    }

    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        killProcessTree(child)
        reject(makeCliError('Local codex CLI timed out after ' + Math.round(effectiveTimeoutMs / 1000) + 's', { code: 'local_cli_timeout', status: 504 }))
      }, effectiveTimeoutMs)
      let streamBytes = 0
      child.stdout.on('data', (data) => {
        // Bound peak memory; fail loud rather than truncating a JSONL line mid-object.
        streamBytes += data.length
        if (streamBytes > MAX_CLI_OUTPUT_BYTES) {
          clearTimeout(timer)
          killProcessTree(child)
          return reject(makeCliError(
            'The local codex CLI produced more than ' + Math.round(MAX_CLI_OUTPUT_BYTES / 1024 / 1024) +
            'MB on stdout and was stopped. This indicates a malfunctioning CLI, not a normal response.',
            { code: 'local_cli_output_too_large', status: 502 }))
        }
        lineBuffer += data.toString('utf8')
        let nl
        while ((nl = lineBuffer.indexOf('\n')) >= 0) {
          handleLine(lineBuffer.slice(0, nl).trim())
          lineBuffer = lineBuffer.slice(nl + 1)
        }
      })
      child.on('error', (e) => { clearTimeout(timer); reject(makeCliError('Could not run codex CLI: ' + e.message, { code: 'local_cli_error' })) })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (lineBuffer.trim()) handleLine(lineBuffer.trim())
        resolve(code)
      })
    })

    const responseText = completedMessages.length ? completedMessages.join('\n\n') : agentText
    if (exitCode !== 0 || errorText || (!responseText && !usage)) {
      throw mapCliFailure({ exitCode, errorText, stderrText: Buffer.concat(stderr).toString('utf8') })
    }
    return { responseText, thinkingText: thinkingParts.join('\n\n'), usage }
  } finally {
    // releaseSlot FIRST and unconditionally — see the note above the spawn.
    releaseSlot()
    if (signal) { try { signal.removeEventListener('abort', killChild) } catch (e) { /* best effort */ } }
    killChild()
    if (cleanup) cleanup()
  }
}

/**
 * Non-streaming ask. Same params as the API connectors; apiKey is ignored (there is none),
 * `local` carries the owner's connector config ({ binaryPath }) from the resource record.
 */
export const ask = async ({ prompt, context, model, responseType, files, web, local, timeoutMs, signal }) => {
  rejectUnsupported({ files, web })
  const binaryPath = resolveBinaryOrThrow(local)
  const requestedModel = resolveModelArg(model)
  const { responseText, thinkingText, usage } = await runExec({
    binaryPath,
    model: requestedModel,
    promptText: buildPromptText(prompt, context),
    timeoutMs,
    signal
  })
  const done = buildDoneFields({ model: requestedModel, responseText, thinkingText, usage })
  return {
    ...done,
    response: responseType === 'json' ? parseJsonResponse(done.response) : done.response
  }
}

/**
 * Streaming variant — Codex emits whole agent_message items (item.updated carries the
 * running text), so deltas are the new suffix since the last event: coarse but correct.
 */
export async function * askStream ({ prompt, context, model, files, web, local, timeoutMs, signal }) {
  rejectUnsupported({ files, web })
  const binaryPath = resolveBinaryOrThrow(local)
  const requestedModel = resolveModelArg(model)

  // queue+wake bridge from runExec's onEvent callback into generator yields
  const queue = []
  let wake = null
  const wakeUp = () => { if (wake) { const w = wake; wake = null; w() } }

  let streamedText = ''
  const onEvent = (event) => {
    const type = event.type || ''
    if ((type === 'item.updated' || type === 'item.completed') && event.item) {
      if (event.item.type === 'agent_message' && typeof event.item.text === 'string') {
        const full = event.item.text
        const newSuffix = full.startsWith(streamedText) ? full.slice(streamedText.length) : full
        if (newSuffix) {
          streamedText = full.startsWith(streamedText) ? full : streamedText + newSuffix
          queue.push({ type: 'delta', text: newSuffix })
        }
      } else if (event.item.type === 'reasoning' && typeof event.item.text === 'string' && type === 'item.completed') {
        queue.push({ type: 'thinking', text: event.item.text })
      }
    }
    wakeUp()
  }

  let finished = false
  let failure = null
  let collected = null
  const control = {}
  const runningExec = runExec({ binaryPath, model: requestedModel, promptText: buildPromptText(prompt, context), timeoutMs, onEvent, control, signal })
    .then(r => { collected = r }, e => { failure = e })
    .finally(() => { finished = true; wakeUp() })

  try {
    while (true) {
      while (queue.length) yield queue.shift()
      if (finished) break
      await new Promise(resolve => { wake = resolve })
    }
    await runningExec
    if (failure) throw failure

    yield {
      type: 'done',
      ...buildDoneFields({
        model: requestedModel,
        responseText: collected.responseText,
        thinkingText: collected.thinkingText,
        usage: collected.usage
      })
    }
  } finally {
    // reached on normal completion (harmless) AND on gen.return() from a client disconnect —
    // stop the subprocess so an abandoned request stops spending the subscription window
    if (control.kill) control.kill()
    await runningExec.catch(() => {}) // settle the slot/cleanup before returning
  }
}
