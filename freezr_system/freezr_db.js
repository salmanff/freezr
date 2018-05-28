// freezr.info - nodejs system files - freezr_db.js
exports.version = "0.0.1";

var async = require('async'),
    bcrypt = require('bcryptjs'),
    db_main = require("./db_main.js"),
    helpers = require("./helpers.js"),
    file_handler = require('./file_handler.js');

const ARBITRARY_COUNT = 200;

// APP_DB's - pass through to main_db
exports.app_db_collection_get = function (app_name, collection_name, callback) { 
    //onsole.log("app_db_collection_get "+app_name)
    db_main.app_db_collection_get (app_name, collection_name, true, callback)
}
exports.real_id = function(data_object_id,app_config,collection_name) {
    //onsole.log("getting real id for "+data_object_id+" collection name "+collection_name)
    if (collection_name=="files" ||   (app_config && app_config.collections && app_config.collections[collection_name] && app_config.collections[collection_name].make_data_id && (app_config.collections[collection_name].make_data_id.manual || app_config.collections[collection_name].make_data_id.from_field_names))) {
        return  data_object_id;
    } else {
        return db_main.get_real_object_id(data_object_id)
    }
}
exports.init_admin_db = function(callback) { db_main.init_admin_db(callback)} 
exports.resetFreezrEnvironment = function(env)  {db_main.resetFreezrEnvironment(env) }
exports.set_and_nulify_environment = function(env)  {db_main.set_and_nulify_environment(env) }
exports.write_environment = function(env, callback)  {db_main.write_environment(env, callback) }
exports.get_coll = db_main.get_coll;
//exports.get_coll = function(app_name, collection_name, callback) { db_main.get_coll(app_name, collection_name, callback);}

// DB calls
function object_by_unique_field (collection, field, value, callback) {
    var o = {};
    o[field] = value;
    //onsole.log("finding "+value+" in "+field+"in collection "+collection)

    db_main[collection].find( o ).toArray(function (err, results) {
        
        if (err) {
            callback(err, null, callback);
            return;
        }
        if (!results || results.length == 0) {
            callback(null, null, callback);
        } else if (results.length == 1) {
            callback(null, results[0], callback);
        } else {
            callback(helpers.internal_error("freezr_db", exports.version, "object_by_unique_field", "multiple results where unique result expected" ), null, callback);
        }
    });
};
exports.user_id_from_user_input = function (user_id_input) {
    //
    return user_id_input? user_id_input.trim().toLowerCase().replace(/ /g, "_"): null;
};
exports.user_by_user_id = function (user_id, callback) {
    if (!user_id)
        callback(helpers.missing_data("user_id", "freezr_db", exports.version, "user_by_user_id"));
    else
        user_by_field("user_id", exports.user_id_from_user_input(user_id), callback);
};
function user_by_field (field, value, callback) {
    //
    object_by_unique_field ("users", field, value, callback);
}

// USERS DB -  INTERACTIONS
exports.add_user = function (valid_unique_user_id, password, valid_email, full_name, isAdmin, owner, callback) {
    async.waterfall([
        // validate params
        function (cb) {
            if (!valid_unique_user_id)
                cb(helpers.missing_data("user_id", "freezr_db", exports.version,"add_user"));
            else if (!password)
                cb(helpers.missing_data("password", "freezr_db", exports.version,"add_user"));
            else if (!owner)
                cb(helpers.missing_data("owner", "freezr_db", exports.version,"add_user"));
            else
                bcrypt.hash(password, 10, cb);
        },

        // create the user in mongo.
        function (hash, cb) {
            var user_id = exports.user_id_from_user_input(valid_unique_user_id);
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
            db_main.users.insert(write, { w: 1, safe: true }, cb);
        }
    ],
    function (err, results) {
        //onsole.log("added user"+JSON.stringify(results))
        if (err) {
            callback(helpers.auth_failure("admin_handler.js",exports.version,"add_user","could not add user "+err));
        } else {
            callback(null);
        }
    });
};
exports.changeUserPassword = function (user_id,password, callback) {
    async.waterfall([
        // validate params
        function (cb) {
            if (!user_id)
                cb(helpers.missing_data("user_id", "freezr_db", exports.version,"changeUserPassword"));
            else if (!password)
                cb(helpers.missing_data("password", "freezr_db", exports.version,"changeUserPassword"));
            else
                bcrypt.hash(password, 10, cb);
        },

        // UPDATE value in Mongo
        function (hash, cb) {
            db_main.users.update(
                {user_id: user_id},
                { $set: {password: hash, _date_Modified: new Date().getTime() } }, 
                {safe: true }, 
                cb);
        }
    ],
    function (err, user_json) {
        if (err) {
            callback (err);
        } else {
            callback(null, user_json);
        }
    });
}
exports.all_users = function (sort_field, sort_desc, skip, count, callback) {
    var sort = {};
    if (sort_field) {sort[sort_field] = sort_desc ? -1 : 1;}
    skip = skip? skip: 0;
    count = count? count:ARBITRARY_COUNT;
    if (db_main && db_main.users) {
        db_main.users.find(null)
            .sort(sort)
            .limit(count)
            .skip(skip) 
            .toArray(callback);
    } else {
        callback(helpers.internal_error("freezr_db", exports.version, "all_users", "users dtabase is unavailable" ))
    }
};


