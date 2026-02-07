// freezr.info - dbfs_azure.mjs
// Azure blob store file system connector (MODERNIZED TO ES6 MODULES)
//
// Original: fs_obj_azure.js 2020-06
// Azure blob store file system object used for freezr and nedb-asyncfs
// API docs: using https://learn.microsoft.com/en-us/azure/storage/blobs/storage-quickstart-blobs-nodejs?tabs=connection-string%2Croles-azure-portal%2Csign-in-visual-studio-code&pivots=blob-storage-quickstart-scratch
  // for nedb-asyncfs, each type of file system should have a file with the following functions
  // - Commands similar to 'fs'
  //   writeFile
  //   rename
  //   unlink (should be used for files only)
  //   exists
  //   stat (similar to fs.stat except it has type (dir or file) instead of isDirectory and isFile)
  //   readFile
  //   readdir
  // - Addional file commands
  //   readall
  //   deleteObjectList
  //   mkdirp
  //   initFS (optional)
  //   getFileToSend
  //   removeFolder (like unlink for folders)
  // - NeDB specific
  //   appendNedbTableFile (mimicks functinaility without adding actually appending)
  //   readNedbTableFile
  //   deleteNedbTableFiles
  //   writeNedbTableFile
  //   crashSafeWriteNedbFile
  
import async from 'async'
import path from 'path'
import { BlobServiceClient } from '@azure/storage-blob'
import { DefaultAzureCredential } from '@azure/identity'

// Import modernized nedb table functions
import {
  appendNedbTableFile,
  readNedbTableFile,
  deleteNedbTableFiles,
  writeNedbTableFile,
  crashSafeWriteNedbFile
} from './nedbtablefuncs.mjs'

function AZURE_FS (credentials = {}, options = {}) {
  this.BlobServiceClient = BlobServiceClient
  this.defaultAzureDredentials = DefaultAzureCredential
  this.params = {
    msConnectioNString: credentials?.msConnectioNString,
    secretAccessKey: credentials?.secretAccessKey,
    storageAccountName: credentials?.storageAccountName || 'freezrstorageaccount',
    containerName: credentials?.containerName || 'freezrcontainer'
  }
  this.doNotPersistOnLoad = (options.doNotPersistOnLoad === false)? false : true
}

AZURE_FS.prototype.name = 'azure'

