// freezr.info - nodejs system files - public_handler.js

// THIS NEEDS TO BE REVIEWED - (2024))

exports.version = '0.0.200'

const helpers = require('./helpers.js')
const async = require('async')
const fileHandler = require('./file_handler.js')

const ALL_APPS_HMTL_CONFIG = { // html and configuration for generic public pages
  display_name: 'freezr - All public cards',
  version: '0.0.2',
  public_pages: {
    allPublicRecords: {
      html_file: 'allpublicrecords.html',
      css_files: ['allpublicrecords.css'],
      script_files: ['allpublicrecords.js']
    }
  }
}
const ALL_APPS_RSS_CONFIG = { // html and configuration for generic public pages
  meta: {
    app_display_name: 'freezr - Public RSS feed',
    app_version: '0.0.2'
  },
  public_pages: {
    allPublicRSS: {
      xml_file: 'rss.xml',
      page_title: 'RSS feed '
    }
  }
}

const genericHTMLforRecord = function (record) {
  const RECORDS_NOT_SHOW = ['_accessible_By', '_date_created', '_date_modified', '_date_accessibility_mod', '_date_published', '_app_name', '_data_owner', '_permission_name', '_collection_name'] // , '_id'
  let text = "<div class='freezr_public_genericCardOuter freezr_public_genericCardOuter_overflower'>"
  text += '<div class="freezr_public_app_title">' + record._app_name + '</div>'
  text += '<br><div class="freezr_public_app_title">The developer has not defined a format for this record.</div><br>'
  text += '<table>'
  for (const key in record) {
    if (Object.prototype.hasOwnProperty.call(record, key) && RECORDS_NOT_SHOW.indexOf(key) < 0) {
      // "_date_published","publisher", "_app_name"
      text += "<tr style='width:100%; font-size:12px; overflow:normal'><td style='width:100px'>" + key + ': </td><td>' + ((typeof record[key] === 'string') ? record[key] : JSON.stringify(record[key])) + '</td></tr>'
    }
  }
  text += "<tr style='width:100%; font-size:12px; overflow:normal'><td style='width:100px'>" + ' </td><td>' + '</td></tr>'
  const theDate = new Date(record._date_published || record._date_modified)
  text += "<tr style='width:100%; font-size:12px; overflow:normal'><td style='width:100px'>" + 'Published by' + ': </td><td>' + record._data_owner + ' on ' + theDate.toLocaleDateString() + '</td></tr>'
  // text += "<tr style='width:100%; font-size:12px; overflow:normal'><td style='width:100px'>"+" on (date) " +": </td><td>"+theDate.toLocaleDateString()+"</td></tr>"
  // text += "<tr style='width:100%; font-size:12px; overflow:normal'><td style='width:100px'>"+" with app " +": </td><td>"+record._app_name+"</td></tr>"

  text += '</table>'
  text += '</div>'
  return text
}

