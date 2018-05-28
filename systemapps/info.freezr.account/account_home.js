// freezr Accunts page

freezr.initPageScripts = function() {
  document.addEventListener('click', function (evt) {
    console.log('clicked'+evt.target.id);
    if (evt.target.id && freezr.utils.startsWith(evt.target.id,"goto_")) {
      var parts = evt.target.id.split('_');
      window.location = "/apps/"+parts[2];
    }
  });

  setTimeout(function(){ 
	  var imglist = document.getElementsByClassName("logo_img") 
	  console.log("got img lass f len "+imglist.length)
	  for (var i=0; i<imglist.length; i++) {
	      console.log(" got in LIST"+imglist[i].id)
	      if (imglist[i].complete && imglist[i].naturalHeight !== 0) console.log(imglist[i].id+" compelte")
	      if (!imglist[i].complete|| imglist[i].naturalHeight == 0) console.log(imglist[i].id+" NOT compelte")
	      if (!imglist[i].complete|| imglist[i].naturalHeight == 0) imglist[i].src="/app_files/info.freezr.public/static/freezer_logo_empty.png";
	  }
  }, 1000);

  if (!freezr_user_is_admin) {document.getElementById("freezer_admin_butt").style.display="none";} 
}

