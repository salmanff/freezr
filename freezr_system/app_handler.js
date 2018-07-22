// freezr.info - nodejs system files - app_handler.js
exports.version = "0.0.1";
 
var helpers = require('./helpers.js'),
    freezr_db = require("./freezr_db.js"),
    user_obj = require("./user_obj.js"),
    async = require('async'),
    file_handler = require('./file_handler.js');

var reserved_field_name_list = ["_owner","_date_Created", "_date_Modified","_accessible_By"];

exports.generateSystemDataPage = function (req, res) {
    // '/allmydata/:whattodo/:app_name'
    if (req.params.whattodo == "view" ) {
        req.params.sysConfig = {
            'pages':{
                'allmydata_view': {
                    "page_title":"View all my data for "+req.params.app_name,
                    "html_file":"./info.freezr.account/allmydata_view.html",
                    "css_files": ["./info.freezr.account/allmydata_view.css"],
                    "script_files": ["./info.freezr.account/allmydata_view.js","./info.freezr.account/FileSaver.js"]
                }
        }}
       req.params.page = 'allmydata_view'
    } else if (req.params.whattodo == "backup" ) {
        req.params.sysConfig = {
            'pages':{
                'allmydata_backup': {
                    "page_title":"Backup and Restore data for "+req.params.app_name,
                    "html_file":"./info.freezr.account/allmydata_backup.html",
                    "css_files": ["./info.freezr.account/allmydata_backup.css"],
                    "script_files": ["./info.freezr.account/allmydata_backup.js","./info.freezr.account/FileSaver.js"]
                }
        }}
        req.params.page = 'allmydata_backup'
    } else {
        helpers.send_internal_err_page(res, "app_handler", exports.version, "generateDataPage", "whattodo is not defined");
    }
    
    exports.generatePage(req, res);
}

exports.generatePage = function (req, res) { 
    // '/apps/:app_name' and '/apps/:app_name/:page' (and generateDataPage above)
    helpers.log (req,"appPage: "+req.url);

    if (req.params.sysConfig === undefined) {
        file_handler.async_app_config(req.params.app_name, req.freezr_environment, function(err, app_config){
            if (err) {
                helpers.warning("app_handler.js", exports.version, "generatePage", "Pass through of app_config ");
                helpers.send_failure(res, 500, err);
            } else {

                var page_name = req.params.page? req.params.page: "index";
                var has_app_config = true;
                if (!app_config) {
                    app_config = {};
                    has_app_config = false;
                }
                app_config.pages = app_config.pages || {};
                app_config.pages[page_name] = app_config.pages[page_name] || {}

                if (app_config.pages[page_name].initial_query) {
                    // formulate req to add an internlcallforward and relevant query_params 
                    // generatePageWithAppConfig (req, res, app_config, initial_query) addinitial data here and internalcallfwd it from db_quer
                            // note define requestee app and requestor app etc to fit db_query params without overlapping

                    // Only takes type: db_query at this time
                    
                    var data_params = app_config.pages[page_name].initial_query;

                    req.params.requestor_app = req.params.app_name;
                    req.params.permission_name = data_params.permission_name;
                    var app_config_permission_schema = (app_config.permissions)? app_config.permissions[req.params.permission_name]: {};
                    if (app_config_permission_schema) {                        
                        req.params.requestee_app = (app_config_permission_schema.requestee_app)? app_config_permission_schema.requestee_app: req.params.requestor_app;
                        if (data_params.collection_name) {
                            if (app_config_permission_schema.collection) {
                                req.body.collection = app_config_permission_schema.collection;
                                if (data_params.collection_name && app_config_permission_schema.collection != data_params.collection_name) helpers.warning("app_handler", exports.version, "generatePage", "permission schema collections inconsistent with requested collction "+data_params.collection_name+" for app: "+req.params.app_name)
                            } else if (app_config_permission_schema.collections && Object.prototype.toString.call( app_config_permission_schema.collections ) === '[object Array]' && app_config_permission_schema.collections.length>0) {
                                if (data_params.collection_name && app_config_permission_schema.collections.indexOf(data_params.collection_name)>0) {
                                    req.body.collection = data_params.collection_name;   
                                } else {
                                    helpers.send_failure(res, 500, helpers.state_error("app_handler", exports.version, "generatePage","bad_colelction_name","permission schema collections inconsistent with requested collction "+data_params.collection_name+" for app: "+req.params.app_name));
                                }            
                            } else {
                                helpers.send_failure(res, 500, helpers.state_error("app_handler", exports.version, "generatePage","bad_colelction_name","permission schema collections not stated - need to add to app config:  "+data_params.collection_name+" for app: "+req.params.app_name));
                            }
                        } else {
                            if (app_config_permission_schema.collections && Object.prototype.toString.call( app_config_permission_schema.collections ) === '[object Array]' && app_config_permission_schema.collections.length>0) {
                                req.body.collection = app_config_permission_schema.collections[0]   
                            } else {
                                helpers.send_failure(res, 500, helpers.state_error("app_handler", exports.version, "generatePage","bad_colelction_name","permission schema collections not stated - need to add to app config the desired collection for  app: "+req.params.app_name));
                            } 
                        }
                    } else {
                        req.params.requestee_app = req.params.requestor_app;
                        req.body.collection = data_params.collection_name || null;
                    }
                    req.params.skipappcodecheck = true;

                    req.internalcallfwd = function (err, results) {
                        if (err) console.log("State Error "+err)
                        
                        req.params.queryresults = {results: results};
                        generatePageWithAppConfig(req, res, app_config);
                    }
                    exports.db_query(req, res);

                } else if (!has_app_config){
                    // todo - check if the files exist first
                    app_config.pages[page_name].page_title  =  page_name;
                    app_config.pages[page_name].html_file   =  page_name+".html"; // file_handler.appLocalFileExists(req.params.app_name, (page_name+".html"))?  page_name+".html" : null;
                    app_config.pages[page_name].css_files   =  page_name+".css"; // file_handler.appLocalFileExists(req.params.app_name, (page_name+".css" ))?  page_name+".css"  : null;
                    app_config.pages[page_name].script_files= [page_name+".js"] //file_handler.appLocalFileExists(req.params.app_name, (page_name+".js"  ))? [page_name+".js"]  : null; 
                    generatePageWithAppConfig(req, res, app_config);
                } else {
                    generatePageWithAppConfig(req, res, app_config);
                }
            }
        }) 
    } else {
         generatePageWithAppConfig(req, res, req.params.sysConfig)
    }
}

var generatePageWithAppConfig = function (req, res, app_config) { 
    var page_name = req.params.page? req.params.page: "index";
    if (helpers.endsWith(page_name, '.html')) page_name = page_name.slice(0,-5);

    var page_params = {};
    if (app_config && app_config.pages && app_config.pages[page_name]) {
        page_params = app_config.pages[page_name];
    } 

    var options = {
        page_title: page_params.page_title+" - freezr.info",
        page_url: page_params.html_file? page_params.html_file: './info.freezr.public/fileNotFound.html',
        css_files: [],
        queryresults: (req.params.queryresults || null),
        script_files: [], //page_params.script_files, //[],
        messages: {showOnStart:false},
        user_id: req.session.logged_in_user_id,
        user_is_admin :req.session.logged_in_as_admin,
        app_name: req.params.app_name,
        app_display_name : ( (app_config && app_config.meta && app_config.meta.app_display_name)? app_config.meta.app_display_name:req.params.app_name),
        app_version: (app_config && app_config.meta && app_config.meta.app_version)? app_config.meta.app_version:"N/A",
        other_variables: null,
        freezr_server_version: req.freezr_server_version,
        server_name: req.protocol+"://"+req.get('host')
    }     

    freezr_db.get_or_set_user_app_code (req.session.logged_in_user_id,req.params.app_name, function(err,results,cb){
        if (err || !results.app_code) {
            helpers.send_internal_err_page(res, "app_handler", exports.version, "generatePage", "Could not get app code");
        } else {
            options.app_code = results.app_code;
            options.messages.showOnStart = (results.newCode && app_config && app_config.permissions && Object.keys(app_config.permissions).length > 0);


            freezr_db.check_device_code_specific_session(req.session.device_code, req.session.logged_in_user_id, req.params.app_name, function(err, cb) {
                // Put page param scripts in options.scrip_files, except for outside scripts to be checked below
                if (err) {
                    req.session.device_code=null;
                    res.redirect('/account/login?error=true&error_type=login_redentials_for_app_only')
                } else {
                    if (page_params.css_files) {
                        if (typeof page_params.css_files == "string") page_params.css_files = [page_params.css_files];
                        page_params.css_files.forEach(function(css_file) {
                            if (helpers.startsWith(css_file,"http")) {
                                helpers.app_data_error(exports.version, "generatePage", req.params.app_name, "Cannot have css files referring to other hosts")
                            } else {
                                if (file_handler.fileExt(css_file) == 'css'){
                                    options.css_files.push(css_file);
                                } else {
                                    helpers.app_data_error(exports.version, "generatePage", req.params.app_name, "Cannot have non js file used as css "+css_file)
                                }
                            }
                        });
                    }
                    var outside_scripts = [];
                    if (page_params.script_files) {
                        if (typeof page_params.script_files == "string") page_params.script_files = [page_params.script_files];
                        page_params.script_files.forEach(function(js_file) {
                            if (helpers.startsWith(js_file,"http")) {
                                outside_scripts.push(js_file)
                            } else {
                                // Check if exists? - todo and review - err if file doesn't exist?
                                if (file_handler.fileExt(js_file) == 'js'){
                                    options.script_files.push(js_file);
                                } else {
                                    helpers.app_data_error(exports.version, "generatePage", req.params.app_name, "Cannot have non js file used as js.")
                                }
                            }
                        });
                    }

                    if (outside_scripts.length>0) {
                        freezr_db.all_userAppPermissions(req.session.logged_in_user_id, req.params.app_name, function(err, perm_list, cb) {
                            if (err) {
                                helpers.send_internal_err_page(res, "app_handler", exports.version, "generatePage", "Could not get user app  permissions");
                            } else {
                                if (perm_list.length>0) {
                                    outside_scripts.forEach(function(script_requested) {
                                        for (var i=0; i<perm_list.length; i++) {
                                            var perm_obj = perm_list[i];
                                            if (perm_obj.script_url && perm_obj.script_url == script_requested && perm_obj.granted && !perm_obj.denied) {
                                                options.script_files.push(perm_obj.script_url);
                                                break;
                                            }
                                        }
                                    });
                                }  
                                options.testfrom = "APP"
                                file_handler.load_data_html_and_page(res, options, req.freezr_environment);
                            }
                        })
                    } else {
                        options.testfrom = "APP"
                        file_handler.load_data_html_and_page(res, options, req.freezr_environment);

                    }
                }
            })   
        }
    });    
};