// USER_DEVICES
exports.set_or_update_user_device_code = function (device_code, user_id,login_for_app_name, callback){
    async.waterfall([
        // 1. Get Device Code 
        function (cb) {
            db_main.user_devices.find({'device_code':device_code, 'user_id':user_id})
                .limit(1)
                .skip(0)
                .toArray(cb)
        }, 
        function (user_device_records, cb) {
            if (user_device_records && user_device_records.length>0) {
                db_main.user_devices.update(
                    {'device_code':device_code, 'user_id':user_id},
                    { $set: {_date_Modified: new Date().getTime() , 'login_for_app_name':login_for_app_name} }, 
                    {safe: true }, 
                    cb);
            } else {
                var write = {
                    'device_code':device_code, 
                    'user_id':user_id,
                    'login_for_app_name':login_for_app_name,
                    _owner: user_id,
                    _date_Created: new Date().getTime(),
                    _date_Modified: new Date().getTime()
                };
                db_main.user_devices.insert(write, { w: 1, safe: true }, cb);
            }
        }
    ], 
    function (err, results) {
        if (err) {
            callback(err, null);
        } else {
            callback(null, {'device_code':device_code, 'login_for_app_name':login_for_app_name});
        }  
    });
}
exports.get_device_code_specific_session = function (device_code, user_id, callback){
    //onsole.log("get_device_code_specific_session "+user_id+" app: "+app_name);
    async.waterfall([
        // 1. Get App Code 
        function (cb) {
            db_main.user_devices.find({'device_code':device_code, 'user_id':user_id})
                .limit(1)
                .skip(0)
                .toArray(cb)
        }
    ], 
    function (err, results) {
        if (err) {
            callback(err, null, callback);
        } else if (!results || results.length==0) {
            callback(helpers.missing_data("device code for specific session", "freezr_db", exports.version,"get_device_code_specific_session"), null, callback);
        } else {
            callback(null, {'device_code':device_code, 'login_for_app_name':login_for_app_name}, callback);
        }  
    });
}
exports.check_device_code_specific_session = function (device_code, user_id, app_name, callback){
    async.waterfall([
        // 1. Get App Code 
        function (cb) {
            db_main.user_devices.find({'device_code':device_code, 'user_id':user_id})
                .limit(1)
                .skip(0)
                .toArray(cb)
        }
    ], 
    function (err, results) {
        if (err) {
            callback(err);
        } else if (!results || results.length==0) {
            callback(helpers.missing_data("device code for specific session (2)", "freezr_db", exports.version,"check_device_code_specific_session"));
        } else if (!results[0].login_for_app_name) {
            callback(null);
        } else if (results[0].login_for_app_name == app_name) {
            callback(null);
        } else {
            callback(helpers.auth_failure("freezr_db", exports.version, "check_device_code_specific_session", "invalid device code for app"));
        }
    });
}

