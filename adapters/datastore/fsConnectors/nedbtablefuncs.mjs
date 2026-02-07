// freezr.info - nedbtablefuncs.mjs
// NeDB table functions for cloud file systems
// 

import async from 'async'
import path from 'path'

// NeDB specific
export const appendNedbTableFile = function(filepath, contents, encoding, callback) {
  // The main different with the standard functions from local fs, is that instead of appending to the
  // main file which requires a full read and write operation every time,
  // appended items are added to another folder - one file per record - and then read back when the
  // (table) file is read, or deleted after crashSafeWriteNedbFile

  // onsole.log(' - aws-append start ',filepath, contents, new Date().toLocaleTimeString() + ' : ' + new Date().getMilliseconds())
  // if (encoding) console.warn('ignoring encoding on append for file ',{filepath,encoding} )
  const self = this

  let [appendDirectory] = getnamesForAppendFilesFrom(filepath)
  // this.mkdirp (appendDirectory, function(err) {}) NOT Needed as aws has not folder structure
  const path = appendDirectory + '/' + dateBasedNameForFile()

  self.writeFile(path, contents, {}, callback)

}

export const readNedbTableFile = function(path, encoding, callback) {
  // read file goes through folder with appends, and adds them to content
  // onsole.log(' - aws-readNedbTableFile ', path)

  const self = this
  
  var [appendDirectory] = getnamesForAppendFilesFrom(path)
  var appendlist = []
  //const tagList = {}
  let contents = null

  self.readFile(path, {}, function(err, fullContent) {
    if (err) {
      console.warn('Error reading file in readNedbTableFile', err);
      return callback(err)
    } else {
      getAllAppendDirectoryFiles(self, appendDirectory, true, function (err, timelyEntries) {
        if (err) {
          console.warn('Error in readNedbTableFile:', err);
          return callback(err)
        } else if (timelyEntries && timelyEntries.length > 0) {
          // timelyEntries.forEach(entry => tagList[entry.ETag] = entry.Key)
          return Promise.all(timelyEntries.map(afile => {
            return new Promise((resolve, reject) => {
              self.readFile(afile.path, {}, function(err, content) {
                if (err) { reject (err) } else { resolve ({ path: afile.path, mtimeMs: afile.mtimeMs, content}) }
              })
            })
          } ))
          .then(appends => {
            appends = appends.sort(sortByMod)
            appends.forEach(append => { fullContent += append.content })
            // throw new Error('notAnError')
            return callback(null, fullContent)
          })
          .catch(error => {
            // if (error.message === 'notAnError') {
            //   return callback(null, contents)
            // } else {
              console.warn('got a real err in readNedbTableFile for '+path,error)
              return callback(error)
            //}
          })
        } else {
          callback(null, fullContent)
        }
      })
    }
  })
}

export const writeNedbTableFile = function(filename, data, options, callback) {
  console.log('nedbtablefuncs - writeNedbTableFile', filename, data, options)
  // new writeFile also writes over the appended file directory
  // onsole.log('writeNedbTableFile writeFile ', {filename, data})

  callback = callback || function () {}
  const self = this
  const now = new Date().getTime()

  let [appendDirectory] = getnamesForAppendFilesFrom(filename)

  self.writeFile(filename, data, {}, function (err) {
    if (err) {
      return callback(err)
    } else {
      getAllAppendDirectoryFiles(self, appendDirectory, true, function (err, fileEntries) {
        if (err) {
          console.warn('Error in writeNedbTableFile:', err);
          return callback(err)
        } else {
          if (fileEntries.length > 0) {
            fileEntries = fileEntries.sort(sortByMod).reduce((result, entry) => {
              if (timeFromPath(entry.path) < now) result.push({ path: entry.path })
              return result
            }, [])
          }
          if (fileEntries.length >= 1000) fileEntries = fileEntries.slice(0,999) // the rest can be done later
          if (fileEntries.length>0) {
            self.deleteObjectList(fileEntries, callback)
          } else {
            callback(null)
          }
        }
      })
    }
  })
}

