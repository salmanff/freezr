// freezr  firstSetUp

/* global freezr, freezrServerStatus, freezrEnvironment, freezerRestricted, freezrIsDev */
// const thisPage = document.location.href.includes('register/firstSetUp') ? 'firstSetUp' : 'new_self_register'

freezr.initPageScripts = function () {
  console.log('firstSetUp.js loaded', { freezrEnvironment, thisPage })
  createSelector('FS', freezrEnvironment.fsParams.type)
  createSelector('DB', freezrEnvironment.dbParams.type)

  document.addEventListener('click', function (evt) {
    // onsole.log(evt.target.id)
    const args = evt.target.id.split('_')
    if (args && args.length > 1 && args[0] === 'click') {
      switch (args[1]) {
        case 'launch':
          launch()
          break
        case 'checkResource':
          checkResource(args[2])
          break
        default:
          console.warn('udnefined click ', args)
          break
      }
    }
  })

  hideClass('freezr_hiders')

  document.getElementById('password2').addEventListener('keypress', function (e) { if (e.keyCode === 13) launch() })

  // add oauth issues here
  populateErrorMessage(freezrServerStatus, true)
  setTimeout(function () { document.body.scrollTop = 0 }, 20)
}

const ENV_PARAMS = {
  FS: {
    local: {
      label: "Server's file system",
      msg: 'You are using your local file system.',
      warning: 'Note that most cloud servers delete their local file system when they restart - ie periodically. Make sure you know what you are doing when you choose this option.',
      firstSetUp: true,
      register: false
    },
    dropbox: {
      label: 'Dropbox',
      msg: 'You can use your drpbox as your file system. Please obtain an access token an enter it here.',
      warning: 'This will be automated in the future.',
      firstSetUp: true,
      register: true,
      fields: [{
        name: 'accessToken',
        display: 'Access Token:'
      }]
    },
    aws: {
      label: 'AWS (Amazon)',
      msg: 'You can use Amazon S3 storage as your file system. Please obtain an access token an enter it here.',
      firstSetUp: true,
      register: true,
      fields: [
        { name: 'accessKeyId', display: 'Access Key Id:' },
        { name: 'secretAccessKey', display: 'Secret Access Key:' }
      ]
    },
    sysDefault: {
      label: 'System Default',
      msg: 'The admin has offered to use the default system settings to store your files.',
      firstSetUp: false,
      register: true // Not always true - only if allowed
    }
  },
  DB: {
    sysDefault: {
      label: 'System Default',
      msg: 'The admin has offered to use the default system settings to store your database.',
      firstSetUp: false,
      register: true // Not always true - only if allowed
    },
    nedb: {
      label: 'Use files as database',
      msg: 'You can use your local file system as a database, with NEDB.',
      warning: 'Note that if you want to store more than a few thousand records, a more enterprise-scale database like mongo may be needed.',
      firstSetUp: true,
      register: true
    },
    localMongo: {
      label: 'Local Mongo Server',
      msg: 'You have a local instance of mongo running.',
      firstSetUp: true,
      register: false
    },
    mongoS: {
      label: 'MongoDB - Connection String',
      msg: 'You can enter a full url of a mongo database. Mongo Atlas provides this for you, or you can set up your own.',
      fields: [{ name: 'mongoString', display: 'Full Mongo URL:' }],
      firstSetUp: true,
      register: true
    },
    mongoD: {
      label: 'MongoDB - Full Details',
      msg: 'You can enter the individual parameters of mongodb database. ',
      fields: [
        { name: 'user', display: 'Database User:' },
        { name: 'password', display: 'Database Password:', type: 'password' },
        { name: 'host', display: 'Database Host:' },
        { name: 'port', display: 'Database Port:' },
        { name: 'user', display: 'Database User:' }
      ],
      firstSetUp: true,
      register: true
    }
  }
}

const createSelector = function (resource, choice) {
  /// todo - save previous values
  const selector = document.getElementById('selector_' + resource)
  selector.innerHTML = ''
  for (const [key, params] of Object.entries(ENV_PARAMS[resource])) {
    if (params[thisPage]) {
      const option = document.createElement('option')
      option.setAttribute('value', key)
      option.innerHTML = params.label
      selector.appendChild(option)
    }
  }
  selector.value = choice
  changeSelector(resource)
  document.getElementById('selector_' + resource).onchange = function () { changeSelector(resource) }
}

