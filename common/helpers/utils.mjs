// freezr.info - nodejs system files - utils.js
// General utility functions

import path from 'path'
import crypto from 'crypto'

// Array utilities
export const addToListAsUnique = (aList, anItem) => {
  if (!anItem) {
    return aList
  } else if (!aList) {
    return [anItem]
  } else if (aList.indexOf(anItem) < 0) {
    aList.push(anItem)
  }
  return aList
}

export const removeFromListIfExists = (aList, anItem) => {
  if (!anItem) {
    return aList
  } else if (!aList) {
    return []
  } else {
    const i = aList.indexOf(anItem)
    if (i > -1) aList.splice(i, 1)
  }
  return aList
}

export const reduceToUnique = (aList) => {
  const returnList = []
  aList.forEach(el => {
    if (returnList.indexOf(el) < 0) returnList.push(el)
  })
  return returnList
}

// Time utilities
export const nowInSeconds = () => {
  return Math.round((new Date()).getTime() / 1000)
}

export const expiryDatePassed = (expiry) => {
  const now = new Date().getTime()
  return now > expiry
}

// Random utilities
export const randomText = (textLen) => {
  if (!textLen) textLen = 10
  return crypto.randomBytes(Math.ceil(textLen * 0.75)).toString('base64url').slice(0, textLen)
}

// Regex safety utilities
export const escapeRegex = (str) => {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
export const isSafeRegex = (pattern) => {
  if (!pattern || typeof pattern !== 'string') return false
  if (pattern.length > 200) return false
  // Reject nested quantifiers — the core of almost all ReDoS patterns
  // Matches: group containing a quantifier, followed by a quantifier
  // e.g., (a+)+  (a*)*  (a+){2,}  (\w+)*
  if (/\([^)]*[+*}]\)?[+*{]/.test(pattern)) return false
  return true
}

// Version comparison
export const newVersionNumberIsHigher = (oldNum, newNum) => {
  return versionCompare(oldNum, newNum) === -1
}

export const newVersionNumberIsEqualOrHigher = (oldNum, newNum) => {
  return versionCompare(oldNum, newNum) <= 0
}

const versionCompare = (v1, v2) => {
  // https://www.geeksforgeeks.org/compare-two-version-numbers/
  let vnum1 = 0, vnum2 = 0

  for (let i = 0, j = 0; (i < v1.length || j < v2.length);) {
    // storing numeric part of version 1 in vnum1
    while (i < v1.length && v1[i] != '.') {
      vnum1 = vnum1 * 10 + (v1[i] - '0')
      i++
    }

    // storing numeric part of version 2 in vnum2
    while (j < v2.length && v2[j] != '.') {
      vnum2 = vnum2 * 10 + (v2[j] - '0')
      j++
    }

    if (vnum1 > vnum2)
      return 1
    if (vnum2 > vnum1)
      return -1

    // if equal, reset variables and go for next numeric part
    vnum1 = vnum2 = 0
    i++
    j++
  }
  return 0
}

// Text processing utilities
export const getWords = (anObject) => {
  if (!anObject) {
    return []
  } else if (typeof anObject === "string") {
    return anObject.toLowerCase().split(" ")
  } else if (!isNaN(anObject)) {
    return [anObject + ""]
  } else if (Array.isArray(anObject)) {
    let all = []
    anObject.forEach(el => { all = all.concat(getWords(el)) })
    return all
  } else if (typeof anObject === "object") {
    let all = []
    for (const aKey in anObject) {
      if (anObject.hasOwnProperty(aKey)) {
        all = all.concat(getWords(anObject[aKey]))
        all = all.concat([aKey])
      }
    }
    return all
  } else {
    return JSON.stringify(anObject).toLowerCase().split(" ")
  }
}

export const getUniqueWords = (anObject, theFields) => {
  // if theFields is null, all items are counted. if not only specific theFields of the object at the top level (and it has to be an object)
  let allWords = []
  if (Array.isArray(anObject) || typeof anObject !== "object" || !theFields) {
    return reduceToUnique(getWords(anObject))
  } else {
    theFields.forEach(aField => {
      allWords = allWords.concat(getWords(anObject[aField]))
    })
    return reduceToUnique(allWords)
  }
}

