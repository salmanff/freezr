// freezr.info - Modern ES6 Module - CEPS API Controller
// Controller for CEPS API endpoints
// Calls legacy handlers from app_handler.js
// Middleware in routes sets up req properties that legacy handlers expect

import { sendFailure, sendAuthFailure, sendApiSuccess } from '../../../adapters/http/responses.mjs'
import { startsWith, endsWith, isEmpty, randomText, addToListAsUnique, getUniqueWords, removeFromListIfExists, isSafeRegex } from '../../../common/helpers/utils.mjs'
import { permissionTypesThatDontNeedTableId, PERMISSION_TYPES_FOR_WHICH_RECORDS_ARE_MARKED } from '../../../middleware/permissions/permissionDefinitions.mjs'
import { generateAppToken } from '../../../middleware/tokens/tokenHandler.mjs'
import { fileTokenStore } from '../../../middleware/tokens/fileTokenStore.mjs'
import { isSystemApp, validFilename } from '../../../common/helpers/config.mjs'
import { convert as convertPicture } from '../../../common/helpers/pictures.mjs'
import { removeStartAndEndSlashes } from '../../../adapters/datastore/fsConnectors/fileHandler.mjs'
import { getOrigIdWithOatRemoved } from '../../../adapters/datastore/dbConnectors/mongo_utils.mjs'
import { SYSTEM_PERMS } from '../../../common/helpers/config.mjs'
import { getAllSystemPermissionsForApp } from '../../../common/helpers/systemPermissions.mjs'
import { encryptResourceSensitiveFields } from '../../account/services/resourceCrypto.mjs'
import { isPermitted, resolveCapability, checkCapabilities, normalizeWebOption } from '../services/llmCapabilityService.mjs'
import { sanitizeModelKeys, unsanitizeModelKeys, canonicalizeModelMap, normalizePricingModels, makeEmptyTokensUsed, getModelFamily, findModelPrice, isLookupFailedForModel, applyPriceToTokensUsed, IMAGE_PRICING_SUFFIX, findImageModelPrice, applyImagePriceToTokensUsed, AUDIO_PRICING_SUFFIX, findAudioModelPrice, applyAudioPriceToTokensUsed } from '../services/llmCostService.mjs'
import { recordUsage, queryTallies, summarizeTallies, utcDay } from '../../account/services/usageTallyService.mjs'

// Writes to this table get their sensitive fields encrypted before persistence.
// See features/account/services/resourceCrypto.mjs for the per-type field map.
const RESOURCES_APP_TABLE = 'info.freezr.account.resources'

/**
 * Apply resource-record encryption when writing to info.freezr.account.resources.
 * No-op for all other tables. Returns a possibly-new write object; never mutates.
 */
const maybeEncryptResourceWrite = (appTable, write) => {
  if (appTable !== RESOURCES_APP_TABLE) return write
  return encryptResourceSensitiveFields(write)
}
import path from 'path'
import crypto from 'crypto'
import dns from 'dns'
import { promisify } from 'util'
import http from 'http'
import https from 'https'

const dnsLookup = promisify(dns.lookup)

/**
 * How long may the connector wait for this particular /feps/llm/ask?
 *
 * Bounded by whichever is sooner:
 *   - what the caller explicitly asked for (`options.timeoutMs`), and
 *   - how long the calling JOB has left (`x-freezr-job-deadline`, set by
 *     adapters/jobs/internalApiClient.mjs on every in-process job request).
 *
 * The job bound matters because a job that abandons a step does NOT cancel the request it
 * started: an in-process job's synthetic response has no socket, so it never emits 'close'
 * and the disconnect path below cannot fire for it. Without this, a local-CLI call outlives
 * the job that asked for it and keeps that connector's single slot — every later call is
 * refused 429 "busy" until the CLI's own 5-minute ceiling expires. An LLM call should never
 * outlive its job's budget regardless of this bug.
 *
 * Returns undefined when neither applies, leaving each connector on its own default. A
 * deadline already past yields 1ms, which connectors floor to their minimum — the call fails
 * fast rather than being handed a full fresh budget.
 */
export const resolveAskTimeoutMs = (req, options = {}) => {
  const candidates = []
  const requested = Number(options?.timeoutMs ?? req?.body?.timeoutMs)
  if (Number.isFinite(requested) && requested > 0) candidates.push(requested)
  const jobDeadline = Number(req?.headers?.['x-freezr-job-deadline'])
  if (Number.isFinite(jobDeadline) && jobDeadline > 0) candidates.push(Math.max(1, jobDeadline - Date.now()))
  return candidates.length > 0 ? Math.min(...candidates) : undefined
}

