// freezr.info - nodejs system files - main file: server.js
const VERSION = "0.0.122";


// INITALISATION / APP / EXPRESS
console.log("=========================  VERSION August 2019  =======================")
const LISTEN_TO_LOCALHOST_ON_LOCAL = true; // for local development - set to true to access local site at http://localhost:3000, and false to access it at your local ip address - eg http://192.168.192.1:3000 (currently not working)


var fs = require('fs'),
    express = require('express'),
    bodyParser  = require('body-parser'),
    multer  = require('multer'),
    upload = multer().single('file'),
    logger = require('morgan'),
    cookieParser = require('cookie-parser'),
    cookieSession = require('cookie-session'),
    session = require('express-session'),
    app = express();


var  db_handler = require('./freezr_system/db_handler.js'),
    admin_handler = require('./freezr_system/admin_handler.js'),
    account_handler = require('./freezr_system/account_handler.js'),
    helpers = require('./freezr_system/helpers.js'),
    environment_defaults = require('./freezr_system/environment/environment_defaults.js'),
    file_handler = require('./freezr_system/file_handler.js'),
    app_handler = require('./freezr_system/app_handler.js'),
    async = require('async'),
    visit_logger = require('./freezr_system/visit_logger.js'),
    public_handler = require('./freezr_system/public_handler.js');

// console var tester = require('./freezr_system/environment/db_env_gaeCloudDatastore.js');

// var tester = require('./freezr_system/environment/db_env_nedb.js');


// stackoverflow.com/questions/26287968/meanjs-413-request-entity-too-large
app.use(bodyParser.json({limit:1024*1024*3, type:'application/json'}));
app.use(bodyParser.urlencoded( { extended:true,limit:1024*1024*3,type:'application/x-www-form-urlencoding' } ) );
app.use(cookieParser());


var freezr_prefs={};
const DEFAULT_PREFS={
    log_visits:true,
    log_details:{each_visit:true, daily_db:true, include_sys_files:false, log_app_files:false},
    redirect_public:false,
    public_landing_page: ""
};
var freezr_secrets = {params: {
                        session_cookie_secret:null
                     }};
var freezr_environment, custom_file_environment;






