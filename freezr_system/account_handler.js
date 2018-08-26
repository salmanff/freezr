// freezr.info - nodejs system files - account_handler
exports.version = "0.0.122";

var helpers = require('./helpers.js'),
    freezr_db = require("./freezr_db.js"),
    user_obj = require("./user_obj.js"),
    async = require('async'),
    flags_obj = require("./flags_obj.js"),
    file_handler = require('./file_handler.js');

exports.generate_login_page = function (req, res) {
    // '/account/login' or '/account/applogin/login/:app_name'

    helpers.log (req,"login_page "+JSON.stringify(req.url) );

    if (req.session && req.session.logged_in_user_id && req.url=='/account/login' && req.freezr_is_setup)  { // last term relevant only if freezr preferences file has been deleted
        res.redirect("/account/home");
    } else {
        var options = {
            page_title: (req.params.app_name? "Freezr App Login for "+req.params.app_name : " Login (Freezr)"),
            css_files: './info.freezr.public/freezr_style.css',
            initial_query: null, 
            server_name: req.protocol+"://"+req.get('host'),
            freezr_server_version: req.freezr_server_version,
            app_name: (req.params.app_name? req.params.app_name:"info.freezr.account"),
            other_variables: "var login_for_app_name="+(req.params.app_name? ("'"+req.params.app_name+"';"):"null")+";" + " var loginAction = "+(req.params.loginaction? ("'"+req.params.loginaction+"';"):"null")+";" + " var freezrServerStatus = "+JSON.stringify(req.freezrStatus) +";"
        } 
        freezr_db.all_users("_date_Created", true, 0, null, function (err, results) {
            if (err && req.freezr_is_setup) {
                res.redirect('/admin/public/starterror');
            } else if ((err || !results || results.length==0) && !req.freezr_is_setup){
                res.redirect('/admin/public/firstSetUp');
            } else {
                if (!req.session) req.session = {};
                if (!req.session.device_code) {
                    req.session.device_code = helpers.randomText(10);
                    // todo later - Record device code below async-ly and keep track of all attempts to access 
                }
                if (results && results.length>0) {
                    options.app_name="info.freezr.public"
                    options.page_url='account_'+(req.params.app_name?'app':'')+'login.html';
                    options.script_files = ['./info.freezr.public/account_login.js'];

                    if (!req.freezr_is_setup) {
                        options.other_variables+=" var warnings='setupfile-resave';"
                    }
                    file_handler.load_data_html_and_page(res, options);
                } else {
                    helpers.send_failure(res, helpers.error("db failed","Could not find any users in the database. If you are a developer, this could be because you have deleted the database. If so, delete also the freezr_environment.js file. Other wise, your database may be corrupt, which is a very serious error."),"account_handler", exports.version,"generate_login_page");
                }
            }
        });
    }
};

exports.generate_applogin_results = function (req, res) {
    // /account/applogin/results
    //onsole.log("accounts generate_applogin_results params are "+JSON.stringify(req.params));
    var options = {
        page_title: "Freezr App Login Results (Freezr)",
        css_files: './info.freezr.public/freezr_style.css',
        initial_query: null,
        app_name: "info.freezr.account",
        other_variables: null,
        server_name : req.protocol+"://"+req.get('host'),
        page_url:'info.freezr.public/blankHtml.html',
        script_files: null
    } 
    file_handler.load_data_html_and_page(res, options);
};

exports.generateAccountPage = function (req, res) {
    // /account/:page
    helpers.log (req,"accountPage: "+req.url);
    if (!req.params.page) {req.params.page="home"} else {req.params.page= req.params.page.toLowerCase();}
    
    if (accountPage_Config[req.params.page]) {
        var options = accountPage_Config[req.params.page];
        options.app_name = req.params.app_name? req.params.app_name: "info.freezr.account";
        options.user_id =req.session.logged_in_user_id;
        options.user_is_admin =req.session.logged_in_as_admin;
        options.server_name = req.protocol+"://"+req.get('host');


        if (!options.initial_query_func) {
            file_handler.load_data_html_and_page(res,options)
        } else {
            req.freezrInternalCallFwd = function(err, results) {
                if (err) {
                    res.redirect("/admin/public/starterror");
                } else {
                    options.queryresults = results;
                    file_handler.load_data_html_and_page(res,options)
                }
            }
            options.initial_query_func(req,res);
        }


    } else {
        //onsole.log("SNBH - accountPage_Config - Redirecting from generateAccountPage")
        res.redirect("/account/home");
    }
};

