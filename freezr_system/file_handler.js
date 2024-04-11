// freezr.info - nodejs system files - file_handler

/* todo 2021
  - later do:
      - clean up ugliness
      - redo other variables so it is an object not a string
      - replaced fs,exist swith fsexistssysnc in localCheckExistsOrCreateUserFolder (without checking p to recheck)
*/
exports.version = '0.0.200'

const path = require('path')
const fs = require('fs')
const async = require('async')
const helpers = require('./helpers.js')
const json = require('comment-json')
const mkdirp = require('mkdirp')

require('./flags_obj.js') /* global Flags */

// MAIN LOAD PAGE
const FREEZR_CORE_CSS = '<link rel="stylesheet" href="/app_files/public/info.freezr.public/public/freezr_core.css" type="text/css" />'
const FREEZR_CORE_JS = '<script src="/app_files/public/info.freezr.public/public/freezr_core.js" type="text/javascript"></script>'
exports.load_data_html_and_page = function (req, res, options) {
  fdlog('load_data_html_and_page for ' + JSON.stringify(options.page_url), req.freezrAppFS)
  req.freezrAppFS.readAppFile(options.page_url, null, function (err, htmlContent) {
    // fdlog('in file_handler load_data_html_and_page foe content.. ', htmlContent)
    if (err) {
      felog('load_data_html_and_page', 'got err reading: ' + req.freezrAppFS.pathToFile(options.user_id, options.app_name, options.page_url), { err })
      htmlContent = fs.readFileSync('systemapps' + exports.sep() + 'info.freezr.public' + exports.sep() + 'public' + exports.sep() + 'fileNotFound.html')
    }
    if (options.queryresults) {
      // fdlog('file_handle queryresults:' + JSON.stringify(options.queryresults))
      const Mustache = require('mustache')
      options.page_html = Mustache.render(htmlContent, options.queryresults)
      exports.load_page_html(req, res, options)
    } else {
      options.page_html = htmlContent
      exports.load_page_html(req, res, options)
    }
  })
}
exports.load_page_html = function (req, res, opt) {
  fdlog('load page html', opt.app_name + '... ' + opt.page_url + ' isPublic ? ' + opt.isPublic)

  fs.readFile(
    opt.isPublic ? 'html_skeleton_public.html' : 'html_skeleton.html',
    function (err, contents) {
      if (err) {
        felog('load_page_html', 'err reading skeleton file ' + (opt.isPublic ? 'html_skeleton_public.html' : 'html_skeleton.html'), err)
        helpers.send_failure(res, 500, err)
        return
      }
      contents = contents.toString('utf8')

      if (!opt.app_name) {
        // need these two to function
        opt.app_name = 'info.freezr.public '
        opt.page_url = opt.page_url || 'fileNotFound.html' //
      }
      // fdlog('load_page_html path to ',req.freezrAppFS.pathToFile(opt.page_url) )

      contents = contents.replace('{{PAGE_TITLE}}', opt.page_title ? opt.page_title : 'app - freezr')
      contents = contents.replace('{{PAGE_URL}}', partUrlPathTo(opt.user_id, opt.app_name, opt.page_url))
      contents = contents.replace('{{APP_CODE}}', opt.app_code ? opt.app_code : '')
      contents = contents.replace('{{APP_NAME}}', opt.app_name)
      contents = contents.replace('{{APP_VERSION}}', (opt.app_version))
      contents = contents.replace('{{APP_DISPLAY_NAME}}', (opt.app_display_name ? opt.app_display_name : opt.app_name))
      contents = contents.replace('{{USER_ID}}', opt.user_id ? opt.user_id : '')
      contents = contents.replace('{{USER_IS_ADMIN}}', opt.user_is_admin ? opt.user_is_admin : false)
      contents = contents.replace('{{FREEZR_SERVER_VERSION}}', (opt.freezr_server_version ? opt.freezr_server_version : 'N/A'))
      contents = contents.replace('{{SERVER_NAME}}', opt.server_name)
      contents = contents.replace('{{FREEZR_CORE_CSS}}', FREEZR_CORE_CSS)
      contents = contents.replace('{{FREEZR_CORE_JS}}', FREEZR_CORE_JS)
      const nonce = helpers.randomText(10)
      contents = contents.replace('{{FREEEZR-SCRIPT-NONCE}}', nonce)
      contents = contents.replace('{{FREEEZR-SCRIPT-NONCE}}', nonce) // 2nd instance
      contents = contents.replace('{{META_TAGS}}', opt.meta_tags ? opt.meta_tags : '')

      contents = contents.replace('{{HTML-BODY}}', opt.page_html ? opt.page_html : 'Page Not found')

      let cssFiles = ''
      let thePath
      const userId = (helpers.is_system_app(opt.app_name)) ? null : opt.owner_id
      if (opt.css_files) {
        if (typeof opt.css_files === 'string') opt.css_files = [opt.css_files]
        opt.css_files.forEach(function (aFile) {
          thePath = partUrlPathTo(userId, opt.app_name, aFile)
          if (exports.fileExt(thePath) === 'css') {
            cssFiles = cssFiles + ' <link rel="stylesheet" href="' + thePath + '" type="text/css" />'
          } else {
            felog('load_page_skeleton', 'ERROR - NON CSS FILE BEING USED FOR CSS for:' + opt.owner_id + ' app:' + opt.app_name + ' page: ' + opt.page_url)
          }
        })
      }
      if (opt.full_css_files) {
        opt.full_css_files.forEach(function (aFilePath) {
          if (exports.fileExt(aFilePath) === 'css') {
            cssFiles = cssFiles + ' <link rel="stylesheet" href="' + aFilePath + '" type="text/css" />'
          } else {
            felog('load_page_skeleton', 'ERROR - NON CSS FILE BEING USED FOR CSS for: ' + aFilePath + ' at ' + opt.owner_id + ' app:' + opt.app_name + ' page: ' + opt.page_url)
          }
        })
      }
      contents = contents.replace('{{CSS_FILES}}', cssFiles)

      let scriptFiles = ''
      if (opt.script_files) {
        opt.script_files.forEach(function (pathToFile) {
          thePath = partUrlPathTo(userId, opt.app_name, pathToFile)
          scriptFiles = scriptFiles + '<script src="' + thePath + '" type="text/javascript"></script>'
        })
      }
      if (opt.modules) {
        opt.modules.forEach(function (pathToFile) {
          thePath = partUrlPathTo(userId, opt.app_name, pathToFile)
          scriptFiles = scriptFiles + '<script src="' + thePath + '" type="module"></script>'
        })
      }
      if (opt.full_path_scripts) {
        opt.full_path_scripts.forEach(function (pathToFile) {
          scriptFiles = scriptFiles + '<script src="' + pathToFile + '" type="text/javascript"></script>'
        })
      }
      if (opt.full_path_modules) {
        opt.full_path_modules.forEach(function (pathToFile) {
          scriptFiles = scriptFiles + '<script src="' + pathToFile + '" type="module"></script>'
        })
      }
      contents = contents.replace('{{SCRIPT_FILES}}', scriptFiles)

      // other_variables used by system only
      contents = contents.replace('{{OTHER_VARIABLES}}', opt.other_variables ? opt.other_variables : 'null')

      // to do - to make messages better
      contents = contents.replace('{{MESSAGES}}', JSON.stringify(opt.messages))
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(contents)
    }
  )
}
exports.load_page_xml = function (req, res, opt) {
  fdlog('load page xml', opt.app_name + '... ' + opt.page_url)
  fs.readFile(
    'freezr_xml_skeleton_public.xml',
    function (err, contents) {
      if (err) {
        felog('load_page_xml', 'err reading file ', err)
        helpers.warning('file_handler', exports.version, 'load_page_xml', 'got err reading freezr_xml_skeleton_public ')
        helpers.send_failure(res, 500, err)
        return
      }
      contents = contents.toString('utf8')
      contents = contents.replace('{{XML_CONTENT}}', opt.page_xml ? opt.page_xml : '')

      // res.writeHead(200, { "Content-Type": "text/html" });
      res.type('application/xml')
      res.end(contents)
    }
  )
}

