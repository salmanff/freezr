// freezr.info - Modern ES6 Module - Public API Controller
// Handles JSON API endpoints for public routes

import { sendFailure, sendAuthFailure, sendApiSuccess } from '../../../adapters/http/responses.mjs'

/**
 * Builds query parameters from request params and query string
 * 
 * @param {Object} req - Express request object
 * @returns {Object} Query parameters object
 */
const buildPublicQuery = (req) => {
  const queryParams = {}
  if (!req.query) req.query = {}
  
  // Add data_owner from user_id param
  if (req.params.user_id) {
    queryParams.data_owner = req.params.user_id.toLowerCase()
  }
  
  // Add requestor_app from app_name param
  if (req.params.app_name) {
    queryParams.requestor_app = req.params.app_name.toLowerCase()
  }
  
  // Add date filters
  if (req.query.published_before) {
    const beforeDate = parseInt(req.query.published_before)
    if (!isNaN(beforeDate)) {
      queryParams._date_published = queryParams._date_published || {}
      queryParams._date_published.$lt = beforeDate
    }
  }
  
  if (req.query.published_after) {
    const afterDate = parseInt(req.query.published_after)
    if (!isNaN(afterDate)) {
      queryParams._date_published = queryParams._date_published || {}
      queryParams._date_published.$gt = afterDate
    }
  }
  
  // Add search filter for search_words (must be done after isPublic is set)
  if (req.query.search) {
    const searchTerm = decodeURIComponent(req.query.search).trim().toLowerCase()
    if (searchTerm) {
      if (searchTerm.indexOf(' ') < 0) {
        // Single term - simple regex
        queryParams.search_words = new RegExp(searchTerm)
      } else {
        // Multiple terms - use $and with multiple regex conditions
        // Start with existing queryParams, then add search conditions
        const theAnds = [queryParams]
        const searchTerms = searchTerm.split(' ').filter(term => term.length > 0)
        searchTerms.forEach(term => {
          theAnds.push({ search_words: new RegExp(term) })
        })
        // Return new query with $and structure
        return { $and: theAnds }
      }
    }
  }
  
  return queryParams
}

/**
 * Creates public API controller
 * 
 * @returns {Object} Controller object with handler methods
 */
