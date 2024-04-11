// freezr.info - nodejs system files - app_handler.js

exports.version = '0.0.200'

const helpers = require('./helpers.js')
const async = require('async')
const fileHandler = require('./file_handler.js')

exports.generatePage = function (req, res) {
  // '/apps/:app_name' and '/apps/:app_name/:page' (and generateDataPage above)
  fdlog('generatePage NEW: ' + req.url)
  const manifest = req.freezrRequestorManifest || {}

  if (!req.params.page) req.params.page = 'index'
  if (helpers.endsWith(req.params.page, '.html')) req.params.page = req.params.page.slice(0, -5)

  const pageName = req.params.page

  if (!manifest.pages) manifest.pages = { pageName: {} }
  if (!manifest.pages[pageName]) {
    manifest.pages[pageName] = {
      // todo - check if the files exist first?
      html_file: pageName + '.html',
      css_files: pageName + '.css',
      script_files: [pageName + '.js']
    }
  }
  if (!manifest.pages[pageName].page_title) manifest.pages[pageName].page_title = pageName

  req.params.internal_query_token = req.freezrTokenInfo.app_token // internal query request

  if (manifest.pages[pageName].initial_query) {
    // Only takes type: db_query at this time
    const queryParams = manifest.pages[pageName].initial_query
    const manifestPermissionSchema = (manifest.permissions && queryParams.permission_name) ? manifest.permissions[queryParams.permission_name] : null

    if (manifestPermissionSchema) {
      req.body.permission_name = queryParams.permission_name
      req.params.app_table = req.params.app_name + (manifestPermissionSchema.collection_name ? ('.' + manifestPermissionSchema.collection_name) : '')
      if (queryParams.collection_name && manifestPermissionSchema.collection_name !== queryParams.collection_name) helpers.warning('app_handler', exports.version, 'generatePage', 'permission schema collection inconsistent with requested collction ' + queryParams.collection_name + ' for app: ' + req.params.app_name)
    } else if (queryParams.collection_name) {
      req.params.app_table = req.params.app_name + (queryParams.collection_name ? ('.' + queryParams.collection_name) : '')
    } else {
      felog('generatePage ', 'Have to define either permission_name or collection_name (for own collection) in initial_query of manifest')
    }

    req.internalcallfwd = function (err, results) {
      if (err) felog('State Error ' + err)
      req.params.queryresults = { results }
      generatePageWithManifest(req, res, manifest)
    }
    exports.db_query(req, res)
  } else {
    generatePageWithManifest(req, res, manifest)
  }
}

