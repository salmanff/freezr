
// This file is used mostly for testing (though it could be used for launching the db_fs depending on what FS is available).
// Current version works with dropbox and if not present, aws. It can be customised additional types of fs's.

var fs = require('fs')

let name = 'localFS' // default fs
let Custom_FS = null
let dbFS, cred_contents;

// first try getting dbx
Custom_FS = require('./dbfs_dropbox.js')
cred_contents = fs.existsSync("./env/.dropbox_credentials.js")? require("./.dropbox_credentials.js"):null
if (Custom_FS && cred_contents){
  if (cred_contents.accessToken) cred_contents.manualAccessToken = true
  dbFS = (cred_contents.accessToken || cred_contents.refreshToken)? new Custom_FS(cred_contents, {doNotPersistOnLoad: false}) : null;
  if (dbFS) name = 'dropbox'
}

// if dbx is not configured, try aws s3
if (!dbFS) {
  Custom_FS = require('./dbfs_aws.js')
  cred_contents = fs.existsSync("./env/.aws_credentials.js")? require("./.aws_credentials.js") : null
  console.log(cred_contents)
  if (Custom_FS && cred_contents && cred_contents.accessKeyId && cred_contents.secretAccessKey){
    if (!cred_contents.region) cred_contents.region = 'eu-central-1';
    if (!cred_contents.bucket) cred_contents.bucket = 'aws-fsobj-test' // + Math.round(Math.random()*1000000,0)

    dbFS = new Custom_FS(cred_contents, {doNotPersistOnLoad: false});
    if (dbFS) name = 'aws'
  }
}

// if aws is not configured, try  googleDrive
if (!dbFS) {
  Custom_FS = require('./dbfs_googleDrive.js')
  cred_contents = fs.existsSync("./env/.googleDrive_credentials.js")? require("./.googleDrive_credentials.js") : null
  console.log(cred_contents)
  if (Custom_FS && cred_contents &&
      ((cred_contents.refreshToken && cred_contents.clientId && cred_contents.secret) ||
        cred_contents.access_token)
  ) {
    if (!cred_contents.redirecturi) cred_contents.redirecturi = 'localhost:3000/admin/oauth_validate_page'
    dbFS = new Custom_FS(cred_contents, { doNotPersistOnLoad: false });
    if (dbFS) name = 'googleDrive'
  }
}

// if googleDrive is not configured, user local
if (!dbFS) {
  dbFS = require('./dbfs_local.js')
  name = 'defaultLocalFS'
}


// Interface
module.exports = {name, dbFS}
