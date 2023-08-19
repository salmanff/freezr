// visit_logger.js
// freezr.info - nodejs system files - logger.js

/* TO DO
  - cleanUpLoggedInLogVisits should be triggered at a regular time very 24 hours
      - also - this does not scale if user numbers are very large - ie does it make sense to keep logs of every user?
  - cleabup of errs should record timeoutvar and clear it too
  - Need to record user app pages served from app (eg from poster)
  - 34344main consts should be diriven by freezrPref page
  - keep a whitelist based on an 'app' that user can upload defining a function -> only for main admin user
  - are there better ways of keeping track of non logged in visitors to ppages (and also check if any other urls's dont pass through accesshandler)
    - also need to make sure this works with outside validated users (ie where req.session.logged_in_user doesnt exist - may be req.session.validateduser)
*/
/*
  visitLogs: {
    authFailure[accessPt] // accessPt can be login, appTokenLogin, token, tokenExipre, accessToken
      .list: list of unsaved failed logins
      .savedList: those that have been saved to db - kept here for continutity when checking #attempts

}
*/

const helpers = require('./helpers.js')
const async = require('async')

exports.version = '0.0.122'

const MAX_LOGIN_ATTEMPTS_BEFORE_FREEZE = 100
const MAX_LOGIN_ATTEMPTS_BEFORE_SAVE = 100
const MAX_LOGIN_ATTEMPTS_PER_IP_ADDRESS = 5
const FREEZE_ATTEMPT_WINDOW = 1000 * 60 * 60 // 60 minutes
const TIME_TO_UNFREEZE = 1000 * 60 * 60 // 60 minutes
const MAX_TIME_BEFORE_SAVE = 1000 * 60 * 60 * 24 // 1 day
const AUTH_FAILURE_AOC = {
  app_table: 'info_freezr_admin_visitAuthFailures',
  app_name: 'info.freezr.admin',
  owner: 'fradmin'
}
const LOGGEDIN_LOG_VIST_AOC = {
  app_table: 'info_freezr_admin_visitLogs',
  app_name: 'info.freezr.admin',
  owner: 'fradmin'
}
const timers = {
  visits: { lastSave: null, timout: null, saveWip: false },
  auths: {}
}

exports.tooManyFailedAuthAttempts = function (visitLogs, req, accessPt) {
  if (!visitLogs.authFailure) visitLogs.authFailure = {}
  if (!visitLogs.authFailure[accessPt]) visitLogs.authFailure[accessPt] = {}
  if (!visitLogs.authFailure[accessPt].list) visitLogs.authFailure[accessPt].list = []
  if (!visitLogs.authFailure[accessPt].savedList) visitLogs.authFailure[accessPt].savedList = []

  // unfreeze if TIME_TO_UNFREEZE has passed
  if (visitLogs.authFailure[accessPt].wasFrozen && (visitLogs.authFailure[accessPt].wasFrozen + TIME_TO_UNFREEZE < new Date().getTime())) visitLogs.authFailure[accessPt].wasFrozen = null

  const visitorIp = getClientAddress(req)

  fdlog('tooManyFailedAuthAttempts visitlog length is now ', visitLogs.authFailure[accessPt], ' list len ', visitLogs.authFailure[accessPt].list.length, ' last  item  ', visitLogs.authFailure[accessPt].list[visitLogs.authFailure[accessPt].list.length - 1])
  const fullList = visitLogs.authFailure[accessPt].savedList.concat(visitLogs.authFailure[accessPt].list)
  if (ipIsWhiteListed(visitorIp)) {
    return false
  } else if (visitLogs.authFailure[accessPt].wasFrozen) { // already frozen
    return true
  } else if (fullList.length > 0) {
    let ttlLen = 0
    let ipLen = 0
    for (let i = fullList.length-1; i >= 0; i--) {
      if (fullList[i].date + FREEZE_ATTEMPT_WINDOW < new Date().getTime()) { // time has passed - break
        break
      } else {
        ttlLen++
        if (fullList[i].ipaddress == visitorIp) ipLen++
      }
    }
    fdlog('tooManyFailedAuthAttempts: ', { ttlLen, ipLen })
    if ((accessPt === 'login' || accessPt === 'appLogin') && ttlLen > MAX_LOGIN_ATTEMPTS_BEFORE_FREEZE) {
      visitLogs[accessPt].wasFrozen = new Date().getTime()
      return true
    }
    if (ipLen > MAX_LOGIN_ATTEMPTS_PER_IP_ADDRESS) return true
    return false
  } else {
    return false
  }
}
exports.addNewFailedAuthAttempt = function (dsManager, req, options) {
  const visitLogs = dsManager.visitLogs
  if (!options || !options.accessPt) console.error('need to have accessPt when registering failure')
  const accessPt = options?.accessPt || 'unknown'
  if (!visitLogs.authFailure) visitLogs.authFailure = {}
  if (!visitLogs.authFailure[accessPt]) visitLogs.authFailure[accessPt] = {}
  if (!visitLogs.authFailure[accessPt].list) visitLogs.authFailure[accessPt].list = []
  visitLogs.authFailure[accessPt].list.push(failedAuthRecord(req, options))
  fdlog('added to list visitlog length is now ', visitLogs.authFailure[accessPt].list.length)
  setTimeout(() => {
    cleanUpVisitAuthFailures(dsManager, { accessPt })
  }, 5)
  return false
}