// USER_installed_app_list
exports.get_user_app_code = function (user_id, app_name, callback){
    //onsole.log("getting app code for "+user_id+" app "+app_name);
    var dbQuery = {'_id':user_id+'}{'+app_name};
    db_main.user_installed_app_list.find(dbQuery)
        .limit(1)
        .skip(0)
        .toArray(function (err, results) {
                if (err) {
                    callback(err, null);
                } else if (!results || results.length<1 || !results[0].app_code) {
                    callback(null, null);
                } else {
                    callback(null, results[0].app_code);
                }
            }
        );
}
exports.remove_user_app = function (user_id, app_name, callback){
    //onsole.log("removing app  for "+user_id+" app "+app_name);
    var dbQuery = {'_id':user_id+'}{'+app_name};
    db_main.user_installed_app_list.update(dbQuery,
                        { $set: {removed: true, app_code:null, _date_Modified: new Date().getTime() } }, 
                        {safe: true }, 
                        callback);
}
exports.get_or_set_user_app_code = function (user_id,app_name, callback){
    var app_code = null, new_app_code=null;
    async.waterfall([
        // 1. Get App Code 
        function (cb) {
            db_main.user_installed_app_list.find({'_id':user_id+'}{'+app_name})
                .limit(1)
                .skip(0)
                .toArray(cb)
        }, 

        function (user_app_records, cb) {
            if (user_app_records && user_app_records.length>0) {
                app_code = user_app_records[0].app_code;
                new_app_code = false; // march 2015 app_code;
                if (user_app_records[0].removed) {
                    app_code = helpers.randomText(10);
                    db_main.user_installed_app_list.update(
                        {_id: user_app_records[0]._id},
                        { $set: {app_code: app_code, removed: false, _date_Modified: new Date().getTime() } }, 
                        {safe: true }, 
                        cb);
                } else {
                    cb(null, cb);
                }
            } else { // GOT NEW APP CODE
                new_app_code = Math.round(Math.random()*10000000);
                var write = {
                    _id: user_id+'}{'+app_name,
                    app_code: new_app_code,
                    app_name: app_name,
                    app_delivered:false,
                    _owner: user_id,
                    _date_Created: new Date().getTime(),
                    _date_Modified: new Date().getTime(),
                    removed: false
                };
                db_main.user_installed_app_list.insert(write, { w: 1, safe: true }, cb);
            }
        }
    ], 
    function (err, results) {
        if (err) {
            callback(err, null, callback);
        } else if (app_code) {
            callback(null, {'app_code':app_code, 'newCode':(new_app_code?true:false)}, callback);
        } else if (results && results[0] && results[0].app_code) { // old mongo
            app_code = results[0].app_code
            callback(null, {'app_code':app_code, 'newCode':(new_app_code?true:false)}, callback);        
        } else if (results && results.ops && results.ops[0] && results.ops[0].app_code) {
            app_code = results.ops[0].app_code;
            callback(null, {'app_code':app_code, 'newCode':(new_app_code?true:false)}, callback);        
        } else  {
            callback(helpers.internal_error("freezr_db", exports.version, "get_or_set_user_app_code", "Unknown Error Getting App code"), null, callback)
        } 
    });
}

