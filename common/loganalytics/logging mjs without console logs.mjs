// ============================================
// logging.mjs
// FREEZR LOGGING & ANALYTICS SYSTEM 
// Split into LogManager (privileged) and Logger (restricted)
// Simplified flush strategy: idle OR threshold
// Simplified file structure: {date}-{serverKey}.jsonl
// ES Module version

// Improvements
// Cleanup should be done on idle if the 24 hour threshold has PasswordPolicyViolationException, rather than every 24 hours
//    ie mark it for a cron job to run on idle and / or within a threshold

// ============================================

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';

const defaultLogDir = process.env.NODE_ENV === 'production' 
  ? '/tmp/freezr-logs'  // Production: ephemeral, fast
  : './users_temp_logs';           // Development: easy to see/debug


// ============================================
// 1. IDLE TIMER
// ============================================

export class IdleTimer {
  constructor(idleThresholdMs = 5000, config = {}) {
    this.idleThreshold = idleThresholdMs;
    this.lastActivity = Date.now();
    this.flushCallbacks = [];
    this.checkInterval = null;
    this.hasFlushedWhileIdle = false;
    
    this.logInfo = config.logInfo ? (...args) => config.logInfo(...args) : ((...args) => console.log(...args));
    this.logError = config.logError ? (...args) => config.logError(...args) : ((...args) => console.error(...args));
  }
  
  recordActivity() {
    this.lastActivity = Date.now();
    this.hasFlushedWhileIdle = false; // Reset on new activity
  }
  
  onIdle(callback) {
    this.flushCallbacks.push(callback);
    
    if (!this.checkInterval) {
      this.checkInterval = setInterval(() => {
        const idleTime = Date.now() - this.lastActivity;
        
        if (idleTime >= this.idleThreshold) {
          this.flush();
        }
      }, 1000);
    }
  }
  
  async flush() {
    if (this.flushCallbacks.length === 0) return;
    if (this.hasFlushedWhileIdle) return; // Already flushed during this idle period
    
    const idleTime = Date.now() - this.lastActivity;
    
    // Only flush if we've been idle for the threshold duration
    if (idleTime < this.idleThreshold) {
      return;
    }
    
    this.hasFlushedWhileIdle = true; // Mark as flushed before running callbacks
    const timeStr = new Date().toLocaleTimeString();
    this.logInfo('[LOG MANAGER] Server idle, flushing buffers...', { callbackCount: this.flushCallbacks.length });
    
    for (const callback of this.flushCallbacks) {
      try {
        await callback();
      } catch (err) {
        this.logError('[LOG MANAGER] Flush error:', err);
      }
    }
  }
  
  middleware() {
    return (req, res, next) => {
      this.recordActivity();
      next();
    };
  }
  
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }
}

// ============================================
// 2. BACKUP PATTERNS (Simplified)
// ============================================

export const BACKUP_PATTERNS = {
  SYNCHRONOUS: 'synchronous',  // Write immediately
  BUFFERED: 'buffered',        // Write when idle OR threshold reached
  NONE: 'none'                 // Don't persist
};

export class BackupPattern {
  constructor(pattern, options = {}) {
    this.pattern = pattern;
    this.bufferThreshold = options.bufferThreshold || 100;
  }
  
  shouldFlushImmediately() {
    return this.pattern === BACKUP_PATTERNS.SYNCHRONOUS;
  }
  
  shouldFlushOnThreshold(bufferSize) {
    return this.pattern === BACKUP_PATTERNS.BUFFERED && 
           bufferSize >= this.bufferThreshold;
  }
  
  shouldBuffer() {
    return this.pattern === BACKUP_PATTERNS.BUFFERED;
  }
  
  isNone() {
    return this.pattern === BACKUP_PATTERNS.NONE;
  }
}

// ============================================
// 3. METADATA EXTRACTOR
// ============================================

function cleanMetadata(metadata) {
  const meta = {};

  if (metadata.reqId !== undefined) meta.reqId = metadata.reqId;
  if (metadata.path !== undefined) meta.path = metadata.path;
  if (metadata.user !== undefined) meta.user = metadata.user;
  if (metadata.device !== undefined) meta.device = metadata.device;
  if (metadata.app !== undefined) meta.app = metadata.app;
  if (metadata.ip !== undefined) meta.ip = metadata.ip;
  
  return meta;
}

// ============================================
// 4. DEV FILTERS
// ============================================

