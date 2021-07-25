// fs_obj_googleDrive.js 2021-01
/* Note on Security:
  googleDrive PKCE does not work without a specific android or ios app store ID.
  So unfortunately, the client secret will be exposed in this process, so that the token can be refreshed, and may be abused by others.
  This creates a reliability / security issue for the authenticator service, but should not pose a security risk for users.
  An alternative would be to ask the authenticator service to review the access token regularly, but doing so would give the authenticator service knowledge of the user's usage and so it is not clear there is a security benefit.
*/
/*
Google Drive file system object used for freezr and nedb-async
API docs: using https://github.com/googleapis/google-api-nodejs-client
and: https://developers.google.com/drive/api/v3

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
/*

/* pathstructure used
  self.pathIds = {users_freezr: {
    id: xxxxx
    children: {}
      files: {
        id:
        children
      }
    }
  }}

 */

const { google } = require('googleapis')
const async = require('async')

function googleDriveFS (credentials = {}, options = {}) {
  fdlog('googleDriveFS  - new goog credentials to set ', { credentials })
  this.credentials = credentials
  if (credentials.clientId) this.credentials.clientId = credentials.clientId
  this.auth = new google.auth.OAuth2(credentials.clientId, credentials.secret, credentials.redirecturi)
  const credsToSet = {
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
    expiry_date: credentials.expiry
  }
  this.auth.setCredentials(credsToSet)
  // fdlog('googleDriveFS - set 1  credentials - ', this.auth.credentials)
  this.drive = google.drive({ version: 'v3', auth: this.auth })
  this.pathIds = {}
  this.doNotPersistOnLoad = (options.doNotPersistOnLoad !== false)
}

googleDriveFS.prototype.name = 'googleDrive'

// primitives
googleDriveFS.prototype.initFS = function (callback) {
  fdlog('initialising ggogle FS with credentials ', this.credentials)
  if (this.credentials.refreshToken) {
    return callback(null)
  } else if (this.credentials.accessToken && this.credentials.accessToken !== 'null') {
    // may be a non-expiring test access token
    fdlog('All good good on goog - have accessToken')
    return callback(null)
  } else {
    felog('googleDriveFS initFS - callback err - no tokens')
    return callback(new Error('Credentials not valid for initiating googleDrive'))
  }
}