// APP INTERACTIONS 
exports.update_permission_records_from_app_config = function(app_config, app_name, user_id, flags, callback) {
    if (!app_config) {
        flags.add('notes','appconfig_missing');
        callback(null, flags)
    } else { 
        // app_config exists - check it is valid
        // make a list of the schemas to re-iterate later and add blank permissions
        var app_config_permissions = (app_config && app_config.permissions && Object.keys(app_config.permissions).length > 0)? JSON.parse(JSON.stringify( app_config.permissions)) : null;
        var queried_schema_list = [], schemad_permission;
        for (var permission_name in app_config_permissions) {
            if (app_config_permissions.hasOwnProperty(permission_name)) {
                schemad_permission = exports.permission_object_from_app_config_params(app_config_permissions[permission_name], permission_name, app_name)
                queried_schema_list.push(schemad_permission);
            }
        }

        // For all users...
        exports.all_users(null, null, null, null, function (err, users) {

            async.forEach(users, function (aUser, cb) {
                async.waterfall ([

                    // 1. register app for the user
                    function (cb) {
                        exports.get_or_set_user_app_code(aUser.user_id,app_name, cb)
                    },

                    function (a,b,cb) {
                        cb(null)
                    }, 

                    // 2. for each permission, get or set a permission record
                    function (cb) {
                        async.forEach(queried_schema_list, function (schemad_permission, cb) { // get perms 
                            exports.permission_by_owner_and_permissionName(aUser.user_id, 
                                schemad_permission.requestor_app, 
                                schemad_permission.requestee_app, 
                                schemad_permission.permission_name, 
                                function(err, returnPerms) {
                                    if (err) {
                                        cb(helpers.internal_error ("freezr_db", exports.version, "update_permission_records_from_app_config","permision query error"));
                                    } else if (!returnPerms || returnPerms.length == 0) { // create new perm: schemad_permission.permission_name for aUser
                                        exports.create_query_permission_record(aUser.user_id, schemad_permission.requestor_app, schemad_permission.requestee_app, schemad_permission.permission_name, schemad_permission, null, cb)
                                    } else if (exports.permissionsAreSame(schemad_permission, returnPerms[0])) {
                                        cb(null);
                                    } else if (returnPerms[0].granted){
                                        exports.updatePermission(returnPerms[0], "OutDated", null, cb); 
                                    } else {
                                        // todo - really should also update the permissions
                                        cb(null);
                                    }
                                })
                        }, 
                        function (err) {
                            if (err) { 
                                cb(err) 
                            } else {
                                cb(null);
                            }
                        })
                    }, 

                ],function (err) {
                    if (err) { //err in update_app_config_from_file waterfall 
                        cb(err);
                    } else {
                        cb();
                    }
                })
            }, 
            function (err) {
                if (err) { 
                    if (!flags.error) flags.error = []; flags.error.push(err);
                    callback(null, flags) 
                } else {
                    callback(null, flags);
                }
            })
        })

    }
}
exports.add_app = function (app_name, app_display_name, user_id, callback) { 
    //onsole.log("add_app "+app_name+" "+app_display_name);
    async.waterfall([
        // 1 make sure data exists
        function (cb) {
            if (!app_name)
                cb(helpers.missing_data("app_name", "freezr_db", exports.version,"add_app"));
            else if (!helpers.valid_app_name(app_name))
                cb(helpers.invalid_data("app_name: "+app_name, "freezr_db", exports.version,"add_app"));
            else
                cb(null);
        },

        // 2. see if app already exists
        function (cb) {
            object_by_unique_field("installed_app_list", "app_name",app_name, cb);
        },

        // 3. stop if app already exists
        function (existing_app, arg2, cb) {
            if (existing_app) {
                cb(helpers.data_object_exists("app (add_app)"));
            } else {
                cb(null);
            }
        },

        // 4. create the app in mongo.
        function (cb) {
            var write = {
                _id: app_name,
                app_name: app_name,
                display_name: app_display_name,
                _owner:user_id,
                _date_Created: new Date().getTime(),
                _date_Modified: new Date().getTime()
            };
            db_main.installed_app_list.insert(write, { w: 1, safe: true }, cb);
        },

        // todo later: Add permissions for app. who is allowed to use it etc?

        // fetch and return the new app.
        function (results, cb) {
            cb(null, results[0]);
        }
    ],
    function (err, app_json) {
        if (err) {
            callback(err);
        } else {
            callback(null, app_json);
        }
    });
};
exports.all_apps = function (sort_field, sort_desc, skip, count, callback) {
    var sort = {};
    sort[sort_field] = sort_desc ? -1 : 1;
    skip = skip? skip:0;
    count = count? count:ARBITRARY_COUNT;
    db_main.installed_app_list.find()
        .sort(sort)
        .limit(count)
        .skip(skip)
        .toArray(callback);
};
exports.all_user_apps = function (user_id, sort_field, sort_desc, skip, count, callback) {
    if (!user_id) {
        callback(helpers.missing_data("User id", "freezr_db", exports.version,"all_user_apps"))
    } else {
        var sort = {};
        sort[sort_field] = sort_desc ? -1 : 1;
        skip = skip? skip:0;
        count = count? count:ARBITRARY_COUNT;
        if (db_main && db_main.user_installed_app_list){
                db_main.user_installed_app_list.find({'_owner':user_id})
                    .sort(sort)
                    .limit(count)
                    .skip(skip)
                    .toArray(callback);
        } else {
            callback(helpers.state_error("freezr_db", exports.version, "all_user_apps", helpers.error("missing_db","The db is not running.") ) )
        }
    }
};
exports.getAllCollectionNames = db_main.getAllCollectionNames;