const changeSelector = function (resource) {
  const choice = document.getElementById('selector_' + resource).value
  if (!choice) {
    showError('Please choose an item')
  } else {
    const params = ENV_PARAMS[resource][choice]
    document.getElementById('msg_' + resource).innerHTML = params.msg || ''
    document.getElementById('warning_' + resource).innerHTML = params.warning || ''
    if (resource === 'FS' && choice === 'local' && document.location.host.includes('localhost')) document.getElementById('warning_' + resource).innerHTML = ''
    const tabletop = document.getElementById('table_elements_' + resource)
    tabletop.innerHTML = ''
    if (params.fields && params.fields.length > 0) {
      const table = document.createElement('table')
      params.fields.forEach(item => {
        const row = document.createElement('tr')
        const col1 = document.createElement('td')
        col1.setAttribute('width', '150px')
        col1.setAttribute('align', 'right')
        col1.innerHTML = item.display
        row.appendChild(col1)
        const col2 = document.createElement('td')
        col2.setAttribute('width', '220px')
        const input = document.createElement('input')
        input.setAttribute('type', (item.type || 'text'))
        input.setAttribute('size', '40')
        input.setAttribute('name', (choice + '_' + item.name))
        input.id = choice + '_' + item.name
        col2.appendChild(input)
        row.appendChild(col2)
        table.appendChild(row)
      })
      tabletop.appendChild(table)
    }
  }
}
const getFormData = function (resource) {
  const choice = document.getElementById('selector_' + resource).value
  const params = { type: choice }
  let err = choice ? '' : 'Nothing selected'
  if (choice) {
    const fields = ENV_PARAMS[resource][choice].fields
    if (fields && fields.length > 0) {
      fields.forEach((item) => {
        const input = document.getElementById(choice + '_' + item.name)
        if (input && input.value && input.value.trim() !== '') {
          params[item.name] = input.value
        } else {
          err += (err ? ',' : 'Missing parameter: ') + item.name
        }
      })
    }
  }
  return [err, choice, params]
}
const checkResource = async function (resource) {
  const [err, choice, params] = getFormData(resource)
  if (err) {
    showError(err)
  } else if (choice === 'sysDefault') {
    showError('Cannot test system defaults')
  } else if (thisPage !== 'firstSetUp' && resource === 'DB' && choice === 'nedb' && document.getElementById('selector_FS').value === 'local') {
    showError('Cannot check nedb with local file system (except when setting up the system)')
  } else {
    var toSend = { resource, env: {}, action: 'checkresource' }
    toSend.env[(resource === 'FS' ? 'fsParams' : 'dbParams')] = params
    if (resource === 'DB') {
      const [fsErr, fsChoice, fsParams] = getFormData('FS')
      if (fsErr) {
        showError(fsErr)
      } else {
        toSend.env.fsParams = fsParams
      }
    }

    try {
      const data = await freezr.apiRequest('POST', '/register/api/checkresource', toSend)
      gotCheckStatus(null, data)
    } catch (error) {
      gotCheckStatus(error, null)
    }
  }
}

function gotCheckStatus (err, data) {
  // if (err || (data && data.err) || (data && !data.checkpassed))
  console.log('gotCheckStatus ', { err, data })
  if (err) {
    showError(err.message)
  } else if (data.err) {
    showError(data.err)
  } else if (!data.checkpassed) {
    showError('Unsuccessful attempt to check ' + (data.resource === 'FS' ? 'file system.' : 'database.'))
  } else {
    showError('Your ' + (data.resource === 'FS' ? 'file system' : 'database') + ' works!')
  }
}

var launch = async function () {
  const [fsErr, , fsParams] = getFormData('FS')
  const [dbErr, , dbParams] = getFormData('DB')
  const ids = {}
  const ID_LIST = ['userId', 'password', 'password2']
  ID_LIST.forEach(item => {
    ids[item] = document.getElementById(item).value
  })
  const setupToken = document.getElementById('setupToken')?.value?.trim()

  if (fsErr) {
    showError(fsErr)
  } else if (dbErr) {
    showError(dbErr)
  } else if (!ids.userId || !ids.password) {
    showError('You need a name and password to register and launch')
  } else if (ids.userId.indexOf('_') > -1 || ids.userId.indexOf(' ') > -1 || ids.userId.indexOf('/') > -1) {
    showError("user id's cannot have '/' or '_' or spaces in them")
  } else if (!ids.password2 || ids.password !== ids.password2) {
    showError('Passwords have to match')
  } else if (thisPage === 'firstSetUp' && !freezrIsDev && !setupToken) {
    showError('Setup token is required (unless running in development mode).')
  } else if (thisPage === 'firstSetUp' && !freezrIsDev && !isValidSetupToken(setupToken)) {
    showError('Setup token format is invalid or expired. Use "<token>.YYYY-MM-DD".')
  } else {
    showError('')
    var theInfo = { action: (thisPage === 'firstSetUp' ? 'setup' : 'new'), userId: ids.userId, password: ids.password, env: {fsParams, dbParams} }
    if (thisPage === 'firstSetUp' && setupToken) theInfo.setupToken = setupToken
    // freezerRestricted.menu.resetDialogueBox(true);

    const thisAction = (thisPage === 'firstSetUp' ? 'firstSetUp' : 'newParams')

    try {
      const data = await freezr.apiRequest('POST', '/register/api/' + thisAction, theInfo)
      gotRegisterStatus(null, data)
    } catch (error) {
      gotRegisterStatus(error, null)
    }
  }
}

