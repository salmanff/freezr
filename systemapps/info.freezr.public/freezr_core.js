/* Core freezr API - v0.0.122 - 2018-08

The following variables need to have been declared in index.html
    freezr_app_name, freezr_app_code, freezr_user_id, freezr_user_is_admin
    freezr web based apps declare these automatically

*/
  var freezr = {
      'db':{},  // data base related functions
      'perms':{}, // grant and query permissions
      'html':{},  // functions to render pages
      'filePath': {},  // functions to generate a correct path to files
      'initPageScripts':null, // initPageScripts can be defined in the app's js file to run initial scripts upon page load.
      'utils':{},
      'menu':{},
      'app': {
        'isWebBased':true, 
        'loginCallback':null,
        'logoutCallback':null,
        'server':null
      }
  };
  var freezer_restricted = {
      'utils':{}
  };
  freezr.onFreezrMenuClose = function(hasChanged) {}; // this is called when freezr menu is closed.
  var freezr_app_display_name = freezr_app_display_name? freezr_app_display_name:"";
  var freezr_app_version = freezr_app_version? freezr_app_version:"n/a";
  var freezr_server_version = freezr_server_version? freezr_server_version:"n/a";
// db Functions - data base related functions - to read or write 
freezr.db.write = function(data, options, callback) {
  // write to the database
  // options include collection, updateRecord, data_object_id (needed for updateRecord), restoreRecord, confirm_return_fields

  if (!data) {callback({"error":"No data sent."});}

  var contentType='application/json';
  var postData= JSON.stringify({'data':data, 'options':options});
  var collection =  (options && options.collection)? options.collection:"main";

  var url= "/v1/db/write/"+freezr_app_name+"/"+freezr_app_code+"/"+collection

  if (!callback) callback = function(aJson) {console.log(JSON.stringify(aJson)) };

  //onsole.log("posting to url "+url+" postdata "+JSON.stringify(postData))
  freezer_restricted.connect.send(url, postData, callback, "PUT", contentType);
};
freezr.db.upload = function(file, options, callback ) {
  // upload a file and record it in the database
  // options can be: data (a json of data related to file) and updateRecord
  // and file specific ones: targetFolder, fileName, fileOverWrite
  // For files uploaded, colelction is always "files"

  var url= "/v1/db/upload/"+freezr_app_name+"/"+freezr_app_code;  
  var uploadData = new FormData();
  if (file) {uploadData.append('file', file); /*onsole.log("Sending file1");*/}
  if (options && options.data) {
    uploadData.append("data", JSON.stringify(data));
    delete options.data;
  }
  if (options) uploadData.append("options", JSON.stringify(options));
  
  freezer_restricted.connect.send(url, uploadData, callback, "PUT", null);
};
freezr.db.getById = function(data_object_id, options, callback ) {
  // get a specific object by object id
  // options are collection_name, permission_name
  if (!data_object_id) {callback({"error":"No id sent."});}
  var requestee_app   = (!options || !options.requestee_app)? freezr_app_name: options.requestee_app;
  var collection_name = (options && options.collection_name)? options.collection_name : "main";
  var permission_name = (options && options.permission_name)? options.permission_name : "me";
  var url = '/v1/db/getbyid/'+permission_name+"/"+collection_name+"/"+freezr_app_name+'/'+freezr_app_code+'/'+requestee_app+'/'+data_object_id;
  freezer_restricted.connect.read(url, null, callback);
}
freezr.db.query = function(options, callback) {
  // queries db 
  // options are:
    // permission_name
    // field_name, field_value (necessary for field_permissions and folder)
    // collection - default is to use the first in list for object_delegate
    // app_name - Only used for info.freezr.admin for admin requests
    // Note:  permission will indicate requestee_app if it is different from freezr_app_name
    // query_params is any list of query parameters

  if (!options) options = {};
  var permission_string = options.permission_name? ('/'+options.permission_name):""
  var url = '/v1/db/query/'+freezr_app_name+'/'+freezr_app_code+'/'+freezr_app_name+permission_string;

  if (options.app_name && options.app_name == "info.freezr.admin") url='/v1/admin/dbquery/'+options.collection
  freezer_restricted.connect.send(url, JSON.stringify(options), callback, 'POST', 'application/json');
}
freezr.db.update = function(data, options, callback) {
  // simple record update, assuming data has a ._id object
  // options can have collection
  if (!data) {callback({"error":"No data sent."});}
  if (!data._id) {callback({"error":"No _id to update."});}
  if (!options) options = {};
  options.updateRecord = true;
  options.data_object_id = data._id;
  freezr.db.write(data, options, callback )
};
freezr.db.getByPublicId = function(data_object_id, callback) {
  // get a specific public object by its object id
  // app_config needs to be set up for this and item to have been permissioned and tagged as public
  if (!data_object_id) {callback({error:'No id sent.'});}
  var url = '/v1/pdb/'+data_object_id;

  freezer_restricted.connect.read(url, options, callback);
}
freezr.db.publicquery = function(options, callback) {
  // options can be: app_name, skip, count, user_id, pid
  if (!options) options = {};
  var url = '/v1/pdbq';
  freezer_restricted.connect.send(url, JSON.stringify(options), callback, 'POST', 'application/json');
}

