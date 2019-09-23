// freezr.info - nodejs system files
// Default System environment variable - currently set up for own-servers and for Openshift
// It can be customized for other environments
exports.version = "0.0.124";

var path = require('path'),
    fs = require('fs'),
    async = require('async'),
    db_handler = require('../db_handler.js');

exports.autoConfigs = function(callback) {
  let autoConfigs = {
    ipaddress     : autoIpAddress(),
    port          : autoPort(),
    dbParams      : null, //{oneDb , addAuth}
    userDirParams : userDirParams() //
  }
  autoDbParams((err, params) => {
    autoConfigs.dbParams=params
    callback(err, autoConfigs)
  })
}

var autoIpAddress = function() {
  if ( process && process.env && process.env.DATABASE_SERVICE_NAME && process.env.OPENSHIFT_NODEJS_IP) {
      return process.env.OPENSHIFT_NODEJS_IP; // openshift v3
  }                                            // add other platforms here
  else return null;
}

var autoPort = function() {
  if ( process && process.env && process.env.DATABASE_SERVICE_NAME) {
      return 8080; // openshift v3
  }  else if (process && process.env && process.env.PORT) { // aws
      //onsole.log("auto port exists (AWS & other..)",    process.env.PORT)
      return process.env.PORT;
  }                                            // add other platforms here
  else return 3000;
}


