//admin oauth_serve_setup

let oa_params = {};
let edit_id = "";
const EDIT_BUT_MSG = "Update Permission Parameters"
// federation_enabled + partner_redirect_uris support acting as a federation provider
// (freezr_mail_phase1.md §2.9). Both default to off/empty; only relevant if the admin
// opts in to accept partner requests. Users on this freezr always use whatever credentials
// they pick at /connections/new — they don't need an admin-side consumer config row.
const PARAM_LIST = ['type','name','key','secret','enabled','redirecturi','federation_enabled','partner_redirect_uris']
const PARAM_OPTIONALS = ['secret','enabled','federation_enabled','partner_redirect_uris']
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
          case 'delete':
            if (confirm('Are you sure you want to delete this OAuth configuration?')) {
              writeOauthPerm({ _id: args[2], delete: true });
            }
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
    var el = document.getElementById('oa_'+aParam);
    if (!el) return;
    var val = oa_params[aParam];
    if (el.type === 'checkbox') {
      el.checked = !!val;
      return;
    }
    // partner_redirect_uris is an array on disk; the textarea wants one URL per line.
    if (aParam === 'partner_redirect_uris' && Array.isArray(val)) val = val.join('\n');
    el.value = (val || '');
  })
  // NOTE: Phase 1 limitation — when editing an existing row, the federation fields
  // (federation_enabled, partner_redirect_uris) are not currently round-tripped from the
  // row template back into the edit form. If you need to edit those, delete and
  // recreate the row. Polish is a follow-up commit.
}

const states_issued = {}
var makeOauth = function () {
  //onsole.log("todo - Basic error checking") // has to be string
  document.body.scrollTop = 0;

  oa_params = {};
  PARAM_LIST.forEach(function(aParam) {
    const el = document.getElementById('oa_'+aParam);
    if (!el) return;
    if (el.type === 'checkbox') {
      oa_params[aParam] = !!el.checked;
      return;
    }
    const raw = (el.value || '').trim();
    if (!raw) return;
    if (aParam === 'partner_redirect_uris') {
      // Textarea: one URL per line → array of strings, ignoring blank lines.
      oa_params[aParam] = raw.split(/\r?\n/).map(function(s){ return s.trim(); }).filter(Boolean);
    } else {
      oa_params[aParam] = raw;
    }
  });

  // Validation: type + name required; Client ID + Redirect URI required (this row IS a
  // direct provider config — no more standalone consumer-config option, since /connections/new
  // gives users the partner-picker directly).
  if (!oa_params.type || !oa_params.name) {
    showError('Type and App Name are required.');
    return;
  }
  if (!oa_params.key || !oa_params.redirecturi) {
    showError('Client ID and Redirect URI are required. See freezr_own_google_oauth_setup.md for how to obtain them from Google.');
    return;
  }

  showError('');
  document.getElementById('loader').style.display = 'block';
  if (edit_id) oa_params._id = edit_id;
  oa_params.enabled = true;
  writeOauthPerm(oa_params);
}

var writeOauthPerm = async function (oa_params) {
    console.log("sending theInfo: "+JSON.stringify (oa_params))
    try {
      const data = await freezr.apiRequest('PUT', '/oauth/privateapi/oauth_perm', oa_params)
      gotMakeOauthStatus(null, data)
    } catch (error) {
      gotMakeOauthStatus(error, null)
    }
}
var gotMakeOauthStatus = function(error, data) {
  //onsole.log("gotMakeOauthStatus "+JSON.stringify(data));
  document.getElementById("loader").style.display = 'none';
  data = freezr.utils.parse(data)
  if (error) {
    showError("Error: "+ error.message + (data ? ' ' + data.written : ''));
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
