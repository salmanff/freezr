// freezr.info - nodejs system files - public_handler.js
exports.version = "0.0.1";

var helpers = require('./helpers.js'),
    freezr_db = require("./freezr_db.js"),
    async = require('async'),
    file_handler = require('./file_handler.js');

const ALL_APPS_CONFIG = { // html and configuration for generic public pages
        'meta': {
            'app_display_name':"freezr - All public cards",
            'app_version': "0.0.1"
        },
        'public_pages' : {
            "allPublicRecords" : {
                'html_file':"allpublicrecords.html",
                'css_files': ["allpublicrecords.css"],
                'script_files': ["allpublicrecords.js"]
            }
        }
    }
    genericHTMLforRecord = function(record) {         
        var text = "<div class='freezr_public_genericCardOuter freezr_public_genericCardOuter_overflower'>" 
        text+= '<div class="freezr_public_app_title">'+record._app_name+"</div>";
        text += "<table>"     
        for (var key in record) {
            if (Object.prototype.hasOwnProperty.call(record, key)) {
                text+= "<tr style='width:100%; font-size:12px; overflow:normal'><td style='width:100px'>"+key +": </td><td>"+((typeof record[key] ==="string")? record[key] : JSON.stringify(record[key]) )+"</td></tr>"   
            };
        }
        text+="</table>"
        text+="</div>"
        return text;
    }