exports.recordLoggedInVisit = function (dsManager, req, options) {
  const visitLogs = dsManager.visitLogs
  const userId = req.session?.logged_in_user_id || options?.userId || 'unknown'
  const visitType = options?.visitType || 'unknown'
  const path = req.originalUrl.split('?').shift().replace(/\./g, '_')
  if (!visitLogs.loggedInUsers) visitLogs.loggedInUsers = {}
  if (!visitLogs.loggedInUsers[userId]) visitLogs.loggedInUsers[userId] = { paths: {}, pages: {}, files: {}, apis: {}, unknown: {} }
  if (!visitLogs.loggedInUsers[userId].paths[path]) visitLogs.loggedInUsers[userId].paths[path] = 0
  visitLogs.loggedInUsers[userId].paths[path]++
  const appName = req.freezrTokenInfo?.app_name || req.params.app_name || 'unknown' // also req.freezrAttributes?.requestor_app || req.params.app_table   
  // todo 2023 - make this mroe sophisticated with requestor and requestee apps etc??
  if (!visitLogs.loggedInUsers[userId][visitType][appName]) visitLogs.loggedInUsers[userId][visitType][appName] = 0
  if (!visitLogs.loggedInUsers[userId][visitType][appName]) visitLogs.loggedInUsers[userId][visitType][appName] = 0
  visitLogs.loggedInUsers[userId][visitType][appName]++
  if (userId !== req.freezrTokenInfo?.owner_id) {
    const ownerId = req.freezrTokenInfo?.owner_id
    if (!visitLogs.loggedInUsers[ownerId]) visitLogs.loggedInUsers[ownerId] = { paths: {}, pages: {}, files: {}, apis: {}, unknown: {}}
    if (!visitLogs.loggedInUsers[ownerId].paths[path]) visitLogs.loggedInUsers[ownerId].paths[path] = 0
    visitLogs.loggedInUsers[ownerId].paths[path]++
    if (!visitLogs.loggedInUsers[ownerId][visitType][appName]) visitLogs.loggedInUsers[ownerId][visitType][appName] = 0
    visitLogs.loggedInUsers[ownerId][visitType][appName]++
  }
  fdlog('recordLoggedInVisit ' + appName + ' fot ' + req.originalUrl + ': visitType ' + visitType + ' req.freezrTokenInfo' + req.freezrTokenInfo + '  req.params.app_name ' + req.params.app_name)

  setTimeout(() => {
    cleanUpLoggedInLogVisits(dsManager)
  }, 5)
  return false
}