const generatePageWithManifest = function (req, res, manifest) {
  fdlog('generatePageWithManifest', { manifest })

  const pageParams = manifest.pages[req.params.page]

  const options = {
    page_title: pageParams.page_title + ' - freezr.info',
    page_url: pageParams.html_file ? pageParams.html_file : './info.freezr.public/fileNotFound.html',
    css_files: [],
    queryresults: (req.params.queryresults || null),
    script_files: [], // pageParams.script_files, //[],
    messages: { showOnStart: false },
    user_id: req.session.logged_in_user_id,
    owner_id: req.freezrTokenInfo.owner_id || req.session.logged_in_user_id,
    user_is_admin: req.session.logged_in_as_admin,
    app_name: req.params.app_name,
    app_display_name: ((manifest && manifest.display_name) ? manifest.display_name : req.params.app_name),
    app_version: (manifest && manifest.version) ? manifest.version : 'N/A',
    other_variables: null,
    freezr_server_version: req.freezr_server_version,
    server_name: req.protocol + '://' + req.get('host')
  }

  if (!req.params.internal_query_token) {
    helpers.send_internal_err_page(res, 'app_handler', exports.version, 'generatePage', 'app_token missing in generatePageWithManifest')
  } else {
    let appPrefix = '/apps/'
    const parts = req.originalUrl.split('/')
    if (parts.length > 1 && parts[1] === 'oapp') appPrefix = '/oapp/' + req.freezrTokenInfo.owner_id + '/'
    fdlog('setting cookie at ' + appPrefix + req.params.app_name + ' for user ' + req.session.logged_in_user_id)
    res.cookie('app_token_' + req.session.logged_in_user_id, req.params.internal_query_token, { path: appPrefix + req.params.app_name })

    // options.messages.showOnStart = (results.newCode && manifest && manifest.permissions && Object.keys(manifest.permissions).length > 0);
    if (pageParams.css_files) {
      if (typeof pageParams.css_files === 'string') pageParams.css_files = [pageParams.css_files]
      pageParams.css_files.forEach(function (cssFile) {
        if (helpers.startsWith(cssFile, 'http')) {
          helpers.app_data_error(exports.version, 'generatePage', req.params.app_name, 'Cannot have css files referring to other hosts')
        } else {
          if (fileHandler.fileExt(cssFile) === 'css') {
            options.css_files.push(cssFile)
          } else {
            helpers.app_data_error(exports.version, 'generatePage', req.params.app_name, 'Cannot have non js file used as css ' + pageParams.css_files)
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
        } else {
          // Check if exists? - todo and review - err if file doesn't exist?
          if (fileHandler.fileExt(jsFile) === 'js') {
            options.script_files.push(jsFile)
          } else {
            helpers.app_data_error(exports.version, 'generatePage', req.params.app_name, 'Cannot have non js file used as js.')
          }
        }
      })
    }

    if (outsideScripts.length > 0) {
      fdlog('todo? re-implement outside-scripts permission??')
    }
    fileHandler.load_data_html_and_page(req, res, options)
  }
}

// ceps operations
// each of these are perviously handled by access_handler and perm_handler which add the following to req:
/*
From userAPIRights in access_handler
freezrTokenInfo (related to requestor):
  {userId, appName, loggedIn:}

From readWritePerms in perm_handler
freezrAttributes : {
  permission_name: null,
  owner_user_id:null,
  requestor_app:null,
  requestor_user_id: null,
  own_record: false, //ie not permitted
  record_is_permitted: false,
  grantedPerms: [] // If not own_record, list of permissions granted by the requestee related to the app_table being queried
}

*/
exports.write_record = function (req, res) { // create update or upsert
  // app.post('/ceps/write/:app_table', userDataAccessRights, app_handler.write_record);
  // app.put('/ceps/update/:app_table/:data_object_id', userDataAccessRights, app_handler.write_record)
  // app.post('/feps/write/:app_table', userDataAccessRights, app_handler.write_record);
  // app.post('/feps/write/:app_table/:data_object_id', userDataAccessRights, app_handler.write_record);
  // app.post('/feps/upsert/:app_table', userDataAccessRights, app_handler.write_record);

  fdlog('write_record', 'ceps writeData at ' + req.url, req.query) // req.query , req.body

  const isUpsert = (req.query.upsert === 'true')
  fdlog('req.query ', req.query, { isUpsert })
  const isUpdate = helpers.startsWith(req.url, '/ceps/update') || helpers.startsWith(req.url, '/feps/update') || (helpers.startsWith(req.url, '/feps/write') && req.query.upsert === 'true')
  const replaceAllFields = isUpdate && (req.query?.replaceAllFields === 'true' || helpers.startsWith(req.url, '/ceps/update'))
  const isCeps = helpers.startsWith(req.url, '/ceps/')
  const isQueryBasedUpdate = (!isCeps && isUpdate && !req.params.data_object_id && req.body.q && req.body.keys)
  if (req.params.data_object_start) {
    const parts = req.path.split('/').slice(4)
    req.params.data_object_id = parts.join('/')
  }


  fdlog('write rec ', { isUpdate, replaceAllFields }, 'query: ', req.body, 'body', req.query)
  const write = req.body || {}
  const dataObjectId = (isUpsert || isUpdate) ? req.params.data_object_id : (req.body._id ? (req.body._id + '') : null)

  const [granted, bestGrantType] = checkWritePermission(req)

  const appErr = function (message) { return helpers.app_data_error(exports.version, 'write_record', req.freezrAttributes.requestor_app, message) }
  const authErr = function (message) { return helpers.auth_failure('app_handler', exports.version, 'write_record', req.freezrAttributes.requestor_app + ': ' + message) }

  fdlog('req.freezrAttributes.requestor_app, req.params.app_name', req.freezrAttributes.requestor_app, req.params.app_name)
  async.waterfall([
    // 1. check basics
    function (cb) {
      if (!granted) {
        fdlog('not gramted err ', req)
        cb(authErr('unauthorized write access'))
      } else if (!isUpsert && !isUpdate && Object.keys(write).length <= 0) {
        cb(appErr('Missing data parameters.'))
      } else if (helpers.startsWith(req.params.app_table, 'info.freezr')) {
        // to write into any info,freezr table, must go through addount_handler or admin_handler
        cb(helpers.invalid_data('app name not allowed: ' + req.freezrAttributes.requestor_app, 'account_handler', exports.version, 'write_record'))
      } else if (isCeps && (isUpsert || (isUpdate && !dataObjectId))) {
        cb(appErr('CEPs is not yet able to do upsert, and key only updates and query based updates.'))
      } else if (!dataObjectId && !isUpsert && !isUpdate) { // Simple create object with no id
        cb(null, null)
      } else if (dataObjectId && (isUpsert || isUpdate)) { // isUpsert or update
        req.freezrRequesteeDB.read_by_id(dataObjectId, function (err, results) {
          cb((isUpsert ? null : err), results)
        })
      } else if (isQueryBasedUpdate && req.freezrAttributes.requestor_user_id) { // just to mass update // 2022-11 added req.freezrAttributes.requestor_user_id as redundancy
        cb(null, null)
      } else {
        fdlog('isQueryBasedUpdate ', isQueryBasedUpdate, 'isCeps ', isCeps, 'upodate: ', isUpdate, 'params: ', req.params, 'body: ', req.body)
        cb(appErr('Malformed path body combo '))
      }
    },

    // 4. write
    function (results, cb) {
      if (isQueryBasedUpdate) { // no results needed
        if (bestGrantType === 'write_own') {
          write.q._created_by_user = req.freezrAttributes.requestor_user_id
          write.q._created_by_app = req.freezrAttributes.requestor_app
        }
        req.freezrRequesteeDB.update(write.q, write.keys, { replaceAllFields: false /* redundant */ }, cb)
      } else if (results) {
        if (bestGrantType === 'write_own' && (results._created_by_user !== req.freezrAttributes.requestor_user_id || results._created_by_app !== req.freezrAttributes.requestor_app)) {
          cb(helpers.auth_failure('app_handler', exports.version, 'write_record', req.freezrAttributes.requestor_app, 'unauthorised access from write_own'))
        } if ((isUpsert || isUpdate) && results._date_modified /* ie is non empty record */) { // one entity
          if (bestGrantType === 'write_own') {
            write._created_by_user = req.freezrAttributes.requestor_user_id
            write._created_by_app = req.freezrAttributes.requestor_app
          }
          req.freezrRequesteeDB.update(dataObjectId.toString(), write, { replaceAllFields, old_entity: results }, cb)
        } else {
          const errmsg = isUpsert ? 'internal err in old record' : 'Record exists - use "update" to update existing records'
          cb(helpers.auth_failure('app_handler', exports.version, 'write_record', req.freezrAttributes.requestor_app, errmsg))
        }
      } else if (isUpdate && !isUpsert) { // should have gotten results
        console.warn('; no record found err in  write_rec ', { write, results, dataObjectId, isUpsert, isUpdate })
        cb(appErr('record not found'))
      } else { // upsert / create - new document - should not have gotten results
        if (req.freezrAttributes.owner_user_id !== req.freezrAttributes.requestor_user_id) {
          write._created_by_user = req.freezrAttributes.requestor_user_id
          write._created_by_app = req.freezrAttributes.requestor_app
        }
        req.freezrRequesteeDB.create(dataObjectId?.toString(), write, { restoreRecord: false }, cb)
      }
    }
  ],
    function (err, writeConfirm) {
      fdlog('write err', err, 'writeConfirm', { writeConfirm, isUpdate, isQueryBasedUpdate })
      // onsole.log('isQueryBasedUpdate success ', { err, writeConfirm })
      if (err) {
        console.warn('err ', err)
        helpers.send_failure(res, err, 'app_handler', exports.version, 'write_record')
      } else if (isQueryBasedUpdate) {
        helpers.send_success(res, writeConfirm)
      } else if (!writeConfirm || (!writeConfirm.nModified && !writeConfirm._id)) {
        felog('snbh - unknown error writing one record at a time ', { write, writeConfirm })
        helpers.send_failure(res, new Error('unknown write error'), 'app_handler', exports.version, 'write_record')
      } else if (isUpdate || isUpsert) {
        helpers.send_success(res, writeConfirm)
      } else { // write new (CEPS)
        helpers.send_success(res, writeConfirm)
      }
    })
}
exports.read_record_by_id = function (req, res) {
  // app.get('/ceps/read/:app_table/:data_object_id', userDataAccessRights, app_handler.read_record_by_id);
  // app.get('/feps/read/:app_table/:data_object_id/:requestee_user_id', userDataAccessRights, app_handler.read_record_by_id);
  //   feps option: "?"+(requestee_app==freezr_app_name? "":("requestor_app="+freezr_app_name)) + (permission_name? ("permission_name="+permission_name):"")

  //  app.get('/feps/userfileGetToken/:permission_name/:requestee_app_name/:requestee_user_id/*', userDataAccessRights, app_handler.read_record_by_id); // collection_name is files
  //    collection name is 'files'

  let dataObjectId
  let permittedRecord
  const requestFile = helpers.startsWith(req.path, '/feps/getuserfiletoken')

  if (requestFile) {
    const parts = req.originalUrl.split('/')
    dataObjectId = unescape(parts.slice(6).join('/'))
    if (dataObjectId.indexOf('?') > -1) {
      const parts2 = dataObjectId.split('?')
      dataObjectId = parts2[0]
    }
  } else {
    dataObjectId = req.params.data_object_id
  }

  const [granted, readAll] = checkReadPermission(req)

  const appErr = function (message) { return helpers.app_data_error(exports.version, 'read_record_by_id', req.freezrAttributes.requestor_app, message) }
  const authErr = function (message) { return helpers.auth_failure('app_handler', exports.version, 'read_record_by_id', req.freezrAttributes.requestor_app + ': ' + message) }

  async.waterfall([
    // 1. get item.. if own_record, go to end. if not, get all record permissions
    function (cb) {
      if (!granted) {
        cb(authErr('unauthorised read access'))
      } else if (!dataObjectId) {
        cb(appErr('cannot read with out a data_object_id'))
      } else if (!req.freezrRequesteeDB) {
        cb(appErr('internal error getting db'))
      } else {
        req.freezrRequesteeDB.read_by_id(dataObjectId, cb)
      }
    },

    // 2. get permissions if needbe, and remove fields that shouldnt be sent
    function (fetchedRecord, cb) {
      if (!fetchedRecord) {
        cb(appErr('no related records for ' + dataObjectId))
      } else if (req.freezrAttributes.own_record || readAll) { // ie own_record or has read_all.. redundant? own_record always gets readall
        permittedRecord = fetchedRecord
        // todo - should have a flag for admin / account operations to get the _accessible too
        if (!req.freezrAttributes.own_record) { delete permittedRecord._accessible }
        cb(null)
      } else if (!req.freezrAttributes.grantedPerms || req.freezrAttributes.grantedPerms.length === 0) {
        cb(authErr('No granted permissions exist'))
      } else {
        // TEMP _accessible: accessible[grantee][fullPermName] = {granted:true}
        let accessToRecord = false
        let relevantPerm = null

        const requestee = req.freezrAttributes.owner_user_id.replace(/\./g, '_')

        req.freezrAttributes.grantedPerms.forEach(aPerm => {
          if (aPerm.type === 'write_own' && fetchedRecord._created_by_user === req.freezrAttributes.requestor_user_id) { //  && fetchedRecord._created_by_app === req.freezrAttributes.requestor_app
            accessToRecord = true
            relevantPerm = aPerm
          } else if (fetchedRecord._accessible && fetchedRecord._accessible[requestee] &&
            fetchedRecord._accessible[requestee][aPerm.permission_name].granted
          ) {
            accessToRecord = true
            if (fetchedRecord._accessible[requestee][aPerm.permission_name].granted &&
              (!req.freezrAttributes.permission_name || aPerm.permission_name === req.freezrAttributes.permission_name)
            ) {
              // nb treating permisiion_name as optional. If we want to force having a permission_name then expression should eb removed
              relevantPerm = aPerm
            }
          }
        })

        if (accessToRecord && relevantPerm) {
          if (!requestFile && relevantPerm.return_fields && relevantPerm.return_fields.length > 0) {
            permittedRecord = {}
            relevantPerm.return_fields.forEach(key => {
              permittedRecord[key] = fetchedRecord[key]
            })
          } else {
            permittedRecord = fetchedRecord
          }
          delete permittedRecord._accessible
          cb(null)
        } else {
          cb(authErr('No matching permissions exist'))
        }
      }
    }
  ],
    function (err) {
      // fdlog("got to end of read_record_by_id");
      if (err) {
        helpers.send_failure(res, err, 'app_handler', exports.version, 'read_record_by_id')
      } else if (requestFile) {
        helpers.send_success(res, { fileToken: getOrSetFileToken(req.freezrAttributes.owner_user_id, req.params.app_name, dataObjectId) })
      } else {
        helpers.send_success(res, permittedRecord)
      }
    })
}
const reduceToPermittedFields = function (record, returnFields) {
  if (record._accessible) delete record._accessible
  if (!returnFields) return record

  returnFields.push('_date_modified')
  if (returnFields._accessible) delete returnFields._accessible
  const returnObj = {}
  returnFields.forEach((aField) => { returnObj[aField] = record[aField] })
  return returnObj
}
exports.db_query = function (req, res) {
  fdlog('db_query in app_hanlder: ' + req.url + ' body ' + JSON.stringify(req.body) + ' req.params.app_table', req.params.app_table)
  // app.get('/ceps/query/:app_table', userDataAccessRights, app_handler.db_query); (req.params contain query)
  // app.get('/feps/query/:app_table', userDataAccessRights, app_handler.db_query); (same as ceps)
  // app.post('/feps/query/:app_table', userDataAccessRights, app_handler.db_query);
  //   body: permission_name, user_id (ie requestee id), q (query params), only_others, sort

  if (helpers.startsWith(req.params.app_table, 'info.freezr.admin') || req.freezrAttributes.requestor_app === 'info.freezr.admin' || helpers.startsWith(req.params.app_table, 'info.freezr.account')) {
    fdlog('should db_query used to make admin queries???')
  }

  // const permissionName = req.body.permission_name

  const authErr = function (message) { return helpers.auth_failure('app_handler', exports.version, 'db_query', message + ' ' + req.params.app_table) }

  if ((!req.body || helpers.isEmpty(req.body)) && req.query && !helpers.isEmpty(req.query)) req.body = { q: req.query } // in case of a GET statement (ie move query to body)

  let gotErr = null

  const [granted, canReadAllTable, relevantAndGrantedPerms] = checkReadPermission(req)
  fdlog('checkReadPermission results for req.freezrAttributes: ', req.freezrAttributes, { granted, canReadAllTable, relevantAndGrantedPerms })
  const thePerm = relevantAndGrantedPerms[0]
  fdlog({ relevantAndGrantedPerms, thePerm })

  if (relevantAndGrantedPerms.length > 1) fdlog('todo - deal with multiple permissions - forcePermName??')
  // if (!req.freezrAttributes.own_record && !permissionName) console.log("todo review - Need a persmission name to access others' apps and records? if so permissionName needs to be compulsory for perm_handler too")
  fdlog('todo - not granted reason???', { granted }, req.params.app_table, ' req.path:', req.path, ' body:', req.body, ' query: ', req.query)

  if (!granted) {
    gotErr = authErr('unauthorized access to query - no permissions')
  } else if (canReadAllTable) { // includes read_all / write_all prems and req.freezrAttributes.own_record
    // all good
  } else if (thePerm.type === 'write_own') {
    if (!req.body.q) req.body.q = {}
    if (req.freezrAttributes.requestor_user_id !== req.freezrAttributes.owner_user_id) req.body.q._created_by_user = req.freezrAttributes.requestor_user_id
    // if (req.freezrAttributes.requestor_app !== 'info.freezr.account') req.body.q._created_by_app = req.freezrAttributes.requestor_app
  } else if (thePerm.type === 'db_query') {
    // for db_queries make sure query fits the intended schema
    fdlog('todo future functionality')

    if (req.freezrAttributes.grantedPerms.length > 1) gotErr = authErr('develper error - more than one auth')

    if (thePerm.permitted_fields && thePerm.permitted_fields.length > 0 && Object.keys(req.body.q).length > 0) {
      const checkQueryParamsPermitted = function (queryParams, permittedFields) {
        let err = null
        if (Array.isArray(queryParams)) {
          queryParams.forEach(function (item) {
            err = err || checkQueryParamsPermitted(item, permittedFields)
          })
        } else {
          for (const key in queryParams) {
            if (key === '$and' || key === '$or') {
              return checkQueryParamsPermitted(queryParams[key], permittedFields)
            } else if (['$lt', '$gt', '_date_modified'].indexOf(key) > -1) {
              // do nothing
            } else if (permittedFields.indexOf(key) < 0) {
              return (new Error('field not permitted ' + key))
            }
          }
        }
        return (err)
      }
      gotErr = checkQueryParamsPermitted(req.body.q, thePerm.permitted_fields)
    }
    gotErr = new Error('todo - dg_query permission type NOT yet functional')
  } else if (thePerm.type === 'share_records') {
    // TEMP _accessible: accessible[grantee][fullPermName] = {granted:true}
    fdlog('todo - add groups - done?? ')
    if (!req.body.q) req.body.q = {}
    req.body.q['_accessible.' + req.freezrAttributes.requestor_user_id + '.granted'] = true // old { $exists: true }
  }

  if (gotErr) {
    helpers.send_failure(res, gotErr, 'app_handler', exports.version, 'db_query')
  } else {
    //  console.log('todo - if type is not db_query then add relevant criteria to query')

    const skip = req.body.skip ? parseInt(req.body.skip) : 0
    let count = req.body.count ? parseInt(req.body.count) : (req.params.max_count ? req.params.max_count : 100)
    if (thePerm && thePerm.max_count && count + skip > thePerm.max_count) {
      count = Math.max(0, thePerm.max_count - skip)
    }
    let sort = (thePerm && thePerm.sort_fields) ? thePerm.sort_fields : req.body.sort
    if (!sort) sort = { _date_modified: -1 } // default
    if (!req.body.q) req.body.q = {}
    if (req.body.q._modified_before) {
      req.body.q._date_modified = { $lt: parseInt(req.body.q._modified_before) }
      delete req.body.q._modified_before
    }
    if (req.body.q._modified_after) {
      req.body.q._date_modified = { $gt: parseInt(req.body.q._modified_after) }
      delete req.body.q._modified_after
    }
    fdlog('In query to find', JSON.stringify(req.body.q), { sort }, 'count: ', req.body.count)
    let returnFields = null

    if (thePerm && thePerm.return_fields && thePerm.return_fields.length > 0) {
      returnFields = thePerm.return_fields
    }

    const transformQueryRegexes = function (q) {
      const ret = {}
      for (const [key, value] of Object.entries(q)) {
        if (key === '$regex' && typeof value === 'string') {
          ret[key] = new RegExp(value)
        } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || !value) {
          ret[key] = value
        } else if (Array.isArray(value)) {
          ret[key] = value.map(inner => transformQueryRegexes(inner))
        } else if (typeof value === 'object') {
          ret[key] = transformQueryRegexes(value)
        } else {
          console.warn('FUNNY EXPRESSION PASSED', { key, value })
          ret[key] = value
        }
      }
      return ret
    }

    // transform regexes
    try {
      const transfedRegex = transformQueryRegexes(req.body.q)
      req.body.q = transfedRegex
    } catch (e) {
      felog('Couldnot tranfrm query ', req.body.q)
    }

    req.freezrRequesteeDB.query(req.body.q,
      { sort, count, skip }, function (err, results) {
        if (err) {
          console.warn('got err for req.body.q ', req.body.q, { err })
          helpers.send_failure(res, err, 'app_handler', exports.version, 'do_db_query')
        } else {
          if (results && results.length > 0) {
            if (thePerm) {
              results.map(anitem => {
                anitem._owner = req.freezrAttributes.owner_user_id
                return anitem
              })
            }
            if (thePerm && thePerm.return_fields) results = results.map(record => { return reduceToPermittedFields(record, returnFields) })
            const sorter = function (sortParam) {
              const key = Object.keys(sortParam)[0]
              return function (obj1, obj2) {
                return sortParam[key] > 0 ? (obj1[key] > obj2[key]) : obj1[key] < obj2[key]
              }
            }
            results.sort(sorter(sort))
          }

          // if (manifest_permission_schema.max_count && all_permitted_records.length>manifest_permission_schema.max_count)  all_permitted_records.length=manifest_permission_schema.max_count
          if (req.internalcallfwd) {
            req.internalcallfwd(err, results)
          } else {
            // onsole.log('db)_query resilts results len - ', results.length)
            helpers.send_success(res, results)
          }
        }
      })
  }
}
exports.delete_record = function (req, res) {
  // app.delete('/feps/delete/:app_table/:data_object_id', userAPIRights, readWriteUserData, addUserFsFromTokenInfo, appHandler.delete_record)
  //   app.delete('/ceps/delete/:app_table/:data_object_id', userAPIRights, readWriteUserData, appHandler.delete_record)
  // app.delete('/feps/delete/:app_table/:data_object_start/*', userAPIRights, readWriteUserData, addUserFsFromTokenInfo, appHandler.delete_record)
  //   app.delete('/feps/delete/:app_table', userAPIRights, readWriteUserData, addUserFsFromTokenInfo, appHandler.delete_record)

  fdlog('delete ' + req.url, req.body)
  if (req.params.data_object_start) {
    const parts = req.path.split('/').slice(4)
    req.params.data_object_id = parts.join('/')
  } else if (!req.params.data_object_id) {
    // onsole.log('NO DATA ID - DELEE BY QUERY ')
  }

  fdlog('app_handler delete_record ' + req.url)

  // const appErr = function (message) { return helpers.app_data_error(exports.version, 'delete_record', req.freezrAttributes.requestor_app, message) }
  const authErr = function (message) { return helpers.auth_failure('app_handler', exports.version, 'delete_record', req.freezrAttributes.requestor_app + ': ' + message) }

  const [granted, bestGrantType] = checkWritePermission(req)

  const nowDeleteRecord = function () {
    req.freezrRequesteeDB.delete_record(req.params.data_object_id, null, function (err, deleteConfirm) {
      // fdlog("err",err,"deleteConfirm",deleteConfirm)
      if (err) {
        helpers.send_failure(res, err, 'app_handler', exports.version, 'delete_record')
      } else if (!deleteConfirm) {
        helpers.send_failure(res, new Error('unknown write error'), 'app_handler', exports.version, 'delete_record')
      } else {
        helpers.send_success(res, { success: true })
      }
    })
  }
  const nowDeleteRecords = function () {
    req.freezrRequesteeDB.delete_records(req.body, null, function (err, numDeleted) {
      fdlog({ err, numDeleted })
      if (err) {
        helpers.send_failure(res, err, 'app_handler', exports.version, 'delete_record')
      } else {
        helpers.send_success(res, { success: true, numDeleted })
      }
    })
  }

  if (!granted) {
    helpers.send_failure(res, authErr('unauthorized write access'), 'app_handler', exports.version, 'delete_record')
  } else if (bestGrantType === 'write_own') {
    if (!req.params.data_object_id) {
      helpers.send_failure(res, new Error('3rd parties with write_own permissions can only delete one record at a time'), 'app_handler', exports.version, 'delete_record')
    } else {
      req.freezrRequesteeDB.read_by_id(req.params.data_object_id, function (err, results) {
        if (err) {
          helpers.send_failure(res, err, 'app_handler', exports.version, 'delete_record')
        } else if (results._created_by_user !== req.freezrAttributes.requestor_user_id || results._created_by_app !== req.freezrAttributes.requestor_app) {
          helpers.send_failure(res, authErr('unauthorized record access'), 'app_handler', exports.version, 'delete_record')
        } else {
          nowDeleteRecord()
        }
      })
    }
    // need to read record and make sure it is own record before deleting
  } else if (helpers.endsWith(req.params.app_table, '.files')) {
    if (helpers.startsWith(req.path, '/ceps/delete')) {
      helpers.send_failure(res, new Error('cannot apply ceps to files'), 'app_handler', exports.version, 'delete_record')
    } else if (!req.params.data_object_id) {
      helpers.send_failure(res, new Error('Currently can only delete one file at a time'), 'app_handler', exports.version, 'delete_record')
    } else {
      const endpath = req.params.data_object_id
      req.freezrUserAppFS.removeFile(endpath, {}, function (err, results) {
        if (err) {
          console.warn('err in remove file ', endpath)
          helpers.send_failure(res, err, 'app_handler', exports.version, 'delete_record')
        } else {
          nowDeleteRecord()
        }
      })
    }
  } else if (req.params.data_object_id) {
    nowDeleteRecord()
  } else {
    nowDeleteRecords()
  }
}
exports.restore_record = function (req, res) {
  // app.post('/feps/restore/:app_table', userDataAccessRights, app_handler.restore_record)
  // body has record and options: password, updateRecord, data_object_id

  fdlog('feps restore_record at ' + req.url + ' body:' + JSON.stringify((req.body) ? req.body : ' none'))

  const write = req.body.record
  const options = req.body.options || {}
  const dataObjectId = options.data_object_id
  const isUpdate = dataObjectId && options.updateRecord
  const isUpsert = dataObjectId && options.upsertRecord

  const appErr = function (message) { return helpers.app_data_error(exports.version, 'restore_record', (options.app_name || req.params.app_table), message) }
  const authErr = function (message) { return helpers.auth_failure('app_handler', exports.version, 'restore_record', req.params.app_table + ': ' + message) }

  const permissionRestore = (req.params.app_table === 'info.freezr.admin.public_records') // todo re-review this after movign public_records to publc owner rather than fradmin

  async.waterfall([
    // 1. check app token .. and set user_id based on record if not a param...
    function (cb) {
      if (!req.session.logged_in_user_id || req.session.logged_in_user_id !== req.freezrAttributes.owner_user_id || (req.freezrAttributes.requestor_app !== 'info.freezr.account' && req.freezrAttributes.actualRequester !== 'info.freezr.account')) {
        cb(authErr('need to be logged in and requesting proper permissions ' + req.session.logged_in_user_id + ' vs ' + req.freezrAttributes.owner_user_id + ' app ' + req.freezrAttributes.requestor_app))
      } else if (Object.keys(write).length <= 0) {
        cb(appErr('No data to write'))
        // todo - also check if app_table starts with system app names
      } else if (permissionRestore) {
        if (req.session.logged_in_as_admin) {
          cb(null)
        } else {
          cb(authErr('need to be admin to restore admin records'))
        }
      } else {
        cb(null)
      }
    },

    function (cb) {
      if (!dataObjectId && !isUpdate && !isUpsert) { // Simple create object with no id
        cb(null, null)
      } else if (dataObjectId) { // isUpsert or update
        req.freezrRequesteeDB.read_by_id(dataObjectId, function (err, results) {
          cb(err, results)
        })
      } else {
        cb(appErr('Malformed path body combo 2'))
      }
    },

    // 4. write
    function (results, cb) {
      if (results && isUpdate && results._date_created /* ie is non empty record */) {
        req.freezrRequesteeDB.update(dataObjectId.toString(), write, { old_entity: results, restoreRecord: true, replaceAllFields: true }, cb)
      } else if (results && !isUpdate && !isUpsert) { // should have gotten results
        cb(appErr('Existing record found when this should not be an update '))
      } else if (isUpdate) { // should have gotten results
        cb(appErr('record not found for an update restore'))
      } else { // new document - should not have gotten results
        if (write._id) delete write._id
        req.freezrRequesteeDB.create(dataObjectId, write, { restoreRecord: true }, cb)
      }
    }
  ],
    function (err, writeConfirm) {
      fdlog('end restore rec ', { err, writeConfirm })
      if (err) {
        helpers.send_failure(res, err, 'app_handler', exports.version, 'restore_record')
      } else if (!writeConfirm) {
        helpers.send_failure(res, new Error('unknown write error'), 'app_handler', exports.version, 'restore_record')
      } else if (isUpdate) {
        helpers.send_success(res, writeConfirm)
      } else {
        helpers.send_success(res, {
          _id: writeConfirm._id,
          _date_created: writeConfirm._date_created,
          _date_modified: writeConfirm._date_modified
        })
      }
    })
}