exports.generatePublicPage = function (req, res) { 
    //    app.get('/pcard/:user_id/:app_name/:collection_name/:data_object_id'    
    //    app.get('/pcard/:user_id/:requestor_app/:permission_name/:app_name/:collection_name/:data_object_id', addVersionNumber, public_handler.generatePublicPage); 
    //    app.get('/v1/pobject/:user_id/:app_name/:collection_name/:data_object_id', public_handler.generatePublicPage); // collection_name is files 
            // Note: for pcard, app_name is requestee_app
    /* todo or separate into another function 
        // app.get('/v1/pfile/:user_id/:app_name/*', public_handler.getPublicDataObject); // collection_name is files 
        var isfile = helpers.startsWith(req.path,"/v1/pfile/");
         if (isfile) {req.params.collection_name = "files"; objectOnly=true;}
         */
    
    //    app.get('/ppage/:app_name/:page', addVersionNumber, public_handler.generatePublicPage); 
    //    app.get('/ppage/:app_name', addVersionNumber, public_handler.generatePublicPage); 
    //    app.get('/ppage', addVersionNumber, public_handler.generatePublicPage); 
    console.log("generating public page ",req.url," with query ",req.query);
   
    var isCard    = helpers.startsWith(req.path,"/pcard");
    var objectOnly= helpers.startsWith(req.path,"/v1/pobject/");
    var allApps   = (!isCard && !req.params.app_name);
    var app_name  = allApps? "info.freezr.public" : req.params.app_name;
    var useGenericFreezrPage = allApps;

    var page_name; page_params = {};

    file_handler.async_app_config(app_name, req.freezr_environment, function (err, app_config) {
        if (allApps) app_config  = ALL_APPS_CONFIG;
        if (err) {
            helpers.send_failure("public_handler", exports.version, "generatePublicPage", null, "problem getting app config while accessing public "+ (isCard?"card.":"page."));
        } else if (!app_config ){
            helpers.send_failure("public_handler", exports.version, "generatePublicPage", null, "app config missing while accessing public "+ (isCard?"card.":"page."));
            // permissions for public access re given in the app_config so no app config means no pubic records
        } else {
            page_name   = req.params.page;
            if (!page_name || !app_config.public_pages[page_name]) page_name = firstElementKey(app_config.public_pages);
            if (!page_name || !app_config.public_pages[page_name] || !app_config.public_pages[page_name].html_file) {
                useGenericFreezrPage = true;
                page_params = ALL_APPS_CONFIG.public_pages.allPublicRecords
            } else {
                if (helpers.endsWith(page_name, '.html')) page_name = page_name.slice(0,-5);
                page_params = app_config.public_pages[page_name];
            }
            if (!isCard && !objectOnly) {
                var options = {
                    page_url: page_params.html_file,
                    page_title: (page_params.page_title? page_params.page_title:"Public info")+" - freezr.info",
                    css_files: [], // page_params.css_files,
                    initial_query: page_params.initial_query? page_params.initial_query: {},
                    script_files: [], //, //[],
                    app_name: app_name,
                    app_display_name : (allApps? "All Freezr Apps" : ( (app_config && app_config.meta && app_config.meta.app_display_name)? app_config.meta.app_display_name:app_name) ),
                    app_version: (app_config && app_config.meta && app_config.meta.app_version && !allApps)? app_config.meta.app_version:"N/A",
                    freezr_server_version: req.freezr_server_version,
                    other_variables: null,
                    server_name: req.protocol+"://"+req.get('host'),

                    // extra items
                    page_name: page_name,
                    isPublic: true,
                    allApps: allApps,
                    useGenericFreezrPage: useGenericFreezrPage   
                }     
                
                if (req.query) {
                    for (param in req.query) {if (Object.prototype.hasOwnProperty.call(req.query, param)) {
                        if (['skip','count'].indexOf(param)>-1) {
                            options.initial_query[param] = req.query[param];
                        } else if (['q','search'].indexOf(param)>-1) {
                            options.initial_query.search = req.query[param]; 
                        } else if (['app','app_name'].indexOf(param)>-1) {
                            options.initial_query.app_name = req.query[param]; 
                        } else if (['user','_owner','user_id'].indexOf(param)>-1) {
                            options.initial_query._owner = req.query[param]; 
                        } 
                        // todo - expand search query paramaters to the data_object
                    }}
                } 

                var outside_scripts = [];
                if (page_params.script_files) {
                    if (typeof page_params.script_files == "string") page_params.script_files = [page_params.script_files];
                    page_params.script_files.forEach(function(js_file) {
                        if (helpers.startsWith(js_file,"http")) {
                            outside_scripts.push(js_file)
                        } else if (helpers.startsWith(js_file,"/") || helpers.startsWith(js_file,".")) {
                            helpers.app_data_error(exports.version, "generatePage", req.params.app_name, "Cannot have script files referring to other folders")
                        } else {
                            if (file_handler.fileExt(js_file) == 'js'){
                                options.script_files.push("public/"+js_file);
                            } else {
                                helpers.app_data_error(exports.version, "generatePage", req.params.app_name, "Cannot have non js file used as js.")
                            }
                        }
                    });
                }
                if (page_params.css_files) {
                    if (typeof page_params.css_files == "string") page_params.css_files = [page_params.css_files];
                    page_params.css_files.forEach(function(css_file) {
                        if (helpers.startsWith(css_file,"http")) {
                            helpers.app_data_error(exports.version, "generatePage", req.params.app_name, "Cannot have css files referring to other hosts")
                        } else if (helpers.startsWith(css_file,"/") || helpers.startsWith(css_file,".")) {
                            helpers.app_data_error(exports.version, "generatePage", req.params.app_name, "Cannot have css files referring to other folders")
                        } else {
                            if (file_handler.fileExt(css_file) == 'css'){
                                options.css_files.push("public/"+css_file);
                            } else {
                                helpers.app_data_error(exports.version, "generatePage", req.params.app_name, "Cannot have non css file used as css :"+css_files)
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
                            gotoShowInitialData(res, req.freezr_environment, options);
                        }
                    })
                } else {
                    gotoShowInitialData(res, req.freezr_environment, options);
                }
            } else { // isCard or one objectOnly
                req.freezrInternalCallFwd = function(err, results) {
                    var contents;
                    if (err) { 
                        if (objectOnly) {
                            helpers.send_failure(res, err, "public_handler", exports.version, "generatePublicPage");
                        } else {
                            helpers.state_error("public_handler", exports.version, "generatePublicPage:freezrInternalCallFwd", err, "uknown" )
                            contents = "error getting data "+JSON.stringify(err)
                            res.writeHead(200, { "Content-Type": "text/html" });
                            res.end(contents);
                        }
                    } else {
                        var record, html_file;
                        if (!results || !results.results || results.results.length==0) {
                            record = {}; 
                            record[app_name]="No records found."
                            html_file = ALL_APPS_CONFIG.public_pages.allPublicRecords.html_file;
                        } else {
                            record = formatDates(results.results[0]);
                            html_file = (app_config && app_config.permissions && app_config.permissions[record._permission_name] && app_config.permissions[record._permission_name].card)? app_config.permissions[record._permission_name].card : null;
                        }
                        if (objectOnly) {
                            helpers.send_success(res, {'results':record});
                        } else if (html_file) {
                            var Mustache = require('mustache');
                            // todo add option to wrap card in html header
                            file_handler.get_file_content(app_name, "public"+file_handler.sep()+html_file , req.freezr_environment, function(err, html_content) {
                                if (err) {
                                    helpers.send_failure(res, helpers.error("file missing","html file missing - cannot generate card without a card html ("+page_name+")in app:"+app_name+"."), "public_handler", exports.version, "generatePublicPage" )
                                
                                } else {
                                    // todo may be "if html file is emppty generate generic todo now")
                                    try {
                                        contents = Mustache.render(html_content, record);
                                    } catch (e) {
                                        contents = "Error in processing mustached app html - "+html_content
                                    }
                                    res.writeHead(200, { "Content-Type": "text/html" });
                                    res.end(contents);
                                }
                            });
                        } else {
                            contents = genericHTMLforRecord(record, false);
                            res.writeHead(200, { "Content-Type": "text/html" });
                            res.end(contents);
                        }
                    }
                }
                req.body = {
                    _app_name:req.params.app_name, 
                    user_id:req.params.user_id,
                    count: 1,
                    skip: 0,
                    query_params: {
                        collection_name: req.params.collection_name,
                        data_object_id: req.params.data_object_id
                    }
                };
                exports.dbp_query(req,res);
            }
        }
    });
};

gotoShowInitialData = function(res, freezr_environment, options) {
    // used when generating a page of accessible items
    var req= {freezr_environment: freezr_environment}
    if (!options) options = {};
    if (!options.initial_query) options.initial_query = {};
    var display_more=true;
    req.body = {app_name:options.initial_query.app_name, 
                user_id:options.initial_query._owner,
                count: options.initial_query.count || 20,
                skip: options.initial_query.skip || 0,
                query_params:options.initial_query.query_params || {},
                search: options.initial_query.search
    };

    if (!options.initial_query){
        file_handler.get_file_content(options.app_name, "public"+file_handler.sep()+options.page_url , freezr_environment, function(err, html_content) {
            if (err) {
                helpers.send_failure(res, helpers.error("file missing","html file missing - cannot generate page without file page_url 4 ("+options.page_url+")in app:"+options.app_name+" public folder (no data)."), "public_handler", exports.version, "gotoShowInitialData" )
            } else {
                options.page_html= html_content;
                file_handler.load_page_html(res,options)
            }
        });
    } else if (options.useGenericFreezrPage) {
        req.url = '/ppage';
        if (!options.allApps) req.body.app_name = options.app_name;
        req.freezrInternalCallFwd = function(err, results) {
            // get results from query and for each record, get the file and then merge the record 
                /* from setObjectAccess for permission_record
                    var unique_object_permission_attributes =
                        {   'requestor_app':req.params.requestor_app,
                            'requestee_app':requestee_app,
                            '_owner':req.session.logged_in_user_id,
                            'permission_name':req.params.permission_name,
                            'collection_name': collection_name,
                            'data_object_id': data_object_id,
                            'shared_with_group':new_shared_with_group
                            '_id':requestee_app+"_"+req.session.logged_in_user_id+"_"+data_object_id;
                        } nb also adds _app_name
                    */
            var records_stream=[]; 
            var renderStream = function () {
                file_handler.get_file_content("info.freezr.public", "public"+file_handler.sep()+options.page_url , freezr_environment, function(err, html_content) {
                    if (err) {
                        helpers.send_failure(res, helpers.error("file missing","html file missing - cannot generate page without file page_url 1 ("+options.page_url+")in app:"+options.app_name+" publc folder."), "public_handler", exports.version, "gotoShowInitialData" );
                    } else {
                        current_search =  req.body.search && req.body.search.length>0? (req.body.search):"";
                        current_search += req.body.user_id && req.body.user_id.length>0? ( (current_search.length>0?"&":"") + "user:"+req.body.user_id):"";
                        current_search += req.body.app_name && req.body.app_name.length>0? ((current_search.length>0?"&":"") + "app:"+req.body.app_name):"";
                        search_url =  req.body.search && req.body.search.length>0? ("q="+req.body.search):"";
                        search_url += req.body.user_id && req.body.user_id.length>0? ((search_url.length>0?"&":"") + "user="+req.body.user_id):"";
                        search_url += req.body.app_name && req.body.app_name.length>0? ((search_url.length>0?"&":"") + "app="+req.body.app_name):"";
                        search_url += (search_url.length>0?"&":"") + "skip="+(parseInt(req.body.skip || 0) + parseInt(req.body.count || 0));

                        var page_components = {
                            skipped: parseInt(req.body.skip || 0),
                            counted: parseInt(req.body.count || 0),
                            display_more : (display_more?"block":"none"),
                            user_id: req.body.user_id? req.body.user_id: "",
                            app_name: (options.allApps? "": options.app_name),
                            records_stream: records_stream,
                            current_search: current_search,
                            search_url:search_url
                        }

                        try {
                            options.page_html= Mustache.render(html_content, page_components);
                        } catch (e) {
                            options.page_html = "Error in processing mustached app html - "+html_content
                        }

                        file_handler.load_page_html(res,options)
                    }               
                });
            }

            var app_cards = {}, html_file, html_content, app_config, app_configs= {}, logos= {};
            var Mustache = require('mustache');
            if (!results || !results.results || results.results.length == 0) {
                display_more = false;
                renderStream();
            } else { // add card to each record (todo - this should be done in dbp_query as an option req.paras.addcard)
                display_more = results.results.length>=(req.body.count) // this can lead to a problem if a permission is not allowed - todo : in query send back record with a not_permitted flag
                var permission_record_card_create = function(permission_record, app_config) {
                    var temp_card = formatDates(permission_record, app_config)
                    if (app_cards[permission_record._app_name] && app_cards[permission_record._app_name] != "NA") {
                        try {
                            temp_card._card = Mustache.render(app_cards[temp_card._app_name], temp_card);
                        } catch (e) {
                            helpers.app_data_error(exports.version, "gotoShowInitialData:freezrInternalCallFwd", temp_card._app_name, "error rendering app data with card template "+e);
                            temp_card._card  = null;
                        }
                    } 
                    if (app_cards[permission_record._app_name] == "NA" || !permission_record._card) {
                        temp_card._card = genericHTMLforRecord(permission_record);
                    }
                    return temp_card
                }

                async.forEach(results.results, function (permission_record, cb2) {
                    html_content=null; html_file=null;
                    if (!permission_record || !permission_record._app_name) { // (false) { //
                        helpers.app_data_error(exports.version, "public_handler:gotoShowInitialData:freezrInternalCallFwd", "no_permission_or_app", "Uknown error - No permission or app name for a record ");
                    } else {
                        if (!app_cards[permission_record._app_name]) {
                            file_handler.async_app_config(permission_record._app_name, req.freezr_environment,function (err, app_config) { 
                                if (err) {
                                    helpers.app_data_error(exports.version, "public_handler:gotoShowInitialData:freezrInternalCallFwd", "ignore_error_getting_config", err.message);
                                } else {
                                    app_configs[permission_record._app_name]= app_config;
                                    html_file = (app_config && app_configs[permission_record._app_name].permissions && 
                                                 app_configs[permission_record._app_name].permissions[permission_record._permission_name] && 
                                                 app_configs[permission_record._app_name].permissions[permission_record._permission_name].card);
                                    
                                    if (html_file ) {
                                        file_handler.get_file_content(permission_record._app_name, "public/"+html_file, freezr_environment, function(err, html_content) {
                                            var permission_record_card;
                                            if (!html_content || err) {
                                                helpers.app_data_error(exports.version, "public_handler:gotoShowInitialData:freezrInternalCallFwd", "err_getting_html_content", ((err && err.message)?err.message: "Missing html content to create card"));
                                                app_cards[permission_record._app_name] = "NA";
                                                permission_record._card = genericHTMLforRecord(permission_record);   
                                                records_stream.push(permission_record);
                                            } else {
                                                app_cards[permission_record._app_name] = html_content;
                                                permission_record_card = permission_record_card_create(permission_record, app_configs[permission_record._app_name])
                                                records_stream.push(permission_record_card);
                                            }
                                            cb2(null);
                                        })

                                    } else {
                                        app_cards[permission_record._app_name] = "NA";
                                        permission_record._card = genericHTMLforRecord(permission_record);   
                                        records_stream.push(permission_record);
                                        cb2(null);
                                    }
                                }
                            });
                        } else {
                            var permission_record_card = permission_record_card_create(permission_record, app_configs[permission_record._app_name])
                            records_stream.push(permission_record_card);
                            cb2(null);
                        }
                    }
                },
                function (err) {
                    if (err) {
                        helpers.send_failure(res, err, "public_handler", exports.version, "gotoShowInitialData:freezrInternalCallFwd" )
                    } else {
                        renderStream();
                    }
                })
            }             
        }
        exports.dbp_query(req,res);
    } else { // Initial data capture (but not generic freezr page)
        req.url = options.initial_query.url;
        if (!options.allApps) req.body.app_name = options.app_name;
        req.freezrInternalCallFwd = function(err, results) {
            if (err) {
                helpers.send_failure(res, err, "public_handler", exports.version, "gotoShowInitialData" )
            } else {

                file_handler.async_app_config(options.app_name, req.freezr_environment,function (err, app_config) { 
                    if (err) {
                        helpers.send_failure(res, err, "public_handler", exports.version, "gotoShowInitialData" )
                    } else {
                        var Mustache = require('mustache');
                        if (results && results.results && results.results.length > 0 && !options.allApps) {
                            for (var i=0;i<results.results.length;i++) {
                                results.results[i] = formatDates(results.results[i], app_config)
                            }
                        }
                        var html_file = (app_config && app_config.public_pages && app_config.public_pages[options.page_name] && app_config.public_pages[options.page_name].html_file)? app_config.public_pages[options.page_name].html_file: null;
                        if (!html_file) {
                            helpers.send_failure(res, helpers.error("file missing","html file missing - cannot generate page without file page_url 2 ("+html_file+")in app:"+options.app_name+" publc folder."), "public_handler", exports.version, "gotoShowInitialData" )
                        } else {      
                            file_handler.get_file_content(req.body.app_name, "public"+file_handler.sep()+html_file , freezr_environment, function(err, html_content) {
                                if (err) {
                                    helpers.send_failure(res, helpers.error("file missing","html file missing - cannot generate page without file page_url 3f("+options.page_url+")in app:"+options.app_name+" publc folder."), "public_handler", exports.version, "gotoShowInitialData" )
                                } else {
                                    try {
                                        options.page_html =  Mustache.render(html_content, results);
                                    } catch (e) {
                                        options.page_html = "Error in processing mustached app html - "+JSON.stringify(e)+"</br>"+html_content
                                    }
                                    file_handler.load_page_html(res,options);
                                }
                            })
                        }
                    }
                })
            }
        }
        exports.dbp_query(req,res);
    }
}

// database operations
exports.dbp_query = function (req, res){
    //    app.get('/v1/pdbq', addVersionNumber, public_handler.dbp_query); 
    //    app.get('/v1/pdbq/:app_name', addVersionNumber, public_handler.dbp_query); 
    //    app.post('/v1/pdbq', addVersionNumber, public_handler.dbp_query); 
    //    exports.generatePublicPage directly && via gotoShowInitialData
    /* 
    options are, for get (ie req.params and req.query) and post (req.body): 
        - app_name
        - user_id
        - skip
        - count
        - query_params (for post only)
    */
    console.log("dbp_query body ",req.body, " params ",req.params)
    var data_records= [],
        errs = [],
        skip = (req.body && req.body.skip)? parseInt(req.body.skip): ( (req.query && req.query.skip)? parseInt(req.query.skip): 0 ), 
        count= (req.body && req.body.count)? parseInt(req.body.count): ( (req.query && req.query.count)? parseInt(req.query.count): 50 ),
        sort =  {'_date_Modified': -1}

    function app_err(message) {return helpers.app_data_error(exports.version, "dbp_query", "public query for "+(req.body.app_name || ((req.params && req.params.app_name)? req.params.app_name: null) || "all apps"), message);}
    function app_auth(message) {return helpers.auth_failure("public_handler", exports.version, "dbp_query", message);}

    async.waterfall([
        // 1. get permission collection
        function (cb) {
            freezr_db.app_db_collection_get("info_freezr_permissions" , "accessible_objects", cb);
        },

        // 2 get the permission
        function (theCollection, cb) {
            var permission_collection = theCollection;
            var permission_attributes = {
                granted: true,
                shared_with_group: 'public'
            };

            if (req.body && req.body.app_name) permission_attributes.requestee_app = req.body.app_name.toLowerCase();
            if (req.params && req.params.app_name) permission_attributes.requestee_app = req.params.app_name.toLowerCase();
            if (req.body && req.body.user_id ) permission_attributes._owner = req.body.user_id.toLowerCase();
            if (req.query && req.query.user_id ) permission_attributes._owner = req.query.user_id.toLowerCase();

            if (req.body.search) {
                req.body.search = decodeURIComponent(req.body.search).toLowerCase();
                if (req.body.search.indexOf(' ')<0) {
                    permission_attributes.search_words = req.body.search;
                    if (req.body.query_params) permission_attributes = {'$and':[permission_attributes,  req.body.query_params]}
                } else {
                    var theAnds = [permission_attributes];
                    //if (req.body.query_params) theAnds.push(req.body.query_params)
                    var searchterms = req.body.search.split(' ');
                    searchterms.forEach(function(aterm) {theAnds.push({'search_words':aterm})});
                    permission_attributes = {'$and':theAnds}
                }
            }

            permission_collection.find(permission_attributes)
                .sort(sort)
                .limit(count)
                .skip(skip)
                .toArray(cb);

        },
        // 3 see permission record and make sure it is still granted 
        function (results, cb) {
            if (!results || results.length==0) {
                cb(null);
            }  else {
                async.forEach(results, function (permission_record, cb2) {
                    recheckPermissionExists(permission_record, req.freezr_environment,  function (err, results) {
                        if (err) {
                            errs.push({error:err, permission_record:permission_record._id})
                            //cb2(null)
                        } else if (!permission_record.data_object){
                            errs.push({error:helpers.error("old data","no data-object associaetd with permsission"), permission_record:permission_record._id})
                            //cb2(null)                            
                        } else if (!results.success){
                            errs.push({error:helpers.error("unkown-err", results), permission_record:permission_record._id})
                            //cb2(null)                                                        
                        } else {
                            if (!permission_record.data_record) permission_record.data_record = {};
                            permission_record.data_object._app_name = permission_record.requestee_app;
                            permission_record.data_object._permission_name = permission_record.permission_name;
                            permission_record.data_object._collection_name = permission_record.collection_name;
                            permission_record.data_object._date_Modified = permission_record._date_Modified;
                            permission_record.data_object._date_Created = permission_record._date_Created;
                            permission_record.data_object._id = permission_record._id;
                            data_records.push (permission_record.data_object)
                            //cb2(null)
                        }
                        cb2(null)
                    });
                },
                function (err) {
                    if (err) {
                        errs.push({error:err, permission_record:null});
                    } 
                    cb(null)
                }
                );
            }
        }
    ], 
    function (err) {
        if (err) {
            helpers.send_failure(res, err, "public_handler", exports.version, "dbp_query");
        } else {
            var sortBylastModDate = function(obj1,obj2) { return obj2._date_Modified - obj1._date_Modified; }
            data_records = data_records.sort(sortBylastModDate)
            if (req.freezrInternalCallFwd) {
                //if (errs && errs.length>0) //onsole.log("end of query with "+data_records.length+" results and errs "+JSON.stringify(errs))
                req.freezrInternalCallFwd(null, {results:data_records, errors:errs, next_skip:(skip+count)});
            } else {
                helpers.send_success(res, {results:data_records, errors:errs, next_skip:(skip+count)});
            }
        }
    });
}


var recheckPermissionExists = function(permission_record, freezr_environment, callback) {
    // todo - consider removing this in future - this is redundant if app_handler.setObjectAccess works correctly
    //onsole.log("recheckPermissionExists", permission_record)
    
    var app_config, permission_model, success = false;

    async.waterfall([
    // 0. get app config
        function (cb) {
            file_handler.async_app_config(permission_record.requestee_app, freezr_environment,cb);
        },
    // 1. make sure all data exits and get app permissions and...
    function (got_app_config, cb) {
        app_config = got_app_config;
        permission_model= (app_config && app_config.permissions && app_config.permissions[permission_record.permission_name])? app_config.permissions[permission_record.permission_name]: null;

        if (!app_config){
            cb(helpers.app_data_error(exports.version, "recheckPermissionExists", permission_record.requestee_app, "missing or removed app_config"));
        } else if (!permission_model){
            cb(helpers.app_data_error(exports.version, "recheckPermissionExists", permission_record.requestee_app, "missing or removed app_config"));
        } else {
            freezr_db.permission_by_owner_and_permissionName (permission_record._owner, permission_record.requestor_app, permission_record.requestee_app, permission_record.permission_name, cb)
        }
    },
        /* from setObjectAccess for permission_record
        var unique_object_permission_attributes =
            {   'requestor_app':req.params.requestor_app,
                'requestee_app':requestee_app,
                '_owner':req.session.logged_in_user_id,
                'permission_name':req.params.permission_name,
                'collection_name': collection_name,
                'data_object_id': data_object_id,
                'shared_with_group':new_shared_with_group
                '_id':requestee_app+"_"+req.session.logged_in_user_id+"_"+data_object_id;

                also: data_object
            }
        */

    // 2.  if granted, success
    function (results, cb) {
        function app_auth(message) {return helpers.auth_failure("public_handler", exports.version, "dbp_query", message);}
        if (!results || results.length==0) {
            cb(app_auth("permission does not exist"));
        }  else if (!results.length>1) {
            cb(app_auth("internal error - more than one permission retrieved."));
        }  else if (!results[0].granted) {
            cb(app_auth("permission no longer granted."));
        } else {
            success = true;
            cb(null)
        }
    },
    ],
    function(err, results){
        if (err) {
            helpers.app_data_error(exports.version, "recheckPermissionExists", permission_record.requestee_app, err)
            callback(err, {'_id':permission_record.data_object_id, success:success})
        } else {
            callback(null, {'_id':permission_record.data_object_id, success:success});
        }
    })

}

// ancillary functions and name checks
    function isEmpty(obj) {
      // stackoverflow.com/questions/4994201/is-object-empty
        if (obj == null) return true;
        if (obj.length > 0)    return false;
        if (obj.length === 0)  return true;
        for (var key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) return false;
        }
        return true;
    }
    function firstElementKey(obj) {
        if (obj == null) return null;
        if (obj.length === 0)  return null;
        for (var key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) return key;
            break;
        }
        return null;
    }

    var folder_name_from_id = function(the_user, the_id) {
        return the_id.replace((the_user+"_"),"");
    }
    var formatDates = function(permission_record, app_config) {
        var coreDateList = ['_date_Modified','_date_Created']
        coreDateList.forEach(function(name) {
            var aDate = new Date(permission_record[name])
            permission_record[name] = aDate.toLocaleString();
         })
        var field_names = (app_config && 
            app_config.collections && 
            app_config.collections[permission_record._collection_name] && 
            app_config.collections[permission_record._collection_name].field_names)? app_config.collections[permission_record._collection_name].field_names: null;
        if (field_names){
            for (var name in field_names) {
                if (Object.prototype.hasOwnProperty.call(field_names, name)) {
                    if (field_names[name].type == "date" && permission_record[name]) {
                        var aDate = new Date(permission_record[name])
                        permission_record[name] = aDate.toDateString()
                    } 
                };
            }
        }
        return permission_record;
    }



/* Todo - to be redone, or integrated into above
exports.getPublicDataObject= function(req, res) {
    // todo - Needs to be redone for files only
}
*/