function shouldLogDev(args, metadata, matchers) { // assertFn removed
  // for message key - checks if first string message contains any of the matcher values if array or the value if string
  // for other keys - checks if the value is in the metadata or in the args array
  const firstMessage = args.find(m => typeof m === 'string') || '';

  const metaMatchers = metadata._matchers || {};
  const allMatchers = { ...matchers, ...metaMatchers };
  
  if (Object.keys(allMatchers).length === 0) {
    return false; // No matchers, do not log
  }
  
  // Check each filter
  for (const [key, value] of Object.entries(allMatchers)) {
    if (key === 'message') {
      if (Array.isArray(value)) {
        // Multiple allowed values
        if (value.some(val => firstMessage.includes(val))) {
          return true;
        }
      } else if (firstMessage.indexOf(value) > -1) {
        return true;
      }  
    } else if (Array.isArray(value)) {
      // Multiple allowed values ?? 
      if (value.includes(metadata[key])) {
        return true;
      } 
      if (args.some(arg => arg[key] === value)) {
        return true;
      }
    } else {
      // Single value match
      if (metadata[key] === value) {
        return true;
      }
      if (args.some(arg => arg[key] === value)) {
        return true;
      }
    }
  }
  
  return false;
}

// ============================================
// 5. LOGGER (Restricted - for application code)
// ============================================

export class Logger {
  constructor(config, scopedFunctions) {
    this.name = config.name || 'SimpleLogger';
    this.serverKey = config.serverKey;
    
    // Dev logging configuration
    this.devLoggingEnabled = config.devLogging !== false;
    this.devMatchers = config.devMatchers || {};
    
    this.writeToLocalFn = scopedFunctions.writeToLocal;
    this.markForCloudSyncFn = scopedFunctions.markForCloudSync;
    
    this.buffers = {
      error: [],
      warn: [],
      info: [],
      auth: [],
      track: [],
      debug: []
    };
    
    this.backupPatterns = {
      error: new BackupPattern(
        config.errorPattern || BACKUP_PATTERNS.SYNCHRONOUS
      ),
      warn: new BackupPattern(
        config.warnPattern || BACKUP_PATTERNS.BUFFERED,
        { bufferThreshold: config.warnBufferThreshold || 50 }
      ),
      info: new BackupPattern(
        config.infoPattern || BACKUP_PATTERNS.BUFFERED,
        { bufferThreshold: config.infoBufferThreshold || 100 }
      ),
      auth: new BackupPattern(
        config.authPattern || BACKUP_PATTERNS.SYNCHRONOUS
      ),
      track: new BackupPattern(
        config.trackPattern || BACKUP_PATTERNS.BUFFERED,
        { bufferThreshold: config.trackBufferThreshold || 200 }
      ),
      debug: new BackupPattern(
        config.devPattern || BACKUP_PATTERNS.NONE
      )
    };
  }
  
  createEvent(level, timestamp, messages, metadata = {}) {
    const meta = cleanMetadata(metadata);
    
    let error = null;
    let errorStack = null;
    const filteredMessages = [];
    
    for (const msg of messages) {
      if (msg instanceof Error) {
        if (!error) { // Only keep first error
          error = msg.message;
          errorStack = msg.stack;
        }
      } else {
        filteredMessages.push(msg);
      }
    }
    
    return {
      serverKey: this.serverKey,
      level,
      timestamp,
      meta,
      messages: filteredMessages,
      ...(error && { 
        error,
        errorStack
      })
    };
  }
  
