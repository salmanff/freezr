// freezr.info - nodejs system files 
// Default System environment variable - currently set up for own-servers and for Openshift
// It can be customized for other environments
exports.version = "0.0.122";

 
exports.autoConfigs = function() {
  var autoConfigs = {
    ipaddress     : autoIpAddress(),
    port          : autoPort(), 
    dbParams      : autoDbParams(), //{oneDb , addAuth}
    userDirParams : userDirParams() // 
  }
  return autoConfigs
}

var autoIpAddress = function() {
  if ( process && process.env && process.env.DATABASE_SERVICE_NAME ) {
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


var autoDbParams = function() {
  if (process && process.env) console.log("autoDbParams",process.env.DB_USER,process.env.DB_PASS,process.env.DB_HOST)

  if (  process && process.env && process.env.FREEZR_DB ) {  // manually set env variables
        
      return {
            user : process.env.DB_USER, 
            pass : process.env.DB_PASS,  
            host : process.env.DB_HOST,
            port : process.env.DB_PORT,
            addAuth : (process.env.ADD_AUTH || false),
            oneDb : ((process.env.ONE_DB && process.env.ONE_DB==false)? false : true),
            unifiedDbName: process.env.UNIFIED_DB_NAME || "sampledb"
        }
  } else if (  process && process.env                   // openshift v3
            // from https://github.com/openshift/nodejs-ex/blob/master/server.js
            && process.env.DATABASE_SERVICE_NAME 
            && process.env.MONGODB_USER 
            && process.env.MONGODB_PASSWORD) { 
        var mongoServiceName = process.env.DATABASE_SERVICE_NAME.toUpperCase();
        return {
            user : process.env.MONGODB_USER, 
            pass : process.env.MONGODB_PASSWORD,  
            host : process.env[mongoServiceName + '_SERVICE_HOST'],
            port : process.env[mongoServiceName + '_SERVICE_PORT'],
            addAuth : false,
            oneDb : true,
            unifiedDbName: "sampledb"
        }
  } else {
      return{                                   // default local
            user : null,
            pass : null, 
            host : 'localhost',
            port : '27017',
            addAuth : false,
            oneDb: false
        }
  }  
}
var userDirParams = function() {
  if (  process && process.env && process.env.FREEZR_FS && process.env.FREEZR_FS =="dropbox") {
    return {
      name: process.env.FREEZR_FS,
      access_token: process.env.FS_TOKEN,
    }
  } else {
    return {name: null }  
  }
}