googleDriveFS.prototype.writeFile = function (path, contents, options, callback) {
  fdlog(' - goog writefile', path)

  const self = this
  options = options || {}
  self.folderDetailsFromFilePath(path, null, function (err, folderDetails) {
    if (err) {
      callback(err)
    } else if (!folderDetails || !folderDetails.folderId) {
      callback(new Error('could not get folderdetails from path ', path))
    } else {
      self.fileOrFolderExistsOnGoog(path, { fileOnly: true }, (err, exists, fileInfo) => {
        if (!err && exists === true && options.doNotOverWrite) err = new Error('cannot overwrite whjen doNotOverWrite option is set')
        if (err) {
          callback(err)
        } else if (!exists) {
          const fileMetadata = {
            name: folderDetails.fileName,
            parents: [folderDetails.folderId]
          }
          // https://stackoverflow.com/questions/12755997/how-to-create-streams-from-string-in-node-js
          var Readable = require('stream').Readable
          var s = new Readable()
          s.push(contents)
          s.push(null) // indicates end-of-file
          var media = { body: s }

          /* todo later - see if need be, implement something like this
          const ending = folderDetails.fileName.split('.').pop()
          if (['png','jpg','jpeg'].includes(ending.toLowerCase())) {
            media.mimeType = 'image/jpeg'
          } else {
            media.mimeType = 'application/json'
          }
          */

          // console.log('googleDriveFS.prototype.writeFile going to create type ', (typeof contents), { fileMetadata, contents })

          self.drive.files.create({
            resource: fileMetadata,
            media,
            fields: 'id'
          }, function (err, file) {
            if (err) {
              // Handle error
              felog('goog writeFile', '1 - write err in goog writeFile', { file, err })
              callback(err)
            } else {
              fdlog('goog writeFile success - File all: ', (file.data ? file.data.id : 'not found'), file)
              callback(null)
            }
          })
        } else { // exists
          const fileMetadata = {
            name: folderDetails.fileName,
            addParents: [folderDetails.folderId]
          }
          self.drive.files.update({
            resource: fileMetadata,
            media: { body: contents },
            fileId: fileInfo.fileId
          }, function (err, file) {
            if (err) {
              // Handle error
              felog('goog writeFile', '2 overwrite - write err in goog writeFile', err)
              callback(err)
            } else {
              fdlog('goog writeFile success overwrite - File all: ', (file.data ? file.data.id : 'not found'), file)
              callback(null)
            }
          })
        }
      })
    }
  })
}
googleDriveFS.prototype.rename = function (fromPath, toPath, callback) {
  fdlog(' - goog-rename ', fromPath, toPath)
  const self = this

  self.fileOrFolderExistsOnGoog(fromPath, { fileOnly: true }, (err, exists, fileInfo) => {
    fdlog('fileOrFolderExistsOnGoog ', { fileInfo })
    const fromFileId = fileInfo ? fileInfo.fileId : null
    const parentId = fileInfo ? fileInfo.parentId : null
    if (err) {
      callback(err)
    } else if (!exists || !fromFileId) {
      callback(new Error('file does not exist'))
    } else { // exists
      self.unlink(toPath, function (err, resp) {
        if (err) {
          callback(new Error('error while renaming file and deleting old toPath file'))
        } else {
          const newName = toPath.split('/').pop()
          // todo should check if topath and frompath paths are actually the same
          // self.drive.files.update({ fileId: fromFileId }, { resource: { name: newName } }, (err, results) => {
          fdlog('goog-rename - to copy ', { newName, parentId })
          self.drive.files.copy({ fileId: fromFileId, requestBody: { name: newName, parents: [parentId] } }, (err, results) => {
            fdlog('goog-rename - copied ', { newName, parentId, err, results })

            self.drive.files.delete({
              fileId: fromFileId
            }, function (err, results) {
              // if (err)
              if (err) felog('goog-rename delete  ', { err, results })
              callback(err)
            })
          })
        }
      })
    }
  })
}
googleDriveFS.prototype.unlink = function (path, callback) {
  fdlog(' - goog-unlink ', path)
  const self = this
  self.removeFromPathIds(path)

  self.fileOrFolderExistsOnGoog(path, { fileOnly: false }, (err, exists, fileInfo) => {
    if (err) {
      callback(err)
    } else if (!exists || !fileInfo || !fileInfo.fileId) {
      callback(null) // ('file does not exist')
    } else { // exists
      self.drive.files.delete({
        fileId: fileInfo.fileId
      }, function (err, results) {
        if (err) felog('goog delete err ', { err, results })
        callback(err)
      })
    }
  })
}
googleDriveFS.prototype.exists = function (file, callback) {
  fdlog(' - goog-exists ', file)
  this.fileOrFolderExistsOnGoog(file, { fileOnly: false }, (err, exists, fileInfo) => {
    // const folderId = fileInfo.fileId
    callback((err || exists))
  })
}
googleDriveFS.prototype.mkdirp = function (path, callback) {
  return this.GetOrMakeFolders(path, { doNotMake: false, returnId: false }, callback)
}
googleDriveFS.prototype.readdir = function (dirpath, callback) {
  // Note current implementation doesnt return more files than the limit
  fdlog('goog reading dir ', dirpath)

  const self = this

  self.GetOrMakeFolders(dirpath, { doNotMake: true, returnId: true }, (err, folder) => {
    if (err) {
      felog('readdir', 'could not read', { dirpath, err })
      callback(err)
    } else if (!folder) {
      callback(new Error('readdir - could not reach folder ', dirpath))
    } else if (!folder.folderId) {
      callback(new Error('readdir - folder does not exist ', dirpath))
    } else {
      var list = []
      var pageToken = null
      const queryString = '"' + folder.folderId + '" in parents'

      // Using the NPM module 'async'
      async.doWhilst(function (cb) {
        self.drive.files.list({
          q: queryString,
          fields: 'nextPageToken, files(id, name)',
          spaces: 'drive',
          pageToken: pageToken
        }, function (err, res) {
          if (err) {
            // Handle error
            felog('readdir', 'whilst', err)
            cb(err)
          } else if (!res.data || !res.data.files) {
            felog('readdir', res)
            cb(new Error('error getting res.data.files in goog readdir'))
          } else {
            res.data.files.forEach(function (file) {
              fdlog('Found file: ', file.name, file.id)
              list.push(file.name)
            })
            pageToken = res.nextPageToken
            cb()
          }
        })
      }, function () {
        return !!pageToken
      }, function (err) {
        callback(err, list)
      })
    }
  })
}
googleDriveFS.prototype.readFile = function (path, options, callback) {
  // read file goes through folder with appends, and adds them to content
  fdlog(' - goog-readFile ', path)

  const self = this
  self.fileOrFolderExistsOnGoog(path, { fileOnly: true }, (err, exists, fileInfo) => {
    if (err) {
      callback(err)
    } else if (!exists) {
      callback(new Error(FILE_DOES_NOT_EXIT))
    } else { // exists
      if (!fileInfo || !fileInfo.fileId) felog('readFile', 'snbh - fileInfo missing on readfile ', path)
      self.drive.files.get({
        fileId: fileInfo.fileId,
        alt: 'media'
      }, function (err, results) {
        if (!err && (!results || results.statusText !== 'OK' || !results.data === null || results.data === undefined)) err = new Error('could not get file data')
        if (err) felog('goog-readfile ', { err, results })
        callback(err, ((results && results.data) ? results.data : null))
      })
    }
  })
}