const ipIsWhiteListed = function(visitorIp) {
  // todo 
  return false
}
const cleanUpVisitAuthFailures = function (dsManager, options) {
  // remove old samed ones if most recent is >
  const accessPt = options?.accessPt || 'unknown'
  const fails = dsManager.visitLogs.authFailure[accessPt]
  const now = new Date().getTime()
  if (!options) options = { forceSave: false }
  if (options.forceSave || fails.list.length > MAX_LOGIN_ATTEMPTS_BEFORE_SAVE || (fails.list.length > 0 && fails.list[0].date + MAX_TIME_BEFORE_SAVE < now)) {
    const itemToSave = {
      date: now,
      accessPt,
      list: fails.list
    }
    dsManager.getorInitDb(AUTH_FAILURE_AOC, {}, function (err, logDb) {
      if (err) {
        console.error('error getting log_aoc to record logs')
      } else {
        logDb.create(null, itemToSave, null, function (err) {
          if (err) {
            console.error('error writing logs to log_aoc')
          } else {
            if (!fails.savedList) fails.savedList = []
            fails.savedList = fails.savedList.concat(JSON.parse(JSON.stringify(fails.list)))
            fails.list = []
            let sliceFromHere = 0
            for (let i = fails.savedList.length-1; i >= 0; i--) {
              if (fails.savedList[i].date + FREEZE_ATTEMPT_WINDOW <  now) {
                sliceFromHere = i
                break
              }
            }
            if (sliceFromHere) fails.savedList = fails.savedList.slice(sliceFromHere)
          }
        })
      }
    })
  }
}
const cleanUpLoggedInLogVisits = function (dsManager, options) {
  // todo 2023 -> save user data on theor db.. and give them right to delete and hold highlevel data (non app specific?) at fradmin
  if (!timers.visits.lastSave) timers.visits.lastSave = new Date().getTime()
  if (!timers.visits.saveWip && (options?.forceSave || timers.visits.lastSave + MAX_TIME_BEFORE_SAVE < new Date().getTime())) {
    timers.visits.saveWip = true
    dsManager.getorInitDb(LOGGEDIN_LOG_VIST_AOC, {}, function (err, logDb) {
      if (err) {
        console.error('Error getting LOGGEDIN_LOG_VIST_AOC to record logs', err)
      } else {
        const userList = []
        for (const [userId] of Object.entries(dsManager.visitLogs.loggedInUsers)) {
          userList.push(userId) //  = helpers.addToListAsUnique(userList, userId)
        }
        async.forEach(userList, function (userId, cb) {
          const itemToSave = {
            date: new Date().getTime(),
            userId,
            paths: dsManager.visitLogs.loggedInUsers[userId].paths,
            pages: dsManager.visitLogs.loggedInUsers[userId].pages,
            files: dsManager.visitLogs.loggedInUsers[userId].files,
            apis: dsManager.visitLogs.loggedInUsers[userId].apis,
            unknown: dsManager.visitLogs.loggedInUsers[userId].unknown
          }
          if (helpers.isEmpty(itemToSave.visits)) {
            cb(null)
          } else {
            logDb.create(null, itemToSave, null, function (err, results) {
              if (!err) { dsManager.visitLogs.loggedInUsers[userId] = {} }
              cb(err)
            })
          }
        }, function (err) {
          timers.visits.lastSave = new Date().getTime()
          timers.visits.saveWip = false
          if (err) console.error('error saving in loggedinvisit ', { err})
        })
      } 
    })
  } 
}

const failedAuthRecord = function (req, options) {
  const rec = {
    ipaddress: getClientAddress(req),
    date: new Date().getTime(),
    userId: options?.userId || req.session.logged_in_user_id || req.body?.user_id,
    accessPt: options?.accessPt,
    source: options?.source
  }
  return rec
}

function getClientAddress (request) {
  return request.headers['x-forwarded-for']?.split(',').shift() ||
    request.socket?.remoteAddress ||
    'unknown'
}

// UNUSED
function timestamp () {
	// todo Add in preferred time zone adjustment before stamping
	return new Date().toISOString()
}
function dateString (time) {
	// todo Add in preferred time zone adjustment before stamping
	var date = time? new Date(time) : new Date()
	return date.toISOString().split('T')[0]
}
function isSysFile(url) {
  return FREEZR_SYS_FILES.indexOf(url)>-1
}
const FREEZR_SYS_FILES = ['/app_files/public/info.freezr.public/freezr_style.css', '/app_files/public/info.freezr.public/freezr_core.css', '/app_files/public/info.freezr.public/freezr_core.js', '/app_files/public/info.freezr.public/public/static/freezr_texture.png', '/app_files/public/info.freezr.public/static/freezer_log_top.png', '/favicon.ico']
function getExternalReferer (req) {
  if (!req.header('Referer')) return null;
  //onsole.log("ref "+req.header('Referer'));
  if (!helpers.startsWith(req.header('Referer'), (req.protocol + '://' + req.hostname) ) ) {
    return req.header('Referer')
  } else {
    return null
  }
}

// err Loggers
const LOG_ERRORS = true
const felog = function (...args) { if (LOG_ERRORS) helpers.warning('app_handler.js', exports.version, ...args) }
const LOG_DEBUGS = false
const fdlog = function (...args) { if (LOG_DEBUGS) console.log(...args) }
