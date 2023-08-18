// visit_logger.js
// freezr.info - nodejs system files - logger.js

/* TO DO
  - keep list and record to db every once in a while -> eg dg authFailures type: login (or token)
    - keep a whitelist based on an 'app' that user can upload defining a function -> only for main admin user
  - show current and historics in an admin page... and unlock logins ... and use client side APIs
  - keep track of fake tokens
  - keep track of live tokens -> 
    - keep track of loggedin visitors and validatedguests
  - keep track of non logged in visitors to ppages
    - 
*/

var helpers = require('./helpers.js'),
    // db_handler = require("./db_handler.js"),
    async = require('async'),
    file_handler = require('./file_handler.js');

exports.version = '0.0.122'

const MAX_LOGIN_ATTEMPTS_BEFORE_FREEZE = 100
const MAX_LOGINS_BEFORE_SAVE = 1000
const MAX_LOGIN_ATTEMPTS_PER_IP_ADDRESS = 3
const FREEZE_ATTEMPT_WINDOW = 1000 * 60 * 60 // 60 minutes
const TIME_TO_UNFREEZE = 1000 * 60 * 60 // 60 minutes
const MAX_TIME_BEFORE_SAVE = 1000 * 60 * 60 * 24 // 1 day
const LOG_AOC = {
  app_name:'info.freezr.admin',
  collection_name:"visit_logs",
  owner:'fradmin'
}


exports.tooManyLogInAttempts = function (visitLogs, req) {
  if (!visitLogs.failedAttemptTimerStart) visitLogs.failedAttemptTimerStart = new Date().getTime()
	if (!visitLogs.fails) visitLogs.fails = {}
	if (!visitLogs.fails.list) visitLogs.fails.list = []
	if (!visitLogs.fails.savedList) visitLogs.fails.savedList = []
  
  // unfreeze if TIME_TO_UNFREEZE has passed
  if (visitLogs.fails.wasFrozen && (visitLogs.fails.wasFrozen + TIME_TO_UNFREEZE < new Date().getTime()))  visitLogs.fails.wasFrozen = null

  const visitorIp = getClientAddress(req)

  console.log('tooManyLogInAttempts visitlog length is now ', visitLogs.fails, ' list len ', visitLogs.fails.list.length)
  console.log('tooManyLogInAttempts last  item  ', visitLogs.fails.list[visitLogs.fails.list.length - 1])

  const fullList = visitLogs.fails.savedList.concat(visitLogs.fails.list)
  if (visitLogs.fails.wasFrozen ) {
    // todo add white listed IPs
    return true
  } else if (visitLogs.fails.list.length > 0) {
    let ttlLen = 0
    let ipLen = 0
    for (let i = visitLogs.fails.list.length-1; i >= 0; i--) {
      if (visitLogs.fails.list.date < new Date().getTime() - FREEZE_ATTEMPT_WINDOW) {
        console.log('time has passed - break')
        break
      }
      ttLen++
      if (visitLogs.fails.list[i].ipaddress == visitorIp) ipLen++
    }
    if (ttlLen > MAX_LOGIN_ATTEMPTS_BEFORE_FREEZE) {
      visitLogs.fails.wasFrozen = new Date().getTime()
      return true
    }
    if (ipLen > MAX_LOGIN_ATTEMPTS_PER_IP_ADDRESS) return true
    return false
  } else {
    return false
  }
}
exports.addNewFailedLogin = function (dsManager, req, options) {
  const visitLogs = dsManager.visitLogs
	if (!visitLogs.fails) visitLogs.fails = {}
	if (!visitLogs.fails.list) visitLogs.fails.list = []
	visitLogs.fails.list.push(loginrecord(req, options))
	console.log('added to list visitlog length is now ', visitLogs.fails.list.length, loginrecord(req))
	// console.log('logtr from add new ', {visitLogs})
  setTimeout(() => {
    cleanUpVisitLoginFailures(dsManager)
  }, 5);
	return false
}

