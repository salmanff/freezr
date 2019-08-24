// freezr.info - nodejs databsse - sample custom_envioronments.js
// This can be used to create custom environments for accessing a custom db and file system
//
// custom environment for Google App Ending (GAE) COud Datastore

// GAE Quirks
// Because GAE cant do OR queries, OR queries are done MANUALLY
// Because GAE cant sort (eg by _date_Modified) in addtiion to filtering,
//   the owner is added to the entity kind

// Todo
// db_find sort if more than one $or?


'use strict';

const  {Datastore} = require('@google-cloud/datastore');
const  helpers = require('../helpers.js');

const  async = require('async')

var freezr_environment = null;
let ds=null;

exports.use = true;

exports.name='Google App Engine Datastore'

exports.customDb = function(app_name) {return true}

exports.re_init_environment_sync = function(env_params) {
    const keyFilename= './freezr_system/environment/gaeDatastoreKeyfile.json'

    const fs=require('fs')

    let keyfile = fs.readFileSync(keyFilename)
    keyfile=JSON.parse(keyfile)
    if (keyfile) {
      freezr_environment = env_params;
      freezr_environment.dbParams.projectid = keyfile.project_id
      freezr_environment.dbParams.gaeKeyFile = true

      ds = new Datastore({
          projectId : keyfile.project_id,
          keyFilename: './freezr_system/environment/gaeDatastoreKeyfile.json'
        });

    } else {
      helpers.state_error("*** could not re_init_environment_sync - keyfile missing ****")
    }


}
exports.re_init_freezr_environment = function(env_params, callback) {
    freezr_environment = env_params;
    let ds_params= null;
    if (env_params.dbParams.gaeKeyFile) {
      ds_params= {
        projectId : env_params.dbParams.projectid,
        keyFilename: './freezr_system/environment/gaeDatastoreKeyfile.json'
      }
    }
    ds = new Datastore(ds_params);
    callback(null)
}
exports.check_db = function (env_params, callback) {
		//onsole.log("check_db in gae")
    const appcollowner = {
      app_name:'info_freezer_admin',
		  collection_name : 'params',
      _owner: 'freezr_admin'
    }
    let env_on_db=null;

    exports.db_getbyid(env_params, appcollowner, "freezr_environment", function(err, env_on_db) {
			exports.db_getbyid(env_params, appcollowner, "test_write_id", (err2, savedData) => {
		    if (err || err2) {
		      console.warn("got err in check_db ",(err? err : err2))
        	callback((err? err : err2), env_on_db);
		    } else if (savedData){
          exports.db_update (env_params, appcollowner, "test_write_id", {'foo':'updated bar'},
            {}, (err, ret)=> callback(err, env_on_db))
		    } else {
          exports.db_insert (env_params, appcollowner, "test_write_id", {'foo':'bar'}, null, (err, ret)=> callback(err, env_on_db))
        }
		});
	})
}

exports.db_insert = function (env_params, appcollowner, id, entity, options, callback) {

  const key = getGaeKey(appcollowner, id);
  const insertable = {
    key: key,
    data: entity,
  };

  ds.insert(insertable).then((ent) => {
    let success = {success:true, entity:entity, issues:{}}

    if (!id){
      try {
        id = ent[0].mutationResults[0].key.path[0].id
      } catch(e) {
        success.issues.idNotReturned = true;
      }
    }
    success.entity._id = (parseInt(id) == id)? parseInt(id, 10):id;

    if (ent && ent[0] && ent[0].mutationResults && ent[0].mutationResults[0] && ent[0].mutationResults[0].conflictDetected) success.issues.conflictDetected = true;

    callback(null, success)

  }).catch((err) =>{
    console.log("In insert got err ",err)
    callback(err)
  });
}

exports.db_getbyid = function (env_params, appcollowner, id, cb) {
  const key = getGaeKey(appcollowner, id);
  ds.get(key, (err, entity) => {
    let result = fromDatastore(entity)
    if (result && !result._id) result._id = id;
    cb(err, result);
  });
}

