// addlocalmicroservice.js
// allows admin users to add microservice
/* global freezr */

freezr.initPageScripts = async function () {
  const uploadArea = document.getElementById('upload_area')
  if (uploadArea) {
    uploadArea.ondragenter = handleDragEnter
    uploadArea.ondragover = handleDragOver
    uploadArea.ondragleave = handleDragLeave
    uploadArea.ondrop = handleDrop
  }

  const ret = await freezr.serverless.getAllLocalFunctions()
  console.log('getAllLocalFunctions ret', { ret })
  if (ret.localFunctions && ret.localFunctions.length > 0) {
    document.getElementById('deleteservicetitle').style.display = 'block'
    document.getElementById('deletelocalfunction').style.display = 'block'
    const thirdPartyFunctionNamesList = document.getElementById('thirdPartyFunctionNamesList')
    thirdPartyFunctionNamesList.innerHTML = `
      <label for="thirdPartyFunctionDropdown">Select a local service:</label>
      <select id="thirdPartyFunctionDropdown" name="thirdPartyFunctionDropdown">
        <option value="">-- Select a service --</option>
        ${ret.localFunctions.map(functionName => `
          <option value="${functionName}">${functionName}</option>
        `).join('')}
      </select>
    `
  }


  document.getElementById('deletelocalfunction').onclick = async function () {
    const thirdPartyFunctionName = document.getElementById('thirdPartyFunctionDropdown').value
    console.log('deleting', { thirdPartyFunctionName })
    if (!thirdPartyFunctionName) {
      showError('Please enter a service name')
    } else {
      try {
        const returndata = await freezr.serverless.deleteLocal({ thirdPartyFunctionName })
        if (returndata.error) {
          console.warn({ returndata })
          showError(returndata.error)
        } else {
          showError('Service deleted successfully.')
        }
      } catch (error) {
        console.warn({ error })
        showError(error.message)
      }
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
const handleDrop = async function (e) {
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
  let thirdPartyFunctionName = parts.join('.')
  thirdPartyFunctionName = thirdPartyFunctionName.split(' ')[0]

  if (!items || !file) {
    showError('Please Choose a file first.')
  } else if (items.length > 1) {
    showError('Please upload one zip file only.')
  } else if (ext !== 'zip') {
    showError('The app file uploaded must be a zipped file. (File name represents the service name.)')
  } else {
    try {
      const returndata = await freezr.serverless.upsertLocal({ file, thirdPartyFunctionName })
      if (returndata.error) {
        console.warn({ returndata })
        showError(returndata.error)
      } else {
        showError('Service uploaded successfully.')
      }
    } catch (error) {
      console.warn({ error })
      showError(error.message)
    }
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