// database operations
exports.putData = function (req, res){
    // /v1/app_data/:app_name/:source_app_code/:collection
    //helpers.log (req,"putData at "+req.url); //+"body:"+JSON.stringify((req.body && req.body.options)? req.body.options:" none"));
    helpers.log (req,"putData at "+req.url+"body:"+JSON.stringify((req.body && req.body.options)? req.body.options:" none"));

    // Initialize variables
        if (req.body.options && (typeof req.body.options == "string")) req.body.options = JSON.parse(req.body.options); // needed when upload file
        if (req.body.data && (typeof req.body.data == "string")) req.body.data = JSON.parse(req.body.data); // needed when upload file

        var data_object_id= (req.body.options && req.body.options.data_object_id)? req.body.options.data_object_id: null;
        var flags = new Flags({'app_name':req.params.app_name});
        var app_config = null, real_object_id, data_model, dbCollection = null, collection_name=null, returned_confirm_fields={},  real_object_id;
        function app_err(message) {return helpers.app_data_error(exports.version, "putData", req.params.app_name, message);}
        var fileParams = {'dir':"", 'name':"", 'duplicated_file':false};
        fileParams.is_attached = (req.file)? true:false;
        var isAccessibleObject, permission_object, accessibles_db;
        var write = (req.body && req.body.data)? JSON.parse(JSON.stringify(req.body.data)): {};

        var final_object = null;

        delete write._owner;
        if (!req.body.options || !req.body.options.restoreRecord){
            if (write._date_Modified) delete write._date_Modified;
            if (write._date_Created ) delete write._date_Created;
        }
        if (req.body.options && req.body.options.updateRecord && !req.body.options.restoreRecord) {
            reserved_field_name_list.forEach(function (aReservedField) {
                if (write[aReservedField] ) delete write[aReservedField];
            } )
        }


        //onsole.log("-- write ",write)
        function app_auth(message) {return helpers.auth_failure("app_handler", exports.version, "putData", message);}
        
    // Set collection_name and data_model
    
    async.waterfall([
    // 0. get app config
        function (cb) {
            file_handler.async_app_config(req.params.app_name, req.freezr_environment,cb);
        },
    // 1. make sure all data exits
        function (got_app_config, cb) {
            app_config = got_app_config;

            if (fileParams.is_attached) {
                if (req.params.collection) flags.add('warnings','collectionNameWithFiles',{'collection_name':collection_name});
                if (data_object_id) flags.add('warnings','dataObjectIdSentWithFiles');
                collection_name = "files";
                data_model = (app_config && app_config.files)? app_config.files: null;
            } else if (req.params.collection == "files" && req.body.options && req.body.options.updateRecord){
                collection_name = "files";
                data_model = (app_config && app_config.files)? app_config.files: null;
            } else {
                collection_name  = req.params.collection? req.params.collection.replace(".json",""): null;
                data_model= (app_config && app_config.collections && collection_name && app_config.collections[collection_name])? app_config.collections[collection_name]: null;
            }

            if (!req.session.logged_in_user_id) {
                cb(helpers.auth_failure("app_handler", exports.version, "putData", req.params.app_name, "Need to be logged in to access app"));
            } else if (!collection_name) { 
                cb(app_err("Missing collection name"));
            } else if (!newObjectFieldNamesAreValid(req,data_model)) {
                cb(app_err("invalid field names"));
            } else if (fileParams.is_attached && data_model && data_model.do_not_allow) {
                cb(app_err("config doesnt allow file uploads."));
            } else if (!fileParams.is_attached && Object.keys(req.body.data).length<=0 ) {
                cb(app_err("Missing data parameters."));
            } else if (!fileParams.is_attached && Object.keys(req.body.data).length<=0 ) {
                cb(app_err("Missing data parameters."));               
            } else if (helpers.system_apps.indexOf(req.params.app_name)>-1 || 
                !collectionIsValid(collection_name,app_config,fileParams.is_attached)){
                // check for exception of 
                //onsole.log(collection_name,req.params.app_name,req.body.options.restoreRecord)
                if (collection_name=="accessible_objects" && req.params.app_name=="info.freezr.permissions" && req.body.options.restoreRecord && req.body.options.password) {
                    freezr_db.user_by_user_id(req.session.logged_in_user_id, function (err, user_json) {
                        if (err) {
                            cb(err)
                        } else {
                            var u = new User(user_json);
                            if (u.check_passwordSync(req.body.options.password)) {
                                cb(null)
                            } else {
                                cb(helpers.auth_failure("app_handler", exports.version, "putData", req.params.app_name, "Cannot upload to accessible_objects without a password"));
                            }
                        }
                    })
                } else if (helpers.system_apps.indexOf(req.params.app_name)>-1 ){
                    cb(helpers.invalid_data("app name not allowed: "+req.params.app_name, "account_handler", exports.version, "add_uploaded_app_zip_file"));
                } else {
                    cb(app_err("Collection name "+collection_name+"is invalid."));
                }
            } else {
                cb(null);
            }
        },

    // 2. checkapp code (make sure the right app is sending data) and device_code (to make sure rights exist)
        function (cb) {
            freezr_db.check_app_code(req.session.logged_in_user_id, req.params.app_name, req.params.source_app_code, cb)
        },
        function (cb) {
            freezr_db.check_device_code_specific_session(req.session.device_code, req.session.logged_in_user_id, req.params.app_name, cb)
        },

    // 3. get data_object_id (if needed to be set manually) 
    //     and if file: error check and write file  
        function(cb) {
            if (fileParams.is_attached) {
                fileParams.dir = (req.body.options && req.body.options.targetFolder)?req.body.options.targetFolder : "";
                data_object_id = file_handler.removeStartAndEndSlashes(req.session.logged_in_user_id+"/"+file_handler.removeStartAndEndSlashes(""+fileParams.dir));
                fileParams.dir = file_handler.normUrl(file_handler.removeStartAndEndSlashes("userfiles/"+req.session.logged_in_user_id+"/"+req.params.app_name+"/"+file_handler.removeStartAndEndSlashes(""+fileParams.dir)) );
                fileParams.name = ( req.body.options && req.body.options.fileName)?req.body.options.fileName : req.file.originalname; 

                if (!helpers.valid_filename(fileParams.name) ) {
                    cb(app_err("Invalid file name"));
                } else if (data_model && data_model.allowed_file_types && data_model.allowed_file_types.length>0 && data_model.allowed_file_types.indexOf(file_handler.fileExt(fileParams.name))<0 ){
                    cb(app_err("invalid file type"));
                } else if (!file_handler.valid_path_extension(fileParams.dir)) {
                    cb(app_err("invalid folder name"));
                } else {
                    data_object_id = data_object_id+"/"+fileParams.name;
                    file_handler.writeUserFile(fileParams.dir, fileParams.name, req.body.options, data_model, req, cb);       
                }
            } else if ((!req.body.options || !req.body.options.updateRecord) && (!data_model || !data_model.make_data_id || (!data_model.make_data_id.from_field_names && !data_model.make_data_id.manual))) {
                delete write._id;
                cb(null, null);
            } else if (req.body.options.updateRecord) { 
                if (req.body.options.KeepUpdateIds){
                    cb(null, null);
                } else {
                    delete write._id;
                    cb(null, null);
                }
            } else if (data_model && data_model.make_data_id && data_model.make_data_id.manual) {
                if (write._id) {
                    cb(null, null);
                } else {
                    console.log("write error for "+data_object_id)
                    console.log(write)
                    cb(app_err("object id is set to manual but is missing"));
                }
            // then is must be make_data_id.from_field_names...
            } else if  (data_model && data_model.make_data_id && (!data_model.make_data_id.reference_field_names || !(data_model.make_data_id.reference_field_names instanceof Array) || data_model.make_data_id.reference_field_names.length==0) ){
                cb(app_err("object id reference field_names but none are included"));
            } else { 
                var err = null;
                try {
                    data_object_id = unique_id_from(data_model.make_data_id.reference_field_names, req.body.data, req.session.logged_in_user_id);
                } catch (e) {
                    err=e; 
                }
                if (err) {cb(app_err("Could not set object_id - "+err));} else {cb(null);}
            }
        },

    // 4. get collection, set real_object_id and get existing object (if it exists).
        function (new_file_name, cb) {
            if (fileParams.is_attached && new_file_name != fileParams.name) {
                var last =  data_object_id.lastIndexOf(fileParams.name);
                if (last>0) {
                    data_object_id = data_object_id.substring(0,last)+new_file_name;
                } else {
                    console.log("SNBH - no file name in obejct id")
                }
            }
            //onsole.log('todo recheck filename change here and record', new_file_name,collection_name,req.params.app_name.replace(/\./g,"_"))
            freezr_db.app_db_collection_get(req.params.app_name.replace(/\./g,"_"), collection_name, cb);
        },
        function (theCollection, cb) {
            dbCollection = theCollection;
            if (!data_object_id) {
                cb(null, null);
            } else {
                real_object_id = freezr_db.real_id(data_object_id,app_config,collection_name);
                dbCollection.find({ _id: real_object_id }).toArray(cb);
            }
        },

    // 5. write or update the results
        function (results, cb) {
            //onsole.log("Going to write id "+data_object_id+((results && results.length>0)? "item exists": "new item"));
            //onsole.log("results of finding ",results)
            //onsole.log("data_model ",JSON.stringify(data_model))
                write._owner = req.session.logged_in_user_id; 
                if (!req.body.options || !req.body.options.restoreRecord || !write._date_Modified) write._date_Modified =  0 + (new Date().getTime() );
                
                if (fileParams.is_attached) {write._folder = (req.body.options && req.body.options.targetFolder)? file_handler.removeStartAndEndSlashes(req.body.options.targetFolder):"/";}

                // set confirm_return_fields
                    var return_fields_list = (req.body.options && req.body.options.confirm_return_fields)? req.body.options.confirm_return_fields: ['_id'];
                    for (var i =0; i<return_fields_list.length; i++) {
                        if ((typeof return_fields_list[i] == "string")  && 
                            write[return_fields_list[i]]) {
                            returned_confirm_fields[return_fields_list[i]] = write[return_fields_list[i]];
                        }
                        if (data_object_id) {returned_confirm_fields._id = data_object_id};
                    }
            

            if ((results == null || results.length == 0) && req.body.options && req.body.options.updateRecord && !req.body.options.restoreRecord && (!data_model || !data_model.make_data_id || !data_model.make_data_id.manual) ){
                cb(helpers.rec_missing_error(exports.version, "putData", req.params.app_name, "Document not found. (updateRecord with no record) for record "))
            } else if ( (results == null || results.length == 0) ) { // new document
                write._date_Created = new Date().getTime();
                if (data_object_id) {write._id = real_object_id;}; // it is not manual
                //onsole.log("writing ",write)
                if ((req.body.options && req.body.options.fileOverWrite) && fileParams.is_attached) flags.add('warnings','fileRecordExistsWithNoFile');
                dbCollection.insert(write, { w: 1, safe: true }, cb);
            } else if (results.length == 1 && fileParams.is_attached && (req.body.options && req.body.options.fileOverWrite) && results[0]._owner == req.session.logged_in_user_id) { // file data being updated
                dbCollection.update({_id: real_object_id },
                    {$set: write}, {safe: true }, cb);
            } else if (results.length == 1 
                        && req.body.options && (req.body.options.KeepUpdateIds || req.body.options.updateRecord || (data_model && data_model.make_data_id && data_model.make_data_id.manual)) && results[0]._owner == req.session.logged_in_user_id) { // document update
                //todo: have option of overwriting all? dbCollection.update({ _id: real_object_id }, ie write, {safe: true }, cb);
                final_object = results[0];
                isAccessibleObject = (final_object._accessible_By && final_object._accessible_By.groups && final_object._accessible_By.groups.length>0);
                returned_confirm_fields._updatedRecord=true;
                dbCollection.update({ _id: real_object_id },
                    {$set: write}, {safe: true }, cb);                
            } else if (results[0]._owner != req.session.logged_in_user_id) {
                cb(helpers.auth_failure("app_handler", exports.version, "putData", req.params.app_name, "Cannot write to another user's record"));
            } else if (results.length == 1) {
                cb(app_err("data object ("+data_object_id+") already exists. Set updateRecord to true in options to update a document, or fileOverWrite to true when uploading files."));
            } else {
                cb(app_err("Multiple Objects retrieved - SNBH"));
            }
        },

        //if it is an accessible object then update the accessible_object record too
        // get permission db
        function(final_object_list, cb) {
            //onsole.log({final_object_list})
            final_object = (final_object || ((final_object_list && final_object_list.ops && final_object_list.ops.length>0)? final_object_list.ops[0]:null));
            if (!isAccessibleObject) {
                cb(null, cb)
            } else {               
                freezr_db.app_db_collection_get("info_freezr_permissions" , "accessible_objects", cb);
            }
        }, 
        
        function (theCollection, cb) {
            if (!isAccessibleObject) {
                cb(null, cb)
            } else{
                accessibles_db = theCollection;
                // _accessible_By: {groups: ['public'], users:[], group_perms:{"public":["requestor_app1/perm1","requestor_app1/perm2"], user_perms:{someone:["requestor_app3/perm2"]} }

                //onsole.log(final_object._accessible_By)

                if (final_object._accessible_By.group_perms.public) { // todo? also do for non public?
                    async.forEach(final_object._accessible_By.group_perms.public, function (requestorapp_permname, cb2) {
                        var acc_id = req.session.logged_in_user_id+"/"+requestorapp_permname+"/"+req.params.app_name+"/"+collection_name+"/"+data_object_id;
                        //onsole.log("getting acc_id "+acc_id)
                        accessibles_db.find({"_id":acc_id}).toArray(function(err, results) {
                            if (!results || results.length==0) {
                                flags.add('warnings', "missing_accessible", {"_id":acc_id, "msg":"permission does not exist - may have been removed - should remove public"});
                                cb2(null);
                            }  else if (!results.length>1) {
                                flags.add('warnings', "too_many_accessibles", {"_id":acc_id, "msg":"internal error - more than one permission retrieved"});
                                cb2(null);
                            } else {
                                permission_object = results[0];
                                permission_object.data_object = {}; 
                                var requestorApp = requestorapp_permname.split("/")[0];
                                
                                file_handler.async_app_config(requestorApp, req.freezr_environment, function(err, requestorAppConfig){
                                    if (err) {
                                        console.log("Error getting requestorAppConfig - todo - consider issuing flad rather than error")
                                        cb(helpers.state_error("app_handler.js", exports.version, "putData", err, "Could not get requestor app config"));
                                    } else {
                                        var permission_name = requestorapp_permname.split("/")[1];
                                        var permission_model= (requestorAppConfig && requestorAppConfig.permissions && requestorAppConfig.permissions[permission_name])? requestorAppConfig.permissions[permission_name]: null;
                                        if (requestorAppConfig && permission_name && permission_model){
                                            if (permission_model.return_fields){ 
                                                for (var i=0; i<permission_model.return_fields.length; i++) {
                                                    permission_object.data_object[permission_model.return_fields[i]] =  write[permission_model.return_fields[i]];
                                                }
                                            } else {
                                                permission_object.data_object = write;
                                            }
                                            delete permission_object._id
                                            accessibles_db.update({ _id: results[0]._id }, {$set : permission_object}, {safe: true }, cb2);
                                        } else {
                                            flags.add('warnings', "app_config_error", {"_id":acc_id, "msg":"no "+(requestorAppConfig?"app_config":("permission_name or model for "+permission_name))});
                                            cb2(null);
                                        }
                                    }
                                })
                            }
                        });
                    },
                    function (err) {
                        console.log({flags})
                        if (err) {
                            flags.add('warnings',"unkown_error_accessibles", err);
                        } 
                        cb(null)
                    })
                } else { cb(null)}
            }
        }
    ], 
    function (err) {
        if (err) {
            helpers.send_failure(res, err, "app_handler", exports.version, "putData");
        } else {            
            //onsole.log({final_object})
            if (final_object && final_object._id) returned_confirm_fields._id = final_object._id; // new document
            if (final_object && final_object._date_Created) returned_confirm_fields._date_Created = final_object._date_Created;
            helpers.send_success(res, {'success':true, 'confirmed_fields':returned_confirm_fields, 'duplicated_file':fileParams.duplicated_file, 'flags':flags});
        }
    });
}
exports.getDataObject= function(req, res) {
    //app.get('/v1/db/getbyid/:permission_name/:collection_name/:requestor_app/:source_app_code/:requestee_app/:data_object_id', app_handler.getDataObject); // here request type must be "one"
    //app.get('/v1/userfiles/:permission_name/:collection_name/:requestor_app/:source_app_code/:requestee_app/:user_id/*', app_handler.getDataObject);

    // Initialize variables
        var request_file = helpers.startsWith(req.path,"/v1/userfiles") ;
        var requestedFolder, parts, resulting_record = null, app_permission, data_object_id, data_record;
        if (request_file) {
            parts = req.originalUrl.split('/');
            parts.splice(0,9,"userfiles",parts[8],parts[7]);
            requestedFolder = parts.length==6? "/": (parts.slice(4,parts.length-1)).join("/");
            data_object_id = req.params.user_id+"/"+unescape(parts.slice(3).join("/"));
        } else {
            data_object_id = req.params.data_object_id;
        }
        if(!req.params.user_id) req.params.user_id = req.session.logged_in_user_id; 

        var app_config, permission_model, permission_type, collection_name, own_record, accessibles_collection_name;

        var record_is_permitted = false;
        var flags = new Flags({'app_name':req.params.requestor_app});

        function app_err(message) {return helpers.app_data_error(exports.version, "getDataObject", req.params.app_name, message);}
        function app_auth(message) {return helpers.auth_failure("app_handler", exports.version, "getDataObject", message);}
        //onsole.log("getDataObject "+data_object_id+" from coll "+collection_name);

    async.waterfall([
    // 0. get app config
        function (cb) {
            file_handler.async_app_config(req.params.requestor_app, req.freezr_environment,cb);
        },
    // 1. make sure all data exits
        function (got_app_config, cb) {

            app_config = got_app_config;
            permission_model= (app_config && app_config.permissions && app_config.permissions[req.params.permission_name])? app_config.permissions[req.params.permission_name]: null;
            permission_type = (permission_model && permission_model && permission_model.type)? permission_model.type: null;

            collection_name = req.params.collection_name?  req.params.collection_name: (permission_model.collection? permission_model.collection :  ( (permission_model.collections && permission_model.collections.length>0)? permission_model.collections[0]: null ) ) 

            own_record = (req.params.requestor_app == req.params.requestee_app  && (!request_file || (req.session.logged_in_user_id == req.params.user_id) ) );
            accessibles_collection_name = permission_type=="field_delegate"? "field_permissions": null;

            console.log("requestor_app")
            console.log(req.params.requestor_app)
            console.log("requestee_app")
            console.log(req.params.requestee_app)

            if (!req.session || !req.session.logged_in || !req.session.logged_in_user_id) {
                cb(app_auth("Need to be logged in to access app"));
            } else if (!data_object_id){
                cb(app_err("missing data_object_id"));
            } else if (req.params.requestor_app == "info.freezr.admin" || req.params.requestee_app == "info.freezr.admin") {
                // NB this should be redundant but adding it in any case
                cb(app_auth("Should not access admin db via this interface"));
            } else if (own_record && request_file) {
                cb(null); // no need to check for other issues - just app code
            } else if (!app_config){
                cb(app_err("missing app_config"));
            } else if (!own_record && !permission_model){
                cb(app_err("missing permission"));
            } else if (!own_record && !permission_type){
                cb(app_err("missing permission type"));
            } else if (!own_record && helpers.permitted_types.type_names.indexOf(permission_type)<0 && permission_type!="db_query") {
                cb(app_err("invalid permission type"));
            } else {
                cb(null);
            }
        },

        // 2. checkapp code (make sure the right app is sending data) and device_code (to make sure rights exist)
        function (cb) {
            freezr_db.check_app_code(req.session.logged_in_user_id, req.params.requestor_app, req.params.source_app_code, cb)
        },
        function (cb) {
            freezr_db.check_device_code_specific_session(req.session.device_code, req.session.logged_in_user_id, req.params.requestor_app, cb)
        },

        // 3. open app db
        function (cb) {
            if (own_record && request_file) {    
                record_is_permitted = true;
            } 
            freezr_db.app_db_collection_get(req.params.requestee_app.replace(/\./g,"_") , collection_name, cb);
        },

        // 4. get the record (unless you are getting a file)
        function (theCollection, cb) {
            var real_object_id = freezr_db.real_id(data_object_id,app_config,collection_name);
            theCollection.find({'_id':real_object_id}).toArray(cb);
        },

        // 5. check if record fits criteria and return it if it belongs to the logged in user (own_record)
        function (results, cb) {
            if (!results || results.length==0) {
                cb(app_err("no related records"))
            } else {
                if (results.length>1) {
                    console.log('MoreThanOneRecordRetrieved - SNBH')
                    flags.add('warnings','MoreThanOneRecordRetrieved - SNBH');
                }

                if (!own_record && !request_file && permission_model.return_fields && permission_model.return_fields.length>0) {
                    resulting_record = {};
                    for (var i=0; i<permission_model.return_fields.length; i++) {
                        resulting_record[permission_model.return_fields[i]] =  results[0][permission_model.return_fields[i]];
                    }
                } else {
                    resulting_record = results[0];
                }

                if (own_record) {
                    record_is_permitted = true;
                    cb({"success":true}, null)
                } else {
                    // check _accessible... if object_delegate
                                        // CHECK ALL console todo now

                    var have_access  = false
                    var correct_access = false
                    var perm_string = req.params.requestee_app+"/"+req.params.permission_name

                    var loggedInAccess = (resulting_record._accessible_By && resulting_record._accessible_By.group_perms && resulting_record._accessible_By.group_perms.logged_in)? resulting_record._accessible_By.group_perms.logged_in: null;
                    if (loggedInAccess && loggedInAccess.length>0 && req.session.logged_in) {
                        // could also check _accessible_By.groups -> logged_in
                        have_access = true;
                        if (loggedInAccess.indexOf(perm_string) > -1 )  correct_access=true
                    }

                    var publicAccess = (resulting_record._accessible_By && resulting_record._accessible_By.group_perms && resulting_record._accessible_By.group_perms.public)? resulting_record._accessible_By.group_perms.public : null;
                    if (publicAccess && publicAccess.length>0) {
                        // could also check _accessible_By.groups -> public
                        have_access = true;
                        if (publicAccess.indexOf(perm_string) > -1 )  correct_access=true
                    }

                    var userAccess = (resulting_record._accessible_By && resulting_record._accessible_By.user_perms && resulting_record._accessible_By.user_perms[req.session.logged_in_user_id])? resulting_record._accessible_By.user_perms[req.session.logged_in_user_id] : null;
                    if (userAccess && userAccess.length>0) {
                        // could also check _accessible_By.users 
                        have_access = true;
                        if (userAccess.indexOf(perm_string) > -1 )  correct_access=true
                    }

                    if (!correct_access) flags.add('warnings','Access granted but not for this permission');
                    if (have_access) {
                        cb(null);
                    } else {
                        cb(app_auth("access to object not granted"));
                    }
                }
            }
        },

        // 6. get app permissions and if granted, open field_permissions or object_permission collection 
        function(cb) {
            freezr_db.permission_by_owner_and_permissionName (req.params.user_id, req.params.requestor_app, req.params.requestee_app, req.params.permission_name, cb)
        },
        function (results, cb) {
            if (!results || results.length==0) {
                cb(app_auth("permission does not exist"));
            }  else if (!results[0].granted) {
                cb(app_auth("permission not granted"));
            }  else {
                app_permission = results[0];
                if (accessibles_collection_name) { // ie field permissins
                    freezr_db.app_db_collection_get("info_freezr_permissions" , accessibles_collection_name, cb);
                } else {
                    record_is_permitted = true;
                    cb({"success":true}, null)
                }
            }
        },
        // 7 Find right permisssion attributes to see if they are granted and consistent with app permission
        // Note: ALL this needs  to be revieweed and updated for field permissions
        function (theCollection, cb) {
            var permission_collection = theCollection;
            var permission_attributes = {
                'requestor_app':req.params.requestor_app,
                'requestee_app':req.params.requestee_app,
                '_owner': req.params.user_id,
                'permission_name':req.params.permission_name,
                '$or': [{'shared_with_group':'logged_in'},{'shared_with_group':'public'},{'shared_with_user': req.session.logged_in_user_id} ] 
            }
            if (accessibles_collection_name == "field_permissions") {
                // no extra conditions
                permission_collection.find(permission_attributes).toArray(cb);
            } else {
                cb(null, null)
            }            
        },
        function (all_permissions, cb) {
            if (own_record) {
                cb(null);
            } else  if (permission_type == "folder_delegate") {
                // go through all directories permitted and see if file is permitted
                var sharable_folder, folder_delegate_perm_granted = false, app_perm_granted = false;
                for (var i= 0; i<app_permission.sharable_folders.length; i++) {
                    sharable_folder = file_handler.removeStartAndEndSlashes(app_permission.sharable_folders[i]);
                    if (helpers.startsWith(requestedFolder, sharable_folder)) {
                        // app_perm_granted - permitted due to field perm app_permission.sharable_folders[i]
                        app_perm_granted = true;
                    }
                }
                if (app_perm_granted) {
                    record_is_permitted = true;
                    cb(null);
                } else {
                    cb(app_auth("app permission granted does not correspond to request"));
                }
            } else if (all_permissions == null || all_permissions.length == 0) {
                cb(app_auth("no permission")); 
            } else if (permission_type=="object_delegate") {
                // note that it is possible for multiple permissions to have been given the "or" in the query allowing one for groups and one for users.. but it doesnt really matter because it is allowed in any case
                if (app_permission.collections.indexOf(collection_name)<0) {
                    cb(app_auth("permission doesnt allow specified collection"))
                } else {
                    record_is_permitted = true;
                    cb(null);
                }
            } else if (permission_type == "field_delegate") {
                for (var i= 0; i<all_permissions.length; i++) {
                    if (permission_model.sharable_fields.indexOf(all_permissions[i].field_name) >= 0 && app_permission.sharable_fields.indexOf(all_permissions[i].field_name) >= 0 && resulting_record[all_permissions[i].field_name] == all_permissions[i].field_value) {
                        // record is permitted due to field perm: all_permissions[i]
                        record_is_permitted = true;
                    }
                }
                cb(null);
            } else {
                record_is_permitted = false;
                cb(app_err("Wrong permission type - SNBH"));
            }
        }
    ], 
    function (err) {
        //onsole.log("got to end of getDataObject");
        if (!record_is_permitted) {
            if (request_file){
                res.sendStatus(401);
            } else {
                helpers.send_failure(res, err, "app_handler", exports.version, "getDataObject");
            }
        } else if (request_file){
            //onsole.log("sending getDataObject "+__dirname.replace("/freezr_system","/") + unescape(parts.join('/')));
            if (flags.warnings) console.log("flags:",flags)
            file_handler.sendUserFile(res, unescape(parts.join('/')), req.freezr_environment );
        } else {
            //onsole.log("sending record:"+JSON.stringify(resulting_record));
            helpers.send_success(res, {'results':resulting_record, 'flags':flags});
        }
    });
}
exports.db_query = function (req, res){
    helpers.log (req,"db_query: "+req.url)
    //app.post('/v1/db/query/:requestor_app/:source_app_code/:requestee_app', userDataAccessRights, app_hdlr.db_query); 
    //app.post('/v1/db/query/:requestor_app/:source_app_code/:requestee_app/:permission_name', userDataAccessRights, app_hdlr.db_query); 
    // req.body.onlyOthers excludes own records
    // todo - Simplify so that if ownrecord, just looks up the db and if not, then returns the data_record in the accessibles_db. (Figure out what to do in case of field and folder permissions - potentially separate into separate functions)

    console.log("db_query from: "+req.params.requestor_app+" - "); // +JSON.stringify(req.body)

    var appDb = {}, dbCollection, accessibles_collection, objectsPermittedList=[];
    var usersWhoGrantedFieldPermission = (req.params.requestee_app == req.params.requestor_app)? [{'_owner':req.session.logged_in_user_id}]: []; // if requestor is same as requestee then user is automatically included
    var usersWhoGrantedAppPermission = (!req.body.onlyOthers && req.params.requestee_app == req.params.requestor_app)? [{'_owner':req.session.logged_in_user_id}]: []; // if requestor is same as requestee then user is automatically included
    


    var app_config, app_config_permission_schema, accessibles_collection_name, permission_attributes, own_record;

    // get permissions and get list of users who granted okay and check field name is right
    // get field permissions and check again

    function app_err(message) {return helpers.app_data_error(exports.version, "db_query", req.params.requestor_app, message);}
    function app_auth_err(message) {return helpers.auth_failure("app_handler", exports.version, "db_query", message+" "+req.params.requestor_app);}

    async.waterfall([
        // 0 get app config
        function (cb) {
            file_handler.async_app_config(req.params.requestee_app, req.freezr_environment,cb);
        },
        // 1. Check all data needed exists 
        function (the_app_config, cb) {
            app_config = the_app_config;

            app_config_permission_schema = (app_config && app_config.permissions)? app_config.permissions[req.params.permission_name]: null;
            
            accessibles_collection_name = (app_config_permission_schema && app_config_permission_schema.type=="field_delegate")? "field_permissions": null;
                // to be used for field / folder permission
            permission_attributes = { 
                'requestor_app': req.params.requestor_app,
                'requestee_app': ((app_config_permission_schema && app_config_permission_schema.requestee_app)? app_config_permission_schema.requestee_app: req.params.requestee_app),
                'permission_name': req.params.permission_name,
                'granted':true
                // field_value - to be assigned
            };

            own_record = (!req.params.permission_name && req.params.requestor_app==permission_attributes.requestee_app)
            // if no permission name is given, then it is one's own records, otehr wise returns shared items
            
            //onsole.log("own_record",own_record," req.params.requestor_app",req.params.requestor_app," permission_attributes.requestee_app",permission_attributes.requestee_app," req.params.permission_name",req.params.permission_name)
            
            if (!req.session.logged_in_user_id) {
                cb(app_auth_err("Need to be logged in to access app"));
            } else if (!req.params.permission_name && !own_record) {
                cb(app_err("Missing permission_name"));
            } else if (req.params.requestor_app == "info.freezr.admin" || req.params.requestee_app == "info.freezr.admin") {
                // NB this should be redundant but adding it in any case
                cb(app_auth_err("Should not access admin db via this interface"));
            } else if (own_record) {
                cb(null)
            } else if (!app_config || !app_config_permission_schema){
                cb(app_err("Missing app_config && permission_schema"));
            } else  {
                if (app_config_permission_schema.type=="folder_delegate") {
                    permission_attributes.field_name = "_folder";
                    if (!app_config_permission_schema.sharable_folders || app_config_permission_schema.sharable_folders.length==0) {
                        cb(app_err("No folders have been specified in app config"));
                    } else {
                        permission_attributes.field_value = req.body.field_value? req.body.field_value :app_config_permission_schema.sharable_folders[0];
                        cb(null);
                    }
                } else if (app_config_permission_schema.type=="field_delegate") {
                    permission_attributes.field_name = req.body.field_name;
                    permission_attributes.field_value = req.body.field_value;
                    if (!req.body.field_name && app_config_permission_schema.sharable_fields && app_config_permission_schema.sharable_fields.length>0) {
                        permission_attributes.field_name = app_config_permission_schema.sharable_fields[0];
                    }
                    if (!permission_attributes.field_name) {
                        cb(app_err("missing ield name in app config"));
                    } else if (!permission_attributes.field_value){
                        cb(app_err("missing field value"));
                    }  else {
                        cb(null);
                    }  
                } else { // types are db_query or object_delegate
                    cb(null);
                }
                          
            }
        },

        // 2. checkapp code (make sure the right app is sending data) and device_code (to make sure rights exist)
        function (cb) {
            if (req.params.skipappcodecheck) {
                cb(null)
            } else {
                freezr_db.check_app_code(req.session.logged_in_user_id, req.params.requestor_app, req.params.source_app_code, cb)
            }
        },
        function (cb) {
            if (req.params.skipappcodecheck) {
                cb(null)
            } else {
                freezr_db.check_device_code_specific_session(req.session.device_code, req.session.logged_in_user_id, req.params.requestor_app, cb)
            }
        },

        // 3. Get app permission
        function (cb) {
            if (own_record) {
                cb(null, []);
            } else {
                freezr_db.all_granted_app_permissions_by_name(req.params.requestor_app, permission_attributes.requestee_app, req.params.permission_name, null , cb) 
            }
        },

        // 4. Recheck that have given the required permission and add to usersWhoGrantedAppPermission list
        function (allUserPermissions, cb) {
            if (allUserPermissions && allUserPermissions.length>0) {
                for (var i=0; i<allUserPermissions.length; i++) {
                    if (  (allUserPermissions[i].sharable_groups && allUserPermissions[i].sharable_groups.indexOf("logged_in")>-1 && req.session.logged_in_user_id)
                          ||
                          (allUserPermissions[i].sharable_groups && allUserPermissions[i].sharable_groups.indexOf("user")>-1 && req.session.logged_in_user_id) // currently only share with logged in users
                          ||
                          (allUserPermissions[i].sharable_groups && allUserPermissions[i].sharable_groups.indexOf("self")>-1 && allUserPermissions[i]._owner==req.session.logged_in_user_id) 
                        // todo - if statement to be pushed in freezr_db as a function... and used in other permission functions as an extra security (and everntually to allow non logged in users)
                        ) {
                            if (["field_delegate","folder_delegate"].indexOf(app_config_permission_schema.type)>=0 && freezr_db.fieldNameIsPermitted(allUserPermissions[i],app_config_permission_schema,permission_attributes.field_name) ) {
                                usersWhoGrantedAppPermission.push({'_owner':allUserPermissions[i]._owner});
                            } else if (app_config_permission_schema.type=="object_delegate" ) {
                                // todo re-added (2017) - check wh removed and security implications
                                usersWhoGrantedAppPermission.push({'_owner':allUserPermissions[i]._owner});
                            } else if (app_config_permission_schema.type=="db_query" && freezr_db.queryIsPermitted(allUserPermissions[i],app_config_permission_schema,req.body)) {
                                // Note: Currently no field permissions in db_query
                                usersWhoGrantedAppPermission.push({'_owner':allUserPermissions[i]._owner});
                            } 
                            /* else {
                                helpers.warning("app_handler - "+req.params.requestor_app, exports.version, "error? - permission changed and no longer permitted for "+allUserPermissions[i]._owner)
                            }*/
                    }
                }
            }
            if (own_record || (usersWhoGrantedAppPermission.length>0)) {
                cb(null)
            } else {
                cb(app_auth_err("No users have granted permissions for permission:"+req.params.permission_name));
            }

        },

        // 5. get accessibles collection  (to be re-implemented later - todo)
        function (cb) {
            if (accessibles_collection_name) { // ie app_config_permission_schema.type=="field_delegate" or app_config_permission_schema.type=="object_delegate"
                freezr_db.app_db_collection_get("info_freezr_permissions" , accessibles_collection_name, cb);
            } else {
                // ie for object_delegate
                cb(null, null)
            }
        },

        // 7. find field permissions (to be re-implemented later - todo)
        function (theCollection, cb) {
            accessibles_collection = theCollection;
            if (accessibles_collection_name && usersWhoGrantedAppPermission && usersWhoGrantedAppPermission.length>0){ 
                var permissionQuery = {'$and':[{'$or':usersWhoGrantedAppPermission},
                                                permission_attributes
                                                ]}
                if (app_config_permission_schema.type=="field_delegate") {
                    accessibles_collection.find(permissionQuery).toArray(cb);
                } else if (app_config_permission_schema.type=="object_delegate"){
                    var skip =  0, 
                        sort = {'_date_Modified': -1};
                    accessibles_collection.find(permissionQuery).sort(sort).skip(skip).toArray(cb);

                } else if (app_config_permission_schema.type=="db_query") {
                    if (usersWhoGrantedAppPermission.length>0) {
                        cb(null, [])
                    } else {
                        cb(app_err("no permission granted"));
                    }
                } else {
                    // shouldnt be here
                    cb(null, []);
                }
            } else if (accessibles_collection_name){
                cb(app_err("no permission granted (accessibles_collection_name)")) 
            } else { 
                // ie for object_delegate
                cb(null, []);
            }
        },

        // 8. Add owners to usersWhoGrantedFieldPermission list
        function (allUserFieldPermissions, cb) {
            if (!accessibles_collection_name) {
                usersWhoGrantedFieldPermission = usersWhoGrantedAppPermission;
            } else if (allUserFieldPermissions && allUserFieldPermissions.length>0) { //  (to be re-implemented later - todo)
                for (var i=0; i<allUserFieldPermissions.length; i++) {
                    if (app_config_permission_schema.type=="field_delegate") {
                        usersWhoGrantedFieldPermission.push({'_owner':allUserFieldPermissions[i]._owner});
                    } else if (app_config_permission_schema.type=="object_delegate") {
                        objectsPermittedList.push({'_id':freezr_db.real_id(allUserFieldPermissions[i].data_object_id,app_config,collection_name) });
                    } 
                }
            }
            if (usersWhoGrantedFieldPermission.length>1) {
                usersWhoGrantedFieldPermission = {'$or':usersWhoGrantedFieldPermission}
            } else if (usersWhoGrantedFieldPermission.length>0)  {
                usersWhoGrantedFieldPermission = usersWhoGrantedFieldPermission[0];  
            } else {
                cb(app_err("no permission granted"))
            }
            cb(null);
        },

        // 9. Open relevant collection
        function (cb) {
            var collection_name = req.body.collection? req.body.collection : (app_config_permission_schema && app_config_permission_schema.type=="folder_delegate")? "files": (app_config_permission_schema && app_config_permission_schema.collection)? app_config_permission_schema.collection:(app_config_permission_schema && app_config_permission_schema.collections)? app_config_permission_schema.collections[0]:null;
            if (own_record && !collection_name) collection_name = 'main';
            if (collection_name) {
                freezr_db.app_db_collection_get(permission_attributes.requestee_app.replace(/\./g,"_") , collection_name, cb);
            } else {
                cb(app_err("missing collection_name"));
            }
        },

        // 10. do query on collection
        function (theCollection, cb) {
            var query_params = req.body.query_params;
            if (!query_params) query_params = {};

            if (app_config_permission_schema && (app_config_permission_schema.type=="folder_delegate" || app_config_permission_schema.type=="field_delegate")) {
                query_params[permission_attributes.field_name] = permission_attributes.field_value;
            }
            
            if (!query_params || Object.keys(query_params).length==0) {
                query_params = usersWhoGrantedFieldPermission;
            } else {
                query_params = {'$and':[ usersWhoGrantedFieldPermission, query_params]};
            }
            
            if (app_config_permission_schema && app_config_permission_schema.type=="object_delegate") {
                if (!query_params.$and) query_params = {'$and':[query_params]};
                var perm_string = permission_attributes.requestee_app+"/"+permission_attributes.permission_name
                var theOrs = []
                if (app_config_permission_schema.sharable_groups && app_config_permission_schema.sharable_groups.length>0) {
                    if (app_config_permission_schema.sharable_groups.indexOf('public')>-1) theOrs.push({'_accessible_By.group_perms.public':perm_string})
                    if (app_config_permission_schema.sharable_groups.indexOf('logged_in')>-1 && req.session.logged_in_user_id) theOrs.push({'_accessible_By.group_perms.logged_in':perm_string})
                    if (app_config_permission_schema.sharable_groups.indexOf('user')>-1 && req.session.logged_in_user_id) {
                        var a_user_obj={}
                        a_user_obj['_accessible_By.user_perms.'+req.session.logged_in_user_id]=perm_string;
                        theOrs.push(a_user_obj);
                    }
                    if (!req.body.onlyOthers && req.params.requestee_app == req.params.requestor_app) theOrs.push({'_owner':req.session.logged_in_user_id})
                    
                }
                if (theOrs.length==0) {
                    cb(app_err("permission schema has no sharables"));
                } else if (theOrs.length == 1) {
                    theOrs = theOrs[0]
                } else {
                    theOrs = {'$or':theOrs}
                }
                query_params.$and.push(theOrs);
                // replace above with parameterized one
            }


            //onsole.log("permission_attributes is "+JSON.stringify(permission_attributes));
            //onsole.log("query_params is "+JSON.stringify(query_params));

            var skip = req.body.skip? parseInt(req.body.skip): 0, 
                count= req.body.count? parseInt(req.body.count):((app_config_permission_schema && app_config_permission_schema.max_count)? app_config_permission_schema.max_count: 50);
            if (app_config_permission_schema && app_config_permission_schema.max_count && count+skip>app_config_permission_schema.max_count) {count = Math.max(0,app_config_permission_schema.max_count-skip);}

            var sort = {};
            if (req.body.sort_field) {
                sort[req.body.sort_field] = req.body.sort_direction? parseInt(sort_direction):-1;
            } else if (app_config_permission_schema && app_config_permission_schema.sort_fields) {
                sort = app_config_permission_schema.sort_fields;
            } else {
                sort =  {'_date_Modified': -1}
            }
            //onsole.log("query_params for permitted fields "+JSON.stringify(query_params)+" count "+count+" skip "+skip+" sort "+JSON.stringify(sort));

            theCollection.find(query_params)
                .sort(sort)
                .limit(count)
                .skip(skip)
                .toArray(cb);

        },

        // 11. parse to send only the permitted return fields and anonimyze as necessary
        function (results, cb) {
            var returnArray = [], aReturnObject={};

            for (var i= 0; i<results.length; i++) {
                if (!app_config_permission_schema || !app_config_permission_schema.return_fields || app_config_permission_schema.return_fields.length==0) {
                    aReturnObject = results[i];
                } else {
                    aReturnObject = {};
                    for (j=0; j<app_config_permission_schema.return_fields.length;j++) {
                        aReturnObject[app_config_permission_schema.return_fields[j]] = results[i][app_config_permission_schema.return_fields[j]];
                    }
                }
                if (aReturnObject._owner && results[i].anonymously) {
                    aReturnObject._owner="_Anonymous_";
                }
                returnArray.push(aReturnObject);
            }
            cb (null, returnArray);
        }


    ], 
    function (err, results) {
        if (req.internalcallfwd){
            req.internalcallfwd(err, results)
        } else if (err) {
            console.log("err at end of db_query "+err)
            helpers.send_failure(res, err, "app_handler", exports.version, "db_query");
        } else {
            helpers.send_success(res, {'results':results});
        }
    });
}

