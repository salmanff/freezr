
const CUST_FILE_SEL_LIST = ['local','dropbox'];
const INPUT_TEXT_PARAM_LIST = ['user_id', 'password', 'password2', 'db_user', 'db_pword', 'db_host', 'db_port', 'db_connectionString', 'db_unifiedDbName', 'fs_token','fs_auth_Server','fs_auth_AppName'];
//Unused:  INPUT_CHECK_PARAM_LIST = ['db_addAuth'] ,  INPUT_SELCTOR_PARAM_LIST = ['fs_selectorName']

freezr.initPageScripts = function() {
  document.addEventListener('click', function (evt) {
    //onsole.log(evt.target.id)
    let args = evt.target.id.split("_");
    let params = {};
    if (args && args.length>1 && args[0] == "click") {
      switch(args[1]) {
          case 'register':
            register();
            break;
          case 'externalDb':
            if (args[2]) {
              showSubSection(args[1],args[2])
            } else {
              showMainSection(args[1])
            }
            break;
          case 'externalFs':
            showMainSection(args[1])
            break;
          case 'showAuth':
            showAuthSection(args[2]);
            break;
          case 'goAuthDropbox':
            goAuthDropbox();
            break;
          case 'launch':
            window.open("/account/app_management","_self");
            break;
          default:
            console.log("?")
            break;
      }
    }
  });

  hideClass("freezr_hiders");
  if (firstSetUp) {
    document.getElementById('password2').addEventListener('keypress', function (e) {if (e.keyCode === 13) register();});
    hideDiv('change-reg');
  } else {
    document.getElementById('password').addEventListener('keypress', function (e) {if (e.keyCode === 13) register();});
    hideDivs(['first-reg','second-password','second-password2'])
  }
  document.getElementById('customFileSysSelect').onchange = changeFsChoice;

  // populate
  let tempParams =localStorage.getItem("params");

  if (tempParams) {
    // These are kept when leaving the site to go authenticate
    tempParams = JSON.parse(tempParams);
    window.localStorage.removeItem("params");
  } else {
    tempParams = {
      user_id: freezr_user_id || null,
      db_user: freezr_environment.dbParams.user,
      db_pword: '',
      db_host: freezr_environment.dbParams.host,
      db_port: freezr_environment.dbParams.port,
      db_connectionString: freezr_environment.dbParams.connectionString,
      db_has_pw: freezr_environment.dbParams.has_password,
      db_unifiedDbName: (freezr_environment.dbParams.unifiedDbName? freezr_environment.dbParams.unifiedDbName : ""),
      fs_selectorName: ((freezr_environment.userDirParams.name && freezr_environment.userDirParams.name!="glitch.com")? freezr_environment.userDirParams.name : "local"),
      fs_auth_Server: 'https://www.salmanff.com',
      fs_auth_AppName: 'freezr'
    }
  };

  let newOauth = parseFragments();
  //onsole.log("original url href "+window.location.href)

  if (newOauth && newOauth.access_token) {
    showMainSection('externalFs');
    tempParams.fs_token = newOauth.access_token;
    tempParams.fs_selectorName = newOauth.source;
    window.history.replaceState('Object', 'Title', '/admin/public/firstSetUp');
  } else if (freezr_environment.userDirParams.has_access_token) {
    tempParams.fs_has_token = true;
  }

  if (tempParams.db_user) showMainSection('externalDb');
  if (tempParams.connectionString) {showMainSection('externalDb'); showSubSection('externalDb','connectionString'); };

  populateForm(tempParams);

  hideCustSelectorDivs((tempParams.fs_token || tempParams.fs_has_token)? "gotToken": null);

  populateErrorMessage(freezrServerStatus, true);

  setTimeout(function(){ document.body.scrollTop = 0;},20);
}
var showMainSection = function (section) {
  hideDiv('click_'+section);
  showDiv(section);
}
var showSubSection = function (mainSection, subSection) {
  //onsole.log("as",mainSection,subSection)
  if (mainSection == 'externalDb') {
    hideDiv("externalDb_"+(subSection == 'connectionString'? 'Details':'connectionString'));
    showDiv("externalDb_"+subSection);
  }
}
var  populateForm = function(params) {
  //onsole.log("populateForm",params)
  INPUT_TEXT_PARAM_LIST.forEach(aParam =>  {if(document.getElementById(aParam)) document.getElementById(aParam).value = params[aParam] || "";})

  document.getElementById('db_addAuth').checked = params.db_addAuth? true:false;
  if (!params.fs_selectorName) params.fs_selectorName = "local";
  let selector = document.getElementById('customFileSysSelect');
  selector.selectedIndex = CUST_FILE_SEL_LIST.indexOf(params.fs_selectorName);
}
var hideCustSelectorDivs = function(oauth2show) {
  var serviceName = CUST_FILE_SEL_LIST[document.getElementById('customFileSysSelect').selectedIndex];
  hideClass("filesys_choice");
  showClass("fileSys_"+serviceName);
  if (!oauth2show) {oauth2show = ((serviceName =='local')? null:'external');}
  showAuthSection(oauth2show);
}
var showAuthSection = function(section){
  hideDivs(['auth_manual', 'auth_external', 'auth_gotToken', 'auth_environmentToken'])
  if (section!="gotToken") document.getElementById("fs_token").value="";
  if (section && section!="local") {showMainSection('externalFs'); showDiv("auth_"+section);}
}
var changeFsChoice = function() {
  if (document.getElementById('fs_token').value == "" || confirm("These will remove your current access token. Are you sure you want to change?")) hideCustSelectorDivs(null);
}
var goAuthDropbox = function() {
  let url = document.getElementById('fs_auth_Server').value;
  let appName = document.getElementById('fs_auth_AppName').value;
  if (!url) {
    showError("need to enter a url")
  } else if (!appName) {
    showError("need to enter an app name")
  } else {
    let currentParams = get_current_vals();
    window.localStorage.setItem("params", JSON.stringify(currentParams));

    const allurl = url+"/admin/public/oauth_start_oauth#source=dropbox&type=file_env&name="+appName+"&sender="+encodeURIComponent(freezr_server_address+"/admin/public/firstSetUp")
    //onsole.log("opening authenticator site as first step in oauth process: "+allurl)
    window.open(allurl,"_self");
  }
}
var get_current_vals = function() {
  let params = {};
  INPUT_TEXT_PARAM_LIST.forEach(aParam =>  {if(document.getElementById(aParam)) params[aParam] = document.getElementById(aParam).value? document.getElementById(aParam).value:null;})

  params.db_addAuth=document.getElementById('db_addAuth')? document.getElementById('db_addAuth').checked:null;

  params.wantsExternalDb = (params.connectionString || params.db_host || params.db_pword || freezr_environment.dbParams.has_password);

  params.externalDb = params.db_connectionString?
          {connectionString:params.db_connectionString, has_password: freezr_environment.dbParams.has_password}
          :
            (params.wantsExternalDb?
              {port:params.db_port, host:params.db_host, pass:params.db_pword, user:params.db_user, addAuth:params.db_addAuth, has_password: freezr_environment.dbParams.has_password}
              : null);
  params.infoMissing = false;
  params.externalFs = {};
  params.fileSysSelected = CUST_FILE_SEL_LIST[document.getElementById('customFileSysSelect').selectedIndex];
  if (params.fileSysSelected!= 'local') {
    params.externalFs = {name: params.fileSysSelected, access_token: document.getElementById('fs_token').value, has_access_token:freezr_environment.userDirParams.has_access_token};
    if (!params.externalFs.access_token && !freezr_environment.userDirParams.has_access_token) { params.infoMissing = true; }
  }
  return params
}
var register = function () {
  (document.documentElement || document.body.parentNode || document.body).scrollTop = 0;

  let forminfo = get_current_vals();
  // create
  //onsole.log(forminfo)

  if (!forminfo || !forminfo.user_id || !forminfo.password) {
    showError("You need a name and password to log in");
  } else if (forminfo.user_id.indexOf("_")>-1 || forminfo.user_id.indexOf(" ")>-1 || forminfo.user_id.indexOf("/")>-1) {
    showError("user id's cannot have '/' or '_' or spaces in them");
  } else if (firstSetUp &&  (!forminfo.password2 || forminfo.password != forminfo.password2) ) {
    showError("Passwords have to match");
  } else if (forminfo.infoMissing) {
    showError("To use an external file system, you have to get an access token. ")
  } else {
    showError("");
    document.getElementById("click_register").style.display="none";
    var theInfo = { register_type: "setUp",
                    isAdmin: "true",
                    user_id: forminfo.user_id,
                    password: forminfo.password,
                    externalDb: forminfo.externalDb,
                    unifiedDbName:forminfo.db_unifiedDbName,
                    externalFs: forminfo.externalFs
                  };
    freezer_restricted.menu.resetDialogueBox(true);
    //setTimeout(function(){ },2000);

    freezer_restricted.connect.write("/v1/admin/first_registration", theInfo, gotRegisterStatus, "jsonString");
  }
}


