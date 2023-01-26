// Core freezr API - v0.0.144 - 2023-01

/* global freezrMeta */ // from html or from freezr_pre_definitions (freezr_app_init)
/* global FormData, XMLHttpRequest, confirm */ // from system

if (!freezrMeta) console.warn('Need to define freezrMeta in the app before running freezr_core.js')

const freezr = {
  ceps: {}, // data base related functions based on CEPS only
  feps: {}, // data base related functions for freezr
  perms: {}, // grant and query permissions
  html: {}, // functions to render pages
  filePath: {}, // functions to generate a correct path to files
  initPageScripts: null, // initPageScripts can be defined in the app's js file to run initial scripts upon page load.
  utils: {},
  menu: {},
  app: {
    isWebBased: true,
    loginCallback: null,
    server: null
  }
}

const freezerRestricted = {
  utils: {}
}

freezr.onFreezrMenuClose = function (hasChanged) {} // this is called when freezr menu is closed.

freezr.utils.getOpCbFrom = function (optionsAndCallback) {
  if (!optionsAndCallback || optionsAndCallback.length === 0) return [null, null]
  const callback = optionsAndCallback[optionsAndCallback.length - 1]
  const options = optionsAndCallback.length > 1 ? (optionsAndCallback[0] || []) : []
  if (optionsAndCallback.length > 2) console.warn('too many parameters in function', optionsAndCallback)
  return [options, callback]
}