// permission access operations
exports.setObjectAccess = function (req, res) {
    // After app-permission has been given, this sets or updates permission to access a record
    //app.put('/v1/permissions/setobjectaccess/:requestor_app/:source_app_code/:permission_name', userDataAccessRights, app_hdlr.setObjectAccess);
    //'action': 'grant' or 'deny' // default is grant
    //'data_object_id' (a string) or 'query_criteria' (an object with creteria for search) mandaory
    // can have one of:  'shared_with_group':'logged_in' or 'self' or 'public'
    // 'requestee_app': app_name (defaults to self)
    // todo this could be merged with setFieldAccess
    // note "granted" in accessible-object is redundant - should be set to false if all groups have been removed
    
    var app_config, 
        permission_model, 
        permission_type, 
        requestee_app, 
        collection_name, 
        dbCollection, 
        permission_collection,
        accessibles_object_id, 
        search_words = [],
        the_one_public_data_object = {},
        records_changed=0;
        real_object_id=null;


    var data_object_id = req.body.data_object_id? req.body.data_object_id : null;
    var query_criteria = req.body.query_criteria? req.body.query_criteria : null;
    var new_shared_with_user = req.body.shared_with_user? req.body.shared_with_user: null;
    var new_shared_with_group = new_shared_with_user? "user": (req.body.shared_with_group? req.body.shared_with_group: 'self');
    var issues = [];
    var doGrant = (!req.body.action || req.body.action == "grant")? true:false;

    var addToAccessibles =  new_shared_with_group == "public"  || (query_criteria && req.body.make_accessible);
    // currently added query_criteria to deal with multuple items, but "make_accessible" section only works with one object at a time - to be fixed / updated later (Todo later)

    console.log("setObjectAccess by "+req.session.logged_in_user_id+" for "+data_object_id+" query:"+ JSON.stringify(query_criteria)+" action"+JSON.stringify(req.body.action)+" perm: " +req.params.permission_name, " accessibles_object_id:",accessibles_object_id,"collection name: ",req.body.collection);
    
    function app_err(message) {return helpers.app_data_error(exports.version, "putData", req.params.requestor_app + "- "+message);}

    async.waterfall([
        // 0 get app config
        function (cb) {
            file_handler.async_app_config(req.params.requestor_app, req.freezr_environment,cb);
        },
        // 1. Check all data needed exists 
        function (the_app_config, cb) {
            app_config = the_app_config;

            permission_model= (app_config && app_config.permissions && app_config.permissions[req.params.permission_name])? app_config.permissions[req.params.permission_name]: null;
            permission_type = (permission_model && permission_model && permission_model.type)? permission_model.type: null;
            requestee_app = req.body.requestee_app? req.body.requestee_app: req.params.requestor_app; 
            collection_name = req.body.collection? req.body.collection: ((permission_model && permission_model.collections && permission_model.collections.length>0)? permission_model.collections[0] : null);
            accessibles_object_id = addToAccessibles? (req.session.logged_in_user_id+"/"+req.params.requestor_app+"/"+req.params.permission_name+"/"+requestee_app+"/"+collection_name+"/"+data_object_id):null;

            if (!req.session.logged_in_user_id) {
                cb(helpers.auth_failure("app_handler", exports.version, "setObjectAccess", req.params.app_name, "Need to be logged in to access app"));
            } else if (!app_config){
                cb(app_err("Missing app_config"));
            } else if (!permission_model){
                cb(app_err("Missing permission"));
            } else if (!permission_type){
                cb(app_err("Missing permission type"));
            } else if ( permission_model.sharable_groups.indexOf(new_shared_with_group) <0) {
                cb(app_err("permission group requested is not permitted "+new_shared_with_group));
            } else if (permission_type != "object_delegate"){
                cb(app_err("permission type mismatch"));
            } else if (helpers.permitted_types.groups_for_objects.indexOf(new_shared_with_group)<0 ){
                cb(app_err("invalid permission group"));
            } else if (!collection_name){
                cb(app_err("Missing collection"));
            } else if (!data_object_id && !query_criteria){
                cb(app_err("Missing data_object_id or query_criteria"));
            } else if (data_object_id && typeof data_object_id!="string"){
                cb(app_err("data_object_id must be a string"));
            } else if (query_criteria && typeof query_criteria!="object"){
                cb(app_err("query_criteria must be an object"));
            } else if (!req.body.action){
                cb(app_err("Missing action (grant or deny)"));
            } else if (req.body.action && ["grant","deny"].indexOf(req.body.action)<0 ){
                cb(app_err("invalid field permission action :"+req.body.action));
            } else {
                cb(null);
            }
        },

        // 2. checkapp code (make sure the right app is sending data) and device_code (to make sure rights exist)
        function (cb) {
            freezr_db.check_app_code(req.session.logged_in_user_id, req.params.requestor_app, req.params.source_app_code, cb)
        },
        function (cb) {
            freezr_db.check_device_code_specific_session(req.session.device_code, req.session.logged_in_user_id, req.params.requestor_app, cb)
        },

        // 3. get app permissions 
        function(cb) {
            freezr_db.permission_by_owner_and_permissionName (req.session.logged_in_user_id, req.params.requestor_app, requestee_app, req.params.permission_name, cb)
        },

        // 4. check permission is granted and can authorize requested fields, and if so, get permission collection
        function (results, cb) {
            if (!results || results.length==0) {
                cb(helpers.error("PermissionMissing","permission does not exist"))
            }  else if (!results[0].granted) {
                cb(helpers.error("PermissionNotGranted","permission not granted yet"))
            }  else if (!results[0].collections || results[0].collections.length<0)  {
                cb(app_err("No collections sited in config file"))
            }  else if (results[0].collections.indexOf(collection_name) < 0)  {
                cb(app_err("bad collection_name"))
            } else {
                freezr_db.app_db_collection_get(requestee_app.replace(/\./g,"_") , collection_name, cb);
            }
        },

        // 5. open object by id 
        function (theCollection, cb) {
            dbCollection = theCollection;
            if (data_object_id){
                real_object_id = freezr_db.real_id(data_object_id,app_config,collection_name);
                dbCollection.find({'_id':real_object_id,'_owner':req.session.logged_in_user_id}).toArray(cb);
            } else if (query_criteria) {
                query_criteria._owner = req.session.logged_in_user_id;
                dbCollection.find(query_criteria).toArray(cb);

            }
        },

        // 6. If object exists, continue and write _
        function (results, cb) {
            if (results == null || results.length == 0) {
                cb(helpers.missing_data("no such objects found"))
            } else {
                async.forEach(results, function (data_object, cb2) {
                    if (addToAccessibles && permission_model.search_fields) {
                        search_words = helpers.getUniqueWords(data_object,permission_model.search_fields)
                    }
                    
                    // nb this part only works ith one - to fix

                    if (data_object._owner != req.session.logged_in_user_id) {cb2(helpers.auth_failure("app_handler", exports.version, "setObjectAccess", req.params.app_name +  "Attempt to try and set access permissions for others"));} 

                    if (new_shared_with_group == "public") the_one_public_data_object = data_object;

                    // set _accessible_By field 
                    var accessibles = data_object._accessible_By? data_object._accessible_By:{groups:[],users:[], group_perms:{}, user_perms:{}};
                    // _accessible_By: {groups: ['public'], users:[], group_perms:{"public":["requestor_app1/perm1","requestor_app1/perm2"], user_perms:{someone:["requestor_app3/perm2"]} }
                    if (doGrant) {
                        if (accessibles.groups.indexOf(new_shared_with_group)<0 ) accessibles.groups.push(new_shared_with_group);
                        if (new_shared_with_group=="user") {
                            if (accessibles.users.indexOf(new_shared_with_user)<0 ) accessibles.users.push(new_shared_with_user);
                            if (!accessibles.user_perms[new_shared_with_user]) accessibles.user_perms[new_shared_with_user]=[];
                            if ( accessibles.user_perms[new_shared_with_user].indexOf(req.params.requestor_app+"/"+req.params.permission_name)<0) accessibles.user_perms[new_shared_with_user].push((req.params.requestor_app+"/"+req.params.permission_name));
                        } else {
                            if (!accessibles.group_perms[new_shared_with_group]) accessibles.group_perms[new_shared_with_group]=[];
                            if ( accessibles.group_perms[new_shared_with_group].indexOf(req.params.requestor_app+"/"+req.params.permission_name)<0) accessibles.group_perms[new_shared_with_group].push((req.params.requestor_app+"/"+req.params.permission_name));
                        }
                    } else { // remove grant
                        if (new_shared_with_group=="user") {
                            var permIndex = accessibles.user_perms[new_shared_with_user]? accessibles.user_perms[new_shared_with_user].indexOf(req.params.requestor_app+"/"+req.params.permission_name): (-1);
                            if ( permIndex>-1) accessibles.user_perms[new_shared_with_user].splice(permIndex,1);
                            if (accessibles.user_perms[new_shared_with_user] && accessibles.user_perms[new_shared_with_user].length>0) {
                                issues.push("Object is still accessible by other users or groups as other permissions have granted it access.")
                            } else {
                                delete accessibles.user_perms[new_shared_with_user];
                                var usrIndex = accessibles.users.indexOf(new_shared_with_user);
                                accessibles.users.splice(usrIndex,1)
                                // todo should also remove "user" from "groups" if there are no more users in user_perms
                            }
                        } else { // shared_with_group
                            if ((accessibles.group_perms[new_shared_with_group])){
                                var permIndex = accessibles.group_perms[new_shared_with_group].indexOf(req.params.requestor_app+"/"+req.params.permission_name);
                                if ( permIndex>-1) accessibles.group_perms[new_shared_with_group].splice(permIndex,1);
                            } else {
                                issues.push("Record had not been marked to me permissable, possibly due to a previous error.")
                            }
                            if (accessibles.group_perms[new_shared_with_group] && accessibles.group_perms[new_shared_with_group].length>0) {
                                issues.push("Object is still accessible by other groups as other permissions have granted it access.")
                            } else {
                                delete accessibles.group_perms[new_shared_with_group];
                                var grpIndex = accessibles.groups.indexOf(new_shared_with_group);
                                accessibles.groups.splice(grpIndex,1)
                            }
                        }
                    }
                    records_changed++;
                    dbCollection.update({ _id: data_object._id },
                        {$set: {_accessible_By:accessibles}}, {safe: true }, cb2); 
                    },
                    function (err) {
                        if (err) {
                            console.log("COULD NOT SET OBJECT ACCESS IN QUERY "+JSON.stringify(err))
                        } 
                        cb(err)
                    }
                )
            }
        },

        //7a get accessible_objects
        function (cb) {
            if (addToAccessibles) {
                freezr_db.app_db_collection_get("info_freezr_permissions" , "accessible_objects", cb);
            } else {cb(null, null)}
        },
        // 7b. oand write to it
        function (theCollection, cb) {
            if (addToAccessibles) {
                accessibles_collection = theCollection;
                accessibles_collection.find({_id:accessibles_object_id}).toArray(cb)
            } else {cb(null, null)}
        },

        // 9. write or update the results
        function (results, cb) {
            if (addToAccessibles) {
                if (results == null || results.length == 0) {
                    //  accessibles_object_id was req.session.logged_in_user_id+"/"+req.params.requestor_app+"/"+req.params.permission_name+"/"+requestee_app+"/"+collection_name+"/"+data_object_id;
                    var accessibles_object = {   
                        'requestee_app':requestee_app,
                        '_owner':req.session.logged_in_user_id,
                        'data_object_id': data_object_id,
                        'permission_name':req.params.permission_name,
                        'requestor_app':req.params.requestor_app,
                        'collection_name': collection_name,
                        'shared_with_group':[new_shared_with_group],
                        'shared_with_user':[new_shared_with_user],
                        '_date_Modified' : new Date().getTime(),
                        '_date_Created' : new Date().getTime(),
                        'data_object' : the_one_public_data_object,
                        'search_words' : search_words,
                        'granted':doGrant,

                        '_id':accessibles_object_id
                        }
                    if (!doGrant) {
                        app_err("cannot remove a permission that doesnt exist");
                        cb(null); // Internal error which can be ignored as non-existant permission was being removed
                    } else { // write new permission
                        //onsole.log("writing new ",accessibles_object)
                        accessibles_collection.insert(accessibles_object, { w: 1, safe: true }, cb);
                    }
                } else if (results.length == 1) { // update existing perm
                    var write = {};
                    if (doGrant) {
                        write.granted=true;
                        write.shared_with_group = helpers.addToListAsUnique(results[0].shared_with_group,new_shared_with_group);
                        if (new_shared_with_group=="user") write.shared_with_user = helpers.addToListAsUnique(results[0].shared_with_user,new_shared_with_user);
                    } else if (!doGrant) {
                        if (new_shared_with_group=="user" && results[0].shared_with_user.indexOf(new_shared_with_user)>-1) 
                        if ( (new_shared_with_group=="user" && (!results[0].shared_with_user || results[0].shared_with_user.length==0 ) && results[0].indexOf("user")>-1)
                            || results[0].indexOf(new_shared_with_group)>-1) {
                            write.shared_with_group = results[0].shared_with_group;
                            write.shared_with_group.splice(results[0].indexOf(new_shared_with_group),1);
                        }
                        write.granted = ( (write.shared_with_group && write.shared_with_group.length>0) ) ;
                    } 
                    write._date_Modified = new Date().getTime();
                    write.data_object = the_one_public_data_object;
                    write.search_words = search_words;
                    accessibles_collection.update({ _id: accessibles_object_id }, {$set : write}, {safe: true }, cb);
                } else {
                    cb(app_err("Can not update multiple objects retrieved - SNBH"));
                }
            } else {cb(null, null)}
        }
    ], 
    function (err, results) {
        if (err) {
            console.log(err)
            helpers.send_failure(res, err, "app_handler", exports.version, "setObjectAccess");
        } else { // sending back data_object_id
            helpers.send_success(res, {'data_object_id':data_object_id, 'accessibles_object_id':accessibles_object_id, 'grant':doGrant,'issues':issues, 'query_criteria':query_criteria, 'records_changed':records_changed});
        }
    });
}