/* NEW NEW 2020 / 2021 */
exports.appFileListFromZip = function (zipfile) {
  fdlog('appFileListFromZip ')
  const AdmZip = require('./forked_modules/adm-zip/adm-zip.js')

  try {
    const zip = new AdmZip(zipfile)
    const zipEntries = zip.getEntries() // an array of ZipEntry records
    const fileList = []
    zipEntries.forEach(function (zipEntry) {
      if (!zipEntry.isDirectory && !helpers.startsWith(zipEntry.entryName, '__MACOSX')) {
        fileList.push(zipEntry.entryName)
      }
    })
    return [null, fileList]
  } catch (e) {
    felog('appFileListFromZip ', e)
    return [e]
  }
}
exports.extractNextFile = function (params, callback) {
  /* params:
      file: req.file.buffer,
      name: req.file.originalname,
      appFS,
      freezrUserAppListDB: req.freezrUserAppListDB,
      fileUrl: req.body.app_url,
      versionDate: new Date().getTime(),
      init: true
      // appRecord: [record from freezrUserAppListDB]
      // params.filesRemaining = fileList
  */
  const fileList = [...params.filesRemaining]
  var AdmZip = require('./forked_modules/adm-zip/adm-zip.js')

  try {
    const zip = new AdmZip(params.file)
    const zipEntries = zip.getEntries() // an array of ZipEntry records
    let gotDirectoryWithAppName = null

    zipEntries.forEach(function (zipEntry) {
      // This is for case of compressing a zip file which includes a root folder with the app names
      if (!gotDirectoryWithAppName && zipEntry.isDirectory && helpers.startsWith(zipEntry.entryName, params.appFS.appName) && zipEntry.entryName.indexOf('/') > 1) gotDirectoryWithAppName = zipEntry.entryName.slice(0, zipEntry.entryName.indexOf('/' + 1))
      if (!gotDirectoryWithAppName && zipEntry.isDirectory && zipEntry.entryName === params.name + '/') { gotDirectoryWithAppName = params.name + '/' }
    })

    let foundEntry = null
    let fileListIndex = -1

    let count = zipEntries.length - 1
    while (!foundEntry && count >= 0) {
      fileListIndex = fileList.indexOf(zipEntries[count].entryName)
      if (fileListIndex > -1) {
        foundEntry = zipEntries[count]
        fileList.splice(fileListIndex, 1)
      } else {
        count--
      }
    }

    let dowrite = true
    if (!foundEntry) dowrite = false

    var fileName = foundEntry ? foundEntry.entryName.toString() : null

    if (fileName && helpers.endsWith(fileName, '/')) {
      dowrite = false
    } else if (fileName) {
      const parts = fileName.split('/')
      if (helpers.startsWith(parts[parts.length - 1], '.')) {
        dowrite = false
      }
    }
    if (dowrite) {
      if (gotDirectoryWithAppName && helpers.startsWith(fileName, gotDirectoryWithAppName)) {
        fileName = fileName.substring(gotDirectoryWithAppName.length + 1)
      } else if (gotDirectoryWithAppName) {
        dowrite = false
      } // else { fileName = fileName; }
    }

    if (dowrite) {
      const content = foundEntry.getData()
      // fqkereq = {file: {buffer: content} }
      params.appFS.writeToAppFiles(fileName, content, { doNotOverWrite: false }, function (err) {
        if (err) {
          felog('extractNextFile', 'Error writing file ' + fileName + ' to cloud', err)
          callback(err, params.filesRemaining)
        } else {
          callback(null, fileList)
        }
      })
    } else {
      callback(null, fileList)
    }
  } catch (e) {
    felog('extractNextFile ', e)
    callback(helpers.invalid_data('extractNextFile: error extracting from zip file ' + JSON.stringify(e), 'file_handler', exports.version, 'extractNextFile'), fileList)
  }
}
exports.extractZipToLocalFolder = function (zipfile, partialPath, appName, callback) {
  fdlog('extractZipToLocalFolder ' + partialPath)
  var AdmZip = require('./forked_modules/adm-zip/adm-zip.js')

  try {
    const zip = new AdmZip(zipfile) // "zipfilesOfAppsInstalled/"+app_name);
    if (!partialPath) throw new Error('cannot zip to root directory')
    // nb - also partialPath needs to start with FREEZR_USER_FILES_DIR or userfolder

    const fullPath = fullLocalPathTo(partialPath)
    fdlog('extractZipToLocalFolder', { partialPath, fullPath })

    localCheckExistsOrCreateUserFolder(partialPath, function () {
      const zipEntries = zip.getEntries() // an array of ZipEntry records

      zipEntries.forEach(function (zipEntry) {
        if (!zipEntry.isDirectory && !helpers.startsWith(zipEntry.entryName, '__MACOSX')) {
          let targetpath = zipEntry.entryName
          if (helpers.startsWith(zipEntry.entryName, '/')) targetpath = targetpath.slice(1)
          if (helpers.startsWith(zipEntry.entryName, appName)) targetpath = targetpath.slice(targetpath.indexOf('/') + 1)
          // fdlog("zipEntry.entryName: "+zipEntry.entryName+ " targetpath: "+targetpath)
          targetpath = targetpath.lastIndexOf('/') > 0 ? ('/' + targetpath.slice(0, targetpath.lastIndexOf('/'))) : ''
          zip.extractEntryTo(zipEntry.entryName, (fullPath + targetpath), false, true)
        }
      })
      callback(null)
    })
  } catch (e) {
    felog('extractZipToLocalFolder ', e)
    callback(helpers.invalid_data('extractZippedFilesToLocalFolder: error extracting from zip file ' + JSON.stringify(e), 'file_handler', exports.version, 'extractZippedAppFiles'))
  }
}
const fullLocalPathTo = function (partialPath) {
  if (partialPath) {
    return path.normalize(systemPath() + path.sep + exports.removeStartAndEndSlashes(partialPath))
  } else {
    return systemPath()
  }
}
exports.fullLocalPathTo = fullLocalPathTo
var systemPath = function () {
  //
  return path.normalize(__dirname.replace(path.sep + 'freezr_system', ''))
}
exports.deleteLocalFolderAndContents = function (partialPath, callback) {
  const fullPath = fullLocalPathTo(partialPath)
  if (!fs.existsSync(fullPath)) {
    return callback(null)
  } else {
    return deleteLocalFolderAndContents(fullPath, callback)
  }
}
var deleteLocalFolderAndContents = function (location, next) {
  // http://stackoverflow.com/questions/18052762/in-node-js-how-to-remove-the-directory-which-is-not-empty
  fs.readdir(location, function (err, files) {
    if (err) {
      return next(err)
    } else {
      async.forEach(files, function (file, cb) {
        file = location + path.sep + file
        fs.stat(file, function (err, stat) {
          if (err) {
            return cb(err)
          }
          if (stat.isDirectory()) {
            deleteLocalFolderAndContents(file, cb)
          } else {
            fs.unlink(file, function (err) {
              if (err) {
                return cb(err)
              }
              return cb()
            })
          }
        })
      }, function (err) {
        if (err) return next(err)
        fs.rmdir(location, function (err) {
          return next(err)
        })
      })
    }
  })
}
exports.getLocalManifest = function (partialPath, callback) {
  fdlog('getLocalManifest ', partialPath)
  const fullPathToManifestFile = fullLocalPathTo(partialPath) + path.sep + helpers.APP_MANIFEST_FILE_NAME
  if (!fs.existsSync(fullPathToManifestFile)) {
    fdlog('No app config at ' + partialPath)
    callback(null, null)
  } else {
    fs.readFile(fullPathToManifestFile, function (err, manifest) {
      if (err) {
        callback(helpers.error('file_handler.js', exports.version, 'getLocalManifest', 'Error reading manifest file for ' + partialPath + ': ' + JSON.stringify(err)))
      } else {
        try {
          manifest = json.parse(manifest, null, true)
        } catch (e) {
          felog('async_manifest', 'could not parse app config at ' + partialPath)
          err = helpers.manifest_error(exports.version, 'file_handler:async_manifest', partialPath, partialPath + ' manifest could not be parsed - parsing requires app config to have double quotes in keys.')
        }
        callback(err, manifest)
      }
    })
  }
}
exports.getLocalSystemAppFileContent = function (partialPath, callback) {
  fdlog('getLocalSystemAppFileContent ', partialPath)
  const fullPathToFile = fullLocalPathTo(partialPath)
  if (!fs.existsSync(fullPathToFile)) {
    // fdlog('No file at ' + partialPath)
    callback(null, null)
  } else {
    fs.readFile(fullPathToFile, callback)
  }
}
exports.renameLocalFileOrFolder = function (oldPartialPath, newpartialPath, callback) {
  const currPath = fullLocalPathTo(oldPartialPath)
  const newPath = fullLocalPathTo(newpartialPath)
  fs.rename(currPath, newPath, function (err) {
    callback(err)
  })
}