// db Functions - data base related functions - to read or write
freezr.ceps.create = function (data, ...optionsAndCallback) {
  // write to the database
  // options:
  //  app_table or collection (in which case the app is assumed to be freezrMeta.appName app_table )
  //  updateRecord
  const [options, callback] = freezr.utils.getOpCbFrom(optionsAndCallback)
  if (!data) {
    callback(new Error('No data to write.'))
  } else if (options.updateRecord) {
    freezr.ceps.update(data, options, callback)
  } else {
    const appTable = options.app_table || (freezrMeta.appName + (options.collection ? ('.' + options.collection) : ''))
    const url = (options.host || '') + '/ceps/write/' + appTable
    const writeOptions = { appToken: (options.appToken || null) }
    freezerRestricted.connect.send(url, JSON.stringify(data), callback, 'POST', 'application/json', writeOptions)
  }
}
freezr.feps.create = function (data, ...optionsAndCallback) {
  // non ceps options:
  //  data_object_id (ignored if updateRecord)
  //   upsert
  //   host and accesstoken for third party servers
  const [options, callback] = freezr.utils.getOpCbFrom(optionsAndCallback)
  if (!data) {
    callback(new Error('No data to write.'))
  } else if (options.updateRecord) {
    freezr.feps.update(data, options, callback)
  } else {
    const appTable = options.app_table || (freezrMeta.appName + (options.collection ? ('.' + options.collection) : ''))
    const url = (options.host || '') + '/feps/write/' + appTable + (options.data_object_id ? ('/' + options.data_object_id + (options.upsert ? '?upsert=true' : '')) : '')
    const writeOptions = { appToken: (options.appToken || null) }
    freezerRestricted.connect.send(url, JSON.stringify(data), callback, 'POST', 'application/json', writeOptions)
  }
}
freezr.feps.upload = function (file, options, callback) {
  // upload a file and record it in the database
  // options can be: data (a json of data related to file) and updateRecord
  // and file specific ones: targetFolder, fileName, doNotOverWrite
  // For files uploaded, collection is always 'files'

  if (file) {
    options = options || {}
    options.overwrite = !options.doNotOverWrite
    const url = (options.host || '') + '/feps/upload/' + freezrMeta.appName
    const writeOptions = {}
    if (options.appToken) {
      writeOptions.appToken = options.appToken
      delete options.appToken
      delete options.host
    }
    const uploadData = new FormData()
    uploadData.append('file', file) /* onsole.log('Sending file1') */
    uploadData.append('options', JSON.stringify(options))
    freezerRestricted.connect.send(url, uploadData, callback, 'PUT', null, writeOptions)
  } else {
    callback(new Error('No file to upload'))
  }
}
freezr.ceps.getById = function (dataObjectId, options, callback) {
  // get a specific object by object id
  // options:
  //  app_table or collection (in which case the app is assumed to be freezrMeta.appName app_table )
  options = options || {}
  if (!dataObjectId) {
    callback(new Error('No id sent.'))
  } else {
    const requesteeApp = options.requestee_app || freezrMeta.appName
    const appTable = options.app_table || (requesteeApp + (options.collection ? ('.' + options.collection) : ''))
    const url = (options.host || '') + '/ceps/read/' + appTable + '/' + dataObjectId
    const readOptions = { appToken: (options.appToken || null) }
    freezerRestricted.connect.read(url, null, callback, readOptions)
  }
}
freezr.feps.getById = function (dataObjectId, options = {}, callback) {
  // additional feps options: permission_name and userId
  if (!dataObjectId) {
    callback(new Error('No id sent.'))
  } else {
    const requesteeApp = options.requestee_app || freezrMeta.appName
    const appTable = options.app_table || (requesteeApp + (options.collection ? ('.' + options.collection) : ''))
    const permissionName = options.permission_name || null
    const userId = options.user_id || null
    const url = (options.host || '') + '/feps/read/' + appTable + '/' + dataObjectId + (userId ? ('/' + userId) : '') + '?' + (requesteeApp === freezrMeta.appName ? '' : ('requestor_app=' + freezrMeta.appName)) + (permissionName ? ('permission_name=' + permissionName) : '')
    const readOptions = { appToken: (options.appToken || null) }
    freezerRestricted.connect.read(url, null, callback, readOptions)
  }
}
freezr.ceps.getquery = function (...optionsAndCallback) {
  // queries db
  // options:
  //  app_table or collection (in which case the app is assumed to be freezrMeta.appName app_table )
  //   q: list of queries eg{field:value, field, value} - can also have (_date_modified : {$lt: value}) or $gt
  //   host: if going to another server - may need appToken for
  const [options, callback] = freezr.utils.getOpCbFrom(optionsAndCallback)
  const appTable = options.app_table || (freezrMeta.appName + (options.collection ? ('.' + options.collection) : ''))
  if (options.q) {
    for (const param in options.q) {
      if (param === '_date_modified' && options.q._date_modified.$lt && !isNaN(options.q._date_modified.$lt)) {
        options.q._modified_before = options.q._date_modified.$lt
        delete options.q._date_modified
      } else if (param === '_date_modified' && options.q._date_modified.$gt && !isNaN(options.q._date_modified.$gt)) {
        options.q._modified_after = options.q._date_modified.$gt
        delete options.q._date_modified
      }
      if (typeof options.q[param] === 'object') {
        delete options.q[param]
        if (param !== '_date_modified') console.warn('Cannot have complex queries in ceps at this point ' + param + ' is invalid.')
      }
    }
  }
  const url = (options.host || '') + '/ceps/query/' + appTable
  const readOptions = { appToken: (options.appToken || null) }
  freezerRestricted.connect.read(url, options.q, callback, readOptions)
}
freezr.feps.postquery = function (...optionsAndCallback) {
  // additional feps options:
  //   permission_name, userId (which is the requestee id)
  //   appName can be added optionally to check against the manifest permission (which also has it)
  //   q is any list of query parameters, sort is sort fields
  //   only_others excludes own records
  //   count, skip

  const [options, callback] = freezr.utils.getOpCbFrom(optionsAndCallback)
  const appTable = options.app_table || ((options.appName || freezrMeta.appName) + (options.collection ? ('.' + options.collection) : ''))

  const url = (options.app_name && options.app_name === 'info.freezr.admin')
    ? '/v1/admin/dbquery/' + options.collection
    : (options.host || '') + '/feps/query/' + appTable
  const writeOptions = {}
  if (options.appToken) {
    writeOptions.appToken = options.appToken
    delete options.appToken
    delete options.host
  }
  if (options.count) writeOptions.count = options.count
  if (options.skip) writeOptions.skip = options.skip
  freezerRestricted.connect.send(url, JSON.stringify(options), callback, 'POST', 'application/json', writeOptions)
}
freezr.ceps.update = function (data = {}, ...optionsAndCallback) {
  // simple record update, assuming data has a ._id object
  // options:
  //    app_table or collection (in which case the app is assumed to be freezrMeta.appName.app_table )
  const [options, callback] = freezr.utils.getOpCbFrom(optionsAndCallback)
  if (!data._id) {
    callback(new Error('No id to update.'))
  } else {
    const appTable = options.app_table || (freezrMeta.appName + (options.collection ? ('.' + options.collection) : ''))
    const url = (options.host || '') + '/ceps/update/' + appTable + '/' + data._id
    const writeOptions = { appToken: (options.appToken || null) }
    freezerRestricted.connect.send(url, JSON.stringify(data), callback, 'PUT', 'application/json', writeOptions)
  }
}
freezr.feps.update = function (data = {}, ...optionsAndCallback) {
  // additional feps options:
  //   setkeys - if true then changes only the keys in the object. (works with one _id)
  //   options.q is the query which is sent, for changing a number of items (acts as if it is setkeys)
  //   host and appToken for third party servers

  const [options, callback] = freezr.utils.getOpCbFrom(optionsAndCallback)
  if (!data._id && !options.q) {
    callback(new Error('No _id to update... and no query'))
  } else if (data._id && options.q) {
    callback(new Error('need to update either _id or a query - not both'))
  } else {
    const appTable = options.app_table || (freezrMeta.appName + (options.collection ? ('.' + options.collection) : ''))
    const url = (options.host || '') + '/feps/update/' + appTable + (data._id ? ('/' + data._id) : '') + (options.setkeys ? '?setkeys=true' : '')
    if (options.q) data = { q: options.q, keys: data }
    const writeOptions = { appToken: (options.appToken || null) }
    freezerRestricted.connect.send(url, JSON.stringify(data), callback, 'PUT', 'application/json', writeOptions)
  }
}
freezr.ceps.delete = function (dataObjectId, options, callback) {
  // simple record update, assuming data has a ._id object
  // options:
  //    app_table or collection (in which case the app is assumed to be freezrMeta.appName app_table )
  //    host and appToken for third party servers
  if (!dataObjectId) {
    callback(new Error('No data_id sent.'))
  } else {
    options = options || {}
    const appTable = options.app_table || (freezrMeta.appName + (options.collection ? ('.' + options.collection) : ''))
    const url = (options.host || '') + '/ceps/delete/' + appTable + '/' + dataObjectId
    const writeOptions = { appToken: (options.appToken || null) }
    freezerRestricted.connect.send(url, null, callback, 'DELETE', 'application/json', writeOptions)
  }
}
freezr.feps.delete = function (idOrQuery, options, callback) {
  // simple record update, assuming data has a ._id object
  // options:
  //    app_table or collection (in which case the app is assumed to be freezrMeta.appName app_table )
  if (!idOrQuery) {
    callback(new Error('No data_id sent.'))
  } else {
    const isSingleRecord = (typeof idOrQuery === 'string')
    options = options || {}
    const appTable = options.app_table || (freezrMeta.appName + (options.collection ? ('.' + options.collection) : ''))
    const url = (options.host || '') + '/feps/delete/' + appTable + (isSingleRecord ? ('/' + idOrQuery) : '')
    const body = isSingleRecord ? {} : idOrQuery
    const writeOptions = { appToken: (options.appToken || null) }
    freezerRestricted.connect.send(url, JSON.stringify(body), callback, 'DELETE', 'application/json', writeOptions)
  }
}
freezr.feps.getByPublicId = function (dataObjectId, options, callback) {
  // get a specific public object by its object id
  // manifest needs to be set up for this and item to have been permissioned and tagged as public
  if (!dataObjectId) { callback(new Error('No id sent.')) }
  if (!options) options = {}
  const url = (options.host || '') + '/v1/pdb/' + dataObjectId
  const readOptions = { appToken: (options.appToken || null) }
  freezerRestricted.connect.read(url, null, callback, readOptions)
}
freezr.feps.publicquery = function (options, callback) {
  // options can be: app_name, skip, count, userId, pid
  if (!options) options = {}
  const url = (options.host || '') + '/v1/pdbq'
  const readOptions = {}
  if (options.appToken) {
    readOptions.appToken = options.appToken
    delete options.appToken
    delete options.host
  }
  freezerRestricted.connect.send(url, JSON.stringify(options), callback, 'POST', 'application/json', readOptions)
}

