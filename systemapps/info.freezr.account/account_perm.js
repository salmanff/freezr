//

let confirm =null;


freezr.initPageScripts = function() {
  document.addEventListener('click', function (evt) {
    //onsole.log('clicked'+evt.target.id+" path "+window.location.pathname);
    if (evt.target.id && evt.target.id=="confirm_permission") {
      changePermission(confirm, null, changePermissionCallBack)
    } else if (evt.target.id && evt.target.id=="close_window") {
      window.close()
    } else if (evt.target.id && freezr.utils.startsWith(evt.target.id,"freezerperm_") && freezr.utils.startsWith(window.location.pathname,"/account/perms/") ) {
      var parts = evt.target.id.split('_'); // freezerperm_{{requestee_app???}}_{{permission_name}}_{{action}}
      let details = { requestor_app:parts[2],table_id:parts[1],action:parts[3] }
      details.name = parts.slice(4).join("_")
      changePermission(details, evt.target, changePermissionCallBack)
    }


  });
  if (window.location.search) {
    // check have all params
    // do accept and on callback give message and hide confirm box and also switch the other permissions
    confirm = {}
    let parts = window.location.search.slice(1).split("&");
    parts.forEach(aPart => {
        let items = aPart.split('=');
        if(items.length>1) {confirm[items[0] ]= items[1]}
    })
    parts = window.location.pathname.split("/");
    if (!confirm.requestee_app_table){
      confirm.requestee_app_table = parts[3]
    } else if (parts[3] && parts[3] != confirm.requestee_app_table) {
      console.warn("Conflicting item requestee_app_table - using "+confirm.requestee_app_table)
    }
    console.log(confirm)
    if (confirm.table_id && confirm.requestor_app && confirm.action && confirm.name) {
      document.getElementById("confirm_title").innerHTML= (confirm.action=="Accept"? "Are you sure you want to grant this permission?":"Please confirm you want revoke this permission:")
      document.getElementById("confirm_app_name").innerHTML= freezr.utils.startsWith(confirm.table_id,confirm.requestor_app)? ("App: "+confirm.requestor_app):("App: "+confirm.requestor_app+" is asking to access "+confirm.table_id)
      document.getElementById("confirm_permission_name").innerHTML= "Permission name: "+confirm.name
      const sentenceId = "sentence_"+confirm.table_id +"_"+confirm.requestor_app+"_"+confirm.name
      if (document.getElementById(sentenceId)){
        document.getElementById("confirm_perm_sentence").innerHTML= document.getElementById(sentenceId).innerHTML
        document.getElementById("confirm_dialogue").style.display="block"
      } else {
        showError("Internal error getting error description for " + sentenceId)
        console.warn("error getting "+sentenceId)
      }
    } else {
      showError("For confirmation, need requestee_app_table and permission_name and action")
      console.warn(confirm)
    }
    if (confirm.window == "popup") {
      document.getElementById("adminFunctions").style.display="none"
      document.getElementById("freezerMenuButt").style.display="none"
    }
    window.history.pushState(null, null, '/account/perms/'+(confirm.requestee_app || ""));
  }
  setTimeout(freezerRestricted.menu.replace_missing_logos,2)
}

var showError = function(errorText) {
  var errorBox=document.getElementById("errorBox");
  errorBox.style="display:block"
  errorBox.innerHTML= errorText;
}

const changePermission = function(details, theButt, callback) {
  console.log('changePermission' , { details, theButt })
    if (!theButt) { //
      document.getElementById("confirm_dialogue_inner").style.display="none"
      document.getElementById("confirm_spinner").style.display="block"
      theButt=document.getElementById("freezerperm_"+ details.table_id +"_"+details.requestor_app+"_"+details.action+"_"+details.name)
    }
    if (theButt) {
      theButt.innerHTML=". . . "
      theButt.className = "freezer_butt_pressed";
      theButt.id="freezerperm_"+details.table_id+"_"+details.requestor_app+"_pending_"+details.name
      const url = '/v1/permissions/change' + (details.table_id ? ('/' + details.table_id) : '');
      console.log({ url })
      const data = {'changeList':[details]};
      freezerRestricted.connect.write(url, data, function(error, returnJson) {changePermissionCallBack(error, returnJson, details, theButt)});
    } else {
      showError("INTERNAL ERROR - Please try again")
    }
  }


const changePermissionCallBack = function(error, returnJson, details, theButt) {
    //console.log('permission Callback ',returnJson);
    returnJson = freezerRestricted.utils.parse(returnJson);
    //document.getElementById("confirm_dialogue").style.display="none"
    if (returnJson.success && !error) {
      const newAction = (details.action == "Accept")? "Deny":"Accept"
      theButt.innerHTML = newAction
      theButt.className = "freezer_butt"
      theButt.id = "freezerperm_"+details.table_id+"_"+details.requestor_app+"_"+newAction+"_"+details.name
      showError((details.action == "Accept"? "Success!!! You have accepted the permission":"Success: You have revoked the permission"))
      let titles = ["confirm_title","confirm_spinner","confirm_app_name", "confirm_permission_name","confirm_perm_sentence","confirm_permission"]
      titles.forEach(aDivId => {document.getElementById(aDivId).style.display="none"})
      document.getElementById("confirm_dialogue_inner").style.display="block"
    } else {
      theButt.innerHTML = "Error";
      showError("There was an error changing this permission - please try again later")
    }
  }