// ACCESS RIGHT FUNCTIONS
var serveAppFile = function(req, res, next) {
    //onsole.log( (new Date())+" serveAppFile - "+req.originalUrl);
    var fileUrl = req.originalUrl;

    // clean up url
    if (helpers.startsWith(fileUrl,'/app_files/')) { fileUrl = fileUrl.replace('/app_files/','app_files/')}
    else if (helpers.startsWith(fileUrl,'/apps/')) { fileUrl = fileUrl.replace('/apps/','app_files/')}

    if (fileUrl.indexOf('?')>1) { fileUrl = fileUrl.substr(0,fileUrl.indexOf('?'));} // solving slight problem when node.js adds a query param to some fetches

    //onsole.log( (new Date())+" serveAppFile - "+fileUrl);


    if (req.session && req.session.logged_in) {
        visit_logger.record(req, freezr_environment, freezr_environment, freezr_prefs, {source:'serveAppFile'});
        file_handler.sendAppFile(res, fileUrl, freezr_environment);
    } else {
        visit_logger.record(req, freezr_environment, freezr_prefs, {source:'serveAppFile',auth_error:true});
        helpers.auth_warning("server.js", VERSION, "serveAppFile", "Unauthorized attempt to access file "+ fileUrl);
        res.sendStatus(401);
    }
}
var servePublicAppFile = function(req, res, next) {
    var fileUrl = file_handler.normUrl(req.originalUrl.replace('/app_files/','app_files/') );

    if (helpers.startsWith(fileUrl,'/apps/')) { fileUrl = fileUrl.replace('/apps/','app_files/')}
    if (fileUrl.indexOf('?')>1) { fileUrl = fileUrl.substr(0,fileUrl.indexOf('?'));} // solving slight problem when node.js adds a query param to some fetches

    visit_logger.record(req, freezr_environment, freezr_prefs, {source:'servePublicAppFile'});
    if (fileUrl.slice(1)=="favicon.ico") {
        res.sendFile(file_handler.systemPathTo("systemapps/info.freezr.public/static/" + fileUrl));
    } else {
        file_handler.sendAppFile(res, fileUrl, freezr_environment);
    }
}
var appPageAccessRights = function(req, res, next) {
    if ((freezr_environment.freezr_is_setup && req.session && req.session.logged_in) ){
        visit_logger.record(req, freezr_environment, freezr_prefs, {source:'appPageAccessRights'});
        if (req.params.page || helpers.endsWith(req.originalUrl,"/") ) {
            req.freezr_server_version = VERSION;
            req.freezrStatus = freezrStatus;
            req.freezr_environment = freezr_environment;
            next();
        } else {
            res.redirect(req.originalUrl+'/');
        }
    } else {
        visit_logger.record(req, freezr_environment, freezr_prefs, {source:'appPageAccessRights', auth_error:true});
        if (freezr_environment && freezr_environment.freezr_is_setup) helpers.auth_warning("server.js", VERSION, "appPageAccessRights", "Unauthorized attempt to access page"+req.url+" without login ");
        res.redirect('/account/login')
    }
}
function requireAdminRights(req, res, next) {
    //onsole.log("require admin login "+req.session.logged_in_as_admin+" for "+req.session.logged_in_user_id);
    if (req.session && req.session.logged_in_as_admin) {
        req.freezr_server_version = VERSION;
        req.freezrStatus = freezrStatus;
        req.freezr_environment = freezr_environment;
        visit_logger.record(req, freezr_environment, freezr_prefs, {source:'requireAdminRights', auth_error:false});
        next();
    } else {
        visit_logger.record(req, freezr_environment, freezr_prefs, {source:'requireAdminRights', auth_error:true});
        helpers.auth_warning("server.js", VERSION, "requireAdminRights", "Unauthorized attempt to access admin area "+req.url+" - ");
        res.redirect("/account/login");
    }
}
var userDataAccessRights = function(req, res, next) {
    //onsole.log("userDataAccessRights sess "+(req.session?"Y":"N")+"  loggin in? "+req.session.logged_in_user_id+" param id"+req.params.userid);
    if (freezr_environment.freezr_is_setup && req.session && req.session.logged_in && req.session.logged_in_user_id){
        req.freezr_environment = freezr_environment;
        req.freezrStatus = freezrStatus;
        visit_logger.record(req, freezr_environment, freezr_prefs, {source:'userDataAccessRights'});
        next();
    } else {
        if (freezr_environment && freezr_environment.freezr_is_setup) helpers.auth_warning("server.js", VERSION, "userDataAccessRights", "Unauthorized attempt to access data "+req.url+" without login ");
        visit_logger.record(req, freezr_environment, freezr_prefs, {source:'userDataAccessRights', auth_error:true});
        res.sendStatus(401);
    }
}
function uploadFile(req,res) {
    req.freezr_server_version = VERSION;
    req.freezr_environment = freezr_environment;
    // visit_logger already done via userdatarights
    upload(req, res, function (err) {
        if (err) {
            helpers.send_failure(res, err, "server.js", VERSION, "uploadFile");
        }
        app_handler.putData(req,res);
    })
}
function uploadAppZipFile(req,res) {
    req.freezr_server_version = VERSION;
    req.freezr_environment = freezr_environment;
    // visit_logger already done via
    upload(req, res, function (err) {
        if (err) {
            helpers.send_failure(res, err, "server.js", VERSION, "uploadAppZipFile");
        }
        account_handler.add_uploaded_app_zip_file(req,res);
    })
}
function addVersionNumber(req, res, next) {
    req.freezr_server_version = VERSION;
    req.freezr_environment = freezr_environment;
    req.freezrStatus = freezrStatus;
    req.freezr_is_setup = freezr_environment.freezr_is_setup;

    visit_logger.record(req, freezr_environment, freezr_prefs, {source:'addVersionNumber', auth_error:false});

    next();
}

