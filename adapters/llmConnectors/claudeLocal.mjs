// freezr.info - Claude Code local-CLI LLM Connector
// Runs prompts through the locally installed, logged-in `claude` CLI (headless `claude -p`),
// so the SERVER OWNER's Claude subscription answers instead of a metered API key.
//
// POLICY BOUNDARY (read before changing anything here):
// Anthropic permits a subscription owner to use headless Claude Code / the Agent SDK for
// their own personal projects, and prohibits third parties from offering claude.ai login or
// subscription rate limits in their products. This connector stays on the right side of that
// line structurally:
//   - it NEVER reads, stores, or transmits any credential — no OAuth token, no keychain,
//     no ~/.claude files. It only spawns the `claude` binary the owner installed and logged
//     into, and reads its stdout;
//   - it never calls api.anthropic.com;
//   - the child gets an ALLOWLISTED environment (localCliEnv.mjs), so the CLI can only answer
//     from the owner's login: no ANTHROPIC_API_KEY to bill silently, and no ANTHROPIC_BASE_URL
//     to redirect the owner's authenticated requests elsewhere;
//   - availability is triple-gated upstream (admin master pref `local_llm_cli_enabled`,
//     the requesting user's isAdmin flag, and an explicit owner attestation) — see
//     llmContext.mjs. Do not weaken those gates: serving this connector to a non-owner user
//     is exactly the prohibited pattern.
//
// Follows the connector contract documented at the top of anthropic.mjs. Deliberate gaps:
// max_tokens, cache and files are not supported by the CLI transport (files could be, via the
// sandbox cwd, but not until the base path is proven); `thinking` text is passed through when
// the CLI streams it but cannot be requested. Pricing is an all-zeros table — the subscription
// has no per-call price — with the CLI's API-equivalent figure kept as rawUsage.notionalCostUsd.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildLocalCliEnv, killProcessTree } from './localCliEnv.mjs'

export const DEFAULT_FAMILY = 'sonnet'

export const PROVIDER_NAME = 'ClaudeLocal'

/** Distinct from the API connector's 'anthropic' so usage tallies keep subscription rows apart. */
export const getVendorForModel = (_modelId) => 'anthropic-subscription'

const MODEL_ALIASES = ['sonnet', 'opus', 'haiku']
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const MIN_TIMEOUT_MS = 5 * 1000

// A misbehaving child can stream faster than the timeout expires, so a time limit does not
// bound PEAK MEMORY. This does. The cap is deliberately huge — a real answer is a few hundred
// KB, so ~100x headroom means it only ever fires on genuine pathology.
//
// On overflow we KILL and THROW. We never truncate and carry on: a clipped buffer breaks
// JSON.parse mid-object, which would turn a long but perfectly good answer into a confusing
// "no result" error. Loud and specific beats silently corrupt.
const MAX_CLI_OUTPUT_BYTES = 64 * 1024 * 1024
const outputTooLarge = (streamName) => makeCliError(
  'The local Claude Code CLI produced more than ' + Math.round(MAX_CLI_OUTPUT_BYTES / 1024 / 1024) +
  'MB on ' + streamName + ' and was stopped. This indicates a malfunctioning CLI, not a normal response.',
  { code: 'local_cli_output_too_large', status: 502 }
)

/**
 * Resolve a caller-requested wait against this connector's ceiling.
 *
 * A caller may ask to wait LESS than the ceiling and should: a background job whose own step
 * budget is shorter than DEFAULT_TIMEOUT_MS would otherwise leave an orphaned CLI holding the
 * single slot for the remainder, so every later /feps/llm/ask is refused 429 "busy" after the
 * caller has already given up. It may never ask for MORE — the ceiling is what bounds that slot.
 * A value too small to plausibly complete is floored rather than failing instantly, so a silly
 * number is a slow answer and not a hard error.
 */
export const resolveTimeoutMs = (requested) => {
  const n = Number(requested)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(n, MIN_TIMEOUT_MS), DEFAULT_TIMEOUT_MS)
}

// One spawn at a time, one queued behind it. Bursts against a subscription window are how a
// well-meaning app empties the owner's 5-hour allowance; anything past the queue fails fast
// with a clear message instead of piling up subprocesses.
const MAX_CONCURRENT = 1
const MAX_QUEUED = 1
let running = 0
const waiting = []