var gotRegisterStatus = function(data) {
  var theEl = document.getElementById("freezer_dialogueInnerText");
  if (data) data = freezr.utils.parse(data);
  //onsole.log("gotRegisterStatus "+JSON.stringify(data));
  if (!data) {
    freezr.utils.freezrMenuClose();
    showError("Could not connect to server");
  } else if (data.error) {
    freezr.utils.freezrMenuClose();
    showError("Error: "+data.message);
  } else {
    var theEl = document.getElementById("freezer_dialogueInnerText");
    var msgDiv2 = document.getElementById("top_register_finish_01").cloneNode(true);
    msgDiv2.childNodes.forEach(function (aNode) {if (aNode.id) aNode.id = aNode.id.replace("01","02")})
    hideClass("freezr_hiders");
    theEl.innerHTML = "";
    theEl.appendChild(msgDiv2);
    showInstructions(data.freezrStatus);
  }
      document.getElementById("click_register").style.display="block";
}


var showInstructions = function(freezrStatus) {
  populateErrorMessage(freezrStatus, false);
  var els = [], theClass;
  if (freezrStatus.fundamentals_okay) {
    if (!freezrStatus.environments_match || !freezrStatus.can_write_to_user_folder|| ((freezrStatus.other_errors && freezrStatus.other_errors.length>0))){
      theClass = "fh_partsuccess"
    } else {
      theClass = "fh_success"
    }
  } else {
      theClass = "fh_errors";
  }
  showClass(theClass)
  document.getElementById("close_instructions_01").style.display="none";
}
var populateErrorMessage = function (freezrServerStatus, initial){
  console.log("freezrServerStatus",freezrServerStatus)
  var inner = "";
  if (!freezrServerStatus.fundamentals_okay) {
    var inner = "<b>There was a serious issue with your freezr server environement.<br/>";
    if (!freezrServerStatus.can_write_to_user_folder) {
      inner+= "The system cannot write on the user folder. This means you can't install any apps permanently. <br/>";
    }
    if (!freezrServerStatus.can_read_write_to_db) {
      inner+= "The system cannot access a database. (Perhaps you need to run mongo.)<br/>";
    }
    inner+= "This need to be fixed to be able to run the system. ";
    inner+= (initial? "Please review your External File System or Database for alternatives" : "Please try resubmitting credentials.");
    inner+= "<br/><br/>";
  }
  inner+= !freezrServerStatus.environments_match? "There was a mismatch on environment paramaters":"";
  inner+= (freezrServerStatus.other_errors && freezrServerStatus.other_errors.length>0)? ("Other issues"+freezrServerStatus.other_errors.join("<br/>")):"";

  if (!firstSetUp) inner+="<br/><hr/>IT IS VERY DANGEROUS TO RESET YOUR FREEZR WITH NEW PARAMETERS. <BR/> ONLY DO THIS IF YOU REALLY KNOW WHAT YOU ARE DOING.<br/><hr/>"
  showError(inner);
}
var parseFragments = function (){
  if (window.location.hash.indexOf('#')<0) return null
  let fragments = (function(a) {
  // stackoverflow.com/questions/901115/how-can-i-get-query-string-values-in-javascript
    if (a == "") return {};
    var b = {};
    for (var i = 0; i < a.length; ++i)
    {
        var p=a[i].split('=', 2);
        if (p.length == 1)
            b[p[0]] = "";
        else
            b[p[0]] = decodeURIComponent(p[1].replace(/\+/g, " "));
    }
    return b;
  })(window.location.hash.substr(1).split('&'))
  return fragments;
}


