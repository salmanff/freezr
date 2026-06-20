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
      throw error
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let finalResult = null

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let lineEnd
      while ((lineEnd = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, lineEnd).trim()
        buffer = buffer.slice(lineEnd + 1)
        if (!line.startsWith('data: ')) continue
        try {
          const data = JSON.parse(line.slice(6))
          if (data.type === 'delta' && options.onDelta) {
            options.onDelta(data.text)
          } else if (data.type === 'thinking' && options.onThinking) {
            options.onThinking(data.text)
          } else if (data.type === 'done') {
            finalResult = { success: data.success, response: data.response, meta: data.meta }
            if (data.thinking) finalResult.thinking = data.thinking
          } else if (data.type === 'error') {
            throw new Error(data.error || 'LLM streaming error')
          }
        } catch (e) {
          if (e.message && !e.message.startsWith('Unexpected')) throw e
        }
      }
    }

    if (!finalResult) throw new Error('Stream ended without a done event')
    return finalResult
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
     * @param {boolean|Object} [options.thinking] - Enable extended thinking/reasoning.
     *   Claude: true for 10k budget, or { budget_tokens: N }. Returns full thinking text.
     *   ChatGPT: true for medium effort, or { effort: 'low'|'medium'|'high' }. Auto-selects o-series model. Returns reasoning summary.
     * @param {File|File[]} [options.files] - One or more File objects to include with the request
     * @param {boolean} [options.streamBack] - Stream LLM response chunks back to the browser via SSE.
     *   When true, onDelta/onThinking callbacks fire as text arrives. Incompatible with files and responseType:'json'.
     * @param {function} [options.onDelta] - Called with each text chunk during streaming (requires streamBack:true)
     * @param {function} [options.onThinking] - Called with each thinking/reasoning chunk during streaming
     * @param {string} [options.appToken] - App token (if calling from another app context)
     * @param {string} [options.host] - Remote host (for cross-server calls)
     * @returns {Promise<Object>} Response with
     *   { success, response, thinking?, meta: { provider, model, modelFamily, rawUsage, tokensUsed, cost?, pricing, availableFamilies, hasKey } }
     */
    async ask (prompt, options = {}) {
      const url = (options.host || '') + '/feps/llm/ask'

      const streamOpts = {
        appToken: options.appToken,
        onDelta: options.streamBack ? options.onDelta : undefined,
        onThinking: options.streamBack ? options.onThinking : undefined
      }

      if (options.files) {
        const uploadData = new FormData()
        const fileList = Array.isArray(options.files) ? options.files : [options.files]
        fileList.forEach(f => uploadData.append('file', f))
        const bodyOptions = {
          prompt,
          context: options.context,
          provider: options.provider,
          family: options.family,
          model: options.model,
          max_tokens: options.max_tokens,
          noCosts: options.noCosts,
          role: options.role,
          responseType: options.responseType,
          thinking: options.thinking
        }
        uploadData.append('options', JSON.stringify(bodyOptions))
        return _streamingAsk(url, uploadData, { ...streamOpts, isFormData: true })
      }

      const bodyOptions = {
        provider: options.provider,
        family: options.family,
        model: options.model,
        max_tokens: options.max_tokens,
        noCosts: options.noCosts,
        role: options.role,
        responseType: options.responseType,
        thinking: options.thinking
      }

      return _streamingAsk(url, { prompt, context: options.context, options: bodyOptions }, streamOpts)
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
    }
  }
}
