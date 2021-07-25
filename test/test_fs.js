
//

var expect = require('chai').expect;
var assert = require('chai').assert;
var all_environments = require('../test/test_environment_params.js').params;


const TEST_APP_NAME = "test_app",
      TEST_APPCOLLOWNER = {app_name:TEST_APP_NAME, collection_name:TEST_COLL_1}

// check params {
expect(all_environments).to.be.an('array')

// check params {
describe('Check file environments', function() {
  all_environments.forEach((env_params) => {
    //onsole.log(env_params)
    context('Checking '+env_params.test_name, function() {
      it('should have dbParams', function() {
        expect(env_params).to.include.all.keys('dbParams','test_name')
      })
    })
  })
})

all_environments.forEach((env_params) => {
  env_params.force_env_reset = true;
})


all_environments.forEach((env_params) => {

    db_handler.re_init_environment_sync(env_params)

    describe('2 Re-initialise db environment'+env_params.test_name, function() {
        it('re-intiialises db environment', function(done) {
            console.log(" 222 XXXXXXXXXXXXXX  XXXXXXXXXXXXXX  XXXXXXXXXXXXXX  XXXXXXXXXXXXXX ")
            console.log("  222   TEST DB_HANDLER - CHECKING ENVIRONMENT "+env_params.test_name)
            console.log(" 222 XXXXXXXXXXXXXX  XXXXXXXXXXXXXX  XXXXXXXXXXXXXX  XXXXXXXXXXXXXX ")
            db_handler.re_init_freezr_environment(env_params, done)
          });
    })
    describe('2 Check Database (check_db) '+env_params.test_name, function() {
        it('check_db has no errors - '+env_params.test_name, function(done) {
            db_handler.re_init_freezr_environment(env_params, done)
          });
    })
    describe('Database fundamentals: '+env_params.test_name, function() {
      context('create '+env_params.test_name, function() {
        it('inserts a no ID item in db '+env_params.test_name+"===================", function(done) {
            db_handler.create(env_params, TEST_APPCOLLOWNER, null,
              { 'test_field':'hello - no id',
                'tag':TEST_TAG1,
                'allhave':'thisvalue'},
              null,
              function(err, ret) {
                if (err) {
                  done(err);
                } else {
                  //onsole.log(" ret insert "+env_params.test_name+" "+JSON.stringify(ret))
                  done();
                }
              })
          });
          it('finds all items (1) '+env_params.test_name+"===================", function(done) {
              db_handler.query(env_params, TEST_APPCOLLOWNER, {},{},
                (err, ret) => {
                  //onsole.log("find ALL items ret "+JSON.stringify(ret), (ret? ret.length:" no len") )
                  if (err) {
                    done(err);
                  } else if (!ret || ret.length!=1){
                    done(new Error ("expected items of length 1 and got "+(ret? ret.length:" ZERO!!") ))
                  } else {
                    done();
                  }
                })
          });
        it('inserts item in db with an id '+env_params.test_name+"===================", function(done) {
                db_handler.create(env_params, {app_name:TEST_APP_NAME, collection_name:TEST_COLL_1}, TEST_ID1,
                  { 'test_field':'hello2 with id',
                    'tag':TEST_TAG1,
                    'allhave':'thisvalue'},
                  null,
                  function(err, ret) {
                    //onsole.log("insert ret "+JSON.stringify(ret))
                    if (err) {
                      done(err);
                    } else {
                      if (!ret) console.warn("DB did not return entity");
                      if (ret && ret.entity && ret.entity._id!=TEST_ID1) {
                        done(new Error("returned id didnt match id written"))
                      }
                      else done();
                    }
                  })
          });
          it('finds all items (2) '+env_params.test_name+"===================", function(done) {
              db_handler.query(env_params, {app_name:TEST_APP_NAME, collection_name:TEST_COLL_1}, {},{},
                (err, ret) => {
                  //onsole.log("find ALL items ret "+JSON.stringify(ret), (ret? ret.length:" no len") )
                  if (err) {
                    done(err);
                  } else if (!ret || ret.length!=2){
                    done(new Error ("expected items of length 2 and got "+(ret? ret.length:" ZERO!!") ))
                  } else {
                    done();
                  }
                })
          });
        it('inserts item with id - should generate error - '+env_params.test_name+"===================", function(done) {
          db_handler.create(env_params, TEST_APPCOLLOWNER, TEST_ID1, {'test_field':'hello duplicate id','tag':'tag1', 'allhave':'thisvalue'},null,
              function(err, ret) {
                if (err) {
                  done();
                } else {
                  done(new Error ("Should NOT be able to insert when an id already exists"));
                }
              })
          });
          it('finds all items (2a) '+env_params.test_name+"===================", function(done) {
              db_handler.query(env_params, TEST_APPCOLLOWNER, {},{},
                (err, ret) => {
                  //onsole.log("find ALL items ret "+JSON.stringify(ret), (ret? ret.length:" no len") )
                  if (err) {
                    done(err);
                  } else if (!ret || ret.length!=2){
                    done(new Error ("expected items of length 2 and got "+(ret? ret.length:" ZERO!!") ))
                  } else {
                    done();
                  }
                })
          });
      })

      context('db_upsert and db_update '+env_params.test_name, function() {
        it('upserts item in db with a new id', function(done) {
            db_handler.upsert(env_params, TEST_APPCOLLOWNER, TEST_ID2,
              { 'test_field':'hello2 with id',
                'tag':'tag2',
                'allhave':'thisvalue'},
              function(err, ret) {
                //onsole.log("ret From upsert",ret)
                if (err) {
                  done(err);
                } else {
                  if (!ret) console.warn("DB should return entity");
                  else done();
                }
              })
        });
        it('finds all items (3)'+env_params.test_name+"===================", function(done) {
            db_handler.query(env_params, TEST_APPCOLLOWNER, {},{},
              (err, ret) => {
                //onsole.log("find ALL items ret "+JSON.stringify(ret), (ret? ret.length:" no len") )
                if (err) {
                  done(err);
                } else if (!ret || ret.length!=3){
                  done(new Error ("expected items of length 3 and got "+(ret? ret.length:" ZERO!!") ))
                } else {
                  done();
                }
              })
        });
        it('upserts item in db replacing the old id '+env_params.test_name+"===================", function(done) {
            db_handler.upsert(env_params, TEST_APPCOLLOWNER, TEST_ID1, {'test_field':'hello3 with id', 'allhave':'thisvalue','tag':'tag3'},
              function(err, ret) {
                //onsole.log("insert ret "+JSON.stringify(ret))
                if (err) {
                  done(err);
                } else {
                  //onsole.log("return from upsert with replace ", JSON.stringify(ret))
                  if (!ret) console.warn("DB did not return entity");
                  if (ret && ret.entity && ret.entity._id!=TEST_ID1) done(new Error("returned id didnt match id written (replace)"))
                  else done();
                }
              })
        });
        it('finds all items (3a) '+env_params.test_name+"===================", function(done) {
            db_handler.query(env_params, TEST_APPCOLLOWNER, {},{},
              (err, ret) => {
                //onsole.log("find ALL items ret "+JSON.stringify(ret), (ret? ret.length:" no len") )
                if (err) {
                  done(err);
                } else if (!ret || ret.length!=3){
                  done(new Error ("expected items of length 3 and got "+(ret? ret.length:" ZERO!!") ))
                } else {
                  done();
                }
              })
        });
        it('upserts item using query '+env_params.test_name+"===================", function(done) {
          db_handler.upsert(env_params, TEST_APPCOLLOWNER, {'tag':'tag2'}, {'test_field':'hello2 with id upserted via query', 'allhave':'thisvalue', 'tag':'tag2'},
                function(err, ret) {
                  //onsole.log("insert ret "+JSON.stringify(ret))
                  if (err) {
                    done(err);
                  } else {
                    //onsole.log("return from upsert with replace via query", JSON.stringify(ret))
                    if (!ret) console.warn("DB did not return entity");
                    if (ret && ret.entity && ret.entity._id!=TEST_ID1) done(new Error("returned id didnt match id written (replace)"))
                    else if (ret && ret.nModified && ret.nModified!=1 ) done(new Error("turied to upsert but expected 1 nModified - got "+ret.nModified))
                    else if (ret && ret.entity && ret.entity.test_field!='hello2 with id upserted via query') done(new Error("returned id didnt match id written (replace)"))
                    else done();
                  }
                })
          });
          it('finds all items (3b) '+env_params.test_name+"==================="+env_params.test_name+"===================", function(done) {
              db_handler.query(env_params, TEST_APPCOLLOWNER, {},{},
                (err, ret) => {
                  //onsole.log("find ALL items 3b post upsert ret "+JSON.stringify(ret), (ret? ret.length:" no len") )
                  if (err) {
                    done(err);
                  } else if (!ret || ret.length!=3){
                    done(new Error ("expected items of length 3 and got "+(ret? ret.length:" ZERO!!") ))
                  } else {
                    done();
                  }
                })
          });
        // updateinto new ID -
        // update but not replace all fields
        // update all by tags and select fields
      })


      //[{"_id":"5d22f36223846b1f0a1e3ecd","test_field":"hello - no id","tag":"tag1","allhave":"thisvalue","_date_created":1562571618225,"_date_modified":1562571618225},{"_id":"testid1","test_field":"hello3 with id","allhave":"thisvalue","tag":"tag3","_date_created":1562571618225},{"_id":"testid2","test_field":"hello2 with id upserted via query","allhave":"thisvalue","tag":"tag2","_date_created":1562571618225}]
      //[{"_date_modified":1562571618565,"test_field":"hello - no id","tag":"tag1","allhave":"thisvalue","_date_created":1562571618565,"_id":"5672330625810432"},        {"_id":"testid1","test_field":"hello2 with id","tag":"tag1","allhave":"thisvalue","_date_created":1562571619873,"_date_modified":1562571619873},{"_date_modified":1562571622140,"test_field":"hello2 with id",
      ,"tag":"tag2","allhave":"thisvalue","_date_created":1562571622140,"_id":"testid2"}]

      context('db_find and remove '+env_params.test_name, function() {
        it('finds all items '+env_params.test_name+"===================", function(done) {
            db_handler.query(env_params, TEST_APPCOLLOWNER, {},{},
              (err, ret) => {
                //onsole.log("find ALL items before sorting "+JSON.stringify(ret), (ret? ret.length:" no len") )
                if (err) {
                  done(err);
                } else if (!ret || ret.length!=3){
                  done(new Error ("expected items of length 3 and got "+(ret? ret.length:" ZERO!!") ))
                } else {
                  done();
                }
              })
        });
        it('finds all items sorted (1) '+env_params.test_name+"===================", function(done) {
            db_handler.query(env_params, TEST_APPCOLLOWNER, {},{sort:{'tag':-1},count:2},
              (err, ret) => {
                //onsole.log("find ALL items sorted (1)"+JSON.stringify(ret), (ret? ret.length:" no len") )
                if (err) {
                  done(err);
                } else if (!ret || ret.length!=2){
                  done(new Error ("expected items of length 2 and got "+(ret? ret.length:" ZERO!!") ))
                } else if (ret[0].tag!="tag3"){
                  done(new Error ("expected items of tag3 got "+(ret? JSON.stringify(ret[0]):" NONE!!") ))
                } else if (ret[1].tag!="tag2"){
                  done(new Error ("expected 2nd item of tag2 got "+JSON.stringify(ret[0]) ))
                } else {
                  done();
                }
              })
        });
        it('finds all items sorted (2)'+env_params.test_name+"===================", function(done) {
            db_handler.query(env_params, TEST_APPCOLLOWNER, {},{sort:{'tag':1},count:2,skip:1},
              (err, ret) => {
                //onsole.log("find ALL items sorted (2)"+JSON.stringify(ret), (ret? ret.length:" no len") )
                if (err) {
                  done(err);
                } else if (!ret || ret.length!=2){
                  done(new Error ("expected items of length 2 and got "+(ret? ret.length:" ZERO!!") ))
                } else if (ret[0].tag!="tag2"){
                  done(new Error ("expected items of tag2 got "+JSON.stringify(ret[0]) ))
                } else if (ret[1].tag!="tag3"){
                  done(new Error ("expected 2nd item of tag3 got "+JSON.stringify(ret[0]) ))
                } else {
                  done();
                }
              })
        });
        it('finds queried items '+env_params.test_name+"===================", function(done) {
            db_handler.query(env_params, TEST_APPCOLLOWNER, {'tag':TEST_TAG1},{},
              (err, ret) => {
                //onsole.log("find  items ret "+JSON.stringify(ret), (ret? ret.length:" no len") )
                if (err) {
                  done(err);
                } else if (!ret || ret.length!=1){
                  done(new Error ("expected items of length 1 and got "+(ret? ret.length:" ZERO!!") ))
                } else {
                  done();
                }
              })
        });
        it('finds queried items (2) and checks upsert results'+env_params.test_name+"===================", function(done) {
            db_handler.query(env_params, TEST_APPCOLLOWNER, {'tag':'tag2'},{},
              (err, ret) => {
                //onsole.log("find ALL from upsert items ret "+JSON.stringify(ret), (ret? ret.length:" no len") )
                if (err) {
                  done(err);
                } else if (!ret || ret.length>1){
                  done(new Error ("expected items of length 1 and got "+(ret? ret.length:" ZERO!!") ))
                } else if (ret[0].test_field!='hello2 with id upserted via query') {
                  done(new Error ("expected item to be updated and instead got "+JSON.stringify(ret)))
                } else {
                  done();
                }
              })
        });
        it('finds $AND queried items and checks results'+env_params.test_name+"===================", function(done) {
            db_handler.query(env_params, TEST_APPCOLLOWNER,
              {$and:[{"allhave":"thisvalue"},{test_field:'hello2 with id upserted via query'}]},
              {},
              (err, ret) => {
                //onsole.log("find ALL items ret "+JSON.stringify(ret), (ret? ret.length:" no len") )
                if (err) {
                  done(err);
                } else if (!ret || ret.lengfth==0 || ret.length>1){
                  done(new Error ("expected items of length 1 and got "+(ret? ret.length:" ZERO!!") ))
                } else if (ret[0].test_field!='hello2 with id upserted via query') {
                  done(new Error ("expected item to be updated and instead got "+JSON.stringify(ret)))
                } else {
                  done();
                }
              })
        });
        it('finds $AND and $or queried items'+env_params.test_name+"===================", function(done) {
            db_handler.query(env_params, TEST_APPCOLLOWNER,
              {$and:[{"allhave":"thisvalue"},
                    {$or: [{'test_field':'hello2 with id upserted via query'},{'test_field':'hello - no id'}] }
                    ]},
              {},
              (err, ret) => {
                //onsole.log("find and and or items ret "+JSON.stringify(ret), (ret? ret.length:" no len") )
                if (err) {
                  done(err);
                } else if (!ret || ret.length!=2){
                  done(new Error ("expected items of length 2 and got "+(ret? ret.length:" ZERO!!") ))
                } else {
                  done();
                }
              })
        });
        it('finds an id'+env_params.test_name+"===================", function(done) {
            db_handler.read_by_id(env_params, TEST_APPCOLLOWNER, TEST_ID1,
              function(err, ret) {
                //onsole.log("find by id ret "+JSON.stringify(ret))
                if (err) {
                  done(err);
                } else if (!ret._id) {
                  done(new Error("null entity returned"))
                } else if (ret._id != TEST_ID1) {
                  done(new Error("Wrong entity returned"))
                } else {done();}
              })
        });
        it('finds nothing if no id'+env_params.test_name+"===================", function(done) {
            db_handler.read_by_id(env_params, TEST_APPCOLLOWNER, 'NonExistantId',
              function(err, ret) {
                //onsole.log("Got non existant id "+JSON.stringify(ret))
                if (err) {
                  done(err);
                } else if (ret) {
                  console.warn("todo - check empty object")
                  done()
                } else {
                  done()
                }
              })
        });
        it('updates an item '+env_params.test_name+"===================", function(done) {
            db_handler.update(env_params, TEST_APPCOLLOWNER, {'tag':'tag2'},{'tag':'tag1'},{replaceAllFields:false, multi:true},
              function(err, ret) {
                //onsole.log("db_handler db_update an item ret "+JSON.stringify(ret))
                if (err) {
                  done(err);
                } else {
                  db_handler.query(env_params, TEST_APPCOLLOWNER, {'tag':'tag1'},{},
                    (err, ret) => {
                      //onsole.log("find updated items (1) items ret "+JSON.stringify(ret), (ret? ret.length:" no len") )
                      if (err) {
                        done(err);
                      } else if (!ret || ret.length!=2){
                        done(new Error ("Updated but expected items of length 2 and got "+(ret? ret.length:" ZERO!!") ))
                      } else {
                        done();
                      }
                    })
                }
              })
        });
        it('tries to update non-existing item '+env_params.test_name+"===================", function(done) {
            db_handler.update(env_params, TEST_APPCOLLOWNER, {'tag':'tag5'},{'tag':'tag1'},null,
              function(err, ret) {
                if (err) {
                  done(err);
                } else {
                  db_handler.query(env_params, TEST_APPCOLLOWNER, {'tag':'tag2'},{},
                    (err, ret) => {
                      if (err) {
                        done(err);
                      } else if (ret && ret.length!=0){
                        done(new Error ("Updated but expected items of length 2 and got "+(ret? ret.length:" ZERO!!") ))
                      } else {
                        done();
                      }
                    })
                }
              })
        });
        it('removed item with id'+env_params.test_name+"===================", function(done) {
            db_handler.delete_record(env_params, TEST_APPCOLLOWNER, TEST_ID1,{},
              function(err, ret) {
                if (err) {
                  done(err);
                } else {
                  //onsole.log(" ret remove "+env_params.test_name+" "+JSON.stringify(ret))
                  done();
                }
              })
        });
        it('tried to find non-existant id...'+env_params.test_name+"===================", function(done) {
            db_handler.read_by_id(env_params, TEST_APPCOLLOWNER, TEST_ID1,
              function(err, ret) {
                if (err) {
                  done(err);
                } else if (ret){
                  done(err)
                } else {
                  done();
                }
              })
        });

        it('finds all collection names '+env_params.test_name+"===================", function(done) {
            db_handler.getAllAppTableNames(env_params, "test_app",
              function(err, ret) {
                if (err) {
                  done(err);
                } else if (ret){
                  if (ret.length==1 && ret[0]=="coll_1") done()
                  else done(new Error("expected one entry of coll_1 and got",ret.join(", ")))
                } else {
                  done(new Err("no return from colelction names"));
                }
              })
        });

        it('2 removes all items with query '+env_params.test_name+"===================", function(done) {
            db_handler.delete_record(env_params, TEST_APPCOLLOWNER, {},{},
              function(err, ret) {
                //onsole.log("returned from remove with ret",ret)
                if (err) {
                  done(err);
                } else {
                  //onsole.log(" ret remove "+env_params.test_name+" "+JSON.stringify(ret))
                  //CHECK ID IS CORRECT
                  done();
                }
              })
        });
        // find all - shuld find nothing

      })
    })
})
