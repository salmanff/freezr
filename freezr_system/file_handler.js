// freezr.info - nodejs system files - file_handler
exports.version = "0.0.122";

var path = require('path'),
    fs = require('fs'),
    async = require('async'),
    helpers = require('./helpers.js'),
    flags_obj = require("./flags_obj.js");
    sensor = require("./file_sensor.js"),
    json = require('comment-json');


var freezr_environment = null; // variable set below
var custom_environment= null;
/*  custom_environment can have the following
custom_environment.init_custom_env

custom_environment.use
custom_environment.customFiles(app_name) - true if used ("custom_environment.use" needs to be set to true too)
custom_environment.writeUserFile(folderPartPath, fileName, saveOptions, data_model, freezr_environment, callback)
custom_environment.sendUserFile(res, filePartPath, freezr_environment)
custom_environment.get_app_config
custom_environment.appLocalFileExists(app_name, fileName, freezr_environment)
custom_environment.extractZippedAppFiles(zipfile, app_name, originalname, freezr_environment, callback)
custom_environment.readUserDir(user_id,app_name,folder_name, freezr_environment, callback)
custom_environment.readAppFileSyncParts(app_name, fileName, freezr_environment);
custom_environment.readFileSync(partialUrl, freezr_environment, callback);
*/


// SET UP

exports.reset_freezr_environment = function(env) {
    freezr_environment = env;
}
exports.init_custom_env = function(env_params, callback) {
    freezr_environment = env_params;
    var file_env_name = (env_params && env_params.userDirParams && env_params.userDirParams.name)? ("file_env_"+env_params.userDirParams.name+".js") : null;
    //custom_environment = (file_env_name && fs.existsSync(exports.systemPathTo('freezr_system/environment/'+file_env_name)) )? require(exports.systemPathTo('freezr_system/environment/'+file_env_name)):null;
    if (file_env_name && fs.existsSync(exports.systemPathTo('freezr_system/environment/'+file_env_name)) )  {
            env_okay = true;
            try {
                custom_environment =  require(exports.systemPathTo('freezr_system/environment/'+file_env_name));
            } catch (e) {
                env_okay = false;
                console.warn("got err in init_custom_env")
                callback(helpers.state_error("file_handler",exports.version,"init_custom_env", ("error reading file "+file_env_name+" - "+e.message), "error_in_custom_file") )
            }
            if (env_okay) custom_environment.init_custom_env(env_params, callback);
    } else {
        callback(null);
    }
}
exports.setup_file_sys = function(env_params, callback) {
    // returns false if it can't se up directories - and system fails
    // this is called reset_freezr_environment, so env shoiuld be set

    if (custom_environment && custom_environment.use && custom_environment.customFiles && custom_environment.customFiles() ) {
        custom_environment.setupFileSys(freezr_environment, helpers.USER_DIRS, callback)
    } else {

        try {
            let path = userAppsLocalPathTo();
            if (!fs.existsSync(path) ) fs.mkdirSync(path);
            helpers.USER_DIRS.forEach(function(userDir) {
                let path = userAppsLocalPathTo(userDir);
                if (!fs.existsSync(path) ) fs.mkdirSync(path);
            });
            callback(null)
        } catch (e) {
            helpers.state_error("file_handler.js",exports.version,"setupFileSys", e, "setup_file_sys_failure" )
        }
    }
}

// General Utilities
  exports.fileExt = function(fileName) {
        var ext = path.extname(fileName);
        if (ext && ext.length>0) ext = ext.slice(1);
        return ext;
    }
	exports.sep = function() {return path.sep };
	exports.normUrl = function(aUrl) {return path.normalize(aUrl) };
	exports.removeStartAndEndSlashes = function(aUrl) {
		if (helpers.startsWith(aUrl,"/")) aUrl = aUrl.slice(1);
		if (aUrl.slice(aUrl.length-1) == "/") aUrl = aUrl.slice(0,aUrl.length-1);
		return aUrl;
	}
  exports.folder_is_in_list_or_its_subfolders = function(folder_name, checklist) {
        folder_name = exports.removeStartAndEndSlashes(folder_name);
        if (!folder_name || !checklist || checklist.length==0)  return false;
        var sharable_folder;
        for (var i= 0; i<checklist.length; i++) {
            sharable_folder = exports.removeStartAndEndSlashes(checklist[i])
            if (exports.startsWith(folder_name, sharable_folder)) {
                return true;
            }
        }
        return false;
    }
  exports.valid_path_extension = function(aPath) {
        var parts = aPath.split(path.sep);
        if (!aPath) return true;
        for (var i=0; i<parts.length; i++) {
            if (!helpers.valid_dir_name(parts[i]) ) return false
        }
    return true;
    }


