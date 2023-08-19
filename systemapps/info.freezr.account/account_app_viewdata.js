// app dataview
/*
- do pagination
-> do retrieve for backup
-> create restore data page

// decide later on sort_by dropdown, choose data points menu, editableTableView, add SEARCH - do card view\

*/
/* global targetApp, freezr, freepr, freezrMeta, freezerRestricted, Blob */

import { createObjectDiv } from '../info.freezr.public/public/modules/drawJson.js'
import { saveAs } from './FileSaver.js'

const VIEW_RETRIEVE_COUNT = 50
const BACKUP_RETRIEVE_COUNT = 500
const FILE_SIZE_MAX = 2000000

const dl = {
  meta: {
    user: null,
    app_name: null,
    date: new Date().getTime(),
    source: 'app_viewdata',
    all_collection_names: [],
    num_app_tables_retrieved: 0,
    retrievedAll: false,
    manifest: null
  },
  current_collection: {
    name: null,
    retrieved: 0,
    retrievedAll: false,
    rowsShown: 0,
    fields: [
      // {'name':xxx, 'cellLen':xxx, type':null}
    ]
  },
  app_tables: [],
  saved_coll: {	
    name: '',
    first_retrieved_date: null,
    last_retrieved_date: null,
    data: [],
    part: 1,
    retrieved_all: false
  }
}

freezr.initPageScripts = function () {
  document.getElementById('app_name').innerHTML = targetApp
  document.getElementById('appSettings').href = '/account/app/settings/' + targetApp

  document.getElementById('collection_names').onchange = click.changeCollection
  const buttonNames = ['getCollectionData', 'backUpData']
  buttonNames.forEach(name => {
    document.getElementById(name).onclick = click[name]
  })

  dl.meta.app_name = targetApp
  dl.meta.user = freezrMeta.userId

  freezr.utils.getManifest(targetApp, function (error, configReturn) {
    console.log('got manifest ', { error, configReturn })
    freezr.testdl = dl
    if (error || configReturn.error) {
      console.warn({ error })
      showError('Error connecting to server')
    } else {
      dl.meta.manifest = configReturn.manifest
      dl.meta.app_tables = configReturn.app_tables
      dl.meta.current_collection_num = 0
      dl.meta.num_points_retrieved = 0
      if (dl.meta.app_tables && dl.meta.app_tables.length > 0) {
        const tableList = document.getElementById('collection_names')
        tableList.innerHTML = ''
        dl.meta.app_tables.forEach(function (aColl) {
          tableList.innerHTML += "<option value='" + aColl + "'>" + aColl + '</option>'
        })
      } else {
        showError('No data app_tables in this app')
        const els = ['collectionChoice', 'collection_sheet']
        els.forEach(el => { document.getElementById(el).style.display = 'none' })
      }
    }
  })
}

const click = {
  changeCollection: async function () {
    dl.current_collection = {
      name: document.getElementById('collection_names').value,
      retrieved: 0,
      retrievedAll: false,
      rowsShown: 0
    }
    await click.getCollectionData()
  },
  getCollectionData: async function () {
    document.getElementById('loading').style.display = 'block'

    const gotData = await freepr.feps.postquery({
      appName: targetApp,
      app_table: document.getElementById('collection_names').value,
      count: VIEW_RETRIEVE_COUNT,
      skip: dl.current_collection.retrieved
    })
    console.log({ gotData })
    document.getElementById('loading').style.display = 'none'
    showError()
    if (!Array.isArray(gotData) || !gotData || gotData.length === 0) {
      showError('No data could be retrieded')
      return
    }
    document.getElementById('getCollectionData').style.display = 'none'
    document.getElementById('backUpData').style.display = 'block'
    document.getElementById('moreAndPages').style.display = 'block'

    dl.current_collection.retrieved += gotData.length
    dl.current_collection.retrievedAll = (gotData && gotData.length < VIEW_RETRIEVE_COUNT)
    if (!dl.current_collection.records) dl.current_collection.records = []
    dl.current_collection.records = dl.current_collection.records.concat(gotData)
    if (!dl.current_collection.name) dl.current_collection.name = document.getElementById('collection_names').value // for when only one collection exists and refresh doesnt trigger
    const coll = dl.current_collection.name.slice(dl.meta.app_name.length + 1)
    dl.current_collection.collmanifest = dl.meta?.manifest?.app_tables ? dl.meta?.manifest?.app_tables[coll] : null
    // onsole.log({ dl })

    const nextPage = Math.ceil((dl.current_collection.retrieved) / VIEW_RETRIEVE_COUNT)
    showPage(nextPage)
  },
  backUpData: function () {
    document.getElementById('headerChooser').style.display = 'none'
    document.getElementById('moreAndPages').style.display = 'none'
    document.getElementById('all_data').innerHTML = ''
    dl.saved_coll.name = dl.current_collection.name
    delete dl.current_collection

    document.getElementById('backup_status').innerHTML = ''
    const header = document.createElement('h1')
    header.innerHTML = 'Backing Up to file: ' + dl.saved_coll.name
    document.getElementById('backup_status').appendChild(header)

    dl.saved_coll.first_retrieved_date = new Date().getTime()
    dl.saved_coll.last_retrieved_date = new Date().getTime()
    dl.saved_coll.part = 1
    dl.saved_coll.retrieved_all = false
    dl.saved_coll.data = []
    retrieveDataForBackUp()
  }
}