// Other file system
googleDriveFS.prototype.getFileToSend = function (path, callback) {
  fdlog(' - goog-getFileToSend ', path)
  const self = this
  self.fileOrFolderExistsOnGoog(path, { fileOnly: true }, (err, exists, fileInfo) => {
    if (err) {
      callback(err)
    } else if (!exists) {
      callback(new Error('file does not exist ' + path))
    } else { // exists
      if (!fileInfo || !fileInfo.fileId) felog('snbh - fileInfo missing on getFileToSend ', path)
      self.drive.files.get({
        fileId: fileInfo.fileId,
        alt: 'media'
      }, { responseType: 'stream' }, // !! https://stackoverflow.com/questions/59347966/how-to-get-the-name-of-the-downloaded-file-with-drive-files-get-drive-api
      function (err, results) {
        fdlog('goog getFileToSend - needs to be rechecked - ', { err, results })
        if (!err && (!results || results.statusText !== 'OK' || !results.data === null || results.data === undefined)) err = new Error('could not get file data')
        if (err) {
          callback(err)
        } else {
          callback(null, results.data)
        }
      })
    }
  })
}
googleDriveFS.prototype.removeFolder = function (path, callback) {
  fdlog(' - goog-removeFolder ', path)
  this.removeFromPathIds(path)
  return this.unlink(path, callback)
}