// Permissions and file permissions
freezr.perms.getAppPermissions = function (callback) {
  // gets a list of permissions granted - this is mainly called on my freezr_core, but can also be accessed by apps
  const url = '/ceps/perms/get'
  freezerRestricted.connect.read(url, null, callback)
}
// Non-CEPS
freezr.perms.isGranted = function (permissionName, callback) {
  // see if a permission has been granted by the user - callback(isGranted)
  const url = '/v1/permissions/getall/' + freezrMeta.appName
  freezerRestricted.connect.read(url, null, function (err, ret) {
    let isGranted = false
    if (err) {
      callback(err)
    } if (ret && ret.length > 0) {
      ret.forEach((aPerm) => {
        if (aPerm.name === permissionName && aPerm.granted === true) isGranted = true
      })
    }
    callback(isGranted)
  })
}
freezr.perms.shareRecords = function (idOrQuery, options, callback) {
  // gives specific people access to a specific object
  // permissionName is the permissionName under which the field is being

  let cepsOrFeps = 'ceps'

  if (!options) {
    options =
      { /*
        NO requestorApp - this is automatically added on server side

        Options - CEPS
        name: permissionName - OBLIGATORY
        'table_id': app_name (defaults to app self) (Should be obligatory?)
        'action': 'grant' or 'deny' (or anything else)
        'grantees': people being granted access (can also put grantee which is converted to a list [grantee])
        publicid: sets a public id instead of the automated accessible_id
        _date_published: sets the publish date

        NON CEPS options
        unlisted - for public items that dont need to be lsited separately in the public_records database
        doNotList - Does appear in the public table but doesnt show up on the ppage query list.

        idOrQuery being query is NON-CEPS - ie query_criteria or object_id_list
        */
      }
      //
  }
  if (!options.grantees && options.grantee) options.grantees = [options.grantee]
  if (!idOrQuery) {
    callback(new Error('must incude object id or a search query'))
  } else if (!options.grantees || options.grantees.length < 1 || !Array.isArray(options.grantees) || !options.table_id || !options.name) {
    callback(new Error('must incude permission name, grantee and table_id'))
  } else {
    options.grant = (options.action === 'grant')
    if (typeof idOrQuery === 'string') {
      options.record_id = idOrQuery
      if (options.publicid || options.pubDate || options.unlisted) cepsOrFeps = 'feps'
    } else {
      cepsOrFeps = 'feps'
      if (typeof idOrQuery === 'object') options.query_criteria = idOrQuery
      if (idOrQuery.constructor === Array) options.object_id_list = idOrQuery
    }
    const url = '/' + cepsOrFeps + '/perms/share_records'
    freezerRestricted.connect.ask(url, options, callback)
  }
}
freezr.perms.shareServableFile = function (id, options, callback) {
  // makes a specific file public via shareRecords
  // permissionName is the permissionName under which the field is being
  if (!options) {
    options =
      { /*
        name: permissionName - OBLIGATORY
        'action': 'grant' or 'deny' (or anything else)
        publicid: sets a public id instead of the automated accessible_id
        fileStructure: {js:[], css:[]},
        doNotList:false
        */
      }
      //
  }
  if (!id) {
    callback(new Error('must incude object id or a search query'))
  } else if (options.fileStructure && id.split('.').pop() !== 'html') {
    callback(new Error('main page must be a .html file'))
  } else {
    options.table_id = freezrMeta.appName + '.files'
    options.grantees = ['_public']
    options.grant = (options.grant || options.action === 'grant')
    options.record_id = id

    const url = '/feps/perms/share_records'

    freezerRestricted.connect.ask(url, options, callback)
  }
}
freezr.perms.validateDataOwner = function (options, callback) {
  // options
  if (!options) options = {}
  options.requestor_user = freezrMeta.userId
  // options.requestor_host = freezrMeta.serverAddress
  // if (!options.data_owner_host) options.data_owner_host = freezrMeta.serverAddress
  if (options.data_owner_host) options.requestor_host = freezrMeta.serverAddress
  freezerRestricted.connect.ask('/ceps/perms/validationtoken/set', options, function (err, ret) {
    if (err) console.error('got err getting validateDataOwner', { err, ret })
    options.validation_token = ret ? ret.validation_token : null

    const dataOwnerUrl = (options.data_owner_host || '') + '/ceps/perms/validationtoken/validate'

    freezerRestricted.connect.read(dataOwnerUrl, options, function (err, ret) {
      if (err) {
        const tosend = { error: err }
        callback(tosend)
      } else {
        callback(ret)
      }
    })
  })
}
freezr.ceps.sendMessage = function (toShare = {}, callback) {
  // toShare needsrecipient_host
  if (!toShare || !toShare.recipient_host || !toShare.recipient_id ||
    (!toShare.sharing_permission && !toShare.messaging_permission) || !toShare.contact_permission ||
    !toShare.table_id || !toShare.record_id) {
    callback(new Error('incomplete message fields - need al of recipient_host, recipient_id, sharing_permission, contact_permission, table_id, record_id '))
  } else {
    toShare.type = toShare.sharing_permission ? 'share_records' : 'message_records'
    toShare.app_id = freezrMeta.appName
    toShare.sender_id = freezrMeta.userId
    toShare.sender_host = freezrMeta.serverAddress
    freezerRestricted.connect.ask('/ceps/message/initiate', toShare, callback)
  }
}
freezr.ceps.getAppMessages = function (options, callback) {
  console.log('todo - add getAppMessages')
}
// PROMISES create freezr.promise based on above
freezr.promise = { ceps: {}, feps: {}, perms: {} }
Object.keys(freezr.ceps).forEach(aFunc => { freezr.promise.ceps[aFunc] = null })
Object.keys(freezr.feps).forEach(aFunc => { freezr.promise.feps[aFunc] = null })
Object.keys(freezr.perms).forEach(aFunc => { freezr.promise.perms[aFunc] = null })
Object.keys(freezr.promise).forEach(typeO => {
  Object.keys(freezr.promise[typeO]).forEach(function (freezrfunc) {
    freezr.promise[typeO][freezrfunc] = function () {
      const args = Array.prototype.slice.call(arguments)
      return new Promise(function (resolve, reject) {
        args.push(function (error, resp) {
          if (error || !resp || resp.error) {
            if (!error) error = resp.error ? resp : new Error('No response from promise')// temp fix todo review
            reject(error)
          } else {
            resolve(resp)
          }
        })
        freezr[typeO][freezrfunc](...args)
      })
    }
  })
})
const freepr = freezr.promise
if (freepr.eslinkhack) freepr.eslinthack('cleaned')

