// serverUpdates.js
//
/* global  */
const helpers = require('./helpers.js')
const async = require('async')

exports.doUpdates = function (dsManager, oldV, newV, callback) {
  async.forEach(updates, function (update, cb2) {
    if (helpers.newVersionNumberIsHigher(oldV, update.asOfV)) {
      update.execute(dsManager, cb2)
    } else {
      cb2(null)
    }
  }, callback)
}

const updates = [
  {
    asOfV: '0.0.210',
    execute: function (dsManager, callback) {
      function convertNextRecordFromFradminToPublic (dsManager, exceptions, callback) {
        const OLD_PUBLIC_OAC = {
          owner: 'fradmin',
          app_name: 'info.freezr.admin',
          collection_name: 'public_records'
        }
        const NEW_PUBLIC_OAC = {
          owner: 'public',
          app_name: 'info.freezr.public',
          collection_name: 'public_records'
        }
        let oldPublicDb
        let newPublicDb
        let oldRecord
        let recId
        async.waterfall([
          // get old and new Dbs
          function (cb) {
            dsManager.getOrSetUserDS(OLD_PUBLIC_OAC.owner, cb)
          },
          function (userDS, cb) {
            userDS.getorInitDb(OLD_PUBLIC_OAC, null, cb)
          },
          function (theDb, cb) {
            oldPublicDb = theDb
            dsManager.getOrSetUserDS(NEW_PUBLIC_OAC.owner, cb)
          },
          function (userDS, cb) {
            userDS.getorInitDb(NEW_PUBLIC_OAC, null, cb)
          },
          function (theDb, cb) {
            newPublicDb = theDb
            cb(null)
          },

          // query first item
          function (cb) {
            oldPublicDb.query({ _id: { $nin: exceptions } }, { count: 1 }, cb)
          },
          // .. and write it to the new db
          function (oldRecs, cb) {
            if (oldRecs.length === 0) {
              cb(new Error('no more items'))
            } else {
              oldRecord = oldRecs[0]
              recId = oldRecord._id
              delete oldRecord._id
              newPublicDb.create(recId, oldRecord, null, (err, ret) => {
                if (err && err.errorType === 'uniqueViolated') {
                  exceptions.push(recId)
                  cb(null, ret)
                } else {
                  cb(err, ret)
                }
              })
            }
          },
          // ... then delete it in the old db
          function (ret, cb) {
            oldPublicDb.delete_record(recId, null, cb)
          },
          function (ret, cb) {
            cb(null)
          }
        ], function (err) {
          if (err && err.message === 'no more items') {
            callback(null)
            // todo -> should really cacth item already exists error
          } else if (err) {
            console.warn('got err in serverUpdates process', err)
            callback(err)
          } else {
            convertNextRecordFromFradminToPublic(dsManager, exceptions, callback)
          }
        })
      }

      convertNextRecordFromFradminToPublic(dsManager, [], callback)

    }
  }
]
