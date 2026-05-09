// freezr.info - Modern ES6 Module - Public Page Controller
// Handles HTML page rendering for public routes (no-cookie routes)

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import Mustache from '../../../common/misc/mustache.mjs'
import { loadPageHtml, loadDataHtmlAndPage, fileExt } from '../../../adapters/rendering/pageLoader.mjs'
import { sendFailure, sendAuthFailure, sendContent } from '../../../adapters/http/responses.mjs'
import { endsWith, escapeRegex } from '../../../common/helpers/utils.mjs'
import { isSystemApp } from '../../../common/helpers/config.mjs'
import { getOrigIdWithOatRemoved, stripUnifiedPrefixFromPublicid } from '../../../adapters/datastore/dbConnectors/mongo_utils.mjs'

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const SYSTEM_APPS_PATH = path.resolve(__dirname, '../../../freezrsystmapps')

let _appCardTemplateCache = null
const getAppCardTemplate = async () => {
  if (_appCardTemplateCache) return _appCardTemplateCache
  try {
    _appCardTemplateCache = await fs.promises.readFile(
      path.join(SYSTEM_APPS_PATH, 'info.freezr.public/public/appcard.html'), 'utf8'
    )
  } catch (e) {
    _appCardTemplateCache = '<div>{{display_name}} by @{{_data_owner}}</div>'
  }
  return _appCardTemplateCache
}

const renderPublishedAppCard = (flattenedRecord, publicRecord) => {
  const appName = publicRecord.original_record?.publishedAppName || ''
  const logoPublicId = '@' + publicRecord.data_owner + '/app/' + appName + '/logo'
  flattenedRecord._hasLogo = true
  flattenedRecord._logoUrl = logoPublicId
  flattenedRecord._logoLetter = (flattenedRecord.display_name || appName || '?').charAt(0).toUpperCase()
  return flattenedRecord
}

/**
 * Maps a public record to a formatted record with metadata fields
 * 
 * @param {Object} publicRecord - The raw public record from DB
 * @returns {Object} Formatted record with metadata
 */
const flattenPublicRecord = (publicRecord) => {
  // onsole.log('Formatting public record', { publicRecord })

  if (!publicRecord) return {}

  
  const record = { ...(publicRecord.original_record || {}) }
  
  // Add metadata fields
  record._app_name = publicRecord.requestor_app
  record._data_owner = publicRecord.data_owner
  record._permission_name = publicRecord.permission_name
  record._app_table = publicRecord.original_app_table
  record._collection_name = publicRecord.original_app_table?.split('.').slice(1).join('.') || ''
  record._date_modified = publicRecord._date_modified
  record._date_published = publicRecord._date_published || publicRecord._date_created
  record.__date_published = publicRecord._date_published 
    ? new Date(publicRecord._date_published).toLocaleDateString() 
    : 'n/a'
  record._date_created = publicRecord._date_created
  record._original_id = record._id
  record._id = publicRecord._id

  // also format html main page and associated files
  if (publicRecord.isHtmlMainPage) { record.isHtmlMainPage = publicRecord.isHtmlMainPage }
  if (publicRecord.fileStructure) { record.fileStructure = publicRecord.fileStructure }
  if (publicRecord.html_page) { record.html_page = publicRecord.html_page }
  
  // Format date fields for display
  const coreDateList = ['_date_modified', '_date_created', '_date_published']
  coreDateList.forEach(name => {
    if (record[name]) {
      const aDate = new Date(record[name])
      record['_' + name] = aDate.toLocaleString()
    }
  })

  delete record._accessible // old format
  delete record._accessibles
  
  return record
}

/**
 * Gets manifest data from publicManifestsDb (with caching support)
 * 
 * @param {Object} publicManifestsDb - Public manifests database
 * @param {string} dataOwner - The data owner user ID
 * @param {string} appName - The app name
 * @param {Object} manifestCache - Optional cache object to store/retrieve manifests
 * @returns {Promise<Object|null>} Manifest data object with { manifest, cards } or null
 */
const getManifestDataFromDbOrCache = async (publicManifestsDb, dataOwner, appName, manifestCache = null) => {
  const cacheKey = `${dataOwner}:${appName}`
  
  // Check cache first
  if (manifestCache && manifestCache[cacheKey]) {
    return manifestCache[cacheKey]
  }

  if (!publicManifestsDb) {
    return null
  }

  try {
    const manifests = await publicManifestsDb.query(
      { user_id: dataOwner, app_name: appName }, 
      {}
    )
    
    if (manifests && manifests.length > 0) {
      const manifestData = {
        manifest: manifests[0].manifest,
        cards: manifests[0].cards
      }
      
      // Store in cache if provided
      if (manifestCache) {
        manifestCache[cacheKey] = manifestData
      }
      
      return manifestData
    }
  } catch (error) {
    console.error('Error querying publicManifestsDb', { error, dataOwner, appName })
  }

  return null
}

/**
 * Renders card HTML from manifest data and public record
 * 
 * @param {Object} manifestData - Object with { manifest, cards }
 * @param {Object} publicRecord - The raw public record from DB
 * @returns { cardHtml: string, flattenedRecord: Object } Rendered card HTML and flattened record or null
 */