  log(level, messages, metadata = {}) {
    const timestamp = new Date().toISOString();
    const timeString = new Date().toLocaleTimeString();
    
    const messagesArray = Array.isArray(messages) ? messages : [messages];
    
    const event = this.createEvent(level, timestamp, messagesArray, metadata);
    const pattern = this.backupPatterns[level];

    const metaParts = [
      event.meta.reqId && `s:${event.meta.reqId}`,
      event.meta.path && `path:${event.meta.path}`,
      event.meta.user && `usr:${event.meta.user}`,
      event.meta.app && `app:${event.meta.app}`
    ].filter(Boolean);
    const metaStr = metaParts.join(' ');

    let formattedMessages = event.messages.map(msg => {
      if (typeof msg === 'object' && msg !== null) {
        const indent = '    '; // 4 spaces per indent level
        const jsonStr = JSON.stringify(msg, null, 2); 
        // Indent all lines after the first to align with emoji prefix
        return jsonStr.split('\n').map((line, idx) => idx === 0 ? line : indent + line).join('\n');
      }
      return msg;
    });

    // If no messages but we have an error, show the error message
    // onsole.log('formattedMessages: ', formattedMessages);
    if (formattedMessages.length === 0) {
      formattedMessages = [];
    }
    if (event.error) {
      formattedMessages.push({ error: event.error, stack: event.errorStack });
    }

    // If still no messages, show empty string to avoid blank output
    if (formattedMessages.length === 0) {
      formattedMessages = [''];
    }

    if (level === 'error') {
      console.log(`❌🥶 ${timeString} ${metaStr} msg:`, ...formattedMessages);
    } else if (level === 'auth') {
      console.log(`‼️❌ AUTH ❌‼️ ${timeString} ${metaStr} msg:`, ...formattedMessages, metadata);
    } else if (level === 'debug') {
      console.log(`🔎 ${timeString} ${metaStr} msg:`, ...formattedMessages);
    } else {
      const emoji = level === 'warn' ? '⚠️⚠️ ' : ( level === 'info' ? 'ℹ️  ' : '❄️  ');
      console.log(`${emoji} ${timeString} ${metaStr} msg:`, ...formattedMessages);
    }
    
    // ASYNC: Defer file/DB writes to avoid blocking
    setImmediate(async () => {
      try {
        // Check pattern and handle accordingly
        if (pattern.shouldFlushImmediately()) {
          await this.writeEventToLocal(level, event);
          return;
        }
        
        if (pattern.isNone()) {
          // NONE: Don't persist
          return;
        }
        
        // BUFFERED: Add to buffer
        this.buffers[level].push(event);
        
        // Check if threshold reached
        if (pattern.shouldFlushOnThreshold(this.buffers[level].length)) {
          await this.flushBuffer(level);
        }
      } catch (err) {
        console.error(`[Logger] Failed to process ${level} log:`, err);
      }
    });
  }
  
  async writeEventToLocal(level, event) {
    try {
      const content = JSON.stringify(event) + '\n';
      const dateStr = await this.writeToLocalFn(content);
      this.markForCloudSyncFn(dateStr);
    } catch (err) {
      console.error(`[${this.name}] Failed to write ${level} log to local:`, err);
    }
  }
  
  async flushBuffer(level) {
    if (this.buffers[level].length === 0) return;
    
    const events = [...this.buffers[level]];
    this.buffers[level] = [];
    
    try {
      const content = events.map(e => JSON.stringify(e)).join('\n') + '\n';
      const dateStr = await this.writeToLocalFn(content);
      this.markForCloudSyncFn(dateStr);
    } catch (err) {
      console.error(`[${this.name}] Failed to flush ${level} logs:`, err);
      this.buffers[level].unshift(...events);
    }
  }
  
  getBuffers() {
    return {
      error: [...this.buffers.error],
      warn: [...this.buffers.warn],
      info: [...this.buffers.info],
      auth: [...this.buffers.auth],
      track: [...this.buffers.track],
      debug: [...this.buffers.debug]
    };
  }
  
  clearBuffers() {
    this.buffers.error = [];
    this.buffers.warn = [];
    this.buffers.info = [];
    this.buffers.auth = [];
    this.buffers.track = [];
    this.buffers.debug = [];
  }
  
  // Public API (all sync - console output immediate, file/DB writes deferred)
  // Accepts ...args as messages, metadata is separate and passed as the first argument
  
  error(metadata = {}, args) {
    this.log('error', args, metadata);
  }
  
  warn(metadata = {}, args) {
    this.log('warn', args, metadata);
  }
  
  info(metadata = {}, args) {
    this.log('info', args, metadata);
  }
  
  auth(metadata = {}, args) {
    this.log('auth', args, metadata);
  }
  
  track(metadata = {}, args) {
    this.log('track', args, metadata);
  }
  
  debug(metadata = {}, args) {
    if (!shouldLogDev(args, metadata, this.devMatchers)) {
      return;
    }
    
    const cleanMeta = { ...metadata };
    delete cleanMeta._matchers;
    delete cleanMeta._assert;
    
    this.log('debug', args, cleanMeta);
  }
}

// ============================================
// 5b. FLOGGER (Request-scoped contextualized logger)
// ============================================