// Detect errors that mean "the storage provider rejected our credentials / we can't access the
// store" (as opposed to a genuine not-found or empty result). Used to surface a clear
// "refresh your credentials" warning instead of silently showing no data. Covers the AWS/S3 SDK
// error shapes, Azure/Dropbox/Google auth failures, and 401/403 responses.
export const isStorageAccessError = (err) => {
  if (!err) return false
  const name = err.name || ''
  const code = err.code || err.Code || ''
  const status = (err.$metadata && err.$metadata.httpStatusCode) || err.statusCode
  const msg = String(err.message || '')
  const NAMES = ['SignatureDoesNotMatch', 'InvalidAccessKeyId', 'AccessDenied', 'AuthorizationHeaderMalformed',
    'TokenRefreshRequired', 'InvalidToken', 'ExpiredToken', 'CredentialsError', 'UnrecognizedClientException',
    'AuthenticationFailed', 'InvalidAuthenticationInfo']
  if (NAMES.includes(name) || NAMES.includes(code)) return true
  if (status === 401 || status === 403) return true
  return /signature.*does not match|access denied|invalid access key|invalid_grant|invalid token|expired token|authentication ?failed|not authorized|unauthorized|credentials/i.test(msg)
}

// Path utilities
export const removeLastPathElement = (statedPath, depth) => {
  if (!depth) depth = 1
  const parts = statedPath.split(path.sep)
  for (let i = 0; i < depth; i++) {
    parts.pop()
  }
  return parts.join(path.sep)
}
/**
 * Check if a resource path represents a page request
 * Pages are resources that end with .html or have no file extension
 * 
 * @param {string} pathToCheck - The resource path to check
 * @returns {boolean} True if the resource is a page, false if it's a file
 */
export const isPageRequest = (pathToCheck) => {
  if (!pathToCheck) return false  
  // Check if resource ends with .html or has no extension (no ".")
  return pathToCheck.endsWith('.html') || !pathToCheck.split('/')?.pop().includes('.') || pathToCheck.endsWith('?') || pathToCheck.startsWith('/app/settings/')
}

/**
 * Paths we should never use as a post-login fwdTo target (would loop or
 * land the user back on a credential / setup page).
 */
const FWDTO_SKIP_PREFIXES = [
  '/account/login',
  '/account/logout',
  '/account/reset',
  '/account/reauthorise',
  '/acctapi/',
  '/register/',
  '/admin/'
]

/**
 * True if `url` is a safe same-origin relative URL we can hand to the browser
 * for navigation. Blocks protocol-relative (`//evil`), absolute (`http://…`),
 * and pseudo-protocol (`javascript:`) URLs to prevent open-redirect abuse.
 *
 * @param {string} url
 * @returns {boolean}
 */
export const isSafeRelativeUrl = (url) => {
  if (typeof url !== 'string' || url.length === 0) return false
  if (!url.startsWith('/')) return false
  if (url.startsWith('//')) return false
  if (url.includes('\\')) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false
  return true
}

/**
 * Build a login redirect URL that preserves the user's intended destination
 * via a `fwdTo` query parameter. The login page (`account_login.js`) reads
 * `fwdTo` and navigates there once the user authenticates.
 *
 * Rules:
 *  - If `redirectUrl` already carries a `fwdTo`, return it unchanged
 *    (something upstream already decided where to forward to).
 *  - Prefer an existing `req.query.fwdTo` if present and safe — that lets the
 *    target survive multi-hop redirect chains (e.g. /apps/foo → /account/home
 *    → /account/login) without being overwritten with the intermediate URL.
 *  - Otherwise capture `req.originalUrl`.
 *  - Skip if the candidate target is itself a login/logout/register/admin
 *    page (avoids pointless or looping forwards).
 *  - Validate with `isSafeRelativeUrl` to block open-redirect payloads.
 *
 * @param {object} req - Express request object (may be undefined)
 * @param {string} redirectUrl - Base URL to redirect the user to (e.g. /account/home)
 * @returns {string} The redirect URL, possibly enriched with `?fwdTo=…`
 */
export const buildLoginRedirectUrl = (req, redirectUrl) => {
  if (!redirectUrl || typeof redirectUrl !== 'string') return redirectUrl
  if (!req) return redirectUrl
  if (redirectUrl.includes('fwdTo=')) return redirectUrl

  // Prefer an already-captured fwdTo so it survives redirect chains.
  let target = req.query && req.query.fwdTo
  if (!isSafeRelativeUrl(target)) target = req.originalUrl
  if (!isSafeRelativeUrl(target)) return redirectUrl

  const pathOnly = target.split('?')[0]
  if (FWDTO_SKIP_PREFIXES.some(p => pathOnly === p || pathOnly.startsWith(p + (p.endsWith('/') ? '' : '/')))) {
    return redirectUrl
  }

  const sep = redirectUrl.includes('?') ? '&' : '?'
  return `${redirectUrl}${sep}fwdTo=${encodeURIComponent(target)}`
}

