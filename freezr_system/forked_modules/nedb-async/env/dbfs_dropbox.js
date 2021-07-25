// fs_obj_dropbox.js 2021-01
/*
Dropbox file system object used for freezr and nedb-async
API docs: using https://dropbox.github.io/dropbox-sdk-js/Dropbox.html

for nedb sync, each type of FS should have a file with the following functions
- Commands similar to 'fs'
    writeFile
    rename
    unlink
    exists
    readdir
    mkdirp (Not needed on some systems)
    appendNedbTableFile (mimicks functinaility without adding actually appending)
- Addional commands
  readNedbTableFile
  deleteNedbTableFiles
  writeNedbTableFile
  crashSafeWriteNedbFile
  initFS (optional)
*/

const { Dropbox } = require('dropbox')
var async = require('async')
const https = require('https')
const fetch = require('node-fetch')

function DropboxFS (credentials = {}, options = {}) {
  fdlog('new dropbox credentials ', { credentials })
  this.credentials = credentials
  // if (credentials.code) this.credentials.refreshToken = credentials.code
  if (credentials.clientId) this.credentials.clientId = credentials.clientId
  this.dbx = new Dropbox({ fetch, clientId: credentials.clientId })
  if (credentials.accessToken && !credentials.clientId) {
    credentials.manualAccessToken = true
    this.dbx.auth.accessToken = credentials.accessToken
  }
  this.dbx.auth.codeChallenge = credentials.codeChallenge
  this.dbx.auth.codeVerifier = credentials.codeVerifier
  this.dbx.auth.redirect_uri = credentials.redirecturi
  this.doNotPersistOnLoad = (options.doNotPersistOnLoad !== false)
}

DropboxFS.prototype.name = 'dropbox'

