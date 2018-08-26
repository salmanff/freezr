// freezr.info - nodejs system files - sample custom_envioronments.js
// A file named custom_envioronments.js can be set up using this template to create custom environments for accessing a custom db and file system
// Not db portion not currently operational as it requires changes in the freezr_system


// custom environment for dropbox

var Dropbox = require('dropbox'), 
	https = require('https'),
    async = require('async'), 
    helpers = require('../helpers.js'), 
    fs = require('fs'), path = require('path'), // for cached app files
    json = require('comment-json');

exports.version = "0.0.122";

var dbx = null;

var FILE_CACHE = {}
var MAX_LEN_FILE_CACHE = 100;
exports.use = true;

exports.customFiles = function(app_name) {return true} 
exports.customDb    = function(app_name) {return false} 


var useAppFileFSCache = function() {
	// todo - set to false base don user_prefs and ability to write to server 
	return true;
}
/*  
custom_environment should have the following functions for a db: TBCompleted

*/


exports.init_custom_env = function(env_params, callback)  {
	console.log("     Initialising custom environment for dropbox - dbx (NOTE - NODE 4.x + NEEDED TO RUN THIS.) ")
	var userDirParams = (env_params && env_params.userDirParams)? env_params.userDirParams: null;
	var access_token = (env_params && env_params.userDirParams && env_params.userDirParams.access_token)? env_params.userDirParams.access_token: null;
	if (!access_token) {					
		callback(helpers.auth_failure("file_env_dropbox.js", exports.version, "init_custom_env", "Could not initialise custom environment with dropbox - no access token ","missing_access_token_dropbox" ) );
	} else {
		dbx = new Dropbox({ accessToken: access_token });
		callback(null)
	}
}
exports.setupFileSys = function(freezr_environment, USER_DIRS, callback) {
	// no need to set up as dropbox creates parent folders automatically so doesnt create error
	callback(null);
}

exports.sendAppFile = function(res, filePath, env_params) {
	if (!dbx) exports.init_custom_env(env_params);
	//onsole.log("sending app file "+filePath)
    if (useAppFileFSCache() && fs.existsSync(systemPathTo (filePath))) {
    	//onsole.log("SENDING Cached version")
    	res.sendFile(systemPathTo(filePath));
    } else {
    	dbx.filesGetTemporaryLink({path: "/"+filePath})
		.then( response => https.get(response.link, secondRes => {
			secondRes.pipe(res);
			var pathOnly = filePath.split("/");
			if (useAppFileFSCache() && pathOnly.length>0){
		  	   	//onsole.log("Going to FScache the file on node server;");
		      	pathOnly.pop();
		      	// Note - async version of mkdir loses pipe so need to use sync
		      	localCheckExistsOrCreateUserFolderSync(pathOnly.join(path.sep) )
		  	var myFile = fs.createWriteStream(systemPathTo(filePath));
			secondRes.pipe(myFile);
				return;
			} else {return;}
		}) )
		.catch(error => {
			console.warn("err in send app file",error)
		if (error && error.error && error.error.error_summary && helpers.startsWith(error.error.error_summary, 'path/not_found') ){
		  	if (!helpers.endsWith(filePath,"logo.png")) helpers.warning("file_env_dropbox.js", exports.version, "sendAppFile", "Missing file:  "+filePath);
		} else {
			if (!error.message) error.message="";
			error.message+=" Missing file: "+filePath
			helpers.state_error ("file_env_dropbox", exports.version, "sendAppFile", error, "missing_file");
		}
		res.sendStatus(401);
		});
	}
    
} 

