// freezrApiV2.llm.js - Freezr SDK add-on for LLM access
// Version 2.0.0 - 2026
//
// Attaches `freezr.llm` to the global `freezr` object created by
// freezrApiV2.js (core). Loaded only when the app's manifest declares a
// use_llm permission, or when the systemPermissions.json registry has a
// matching shortcut (see common/helpers/sdkAddons.mjs +
// adapters/rendering/pageLoader.mjs).

/* global freezr, freezrMeta */

if (typeof freezr === 'undefined') {
  console.error('freezrApiV2.llm.js loaded before freezrApiV2.js core — skipping. Check manifest script order.')
} else {
  console.log('Running freezrApiV2.llm.js !!')

  // ============================================
  // PRIVATE - SSE streaming reader for /feps/llm/ask
  // ============================================
  /**
   * Reads an SSE response from the server and collates the final result.
   * When callbacks (onDelta / onThinking) are provided via callbackOptions
   * they fire as chunks arrive (streamBack mode). Otherwise the stream is
   * consumed silently and the final result returned.
   *
   * @param {string} url - The endpoint URL
   * @param {*} body - Request body (JSON-serialisable object or FormData)
   * @param {Object} [options] - { appToken, onDelta, onThinking, isFormData }
   * @returns {Promise<Object>} Final result { success, response, meta, thinking? }
   * @throws {Error} On transport failure the thrown error carries `code` ('stream_incomplete'
   *   when the connection ended before the done event) plus `partial` / `partialThinking`
   *   (whatever had streamed) and `deltaCount`, so callers can salvage instead of re-paying.
   */
  async function _streamingAsk (url, body, options = {}) {
    let fullUrl = url
    if (!fullUrl.startsWith('http') && !freezr.app.isWebBased && freezrMeta.serverAddress) {
      fullUrl = freezrMeta.serverAddress + fullUrl
    }

    const accessToken = options.appToken ||
      (freezr.app.isWebBased ? freezr.utils.getCookie('app_token_' + freezrMeta.userId) : freezrMeta.appToken)

    const headers = {}
    if (accessToken) headers.Authorization = 'Bearer ' + accessToken

    let requestBody
    if (options.isFormData) {
      requestBody = body
    } else {
      headers['Content-Type'] = 'application/json'
      requestBody = JSON.stringify(body)
    }

    const response = await fetch(fullUrl, { method: 'PUT', headers, body: requestBody })

    if (response.status !== 200) {
      const errorData = await response.json().catch(() => ({}))
      const error = new Error(errorData.error || errorData.message || 'Unknown error')
      error.status = response.status
      // Carry the machine-readable fields through. Without this an app can only regex the
      // message: a capability rejection loses its code/capability/supportedBy, and the
      // long-standing 'no LLM key' 400 loses its meta.hasKey the same way.
      if (errorData.code) error.code = errorData.code
      if (errorData.capability) error.capability = errorData.capability
      if (errorData.supportedBy) error.supportedBy = errorData.supportedBy
      if (errorData.model) error.model = errorData.model
      if (errorData.meta) error.meta = errorData.meta
      throw error
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let finalResult = null
    // Kept even when the caller passed no callbacks: if the connection dies before the done
    // event, this is the only copy of what the model already said, and re-asking costs money.
    let partial = ''
    let partialThinking = ''
    let deltaCount = 0

    // Returns true when a terminal event was seen. Throws on an explicit server error event.
    const handleLine = (rawLine) => {
      const line = rawLine.trim()
      // ':' prefixed lines are SSE comments (our anti-idle heartbeat) — ignore them.
      if (!line.startsWith('data:')) return false
      const payload = line.slice(5).trim()
      if (!payload) return false
      let data
      try {
        data = JSON.parse(payload)
      } catch (e) {
        // A truncated final line. Not fatal on its own — let the caller see the partial.
        console.warn('freezr.llm: dropping unparseable SSE line', payload.slice(0, 120))
        return false
      }
      if (data.type === 'delta') {
        deltaCount++
        partial += (data.text || '')
        if (options.onDelta) options.onDelta(data.text)
      } else if (data.type === 'thinking') {
        partialThinking += (data.text || '')
        if (options.onThinking) options.onThinking(data.text)
      } else if (data.type === 'tool') {
        // Server-tool progress (web access). Purely informational — the answer still arrives
        // as deltas — so a caller that passes no onTool simply ignores it.
        if (options.onTool) options.onTool(data)
      } else if (data.type === 'done') {
        finalResult = { success: data.success, response: data.response, meta: data.meta }
        if (data.thinking) finalResult.thinking = data.thinking
        return true
      } else if (data.type === 'error') {
        const err = new Error(data.error || 'LLM streaming error')
        err.code = data.code || 'llm_error'
        // A capability rejection can only reach the app as an error EVENT once the stream has
        // started (headers are flushed before the provider is called), so keep its fields.
        if (data.capability) err.capability = data.capability
        if (data.model) err.model = data.model
        if (data.supportedBy) err.supportedBy = data.supportedBy
        err.partial = partial
        err.partialThinking = partialThinking
        err.deltaCount = deltaCount
        throw err
      }
      return false
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let lineEnd
      while ((lineEnd = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, lineEnd)
        buffer = buffer.slice(lineEnd + 1)
        handleLine(line)
      }
    }
    // The stream can end without a trailing newline (proxies re-chunk freely), which would
    // otherwise strand a complete done event in the buffer.
    buffer += decoder.decode()
    if (buffer.trim()) handleLine(buffer)

    if (!finalResult) {
      const err = new Error(deltaCount
        ? 'Connection dropped after ' + deltaCount + ' chunks, before the LLM finished'
        : 'Connection dropped before the LLM returned anything')
      err.code = 'stream_incomplete'
      err.partial = partial
      err.partialThinking = partialThinking
      err.deltaCount = deltaCount
      throw err
    }
    return finalResult
  }

  // A dropped SSE connection is a transport failure, not a model failure, so it is safe to
  // re-ask — but only when nothing had streamed yet. Once deltas have reached the caller's
  // onDelta, a silent re-ask would double-bill and duplicate text in their UI; those cases are
  // handed back with `.partial` attached so the app can salvage or restart deliberately.
  async function _streamingAskWithRetry (url, body, options = {}) {
    const maxAttempts = (options.retries === undefined ? 2 : options.retries) + 1
    let lastError = null
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await _streamingAsk(url, body, options)
      } catch (e) {
        lastError = e
        const retriable = e.code === 'stream_incomplete' && !e.deltaCount
        if (!retriable || attempt === maxAttempts) throw e
        console.warn('freezr.llm: ' + e.message + ' — retrying (' + (attempt + 1) + '/' + maxAttempts + ')')
        if (options.onRetry) options.onRetry(attempt, e)
        await new Promise(resolve => setTimeout(resolve, attempt * 1000))
      }
    }
    throw lastError
  }

  // Memoized ping backing freezr.llm.can(), so a UI can ask about several capabilities
  // while building a screen without issuing a request each time.
  let _capabilityPing = null

  // ONE list of the options that travel to the server, because there are three transports
  // (headless base64, browser multipart, plain JSON) and keeping three hand-written copies is
  // how `effort` ended up shipping in all three while documented in none.
  function _buildAskBodyOptions (options) {
    return {
      provider: options.provider,
      family: options.family,
      model: options.model,
      max_tokens: options.max_tokens,
      noCosts: options.noCosts,
      role: options.role,
      responseType: options.responseType,
      thinking: options.thinking,
      effort: options.effort,
      cache: options.cache,
      web: options.web,
      timeoutMs: options.timeoutMs
    }
  }

  // Headless background job helper: normalise one LLM file input into { fileName, mimeType, contentBase64 }.
  // A background job has no browser File, so it passes a Blob (e.g. from getAttachment) or a plain object
  // { fileName|name, mimeType|type, contentBase64 | buffer | data }. Buffer is provided by the job
  // sandbox. Connectors derive media type from the filename, so pass a sensible fileName.
  async function _toLlmFilePayload (f) {
    if (typeof Blob !== 'undefined' && f instanceof Blob) {
      return { fileName: f.name || 'file', mimeType: f.type || undefined, contentBase64: Buffer.from(await f.arrayBuffer()).toString('base64') }
    }
    if (f && typeof f === 'object') {
      const fileName = f.fileName || f.name || 'file'
      const mimeType = f.mimeType || f.type || undefined
      if (typeof f.contentBase64 === 'string') return { fileName, mimeType, contentBase64: f.contentBase64 }
      const raw = f.buffer || f.data
      if (typeof raw === 'string') return { fileName, mimeType, contentBase64: raw } // assume base64
      if (raw instanceof ArrayBuffer) return { fileName, mimeType, contentBase64: Buffer.from(raw).toString('base64') }
      if (ArrayBuffer.isView(raw)) return { fileName, mimeType, contentBase64: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('base64') }
    }
    throw new Error('llm.ask (job): each file must be a Blob, or { fileName, mimeType, contentBase64 | buffer }')
  }

  // ============================================
  // freezr.llm
  // ============================================

  freezr.llm = {
    /**
     * Check if the user has any LLM keys configured
     * @param {Object} [options]
     * @param {string} [options.appToken] - App token
     * @param {string} [options.provider] - Preferred provider for the returned snapshot
     * @param {boolean} [options.refresh] - Refresh pricing metadata before returning
     * @param {string} [options.host] - Remote host
     * @returns {Promise<Object>} { success, exists, defaultProvider, defaultFamily, providers, imageProviders?, pricingMeta }
     * `defaultProvider` is the user's chosen default provider name (e.g. 'Claude', 'ChatGPT').
     * `defaultFamily` is the default model family for that provider (e.g. 'sonnet', 'mini').
     * `providers[providerName]` is an array of `{ id, family, provider, version, latest, pricing }`.
     * `imageProviders[providerName]` is an array of image models (present when image models exist).
     * `latest` is true for the newest model in each family.
     * `pricing` is `{ input, output, other? }` (cost per M tokens) or null.
     * `pricingMeta[providerName]` is `{ lastUpdated, refreshNeeded }`.
     * `capabilities[providerName]` is what that provider can do beyond plain text — e.g.
     *   `{ web: { search: true, fetch: true }, voice: false, ... }`. Each value is `true`,
     *   `false`, or the string 'unknown'. 'unknown' means the provider has not published an
     *   answer for that model — treat it as "try it and handle the error", NOT as "no".
     *   Individual models in `providers[name][]` may also carry their own `capabilities`.
     */
    async ping (options = {}) {
      const url = (options.host || '') + '/feps/llm/ask'
      const writeOptions = {}
      if (options.appToken) writeOptions.appToken = options.appToken
      const body = { ping: true }
      if (options.provider) body.provider = options.provider
      if (options.refresh) body.refresh = true
      return freezr.apiRequest('PUT', url, body, { ...writeOptions, contentType: 'application/json' })
    },
    /**
     * Send a prompt to an LLM via the user's stored API keys
     * @param {string|Array} prompt - Text prompt or array of { role, content } messages for conversation history
     * @param {Object} [options] - Optional settings
     * @param {string} [options.context] - System message (LLM instructions/persona - eg 'you are a helpful assistant')
     * @param {string} [options.provider] - Preferred provider ('Claude' or 'ChatGPT')
     * @param {string} [options.family] - Model family shorthand ('sonnet', 'mini', 'opus' etc). Used when model is not specified.
     * @param {string} [options.model] - Model shorthand ('sonnet', 'o3-mini' etc) or full model name
     * @param {number} [options.max_tokens] - Max tokens for the response
     * @param {boolean} [options.noCosts] - Skip pricing lookups/cost enrichment for this request
     * @param {string} [options.role] - Default role when prompt is a string (defaults to 'user')
     * @param {string} [options.responseType] - 'json' to auto-parse JSON from the LLM response
     * @param {boolean|Object} [options.thinking] - Extended thinking/reasoning.
     *   Claude: true for 10k budget, or { budget_tokens: N }. Returns full thinking text.
     *   { display: 'summarized' } — REQUIRED to actually SEE the thinking on recent
     *   models (Sonnet 5, Opus 4.7+). Those models think by default and bill for it,
     *   but default to display 'omitted': the thinking blocks arrive with EMPTY text,
     *   so an app that renders `thinking` shows nothing while still paying. Pass
     *   { display: 'summarized' } to get a readable summary back. (The raw chain of
     *   thought is never returned on any model.)
     *   EXPLICIT false = "do not think": recent Claude models (Sonnet 5, Opus 4.7+) think BY
     *   DEFAULT when this option is absent, and thinking bills as output tokens — high-volume
     *   structured-output callers should pass false. Omitting the option keeps the model default.
     *   ChatGPT: true for medium effort, or { effort: 'low'|'medium'|'high' }. Auto-selects o-series model. Returns reasoning summary.
     * @param {boolean|Object} [options.cache] - Cache the prompt prefix at the provider (prompt caching).
     *   true for the default 5-minute TTL, or { ttl: '1h' }. Marks the end of the request's messages as a
     *   cache breakpoint: a follow-up call whose messages re-send the same prefix and only APPEND turns
     *   (e.g. Q&A over one large document) bills the cached span at ~10% of the input rate instead of full
     *   price. Claude only today; ignored by providers that cache automatically (ChatGPT). Cached-token
     *   counts and their cost are reported in meta.tokensUsed.other.
     *   EXPLICIT placement: when a turn's content is a content-block array and a block carries
     *   cache_control ({ type: 'ephemeral' } or { type: 'ephemeral', ttl: '1h' }), the server adds ONLY
     *   the system-prompt breakpoint and sends your turns exactly as given — no automatic breakpoints on
     *   the last messages. Use this when the last turn changes every call (a fresh email, a new record):
     *   automatic placement would cache-WRITE it every time (1.25x, or 2x at 1h) and rarely read it back.
     *   Put the marker on the last block of the STABLE part: e.g.
     *   [{ role: 'user', content: [{ type: 'text', text: stableDoc, cache_control: { type: 'ephemeral' } }] },
     *    { role: 'user', content: theVaryingQuestion }]. A 1h marker makes the system breakpoint 1h too.
     * @param {number} [options.timeoutMs] - How long the server may wait for this answer, in ms.
     *   Only ever SHORTENS the wait: each connector clamps it to its own ceiling (5 min on the
     *   local CLI connectors) and floors implausibly small values. Worth setting when the caller
     *   has a deadline of its own — a background job that abandons a step after 4 minutes should
     *   pass slightly less than that, so the local connector's single slot is freed when the job
     *   gives up instead of staying held (and refusing later calls with 429) until the ceiling.
     *   A job need not pass it to get that protection: the server already bounds the wait by the
     *   job's own remaining runtime. Ignored by the API-key connectors.
     * @param {string} [options.effort] - How hard the model should work: 'low'|'medium'|'high'|'xhigh'|'max'.
     *   Scales thinking depth AND overall token spend. Claude only; ignored elsewhere.
     * @param {boolean|Object} [options.web] - Let the model reach the live web.
     *   true enables everything the provider has. For finer control:
     *   { search: true|{ maxUses, allowedDomains, blockedDomains, userLocation },
     *     fetch:  true|{ maxUses, allowedDomains, blockedDomains, maxContentTokens },
     *     optional: false }
     *   search and fetch are different things: search runs a query, while fetch retrieves URLs
     *   ALREADY PRESENT in the conversation (so fetch is what you want when the user pastes a
     *   link, and useless for "look this up").
     *   Searches are billed per request and show up in meta.cost/meta.tokensUsed.other.
     *   By default an unsupported provider FAILS the call with code 'capability_unsupported'
     *   rather than quietly answering without the web — pass { optional: true } to prefer a
     *   possibly-stale answer, and check meta.capabilities.unavailable to see what you lost.
     *   Claude only today; check freezr.llm.can('web') first.
     * @param {File|File[]} [options.files] - One or more File objects to include with the request
     * @param {boolean} [options.streamBack] - Stream LLM response chunks back to the browser via SSE.
     *   When true, onDelta/onThinking callbacks fire as text arrives. Incompatible with files and responseType:'json'.
     * @param {function} [options.onDelta] - Called with each text chunk during streaming (requires streamBack:true)
     * @param {function} [options.onThinking] - Called with each thinking/reasoning chunk during streaming
     * @param {function} [options.onTool] - Called as the model uses a server tool (requires streamBack:true).
     *   Receives { type:'tool', tool:'web_search'|'web_fetch', status:'started'|'searching'|'result',
     *   query?, results?, url? } — enough to render "Searching the web…" and then the query.
     * @param {string} [options.appToken] - App token (if calling from another app context)
     * @param {string} [options.host] - Remote host (for cross-server calls)
     * @param {number} [options.retries] - Automatic re-asks when the connection drops before any
     *   text arrived (default 2, 0 to disable). Once text has streamed the call is NOT retried
     *   automatically — re-asking would double-bill and duplicate output in the caller's UI.
     *   Instead the thrown error carries `code: 'stream_incomplete'`, `partial` (the text that
     *   did arrive), `partialThinking` and `deltaCount`, so the app can salvage or restart.
     * @param {function} [options.onRetry] - Called as (attemptNumber, error) before each re-ask.
     * @returns {Promise<Object>} Response with
     *   { success, response, thinking?, meta: { provider, model, modelFamily, stopReason, maxTokens, rawUsage, tokensUsed, cost?, pricing, availableFamilies, hasKey } }
     *   When the model used the web, meta also carries:
     *     toolsUsed: { webSearch: { requests, queries, sources: [{url,title}] },
     *                  webFetch: { requests, urls }, errors: [{ tool, code }] }
     *     citations: [{ url, title, citedText }]
     *     capabilities: { unavailable: [] }  — non-empty only when you passed optional:true
     *                                          and did NOT get what you asked for.
     *   meta.stopReason is the provider's own reason for stopping: 'max_tokens' means
     *   the answer was CUT OFF at meta.maxTokens and what you got is partial (and, if
     *   you asked for responseType 'json', will not have parsed). 'end_turn' means it
     *   finished normally. Check it before trusting a response.
     */
    async ask (prompt, options = {}) {
      const url = (options.host || '') + '/feps/llm/ask'

      const streamOpts = {
        appToken: options.appToken,
        onDelta: options.streamBack ? options.onDelta : undefined,
        onThinking: options.streamBack ? options.onThinking : undefined,
        onTool: options.streamBack ? options.onTool : undefined,
        retries: options.retries,
        onRetry: options.onRetry
      }

      if (options.files) {
        const fileList = Array.isArray(options.files) ? options.files : [options.files]

        // Headless/job path: no multipart transport — send files as base64 JSON. The server
        // (uploadLlmIfNeeded) rebuilds req.files, so the connectors are unchanged. The response is
        // still SSE, which the job transport carries faithfully. See job-download-supplement.md.
        if (!freezr.app.isWebBased) {
          const filesBase64 = []
          for (const f of fileList) filesBase64.push(await _toLlmFilePayload(f))
          const bodyOptions = _buildAskBodyOptions(options)
          return _streamingAskWithRetry(url, { prompt, context: options.context, options: bodyOptions, filesBase64 }, streamOpts)
        }

        const uploadData = new FormData()
        fileList.forEach(f => uploadData.append('file', f))
        const bodyOptions = { prompt, context: options.context, ..._buildAskBodyOptions(options) }
        uploadData.append('options', JSON.stringify(bodyOptions))
        return _streamingAskWithRetry(url, uploadData, { ...streamOpts, uploadFile: true })
      }

      const bodyOptions = _buildAskBodyOptions(options)

      return _streamingAskWithRetry(url, { prompt, context: options.context, options: bodyOptions }, streamOpts)
    },
    /**
     * The capability snapshot behind can(), off the SAME memoized ping — so asking both costs
     * one request, not two. Use it when a yes/no is not enough and you need to know WHICH
     * provider will serve a capability (e.g. to tell the user which key is about to be spent).
     *
     *   const { capabilities, defaultProvider } = await freezr.llm.capabilities()
     *
     * @param {Object} [options] - { refresh, appToken, host }
     * @returns {Promise<{ capabilities: Object, defaultProvider: string|null }>}
     */
    async capabilities (options = {}) {
      if (!_capabilityPing || options.refresh) {
        _capabilityPing = this.ping({ appToken: options.appToken, host: options.host })
          .catch(e => { _capabilityPing = null; throw e })
      }
      const snapshot = await _capabilityPing
      return {
        capabilities: snapshot?.capabilities || {},
        defaultProvider: snapshot?.defaultProvider || null
      }
    },
    /**
     * Can the user's LLM setup actually do this? Use it to show a feature only where it works,
     * instead of finding out by failing.
     *
     *   if (await freezr.llm.can('web')) showWebToggle()
     *   if (await freezr.llm.can('voice.stt', { anyProvider: true })) showMicButton()
     *
     * @param {string} capability - 'web', 'web.search', 'voice.stt', 'vision', …
     * @param {Object} [options]
     * @param {string} [options.provider] - Check this provider instead of the user's default
     * @param {boolean} [options.anyProvider] - Answer for the BEST of the user's providers
     *   rather than their default. Use this for a capability only one provider has (voice is
     *   ChatGPT-only today): a user whose default is Claude but who also holds a ChatGPT key
     *   CAN transcribe, because the server picks the capable key for voice calls — so asking
     *   about the default alone would hide a feature that works. Do NOT use it for `web`,
     *   where the server deliberately refuses rather than switching the provider that answers.
     * @param {boolean} [options.refresh] - Re-ping instead of using the cached snapshot
     * @returns {Promise<boolean|string>} true, false, or 'unknown' (= try it and handle the error)
     */
    async can (capability, options = {}) {
      if (!_capabilityPing || options.refresh) {
        _capabilityPing = this.ping({ appToken: options.appToken, host: options.host })
          .catch(e => { _capabilityPing = null; throw e })
      }
      const snapshot = await _capabilityPing

      // Walks one provider's map. Kept as a local so anyProvider can run it over each of them
      // without a second copy of the rules — this resolver is already a hand-written twin of
      // the server's resolveCapability (browser JS cannot import it), and a third copy is how
      // the two would drift apart unnoticed.
      const resolveFor = (providerName) => {
        const map = snapshot?.capabilities?.[providerName]
        if (!map) return 'unknown'
        let node = map
        for (const segment of String(capability).split('.')) {
          if (node === 'unknown') return 'unknown'
          // Known in general but silent about this half — still 'try it', not 'no'.
          if (node === true) return 'unknown'
          if (!node || typeof node !== 'object' || !(segment in node)) return false
          node = node[segment]
        }
        if (node === 'unknown') return 'unknown'
        if (node && typeof node === 'object') return Object.values(node).some(v => v !== false)
        return node === true
      }

      if (!options.anyProvider) return resolveFor(options.provider || snapshot?.defaultProvider)

      const answers = Object.keys(snapshot?.capabilities || {}).map(resolveFor)
      if (answers.some(a => a === true)) return true
      // Nothing said yes, but something said "try it" — that is not a no.
      if (answers.some(a => a === 'unknown')) return 'unknown'
      return answers.length ? false : 'unknown'
    },
    /**
     * Generate an image using the user's stored LLM API keys.
     * OpenAI returns raster PNG; Anthropic generates SVG converted to PNG server-side.
     * @param {string} prompt - Text description of the image to generate
     * @param {Object} [options] - Optional settings
     * @param {string} [options.size] - Image size (default '1024x1024')
     * @param {string} [options.quality] - Quality level (default 'auto')
     * @param {string} [options.outputFormat] - 'png' (default) or 'svg'
     * @param {string} [options.provider] - LLM provider ('ChatGPT' or 'Claude')
     * @param {string} [options.model] - Specific model to use (adapter picks default if omitted)
     * @param {string} [options.appToken] - App token
     * @param {string} [options.host] - Remote host
     * @returns {Promise<Object>} { success, format, b64Data?, svgData?, revisedPrompt, meta, tokensUsed, cost }
     */
    async generateImage (prompt, options = {}) {
      const url = (options.host || '') + '/feps/llm/generate_image'
      const writeOptions = {}
      if (options.appToken) writeOptions.appToken = options.appToken
      const body = { prompt, size: options.size, quality: options.quality, outputFormat: options.outputFormat }
      if (options.provider) body.provider = options.provider
      if (options.model) body.model = options.model
      return freezr.apiRequest('PUT', url, body, { ...writeOptions, contentType: 'application/json' })
    },
    /**
     * Speech to text, using the user's stored LLM API keys.
     *
     * ChatGPT only: Anthropic ships no speech model at all, so on a Claude-only setup this
     * fails with code 'capability_unsupported' BEFORE anything is charged. Gate the feature
     * with `await freezr.llm.can('voice.stt')` rather than finding out by failing.
     *
     * @param {Blob|Object} audio - a Blob (e.g. from MediaRecorder), or { fileName, mimeType, contentBase64 }
     * @param {Object} [options] - Optional settings
     * @param {string} [options.language] - ISO-639-1 hint ('en', 'pt'). Improves accuracy AND speed.
     * @param {string} [options.prompt] - Vocabulary hint: names and jargon the audio contains
     * @param {string} [options.provider] - LLM provider (defaults to the user's default)
     * @param {string} [options.model] - Specific model (adapter picks a metered default if omitted)
     * @param {string} [options.appToken] - App token
     * @param {string} [options.host] - Remote host
     * @returns {Promise<Object>} { success, text, meta, tokensUsed, cost }
     */
    async transcribe (audio, options = {}) {
      const url = (options.host || '') + '/feps/llm/transcribe'
      const writeOptions = {}
      if (options.appToken) writeOptions.appToken = options.appToken
      const bodyOptions = {}
      for (const key of ['provider', 'model', 'language', 'prompt']) {
        if (options[key] !== undefined) bodyOptions[key] = options[key]
      }

      // Same two transports as ask()'s file attachments, and the same server-side handling:
      // multipart in a browser, base64 JSON for a job runtime with no FormData.
      if (!freezr.app.isWebBased) {
        const filesBase64 = [await _toLlmFilePayload(audio)]
        return freezr.apiRequest('PUT', url, { options: bodyOptions, filesBase64 }, { ...writeOptions, contentType: 'application/json' })
      }
      const uploadData = new FormData()
      uploadData.append('file', audio)
      uploadData.append('options', JSON.stringify(bodyOptions))
      // `uploadFile`, NOT `isFormData`. The core freezr.apiRequest gates pass-through on
      // `uploadFile`; `isFormData` is the name used by _streamingAsk, the LLM add-on's own
      // helper, a few lines up. Getting them the wrong way round does not error — apiRequest
      // just JSON.stringifies the FormData into "{}", the server sees an empty body, multer
      // finds no file, and the request dies as 'No audio provided' with nothing pointing here.
      return freezr.apiRequest('PUT', url, uploadData, { ...writeOptions, uploadFile: true })
    },
    /**
     * Text to speech, using the user's stored LLM API keys. ChatGPT only, as above —
     * gate with `await freezr.llm.can('voice.tts')`.
     *
     * Returns base64 audio the same way generateImage returns a base64 image:
     *   const { format, b64Data } = await freezr.llm.speak('Hello there')
     *   new Audio('data:audio/' + format + ';base64,' + b64Data).play()
     *
     * COST NOTE: the speech API returns no usage figures of any kind, so freezr meters this
     * call on the exact character count of `text`. meta/cost come back with
     * tokensUsed.other.details.costEstimated === true to say so.
     *
     * @param {string} text - What to say
     * @param {Object} [options] - Optional settings
     * @param {string} [options.voice] - 'alloy' (default), 'ash', 'coral', 'sage', 'marin', …
     * @param {string} [options.format] - 'mp3' (default), 'opus', 'aac', 'flac', 'wav', 'pcm'
     * @param {string} [options.instructions] - How to say it ('calm and slow'); ignored by tts-1
     * @param {string} [options.provider] - LLM provider (defaults to the user's default)
     * @param {string} [options.model] - Specific model
     * @param {string} [options.appToken] - App token
     * @param {string} [options.host] - Remote host
     * @returns {Promise<Object>} { success, format, b64Data, meta, tokensUsed, cost }
     */
    async speak (text, options = {}) {
      const url = (options.host || '') + '/feps/llm/speak'
      const writeOptions = {}
      if (options.appToken) writeOptions.appToken = options.appToken
      const bodyOptions = {}
      for (const key of ['provider', 'model', 'voice', 'format', 'instructions']) {
        if (options[key] !== undefined) bodyOptions[key] = options[key]
      }
      return freezr.apiRequest('PUT', url, { text, options: bodyOptions }, { ...writeOptions, contentType: 'application/json' })
    }
  }
}
