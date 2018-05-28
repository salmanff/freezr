var hello="hello there";
var retrieve_COUNT = 50;
var dl = {  'meta': { 'user':null,
					'app_name':null,
					'date':new Date().getTime(),
					'source':"allmydata_view",
					'all_collection_names': [],
					'num_collections_retrieved':0,
					'retrieved_all':false,
					'app_config': null
					},
		  	'current_collection':{
			  	'num':0,		  	
			  	'rowsShown':0,
			  	'name':null,
				'fields':[
				  		//{'name':xxx, 'cellLen':xxx, type':null}
				 ]
			},
		 	'collections': []
		 		// {'name':  xxx , 'data': [], 'retrieved_all':false}
	}

freezr.initPageScripts = function() {
	document.getElementById('app_name').innerHTML= freezr_app_name;
	document.getElementById('freezr_user_id').innerHTML= freezr_user_id;
	document.getElementById("toptitle").onclick = function() {window.open("/apps/"+freezr_app_name,"_self");}
	document.getElementById("gotoBackUp").onclick = function() {window.open("/allmydata/backup/"+freezr_app_name,"_self");}
	document.getElementById("saveData").onclick = function () {saveData();}
	document.getElementById("retrieve_more").onclick = function() {retrieve_more();}
	document.getElementById("collection_names").onchange = function() {change_collection();}

	dl.meta.app_name=freezr_app_name;
	dl.meta.user=freezr_user_id;

	freezr.utils.getConfig(function(configReturn) {
		if (configReturn.error ) {
			showWarning("Error connecting to server");
		} else {
			configReturn = freezr.utils.parse(configReturn);
			console.log(configReturn);
			dl.meta.all_collection_names = configReturn.collection_names;
			dl.meta.app_config = configReturn.app_config;
			dl.meta.num_collections_retrieved = 0;
			dl.collections=[];
			if (dl.meta.all_collection_names && dl.meta.all_collection_names.length>0) {
				var coll_list = document.getElementById("collection_names");
				coll_list.innerHTML="";
				var collNum =0;
				dl.meta.all_collection_names.forEach(function (aColl) {
					coll_list.innerHTML+="<option value='"+(collNum++)+"'>"+aColl+"</option>";
				})
				getCollectionData();
			} else {
				showWarning("No data collections in this app");
				document.getElementById('retrieve_more').style.display = "none";
				document.getElementById('collection_area').style.display = "none";
				document.getElementById('collection_sheet').style.display = "none";
				document.getElementById('saveData').style.display = "none";

			}
		}
	});
}
var getCollectionData = function () {
	//onsole.log("to get next coll "+dl.meta.num_collections_retrieved+"-"+dl.meta.all_collection_names.length+" "+JSON.stringify(dl.meta));
	if (dl.meta.num_collections_retrieved < dl.meta.all_collection_names.length) {
		freezr.db.query(
			{ collection:dl.meta.all_collection_names[dl.meta.num_collections_retrieved], count:retrieve_COUNT , skip:0 },
			  gotCollectionData)
	} else {
		showCollectionData();
	}
};
var gotCollectionData = function (returnJson) {
	//onsole.log("gotCollectionData "+JSON.stringify(returnJson));
	returnJson = freezr.utils.parse(returnJson);
	var retrieved_all = (returnJson.results.length<retrieve_COUNT);
	dl.collections.push( {'name':dl.meta.all_collection_names[dl.meta.num_collections_retrieved], 'data':returnJson.results, 'retrieved_all':retrieved_all });
	dl.meta.num_collections_retrieved++;
	getCollectionData();
}
var showCollectionData = function(collection_num) {
	if (!collection_num || collection_num==null ) {collection_num = dl.current_collection.num} else {dl.current_collection.num=collection_num};
	dl.current_collection.name = dl.collections[collection_num].name;

	dl.current_collection.rowsShown=0;

	dl.current_collection.fields = {
		'_id':{'cellLen':40},
		'_date_Created':{'cellLen':50, 'type':'date'},
		'_date_Modified':{'cellLen':50, 'type':'date'},
	}


	var dataSet = dl.collections[collection_num].data;
	dataSet.forEach(function(dataRow) {
		for (var key in dataRow ) {
			if (dataRow.hasOwnProperty(key) && key!="_creator") {
				if (!dl.current_collection.fields[key]) {
					dl.current_collection.fields[key]= {'cellLen':10};
					if (dl.meta.app_config && dl.meta.app_config.collections && dl.meta.app_config.collections[dl.collections[collection_num].name] && dl.meta.app_config.collections[dl.collections[collection_num].name].field_names && dl.meta.app_config.collections[dl.collections[collection_num].name].field_names[key] && dl.meta.app_config.collections[dl.collections[collection_num].name].field_names && dl.meta.app_config.collections[dl.collections[collection_num].name].field_names[key].type  ) {
						dl.current_collection.fields[key].type = dl.meta.app_config.collections[dl.collections[collection_num].name].field_names[key].type+"";
					}
				}
				var maxLen =  dl.current_collection.fields[key].type=="date"? 70 : ( dataRow [key]?  (((dataRow [key].length)>100)? 300: ((dataRow [key].length)>40? 200: ( (dataRow [key].length)>10? 100: 50  )   )  ) : 50 );
				dl.current_collection.fields[key].cellLen = Math.max(dl.current_collection.fields[key].cellLen, maxLen);
			}
		}
	});


	var tempText = '<div class="div-table-row headrow">';
	var totalWidth = 0;
	for (var key in dl.current_collection.fields) {
		if (dl.current_collection.fields.hasOwnProperty(key)) {
			var newKey = key+"";
			if (key=="_id") newKey ="id";
			if (key=="_date_Created") newKey ="Created";
			if (key=="_date_Modified") newKey ="Modified";
			tempText+= "<div class='div-table-col headcell' style='width:"+  dl.current_collection.fields[key].cellLen +"px'>"+newKey+"</div>";
			totalWidth+=dl.current_collection.fields[key].cellLen+10; 
		}
	} 
	tempText+="</div>"

	document.getElementById("collection_sheet").style.width = totalWidth+"px";
	document.getElementById("retrieve_more").style.width = Math.min(totalWidth,window.innerWidth)+"px";
	document.getElementById("collection_sheet").innerHTML=tempText;

	insertnextElements();
}