exports.writeUserFile = function (folderPartPath, fileName, saveOptions, data_model, req, callback) { 
	//onsole.log("writeUserFile",folderPartPath)
	// Used for userapps and userfiles

	if (!dbx) exports.init_custom_env(req.freezr_environment);
	var filePath = (folderPartPath? ("/"+folderPartPath):"")+(fileName? ("/"+fileName) : "");
	
	var uploadparams = {path: filePath , contents:req.file.buffer };
	if (saveOptions && saveOptions.fileOverWrite ) {
		uploadparams.mode = "overwrite";
	} else if (data_model && data_model.file && data_model.file.donot_auto_enumerate_duplicates) {
		uploadparams.mode = "add";
    	uploadparams.autorename = false;
	} else {
		uploadparams.mode = "add";
    	uploadparams.autorename = true;
	}
	dbx.filesUpload(uploadparams)
	    .then(response => {
	    	callback(null, response.name)
	    } )
        .catch(function(error) {
          	var errparse = {};
          	if (error) errparse = JSON.parse(error.error);
          	if (errparse && errparse.error && errparse.error.reason && errparse.error.reason[".tag"] && errparse.error.reason[".tag"] == "conflict" ) {
          		error = helpers.state_error ("file_env_dropbox", exports.version, "writeUserFile", new Error("Dropbox environment: Conflict in writing file."),"write_conflict_dropbox");
          		// ADD ERROR HERE AND IN FILE_HANDLER AND HANDLE ON FRONT-END SIDE
          	} else if (errparse && errparse.error && errparse.error.reason && errparse.error.reason[".tag"]){
          		error = helpers.state_error ("file_env_dropbox", exports.version, "writeUserFile", new Error(JSON.stringfy(errparse.error)),errparse.error.reason[".tag"]);
          	} else {
          		error = helpers.state_error ("file_env_dropbox", exports.version, "writeUserFile", error,"dropbox_write_error");
          	}
          	callback(error, null) //, callback)
        });	
}
exports.writeTextToUserFile = function (folderPartPath, fileName, fileText, saveOptions, data_model, app_name, freezr_environment, callback) { 
	//onsole.log("writeUserFile",folderPartPath)
	// Used for userapps and userfiles

	if (!dbx) exports.init_custom_env(freezr_environment);
	var filePath = (folderPartPath? ("/"+folderPartPath):"")+(fileName? ("/"+fileName) : "");

	var fileBuffer =  fileText;
	
	var uploadparams = {path: filePath , contents:fileBuffer };
	if (saveOptions && saveOptions.fileOverWrite ) {
		uploadparams.mode = "overwrite";
	} else if (data_model && data_model.file && data_model.file.donot_auto_enumerate_duplicates) {
		uploadparams.mode = "add";
    	uploadparams.autorename = false;
	} else {
		uploadparams.mode = "add";
    	uploadparams.autorename = true;
	}
	dbx.filesUpload(uploadparams)
	    .then( response => callback(null, response.name) )
        .catch(function(error) {
          	var errparse = {};
          	if (error) errparse = JSON.parse(error.error);
          	if (errparse && errparse.error && errparse.error.reason && errparse.error.reason[".tag"] && errparse.error.reason[".tag"] == "conflict" ) {
          		error = helpers.state_error ("file_env_dropbox", exports.version, "writeUserFile", new Error("Dropbox environment: Conflict in writing file."),"write_conflict_dropbox");
          		// ADD ERROR HERE AND IN FILE_HANDLER AND HANDLE ON FRONT-END SIDE
          	} else if (errparse && errparse.error && errparse.error.reason && errparse.error.reason[".tag"]){
          		error = helpers.state_error ("file_env_dropbox", exports.version, "writeUserFile", new Error(JSON.stringfy(errparse.error)),errparse.error.reason[".tag"]);
          	} else {
          		error = helpers.state_error ("file_env_dropbox", exports.version, "writeUserFile", error,"dropbox_write_error");
          	}
          	callback(error, null);
        });	
}

