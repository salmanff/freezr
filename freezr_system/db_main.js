// freezr.info - nodejs system files - db_main.js
exports.version = "0.0.122";

var async = require('async'),
    helpers = require('./helpers.js'),
    MongoClient = require('mongodb').MongoClient,
    file_handler = require('./file_handler.js');
var autoCloseTimeOut;
var freezr_environment = file_handler.existsSyncLocalSystemAppFile(file_handler.systemPathTo("freezr_environment.js"))? require(file_handler.systemPathTo("freezr_environment.js")):null;
var custom_environment = file_handler.existsSyncLocalSystemAppFile(file_handler.systemPathTo("custom_environment.js"))? require(file_handler.systemPathTo("custom_environment.js")):null;

var unifiedDb;

exports.dbConnectionString = function(appName) { 
    
    var connectionString = ""
    
    if (false && freezr_environment && freezr_environment.dbParams && freezr_environment.dbParams.host && freezr_environment.dbParams.host=="localhost"  ) { 
        return 'localhost/'+(freezr_environment.dbParams.unifiedDbName? freezr_environment.dbParams.unifiedDbName: appName);
    } else if (freezr_environment && freezr_environment && freezr_environment.dbParams) {
        if (freezr_environment.dbParams.connectionString) {
            return freezr_environment.dbParams.connectionString
        } else {
            connectionString+= 'mongodb://'
            if (freezr_environment.dbParams.user) connectionString+= freezr_environment.dbParams.user + ":"+freezr_environment.dbParams.pass + "@"
            connectionString += freezr_environment.dbParams.host + (freezr_environment.dbParams.host=="localhost"? "" : (":"+freezr_environment.dbParams.port) )
            connectionString += "/"+ ((freezr_environment.dbParams && freezr_environment.dbParams.unifiedDbName)? freezr_environment.dbParams.unifiedDbName:appName)  +(freezr_environment.dbParams.addAuth? '?authSource=admin':'');
            return connectionString
        }
    } else {
        console.warn("ERROR - NO DB HOST")
        return null;
    }
}

exports.reset_freezr_environment = function(env) {
    //onsole.log("resettting environment in db_main "+JSON.stringify(env))
    freezr_environment = env;
}  

exports.set_and_nulify_environment = function(old_env) {
    freezr_environment = old_env;
    exports.users = null;
    exports.installed_app_list = null; // list of apps installed by users
    exports.user_devices = null; // set of device codes couples with user_names and whether it is an login_for_app_name login
    exports.user_installed_app_list = null; // contains data on "show_app_on_home_screen", "order_to_show" and "app_codes" 
    exports.permissions = null;
}


exports.get_real_object_id = function (data_object_id) {
    var ObjectID = require('mongodb').ObjectID;
    var real_id=null;;
    try {
        real_id = new ObjectID(data_object_id);
    } catch(e) {
        console.warn("error getting real_id possibly due to a mal-configured app_config file",e)
    }
    return real_id
}
var get_full_coll_name = function (app_name, collection_name) {
    // gets collection name if unified db is used
    if (freezr_environment.dbParams.unifiedDbName) {
        return app_name+"__"+collection_name
    } else {
        return collection_name;
    }
}

exports.check_db = function (callback) {
    var temp_admin_db, params_coll, env_on_db=null;
    async.waterfall([        
        // 1. open database connection
        function (cb) {
            MongoClient.connect(exports.dbConnectionString('info_freezer_admin'), cb);
        },

        // 2. create collections for users, installed_app_list, user_installed_app_list, user_devices, permissions.
        function (theclient, cb) {
            theclient = theclient.db(theclient.s.options.dbName)
            temp_admin_db = theclient;
            temp_admin_db.collection(get_full_coll_name('info_freezer_admin',"params"), cb);
        },

        function (the_coll, cb) {
            params_coll = the_coll;
            params_coll.find( {"_id":"freezr_environment"} ).toArray(cb);
        },


        function (results, cb) {
            if (results && results.length>0 && results[0].params) env_on_db = results[0].params;
            params_coll.update({'_id':"test_write_id",'foo':'bar'}, { w: 1, safe: true }, cb);
        }

    ], function(err, write_result) {
        if (err) console.warn("got err in check_db ",err)
        if (err) callback(err, env_on_db);
        if (!err) callback(null, env_on_db)
    });
}

