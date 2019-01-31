// freezr.info - nodejs system files - main file: server.js 
const VERSION = "0.0.122";


// INITALISATION / APP / EXPRESS
console.log("=========================  VERSION August 2018  =======================")
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


var db_main = require('./freezr_system/db_main.js'),
    admin_handler = require('./freezr_system/admin_handler.js'),
    account_handler = require('./freezr_system/account_handler.js'),
    helpers = require('./freezr_system/helpers.js'),
    environment_defaults = require('./freezr_system/environment/environment_defaults.js'),
    file_handler = require('./freezr_system/file_handler.js'),
    app_handler = require('./freezr_system/app_handler.js'),
    async = require('async'),
    visit_logger = require('./freezr_system/visit_logger.js'),
    public_handler = require('./freezr_system/public_handler.js');

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


function has_cookie_in_environment() {
    return (process && process.env && process.env.COOKIE_SECRET);
}
if (has_cookie_in_environment()) {
    freezr_secrets.params.session_cookie_secret = process.env.COOKIE_SECRET
} else if (fs.existsSync(file_handler.systemPathTo("freezr_secrets.js"))) {
    freezr_secrets = require(file_handler.systemPathTo("freezr_secrets.js"))
} 
if (!freezr_secrets.params.session_cookie_secret) {
    freezr_secrets.params.session_cookie_secret = helpers.randomText(20)
}



app.use(cookieSession(
    // todo - move to a metof (if possible) to be able to reset coookie secret programmatically?
    {
    secret: freezr_secrets.params.session_cookie_secret,
    maxAge: 15552000000,
    store: new session.MemoryStore() // review - perhaps change this to mongo
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
        visit_logger.record(req, freezr_prefs, {source:'serveAppFile'});
        file_handler.sendAppFile(res, fileUrl, freezr_environment);
    } else {
        visit_logger.record(req, freezr_prefs, {source:'serveAppFile',auth_error:true});
        helpers.auth_warning("server.js", VERSION, "serveAppFile", "Unauthorized attempt to access file "+ fileUrl);
        res.sendStatus(401);
    }
}
var servePublicAppFile = function(req, res, next) {
    var fileUrl = file_handler.normUrl(req.originalUrl.replace('/app_files/','app_files/') );

    if (helpers.startsWith(fileUrl,'/apps/')) { fileUrl = fileUrl.replace('/apps/','app_files/')}
    if (fileUrl.indexOf('?')>1) { fileUrl = fileUrl.substr(0,fileUrl.indexOf('?'));} // solving slight problem when node.js adds a query param to some fetches

    visit_logger.record(req, freezr_prefs, {source:'servePublicAppFile'});
    if (fileUrl.slice(1)=="favicon.ico") {
        res.sendFile(file_handler.systemPathTo("systemapps/info.freezr.public/static/" + fileUrl));
    } else {
        file_handler.sendAppFile(res, fileUrl, freezr_environment);
    }
}
var appPageAccessRights = function(req, res, next) {
    if ((freezr_environment.freezr_is_setup && req.session && req.session.logged_in) ){
        visit_logger.record(req, freezr_prefs, {source:'appPageAccessRights'});
        if (req.params.page || helpers.endsWith(req.originalUrl,"/") ) {
            req.freezr_server_version = VERSION;
            req.freezrStatus = freezrStatus;
            req.freezr_environment = freezr_environment;
            next();
        } else {
            res.redirect(req.originalUrl+'/');
        }
    } else {
        visit_logger.record(req, freezr_prefs, {source:'appPageAccessRights', auth_error:true});
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
        visit_logger.record(req, freezr_prefs, {source:'requireAdminRights', auth_error:false});
        next();
    } else {
        visit_logger.record(req, freezr_prefs, {source:'requireAdminRights', auth_error:true});
        helpers.auth_warning("server.js", VERSION, "requireAdminRights", "Unauthorized attempt to access admin area "+req.url+" - ");
        res.redirect("/account/login");
    }
}
var userDataAccessRights = function(req, res, next) {
    //onsole.log("userDataAccessRights sess "+(req.session?"Y":"N")+"  loggin in? "+req.session.logged_in_user_id+" param id"+req.params.userid);
    if (freezr_environment.freezr_is_setup && req.session && req.session.logged_in && req.session.logged_in_user_id){
        req.freezr_environment = freezr_environment;
        req.freezrStatus = freezrStatus;
        visit_logger.record(req, freezr_prefs, {source:'userDataAccessRights'});
        next();
    } else {
        if (freezr_environment && freezr_environment.freezr_is_setup) helpers.auth_warning("server.js", VERSION, "userDataAccessRights", "Unauthorized attempt to access data "+req.url+" without login ");
        visit_logger.record(req, freezr_prefs, {source:'userDataAccessRights', auth_error:true});
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
    
    visit_logger.record(req, freezr_prefs, {source:'addVersionNumber', auth_error:false});

    next();
}

// APP PAGES AND FILE
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
                    file_handler.resetFreezrEnvironment(freezr_environment);
                    freezrStatus = results.fstatus;
                    freezrStatus.fundamentals_okay = getAllOkayStatus(freezrStatus);
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
            visit_logger.record(req, freezr_prefs, {source:'home'});
            var redirect_url = (req.session && req.session.logged_in)? "/account/home": getPublicUrlFromPrefs();
            helpers.log(req,"home url redirect")
            res.redirect( redirect_url);
            res.end();
        });
        app.get('*', function (req, res) {
            helpers.log(req,"unknown url redirect: "+req.url)
            visit_logger.record(req, freezr_prefs, {source:'redirect'});
            //onsole.log("redirecting to account/login as default or for non logged in "+req.originalUrl);
            res.redirect( (req.session && req.session.logged_in)? "/account/home":getPublicUrlFromPrefs());
            res.end();
        });