// Permissions and file permissions
freezr.perms.getAllAppPermissions = function(callback) {
  // gets a list of permissions granted - this is mainly called on my freezr_core, but can also be accessed by apps
  var url = '/v1/permissions/getall/'+freezr_app_name+'/'+freezr_app_code;
  freezer_restricted.connect.read(url, null, callback);
}
freezr.perms.isGranted = function(permission_name, callback) {
  // see if a permission has been granted by the user - callback(isGranted)
  var url = '/v1/permissions/getall/'+freezr_app_name+'/'+freezr_app_code;
  freezer_restricted.connect.read(url, null, function(ret){
    ret = freezr.utils.parse(ret);
    let isGranted = false;
    ret.forEach((aPerm) => {
      if (aPerm.permission_name == permission_name && aPerm.granted == true) isGranted=true;
    })
    callback(isGranted)
  } );
}
freezr.perms.setFieldAccess = function(options, callback) {
  // todo - Currently not functional
  // can give specific people access to fields with specific values - eg myHusband can be given to all "album" fields whose value is "ourVacationAlbum2014"
  // field name and value are needed for field_delegate type permissions but unnecessary for foler_delegate permissions
  // permission_name is the permission_name under which the field is being  

  var url = '/v1/permissions/setfieldaccess/'+freezr_app_name+'/'+freezr_app_code+'/'+permission_name;
  if (!options) {options  = 
      { //'action': 'grant' or 'deny' // default is grant
        //'field_name': 'albums', // field name of value
        //'field_value':'ourVacationAlbum2014' // gives access to 
        // can have one of:  'shared_with_group':'logged_in' or 'shared_with_user':a user id 
        // 'requestee_app': app_name (defaults to self)
       }
      }
  if (!options.action) {options.action = "grant";}

  freezer_restricted.connect.write(url, options, callback);
}
freezr.perms.setObjectAccess = function(permission_name, idOrQuery, options, callback) {
  // gives specific people access to a specific object
  // permission_name is the permission_name under which the field is being  

  var url = '/v1/permissions/setobjectaccess/'+freezr_app_name+'/'+freezr_app_code+'/'+permission_name;
  if (!options) {options  = 
      { //'action': 'grant' or 'deny' // default is grant
        // can have one of:  'shared_with_group':'logged_in' or 'public' or 'shared_with_user':a user id  
        // 'requestee_app': app_name (defaults to self)
        // collection: defaults to first in list
        // pid: sets a publid id instead of the automated accessible_id
        // pubDate: sets the publish date
        // not_accessible - for public items that dont need to be lsited separately in the accessibles database
       }
      }
  if (!options.action) {options.action = "grant";}
  if (!idOrQuery) {
    callback({'error':'must incude object id or a seearch query'})
  } else {
    if (typeof idOrQuery == "string") options.data_object_id = idOrQuery;
    if (typeof idOrQuery == "object") options.query_criteria = idOrQuery;
    if (idOrQuery.constructor === Array) options.object_id_list = idOrQuery;
    freezer_restricted.connect.write(url, options, callback);
  }
}
freezr.perms.listOfFieldsIvegrantedAccessTo = function(options, callback) {
  // todo - Currently not functional
  // returns list of folders (or field names) the app has given access to on my behalf.
  // options: permission_name, collection, field_name, field_value, shared_with_group, shared_with_user, granted
  var url = '/v1/permissions/getfieldperms/ihavegranted/'+freezr_app_name+'/'+freezr_app_code+'/';
  freezer_restricted.connect.read(url, options, callback);
}
freezr.perms.allFieldsIHaveAccessTo = function(options , callback) {
  // todo - Currently not functional
  // returns list of folders (or field names) user has been given access to (excluding subfolders) by other users
  // options: permission_name, collection, requestee_app, action,  _owner, 
  // target_app???
  var url = '/v1/permissions/getfieldperms/ihaveccessto/'+freezr_app_name+'/'+freezr_app_code+'/';
  freezer_restricted.connect.read(url, options, callback);
}