/**
 * FLogger - A request-scoped logger wrapper that pre-bakes context metadata.
 * 
 * Instead of passing { res } to every log call, FLogger captures the request
 * context once and includes it automatically in all log calls.
 * 
 * Usage:
 *   const flogger = new FLogger(coreLogger, { reqId, reqIp, method, path, user, device });
 *   flogger.info('User logged in');  // Sync - console output immediate, file writes deferred
 *   
 */
export class FLogger {
  /**
   * @param {Logger} coreLogger - The core Logger instance (singleton)
   * @param {Object} context - Initial context { reqId, reqIp, method, path, user, device }
   */
  constructor(coreLogger, context) {
    this.coreLogger = coreLogger;
    this.context = context;
  }
  
  /**
   * Update context with token-related params (call this when token info becomes available)
   * @param {Object} params - Token params { app, ... }
   */
  setTokenParams(params) {
    if (params.app !== undefined) this.context.app = params.app;
    // Add other token-related fields as needed
  }
  
  /**
   * Get the full context for logging
   */
  getFullContext() {
    return this.context;
  }
  
  info(...args) {
    this.coreLogger.log('info', args, this.getFullContext());
  }
  
  error(...args) {
    this.coreLogger.log('error', args, this.getFullContext());
  }
  
  warn(...args) {
    this.coreLogger.log('warn', args, this.getFullContext());
  }
  
  debug(...args) {
    this.coreLogger.debug(this.getFullContext(), args);
  }
  
  auth(...args) {
    this.coreLogger.log('auth', args, this.getFullContext());
  }
  
  track(...args) {
    this.coreLogger.log('track', args, this.getFullContext());
  }
}

// ============================================
// 6. PINO LOGGER ADAPTER
// ============================================

export class PinoLogger extends Logger {
  constructor(config, scopedFunctions) {
    super(config, scopedFunctions);
    this.name = 'PinoLogger';
    this.initPino(config);
    console.log('[PinoLogger] Initialized with pino backend');
  }
  
  async initPino(config) {
    try {
      const pinoModule = await import('pino');
      const pino = pinoModule.default || pinoModule;
      
      this.pino = pino({
        level: config.pinoLevel || 'info',
        ...config.pinoOptions
      });
    } catch (err) {
      throw new Error(
        'Pino not installed. Install with: npm install pino\n' +
        'Or use SimpleLogger by setting loggerType: "simple"'
      );
    }
  }
  
  log(level, message, errorOrMetadata = {}, metadata = {}) {
    let error = null;
    let meta = metadata;
    
    if (errorOrMetadata instanceof Error) {
      error = errorOrMetadata;
    } else {
      meta = { ...errorOrMetadata, ...metadata };
    }
    
    const extracted = cleanMetadata(meta);
    
    // Log to pino
    const pinoLevel = level === 'track' ? 'info' : level;
    const pinoLevel2 = pinoLevel === 'auth' ? 'warn' : pinoLevel;
    
    if (error) {
      this.pino[pinoLevel2]({ err: error, ...extracted }, message);
    } else {
      this.pino[pinoLevel2](extracted, message);
    }
    
    // Also persist via parent class (now sync, defers async work internally)
    super.log(level, message, errorOrMetadata, metadata);
  }
}

// ============================================
// 7. LOG MANAGER (Privileged - admin only)
// ============================================

