// freezr.info - nodejs system files - admin_handler.js
exports.version = "0.0.123";

var helpers = require('./helpers.js'),
    db_handler = require("./db_handler.js"),
    bcrypt = require('bcryptjs'),
    user_obj = require("./user_obj.js"),
    async = require('async'),
    fs = require('fs'),
    file_handler = require('./file_handler.js');

exports.generateAdminPage = function (req, res) {
    helpers.log(req, "adminPage: "+req.url)
    // todo - distibguish http & https
    //onsole.log("??? req.headers.referer.split(':')[0]"+req.headers.referer);
    //onsole.log("??? req.secure "+req.secure)
    //onsole.log("??? req.protocol"+req.protocol)
    var initial_query = '', script_files=null; css_files= null;  page_title= null, initial_query_func= null, page_url = null, other_variables=null;
    var isPublicPage = helpers.startsWith(req.url,"/admin/public")
    if (!isPublicPage && !req.params.sub_page) req.params.sub_page = "home"
    switch(req.params.sub_page) {
        case "home":
            page_title = "freezr.info - Admin";
            css_files = ['./info.freezr.admin/public/firstSetUp.css','./info.freezr.public/freezr_style.css'];
            break;
        case "list_users":
            page_title = "freezr.info - User list";
            css_files = './info.freezr.public/freezr_style.css';
            initial_query = {'url':"/v1/admin/user_list.json"};
            initial_query_func = exports.list_all_users
            break;
        case "register":
            script_files = ['./info.freezr.admin/register.js'];
            page_title = "freezr.info - Register";
            css_files = './info.freezr.public/freezr_style.css';
            break;
        case "prefs":
            script_files = ['./info.freezr.admin/prefs.js'];
            page_title = "freezr.info - Main Preferences";
            css_files = './info.freezr.public/freezr_style.css';
            initial_query_func = exports.get_main_prefs
            break;
        case "oauth_serve_setup":
            page_title = "freezr.info - Set up your freezr as an oauth server";
            css_files = ['oauth_serve_setup.css','./info.freezr.public/freezr_style.css'];
            script_files = ['oauth_serve_setup.js'];
            initial_query_func = exports.list_all_oauths;
            break;
        // PUBLIC PAGES...
        case "oauth_start_oauth": //public
            script_files = ['./info.freezr.admin/public/oauth_start_oauth.js'];
            page_title = "freezr.info - o-auth - starting process";
            css_files = './info.freezr.public/freezr_style.css';
            break;
        case "oauth_validate_page": //public
            script_files = ['./info.freezr.admin/public/oauth_validate_page.js'];
            page_title = "freezr.info - o-auth validating page";
            css_files = './info.freezr.public/freezr_style.css';
            break;
        case "firstSetUp": //public - Note security checks done below
            page_title = "Freezr Set Up";
            page_url= 'firstSetUp.html';
            script_files = ['./info.freezr.admin/public/firstSetUp.js'];
            css_files = ['./info.freezr.admin/public/firstSetUp.css','./info.freezr.public/freezr_style.css'];
            var temp_environment = JSON.parse(JSON.stringify(req.freezr_environment) );
            if (temp_environment.dbParams && temp_environment.dbParams.pass ){
                temp_environment.dbParams.pass = null;
                temp_environment.dbParams.has_password = true;
            };
            if (temp_environment.dbParams && temp_environment.dbParams.connectionString ){
                temp_environment.dbParams.connectionString = null;
                temp_environment.dbParams.has_password = true;
            };
            if (temp_environment.userDirParams && temp_environment.userDirParams.access_token) {
                temp_environment.userDirParams.access_token = null;
                temp_environment.userDirParams.has_access_token = true;
            }
            other_variables = " var freezrServerStatus = "+JSON.stringify(req.freezrStatus)+"; var firstSetUp = "+(req.freezr_environment.freezr_is_setup? "false":"true")+";"+ " var freezr_environment = "+JSON.stringify(temp_environment)+";"
            break;
        case "starterror": // public
            page_title = "Fatal Error (Freezr)",
            script_files = ['./info.freezr.admin/public/starterror.js'];
            css_files = './info.freezr.public/freezr_style.css';
            other_variables = "var startup_errors = "+JSON.stringify(req.freezrStatus);
            break;
        default:
            script_files = ['./info.freezr.admin/'+ req.params.sub_page +'.js'];
            css_files = ['./info.freezr.admin/freezr_style.css', './info.freezr.admin/'+ req.params.sub_page +'.css'];
            break;
    }

    var options = {
        page_title: page_title? page_title: "Admin "+req.params.sub_page.replace('_',' ')+" (Freezr)",
        css_files: css_files,
        page_url: (isPublicPage? "public/":"") + (req.params.sub_page+'.html'),
        initial_query: initial_query,
        app_name: "info.freezr.admin",
        user_id:req.session.logged_in_user_id,
        user_is_admin:req.session.logged_in_as_admin,
        script_files: script_files,
        other_variables: other_variables? other_variables : (req.params.userid? ("var userid='"+req.params.userid+"';"):''),
        freezr_server_version: req.freezr_server_version,
        server_name: (helpers.startsWith(req.get('host'),"localhost")?"http":"https")+"://"+req.get('host')
    }

    if (isPublicPage && req.params.sub_page == "oauthvalidate") {
        oauth_validate(req, res);
    } else if (
        req.params.sub_page=="firstSetUp" &&
        req.freezr_environment.freezr_is_setup &&
        !req.session.logged_in_as_admin
        ) {
        res.redirect("/");
    } else if (!initial_query_func || isPublicPage) {
        file_handler.load_data_html_and_page(res,options)
    } else {
        req.freezrInternalCallFwd = function(err, results) {
            if (err) {
                options.success = false;
                options.error = err;
            } else {
                //onsole.log("queryresults ",results)
                options.queryresults = results;
            }
            file_handler.load_data_html_and_page(res,options)
        }
        initial_query_func(req,res);
    }
}

