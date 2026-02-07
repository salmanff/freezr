/**
 * Original files from nedb-asyncfs converted to modules here
 * 
 * Default filesystem - uses fs module
 * Behaviour is (or should be) consistent with the original NeDB
 *
   for nedb-asyncfs, each type of file system should have a file with the following functions
   - Commands similar to 'fs'
     writeFile
     rename
     unlink (should be used for files only)
     exists
     stat (similar to fs.stat except it has type (dir or file) instead of isDirectory and isFile)
     readFile
     readdir
   - Addional file commands
     mkdirp
     initFS (optional)
     getFileToSend
     removeFolder (like unlink for folders)
   - NeDB specific
     appendNedbTableFile (mimicks functinaility without adding actually appending)
     readNedbTableFile
     deleteNedbTableFiles
     writeNedbTableFile
     crashSafeWriteNedbFile

 * Any custom filesystems need to implement the same functions
 */


// freezr.info - dbfs_local.mjs
// Local file system connector (MODERNIZED TO ES6 MODULES)

import fs from 'fs'
import async from 'async'
import mkdirp from 'mkdirp'
import path from 'path'

const localFS = {}

localFS.name = 'local'

localFS.exists = function(filename, callback) {
  callback (fs.existsSync(filename)? true : false)
}

localFS.isPresent = function (filename, callback) {
  // onsole.log('is present ', filename)
  fs.stat(filename, function (err, stat) {
    if (err == null) {
      callback(null, true)
    } else if (err.code === 'ENOENT') {
      callback(null, false)
    } else {
      callback(err)
    }
  })
}

localFS.rename = fs.rename

localFS.stat = function (path, callback) {
  fs.stat(path, function (err, stats) {
    if (err) {
      callback(err)
    } else {
      if (stats.isDirectory()) {
        stats.type = 'dir'
      } else if (stats.isFile()) {
        stats.type = 'file'
      }
      callback(null, stats)
    }
  })
}

localFS.size = function (fileOrDirPath, callback) { 
  const folderSize = function (dirPath, callback) {
    fs.readdir(dirPath, function (err, files) {
      let fullsize = 0
      async.forEach(files, function (file, cb) {
        fileOrDirPath = dirPath + path.sep + file
        localFS.size(fileOrDirPath, function (err, size) {
          if (err) {
            cb(err);
           } else {
             fullsize += size
             cb(null)
           }
        })
      }, function (err) {
        if (err?.code === 'ENOENT') err = null
        callback(err, fullsize)
      })
    })
  }
  
  fs.stat(fileOrDirPath, function (err, stat) {
    if (err) {
     callback(err);
    } else if (stat.isDirectory()) {
      folderSize(fileOrDirPath, callback);
    } else {
      // onsole.log('got file size for ', filePath, stat.size)
      callback(null, stat.size)
    }
})
}

localFS.writeFile = function (path, contents, options, callback) {
  // onsole.log('write file ', { options })
  if (options && options.doNotOverWrite && fs.existsSync(path)) {
    callback(new Error('File exists - doNotOverWrite option was set and could not overwrite.'))
  } else {
    let dirs = path.split('/')
    dirs.pop()
    dirs = dirs.join('/')
    mkdirp.sync(dirs)
    fs.writeFile(path, contents, options, callback)
  }
}

localFS.readFile = function(path, options, callback) {
  fs.readFile(path, options, function (err, content) {
    content = content ? content.toString() : null
    callback(err, content)
  })
}

localFS.getFileToSend = function(path, options, callback) {
  fs.readFile(path, options, function (err, content) {
    callback(err, content)
  })
}

localFS.unlink = fs.unlink

localFS.readdir = function (path, options, callback) {
  options = options || {}
  if (options.withFileTypes) throw new Error('file types not implemnted yet')
  fs.readdir(path, options, function (err, files) {
    // onsole.log('in readdir read ', { path, err })
    if (err) {
      if (err.code?.indexOf('ENOENT') > -1) {
        callback(null, [])
      } else {
        callback(err)
      }
    } else {
      // var formattedList = [] // to be used for withFileTypes
      // files.forEach((file, i) => { formattedList.push(file) })
      callback(null, files)
    }
  })
}

localFS.mkdirp = mkdirp // to review if this is needed. (added not teste dby cursor 2025-10)