exports.remove_user_records = function (user_id, app_name, callback) {
    var appDb, collection_names = [], other_data_exists = false;
    console.log("remove_user_records for ",user_id,app_name)

    async.waterfall([
        // 1. get all collection names
        function (cb) {
            db_main.getAllCollectionNames(app_name.replace(/\./g,"_"), cb);
        },

        // 2. for all colelctions, delete user data
        function (collection_names, cb){
            if (collection_names && collection_names.length>0) {
                console.log("Coll names ",collection_names)
                var this_collection;
                async.forEach(collection_names, function (collection_name, cb2) {
                    async.waterfall([

                    function (cb3) {
                        exports.app_db_collection_get(app_name.replace(/\./g,"_") , collection_name, cb3);
                    },

                    function (theCollection, cb3) {
                        this_collection = theCollection;
                        this_collection.remove({'_owner':user_id}, {safe: true}, cb2);
                    },

                    function (results, cb3)  {// remvoal results 
                        this_collection.find().limit(1).toArray(cb2)
                    },

                    function(records, cb3) {
                        if (records && records.length>0) other_data_exists=true;
                        cb3(null);
                    }

                    ], 
                    function (err) {
                        if (err) {
                            cb2(err);
                        } else {
                            cb2(null);
                        }
                    });
                },
                function (err) {
                    if (err) {
                        cb(err);
                    } else {
                        cb(null);
                    }
                })
            } else {
                cb(null);
            }
        }

        ], 
        function (err) {
            if (err) {
                callback(err);
            } else {
                callback(null, {'removed_user_records':true , 'other_data_exists':other_data_exists});
            }

        });
}
exports.try_to_delete_app = function (user_id, app_name, env_params, callback) { 
    console.log("going to try_to_delete_app "+app_name);
    var other_data_exists = false;
    async.waterfall([
        // validate params ad remvoe all user data
        function (cb) {
            if (!app_name){
                cb(helpers.missing_data("app_name", "freezr_db", exports.version,"try_to_delete_app"));
            } else {
                exports.remove_user_records(user_id, app_name, cb);
            }
        },

        // record if other people still have data
        function(results, cb) {
            other_data_exists = results.other_data_exists;
            cb(null)

        },

        // remove permissions
        function(cb) {
            db_main.permissions.remove({_owner:user_id, requestor_app:app_name}, {safe: true}, cb);
        },

        // remove app directory
        function (results, cb) {
            if (!other_data_exists) {
                //onsole,log("going to deleteAppFolderAndContents")
                file_handler.deleteAppFolderAndContents(app_name, env_params, cb);
            } else {
                cb(null, null);
            }
        },

        function (cb) {
            if (!other_data_exists) {
                db_main.installed_app_list.remove({_id:app_name}, {safe: true}, cb);
            } else {
                cb(null, null);
            }
        },

        // also remove from user_installed_app_list
        function (results, cb) {
            if (!other_data_exists) {
                db_main.user_installed_app_list.remove({'_id':user_id+'}{'+app_name}, {safe: true}, cb);                            
            } else {
                cb(null);
            }
        }


    ], 
    function (err) {
        if (err) {
            callback(err);
        } else {
            callback(null, {'removed_user_records':true , 'other_data_exists':other_data_exists});
        }

    });
}
exports.app_exists_in_db = function (app_name, callback) { 
    object_by_unique_field ("installed_app_list", "app_name", app_name, function (dummy, obj_returned){
        var tempret = (obj_returned==null? false: true);
        callback(tempret, callback);
    });
}
exports.get_app_info_from_db = function (app_name, callback) { 
    object_by_unique_field ("installed_app_list", "app_name", app_name, function (dummy, obj_returned){
        callback(null, obj_returned);
    });
}