export class LogManager {
  constructor(fsDatastore, config = {}) {
    this.fsDatastore = fsDatastore;
    this.config = config;
    
    // Generate unique server key
    this.serverKey = crypto.randomBytes(8).toString('hex'); // process.env.NODE_ENV === 'development' ? 'devServer' : 
    const timeStr = new Date().toLocaleTimeString();
    console.log(`❄️  ${timeStr}  [LogManager] Set up with server key: ${this.serverKey}`);
    
    // Local file paths
    this.localLogsDir = config.localLogsDir || defaultLogDir;
    
    try {
      fsSync.mkdirSync(this.localLogsDir, { recursive: true });
    } catch (err) {
      console.error('Failed to create local logs directory:', err);
    }
    
    // Track what needs to be synced to cloud
    this.pendingCloudSync = new Set();
    
    // Cloud sync interval (default: every 5 minutes)
    this.cloudSyncInterval = config.cloudSyncInterval || 5 * 60 * 1000;
    this.cloudSyncTimer = null;
    
    // Create idle timer with logger functions
        
    // Use provided logger functions or fallback to console
    const logMetaData = {
      appName: 'logger-idle-timer',
      functionName: 'flush',
      user: 'fradmin'
    };
    this.idleTimer = new IdleTimer(config.idleThreshold || 5000, {
      logInfo: (...args) => this.logger.info(logMetaData, ...args),
      logError: (...args) => this.logger.error(logMetaData, ...args)
    });
    this.idleTimer.recordActivity(); // Initialize to prevent immediate flush
    
    // Create logger
    this.logger = this.createLogger();
    
    // Setup idle flushes (only strategy now)
    this.setupIdleFlushes();
    
    // Start cloud sync
    this.cloudSyncTimer = setInterval(() => this.flushToCloud(), this.cloudSyncInterval);
    
    // Create aggregation engine
    this.aggregation = new AggregationEngine(fsDatastore);
    
    // Create retention manager with logger functions
    this.retention = new RetentionManager(fsDatastore, {
      detailedLogsRetention: config.detailedLogsRetention || 180,
      // Potentially used in future if handle analytics here
      // hourlyRetention: config.hourlyRetention || 30, 
      // dailyRetention: config.dailyRetention || 365,
      localLogsDir: this.localLogsDir,
      localRetentionDays: config.localRetentionDays || 30,
      // Pass logger functions for proper logging
      logWarn: (...args) => this.logger.warn(logMetaData, ...args),
      logError: (...args) => this.logger.error(logMetaData, ...args),
      logInfo: (...args) => this.logger.info(logMetaData, ...args)
    });
    
    this.retention.scheduleDaily();
  }
  
  createLogger() {
    const loggerType = this.config.loggerType || 'simple';
    
    // Create scoped functions for logger
    const scopedFunctions = {
      writeToLocal: this.createWriteToLocalFn(),
      markForCloudSync: (dateStr) => this.pendingCloudSync.add(dateStr)
    };
    
    const loggerConfig = {
      ...this.config,
      serverKey: this.serverKey,
      name: loggerType === 'pino' ? 'PinoLogger' : 'SimpleLogger'
    };
    
    if (loggerType === 'pino') {
      try {
        return new PinoLogger(loggerConfig, scopedFunctions);
      } catch (err) {
        console.warn(err.message);
        console.warn('Falling back to SimpleLogger');
        return new Logger(loggerConfig, scopedFunctions);
      }
    }
    
    return new Logger(loggerConfig, scopedFunctions);
  }
  
  createWriteToLocalFn() {
    return async (content) => {
      const today = new Date().toISOString().split('T')[0];
      const localPath = path.join(this.localLogsDir, `${today}-${this.serverKey}.jsonl`);
      
      // Append to local file (async)
      await fs.appendFile(localPath, content);
      
      return today;
    };
  }
  
  setupIdleFlushes() {
    // Flush all buffered levels when idle
    this.idleTimer.onIdle(() => this.flushAllBuffers());
    
    // Also flush to cloud when idle
    this.idleTimer.onIdle(() => this.flushToCloud());
  }
  
  async flushBuffer(level) {
    await this.logger.flushBuffer(level);
  }
  
  async flushAllBuffers() {
    const levels = ['error', 'warn', 'info', 'auth', 'track', 'debug'];
    await Promise.all(levels.map(level => this.flushBuffer(level)));
  }
  
  async flushAll() {
    await this.flushAllBuffers();
    await this.flushToCloud();
  }
  
  async flushToCloud() {
    if (this.pendingCloudSync.size === 0) return;
    
    const syncedFiles = [];
    
    for (const dateStr of this.pendingCloudSync) {
      try {
        const localPath = path.join(this.localLogsDir, `${dateStr}-${this.serverKey}.jsonl`);
        const content = await fs.readFile(localPath, 'utf8');
        
        // Upload to cloud in server-specific path
        await this.fsDatastore.writeToUserFiles(
          `logs/detailed/${dateStr}-${this.serverKey}.jsonl`,
          content,
          {}
        );
        
        syncedFiles.push(dateStr);
      } catch (err) {
        console.error(`[LogManager] Failed to sync ${dateStr}.jsonl to cloud:`, err);
      }
    }
    
    syncedFiles.forEach(f => this.pendingCloudSync.delete(f));
  }
  
