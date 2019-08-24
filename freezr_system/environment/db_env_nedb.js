// freezr.info - nodejs databsse - sample custom_envioronments.js
// This can be used to create custom environments for accessing a custom db and file system
//
// custom environment for nedb


'use strict';

const Datastore = require('nedb');
const helpers = require('../helpers.js'),
      path = require('path'),
      async = require('async')

let freezr_environment = null;
let running_apps_db = {};
let autoCloseTimeOut = null;

const ARBITRARY_FIND_COUNT_DEFAULT = 100

exports.use = true;

exports.name='nedb Datastore'

exports.customDb = function(app_name) {return true}

exports.re_init_environment_sync = function(env_params) {
      freezr_environment = env_params;
      running_apps_db = {}
}
exports.re_init_freezr_environment = function(env_params, callback) {
    freezr_environment = env_params;
    running_apps_db = {}
    callback(null)
}
exports.check_db = function (env_params, callback) {
		//onsole.log("check_db in nedb")
    const appcollowner = {
      app_name:'info_freezer_admin',
		  collection_name : 'params',
      _owner: 'freezr_admin'
    }
    let env_on_db=null;

    const coll = get_coll(env_params, appcollowner)

    exports.db_getbyid(env_params, appcollowner, "freezr_environment", function(err, env_on_db) {
			exports.db_getbyid(env_params, appcollowner, "test_write_id", (err2, savedData) => {
		    if (err || err2) {
		      console.warn("got err in check_db ",(err? err : err2))
        	callback((err? err : err2), env_on_db);
		    } else if (savedData){
          exports.db_update (env_params, appcollowner, "test_write_id", {'foo':'updated bar'},
            {}, (err, ret)=> callback(err, env_on_db))
		    } else {
          exports.db_insert (env_params, appcollowner, "test_write_id", {'foo':'bar'}, null, (err, ret)=> callback(err, env_on_db))
        }
		});
	})
}
exports.db_insert = function (env_params, appcollowner, id, entity, options, callback) {
  const coll = get_coll(env_params, appcollowner)
  if (id) entity._id = id;
  coll.insert(entity, function (err, newDoc) {   // Callback is optional
    // newDoc is the newly inserted document, including its _id
    // newDoc has no key called notToBeSaved since its value was undefined
    if (err) callback(err);
    else callback(null, {
      success:true,
      entity: newDoc
    })
  })
}
exports.db_getbyid = function (env_params, appcollowner, id, cb) {
  const coll = get_coll(env_params, appcollowner)
  coll.find({ '_id': id},  (err, results) => {
    let object=null;
    if (err) {
      // TO helpers.error
      console.warn("error getting object for "+app_name+" collection:"+collection_name+" id:"+id+" in db_getbyid")
      helpers.state_error("db_env_nedb", exports.version, "db_getbyid", err, "error getting object for "+appcollowner.app_name+" collection:"+appcollowner.collection_name+" id:"+id+" in db_getbyid");
    } else if (results && results.length>0 ){
      object = results[0]
    }
    cb(err, object);
  });
}
exports.db_find = function(env_params, appcollowner, query, options, cb) {
  //onsole.log("in nedb db_find ",query, "options",options)
  const coll = get_coll(env_params, appcollowner)
  coll.find(query)
      .sort(options.sort || null)
      .limit(options.count || ARBITRARY_FIND_COUNT_DEFAULT)
      .skip(options.skip || 0)
      .exec(cb);
}
exports.db_update = function (env_params, appcollowner, idOrQuery, updates_to_entity, options, cb) {
  // IMPORTANT: db_update cannot insert new entities - just update existign ones (TODO NOW CHECK)
    // options: replaceAllFields - replaces all object rather than specific keys
    // In replaceAllFields: function needs to take _date_Created and _owner from previous version and add it here
    // TODO NOW - make sure that for update, entity must exist, otherwise, need to add _date_Created and _onwer etc

    //onsole.log("db_update in nedb idOrQuery ",idOrQuery, "options",options)
    options = options || {};
    const coll = get_coll(env_params, appcollowner)
    let find = (typeof idOrQuery == "string")? {_id: idOrQuery }: idOrQuery;
    if ( options.replaceAllFields) {
      coll.find(find)
          .limit(1)
          .exec((err, entities) => {
           if (!entities || entities.length==0) {
             cb(null, {nModified:0, n:0}) // todo make nModified consistent
           } else {
             let old_entity = entities[0];
             updates_to_entity._date_Created = old_entity._date_Created
             updates_to_entity._owner = old_entity._owner
             coll.update(find, updates_to_entity, {safe: true }, cb);
           }
         })
    } else {  //if (!options.replaceAllFields)
      coll.update(find, {$set: updates_to_entity}, { multi:options.multi }, cb);
    }
}
exports.db_remove = function (env_params, appcollowner, idOrQuery, options={}, cb) {
  const coll = get_coll(env_params, appcollowner)
  if (typeof idOrQuery=="string") idOrQuery={"_id":idOrQuery}
  coll.remove(idOrQuery, {multi:true}, cb);
}
exports.update_record_by_id = function (env_params, appcollowner, id, updates_to_entity, cb) {
  const coll = get_coll(env_params, appcollowner)
  coll.update({_id: id }, {$set: updates_to_entity}, {safe: true, multi:false }, cb);
}

exports.set_and_nulify_environment = function(old_env) {
    freezr_environment = old_env;
}

exports.getAllCollectionNames = function(env_params, app_name, callback) {
  const db_folder = env_params.dbParams.db_path + path.sep;
  const fs = require('fs');
  let list = []
  fs.readdir(db_folder, (err, files) => {
    files.forEach(file => {
      if (helpers.startsWith(file, app_name)) list.push(file.slice(app_name.length+2,-3) )
    });
    callback(null, list)
  });
}

function get_coll(env_params, appcollowner) {
    //onsole.log("env_params in get_coll",env_params)
    if (running_apps_db[full_name(appcollowner)] && running_apps_db[full_name(appcollowner)].db) return running_apps_db[full_name(appcollowner)].db
    if (!running_apps_db[full_name(appcollowner)]) running_apps_db[full_name(appcollowner)]={'db':null, 'last_accessed':null};
    let coll_meta = running_apps_db[full_name(appcollowner)]
    coll_meta.last_access = new Date().getTime();
    coll_meta.db = new Datastore(env_params.dbParams.db_path + path.sep + full_name(appcollowner)+'.db');
    coll_meta.db.loadDatabase()
    clearTimeout(autoCloseTimeOut);
    autoCloseTimeOut = setTimeout(exports.closeUnusedApps,30000);
    return coll_meta.db
}
const full_name = function (appcollowner) {
    if (!appcollowner) throw helpers.error("NEDB collection failure - need appcollowner ")
    if (!appcollowner.app_name || !appcollowner.collection_name) throw helpers.error("NEDB collection failure - need app name and coll name for "+appcollowner.app_name+"__"+appcollowner.collection_name)
    return (appcollowner.app_name+"__"+appcollowner.collection_name)
}
exports.closeUnusedApps = function() {
    //onsole.log("closeUnusedApps...")
    var unusedAppsExist = false;
    const closeThreshold = 20000;
    for (var oneAppName in running_apps_db) {
        if (running_apps_db.hasOwnProperty(oneAppName) && running_apps_db[oneAppName]) {
            if (!running_apps_db[oneAppName].last_access || (new Date().getTime()) - running_apps_db[oneAppName].last_access  > closeThreshold) {
                running_apps_db[oneAppName].db = null;
                if (running_apps_db[oneAppName].db) delete running_apps_db[oneAppName];
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
