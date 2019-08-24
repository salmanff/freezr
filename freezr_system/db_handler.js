// freezr.info - nodejs system files - db_handler.js
exports.version = "0.0.130"; // Changed names from freezr__db

// Note on queries
//  Currently queires must have $and at the top level with no other object keys (ie all must be placed in the àand object)
//  One $or level query can be put inside the top $and, but cannot add more complexity at lower levels $or can only have equalities. (main $and can also have $lt, $gt)
//  Constraints have been added for Google App Engine / Datastore compatibility (or until a better translation algorithm is used to do $or queries on gae)

// todo: review and redo db_update as it would only be used for admin


const async = require('async'),
      fs = require('fs'),
      helpers = require("./helpers.js"),
      file_handler = require('./file_handler.js'),
      db_default_mongo = require("./environment/db_default_mongo.js") // Default db

let custom_environment= null;

const ARBITRARY_COUNT = 200;

// apc = appcollowner
const PERMISSION_APC = {
  app_name:'info_freezer_admin',
  collection_name:'permissions',
  _owner:'freezr_admin'
}
const PARAMS_APC = {
  app_name:'info_freezer_admin',
  collection_name:'params',
  _owner:'freezr_admin'
}
const USERS_APC = {
  app_name:'info_freezer_admin',
  collection_name:'users',
  _owner:'freezr_admin'
}
const APPLIST_APC = {
  app_name:'info_freezer_admin',
  collection_name:'installed_app_list',
  _owner:'freezr_admin'
}
const OAUTHPERM_APC = {
  app_name:'info_freezer_admin',
  collection_name:"oauth_permissions",
  _owner:'freezr_admin'
}

// INITIALISING
exports.re_init_environment_sync = function(env_params)  {
    // used mostly for testing
    if (env_params && env_params.dbParams && (
      env_params.dbParams.dbtype == "gaeCloudDatastore" ||
      env_params.dbParams.dbtype == "nedb"
    )
    )  {
        const file_env_name = "db_env_"+env_params.dbParams.dbtype+".js";
        if (fs.existsSync(file_handler.systemPathTo('freezr_system/environment/'+file_env_name))) {
            let env_okay = true;
            try {
                custom_environment =  require(file_handler.systemPathTo('freezr_system/environment/'+file_env_name));
            } catch (e) {
                env_okay = false;
                console.warn("**** **** got err in re_init_freezr_environment **** ****")
                return helpers.state_error("db_handler",exports.version,"re_init_freezr_environment", ("error reading file "+file_env_name+" - "+e.message), "error_in_custom_file")
            }
            if (env_okay) custom_environment.re_init_environment_sync(env_params);
        } else {
            console.warn("file doen't exist "+'freezr_system/environment/'+file_env_name)
        }
    } else {
        custom_environment=null;
        db_default_mongo.re_init_environment_sync(env_params)
    }
}
exports.re_init_freezr_environment = function(env_params, callback)  {
  console.log("in db_handler re_init_freezr_environment with ",env_params)

    if (env_params && env_params.dbParams && (
            env_params.dbParams.dbtype == "gaeCloudDatastore" ||
            env_params.dbParams.dbtype == "nedb"
          ) )  {
            console.log("is nedb ")
      const file_env_name = "db_env_"+env_params.dbParams.dbtype+".js";
        if (fs.existsSync(file_handler.systemPathTo('freezr_system/environment/'+file_env_name))) {
          console.log("file exist ")
            let env_okay = true;
            try {
                custom_environment =  require(file_handler.systemPathTo('freezr_system/environment/'+file_env_name));
            } catch (e) {
                env_okay = false;
                console.warn("got err in re_init_freezr_environment")
                callback(helpers.state_error("db_handler",exports.version,"re_init_freezr_environment", ("error reading file "+file_env_name+" - "+e.message), "error_in_custom_file") )
            }
            if (env_okay) custom_environment.re_init_freezr_environment(env_params, callback);
        } else {
            console.warn("file doen't exist "+'freezr_system/environment/'+file_env_name)
        }
    } else {
        custom_environment=null;
        db_default_mongo.re_init_freezr_environment(env_params, callback)
    }
}
exports.check_db      = function(env_params, callback) {
  // checks that the db is functioning and returns a copy of the freezr_environment if there is one on the db
    dbToUse(env_params).check_db(env_params,callback);
}
var useCustomEnvironment = function(env_params, app_name) {
    //onsole.log("useCustomEnvironment: env_params "+JSON.stringify(env_params))
    if (!env_params || !env_params.dbParams ||
      !custom_environment || !custom_environment.use
      || !custom_environment.customDb
      || !custom_environment.customDb(app_name) ) return false;
    return true;
}
var dbToUse = function(env_params) {
    if (env_params.force_env_reset) {exports.re_init_environment_sync(env_params)}
    if (useCustomEnvironment(env_params)){
        return custom_environment
    } else {
        return db_default_mongo
    }
}

