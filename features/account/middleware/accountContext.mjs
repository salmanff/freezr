// freezr.info - Modern ES6 Module - Account Logged In User Page Middleware
// Middleware for handling authenticated user page requests
//
// Architecture Pattern:
// - Two separate functions: one for auth/token validation, one for appFS setup
// - Modern version puts data in res.locals (not req parameters)
// - Replicates legacy loggedInUserPage and addAppFs functionality

import { 
  isSystemApp,
  APP_TOKEN_OAC,
  USER_DB_OAC,
  PUBLIC_MANIFESTS_OAC,
  userPERMS_OAC,
  userContactsOAC,
  userGroupsOAC,
  PRIVATE_FEED_OAC,
  messagesSentOAC,
  messagesGotOAC
} from '../../../common/helpers/config.mjs'
import { sendFailure } from '../../../adapters/http/responses.mjs'
import { createBaseFreezrContextForResLocals } from '../../../common/helpers/context.mjs'

/**
 * Middleware to add user apps and permissions DBs (replicates addAppFs)
 * Gets appFS and puts it in res.locals (modern approach)
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @returns {Function} Express middleware function
 */
export const createAddUserDSAndAppFS = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
    // onsole.log('📁 addUserAppsAndPermDBs middleware called')
    
    try {
      if (!freezrPrefs) throw new Error('‼️❌‼️ no freezrPrefs in createAddUserDSAndAppFS')
      const owner = req.session.logged_in_user_id
      if (!owner && req.params.user_id) {
        // nb Previously this was owner = req.params.user_id || req.session.logged_in_user_id 
        // consider adding a test
        throw new Error('User ID is in params - need to finalise this in mdoernization after udnerstanding context of why it is being done like this')
      }
      const appName = req.params.app_name
      if (!appName) {
        // instrad of throwing an error, just skip the appFS setup so correct errors are sent based on route
        next()
      } else {
      
        // onsole.log('📁 Getting appFS for:', { owner, appName })
        
        // Get userDS
        const userDS = await dsManager.getOrSetUserDS(owner, { freezrPrefs })
        
        // Get appFS (system apps use fradmin's DS)
        const theDs = isSystemApp(appName) 
          ? dsManager.users.fradmin 
          : userDS

        const appFS = await theDs.getorInitAppFS(appName, {})
        
        // onsole.log('accountLoggedInUserPage - appFS', { owner, appName, appFS})

        // Preserve existing res.locals.freezr if it exists (e.g., tokenInfo from tokenGuard)
        const existingFreezr = res.locals.freezr || {}
        
        res.locals.freezr = {
          ...createBaseFreezrContextForResLocals(req, dsManager, freezrPrefs, freezrStatus),
          ...existingFreezr, // Preserve existing properties (like tokenInfo)
          appFS,
          userDS
        }
        
        //onsole.log('✅ AppFS set up in res.locals.freezr, proceeding to next middleware')
        next()
      }
      
    } catch (error) {
      if (error.message === 'user incomplete') {
        return res.redirect('/register/newparams?error=user_incomplete')
      }
      console.error('❌ Error in addUserAppsAndPermDBs middleware:', error)
      sendFailure(res, error, 'createAddUserDSAndAppFS', 500)
      //   res.redirect('/account/login?redirect=internalError')
    }
  }
}

/**
 * Middleware to add app token database (replicates addAppTokenDB)
 * Gets token DB and puts it in res.locals (modern approach)
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @returns {Function} Express middleware function
 */
export const createAddTokenDb = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
    // onsole.log('🔑 addTokenDb middleware called')
    
    try {
      // Add app token DB (for password generation)
      const appTokenDb = await dsManager.getorInitDb(APP_TOKEN_OAC, { freezrPrefs })

      // Preserve existing res.locals.freezr if it exists
      const existingFreezr = res.locals.freezr || {}
      
      res.locals.freezr = {
        ...createBaseFreezrContextForResLocals(req, dsManager, freezrPrefs, freezrStatus),
        ...existingFreezr, // Preserve existing properties
        appTokenDb
      }
      
      // onsole.log('✅ App token DB set up in res.locals.freezr, proceeding to next middleware')
      next()
      
    } catch (error) {
      console.error('❌ Error in addTokenDb middleware:', error)
      res.status(500).json({ error: 'Could not access app token database' })
    }
  }
}

/**
 * Middleware to add all users database (replicates addAllUsersDb)
 * Gets the users database and puts it in res.locals (modern approach)
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @returns {Function} Express middleware function
 */