// USER MANAGEMENT
exports.login = function (req, res) {
    // /v1/account/login 
    // "/v1/account/applogin"
    //onsole.log("login req host:"+req.hostname+" url"+req.url+" baseUrl "+req.baseUrl+" BODY "+JSON.stringify(req.body));
    var user_id = (req.body && req.body.user_id)? freezr_db.user_id_from_user_input(req.body.user_id): null;
    var source_app_code = null;

    async.waterfall([
        function (cb) {
            if (!user_id)
                cb(helpers.auth_failure("account_handler.js",exports.version,"login","Missing user id"));
            else if (!helpers.user_id_is_valid(user_id) )
                cb(helpers.auth_failure("account_handler.js",exports.version,"login","invalid user id"));
            else if (!req.body.password)
                cb(helpers.auth_failure("account_handler.js",exports.version,"login","Missing password"));
            else if (req.url=="/v1/account/applogin"  && !req.body.login_for_app_name)
                cb(helpers.auth_failure("account_handler.js",exports.version,"login","Trying to login to all apps via an app login interface."));
            else
                cb(null);
        },

        // 1. get user_id
        function (cb) {
            freezr_db.user_by_user_id(user_id, cb);
        },

        // 2. check the password
        function (user_json, dummy_cb, cb) {
            var u = new User(user_json);

            if (u.check_passwordSync(req.body.password)) {
                req.session.logged_in = true;

                req.session.logged_in_user_id = freezr_db.user_id_from_user_input(req.body.user_id);
                req.session.logged_in_date = new Date();
                req.session.logged_in_as_admin = u.isAdmin;

                if (req.body.login_for_app_name) {
                    req.session.login_type = "app";
                } else {
                    req.session.login_type = "all";
                }

                cb(null);

            } else {
                cb(helpers.auth_failure("account_handler.js",exports.version,"login","Wrong password"));
            }
        },

        // 3. Set or update device code
        function (cb) {
            freezr_db.set_or_update_user_device_code(req.session.device_code, user_id,  req.body.login_for_app_name, cb)
        },

        // 4. get an app_code (used for app_specific login only)
        function(results, cb) {
            if (req.body.login_for_app_name) {
                freezr_db.get_user_app_code(user_id, req.body.login_for_app_name, cb)
            } else {
                cb(null, null)
            }
        }
        
    ],
    function (err, source_app_code) {
        if (!err) {
            helpers.send_success(res, { logged_in: true , "login_for_app_name":req.body.login_for_app_name, 'source_app_code':source_app_code, 'user_id':user_id});
        } else {
            helpers.send_failure(res, err,"account_handler", exports.version,"login");
        }
    });
};
exports.ping = function (req, res) {
    // /v1/account/ping 
    //onsole.log("ping.."+JSON.stringify(req.query))
    if (!req.session.logged_in_user_id && !req.query.user_id) {
        helpers.send_success(res, { logged_in: false});
    } else if (req.query.user_id) {
        // also needs req.query.password, which has to be checked
        // check 
        async.waterfall([
            // 1. get user
            function (cb) {
                freezr_db.user_by_user_id(req.query.user_id, cb);
            },

            // 2. check the password
            function (user_json, dummy_cb, cb) {
                var u = new User(user_json);
                if (u.check_passwordSync(req.query.password)) {
                    cb(null);
                } else {
                    cb(helpers.auth_failure("account_handler.js",exports.version,"ping","Wrong password"));
                }
            },

            // 3. get code
            function(cb){
                freezr_db.get_or_set_user_app_code (req.session.logged_in_user_id,req.query.login_for_app_name, cb);
            }        
        ],
        function (err, results) {
            if (err) {
                helpers.send_success(res, { logged_in: false, 'freezr_server_version':req.freezr_server_version});        
            } else if (!results || !results.app_code) {
                helpers.send_success(res, { logged_in: true, 'login_for_app_name':req.query.login_for_app_name,  'logged_in_as_admin':req.session.logged_in_as_admin, 'user_id':req.session.logged_in_user_id, 'freezr_server_version':req.freezr_server_version, 'error':"error_getting_app_code"});               
            } else {
                 helpers.send_success(res, { logged_in: true, 'login_for_app_name':req.query.login_for_app_name,  'logged_in_as_admin':req.session.logged_in_as_admin, 'user_id':req.session.logged_in_user_id, 'freezr_server_version':req.freezr_server_version, 'source_app_code':results.app_code});       
            }
        });
    } else {
        var logged_in = (req.session.logged_in_user_id? true:false);
        helpers.send_success(res, { logged_in:  logged_in, 'logged_in_as_admin':req.session.logged_in_as_admin, 'user_id':req.session.logged_in_user_id, 'freezr_server_version':req.freezr_server_version, 'login_for_app_name':req.query.login_for_app_name});
    } 
};
exports.logout = function (req, res) {
    req.session.logged_in = false;
    req.session.logged_in_user_id = null;
    req.session.logged_in_date = null;
    req.session.logged_in_as_admin = false; 
    helpers.send_success(res, { 'logged_out': true });
}
exports.logout_page = function (req, res) {
    // /account/logout
    req.session.logged_in = false;
    req.session.logged_in_user_id = null;
    req.session.logged_in_date = null;
    req.session.logged_in_as_admin = false; 

    res.redirect("/account/login");
}
exports.changePassword = function (req, res) {
    // /v1/account/changePassword.json
    //onsole.log("Changing password  "+JSON.stringify(req.body));

    var user_id = req.body.user_id;
    async.waterfall([
        function (cb) {
            if (!user_id)
                cb(helpers.auth_failure("account_handler.js",exports.version,"changePassword","Missing user id"));
            else if (!req.body.oldPassword)
                cb(helpers.auth_failure("account_handler.js",exports.version,"changePassword","Missing old password"));
            else if (!req.body.newPassword)
                cb(helpers.auth_failure("account_handler.js",exports.version,"changePassword","Missing new password"));
            else
                cb(null);
        },

        // 1. get user record
        function (cb) {
            freezr_db.user_by_user_id(user_id, cb);
        },

        // 2. check the password
        function (user_json, dummy_cb, cb) {
            var u = new User(user_json);
            if (u.check_passwordSync(req.body.oldPassword)) {
                cb(null);
            } else {
                cb(helpers.auth_failure("account_handler.js",exports.version,"changePassword","Wrong password"));
            }
        },

        // 3. change pw for the user.
        function (cb) {
            freezr_db.changeUserPassword(
                req.body.user_id,
                req.body.newPassword,
                cb);
        }
    ],
    function (err, user_json) {
        if (err) {
            helpers.send_failure(res, err,"account_handler", exports.version,"changePassword");
        } else {
            var u = new User(user_json);
            helpers.send_success(res, {user: u.response_obj() });
        }
    });
};
exports.list_all_user_apps = function (req, res) {
    // /v1/account/app_list.json
    var user_id = req.session.logged_in_user_id;
    var removed_apps = [], user_apps = [], new_apps = [];
    var user_app_names = [], removed_app_names = [];
    async.waterfall([
        // 1. check basic data exists
        function (cb) {
            if (!user_id) 
                cb(helpers.missing_data("user_id"));
            else
                cb(null);
        },

        // 2. get all user apps, and add the names to the appropriate lists
        function(cb) {
            freezr_db.all_user_apps(user_id, null, true, 0, null, cb);
        },
        function(results, cb) {
            if (results && results.length>0) {
                for (var i =0; i<results.length; i++) {
                    if (results[i].removed) {
                        removed_app_names.push(results[i].app_name)
                    } else {
                        user_app_names.push(results[i].app_name);
                    }
                }
            }
            cb(null);
        },

        // 3. get all apps, and match the records to the right list
        function(cb) {
            freezr_db.all_apps(null, true, 0, null, cb);
        },
        function(results, cb) {
            if (results && results.length>0) {
                for (var i =0; i<results.length; i++) {
                    if (results[i].app_name && results[i].app_name == results[i].display_name) {results[i].display_name = results[i].display_name.replace(/\./g, '. ')}
                    results[i].logo = "/app_files/"+results[i].app_name+"/static/logo.png";
                    if (removed_app_names.indexOf(results[i].app_name)>=0) {
                        removed_apps.push(results[i])
                    } else if (user_app_names.indexOf(results[i].app_name)>=0) {
                        user_apps.push(results[i])
                    } else {
                        new_apps.push(results[i]);
                    }
                }
            }
            cb(null);
        }
    ],
    function (err, user_json) {
        if (err) {
            if (req.freezrInternalCallFwd) {
                req.freezrInternalCallFwd(err, null)
            } else {
                helpers.send_failure(res, err,"account_handler", exports.version,"list_all_user_apps");
            }
        } else {
            if (req.freezrInternalCallFwd) {
                req.freezrInternalCallFwd(null, {removed_apps:removed_apps, user_apps:user_apps, new_apps:new_apps})
            } else {
                helpers.send_success(res, {removed_apps:removed_apps, user_apps:user_apps, new_apps:new_apps});
            }
        }
    });
};
exports.add_uploaded_app_zip_file = function (req, res) {
    // app.put ('/v1/account/upload_app_zipfile.json', requireUserRights, uploadAppZipFile); 
    helpers.log (req,"add_uploaded_app_zip_file body") //+JSON.stringify(req.body));

    var app_name, app_path, app_version=null; app_display_name=null;
    var flags = new Flags({});
 
    async.waterfall([
    // 1. make sure data and file names exist
        function (cb) {
            if (!req.session.logged_in_user_id) 
                cb(helpers.missing_data("user_id"));
            else if (!req.session.logged_in_as_admin)
                helpers.auth_failure("account_handler", exports.version,"add_uploaded_app_zip_file","Could not add apps without admin privelages.");
            else if (!req.file)
                cb(helpers.missing_data("file","account_handler", exports.version, "add_uploaded_app_zip_file"));
            else if (!req.file.originalname)
                cb(helpers.missing_data("file name","account_handler", exports.version, "add_uploaded_app_zip_file"));
            else if (req.file.originalname.length<5 || req.file.originalname.substr(-4) != ".zip")
                cb(helpers.invalid_data("file name not zip: "+req.file.originalname, "account_handler", exports.version, "add_uploaded_app_zip_file"));
            else
                cb(null);
        },

    // 2. Make sure it is a zip file and extract the app_name
        function (cb) {

            var parts = req.file.originalname.split('.');
            if (helpers.endsWith(parts[(parts.length-2)],"-master")) parts[(parts.length-2)] = parts[(parts.length-2)].slice(0,-7);

            if (helpers.startsWith((parts[(parts.length-2)]),"_v_")) {
                app_version = parts[parts.length-2].slice(3);
                parts.splice(parts.length-2,2);
            } else {
                parts.splice(parts.length-1,1);
            }
            app_name = parts.join('.');
            app_name = app_name.split(' ')[0];
            
            if (app_name.length<1) {
                cb(helpers.invalid_data("app name missing - that is the name of the app zip file name before any spaces.", "account_handler", exports.version, "add_uploaded_app_zip_file"));
            } else if (!helpers.valid_app_name(app_name)) {    
                cb(helpers.invalid_data("app name: "+app_name, "account_handler", exports.version, "add_uploaded_app_zip_file"));
            } else if (helpers.system_apps.indexOf(app_name)>-1  || !helpers.valid_app_name(app_name)){
                cb(helpers.invalid_data("app name not allowed: "+app_name, "account_handler", exports.version, "add_uploaded_app_zip_file"));
            } else {    
                flags = new Flags({'app_name':app_name,'didwhat':'installed'});    
                cb(null);
            }
        },

    // 3. Make sure app directory exists
        function (cb) {
            file_handler.checkExistsOrCreateUserAppFolder(app_name, req.freezr_environment, cb);
        },

    // 4. Extract Zip File Contents
        function (cb) {
            file_handler.extractZippedAppFiles(req.file.buffer, app_name, req.file.originalname, req.freezr_environment, cb);
        },

        // 5a. Get and check app_config (populate app_version and app_display_name and permissons)
        function (cb) {
            file_handler.async_app_config(app_name, req.freezr_environment,cb);
        },
        // 5b. make sure all data exits
        function (app_config, cb) {
            if (app_config)  {
                if (!app_version && app_config.meta && app_config.meta.app_version) app_version = app_config.meta.app_version;
                if (app_config && app_config.meta && app_config.meta.app_display_name) app_display_name = app_config.meta.app_display_name;
                flags = file_handler.check_app_config(app_config, app_name, app_version, flags);
            } else {
                flags.add('notes','appconfig_missing');
            }
            if (!app_display_name) app_display_name = app_name;
            if (!app_version) app_version = 1;

            if (app_config) {
                freezr_db.update_permission_records_from_app_config(app_config, app_name, req.session.logged_in_user_id, flags, cb);
            } else {
                cb(null, null)
            }
        }, 

        // 6. Go through files and Sensor the code
        function (newflags, cb) {
            flags = newflags? newflags:flags;
            file_handler.sensor_app_directory_files(app_name, flags, req.freezr_environment, cb);
        },

        // 7. See if app exists
        function (newflags, dummy, cb) {
            if (newflags && Object.keys(newflags).length > 0) flags = newflags;
            freezr_db.get_app_info_from_db(app_name, cb);
        },

        // 8. If app already exists, flag it as an update
        function (app_info, cb) {
            if (app_info) {
                flags.add('notes',"app_updated_msg");
                flags.meta.didwhat = "updated (from uploaded files)";
                if (app_info.display_name != app_display_name) {
                    cb(null, null)
                } else {
                    cb(null, null)
                }
            } else {
                flags.meta.didwhat = "uploaded";
                freezr_db.add_app(
                    app_name,
                    app_display_name,
                    req.session.logged_in_user_id,
                    cb);
            }
        },

        function(app_info, cb) {
            if (flags.meta.didwhat == "uploaded") {
                freezr_db.get_or_set_user_app_code(req.session.logged_in_user_id,app_name, cb);
            } else {
                cb (null, null);
            }

        }

        // todo later (may be) - also check app_confg permissions (as per changeNamedPermissions) to warn of any issues
     ],
    function (err, dummy) {
        // todo: if there is an error in a new app_config the previous one gets wied out but the ap still runs (as it was instaled before successfully), so it should be marked with an error.
        // todo: also better to wipe out old files so old files dont linger if they dont exist in new version
        flags.meta.app_name = app_name;
        if (err) {
            // todo later: perhaps delete the zip file
            if (!err.code) err.code = 'err_unknown';
            flags.add('errors', err.code, {'function':'add_uploaded_app_zip_file', 'text':err.message});
        }
        //onsole.log(flags)
        helpers.send_success(res, flags.sentencify() );
    });
}
exports.appMgmtActions  = function (req,res) /* deleteApp updateApp */ {
    // /v1/account/appMgmtActions.json
    console.log("At app mgmt actions "+JSON.stringify(req.body));
    var action = (req.body && req.body.action)? req.body.action: null;
    var app_name = (req.body && req.body.app_name)? req.body.app_name: null;
    var user_id = req.session.logged_in_user_id;
    var app_version=null; 
    
    if (action == 'removeApp') {
        if (user_id) {
            freezr_db.remove_user_app(user_id, app_name, function(feedback) { helpers.send_success(res, feedback)});
        } else {
            helpers.send_auth_failure(res, "account_handler", exports.version,"appMgmtActions","Could not remove app without user.","auth_noUser");
        }
    } else if (action == 'deleteApp') {
        if (user_id) {
            // remove all data
            freezr_db.try_to_delete_app(user_id, app_name, req.freezr_environment, function(err, feedback) { 
                if (err) {
                    helpers.send_internal_err_failure(res, "freezr_db", freezr_db.version, "try_to_delete_app", "Internal error trying to delete app. App was not deleted." ) 
                } else {
                    console.log("success in deleting app")
                    helpers.send_success(res, {success: true})
                }
            });
        } else {
            helpers.send_auth_failure(res, "account_handler", exports.version,"appMgmtActions","Could not remove app without admin privelages.","auth_notAdmin");
        }
    } else if (action == 'updateApp') {
        var flags = new Flags({'app_name':app_name});
        var app_config, app_display_name=null;
        //var app_path = app_name? file_handler.fullPathToUserLocalAppFiles(app_name): null;

        async.waterfall([
            // updateApp 1. make sure data and file names exist
            function (cb) {
                if (!req.session.logged_in_user_id) 
                    cb(helpers.missing_data("user_id"));
                else if (!req.session.logged_in_as_admin)
                    helpers.auth_failure("account_handler", exports.version,"appMgmtActions","Could not update app without admin privelages.");
                else if (!app_name)
                    cb(helpers.invalid_data("missing app name", "account_handler", exports.version,"appMgmtActions"));
                else if (!helpers.valid_app_name(app_name))   
                    cb(helpers.invalid_data("app name: "+app_name, "account_handler", exports.version,"appMgmtActions"));
                else
                    cb(null);
            },

            // updateApp 2a. Make sure app directory exists
            function (cb) {
                file_handler.checkExistsOrCreateUserAppFolder(app_name, req.freezr_environment, cb);
            },
            // updateApp 2b. clear app FSCache if need be
            function (cb) {
                file_handler.clearFSAppCache(app_name, req.freezr_environment, cb);
            },


            // 3a. Get and check app_config (populate app_version and app_display_name and permissons)
            function (cb) {
                    file_handler.async_app_config(app_name, req.freezr_environment,cb);
                },
            // 3b. make sure all data exits
            function (app_config, cb) {
                if (app_config)  {
                    if (!app_version && app_config.meta && app_config.meta.app_version) app_version = app_config.meta.app_version;
                    if (app_config && app_config.meta && app_config.meta.app_display_name) app_display_name = app_config.meta.app_display_name;
                    flags = file_handler.check_app_config(app_config, app_name, app_version, flags);
                } else {
                    flags.add('notes','appconfig_missing');
                }
                if (!app_display_name) app_display_name = app_name;
                if (!app_version) app_version = 1;

                if (app_config) {
                    freezr_db.update_permission_records_from_app_config(app_config, app_name, req.session.logged_in_user_id, flags, cb);
                } else {
                    cb(null, null)
                }
            },

            // 4. Go through files and Sensor the code
            function (newflags, cb) {
                flags = newflags? newflags:flags;
                file_handler.sensor_app_directory_files(app_name, flags, req.freezr_environment, cb);
            },

            // 5. see if app is already in db
            function (newflags, dummy, cb) { 
                if (newflags && Object.keys(newflags).length > 0) flags = newflags;

                if (helpers.valid_app_name(app_name)) {    
                    freezr_db.get_app_info_from_db(app_name, cb);
                } else {
                    cb(helpers.invalid_data("app name: "+app_name, "account_handler", exports.version, "appMgmtActions"));
                }
            },

            // 6. If app already exists, flag it as an update
            function (app_info, cb) {
                if (app_info) {
                    flags.add('notes',"app_updated_msg");
                    flags.meta.didwhat = "updated (from files in directory)";
                    if (app_info.display_name != app_display_name) {
                        // todo - should update display name
                        cb(null, null)
                    } else {
                        cb(null, null)
                    }
                } else {  //add to directory");
                    flags.meta.didwhat = "installed";
                    freezr_db.add_app(
                        app_name,
                        app_display_name,
                        req.session.logged_in_user_id,
                        cb);
                }
            },


            function(app_info, cb) {
                if (flags.meta.didwhat == "installed") {
                    freezr_db.get_or_set_user_app_code(req.session.logged_in_user_id,app_name, cb);
                } else {
                    cb (null, null);
                }
            }
        ],
        function (err) {
            flags.meta.app_name = app_name;
            if (err) {
                flags.add('errors','err_unknown',{'function':'appMgmtActions update', 'text':JSON.stringify(err)});
            } 
            console.warn(flags)
            helpers.send_success(res, flags.sentencify() );
        });

    } else {
        helpers.send_failure(res, err,"account_handler", exports.version,"appMgmtActions");

    }
}