exports.getOrSetPrefs = function (prefName, prefsToSet, doSet, callback) {
    var temp_admin_db, params_coll, pref_on_db={};
    async.waterfall([        
        // 1. open database connection
        function (cb) {
            MongoClient.connect(exports.dbConnectionString('info_freezer_admin'), cb);
        },

        // 2. create collections for users, installed_app_list, user_installed_app_list, user_devices, permissions.
        function (theclient, cb) {
            theclient.db(theclient.s.options.dbName).collection(get_full_coll_name('info_freezer_admin',"params"), cb);
        },

        function (the_coll, cb) {
            params_coll = the_coll
            params_coll.find( {"_id":prefName} ).toArray(cb);
        },

        function (results, cb) {
            if (!doSet && results && results.length>0) {
                pref_on_db = results[0];
                cb(null)
            } else if (doSet && prefsToSet) {
                pref_on_db = prefsToSet
                if (results && results.length>0){
                    console.warn("inserting new prefs ", pref_on_db)
                    params_coll.update({ _id: prefName },{$set: pref_on_db}, {safe: true }, cb); 
                } else {
                    pref_on_db._id = prefName
                    params_coll.insert(pref_on_db, { w: 1, safe: true }, cb);
                }
            } else if (doSet || !prefsToSet){
                cb(helpers.internal_error ("db_main", exports.version, "getOrSetPrefs",( "doset is set to true but nothing to replace prefs "+prefName) ) )
            } else {
                cb(null);
            }
        }
    ], function(err, write_result) {
        if (err) console.warn("got err in getPrefs ",err)
        if (err) callback(err, prefsToSet);
        if (!err) callback(null, pref_on_db)
    });
}

exports.get_coll = function (app_name, collection_name, callback) {
    //onsole.log("goign to open "+app_name+" coll:"+collection_name+" connection string: "+exports.dbConnectionString(app_name))
    
    async.waterfall([        
        // 1. open database connection
        function (cb) {
            app_name=app_name.replace(/\./g,"_");
            MongoClient.connect(exports.dbConnectionString(app_name), cb);
        },

        // 2. create collections for users, installed_app_list, user_installed_app_list, user_devices, permissions.
        function (theclient, cb) {
          theclient = theclient.db(theclient.s.options.dbName)
          theclient.collection(get_full_coll_name(app_name,collection_name), cb);
        }
    ], function(err, collection) {
        if (err) console.warn("error getting "+app_name+" collection:"+collection_name+" in get coll")
        callback(err, collection);
    });
}


exports.write_environment = function (env, callback) {
    // todo - write to collection of env and so keep a list of all envs for later review
    var temp_admin_db, params_coll, env_on_db=null;
    async.waterfall([        
        // 1. open database connection
        function (cb) {
            MongoClient.connect(exports.dbConnectionString('info_freezer_admin'), cb);
        },

        // 2. create collections for users, installed_app_list, user_installed_app_list, user_devices, permissions.
        function (theclient, cb) {
          theclient = theclient.db(theclient.s.options.dbName)
          temp_admin_db = theclient;
          temp_admin_db.collection(get_full_coll_name('info_freezer_admin',"params"), cb);
        },

        function (the_coll, cb) {
            params_coll = the_coll;
            params_coll.update({'_id':"freezr_environment"},{$set:{params:env}},{upsert:true}, cb)
            //params_coll.insert({'_id':"freezr_environment","params":env}, { w: 1, safe: true }, cb);
        }
    ], function(err, write_result) {
        if (err) callback(err);
        if (!err) callback(null)
    });
}
exports.init_admin_db = function (callback) {
    console.log("   - Initiating Admin DB ")//+JSON.stringify(freezr_environment) );

    async.waterfall([        
        // 1. open database connection
        function (cb) {
            var connectionString = freezr_environment.dbParams.connectionString || exports.dbConnectionString('info_freezer_admin')
            MongoClient.connect(exports.dbConnectionString('info_freezer_admin'), cb);
        },

        // 2. create collections for users, installed_app_list, user_installed_app_list, user_devices, permissions.
        function (theclient, cb) {
          admin_db = theclient.db(theclient.s.options.dbName);
          admin_db.collection(get_full_coll_name('info_freezer_admin',"users"), cb);
        },

        function (users_coll, cb) {
           exports.users = users_coll;
            admin_db.collection(get_full_coll_name('info_freezer_admin',"installed_app_list"), cb);
        },

        function (installed_app_list_coll, cb) {
            exports.installed_app_list = installed_app_list_coll;
            admin_db.collection(get_full_coll_name('info_freezer_admin',"user_installed_app_list"), cb);
        },

        function (user_installed_app_list_coll, cb) {
            exports.user_installed_app_list = user_installed_app_list_coll;
            admin_db.collection(get_full_coll_name('info_freezer_admin',"user_devices"), cb);
        },

        function (userdevices_coll, cb) {
            exports.user_devices = userdevices_coll;
            admin_db.collection(get_full_coll_name('info_freezer_admin',"permissions"), cb);
        },

        function (permissions_coll, cb) {
            exports.permissions = permissions_coll;
            cb(null);
        }

    ], callback);
};
// See freezr_db.js for methods
exports.users = null;
exports.installed_app_list = null; // list of apps installed by users
exports.user_devices = null; // set of device codes couples with user_names and whether it is an login_for_app_name login
exports.user_installed_app_list = null; // contains data on "show_app_on_home_screen", "order_to_show" and "app_codes" 
exports.permissions = null;