exports.user_register = function (req, res) {
    //onsole.log("Registering "+req.body.user_id);
    var uid = db_handler.user_id_from_user_input(req.body.user_id);
    var em = req.body.email_address;
    var fn = req.body.full_name;
    var isAdmin = req.body.isAdmin =="true";
    var register_type = req.body.register_type;
    function register_auth_error(message) {return helpers.auth_failure("admin_handler.js",exports.version,"register",message)}
    async.waterfall([
        function (cb) {
            if (req.session && req.session.logged_in_as_admin && register_type=="normal") {
                cb(null);
            } else if (!register_type) {
                cb(register_auth_error("Missing register type"));
            } else {
                cb(register_auth_error("Missing Admin preivelages"));
            }
        },

        function (cb) {
            if (em && !helpers.email_is_valid(em))
                cb(helpers.invalid_email_address());
            else if (!uid)
                cb(register_auth_error("Missing user id"));
            else if (!helpers.user_id_is_valid(uid))
                cb(register_auth_error("Invalid user id"));
            else if (!req.body.password)
                cb(register_auth_error("Missing password"));
            else
                cb(null);
        },


        // 2. check if person already exists
        function (cb) {
            exports.make_sure_user_is_unique(req.freezr_environment, uid, em, cb);
        },

        function (field_is_clear, arg2, cb) {
            if (field_is_clear) {
                cb(null)
            } else {
                cb(register_auth_error("name or email address exists") );
            }
        },

        // 3. register the user.
        function (cb) {
            var creator = register_type=="normal"? req.session.logged_in_user_id: "_self_";
            add_user(req.freezr_environment,  uid, req.body.password, em, fn, isAdmin, creator, cb);
        }
    ],
    function (err, user_json) {
        if (err) {
            helpers.send_failure(res, err,"admin_handler", exports.version,"register");
        } else {
            var u = new User(user_json);
            helpers.send_success(res, {user: u.response_obj() });
        }
    });
};

validExternalDbParams = function(params){
    // todo - make better checks
    return true;
}
validExternalFsParams = function(params){
    // todo - make better checks
    if (params.name && !params.access_token) return false;
    if (!params.name && params.access_token) return false;
    if (params.name && !fs.existsSync(file_handler.systemPathTo('freezr_system/environment/file_env_'+params.name+'.js'))) return false;
    return true;
}

