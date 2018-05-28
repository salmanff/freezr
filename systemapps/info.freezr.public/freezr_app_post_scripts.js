// info.freezr.public - 
/* script file to be included after freezr_app_init.js and app_config.js . If there is no app_config.js, then freezr_app_name must be defined by the app
*/

    var freezr_app_name = (exports && exports.structure && exports.structure.meta && exports.structure.meta.app_name)? exports.structure.meta.app_name: "";
    var freezr_app_version = (exports && exports.structure && exports.structure.meta && exports.structure.meta.app_version)? exports.structure.meta.app_version: "N/A";
    var freezr_app_display_name = (exports && exports.structure && exports.structure.meta && exports.structure.meta.app_display_name)? exports.structure.meta.app_display_name: freezr_app_name;

	freezr.app.isWebBased = false;
	document.addEventListener("DOMContentLoaded", function(){
			freezr.utils.addFreezerDialogueElements();
			freezr.initPageScripts();
	});

