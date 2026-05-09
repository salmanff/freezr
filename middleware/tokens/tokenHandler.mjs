// freezr.info - Modern ES6 Module - Token Handler
// Handles all token-related operations for authentication
//
// Architecture Pattern:
// - Dedicated module for token generation and management
// - Modern ES6 async/await patterns
// - Clean separation from legacy access_handler.js

import { generateOneTimeAppPassword } from '../../common/helpers/config.mjs'

const EXPIRY_DEFAULT = 2 * 24 * 60 * 60 * 1000 // 2 days in milliseconds

const isExpired = (token) => {
  return token.expiry < (new Date().getTime() ) // + (24 * 60 * 60 * 1000)
}

const isCloseToExpiry = (token) => {
  return token.expiry < (new Date().getTime() - (24 * 60 * 60 * 1000)) // 1 day in milliseconds to refresh
}

/**
 * Generate a new app token for a user
 * 
 * @param {string} userId - User ID
 * @param {string} appName - Application name
 * @param {string} deviceCode - Device code
 * @returns {string} Generated app token
 */
export function generateAppToken(userId, appName, deviceCode) {
  // onsole.log('🔑 Generating app token for:', { userId, appName, deviceCode })
  
  // Use the existing helper function
  // Use randomText from common/helpers/utils.mjs instead of helpers

  return generateOneTimeAppPassword()
}

/**
 * Get or create an app token for a logged-in user
 * 
 * @param {Object} tokenDb - Token database instance
 * @param {Object} req - Express request object with session data
 * @returns {Promise<Object>} Token information
 */
export async function getOrSetAppTokenForLoggedInUser(tokenDb, appName, session, cookies) {
  // onsole.log('🔑 getOrSetAppTokenForLoggedInUser called') // headers, 

  const deviceCode = session.device_code
  const userId = session.logged_in_user_id
  
  try {
    let expiredToken = null // if the token is expired, we need to update the token
    let appToken = null
    try {
      let existingToken = null
      try {
       existingToken = await getAndCheckCookieTokenForLoggedInUser(tokenDb, session, cookies)
       // onsole.log('🔑 getOrSetAppTokenForLoggedInUser - got existingToken', { existingToken })
      } catch (error) {
        // no prob - create new token
      }
      if (!existingToken) {
        appToken = generateAppToken(userId, appName, deviceCode)
        // onsole.log('🔑 getOrSetAppTokenForLoggedInUser - generated new appToken', { appToken })
      } else if (existingToken.app_name !== appName) {
        // console.warn('🔑 Token mismatch - app name mismatch - this should not happen SNBH ', { existingToken, appName })
        appToken = generateAppToken(userId, appName, deviceCode)
      } else if (existingToken && !isCloseToExpiry(existingToken)) { 
        // onsole.log('🔑 Returning existing app_token:', (existingToken.app_token), { expiry: new Date(existingToken.expiry).toISOString()})
        return existingToken
      } else if (existingToken) {
        // onsole.log('🔑 almost expired token:', (existingToken.app_token), { expiry: new Date(existingToken.expiry).toISOString()})
        expiredToken = existingToken // almost expired
        appToken = existingToken.app_token
      } else {
        appToken = generateAppToken(userId, appName, deviceCode)
      }

    } catch (error) {
      console.error('🔑 Error getting app token for logged in user:', error)
      if (error.code === 'expired' && error.tokenInfo) {
        expiredToken = error.tokenInfo
      } else {
        console.error('🔑 Error getting app token for logged in user:', error)
        throw error
      }
    }
    
    // Create new token
    const newToken = {
      logged_in: true,
      token_type: 'browser',
      source_device: deviceCode,
      requestor_id: userId,
      owner_id: userId,
      app_name: appName,
      app_password: null,
      app_token: appToken,
      expiry: (new Date().getTime() + EXPIRY_DEFAULT),
      user_device: deviceCode,
      date_used: new Date().getTime()
    }
    
    let writeResult
    if (expiredToken && !expiredToken._id) console.warn('⚠️ - hae tokem info with no id - should get id', { expiredToken })

    if (expiredToken && expiredToken._id) {
      // tokenDb.cache.byToken[expiredToken.app_token] = null
      writeResult = await tokenDb.update(expiredToken._id, newToken, { replaceAllFields: true })
      newToken._id = expiredToken._id
      // onsole.log('🔑 Updated token record', { tokenDb, aoc: tokenDb.dbParams.aoc })
    } else {
      writeResult = await tokenDb.create(null, newToken, { })
      // onsole.log('🔑 new token writeResult ', { newToken, writeResult, tokenDb, aoc: tokenDb.dbParams.aoc })
    }
    
    // // Update cache
    // if (!tokenDb.cache.byToken) tokenDb.cache.byToken = {}
    // tokenDb.cache.byToken[newToken.app_token] = newToken
    
    // // TODO-modernization - review - should we use byOwnerDeviceApp or byToken for caching? what is the use?
    // if (!tokenDb.cache.byOwnerDeviceApp) tokenDb.cache.byOwnerDeviceApp = {}
    // if (!tokenDb.cache.byOwnerDeviceApp[userId]) tokenDb.cache.byOwnerDeviceApp[userId] = {}
    // if (!tokenDb.cache.byOwnerDeviceApp[userId][deviceCode]) tokenDb.cache.byOwnerDeviceApp[userId][deviceCode] = {}
    // if (!tokenDb.cache.byOwnerDeviceApp[userId][deviceCode][appName]) tokenDb.cache.byOwnerDeviceApp[userId][deviceCode][appName] = {}
    // tokenDb.cache.byOwnerDeviceApp[userId][deviceCode][appName] = newToken
    
    return newToken
      
  } catch (error) {
    console.error('🔑 Token handler error 1:', { error, appName, userId, deviceCode})
    throw error
  }
}

