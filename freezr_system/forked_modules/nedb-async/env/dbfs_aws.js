// fs_obj_aws.js 2020-06
/*
AWS S3 file system object used for freezr and nedb-async
API docs: using https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html

for nedb sync, each type of FS should have a file with the following functions
- Commands similar to 'fs'
    writeFile
    rename
    unlink
    exists
    readdir
    mkdirp (Not needed on some systems)
- Addional commands
  appendNedbTableFile (mimicks functinaility without adding actually appending)
  readNedbTableFile
  deleteNedbTableFiles
  writeNedbTableFile
  crashSafeWriteNedbFile
  INITFS (optional)

*/

var async = require('async')

function AWS_FS(credentials = {}, options = {}) {
  // onsole.log("New aws fs")
  this.aws = require('aws-sdk');
  this.aws.config.update({
    region: credentials.region || 'eu-central-1',
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey
  });

  this.bucket = credentials.bucket || 'freezr'
  this.doNotPersistOnLoad = (options.doNotPersistOnLoad === false)? false : true
}

AWS_FS.prototype.name = 'aws'


// primitives
AWS_FS.prototype.initFS = function (callback) {
  // onsole.log(' - aws INITFS ',this.bucket)
  self = this

  const s3 = new self.aws.S3(/*{apiVersion: '2006-03-01'}*/).createBucket({Bucket: self.bucket}, function(err, awsCreateBucketResponse) {
    if (!err || err.code === 'BucketAlreadyOwnedByYou') {
      callback(null)
    } else {
      console.warn("err in INITFS ",err, err.stack);
      callback(err)
    }
  })
}
AWS_FS.prototype.writeFile = function(path, contents, options, callback) {
  // onsole.log(' - aws writefile',path, this.bucket, "contents:",contents)
  // console.log(Need to handle overwrite option - options not implemented  (ie AAWS overwrites)
  // console.log("options not implemented - doNotOverWrite")
  if (options && options.doNotOverWrite) {
    callback(new Error('doNotOverWrite option is not set in aws'))
  } else {
    const objectParams = { Bucket: this.bucket, Key: path, Body: contents }
    const s3 = new this.aws.S3()
    s3.putObject(objectParams, function (err, awsWriteResponse) {
      if (err) console.warn('writeFile err', { err, awsWriteResponse })
      return callback(err)
    })
  }
}
AWS_FS.prototype.rename = function(from_path, to_path, callback) {
  // onsole.log(' - aws-rename ',from_path, to_path)

  const bucket = this.bucket
  const s3 = new this.aws.S3()
  const self = this;
  let chainEnded = false
  this.unlink(to_path, function(rename_delete_err) {
    if (rename_delete_err) {
      console.warn({rename_delete_err})
      callback(new Error('rename_delete_err ' + from_path + ' to ' + to_path))
    } else {
      const params = {
        Bucket: bucket,
        CopySource: '/' + bucket + '/' + from_path,
        Key: to_path
      }
      s3.copyObject(params).promise()
      .then(response => {
        self.unlink(from_path, function(rename_delete_err2) {
          if (rename_delete_err2) console.warn({rename_delete_err2})
          chainEnded = true
          return callback(rename_delete_err2)
        })
      } )
      .catch(err  => {
        console.warn('rename move error ',from_path,err)
        if (!chainEnded) return callback(new Error('rename_move_err ' + from_path + ' to ' + to_path))
      })
    }
  })
}
AWS_FS.prototype.unlink = function(path, callback) {
  // onsole.log(' - aws-unlink ',path)
  const bucket = this.bucket
  const s3 = new this.aws.S3()
  let chainEnded = false;

  s3.deleteObject({ Bucket: bucket, Key: path }).promise()
  .then(response => {
    chainEnded= true;
    return callback(null)
  })
  .catch(error => {
    if (isPathNotFound(error)){
      // Does not exist so not an error here - all is okay
      return callback(null)
    } else {
      console.warn('unlink err ', path, error)
      if (chainEnded) return callback( error )
    }
  })
}
AWS_FS.prototype.exists = function(file, callback){
  // onsole.log(' - aws-exists ',file, ' in ',this.bucket)

  const objectParams = { Bucket: this.bucket, Key: file };
  const s3 = new this.aws.S3()

  s3.headObject(objectParams, function (err, metadata) {
    if (isPathNotFound(err)) {
      return callback(false)
    } else if (err){
      console.warn('exists-aws unknown headObject err ', file, err)
      throw new Error('unknown aws read errror')
    } else {
      return callback(true)
    }
  });
}
AWS_FS.prototype.mkdirp = function(path, callback) {
  // onsole.log(' - aws-mkdirp ',path," - not needed")
  return callback(null)
}
AWS_FS.prototype.readdir = function(dirpath, callback) {
  // Note current implementation doesnt return more files than the limit
  // onsole.log('aws reading dir ',dirpath )

  const bucket = this.bucket
  const s3 = new this.aws.S3()
  let chainEnded = false

  s3.listObjectsV2({ Bucket:bucket, Delimiter: '/', Prefix: dirpath+'/' }).promise()
  .then(response => {
    const entries = response.Contents.map(entry => { return entry.Key})
    chainEnded = true
    return callback(null, entries)
  })
  .catch(err => {
    console.warn('readdir',{chainEnded, err})
    if (!chainEnded) return callback(err)
  })
}
AWS_FS.prototype.readFile = function(path, encoding, callback) {
  console.log(' aws readFile ')

  let contents = null
  const bucket = this.bucket
  const params = {
    Bucket: bucket,
    Key: path
  };
  const s3 = new this.aws.S3()

  s3.getObject(params).promise()
    .then(data => {
      const contents = data.Body.toString('utf8')
      return callback(null, contents)
    })
    .catch(error => {
      console.warn('got a real err in readFile for ' + path, error)
      return callback(error)
    })
}
AWS_FS.prototype.getFileToSend = function(path, callback) {

  console.log(' aws getFileToSend experimental')
  const bucket = this.bucket
  const params = {
    Bucket: bucket,
    Key: path
  };
  const s3 = new this.aws.S3()

  s3.getObject(params).promise()
    .then(data => {
      const contents = data.Body
      return callback(null, contents)
    })
    .catch(error => {
      console.warn('got a real err in readFile for ' + path, error)
      return callback(error)
    })
}
AWS_FS.prototype.removeFolder = function(dirpath, cb) {

  cb = cb || function () {}
  const bucket = this.bucket
  const s3 = new this.aws.S3()

  getAllAppendDirectoryFiles (s3, bucket, dirpath, true)
    .then(fileEntries => {
      console.log('aws got file entries of len ' + fileEntries.length)
      if (fileEntries.length >= 1000) {
        fileEntries = fileEntries.slice(0,999) // todo - should clean recursively
      }
      // onsole.log('TO DELETE for writeNedbTableFile entrie of len ' + fileEntries.length)
      if (fileEntries.length>0){
        s3.deleteObjects({ Bucket: bucket, Delete: { Objects: fileEntries, Quiet: false } }).promise()
      } else {
        return null
      }
    } )
    .then(s3DeleteRet => {
      throw new Error('notAnError')
    })
    .catch(errEndOnwriteTable => {
      if (errEndOnwriteTable.message === 'notAnError') {
        cb(null)
      } else {
        console.warn({errEndOnwriteTable});
        cb(errEndOnwriteTable)
      }
    })
}