var autoDbParams = function(callback) {
  let main_db_params={}
  let haveWorkingDb= false
  let otherOptions = {
    MONGO_EXTERNAL:{
      vars_exist:false,
      functioning:false,
      env_on_db:false,
      params:null
    },
    MONGO_OPENSHIFT:{
      vars_exist:false,
      functioning:false,
      env_on_db:false,
      params:null
    },
    MONGO_LOCAL:{
      functioning:false,
      env_on_db:false,
      params:null
    },
    NEDB_LOCAL:{
      functioning:false,
      env_on_db:false,
      params:null
    },
    GAE:{
      functioning:false,
      env_on_db:false,
      gaeApiRunning : false,
      gaeProjectId  : (process && process.env)? process.env.GOOGLE_CLOUD_PROJECT:null,
      params:{}
    }
  }
  // NB todo  (console.log: this replicates the db waterfall so may need to be merged / cleaned up)

  async.waterfall([
    // 1 MONGO_EXTERNAL check for environment variables being set at process.env for mongo
    function (cb) {
      if (  process && process.env && process.env.FREEZR_DB && process.env.FREEZR_DB.toLowerCase()=="mongodb") {  // manually set env variables for mongo
        otherOptions.MONGO_EXTERNAL.vars_exist=true
        otherOptions.MONGO_EXTERNAL.params = {
                dbtype: process.env.FREEZR_DB.toLowerCase(), // should be Mondodb
                user : process.env.DB_USER,
                pass : process.env.DB_PASS,
                host : process.env.DB_HOST,
                port : process.env.DB_PORT,
                addAuth : (process.env.ADD_AUTH || false),
                oneDb : ((process.env.ONE_DB && process.env.ONE_DB==false)? false : true), // "false"?? to check
                unifiedDbName: process.env.UNIFIED_DB_NAME || "sampledb"
          }
          db_handler.re_init_environment_sync({dbParams:otherOptions.MONGO_EXTERNAL.params})
          db_handler.check_db({dbParams:otherOptions.MONGO_EXTERNAL.params}, (err,env_on_db)=>{
              if (!err) {
                if (env_on_db) otherOptions.MONGO_EXTERNAL.env_on_db=env_on_db
                otherOptions.MONGO_EXTERNAL.functioning = true;
                haveWorkingDb=true;
                main_db_params = otherOptions.MONGO_EXTERNAL.params
              } else {
                console.warn("GOT ERR FOR MONGO_EXTERNAL")
              }
              cb(null)
          })
      } else if (process && process.env && process.env.MONGO_STR){
        otherOptions.MONGO_EXTERNAL.vars_exist=true
        otherOptions.MONGO_EXTERNAL.params = {
                dbtype: "mongodb", // should be Mondodb
                connectionString : process.env.MONGO_STR
          }
          db_handler.re_init_environment_sync({dbParams:otherOptions.MONGO_EXTERNAL.params})
          db_handler.check_db({dbParams:otherOptions.MONGO_EXTERNAL.params}, (err,env_on_db)=>{
              if (!err) {
                if (env_on_db) otherOptions.MONGO_EXTERNAL.env_on_db=env_on_db
                otherOptions.MONGO_EXTERNAL.functioning = true;
                haveWorkingDb=true;
                main_db_params = otherOptions.MONGO_EXTERNAL.params
              } else {
                console.warn("GOT ERR FOR MONGO_EXTERNAL")
              }
              cb(null)
          })



      } else {
        cb(null)
      }
    },
    // 2. MONGO_REDHAT
    function (cb) {
      if (  process && process.env                   // Redhat openshift v3
                // from https://github.com/openshift/nodejs-ex/blob/master/server.js
                && process.env.DATABASE_SERVICE_NAME
                && process.env.MONGODB_USER
                && process.env.MONGODB_PASSWORD) {
            var mongoServiceName = process.env.DATABASE_SERVICE_NAME.toUpperCase();
            otherOptions.MONGO_OPENSHIFT.vars_exist=true
            otherOptions.MONGO_OPENSHIFT.params = {
                dbtype: "mongodb",
                user : process.env.MONGODB_USER,
                pass : process.env.MONGODB_PASSWORD,
                host : process.env[mongoServiceName + '_SERVICE_HOST'],
                port : process.env[mongoServiceName + '_SERVICE_PORT'],
                addAuth : false,
                oneDb : true,
                unifiedDbName: "sampledb"
            }
            db_handler.re_init_environment_sync({dbParams:otherOptions.MONGO_OPENSHIFT.params})
            db_handler.check_db({dbParams:otherOptions.MONGO_OPENSHIFT.params}, (err,env_on_db)=>{
                if (!err) {
                  if (env_on_db) otherOptions.MONGO_OPENSHIFT.env_on_db=env_on_db
                  otherOptions.MONGO_OPENSHIFT.functioning = true;
                  if (!haveWorkingDb) main_db_params = otherOptions.MONGO_OPENSHIFT.params
                  // note logical flaw (but unlikely scenario) that if part 1 and 2 exists, and part 2 is already initiated, part 1 is returned...
                  haveWorkingDb=true;
                } else {
                  console.warn("GOT ERR FOR MONGO_OPENSHIFT")
                }
                cb(null)
            })
      } else {cb(null)}
    },
    // 3. GAE
    function (cb) {
        let isGaeServer = (process && process.env && process.env.GOOGLE_CLOUD_PROJECT)
        let failed = false
        try {
          let {Datastore} = require('@google-cloud/datastore');
          let ds = new Datastore();
          otherOptions.GAE.gaeApiRunning = true;
        } catch(e) {
          // no GAE API
        }
        // To use GAE datastore without running the GAE server, place the keyfile under environment, and name it gaeDatastoreKeyfile.json
        if (otherOptions.GAE.gaeApiRunning) {
          otherOptions.GAE.params.dbtype= "gaeCloudDatastore"
          try {
            let keyfile = fs.readFileSync('./freezr_system/environment/gaeDatastoreKeyfile.json')
            keyfile=JSON.parse(keyfile)
            if (keyfile) {
              otherOptions.GAE.params.gaeProjectId = keyfile.project_id
              otherOptions.GAE.params.gaeKeyFile = true
            }
          } catch (e) {
            // No GAE filekey
          }
        }
        if ( otherOptions.GAE.gaeApiRunning && (otherOptions.GAE.gaeKeyFile || isGaeServer)) {    // Google App Engine
          db_handler.re_init_environment_sync({dbParams:otherOptions.GAE.params})
          db_handler.check_db({dbParams:otherOptions.GAE.params}, (err,env_on_db)=>{
              if (!err) {
                if (env_on_db) otherOptions.GAE.env_on_db=env_on_db
                otherOptions.GAE.functioning = true;
                if (!haveWorkingDb) main_db_params = otherOptions.GAE.params
                haveWorkingDb=true;
              }
              cb(null)
          })
        } else {cb(null)}
    },

    // 4. MONGO_LOCAL
    function (cb) {
      otherOptions.MONGO_LOCAL.params = {                                   // default local
            dbtype: "mongodb",
            user : null,
            pass : null,
            host : 'localhost',
            port : '27017',
            addAuth : false,
            oneDb: false
      }
      db_handler.re_init_environment_sync({dbParams:otherOptions.MONGO_LOCAL.params})
      db_handler.check_db({dbParams:otherOptions.MONGO_LOCAL.params}, (err,env_on_db)=>{
          if (!err) {
            if (env_on_db) otherOptions.MONGO_LOCAL.env_on_db=env_on_db
            otherOptions.MONGO_LOCAL.functioning = true;
            if (!haveWorkingDb) main_db_params = otherOptions.MONGO_LOCAL.params
            haveWorkingDb=true;
          } else {
            console.warn("GOT ERR FOR MONGO_LOCAL")
          }
          cb(null)
      })
    },

    // 5. NEDB
    function (cb) {
      otherOptions.NEDB_LOCAL.params = {                                   // default local
            dbtype: "nedb",
            db_path : (is_glitch()? (GLITCH_USER_ROOT + path.sep):"")+"userDB",
      }
      db_handler.re_init_environment_sync({dbParams:otherOptions.NEDB_LOCAL.params})
      db_handler.check_db({dbParams:otherOptions.NEDB_LOCAL.params}, (err,env_on_db)=>{
          if (!err) {
            if (env_on_db) otherOptions.NEDB_LOCAL.env_on_db=env_on_db
            otherOptions.NEDB_LOCAL.functioning = true;
            if (!haveWorkingDb) main_db_params = otherOptions.NEDB_LOCAL.params
            haveWorkingDb=true;
            cb(null)
          } else { // try storing on non-glitch
            otherOptions.NEDB_LOCAL.params = {                                   // default local
                  dbtype: "nedb",
                  db_path : "userData",
            }
            db_handler.re_init_environment_sync({dbParams:otherOptions.NEDB_LOCAL.params})
            db_handler.check_db({dbParams:otherOptions.NEDB_LOCAL.params}, (err,env_on_db)=>{
                if (!err) {
                  if (env_on_db) otherOptions.NEDB_LOCAL.env_on_db=env_on_db
                  otherOptions.NEDB_LOCAL.functioning = true;
                  if (!haveWorkingDb) main_db_params = otherOptions.NEDB_LOCAL.params
                  haveWorkingDb=true;
                }
                cb(null)
            })
          }
        })
    },
    // 6. OTHER - ADD
    function (cb) {
      cb(null)
    }],
    function (err) {
      //onsole.log("AUTO DB Options")
      //onsole.log(otherOptions)
      //onsole.log("Current DB (main_db_params):")
      //onsole.log(main_db_params)
      if (err) console.warn(err)
      main_db_params.otherOptions = JSON.parse(JSON.stringify(otherOptions))
      callback(null, main_db_params)
    }
  )



}
/*
console.warn(" TEMP GLITCH TEST - REMOVE THIS.")
process = process || {}
process.env = process.env || {}
process.env.API_SERVER_EXTERNAL = "https://api.glitch.com"
*/
var userDirParams = function() {
  if (  process && process.env && process.env.FREEZR_FS && process.env.FREEZR_FS =="dropbox") {
    return {
      name: process.env.FREEZR_FS,
      access_token: process.env.FS_TOKEN,
    }
  } else if (is_glitch() ){
    return {
      name: "glitch.com",
      userRoot: GLITCH_USER_ROOT
    }
  } else {
    return {
        name: null,
        userRoot: null
    }
  }
}
function is_glitch() {
  return (process && process.env && process.env.API_SERVER_EXTERNAL && process.env.API_SERVER_EXTERNAL.indexOf("glitch")>0)
}
const GLITCH_USER_ROOT = ".data"
