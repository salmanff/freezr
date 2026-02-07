// freezr.info - Modern ES6 Module - CEPS API Controller
// Controller for CEPS API endpoints
// Calls legacy handlers from app_handler.js
// Middleware in routes sets up req properties that legacy handlers expect

import { sendFailure, sendApiSuccess } from '../../../adapters/http/responses.mjs'
import { startsWith, endsWith, isEmpty, randomText, addToListAsUnique, getUniqueWords, removeFromListIfExists } from '../../../common/helpers/utils.mjs'
import { permissionTypesThatDontNeedTableId, PERMISSION_TYPES_FOR_WHICH_RECORDS_ARE_MARKED } from '../../../middleware/permissions/permissionDefinitions.mjs'
import { generateAppToken } from '../../../middleware/tokens/tokenHandler.mjs'
import { isSystemApp, validFilename } from '../../../common/helpers/config.mjs'
import { convert as convertPicture } from '../../../common/helpers/pictures.mjs'
import { removeStartAndEndSlashes } from '../../../adapters/datastore/fsConnectors/fileHandler.mjs'
import { SYSTEM_PERMS } from '../../../common/helpers/config.mjs'
import path from 'path'
import http from 'http'
import https from 'https'
/**
 * Create CEPS API controller
 * 
 * @param {object} dependencies - Required dependencies
 * @returns {object} Controller object with handler methods
 */