// UTILITY Functions
freezr.utils.updateFileList = function (folderName, callback) { // Currently NOT FUNCTIONAL
  // This is for developers mainly. If files have been added to a folder manually, this function reads all the files and records them in the db
  // app.get('/v1/developer/fileListUpdate/:app_name/:source_app_code/:folderName', userDataAccessRights, app_hdlr.updateFileDb)
  const url = '/v1/developer/fileListUpdate/' + freezrMeta.appName + '/' + (folderName ? '/' + folderName : '')
  // onsole.log('fileListUpdate Sending to '+url)
  freezerRestricted.connect.read(url, null, callback)
}
freezr.utils.getManifest = function (appName, callback) {
  // This is for developers mainly. It retrieves the manifest file and the list of app_tables which haev been used
  // app.get('/v1/developer/manifest/:app_name/:source_app_code',userDataAccessRights, app_handler.getManifest)
  // it returns: {'manifest':manifest, 'app_tables':app_tables}, where app_tables are the app_table names actually used, whether they appear in the manifest or not.

  if (!appName) appName = freezrMeta.appName
  const url = '/v1/developer/manifest?targetApp=' + appName
  freezerRestricted.connect.read(url, null, callback)
}
freezr.utils.ping = function (options, callback) {
  // pings freezr to get back logged in data
  // options can be password and appName (Not functional)
  const url = '/ceps/ping'
  freezerRestricted.connect.read(url, options, function (error, resp) {
    if (error || !resp || resp.error) {
      callback(error || new Error((resp && resp.error) ? resp.error : 'unkown error'))
    } else if (!resp.server_type) {
      callback(new Error('No server type'))
    } else {
      callback(null, resp)
    }
  })
}
freezr.utils.getHtml = function (partPath, appName, callback) {
  // Gets an html file on the freezr server
  if (!appName) appName = freezrMeta.appName
  if (!partPath.endsWith('.html') && !partPath.endsWith('.htm')) {
    callback(new Error('error - can only get html files'))
  } else {
    const htmlUrl = '/app_files/' + appName + '/' + partPath
    freezerRestricted.connect.read(htmlUrl, null, callback, { textResponse: true })
  }
}
freezr.utils.getAllAppList = function (callback) {
  freezerRestricted.connect.read('/v1/account/data/app_list.json', null, callback)
}
freezr.utils.getPrefs = function (callback) {
  freezerRestricted.connect.read('/v1/account/data/user_prefs.json', null, callback)
}
freezr.utils.getAppResourceUsage = function (app, callback) {
  const options = app ? { app_name: app } : null
  freezerRestricted.connect.read('/v1/account/data/app_resource_use.json', options, callback)
}

