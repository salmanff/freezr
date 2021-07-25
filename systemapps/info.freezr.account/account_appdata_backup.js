/*
freezr accounts accpunt_appdata_backup.js


This functionality page is incomplete.... Major clean up needed...

To add upload options:
	- backup all app_tables seuentially
	- set KeepUpdateIds to true : this is probably okay if redoing all data in a d-base but if records already exist, then it could run into problems as the record id may already be in use.
	- only add new: remove restoreRecord as asn option
	- add a rules for ignoring uploads: eg fj:deleted,true
	- only add new records

	'appdata_view': {
			page_title:"View all my data ",
			page_url: "account_appdata_view.html",
			css_files: ["account_appdata_view.css"],
			script_files: ["account_appdata_view.js","FileSaver.js"]
	},

*/

const retrieve_COUNT = 500;
const FILE_SIZE_MAX = 2000000;

var dl = {  // download file structure
			'meta': {
				'user':null,
				'app_name':null,
				'date':new Date().getTime(),
				'source':"appdata_backup",
				'all_app_tables': [],
				'manifest': null
			},
			'saved_coll':
				{	'name':"",
			  		'first_retrieved_date':null,
			  		'last_retrieved_date':null,
			  		'data':[],
						'part':1,
					'retrieved_all':false
				},
			password:null
		}

freezr.initPageScripts = function() {
	document.getElementById('app_name').innerHTML= app_name;
	document.getElementById('freezr_user_id').innerHTML= freezrMeta.userId;
	document.getElementById("backToApp").onclick = function() {window.open("/apps/"+app_name,"_self");}
	document.getElementById("freezrHome").onclick = function() {window.open("/","_self");}
	document.getElementById("addAllRecords").onclick = function() {addAllRecords()};
	document.getElementById("addAllFiles").onclick = function() {addAllFiles()};
	document.getElementById("addRecord").onclick = function() {addRecord()};
	document.getElementById("skipRecord").onclick = function() {skipRecord()};


	document.getElementById("getAndSaveData").onclick = function () {getAndSaveData();}
	document.getElementById("uploadAndRestoreData").onclick = function () {uploadAndRestoreData();}

	dl.meta.app_name=app_name;
	dl.meta.user=freezrMeta.userId;

	freezr.utils.getManifest(app_name, function(error, configReturn) {
		if (error || configReturn.error ) {
			showWarning("Error connecting to server - try later.");
			hideElments();
		} else {
			configReturn = freezr.utils.parse(configReturn);
      console.log({ configReturn })
			dl.meta.all_app_tables = configReturn.app_tables;
			dl.meta.manifest = configReturn.manifest;
			if (dl.meta.all_app_tables && dl.meta.all_app_tables.length>0) {
				var coll_list = document.getElementById("collection_names");
				coll_list.innerHTML="";
				var collNum =0;
				dl.meta.all_app_tables.forEach(function (aColl) {
					coll_list.innerHTML+="<option value='"+(collNum++)+"'>"+aColl+"</option>";
				})
			} else {
				showWarning("No data app_tables in this app");
				document.getElementById('getAndSaveData').style.display = "none";
			}
		}
	});
}