// primitives
AZURE_FS.prototype.initFS = function (callback) {
  // onsole.log(' - azure INITFS ',this.name)
  const self = this

  // Use connection string if available, otherwise use DefaultAzureCredential
  let blobServiceClient
  if (self.params.msConnectioNString) {
    // console.log('⚠️  Using connection string for Azure authentication - make sure this works in production - NOT needed in Azure environment!!')
    blobServiceClient = self.BlobServiceClient.fromConnectionString(self.params.msConnectioNString)
  } else {
    // onsole.log('Using DefaultAzureCredential for Azure authentication within Azure environment')
    blobServiceClient = new self.BlobServiceClient(
      `https://${self.params.storageAccountName}.blob.core.windows.net`,
      new self.defaultAzureDredentials()
    )
  }

  // CREATE CONTAINER ====================================================================================
  // Create a unique name for the container
  const containerName = self.params.containerName
  const containerClient = blobServiceClient.getContainerClient(containerName);

  const listOptions = {
    includeDeleted: false,
    includeMetadata: true,
    includeSystem: true,
    prefix: containerName
  }
  
  blobServiceClient.listContainers(listOptions).next()
  .then((existing) => {
    if (existing?.value?.name === containerName) {
      // onsole.log('Container already exists - gor containerClient')
      self.containerClient = containerClient
      return callback(null)
    } else {
      // ddlog('\nCreating container...', containerName);
  
      // Get a reference to a container
      // Create the container
      containerClient.create()
      .then((createContainerResponse) => {
        // onsole.log(`Container was created successfully.\n\trequestId:${createContainerResponse.requestId}\n\tURL: ${containerClient.url}`);
        self.containerClient = containerClient
        return callback(null)
      })
      .catch(err => {
        console.warn('Error creating container', err);
        throw err
      })
    }
  })
  .catch(err => {
    if (err) console.warn('initFS error ',err)
    if (err) console.warn('initFS error creds ', this.credentials)
    return callback(err)
  })
}
AZURE_FS.prototype.isPresent = function(file, callback){
  // onsole.log(' - azure-exists ',file, ' in ')
  // const self = this
  // if (!this.containerClient)  console.error('Container not initialized ispresent', { self })
  // if (!self.containerClient) return callback(new Error('Container not initialized'))
  const listOptions = {
    includeCopy: false,                 // include metadata from previous copies
    includeDeleted: false,              // include deleted blobs 
    includeDeletedWithVersions: false,  // include deleted blobs with versions
    includeLegalHold: false,            // include legal hold
    includeMetadata: true,              // include custom metadata
    includeSnapshots: false,             // include snapshots
    includeTags: false,                  // include indexable tags
    includeUncommitedBlobs: false,      // include uncommitted blobs
    includeVersions: false,             // include all blob version
    prefix: file                          // filter by blob name prefix
  }
  this.containerClient.listBlobsFlat(listOptions).next()
  .then((existing) => {
    // onsole.log('existing .. ',existing?.value?.name)
    return callback(null, existing?.value?.name === file)
  })
  .catch(err => {
    console.warn('isPresent error ',err)
    return callback(err)
  })
}
AZURE_FS.prototype.exists = function(file, callback){
  // onsole.log(' - azure-exists ',file, ' in ',this.bucket)
  this.isPresent(file, function(err, present) {
    return callback(err ? false : present)
  })
}
AZURE_FS.prototype.mkdirp = function(path, callback) {
  // onsole.log(' - azure-mkdirp ',path," - not needed")
  const self = this
  if (!self.containerClient) {
    // onsole.log('container Not initiatialised - re-intialising fs with ', self.params)
    self.initFS(callback)
  } else {
    return callback(null, null)
  }
}
AZURE_FS.prototype.writeFile = function(path, contents, options, callback) {
  // onsole.log('azure writefile ', { path, contents , options })
  const self = this
  if (options && options.doNotOverWrite) { // Note (ie Aazure overwrites by default)
    self.isPresent(path, function (err, present) {
      if (err) {
        callback(err)
      } else if (present) {
        callback(new Error('File exists - doNotOverWrite option was set and could not overwrite.'))
      } else {
        options.doNotOverWrite = false
        self.writeFile(path, contents, options, callback)
      }
    })
  } else {
    const blockBlobClient = self.containerClient.getBlockBlobClient(path);
    // onsole.log( `\nUploading to Azure storage as blob\n\tname: ${path}:\n\tURL: ${blockBlobClient.url}` );
    blockBlobClient.upload(contents, contents.length)
    .then(response => {
      return callback(null)
    })
    .catch(err => {
      console.warn('Error uploading blob', err);
      return callback(err)
    })
  }
}

AZURE_FS.prototype.unlink = function(path, callback) {
  // onsole.log(' - azure-unlink ',path)
  const self = this

  // include: Delete the base blob and all of its snapshots.
  // only: Delete only the blob's snapshots and not the blob itself.
  const options = {
    deleteSnapshots: 'include' // or 'only'
  }
  const blockBlobClient = self.containerClient.getBlockBlobClient(path);
  blockBlobClient.deleteIfExists(options)
  .then(response => {
    // onsole.log( `Blob was deleted successfully. requestId: ${response.requestId}` )
    return callback(null)
  })
  .catch(err => {
    console.warn('Error deleting blob', err);
    return callback(err)
  })
}
AZURE_FS.prototype.rename = function(from_path, to_path, callback) {
  // onsole.log(' - azure-rename ',from_path, to_path)
  const self = this

  const oldBlobClient = self.containerClient.getBlockBlobClient(from_path);
  const newBlobClient = self.containerClient.getBlockBlobClient(to_path);

  const asyncPolUntilDone = async function (copyPoller) {
    // const copyPoller = await newBlobClient.beginCopyFromURL(oldBlobClient.url)
    const result = await copyPoller.pollUntilDone();
   //  await blobClient.delete();
    return result
  }

  newBlobClient.beginCopyFromURL(oldBlobClient.url)
  .then(copyPoller => {
    return asyncPolUntilDone(copyPoller)
  })
  .then(response => {
    // onsole.log( `Blob was copied successfully. requestId: ${response.requestId}` )
    return self.unlink(from_path, callback) 
  })
  .catch(err => {
    console.warn('Error copying blob', err);
    return callback(err)
  })

}
AZURE_FS.prototype.stat = function (file, callback) {
  // onsole.log(' - azure-exists ',file, ' in ',this.bucket)
  const self = this
  const blobClient = self.containerClient.getBlockBlobClient(file);

  blobClient.getProperties()
  .then(metadata => {
    // onsole.log('Properties of blob ',file, metadata) atimeMs, mtimeMs, ctimeMs, and birthtimeMs
    if (metadata?.lastModified) metadata.mtimeMs = new Date(metadata.lastModified).getTime()
    if (metadata?.createdOn) metadata.birthtimeMs = new Date(metadata.createdOn).getTime()
    if (metadata?.contentLength) metadata.size = metadata.contentLength
    metadata.type = 'file'
    return callback(null, metadata)
  })
  .catch(err => {
    if (err.details?.errorCode === 'BlobNotFound') {
      err.code = 'ENOENT'
    } else {
      console.warn('Error getting blob properties', { err });
    }
    return callback(err)
  })
}