// developer utilities
    exports.getConfig = function (req, res){
        //app.get(''/v1/developer/config/:app_name/:source_app_code'

        var app_config, collection_names = null;

        function app_err(message) {return helpers.app_data_error(exports.version, "getConfig", req.params.app_name + " - " + message);}
        
        async.waterfall([
            // 0. get app config
            function (cb) {
                file_handler.async_app_config(req.params.app_name, req.freezr_environment,cb);
            },
            // 1. make sure all data exits
            function (got_app_config, cb) {
                app_config = got_app_config;
                if (!req.session.logged_in_user_id) {
                    cb(helpers.auth_failure("app_handler", exports.version, "getConfig", req.params.app_name +  " Need to be logged in to access app"));
                } else {
                    cb(null);
                }
            },

            // 2. checkapp code (make sure the right app is sending data) and device_code (to make sure rights exist)
            function (cb) {
                freezr_db.check_app_code(req.session.logged_in_user_id, req.params.app_name, req.params.source_app_code, cb)
            },
            function (cb) {
                freezr_db.check_device_code_specific_session(req.session.device_code, req.session.logged_in_user_id, req.params.app_name, cb)
            },

            // 3. open database connection & get collections
            function (cb) {
                freezr_db.getAllCollectionNames(req.params.app_name.replace(/\./g,"_"), cb);
            },

            // 4. keep names
            function (names, cb) {
                collection_names = names;
                cb(null)
            },

        ], 
        function (err) {
            if (err) {
                helpers.send_failure(res, err, "app_handler", exports.version, "getConfig");
            } else {
                helpers.send_success(res, {'app_config':app_config, 'collection_names':collection_names});
            }
        });
    }
    exports.updateFileList = function (req, res){
        //app.get('/v1/developer/fileListUpdate/:app_name/:source_app_code/:folder_name', userDataAccessRights, app_hdlr.updateFileList);
        // Note: Currently ignores files within directories - ie doesnt iterate
        // todo - note - functionality not tested

        console.log("=======================================")
        console.log("updateFileList NEEDS TO BE REDONE!!!!!")
        console.log("=======================================")

        //onsole.log("got to updateFileDb request for body"+JSON.stringify(req.body)); 

        /*

        var app_config = file_handler.get app config(req.params.app_name);
        var flags = new Flags({'app_name':req.params.app_name}, {'collection_name':'files'});

        var collection_name = "files";
        var data_model = (app_config && app_config.files)? app_config.files: null;

        var dbCollection = null, warning_list =[], files_added_list = [];

        function app_err(message) {return helpers.app_data_error(exports.version, "updateFileList", req.params.app_name, message);}
        
        async.waterfall([
            // 1. make sure all data exits
            function (cb) {
                if (!req.session.logged_in_user_id) {
                    cb(helpers.auth_failure("app_handler", exports.version, "updateFileList", req.params.app_name, "Need to be logged in to access app"));
                } else if (!collectionIsValid(collection_name, app_config, true)) {
                    cb(app_err("invalid collection name"));
                } else if (!newObjectFieldNamesAreValid(null,data_model)) {
                    cb(app_err("cannot update file list with required field_names"));
                } else if (data_model && data_model.do_not_allow) {
                    cb(app_err("files not allowed"));
                } else if (!file_handler.valid_path_extension(req.params.folder_name)) {
                    cb(app_err("invalid folder name", ""));
                } else {
                    cb(null);
                }
            },

            // 2. checkapp code (make sure the right app is sending data) and device_code (to make sure rights exist)
            function (cb) {
                freezr_db.check_app_code(req.session.logged_in_user_id, req.params.app_name, req.params.source_app_code, cb)
            },
            function (cb) {
                freezr_db.check_device_code_specific_session(req.session.device_code, req.session.logged_in_user_id, req.params.app_name, cb)
            },

            // 3. open database connection & get collection
            function (cb) {
                freezr_db.app_db_collection_get(req.params.app_name.replace(/\./g,"_") , collection_name, cb);
            },

            // 4. read files
            function (theCollection, cb) {
                dbCollection = theCollection;
                file_handler.readUserDir(req.session.logged_in_user_id,req.params.app_name,req.params.folder_name, req.freezr_environment, cb);
            },


            // 5. handle file and get a unique id
            function(folderlist, cb) {
                if (folderlist && folderlist.length>0) {
                    var file_name;
                    async.forEach(folderlist, function (file_name, cb2) {

                        var data_object_id = req.session.logged_in_user_id+(req.params.folder_name?file_handler.sep()+req.params.folder_name:"")+file_handler.sep()+file_name;

                        if (!helpers.valid_filename(file_name) ) {
                            warning_list.push(file_name+": invalid file name");
                            cb2(null);
                        } else if (data_model && data_model.allowed_file_types && data_model.allowed_file_types.length>0 && data_model.allowed_file_types.indexOf(file_handler.fileExt(file_name))<0 ){
                            warning_list.push(file_name+": invalid file type");
                            cb2(null);
                        } else {

                            async.waterfall([
                                function (cb3) {
                                    file_handler.userLocalFileStats(req.session.logged_in_user_id,req.params.app_name,req.params.folder_name, file_name, cb3);

                                },

                                function(fileStats, cb3) {
                                    if (fileStats.isDirectory() ) {
                                        cb3(helpers.app_data_error(exports.version, "updateFileList", req.params.app_name, "directory error exception - file is a directory"));
                                    } else {
                                        cb3(null)
                                    }
                                },

                                function (cb3) {
                                    dbCollection.find({ _id: data_object_id }).toArray(cb3);
                                },

                                // 7. write or update the results
                                function (results, cb3) {
                                    if (!results  || results.length == 0) {
                                        var write = {};
                                        write._owner = req.session.logged_in_user_id; 
                                        write._date_Modified = new Date().getTime();
                                        write._id = data_object_id;
                                        write._folder = req.params.folder_name? req.params.folder_name:file_handler.sep();                                       
                                        write._date_Created = new Date().getTime();
                                        dbCollection.insert(write, { w: 1, safe: true }, cb3);
                                    } else if (results.length > 1) {
                                        cb3(helpers.app_data_error(exports.version, "updateFileList", req.params.app_name, "multiple_files_exception - Multiple Objects retrieved for "+file_name))
                                    } else {
                                        cb3(null, null);
                                    }
                                }, 

                                function (written_object, cb3) {
                                    if (written_object) files_added_list.push(file_name); // else done with file: file_name 
                                    cb3(null);
                                }
                            ],
                            function (err) { // end cb3 - back to cb2
                                if (err) {
                                    warning_list.push(file_name+": "+(err.message? err.message:"unknown error"));
                                } 
                                cb2(null);
                            });
                        }
                    },
                    function (err) {
                        if (err) {
                            warning_list.push("'unkown_file_error': "+JSON.stringify(err));
                        } 
                        cb(null)
                    }

                    )
                } else {
                    cb(null);
                }            
            },

        ], 
        function (err) {
            if (err) {
                helpers.send_failure(res, err, "app_handler", exports.version, "updateFileList");
            } else {
                helpers.send_success(res, {'flags':flags, 'files_added_list':files_added_list, 'warning_list':warning_list});
            }
        });*/
    }

