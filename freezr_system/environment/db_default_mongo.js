// freezr.info - nodejs system files - db_default_mongo.js
exports.version = "0.0.130"; // Changed names from db__main

var async = require('async'),
    helpers = require('../helpers.js'),
    MongoClient = require('mongodb').MongoClient,
    file_handler = require('../file_handler.js');
var autoCloseTimeOut;
var freezr_environment = file_handler.existsSyncLocalSystemAppFile(file_handler.fullLocalPathToUserFiles("userfiles","freezr_environment.js"))? require(file_handler.fullLocalPathToUserFiles("userfiles","freezr_environment.js")):null;


exports.name='Mongo Datastore'

var unifiedDb;

const ARBITRARY_FIND_COUNT_DEFAULT = 100

exports.re_init_environment_sync = function(env_params) {
    // Resets freezr_environment
    freezr_environment = env_params;
}
exports.re_init_freezr_environment = function(env_params, callback) {
    // Resets freezr_environment
    freezr_environment = env_params;
    callback(null)
    //onsole.log("resettting environment in db_default_mongo "+JSON.stringify(env))
}
exports.check_db = function (env_params, callback) {
    // Checks to see if it can read / write to database - Reads the environment and writes {foo:bar}
    // Note that env_params is not used... however it is included as custom environments may need it
    var temp_admin_db, params_coll, env_on_db=null;
    async.waterfall([
        // 1. open database connection
        function (cb) {
            MongoClient.connect(dbConnectionString('info_freezer_admin'), cb);
        },

        // 2. create collections for users, installed_app_list, user_installed_app_list, user_devices, permissions.
        // This section is specific to mongo implementation
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
        },

        // 3 - read and write params to make sure db is active
        function (cb) {
            admin_db.collection(get_full_coll_name('info_freezer_admin',"params"), cb);
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
        callback(err, env_on_db);
    });
}
exports.set_and_nulify_environment = function(old_env) {
    freezr_environment = old_env;
    exports.users = null;
    exports.installed_app_list = null; // list of apps installed by users
    exports.user_devices = null; // set of device codes couples with user_names and whether it is an login_for_app_name login
    exports.user_installed_app_list = null; // contains data on "show_app_on_home_screen", "order_to_show" and "app_codes"
    exports.permissions = null;
}

exports.db_insert = function (env_params, appcollowner, id, entity, options, callback) {
  get_coll(appcollowner.app_name, appcollowner.collection_name, (err, theCollection) =>{
    if(err) {callback(exports.state_error ("db_default_mongo", exports.version, "db_insert", err ))
      } else {
        if (id) entity._id = id;
        theCollection.insert(entity, { w: 1, safe: true }, (err, results) => {
          if (err) callback(err);
          else callback(null, {
            success:true,
            entity: (results.ops && results.ops.length>0)? results.ops[0]:null
          })
        });
      }
    })
}
exports.db_getbyid = function (env_params, appcollowner, id, callback){
  id = get_real_object_id(id)
  async.waterfall([
      // 1. open database connection
      function (cb) {
          MongoClient.connect(dbConnectionString(appcollowner.app_name), cb);
      },

      // 2. get collection
      function (theclient, cb) {
        theclient = theclient.db(theclient.s.options.dbName)
        theclient.collection(get_full_coll_name(appcollowner.app_name,appcollowner.collection_name), cb);
      },

      // 3. Get item
      function(collection, cb) {
        collection.find({ _id: id }).toArray(cb);
      }
  ], function(err, results) {
      let object=null;
      if (err) {
        // TO helpers.error
        console.warn("error getting object for "+app_name+" collection:"+collection_name+" id:"+id+" in db_getbyid")
        helpers.state_error("db_default_mongo", exports.version, "db_getbyid", err, "error getting object for "+app_name+" collection:"+collection_name+" id:"+id+" in db_getbyid");
      } else if (results && results.length>0 ){
        object = results[0]
      }
      callback(err, object);
  });
}