var running_apps_db = {};

exports.app_db_collection_get = function (app_name, collection_name, firstpass, callback) {
    //onsole.log(" app_db_collection_get - "+app_name+"  -  " +collection_name+"- -firstpass:"+firstpass);
    //onsole.log(callback)
    if (!running_apps_db[app_name]) running_apps_db[app_name]={'db':null, 'collections':{}};
    if (!running_apps_db[app_name].collections) running_apps_db[app_name].collections= {collection_name:null};
    if (!running_apps_db[app_name].collections[collection_name]) running_apps_db[app_name].collections[collection_name] = null;

    collection_name = get_full_coll_name(app_name,collection_name);

    async.waterfall([

        // 1. open database connection
        function (cb) {
            if (freezr_environment.dbParams.unifiedDbName && unifiedDb) {
                cb(null, null);
            } else if (running_apps_db[app_name].db) {
                cb(null, null);
            } else {
                MongoClient.connect(exports.dbConnectionString(app_name), cb);
           }
        },

        // 2. 
        function (theclient, cb) {
            if (freezr_environment.dbParams.unifiedDbName && !unifiedDb) {unifiedDb=theclient}
            if (!unifiedDb && !running_apps_db[app_name].db) running_apps_db[app_name].db = theclient;
            if (running_apps_db[app_name].collections[collection_name]) {
                cb(null,null);
            } else if (unifiedDb) {
                unifiedDb.db(unifiedDb.s.options.dbName).collection(collection_name, cb);
            } else {
                theclient = running_apps_db[app_name].db
                theclient.db(theclient.s.options.dbName).collection(collection_name, cb);
            }
        },

        function (app_collection, cb) {
            if (!running_apps_db[app_name].collections[collection_name]) running_apps_db[app_name].collections[collection_name] = app_collection;
            cb(null);
        }
    ], 
    function (err) {
        if (err) {
            running_apps_db[app_name].collections[collection_name] = null;
            if (firstpass && running_apps_db[app_name].db) {
                helpers.warning ("db_main", exports.version, "app_db_collection_get", "first pass error getting collection - "+err );
                running_apps_db[app_name].db.close(function(err2) {
                    if (err2) {
                        helpers.warning ("db_main", exports.version, "app_db_collection_get", "first pass error closing collection "+collection_name+" ("+app_name+") - " +err2);
                    }
                    running_apps_db[app_name].db = null;
                    exports.app_db_collection_get(app_name, collection_name, false, callback);
                });
            } else if (firstpass) {
                callback(helpers.internal_error("db_main", exports.version, "app_db_collection_get", "No db collection exists yet "+collection_name+" ("+app_name+") - "+err ));                
            } else if (running_apps_db[app_name].db) {
                callback(helpers.internal_error("db_main", exports.version, "app_db_collection_get", "second pass error getting collection (exists) "+collection_name+" ("+app_name+") - "+err ));
            } else {
                callback(helpers.internal_error("db_main", exports.version, "app_db_collection_get", "second pass error getting collection "+collection_name+" ("+app_name+") - " +err ));
            }
        } else {
            running_apps_db[app_name].last_access = new Date().getTime();
            clearTimeout(autoCloseTimeOut);
            if (!freezr_environment.dbParams.unifiedDbName) autoCloseTimeOut = setTimeout(exports.closeUnusedApps,30000);
            callback(null, running_apps_db[app_name].collections[collection_name]);
        }
    });
};
exports.getAllCollectionNames = function(app_name, callback) {
    //onsole.log(" getAllCollectionNames -"+app_name+"- hasOwnProperty "+running_apps_db.hasOwnProperty(app_name));
    if (!running_apps_db[app_name]) running_apps_db[app_name]={'db':null, 'collections':{}};

    async.waterfall([
        // 1. open database connection
        function (cb) {
            if (running_apps_db[app_name].db) {
                cb(null, null);
            } else if (freezr_environment.dbParams.unifiedDbName && unifiedDb) {
                cb(null, null);
            } else {
                MongoClient.connect(exports.dbConnectionString(app_name), cb);
           }
        },

        // 2. 
        function (theclient, cb) {
            // unifiedDb  if (theDb) theDb.listCollections().toArray(cb); (also use theDb below)
            if (freezr_environment.dbParams.unifiedDbName && !unifiedDb) {unifiedDb=theclient}
            if (!unifiedDb && !running_apps_db[app_name].db) running_apps_db[app_name].db = theclient;
            if (unifiedDb) {
                unifiedDb.db(unifiedDb.s.options.dbName).listCollections().toArray(cb);
            } else if (running_apps_db[app_name].db) {
                theclient = running_apps_db[app_name].db
                theclient.db(theclient.s.options.dbName).listCollections().toArray(cb);
            } else {
                cb(null);
            };
        }
    ], function (err, nameObjList) {
        if (err) {
            callback(null, null);
        } else if (nameObjList  && nameObjList.length>0){
            var a_name, collection_names=[];
            if (nameObjList && nameObjList.length > 0) {
                nameObjList.forEach(function(name_obj) {
                    a_name = name_obj.name; 
                    if (a_name && a_name!="system") {
                        if (!freezr_environment.dbParams.unifiedDbName) {
                            collection_names.push(a_name);
                        } else if (helpers.startsWith(a_name,app_name+"__")) {
                            collection_names.push(a_name.slice(app_name.length+2));
                        }
                    }
                });
            }
            callback(null, collection_names);
        } else {
            callback(null, []);
        }
    });
}