AZURE_FS.prototype.readFile = function(path, options, callback) {
  const self = this
  
  async function streamToText(readable) {
    readable.setEncoding('utf8');
    let data = '';
    for await (const chunk of readable) {
      data += chunk;
    }
    // onsole.log('streamToText',data)
    return data;
  }
  const blockBlobClient = self.containerClient.getBlockBlobClient(path)
  // onsole.log('readFile item ',path)

  blockBlobClient.download(0)
    .then(downloadBlockBlobResponse => {
      return streamToText(downloadBlockBlobResponse.readableStreamBody)
      // return streamToTextPromise(downloadBlockBlobResponse.readableStreamBody)
    })
    .then(data => {
      return callback(null, data)
    })
    .catch(err => { 
      if (err.code === 'BlobNotFound') {
        err.code = 'ENOENT'
      } else {
        console.warn('Error downloading blob', { err})
      }
      return callback(err)
    })
}
AZURE_FS.prototype.size = function(dirorfFilePath, callback) {
  const self = this

  const getFolderSize = function(dirpath, options = { size: 0 }, callback) {
    // onsole.log('getFolderSize ',{dirpath, options})
    self.readdir(dirpath, null, function (err, files) {
      let fullsize = 0
      async.forEach(files, function (file, cb) {
        const fileOrDirPath = dirpath + path.sep + file
        self.size(fileOrDirPath, function (err, size) {
          if (err) {
            cb(err);
           } else {
             fullsize += size
             cb(null)
           }
        })
      }, function (err) {
        callback(err, fullsize)
      })
    })
  }

  self.stat(dirorfFilePath, function (err, metadata) {
    // onsole.log('stat of folder ',{dirorfFilePath, metadata})
    if (metadata && metadata.size) {
      callback(null, metadata.size)
    } else {
      getFolderSize(dirorfFilePath, { size: 0, ContinuationToken: null }, callback)
    }
  })
}
AZURE_FS.prototype.readdir = function(dirPath, options = { maxPageSize: 500 }, callback) {
  const self = this

  options = options || {}
  options.includeMeta = false

  self.readall(dirPath, options)
  .then(entries => {
    return callback(null, entries)
  })
  .catch(err => {
    console.warn('Error readall in readdir:', err);
    return callback(err)
  })
}
AZURE_FS.prototype.getFileToSend = function(path, options, callback) {
  const self = this
  async function streamToBuffer(readableStream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        readableStream.on('data', (data) => {
            chunks.push(data instanceof Buffer ? data : Buffer.from(data));
        });
        readableStream.on('end', () => {
            resolve(Buffer.concat(chunks));
        });
        readableStream.on('error', reject);
    });
  }
  const blockBlobClient = self.containerClient.getBlockBlobClient(path)
  // onsole.log('getFileToSend item ',path)

  blockBlobClient.download()
    .then(downloadResponse => {
      return streamToBuffer(downloadResponse.readableStreamBody)
      // return streamToTextPromise(downloadBlockBlobResponse.readableStreamBody)
    })
    .then(data => {
      // onsole.log('downloaded ',data)
      return callback(null, data)
    })
    .catch(err => { 
      if (err.code === 'BlobNotFound') {
        err.code = 'ENOENT'
        console.warn('Error downloading blob', { err})
      }
      return callback(err)
    })
}
AZURE_FS.prototype.removeFolder = function(dirpath, callback) {

  const self = this
  callback = callback || function () {}

  self.readdir(dirpath, null, function (err, entries) {
    if (err) {
      return callback(err)
    } else if (!entries || entries.length === 0) {
      return callback(null) // (new Error('ENOENT: no such file or directory'))
    } else {
      async.forEach(entries, function (filename, cb) {
        const fullName = dirpath + '/' + filename
        self.unlink(fullName, cb)
      }, function (err) {
        callback(err)
      })
    }
  })
}