const getFlattenedRecordAndCardHtml = (manifestData, publicRecord) => {
  let cardHtml = null
  const flattenedRecord = flattenPublicRecord(publicRecord)

  if (!manifestData || !manifestData.manifest) {
    return { cardHtml: null, flattenedRecord: null }
  }

  const permissionName = publicRecord.permission_name
  const appName = publicRecord.requestor_app
  const { manifest, cards } = manifestData

  let pcardTemplate = null

  // 1. Check permission-level pcard override
  if (manifest.permissions && cards) {
    const permission = manifest.permissions.find(p => p.name === permissionName)
    if (permission?.pcard && cards[permission.name]) {
      pcardTemplate = cards[permission.name]
    }
  }

  // 2. Fall back to app_table-level pcard
  if (!pcardTemplate && cards) {
    const tableKey = publicRecord.original_app_table?.substring(appName.length + 1)
    if (tableKey && manifest.app_tables?.[tableKey]?.pcard && cards['_table:' + tableKey]) {
      pcardTemplate = cards['_table:' + tableKey]
    }
  }

  if (pcardTemplate) {
    try {
      cardHtml = Mustache.render(pcardTemplate, flattenedRecord)
    } catch (e) {
      console.warn('Error rendering pcard template', { error: e.message, permissionName })
    }
  }

  return { cardHtml, flattenedRecord }
}

/**
 * Gets manifest and renders card HTML from publicManifestsDb
 * Convenience function that combines getManifestDataFromDbOrCache and getFlattenedRecordAndCardHtml
 * 
 * @param {Object} publicManifestsDb - Public manifests database
 * @param {Object} publicRecord - The raw public record from DB
 * @param {Object} manifestCache - Optional cache object to store/retrieve manifests
 * @returns {Promise<Object>} Object with { manifest, cardHtml, flattenedRecord }
 */
const getManifestAndCardHtml = async (publicManifestsDb, publicRecord, manifestCache = null) => {
  const dataOwner = publicRecord.data_owner
  const appName = publicRecord.requestor_app
  
  const manifestData = await getManifestDataFromDbOrCache(publicManifestsDb, dataOwner, appName, manifestCache)
  const { cardHtml, flattenedRecord } = getFlattenedRecordAndCardHtml(manifestData, publicRecord)

  return { 
    manifest: manifestData?.manifest || null, 
    cardHtml, 
    flattenedRecord 
  }
}

/**
 * Shared helper to render a public object page given a publicId
 * Used by both objectPage and catchAllPublicId
 * 
 * @param {string} publicId - The public record ID
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Object} options - Additional options
 * @param {boolean} options.cardOnly - If true, return just the card HTML without page wrapper
 * @param {boolean} options.publicRecord - Provided in case of public files being sent (via prepUserDSsForPublicFiles)
 * @returns {Promise} Renders the page or returns error
 */