exports.generatePublicPage = function (req, res) {
  /*
  app.get('/papp/@:user_id/:app_name/:page', publicUserPage, addPublicRecordsDB, hasAtLeastOnePublicRecord, addPublicUserFs, publicHandler.generatePublicPage)
  app.get('/papp/@:user_id/:app_name', publicUserPage, addPublicRecordsDB, hasAtLeastOnePublicRecord, addPublicUserFs, publicHandler.generatePublicPage)
  app.get('/public/@:user_id', publicUserPage, addPublicRecordsDB, hasAtLeastOnePublicRecord, publicHandler.generatePublicPage)
  app.use('/public', redirectOrMainPublic, publicUserPage, addPublicRecordsDB, publicHandler.generatePublicPage)
  app.get('/rss.xml', publicUserPage, addPublicRecordsDB, publicHandler.generatePublicPage)

  removed app.get('/v1/pobject/:user_id/:requestee_app_table/:data_object_id', addPublicRecordsDB, publicHandler.generatePublicPage)
  */
  fdlog('generatePublicPage')

  // NB needs to reviewed and redone - (partially redid with no real error checking in 2024)

  // const isCard = helpers.startsWith(req.path, '/pcard')
  const isRss = helpers.startsWith(req.path, '/rss.xml')
  const objectOnly = helpers.startsWith(req.path, '/v1/pobject/')
  req.params.isAppSPecificPage = req.url.indexOf('/papp/') === 0
  const allApps = ['/rss.xml'].includes(req.path) || req.params?.app_name === 'info.freezr.public'
  req.params.allApps = allApps
  const appName = allApps ? null : req.params.app_name
  let useGenericFreezrPage = allApps
  const userId = req.params.user_id

  if (req.query && req.query.user && !req.params.user_id) req.params.user_id = req.query.user
  if (req.query && req.query.u && !req.params.user_id) req.params.user_id = req.query.u

  fdlog('generating public page ', req.url, ' with query ', req.query, 'path ', req.path, { allApps, userId, appName })

  let pageName = (req.params && req.params.page) ? req.params.page : null
  let pageParams = {}

  req.params.doNotGetDoNotLists = true

  const theQuery = { }
  if (userId) theQuery.user_id = userId
  if (appName && appName !== 'info.freezr.public') theQuery.app_name = appName
  if (req.params.requestee_app_table) theQuery['manifest.permissions'] = { $elemMatch: { table_id: req.params.requestee_app_table } }

  req.freezrPublicManifestsDb.query(theQuery, null, (err, results) => {
    // note: this is not needed when have allApps so skip errors
    // requestee_app_table // user_id: userId, app_name: appName
    fdlog('freezrPublicManifestsDb', { err, results, userId })

    if (err || !results) {
      felog('todo - redirect to error page - freezrPublicPermDB ', { userId, appName }, err)
      res.sendStatus(401)
    } else {
      let manifest
      if (isRss) manifest = ALL_APPS_RSS_CONFIG
      if (!req.params.isAppSPecificPage) manifest = ALL_APPS_HMTL_CONFIG
      if (pageName || helpers.startsWith(req.url, '/papp')) { // req.params.page
        manifest = (results && results[0]) ? results[0].manifest : null
        if (!pageName && manifest && manifest.public_pages) pageName = firstElementKey(manifest.public_pages)
        if (helpers.endsWith(pageName, '.html')) pageName = pageName.slice(0, -5)
        // if (allApps) manifest = ALL_APPS_HMTL_CONFIG
      }

      if (err || !manifest || !manifest.public_pages ||
        (isRss && !manifest.public_pages.allPublicRSS) ||
        (!isRss && (!manifest.public_pages &&
          !(manifest.public_pages.allPublicRecords ||
            (manifest.public_pages[pageName] && manifest.public_pages[pageName].html_file))))
      ) {
        if (err) { helpers.state_error('public_handler', exports.version, 'generatePublicPage', err, 'Problem getting Mankifest for public on ' + appName) }
        if (isRss) { // } (isCard || isRss || objectOnly) {
          err = helpers.error('missing_manifest', 'app config missing while accessing public page.')
          helpers.send_failure(res, err, 'public_handler', exports.version, 'generatePublicPage')
        } else {
          console.warn('An err.. ', { err, results, manifest, pubrec: manifest?.public_pages, pageName })
          res.redirect('/public?noredirect=true&redirect=true&error=nosuchpagefound' + (appName ? ('&app_name=' + appName) : '') + (pageName ? ('&page_name=' + pageName) : '') + (err ? ('&error=NoManifest') : ''))
        }
      } else if (objectOnly) { // previously had isCard too
        req.freezrInternalCallFwd = function (err, results) {
          fdlog('freezrInternalCallFwd  ', { err, results })
          if (err || !results || !results.results || results.results.length === 0) {
            if (!err) err = new Error('no results')
            helpers.send_failure(res, err, 'public_handler', exports.version, 'generatePublicPage')
          // } else if (req.params.user_id || !req.params.requestee_app_table || !req.params.data_object_id) {
          //   helpers.send_failure(res, new Error('invalid request - no data '), 'public_handler', exports.version, 'generatePublicPage')
          } else {
            const record = formatFields(results.results[0])
            helpers.send_success(res, { results: record })
          }
        }
        // user_id/:requestee_app_table/:data_object_id
        req.body = {
          q: {
            data_owner: req.params.user_id,
            original_app_table: req.params.requestee_app_table,
            original_record_id: req.params.data_object_id
          }
        }
        exports.dbp_query(req, res)
      } else { // Main Case
        if (isRss) {
          useGenericFreezrPage = true
          pageParams = manifest.public_pages.allPublicRSS
        } if (!pageName || !manifest.public_pages[pageName] || !manifest.public_pages[pageName].html_file) {
          useGenericFreezrPage = true
          pageParams = manifest.public_pages.allPublicRecords
        } else {
          pageParams = manifest.public_pages[pageName]
        }
        const options = {
          page_url: pageParams.html_file,
          xml_url: pageParams.xml_file,
          page_title: (pageParams.page_title ? pageParams.page_title : 'Public info') + ' - freezr.info',
          css_files: [], // pageParams.css_files,
          q: pageParams.initial_query ? pageParams.initial_query : {},
          // q: pageParams.initial_query ? { $and: [pageParams.initial_query, { isPublic: true }] } : { isPublic: true },
          script_files: [], //, //[],
          app_name: appName,
          app_display_name: (!req.params.isAppSPecificPage ? 'All Freezr Apps' : ((manifest && manifest.display_name) ? manifest.display_name : appName)),
          app_version: (manifest && manifest.version && req.params.isAppSPecificPage) ? manifest.version : 'N/A',
          freezr_server_version: req.freezr_server_version,
          other_variables: null,
          server_name: req.protocol + '://' + req.get('host'),
          user_id: req.session.user_id,
          user_queried: userId,

          // extra items
          page_name: pageName,
          allApps: !req.params.isAppSPecificPage,
          isRss,
          useGenericFreezrPage
        }

        // q can come from req.query and initial query
        Object.keys(req.query).forEach(function (key) {
          options.q[key] = req.query[key]
        })
        options.q.isPublic = true

        parseAttachedFiles(
          options,
          pageParams,
          function (finalOptions) { gotoShowInitialData(res, req, finalOptions) }
        )
      }
    }
  })
}
const gotoShowInitialData = function (res, req, options) {
  // used when generating a page of accessible items
  fdlog('gotoShowInitialData ', { options })

  if (!options) options = {}
  if (!options.q) options.q = {}
  let displayMore = true
  req.query = options.q
  const MAX_PER_PAGE = 10

  const Mustache = require('mustache')

  if (!req.query.count) req.query.count = MAX_PER_PAGE
  // onsole.log("gotoShowInitialData "+JSON.stringify( options))

  if (!options.q) {
    req.freezrAppFS.readAppFile(('public' + fileHandler.sep() + options.page_url), null, function (err, htmlContent) {
      // old: fileHandler.get_file_content(options.user_id, options.app_name, "public"+fileHandler.sep()+options.page_url , freezr_environment, function (err, htmlContent) {
      if (err) {
        helpers.send_failure(res, helpers.error('file missing', 'html file missing - cannot generate page without file page_url 4 (' + options.page_url + ')in app:' + options.app_name + ' public folder (no data).'), 'public_handler', exports.version, 'gotoShowInitialData')
      } else {
        options.page_html = htmlContent
        fileHandler.load_page_html(req, res, options)
      }
    })
  } else if (options.isRss) {
    req.url = ':/rss.xml'
    // if (!options.allApps) req.query.app_name = options.app_name;
    req.freezrInternalCallFwd = function (err, results) {
      if (err) console.warn('deal with rss error ', err)
      const rssRecords = []
      const renderStream = function () {
        req.freezrAppFS.readAppFile(('public' + fileHandler.sep() + options.xml_url), null, function (err, xmlContent) {
          // old:  fileHandler.get_file_content(null, "info.freezr.public", "public"+fileHandler.sep()+options.xml_url , freezr_environment, function (err, xmlContent) {
          if (err) {
            helpers.send_failure(res, helpers.error('file missing', 'html file missing - cannot generate page without file xml_url (' + options.xml_url + ')in app:' + options.app_name + ' publc folder.'), 'public_handler', exports.version, 'gotoShowInitialData')
          } else {
            const pageComponents = {
              page_title: options.page_title,
              server_name: options.server_name,
              // app_name: (options.allApps ? '' : options.app_name),
              results: rssRecords
            }

            try {
              options.page_xml = Mustache.render(xmlContent, pageComponents)
            } catch (e) {
              helpers.state_error('public_handler', exports.version, 'gotoShowInitialData', e, 'mustache err')
              options.page_xml = '<error>Error in processing mustached app xml</error>"'
            }

            fileHandler.load_page_xml(req, res, options)
          }
        })
      }

      const manifests = {}
      if (!results || !results.results || results.results.length === 0) {
        renderStream()
      } else { // add card to each record (todo - this should be done in dbp_query as an option req.paras.addcard)
        const transformToRSS = function (permissionRecord, manifest) {
          permissionRecord = formatFields(permissionRecord, manifest)
          const RSS_FIELDS = ['title', 'description', 'imgurl', 'imgtitle', 'pubDate']
          const tempObj = {}
          const rssMap = (manifest.app_tables && manifest.app_tables[permissionRecord._collection_name] && manifest.app_tables[permissionRecord._collection_name].rss_map) ? manifest.app_tables[permissionRecord._collection_name].rss_map : {}
          RSS_FIELDS.forEach((anRSSField) => { tempObj[anRSSField] = permissionRecord[(rssMap && rssMap[anRSSField] ? rssMap[anRSSField] : anRSSField)] })
          tempObj.application = permissionRecord._app_name
          tempObj.link = tempObj.link || (options.server_name + '/public/' + permissionRecord._id)

          if (!tempObj.title && !tempObj.description && !tempObj.imageurl) return null
          return tempObj
        }

        async.forEach(results.results, function (permissionRecord, cb2) {
          let arecord = null
          if (!permissionRecord || !permissionRecord._app_name) { // (false) { //
            helpers.app_data_error(exports.version, 'public_handler:gotoShowInitialData:freezrInternalCallFwd', 'no_permission_or_app', 'Uknown error - No permission or app name for a record ')
          } else {
            // if (!manifests[permissionRecord._app_name]) { 
            //   fileHandler.async_manifest(permissionRecord.data_owner, permissionRecord._app_name, req.freezr_environment, function (err, manifest) {
            //     if (err) {
            //       helpers.app_data_error(exports.version, 'public_handler:gotoShowInitialData:freezrInternalCallFwd', 'ignore_error_getting_config', err.message)
            //     } else {
            //       manifests[permissionRecord._app_name] = manifest
            //       arecord = transformToRSS(permissionRecord, manifests[permissionRecord._app_name])
            //       if (arecord) rssRecords.push(arecord)
            //     }
            //   })
            // } else {
            arecord = transformToRSS(permissionRecord, manifests[permissionRecord._app_name])
            if (arecord) rssRecords.push(arecord)
            // }
          }
          cb2(null)
        },
        function (err) {
          if (err) {
            helpers.send_failure(res, err, 'public_handler', exports.version, 'gotoShowInitialData:freezrInternalCallFwd')
          } else {
            renderStream()
          }
        })
      }
    }
    exports.dbp_query(req, res)
  } else if (options.useGenericFreezrPage) {
    req.url = '/public'
    if (req.params.isAppSPecificPage) req.query.app_name = options.app_name
    req.freezrInternalCallFwd = function (err, results) {
      // get results from query and for each record, get the file and then merge the record
      /*
        //  accessibles_object_id automated version is userId+"/"+req.params.requestor_app+"/"+req.params.permission_name+"/"+requesteeApp+"/"+collection_name+"/"+dataObjectId;
        var accessibles_object = {
            'requestee_app':requesteeApp,
            'data_owner':userId,
            'data_object_id': dataObjectId,
            'permission_name':req.params.permission_name,
            'requestor_app':req.params.requestor_app,
            'collection_name': collection_name,
            'shared_with_group':[new_shared_with_group],
            'shared_with_user':[new_shared_with_user],
            '_date_published' :date_Published,
            'data_object' : the_one_public_data_object[0], // make this async and go through al of them
            'search_words' : search_words,
            'granted':doGrant,

            '_id':accessibles_object_id
            }
      */
      fdlog('freezrInternalCallFwd results ', results)
      if (err) felog('err in ??', err)
      let recordsStream = []
      const renderStream = function () {
        req.freezrAppFS.readAppFile(('public' + fileHandler.sep() + options.page_url), null, function (err, htmlContent) {
          // old: fileHandler.get_file_content(null, 'info.freezr.public', 'public' + fileHandler.sep() + options.page_url, freezr_environment, function (err, htmlContent) {
          if (err) {
            helpers.send_failure(res, helpers.error('file missing', 'html file missing - cannot generate page without file page_url 1 (' + options.page_url + ')in app:' + options.app_name + ' publc folder.'), 'public_handler', exports.version, 'gotoShowInitialData')
          } else {
            let currentSearch = req.query.search && req.query.search.length > 0 ? (req.query.search) : ''
            currentSearch += req.query.user_id && req.query.user_id.length > 0 ? ((currentSearch.length > 0 ? '&' : '') + 'user:' + req.query.user_id) : ''
            currentSearch += req.query.app_name && req.query.app_name.length > 0 ? ((currentSearch.length > 0 ? '&' : '') + 'app:' + req.query.app_name) : ''
            let searchUrl = req.query.search && req.query.search.length > 0 ? ('q=' + req.query.search) : ''
            searchUrl += req.query.user_id && req.query.user_id.length > 0 ? ((searchUrl.length > 0 ? '&' : '') + 'user=' + req.query.user_id) : ''
            searchUrl += req.query.app_name && req.query.app_name.length > 0 ? ((searchUrl.length > 0 ? '&' : '') + 'app:' + req.query.app_name) : ''
            searchUrl += (searchUrl.length > 0 ? '&' : '') + 'skip=' + (parseInt(req.query.skip || 0) + parseInt(req.query.count || 0))

            const pageComponents = {
              skipped: parseInt(req.query.skip || 0),
              counted: parseInt(req.query.count || 0),
              display_more: (displayMore ? 'block' : 'none'),
              user_id: req.query.user_id ? req.query.user_id : '',
              app_name: (options.allApps ? '' : options.app_name),
              recordsStream,
              current_search: currentSearch,
              search_url: searchUrl
            }

            try {
              options.page_html = Mustache.render(htmlContent, pageComponents)
            } catch (e) {
              felog('renderStream  err ', e)
              options.page_html = 'Error in processing mustached app html - ' + htmlContent
            }
            fileHandler.load_page_html(req, res, options)
          }
        })
      }

      if (!results || !results.results || results.results.length === 0) {
        displayMore = false
        renderStream()
      } else { // add card to each record (todo - this should be done in dbp_query as an option req.paras.addcard)
        displayMore = results.results.length >= (req.query.count) // this can lead to a problem if a permission is not allowed - todo : in query send back record with a not_permitted flag

        results.results.forEach(arecord => {
          if (!arecord._card) arecord._card = genericHTMLforRecord(arecord)
          recordsStream += arecord._card
        })
        renderStream()
      }
    }
    exports.dbp_query(req, res)
  } else { // Initial data capture (but not generic freezr page)
    req.url = options.q.url
    if (req.params.isAppSPecificPage) req.query.app = options.app_name
    req.freezrInternalCallFwd = function (err, results) {
      if (err) {
        helpers.send_failure(res, err, 'public_handler', exports.version, 'gotoShowInitialData')
      } else {
        const userId = helpers.startsWith(req.params.user_id, '@') ? req.params.user_id.slice(1) : req.params.user_id
        req.freezrPublicManifestsDb.query({ user_id: userId, app_name: req.params.app_name }, null, (err, manifs) => {
          // note: this is not needed when have allApps so skip errors
          if (err || !manifs || manifs.length === 0) {
            helpers.send_failure(res, err, 'public_handler', exports.version, 'gotoShowInitialData')
          } else {
            const manifest = manifs[0] ? manifs[0].manifest : null
            const Mustache = require('mustache')
            if (results && results.results && results.results.length > 0 && !options.allApps) {
              for (let i = 0; i < results.results.length; i++) {
                results.results[i] = formatFields(results.results[i], manifest)
              }
            }
            if (manifest && manifest.public_pages && manifest.public_pages[options.page_name] && manifest.public_pages[options.page_name].header_map) {
              options.meta_tags = createHeaderTags(manifest.public_pages[options.page_name].header_map, results.results)
            } else {
              options.meta_tags = createHeaderTags(null, results.results)
            }

            const htmlFile = (manifest && manifest.public_pages && manifest.public_pages[options.page_name] && manifest.public_pages[options.page_name].html_file) ? manifest.public_pages[options.page_name].html_file : null
            if (!htmlFile) {
              helpers.send_failure(res, helpers.error('file missing', 'html file missing - cannot generate page without file page_url 2 (' + htmlFile + ')in app:' + options.app_name + ' publc folder.'), 'public_handler', exports.version, 'gotoShowInitialData')
            } else {
              req.freezrAppFS.readAppFile(('public' + fileHandler.sep() + htmlFile), null, function (err, htmlContent) {
                // old - fileHandler.get_file_content(req.query.user_id, req.query.app_name, 'public' + fileHandler.sep() + htmlFile , freezr_environment, function (err, htmlContent) {
                if (err) {
                  helpers.send_failure(res, helpers.error('file missing","html file missing - cannot generate page without file page_url 3f(' + options.page_url + ')in app:' + options.app_name + ' publc folder.'), 'public_handler', exports.version, 'gotoShowInitialData')
                } else {
                  try {
                    options.page_html = Mustache.render(htmlContent, results)
                  } catch (e) {
                    options.page_html = 'Error in processing mustached app html - ' + JSON.stringify(e) + '</br>' + htmlContent
                  }
                  fileHandler.load_page_html(req, res, options)
                }
              })
            }
          }
        })
      }
    }
    exports.dbp_query(req, res)
  }
}