const isValidSetupToken = function (token) {
  if (!token || typeof token !== 'string') return false
  const lastDot = token.lastIndexOf('.')
  if (lastDot < 0) return false
  const dateStr = token.slice(lastDot + 1)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false
  const expires = new Date(`${dateStr}T23:59:59.999Z`)
  if (Number.isNaN(expires.getTime())) return false
  return Date.now() <= expires.getTime()
}

const gotRegisterStatus = function (error, data) {
  if (error) {
    console.log('gotRegisterStatus ', { error, data })
    showError('Error: ' + error.message)
  } else if (!data) {
    showError('No data was sent ferom server - refresh to see status')
  } else {
    window.location = (thisPage === 'firstSetUp' ? '/admin/prefs?firstSetUp=true' : '/account/home')
  }
}

const INPUT_TEXT_PARAM_LIST = ['user_id', 'password', 'password2', 'db_user', 'db_pword', 'db_host', 'db_port', 'db_connectionString', 'db_unifiedDbName', 'fs_token','fs_auth_Server','fs_auth_AppName'];

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
  let selector = document.getElementById('selector_fs');
  // selector.selectedIndex = CUST_FILE_SEL_LIST.indexOf(params.fs_selectorName);
}
var hideCustSelectorDivs = function(oauth2show) {
  // var serviceName = CUST_FILE_SEL_LIST[document.getElementById('selector_fs').selectedIndex];
  hideClass("filesys_choice");
  showClass("fileSys_"+serviceName);
  if (!oauth2show) {oauth2show = ((serviceName =='local')? null:'external');}
  showAuthSection(oauth2show);
}
var showAuthSection = function(section){
  hideDivs(['auth_external', 'auth_gotToken', 'auth_environmentToken'])
  if (section!="gotToken") document.getElementById("fs_token").value="";
  if (section && section!="local") {showMainSection('externalFs'); showDiv("auth_"+section);}
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

    const allurl = url+"/public/oauth/oauth_start_oauth#source=dropbox&type=file_env&name="+appName+"&sender="+encodeURIComponent(freezrMeta.serverAddress+"/admin/firstSetUp")
    //onsole.log("opening authenticator site as first step in oauth process: "+allurl)
    window.open(allurl,"_self");
  }
}
var get_current_vals = function() {
  let params = {};
  INPUT_TEXT_PARAM_LIST.forEach(aParam =>  {if(document.getElementById(aParam)) params[aParam] = document.getElementById(aParam).value? document.getElementById(aParam).value:null;})

  params.db_addAuth=document.getElementById('db_addAuth')? document.getElementById('db_addAuth').checked:null;

  params.wantsExternalDb = (params.connectionString || params.db_host || params.db_pword || freezrEnvironment.dbParams.has_password);

  params.externalDb = params.db_connectionString?
          {connectionString:params.db_connectionString, has_password: freezrEnvironment.dbParams.has_password}
          :
            (params.wantsExternalDb?
              {port:params.db_port, host:params.db_host, pass:params.db_pword, user:params.db_user, addAuth:params.db_addAuth, has_password: freezrEnvironment.dbParams.has_password}
              : null);
  params.infoMissing = false;
  params.externalFs = {};
  // params.fileSysSelected = CUST_FILE_SEL_LIST[document.getElementById('selector_fs').selectedIndex];
  if (params.fileSysSelected!= 'local') {
    params.externalFs = {type: params.fileSysSelected, access_token: document.getElementById('fs_token').value, has_access_token:freezrEnvironment.fsParams.has_access_token};
    if (!params.externalFs.access_token && !freezrEnvironment.fsParams.has_access_token) { params.infoMissing = true; }
  }
  return params
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
  console.log("populateErrorMessage freezrServerStatus",freezrServerStatus)
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
  inner+= (freezrServerStatus.other_errors && freezrServerStatus.other_errors.length>0)? ("Other issues"+freezrServerStatus.other_errors.join("<br/>")):"";

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
  var errorBox=document.getElementById("errorBox");
  errorBox.style.display = "block"
  errorBox.innerHTML = errorText;
}
const hideClass = function (theClass) {
  const els = document.getElementsByClassName(theClass)
  for (var i = 0; i < els.length; i++) {
    els[i].style.display = 'none'
  }
}
const showClass = function (theClass) {
  const els = document.getElementsByClassName(theClass)
  for (var i = 0; i < els.length; i++) {
    els[i].style.display = 'block'
  }
}
const showDiv = function (divId) {
  const theEl = document.getElementById(divId)
  if (theEl) theEl.style.display = 'block'
}
const hideDiv = function (divId) {
  const theEl = document.getElementById(divId)
  if (theEl) theEl.style.display = 'none'
}
const hideDivs = function (theDivs) {
  if (theDivs && theDivs.length > 0) {
    for (var i = 0; i < theDivs.length; i++) {
      hideDiv(theDivs[i])
    }
  }
}
const showDivs = function (theDivs) {
  if (theDivs && theDivs.length > 0) {
    for (var i = 0; i < theDivs.length; i++) {
      showDiv(theDivs[i])
    }
  }
}
