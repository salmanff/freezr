// visit_logger.js
// freezr.info - nodejs system files - logger.js

/* TO DO
	//  reloadDb at the beginning

	// get rid of "throw errors"...

*/

var helpers = require('./helpers.js'),
    db_handler = require("./db_handler.js"),
    async = require('async'),
    file_handler = require('./file_handler.js');

exports.version = '0.0.122'

const MAX_NUM_DETAIL_REFS = 100;
const MAX_NUM_FULL_LOGS_IN_FILE = 100;


var full_file_log = [],
	make_new_file = true,
	last_file_name = null;
var current_date = dateString();
var day_db_log = {};
var saveTimer = null;

exports.reloadDb = function (env_params, callback) {
	// get the latest from db
	// get the latest file, if any and have the counter
	var today = dateString();
  const appcollowner = {
    app_name:'info_freezer_admin',
    collection_name:'visit_log_daysum',
    _owner:'freezr_admin'
  }
  db_handler.db_getbyid (env_params, appcollowner, today, (err, object) => {
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

exports.record = function(req, env_params, prefs, options){
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

	var the_url = "userfiles/freezr_admin/daily_log_files/"+(new Date().getFullYear())
	file_handler.writeTextToUserFile (
		file_handler.normUrl(the_url),
		last_file_name,
		JSON.stringify({'app':'info,freezr.visit_logger' ,version:exports.version,logs:full_file_log}),
		{fileOverWrite: !make_new_file},
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
	write._owner = 'freezr_admin';
  appcollowner = {
    app_name:'info_freezer_admin',
    collection_name:'params',
    _owner:'freezr_admin'
  }

  db_handler.db_upsert (env_params, appcollowner, theDateString, write, (err, entity)=>{
    if (err) {
      helpers.state_error("visit_logger", exports.version, "saveToDb", err, "err_writing_logs_to_db")
    } else {
      if (theDateString != today ) {
        delete day_db_log[theDateString]
      }
    }

  })

/* OLD temp DELETE THIS (TODO)
	async.waterfall([
        function (cb) {
        	db_handler.app_db_collection_get('info_freezr_admin', 'visit_log_daysum', cb);
        },
        function (theCollection, cb) {
            dbCollection = theCollection;
            dbCollection.find({ _id: theDateString }).toArray(cb);
        },
        function (results, cb) {
        	// todo - have a function to "write or update"
			write._date_Modified =  0 + (new Date().getTime() );
            if ( (results == null || results.length == 0) ) { // new document
                write._date_Created = new Date().getTime();
                write._id = theDateString;
                dbCollection.insert(write, { w: 1, safe: true }, cb);
            } else {
            	delete write._id;
                dbCollection.update({_id: theDateString },
                    {$set: write}, {safe: true }, cb);
            }
        },
	],
    function (err) {
        if (err) {
        	helpers.state_error("visit_logger", exports.version, "saveToDb", err, "err_writing_logs_to_db")
        } else {
        	if (theDateString != today ) {
        		delete day_db_log[theDateString]
        	}
        }
    });
*/
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
	} else if (options.source == 'userDataAccessRights') {
		var parts = req.originalUrl.split('?')[0].split("/");
		if (parts[2]=="userfiles" ) {
			day_db_log[today][user_type].numUserFiles++
		} else if (parts[2]=="db") {
		  if (parts[3] == "upload") {
		  		day_db_log[today][user_type].numFileUpload++
		  } else if (parts[3] == "write") {
		  	day_db_log[today][user_type].numdbWrites++
		  } else {day_db_log[today][user_type].numDbReads++}
		} else { // parts[2] == permissions, account, developer...
			if (parts[3] == "setobjectaccess" || parts[3] == "change" || parts[3] == "changePassword.json" || parts[3] == "upload_app_zipfile.json" ) {
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
		} else if (parts[2]=="publicfiles") {
				if (!day_db_log[today][user_type].numPubFiles) day_db_log[today][user_type].numPubFiles=0;
				day_db_log[today][user_type].numPubFiles++
		} else if (parts[1]=="account" || parts[2]=="account" || parts[1]=="login"|| parts[2]=="admin") {
			day_db_log[today][user_type].numpubadmin++
		} else {
			console.warn("unknown addVersionNumber category", req.originalUrl,parts)
			throw helpers.error("unknown addVersionNumber category")
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
	const PARTS2URLS =  ['app_files', 'apps', 'v1']
	const PARTS1URLS =  ['allmydata', 'favicon.ico', 'ppage', 'papp', 'account', 'login', 'admin']

	if (parts.length<2) return "account"
	if (PARTS2URLS.indexOf (parts[1]) >-1 ) return parts[2].replace(/\./g,"_");
	if (PARTS1URLS.indexOf (parts[1]) >-1 )  return parts[1].replace(/\./g,"_");
	console.warn("NO APP: "+req.originalUrl+ " "+parts.length+" "+parts.join("P"))
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

const FREEZR_SYS_FILES = ['/app_files/info.freezr.public/freezr_style.css', '/app_files/info.freezr.public/freezr_core.css', '/app_files/info.freezr.public/freezr_core.js', '/app_files/info.freezr.public/static/freezr_texture.png', '/app_files/info.freezr.public/static/freezer_log_top.png', '/favicon.ico']