// MAIN PRIMARY FUNCTIONS - Passed on to specific db
exports.db_insert = function (env_params, appcollowner, id, entity, options, cb) {
  // if successful returns  {success:true, entity:entity, issues:{}}
  // issues will indicate specific non critical errors etc (todo)
  // entity must have an _owner
  // only inserts one entity at a time
  appcollowner.app_name = appcollowner.app_name.replace(/\./g,"_")
  if (!options || !options.restoreRecord){
    helpers.RESERVED_FIELD_LIST.forEach((aReservedField) => delete entity[aReservedField] )
    entity._date_Created  = new Date().getTime();
    entity._date_Modified = new Date().getTime();
    entity._owner         = appcollowner._owner
  }
  if (!entity._owner) {
    cb(helpers.state_error("db_handler", exports.version, "db_insert", null, "Cannot crete an entity without an owner"))
  } else {
    dbToUse(env_params).db_insert(env_params, appcollowner, id, entity, options, cb);
  }
}
exports.db_getbyid = function (env_params, appcollowner, id, cb) {
  appcollowner.app_name = appcollowner.app_name.replace(/\./g,"_")
  dbToUse(env_params).db_getbyid(env_params, appcollowner, id, cb);
}
exports.db_find = function(env_params, appcollowner, idOrQuery, options, callback) {
  //onsole.log("find idOrQuery ",idOrQuery, (typeof idOrQuery))
  // options are sort, count, skip
  appcollowner.app_name = appcollowner.app_name.replace(/\./g,"_")
  if (typeof idOrQuery == "string") {
    dbToUse(env_params).db_getbyid(env_params, appcollowner, idOrQuery, callback)
  } else {
    let [err, well_formed] = query_is_well_formed(idOrQuery)
    if (well_formed) {
      dbToUse(env_params).db_find(env_params, appcollowner, idOrQuery, options, callback)
    } else {
      callback(err)
    }
  }
}
exports.db_update = function (env_params, appcollowner, idOrQuery, updates_to_entity,
  options={replaceAllFields:false, multi:false},
  cb) {
  // IMPORTANT: dbToUse.db_update cannot insert new entities - just update existing ones
  // options: replaceAllFields - replaces all object rather than specific keys - only works for 1 entity (ie the first one returned in query)
            // multi: replaces multiple items matching the criteria
  // todo - multi needs to be reviewed and corrected, specially for queries with more than maximum number of results
  // ALSO Query structure can only have one $and at top, and one $or as part of that, nothing else

  // Needs to be rechecked - too complex?

  options = options || {replaceAllFields:false, multi:false}
  updates_to_entity._date_Modified = new Date().getTime();
  delete updates_to_entity._owner
  delete updates_to_entity._date_Created
  delete updates_to_entity._id
  appcollowner.app_name = appcollowner.app_name.replace(/\./g,"_")
  dbToUse(env_params).db_update(env_params, appcollowner, idOrQuery, updates_to_entity, options, cb);
}


exports.update_app_record = function (env_params, appcollowner, id, old_object, updates_to_entity, cb) {
  // replaces old entity with new one. (NB if old_object had a previous field, it should be set to null for Mongo)
  appcollowner.app_name = appcollowner.app_name.replace(/\./g,"_")
  helpers.RESERVED_FIELD_LIST.forEach((aReservedField) => updates_to_entity[aReservedField] = old_object[aReservedField])
  updates_to_entity._date_Modified = new Date().getTime();
  dbToUse(env_params).update_record_by_id (env_params, appcollowner, id, updates_to_entity, cb);
}
exports.db_remove = function (env_params, appcollowner, idOrQuery, options, cb) {
    // No options at this point - reserved for future
    // Removes one or multiple items
    appcollowner.app_name = appcollowner.app_name.replace(/\./g,"_")
    dbToUse(env_params).db_remove(env_params, appcollowner, idOrQuery, options, cb);
}

exports.db_upsert = function (env_params, appcollowner, idOrQuery, entity, cb) {
  // If multiple entites, only updates the first!! Does not work with multiple entities
  //onsole.log("db_handler.db_upsert")

  //onsole.log("in db_handler - db_upsert ",idOrQuery)

  function callFwd (err, existing_entity) {
    //onsole.log("In db_handler upsert callFwd", existing_entity)
    //onsole.log("Will replace with new entity", entity)
    if (err) {
      helpers.state_error("db_handler", exports.version, "db_upsert", err, "error reading db")
      cb(err)
    } else if (!existing_entity || (Array.isArray(existing_entity) && existing_entity.length==0)){
      let id =  (typeof idOrQuery == "string")? idOrQuery: (
                  (idOrQuery && idOrQuery._id)? idOrQuery._id : null
                )
      exports.db_insert(env_params, appcollowner, id, entity, null, (err, result)=>{
        cb(err, ((result && result.entity)? result.entity : null))
      })
    } else  {
      if (Array.isArray(existing_entity)) {
        existing_entity=existing_entity[0];
      }
      delete entity._id;
      idOrQuery = existing_entity._id
      dbToUse(env_params).db_update(env_params, appcollowner, idOrQuery, entity, {replaceAllFields:true}, cb)
        // todo if returns nmodified==0, then throw error
    }
  };

  if (typeof idOrQuery== "string") {
    exports.db_getbyid(env_params, appcollowner, idOrQuery, callFwd)
  } else {
    //onsole.log("in upsert doing first find for ",idOrQuery)
    exports.db_find(env_params, appcollowner, idOrQuery, {count:1}, callFwd)
  }
}