const renderPublicObjectPage = async (req, res, publicId, options = {}) => {
  // onsole.log('renderPublicObjectPage controller', { publicId, options, path: req.path })
  const { cardOnly = false } = options
  const publicRecordsDb = res.locals.freezr?.publicRecordsDb
  const publicManifestsDb = res.locals.freezr?.publicManifestsDb

  // 1. Look up the object in publicRecordsDb (middleware or catchAllPublicId may have already looked it up)
  const publicRecord = options.publicRecord || res.locals.freezr?.publicRecord || await publicRecordsDb.read_by_id(publicId)

  // 2. Check if the record isPublic or is accessible via a code (if shared via private link) 
  if (!publicRecord) {
    // onsole.log('publicRecord not found', { publicId, cardOnly })
    if (cardOnly) {
      return res.status(404).send('<div class="freezr_public_error">Record not found</div>')
    }
    return res.redirect(publicOrLoggedInHomePath(req)+ 'error=page with path ' + encodeURIComponent(publicId) + ' not found')
  } else if (!publicRecord.isPublic) { 
    const code = res.locals.reqquery?.code
    if (publicRecord.isHtmlMainPage || res.locals.freezr.appFS) {
      // mainHTMLFiles and files that will be served are published with no isPublic flag as (presumably) the two are mutually exlusive
    } else if (!code || publicRecord.privateLinks.indexOf(code) < 0) {
      // onsole.log('Private link code not found', { code, publicRecord })
      return sendAuthFailure(res, 'wrong code to private link', { function: 'public.objectPage', redirectUrl: publicOrLoggedInHomePath(req) + 'error=page ' + encodeURIComponent(publicId) + ' is not available' }, 404 )
    }
  }

  // 2. Get app info from record
  const appName = publicRecord.requestor_app
  const dataOwner = publicRecord.data_owner

  // 3. Check if this is an (a) HTML main page (full page, not a card) or (b) a file
  if (publicRecord.isHtmlMainPage && !cardOnly) {
    // onsole.log('HTML main page ', publicId)
    // For cardOnly requests on HTML pages, return the record as JSON

    // Serve as a full HTML page with its CSS/JS files
    const fileStructure = publicRecord.fileStructure || {}
    const cssFiles = [] 
    if (Array.isArray(fileStructure.css)) {
      fileStructure.css.forEach(cssObject => {
        // Defensive: legacy fileStructure entries from records published before the
        // shareRecords prefix-stripping fix carry `<owner>__<appTable>__` inside the
        // publicid. Strip it so the rendered <link href> resolves. No-op on clean ids.
        const cssPath = stripUnifiedPrefixFromPublicid(cssObject.publicid)
        // adding '/' as hack so absolute path is used on pageLoad rather than adding userId and appName
        cssFiles.push('/' + cssPath)
      })
    }
    const jsFiles = [] 
    if (Array.isArray(fileStructure.js)) {
      fileStructure.js.forEach(jsObject => {
        const jsPath = stripUnifiedPrefixFromPublicid(jsObject.publicid)
        // adding '/' as hack so absolute path is used on pageLoad rather than adding userId and appName
        jsFiles.push('/' + jsPath)
      })
    }

    let metaTags = ''
    const meta = publicRecord.meta
    if (meta && typeof meta === 'object') {
      if (meta.title) metaTags += `<meta property="og:title" content="${escapeHtml(meta.title)}">`
      if (meta.description) {
        metaTags += `<meta name="description" content="${escapeHtml(meta.description)}">`
        metaTags += `<meta property="og:description" content="${escapeHtml(meta.description)}">`
      }
      if (meta.image) metaTags += `<meta property="og:image" content="${escapeHtml(meta.image)}">`
    }

    const pageOptions = {
      page_title: (meta?.title) || fileStructure.name || publicId,
      page_html: publicRecord.html_page || '',
      page_url: publicId,
      app_name: appName,
      app_display_name: appName,
      app_version: 'N/A',
      css_files: cssFiles,
      script_files: jsFiles,
      meta_tags: metaTags,
      freezr_server_version: res.locals.freezr?.freezrVersion,
      server_name: res.locals.freezr?.serverName,
      user_queried: dataOwner,
      owner_id: dataOwner,
      isPublic: true
    }

    res.locals.freezr.permGiven = true
    return loadPageHtml(res, pageOptions)
  }
  // 3b Check if it is a file
  if (publicRecord && endsWith(publicRecord.original_app_table, '.files') && !cardOnly) {
    // Defensive: legacy public records created on unified-DB Mongo may have stored
    // `original_record_id` as `<owner>__<appTable>__<originalPath>`. Strip the prefix
    // so we resolve the actual blob/file path. New records (post-fix in cepsfepsApiController)
    // already store the unprefixed value, in which case this is a no-op.
    const filePath = getOrigIdWithOatRemoved(
      publicRecord.original_record_id,
      { owner: publicRecord.data_owner, app_table: publicRecord.original_app_table }
    )
    if (!filePath || !res.locals.freezr.appFS) {
      console.warn('File or appfs not found', { filePath, appFS: res.locals.freezr.appFS })
      return sendFailure(res, 'File or appfs not found', 'public.objectPage', 404 )
    }
    // If we do not set the 'Content-Disposition' header, the browser may try to display the zip file contents
    // in the browser window, or handle it using its default behavior for unknown types,
    // rather than prompting the user to download the file as an attachment with a specific filename.
    // Setting these headers ensures the user is prompted to download the file with the correct type and name.
    // Not setting the 'Content-Type' header to 'application/zip' might result in the browser not recognizing
    // the file as a zip archive, potentially leading to incorrect handling (e.g., treating as plain text).
    if (filePath.endsWith('.zip')) {
      const downloadName = publicRecord.original_record?.fileName || path.basename(filePath)
      res.setHeader('Content-Disposition', 'attachment; filename="' + downloadName + '"')
      res.setHeader('Content-Type', 'application/zip')
    }
    res.locals.freezr.permGiven = true
    return res.locals.freezr.appFS.sendUserFile(filePath, res)
  } else {
    // onsole.log('Public file check - not sending file', { publicRecord, publicId, apptable: publicRecord.original_app_table, hadOptions: options.publicRecord ? 'yes' : 'no' , cardOnly, endswithfiles: endsWith(publicRecord.original_app_table, '.files') })
  }
  // ========================== 4 - 10  Regular Object Page or Card rendering ==========================
  // 4. Get manifest and card HTML
  const { manifest, cardHtml, flattenedRecord } = await getManifestAndCardHtml(publicManifestsDb, publicRecord)
  res.locals.freezr.permGiven = true

  // 5. Resolve ppage (full page template) — check permission override first, then app_table
  const tableKey = publicRecord.original_app_table?.substring(appName.length + 1)
  let ppageConfig = null
  if (manifest) {
    const permissionName = publicRecord.permission_name
    if (manifest.permissions) {
      const permission = manifest.permissions.find(p => p.name === permissionName)
      if (permission?.ppage && typeof permission.ppage === 'object') {
        ppageConfig = permission.ppage
      }
    }
    if (!ppageConfig && tableKey && manifest.app_tables?.[tableKey]?.ppage) {
      ppageConfig = manifest.app_tables[tableKey].ppage
    }
  }

  // 6. If ppage exists and not cardOnly, render full page from app's public/ directory
  //    appFS is set up by middleware (prepAppFSForPublicRecord or prepUserDSsForPublicFiles)
  const appFS = res.locals.freezr?.appFS
  if (ppageConfig && !cardOnly && appFS) {
    try {
      const metaTags = ppageConfig.header_map
        ? createHeaderTags(ppageConfig.header_map, [flattenedRecord])
        : ''

      const htmlFile = ppageConfig.html_file?.startsWith('public/')
        ? ppageConfig.html_file
        : 'public/' + ppageConfig.html_file

      const cssFiles = []
      if (ppageConfig.css_files) {
        const cssArray = Array.isArray(ppageConfig.css_files) ? ppageConfig.css_files : [ppageConfig.css_files]
        cssArray.forEach(cssFile => {
          if (fileExt(cssFile) === 'css') {
            const publicPath = cssFile.startsWith('public/') ? cssFile : 'public/' + cssFile
            cssFiles.push(`/public/app/@${dataOwner}/${appName}/${publicPath}`)
          }
        })
      }

      const scriptFiles = []
      if (ppageConfig.script_files) {
        const scriptArray = Array.isArray(ppageConfig.script_files) ? ppageConfig.script_files : [ppageConfig.script_files]
        scriptArray.forEach(jsFile => {
          if (fileExt(jsFile) === 'js') {
            const publicPath = jsFile.startsWith('public/') ? jsFile : 'public/' + jsFile
            scriptFiles.push(`/public/app/@${dataOwner}/${appName}/${publicPath}`)
          }
        })
      }

      const recordTitle = flattenedRecord[ppageConfig.header_map?.title?.field_name] || ''
      const pageTitle = (recordTitle || ppageConfig.page_title || 'Public Record') +
        ' - ' + (manifest?.display_name || appName)

      const pageOptions = {
        page_title: pageTitle,
        page_url: htmlFile,
        css_files: cssFiles,
        script_files: scriptFiles,
        meta_tags: metaTags,
        queryresults: flattenedRecord,
        app_name: appName,
        app_display_name: manifest?.display_name || appName,
        app_version: manifest?.version || 'N/A',
        faviconUrl: `/public/app/@${dataOwner}/${appName}/logo`,
        freezr_server_version: res.locals.freezr?.freezrVersion,
        server_name: res.locals.freezr?.serverName,
        user_queried: dataOwner,
        owner_id: dataOwner,
        isPublic: true
      }

      return loadDataHtmlAndPage(appFS, res, pageOptions)
    } catch (err) {
      console.warn('Error rendering ppage, falling back to card layout', { error: err.message, appName, tableKey })
    }
  }

  // 7. Render the inner content (use cardHtml if available, otherwise generate generic)
  const manifestMissing = !manifest
  const innerHtml = cardHtml || generateGenericCardHtml(flattenedRecord, manifestMissing)

  // 8. If cardOnly, just return the card HTML without any wrapper
  if (cardOnly) {
    return sendContent(res, innerHtml)
  }

  // 9. Wrap in freezr texture layout
  const pageHtml = await tranformToCardLayout(innerHtml, flattenedRecord)

  // 10. Build page options and serve with html_skeleton_public.html wrapper
  const pageOptions = {
    page_title: 'Public Record - freezr.info from ' + dataOwner + ' using ' + (manifest?.display_name || appName),
    page_html: pageHtml,
    page_url: publicId,
    app_name: appName,
    app_display_name: manifest?.display_name || appName,
    app_version: manifest?.version || 'N/A',
    css_files: ['/app/info.freezr.public/public/objectPage.css'],
    script_files: ['/app/info.freezr.public/public/objectPage.js'],
    faviconUrl: `/public/app/@${dataOwner}/${appName}/logo`,
    freezr_server_version: res.locals.freezr?.freezrVersion,
    server_name: res.locals.freezr?.serverName,
    user_queried: dataOwner,
    owner_id: dataOwner,
    isPublic: true
  }

  return loadPageHtml(res, pageOptions)
}