// SET UP AND RUN APP 


var freezrStatus = {
    fundamentals_okay: null,
    environment_file_exists_no_faults : false,
    can_write_to_system_folder : false,
    can_write_to_user_folder : false,
    can_read_write_to_db : false,
    environment_mismatch : false
}
// setting up freezr_environment
// Checks file on server - if so, use that but check against the version of the db and mark error if they are different
// But if file doesn't exist (it could be because of a restart in docker wiping it out) use teh db. (Not an error - just warn)
async.waterfall([   
    // 0 Read freezr_environment from file and initiate environment or use defaults
    function (cb) { // todo - make async with errr coming back from init_custome_env
        if (fs.existsSync(file_handler.systemPathTo("freezr_environment.js"))) {
            try {
                freezr_environment = require(file_handler.systemPathTo("freezr_environment.js"));
                freezr_environment = freezr_environment.params;
                freezrStatus.environment_file_exists_no_faults = true;
                if (freezr_environment && freezr_environment.userDirParams && freezr_environment.userDirParams.name) {
                    file_handler.init_custom_env(freezr_environment, cb);
                } else {
                    cb(null);
                }
            } catch(e) {
                cb(helpers.error("1 - ERROR: could not read / parse freezr_environment file","freezr_environment_mal_formed"))
            }
        } else {
            console.warn("1 - freezr_environment file does NOT exist.");
            freezr_environment = environment_defaults.autoConfigs();
            freezr_environment.freezr_is_setup = false;
            freezr_environment.first_user = null;
            cb(null);
        }
        
    }, 
    // 1 Get ip address for local apps (currently not working - todo to review)
    function (cb) { 
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
    // 2. check can write to system 
    function (cb) { 
        fs.writeFile(file_handler.systemPathTo("test_write.txt"), "Testing write on server", cb)
    }, 
    function (cb) { 
        freezrStatus.can_write_to_system_folder = true;
        console.log("2 - check - Can Write to System Folder.")
        cb(null);
    },

    // test check db and re-wrtie or check freezr_environment
    function (cb) { 
        db_main.resetFreezrEnvironment(freezr_environment);
        db_main.check_db(function (err, env_on_db) {
            //onsole.log("got env_on_db ",env_on_db)
            if (!err) freezrStatus.can_read_write_to_db = true;
            if (freezrStatus.environment_file_exists_no_faults) {
                if (!helpers.variables_are_similar(freezr_environment,env_on_db)) {
                    helpers.warning("server.js", exports.version, "startup_waterfall", "STARTUP MISMATCH - freezr_environment on server different from one on db" )
                    freezrStatus.environment_mismatch = true;
                    console.log("3 - PROBLEM freezr_environment NOT consistent with db version")
                } else {
                    console.log("3 - check - db working - freezr_environment consistent with db version")
                }
                cb(null)
            } else {
                if (freezr_environment.freezr_is_setup) helpers.warning("server.js", exports.version, "startup_waterfall", "freezr_environment on server not found" )
                
                if (env_on_db && freezrStatus.can_write_to_system_folder) {   
                    console.log("3 - Using db version of freezr_environment (as file doesnt exist)")
                    freezr_environment = env_on_db
                    db_main.resetFreezrEnvironment(freezr_environment);
                    fs.writeFile(file_handler.systemPathTo("freezr_environment.js", false, freezr_environment), "exports.params=" + JSON.stringify(freezr_environment), function(err) { 
                        if(err) {
                            freezrStatus.can_write_to_system_folder = false;
                            helpers.warning("server.js", exports.version, "startup_waterfall", "Strange inconsistency writing files to server root" )
                        }
                        cb(null);
                    })
                } else {
                    console.log("3 - No freezr_environment on db or file - FIRST REGISTRATION WILL BE TRIGGERED")
                    cb(null)
                }
            }
        })
    }, 

    // initiate db if all okay
    function (cb) { 
        if (freezrStatus.can_read_write_to_db) {
            db_main.init_admin_db(function (err, results) {
                if (err) {
                    helpers.warning("server.js", exports.version, "startup_waterfall", "Strange inconsistency getting error initiating db" )
                    freezrStatus.can_read_write_to_db = false;
                }  
                cb(null);
            });
        } else {            
            cb(null);
        }            
    }, 
    // Wrtie freezr secrets if doesnt exist
    function (cb) {
        if (freezrStatus.can_write_to_system_folder && !fs.existsSync(file_handler.systemPathTo("freezr_secrets"))) {
            var file_text = has_cookie_in_environment()? "exports.params={}" : "exports.params=" + JSON.stringify(freezr_secrets.params);
            fs.writeFile(file_handler.systemPathTo("freezr_secrets.js"), file_text, function(err) {
                if(err) {
                    helpers.warning("server.js", exports.version, "startup_waterfall", "Stransge inconsistency writing files (freezr_secrets) onto server" )
                } else {
                    console.log("4 - Can write to system folders")                    
                }
                cb(null)
            }); 
        } else {cb(null)}
    },
    // Check if can write to user folder
    function (cb) {
        file_handler.writeTextToUserFile ("userapps", "test_write.txt", "Testing write on server", {fileOverWrite:true}, null, null, freezr_environment, function (err) {
            if(err) { 
                helpers.warning("server.js", exports.version,"startup_waterfall","failure to write to user folder - "+err);
            } else {
                console.log("5 - Can write to user folders")           
            }
            freezrStatus.can_write_to_user_folder = err? false:true;
            freezrStatus.fundamentals_okay = getAllOkayStatus(freezrStatus);
            file_handler.resetFreezrEnvironment(freezr_environment);
            if (freezr_environment && freezr_environment.userDirParams && freezr_environment.userDirParams.name) {
                file_handler.init_custom_env(freezr_environment, cb);
            } else {
                cb(null);
            }
        })
    },

    // Get freezr main preferences
    function (cb) {
        db_main.getOrSetPrefs("main_prefs", DEFAULT_PREFS, false ,function (err, main_prefs_on_db) {
            freezr_prefs = main_prefs_on_db;
            cb(err)
        })
    },

    // reload visit_logger
    function (cb) {
        visit_logger.reloadDb(cb)
    }], 
    function (err) {
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

var getAllOkayStatus = function(aStatus) {
    return (aStatus.can_write_to_user_folder && aStatus.can_read_write_to_db)

}
        


