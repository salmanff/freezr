/**
 * Way data is stored for this database
 * For a Node.js/Node Webkit database it's the file system
 * For a browser-side database it's localforage which chooses the best option depending on user browser (IndexedDB then WebSQL then localStorage)
 *
 * This version is the Node.js/Node Webkit version
 * It's essentially fs, mkdirp and crash safe write and read functions

 * @sf_added customFS to all functions and moved multiple functionalities to the custom file system file
 */

var async = require('async')
  , storage = {}
  ;

storage.exists = function(file, customFS, callback) {
  return customFS.exists(file, callback);
}
storage.rename = function(oldPath, newPath, customFS, callback) {
  customFS.rename(oldPath, newPath, callback);
}
storage.readdir = function(folerpath, callback) {
  customFS.readdir(folerpath, callback);
}
storage.writeNedbTableFile = function(tempFilename, data, options, customFS, callback) {
  if (callback === undefined) {
    let realcallback = customFS
    let realcustomFS = options
    return realcustomFS.writeNedbTableFile(tempFilename, data, null, realcallback)
  } else {
    customFS.writeNedbTableFile(tempFilename, data, options, function(err){
      return callback(err)
    })
  }
};
storage.unlink = function(file, customFS, callback) {
  return customFS.unlink(file, callback);
}
storage.appendFile = function(filename, toPersist, encoding, customFS, callback) {
  return customFS.appendNedbTableFile(filename, toPersist, encoding, callback)
};
storage.readFile = function(filename, encoding, customFS, callback ) {
  return customFS.readNedbTableFile(filename, encoding, callback)
};
storage.mkdirp = function(dir, customFS, callback) {
  return customFS.mkdirp(dir, callback)
}


storage.ensureFileDoesntExist = function (file, customFS, callback) {
  // @sf_changed This is changed because files may exist in the folder even if the main db files doesnt exist, so using 'exists' is not sufficient. Need to delete all.
  customFS.deleteNedbTableFiles(file, function (err) {
    if (!err) err = null
    return callback(err);
  })
};


/**
 * Fully write or rewrite the datafile, immune to crashes during the write operation (data will not be lost)
 * @param {String} filename
 * @param {String} data
 * @param {Function} cb Optional callback, signature: err
 */

storage.crashSafeWriteFile = function (filename, data, customFS, cb) {
  return customFS.crashSafeWriteNedbFile (filename, data, cb)
};

/**
 * Ensure the datafile contains all the data, even if there was a crash during a full file write
 * @param {String} filename
 * @param {Function} callback signature: err
 */
storage.ensureDatafileIntegrity = function (filename, customFS, callback) {
  var tempFilename = filename + '~';

  storage.exists(filename, customFS, function (filenameExists) {
    // Write was successful
    if (filenameExists) { return callback(null); }

    storage.exists(tempFilename, customFS, function (oldFilenameExists) {
      // New database
      if (!oldFilenameExists) {
        storage.writeNedbTableFile(filename, '', 'utf8', customFS, function (err) {
          callback(err);
        });
      } else {
        // Write failed, use old version
        storage.rename(tempFilename, filename, customFS, function (err) {
          if (!err) err = null;
          return callback(err);
        });
      }
    });
  });
};



// Interface
module.exports = storage;