freezr.utils.filePathFromName = function (fileName, options) {
  console.warn('DEPRECTAED filePathFromId')
}
freezr.utils.filePathFromId = function (fileId, options) {
  console.warn('DEPRECTAED filePathFromId')
}
freezr.utils.userfile = function (userId, fileName) { return userId + '/' + fileName }
freezr.utils.setFilePath = function (imgEl, attr, fileId, options) {
  if (!options) options = {}
  options.requestee_app = options.requestee_app || freezrMeta.appName
  options.permission_name = options.permission_name || 'self'
  options.requestee_user_id = options.requestee_user_id || freezrMeta.userId
  if (!fileId) return null
  if (freezr.utils.startsWith(fileId, '/')) fileId = fileId.slice(1)
  freezr.utils.getFileToken(fileId, options, function (fileToken) {
    imgEl[attr] = '/feps/userfiles/' + options.requestee_app + '/' + options.requestee_user_id + '/' + fileId + '?fileToken=' + fileToken + (options.permission_name ? ('&permission_name=' + options.permission_name) : '')
  })
}
freezr.utils.getFileToken = function (fileId, options, callback) {
  // WIP - to be completed 2019
  // check if exists - if not, check permissions and send back a token and keep a list of tokens
  // return token
  if (!options) options = {}
  options.requestee_user_id = options.requestee_user_id || freezrMeta.userId
  options.requestee_app = options.requestee_app || freezrMeta.appName
  options.permission_name = options.permission_name || 'self'

  const url = '/feps/getuserfiletoken' + '/' + (options.permission_name || 'self') + '/' + options.requestee_app + '/' + options.requestee_user_id + '/' + fileId
  freezerRestricted.connect.read(url, null, (err, resp) => {
    const token = (resp && resp.fileToken) ? resp.fileToken : null
    if (err) console.warn('error in getting token ', err)
    callback(token)
  })
}
freezr.utils.refreshFileTokens = function (eltag = 'IMG', attr = 'src') {
  const pictList = document.getElementsByTagName(eltag)
  if (pictList.length > 0) {
    const host = window.location.href.slice(0, (window.location.href.slice(8).indexOf('/') + 8))
    const fepspath = '/feps/userfiles/'
    for (let i = 0; i < pictList.length; i++) {
      if (freezr.utils.startsWith(pictList[i][attr], host + fepspath)) {
        const parts = pictList[i][attr].split('/')
        const pictId = parts.slice(7).join('/').split('?')[0]
        freezr.utils.setFilePath(pictList[i], attr, pictId) //, {'permission_name':'picts_share'}
      }
    }
  }
}
freezr.utils.publicPathFromId = function (fileId, requesteeApp, userId) {
  // returns the public file path based on the file id so it can be referred to in html.
  // params are permission_name, requesteeApp
  if (!userId) console.warn('2021-10 breaking change - need to specify userid as userid was disassociated from fileId')
  if (!fileId || !requesteeApp || !userId) return null
  if (freezr.utils.startsWith(fileId, '/')) fileId = fileId.slice(1)
  return '/publicfiles/' + requesteeApp + '/' + userId + '/' + fileId
}
freezr.utils.fileIdFromPath = function (filePath) {
  // returns the id given a private or public url of a freezr file path
  if (!filePath) return null
  let parts = filePath.split('/')
  const type = (parts[4] === 'userfiles' ? 'private' : (parts[4] === 'publicfiles' ? 'public' : null))
  if (!type) return null
  parts = parts.slice((type === 'private' ? 10 : 6))
  return decodeURI(parts.join('/'))
}
freezr.utils.getCookie = function (cname) {
  const name = cname + '='
  const ca = document.cookie.split(';')
  for (let i = 0; i < ca.length; i++) {
    let c = ca[i]
    while (c.charAt(0) === ' ') {
      c = c.substring(1)
    }
    if (c.indexOf(name) === 0) {
      return c.substring(name.length, c.length)
    }
  }
  return ''
}
freezr.utils.parse = function (dataString) {
  if (typeof dataString === 'string') {
    try {
      dataString = JSON.parse(dataString)
    } catch (err) {
      dataString = { data: dataString }
    }
  }
  return dataString
}
freezr.utils.startsWith = function (longertext, checktext) {
  if (!checktext || !longertext) { return false } else
  if (checktext.length > longertext.length) { return false } else {
    return (checktext === longertext.slice(0, checktext.length))
  }
}
freezr.utils.longDateFormat = function (aDateNum) {
  if (!aDateNum || aDateNum + '' === '0') {
    return 'n/a'
  } else {
    try {
      const aDate = new Date(aDateNum)
      const retVal = aDate.toLocaleDateString() + ' ' + aDate.toLocaleTimeString()
      return retVal.substring(0, retVal.length - 3)
    } catch (err) {
      return 'n/a - error'
    }
  }
}
freezr.utils.testCallBack = function (returnJson) {
  returnJson = freezerRestricted.utils.parse(returnJson)
  // onsole.log('testCallBack - return json is ',returnJson)
}