exports.getAllCollectionNames= function (env_params, app_name, callback) {
  app_name = app_name.replace(/\./g,"_")
  dbToUse(env_params).getAllCollectionNames (env_params, app_name, callback)
}

//CUSTOM ENV AND  ENV ACTIONS (ie SET UP etc)
exports.get_or_set_prefs = function (env_params, prefName, prefsToSet, doSet, callback) {
  console.log("get_or_set_prefs Done for "+prefName+ "doset?"+doSet)
  console.log("TO REVIEW / DEBUG - prefsToSet")
  console.log(prefsToSet)
  let pref_on_db={}, err=null;

  const callFwd = function(err, write_result) {
      if (err) {
        console.warn("got err in getPrefs ",err)
        callback(err, prefsToSet)
      } else {callback(null, pref_on_db)}
  }
  exports.db_getbyid(env_params, PARAMS_APC, prefName, (err, results)=> {
    if (err) {
      callFwd(err)
    } else if (!doSet && results && results.length>0) {
        pref_on_db = results[0];
        callFwd(null);;
    } else if (doSet && prefsToSet) {
        pref_on_db = prefsToSet
        if (results && results.length>0){
            console.warn("inserting new prefs ", pref_on_db)
            exports.db_update(env_params, PARAMS_APC, prefName, pref_on_db, {replaceAllFields:true, multi:false}, callFwd)
        } else {
            pref_on_db._id = prefName
            exports.db_insert(env_params, PARAMS_APC, prefName, pref_on_db, null, callFwd)
        }
    } else if (doSet && !prefsToSet){
        callFwd(helpers.internal_error ("db_handler", exports.version, "get_or_set_prefs",( "doset is set to true but nothing to replace prefs "+prefName) ) )
    } else {
        callFwd(null);
    }
  })
}
exports.set_and_nulify_environment = function(env_params)  {dbToUse(env_params).set_and_nulify_environment(env_params) }
exports.write_environment = function(env_params, callback)  {
      // todo - write to collection of env and so keep a list of all envs for later review
      exports.db_upsert(env_params, PARAMS_APC, "freezr_environment", {params:env_params}, (err, write_result) =>{
          callback(err);
      })
}