// primitives
DropboxFS.prototype.initFS = function (callback) {
  fdlog('initialising dropbox FS with credentials ', this.credentials)
  const self = this
  if (this.credentials.code && !this.credentials.refreshToken) {
    // initiate
    self.dbx.auth.getAccessTokenFromCode(this.credentials.redirecturi, this.credentials.code)
      .then(token => {
        // fdlog(`initialising dropbox FS Token Result:${JSON.stringify(token)}`)
        if (token && token.result && token.result.refresh_token) {
          self.credentials.refreshToken = token.result.refresh_token
          self.dbx.auth.setRefreshToken(token.refresh_token)
          // above line not necessary as item will probably need to be re-initialised with getAccessToken later
          return callback(null)
        } else {
          return callback(new Error('could not get token '))
        }
      })
      .catch(err => {
        felog('dbfs_dropbox initFS error getting tokens ', err)
        return callback(err)
      })
  } else if (this.credentials.refreshToken) {
    return callback(null)
  } else if (this.credentials.accessToken && this.credentials.accessToken !== 'null' && this.credentials.manualAccessToken) {
    // may be a non-expiring test access token
    return callback(null)
  } else {
    return callback(new Error('Credentials not valid for initiating dropbox'))
  }
}
DropboxFS.prototype.getorRefreshAccessTokenFromDbx = function () {
  const self = this
  if (!self.credentials || (!self.credentials.accessToken && !self.credentials.refreshToken)) {
    return Promise.reject(new Error('no credentials for accessing dbx'))
  } else if (self.credentials.accessToken && self.credentials.manualAccessToken) {
    return Promise.resolve()
  } else {
    if (!self.dbx.auth.getRefreshToken()) {
      self.dbx.auth.setRefreshToken(self.credentials.refreshToken)
    }
    self.dbx.auth.checkAndRefreshAccessToken()
    return Promise.resolve()
    /* todo console.log -> recheck why this is sync ??
      .then(response => {
        return Promise.resolve()
      })
      .catch(err => {
        felog('err in checkAndRefreshAccessToken ', err)
        return Promise.reject(new Error('could not refresh access token'))
      })
      */
  }
}
DropboxFS.prototype.writeFile = function (path, contents, options, callback) {
  fdlog(' - dbx writefile', path)
  path = '/' + path
  var arg = { path, contents }
  if (!options || !options.doNotOverWrite) arg.mode = 'overwrite'
  const self = this

  self.getorRefreshAccessTokenFromDbx()
    .then(response => {
      // console.log('todo ?? need to fix so that if the file exists it is removed first - ie overwrite ')
      return self.dbx.filesUpload(arg)
    })
    .then(response => {
      return callback(null)
    })
    .catch(function (error) {
      felog('dbfs_dropbox writeFile err 2', { path, error })
      return callback(error)
    })
}
DropboxFS.prototype.rename = function (fromPath, toPath, callback) {
  fdlog(' - dbx-rename ', fromPath, toPath)
  const self = this

  self.unlink(toPath, function (renameDeleteErr) {
    if (renameDeleteErr) {
      return callback(new Error('renameDeleteErr 1 ' + fromPath + ' to ' + toPath))
    } else {
      fromPath = '/' + fromPath
      toPath = '/' + toPath

      self.getorRefreshAccessTokenFromDbx()
        .then(response => {
          return self.dbx.filesMoveV2({ from_path: fromPath, to_path: toPath })
        })
        .then(response => {
          return callback(null)
        })
        .catch(err => {
          felog('dbfs_dropbox - rename move error 2 ', { fromPath, err })
          return callback(new Error('rename_move_err ' + fromPath + ' to ' + toPath))
        })
    }
  })
}
DropboxFS.prototype.unlink = function (path, callback) {
  fdlog(' - dbx-unlink ', path)
  path = '/' + path
  const arg = { path }
  const self = this

  self.getorRefreshAccessTokenFromDbx()
    .then(response => {
      return this.dbx.filesDeleteV2(arg)
    })
    .then(response => {
      return callback(null)
    })
    .catch(error => {
      if (isPathNotFound(error)) {
        // Does not exist so not an error here - all is okay
        return callback(null)
      } else {
        felog('dbfs_dropbox unlink err for ' + path, error)
        return callback(error)
      }
    })
}
DropboxFS.prototype.exists = function (file, callback) {
  fdlog('dbfs_dropbox - exists ', file)
  const path = '/' + file
  const self = this
  let ret = false

  self.getorRefreshAccessTokenFromDbx()
    .then(response => {
      return self.dbx.filesGetTemporaryLink({ path })
    })
    .then(response => {
      ret = true
      return callback(ret)
    })
    .catch(error => {
      if (isPathNotFound(error)) {
        // Does not exist
        return callback(ret)
      } else {
        felog('dbfs_dropbox - exists - unknown error finding ' + file, error)
        return callback(new Error('unknown err connecting to dropbox on "exist" ' + error.message))
      }
    })
}
DropboxFS.prototype.mkdirp = function (path, callback) {
  fdlog('dbfs_dropbox - mkdirp ', path)
  path = '/' + path
  const self = this

  self.getorRefreshAccessTokenFromDbx()
    .then(response => {
      return self.dbx.filesCreateFolder({ path })
    })
    .then(response => {
      return callback(null)
    })
    .catch(error => {
      if (error.error && error.error.error_summary && error.error.error_summary.indexOf('path/conflict') === 0) {
        // already exists - just continue...
        return callback(null)
      } else {
        felog('dbfs_dropbox - mkdirp error for ' + { path, error })
        return callback(error)
      }
    })
}
DropboxFS.prototype.readdir = function (dirpath, callback) {
  // Note current implementation doesnt return more files than the limit
  fdlog('dbfs_dropbox reading dir ', dirpath)

  const self = this

  self.getorRefreshAccessTokenFromDbx()
    .then(response => {
      return self.dbx.filesListFolder({ path: '/' + dirpath })
    })
    .then(response => {
      if (!response.result) response.result = {}
      if (!response.result.entries) response.result.entries = []
      const entries = response.result.entries.map(entry => { return entry.path_lower })
      // fdlog('readdir for entries of len ' + entries.length)
      if (response.result && response.result.has_more) {
        readmoreFileList(self.dbx, response.result.cursor, entries, callback)
      } else {
        return callback(null, entries)
      }
    })
    .catch(err => {
      felog('dbfs_dropbox - readdir err', { dirpath, err })
      return callback(err)
    })
}
const readmoreFileList = function (dbx, cursor, oldlist, callback) {
  dbx.filesListFolderContinue({ cursor })
    .then(response => {
      if (!response.result) response.result = {}
      if (!response.result.entries) response.result.entries = []
      let entries = response.result.entries.map(entry => { return entry.path_lower.slice('/userdb/'.length) })
      entries = entries.concat(oldlist)
      if (response.result.has_more) {
        readmoreFileList(dbx, response.result.cursor, entries, callback)
      } else {
        return callback(null, entries)
      }
    })
    .catch(err => {
      felog('dbfs_dropbox - readmoreFileList ', err)
      return callback(err)
    })
}
DropboxFS.prototype.readFile = function (path, options, callback) {
  // read file goes through folder with appends, and adds them to content
  fdlog('dbfs_dropbox - readFile ', path)

  var self = this
  path = '/' + path

  self.getorRefreshAccessTokenFromDbx()
    .then(response => {
      return self.dbx.filesDownload({ path })
    })
    .then(response => {
      if (!response || !response.result || !response.result.fileBinary) {
        return callback(new Error('null response from dbx getting ' + path))
      } else {
        return callback(null, response.result.fileBinary.toString())
      }
    })
    .catch(err => {
      if (isPathNotFound(err)) {
        return callback(new Error('file not found - ' + path))
      } else {
        felog('dbfs_dropbox - readFile unknown error getting file from dbx ', err)
        return callback(new Error('unknown error getting - ' + path))
      }
    })
}

