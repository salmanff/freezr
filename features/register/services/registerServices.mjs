// freezr.info - Register Services
// Helper utilities for setup token handling and register setup flows

import crypto from 'crypto'

const SETUP_TOKEN_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/
const ENV_KEY_NAME = 'FREEZR_ENV_KEY'
const ENV_KEY_MIN_LEN = 16

export const createSetupToken = ({ daysValid = 1, now = Date.now() } = {}) => {
  const secret = crypto.randomBytes(24).toString('hex')
  const expiresAt = new Date(now + (daysValid * 24 * 60 * 60 * 1000))
  const dateStr = expiresAt.toISOString().slice(0, 10)
  return {
    token: `${secret}.${dateStr}`,
    expiresAt,
    dateStr
  }
}

const getEnvKey = () => {
  const rawKey = process?.env?.[ENV_KEY_NAME]
  if (!rawKey) return null
  if (rawKey.length < ENV_KEY_MIN_LEN) {
    throw new Error(`${ENV_KEY_NAME} is too short`)
  }
  return crypto.createHash('sha256').update(rawKey).digest()
}

export const parseSetupToken = (token) => {
  if (!token || typeof token !== 'string') return null
  const lastDot = token.lastIndexOf('.')
  if (lastDot < 0) return null
  const secret = token.slice(0, lastDot)
  const dateStr = token.slice(lastDot + 1)
  if (!secret || !SETUP_TOKEN_DATE_REGEX.test(dateStr)) return null
  const expires = new Date(`${dateStr}T23:59:59.999Z`)
  if (Number.isNaN(expires.getTime())) return null
  return { secret, expires, dateStr }
}

export const tokenExpired = (expires) => Date.now() > expires.getTime()

export const safeEqual = (a, b) => {
  if (!a || !b || a.length !== b.length) return false
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

export const encryptParams = (params) => {
  if (!params || typeof params !== 'object') return params
  if (params.__enc) return params
  if (params.type === 'system') return params

  const key = getEnvKey()
  if (!key) return params

  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(params))
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  return {
    __enc: {
      v: 1,
      alg: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: encrypted.toString('base64')
    }
  }
}

export const decryptParams = (params) => {
  if (!params || typeof params !== 'object') return params
  if (!params.__enc) return params

  const key = getEnvKey()
  if (!key) {
    throw new Error(`${ENV_KEY_NAME} is required to decrypt stored params`)
  }

  const { iv, tag, data } = params.__enc || {}
  if (!iv || !tag || !data) {
    throw new Error('Encrypted params missing iv/tag/data')
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(data, 'base64')),
    decipher.final()
  ])
  return JSON.parse(decrypted.toString('utf8'))
}

export const reAddConfidentialInfoToInitialEnvironment = (req, initialEnv, freezrPrefs) => {
  if (initialEnv && req.body && req.body.env) {
    let { fsParams, dbParams } = req.body.env
    if (fsParams && fsParams.useServerToken && fsParams.type === initialEnv.fsParams.type) {
      req.body.env.fsParams = initialEnv.fsParams
    } else if (fsParams && fsParams.choice === 'sysDefault' && freezrPrefs?.allowAccessToSysFsDb) {
      fsParams = initialEnv.fsParams
    }
    if (dbParams && dbParams.useServerToken && dbParams.type === initialEnv.dbParams.type) {
      req.body.env.dbParams = initialEnv.dbParams
    }
  }
}

// Simple checksum (can be upgraded to HMAC in the future)
const stableStringify = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

export const computeEnvChecksum = (env) => {
  if (!env || typeof env !== 'object') return null
  const toHash = { ...env }
  delete toHash._id
  delete toHash._date_created
  delete toHash._date_modified
  delete toHash.env_checksum
  const payload = stableStringify(toHash)
  return crypto.createHash('sha256').update(payload).digest('hex')
}

export const verifyEnvChecksum = (env) => {
  if (!env || typeof env !== 'object') return false
  if (!env.env_checksum) return false
  const expected = computeEnvChecksum(env)
  return expected === env.env_checksum
}
