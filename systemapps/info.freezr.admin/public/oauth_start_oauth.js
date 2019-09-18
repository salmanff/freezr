// oauth_start_oauth.js



freezr.initPageScripts = function() {
	console.log("oauth_start_oauth fragments")
	console.log(fragments);
	console.log(fragments.sender+ " vs " + document.referrer)
	if (!fragments.type) {
		showError("Error - Missing type")
	} else if (!fragments.name) {
		showError("Error - Missing name")
	} else if (!fragments.source) {
		showError("Error - Missing source")
	} else if (!fragments.sender) {
		showError("Error - Missing sender")
	} else {		
	    let options = {
	      source: fragments.source,
	      name: fragments.name,
	      type: fragments.type,
	      sender: fragments.sender
	    }

	    freezer_restricted.connect.read("/v1/admin/oauth/public/get_new_state", options, function(jsonString) {
	    	jsonString = freezr.utils.parse(jsonString);
	    	console.log("got jsonString "+JSON.stringify(jsonString))

	      //
	    	let redirect_uri = freezr_server_address+"/admin/public/oauth_validate_page";
	    	const allurl = "https://dropbox.com/oauth2/authorize?response_type=token&state="+jsonString.state+"&client_id="+jsonString.key+"&redirect_uri="+encodeURIComponent(redirect_uri)
	    	console.log("opening "+allurl)
	    	window.open(allurl,"_self");

	    });
	}
}

var fragments = (function(a) {
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
})(window.location.hash.substr(1).split('&'));


var showError = function(errorText) {
  document.body.scrollTop = 0;
  var errorBox=document.getElementById("errorBox");
  errorBox.innerHTML= errorText;
}