// permission access operations
exports.shareRecords = function (req, res) {
  // After app-permission has been given, this sets or updates permission to access a record
  // app.post('/ceps/perms/share_records', userAPIRights, addUserPermsAndRequesteeDB, addPublicRecordsDB, appHandler.shareRecords)
  // app.post('/feps/perms/share_records', userAPIRights, addUserPermsAndRequesteeDB, addPublicRecordsDB, appHandler.shareRecords)
  /*
    NO requestorApp - this is automatically added on server side

    Options - CEPS
    name: permissionName - OBLOGATORY
    'table_id': app_name (defaults to app self) (Should be obligatory?)
    'action': 'grant' or 'deny' // default is grant
    grantee or list of 'grantees': people being granted access
    doNotList: whether the record shoudl show up on the feed

    NON CEPS options
    publicid: sets a publid id instead of the automated accessible_id (nb old was pid)
    pubDate: sets the publish date
    unlisted - for public items that dont need to be lsited separately in the public_records database
    idOrQuery being query is NON-CEPS - ie query_criteria or object_id_list - can be null for read_all, write_all
    fileStructure - for serving user uploaded web pages => json object with {js: [], css:[]}
  */
  fdlog('shareRecords, req.body: ', req.body)

  const queryFromBody = function (rec) {
    if (!rec) return null
    if (typeof rec === 'string') return { _id: rec }
    if (Array.isArray(rec)) return { $or: rec.map(arec => { return ({ _id: (typeof arec === 'string') ? arec : '' }) }) }
    if (typeof rec === 'object') return rec
    return null
  }
  const recordQuery = queryFromBody(req.body.record_id || req.body.object_id_list || req.body.query_criteria)
  const datePublished = req.body.grant ? (req.body.pubDate ? req.body.pubDate : new Date().getTime()) : null
  const isHtmlMainPage = req.body.isHtmlMainPage

  const userId = req.freezrTokenInfo.requestor_id // requestor and requestee are the same
  let requestorApp = req.freezrTokenInfo.app_name
  if (req.session.logged_in_user_id && req.session.logged_in_user_id === userId && req.freezrTokenInfo.app_name === 'info.freezr.account' && req.body.requestor_app) {
    // info.freezr.account can have access to any requestor_app
    requestorApp = req.body.requestor_app
    delete recordQuery.requestor_app
  }
  const proposedGrantees = req.body.grantees || []

  let grantedPermission = null
  let newRecordUniquePublicId = null

  const allowedGrantees = []
  const granteesNotAllowed = []
  let recordsToChange = []

  let hasPublicLink = false
  let hasPrivateFeed = false
  let hasPrivateLink = false
  let codeOrName = null
  const PERMS_WITH_ACCESS_TO_ALL_RECORDS = ['read_all', 'write_all', 'write_own', 'app_access']
  let permDoesntNeedTableId = false

  fdlog('shareRecords from ' + userId + 'for requestor app ' + requestorApp + ' query:' + JSON.stringify(recordQuery) + ' action' + JSON.stringify(req.body.grant) + ' perm: ' + req.body.name + ' action ' + req.params.action + ' req.freezrUserPrefs ' + req.freezrUserPrefs)
  function appErr(message) {
    return helpers.app_data_error(exports.version, 'shareRecords', req.freezrTokenInfo.app_name, message)
  }

  async.waterfall([
    // 0 make basic checks and get the perm
    function (cb) {
      if (req.body.publicid && (typeof req.body.record_id !== 'string' || (!req.session.logged_in_as_admin && !helpers.startsWith(req.body.publicid, ('@' + req.session.logged_in_user_id + '/'))))) { // implies: req.body.grantees.includes('_public') or 'privtefeed or privatelink'
        if (typeof req.body.record_id !== 'string') {
          cb(appErr('input error - cannot assign a public id to more than one entity - please include one record if under record_id'))
        } else {
          cb(appErr('input error - non admin users should always use the users name in their publicid, starting with an @ sign.'))
        }
        // todo - possible future conflict if a user signs up with a name which an admin wants to use for their url
      } else if (isHtmlMainPage && (!req.body.grantees.includes('_public') || typeof req.body.record_id !== 'string' || !helpers.endsWith(req.body.table_id, '.files') || !helpers.endsWith(req.body.record_id, 'html'))) {
        cb(appErr('input error - cannot assign a file structure to more than one entity, and it has to be made public, and end with html'))
      } else if (!req.body.name) {
        cb(appErr('error - need permission name to set access'))
        // } else if (!req.body.table_id) {
        //   cb(appErr('error - need requested table_id to work on permission'))
      } else if (!req.body.grantees || req.body.grantees.length < 1) {
        cb(appErr('error - need people or gorups to grant permissions to.'))
      } else if (!requestorApp) {
        cb(appErr('internal error getting requestor app'))
      } else {
        req.freezrUserPermsDB.query({ name: req.body.name, requestor_app: requestorApp }, {}, cb)
      }
    },
    function (results, cb) {
      if (!results || results.length === 0) {
        console.warn('req.body.name ', req.body.name, { requestorApp })
        cb(helpers.error('PermissionMissing', 'permission with name ' + req.body.name + ' and app ' + requestorApp + 'does not exist - try re-installing app'))
      } else if (!results[0].granted) {
        cb(helpers.error('PermissionNotGranted', 'permission not granted yet'))
      } else if (req.body.table_id && results[0].table_id !== req.body.table_id) {
        fdlog('results', results[0], 'req.body', req.body)
        console.warn('results[0].table_id ', results[0].table_id, 'req.body.table_id', req.body.table_id)
        cb(helpers.error('TableMissing', 'The table being granted permission to does not correspond to the permission '))
      } else if (!req.body.table_id && PERMS_WITH_ACCESS_TO_ALL_RECORDS.indexOf(results[0].type) < 0 && results[0].type !== 'use_app') {
        cb(appErr('error - need requested table_id to work on permission'))
      } else {
        if (results.length > 1) felog('two permissions found where one was expected ' + JSON.stringify(results))
        grantedPermission = results[0]
        permDoesntNeedTableId = PERMS_WITH_ACCESS_TO_ALL_RECORDS.indexOf(grantedPermission.type) >= 0 || grantedPermission.type === 'use_app'

        // fdlog({ grantedPermission })
        if (!recordQuery && !permDoesntNeedTableId) {
          cb(appErr('Missing query to set access'))
        } else if ((grantedPermission.type === 'share_records' || grantedPermission.type === 'message_records') && grantedPermission.table_id === req.freezrRequesteeDB.oac.app_table && !req.body.fileStructure && !isHtmlMainPage) {
          cb(null)
        } else if (grantedPermission.type === 'upload_pages' && req.freezrRequesteeDB.oac.app_table.split('.').pop() === 'files') {
          cb(null)
        } else if (permDoesntNeedTableId) {
          cb(null)
        } else {
          felog('check error ', { grantedPermission }, 'oac: ', req.freezrRequesteeDB.oac)
          console.warn('comped ' + req.freezrRequesteeDB.oac.app_table, ' with ', { grantedPermission })
          cb(new Error('Permission type mismatch for sharing'))
        }
      }
    },

    // make sure grantees are in ACL - assign them to allowedGrantees
    function (cb) {
      let tooManyRequests = false
      async.forEach(proposedGrantees, function (grantee, cb2) {
        if (typeof grantee !== 'string') {
          cb2(new Error('can only share with strings'))
        } else if (grantee === '_public') {
          if (hasPublicLink || hasPrivateLink || hasPrivateFeed) tooManyRequests = true
          hasPublicLink = true
          // todo-later conside grantedPermission.allowPublic to explicitly allow sharing with public
          allowedGrantees.push(grantee)
          cb2(null)
          // } else if (helpers.startsWith(grantee, '_privatelink:')) {
        } else if (grantee === '_privatelink') {
          if (hasPublicLink || hasPrivateLink || hasPrivateFeed) tooManyRequests = true
          hasPrivateLink = true
          // todo-later conside grantedPermission.allowPublic to explicitly allow sharing with public
          allowedGrantees.push(grantee)
          cb2(null)
        } else if (helpers.startsWith(grantee, 'group:')) {
          const name = grantee.substring(('group:'.length))
          req.freezrCepsGroups.query({ name }, null, function (err, results) {
            if (results && results.length > 0) {
              allowedGrantees.push(grantee)
            } else {
              granteesNotAllowed.push(grantee)
            }
            cb2(err)
          })
        } else if (helpers.startsWith(grantee, '_privatefeed:')) {
          if (hasPublicLink || hasPrivateLink || hasPrivateFeed) tooManyRequests = true
          hasPrivateFeed = true
          const name = grantee.substring(('_privatefeed:'.length))
          req.freezrCepsPrivateFeeds.query({ name }, null, function (err, results) {
            if (results && results.length > 0) {
              allowedGrantees.push(grantee)
            } else {
              granteesNotAllowed.push(grantee)
            }
            cb2(err)
          })
        } else { // if (grantee.indexOf('@') > 0)
          grantee = grantee.replace(/\./g, '_')
          if (req.freezrUserPrefs.blockMsgsFromNonContacts) {
            // to do - implement BlockMsgsFromNonContacts redo below for grantees with no servername
            const granteeParts = grantee.split('@')
            if (granteeParts.length < 2) {
              cb(new Error('need toimplement forinernal contact'))
            } else {
              fdlog('shareRecords - Considering grantee', grantee)
              req.freezrCepsContacts.query({ searchname: grantee }, null, function (err, results) {
                // req.freezrCepsContacts.query({ username: granteeParts[0], serverurl: granteeParts[1] }, null, function (err, results) {
                if (results && results.length > 0) {
                  allowedGrantees.push(grantee)
                } else {
                  granteesNotAllowed.push(grantee)
                }
                cb2(err)
              })
            }
          } else {
            allowedGrantees.push(grantee)
            cb(null)
          }
        }
        // else { // unkown type
        //   granteesNotAllowed.push(grantee)
        // }
      }, function (err) {
        // onsole.log({ granteesNotAllowed, allowedGrantees })
        if (tooManyRequests) {
          cb(new Error('Currently can only support one private feed or one public link or one private link at a time.'))
        } else if (allowedGrantees.length > 0) {
          cb(err)
        } else {
          cb(new Error('No grantees are in your contacts'))
        }
      })
    },

    // get the records and add the grantees in _accessible (or remove them)
    function (cb) {
      // onsole.log(recordQuery)
      if (permDoesntNeedTableId) {
        cb(null, null)
      } else {
        req.freezrRequesteeDB.query(recordQuery, null, cb)
      }
    },
    function (records, cb) {
      if (permDoesntNeedTableId) {
        cb(null)
      } else if (!records || records.length === 0) {
        cb(new Error('no records found to add or remove'))
      } else {
        recordsToChange = records
        async.forEach(recordsToChange, function (rec, cb2) {
          const accessible = rec._accessible || {}
          let publicid
          const fullPermName = (requestorApp + '/' + req.body.name).replace(/\./g, '_')

          if (req.body.grant) {
            allowedGrantees.forEach((grantee) => {
              grantee = grantee.replace(/\./g, '_')
              const granteeKey = (grantee === '_public' || grantee === '_privatelink') ? grantee : ((helpers.startsWith(grantee, '_privatefeed:')) ? grantee.substr(0, 12) : grantee)
              codeOrName = helpers.startsWith(grantee, '_privatefeed:') ? grantee.substr(13) : null

              if (!accessible[granteeKey]) accessible[granteeKey] = {}
              accessible[granteeKey].granted = true
              if (!accessible[granteeKey][fullPermName]) accessible[granteeKey][fullPermName] = { granted: true }

              if (grantee === '_public' || grantee === '_privatelink' || helpers.startsWith(grantee, '_privatefeed:')) {
                publicid = ((grantee === '_public' && req.body.publicid) ? req.body.publicid : ('@' + userId + '/' + req.body.table_id + '/' + rec._id.toString()))
                accessible[granteeKey][fullPermName].public_id = publicid
                accessible[granteeKey][fullPermName]._date_published = datePublished
                accessible[granteeKey][fullPermName]._date_modified = new Date().getTime
                newRecordUniquePublicId = publicid

                if (grantee === '_privatelink') {
                  if (!accessible[granteeKey][fullPermName].codes) accessible[granteeKey][fullPermName].codes = []
                  codeOrName = helpers.randomText(20)
                  accessible[granteeKey][fullPermName].codes.push(codeOrName)
                } else if (helpers.startsWith(grantee, '_privatefeed:')) {
                  if (!accessible[granteeKey][fullPermName].names) accessible[granteeKey][fullPermName].names = []
                  accessible[granteeKey][fullPermName].names.push(codeOrName)
                }
              }
            })
          } else { // revoke
            req.body.grantees.forEach((grantee) => {
              grantee = grantee.replace(/\./g, '_')
              const granteeKey = (grantee === '_public' || grantee === '_privatelink') ? grantee : (helpers.startsWith(grantee, '_privatefeed:')) ? grantee.substr(0, 12) : grantee
              // future - could keep all public id's and then use those to delete them later
              if (accessible[granteeKey] && accessible[granteeKey][fullPermName]) {
                publicid = accessible[granteeKey][fullPermName].public_id
                delete accessible[granteeKey][fullPermName]
              }
              let isEmpty = true
              for (const perm in accessible[granteeKey]) if (perm !== 'granted' && perm !== 'messaged') isEmpty = false
              if (isEmpty) {
                if (accessible[granteeKey] && accessible[granteeKey].messaged) {
                  accessible[grantee].granted = false
                } else if (accessible[grantee]) {
                  delete accessible[grantee]
                }
              }
            })
          }
          // fdlog('updating freezrRequesteeDB ',rec._id,'with',{accessible})
          const updates = { _accessible: accessible }
          if (isHtmlMainPage) { // assumes allowedGrantees.includes('_public') && && helpers.endsWith(req.body.table_id, '.files'
            updates.isHtmlMainPage = true
            updates.fileStructure = req.body.fileStructure
          }

          // check if public if has already been used
          if (req.body.publicid) {
            req.freezrPublicRecordsDB.query(req.body.publicid, {}, function (err, results) {
              if (err) {
                cb2(err)
              } else if (results.length > 0 && (results[0].original_app_table !== req.body.table_id || results[0].original_record_id !== rec._id)) {
                console.warn('req.body.publicid used - to recheck this ' + req.body.publicid + ' req.body.table_id', req.body.table_id, 'rec._id ', rec._id, results)
                cb2(new Error('Another entity already has the id requested.'))
              } else {
                req.freezrRequesteeDB.update(rec._id.toString(), updates, { newSystemParams: true }, function (err, results) {
                  cb2(err)
                })
              }
            })
          } else {
            req.freezrRequesteeDB.update(rec._id.toString(), updates, { newSystemParams: true }, function (err, results) {
              fdlog('sharing - updated ', { rec, updates })
              cb2(err)
            })
          }
        }, cb)
      }
    },

    // add the grantees to the permission record
    function (cb) {
      if (req.body.grant) {
        let granteeList = grantedPermission.grantees || []
        allowedGrantees.forEach((grantee) => {
          grantee = grantee.replace(/\./g, '_')
          granteeList = helpers.addToListAsUnique(granteeList, grantee)
        })
        req.freezrUserPermsDB.update(grantedPermission._id.toString(), { grantees: granteeList }, { replaceAllFields: false }, function (err, results) {
          cb(err)
        })
        // note that the above live is cumulative.. it could be cleaned if it bloats
      } else {
        // console.log - todo in future, create a more complex algorithm to check if all records shared with grantee have been removed and then remove the grantees
        // cirrently list contains all names of people with whome a record hasd been shared in the past, even if revoked later
        cb(null)
      }
    },

    // for public records, add them to the public db
    function (cb) {
      if (hasPublicLink || hasPrivateFeed || hasPrivateLink) {
        async.forEach(recordsToChange, function (rec, cb2) {
          const publicid = (hasPublicLink && req.body.publicid) ? req.body.publicid : ('@' + userId + '/' + req.body.table_id + '/' + rec._id.toString())
          let searchWords = []
          if (grantedPermission.searchFields && grantedPermission.searchFields.length > 0) {
            searchWords = helpers.getUniqueWords(rec, grantedPermission.searchFields)
          }
          let originalRecord = {}
          if (grantedPermission.return_fields && grantedPermission.return_fields.length > 0) {
            grantedPermission.return_fields.forEach(item => {
              originalRecord[item] = rec[item]
            });
            ['_date_created', '_date_modified', '_id'].forEach(item => {
              originalRecord[item] = rec[item]
            })
          } else {
            originalRecord = rec
          }

          req.freezrPublicRecordsDB.query({ data_owner: userId, original_record_id: rec._id, original_app_table: req.body.table_id }, {}, function (err, results) {
            const accessiblesObject = {
              data_owner: userId,
              original_app_table: req.body.table_id,
              requestor_app: requestorApp,
              permission_name: req.body.name,
              original_record_id: rec._id,
              original_record: originalRecord,
              search_words: searchWords,
              _date_published: datePublished,
              fileStructure: isHtmlMainPage ? req.body.fileStructure : null,
              doNotList: req.body.doNotList,
              isHtmlMainPage
            }
            fdlog('freezrPublicRecordsDB query for id ' + rec._id, { results }, 'body: ', req.body)
            if (err) {
              cb2(err)
            } else if (results.length > 1) {
              cb2(helpers.state_error('app_handler', exports.version, 'shareRecords', 'multiple_permissions', new Error('Retrieved moRe than one permission where there should only be one ' + JSON.stringify(results)), null))
              // todo delete other ones?
            } else if (results.length > 0 && results[0].permission_name !== req.body.name) {
              cb2(new Error('Permission name mismatch. Currently freezr only deals with one public entity per permission name'))
            } else if (req.body.grant && results.length > 0 && results[0]._id !== publicid) {
              cb2(new Error('Please ungrant the permission so as to delete the old file before changing public ids'))
            } else { // update existing accessible record
              if (req.body.grant) {
                if (isHtmlMainPage) { // assumes && allowedGrantees.includes('_public') && helpers.endsWith(req.body.table_id, '.files')
                  const path = rec._id
                  req.freezrUserAppFS.readUserFile(path, {}, function (err, contents) {
                    if (err) {
                      cb2(err)
                    } else if (!results || results.length === 0) {
                      accessiblesObject.html_page = contents
                      newRecordUniquePublicId = publicid
                      req.freezrPublicRecordsDB.create(publicid, accessiblesObject, {}, cb2)
                    } else {
                      newRecordUniquePublicId = publicid
                      accessiblesObject.html_page = contents
                      req.freezrPublicRecordsDB.update(publicid, accessiblesObject, {}, function (err, results) {
                        cb2(err)
                      })
                      // req.freezrPublicAppFS.writeToUserFiles(publicid, results, {}, function (err, results)
                    }
                  })
                } else if (results.length > 0) { // ie === 1
                  accessiblesObject._date_published = req.body.pubDate || results[0]._date_published
                  accessiblesObject.doNotList = results[0].doNotList
                  if (hasPrivateFeed) {
                    accessiblesObject.isPublic = results[0].isPublic
                    accessiblesObject.privateLinks = results[0].privateLinks
                    if (results[0].privateFeedNames) {
                      accessiblesObject.privateFeedNames = results[0].privateFeedNames
                      accessiblesObject.privateFeedNames.push(codeOrName)
                    } else {
                      accessiblesObject.privateFeedNames = [codeOrName]
                    }
                  } else if (hasPrivateLink) {
                    accessiblesObject.isPublic = results[0].isPublic
                    accessiblesObject.privateFeedNames = results[0].privateFeedNames
                    if (results[0].privateLinks) {
                      accessiblesObject.privateLinks = results[0].privateLinks
                      accessiblesObject.privateLinks.push(codeOrName)
                    } else {
                      accessiblesObject.privateLinks = [codeOrName]
                    }
                  } else {
                    accessiblesObject.privateFeedNames = results[0].privateFeedNames
                    accessiblesObject.privateLinks = results[0].privateLinks
                    accessiblesObject.isPublic = true
                  }
                  req.freezrPublicRecordsDB.update(publicid, accessiblesObject, {}, function (err, results) {
                    cb2(err)
                  })
                } else { // create object
                  if (hasPrivateFeed) {
                    accessiblesObject.privateFeedNames = [codeOrName]
                    accessiblesObject.isPublic = false
                  } else if (hasPrivateLink) {
                    accessiblesObject.privateLinks = [codeOrName]
                    accessiblesObject.isPublic = false
                  } else { // ispublic
                    accessiblesObject.isPublic = true
                  }
                  req.freezrPublicRecordsDB.create(publicid, accessiblesObject, {}, cb2)
                }
              } else { // remove grant
                if (hasPrivateFeed) {
                  accessiblesObject.isPublic = (results && results.length > 0) ? results[0].isPublic : false
                  accessiblesObject.privateLinks = (results && results.length > 0) ? results[0].privateLinks : null
                  accessiblesObject.privateFeedNames = helpers.removeFromListIfExists(accessiblesObject.privateFeedNames, codeOrName)
                } else if (hasPrivateLink) {
                  accessiblesObject.isPublic = (results && results.length > 0) ? results[0].isPublic : false
                  accessiblesObject.privateFeedNames = (results && results.length > 0) ? results[0].privateFeedNames : null
                  accessiblesObject.privateLinks = helpers.removeFromListIfExists(accessiblesObject.privateLinks, codeOrName)
                } else {
                  accessiblesObject.privateLinks = (results && results[0] && results[0].privateLinks) ? results[0].privateLinks : null
                  accessiblesObject.privateFeedNames = (results && results[0] && results[0].privateFeedNames) ? results[0].privateFeedNames : null
                  accessiblesObject.isPublic = false
                }
                if (!accessiblesObject.isPublic && (!accessiblesObject.privateFeedNames || accessiblesObject.privateFeedNames.length === 0) && (!accessiblesObject.privateLinks || accessiblesObject.privateLinks.length === 0)) {
                  req.freezrPublicRecordsDB.delete_record(publicid, {}, cb2)
                } else {
                  accessiblesObject._date_published = results[0]._date_published
                  accessiblesObject.doNotList = results[0].doNotList
                  req.freezrPublicRecordsDB.update(publicid, accessiblesObject, {}, function (err, results) {
                    cb2(err)
                  })
                }
              }
            }
          })
        }, function (err) {
          // onsole.log('end of share ', { err })
          cb(err)
        })
      } else {
        cb(null)
      }
    }
  ],
    function (err, results) {
      fdlog('end of share', { err, results }, 'publidcIds: ', req.body.publicid, 'vs ' + newRecordUniquePublicId)
      if (err) {
        felog(err, results)
        helpers.send_failure(res, err, 'app_handler', exports.version, 'shareRecords')
      } else if (req.body.publicid || newRecordUniquePublicId) { // added newRecordUniquePublicId 2022-12 - isHtmlMainPage affected? todo review?
        helpers.send_success(res, { record_id: req.body.record_id, _publicid: newRecordUniquePublicId, code: codeOrName, _date_published: datePublished, grant: req.body.grant, recordsChanged: (recordsToChange.length) })
      } else {
        helpers.send_success(res, { success: true, recordsChanged: (recordsToChange.length) })
      }
    })
}
const checkWritePermission = function (req, forcePermName) {
  // console.log todo note using groups, we should also pass on all the groups user is part of and check them
  if (req.freezrAttributes.own_record && helpers.startsWith(req.params.app_table, req.freezrAttributes.requestor_app)) return [true, 'write_all', []]
  // to do - review above - 2nd expression redundant?
  if (req.freezrAttributes.requestor_app === 'info.freezr.account' && req.freezrAttributes.owner_user_id === req.freezrAttributes.requestor_user_id && req.freezrAttributes.requestor_user_id === req.session.logged_in_user_id) return [true, 'write_all', []]
  function mostPowerfulOf(type1, type2) {
    if (type1 === 'write_all' || type2 === 'write_all') return 'write_all'
    if (type1 === 'write_own' || type2 === 'write_own') return 'write_own'
    return null
  }

  let granted = false
  let grantType = null
  const relevantAndGrantedPerms = []
  req.freezrAttributes.grantedPerms.forEach(perm => {
    if (['write_all', 'write_own'].includes(perm.type) &&
      (perm.grantees.includes(req.freezrAttributes.requestor_user_id) ||
        perm.grantees.includes('_allUsers'))
    ) {
      if (!forcePermName || perm.name === forcePermName) {
        granted = true
        grantType = mostPowerfulOf(grantType, perm.type)
        relevantAndGrantedPerms.push(perm)
      }
    }
  })
  return [granted, grantType, relevantAndGrantedPerms]
}
const checkReadPermission = function (req, forcePermName) {
  fdlog('checkReadPermission freezrAttributes', req.freezrAttributes)
  if (req.freezrAttributes.own_record) return [true, true, []]
  if (req.freezrAttributes.owner_user_id === req.freezrAttributes.requestor_user_id && ['dev.ceps.contacts', 'dev.ceps.groups'].indexOf(req.freezrRequesteeDB.oac.app_table) > -1 && req.freezrAttributes.requestor_app === 'info.freezr.account') return [true, true, [{ type: 'db_query' }]]
  // if (req.session.logged_in_as_admin && ['dev.ceps.contacts', 'dev.ceps.groups'].indexOf(req.freezrRequesteeDB.oac.app_table) > -1 && req.freezrAttributes.requestor_app === 'info.freezr.account') return [true, true, [{ type: 'db_query' }]]
  if (req.session.logged_in_as_admin && ['info.freezr.admin.visitAuthFailures', 'info.freezr.admin.visitLogs'].indexOf(req.freezrRequesteeDB.oac.app_table) > -1 && req.freezrAttributes.requestor_app === 'info.freezr.admin') return [true, true, [{ type: 'db_query' }]]
  // console.log - todo - all system manifests and permissions should be separated out and created in config files and populated upom initiation


  let granted = false
  let readAll = false
  const relevantAndGrantedPerms = []
  req.freezrAttributes.grantedPerms.forEach(perm => {
    if (['write_all', 'write_own', 'read_all', 'share_records'].includes(perm.type) &&
      // above is reduncant as only these threee types ar allowed, but future types may differ
      (req.freezrAttributes.requestor_user_id === req.freezrAttributes.owner_user_id ||
        perm.grantees.includes(req.freezrAttributes.requestor_user_id) ||
        perm.grantees.includes('_public') || // console.log: todo: || includes valid group names [2021 - groups]
        perm.grantees.includes('_allUsers'))
    ) {
      if (!forcePermName || perm.name === forcePermName) {
        granted = true
        relevantAndGrantedPerms.push(perm)
        readAll = readAll || ['write_all', 'read_all'].includes(perm.type)
      }
    }
    // moved up 2023-05
    // readAll = readAll || ['write_all', 'read_all'].includes(perm.type)
  })
  fdlog({ granted, readAll, relevantAndGrantedPerms })
  return [granted, readAll, relevantAndGrantedPerms]
}

