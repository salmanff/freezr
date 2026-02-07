// startupSequence.mjs - Main server startup sequence

import dns from 'dns'
import os from 'os'
import { promisify } from 'util'

// Config and services
import DS_MANAGER from '../../adapters/datastore/dsManager.mjs'
import { DEFAULT_PREFS, getOrSetPrefs, checkServerVersionAndUpdate } from '../../features/admin/services/adminConfigService.mjs'
import { PARAMS_OAC, USER_DB_OAC } from '../helpers/config.mjs'
import { checkDB, checkFS, tryGettingEnvFromautoConfig } from '../../adapters/datastore/environmentDefaults.mjs'

// Logging and auth
import { createLogManager, BACKUP_PATTERNS, FLogger } from '../loganalytics/logging.mjs'
import { createLogSummarizer } from '../loganalytics/summarization.mjs'
import { AuthRateLimiter } from '../../middleware/auth/authRateLimiter.mjs'

// Routes
import { mountAllModernRoutes } from '../../froutes/index.mjs'

// Startup helpers
import { consoleFlogger } from './consoleFlogger.mjs'
import { getPublicUrlFromPrefs, newFreezrSecrets, addAppUses } from './startupHelpers.mjs'
import { createRequestLoggerMiddleware, createAddConsoleFloggerMiddleware } from '../../middleware/requestLogger.mjs'
import { AUTH_RATE_LIMIT } from './constants.mjs'

const dnsLookup = promisify(dns.lookup)

/**
 * Main startup sequence for the freezr server
 * @param {Express} app - Express application instance
 * @param {string} VERSION - Server version string
 * @returns {Promise<Object>} - All initialized state
 */