// ancillary functions and name checks
    var collectionIsValid = function (collection_name, app_config,is_file_record){
        // checkes collection name and versus app_config requirements
        
        if (!helpers.valid_collection_name(collection_name,is_file_record) ) {
            return false
        } else if (!app_config || !app_config.meta || !app_config.meta.only_use_collections_listed) {
            return true;
        } else if (is_file_record || collection_name=="files" ){
            return !(app_config.files && app_config.files.do_not_allow)
        } else if (app_config.collections) {
           for (oneCollection in app_config.collections) {
                if (app_config.collections.hasOwnProperty(oneCollection) && oneCollection == collection_name) {return true;}
            }
        }
        return false;
    }
    var newObjectFieldNamesAreValid = function(req, data_model) {
        // Make lists of required field_names from data object
        if (!data_model) {
            return true;
        } else {
            var allFieldNameList= [],
                requiredFieldNameList = [];
            if (data_model && data_model.field_names) {
                for (field_name in data_model.field_names) {
                    if (data_model.field_names.hasOwnProperty(field_name)) {
                        allFieldNameList.push(field_name);
                        if (data_model.field_names[field_name].required) requiredFieldNameList.push(field_name)
                    }
                }
            }
            //onsole.log("allFieldNameList are "+allFieldNameList.join(", "));
            //onsole.log("requiredFieldNameList are "+requiredFieldNameList.join();
            
            if (req && req.body && req.body.data) {
                for (key in req.body.data) {
                    if (req.body.data.hasOwnProperty(key)) {
                        if (requiredFieldNameList.indexOf(key)>-1) {
                            requiredFieldNameList.splice(requiredFieldNameList.indexOf(key),1)
                        }
                        if ((!req.body.options || !req.body.options.restoreRecord) && reserved_field_name_list.indexOf(key)>-1) {
                            helpers.warning("app_handler", exports.version, "newObjectFieldNamesAreValid","key used is reserved  reserved field_names are "+reserved_field_name_list.join(" "));
                            return false;
                        }
                        if (data_model && data_model.strictly_Adhere_To_schema && allFieldNameList.indexOf(key)<0) {
                            helpers.warning("app_handler", exports.version, "newObjectFieldNamesAreValid","data schema was declared as strict but "+key+" is not declared");
                            return false
                        }
                    }
                }
            }

            // check if file is sent but shouldnt be
            if (data_model && data_model.strictly_Adhere_To_schema && !data_model.file && req.file) {
                helpers.warning("app_handler", exports.version, "newObjectFieldNamesAreValid","ER  SENDIGN FILES WHEN IT SHOULDNT BE");
                return false;
            }

            return (req && req.body && req.body.options && req.body.options.updateRecord) || requiredFieldNameList.length==0;
        }
    }
    var removeIds = function(jsonList) {
        // toto later: in config add a var: private or dontReturn which means that is not returned to third parties
        for (var i=0; i<jsonList.length;i++) {
            if (jsonList[i]._id) {
                delete jsonList[i]._id;
            }
        }
        return jsonList;
    }
    var unique_id_from = function(ref_field_names, params, user_id) {
        data_object_id= "";
        for (var i=0; i<ref_field_names.length; i++) {
            if (!params[ref_field_names[i]] || params[ref_field_names[i]]=="") {
                return helpers.app_data_error(exports.version, "unique_id_from", "app name uknown","missing data key needed for making unique id: "+ref_field_names[i]);
            }
            data_object_id = "_"+params[ref_field_names[i]];
        }
        return user_id + data_object_id;
    }
    var folder_name_from_id = function(the_user, the_id) {
        return the_id.replace((the_user+"_"),"");
    }