/**
 * Get app token for a logged-in user
 * 
 * @param {Object} tokenDb - Token database instance
 * @param {Object} req - Express request object with session data
 * @returns {Promise<Object>} Token information
 */
export async function getAppTokenFromHeaderAndDoMinimalChecks(tokenDb, session, headers, tempCookieFortesting = null) {
  // onsole.log('🔑 getAppTokenFromHeaderAndDoMinimalChecks called')
  // ONLY CHECKS user_id and device_code for logged_in tokens, and expiry 
    
  const existingHeaderToken = getAppTokenFromHeader(headers)
  // onsole.log('🔑 existingHeaderToken', { existingHeaderToken })

  // onsole.log('🔑 Existing header token:', existingHeaderToken)
  const userId = session?.logged_in_user_id || null
  const existingCookieToken = (userId && tempCookieFortesting) ? tempCookieFortesting['app_token_' + userId] : null

  if (!existingHeaderToken) {
    throw new Error('getAppTokenFromHeaderAndDoMinimalChecks requires existingHeaderToken')
  }

  let tokenInfo = null

  // if (existingHeaderToken && tokenDb?.cache?.byToken[existingHeaderToken]?.app_token === existingHeaderToken) {
  //   tokenInfo = tokenDb.cache.byToken[existingHeaderToken]
  // } else {
  const results = await tokenDb.query({ app_token: existingHeaderToken })
  if (results && results.length > 0) {
    tokenInfo = results[0]
  }
  
  if (!tokenInfo) {
    console.error('❌ Token not found in database')
    throw new Error('Token not found in database')
  }
  
  if (existingHeaderToken && existingCookieToken && existingHeaderToken !== existingCookieToken && process.env.FREEZR_TEST_MODE !== 'true') {
    console.warn('⚠️ existingHeaderToken and existingCookieToken both found - should this happen?? - SNBH??')
    console.warn('⚠️ .. AND THEY ARE NOT EVEN EQUAL ???? 🤷🏽‍♂️ - SNBH??', { existingHeaderToken, existingCookieToken })
    // const results2 = await tokenDb.query({ app_token: existingCookieToken })
    // onsole.log('🔑 getAppTokenFromHeaderAndDoMinimalChecks - got results2', { results2, tokenInfo })

  }
  
  // if (!tokenDb.cache) tokenDb.cache = {}
  // if (!tokenDb.cache.byToken) tokenDb.cache.byToken = {}
  // tokenDb.cache.byToken[tokenInfo.app_token] = tokenInfo
  // }

  // 🟣🟣🟣 DIAG: log every offline-token usage so we can see whether the same
  // token survives past its expiry, or whether a fresh one is silently issued
  // if (tokenInfo && !tokenInfo.logged_in) {
  //   const _now = Date.now()
  //   const _msFromNow = (tokenInfo.expiry || 0) - _now
  //   console.log('🟣🟣🟣 OFFLINE-TOKEN USED (incoming API call)', {
  //     app_token: tokenInfo.app_token ? tokenInfo.app_token.substring(0, 10) + '...' : null,
  //     app_name: tokenInfo.app_name,
  //     token_type: tokenInfo.token_type,
  //     requestor_id: tokenInfo.requestor_id,
  //     owner_id: tokenInfo.owner_id,
  //     expiry_iso: tokenInfo.expiry ? new Date(tokenInfo.expiry).toISOString() : null,
  //     expires_in_sec: Math.round(_msFromNow / 1000),
  //     is_expired: _msFromNow <= 0
  //   })
  // }

  if (isExpired(tokenInfo)) {
    // if (tokenInfo && !tokenInfo.logged_in) {
    //   console.warn('🟣🟣🟣 OFFLINE-TOKEN EXPIRED — rejecting request', {
    //     app_token: tokenInfo.app_token ? tokenInfo.app_token.substring(0, 10) + '...' : null,
    //     app_name: tokenInfo.app_name,
    //     expiry_iso: tokenInfo.expiry ? new Date(tokenInfo.expiry).toISOString() : null,
    //     expired_ago_sec: Math.round((Date.now() - (tokenInfo.expiry || 0)) / 1000)
    //   })
    // }
    console.warn('⚠️ Token is expired wthout any recent visits (c)', { tokenInfo })
    const err = new Error('Token is expired')
    err.code = 'expired'
    throw err
  }

  // Session binding: only validate for browser tokens (oauth tokens skip this)
  if (tokenInfo.token_type === 'browser' && session?.logged_in_user_id) {
    const deviceCode = session.device_code
    const sessionUserId = session.logged_in_user_id
    
    if (!sessionUserId || (!deviceCode && process.env.FREEZR_TEST_MODE !== 'true')) {
      const error = new Error('no user or deviceCode for getOrSetAppTokenForLoggedInUser (1)')
      throw error
    }
    if (tokenInfo.requestor_id !== sessionUserId || tokenInfo.user_device !== deviceCode) {
      throw new Error('token mismatch')
    }
  }
  // check app
  return tokenInfo
}