const BLOCKED_QUERY_OPERATORS = ['$where', '$function', '$accumulator', '$expr']
const rejectBlockedQueryOperators = function (q) {
  if (!q || typeof q !== 'object') return
  if (Array.isArray(q)) {
    q.forEach(item => rejectBlockedQueryOperators(item))
    return
  }
  for (const [key, value] of Object.entries(q)) {
    if (BLOCKED_QUERY_OPERATORS.includes(key)) {
      throw new Error('Query operator not allowed: ' + key)
    }
    if (value && typeof value === 'object') {
      rejectBlockedQueryOperators(value)
    }
  }
}

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
    write_all: false,
    write_own: false,
    grantedPerms: []
  }
   */

  const ping = function (req, res) {
    if (!res.locals.freezr) res.locals.freezr = {}
    res.locals.freezr.permGiven = true
    const sessionUserId = req.session?.logged_in_user_id
    const tokenUserId = res.locals.freezr?.tokenInfo?.requestor_id
    const userId = sessionUserId || tokenUserId
    if (!userId) {
      return sendApiSuccess(res, { logged_in: false, server_type: 'info.freezr', server_version: res.locals.freezr?.freezrPrefs?.version })
    } else {
      const pingResponse = { logged_in: true, logged_in_as_admin: !!req.session?.logged_in_as_admin, user_id: userId, server_type: 'info.freezr', server_version: res.locals.freezr?.freezrPrefs?.version, storageLimits: res.locals?.freezr?.freezrStorageLimits }
      // App-identified pings (valid Bearer app token) also get the app's permission grants
      // annotated with usability, plus the user-capability summary — set by addAppCapabilities.
      if (res.locals.freezr.appPermissions) {
        pingResponse.app_name = res.locals.freezr.tokenInfo?.app_name
        pingResponse.permissions = res.locals.freezr.appPermissions
        pingResponse.capabilities = res.locals.freezr.appCapabilities
      }
      return sendApiSuccess(res, pingResponse)
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
    if (dataObjectId?.endsWith('.files')) {
      return sendFailure(res, 'record ids cannot end in "files"', 'writeorUpsertRecord', 401)
    }
    // onsole.log('      🔑 writeorUpsertRecord dataObjectId', { dataObjectId, options, freezr: res.locals.freezr, tokenInfo: res.locals.freezr.tokenInfo, oac: res.locals.freezr.appTableDb.oac, appTableDb: res.locals.freezr.rightsToTable })
    const write = isOldFormatOrCepsFormat ? (req.body || {} ): req.body?._entity
    const appTableDb = res.locals.freezr.appTableDb
    const canWrite = res.locals.freezr.rightsToTable.own_record
      || res.locals.freezr.rightsToTable.write_all
      || (res.locals.freezr.rightsToTable.write_own)
    if (canWrite && appTableDb && write) {
      res.locals.freezr.permGiven = true
      if (!res.locals.freezr.rightsToTable.own_record) {
        write._created_by_user = res.locals.freezr.tokenInfo.requestor_id
        write._created_by_app = res.locals.freezr.tokenInfo.app_name
        if (!write._created_by_user || !write._created_by_app) {
          return sendFailure(res, 'Missing creator identity for cross-app write', 'writeRecord', 401)
        }
      }
      try {
        const writeToPersist = maybeEncryptResourceWrite(req.params.app_table, write)
        const result = await appTableDb.create(dataObjectId, writeToPersist)
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
      return sendFailure(res, 'Not authorized to write record (1)', 'writeorUpsertRecord', 401)
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
      write._created_by_user = res.locals.freezr.tokenInfo.requestor_id
      write._created_by_app = res.locals.freezr.tokenInfo.app_name
      if (!write._created_by_user || !write._created_by_app) {
        return sendFailure(res, 'Missing creator identity for cross-app write', 'upsertRecord', 401)
      }
    }

    if (existingRecord) {
      const canWrite = res.locals.freezr.rightsToTable.own_record
        || res.locals.freezr.rightsToTable.write_all
        || (res.locals.freezr.rightsToTable.write_own && existingRecord._created_by_user === res.locals.freezr.tokenInfo.requestor_id && existingRecord._created_by_app === res.locals.freezr.tokenInfo.app_name)

        if (canWrite && appTableDb && write && dataObjectId) {
          res.locals.freezr.permGiven = true
          try {
            const writeToPersist = maybeEncryptResourceWrite(req.params.app_table, write)
            const result = await appTableDb.update(dataObjectId, writeToPersist)
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
          return sendFailure(res, 'Not authorized to write record (2)', 'writeRecord', 401)
        }

    } else {
      if (dataObjectId.endsWith('.files')) {
        return sendFailure(res, 'record ids cannot end in "files"', 'upsertRecord', 401)
      }

      const canWrite = res.locals.freezr.rightsToTable.own_record
        || res.locals.freezr.rightsToTable.write_all
        || res.locals.freezr.rightsToTable.write_own

        if (canWrite && appTableDb && write && dataObjectId) {
          res.locals.freezr.permGiven = true
          try {
            const writeToPersist = maybeEncryptResourceWrite(req.params.app_table, write)
            const result = await appTableDb.create(dataObjectId, writeToPersist)
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
          return sendFailure(res, 'Not authorized to write record (3)', 'writeRecord', 401)
        } 
    }
  }

  const updateRecord  = async function (req, res) {
    // onsole.log('updateRecord req.body', req.body)
    const isOldFormat = !req.body?._entity
    const write = isOldFormat ? (req.body || {} ): req.body?._entity
    const options = isOldFormat ? (req.query || {}) : req.body   
    const isCeps = startsWith(req.baseUrl, '/ceps')
    const replaceAllFields = isCeps ? true : (options.replaceAllFields === 'true' || options.replaceAllFields === true)
    const isQueryBasedUpdate = (!isCeps && !req.params.data_object_id && req.body.q && req.body.keys)
    if (req.params.data_object_start) {
      // onsole.log('      🔑 updateRecord data_object_start', { data_object_start: req.params.data_object_start, path: req.path })
      const parts = req.path.split('/').slice(3)
      req.params.data_object_id = parts.join('/')
    }
    const dataObjectId = (req.params.data_object_id || write._id)
    // console.log('updateRecord', { req, requrl: req.url,isCeps, dataObjectId, replaceAllFields, options })
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

    // console.log('updateRecord', { rights:res.locals.freezr.rightsToTable, grantedPerms:res.locals.freezr.rightsToTable.grantedPerms, write, options, isCeps, replaceAllFields, isQueryBasedUpdate, dataObjectId, existingRecord })

    const canWrite = res.locals.freezr.rightsToTable.own_record 
      || res.locals.freezr.rightsToTable.write_all
      || (res.locals.freezr.rightsToTable.write_own && existingRecord && existingRecord._created_by_user === res.locals.freezr.tokenInfo.requestor_id && existingRecord._created_by_app === res.locals.freezr.tokenInfo.app_name)
      || (res.locals.freezr.rightsToTable.write_own && isQueryBasedUpdate)

    if (!existingRecord && !isQueryBasedUpdate) {
      console.warn('no existingRecord and not query based update', { dataObjectId, write, isQueryBasedUpdate })
      return sendFailure(res, 'Record not found', 'updateRecord', 404)
    } else if (existingRecord && isQueryBasedUpdate) {
      return sendFailure(res, 'Query based update not supported', 'updateRecord', 401)
    } else if (!canWrite && res.locals.freezr.rightsToTable.write_own) {
      console.warn('⚠️ Existing record has undefined _created_by_user or _created_by_app — possible data corruption from prior bug', { dataObjectId })
      return sendFailure(res, 'Record has missing creator identity — cannot update', 'updateRecord', 500)
    } else if (canWrite && appTableDb && write) {

      if (!res.locals.freezr.rightsToTable.own_record) {
        if (!write._modified_by_users) write._modified_by_users = []
        if (write._modified_by_users.indexOf(res.locals.freezr.tokenInfo.requestor_id) < 0) write._modified_by_users.push(res.locals.freezr.tokenInfo.requestor_id)
        write._lastModified_by_user = res.locals.freezr.tokenInfo.requestor_id
        // todo - refine _lastModified_by_app and modified_y_app to only write this if app is different
        write._lastModified_by_app = res.locals.freezr.tokenInfo.app_name

        if (existingRecord) {
          write._created_by_user = existingRecord._created_by_user
          write._created_by_app = existingRecord._created_by_app
        } else if (isQueryBasedUpdate) {
          write.q._created_by_user = res.locals.freezr.tokenInfo.requestor_id
          write.q._created_by_app = res.locals.freezr.tokenInfo.app_name
        }
      }
      
      res.locals.freezr.permGiven = true
      
      try {
        let result = null
        const writeToPersist = maybeEncryptResourceWrite(req.params.app_table, write)
        if (existingRecord) {
          result = await appTableDb.update(dataObjectId.toString(), writeToPersist, { replaceAllFields, old_entity: existingRecord })
          // console.log('update result', { dataObjectId, result })
          result._id = dataObjectId
          result._date_created = existingRecord._date_created
        } else { // isQueryBasedUpdate
          rejectBlockedQueryOperators(req.body.q)
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
      return sendFailure(res, 'Not authorized to write record (4)', 'writeRecord', 401)
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
      || res.locals.freezr.rightsToTable.write_all
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
    // read_by_id can return the CACHED object itself. The non-owner branches below delete fields
    // (_accessibles) from the record before sending it — done on the cached object, that would
    // permanently strip _accessibles from the cache, and a later shareRecords grant/deny reading
    // the record through the cache would then wipe every grant on it. Clone before any mutation.
    if (fetchedRecord) fetchedRecord = { ...fetchedRecord }
    // onsole.log('readRecordById permGiven 1', { aoc: appTableDb.oac, dataObjectId, fetchedRecord })

    if (res.locals.freezr.rightsToTable.own_record || res.locals.freezr.rightsToTable.can_read || res.locals.freezr.rightsToTable.write_all) {
      res.locals.freezr.permGiven = true
      if (!fetchedRecord) {
        return sendFailure(res, 'no related records exist', 'readRecordById', 401)
      }
      if (!res.locals.freezr.rightsToTable.own_record) delete fetchedRecord._accessible // old format
      if (!res.locals.freezr.rightsToTable.own_record) delete fetchedRecord._accessibles
      return sendApiSuccess(res, fetchedRecord)
    }

    // Conditional read with write_own or share_records
    // Guard a missing record before the per-permission checks below dereference it — the
    // own_record/can_read/write_all branch above returns early on null, this path must too, else a
    // read-by-id of a non-existent record crashes the server (Cannot read properties of null).
    if (!fetchedRecord) {
      return sendFailure(res, 'no related records exist', 'readRecordById', 401)
    }

    const requestee = res.locals.freezr.tokenInfo.requestor_id // .replace(/\./g, '_')
    // The app consuming this read. An _accessibles grantee is a (user, app) pair: entries with a
    // grantee_app name the consuming app explicitly (same-user app-scoped shares); entries without
    // one keep the legacy semantics (consuming app = the granting app, entry.requestor_app).
    // effectiveRequestorApp covers cross-user delegation, where the delegate app reads AS the
    // granting app (see createResolveRequestorDelegates).
    const consumingApp = res.locals.freezr.effectiveRequestorApp || res.locals.freezr.tokenInfo.app_name

    let relevantPerm = null
    let accessToRecord = false
    let permittedRecord

    res.locals.freezr.rightsToTable.grantedPerms.forEach(aPerm => {
      
      if (aPerm.type === 'write_own' && fetchedRecord._created_by_user === res.locals.freezr.tokenInfo.requestor_id && fetchedRecord._created_by_app === res.locals.freezr.tokenInfo.app_name) {
        accessToRecord = true
        relevantPerm = aPerm
      } else if (Array.isArray(fetchedRecord._accessibles) && fetchedRecord._accessibles.length > 0) {
        const accessibleObj = fetchedRecord._accessibles.find(obj =>
          obj.grantee === requestee &&
          obj.requestor_app === aPerm.requestor_app &&
          obj.permission_name === aPerm.name &&
          (obj.grantee_app || obj.requestor_app) === consumingApp &&
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
      delete permittedRecord._accessible // old format
      delete permittedRecord._accessibles
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
      || res.locals.freezr.rightsToTable.write_all
      || res.locals.freezr.rightsToTable.write_own
      || res.locals.freezr.rightsToTable.write_own_inner // used for public records
      || res.locals.freezr.rightsToTable.share_records

    if (!mayBeCanRead || (res.locals.freezr.rightsToTable.share_records && res.locals.freezr.rightsToTable.grantedPerms.length === 0)) {
      console.warn('dbQuery mayBeCanRead - not mayBeCanRead', { mayBeCanRead, rightsToTable: res.locals.freezr.rightsToTable, grantedPerms: res.locals.freezr.rightsToTable.grantedPerms, path: req.path })
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
            theQuery['_accessibles.grantee'] = res.locals.freezr.tokenInfo.requestor_id
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

    // transform regexes and block dangerous MongoDB operators
    const transformQueryRegexes = function (q) {
      const ret = {}
      for (const [key, value] of Object.entries(q)) {
        if (BLOCKED_QUERY_OPERATORS.includes(key)) {
          throw new Error('Query operator not allowed: ' + key)
        } else if (key === '$regex' && typeof value === 'string') {
          if (!isSafeRegex(value)) throw new Error('Unsafe regex pattern rejected')
          ret[key] = new RegExp(value, 'i')
        } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || !value) {
          ret[key] = value
        } else if (Array.isArray(value)) {
          // Only recurse into object elements. Primitive elements (e.g. the
          // strings/numbers in $in / $nin / $all, or $or/$and operands) must be
          // passed through untouched — recursing a string here would explode it
          // into a char-indexed object via Object.entries(), corrupting the query.
          ret[key] = value.map(inner => (inner && typeof inner === 'object') ? transformQueryRegexes(inner) : inner)
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
      console.warn('Query rejected', { e }, JSON.stringify(theQuery))
      return sendFailure(res, e.message || 'Invalid query', 'dbQuery', 400)
    }

    const appTableDb = res.locals.freezr.appTableDb

    let sort = (thePerm && thePerm.sort_fields) ? thePerm.sort_fields : req.body.sort
    // onsole.log('dbQuery sort', { appTableDbChoice: appTableDb.dbParams.choice , appTableUnificationStrategy: appTableDb.dbParams.dbUnificationStrategy})
    if (!sort) {
      if (appTableDb.dbParams.choice === 'cosmosForMongoString') {
        sort = { _date_modified: -1} //  cosmosformongostring needs to define this or each sort type
      } else {
        sort = { _date_modified: -1, _id: -1 } // include _id for stable sorting with skip 
      }
    }


    let queryResults = null
    try {
      queryResults = await appTableDb.query(theQuery, { sort, count, skip })
      // onsole.log('dbQuery queryResults', { theQuery, appTableOac: appTableDb.oac, resultCount: queryResults?.length, skip, count })
    } catch (err) {
      console.error('❌ Error querying database:', err)
      return sendFailure(res, err, 'dbQuery', 500)
    }
    // onsole.log('cepefepsquery - > queryResults', { theQuery, queryResults })
    if (queryResults.error) {
      console.warn('db_query - got err for theQuery ', theQuery, { err: queryResults.error })
      return sendFailure(res, queryResults.error, 'dbQuery', 500)
    }

    // share_records reads: the injected query only pinned (grantee, granted) — verify per record that
    // the grant's consuming app is THIS caller. A grantee is a (user, app) pair: entries with a
    // grantee_app name the consuming app explicitly; entries without one mean the granting app
    // (entry.requestor_app). effectiveRequestorApp covers cross-user delegation reads.
    if (thePerm && thePerm.type === 'share_records' && queryResults && queryResults.length > 0) {
      const shareConsumingApp = res.locals.freezr.effectiveRequestorApp || res.locals.freezr.tokenInfo.app_name
      const shareRequestee = res.locals.freezr.tokenInfo.requestor_id
      queryResults = queryResults.filter(rec => Array.isArray(rec._accessibles) && rec._accessibles.some(obj =>
        obj && obj.granted === true &&
        obj.grantee === shareRequestee &&
        (obj.grantee_app || obj.requestor_app) === shareConsumingApp
      ))
    }

    if (thePerm && queryResults && queryResults.length > 0) {
      // onsole.log('dbQuery queryResults 1 and 2', { thePerm, queryResults1: queryResults[0], queryResults2: queryResults.length > 1 ? queryResults[1] : null })
      // Clone before mutating: query results can be the cache's own objects — adding _owner or
      // deleting _accessibles (reduceToPermittedFields below) on them would poison the cache.
      queryResults = queryResults.map(anitem => {
        return { ...anitem, _owner: res.locals.freezr.tokenInfo.data_owner_user_id }
      })
      if (thePerm.return_fields && thePerm.return_fields.length > 0) {
        const reduceToPermittedFields = function (record, returnFields) {
          if (record._accessible) delete record._accessible // old format
          if (record._accessibles) delete record._accessibles
          if (!returnFields) return record
        
          returnFields.push('_date_modified')
          if (returnFields._accessibles) delete returnFields._accessibles
          if (returnFields._accessible) delete returnFields._accessible // old format
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
    if (res.locals.freezr.rightsToTable.own_record || res.locals.freezr.rightsToTable.write_all) {
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
      if (startsWith(req.baseUrl, '/ceps')) {
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
        rejectBlockedQueryOperators(req.body.q)
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
      const userId = req.session?.logged_in_user_id
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

      Identifier precedence (which record(s) to share / unshare):
        1. record_id (string | string[])      ← DEFAULT, the original record _id
        2. object_id_list (array of ids)      ← bulk by original ids
        3. query_criteria: { publicid }       ← when only the publicid is known (e.g. orphan cleanup, share-link UI)
        4. query_criteria: { ...mongoQuery }  ← arbitrary owner-side query

      Orphan recovery flags:
        - forcePublicIdTakeover (grant): if the chosen publicid is already held by an orphaned/conflicting
          public record, delete it and (when same collection) clean the source _accessibles, then proceed.
        - forcePublicIdCleanup (deny): if the source record can't be found but a public record exists for
          the supplied publicid, delete that orphaned public record. Requires `query_criteria.publicid`.
    */
    res.locals.flogger.track('shareRecords - test extra log', { function: 'shareRecords', requestorApp: res.locals.freezr.tokenInfo.app_name, userId: res.locals.freezr.tokenInfo.requestor_id })

    
    const queryFromBody = function (doGrant, rec) { 
      if (!rec) return null
      if (typeof rec === 'string') return { _id: rec } // for deny permission, this should be the original id - if not use publicid
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
    if (req.session?.logged_in_user_id && req.session.logged_in_user_id === userId && res.locals.freezr.tokenInfo.app_name === 'info.freezr.account' && req.body.requestor_app) {
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

    // console.log('🔑 share..', { body: req.body, requestorApp, userId, appTableId })

    // 1. initial checks
    // Block publicids that could collide with reserved route prefixes (even for admins)
    const RESERVED_ROUTE_PREFIXES = ['app/', 'apps/', 'admin/', 'adminapi/', 'account/', 'acctapi/', 'register/', 'creator/', 'creatorapi/', 'feps/', 'ceps/', 'oauth/', 'public/', 'publicapps/', 'login']
    if (req.body.publicid) {
      const normalised = req.body.publicid.replace(/^\/+/, '') // strip leading slashes
      if (RESERVED_ROUTE_PREFIXES.some(prefix => normalised === prefix.replace(/\/$/, '') || startsWith(normalised, prefix))) {
        return sendFailure(res, 'Public IDs cannot start with reserved paths (' + RESERVED_ROUTE_PREFIXES.join(', ') + ')', { function: 'shareRecords', requestorApp, userId }, 400)
      }
    }
    if (req.body.publicid &&
      (typeof req.body.record_id !== 'string' ||
      ((!req.session?.logged_in_as_admin && !req.session?.logged_in_as_publisher) && !startsWith(req.body.publicid, ('@' + req.session?.logged_in_user_id + '/' + requestorApp))))) { // implies: req.body.grantees.includes('_public') or 'privtefeed or privatelink'
      if (typeof req.body.record_id !== 'string') {
        return sendFailure(res, 'input error - cannot assign a public id to more than one entity - please include one record if under record_id', { function: 'shareRecords', requestorApp, userId })
      } else {
        return sendFailure(res, 'input error - non-admin and users who have no publishing rights  should always use the users name in their publicid, starting with an @ sign.', { function: 'shareRecords', requestorApp, userId })
      }
      // todo - possible future conflict if a user signs up with a name which an admin wants to use for their url
    } else if (req.body.publicid && !req.session?.logged_in_as_admin && requestorApp !== 'info.freezr.creator' &&
      startsWith(req.body.publicid, '@' + req.session?.logged_in_user_id + '/app/')) {
      return sendFailure(res, 'The @userId/app/ namespace is reserved for published creator apps.', { function: 'shareRecords', requestorApp, userId })
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

    const grantedPermission = permQueryResults && permQueryResults.length > 0 ? permQueryResults[0] : null
    if (!permQueryResults || permQueryResults.length === 0) {
      return sendFailure(res, 'permission with name ' + permissionName + ' and app ' + requestorApp + 'does not exist - try re-installing app', { function: 'shareRecords', requestorApp, userId })
    } else if (!grantedPermission.granted) {
      return sendFailure(res, 'permission not granted yet', { function: 'shareRecords', requestorApp, userId })
    } else if (appTableId && grantedPermission.type !== 'upload_pages' && grantedPermission.table_id !== appTableId && !grantedPermission.table_id.includes(appTableId)) {
      console.warn('The table being granted permission to does not correspond to the permission (2)', { grantedPermission, appTableId })
      return sendFailure(res, 'The table being granted permission to does not correspond to the permission (2)', { function: 'shareRecords', requestorApp, userId })
    } else if (appTableId && permissionTypesThatDontNeedTableId().includes(grantedPermission.type) && grantedPermission.type !== 'upload_pages' && grantedPermission.type !== 'allow_self_frames') {
      // upload_pages / allow_self_frames exception - technically they do not need one as it goes into files, but table id is added in the route chain 
      return sendFailure(res, 'Table id passed onto a permission type that doesnt need it.', { function: 'shareRecords', requestorApp, userId })
    } else if (permissionTypesThatDontNeedTableId().includes(grantedPermission.type) && appTableId !== res.locals.freezr.appTableDb?.oac?.app_table) {
      // appTableDb is only set by middleware when req.body.table_id is present, so it is undefined
      // for table-less permission types (eg use_app) - both sides are then undefined and this passes
      console.warn('The table being granted permission to does not correspond to the permission (1) ', { appTableId, appTableFromAppTableDb: res.locals.freezr.appTableDb?.oac?.app_table })
      return sendFailure(res, 'The table being granted permission to does not correspond to the permission ', { function: 'shareRecords', requestorApp, userId, appTableId, appTableFromAppTableDb: res.locals.freezr.appTableDb?.oac?.app_table })
    }else if (grantedPermission.type === 'upload_pages' && appTableId.split('.').pop() !== 'files') {
      return sendFailure(res, 'Upload pages permission can only be used on files', { function: 'shareRecords', requestorApp, userId })
    } else if (PERMISSION_TYPES_FOR_WHICH_RECORDS_ARE_MARKED.includes(grantedPermission.type) // ie share_records, message_records, upload_pages
      && (!appTableId || !res.locals.freezr.appTableDb || (grantedPermission.type !== 'upload_pages' && !grantedPermission.table_id.includes(res.locals.freezr.appTableDb.oac.app_table)))) {
        // removed grantedPermission.table_id === res.locals.freezr.appTableDb.oac.app_table)
        console.warn('The table being granted permission to does not correspond to the permission (3)', { grantedPermission, appTableId, appTableFromAppTableDb: res.locals.freezr.appTableDb })
        return sendFailure(res, 'The table being granted permission to does not correspond to the permission ', { function: 'shareRecords', requestorApp, userId })
    }
    if (permQueryResults.length > 1) {
      console.warn('two permissions found where one was expected - SNBH - System Error ' + JSON.stringify(permQueryResults))
    } 
    // console.log('Going to give permission (3)', { grantedPermission, appTableId, appTableFromAppTableDbOac: res.locals.freezr.appTableDb.oac })

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
      } else if (startsWith(grantee, 'app:')) {
        // Same-user app grantee: grants access to another app OF THE SAME USER. Expanded server-side
        // to the (owner user, app) pair — never an app alone, so on a multi-user server another user
        // running the same app can never match. No contact check: the grantee user is the owner.
        const granteeAppName = grantee.substring('app:'.length)
        if (!granteeAppName || !/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i.test(granteeAppName)) {
          granteesNotAllowed.push(grantee)
        } else if (!PERMISSION_TYPES_FOR_WHICH_RECORDS_ARE_MARKED.includes(grantedPermission.type)) {
          // App-scoped grants are only defined for record-marked sharing (share_records etc.);
          // table-level permission types keep user-identity grantees.
          return sendFailure(res, 'app grantees can only be used with record-marked permission types (eg share_records)', { function: 'shareRecords', requestorApp, userId })
        } else {
          allowedGrantees.push(grantee)
        }
      } else { // if (grantee.indexOf('@') > 0)
        grantee = grantee.replace(/\./g, '_')
        if (res.locals.freezr.userPrefs.blockMsgsFromNonContacts) {
          // to do - implement BlockMsgsFromNonContacts redo below for grantees with no servername
          // const granteeParts = grantee.split('@')
          // if (granteeParts.length < 2) {
          //   return sendFailure(res, 'need to implement for internal contact', { function: 'shareRecords', requestorApp, userId })
          // } else {
            let contactsResults = null
            try {
              contactsResults = await res.locals.freezr.userContactsDb.query({ searchname: grantee })
            } catch (err) {
              console.error( 'Error querying contacts', { error: err })
              res.locals.flogger.error('Error querying contacts', { function: 'shareRecords', requestorApp, userId, error: err })
              granteesNotAllowed.push(grantee)
              continue
            }
            if (contactsResults && contactsResults.length > 0) {
              allowedGrantees.push(grantee)
            } else {
              granteesNotAllowed.push(grantee)
            }
          // }
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
    
    // 4. For permission types that require records to be marked, mark the specific records and add the grantees in _accessibles (or remove them)
    if (PERMISSION_TYPES_FOR_WHICH_RECORDS_ARE_MARKED.includes(grantedPermission.type)) {
      let records = null
      try {
        records = await res.locals.freezr.appTableDb.query(recordQuery, {})
      } catch (err) {
        console.error('❌ Error querying records for sharing:', err)
        return sendFailure(res, err, 'shareRecords', 500)
      }
      if (!records || records.length === 0) {
        // Orphan cleanup: revoke + caller only has the publicid + explicit force flag → delete the orphaned public record only.
        // The source record is gone (or its _accessibles entry was already cleared) so there's nothing to update there.
        const orphanPublicid = req.body.query_criteria && req.body.query_criteria.publicid
        if (!doGrant && req.body.forcePublicIdCleanup && orphanPublicid && (hasPublicLink || hasPrivateLink || hasPrivateFeed)) {
          let orphanResults = null
          try {
            orphanResults = await res.locals.freezr.publicRecordsDb.query({ _id: orphanPublicid }, {})
          } catch (err) {
            return sendFailure(res, 'Force cleanup: failed to query public record', { function: 'shareRecords', requestorApp, userId, publicid: orphanPublicid, error: err }, 500)
          }
          const orphan = orphanResults && orphanResults.length > 0 ? orphanResults[0] : null
          if (!orphan) {
            return sendFailure(res, 'Force cleanup: no source record and no public record found to clean up', { function: 'shareRecords', requestorApp, userId, publicid: orphanPublicid })
          }
          const isAdminOrPublisher = !!(req.session?.logged_in_as_admin || req.session?.logged_in_as_publisher)
          if (orphan.data_owner !== userId && !isAdminOrPublisher) {
            return sendFailure(res, 'Force cleanup: not allowed to delete this public record', { function: 'shareRecords', requestorApp, userId, publicid: orphanPublicid }, 403)
          }
          try {
            await res.locals.freezr.publicRecordsDb.delete_record(orphanPublicid, {})
          } catch (err) {
            return sendFailure(res, 'Force cleanup: failed to delete orphaned public record', { function: 'shareRecords', requestorApp, userId, publicid: orphanPublicid, error: err }, 500)
          }
          return sendApiSuccess(res, { success: true, recordsChanged: 0, orphanPublicIdRemoved: orphanPublicid })
        }
        return sendFailure(res, 'no records found to add or remove grantees to ', { db: res.locals.freezr.appTableDb.oac, recordQuery,function: 'shareRecords', requestorApp, userId })
      } 

      // recordsToChange = records
      const appTableOac = res.locals.freezr.appTableDb?.oac
      for (const rec of records) {
        // const accessible = rec._accessible || {} // Old Format
        const accessibles = rec._accessibles || []
        // In unified-DB Mongo mode, rec._id is stored as `<owner>__<appTable>__<originalId>`.
        // Strip the prefix so any "external" use (file path, public URL slug, original_record_id
        // field, comparisons against other plain ids) sees the original application-level id.
        // Internal DB ops (update/query by _id) are unaffected because the Mongo adapter is
        // idempotent in adding the prefix back.
        const recOriginalId = getOrigIdWithOatRemoved(rec._id, appTableOac)
        const recOriginalIdStr = recOriginalId == null ? '' : recOriginalId.toString()

        if (doGrant) {
          for (const grantee of allowedGrantees) {
            // 'app:<appName>' grantees expand to (owner user, app): grantee = the owner's own userId,
            // grantee_app = the consuming app. Read paths match (grantee, grantee_app ?? requestor_app).
            const isAppGrantee = startsWith(grantee, 'app:')
            const granteeApp = isAppGrantee ? grantee.substring('app:'.length) : null
            const granteeKey = isAppGrantee ? userId : ((grantee === '_public' || grantee === '_privatelink') ? grantee : ((startsWith(grantee, '_privatefeed:')) ? grantee.substr(0, 12) : grantee))

            // find array object on the full (grantee, grantee_app, requestor_app, permission_name)
            // tuple, so an app-scoped grant never collides with a user-scoped one on the same record
            let accessibleObject = accessibles.find(obj => obj.grantee === granteeKey && (obj.grantee_app || null) === granteeApp && obj.requestor_app === requestorApp && obj.permission_name === permissionName)
            if (!accessibleObject) {
              accessibleObject = { grantee: granteeKey, requestor_app: requestorApp, permission_name: permissionName, granted: true }
              if (granteeApp) accessibleObject.grantee_app = granteeApp
              accessibles.push(accessibleObject)
            }
            accessibleObject.granted = true
            
            if (granteeKey === '_public' || granteeKey === '_privatelink' || granteeKey === '_privatefeed') {
              const publicid = ((granteeKey === '_public' && req.body.publicid) ? req.body.publicid : ('@' + userId + '/' + appTableId + '/' + recOriginalIdStr))
              accessibleObject.public_id = publicid
              accessibleObject._date_published = datePublished
              accessibleObject._date_modified = new Date().getTime()
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
              let existingPublicRecord = publicIdResults.length > 0 ? publicIdResults[0] : null

              // Compare the public record's original_record_id against the prefix-stripped current
              // record id. Strip both sides defensively to handle records written before the
              // strip-on-write fix (which stored the prefixed _id into original_record_id).
              const existingOriginalIdStripped = existingPublicRecord
                ? getOrigIdWithOatRemoved(existingPublicRecord.original_record_id?.toString(), appTableOac)
                : null
              if (existingPublicRecord && (existingPublicRecord.data_owner !== userId || existingPublicRecord.original_app_table !== appTableId || existingOriginalIdStripped !== recOriginalIdStr)) {
                console.warn('check freezrPublicRecordsDB req.body.publicid used - to recheck this ' + req.body.publicid + ' appTableId', appTableId, 'rec._id ', rec._id, publicIdResults)
                // 
                if (!req.body.forcePublicIdTakeover ||
                    !(existingPublicRecord.data_owner === userId &&
                      existingPublicRecord.original_app_table === res.locals.freezr.appTableDb.oac.app_table) 
                ) {
                  return sendFailure(res, 'Another entity already has the id requested. Please use a different public id.', { function: 'shareRecords', requestorApp, userId })
                }

                try {
                  const srcRecs = await res.locals.freezr.appTableDb.query({ _id: existingPublicRecord.original_record_id }, {})
                  if (srcRecs && srcRecs.length > 0) {
                    const srcRec = srcRecs[0]
                    const originalAccessibles = srcRec._accessibles || []
                    const cleaned = originalAccessibles.filter(a => a.public_id !== publicid)
                    if (cleaned.length !== originalAccessibles.length) {
                      await res.locals.freezr.appTableDb.update(srcRec._id.toString(), { _accessibles: cleaned }, { newSystemParams: true, replaceAllFields: false })
                    }
                  }
                } catch (err) {
                  res.locals.flogger.error('Force takeover: could not clean source _accessibles', { function: 'shareRecords', requestorApp, userId, publicid, error: err })
                  // continue - public record delete is the primary goal
                }

                try {
                  await res.locals.freezr.publicRecordsDb.delete_record(publicid, {})
                } catch (err) {
                  return sendFailure(res, 'Force takeover: failed to delete existing public record', { function: 'shareRecords', requestorApp, userId, publicid, error: err }, 500)
                }
                existingPublicRecord = null
              }
              const accessiblesObject = existingPublicRecord || {
                data_owner: userId,
                original_app_table: appTableId,
                requestor_app: requestorApp,
                permission_name: req.body.name,
                original_record_id: recOriginalIdStr,
                original_record: rec,
                _date_published: datePublished,
                fileStructure: isHtmlMainPage ? req.body.fileStructure : null,
                meta: isHtmlMainPage && req.body.meta ? req.body.meta : null,
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
                if (req.body.fileStructure) accessiblesObject.fileStructure = req.body.fileStructure
                if (req.body.meta !== undefined) accessiblesObject.meta = req.body.meta || null
                // recOriginalIdStr has the unified-DB `<owner>__<appTable>__` prefix removed,
                // which is required so the file path is just e.g. `projects/.../index.html`.
                const path = recOriginalIdStr
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
            const isAppGrantee = startsWith(grantee, 'app:')
            const granteeApp = isAppGrantee ? grantee.substring('app:'.length) : null
            const granteeKey = isAppGrantee ? userId : ((grantee === '_public' || grantee === '_privatelink') ? grantee : (startsWith(grantee, '_privatefeed:')) ? grantee.substr(0, 12) : grantee)
            // future - could keep all public id's and then use those to delete them later
            let accessiblePublicid = null
            // match on the full (grantee, grantee_app, requestor_app, permission_name) tuple, so an
            // app-scoped grant can be revoked without touching a user-scoped one on the same record
            const index = accessibles.findIndex(obj => obj.grantee === granteeKey && (obj.grantee_app || null) === granteeApp && obj.requestor_app === requestorApp && obj.permission_name === permissionName);
            if (index !== -1) {
              const accessibleObject = { ...accessibles[index] };
              accessibles.splice(index, 1);
              // accessibleObject can be used or logged if needed
              accessiblePublicid = accessibleObject.public_id
            }

            // REMOVE PUBLIC HERE
            if (granteeKey === '_public' || granteeKey === '_privatelink' || granteeKey === '_privatefeed') {
              const fallbackPublicid = ((granteeKey === '_public' && req.body.publicid) ? req.body.publicid : ('@' + userId + '/' + appTableId + '/' + recOriginalIdStr))
              const publicid = accessiblePublicid || fallbackPublicid
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
    res.locals.freezr.permGiven = true
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
        // Stamp system file metadata onto the files record (merged, so the app's own `data`
        // fields are preserved). Computed from what was actually written so the size is correct
        // even when convertPict re-encodes the file. These are system-managed: setting them here
        // (after the app's data was written) means a value the app tried to put in `data` cannot
        // spoof them. _file_extension is lower-cased and dot-less (e.g. 'pdf').
        const fileMeta = {
          _UploadStatus: 'complete',
          _file_size: (theFile && theFile.length) || req.file.size || 0,
          _mime_type: (options.convertPict && options.convertPict.type === 'jpg') ? 'image/jpeg' : (req.file.mimetype || ''),
          _file_extension: fileParams.name.includes('.') ? fileParams.name.split('.').pop().toLowerCase() : ''
        }
        await userFilesDb.update(dataObjectId.toString(), fileMeta, { replaceAllFields: false })
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
      const isSelfSend = username === messageCopy.sender_id

      if (!isSelfSend && !freezr.freezrOtherPersonContacts?.[username]) {
        throw new Error('no contact db found for user ' + username)
      }
      if (!freezr.freezrOtherPersonGotMsgs?.[username]) {
        throw new Error('no msgdb found for user ' + username)
      }

      // Check if recipient has sender as contact (skipped on self-send: users are not
      // contacts of themselves, and the flag would wrongly mark their own messages)
      if (!isSelfSend) {
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
        
        const transmitReq = httpOrHttps.request(sendOptions, (transmitRes) => {
          let chunks = ''
          transmitRes.on('data', (chunk) => {
            chunks += chunk.toString('utf-8')
          })
          transmitRes.on('end', () => {
            try {
              const parsed = JSON.parse(chunks)
              if (parsed.error) {
                console.warn('transmission err from server ', { messageCopy, parsed })
                reject(new Error('recipient server refusal'))
              } else {
                resolve(parsed)
              }
            } catch (e) {
              console.warn('error parsing transmit response', { chunks, e })
              reject(new Error('recipient server verification'))
            }
          })
        })
        transmitReq.on('error', (error) => {
          console.warn('error in transmit ', error)
          reject(new Error('recipient server connection'))
        })
        transmitReq.write(JSON.stringify(messageCopy))
        transmitReq.end()
      })
    }

    try {
      switch (action) {
        case 'initiate': {
          // console.log('🔑 messageActions initiate', { action, body: req.body, params: req.params })
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

          if (!params.type) params.type = 'message_records'
          if (params.type !== 'message_records' && params.type !== 'message_direct') {
            return sendFailure(res, 'only message_records and message_direct type messaging currently allowed', 'messageActions', 400)
          }
          // Sender identity is authoritative from the TOKEN, not the client. Browser clients stamp
          // sender_id/sender_host from freezrMeta, but the job runtimes have no full freezrMeta
          // (adapters/jobs/jobClientCore.mjs builds a minimal sandbox), so: default a missing
          // sender_id from the token (a SUPPLIED one must still match it — checked below), and treat
          // sender_host as OPTIONAL. sender_host is only load-bearing for CROSS-SERVER sends (the
          // recipient server authenticates by calling back <sender_host>/ceps/message/verify), so
          // those are refused without it (guard below). Long-term: derive it from a canonical-server-
          // url admin pref rather than trusting the client — see TODO.md.
          if (!params.sender_id) params.sender_id = freezr.tokenInfo.requestor_id
          if (!params.sender_host) delete params.sender_host // '' from the job SDK → treat as absent
          if (params.sender_host && typeof params.sender_host !== 'string') {
            return sendFailure(res, 'sender_host invalid', 'messageActions', 400)
          }
          // message_records shares a stored record (needs a record_id, or a message_id to reply about one);
          // message_direct carries free text + an optional opaque payload (neither required). table_id is
          // required for both (above), so the message always lands in a specific app's inbox.
          // See freezr_askapp_sharing_summary.md §3 (Message shapes).
          if (!objectFieldsHaveAllStrings(params, ['app_id', 'sender_id', 'table_id']) ||
              (params.type === 'message_records' && !params.record_id && !params.message_id)) {
            return sendFailure(res, 'field insufficency mismatch', 'messageActions', 400)
          }
          if (params.sender_id !== freezr.tokenInfo.requestor_id) {
            return sendFailure(res, 'requestor id mismatch', 'messageActions', 401)
          }
          if (params.app_id !== freezr.tokenInfo.app_name) {
            return sendFailure(res, 'app id mismatch', 'messageActions', 401)
          }
          if (!params.messaging_permission) {
            return sendFailure(res, 'missing permission names in request', 'messageActions', 400)
          }
          // contact_permission is optional (the grant was never actually enforced — see the commented-out
          // contactPerm check below); when present it must be a string as it is echoed in the envelope.
          if (params.contact_permission && typeof params.contact_permission !== 'string') {
            return sendFailure(res, 'contact_permission invalid', 'messageActions', 400)
          }
          // recipient_app is optional routing: which app's inbox this message is addressed to (honored by
          // the inbox read rule for same-user recipients). app_id stays pinned to the sender's token —
          // it is authentication; recipient_app is routing.
          if (params.recipient_app && typeof params.recipient_app !== 'string') {
            return sendFailure(res, 'recipient_app invalid', 'messageActions', 400)
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
          // Cross-server sends REQUIRE sender_host — the recipient server authenticates the message
          // by calling back <sender_host>/ceps/message/verify with the nonce, so a message without a
          // sender_host can never be verified. Refuse LOUDLY here rather than failing weirdly at the
          // recipient (this is the deliberately-unsupported case for background jobs until a
          // canonical-server-url admin pref exists — see TODO.md). Same-server recipients carry no
          // recipient_host, so same-user/app-to-app sends pass through.
          if (!params.sender_host) {
            const crossHostRecipient = (freezr.freezrMessageRecipients || []).find(r => r && r.recipient_host)
            if (crossHostRecipient) {
              return sendFailure(res, 'sender_host is required for cross-server messages (unavailable from background jobs until the canonical server url pref exists)', 'messageActions', 400)
            }
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
          // Layer in auto-granted system-app messaging/contacts perms (common/systemPermissions.json) so
          // system apps (e.g. info.freezr.creator sharing ask-apps) can message without a user-grant
          // dialog. See freezr_askapp_sharing_summary.md §3. Fabricated in-memory records, never written.
          permsResults = (permsResults || []).concat(getAllSystemPermissionsForApp(freezr.tokenInfo.app_name))
          if (!permsResults || permsResults.length === 0) {
            return sendFailure(res, 'Sharing Permissions missing - internal', 'messageActions', 401)
          }

          permsResults.forEach(aPerm => {
            if (aPerm.name === params.messaging_permission &&
              aPerm.granted && aPerm.type === 'message_records' && (params.type === 'message_records' || params.type === 'message_direct') &&
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

          // 3. Get record (message_records only; message_direct carries no stored record)
          let fetchedRecord = null
          if (params.record_id) {
            try {
              fetchedRecord = await freezr.appTableDb.read_by_id(params.record_id)
            } catch (err) {
              return sendFailure(res, 'Error reading record', { function: 'messageActions', error: err }, 500)
            }
          }

          // 4. Construct a permitted-record
          if (params.type === 'message_records') {
            if (!fetchedRecord) {
              return sendFailure(res, 'no related records', 'messageActions', 404)
            }
            if (!messagingPerm.table_id.includes(freezr.appTableDb.oac.app_table)) {
              return sendFailure(res, 'messaging table id mismatch ' + messagingPerm.table_id + ' vs ' + freezr.appTableDb.oac.app_table, 'messageActions', 400)
            }

            recordAccessibleField = fetchedRecord._accessibles || []

            // Check permission
            if (messagingPerm && messagingPerm.return_fields && messagingPerm.return_fields.length > 0) {
              permittedRecord = {}
              messagingPerm.return_fields.forEach(key => {
                if (params?.record && params.record[key]) permittedRecord[key] = params.record[key]
              })
            } else {
              permittedRecord = JSON.parse(JSON.stringify(params.record))
            }
            delete permittedRecord._accessible // old format
            delete permittedRecord._accessibles
          } else if (params.type === 'message_direct') {
            // No stored record: pass the app-defined payload through opaquely (no return_fields trim, no
            // _accessibles grant), or null for a text-only message. Recipient-side validation only (the
            // blockMsgsToNonContacts pref). See freezr_askapp_sharing_summary.md §3 (message_direct).
            permittedRecord = (params.record && typeof params.record === 'object') ? JSON.parse(JSON.stringify(params.record)) : null
            if (permittedRecord) { delete permittedRecord._accessible; delete permittedRecord._accessibles }
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
              // Self-send (recipient user is the sender user, same host — eg app-to-app messaging within
              // one account) needs no contacts entry: users are not contacts of themselves.
              if (recipient.recipient_id === params.sender_id && (!recipient.recipient_host || recipient.recipient_host === params.sender_host)) {
                validatedRecipients.push(recipient)
                continue
              }
              try {
                let contactResults = null
                try {
                  contactResults = await freezr.userContactsDb.query({ username: recipient.recipient_id, serverurl: recipient.recipient_host }, {})
                  console.log('validate recipients if blocking messages to non-contacts', { contactResults })
                } catch (err) {
                  console.error('❌ Error querying contacts:', err)
                  recipientStatus[recipientAsJsonKey(recipient)] = { status: 'err', err: err.message, recipient_id: recipient.recipient_id, recipient_host: recipient.recipient_host }
                  recipientsWithErrorsSending.push({ recipient_id: recipient.recipient_id, recipient_host: recipient.recipient_host, err: 'Could not verify contact' })
                  continue
                }
                if (!contactResults || contactResults.length === 0) {
                  console.log('validate recipients if blocking messages to non-contacts', { contactResults })
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
            console.log('validate recipients if blocking messages to non-contacts', { validatedRecipients })
            console.log('validate recipients if blocking messages to non-contacts', { freezrMessageRecipients: freezr.freezrMessageRecipients })
          }

          // 7. Separate sameHost from otherHost members
          if (!validatedRecipients || validatedRecipients.length === 0) {
            console.warn('messageActions no members to share with')
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
            console.log('🔑 messageActions initiate - sending to same host members ', { validatedSameHostMembers })
            const messageCopy = JSON.parse(JSON.stringify(messageToKeep))
            delete messageCopy.recipientStatus
            delete messageCopy.nonces

            for (const recipient of validatedSameHostMembers) {
              console.log('🔑 messageActions initiate - sending to same host member ', { recipient })
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
            console.log('🔑 messageActions initiate - sending to other host members ', { validatedOtherHostMembers })
            for (const recipient of validatedOtherHostMembers) {
              console.log('🔑 messageActions initiate - sending to other host member ', { recipient })
              try {
                const resp = await transmitMessage(recipient, messageToKeep)
                console.log('🔑 messageActions initiate - response from other host member ', { resp })
                if (resp?.success) {
                  recipientsSuccessfullysentTo.push({ recipient_id: recipient.recipient_id, recipient_host: recipient.recipient_host })
                } else {
                  recipientsWithErrorsSending.push({ recipient_id: recipient.recipient_id, recipient_host: recipient.recipient_host, err: (resp?.error || 'failure to send') })
                }
              } catch (err) {
                console.warn('messageActions transmitted msg with ', { recipient, err })
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

          // 11. Update record _accessibles field with messaging grants (message_records only — a
          // message_direct has no stored record to stamp, so skip). This stamping is what grants each
          // same-host recipient the grantee file-fetch of a shared record. §2-3.
          if (params.record_id) {
            if (!Array.isArray(recordAccessibleField)) recordAccessibleField = []
            recipientsSuccessfullysentTo.forEach(recipient => {
              const recipientString = recipientAsJsonKey(recipient)
              let entry = recordAccessibleField.find(obj => obj.grantee === recipientString && obj.requestor_app === params.app_id && obj.permission_name === params.messaging_permission)
              if (!entry) {
                entry = { grantee: recipientString, requestor_app: params.app_id, permission_name: params.messaging_permission, granted: true, messaged: [] }
                recordAccessibleField.push(entry)
              }
              if (!entry.messaged) entry.messaged = []
              entry.messaged.push(new Date().getTime())
            })
            try {
              const updateResult = await freezr.appTableDb.update(params.record_id.toString(), { _accessibles: recordAccessibleField }, { replaceAllFields: false, newSystemParams: true })
              console.log('🔑 messageActions initiate 11 - update result ', { updateResult })
            } catch (err) {
              console.error('❌ Error updating record accessible field:', err)
              return sendFailure(res, 'Error updating record accessible field', { function: 'messageActions', error: err }, 500)
            }
          }

          console.log('🔑 messageActions initiate 11 end ', { success: true, recipientsSuccessfullysentTo, recipientsWithErrorsSending })

          return sendApiSuccess(res, { success: true, recipientsSuccessfullysentTo, recipientsWithErrorsSending })
        }

        case 'transmit': {
          console.log('🔑 messageActions transmit', { action, body: req.body, params: req.params })
          const receivedParams = req.body
          let storedmessageId = null
          let senderIsAContact = false
          let status = 0

          // 1. Validate fields
          const fields = ['app_id', 'sender_id', 'sender_host', 'recipient_host', 'recipient_id', 'type', 'contact_permission', 'recipient_app', 'table_id', 'nonce', 'message', 'messaging_permission', 'record']
          const fieldExceptions = ['message', 'record_id', 'record', 'message_id', 'contact_permission', 'recipient_app']
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
          console.log('🔑 messageActions transmit - http module ', { isLocalhost })

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
              console.log('🔑 messageActions transmit - response from sender ') // , { verifyRes })
              let chunks = ''
              verifyRes.on('data', function (chunk) {
                chunk = chunk.toString('utf-8')
                if (chunk.slice(-1) === '\n') chunk = chunk.slice(0, -1)
                chunks += chunk
              })

              verifyRes.on('end', function () {
                try {
                  const data = JSON.parse(chunks)
                  console.log('🔑 messageActions transmit - endverify') // , { verifyResponseData: data })
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
            console.log('🔑 messageActions transmit', { verifyReq: JSON.stringify(receivedParams) })
            verifyReq.write(JSON.stringify(receivedParams))
            verifyReq.end()
          })

          // 5. Update the record
          status = 3
          if (verifyResponse.record) {
            try {
              console.log('🔑 messageActions transmit - updating received message ', { storedmessageId }) // verifyResponse
              const updateResult = await freezr.userMessagesGotDb.update(storedmessageId, { message: verifyResponse.message, record: verifyResponse.record, status: 'verified' }, { replaceAllFields: false })
              console.log('🔑 messageActions transmit - update result ', { updateResult })
            } catch (err) {
              return sendFailure(res, 'Error updating received message 3', { function: 'messageActions', error: err.message }, 500)
            }
          }

          return sendApiSuccess(res, { success: true })
        }

        case 'verify': {
          console.log('🔑 messageActions verify', { action, body: req.body, params: req.params })
          if (!req.body.nonce) {
            return sendFailure(res, 'nonce required to verify messages', 'messageActions', 401)
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
            return sendFailure(res, 'no results from nonce in message', 'messageActions', 401)
          }

          const haveDifferentMessageFields = (dbMessage, verifyeeMessage) => {
            const fields = ['app_id', 'sender_id', 'sender_host', 'table_id'] // contact_permission is optional so no longer compared
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

          console.log('🔑 messageActions verify - end ', { record: results[0].record, message: results[0].message, success: true })

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
              // An app may mark messages it sent (app_id) or messages addressed to it (recipient_app)
              if (!results || results.length === 0 || (results[0].app_id !== freezr.tokenInfo.app_name && results[0].recipient_app !== freezr.tokenInfo.app_name)) {
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
            // Two separate updates (not $or — the cache query matcher only supports plain field
            // equality): messages the app sent and messages addressed to it via recipient_app.
            // 'no record found to update' just means one of the two sets is empty.
            for (const markAllQuery of [{ app_id: freezr.tokenInfo.app_name }, { recipient_app: freezr.tokenInfo.app_name }]) {
              try {
                await freezr.userMessagesGotDb.update(markAllQuery, { marked_read: true }, { replaceAllFields: false })
              } catch (err) {
                if (!err?.message?.includes('no record')) {
                  return sendFailure(res, 'Error updating all messages read status', { function: 'messageActions', error: err }, 500)
                }
              }
            }
          }

          res.locals.freezr.permGiven = true
          return sendApiSuccess(res, { success: true })
        }

        case 'get': {
          // GET /ceps/messages — the app's inbox: messages it sent that landed here (app_id, which is
          // pinned to the sender's token) plus messages addressed to it via the optional recipient_app
          // routing field. Two queries rather than $or (the cache query matcher only supports plain
          // field equality), deduped by _id.
          const appName = freezr.tokenInfo.app_name
          const skip = req.query?.skip ? parseInt(req.query.skip) : 0
          const count = req.query?.count ? parseInt(req.query.count) : 50
          const unreadOnly = req.query?.unread_only === 'true' || req.query?.unread_only === true

          const messages = []
          const seenIds = {}
          for (const getQuery of [{ app_id: appName }, { recipient_app: appName }]) {
            if (unreadOnly) getQuery.marked_read = { $ne: true }
            let results = null
            try {
              // fetch enough to honor skip+count after the two result sets are merged
              results = await freezr.userMessagesGotDb.query(getQuery, { sort: { _date_created: -1 }, count: (skip + count) })
            } catch (err) {
              return sendFailure(res, 'Error querying messages', { function: 'messageActions', error: err }, 500)
            }
            (results || []).forEach(msg => {
              const idString = msg._id?.toString()
              if (!seenIds[idString]) {
                seenIds[idString] = true
                messages.push(msg)
              }
            })
          }
          messages.sort((a, b) => (b._date_created || 0) - (a._date_created || 0))

          res.locals.freezr.permGiven = true
          return sendApiSuccess(res, { messages: messages.slice(skip, skip + count) })
        }

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
    console.log('CEPSValidator', { action, body: req.body, params: req.params })
    const EXPIRY_DEFAULT = 30 * 24 * 60 * 60 * 1000 // 30 days // 60 * 60 * 1000 // 60 minute (TEST) // 

    // Helper: check if a CEPS identifier param contains unsafe characters for query strings
    const UNSAFE_PARAM_CHARS = /[&=?#\s]/
    const hasCepsParamIssues = (params) => {
      for (const [key, value] of Object.entries(params)) {
        if (value && typeof value === 'string' && UNSAFE_PARAM_CHARS.test(value)) {
          console.warn('CEPSValidator - unsafe characters in param:', key)
          return true
        }
      }
      return false
    }

    // Helper: check if a hostname resolves to a private/internal IP (SSRF protection)
    const isPrivateIP = (ip) => {
      // IPv4 private ranges
      if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip === '127.0.0.1' || ip === '0.0.0.0') return true
      if (ip.startsWith('172.')) {
        const second = parseInt(ip.split('.')[1], 10)
        if (second >= 16 && second <= 31) return true
      }
      // IPv4 link-local and metadata
      if (ip.startsWith('169.254.')) return true
      // IPv6 loopback and private
      if (ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true
      return false
    }

    const hostResolvesToPrivateIP = async (hostname) => {
      try {
        const result = await dnsLookup(hostname, { all: true })
        const addresses = Array.isArray(result) ? result : [result]
        for (const entry of addresses) {
          if (isPrivateIP(entry.address)) return true
        }
        return false
      } catch (err) {
        // DNS resolution failure - treat as suspicious
        console.error('CEPSValidator - DNS lookup failed for:', hostname, err.message)
        return true
      }
    }

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

        let validationtoken = crypto.randomBytes(32).toString('hex') // 64-char crypto-secure token
        validationtoken = validationtoken.replace(/[&=?]/g, '') // this should not be needed but jst in case
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
          app_id: freezr.tokenInfo.app_name, // requestor app
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
        // onsole.log('CEPSValidator validate', { q: req.query, permsdboac: freezr.userPermsDB.oac })
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
            console.warn('invalid requst getting granted perms ', { user: req.session?.logged_in_user_id, grantedPerms, dbQuery }, req.query)
            const allPerms = await freezr.userPermsDB.query({}, {})
            // console.warn('allPerms', { allPerms })
            for (const perm of allPerms) {
              if (perm.name === req.query.permission) console.warn('perm', { perm })
            }
            return sendFailure(res, 'invalid request 2', 'CEPSValidator', 401)
          }

          // Check if requestor is in grantees
          let hasRight = false
          const requesterUserIsOwner = (query) => {
            return (query.data_owner_user === query.requestor_user && 
              ((!query.requestor_host && !query.data_owner_host) || query.requestor_host === query.data_owner_host))
          }
          grantedPerms.forEach((item) => {
            if (requesterUserIsOwner(req.query) ||
              (item.grantees && item.grantees.includes(requestor))) hasRight = true
          })

          if (!hasRight) {
            console.error('invalid request getting granted perms ', { requestor })
            return sendFailure(res, 'invalid request getting permissions granted', 'CEPSValidator', 401)
          }

          // extra check - should be redundant - but just in case
          const oacOwner = freezr.userPermsDB.oac.owner
          if (oacOwner !== req.query.data_owner_user) {
            console.error('invalid request - oacOwner mismatch ', { oacOwner, data_owner_user: req.query.data_owner_user })
            return sendFailure(res, 'invalid request - oacOwner mismatch', 'CEPSValidator', 401)
          }

        }

        // 4. Verify validation token
        let verified = false
        if (!req.query.data_owner_host) { // ie requestor is samehost as owner
          if (req.query.data_owner_user === 'public') { // exception for common db's - for privateFeedCodes
            const perm = SYSTEM_PERMS[req.query.permission] // 2026-01 changed this reference to config.mjs without testing - ws in this file previously
            if (perm && perm.table_id === req.query.table_id && Array.isArray(perm.grantees) && perm.grantees.includes('_allUsers')) {
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
            // Delete the validation token after successful use (single-use nonce)
            try {
              await freezr.validationTokenDB.delete_records({ validation_token: req.query.validation_token }, {})
            } catch (err) {
              console.warn('⚠️ Could not delete used validation token:', err)
              // Non-fatal: token will expire in 5 minutes anyway
            }
            verified = true
          }
        } else {
          // onsole.log('CEPSValidator cross-host verification', { q: req.query })
          // Cross-host verification - make HTTP request to requestor's server

          // Validate params don't contain query-string-breaking characters
          const crossHostParams = {
            validation_token: req.query.validation_token,
            data_owner_user: req.query.data_owner_user,
            data_owner_host: req.query.data_owner_host,
            permission: req.query.permission,
            table_id: req.query.table_id,
            requestor_user: req.query.requestor_user,
            requestor_host: req.query.requestor_host
          }
          if (hasCepsParamIssues(crossHostParams)) {
            return sendFailure(res, 'invalid characters in request parameters', 'CEPSValidator', 400)
          }

          // Parse requestor_host safely using URL constructor
          let parsedRequestorHost
          try {
            parsedRequestorHost = new URL(req.query.requestor_host)
          } catch (urlErr) {
            return sendFailure(res, 'invalid requestor_host URL', 'CEPSValidator', 400)
          }

          const isLocalhost = parsedRequestorHost.hostname === 'localhost' || parsedRequestorHost.hostname === '127.0.0.1'

          // SSRF protection: block requests to private/internal IPs (except localhost in dev)
          if (!isLocalhost) {
            const isPrivate = await hostResolvesToPrivateIP(parsedRequestorHost.hostname)
            if (isPrivate) {
              console.error('CEPSValidator - SSRF blocked: requestor_host resolves to private IP:', req.query.requestor_host)
              return sendAuthFailure(res, { type: 'Unauthorized', error: 'requestor host resolves to a private IP', statusCode: 403, shouldBeAlertedToFailure: true })
            }
          } else if (parsedRequestorHost.protocol === 'http:') {
            return sendFailure(res, 'cannot allow unsecure sites except localhost', 'CEPSValidator', 400)
          }

          const httpOrHttps = parsedRequestorHost.protocol === 'http:' ? http : https

          // Build query string with proper URI encoding
          const queryParams = new URLSearchParams()
          queryParams.set('validation_token', req.query.validation_token)
          queryParams.set('data_owner_user', req.query.data_owner_user)
          if (req.query.data_owner_host) queryParams.set('data_owner_host', req.query.data_owner_host)
          queryParams.set('permission', req.query.permission)
          queryParams.set('table_id', req.query.table_id)
          queryParams.set('requestor_user', req.query.requestor_user)
          if (req.query.requestor_host) queryParams.set('requestor_host', req.query.requestor_host)

          const options = {
            hostname: parsedRequestorHost.hostname,
            path: '/ceps/perms/validationtoken/verify?' + queryParams.toString(),
            method: 'GET',
            headers: {
              'Content-Type': 'application/json'
            }
          }
          if (parsedRequestorHost.port) options.port = parsedRequestorHost.port

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
        // Delete the validation token after successful verification (single-use nonce)
        try {
          await freezr.validationTokenDB.delete_records({ validation_token: req.query.validation_token }, {})
        } catch (err) {
          console.warn('⚠️ Could not delete used validation token:', err)
          // Non-fatal: token will expire in 5 minutes anyway
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

  // Cross-user file authorisation. Returns true iff the file record identified by `filePath`
  // in the data owner's <app>.files collection carries an _accessibles grant for this requestor,
  // matching the grantee (user, app) pair: (grantee, grantee_app ?? requestor_app) against the
  // token's (requestor_id, consuming app). Mirrors the record-level check in readRecordById.
  // Fails closed on any error / missing record / missing collection.
  const requestorHasAccessibleFileGrant = async (res, filePath, tokenInfo, appName) => {
    try {
      const appTableDb = res.locals.freezr?.appTableDb // the data owner's <app>.files collection
      if (!appTableDb) return false
      const fileRecord = await appTableDb.read_by_id(filePath)
      if (!fileRecord || !Array.isArray(fileRecord._accessibles)) return false
      const requestee = tokenInfo.requestor_id
      // Consuming app: the app that minted the fileToken (stored at mint time), falling back to
      // the path app for tokens minted before requestor_app was stored — the legacy pinning.
      const consumingApp = tokenInfo.requestor_app || appName
      return fileRecord._accessibles.some(obj =>
        obj && obj.granted === true &&
        obj.grantee === requestee &&
        (obj.grantee_app || obj.requestor_app) === consumingApp
      )
    } catch (e) {
      return false
    }
  }

  /**
   * GET /feps/userfiles/:app_name/:user_id/*
   * Serve a user file, authenticated via path-scoped app_token cookie.
   * Cookie middleware has already validated the token and set res.locals.freezr.tokenInfo.
   */
  const sendUserFile = async (req, res) => {
    try {
      const parts = req.path.split('/').slice(4)
      const filePath = decodeURI(parts.join('/'))
      const userId = req.params.user_id
      const appName = req.params.app_name

      // Reject path traversal early (defence-in-depth; the FS layer also confines the path).
      // A leading slash, a null byte, or any '..' segment is never a legitimate app-relative path.
      if (!filePath || filePath.indexOf('\0') >= 0 || filePath.charAt(0) === '/' ||
          filePath.split('/').some(seg => seg === '..')) {
        return sendAuthFailure(res, { type: 'Unauthorized', error: 'invalid file path', function: 'sendUserFile', statusCode: 400 })
      }

      const tokenInfo = res.locals.freezr?.tokenInfo
      if (!tokenInfo || tokenInfo.app_name !== appName) {
        return sendAuthFailure(res, { type: 'Unauthorized', error: 'invalid authentication', function: 'sendUserFile', statusCode: 401 })
      }

      // The credential (a scoped ?fileToken= or a Bearer app_token) was ALREADY validated upstream by
      // the getFileTokenInfo middleware — a request with neither is 401'd there, never reaching here —
      // and just above we required tokenInfo.app_name === the requested app. This is the second,
      // record-level identity check that ties that validated token to THIS file:
      //  (a) OWNER: the token's user is the path user → its own app's files.
      //  (b) GRANTEE: a cross-user token (requestor_id = grantee, owner_id = data owner = path user)
      //      may read ONLY a file explicitly shared with the requestor, verified via the record's
      //      _accessibles entry. Reached by an exact-file grantee fileToken (see getUserFileToken, §5).
      // (Essential for the Bearer path: getFileTokenInfo pins a Bearer token to the SESSION user, not
      //  the PATH user, so this owner check is what stops app X's token reading /userfiles/X/other/…)
      const isOwner = tokenInfo.requestor_id === userId
      let permitted = isOwner
      if (!permitted && tokenInfo.owner_id === userId && tokenInfo.requestor_id) {
        permitted = await requestorHasAccessibleFileGrant(res, filePath, tokenInfo, appName)
      }
      if (!permitted) {
        return sendAuthFailure(res, { type: 'Unauthorized', error: 'invalid authentication', function: 'sendUserFile', statusCode: 401 })
      }

      res.locals.freezr.permGiven = true
      const appFS = res.locals.freezr.appFS
      appFS.sendUserFile(filePath, res)
    } catch (err) {
      return sendFailure(res, 'Error in sendUserFile', 'sendUserFile', 500)
    }
  }

  /**
   * GET /feps/getuserfiletoken/:permission_name/:app_name/:user_id   (optional ?file=<path>)
   * Mint a short-lived, scoped fileToken (held in memory) so native <img>/<video>/CSS loads can
   * authenticate private userfiles WITHOUT the ambient cookie (which leaks cross-site/cross-app). See
   * freezr_file_access_plan_v1.md §4b. Authenticated as the requesting app's own app_token (Bearer).
   *
   *  - SELF (own app + own user): the reader already owns the files, so an (app,user)-scoped token
   *    (no file_path) covers every private image on the page in one mint.
   *  - GRANTEE (another user's file, same app): must present the exact `?file=` and hold an
   *    _accessibles grant on that specific .files record (checked against res.locals.freezr.appTableDb,
   *    the owner's <app>.files collection); the token is scoped to that one file.
   */
  const FILE_TOKEN_TTL_MS = 10 * 60 * 1000 // 10 minutes — long enough to load a page, short enough to bound leakage
  const getUserFileToken = async (req, res) => {
    const FUNC = 'getUserFileToken'
    try {
      const tokenInfo = res.locals.freezr?.tokenInfo
      if (!tokenInfo) {
        return sendAuthFailure(res, { type: 'Unauthorized', error: 'invalid authentication', function: FUNC, statusCode: 401 })
      }
      const permissionName = req.params.permission_name || 'self'
      const appName = req.params.app_name // whose files
      const userId = req.params.user_id // data owner (files owner)
      if (!appName || !userId) return sendFailure(res, 'app_name and user_id required', FUNC, 400)

      // Optional exact-file scope (required for grantee tokens); reject traversal in it.
      let filePath = (req.query && req.query.file) ? decodeURIComponent(req.query.file) : null
      if (filePath) {
        if (filePath.charAt(0) === '/') filePath = filePath.slice(1)
        if (filePath.indexOf('\0') >= 0 || filePath.split('/').some(seg => seg === '..')) {
          return sendFailure(res, 'invalid file path', FUNC, 400)
        }
      }

      const requestorApp = tokenInfo.app_name
      const requestorUser = tokenInfo.requestor_id

      const isSelf = (requestorApp === appName && requestorUser === userId)
      if (!isSelf) {
        // GRANTEE: requires an _accessibles grant on the exact file. Two forms, matched below as
        // (grantee, grantee_app ?? requestor_app) === the token's server-verified (user, app):
        //  - cross-user, same app: a user-scoped grant (no grantee_app; consuming app = granting app)
        //  - same-user, cross-app: an app-scoped grant whose grantee_app names THIS consuming app
        // (replaces the old blanket cross-app 403)
        if (!filePath) {
          return sendFailure(res, 'a specific ?file= is required for a shared-file token', FUNC, 400)
        }
        // res.locals.freezr.appTableDb is the OWNER's <app>.files collection (opened by the route's
        // addOwnerAppTableAndFsIfNeedBe with data_owner_id = user_id).
        const appTableDb = res.locals.freezr?.appTableDb
        let granted = false
        try {
          if (appTableDb) {
            const rec = await appTableDb.read_by_id(filePath)
            if (rec && Array.isArray(rec._accessibles)) {
              granted = rec._accessibles.some(obj =>
                obj && obj.granted === true &&
                obj.grantee === requestorUser &&
                (obj.grantee_app || obj.requestor_app) === requestorApp &&
                (!permissionName || permissionName === 'self' || obj.permission_name === permissionName)
              )
            }
          }
        } catch (e) { granted = false }
        if (!granted) {
          return sendAuthFailure(res, { type: 'Unauthorized', error: 'no grant for this file', function: FUNC, statusCode: 403 })
        }
      }

      // Authorisation passed (self, or a verified grantee grant) — mark it for the response guard.
      res.locals.freezr.permGiven = true

      const fileToken = crypto.randomBytes(32).toString('hex')
      const expiry = new Date().getTime() + FILE_TOKEN_TTL_MS
      fileTokenStore.set(fileToken, {
        app_name: appName, // whose files
        user_id: userId, // data owner
        requestor_id: requestorUser, // the reader
        requestor_app: requestorApp, // the CONSUMING app (== appName except for app-scoped grants)
        owner_id: userId, // the files' owner (== requestor for self)
        file_path: isSelf ? (filePath || null) : filePath, // self: optional (app,user)-scope; grantee: exact file
        permission_name: permissionName,
        expiry
      })
      return sendApiSuccess(res, { fileToken, expiry })
    } catch (err) {
      return sendFailure(res, 'Error in getUserFileToken', FUNC, 500)
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

  const upsertPricingRecord = async (pricingDb, provider, modelsToMerge, sourceModel, { replaceAll = false, source = 'llm_self_report' } = {}) => {
    const now = new Date().toISOString()
    const canonicalModels = canonicalizeModelMap(provider, modelsToMerge)
    const safeModels = sanitizeModelKeys(canonicalModels)
    const existing = await pricingDb.query({ provider }, { count: 1 })

    if (existing && existing.length > 0) {
      const existingModels = sanitizeModelKeys(canonicalizeModelMap(provider, unsanitizeModelKeys(existing[0].models || {})))
      const mergedModels = replaceAll ? safeModels : { ...existingModels, ...safeModels }
      await pricingDb.update(existing[0]._id.toString(), {
        provider,
        models: mergedModels,
        lastUpdated: now,
        source,
        sourceModel
      })
      return unsanitizeModelKeys(mergedModels)
    } else {
      await pricingDb.create(null, {
        provider,
        models: safeModels,
        lastUpdated: now,
        source,
        sourceModel
      })
      return unsanitizeModelKeys(safeModels)
    }
  }

  const LLM_PRICING_STALE_MS = 7 * 24 * 60 * 60 * 1000

  // The one place a provider name maps to a connector module. Unknown names still fall
  // through to Anthropic (long-standing behavior existing records may rely on).
  const CONNECTOR_PATHS = {
    Claude: '../../../adapters/llmConnectors/anthropic.mjs',
    ChatGPT: '../../../adapters/llmConnectors/openai.mjs',
    ClaudeLocal: '../../../adapters/llmConnectors/claudeLocal.mjs',
    CodexLocal: '../../../adapters/llmConnectors/codexLocal.mjs'
  }
  const getConnectorPath = (provider) => CONNECTOR_PATHS[provider] || CONNECTOR_PATHS.Claude

  // A local-CLI resource has no `key` — its credential is the CLI login on this machine.
  // Everywhere "has a key" used to mean "usable", localCli now counts too.
  const isUsableLlmResource = (r) => !!(r && (r.key || r.localCli))

  const _tryParseJson = (text) => {
    if (!text) return text
    try { return JSON.parse(text) } catch (e) { /* continue */ }
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
    if (fenceMatch) {
      try { return JSON.parse(fenceMatch[1].trim()) } catch (e) { /* continue */ }
    }
    const braceStart = text.indexOf('{')
    const bracketStart = text.indexOf('[')
    const start = (braceStart >= 0 && (bracketStart < 0 || braceStart < bracketStart)) ? braceStart : bracketStart
    if (start >= 0) {
      const closer = text[start] === '{' ? '}' : ']'
      const end = text.lastIndexOf(closer)
      if (end > start) {
        try { return JSON.parse(text.slice(start, end + 1)) } catch (e) { /* continue */ }
      }
    }
    return text
  }

  /**
   * Add one LLM call to the caller's daily cost tally (info.freezr.account.usageTallies).
   *
   * Never throws and never blocks the answer: the response bytes are already on the wire
   * when this runs, and a metering failure (a closed db, or storageLimitExceeded when the
   * user is over quota) must not turn a successful LLM call into an error.
   *
   * The row is keyed by the API KEY actually spent, plus the upstream vendor the connector
   * reports — so an aggregator key (OpenRouter) splits into one row per real vendor while a
   * direct key just has vendor === provider.
   */
  const meterLlmUsage = async (res, { resource, connector, model, kind, tokensUsed = null, cost = null, outcome = 'ok' }) => {
    try {
      const tallyDb = res.locals?.freezr?.usageTallyDb
      if (!tallyDb || !resource) return
      const tokenInfo = res.locals?.freezr?.tokenInfo || {}
      await recordUsage(tallyDb, {
        ownerId: tokenInfo.requestor_id,
        appName: tokenInfo.app_name,
        resource: 'llm',
        resourceId: resource._id,
        resourceName: resource.name || null,
        provider: resource.provider || null,
        vendor: (typeof connector?.getVendorForModel === 'function' && connector.getVendorForModel(model)) || resource.provider || null,
        model: model || null,
        kind,
        tokensUsed,
        cost,
        outcome
      })
    } catch (e) {
      console.warn('Could not record LLM usage tally:', e.message)
    }
  }

  /**
   * Capability maps for every provider the user actually holds a key for. Built from each
   * connector's own getCapabilities so the answer is the connector's, not a table here —
   * and scoped to the user's own keys so an error never advertises a provider they cannot use.
   */
  const collectProviderCapabilities = async (llmResources, model) => {
    const out = {}
    for (const resource of (llmResources || []).filter(isUsableLlmResource)) {
      try {
        const connector = await import(getConnectorPath(resource.provider))
        out[resource.provider] = typeof connector.getCapabilities === 'function'
          ? await connector.getCapabilities({ apiKey: resource.key, model })
          : (connector.CAPABILITIES || {})
      } catch (e) {
        console.warn('Could not read capabilities for', resource.provider, ':', e.message)
      }
    }
    return out
  }

  /**
   * Fold the connector's server-tool rates (web search per 1,000, etc.) into a stored price.
   *
   * Server-tool rates are PROVIDER-level constants, but pricing records are per-model and
   * cached for a week — so a record written before those rates existed carries none, and the
   * cost maths then bills searches at ZERO rather than failing loudly. Reading them from the
   * connector at request time makes a stale record harmless. The stored value still wins if
   * one is present, so a future per-model override is not clobbered.
   */
  const withServerToolPrices = (price, connector) => {
    if (!price || typeof connector?.getServerToolPrices !== 'function') return price
    return { ...connector.getServerToolPrices(), ...price }
  }

  const getSelectedResource = (llmResources, provider) => {
    let resource = null
    if (provider) resource = llmResources.find(r => r.provider === provider)
    if (!resource) resource = llmResources.find(r => r.default) || llmResources[0] || null
    return resource
  }

  const getPricingRecord = async (pricingDb, provider) => {
    if (!pricingDb || !provider) return null
    const existing = await pricingDb.query({ provider }, { count: 1 })
    if (!existing || existing.length === 0) return null
    const rec = existing[0]
    return {
      _id: rec._id,
      provider: rec.provider,
      models: unsanitizeModelKeys(rec.models || {}),
      lastUpdated: rec.lastUpdated || null,
      source: rec.source || null,
      sourceModel: rec.sourceModel || null
    }
  }

  const refreshProviderPricing = async ({ resource, pricingDb, connector, targetModel = null }) => {
    const pricingResult = await connector.getPricing({ apiKey: resource.key, targetModel })
    let modelsToMerge = normalizePricingModels(resource.provider, pricingResult?.models || null)
    console.log('📊 modelsToMerge for', resource.provider, ':', JSON.stringify(modelsToMerge))

    if (targetModel && !modelsToMerge) {
      modelsToMerge = { [targetModel]: { lookup_failed: true } }
      console.log('📊 No pricing found for target model', targetModel, '- marking lookup_failed')
    }

    if (!modelsToMerge) return null

    const allModels = await upsertPricingRecord(
      pricingDb,
      resource.provider,
      modelsToMerge,
      pricingResult?.sourceModel || null,
      { replaceAll: !targetModel, source: pricingResult?.source || 'llm_self_report' }
    )
    console.log('📊 Stored pricing for', resource.provider, '- keys:', Object.keys(allModels))
    return { models: allModels, lastUpdated: new Date().toISOString(), sourceModel: pricingResult?.sourceModel || null }
  }

  /**
   * Pricing for a NAMESPACED model family — images, and now audio. Both live in their own
   * `<provider>_image` / `<provider>_audio` record because their price rows have different
   * axes from a text row (an audio token is not a text token and does not cost the same), and
   * mixing them would let findModelPrice return an image rate for a chat call.
   *
   * Written once and shared rather than copied per namespace: this file already learned that
   * lesson on the ask() options, where three hand-maintained copies of one list is how `effort`
   * shipped in all three transports and was documented in none.
   */
  const refreshNamespacedPricing = async ({ resource, pricingDb, connector, namespace, fetcher, targetModel = null }) => {
    if (typeof connector[fetcher] !== 'function') return null
    const pricingResult = await connector[fetcher]({ apiKey: resource.key, targetModel })
    if (!pricingResult?.models) return null
    const namespacedProvider = resource.provider + namespace

    const safeModels = sanitizeModelKeys(pricingResult.models)
    const existing = await pricingDb.query({ provider: namespacedProvider }, { count: 1 })
    const now = new Date().toISOString()
    const record = {
      provider: namespacedProvider,
      lastUpdated: now,
      source: pricingResult.source || 'llm_self_report',
      sourceModel: pricingResult.sourceModel || null
    }

    if (existing && existing.length > 0) {
      // A targeted refresh MERGES (it only looked up one model); a full one replaces.
      const merged = targetModel ? { ...(existing[0].models || {}), ...safeModels } : safeModels
      await pricingDb.update(existing[0]._id.toString(), { ...record, models: merged })
      return { models: unsanitizeModelKeys(merged), lastUpdated: now }
    }
    await pricingDb.create(null, { ...record, models: safeModels })
    return { models: unsanitizeModelKeys(safeModels), lastUpdated: now }
  }

  const getNamespacedPricingRecord = async (pricingDb, provider, namespace) => {
    if (!pricingDb || !provider) return null
    const existing = await pricingDb.query({ provider: provider + namespace }, { count: 1 })
    if (!existing || existing.length === 0) return null
    const rec = existing[0]
    return {
      _id: rec._id,
      provider: rec.provider,
      models: unsanitizeModelKeys(rec.models || {}),
      lastUpdated: rec.lastUpdated || null
    }
  }

  const refreshImagePricing = ({ resource, pricingDb, connector, targetModel = null }) =>
    refreshNamespacedPricing({ resource, pricingDb, connector, namespace: IMAGE_PRICING_SUFFIX, fetcher: 'getImagePricing', targetModel })

  const getImagePricingRecord = (pricingDb, provider) =>
    getNamespacedPricingRecord(pricingDb, provider, IMAGE_PRICING_SUFFIX)

  const refreshAudioPricing = ({ resource, pricingDb, connector, targetModel = null }) =>
    refreshNamespacedPricing({ resource, pricingDb, connector, namespace: AUDIO_PRICING_SUFFIX, fetcher: 'getVoicePricing', targetModel })

  const getAudioPricingRecord = (pricingDb, provider) =>
    getNamespacedPricingRecord(pricingDb, provider, AUDIO_PRICING_SUFFIX)

  const buildImageProviderState = async ({ resource, pricingDb, refresh = false }) => {
    const connector = await import(getConnectorPath(resource.provider))
    if (typeof connector.listImageModels !== 'function') return null

    let imageModels = []
    try {
      imageModels = await connector.listImageModels({ apiKey: resource.key })
    } catch (e) {
      console.warn('Could not list image models for', resource.provider, ':', e.message)
      return null
    }
    if (imageModels.length === 0) return null

    let pricingRecord = await getImagePricingRecord(pricingDb, resource.provider)

    if (refresh) {
      try {
        await refreshImagePricing({ resource, pricingDb, connector })
        pricingRecord = await getImagePricingRecord(pricingDb, resource.provider)
      } catch (e) {
        console.warn('Image pricing refresh failed for', resource.provider, ':', e.message)
      }
    }

    const pricingModels = pricingRecord?.models || {}
    const lastUpdated = pricingRecord?.lastUpdated || null
    const refreshNeeded = !lastUpdated || ((Date.now() - new Date(lastUpdated).getTime()) > LLM_PRICING_STALE_MS)

    const models = imageModels.map(m => {
      const price = findImageModelPrice(pricingModels, m.id)
      return {
        id: m.id,
        provider: m.provider || resource.provider,
        created: m.created,
        pricing: price || null
      }
    }).filter(m => m.pricing)

    return {
      models,
      pricingMeta: { lastUpdated, refreshNeeded }
    }
  }

  /**
   * The voice models a provider offers, for the ping snapshot. Same shape as the image one,
   * plus a `kind` ('stt' | 'tts') so an app picking a model does not have to read its name.
   *
   * Unlike images, a voice model is listed even with NO price row: a missing rate must not
   * hide the capability, because the gate has already told the app it can transcribe. The
   * pricing gap shows up as pricing:null, which is visible, rather than as an absent model.
   */
  const buildVoiceProviderState = async ({ resource, pricingDb, refresh = false }) => {
    const connector = await import(getConnectorPath(resource.provider))
    if (typeof connector.listVoiceModels !== 'function') return null

    let voiceModels = []
    try {
      voiceModels = await connector.listVoiceModels({ apiKey: resource.key })
    } catch (e) {
      console.warn('Could not list voice models for', resource.provider, ':', e.message)
      return null
    }
    if (voiceModels.length === 0) return null

    let pricingRecord = await getAudioPricingRecord(pricingDb, resource.provider)
    if (refresh) {
      try {
        await refreshAudioPricing({ resource, pricingDb, connector })
        pricingRecord = await getAudioPricingRecord(pricingDb, resource.provider)
      } catch (e) {
        console.warn('Voice pricing refresh failed for', resource.provider, ':', e.message)
      }
    }

    const pricingModels = pricingRecord?.models || {}
    const lastUpdated = pricingRecord?.lastUpdated || null
    const refreshNeeded = !lastUpdated || ((Date.now() - new Date(lastUpdated).getTime()) > LLM_PRICING_STALE_MS)

    const models = voiceModels.map(m => ({
      id: m.id,
      provider: m.provider || resource.provider,
      created: m.created,
      kind: m.kind || null,
      pricing: findAudioModelPrice(pricingModels, m.id) || null
    }))

    return {
      models,
      pricingMeta: { lastUpdated, refreshNeeded }
    }
  }

  const buildProviderState = async ({ resource, pricingDb, refresh = false }) => {
    const connector = await import(getConnectorPath(resource.provider))
    const modelInfos = await connector.listModels({ apiKey: resource.key })
    let pricingRecord = await getPricingRecord(pricingDb, resource.provider)

    if (refresh) {
      try {
        await refreshProviderPricing({ resource, pricingDb, connector })
      } catch (e) {
        console.warn('Pricing refresh failed for ' + resource.provider + ':', e.message)
      }
      pricingRecord = await getPricingRecord(pricingDb, resource.provider)
    }

    const pricingModels = pricingRecord?.models || {}
    const lastUpdated = pricingRecord?.lastUpdated || null
    // A purely self-reported table is refresh-eligible REGARDLESS of age: models mis-state their
    // own prices (observed: every current Opus model claiming the old $15/$75 rate, tripling every
    // cost figure shown), and the connector now answers from an official table first — but only a
    // refresh replaces what is already stored. Age alone would leave wrong values in place for days.
    const selfReportedOnly = pricingRecord?.source === 'llm_self_report'
    const refreshNeeded = !lastUpdated || selfReportedOnly ||
      ((Date.now() - new Date(lastUpdated).getTime()) > LLM_PRICING_STALE_MS)

    const models = modelInfos.map(m => {
      const price = findModelPrice(resource.provider, pricingModels, m.id, m.family)
      let pricing = null
      if (price) {
        pricing = { input: price.input, output: price.output }
        const other = {}
        for (const [k, v] of Object.entries(price)) {
          if (k !== 'input' && k !== 'output' && k !== 'key') other[k] = v
        }
        if (Object.keys(other).length > 0) pricing.other = other
      }
      return {
        id: m.id,
        family: m.family || getModelFamily(resource.provider, m.id),
        provider: m.provider || resource.provider,
        version: m.version || '',
        latest: m.latest || false,
        // The provider's own per-model answer, condensed to freezr's vocabulary. Absent when
        // the provider publishes nothing about that model — which means "unknown, try it",
        // never "unsupported".
        ...(m.capabilities ? { capabilities: m.capabilities } : {}),
        pricing
      }
    })
    // NOT filtered by `pricing`. It used to be, and the effect was that a model the provider
    // had released but the pricing table did not yet cover was INVISIBLE in every app's model
    // picker — observed 2026-09-06 with a key whose newest models (gpt-6, gpt-5.6, gpt-5.5-pro)
    // simply did not appear, so the list looked like it stopped at 5.4.
    // A missing price is not a reason to hide a working model:
    //   - llmAsk already does a targeted pricing refresh the first time it meets an unpriced
    //     model, so the gap closes itself on first use;
    //   - the usage tallies already count `unpriced_requests`, i.e. an unpriced call is a state
    //     this system was built to expect, not an error;
    //   - `pricing: null` travels to the app, so a picker that wants to say "cost unknown" can.
    // Hiding it, by contrast, could never fix itself: the model stayed unpriced precisely
    // because nothing was ever able to select it.

    return {
      models,
      pricingMeta: { lastUpdated, refreshNeeded }
    }
  }

  const llmAsk = async (req, res) => {
    try {
      res.locals.freezr.permGiven = true

      const options = req.body?.options || {}
      const prompt = req.body?.prompt
      const context = req.body?.context
      const provider = options.provider || req.body?.provider
      const family = options.family || req.body?.family
      const model = options.model || req.body?.model
      const max_tokens = options.max_tokens || req.body?.max_tokens
      const role = options.role || req.body?.role
      const responseType = options.responseType || req.body?.responseType
      // `false` is a real value here — "do not think" — and recent models think by default, so
      // collapsing false to null silently re-enables the most expensive behaviour on the wire.
      const effort = options.effort || req.body?.effort || null
      const thinking = options.thinking !== undefined
        ? options.thinking
        : (req.body?.thinking !== undefined ? req.body.thinking : null)
      const cache = options.cache || req.body?.cache || null
      // Web access. Normalized here so the gate, the connector and the meta all read the
      // same shape (true -> { search: true, fetch: true }).
      const web = normalizeWebOption(options.web !== undefined ? options.web : req.body?.web)
      // Per-request wait, bounded by the caller's ask and by the calling job's remaining
      // budget. Connectors clamp it to their own ceiling/floor — see resolveAskTimeoutMs.
      const timeoutMs = resolveAskTimeoutMs(req, options)
      const noCosts = options.noCosts === true || req.body?.noCosts === true
      const refresh = options.refresh === true || req.body?.refresh === true
      const llmResources = res.locals.freezr?.llmResources || []
      const files = req.files || null
      const pricingDb = res.locals.freezr?.llmPricingDb

      const resource = getSelectedResource(llmResources, provider)

      if (req.body?.ping) {
        const activeResources = llmResources.filter(isUsableLlmResource)
        const selectedProvider = provider || resource?.provider || activeResources[0]?.provider || null
        const providers = {}
        const imageProviders = {}
        const voiceProviders = {}
        const pricingMeta = {}
        for (const active of activeResources) {
          const state = await buildProviderState({
            resource: active,
            pricingDb,
            refresh: refresh && (!provider || provider === active.provider)
          })
          providers[active.provider] = state.models
          pricingMeta[active.provider] = state.pricingMeta

          try {
            const imageState = await buildImageProviderState({
              resource: active,
              pricingDb,
              refresh: refresh && (!provider || provider === active.provider)
            })
            if (imageState) {
              imageProviders[active.provider] = imageState.models
              pricingMeta[active.provider + IMAGE_PRICING_SUFFIX] = imageState.pricingMeta
            }
          } catch (e) {
            console.warn('Image model state failed for', active.provider, ':', e.message)
          }

          try {
            const voiceState = await buildVoiceProviderState({
              resource: active,
              pricingDb,
              refresh: refresh && (!provider || provider === active.provider)
            })
            if (voiceState) {
              voiceProviders[active.provider] = voiceState.models
              pricingMeta[active.provider + AUDIO_PRICING_SUFFIX] = voiceState.pricingMeta
            }
          } catch (e) {
            console.warn('Voice model state failed for', active.provider, ':', e.message)
          }
        }
        let defaultFamily = null
        if (selectedProvider) {
          try {
            const defaultConnector = await import(getConnectorPath(selectedProvider))
            defaultFamily = defaultConnector.DEFAULT_FAMILY || null
          } catch (e) { /* ignore */ }
        }

        // Capability snapshot, so an app can show a "search the web" toggle only where it
        // will work instead of discovering it by failing. Values are true / false /
        // 'unknown' — 'unknown' means "try it and handle the error", not "no".
        const capabilities = await collectProviderCapabilities(activeResources, null)

        const pingResponse = {
          success: true,
          exists: activeResources.length > 0,
          defaultProvider: selectedProvider,
          defaultFamily,
          providers,
          capabilities,
          pricingMeta
        }
        if (Object.keys(imageProviders).length > 0) {
          pingResponse.imageProviders = imageProviders
        }
        if (Object.keys(voiceProviders).length > 0) {
          pingResponse.voiceProviders = voiceProviders
        }

        // What this app has spent of the user's LLM budget today and this month, so an app
        // can show a running total without keeping its own books. Non-fatal: a ping must
        // still answer if the meter is unreadable.
        try {
          const tallyDb = res.locals.freezr?.usageTallyDb
          const appName = res.locals.freezr?.tokenInfo?.app_name
          if (tallyDb && appName) {
            const today = utcDay(Date.now())
            const rows = await queryTallies(tallyDb, { resource: 'llm', from: today.slice(0, 8) + '01', to: today, appName })
            pingResponse.usage = {
              today: summarizeTallies(rows.filter(r => r.date === today)).total,
              month: summarizeTallies(rows).total,
              currency: 'USD'
            }
          }
        } catch (e) {
          console.warn('Could not read LLM usage tallies for ping:', e.message)
        }

        return sendApiSuccess(res, pingResponse)
      }

      if (!isUsableLlmResource(resource)) {
        return res.status(400).json({
          success: false,
          error: 'No LLM key found. Add one in Account Resources.',
          meta: { provider: provider || null, hasKey: false }
        })
      }

      if (!prompt) {
        return res.status(400).json({ success: false, error: 'No prompt provided' })
      }

      const connector = await import(getConnectorPath(resource.provider))
      const resolvedModel = model || family || connector.DEFAULT_FAMILY || null

      // Capability gate. Runs BEFORE any provider call, so a request for something this
      // provider genuinely cannot do costs the user nothing. Note that an UNKNOWN capability
      // passes through on purpose — the connectors settle those by trying (see the three-tier
      // note in common/helpers/llmCapabilities.mjs), which is what keeps freezr out of the
      // business of maintaining a per-model feature table.
      let webUnavailable = []
      if (web) {
        const required = []
        if (web.search) required.push('web.search')
        if (web.fetch) required.push('web.fetch')
        const providerCapabilities = await collectProviderCapabilities(llmResources, resolvedModel)
        const gate = checkCapabilities({
          required,
          optional: web.optional,
          providerCapabilities,
          provider: resource.provider,
          model: resolvedModel
        })
        if (!gate.ok) return res.status(400).json(gate.error)
        webUnavailable = gate.unavailable
      }


      // Always use SSE streaming when available to keep the connection alive
      // (Heroku and similar hosts impose a 30s first-byte timeout on HTTP responses).
      // The client reads the SSE stream internally and only surfaces chunks
      // to the app developer when streamBack is explicitly requested.
      if (typeof connector.askStream === 'function') {
        res.locals.freezr.permGiven = true
        res.locals.flogger.track('api', { app_name: res.locals?.freezr?.tokenInfo?.app_name })
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no') // nginx: never buffer this response
        res.flushHeaders()

        // Some front-end proxies (Azure App Service / ARR, some CDNs) hold response bytes in a
        // ~4KB buffer before forwarding them. A 6-byte heartbeat comment can sit in that buffer
        // forever, so the platform's IDLE timer (230s on App Service, 4 min on Azure LB) never
        // resets and the connection is killed mid-request even though we "wrote" regularly.
        // Padding each heartbeat past the buffer threshold forces the bytes onto the wire; the
        // client's SSE parser skips comment lines, so the only cost is ~4KB per quiet 15s window.
        const SSE_PAD = ': ' + '.'.repeat(4096) + '\n\n'
        res.write(SSE_PAD) // commit the front-end to streaming mode before the first quiet window

        let lastWriteAt = Date.now()
        const writeSSE = (data) => {
          lastWriteAt = Date.now()
          res.write('data: ' + JSON.stringify(data) + '\n\n')
        }

        // Every intermediary between us and the browser (Heroku 55s, nginx proxy_read_timeout
        // 60s, Cloudflare 100s) drops an SSE connection that goes quiet, and once headers are
        // flushed the client just sees a clean EOF — which surfaces as the useless
        // "Stream ended without a done event". There are two long silent windows here: before
        // the first token (model resolution + prompt prefill on a big document, and OpenAI
        // o-series reasoning, which emits no deltas at all) and after the last one (the pricing
        // lookup/refresh below). A comment line keeps bytes moving through both; the client's
        // parser only reads `data: ` lines so it ignores these.
        const HEARTBEAT_MS = 15000
        const heartbeat = setInterval(() => {
          if (res.writableEnded) return
          if (Date.now() - lastWriteAt < HEARTBEAT_MS) return
          lastWriteAt = Date.now()
          res.write(SSE_PAD)
        }, HEARTBEAT_MS / 3)
        if (heartbeat.unref) heartbeat.unref()

        // If the browser goes away mid-answer, stop paying the provider for the rest of it.
        //
        // TWO mechanisms, because neither alone is enough:
        //   - abortController: the authoritative one. A connector that spawns a subprocess
        //     (the local CLI connectors) listens on the signal and kills its child at once.
        //   - gen.return(): ends the generator so the loop below unwinds. On its own this
        //     CANNOT stop a quiet connector: an async generator's return() is QUEUED and only
        //     takes effect when the generator next suspends AT A YIELD, so a CLI that has gone
        //     silent mid-answer would keep running — and keep that connector's single slot,
        //     failing every later call with 429 — until its own timeout. Hence the signal.
        // Both are safe on normal completion: Node also emits 'close' when the response
        // finishes, by which point the generator is done (return() is a no-op) and the
        // connector has already removed its abort listener.
        let clientGone = false
        let gen = null
        const abortController = new AbortController()
        const onClientClose = () => {
          clientGone = true
          abortController.abort()
          try { gen?.return?.() } catch (e) { /* generator already finished */ }
        }
        res.on('close', onClientClose)

        try {
          gen = connector.askStream({
            apiKey: resource.key,
            prompt,
            context,
            model: resolvedModel,
            max_tokens: max_tokens || null,
            role: role || null,
            thinking: thinking === false ? false : (thinking || null),
            effort: effort || undefined,
            cache: cache || null,
            web: web || null,
            files: (files && files.length > 0) ? files : null,
            // local-CLI connector config ({ binaryPath }) from the resource record;
            // key-based connectors ignore it
            local: resource.local || null,
            // per-request wait + client-disconnect abort; key-based connectors don't
            // destructure either and ignore them
            timeoutMs,
            signal: abortController.signal
          })

          let doneResult = null
          for await (const chunk of gen) {
            if (clientGone) { await gen.return?.(); break }
            if (chunk.type === 'done') {
              doneResult = chunk
            } else {
              // delta / thinking / tool — relayed verbatim. Clients that predate a chunk
              // type ignore it (see the SSE reader in freezrApiV2.llm.js), so adding one
              // is backwards compatible.
              writeSSE(chunk)
            }
          }

          if (doneResult) {
            let finalResponse = doneResult.response
            if (responseType === 'json' && typeof finalResponse === 'string') {
              finalResponse = _tryParseJson(finalResponse)
            }

            let pricingRecord = pricingDb ? await getPricingRecord(pricingDb, resource.provider) : null
            let price = null
            // Priced even when the app asked for noCosts: the meter needs the dollars even
            // though the response below omits them. Accounting is not app-optional.
            if (pricingDb) {
              price = findModelPrice(resource.provider, pricingRecord?.models || {}, doneResult.model, doneResult.family)
              if (!price && !isLookupFailedForModel(resource.provider, pricingRecord?.models || {}, doneResult.model)) {
                try {
                  await refreshProviderPricing({ resource, pricingDb, connector, targetModel: doneResult.model })
                  pricingRecord = await getPricingRecord(pricingDb, resource.provider)
                  price = findModelPrice(resource.provider, pricingRecord?.models || {}, doneResult.model, doneResult.family)
                } catch (e) {
                  console.warn('Could not refresh targeted pricing for', doneResult.model, ':', e.message)
                }
              }
            }
            const pricedTokens = applyPriceToTokensUsed(doneResult.tokensUsed, withServerToolPrices(price, connector))
            writeSSE({
              type: 'done',
              success: true,
              response: finalResponse,
              thinking: doneResult.thinking || null,
              meta: {
                provider: doneResult.provider,
                model: doneResult.model,
                modelFamily: doneResult.family,
                // stopReason 'max_tokens' means the answer was CUT OFF at maxTokens —
                // the app should treat the response as partial (and unparseable, if it
                // asked for JSON) rather than guessing from token counts.
                stopReason: doneResult.stopReason || null,
                maxTokens: doneResult.maxTokens || null,
                rawUsage: doneResult.rawUsage,
                tokensUsed: noCosts ? makeEmptyTokensUsed(doneResult.tokensUsed) : pricedTokens.tokensUsed,
                cost: noCosts ? null : pricedTokens.cost,
                pricing: noCosts ? null : (price || null),
                // What the web tools actually did: sources to show the user, fetched URLs as
                // the audit trail for what left the conversation.
                ...(doneResult.toolsUsed ? { toolsUsed: doneResult.toolsUsed } : {}),
                ...(doneResult.citations ? { citations: doneResult.citations } : {}),
                // Names anything the caller asked for and did NOT get (only possible when
                // they passed optional) — otherwise a stale answer passes for a fresh one.
                capabilities: { unavailable: [...webUnavailable, ...(doneResult.unavailable || [])] },
                hasKey: true
              }
            })
            await meterLlmUsage(res, {
              resource,
              connector,
              model: doneResult.model,
              kind: 'ask',
              tokensUsed: pricedTokens.tokensUsed,
              cost: pricedTokens.cost
            })
          } else if (!clientGone) {
            // The generator finished without a done chunk. Never end the response silently —
            // a bodiless EOF is indistinguishable from a dropped connection at the client.
            console.error('❌ llmAsk (streaming): connector ended without a done chunk', resource.provider, resolvedModel)
            writeSSE({ type: 'error', error: 'LLM stream ended without a result', code: 'no_done' })
            await meterLlmUsage(res, { resource, connector, model: resolvedModel, kind: 'ask', outcome: 'error' })
          } else {
            // Client left mid-answer. The provider has already billed the prefill, so the
            // request is counted even though the `done` chunk (and its usage) never arrived.
            await meterLlmUsage(res, { resource, connector, model: resolvedModel, kind: 'ask', outcome: 'aborted' })
          }

          return res.end()
        } catch (streamError) {
          console.error('❌ Error in llmAsk (streaming):', streamError)
          // SSE headers are already flushed by this point, so a capability rejection raised by
          // the connector (tier 3: the model turned out not to support what was asked) cannot
          // become a 400 — it has to travel as an error EVENT. Carry its structure, or the app
          // is left regexing a message string. The SSE reader copies `code` onto the thrown error.
          writeSSE({
            type: 'error',
            error: streamError.message || 'LLM streaming failed',
            ...(streamError.code ? { code: streamError.code } : {}),
            ...(streamError.capability ? { capability: streamError.capability } : {}),
            ...(streamError.model ? { model: streamError.model } : {})
          })
          await meterLlmUsage(res, { resource, connector, model: resolvedModel, kind: 'ask', outcome: 'error' })
          return res.end()
        } finally {
          clearInterval(heartbeat)
          res.removeListener('close', onClientClose)
        }
      }

      // Fallback for connectors without askStream
      const result = await connector.ask({
        apiKey: resource.key,
        prompt,
        context,
        model: resolvedModel,
        max_tokens: max_tokens || null,
        role: role || null,
        responseType: responseType || null,
        thinking: thinking === false ? false : (thinking || null),
        effort: effort || undefined,
        cache: cache || null,
        web: web || null,
        files: (files && files.length > 0) ? files : null,
        local: resource.local || null,
        timeoutMs
      })

      let pricingRecord = pricingDb ? await getPricingRecord(pricingDb, resource.provider) : null
      let price = null
      // Priced even under noCosts — see the streaming path above.
      if (pricingDb) {
        price = findModelPrice(resource.provider, pricingRecord?.models || {}, result.model, result.family)
        if (!price && !isLookupFailedForModel(resource.provider, pricingRecord?.models || {}, result.model)) {
          try {
            await refreshProviderPricing({ resource, pricingDb, connector, targetModel: result.model })
            pricingRecord = await getPricingRecord(pricingDb, resource.provider)
            price = findModelPrice(resource.provider, pricingRecord?.models || {}, result.model, result.family)
          } catch (e) {
            console.warn('Could not refresh targeted pricing for', result.model, ':', e.message)
          }
        }
      }

      const pricedTokens = applyPriceToTokensUsed(result.tokensUsed, withServerToolPrices(price, connector))

      const reply = {
        success: true,
        response: result.response,
        meta: {
          provider: result.provider,
          model: result.model,
          modelFamily: result.family,
          // See the streaming path above: 'max_tokens' means the answer was cut off.
          stopReason: result.stopReason || null,
          maxTokens: result.maxTokens || null,
          rawUsage: result.rawUsage,
          tokensUsed: noCosts ? makeEmptyTokensUsed(result.tokensUsed) : pricedTokens.tokensUsed,
          cost: noCosts ? null : pricedTokens.cost,
          pricing: noCosts ? null : (price || null),
          ...(result.toolsUsed ? { toolsUsed: result.toolsUsed } : {}),
          ...(result.citations ? { citations: result.citations } : {}),
          capabilities: { unavailable: [...webUnavailable, ...(result.unavailable || [])] },
          hasKey: true
        }
      }
      if (result.thinking) reply.thinking = result.thinking
      const sent = sendApiSuccess(res, reply)
      await meterLlmUsage(res, {
        resource,
        connector,
        model: result.model,
        kind: 'ask',
        tokensUsed: pricedTokens.tokensUsed,
        cost: pricedTokens.cost
      })
      return sent
    } catch (error) {
      console.error('❌ Error in llmAsk:', error)
      // A capability rejection raised by the connector (the model turned out not to support
      // what was asked) is a 400 with its structure preserved, not an opaque 500 — the app
      // needs `code`/`capability` to react rather than a message string to regex.
      if (error.code === 'capability_unsupported' || error.code === 'capability_unsupported_on_model') {
        return res.status(400).json({
          success: false,
          error: error.message,
          code: error.code,
          capability: error.capability || null,
          model: error.model || null,
          supportedBy: error.supportedBy || []
        })
      }
      const statusCode = error.status || 500
      const errorResponse = {
        success: false,
        error: error.message || 'LLM request failed',
        errorType: error.error?.error?.type || null,
        errorStatus: statusCode
      }
      return res.status(statusCode).json(errorResponse)
    }
  }

  /**
   * Resolve the provider + connector for a voice call and gate the capability BEFORE calling
   * out, so a request the provider cannot serve costs nothing. Shared by both handlers because
   * the only difference between them is which half of `voice` they need.
   *
   * This is the first gate that can answer "Claude cannot, ChatGPT can" — every capability
   * before voice ran the other way round.
   */
  const resolveVoiceTarget = async ({ res, llmResources, provider, capability }) => {
    let resource = getSelectedResource(llmResources, provider)
    if (!isUsableLlmResource(resource)) {
      return { error: { status: 400, body: { success: false, error: 'No LLM key found. Add one in Account Resources.', meta: { hasKey: false } } } }
    }
    const providerCapabilities = await collectProviderCapabilities(llmResources, null)

    // If the user's DEFAULT provider cannot do this, fall back to one of their own keys that
    // can — voice is currently ChatGPT-only, so a user whose default is Claude would otherwise
    // be unable to use it at all despite holding a working key.
    //
    // Note this is the OPPOSITE of what llmAsk does, deliberately. There, switching provider
    // silently would change the MODEL ANSWERING THE QUESTION, so the gate refuses and names the
    // alternative instead. Here the provider is doing a mechanical transform — the same audio
    // in, the same words out — so picking the one that can is a convenience, not a substitution.
    // Which key was actually spent still comes back in meta.provider, and only providers the
    // user already holds a key for are ever considered.
    if (!isPermitted(resolveCapability(providerCapabilities[resource.provider] || {}, capability))) {
      const capable = (llmResources || []).find(r => r.key &&
        isPermitted(resolveCapability(providerCapabilities[r.provider] || {}, capability)))
      if (capable) {
        console.log('[freezr llm] ' + resource.provider + ' cannot ' + capability + '; using this user\'s ' + capable.provider + ' key instead')
        resource = capable
      }
    }

    const connector = await import(getConnectorPath(resource.provider))
    const gate = checkCapabilities({ required: [capability], providerCapabilities, provider: resource.provider })
    if (!gate.ok) return { error: { status: 400, body: gate.error } }
    return { resource, connector }
  }

  /**
   * Price a voice call against the <provider>_audio namespace, refreshing once if the model is
   * not in the table yet. Mirrors the image path: the meter needs the dollars even when the
   * table is cold, and a missing rate silently bills at zero (the web-search lesson).
   */
  const priceVoiceCall = async ({ resource, connector, pricingDb, result }) => {
    if (!pricingDb || !result.tokensUsed) return applyAudioPriceToTokensUsed(result.tokensUsed, null)
    let record = await getAudioPricingRecord(pricingDb, resource.provider)
    let price = findAudioModelPrice(record?.models || {}, result.model)
    if (!price) {
      try {
        await refreshAudioPricing({ resource, pricingDb, connector, targetModel: result.model })
        record = await getAudioPricingRecord(pricingDb, resource.provider)
        price = findAudioModelPrice(record?.models || {}, result.model)
      } catch (e) {
        console.warn('Could not refresh voice pricing for', result.model, ':', e.message)
      }
    }
    return applyAudioPriceToTokensUsed(result.tokensUsed, price)
  }

  /**
   * PUT /feps/llm/transcribe — speech to text.
   * Takes the audio through the same two transports llmAsk accepts for attachments (multipart
   * upload, or headless `filesBase64` JSON), so a background job can call it too.
   */
  const llmTranscribe = async (req, res) => {
    try {
      res.locals.freezr.permGiven = true

      const options = req.body?.options || {}
      const provider = options.provider || req.body?.provider
      const model = options.model || req.body?.model
      const language = options.language || req.body?.language
      const prompt = options.prompt || req.body?.prompt
      const llmResources = res.locals.freezr?.llmResources || []
      const pricingDb = res.locals.freezr?.llmPricingDb

      // Both transports land in req.files: multer for a browser upload, and the route's
      // uploadLlmIfNeeded for the headless `filesBase64` JSON a job runtime has to use (it has
      // no multipart socket stream). Reusing that is why there is no second decode path here.
      const audio = (req.files && req.files.length > 0) ? req.files[0] : null
      if (!audio) return res.status(400).json({ success: false, error: 'No audio provided' })

      const target = await resolveVoiceTarget({ res, llmResources, provider, capability: 'voice.stt' })
      if (target.error) return res.status(target.error.status).json(target.error.body)
      const { resource, connector } = target

      const result = await connector.transcribe({ apiKey: resource.key, audio, model, language, prompt })
      const pricedTokens = await priceVoiceCall({ resource, connector, pricingDb, result })

      const sent = sendApiSuccess(res, {
        success: true,
        text: result.text,
        meta: { provider: result.provider, model: result.model, hasKey: true },
        tokensUsed: pricedTokens.tokensUsed,
        cost: pricedTokens.cost
      })
      await meterLlmUsage(res, {
        resource, connector, model: result.model, kind: 'transcribe',
        tokensUsed: pricedTokens.tokensUsed, cost: pricedTokens.cost
      })
      return sent
    } catch (error) {
      console.error('Error in llmTranscribe:', error)
      if (error.code === 'capability_unsupported' || error.code === 'capability_unsupported_on_model') {
        return res.status(400).json({ success: false, error: error.message, code: error.code, capability: error.capability || null })
      }
      return res.status(error.status || 500).json({ success: false, error: error.message || 'Transcription failed' })
    }
  }

  /** PUT /feps/llm/speak — text to speech. Returns base64 audio, like generate_image does. */
  const llmSpeak = async (req, res) => {
    try {
      res.locals.freezr.permGiven = true

      const options = req.body?.options || {}
      const text = req.body?.text || req.body?.prompt
      const provider = options.provider || req.body?.provider
      const model = options.model || req.body?.model
      const voice = options.voice || req.body?.voice
      const format = options.format || req.body?.format
      const instructions = options.instructions || req.body?.instructions
      const llmResources = res.locals.freezr?.llmResources || []
      const pricingDb = res.locals.freezr?.llmPricingDb

      if (!text) return res.status(400).json({ success: false, error: 'No text provided' })

      const target = await resolveVoiceTarget({ res, llmResources, provider, capability: 'voice.tts' })
      if (target.error) return res.status(target.error.status).json(target.error.body)
      const { resource, connector } = target

      const result = await connector.speak({ apiKey: resource.key, text, voice, format, model, instructions })
      const pricedTokens = await priceVoiceCall({ resource, connector, pricingDb, result })

      const sent = sendApiSuccess(res, {
        success: true,
        format: result.format,
        b64Data: result.b64Data,
        meta: { provider: result.provider, model: result.model, voice: voice || null, hasKey: true },
        tokensUsed: pricedTokens.tokensUsed,
        cost: pricedTokens.cost
      })
      await meterLlmUsage(res, {
        resource, connector, model: result.model, kind: 'speak',
        tokensUsed: pricedTokens.tokensUsed, cost: pricedTokens.cost
      })
      return sent
    } catch (error) {
      console.error('Error in llmSpeak:', error)
      if (error.code === 'capability_unsupported' || error.code === 'capability_unsupported_on_model') {
        return res.status(400).json({ success: false, error: error.message, code: error.code, capability: error.capability || null })
      }
      return res.status(error.status || 500).json({ success: false, error: error.message || 'Speech generation failed' })
    }
  }

  const llmGenerateImage = async (req, res) => {
    try {
      res.locals.freezr.permGiven = true

      const prompt = req.body?.prompt
      const size = req.body?.size || '1024x1024'
      const quality = req.body?.quality || 'auto'
      const outputFormat = req.body?.outputFormat || 'png'
      const provider = req.body?.provider
      const model = req.body?.model
      const llmResources = res.locals.freezr?.llmResources || []
      const pricingDb = res.locals.freezr?.llmPricingDb

      if (!prompt) {
        return res.status(400).json({ success: false, error: 'No prompt provided' })
      }

      // console.log('llmGenerateImage prompt:', prompt)

      const resource = getSelectedResource(llmResources, provider)

      if (!resource || !resource.key) {
        return res.status(400).json({
          success: false,
          error: 'No LLM key found. Add one in Account Resources.',
          meta: { hasKey: false }
        })
      }

      const connector = await import(getConnectorPath(resource.provider))
      if (typeof connector.generateImage !== 'function') {
        return res.status(400).json({ success: false, error: 'Image generation not supported for provider: ' + resource.provider })
      }

      const result = await connector.generateImage({ apiKey: resource.key, prompt, size, quality, model })

      // console.log('🖼️ Image generated - model:', result.model, 'provider:', result.provider)
      // console.log('🖼️ Raw usage from API:', JSON.stringify(result.rawUsage))
      // console.log('🖼️ Standardized tokensUsed:', JSON.stringify(result.tokensUsed))

      let pricedTokens
      const isRasterProvider = resource.provider === 'ChatGPT'

      if (isRasterProvider && pricingDb && result.tokensUsed) {
        let imgPricingRecord = await getImagePricingRecord(pricingDb, resource.provider)
        let imagePrice = findImageModelPrice(imgPricingRecord?.models || {}, result.model)
        // console.log('🖼️ Existing image price for', result.model, ':', JSON.stringify(imagePrice))
        if (!imagePrice) {
          try {
            await refreshImagePricing({ resource, pricingDb, connector, targetModel: result.model })
            imgPricingRecord = await getImagePricingRecord(pricingDb, resource.provider)
            imagePrice = findImageModelPrice(imgPricingRecord?.models || {}, result.model)
            // console.log('🖼️ After refresh, image price:', JSON.stringify(imagePrice))
          } catch (e) {
            console.warn('Could not refresh image pricing for', result.model, ':', e.message)
          }
        }
        pricedTokens = applyImagePriceToTokensUsed(result.tokensUsed, imagePrice)
        // console.log('🖼️ Final priced tokens:', JSON.stringify(pricedTokens))
      } else if (pricingDb && result.tokensUsed) {
        let pricingRecord = await getPricingRecord(pricingDb, resource.provider)
        let price = findModelPrice(resource.provider, pricingRecord?.models || {}, result.model, result.family)
        if (!price && !isLookupFailedForModel(resource.provider, pricingRecord?.models || {}, result.model)) {
          try {
            await refreshProviderPricing({ resource, pricingDb, connector, targetModel: result.model })
            pricingRecord = await getPricingRecord(pricingDb, resource.provider)
            price = findModelPrice(resource.provider, pricingRecord?.models || {}, result.model, result.family)
          } catch (e) {
            console.warn('Could not refresh targeted pricing for', result.model, ':', e.message)
          }
        }
        pricedTokens = applyPriceToTokensUsed(result.tokensUsed, price)
      } else {
        pricedTokens = applyPriceToTokensUsed(result.tokensUsed, null)
      }

      // Same tally as llmAsk, under kind 'generate_image'. Declared once because the image
      // reply leaves by two different returns below.
      const meterImage = () => meterLlmUsage(res, {
        resource,
        connector,
        model: result.model,
        kind: 'generate_image',
        tokensUsed: pricedTokens.tokensUsed,
        cost: pricedTokens.cost
      })

      if (result.format === 'svg' && outputFormat === 'png') {
        const { convert } = await import('../../../common/helpers/pictures.mjs')
        const svgBuffer = Buffer.from(result.svgData, 'utf-8')
        const pngBuffer = await convert(
          { buffer: svgBuffer, originalname: 'image.svg' },
          { width: 1024, type: 'png' }
        )
        const sentPng = sendApiSuccess(res, {
          success: true,
          format: 'png',
          b64Data: pngBuffer.toString('base64'),
          revisedPrompt: result.revisedPrompt || null,
          meta: { provider: result.provider, model: result.model, convertedFrom: 'svg' },
          tokensUsed: pricedTokens.tokensUsed,
          cost: pricedTokens.cost
        })
        await meterImage()
        return sentPng
      }

      const reply = {
        success: true,
        format: result.format,
        revisedPrompt: result.revisedPrompt || null,
        meta: { provider: result.provider, model: result.model },
        tokensUsed: pricedTokens.tokensUsed,
        cost: pricedTokens.cost
      }
      if (result.format === 'svg') {
        reply.svgData = result.svgData
      } else {
        reply.b64Data = result.b64Data
      }
      const sentImage = sendApiSuccess(res, reply)
      await meterImage()
      return sentImage
    } catch (error) {
      console.error('Error in llmGenerateImage:', error)
      return res.status(error.status || 500).json({
        success: false,
        error: error.message || 'Image generation failed'
      })
    }
  }

  const DEFAULT_MAX_USER_FILE_TREE_FILES = 5000
  /** Max subdirectory levels below subPath (keep low for slow cloud FS; 0 = folder names only). */
  const DEFAULT_MAX_USER_FILE_TREE_DEPTH = 5
  /** Hard cap on requested maxDepth (abuse / typo guard; real depth is still limited by disk). */
  const ABSOLUTE_MAX_USER_FILE_TREE_DEPTH = 64

  /**
   * Relative path under user files (no leading slash, no ..). Empty = whole tree root.
   */
  const sanitizeUserFileSubPath = (raw) => {
    if (raw == null || String(raw).trim() === '') return ''
    const s = String(raw).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/g, '')
    if (s === '') return ''
    if (s.includes('..') || s.includes('\0')) return null
    const parts = s.split('/').filter(Boolean)
    for (const p of parts) {
      if (p === '.' || p === '..') return null
      if (!validFilename(p)) return null
    }
    return parts.join('/')
  }

  /**
   * Walk user files via appFS.readUserDir / statUserFile (local + cloud backends).
   * Paths in nodes are relative to listRootEndpath (the requested subPath, or '').
   * @param depth Nesting depth below list root (0 = subPath itself). Stops recursing at maxDepth.
   */
  const buildUserFileTreeFromAppFS = async (appFS, dirEndpath, listRootEndpath, options, depth = 0) => {
    const { readSubFolders, includeMetadata, state, maxDepth } = options
    let names = []
    try {
      names = await appFS.readUserDir(dirEndpath || '', {})
    } catch (err) {
      names = []
    }
    if (!Array.isArray(names)) names = []

    const entries = []
    for (const name of names) {
      const childEndpath = dirEndpath ? `${dirEndpath}/${name}` : name
      try {
        const st = await appFS.statUserFile(childEndpath)
        const isDir = st.type === 'dir' || st.type === 'directory'
        entries.push({ name, childEndpath, isDir, st })
      } catch (e) {
        continue
      }
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    const tree = []
    let folderIncomplete = false

    for (const ent of entries) {
      const { name, childEndpath, isDir, st } = ent
      const relPath = listRootEndpath
        ? path.posix.relative(listRootEndpath, childEndpath)
        : childEndpath

      if (isDir) {
        if (!readSubFolders) {
          tree.push({ name, path: relPath, type: 'folder', children: [] })
          continue
        }
        if (depth >= maxDepth) {
          tree.push({
            name,
            path: relPath,
            type: 'folder',
            children: [],
            incomplete: true,
            depthLimited: true
          })
          folderIncomplete = true
          continue
        }
        if (state.fileCount >= state.limit) {
          folderIncomplete = true
          break
        }
        const sub = await buildUserFileTreeFromAppFS(
          appFS,
          childEndpath,
          listRootEndpath,
          options,
          depth + 1
        )
        const node = { name, path: relPath, type: 'folder', children: sub.tree }
        if (sub.incomplete) {
          node.incomplete = true
          folderIncomplete = true
        }
        tree.push(node)
      } else {
        if (state.fileCount >= state.limit) {
          folderIncomplete = true
          break
        }
        state.fileCount++
        const node = { name, path: relPath, type: 'file' }
        if (includeMetadata && st) {
          if (typeof st.size === 'number') node.size = st.size
          if (typeof st.mtimeMs === 'number') node.mtimeMs = st.mtimeMs
        }
        tree.push(node)
      }
    }
    return { tree, incomplete: folderIncomplete }
  }

  /**
   * POST /feps/read_user_file_tree/:app_name
   * Body (JSON): subPath?, readSubFolders?, maxFiles?, maxDepth?, includeMetadata?
   * Uses appFS.readUserDir / statUserFile — same storage as PUT /feps/upload (no direct fs/ROOT_DIR).
   */
  const readUserFileTree = async (req, res) => {
    try {
      const appFS = res.locals.freezr?.appFS
      if (!appFS || !appFS.owner || !appFS.appName || typeof appFS.readUserDir !== 'function') {
        return sendFailure(res, 'Could not access app filesystem.', 'readUserFileTree', 500)
      }

      const body = req.body && typeof req.body === 'object' ? req.body : {}
      const readSubFolders = body.readSubFolders !== false
      const includeMetadata = body.includeMetadata === true
      let maxFiles = parseInt(body.maxFiles, 10)
      if (!Number.isFinite(maxFiles) || maxFiles < 1) {
        maxFiles = DEFAULT_MAX_USER_FILE_TREE_FILES
      }
      maxFiles = Math.min(maxFiles, 100000)

      let maxDepth = parseInt(body.maxDepth, 10)
      if (!Number.isFinite(maxDepth) || maxDepth < 0) {
        maxDepth = DEFAULT_MAX_USER_FILE_TREE_DEPTH
      }
      maxDepth = Math.min(maxDepth, ABSOLUTE_MAX_USER_FILE_TREE_DEPTH)

      const subPath = sanitizeUserFileSubPath(body.subPath)
      if (subPath === null) {
        return sendFailure(res, 'Invalid subPath.', 'readUserFileTree', 400)
      }

      if (subPath) {
        try {
          const st = await appFS.statUserFile(subPath)
          if (st && st.type === 'file') {
            return sendFailure(res, 'subPath is not a folder.', 'readUserFileTree', 400)
          }
        } catch (err) {
          res.locals.freezr.permGiven = true
          return sendApiSuccess(res, {
            success: true,
            tree: [],
            incomplete: false,
            fileCount: 0,
            maxFiles,
            maxDepth,
            subPath,
            readSubFolders,
            includeMetadata
          })
        }
      }

      res.locals.freezr.permGiven = true

      const state = { fileCount: 0, limit: maxFiles }
      const { tree, incomplete } = await buildUserFileTreeFromAppFS(
        appFS,
        subPath || '',
        subPath || '',
        { readSubFolders, includeMetadata, state, maxDepth }
      )

      return sendApiSuccess(res, {
        success: true,
        tree,
        incomplete,
        fileCount: state.fileCount,
        maxFiles,
        maxDepth,
        subPath,
        readSubFolders,
        includeMetadata
      })
    } catch (error) {
      console.error('readUserFileTree error:', error)
      return sendFailure(res, error, 'readUserFileTree', 500)
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
    sendUserFile,
    getUserFileToken,
    restoreRecord,
    serverlessTasks,
    llmAsk,
    llmGenerateImage,
    llmTranscribe,
    llmSpeak,
    readUserFileTree
  }
}

export default {
  createCepsApiController
}