/*  ==================================================================

The following functions should NOT be called by apps.
That's why they are called 'restricted'
They are for internal purposes only

==================================================================    */
freezerRestricted.utils = freezr.utils
freezerRestricted.connect = {}
freezerRestricted.menu = {}
freezerRestricted.permissions = {}

// CONNECT - BASE FUNCTIONS TO CONNECT TO SERVER
freezerRestricted.connect.ask = function (url, data, callback, type) {
  let postData = null
  let contentType = ''

  if (!type || type === 'jsonString') {
    postData = data ? JSON.stringify(data) : '{}'
    contentType = 'application/json' // 'application/x-www-form-urlencoded' //
  } else {
    postData = data
  }
  // todo - add posting pictures (???)

  freezerRestricted.connect.send(url, postData, callback, 'POST', contentType)
}
freezerRestricted.connect.write = function (url, data, callback, type) {
  let postData = null
  let contentType = ''

  if (!type || type === 'jsonString') {
    postData = JSON.stringify(data)
    contentType = 'application/json'
  } else {
    postData = data
  }
  freezerRestricted.connect.send(url, postData, callback, 'PUT', contentType)
}
freezerRestricted.connect.read = function (url, data, callback, options) {
  // options - textResponse (response is text)
  if (data) {
    const query = []
    for (const key in data) {
      query.push(encodeURIComponent(key) + '=' + encodeURIComponent(data[key]))
    }
    url = url + '?' + query.join('&')
  }
  freezerRestricted.connect.send(url, null, callback, 'GET', null, options)
}
freezerRestricted.connect.send = function (url, postData, callback, method, contentType, options = {}) {
  let req = null
  let badBrowser = false
  if (!callback) callback = freezr.utils.testCallBack
  try {
    req = new XMLHttpRequest()
  } catch (e) {
    badBrowser = true
  }

  const coreUrl = url ? url.split('?')[0] : ''
  const PATHS_WO_TOKEN = ['/oauth/token', '/ceps/ping', '/v1/account/login', '/v1/admin/self_register', '/v1/admin/oauth/public/get_new_state', '/v1/admin/oauth/public/validate_state']
  if (badBrowser) {
    callback(new Error('You are using a non-standard browser. Please upgrade.'))
  // } else if (!options.urlAuthOverride && !freezerRestricted.connect.authorizedUrl(url, method)) {
  //  callback(new Error('You are not allowed to send data to third party sites like ' + url))
  } else if (!options.appToken && !freezrMeta.appToken && !freezr.utils.getCookie('app_token_' + freezrMeta.userId) && PATHS_WO_TOKEN.indexOf(coreUrl) < 0) {
    callback(new Error('Need to obtain an app token before sending data to ' + url))
  } else {
    if (!freezerRestricted.utils.startsWith(url, 'http') && !freezr.app.isWebBased && freezrMeta.serverAddress) { url = freezrMeta.serverAddress + url }
    req.open(method, url, true)
    if (!freezr.app.isWebBased && freezrMeta.serverAddress) {
      req.withCredentials = true
      req.crossDomain = true
    }
    req.onreadystatechange = function () {
      if (req && req.readyState === 4) {
        let jsonResponse = req.responseText
        if ((!options || !options.textResponse) && jsonResponse) jsonResponse = freezr.utils.parse(jsonResponse)
        if (this.status === 200 && jsonResponse && !jsonResponse.error) {
          callback(null, jsonResponse)
        } else if (jsonResponse && jsonResponse.error) {
          console.error('ERROR SYNCING ', { jsonResponse })
          const error = new Error(jsonResponse.error)
          if (jsonResponse.message) error.message = jsonResponse.message
          callback(error)
        } else {
          const error = new Error('Connection error ')
          error.status = this.status
          if (this.status === 0) error.code = 'noComms'
          if (this.status === 400) error.code = 'noServer'
          if (!error.code) error.code = 'unknownErr'
          // if (this.status === 401 && !freezr.app.isWebBased) { freezr.app.offlineCredentialsExpired = true }
          callback(error)
        }
      }
    }
    if (contentType) req.setRequestHeader('Content-type', contentType)
    const accessToken = options.appToken || (freezr.app.isWebBased ? freezr.utils.getCookie('app_token_' + freezrMeta.userId) : freezrMeta.appToken)
    req.setRequestHeader('Authorization', 'Bearer ' + accessToken)
    req.send(postData)
  }
}
freezerRestricted.connect.authorizedUrl = function (aUrl, method) {
  if (freezerRestricted.utils.startsWith(aUrl, 'http') && (freezr.app.isWebBased || !freezerRestricted.utils.startsWith(aUrl, freezrMeta.serverAddress))) {
    // todo - to make authorized sites
    let warningText = (method === 'POST') ? 'The web page is trying to send data to ' : 'The web page is trying to access '
    warningText = warningText + 'a web site on the wild wild web: ' + aUrl + ' Are you sure you want to do this?'
    return (confirm(warningText))
  } else {
    return true
  }
}

