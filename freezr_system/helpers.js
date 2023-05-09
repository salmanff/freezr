// freezr.info - nodejs system files - helpers.js
// THIS NEEDS TO BE CLEANED AND re-organised
exports.version = '0.0.122'

const async = require('async')
const flags_obj = require("./flags_obj.js")
const path = require('path')

exports.RESERVED_FIELD_LIST = ["_id", "_date_created", "_date_modified","_accessible","_publicid","_date_accessibility_mod"];
// ,"_date_published" removed as need to trust apps to set it

exports.log = function (...messages) {
  console.log(new Date(), ...messages)
}

exports.APP_MANIFEST_FILE_NAME = 'manifest.json'
exports.FREEZR_USER_FILES_DIR = 'users_freezr'

// Valid names
// OTHER FUNCS TO REVIEW
    exports.user_id_from_user_input = function (user_id_input) {
      //
      return user_id_input? user_id_input.trim().toLowerCase().replace(/ /g, "_"): null;
    };
    exports.system_apps = ["info.freezr.account","info.freezr.admin","info.freezr.public","info.freezr.permissions","info.freezr.posts","info.freezr.logs"];
    exports.SYSTEM_ADMIN_COLLS = ['users','permissions','visit_log_daysum','params','oauth_permissions','app_tokens']
    exports.SYSTEM_ADMIN_APPTABLES = exports.SYSTEM_ADMIN_COLLS.map(coll => {return ('info_freezr_admin_'+coll)})
    exports.permitted_types = {
        groups_for_objects: ["user","logged_in","public"],
        //groups_for_fields: ["user","logged_in"],
        type_names: ["object_delegate", "db_query"], // used in getDataObject
    }
    var reserved_collection_names = ["field_permissions", "accessible_objects"]; // "files" s also reserved but can write to it
    const RESERVED_IDS =['fradmin', 'public', 'test']

exports.is_system_app = function (appName) {
    if (!appName) console.warn('Asking is_system_app for NULL APP')
    if (!appName) return false
  let ret = false
  appName = appName.replace(/\./g, '_')
  exports.system_apps.forEach((item, i) => {
    item = item.replace(/\./g, '_')
    if (item === appName || exports.startsWith(appName, item)) ret = true
  })
  return ret
}
    // note - App_name and user_id etc could have spaces but need to deCodeUri when in url
    exports.valid_app_name = function(app_name) {
        if (!app_name) return false;
        if (app_name.length<1) return false;
        if (!exports.valid_filename(app_name)) return false;
        if (exports.starts_with_one_of(app_name, ['.','-','\\','system'] )) return false;
        if (exports.system_apps.indexOf(app_name)>-1) return false;
        if (app_name.indexOf("_") >-1) return false;
        if (app_name.indexOf(" ") >-1) return false;
        if (app_name.indexOf("$") >-1) return false;
        if (app_name.indexOf('"') >-1) return false;
        if (app_name.indexOf("/") >-1) return false;
        if (app_name.indexOf("@") >-1) return false;
        if (app_name.indexOf("\\") >-1) return false;
        if (app_name.indexOf("{") >-1) return false;
        if (app_name.indexOf("}") >-1) return false;
        if (app_name.indexOf("..") >-1) return false;
        var app_segements = app_name.split('.');
        if (app_segements.length <3) return false;
        return true;
    }
    exports.valid_unify_db_name = function(db_name) {
        if (!db_name) return false;
        if (db_name.indexOf("$") >-1) return false;
        if (db_name.indexOf('"') >-1) return false;
        if (db_name.indexOf("@") >-1) return false;
        if (db_name.indexOf("/") >-1) return false;
        if (db_name.indexOf("\\") >-1) return false;
        if (db_name.indexOf(" ") >-1) return false;
        return true;
    }
    exports.valid_filename = function (fn) {
        var re = /[^\.a-zA-Z0-9-_ ]/;
        // @"^[\w\-. ]+$" http://stackoverflow.com/questions/11794144/regular-expression-for-valid-filename
        return typeof fn == 'string' && fn.length > 0 && !(fn.match(re) );
    };
    exports.valid_dir_name = function(dir) {
        var re = /[^\a-zA-Z_0-9-.]/;
        return typeof dir == 'string' && dir.length > 0 && !(dir.match(re));
    }
    exports.user_id_is_valid = function(uid) {
      return (RESERVED_IDS.indexOf(uid)<0 && uid.indexOf("@") < 0 && uid.indexOf("_") < 0 && uid.indexOf(" ") < 0 && uid.indexOf("/") < 0 && uid.indexOf("{") < 0 && uid.indexOf("}") < 0 )
    }
    exports.valid_permission_name = function(name) {
      return (name.indexOf(" ") < 0 && name.indexOf("/") < 0  && name.indexOf(" ") < 0 )
    }
    exports.valid_collection_name = function(collection_name,is_file_record)  {
        if (!collection_name) {
          return true
        } else if (collection_name.indexOf("_")>-1 || collection_name.indexOf("/")>-1 || collection_name.indexOf(" ")>-1  ||collection_name.indexOf("@")>-1   || (exports.starts_with_one_of(collection_name, ['.','-','\\'] )) ) {
            return false
        } else if (reserved_collection_names.indexOf(collection_name)>-1){
            return false;
        }
        return true;
    }

