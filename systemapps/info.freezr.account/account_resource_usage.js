// account_resource_usage.js

/* global freezr */

let fullAppList

freezr.initPageScripts = async function () {
  // freezr.utils.getAllAppList((error, appList) => {
  //   console.log({ error, appList })
  //   const errors = []
  //   const resourceData = []
  //   fullAppList = appList.user_apps.concat(appList.removed_apps)
  //   console.log({ fullAppList })
  //   fullAppList.forEach(appObj => {
  //     freezr.utils.getAppResourceUsage(appObj.app_name, (error, useageData) => {
  //       if (error) errors.push({ app: appObj.app_name, error })
  //       if (useageData) resourceData.push(useageData)
  //       console.log('ret from getting resources for ', appObj.app_name, { error, useageData })
  //     })
  //   })
  //   console.log({ errors, resourceData })
  // })
  freezr.utils.getAppResourceUsage(null, (error, useageData) => {
    // console.log('ret from getting all resources  ', { error, useageData })
    const appListDiv = document.getElementById('app_list')
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
        for (const [dbName, size] of Object.entries(resource.dbs)) {
          dbDiv.appendChild(makeDiv(null, (dbName + ': ' + showSize(size))))
          localTotal += getNum(size)
        }
        gridContainer.appendChild(dbDiv)
        gridContainer.appendChild(makeDiv({ 'text-align': 'right' }, showSize(localTotal)))
      })
      appListDiv.appendChild(gridContainer)
      appListDiv.appendChild(makeEl('br'))
      appListDiv.appendChild(makeDiv(null, ' * Tables may appear in multiple apps'))
    } else if (error) {
      appListDiv.innerHTML = 'There are errors capturing resource size data.'
    } else {
      appListDiv.innerHTML = 'It doesnt look like you have any apps installed so you are not using any resources yet.'
    }
  })
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
