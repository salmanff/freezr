// addsystemextension.js
// allows admin users to add system extension
/* global freezerRestricted, freezr */

freezr.initPageScripts = function () {
  const uploadArea = document.getElementById('upload_area')
  if (uploadArea) {
    uploadArea.ondragenter = handleDragEnter
    uploadArea.ondragover = handleDragOver
    uploadArea.ondragleave = handleDragLeave
    uploadArea.ondrop = handleDrop
  }
  document.getElementById('deleteExtension').onclick = function () {
    const extensionName = document.getElementById('extensionName').innerText
    console.log('deleting', { extensionName })
    if (!extensionName) {
      showError('Please enter a service name')
    } else {
      freezr.feps.systemExtensions({ task: 'deleteextension', system_extension_name: extensionName }, function (error, returndata) {
        if (error || returndata.error) {
          console.warn({ error, returndata })
          showError((error ? error.message : returndata.error))
        } else {
          showError('Service deleted successfully.')
        }
      })
    }
  }
}
// Hanlding dropped files
//  credit to https://www.smashingmagazine.com/2018/01/drag-drop-file-uploader-vanilla-js/ and https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API/File_drag_and_drop
const handleDragEnter = function (e) {
  preventDefaults(e)
  highlight(e)
}
const handleDragOver = function (e) {
  preventDefaults(e)
  highlight(e)
}
const handleDragLeave = function (e) {
  preventDefaults(e)
  unhighlight(e)
}
const handleDrop = function (e) {
  preventDefaults(e)
  unhighlight(e)
  const items = e.dataTransfer.items
  // let files = dt.files
  // const dropId = targetDropArea(e).id

  const extFromFileName = function (fileName) {
    return fileName.split('.').pop()
  }

  const file = (items && items.length > 0) ? items[0].getAsFile() : ''
  const ext = extFromFileName(file.name)

  const parts = file.name.split('.')
  parts.splice(parts.length - 1, 1)
  let extensionName = parts.join('.')
  extensionName = extensionName.split(' ')[0]

  if (!items || !file) {
    showError('Please Choose a file first.')
  } else if (items.length > 1) {
    showError('Please upload one zip file only.')
  } else if (ext !== 'zip') {
    showError('The app file uploaded must be a zipped file. (File name represents the service name.)')
  } else {
    const uploadData = new FormData()
    uploadData.append('file', file)
    uploadData.append('system_extension_name', extensionName)
    const url = '/feps/systemextensions/upsertextension'

    freezerRestricted.connect.send(url, uploadData, function (error, returndata) {
      if (error || returndata.error) {
        console.warn({ error, returndata })
        showError((error ? error.message : returndata.error))
      } else {
        showError('Service uploaded successfully. Need to also install after upsert')
      }
    }, 'PUT', null, { uploadFile: true })
  }
}

const preventDefaults = function (e) {
  e.preventDefault()
  e.stopPropagation()
}
const highlight = function (e) {
  targetDropArea(e).classList.add('highlight')
}
const unhighlight = function (e) {
  targetDropArea(e).classList.remove('highlight')
}
const targetDropArea = function (e) {
  let target = e.target
  if (!target.className.includes('drop-area')) {
    target = target.parentElement
  }
  if (!target.className.includes('drop-area')) console.log('akkkhhh - should iterate')
  return target
}

let timer = null
const showError = function (errorText) {
  clearTimeout(timer)
  const errorBox = document.getElementById('errorBox')
  errorBox.style['font-size'] = '24px'
  errorBox.innerHTML = errorText || ' &nbsp '
  if (errorText) {
    timer = setTimeout(function () {
      showError()
    }, 5000)
  }
}