exports.first_registration = function (req, callback) {
    helpers.log (req,"first time register (or resetting of parameters) for user :",req.body);
    var uid = db_handler.user_id_from_user_input(req.body.user_id);
    var isAdmin = true;
    var register_type = "setUp";

    function reg_auth_fail(message, errCode) {helpers.auth_failure("admin_handler", exports.version,"first_registration",message, errCode); }

    var init, user_json;
    var freezr_environment;
    var device_code = helpers.randomText(10);
    var users_exist_in_db = false;

    var temp_status = req.freezrStatus;

    var temp_environment = JSON.parse(JSON.stringify(req.freezr_environment));
    if (req.body.externalDb && Object.keys(req.body.externalDb).length > 0 && req.body.externalDb.constructor === Object) temp_environment.dbParams = req.body.externalDb;
    temp_environment.dbParams.unifiedDbName = req.body.unifiedDbName? (req.body.unifiedDbName.replace(/\ /g,"") ) : null;
    if (temp_environment.dbParams && !temp_environment.dbParams.connectionString && !temp_environment.dbParams.pass &&
        temp_environment.dbParams.user /* in case user is deleting all dbparams */ &&
        req.freezr_environment.dbParams.pass)
        temp_environment.dbParams.pass = req.freezr_environment.dbParams.pass;
    if (helpers.startsWith(temp_environment.dbParams.connectionString,"mongodb") ) {
        temp_environment.dbParams.dbtype = "localhost-mongo"
      } else if (temp_environment.dbParams.host == "localhost" ){
        temp_environment.dbParams.dbtype = "localhost-mongo"
      }
        // // TODO later  all params need to be checked and fleshed out
    //if (temp_environment.dbParams && temp_environment.dbParams.connectionString)
    if (req.body.externalFs && req.body.externalFs.name && req.body.externalFs.name!="glitch.com") temp_environment.userDirParams = req.body.externalFs ;
    if (!temp_environment.userDirParams.access_token &&
        temp_environment.userDirParams.name &&
        req.freezr_environment.userDirParams.access_token )
        temp_environment.userDirParams.access_token = req.freezr_environment.userDirParams.access_token;
    if (!temp_environment.userDirParams.name) temp_environment.userDirParams.name="local"
    if (req.freezr_environment.freezr_is_setup && !req.session.logged_in_user_id) {
        callback(reg_auth_fail("System is already initiated.", "auth-initedAlready"));
    } else if (!uid)
        callback(helpers.missing_data("user id"));
    else if (!helpers.user_id_is_valid(uid))
        callback(reg_auth_fail("Valid user id needed to initiate.","auth-invalidUserId"));
    else if (!req.body.password)
        callback(helpers.missing_data("password"));
    else if (req.body.externalDb && !validExternalDbParams(req.body.externalDb) )
        callback(reg_auth_fail("Database parameters are not correct","auth-invalidDbParams") );
    else if (req.body.unifiedDbName && !helpers.valid_unify_db_name(req.body.unifiedDbName) )
        callback(reg_auth_fail("Unfiied db name is invalid","auth-invalidUnifiedDbName"));
    else if (req.body.externalFs && !validExternalFsParams(req.body.externalFs) )
        callback(reg_auth_fail("File parameters are not correct","auth-invalidDbParams") );
    else {

        async.waterfall([
            function(cb) {
                if (req.freezr_environment.freezr_is_setup) {
                    checkIsCorrectFirstUser(uid, req.body.password, req, cb) //201906
                } else { cb(null) }
            },

            // File sys
            function (cb) {
                file_handler.init_custom_env(temp_environment, cb);
            },
            function (cb) {
                file_handler.writeTextToUserFile ("userapps", "test_write.txt", "Testing write on server", {fileOverWrite:true}, null, null, temp_environment, function (err) {
                    temp_status.can_write_to_user_folder = err? false:true;
                    if(err) {
                        // reset original parameters
                        temp_environment.userDirParams = req.freezr_environment.userDirParams;
                        file_handler.reset_freezr_environment(temp_environment);
                        file_handler.init_custom_env(temp_environment, function() {
                            helpers.warning("admin_handler", exports.version,"first_registration","failure to write to user folder - "+err);
                            cb(null)
                        });
                    } else { cb(null); }
                })
            },
            function (cb) {
                file_handler.setup_file_sys(temp_environment, cb)
            },

            // db set up and check
            function (cb) {
                db_handler.re_init_freezr_environment(temp_environment,cb);
            },
            function (cb) {
                //onsole.log("set env : "+JSON.stringify(temp_environment))
                db_handler.check_db(temp_environment, function (err, results) { // in case it has not been inited (and to make sure it exists)
                    if (err) {
                        // reset freezr environment
                        db_handler.set_and_nulify_environment(req.freezr_environment);
                        temp_status.can_read_write_to_db = false;
                        temp_environment.userDirParams = req.freezr_environment.userDirParams;
                        file_handler.reset_freezr_environment(temp_environment);
                        file_handler.init_custom_env(temp_environment, function(err2) {
                            cb(helpers.state_error("admin_handler", exports.version,"first_registration",helpers.error("db_write_error","Failure initialising database ("+err.message+")"),"db_write_error") );
                        });
                    } else {
                        temp_status.can_read_write_to_db = true;
                        cb(null)
                    }

                })
            },

            function (cb) {
                db_handler.all_users(temp_environment, (err, results) =>  {
                    if (err) {
                        temp_environment.dbParams = req.freezr_environment.dbParams;
                        db_handler.set_and_nulify_environment(temp_environment);
                        temp_status.can_read_write_to_db = false;
                        temp_environment.userDirParams = req.freezr_environment.userDirParams;
                        file_handler.reset_freezr_environment(temp_environment);
                        file_handler.init_custom_env(temp_environment, function(err2) {
                            cb(helpers.state_error("admin_handler", exports.version,"first_registration",helpers.error("db_error", "Failure to get the users  data-base  ("+JSON.stringify(err)+")" ),"db_error") );
                        });
                    } else if (results && results.length>0) {
                        if (req.freezr_environment.freezr_is_setup) {
                            // this is an update
                            users_exist_in_db = true;
                            cb(null)
                        } else {
                            temp_environment.dbParams = req.freezr_environment.dbParams;
                            db_handler.set_and_nulify_environment(temp_environment);
                            // keeping new file sys change.
                            db_handler.check_db(req.freezr_environment, function(err) {
                                cb(reg_auth_fail("Cannot reach database or system is already initiated with users.", "auth-initedAlready"));
                            })
                        }
                    } else {
                        cb(null)
                    }
                });
            },

            function (cb) {
                if (users_exist_in_db) {
                    cb(null);
                } else {
                    add_user(temp_environment, uid, req.body.password, null, null, true, "_self_", function (err, a_user_json) {
                        // valid_unique_user_id, password, valid_email, full_name, isAdmin, creator, callback
                        user_json = a_user_json;
                        if (err) {
                            db_handler.set_and_nulify_environment(temp_environment);
                            temp_status.can_read_write_to_db = false;
                            cb(helpers.state_error("admin_handler", exports.version,"first_registration", helpers.error("db_error", "Failure to add users to data-base  - "+JSON.stringify(err)+")" ),"db_error") );
                        } else {
                            cb(null)
                        }
                    });
                }
            },

            function (cb) {
                db_handler.set_or_update_user_device_code(temp_environment, device_code, req.body.user_id,  false, function (err, results) {
                    if (err) {
                        helpers.warning("admin_handler", exports.version,"first_registration", helpers.error("Failure to get a device code - "+err.message, "device_code_err"));
                        temp_status.other_errors = ["Could not set device code in first_registration"]
                    }
                    cb(null)
                });
            },

            function (cb) {
                // all should be well
                freezr_environment = temp_environment;
                freezr_environment.freezr_is_setup=true;
                freezr_environment.first_user = uid;
                file_handler.writeTextToUserFile ("userfiles", "freezr_environment.js", "exports.params=" + JSON.stringify(freezr_environment), {fileOverWrite:true}, null, null, freezr_environment, function (err) {
                    if(err) {
                        helpers.warning("admin_handler", exports.version, "first_registration", "error_writing_environment_to_external_fs "+err );
                    }
                    cb(null);
                });
            },


            function (cb) {
                // probably should keep a copy of old envs for security review purposes
                db_handler.write_environment(freezr_environment, function(err, results){
                    if (err) {
                        helpers.state_error("admin_handler", exports.version, "first_registration", err, "error_writing_environment_to_db" )
                        if (!temp_status.other_errors) temp_status.other_errors = [];
                        temp_status.other_errors.push("failure to write freezr_environment to database.")
                    }
                    cb(null)
                });
            }
        ], function (err) {
                if (err){
                    callback(err,{error:true, fstatus:temp_status});
                } else {
                    // no need to reset session if not
                    var u = null;;
                    if (user_json) u = new User(user_json);
                    if (register_type=="setUp") {
                        req.session.logged_in = true;
                        req.session.logged_in_user_id = db_handler.user_id_from_user_input(req.body.user_id);
                        req.session.logged_in_date = new Date();
                        req.session.logged_in_as_admin = true;
                        req.session.device_code = device_code;
                    }
                    callback(null, {success:true, user: (u? u.response_obj():null ), freezr_environment:freezr_environment , fstatus:temp_status})
                }
            }
        );
    }
};

