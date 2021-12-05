/**
 * Default filesystem - uses fs module
 * Behaviour is (or should be) consistent with the original NeDB
 *
 * Any custom filesystems need to implement the same functions
 */


var fs = require('fs')
  , async = require('async')
  , mkdirp = require('mkdirp')
  , path = require('path')
  , localFS = {}
  ;

localFS.name = 'local'

localFS.exists = function(filename, callback) {
  callback (fs.existsSync(filename)? true: false)
}
localFS.rename = fs.rename;
localFS.writeFile = function (path, contents, options, callback) {
  if (options && options.doNotOverWrite && fs.existsSync(path)) {
    callback(new Error('File exists - doNotOverWrite option was set and could not overwrite.'))
  } else {
    let dirs = path.split('/')
    dirs.pop()
    dirs = dirs.join('/')
    mkdirp.sync(dirs)
    fs.writeFile(path, contents, options, callback)
    /*
    mkdirp(dirs)
      .then(made => {
        console.log(`made directories, starting with ${made}`)
      })
      .catch(err =>
        callback(err)
      )
    */
  }
}
localFS.readFile = function(path, options, callback) {
  fs.readFile(path, options, function (err, content) {
    content = content ? content.toString() : null
    callback(err, content)
  })
}
localFS.unlink = fs.unlink;
localFS.readdir = fs.readdir;
localFS.mkdirp = mkdirp;

localFS.initFS = function(callback) { callback(null) };


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
          if (errFS) console.warn({errFS})
          if (errC) console.warn({errC})
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
  const filePath = path.normalize(fullPath)
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    // console.log('should this be a non-response')
    res.sendStatus(401)
  }
}
localFS.removeFolder = function(fullPath, callback) {
  const filePath = path.normalize(fullPath)
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
                        if (err) {
                            return cb(err);
                        }
                        return cb();
                    })
                }
            })
        }, function (err) {
            if (err) return next(err)
            fs.rmdir(location, function (err) {
                return next(err)
            })
        })
    })
}
// Interface
module.exports = localFS;