exports.checkExistsOrCreateUserAppFolder = function (app_name, env_params, callback) {
	if (!dbx) exports.init_custom_env(env_params);
	var filePath = "/userapps/"+app_name
	dbx.filesCreateFolder({path: filePath})
	    .then(response => {
	    	if (useAppFileFSCache()){
		    	var app_path = "userapps"+path.sep+app_name;
	        	localCheckExistsOrCreateUserFolderSync(systemPathTo(app_path));
	        }
	    	callback(null) 
	    } )
        .catch( error => {
          	if (error && error.error && error.error.error_summary && error.error.error_summary.indexOf( "conflict")>0 ) {
          		//onsole.log("checkExistsOrCreateUserAppFolder - FILE ALREADY EXSITS "+filePath+" - ignore error");
          		error=null;
          	} else {
          		helpers.state_error ("file_env_dropbox", exports.version, "checkExistsOrCreateUserAppFolder", error, "unown_error_making_directors" ) 
          	}
          	callback(error)
        });	
}

exports.clearFSAppCache = function (app_name, env_params, callback) {
    // console from security perspective should wipe out files so no rogue files remain from previous installs ( todo)
    if (useAppFileFSCache() && fs.existsSync(systemPathTo ("userapps/"+app_name))) {
            deleteLocalFolderAndCacheAndContents(app_name, null, function(err) {
                // ignores err of removing directories - todo shouldflag
                if (err) console.warn("ignoring ERROR in removing app files for "+app_name+ "err:"+err);
                callback(null)
            });        // from http://stackoverflow.com/questions/18052762/in-node-js-how-to-remove-the-directory-which-is-not-empty		
	} else {    
        callback(null);
	}
}