exports.nowGenerateSingleObjectPage = function (req, res) {
  fdlog('nowGenerateSingleObjectPage 0 ', { params: req.params })
  req.freezrInternalCallFwd = function (err, results) {
    if (err || !results.results || results.results.length === 0 || !results.results[0]) {
      res.redirect('/public?noredirect=true&redirect=true&error=nosuchpublicobject&pid=' + req.params.object_public_id)
    } else {
      let theObj = results.results[0]
      req.freezrPublicManifestsDb.query({ user_id: theObj._data_owner, app_name: theObj._app_name }, null, (err, manifests) => {
        if (err || !manifests) {
          felog('NO  manifests found ', { err })
          helpers.send_failure(res, err, 'public_handler', exports.version, 'nowGenerateSingleObjectPage')
        } else if (manifests.length === 0) {
          helpers.send_failure(res, helpers.error('missing manifest'), 'public_handler', exports.version, 'nowGenerateSingleObjectPage')
        } else {
          const manifest = manifests[0].manifest
          theObj = formatFields(theObj, manifest)
          let htmlCard = manifests[0].ppages ? manifests[0].ppages[theObj._permission_name] : null
          if (!htmlCard && manifests[0].cards) htmlCard = manifests[0].cards[theObj._permission_name]
          if (!htmlCard) {
            const htmlContent = genericHTMLforRecord(theObj)
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end(htmlContent)
            // } else if (!pageName) {
            //  helpers.send_failure(res, helpers.error('missing public page name'), 'public_handler', exports.version, 'nowGenerateSingleObjectPage')
          } else {
            let pageName = null
            manifest.permissions.forEach(item => { if (item.name === theObj._permission_name) pageName = item.ppage })

            const htmlFile = (manifest && manifest.public_pages && pageName && manifest.public_pages[pageName] && manifest.public_pages[pageName].html_file) ? manifest.public_pages[pageName].html_file : null

            const pageParams = manifest.public_pages[pageName] || {}

            const Mustache = require('mustache')
            const options = {
              page_url: htmlFile,
              page_title: (pageParams.page_title ? pageParams.page_title : 'Public info') + ' - freezr.info',
              css_files: [], // pageParams.css_files,
              // initial_query: pageParams.initial_query ? pageParams.initial_query : {},
              script_files: [], //, //[],
              app_name: theObj._app_name,
              app_display_name: ((manifest && manifest.display_name) ? manifest.display_name : theObj.app_name),
              app_version: (manifest && manifest.version) ? manifest.version : 'N/A',
              freezr_server_version: req.freezr_server_version,
              other_variables: null,
              server_name: req.protocol + '://' + req.get('host'),
              user_queried: theObj._data_owner,

              // extra items
              page_name: pageName,
              isPublic: true,
              allApps: false,
              useGenericFreezrPage: false
            }
            try {
              options.page_html = Mustache.render(htmlCard, theObj)
            } catch (e) {
              options.page_html = 'Error in processing mustached app html - ' + JSON.stringify(e) + '</br>' + htmlCard
            }

            if (manifest && manifest.public_pages && manifest.public_pages[pageName] && manifest.public_pages[pageName].header_map) {
              options.meta_tags = createHeaderTags(manifest.public_pages[options.page_name].header_map, [theObj])
            } else {
              options.meta_tags = createHeaderTags(null, [theObj])
            }

            parseAttachedFiles(
              options,
              pageParams,
              function (finalOptions) {
                fileHandler.load_page_html(req, res, finalOptions)
              }
            )
          }
        }
      })
    }
  }
  if (req.params.object_public_id) {
    req.query.pid = req.params.object_public_id
  } else {
    req.query.pid = '@' + req.params.user_id + '/' + req.params.app_table + '/' + req.params.data_object_id
  }
  exports.dbp_query(req, res)
}
exports.generateSingleObjectPageOrHtmlPageOrFile = function (req, res) {
  // no longer used??
  // app.get('/*', addVersionNumber, public_handler.generatePublicPage);

  fdlog('generateSingleObjectPageOrHtmlPageOrFile ', req.path)

  const aPublicRecord = req.freezrPublicObject

  if (aPublicRecord.isHtmlMainPage) {
    const struct = aPublicRecord.fileStructure || {}
    const scriptFiles = []
    if (struct.js && struct.js.length > 0) struct.js.forEach(item => scriptFiles.push('/' + item.publicid))
    const cssFiles = []
    if (struct.css && struct.css.length > 0) struct.css.forEach(item => cssFiles.push('/' + item.publicid))
    const options = {
      page_title: struct.page_title || 'a freezr public page from ' + aPublicRecord.requestor_app,
      full_css_files: cssFiles,
      full_path_scripts: scriptFiles,
      page_html: aPublicRecord.html_page,
      page_url: req.path,
      app_name: aPublicRecord.requestor_app,
      isPublic: true
    }
    fileHandler.load_page_html(req, res, options)
  } else if (helpers.endsWith(aPublicRecord.original_app_table, '.files')) {
    const filePath = aPublicRecord.original_record_id
    req.freezrUserFS.sendUserFile(filePath, res)
  } else {
    exports.nowGenerateSingleObjectPage(req, res)
  }
}

