// account_resource_usage.js

/* global freezr */

let fullAppList

function getUrlUser () {
  const params = new URLSearchParams(typeof location !== 'undefined' && location.search || '')
  return params.get('user') || null
}

function showSpinner (container) {
  if (!container) return
  const wrap = document.createElement('div')
  wrap.className = 'freezr-spinner-overlay'
  wrap.setAttribute('data-resource-spinner', '1')
  const spinner = document.createElement('div')
  spinner.className = 'freezr-spinner'
  wrap.appendChild(spinner)
  container.appendChild(wrap)
}

function removeSpinner (container) {
  if (!container) return
  const el = container.querySelector('[data-resource-spinner="1"]')
  if (el) el.remove()
}

freezr.initPageScripts = async function () {
  const appListDiv = document.getElementById('app_list')
  const userLabelEl = document.getElementById('resource_usage_user_label')
  if (!appListDiv) {
    console.error('[resourceusage] app_list element not found')
    return
  }

  const targetUser = getUrlUser()
  if (targetUser && userLabelEl) {
    userLabelEl.style.display = 'block'
    userLabelEl.textContent = 'Viewing resources for: ' + targetUser
  }

  showSpinner(appListDiv)
  try {
    const useageData = targetUser
      ? await freezr.apiRequest('GET', '/adminapi/getuserappresources?user=' + encodeURIComponent(targetUser))
      : await freezr.utils.getAppResourceUsage(null)
    removeSpinner(appListDiv)
    if (useageData && useageData.resources && useageData.resources.length > 0) {
      appListDiv.appendChild(makeEl('h3', null, ('Total size: ' + showSize(useageData.totalSize))))
      appListDiv.appendChild(makeEl('br'))
      const gridContainer = makeDiv({ display: 'grid', 'grid-template-columns': '250px 80px 80px 280px 80px', padding: '10px', 'row-gap': '5px' })
      gridContainer.appendChild(makeEl('h4', { width: '250px', 'text-decoration': 'underline' }, 'App name        '))
      gridContainer.appendChild(makeEl('h4', { width: '80px', 'text-decoration': 'underline', 'text-align': 'right' }, 'App Size'))
      gridContainer.appendChild(makeEl('h4', { width: '80px', 'text-decoration': 'underline', 'text-align': 'right' }, 'Files'))
      gridContainer.appendChild(makeEl('h4', { width: '280px', 'text-decoration': 'underline', 'text-align': 'right' }, 'Databases'))
      gridContainer.appendChild(makeEl('h4', { width: '80px', 'text-decoration': 'underline', 'text-align': 'right' }, 'Total*'))

      useageData.resources.forEach(resource => {
        let localTotal = 0
        gridContainer.appendChild(makeEl('h4', { 'align-items': 'start', display: 'contents' }, resource.appName))
        gridContainer.appendChild(makeDiv({ 'text-align': 'right' }, showSize(resource.apps)))
        gridContainer.appendChild(makeDiv({ 'text-align': 'right' }, showSize(resource.files)))
        localTotal += (getNum(resource.apps) + getNum(resource.files))
        const dbDiv = makeDiv({ 'text-align': 'right' })
        for (const [dbName, size] of Object.entries(resource.dbs || {})) {
          dbDiv.appendChild(makeDiv(null, (dbName + ': ' + showSize(size))))
          localTotal += getNum(size)
        }
        gridContainer.appendChild(dbDiv)
        gridContainer.appendChild(makeDiv({ 'text-align': 'right' }, showSize(localTotal)))
      })
      appListDiv.appendChild(gridContainer)
      appListDiv.appendChild(makeEl('br'))
      appListDiv.appendChild(makeDiv(null, ' Last Updated on ' + new Date(useageData.time).toLocaleString()))
      appListDiv.appendChild(makeDiv(null, ' * Tables may appear in multiple apps'))
    } else {
      appListDiv.innerHTML = targetUser
        ? 'No app resources found for this user.'
        : 'It doesnt look like you have any apps installed so you are not using any resources yet.'
    }
  } catch (error) {
    removeSpinner(appListDiv)
    console.error('[resourceusage] getAppResourceUsage error', error)
    appListDiv.innerHTML = 'There are errors capturing resource size data.'
  }
}
const makeDiv = function (styles, innerText) { return makeEl('div', styles, innerText) }
const makeEl = function (type, styles, innerText) {
  const theEl = document.createElement(type)
  if (styles) {
    for (const [key, value] of Object.entries(styles)) {
      theEl.style[key] = value
    }
  }
  if (innerText) theEl.innerHTML = innerText
  return theEl
}
const showSize = function (bytes) {
  if (!bytes) return '0'
  if (isNaN(bytes)) return bytes
  if (bytes >= 1000000) return ((Math.round(bytes / 10000) / 100).toLocaleString() + 'Mbs')
  if (bytes >= 1000) return ((Math.round(bytes / 100) / 10).toLocaleString() + 'kbs')
  return bytes.toLocaleString() + 'b'
}
const getNum = function (bytes) {
  if (!bytes) return 0
  if (isNaN(bytes)) return 0
  return bytes
}