localFS.initFS = function(callback) { callback(null) }


// nedb related
localFS.appendNedbTableFile = fs.appendFile;
localFS.readNedbTableFile = fs.readFile;
localFS.deleteNedbTableFiles = function(filename, callback) {
  if (fs.existsSync(filename)) fs.unlinkSync(filename)
  callback(null)
}
; // for local system, deleting one file effectively deletes the table
localFS.writeNedbTableFile = fs.writeFile; // This reqrites the whole table, which is the same as for local fs
/**
 * @sf_added - Moved crashSafeWriteFile (now crashSafeWriteNedbFile ) and flushToStorage here from storage.js
 * crashSafeWriteNedbFile will be handled differently for remote storage systems to make them less operation intensive
 * Flush data in OS buffer to storage if corresponding option is set
 * @param {String} options.filename
 * @param {Boolean} options.isDir Optional, defaults to false
 * If options is a string, it is assumed that the flush of the file (not dir) called options was requested
 */
const flushToStorage = function (options, callback) {
  var filename, flags;
  if (typeof options === 'string') {
    filename = options;
    flags = 'r+';
  } else {
    filename = options.filename;
    flags = options.isDir ? 'r' : 'r+';
  }

  // Windows can't fsync (FlushFileBuffers) directories. We can live with this as it cannot cause 100% dataloss
  // except in the very rare event of the first time database is loaded and a crash happens
  if (flags === 'r' && (process.platform === 'win32' || process.platform === 'win64')) { return callback(null); }

  fs.open(filename, flags, function (err, fd) {
    if (err) { return callback(err); }
    fs.fsync(fd, function (errFS) {
      fs.close(fd, function (errC) {
        if (errFS || errC) {
          if (errFS) console.warn({ errFS })
          if (errC) console.warn({ errC })
          var e = new Error('Failed to flush to storage');
          e.errorOnFsync = errFS;
          e.errorOnClose = errC;
          return callback(e);
        } else {
          return callback(null);
        }
      });
    });
  });
};

localFS.crashSafeWriteNedbFile = function (filename, data, cb) {
  var callback = cb || function () {}
    , tempFilename = filename + '~';

  async.waterfall([
    async.apply(flushToStorage, { filename: path.dirname(filename), isDir: true })
  , function (cb) {
      localFS.exists(filename, function (exists) {
        if (exists) {
          flushToStorage(filename, function (err) { return cb(err); });
        } else {
          return cb();
        }
      });
    }
  , function (cb) {
      localFS.writeFile(tempFilename, data, function (err) { return cb(err); });
    }
  , async.apply(flushToStorage, tempFilename)
  , function (cb) {
      localFS.rename(tempFilename, filename, function (err) { return cb(err); });
    }
  , async.apply(flushToStorage, { filename: path.dirname(filename), isDir: true })
  ], function (err) { return callback(err); })
};

// Other file system
localFS.sendLocalFile = function(fullPath, res) {
  console.warn('sendLocalFile DISABLED - functinality now via ', { fullPath })
  res.sendStatus(400) // 400 Bad Request
  // const filePath = path.normalize(fullPath)
  // if (fs.existsSync(filePath)) {
  //   res.sendFile(filePath);
  // } else {
  //   // console.log('should this be a non-response')
  //   res.sendStatus(401)
  // }
}
localFS.removeFolder = function(fullPath, callback) {
  deleteLocalFolderAndContents(fullPath, callback)
}
var deleteLocalFolderAndContents = function(location, next) {
    // http://stackoverflow.com/questions/18052762/in-node-js-how-to-remove-the-directory-which-is-not-empty
    fs.readdir(location, function (err, files) {
      async.forEach(files, function (file, cb) {
        file = location + path.sep + file
        fs.stat(file, function (err, stat) {
          if (err) {
            return cb(err);
          }
          if (stat.isDirectory()) {
            deleteLocalFolderAndContents(file, cb);
          } else {
            fs.unlink(file, function (err) {
              cb(err)
            })
          }
        })
      }, function (err) {
          if (err) return next(err)
          fs.rmdir(location, function (err) {
              if (err && err.code !== 'ENOENT') { 
                return next(err);
              } else {
                return next(null)
              }
          })
      })
    })
}
// Interface
export default localFS