// Other file system
DropboxFS.prototype.getFileToSend = function (path, callback) {
  path = '/' + path
  const self = this
  fdlog(' dbfs_dropbox getFileToSend partialPath ' + path)

  self.getorRefreshAccessTokenFromDbx()
    .then(response => {
      return self.dbx.filesGetTemporaryLink({ path })
    })
    .then(response => {
      fdlog('in dbfs_dropbox  getFileToSend - link for ' + path + ' is ' + response.link)
      if (!response || !response.result || !response.result.link) {
        return new Error('could not get link')
      } else {
        fdlog('in dbfs_dropbox  getFileToSend - sending stream ' )
        https.get(response.result.link, stream => {
          return callback(null, stream)
        })
      }
    })
    .catch(error => {
      // helpers.warning("file_env_dropbox.js", exports.version, "sendUserFile", "Missing file:  "+path);
      felog('in dbfs_dropbox getFileToSend error ', { path, error })
      return callback(error)
    })
}
DropboxFS.prototype.removeFolder = function (path, callback) {
  return this.unlink(path, callback)
}

DropboxFS.prototype.appendNedbTableFile = function (path, contents, encoding, callback) {
  // The main different with the standard functions from local fs, is that instead of appending to the
  // main file which requires a full read and write operation every time,
  // appended items are added to another folder - one file per record - and then read back when the
  // (table) file is read, or deleted after crashSafeWriteNedbFile

  fdlog(' - dbx-appendNedbTableFile start ', path, contents) // new Date().toLocaleTimeString() + ' : ' + new Date().getMilliseconds()
  // if (encoding) fdlog('console.warn ignoring encoding on append for file ',path)

  const self = this
  const [appendDirectory] = getnamesForAppendFilesFrom(path)
  let chainEnded = false

  /* this.mkdirp (appendDirectory, function(err) {}) NOT Needed as Dropbox automatically creates folders */
  path = '/' + appendDirectory + '/' + dateBasedNameForFile()
  self.getorRefreshAccessTokenFromDbx()
    .then(response => {
      return self.dbx.filesUpload({ path, contents })
    })
    .then(response => {
      chainEnded = true
      // onsole.log(' - dbx-append mkdrirp upload done',new Date().toLocaleTimeString() + ' : ' + new Date().getMilliseconds())
      return callback(null)
    })
    .catch(function (error) {
      felog('dbx-appendNedbTableFile upload err', error)
      if (!chainEnded) return callback(error)
    })
}
DropboxFS.prototype.readNedbTableFile = function (path, encoding, callback) {
  // read file goes through folder with appends, and adds them to content
  fdlog(' - dbx-readNedbTableFile ', path)
  var [appendDirectory] = getnamesForAppendFilesFrom(path)
  var self = this
  let contents = ''
  let chainEnded = false
  path = '/' + path

  self.getorRefreshAccessTokenFromDbx()
    .then(response => {
      return self.dbx.filesDownload({ path })
    })
    .then(response => {
      if (!response) {
        throw new Error('could not get file from dbx 1')
      } else {
        if (response.result && response.result.fileBinary) {
          contents = response.result.fileBinary.toString()
          return getAllAppendDirectoryFiles(self, '/' + appendDirectory, true)
        } else {
          return Promise.reject(new Error('could not get file from dbx 2'))
        }
      }
    })
    .then(response => {
      return response
    })
    .catch(err => {
      if (isPathNotFound(err)) {
        return getAllAppendDirectoryFiles(self, '/' + appendDirectory, true)
      } else {
        felog('in dbfs_dropbox readNedbTableFile - real err ', { path, err })
        throw err
      }
    })
    .then(timelyEntries => {
      if (timelyEntries && timelyEntries.length > 0) {
        return Promise.all(timelyEntries.map(afile => self.dbx.filesDownload({ path: afile.path_lower })))
      } else {
        return []
      }
    })
    .then(appends => {
      appends = appends.map(append => { return append.result })
      // appends.forEach(append => {appendlist.push({path_lower: append.path_lower, fileBinary: append.fileBinary }) })
      appends.sort(sortByMod)
      appends.forEach(append => { contents += append.fileBinary })
      if (contents.slice(contents.length - 2) === '\n\n') contents = contents.slice(0, contents.length - 1)
      //  quirk of addig extra blank line on maual entry
      chainEnded = true
      return callback(null, contents)
    })
    .catch(error => {
      if (isPathNotFound(error)) {
        if (contents.slice(contents.length - 2) === '\n\n') contents = contents.slice(0, contents.length - 1)
        return callback(null, contents)
      } else {
        if (!chainEnded) return callback(error)
      }
    })
}
DropboxFS.prototype.writeNedbTableFile = function (filename, data, options, callback) {
  // new writeFile also writes over the appended file directory
  fdlog(' - dbx- writeNedbTableFile ', filename)

  callback = callback || function () {}
  const self = this
  const now = new Date().getTime()

  const [appendDirectory] = getnamesForAppendFilesFrom(filename)
  self.writeFile(filename, data, { doNotOverWrite: false }, function (err) {
    if (err) {
      felog('dbx- writeNedbTableFile - error writing file in writeNedbTableFile', err)
      return callback(err)
    } else {
      getAllAppendDirectoryFiles(self, '/' + appendDirectory, true)
        .then(fileEntries => {
          if (fileEntries.length > 0) {
            fileEntries = fileEntries.sort(sortByMod).reduce((result, entry) => {
              if (entry.path_lower && entry.path_lower.length > 0) {
                if (timeFromPath(entry.path_lower) < now) result.push({ path: entry.path_lower })
              } else {
                felog('dbx- writeNedbTableFile - strange error - no path for ', { filename, entry })
              }
              return result
            }, [])
          }
          if (fileEntries.length >= 1000) {
            fileEntries = fileEntries.slice(0, 999) // the rest can be done later
          }
          if (fileEntries.length > 0) {
            return self.dbx.filesDeleteBatch({ entries: fileEntries })
          } else {
            return null
          }
        })
        .then(dbxDeleteRet => {
          return callback(null)
        })
        .catch(errEndOnwriteTable => {
          felog('dbx- writeNedbTableFile - ', { errEndOnwriteTable })
          return callback(errEndOnwriteTable)
        })
        // old self.dbx.filesDeleteV2({ path: '/' + appendDirectory}) .then(dbxWriteTableDeleteRet => {callback(null)})
    }
  })
  /* } RELATED TO UNLINKE BAOVE - REMOVE
  }) */
}
DropboxFS.prototype.deleteNedbTableFiles = function (file, callback) {
  fdlog('dbfs_dropbox deleteNedbTableFiles ', file)
  var [appendDirectory] = getnamesForAppendFilesFrom(file)
  var self = this
  // let chainEnded = false

  self.unlink(file, function (err) {
    if (err) {
      return callback(err)
    } else {
      self.getorRefreshAccessTokenFromDbx()
        // renewing token just in case time has run by - should not be strictly necessary
        .then(response => {
          return self.dbx.filesDeleteV2({ path: '/' + appendDirectory })
        })
        .then(deleteNedbTableFilesRet => {
          return callback(null)
        })
        .catch(err => {
          if (isPathNotFound(err)) {
            return callback()
          } else {
            felog('dbfs_dropbox deleteNedbTableFiles ', appendDirectory, err)
            return callback(err)
          }
        })
    }
  })
}
DropboxFS.prototype.crashSafeWriteNedbFile = function (filename, data, cb) {
  // For storage services, the crashSafeWriteNedbFile is really crashSafeWriteFileOnlyIfThereAreApppendedRecordFiles
  // if there are no appended records (which are stored in files (See appendNedbTableFile above) ) then there is no need to rewrite the file

  // NOTE: THIS SHOULD ONLY BE CALLED WHEN THE INMEMORY DB ACTUALLY HAS ALL THE DATA - IE THAT IT HAS PERSISTED

  // If the temporary directory exists, then new items have been added, so we know we have to save

  var callback = cb || function () {}
  var self = this
  const now = new Date().getTime()

  const [appendDirectory] = getnamesForAppendFilesFrom(filename)
  fdlog('dbfs_dropbox crashSafeWriteNedbFile write ', { filename }) // data

  async.waterfall([
    // Write the new file and then delete the temp folder
    function (cb) {
      return self.unlink(tempOf(filename), cb)
    },
    function (cb) {
      self.writeFile(tempOf(filename), data, {}, function (err) { return cb(err) })
    },
    function (cb) {
      return self.unlink(filename, cb)
    },
    function (cb) {
      self.rename(tempOf(filename), filename, function (err) { return cb(err) })
    },
    function (cb) {
      getAllAppendDirectoryFiles(self, '/' + appendDirectory, true)
        .then(fileEntries => {
          if (fileEntries.length > 0) {
            fileEntries = fileEntries.sort(sortByMod).reduce((result, entry) => {
              if (timeFromPath(entry.path_lower) < now) result.push({ path: entry.path_lower })
              return result
            }, [])
          }
          if (fileEntries.length >= 1000) {
            fileEntries = fileEntries.slice(0, 999) // the rest can be done later
          }

          if (fileEntries === 0) {
            return null
          } else {
            self.dbx.filesDeleteBatch({ entries: fileEntries })
          }
        })
        .then(results => {
          throw new Error('notAnError')
        })
        .catch(err => {
          if (err.message === 'notAnError') { cb() } else cb(err)
        })
    }],
  function (err) {
    if (err) felog('dbfs_dropbox crashSafeWriteNedbFile write', { err })
    return callback(err)
  })
}