exports.db_update = function (env_params, appcollowner, idOrQuery, updates_to_entity, options, callback) {
  // IMPORTANT: db_update cannot insert new entities - just update existign ones (TODO NOW CHECK)
    // options: replaceAllFields - replaces all object rather than specific keys
    // In replaceAllFields: function needs to take _date_Created and _owner from previous version and add it here
    // TODO NOW - make sure that for update, entity must exist, otherwise, need to add _date_Created and _onwer etc

    //onsole.log("db_update in mongo idOrQuery ",idOrQuery, "options",options)

    options = options || {};
    get_coll(appcollowner.app_name, appcollowner.collection_name, (err, theCollection) =>{
      if(err) {
        callback(exports.state_error ("db_default_mongo", exports.version, "db_update", err ))
      } else {
          let find = (typeof idOrQuery == "string")? {_id: idOrQuery }: idOrQuery;
          if ( options.replaceAllFields) {
            theCollection.find(idOrQuery)
                .limit(1)
                .toArray((err, entities) => {
                 if (!entities || entities.length==0) {
                   callback(null, {nModified:0, n:0}) // todo make nModified consistent
                 } else {
                   let old_entity = entities[0];
                   updates_to_entity._date_Created = old_entity._date_Created
                   updates_to_entity._owner = old_entity._owner
                   theCollection.update(find, updates_to_entity, {safe: true }, callback);
                 }
               })
          } else {  //if (!options.replaceAllFields)
            theCollection.update(find, {$set: updates_to_entity}, {safe: true, multi:options.multi }, callback);
          }
      }
    })
}
exports.update_record_by_id = function (env_params, appcollowner, id, updates_to_entity, cb) {
  // Assumes all fields are being replaced including
  // no options
  get_coll(appcollowner.app_name, appcollowner.collection_name, (err, theCollection) =>{
    if(err) {
      callback(exports.state_error ("db_default_mongo", exports.version, "db_update", err ))
    } else {
      theCollection.update({_id: id }, {$set: updates_to_entity}, {safe: true, multi:false }, cb);
    }
  })
}
exports.db_remove = function(env_params, appcollowner, idOrQuery, options, callback){
  // No options at this point
  if (typeof idOrQuery=="string") idOrQuery={"_id":idOrQuery}
  if (exports[appcollowner.collection_name] ) {
    exports[appcollowner.collection_name].remove(idOrQuery, {safe: true}, callback);
  //} else if (running_apps_db.hasOwnProperty(appcollowner.app_name) && running_apps_db[appcollowner.app_name]) {
    //running_apps_db[appcollowner.app_name].remove(idOrQuery, {safe: true}, callback);
    //to - check if db is in memory?
  } else {
    get_coll(appcollowner.app_name, appcollowner.collection_name, (err, theCollection) =>{
      if(err) {
        callback(exports.state_error ("db_default_mongo", exports.version, "db_remove", err ))
      } else {
        theCollection.remove(idOrQuery, {multi:true}, callback);
      }
    })
  }
}
exports.db_find = function(env_params, appcollowner, query, options, callback) {
  //onsole.log("in mongo db_find ",query, "options",options)
  options = options || {}
  if (appcollowner.app_name=="info_freezer_admin" && exports[appcollowner.collection_name]) {
    exports[appcollowner.collection_name].find(query).toArray(callback)
  } else {
    get_coll (appcollowner.app_name, appcollowner.collection_name, (err, theCollection)=>{
      //onsole.log(err)
      if (err) {
        callback(helpers.state_error ("db_default_mongo", exports.version, "db_find", err ))
      } else {
        theCollection.find(query)
            .sort(options.sort || null)
            .limit(options.count || ARBITRARY_FIND_COUNT_DEFAULT)
            .skip(options.skip || 0)
            .toArray(callback);
        }
    })
  }
}

const get_coll = function (app_name, collection_name, callback) {
    if (!freezr_environment.dbParams.unifiedDbName) autoCloseTimeOut = setTimeout(exports.closeUnusedApps,30000);
    async.waterfall([
        // 1. open database connection
        function (cb) {
            MongoClient.connect(dbConnectionString(app_name), cb);
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
const get_full_coll_name = function (app_name, collection_name) {
    // gets collection name if unified db is used
    if (freezr_environment.dbParams.unifiedDbName) {
        return (app_name+"__"+collection_name)
    } else {
        return collection_name;
    }
}
const dbConnectionString = function(appName) {
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
const get_real_object_id = function (data_object_id) {
    var ObjectID = require('mongodb').ObjectID;
    var real_id=data_object_id;;
/*    try {
        real_id = new ObjectID(data_object_id);
    } catch(e) {
        console.warn("error getting real_id possibly due to a mal-configured app_config file ",data_object_id,e)
    }
    todonow - 2019 removed
    */
    return real_id
}



// See db_handler.js for methods (legacy notation)
var running_apps_db = {};
exports.users = null;
exports.installed_app_list = null; // list of apps installed by users
exports.user_devices = null; // set of device codes couples with user_names and whether it is an login_for_app_name login
exports.user_installed_app_list = null; // contains data on "show_app_on_home_screen", "order_to_show" and "app_codes"
exports.permissions = null;
exports.getAllCollectionNames = function(env_params, app_name, callback) {
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
                MongoClient.connect(dbConnectionString(app_name), cb);
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
    const closeThreshold = 20000;
    for (var oneAppName in running_apps_db) {
        if (running_apps_db.hasOwnProperty(oneAppName) && running_apps_db[oneAppName]) {
            if (!running_apps_db[oneAppName].last_access || (new Date().getTime()) - running_apps_db[oneAppName].last_access  > closeThreshold) {
                running_apps_db[oneAppName].collections = null;
                if (running_apps_db[oneAppName].db) {
                    var DbToClose = running_apps_db[oneAppName].db;
                    delete running_apps_db[oneAppName];
                    DbToClose.close(function(err2) {
                        if (err2) {helpers.warning ("db_default_mongo", exports.version, "closeUnusedApps", "err closing "+oneAppName+" - "+err2); }
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
