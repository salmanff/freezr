// freezrApiV2.js - Modern Freezr API freezrApiV2.js
// Version 2.0.0 - 2026

/* global freezrMeta */

if (!freezrMeta) {
  console.warn('Need to define freezrMeta in the app before running freezrApiV2.js')
}
console.log('Running freezrApiV2.js !!')

// ============================================
// FREEZR API V2 - MODERN INTERFACE
// ============================================

const freezr = (function() {
  const API_VERSION = '2.0.0'

  // ============================================
  // PRIVATE - HELPER FUNCTIONS
  // ============================================

  function buildAppTable(collectionOrAppTable, requesteeApp) {
    // If has dots, it's already a full app_table
    if (collectionOrAppTable && collectionOrAppTable.includes('.')) {
      if (requesteeApp) console.warn(`buildAppTable: requesteeApp ${requesteeApp} is ignored because collectionOrAppTable ${collectionOrAppTable} has dots and so it is assumed to be the app_table`)
      return collectionOrAppTable
    }
    // Otherwise it's a collection name, prepend appName
    return `${requesteeApp || freezrMeta.appName}.${collectionOrAppTable}`
  }

  function shouldUseFeps(fepsOnlyKeys, options) {
    if (!options) return false
    return fepsOnlyKeys.some(key => options[key] !== undefined)
  }

  // ============================================
  // PRIVATE - API REQUEST HANDLER
  // ============================================

  async function apiRequest(method, path, body = null, options = {}) {
    // Construct full URL
    let url = path
    if (!url.startsWith('http') && !freezr.app.isWebBased && freezrMeta.serverAddress) {
      url = freezrMeta.serverAddress + url
    }

    // Get access token
    const PATHS_WITHOUT_TOKEN = [
      '/ceps/ping', '/acctapi/login', '/public/query',
      '/register/api/checkresource', '/register/api/firstSetUp', '/register/api/newselfreg', 
      '/oauth/token', '/oauth/get_new_state', '/oauth/validate_state'
    ]
    let pathOnly;
    if (url.startsWith('http')) {
      try {
        const parsedUrl = new URL(url);
        pathOnly = parsedUrl.pathname;
      } catch (e) {
        pathOnly = url; // fallback in case of invalid URL
      }
    } else {
      pathOnly = url.split('?')[0];
    }
    
    const accessToken = options?.appToken || 
                       (freezr.app.isWebBased ? freezr.utils.getCookie('app_token_' + freezrMeta.userId) : freezrMeta.appToken)

    if (!accessToken && !PATHS_WITHOUT_TOKEN.includes(pathOnly)) {
      console.warn('apiRequest: Need to obtain an app token before sending data to ', {pathOnly, url})
      const error = new Error('api Need to obtain an app token before sending data to ' + url)
      error.status = 401
      throw error
    }

    // Build headers
    const headers = {}
    if (accessToken) {
      headers.Authorization = 'Bearer ' + accessToken
    }
    
    // Handle different content types
    let requestBody = null
    if (body) {
      if (options?.uploadFile) {
        // FormData - let browser set Content-Type with boundary
        requestBody = body
      } else {
        headers['Content-Type'] = 'application/json'
        requestBody = JSON.stringify(body)
      }
    }

    // Make request
    // console.log('apiRequest', { method, url, headers })
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: requestBody
      })

      if (response.status === 200) {
        return options?.textResponse ? await response.text() : await response.json()
      } else {
        const errorData = await response.json().catch(() => ({}))
        console.error('apiRequest error', { errorData, response })
        const error = new Error(errorData.error || errorData.message || 'Unknown error')
        error.status = response.status
        
        throw error
      }
    } catch (error) {
      // If already an Error from response handling, rethrow
      if (error.status !== undefined) throw error
      
      // Network/fetch errors
      const networkError = new Error('Network error: ' + error.message)
      throw networkError
    }
  }

  /**
   * Internal helper: reads an SSE response from the server and collates
   * the final result. When callbacks (onDelta / onThinking) are provided
   * via callbackOptions they fire as chunks arrive (streamBack mode).
   * Otherwise the stream is consumed silently and the final result returned.
   *
   * @param {string} url - The endpoint URL
   * @param {*} body - Request body (JSON-serialisable object or FormData)
   * @param {Object} [options] - { appToken, onDelta, onThinking, isFormData }
   * @returns {Promise<Object>} Final result { success, response, meta, thinking? }
   */
  async function _streamingAsk (url, body, options = {}) {
    let fullUrl = url
    if (!fullUrl.startsWith('http') && !freezr.app.isWebBased && freezrMeta.serverAddress) {
      fullUrl = freezrMeta.serverAddress + fullUrl
    }

    const accessToken = options.appToken ||
      (freezr.app.isWebBased ? freezr.utils.getCookie('app_token_' + freezrMeta.userId) : freezrMeta.appToken)

    const headers = {}
    if (accessToken) headers.Authorization = 'Bearer ' + accessToken

    let requestBody
    if (options.isFormData) {
      requestBody = body
    } else {
      headers['Content-Type'] = 'application/json'
      requestBody = JSON.stringify(body)
    }

    const response = await fetch(fullUrl, { method: 'PUT', headers, body: requestBody })

    if (response.status !== 200) {
      const errorData = await response.json().catch(() => ({}))
      const error = new Error(errorData.error || errorData.message || 'Unknown error')
      error.status = response.status
      throw error
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let finalResult = null

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let lineEnd
      while ((lineEnd = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, lineEnd).trim()
        buffer = buffer.slice(lineEnd + 1)
        if (!line.startsWith('data: ')) continue
        try {
          const data = JSON.parse(line.slice(6))
          if (data.type === 'delta' && options.onDelta) {
            options.onDelta(data.text)
          } else if (data.type === 'thinking' && options.onThinking) {
            options.onThinking(data.text)
          } else if (data.type === 'done') {
            finalResult = { success: data.success, response: data.response, meta: data.meta }
            if (data.thinking) finalResult.thinking = data.thinking
          } else if (data.type === 'error') {
            throw new Error(data.error || 'LLM streaming error')
          }
        } catch (e) {
          if (e.message && !e.message.startsWith('Unexpected')) throw e
        }
      }
    }

    if (!finalResult) throw new Error('Stream ended without a done event')
    return finalResult
  }

  // ============================================
  // APP API - CORE CRUD
  // ============================================

  const freezr = {
    API_VERSION,
    
    app: {
      isWebBased: true,
      offlineCredentialsExpired: false
    },

    // Create a new record
    async create(collectionOrAppTable, data, options = {}) {
      if (!data) {
        throw new Error('No data to write')
      }

      const appTable = buildAppTable(collectionOrAppTable, options?.requestee_app)
      
      const writeOptions = { appToken: options?.appToken || null }

      const fepsOptions = ['data_object_id', 'upsert', 'permission_name', 'owner_id', 'requestee_app']
      if (shouldUseFeps(fepsOptions, options)) {
        const url = (options?.host || '') + '/feps/write/' + appTable + 
                    (options?.data_object_id ? ('/' + options.data_object_id) : '')
        
        const body = { _entity: data }
        fepsOptions.forEach(option => {
          if (options?.[option]) body[option] = options[option]
        })
        return await apiRequest('POST', url, body, writeOptions)
      } else {
        const url = (options.host || '') + '/ceps/write/' + appTable
        return await apiRequest('POST', url, data, writeOptions)
      }
    },

    // Read a record by ID
    async read(collectionOrAppTable, id, options = {}) {
      if (!id) {
        throw new Error('No id provided')
      }

      const requesteeApp = options?.requestee_app || freezrMeta.appName
      const appTable = buildAppTable(collectionOrAppTable, requesteeApp)
      
      if (shouldUseFeps(['permission_name', 'owner_id'], options)) {
        const permissionName = options?.permission_name || null
        const ownerId = options?.owner_id || null
        if (options?.host) console.log('core.read options.host', options.host)
        const url = (options?.host || '') + '/ceps/read/' + appTable + '/' + id + 
                    ((ownerId || requesteeApp || permissionName) ? '?' : '') + 
                    (ownerId ? ('owner_id=' + ownerId) : '') + 
                    (requesteeApp === freezrMeta.appName ? '' : ('requestor_app=' + freezrMeta.appName)) + 
                    (permissionName ? ('&permission_name=' + permissionName) : '')
        const readOptions = { appToken: options?.appToken || null }
        return await apiRequest('GET', url, null, readOptions)
      } else {
        const url = (options.host || '') + '/ceps/read/' + appTable + '/' + id
        const readOptions = { appToken: options.appToken || null }
        return await apiRequest('GET', url, null, readOptions)
      }
    },

    // Query records
    async query(collectionOrAppTable, query = {}, options = {}) {
      const appTable = buildAppTable(collectionOrAppTable)
            
      const url = '/ceps/query/' + appTable
      
      const body = { }
      const allowedOptions = ['permission_name', 'owner_id', 'count', 'skip', 'sort', 'requestee_app']
      allowedOptions.forEach(option => {
        // Use !== undefined to allow 0 values for count/skip
        if (options?.[option] !== undefined) body[option] = options[option]
      })
      body.q = query

      const writeOptions = { appToken: options?.appToken || null }
        
      return await apiRequest('POST', url, body, writeOptions)
      
      // CEPS GET query no longer used
    },

    // Update entire record (replaces all fields by default)
    async update(collectionOrAppTable, id, data, options = {}) {
      if (!id )  throw new Error('No id  provided for update')

      const appTable = buildAppTable(collectionOrAppTable)
      const writeOptions = { appToken: options.appToken || null }
      
      if (shouldUseFeps(['permission_name', 'owner_id'], options)) {
        const body = { _entity: data, replaceAllFields: true }
        const fepsKeys = ['permission_name', 'owner_id']
        fepsKeys.forEach(k => { if (options?.[k]) body[k] = options[k] })
        const url = (options.host || '') + '/feps/update/' + appTable + '/' + id
        return await apiRequest('PUT', url, body, writeOptions)
      } else {
        // Note in ceps, replaceAllFields is always true
        const url = (options.host || '') + '/ceps/update/' + appTable + '/' + id
        return await apiRequest('PUT', url, data, writeOptions)
      }
    },

    // Update specific fields only (partial update)
    async updateFields(collectionOrAppTable, idOrQuery, fields, options = {}) {
      const id = typeof idOrQuery === 'string' ? idOrQuery : null
      
      if (!id && typeof idOrQuery !== 'object') throw new Error('No id or query provided for updateFields')
      if (!fields || typeof fields !== 'object') throw new Error('No fields provided for updateFields')

      const appTable = buildAppTable(collectionOrAppTable)
      const writeOptions = { appToken: options.appToken || null }
      const url = (options.host || '') + '/feps/update/' + appTable + (id ? ('/' + id) : '')

      const body = id ? { _entity: fields } : { q: idOrQuery, keys: fields }

      const fepsOptions = ['permission_name', 'owner_id']
      fepsOptions.forEach(option => {
        if (options?.[option]) body[option] = options[option]
      })
      
      return await apiRequest('PUT', url, body, writeOptions)
    },

    // Delete a record
    async delete(collectionOrAppTable, idOrQuery, options = {}) {
      if (!idOrQuery) {
        throw new Error('No id or query provided for delete')
      }

      const appTable = buildAppTable(collectionOrAppTable)
      const isSingleRecord = typeof idOrQuery === 'string'
      const id = typeof idOrQuery === 'string' ? idOrQuery : null
      
      if (shouldUseFeps(['permission_name', 'owner_id'], options) || !isSingleRecord) {
        const url = (options.host || '') + '/feps/delete/' + appTable + 
                    (id ? ('/' + id) : '')
        const body = id ? {} : { q: idOrQuery }

        const fepsOptions = ['permission_name', 'owner_id']
        fepsOptions.forEach(option => {
          if (options?.[option]) body[option] = options[option]
        })
  
        const writeOptions = { appToken: options.appToken || null }
        return await apiRequest('DELETE', url, body, writeOptions)
      } else {
        const url = (options.host || '') + '/ceps/delete/' + appTable + '/' + idOrQuery
        const writeOptions = { appToken: options.appToken || null }
        return await apiRequest('DELETE', url, null, writeOptions)
      }
    },

    // Query Public Records
    async publicquery(options) {
      if (!options) options = {}
      const url = (options.host || '') + '/public/query' + (options.owner ? ('/@' + options.owner) : '')
      const writeOptions = {}
      
      if (options.appToken) {
        writeOptions.appToken = options.appToken
        delete options.appToken
      }
      delete options.host
    
      return await apiRequest('POST', url, options, writeOptions)

    },

    // Collection factory
    collection(name) {
      return {
        create: (data, options) => freezr.create(name, data, options),
        read: (id, options) => freezr.read(name, id, options),
        query: (query, options) => freezr.query(name, query, options),
        update: (id, data, options) => freezr.update(name, id, data, options),
        updateFields: (id, fields, options) => freezr.updateFields(name, id, fields, options),
        delete: (id, options) => freezr.delete(name, id, options)
      }
    },

    // ============================================
    // APP API - FILE OPERATIONS
    // ============================================

    async upload(file, options) {
      if (!file) {
        throw new Error('No file to upload')
      }
      if (!options) options = {}

      options.overwrite = !options.doNotOverWrite
      const url = (options.host || '') + '/feps/upload/' + freezrMeta.appName
      const writeOptions = { uploadFile: true }
      
      if (options.appToken) {
        writeOptions.appToken = options.appToken
        delete options.appToken
        delete options.host
      }

      const uploadData = new FormData()
      uploadData.append('file', file)
      uploadData.append('options', JSON.stringify(options))
      
      return await apiRequest('PUT', url, uploadData, writeOptions)
    },

    getFileUrl(fileId, options = {}) {
      if (!fileId) return null
      
      const app = options.requestee_app || freezrMeta.appName
      const userId = options.requestee_user_id || freezrMeta.userId
      const permissionName = options.permission_name || null // not used / tested yet
      
      if (fileId.startsWith('/')) fileId = fileId.slice(1)
      
      return `/feps/userfiles/${app}/${userId}/${fileId}` + (permissionName ? ('?permission_name=' + permissionName) : '')
    },

    async deleteFile(fileId, options = {}) {
      if (!fileId) {
        throw new Error('No file id provided')
      }

      return await freezr.delete('files', fileId, options)
    },

    // ============================================
    // APP API - PERMISSIONS
    // ============================================

    perms: {
      async getAppPermissions(options = {}) {
        const url = '/ceps/perms/get' + (options.owner ? ('?owner=' + options.owner) : '')
        return await apiRequest('GET', url)
      },

      async isGranted(permissionName) {
        const url = '/ceps/perms/get' + (options.owner ? ('?owner=' + options.owner) : '')
        const perms = await apiRequest('GET', url)
        
        if (!perms || perms.length === 0) return false
        return perms.some(p => p.name === permissionName && p.granted === true)
      },

      async shareRecords(idOrQuery, options = {}) {
        // Identifier precedence for `idOrQuery`:
        //   1. string             → original record _id (DEFAULT and recommended)
        //   2. array of strings   → bulk by original _ids
        //   3. object             → query_criteria; pass { publicid } when only the publicid is known
        //
        // Orphan recovery flags:
        //   - forcePublicIdTakeover (grant): delete a conflicting orphaned public record and
        //     (when same collection + same data_owner) clear the source _accessibles entry,
        //     then publish in its place.
        //   - forcePublicIdCleanup (deny): when paired with `query_criteria: { publicid }`,
        //     delete the orphaned public record even if no source record is found.
        //     For convenience, prefer `freezr.perms.unshareByPublicId(publicid, ...)`.
        if (!options.grantees && options.grantee) {
          options.grantees = [options.grantee]
        }
        
        if (!options.grantees || !Array.isArray(options.grantees) || 
            options.grantees.length === 0 || !options.name) {
          throw new Error('Must include permission name and grantees')
        }

        options.grant = (options.action === 'grant')
        
        const endpoint = '/ceps/perms/share_records'
        
        if (idOrQuery && typeof idOrQuery === 'string') {
          options.record_id = idOrQuery
          // if (options.publicid || options.pubDate || options.unlisted) {}
        } else {
          // endpoint = '/ceps/perms/share_records'
          if (idOrQuery && typeof idOrQuery === 'object') {
            options.query_criteria = idOrQuery
          }
          if (idOrQuery && Array.isArray(idOrQuery)) {
            options.object_id_list = idOrQuery
          }
        }

        return await apiRequest('POST', endpoint, options)
      },

      async shareFilePublicly(fileId, options = {}) {
        // fileId is the file's record _id (i.e. the file path used to address the record).
        // For both grant AND revoke the default is to identify the record by its _id,
        // matching the convention used by `shareRecords`.
        //
        // Options:
        //   - fileStructure       : html main-page bundle (.html files only)
        //   - publicid            : custom publicid to assign on grant
        //   - forcePublicIdTakeover : on grant, delete a conflicting orphan public record
        //   - byPublicId: true    : treat `fileId` as the publicid to revoke (use when you no
        //                            longer have the original file record). Implies action: 'deny'.
        //                            See also `freezr.perms.unshareByPublicId(...)`.
        //   - forcePublicIdCleanup : on revoke + byPublicId, delete the orphaned public record
        //                            even if no source file record is found.
        if (!fileId) {
          throw new Error('Must include file id')
        }
        
        if (options.fileStructure && !fileId.endsWith('.html')) {
          throw new Error('Main page must be a .html file')
        }

        options.table_id = freezrMeta.appName + '.files'
        options.grantees = ['_public']
        options.grant = (options.grant === undefined && options.action !== 'deny') || options.grant || options.action === 'grant'
        // default to grant
        if (options.grant) {
          options.record_id = fileId
        } else if (options.byPublicId) {
          delete options.byPublicId
          options.query_criteria = { publicid: fileId }
        } else {
          options.record_id = fileId
        }

        return await apiRequest('POST', '/ceps/perms/share_records', options)
      },

      async unshareByPublicId(publicid, options = {}) {
        // Explicit "I only have the publicid" entry point for revoking shares.
        // Use when the source record's _accessibles entry has been lost, or when a UI
        // flow only knows the public URL. Safe orphan recovery: pass
        // `forcePublicIdCleanup: true` to delete the public record even if its source
        // record can no longer be found.
        if (!publicid || typeof publicid !== 'string') {
          throw new Error('Must include publicid string')
        }
        if (!options.name) {
          throw new Error('Must include permission name')
        }
        if (!options.grantees && options.grantee) {
          options.grantees = [options.grantee]
        }
        if (!options.grantees || !Array.isArray(options.grantees) || options.grantees.length === 0) {
          options.grantees = ['_public']
        }
        options.action = 'deny'
        options.grant = false
        options.query_criteria = { publicid }

        return await apiRequest('POST', '/ceps/perms/share_records', options)
      },

      async validateDataOwner(options = {}) {
        options.requestor_user = freezrMeta.userId
        if (options.data_owner_host) {
          options.requestor_host = freezrMeta.serverAddress
        }
        if (!options.app_id) options.app_id = freezrMeta.appName

        // Get validation token
        const tokenResult = await apiRequest('POST', '/ceps/perms/validationtoken/set', options)
        options.validation_token = tokenResult ? tokenResult.validation_token : null

        if (!options.validation_token) {
          throw new Error('Failed to get validation token')
        }

        // Validate with data owner
        const dataOwnerUrl = (options.data_owner_host || '') + '/ceps/perms/validationtoken/validate'
        
        const queryParams = []
        for (const key in options) {
          queryParams.push(encodeURIComponent(key) + '=' + encodeURIComponent(options[key]))
        }
        const fullUrl = dataOwnerUrl + '?' + queryParams.join('&')
        
        return await apiRequest('GET', fullUrl)
      }
    },

    // ============================================
    // APP API - MESSAGES
    // ============================================

    messages: {
      async send(message = {}, options = {}) {
        if (!message.recipient_id && !message.recipients) {
          throw new Error('Must include recipient_id or recipients')
        }
        if ((!message.sharing_permission && !message.messaging_permission) || 
            !message.contact_permission || !message.table_id || !message.record_id) {
          throw new Error('Incomplete message fields')
        }

        message.type = message.sharing_permission ? 'share_records' : 'message_records'
        message.app_id = freezrMeta.appName
        message.sender_id = freezrMeta.userId
        message.sender_host = freezrMeta.serverAddress

        return await apiRequest('POST', '/ceps/message/initiate', message)
      },

      async markRead(messageIds, markAll = false) {
        if (!messageIds && !markAll) {
          throw new Error('Need either messageIds or markAll')
        }
        if (markAll && messageIds) {
          throw new Error('Need either messageIds or markAll, not both')
        }
        if (!markAll && (!Array.isArray(messageIds) || messageIds.length === 0)) {
          throw new Error('messageIds must be an array')
        }

        const body = { message_ids: messageIds, markAll }
        return await apiRequest('POST', '/ceps/message/mark_read', body)
      },

      async getAppMessages(options = {}) {
        return await apiRequest('GET', '/ceps/messages', null, options)
      }
    },

    // ============================================
    // APP API - UTILITIES
    // ============================================

    utils: {
      parse(dataString) {
        if (typeof dataString === 'string') {
          try {
            return JSON.parse(dataString)
          } catch (err) {
            return { data: dataString }
          }
        }
        return dataString
      },

      getCookie(name) {
        if (!freezr.app.isWebBased) return ''
        
        const cookieName = name + '='
        const cookies = document.cookie.split(';')
        
        for (let i = 0; i < cookies.length; i++) {
          let cookie = cookies[i]
          while (cookie.charAt(0) === ' ') {
            cookie = cookie.substring(1)
          }
          if (cookie.indexOf(cookieName) === 0) {
            return cookie.substring(cookieName.length, cookie.length)
          }
        }
        return ''
      },

      startsWith(longerText, checkText) {
        if (!checkText || !longerText) return false
        if (checkText.length > longerText.length) return false
        return checkText === longerText.slice(0, checkText.length)
      },

      longDateFormat(dateNum) {
        if (!dateNum || dateNum === 0) return 'n/a'
        
        try {
          const date = new Date(dateNum)
          const result = date.toLocaleDateString() + ' ' + date.toLocaleTimeString()
          return result.substring(0, result.length - 3)
        } catch (err) {
          return 'n/a - error'
        }
      },

      async getManifest(appName, callback) {
        if (!appName) appName = freezrMeta.appName
        const url = '/feps/manifest' + (appName ? '/' + appName : '')
        
        if (!callback) return await apiRequest('GET', url)
        console.warn('callback based getManifest is deprecated. pease use async/await instead')
        try {
          const result = await apiRequest('GET', url)
          callback(null, result)
        } catch (err) {
          callback(err)
        }
      },

      async ping(options = {}) {
        const url = (options.server || '') + '/ceps/ping'
        const response = await apiRequest('GET', url, null, options)
        if (!response.server_type) {
          throw new Error('No server type in ping response')
        }
        return response
      },

      async getHtml(partPath, appName) {
        if (!appName) appName = freezrMeta.appName
        if (!partPath.endsWith('.html') && !partPath.endsWith('.htm')) {
          throw new Error('Can only get HTML files')
        }
        
        const url = '/app/' + appName + '/' + partPath
        return await apiRequest('GET', url, null, { textResponse: true })
      },

      async getAllAppList() {
        return await apiRequest('GET', '/acctapi/getAppList')
      },

      async getPrefs() {
        return await apiRequest('GET', '/acctapi/getUserPrefs')
      },

      async getAppResourceUsage(app) {
        const options = app ? { app_name: app } : null
        const queryParams = []
        if (options) {
          for (const key in options) {
            queryParams.push(encodeURIComponent(key) + '=' + encodeURIComponent(options[key]))
          }
        }
        const url = '/acctapi/getAppResourceUsage' + (queryParams.length > 0 ? '?' + queryParams.join('&') : '')
        return await apiRequest('GET', url)
      },

      publicPathFromId(fileId, requesteeApp, userId) {
        if (!userId) {
          console.warn('Need to specify userId - userId was disassociated from fileId')
        }
        if (!fileId || !requesteeApp || !userId) return null
        if (fileId.startsWith('/')) fileId = fileId.slice(1)
        return '/@' + userId + '/' + requesteeApp + '/' + fileId
      },

      appFilePathFrom(appFolderRelativePath) {
        return '/app/@' + freezrMeta.userId + '/' + freezrMeta.appName + '/' + appFolderRelativePath
      },

      userFilePath(fileId) {
        if (!fileId) return null
        if (fileId.startsWith('/')) fileId = fileId.slice(1)
        return '/feps/userfiles/' + freezrMeta.appName + '/' + freezrMeta.userId + '/' + fileId
      },

      // Backward compatibility helper
      getOpCbFrom(optionsAndCallback) {
        if (!optionsAndCallback || optionsAndCallback.length === 0) return [null, null]
        const callback = optionsAndCallback[optionsAndCallback.length - 1]
        const options = optionsAndCallback.length > 1 ? (optionsAndCallback[0] || {}) : {}
        if (optionsAndCallback.length > 2) {
          console.warn('Too many parameters in function', optionsAndCallback)
        }
        return [options, callback]
      }
    },

    // ============================================
    // APP API - MENU (TODO V3: Refactor to event-driven)
    // ============================================

    menu: {
      options: {
        showButton: true  // Apps can set to false to hide App Home button
      },

      open() {
        const menu = document.getElementById('freezer_menu')
        const overlay = document.getElementById('freezer_menu_overlay')
        if (menu && overlay) {
          overlay.style.display = 'block'
          menu.style.right = '0'
          this._loadContent()
        }
      },

      close() {
        const menu = document.getElementById('freezer_menu')
        const overlay = document.getElementById('freezer_menu_overlay')
        if (menu && overlay) {
          menu.style.right = '-130px'
          setTimeout(() => {
            overlay.style.display = 'none'
          }, 300)
        }
      },

      async _loadContent() {
        const contentDiv = document.getElementById('freezer_menu_content')
        if (!contentDiv) return
        if (/^\/(account|register|admin)\//.test(window.location.pathname)) return
        try {
          const perms = await freezr.perms.getAppPermissions()
          this._renderContent(perms)
        } catch (err) {
          console.warn('Error loading permissions:', err)
          contentDiv.innerHTML = '<div style="padding: 10px; font-size: 11px;">Error loading permissions</div>'
        }
      },
 
      _renderContent(perms) {
        const contentDiv = document.getElementById('freezer_menu_content')
        if (!contentDiv) return

        let html = ''

        // Permissions section
        if (perms && perms.length > 0) {
          html += '<div style="padding: 10px 15px; border-top: 1px solid #ddd;">'
          html += '<div style="font-weight: bold; font-size: 11px; margin-bottom: 8px;">Permissions Granted</div>'
          
          perms.forEach(perm => {
            const icon = perm.granted ? '✓' : '✗'
            const color = perm.granted ? '#080' : '#800'
            html += `<div style="font-size: 10px; margin-bottom: 4px; color: ${color}; text-indent: -12px; padding-left: 12px;">`
            html += `${icon} ${perm.name.replace(/_/g, ' ')}</div>`
          })
          
          html += '<div class="freezer_menu_button freezr_settings_link" '
          html += 'style="margin-top: 10px; font-size: 10px; text-align: center;">Settings</div>'
          html += '</div>'
        } else if (window.location.pathname.indexOf('/apps') === 0) {
          html += '<div style="padding: 10px 15px; border-top: 1px solid #ddd;">'
          html += '<div class="freezer_menu_button freezr_settings_link" '
          html += 'style="font-size: 10px; text-align: center;">Settings</div>'
          html += '</div>'
        }

        contentDiv.innerHTML = html
        contentDiv.querySelectorAll('.freezr_settings_link').forEach(el => {
          el.addEventListener('click', () => { window.location.href = '/account/app/settings/' + freezrMeta.appName })
        })
      },

      _highestSeverity(notifications) {
        // error > warning > info
        const order = { error: 3, warning: 2, info: 1 }
        let best = null
        let bestRank = 0
        for (const n of (notifications || [])) {
          const rank = order[n.severity] || 1
          if (rank > bestRank) { best = n.severity || 'info'; bestRank = rank }
        }
        return best
      },

      _renderBadge(buttonEl) {
        if (!buttonEl) return
        const existing = buttonEl.querySelector('.freezr-notif-badge')
        if (existing) existing.remove()
        const notifications = (freezrMeta && freezrMeta.notifications) || []
        if (!notifications.length) return
        const badge = document.createElement('div')
        badge.className = 'freezr-notif-badge'
        badge.setAttribute('data-severity', this._highestSeverity(notifications) || 'error')
        badge.textContent = notifications.length > 9 ? '9+' : String(notifications.length)
        buttonEl.style.position = buttonEl.style.position || 'fixed'
        buttonEl.appendChild(badge)
      },

      _createElements() {
        const menuButton = document.createElement('div')
        menuButton.id = 'freezer_img_button'
        menuButton.className = 'freezr-logo-btn-negative-gradient'
        if (!this.options.showButton) menuButton.style.display = 'none'
        menuButton.onclick = () => this.open()
        document.body.appendChild(menuButton)
        this._renderBadge(menuButton)

        // Create overlay
        const overlay = document.createElement('div')
        overlay.id = 'freezer_menu_overlay'
        overlay.onclick = () => this.close()
        document.body.appendChild(overlay)

        // Create menu
        const menu = document.createElement('div')
        menu.id = 'freezer_menu'
        
        // Close button
        const closeBtn = document.createElement('div')
        closeBtn.className = 'freezer_menu_button freezer_close_button'
        const textEl = document.createElement('span')
        textEl.id = 'freezer_menu_close_text'
        textEl.textContent = 'Close'
        closeBtn.appendChild(textEl)

        const imgCloseBtn = document.createElement('div')
        imgCloseBtn.id = 'freezer_menu_inner_close_img'
        imgCloseBtn.className = 'freezr-logo-btn-negative-gradient'
        closeBtn.appendChild(imgCloseBtn)
        closeBtn.onclick = () => this.close()
        menu.appendChild(closeBtn)

        // freezr Home button (only for web apps)
        if (freezr.app.isWebBased && window.location.pathname !== '/account/home') {
          const freezrHomeBtn = document.createElement('div')
          freezrHomeBtn.className = 'freezer_menu_button'
          freezrHomeBtn.textContent = 'freezr Home'
          freezrHomeBtn.onclick = () => window.location.href = '/account/home'
          menu.appendChild(freezrHomeBtn)

          // App Home button (conditional)
          if (window.location.pathname !== `/apps/${freezrMeta.appName}/index` && 
              window.location.pathname.indexOf('/account') !== 0 &&
              window.location.pathname.indexOf('/register') !== 0 &&
              window.location.pathname.indexOf('/creator') !== 0 &&
              window.location.pathname.indexOf('/admin') !== 0) {
            const appHomeBtn = document.createElement('div')
            appHomeBtn.className = 'freezer_menu_button'
            appHomeBtn.textContent = 'App Home'
            appHomeBtn.onclick = () => window.location.href = `/apps/${freezrMeta.appName}`
            menu.appendChild(appHomeBtn)
          }
        } else {
          const logginText = document.createElement('div')
          logginText.id = 'freezer_menu_login_text'
          logginText.textContent = 'You are logged in as ' +
            freezrMeta.userId + ' on freezr server: ' +
            freezrMeta.serverAddress.replaceAll('/', '/ ').replaceAll(':', ': ').replaceAll('.', '. ')
            ' version: ' + freezrMeta.serverVersion
          menu.appendChild(logginText)

        }

        // Notifications block - rendered synchronously from freezrMeta.notifications.
        // Sits above the per-app content so it shows on every page (apps + system).
        const notifBlock = document.createElement('div')
        notifBlock.id = 'freezer_menu_notifications'
        menu.appendChild(notifBlock)
        this._renderNotifications(notifBlock)

        // Content area for permissions
        const content = document.createElement('div')
        content.id = 'freezer_menu_content'
        menu.appendChild(content)

        document.body.appendChild(menu)
      },

      _renderNotifications(container) {
        if (!container) return
        const notifications = (freezrMeta && freezrMeta.notifications) || []
        container.innerHTML = ''
        if (!notifications.length) {
          container.style.display = 'none'
          return
        }
        container.style.display = 'block'
        notifications.forEach(n => {
          const item = document.createElement('div')
          item.className = 'freezr-notif-item'
          item.setAttribute('data-severity', n.severity || 'info')

          const title = document.createElement('div')
          title.className = 'freezr-notif-title'
          title.textContent = n.title || ''
          item.appendChild(title)

          if (n.message) {
            const msg = document.createElement('div')
            msg.className = 'freezr-notif-msg'
            msg.textContent = n.message
            item.appendChild(msg)
          }

          if (n.action && n.action.url) {
            const a = document.createElement('a')
            a.className = 'freezr-notif-action'
            a.href = n.action.url
            a.textContent = n.action.label || 'View'
            item.appendChild(a)
          }

          container.appendChild(item)
        })
      }
    },

    llm: {
      /**
       * Check if the user has any LLM keys configured
       * @param {Object} [options]
       * @param {string} [options.appToken] - App token
       * @param {string} [options.provider] - Preferred provider for the returned snapshot
       * @param {boolean} [options.refresh] - Refresh pricing metadata before returning
       * @param {string} [options.host] - Remote host
       * @returns {Promise<Object>} { success, exists, defaultProvider, defaultFamily, providers, imageProviders?, pricingMeta }
       * `defaultProvider` is the user's chosen default provider name (e.g. 'Claude', 'ChatGPT').
       * `defaultFamily` is the default model family for that provider (e.g. 'sonnet', 'mini').
       * `providers[providerName]` is an array of `{ id, family, provider, version, latest, pricing }`.
       * `imageProviders[providerName]` is an array of image models (present when image models exist).
       * `latest` is true for the newest model in each family.
       * `pricing` is `{ input, output, other? }` (cost per M tokens) or null.
       * `pricingMeta[providerName]` is `{ lastUpdated, refreshNeeded }`.
       */
      async ping (options = {}) {
        const url = (options.host || '') + '/feps/llm/ask'
        const writeOptions = {}
        if (options.appToken) writeOptions.appToken = options.appToken
        const body = { ping: true }
        if (options.provider) body.provider = options.provider
        if (options.refresh) body.refresh = true
        return apiRequest('PUT', url, body, { ...writeOptions, contentType: 'application/json' })
      },
      /**
       * Send a prompt to an LLM via the user's stored API keys
       * @param {string|Array} prompt - Text prompt or array of { role, content } messages for conversation history
       * @param {Object} [options] - Optional settings
       * @param {string} [options.context] - System message (LLM instructions/persona - eg 'you are a helpful assistant')
       * @param {string} [options.provider] - Preferred provider ('Claude' or 'ChatGPT')
       * @param {string} [options.family] - Model family shorthand ('sonnet', 'mini', 'opus' etc). Used when model is not specified.
       * @param {string} [options.model] - Model shorthand ('sonnet', 'o3-mini' etc) or full model name
       * @param {number} [options.max_tokens] - Max tokens for the response
       * @param {boolean} [options.noCosts] - Skip pricing lookups/cost enrichment for this request
       * @param {string} [options.role] - Default role when prompt is a string (defaults to 'user')
       * @param {string} [options.responseType] - 'json' to auto-parse JSON from the LLM response
       * @param {boolean|Object} [options.thinking] - Enable extended thinking/reasoning.
       *   Claude: true for 10k budget, or { budget_tokens: N }. Returns full thinking text.
       *   ChatGPT: true for medium effort, or { effort: 'low'|'medium'|'high' }. Auto-selects o-series model. Returns reasoning summary.
       * @param {File|File[]} [options.files] - One or more File objects to include with the request
       * @param {boolean} [options.streamBack] - Stream LLM response chunks back to the browser via SSE.
       *   When true, onDelta/onThinking callbacks fire as text arrives. Incompatible with files and responseType:'json'.
       * @param {function} [options.onDelta] - Called with each text chunk during streaming (requires streamBack:true)
       * @param {function} [options.onThinking] - Called with each thinking/reasoning chunk during streaming
       * @param {string} [options.appToken] - App token (if calling from another app context)
       * @param {string} [options.host] - Remote host (for cross-server calls)
       * @returns {Promise<Object>} Response with
       *   { success, response, thinking?, meta: { provider, model, modelFamily, rawUsage, tokensUsed, cost?, pricing, availableFamilies, hasKey } }
       */
      async ask (prompt, options = {}) {
        const url = (options.host || '') + '/feps/llm/ask'

        const streamOpts = {
          appToken: options.appToken,
          onDelta: options.streamBack ? options.onDelta : undefined,
          onThinking: options.streamBack ? options.onThinking : undefined
        }

        if (options.files) {
          const uploadData = new FormData()
          const fileList = Array.isArray(options.files) ? options.files : [options.files]
          fileList.forEach(f => uploadData.append('file', f))
          const bodyOptions = {
            prompt,
            context: options.context,
            provider: options.provider,
            family: options.family,
            model: options.model,
            max_tokens: options.max_tokens,
            noCosts: options.noCosts,
            role: options.role,
            responseType: options.responseType,
            thinking: options.thinking
          }
          uploadData.append('options', JSON.stringify(bodyOptions))
          return _streamingAsk(url, uploadData, { ...streamOpts, isFormData: true })
        }

        const bodyOptions = {
          provider: options.provider,
          family: options.family,
          model: options.model,
          max_tokens: options.max_tokens,
          noCosts: options.noCosts,
          role: options.role,
          responseType: options.responseType,
          thinking: options.thinking
        }

        return _streamingAsk(url, { prompt, context: options.context, options: bodyOptions }, streamOpts)
      },
      /**
       * Generate an image using the user's stored LLM API keys.
       * OpenAI returns raster PNG; Anthropic generates SVG converted to PNG server-side.
       * @param {string} prompt - Text description of the image to generate
       * @param {Object} [options] - Optional settings
       * @param {string} [options.size] - Image size (default '1024x1024')
       * @param {string} [options.quality] - Quality level (default 'auto')
       * @param {string} [options.outputFormat] - 'png' (default) or 'svg'
       * @param {string} [options.provider] - LLM provider ('ChatGPT' or 'Claude')
       * @param {string} [options.model] - Specific model to use (adapter picks default if omitted)
       * @param {string} [options.appToken] - App token
       * @param {string} [options.host] - Remote host
       * @returns {Promise<Object>} { success, format, b64Data?, svgData?, revisedPrompt, meta, tokensUsed, cost }
       */
      async generateImage (prompt, options = {}) {
        const url = (options.host || '') + '/feps/llm/generate_image'
        const writeOptions = {}
        if (options.appToken) writeOptions.appToken = options.appToken
        const body = { prompt, size: options.size, quality: options.quality, outputFormat: options.outputFormat }
        if (options.provider) body.provider = options.provider
        if (options.model) body.model = options.model
        return apiRequest('PUT', url, body, { ...writeOptions, contentType: 'application/json' })
      }
    },

    serverless: {
      async _deliverTask (options) {
        if (!options || !options.task) {
          throw new Error('No options sent.')
        }
        // to check to make sure function naame is has no unallowed characters
        const url = (options.host || '') + '/feps/serverless/' + options.task
        const writeOptions = { }
        if (options.appToken) {
          writeOptions.appToken = options.appToken
          delete options.appToken
          delete options.host
        }
        if (options.file) {
          writeOptions.uploadFile = true
          const uploadData = new FormData()
          uploadData.append('file', options.file) /* onsole.log('Sending file1') */
          const newOptions = {}
          Object.keys(options).forEach((key) => { if (key !== 'file') newOptions[key] = options[key] })
          uploadData.append('options', JSON.stringify(newOptions))
          return apiRequest('PUT', url, uploadData, writeOptions)
        } else if (options.useGet) {
          return apiRequest('GET', url, null)
        } else {
          return apiRequest('PUT', url, options, { ...writeOptions, contentType: 'application/json' })
        }
      },
      invokeCloud: async (options) => freezr.serverless._deliverTask({...options, task: 'invokeserverless'}),
      invokeLocal: async (options) => freezr.serverless._deliverTask({...options, task: 'invokelocalservice'}),
      createInvokeCloud: async (options) => freezr.serverless._deliverTask({...options, task: 'createinvokeserverless'}),
      upsertCloud: async (options) => freezr.serverless._deliverTask({...options, task: 'upsertserverless'}),
      updateCloud: async (options) => freezr.serverless._deliverTask({...options, task: 'updateserverless'}),
      deleteCloud: async (options) => freezr.serverless._deliverTask({...options, task: 'deleteserverless'}),
      roleCreateCloud: async (options) => freezr.serverless._deliverTask({...options, task: 'rolecreateserverless'}),
      deleteRole: async (options) => freezr.serverless._deliverTask({...options, task: 'deleterole'}),
      upsertLocal: async (options) => freezr.serverless._deliverTask({...options, task: 'upsertlocalservice'}),
      deleteLocal: async (options) => freezr.serverless._deliverTask({...options, task: 'deletelocalfunction'}),
      getAllLocalFunctions: async (options) => freezr.serverless._deliverTask({...options, useGet: true, task: 'getalllocalfunctions'})

    },

    // Callback for when menu closes (deprecated, kept for compatibility)
    onFreezrMenuClose: null,

    // ============================================
    // PUBLIC API - LOW-LEVEL REQUEST METHOD
    // ============================================
    
    // Expose apiRequest for custom API calls (e.g., account API endpoints)
    apiRequest
  }

  // ============================================
  // BACKWARD COMPATIBILITY LAYER
  // ============================================

  function callbackToAsync(asyncFn, args) {
    const callback = args[args.length - 1]
    const params = args.slice(0, -1)
    
    asyncFn(...params)
      .then(result => callback(null, result))
      .catch(error => callback(error))
  }

  // Legacy CEPS methods (callback-based)
  freezr.ceps = {
    create(data, ...optionsAndCallback) {
      console.warn('DEPRECATED: freezr.ceps.create() - Use freezr.create() instead')
      const [options, callback] = freezr.utils.getOpCbFrom(optionsAndCallback)
      
      // Extract collection/app_table from options for backward compat
      const collectionOrAppTable = options.app_table || 
                                   (options.collection ? `${freezrMeta.appName}.${options.collection}` : null)
      
      if (!callback) return freezr.create(collectionOrAppTable, data, options)
      callbackToAsync(freezr.create, [collectionOrAppTable, data, options, callback])
    },

    getById(dataObjectId, options, callback) {
      console.warn('DEPRECATED: freezr.ceps.getById() - Use freezr.read() instead')
      
      const collectionOrAppTable = options.app_table || 
                                   (options.collection ? `${freezrMeta.appName}.${options.collection}` : null)
      
      if (!callback) return freezr.read(collectionOrAppTable, dataObjectId, options)
      callbackToAsync(freezr.read, [collectionOrAppTable, dataObjectId, options, callback])
    },

    getquery(...optionsAndCallback) {
      console.warn('DEPRECATED: freezr.ceps.getquery() - Use freezr.query() instead')
      const [options, callback] = freezr.utils.getOpCbFrom(optionsAndCallback)
      
      const collectionOrAppTable = options.app_table || 
                                   (options.collection ? `${freezrMeta.appName}.${options.collection}` : null)
      const appTable = collectionOrAppTable || freezrMeta.appName + '.' + options.collection
      
      const query = options.q || {}
      const transformedQuery = { ...query }
      if (query._date_modified) {
        if (query._date_modified.$lt && !isNaN(query._date_modified.$lt)) {
          transformedQuery._modified_before = query._date_modified.$lt
        }
        if (query._date_modified.$gt && !isNaN(query._date_modified.$gt)) {
          transformedQuery._modified_after = query._date_modified.$gt
        }
        delete transformedQuery._date_modified
      }
        
      // Remove complex queries for CEPS
      for (const param in transformedQuery) {
        if (typeof transformedQuery[param] === 'object' && param !== '_date_modified') {
          delete transformedQuery[param]
          console.warn('Cannot have complex queries in CEPS - ' + param + ' is invalid')
        }
      }
        
      const url = (options.host || '') + '/ceps/query/' + appTable
      const readOptions = { appToken: options.appToken || null }
        
      // Add query params to URL
      const queryParams = []
      for (const key in transformedQuery) {
        queryParams.push(encodeURIComponent(key) + '=' + encodeURIComponent(transformedQuery[key]))
      }
      const fullUrl = queryParams.length > 0 ? url + '?' + queryParams.join('&') : url
      console.log('query ceps getquery fullUrl', fullUrl)

      if (!callback) return apiRequest('GET', fullUrl, null, readOptions)
      callbackToAsync(apiRequest, [ 'GET', fullUrl, null, readOptions, callback])
    },

    update(data = {}, ...optionsAndCallback) {
      console.warn('DEPRECATED: freezr.ceps.update() - Use freezr.update() instead')
      const [options, callback] = freezr.utils.getOpCbFrom(optionsAndCallback)
      
      const collectionOrAppTable = options.app_table || 
                                   (options.collection ? `${freezrMeta.appName}.${options.collection}` : null)
      
      if (!callback) return freezr.update(collectionOrAppTable, data._id, data, options)
      callbackToAsync(freezr.update, [collectionOrAppTable, data._id, data, options, callback])
    },

    delete(dataObjectId, options, callback) {
      console.warn('DEPRECATED: freezr.ceps.delete() - Use freezr.delete() instead')
      
      const collectionOrAppTable = options.app_table || 
                                   (options.collection ? `${freezrMeta.appName}.${options.collection}` : null)
      
      if (!callback) return freezr.delete(collectionOrAppTable, dataObjectId, options)
      callbackToAsync(freezr.delete, [collectionOrAppTable, dataObjectId, options, callback])
    },

    sendMessage(toShare = {}, callback) {
      console.warn('DEPRECATED: freezr.ceps.sendMessage() - Use freezr.messages.send() instead')
      
      if (!callback) return freezr.messages.send(toShare)
      callbackToAsync(freezr.messages.send, [toShare, callback])
    },

    getAppMessages(options, callback) {
      console.warn('DEPRECATED: freezr.ceps.getAppMessages() - Use freezr.messages.getAppMessages() instead')
      
      if (!callback) return freezr.messages.getAppMessages(options)
      callbackToAsync(freezr.messages.getAppMessages, [options, callback])
    }
  }

  // Legacy FEPS methods
  freezr.feps = {
    create(data, ...optionsAndCallback) {
      console.warn('DEPRECATED: freezr.feps.create() - Use freezr.create() instead')
      const [options, callback] = freezr.utils.getOpCbFrom(optionsAndCallback)
      
      // Extract collection/app_table from options for backward compat
      const collectionOrAppTable = options.app_table || 
                                   (options.collection ? `${freezrMeta.appName}.${options.collection}` : null)
      if (options.updateRecord) {
        if (!callback) return freezr.update(collectionOrAppTable, data._id, data, options)
        callbackToAsync(freezr.update, [collectionOrAppTable, data._id, data, options, callback])
      } else {
        if (!callback) return freezr.create(collectionOrAppTable, data, options)
        callbackToAsync(freezr.create, [collectionOrAppTable, data, options, callback])
      }
    },

    write(data, ...optionsAndCallback) {
      console.warn('DEPRECATED: freezr.feps.write() - Use freezr.create() instead', { data, optionsAndCallback })
      return freezr.feps.create(data, ...optionsAndCallback)
    },

    getById(dataObjectId, options = {}, callback) {
      console.warn('DEPRECATED: freezr.feps.getById() - Use freezr.read() instead')
      return freezr.ceps.getById(dataObjectId, options, callback)
    },

    postquery(...optionsAndCallback) {
      console.warn('DEPRECATED: freezr.feps.postquery() - Use freezr.query() instead')
      const [options, callback] = freezr.utils.getOpCbFrom(optionsAndCallback)
      
      // Extract collection/app_table from options for backward compat
      const collectionOrAppTable = options.app_table || 
                                   (options.collection ? `${freezrMeta.appName}.${options.collection}` : null)
      if (!callback) return freezr.query(collectionOrAppTable, query, options)
      const query = options.q || {}
      delete options.q
      callbackToAsync(freezr.query, [collectionOrAppTable, query, options, callback])
      
    },

    update(data = {}, ...optionsAndCallback) {
      console.warn('DEPRECATED: freezr.feps.update() - Use freezr.update() instead')
      const [options, callback] = freezr.utils.getOpCbFrom(optionsAndCallback)
      
      const collectionOrAppTable = options.app_table || 
                                   (options.collection ? `${freezrMeta.appName}.${options.collection}` : null)

      if (options?.q) {
        if (!callback) return freezr.updateFields(collectionOrAppTable, options.q, data, options)
        callbackToAsync(freezr.updateFields, [collectionOrAppTable, options.q, data, options, callback])
      } else {
        if (!callback) return freezr.update(collectionOrAppTable, data._id, data, options)
        callbackToAsync(freezr.update, [collectionOrAppTable, data._id, data, options, callback])
      }
    },

    delete(idOrQuery, options, callback) {
      console.warn('DEPRECATED: freezr.feps.delete() - Use freezr.delete() instead')
      const collectionOrAppTable = options.app_table || 
        (options.collection ? `${freezrMeta.appName}.${options.collection}` : null)

      // return freezr.delete(collectionOrAppTable, idOrQuery, options, callback)
      callbackToAsync(freezr.delete, [collectionOrAppTable, idOrQuery, options, callback])

    },

    upload(file, options, callback) {
      console.warn('DEPRECATED: freezr.feps.upload() - Use freezr.upload() instead')
      
      if (!callback) return freezr.upload(file, options)
      callbackToAsync(freezr.upload, [file, options, callback])
    },

    getByPublicId(dataObjectId, options, callback) {
      console.warn('DEPRECATED: freezr.feps.getByPublicId () - use freezr.public.query() instead')
      if (!options) options = {}
      options._id = dataObjectId
      return freezr.feps.publicquery(options, callback)
    },

    publicquery(options, callback) {
      console.warn('DEPRECATED: freezr.feps.publicquery() - use freezr.public.query() instead')
      const url = (options.host || '') + '/public/query'
      const reqOptions = {}
      
      if (options.appToken) {
        reqOptions.appToken = options.appToken
        delete options.appToken
        delete options.host
      }
      
      if (!callback) {
        return apiRequest('POST', url, options, reqOptions)
      }
      
      apiRequest('POST', url, options, reqOptions)
        .then(result => callback(null, result))
        .catch(error => callback(error))
    },

    markMessagesRead(messageIds, markAll, callback) {
      console.warn('DEPRECATED: freezr.feps.markMessagesRead() - Use freezr.messages.markRead() instead')
      
      if (!callback) return freezr.messages.markRead(messageIds, markAll)
      callbackToAsync(freezr.messages.markRead, [messageIds, markAll, callback])
    },

    microservices (options, callback) {
      console.warn('DEPRECATED: freezr.feps.microservices() - Use freezr.microservices() - TO BE CREATED!!')
      // options must include task
      if (!options || !options.task) {
        callback(new Error('No options sent.'))
        return
      }
      // to check to make sure function naame is has no unallowed characters
      const url = (options.host || '') + '/feps/serverless/' + options.task
      const writeOptions = { }
      if (options.appToken) {
        writeOptions.appToken = options.appToken
        delete options.appToken
        delete options.host
      }
      if (options.file) {
        writeOptions.uploadFile = true
        const uploadData = new FormData()
        uploadData.append('file', options.file) /* onsole.log('Sending file1') */
        const newOptions = {}
        Object.keys(options).forEach((key) => { if (key !== 'file') newOptions[key] = options[key] })
        uploadData.append('options', JSON.stringify(newOptions))
        uploadData.append('other', 'hello other')
        if (!callback) {
          return apiRequest('PUT', url, uploadData, writeOptions)
        }
        apiRequest('PUT', url, uploadData, writeOptions)
          .then(result => callback(null, result))
          .catch(error => callback(error))
      } else {
        if (!callback) {
          return apiRequest('PUT', url, options, { ...writeOptions, contentType: 'application/json' })
        }
        apiRequest('PUT', url, options, { ...writeOptions, contentType: 'application/json' })
          .then(result => callback(null, result))
          .catch(error => callback(error))
      }
    }
  }

  // Legacy promise-based methods
  freezr.promise = {
    ceps: {},
    feps: {},
    perms: {}
  }

  Object.keys(freezr.ceps).forEach(funcName => {
    freezr.promise.ceps[funcName] = function(...args) {
      console.warn(`DEPRECATED: freezr.promise.ceps.${funcName}() - Use freezr.${funcName}() instead (already async)`)
      return new Promise((resolve, reject) => {
        const callback = (err, result) => err ? reject(err) : resolve(result)
        freezr.ceps[funcName](...args, callback)
      })
    }
  })

  Object.keys(freezr.feps).forEach(funcName => {
    freezr.promise.feps[funcName] = function(...args) {
      console.warn(`DEPRECATED: freezr.promise.feps.${funcName}() - Use freezr.${funcName}() instead (already async)`)
      return new Promise((resolve, reject) => {
        const callback = (err, result) => err ? reject(err) : resolve(result)
        freezr.feps[funcName](...args, callback)
      })
    }
  })

  Object.keys(freezr.perms).forEach(funcName => {
    freezr.promise.perms[funcName] = function(...args) {
      console.warn(`DEPRECATED: freezr.promise.perms.${funcName}() - Use freezr.perms.${funcName}() instead (already async)`)
      return freezr.perms[funcName](...args)
    }
  })


  // Initialize menu elements on load
  if (typeof document !== 'undefined' && freezrMeta.type !== 'extentionPopupException') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        freezr.menu._createElements()
      })
    } else if (document?.body) {
      freezr.menu._createElements()
    }

    // Escape key handler
    document.addEventListener('keydown', (evt) => {
      if (evt.key === 'Escape') {
        const overlay = document.getElementById('freezer_menu_overlay')
        if (overlay && overlay.style.display === 'block') {
          freezr.menu.close()
        }
      }
    })
  }

  // Legacy util aliases
  freezr.utils.addFreezerDialogueElements = () => freezr.menu._createElements()
  freezr.utils.freezrMenuOpen = () => freezr.menu.open()
  freezr.utils.freezrMenuClose = () => freezr.menu.close()

  return freezr
})()

// Legacy freepr alias
const freepr = freezr.promise

// Expose freezr on the global object so module scripts (<script type="module">,
// e.g. bundled React/Vite apps) can see it.
if (typeof window !== 'undefined') window.freezr = freezr

console.log('freezrCoreV2.js loaded - API Version ' + freezr.API_VERSION)