// NOT USED / EXTRA
    var make_sure_required_field_names_exist = function (params, data_model, cb) {
        // NOTE - Currently not used... can be used if want to have records point to other records... can be put in putData
        // checks the data model to see if there are requried referecne objects and make sure the refeenced objects actually exist
        // todo - Works with ONE ref object... need to expand it to multiple
        var ref_names = [];
        if (data_model && data_model.field_names) {
            for (key in data_model.field_names) {
                if (data_model.field_names.hasOwnProperty(key) && data_model.field_names[key].type=="data_object") {
                    ref_names.push(key);
                }
            }
        }
        if (ref_names.length == 0) {
            cb(null);
        } else {
            // TODO Need to loop through multiple references
            a_ref_name = ref_names[0];
            referenced_object_name = data_model.field_names[a_ref_name].referenced_object;
            ref_value = params[a_ref_name];

            db.collection(referenced_object_name, function(err, referenced_object){
                if (err) {
                    cb(helpers.app_data_error(exports.version, "make_sure_required_field_names_exist", "app name uknown","Could not get referenced object "+referenced_object_name+"from "+a_ref_name,""))
                } else {
                    referenced_object.find({ _id: ref_value }).toArray(function (err, results) {
                        if (err) {
                            cb(err);
                        } else if (results.length == 0) {
                            cb(helpers.app_data_error(exports.version, "make_sure_required_field_names_exist", "app name uknown","referenced object "+ref_value+" in collection "+referenced_object_name+" from key id "+a_ref_name));
                        } else if (results.length == 1) {
                            cb(null);
                        } else {
                            cb(helpers.app_data_error(exports.version, "make_sure_required_field_names_exist", "app name uknown","More than one result retuened for referenced object "+referenced_object_name+"from "+a_ref_name,""));
                        }
                    });

                }
            } );

        }
    }