// PERMISSSIONS
exports.changeNamedPermissions = function(req, res) {
    //app.put ('/v1/permissions/change/:requestee_app/:source_app_code', userDataAccessRights, account_handler.changePermissions); 
    helpers.log (req,"changePermissions "+JSON.stringify(req.body));
    
    if (req.body.changeList && req.body.changeList.length==1 && req.body.changeList[0].permission_name && req.body.changeList[0].action && req.body.changeList[0].permission_object) {
        var permission_name = req.body.changeList[0].permission_name;
        var action = req.body.changeList[0].action;
        var permission_object = req.body.changeList[0].permission_object;

        var requestee_app = req.params.requestee_app;
        var requestor_app  = (permission_object && permission_object.requestor_app)? permission_object.requestor_app: requestee_app;
        
        var app_config, app_config_permissions, schemad_permission;
                        

        async.waterfall([
            // 0 get app config
            function (cb) {
                file_handler.async_app_config(requestor_app, req.freezr_environment,cb);
            },
            // 1. Check all data needed exists 
            function (the_app_config, cb) {
                app_config = the_app_config;
                
                app_config_permissions = (app_config && app_config.permissions && Object.keys(app_config.permissions).length > 0)? JSON.parse(JSON.stringify( app_config.permissions)) : null;
                schemad_permission = freezr_db.permission_object_from_app_config_params(app_config_permissions[permission_name], permission_name, requestee_app, requestor_app);
                if (schemad_permission && schemad_permission.type == "folder_delegate") permission_object.collection="files";
                if (schemad_permission && (typeof schemad_permission.sharable_groups == "string" || !isNaN(schemad_permission.sharable_groups))) schemad_permission.sharable_groups = [schemad_permission.sharable_groups];

                //onsole.log("Schemad permission is "+JSON.stringify(schemad_permission))
        
                if (!schemad_permission) {
                    cb(helpers.missing_data("No permission schema exists"));
                } else if (!helpers.valid_permission_name(permission_name)  ) {
                    cb(helpers.invalid_data("Invalid permission name: "+permission_name+".","account_handler", exports.version, "changeNamedPermissions"));                
                } else if (helpers.permitted_types.type_names.indexOf(schemad_permission.type)<0  ) {
                    cb(helpers.invalid_data("Permitted types can only be specific types not "+schemad_permission.type+".","account_handler", exports.version, "changeNamedPermissions"));                
                } else if (schemad_permission.type == "object_delegate" && helpers.permitted_types.groups_for_objects.indexOf(schemad_permission.sharable_groups[0])<0  ) {
                    cb(helpers.invalid_data("Object delegates can only have specified sharable groups, not "+schemad_permission.sharable_groups[0]+".","account_handler", exports.version, "changeNamedPermissions"));                    
                } else if (schemad_permission.sharable_groups && schemad_permission.sharable_groups.length>1  ) {
                    cb(helpers.invalid_data("Only one sharable_group can be permissioned now "+schemad_permission.sharable_groups.join(',')+".","account_handler", exports.version, "changeNamedPermissions"));                    
                } else if ((schemad_permission.type == "folder_delegate" || schemad_permission.type == "field_delegate") && helpers.permitted_types.groups_for_fileds.indexOf(schemad_permission.sharable_groups[0])<0  ) {
                    cb(helpers.invalid_data("Field / folder delegates can only have specified sharable groups, not "+schemad_permission.sharable_groups[0]+".","account_handler", exports.version, "changeNamedPermissions"));                    
                } else if (schemad_permission.sharable_groups=="public" && schemad_permission.requestee_app !=schemad_permission.requestor_app) {
                    cb(helpers.invalid_data("you can only make data public via its own app","account_handler", exports.version, "changeNamedPermissions"));                    
                } else if (permission_name && (action && permission_object && requestor_app && requestee_app && (permission_object.collection || (schemad_permission && schemad_permission.type == "object_delegate" && permission_object.collections) )  || (schemad_permission && schemad_permission.type == "outside_scripts" && schemad_permission.script_url && helpers.startsWith(schemad_permission.script_url,"http") )  ) ) {
                    cb(null)
                } else {
                    cb(helpers.missing_data("permission related data"));
                } 
            },

            // 2. Check user App Code 
            function (cb) {
                freezr_db.check_app_code(req.session.logged_in_user_id, requestee_app, req.params.source_app_code, cb); 
            },

            // 3. get current permission record
            function (cb) {
                freezr_db.permission_by_owner_and_permissionName(req.session.logged_in_user_id, requestor_app, requestee_app, permission_name, cb);
                    //onsole.log("getting existing perm: req.session.logged_in_user_id:"+req.session.logged_in_user_id+", requestor_app:"+requestor_app+", requestee_app:"+requestee_app+", permission_name:"+permission_name)
            },

            // 4. Make sure of validity and update permission record
            function (results, cb) {
                if (results.length == 0) {
                    helpers.warning ("account_handler", exports.version, "changeNamedPermissions","SNBH - permissions should be recorded already via app_config set up");
                    freezr_db.create_query_permission_record(req.session.logged_in_user_id, requestor_app, requestee_app, permission_name, permission_object, action, cb);
                } else {
                    if (results.length > 1) {
                        freezr_db.deletePermission(results[1]._id, null);
                        helpers.internal_error ("account_handler", exports.version, "changeNamedPermissions","SNBH - more than 1 result");
                    }
            
                    if (schemad_permission && (action == "Accept" || action=="Deny" ) ) {
                        freezr_db.updatePermission(results[0], action, schemad_permission, cb);
                    } else if (action == "Deny" && results[0].outDated) { 
                        helpers.warning ("account_handler", exports.version, "changeNamedPermissions","ERR now REMOVED AS OUTDATED");
                        freezr_db.deletePermission(results[0]._id, cb);
                    } else {
                        cb(helpers.invalid_data("action must be 'Accept' or 'Deny' only - SNBH","account_handler", exports.version, "changeNamedPermissions"));
                    }
                }
            },

            // 5.  
            function (results, cb) {
                if (action == "Accept") {
                    cb(null, {aborted:false})
                } else {
                    removeAllAccessibleObjects(req.session.logged_in_user_id, requestor_app, requestee_app, permission_name, cb);
                }

            },
        ], 

        function (err, success) {
            if (err) {
                helpers.send_failure(res, err,"account_handler", exports.version,"changeNamedPermissions");
            } else { 
                // check - to delete
                helpers.send_success(res, {success: true, 'permission_name':permission_name  , 'buttonId':req.body.changeList[0].buttonId, 'action':action, 'aborted':success.aborted, 'flags':success.flags});
            }
        });

    } else {
        helpers.send_failure(res, helpers.invalid_data,("One request at a time can be accepted."),"account_handler", exports.version,"changeNamedPermissions"); 
    }
}
removeAllAccessibleObjects = function(user_id, requestor_app, requestee_app, permission_name, callback) {
    // assumes error checking all done
    var flags = new Flags({'function':'removeAllAccessibleObjects'});
    var collection_list = [], collections_affected = {}, warning_list= [], accessibles_collection; 
    // collections_affected => { collection1:[id1, id2] , collection2:[id3,id4] }
    //  get app_config and colelctions_affected addasunique (collections in app_config) //redundancy

    async.waterfall([
    // 1.  get all accessibles collection
    function (cb) {
        freezr_db.app_db_collection_get("info_freezr_permissions" , "accessible_objects", cb);
    },
    // 2.  get all relevant objects
    function (theCollection, cb) {
        if (!theCollection) cb(helpers.error("db access error","could not access info_freezr_permissions from removeAllAccessibleObjects"))
        accessibles_collection = theCollection;
        accessibles_collection.find({_owner:user_id, permission_name: permission_name, requestor_app: requestor_app, granted:true}).toArray(cb)
    },
    // 3. Set granted=false to all accessibles and create nice lists for future actions
    function (results, cb) {
        if (!results || results.length==0) {
            cb(null)
        } else {
            results.forEach(function (acc_obj){
                if (!collections_affected[acc_obj.collection_name]) {
                    collections_affected[acc_obj.collection_name]=[];
                    collection_list.push(acc_obj.collection_name);
                }
                collections_affected[acc_obj.collection_name].push(acc_obj.data_object_id);
            })
            //onsole.log({collections_affected})
            async.forEach(results, function (acc_obj, cb2) {
                //onsole.log("setting "+acc_obj._id)
                accessibles_collection.update({_id: acc_obj._id },
                    {$set: {granted:false, '_date_Modified' : (new Date().getTime())}  }, {safe: true }, cb2);
                },
                function (err) {
                    if (err) {
                        console.warn("Got an err  of removeAllAccessibleObjects "+JSON.stringify(err))
                        flags.add('major_warnings','accessibles_collection_update',{err:err,'function':'removeAllAccessibleObjects','async-part':3, 'message':'uknown error updating accessibles.'})
                    } 
                    cb(null)
                }
            )
        }
    },

    // 4. remove the relevant _accessible_By indicator of the actual objects  
    function (cb) {
        var db_collection;
        async.forEach(collection_list, function (collection_name, cb2) {
            if (collection_name) {
                //onsole.log("getting collection name "+collection_name+" from requestee_app "+requestee_app)
                freezr_db.app_db_collection_get(requestee_app.replace(/\./g,"_") , collection_name, 
                    function (err, theCollection) {
                        if (err) {
                            flags.add('major_warnings','data_object_update',{err:err,'function':'removeAllAccessibleObjects','async-part':4,'collection_name':collection_name,'message':'error geting collection '+collection_name});
                            cb2(null);
                        } else {
                            db_collection = theCollection;
                            what_to_find = {"_accessible_By.group_perms.public": requestor_app+"/"+permission_name};
                                // later add or for other sharable gorups, base don app_config (ie do || for all permitted groups)
                            //onsole.log({what_to_find})
                            db_collection.find(what_to_find).toArray(function(err, results){
                                if (err) {
                                    flags.add('major_warnings','data_object_update',{err:err,'function':'removeAllAccessibleObjects','async-part':4, 'perm':requestor_app+"/"+permission_name,'message':'error geting data object for '+requestor_app+"/"+permission_name});
                                    cb2(null);
                                } else if (!results || results.length==0){
                                    flags.add('minor_warnings_data_object','data_object_update',{err:err,'function':'removeAllAccessibleObjects','async-part':4, 'perm':requestor_app+"/"+permission_name,'message':'No data objects present for '+requestor_app+"/"+permission_name});
                                    cb2(null);                                    
                                } else {
                                    async.forEach(results, function (anObject, cb3) { 
                                        var newAccessibleBy = anObject._accessible_By;
                                        if (!newAccessibleBy) {
                                            flags.add('minor_warnings_data_object','data_object_update',{err:err,'function':'removeAllAccessibleObjects','async-part':4,'data_object_id':anObject._id, 'perm':requestor_app+"/"+permission_name,'message':'No _accessible_By present for '+requestor_app+"/"+permission_name+" in object "+anObject._id});
                                            cb3(null);                                    
                                        } else if (!newAccessibleBy.group_perms || !newAccessibleBy.group_perms.public  || newAccessibleBy.group_perms.public.indexOf(requestor_app+"/"+permission_name)<0) {
                                            flags.add('minor_warnings_data_object','data_object_update',{err:err,'function':'removeAllAccessibleObjects','async-part':4,'data_object_id':anObject._id, 'perm':requestor_app+"/"+permission_name,'message':'No permission_name found in _accessible_By for '+requestor_app+"/"+permission_name+" in object "+anObject._id});
                                            cb3(null);                                    
                                        } else {
                                            var idx = newAccessibleBy.group_perms.public.indexOf(requestor_app+"/"+permission_name);
                                            newAccessibleBy.group_perms.public.splice(idx,1);
                                            if (newAccessibleBy.group_perms.public.length== 0) {
                                                idx = newAccessibleBy.groups.indexOf("public");
                                                if (idx>=0) newAccessibleBy.groups.splice(idx,1) // should always be the case
                                            }
                                            idx = collections_affected[collection_name].indexOf(requestor_app+"/"+permission_name);
                                            if (idx>=0) collections_affected[collection_name].splice(idx,1) // should always be the case
                                            db_collection.update({_id: anObject._id },
                                                {$set: {'_date_Modified' : (new Date().getTime())}  }, {safe: true }, cb3);
                                        }
                                    },
                                    function (err) {
                                        if (err) {
                                            console.warn("Got an err in (a) within object retrieavel of removeAllAccessibleObjects "+JSON.stringify(err))
                                            warning_list.push("'unkown_error_removing_accessible_indiccator': "+JSON.stringify(err));
                                        } 
                                        cb2(null)
                                    })
                                }

                            }) 
                        }
                    }
                );  
            } else {
                flags.add('minor_warnings_data_object','data_object_update',{err:{'message':'missing colelction name - SNBH - possible internal error'},'function':'removeAllAccessibleObjects','async-part':4})
                cb2(null);
            }

        },
        function (err) {
            if (err) {
                console.warn("Got an err within collection getting of removeAllAccessibleObjects "+JSON.stringify(err))
                flags.add('major_warnings','data_object_update',{err:err,'function':'removeAllAccessibleObjects','async-part':4, 'message':'uknown error updating data_object.'})
            } 
            cb(null)
        }
        )
    },
    ], 

    function (err) {
        //onsole.log("removeAllAccessibleObjects" + JSON.stringify(flags));
        if (err) {
            callback(err, {aborted:true, 'flags':flags} )
        } else {  
            callback(null, {aborted:false, flags:flags} )
        }
    });
}
exports.all_app_permissions = function(req, res) {
    // app.get('/v1/permissions/getall/:requestee_app/:source_app_code', userDataAccessRights, account_handler.all_app_permissions);
    // Need to check requested permissions in app config against granted permissions
    // check by name and also make sure that it has not changed...
    //onsole.log("all_app_permissions")

        var requestee_app = req.params.requestee_app;
        var returnPermissions = [], user_permissions_to_add=[], user_permissions_to_delete=[], user_permissions_changed=[];
        var app_config;

        async.waterfall([
            // check app code
            function (cb) {
                freezr_db.check_app_code(req.session.logged_in_user_id, requestee_app, req.params.source_app_code, cb); 
            },

            // get app config
            function (cb) {
                file_handler.async_app_config(requestee_app, req.freezr_environment,cb);
            },
            // get all_userAppPermissions -
            
            function (the_app_config, cb) {
                app_config = the_app_config;
                freezr_db.all_userAppPermissions(req.session.logged_in_user_id, requestee_app, cb);
            },


            function (all_userAppPermissions, cb) {
                // mini-hack for development only - in case app hasnt been registered or is updated offline, go to the app config to get the needs and check that they are all there and aer uptodate
                // Can remove this for non-developers
                //
                var app_config_permissions = (app_config && app_config.permissions && Object.keys(app_config.permissions).length > 0)? JSON.parse(JSON.stringify( app_config.permissions)) : null;
                var permission_name="", schemad_permission;
                
                for (var i=0; i<all_userAppPermissions.length; i++) {

                    aPermission = all_userAppPermissions[i];
                    
                    permission_name = all_userAppPermissions[i].permission_name;

                    if (aPermission.requestor_app !=requestee_app) {
                        // Other apps have requested permission - just add them
                        // Need to check changes here.
                        returnPermissions.push(aPermission);
                    } else if (app_config_permissions && app_config_permissions[permission_name]) {
                        schemad_permission = freezr_db.permission_object_from_app_config_params(app_config_permissions[permission_name], permission_name, requestee_app)
                        if (freezr_db.permissionsAreSame(aPermission,schemad_permission)) {
                            returnPermissions.push(aPermission);
                        // todo - if not the same then should at least update the old stored permission so itis in the future? to review
                        } else if (aPermission.granted){ // permissions generated but not the same
                            aPermission.granted = false;
                            aPermission.outDated = true;
                            returnPermissions.push(schemad_permission);
                            user_permissions_changed.push(schemad_permission);
                        } else if (aPermission.denied) { // aready denied so send the schemad_permission in case ser accepts
                            schemad_permission.denied = true;
                            returnPermissions.push(schemad_permission);
                        } else { // aready marked as changed so send the schemad_permission in case ser accepts
                            schemad_permission.denied = true;
                            returnPermissions.push(schemad_permission);
                        }
                        delete app_config_permissions[permission_name]; // delete from schemas so add unused ones later
                    } else {
                        // permission was granted but is no longer in app_config - this should not happen very often
                        console.warn("WARNING - permission no longer exists")
                        user_permissions_to_delete.push(aPermission);
                        helpers.warning("account_handler", exports.version, "all_app_permissions", "permission was granted but is no longer in app_config - this should not happen very often "+JSON.stringify(aPermission));
                    }
                }
                // add all the schemad queries which were not in the db 
                if (app_config_permissions) {            // AND ADD app_config_permissions has objects in it 
                    var newPermission={};
                    for (var key in app_config_permissions) {
                        if (app_config_permissions.hasOwnProperty(key)) {
                            newPermission = freezr_db.permission_object_from_app_config_params(app_config_permissions[key], key, requestee_app);
                            returnPermissions.push(newPermission);
                            user_permissions_to_add.push(newPermission);
                        }
                    }
                }
                cb(null)
            /* 
                todo later: Go through forEach of user_permissions_to_add user_permissions_to_delete user_permissions_changed and update the database... not necessary, but better, specially for deleting
            */
            }
        ], 
        function (err) {
            if (err) {
                helpers.send_failure(res, err,"account_handler", exports.version,"all_app_permissions"); 
            } else {  
                helpers.send_success(res, returnPermissions);
            }
        });
}