// PROMISES create freezr.promise based on above
freezr.promise= {db:{},perms:{}}
Object.keys(freezr.db     ).forEach(aFunc => freezr.promise.db[aFunc]   =null)
Object.keys(freezr.perms  ).forEach(aFunc => freezr.promise.perms[aFunc]=null)
Object.keys(freezr.promise).forEach(typeO => {
  Object.keys(freezr.promise[typeO]).forEach(function(freezrfunc) {
     freezr.promise[typeO][freezrfunc] = function() {
      var args = Array.prototype.slice.call(arguments);
      return new Promise(function (resolve, reject) {
        args.push(function(resp) {
          resp=freezr.utils.parse(resp);
          if (!resp || resp.error) {reject(resp);} else { resolve(resp)}
        })
        freezr[typeO][freezrfunc](...args)
      });
     }
  });
});
freepr = freezr.promise;
// UTILITY Functions
freezr.utils.updateFileList = function(folder_name, callback) {// Currently NOT FUNCTIONAL
  // This is for developers mainly. If files have been added to a folder manually, this function reads all the files and records them in the db
  //app.get('/v1/developer/fileListUpdate/:app_name/:source_app_code/:folder_name', userDataAccessRights, app_hdlr.updateFileDb);
  var url = '/v1/developer/fileListUpdate/'+freezr_app_name+'/'+freezr_app_code+ (folder_name?'/'+folder_name:"");
  //onsole.log("fileListUpdate Sending to "+url)
  freezer_restricted.connect.read(url, null, callback);
}
freezr.utils.getConfig = function(callback) {
  // This is for developers mainly. I retrieves the app_config file and the list of collections which haev been used
  //app.get('/v1/developer/config/:app_name/:source_app_code',userDataAccessRights, app_handler.getConfig);
  // it returns: {'app_config':app_config, 'collection_names':collection_names}, where collection_names are the collection_names actually used, whether they appear in the app_config or not.

  var url = '/v1/developer/config/'+freezr_app_name+'/'+freezr_app_code;
  //onsole.log("fileListUpdate Sending to "+url)
  freezer_restricted.connect.read(url, null, callback);
}
freezr.utils.ping = function(options, callback) {
  // pings freezr to get back logged in data
  // options can be password and app_name
  var url = '/v1/account/ping';
  freezer_restricted.connect.read(url, options, callback);

}
freezr.utils.logout = function() {
  if (freezr.app.isWebBased) {
    console.warn("Warning: On web based apps, logout from freezr home.")
    if (freezr.app.logoutCallback) freezr.app.logoutCallback({logged_out:false});
  } else {
    freezer_restricted.connect.ask("/v1/account/applogout", null, function(resp) {
      resp = freezr.utils.parse(resp);
      freezer_restricted.menu.close()
      if (resp.error) {
        console.warn("ERROR Logging Out");
      } else { 
        freezr_app_code = null;
        freezr_user_id = null;
        freezr_server_address= null;
        freezr_user_is_admin = false;
        if (freezr.app.logoutCallback) freezr.app.logoutCallback(resp);
      }     
    });
  }
}
freezr.utils.getHtml = function(part_path, app_name, callback) {
  // Gets an html file on the freezr server
  if (!app_name) app_name = freezr_app_name;
  if (!part_path.endsWith(".html") && !part_path.endsWith(".htm")) {
    callback("error - can only get html files")
  } else {
    var html_url = '/app_files/'+app_name+"/"+part_path;
    freezer_restricted.connect.read(html_url, null, callback);
  }
}
freezr.utils.getAllAppList = function(callback) {
  freezer_restricted.connect.read('/v1/account/app_list.json', null, callback)
}
freezr.utils.filePathFromName = function(fileName, options) {
  // options are permission_name, requestee_app AND user_id
  // returns the full file path based on the name of a file so it can be referred to in html. (fileName can include subfolders in user directory)
  var user_id = (options && options.user_id)? options.user_id : freezr_user_id;
  if (! fileName ) return null
  else return freezr.utils.filePathFromId(user_id +"/"+fileName, options) 
}
freezr.utils.filePathFromId = function(fileId, options) {
  // returns the file path based on the file id so it can be referred to in html.
  // options are permission_name, requestee_app
  if (!fileId) return null;
  var permission_name = (options && options.permission_name)? options.permission_name : "me";
  var requestee_app   = (options &&   options.requestee_app)?  options.requestee_app   : freezr_app_name;
  if (freezr.utils.startsWith(fileId,"/")) fileId = fileId.slice(1);
  return "/v1/userfiles/"+permission_name+"/files/"+freezr_app_name+"/"+ freezr_app_code +"/"+requestee_app+"/"+fileId;
}
freezr.utils.publicPathFromId = function(fileId, requestee_app) {
  // returns the public file path based on the file id so it can be referred to in html.
  // params are permission_name, requestee_app
  if (!fileId || !requestee_app) return null;
  if (freezr.utils.startsWith(fileId,"/")) fileId = fileId.slice(1);
  return "/v1/publicfiles/"+requestee_app+"/"+fileId;
}
freezr.utils.fileIdFromPath = function(filePath) {
  // returns the id given a private or public url of a freezr file path 
  if (!filePath) return null;
  let parts = filePath.split("/");
  let type =  ( parts[4]=="userfiles"?"private":(parts[4]=="publicfiles"?"public":null)  )
  if (!type) return null;
  parts = parts.slice( (type=="private"?10:6) )
  return decodeURI(parts.join("/"));
}
freezr.utils.parse = function(dataString) {
  if (typeof dataString == "string") {
    try {
          dataString=JSON.parse(dataString);
    } catch(err) {
      dataString= {'data':dataString}
    }
  }
  return dataString
}
freezr.utils.startsWith = function(longertext, checktext) {
    if (!checktext || !longertext) {return false} else 
    if (checktext.length > longertext.length) {return false} else {
    return (checktext == longertext.slice(0,checktext.length));}
}
freezr.utils.longDateFormat = function(aDateNum) {
  if (!aDateNum || aDateNum+''=='0') {
    return 'n/a';
  } else {
    try {
      aDate = new Date(aDateNum);
      var retVal = aDate.toLocaleDateString() + ' '+ aDate.toLocaleTimeString(); 
      return  retVal.substr(0,retVal.length-3);
    } catch (err) {
      return 'n/a - error';
    }
  }
}
freezr.utils.testCallBack = function(returnJson) {
  returnJson = freezer_restricted.utils.parse(returnJson);
  //onsole.log("return json is "+JSON.stringify(returnJson));
}

/*  ==================================================================

The following functions should NOT be called by apps.
That's why they are called "restricted"
They are for internal purposes only

==================================================================    */ 

freezer_restricted.utils = freezr.utils;
freezer_restricted.connect= {};
freezer_restricted.menu = {};
freezer_restricted.permissions= {};

