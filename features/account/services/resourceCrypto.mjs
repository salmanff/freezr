// freezr.info - Account Resource Crypto Helpers
// Selective encryption/decryption of sensitive fields on records in
// info.freezr.account.resources. Used at the read/write boundaries so the rest
// of the codebase deals with cleartext records.
//
// Encryption uses encryptParams/decryptParams from the register services, which:
//   - Wrap arbitrary JSON in AES-256-GCM keyed off process.env.FREEZR_ENV_KEY
//   - Are idempotent (won't double-encrypt via the __enc marker)
//   - No-op silently when FREEZR_ENV_KEY is unset — caller stores plaintext-wrapped
//     in the same shape, just without the encryption envelope
//
// Per-type field handling:
//   - type: 'llm'         — `key` (string) is wrapped as { value } then encrypted
//   - type: 'connection'  — `oauth` (object) is encrypted as-is
//   - type: 'compute'     — `secret` (object: { accessKeyId, secretAccessKey, arnRole }) encrypted as-is
//
// Both directions are idempotent: encrypting an already-encrypted record returns
// it unchanged; decrypting a plain record returns it unchanged. This is critical
// for the transition period where some existing records are still plaintext.

import { encryptParams, decryptParams } from '../../register/services/registerServices.mjs'

let warnedNoEnvKeyInProd = false

const warnIfProdNoEnvKey = () => {
  if (warnedNoEnvKeyInProd) return
  if (process?.env?.NODE_ENV === 'production' && !process?.env?.FREEZR_ENV_KEY) {
    console.warn(
      '⚠️  FREEZR_ENV_KEY is not set in production — sensitive resource fields ' +
      '(LLM keys, OAuth tokens) will be stored UNENCRYPTED. Set FREEZR_ENV_KEY ' +
      'to a long random string and restart the server to enable encryption-at-rest.'
    )
    warnedNoEnvKeyInProd = true
  }
}

/**
 * Encrypt sensitive fields on a resource record about to be persisted.
 * Returns a new object — does not mutate input.
 *
 * @param {Object} record  Resource record being written to info.freezr.account.resources
 * @returns {Object}       Record with sensitive fields encrypted (when env key is set)
 */
export const encryptResourceSensitiveFields = (record) => {
  if (!record || typeof record !== 'object') return record
  warnIfProdNoEnvKey()

  if (record.type === 'llm') {
    if (record.key === undefined || record.key === null) return record
    if (typeof record.key === 'string') {
      // Plain string from the client — wrap then encrypt
      return { ...record, key: encryptParams({ value: record.key }) }
    }
    if (typeof record.key === 'object') {
      // Already an object — could be { value } (pre-encrypt) or { __enc } (already encrypted)
      // encryptParams is idempotent: passes through __enc, encrypts otherwise.
      return { ...record, key: encryptParams(record.key) }
    }
    return record
  }

  if (record.type === 'connection') {
    if (!record.oauth || typeof record.oauth !== 'object') return record
    // OAuth controller already encrypts via encryptParams before writing here, but
    // this hook is a safety net in case the connection record arrives in plaintext
    // via some other path (e.g. a future admin reseed). Idempotent.
    return { ...record, oauth: encryptParams(record.oauth) }
  }

  if (record.type === 'compute') {
    // Compute credentials (AWS access keys etc.) live in `secret`; encrypt it as a whole, like
    // connection oauth. Idempotent (encryptParams passes through an already-encrypted __enc).
    if (!record.secret || typeof record.secret !== 'object') return record
    return { ...record, secret: encryptParams(record.secret) }
  }

  return record
}

/**
 * Decrypt sensitive fields on a resource record being read for use.
 * Returns a new object — does not mutate input.
 *
 * Handles three storage shapes (transition-period safe):
 *   - plain string                (legacy LLM keys pre-encryption)
 *   - { value: '...' }            (env-key-unset path: wrapped but not encrypted)
 *   - { __enc: { ... } }          (env-key-set path: encrypted)
 *
 * @param {Object} record  Resource record loaded from info.freezr.account.resources
 * @returns {Object}       Record with sensitive fields in usable cleartext form
 */
export const decryptResourceSensitiveFields = (record) => {
  if (!record || typeof record !== 'object') return record

  if (record.type === 'llm') {
    if (record.key === undefined || record.key === null) return record
    if (typeof record.key === 'string') return record  // Legacy plain string — pass through
    if (typeof record.key === 'object') {
      const dec = decryptParams(record.key)  // pass-through if no __enc marker
      const plain = (dec && typeof dec === 'object' && 'value' in dec) ? dec.value : dec
      return { ...record, key: plain }
    }
    return record
  }

  if (record.type === 'connection') {
    if (!record.oauth || typeof record.oauth !== 'object') return record
    return { ...record, oauth: decryptParams(record.oauth) }
  }

  if (record.type === 'compute') {
    if (!record.secret || typeof record.secret !== 'object') return record
    return { ...record, secret: decryptParams(record.secret) }
  }

  return record
}

export default { encryptResourceSensitiveFields, decryptResourceSensitiveFields }
