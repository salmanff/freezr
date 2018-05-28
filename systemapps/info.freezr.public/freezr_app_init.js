/* freezr apps (electron) 
	Script to be referenced after freezr_core and ebfore app_config ans freezer_app_post_scripts
*/		
		// Electron specific:
		//window.nodeRequire = require;
		delete window.require;
		delete window.exports;
		delete window.module;

		// all apps..
		var exports = {structure:null};

	    var freezr_info_page_url = null;
	    var freezr_info_initial_query = null;
	    var freezr_app_code = null;
	    var freezr_user_id = null;
	    var freezr_messages = null;
	    var freezr_server_address = "";
	    var freezr_server_version = "n/a";
	    var freezr_user_is_admin = null;    

	    