var insertnextElements = function() {
	//onsole.log("insert next"+dl.collections[dl.current_collection.num].data.length);
	if (dl.current_collection.rowsShown<dl.collections[dl.current_collection.num].data.length) {
		var tempText = "";
		var dataRow = dl.collections[dl.current_collection.num].data[dl.current_collection.rowsShown];
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
		insertnextElements();
	} else {
		document.getElementById("retrieve_more").style.display = (dl.collections[dl.current_collection.num].retrieved_all)? "none":"block";
	}
}

// Chaning Collections and Getting More Data
var change_collection = function() {
	showCollectionData(document.getElementById("collection_names").value);
}
var retrieve_more = function() {
	freezr.db.query({ collection:dl.current_collection.name, count:retrieve_COUNT , skip:(dl.collections[dl.current_collection.num].data.length) }, gotMoreData)	
}
var gotMoreData = function(returnJson) {
	returnJson = freezr.utils.parse(returnJson);
	var retrieved_all = (returnJson.results.length<retrieve_COUNT);
	dl.collections[dl.current_collection.num].retrieved_all = retrieved_all;
	dl.collections[dl.current_collection.num].data = dl.collections[dl.current_collection.num].data.concat(returnJson.results);
	document.getElementById("retrieve_more").style.display = (dl.collections[dl.current_collection.num].retrieved_all)? "none":"block";
	insertnextElements();
}

// Save Data
var saveData = function() {
	if (confirm("Download All Data to this device?")){
		// codepen.io/davidelrizzo/pen/cxsGb
		var text = JSON.stringify(dl);
 		var filename = "freezr data download "+freezr_app_name+" for "+freezr_user_id+" "+(new Date().getTime())+".json";
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