const showPage = function (pageNum) {
  dl.current_collection.pageNum = pageNum
  const rowsShownStarting = ((pageNum - 1) * VIEW_RETRIEVE_COUNT)
  const { retrievedAll, retrieved } = dl.current_collection
  const totalPages = Math.ceil(retrieved / VIEW_RETRIEVE_COUNT)

  const dataDiv = document.getElementById('all_data')
  dataDiv.innerHTML = ''

  // onsole.log({ pageNum, rowsShownStarting, totalPages, dl })
  for (let i = rowsShownStarting; i < Math.min(rowsShownStarting + VIEW_RETRIEVE_COUNT, dl.current_collection.records.length); i++) {
    const record = dl.current_collection.records[i]
    dataDiv.appendChild(createObjectDiv(record, { isTopLevel: true, editable: true, appTableManifest: dl.current_collection.collmanifest, updateRecord }))
  }
  
  // createNextPagePrevPageDiv()
  const pageNumsDiv = document.getElementById('moreAndPages')
  pageNumsDiv.innerHTML = ''
  pageNumsDiv.innerHTML = 'Showing page ' + pageNum + ' of ' + (retrievedAll ? totalPages : 'many') + '.  ' + (totalPages > 1 ? 'Go to page: ' : ' ')
  if (totalPages > 1) {
    for (let i = 1; i <= totalPages; i++) {
      if (i !== pageNum) {
        const onePageSpan = document.createElement('span')
        onePageSpan.style['margin-right'] = '5px'
        onePageSpan.style.color = 'blue'
        onePageSpan.style.cursor = 'pointer'
        onePageSpan.innerText = ' ' + i
        onePageSpan.onclick = function (e) { showPage(i) }
        pageNumsDiv.appendChild(onePageSpan)
      }
    }
  }
  if (!retrievedAll) {
    const more = document.createElement('div')
    more.style.color = 'blue'
    more.style.display = 'inline-block'
    more.style.cursor = 'pointer'
    more.onclick = click.getCollectionData
    more.innerText = 'Fetch more'
    more.style['margin-left'] = '10px'
    pageNumsDiv.appendChild(more)
  }
}
const updateRecord = function (record, cb) {
  const options = {
    app_table: dl.current_collection.name,
    app_name: dl.meta.app_name,
    KeepUpdateIds: true,
    updateRecord: true,
    data_object_id: record._id
  }
  delete record._id

  const url = '/feps/restore/' + dl.current_collection.name
  freezerRestricted.connect.send(url, { record, options }, function (err, ret) {
    cb(err, ret)
  }, 'POST', 'application/json')
}

// DATA BACK UP  => follows click.backUpData
const retrieveDataForBackUp = function () {
  const queryOptions = {
    appName: dl.meta.app_name,
    app_table: dl.saved_coll.name,
    count: BACKUP_RETRIEVE_COUNT,
    q: { _date_modified: { $lt: dl.saved_coll.last_retrieved_date } }
  }
  freezr.feps.postquery(queryOptions, gotData)
}
const gotData = function (error, returnJson) {
  if (!Array.isArray(returnJson) && returnJson.results) {
    returnJson = returnJson.results
  } // case of admin query

  if (!returnJson || error) {
    showError('Error - could not retrieve data')
  } else if (!returnJson || returnJson.length === 0) {
    if (dl.saved_coll.data.length === 0) {
      showError()
      showError('No data found in that table')
      addStatus('Refresh page to try again')
    } else {
      endRetrieve()
    }
  } else {
    dl.saved_coll.retrieved_all = (returnJson.length < BACKUP_RETRIEVE_COUNT)
    dl.saved_coll.last_retrieved_date = getMinDate(returnJson, dl.saved_coll.last_retrieved_date)
    dl.saved_coll.data = dl.saved_coll.data.concat(returnJson)
    addStatus('got ' + returnJson.length + ' records for a total of ' + dl.saved_coll.data.length)

    if (dl.saved_coll.retrieved_all || JSON.stringify(dl.saved_coll.data).length > FILE_SIZE_MAX) {
      const fileName = saveDataToFile()
      const lastDate = new Date(dl.saved_coll.last_retrieved_date);
      const firstDate = new Date(dl.saved_coll.first_retrieved_date);
      addStatus('Created file: "' + fileName + '"  for data from ' + lastDate.toLocaleDateString() + ' ' + lastDate.toLocaleTimeString() + ' to ' + firstDate.toLocaleDateString() + ' ' + firstDate.toLocaleTimeString() + '.')
      dl.saved_coll.first_retrieved_date = dl.saved_coll.last_retrieved_date
      dl.saved_coll.part++
      dl.saved_coll.data = []
    }
    if (!dl.saved_coll.retrieved_all) {
      retrieveDataForBackUp()
    } else {
      endRetrieve()
    }
  }
}
const endRetrieve = function() {
  showError('Back Up complete. ')
  addStatus('Retrieved all data. Refresh page to do another backup.')
}
// Save Data
const saveDataToFile = function() {
  // codepen.io/davidelrizzo/pen/cxsGb
  const text = JSON.stringify(dl)
  const filename = 'freezr data backup table ' + dl.saved_coll.name + ' for user ' + freezrMeta.userId + ' ' + new Date(dl.meta.date).toLocaleDateString() + ' part ' + dl.saved_coll.part + '.json'
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  saveAs(blob, filename)
  return filename
}

const getMinDate = function (list, themin) {
  if (!themin) themin = new Date().getTime()
  list.forEach(item => {
    themin = Math.min(themin, item._date_modified)
  })
  return themin
}
const addStatus = function (aText) {
  const backUpEl = document.getElementById('backup_status')
  backUpEl.innerHTML = backUpEl.innerHTML + '<br/>' + aText
}

const showError = function (msg) {
  const warnDiv = document.getElementById('warnings')
  warnDiv.innerHTML = ''
  if (msg) warnDiv.innerHTML = ('<br/>' + msg + '<br><br>')
}