/**
 * Creates public page controller with dependency injection 
 * 
 * @param {Object} dsManager - Data store manager
 * @param {Object} freezrPrefs - Freezr preferences
 * @returns {Object} Controller object with handler methods
 */
export const createPublicPageController = () => {
  return {
    /**
     * GET /public/objectcard/:publicid
     * GET /public/objectcard/@:user_id/:app_table/:data_object_id
     * Returns just the card HTML without any page wrapper
     * Useful for embedding or AJAX loading
     */
    objectCard: async (req, res) => {
      const flogger = res.locals.flogger

      const publicRecordsDb = res.locals.freezr?.publicRecordsDb
      if (!publicRecordsDb) {
        flogger?.error('missingSystemDb', { function: 'public.objectCard' })
        return res.status(500).send('<div class="freezr_public_error">Database not available</div>')
      }

      try {
        // Build public ID from params
        let publicId
        if (req.params.publicid) {
          publicId = req.params.publicid
        } else {
          const userId = req.params.user_id?.toLowerCase()
          const appTable = req.params.app_table?.toLowerCase()
          const dataObjectId = req.params.data_object_id
          
          if (!userId || !appTable || !dataObjectId) {
            flogger?.error('Missing parameters', { function: 'public.objectCard', missingParams: { userId: Boolean(userId), appTable: Boolean(appTable), dataObjectId: Boolean(dataObjectId) } })
            return res.status(400).send('<div class="freezr_public_error">Missing parameters</div>')
          }
          
          publicId = `@${userId}/${appTable}/${dataObjectId}`
        }
        res.locals.freezr.permGiven = true

        // Render using shared helper with cardOnly option
        return renderPublicObjectPage(req, res, publicId, { cardOnly: true })

      } catch (error) {
        flogger?.error(error.message, { function: 'public.objectCard' })
        return res.status(500).send('<div class="freezr_public_error">Server error</div>')
      }
    },

    /**
     * GET /public/oauth/:getwhat
     */
    oauthActions: async (req, res) => {
      const getWhat = req.params.getwhat
      const manifests = {
        oauth_start_oauth: {
          page_title: 'freezr.info - o-auth - starting process',
          css_files: ['/app/info.freezr.public/public/freezr_style.css'],
          page_url: 'oauth_start_oauth.html',
          app_name: 'info.freezr.public',
          script_files: ['public/oauth_start_oauth.js'],
          modules: []
        },

        oauth_validate_page: {
          page_title: 'freezr.info - o-auth validating page',
          css_files: ['/app/info.freezr.public/public/freezr_style.css'],
          page_url: 'oauth_validate_page.html',
          app_name: 'info.freezr.public',
          script_files: ['/app/info.freezr.public/public/oauth_validate_page.js'],
          modules: []
        }
      }
      const manifest = manifests[getWhat]
      if (!manifest) {
        return sendFailure(res, 'Invalid OAuth action: ' + getWhat, { function: 'public.oauthActions' }, 400 )
      }
      if (!res.locals.freezr) res.locals.freezr = {}
      res.locals.freezr.permGiven = true

      try {
        manifest.page_html = await fs.promises.readFile(path.join(__dirname, '../../../freezrsystmapps/info.freezr.public/public/' + manifest.page_url), 'utf8')
      } catch (err) {
        console.error('err reading oauth page file', manifest.page_url, err)
        return sendFailure(res, 'err reading oauth page file', { function: 'public.oauthActions' }, 500 )
      }
      return loadPageHtml(res, manifest)
    },

    /**
     * GET /public
     * Renders the public feed page showing all public records
     * Query params: owner, app, search, skip, count
     */
    feedPage: async (req, res) => {
      const flogger = res.locals.flogger
      const publicRecordsDb = res.locals.freezr?.publicRecordsDb
      const publicManifestsDb = res.locals.freezr?.publicManifestsDb

      if (!publicRecordsDb) {
        flogger?.error('missingSystemDb', { function: 'public.feedPage' })
        return res.status(500).send('<div class="freezr_public_error">Database not available</div>')
      }

      try {
        // Parse query parameters
        const owner = req.query.owner || req.query.user
        const app = req.query.app
        const search = req.query.search || req.query.q
        const skip = parseInt(req.query.skip) || 0
        const count = parseInt(req.query.count) || 20
        const error = req.query.error
        const message = req.query.message

        // Build query
        // doNotList should be false, null, or not exist (anything but true)
        const queryParams = { 
          isPublic: true, 
          doNotList: { $ne: true } 
        }
        
        if (owner) {
          queryParams.data_owner = owner.toLowerCase()
        }
        if (app) {
          queryParams.requestor_app = app.toLowerCase()
        }
        
        // Handle search with multiple terms
        let searchConditions = null
        if (search) {
          const searchTerm = decodeURIComponent(search).trim().toLowerCase()
          if (searchTerm.indexOf(' ') < 0) {
            queryParams.search_words = new RegExp(escapeRegex(searchTerm))
          } else {
            const theAnds = [{ ...queryParams }]
            const searchTerms = searchTerm.split(' ').filter(term => term.length > 0)
            searchTerms.forEach(term => {
              theAnds.push({ search_words: new RegExp(escapeRegex(term)) })
            })
            searchConditions = { $and: theAnds }
          }
        }

        const finalQuery = searchConditions || queryParams
        const sort = { _date_published: -1 }

        // Execute query
        const results = await publicRecordsDb.query(finalQuery, { sort, count: count + 1, skip })

        // Check if there are more results
        const hasMore = results && results.length > count
        const displayResults = hasMore ? results.slice(0, count) : (results || [])

        // Get cards for each result using cached manifests
        const formattedResults = []
        const manifestCache = {}

        for (const publicRecord of displayResults) {
          let cardHtml, flattenedRecord

          if (publicRecord.requestor_app === 'info.freezr.creator' && publicRecord.permission_name === 'publish_app' && !publicRecord.original_record?.isLogo) {
            flattenedRecord = flattenPublicRecord(publicRecord)
            renderPublishedAppCard(flattenedRecord, publicRecord)
            const appCardTpl = await getAppCardTemplate()
            try {
              cardHtml = Mustache.render(appCardTpl, flattenedRecord)
            } catch (e) {
              cardHtml = null
            }
          } else {
            const result = await getManifestAndCardHtml(publicManifestsDb, publicRecord, manifestCache)
            cardHtml = result.cardHtml
            flattenedRecord = result.flattenedRecord
          }

          if (cardHtml) {
            flattenedRecord._card = cardHtml
          }

          if (!flattenedRecord._card) {
            const hasDisplayableContent = flattenedRecord.title || flattenedRecord.description || 
              flattenedRecord.text || flattenedRecord.content || flattenedRecord.body || flattenedRecord.message
            
            if (!hasDisplayableContent) {
              // Create a preview of the record data (exclude metadata fields)
              const previewData = { }
              const metaData = {}
              Object.keys(flattenedRecord).forEach(key => {
                if (!key.startsWith('_')) {
                  previewData[key] = flattenedRecord[key]
                } else {
                  metaData[key] = flattenedRecord[key]
                }
              })
              if (Object.keys(previewData).length > 0) {
                flattenedRecord._json_preview = JSON.stringify(previewData, null, 2)
              }
            }
          }

          formattedResults.push(flattenedRecord)
        }

        // Build filter description
        let filterDescription = ''
        if (owner) filterDescription += `User: ${owner} `
        if (app) filterDescription += `App: ${app} `
        if (search) filterDescription += `Search: "${search}"`

        // Build current search for display
        let currentSearch = ''
        if (search) currentSearch = search
        if (owner) currentSearch += (currentSearch ? ' ' : '') + `owner:${owner}`
        if (app) currentSearch += (currentSearch ? ' ' : '') + `app:${app}`

        // Build next URL for pagination
        const nextParams = new URLSearchParams()
        if (owner) nextParams.set('owner', owner)
        if (app) nextParams.set('app', app)
        if (search) nextParams.set('search', search)
        nextParams.set('skip', String(skip + count))
        const nextUrl = nextParams.toString()

        // Build page data for Mustache
        const pageData = {
          results: formattedResults,
          result_count: formattedResults.length,
          total_count: skip + formattedResults.length + (hasMore ? '+' : ''),
          has_more: hasMore,
          next_url: nextUrl,
          current_search: currentSearch,
          filter_description: filterDescription.trim() || null,
          error: error || null,
          message: message || null
        }

        // Read and render the HTML template
        let htmlContent
        try {
          const templatePath = path.join(SYSTEM_APPS_PATH, 'info.freezr.public/public/publicFeed.html')
          htmlContent = await fs.promises.readFile(templatePath, 'utf8')
        } catch (err) {
          return sendFailure(res, err, { function: 'public.feedPage.template.readFile' }, 500 )
        }

        // Render with Mustache
        const pageHtml = Mustache.render(htmlContent, pageData)

        // Build page options
        const options = {
          page_title: 'Public Feed - freezr.info',
          page_html: pageHtml,
          page_url: '/public',
          app_name: 'info.freezr.public',
          app_display_name: 'freezr Public Feed',
          app_version: 'N/A',
          css_files: ['/app/info.freezr.public/public/publicFeed.css'],
          script_files: [
            '/app/info.freezr.public/public/publicFeed.js'
          ],
          freezr_server_version: res.locals.freezr?.freezrVersion,
          server_name: res.locals.freezr?.serverName,
          isPublic: true
        }

        res.locals.freezr.permGiven = true
        return loadPageHtml(res, options)

      } catch (error) {
        return sendFailure(res, error, { function: 'public.feedPage', redirectUrl: '/public/notfound?error=couldNotGetPublicPage ', path: '/public' }, 500 )
      }
    },

    /**
     * GET /public/rss
     * Generates an RSS feed of public records
     * Query params: owner, app, search, skip, count (same as feedPage)
     */
    rssFeed: async (req, res) => {
      const flogger = res.locals.flogger
      const publicRecordsDb = res.locals.freezr?.publicRecordsDb
      const publicManifestsDb = res.locals.freezr?.publicManifestsDb

      if (!publicRecordsDb) {
        flogger?.error('missingSystemDb', { function: 'public.rssFeed' })
        return res.status(500).type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?><error>Database not available</error>')
      }

      try {
        // Parse query parameters (same as feedPage)
        const owner = req.query.owner || req.query.user
        const app = req.query.app
        const search = req.query.search || req.query.q
        const skip = parseInt(req.query.skip) || 0
        const count = parseInt(req.query.count) || 50 // Default to 50 for RSS

        // Build query (same logic as feedPage)
        const queryParams = { isPublic: true }
        
        if (owner) {
          queryParams.data_owner = owner.toLowerCase()
        }
        if (app) {
          queryParams.requestor_app = app.toLowerCase()
        }
        
        // Handle search with multiple terms
        let searchConditions = null
        if (search) {
          const searchTerm = decodeURIComponent(search).trim().toLowerCase()
          if (searchTerm.indexOf(' ') < 0) {
            queryParams.search_words = new RegExp(escapeRegex(searchTerm))
          } else {
            const theAnds = [{ ...queryParams }]
            const searchTerms = searchTerm.split(' ').filter(term => term.length > 0)
            searchTerms.forEach(term => {
              theAnds.push({ search_words: new RegExp(escapeRegex(term)) })
            })
            searchConditions = { $and: theAnds }
          }
        }

        const finalQuery = searchConditions || queryParams
        const sort = { _date_published: -1 }

        // Execute query
        const results = await publicRecordsDb.query(finalQuery, { sort, count, skip })

        // Format results for RSS
        const rssItems = []

        const serverName = res.locals.freezr?.serverName || (req.protocol + '://' + req.get('host'))

        for (const publicRecord of (results || [])) {
          const flattenedRecord = flattenPublicRecord(publicRecord)
          
          // Build RSS item
          const rssItem = {
            title: flattenedRecord.title || flattenedRecord.name || flattenedRecord._app_name || 'Untitled',
            link: `${serverName}/public/objectpage/${publicRecord._id}`,
            description: '',
            pubDate: null
          }

          // Extract description from common fields
          const descriptionFields = ['description', 'text', 'content', 'body', 'message', 'summary']
          for (const field of descriptionFields) {
            if (flattenedRecord[field]) {
              // Strip HTML tags and limit length for RSS
              // Mustache will handle XML escaping automatically
              let desc = String(flattenedRecord[field])
              desc = desc.replace(/<[^>]*>/g, '') // Remove HTML tags
              desc = desc.substring(0, 500) // Limit length
              if (desc.length === 500) desc += '...'
              rssItem.description = desc
              break
            }
          }

          // If no description found, create one from available data
          if (!rssItem.description) {
            const previewData = {}
            Object.keys(flattenedRecord).forEach(key => {
              if (!key.startsWith('_') && key !== 'title' && key !== 'name') {
                previewData[key] = flattenedRecord[key]
              }
            })
            if (Object.keys(previewData).length > 0) {
              rssItem.description = JSON.stringify(previewData, null, 2).substring(0, 500)
            } else {
              rssItem.description = `Public record from ${flattenedRecord._data_owner} using ${flattenedRecord._app_name}`
            }
          }

          // Format pubDate (RFC 822 format for RSS)
          if (flattenedRecord._date_published) {
            const pubDate = new Date(flattenedRecord._date_published)
            rssItem.pubDate = pubDate.toUTCString()
          } else if (flattenedRecord._date_created) {
            const pubDate = new Date(flattenedRecord._date_created)
            rssItem.pubDate = pubDate.toUTCString()
          }

          // Extract image if available
          if (flattenedRecord.image || flattenedRecord.imgurl || flattenedRecord.photo) {
            const imgUrl = flattenedRecord.image || flattenedRecord.imgurl || flattenedRecord.photo
            if (typeof imgUrl === 'string' && (imgUrl.startsWith('http') || imgUrl.startsWith('/'))) {
              rssItem.imgurl = imgUrl.startsWith('http') ? imgUrl : `${serverName}${imgUrl}`
              rssItem.imgtitle = rssItem.title
            }
          }

          rssItems.push(rssItem)
        }

        // Build page title
        let pageTitle = 'Public Feed - freezr.info'
        if (owner) pageTitle += ` - ${owner}`
        if (app) pageTitle += ` - ${app}`
        if (search) pageTitle += ` - "${search}"`

        // Read RSS template
        const rssTemplatePath = path.join(SYSTEM_APPS_PATH, 'info.freezr.public/public/rss.xml')
        let rssTemplate
        try {
          rssTemplate = await fs.promises.readFile(rssTemplatePath, 'utf8')
        } catch (err) {
          flogger?.error('Error reading RSS template', { function: 'public.rssFeed', error: err })
          return res.status(500).type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?><error>RSS template not found</error>')
        }

        // Render RSS template with Mustache
        const rssData = {
          page_title: pageTitle,
          server_name: serverName,
          results: rssItems
        }
        const rssContent = Mustache.render(rssTemplate, rssData)

        res.locals.freezr.permGiven = true
        sendContent(res, rssContent, 'application/xml')

      } catch (error) {
        flogger?.error('systemError', { function: 'public.rssFeed', error })
        return res.status(500).type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?><error>System Error</error>')
      }
    },

    pageNotFound: async (req, res) => {
      let htmlContent
      try {
        const templatePath = path.join(SYSTEM_APPS_PATH, 'info.freezr.public/public/pageNotFound.html')
        htmlContent = await fs.promises.readFile(templatePath, 'utf8')
      } catch (err) {
        return sendFailure(res, err, { function: 'public.feedPage.template.readFile' }, 500 )
      }


      // Build page options
      const options = {
        page_title: 'Page Not Found - freezr.info',
        page_html: htmlContent,
        page_url: '/notfound',
        app_name: 'info.freezr.public',
        app_display_name: 'freezr Page Not Found',
        app_version: 'N/A',
        css_files: ['/app/info.freezr.public/public/freezr_style.css'],
        script_files: ['/app/info.freezr.public/public/pageNotFound.js'],
        freezr_server_version: res.locals.freezr?.freezrVersion,
        server_name: res.locals.freezr?.serverName,
        isPublic: true
      }

      if (!res.locals.freezr) res.locals.freezr = {}
      res.locals.freezr.permGiven = true
      return loadPageHtml(res, options)
    },

    /**
     * Catch-all handler for legacy public ID routes
     * Handles routes like /@user/app.table/objectId
     * Checks if the path exists as a public ID and renders the object page
     */
    publicAppsPage: async (req, res) => {
      try {
        let htmlContent
        try {
          const templatePath = path.join(SYSTEM_APPS_PATH, 'info.freezr.public/public/publicApps.html')
          htmlContent = await fs.promises.readFile(templatePath, 'utf8')
        } catch (err) {
          return sendFailure(res, err, { function: 'public.publicAppsPage.template' }, 500)
        }

        const options = {
          page_title: 'Published Apps - freezr',
          page_html: htmlContent,
          page_url: '/publicapps',
          app_name: 'info.freezr.public',
          app_display_name: 'freezr Published Apps',
          app_version: 'N/A',
          css_files: [
            '/app/info.freezr.public/public/publicFeed.css',
            '/app/info.freezr.public/public/publicApps.css'
          ],
          script_files: [
            '/app/info.freezr.public/public/publicApps.js'
          ],
          freezr_server_version: res.locals.freezr?.freezrVersion,
          server_name: res.locals.freezr?.serverName,
          isPublic: true
        }

        res.locals.freezr.permGiven = true
        return loadPageHtml(res, options)
      } catch (error) {
        console.error('Error in publicAppsPage:', error)
        return sendFailure(res, error, { function: 'public.publicAppsPage' }, 500)
      }
    },

    publicAppCard: async (req, res) => {
      try {
        const publicRecordsDb = res.locals.freezr?.publicRecordsDb
        if (!publicRecordsDb) return sendFailure(res, 'No public records DB', { function: 'public.publicAppCard' }, 500)

        const userId = req.params?.user_id
        const appName = req.params?.app_name
        if (!userId || !appName) return sendFailure(res, 'user_id and app_name required', { function: 'public.publicAppCard' }, 400)

        const publicId = '@' + userId + '/app/' + appName
        const record = await publicRecordsDb.read_by_id(publicId)
        if (!record) return sendFailure(res, 'App not found or not public', { function: 'public.publicAppCard' }, 404)

        const flat = flattenPublicRecord(record)
        flat._hasLogo = true
        flat._logoUrl = publicId + '/logo'
        flat._logoLetter = (flat.display_name || flat.publishedAppName || '?').charAt(0).toUpperCase()

        let appCardTemplate
        try {
          const templatePath = path.join(SYSTEM_APPS_PATH, 'info.freezr.public/public/appcard.html')
          appCardTemplate = await fs.promises.readFile(templatePath, 'utf8')
        } catch (e) {
          appCardTemplate = '<div>{{display_name}} by @{{_data_owner}}</div>'
        }

        const cardHtml = Mustache.render(appCardTemplate, flat)
        return sendContent(res, cardHtml)
      } catch (error) {
        console.error('Error in publicAppCard:', error)
        return sendFailure(res, error, { function: 'public.publicAppCard' }, 500)
      }
    },

    publicAppDownload: async (req, res) => {
      try {
        const publicRecordsDb = res.locals.freezr?.publicRecordsDb
        if (!publicRecordsDb) return sendFailure(res, 'No public records DB', { function: 'public.publicAppDownload' }, 500)

        const userId = req.params?.user_id
        const appName = req.params?.app_name
        if (!userId || !appName) return sendFailure(res, 'user_id and app_name required', { function: 'public.publicAppDownload' }, 400)

        const publicId = '@' + userId + '/app/' + appName
        const record = await publicRecordsDb.read_by_id(publicId)
        if (!record) return sendFailure(res, 'App not found or not public', { function: 'public.publicAppDownload' }, 404)

        return res.redirect('/' + publicId)
      } catch (error) {
        console.error('Error in publicAppDownload:', error)
        return sendFailure(res, error, { function: 'public.publicAppDownload' }, 500)
      }
    },

    catchAllPublicId: async (req, res) => {
      const flogger = res.locals.flogger
      const publicRecordsDb = res.locals.freezr?.publicRecordsDb

      if (req.params.app_name && isSystemApp(req.params.app_name)) {
        // return res.status(404).end()
        return sendFailure(res, 'missingSystemDb', { function: 'public.catchAllPublicId', redirectUrl: '/public?error=no cpulc id in system aps' }, 404 )
      }

      if (res.locals.freezr.appFS && res.locals.freezr.publicRecord) {
        // onsole.log('Catch-all public ID handler', { publicId: res.locals.freezr.publicid, url: req.originalUrl })
        return renderPublicObjectPage(req, res, res.locals.freezr.publicid, { publicRecord: res.locals.freezr.publicRecord })
      } 

      if (!publicRecordsDb) {
        return sendFailure(res, 'missingSystemDb', { function: 'public.catchAllPublicId', redirectUrl: '/public?error=Database is Unavailable' }, 500 )
      }

      try {
        // Build public ID from the path (remove leading slash)
        const publicId = req.path.startsWith('/') ? req.path.substring(1) : req.path

        // Render using shared helper
        return renderPublicObjectPage(req, res, publicId, { redirectOnError: true })

      } catch (error) {
        flogger?.error('Error in catch-all public ID handler', { error, path: req.path })
        console.error('❌ Error in catchAllPublicId:', error)
        return res.redirect(publicOrLoggedInHomePath(req) + '?error=server_error')
      }
    }
  }
}