export const createAddAllUsersDb = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
    // onsole.log('👥 addAllUsersDb middleware called')
    
    try {
      // Get all users database (fradmin's users collection)
      const allUsersDb = dsManager.getDB(USER_DB_OAC)

      if (!allUsersDb || !allUsersDb.query) {
        console.error('❌ Could not get allUsersDb')
        return res.status(500).json({ error: 'Could not access users database' })
      }

      // Preserve existing res.locals.freezr if it exists
      const existingFreezr = res.locals.freezr || {}
      
      res.locals.freezr = {
        ...createBaseFreezrContextForResLocals(req, dsManager, freezrPrefs, freezrStatus),
        ...existingFreezr, // Preserve existing properties
        allUsersDb
      }
      
      // onsole.log('✅ All users DB set up in res.locals.freezr, proceeding to next middleware')
      next()
      
    } catch (error) {
      console.error('❌ Error in addAllUsersDb middleware:', error)
      sendFailure(res, error, 'addAllUsersDb', 500)
      // res.status(500).json({ error: 'Could not access users database' })
    }
  }
}

/**
 * Middleware to add public manifests database
 * Gets the public manifests database and puts it in res.locals (modern approach)
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @returns {Function} Express middleware function
 */
export const createAddPublicManifestsDb = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
    // onsole.log('📋 addPublicManifestsDb middleware called')
    
    try {
      // Get public manifests database (fradmin's public_manifests collection)
      const publicManifestsDb = await dsManager.getorInitDb(PUBLIC_MANIFESTS_OAC, { freezrPrefs })

      if (!publicManifestsDb) {
        console.error('❌ Could not get publicManifestsDb')
        return sendFailure(res, error, 'addPublicManifestsDb', 500)
      }
            
      res.locals.freezr.publicManifestsDb = publicManifestsDb
      
      // onsole.log('✅ Public manifests DB set up in res.locals.freezr, proceeding to next middleware')
      next()
      
    } catch (error) {
      console.error('❌ Error in addPublicManifestsDb middleware:', error)
      sendFailure(res, error, 'addPublicManifestsDb', 500)
    }
  }
}

/**
 * Middleware to add user messages database
 * Gets user contacts database and puts it in res.locals (modern approach)
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @returns {Function} Express middleware function
 */
export const createAddMessageDb = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
    // onsole.log('📋 addMessageDb middleware called')
    
    try {
      const userId = res.locals.freezr?.tokenInfo?.requestor_id
      if (!userId) {
        return sendFailure(res, 'User not logged in', 'addUserContactsDb', 401)
      }
      // Get user contacts database
      const userMessagesSentDb = await dsManager.getorInitDb(messagesSentOAC(userId), { freezrPrefs })
      if (!userMessagesSentDb) {
        console.error('❌ Could not get userMessagesSentDb')
        return sendFailure(res, 'Could not get userMessagesSentDb', 'addUserMessagesSentDb', 500)
      }
      
      res.locals.freezr.userMessagesSentDb = userMessagesSentDb

      const userMessagesGotDb = await dsManager.getorInitDb(messagesGotOAC(userId), { freezrPrefs })
      if (!userMessagesGotDb) {
        console.error('❌ Could not get userMessagesGotDb')
        return sendFailure(res, 'Could not get userMessagesGotDb', 'addUserMessagesGotDb', 500)
      }
      
      res.locals.freezr.userMessagesGotDb = userMessagesGotDb

      const { gotMessageDbs, contactsDBs, simpleRecipients, badContacts } = await getGotMessagesAndContactsForRecipients(
        dsManager, 
        req.body, 
        res.locals.freezr.userGroupsDb, 
        freezrPrefs
      )
      
      res.locals.freezr.freezrOtherPersonGotMsgs = gotMessageDbs
      res.locals.freezr.freezrOtherPersonContacts = contactsDBs
      res.locals.freezr.freezrMessageRecipients = simpleRecipients
      res.locals.freezr.freezrBadContacts = badContacts
      
      // onsole.log('✅ User messages DB set up in res.locals.freezr, proceeding to next middleware')
      next()
    } catch (error) {
      console.error('❌ Error in addMessageDb middleware:', error)
      sendFailure(res, error, 'addMessageDb', 500)
    }
  }
}