exports.make_sure_user_is_unique = function (env_params, user_id, email_address, callback) {
    async.waterfall([
        function (cb) {
            if (user_id) {
                db_handler.user_by_user_id(env_params, user_id, cb);
            } else {
                cb(null, null, cb);
            }
        },

        function (user, arg2, cb) {
            if (user) {
                cb(helpers.auth_failure("admin_handler", exports.version, "make_sure_user_is_unique", "user id already exists" ));
            } else {
                cb(null, null, cb);
            }
        },

        function (user, arg2, cb) {
            if (user) {
                cb(helpers.auth_failure("admin_handler", exports.version, "make_sure_user_is_unique", "email already exists") );
            } else {
                cb(null, null, cb);
            }
        }
    ],
    function (err, exists) {
        if (err) {
            callback(err, false, callback)
        } else {
            callback(null, !exists, callback)
        }
    });
}
exports.list_all_users = function (req, res) {
    db_handler.all_users(req.freezr_environment, (err, results) => {
        if (err) {
            if (req.freezrInternalCallFwd) {
                req.freezrInternalCallFwd(err, {users: []})
            } else {
                helpers.send_internal_err_failure(res, "admin_handler", exports.version,"list_all_users","failure to get all user list - "+err);
            }
        } else {
            var out = [];
            if (results) {
                var temp = new User();
                for (var i = 0; i < results.length; i++) {
                    out.push(new User(results[i]).response_obj());
                }
            }
            if (req.freezrInternalCallFwd) {
                req.freezrInternalCallFwd(null, {users: out})
            } else {
                helpers.send_success(res, {users: out });
            }
        }
    });
};