/**
 * Get app token for a logged-in user
 * 
 * @param {Object} tokenDb - Token database instance
 * @param {Object} req - Express request object with session data
 * @returns {Promise<Object>} Token information
 */
export async function getAndCheckCookieTokenForLoggedInUser(tokenDb, session, cookies) {
  // onsole.log('🔑 getAndCheckCookieTokenForLoggedInUser called')
  // Note - the session determines expiry timing so logged in users' tokens can be extended if the user is logged in
  
  if (!session) {
    console.error('🔑 no session for getCheckAndExtendCookieTokenForLoggedInUser', { session })
    const error = new Error('no session present in request - must be loggedout')
    throw error
  }
  
  const deviceCode = session.device_code
  const userId = session.logged_in_user_id
  
  if (!userId || !deviceCode) {
    console.error('🔑 no user or deviceCode for getOrSetAppTokenForLoggedInUser', { userId, deviceCode, session })
    const error = new Error('no user or deviceCode for getOrSetAppTokenForLoggedInUser (2)')
    throw error
  }
    
  const existingCookieToken = cookies ? cookies['app_token_' + userId] : null

  let tokenInfo = null
  // Check existing cookie token
  // if (existingCookieToken &&
  //   tokenDb.cache &&
  //   tokenDb.cache.byToken &&
  //   tokenDb.cache.byToken[existingCookieToken]) {
  //     tokenInfo = tokenDb.cache.byToken[existingCookieToken]
  // } else { // or get from the database
    const results = await tokenDb.query({ app_token: existingCookieToken })
    if (results && results.length > 0) {
      // onsole.log('🔑 getAndCheckCookieTokenForLoggedInUser - got token info from database', { existingCookieToken, results } )
      tokenInfo = results[0]
      // if (!tokenDb.cache) tokenDb.cache = {}
      // if (!tokenDb.cache.byToken) tokenDb.cache.byToken = {}
      // tokenDb.cache.byToken[tokenInfo.app_token] = tokenInfo
    } 
  // }

  if (!tokenInfo) {
    // onsole.warn('⚠️ No existing token found for cookie token', { existingCookieToken })
    throw new Error('Could Not auth credentials')
  }
  
  if (tokenInfo.token_type !== 'browser'
    || tokenInfo.requestor_id !== userId
    // || (!appName || tokenDb.cache.byToken[existingCookieToken].app_name === appName)
    || tokenInfo.user_device !== deviceCode) {
      console.warn('⚠️ Serious token mismatch error for cookie token', { existingCookieToken, tokenInfo, userId, deviceCode })
      throw new Error('Could Not match credentials')
  } 

  if (isExpired(tokenInfo)) {
    console.warn('⚠️ Token is expired wthout any recent visits (h)', { tokenInfo })
    const err = new Error('Token is expired')
    err.code = 'expired'
    throw err
  } 
  // if (isCloseToExpiry(tokenInfo)) {
    // Should use a different function to extend the token
  //} 
  // onsole.log('🔍 getAndCheckCookieTokenForLoggedInUser - returning tokenInfo', { tokenInfo })
  return tokenInfo
}