googleDriveFS.prototype.appendNedbTableFile = function (path, contents, encoding, callback) {
  // The main different with the standard functions from local fs, is that instead of appending to the
  // main file which requires a full read and write operation every time,
  // appended items are added to another folder - one file per record - and then read back when the
  // (table) file is read, or deleted after crashSafeWriteNedbFile

  fdlog(' - goog-appendNedbTableFile start ', path, contents) // new Date().toLocaleTimeString() + ' : ' + new Date().getMilliseconds()
  // if (encoding) console.warn('ignoring encoding on append for file ',path)

  const [appendDirectory] = getnamesForAppendFilesFrom(path)
  path = appendDirectory + '/' + dateBasedNameForFile()

  this.writeFile(path, contents, { doNotOverWrite: true }, callback)
}
googleDriveFS.prototype.readNedbTableFile = function (path, encoding, callback) {
  // read file goes through folder with appends, and adds them to content
  fdlog(' - goog-readNedbTableFile ', path)
  var self = this
  const [appendDirectory] = getnamesForAppendFilesFrom(path)
  let contents = ''

  self.readFile(path, {}, (err, mainfileContent) => {
    if (err && err.message !== FILE_DOES_NOT_EXIT) {
      felog('file read err message', err.message)
      callback(err)
    } else {
      if (!mainfileContent) mainfileContent = ''
      if (err && err.message === FILE_DOES_NOT_EXIT) {
        mainfileContent = ''
      } else if (typeof mainfileContent === 'object') {
        mainfileContent = JSON.stringify(mainfileContent) + '\n'
      } else if (typeof mainfileContent !== 'string') {
        mainfileContent = mainfileContent.toString()
        // if (mainfileContent.length>2 && mainfileContent.slice(contents.length-1) !== '\n') mainfileContent += '\n'
      }
      contents = mainfileContent

      var toSortEntries = []

      self.getAllAppendDirectoryFiles(appendDirectory, true, (err, results) => { // { folderId, entries }
        if (!err && results && results.entries && results.entries.length > 0) {
          fdlog('todo - can one just do a search for all files and get the content with it, as opposed to getting list and then the content')
          async.forEach(results.entries, (entry, cb) => {
            self.drive.files.get({
              fileId: entry.id,
              alt: 'media'
            }, function (err, results) {
              if (!err && (!results || results.statusText !== 'OK' || !results.data === null || results.data === undefined)) err = new Error('could not get file data')
              if (!err && results && results.data) {
                if (typeof results.data !== 'string') results.data = JSON.stringify(results.data) + '\n'
                entry.data = results.data
                toSortEntries.push(entry)
              }
              // if (err) felog('goog readNedbTableFile', { err, results })
              cb(err)
            })
          }, (err) => {
            if (err) {
              felog('Err in getting nedb file content', err)
              callback(err)
            } else {
              toSortEntries = toSortEntries.sort(sortByMod)
              // download contents and add
              for (var i = 0; i < toSortEntries.length; i++) {
                contents += toSortEntries[i].data
              }
              fdlog('e1 DB populated with:' + contents + '.END')
              callback(null, contents)
            }
          })
        } else if (err) {
          callback(err)
        } else {
          if (contents && contents.length > 1 && contents.slice(contents.length - 2) === '\n\n') contents = contents.slice(0, contents.length - 1)
          fdlog('e2 DB populated with:' + contents + '.END')
          callback(err, contents)
        }
      })
    }
  })
}
googleDriveFS.prototype.writeNedbTableFile = function (filename, data, options, callback) {
  // new writeFile also writes over the appended file directory
  fdlog(' - goog- writeNedbTableFile ', { filename, data }) // data

  const self = this
  const [appendDirectory] = getnamesForAppendFilesFrom(filename)
  const now = new Date().getTime()

  self.writeFile(filename, data, {}, function (err) {
    if (err) {
      felog('writeNedbTableFile', 'error writing file in writeNedbTableFile', err)
      return callback(err)
    } else {
      self.getAllAppendDirectoryFiles(appendDirectory, true, (err, results) => { // { folderId, entries }
        if (!err && results && results.entries && results.entries.length > 0) {
          results.entries = results.entries.sort(sortByMod)
          async.forEach(results.entries, (entry, cb) => {
            if (timeFromPath(entry.name) < now) {
              self.drive.files.delete({
                fileId: entry.id
              }, function (err, results) {
                cb(err)
              })
            } else {
              cb(null)
            }
          }, (err) => {
            if (err) felog('Err in deleting nedb appendDirectory files ', err)
            callback(err)
          })
        } else {
          callback(err)
        }
      })
    }
  })
}
googleDriveFS.prototype.deleteNedbTableFiles = function (file, callback) {
  fdlog('goog deleteNedbTableFiles ', file)
  const [appendDirectory] = getnamesForAppendFilesFrom(file)
  const self = this

  self.unlink(file, function (err) {
    if (err) {
      felog('err in deleteNedbTableFiles - todo: if filenotfound then ignore for file ' + file, err)
      return callback(err)
    } else {
      self.unlink(appendDirectory, function (err) {
        if (err) felog('err in deleteNedbTableFiles - todo: if filenotfound then ignore for file ' + file, err)
        return callback(err)
      })
    }
  })
}
googleDriveFS.prototype.crashSafeWriteNedbFile = function (filename, data, callback) {
  // For storage services, the crashSafeWriteNedbFile is really crashSafeWriteFileOnlyIfThereAreApppendedRecordFiles
  // if there are no appended records (which are stored in files (See appendNedbTableFile above) ) then there is no need to rewrite the file

  // NOTE: THIS SHOULD ONLY BE CALLED WHEN THE INMEMORY DB ACTUALLY HAS ALL THE DATA - IE THAT IT HAS PERSISTED

  // If the temporary directory exists, then new items have been added, so we know we have to save

  const self = this
  const [appendDirectory] = getnamesForAppendFilesFrom(filename)
  const now = new Date().getTime()

  fdlog('goog crashSafeWriteNedbFile write ', { filename }) // data

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
      self.rename(tempOf(filename), filename, function (err) {
        return cb(err)
      })
    },
    function (cb) {
      self.getAllAppendDirectoryFiles(appendDirectory, true, cb)
    },
    function (results, cb) {
      if (results && results.entries && results.entries.length > 0) {
        results.entries = results.entries.sort(sortByMod)
        async.forEach(results.entries, (entry, cb2) => {
          if (timeFromPath(entry.name) < now) {
            self.drive.files.delete({
              fileId: entry.id
            }, function (err, results) {
              if (err) felog('goog deleted appendDirectory in crashSafeWriteNedbFile file (remove console and move "cb" to delete)', { err, results })
              cb2(err)
            })
          } else {
            cb2(null)
          }
        }, (err) => {
          if (err) felog('Err in deleting nedb appendDirectory files ', err)
          cb(err)
        })
      } else {
        cb(null)
      }
    }
  ],
  function (err) {
    if (err) felog('end of crashSafeWriteNedbFile write', { err, data })
    return callback(err)
  })
}

