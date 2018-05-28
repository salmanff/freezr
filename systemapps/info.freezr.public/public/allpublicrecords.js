/* 
allpublicrecords
*/
document.addEventListener('click', function(e) { 
        var el = e.target
        if (el.className=="freezr_expander") {
            el.style.display="none";
            el.parentElement.className="freezr_public_genericCardOuter";
        } else if (el.id=="searchButt") {
        	doSearch();
        }
    }, false);
document.onkeypress= function (evt) {
	if (evt.keyCode == 13 && evt.target && evt.target.id=="searchBox") {
		evt.preventDefault();
		doSearch(); 
	} 
}


var doSearch = function () {
	terms = document.getElementById("searchBox").innerText.toLowerCase();
	if (terms.length>0) terms = terms.split(" ")
	var app=[], q=[], user=null 
	if (terms.length>0) {
		console.log("here")
		terms.forEach(function(aterm) {
			if (startsWith(aterm,"app:") ){
				app = aterm.slice(4)
			} else if (startsWith(aterm,"user:") ){
				user=(aterm.slice(5))
			} else {
				q.push(aterm)
			}
		})
	}
	console.log( '/ppage?' + ((q && q.length>0)?("q="+q.join(" ")):"") + ((app && app.length>0)?("app="+app):"") + ((user && user.length>0)?("user="+user):"" ) );
	window.open('/ppage?' +  ((q && q.length>0)?("q="+q.join(" ")):"") + ((app && app.length>0)?("app="+app):"") + ((user && user.length>0)?("user="+user):"" ),"_self" );
}

var startsWith = function(longertext, checktext) {
        if (checktext.length > longertext.length) {return false} else {
        return (checktext == longertext.slice(0,checktext.length));}
    }