const acquireSlot = () => new Promise((resolve, reject) => {
  if (running < MAX_CONCURRENT) { running++; return resolve() }
  if (waiting.length >= MAX_QUEUED) {
    const err = new Error('The local Claude Code connector is busy with another request — try again in a moment')
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

export const getFamilyFromModelId = (id) => {
  if (!id) return ''
  const lower = id.toLowerCase()
  if (MODEL_ALIASES.includes(lower)) return lower
  // full claude-* ids: same parse as the API connector
  const stripped = lower.replace(/^claude-/, '').replace(/-\d{8}$/, '')
  const segments = stripped.split('-')
  const nameParts = []
  let majorVersion = null
  for (const seg of segments) {
    if (/^\d+$/.test(seg)) {
      if (majorVersion === null) majorVersion = seg
    } else {
      nameParts.push(seg)
    }
  }
  const base = nameParts.join('-')
  return majorVersion ? `${base}-${majorVersion}` : base
}

export const parseModelId = (id) => ({
  id: id || '',
  family: getFamilyFromModelId(id),
  provider: PROVIDER_NAME,
  version: ''
})

/**
 * The CLI resolves its own aliases to the current model, so the list is the aliases — there
 * is no models API to enumerate against (and no key to do it with).
 */
export const listModels = async (_opts = {}) => MODEL_ALIASES.map(alias => ({
  id: alias,
  family: alias,
  provider: PROVIDER_NAME,
  version: '',
  latest: true
}))

/**
 * All zeros ON PURPOSE: subscription calls have no per-call dollar price. Keeping a real
 * (zero) price row — rather than returning null — is what makes every downstream cost figure
 * an honest $0.00 instead of "unknown", and stops llmAsk re-attempting a pricing lookup on
 * each call. normalizePricingModels admits zero rows for this provider only.
 */
export const getPricing = async ({ targetModel = null } = {}) => {
  const ids = targetModel ? [targetModel] : MODEL_ALIASES
  const models = {}
  for (const id of ids) models[id] = { input: 0, output: 0, cachedInput: 0 }
  return { models, source: 'subscription_zero_cost', sourceModel: null }
}

export const CAPABILITIES = {
  web: { search: false, fetch: false },
  vision: false,
  documents: false,
  thinking: { text: true }, // passed through when the CLI streams it; cannot be requested
  effort: true,
  cache: false,
  images: { generate: false },
  voice: false
}

export const getCapabilities = async (_opts = {}) => ({ ...CAPABILITIES })

// Where a native install lands the binary. An explicit configured path (from the owner's
// enable screen) is tried first; $PATH is not consulted because the server process's PATH
// (launchd, systemd) rarely matches the owner's shell.
const CANDIDATE_PATHS = [
  path.join(os.homedir(), '.local', 'bin', 'claude'),
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude'
]

/**
 * Locate an executable `claude` binary. Only files actually NAMED claude are accepted — the
 * configured path is owner-written data, and this connector must never become a generic
 * "run any binary as the server" primitive.
 */
export const findClaudeBinary = (preferredPath = null) => {
  const candidates = preferredPath ? [preferredPath, ...CANDIDATE_PATHS] : CANDIDATE_PATHS
  for (const candidate of candidates) {
    if (!candidate || path.basename(candidate) !== 'claude') continue
    // Absolute only. A relative path would resolve against the server's cwd (the freezr tree),
    // and every legitimate configuration is absolute. Deliberately NOT checking ownership or
    // world-writability: homebrew, npm-global and service-user installs all vary, so those
    // checks would refuse good binaries with a baffling message for little gain given the
    // admin + master-pref + creator-only gates in front of this.
    if (!path.isAbsolute(candidate)) continue
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch (e) { /* try next */ }
  }
  return null
}

const resolveModelArg = (model) => {
  const wanted = (model || DEFAULT_FAMILY).toLowerCase()
  if (MODEL_ALIASES.includes(wanted)) return wanted
  if (wanted.startsWith('claude-')) return wanted
  return DEFAULT_FAMILY
}

const contentToText = (content) => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(b => (b && typeof b === 'object' && typeof b.text === 'string') ? b.text : '').join('')
  }
  return String(content ?? '')
}

// The CLI takes one prompt, not a messages array — a multi-turn prompt is flattened to a
// labeled transcript. Lossy for exotic content blocks, faithful for the text conversations
// apps actually send.
const flattenPrompt = (prompt) => {
  if (typeof prompt === 'string' || !Array.isArray(prompt)) return String(prompt ?? '')
  if (prompt.length === 1) return contentToText(prompt[0].content)
  return prompt
    .map(m => ((m.role === 'assistant' ? 'Assistant' : 'User') + ': ' + contentToText(m.content)))
    .join('\n\n')
}

const MAX_CONTEXT_CHARS = 32000
const capContext = (context) => {
  if (!context) return context
  const text = String(context)
  if (text.length <= MAX_CONTEXT_CHARS) return text
  throw makeCliError('context is too long for the local Claude CLI connector (' + text.length +
    ' chars; limit ' + MAX_CONTEXT_CHARS + ') — it is passed as a command-line argument. Shorten it or put the material in the prompt, which is sent on stdin.',
  { code: 'context_too_long', status: 400 })
}

const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant. Answer the user directly and completely.'

const buildArgs = ({ model, context, effort, streaming }) => {
  const args = [
    '-p',
    '--output-format', streaming ? 'stream-json' : 'json',
    '--model', resolveModelArg(model),
    // Prompt-in, text-out only: no tools, no MCP, no settings-file surprises, no session
    // files left on disk. NOT --bare: bare mode skips OAuth credentials, i.e. it would break
    // the subscription auth this connector exists for.
    '--tools', '',
    '--strict-mcp-config',
    '--restricted',
    '--no-session-persistence',
    // Replace the Claude Code system prompt: callers want a model answering, not a coding
    // agent narrating tool use it doesn't have.
    // NOTE: this rides in argv, so it is visible to any local user via `ps` for the duration of
    // the call, and argv has a hard size cap (~256KB macOS / ~2MB Linux) that a big context
    // would hit as a confusing E2BIG. This CLI version exposes no --system-prompt-file, so the
    // mitigation is a cap with a clear error rather than a silent truncation.
    '--system-prompt', capContext(context) || DEFAULT_SYSTEM_PROMPT
  ]
  if (streaming) args.push('--include-partial-messages', '--verbose')
  // Allowlisted, never passed through. `effort` is caller-supplied and lands in argv: a value
  // like '--dangerously-skip-permissions' is a token starting with '--', and whether an arg
  // parser treats that as a VALUE or as a new FLAG is its business, not ours. Since this
  // connector's entire containment rests on the flags above (--tools '', --restricted,
  // --strict-mcp-config), a caller who can smuggle one flag could undo all of them. The set
  // matches `claude --help` (low, medium, high, xhigh, max).
  if (effort && EFFORT_LEVELS.includes(String(effort))) args.push('--effort', String(effort))
  return args
}

const spawnCli = ({ binaryPath, args, signal }) => {
  // Empty scratch cwd: even with tools disabled, never point the CLI at freezr's own tree.
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freezr-claude-local-'))
  // Allowlisted environment — see localCliEnv.mjs. This SUBSUMES the old
  // `delete env.ANTHROPIC_API_KEY` billing guarantee (those variables are simply never
  // passed), and additionally keeps ANTHROPIC_BASE_URL — which would redirect the owner's
  // authenticated requests to another host — out of the child.
  const env = buildLocalCliEnv(['CLAUDE_CONFIG_DIR'])
  const child = spawn(binaryPath, args, { cwd: sandboxDir, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })

  // stdin errors must never reach the process-level handler. If the CLI is already gone when
  // we write the prompt — killed by an abort a tick earlier, exited on a bad flag, missing
  // binary — the write raises EPIPE on this stream, and an 'error' with no listener is an
  // UNCAUGHT EXCEPTION that takes the whole freezr server down. The child's exit/close
  // handlers already report the failure properly, so this listener only has to exist.
  child.stdin.on('error', () => { /* child gone before it read the prompt; exit path reports it */ })

  // Caller-driven abort (the HTTP client went away). This MUST kill the child directly rather
  // than relying on the caller closing our generator: an async generator's return() is queued
  // and only lands when the generator next suspends AT A YIELD, so a CLI that has gone quiet
  // mid-answer would keep running — and keep this connector's single slot — until its timeout.
  // Killing the child makes the exit handler fire, which unblocks the read loop normally.
  const onAbort = () => { killProcessTree(child) }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const cleanup = () => {
    if (signal) { try { signal.removeEventListener('abort', onAbort) } catch (e) { /* best effort */ } }
    try { fs.rmSync(sandboxDir, { recursive: true, force: true }) } catch (e) { /* best effort */ }
  }
  return { child, cleanup }
}

const isSubscriptionLimitMessage = (text) => /usage limit|rate limit|limit reached|out of.*(quota|usage)/i.test(text || '')

const makeCliError = (message, { code = null, status = null } = {}) => {
  const err = new Error(message)
  if (code) err.code = code
  if (status) err.status = status
  return err
}

const errorFromCliOutput = ({ exitCode, resultEvent, stderrText }) => {
  const detail = (resultEvent && typeof resultEvent.result === 'string' && resultEvent.result) ||
    (stderrText || '').trim().split('\n').slice(-3).join(' ').slice(0, 500) ||
    ('claude CLI exited ' + (exitCode === null ? 'on a signal (killed)' : 'with code ' + exitCode))
  if (isSubscriptionLimitMessage(detail)) {
    return makeCliError(
      'Claude subscription usage window exhausted — retry after it resets, or use an API-key resource instead. (' + detail + ')',
      { code: 'subscription_limit', status: 429 }
    )
  }
  if (/log ?in|logged out|authent|credential|setup-token/i.test(detail)) {
    return makeCliError(
      'The local Claude Code CLI is not logged in. Run `claude` in a terminal on the server and log in, then retry. (' + detail + ')',
      { code: 'local_cli_not_authenticated', status: 503 }
    )
  }
  return makeCliError('Local Claude Code CLI failed: ' + detail, { code: 'local_cli_error' })
}

// Anthropic-convention usage block (input_tokens / output_tokens / cache_*_input_tokens) into
// the canonical freezr shape — same details keys the cost service prices (see anthropic.mjs).
const standardizeUsage = (usage) => {
  if (!usage) {
    return {
      input: { qtty: 0, cost: 0 },
      output: { qtty: 0, cost: 0 },
      other: { qtty: 0, cost: 0, details: {} }
    }
  }
  const cacheRead = usage.cache_read_input_tokens || 0
  const cacheWrite = usage.cache_creation_input_tokens || 0
  const details = {}
  if (cacheRead || cacheWrite) {
    details.cacheReadTokens = cacheRead
    details.cacheCreationTokens = cacheWrite
  }
  return {
    input: { qtty: usage.input_tokens || 0, cost: 0 },
    output: { qtty: usage.output_tokens || 0, cost: 0 },
    other: { qtty: cacheRead + cacheWrite, cost: 0, details }
  }
}

// The model that actually answered, from the result event's modelUsage map (the CLI resolves
// aliases itself and we never see the resolution otherwise). Falls back to what was asked for.
const modelFromResult = (resultEvent, requestedModel) => {
  const usageMap = resultEvent?.modelUsage
  if (usageMap && typeof usageMap === 'object') {
    let best = null
    for (const [id, u] of Object.entries(usageMap)) {
      const out = (u && (u.outputTokens || u.output_tokens)) || 0
      if (!best || out > best.out) best = { id, out }
    }
    if (best) return best.id
  }
  return requestedModel
}

const buildDoneFields = ({ resultEvent, requestedModel, responseText }) => {
  const model = modelFromResult(resultEvent, requestedModel)
  const usage = resultEvent?.usage || null
  return {
    response: responseText,
    thinking: null,
    provider: PROVIDER_NAME,
    model,
    family: getFamilyFromModelId(model),
    stopReason: 'end_turn',
    maxTokens: null,
    toolsUsed: null,
    citations: null,
    unavailable: [],
    rawUsage: {
      ...(usage || {}),
      // what this WOULD have cost at API list rates — informational; the actual cost is $0
      notionalCostUsd: typeof resultEvent?.total_cost_usd === 'number' ? resultEvent.total_cost_usd : null,
      subscription: true
    },
    tokensUsed: standardizeUsage(usage)
  }
}

const rejectUnsupported = ({ files, web }) => {
  if (files && files.length > 0) {
    throw makeCliError('The local Claude Code connector does not support file attachments — use an API-key resource for requests with files', {
      code: 'capability_unsupported',
      status: 400
    })
  }
  if (web && (web.search || web.fetch) && !web.optional) {
    throw makeCliError('The local Claude Code connector does not support web access — use an API-key resource for web-informed requests', {
      code: 'capability_unsupported',
      status: 400
    })
  }
}

const resolveBinaryOrThrow = (local) => {
  const binaryPath = findClaudeBinary(local?.binaryPath || null)
  if (!binaryPath) {
    throw makeCliError(
      'No claude CLI found on this server. Install it (https://claude.ai/install.sh) and log in, then re-test on Account Resources.',
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

/**
 * Non-streaming ask. Same params as the API connectors; apiKey is ignored (there is none),
 * `local` carries the owner's connector config ({ binaryPath }) from the resource record.
 */
export const ask = async ({ prompt, context, model, responseType, effort, files, web, local, timeoutMs, signal }) => {
  rejectUnsupported({ files, web })
  const binaryPath = resolveBinaryOrThrow(local)
  const requestedModel = resolveModelArg(model)
  const args = buildArgs({ model: requestedModel, context, effort, streaming: false })
  const effectiveTimeoutMs = resolveTimeoutMs(timeoutMs)

  await acquireSlot()
  // spawnCli INSIDE the try: mkdtempSync (tmp full / permissions) and spawn can throw, and a
  // throw between acquireSlot() and the try would skip releaseSlot() — with MAX_CONCURRENT 1
  // that permanently bricks the connector, every later call failing 429 "busy" until restart.
  let child = null
  let cleanup = null
  try {
    ({ child, cleanup } = spawnCli({ binaryPath, args, signal }))
    const stdout = []
    const stderr = []
    let outBytes = 0
    let errBytes = 0
    let overflowed = null
    const guard = (streamName, bytes, sink, chunk) => {
      if (overflowed) return bytes
      const next = bytes + chunk.length
      if (next > MAX_CLI_OUTPUT_BYTES) { overflowed = streamName; killProcessTree(child); return next }
      sink.push(chunk)
      return next
    }
    child.stdout.on('data', d => { outBytes = guard('stdout', outBytes, stdout, d) })
    child.stderr.on('data', d => { errBytes = guard('stderr', errBytes, stderr, d) })
    child.stdin.end(flattenPrompt(prompt))

    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        killProcessTree(child)
        reject(makeCliError('Local Claude Code CLI timed out after ' + Math.round(effectiveTimeoutMs / 1000) + 's', { code: 'local_cli_timeout', status: 504 }))
      }, effectiveTimeoutMs)
      child.on('error', (e) => { clearTimeout(timer); reject(makeCliError('Could not run claude CLI: ' + e.message, { code: 'local_cli_error' })) })
      child.on('close', (code) => { clearTimeout(timer); resolve(code) })
    })

    if (overflowed) throw outputTooLarge(overflowed)
    const stdoutText = Buffer.concat(stdout).toString('utf8').trim()
    let resultEvent = null
    try {
      resultEvent = JSON.parse(stdoutText)
    } catch (e) {
      // tolerate leading noise: parse the last line that looks like a JSON object
      const lines = stdoutText.split('\n').filter(l => l.trim().startsWith('{'))
      for (let i = lines.length - 1; i >= 0 && !resultEvent; i--) {
        try { resultEvent = JSON.parse(lines[i]) } catch (e2) { /* keep looking */ }
      }
    }

    if (exitCode !== 0 || !resultEvent || resultEvent.is_error || resultEvent.subtype !== 'success') {
      throw errorFromCliOutput({ exitCode, resultEvent, stderrText: Buffer.concat(stderr).toString('utf8') })
    }

    const done = buildDoneFields({ resultEvent, requestedModel, responseText: resultEvent.result || '' })
    return {
      ...done,
      response: responseType === 'json' ? parseJsonResponse(done.response) : done.response
    }
  } finally {
    // releaseSlot FIRST and unconditionally: child/cleanup are null when spawnCli threw, and a
    // throw in here would strand the slot — the exact brick this restructuring prevents.
    releaseSlot()
    if (cleanup) cleanup()
  }
}

