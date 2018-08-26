/* 
allpublicrecords
*/
document.addEventListener('click', function(e) { 
    	var el = e.target
    	if (el.className=="freezr_expander") {
            el.style.display="none";
            while (el.tagName !="body" && el.className.indexOf("freezr_public_genericCardOuter")<0) {el=el.parentNode;}
            if (el.tagName !="body") el.className="freezr_public_genericCardOuter";
            adjustHeight(el)
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
window.onresize = function(event) {
	let outers = document.getElementsByClassName("freezr_public_genericCardOuter");
	Array.prototype.forEach.call(outers, function(anOuter) { 
		if (anOuter.className.indexOf("freezr_public_genericCardOuter_overflower")<0) adjustHeight(anOuter);
	})
};
var doSearch = function () {
	terms = document.getElementById("searchBox").innerText.toLowerCase();
	if (terms.length>0) terms = terms.split(" ")
	var app=[], q=[], user=null 
	if (terms.length>0) {
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
	window.open('/ppage?' +  ((q && q.length>0)?("q="+q.join(" ")):"") + ((app && app.length>0)?("app="+app):"") + ((user && user.length>0)?("user="+user):"" ),"_self" );
}

var startsWith = function(longertext, checktext) {
        if (checktext.length > longertext.length) {return false} else {
        return (checktext == longertext.slice(0,checktext.length));}
    }

var adjustHeight= function(originalEl, el) {
	if (!el) el = originalEl
	Array.from(el.children).forEach((aChild, index) => {
		let diff = (aChild.offsetTop + aChild.offsetHeight) - (originalEl.offsetTop+originalEl.offsetHeight)
		if (diff>0) {originalEl.style.minHeight= (originalEl.offsetHeight+diff) + "px"; }
		adjustHeight(originalEl, aChild);
	})
}