export const createCepsApiController = () => {
  /**
   res.locals.freezr.rightsToTable = {
    own_record: false,
    can_read: false,
    share_records: false,
    can_write: false,
    write_own: false,
    grantedPerms: []
  }
   */

  const ping = function (req, res) {
    res.locals.freezr.permGiven = true
    if (!req.session.logged_in_user_id) {
      return sendApiSuccess(res, { logged_in: false, server_type: 'info.freezr', server_version: freezrPrefs.version })
    } else {
      return sendApiSuccess(res, { logged_in: true, logged_in_as_admin: req.session.logged_in_as_admin, user_id: req.session.logged_in_user_id, server_type: 'info.freezr', storageLimits: res.locals.freezr.freezrStorageLimits  })
    }
  }
  /**
   * POST /ceps/write/:app_table
   * Create a new record
   * Middleware sets up: req.freezrTokenInfo, req.freezrAttributes, req.freezrRequesteeDB
   */
  const writeorUpsertRecord  = async function (req, res) {
    const isOldFormatOrCepsFormat = !req.body?._entity
    const options = isOldFormatOrCepsFormat ? (req.query || {}) : req.body   
    const isUpsert = (options.upsert === 'true' /* oldformat */ || options.upsert === true)
    
    if (isUpsert) {
      return upsertRecord(req, res)
    }

    const dataObjectId = req.params.data_object_id || options.data_object_id || /* feps */ options._id
    // onsole.log('      🔑 writeorUpsertRecord dataObjectId', { dataObjectId, options, freezr: res.locals.freezr, tokenInfo: res.locals.freezr.tokenInfo, oac: res.locals.freezr.appTableDb.oac, appTableDb: res.locals.freezr.rightsToTable })
    const write = isOldFormatOrCepsFormat ? (req.body || {} ): req.body?._entity
    const appTableDb = res.locals.freezr.appTableDb
    const canWrite = res.locals.freezr.rightsToTable.own_record
      || res.locals.freezr.rightsToTable.can_write
      || (res.locals.freezr.rightsToTable.write_own)
    if (canWrite && appTableDb && write) {
      res.locals.freezr.permGiven = true
      if (!res.locals.freezr.rightsToTable.own_record) {
        write._created_by_user = res.locals.freezr.tokenInfo.requestor_id
        write._created_by_app = res.locals.freezr.tokenInfo.app_name
      }
      try {
        const result = await appTableDb.create(dataObjectId, write)
        // onsole.log('write result', { result })
        if (!result || result.error) {
          console.error('❌ Error writing record:', result.error)
          return sendFailure(res, result.error || 'Unknown error', 'writeRecord', 500)
        } else {
          return sendApiSuccess(res, result)
        }
      } catch (err) {
        console.error('❌ Error writing record:', err)
        return sendFailure(res, err, 'writeRecord', 500)
      }
    } else {
      return sendFailure(res, 'Not authorized to write record', 'writeorUpsertRecord', 401)
    }
  }

  const upsertRecord  = async function (req, res) {
    // onsole.log('      🔑 upsertRecord', { body: req.body, query: req.query, params: req.params })
    const isOldFormat = !req.body?._entity
    const write = isOldFormat ? (req.body || {} ): req.body?._entity
    const options = isOldFormat ? (req.query || {}) : req.body   
    const dataObjectId = (req.params.data_object_id || write.data_object_id || write._entity?._id) 
    const appTableDb = res.locals.freezr.appTableDb

    if (!appTableDb || !dataObjectId) {
      return sendFailure(res, 'No appTableDb or dataObjectId', 'upsertRecord', 401)
    }

    let existingRecord = null
    try {
      existingRecord = await appTableDb.read_by_id(dataObjectId)
    } catch (err) {
      console.error('❌ Error reading record for upsert:', err)
      return sendFailure(res, err, 'upsertRecord', 500)
    }
    if (!res.locals.freezr.rightsToTable.own_record) {
      write._created_by_user = res.locals.freezr.tokenInfo.requestor_user_id
      write._created_by_app = res.locals.freezr.tokenInfo.requestor_app
    }
    
    if (existingRecord) {
      const canWrite = res.locals.freezr.rightsToTable.own_record
        || res.locals.freezr.rightsToTable.can_write
        || (res.locals.freezr.rightsToTable.write_own && existingRecord._created_by === res.locals.freezr.tokenInfo.requestor_user_id && existingRecord._created_by_app === res.locals.freezr.tokenInfo.requestor_app)
      
        if (canWrite && appTableDb && write && dataObjectId) {
          res.locals.freezr.permGiven = true
          try {
            const result = await appTableDb.update(dataObjectId, write)
            // onsole.log('write result', { result })
            if (!result || result.error) {
              console.error('❌ Error updating record:', result.error)
              return sendFailure(res, result.error || 'Unknown error', 'writeRecord', 500)
            } else {
              return sendApiSuccess(res, result)
            }
          } catch (err) {
            console.error('❌ Error updating record:', err)
            return sendFailure(res, err, 'writeRecord', 500)
          }
        } else {
          return sendFailure(res, 'Not authorized to write record', 'writeRecord', 401)
        } 

    } else {
      const canWrite = res.locals.freezr.rightsToTable.own_record
        || res.locals.freezr.rightsToTable.can_write
        || res.locals.freezr.rightsToTable.write_own

        if (canWrite && appTableDb && write && dataObjectId) {
          res.locals.freezr.permGiven = true
          try {
            const result = await appTableDb.create(dataObjectId, write)
            // onsole.log('write result', { result })
            if (!result || result.error) {
              console.error('❌ Error creating record:', result.error)
              return sendFailure(res, result.error || 'Unknown error', 'writeRecord', 500)
            } else {
              return sendApiSuccess(res, result)
            }
          } catch (err) {
            console.error('❌ Error creating record:', err)
            return sendFailure(res, err, 'writeRecord', 500)
          }
        } else {
          return sendFailure(res, 'Not authorized to write record', 'writeRecord', 401)
        } 
    }
  }

  const updateRecord  = async function (req, res) {
    // onsole.log('updateRecord req.body', req.body)
    const isOldFormat = !req.body?._entity
    const write = isOldFormat ? (req.body || {} ): req.body?._entity
    const options = isOldFormat ? (req.query || {}) : req.body   
    const isCeps = startsWith(req.url, '/ceps/')
    const replaceAllFields = isCeps ? true : (options.replaceAllFields === 'true' || options.replaceAllFields === true)
    const isQueryBasedUpdate = (!isCeps && !req.params.data_object_id && req.body.q && req.body.keys)
    if (req.params.data_object_start) {
      // onsole.log('      🔑 updateRecord data_object_start', { data_object_start: req.params.data_object_start, path: req.path })
      const parts = req.path.split('/').slice(3)
      req.params.data_object_id = parts.join('/')
    }
    const dataObjectId = (req.params.data_object_id || write._id)
    const appTableDb = res.locals.freezr.appTableDb
    let existingRecord = null
    if (dataObjectId) {
      try {
        existingRecord = await appTableDb.read_by_id(dataObjectId)
      } catch (err) {
        console.error('❌ Error reading record for update:', err)
        return sendFailure(res, err, 'updateRecord', 500)
      }
    }

    // onsole.log('updateRecord', { write, options, isCeps, replaceAllFields, isQueryBasedUpdate, dataObjectId, existingRecord })

    const canWrite = res.locals.freezr.rightsToTable.own_record 
      || res.locals.freezr.rightsToTable.can_write
      || (res.locals.freezr.rightsToTable.write_own && existingRecord && existingRecord._created_by === res.locals.freezr.tokenInfo.requestor_user_id && existingRecord._created_by_app === res.locals.freezr.tokenInfo.requestor_app)
      || (res.locals.freezr.rightsToTable.write_own && isQueryBasedUpdate)

    if (!res.locals.freezr.rightsToTable.own_record) {
      if (existingRecord) {
        write._created_by_user = existingRecord._created_by
        write._created_by_app = existingRecord._created_by_app
      } else if (isQueryBasedUpdate) {
        write.q._created_by_user = res.locals.freezr.tokenInfo.requestor_user_id
        write.q._created_by_app = res.locals.freezr.tokenInfo.requestor_app
      }
    }

    if (!existingRecord && !isQueryBasedUpdate) {
      return sendFailure(res, 'Record not found', 'updateRecord', 404)
    } else if (existingRecord && isQueryBasedUpdate) {
      return sendFailure(res, 'Query based update not supported', 'updateRecord', 401)
    } else if (canWrite && appTableDb && write) {
      res.locals.freezr.permGiven = true
      try {
        let result = null
        if (existingRecord) {
          result = await appTableDb.update(dataObjectId.toString(), write, { replaceAllFields, old_entity: existingRecord })
          // onsole.log('update result', { result })
          result._id = dataObjectId
          result._date_created = existingRecord._date_created
        } else { // isQueryBasedUpdate
          result = await appTableDb.update(req.body.q, req.body.keys)
          result._date_modified = Date.now()
        }
        // onsole.log('write result', { result })
        if (!result || result.error) {
          console.error('❌ Error updating record:', result.error)
          return sendFailure(res, result.error || 'Unknown error', 'writeRecord', 500)
        } else {
          return sendApiSuccess(res, result)
        }
      } catch (err) {
        console.error('❌ Error updating record:', err)
        return sendFailure(res, err, 'writeRecord', 500)
      }
    } else {
      return sendFailure(res, 'Not authorized to write record', 'writeRecord', 401)
    }
  }

  /**
   * GET /ceps/read/:app_table/:data_object_id
   * Read a record by ID
   * Middleware sets up: req.freezrTokenInfo, req.freezrAttributes, req.freezrRequesteeDB
   */
  const readRecordById = async (req, res) => {
    // onsole.log('readRecordById', { req: req.params })
    
    const dataObjectId = req.params.data_object_id
    const appTableDb = res.locals.freezr.appTableDb

    const mayBeCanRead = res.locals.freezr.rightsToTable.own_record 
      || res.locals.freezr.rightsToTable.can_read
      || res.locals.freezr.rightsToTable.can_write
      || res.locals.freezr.rightsToTable.write_own
      || res.locals.freezr.rightsToTable.write_own_inner
      || res.locals.freezr.rightsToTable.share_records

    if (!mayBeCanRead) {
      console.warn('readRecordById permGiven - not maye be even', { rights: res.locals.freezr.rightsToTable, perms: res.locals.freezr.rightsToTable.grantedPermsFaddRightsToTable })
      return sendFailure(res, 'Not authorized to read record (1)', 'readRecordById', 401)
    }

    let fetchedRecord = null
    try {
      fetchedRecord = await appTableDb.read_by_id(dataObjectId)
    } catch (err) {
      console.error('❌ Error reading record by ID:', err)
      return sendFailure(res, err, 'readRecordById', 500)
    }
    // onsole.log('readRecordById permGiven 1', { aoc: appTableDb.oac, dataObjectId, fetchedRecord })

    if (res.locals.freezr.rightsToTable.own_record || res.locals.freezr.rightsToTable.can_read || res.locals.freezr.rightsToTable.can_write) {
      res.locals.freezr.permGiven = true
      if (!fetchedRecord) {
        return sendFailure(res, 'no related records exist', 'readRecordById', 401)
      }
      if (!res.locals.freezr.rightsToTable.own_record) delete fetchedRecord._accessible
      return sendApiSuccess(res, fetchedRecord)
    }

    // Conditional read with write_own or share_records
    const requestee = res.locals.freezr.tokenInfo.requestor_id // .replace(/\./g, '_')

    
    let relevantPerm = null
    let accessToRecord = false
    let permittedRecord

    res.locals.freezr.rightsToTable.grantedPerms.forEach(aPerm => {
      
      if (aPerm.type === 'write_own' && fetchedRecord._created_by_user === res.locals.freezr.tokenInfo.requestor_user_id && fetchedRecord._created_by_app === res.locals.freezr.tokenInfo.app_name) {
        accessToRecord = true
        relevantPerm = aPerm
      } else if (Array.isArray(fetchedRecord._accessibles) && fetchedRecord._accessibles.length > 0) {
        const accessibleObj = fetchedRecord._accessibles.find(obj =>
          obj.grantee === requestee &&
          obj.requestor_app === aPerm.requestor_app &&
          obj.permission_name === aPerm.name &&
          obj.granted === true
        )
        if (accessibleObj) {
          accessToRecord = true
          relevantPerm = aPerm
        }
      }
    })
    if (accessToRecord) {
      // onsole.log('readRecordById permGiven - accessToRecord', { accessToRecord, relevantPerm, fetchedRecord, perms: res.locals.freezr.rightsToTable.grantedPerms })
      if (!relevantPerm) console.warn('relevant perm mismath 0 to reiew')
      if (relevantPerm.return_fields && relevantPerm.return_fields.length > 0) {
        permittedRecord = {}
        relevantPerm.return_fields.forEach(key => {
          permittedRecord[key] = fetchedRecord[key]
        })
      } else {
        permittedRecord = fetchedRecord
      }
      delete permittedRecord._accessible
    } else {
      // onsole.log('readRecordById permGiven - not accessToRecord', { accessToRecord, relevantPerm, fetchedRecord, perms: res.locals.freezr.rightsToTable.grantedPerms })
      return sendFailure(res, 'No matching permissions exist (0)', 'readRecordById', 401)
    }

    res.locals.freezr.permGiven = true
    if (!permittedRecord) {
      return sendFailure(res, 'no related records exist or are permitted', 'readRecordById', 401)
    } else {
      return sendApiSuccess(res, permittedRecord)
    }
  }

  /**
   * GET /ceps/query/:app_table
   * Query records
   * Middleware sets up: req.freezrTokenInfo, req.freezrAttributes, req.freezrRequesteeDB
   */
  const dbQuery = async (req, res) => {

    // onsole.log('dbQuery ', { reqquery: req.query, reqbody: req.body, reqparams: req.params })
    
    // ceps query coversion... to body
    if ((!req.body || isEmpty(req.body)) && req.query && !isEmpty(req.query)) {
      // Traverse req.query and convert numeric strings to real numbers (for ceps queries)
      if (req.query && typeof req.query === 'object') {
        const convertNumericStrings = (obj) => {
          Object.keys(obj).forEach(key => {
            const val = obj[key]
            if (typeof val === 'string' && val.trim() !== '' && !isNaN(val) && isFinite(val)) {
              // Only convert if it is a numeric string (and not empty/space)
              obj[key] = Number(val)
            } else if (val && typeof val === 'object' && !Array.isArray(val)) {
              convertNumericStrings(val)
            }
          })
        }
        convertNumericStrings(req.query)
      }
      if (req.query._modified_after) {
        req.query._date_modified = { $gt: parseInt(req.query._modified_after) }
        delete req.query._modified_after
      }
      if (req.query._modified_before) {
        req.query._date_modified = { $lt: parseInt(req.query._modified_before) }
        delete req.query._modified_before
      }
      req.body = { q: req.query } // in case of a GET statement (ie move query to body)
      // consider useing this for count and skip
      // if (req.query._count) {
      //   req.body.count = req.query._count
      //   delete req.body.q._count
      // }
    }

    const mayBeCanRead = res.locals.freezr.rightsToTable.own_record 
      || res.locals.freezr.rightsToTable.can_read
      || res.locals.freezr.rightsToTable.can_write
      || res.locals.freezr.rightsToTable.write_own
      || res.locals.freezr.rightsToTable.write_own_inner // used for public records
      || res.locals.freezr.rightsToTable.share_records

    if (!mayBeCanRead || (res.locals.freezr.rightsToTable.share_records && res.locals.freezr.rightsToTable.grantedPerms.length === 0)) {
      console.warn('dbQuery mayBeCanRead - not mayBeCanRead', { mayBeCanRead, rightsToTable: res.locals.freezr.rightsToTable, grantedPerms: res.locals.freezr.rightsToTable.grantedPerms })
      return sendFailure(res, 'Not authorized to read record (2)', 'readRecordById', 401)
    }

    let theQuery = req.body.q || {}

    // Permissions
    let thePerm = null
    if (res.locals.freezr.rightsToTable.own_record || res.locals.freezr.rightsToTable.can_read) {
      res.locals.freezr.permGiven = true
    } else {

      res.locals.freezr.rightsToTable.grantedPerms.forEach(aPerm => {
        if (aPerm.type === 'write_all' || aPerm.type === 'read_all') {
          thePerm = aPerm
        } else if (aPerm.type === 'write_own') {
          thePerm = aPerm
          theQuery._created_by_user = res.locals.freezr.tokenInfo.requestor_id
          theQuery._created_by_app = res.locals.freezr.tokenInfo.app_name
        } else if (aPerm.type === 'write_own_inner') { // for public records
          thePerm = aPerm
          theQuery.data_owner = res.locals.freezr.tokenInfo.requestor_id
        } else if (aPerm.type === 'db_query') {
          // sendFailure(res, 'db_query permission type NOT yet functional', 'dbQuery')
          // const checkQueryParamsPermitted = function (queryParams, permittedFields) {
          //   let err = null
          //   if (Array.isArray(queryParams)) {
          //     queryParams.forEach(function (item) {
          //       err = err || checkQueryParamsPermitted(item, permittedFields)
          //     })
          //   } else {
          //     for (const key in queryParams) {
          //       if (key === '$and' || key === '$or') {
          //         return checkQueryParamsPermitted(queryParams[key], permittedFields)
          //       } else if (['$lt', '$gt', '_date_modified'].indexOf(key) > -1) {
          //         // do nothing
          //       } else if (permittedFields.indexOf(key) < 0) {
          //         return (new Error('field not permitted ' + key))
          //       }
          //     }
          //   }
          //   return (err)
        } else if (aPerm.type === 'share_records') {
          if (!thePerm) {
            thePerm = aPerm
            theQuery['_accessibles.grantee'] = res.locals.freezr.tokenInfo.requestor_user_id
            theQuery['_accessibles.granted'] = true // should be redundant
          }
        }
      })
      if (!thePerm) {
        console.warn('dbQuery no matching permissions exist', { thePerm, theQuery, rightsToTable: res.locals.freezr.rightsToTable, grantedPerms: res.locals.freezr.rightsToTable.grantedPerms })
        return sendFailure(res, 'No matching permissions exist - dbq', 'dbQuery', 401)
      } else {
        res.locals.freezr.permGiven = true
      }
    }

    // Query
    const skip = req.body.skip ? parseInt(req.body.skip) : 0
    let count = req.body.count ? parseInt(req.body.count) : (req.params.max_count ? req.params.max_count : 500)
    if (thePerm && thePerm.max_count && count + skip > thePerm.max_count) {
      count = Math.max(0, thePerm.max_count - skip)
    }

    let sort = (thePerm && thePerm.sort_fields) ? thePerm.sort_fields : req.body.sort
    if (!sort) sort = { _date_modified: -1, _id: -1 } // default - include _id for stable sorting with skip

    // transform regexes
    const transformQueryRegexes = function (q) {
      const ret = {}
      for (const [key, value] of Object.entries(q)) {
        if (key === '$regex' && typeof value === 'string') {
          ret[key] = new RegExp(value, 'i')
        } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || !value) {
          ret[key] = value
        } else if (Array.isArray(value)) {
          ret[key] = value.map(inner => transformQueryRegexes(inner))
        } else if (typeof value === 'object') {
          ret[key] = transformQueryRegexes(value)
        } else {
          console.warn('FUNNY EXPRESSION PASSED', { key, value })
          ret[key] = value
        }
      }
      return ret
    }
    try {
      const transfedRegex = transformQueryRegexes(theQuery)
      theQuery = transfedRegex
    } catch (e) {
      console.warn('Couldnot tranfrm query ', { e }, JSON.stringify(theQuery))
    }

    const appTableDb = res.locals.freezr.appTableDb
    let queryResults = null
    try {
      queryResults = await appTableDb.query(theQuery, { sort, count, skip })
      // onsole.log('dbQuery queryResults', { theQuery, resultCount: queryResults?.length, skip, count })
    } catch (err) {
      console.error('❌ Error querying database:', err)
      return sendFailure(res, err, 'dbQuery', 500)
    }
    // onsole.log('cepefepsquery - > queryResults', { theQuery, queryResults })
    if (queryResults.error) {
      console.warn('db_query - got err for theQuery ', theQuery, { err: queryResults.error })
      return sendFailure(res, queryResults.error, 'dbQuery', 500)
    }


    if (thePerm && queryResults && queryResults.length > 0) {
      // onsole.log('dbQuery queryResults 1 and 2', { thePerm, queryResults1: queryResults[0], queryResults2: queryResults.length > 1 ? queryResults[1] : null })
      queryResults.map(anitem => {
        anitem._owner = res.locals.freezr.tokenInfo.data_owner_user_id
        return anitem
      })
      if (thePerm.return_fields && thePerm.return_fields.length > 0) {
        const reduceToPermittedFields = function (record, returnFields) {
          if (record._accessible) delete record._accessible
          if (!returnFields) return record
        
          returnFields.push('_date_modified')
          if (returnFields._accessible) delete returnFields._accessible
          const returnObj = {}
          returnFields.forEach((aField) => { returnObj[aField] = record[aField] })
          return returnObj
        }
        queryResults = queryResults.map(record => { return reduceToPermittedFields(record, thePerm.return_fields) })
      }
      //onsole.log('dbQuery queryResults post ', { thePerm, queryResults1: queryResults[0], queryResults2: queryResults.length > 1 ? queryResults[1] : null })
        
      // const sorter = function (sortParam) {
      //   const key = Object.keys(sortParam)[0]
      //   return function (obj1, obj2) {
      //     return sortParam[key] > 0 ? (obj1[key] > obj2[key]) : obj1[key] < obj2[key]
      //   }
      // }
      // results.sort(sorter(sort))
    }

    // if (manifest_permission_schema.max_count && all_permitted_records.length>manifest_permission_schema.max_count)  all_permitted_records.length=manifest_permission_schema.max_count
    if (res.locals.freezr.internalcallfwd) {
      res.locals.freezr.internalcallfwd(err, queryResults)
    } else {
      return sendApiSuccess(res, queryResults)
    }
  }

  /**
   * DELETE /ceps/delete/:app_table/:data_object_id
   * Delete a record
   * Middleware sets up: req.freezrTokenInfo, req.freezrAttributes, req.freezrRequesteeDB
   */
  const deleteRecords = async (req, res) => {
    // Get data_object_id or ensure delete query
    if (req.params.data_object_start) {
      // onsole.log('      🔑 deleteRecords data_object_start', { data_object_start: req.params.data_object_start, path: req.path })
      const parts = req.path.split('/').slice(3)
      req.params.data_object_id = parts.join('/')
    } else if (!req.params.data_object_id) {
      // onsole.log('NO DATA ID - DELEE BY QUERY ')
      if (!req.body?.q) {
        return sendFailure(res, 'No data query to delete', 'deleteRecords')
      }
    }
    // onsole.log('deleteRecords req.params', { params: req.params, body: req.body })

    // Ensure permission exists
    let canDelete = false
    if (res.locals.freezr.rightsToTable.own_record || res.locals.freezr.rightsToTable.can_write) {
      canDelete = true
      res.locals.freezr.permGiven = true
    } else if (res.locals.freezr.rightsToTable.write_own) {
      if (!req.params.data_object_id) {
        return sendFailure(res, 'can only delete write_own with a data_object_id - can change this isn the future to modify delte query', 'deleteRecords')
      }
      let existingRecord = null
      if (req.params.data_object_id) {
        // onsole.log('deleteRecords existingRecord', { data_object_id: req.params.data_object_id, freezr: res.locals.freezr })
        try {
          existingRecord = await res.locals.freezr.appTableDb.read_by_id(req.params.data_object_id)
        } catch (err) {
          console.error('❌ Error reading record for delete:', err)
          return sendFailure(res, err, 'deleteRecords', 500)
        }
      }
      if (existingRecord?._created_by_user !== res.locals.freezr.tokenInfo.requestor_id || 
        existingRecord?._created_by_app !== res.locals.freezr.tokenInfo.app_name) {
        // onsole.log('deleteRecords existingRecord', { user1: existingRecord?._created_by_user, user2: res.locals.freezr.tokenInfo.requestor_id, app1: existingRecord?._created_by_app, app2: res.locals.freezr.tokenInfo.app_name, usereq: (res.locals.freezr.tokenInfo.requestor_id === existingRecord?._created_by_user), appeq: (res.locals.freezr.tokenInfo.app_name === existingRecord?._created_by_app) })
        // onsole.log('deleteRecords unauthorized record access', { existingRecord, freezr: res.locals.freezr })
        return sendFailure(res, 'unauthorized record access', 'deleteRecords')
      }
      res.locals.freezr.permGiven = true
      canDelete = true
    } else if (res.locals.freezr.rightsToTable.write_own_inner) { // public records
      if (!req.params.data_object_id) {
        return sendFailure(res, 'can only delete write_own_inner with a data_object_id - can change this isn the future to modify delte query', 'deleteRecords')
      }
      let existingRecord = null
      if (req.params.data_object_id) {
        // onsole.log('deleteRecords existingRecord', { data_object_id: req.params.data_object_id, freezr: res.locals.freezr })
        try {
          existingRecord = await res.locals.freezr.appTableDb.read_by_id(req.params.data_object_id)
        } catch (err) {
          console.error('❌ Error reading record for delete:', err)
          return sendFailure(res, err, 'deleteRecords', 500)
        }
      }
      
      if (existingRecord?.data_owner !== res.locals.freezr.tokenInfo.requestor_id || 
        res.locals.freezr.tokenInfo.app_name !== 'info.freezr.account') {
        // console.warn('deleteRecords unauthorized record access', { existingRecord, freezr: res.locals.freezr })
        return sendFailure(res, 'unauthorized record access to modify public records', 'deleteRecords')
      }
      res.locals.freezr.permGiven = true
      canDelete = true
    } else {
      return sendFailure(res, 'Not authorized to delete record - unknown permission', 'deleteRecords')
    }

    // handle files
    if (endsWith(req.params.app_table, '.files')) {
      if (startsWith(req.path, '/ceps/delete')) {
        return sendFailure(res, 'cannot apply ceps to files', 'deleteRecords')
      } else if (!req.params.data_object_id) {
        return sendFailure(res, 'Currently can only delete one file at a time', 'deleteRecords')
      } else {
        const endpath = req.params.data_object_id
        try {
          // onsole.log('      🔑 deleteRecords removeFile', { endpath, freezr: res.locals.freezr })
           await res.locals.freezr.appFS.removeFile(endpath, {}) 
        } catch (err) {
          console.warn('err in remove file ', {endpath, err })
          return sendFailure(res, 'error removing file ' + err.message, { function: 'deleteRecords', error: err})
        }
      }
    } 

    try {
      // onsole.log('      🔑 deleteRecords deleteRecords', { object_id: req.params.data_object_id, body: req.body })
      let deleteConfirm = null
      if (req.params.data_object_id) {
        deleteConfirm = await res.locals.freezr.appTableDb.delete_record(req.params.data_object_id, null)
      } else {
        deleteConfirm = await res.locals.freezr.appTableDb.delete_records(req.body.q, null)
      }
      // onsole.log('      🔑 deleteRecords deleteConfirm', { deleteConfirm, object_id: req.params.data_object_id, body: req.body })
      // const deleteConfirm = req.params.data_object_id 
      //   ? await res.locals.freezr.appTableDb.delete_record(req.params.data_object_id, null)
      //   : await res.locals.freezr.appTableDb.delete_records(req.body, null)
      // if (!deleteConfirm) {
      //   console.warn('unknown write error 2', { freezr: res.locals.freezr, appTableDb: res.locals.freezr.appTableDb, deleteConfirm, object_id: req.params.data_object_id, body: req.body })
      //   return sendFailure(res, 'unknown write error', 'deleteRecords')
      // }
      return sendApiSuccess(res, { success: true, deleteConfirm })
    } catch (err) {
      console.error('❌ Error deleting records:', { err, object_id: req.params.data_object_id })
      return sendFailure(res, 'could not delete records: ' + err.message, { function: 'deleteRecords', error: err })
    }
  
  }


  /**
   * POST /feps/restore/:app_table
   * Restore a deleted record
   */
  const restoreRecord = async (req, res) => {
    try {
      const write = req.body.record
      const options = req.body.options || {}
      const dataObjectId = options.data_object_id
      const isUpdate = dataObjectId && options.updateRecord
      const isUpsert = dataObjectId && options.upsertRecord

      const appTable = req.params.app_table
      const freezr = res.locals.freezr
      const appTableDb = freezr.appTableDb

      if (!appTableDb) {
        return sendFailure(res, 'Internal error - database not found', 'restoreRecord', 500)
      }

      // Check permissions - must be logged in and requesting proper permissions
      const userId = req.session.logged_in_user_id
      const ownerId = freezr.tokenInfo?.owner_id
      const requestorApp = freezr.tokenInfo?.app_name

      //  && freezr.tokenInfo?.actualRequester !== 'info.freezr.account'

      if (!userId || userId !== ownerId || (requestorApp !== 'info.freezr.account')) {
        return sendFailure(res, 'need to be logged in and requesting proper permissions', 'restoreRecord', 401)
      }

      if (Object.keys(write).length <= 0) {
        return sendFailure(res, 'No data to write', 'restoreRecord', 400)
      }

      // Check if it's a permission restore (admin only)
      // todo re-review this after movign public_records to publc owner rather than fradmin
      // .. also allow users to change their own public records
      const permissionRestore = (appTable === 'info.freezr.admin.public_records')
      if (permissionRestore && !req.session.logged_in_as_admin) {
        return sendFailure(res, 'need to be admin to restore admin records', 'restoreRecord', 403)
      }

      let existingRecord = null
      if (dataObjectId) {
        try {
          existingRecord = await appTableDb.read_by_id(dataObjectId)
        } catch (err) {
          // Record doesn't exist, which is fine for restore
        }
      }
      // onsole.log('restoreRecord existingRecord', { existingRecord, isUpdate, isUpsert })

      if (existingRecord && (isUpdate || isUpsert) && existingRecord._date_created) {
        // Update existing record
        await appTableDb.update(dataObjectId.toString(), write, { old_entity: existingRecord, restoreRecord: true, replaceAllFields: true })
        res.locals.freezr.permGiven = true
        return sendApiSuccess(res, { _id: dataObjectId, _date_modified: write._date_modified, _date_created: write._date_created })
      } else if (existingRecord && !isUpdate && !isUpsert) {
        return sendFailure(res, 'Existing record found when this should not be an update', { function: 'restoreRecord'}, 400)
      } else if (isUpdate && !existingRecord) {
        console.warn('      🔑 restoreRecord record not found for an update restore', { dataObjectId, write, existingRecord })
        return sendFailure(res, 'record not found for an update restore', { function: 'restoreRecord' }, 404)
      } else {
        // Create new record
        if (isUpdate) throw new Error('SNBJ - isUpdate cannot create a new record')
        if (write._id) delete write._id
        const result = await appTableDb.create(dataObjectId, write, { restoreRecord: true })
        res.locals.freezr.permGiven = true
        return sendApiSuccess(res, {
          _id: result._id,
          _date_created: result._date_created,
          _date_modified: result._date_modified
        })
      }
    } catch (err) {
      return sendFailure(res, 'error restoring record: ' + err.message, { function: 'restoreRecord', error: err }, 500)
    }
  }


  /**
   * POST /ceps/perms/share_records
   * Share records with grantees
   * Middleware sets up: req.freezrTokenInfo, req.freezrUserPermsDB, req.freezrRequesteeDB, req.freezrPublicRecordsDB
   */
  const shareRecords = async (req, res) => {
    /*

      Options - CEPS
      name: permissionName - OBLOGATORY
      'table_id': app_name (defaults to app self) - OBLOGATORY
      grantee or list of 'grantees': people being granted access - OBLOGATORY
      'action': 'grant' or 'deny' // default is grant 
      doNotList: whether the record shoudl show up on the feed - default is false

      NON CEPS options
      publicid: sets a publid id instead of the automated accessible_id (nb old was pid)
      pubDate: sets the publish date
      unlisted - for public items that dont need to be lsited separately in the public_records database
      idOrQuery being query is semi-CEPS - ie query_criteria or object_id_list - can be null for read_all, write_all
      fileStructure - for serving user uploaded web pages => json object with {js: [], css:[]}
    */
    res.locals.flogger.track('shareRecords - test extra log', { function: 'shareRecords', requestorApp: res.locals.freezr.tokenInfo.app_name, userId: res.locals.freezr.tokenInfo.requestor_id })

    
    const queryFromBody = function (doGrant, rec) { 
      if (!rec) return null
      if (typeof rec === 'string' && doGrant) return { _id: rec }
      if (Array.isArray(rec)) return { $or: rec.map(arec => { return ({ _id: (typeof arec === 'string') ? arec : '' }) }) }
      if (typeof rec === 'object') {
        if (rec.publicid) {
          // onsole.log('🔑 shareRecords queryFromBody publicid', { "_accessibles.public_id": rec.publicid })
          return { "_accessibles.public_id": rec.publicid }
        }
        return rec
      }
      return null
    }
    const doGrant = req.body.action === 'grant' || req.body.grant === true
    const recordQuery = queryFromBody(doGrant, req.body.record_id || req.body.object_id_list || req.body.query_criteria)
    const datePublished = req.body.action === 'grant' ? (req.body.pubDate ? req.body.pubDate : new Date().getTime()) : null
    const isHtmlMainPage = req.body.isHtmlMainPage

    // onsole.log('🔑 shareRecords recordQuery', { recordQuery, body: req.body, criteria: req.body.query_criteria })
    
    const userId = res.locals.freezr.tokenInfo.requestor_id // requestor and requestee are the same
    
    let accountRequestedrequestorApp = null
    if (req.session.logged_in_user_id && req.session.logged_in_user_id === userId && res.locals.freezr.tokenInfo.app_name === 'info.freezr.account' && req.body.requestor_app) {
      // info.freezr.account can have access to any requestor_app
      accountRequestedrequestorApp = req.body.requestor_app
      delete recordQuery.requestor_app
    }
    const requestorApp = accountRequestedrequestorApp || res.locals.freezr.tokenInfo.app_name

    const permissionName = req.body.name
    let newRecordUniquePublicId = null

    const appTableId = req.body.table_id
    
    const proposedGrantees = req.body.grantees || []
    const allowedGrantees = []
    const granteesNotAllowed = []
    let recordsToChange = []
    let recordsChanged = 0

    const incompleteTransactionErrors = []
    
    // 1. initial checks
    if (req.body.publicid &&
      (typeof req.body.record_id !== 'string' ||
      ((!req.session.logged_in_as_admin && !req.session.logged_in_as_publisher) && !startsWith(req.body.publicid, ('@' + req.session.logged_in_user_id + '/' + requestorApp))))) { // implies: req.body.grantees.includes('_public') or 'privtefeed or privatelink'
      if (typeof req.body.record_id !== 'string') {
        return sendFailure(res, 'input error - cannot assign a public id to more than one entity - please include one record if under record_id', { function: 'shareRecords', requestorApp, userId })
      } else {
        return sendFailure(res, 'input error - non-admin and users who have no publishing rights  should always use the users name in their publicid, starting with an @ sign.', { function: 'shareRecords', requestorApp, userId })
      }
      // todo - possible future conflict if a user signs up with a name which an admin wants to use for their url
    } else if (isHtmlMainPage && (!req.body.grantees.includes('_public') || typeof req.body.record_id !== 'string' || !endsWith(appTableId, '.files') || !endsWith(req.body.record_id, 'html'))) {
      return sendFailure(res, 'input error - cannot assign a file structure to more than one entity, and it has to be made public, and end with html', { function: 'shareRecords', requestorApp, userId })
    } else if (!permissionName) {
      return sendFailure(res, 'error - need permission name to set access', { function: 'shareRecords', requestorApp, userId })
    } else if (!req.body.grantees || req.body.grantees.length < 1) {
      return sendFailure(res, 'error - need people or gorups to grant permissions to.', { function: 'shareRecords', requestorApp, userId })
    } else if (!requestorApp) {
      return sendFailure(res, 'internal error getting requestor app')
    } else if (!userId) {
      return sendFailure(res, 'internal error getting user id')
    } else if (appTableId !== res.locals.freezr.appTableDb.oac.app_table) {
      console.warn('The table being granted permission to does not correspond to the permission (1) ', { appTableId, appTableFromAppTableDb: res.locals.freezr.appTableDb.oac.app_table })
      return sendFailure(res, 'The table being granted permission to does not correspond to the permission ', { function: 'shareRecords', requestorApp, userId, appTableId, appTableFromAppTableDb: res.locals.freezr.appTableDb.oac.app_table })
    }

    // 2.get the permission record and do basic checks
    let permQueryResults = null
    // onsole.log('🔑 permQueryResults', { permissionName, requestorApp, isSystemApp: isSystemApp(requestorApp) })
    if (isSystemApp(requestorApp)) {
      permQueryResults = [SYSTEM_PERMS[permissionName]]
    } else {
      try {
        permQueryResults = await res.locals.freezr.ownerPermsDb.query({ name: permissionName, requestor_app: requestorApp }, {})
      } catch (err) {
        console.error('❌ Error querying permissions:', err)
        return sendFailure(res, err, 'shareRecords', 500)
      }
    }
    // onsole.log('🔑 permQueryResults', { permQueryResults })

    const grantedPermission = permQueryResults && permQueryResults.length > 0 ? permQueryResults[0] : null
    if (!permQueryResults || permQueryResults.length === 0) {
      return sendFailure(res, 'permission with name ' + permissionName + ' and app ' + requestorApp + 'does not exist - try re-installing app', { function: 'shareRecords', requestorApp, userId })
    } else if (!grantedPermission.granted) {
      return sendFailure(res, 'permission not granted yet', { function: 'shareRecords', requestorApp, userId })
    } else if (appTableId && grantedPermission.table_id !== appTableId && !grantedPermission.table_id.includes(appTableId)) {
      console.warn('The table being granted permission to does not correspond to the permission (2)', { grantedPermission, appTableId })
      return sendFailure(res, 'The table being granted permission to does not correspond to the permission (2)', { function: 'shareRecords', requestorApp, userId })
    } else if (appTableId && permissionTypesThatDontNeedTableId().includes(grantedPermission.type) && grantedPermission.type !== 'upload_pages') {
      // upload_pages exception - technically they do not need one as it goes into files, but table id is added in the route chain 
      return sendFailure(res, 'Table id passed onto a permission type that doesnt need it.', { function: 'shareRecords', requestorApp, userId })
    } else if (grantedPermission.type === 'upload_pages' && appTableId.split('.').pop() !== 'files') {
      return sendFailure(res, 'Upload pages permission can only be used on files', { function: 'shareRecords', requestorApp, userId })
    } else if (PERMISSION_TYPES_FOR_WHICH_RECORDS_ARE_MARKED.includes(grantedPermission.type) // ie share_records, message_records, upload_pages
      && !grantedPermission.table_id.includes(res.locals.freezr.appTableDb.oac.app_table)) {
        // removed grantedPermission.table_id === res.locals.freezr.appTableDb.oac.app_table)
        console.warn('The table being granted permission to does not correspond to the permission (3)', { grantedPermission, appTableId, appTableFromAppTableDb: res.locals.freezr.appTableDb.oac.app_table })
        return sendFailure(res, 'The table being granted permission to does not correspond to the permission ', { function: 'shareRecords', requestorApp, userId })
    }
    if (permQueryResults.length > 1) {
      console.warn('two permissions found where one was expected - SNBH - System Error ' + JSON.stringify(permQueryResults))
    } 

    // OLD CHECKS DISCARDED ON INCORPORATED INTO ABOVE
    // let permDoesntNeedTableId = false
    // permDoesntNeedTableId = PERMS_WITH_ACCESS_TO_ALL_RECORDS.indexOf(grantedPermission.type) >= 0 || grantedPermission.type === 'use_app'
    // if (!recordQuery && !permDoesntNeedTableId) {
    //   sendFailure(res, 'Missing query to set access', { function: 'shareRecords', requestorApp, userId })
    // } else if (
    //   (grantedPermission.type === 'share_records' || grantedPermission.type === 'message_records') 
    //   && (grantedPermission.table_id.includes(res.locals.freezr.appTableDb.oac.app_table) || grantedPermission.table_id === res.locals.freezr.appTableDb.oac.app_table) 
    //   && !req.body.fileStructure && !isHtmlMainPage) {
    //     // continue
    // } else if (grantedPermission.type === 'upload_pages' && res.locals.freezr.appTableDb.oac.app_table.split('.').pop() === 'files') {
    //     // continue        
    // } else if (permDoesntNeedTableId) {
    //     // continue
    // } else {
    //   console.error('Permission type mismatch for sharing', { grantedPermission, oacFromAppTableDb: res.locals.freezr.appTableDb.oac, recordQuery })
    //   return sendFailure(res, 'Permission type mismatch for sharing', { function: 'shareRecords', requestorApp, userId })
    // }
      

    // 3. Validate proposedGrantees and construct allowedGrantees
    let tooManyRequests = false
    let hasPublicLink = false
    let hasPrivateFeed = false
    let privateFeedCode = null
    let hasPrivateLink = false
    let codeOrName = null
    let feedName
    let code = null
    for (let grantee of proposedGrantees) {
      if (typeof grantee !== 'string') {
        return sendFailure(res, 'can only share with strings', { function: 'shareRecords', requestorApp, userId })
      } else if (grantee === '_public') {
        if (hasPublicLink || hasPrivateLink || hasPrivateFeed) tooManyRequests = true
        hasPublicLink = true
        // todo-later conside grantedPermission.allowPublic to explicitly allow sharing with public
        allowedGrantees.push(grantee)
      } else if (grantee === '_privatelink') {
        if (hasPublicLink || hasPrivateLink || hasPrivateFeed) tooManyRequests = true
        hasPrivateLink = true
        // todo-later conside grantedPermission.allowPublic to explicitly allow sharing with public
        allowedGrantees.push(grantee)
      } else if (startsWith(grantee, 'group:')) {
        const name = grantee.substring(('group:'.length))
        let groupResults = null
        try {
          groupResults = await res.locals.freezr.cepsGroupsDB.query({ name }, null)
        } catch (err) {
          res.locals.flogger.error('Error querying groups', { function: 'shareRecords', requestorApp, userId, error: err })
          granteesNotAllowed.push(grantee)
          continue
        }
        if (groupResults && groupResults.length > 0) {
          allowedGrantees.push(grantee)
        } else {
          granteesNotAllowed.push(grantee)
        }
      } else if (startsWith(grantee, '_privatefeed:')) {      
        if (hasPublicLink || hasPrivateLink || hasPrivateFeed) tooManyRequests = true
        hasPrivateFeed = true
        const name = grantee.substring(('_privatefeed:'.length))
        let privateFeedResults = null
        try {
          privateFeedResults = await res.locals.freezr.cepsPrivateFeedsDB.query({ name }, null)
        } catch (err) {
          res.locals.flogger.error('Error querying private feeds', { function: 'shareRecords', requestorApp, userId, error: err })
          granteesNotAllowed.push(grantee)
          continue
        }
        if (privateFeedResults && privateFeedResults.length > 0) {
          privateFeedCode = privateFeedResults[0].code
          allowedGrantees.push(grantee)
        } else {
          granteesNotAllowed.push(grantee)
        }
      } else { // if (grantee.indexOf('@') > 0)
        grantee = grantee.replace(/\./g, '_')
        if (res.locals.freezr.userPrefs.blockMsgsFromNonContacts) {
          // to do - implement BlockMsgsFromNonContacts redo below for grantees with no servername
          const granteeParts = grantee.split('@')
          if (granteeParts.length < 2) {
            return sendFailure(res, 'need to implement for internal contact', { function: 'shareRecords', requestorApp, userId })
          } else {
            let contactsResults = null
            try {
              contactsResults = await res.locals.freezr.cepsContactsDB.query({ searchname: grantee })
            } catch (err) {
              res.locals.flogger.error('Error querying contacts', { function: 'shareRecords', requestorApp, userId, error: err })
              granteesNotAllowed.push(grantee)
              continue
            }
            if (contactsResults && contactsResults.length > 0) {
              allowedGrantees.push(grantee)
            } else {
              granteesNotAllowed.push(grantee)
            }
          }
        } else {
          allowedGrantees.push(grantee)
        }
      }
    }
    if (tooManyRequests) {
      // Handling more than one is okay except for the error handking which gets complicated, so turned off for now
      return sendFailure(res, 'Currently can only support one private feed or one public link or one private link at a time.', { function: 'shareRecords', requestorApp, userId })
    } else if (allowedGrantees.length === 0) {
      return sendFailure(res, 'No grantees are in your contacts', { function: 'shareRecords', requestorApp, userId })
    }
    // onsole.log('shareRecords allowedGrantees', { allowedGrantees })
    
    // 4. For permission types that require records to be marked, mark the specific records and add the grantees in _accessible (or remove them)
    if (PERMISSION_TYPES_FOR_WHICH_RECORDS_ARE_MARKED.includes(grantedPermission.type)) {
      let records = null
      try {
        records = await res.locals.freezr.appTableDb.query(recordQuery, {})
      } catch (err) {
        console.error('❌ Error querying records for sharing:', err)
        return sendFailure(res, err, 'shareRecords', 500)
      }
      if (!records || records.length === 0) {
        return sendFailure(res, 'no records found to add or remove grantees to ', { db: res.locals.freezr.appTableDb.oac, recordQuery,function: 'shareRecords', requestorApp, userId })
      } 

      // recordsToChange = records
      for (const rec of records) {
        // const accessible = rec._accessible || {} // Old Format
        const accessibles = rec._accessibles || []
        
        if (doGrant) {
          for (const grantee of allowedGrantees) {
            const granteeKey = (grantee === '_public' || grantee === '_privatelink') ? grantee : ((startsWith(grantee, '_privatefeed:')) ? grantee.substr(0, 12) : grantee)

            // find array object with grantee, requestor_app and permission_name
            let accessibleObject = accessibles.find(obj => obj.grantee === granteeKey && obj.requestor_app === requestorApp && obj.permission_name === permissionName)
            if (!accessibleObject) {
              accessibleObject = { grantee: granteeKey, requestor_app: requestorApp, permission_name: permissionName, granted: true }
              accessibles.push(accessibleObject)
            } 
            accessibleObject.granted = true
            
            if (granteeKey === '_public' || granteeKey === '_privatelink' || granteeKey === '_privatefeed') {
              const publicid = ((granteeKey === '_public' && req.body.publicid) ? req.body.publicid : ('@' + userId + '/' + appTableId + '/' + rec._id.toString()))
              accessibleObject.public_id = publicid
              accessibleObject._date_published = datePublished
              accessibleObject._date_modified = new Date().getTime
              newRecordUniquePublicId = publicid

              if (granteeKey === '_privatelink') {
                if (!accessibleObject.codes) accessibleObject.codes = []
                code = randomText(20)
                accessibleObject.codes.push(code)
              } else if (granteeKey === '_privatefeed') {
                if (!accessibleObject.privateFeedNames) accessibleObject.privateFeedNames = []
                feedName = grantee.substr(13)
                accessibleObject.privateFeedNames.push(feedName)
              }
              // MAKE PUBLIC ON PUBLIC RECORD DB HERE
              let publicIdResults = null
              try {
                publicIdResults = await res.locals.freezr.publicRecordsDb.query({ _id: publicid}, {})
              } catch (err) {
                // onsole.log('      🔑 writeorUpsertRecord publicIdResults', { publicid, err })
                console.error('❌ Error querying public records:', err)
                return sendFailure(res, err, 'shareRecords', 500)
              }
              const existingPublicRecord = publicIdResults.length > 0 ? publicIdResults[0] : null

              if (existingPublicRecord && (existingPublicRecord.data_owner !== userId || existingPublicRecord.original_app_table !== appTableId || existingPublicRecord.original_record_id.toString() !== rec._id.toString())) {
                console.warn('check freezrPublicRecordsDB req.body.publicid used - to recheck this ' + req.body.publicid + ' appTableId', appTableId, 'rec._id ', rec._id, publicIdResults)
                return sendFailure(res, 'Another entity already has the id requested. Please use a different public id.', { function: 'shareRecords', requestorApp, userId })
              }              
              const accessiblesObject = existingPublicRecord || {
                data_owner: userId,
                original_app_table: appTableId,
                requestor_app: requestorApp,
                permission_name: req.body.name,
                original_record_id: rec._id.toString(),
                original_record: rec,
                _date_published: datePublished,
                fileStructure: isHtmlMainPage ? req.body.fileStructure : null,
                doNotList: req.body.doNotList,
                isHtmlMainPage
              }
              
              if (grantedPermission.search_fields && grantedPermission.search_fields.length > 0) {
                const searchWordList = getUniqueWords(rec, grantedPermission.search_fields)
                accessiblesObject.search_words = searchWordList.length > 0 ? searchWordList.join(' ') : null
              }
              let originalRecord = {}
              if (grantedPermission.return_fields && grantedPermission.return_fields.length > 0) {
                grantedPermission.return_fields.forEach(item => {
                  originalRecord[item] = rec[item]
                });
                ['_date_created', '_date_modified', '_id'].forEach(item => {
                  originalRecord[item] = rec[item]
                })
                accessiblesObject.original_record = originalRecord
              }
              if (isHtmlMainPage) { // assumes && allowedGrantees.includes('_public') && helpers.endsWith(appTableId, '.files')
                const path = rec._id
                let contents = null
                try {
                  contents = await res.locals.freezr.userAppFS.readUserFile(path, {})
                } catch (err) {
                  console.error('❌ Error reading user file:', err)
                  return sendFailure(res, 'Error reading user file for isHtmlMainPage', { function: 'shareRecords', requestorApp, userId, error: err }, 500)
                }
                if (!existingPublicRecord) {
                  accessiblesObject.html_page = contents
                  // newRecordUniquePublicId = publicid
                  try {
                    const newrec = await res.locals.freezr.publicRecordsDb.create(publicid, accessiblesObject, {})
                  } catch (err) {
                    console.error('❌ Error creating public record:', err)
                    return sendFailure(res, 'Error creating public record for isHtmlMainPage', { function: 'shareRecords', requestorApp, userId, error: err }, 500)
                  }
                } else {
                  //newRecordUniquePublicId = publicid
                  accessiblesObject.html_page = contents
                  try {
                    await res.locals.freezr.publicRecordsDb.update(publicid, accessiblesObject, {})
                  } catch (err) {
                    return sendFailure(res, 'Error updating public record for isHtmlMainPage', { function: 'shareRecords', requestorApp, userId, error: err }, 500)
                  }
                }
              } else if (existingPublicRecord) {
                accessiblesObject._date_published = req.body.pubDate || existingPublicRecord._date_published
                accessiblesObject.doNotList = existingPublicRecord.doNotList
                if (hasPrivateFeed) {
                  accessiblesObject.isPublic = existingPublicRecord.isPublic
                  accessiblesObject.privateLinks = existingPublicRecord.privateLinks
                  if (existingPublicRecord.privateFeedNames) {
                    accessiblesObject.privateFeedNames = existingPublicRecord.privateFeedNames
                    accessiblesObject.privateFeedNames.push(feedName)
                  } else {
                    accessiblesObject.privateFeedNames = [feedName]
                  }
                } else if (hasPrivateLink) {
                  accessiblesObject.isPublic = existingPublicRecord.isPublic
                  accessiblesObject.privateFeedNames = existingPublicRecord.privateFeedNames
                  if (existingPublicRecord.privateLinks) {
                    accessiblesObject.privateLinks = existingPublicRecord.privateLinks
                    accessiblesObject.privateLinks.push(code)
                  } else {
                    accessiblesObject.privateLinks = [code]
                  }
                } else {
                  accessiblesObject.privateFeedNames = existingPublicRecord.privateFeedNames
                  accessiblesObject.privateLinks = existingPublicRecord.privateLinks
                  accessiblesObject.isPublic = true
                }
                try {
                  await res.locals.freezr.publicRecordsDb.update(publicid, accessiblesObject, {})
                } catch (err) {
                  return sendFailure(res, 'Error updating public record for existingPublicRecord', { function: 'shareRecords', requestorApp, userId, error: err }, 500)
                }
              } else { // create object
                if (hasPrivateFeed) {
                  accessiblesObject.privateFeedNames = [feedName]
                  accessiblesObject.isPublic = false
                } else if (hasPrivateLink) {
                  accessiblesObject.privateLinks = [code]
                  accessiblesObject.isPublic = false
                } else { // ispublic
                  accessiblesObject.isPublic = true
                }
                try {
                  const newrec = await res.locals.freezr.publicRecordsDb.create(publicid, accessiblesObject, {})
                } catch (err) {
                  return sendFailure(res, 'Error creating public record', { function: 'shareRecords', requestorApp, userId, error: err }, 500)
                }
              }

              // add hasPublic to permission - 
              // note: hasPublic is redundant now and not used because freezr checks for public records via query before serving files.... 
              // so this is not needed.. but kept in, in case it is needed in the future for other purposes
              try {
                if (!isSystemApp(requestorApp)) await res.locals.freezr.ownerPermsDb.update(grantedPermission._id.toString(), { hasPublic: true }, { replaceAllFields: false })
              } catch (err) {
                return sendFailure(res, 'Error updating owner permissions', { function: 'shareRecords', requestorApp, userId, error: err }, 500)
              }
            }
          }
        } else { // revoke
          for (const grantee of allowedGrantees) {
            const granteeKey = (grantee === '_public' || grantee === '_privatelink') ? grantee : (startsWith(grantee, '_privatefeed:')) ? grantee.substr(0, 12) : grantee
            // future - could keep all public id's and then use those to delete them later
            let accessiblePublicid = null
            const index = accessibles.findIndex(obj => obj.grantee === granteeKey && obj.requestor_app === requestorApp && obj.permission_name === permissionName);
            if (index !== -1) {
              const accessibleObject = { ...accessibles[index] };
              accessibles.splice(index, 1);
              // accessibleObject can be used or logged if needed
              accessiblePublicid = accessibleObject.public_id
            }

            // REMOVE PUBLIC HERE
            if (granteeKey === '_public' || granteeKey === '_privatelink' || granteeKey === '_privatefeed') {
              const publicid = ((granteeKey === '_public' && req.body.publicid) ? req.body.publicid : ('@' + userId + '/' + appTableId + '/' + rec._id.toString()))
              if (accessiblePublicid && accessiblePublicid !== publicid) {
                console.warn('SNBH - shareRecords updateRecord permDoesntNeedTableId 4b-1 - accessiblePublicid !== publicid', { accessiblePublicid, publicid })
              }
              if (!publicid) {
                console.warn('shareRecords updateRecord permDoesntNeedTableId 4b-1 - no publicid found for grantee', granteeKey, 'accessibles', accessibles)
                continue
              }
              let publicIdResults = null
              try {
                publicIdResults = await res.locals.freezr.publicRecordsDb.query({ _id: publicid}, {})
              } catch (err) {
                console.error('❌ Error querying public records for revoke:', err)
                continue
              }
              const existingPublicRecord = publicIdResults.length > 0 ? publicIdResults[0] : null

              if (!existingPublicRecord) {
                console.warn('shareRecords updateRecord permDoesntNeedTableId 4b-2 - no existingPublicRecord found for publicid', publicid, 'granteeKey', granteeKey, 'accessibles', accessibles)
                continue
              }

              if (hasPrivateFeed) {
                existingPublicRecord.isPublic = (publicIdResults && publicIdResults.length > 0) ? publicIdResults[0].isPublic : false
                existingPublicRecord.privateLinks = (publicIdResults && publicIdResults.length > 0) ? publicIdResults[0].privateLinks : null
                existingPublicRecord.privateFeedNames = removeFromListIfExists(existingPublicRecord.privateFeedNames, codeOrName)
              } else if (hasPrivateLink) {
                existingPublicRecord.isPublic = (publicIdResults && publicIdResults.length > 0) ? publicIdResults[0].isPublic : false
                existingPublicRecord.privateFeedNames = (publicIdResults && publicIdResults.length > 0) ? publicIdResults[0].privateFeedNames : null
                existingPublicRecord.privateLinks = removeFromListIfExists(existingPublicRecord.privateLinks, codeOrName)
              } else {
                existingPublicRecord.privateLinks = (publicIdResults && publicIdResults[0] && publicIdResults[0].privateLinks) ? publicIdResults[0].privateLinks : null
                existingPublicRecord.privateFeedNames = (publicIdResults && publicIdResults[0] && publicIdResults[0].privateFeedNames) ? publicIdResults[0].privateFeedNames : null
                existingPublicRecord.isPublic = false
              }
              if (!existingPublicRecord.isPublic && (!existingPublicRecord.privateFeedNames || existingPublicRecord.privateFeedNames.length === 0) && (!existingPublicRecord.privateLinks || existingPublicRecord.privateLinks.length === 0)) {
                try {
                  await res.locals.freezr.publicRecordsDb.delete_record(publicid, {})
                } catch (err) {
                  incompleteTransactionErrors.push({ error: 'could not delete public record', publicid, rec, error: err })
                  res.locals.flogger.error('Error deleting public record', { function: 'shareRecords', requestorApp, userId, error: err })
                  
                  // Continue processing other records even if this one fails
                }
              } else {
                existingPublicRecord._date_published = publicIdResults[0]._date_published
                existingPublicRecord.doNotList = publicIdResults[0].doNotList
                try {
                  await res.locals.freezr.publicRecordsDb.update(publicid, existingPublicRecord, {})
                } catch (err) {
                  incompleteTransactionErrors.push({ error: 'could not update public record', publicid, rec, existingPublicRecord, error: err })
                  res.locals.flogger.error('Error updating public record', { function: 'shareRecords', requestorApp, userId, error: err })
                  // Continue processing other records even if this one fails
                }
              }

              try {
                // seee above hasPublic is not used but kept in, just on case
                const otherPublicrecords = await res.locals.freezr.appTableDb.query({ $or: [
                  { "_accessibles.grantee": '_public' }, 
                  { "_accessibles.grantee": '_privatelink' }, 
                  { "_accessibles.grantee": '_privatefeed' }
                ] }, {})
                if (otherPublicrecords.length === 0) {
                    await res.locals.freezr.ownerPermsDb.update(grantedPermission._id.toString(), { hasPublic: false }, { replaceAllFields: false })
                }
              } catch (err) {
                incompleteTransactionErrors.push({ error: 'could not query other public records', message: err.message })
                res.locals.flogger.error('Error querying other public records', { function: 'shareRecords', requestorApp, userId, error: err })
              }
            }
          }
        }
        // fdlog('updating freezrRequesteeDB ',rec._id,'with',{accessible})
        const updates = { _accessibles: accessibles }
        if (isHtmlMainPage) { // assumes allowedGrantees.includes('_public') && && helpers.endsWith(appTableId, '.files'
          updates.isHtmlMainPage = true
          updates.fileStructure = req.body.fileStructure
        }
        try {
          await res.locals.freezr.appTableDb.update(rec._id.toString(), updates, { newSystemParams: true })
          recordsChanged++
        } catch (err) {
          console.error('❌ Error updating record accessibles:', err)
          return sendFailure(res, err, 'shareRecords', 500)
        }

        // check if public if has already been used
        // if (req.body.publicid) {
        //   const publicIdResults = await res.locals.freezr.publicRecordsDb.query(req.body.publicid, {})
        //   if (publicIdResults.length > 0 && (publicIdResults[0].original_app_table !== appTableId || publicIdResults[0].original_record_id.toString() !== rec._id.toString())) {
        //     console.warn('check freezrPublicRecordsDB req.body.publicid used - to recheck this ' + req.body.publicid + ' appTableId', appTableId, 'rec._id ', rec._id, publicIdResults)
        //     return sendFailure(res, 'Another entity already has the id requested.', { function: 'shareRecords', requestorApp, userId })
        //   } else {
        //     const updateRecord = await res.locals.freezr.appTableDb.update(rec._id.toString(), updates, { newSystemParams: true })
        //     onsole.log('shareRecords updateRecord 4a - updateRecord', { recId: rec._id, updateRecord })
        //   }
        // } else {
        //   const updateRecord = await res.locals.freezr.appTableDb.update(rec._id.toString(), updates, { newSystemParams: true })
        //   onsole.log('shareRecords updateRecord 4b - updateRecord', { recId: rec._id, updates, accessible, updateRecord })
        // }
      }

    }

    // 5. Add the grantees to the permission record if NOT PERMISSION_TYPES_FOR_WHICH_RECORDS_ARE_MARKED
    if (!PERMISSION_TYPES_FOR_WHICH_RECORDS_ARE_MARKED.includes(grantedPermission.type)) {
      if (doGrant) {
        let granteeList = grantedPermission.grantees || []
        allowedGrantees.forEach((grantee) => {
          grantee = grantee.replace(/\./g, '_').trim()
          granteeList = addToListAsUnique(granteeList, grantee)
        })
        try {
          await res.locals.freezr.ownerPermsDb.update(grantedPermission._id.toString(), { grantees: granteeList }, { replaceAllFields: false })
        } catch (err) {
          // point error but continue
          incompleteTransactionErrors.push({ id: grantedPermission._id.toString(), grantees: granteeList, error: 'could not update owner permissions', message: err.message })
        }
        // note that the above live is cumulative.. it could be cleaned if it bloats
      } else {
        const granteeList = grantedPermission.grantees || []
        allowedGrantees.forEach((grantee) => {
          grantee = grantee.replace(/\./g, '_').trim()
          if (granteeList.indexOf(grantee) >= 0) granteeList.splice(granteeList.indexOf(grantee), 1)
        })
        try {
          await res.locals.freezr.ownerPermsDb.update(grantedPermission._id.toString(), { grantees: granteeList }, { replaceAllFields: false })
        } catch (err) {
          // point error but continue
          incompleteTransactionErrors.push({ id: grantedPermission._id.toString(), grantees: granteeList,error: 'could not update owner permissions', message: err.message })

        }
      }
    }

    // REPLICATED ABOVE - TO RECHECK
    // // 6. for public records, add them to the public db
    // if (hasPublicLink || hasPrivateFeed || hasPrivateLink) {
    //   for (const rec of recordsToChange) {
    //     const publicid = (hasPublicLink && req.body.publicid) ? req.body.publicid : ('@' + userId + '/' + appTableId + '/' + rec._id.toString())
    //     let searchWordList = []
    //     if (grantedPermission.search_fields && grantedPermission.search_fields.length > 0) {
    //       searchWordList = getUniqueWords(rec, grantedPermission.search_fields)
    //     }
    //     let originalRecord = {}
    //     if (grantedPermission.return_fields && grantedPermission.return_fields.length > 0) {
    //       grantedPermission.return_fields.forEach(item => {
    //         originalRecord[item] = rec[item]
    //       });
    //       ['_date_created', '_date_modified', '_id'].forEach(item => {
    //         originalRecord[item] = rec[item]
    //       })
    //     } else {
    //       originalRecord = rec
    //     }

    //     const accessiblesObject = {
    //       data_owner: userId,
    //       original_app_table: appTableId,
    //       requestor_app: requestorApp,
    //       permission_name: req.body.name,
    //       original_record_id: rec._id.toString(),
    //       original_record: originalRecord,
    //       search_words: (searchWordList.length > 0 ? searchWordList.join(' ') : null),
    //       _date_published: datePublished,
    //       fileStructure: isHtmlMainPage ? req.body.fileStructure : null,
    //       doNotList: req.body.doNotList,
    //       isHtmlMainPage
    //     }
    //     const results = await res.locals.freezr.publicRecordsDb.query({ data_owner: userId, original_record_id: rec._id.toString(), original_app_table: appTableId }, {})
    //     if (results.length > 1) {
    //       return sendFailure(res, 'Retrieved more than one permission where there should only be one ' + JSON.stringify(results), { function: 'shareRecords', requestorApp, userId })
    //       // todo delete other ones?
    //     } else if (results.length > 0 && results[0].permission_name !== req.body.name) {
    //       return sendFailure(res, 'Permission name mismatch. Currently freezr only deals with one public entity per permission name', { function: 'shareRecords', requestorApp, userId })
    //     } else if (req.body.grant && results.length > 0 && results[0]._id !== publicid) {
    //       return sendFailure(res, 'Please ungrant the permission so as to delete the old file before changing public ids', { function: 'shareRecords', requestorApp, userId })
    //     } else { // update existing accessible record
    //       if (req.body.grant) {
    //         if (isHtmlMainPage) { // assumes && allowedGrantees.includes('_public') && helpers.endsWith(appTableId, '.files')
    //           const path = rec._id
    //           const contents = await res.locals.freezr.userAppFS.readUserFile(path, {})
    //           if (!results || results.length === 0) {
    //             accessiblesObject.html_page = contents
    //             newRecordUniquePublicId = publicid
    //             await res.locals.freezr.publicRecordsDb.create(publicid, accessiblesObject, {})
    //           } else {
    //             newRecordUniquePublicId = publicid
    //             accessiblesObject.html_page = contents
    //             await res.locals.freezr.publicRecordsDb.update(publicid, accessiblesObject, {})
    //           }
    //         } else if (results.length > 0) { // ie === 1
    //           accessiblesObject._date_published = req.body.pubDate || results[0]._date_published
    //           accessiblesObject.doNotList = results[0].doNotList
    //           if (hasPrivateFeed) {
    //             accessiblesObject.isPublic = results[0].isPublic
    //             accessiblesObject.privateLinks = results[0].privateLinks
    //             if (results[0].privateFeedNames) {
    //               accessiblesObject.privateFeedNames = results[0].privateFeedNames
    //               accessiblesObject.privateFeedNames.push(codeOrName)
    //             } else {
    //               accessiblesObject.privateFeedNames = [codeOrName]
    //             }
    //           } else if (hasPrivateLink) {
    //             accessiblesObject.isPublic = results[0].isPublic
    //             accessiblesObject.privateFeedNames = results[0].privateFeedNames
    //             if (results[0].privateLinks) {
    //               accessiblesObject.privateLinks = results[0].privateLinks
    //               accessiblesObject.privateLinks.push(codeOrName)
    //             } else {
    //               accessiblesObject.privateLinks = [codeOrName]
    //             }
    //           } else {
    //             accessiblesObject.privateFeedNames = results[0].privateFeedNames
    //             accessiblesObject.privateLinks = results[0].privateLinks
    //             accessiblesObject.isPublic = true
    //           }
    //           await res.locals.freezr.publicRecordsDb.update(publicid, accessiblesObject, {})
    //         } else { // create object
    //           if (hasPrivateFeed) {
    //             accessiblesObject.privateFeedNames = [codeOrName]
    //             accessiblesObject.isPublic = false
    //           } else if (hasPrivateLink) {
    //             accessiblesObject.privateLinks = [codeOrName]
    //             accessiblesObject.isPublic = false
    //           } else { // ispublic
    //             accessiblesObject.isPublic = true
    //           }
    //           await res.locals.freezr.publicRecordsDb.create(publicid, accessiblesObject, {})
    //         }
    //       } else { // remove grant
    //         if (hasPrivateFeed) {
    //           accessiblesObject.isPublic = (results && results.length > 0) ? results[0].isPublic : false
    //           accessiblesObject.privateLinks = (results && results.length > 0) ? results[0].privateLinks : null
    //           accessiblesObject.privateFeedNames = removeFromListIfExists(accessiblesObject.privateFeedNames, codeOrName)
    //         } else if (hasPrivateLink) {
    //           accessiblesObject.isPublic = (results && results.length > 0) ? results[0].isPublic : false
    //           accessiblesObject.privateFeedNames = (results && results.length > 0) ? results[0].privateFeedNames : null
    //           accessiblesObject.privateLinks = removeFromListIfExists(accessiblesObject.privateLinks, codeOrName)
    //         } else {
    //           accessiblesObject.privateLinks = (results && results[0] && results[0].privateLinks) ? results[0].privateLinks : null
    //           accessiblesObject.privateFeedNames = (results && results[0] && results[0].privateFeedNames) ? results[0].privateFeedNames : null
    //           accessiblesObject.isPublic = false
    //         }
    //         if (!accessiblesObject.isPublic && (!accessiblesObject.privateFeedNames || accessiblesObject.privateFeedNames.length === 0) && (!accessiblesObject.privateLinks || accessiblesObject.privateLinks.length === 0)) {
    //           await res.locals.freezr.publicRecordsDb.delete_record(publicid, {})
    //         } else {
    //           accessiblesObject._date_published = results[0]._date_published
    //           accessiblesObject.doNotList = results[0].doNotList
    //           await res.locals.freezr.publicRecordsDb.update(publicid, accessiblesObject, {})
    //         }
    //       }
    //     }
    //   }
    // }

    if (req.body.publicid || newRecordUniquePublicId) { // added newRecordUniquePublicId 2022-12 - isHtmlMainPage affected? todo review?
      return sendApiSuccess(res, { record_id: req.body.record_id, _publicid: newRecordUniquePublicId, code: code, feedName: feedName, _date_published: datePublished, grant: doGrant, recordsChanged, privateFeedCode })
    } else {
      return sendApiSuccess(res, { success: true, recordsChanged, incompleteTransactionErrors })
    }
  }

  /**
   * POST /feps/upload/:app_name
   * Upload a file and create a file record
   * Middleware sets up: res.locals.freezr.userFilesDb, res.locals.freezr.appFS, req.file (from multer)
   */
  const uploadUserFileAndCreateRecord = async (req, res) => {
    try {
      // onsole.log('🔑 uploadUserFileAndCreateRecord', { body: req.body, freezr: res.locals.freezr })
      if (!req.file) {
        return sendFailure(res, 'Missing file', 'uploadUserFileAndCreateRecord', 400)
      }

      if (!req.file.originalname) {
        return sendFailure(res, 'Missing file name', 'uploadUserFileAndCreateRecord', 400)
      }

      const appName = req.params.app_name
      const freezr = res.locals.freezr
      const userFilesDb = freezr.userFilesDb
      const appFS = freezr.appFS

      if (!userFilesDb || !appFS) {
        return sendFailure(res, 'Internal error - database or file system not found', 'uploadUserFileAndCreateRecord', 500)
      }

      // Check if system app (with special handling for profile pictures)
      const isAProfilePict = isSystemApp(appName) && 
        appName === 'info.freezr.account' &&
        !req.body?.targetFolder &&
        req.body?.fileName === 'profilePict.jpg'
        && req.body?.convertPict?.width === 500 && req.body?.convertPict?.type === 'jpg'

      // onsole.log('🔑 isAProfilePict', { appName, isAProfilePict, body: req.body, options: req.body.options })

      if (isSystemApp(appName) && !isAProfilePict) {
        // system app can only upload profile pictures
        return sendFailure(res, 'app name not allowed: ' + appName, 'uploadUserFileAndCreateRecord', 403)
      }

      // Parse options if provided as string
      let options = req.body || {}
      if (typeof options === 'string') {
        try {
          options = JSON.parse(options)
        } catch (e) {
          return sendFailure(res, 'Invalid options JSON', 'uploadUserFileAndCreateRecord', 400)
        }
      }

      // Parse data if provided as string
      let data = options.data || {}
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data)
        } catch (e) {
          return sendFailure(res, 'Invalid data JSON', 'uploadUserFileAndCreateRecord', 400)
        }
      }

      const fileParams = {
        dir: options.targetFolder || '',
        name: options.fileName || req.file.originalname
      }

      // Validate filename
      if (!validFilename(fileParams.name)) {
        return sendFailure(res, 'Invalid file name', 'uploadUserFileAndCreateRecord', 400)
      }

      // Helper function to validate path extension
      const validPathExtension = (aPath) => {
        if (!aPath) return true
        const parts = aPath.split(path.sep)
        for (let i = 0; i < parts.length; i++) {
          if (!validFilename(parts[i])) return false
        }
        return true
      }

      // Validate path
      if (!validPathExtension(fileParams.dir)) {
        return sendFailure(res, 'invalid folder name', 'uploadUserFileAndCreateRecord', 400)
      }

      // Build data object ID
      const dirName = removeStartAndEndSlashes(removeStartAndEndSlashes('' + fileParams.dir))
      const dataObjectId = (dirName ? (dirName + '/') : '') + fileParams.name

      // Check if file exists
      let existingRecord = null
      try {
        existingRecord = await userFilesDb.read_by_id(dataObjectId)
      } catch (err) {
        // File doesn't exist, which is fine
      }

      const isUpdate = existingRecord && (options.overwrite || existingRecord._UploadStatus === 'wip')

      // onsole.log('🔑 isUpdate', { existingRecord, isUpdate })
      if (existingRecord && !isUpdate) {
        return sendFailure(res, 'Cannot overwrite existing file', 'uploadUserFileAndCreateRecord', 400)
      }

      // Write record as WIP
      const write = data || {}
      write._UploadStatus = 'wip'

      try {
        if (isUpdate) {
          await userFilesDb.update(dataObjectId.toString(), write, { newSystemParams: isAProfilePict })
        } else {
          await userFilesDb.create(dataObjectId.toString(), write, { newSystemParams: isAProfilePict })
        }
      } catch (err) {
        return sendFailure(res, err, 'uploadUserFileAndCreateRecord', { function: 'writeRecord', error: err }, 500)
      }

      // Convert picture if needed
      let theFile = req.file.buffer
      if (options.convertPict) {
        try {
          theFile = await convertPicture(req.file, options.convertPict)
        } catch (err) {
          console.error('❌ Error converting picture:', err)
          return sendFailure(res, 'Error converting picture: ' + err.message, { function: 'uploadUserFileAndCreateRecord', error: err }, 500)
        }
      }

      try {
        // Write file
        // onsole.log('🔑 writing file', { dataObjectId, theFile, options })
        const endPath = removeStartAndEndSlashes(fileParams.dir + '/' + fileParams.name)
        const writtenPath = await appFS.writeToUserFiles(endPath, theFile, { doNotOverWrite: !options.overwrite })
        // Update record status to complete
        await userFilesDb.update(dataObjectId.toString(), { _UploadStatus: 'complete' }, { replaceAllFields: false })
      } catch (err) {
        return sendFailure(res, err, 'uploadUserFileAndCreateRecord', { function: 'writeFile', error: err }, 500)
      }
      res.locals.freezr.permGiven = true
      return sendApiSuccess(res, { _id: dataObjectId })
    } catch (err) {
      console.error('❌ Error in uploadUserFileAndCreateRecord:', err)
      return sendFailure(res, err, 'uploadUserFileAndCreateRecord', 500)
    }
  }

  /**
   * POST /ceps/message/:action
   * Handle messaging actions (initiate, transmit, verify, mark_read)
   * Middleware sets up: res.locals.freezr.tokenInfo, res.locals.freezr.ownerPermsDb, res.locals.freezr.appTableDb, res.locals.freezr.userMessagesSentDb, etc.
   */
  const messageActions = async (req, res) => {
    // TODO Untested and unverified -> review app_handler.js for original
    const action = req.params.action
    const freezr = res.locals.freezr
    
    // Helper function to convert recipient to JSON key
    const recipientAsJsonKey = (recipient) => {
      if (!recipient || !recipient.recipient_id) {
        console.warn('recipientAsJsonKey - no recipient ', recipient)
        return null
      }
      let recipientString = recipient.recipient_id + (recipient.recipient_host ? ('@' + recipient.recipient_host) : '')
      recipientString = recipientString.replace(/\./g, '_')
      return recipientString
    }

    // Helper function to reconfigure members by switching senders and receivers
    const reconfigureMembersBySwitchingSendersAndReceivers = (messageCopy) => {
      const members = messageCopy.recipients
      const senderHost = messageCopy.sender_host
      const recipientHost = messageCopy.recipient_host
      const revisedMembers = []
      if (members && members.length > 0) {
        console.warn('REVIEW THIS LOGIC??? - added else below - but this is inconsistent, even if it was working in old version')
        members.forEach(recipient => {
          const tempRevisedRecipient = { recipient_id: recipient.recipient_id, recipient_host: recipient.recipient_host }
          if (!tempRevisedRecipient.recipient_host) tempRevisedRecipient.recipient_host = senderHost
          if (tempRevisedRecipient.recipient_host === recipientHost) tempRevisedRecipient.recipient_host = null
          revisedMembers.push(tempRevisedRecipient)
        })
      } else {
        const tempRevisedRecipient = { 
          recipient_id: messageCopy.sender_id, 
          recipient_host: messageCopy.sender_host === recipientHost ? null : messageCopy.sender_host
        }
        revisedMembers.push(tempRevisedRecipient)
      }
      return revisedMembers
    }

    // Helper function for same-host message exchange
    const sameHostMessageExchange = async (recipient, messageCopy) => {
      const username = recipient.recipient_id
      
      if (!freezr.freezrOtherPersonContacts?.[username]) {
        throw new Error('no contact db found for user ' + username)
      }
      if (!freezr.freezrOtherPersonGotMsgs?.[username]) {
        throw new Error('no msgdb found for user ' + username)
      }
      
      // Check if recipient has sender as contact
      let contacts = null
      try {
        contacts = await freezr.freezrOtherPersonContacts[username].query({ username: messageCopy.sender_id, serverurl: null }, {})
      } catch (err) {
        console.error('❌ Error querying contacts:', err)
        throw new Error('Failed to query contacts: ' + err.message)
      }
      
      if (!contacts || contacts.length === 0) {
        messageCopy.senderIsNotContact = true
      }
      if (contacts && contacts.length > 1) {
        console.warn('two contacts found where one was expected ' + JSON.stringify(contacts))
      }
      
      // Add the message to recipient's message queue
      try {
        await freezr.freezrOtherPersonGotMsgs[username].create(null, messageCopy, {})
      } catch (err) {
        console.error('❌ Error creating message:', err)
        throw new Error('Failed to create message: ' + err.message)
      }
    }

    // Helper function to transmit message to other host
    const transmitMessage = async (recipient, messageToKeep) => {
      return new Promise(async (resolve, reject) => {
        const messageCopy = JSON.parse(JSON.stringify(messageToKeep))
        messageCopy.recipient_host = recipient.recipient_host
        messageCopy.recipient_id = recipient.recipient_id
        delete messageCopy.recipientStatus
        delete messageCopy.nonces
        delete messageCopy.record
        messageCopy.nonce = recipient.nonce
        messageCopy.recipients = reconfigureMembersBySwitchingSendersAndReceivers(messageCopy)

        const isLocalhost = startsWith(recipient.recipient_host, 'http://localhost')
        const http = await import('http');
        const https = await import('https');
        const httpOrHttps = isLocalhost ? http : https;

        const sendOptions = {
          hostname: isLocalhost ? 'localhost' : recipient.recipient_host.slice(8),
          path: '/ceps/message/transmit',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': JSON.stringify(messageCopy).length
          },
          timeout: 2000
        }
        if (isLocalhost) sendOptions.port = Number(recipient.recipient_host.slice(17))
        
        const verifyReq = httpOrHttps.request(sendOptions, (verifyRes) => {
          verifyRes.on('data', (returns) => {
            if (returns) returns = returns.toString()
            try {
              returns = JSON.parse(returns)
              if (returns.error) {
                console.warn('transmission err from server ', { messageCopy, returns })
                reject(new Error('recipient server refusal'))
              } else {
                resolve(null)
              }
            } catch (e) {
              console.warn('error getting transmit ', { returns, e })
              reject(new Error('recipient server verification'))
            }
          })
        })
        verifyReq.on('error', (error) => {
          console.warn('error in transmit ', error)
          reject(new Error('recipient server connection'))
        })
        verifyReq.write(JSON.stringify(messageCopy))
        verifyReq.end()
      })
    }

    try {
      switch (action) {
        case 'initiate': {
          // Implementation for initiate action
          let messagingPerm = null
          let contactPerm = null
          let groupPerm = null
          let permittedRecord = null
          let messageToKeep = null
          let messageId = null
          const recipientStatus = {}
          let validatedRecipients = []
          const validatedSameHostMembers = []
          const validatedOtherHostMembers = []
          let recordAccessibleField = {}
          const recipientsSuccessfullysentTo = []
          const recipientsWithErrorsSending = freezr.freezrBadContacts || []
          const params = req.body

          if (!params.app_id) params.app_id = freezr.tokenInfo.app_name

          // 1. Basic checks
          const objectFieldsHaveAllStrings = (object, objectParams) => {
            let failed = false
            objectParams.forEach(key => { if (!object[key] || typeof (object[key]) !== 'string') failed = true })
            return !failed
          }
          const arrayFieldsHaveAllStrings = (list) => {
            let failed = false
            list.forEach(item => { if (typeof item !== 'string') failed = true })
            return !failed
          }

          if (!objectFieldsHaveAllStrings(params, ['app_id', 'sender_id', 'sender_host', 'contact_permission', 'table_id']) || (!params.record_id && !params.message_id)) {
            return sendFailure(res, 'field insufficency mismatch', 'messageActions', 400)
          }
          if (params.type !== 'message_records') {
            return sendFailure(res, 'only message_records type messaging currently allowed', 'messageActions', 400)
          }
          if (params.sender_id !== freezr.tokenInfo.requestor_id) {
            return sendFailure(res, 'requestor id mismatch', 'messageActions', 401)
          }
          if (params.app_id !== freezr.tokenInfo.app_name) {
            return sendFailure(res, 'app id mismatch', 'messageActions', 401)
          }
          if (!params.messaging_permission || !params.contact_permission) {
            return sendFailure(res, 'missing permission names in request', 'messageActions', 400)
          }
          if (!params.recipient_id && !params.group_name && !params.recipients) {
            return sendFailure(res, 'malformed recipients in request', 'messageActions', 400)
          }
          if (params.recipient_id && typeof params.recipient_id !== 'string') {
            return sendFailure(res, 'recipient_id invalid', 'messageActions', 400)
          }
          if (params.group_name && typeof params.group_name !== 'string') {
            return sendFailure(res, 'group_name invalid', 'messageActions', 400)
          }
          if (params.group_members && !arrayFieldsHaveAllStrings(params.group_members)) {
            return sendFailure(res, 'group_members invalid', 'messageActions', 400)
          }
          if (params.message && typeof params.message !== 'string') {
            return sendFailure(res, 'message related to a message must be text', 'messageActions', 400)
          }

          // 2. Check message permission
          if (!freezr.ownerPermsDb) {
            console.error('owner permissions database not found', { freezr })
          }
          let permsResults = null
          try {
            permsResults = await freezr.ownerPermsDb.query({ requestor_app: freezr.tokenInfo.app_name }, {})
          } catch (err) {
            console.error('❌ Error querying permissions:', err)
            return sendFailure(res, err, 'messageActions', 500)
          }
          if (!permsResults || permsResults.length === 0) {
            return sendFailure(res, 'Sharing Permissions missing - internal', 'messageActions', 401)
          }

          permsResults.forEach(aPerm => {
            if (aPerm.name === params.messaging_permission &&
              aPerm.granted && aPerm.type === 'message_records' && params.type === 'message_records' &&
              (aPerm.table_id === freezr.appTableDb.oac.app_table || aPerm.table_id.includes(freezr.appTableDb.oac.app_table))
            ) messagingPerm = aPerm
            if (aPerm.name === params.contact_permission &&
              aPerm.granted && (aPerm.table_id === 'dev.ceps.contacts' || aPerm.table_id.includes('dev.ceps.contacts')) &&
              (aPerm.type === 'read_all' || aPerm.type === 'write_own' || aPerm.type === 'write_all')
            ) contactPerm = aPerm
            if (aPerm.name === params.contact_permission &&
              aPerm.granted && aPerm.table_id === 'dev.ceps.groups' &&
              (aPerm.type === 'read_all' || aPerm.type === 'write_own' || aPerm.type === 'write_all')
            ) groupPerm = aPerm
          })

          if (!messagingPerm) { // } || (!contactPerm && !groupPerm)) {
            console.warn('Permission type mismatch for messaging', { permsResults, dbApptable: freezr.appTableDb.oac.app_table, params, messagingPerm, contactPerm, groupPerm })
            return sendFailure(res, 'Permission type mismatch for messaging', 'messageActions', 401)
          }

          // 3. Get record and make sure grantee is in it
          let fetchedRecord = null
          if (params.record_id) {
            try {
              fetchedRecord = await freezr.appTableDb.read_by_id(params.record_id)
            } catch (err) {
              return sendFailure(res, 'Error reading record', { function: 'messageActions', error: err }, 500)
            }
          } else {
            return sendFailure(res, 'no record id or message id provided', 'messageActions', 400)
          }

          // 4. Construct a permitted-record
          if (params.type === 'message_records') {
            if (!fetchedRecord) {
              return sendFailure(res, 'no related records', 'messageActions', 404)
            }
            if (!messagingPerm.table_id.includes(freezr.appTableDb.oac.app_table)) {
              return sendFailure(res, 'messaging table id mismatch ' + messagingPerm.table_id + ' vs ' + freezr.appTableDb.oac.app_table, 'messageActions', 400)
            }

            recordAccessibleField = fetchedRecord._accessible || {}

            // Check permission
            if (messagingPerm && messagingPerm.return_fields && messagingPerm.return_fields.length > 0) {
              permittedRecord = {}
              messagingPerm.return_fields.forEach(key => {
                if (params?.record && params.record[key]) permittedRecord[key] = params.record[key]
              })
            } else {
              permittedRecord = JSON.parse(JSON.stringify(params.record))
            }
            delete permittedRecord._accessible
          } else {
            return sendFailure(res, 'snbh type was already checked ???', 'messageActions', 400)
          }

          // 5. Create message to keep
          messageToKeep = { ...params }
          messageToKeep.record = permittedRecord

          freezr.freezrMessageRecipients.forEach(recipient => {
            recipientStatus[recipientAsJsonKey(recipient)] = { status: 'initiate', recipient_id: recipient.recipient_id, recipient_host: recipient.recipient_host }
          })
          messageToKeep.status = 'initiate'
          let createResult = null
          try {
            createResult = await freezr.userMessagesSentDb.create(null, messageToKeep, {})
          } catch (err) {
            return sendFailure(res, 'Error creating message', { function: 'messageActions', error: err }, 500)
          }
          messageId = createResult._id

          // 6. Validate recipients if blocking messages to non-contacts
          if (freezr.userPrefs?.blockMsgsToNonContacts) {
            for (const recipient of freezr.freezrMessageRecipients) {
                try {
                let contactResults = null
                try {
                  contactResults = await freezr.userContactsDb.query({ username: recipient.recipient_id, serverurl: recipient.recipient_host }, {})
                } catch (err) {
                  console.error('❌ Error querying contacts:', err)
                  recipientStatus[recipientAsJsonKey(recipient)] = { status: 'err', err: err.message, recipient_id: recipient.recipient_id, recipient_host: recipient.recipient_host }
                  recipientsWithErrorsSending.push({ recipient_id: recipient.recipient_id, recipient_host: recipient.recipient_host, err: 'Could not verify contact' })
                  continue
                }
                if (!contactResults || contactResults.length === 0) {
                  recipientStatus[recipientAsJsonKey(recipient)] = { status: 'member not in contacts', recipient_id: recipient.recipient_id, recipient_host: recipient.recipient_host }
                  recipientsWithErrorsSending.push({ recipient_id: recipient.recipient_id, recipient_host: recipient.recipient_host, err: 'member not in contacts' })
                } else {
                  if (contactResults.length > 1) {
                    console.warn('SNBH - two contacts found where one was expected - will add to erroed and non erroed !!! Wot to do? ' + JSON.stringify(contactResults))
                    recipientsWithErrorsSending.push({ recipient_id: recipient.recipient_id, recipient_host: recipient.recipient_host, err: '2 member are same of same not in contacts - sent to first' })
                  }
                  validatedRecipients.push(recipient)
                }
              } catch (err) {
                recipientStatus[recipientAsJsonKey(recipient)] = { status: 'err', err: err.message, recipient_id: recipient.recipient_id, recipient_host: recipient.recipient_host }
                recipientsWithErrorsSending.push({ recipient_id: recipient.recipient_id, recipient_host: recipient.recipient_host, err: err.message })
              }
            }
          } else {
            validatedRecipients = freezr.freezrMessageRecipients
          }

          // 7. Separate sameHost from otherHost members
          if (!validatedRecipients || validatedRecipients.length === 0) {
            console.warn('no members to share with')
            messageToKeep.recipientStatus = recipientStatus
            messageToKeep.status = 'err'
            await freezr.userMessagesSentDb.update(messageId, messageToKeep, {})
            return sendFailure(res, 'No members to share with', 'messageActions', 400)
          }

          messageToKeep.nonces = []
          validatedRecipients.forEach(recipient => {
            if (!recipient.recipient_host || recipient.recipient_host === messageToKeep.sender_host) {
              validatedSameHostMembers.push(recipient)
            } else {
              const nonce = randomText(50)
              const recipientCopy = { nonce, recipient_id: recipient.recipient_id, recipient_host: recipient.recipient_host }
              recipientStatus[recipientAsJsonKey(recipient)].nonce = nonce
              messageToKeep.nonces.push(nonce)
              validatedOtherHostMembers.push(recipientCopy)
            }
          })

          // 8. Send to same host members
          if (validatedSameHostMembers.length > 0) {
            const messageCopy = JSON.parse(JSON.stringify(messageToKeep))
            delete messageCopy.recipientStatus
            delete messageCopy.nonces

            for (const recipient of validatedSameHostMembers) {
              try {
                await sameHostMessageExchange(recipient, messageCopy)
                recipientsSuccessfullysentTo.push(recipient)
                recipientStatus[recipientAsJsonKey(recipient)].status = 'verified'
              } catch (err) {
                recipientsWithErrorsSending.push({ recipient_id: recipient.recipient_id, err: (err.message || 'failure to send') })
                recipientStatus[recipientAsJsonKey(recipient)].status = 'err'
                recipientStatus[recipientAsJsonKey(recipient)].err = err.message
              }
            }
          }

          // 9. Update message with nonces and status of samehost ones
          messageToKeep.recipientStatus = recipientStatus
          try {
            await freezr.userMessagesSentDb.update(messageId, messageToKeep, {})
          } catch (err) {
            console.error('❌ Error updating message:', err)
            // return sendFailure(res, 'Error updating message', { function: 'messageActions', error: err }, 500)
          }

          // 10. Send to other host members
          if (validatedOtherHostMembers.length > 0) {
            for (const recipient of validatedOtherHostMembers) {
              try {
                await transmitMessage(recipient, messageToKeep)
                recipientsSuccessfullysentTo.push({ recipient_id: recipient.recipient_id, recipient_host: recipient.recipient_host })
              } catch (err) {
                console.warn('transmitted msg with ', { recipient, err })
                recipientsWithErrorsSending.push({ recipient_id: recipient.recipient_id, recipient_host: recipient.recipient_host, err: (err?.message || 'failure to send') })
                const setObj = {}
                setObj['recipientStatus.' + recipientAsJsonKey(recipient) + '.status'] = 'err'
                try {
                  await freezr.userMessagesSentDb.update(messageId, { $set: setObj }, { replaceAllFields: false })
                } catch (err) {
                  console.error('❌ Error updating message status:', err)
                  // Continue processing other recipients
                }
              }
            }
          }

          // 11. Update record accessible field
          if (!recordAccessibleField) recordAccessibleField = {}
          recipientsSuccessfullysentTo.forEach(recipient => {
            const recipientString = recipientAsJsonKey(recipient)
            if (!recordAccessibleField[recipientString]) recordAccessibleField[recipientString] = {}
            if (!recordAccessibleField[recipientString].messaged) recordAccessibleField[recipientString].messaged = []
            recordAccessibleField[recipientString].messaged.push(new Date().getTime())
          })
          try {
            await freezr.appTableDb.update(params.record_id.toString(), { _accessible: recordAccessibleField }, { replaceAllFields: false, newSystemParams: true })
          } catch (err) {
            return sendFailure(res, 'Error updating record accessible field', { function: 'messageActions', error: err }, 500)
          }

          return sendApiSuccess(res, { success: true, recipientsSuccessfullysentTo, recipientsWithErrorsSending })
        }

        case 'transmit': {
          const receivedParams = req.body
          let storedmessageId = null
          let senderIsAContact = false
          let status = 0

          // 1. Validate fields
          const fields = ['app_id', 'sender_id', 'sender_host', 'recipient_host', 'recipient_id', 'type', 'contact_permission', 'table_id', 'nonce', 'message', 'messaging_permission', 'record']
          const fieldExceptions = ['message', 'record_id', 'record', 'message_id']
          let failed = false
          const validatedParams = {}
          
          for (const [key, keyObj] of Object.entries(req.body)) {
            if (fields.includes(key)) {
              if (typeof req.body[key] === 'string') validatedParams[key] = keyObj
            } else if (['message', 'record_id', 'record', 'message_id', '_date_modified', '_date_created'].indexOf(key) < 0) {
              console.warn('message sent unnecessary field - need to fix and add back failure for security purposes ', key)
            }
          }
          fields.forEach(key => { if (!validatedParams[key] && !fieldExceptions.includes(key)) failed = true })
          
          if (failed) {
            return sendFailure(res, 'failed to get keys for sharing', 'messageActions', 400)
          }

          // 2. Check that recipient has sender as contact
          let contactResults = null
          try {
            contactResults = await freezr.userContactsDb.query({ username: receivedParams.sender_id, serverurl: receivedParams.sender_host }, {})
          } catch (err) {
            return sendFailure(res, 'Error querying contacts', { function: 'messageActions', error: err }, 500)
          }
          
          if (!contactResults || contactResults.length === 0) {
            if (freezr.userPrefs?.blockMsgsFromNonContacts) {
              senderIsAContact = false
              return sendFailure(res, 'contact does not exist - Cannot send', 'messageActions', 401)
            } else {
              senderIsAContact = false
            }
          } else {
            senderIsAContact = true
            if (contactResults.length > 1) {
              console.warn('two contacts found where one was expected ' + JSON.stringify(contactResults))
            }
          }

          // 3. Store message
          status = 1
          delete receivedParams._id
          receivedParams.senderIsAContact = senderIsAContact
          let confirmed = null
          try {
            confirmed = await freezr.userMessagesGotDb.create(null, receivedParams, null)
          } catch (err) {
            return sendFailure(res, 'Error creating received message 2', { function: 'messageActions', error: err }, 500)
          }
          status = 2
          storedmessageId = confirmed._id.toString()

          // 4. Verify the nonce and get the record
          const isLocalhost = startsWith(receivedParams.sender_host, 'http://localhost')
          const httpModule = isLocalhost ? http : https

          const options = {
            hostname: isLocalhost ? 'localhost' : receivedParams.sender_host.slice(8),
            path: '/ceps/message/verify',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': JSON.stringify(receivedParams).length
            },
            timeout: 2000
          }
          if (isLocalhost) options.port = receivedParams.sender_host.slice(17)

          const verifyResponse = await new Promise((resolve, reject) => {
            const verifyReq = httpModule.request(options, (verifyRes) => {
              let chunks = ''
              verifyRes.on('data', function (chunk) {
                chunk = chunk.toString('utf-8')
                if (chunk.slice(-1) === '\n') chunk = chunk.slice(0, -1)
                chunks += chunk
              })

              verifyRes.on('end', function () {
                try {
                  const data = JSON.parse(chunks)
                  resolve(data)
                } catch (e) {
                  console.error('error parsing message in transmit', e, 'data chunks now -' + chunks + '- end chunks')
                  reject(e)
                }
              })
            })
            verifyReq.on('error', (error) => {
              console.warn('error in transmit ', error)
              reject(new Error('message transmission error 1'))
            })
            verifyReq.write(JSON.stringify(receivedParams))
            verifyReq.end()
          })

          // 5. Update the record
          status = 3
          if (verifyResponse.record) {
            try {
              await freezr.userMessagesGotDb.update(storedmessageId, { message: verifyResponse.message, record: verifyResponse.record, status: 'verified' }, { replaceAllFields: false })
            } catch (err) {
              return sendFailure(res, 'Error updating received message 3', { function: 'messageActions', error: err.message }, 500)
            }
          }

          return sendApiSuccess(res, { success: true })
        }

        case 'verify': {
          if (!req.body.nonce) {
            console.error('nonce required to verify messages ', req.body)
            return res.sendStatus(401)
          }

          const TIME_LIMIT = 1000 * 60 * 60 * 24 // 24 hours
          let results = null
          try {
            results = await freezr.userMessagesSentDb.query({ nonces: req.body.nonce }, {})
          } catch (err) {
            return sendFailure(res, 'Error querying messages by nonce', { function: 'messageActions', error: err }, 500)
          }

          if (!results || results.length === 0) {
            console.error('no results from nonce in message ', req.body)
            return res.sendStatus(401)
          }

          const haveDifferentMessageFields = (dbMessage, verifyeeMessage) => {
            const fields = ['app_id', 'sender_id', 'sender_host', 'contact_permission', 'table_id']
            let failed = false
            fields.forEach(key => { if (dbMessage[key] !== verifyeeMessage[key]) failed = true })
            if (!verifyeeMessage.recipient_id || !verifyeeMessage.recipient_host) failed = true
            const recipientString = recipientAsJsonKey({ recipient_id: verifyeeMessage.recipient_id, recipient_host: verifyeeMessage.recipient_host })
            if (!dbMessage.recipientStatus[recipientString] ||
                dbMessage.recipientStatus[recipientString].nonce !== verifyeeMessage.nonce ||
                dbMessage.recipientStatus[recipientString].status === 'verified') failed = true
            return failed
          }

          if (haveDifferentMessageFields(results[0], req.body)) {
            console.warn('Message mismatch ', { recipientStatus: JSON.stringify(results[0].recipientStatus) })
            console.warn('Message mismatch ', { db: results[0], body: req.body })
            console.warn('Message mismatch ', { dbrec: results[0].recipients })
            return sendFailure(res, 'Message Field Mismatch', { function: 'messageActions' }, 401)
          }

          // Update sent message by removing nonce from nonces and updating status
          const nonces = [...results[0].nonces]
          nonces.splice(nonces.indexOf(req.body.nonce), 1)
          const recipientConfirm = { recipient_id: req.body.recipient_id, recipient_host: req.body.recipient_host, status: 'verified' }
          const recipientString = recipientAsJsonKey(recipientConfirm)
          const recipientKey = 'recipientStatus.' + recipientString
          const changes = { nonces }
          changes[recipientKey] = recipientConfirm
          try {
            await freezr.userMessagesSentDb.update(results[0]._id.toString(), changes, { replaceAllFields: false })
          } catch (err) {
            return sendFailure(res, ' Error updating message verification', { function: 'messageActions', error: err }, 500)
          }

          return sendApiSuccess(res, { record: results[0].record, message: results[0].message, success: true })
        }

        case 'mark_read': {
          const messageIds = req.body.message_ids
          const markAll = req.body.mark_all

          if ((!messageIds || messageIds.length === 0) && !markAll) {
            console.warn('missing permission IDs in request, ', { messageIds, markAll })
            return sendFailure(res, 'missing permission IDs in request', 'messageActions', 400)
          }

          if (!markAll) {
            for (const messageId of messageIds) {
              let results = null
              try {
                results = await freezr.userMessagesGotDb.query({ _id: messageId }, {})
              } catch (err) {
                return sendFailure(res, 'Error querying message', { function: 'messageActions', error: err }, 500)
              }
              if (!results || results.length === 0 || results[0].app_id !== freezr.tokenInfo.app_name) {
                console.warn('message not found ', { messageId, results })
                return sendFailure(res, 'message not found', { function: 'messageActions' }, 404)
              }
              try {
                await freezr.userMessagesGotDb.update(messageId, { marked_read: true }, { replaceAllFields: false })
              } catch (err) {
                return sendFailure(res, 'Error updating message read status', { function: 'messageActions', error: err }, 500)
              }
            }
          } else {
            try {
              await freezr.userMessagesGotDb.update({ app_id: freezr.tokenInfo.app_name }, { marked_read: true }, { replaceAllFields: false })
            } catch (err) {
              return sendFailure(res, 'Error updating all messages read status', { function: 'messageActions', error: err }, 500)
            }
          }

          return sendApiSuccess(res, { success: true })
        }

        case 'get':
          // Not used - kept for compatibility
          return sendFailure(res, 'get action not implemented', 'messageActions', 501)

        default:
          return sendFailure(res, 'invalid query', 'messageActions', 400)
      }
    } catch (error) {
      console.error('❌ Error in messageActions:', error)
      return sendFailure(res, error, 'messageActions', 500)
    }
  }

  /* 
  * CEPSValidator
  * Validate or verify a validation token (for actions: set, validate, verify)
  * Middleware sets up: res.locals.freezr.tokenInfo, res.locals.freezr.validationTokenDB, res.locals.freezr.cepsContacts, res.locals.freezr.userPermsDB, res.locals.freezr.appTokenDB
  */
  const CEPSValidator = async (req, res) => {
    const action = req.params.action
    const freezr = res.locals.freezr
    const EXPIRY_DEFAULT = 30 * 24 * 60 * 60 * 1000 // 30 days

    // Helper function to convert query params to validation params
    const validationParamsFromQuery = (query) => {
      const params = {
        validation_token: query.validation_token,
        data_owner_user: query.data_owner_user,
        permission: query.permission,
        table_id: query.table_id,
        requestor_user: query.requestor_user,
        expiration: { $gt: new Date().getTime() }
      }
      if (query.data_owner_host) params.data_owner_host = query.data_owner_host
      return params
    }

    try {
      if (action === 'set') {
        // onsole.log('CEPSValidator set', { bod: req.body })
        /*
        { data_owner_host : {host url}, // blank if same
          data_owner_user : {username},
          table_id : {table-identifier},
          requestor_user :{username of requestor on her/his own pds},
          permission : {name of permission},
          app_id: {requesting app's id},
          record_id : {_id of record being shared} // (optional)
        }
        */
        if (!freezr.tokenInfo) {
          return sendFailure(res, 'data mismatch', 'CEPSValidator', 401)
        }
        if (req.body.app_id !== freezr.tokenInfo.app_name) {
          console.error('CEPSValidator mismatch - body ', req.body, ' vs token ', freezr.tokenInfo)
          return sendFailure(res, 'data mismatch', 'CEPSValidator', 401)
        }
        if (freezr.tokenInfo.requestor_id !== freezr.tokenInfo.owner_id) {
          console.error('auth failure ', freezr.tokenInfo.requestor_id, ' vs token ', freezr.tokenInfo)
          return sendFailure(res, 'incomplete request 1', 'CEPSValidator', 401)
        }
        if (!req.body.data_owner_user) {
          console.error('incomplete request 2 ', req.body, ' vs token ', freezr.tokenInfo)
          return sendFailure(res, 'incomplete request 2', 'CEPSValidator', 400)
        }

        const validationtoken = randomText(30)
        const EXPIRATION_MINUTES = 5
        const expiration = new Date().getTime() + EXPIRATION_MINUTES * 60 * 1000
        const requesterHost = (startsWith(req.get('host'), 'localhost') ? 'http' : 'https') + '://' + req.headers.host
        const dataOwnerHost = req.body.data_owner_host

        const newValidator = {
          validation_token: validationtoken,
          expiration,
          requestor_user: freezr.tokenInfo.requestor_id,
          data_owner_host: dataOwnerHost,
          data_owner_user: req.body.data_owner_user,
          permission: req.body.permission,
          table_id: req.body.table_id,
          app_id: freezr.tokenInfo.app_name,
          record_id: req.body.record_id // {_id of record being shared} // (optional)
        }
        if (dataOwnerHost) newValidator.requestor_host = requesterHost // for same host requests
        // todo - also check contacts and user -> BlockMsgsToNonContacts

        try {
          const returns = await freezr.validationTokenDB.create(null, newValidator, null)
          res.locals.freezr.permGiven = true
          return sendApiSuccess(res, { validation_token: validationtoken, requestor_host: requesterHost, expiration })
        } catch (err) {
          console.error('❌ Error in validationTokenDB create:', err)
          return sendFailure(res, err, 'CEPSValidator', 500)
        }

      } else if (action === 'validate') {
        // onsole.log('CEPSValidator validate', { q: req.query })
        /*
        validation_token: {Same as above}
        data_owner_user : {Same as above},
        data_owner_host : {Same as above},
        table_id : {Same as above},
        permission : {Same as above},
        app_id : {Same as above},
        requestor_user : {Same as above},
        requestor_host: {Same as above},
        */
        const requestor = req.query.requestor_user + (req.query.requestor_host ? ('@' + req.query.requestor_host.replace(/\./g, '_')) : '')
        const appToken = generateAppToken(requestor, req.query.app_id, null)
        const accessTokenExpiry = (new Date().getTime() + EXPIRY_DEFAULT)

        // 1. Basic checks
        if (!req.query.validation_token || !req.query.data_owner_user || !req.query.table_id || !req.query.requestor_user || (!req.query.permission && req.query.requestor_host && freezr.tokenInfo?.app_name !== 'info.freezr.account')) {
          console.warn('CEPS Validator incomplete request 5 body ', req.body, ' freezrTokenInfo ', freezr.tokenInfo)
          return sendFailure(res, 'incomplete request 5', 'CEPSValidator', 400)
        }

        // 2. Make sure contact exists
        let contacts = null
        try {
          contacts = await freezr.cepsContacts.query({ username: req.query.requestor_user, serverurl: req.query.requestor_host }, null)
        } catch (err) {
          console.error('❌ Error querying contacts:', err)
          return sendFailure(res, err, 'CEPSValidator', 500)
        }
        
        if (contacts && contacts.length > 0) {
          // Contact exists, continue
        } else if (!req.query.data_owner_host && req.query.data_owner_user === 'public') {
          // Exception for 'public'
        } else if (freezr.userPrefs && freezr.userPrefs.blockMsgsFromNonContacts) {
          console.error('no contacts - invalid request - c')
          return sendFailure(res, 'invalid request - c', 'CEPSValidator', 401)
        } else if ((!req.query.data_owner_host && req.query.requestor_host) || (req.query.data_owner_host && !req.query.requestor_host)) {
          return sendFailure(res, 'invalid request - d', 'CEPSValidator', 400)
        }

        // 3. Make sure permission has been granted
        if (req.query.data_owner_user === 'public' && !req.query.data_owner_host) {
          // This case is dealt with below
        } else {
          const dbQuery = {
            table_id: req.query.table_id,
            name: req.query.permission,
            granted: true
          }
          let grantedPerms = null
          try {
            grantedPerms = await freezr.userPermsDB.query(dbQuery, {})
          } catch (err) {
            console.error('❌ Error querying user permissions:', err)
            return sendFailure(res, err, 'CEPSValidator', 500)
          }
          
          if (!grantedPerms || grantedPerms.length < 1) {
            console.warn('invalid requst getting granted perms ', { user: req.session?.logged_in_user_id, grantedPerms }, req.query)
            return sendFailure(res, 'invalid request 2', 'CEPSValidator', 401)
          }

          // Check if requestor is in grantees
          let hasRight = false
          grantedPerms.forEach((item) => {
            if (item.grantees && item.grantees.includes(requestor)) hasRight = true
          })

          if (!hasRight) {
            console.error('invalid request getting granted perms ', { requestor })
            return sendFailure(res, 'invalid request getting permissions granted', 'CEPSValidator', 401)
          }
        }

        // 4. Verify validation token
        let verified = false
        if (!req.query.data_owner_host) { // ie requestor is samehost as owner
          if (req.query.data_owner_user === 'public') { // exception for common db's - for privateFeedCodes
            const perm = SYSTEM_PERMS[req.query.permission] // 2026-01 changed this reference to config.mjs without testing - ws in this file previously
            if (perm && perm.table_id === req.query.table_id && '_allUsers'.indexOf(perm.grantees) > -1) {
              verified = true
            } else {
              console.error('req.query ', req.query, { perm })
              return sendFailure(res, 'not verifited for internal access 1', 'CEPSValidator', 401)
            }
          } else {
            let returns = null
            try {
              returns = await freezr.validationTokenDB.query(validationParamsFromQuery(req.query), null)
            } catch (err) {
              console.error('❌ Error querying validation token:', err)
              return sendFailure(res, err, 'CEPSValidator', 500)
            }
            if (!returns || returns.length < 1) {
              return sendFailure(res, 'not verifited 1', 'CEPSValidator', 401)
            }
            verified = true
          }
        } else {
          // onsole.log('CEPSValidator cross-host verification', { q: req.query })
          // Cross-host verification - make HTTP request to requestor's server
          const isLocalhost = startsWith(req.query.requestor_host, 'http://localhost')

          const httpOrHttps = isLocalhost ? http : https;

          let queryString = 'validation_token=' + req.query.validation_token
          queryString += '&data_owner_user=' + req.query.data_owner_user
          if (req.query.data_owner_host) queryString += '&data_owner_host=' + req.query.data_owner_host
          queryString += '&permission=' + req.query.permission
          queryString += '&table_id=' + req.query.table_id
          queryString += '&requestor_user=' + req.query.requestor_user
          if (req.query.requestor_host) queryString += '&requestor_host=' + req.query.requestor_host

          const options = {
            hostname: isLocalhost ? 'localhost' : req.query.requestor_host.slice(8),
            path: '/ceps/perms/validationtoken/verify?' + queryString,
            method: 'GET',
            headers: {
              'Content-Type': 'application/json'
            }
          }
          if (isLocalhost) options.port = req.query.requestor_host.slice(17)

          try {
            const otherServerReturns = await new Promise((resolve, reject) => {
              const verifyReq = httpOrHttps.request(options, (verifyRes) => {
                let data = ''
                verifyRes.on('data', (chunk) => {
                  data += chunk.toString()
                })
                verifyRes.on('end', () => {
                  try {
                    resolve(JSON.parse(data))
                  } catch (e) {
                    reject(new Error('Failed to parse response'))
                  }
                })
              })
              verifyReq.on('error', (error) => {
                console.error('error in verify ', error)
                reject(error)
              })
              verifyReq.write('')
              verifyReq.end()
            })

            if (otherServerReturns.verified) {
              verified = true
            } else {
              console.error('invalid request getting other server returns', { otherServerReturns })
              return sendFailure(res, 'invalid request 3', 'CEPSValidator', 401)
            }
          } catch (error) {
            console.error('error in cross-host verification ', error)
            return sendFailure(res, 'incomplete validation', 'CEPSValidator', 500)
          }
        }

        // 5. Create app token if verified
        if (verified) {
          const write = {
            logged_in: false,
            requestor_id: requestor,
            owner_id: req.query.data_owner_user,
            app_name: req.query.app_id,
            app_token: appToken, // create token instead
            expiry: accessTokenExpiry,
            one_device: null,
            user_device: null,
            date_used: null // to be replaced by date
          }
          let results = null
          try {
            results = await freezr.appTokenDB.create(null, write, null)
          } catch (err) {
            return sendFailure(res, 'Error creating app token', { function: 'CEPSValidator', error: err }, 500)
          }
          res.locals.freezr.permGiven = true
          return sendApiSuccess(res, { validated: true, 'access-token': appToken, expiry: accessTokenExpiry })
        } else {
          return sendFailure(res, 'validation failed', 'CEPSValidator', 401)
        }

      } else if (action === 'verify') {
        // onsole.log('CEPSValidator verify', { q: req.query })
        if (!req.query.validation_token || !req.query.data_owner_user || !req.query.data_owner_host || !req.query.table_id || !req.query.permission || !req.query.requestor_user || !req.query.requestor_host) {
          console.error('Missing verification data query:', req.query, '   url:' + req.url)
          return sendFailure(res, 'invalid data', 'CEPSValidator', 400)
        }

        let returns = null
        try {
          returns = await freezr.validationTokenDB.query(validationParamsFromQuery(req.query), {})
        } catch (err) {
          console.error('❌ Error querying validation token:', err)
          return sendFailure(res, 'Error querying validation token', { function: 'CEPSValidator', error: err }, 500)
        }
        
        if (!returns || returns.length === 0) {
          return sendFailure(res, 'incomplete request 7', 'CEPSValidator', 401)
        }
        res.locals.freezr.permGiven = true
        return sendApiSuccess(res, { verified: true })
      } else {
        return sendFailure(res, 'invalid query', 'CEPSValidator', 400)
      }
    } catch (error) {
      console.error('❌ Error in CEPSValidator:', error)
      return sendFailure(res, error, 'CEPSValidator', 500)
    }
  }

  /**
   * GET /feps/getuserfiletoken/:permission_name/:app_name/:user_id/*
   * Get a file token for accessing a user file
   * Handles permission check and token generation using cache
   */
  const getFileToken = async (req, res) => {
    // onsole.log('      🔑 getFileToken called', { req, res })
    try {
      // Extract file path from URL
      // URL format: /feps/getuserfiletoken/:permission_name/:app_name/:user_id/*
      const parts = req.originalUrl.split('/')
      const dataObjectId = decodeURIComponent(parts.slice(6).join('/'))
      
      // Remove query string if present
      let cleanDataObjectId = dataObjectId
      if (dataObjectId.indexOf('?') > -1) {
        const parts2 = dataObjectId.split('?')
        cleanDataObjectId = parts2[0]
      }
      
      const appName = req.params.app_name
      const appTableDb = res.locals.freezr.appTableDb
      
      if (!appTableDb) {
        return sendFailure(res, 'Internal error - database not found', 'getFileToken', 500)
      }

      // Check permissions - same logic as readRecordById
      const mayBeCanRead = res.locals.freezr.rightsToTable.own_record 
        || res.locals.freezr.rightsToTable.can_read
        || res.locals.freezr.rightsToTable.can_write
        || res.locals.freezr.rightsToTable.write_own
        || res.locals.freezr.rightsToTable.share_records

      if (!mayBeCanRead) {
        return sendFailure(res, 'Not authorized to read record', 'getFileToken', 401)
      }

      // Read the file record to verify it exists and check permissions
      let fetchedRecord = null
      try {
        fetchedRecord = await appTableDb.read_by_id(cleanDataObjectId)
      } catch (err) {
        console.error('❌ Error reading file record by ID:', err)
        return sendFailure(res, err, 'getFileToken', 500)
      }

      if (!fetchedRecord) {
        return sendFailure(res, 'File record not found', 'getFileToken', 404)
      }

      // Check if user has direct access (own_record, can_read, can_write)
      let hasAccess = res.locals.freezr.rightsToTable.own_record 
        || res.locals.freezr.rightsToTable.can_read
        || res.locals.freezr.rightsToTable.can_write

      // If not direct access, check conditional permissions (write_own or share_records)
      if (!hasAccess) {
        const requestee = res.locals.freezr.tokenInfo.requestor_id //.replace(/\./g, '_')
        let accessToRecord = false

        res.locals.freezr.rightsToTable.grantedPerms.forEach(aPerm => {
          if (aPerm.type === 'write_own' && 
              fetchedRecord._created_by_user === res.locals.freezr.tokenInfo.requestor_user_id && 
              fetchedRecord._created_by_app === res.locals.freezr.tokenInfo.app_name) {
            accessToRecord = true
          } else if (Array.isArray(fetchedRecord._accessibles) && fetchedRecord._accessibles.length > 0) {
            const accessibleObj = fetchedRecord._accessibles.find(obj =>
              obj.grantee === requestee &&
              obj.requestor_app === aPerm.requestor_app &&
              obj.permission_name === aPerm.name &&
              obj.granted === true
            )
            if (accessibleObj) {
              accessToRecord = true
            }
          }
        })
        
        if (!accessToRecord) {
          return sendFailure(res, 'No matching permissions exist', 'getFileToken', 401)
        }
      }

      // Permission check passed - generate or retrieve file token from cache
      const cache = appTableDb.cache
      if (!cache) {
        return sendFailure(res, 'Internal error - cache not available', 'getFileToken', 500)
      }

      // Generate token using cache (with token generator function)
      const fileToken = cache.getOrSetFileToken(cleanDataObjectId, (length) => randomText(length))
      
      res.locals.freezr.permGiven = true
      return sendApiSuccess(res, { fileToken })
    } catch (err) {
      console.error('❌ Error in getFileToken:', err)
      return sendFailure(res, err, 'getFileToken', 500)
    }
  }

  /**
   * GET /feps/userfiles/:app_name/:user_id/*
   * Serve a user file with file token validation
   * Uses cache for multi-server token validation
   */
  const sendUserFileWithFileorAppToken = async (req, res) => {
    try {
      // Extract file path from URL
      // URL format: /feps/userfiles/:app_name/:user_id/*
      // Path structure: /feps/userfiles/app_name/user_id/file/path
      const parts = req.path.split('/').slice(4) // Skip: /feps/userfiles/app_name/user_id
      const filePath = decodeURI(parts.join('/'))
      const userId = req.params.user_id
      const appName = req.params.app_name
      const fileToken = req.query.fileToken

      const appTokenInfo = res.locals.freezr?.tokenInfo
      const validAppToken = appTokenInfo && appTokenInfo.owner_id === userId && appTokenInfo.app_name === appName ? appTokenInfo : null

      if (!fileToken && !validAppToken) {
        return res.sendStatus(401)
      }

      if (fileToken) { // Use file token
        // Get the files database and cache for this user/app
        // onsole.log('      🔑 sendUserFileWithFileorAppToken - using file token')
        const appTableDb = res.locals.freezr.appTableDb
        if (!appTableDb || !appTableDb.cache) {
          console.error('❌ Cache not available for file token validation')
          return res.sendStatus(500)
        }

        // Validate token using cache (multi-server compatible)
        const cache = appTableDb.cache
        const tokenTime = cache.validateFileToken(filePath, fileToken)
        
        if (!tokenTime) {
          console.error('❌ Invalid or expired file token trying to fetch ' + filePath)
          return res.sendStatus(401)
        }
      } else {
        // Use app token
        // onsole.log('      🔑 sendUserFileWithFileorAppToken -> With App Token appFS')
      }

      res.locals.freezr.permGiven = true
      const appFS = res.locals.freezr.appFS
      appFS.sendUserFile(filePath, res)
    } catch (err) {
      console.error('❌ Error in sendUserFileWithFileorAppToken:', err)
      return res.sendStatus(500)
    }
  }


  /**
   * POST /feps/serverless/:task
   * Handle microservice tasks (invoke, create, update, delete serverless functions)
   * Also handles local service management (upsert, delete) for admins
   * 
   * Middleware sets up: res.locals.freezr.tokenInfo, res.locals.freezr.userDS, res.locals.freezr.appFS, res.locals.freezr.thirdPartyFunctionsFS
   * 
   * Tasks:
   * - invokeserverless: Invoke a serverless function
   * - invokelocalservice: Invoke a local microservice
   * - createserverless: Create a new serverless function
   * - updateserverless: Update an existing serverless function
   * - upsertserverless: Create or update a serverless function
   * - deleteserverless: Delete a serverless function
   * - rolecreateserverless: Create AWS IAM role for Lambda
   * - upsertlocalservice: Upload/update a local microservice (admin only)
   * - deletelocalfunction: Delete a local microservice (admin only)
   */
  const serverlessTasks = async (req, res) => {
    try {
      // Import the tasks function from serverless.mjs
      const { tasks } = await import('../../../adapters/datastore/slConnectors/serverless.mjs')
      
      // Mark permission as given (middleware has already validated)
      res.locals.freezr.permGiven = true
      
      // Call the tasks handler
      return await tasks(req, res)
    } catch (error) {
      console.error('❌ Error in serverlessTasks:', error)
      return sendFailure(res, error, 'serverlessTasks', 500)
    }
  }

  return {
    ping,
    writeorUpsertRecord,
    upsertRecord,
    updateRecord,
    readRecordById,
    dbQuery,
    deleteRecords,
    shareRecords,
    messageActions,
    CEPSValidator,
    uploadUserFileAndCreateRecord,
    getFileToken,
    sendUserFileWithFileorAppToken,
    restoreRecord,
    serverlessTasks
  }
}

export default {
  createCepsApiController
}