exports.mkdirp = mkdirp
exports.dirFromFile = function (filePath) {
  var dir = filePath.split('/')
  dir.pop()
  return dir.join('/')
}
exports.removeCloudAppFolder = function (appFS, callback) {
  // console.log - think through - should this really be in ds_manager?
  const appPath = (appFS.fsParams.rootFolder || helpers.FREEZR_USER_FILES_DIR) + '/' + appFS.owner + '/apps/' + appFS.appName
  async.waterfall([
    function (cb) {
      appFS.fs.removeFolder(appPath, cb)
    },
    function (cb) {
      appFS.fs.mkdirp(appPath, cb)
    }],
  function (err) { callback(err) })
}

exports.extractZipAndReplaceToCloudFolder = function (zipfile, originalname, appFS, callback) {
  // console.log - think through - should this really be in ds_manager?
  const appPath = (appFS.fsParams.rootFolder || helpers.FREEZR_USER_FILES_DIR) + '/' + appFS.owner + '/apps/' + appFS.appName
  async.waterfall([
    function (cb) {
      appFS.fs.removeFolder(appPath, cb)
    },
    function (cb) {
      appFS.fs.mkdirp(appPath, cb)
    },
    function (ret, cb) {
      exports.extractZipToCloudFolder(zipfile, originalname, appFS, cb)
    }],
  callback)
}
exports.extractZipToCloudFolder = function (zipfile, originalname, appFS, callback) {
  // fdlog('2020-10 todo see if this can be replaced with fn to copy files from local one by one')
  var AdmZip = require('./forked_modules/adm-zip/adm-zip.js')
  var zip = new AdmZip(zipfile) // 'zipfilesOfAppsInstalled/' + app_name)
  var zipEntries = zip.getEntries() // an array of ZipEntry records
  var gotDirectoryWithAppName = null

  fdlog('extractZipToCloudFolder  ', originalname)

  zipEntries.forEach(function (zipEntry) {
    // This is for case of compressing a zip file which includes a root folder with the app names
    if (!gotDirectoryWithAppName && zipEntry.isDirectory && helpers.startsWith(zipEntry.entryName, appFS.appName) && zipEntry.entryName.indexOf('/') > 1) gotDirectoryWithAppName = zipEntry.entryName.slice(0, zipEntry.entryName.indexOf('/' + 1))
    if (!gotDirectoryWithAppName && zipEntry.isDirectory && zipEntry.entryName === originalname + '/') { gotDirectoryWithAppName = originalname + '/' }
  })
  // fdlog('env.extractZippedAppFiles ' + appFS.appName + ' gotDirectoryWithAppName ' + gotDirectoryWithAppName)

  var callFwd = function (fileName, isDirectory, content, overwrite, callfwdback) {
    var dowrite = true
    if (helpers.endsWith(fileName, '/')) {
      dowrite = false
    } else {
      const parts = fileName.split('/')
      if (helpers.startsWith(parts[parts.length - 1], '.')) {
        dowrite = false
      }
    }
    if (dowrite) {
      if (gotDirectoryWithAppName && helpers.startsWith(fileName, gotDirectoryWithAppName)) {
        fileName = fileName.substring(gotDirectoryWithAppName.length + 1)
      } else if (gotDirectoryWithAppName) {
        dowrite = false
      } // else { fileName = fileName; }
    }
    if (dowrite) {
      // fqkereq = {file: {buffer: content} }
      appFS.writeToAppFiles(fileName, content, { doNotOverWrite: false }, function (err) {
        if (err) felog('extractZipToCloudFolder', 'Error writing file ' + fileName + ' to cloud', err)
        callfwdback()
      })
    } else {
      callfwdback()
    }
  }

  zip.extractAllToAsyncWithCallFwd(callFwd, true, function (err) {
    if (err) {
      felog('extractZipToCloudFolder -> zip.extractAllToAsyncWithCallFwd', 'got err extracting files in zip.extractAllToAsyncWithCallFwd', err)
      callback(err)
      /* // to do later - error check this..
    } else if (useAppFileFSCache()){
      try {
              var zip = new AdmZip(zipfile); //"zipfilesOfAppsInstalled/"+app_name);
          var partialUrl = (add userRootFolder if need be ||) FREEZR_USER_FILES_DIR +path.sep+app_name;
                var FSCache_app_path = systemPathTo(partialUrl);

              if (gotDirectoryWithAppName) {
                  zip.extractEntryTo(app_name + "/", FSCache_app_path, false, true);
              } else {
                  zip.extractAllTo(FSCache_app_path, true);
              }
              callback(null);
          } catch ( e ) {
            helpers.warning("file_env_dropbox", exports.version, "extractZippedAppFiles", "Error extracting to FSCache"+e )
              callback(null);
          }
          */
    } else {
      callback(null)
    }
  })
}