// APP PAGES AND FILE
const add_app_uses = function(){
  // headers and cookies
        app.use(cookieSession(
            // todo - move to a metof (if possible) to be able to reset coookie secret programmatically?
            {
            secret: freezr_secrets.params.session_cookie_secret,
            maxAge: 15552000000,
            store: new session.MemoryStore() // todolater:eview
            }
        ));
        app.use(function(req, res, next) {
            //stackoverflow.com/questions/22535058/including-cookies-on-a-ajax-request-for-cross-domain-request-using-pure-javascri
            res.header("Access-Control-Allow-Credentials","true");
            res.header("Access-Control-Allow-Origin", null);
            res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Origin, Accept");
            res.header("Access-Control-Allow-Methods","PUT, POST, GET, OPTIONS");
            next();
        });

  // app pages and files
        app.use("/app_files/info.freezr.public", servePublicAppFile);
        app.get('/app_files/:app_name/public/static/:file', servePublicAppFile);
        app.get('/app_files/:app_name/public/:file', servePublicAppFile);
        app.use("/app_files/:app_name/:file", serveAppFile);
        app.get('/apps/:app_name', appPageAccessRights, app_handler.generatePage);
        app.get('/apps/:app_name/static/:file', serveAppFile);
        app.get('/apps/:app_name/:page', appPageAccessRights, app_handler.generatePage);
        app.get('/allmydata/:whattodo/:app_name', appPageAccessRights, app_handler.generateSystemDataPage);
        app.get('/favicon.ico', servePublicAppFile)

    // app files and pages and user files
        app.get('/v1/db/getbyid/:permission_name/:collection_name/:requestor_app/:source_app_code/:requestee_app/:data_object_id', userDataAccessRights, app_handler.getDataObject); // here request type must be "one"
        app.get('/v1/userfiles/:permission_name/:collection_name/:requestor_app/:source_app_code/:requestee_app/:user_id/*', userDataAccessRights, app_handler.getDataObject); // collection_name is files
    // db
        app.put('/v1/db/upload/:app_name/:source_app_code',userDataAccessRights, uploadFile);
        app.put('/v1/db/write/:app_name/:source_app_code/:collection', userDataAccessRights, app_handler.putData);
        app.post('/v1/db/query/:requestor_app/:source_app_code/:requestee_app', userDataAccessRights, app_handler.db_query);
        app.post('/v1/db/query/:requestor_app/:source_app_code/:requestee_app/:permission_name', userDataAccessRights, app_handler.db_query);

    // public
        app.get('/pcard/:user_id/:requestor_app/:permission_name/:app_name/:collection_name/:data_object_id', addVersionNumber, public_handler.generatePublicPage);
        app.get('/pcard/:user_id/:app_name/:collection_name/:data_object_id', addVersionNumber, public_handler.generatePublicPage);
        app.get('/papp/:app_name/:page', addVersionNumber, public_handler.generatePublicPage);
        app.get('/papp/:app_name', addVersionNumber, public_handler.generatePublicPage);
        app.get('/ppage/:object_public_id', addVersionNumber, public_handler.generatePublicObjectPage);
        app.get('/ppage', addVersionNumber, public_handler.generatePublicPage);
        app.get('/rss.xml', addVersionNumber, public_handler.generatePublicPage);
        app.get('/apps/:app_name/public/static/:file', servePublicAppFile);
        app.get('/v1/pdbq', addVersionNumber, public_handler.dbp_query);
        app.get('/v1/pdbq/:app_name', addVersionNumber, public_handler.dbp_query);
        app.post('/v1/pdbq', addVersionNumber, public_handler.dbp_query);
        app.get('/v1/publicfiles/:requestee_app/:user_id/*', addVersionNumber, public_handler.get_data_object);
        app.get('/v1/pdb/getbyid/:requestee_app/:collection_name/:data_object_id', app_handler.getDataObject); // here request type must be "one"

        app.get('/v1/pobject/:user_id/:app_name/:collection_name/:data_object_id', addVersionNumber, public_handler.generatePublicPage);


    // permissions
        app.put('/v1/permissions/setobjectaccess/:requestor_app/:source_app_code/:permission_name', userDataAccessRights, app_handler.setObjectAccess);
        app.put('/v1/permissions/change/:requestee_app/:source_app_code', userDataAccessRights, account_handler.changeNamedPermissions);
        app.get('/v1/permissions/getall/:requestee_app/:source_app_code', userDataAccessRights, account_handler.all_app_permissions);
        // todo & review / redo app.put('/v1/permissions/setfieldaccess/:requestor_app/:source_app_code/:permission_name', userDataAccessRights, app_handler.setFieldAccess);
        // todo & review / redoapp.get('/v1/permissions/getfieldperms/:requested_type/:requestor_app/:source_app_code', userDataAccessRights, app_handler.getFieldPermissions)

    // developer utilities
        app.get('/v1/developer/config/:app_name/:source_app_code',userDataAccessRights, app_handler.getConfig);
        app.get('/v1/developer/fileListUpdate/:app_name/:source_app_code', userDataAccessRights, app_handler.updateFileList);
        app.get('/v1/developer/fileListUpdate/:app_name/:source_app_code/:folder_name', userDataAccessRights, app_handler.updateFileList);

    // account pages
        app.get ('/account/logout', addVersionNumber, account_handler.logout_page);
        app.get ('/account/login', addVersionNumber, account_handler.generate_login_page);
        app.get ('/login', addVersionNumber, account_handler.generate_login_page);
        app.get ('/account/applogin/login/:app_name', addVersionNumber, account_handler.generate_login_page);
        app.get ('/account/applogin/results', addVersionNumber, account_handler.generate_applogin_results);
        app.get ('/account/:page', appPageAccessRights, account_handler.generateAccountPage);

        app.get('/v1/account/ping', addVersionNumber, account_handler.ping);
        app.post('/v1/account/login', addVersionNumber, account_handler.login);
        app.post('/v1/account/applogin', addVersionNumber, account_handler.login);
        app.post('/v1/account/applogout', addVersionNumber, account_handler.logout);
        app.put ('/v1/account/changePassword.json', userDataAccessRights, account_handler.changePassword);
        app.put ('/v1/account/upload_app_zipfile.json', userDataAccessRights, uploadAppZipFile);

        app.get('/v1/account/app_list.json', userDataAccessRights, account_handler.list_all_user_apps);
        app.post('/v1/account/appMgmtActions.json', userDataAccessRights, account_handler.appMgmtActions);



    // admin pages
        app.put ('/v1/admin/oauth_perm', requireAdminRights, admin_handler.oauth_perm_make);
        app.get('/v1/admin/oauth/public/:dowhat', addVersionNumber, admin_handler.oauth_do);

        app.get('/admin/public/:sub_page', addVersionNumber, admin_handler.generateAdminPage);
        app.get('/admin/:sub_page', requireAdminRights, admin_handler.generateAdminPage);
        app.get('/admin', requireAdminRights, admin_handler.generateAdminPage);

        app.put('/v1/admin/change_main_prefs', requireAdminRights, function (req, res) {
            req.defaultPrefs = DEFAULT_PREFS;
            admin_handler.change_main_prefs (req, function(err, returns) {
                if (err) {
                    helpers.send_auth_failure(res, "admin_handler", exports.version,"change_main_prefs",err.message, err.errCode);
                } else {
                    freezr_prefs = returns.newPrefs;
                    console.log("new freezr_prefs returns")
                    console.log(returns)
                    helpers.send_success(res, returns);
                }
            })
        })
        app.put('/v1/admin/user_register', requireAdminRights, admin_handler.user_register);
        app.put('/v1/admin/first_registration', addVersionNumber, function (req, res) {
            admin_handler.first_registration(req, function(err, results) {
                if (err || !results || !results.freezr_environment) {
                    if (!err) err = {message:'unknown err', code:null}
                    helpers.send_auth_failure(res, "admin_handler", exports.version,"first_registration",err.message, err.errCode);
                } else {
                    helpers.log (null,"End of process of 1st reg "+JSON.stringify(results))
                    freezr_environment = results.freezr_environment
                    file_handler.reset_freezr_environment(freezr_environment);
                    freezrStatus = results.fstatus;
                    freezrStatus.fundamentals_okay = get_all_okay_status(freezrStatus);
                    helpers.send_success(res, {user:results.user, freezrStatus:freezrStatus});
                }
            })
        });
        app.post('/v1/admin/dbquery/:collection_name', requireAdminRights, admin_handler.dbquery);
        app.get('/v1/admin/user_list.json', requireAdminRights, admin_handler.list_all_users);

    // default redirects
        function getPublicUrlFromPrefs () {
            //onsole.log(freezr_prefs)
            if (!freezr_prefs.redirect_public) return "/account/login";
            if (!freezr_prefs.public_landing_page) return "/ppage";
            return "/papp/"+freezr_prefs.public_landing_page;
        }
        app.get("/", function (req, res) {
            // to if allows public people coming in, then move to public page
            //onsole.log("redirecting to account/home as default for "+req.originalUrl);
            visit_logger.record(req, freezr_environment, freezr_prefs, {source:'home'});
            var redirect_url = (req.session && req.session.logged_in)? "/account/home": getPublicUrlFromPrefs();
            helpers.log(req,"home url redirect")
            res.redirect( redirect_url);
            res.end();
        });
        app.get('*', function (req, res) {
            helpers.log(req,"unknown url redirect: "+req.url)
            visit_logger.record(req, freezr_environment, freezr_prefs, {source:'redirect'});
            //onsole.log("redirecting to account/login as default or for non logged in "+req.originalUrl);
            res.redirect( (req.session && req.session.logged_in)? "/account/home":getPublicUrlFromPrefs());
            res.end();
        });
}