const cleanUpVisitLoginFailures = function (dsManager, options) {
  // remove old samed ones if most recent is >
  const fails = dsManager.visitLogs.fails
  const now = new Date().getTime()
  if (!options) options = { forceSave: false }
  if (options.forceSave || fails.list.length > MAX_LOGINS_BEFORE_SAVE || (fails.list.length > 0 && fails.list[0].date + MAX_TIME_BEFORE_SAVE < now)) {
    const itemToSave = {
      date: now,
      type: 'failedLogins',
      list: fails.list
    }
    dsManager.getorInitDb(LOG_AOC, {}, function (err, logDb) {
      if (err) {
        console.error('error getting log_aoc to record logs')
      } else {
        logDb.create(null, itemToSave, null, function (err) {
          if (err) {
            console.error('error writing logs to log_aoc')
          } else {
            if (!fails.savedList) fails.savedList = []
            fails.savedList = fails.savedList .concat(JSON.parse(JSON.stringify(fails.list)))
            let cutFromItem = 0
        
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

const loginrecord = function(req, options) {
  const rec = {
    ipaddress: getClientAddress(req),
    date: new Date().getTime(),
    userId: req.body?.user_id
  }
  if (options && options.tooManyLogins) rec.source = 'toomany'
  return rec
}


// OLD VISIT LOGGER
/* TO DO
  // THIS NEEDS TO BE REDONE COMPLETELY

	//  reloadDb at the beginning

	// get rid of "throw errors"...

*/

const MAX_NUM_DETAIL_REFS = 100;
const MAX_NUM_FULL_LOGS_IN_FILE = 100;


var full_file_log = [],
	make_new_file = true,
	last_file_name = null;
var current_date = dateString();
var day_db_log = {};
var saveTimer = null;

const LOGGER_APC = {
  app_name:'info.freezr.admin',
  collection_name:"visit_log_daysum",
  owner:'fradmin'
}

exports.reloadDb = function (env_params, callback) {
	// get the latest from db
	// get the latest file, if any and have the counter
	var today = dateString();
  console.log("visitLogger env_params ccc")
  console.log(env_params)

  db_handler.read_by_id (env_params, LOGGER_APC, today, (err, object) => {
    //onsole.log("visit_logger got today object :",today)
    if (err) {
      console.warn(err)
      helpers.state_error("visit_logger", exports.version, "reloadDb", err, "err_reloading db");
    } else {
          day_db_log[today] = object || {};
    }
    callback(err)
  })
}

exports.record = function(req, env_params, prefs, options={}){
	//onsole.log("RECORD? "+get_app_name(req)+" "+req.originalUrl)
	if (!prefs) console.warn("PREFS NOT DEFINED ********************")
	if (prefs && prefs.log_visits) {

		// init variables
		if (!prefs.log_details) prefs.log_details={}
		options.ipaddress = getClientAddress(req);
		options.app_name = get_app_name(req, options);
		options.exteralRef = get_external_referer(req);

		// ignore system files and app files (unless opted not to)
		if (!isSysFile(req.originalUrl) || prefs.log_details.include_sys_files){
			if (prefs.log_details.log_app_files || !sourceIsFile(options.source)) {
				var full_record = [
					timestamp(),
					req.originalUrl,
					req.session.logged_in_user_id,
					options.ipaddress,
					req.header('Referer'),
					(options.auth_error?"Auth-Err":"")
					];
				full_file_log.push(full_record)
				//onsole.log("full_record")
				//onsole.log(full_record)
				if (full_record.length > MAX_NUM_FULL_LOGS_IN_FILE) {
					write_full_log_file(req, function () {
						addRecordToDailySummary(req, prefs, options);
						clearTimeout(saveTimer);
					});
				} else {
					addRecordToDailySummary(req, prefs, options);
					clearTimeout(saveTimer);
					saveTimer = setTimeout(function(){
						write_full_log_file(req, env_params, function() {saveToDb(env_params)})
					},0.2*60*1000)
				}

			}
		}
	}
}

function write_full_log_file (req, env_params, callback) {
	//onsole.log("goig to write_full_log_file- make_new_file is "+make_new_file)
	var newLogFile = [];
	if (current_date != dateString()) newLogFile.push(full_file_log.pop());
	if (!last_file_name) make_new_file=true;
	if (make_new_file) last_file_name = "full_logs_"+current_date+".json";

  var the_url = (env_params.fsParams.rootFolder || helpers.FREEZR_USER_FILES_DIR) + '/fradmin/files/info.freezr.admin/daily_log_files/' + (new Date().getFullYear())
	file_handler.writeTextToUserFile (
		file_handler.normUrl(the_url),
		last_file_name,
		JSON.stringify({'app':'info,freezr.visit_logger' ,version:exports.version,logs:full_file_log}),
		{doNotOverWrite: make_new_file},
		{},
		"info.freezr.logs",
		req.freezr_environment,
		function(err, written_filename) {
			last_file_name = written_filename;
			make_new_file = false;
			if (err || full_file_log.length > MAX_NUM_FULL_LOGS_IN_FILE || current_date != dateString()) {
				make_new_file = true;
				full_file_log = newLogFile;
				if (err) {
					helpers.state_error("visit_logger", exports.version, "write_full_log_file", err, "err_writing_logfile")
					console.warn(full_file_log)
				}
			}
			current_date = dateString();
			callback();
		});
}
function saveToDb(env_params) {
	//onsole.log("saveToDb")
	//onsole.log(JSON.stringify(day_db_log))
  var theDateString = null, today = dateString();

	// iterate through records and find one
	Object.keys(day_db_log).forEach(function(aDay) {if (aDay != today) theDateString=aDay;})
	theDateString = theDateString || today;
	// find one date to log. if more old days exist (unlikely), it will deal with one on each save

	var write = day_db_log[theDateString]

  db_handler.upsert (env_params, LOGGER_APC, theDateString, write, (err, entity)=>{
    if (err) {
      helpers.state_error("visit_logger", exports.version, "saveToDb", err, "err_writing_logs_to_db")
    } else {
      if (theDateString != today ) {
        delete day_db_log[theDateString]
      }
    }

  })
}

function addRecordToDailySummary(req, prefs, options) {
	var today = dateString ();
	var user_type = req.session.logged_in_user_id? "logged_in" : "anon";
	if (!day_db_log[today] ) day_db_log[today] = {};
	if (!day_db_log[today][user_type]) {
		day_db_log[today][user_type] = {
			'user_type':user_type,
			'dateString':today,

			apps:{},
			pages:{},
			visitIps:{},
			pageRefs:{},
			someUnauthUrls:{},
			users: {},
			numUnauthzed: 0,
			numAppPageViews:0,
			numAppFiles: 0,
			numUserFiles:0,
			numAcctChges:0,
			numdbWrites: 0,
			numFileUpload: 0,
			numDbReads: 0,
			numpcard:0,
			numppage:0,
			numpdb:0,
			numPubFiles:0,
			numredirect:0,
			numpubadmin:0, // log in logout oauth
		}
	}

	function addTo(outerKey, innerKey) {
		if (innerKey) {
			innerKey = encodeURI(innerKey)
			if (day_db_log[today][user_type][outerKey][innerKey]) {
				day_db_log[today][user_type][outerKey][innerKey]++
			} else if (Object.keys(day_db_log[today][user_type][outerKey]).length<MAX_NUM_DETAIL_REFS) {
				day_db_log[today][user_type][outerKey][innerKey]=1
			} else if (day_db_log[today][user_type][outerKey]["_other"]){
				day_db_log[today][user_type][outerKey]["_other"]++
			} else {day_db_log[today][user_type][outerKey]["_other"]=1}
		}
	}
	addTo("visitIps",options.ipaddress);
	addTo("apps",  options.app_name);

	if (req.session.logged_in_user_id) addTo("users",req.session.logged_in_user_id);

	if (options.auth_error) {
		day_db_log[today][user_type].numUnauthzed++;
		addTo("someUnauthUrls",encodeURI( req.originalUrl.replace(/\./g,"_")));
	}

	if (options.source == 'appPageAccessRights') {
		addTo("pageRefs",options.exteralRef);
		addTo("pages", encodeURI(req.originalUrl.replace(/\./g,"_")));
		day_db_log[today][user_type].numAppPageViews++
	} else if(APP_FILE_SOURCES.indexOf(options.source)>-1) {
		day_db_log[today][user_type].numAppFiles++
	} else if (options.source == 'userDataAccessRights' || options.source == 'userLoggedInRights') {
		var parts = req.originalUrl.split('?')[0].split("/");
		if (parts[2]=="db") {
		  if (parts[3] == "upload") {
		  		day_db_log[today][user_type].numFileUpload++
		  } else if (parts[3] == "write") {
		  	day_db_log[today][user_type].numdbWrites++
		  } else {day_db_log[today][user_type].numDbReads++}
		} else { // parts[2] == permissions, account, developer...
			if (parts[3] == "setobjectaccess" || ["change","changePassword.json","app_install_from_zipfile.json","app_install_from_url.json"].indexOf(parts[3])>-1 ) {
				day_db_log[today][user_type].numAcctChges++
			} else {day_db_log[today][user_type].numDbReads++}
		}
	} else if (options.source == 'addVersionNumber') {
		// todo later - conside streamlibing URLs to reduce if..else
		var parts = req.originalUrl.split('?')[0].split("/");
		if (parts[1]=="ppage" || parts[1]=="papp" || parts[1]=="rss.xml" || parts[2]=="public") {
			addTo("pageRefs",options.exteralRef);
			addTo("pages", encodeURI(req.originalUrl.replace(/\./g,"_")));
			day_db_log[today][user_type].numppage++
		} else if (parts[1]=="pcard") {
			day_db_log[today][user_type].numpcard++
		} else if (parts[2]=="pdbq" || parts[2]=="pobject") {
				day_db_log[today][user_type].numpdb++
		} else if (parts[2]=="userfiles" ) {
			day_db_log[today][user_type].numUserFiles++
		} else if (parts[2]=="publicfiles") {
				if (!day_db_log[today][user_type].numPubFiles) day_db_log[today][user_type].numPubFiles=0;
				day_db_log[today][user_type].numPubFiles++
		} else if (parts[1]=="account" || parts[2]=="account" || parts[1]=="login"|| parts[2]=="admin") {
			day_db_log[today][user_type].numpubadmin++
		} else {
      if (!day_db_log[today][user_type].unknowncat) day_db_log[today][user_type].unknowncat=0;
      day_db_log[today][user_type].unknowncat++
			console.warn("unknown addVersionNumber category", req.originalUrl,parts)
		}
	} else if (options.source == 'requireAdminRights') {
		day_db_log[today][user_type].numpubadmin++
	} else if (options.source == 'home') {
		// do nothing for the moment
	} else if (options.source == 'redirect') {
		day_db_log[today][user_type].numredirect++
	} else {
		console.warn("visit_logger: No choices left on source "+req.originalUrl+" source:"+options.source)
	}
}
function getClientAddress(request){
	// https://stackoverflow.com/questions/8107856/how-to-determine-a-users-ip-address-in-node
    //console.log("with incompatible with strict mode - reqq.ip works? "+req.ip)
    /* Alternate code to test console todo
    return request.ip */
    with(request)
        return (headers['x-forwarded-for'] || '').split(',')[0]
            || connection.remoteAddress
}

function get_app_name(req, options) {
	if (req.params.app_name) return req.params.app_name.replace(/\./g,"_")
	if (req.params.requestor_app) return req.params.requestor_app.replace(/\./g,"_")
	if (options.source == "home") return "home_redirect"

	if (req.originalUrl.split('?')[0] == "/") return "root"
	var parts = req.originalUrl.split('?')[0].split("/");
  if (parts[2]=="userfiles") return parts[3].replace(/\./g,"_");
	const PARTS2URLS =  ['app_files', 'apps', 'v1','feps','ceps']
	const PARTS1URLS =  ['appdata', 'favicon.ico', 'ppage', 'papp', 'account', 'login', 'admin']

	if (parts.length<2) return "account"

	if (PARTS2URLS.indexOf (parts[1]) >-1 ) return parts[2].replace(/\./g,"_");
	if (PARTS1URLS.indexOf (parts[1]) >-1 )  return parts[1].replace(/\./g,"_");
	console.warn("NO APP: "+req.originalUrl+ " "+parts.length+" "+parts.join(" - "))
	return "unknown_error"
}
function get_external_referer(req) {
	if (!req.header('Referer')) return null;
	//onsole.log("ref "+req.header('Referer'));
	if (!helpers.startsWith(req.header('Referer'), (req.protocol+"://"+req.hostname) ) ) {
		return req.header('Referer')
	} else {return null}
}
function timestamp () {
	// todo Add in preferred time zone adjustment before stamping
	return new Date().toISOString()
}
function dateString (time) {
	// todo Add in preferred time zone adjustment before stamping
	var date = time? new Date(time) : new Date()
	return date.toISOString().split('T')[0]
}

const APP_FILE_SOURCES = ['servePublicAppFile','serveAppFile']
function sourceIsFile(source) {
	return APP_FILE_SOURCES.indexOf(source) >-1
}
function isSysFile(url) {
	return FREEZR_SYS_FILES.indexOf(url)>-1
}

const FREEZR_SYS_FILES = ['/app_files/public/info.freezr.public/freezr_style.css', '/app_files/public/info.freezr.public/freezr_core.css', '/app_files/public/info.freezr.public/freezr_core.js', '/app_files/public/info.freezr.public/public/static/freezr_texture.png', '/app_files/public/info.freezr.public/static/freezer_log_top.png', '/favicon.ico']
