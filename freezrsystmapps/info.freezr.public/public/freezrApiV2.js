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
      '/ceps/ping', '/acctapi/login', 'public/query',
      '/register/api/checkresource', '/register/api/firstSetUp', '/register/api/newselfreg', 
      '/oauth/token', '/oauth/get_new_state', '/oauth/validate_state'
    ]
    const coreUrl = url.split('?')[0]
    
    const accessToken = options?.appToken || 
                       (freezr.app.isWebBased ? freezr.utils.getCookie('app_token_' + freezrMeta.userId) : freezrMeta.appToken)

    if (!accessToken && !PATHS_WITHOUT_TOKEN.includes(coreUrl)) {
      const error = new Error('Need to obtain an app token before sending data to ' + url)
      error.status = 401
      throw error
    }

    // Build headers
    const headers = {
      Authorization: 'Bearer ' + accessToken
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
    console.log('apiRequest', { method, url, headers })
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
        
        if (response.status === 401 && !freezr.app.isWebBased) {
          freezr.app.offlineCredentialsExpired = true
        }
        
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
        if (!options._entity) throw new Error('need to provide _entity for feps update')
        const url = (options.host || '') + '/feps/update/' + appTable + '/' + id + '?replaceAllFields=true'
        return await apiRequest('PUT', url, data, writeOptions)
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

    async upload(file, options = {}) {
      if (!file) {
        throw new Error('No file to upload')
      }

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
      
      options.requestee_app = options.requestee_app || freezrMeta.appName
      options.permission_name = options.permission_name || 'self'
      options.requestee_user_id = options.requestee_user_id || freezrMeta.userId
      
      if (fileId.startsWith('/')) fileId = fileId.slice(1)
      
      return `/feps/userfiles/${options.requestee_app}/${options.requestee_user_id}/${fileId}` +
             `?permission_name=${options.permission_name}`
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
        // to access a record from its public id pass { publicid }
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
        // fileId is the id of the file when granting and the public id when ungranting
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
        } else {
          options.query_criteria = { publicid: fileId }
        }

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
        const response = await apiRequest('GET', '/ceps/ping', null, options)
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

      async getFileToken (fileId, options, callback) {
        // WIP - to be completed 2019
        // check if exists - if not, check permissions and send back a token and keep a list of tokens
        // return token
        if (!options) options = {}
        options.requestee_user_id = options.requestee_user_id || freezrMeta.userId
        options.requestee_app = options.requestee_app || freezrMeta.appName
        options.permission_name = options.permission_name || 'self'
      
        const url = '/feps/getuserfiletoken' + '/' + (options.permission_name || 'self') + '/' + options.requestee_app + '/' + options.requestee_user_id + '/' + fileId
        try {
          const resp = await apiRequest('GET', url, null)
          const token = (resp && resp.fileToken) ? resp.fileToken : null
          return token
        } catch (err) {
          console.warn('error in getting token ', err)
          return null
        }
      },

      refreshFileTokens(eltag = 'IMG', attr = 'src') {
        const pictList = document.getElementsByTagName(eltag)
        if (pictList.length > 0) {
          const host = window.location.href.slice(0, (window.location.href.slice(8).indexOf('/') + 8))
          const fepspath = '/feps/userfiles/'
          for (let i = 0; i < pictList.length; i++) {
            if (freezr.utils.startsWith(pictList[i][attr], host + fepspath)) {
              const parts = pictList[i][attr].split('/')
              const pictId = parts.slice(7).join('/').split('?')[0]
              freezr.utils.setFilePath(pictList[i], attr, pictId) //, {'permission_name':'picts_share'}
            }
          }
        }
      },

      async setFilePath (imgEl, attr, fileId, options) {
        if (!options) options = {}
        options.requestee_app = options.requestee_app || freezrMeta.appName
        options.permission_name = options.permission_name || 'self'
        options.requestee_user_id = options.requestee_user_id || freezrMeta.userId
        if (!fileId) return null
        if (freezr.utils.startsWith(fileId, '/')) fileId = fileId.slice(1)
        const fileToken = await freezr.utils.getFileToken(fileId, options)
        if (!fileToken) return null
        imgEl[attr] = '/feps/userfiles/' + options.requestee_app + '/' + options.requestee_user_id + '/' + fileId + '?fileToken=' + fileToken + (options.permission_name ? ('&permission_name=' + options.permission_name) : '')
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
          
          html += `<div class="freezer_menu_button" onclick="window.location.href='/account/app/settings/${freezrMeta.appName}'" `
          html += 'style="margin-top: 10px; font-size: 10px; text-align: center;">Settings</div>'
          html += '</div>'
        } else if (window.location.pathname.indexOf('/apps') === 0) {
          html += '<div style="padding: 10px 15px; border-top: 1px solid #ddd;">'
          html += `<div class="freezer_menu_button" onclick="window.location.href='/account/app/settings/${freezrMeta.appName}'" `
          html += 'style="font-size: 10px; text-align: center;">Settings</div>'
          html += '</div>'
        }

        contentDiv.innerHTML = html
      },

      _createElements() {
        // Create menu button
        const imgUrl = freezr.app.isWebBased 
          ? '/app/info.freezr.public/public/static/freezer_log_top.png'
          : '../freezr/static/freezer_log_top.png'
        const menuButton = document.createElement('img')
        menuButton.id = 'freezer_img_button'
        menuButton.src = imgUrl
        if (!this.options.showButton) menuButton.style.display = 'none'
        menuButton.onclick = () => this.open()
        document.body.appendChild(menuButton)

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

        const imgCloseBtn = document.createElement('img')
        imgCloseBtn.src = imgUrl
        imgCloseBtn.id = 'freezer_menu_inner_close_img'
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

        // Content area for permissions
        const content = document.createElement('div')
        content.id = 'freezer_menu_content'
        menu.appendChild(content)

        document.body.appendChild(menu)
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
        callbackToAsync(freezr.update, [collectionOrAppTable, data, options, callback])
      } else {
        if (!callback) return freezr.create(collectionOrAppTable, data, options)
        callbackToAsync(freezr.create, [collectionOrAppTable, data, options, callback])
      }
    },

    write(data, ...optionsAndCallback) {
      console.warn('DEPRECATED: freezr.feps.write() - Use freezr.create() instead')
      return freezr.ceps.create(data, ...optionsAndCallback)
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
  if (typeof document !== 'undefined') {
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

console.log('freezrCoreV2.js loaded - API Version ' + freezr.API_VERSION)