var getAndSaveData = function () {
	hideElments();
	showWarning("Retrieving data for BackUp.")
	dl.saved_coll.name = dl.meta.all_app_tables[document.getElementById("collection_names").value];
	document.getElementById("backup_status").innerHTML="<br/> Read these status updates from bottom to top.";
	addStatus("Getting collection: "+dl.saved_coll.name);
	dl.saved_coll.first_retrieved_date = new Date().getTime();
	dl.saved_coll.last_retrieved_date = new Date().getTime();
	dl.saved_coll.part=1;
	dl.saved_coll.retrieved_all=false;
	dl.saved_coll.data=[];
	retrieve_data();
}
var retrieve_data = function() {
	var queryOptions = {
		appName:app_name,
		app_table:dl.saved_coll.name,
		count:retrieve_COUNT,
		q: {'_date_modified':{'$lt':dl.saved_coll.last_retrieved_date}}
	}
  console.log({ queryOptions})
	freezr.feps.postquery(queryOptions, gotData)
}
var gotData = function(error, returnJson) {
	returnJson = freezr.utils.parse(returnJson);
	if (!Array.isArray(returnJson) && returnJson.results) {returnJson = returnJson.results} // case of admin query

	if (!returnJson || error) {
		showWarning("Error - could not retrieve data")
	} else if (!returnJson || returnJson.length==0) {
		if (dl.saved_coll.data.length==0) {showWarning(null); showWarning("No data found in that collection");addStatus("refresh page to try again")} else {endRetrieve();}
	} else {
		dl.saved_coll.retrieved_all = (returnJson.length<retrieve_COUNT);
		//onsole.log("got data len:"+returnJson.length, " all?",dl.saved_coll.retrieved_all )
		//onsole.log(returnJson)

		dl.saved_coll.last_retrieved_date = getMinDate(returnJson, dl.saved_coll.last_retrieved_date);
		dl.saved_coll.data = dl.saved_coll.data.concat(returnJson);
		addStatus("got "+returnJson.length+" records for a total of "+dl.saved_coll.data.length)
		var showdate = new Date(dl.saved_coll.last_retrieved_date)

		if (dl.saved_coll.retrieved_all || JSON.stringify(dl.saved_coll.data).length >FILE_SIZE_MAX) {
			var fileName = saveData();
			var lastDate = new Date(dl.saved_coll.last_retrieved_date);
			var firstDate = new Date(dl.saved_coll.first_retrieved_date);
			addStatus("Created file: '"+fileName+"' for data from "+lastDate.toLocaleDateString()+" "+lastDate.toLocaleTimeString()+ " to "+firstDate.toLocaleDateString()+" "+firstDate.toLocaleTimeString()+ ".");
			dl.saved_coll.first_retrieved_date = dl.saved_coll.last_retrieved_date;
			dl.saved_coll.part++
			dl.saved_coll.data=[];
		}
		if (!dl.saved_coll.retrieved_all) {
			retrieve_data();
		} else {
			endRetrieve();
		}
	}
}
var endRetrieve = function() {
	showWarning("Back Up complete. ");
	addStatus("Retrieved all data. Refresh page to do another backup.");
}
// Save Data
var saveData = function() {
	// codepen.io/davidelrizzo/pen/cxsGb
	var text = JSON.stringify(dl);
	var filename = "freezr data backup "+app_name+" coll "+dl.saved_coll.name+" user "+freezrMeta.userId+" "+dl.meta.date+" part "+dl.saved_coll.part+".json";
	var blob = new Blob([text], {type: "text/plain;charset=utf-8"});
	saveAs(blob, filename);
	return filename;
}

var getMinDate = function(list, themin) {
	if (!themin) themin = new Date().getTime()
	themax = 0
	list.forEach(item => {
		themin = Math.min(themin,item._date_modified)
	})
	return themin
}


var uploader = {
	current_file_num:null,
	current_collection_num:null,
	current_record:null,
	records_uploaded:0,
	records_updated:0,
	records_erred:0,
	file_content:null,
	ok_to_process_all_records:false,
	ok_to_process_all_files:false,
	override_difference: {
		app_name:false,
		user_name:false
	},
	options: {
		KeepUpdateIds:true
	}
};