exports.get_main_prefs = function (req, res) {
    db_handler.get_or_set_prefs (req.freezr_environment, "main_prefs", null, false, function (err, theprefs) {
        //onsole.log("got prefs in get_main_prefs ",theprefs)
        if (err) {
            if (req.freezrInternalCallFwd) {
                req.freezrInternalCallFwd(err, {})
            } else {
                helpers.send_internal_err_failure(res, "admin_handler", exports.version,"get_main_prefs","failure to get all user list - "+err);
            }
        } else {
            if (req.freezrInternalCallFwd) {
                req.freezrInternalCallFwd(null, theprefs)
            } else {
                helpers.send_success(res, theprefs);
            }
        }
    });
};
exports.change_main_prefs = function (req, callback) {
    helpers.log (req,("change_main_prefs :"+JSON.stringify (req.body)));

    var user_id = req.session.logged_in_user_id, freezr_prefs={};

    async.waterfall([
        // 0. checks
        function (cb) {
            if (!user_id || !req.session.logged_in_as_admin) {
                cb(helpers.auth_failure("admin_handler.js",exports.version,"change_main_prefs","Not admin"));
            } else if (!req.body.password) {
                cb(helpers.missing_data("password"));
            } else {
                cb(null)
            }
        },

        // 1. get user_id
        function (cb) {
            db_handler.user_by_user_id(req.freezr_environment, user_id, cb);
        },

        // 2. check the password
        function (user_json, dummy_cb, cb) {
            var u = new User(user_json);
            if (u.check_passwordSync(req.body.password)) {
                cb(null);
            } else {
                cb(helpers.auth_failure("admin_handler.js",exports.version,"change_main_prefs","Wrong password"));
            }
        },

        // 1. sanitize and set the prefs
        function (cb) {
            Object.keys(req.defaultPrefs).forEach(function(key) {
                freezr_prefs[key] = req.body[key] || req.defaultPrefs[key]
                if (req.body[key]===false)freezr_prefs[key] =false;
                //onsole.log(key, req.defaultPrefs[key]);
            });
            if (freezr_prefs.public_landing_page) freezr_prefs.public_landing_page = freezr_prefs.public_landing_page.trim();
            db_handler.get_or_set_prefs (req.freezr_environment, "main_prefs", freezr_prefs, true, callback)
            // todo - also check app list to make sure app exists
        },


    ],
    function (err) {
        //onsole.log("sending from admin new prefs "+freezr_prefs)
        callback(err, {message:"", newPrefs:freezr_prefs})
    });

}