// SET UP AND RUN APP
var freezrStatus = {
    fundamentals_okay: null,
    environment_file_exists_no_faults : false,
    can_write_to_user_folder : false,
    can_read_write_to_db : false,
    environments_match : true
}

const  get_all_okay_status = function(aStatus) {
    return (aStatus.can_write_to_user_folder && aStatus.can_read_write_to_db)
}
const try_reading_freezr_env_file = function(env, callback) {
  file_handler.init_custom_env(env, (err) => { // uses env passed to it (generally autoconfig params) to find nev on file
    if (err) {
      console.warn("Error getting custom_env ", err)
      callback(err)
    } else {
      file_handler.requireFile("userfiles","freezr_environment.js",env, callback )
    }
  })
}
function has_cookie_in_environment() {
    return (process && process.env && process.env.COOKIE_SECRET);
}

// setting up freezr_environment
// Checks file on server - if so, use that but check against the version of the db and mark error if they are different
// But if file doesn't exist (it could be because of a restart in docker wiping it out) use the db. (Not an error - just warn)
async.waterfall([
    // 1 Read freezr_environment from file and initiate environment or use defaults
    function (cb) { // todo - make async with errr coming back from init_custome_env
      try_reading_freezr_env_file (freezr_environment, (err, env_on_file) => {
        if (!err) {
          freezr_environment = env_on_file.params;
          freezrStatus.environment_file_exists_no_faults = true;
          console.log("1. Local copy of freezr_environment.js exists",freezr_environment)
          cb(null)
        } else {
          // todo later: consider also case where file is corrupt - here we assume it doesnt exist and try other options
          console.log("1. Note - no local copy of freezr_environment foun")
          environment_defaults.autoConfigs((err, autoconfigs) => {
            if (err) {
              console.warn("1 - Local environment file missing and ERROR getting Autoconfigured settings")
              cb(null)
            } else {
              if (autoconfigs) freezr_environment = autoconfigs;
              //onsole.log("Got autoconfigs, freezr_environment is "+JSON.stringify(freezr_environment))
              try_reading_freezr_env_file (freezr_environment, (err, env_on_file) => {
                if (!err) {
                  freezr_environment = env_on_file.params;
                  freezrStatus.environment_file_exists_no_faults = true;
                  console.log("1. Using autoconfig parameters, found freezr_environment.js file")
                  cb(null);
                } else {
                  console.warn("1 - freezr_environment file does NOT exist or had errors(!) (DB to be queried for environment)");
                  freezr_environment.freezr_is_setup = false;
                  freezr_environment.first_user = null;
                  cb(null);
                }
              })
            }
          })
        }
      })
    },

    // 2. test check db and re-write or check freezr_environment
    function (cb) {
        db_handler.re_init_freezr_environment(freezr_environment, cb);
    },
    function (cb) {
        db_handler.check_db(freezr_environment, function (err, env_on_db) {
            if (err) {
              freezrStatus.can_read_write_to_db = false;
              console.warn("2 - DB Not Working ",err)
              cb (err)
            } else {
              freezrStatus.can_read_write_to_db = true;
              if (freezrStatus.environment_file_exists_no_faults) {
                  if (!helpers.variables_are_similar(freezr_environment,env_on_db)) {
                      helpers.warning("server.js", exports.version, "startup_waterfall", "STARTUP MISMATCH - freezr_environment on server different from one on db" )
                      freezrStatus.environments_match = false;
                      console.warn("2 - PROBLEM freezr_environment NOT consistent with db version")
                  } else {
                      console.log("2 - db working - freezr_environment consistent with db version")
                  }
                  cb(null)
              } else {
                  if (freezr_environment.freezr_is_setup) helpers.warning("server.js", exports.version, "startup_waterfall", "freezr_environment on server not found" )
                  if (env_on_db) {
                      console.log("2 - Using db version of freezr_environment (as file doesnt exist)")
                      freezr_environment = env_on_db
                      freezr_environment.env_on_db_only = true;
                      cb(null)
                  } else {
                      console.log("2 - No freezr_environment on db or file - FIRST REGISTRATION WILL BE TRIGGERED")
                      cb(null)
                  }
              }
            }
        })
    },


    // 3a. create user directories and file_handler
    function (cb) {
      file_handler.reset_freezr_environment(freezr_environment);
      file_handler.init_custom_env(freezr_environment, (err)=>{
        if(err) {
            helpers.warning("server.js", exports.version,"startup_waterfall","failure to initialise custom environment - "+err);
        }
        cb(null);
      });
    },
    // 3b - Check if can write to user folder (if 3a fails, 3b should fail too)
    function (cb) {
      file_handler.setup_file_sys(freezr_environment, (err) => {
        if(err) {
            helpers.warning("server.js", exports.version,"startup_waterfall","failure to create user directories - "+err);
        }
        cb(null);
      })
    },
    // 3c - Check if can write to user folder (if 3b fails, 3c will fail too)
    function (cb) {
      file_handler.writeTextToUserFile ("userapps", "test_write.txt", "Testing write on server", {fileOverWrite:true}, null, null, freezr_environment, function (err) {
        if(err) {
          helpers.warning("server.js", exports.version,"startup_waterfall","failure to write to user folder - "+err);
        } else {
          console.log("3 - Can write to user folders")
        }
        freezrStatus.can_write_to_user_folder = err? false:true;
        if (freezrStatus.can_write_to_user_folder && freezr_environment.env_on_db_only ){
          // try re-writing freezr_environment.js on local environment  if only existed on the db
          fs.writeFile(file_handler.fullLocalPathToUserFiles("userfiles","freezr_environment.js"), false, freezr_environment, "exports.params=" + JSON.stringify(freezr_environment), function(err) {
            // only happens if using local file system and file has been corrupted. Other wise, if non local fs, then error is normal, so it is not caught
              cb(null);
          })
        } else {
          cb(null)
        }
      })
    },

    // 4 - Read and write freezr secrets if doesnt exist
    function (cb) {
      file_handler.requireFile("userfiles","freezr_secrets.js",freezr_environment, (err, secrets_onfile) => {
        if (secrets_onfile) freezr_secrets=secrets_onfile;
        if (has_cookie_in_environment()) { // override
            freezr_secrets.params.session_cookie_secret = process.env.COOKIE_SECRET
        }
        if (!freezr_secrets.params.session_cookie_secret) {
            freezr_secrets.params.session_cookie_secret = helpers.randomText(20)
        }
        add_app_uses();

        if (!secrets_onfile && freezrStatus.can_write_to_user_folder) {
            var file_text = has_cookie_in_environment()? "exports.params={}" : "exports.params=" + JSON.stringify(freezr_secrets.params);
            file_handler.writeTextToUserFile ("userfiles", "freezr_secrets.js", file_text, {fileOverWrite:true}, null, null, freezr_environment, function (err) {
                if(err) {
                    helpers.warning("server.js", exports.version, "startup_waterfall", "Stransge inconsistency writing files (freezr_secrets) onto server" )
                }
                cb(null)
            });
        } else {cb(null)}
      })
    },

    //  5 - Get ip address for local network servers (currently not working - todo to review)
    function (cb) {
        freezrStatus.fundamentals_okay = get_all_okay_status(freezrStatus);
        //onsole.log("require('os').hostname()"+require('os').hostname())
        if (LISTEN_TO_LOCALHOST_ON_LOCAL) {
            cb(null)
        } else {
            require('dns').lookup(require('os').hostname(), function (err, add, fam) {
                // Priorities in choosing default address: 1. default ip from environment_defaults (if written) 2. localhost if relevant 3. address looked up.
                freezr_environment.ipaddress = freezr_environment.ipaddress? freezr_environment.ipaddress: ((helpers.startsWith(add,"192.168") && LISTEN_TO_LOCALHOST_ON_LOCAL)? "localhost" :add);
                console.warn("hostname currently not working - Once working: Would be running on local ip Address: "+freezr_environment.ipaddress);
                cb(null);
           })
        }
    },

    // 6 Get freezr main preferences
    function (cb) {
      //onsole.log("get or set main prefs "+JSON.stringify(DEFAULT_PREFS))
      if (freezrStatus.can_read_write_to_db){
        db_handler.get_or_set_prefs(freezr_environment, "main_prefs", DEFAULT_PREFS, false ,function (err, main_prefs_on_db) {
            freezr_prefs = main_prefs_on_db;
            cb(err)
        })
      } else {cb (null)}
    },

    // reload visit_logger
    function (cb) {
        if (freezrStatus.can_read_write_to_db) {visit_logger.reloadDb(freezr_environment, cb)} else {cb(null)}
    }],
    function (err) {
        if (err) console.log(" =================== Got err on start ups =================== ")
        console.log("Startup checks complete.")
        console.log("freezr_prefs: ")
        console.log(freezr_prefs)
        console.log("freezrStatus: ")
        console.log(freezrStatus)
        //onsole.log(freezr_environment)
        if (err) {
            helpers.warning("server.js", exports.version, "startup_waterfall", "STARTUP ERR "+JSON.stringify(err) )
        }
        // st hack in case of change in port (eg heroku) - to do - make more elegant with env defaults
        var theport = (process && process.env && process.env.PORT)? process.env.PORT : freezr_environment.port;
        app.listen(theport) //, freezr_environment.ipaddress)
        helpers.log (null,"Going to listen on port "+freezr_environment.port)
    }
)
