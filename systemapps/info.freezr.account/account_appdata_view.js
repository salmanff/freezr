
var retrieve_COUNT = 50;
var dl = {  'meta': { 'user':null,
					'app_name':null,
					'date':new Date().getTime(),
					'source':"appdata_view",
					'all_collection_names': [],
					'num_app_tables_retrieved':0,
					'retrieved_all':false,
					'manifest': null
					},
		  	'current_collection':{
			  	'num':0,
					'retrieved':0,
					'retrieved_all':false,
			  	'rowsShown':0,
			  	'name':null,
				'fields':[
				  		//{'name':xxx, 'cellLen':xxx, type':null}
				 ]
			},
		 	'app_tables': []
		 		// {'name':  xxx , 'data': [], 'retrieved_all':false}
	}

freezr.initPageScripts = function() {
	document.getElementById('app_name').innerHTML= app_name;
	document.getElementById('freezr_user_id').innerHTML= freezrMeta.userId;
	document.getElementById("toptitle").onclick = function() {window.open("/apps/"+app_name,"_self");}
	document.getElementById("gotoBackUp").onclick = function() { window.open("/account/appdata/"+app_name+"/backup","_self");}
	document.getElementById("saveData").onclick = function () {saveData();}
	document.getElementById("getCollectionData").onclick = function() {getCollectionData();}
	document.getElementById("retrieve_more").onclick = function() {retrieve_more();}
	document.getElementById("collection_names").onchange = function() {change_collection();}

	dl.meta.app_name=app_name;
	dl.meta.user=freezrMeta.userId;

	freezr.utils.getManifest(app_name, function(error, configReturn) {
		if (error || configReturn.error ) {
			showWarning("Error connecting to server");
		} else {
			console.log("got app config ",configReturn)
			dl.meta.manifest = configReturn.manifest;
			dl.meta.app_tables = configReturn.app_tables;
			dl.meta.current_collection_num = 0
			dl.meta.num_points_retrieved = 0;
			if (dl.meta.app_tables && dl.meta.app_tables.length>0) {
				var coll_list = document.getElementById("collection_names");
				coll_list.innerHTML="";
				var collNum =0;
				dl.meta.app_tables.forEach(function (aColl) {
					coll_list.innerHTML+="<option value='"+(collNum++)+"'>"+aColl+"</option>";
				})
			} else {
				showWarning("No data app_tables in this app");
				document.getElementById('retrieve_more').style.display = "none";
				document.getElementById('collection_area').style.display = "none";
				document.getElementById('collection_sheet').style.display = "none";
				document.getElementById('saveData').style.display = "none";

			}
		}
	});
}
// Chaning app_tables and Getting More Data
var change_collection = function() {
	dl.current_collection = {
		'num':document.getElementById("collection_names").value,
		'retrieved':0,
		'retrieved_all':false,
		'rowsShown':0,
		'name':null,
	}
}
var getCollectionData = function () {
	document.getElementById('table_wrap').style.display="block"
	//onsole.log("to get next coll "+dl.current_collection.num+"-"+dl.meta.app_tables.length+" "+JSON.stringify(dl.meta));
		freezr.feps.postquery(
			{appName:app_name, app_table:dl.meta.app_tables[dl.current_collection.num], count:retrieve_COUNT , skip:dl.current_collection.retrieved },
			  gotCollectionData)
};
var gotCollectionData = function (error, returnJson) {
	//onsole.log("gotCollectionData ",returnJson);
	returnJson = freezr.utils.parse(returnJson);
	if (!Array.isArray(returnJson) && returnJson.results) {returnJson = returnJson.results} // case of admin query
	dl.current_collection.retrieved+=returnJson.length
	dl.current_collection.retrieved_all = (returnJson && returnJson.length<retrieve_COUNT);
	//dl.app_tables.push( {'name':dl.meta.app_tables[dl.meta.current_collection_num], 'data':returnJson, 'retrieved_all':retrieved_all });
	//dl.meta.num_app_tables_retrieved++;
  if (error) console.warn(error) // console.log('need to handle error')
  showCollectionData(returnJson)
	//getCollectionData();
}

var retrieve_more = getCollectionData;
/*
var retrieve_more = function() {
	freezr.db.query({ collection:dl.current_collection.name, count:retrieve_COUNT , skip:(dl.app_tables[dl.current_collection.num].data.length) }, gotMoreData)
}
var gotMoreData = function(returnJson) {
	returnJson = freezr.utils.parse(returnJson);
	var retrieved_all = (returnJson.results.length<retrieve_COUNT);
	dl.app_tables[dl.current_collection.num].retrieved_all = retrieved_all;
	dl.app_tables[dl.current_collection.num].data = dl.app_tables[dl.current_collection.num].data.concat(returnJson.results);
	document.getElementById("retrieve_more").style.display = (dl.app_tables[dl.current_collection.num].retrieved_all)? "none":"block";
	insertnextElements();
}
*/