// MESSAGES
exports.messageActions = function (req, res) {
  fdlog('received messageActions at', req.body, req.params.action, 'req.freezrUserPrefs ', req.freezrUserPrefs)
  switch (req.params.action) {
    case 'initiate': {
      fdlog('share initiate')
      // make sure app has sharing permission and conctact permission
      // record message in 'messages sent'
      // communicate it to the other person's server
      // ceps/messages/transmit
      /*
      {
        type: ‘share_records’, // or message_records' based on permission type
        recipient_host : ‘https://data-vault.eu’,
        recipient_id : ‘christoph’,
        group_name:
        sharing_permission : ‘link_share’,
        contact_permission : ‘friends’,
        group_permission : ‘friends’,
        table_id : ‘com.salmanff.vulog.marks’,
        record_id : ‘randomRecordId123’,
NEW     record: (for message_records)
NEW     messaging_permission: 'message_link'
NEW     message:
        app_id :
        sender_id :
        sender_host :
      }
      */
      let sharingPerm = null
      let messagingPerm = null // NEWDO?
      let contactPerm = null
      let groupPerm = null
      let permittedRecord = null
      let recordAccessibleField = {}
      const recipientsSuccessfullysentTo = []
      const recipientsWithErrorsSending = []
      const params = req.body
      const recipientFullName = (params.recipient_id + '@' + params.recipient_host).replace(/\./g, '_')
      if (!params.sender_id) params.sender_id = req.freezrTokenInfo.requestor_id
      if (!params.app_id) params.app_id = req.freezrTokenInfo.app_name
      const isRecordLessMessageReply = (params.message_id && !params.record_id && params.type === 'message_records')

      async.waterfall([
        // 1 basic checks
        function (cb) {
          const objectFieldsHaveAllStrings = function (object, objectParams) {
            let failed = false
            objectParams.forEach(key => { if (!object[key] || typeof (object[key]) !== 'string') failed = true })
            return !failed
          }
          const arrayFieldsHaveAllStrings = function (list) {
            let failed = false
            list.forEach(item => { if (typeof item !== 'string') failed = true })
            return !failed
          }

          if (!objectFieldsHaveAllStrings(params, ['app_id', 'sender_id', 'sender_host', 'contact_permission', 'table_id'] || (!params.record_id && !params.message_id))) {
            cb(new Error('field insufficency mismatch'))
          } else if (params.type !== 'share_records' && params.type !== 'message_records') {
            cb(helpers.error(null, 'only share_records and message-_ecords type messaging currently allowed'))
          } else if (params.sender_id !== req.freezrTokenInfo.requestor_id) {
            cb(helpers.error(null, 'requestor id mismatch'))
          } else if (params.app_id !== req.freezrTokenInfo.app_name) {
            cb(helpers.error(null, 'app id mismatch'))
          } else if ((!params.sharing_permission && !params.messaging_permission) || !params.contact_permission) {
            cb(helpers.error(null, 'missing permission names in request'))
          } else if (!params.recipient_id && !params.group_name && !params.group_members) {
            cb(helpers.error(null, 'malformed recipients in request'))
          } else if (params.recipient_id && typeof params.recipient_id !== 'string') {
            cb(helpers.error(null, 'recipient_id invalid'))
          } else if (params.group_name && typeof params.group_name !== 'string') {
            cb(helpers.error(null, 'recipient_id invalid'))
          } else if (params.group_members && !arrayFieldsHaveAllStrings(params.group_members)) {
            cb(helpers.error(null, 'group_members invalid'))
          } else if (params.message && typeof params.message !== 'string') {
            cb(helpers.error(null, 'message related to a message must be text'))
          } else {
            cb(null)
          }
        },
        // 2 check message permision
        function (cb) {
          req.freezrUserPermsDB.query({ requestor_app: req.freezrTokenInfo.app_name }, {}, cb)
        },
        function (results, cb) {
          if (!results || results.length === 0) {
            cb(helpers.error('Message Permission Missing', 'Sharing Permissions missing - internal'))
          } else {
            // note: these should be someaht redundant checks as shareRecords would have already taken place - see next step
            results.forEach(aPerm => {
              if (aPerm.name === params.sharing_permission &&
                aPerm.granted && aPerm.type === 'share_records' && params.type === 'share_records' &&
                aPerm.table_id === req.freezrRequesteeDB.oac.app_table
              ) sharingPerm = aPerm
              if (aPerm.name === params.messaging_permission &&
                aPerm.granted && aPerm.type === 'message_records' && params.type === 'message_records' &&
                aPerm.table_id === req.freezrRequesteeDB.oac.app_table
              ) messagingPerm = aPerm
              if (aPerm.name === params.contact_permission &&
                aPerm.granted && aPerm.table_id === 'dev.ceps.contacts' &&
                (aPerm.type === 'read_all' || aPerm.type === 'write_own' || aPerm.type === 'write_all')
              ) contactPerm = aPerm
              if (aPerm.name === params.contact_permission &&
                aPerm.granted && aPerm.table_id === 'dev.ceps.groups' &&
                (aPerm.type === 'read_all' || aPerm.type === 'write_own' || aPerm.type === 'write_all')
              ) groupPerm = aPerm
            })
            if ((sharingPerm || messagingPerm) && (contactPerm || groupPerm)) {
              cb(null)
            } else {
              cb(new Error('Permission type mismatch for messaging'))
            }
          }
        },

        // 3 get record and make sure grantee is in it.. keep a copy
        function (cb) {
          if (params.record_id) {
            req.freezrRequesteeDB.read_by_id(params.record_id, cb)
          } else if (isRecordLessMessageReply) {
            req.freezrGotMessages.read_by_id(params.message_id, cb)
          } else {
            cb(new Error('no record id or message id provided'))
          }
        },
        // consdtruct a permitted-record
        function (fetchedRecord, cb) {
          if (params.type === 'share_records') {
            if (!fetchedRecord) {
              cb(helpers.error(null, 'no related records'))
            } else if (!fetchedRecord._accessible || !fetchedRecord._accessible[recipientFullName] || !fetchedRecord._accessible[recipientFullName].granted) {
              cb(helpers.error(null, 'permission not granted'))
            } else {
              fdlog('share initiate ', { fetchedRecord })
              recordAccessibleField = fetchedRecord._accessible

              if (sharingPerm.return_fields && sharingPerm.return_fields.length > 0) {
                permittedRecord = {}
                sharingPerm.return_fields.forEach(key => {
                  permittedRecord[key] = fetchedRecord[key]
                })
              } else {
                permittedRecord = JSON.parse(JSON.stringify(fetchedRecord))
              }
              delete permittedRecord._accessible
              cb(null)
            }
          } else if (params.type === 'message_records') {
            if (!fetchedRecord) {
              cb(helpers.error(null, 'no related records'))
            } else if (messagingPerm.table_id !== req.freezrRequesteeDB.oac.app_table) {
              cb(helpers.error(null, 'messaging table id mismatch ' + messagingPerm.table_id + ' vs ' + req.freezrRequesteeDB.oac.app_table))
            } else {
              recordAccessibleField = fetchedRecord._accessible

              fdlog('message initiate ', { fetchedRecord })

              // check permission
              if (messagingPerm && messagingPerm.return_fields && messagingPerm.return_fields.length > 0) {
                permittedRecord = {} // newdo -> make this the shares record...
                /// also add message field
                messagingPerm.return_fields.forEach(key => {
                  permittedRecord[key] = params.record[key]
                  // todo later check here is shared item is a subset of the record and if not throw error
                })
              } else {
                permittedRecord = JSON.parse(JSON.stringify(params.record))
              }
              delete permittedRecord._accessible
              cb(null)
            }
          } else {
            cb(helpers.error(null, 'snbh type was already checked ??? '))
          }
          // update the record to show it has been messaged. (This really should be done after the 'verify' step)
        },

        function (cb) {
          //   if (params.recipient_id) {
          //     const fullname = params.recipient_id + (params.recipient_host ? ('@' + params.recipient_host) : '')
          //     cb(null, [fullname])
          //   } else if (params.group_members) {
          //     cb(null, params.group_members)
          //   } else if (params.group_name && typeof params.group_name === 'string') {
          //     req.freezrCepsGroups.query({ name: params.group_name }, null, function (err, groups) {
          //       if (err) {
          //         cb(err)
          //       } else if (!groups || groups.length < 1) {
          //         cb(new Error('No groups found'))
          //       } else {
          //         if (groups.length > 1) { console.warn('snbh - found 2 groups of same name') }
          //         cb(null, groups[0].members)
          //       }
          //     })
          //   }
          // },
          //
          // function (members, cb) {
          //   console.log(' sharign with ', { members })
          if (!req.freezrMessageToMembers || req.freezrMessageToMembers.length === 0) {
            console.warn('no members to share with')
            cb(new Error('No members to sharewith'))
          } else {
            async.forEach(req.freezrMessageToMembers, function (member, cb2) {
              const parts = member.split('@')
              const username = parts[0]
              const serverurl = parts.length > 1 ? parts[1] : null
              // todo if req.freezrBlockMsgsToNonContacts is false then this call is redundant - more efficient not to do it
              req.freezrCepsContacts.query({ username, serverurl }, {}, function (err, results) {
                if (err) {
                  recipientsWithErrorsSending.push({ fullname: member, reasons: err.message })
                  cb2()
                } else if (req.freezrUserPrefs.blockMsgsToNonContacts && (!results || results.length === 0)) {
                  recipientsWithErrorsSending.push({ fullname: member, reasons: 'member not in contacts' })
                  cb2()
                } else {
                  if (results.length > 1) {
                    felog('SNBH - two contacts found where one was expected ' + JSON.stringify(results))
                    recipientsWithErrorsSending.push({ fullname: member, reasons: '2 member are same of same not in contacts - sent to first' })
                  }
                  const paramsCopy = JSON.parse(JSON.stringify(params))
                  paramsCopy.recipient_id = username
                  delete paramsCopy.record
                  if (!serverurl || paramsCopy.recipient_host === paramsCopy.sender_host) {
                    paramsCopy.recipient_host = null
                    paramsCopy.group_members = req.freezrMessageToMembers
                    sameHostMessageExchange(req, username, permittedRecord, params, function (err) {
                      if (err) {
                        recipientsWithErrorsSending.push({ fullname: member, reasons: 'failure to send' })
                      } else {
                        recipientsSuccessfullysentTo.push(member)
                      }
                      cb2()
                    })
                  } else {
                    paramsCopy.recipient_host = serverurl
                    paramsCopy.group_members = reconfigureMembersBySwitchingSendersAndReceivers(req.freezrMessageToMembers, params.sender_host, params.recipient_host)
                    createAndTransmitMessage(req.freezrSentMessages, permittedRecord, paramsCopy, function (err) {
                      if (err) {
                        felog('transmitted msg with ', { err })
                        recipientsWithErrorsSending.push({ fullname: member, reasons: 'failure to send' })
                      } else {
                        recipientsSuccessfullysentTo.push(member)
                      }
                      cb2()
                    })
                  }
                }
              })
            }, cb)
          }
        },

        function (cb) {
          if (isRecordLessMessageReply) {
            cb(null, null)
          } else {
            if (!recordAccessibleField) recordAccessibleField = {}
            recipientsSuccessfullysentTo.forEach(member => {
              member = member.replace(/\./g, '_')
              if (!recordAccessibleField[member]) recordAccessibleField[member] = {}
              if (!recordAccessibleField[member].messaged) recordAccessibleField[member].messaged = []
              recordAccessibleField[member].messaged.push(new Date().getTime()) // newd -> list of dates??
            })
            req.freezrRequesteeDB.update(params.record_id.toString(), { _accessible: recordAccessibleField }, { replaceAllFields: false, newSystemParams: true }, cb)
          }
        }

      ], function (err, ret) {
        if (err) {
          console.warn({ err })
          helpers.send_failure(res, err, 'app_handler', exports.version, 'messageActions transmit')
        } else {
          helpers.send_success(res, { success: true, recipientsSuccessfullysentTo, recipientsWithErrorsSending })
        }
      })
    }
      break
    case 'transmit':
      {
        fdlog('share transmit ', req.body)
        // see if is in contact db and if so can get the details - verify it and then record
        // see if sender is in contacts - decide to keep it or not and to verify or not
        // record message in 'messages got' and then do a verify
        const receivedParams = req.body
        let storedmessageId = null
        let senderIsAContact = false
        let status = 0
        async.waterfall([
          function (cb) {
            const fields = ['app_id', 'sender_id', 'sender_host', 'recipient_host', 'recipient_id', 'type', 'contact_permission', 'table_id', 'nonce', 'message', 'messaging_permission', 'group_members', 'record_id', 'record', 'message_id']
            const fieldExceptions = ['message', 'record_id', 'record', 'message_id']
            let failed = false
            if (!req.body.type) { req.body.type = 'share_records' } // temp hacj to revisit and fix
            for (const [key, keyObj] of Object.entries(req.body)) {
              if (fields.includes(key)) {
                if (typeof req.body[key] === 'string') receivedParams[key] = keyObj
                // todo later - add additional checks here
              } else if (key !== 'message') {
                felog('message sent unnecessary field - need to fix and add back failure for security purposes ', key)
                // failed = true
              }
            }
            fields.forEach(key => { if (!receivedParams[key] && !fieldExceptions.includes(key)) failed = true })
            if (failed) {
              cb(new Error('failed to get keys for sharing'))
            } else {
              cb(null)
            }
          },
          // check that recipient has sender as contact
          function (cb) {
            req.freezrCepsContacts.query({ username: receivedParams.sender_id, serverurl: receivedParams.sender_host }, {}, cb)
          },
          function (results, cb) {
            if (!results || results.length === 0) {
              if (req.freezrUserPrefs.blockMsgsFromNonContacts) {
                senderIsAContact = false
                cb(helpers.error('contact PermissionMissing', 'contact does not exist - Cannot send'))
              } else {
                senderIsAContact = false
                cb(null)
              }
            } else {
              senderIsAContact = true
              if (results.length > 1) felog('two contacts found where one was expected ' + JSON.stringify(results))
              cb(null)
            }
          },
          // store message
          function (cb) {
            // todo check message receivedParams
            status++ // = 1
            delete receivedParams._id
            receivedParams.senderIsAContact = senderIsAContact
            req.freezrGotMessages.create(null, receivedParams, null, cb)
          },
          // confirm message receipt
          function (confirmed, cb) {
            status++ // = 2
            storedmessageId = confirmed._id.toString()
            // helpers.send_success(res, { success: true })
            cb(null)
          },
          // verify the nonce and get the record and update the record on the db
          function (cb) {
            const isLocalhost = helpers.startsWith(receivedParams.sender_host, 'http://localhost')
            const https = isLocalhost ? require('http') : require('https')

            const options = {
              hostname: isLocalhost ? 'localhost' : receivedParams.sender_host.slice(8),
              path: '/ceps/message/verify',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': JSON.stringify(receivedParams).length
              }
            }
            if (isLocalhost) options.port = receivedParams.sender_host.slice(17)
            const verifyReq = https.request(options, (verifyRes) => {
              let chunks = ''
              // var chunks = []
              verifyRes.on('data', function (chunk) {
                fdlog('got data chunk -' + chunk.toString('utf-8') + '- End Chunk')
                chunk = chunk.toString('utf-8')
                if (chunk.slice(-1) === '\n') chunk = chunk.slice(0, -1)
                // chunks.push(chunk)
                chunks += chunk
              })

              verifyRes.on('end', function () {
                // let data = Buffer.concat(chunks).toString('utf-8')
                let data = chunks
                fdlog('data chunks now -' + chunks + '- end chunks')
                try {
                  data = JSON.parse(data)
                  cb(null, data)
                } catch (e) {
                  felog('error parsing message in transmit', e)
                  cb(e)
                }
              })
            })
            verifyReq.on('error', (error) => {
              felog('error in transmit ', error)
              cb(helpers.error('message transmission error 1'))
            })
            verifyReq.write(JSON.stringify(receivedParams))
            verifyReq.end()
          },
          // update the record
          function (returns, cb) {
            status++ // = 3
            if (returns.record) {
              req.freezrGotMessages.update(storedmessageId, { message: returns.message, record: returns.record, status: 'verified' }, { replaceAllFields: false }, cb)
            } else {
              // records not sent could be due to internal problem at other server or choice of other server (in future) of not sendinfg record on 'verify' - ignore and deal with separately - app can fetch record_id
              cb(null)
            }
          }
        ],
          function (err) {
            if (err) {
              felog('internal error in transmit', err)
              // todo customise error handling and whther response should be given, based on more refined preferences
              if (status > 1 || receivedParams.senderIsAContact) helpers.send_failure(res, helpers.error('internal error in transmit'), 'app_handler', exports.version, 'messageActions')
              // ie do not respond if the sender is not a contact
            } else {
              helpers.send_success(res, { success: true })
            }
          })
      }
      break
    case 'verify':
      {
        // verify by pinging the sender server of the nonce and getting the info
        // fetch record nonce - have a max time...
        // check other parameters?
        // responde with {record: xxxx}
        fdlog('share verify')
        const haveDifferentMessageFields = function (m1, m2) {
          const fields = ['app_id', 'sender_id', 'sender_host', 'recipient_host', 'recipient_id', 'contact_permission', 'table_id', 'record_id']
          let failed = false
          fields.forEach(key => { if (m1.key !== m2.key) failed = true })
          return failed
        }
        if (!req.body.nonce) {
          felog('nonce required to verify messages ', req.body)
          res.sendStatus(401)
        } else {
          req.freezrSentMessages.query({ nonce: req.body.nonce }, {}, function (err, results) {
            if (err) {
              felog('error getting nonce in message ', req.body)
              helpers.send_failure(res, helpers.error('internal error'), 'app_handler', exports.version, 'messageActions')
            } else if (!results || results.length === 0) {
              felog('no results from nonce in message ', req.body)
              // Not send a respoinse to avoid spam
              // res.sendStatus(401)
            } else if (haveDifferentMessageFields(results[0], req.body)) {
              felog('Message mismatch ', req.body)
              // Not send a respoinse to avoid spam
              // res.sendStatus(401)
            } else {
              // todo - discard old nonces???
              req.freezrSentMessages.update(results[0]._id.toString(), { status: 'verified', nonce: null }, { replaceAllFields: false }, function (err) {
                if (err) felog('error updating sent messages')
                helpers.send_success(res, { record: results[0].record, message: results[0].message, success: true })
              })
            }
          })
        }
      }
      break
    case 'get':
      fdlog('share get - Not Used')
      /* {
      // get own messages
      const theQuery = {
        app_id: req.freezrTokenInfo.app_name
      }
      if (req.query._modified_after) {
        theQuery._date_modified = { $gt: req.query._modified_after }
      } else if (req.query._modified_before) {
        theQuery._date_modified = { $lt: req.query._modified_before }
      }
      req.freezrGotMessages.query(theQuery, {}, function (err, results) {
        if (err) {
          helpers.send_failure(res, helpers.error(null, 'internal error getting messages'), 'app_handler', exports.version, 'messageActions')
        } else {
          helpers.send_success(res, results)
        }
      })
      }
      */
      break
    default:
      helpers.send_failure(res, helpers.error('invalid query'), 'app_handler', exports.version, 'messageActions')
  }
}
const reconfigureMembersBySwitchingSendersAndReceivers = function (members, senderHost, receipientHost) {
  const revisedMembers = []
  members.forEach(member => {
    const parts = member.split('@')
    const user = parts[0]
    const server = parts[1]
    let fullname = member
    if (!server) fullname = user + '@' + senderHost
    if (server === receipientHost) fullname = user
    revisedMembers.push(fullname)
  })
  return revisedMembers
}
const createAndTransmitMessage = function (sentMessagesDb, permittedRecord, checkedParams, callback) {
  // receipientParams must have been checked for requestor and receipient being in contacts and persmissions having been granted
  /*
  {
    type: ‘share_records’, // based on permission type
    recipient_host : ‘https://data-vault.eu’,
    recipient_id : ‘christoph’,
    sharing_permission : ‘link_share’,
    contact_permission : ‘friends’,
    table_id : ‘com.salmanff.vulog.marks’,
    record_id : ‘randomRecordId123’,
NEWDO?  record: (for message_records)
NEWDO?  messaging_permission: 'message_link'
NEWDO?  message:
    app_id :
    sender_id :
    sender_host :
  }
  */
  // create nonce and record the message - status:'not sent'
  checkedParams.nonce = helpers.randomText(50)
  const messageToKeep = { ...checkedParams }
  messageToKeep.record = permittedRecord
  messageToKeep.message = checkedParams.message
  messageToKeep.status = 'initiate'
  fdlog('creating a new message to send ', { checkedParams, messageToKeep })
  sentMessagesDb.create(null, messageToKeep, {}, function (err, ret) {
    if (err) {
      callback(err)
    } else {
      const isLocalhost = helpers.startsWith(checkedParams.recipient_host, 'http://localhost')
      const https = isLocalhost ? require('http') : require('https')

      const sendOptions = {
        hostname: isLocalhost ? 'localhost' : checkedParams.recipient_host.slice(8),
        path: '/ceps/message/transmit',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': JSON.stringify(checkedParams).length
        }
      }
      if (isLocalhost) sendOptions.port = Number(checkedParams.recipient_host.slice(17))
      const verifyReq = https.request(sendOptions, (verifyRes) => {
        verifyRes.on('data', (returns) => {
          if (returns) returns = returns.toString()
          try {
            returns = JSON.parse(returns)
            callback(null, returns)
          } catch (e) {
            console.warn('errir getting trsnsmit ', { returns })
            callback(new Error('unisccessful transmission'))
          }
        })
      })
      verifyReq.on('error', (error) => {
        console.warn('error in transmit ', error)
        callback(helpers.error('message transmission error 2'))
      })
      verifyReq.write(JSON.stringify(checkedParams))
      verifyReq.end()
    }
  })
}
const sameHostMessageExchange = function (req, username, permittedRecord, checkedParams, callback) {
  // receipientParams must have been checked for requestor and receipient being in contacts and persmissions having been granted
  /*
  {
    type: ‘share_records’, // based on permission type
    recipient_host : null in this case
    recipient_id : ‘christoph’,
    group_members:
    sharing_permission : ‘link_share’,
    contact_permission : ‘friends’,
    table_id : ‘com.salmanff.vulog.marks’,
    record_id : ‘randomRecordId123’,
    app_id :
    sender_id :
    sender_host :
  }
  */

  const messageToKeep = { ...checkedParams }
  messageToKeep.record = permittedRecord
  messageToKeep.message = checkedParams.message
  messageToKeep.status = 'verified'
  fdlog('creating a new message INTERNAL MSG  ', { messageToKeep })
  async.waterfall([
    // check receipient to make sure has sender as contact
    function (cb) {
      if (!req.freezrOtherPersonContacts[username]) {
        cb(new Error('no contact db found for user ' + username))
      } else if (!req.freezrOtherPersonGotMsgs[username]) {
        cb(new Error('no msgdb found for user ' + username))
      } else {
        req.freezrOtherPersonContacts[username].query({ username, serverurl: null }, {}, cb)
      }
    },
    function (results, cb) {
      // todo - make this a user preference in the future
      if (!results) {
        cb(helpers.error(null, 'contact  missing - ask the receipient to add you as a contact'))
      } else if (results.length === 0) {
        messageToKeep.senderIsNotContact = true
      }
      if (results && results.length > 1) felog('two contacts found where one was expected ' + JSON.stringify(results))
      cb(null)
      //  }
    },
    // add the sender's message queue
    function (cb) {
      req.freezrSentMessages.create(null, messageToKeep, {}, cb)
    },
    // add the recipient's message queue
    function (ret, cb) {
      req.freezrOtherPersonGotMsgs[username].create(null, messageToKeep, {}, cb)
    }

  ], function (err) {
    if (err) console.warn(err)
    callback(err)
  })
}

