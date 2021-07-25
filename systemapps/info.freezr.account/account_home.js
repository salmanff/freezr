// freezr Accunts page

freezr.initPageScripts = function() {
  document.addEventListener('click', function (evt) {
    //onsole.log('clicked'+evt.target.id);
    if (evt.target.id && freezr.utils.startsWith(evt.target.id,"goto_")) {
      var parts = evt.target.id.split('_');
      window.location = "/apps/"+parts[2]+"/index.html";
    }
  });
  setTimeout(function(){
	  var imglist = document.getElementsByClassName("logo_img")
	  for (var i=0; i<imglist.length; i++) {
	      if (!imglist[i].complete|| imglist[i].naturalHeight == 0) imglist[i].src="/app_files/info.freezr.public/public/static/freezer_logo_empty.png";
	  }
  }, 1000);
  if (!freezrMeta.adminUser) {document.getElementById("freezer_admin_butt").style.display="none";}
}
