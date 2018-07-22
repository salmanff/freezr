// copied from register page - need to customize to change password

var doShowDevoptions = false;
var userHasIntiatedAcions = false;
freezr.initPageScripts = function() {
  document.addEventListener('click', function (evt) {
    if (evt.target.id && freezr.utils.startsWith(evt.target.id,"button_")) {
      var parts = evt.target.id.split('_');
      var args = evt.target.id.split('_');
      args.splice(0,2).join('_');
      //onsole.log(args)
      if (buttons[parts[1]]) buttons[parts[1]](args);
    }
  });

  if (!freezr_user_is_admin) {document.getElementById("button_showDevOptions").style.display="none";}
  if (!freezr_user_is_admin) {document.getElementById("freezer_users_butt").style.display="none";}
  if (freezr_user_is_admin && window.location.search.indexOf("dev=true")>0) doShowDevoptions = true;
  showDevOptions();
}


var showDevOptions = function(){
  buttons.updateAppList();
  if (doShowDevoptions && freezr_user_is_admin) {
    document.getElementById("addFileTable").style.display="block";
    document.getElementById("button_showDevOptions").style.display="none";
  }
}

freezr.onFreezrMenuClose = function(hasChanged) {
  //freezer_restricted.menu.resetDialogueBox(true);
  if (userHasIntiatedAcions) buttons.updateAppList();
  setTimeout(function() {freezer_restricted.menu.resetDialogueBox(true);},300);
}
var buttons = {
  'showDevOptions': function(args) {
    doShowDevoptions = true;
    showDevOptions();
    history.pushState(null, null, '?dev=true');
  },
  'goto': function(args) {
    window.open("/apps/"+args[1],"_self");
  },
  'installApp': function(args) {
    userHasIntiatedAcions = true;
    window.open("/apps/"+args[0],"_self");
  },
  'reinstallApp': function(args) {
    userHasIntiatedAcions = true;
    window.open("/apps/"+args[0],"_self");
  },
  'removeApp': function(args) {
      userHasIntiatedAcions = true;
      freezer_restricted.connect.ask('/v1/account/appMgmtActions.json', {'action':'removeApp', 'app_name':args[0]}, remove_app_callback)
  },
  'deleteApp': function(args) {
      userHasIntiatedAcions = true;
      freezer_restricted.connect.ask('/v1/account/appMgmtActions.json', {'action':'deleteApp', 'app_name':args[0]}, delete_app_callback)
  },
  'uploadZipFileApp': function (args) {
    userHasIntiatedAcions = true;
    var fileInput = document.getElementById('app_zipfile2');
    var file = (fileInput && fileInput.files)? fileInput.files[0]: null;

    var parts = file.name.split('.');
    if (endsWith(parts[(parts.length-2)],"-master")) parts[(parts.length-2)] = parts[(parts.length-2)].slice(0,-7);
    if (startsWith((parts[(parts.length-2)]),"_v_")) {
        parts.splice(parts.length-2,2);
    } else {
        parts.splice(parts.length-1,1);
    }
    app_name = parts.join('.');
    app_name = app_name.split(' ')[0];

    if (!fileInput || !file) {
      showError("Please Choose a file first.");      
    } else if (file.name.substr(-4) != ".zip") {
      document.getElementById('errorBox').innerHTML="The app file uploaded must be a zipped file. (File name represents the app name.)";
    } else if (!valid_app_name(app_name)) {
      document.getElementById('errorBox').innerHTML="Invalid app name - please make sure the zip file conforms to freezr app name guidelines";
    } else {
      var uploadData = new FormData();
      uploadData.append('file', file);
      var url = "/v1/account/upload_app_zipfile.json";
      var theEl = document.getElementById(file.name);
      if (!theEl || confirm("This app exists. Do you want to replace it with the uplaoded files?")) {
        freezer_restricted.menu.resetDialogueBox(true);
        if (file.size > 500000) document.getElementById("freezer_dialogueInnerText").innerHTML = "<br/>You are uploading a large file. This might take a little while. Please be patient.<br/>"+document.getElementById("freezer_dialogueInnerText").innerHTML
        freezer_restricted.connect.send(url, uploadData, function(returndata) {
            var d = freezr.utils.parse(returndata);
            if (d.err) {
              document.getElementById("freezer_dialogueInnerText").innerHTML = "<br/>"+JSON.stringify(d.err);
            } else{
              ShowAppUploadErrors(d,uploadSuccess);
            }
          }, "PUT", null);
      }      
    }
  },
  'updateApp': function(args) {
    userHasIntiatedAcions = true;
    window.scrollTo(0, 0);
    freezer_restricted.menu.resetDialogueBox(true);
    document.getElementById("freezer_dialogue_closeButt").style.display="none";
    document.getElementById("freezer_dialogue_homeButt").style.display="none";
    document.getElementById("freezer_dialogueScreen").onclick=null;
    freezer_restricted.connect.ask('/v1/account/appMgmtActions.json', {'action':'updateApp', 'app_name':args[0]}, function(returndata) {
        var d = JSON.parse(returndata);
        document.getElementById("freezer_dialogue_closeButt").style.display="block";
        document.getElementById("freezer_dialogue_homeButt").style.display="block";
        if (d.err) {
          if (document.getElementById("freezer_dialogueInnerText")) document.getElementById("freezer_dialogueInnerText").innerHTML= "<br/>"+JSON.stringify(d.err);
        } else {
          ShowAppUploadErrors(d,showDevOptions)
        }
        buttons.updateAppList();
    })
  },
  'addAppInFolder': function() {
    userHasIntiatedAcions = true;
    var app_name = document.getElementById('appNameFromFolder').value;
    if (!app_name) {
        showError("Please enter an app name");
    } else {
      buttons.updateApp([app_name]);
    }
  },
  'updateAppList': function() {
      freezr.utils.getAllAppList (function (returndata) {
          var theData = freezr.utils.parse(returndata);
          var theEl = document.getElementById("app_list");
          if(!theData) { 
            theEl.innerHTML = "No Apps have been installed";
          } else if (theData.err || theData.error) {
            theEl.innerHTML = "ERROR RETRIEVING APP LIST";
          } else {
            freezr.utils.getHtml("app_mgmt_list.html", null, function(theHtml) {
              theEl.innerHTML = Mustache.to_html( theHtml,theData );
              var imglist = document.getElementsByClassName("logo_img");
              var imglistener = function(evt){
                    this.src="/app_files/info.freezr.public/static/freezer_logo_empty.png"
                    this.removeEventListener("error",imglistener);
                }
              for (var i=0; i<imglist.length; i++) {
                  imglist[i].addEventListener("error", imglistener )
              }
              if (doShowDevoptions && freezr_user_is_admin) Array.prototype.forEach.call(document.getElementsByClassName("dev_option"), function(el, index) {el.style.display="block";});
            })
          }
      });
  },
  'chooseFile':function() {
    // document.getElementById('buttons_uploadZipFileApp').style.display="block";
    document.getElementById('app_zipfile2').click();
    document.getElementById('button_uploadZipFileApp').style.display  ="block";
  },
  'closeMenu':function() {
    freezr.utils.freezrMenuClose();
    //setTimeout(function() {freezer_restricted.menu.resetDialogueBox(true);},300);
  }

}
var ShowAppUploadErrors = function (theData,callFwd) {
  freezr.utils.getHtml("uploaderrors.html", null, function(theHtml) {
    var theEl = document.getElementById("freezer_dialogueInnerText");
    theEl.innerHTML = Mustache.to_html( theHtml,theData );
    if (callFwd) callFwd();
  })
}