export async function OLDOLDgetCheckAndExtendAppTokenFromheader(tokenDb, appName, session, headers, cookies, fromGetOrSet = false) {
  // onsole.log('🔑 OLDOLDgetCheckAndExtendAppTokenFromheader called')
  //, cookies, fromGetOrSet = false
  
  try {
    const deviceCode = session.device_code
    const userId = session.logged_in_user_id
    
    
    if (!userId || !deviceCode) {
      // console.error('🔑 no user or deviceCode for getOrSetAppTokenForLoggedInUser', { userId, deviceCode })
      const error = new Error('no user or deviceCode for getOrSetAppTokenForLoggedInUser (3)')
      throw error
    }
    
    const existingHeaderToken = getAppTokenFromHeader(headers)
    const existingCookieToken = cookies ? cookies['app_token_' + userId] : null

    // onsole.log('🔑 Existing header token:', existingHeaderToken)
    // onsole.log('🔑 Existing cookie token:', existingCookieToken)
    
    // Should NOT have both - funciton mostly with existingHeaderToken, except when  getOrSetAppTokenForLoggedInUser calls on it
    if (existingHeaderToken && existingCookieToken) {
      console.warn('⚠️ existingHeaderToken and existingCookieToken both found - should this happen?? - SNBH??')
      if (existingHeaderToken !== existingCookieToken) {
        const possiblerror = new Error('existingHeaderToken and existingCookieToken inconsistent - TBD if this is an error')
        throw possiblerror
      }
    }
    if (!existingHeaderToken && !fromGetOrSet) throw new Error('OLDOLDgetCheckAndExtendAppTokenFromheader no longer using existingCookieToken')


    const expiredTokenError = (token) => {
      const error = new Error('token is expired')
      error.code = 'expired'
      error.tokenInfo = token
      return error
    }
    const returnTokenOrThrowOnExpired = (tokenInfo) => {
      if (isExpired(tokenInfo)) {
        // onsole.log('🔑 Token is expired:', tokenInfo)
        throw expiredTokenError(tokenInfo)
      } else {
        return tokenInfo
      }
    }

    // if (existingHeaderToken &&
    //   // (!existingCookieToken || existingHeaderToken !== existingCookieToken) &&
    //   tokenDb.cache &&
    //   tokenDb.cache.byToken &&
    //   tokenDb.cache.byToken[existingHeaderToken] &&
    //   tokenDb.cache.byToken[existingHeaderToken].logged_in &&
    //   tokenDb.cache.byToken[existingHeaderToken].requestor_id === userId &&
    //   (!appName || tokenDb.cache.byToken[existingHeaderToken].app_name === appName) &&
    //   tokenDb.cache.byToken[existingHeaderToken].user_device === deviceCode) {
    //     return returnTokenOrThrowOnExpired(tokenDb.cache.byToken[existingHeaderToken])
    // }
    
    // // Check existing cookie token
    // if (existingCookieToken &&
    //   tokenDb.cache &&
    //   tokenDb.cache.byToken &&
    //   tokenDb.cache.byToken[existingCookieToken] &&
    //   tokenDb.cache.byToken[existingCookieToken].logged_in &&
    //   tokenDb.cache.byToken[existingCookieToken].requestor_id === userId &&
    //   (!appName || tokenDb.cache.byToken[existingCookieToken].app_name === appName) &&
    //   tokenDb.cache.byToken[existingCookieToken].user_device === deviceCode) {
    //     return returnTokenOrThrowOnExpired(tokenDb.cache.byToken[existingCookieToken])
    // }
    
    // Check cache by owner/device/app
    // if (appName && tokenDb.cache &&
    //   tokenDb.cache.byOwnerDeviceApp &&
    //   tokenDb.cache.byOwnerDeviceApp[userId] &&
    //   tokenDb.cache.byOwnerDeviceApp[userId][deviceCode] &&
    //   tokenDb.cache.byOwnerDeviceApp[userId][deviceCode][appName] &&
    //   tokenDb.cache.byOwnerDeviceApp[userId][deviceCode][appName].logged_in) {
    //   // TODO-modernization - review - If it doesnt happen then we should get rid of it
    //   console.warn('⚠️  Using cached token by owner/device/app - no existingCookieToken? - WHY IS THIS HAPPENING? - If it doesnt happen then we should get rid of it')
    //   return returnTokenOrThrowOnExpired(tokenDb.cache.byOwnerDeviceApp[userId][deviceCode][appName])
    // }
    
    // Query database for existing token 
    try {
      const results = await tokenDb.query({ app_token: existingHeaderToken || existingCookieToken })
      /*
      requestor_id: userId, 
      user_device: deviceCode, 
      app_name: appName
      */
      // Check if existing token is still valid
      if (results && results.length > 0) {
        if (!results[0].logged_in) {
          console.warn('⚠️ Token is not logged in - TBD if this is an error - SNBH?? ', { appName, userId, deviceCode })
        } 
        const storedToken = results[0]

        if (storedToken.requestor_id !== userId || storedToken.user_device !== deviceCode || (appName && storedToken.app_name !== appName)) {
          console.warn('❌ Token mismatch - TBD if this is really an error ', { appName, userId, deviceCode, storedToken })
          throw new Error(' token mismatch')
        } else if (!appName) {
          appName = storedToken.app_name
        }

        // Update cache
        // if (!tokenDb.cache.byToken) tokenDb.cache.byToken = {}
        // tokenDb.cache.byToken[storedToken.app_token] = storedToken
        
        // if (!tokenDb.cache.byOwnerDeviceApp) tokenDb.cache.byOwnerDeviceApp = {}
        // if (!tokenDb.cache.byOwnerDeviceApp[userId]) tokenDb.cache.byOwnerDeviceApp[userId] = {}
        // if (!tokenDb.cache.byOwnerDeviceApp[userId][deviceCode]) tokenDb.cache.byOwnerDeviceApp[userId][deviceCode] = {}
        // if (!tokenDb.cache.byOwnerDeviceApp[userId][deviceCode][appName]) tokenDb.cache.byOwnerDeviceApp[userId][deviceCode][appName] = {}
        // tokenDb.cache.byOwnerDeviceApp[userId][deviceCode][appName] = storedToken
        
        return returnTokenOrThrowOnExpired(storedToken)
      } else {
        console.warn('⚠️ No existing token found')
      }
            
    } catch (error) {
      console.error('🔑 Database operation error:', error)
      throw error
    }
  } catch (error) {
    console.error('🔑 Token handler error 2:', error)
    throw error
  }
}

/**
 * Get app token from request header
 * @private
 */
function getAppTokenFromHeader(headers) {
  // Handle case where headers might not exist (e.g., mock requests)
  if (!headers) {
    return null
  }
  
  const authHeader = headers.authorization
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7)
  }
  return null
}

// Note generateAndSaveAppPasswordForUser is called from accounts/// passwordService.mjs

export default {
  generateAppToken,
  getOrSetAppTokenForLoggedInUser
}