exports.sendUserFile = function(res, filePath, env_params) {
	if (!dbx) exports.init_custom_env(env_params);
	//onsole.log("SENDING USER FILE "+filePath)
	dbx.filesGetTemporaryLink({path: "/"+filePath})
		.then(response => https.get(response.link, secondRes => secondRes.pipe(res)) )
		.catch(error => {
		  	helpers.warning("file_env_dropbox.js", exports.version, "sendUserFile", "Missing file:  "+filePath);
		    res.sendStatus(401);
		});	
}
exports.get_file_content = function(filePath, env_params, callback) {
	//onsole.log("get_file_content for "+filePath)
	if (!dbx) exports.init_custom_env(env_params); 
	filePath = filePath.replace("app_files","userapps");
	if (!helpers.startsWith(filePath,"/")) filePath = "/"+filePath

	if ((env_params.reset_cache==undefined || !env_params.reset_cache) && FILE_CACHE[filePath] && FILE_CACHE[filePath].access_date) {
		FILE_CACHE[filePath].access_date = new Date().getTime()
		callback(null, FILE_CACHE[filePath].content)
	} else {
		if (Object.keys(FILE_CACHE).length > MAX_LEN_FILE_CACHE) reduce_file_cache_items();
		FILE_CACHE[filePath] = null;
		//onsole.log("checling for fscache "+filePath+" exists? "+fs.existsSync(systemPathTo (filePath)) )
	 	if (useAppFileFSCache() && fs.existsSync(systemPathTo (filePath))) {
	    	fs.readFile(systemPathTo( filePath ), 'utf8', (err, html_content) => { 
				if (!err) FILE_CACHE[filePath] = {content: html_content, 'access_date' : new Date().getTime()} 
				callback(err, html_content) 
			})
	    } else {
			dbx.filesDownload({path: filePath})
			.then(response => {
				FILE_CACHE[filePath] = {content: response.fileBinary, 'access_date' : new Date().getTime()};
				callback(null, response.fileBinary) 
			})
			.catch(error => {
				var errparse = JSON.parse(error.error);
				if (errparse && errparse.error_summary && helpers.startsWith(errparse.error_summary, 'path/not_found') ){
					console.warn("errparse.error_summary",errparse.error_summary)
					FILE_CACHE[filePath] = {content: '', 'access_date' : new Date().getTime()};
					callback(helpers.error("file_not_found","Could not get content for inexistant file at "+filePath) ,null)
				} else {
					helpers.warning("file_env_dropbox.js", exports.version, "get_file_content", "Could not get file content for  "+filePath);
			    	callback(error, null);
				}
			});
	    }
	}
}
exports.async_app_config = function (app_name, env_params, callback) {
	//onsole.log("async_app_config ")
	var filePath = "app_files/"+app_name+"/app_config.json";
	exports.get_file_content(filePath, env_params, function(err, app_config) {
		if (err) {
			if(err.code =="file_not_found") {
				//onsole.log("okay if app config is  missing for "+app_name)
				callback(null, null)
			} else {
				callback(helpers.app_config_error("NR", "file_env_dropbox:async_app_config", app_name,"Could not get contents of app_config for "+app_name));
			}
		} else if (app_config=='') {
			// Non-existant file in cache
			callback(null, null);
		} else {
			doParseConfig(app_name, app_config, callback);
		}
	})
}
var doParseConfig = function(app_name, app_config, callback) {
	if (!app_config) return (null, null);
	if (typeof app_config != "string")  {
		callback(helpers.app_config_error("NR", "file_env_dropbox:doParseConfig", app_name,app_name+" app_config passed to doParseConfig is not a string"));
	} else {
		//onsole.log("doParseConfig "+app_config)
		app_config = app_config.trim();				
		var err = null
		try {
			app_config = json.parse(app_config, null, true);
		} catch(e) {
			err = helpers.app_config_error(exports.version, "file_env_dropbox:doParseConfig", app_name,app_name+" app_config could not be parsed..."+e.message+" - parsing requires app config to have double quotes in keys.")
			app_config = null;
		}
		callback(err, app_config)
	}
}
exports.extractZippedAppFiles = function(zipfile, app_name, originalname, env_params, callback){
	var AdmZip = require('../forked_modules/adm-zip/adm-zip.js');
    var zip = new AdmZip(zipfile); //"zipfilesOfAppsInstalled/"+app_name);
    var zipEntries = zip.getEntries(); // an array of ZipEntry records
    var gotDirectoryWithAppName = null;
    zipEntries.forEach(function(zipEntry) {
        // This is for case of compressing with mac, which also includes the subfolder - todo: review quirks with windows
        if (!gotDirectoryWithAppName && zipEntry.isDirectory && zipEntry.entryName == app_name+"/") gotDirectoryWithAppName= app_name+"/";
        if (!gotDirectoryWithAppName && zipEntry.isDirectory && zipEntry.entryName == originalname+"/") {gotDirectoryWithAppName= originalname+"/";}
    });
    //onsole.log("env.extractZippedAppFiles "+app_name+" gotDirectoryWithAppName "+ gotDirectoryWithAppName )
		
	var call_fwd = function(file_name, is_directory, content, overwrite, callfwdback) {
		var fakereq = {
			file: {buffer: content},
			freezr_environment: env_params
		}

		var dowrite = true;
		if (helpers.endsWith(file_name,"/") ) {
			dowrite=false;
		} else {
			parts = file_name.split("/")
			if ( helpers.startsWith( parts[ parts.length-1 ], ".") ) {
				dowrite=false;
			}
		}
		if (dowrite) {
			if (gotDirectoryWithAppName && helpers.startsWith(file_name, gotDirectoryWithAppName) ) {
				file_name = "userapps/"+app_name+"/"+file_name.substring(gotDirectoryWithAppName.length);
			} else if (gotDirectoryWithAppName) {
				dowrite = false
			} else {
				file_name = "userapps/"+app_name+"/"+file_name;
			}
		}	
		if (dowrite) {
			//onsole.log("writing user file "+file_name)
			exports.writeUserFile (file_name, null, {fileOverWrite:true}, null, fakereq, function(err){
				if (err) helpers.warning("file_env_dropbox", exports.version, "extractZippedAppFiles", "Error writing file "+file_name+" to dropbox" )
				callfwdback();
			})
		} else {
			callfwdback();
		}

	}

	zip.extractAllToAsyncWithCallFwd(call_fwd, true, function(err) {
		if (err) {
			callback(err)
		} else if (useAppFileFSCache()){
			try { 
	            var zip = new AdmZip(zipfile); //"zipfilesOfAppsInstalled/"+app_name);
			    var partialUrl = 'userapps'+path.sep+app_name;
                var FSCache_app_path = systemPathTo(partialUrl);

	            if (gotDirectoryWithAppName) {
	                zip.extractEntryTo(app_name + "/", FSCache_app_path, false, true);
	            } else {
	                zip.extractAllTo(FSCache_app_path, true);
	            }
	            callback(null);
	        } catch ( e ) { 
	        	helpers.warning("file_env_dropbox", exports.version, "extractZippedAppFiles", "Error extracting to FSCache"+e )
	            callback(null);
	        }

		} else {
			callback(null)
		}
	});
};