// PERMISSIONS
// create update and delete
exports.create_query_permission_record = function (user_id, requestor_app, requestee_app, permission_name, permission_object, action, callback) {
    // must be used after all inputs above are veified as well as permission_object.collection
    // action can be null, "Accept" or "Deny"
    if (!user_id || !requestor_app || !requestee_app || !permission_name || !permission_object.type) {
        callback(helpers.missing_data("query permissions", "freezr_db", exports.version,"create_query_permission_record"));
    }
    var write = {
        requestor_app: requestor_app,        // Required
        requestee_app: requestee_app,       // Required
        collection: permission_object.collection, // this or collections required
        collections: permission_object.collections, // this or collections required
        type: permission_object.type, // Required 
        permission_name: permission_name,             // Required   
        description: permission_object.description? permission_object.description: permission_name,
        granted: false, denied:false, // One of the 2 are required
        outDated:false, 
        _owner: user_id,                  // Required
        _date_Created: new Date().getTime(),
        _date_Modified: new Date().getTime()
    };

    if (write.type == "db_query") {
        write.permitted_fields = permission_object.permitted_fields? permission_object.permitted_fields: null;
        write.sharable_groups = permission_object.sharable_groups? permission_object.sharable_groups: "self";
        //write.allowed_user_ids = permission_object.allowed_user_ids? permission_object.allowed_user_ids: null;
        write.return_fields = permission_object.return_fields? permission_object.return_fields: null;
        write.anonymously = permission_object.anonymously? permission_object.anonymously: false;
        write.sort_fields = permission_object.sort_fields? permission_object.sort_fields: null; // todo later -  only 1 sort field can work at this point - to add more...
        write.max_count = permission_object.count? permission_object.count: null;
    } else if (write.type == "field_delegate") {
        write.sharable_fields = permission_object.sharable_fields? permission_object.sharable_fields : [];
        write.sharable_groups = permission_object.sharable_groups? permission_object.sharable_groups : "self";
    } else if (write.type == "folder_delegate") {
        write.sharable_folders = permission_object.sharable_folders? permission_object.sharable_folders : ['/'];
        write.sharable_groups = permission_object.sharable_groups? permission_object.sharable_groups : "self";
    } else if (write.type == "outside_scripts") {
        write.script_url = permission_object.script_url? permission_object.script_url : null;   
    } else if (write.type == "web_connect") {
        write.web_url = permission_object.web_url? permission_object.web_url : null;
    }

    if (action) {
        if (action == "Accept") {
            write.granted = true;
        } else if (action == "Deny") {
            write.denied = true;
        } 
    } 
    db_main.permissions.insert(write, { w: 1, safe: true }, callback);
}
exports.updatePermission = function(oldPerm, action, newPerms, callback) {
    // Note user_id, requestor_app, requestee_app, permission_name Already verified to find the right record. 
    // action can be null, "Accept" or "Deny"
    //onsole.log("updatePermission "+action)
    //onsole.log("updatePermission old"+JSON.stringify(oldPerm))
    //onsole.log("updatePermission new "+JSON.stringify(newPerms))

    if (!oldPerm || !oldPerm._id || (action=="Accept" && !newPerms ) ) {
        callback(helpers.missing_data("permission data", "freezr_db", exports.version, "updatePermission"))
    } else if (action == "OutDated") {
        db_main.permissions.update(
            {_id: oldPerm._id},
            { $set: {'OutDated':true, '_date_Modified': new Date().getTime()}}, 
            {safe: true }, 
            callback);
    } else  {
        if (action == "Accept") {newPerms.granted = true; newPerms.denied = false;}
        else if (action == "Deny") {newPerms.granted = false; newPerms.denied = true;}
        else {newPerms.granted = false; newPerms.denied = false;} // default - error
        newPerms._date_Modified = new Date().getTime();
        newPerms._date_Created = oldPerm._date_Created;
        newPerms._owner = oldPerm._owner;

        // changes july 2015
        //for (var oldkey in oldPerm) {if (!newPerms[oldkey]) newPerms[oldkey]=null};
        //delete newPerms._id;

        db_main.permissions.update(
            {_id: oldPerm._id},
            newPerms, // new july 2015
            //{ $set: newPerms}, 
            {safe: true }, 
            callback);
    }
}
exports.deletePermission = function (record_id, callback) {
    //
    db_main.permissions.remove({_id:record_id}, {safe: true}, callback);
}
// queries
exports.all_userAppPermissions = function (user_id, app_name, callback) {
    var sort = {'_date_Created':-1};
    var dbQuery = {'$and': [{'_owner':user_id}, {'$or':[{'requestor_app':app_name}, {'requestee_app':app_name}]}]};
    db_main.permissions.find(dbQuery)
        .sort(sort)
        .skip(0)
        .toArray(callback);
}
exports.requestee_userAppPermissions = function (user_id, app_name, callback) {
    var sort = {'_created':1};
    var dbQuery = {'$and': [{'_owner':user_id}, {'requestee_app':app_name}]};
    db_main.permissions.find(dbQuery)
        .sort(sort)
        .skip(0)
        .toArray(callback);
}
exports.permission_by_owner_and_permissionName = function (user_id, requestor_app, requestee_app, permission_name, callback) {
    //onsole.log("getting perms for "+user_id+" "+requestor_app+" "+requestee_app+" "+ permission_name)
    if (!user_id) {
        callback(helpers.missing_data("cannot get permission without user_id", "freezr_db", exports.version,"permission_by_owner_and_permissionName"));
    } else if (!requestor_app) {
        callback(helpers.missing_data("cannot get permission without requestor_app", "freezr_db", exports.version,"permission_by_owner_and_permissionName"));
    } else if (!requestee_app) {
        callback(helpers.missing_data("cannot get permission without requestee_app", "freezr_db", exports.version,"permission_by_owner_and_permissionName"));
    } else if (!permission_name) {
        callback(helpers.missing_data("cannot get permission without permission_name", "freezr_db", exports.version,"permission_by_owner_and_permissionName"));
    } else {
        var dbQuery = {'$and': [{"_owner":user_id}, {'requestee_app':requestee_app}, {'requestor_app':requestor_app}, {'permission_name':permission_name}]};
        db_main.permissions.find(dbQuery)
            .skip(0)
            .toArray(callback);
    }
}
exports.permission_by_owner_and_objectId = function (user_id, requestee_app, collection_name, data_object_id, callback) {
    //onsole.log("getting perms for "+user_id+" "+requestor_app+" "+requestee_app+" "+ permission_name)
    var dbQuery = {'$and': [{"_owner":user_id}, {'requestee_app':requestee_app}, {'collection_name':collection_name}, {'data_object_id':data_object_id}]};
    db_main.permissions.find(dbQuery)
        .skip(0)
        .toArray(callback);
}
exports.all_granted_app_permissions_by_name = function (requestor_app, requestee_app, permission_name, type, callback) {
    var dbQuery = {'$and': [{"granted":true}, {$or:[{"outDated":false}, {"outDated":null}] } ,   {'requestee_app':requestee_app}, {'requestor_app':requestor_app}, {'permission_name':permission_name}]};
    //var dbQuery {'$and': [{"granted":true}, {"outDated":false},  {'requestee_app':requestee_app}, {'requestor_app':requestor_app}, {'permission_name':permission_name}]};
    if (type) dbQuery.$and.push({"type":type})
    //onsole.log("all_granted_app_permissions_by_name"+JSON.stringify(dbQuery));
    db_main.permissions.find(dbQuery)
        .skip(0)
        .toArray(callback);
        // todo - at callback also review each user's permission to make sure it's not outdated
}
// Checking permission similarity
var all_fields_to_check_for_permission_equality = ['type','requestor_app','requestee_app','collection', 'sort_fields','permission_name','sharable_groups','allowed_user_ids','permitted_fields' ,'return_fields','max_count','permitted_folders'];
var fields_for_checking_query_is_permitted = ['type','requestor_app','requestee_app','collection','sort_fields','permission_name','sharable_groups','allowed_user_ids','permitted_folders'];
// check if permitted
var queryParamsArePermitted = function(query, permitted_fields) {
    // go through query and strip out all params an then make sure they are in permitted fields
    //onsole.log("queryParamsArePermitted query "+JSON.stringify(query))
    //onsole.log("queryParamsArePermitted permitted_fields"+JSON.stringify(permitted_fields))
    if (!query || Object.keys(query).length == 0) {
        return true;
    } else if (!permitted_fields || Object.keys(permitted_fields).length == 0) {
        return true;
    } else {
        var queriedParams = getQueryParams(query);
        var allFieldsMatched = true;
        for (var i=0; i<queriedParams.length; i++) {
            if (!helpers.startsWith(queriedParams[i],'$') && permitted_fields.indexOf(queriedParams[i])<0) {
                allFieldsMatched = false;
            } // else exists "queriedParams[i] exists}
        }
        return allFieldsMatched;
    }
}
exports.queryIsPermitted = function(user_permission, query_schema, specific_params) {
    //// Permissions are held specifically for each users... so they actual permission given needs to be compared to the one in the app_config
    // specific params come from the body (query_params) 
    //onsole.log("queryIsPermitted userpermission" + JSON.stringify(user_permission) );
    //onsole.log("queryIsPermitted query_schema" +JSON.stringify(query_schema))
    //onsole.log("queryIsPermitted specific_params" +JSON.stringify(specific_params))
    
    if (!specific_params.count) specific_params.count = user_permission.max_count;
    if (!specific_params.skip) specific_params.skip = 0;
    return objectsAreSimilar(fields_for_checking_query_is_permitted, user_permission,query_schema) 
        && queryParamsArePermitted(specific_params.query_params,user_permission.permitted_fields)
        && (!user_permission.max_count || (specific_params.count + specific_params.skip <= user_permission.max_count));
}
exports.fieldNameIsPermitted = function(requested_permission, permission_schema, field_name) {
    //// Permissions are held specifically for each users... so they actual permission given needs to be compared to the one in the app_config
    switch(permission_schema.type) {
        case 'field_delegate':
            return requested_permission.sharable_fields.indexOf(field_name)>=0;
            break;
        case 'folder_delegate':
            field_name = helpers.removeStartAndEndSlashes(field_name);
            if (requested_permission.sharable_folders && requested_permission.sharable_folders.length>0){
                for (var i = 0; i<requested_permission.sharable_folders.length; i++) {
                    if (helpers.startsWith(field_name, helpers.removeStartAndEndSlashes(requested_permission.sharable_folders[i]))) {
                        return true;
                    }
                }
            }
            return false;
            break;
        default: // Error - bad permission type
            return false;
    }
}
exports.field_requested_is_permitted = function(permission_model,requested_field_name, requested_field_value) {
    //onsole.log("field_requested_is_permitted" + JSON.stringify(permission_model))

    if (permission_model.type == "field_delegate") {
        return permission_model && permission_model.sharable_fields &&  permission_model.sharable_fields.indexOf(requested_field_name)>-1
    } else if (permission_model.type == "folder_delegate") {
        if (!permission_model.sharable_folders || permission_model.sharable_folders.length==0 || permission_model.sharable_folders.indexOf('/') >=0 ) {
            return true;
        } else {
            return file_handler.folder_is_in_list_or_its_subfolders(requested_field_value, permission_model.sharable_folders);
        }
    } else { // should not be here.
        return false;
    }
}
exports.permission_object_from_app_config_params = function(app_config_params, permission_name, requestee_app, requestor_app) {
    var returnpermission = app_config_params;
    if (!app_config_params) return null;
    //onsole.log("permission_object_from_app_config_params app_config_params "+JSON.stringify(app_config_params));
    

    returnpermission.permission_name = permission_name;
    if (!returnpermission.requestor_app) {returnpermission.requestor_app = requestor_app? requestor_app:requestee_app;}
    if (!returnpermission.requestee_app) {returnpermission.requestee_app = requestee_app;}
    return returnpermission;
}
exports.permissionsAreSame = function (p1,p2) {
    //var sim = objectsAreSimilar(all_fields_to_check_for_permission_equality, p1,p2);
    //onsole.log("checking perm similarity ",p1,p2,"is similar? "+sim)
    return objectsAreSimilar(all_fields_to_check_for_permission_equality, p1,p2);
}