const appendFileFolderName = function (filename) {
  var parts = filename.split('.')
  parts.pop()
  return '~' + filename
}
const getnamesForAppendFilesFrom = function (path) {
  const parts = path.split('/')
  const oldfilename = parts.pop()
  parts.push(appendFileFolderName(oldfilename))
  path = parts.join('/')
  return [path, oldfilename]
}
const getAllAppendDirectoryFiles = function (self, appendDirectory, ignoreTime) {
  fdlog('getAllAppendDirectoryFiles')
  const recursiveAppendRead = function (self, appendDirectory, oldlist, cursor, callback) {
    self.getorRefreshAccessTokenFromDbx()
      .then(response => {
        return self.dbx.filesListFolderContinue({ cursor })
      })
      .then(response => {
        if (!response.result) response.result = {}
        if (!response.result.entries) response.result.entries = {}
        const newlist = oldlist.concat(response.result.entries)
        if (response.result.has_more) {
          recursiveAppendRead(self, appendDirectory, newlist, response.result.cursor, callback)
        } else {
          return callback(null, newlist)
        }
      })
      .catch(error => {
        return callback(error)
      })
  }

  return new Promise((resolve, reject) => {
    const writeTime = new Date()
    let gotInitialList = false
    self.getorRefreshAccessTokenFromDbx()
      .then(response => {
        return self.dbx.filesListFolder({ path: appendDirectory })
      })
      .then(response => {
        gotInitialList = true
        if (response && response.result && response.result.has_more) {
          return new Promise((resolve, reject) => {
            recursiveAppendRead(self, appendDirectory, response.result.entries, response.cursor, function (err, list) {
              if (err) { reject(err) } else { resolve(list) }
            })
          })
        } else if (response && response.result && response.result.entries) {
          return response.result.entries
        } else {
          return []
        }
      })
      .then(allentries => {
        const timelyEntries = []
        if (allentries) {
          allentries.forEach(entry => {
            // in case a write operation has hapenned while this loop is run (and also to remove any folders which may be used for future functionality)
            const entryTime = entry.server_modified
            if (ignoreTime || entryTime < writeTime) timelyEntries.push(entry)
          })
        }
        return resolve(timelyEntries)
      })
      .catch(error => {
        if (!gotInitialList && isPathNotFound(error)) {
          return resolve([])
        } else {
          felog(' dbfs_dropbox getAllAppendDirectoryFiles - read error from ' + appendDirectory, error)
          return reject(error)
        }
      })
  })
}