// CUSTOM ENV AND LOCAL ENV ACTIONS
var useCustomEnvironment = function(env_params, app_name) {
    if (isSystemApp(app_name)) return false;
    if (!env_params || !env_params.userDirParams || !custom_environment || !custom_environment.use || !custom_environment.customFiles || !custom_environment.customFiles(app_name) ) return false;
    return true;
}
exports.sendAppFile = function(res, partialUrl, env_params) {
    //onsole.log ("sending app file "+partialUrl) //+" test_custom_env "+partialUrl+"en parmas"+JSON.stringify(env_params))
    partialUrl = path.normalize(partialUrl);
    var path_parts = partialUrl.split(path.sep);
    var app_name = path_parts[1];

    if (useCustomEnvironment(env_params, app_name) ) {
        var filePath = exports.removeStartAndEndSlashes(partialUrl.replace("app_files","userapps"));
        custom_environment.sendAppFile(res, filePath, env_params);
    } else {

        var filePath = (helpers.system_apps.indexOf(app_name)>=0)? exports.systemAppsPathTo(partialUrl):userAppsLocalPathTo(partialUrl);
        if (!fs.existsSync(filePath)) {
            if (!helpers.endsWith(partialUrl,"logo.png")) {
                helpers.warning("file_handler.js", exports.version, "sendAppFile", "link to non-existent file "+filePath );
            }
            res.sendStatus(401);
        } else {
            res.sendFile(filePath);
        }
    }
}