// APP CODE CHECK
exports.check_app_code = function(user_id, app_name, source_app_code, callback) {
    // check app code... ie open user_installed_app_list and make sure app source code is correct
     // see if query is _owner is user_id... or query and is user_id... if so send cb(null)
    // for each user, see if permission has been given
    //onsole.log("check_app_code");

    async.waterfall([
        // 1. Get user App Code 
        function (cb) {
            exports.get_user_app_code(user_id,app_name, cb); 
        }, 

        function(user_app_code,cb) {
            if (user_app_code) {
                if (""+user_app_code== ""+source_app_code) {
                    cb(null)
                } else {

                     
                    cb(helpers.auth_failure("freezr_db", exports.version, "check_app_code", "WRONG SOURCE APP CODE"));
                }
            } else {
                cb(helpers.auth_failure("freezr_db", exports.version, "check_app_code", "inexistant SOURCE APP CODE"));
            }
        }
    ], 
    function (err, results) {
        if (err) {
            callback(err);
        } else {    
            callback(null)
        }
    });
}

// PERMS - Unused / unchecked functions
exports.ungrant_all_field_permissions_by_name = function(permission_record, user_id, callback) {
}
exports.ungrant_all_user_record_access = function (permission_object, user_id, callback) {
}
exports.check_query_permissions = function(user_id, queryJson, app_name, source_app_code, callback) {
}