AWS_FS.prototype.appendNedbTableFile = function(filepath, contents, encoding, callback) {
  // The main different with the stgandard functions from local fs, is that instead of appending to the
  // main file which requires a full read and write operation every time,
  // appended items are added to another folder - one file per record - and then read back when the
  // (table) file is read, or deleted after crashSafeWriteNedbFile

  // onsole.log(' - aws-append start ',filepath, contents, new Date().toLocaleTimeString() + ' : ' + new Date().getMilliseconds())
  // if (encoding) console.warn('ignoring encoding on append for file ',{filepath,encoding} )

  let [appendDirectory] = getnamesForAppendFilesFrom(filepath)
  // this.mkdirp (appendDirectory, function(err) {}) NOT Needed as aws has not folder structure
  const path = appendDirectory + '/' + dateBasedNameForFile()

  const objectParams = {Bucket: this.bucket, Key: path, Body: contents};
  const s3 = new this.aws.S3()

  s3.putObject(objectParams, function(err, awsWriteResponse) {
    if (err) console.warn('error append for '+filepath, {err, awsWriteResponse})
    return callback(err)
  })
}
AWS_FS.prototype.readNedbTableFile = function(path, encoding, callback) {
  // read file goes through folder with appends, and adds them to content
  // onsole.log(' - aws-readNedbTableFile ',path)

  var [appendDirectory] = getnamesForAppendFilesFrom(path)
  var appendlist = [];
  let contents = null
  const bucket = this.bucket
  let tagList = {}

  const params = {
    Bucket: bucket,
    Key: path
  };
  const s3 = new this.aws.S3()

  s3.getObject(params).promise()
  .then(data => {
    contents = data.Body.toString('utf8')
    return getAllAppendDirectoryFiles(s3, bucket, appendDirectory, true)
  })
  .then( timelyEntries => {
    if (timelyEntries.length>0){
      timelyEntries.forEach(entry => tagList[entry.ETag] = entry.Key)
      return Promise.all(timelyEntries.map(afile => s3.getObject({ Bucket: bucket, Key: afile.Key }).promise() ))
    } else {
      return []
    }
  })
  .then(appends => {
    appends.forEach(append => {
      appendlist.push({Key: tagList[append.ETag], fileBinary: append.Body.toString('utf8')})
    })
    appendlist = appendlist.sort(sortByMod)
    appendlist.forEach(append => {contents += append.fileBinary})
    throw new Error('notAnError')
  })
  .catch(error => {
    if (error.message === 'notAnError') {
      return callback(null, contents)
    } else {
      console.warn('got a real err in readNedbTableFile for '+path,error)
      return callback(error)}
  })
}
AWS_FS.prototype.writeNedbTableFile = function(filename, data, options, callback) {
  // new writeFile also writes over the appended file directory
  // onsole.log('writeNedbTableFile writeFile ', {filename, data})

  callback = callback || function () {}
  const bucket = this.bucket
  const s3 = new this.aws.S3()
  const self = this;
  const now = new Date().getTime()

  let [appendDirectory] = getnamesForAppendFilesFrom(filename)

    async.waterfall([
    // Write the new file and then delete the temp folder
    function (cb) {
        self.writeFile(filename, data, {}, function (err) { return cb(err); });
      }
    , function (cb) {
        getAllAppendDirectoryFiles (s3, bucket, appendDirectory, true)
        .then(fileEntries => {
          if (fileEntries.length > 0) {
            fileEntries = fileEntries.sort(sortByMod).reduce((result, entry) => {
              if (timeFromPath(entry.Key) < now) result.push({ Key: entry.Key })
              return result
            }, [])
          }

          if (fileEntries.length >= 1000) {
            fileEntries = fileEntries.slice(0,999) // the rest can be done later
          }
          // onsole.log('TO DELETE for writeNedbTableFile entrie of len ' + fileEntries.length)
          if (fileEntries.length>0){
            s3.deleteObjects({ Bucket: bucket, Delete: { Objects: fileEntries, Quiet: false } }).promise()
          } else {
            return null
          }
        } )
        .then(s3DeleteRet => {
          throw new Error('notAnError')
        })
        .catch(errEndOnwriteTable => {
          if (errEndOnwriteTable.message === 'notAnError') {
            cb(null)
          } else {
            console.warn({errEndOnwriteTable});
            cb(errEndOnwriteTable)
          }
        })
      }
    ], function (err) {
      if (err) console.warn('writeNedbTableFile end for '+filename, err, data)
      return callback(err);
    })
}
AWS_FS.prototype.deleteNedbTableFiles = function(file, callback) {
  var [appendDirectory] = getnamesForAppendFilesFrom(file)
  var appendlist = [];
  const bucket = this.bucket
  const now = new Date().getTime()
  const s3 = new this.aws.S3()

  getAllAppendDirectoryFiles(s3, bucket, appendDirectory, true)
  .then( fileEntries => {
    const entries = fileEntries.map(entry => { return {Key: entry.Key   } })
    if (fileEntries>1000)  console.error('potential error - got more than 1000 files')
    if (fileEntries == 0)
      return null
    else
      s3.deleteObjects({ Bucket: bucket, Delete: { Objects: entries, Quiet: false } }).promise()
  })
  .then(appends => {
    s3.deleteObject({ Bucket: bucket, Key: file }).promise()
  })
  .then(response => {
    // small pause on delete
    chainEnded = true
    setTimeout(function(){return callback(null)},100)
  })
  .catch(error => {
    if (!chainEnded) {
      console.warn('got err in deleteNedbTableFiles for ',error)
      return callback(error)
    }
  })
}
AWS_FS.prototype.crashSafeWriteNedbFile = function(filename, data, callback) {
  // For storage services, the crashSafeWriteNedbFile could be ransformed to crashSafeWriteFileOnlyIfThereAreAppendedRecordFiles
  // if there are no appended records (which are stored in files (See appendNedbTableFile above) ) then there is no need to rewrite the file
  // However the original logic of the crashSafeWriteFile is maintained here

  // NOTE: THIS SHOULD ONLY BE CALLED WHEN THE INMEMORY DB ACTUALLY HAS ALL THE DATA - IE THAT IT HAS PERSISTED

  callback = callback || function () {}
  const bucket = this.bucket
  const s3 = new this.aws.S3()
  const self = this;
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
        getAllAppendDirectoryFiles (s3, bucket, appendDirectory, true)
        .then(fileEntries => {
          if (fileEntries.length > 0) {
            fileEntries = fileEntries.sort(sortByMod).reduce((result, entry) => {
              if (timeFromPath(entry.Key) < now) result.push({ Key: entry.Key })
              return result
            }, [])
          }

          if (fileEntries.length >= 1000) {
            fileEntries = fileEntries.slice(0,999) // the rest can be done later
          }
          // onsole.log('crashSafeWriteNedbFile - To delete entries of len ' + fileEntries.length)
          s3.deleteObjects({ Bucket: bucket, Delete: { Objects: fileEntries, Quiet: false } }).promise()
        } )
        .then(s3DeleteRet => {
          throw new Error('notAnError')
        })
        .catch(errEndOnCrashSafe => {
          if (errEndOnCrashSafe.message === 'notAnError') {
            cb(null)
          } else {
            console.warn({errEndOnCrashSafe});
            cb(errEndOnCrashSafe)
          }
        })
      }
    ], function (err) {
      if (err) console.warn('crashSafeWriteNedbFile end for ',{filename, err, data})
      return callback(err);
    })
}