exports.get_file_content = function(app_name, page_url, env_params, callback){
    //onsole.log("get_file_content for "+app_name+" - " +page_url+" have custom env? "+(custom_environment? "yes":"No"))
    var isSystemAppRef = function(aUrl) {
        if (!helpers.startsWith(aUrl,"./")) return false;
        var parts = aUrl.split("/");
        if (isSystemApp(parts[1])) return true;
        return false;
    }
    var filePath = exports.removeStartAndEndSlashes(exports.partPathToAppFiles(app_name, page_url));
    if (!useCustomEnvironment(env_params, app_name) || isSystemAppRef(page_url) ) {
        fs.readFile( exports.appsLocalPathTo( filePath ), 'utf8', function (err, html_content) {  callback(err, html_content) })
    } else {
        filePath = filePath.replace("app_files","userapps");
        custom_environment.get_file_content(filePath, env_params, callback);
    }
}
exports.extractZippedAppFiles = function(zipfile, app_name, originalname, env_params, callback){
    if (useCustomEnvironment(env_params, app_name) ) {
        custom_environment.extractZippedAppFiles(zipfile, app_name, originalname, env_params, callback);
    } else {
        //onsole.log("getting "+'.'+path.sep+'forked_modules'+path.sep+'adm-zip'+path.sep+'adm-zip.js');
        var AdmZip = require('./forked_modules/adm-zip/adm-zip.js');
        //var AdmZip = require('.'+path.sep+'forked_modules'+path.sep+'adm-zip'+path.sep+'adm-zip.js');

        try {
            var zip = new AdmZip(zipfile); //"zipfilesOfAppsInstalled/"+app_name);
            var app_path = exports.fullLocalPathToAppFiles(app_name, null)
            //onsole.log("extractZippedAppFiles to path "+app_path)

            var zipEntries = zip.getEntries(); // an array of ZipEntry records
            var gotDirectoryWithAppName = false;

            zipEntries.forEach(function(zipEntry) {
                // This is for case of compressing with mac, which also includes the subfolder - todo: review quirks with windows
                if (zipEntry.isDirectory && zipEntry.entryName == app_name+"/") gotDirectoryWithAppName= true;
                if (zipEntry.isDirectory && zipEntry.entryName == originalname+"/") gotDirectoryWithAppName= true;
            });

            if (gotDirectoryWithAppName) { // If app named fodler was top level in the zip file
                zip.extractEntryTo(app_name + "/", userAppsLocalPathTo(), true, true);
            } else {
                zip.extractAllTo(app_path, true);
            }
            callback(null)

        } catch ( e ) {
            callback(helpers.invalid_data("error extracting from zip file "+JSON.stringify(e) , "file_handler", exports.version, "extractZippedAppFiles"));
        }
    }
}
exports.deleteAppFolderAndContents = function(app_name, env_params, callback){
    if (useCustomEnvironment(env_params, app_name) ) {
        return custom_environment.deleteAppFolderAndContents(app_name,env_params, callback)
    } else {
        if (exports.appLocalFileExists(app_name)) {
            var path = exports.fullLocalPathToAppFiles(app_name);
            deleteLocalFolderAndContents(path, function(err) {
                // ignores err of removing directories - todo shouldflag
                if (err) console.warn("ignoring ERROR in removing app files for "+app_name+ "err:"+err);
                callback(null)
            });        // from http://stackoverflow.com/questions/18052762/in-node-js-how-to-remove-the-directory-which-is-not-empty
        } else { callback(null)}
    }
}
exports.requireFile = function(partialUrl, file_name, env_params, callback) {
    var path_parts = partialUrl.split("/");
    var app_name = (path_parts && path_parts.length>1)? path_parts[2]:null;

    if (useCustomEnvironment(env_params, app_name) ) {
        custom_environment.requireFile(partialUrl, env_params, callback);
    } else {
        let err, env_on_file;
        //onsole.log("sendUserFile "+partialUrl)
        try {
          //onsole.log("requireFile in file_handler for ",exports.fullLocalPathToUserFiles(partialUrl, file_name))
          env_on_file = require(exports.fullLocalPathToUserFiles(partialUrl, file_name))
        } catch(e) {
          err=e
        }
        callback(err, env_on_file)
    }
}
exports.sendUserFile = function(res, partialUrl, env_params) {
    var path_parts = partialUrl.split("/");
    var app_name = path_parts[2];

    if (useCustomEnvironment(env_params, app_name) ) {
        custom_environment.sendUserFile(res, partialUrl, env_params);
    } else {
        //onsole.log("sendUserFile "+partialUrl)
        res.sendFile( exports.fullLocalPathToUserFiles(partialUrl, null) ) ;
    }
}
exports.writeUserFile = function (folderPartPath, fileName, saveOptions, data_model, req, callback) {
    //onsole.log("writeUserFile "+folderPartPath+" - "+fileName)
    if (useCustomEnvironment(req.freezr_environment, req.params.app_name) ) {
        custom_environment.writeUserFile(folderPartPath, fileName, saveOptions, data_model, req, callback)
    } else {
        localCheckExistsOrCreateUserFolder(folderPartPath, function() {
            if (fs.existsSync(exports.fullLocalPathToUserFiles(folderPartPath, fileName)  ) ) {
                if ( saveOptions && saveOptions.fileOverWrite  ) {
                    // all okay
                } else if (data_model && data_model.file && data_model.file.donot_auto_enumerate_duplicates) {
                   cb(app_err("Config settings are set to donot_auto_enumerate_duplicates. To over-write a file, fileOverWrite must be set to true in options."));
                } else {
                    fileName = auto_enumerate_filename(folderPartPath,fileName);
                }
            }
            //onsole.log("writeUserFile to ",exports.fullLocalPathToUserFiles(folderPartPath, fileName))
            fs.writeFile(exports.fullLocalPathToUserFiles(folderPartPath, fileName), req.file.buffer, function() {callback(null, fileName )});
        });
    }
}
exports.writeTextToUserFile = function (folderPartPath, fileName, fileText, saveOptions, data_model, app_name, freezr_environment, callback) {
   if (useCustomEnvironment(freezr_environment, app_name) ) {
        custom_environment.writeTextToUserFile(folderPartPath, fileName, fileText, saveOptions, data_model, app_name, freezr_environment, callback)
    } else {
        localCheckExistsOrCreateUserFolder(folderPartPath, function() {
            if (fs.existsSync(exports.fullLocalPathToUserFiles(folderPartPath, fileName)  ) ) {
                if ( saveOptions && saveOptions.fileOverWrite  ) {
                    // all okay
                } else if (data_model && data_model.file && data_model.file.donot_auto_enumerate_duplicates) {
                   cb(app_err("Config settings are set to donot_auto_enumerate_duplicates. To over-write a file, fileOverWrite must be set to true in options."));
                } else {
                    fileName = auto_enumerate_filename(folderPartPath,fileName);
                }
            }
            //onsole.log("Writing writeTextToUserFile to ",exports.fullLocalPathToUserFiles(folderPartPath, fileName))
            fs.writeFile(exports.fullLocalPathToUserFiles(folderPartPath, fileName), fileText, function() {callback(null, fileName )});
        });
    }
}
exports.readUserDir = function(user_id,app_name,folder_name, env_params, callback){
    if (useCustomEnvironment(env_params, app_name) ) {
        return custom_environment.readUserDir(user_id,app_name,folder_name, freezr_environment, callback);
    } else {
        fs.readdir(userAppsLocalPathTo("userfiles"+exports.sep()+user_id+exports.sep()+app_name+(folder_name?exports.sep()+folder_name:"")), callback)
    }
}
exports.checkExistsOrCreateUserAppFolder = function (app_name, env_params, callback) {
    // console from security perspective should wipe out files so no rogue files remain from previous installs ( todo)
    if (useCustomEnvironment(env_params, app_name) ) {
        custom_environment.checkExistsOrCreateUserAppFolder(app_name, env_params, callback);
    } else {
        var app_path = exports.partPathToUserAppFiles(app_name, null);
        localCheckExistsOrCreateUserFolder(app_path, callback);
    }
}
exports.clearFSAppCache = function (app_name, env_params, callback) {
    // console from security perspective should wipe out files so no rogue files remain from previous installs ( todo)
    if (useCustomEnvironment(env_params, app_name) ) {
        custom_environment.clearFSAppCache(app_name, env_params, callback);
    } else {
        callback(null);
    }
}
exports.async_app_config = function(app_name, env_params, callback) {
    if (useCustomEnvironment(env_params, app_name)) {
        custom_environment.async_app_config(app_name, env_params, callback);
    } else if (!exports.appLocalFileExists(app_name, 'app_config.json', null)){
        //onsole.log("Missing app config for "+app_name)
        callback(null, null);
    } else {
        var returnJson= {}, err = null;
        var configPath = exports.fullLocalPathToAppFiles(app_name,'app_config.json');

        fs.readFile( configPath, function (err, app_config) {
            if (err) {
                console.warn("ERROR READING APP CONFIG (1) "+app_name)
                callback(helpers.error("file_handler.js",exports.version,"async_app_config", "Error reading app_config file for "+app_name+": "+JSON.stringify(e)) );
            } else{
                try {
                    app_config = json.parse(app_config, null, true);
                } catch (e) {
                    console.warn("ERROR READING app config (2) "+app_name)
                    console.warn(e)
                    err = helpers.app_config_error(exports.version, "file_handler:async_app_config", app_name,app_name+" app_config could not be parsed..."+e.message+" - parsing requires app config to have double quotes in keys.")
                    app_config = null;
                }
                callback(err, app_config);
            }
        });
    }
}
exports.sensor_app_directory_files = function (app_name, flags, env_params, callback) {
    // onsole.log("sensor_app_directory_files for "+app_name )

    if (custom_environment && custom_environment.use && custom_environment.customFiles && custom_environment.customFiles(app_name) ) {
        custom_environment.sensor_app_directory_files(app_name, flags, env_params, callback);
    } else {
        // todo needs to dill through sub-directories iteratively (add custom directories...)
        var app_path = exports.fullPathToUserLocalAppFiles(app_name, null);
        var appfiles = fs.readdirSync(app_path);
        if (fs.existsSync(app_path+path.sep+'public')) {
            var publicfiles = fs.readdirSync(app_path+path.sep+'public');
            publicfiles.forEach(function(publicfile) {
                appfiles.push("public"+path.sep+publicfile)
            } )
        }
        var file_ext = "", file_text="";
        if (!flags) flags = new Flags({'app_name':app_name});

        async.forEach(appfiles, function(fileName, cb2) {
            var skip_file=false;
            async.waterfall([
                // 1. get file stats
                function (cb3) {
                    skip_file = false;
                    fs.stat(app_path+path.sep+fileName, cb3)
                },

                // 2. if directory skip... if not read file
                function (stats, cb3) {
                    if (stats.isDirectory()) {
                        skip_file = true;
                        flags = sensor.add_directory_flags(fileName, flags);
                        cb3(null, cb3)
                    } else {
                        fs.readFile(app_path+path.sep+fileName, cb3)
                    }
                },

                // sensor filetext
                function (data, cb3) {
                    if (!skip_file) flags = sensor.sensor_file_text(data, fileName, flags);
                    cb3(null)
                }

                ],
                function (err) {
                    if (err) {
                        helpers.warning("file_handler.js",exports.version,"sensor_app_directory_files", "Got err (1): "+JSON.stringify(err));
                        flags.add('errors','err_file',{'function':'sensor_app_directory_files', 'text':JSON.stringify(err), 'fileName':fileName});
                        cb2(null);
                    } else {
                        cb2(null);
                    }
                });
        },
        function (err) {
            if (err) {
                helpers.warning("file_handler.js",exports.version,"sensor_app_directory_files", "Gor err (2): "+JSON.stringify(err));
                flags.add('errors','err_unknown',{'function':'sensor_app_directory_files', 'text':JSON.stringify(err)})
                callback(null, flags, callback);
            } else {
                callback(null, flags, callback);
            }
        })
    }
}

