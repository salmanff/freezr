// freezr.info - nodejs system files - public_handler.js
exports.version = "0.0.122";

var helpers = require('./helpers.js'),
    db_handler = require("./db_handler.js"),
    async = require('async'),
    file_handler = require('./file_handler.js');

const ALL_APPS_HMTL_CONFIG = { // html and configuration for generic public pages
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
    },
    ALL_APPS_RSS_CONFIG = { // html and configuration for generic public pages
        'meta': {
            'app_display_name':"freezr - Public RSS feed",
            'app_version': "0.0.1"
        },
        'public_pages' : {
            "allPublicRSS" : {
                'xml_file':"rss.xml",
                'page_title':"RSS feed "
            }
        }
    },

    genericHTMLforRecord = function(record) {
        const RECORDS_NOT_SHOW = ["_accessible_By","_date_Created","_date_Modified","_date_Accessibility_Mod","_date_Published","_owner", "_app_name","_permission_name","_collection_name","_id"]
        var text = "<div class='freezr_public_genericCardOuter freezr_public_genericCardOuter_overflower'>"
        text+= '<div class="freezr_public_app_title">'+record._app_name+"</div>";
        text+= '<br><div class="freezr_public_app_title">The developer has not defined a format for this record.</div><br>';
        text += "<table>"
        for (var key in record) {
            if (Object.prototype.hasOwnProperty.call(record, key) && RECORDS_NOT_SHOW.indexOf(key)<0) {
              // "_date_Published","_owner":"publisher", "_app_name"
              text+= "<tr style='width:100%; font-size:12px; overflow:normal'><td style='width:100px'>"+key +": </td><td>"+((typeof record[key] ==="string")? record[key] : JSON.stringify(record[key]) )+"</td></tr>"
            }
        }
        text+= "<tr style='width:100%; font-size:12px; overflow:normal'><td style='width:100px'>"+" </td><td>"+"</td></tr>"
        text+= "<tr style='width:100%; font-size:12px; overflow:normal'><td style='width:100px'>"+"Published by" +": </td><td>"+record._owner+"</td></tr>"
        let theDate = new Date(record._date_Published || record._date_Modified)
        text+= "<tr style='width:100%; font-size:12px; overflow:normal'><td style='width:100px'>"+" on (date) " +": </td><td>"+theDate.toLocaleDateString()+"</td></tr>"
        text+= "<tr style='width:100%; font-size:12px; overflow:normal'><td style='width:100px'>"+" with app " +": </td><td>"+record._app_name+"</td></tr>"

        text+="</table>"
        text+="</div>"
        return text;
    }

