var should = require('chai').should()
  , assert = require('chai').assert
  , testFs = 'workspace/test.txt'
  // , fs = require('fs') // sf_added removed
  , path = require('path')
  , _ = require('underscore')
  , async = require('async')
  ;


/**
@sf_added:
  - this test the file system

**/
var env = null
//env = require('../env/params')
env = require('../env/params')
try {
  env = require('../env/params')
} catch(e) {
  env = {dbFS:null, name:'defaultLocalFS'}
  // onsole.log("no custom environment - Useing local fs")
}
console.log(" Using file system enviornment: "+env.name)
const BEFORE_DELAY = (env.name == 'dropbox' || env.name == 'googleDrive')? 1000 :
  ((env.name == 'aws')? 500: 0);
  // dbx mostly works with 500, except for 1 case when writing 100 files
const BEFORE_DELAY0 = (env.name == 'dropbox' || env.name == 'googleDrive') ? 500 : 0;

const WRITE_TEXT = 'hello world'

describe('FS', function () {
  var dbfs;

  beforeEach(function (done) {
      dbfs = env.dbFS

      async.waterfall([
        function (cb) {
          if (dbfs && dbfs.initFS) {
            dbfs.initFS(cb)
          } else {
            cb(null)
          }
        }
      ], done);
  });

  it('initialises', function  (done) {
    dbfs.exists(testFs, function (exists) {
      if (exists) {
        dbfs.unlink(testFs, function(err) {
          if (err) throw err
          done()
          // setTimeout(function() {return cb();},BEFORE_DELAY)
        });
      } else {
        done()
      }
    });
  });

  it('has functions', function (done) {
    assert.isNotNull(dbfs.readdir);
    console.log('add others')
    done();
  });

  it('can write', function (done) {
    dbfs.writeFile(testFs, WRITE_TEXT, {}, function (err) {
      assert.isNull(err);
      dbfs.exists(testFs, function (exists) {
        assert(exists === true)
        done();
      })
    })
  });

  it('can read file', function (done) {
    dbfs.readFile(testFs, {}, function (err, res) {
      console.log('read file res', res)
      assert.isNull(err);
      assert.isNotNull(res);
      res.should.equal(WRITE_TEXT)
      done();
    })
  });

  it('can rename', function (done) {
    var renamedPath = testFs.split('/')
    var renamedFileName = renamedPath.pop()
    renamedFileName = 'renamed-' + renamedFileName
    renamedPath.push(renamedFileName)
    renamedPath = renamedPath.join('/')
    async.waterfall([
      /*
      function (cb) {
        dbfs.exists(renamedPath, exists) {
          if (exists === true) {
            dbfs.unlink(renamedPath, function(err) {
              assert.isNull(err);
              cb()
            })
          } else if (exists === false) {
            cb()
          } else {
            cb(exists)
          }
        }
      }
      */
      function (cb) {
        dbfs.rename(testFs, renamedPath, cb)
      },
      function(cb) {
        dbfs.exists(renamedPath, function (exists) {
          assert(exists === true)
          cb()
        })
      },
      function(cb) {
        dbfs.exists(testFs, function (exists) {
          assert(exists === false)
          cb()
        })
      },
      function(cb) {
        dbfs.readFile(renamedPath, {}, function (err, contents) {
          assert.isNull(err);
          assert.isNotNull(contents);
          contents.should.equal(WRITE_TEXT)
          cb()
        })
      }
    ], function(err) {
      if (!err) err = null
      assert.isNull(err);
      done()
    })
  });


  // it should get directory files
  // it should overwrite
  // it should makedirectories
  // it should remove folder



});