/* Todo - update and review functionality - need to be made coherenet with changes to setObject Access
    exports.setFieldAccess = function (req, res) {
        // After app-permission has been given, this sets a field permission or updates it
        // app.put('/v1/permissions/setfieldaccess/:requestor_app/:source_app_code/:permission_name', userDataAccessRights, app_hdlr.setFieldAccess);
        // Options: 'action': 'grant' // default - can also be 'deny'
            //'field_name': 'albums', // field name of value
            //'field_value':'myVacationAlbum2014' // gives access to 
            // can have one of:  'shared_with_group':'logged_in' or 'shared_with_user':a user id 
            // 'requestee_app': app_name (defaults to self)

        var app_config = helpers.get app config(req.params.requestor_app);

        var permission_model= (app_config && app_config.permissions && app_config.permissions[req.params.permission_name])? app_config.permissions[req.params.permission_name]: null;

        var permission_type = (permission_model && permission_model && permission_model.type)? permission_model.type: null;
        var requestee_app = req.body.requestee_app? req.body.requestee_app: req.params.requestor_app; 

        var shared_with_user = req.body.shared_with_user? req.body.shared_with_user: null;
        var shared_with_group = shared_with_user? "user": (req.body.shared_with_group? req.body.shared_with_group: 'logged_in');

        var requested_field_name = req.body.field_name? req.body.field_name: null;
        if (!requested_field_name && permission_type) {
            if (permission_type=="folder_delegate") {
                requested_field_name = "_folder";
            } else if (permission_type=="field_delegate" && permission_model && permission_model.sharable_fields && permission_model.sharable_fields.length>0) {
                requested_field_name = permission_model.sharable_fields[0];
            }
        }
        var requested_field_value = req.body.field_value? req.body.field_value: ((permission_type=="folder_delegate" && permission_model.sharable_folders && permission_model.sharable_folders.length>0)? permission_model.sharable_folders[0]: null);

        var permission_collection;

        //onsole.log("setFieldAccess with perm"+req.params.permission_name+" requested_field_name" + requested_field_name+" requested_field_value" + requested_field_value+"  - - body:"+JSON.stringify(req.body));

        var flags = new Flags({'app_name':req.params.requestor_app});

        var unique_field_permission_attributes =
                {   'requestor_app':req.params.requestor_app,
                    'requestee_app':requestee_app,
                    '_owner':req.session.logged_in_user_id,
                    'permission_name':req.params.permission_name,
                    'field_name':requested_field_name, 
                    'field_value':requested_field_value,
                    'shared_with_group':shared_with_group
                }
                // note: collection is already defined in the app_config
        if (shared_with_user) unique_field_permission_attributes.shared_with_user = shared_with_user;
        var flags = new Flags({'app_name':req.params.requestor_app});

        function app_err(message) {return helpers.app_data_error(exports.version, "setFieldAccess", req.params.app_name, message);}
        function app_auth_err(message) {return helpers.auth_failure("app_handler", exports.version, "setFieldAccess", req.params.requestor_app,  message);}


        async.waterfall([
            // 1. make sure all data exits
            function (cb) {
                if (!req.session.logged_in_user_id) {
                    cb(helpers.missing_data("Not logged in"));
                } else if (!app_config){
                    cb(helpers.missing_data("app_config"));
                } else if (!permission_model){
                    cb(helpers.missing_data("permission"));
                } else if (!permission_type){
                    cb(helpers.missing_data("permission type"));
                } else if (["folder_delegate","field_delegate"].indexOf(permission_type)<0){
                    cb(app_err("invalid permission type"));
                } else if (helpers.permitted_types.groups_for_fields.indexOf(shared_with_group)<0 ){
                    cb(app_err("invalid permission group"));
                } else if (!requested_field_value || !requested_field_name){
                    cb(app_err("missing field name / value / collection"));
                } else if (req.body.action && ["grant","deny"].indexOf(req.body.action)<0 ){
                    cb(app_err("invalid field permission action :"+req.body.action));
                } else {
                    cb(null);
                }
            },
            function (cb) {
                freezr_db.check_app_code(req.session.logged_in_user_id, req.params.requestor_app, req.params.source_app_code, cb)
            },
            function (cb) {
                freezr_db.check_device_code_specific_session(req.session.device_code, req.session.logged_in_user_id, req.params.requestor_app, cb)
            },

            // 3. get app permissions 
            function(cb) {
                freezr_db.permission_by_owner_and_permissionName (req.session.logged_in_user_id, req.params.requestor_app, requestee_app, req.params.permission_name, cb)
            },

            // 4. check permission is granted and can authorize requested fields, and if so, open db
            function (results, cb) {
                if (!results || results.length==0) {
                    cb(app_auth_err("permission does not exist"))
                }  else if (!results[0].granted) {
                    cb(app_auth_err("permission not granted yet"));
                } else if (!freezr_db.field_requested_is_permitted(results[0],requested_field_name, requested_field_value)) {
                    cb(app_auth_err("app permission granted does not corresppnd to request"))
                } else {
                    freezr_db.app_db_collection_get("info_freezr_permissions", "field_permissions", cb);
                }
            },

            // 5. open object ... make sure object doesn't already exist
            // combo of following fields should be unique: user, requstor app, requestee app, permission name, field_name, 'field_value'
            function (theCollection, cb) {
                permission_collection = theCollection;
                permission_collection.find(unique_field_permission_attributes).toArray(cb);
            },

            // 6. write or update the results
            function (results, cb) {

                if (results == null || results.length == 0) {
                    var write = unique_field_permission_attributes;
                    write._date_Modified = new Date().getTime();
                    write.granted = (!req.body.action || req.body.action == "grant")? true:false;
                    write._date_Created = new Date().getTime();
                    permission_collection.insert(write, { w: 1, safe: true }, cb);
                } else if (results.length == 1) { // updating record
                    var write = {};
                    write._date_Modified = new Date().getTime();

                    var newgrant = (!req.body.action || req.body.action == "grant")? true:false;
                    if (newgrant != results[0].granted) {
                        flags.add('notes','Updated grant permission from '+results[0].granted+' to '+newgrant);
                        write.granted = newgrant; 
                        dbCollection.update({ _id: results[0]._id }, {$set : write}, {safe: true }, cb);
                    } else {
                        cb(app_err("record was already updated"));
                    }                
                } else {
                    cb(helpers.internal_error("app_handler", exports.version, "setFieldAccess", req.params.requestor_app,  message+" - cant update if multiple objects retrieved - SNBH"));
                }
            },
        ], 
        function (err, final_object) {
            if (err) {
                helpers.send_failure(res, err, "app_handler", exports.version, "setFieldAccess");
            } else {
                helpers.send_success(res, {'flags':flags});
            }
        });
    }
    exports.getFieldPermissions = function (req, res) {
        //app.get('/v1/permissions/getfieldperms/:requested_type/:requestor_app/:source_app_code/', userDataAccessRights, app_hdlr.getFieldPermissions)
        // todo - note on slight hole to fill: if app permission has been denied after field permission was granted, the field permission still shows up here (if there was an error deleting it after denying the grant..)

        //onsole.log("getFieldPermissions "+req.url)
        var dbCollection;

        var requestee_app = req.query.requestee_app? req.query.requestee_app: req.params.requestor_app;

        var field_permission_attributes = {};
        if (req.query.permission_name) field_permission_attributes.permission_name = req.query.permission_name;
        if (req.query.collection) field_permission_attributes.collection = req.query.collection;
        if (req.query.field_name) field_permission_attributes.field_name = req.query.field_name;
        if (req.query.granted) field_permission_attributes.granted = (req.query.granted=="true");
        switch(req.params.requested_type) {
            case 'ihavegranted':
            // options: permission_name, collection, field_name, granted, field_value, shared_with_group, shared_with_user
                if (req.query.field_value) field_permission_attributes.field_value = req.query.field_value;
                if (req.query.shared_with_group) field_permission_attributes.shared_with_group = req.query.shared_with_group;
                if (req.query.shared_with_user) field_permission_attributes.shared_with_user = req.query.shared_with_user;
                field_permission_attributes._owner = req.session.logged_in_user_id;
                break;
            case 'ihaveccessto':
            // options: permission_name, collection, field_name, granted,  _owner
                field_permission_attributes.requestor_app = req.params.requestor_app;
                field_permission_attributes.$or = 
                        [{'shared_with_group': 'logged_in'},
                         {'shared_with_user' :  req.session.logged_in_user_id} ];
                if (req.query._owner) field_permission_attributes._owner = req.query._owner;
                break;
            default:
                field_permission_attributes = null;
        }

        async.waterfall([
            // 1. make sure all data exits
            function (cb) {
                if (!req.session.logged_in_user_id) {
                    cb(helpers.missing_data("Not logged in"));
                } else if (!field_permission_attributes){
                    cb(helpers.error("invalid request type"))
                } else {
                    cb(null);
                }
            },


            // 2. checkapp code (make sure the right app is sending data) and device_code (to make sure rights exist)
            function (cb) {
                freezr_db.check_app_code(req.session.logged_in_user_id, req.params.requestor_app, req.params.source_app_code, cb)
            },
            function (cb) {
                freezr_db.check_device_code_specific_session(req.session.device_code, req.session.logged_in_user_id, req.params.requestor_app, cb)
            },

            // 3. get collection
            function (cb) {
                freezr_db.app_db_collection_get("info_freezr_permissions" , "field_permissions", cb);
            },

            // 3. find permissions
            function (theCollection, cb) {
                dbCollection = theCollection;
                dbCollection.find(field_permission_attributes).toArray(cb);
            },

        ], 
        function (err, results) {
            if (err) {
                helpers.send_failure(res, err, "app_handler", exports.version, "getFieldPermissions");
            } else {
                helpers.send_success(res, {'results':results});
            }
        });
    }
*/