exports.generatePublicPage = function (req, res) {
    //    app.get('/pcard/:user_id/:app_name/:collection_name/:data_object_id'
    //    app.get('/pcard/:user_id/:requestor_app/:permission_name/:app_name/:collection_name/:data_object_id', addVersionNumber, public_handler.generatePublicPage);
    //    app.get('/v1/pobject/:user_id/:app_name/:collection_name/:data_object_id', public_handler.generatePublicPage); // collection_name is files
            // Note: for pcard, app_name is requestee_app

    //    app.get('/papp/:app_name/:page', addVersionNumber, public_handler.generatePublicPage);
    //    app.get('/papp/:app_name', addVersionNumber, public_handler.generatePublicPage);
    //    app.get('/ppage/:object_id', addVersionNumber, public_handler.generatePublicPage);
    //    app.get('/ppage', addVersionNumber, public_handler.generatePublicPage);
    //    app.get('/rss', addVersionNumber, public_handler.generatePublicPage);

    console.log("generating public page ",req.url," with query ",req.query);

    var isCard    = helpers.startsWith(req.path,"/pcard");
    var isRss     = helpers.startsWith(req.path,"/rss.xml");
    var objectOnly= helpers.startsWith(req.path,"/v1/pobject/");
    var allApps   = (!isCard && !req.params.app_name);
    var app_name  = allApps? "info.freezr.public" : req.params.app_name;
    var useGenericFreezrPage = allApps;

    let page_name = (req.params && req.params.page)? req.params.page: null;
    let page_params = {};

    file_handler.async_app_config(app_name, req.freezr_environment, function (err, app_config) {
        if (!page_name && app_config && app_config.public_pages) page_name = firstElementKey(app_config.public_pages);
        if (page_name && helpers.endsWith(page_name, '.html')) page_name = page_name.slice(0,-5);
        if (allApps) app_config  = ALL_APPS_HMTL_CONFIG;
        if (isRss) app_config = ALL_APPS_RSS_CONFIG;
        if (err || !app_config || !app_config.public_pages ||
                   (isRss && !app_config.public_pages.allPublicRSS)  ||
                   (!isRss && (!app_config.public_pages &&
                              !(app_config.public_pages.allPublicRecords ||
                                  (app_config.public_pages[page_name] && app_config.public_pages[page_name].html_file))))
                 ){

            if (err) {helpers.state_error("public_handler", exports.version, "generatePublicPage", err, "Problem getting App Config for ppage on "+app_name ) }
            if (isCard || isRss || objectOnly){
              err = helpers.error("missing_app_config","app config missing while accessing public "+ (isCard?"card.":"page."))
              helpers.send_failure(res, err, "public_handler", exports.version, "generatePublicPage");
            } else {
              res.redirect('/ppage?redirect=true&error=nosuchpagefound'+(app_name?("&app_name="+app_name):"")+(page_name?("&page_name="+page_name):"")+(err?("&error=NoAppConfig"):"") )
            }
        } else { // Main Case
            if (isRss) {
                useGenericFreezrPage = true;
                page_params = app_config.public_pages.allPublicRSS
            } else if (!page_name || !app_config.public_pages[page_name] || !app_config.public_pages[page_name].html_file) {
                useGenericFreezrPage = true;
                page_params = app_config.public_pages.allPublicRecords
            } else {
                page_params = app_config.public_pages[page_name];
            }
            if (!isCard && !objectOnly) {
                var options = {
                    page_url: page_params.html_file,
                    xml_url: page_params.xml_file,
                    page_title: (page_params.page_title? page_params.page_title:"Public info")+" - freezr.info",
                    css_files: [], // page_params.css_files,
                    query_params: page_params.initial_query? page_params.initial_query: {},
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
                    isRss: isRss,
                    useGenericFreezrPage: useGenericFreezrPage
                }

                // query_params can come from req.query and initial query
                Object.keys(req.query).forEach(function(key) {
                    options.query_params[key] = req.query[key]
                });

                parse_attached_files(
                    options,
                    page_params,
                    function(final_options) {gotoShowInitialData(res, req.freezr_environment, final_options)}
                );

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
                            html_file = ALL_APPS_HMTL_CONFIG.public_pages.allPublicRecords.html_file;
                        } else {
                            record = formatFields(results.results[0]);
                            html_file = (app_config && app_config.permissions && app_config.permissions[record._permission_name] && app_config.permissions[record._permission_name].pcard)? app_config.permissions[record._permission_name].pcard : null;
                        }
                        if (objectOnly) {
                            helpers.send_success(res, {'results':record});
                        } else if (html_file) {
                            var Mustache = require('mustache');
                            // todo add option to wrap pcard in html header
                            file_handler.get_file_content(app_name, "public"+file_handler.sep()+html_file , req.freezr_environment, function(err, html_content) {
                                if (err) {
                                    helpers.send_failure(res, helpers.error("file missing","html file missing - cannot generate card without a card html ("+page_name+")in app:"+app_name+"."), "public_handler", exports.version, "generatePublicPage" )

                                } else {
                                    // todo may be "if html file is emppty generate generic page todo now")
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
    //onsole.log("gotoShowInitialData")
    var req= {freezr_environment: freezr_environment}
    if (!options) options = {};
    if (!options.query_params) options.query_params = {};
    var display_more=true;
    req.query = options.query_params;
    const MAX_PER_PAGE=10;

    if (!req.query.count) req.query.count = MAX_PER_PAGE;
    //onsole.log("gotoShowInitialData "+JSON.stringify( options))

    if (!options.query_params){
        file_handler.get_file_content(options.app_name, "public"+file_handler.sep()+options.page_url , freezr_environment, function(err, html_content) {
            if (err) {
                helpers.send_failure(res, helpers.error("file missing","html file missing - cannot generate page without file page_url 4 ("+options.page_url+")in app:"+options.app_name+" public folder (no data)."), "public_handler", exports.version, "gotoShowInitialData" )
            } else {
                options.page_html= html_content;
                file_handler.load_page_html(res,options)
            }
        });
    } else if (options.isRss) {
        req.url = ':/rss.xml';
        //if (!options.allApps) req.query.app_name = options.app_name;
        req.freezrInternalCallFwd = function(err, results) {
            var rss_records=[];
            var renderStream = function () {
                file_handler.get_file_content("info.freezr.public", "public"+file_handler.sep()+options.xml_url , freezr_environment, function(err, xml_content) {
                    if (err) {
                        helpers.send_failure(res, helpers.error("file missing","html file missing - cannot generate page without file xml_url ("+options.xml_url+")in app:"+options.app_name+" publc folder."), "public_handler", exports.version, "gotoShowInitialData" );
                    } else {
                        var page_components = {
                            page_title:options.page_title,
                            server_name: options.server_name,
                            app_name: (options.allApps? "": options.app_name),
                            results: rss_records
                        }

                        try {
                            options.page_xml= Mustache.render(xml_content, page_components);
                        } catch (e) {
                            helpers.state_error("public_handler", exports.version, "gotoShowInitialData", e, "mustache err" )
                            options.page_xml = "<error>Error in processing mustached app xml</error>"
                        }

                        file_handler.load_page_xml(res,options)
                    }
                });
            }

            var app_configs= {}, app_cards = {}, html_file, html_content, app_config, logos= {};
            var Mustache = require('mustache');
            if (!results || !results.results || results.results.length == 0) {
                renderStream();
            } else { // add card to each record (todo - this should be done in dbp_query as an option req.paras.addcard)
                var transformToRSS = function(permission_record, app_config) {
                    permission_record = formatFields(permission_record, app_config)
                    const RSS_FIELDS = ["title","description","imgurl","imgtitle","pubDate"]
                    var temp_obj = {};
                    var rss_map = (app_config.collections && app_config.collections[permission_record._collection_name] &&  app_config.collections[permission_record._collection_name].rss_map)? app_config.collections[permission_record._collection_name].rss_map:{};
                    RSS_FIELDS.forEach((anRSSField) => {temp_obj[anRSSField] = permission_record[(rss_map && rss_map[anRSSField]? rss_map[anRSSField]:anRSSField)] })
                    temp_obj.application=permission_record._app_name;
                    temp_obj.link = temp_obj.link || (options.server_name + "/ppage/"+permission_record._id  )

                    if (!temp_obj.title && !temp_obj.description && !temp_obj.imageurl) return null
                    return temp_obj;
                }

                async.forEach(results.results, function (permission_record, cb2) {
                    html_content=null, html_file=null, arecord = null;
                    if (!permission_record || !permission_record._app_name) { // (false) { //
                        helpers.app_data_error(exports.version, "public_handler:gotoShowInitialData:freezrInternalCallFwd", "no_permission_or_app", "Uknown error - No permission or app name for a record ");
                    } else {
                        if (!app_configs[permission_record._app_name]) {
                            file_handler.async_app_config(permission_record._app_name, req.freezr_environment,function (err, app_config) {
                                if (err) {
                                    helpers.app_data_error(exports.version, "public_handler:gotoShowInitialData:freezrInternalCallFwd", "ignore_error_getting_config", err.message);
                                } else {
                                    app_configs[permission_record._app_name]= app_config;
                                    arecord = transformToRSS(permission_record, app_configs[permission_record._app_name])
                                    if (arecord) rss_records.push(arecord);
                                }
                            });
                        } else {
                            arecord = transformToRSS(permission_record, app_configs[permission_record._app_name])
                            if (arecord) rss_records.push(arecord);
                        }
                    }
                    cb2(null);
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
    } else if (options.useGenericFreezrPage) {
        req.url = '/ppage';
        if (!options.allApps) req.query.app_name = options.app_name;
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
                        current_search =  req.query.search && req.query.search.length>0? (req.query.search):"";
                        current_search += req.query.user_id && req.query.user_id.length>0? ( (current_search.length>0?"&":"") + "user:"+req.query.user_id):"";
                        current_search += req.query.app_name && req.query.app_name.length>0? ((current_search.length>0?"&":"") + "app:"+req.query.app_name):"";
                        search_url =  req.query.search && req.query.search.length>0? ("q="+req.query.search):"";
                        search_url += req.query.user_id && req.query.user_id.length>0? ((search_url.length>0?"&":"") + "user="+req.query.user_id):"";
                        search_url += req.query.app_name && req.query.app_name.length>0? ((search_url.length>0?"&":"") + "app="+req.query.app_name):"";
                        search_url += (search_url.length>0?"&":"") + "skip="+(parseInt(req.query.skip || 0) + parseInt(req.query.count || 0));

                        var page_components = {
                            skipped: parseInt(req.query.skip || 0),
                            counted: parseInt(req.query.count || 0),
                            display_more : (display_more?"block":"none"),
                            user_id: req.query.user_id? req.query.user_id: "",
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
                display_more = results.results.length>=(req.query.count) // this can lead to a problem if a permission is not allowed - todo : in query send back record with a not_permitted flag
                var permission_record_card_create = function(permission_record, app_config) {
                    var temp_card = formatFields(permission_record, app_config)
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
                                                 app_configs[permission_record._app_name].permissions[permission_record._permission_name].pcard);

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
        req.url = options.query_params.url;
        if (!options.allApps) req.query.app_name = options.app_name;
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
                                results.results[i] = formatFields(results.results[i], app_config)
                            }
                        }
                        if (app_config && app_config.public_pages && app_config.public_pages[options.page_name] && app_config.public_pages[options.page_name].header_map) {
                            options.meta_tags = createHeaderTags(app_config.public_pages[options.page_name].header_map, results.results)
                        } else {
                            options.meta_tags =createHeaderTags(null,results.results)
                        }

                        var html_file = (app_config && app_config.public_pages && app_config.public_pages[options.page_name] && app_config.public_pages[options.page_name].html_file)? app_config.public_pages[options.page_name].html_file: null;
                        if (!html_file) {
                            helpers.send_failure(res, helpers.error("file missing","html file missing - cannot generate page without file page_url 2 ("+html_file+")in app:"+options.app_name+" publc folder."), "public_handler", exports.version, "gotoShowInitialData" )
                        } else {
                            file_handler.get_file_content(req.query.app_name, "public"+file_handler.sep()+html_file , freezr_environment, function(err, html_content) {
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

exports.generatePublicObjectPage = function (req, res) {
    //    app.get('/ppage/:object_public_id', addVersionNumber, public_handler.generatePublicPage);

    req.freezrInternalCallFwd = function(err, results) {
        //onsole.log(results)
        if (!results.results || results.results.length == 0 || !results.results[0]) {
            res.redirect('/ppage?redirect=true&error=nosuchpublicobject&pid='+req.params.object_public_id)
        } else {
            theObj = results.results[0];
            file_handler.async_app_config(theObj._app_name, req.freezr_environment,function (err, app_config) {
                if (err) {ount

                    helpers.send_failure(res, err, "public_handler", exports.version, "generatePublicObjectPage" )
                } else if (!app_config){
                    helpers.send_failure(res, helpers.error("missing app_config"), "public_handler", exports.version, "generatePublicObjectPage" )
                } else if (!app_config.permissions[theObj._permission_name]){
                    helpers.send_failure(res, helpers.error("missing permission"), "public_handler", exports.version, "generatePublicObjectPage" )
                } else {
                    var Mustache = require('mustache');
                    theObj = formatFields(theObj, app_config);
                    var page_name = (app_config.permissions[theObj._permission_name].ppage);
                    var html_file = (app_config && app_config.public_pages && page_name && app_config.public_pages[page_name] && app_config.public_pages[page_name].html_file)? app_config.public_pages[page_name].html_file: null;
                    if (!page_name || !html_file) {
                        if (!page_name) {
                            console.warn("DEVELOPPER ERROR - Public page (ppage) missing in configuration.")
                        } else {
                            console.warn("html page missing in configuration")
                        }
                        html_file = (app_config && app_config.permissions && app_config.permissions[theObj._permission_name] && app_config.permissions[theObj._permission_name].pcard)? app_config.permissions[theObj._permission_name].pcard : null;
                        if (html_file) console.warn(".. using pcard reference instead ");
                    }

                    file_handler.get_file_content(theObj._app_name, "public"+file_handler.sep()+html_file , req.freezr_environment, function(err, html_content) {
                        if (err) {
                            contents = genericHTMLforRecord(theObj);
                            res.writeHead(200, { "Content-Type": "text/html" });
                            res.end(contents);

                        } else {

                            var page_params = app_config.public_pages[page_name] || {};
                            var options = {
                                page_url: html_file,
                                page_title: (page_params.page_title? page_params.page_title:"Public info")+" - freezr.info",
                                css_files: [], // page_params.css_files,
                                initial_query: page_params.initial_query? page_params.initial_query: {},
                                script_files: [], //, //[],
                                app_name: theObj._app_name,
                                app_display_name : ( (app_config && app_config.meta && app_config.meta.app_display_name)? app_config.meta.app_display_name:app_name) ,
                                app_version: (app_config && app_config.meta && app_config.meta.app_version)? app_config.meta.app_version:"N/A",
                                freezr_server_version: req.freezr_server_version,
                                other_variables: null,
                                server_name: req.protocol+"://"+req.get('host'),

                                // extra items
                                page_name: page_name,
                                isPublic: true,
                                allApps: false,
                                useGenericFreezrPage: false
                            }
                            try {
                                options.page_html =  Mustache.render(html_content, results.results[0]);
                            } catch (e) {
                                options.page_html = "Error in processing mustached app html - "+JSON.stringify(e)+"</br>"+html_content
                            }

                            if (app_config && app_config.public_pages && app_config.public_pages[options.page_name] && app_config.public_pages[options.page_name].header_map) {
                                options.meta_tags = createHeaderTags(app_config.public_pages[options.page_name].header_map, [theObj])
                            } else {
                                options.meta_tags =createHeaderTags(null,[theObj])
                            }

                            parse_attached_files(
                                options,
                                page_params,
                                function(final_options) {file_handler.load_page_html(res,final_options)}
                            );
                        }
                    })
                }
            })
        }
    }
    req.body.pid = req.params.object_public_id;
    exports.dbp_query(req,res);
};
function parse_attached_files(options, page_params, callback ){
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

    if (outside_scripts.length>0) {
        db_handler.all_userAppPermissions(req.freezr_environment, req.session.logged_in_user_id, req.params.app_name, function(err, perm_list, cb) {
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
                callback(options);
            }
        })
    } else {
        callback(options);
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
        - pid
        -
        - query_params (for post only)
    */


    console.log("dbp_query body ",req.body, " params ",req.params, " query ",req.query);

    if (helpers.isEmpty(req.query)) req.query=req.body; // make post and get equivalent
    if (!req.query) req.query = {};

    var data_records= [],
        errs = [],
        skip = (req.query && req.query.skip)? parseInt(req.query.skip): 0 ,
        count= (req.query && req.query.count)? parseInt(req.query.count): 10,
        sort =  {'_date_Published': -1}

    var permission_attributes = {
        granted: true,
        shared_with_group: 'public'
    };
    const VALID_SEARCH_PARAMS = ["data_owner","_owner","_id","requestee_app"];
    VALID_SEARCH_PARAMS.forEach((aParam) => {if (req.query[aParam]) {permission_attributes[aParam] = req.query[aParam].toLowerCase()}})

    // note conflict if have app_name and requestee_app and req.param
    if (req.query.app_name) permission_attributes.requestee_app = req.query.app_name.toLowerCase();
    if (req.query.app) permission_attributes.requestee_app = req.query.app.toLowerCase();
    if (req.params && req.params.app_name) permission_attributes.requestee_app = req.params.app_name.toLowerCase();
    if (req.query.user_id && !permission_attributes._owner) permission_attributes._owner = req.query.user_id.toLowerCase();
    if (req.query.pid && !permission_attributes._id) permission_attributes._id = req.query.pid;

    if (req.query.maxdate) permission_attributes._date_Published ={'$lt': parseInt(req.query.maxdate)}
    if (req.query.mindate) permission_attributes._date_Published ={'$gt': parseInt(req.query.mindate)}

    if (req.query.search || req.query.q) {
        req.query.search = decodeURIComponent(((req.query.search || "") + " "+(req.query.q || "")).trim()).toLowerCase();
        if (req.query.search.indexOf(' ')<0) {
            permission_attributes.search_words = req.query.search;
        } else {
            var theAnds = [permission_attributes];
            var searchterms = req.query.search.split(' ');
            searchterms.forEach(function(aterm) {theAnds.push({'search_words':aterm})});
            permission_attributes = {'$and':theAnds}
        }
    }

    function app_err(message) {return helpers.app_data_error(exports.version, "dbp_query", "public query for "+(req.body.app_name || ((req.params && req.params.app_name)? req.params.app_name: null) || "all apps"), message);}
    function app_auth(message) {return helpers.auth_failure("public_handler", exports.version, "dbp_query", message);}

    async.waterfall([
        // 1 / 2. get the permission
        function (cb) {
          const accessibles_collection = {
            app_name:'info_freezr_permissions',
            collection_name:"accessible_objects",
            _owner:'freezr_admin'
          }
          db_handler.db_find (req.freezr_environment, accessibles_collection, permission_attributes, {sort:sort, count:count, skip:skip}, cb)
        },
        // 3 see permission record and make sure it is still granted
        function (results, cb) {
            if (!results || results.length==0) {
                cb(null);
            }  else {
                //onsole.log("QUERY RESULTS")
                //onsole.log(results)
                async.forEach(results, function (permission_record, cb2) {
                    recheckPermissionExists(req.freezr_environment, permission_record, req.freezr_environment,  function (err, results) {
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
                            permission_record.data_object._date_Published = permission_record._date_Published;
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
            var sortBylastPubDate = function(obj1,obj2) { return obj2._date_Published - obj1._date_Published; }
            data_records = data_records.sort(sortBylastPubDate)
            if (req.freezrInternalCallFwd) {
                //if (errs && errs.length>0) //onsole.log("end of query with "+data_records.length+" results and errs "+JSON.stringify(errs))
                req.freezrInternalCallFwd(null, {results:data_records, errors:errs, next_skip:(skip+count)});
            } else {
                helpers.send_success(res, {results:data_records, errors:errs, next_skip:(skip+count)});
            }
        }
    });
}


exports.get_data_object= function(req, res) {
    //    app.get('/v1/publicfiles/:requestee_app/:user_id/*', addVersionNumber, public_handler.get_data_object); // collection_name is files
    //  (not tested:) app.get('/v1/db/getbyid/:requestee_app/:collection_name/:data_object_id', app_handler.getDataObject); // here request type must be "one"

    // Initialize variables
        var app_config, permission_model, collection_name, requestedFolder, parts, user_id, resulting_record, possible_permissions=[], data_object_id;
        var record_is_permitted = false;
        var flags = new Flags({'app_name':req.params.requestee_app});

        var request_file = helpers.startsWith(req.path,"/v1/publicfiles") ;
        if (request_file) {
            parts = req.originalUrl.split('/');
            parts = parts.slice(4);
            requestedFolder = parts.length==2? "/": (parts.slice(1,parts.length-1)).join("/");
            data_object_id = decodeURI( parts.join("/"));
            collection_name = "files"
            user_id = parts[0]+""
        } else {
            data_object_id = req.params.data_object_id;
            collection_name = req.params.collection_name;
            user_id = req.params.user_id;
        }

        const appcollowner = {
          app_name:req.params.requestee_app,
          collection_name:collection_name,
          _owner:user_id
        }
        const accessibles_collection = {
          app_name:'info_freezr_permissions',
          collection_name:"accessible_objects",
          _owner:'freezr_admin'
        }
        function app_err(message) {return helpers.app_data_error(exports.version, "get_data_object", req.params.requestee_app, message);}
        function app_auth(message) {return helpers.auth_failure("public_handler", exports.version, "get_data_object", message);}

    //onsole.log("public_handler getDataObject "+data_object_id+" from coll "+collection_name);

    async.waterfall([
        // 0. get app config
        function (cb) {
            file_handler.async_app_config(req.params.requestee_app, req.freezr_environment,cb);
        },

        // 1,2,3. make sure all data exits and get the record
        function (got_app_config, cb) {
            app_config = got_app_config;
            if (!data_object_id){
                cb(app_err("missing data_object_id"));
            } else if (!app_config){
                cb(app_err("missing app_config"));
            } else if (!collection_name){
                cb(app_err("missing collection_name"));
            } else {
              db_find(req.freezr_environment, appcollowner, {'_id':data_object_id}, {}, cb)
            }
        },


        // 4. check if record fits permission criteria
        function (results, cb) {
            if (!results || results.length==0) {
                cb(app_err("no related records"))
            } else {
                if (results.length>1) {
                    console.warn('MoreThanOneRecordRetrieved - SNBH')
                    flags.add('warnings','MoreThanOneRecordRetrieved - SNBH');
                }
                resulting_record = results[0];

                if (resulting_record._accessible_By && resulting_record._accessible_By.groups && resulting_record._accessible_By.groups.indexOf("public")>-1) {
                    cb(null)
                } else cb(app_err("permission not granted"))
            }
        },

        // The rest of this is double checking that permission is still granted. (normaly if not granted, the field is remvoed as well)
        // 5. Deal with permissions and get app permissions and if granted, open field_permissions or object_permission collection
        // 6. check the permission - for files, could be one of many
        function (cb) {
            possible_permissions = (resulting_record && resulting_record._accessible_By && resulting_record._accessible_By.group_perms && resulting_record._accessible_By.group_perms.public && resulting_record._accessible_By.group_perms.public.length>0)? resulting_record._accessible_By.group_perms.public:null;

            if (req.params.permission_name && possible_permissions.indexOf(req.params.requestee_app+"/"+req.params.permission_name)<0) {
                cb(app_err("specific permission not granted - ther permissions may be"))
            } else {
                async.forEach(possible_permissions, function (perm_string, cb2) {
                    var permission_name=perm_string.split('/')[1]
                    var a_perm_model= (app_config && app_config.permissions && app_config.permissions[permission_name])? app_config.permissions[permission_name]: null;
                    var permission_type = (a_perm_model && a_perm_model.type)? a_perm_model.type: null;
                    if (!a_perm_model || !permission_type || (helpers.permitted_types.type_names.indexOf(permission_type)<0 && permission_type!="db_query")) {
                        cb2(null);
                    } else {
                        db_handler.permission_by_owner_and_permissionName (req.freezr_environment, user_id, req.params.requestee_app, req.params.requestee_app, permission_name, function(err, results){
                            if (!results || results.length==0 || !results[0].granted) {
                                //onsole.log("no results")
                            }  else  { // it is granted and (permission_type=="object_delegate")
                                if (results[0].collections.indexOf(collection_name)>-1) {
                                    record_is_permitted = true;
                                    permission_model = a_perm_model;
                                }
                            }
                            cb2(null)
                        })
                    }
                },
                function (err) {
                    if (err) {helpers.state_error("public_handler", exports.version, "get_data_object", err, "async err" )}
                    cb(null)
                });
            }
        }
    ],
    function (err) {
        if (err) {helpers.state_error("public_handler", exports.version, "get_data_object", err, "waterfall err" )}
        if (!record_is_permitted) {
            if (request_file){
                res.sendStatus(401);
            } else {
                helpers.send_failure(res, err, "app_handler", exports.version, "getDataObject");
            }
        } else if (request_file){
            var filePath = "userfiles/"+parts[0]+"/"+req.params.requestee_app+"/"+unescape(parts.slice(1).join("/"));
            if (flags.warnings) console.warn("flags:"+JSON.stringify(flags))
            file_handler.sendUserFile(res, filePath, req.freezr_environment );
        } else {
            var send_record = {};
            if (permission_model.return_fields && permission_model.return_fields.length>0) {
                permission_model.return_fields.forEach((aField) => {send_record[aField] =  resulting_record[aField]})
            } else {send_record = resulting_record;}
            helpers.send_success(res, {'results':send_record, 'flags':flags});
        }
    });
}


var recheckPermissionExists = function(env_params, permission_record, freezr_environment, callback) {
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
            //onsole.log("permission_record")
            //onsole.log(permission_record)
            if (!permission_record.data_owner && permission_record._owner!="freezr_admin") permission_record.data_owner=permission_record._owner; // fixing legacy
            db_handler.permission_by_owner_and_permissionName (env_params, permission_record.data_owner, permission_record.requestor_app, permission_record.requestee_app, permission_record.permission_name, cb)
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
    var formatFields = function(permission_record, app_config) {
        var coreDateList = ['_date_Modified','_date_Created','_date_Published']
        coreDateList.forEach(function(name) {
            var aDate = new Date(permission_record[name])
            permission_record["_"+name] = aDate.toLocaleString();
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
    var createHeaderTags = function(header_map,results) {
        // Creates header meta tags for the page - if more than one results is passed, only text fields will be used.
        var headertext = (results && results[0] && results[0]._app_name)? '<meta name="application-name" content="'+results[0]._app_name+' - a freezr app" >':'';
        if (header_map){
            Object.keys(header_map).forEach(function(aHeader) {
                var keyObj = header_map[aHeader];
                if (keyObj.field_name && results && results[0] && results[0][keyObj.field_name]) {
                    headertext+='<meta name="'+aHeader+'" content="'+(keyObj.text? (keyObj.text+" "):"")+results[0][keyObj.field_name]+'" >'
                } else if (keyObj.text) {
                    headertext+='<meta name="'+aHeader+'" content="'+keyObj.text+' - a freezr app" >'
                }
            })}
        return headertext;
    }