// Google helper functions
const FILE_DOES_NOT_EXIT = 'File does not exist'
googleDriveFS.prototype.fileOrFolderExistsOnGoog = function (file, options, callback) {
  fdlog(' - goog-fileExists ', file)

  options = options || {}
  const self = this
  var partPaths = file.split('/')
  const fileName = partPaths.pop()
  const path = partPaths.join('/')
  let returnValue = false

  this.GetOrMakeFolders(path, { doNotMake: true, returnId: true }, (err, folder) => {
    if (err) {
      felog('GetOrMakeFolders 1 - could not check folder ', folder)
      callback(err)
    } else if (!folder) {
      felog('GetOrMakeFolders !folder- could not check folder ', folder)
      callback(new Error('coudl not reach folder'))
    } else if (!folder.folderId) {
      felog('GetOrMakeFolders - !folder.folderId - could not check folder ', folder)
      callback(new Error('folder does not exist'))
    } else {
      const queryString = (options.fileOnly ? 'mimeType != "application/vnd.google-apps.folder" and' : '') +
        ' name = "' + fileName + '" ' +
        ' and "' + folder.folderId + '" in parents'
      fdlog('goog queryString is ' + queryString)

      self.drive.files.list({
        q: queryString,
        fields: 'nextPageToken, files(id, name, createdTime)', // , files/parents
        spaces: 'drive',
        pageToken: null
      }, function (err, response) {
        if (err) {
          // Handle error
          if (err) felog('Handle error - trying to list', { file, err })
          callback(err)
        } else if (response && response.data && response.data.files && response.data.files.length === 0) {
          callback(null, returnValue, { parentId: folder.folderId })
        } else if (response && response.data && response.data.files && response.data.files.length === 1) {
          returnValue = true
          callback(null, returnValue, { parentId: folder.folderId, fileId: response.data.files[0].id })
        } else if (response && response.data && response.data.files && response.data.files.length > 1) {
          returnValue = true
          console.warn('google error - two of the same file exists - todo - need to remove one and take latest')
          callback(null, returnValue, { parentId: folder.folderId, fileId: response.data.files[0].id })
        } else {
          felog('in goog-exists - invalid response ', { file, response })
          callback(new Error('exists - invalid response '))
        }
      })
    }
  })
}
googleDriveFS.prototype.folderDetailsFromFilePath = function (filePath, options, callback) {
  let path = filePath.split('/')
  const fileName = path.pop()
  path = path.join('/')
  return this.GetOrMakeFolders(path, { doNotMake: false, returnId: true }, function (err, folderDetails) {
    if (folderDetails) folderDetails.fileName = fileName
    callback(err, folderDetails)
  })
}
googleDriveFS.prototype.removeFromPathIds = function (path) {
  let pathStruct = this.pathIds
  const pathParts = path.split('/')

  // let foundEnd = false
  fdlog('removeFromPathIds len ', pathParts.length, { path, pathStruct })

  pathParts.forEach((item, i) => {
    if (pathStruct[item]) {
      if (i === pathParts.length - 1) {
        delete pathStruct[item]
        // foundEnd = true
      } else {
        pathStruct = pathStruct[item].children
      }
    } else {
      // foundEnd = true
    }
  })
}
googleDriveFS.prototype.GetOrMakeFolders = function (path, options, callback) {
  // options doNotMake: doesnot make a folder if it doesnt exist, returnId: returns last fodlerId
  fdlog(' - goog-GetOrMakeFolders ', path)

  const self = this
  var pathParts = path.split('/')
  var parentObjs = []
  let pathStruct = self.pathIds
  let folderId = 'root'
  let currentFolderName = 'root'
  options = options || {}

  async.whilst(
    function () {
      return pathParts.length > 0
    },
    function (cb) {
      currentFolderName = pathParts.shift()
      if (pathStruct[currentFolderName] && pathStruct[currentFolderName].folderId) {
        folderId = pathStruct[currentFolderName].folderId
        parentObjs.push({
          name: currentFolderName,
          folderId
        })
        pathStruct = pathStruct[currentFolderName].children
        cb(null)
      } else { // see if it exists online and if not create it
        const queryString = 'mimeType = "application/vnd.google-apps.folder" and' +
          ' name = "' + currentFolderName + '" ' +
          ' and "' + (parentObjs.length > 0 ? parentObjs[parentObjs.length - 1].folderId : 'root') + '" in parents'
        fdlog('goog queryString is ' + queryString)

        self.drive.files.list({
          q: queryString,
          fields: 'nextPageToken, files(id, name)', // , files/parents
          spaces: 'drive',
          pageToken: null
        }, function (err, response) {
          if (err) {
            // Handle error
            if (err && err.message && err.message.indexOf('No refresh token is set') > -1) {
              felog('auth error from goog ', { err })
              err = new Error('authorisation error')
            }
            cb(err)
          } else if (response && response.data && response.data.files && response.data.files.length >= 1) {
            if (response.data.files.length > 1) felog('dbfs_googleDrive GetOrMakeFolders for ' + path + ' - Got more than 1 folder - ignoring error for the moment')
            const theFile = response.data.files[0]
            folderId = theFile.id
            parentObjs.push({
              name: currentFolderName,
              folderId
            })
            pathStruct[currentFolderName] = {
              folderId,
              parentObjs: JSON.parse(JSON.stringify(parentObjs)),
              children: {}
            }
            pathStruct = pathStruct[currentFolderName].children
            cb(null)
          } else if (response && response.data && response.data.files && response.data.files.length === 0) {
            // doesnt exist - create it
            if (options.doNotMake) {
              pathParts = []
              folderId = null
              cb(null)
            } else {
              // fdlog('found no files - will create ', response)
              var fileMetadata = {
                name: currentFolderName,
                mimeType: 'application/vnd.google-apps.folder'
              }
              if (parentObjs.length > 0) {
                fileMetadata.parents = [parentObjs[parentObjs.length - 1].folderId]
              }
              // fdlog('folder doesnt exist - create it ', fileMetadata)
              self.drive.files.create({
                resource: fileMetadata,
                fields: 'id'
              }, function (err, theFile) {
                if (err) {
                  felog('Handle error in creating file' + path, err)
                  cb(err)
                } else {
                  folderId = (theFile && theFile.data && theFile.data.id) ? theFile.data.id : null
                  if (!folderId) {
                    cb(new Error('could not get file id of entity'))
                  } else {
                    parentObjs.push({
                      name: currentFolderName,
                      folderId
                    })
                    pathStruct[currentFolderName] = {
                      folderId,
                      parentObjs: JSON.parse(JSON.stringify(parentObjs)),
                      children: {}
                    }
                    pathStruct = pathStruct[currentFolderName].children
                    cb(null)
                  }
                }
              })
            }
          } else {
            felog('invalid response from google ', { err, response })
            if (response && response.data && response.data.files) felog('files', response.data.files)
            cb(new Error('invalid response from google'))
          }
        })
      }
    },
    function (err) {
      if (err) {
        felog('error in reading recursive directory for ' + path, err)
        callback(err)
      } else if (options.returnId) {
        callback(null, { folderId, folderName: currentFolderName })
      } else {
        callback(null)
      }
    }
  )
}