var ALLOWED_ADMIN_COLLECTIONS = ['visit_log_daysum','visitLogFiles']
exports.dbquery = function(req,res) {
    helpers.log (req,("dbquery :"+JSON.stringify (req.body)));
    // need req.params.collection_name and req.body..
    const appcollowner = {
      app_name:'info_freezer_admin',
      collection_name:req.params.collection_name,
      _owner:'freezr_admin'
    }
    const query = req.body.query_params || {};

    db_handler.db_find (req.freezr_environment, appcollowner,
      req.body.query_params,
      {   count: req.body.count,
          skip:  req.body.skip
      },
      function (err, results) {
        if (err) {
            helpers.send_internal_err_failure(res, "admin_handler", exports.version,"dbquery","failure to query - "+err);
        } else {
            if (!results) results = []
            if (req.freezrInternalCallFwd) {
                req.freezrInternalCallFwd(null, {results: results})
            } else {
                helpers.send_success(res, {results: results});
            }
        }
      }
    )
};

function add_user (env_params, valid_unique_user_id, password, valid_email, full_name, isAdmin, owner, callback) {
    async.waterfall([
        // validate params
        function (cb) {
            if (!valid_unique_user_id)
                cb(helpers.missing_data("user_id", "admin_handler", exports.version,"add_user"));
            else if (!password)
                cb(helpers.missing_data("password", "admin_handler", exports.version,"add_user"));
            else if (!owner)
                cb(helpers.missing_data("owner", "admin_handler", exports.version,"add_user"));
            else
                bcrypt.hash(password, 10, cb);
        },

        // create the user in db.
        function (hash, cb) {
            var user_id = db_handler.user_id_from_user_input(valid_unique_user_id);
            var write = {
                _id: user_id,
                user_id: user_id,
                email_address: valid_email,
                full_name: full_name,
                isAdmin: isAdmin,
                password: hash,
                _owner:owner,
                _date_Created: new Date().getTime(),
                _date_Modified: new Date().getTime(),
                deleted: false
            };
            const appcollowner = {
              app_name:'info_freezer_admin',
              collection_name:"users",
              _owner:'freezr_admin'
            }
            db_handler.db_insert (env_params, appcollowner, null, write, null, cb)
        }
    ],
    function (err, results) {
        if (err) {
            callback(helpers.auth_failure("admin_handler.js",exports.version,"add_user","could not add user "+err));
        } else {
            callback(null);
        }
    });
};

