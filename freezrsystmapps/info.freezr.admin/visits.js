
// admin/prefs.js

/* global freezr, freepr, currentVisits */
import { dg } from '../public/info.freezr.public/public/modules/dgelements.js'

const state = {
  authFailureFetchLastmodDate: null,
  visitsFetchLastmodDate: null,
  // authFailures: [], // to add back if want to keep data for reformatting views
  visits: []
}

freezr.initPageScripts = function () {
  // Auth Failures
  const initialAuthList = []
  if (currentVisits.authFailure) {
    for (const [accessPt] of Object.entries(currentVisits.authFailure)) {
      initialAuthList.push({
        date: new Date().getTime(),
        accessPt,
        list: currentVisits.authFailure[accessPt].list || []
      })
    }
  }
  // state.authFailures.push(initialAuthList)
  createNewAuthSummaryDiv(initialAuthList, { current: true })

  // visits
  const initialVisitList = []
  if (currentVisits.loggedInUsers) {
    for (const [userId] of Object.entries(currentVisits.loggedInUsers)) {
      initialVisitList.push({
        date: new Date().getTime(),
        userId,
        pages: currentVisits.loggedInUsers[userId].pages || {},
        files: currentVisits.loggedInUsers[userId].files || {},
        apis: currentVisits.loggedInUsers[userId].apis || {},
        unknown: currentVisits.loggedInUsers[userId].unknown || {},
        paths: currentVisits.loggedInUsers[userId].paths || {}
      })
    }
  }
  // state.authFailures.push(initialAuthList)
  createNewVisitSummaryDiv(initialVisitList, { current: true })

  dg.el('getMoreAuth').onclick = getMoreAuthItems
  dg.el('getMoreVisits').onclick = getMoreVisitItems


}

const showHideSpan = function () {
  return dg.span({ onclick: showHideNextDiv, style: { color: 'blue', cursor: 'pointer' } }, 'Show Details')
}
const createNewAuthSummaryDiv = function (failureBatch, options) {
  const summaryDiv = dg.div({ style: { padding: '5px' } })
  const [accessPtList, totalFailureCount, oldestDate] = getGroupSummaryOfAuthFailures(failureBatch)
  if (totalFailureCount > 0) {
    summaryDiv.appendChild(dg.span('Since ' + new Date(oldestDate).toLocaleTimeString() + ' on ' + new Date(oldestDate).toLocaleDateString() + ', there have been ' + totalFailureCount + ' auth failures of ' + accessPtList.length + ' types. '))
    summaryDiv.appendChild(showHideSpan())
    const detailsDiv = dg.div({ style: { display: 'none' } })
    failureBatch.forEach(failItem => {
      const inner = dg.div()
      const sinceDate = failItem.list[0]?.date ? new Date(failItem.list[0].date).toLocaleTimeString() : 'uknown date'
      inner.appendChild(dg.span({ style: { 'margin-left': '10px' } }, 'AccessPt ' + failItem.accessPt + ': Since ' + sinceDate + ' on ' + sinceDate + ' - ' + failItem.list.length + ' failures.'))
      inner.appendChild(showHideSpan())
      const underLyingsDiv = dg.div({ style: { display: 'none' } })
      failItem.list.forEach(e => {
        underLyingsDiv.appendChild(dg.div({ style: { 'margin-left': '20px' } }, 'user: ' + e.userId + ' with issue: ' + e.source + ' from ip ' + e.ipaddress + ' at ' + new Date(e.date).toLocaleString()))
      })
      inner.appendChild(underLyingsDiv)
      detailsDiv.appendChild(inner)
    })
    summaryDiv.appendChild(detailsDiv)
  } else if (options && options.current) {
    summaryDiv.appendChild(dg.div('No recent summaries.'))
  } else {
    summaryDiv.appendChild(dg.div('No more summaries'))
    dg.el('getMoreAuth', { clear: true })
  }
  dg.el('authDetails').appendChild(summaryDiv)
}
const getGroupSummaryOfAuthFailures = function (failureList) {
  const accessPtList = []
  let totalFailureCount = 0
  const now = new Date().getTime()
  let oldestDate = now
  failureList.forEach(failRecord => {
    const [accessPt, count, batchOldest] = getAuthSummaryOf(failRecord)
    if (!(accessPt in accessPtList)) accessPtList.push(accessPt)
    oldestDate = Math.min(oldestDate, batchOldest)
    totalFailureCount += count
  })
  return [accessPtList, totalFailureCount, oldestDate]
}
const getAuthSummaryOf = function (failRecord) {
  const accessPt = failRecord.accessPt
  const count = (failRecord.list && failRecord.list.length > 0) ? failRecord.list.length : 0
  console.warn('faile record count is ', {count, failRecord})
  const oldest = (failRecord.list && failRecord.list.length > 0) ? failRecord.list[0].date : new Date().getTime()
  return [accessPt, count, oldest]
}