function isPathNotFound (dbxError) {
  if (dbxError.error && typeof dbxError.error === 'string') {
    try {
      dbxError.error = JSON.parse(dbxError.error)
    } catch (e) {
      felog('dbfs_dropbox - path not found did not parse dbxError.error ', dbxError)
    }
  }
  return (dbxError.error &&
    (dbxError.error.error_summary &&
     (dbxError.error.error_summary.indexOf('path/not_found') === 0 ||
      dbxError.error.error_summary.indexOf('from_lookup/not_found') === 0 ||
      dbxError.error.error_summary.indexOf('path_lookup/not_found') === 0)
    // todo - perhaps change this to just 'not_found'
    )
    // (typeof dbxError.error ===- "string" && dbxError.error.indexOf('path/not_found') > 0)
  )
}
function sortByMod (a, b) {
  if (!b || !b.path_lower || !a || !a.path_lower) {
    throw new Error('data mising in trying to sort ', a, b)
  } else {
    return timeFromPath(a.path_lower) - timeFromPath(b.path_lower)
  }
}

// file conventions
const dateBasedNameForFile = function () {
  return 'rec-' + Math.round(Math.random() * 1000, 0) + '-' + new Date().getTime() + '.adb'
}
const timeFromPath = function (path) {
  let nameTime = path.slice(path.lastIndexOf('/') + 1)
  nameTime = nameTime.slice(nameTime.lastIndexOf('-') + 1, nameTime.lastIndexOf('.adb'))
  return Number(nameTime)
}
const tempOf = function (filename) {
  return filename + '~'
}

// Not used - for fun
DropboxFS.prototype.Manualinit = function (callback) {
  // already initiated
  if (this.credentials.code) {
    let authUrl = 'https://api.dropboxapi.com/oauth2/token' // from example
    // old from docs 'https://api.dropbox.com/oauth2/token'
    authUrl += '?code=' + this.credentials.code
    authUrl += '&grant_type=authorization_code'
    authUrl += '&redirect_uri=' + encodeURIComponent(this.credentials.redirecturi)
    authUrl += '&code_verifier=' + this.credentials.codeVerifier
    authUrl += '&client_id=' + this.credentials.clientId

    const fetchOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }

    fetch(authUrl, fetchOptions)
      .then(resp => {
        return callback(null)
      })
      .catch(e => {
        felog('error fetching in Manualinit', e)
        return callback(e)
      })
  }
}

// logging
const LOG_ERRORS = true
const felog = function (...args) { if (LOG_ERRORS) console.error(...args) }
const LOG_DEBUGS = false
const fdlog = function (...args) { if (LOG_DEBUGS) console.log(...args) }

// Interface
module.exports = DropboxFS