function parseAttachedFiles (options, pageParams, callback) {
  if (pageParams.css_files) {
    if (typeof pageParams.css_files === 'string') pageParams.css_files = [pageParams.css_files]
    pageParams.css_files.forEach(function (cssFile) {
      if (helpers.startsWith(cssFile, 'http')) {
        helpers.app_data_error(exports.version, 'generatePage', options.app_name, 'Cannot have css files referring to other hosts')
      } else if (helpers.startsWith(cssFile, '/') || helpers.startsWith(cssFile, '.')) {
        helpers.app_data_error(exports.version, 'generatePage', options.app_name, 'Cannot have css files referring to other folders')
      } else {
        if (fileHandler.fileExt(cssFile) === 'css') {
          // options.css_files.push('public/' + cssFile) 2021 - to review
          options.css_files.push('./@' + (options.user_queried || 'public') + '/' + (options.app_name || 'info.freezr.public') + '/public/' + cssFile)
        } else {
          helpers.app_data_error(exports.version, 'generatePage', options.app_name, 'Cannot have non css file used as css :' + cssFile)
        }
      }
    })
  }

  const outsideScripts = []
  if (pageParams.script_files) {
    if (typeof pageParams.script_files === 'string') pageParams.script_files = [pageParams.script_files]
    pageParams.script_files.forEach(function (jsFile) {
      if (helpers.startsWith(jsFile, 'http')) {
        outsideScripts.push(jsFile)
      } else if (helpers.startsWith(jsFile, '/') || helpers.startsWith(jsFile, '.')) {
        helpers.app_data_error(exports.version, 'generatePage', options.app_name, 'Cannot have script files referring to other folders')
      } else {
        if (fileHandler.fileExt(jsFile) === 'js') {
          // options.script_files.push('public/' + jsFile)
          options.script_files.push('./@' + (options.user_queried || 'public') + '/' + (options.app_name || 'info.freezr.public') + '/public/' + jsFile)
        } else {
          helpers.app_data_error(exports.version, 'generatePage', options.app_name, 'Cannot have non js file used as js.')
        }
      }
    })
  }

  if (outsideScripts.length > 0) console.warn('outsideScripts removed - todo - see it need to handle outside script permissions')

  callback(options)
}