  // Helper: Normalize date to YYYY-MM-DD
  normalizeDate(date) {
    if (!date) {
      return new Date().toISOString().split('T')[0];
    }
    
    if (typeof date === 'string') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return date;
      }
      return new Date(date).toISOString().split('T')[0];
    }
    
    if (date instanceof Date) {
      return date.toISOString().split('T')[0];
    }
    
    return new Date(date).toISOString().split('T')[0];
  }
  
  // Helper: Parse JSONL content
  parseLogContent(content) {
    if (!content) return [];
    
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try {
          return JSON.parse(line);
        } catch (err) {
          console.error('Failed to parse log line:', line);
          return null;
        }
      })
      .filter(log => log !== null);
  }
  
  // New: Get all logs for a date from ALL servers with filtering
  async getAll(date, options = {}) {
    const { user, level, limit } = options;
    const dateStr = this.normalizeDate(date);
    
    const allLogs = [];
    const processedServers = new Set();
    
    // 1. Get all local files for this date
    try {
      const localFiles = await fs.readdir(this.localLogsDir);
      const pattern = `${dateStr}-`;
      const localServerFiles = localFiles.filter(f => 
        f.startsWith(pattern) && f.endsWith('.jsonl')
      );
      
      for (const file of localServerFiles) {
        try {
          const serverKey = file.replace(pattern, '').replace('.jsonl', '');
          const localPath = path.join(this.localLogsDir, file);
          const content = await fs.readFile(localPath, 'utf8');
          const logs = this.parseLogContent(content);
          allLogs.push(...logs);
          processedServers.add(serverKey);
        } catch (err) {
          console.error(`Failed to read local file ${file}:`, err);
        }
      }
    } catch (err) {
      // Local directory doesn't exist or can't read
    }
    
    // 2. Get cloud files (excluding those already processed)
    try {
      const cloudFiles = await this.listCloudFilesForDate(dateStr);
      
      for (const file of cloudFiles) {
        const serverKey = file.replace(`${dateStr}-`, '').replace('.jsonl', '');
        
        // Skip if already processed from local
        if (processedServers.has(serverKey)) {
          continue;
        }
        
        try {
          const content = await this.fsDatastore.readUserFile(
            `logs/detailed/${file}`
          );
          const logs = this.parseLogContent(content);
          allLogs.push(...logs);
          processedServers.add(serverKey);
        } catch (err) {
          console.error(`Failed to read cloud file ${file}:`, err);
        }
      }
    } catch (err) {
      // Cloud read failed
    }
    
    // Apply filters
    const filtered = allLogs.filter(log => {
        if (user && log.meta?.user !== user) return false;
        if (level && log.level !== level) return false;
        return true;
      });
    
    return limit ? filtered.slice(0, limit) : filtered;
  }

  // New: Get recent logs for multiple days
  async getDays(startDate, endDate, options = {}) {
    // console.log('🔍 getDays called with:', { startDate, endDate, options })

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (!startDate || !endDate || start.getTime() > end.getTime()) {
      return []
    }
    const allLogs = [];

    
    // Iterate from start date to end date, incrementing by one day
    for (
      let date = new Date(start);
      date <= end;
      date.setDate(date.getDate() + 1)
    ) {
      // Make a new Date instance to avoid mutating the iterator
      const currentDate = new Date(date);
      try {
        const dayLogs = await this.getAll(currentDate, options);
        allLogs.push(...dayLogs);
      } catch (err) {
        console.error(`Failed to fetch logs for day ${currentDate.toISOString().slice(0, 10)}:`, err);
      }
    }
    
    // Sort by timestamp (newest first)
    allLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      
    // Apply limit if specified
    if (options.limit) {
      return allLogs.slice(0, options.limit);
    }
    
    return allLogs;
  }
    
  
  // New: Get recent logs for multiple days
  async getRecent(numDays = 7, options = {}) {
    const allLogs = [];
    
    // Get dates for the last N days
    for (let i = 0; i < numDays; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      
      try {
        const dayLogs = await this.getAll(date, options);
        allLogs.push(...dayLogs);
      } catch (err) {
        console.error(`Failed to fetch logs for day ${i}:`, err);
      }
    }
    
    // Sort by timestamp (newest first)
    allLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    // Apply limit if specified
    if (options.limit) {
      return allLogs.slice(0, options.limit);
    }
    
    return allLogs;
  }
  
  // Helper: List all log files in cloud for a specific date
  async listCloudFilesForDate(dateStr) {
    // Try to list files if fsDatastore supports it
    if (this.fsDatastore.listFiles) {
      try {
        const files = await this.fsDatastore.listFiles('logs/detailed/');
        return files.filter(f => f.startsWith(`${dateStr}-`) && f.endsWith('.jsonl'));
      } catch (err) {
        console.error('Failed to list cloud files:', err);
      }
    }
    
    // Fallback: try to read file for current server only
    const currentServerFile = `${dateStr}-${this.serverKey}.jsonl`;
    
    try {
      // Test if file exists by trying to read it
      await this.fsDatastore.readUserFile(`logs/detailed/${currentServerFile}`);
      return [currentServerFile];
    } catch (err) {
      return [];
    }
  }
  
  async readLocal(date, serverKey = null) {
    const dateStr = this.normalizeDate(date);
    const sKey = serverKey || this.serverKey;
    const localPath = path.join(this.localLogsDir, `${dateStr}-${sKey}.jsonl`);
    return await fs.readFile(localPath, 'utf8');
  }
  
  async readCloud(date, serverKey = null) {
    const dateStr = this.normalizeDate(date);
    const sKey = serverKey || this.serverKey;
    return await this.fsDatastore.readUserFile(
      `logs/detailed/${dateStr}-${sKey}.jsonl`
    );
  }
  
  // New: Get all server keys for a date
  async getServerKeys(date) {
    // For local files
    try {
      const files = await fs.readdir(this.localLogsDir);
      const pattern = `${date}-`;
      const serverKeys = files
        .filter(f => f.startsWith(pattern) && f.endsWith('.jsonl'))
        .map(f => f.replace(pattern, '').replace('.jsonl', ''));
      
      if (serverKeys.length > 0) {
        return serverKeys;
      }
    } catch (err) {
      // Continue to cloud
    }
    
    // For cloud files - would need directory listing
    // For now, return current server key
    return [this.serverKey];
  }
  
  async queryLogs(filters = {}) {
    const { 
      startDate, 
      endDate, 
      user, 
      app, 
      level,
      serverKey,
      limit = 1000
    } = filters;
    
    const logs = [];
    const start = new Date(startDate || Date.now() - 7 * 24 * 60 * 60 * 1000);
    const end = new Date(endDate || Date.now());
    
    const serversToQuery = serverKey ? [serverKey] : await this.getServerKeys();
    
    for (const sKey of serversToQuery) {
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];
        
        try {
          const content = await this.fsDatastore.readUserFile(
            `logs/detailed/${dateStr}-${sKey}.jsonl`
          );
          
          if (!content) continue;
          
          const dayLogs = content
            .split('\n')
            .filter(line => line.trim())
            .map(line => JSON.parse(line));
          
          logs.push(...dayLogs);
        } catch (err) {
          // File doesn't exist
        }
        
        if (logs.length >= limit) break;
      }
      
      if (logs.length >= limit) break;
    }
    
    // Apply filters (using new event structure with meta)
    const filtered = logs.filter(log => {
      if (user && log.meta?.user !== user) return false;
      if (app && log.meta?.app !== app) return false;
      if (level && log.level !== level) return false;
      return true;
    });
    
    return filtered.slice(0, limit);
  }
  
  getLogger() {
    return this.logger;
  }
  
  async shutdown() {
    console.log('[LogManager] Shutting down...');
    
    await this.flushAll();
    
    if (this.cloudSyncTimer) {
      clearInterval(this.cloudSyncTimer);
    }
    
    this.idleTimer.stop();
    
    console.log('[LogManager] Shutdown complete');
  }
}