// o-auth
var current_states = {};
const MAX_TIME = 30000;
var clean_intervaler = null;
exports.list_all_oauths = function (req, res) {
    //onsole.log("admin list_all_oauths via db_handler ")
    console.log("************ O_OATH NOT ERROR CHECKED SINCE V 0.0.122 (list_all_oauths) *****************")

    const appcollowner = {
      app_name:'info_freezer_admin',
      collection_name:"oauth_permissions",
      _owner:'freezr_admin'
    }
    db_handler.db_find(env_params, appcollowner, null,
      { count: req.body.count,
        skip:  req.body.skip,
        query_params: {enabled:true}
      }, (err, results) => {
        if (err) {
            helpers.send_internal_err_failure(res, "admin_handler", exports.version,"list_all_oauths","failure to get all user list - "+err);
        } else {
            if (!results) results = []
            if (req.freezrInternalCallFwd) {
                req.freezrInternalCallFwd(null, {results: results})
            } else {
                helpers.send_success(res, {results: results});
            }
        }
    });


};
exports.oauth_perm_make = function (req, res) {
    console.log("************ O_OATH NOT ERROR CHECKED SINCE V 0.0.122 (oauth_perm_make) *****************")
    helpers.log (req,"New or updated oauth for source "+req.body.source+" type: "+req.body.type+" name: "+req.body.name);
    function register_auth_error(message) {return helpers.auth_failure("admin_handler.js",exports.version,"oauth_register",message)}
    var collection = null; update=null;
    var is_update = req.body._id? true:false;
    const appcollowner = {
      app_name:'info_freezer_admin',
      collection_name:"oauth_permissions",
      _owner:'freezr_admin'
    }

    async.waterfall([
        // 1. Check if is admin
        function (cb) {
            if (req.session && req.session.logged_in_as_admin) {
                cb(null);
            } else {
                cb(register_auth_error("Missing Admin preivelages"));
            }
        },

        // 2. check if person already exists
        function (coll, cb) {
            collection = coll;
            if (is_update) {
              db_handler.db_getbyid(req.freezr_environment, appcollowner, req.body._id, cb)
            } else {
              db_handler.db_find (req.freezr_environment, appcollowner,
                                { source: req.body.source, type: req.body.type, name: req.body.name },
                                {}, cb)
            }
        },

        // 3. if exists update and if not write
        function (results, cb) {
            if (Array.isArray(results)) {if (results.length==0) {results=null} else {results=results[0]} }
            var params = {
                source: req.body.source,
                type: req.body.type,
                name: req.body.name,
                key: req.body.key,
                redirecturi: req.body.redirecturi,
                secret: req.body.secret,
                enabled: req.body.enabled
            }
            if (!results) {
                if (is_update) {
                  helpers.send_failure(res, helpers.error("Marked as update but no object found"),"admin_handler", exports.version,"oauth_make:item does not exist");
                } else {
                  update = "new"
                  db_handler.db_insert (req.freezr_environment, appcollowner, null, params, null, cb)
                }
            } else {
                update = "update" +(is_update?"":"_unplanned")
                db_handler.db_update (req.freezr_environment, appcollowner, results._id,
                  params, {replaceAllFields:true}, cb)
            }
        },

    ],
    function (err, results) {
        if (err) {
            helpers.send_failure(res, err,"admin_handler", exports.version,"oauth_make");
        } else {
            helpers.send_success(res, {written: update });
        }
    });
};
exports.oauth_do = function (req, res) {
    // app.get('/v1/admin/oauth/public/:dowhat', addVersionNumber, admin_handler.oauth_do);
    // dowhat can be: get_new_state or validate_state
    console.log("************ O_OATH NOT ERROR CHECKED SINE V 0.0.122 (oauth_do) *****************")
    helpers.log (req,"oauth_do "+req.params.dowhat)
    if (req.params.dowhat == "get_new_state") {
        // Gets a new state to start a third party authorization process
        // example is v1/admin/oauth/public/get_new_state?source=dropbox&&name=freezr&&sender=http://myfreezr.com/first_registration&&type=file_env
        var astate = null;
        var counter = 0, MAX_COUNT = 100;
        while (( counter == 0 || current_states[astate]) && counter++<MAX_COUNT) {
            astate = helpers.randomText(20);
        }
        if (counter++ > MAX_COUNT) {
            helpers.send_failure(res, exports.error("max count exceeded - too many states"),"admin_handler", exports.version,"oauth_do:get_new_state:maxcount");
        } else if (!req.query.source || !req.query.name || !req.query.type || !req.query.sender){
            helpers.send_failure(res, exports.error("Need source name type and sender to get a state "),"admin_handler", exports.version,"oauth_do:get_new_state:missing_data");
        } else {
            // create new record
            current_states[astate] = {
                ip: req.ip,
                date_created: new Date().getTime(),
                source: req.query.source,
                name: req.query.name,
                type: req.query.type,
                sender: req.query.sender
            }
            req.session.oauth_state = astate;
            get_auth_permission (req.freezr_environment, { source: req.query.source, type: req.query.type, name: req.query.name }, function (err, records) {
                if (err) {
                    helpers.send_failure(res, err,"admin_handler", exports.version,"oauth not available - "+err);
                } else if (!records || records.length==0) {
                    helpers.send_failure(res, helpers.error("No records found in oauth"),"admin_handler", exports.version,"oauth not available - no records");
                } else if (records[0].enabled) {
                    helpers.send_success(res, {state: astate, key:records[0].key})
                } else {
                    helpers.send_failure(res, helpers.error("unauthorized access to oauth"),"admin_handler", exports.version,"oauth unauthoried access");
                }
                clean_intervaler = setTimeout(clearStatesTimeOut,MAX_TIME)
            });
        }
    } else if (req.params.dowhat == "validate_state") {
        // allows third parties to validate that they have been authroized
        var state_params = current_states[req.session.oauth_state];
        async.waterfall([
            // 1. check oauth state
            function (cb) {
                if (!state_params) {
                    cb(helpers.auth_failure ("admin_handler", exports.version, "oauth_do:validate_state", "No auth state presented", "auth_error_no_state" ))
                } else if (req.session.oauth_state != req.query.state) {
                   cb(helpers.auth_failure ("admin_handler", exports.version, "oauth_validate_page", "state mismatch", "auth_error_state_mismatch" ))
                } else if (MAX_TIME <( (new Date().getTime()) - state_params.date_created)) {
                    cb(helpers.auth_failure ("admin_handler", exports.version, "oauth_validate_page", "state time exceeded", "auth_error_state_time_exceeded" ))
                } else {cb(null)}
            },
            // 2. get the permission
            function (cb) {
                //onsole.log("oauth_validate_page 1:"+state_params.source+", type: "+state_params.type+", name: "+state_params.name )
                get_auth_permission (req.freezr_environment, { source: state_params.source, type: state_params.type, name: state_params.name }, cb);
            },
            // 3. to make sure it is still enabled
            function (records, cb) {
                //onsole.log("oauth_validate_page "+JSON.stringify(records))
                if (!records || records.length==0) {
                    cb(helpers.auth_failure ("admin_handler", exports.version, "oauth_validate_page", "auth record does not exist", "auth_error_record_missing" ))
                } else if (!records[0].enabled) {
                    cb(helpers.auth_failure ("admin_handler", exports.version, "oauth_validate_page", "auth record is not enabled", "auth_error_record_disabled" ))
                } else {
                    //theRecord = records[0];
                    cb(null)
                }
            },
            // 2. ...
            function (cb) {
                helpers.log (req,"todo now - record the state in the db")
                cb(null)
            },
            function (cb) {
                // later check further permissions like allowed person
                cb(null)
            }
        ],
        function (err) {
            req.session.oauth_state = null;
            if (err) {
                helpers.send_failure(res, err,"admin_handler", exports.version,"oauth_do:get_new_state:collections")
            } else {
                //onsole.log("oauth_validate_page got state again ender is (2) "+state_params.sender)
                helpers.send_success(res, {'success':true, 'sender':state_params.sender, 'source':state_params.source});
            }
        });


    }
}
var clearStatesTimeOut = function() {
    clean_unused_states();
    clearTimeout(clean_intervaler);
}
var get_auth_permission = function (env_params, params, callback) {
  // { source: req.query.source, type: req.body.type, name: req.body.name }
  const appcollowner = {
    app_name:'info_freezer_admin',
    collection_name:"oauth_permissions",
    _owner:'freezr_admin'
  }
  db_handler.db_find(env_params, appcollowner,
      {source: params.source, type: params.type, name: params.name }, {}, callback)
}
var clean_unused_states = function () {
    helpers.log (null,"Clean out old states - todo")
}
var checkIsCorrectFirstUser = function(user_id,to_check_password,req, callback) {
    if (req.session.logged_in_user_id != user_id) {
        callback(helpers.auth_failure("admin_handler", exports.version, "checkIsCorrectFirstUser", "stated user id different from logged in user id", "user id mismatch" ))
    } else if  (!req.session.logged_in_as_admin || !req.session.logged_in_user_id) {
        callback(helpers.auth_failure("admin_handler", exports.version, "checkIsCorrectFirstUser", "Only first user amdinistrators can change the freezr parameters", "only_admins_allowed" ))
    } else if  (!req || !req.freezr_environment ||  !req.freezr_environment.first_user || req.freezr_environment.first_user!=user_id) {
        callback(helpers.auth_failure("admin_handler", exports.version, "checkIsCorrectFirstUser", "Only the first user of the freezr - the one who set it up - can change the freezr parameters", "only_1st_admin_allowed" ))
    } else {
        async.waterfall([
            // 1. get user
            function (cb) {
                db_handler.user_by_user_id(req.freezr_environment, user_id, cb);
            },
            // 2. check the password
            function (user_json, dummy_cb, cb) {
                var u = new User(user_json);
                if (u.check_passwordSync(to_check_password)) {
                    cb(null);
                } else {
                    cb(helpers.auth_failure("admin_handler",exports.version,"checkIsCorrectFirstUser","Wrong password", "wrong_password"));
                }
            }
        ],
        function (err) {
            callback(err)
        });
    }
}