var uploadSuccess = function() {
  buttons.updateAppList();
  //document.getElementById("freezer_dialogue_extra_title").innerHTML="Finalize Installation and Launch'."
  //document.getElementById("freezer_dialogue_extra_title").onclick=function() {buttons.goto}
}
var remove_app_callback = function(data) {
  data = freezer_restricted.utils.parse(data);
  window.scrollTo(0, 0);
  if (!data) {
      showError("Could not connect to server");
  } else if (data.error) {
    showError("Error:"+data.message);
  } else {
    showError("The app was removed from your home page. Scroll down to 'removed apps' section below to re-install or to delete completely.");
    buttons.updateAppList();
  }
}
var delete_app_callback = function(data) {
  data = freezer_restricted.utils.parse(data);
  window.scrollTo(0, 0);
  if (!data) {
      showError("Could not connect to server");
  } else if (data.error) {
    showError("Error:"+data.message);
  } else if (data && data.other_data_exists) {
    showError("Your data was deleted. But the app cannot be removed until other users have also deleted ther data.");
  } else {
    showError("The app was deleted.");
    buttons.updateAppList();
  }
}

var gotChangeStatus = function(data) {
  data = freezer_restricted.utils.parse(data);
  if (!data) {
      showError("Could not connect to server");
  } else if (data.error) {
    showError("Error:"+data.message);
  } else {
    showError("success in making app");
    window.location = "/account/apps";
  }
}

var timer = null;
var showError = function(errorText) {
  timer = null;
  var errorBox=document.getElementById("errorBox");
  errorBox.innerHTML= errorText? errorText: " &nbsp ";
  if (errorText) {
    timer = setTimeout(function () {showError();
  },5000)}
}

var valid_app_name = function(app_name) {
        if (!app_name) return false;
        if (app_name.length<1) return false;
        if (!valid_filename(app_name)) return false;
        if (starts_with_one_of(app_name, ['.','-','\\','system'] )) return false;
        if (SYSTEM_APPS.indexOf(app_name)>-1) return false;
        if (app_name.indexOf("_") >-1) return false;
        if (app_name.indexOf(" ") >-1) return false;
        if (app_name.indexOf("$") >-1) return false;
        if (app_name.indexOf('"') >-1) return false;
        if (app_name.indexOf("/") >-1) return false;
        if (app_name.indexOf("\\") >-1) return false;
        if (app_name.indexOf("{") >-1) return false;
        if (app_name.indexOf("}") >-1) return false;
        if (app_name.indexOf("..") >-1) return false;
        var app_segements = app_name.split('.');
        if (app_segements.length <3) return false;
        return true;
    }
valid_filename = function (fn) {
        var re = /[^\.a-zA-Z0-9-_ ]/;
        // @"^[\w\-. ]+$" http://stackoverflow.com/questions/11794144/regular-expression-for-valid-filename
        return typeof fn == 'string' && fn.length > 0 && !(fn.match(re) );
    };
var endsWith = function (longertext, checktext) {
        if (!checktext || !longertext || checktext.length > longertext.length) {return false} else {
        return (checktext == longertext.slice((longertext.length-checktext.length)));}
    }
var startsWith = function(longertext, checktext) {
        if (!longertext || !checktext || !(typeof longertext === 'string')|| !(typeof checktext === 'string')) {return false} else 
        if (checktext.length > longertext.length) {return false} else {
        return (checktext == longertext.slice(0,checktext.length));}
    }
var starts_with_one_of = function(thetext, stringArray) {
        for (var i = 0; i<stringArray.length; i++) {
            if (startsWith(thetext,stringArray[i])) return true;
        }
        return false;
    }
const SYSTEM_APPS = ["info.freezr.account","info.freezr.admin","info.freezr.public","info.freezr.permissions","info.freezr.posts"];