// ADDITIONAL FILE COMMANDS
AZURE_FS.prototype.readall = function (dirPath, options) {  
  const self = this
  const maxPageSize = options?.maxPageSize || 500
  const includeMeta = options?.includeMeta || false
  
  const entries = []

  const standardiseMetaData = function (metadata) {
    const newMeta = metadata?.properties
    newMeta.path = metadata?.name
    if (newMeta && newMeta.LastModified) newMeta.mtimeMs = new Date(newMeta.LastModified).getTime()
    if (newMeta && newMeta.createdOn) newMeta.birthtimeMs = new Date(newMeta.createdOn).getTime()
    if (newMeta && newMeta.ContentLength) newMeta.size = newMeta.ContentLength
    return newMeta
  }

  return new Promise(async (resolve, reject) => {
    const listOptions = {
      includeMetadata: includeMeta,
      includeSnapshots: false,
      includeTags: false,
      includeVersions: false,
      prefix: dirPath
    }
    const params = { maxPageSize }

    let isTruncated = true;
    try { // try first to cach no files error
      const firstResp = await self.containerClient.listBlobsFlat(listOptions).byPage(params).next()
      const newItems = firstResp.value?.segment?.blobItems
      if (newItems?.length > 0) newItems.forEach((c) => entries.push(includeMeta ? standardiseMetaData(c) : c.name.substring(dirPath.length + 1)))
      params.continuationToken = firstResp?.value?.continuationToken
      isTruncated = Boolean(params.continuationToken)
    } catch (err) {
      isTruncated = false
      if (err.message.indexOf('no such file or directory') >= 0) {
        // do nothing
      } else {
        console.warn('Error in readall:', err);
        return reject(err)
      }
    }

    while (isTruncated) {
      const resp = await self.containerClient.listBlobsFlat(listOptions).byPage(params).next()
      const newItems = resp.value?.segment?.blobItems
      if (newItems?.length > 0) newItems.forEach((c) => entries.push(includeMeta ? standardiseMetaData(c) : c.name.substring(dirPath.length + 1)))
      params.continuationToken = resp?.value?.continuationToken
      isTruncated = Boolean(params.continuationToken)
    }
    resolve(entries)
  })
}

AZURE_FS.prototype.deleteObjectList = function (nativeObjectList, callback) {
  const self = this
  // onsole.log('deleteObjectList in azure ', {dirPath, options })
  //'Key' legacy of aws ;)

  const pathArray = nativeObjectList.map(e => { 
    if (!e.Key && !e.path)console.warn('deleteObjectList - no path in object', e)
    return { Key: (e.path || e.Key) } 
  }).filter(e => e.Key)

  return Promise.all(pathArray.map(afile => {
    return new Promise((resolve, reject) => {
      self.unlink(afile.Key, function(err) {
        if (err) { reject (err) } else { resolve () }
      })
    })
  } ))
  .then(results => {
    return callback(null)
  })
  .catch(err => {
    console.warn('Error in deleteObjectList:', err);
    return callback(err)
  })
}

AZURE_FS.prototype.writeNedbTableFile = writeNedbTableFile
AZURE_FS.prototype.appendNedbTableFile = appendNedbTableFile
AZURE_FS.prototype.readNedbTableFile = readNedbTableFile
AZURE_FS.prototype.deleteNedbTableFiles = deleteNedbTableFiles
AZURE_FS.prototype.crashSafeWriteNedbFile = crashSafeWriteNedbFile


// Interface - Export as cloudFS for generic cloud file system usage
export default AZURE_FS
export { AZURE_FS as cloudFS }