var showCollectionData = function(dataSet) {
	dl.current_collection.name = dl.meta.app_tables[dl.current_collection.num];
	dl.current_collection.rowsShown=0;

	const collection_name = dl.meta.app_tables[dl.current_collection.num];

	dl.current_collection.fields = {
		'_id':{'cellLen':40},
		'_date_created':{'cellLen':50, 'type':'date'},
		'_date_modified':{'cellLen':50, 'type':'date'},
	}

	if (dataSet && dataSet.length>0){
		dataSet.forEach(function(dataRow) {
			for (var key in dataRow ) {
				if (dataRow.hasOwnProperty(key) && key!="_owner") {
					if (!dl.current_collection.fields[key]) {
						dl.current_collection.fields[key]= {'cellLen':10};
						if (dl.meta.manifest && dl.meta.manifest.app_tables && dl.meta.manifest.app_tables[collection_name] && dl.meta.manifest.app_tables[collection_name].field_names && dl.meta.manifest.app_tables[collection_name].field_names[key] && dl.meta.manifest.app_tables[collection_name].field_names && dl.meta.manifest.app_tables[collection_name].field_names[key].type  ) {
							dl.current_collection.fields[key].type = dl.meta.manifest.app_tables[collection_name].field_names[key].type+"";
						}
					}
					var maxLen =  dl.current_collection.fields[key].type=="date"? 70 : ( dataRow [key]?  (((dataRow [key].length)>100)? 300: ((dataRow [key].length)>40? 200: ( (dataRow [key].length)>10? 100: 50  )   )  ) : 50 );
					dl.current_collection.fields[key].cellLen = Math.max(dl.current_collection.fields[key].cellLen, maxLen);
				}
			}
		});
	}


	var tempText = '<div class="div-table-row headrow">';
	var totalWidth = 0;
	for (var key in dl.current_collection.fields) {
		if (dl.current_collection.fields.hasOwnProperty(key)) {
			var newKey = key+"";
			if (key=="_id") newKey ="id";
			if (key=="_date_created") newKey ="Created";
			if (key=="_date_modified") newKey ="Modified";
			tempText+= "<div class='div-table-col headcell' style='width:"+  dl.current_collection.fields[key].cellLen +"px'>"+newKey+"</div>";
			totalWidth+=dl.current_collection.fields[key].cellLen+10;
		}
	}
	tempText+="</div>"

	document.getElementById("collection_sheet").style.width = totalWidth+"px";
	document.getElementById("retrieve_more").style.width = Math.min(totalWidth,window.innerWidth)+"px";
	document.getElementById("collection_sheet").innerHTML=tempText;

	//onsole.log("insert next"+dl.app_tables[dl.current_collection.num].data.length);
	dataSet.forEach(dataRow => {
		var tempText = "";
		for (var key in dl.current_collection.fields ) {
			if (dl.current_collection.fields.hasOwnProperty(key)) {
				var cellContent = dataRow[key]?  (dl.current_collection.fields[key].type=="date"?freezr.utils.longDateFormat(  dataRow[key]) : JSON.stringify(dataRow[key])) : " - ";
				tempText+= "<div class='div-table-col' style='width:"+ dl.current_collection.fields[key].cellLen+"px' >"+(cellContent)+"</div>"
			}
		}
		tempText +="<div class='lineDiv'> </div>"
		var rowEl = document.createElement("div");
		rowEl.className = "div-table-row";
		rowEl.innerHTML = tempText;
		document.getElementById("collection_sheet").appendChild(rowEl);
		dl.current_collection.rowsShown++;
	})
	document.getElementById("retrieve_more").style.display = (dl.current_collection.retrieved_all)? "none":"block";
}




// Save Data
var saveData = function() {
	if (confirm("Download All Data to this device?")){
		// codepen.io/davidelrizzo/pen/cxsGb
		var text = JSON.stringify(dl);
 		var filename = "freezr data download "+app_name+" for "+freezrMeta.userId+" "+(new Date().getTime())+".json";
		var blob = new Blob([text], {type: "text/plain;charset=utf-8"});
  		saveAs(blob, filename);
	};
}


// Generics
var showWarning = function(msg) {
	// null msg clears the message
	if (!msg) {
		document.getElementById("warnings").innerHTML="";
	} else {
		var newText = document.getElementById("warnings").innerHTML;
		if (newText && newText!=" ") newText+="<br/>";
		newText += msg;
		document.getElementById("warnings").innerHTML= newText;
	}
}