// CONNECT - BASE FUNCTIONS TO CONNECT TO SERVER
  freezer_restricted.connect.ask = function(url, data, callback, type) {
      var postData=null, contentType="";

      if (!type || type=="jsonString") {
        postData= data? JSON.stringify(data): "{}";
        contentType = 'application/json'; // "application/x-www-form-urlencoded"; //
      } else {
        postData = data;
      }
      // todo - add posting pictures

  	freezer_restricted.connect.send(url, postData, callback, "POST", contentType);
  };
  freezer_restricted.connect.write = function(url, data, callback, type) {
      var postData=null, contentType="";

      if (!type || type=="jsonString") {
        postData= JSON.stringify(data);
        contentType = 'application/json'; 
      } else {
        postData=data;
      }
  	freezer_restricted.connect.send(url, postData, callback, "PUT", contentType);
  };
  freezer_restricted.connect.read = function(url, data, callback) {
  	if (data) {
  	    var query = [];
  	    for (var key in data) {
  	        query.push(encodeURIComponent(key) + '=' + encodeURIComponent(data[key]));
  	    }
  	    url = url  + '?' + query.join('&');
      }
      freezer_restricted.connect.send(url, null, callback, 'GET', null)
  };
  freezer_restricted.connect.send = function (url, postData, callback, method, contentType) {
    //onsole.log("getting send req for url "+url)
  	var req = null, badBrowser = false;
    if (!callback) callback= freezr.utils.testCallBack;
  	try {
        req = new XMLHttpRequest();
      } catch (e) {
     		badBrowser = true;
      }
      if (!freezr.app.isWebBased && freezr_server_address) {url = freezr_server_address+url;}

      if (badBrowser) { 
      	callback({"error":true, "message":"You are using a non-standard browser. Please upgrade."});
      } else if (!freezer_restricted.connect.authorizedUrl(url, method)) {
        callback({"error":true, "message":"You are not allowed to send data to third party sites like "+url});
      } else { 
        //onsole.log("sending url "+url)
        req.open(method, url, true);
        if (!freezr.app.isWebBased && freezr_server_address) {
          req.withCredentials = true;
          req.crossDomain = true;
        } 
        req.onreadystatechange = function() {
          if (req && req.readyState == 4) {
              var jsonResponse = req.responseText;
              //lert("AT freeezr level status "+this.status+" resp"+req.responseText)
              jsonResponse = jsonResponse? jsonResponse : {"error":"No Data sent from servers", "errorCode":"noServer"};
              if (this.status == 200 || this.status == 0) {
    				    callback(jsonResponse); 
        			} else if (this.status == 400) {
        				callback({'error':((jsonResponse.type)? jsonResponse.type: 'Connection error 400'),'message':'Error 400 connecting to the server', "errorCode":"noServer"});
        			} else {
                if (this.status == 401 && !freezr.app.isWebBased) {freezr.app.offlineCredentialsExpired = true; }
        				callback({'error':"unknown error from freezr server","status":this.status, "errorCode":"noServer"});
        			}         
            } 
        };
        if (contentType) req.setRequestHeader('Content-type', contentType);
        req.send(postData)
      }
  }
  freezer_restricted.connect.authorizedUrl = function (aUrl, method) {
  	if ((freezer_restricted.utils.startsWith(aUrl,"http") && freezr.app.isWebBased) || (!freezer_restricted.utils.startsWith(aUrl,freezr_server_address) && !freezr.app.isWebBased) ){
  		//todo - to make authorized sites
  		var warningText = (method=="POST")? "The web page is trying to send data to ":"The web page is trying to access ";
  		warningText = warningText + "a web site on the wild wild web: "+aUrl+" Are you sure you want to do this?"
  		return (confirm(warningText))
  	} else {
  		return true;
  	}
  } 

// PERMISSIONS - BASE FUNCTIONS GRANTING PERMISSIONS
  freezer_restricted.permissions.change = function(buttonId, permission_name, permission_object) {
    //onsole.log("CHANGE id"+buttonId+" permission_name"+permission_name+" "+ JSON.stringify(permission_object));
    //  {"description":"Player Recent Scores","app_name":null,"collection":"scores","search_fields":null,"sort_fields":{"_date_created":1},"count":1,"return_fields":["score","_owner","_date_created"],"sharable_groups":"logged_in"}
    var theButt = document.getElementById(buttonId);
    if (theButt.className == "freezer_butt") {
      theButt.className = "freezer_butt_pressed";
      var action = theButt.innerHTML;
      theButt.innerHTML = ". . .";
      var url = '/v1/permissions/change/'+freezr_app_name+'/'+freezr_app_code;
      var sentData = {'changeList':[{'action':action, 'permission_name':permission_name, 'permission_object':permission_object, 'buttonId':buttonId}]};
      freezer_restricted.connect.write(url, sentData, freezer_restricted.permissions.changePermissionCallBack);
    }
  }
  freezer_restricted.permissions.changePermissionCallBack = function(returnJson) {
    //onsole.log('permission Callback '+JSON.stringify(returnJson));
    returnJson = freezer_restricted.utils.parse(returnJson);
    var theButt = (returnJson && returnJson.buttonId)? document.getElementById(returnJson.buttonId) : null;
    if (theButt) {
      if (returnJson.success) { 
        if (returnJson.action == "Accept") { 
          theButt.innerHTML = "Now Accepted"
        } else if (returnJson.action == "Deny") {
          theButt.innerHTML = "Now Denied";
          if ((returnJson.flags && returnJson.flags.major_warnings && returnJson.flags.major_warnings.length>0) || returnJson.aborted)  {
            theButt.nextSibling.style.color = "red";
            theButt.nextSibling.innerHTML = "Note: There were some SERIOUS errors removing permissions from data already marked as permitted. "
          } else if (returnJson.flags && returnJson.flags.minor_warnings_data_object && returnJson.flags.minor_warnings_data_object.length>0) {
            theButt.nextSibling.style.color = "red";
            theButt.nextSibling.innerHTML = "There were some data inconsistencies found when removing permissions from data already marked as permitted. "
          }
        }
      } else {
        theButt.innerHTML = "Error";
        theButt.nextSibling.innerHTML = "There was an error changing this permission - please try again later"
      }
    } else {
      var mainEl = document.getElementById("freezer_dialogueInnerText");
      if (mainEl) mainEl.innerHTML = "Error communicating with server. <br/>"+((returnJson && returnJson.error)? returnJson.error : "")
    }
  }