// MENU - BASE FUNCTIONS SHOWING THEM WHEN THE FREEZR ICON (top right of each app) IS PRESSEDFreeezer Dialogie HTML
freezerRestricted.menu.hasChanged = false
freezerRestricted.menu.addFreezerDialogueElements = function () {
  // onsole.log('addFreezerDialogueElements')
  const freezerMenuButt = document.createElement('img')
  freezerMenuButt.src = freezr.app.isWebBased ? '/app_files/public/info.freezr.public/public/static/freezer_log_top.png' : '../freezr/static/freezer_log_top.png'
  freezerMenuButt.id = 'freezerMenuButt'
  freezerMenuButt.onclick = freezerRestricted.menu.freezrMenuOpen
  freezerMenuButt.className = 'freezerMenuButt_' + ((!freezr.app.isWebBased && /iPhone|iPod|iPad/.test(navigator.userAgent)) ? 'Head' : 'Norm')
  document.getElementsByTagName('BODY')[0].appendChild(freezerMenuButt)

  const elDialogueOuter = document.createElement('div')
  elDialogueOuter.id = 'freezer_dialogueOuter'
  document.getElementsByTagName('BODY')[0].appendChild(elDialogueOuter)
  const elDialogueScreen = document.createElement('div')
  elDialogueScreen.id = 'freezer_dialogueScreen'
  elDialogueOuter.appendChild(elDialogueScreen)
  elDialogueScreen.onclick = freezerRestricted.menu.close
  const elDialogueInner = document.createElement('div')
  elDialogueInner.id = 'freezer_dialogueInner'
  elDialogueOuter.appendChild(elDialogueInner)
  const elDialogueCloseButt = document.createElement('div')
  elDialogueCloseButt.className = 'freezer_butt'
  elDialogueCloseButt.id = 'freezer_dialogue_closeButt'
  elDialogueCloseButt.innerHTML = ' Close '
  elDialogueCloseButt.onclick = freezerRestricted.menu.close
  elDialogueInner.appendChild(elDialogueCloseButt)
  if (freezr.app.isWebBased && freezrMeta.userId && freezrMeta.serverAddress) {
    // nb server_address and userId may be nonexistant on app logout and login
    const elDialogueHomeButt = document.createElement('div')
    elDialogueHomeButt.className = 'freezer_butt'
    elDialogueHomeButt.id = 'freezer_dialogue_homeButt'
    elDialogueHomeButt.innerHTM = 'freezr home'
    elDialogueHomeButt.onclick = function (evt) { window.open('/account/home', '_self') }
    elDialogueInner.appendChild(elDialogueHomeButt)
  }
  const appTitle = document.createElement('div')
  appTitle.id = 'freezr_menu_appTitle'
  elDialogueInner.appendChild(appTitle)

  const innerText = document.createElement('div')
  innerText.id = 'freezer_dialogueInnerText'
  elDialogueInner.appendChild(innerText)

  const menuPerms = document.createElement('div')
  menuPerms.id = 'freezr_menu_perms'
  elDialogueInner.appendChild(menuPerms)
  elDialogueInner.style['-webkit-transform'] = 'translate3d(' + (Math.max(window.innerWidth, window.innerHeight)) + 'px, -' + (Math.max(window.innerWidth, window.innerHeight)) + 'px, 0)'
}
freezerRestricted.menu.close = function (evt) {
  if (document.getElementById('freezer_dialogueInner')) {
    document.getElementById('freezer_dialogueInner').style['-webkit-transform'] = 'translate3d(' + (Math.max(window.innerWidth, window.innerHeight)) + 'px, -' + (Math.max(window.innerWidth, window.innerHeight)) + 'px, 0)'
    setTimeout(function () {
      document.getElementById('freezer_dialogueOuter').style.display = 'none'
    }, 400)
    const bodyEl = document.getElementsByTagName('BODY')[0]
    if (bodyEl) { bodyEl.style.overflow = 'visible' }
    freezr.onFreezrMenuClose(freezerRestricted.menu.hasChanged)
    freezerRestricted.menu.hasChanged = false
  }
}
freezerRestricted.menu.freezrMenuOpen = function () {
  window.scrollTo(0, 0)
  freezerRestricted.menu.resetDialogueBox()
  freezerRestricted.menu.hasChanged = true

  if (freezr.app.isWebBased) { // app pages
    freezerRestricted.menu.addLoginInfoToDialogue('freezer_dialogueInnerText', false)
    if (freezrMeta.appName !== 'info.freezr.account' && freezrMeta.appName !== 'info.freezr.admin') {
      freezerRestricted.menu.show_permissions()
    }
  } else if (freezrMeta.appToken && !freezr.app.offlineCredentialsExpired) {
    freezerRestricted.menu.addLoginInfoToDialogue('freezer_dialogueInnerText', true)
    freezr.perms.getAllAppPermissions(freezerRestricted.menu.showOfflinePermissions)
  } else if (freezerRestricted.menu.add_standAloneApp_login_dialogue) {
    freezerRestricted.menu.add_standAloneApp_login_dialogue('freezer_dialogueInnerText')
  } else { // no app code, or offlineCredentialsExpired so its a stnad alone app
    document.getElementById('freezer_dialogueInnerText').innerHTML = 'Developer error: Please include the freezr_app_post_scripts.js file in your declarations.'
  }
}
freezerRestricted.menu.resetDialogueBox = function (isAdminPage, addText) {
  const innerText = (document.getElementById('freezer_dialogueInnerText'))
  if (innerText) innerText.innerHTML = (addText ? ('<br/><div>' + addText + '</div>') : '') + '<br/><div align="center">.<img src="' + (freezr.app.isWebBased ? '/app_files/public/info.freezr.public/public/static/ajaxloaderBig.gif' : 'freezr/static/ajaxloaderBig.gif') + '"/></div>'
  const dialogueEl = document.getElementById('freezer_dialogueOuter')
  if (dialogueEl) dialogueEl.style.display = 'block'
  const bodyEl = document.getElementsByTagName('BODY')[0]
  if (bodyEl) {
    bodyEl.style.oldOverflow = bodyEl.style.overflow
    bodyEl.style.overflow = 'hidden'
  }
  if (dialogueEl && bodyEl) dialogueEl.style.top = Math.round(bodyEl.scrollTop) + 'px'
  if (document.getElementById('freezer_dialogueInner')) document.getElementById('freezer_dialogueInner').style['-webkit-transform'] = 'translate3d(0, 0, 0)'
}