const showHideNextDiv = function (e) {
  const clickedDiv = e.target
  const detailsDiv = e.target.nextSibling
  const detalsAreHidden = (detailsDiv.style.display === 'none')
  if (detalsAreHidden) {
    detailsDiv.style.display = 'block'
    clickedDiv.innerText = 'Hide Details'
  } else {
    detailsDiv.style.display = 'none'
    clickedDiv.innerText = 'Show Details'
  }
}
const getMoreAuthItems = async function () {
  state.authFailureFetchLastmodDate = state.authFailureFetchLastmodDate || new Date().getTime()
  const failureBatch = await freepr.feps.postquery({ app_table: 'info.freezr.admin.visitAuthFailures', owner: 'fradmin', q: { _date_modified: { $lt: state.authFailureFetchLastmodDate } }, limit: 5 })
  failureBatch.forEach(failed => { state.authFailureFetchLastmodDate = Math.min(state.authFailureFetchLastmodDate, failed._date_modified) })
  // state.authFailures.push(failureBatch)
  createNewAuthSummaryDiv(failureBatch)
}
const getMoreVisitItems = async function () {
  state.visitsFetchLastmodDate = state.visitsFetchLastmodDate || new Date().getTime()
  const visitBatch = await freepr.feps.postquery({ app_table: 'info.freezr.admin.visitLogs', owner: 'fradmin', q: { _date_modified: { $lt: state.authFailureFetchLastmodDate } }, limit: 20 })
  visitBatch.forEach(visitStats => { state.visitsFetchLastmodDate = Math.min(state.visitsFetchLastmodDate, visitStats._date_modified) })
  // state.visits.push(visitBatch)
  createNewVisitSummaryDiv(visitBatch)
}

const createNewVisitSummaryDiv = function (visitBatch, options) {
  const summaryDiv = dg.div({ style: { padding: '5px' } })
  const [userIdList, totalPageVisitCount, allAppNames, totalPathCount, oldestDate] = getGroupSummaryOfuserVisits(visitBatch)
  // onsole.log({ userIdList, totalPageVisitCount, totalPathCount, allAppNames })
  if (totalPathCount > 0) {
    summaryDiv.appendChild(dg.span('Since ' + new Date(oldestDate).toLocaleTimeString() + ' on ' + new Date(oldestDate).toLocaleDateString() + ', there have been ' + totalPageVisitCount + ' pages visited on ' + allAppNames.length + ' apps by ' + userIdList.length + ' users. Total pings to server: ' + totalPathCount + ', '))
    summaryDiv.appendChild(showHideSpan())
    const detailsDiv = dg.div({ style: { display: 'none' } })
    visitBatch.forEach(userVisitRecord => {
      const [pageVisitCount, appList, pathCount, date] = getUserVisitSummaryOf(userVisitRecord)
      const inner = dg.div()
      inner.appendChild(dg.span({ style: { 'margin-left': '10px' } }, 'user ' + userVisitRecord.userId + ' visited ' + pageVisitCount + ' pages on ' + appList.length + ' apps - total count ' + pathCount + '. '))
      inner.appendChild(showHideSpan())
      const underLyingsDiv = dg.div({ style: { display: 'none' } })
      underLyingsDiv.appendChild(dg.div({ style: { 'margin-left': '20px' } }, 'Apps: ' + appList.join(', ') + '.'))
      inner.appendChild(underLyingsDiv)
      detailsDiv.appendChild(inner)
    })
    summaryDiv.appendChild(detailsDiv)
  } else if (options && options.current) {
    summaryDiv.appendChild(dg.div('No recent visits.'))
  } else {
    summaryDiv.appendChild(dg.div('No more visit records'))
    dg.el('getMoreVisits', { clear: true })
  }
  dg.el('visitDetails').appendChild(summaryDiv)
}
const getGroupSummaryOfuserVisits = function (visitBatch) {
  let userIdList = []
  let allAppNames = []
  let totalPageVisitCount = 0
  let totalPathCount = 0
  let oldestDate = new Date().getTime()
  visitBatch.forEach(userVisitRecord => {
    const [pageVisitCount, appList, pathCount, date] = getUserVisitSummaryOf(userVisitRecord)
    // onsole.log({ pageVisitCount, appList, pathCount, date })
    userIdList = addToListAsUnique(userIdList, userVisitRecord.userId)
    oldestDate = Math.min(oldestDate, date)
    appList.forEach(app => { allAppNames = addToListAsUnique(allAppNames, app) })
    totalPageVisitCount += pageVisitCount
    totalPathCount += pathCount
  })
  return [userIdList, totalPageVisitCount, allAppNames, totalPathCount, oldestDate]
}
const getUserVisitSummaryOf = function (userVisitRecord) {
  // onsole.log({ userVisitRecord })
  let pageVisitCount = 0
  let appNames = []
  if (userVisitRecord.pages) {
    for (const [appName, appCount] of Object.entries(userVisitRecord.pages)) {
      appNames = addToListAsUnique(appNames, appName)
      pageVisitCount += appCount
    }
  }
  if (userVisitRecord.apis) {
    for (const [appName] of Object.entries(userVisitRecord.apis)) {
      appNames = addToListAsUnique(appNames, appName)
    }
  }
  if (userVisitRecord.files) {
    for (const [appName] of Object.entries(userVisitRecord.files)) {
      appNames = addToListAsUnique(appNames, appName)
    }
  }
  let pathCount = 0
  if (userVisitRecord.paths) {
    for (const [path, count] of Object.entries(userVisitRecord.paths)) {
      if (path) pathCount += count
    }
  }
  return [pageVisitCount, appNames, pathCount, userVisitRecord.date]
}

// generics
const addToListAsUnique = function (aList, anItem) {
  if (!anItem) {
    return aList
  } else if (!aList) {
    return [anItem]
  } else if (aList.indexOf(anItem) < 0) {
    aList.push(anItem)
  }
  return aList
}