/**
 * Streaming variant — yields the contract's chunk protocol ({ delta } / { thinking } /
 * terminal { done }) off the CLI's stream-json events. The generator's finally kills the
 * subprocess, so the controller's gen.return() on client disconnect stops the spend.
 */
export async function * askStream ({ prompt, context, model, effort, files, web, local, timeoutMs, signal }) {
  rejectUnsupported({ files, web })
  const binaryPath = resolveBinaryOrThrow(local)
  const requestedModel = resolveModelArg(model)
  const args = buildArgs({ model: requestedModel, context, effort, streaming: true })
  const effectiveTimeoutMs = resolveTimeoutMs(timeoutMs)

  await acquireSlot()
  // spawnCli INSIDE the try: mkdtempSync (tmp full / permissions) and spawn can throw, and a
  // throw between acquireSlot() and the try would skip releaseSlot() — with MAX_CONCURRENT 1
  // that permanently bricks the connector, every later call failing 429 "busy" until restart.
  let child = null
  let cleanup = null
  try {
    ({ child, cleanup } = spawnCli({ binaryPath, args, signal }))
    child.stdin.end(flattenPrompt(prompt))

    const stderr = []
    let errBytes = 0
    child.stderr.on('data', d => {
      errBytes += d.length
      if (errBytes <= MAX_CLI_OUTPUT_BYTES) stderr.push(d)
    })

    // queue+wake bridge from the child's line events into generator yields
    const queue = []
    let wake = null
    let exited = null
    let spawnError = null
    const wakeUp = () => { if (wake) { const w = wake; wake = null; w() } }

    let lineBuffer = ''
    let streamBytes = 0
    child.stdout.on('data', (data) => {
      // Same reasoning as ask(): bound peak memory, and fail loud rather than truncating a
      // JSONL line mid-object (which would surface as an unparseable event, not as the real
      // problem). A single line this large means the CLI is malfunctioning.
      streamBytes += data.length
      if (streamBytes > MAX_CLI_OUTPUT_BYTES) {
        if (!spawnError) spawnError = outputTooLarge('stdout')
        exited = 'output_too_large'
        killProcessTree(child)
        wakeUp()
        return
      }
      lineBuffer += data.toString('utf8')
      let nl
      while ((nl = lineBuffer.indexOf('\n')) >= 0) {
        const line = lineBuffer.slice(0, nl).trim()
        lineBuffer = lineBuffer.slice(nl + 1)
        if (line.startsWith('{')) {
          try { queue.push(JSON.parse(line)) } catch (e) { /* partial/noise line */ }
        }
      }
      wakeUp()
    })
    child.on('error', (e) => { spawnError = e; exited = -1; wakeUp() })
    // `exited` doubles as the "has it finished?" sentinel for the read loop below, so it must
    // never be left null for a child that HAS finished. A signal-killed child reports
    // code === null (SIGKILL from an abort, or from the timeout path) — recording that verbatim
    // made `exited` indistinguishable from "still running", so the loop parked on until the
    // deadline even though the process was already gone. Record the signal name instead.
    child.on('close', (code, signalName) => {
      if (exited === null) exited = (code === null ? (signalName || 'killed') : code)
      wakeUp()
    })

    const deadline = Date.now() + effectiveTimeoutMs
    let resultEvent = null
    const textParts = []

    while (true) {
      while (queue.length) {
        const event = queue.shift()
        if (event.type === 'stream_event') {
          const delta = event.event?.delta
          if (delta?.type === 'text_delta' && delta.text) {
            textParts.push(delta.text)
            yield { type: 'delta', text: delta.text }
          } else if (delta?.type === 'thinking_delta' && delta.thinking) {
            yield { type: 'thinking', text: delta.thinking }
          }
        } else if (event.type === 'result') {
          resultEvent = event
        }
      }
      if (resultEvent || exited !== null) break
      if (Date.now() > deadline) {
        throw makeCliError('Local Claude Code CLI timed out after ' + Math.round(effectiveTimeoutMs / 1000) + 's', { code: 'local_cli_timeout', status: 504 })
      }
      await new Promise(resolve => {
        wake = resolve
        const t = setTimeout(() => { wake = null; resolve() }, 1000) // re-check the deadline
        if (t.unref) t.unref()
      })
    }

    if (spawnError) {
      throw makeCliError('Could not run claude CLI: ' + spawnError.message, { code: 'local_cli_error' })
    }
    if (!resultEvent || resultEvent.is_error || resultEvent.subtype !== 'success') {
      throw errorFromCliOutput({ exitCode: exited, resultEvent, stderrText: Buffer.concat(stderr).toString('utf8') })
    }

    yield {
      type: 'done',
      ...buildDoneFields({
        resultEvent,
        requestedModel,
        // the result event's text is authoritative; deltas are the fallback if it is empty
        responseText: (typeof resultEvent.result === 'string' && resultEvent.result) || textParts.join('')
      })
    }
  } finally {
    releaseSlot()
    if (child) { killProcessTree(child) }
    if (cleanup) cleanup()
  }
}