// USER INTERACTIONS
exports.user_by_user_id = function (env_params, user_id, callback) {
    if (!user_id)
        callback(helpers.missing_data("user_id", "db_handler", exports.version, "user_by_user_id"));
    else
      admin_obj_by_unique_field (env_params, "info_freezer_admin","users", "user_id", exports.user_id_from_user_input(user_id), callback);
};
exports.all_users = function (env_params, callback) {
  exports.db_find(env_params, USERS_APC, null, {count:ARBITRARY_COUNT}, callback)
};
exports.changeUserPassword = function (user_id,password, callback) {

    async.waterfall([
        // validate params
        function (cb) {
            if (!user_id)
                cb(helpers.missing_data("user_id", "db_handler", exports.version,"changeUserPassword"));
            else if (!password)
                cb(helpers.missing_data("password", "db_handler", exports.version,"changeUserPassword"));
            else
                bcrypt.hash(password, 10, cb);
        },

        // UPDATE value in db
        function (hash, cb) {
          exports.db_update (env_params, USERS_APC,
            {user_id: user_id},
            {password: hash},
            {replaceAllFields:false},
            cb)
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

function admin_obj_by_unique_field (env_params, app_name, collection_name, field, value, callback) {
    let query = {};
    query[field] = value;
    const appcollowner = {
      app_name:app_name,
      collection_name:collection_name,
      _owner:'freezr_admin'
    }
    exports.db_find(env_params, appcollowner, query, {}, (err, results) => {
        if (err) {
            callback(err, null, callback);
            return;
        }
        if (!results || results.length == 0) {
            callback(null, null, callback);
        } else if (results.length == 1) {
            callback(null, results[0], callback);
        } else {
            callback(helpers.internal_error("db_handler", exports.version, "admin_obj_by_unique_field", "multiple results where unique result expected" ), null, callback);
        }
    });
};

// USER_DEVICES
exports.set_or_update_user_device_code = function (env_params, device_code, user_id,login_for_app_name, callback){
  let write = {
    'device_code':device_code,
    'user_id':user_id,
    'login_for_app_name':login_for_app_name
  }
  const appcollowner = {
    app_name:'info_freezer_admin',
    collection_name:'user_devices',
    _owner:user_id
  }

  //onsole.log("in db:handler set_or_update_user_device_code")
  exports.db_upsert (env_params, appcollowner,
    {'device_code':device_code, 'user_id':user_id},
    write,
    (err, results) => {
        if (err) {
            callback(err);
        } else {
            callback(null, {'device_code':device_code, 'login_for_app_name':login_for_app_name});
        }
    })
}
exports.get_device_code_specific_session = function (env_params, device_code, user_id, callback){
    //onsole.log("get_device_code_specific_session "+user_id+" app: "+app_name);
    const appcollowner = {
      app_name:'info_freezer_admin',
      collection_name:'user_devices',
      _owner:user_id
    }
    exports.db_find(env_params, appcollowner,
      {'device_code':device_code, 'user_id':user_id}, //query
      {skip:0, count:1}, // options
      (err, results) => {
        if (err) {
            callback(err, null, callback);
        } else if (!results || results.length==0) {
            callback(helpers.missing_data("device code for specific session", "db_handler", exports.version,"get_device_code_specific_session"), null, callback);
        } else {
            callback(null, {'device_code':device_code, 'login_for_app_name':login_for_app_name}, callback);
        }
      }
    )
}
exports.check_device_code_specific_session = function (env_params, device_code, user_id, app_name, callback){
  const appcollowner = {
    app_name:'info_freezer_admin',
    collection_name:'user_devices',
    _owner:user_id
  }
  dbToUse(env_params).db_find(env_params, appcollowner,
    {'device_code':device_code, 'user_id':user_id}, //query
    {skip:0, count:1}, // options
    (err, results) => {
        if (err) {
            callback(err);
        } else if (!results || results.length==0) {
            callback(helpers.missing_data("device code for specific session (2)", "db_handler", exports.version,"check_device_code_specific_session"));
        } else if (!results[0].login_for_app_name) {
            callback(null);
        } else if (results[0].login_for_app_name == app_name) {
            callback(null);
        } else {
            callback(helpers.auth_failure("db_handler", exports.version, "check_device_code_specific_session", "invalid device code for app"));
        }
    });
}

// APP CODE CHECK
exports.check_app_code = function(env_params, user_id, app_name, source_app_code, callback) {
    // check app code... ie open user_installed_app_list and make sure app source code is correct
     // see if query is _owner is user_id... or query and is user_id... if so send cb(null)
    // for each user, see if permission has been given
    //onsole.log("check_app_code");

    async.waterfall([
        // 1. Get user App Code
        function (cb) {
            exports.get_user_app_code(env_params, user_id,app_name, cb);
        },

        function(user_app_code,cb) {
            if (user_app_code) {
                if (""+user_app_code== ""+source_app_code) {
                    cb(null)
                } else {
                    cb(helpers.auth_failure("db_handler", exports.version, "check_app_code", "WRONG SOURCE APP CODE"));
                }
            } else {
                cb(helpers.auth_failure("db_handler", exports.version, "check_app_code", "inexistant SOURCE APP CODE"));
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
exports.get_user_app_code = function (env_params, user_id, app_name, callback){
    //onsole.log("getting app code for "+user_id+" app "+app_name);
    const appcollowner = {
      app_name:'info_freezer_admin',
      collection_name:'user_installed_app_list',
      _owner:user_id
    }
    dbToUse(env_params).db_find(env_params, appcollowner,
      {'_id':user_id+'}{'+app_name}, //query
      {skip:0, count:1}, // options
      (err, results) => {
        //onsole.log("get_user_app_code results")
        //onsole.log(results)
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
exports.remove_user_app = function (env_params, user_id, app_name, callback){
    //onsole.log("removing app  for "+user_id+" app "+app_name);
    const db_query = {'_id':user_id+'}{'+app_name};
    const appcollowner = {
      app_name:'info_freezer_admin',
      collection_name:'user_installed_app_list',
      _owner:user_id
    }
    exports.db_update (env_params, appcollowner,
      {'_id':user_id+'}{'+app_name}, // query,
      {removed: true, app_code:null}, // updates_to_entity
      {replaceAllFields:false}, // options
      callback)
}
exports.get_or_set_user_app_code = function (env_params, user_id,app_name, callback){
    var app_code = null, new_app_code=null;
    const appcollowner = {
      app_name:'info_freezer_admin',
      collection_name:'user_installed_app_list',
      _owner:user_id
    }
    async.waterfall([
        // 1. Get App Code
        function (cb) {
          exports.db_find(env_params, appcollowner,
            {'_id':user_id+'}{'+app_name}, //query
            {skip:0, count:1}, // options
            cb)
        },

        function (user_app_records, cb) {
          //onsole.log("get_or_set_user_app_code got ",user_app_records)
            if (user_app_records && user_app_records.length>0) {
                app_code = user_app_records[0].app_code;
                new_app_code = false;
                if (user_app_records[0].removed) {
                    app_code = helpers.randomText(10);
                    exports.db_update (env_params, appcollowner,
                      {_id: user_app_records[0]._id},  //idOrQuery,
                      {app_code: app_code, removed: false}, // updates_to_entity
                      {replaceAllFields:false, multi:false},
                      cb)
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
                    removed: false
                };
                exports.db_insert (env_params, appcollowner, user_id+'}{'+app_name , write, null, (err, inserted)=>{
                  cb(err, (inserted && inserted.entity)? [inserted.entity] : [])
                })
            }
        }
    ],
    function (err, results) {
        if (err) {
            callback(err, null, callback);
        } else if (app_code) {
            callback(null, {'app_code':app_code, 'newCode':(new_app_code?true:false)}, callback);
        } else if (results && results[0] && results[0].app_code) { // old mong_o
            app_code = results[0].app_code
            callback(null, {'app_code':app_code, 'newCode':(new_app_code?true:false)}, callback);
        } else  {
            callback(helpers.internal_error("db_handler", exports.version, "get_or_set_user_app_code", "Unknown Error Getting App code"), null, callback)
        }
    });
}

// APP INTERACTIONS
exports.update_permission_records_from_app_config = function(env_params, app_config, app_name, user_id, flags, callback) {
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
        exports.all_users(env_params, function (err, users) {
            async.forEach(users, function (aUser, cb) {
                async.waterfall ([

                    // 1. register app for the user
                    function (cb) {
                        exports.get_or_set_user_app_code(env_params, aUser.user_id,app_name, cb)
                    },

                    function (a,b,cb) {
                        cb(null)
                    },

                    // 2. for each permission, get or set a permission record
                    function (cb) {
                        async.forEach(queried_schema_list, function (schemad_permission, cb) { // get perms
                            exports.permission_by_owner_and_permissionName(env_params, aUser.user_id,
                                schemad_permission.requestor_app,
                                schemad_permission.requestee_app,
                                schemad_permission.permission_name,
                                function(err, returnPerms) {
                                    if (err) {
                                        cb(helpers.internal_error ("db_handler", exports.version, "update_permission_records_from_app_config","permision query error"));
                                    } else if (!returnPerms || returnPerms.length == 0) { // create new perm: schemad_permission.permission_name for aUser
                                        exports.create_query_permission_record(env_params, aUser.user_id, schemad_permission.requestor_app, schemad_permission.requestee_app, schemad_permission.permission_name, schemad_permission, null, cb)
                                    } else if (exports.permissionsAreSame(schemad_permission, returnPerms[0])) {
                                        cb(null);
                                    } else if (returnPerms[0].granted){
                                        exports.updatePermission(req.freezr_environment, returnPerms[0], "OutDated", null, cb);
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
exports.add_app = function (env_params, app_name, app_display_name, user_id, callback) {
    //onsole.log("add_app "+app_name+" "+app_display_name);
    async.waterfall([
        // 1 make sure data exists
        function (cb) {
            if (!app_name)
                cb(helpers.missing_data("app_name", "db_handler", exports.version,"add_app"));
            else if (!helpers.valid_app_name(app_name))
                cb(helpers.invalid_data("app_name: "+app_name, "db_handler", exports.version,"add_app"));
            else
                cb(null);
        },

        // 2. see if app already exists
        function (cb) {
            admin_obj_by_unique_field(env_params, "info_freezer_admin","installed_app_list", "app_name",app_name, cb);
        },

        // 3. stop if app already exists
        function (existing_app, arg2, cb) {
            if (existing_app) {
                cb(helpers.data_object_exists("app (add_app)"));
            } else {
                cb(null);
            }
        },

        // 4. create the app in the database.
        function (cb) {
            const write = {
                _id: app_name,
                app_name: app_name,
                installed_by: user_id,
                display_name: app_display_name
            };
            exports.db_insert (env_params, APPLIST_APC, null, write, null, cb);
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
exports.all_apps = function (env_params, options, callback) {
  options = options || {}
  dbToUse(env_params).db_find(env_params, APPLIST_APC,
    null, //query
    {skip:options.skip? options.skip:0, count:options.count || ARBITRARY_COUNT}, // options
    callback)
};
exports.all_user_apps = function (env_params, user_id, skip, count, callback) {
    if (!user_id) {
        callback(helpers.missing_data("User id", "db_handler", exports.version,"all_user_apps"))
    } else {
        const appcollowner = {
          app_name:'info_freezer_admin',
          collection_name:'user_installed_app_list',
          _owner:user_id
        }
        dbToUse(env_params).db_find(env_params, appcollowner,
          {'_owner':user_id}, //query
          {skip:skip? skip:0, count:count? count:ARBITRARY_COUNT}, // options
          callback)
    }
};


exports.remove_user_records = function (env_params, user_id, app_name, callback) {
    var appDb, collection_names = [], other_data_exists = false;
    helpers.log (fake_req_from(user_id) ,("remove_user_records for "+user_id+" "+app_name));

    async.waterfall([
        // 1. get all collection names
        function (cb) {
            exports.getAllCollectionNames(env_params, app_name, cb);
        },

        // 2. for all colelctions, delete user data
        function (collection_names, cb){
            if (collection_names && collection_names.length>0) {
                //onsole.log("Coll names ",collection_names)
                var this_collection;

                async.forEach(collection_names, function (collection_name, cb2) {
                    const appcollowner = {
                      app_name:app_name,
                      collection_name:collection_name,
                      _owner:user_id
                    }
                    async.waterfall([

                      function (cb3) {
                          exports.db_remove(env_params,appcollowner,{'_owner':user_id}, {}, cb3);
                      },

                      function (results, cb3)  {// removal results
                          exports.db_find(env_params,appcollowner,{'_owner':user_id}, {count:1}, cb2)
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
exports.try_to_delete_app = function (env_params, logged_in_user, app_name, callback) {
    helpers.log (fake_req_from(logged_in_user) ,("going to try_to_delete_app "+app_name));
    var other_data_exists = false;
    async.waterfall([
        // validate params ad remvoe all user data
        function (cb) {
            if (!app_name){
                cb(helpers.missing_data("app_name", "db_handler", exports.version,"try_to_delete_app"));
            } else {
                exports.remove_user_records(env_params, logged_in_user, app_name, cb);
            }
        },

        // record if other people still have data
        function(results, cb) {
            other_data_exists = results.other_data_exists;
            cb(null)

        },

        // remove permissions
        function(cb) {
            exports.db_remove(env_params, PERMISSION_APC, {permitter:logged_in_user, requestor_app:app_name}, {}, cb);
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
              exports.db_remove(env_params, APPLIST_APC, {_id:app_name}, {}, cb);
            } else {
                cb(null, null);
            }
        },

        // also remove from user_installed_app_list
        function (results, cb) {
            if (!other_data_exists) {
              exports.db_remove(env_params, APPLIST_APC, {'_id':logged_in_user+'}{'+app_name}, {}, cb);
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
exports.get_app_info_from_db = function (env_params, app_name, callback) {
    admin_obj_by_unique_field (env_params, "info_freezer_admin","installed_app_list", "app_name", app_name, function (dummy, obj_returned){
        callback(null, obj_returned);
    });
}


// PERMISSIONS
// create update and delete
exports.create_query_permission_record = function (env_params, user_id, requestor_app, requestee_app, permission_name, permission_object, action, callback) {
    // must be used after all inputs above are veified as well as permission_object.collection
    // action can be null, "Accept" or "Deny"
    if (!user_id || !requestor_app || !requestee_app || !permission_name || !permission_object.type) {
        callback(helpers.missing_data("query permissions", "db_handler", exports.version,"create_query_permission_record"));
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
        permitter: user_id,                  // Required
        _owner: 'freezr_admin',                  // Required
        _date_Created: new Date().getTime(),
        //_date_Modified: new Date().getTime()
    };

    if (write.type == "replaceAllFields") {
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
    exports.db_insert (env_params, PERMISSION_APC, null, write, null, callback);
}

exports.updatePermission = function(env_params, oldPerm, action, newPerms, callback) {
    // Note user_id, requestor_app, requestee_app, permission_name Already verified to find the right record.
    // action can be null, "Accept" or "Deny"
    //
    //onsole.log("updatePermission "+action)
    //onsole.log("updatePermission old"+JSON.stringify(oldPerm))
    //onsole.log("updatePermission new "+JSON.stringify(newPerms))

    if (!oldPerm || !oldPerm._id || (action=="Accept" && !newPerms ) ) {
        callback(helpers.missing_data("permission data", "db_handler", exports.version, "updatePermission"))
    } else if (action == "OutDated") {
      exports.db_update (env_params, PERMISSION_APC,
        {_id: oldPerm._id},  //idOrQuery,
         {'OutDated':true}, // updates_to_entity
         {replaceAllFields:false},
         callback);
    } else  {
        if (action == "Accept") {newPerms.granted = true; newPerms.denied = false;newPerms.outDated=false}
        else if (action == "Deny") {newPerms.granted = false; newPerms.denied = true;newPerms.outDated=false}
        else {newPerms.granted = false; newPerms.denied = false;} // default - error

        newPerms.permitter = oldPerm.permitter

        exports.db_update (env_params, PERMISSION_APC,
          {_id: oldPerm._id},  //idOrQuery,
          newPerms, // updates_to_entity
          {replaceAllFields:true},
          callback)
    }
}
exports.deletePermission = function (env_params, record_id, callback) {
    //
    exports.db_remove(env_params, PERMISSION_APC, record_id, {}, callback);
}
// queries
exports.all_userAppPermissions = function (env_params, user_id, app_name, callback) {
    var dbQuery = {'$and': [{'permitter':user_id}, {'$or':[{'requestor_app':app_name}, {'requestee_app':app_name}]}]};
    exports.db_find(env_params, PERMISSION_APC, dbQuery, {}, callback)
}
exports.requestee_userAppPermissions = function (user_id, app_name, callback) {
    var dbQuery = {'$and': [{'permitter':user_id}, {'requestee_app':app_name}]};

    exports.db_find(env_params, PERMISSION_APC, dbQuery, {}, callback)
}
exports.permission_by_owner_and_permissionName = function (env_params, user_id, requestor_app, requestee_app, permission_name, callback) {
    //onsole.log("getting perms for "+user_id+" "+requestor_app+" "+requestee_app+" "+ permission_name)
    if (!user_id) {
        callback(helpers.missing_data("cannot get permission without user_id", "db_handler", exports.version,"permission_by_owner_and_permissionName"));
    } else if (!requestor_app) {
        callback(helpers.missing_data("cannot get permission without requestor_app", "db_handler", exports.version,"permission_by_owner_and_permissionName"));
    } else if (!requestee_app) {
        callback(helpers.missing_data("cannot get permission without requestee_app", "db_handler", exports.version,"permission_by_owner_and_permissionName"));
    } else if (!permission_name) {
        callback(helpers.missing_data("cannot get permission without permission_name", "db_handler", exports.version,"permission_by_owner_and_permissionName"));
    } else {
        const dbQuery = {'$and': [{"permitter":user_id},
                                  {'requestee_app':requestee_app},
                                  {'requestor_app':requestor_app},
                                  {'permission_name':permission_name}
                        ]};
        exports.db_find(env_params, PERMISSION_APC, dbQuery, {}, callback)
    }
}
exports.permission_by_owner_and_objectId = function (user_id, requestee_app, collection_name, data_object_id, callback) {
    //onsole.log("getting perms for "+user_id+" "+requestor_app+" "+requestee_app+" "+ permission_name)
    const dbQuery = {'$and': [{"permitter":user_id}, {'requestee_app':requestee_app}, {'collection_name':collection_name}, {'data_object_id':data_object_id}]};
    exports.db_find(env_params, PERMISSION_APC, dbQuery, {}, callback)
}
exports.all_granted_app_permissions_by_name = function (env_params, requestor_app, requestee_app, permission_name, type, callback) {
    var dbQuery = {'$and': [{"granted":true}, {$or:[{"outDated":false}, {"outDated":null}] } ,   {'requestee_app':requestee_app}, {'requestor_app':requestor_app}, {'permission_name':permission_name}]};
    //var dbQuery {'$and': [{"granted":true}, {"outDated":false},  {'requestee_app':requestee_app}, {'requestor_app':requestor_app}, {'permission_name':permission_name}]};
    if (type) dbQuery.$and.push({"type":type})
    //onsole.log("all_granted_app_permissions_by_name"+JSON.stringify(dbQuery));

    exports.db_find(env_params, PERMISSION_APC, dbQuery, {}, callback)
        // todo - at callback also review each user's permission to make sure it's not outdated
}
// Checking permission similarity
const all_fields_to_check_for_permission_equality = ['type','requestor_app','requestee_app','collection', 'sort_fields','permission_name','sharable_groups','allowed_user_ids','permitted_fields' ,'return_fields','max_count','permitted_folders'];
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

const query_is_well_formed = function(topquery) {
  // options include sort,limit and keyOnly
  let err = "";

  let top_ands = [];
  let theOrs=[];
  let oneOwner= null;

  let test_strings=[]

  const APPCOLL_OWNER="test_user"

  function getFirstKeyValue(obj, toplevel) {
    let i=1, ret=[null, null, null], err1 ="";
    Object.keys( obj ).forEach( key => {
      let part = {};
      if (i++ == 1) {
        if (typeof obj[key]!="string" && isNaN(obj[key])
            && !(toplevel==true && key=="$or" && Array.isArray(obj[key]) ) ) {
          err1 += " - Object cannot have multiple levels of queries"
        } else {
          ret= [key, obj[key], null]
        }
      } else {
        err1 += "Object contains more than one element (expected 1 for: "+JSON.stringify(obj)+")"
      }
    });
    if (err1) ret[2]=err1
    return ret;
  }

  // parse out top level $ands
  if (!topquery) {
    top_ands = []
  } else if (typeof topquery=="string") {
    // It is just an id
    top_ands = [topquery]
    oneOwner=APPCOLL_OWNER
  } else if (topquery.$and) {
    top_ands = topquery.$and
    let i=0, j=0;
    Object.keys( topquery ).forEach( key => {
      i++;
      if (key=="_owner") oneOwner=topquery[key]
    })
    topquery.$and.forEach(anAnd => {
      if (anAnd.$or) {
        j++;
        theOrs = anAnd.$or
      }
    })
    if(i>1 || j>1) err+=(" - All query params must be put into the top $and object")

  } else {
    Object.keys( topquery ).forEach( key => {
      if (key=="_owner") oneOwner=topquery[key]
      let part = {};
      part[key]=topquery[key]
      top_ands.push(part)
    });
    if (topquery.$or) {
      theOrs = topquery.$or
    }
  }
  if (theOrs.length==0) {
    theOrs=[{'_owner':oneOwner || APPCOLL_OWNER}]
  }

  for (let i=0; i<theOrs.length;i++) {
    let thisOwner = theOrs[i]._owner || oneOwner || APPCOLL_OWNER;
    test_strings[i] = "query string: ("+APPCOLL_OWNER+")"
  }

  const mongoCommands = ['$eq','$lt','$lte','$gt','$gte']
  top_ands.forEach((part)=> {
    let [key, value, err1] = getFirstKeyValue(part, true)
    if (err1) {
      err+= "Error on "+key+" "+err1
    } else if (key=='_id') {
       test_strings.forEach((a_string)=> {a_string += '(key='+value})
     } else if (key=='_owner') {
        // do nothing - already added
    } else if (key[0]=='$') { // a Mongo command
      if (key=='$or' && Array.isArray(value)) { // top level $or
        // do nothing
      } else if (mongoCommands.indexOf(key)>-1 ) { // allowed commands
        let idx = mongoCommands.indexOf(key)
        for (let i=0; i<theOrs.length;i++) {
          test_strings[i] +=".filter("+key+" : "+value +")"
        }
      } else {
        err+= "Error - Used "+key+" when accepted query commadns are "+JSON.stringify(mongoCommands)
      }
    } else {
      for (let i=0; i<theOrs.length;i++) {
        test_strings[i]+=".filter("+key+" = "+value +")"
      }
    }
  } )

  if (theOrs.length>0 &&
    !(theOrs.length==1 && theOrs[0]._owner)) // dont add owner filter so that one can sort
    {
    for (let i=0; i<theOrs.length;i++) {
      if (theOrs[i]){
        let [key, value, err2]=  getFirstKeyValue(theOrs[i], false)
        test_strings[i]+=".filter("+key+" = "+value +")"
      }
    }
  }

  if (err) {err = new Error(err)}
  if (err) console.warn("********** ERR : "+err)
  //onsole.log(test_strings)
  return [err, (!err)]
}


// GENERAL Admin db
exports.admindb_query = function (collection, options, callback) {
    //onsole.log("db_handler admindb_query")

    options = options || {};
    const appcollowner = {
      app_name:'info_freezer_admin',
      collection_name:collection,
      _owner:'freezr_admin'
    }
    exports.db_find(env_params, appcollowner, options.query_params, {skip:(options.skip? options.skip: 0), count: (options.count? options.count:ARBITRARY_COUNT)}, callback)
};

// OTHER / OAUTH / MOVE TO ADMIN_DB
exports.all_oauths = function (include_disabled, skip, count, callback) {
  options = options || {};
  exports.db_find(env_params, OAUTHPERM_APC,
                  (include_disabled? {}:{enabled:true}),
                  {skip:(options.skip? options.skip: 0), count: (options.count? options.count:ARBITRARY_COUNT)},
                  callback)
};





// General comparison functions ...
const fake_req_from = function(user_id) {return {session:{logged_in_user_id:user_id}}}

var objectsAreSimilar = function(attribute_list, object1, object2 ) {
    // console.log - todo this is very simple - need to improve
    var foundUnequalObjects = false;
    //onsole.log("Checking similarity for 1:"+JSON.stringify(object1)+"  "+" VERSUS:  2:"+JSON.stringify(object2));
    for (var i=0; i<attribute_list.length; i++) {
        if ((JSON.stringify(object1[attribute_list[i]]) != JSON.stringify(object2[attribute_list[i]])) && (!isEmpty(object1[attribute_list[i]]) && !isEmpty(object2[attribute_list[i]]))) {
            // console.log("unequal objects found ", object1[attribute_list[i]] , " and ", object2[attribute_list[i]])
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


// OTHER FUNCS TO REVIEW
// todo Consider moving to helpers
exports.user_id_from_user_input = function (user_id_input) {
    //
    return user_id_input? user_id_input.trim().toLowerCase().replace(/ /g, "_"): null;
};