// database operations
exports.dbp_query = function (req, res) {
  // app.get('/v1/pdbq', addPublicRecordsDB, publicHandler.dbp_query);
  // app.get('/v1/pdbq/:app_name', addPublicRecordsDB, publicHandler.dbp_query);
  // app.post('/v1/pdbq', addPublicRecordsDB, publicHandler.dbp_query);
  //    exports.generatePublicPage directly && via gotoShowInitialData
  /*
  query options are, for get (ie req.params and req.query) and post (req.body):
      - params or query: app_name, user_id
      - query: maxdate, mindate, app, q (for search words)
      - query: skip, count, pid (for _id)
      - q or search (equivalnet of search_words)
  for POST -> everything goes into the body:
    - q ( to search for data_owner, _id, search_words, etc etc) and skip, count
  */
  fdlog('dbp_query body ', req.body, ' params ', req.params, ' query ', req.query)
  // if (helpers.isEmpty(req.query)) req.query = req.body // make post and get equivalent

  let queryParams = {}
  if (req.params.requestee_app) queryParams.requestor_app = req.params.requestee_app.toLowerCase()
  if (!helpers.isEmpty(req.body)) {
    queryParams = req.body.q
    if (req.body.feed) {
      queryParams.privateFeedNames = req.body.feed
    } else if (req.body.code) {
      queryParams.privateLinks = req.body.code
    } else {
      if (req.body.data_owner) queryParams.data_owner = req.body.data_owner
    }
    if (req.body.app_name) queryParams.requestor_app = req.body.app_name.toLowerCase()
  } else if (req.query) {
    if (req.params?.data_object_id && req.params?.user_id && req.params?.app_table) {
      queryParams._id = ('@' + req.params.user_id.toLowerCase() + '/' + req.params.app_table.toLowerCase() + '/' + req.params.data_object_id.toLowerCase())
      if (req.query.code) queryParams.privateLinks = req.query?.code
    } else if (req.query.feed) {
      queryParams.privateFeedNames = req.query.feed
    } else if (req.query.code) {
      queryParams.privateLinks = req.query?.code
    } else {
      // console.warn('used for feeds - change?')
      if (typeof req.query?.user_id === 'string' && req.query?.user_id?.slice(0, 1) === '@') req.query.user_id = req.query.user_id.slice(1)
      if (typeof req.query?.user_id === 'string' && req.query.user_id) queryParams.data_owner = req.query.user_id.toLowerCase()
      if (req.params.user_id) queryParams.data_owner = req.params.user_id.toLowerCase()
      if (typeof req.query?.app === 'string' && req.query.app) queryParams.requestor_app = req.query.app.toLowerCase()
      if (typeof req.query?.requestee_app === 'string' && req.params.requestee_app) queryParams.requestor_app = req.params.requestee_app.toLowerCase()
    }
    if (typeof req.query?.app_name === 'string' && req.query.app_name) queryParams.requestor_app = req.query.app_name.toLowerCase()
    if (typeof req.query?.owner === 'string' && req.query.owner) queryParams.data_owner = req.query.owner.toLowerCase()

    if (req.query.pid) queryParams._id = req.query.pid
    if (req.query.maxdate) queryParams._date_published = { $lt: parseInt(req.query.maxdate) }
    if (req.query.mindate) queryParams._date_published = { $gt: parseInt(req.query.mindate) }
    if (req.query.search || req.query.q) {
      // onsole.log("req.query.search:",req.query.search," req.query.q:"req.query.q)
      if (typeof req.query?.search !== 'string') req.query.search = ''
      req.query.search = decodeURIComponent(((req.query.search || '') + ' ' + (req.query.q || '')).trim()).toLowerCase()
      if (req.query.search.indexOf(' ') < 0) {
        queryParams.search_words = new RegExp(req.query.search)
      } else {
        const theAnds = [queryParams]
        const searchterms = req.query.search.split(' ')
        searchterms.forEach(function (aterm) { theAnds.push({ search_words: new RegExp(aterm) }) })
        queryParams = { $and: theAnds }
      }
    }
  }

  if (!queryParams.privateFeedNames && !queryParams.privateLinks) queryParams.isPublic = true

  // params which are passed prgramatically from generatePublicPage
  // if (req.params.isAppSPecificPage) delete queryParams.requestor_app
  if (req.params?.doNotGetDoNotLists) queryParams.$or = [{ doNotList: false }, { doNotList: null }, { doNotList: { $exists: false } }]

  const skip = req.query?.skip ? parseInt(req.query.skip) : (req.body.skip || 0)
  const count = req.query?.count ? parseInt(req.query.count) : (req.body.count || 10)
  const sort = req.body.sort || { _date_published: -1 }

  fdlog('dbp_query body ', req.body, ' params ', req.params, ' query ', req.query, 'dbp_query queryParams ', { queryParams, ors: queryParams.$or })

  let tempRecords = []
  const finalRecords = []
  const errs = []
  const relevantManifests = {}

  // function appErr (message) { return helpers.app_data_error(exports.version, 'dbp_query', 'public query for ' + (req.body.app_name || ((req.params && req.params.app_name) ? req.params.app_name: null) || 'all apps'), message) }
  // function authErr (message) { return helpers.auth_failure('public_handler', exports.version, 'dbp_query', message) }

  async.waterfall([
    // 0 - for privateFeeds - check code
    function (cb) {
      if (queryParams.privateFeedNames) {
        const code = req.query?.code || req.body?.code // not sure which to use body.q or body
        const name = queryParams.privateFeedNames
        req.freezrPrivateFeedDb.query({ name }, null, function (err, results) {
          if (err) {
            cb(err)
          } else if (!results || results.length < 1 || results[0].code !== code) {
            cb(new Error('Could not authenticate feed'))
          } else {
            cb(null)
          }
        })
      } else {
        cb(null)
      }
    },
    // 1 / 2. get the records
    function (cb) {
      req.freezrPublicRecordsDB.query(queryParams, { sort, count, skip }, cb)
    },
    // 3 see permission record and make sure it is still granted
    function (results, cb) {
      fdlog('dbp_query results', { queryParams, ors: queryParams.$or, results})
      if (!results || results.length === 0) {
        cb(null)
      } else {
        tempRecords = results
        async.forEach(results, function (aPublicRecord, cb2) {
          if (!relevantManifests[aPublicRecord.data_owner]) relevantManifests[aPublicRecord.data_owner] = {}
          if (!relevantManifests[aPublicRecord.data_owner][aPublicRecord.requestor_app]) {
            req.freezrPublicManifestsDb.query({ user_id: aPublicRecord.data_owner, app_name: aPublicRecord.requestor_app }, null, (err, manifests) => {
              if (!err && manifests && manifests.length > 0) {
                relevantManifests[aPublicRecord.data_owner][aPublicRecord.requestor_app] = manifests[0]
              }
              cb2(null)
            })
          } else {
            cb2(null)
          }
        },
        function (err) {
          if (err) {
            errs.push({ error: err, permissionRecord: null })
          }
          cb(null)
        })
      }
    },

    function (cb) {
      fdlog({ relevantManifests, tempRecords })
      const Mustache = require('mustache')
      tempRecords.forEach(retrievedRecord => {
        const afinalRecord = retrievedRecord.original_record || {}
        afinalRecord._app_name = retrievedRecord.requestor_app
        afinalRecord._data_owner = retrievedRecord.data_owner
        afinalRecord._permission_name = retrievedRecord.permission_name
        afinalRecord._app_table = retrievedRecord.original_app_table
        afinalRecord._date_modified = retrievedRecord._date_modified
        afinalRecord._date_published = retrievedRecord._date_published || retrievedRecord._date_created
        afinalRecord.__date_published = retrievedRecord._date_published ? (new Date(retrievedRecord._date_published).toLocaleDateString()) : 'n/a'
        afinalRecord._date_created = retrievedRecord._date_created
        afinalRecord._original_id = afinalRecord._id
        afinalRecord._id = retrievedRecord._id
        const theManifest = relevantManifests[retrievedRecord.data_owner][retrievedRecord.requestor_app]
        fdlog({ theManifest })
        if (theManifest && theManifest.permissions.includes(retrievedRecord.permission_name)) {
          const cardTemplate = theManifest.cards ? theManifest.cards[retrievedRecord.permission_name] : null
          if (cardTemplate) {
            try {
              afinalRecord._card =
                '<div class="freezr_public_genericCardOuter freezr_public_genericCardOuter_overflower"><div class="freezr_expander"> >> </div>' +
                '<span><img src="/publicfiles/@' + afinalRecord._data_owner + '/info.freezr.account/profilePict.jpg" imgerror="hide" style="margin: -0px 5px -22px 5px; border: 1px solid lightgrey; max-width: 40px; max-height: 40px; border-radius: 20px"></span>' +
                '<div style="font-size: 12px; font-style: italic; color: #3f51b5; display: block; margin: 3px 0px -10px 50px;">Posted by ' + afinalRecord._data_owner + ' on ' + afinalRecord.__date_published + '</div>' +
                Mustache.render(cardTemplate, afinalRecord) +
                '</div>'
            } catch (e) {
              felog('error getting card for ', retrievedRecord, e)
            }
          }

          // const collection = retrievedRecord.original_app_table.substring(retrievedRecord.requestor_app.length + 1)
          // afinalRecord._fields = (theManifest.manifest && theManifest.manifest && theManifest.manifest.app_tables && theManifest.manifest.app_tables[collection]) ? theManifest.manifest.app_tables[collection].field_names : null

          finalRecords.push(afinalRecord)
        } else {
          errs.push({ error: new Error('No manifest'), permissionRecord: retrievedRecord })
          felog('Missing manifest ', retrievedRecord)
        }
      })
      cb(null)
    }
  ],
  function (error) {
    fdlog('end of pdquery ', { error, finalRecords })
    // const sortBylastPubDate = function (obj1, obj2) { return obj2._date_published - obj1._date_published }
    // finalRecords = finalRecords.sort(sortBylastPubDate)
    if (req.freezrInternalCallFwd) {
      req.freezrInternalCallFwd(null, { results: finalRecords, error, errs, next_skip: (skip + count) })
    } else {
      helpers.send_success(res, { results: finalRecords, error, errs, next_skip: (skip + count) })
    }
  })
}