exports.get_full_folder_file_list = function(partialUrl, iterate, env_params, callback) {
	if (!dbx) exports.init_custom_env(env_params);
	var fulllist = [];
	dbx.filesListFolder({path: partialUrl})
	  .then(function(response) {
	    fulllist = response.entries;
	    async.forEach(fulllist, function(entry, cb2) {
	    	if (iterate && entry[".tag"]=="folder") {
	    		exports.get_full_folder_file_list(entry.path_lower, iterate, env_params, function(err, sublist){
	    			fulllist = fulllist.concat(sublist)
	    			cb2(null)
	    		})
	    	} else {
	    		cb2(null);
	    	}
        }, function(err){
        	if (err) console.warn("got err in get_full_folder_file_list",err)
		    callback(null,fulllist)
	        // add to flags??
        })
	  })
	  .catch(function(error) {
	    console.warn("get_full_folder_file_list err:",error);
	        // add to flags??
	});
}

exports.sensor_app_directory_files = function (app_name, flags, env_params, callback) {
	// this needs to be restructuring so fle_sensor is called by Account:handler and then it calls file handler...
	// "algorithm" needs to become one! todo.
    var file_ext = "", file_text="";
    if (!flags) flags = new Flags({'app_name':app_name});

	if (!dbx) exports.init_custom_env(env_params); 
    exports.get_full_folder_file_list('/userapps/'+app_name, true, env_params, function(err, appfiles){
    	if (err) {
    		flags.add('errors', err.code, {'function':'sensor_app_directory_files', 'text':err.message});
    	} else {
	    	async.forEach(appfiles, function(fileInfo, cb2) {
	    		//onsole.log("Sensoring "+JSON.stringify(fileInfo))
	    		if (fileInfo[".tag"]=="folder") {
	    			cb2(null)
	    		} else if (sensor.isStaticFolder(fileInfo["path_lower"])) {
	    			cb2(null);
	    		} else if (sensor.is_text_file(fileInfo.name)){
	    			env_params.reset_cache = true; // convenient (though inlelegant) place to put this to renew cache
		    		exports.get_file_content(fileInfo.path_lower, env_params, function(err, content) { 
		        		if (err) {
		        			flags.add('errors', err.code, {'function':'sensor_app_directory_files', 'text':err.message});
		        		} else {
		        			flags = sensor.sensor_file_text(content, fileInfo.name, flags);
		        		}
		        		cb2(null);
		    		})
	    		} else if (sensor.is_allowed_file_ext(fileInfo.name)) {
	    			cb2(null);
	    		} else {
	    			flags.add('warnings','file_illegal_extension',{'fileName':fileInfo.name,'text':'Unknown file extension'});
	    			cb2(null);
	    		}
	        }, function(err){
	        	if (err) flags.add('errors', (err.code? err.code:"unknown_err_sensor"), {'function':'sensor_app_directory_files', 'text':err.message});
		    	env_params.reset_cache = false;
		        callback(null, flags, callback);
	        })
    	}
    })
}

exports.deleteAppFolderAndContents = function(app_name, env_params, callback){
	var filePath = "userapps/"+app_name;
	if (!dbx) exports.init_custom_env(env_params);
	dbx.filesDelete({path: "/"+filePath})
      .then( response => callback )
      .catch(error => {
            if (error) console.warn("ignoring ERROR in removing app files for "+app_name+ "err:"+error);
            callback(null)
      });
}