const appendFileFolderName = function(filename){
  let parts = filename.split('.')
  parts.pop()
  return '~'+filename
}
const getnamesForAppendFilesFrom = function(path) {
  let parts = path.split('/')
  let oldfilename=parts.pop()
  parts.push(appendFileFolderName(oldfilename))
  path = parts.join('/')
  return [path, oldfilename]
}
const getAllAppendDirectoryFiles = function (s3, bucket, appendDirectory, ignoreTime) {
  const recursiveAppendRead = function(s3, appendDirectory, oldlist, continuationToken, callback) {
    s3.listObjectsV2({ Bucket:bucket, Delimiter: '/', Prefix: appendDirectory+'/', ContinuationToken: continuationToken  /*, MaxKeys: 5*/ }).promise()
    .then(response => {
      const newlist = oldlist.concat(response.Contents)
      if (response.isTruncated) {
        recursiveAppendRead(s3, appendDirectory, newlist, response.NextContinuationToken, callback)
      } else {
        return callback(null, newlist)
      }
    })
    .catch(error => {
      return callback(error)
    })
  }

  return new Promise((resolve, reject) => {
    const writeTime = new Date();
    let gotInitialList = false;
    // onsole.log('getAllAppendDirectoryFiles   for ',appendDirectory)
    s3.listObjectsV2({ Bucket:bucket, Delimiter: '/', Prefix: appendDirectory+'/' /*, MaxKeys: 5*/ }).promise()
    .then(response => {
      gotInitialList = true;
      if (response.isTruncated) {
        return new Promise((resolve, reject) => {
          recursiveAppendRead(s3, appendDirectory, response.Contents, response.NextContinuationToken, function(err, list) {
            if (err) { reject (err) } else { resolve (list) }
          })
        })
      } else {
        return response.Contents
      }
    })
    .then(allentries => {
      const timelyEntries = []
      allentries.forEach(entry => {
        // in case a write operation has hapenned while this loop is run (and also to remove any folders which may be used for future functionality)
        let entryTime = entry.LastModified
        if (ignoreTime || entryTime < writeTime) timelyEntries.push(entry)
      });
      resolve(timelyEntries)
    })
    .catch(error => {
      if (!gotInitialList && isPathNotFound(error)) {
        // 'Not an error - there is no append directory so can just send back main file contents '+appendDirectory
        resolve([])
      } else {
        console.warn(' read error from '+appendDirectory, error)
        reject(error)
      }
    })
  })
}

function isPathNotFound(aws_error) {
  return (aws_error && aws_error.code === 'NotFound')
}

function sortByMod(a,b) {
  if (!b || !b.Key || !a || !a.Key)
    throw new Error('trying to sort non existant objects ',a,b);
  else {
    return timeFromPath(a.Key) - timeFromPath(b.Key)
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


// Interface
module.exports = AWS_FS;