const PUBLIC_PROFILE_PICT_EXCEPTIONS = {
  isValidProfilePhoto: function (req) {
    fdlog('co pict - app table:' + req.params.app_table, req.body.options)

    return req.params.app_table === 'info.freezr.account.files' &&
      !req.body.options.targetFolder &&
      req.body.options.fileName === 'profilePict.jpg'
  },
  formatProfilePict: function (file, cb) {
    cb(null, file)
  }

}

exports.create_file_record = function (req, res) {
  fdlog(req, ' create_file_record at ' + req.url + 'body:' + JSON.stringify((req.body && req.body.options) ? req.body.options : ' none'))

  if (req.body.options && (typeof req.body.options === 'string')) req.body.options = JSON.parse(req.body.options) // needed when upload file
  if (req.body.data && (typeof req.body.data === 'string')) req.body.data = JSON.parse(req.body.data) // needed when upload file

  let isUpdate = false // re-review for doing updates

  const appErr = function (message) { return helpers.app_data_error(exports.version, 'create_file_record', req.freezrAttributes.requestor_app, JSON.striungify(message)) }
  // const authErr = function (message) {return helpers.auth_failure("app_handler", exports.version, "create_file_record", req.freezrAttributes.requestor_app + ": "+message);}

  const fileParams = {
    dir: (req.body.options && req.body.options.targetFolder) ? req.body.options.targetFolder : '',
    name: (req.body.options && req.body.options.fileName) ? req.body.options.fileName : req.file.originalname
  }
  if (req.file) fileParams.is_attached = true
  let dataObjectId = fileHandler.removeStartAndEndSlashes(fileHandler.removeStartAndEndSlashes('' + fileParams.dir))
  let isAProfilePict = false

  async.waterfall([
    // 1. check stuff ...
    function (cb) {
      if (!fileParams.is_attached) {
        cb(appErr('Missing file'))
      } else if (!req.file.originalname) {
        cb(appErr('Missing file name'))
      } else if (helpers.is_system_app(req.params.app_name)) {
        if (!PUBLIC_PROFILE_PICT_EXCEPTIONS.isValidProfilePhoto(req)) {
          cb(helpers.invalid_data('app name not allowed: ' + req.params.app_name, 'account_handler', exports.version, 'create_file_record'))
        } else {
          PUBLIC_PROFILE_PICT_EXCEPTIONS.formatProfilePict(req.file, function (err, file) {
            req.file = file
            req.body.options.data = { _accessible: { granted: true, _public: { granted: true } } }
            req.body.options.convertPict = { width: 500, type: 'jpg' }
            isAProfilePict = true
            cb(err)
          })
        }
      } else if (!helpers.valid_filename(fileParams.name)) {
        cb(appErr('Invalid file name'))
      } else if (!fileHandler.valid_path_extension(fileParams.dir)) {
        cb(appErr('invalid folder name'))
      } else if (!req.freezruserFilesDb || !req.freezrAppFS) {
        // todo - this should be checked across all functions (console.log())
        cb(new Error('Internal error - database not found'))
      } else {
        cb(null)
      }
    },

    // get file record..
    function (cb) {
      dataObjectId = (dataObjectId ? (dataObjectId + '/') : '') + fileParams.name
      req.freezruserFilesDb.read_by_id(dataObjectId, cb)
    },
    function (results, cb) {
      if (!results) {
        cb(null)
      } else if (req.body.options.overwrite || results._UploadStatus === 'wip') {
        isUpdate = true
        cb(null)
      } else {
        cb(appErr('Cannot overwrite existing file'))
      }
    },

    // write a record as wip
    function (cb) {
      const write = (req.body.options && req.body.options.data) ? req.body.options.data : {}
      write._UploadStatus = 'wip'
      if (isUpdate) {
        req.freezruserFilesDb.update(dataObjectId.toString(), write, { newSystemParams: isAProfilePict }, cb)
      } else {
        req.freezruserFilesDb.create(dataObjectId.toString(), write, { newSystemParams: isAProfilePict }, cb)
      }
    },

    // convert picture if need be
    function (results, cb) {
      if (!req.body.options.convertPict) {
        cb(null, req.file.buffer)
      } else {
        const picts = require('./services/pictures.js')
        picts.convert(req.file, { width: req.body.options.convertPict.width, type: req.body.options.convertPict.type }, cb)
      }
    },

    // write file
    function (theFile, cb) {
      const endPath = fileHandler.removeStartAndEndSlashes(fileParams.dir + '/' + fileParams.name)
      req.freezrAppFS.writeToUserFiles(endPath, theFile, { doNotOverWrite: !req.body.options.overwrite }, cb)
    },

    // re-dupate record
    function (wrote, cb) {
      req.freezruserFilesDb.update(dataObjectId.toString(), { _UploadStatus: 'complete' }, { replaceAllFields: false }, cb)
    }
  ],
    function (err, writeConfirm) {
      fdlog({ err, writeConfirm })
      if (err) {
        helpers.send_failure(res, err, 'app_handler', exports.version, 'create_file_record')
      } else {
        helpers.send_success(res, { _id: dataObjectId })
      }
    })
}
exports.getFileToken = exports.read_record_by_id