// OTHER / OAUTH

exports.all_oauths = function (include_disabled, skip, count, callback) {
    var sort = {};
    skip = skip? skip: 0;
    count = count? count:ARBITRARY_COUNT;
    query = include_disabled? {}:{enabled:true}
    db_main.get_coll ("info.freezr.admin", "oauth_permissions", function (err, oauths) {
        if (err) {
            console.log("got err in all_oauths "+err)
        } else if (oauths) {
            oauths.find(query)
                .sort(sort)
                .limit(count)
                .skip(skip) 
                .toArray(callback);
        } else {
            callback(helpers.internal_error("freezr_db", exports.version, "all_oauths", "oauths dtabase is unavailable" ))
        }
    }) 
};


// General comparison functions and mongo...
var objectsAreSimilar = function(attribute_list, object1, object2 ) {
    // console.log - todo this is very simple - need to improve
    var foundUnequalObjects = false;
    //onsole.log("Checking similarity for 1:"+JSON.stringify(object1)+"  "+" VERSUS:  2:"+JSON.stringify(object2));
    for (var i=0; i<attribute_list.length; i++) {
        if ((JSON.stringify(object1[attribute_list[i]]) != JSON.stringify(object2[attribute_list[i]])) && (!isEmpty(object1[attribute_list[i]]) && !isEmpty(object2[attribute_list[i]]))) {
            console.log("unequal objects found ", object1[attribute_list[i]] , " and ", object2[attribute_list[i]])
            // todo - improve checking for lists
            foundUnequalObjects=true;
        };
    }
    return !foundUnequalObjects;
}
var object_attributes_are_in_list = function (attribute_list,anObject,checkObjectList) {
    foundsSimilar = false
    for (var i=0; i<checkObjectList.length; i++) {
        if (exports.objectsAreSimilar(attribute_list, anObject, checkObjectList[i] ) ) foundsSimilar = true;
    }
    return foundsSimilar;
}
var isEmpty = function(aThing) {
    //
    return !aThing
}
var getQueryParams = function(jsonQuery) {
    // parses a jsonObject string and gets all the keys of objects which represent the query fields in mongodb
    // also returns 'ands' and 'ors'
    tempret = [];
    if (typeof jsonQuery != "string" || isNaN(jsonQuery) ) {
        if (jsonQuery instanceof Array) {
            for (var i=0; i<jsonQuery.length; i++) {
                tempret = tempret.concat(getQueryParams(jsonQuery[i]));
            }
        } else if (typeof jsonQuery == "object") {
            for (var key in jsonQuery) {
                if (jsonQuery.hasOwnProperty(key)) {
                    tempret.push(key);
                    tempret = tempret.concat(getQueryParams(jsonQuery[key]));
                }
            }
        }
    }  
    return tempret
}

