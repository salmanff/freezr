// oauth_validate_page.js


freezr.initPageScripts = function() { 
	//onsole.log(fragments);
	if (!fragments) {
		showError("Error - No fragements")
	} else if (!fragments.access_token) {
		showError("Error - No access token")
	} else if (!fragments.state) {
		showError("Error - No state")
	} else {
		let options = {state: fragments.state}
		freezer_restricted.connect.read("/v1/admin/oauth/public/validate_state", options, function(jsonString) {
			console.log("oauth validate - return string is "+JSON.stringify(jsonString));
	        jsonString = freezr.utils.parse(jsonString);	        
	        let allurl = jsonString.sender+"#access_token="+fragments.access_token+"&source="+jsonString.source;
	        console.log("oauth_validate_page - redirect to : "+allurl)
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