// fdlog todo - FILE_TOKEN_CACHE needs to be moved to dsManager (console.log)
const FILE_TOKEN_CACHE = {}
const FILE_TOKEN_EXPIRY = 24 * 3600 * 1000 // expiry of 24 hours
const FILE_TOKEN_KEEP = 18 * 3600 * 1000 // time before a new token is issued so it stays valid
let cleanFilecacheTimer = null
const getOrSetFileToken = function (userId, requesteeApp, dataObjectId) {
  const key = FileTokenkeyFromRecord(requesteeApp, dataObjectId)
  const nowTime = new Date().getTime()
  if (cleanFilecacheTimer) clearTimeout(cleanFilecacheTimer)
  cleanFilecacheTimer = setTimeout(cleanFileTokens, 10 * 1000)
  if (!FILE_TOKEN_CACHE[userId]) FILE_TOKEN_CACHE[userId] = {}
  if (!FILE_TOKEN_CACHE[userId][key]) {
    FILE_TOKEN_CACHE[userId][key] = {}
    const newtoken = helpers.randomText(20)
    FILE_TOKEN_CACHE[userId][key][newtoken] = nowTime
    return newtoken
  } else {
    let gotToken = null
    for (const [aToken, aDate] of Object.entries(FILE_TOKEN_CACHE[userId][key])) {
      if (nowTime - aDate < FILE_TOKEN_KEEP) gotToken = aToken
      if (nowTime - aDate > FILE_TOKEN_EXPIRY) delete FILE_TOKEN_CACHE[userId][key][aToken]
    }
    if (gotToken) {
      return gotToken
    } else {
      const newtoken = helpers.randomText(20)
      FILE_TOKEN_CACHE[userId][key][newtoken] = nowTime
      return newtoken
    }
  }
}
const FileTokenkeyFromRecord = function (requesteeApp, dataObjectId) {
  return requesteeApp + '/' + dataObjectId
}
const cleanFileTokens = function () {
  // fdlog('cleanFileTokens')
  const nowTime = new Date().getTime()
  for (const [key, keyObj] of Object.entries(FILE_TOKEN_CACHE)) {
    for (const [aToken, aDate] of Object.entries(keyObj)) {
      if (nowTime - aDate > FILE_TOKEN_EXPIRY) { delete FILE_TOKEN_CACHE[key][aToken] }
    }
    if (Object.keys(keyObj).length === 0) delete FILE_TOKEN_CACHE[key]
  }
}
exports.sendUserFileWithFileToken = function (req, res) {
  // /v1/userfiles/info.freezr.demo.clickOnCheese4.YourCheese/salman/logo.1.png?fileToken=Kn8DkrfgMUwCaVCMkKZa&permission_name=self
  const parts = req.path.split('/').slice(5)
  const newpath = decodeURI(parts.join('/'))
  const userId = req.params.user_id
  const key = FileTokenkeyFromRecord(req.params.app_name, newpath)
  if (!FILE_TOKEN_CACHE[userId] || !FILE_TOKEN_CACHE[userId][key] || !FILE_TOKEN_CACHE[userId][key][req.query.fileToken] || (new Date().getTime - FILE_TOKEN_CACHE[userId][key][req.query.fileToken] > FILE_TOKEN_EXPIRY)) {
    if (!FILE_TOKEN_CACHE[userId] || !FILE_TOKEN_CACHE[userId][key]) {
      felog('NO KEY', req.url)
    }
    res.sendStatus(401)
  } else {
    // ?? old: file_handler.sendUserFile(res, newpath, req.freezr_environment );
    req.freezrAppFS.sendUserFile(newpath, res)
  }
}
exports.sendUserFileWithAppToken = function (req, res) {
  const parts = req.path.split('/').slice(5)
  const newpath = decodeURI(parts.join('/'))

  // NOTE - console.log todo - need to make this permission based (currently only works with self pages)
  if (!req.freezrTokenInfo || req.freezrTokenInfo.owner_id !== req.params.user_id || req.freezrTokenInfo.app_name !== req.params.app_name) {
    console.error('no app token trying to fetch ' + newpath)
    res.sendStatus(401)
  } else {
    req.freezrAppFS.sendUserFile(newpath, res)
  }
}