// SEND SUCCESS / FAILURE
    exports.send_success = function(res, data) {
        //onsole.log("onto send success")
        if (!data) data = {};
        data.error = null;
        //var output = { error: null, data: data };
        // console.log('helpers sending ', JSON.stringify(data) )
        res.end(JSON.stringify(data) + "\n");
    }

    exports.send_failure = function(res, err, system_file, version, theFunction ) {
        console.warn("* * * ERROR *** : Helpers send failure in system_file "+system_file+" function: "+theFunction+"  error"+JSON.stringify( err));
        var code = (typeof err == 'string')? err :(err.code ? err.code : err.name);
        var message = (typeof err == 'string')? err :(err.message ? err.message : code);
        res.writeHead(200, { "Content-Type" : "application/json" });
        res.end(JSON.stringify({ error: err.message, code:err.code }) /*+ "\n"*/);
    }

// ERRORS
    exports.error = function (code, message) {
        var e = new Error(message);
        e.code = code;
        return e;
    };
    exports.state_error = function (system_file, version, theFunction, error, errCode ) {
        if (!errCode && error && error.code) errCode = error.code
        console.warn ("* * * ERROR *** : Error in system_file "+system_file+" function: "+theFunction+" code: "+errCode+" message:"+error);
        return exports.error((errCode? errCode : "uknown error"), ((error && error.message) ? error.message : 'unknown'));
    };

    exports.auth_failure = function (system_file, version, theFunction, message, errCode ) {
        console.warn ("* * * ERROR *** :  Auth Error in system_file "+system_file+" function: "+theFunction+" message:"+message);
        return exports.error((errCode? errCode : "authentication"),
                             "Authentication error: "+message);
    };
    exports.internal_error = function (system_file, version, theFunction, message ) {
        console.warn ("* * * ERROR *** :  Internal Error in system_file "+system_file+" function: "+theFunction+" message:"+message);
        return exports.error("internal_error",
                             "Internal error: "+message);
    };
    exports.warning = function (system_file, version, theFunction, ...messages) {
        //
        console.warn ("* * * WARNING *** :  "+(new Date())+" Possible malfunction in system_file "+system_file + 'version: '+ version + " function: "+theFunction+" message:", ...messages)
    };
    exports.auth_warning = function (system_file, version, theFunction, message ) {
        //
        console.warn ("* * * WARNING *** :  "+(new Date())+" Possible malfunction in system_file "+system_file+" function: "+theFunction+" message:"+message);
    };

    exports.app_data_error = function(version, theFunction, app_name, message) {
        console.warn ("App Data ERROR in function: "+theFunction+" app_name: "+app_name+" message:"+message);
        return exports.error("app_data_error", message);
    }
    exports.manifest_error = function(version, theFunction, app_name, message) {
        console.warn ("App Config ERROR (from "+theFunction+") for app_name: "+app_name+":"+message);
        return exports.error("manifest_error", message);
    }

    exports.rec_missing_error = function(version, theFunction, app_name, message) {
        console.warn ("App Data ERROR in function: "+theFunction+" app_name: "+app_name+" message:"+message);
        return exports.error("rec_missing_error", message);
    }

    exports.send_auth_failure = function (res, system_file, version, theFunction, message, errCode ) {
        var err = exports.auth_failure (system_file, version, theFunction, message , errCode)
        exports.send_failure(res, err, system_file, version, theFunction, message )
    };
    exports.send_internal_err_failure = function (res, system_file, version, theFunction, message, original_err ) {
        var err = exports.internal_error (system_file, version, theFunction, message )
        exports.send_failure(res, err, system_file, version, theFunction, message )
    };
    exports.send_internal_err_page= function (res, system_file, version, theFunction, message ) {
        // todo 2019 - redo this page...
        var err = exports.internal_error (system_file, version, theFunction, message )
        res.redirect('/account/home?error=true&error_type=internal&file='+system_file+"&msg="+message)
    };
    exports.missing_data = function (what, system_file, version, theFunction) {
        console.warn ("WARNING - Missing Data err in system_file "+system_file+" function: "+theFunction+" missing:"+what);
        return exports.error("missing_data",
                             "You must include " + what);
    }
    exports.invalid_data = function (what, system_file, version, theFunction) {
        console.warn ("WARNING - Invalid Data err in system_file "+system_file+" function: "+theFunction+" missing:"+what);
        return exports.error("invalid_data",
                             "Data is invalid: " + what);
    }
    exports.user_exists = function (type) {
        return exports.error("user exists",
                             "There is already a user with this "+type);
    };
    exports.data_object_exists = function (object_id) {
        return exports.error("data exists",
                             "There is already a data object with these unique attributes "+object_id);
    };
    exports.email_is_valid = function(email) {
        // can make a little more sophisticated...
        return (email.indexOf("@") > 0 && email.indexOf(".")>0)
    }
    exports.invalid_email_address = function () {
        return exports.error("invalid_email_address",
                            "That's not a valid email address, sorry");
    };
    exports.invalid_user_id = function () {
        return exports.error("invalid_user_id",
                            "That's not a valid display name - cannot include spaces. sorry");
    };
    exports.malformed_config = function (app_name) {
        return exports.error("malformed_config",
                            "The manifest.json file for "+app_name+"could not be parsed. It may be configured badly, or the JSON structure is not valid");
    };

