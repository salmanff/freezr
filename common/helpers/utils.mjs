// freezr.info - nodejs system files - utils.js
// General utility functions

import path from 'path'

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
  let text = ""
  const possible = "ABCDEFGHIJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
  if (!textLen) textLen = 10

  for (let i = 0; i < textLen; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length))
  }
  return text
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
  return pathToCheck.endsWith('.html') || !pathToCheck.includes('.')
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