// file
exports.get_public_file = function (req, res) {
  // app.get('/publicfiles/@:user_id/:requestee_app/*', addPublicRecordsDB, addPublicUserFs, publicHandler.get_public_file);
  // Initialize variables
  fdlog('get_public_file')

  let parts = req.originalUrl.split('/')
  parts = parts.slice(4)
  const dataObjectId = decodeURI(parts.join('/')).split('?')[0].split('#')[0]

  req.freezruserFilesDb.read_by_id(dataObjectId, (err, resultingRecord) => {
    if (err || !resultingRecord) {
      felog('no related records getting piublci file', dataObjectId, err)
      res.sendStatus(404)
    } else if (resultingRecord._accessible && resultingRecord._accessible._public && resultingRecord._accessible._public.granted) {
      const endPath = unescape(parts.join('/').split('?')[0])
      req.freezrAppFS.sendUserFile(endPath, res)
    } else {
      console.warn('not permitted to get public file' + dataObjectId + ' ' + JSON.stringify(resultingRecord._accessible))
      res.sendStatus(401)
    }
  })
}

// ancillary functions and name checks
function firstElementKey (obj) {
  if (obj == null) return null
  if (obj.length === 0) return null
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) return key
  }
  return null
}
const formatFields = function (permissionRecord, manifest) {
  const coreDateList = ['_date_modified', '_date_created', '_date_published']
  coreDateList.forEach(function (name) {
    const aDate = new Date(permissionRecord[name])
    permissionRecord['_' + name] = aDate.toLocaleString()
  })
  // console.log 2020 - see above vs redoing __date_published below - diplicated??
  let fieldNames = (manifest &&
    manifest.app_tables &&
    manifest.app_tables[permissionRecord._collection_name] &&
    manifest.app_tables[permissionRecord._collection_name].field_names)
    ? manifest.app_tables[permissionRecord._collection_name].field_names
    : null
  if (!fieldNames && permissionRecord._fields) fieldNames = permissionRecord._fields
  if (fieldNames) {
    for (const name in fieldNames) {
      if (Object.prototype.hasOwnProperty.call(fieldNames, name)) {
        if (fieldNames[name].type === 'date' && permissionRecord[name]) {
          const aDate = new Date(permissionRecord[name])
          permissionRecord[name] = aDate.toDateString()
        }
      };
    }
  }
  return permissionRecord
}
const createHeaderTags = function (headerMap, results) {
  // Creates header meta tags for the page - if more than one results is passed, only text fields will be used.
  let headertext = (results && results[0] && results[0]._app_name) ? '<meta name="application-name" content="' + results[0]._app_name + ' - a freezr app" >' : ''
  if (headerMap) {
    Object.keys(headerMap).forEach(function (aHeader) {
      const keyObj = headerMap[aHeader]
      if (keyObj.field_name && results && results[0] && results[0][keyObj.field_name]) {
        headertext += '<meta name="' + aHeader + '" content="' + (keyObj.text ? (keyObj.text + ' ') : '') + results[0][keyObj.field_name] + '" >'
      } else if (keyObj.text) {
        headertext += '<meta name="' + aHeader + '" content="' + keyObj.text + ' - a freezr app" >'
      }
    })
  }
  return headertext
}

// Old or unused
// ------------------ ------------------ ------------------ ------------------ ------------------

// Loggers
const LOG_ERRORS = true
const felog = function (...args) { if (LOG_ERRORS) helpers.warning('public_handler.js', exports.version, ...args) }
const LOG_DEBUGS = false
const fdlog = function (...args) { if (LOG_DEBUGS) console.log(...args) }