// SECURITY UTILITIES
    exports.generateAppToken = function(userId, appName, deviceCode){
      //console.log('to be redone - jwt can be issued here too')
      return exports.randomText(50)
    }
    exports.generateOneTimeAppPassword = function(userId, appName, deviceCode){
      //console.log('to be redone')
      return exports.randomText(50)
    }


// UTILITIES
    exports.startsWith = function(longertext, checktext) {
        if (!longertext || !checktext || !(typeof longertext === 'string')|| !(typeof checktext === 'string')) {return false} else
        if (checktext.length > longertext.length) {return false} else {
        return (checktext == longertext.slice(0,checktext.length));}
    }
    exports.endsWith = function (longertext, checktext) {
        if (!checktext || !longertext || checktext.length > longertext.length) {return false} else {
        return (checktext == longertext.slice((longertext.length-checktext.length)));}
    }

    exports.starts_with_one_of = function(thetext, stringArray) {
        for (var i = 0; i<stringArray.length; i++) {
            if (exports.startsWith(thetext,stringArray[i])) return true;
        }
        return false;
    }
    exports.addToListAsUnique = function(aList,anItem) {
        if (!anItem) {
            return aList
        } else if (!aList) {
            return [anItem]
        } else if (aList.indexOf(anItem) < 0) {
            aList.push(anItem);
        }
        return aList
    }
    exports.removeFromListIfExists = function(aList,anItem) {
        if (!anItem) {
          return aList
        } else if (!aList) {
          return []
        } else {
          let i = aList.indexOf(anItem)
          if (i>-1) aList.splice(i, 1);
        }
        return aList
    }
    exports.now_in_s = function () {
        return Math.round((new Date()).getTime() / 1000);
    }
    exports.randomText = function(textlen) {
        // http://stackoverflow.com/questions/1349404/generate-a-string-of-5-random-characters-in-javascript
        var text = "";
        var possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        if (!textlen) textlen = 10

        for( var i=0; i < textlen; i++ )
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        return text;
    }

    exports.expiry_date_passed = function (expiry) { // expiry is a date in unix epochtime
      const now = new Date().getTime();
      return (now>expiry)
    }
    exports.newVersionNumberIsHigher = function (oldNum, newNum) {
        return versionCompare(oldNum, newNum) === -1
    }
    exports.newVersionNumberIsEuqalOrHigher = function (oldNum, newNum) {
        return versionCompare(oldNum, newNum) <= 0
    }

    function versionCompare(v1, v2) { 
        //https://www.geeksforgeeks.org/compare-two-version-numbers/
        // vnum stores each numeric 
        // part of version 
        var vnum1 = 0, vnum2 = 0; 
    
        // loop until both string are 
        // processed 
        for (var i = 0, j = 0; (i < v1.length 
                                || j < v2.length);) { 
            // storing numeric part of 
            // version 1 in vnum1 
            while (i < v1.length && v1[i] != '.') { 
                vnum1 = vnum1 * 10 + (v1[i] - '0'); 
                i++; 
            } 
    
            // storing numeric part of 
            // version 2 in vnum2 
            while (j < v2.length && v2[j] != '.') { 
                vnum2 = vnum2 * 10 + (v2[j] - '0'); 
                j++; 
            } 
    
            if (vnum1 > vnum2) 
                return 1; 
            if (vnum2 > vnum1) 
                return -1; 
    
            // if equal, reset variables and 
            // go for next numeric part 
            vnum1 = vnum2 = 0; 
            i++; 
            j++; 
        } 
        return 0; 
    } 

