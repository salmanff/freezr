// freezr accounts accpunt_app_restoredata.js
/*
To Do => access to Admin files and to public files

*/
/* global freezr, freezrMeta, freezerRestricted, confirm, FileReader, transformRecord */

import { createObjectDiv } from '../info.freezr.public/public/modules/drawJson.js'

freezr.initPageScripts = function () {
  const buttonNames = ['addAllRecords', 'addAllFiles', 'addRecord', 'skipRecord', 'uploadAndRestoreData']
  buttonNames.forEach(name => {
    document.getElementById(name).onclick = click[name]
  })
}

const uploader = {
  app_table: null,

  current_file_num: null,
  current_collection_num: null,
  current_record: null,
  records_uploaded: 0,
  records_updated: 0,
  records_erred: 0,
  file_content: null,
  ok_to_process_all_records: false,
  ok_to_process_all_files: false,
  override_difference: {
    app_name: false,
    user_name: false
  },
  options: { }
}

const click = {
  uploadAndRestoreData: function () {
    const files = document.getElementById('fileUploader').files
    if (!files || files.length === 0) {
      showWarning('Please choose a file to import')
    } else {
      // if (app_name=="info.freezr.permissions") {
      //   dl.password = prompt("Please enter your password")
      // }

      hideElments()
      uploader.current_file_num = -1
      processNextFile()
    }
  },
  addAllFiles: function () {
    uploader.ok_to_process_all_records = true
    uploader.ok_to_process_all_files = true
    processNextRecord()
  },
  addAllRecords: function () {
    uploader.ok_to_process_all_records = true
    processNextRecord()
  },
  addRecord: function () {
    processNextRecord()
  },
  skipRecord: function () {
    askToProcessNextRecord()
  }
}

const processNextFile = function () {
  const files = document.getElementById('fileUploader').files
  const file = files[++uploader.current_file_num]
  uploader.ok_to_process_all_records = uploader.ok_to_process_all_files

  if (file) {
    uploader.current_collection_num = 0
    uploader.current_record = -1

    var reader = new FileReader()
    reader.readAsText(file, 'UTF-8')
    reader.onload = function (evt) {
      uploader.file_content = JSON.parse(evt.target.result)
      let doUpload = true
      addStatus('Handling file: ' + file.name)
      if (!uploader.app_table) uploader.app_table = uploader.file_content.saved_coll.name
      if (uploader.app_table !== uploader.file_content.saved_coll.name && !uploader.override_difference.app_name) {
        showWarning('Download stopped - this file is related to another table')
        doUpload = false
      }
      if (freezrMeta.userId !== uploader.file_content.meta.user && !uploader.override_difference.user) {
        if (confirm('Data from the file "' + file.name + '" was from the user' + uploader.file_content.meta.user + ' but you are uploading it as user ' + freezrMeta.userId + '. Are you sure you want to proceed?')) {
          uploader.override_difference.user = true
        } else {
          doUpload = false
          showWarning('Restore operation interrupted.')
        }
      }
      if (doUpload) {
        askToProcessNextRecord()
      }
    }
    reader.onerror = function (evt) {
      addStatus('Could not read file: ' + file.name)
      showWarning('error reading file')
    }
  } else if (uploader.current_file_num > 0) {
    showWarning('Upload FInished')
  } else {
    showWarning('No files to upload')
  }
}

const askToProcessNextRecord = function () {
  uploader.current_record++
  if (transformRecord) {
    uploader.file_content.saved_coll.data[uploader.current_record] = transformRecord(uploader.file_content.saved_coll.data[uploader.current_record])
  }
  const thisRecord = uploader.file_content.saved_coll.data[uploader.current_record]

  if (uploader.ok_to_process_all_records) {
    processNextRecord()
  } else if (!thisRecord) {
    document.getElementById('err_nums').innerHTML = 'Errors uploading in total of ' + (++uploader.records_erred) + ' records.'
    addStatus('Error geting record - Missign data in record.<br/>')
    console.warn('err - missing data rec ', thisRecord, 'curr rec:', uploader.current_record, 'coll num:', uploader.current_collection_num, ' len ', uploader.file_content.saved_coll.data.length)
    processNextFile()
  } else {
    document.getElementById('check_record').style.display = 'block'
    document.getElementById('current_record').innerHTML = ''
    document.getElementById('current_record').appendChild(createObjectDiv(thisRecord, { isTopLevel: true, editable: true, appTableManifest: null }))
  }
}

const processNextRecord = function () {
  // process all records in file... then
  document.getElementById('check_record').style.display = 'none'
  document.getElementById('current_record').innerHTML = ''
  const record = uploader.file_content.saved_coll.data[uploader.current_record]
  if (record) {
    const appTable = uploader.file_content.saved_coll.name
    const options = {
      app_table: appTable,
      app_name: uploader.file_content.meta.app_name,
      // password: dl.password,
      updateRecord: true,
      data_object_id: record._id
    }
    delete record._id

    const url = '/feps/restore/' + appTable
    freezerRestricted.connect.send(url, JSON.stringify({ record, options }), restoreRecCallBack, 'POST', 'application/json')
  } else {
    processNextFile()
  }
}
const restoreRecCallBack = function (error, returnData) {
  returnData = freezr.utils.parse(returnData)
  if (error) {
    document.getElementById('err_nums').innerHTML = 'Errors uploading in total of ' + (++uploader.records_erred) + ' records.'
    addStatus('error uploading a record ' + error.message + ' - ' + ((returnData && returnData.message) ? returnData.message : 'unknown cause') + '.<br/>')
    console.warn('err uploading ', { error, returnData })
    uploader.current_record--
    uploader.ok_to_process_all_records = false
  } else {
    if (returnData.success) uploader.records_updated += 1
    document.getElementById('upload_nums').innerHTML = 'Total of ' + (++uploader.records_uploaded) + ' have been uploaded' + (uploader.records_updated ? (', of which ' + uploader.records_updated + ' were updates of existing records.') : '.')
  }
  askToProcessNextRecord()
}

// View Elements
const hideElments = function () {
  document.getElementById('uploadForm').style.display = 'none'
  document.getElementById('uploadAndRestoreData').style.display = 'none'
}
const addStatus = function (aText) {
  document.getElementById('backup_status').innerHTML = aText + '<br/>' + document.getElementById('backup_status').innerHTML
}

// Generics
const showWarning = function (msg) {
  // null msg clears the message
  if (!msg) {
    document.getElementById('warnings').innerHTML = ''
  } else {
    let newText = document.getElementById('warnings').innerHTML
    if (newText && newText !== ' ') newText += '<br/>'
    newText += msg
    document.getElementById('warnings').innerHTML = newText
  }
}
