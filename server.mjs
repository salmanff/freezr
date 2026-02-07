// freezr.info - nodejs system files - main file: server.mjs

const VERSION = '0.0.300'

console.log('=========================  VERSION JAN 11 2026  - ' + VERSION + ' =======================')

if (process.env.NODE_ENV === 'development') {
  console.log('[DEV-INFO] Running in DEVELOPMENT mode')
} else {
  console.log(`[DEV-INFO] Running in ${process.env.NODE_ENV || 'production'} mode`)
}

// Express setup
import express from 'express'
import cookieParser from 'cookie-parser'
import { EXPRESS_CONFIG } from './common/startup/constants.mjs'

const app = express()
app.use(express.json({ limit: EXPRESS_CONFIG.JSON_MB_LIMIT })) // 50MB
app.use(express.urlencoded({ extended: true, limit: EXPRESS_CONFIG.URL_ENCODED_MB_LIMIT })) // 50MB
app.use(cookieParser())
app.enable('trust proxy')

// Startup sequence
import { startupSequence } from './common/startup/startupSequence.mjs'

const {
  dsManager,
  freezrPrefs,
  freezrStatus,
  flogger,
  error
} = await startupSequence(app, VERSION)

// Log startup completion
flogger.info('Startup checks complete.')
flogger.info({ freezrStatus })
flogger.info({ freezrPrefs })
if (process.env.DB_UNIFICATION) {
  flogger.info('\nUnification strategy at process level: ' + process.env.DB_UNIFICATION)
}
if (error) {
  flogger.warn('Server started with error : ' + error.message)
}

// Start server
if (freezrStatus.fundamentals_okay) {
  const port = process.env.PORT || dsManager?.initialEnvironment?.port
  flogger.info('Server listening on port ' + port)
  app.listen(port)
} else {
  flogger.info('Server was NOT Started as fundamental capabioities failed.')
}