// UTILS FOR CUSTOM ENV AND NORMAL ENV
exports.partPathToAppFiles = function(app_name, fileName) {
    // onsole.log("partPathToAppFiles app "+app_name+" file "+fileName)
    if (helpers.startsWith(fileName,"./")) return '/app_files'+fileName.slice(1);
    return '/app_files/'+app_name+ (fileName? '/'+fileName: '') ;
}
exports.partPathToUserAppFiles = function(app_name, fileName) {
    // onsole.log("partPathToAppFiles app "+app_name+" file "+fileName)
    let partialPath = (freezr_environment && freezr_environment.userDirParams && freezr_environment.userDirParams.userRoot)? (freezr_environment.userDirParams.userRoot + path.sep):""
    partialPath = path.sep + partialPath + 'userapps'
    if (helpers.startsWith(fileName,"./")) return partialPath+fileName.slice(1);
    return partialPath + path.sep + app_name + (fileName? '/'+fileName: '') ;
}
exports.check_app_config = function(app_config, app_name, app_version, flags){
    // onsole.log("check_app_config "+app_name+" :"+JSON.stringify(app_config));
    // todo - check permissions and structure of app config
        //  needs to be made more sophisticated and may be in file_sensor)

    if (!flags) flags = new Flags({'app_name':app_name, 'didwhat':'reviewed'}  );
    if (!app_config) {
        flags.add('warnings','appconfig_missing')
    } else {
        if (app_config.meta) {
            if (app_config.meta.app_version && app_version && app_version != app_config.meta.app_version) {
                    flags.add('notes','config_inconsistent_version' )
                }
            if (app_config.meta.app_name && app_name!=app_config.meta.app_name) {
                    flags.add ('notes', 'config_inconsistent_app_name',{'app_name':app_config.meta.app_name});
                }
        }
        if (app_config.pages) {
            for (var page in app_config.pages) {
                if (app_config.pages.hasOwnProperty(page)) {
                    if ( exports.fileExt(app_config.pages[page].html_file) != "html" )  flags.add("warnings", "config_file_bad_ext", {'ext':'html','filename':app_config.pages[page].html_file});
                    if (app_config.pages[page].css_files) {
                        if (typeof app_config.pages[page].css_files == "string") app_config.pages[page].css_files = [app_config.pages[page].css_files];
                        app_config.pages[page].css_files.forEach(
                            function(one_file) {
                                if ( exports.fileExt(one_file) != "css" ) flags.add("warnings", "config_file_bad_ext", {'ext':'css','filename':one_file});
                            }
                        )
                    }
                    if (app_config.pages[page].script_files) {
                        if (typeof app_config.pages[page].script_files == "string") app_config.pages[page].script_files = [app_config.pages[page].script_files];
                        app_config.pages[page].script_files.forEach(
                            function (one_file) {
                                if ( exports.fileExt(one_file) != "js" ) {
                                    flags.add("warnings", "config_file_bad_ext", {'ext':'js','filename':one_file})
                                }
                        });
                    }
                }
            }
        }
    }
    return flags;
}