/**
 * Decide whether the *browser* expected a top-level page response (HTML)
 * versus a sub-resource fetch (script / style / image / xhr / etc.).
 *
 * Uses Fetch Metadata Request Headers (Sec-Fetch-*) which are sent by all
 * modern browsers (Chrome 76+, Firefox 90+, Safari 16.4+):
 *   - Sec-Fetch-Dest: document | iframe | frame  -> top-level / framed page
 *   - Sec-Fetch-Mode: navigate                   -> navigation request
 *   - Sec-Fetch-Dest: script|style|image|font|...|empty -> sub-resource / fetch
 *
 * Falls back to the Accept header (text/html dominant) for older clients,
 * and finally to the URL-extension heuristic so server-to-server callers and
 * tests still get a sensible answer.
 *
 * Use this when deciding the *response shape* (HTML redirect vs JSON 401).
 * For routing dispatch based on the resource path itself, keep using
 * `isPageRequest(path)` instead.
 *
 * @param {object} req - Express request object
 * @returns {boolean} True if the browser is asking for a page
 */
export const isPageBrowserRequest = (req) => {
  if (!req) return false
  const headers = req.headers || {}
  const dest = headers['sec-fetch-dest']
  const mode = headers['sec-fetch-mode']

  // Modern browsers always send at least one Sec-Fetch-* header.
  if (dest || mode) {
    if (dest === 'document') return true // || dest === 'iframe' || dest === 'frame'
    if (mode === 'navigate') return true
    return false
  }

  // Older clients / non-browser callers: prefer Accept negotiation.
  const accept = headers.accept || ''
  if (accept.includes('text/html')) return true
  if (accept && !accept.includes('*/*')) return false

  // Last-ditch fallback: URL heuristic (note: misclassifies dotted app names).
  return isPageRequest(req.path || req.url)
}

// Object comparison utilities
/**
 * Compares two objects to see if they are the same, ignoring specified keys
 * @param {Object} obj1 - First object
 * @param {Object} obj2 - Second object
 * @param {Array} givenIgnorekeys - Keys to ignore in comparison
 * @returns {boolean} - True if objects are the same
 */
export const objectContentIsSame = function (obj1, obj2, givenIgnorekeys = []) {
  const ignorekeys = [...givenIgnorekeys]

  if ((obj1 === undefined || obj1 === null) && (obj2 === undefined || obj2 === null)) return true

  if (typeof obj1 !== typeof obj2) {
    return false
  }

  if (!obj1 || ['string', 'boolean', 'number'].includes(typeof obj1)) {
    return obj1 === obj2
  }

  if (Array.isArray(obj1)) return arraysAreSame(obj1, obj2, givenIgnorekeys)

  let areSame = true
  for (const key in obj1) {
    if ((!ignorekeys.includes(key)) && !objectContentIsSame(obj1[key], obj2[key], givenIgnorekeys)) {
      areSame = false
    }
    ignorekeys.push(key)
  }
  if (areSame) {
    for (const key in obj2) {
      if ((!ignorekeys.includes(key)) && !objectContentIsSame(obj1[key], obj2[key], [])) {
        areSame = false
      }
    }
  }
  return areSame
}
const arraysAreSame = (list1, list2, ignorekeys = []) => {
  if (list1.length !== list2.length) {
    return false
  } else if (list1.length === 0) {
    return true
  } else {
    for (let i = 0; i < list1.length; i++) {
      if (!objectContentIsSame(list1[i], list2[i], ignorekeys)) {
        return false
      }
    }
    return true
  }
}

export const isEmpty = (obj) => {
  if (!obj) return true
  return Object.keys(obj).length === 0 && obj.constructor === Object
}


// Logging utilities
export const log = (...messages) => {
  console.log(new Date(), ...messages)
}

// String utilities
export const startsWith = (longerText, checkText) => {
  if (!longerText || !checkText || typeof longerText !== 'string' || typeof checkText !== 'string') {
    return false
  }
  if (checkText.length > longerText.length) {
    return false
  }
  return checkText === longerText.slice(0, checkText.length)
}

export const endsWith = (longerText, checkText) => {
  if (!checkText || !longerText || checkText.length > longerText.length) {
    return false
  }
  return checkText === longerText.slice(longerText.length - checkText.length)
}

export const startsWithOneOf = (theText, stringArray) => {
  return stringArray.some(str => startsWith(theText, str))
}

// Email validation
export const emailIsValid = (email) => {
  return email.includes('@') && email.includes('.')
}

// Default export with all exports
export default {
  // Array utilities
  addToListAsUnique,
  removeFromListIfExists,
  reduceToUnique,
  
  // Time utilities
  nowInSeconds,
  expiryDatePassed,
  
  // Random utilities
  randomText,

  // Regex safety utilities
  escapeRegex,
  isSafeRegex,
  
  // Version comparison
  newVersionNumberIsHigher,
  newVersionNumberIsEqualOrHigher,
  
  // Text processing
  getWords,
  getUniqueWords,
  
  // Path utilities
  removeLastPathElement,
  
  // Object comparison
  objectContentIsSame,
  isEmpty,

  // Logging
  log,
  
  // String utilities
  startsWith,
  endsWith,
  startsWithOneOf,
  
  // Email validation
  emailIsValid,
  

} 