//admin visitsummary v0.0.1

/*
 Note quirks to be fixed: Currently searching for days based on date_Modified. This could result in 6 or 8 days being returned, instead of 7. Best to change to search based on dateString
*/

var allLogs = {}, 
    allDatesList = [],
    shownData = {
      last_date: new Date(),
    },
    detailShown = {};

const MAX_COLS = 7;

freezr.initPageScripts = function() {
  document.addEventListener('click', function (evt) {
    if(evt.target.id=="prev_week") {
      shownData.last_date= new Date (shownData.last_date-(MAX_COLS*24*60*60*1000)); 
      runQuery();
    }
    if(evt.target.id=="next_week") {
      shownData.last_date = new Date(shownData.last_date.setDate(shownData.last_date.getDate() + MAX_COLS)); 
      runQuery();
    }
    if (startsWith(evt.target.id,"showdetail")) {
      let wotToDo = (evt.target.className == "detailHidden")? "table-row":"none";
      let splits = evt.target.id.split("_")
      let rowToShowHide = "row_"+splits[1]+"_"+splits[2]+(splits.length>3?("_"+splits[3]):"");
      detailShown[rowToShowHide] = (evt.target.className == "detailHidden")?true:false;
      let els = document.getElementsByClassName(rowToShowHide);
      Array.prototype.forEach.call(els, function(anEl) {
         anEl.style.display=wotToDo
      })
      evt.target.className = (evt.target.className == "detailHidden"? "detailShown":"detailHidden")
    }
  });
  shownData.last_date = new Date();
  runQuery();
}

var runQuery = function(options) {
  allLogs = {}; allDatesList=[];
  options = options || {};
  options.app_name = 'info.freezr.admin';
  options.collection = 'visit_log_daysum';
  options.query_params = options.query_params || {};
  options.query_params = {$and: [{'_date_Modified':{$lt:(shownData.last_date.getTime())}},{'_date_Modified':{$gt:(shownData.last_date.getTime()-(MAX_COLS*24*60*60*1000))}}]}
  options.sort ={'_date_Modified': -1}
  options.count=MAX_COLS;
  freezr.db.query(options, function(ret){
    //onsole.log(ret);
    ret = JSON.parse(ret)
    ret.results.forEach((anItem) => {
      allLogs[anItem._id] = anItem;  
      allDatesList = addToListAsUnique(allDatesList, anItem._id);
    })
    allDatesList.sort().reverse()
    showTable();
  })
}


let mainCellOptions = {showNullAsDash:true, ignoreEmptyRows:true, cellClass:'midnum', titleClass:'rowtitle'};
var showTable = function(headers) {
  var theTable = document.getElementById('mainTable');
  if (allDatesList.length==0) {
    theTable.innerHTML="No data available for "+MAX_COLS+" days ending "+shownData.last_date.toDateString()+"."
  } else {
    theTable.innerHTML="";
    headers = headers || allDatesList.slice(0,10)
  
    let theThead = makeEl('thead', null, theTable)
      let theRow   = makeEl('tr', null, theThead)
        makeEl('th',null, theRow)
        headers.forEach((aHeader) => {makeEl('th',formattedDate(aHeader),theRow, 'dateHeader')})
  
    let theBody = makeEl('tbody' , null, theTable)
      
    makeRow(theBody, 'Logged In Users',null,headers, {showNullAsDash:false, ignoreEmptyRows:false, titleClass:'bigtitle'})
    makeRow(theBody, ' Page Views',['logged_in','numAppPageViews'],headers, mainCellOptions)
    makeRow(theBody, ' admin Account',['logged_in','numpubadmin'],headers, mainCellOptions)
  
    makeRow(theBody, ' Database Reads',['logged_in','numDbReads'],headers, mainCellOptions)
    makeRow(theBody, ' Database Writes',['logged_in','numdbWrites'],headers, mainCellOptions)
    makeRow(theBody, ' Account Changes',['logged_in','numAcctChges'],headers, mainCellOptions)
    makeRow(theBody, ' Unauthorized',['logged_in','numUnauthzed'],headers, mainCellOptions)
    makeRow(theBody, ' Redirects',['logged_in','numredirect'],headers, mainCellOptions)
    makeRow(theBody, ' File Uploads',['logged_in','numFileUpload'],headers, mainCellOptions)
    makeRow(theBody, ' Public Page Views',['logged_in','numppage'],headers, mainCellOptions)
    makeRow(theBody, ' Public Page Cards',['logged_in','numpcard'],headers, mainCellOptions)
    
    drawList('users', 'Users', 'logged_in', theBody, headers);
    drawList('apps', 'Applications', 'logged_in', theBody, headers);
    drawList('visitIps', 'IPs (logged in)', 'logged_in', theBody, headers);
    drawList('pages', 'Pages', 'logged_in', theBody, headers);
    drawList('someUnauthUrls', 'Unauthorized URLs', 'logged_in', theBody, headers);
    drawList('pageRefs', 'Page references', 'logged_in', theBody, headers);
  
    makeRow(theBody, 'Anonymous / Public Visits',null,headers, {showNullAsDash:false, ignoreEmptyRows:false, titleClass:'bigtitle'})
    makeRow(theBody, ' Public Page Views',['anon','numppage'],headers, mainCellOptions)
    makeRow(theBody, ' Page Views',['anon','numAppPageViews'],headers, mainCellOptions)
    makeRow(theBody, ' Public Page Cards',['anon','numpcard'],headers, mainCellOptions)
    makeRow(theBody, ' Database Reads',['anon','numDbReads'],headers, mainCellOptions)
    makeRow(theBody, ' Public Database Reads',['anon','numpdb'],headers, mainCellOptions)
    makeRow(theBody, ' Unauthorized',['anon','numUnauthzed'],headers, mainCellOptions)
    makeRow(theBody, ' Redirects',['anon','numredirect'],headers, mainCellOptions)
  
    drawList('visitIps', 'IPs (public)', 'anon', theBody, headers);
    drawList('apps', 'Applications', 'anon', theBody, headers);
    drawList('pages', 'Pages', 'anon', theBody, headers);
    drawList('someUnauthUrls', 'Unauthorized URLs', 'anon', theBody, headers);
    drawList('pageRefs', 'page references', 'anon', theBody, headers);

  }

}