var uploadAndRestoreData = function() {
	var files = document.getElementById("fileUploader").files;
	if (!files || files.length == 0) {
		showWarning("Please choose a file to import");
	} else {
		if (app_name=="info.freezr.permissions") {
			dl.password = prompt("Please enter your password")
		}

		hideElments();
		uploader.current_file_num = -1;
		processNextFile();
	}
}
var processNextFile = function() {
	var files = document.getElementById("fileUploader").files;
	var file = files[++uploader.current_file_num];
	uploader.ok_to_process_all_records= uploader.ok_to_process_all_files;

	if (file) {

		uploader.current_collection_num=0;
		uploader.current_record=-1;


		var reader = new FileReader()
		reader.readAsText(file, "UTF-8");
		reader.onload = function (evt) {
			uploader.file_content= JSON.parse(evt.target.result);
			var doUpload = true;
			addStatus("Handling file: "+file.name);

			if (app_name !=uploader.file_content.meta.app_name && !uploader.override_difference.app_name) {
				if (confirm("Data from the file '"+file.name+"' came from the the app "+uploader.file_content.meta.app_name+" but you are uploading it to the app "+app_name+". Are you sure you want to proceed?")) {
					uploader.override_difference.app_name=true;
				} else {
					doUpload= false
				}
			}
			if (doUpload && freezrMeta.userId !=uploader.file_content.meta.user && !uploader.override_difference.user) {
				if (confirm("Data from the file '"+file.name+"' was from the user "+uploader.file_content.meta.user+" but you are uploading it as user "+freezrMeta.userId+". Are you sure you want to proceed?")) {
					uploader.override_difference.user=true;
				} else {
					doUpload= false
				}
			}
			if (doUpload) {
				askToProcessNextRecord();
			} else {
				showWarning("Restore operation interrupted.")
			}
	    }
	    reader.onerror = function (evt) {
	    	addStatus("Could not read file: "+file.name);
	        showWarning("error reading file");
	    }
	} else if (uploader.current_file_num>0) {
		showWarning("Upload FInished")
	} else {
		showWarning("No files to upload");
	}
}
//var transformRecord = null;
var existingPurls = [];

var transformRecord =  function(aRecord) {
	if (!aRecord) return null;
	['_date_Created','_date_Modified','_date_Published','_date_Accessibility_Mod'].forEach((alabel)=>{
		if (aRecord[alabel]) {
			aRecord[alabel.toLowerCase()] = aRecord[alabel]
			delete aRecord[alabel]
		}
	})
	if (aRecord.data_object && aRecord.data_object._owner)aRecord.data_owner = aRecord.data_object._owner
	delete aRecord._owner
	// todo - all need to be made programmatically...
	//if (aRecord.fj_deleted) return null;
	// for filtering lists imported. Need to do programmatically
	//idlist = []
	//if (idlist.indexOf(aRecord.listoryId)<0 &&  idlist.indexOf(aRecord._id)<0) return null
	/* Used for vulog
	if (!aRecord.url) return null
		var corePath = function(aUrl) {
	  if (aUrl.indexOf('?')>0) aUrl = aUrl.slice(0,aUrl.indexOf('?'));
	  if (aUrl.indexOf('#')>0) aUrl = aUrl.slice(0,aUrl.indexOf('#'));
	  //if (aUrl.indexOf('http://')== 0){ aUrl=aUrl.slice(7)} else if (aUrl.indexOf('https://')== 0) {aUrl=aUrl.slice(8)}
	  if (aUrl.slice(-1)=="/") {aUrl = aUrl.slice(0,-1);}
	  return aUrl.trim();
	}
	var endsWith = function (longWord, portion) {
		return (longWord.indexOf(portion)>=0 && longWord.indexOf(portion) == (longWord.length - portion.length) )
	}
	var removeEnd = function (longWord,portion) {
		if (endsWith(longWord,portion)) {return (longWord.slice(0,-portion.length));} else {return longWord;}
	}
	if (aRecord.url)  {
		aRecord.purl = corePath(aRecord.url)
	};
	if (aRecord.path) {delete aRecord.path}

	if (dl.meta.manifest.app_tables &&
		dl.meta.manifest.app_tables[uploader.file_content.app_tables[uploader.current_collection_num].name] &&
		dl.meta.manifest.app_tables[uploader.file_content.app_tables[uploader.current_collection_num].name].make_data_id ) {
	} else {
		delete aRecord._id;
	}*/
	/*
	if (aRecord._creator){
		delete aRecord._creator
		delete aRecord._ owner
	}
	*/
	return aRecord;
};