// Cache for the freezr layout template (loaded once)
let freezrLayoutTemplateCache = null

/**
 * Wraps inner HTML content in the standard freezr texture layout
 * Uses the genericFreezrLayout.html template with Mustache
 * CSS classes are defined in freezr_style.css
 * 
 * @param {string} innerHtml - The inner HTML content to wrap
 * @param {Object} record - The formatted record (for metadata display)
 * @returns {Promise<string>} HTML string with freezr layout wrapper
 */
const tranformToCardLayout = async (innerHtml, record) => {
  // Template data for Mustache rendering
  const appName = record?._app_name || 'Unknown App'
  const dataOwner = record?._data_owner || 'Unknown'
  const templateData = {
    ...record,
    innerHtml,
    _app_name: escapeHtml(appName),
    _data_owner: escapeHtml(dataOwner)
  }
  
  // Load template from file (cached after first load)
  if (!freezrLayoutTemplateCache) {
    const templatePath = path.join(SYSTEM_APPS_PATH, 'info.freezr.public/public/genericFreezrLayout.html')
    freezrLayoutTemplateCache = await fs.promises.readFile(templatePath, 'utf8')
  }
  
  return Mustache.render(freezrLayoutTemplateCache, templateData)
}

/**
 * Generate generic card HTML for a record when no pcard template exists
 * Shows a JSON dump of the object (without the outer freezr wrapper)
 * CSS classes are defined in freezr_style.css
 * 
 * @param {Object} record - The formatted record
 * @param {boolean} manifestMissing - Whether the manifest was missing
 * @returns {string} HTML string for the card content
 */