// Other..
var reduceToUnique = function(aList) {
    returnList = []
  aList.forEach(function(el){
        if(returnList.indexOf(el)<0) returnList.push(el);
  });
  return returnList
}
function getWords(anObject) {
  if(!anObject) {
    return [];
  } else if (typeof anObject == "string") {
    return anObject.toLowerCase().split(" ");
  } else if (!isNaN(anObject)) {
    return[anObject+""]
  } else if (Array.isArray(anObject)) {
    var all = [];
    anObject.forEach(function(el){all = all.concat(getWords(el)) });
    return all;
  } else if  (typeof anObject == "object"){ // object
    var all = [];
    for (aKey in anObject) {
      if (anObject.hasOwnProperty(aKey)) {all = all.concat(getWords(anObject[aKey])); all=all.concat([aKey]) }
    }
    return all;
  } else {
    return JSON.stringify(anObject).toLowerCase().split(" ");
  }
}
exports.getUniqueWords = function (anObject,theFields){
 // if theFields is null, all items are counted. if not only specific theFields of the object at the top level (and it has to be an object)
 allWords = [];
 if (Array.isArray(anObject) || typeof anObject != "object" || !theFields) {
    return getWords(anObject)
 } else {
   theFields.forEach(function(aField) {
      allWords = allWords.concat(getWords(anObject[aField]))
    });
  return reduceToUnique(allWords);
    }
}
exports.removeLastpathElement = function (statedPath, depth) {
  if (!depth) depth = 1
  const parts = statedPath.split(path.sep)
  for (let i = 0; i < depth; i++) {
      parts.pop()
  }
  return parts.join(path.sep)
}
exports.variables_are_similar = function (obj1, obj2) {
    //onsole.log("variables_are_similar ",JSON.stringify(obj1),JSON.stringify(obj2)," - - - - -----------------")
    if (typeof obj1 != typeof obj2) {
        //onsole.log("variables_are_similar NOT - Type mismatch ",obj1,obj2)
        return false
    } else if (obj1 == obj2) {
        return true
    } else if (typeof obj1 == 'string'  || typeof obj1 == 'number') {
        return obj1 == obj2
    } else if (Array.isArray(obj1) && Array.isArray(obj2) ) {
        //go through list and remove from obj2.. then chekc if empty
        return arrays_are_similar(obj1, obj2)
    } else if (typeof obj1 == "object") {
        return objects_are_similar(obj1, obj2)
    } else {
        //onsole.log("variables_are_similar NOT - Unknown mismatch ",obj1,obj2)
        return false
    }

    // Array.isArray(anObject) || typeof anObject != "object"
}
var arrays_are_similar = function(list1,list2) {
    if (list1.length != list2.length) {
        //onsole.log("variables_are_similar NOT - lists of idfferent engths")
        return false;
    } else if (list1.length==0){
        return true
    } else {
        for (var i =0; i<list1.length; i++) {
            if (!exports.variables_are_similar(list1[i], list2[i])) {
                //onsole.log("variables_are_similar NOT - lists are unsimilar - may be unordered - todo - add unordered option to lists")
                return false;
            }
        }
        return true
    }
}
var objects_are_similar = function (obj1, obj2) {
    if (!obj1 && !obj2) {
        return true
    } else if (!obj1) {
        //onsole.log("objects_are_similar NOT - missing obj1 vy obj2 ",obj2)
        return false
    } else if (!obj2) {
        //onsole.log("objects_are_similar NOT -missing obj2 vy obj1 ",obj1)
        return false
    } else {
        for (var key in obj1) {
          if (obj1.hasOwnProperty(key)) {
            if (!exports.variables_are_similar(obj1[key],obj2[key]) ) {
                //onsole.log("objects_are_similar NOT -Mismatch comparing ",key,obj1[key],obj2[key])
                return false;
            }
            delete obj2[key]
          }
        }
        for (var key in obj2) {
          if (obj2.hasOwnProperty(key)) {
            return false
          }
        }
        return true;
    }
}

exports.isEmpty = function(obj)  {
    if (!obj) return true
    return Object.keys(obj).length === 0 && obj.constructor === Object;
}