var reduce_file_cache_items = function() {
    var list = [];
    for (item in FILE_CACHE) { if (FILE_CACHE.hasOwnProperty(item)) {list.push({filePath:item, access_date: FILE_CACHE[item].access_date})} }
    var date_sort = function (obj1,obj2) { return obj1.access_date -obj2.access_date }
    list.sort(date_sort);
    const reduce_by = 0.2;
    const reduce_by_num = Math.round(reduce_by*MAX_LEN_FILE_CACHE)
    for (var i= 0; i<reduce_by_num; i++) {delete FILE_CACHE[list[i].filePath]; }
}


// file system - needed for caching - consider moving these into a fsutils file accessed by both file_handler and other env_file_handlers

var systemPathTo = function(partialUrl) {
    if (partialUrl) {
        return path.normalize(systemPath() + path.sep + removeStartAndEndSlashes(partialUrl) ) ;
    } else {
        return systemPath();    
    }
}
var systemPath = function() {
    //
    return path.normalize(__dirname.replace(path.sep+"freezr_system"+path.sep+"environment","") )
}
var removeStartAndEndSlashes = function(aUrl) {
	if (helpers.startsWith(aUrl,"/")) aUrl = aUrl.slice(1);
	if (aUrl.slice(aUrl.length-1) == "/") aUrl = aUrl.slice(0,aUrl.length-1);
	return aUrl;
}
var localCheckExistsOrCreateUserFolderSync = function (aPath) {
	/*
	if (!aPath) return;
	var dirs = aPath.split("/")
	if (aPath.length == 0) return;
	var thisPath = dirs.shift();
	var fullPath =  systemPathTo (aPath);
	if (!fs.existsSync(fullPath) ) fs.mkdirSync(fullPath);
	return;*/
    // from https://gist.github.com/danherbert-epam/3960169 modified for sync
    var pathSep = path.sep;
    var dirs = aPath.split("/");
    var root = "";
    
    mkDir();

    function mkDir(){
        var dir = dirs.shift();
        if (dir === "") {// If directory starts with a /, the first path will be th root user folder.
            root = systemPath() + pathSep;
        }
        if (!fs.existsSync(root + dir) ){
            fs.mkdirSync(root + dir); 
            root += dir + pathSep;
            if (dirs.length > 0) {
                mkDir();
            } else {
                return;
            }
        } else {
            root += dir + pathSep;
            if (dirs.length > 0) {
                mkDir();
            } else {
                return;
            }
    	};
    }
}

// delete FILE_CACHE[list[i].filePath];
var deleteLocalFolderAndCacheAndContents = function(app_name, subfolders, next) {
    // http://stackoverflow.com/questions/18052762/in-node-js-how-to-remove-the-directory-which-is-not-empty
    
    location = systemPathTo("userapps/"+app_name + (subfolders? ("/"+subfolders) :"") );
    //onsole.log("deleteLocalFolderAndCacheAndContents "+location);
    if (!subfolders) subfolders = ""

    fs.readdir(location, function (err, files) {
        async.forEach(files, function (file, cb) {
            var fullFilePath = location + '/' + file
            fs.stat(fullFilePath, function (err, stat) {
                if (err) {
                    return cb(err);
                }
                if (stat.isDirectory()) {
                    deleteLocalFolderAndCacheAndContents(app_name, (subfolders+"/"+file)  , cb);
                } else {
                	//onsole.log("deleting app cache for "+app_name+(subfolders? ("/"+subfolders+"/"):"/")+file )
                	if (FILE_CACHE[app_name+(subfolders? ("/"+subfolders+"/"):"/")+file  ]) delete FILE_CACHE[app_name+(subfolders? ("/"+subfolders+"/"):"/")+file  ]
                    if (fs.existsSync(fullFilePath)){
                        fs.unlink(fullFilePath, function (err) {
                            if (err) {
                            	console.warn("got err "+err)
                                return cb(err);
                            }
                            return cb();
                        })
                     } else {
                     	return cb();
                     }
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