// CONFIGS
var accountPage_Config = { // config parameters for accounts pages
    'home': {
        page_title: "Accounts Home (Freezr)",
        css_files: ['./info.freezr.public/freezr_style.css', 'account_home.css'],
        page_url: 'account_home.html',
        initial_query_func: exports.list_all_user_apps,
        //initial_query: {'url':'/v1/account/app_list.json'},
        app_name: "info.freezr.account",
        script_files: ['account_home.js']
    }, 
    'changepassword': {
        page_title: "Change Password (freezr)",
        css_files: './info.freezr.public/freezr_style.css',
        page_url: 'account_changepassword.html',
        script_files: ['account_changepassword.js']
    }, 
    'app_management': {
        page_title: "Apps (freezr)",
        css_files: ['./info.freezr.public/freezr_style.css', 'account_app_management.css'],
        page_url: 'account_app_management.html',
        //initial_query: {'url':'/v1/account/app_list.json'},
        initial_query_func: exports.list_all_user_apps,
        script_files: ['account_app_management.js', './info.freezr.public/public/mustache.js']
    },
    'autoclose': {
        page_title: "Autoclose tab (freezr)",
        page_url: 'account_autoclose.html',
        script_files: ['account_autoclose.js']
    },
    'allmydata_view': {
        page_title:"View all my data ",
        html_file:"allmydata_view.html",
        css_files: ["allmydata_view.css"],
        script_files: ["allmydata_view.js","FileSaver.js"]
    }, 
    'allmydata_backup': {
        page_title:"Backup and Restore data",
        html_file:"allmydata_backup.html",
        css_files: ["allmydata_backup.css"],
        script_files: ["allmydata_backup.js","FileSaver.js"]
    }

}