freezerRestricted.menu.show_permissions = function () {
  document.getElementById('freezer_dialogueInnerText').innerHTML = ''
  setTimeout(async () => {
    const filePath = freezr.app.isWebBased ? '/app_files/public/info.freezr.public/public/modules/AppSettings.js' : '../freezr/modules/AppSettings.js'
    const { showPermsIn } = await import(filePath)
    const perms = await showPermsIn(freezrMeta.appName)
    freezerRestricted.menu.addLoginInfoToDialogue('freezer_dialogueInnerText', false)
    document.getElementById('freezr_menu_perms').appendChild(perms)
  }, 5)
  // var url = '/v1/permissions/gethtml/' + freezrMeta.appName
  // freezerRestricted.connect.read(url, { groupall: true }, function (error, permHtml) {
  //   if (error) {
  //     console.warn(error)
  //     document.getElementById('freezer_dialogueInnerText').innerHTML = 'Error - ' + error.message
  //   } else {
  //     permHtml = freezerRestricted.utils.parse(permHtml)
  //     permHtml = permHtml.all_perms_in_html
  //     document.getElementById('freezer_dialogueInnerText').innerHTML += permHtml
  //     freezerRestricted.menu.replace_missing_logos()
  //   }
  // }, { textResponse: true })
}
freezerRestricted.menu.replace_missing_logos = function () {
  const imglistener = function (evt) {
    this.src = '/app_files/info.freezr.public/public/static/freezer_logo_empty.png'
    this.removeEventListener('error', imglistener)
  }
  Array.from(document.getElementsByClassName('logo_img')).forEach((anImg) => {
    if (anImg.width < 20) {
      anImg.src = '/app_files/info.freezr.public/public/static/freezer_logo_empty.png'
    } else {
      anImg.addEventListener('error', imglistener)
    }
  })
}

freezerRestricted.menu.addLoginInfoToDialogue = function (aDivName, addTitle) {
  const innerElText = document.getElementById(aDivName)
  if (innerElText) {
    innerElText.innerHTML = addTitle ? ('<div class="freezer_dialogue_topTitle">' + (freezrMeta.appDisplayName ? freezrMeta.appDisplayName : freezrMeta.appName) + '</div>') : '<br/>'
    innerElText.innerHTML += (freezrMeta.userId && freezrMeta.serverAddress) ? ('<i>Logged in as' + (freezrMeta.adminUser ? ' admin ' : ' ') + 'user: ' + freezrMeta.userId + (freezrMeta.serverAddress ? (' on freezr server: ' + freezrMeta.serverAddress) : '') + '</i>, version: ' + freezrMeta.serverVersion + '<br/>') : '<br/>You are not logged in'
    innerElText.innerHTML += '<br/>'
    innerElText.innerHTML += (freezrMeta.appversion ? ('<div>App version: ' + freezrMeta.appversion + '</div>') : '')
    if (!freezr.app.isWebBased) {
      innerElText.innerHTML += '<div align="center"><div class="freezer_butt" style="float:none; max-width:100px;" id="freezr_server_logout_butt">log out</div></div><br/>'
      setTimeout(function () { document.getElementById('freezr_server_logout_butt').onclick = function () { freezr.utils.logout() } }, 10)
    }
  } else { console.warn('INTERNAL ERROR - NO DIV AT addLoginInfoToDialogue FOR ' + aDivName) }
}

// event listeners
document.onkeydown = function (evt) {
  if (evt.key === 'Escape' && document.getElementById('freezer_dialogueOuter') && document.getElementById('freezer_dialogueOuter').style.display === 'block') { freezerRestricted.menu.close() }
}

freezr.utils.addFreezerDialogueElements = freezerRestricted.menu.addFreezerDialogueElements
freezr.utils.freezrMenuOpen = freezerRestricted.menu.freezrMenuOpen
freezr.utils.freezrMenuClose = freezerRestricted.menu.close
