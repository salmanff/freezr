// freezr.info — LLM capability gate — llmCapabilityService.mjs
//
// The single place freezr decides whether an app may ask a provider for something beyond
// plain text-in/text-out. Connectors DECLARE what they can do (against the vocabulary in
// common/helpers/llmCapabilities.mjs); this service ENFORCES it, so no connector has to
// carry stub functions that only exist to throw.
//
// Nothing here touches a db or a network — same rule as llmCostService.mjs. Callers resolve
// the per-provider capability maps (via each connector's getCapabilities) and pass them in.
//
// Re-exports the vocabulary so a caller needs only this one import.

import {
  UNKNOWN,
  CAPABILITY_KEYS,
  resolveCapability,
  isPermitted,
  isConfirmed,
  normalizeWebOption
} from '../../../common/helpers/llmCapabilities.mjs'

export { UNKNOWN, CAPABILITY_KEYS, resolveCapability, isPermitted, isConfirmed, normalizeWebOption }

export const CAPABILITY_ERROR = 'capability_unsupported'
export const CAPABILITY_ERROR_ON_MODEL = 'capability_unsupported_on_model'

/**
 * Which of the user's OTHER providers could do this, so the error can say
 * "add/select your OpenAI key" instead of just failing.
 * @param {string} path - dotted capability path
 * @param {Object} providerCapabilities - { [providerName]: capabilityMap }
 * @param {string} [excludeProvider] - the one that just failed
 */
export const computeSupportedBy = (path, providerCapabilities, excludeProvider) => {
  const out = []
  for (const [provider, capabilities] of Object.entries(providerCapabilities || {})) {
    if (provider === excludeProvider) continue
    if (isConfirmed(resolveCapability(capabilities, path))) out.push(provider)
  }
  return out
}

// Human wording for the error message — an app developer reading a support ticket should
// see "cannot reach the web", not a dotted vocabulary path.
const CAPABILITY_PROSE = {
  web: 'reach the web',
  'web.search': 'search the web',
  'web.fetch': 'fetch web pages',
  vision: 'accept images',
  documents: 'accept documents',
  voice: 'handle voice',
  'voice.stt': 'do speech-to-text',
  'voice.tts': 'do text-to-speech',
  images: 'generate images'
}

/** The structured body an app gets back when a capability genuinely isn't available. */
export const buildCapabilityError = ({ capability, provider, model, supportedBy = [], onModel = false, suggestedModel = null }) => {
  const what = CAPABILITY_PROSE[capability] || ('do ' + capability)
  const where = onModel ? (provider + "'s " + (model || 'selected model')) : provider
  const body = {
    success: false,
    error: where + ' cannot ' + what +
      (supportedBy.length ? '. Available with: ' + supportedBy.join(', ') : ''),
    code: onModel ? CAPABILITY_ERROR_ON_MODEL : CAPABILITY_ERROR,
    capability,
    provider: provider || null,
    supportedBy
  }
  if (onModel) body.model = model || null
  if (suggestedModel) body.suggestedModel = suggestedModel
  return body
}

/**
 * The gate. Returns { ok: true, unavailable: [] } to proceed, or
 * { ok: false, error } with the structured body to send back.
 *
 * `optional: true` never fails — it degrades, and names what was dropped in `unavailable`
 * so the app can tell the user the answer wasn't web-informed.
 *
 * @param {Object} params
 * @param {string[]} params.required - dotted capability paths the request needs
 * @param {boolean} params.optional - degrade instead of failing
 * @param {Object} params.providerCapabilities - { [providerName]: capabilityMap }
 * @param {string} params.provider - the provider about to be called
 * @param {string} [params.model]
 */
export const checkCapabilities = ({ required = [], optional = false, providerCapabilities = {}, provider, model }) => {
  const capabilities = providerCapabilities[provider] || {}
  const unavailable = []

  for (const path of required) {
    if (isPermitted(resolveCapability(capabilities, path))) continue
    if (optional) { unavailable.push(path); continue }
    return {
      ok: false,
      unavailable,
      error: buildCapabilityError({
        capability: path,
        provider,
        model,
        supportedBy: computeSupportedBy(path, providerCapabilities, provider)
      })
    }
  }
  return { ok: true, unavailable }
}

export default {
  UNKNOWN,
  CAPABILITY_KEYS,
  CAPABILITY_ERROR,
  CAPABILITY_ERROR_ON_MODEL,
  resolveCapability,
  isPermitted,
  isConfirmed,
  computeSupportedBy,
  normalizeWebOption,
  buildCapabilityError,
  checkCapabilities
}