const appendFileFolderName = function (filename) {
  var parts = filename.split('.')
  parts.pop()
  return '~' + filename
}
const getnamesForAppendFilesFrom = function (path) {
  const parts = path.split('/')
  const originalDbFilename = parts.pop()
  const appendDirectoryName = appendFileFolderName(originalDbFilename)
  parts.push(appendDirectoryName)
  path = parts.join('/')
  return [path, originalDbFilename, appendDirectoryName]
}
googleDriveFS.prototype.getAllAppendDirectoryFiles = function (appendDirectory, ignoreTime, callback) {
  const self = this
  self.GetOrMakeFolders(appendDirectory, { doNotMake: false, returnId: true }, function (err, folderDetails) {
    if (err) {
      callback(err)
    } else {
      const folderId = folderDetails.folderId
      var list = []
      let pageToken = null
      const queryString = '"' + folderId + '" in parents'

      async.doWhilst(function (cb) {
        self.drive.files.list({
          q: queryString,
          fields: 'nextPageToken, files(id, name, createdTime)',
          spaces: 'drive',
          pageToken: pageToken
        }, function (err, res) {
          if (err) {
            felog('getnamesForAppendFilesFrom err for path:' + appendDirectory, { res, err })
            cb(err)
          } else if (!res.data || !res.data.files) {
            felog('getnamesForAppendFilesFrom err for path:' + appendDirectory, { res, err })
            cb(new Error('could not get files in goog in getAllAppendDirectoryFiles'))
          } else if (res.data.files.length === 0) {
            cb()
          } else {
            res.data.files.forEach(function (file) {
              // fdlog('Found file: ', file.name, file.id, file.createdTime)
              list.push(file)
            })
            pageToken = res.nextPageToken
            cb()
          }
        })
      }, function () {
        return !!pageToken
      }, function (err) {
        // fdlog('allentries.len :' + (list ? list.length : '0'))
        const entries = []
        const writeTime = new Date()
        if (list) {
          list.forEach(entry => {
            // in case a write operation has hapenned while this loop is run (and also to remove any folders which may be used for future functionality)
            const entryTime = new Date(entry.createdTime)
            if (ignoreTime || entryTime < writeTime) entries.push(entry)
          })
        }
        callback(err, { folderId, entries })
      })
    }
  })
}
function sortByMod (a, b) {
  if (!b || !b.name || !a || !a.name) {
    throw new Error('data mising in trying to sort ', a, b)
  } else {
    return timeFromPath(a.name) - timeFromPath(b.name)
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

// logging
const LOG_ERRORS = true
const felog = function (...args) { if (LOG_ERRORS) console.error(...args) }
const LOG_DEBUGS = false
const fdlog = function (...args) { if (LOG_DEBUGS) console.log(...args) }

// Interface
module.exports = googleDriveFS