// TO DRAW TABLE
var makeEl = function(type, text, parent, theClass) {
  let theEl = document.createElement(type);
  if (text) theEl.innerHTML = text;
  if (parent) parent.appendChild(theEl);
  if (theClass) theEl.className = theClass;
  return theEl;
}
var makeRow = function(parent, title,keys, headers, options) {
  let gotAVal = false;
  let theRow = makeEl('tr', null,null, options.trClass);
  makeEl('td',title,theRow, options.titleClass);
  headers.forEach((aHeader) => {
    let theVal = valueInJSON(allLogs[aHeader],keys );
    if (theVal) {gotAVal = true;} else if (options.showNullAsDash) {theVal = "-";}
    makeEl('td',theVal,theRow, options.cellClass)
  })
  if (parent && (gotAVal || !options.ignoreEmptyRows)) parent.appendChild(theRow)
  return (gotAVal || !options.ignoreEmptyRows)? theRow:null;
}
var valueInJSON = function(obj, keys) {
  if (!obj || !keys) return null;
  let lastKey = keys[0]
  if (keys.length==1) return obj[lastKey];
  return valueInJSON(obj[lastKey], keys.slice(1) )
}
var drawList = function(listKey, title, user_type, parent, headers){
  let rowname = 'row_'+listKey+'_'+user_type;
  let showClass = detailShown[rowname]? "detailShown" :"detailHidden"
  let titleRow = makeRow(parent, title+'<span class= "'+showClass+'" id="showdetail_'+listKey+'_'+user_type+'"> details</span>',null,headers, {showNullAsDash:false, ignoreEmptyRows:false, titleClass:'listTitle'})
  let keyList = [], keyCount ={};
  headers.forEach((aHeader) => {
    if (allLogs[aHeader] && allLogs[aHeader][user_type]&& allLogs[aHeader][user_type][listKey]){
      Object.keys(allLogs[aHeader][user_type][listKey]).forEach(aKey => {
        //onsole.log(aHeader,user_type,listKey, aKey, allLogs[aHeader][user_type][listKey][aKey], allLogs[aHeader][user_type][listKey])
        keyList = addToListAsUnique(keyList,aKey);
        keyCount[aKey] = keyCount[aKey]? (keyCount[aKey]+(allLogs[aHeader][user_type][listKey][aKey] || 0)) : (allLogs[aHeader][user_type][listKey][aKey] || 0);
      })
    }
  })
  var keyListSorter = function (key1, key2) {return ((keyCount[key2]||0) - (keyCount[key1]||0))}
  keyList.sort(keyListSorter)
  exists = false
  keyList.forEach((aKey) => {
    exists = true;
    let theRow = makeRow(parent, aKey,[user_type,listKey,aKey],headers, mainCellOptions);
    theRow.className = rowname;
    theRow.style.display= detailShown[rowname]? "table-row":"none";
  })
  if (!exists) titleRow.style.display="none"
}


// Other and generic 
var showError = function(errorText) {
  var errorBox=document.getElementById("errorBox");
  errorBox.innerHTML= errorText;
}
var dateString = function (time) {
  var date = time? new Date(time) : new Date()
  return date.toISOString().split('T')[0]
}
var formattedDate = function (dateString) {
  let aDate = dateFromString(dateString)
  return aDate.toDateString()
}
var dateFromString = function(dateString) {
  let parts = dateString.split("-")
  return new Date((parts[1]+" "+parts[2]+" "+parts[0]))
}
var addToListAsUnique = function(aList,anItem) {
  if (!aList) {
    return [anItem]
  } else if (!anItem) {
    return aList 
  } else  if (aList.indexOf(anItem) < 0) {
    aList.push(anItem);
  } 
  return aList
}
var startsWith = function(longertext, checktext) {
  if (!longertext || !checktext || !(typeof longertext === 'string')|| !(typeof checktext === 'string')) {return false} else 
  if (checktext.length > longertext.length) {return false} else {
  return (checktext == longertext.slice(0,checktext.length));}
}