exports.closeUnusedApps = function() {
    //onsole.log("closeUnusedApps...")
    var unusedAppsExist = false;
    closeThreshold = 20000;
    for (var oneAppName in running_apps_db) {
        if (running_apps_db.hasOwnProperty(oneAppName) && running_apps_db[oneAppName]) {
            if (!running_apps_db[oneAppName].last_access || (new Date().getTime()) - running_apps_db[oneAppName].last_access  > closeThreshold) {
                running_apps_db[oneAppName].collections = null;
                if (running_apps_db[oneAppName].db) {
                    var DbToClose = running_apps_db[oneAppName].db;
                    delete running_apps_db[oneAppName];
                    DbToClose.close(function(err2) {
                        if (err2) {helpers.warning ("db_main", exports.version, "closeUnusedApps", "err closing "+oneAppName+" - "+err2); }
                    });
                } else {
                    running_apps_db[oneAppName] = null;
                }
            }
        }
        for (var twoAppName in running_apps_db) {
            if (running_apps_db.hasOwnProperty(twoAppName) ) {
                unusedAppsExist = true;
                //onsole.log("unclosed dbs are "+twoAppName+" diff "+((running_apps_db[twoAppName] && running_apps_db[twoAppName].last_access)? (new Date().getTime() - running_apps_db[twoAppName].last_access ): "no last acces") )
            }  
        }
    }
    clearTimeout(autoCloseTimeOut);
    if (unusedAppsExist) autoCloseTimeOut = setTimeout(exports.closeUnusedApps,30000);
}