var askToProcessNextRecord = function() {
	//onsole.log("dealing with rec"+uploader.current_record)
	//onsole.log(uploader)
	var thisRecord = uploader.file_content.saved_coll.data[++uploader.current_record];

	if (uploader.ok_to_process_all_records) {
		processNextRecord();
	} else if (!thisRecord) {
		document.getElementById("err_nums").innerHTML= "Errors uploading in total of "+(++uploader.records_erred)+" records."
		addStatus("Error geting record - Missign data in record.<br/>")
		console.warn("err - missing data rec ", thisRecord, "curr rec:", uploader.current_record, "coll num:",uploader.current_collection_num, " len ",uploader.file_content.saved_coll.data.length )
		processNextFile();
	} else {
		document.getElementById("check_record").style.display="block";
		document.getElementById("current_record").innerHTML=recordDisplay(transformRecord(thisRecord));
    }
}
var recordDisplay = function (aRecord) {
	var temp = "<table class='recordTable'>";
	for (var key in aRecord) {
	    if (aRecord.hasOwnProperty(key) && (key!='_id' || document.getElementById("keepIdEl").checked)) {
				temp += "<tr><td class='lhs'>"+key+"</td> <td class='rhs'> "+JSON.stringify(aRecord[key])+"</td></tr>";
		}
	}
	temp+="</table>";
	return temp;

}
var addAllFiles = function() {uploader.ok_to_process_all_records=true; uploader.ok_to_process_all_files=true; processNextRecord()};
var addAllRecords = function() {uploader.ok_to_process_all_records=true; processNextRecord()};
var addRecord = function() {processNextRecord()};
var skipRecord = function() { askToProcessNextRecord()};;
var processNextRecord = function() {
	// process all records in file... then
	document.getElementById("check_record").style.display="none";
	document.getElementById("current_record").innerHTML="";
	  var record = uploader.file_content.saved_coll.data[uploader.current_record];
		if (record && transformRecord) {
			record = transformRecord(record);
		}
		if (record) {
			const app_table = uploader.file_content.saved_coll.name;
			// const app_table = (app_name+(collection_name?('.'+collection_name):""))
			const keepId = document.getElementById("keepIdEl").checked
			var options = {
				app_table:app_table,
				app_name:app_name,
				password: dl.password,
				KeepUpdateIds : keepId,
				updateRecord: false,
				data_object_id: (keepId? (record._id):null)
			}
			delete record._id
      console.log('will upload ', { record, options })

			let url= "/feps/restore/"+app_table
	    freezerRestricted.connect.send(url, JSON.stringify({record, options }), restoreRecCallBack, "POST", 'application/json');
		} else {
			//askToProcessNextRecord();
			processNextFile();
		}
}
const restoreRecCallBack = function (error, returnData) {
	returnData = freezr.utils.parse(returnData);
	if (error) {
		document.getElementById("err_nums").innerHTML= "Errors uploading in total of "+(++uploader.records_erred)+" records."
		addStatus("error uploading a record " + error.message + " - "+((returnData && returnData.message)? returnData.message: "unknown cause") +".<br/>")
		console.warn("err uploading ",{error, returnData} )
    uploader.current_record--
    uploader.ok_to_process_all_records = false
	} else {
		if (returnData.success) uploader.records_updated+=1;
		document.getElementById("upload_nums").innerHTML= "Total of "+(++uploader.records_uploaded)+" have been uploaded"+(uploader.records_updated?(", of which "+uploader.records_updated+" were updates of existing records."):".")
	}
	askToProcessNextRecord();
}
// View Elements
var hideElments = function(){
	document.getElementById("uploadForm").style.display="none";
	document.getElementById("uploadAndRestoreData").style.display="none";
	document.getElementById("download_area").style.display="none";
	document.getElementById("getAndSaveData").style.display="none";
}
var addStatus = function(aText) {
	document.getElementById("backup_status").innerHTML=aText+"<br/>"+document.getElementById("backup_status").innerHTML;
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