exports.checkManifest = function (manifest, appName, appVersion, flags) {
  // fdlog('checkManifest ' + appName + ' :' + JSON.stringify(manifest))
  // todo - check permissions and structure of app config
  //  needs to be made more sophisticated and may be in file_sensor)

  if (!flags) flags = new Flags({ app_name: appName, didwhat: 'reviewed' })
  if (!manifest) {
    flags.add('warnings', 'manifest_missing')
  } else {
    if (manifest.version && appVersion && appVersion !== manifest.version) {
      flags.add('notes', 'manifest_inconsistent_version')
    }
    if (manifest.identifier && appName !== manifest.identifier) {
      flags.add('notes', 'config_inconsistent_app_name', { app_name: manifest.identifier })
    }

    if (manifest.pages) {
      for (var page in manifest.pages) {
        if (Object.prototype.hasOwnProperty.call(manifest.pages, page)) {
          if (exports.fileExt(manifest.pages[page].html_file) !== 'html') flags.add('warnings', 'config_file_bad_ext', { ext: 'html', filename: manifest.pages[page].html_file })
          if (manifest.pages[page].css_files) {
            if (typeof manifest.pages[page].css_files === 'string') manifest.pages[page].css_files = [manifest.pages[page].css_files]
            manifest.pages[page].css_files.forEach(
              function (oneFile) {
                if (exports.fileExt(oneFile) !== 'css') flags.add('warnings', 'config_file_bad_ext', { ext: 'css', filename: oneFile })
              }
            )
          }
          if (manifest.pages[page].script_files) {
            if (typeof manifest.pages[page].script_files === 'string') manifest.pages[page].script_files = [manifest.pages[page].script_files]
            manifest.pages[page].script_files.forEach(
              function (oneFile) {
                if (exports.fileExt(oneFile) !== 'js') {
                  flags.add('warnings', 'config_file_bad_ext', { ext: 'js', filename: oneFile })
                }
              })
          }
        }
      }
    }
  }
  return flags
}
exports.getEnvParamsFromLocalFileSystem = function () {
  let envOnFile = null
  try {
    envOnFile = require(fullLocalPathTo(helpers.FREEZR_USER_FILES_DIR + '/fradmin/files/info.freezr.admin/freezr_environment.js'))
  } catch (e) {
    felog('getEnvParamsFromLocalFileSystem', 'file exists ? ' + fs.existsSync(fullLocalPathTo(helpers.FREEZR_USER_FILES_DIR + '/fradmin/files/info.freezr.admin/freezr_environment.js')), 'could not find an environment file locally. ' + fullLocalPathTo(helpers.FREEZR_USER_FILES_DIR + '/fradmin/files/info.freezr.admin/freezr_environment.js'))
    // felog(' to do - differentiate bewtween corrupt file and non existant one')
  }
  if (envOnFile && envOnFile.params) return envOnFile.params
  return null
}

