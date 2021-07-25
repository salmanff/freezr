//admin oauth_serve_setup

let oa_params = {};
let edit_id = "";
const EDIT_BUT_MSG = "Update Permission Parameters"
const PARAM_LIST = ['type','name','key','secret','enabled','redirecturi']
const PARAM_OPTIONALS = ['secret','enabled']
const SUCCESS_MESSAGE = "sucess_write=";
const UNPLANNED_MESSAGE = "sucess_write=update_unplanned";

freezr.initPageScripts = function() {
  document.getElementById('makeOauth').onclick = makeOauth
  if (window.location.href.indexOf(SUCCESS_MESSAGE)>0) showError("Success Writing !!");
  if (window.location.href.indexOf()>0) showError("Updated a record (but there was an inconsistency in this.!");
  window.history.replaceState('Object', 'Title', '/admin/oauth_serve_setup');
  document.addEventListener('click', function (evt) {
    let args = evt.target.id.split("_");
    let params = {};
    if (args[0] == "click") {
      switch(args[1]) {
          case 'edit':
            edit_id = args[2];
            document.getElementById("makeOauth").innerHTML = EDIT_BUT_MSG;
            params = getParamsFromList(edit_id);
            populateEditFields(params);
            break;
          case 'enable':
            params = getParamsFromList(args[2]);
            oa_params.enabled = true;
            writeOauthPerm(params);
            break;
          case 'disable':
            params = getParamsFromList(args[2]);
            oa_params.enabled = false;
            writeOauthPerm(params);
            break;
          default:
            console.log('Error: undefined click ')
      }
    }
  });
}

var getParamsFromList = function(oauth_id) {
  oa_params = {_id:oauth_id};
  PARAM_LIST.forEach(function(aParam) {
    if (document.getElementById(aParam+"_"+oauth_id) ) {
      oa_params[aParam] = document.getElementById(aParam+"_"+oauth_id).innerHTML;
    }
  } )
  return oa_params;
}
var populateEditFields = function(params) {
  PARAM_LIST.forEach(function(aParam) {
    if (document.getElementById('oa_'+aParam) ) {
      document.getElementById('oa_'+aParam).value = (oa_params[aParam] || "") ;
    }
  } )
}

const states_issued = {}
var makeOauth = function () {
  //onsole.log("todo - Basic error checking") // has to be string
  document.body.scrollTop = 0;

  var hasAll = true;
  PARAM_LIST.forEach(function(aParam) {
    if (document.getElementById('oa_'+aParam) && document.getElementById('oa_'+aParam).value ) {
      oa_params[aParam] = document.getElementById('oa_'+aParam).value;
    } else {if (PARAM_OPTIONALS.indexOf(aParam) <0) hasAll=false}
  } )
  if (!hasAll) {
    showError("You need to enter all required information (except the field 'secret').");
  } else {
    showError("");
    document.getElementById("loader").style.display="block";
    if (edit_id) oa_params._id = edit_id;
    oa_params.enabled = true;
    writeOauthPerm(oa_params);
  }
}

var writeOauthPerm = function (oa_params) {
    //onsole.log("sending theInfo: "+JSON.stringify (oa_params))
    freezerRestricted.connect.write("/v1/admin/oauth_perm", oa_params, gotMakeOauthStatus, "jsonString");
}
var gotMakeOauthStatus = function(error, data) {
  //onsole.log("gotMakeOauthStatus "+JSON.stringify(data));
  data = freezr.utils.parse(data)
  if (error) {
    showError("Error: "+ error.message + ' ' + data.written);
  } else if (!data) {
    showError("Could not connect to server");
  } else  {
    window.open("/admin/oauth_serve_setup?"+SUCCESS_MESSAGE+data.written,"_self")
  }
}

var showError = function(errorText) {
  var errorBox=document.getElementById("errorBox");
  errorBox.innerHTML= errorText;
}