// Generics
var showError = function(errorText) {
  document.body.scrollTop = 0;
  var errorBox=document.getElementById("errorBox");
  errorBox.innerHTML= errorText;
}
var hideClass = function (theClass){
  els = document.getElementsByClassName(theClass)
  for (var i=0;i<els.length;i++) {els[i].style.display="none"}
}
var showClass = function (theClass){
  els = document.getElementsByClassName(theClass)
  for (var i=0;i<els.length;i++) {els[i].style.display="block"; }
}
var showDiv = function (divId){
  let theEl = document.getElementById(divId);
  //onsole.log("shwoing "+divId+(theEl? "exists":"ex NOT"))
  if (theEl) theEl.style.display="block";
}
var hideDiv = function (divId){
  let theEl = document.getElementById(divId);

  //onsole.log("hiding "+divId+(theEl? "exists":"ex NOT"))
  if (theEl) theEl.style.display="none";
}
var hideDivs = function(theDivs) {
  if (theDivs && theDivs.length>0) {
    for (var i=0;i<theDivs.length;i++) {hideDiv(theDivs[i])};
  }
}
var showDivs = function(theDivs) {
  if (theDivs && theDivs.length>0) {
    for (var i=0;i<theDivs.length;i++) {showDiv(theDivs[i])};
  }
}