// ============================================
// 8. AGGREGATION ENGINE (Placeholder)
// ============================================

export class AggregationEngine {
  constructor(fsDatastore) {
    this.fsDatastore = fsDatastore;
  }
  
  // Placeholder - actual implementation in summarization.mjs
  async aggregateToHourly(date, serverKeys = null) {
    console.log(`Aggregating hourly data for ${date}...`);
    console.log('Use summarization.mjs for actual aggregation');
  }
}

// ============================================
// 9. RETENTION MANAGER
// ============================================

export class RetentionManager {
  constructor(fsDatastore, config = {}) {
    this.fsDatastore = fsDatastore;
    this.localLogsDir = config.localLogsDir || defaultLogDir;
    
    this.policies = {
      // analytics could eused in future if handle analytics here
      // 'analytics/*/hourly': config.hourlyRetention || 30,
      // 'analytics/*/daily': config.dailyRetention || 365,
      'logs/detailed': config.detailedLogsRetention || 180
    };
    
    this.localRetentionDays = config.localRetentionDays || 1;
    
    this.logWarn = config.logWarn  ? (...args) => config.logWarn(...args) : ((...args) => console.warn(...args));
    this.logError = config.logError  ? (...args) => config.logError(...args) : ((...args) => console.error(...args));
    this.logInfo = config.logInfo  ? (...args) => config.logInfo(...args) : ((...args) => console.log(...args));
    this.logDebug = config.logDebug  ? (...args) => config.logDebug(...args) : ((...args) => console.debug(...args));
  }
  