// LOCAL ONLY
exports.fullLocalPathToUserFiles = function(targetFolder, fileName) {
	// target flder format and rights must have been valdiated.. ie starts with userfiles / user name / app name
	//onsole.log("fullLocalPathToUserFiles  "+targetFolder+" file:"+fileName+" freezr_environment"+JSON.stringify(freezr_environment));
  let partialUrl = exports.removeStartAndEndSlashes(targetFolder) + (fileName? path.sep+fileName: '');
  if (freezr_environment && freezr_environment.userDirParams && freezr_environment.userDirParams.userRoot) partialUrl = freezr_environment.userDirParams.userRoot + path.sep + partialUrl
	return path.normalize(systemPath() + path.sep + partialUrl )
}
exports.appLocalFileExists = function(app_name, file_name, env_params) {
    //
    return fs.existsSync(exports.fullLocalPathToAppFiles(app_name,file_name));
}
exports.existsSyncLocalSystemAppFile = function(fullPath) {
    //
    return fs.existsSync(fullPath);
}
exports.fullLocalPathToAppFiles = function(app_name, fileName) {
    //onsole.log("fullLocalPathToAppFiles  "+app_name+" freezr_environment"+JSON.stringify(freezr_environment));
    var partialUrl = ('app_files'+path.sep+app_name+ (fileName? path.sep+fileName: ''));
    if (isSystemApp(app_name)) return exports.systemAppsPathTo(partialUrl)
    return userAppsLocalPathTo(partialUrl);
}
exports.fullPathToUserLocalAppFiles = function(app_name, fileName) {
    // onsole.log("fullPathToUserLocalAppFiles  "+app_name+" freezr_environment"+JSON.stringify(freezr_environment));
    return exports.appsLocalPathTo(('app_files'+path.sep+app_name+ (fileName? path.sep+fileName: '')) );
}
exports.systemPathTo = function(partialUrl) {
    if (partialUrl) {
        return path.normalize(systemPath() + path.sep + exports.removeStartAndEndSlashes(partialUrl) ) ;
    } else {
        return systemPath();
    }
}
var systemPath = function() {
    //
    return path.normalize(__dirname.replace(path.sep+"freezr_system","") )
}
var isSystemApp = function(app_name) {
    //
    return (helpers.system_apps.indexOf(app_name)>=0)
}
var isSystemPath = function(aUrl) {
        var parts = aUrl.split("/");
        var app_name = (parts && parts.length>1)? parts[1]:"";
        return isSystemApp(app_name);
}
exports.appsLocalPathTo = function(partialUrl) {
    var path_parts = partialUrl.split("/");
    var app_name = path_parts[1];
    return isSystemApp(app_name)? exports.systemAppsPathTo(partialUrl) : userAppsLocalPathTo(partialUrl);
}
exports.systemAppsPathTo = function(partialUrl) {
    //onsole.log("systemAppsPathTo "+partialUrl)
    return exports.systemPathTo(partialUrl.replace("app_files","systemapps") );
}
exports.userLocalFileStats = function(user_id,app_name,folder_name, file_name, callback){
    if (!app_name) callback(helpers.error("cannot get user stats on root directory"))
    else fs.stat (userAppsLocalPathTo("userfiles"+exports.sep()+user_id+exports.sep()+app_name+(folder_name?exports.sep()+folder_name:"")+exports.sep()+file_name), callback);
}
var deleteLocalFolderAndContents = function(location, next) {
    // http://stackoverflow.com/questions/18052762/in-node-js-how-to-remove-the-directory-which-is-not-empty
    fs.readdir(location, function (err, files) {
        async.forEach(files, function (file, cb) {
            file = location + path.sep + file
            fs.stat(file, function (err, stat) {
                if (err) {
                    return cb(err);
                }
                if (stat.isDirectory()) {
                    deleteLocalFolderAndContents(file, cb);
                } else {
                    fs.unlink(file, function (err) {
                        if (err) {
                            return cb(err);
                        }
                        return cb();
                    })
                }
            })
        }, function (err) {
            if (err) return next(err)
            fs.rmdir(location, function (err) {
                return next(err)
            })
        })
    })
}
var auto_enumerate_filename = function(folderpath,fileName) {
    var parts = fileName.split('.')
    var has_version_num = !isNaN(parts[parts.length-2]);
    var version_num = has_version_num? parseInt(parts[parts.length-2]): 1;
    if (!has_version_num) parts.splice(parts.length-1,0,version_num);
    parts[parts.length-2] = version_num++

    while (fs.existsSync( exports.fullLocalPathToUserFiles(folderpath, parts.join('.')) ) ){
        parts[parts.length-2] = version_num++;
    }
    return parts.join(".");
}
var localCheckExistsOrCreateUserFolder = function (aPath, callback) {
    // from https://gist.github.com/danherbert-epam/3960169
    //onsole.log("localCheckExistsOrCreateUserFolder checking "+aPath)
    var pathSep = path.sep;
    var dirs =  path.normalize(aPath).split(path.sep);
    if (freezr_environment && freezr_environment.userDirParams && freezr_environment.userDirParams.userRoot) dirs.unshift(freezr_environment.userDirParams.userRoot)
    var root = "";

    mkDir();

    function mkDir(){

        var dir = dirs.shift();
        if (dir === "") {// If directory starts with a /, the first path will be th root user folder.
            root = systemPath() + pathSep;
        }
        //onsole.log("mkDir "+root + dir);

        fs.exists(root + dir, function(exists){
            if (!exists){
                fs.mkdir(root + dir, function(err){
                    root += dir + pathSep;
                    if (dirs.length > 0) {
                        mkDir();
                    } else if (callback) {
                        callback();
                    }
                });
            } else {
                root += dir + pathSep;
                if (dirs.length > 0) {
                    mkDir();
                } else if (callback) {
                    callback();
                }
            }
        });
    }
};
var userAppsLocalPathTo = function(partialUrl) {
    if (!partialUrl) partialUrl="app_files"
    partialUrl = exports.removeStartAndEndSlashes(partialUrl.replace("app_files","userapps") );
    if (freezr_environment && freezr_environment.userDirParams && freezr_environment.userDirParams.userRoot) partialUrl = freezr_environment.userDirParams.userRoot + path.sep + partialUrl

    //onsole.log("userAppsLocalPathTo "+partialUrl)
    if (custom_environment) { // todo clean up - make sure custom env is needed
        console.warn("SNBH - tdodo - review - "+partialUrl)
        return partialUrl
    } else {
        return exports.systemPathTo(partialUrl);
    }
}