// developer utilities
exports.getManifest = function (req, res) {
  // app.get('/v1/developer/manifest/:app_name'
  // getAllAppTableNames
  felog('NOT TESTED - REVIEW')
  function endCB(err, manifest = null, appTables = []) {
    if (err) felog('got err in getting manifest ', err)
    if (manifest) {
      helpers.send_success(res, { manifest, app_tables: appTables })
    } else {
      helpers.send_failure(res, err, 'app_handler', exports.version, 'getManifest')
    }
  }

  const appName = req.query.targetApp
  fdlog('req.freezrRequestorManifest ', req.freezrRequestorManifest)
  if (!req.freezrRequestorManifest) {
    endCB(new Error('no manifest found'))
  } else {
    // if (appName === 'infor.freezr.admin') console.log('todo - neeed to separate our manifest of fradmin')
    req.freezrUserDS.getorInitDb({ owner: req.session.logged_in_user_id, app_table: appName }, null, function (err, topdb) {
      if (err) {
        endCB(err, req.freezrRequestorManifest)
      } else {
        topdb.getAllAppTableNames(appName, function (err, appTables) {
          endCB(err, req.freezrRequestorManifest, appTables)
        })
      }
    })
  }
}
// Loggers
const LOG_ERRORS = true
const felog = function (...args) { if (LOG_ERRORS) helpers.warning('app_handler.js', exports.version, ...args) }
const LOG_DEBUGS = false
const fdlog = function (...args) { if (LOG_DEBUGS) console.log(...args) }