// General Utilities
exports.fileExt = function (fileName) {
  if (typeof fileName !== 'string') return null
  let ext = path.extname(fileName)
  if (ext && ext.length > 0) ext = ext.slice(1)
  return ext
}
exports.sep = function () { return path.sep }
exports.normUrl = function (aUrl) { return path.normalize(aUrl) }
exports.removeStartAndEndSlashes = function (aUrl) {
  if (helpers.startsWith(aUrl, '/')) aUrl = aUrl.slice(1)
  if (aUrl.slice(aUrl.length - 1) === '/') aUrl = aUrl.slice(0, aUrl.length - 1)
  return aUrl
}
exports.valid_path_extension = function (aPath) {
  const parts = aPath.split(path.sep)
  if (!aPath) return true
  for (var i = 0; i < parts.length; i++) {
    if (!helpers.valid_dir_name(parts[i])) return false
  }
  return true
}
exports.systemPathTo = function (partialUrl) {
  if (partialUrl) {
    return path.normalize(systemPath() + path.sep + exports.removeStartAndEndSlashes(partialUrl))
  } else {
    return systemPath()
  }
}
const partUrlPathTo = function (userId, appName, fileName) {
  // fdlog('partUrlPathTo app ' + appName + ' file ' + fileName + ' user:' + userId)
  if (helpers.startsWith(fileName, './')) return '/app_files' + (userId ? '/' + userId : '') + fileName.slice(1)
  return '/app_files/' + (userId ? (userId + '/') : 'public/') + appName + (fileName ? '/' + fileName : '')
}
const localCheckExistsOrCreateUserFolder = function (aPath, callback) {
  // from https://gist.github.com/danherbert-epam/3960169
  // fdlog('localCheckExistsOrCreateUserFolder checking ' + aPath)
  var pathSep = path.sep
  var dirs = path.normalize(aPath).split(path.sep)

  // if (freezr_environment && freezr_environment.fsParams && freezr_environment.fsParams.userRoot) dirs.unshift(freezr_environment.fsParams.userRoot)
  // fdlog(' need to deal with userroot scenario')

  var root = ''

  mkDir()

  function mkDir () {
    var dir = dirs.shift()
    if (dir === '') { // If directory starts with a /, the first path will be th root user folder.
      root = systemPath() + pathSep
    }

    if (fs.existsSync(root + dir)) {
      root += dir + pathSep
      if (dirs.length > 0) {
        mkDir()
      } else if (callback) {
        callback()
      }
    } else {
      fs.mkdir(root + dir, function (err) {
        root += dir + pathSep
        if (err) {
          callback(err)
        } else if (dirs.length > 0) {
          mkDir()
        } else if (callback) {
          callback()
        }
      })
    }
  }
}

// Loggers
const LOG_ERRORS = true
const felog = function (...args) { if (LOG_ERRORS) helpers.warning('file_handler.js', exports.version, ...args) }
const LOG_DEBUGS = false
const fdlog = function (...args) { if (LOG_DEBUGS) console.log(...args) }