const generateGenericCardHtml = (record, manifestMissing = false) => {
  const noteText = manifestMissing 
    ? 'Manifest not available - showing raw data' 
    : 'The developer has not defined a display format for this record.'
  
  return `
    <div class="freezr_public_note">${noteText}</div>
    <div class="freezr_public_json">
      <pre>${escapeHtml(JSON.stringify(record, null, 2))}</pre>
    </div>
    `
}

/**
 * Escape HTML special characters
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
const escapeHtml = (str) => {
  if (!str) return ''
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * Create meta tags for page headers
 * 
 * @param {Object} headerMap - Map of header names to field mappings
 * @param {Array} results - Array of records (uses first one for field values)
 * @returns {string} HTML meta tags string
 */
const createHeaderTags = (headerMap, results) => {
  let headerText = results?.[0]?._app_name 
    ? `<meta name="application-name" content="${escapeHtml(results[0]._app_name)} - a freezr app">` 
    : ''
  
  if (headerMap) {
    Object.keys(headerMap).forEach(header => {
      const keyObj = headerMap[header]
      let content = null
      if (keyObj.field_name && results?.[0]?.[keyObj.field_name]) {
        content = (keyObj.text ? (keyObj.text + ' ') : '') + results[0][keyObj.field_name]
      } else if (keyObj.text) {
        content = keyObj.text
      }
      if (content) {
        // Use 'property' for Open Graph tags, 'name' for everything else
        const attr = header.startsWith('og:') ? 'property' : 'name'
        headerText += `<meta ${attr}="${header}" content="${escapeHtml(content)}">`
      }
    })
  }
  
  return headerText
}

const publicOrLoggedInHomePath = function (req) {
  // not used due to redirect sec-fetch errors
  // if (req.session?.logged_in_user_id) {
  //   return '/account/home?'
  // } else {
  //   return '/public?'
  // }
  return '/public/notfound?'
}

export default { createPublicPageController }