exports.db_find = function(env_params, appcollowner, top_query, options, cb) {
  //onsole.log("in gae db_find ",top_query)
  if (typeof top_query=="string") {
    exports.db_getbyid (env_params, appcollowner, top_query, (err, entity)=> {
      if (err) {
        cb(err)
      } else {
        entity = fromDatastore(entity)
        if (options.keyOnly) entity = entity._id
        cb(null, [entity])
      }
    })
  } else {

    let [err, ds_queries, query_string] = makeCustomerQueryFromMongoQuery(appcollowner, top_query, options)

    //onsole.log("query_string",query_string)
    if (err) {
      cb(err)
    } else {
      let entities = [];
      async.forEach(ds_queries, function (a_query, cb2) {
        if (typeof a_query=="string") {
          exports.db_getbyid (env_params, appcollowner, a_query, (err2, entity)=> {
            if (err2) {
              cb2(err2)
            } else {
              entities.push(entity)
              cb2()
            }
          })
        } else {
          ds.runQuery(a_query).then( results => {
            entities = [...entities, ...results[0]]
            // todo - add issues  eg results[1]: {"moreResults":"NO_MORE_RESULTS","endCursor":"A9hcHBfX2NYACAA"}
            cb2()
          }).catch( err2 =>{
            console.warn("Caught error in runQuery "+err2)
            cb2(err2)
          })
        }
      },
      function (err3) {
        if (err3) err = err3
        entities = entities.map(fromDatastore)
        entities = remove_duplicates(entities)
        if (options.keyOnly) {entities = entities.map(function(obj) {return obj._id})}
        if (err) console.warn("got err in entities "+err)
        cb(err , entities)
      })
    }
  }
}
exports.db_remove = function (env_params, appcollowner, idOrQuery, options={}, cb) {
  if (typeof idOrQuery == "string") {
    const key = getGaeKey(appcollowner, idOrQuery);
    ds.delete(key).then((what) => {
      cb(null, what)
    }).catch((err)=>{
      cb(err)
    })
  } else {
    options.keyOnly = true
    exports.db_find(env_params, appcollowner, idOrQuery, options, (err, entities)=>{
      function makeKeys (id) {return getGaeKey(appcollowner, id)};
      let keys = entities.map(makeKeys)
      ds.delete(keys).then((what) => {
        cb(null, what)
      }).catch((err)=>{
        cb(err)
      })
    })
  }
}
exports.db_update = function (env_params, appcollowner, idOrQuery, updates_to_entity, options, cb) {
    //onsole.log("gae db_update ",idOrQuery)
    if (typeof idOrQuery == "string") idOrQuery = {"_id":idOrQuery}

    let findoptions = options.replaceAllFields || !options.multi? {count:1}: {};
    exports.db_find(env_params, appcollowner, idOrQuery, findoptions, (err, entities)=> {
      //onsole.log(entities)
      if (!idOrQuery) {
        cb(new Error("No query passed to find"))
      } else if (!entities || entities.length==0) {
        cb(null, {nModified:0, n:0})
      } else {
        let all_results = []
        async.forEach(entities, function (old_entity, cb2) {
          if (!old_entity) { // emtpy entity passed on by "db_find"
            cb2(null)
          } else {
            let id = old_entity._id
            if (options.replaceAllFields) {
              updates_to_entity._owner = old_entity._owner
              updates_to_entity._date_Created = old_entity._date_Created
            } else {
              Object.keys(updates_to_entity ).forEach( key => {
                old_entity[key] = updates_to_entity[key]
              })
              delete old_entity._id
              updates_to_entity = old_entity
            }
            ds.update({
              key: getGaeKey(appcollowner, id),
              data: updates_to_entity
              }
            ).then(
              results => {
                all_results.push(results)
                cb2()
              }
            ).catch(err =>{
              all_results.push(err)
              cb2(err)
              }
            )
          }
        },
        function (err3) {
          cb(err3, {"n":all_results.length,"nModified":all_results.length, details:all_results} )
          // todolater - parse all_results for more insights
        })
      }
  })
}

exports.update_record_by_id = function (env_params, appcollowner, id, updates_to_entity, cb) {
    // Assumes all non-system fields are being replaced
    ds.update({
      key: getGaeKey(appcollowner, id),
      data: updates_to_entity
      }
    ).then(
      results => {
        cb(null, {"n":1,"nModified":1, details:results} )
      }
    ).catch(err =>{
      cb(err)
      }
    )
}

exports.set_and_nulify_environment = function(old_env) {
    freezr_environment = old_env;
}