// MENU - BASE FUNCTIONS SHOWING THEM WHEN THE FREEZR ICON (top right of each app) IS PRESSEDFreeezer Dialogie HTML
  freezer_restricted.menu.hasChanged = false;
  freezer_restricted.menu.addFreezerDialogueElements = function(){

    //onsole.log("addFreezerDialogueElements")
    var freezerMenuButt = document.createElement('img');
    freezerMenuButt.src = freezr.app.isWebBased? "/app_files/info.freezr.public/static/freezer_log_top.png": "./freezrPublic/static/freezer_log_top.png";
    freezerMenuButt.id = "freezerMenuButt"
    freezerMenuButt.onclick = freezer_restricted.menu.freezrMenuOpen;
    freezerMenuButt.className = "freezerMenuButt_" + ((!freezr.app.isWebBased && /iPhone|iPod|iPad/.test(navigator.userAgent) )? "Head":"Norm");
    document.getElementsByTagName("BODY")[0].appendChild(freezerMenuButt);

    var elDialogueOuter = document.createElement('div');
    elDialogueOuter.id = 'freezer_dialogueOuter';
    document.getElementsByTagName("BODY")[0].appendChild(elDialogueOuter);
    var elDialogueScreen = document.createElement('div');
    elDialogueScreen.id = 'freezer_dialogueScreen';
    elDialogueOuter.appendChild(elDialogueScreen);
    elDialogueScreen.onclick = freezer_restricted.menu.close;
    var elDialogueInner = document.createElement('div');
    elDialogueInner.id = 'freezer_dialogueInner';
    elDialogueOuter.appendChild(elDialogueInner);
    var elDialogueCloseButt = document.createElement('div');
    elDialogueCloseButt.className="freezer_butt";
    elDialogueCloseButt.id="freezer_dialogue_closeButt";
    elDialogueCloseButt.innerHTML=" Close ";
    elDialogueCloseButt.onclick = freezer_restricted.menu.close;
    elDialogueInner.appendChild(elDialogueCloseButt);
    if (freezr.app.isWebBased && freezr_user_id && freezr_server_address) {
      // nb server_address and user_id may be nonexistant on app logout and login
      var elDialogueHomeButt = document.createElement('div');
      elDialogueHomeButt.className="freezer_butt";
      elDialogueHomeButt.id="freezer_dialogue_homeButt";
      elDialogueHomeButt.innerHTML="freezr home";
      elDialogueHomeButt.onclick = function (evt) {window.open("/account/home","_self");};
      elDialogueInner.appendChild(elDialogueHomeButt);

      var elDialogueDataViewButt = document.createElement('div');
      elDialogueDataViewButt.className="freezer_butt";
      elDialogueDataViewButt.id="freezer_dialogue_viewDataButt";
      elDialogueDataViewButt.innerHTML="App data";
      elDialogueDataViewButt.onclick = function (evt) {window.open(("/allmydata/view/"+freezr_app_name),"_self");};
      elDialogueInner.appendChild(elDialogueDataViewButt);
    } 
    var elDialogueInnerText = document.createElement('div');
    elDialogueInnerText.id = 'freezer_dialogueInnerText';
    elDialogueInner.appendChild(elDialogueInnerText);
    elDialogueInner.style["-webkit-transform"] = "translate3d("+(Math.max(window.innerWidth,window.innerHeight))+"px, -"+(Math.max(window.innerWidth,window.innerHeight))+"px, 0)";
  }
  freezer_restricted.menu.close = function (evt) {
      document.getElementById("freezer_dialogueInner").style["-webkit-transform"] = "translate3d("+(Math.max(window.innerWidth,window.innerHeight))+"px, -"+(Math.max(window.innerWidth,window.innerHeight))+"px, 0)";
      setTimeout(function(){
          document.getElementById('freezer_dialogueOuter').style.display="none";
      },400 )

      document.getElementsByTagName("BODY")[0].style.overflow="auto";
      freezr.onFreezrMenuClose(freezer_restricted.menu.hasChanged);
      freezer_restricted.menu.hasChanged = false;
  };
  freezer_restricted.menu.freezrMenuOpen = function() {
    var innerEl = document.getElementById('freezer_dialogueInner');
    

    if (freezr.app.isWebBased && !freezr_app_code) { // app pages
      freezer_restricted.menu.resetDialogueBox(true);
      document.getElementById('freezer_dialogueOuter').style.display="block";
      freezer_restricted.menu.addLoginInfoToDialogue('freezer_dialogueInnerText');

      //window.open("/account/home","_self");
    } else if (freezr_app_code  && (freezr.app.isWebBased || !freezr.app.offlineCredentialsExpired) ){
        freezer_restricted.menu.resetDialogueBox();
        freezr.perms.getAllAppPermissions(freezer_restricted.menu.show_permissions);
        freezer_restricted.menu.hasChanged = true;
    } else { // no app code, or offlineCredentialsExpired so its a stnad alone app
        freezer_restricted.menu.resetDialogueBox();
        freezer_restricted.menu.add_standAlonApp_login_dialogue('freezer_dialogueInnerText');
    } 

  }
  freezer_restricted.menu.resetDialogueBox = function(isAdminPage, addText) {
    var innerText = (document.getElementById('freezer_dialogueInnerText'));
    if (innerText) innerText.innerHTML= (addText? ("<br/><div>"+addText+"</div>"): "" )+'<br/><div align="center">.<img src="'+(freezr.app.isWebBased? "/app_files/info.freezr.public/static/ajaxloaderBig.gif": "./freezrPublic/static/ajaxloaderBig.gif")+'"/></div>';
    var dialogueEl = document.getElementById('freezer_dialogueOuter');
    if (dialogueEl) dialogueEl.style.display="block";
    var bodyEl = document.getElementsByTagName("BODY")[0]
    if (bodyEl) bodyEl.style.overflow="hidden";
    if (dialogueEl && bodyEl) dialogueEl.style.top = Math.round(bodyEl.scrollTop)+"px";
    if (isAdminPage && document.getElementById("freezer_dialogue_viewDataButt")) document.getElementById("freezer_dialogue_viewDataButt").style.display= "none";
    if (document.getElementById('freezer_dialogueInner')) document.getElementById('freezer_dialogueInner').style["-webkit-transform"] = "translate3d(0, 0, 0)";
  }
  freezer_restricted.menu.addLoginInfoToDialogue = function(aDivName) {
    var innerElText = document.getElementById(aDivName);
    if (innerElText) {
        innerElText.innerHTML = "<div class='freezer_dialogue_topTitle'>"+(freezr_app_display_name? freezr_app_display_name:freezr_app_name)+"</div>";
        innerElText.innerHTML+= (freezr_app_version?("<div>App version: "+freezr_app_version+"</div>"):"" )
        innerElText.innerHTML+= (freezr_user_id && freezr_server_address)? ("<i>Logged in as"+(freezr_user_is_admin? " admin ":" ")+"user: "+freezr_user_id+(freezr_server_address? (" on freezr server: "+freezr_server_address): "")+"</i>, version: "+freezr_server_version+"<br/>"):"<br/>You are not logged in";
        if (!freezr.app.isWebBased && freezr_app_code){  
            innerElText.innerHTML+= '<div align="center"><div class="freezer_butt" style="float:none; max-width:100px;" id="freezr_server_logout_butt">log out</div></div><br/>'
            setTimeout(function() { document.getElementById("freezr_server_logout_butt").onclick= function() {freezr.utils.logout(); } },10);
        }
    } else {console.warn("INTERNAL ERROR - NO DIV AT addLoginInfoToDialogue FOR "+aDivName)}
  }
  freezer_restricted.menu.add_standAlonApp_login_dialogue = function(divToInsertInId) {
    var divToInsertIn = document.getElementById(divToInsertInId);
    if (document.getElementById("freezer_dialogue_viewDataButt")) document.getElementById("freezer_dialogue_viewDataButt").style.left=(parseInt(window.innerWidth/2)-30)+"px";
    
    var cont = "";
    cont+= '<div align="center">'
    cont+= '<div id="freezr_server_server_name_area">'
      cont+= '<div class="freezer_dialogue_topTitle" >Log in to freezr</div>'
      cont+= '<div><span class="appLogin_name">Freezr server address: </span> <div contenteditable class="appLogin_input" id="freezr_server_name_input" >'+(freezr_server_address? freezr_server_address:'http://')+'</div></div>'
      cont+= '<div><span class="appLogin_name"></span><span class="freezer_butt" id="freezr_server_pingprelogin_butt">next</span></div>'
    cont+= '</div>'
    cont+= '<div id="freezr_server_login_name_area" style="display:none">'
     cont+= '<div id="freezr_login_username_area"><span class="appLogin_name" style="padding-right:69px;">User Name: </span> <div contenteditable class="appLogin_input" id="freezr_login_username" >'+(freezr_user_id? freezr_user_id:'')+'</div></div>'
      cont+= '<div><span class="appLogin_name"style="padding-right:79px;">Password: </span><input contenteditable class="appLogin_input" id="freezr_login_pw" type="password"></input></div>'
      cont+= '<div><span class="appLogin_name"></span><span class="freezer_butt" id="freezr_server_login_butt">log in to freezr</span></div>'
    cont+= '</div>'
    cont+= '</div>'
    divToInsertIn.innerHTML = cont;
    document.getElementById('freezr_server_login_butt').onclick = function(){
      freezr_user_id = document.getElementById('freezr_login_username').innerText;
      var password = document.getElementById('freezr_login_pw').value;
        //onsole.log("logging in "+freezr_user_id+"-"+password+". server "+freezr_server_address)
      if (freezr_user_id && freezr_user_id.length>0 && password && password.length>0 && freezr_server_address && freezr_server_address.length > 0 ) {

        var theInfo = { "user_id": freezr_user_id, "password": password, 'login_for_app_name':freezr_app_name};
        if (!freezr_app_name) {
            alert("developer error: variable freezr_app_name needs to be defined");
        } else {
          freezer_restricted.menu.resetDialogueBox();
          freezer_restricted.connect.ask("/v1/account/applogin", theInfo, function(resp) {
            resp = freezr.utils.parse(resp);
            //onsole.log("got login "+JSON.stringify(resp));
            if (resp.error) {
              document.getElementById('freezer_dialogueInnerText').innerHTML= "Error logging you in: "+(resp.message? resp.message: resp.error);
              freezr.app.loginCallback? freezr.app.loginCallback(resp): console.warn("Error " + JSON.stringify(resp));
            } else if (!resp.source_app_code) {
              document.getElementById('freezer_dialogueInnerText').innerHTML= "Error logging you in: You need to install the app on your freezr first.";
              freezr.app.loginCallback? freezr.app.loginCallback(resp): console.warn("Error " + JSON.stringify(resp));              
            } else if (resp.login_for_app_name == freezr_app_name) {
              freezer_restricted.menu.close()
              freezr_app_code = resp.source_app_code;
              freezr_server_version = resp.freezr_server_version;
              freezr.app.offlineCredentialsExpired = false;
              freezr.app.loginCallback? freezr.app.loginCallback(resp): console.warn("Warning: Set freezr.app.loginCallback to handle log in response: " + JSON.stringify(resp));
            } else {
                document.getElementById('freezer_dialogueInnerText').innerHTML= 'developper error  2- loggedin_app_name '+resp.login_for_app_name+' is not correct.';
            }
          });
        }
      } 
    }

    
    document.getElementById('freezr_server_name_input').onkeypress= function (evt) {
      if (evt.keyCode == 13) {evt.preventDefault(); document.getElementById("freezr_server_pingprelogin_butt").click();};
    }
    document.getElementById('freezr_server_pingprelogin_butt').onclick= function (evt) {
      freezr_server_address = document.getElementById('freezr_server_name_input').innerText;
      if (freezr_server_address.slice(freezr_server_address.length-1)=="/")  freezr_server_address = freezr_server_address.slice(0,freezr_server_address.length-1);
      document.getElementById("freezr_server_server_name_area").innerHTML='<br/><div align="center">.<img src="'+(freezr.app.isWebBased? "/app_files/info.freezr.public/static/ajaxloaderBig.gif": "./freezrPublic/static/ajaxloaderBig.gif")+'"/></div>';
      freezr.utils.ping(null, function(resp) {
        resp = freezr.utils.parse(resp);
        if(resp.error) {
          document.getElementById("freezr_server_server_name_area").innerHTML="The freezr is not available. Please try later.";
        } else if (resp.logged_in) {
          document.getElementById("freezr_server_server_name_area").innerHTML="You are already logged in to this freezr as "+resp.user_id+". Just enter your password."
          document.getElementById('freezr_login_username').innerText = resp.user_id;
          freezr_user_id = resp.user_id;
          document.getElementById("freezr_server_login_name_area").style.display="block";
          document.getElementById("freezr_login_username_area").style.display="none";
          document.getElementById("freezr_login_pw").focus();
        } else {
          document.getElementById("freezr_server_server_name_area").innerHTML="Enter your user name and password to log into "+freezr_server_address;
          document.getElementById("freezr_server_login_name_area").style.display="block";
          document.getElementById("freezr_login_username").focus();
        }
      }, freezr_app_name)
    }
    document.getElementById('freezr_login_username').onkeypress= function (evt) {
      if (evt.keyCode == 13) {evt.preventDefault(); document.getElementById("freezr_login_pw").focus();};
    }
    document.getElementById('freezr_login_pw').onkeypress= function (evt) {
      if (evt.keyCode == 13) {evt.preventDefault(); document.getElementById("freezr_server_login_butt").click();};
    }
  }

  freezer_restricted.menu.show_permissions = function(returnPermissions) {
    if (document.getElementById("freezer_dialogue_viewDataButt")) document.getElementById("freezer_dialogue_viewDataButt").style.left=(parseInt(window.innerWidth/2)-30)+"px";
    returnPermissions = freezer_restricted.utils.parse(returnPermissions);

    var innerElText = document.getElementById('freezer_dialogueInnerText');

    //onsole.log("ALL permissions are "+JSON.stringify(returnPermissions) );

    document.getElementById('freezer_dialogueOuter').style.display="block";
    freezer_restricted.menu.addLoginInfoToDialogue('freezer_dialogueInnerText');

    if (!returnPermissions || returnPermissions.error) {
      innerElText.innerHTML += "<br/><br/>Error connecting to freezr to get permissions";
    } else {

      innerElText.innerHTML += '<div class="freezer_dialogue_topTitle">App Permissions to Access Data</div>';
      var num=0, titleDiv;

      var groupedPermissions = {
              field_delegates:[],
              folder_delegates:[],
              object_delegates:[],
              outside_scripts:[],
              thisApptoThisAppAsked: [],
              thisApptoThisAppGranted: [],
              thisApptoThisAppDenied: [],
              thisApptoThisAppOutDated: [],
              thisAppToOtherApps: [],
              otherAppsGranted: [],
              otherAppsDenied: [],
              otherAppsAsked: []
      };

      for (var i=0; i<returnPermissions.length; i++) {
        aPerm = returnPermissions[i];
        if (aPerm.type == "folder_delegate") {
          groupedPermissions.folder_delegates.push(aPerm);
        } else if (aPerm.type == "field_delegate") {
          groupedPermissions.field_delegates.push(aPerm);
        } else if (aPerm.type == "outside_scripts") {
          groupedPermissions.outside_scripts.push(aPerm);
        } else if (aPerm.type == "object_delegate") {
          groupedPermissions.object_delegates.push(aPerm);
        } else if (aPerm.type == "db_query" && aPerm.requestor_app == freezr_app_name) {
          if (aPerm.requestee_app != freezr_app_name) {
            groupedPermissions.thisAppToOtherApps.push(aPerm);
          } else if (aPerm.granted && !aPerm.outDated) {
            groupedPermissions.thisApptoThisAppGranted.push(aPerm);
          } else if (aPerm.denied) {
            groupedPermissions.thisApptoThisAppDenied.push(aPerm);
          } else if (aPerm.outDated) {
            groupedPermissions.thisApptoThisAppOutDated.push(aPerm);
          } else {
            groupedPermissions.thisApptoThisAppAsked.push(aPerm);
          }
        } else if (aPerm.type == "db_query" && aPerm.requestee_app == freezr_app_name) {
          if (aPerm.granted && !aPerm.outDated) {
            groupedPermissions.otherAppsGranted.push(aPerm);
          } else if (aPerm.denied) {
            groupedPermissions.otherAppsDenied.push(aPerm);
          } else {
            groupedPermissions.otherAppsAsked.push(aPerm);
          }


        } else {
          console.warn("ERROR - why this . uknown permission "+JSON.stringify(aPerm));
        }
      }

      var makePermissionElementFrom = function(type, permission_object, num, buttText) {
        var permEl = document.createElement('div');
        permEl.className = "freezer_BoxTitle"
        permEl.innerHTML = (permission_object.description?  (permission_object.description+ " ("+permission_object.permission_name+")"): permission_object.permission_name);
        var acceptButt = document.createElement('div');
        acceptButt.className = buttText? "freezer_butt": "freezer_butt_pressed";
        acceptButt.id = "freezer_butt_"+num;

        var other_app = permission_object.requestee_app != permission_object.requestor_app;
        var access_word = other_app? "access and share":"share";
        
        acceptButt.innerHTML= buttText;
        if (buttText) {
          acceptButt.onclick = function (evt) {freezer_restricted.permissions.change(this.id, permission_object.permission_name, permission_object);};
        }
        var detailText = document.createElement('div');
        detailText.className="freezer_butt_Text"

        detailText.innerHTML  = other_app? ("The app, <b style='color:purple;'>"+permission_object.requestor_app+"</b>,") : "This app"
        detailText.innerHTML += (buttText=="Accept"? " wants to be able to " : " is able to ")
        if (type == "db_query") {
          detailText.innerHTML += access_word + ": "+(permission_object.return_fields? (permission_object.return_fields.join(", ")) : "ERROR") + " with the following groups: "+permission_object.sharable_groups.join(" ")+".<br/>";
        } else if (type == "folder_delegate") {
          detailText.innerHTML +=  access_word + " all files in these folders : "+ (permission_object.sharable_folders? permission_object.sharable_folders.join(", "):"ERROR" ) +" with "+permission_object.sharable_groups.join(" ")+".<br/>";
        } else if (type == "field_delegate") {
          detailText.innerHTML += access_word+ " all data records from the collection : "+(permission_object.collection? permission_object.collection:"ERROR")+" according to these fields:"+ (permission_object.sharable_fields? permission_object.sharable_fields.join(", "):"ERROR" ) +" with "+permission_object.sharable_groups.join(" ")+".<br/>";
        } else if (type == "object_delegate") {
          detailText.innerHTML += access_word+ " individual data records with the following groups:  "+(permission_object.sharable_groups? permission_object.sharable_groups.join(" "): "None")+".<br/>";
        } else if (type == "outside_scripts") {
          detailText.innerHTML = (buttText=="Accept"? "This app wants to ":"This app can ")+" access the following scripts from the web: "+permission_object.script_url+"<br/>This script can take ALL YOUR DATA and evaporate it into the cloud.";
        }
        var boxOuter = document.createElement('div');
        boxOuter.appendChild(acceptButt);
        boxOuter.appendChild(detailText);
        permEl.appendChild(boxOuter);
        return permEl;
      }


      function writePermissions(type, recordList, buttText, titleText, altText) {
          titleDiv = document.createElement('div');
          titleDiv.className = "freezer_dialogueTitle freezr_dialogueBordered";
          titleDiv.id = "freezer_dialogueTitle"+(num++);
          if (recordList && recordList.length >0) {
            titleDiv.innerHTML = titleText;
            innerElText.appendChild(titleDiv);
            for (var i=0; i<recordList.length; i++) {
              if (type == "field_delegate" || type == "folder_delegate" || type == "object_delegate"|| type == "outside_scripts") {buttText = recordList[i].granted?"Deny":"Accept";}
              innerElText.appendChild(makePermissionElementFrom(type, recordList[i], num++, buttText));
            }
          } else if (altText) {
            titleDiv.innerHTML = altText+"<br/><br/>";
            innerElText.appendChild(titleDiv);
          }
      }


      if (groupedPermissions.thisAppToOtherApps.length + groupedPermissions.outside_scripts.length + groupedPermissions.thisApptoThisAppGranted.length + groupedPermissions.thisApptoThisAppAsked.length +groupedPermissions.thisApptoThisAppDenied.length + groupedPermissions.thisApptoThisAppOutDated.length+ groupedPermissions.folder_delegates.length+ groupedPermissions.field_delegates.length == 0) {
        writePermissions(null, [], "", null, 'This app is not asking for any sharing permissions.');
      } 
      writePermissions("object_delegate", groupedPermissions.object_delegates, null, 'This app is asking for permission to be able to automatically share individual records or FILES with others.');
      writePermissions("folder_delegate", groupedPermissions.folder_delegates, "Accept", 'This app is asking for permission to be able to automatically share your files with others.');
      writePermissions("field_delegate",groupedPermissions.field_delegates, "Accept", 'This app is asking for permission to be able to automatically share some of your date with others.');

      writePermissions("outside_scripts",groupedPermissions.outside_scripts, "Accept", 'This app is asking for permission to be able to access programming scripts from the web. This can be VERY DANGEROUS. DO NOT ACCEPT THIS unless you totally trust the app provider and the source of the script. <br/> <b> PROCEED WITH CAUTION.</b> ');

      writePermissions("db_query", groupedPermissions.thisApptoThisAppAsked, "Accept", 'This app is asking for permission to share your data with other users of this app:');
      writePermissions("db_query",groupedPermissions.thisApptoThisAppOutDated, "Accept", 'You had previously granted similar permissions but the app has changed the criteria so you have to re-accept them:');
      writePermissions("db_query",groupedPermissions.thisApptoThisAppGranted, "Deny", 'You have already granted permission for this app to share the following data with other users of this app:');
      writePermissions("db_query",groupedPermissions.thisApptoThisAppDenied, "Accept", 'You have denied this app from sharing the following data with other users of this app:');

      writePermissions("db_query", groupedPermissions.thisAppToOtherApps, null, "This app is asking for permissions to get your data stored in other apps. You have to go to those apps' pages to grant these permissions:");

      writePermissions("db_query", groupedPermissions.otherAppsAsked, "Accept", 'Other apps are asking for permission for you to see your data from this app:');
      writePermissions("db_query", groupedPermissions.otherAppsGranted, "Deny", 'You have already granted permission to other apps to see your data fro this app as follows:');
      writePermissions("db_query", groupedPermissions.otherAppsDenied, "Accept", 'You have denied other apps from seeing your data from this app as follows:');

    }
  }

  document.onkeydown= function (evt) {
      if (evt.keyCode == 27 && document.getElementById("freezer_dialogueOuter") && document.getElementById("freezer_dialogueOuter").style.display == "block") {freezer_restricted.menu.close()};
  }

freezr.utils.addFreezerDialogueElements = freezer_restricted.menu.addFreezerDialogueElements;
freezr.utils.freezrMenuOpen = freezer_restricted.menu.freezrMenuOpen;
freezr.utils.freezrMenuClose = freezer_restricted.menu.close;