export const createPublicApiController = () => {
  return {
    /**
     * GET /public/readobject/@:user_id/:app_table/:data_object_id
     * Returns a single public object as JSON
     * Replaces: /v1/pobject/@:user_id/:requestee_app_table/:data_object_id
     */
    readObject: async (req, res) => {
      const flogger = res.locals.flogger
      const publicRecordsDb = res.locals.freezr?.publicRecordsDb

      res.locals.freezr.permGiven = true

      // onsole.log('readObject controller')

      if (!publicRecordsDb) {
        flogger?.error('Public records database not available')
        return sendFailure(res, 'Public records database not available', 'readObject', 500)
      }

      try {
        // Build object ID from params
        // Format: @user_id/app_table/data_object_id
        const userId = req.params.user_id?.toLowerCase()
        const appTable = req.params.app_table?.toLowerCase()
        const dataObjectId = req.params.data_object_id // ?.toLowerCase()

        if (!userId || !appTable || !dataObjectId) {
          flogger?.warn('Missing required parameters', { userId, appTable, dataObjectId })
          return sendFailure(res, 'Missing required parameters: user_id, app_table, data_object_id', 'readObject', 400)
        }

        const objectId = `@${userId}/${appTable}/${dataObjectId}`
        flogger?.track('Reading public object', { objectId })

        // Query public records database        
        const results = await publicRecordsDb.read_by_id(objectId)
        if (!results) {
          return sendFailure(res, 'Public object not found', 'public.readObject', 404)
        }


        // Return the original_record object
        const originalRecords = getMappedOriginalRecords([results])
        const originalRecord = originalRecords[0]
        return sendApiSuccess(res, originalRecord )
        
      } catch (error) {
        // flogger?.error('Error reading public object', { error, params: req.params })
        return sendFailure(res, error, 'public.readObject', 500)
      }
    },

    /**
     * GET /public/query
     * GET /public/query/@:user_id
     * GET /public/query/@:user_id/:app_name
     * Queries public database with optional filters
     * Replaces: /v1/pdbq, /v1/pdbq/@:user_id/:requestee_app, /v1/pdbq/:requestee_app
     */
    query: async (req, res) => {
      const flogger = res.locals.flogger
      const publicRecordsDb = res.locals.freezr?.publicRecordsDb

      if (!publicRecordsDb) {
        flogger?.error('Public records database not available')
        return sendFailure(res, 'Public records database not available', 'query', 500)
      }

      try {
        // Build query from params and query string
        let queryParams = {}
        let bodyOrQuery = {}
        if (!req.body) { // GET Params
          queryParams = buildPublicQuery(req)
          bodyOrQuery = req.query || {}
        } else { // POST Params
          queryParams = req.body.q || {}
          if (req.params.user_id) {
            queryParams.data_owner = req.params.user_id.toLowerCase()
          }
          bodyOrQuery = req.body || {}
        }
        if (queryParams.app) {
          queryParams.requestor_app = queryParams.app
          delete queryParams.app
        }
        if (queryParams.owner) {
          queryParams.data_owner = queryParams.owner
          delete queryParams.owner
        }

        // Always filter for public records
        queryParams.isPublic = true
        // .. unless private feeds/links are used - validate feeds / private codes..
        if (bodyOrQuery.feed) {
          queryParams.privateFeedNames = bodyOrQuery.feed
          queryParams.isPublic = false
        }
        if (queryParams.privateFeedNames) {
          const code = bodyOrQuery.code
          const name = queryParams.privateFeedNames
          if (!res.locals.freezr.privateFeedDb) {
            return sendFailure(res, 'Private feed database not available', 'query', 500)
          }
          const privateFeedResults = await res.locals.freezr.privateFeedDb.query({ name }, null)
          if (!privateFeedResults || privateFeedResults.length < 1) {
            return sendFailure(res, 'missingFeed', 'public.query', 401)
          } else if (privateFeedResults[0].code && privateFeedResults[0].code !== code) {
            return sendAuthFailure(res, {
              type: 'feedAuth',
              message: 'feedAuth',
              error: 'feedAuth in public.query',
              path: req.path,
              url: req.url
            })
          }
        } else if (bodyOrQuery.code) {
          queryParams.privateLinks = bodyOrQuery.code
          queryParams.isPublic = false
        }
        
        const skip = bodyOrQuery.skip ? parseInt(bodyOrQuery.skip) : 0
        const count = bodyOrQuery.count ? parseInt(bodyOrQuery.count) : 10
        const sort = bodyOrQuery.sort || { _date_published: -1 }


        // Execute query
        const results = await publicRecordsDb.query(queryParams, { sort, count, skip })
        
        res.locals.freezr.permGiven = true

        if (!results) {
          return sendApiSuccess(res, { results: [], count: 0 })
        }
        
        // Map results to original records format
        const mappedResults = getMappedOriginalRecords(results)
                
        return sendApiSuccess(res, { 
          results: mappedResults,
          count: mappedResults.length,
          skip,
          total: mappedResults.length // Note: actual total would require a separate count query
        })
        
      } catch (error) {
        console.error('Error querying public records', { error, params: req.params, query: req.query })
        flogger?.error('Error querying public records', { error, params: req.params, query: req.query })
        return sendFailure(res, error, 'public.query', 500)
      }
    }
  }
}

// Helper function to extract all original_record fields from an array of objects
function getMappedOriginalRecords(resultsArray) {
  if (!Array.isArray(resultsArray)) return []
  // Map each retrievedRecord to an afinalRecord with appropriate field mappings
  return resultsArray.map(retrievedRecord => {
    if (!retrievedRecord || !retrievedRecord.original_record) return null;
    const afinalRecord = { ...retrievedRecord.original_record };
    afinalRecord._app_name = retrievedRecord.requestor_app;
    afinalRecord._data_owner = retrievedRecord.data_owner;
    afinalRecord._search_words = retrievedRecord.search_words;
    // afinalRecord._permission_name = retrievedRecord.permission_name;
    afinalRecord._app_table = retrievedRecord.original_app_table;
    afinalRecord._date_modified = retrievedRecord._date_modified;
    afinalRecord._date_published = retrievedRecord._date_published || retrievedRecord._date_created;
    afinalRecord.__date_published = retrievedRecord._date_published
      ? (new Date(retrievedRecord._date_published).toLocaleDateString())
      : 'n/a';
    afinalRecord._date_created = retrievedRecord._date_created;
    afinalRecord._original_id = afinalRecord._id;
    afinalRecord._id = retrievedRecord._id;
    return afinalRecord;
  }).filter(Boolean);
}