const getGotMessagesAndContactsForRecipients = async function (dsManager, body, userGroupsDb, freezrPrefs) {
  // onsole.log('getGotMessagesAndContactsFor', { body, userGroupsDb })
  
  const nowGetDBs = async function (dsManager, body, recipients) {
    const gotMessageDbs = {}
    const contactsDBs = {}
    const badContacts = []
    const simpleRecipients = []
    
    for (const recipient of recipients) {
      if (typeof recipient === 'string') {
        console.warn('currently only handling objects of receipients')
        badContacts.push({ recipient_id: recipient, err: 'Object expected and got string' })
      } else if (!recipient.recipient_id) {
        badContacts.push({ recipient_host: recipient.recipient_host, err: 'no recipient_id' })
      } else {
        // const parts = member.split('@')
        // const owner = parts[0]
        // const serverurl = parts > 1 ? parts[1] : null
        simpleRecipients.push({ recipient_id: recipient.recipient_id, recipient_host: recipient.recipient_host })

        if (!recipient.recipient_host || recipient.recipient_host === body.sender_host) {
          try {
            const gotMessages = await dsManager.getorInitDb(
              { app_table: 'dev.ceps.messages.got', owner: recipient.recipient_id }, 
              { freezrPrefs }
            )
            gotMessageDbs[recipient.recipient_id] = gotMessages
            
            try {
              const contactsDB = await dsManager.getorInitDb(
                { app_table: 'dev.ceps.contacts', owner: recipient.recipient_id }, 
                { freezrPrefs }
              )
              contactsDBs[recipient.recipient_id] = contactsDB
            } catch (err) {
              badContacts.push({ 
                recipient_id: recipient.recipient_id, 
                err: (err?.message || 'unknown err getting contact db') 
              })
            }
          } catch (err) {
            badContacts.push({ 
              recipient_id: recipient.recipient_id, 
              err: (err?.message || 'unknown err getting contact messages') 
            })
          }
        }
      }
    }
    
    return { gotMessageDbs, contactsDBs, simpleRecipients, badContacts }
  }

  if (body.recipient_id) {
    // const groupMembers = [(body.recipient_id + (body.recipient_host ? ('@' + body.recipient_host) : ''))]
    const groupMembers = [{ recipient_id: body.recipient_id, recipient_host: body.recipient_host }]
    return await nowGetDBs(dsManager, body, groupMembers)
  } else if (body.recipients) {
    return await nowGetDBs(dsManager, body, body.recipients)
  // } else if (body.group_members) {
  //   return await nowGetDBs(dsManager, body, body.group_members)
  } else if (body.group_name && typeof body.group_name === 'string') {
    // Convert query callback to promise
    const groups = await userGroupsDb.query({ name: body.group_name }, null)
    
    if (!groups || groups.length < 1) {
      throw new Error('No groups found')
    }
    
    if (groups.length > 1) { 
      console.warn('snbh - found 2 groups of same name') 
    }
    
    return await nowGetDBs(dsManager, body, groups[0].members)
  } else {
    throw new Error('Wrong member parameters')
  }
}

/**
 * Middleware to add user contacts database
 * Gets user contacts database and puts it in res.locals (modern approach)
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @returns {Function} Express middleware function
 */
export const createAddUserContactsDb = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
    // onsole.log('📋 addUserContactsDb middleware called')
    
    try {
      const userId = res.locals.freezr?.tokenInfo?.requestor_id
      if (!userId) {
        return sendFailure(res, 'User not logged in', 'addUserContactsDb', 401)
      }
      // Get user contacts database
      const userContactsDb = await dsManager.getorInitDb(userContactsOAC(userId), { freezrPrefs })
      if (!userContactsDb) {
        console.error('❌ Could not get userContactsDb')
        return sendFailure(res, error, 'addUserContactsDb', 500)
      }
      
      res.locals.freezr.userContactsDb = userContactsDb

      const userGroupsDb = await dsManager.getorInitDb(userGroupsOAC(userId), { freezrPrefs })
      if (!userGroupsDb) {
        console.error('❌ Could not get userGroupsDb')
        return sendFailure(res, error, 'addUserContactsDb', 500)
      }
      
      res.locals.freezr.userGroupsDb = userGroupsDb
      
      const privateFeedDb = await dsManager.getorInitDb(PRIVATE_FEED_OAC, { freezrPrefs })
      if (!privateFeedDb) {
        console.error('❌ Could not get privateFeedDb')
        return sendFailure(res, error, 'addUserContactsDb', 500)
      }
      
      res.locals.freezr.privateFeedDb = privateFeedDb

      // onsole.log('✅ User contacts DB set up in res.locals.freezr, proceeding to next middleware')
      next()
      
    } catch (error) {
      console.error('❌ Error in addUserContactsDb middleware:', error)
      sendFailure(res, error, 'addUserContactsDb', 500)
    }
  }
}

/**
 * Middleware to add log manager
 * Gets log manager and puts it in res.locals (modern approach)
 * 
 * @param {Object} dsManager - Data store manager
 * @returns {Function} Express middleware function
 */
export const createAddLogManager = (logManager) => {
  return async (req, res, next) => {
    if (req.params.getAction === 'getlogs') {
      res.locals.freezr.logManager = logManager
    }
    next()
  }
} 

/**
 * Middleware to add system app filesystem
 * Gets system app filesystem and puts it in res.locals (modern approach)
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @param {Object} freezrStatus - Freezr status
 * @returns {Function} Express middleware function
 */
export const createAddSystemAppFS = (dsManager, freezrPrefs, freezrStatus) => {
  return async (req, res, next) => {
    if (!res.locals.freezr) {
      res.locals.freezr = {}
    }
    const userDS = await dsManager.getOrSetUserDS('public', { freezrPrefs })
    const appName = 'info.freezr.' + req.originalUrl.split('/')[1]
    console.log('createAddSystemAppFS - appName', appName)
    if (userDS && userDS.getorInitAppFS) {
      const appFS = await userDS.getorInitAppFS(appName, {})
      res.locals.freezr.appFS = appFS
    }
    next()
  }
}

export default createAddUserDSAndAppFS