export async function startupSequence (app, VERSION) {
  let lastStartupStep = null
  let flogger = consoleFlogger  // Start with console fallback

  // State to be returned
  let dsManager = null
  let freezrPrefs = {}
  let fradminAdminFs = null
  let logManager = null
  let logSummarizer = null
  let coreLogger = null
  let authRateLimiter = null

  const freezrStatus = {
    can_write_to_user_folder: false,
    can_read_write_to_db: false
  }

  try {
    // Step 1: Initialize dsManager
    lastStartupStep = 'init_dsManager'
    flogger.info('🔄 [STARTUP] Initializing dsManager...')
    dsManager = new DS_MANAGER()

    // Step 2: Detect environment parameters
    lastStartupStep = 'detectparams'
    flogger.info('🔄 [STARTUP] Detecting params...')
    const detectedParams = await tryGettingEnvFromautoConfig({ freezrPrefs: DEFAULT_PREFS })

    // Step 3: Set environment and check DB
    lastStartupStep = 'setenv'
    flogger.info('🔄 [STARTUP] Setting env and checking DB...')
    
    if (detectedParams.envOnFile?.freezrIsSetup) {
      dsManager.setSystemUserDS('fradmin', {
        fsParams: detectedParams.envOnFile.fsParams,
        dbParams: detectedParams.envOnFile.dbParams
      })
      dsManager.initialEnvironment = detectedParams.envOnFile
    } else {
      dsManager.initialEnvironment = detectedParams.autoConfig
    }
    
    dsManager.freezrIsSetup = dsManager.initialEnvironment?.freezrIsSetup
    if (!dsManager.freezrIsSetup) flogger.warn('freezr is NOT set up yet')
    if (dsManager.freezrIsSetup && (!detectedParams.envOnFile?.fsParams || !detectedParams.envOnFile?.dbParams)) {
      throw new Error('freezr was initiated but envOnFile not found')
    }
    
    const dbWorks = await checkDB(dsManager.initialEnvironment, { okToCheckOnLocal: true })

    // Step 4: Verify DB works and init PARAMS_OAC
    lastStartupStep = 'dbWorks'
    if (dbWorks?.checkpassed) freezrStatus.can_read_write_to_db = true
    if (dbWorks?.checkpassed && dsManager.freezrIsSetup) {
      try {
        await dsManager.initOacDB(PARAMS_OAC, {})
      } catch (err) {
        flogger.warn('initOacDB error:', err?.message)
      }
    }

    // Step 5: Init DBs and get preferences
    lastStartupStep = 'initdb'
    if (dsManager.freezrIsSetup && freezrStatus.can_read_write_to_db) {
      await dsManager.initOacDB(USER_DB_OAC, {})
      const paramsDb = await dsManager.initOacDB(PARAMS_OAC, {})
      const mainPrefsOnDb = await getOrSetPrefs(paramsDb, 'main_prefs', DEFAULT_PREFS, false)
      freezrPrefs = mainPrefsOnDb || { ...DEFAULT_PREFS }
      freezrPrefs.freezrVersion = VERSION
    } else {
      freezrPrefs = { ...DEFAULT_PREFS, freezrVersion: VERSION }
    }

    // Step 6: Check FS
    lastStartupStep = 'checkfs'
    try {
      const fsParamsToCheck = dsManager.initialEnvironment.envOnFile || dsManager.initialEnvironment
      const fsResult = await checkFS(fsParamsToCheck, {})
      
      if (!fsResult?.checkpassed) flogger.error('ERROR IN FS - Failed test ' + fsResult?.failedtest)
      if (fsResult?.warnings?.length > 0) flogger.warn('WARNINGS IN FS - ' + fsResult.warnings.join(', '))
      if (fsResult?.checkpassed) freezrStatus.can_write_to_user_folder = true
      
      if (dsManager.freezrIsSetup) {
        fradminAdminFs = await dsManager.getOrInitUserAppFS('fradmin', 'info.freezr.admin', {})
      }
    } catch (err) {
      flogger.error('checkFS error:', err?.message)
    }

    // Step 7: Get IP address
    lastStartupStep = 'getip'
    try {
      const { address } = await dnsLookup(os.hostname())
      dsManager.initialEnvironment.ipaddress = dsManager.initialEnvironment.ipaddress || address
    } catch (err) {
      flogger.warn('DNS lookup error')
    }

    // Step 8: Set up system users and admin DBs
    lastStartupStep = 'initadmindb'
    if (dsManager.freezrIsSetup && freezrStatus.can_read_write_to_db) {
      const systemEnv = {
        fsParams: dsManager.initialEnvironment.fsParams,
        dbParams: dsManager.initialEnvironment.dbParams
      }
      dsManager.setSystemUserDS('fradmin', systemEnv)
      dsManager.setSystemUserDS('public', systemEnv)
      await dsManager.initAdminDBs(dsManager.initialEnvironment, freezrPrefs)
    }

    // Step 9: Check server version and run updates
    lastStartupStep = 'version_check'
    if (dsManager.freezrIsSetup) {
      dsManager.systemEnvironment = dsManager.initialEnvironment
      freezrStatus.dbChoice = dsManager.initialEnvironment.dbParams.choice
      freezrStatus.dbType = dsManager.initialEnvironment.dbParams.type
      freezrStatus.fsChoice = dsManager.initialEnvironment.fsParams.choice
      freezrStatus.fsType = dsManager.initialEnvironment.fsParams.type
      freezrStatus.dbUnificationStrategy = freezrPrefs.dbUnificationStrategy
      
      flogger.info('❄️  Database: ' + freezrStatus.dbChoice + ' (' + freezrStatus.dbType + ') | FS: ' + freezrStatus.fsType)
      
      if ((process.env?.DB_UNIFICATION || freezrPrefs.dbUnificationStrategy) && 
          freezrPrefs.dbUnificationStrategy !== 'db' && 
          freezrPrefs.dbUnificationStrategy !== process.env.DB_UNIFICATION) {
        throw new Error('db process unification mismatch')
      }
      
      if (freezrStatus.can_read_write_to_db) {
        await checkServerVersionAndUpdate(dsManager, VERSION)
      }
    } else {
      flogger.info('+++++++++++ FIRST REGISTRATION WILL BE TRIGGERED +++++++++++')
    }

    // Step 10: Configure session (secrets) and root route
    lastStartupStep = 'session_setup'
    const getRedirectUrl = (req) => {
      return (req.session?.logged_in_user_id)
        ? '/account/home'
        : (getPublicUrlFromPrefs(req, dsManager, freezrPrefs) || '/public')
    }

    if (process.env.COOKIE_SECRET) {
      addAppUses(app, { session_cookie_secret: process.env.COOKIE_SECRET }, fradminAdminFs, getRedirectUrl)
    } else if (!dsManager.freezrIsSetup) {
      addAppUses(app, newFreezrSecrets(), fradminAdminFs, getRedirectUrl)
    } else {
      let cookieSecrets = null
      try {
        const secretsOnFile = await fradminAdminFs.readUserFile('freezr_secrets.js', {})
        if (secretsOnFile && secretsOnFile.toString() !== 'null') {
          cookieSecrets = JSON.parse(secretsOnFile.toString())
        }
      } catch (err) {
        flogger.warn('Resetting secrets - error reading secrets file')
      }

      if (!cookieSecrets && freezrStatus.can_write_to_user_folder) {
        const secrets = newFreezrSecrets()
        try {
          await fradminAdminFs.writeToUserFiles('freezr_secrets.js', JSON.stringify(secrets), { doNotOverWrite: false })
        } catch (err) {
          flogger.warn('Error writing secrets file')
        }
        addAppUses(app, secrets, fradminAdminFs, getRedirectUrl)
      } else {
        addAppUses(app, newFreezrSecrets(cookieSecrets), fradminAdminFs, getRedirectUrl)
      }
    }

    // Step 11: Initialize logging system
    lastStartupStep = 'init_logging'
    if (!dsManager?.freezrIsSetup) {
      console.warn('⚠️ ⚠️ ⚠️ Logging system requires freezr to be set up - Logging wll start on server restart - or need to re-initiate on setup')
      app.use(createAddConsoleFloggerMiddleware(consoleFlogger))
    } else {
      const fradminUserFSDataStore = await dsManager.getOrInitUserAppFS('fradmin', 'info.freezr.account', {})
      const fradminUserDbDataStore = await dsManager.getorInitDb({ owner: 'fradmin', app_name: 'info.freezr.account', collection_name: 'visitLogs' }, { freezrPrefs })
      
      logManager = createLogManager(fradminUserFSDataStore, {
        devLogging: process.env.NODE_ENV === 'development',
        errorPattern: BACKUP_PATTERNS.SYNCHRONOUS,
        trackPattern: BACKUP_PATTERNS.FLUSH_IDLE,
        devMatchers: {}
      })

      logSummarizer = createLogSummarizer(logManager, fradminUserDbDataStore)
      coreLogger = logManager.getLogger()
      
      // Upgrade to real FLogger
      flogger = new FLogger(coreLogger, { reqId: 'startup' })
      
      authRateLimiter = new AuthRateLimiter({
        maxAttemptsPerIp: AUTH_RATE_LIMIT.MAX_ATTEMPTS_PER_IP,
        maxAttemptsPerDevice: AUTH_RATE_LIMIT.MAX_ATTEMPTS_PER_DEVICE,
        windowMs: AUTH_RATE_LIMIT.WINDOW_MS,
        blockDurationMs: AUTH_RATE_LIMIT.BLOCK_DURATION_MS,
        onFailure: () => {},
        onBlock: () => {}
      })
      
      // Add logging middleware
      app.use(logManager.idleTimer.middleware())
      app.use(createRequestLoggerMiddleware({ logManager, coreLogger, authRateLimiter }))
    }
    
    flogger.track('✅ Logging system initialized')

    // Step 12: Mount routes
    lastStartupStep = 'mount_routes'
    const result = await mountAllModernRoutes(app, { dsManager, freezrPrefs, freezrStatus, logManager })
    if (!result.success) flogger.error('Some routes failed to mount!')

    // Mark complete
    freezrStatus.fundamentals_okay = freezrStatus.can_write_to_user_folder && freezrStatus.can_read_write_to_db

    return {
      dsManager,
      freezrPrefs,
      freezrStatus,
      fradminAdminFs,
      logManager,
      logSummarizer,
      coreLogger,
      authRateLimiter,
      flogger,
      lastStartupStep,
      error: null
    }

  } catch (err) {
    // Return error state
    freezrStatus.fundamentals_okay = freezrStatus.can_write_to_user_folder && freezrStatus.can_read_write_to_db
    
    flogger.error('❌ Failed to initialize:', err)
    flogger.info(' XXXXXXXXXXXXXXXXXXXXXXXXXXX Got err on start ups XXXXXXXXXXXXXXXXXXXXXXXXXXX ')
    flogger.info(' XXXXXXXXXXXXXXXXX last step: ' + lastStartupStep + ' XXXXXXXXXXXXXXXXXX ')
    flogger.info(' ... for Database   : ' + (dsManager?.initialEnvironment?.dbParams?.choice || ' unknown') + ' (' + (dsManager?.initialEnvironment?.dbParams?.type || 'unknown') + ')')
    flogger.info('File System: ' + (dsManager?.initialEnvironment?.fsParams?.type || 'unknown'))
    console.warn('STARTUP ERR ', ' - code: ', err?.code, ' - err.message:', err?.message, ' - name ', err?.name, ' statusCode: ', err?.statusCode)

    return {
      dsManager,
      freezrPrefs,
      freezrStatus,
      fradminAdminFs,
      logManager,
      logSummarizer,
      coreLogger,
      authRateLimiter,
      flogger,
      lastStartupStep,
      error: err
    }
  }
}