exports.getAllCollectionNames = function(env_params, app_name, callback) {
  const query = ds.createQuery('__Stat_Kind__');
  let collection_list=[];
  ds.runQuery(query).then( entities => {
    entities[0].forEach(anEntity => {
      //onsole.log(anEntity.kind_name)
      if (helpers.startsWith(anEntity.kind_name, app_name)) {
        let coll_name = anEntity.kind_name.slice(app_name.length+2) // remove app_name
        if (coll_name.indexOf('__')>-1) coll_name = coll_name.slice(0,coll_name.indexOf('__')) // remove user at end
        if (coll_name) collection_list = helpers.addToListAsUnique (collection_list, coll_name)
      } else {
        //onsole.log(anEntity.kind_name+"doesnt start with "+app_name)
      }
    })
    callback(null, collection_list)
  }).catch( err =>{
    console.warn("Caught error in runQuery for collection_list "+err)
    callback(err)
  })


}

function makeCustomerQueryFromMongoQuery(appcollowner, topquery, options) {
  // options include sort,limit and keyOnly
  if (options.doTestString && !ds) exports.re_init_environment_sync({dbParams:{}}); // for testing

  //onsole.log("topquery makeCustomerQueryFromMongoQuery "+appcollowner.app_name+" - "+appcollowner.collection_name+" ")
  //onsole.log("topquery",topquery)

  let err = "";

  let ds_queries = [];
  let top_ands = [];
  let theOrs=[];
  let oneOwner= null;

  let test_strings=[]

  function getFirstKeyValue(obj, toplevel) {
    let i=1, ret=[null, null, null], err1 ="";
    Object.keys( obj ).forEach( key => {
      let part = {};
      if (i++ == 1) {
        if (typeof obj[key]!="string" && isNaN(obj[key])
            && !(toplevel==true && key=="$or" && Array.isArray(obj[key]) ) ) {
          err1 += " - Object cannot have multiple levels of queries"
        } else {
          ret= [key, obj[key], null]
        }
      } else {
        err1 += "Object contains more than one element (expected 1 for: "+JSON.stringify(obj)+")"
      }
    });
    if (err1) ret[2]=err1
    return ret;
  }

  // parse out top level $ands
  if (!topquery) {
    top_ands = []
  } else if (typeof topquery=="string") {
    // It is just an id
    top_ands = [topquery]
    oneOwner=appcollowner._owner
  } else if (topquery.$and) {
    top_ands = topquery.$and
    let i=0, j=0;
    Object.keys( topquery ).forEach( key => {
      i++;
      if (key=="_owner") oneOwner=topquery[key]
    })
    topquery.$and.forEach(anAnd => {
      if (anAnd.$or) {
        j++;
        theOrs = anAnd.$or
      }
    })
    if(i>1 || j>1) err+=(" - All query params must be put into the top $and object")

  } else {
    Object.keys( topquery ).forEach( key => {
      if (key=="_owner") oneOwner=topquery[key]
      let part = {};
      part[key]=topquery[key]
      top_ands.push(part)
    });
    if (topquery.$or) {
      theOrs = topquery.$or
    }
  }
  if (theOrs.length==0) {
    theOrs=[{'_owner':oneOwner || appcollowner._owner}]
  }

  for (let i=0; i<theOrs.length;i++) {
    let thisOwner = theOrs[i]._owner || oneOwner || appcollowner._owner;
    ds_queries[i] =ds.createQuery(full_coll_name ({app_name:appcollowner.app_name, collection_name:appcollowner.collection_name, _owner:thisOwner}))
    if (options.keyOnly) {ds_queries[i] = ds_queries[i].select('__key__');}
    test_strings[i] = "query string: "
  }

  const mongoCommands = ['$eq','$lt','$lte','$gt','$gte']
  const gaedsCommands = ['='  ,'<'  ,'<='  ,'>'  ,'>=']
  top_ands.forEach((part)=> {
    let [key, value, err1] = getFirstKeyValue(part, true)
    if (err1) {
      err+= "Error on "+key+" "+err1
    } else if (key=='_id') {
       ds_queries.forEach((a_query)=> {a_query = a_query.filter('__key__', '=', getGaeKey (appcollowner, value))})
     } else if (key=='_owner') {
        // do nothing - already added to appcollowner
    } else if (key[0]=='$') { // a Mongo command
      if (key=='$or' && Array.isArray(value)) { // top level $or
        // do nothing
      } else if (mongoCommands.indexOf(key)>-1 ) { // allowed commands
        let idx = mongoCommands.indexOf(key)
        for (let i=0; i<theOrs.length;i++) {
          ds_queries[i] = ds_queries[i].filter(key, gaedsCommands[idx], value)
          test_strings[i] +=".filter("+key+" "+gaedsCommands[idx]+" "+value +")"
        }
      } else {
        err+= "Error - Used "+key+" when accepted query commadns are "+JSON.stringify(mongoCommands)
      }
    } else {
      for (let i=0; i<theOrs.length;i++) {
        ds_queries[i] = ds_queries[i].filter(key, "=", value)
        test_strings[i]+=".filter("+key+" = "+value +")"
      }
    }
  } )

  if (theOrs.length>0
    // && !(theOrs.length==1 && theOrs[0]._owner)
  ) // dont add owner filter so that one can sort
    {
    for (let i=0; i<theOrs.length;i++) {
      if (theOrs[i]){
        let [key, value, err2]=  getFirstKeyValue(theOrs[i], false)
        if (key != '_owner'){
          ds_queries[i] = ds_queries[i].filter(key, '=', value)
          test_strings[i]+=".filter("+key+" = "+value +")"
        }
      }
    }
  }


  if (options.sort) {
    Object.keys(options.sort).forEach(sort_key => {
      let sort_desc= (options.sort[sort_key]<0)
      ds_queries.forEach((a_query)=> {a_query = a_query.order(sort_key, {descending: sort_desc})})

    //  test_strings.forEach(a_string)=> {a_string = a_string + "sort(" + sort_key + " desc:"+ // < 0? "true":"false") +")"}

    })
  }

  if (options.count || options.skip) {
    ds_queries.forEach((a_query)=> {
      if (options.count) ds_queries.forEach((a_query)=> {a_query = a_query.limit(options.count)})
      // Note: Clearly with multiple Ors, count here returns the limit for each "Or"
      if (options.skip) ds_queries.forEach((a_query)=> {a_query = a_query.offset(options.skip)})
      // Note: GAE indicates using offset is inefficient
      //test_strings.forEach(a_string)=> {a_string = a_string+(options.skip?" skip:"+options.skip : " ")+(options.count?(" count:"+options.count):"")}
    })
  }

  if (err) {err = new Error(err)}
  if (err) console.warn("********** ERR : "+err)
  if (!options.doTestString) {return [err, ds_queries, test_strings]} else {return null};

}
/*
makeCustomerQueryFromMongoQuery({app_name:"app_name",collection_name:"collection_name",_owner:"test_user"}, {'One':1, 'two':2} , {doTestString:true})
makeCustomerQueryFromMongoQuery({app_name:"app_name",collection_name:"collection_name",_owner:"test_user"},
  {$and:[ {'One':1}, {'two':2, 'two_half':2.5}]} , {doTestString:true})
makeCustomerQueryFromMongoQuery({app_name:"app_name",collection_name:"collection_name",_owner:"test_user"},
    {$and:[ {'One':1}, {'two':2},{'two_sixth':2.6}]} , {doTestString:true})
makeCustomerQueryFromMongoQuery({app_name:"app_name",collection_name:"collection_name",_owner:"test_user"},
        {$and:[ {'One':1}, {'two':2},{'two_sixth':2.6},{$or:[{'ten':10},{'eleven':11},{'twelve':12}]}]} , {doTestString:true})
*/
function full_coll_name (appcollowner) {
	if (!appcollowner || !appcollowner.app_name || !appcollowner.collection_name ||!appcollowner._owner) throw new Error("Missing collection name or app name "+appcollowner.app_name+" - "+appcollowner.collection_name+" "+appcollowner._owner)
	return (appcollowner.app_name+"__"+appcollowner.collection_name+"__"+appcollowner._owner).replace(/\./g,"_")
}
function getGaeKey (appcollowner, idOrName) {
  // note todo - this assumes all numeric id's have been generated by GAE
  if (idOrName && parseInt(idOrName) == idOrName) idOrName = parseInt (idOrName, 10)
  let params = [full_coll_name(appcollowner)]
  if (idOrName) params.push(idOrName)
  return ds.key(params)
}
function fromDatastore(obj) {
  //if (!obj) console.warn("No Object at fromDatastore ",obj)
  if (!obj) return null
  if (!obj[Datastore.KEY]) console.warn("No Key at fromDatastore ",obj)
	if (obj[Datastore.KEY]) obj._id = obj[Datastore.KEY].id || obj[Datastore.KEY].name;
	delete obj[Datastore.KEY]
  return obj;
}
function remove_duplicates(list,key="_id"){
  let ret = []
  let keys = []
  list.forEach((anItem) => {
    if (keys.indexOf(anItem[key])<0) {
      keys.push(anItem[key]);
      ret.push(anItem)
    }
  })
  return ret
}