export const deleteNedbTableFiles = function (file, callback) {
  // onsole.log('aws - going to deleteNedbTableFiles')
  const self = this
  const [appendDirectory] = getnamesForAppendFilesFrom(file)
  const appendlist = [];
  const now = new Date().getTime()

  getAllAppendDirectoryFiles(self, appendDirectory, true, function (err, fileEntries) {
    if (err) {
      console.warn('Error in deleteNedbTableFiles:', err);
      return callback(err)
    } else {
      const entries = fileEntries.map(entry => { return {Key: entry.Key   } }) || []
      if (fileEntries>1000)  console.error('potential error - got more than 1000 files')
      if (file) fileEntries.push({ Key: file })
      self.deleteObjectList(fileEntries, callback)
    }
  })
}

export const crashSafeWriteNedbFile = function(filename, data, callback) {
  // For storage services, the crashSafeWriteNedbFile could be ransformed to crashSafeWriteFileOnlyIfThereAreAppendedRecordFiles
  // if there are no appended records (which are stored in files (See appendNedbTableFile above) ) then there is no need to rewrite the file
  // However the original logic of the crashSafeWriteFile is maintained here

  // NOTE: THIS SHOULD ONLY BE CALLED WHEN THE INMEMORY DB ACTUALLY HAS ALL THE DATA - IE THAT IT HAS PERSISTED

  callback = callback || function () {}
  const self = this
  const now = new Date().getTime()

  let [appendDirectory] = getnamesForAppendFilesFrom(filename)
  // onsole.log('crashSafeWriteNedbFile write ', {filename, data})

    async.waterfall([
    // Write the new file and then delete the temp folder
    function (cb) {
        // writeFile overwrites for aws
        self.writeFile(tempOf(filename), data, {}, function (err) { return cb(err); });
      }
    , function (cb) {
        self.rename(tempOf(filename), filename, function (err) { return cb(err); });
      }
    , function (cb) {
        getAllAppendDirectoryFiles (self, appendDirectory, true, cb)
      }
    , function (fileEntries, cb) {
      if (fileEntries.length > 0) {
        fileEntries = fileEntries.sort(sortByMod).reduce((result, entry) => {
          if (timeFromPath(entry.path) < now) result.push({ path: entry.path })
          return result
        }, [])
      }
      if (fileEntries.length >= 1000) {
        fileEntries = fileEntries.slice(0,999) // the rest can be done later
      }
      self.deleteObjectList(fileEntries, cb)
    }
    ], function (err) {
      if (err) console.warn('crashSafeWriteNedbFile end for ',{filename, err, data})
      return callback(err);
    })
}

const getnamesForAppendFilesFrom = function(path) {
  const appendFileFolderName = function (filename) {
    if (!filename) throw new Error('no file name in appendFileFolderName')
    if (typeof filename !== 'string') throw new Error('file name is not string in appendFileFolderName', filename)
    let parts = filename.split('.')
    parts.pop()
    return '~'+filename
  }
  let parts = path.split('/')
  let oldfilename=parts.pop()
  // if(!oldfilename) console.warn('errr: Got empty file name for ', { path, oldfilename})
  // if (oldfilename) 
  parts.push(appendFileFolderName(oldfilename))
  path = parts.join('/')
  return [path, oldfilename]
}
const getAllAppendDirectoryFiles = function (self, appendDirectory, ignoreTime, callback) {
  self.readall(appendDirectory + '/', { includeMeta: true })
  .then(entries => {
    // onsole.log('file readall in getAllAppendDirectoryFiles: ', { appendDirectory, entries})
    if (!entries || entries.length === 0) return callback(null, [])

    const timelyArray = entries.filter(e => { return (ignoreTime || !e.mtimeMs) })
    return callback(null, timelyArray)
  })
  .catch(err => {
    console.warn('Error in getAllAppendDirectoryFiles:', err);
    return callback(err)
  })
}

function sortByMod(a,b) {
  if (!b || !b.path || !a || !a.path)
    throw new Error('trying to sort non existant objects ',a,b);
  else {
    return timeFromPath(a.path) - timeFromPath(b.path)
  }
}

// file conventions
const dateBasedNameForFile = function() {
  return 'rec-' + Math.round( Math.random() * 1000,0) + '-' + new Date().getTime() + '.adb'
}
const timeFromPath = function(path) {
  let nameTime = path.slice(path.lastIndexOf('/')+1)
  nameTime = nameTime.slice(nameTime.lastIndexOf('-')+1,nameTime.lastIndexOf('.adb'))
  return Number(nameTime)
}
const tempOf = function (filename) {
  return filename + '~';
}