  // Helper function to check if a file should be deleted based on date in filename
  fileShouldBeDeleted(file, maxAge, now) {
    // Files are named like: YYYY-MM-DD-{serverKey}.jsonl
    // Extract the date part (first 10 characters)
    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})-/);
    
    if (!dateMatch) {
      // Skip files that don't match the expected pattern
      return { shouldDelete: false, dateStr: null };
    }
    
    const dateStr = dateMatch[1];
    const fileDate = new Date(dateStr + 'T00:00:00Z');
    const fileTimestamp = fileDate.getTime();
    
    // Check if file is older than maxAge
    const shouldDelete = (now - fileTimestamp > maxAge);
    
    return { shouldDelete, dateStr };
  }
  
  async cleanup() {
        
    const now = Date.now();
    
    for (const [pattern, daysToKeep] of Object.entries(this.policies)) {
      const maxAge = daysToKeep * 24 * 60 * 60 * 1000;
      
      try {
        await this.cleanupPattern(pattern, maxAge, now);
      } catch (err) {
        this.logError({}, `Failed to cleanup ${pattern}:`, err);
      }
    }
    
    await this.cleanupLocalFiles();
    
    this.logInfo({}, 'Retention cleanup complete');
  }
  
  async cleanupPattern(pattern, maxAge, now) {
    this.logInfo(`Cleaning up files matching ${pattern} older than ${maxAge}ms or ${maxAge/(24*60*60*1000)} days`);
    
    // For non-local filesystems, use the same algorithm as cleanupLocalFiles
    if (!this.fsDatastore?.readUserDir) {
      this.logWarn('fsDatastore.readUserDir not available for cleanupPattern');
      return;
    }
    
    try {
      // List files in the pattern directory using readUserDir
      const files = await this.fsDatastore.readUserDir(pattern, {});
      
      if (!files || files.length === 0) {
        return;
      }
      
      // Process each file - parse date from filename instead of using stat
      for (const file of files) {
        const { shouldDelete } = this.fileShouldBeDeleted(file, maxAge, now);
        
        if (shouldDelete) {
          this.logInfo(`Deleting old cloud file: ${file}`);
          const relativePath = `${pattern}/${file}`;
          try {
            // Delete the file using removeFile wrapper (which handles path construction)
            await this.fsDatastore.removeFile(relativePath, {});
            this.logInfo(`Deleted old cloud file: ${relativePath}`);
          } catch (err) {
            this.logWarn(`Failed to delete file ${relativePath}:`, err.message);
          }
        }
      }
    } catch (err) {
      // If directory doesn't exist, that's okay - just return
      if (err.code === 'ENOENT' || err.message?.includes('does not exist') || err.message?.includes('no such file')) {
        return;
      }
      this.logError(`Failed to cleanup pattern ${pattern}:`, err);
      throw err;
    }
  }
  
  async cleanupLocalFiles() {
    try {
      const files = await fs.readdir(this.localLogsDir);
      const maxAge = this.localRetentionDays * 24 * 60 * 60 * 1000;
      const now = Date.now();
      
      for (const file of files) {

        const { shouldDelete } = this.fileShouldBeDeleted(file, maxAge, now);
        
        if (shouldDelete) {
          const filePath = path.join(this.localLogsDir, file);
          await fs.unlink(filePath);
          this.logInfo(`Deleted old local file: ${file}`);
        }
      }
    } catch (err) {
      this.logError('Failed to cleanup local files:', err);
    }
  }
  
  scheduleDaily() {
    const now = new Date();
    const tomorrow5AM = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      5, 0, 0
    );
    
    const msUntil5AM = tomorrow5AM - now;
    
    setTimeout(() => {
      this.cleanup();
      setInterval(() => this.cleanup(), 24 * 60 * 60 * 1000);
    }, msUntil5AM);
  }
}

// ============================================
// 10. FACTORY
// ============================================

export function createLogManager(fsDatastore, config = {}) {
  return new LogManager(fsDatastore, config);
}

export default {
  createLogManager,
  LogManager,
  Logger,
  FLogger,
  PinoLogger,
  AggregationEngine,
  RetentionManager,
  IdleTimer,
  BACKUP_PATTERNS
};