// MAIN LOAD PAGE
const FREEZR_CORE_CSS = '<link rel="stylesheet" href="/app_files/info.freezr.public/freezr_core.css" type="text/css" />'
const FREEZR_CORE_JS = '<script src="/app_files/info.freezr.public/freezr_core.js" type="text/javascript"></script>'
exports.load_data_html_and_page = function(res,options, env_params){
    //onsole.log("load_data_html_and_page  for "+JSON.stringify(options.page_url) )
    exports.get_file_content(options.app_name, options.page_url, env_params, function(err, html_content) {
        if (err) {
            helpers.warning("file_handler", exports.version, "load_data_html_and_page", "got err reading: "+exports.partPathToAppFiles(options.app_name, options.page_url) )
            res.redirect('/account/home?error=true&error_type=internal&msg=couldnotreadfile-'+options.app_name+"/"+options.page_url)
        } else {
            //onsole.log("got file content in file handler for ",options.app_name, options.page_url)
            if (options.queryresults){
                //onsole.log("queryresults:"+JSON.stringify(options.queryresults))
                var Mustache = require('mustache');
                options.page_html =  Mustache.render(html_content, options.queryresults);
                exports.load_page_html(res,options)
            } else {
                options.page_html= html_content;
                exports.load_page_html(res,options)
            }
        }
    });
}
exports.load_page_html = function(res, opt) {
    //onsole.log("load page html",opt.app_name+"... "+opt.page_url)
    fs.readFile(
        opt.isPublic?'html_skeleton_public.html':'html_skeleton.html',
        function (err, contents) {
            if (err) {
                console.warn("err reading file "+err)
                helpers.warning("file_handler", exports.version, "load_page_html", "got err reading skeleton "+(opt.isPublic?'html_skeleton_public.html':'html_skeleton.html'))
                helpers.send_failure(res, 500, err);
                return;
            }

            contents = contents.toString('utf8');


            if (!opt.app_name) {
                // need these two to function
                opt.app_name = "info.freezr.public";
                opt.page_url = 'fileNotFound.html';
            }

            contents = contents.replace('{{PAGE_TITLE}}', opt.page_title? opt.page_title: "app - freezr");
            contents = contents.replace('{{PAGE_URL}}', exports.partPathToAppFiles(opt.app_name, opt.page_url) );
            contents = contents.replace('{{APP_CODE}}', opt.app_code? opt.app_code: '');
            contents = contents.replace('{{APP_NAME}}', opt.app_name);
            contents = contents.replace('{{APP_VERSION}}', (opt.app_version));
            contents = contents.replace('{{APP_DISPLAY_NAME}}', (opt.app_display_name? opt.app_display_name: opt.app_name));
            contents = contents.replace('{{USER_ID}}', opt.user_id? opt.user_id: '');
            contents = contents.replace('{{USER_IS_ADMIN}}', opt.user_is_admin? opt.user_is_admin : false);
            contents = contents.replace('{{FREEZR_SERVER_VERSION}}', (opt.freezr_server_version? opt.freezr_server_version: "N/A"));
            contents = contents.replace('{{SERVER_NAME}}', opt.server_name);
            contents = contents.replace('{{FREEZR_CORE_CSS}}', FREEZR_CORE_CSS);
            contents = contents.replace('{{FREEZR_CORE_JS}}', FREEZR_CORE_JS);
            var nonce = helpers.randomText(10)
            contents = contents.replace('{{FREEEZR-SCRIPT-NONCE}}', nonce);
            contents = contents.replace('{{FREEEZR-SCRIPT-NONCE}}', nonce); // 2nd instance
            contents = contents.replace('{{META_TAGS}}', opt.meta_tags? opt.meta_tags: '');

            contents = contents.replace('{{HTML-BODY}}', opt.page_html? opt.page_html: "Page Not found");


            var css_files = "", thePath;
            if (opt.css_files) {
                if (typeof opt.css_files == "string") opt.css_files = [opt.css_files];
                opt.css_files.forEach(function(a_file) {
                    thePath = exports.partPathToAppFiles(opt.app_name, a_file);
                    if (exports.fileExt(thePath) == 'css'){
                        css_files = css_files +  ' <link rel="stylesheet" href="'+thePath+'" type="text/css" />'
                    } else {
                        helpers.warning("file_handler.js",exports.version,"load_page_skeleton", "ERROR - NON CSS FILE BEING SUED FOR CSS.")
                    }

                });
            }
            contents = contents.replace('{{CSS_FILES}}', css_files)

            var script_files = "";
            if (opt.script_files) {
                opt.script_files.forEach(function(pathToFile) {
                	thePath = exports.partPathToAppFiles(opt.app_name, pathToFile);
                	script_files = script_files +  '<script src="'+thePath+'" type="text/javascript"></script>';
                });

            }
            contents = contents.replace('{{SCRIPT_FILES}}', script_files);

            // other_variables used by system only
            contents = contents.replace('{{OTHER_VARIABLES}}', opt.other_variables? opt.other_variables: 'null');

            // to do - to make messages better
            contents = contents.replace('{{MESSAGES}}', JSON.stringify(opt.messages));
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(contents);
        }
    );
}
exports.load_page_xml = function(res, opt) {
    //onsole.log("load page xml",opt.app_name+"... "+opt.page_url)
    fs.readFile(
        'freezr_xml_skeleton_public.xml',
        function (err, contents) {
            if (err) {
                console.warn("err reading file "+err)
                helpers.warning("file_handler", exports.version, "load_page_xml", "got err reading freezr_xml_skeleton_public ")
                helpers.send_failure(res, 500, err);
                return;
            }
            contents = contents.toString('utf8');

            contents = contents.replace('{{XML_CONTENT}}', opt.page_xml? opt.page_xml: "");

            //res.writeHead(200, { "Content-Type": "text/html" });
            res.type('application/xml')
            res.end(contents);
        }
    );
}
