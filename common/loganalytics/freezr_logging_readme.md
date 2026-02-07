# Freezr Logging & Analytics System

A secure, flexible logging and analytics system for Node.js applications with privileged/restricted access separation, configurable backup patterns, pluggable adapters, and multi-server support.

## Philosophy

### Design Principles

1. **Security Through Separation** - LogManager (privileged) vs Logger (restricted):
   - **LogManager**: Full datastore access, queries, aggregation, cloud sync
   - **Logger**: Scoped write-only access, cannot read or query logs
   - Application code only gets Logger - cannot access other users' data

2. **Unified Event Stream** - Logs and analytics from the same events:
   - **Logs**: Diagnostic information (timestamps, stack traces, context)
   - **Analytics**: Aggregate metrics derived from tracked events
   - All events in one stream, different levels serve different purposes

3. **Configurable Persistence** - Different log levels have different backup patterns:
   - **Critical logs** (errors, auth): Write synchronously to survive crashes
   - **Important logs** (warnings): Flush periodically (timed intervals)
   - **Informational logs** (page visits): Flush when idle or buffer is full
   - **Dev logs**: Configurable, default is no persistence

4. **Multi-Server Aware** - Built for horizontal scaling:
   - Each server generates unique `serverKey`
   - Server-specific storage paths prevent write conflicts
   - Aggregation merges data from all servers

5. **Automatic Metadata Extraction** - Pass `res`, get structured data:
   - Extracts user, app, path, session from response object
   - No need to manually copy metadata everywhere

6. **Tiered Data Retention** - Keep detailed data short-term, summaries long-term:
   - Detailed events: 7 days
   - Hourly aggregates: 30 days
   - Daily aggregates: 1 year
   - Monthly summaries: Forever (in DB)

7. **Crash Resilience** - Critical logs survive container restarts:
   - Synchronous writes to local filesystem (survives process crash)
   - Periodic sync to cloud storage (survives container restart)
   - DB writes via summarization module

## Architecture

```
Application Code
      ↓
  Logger (restricted)
      ↓
  ┌───────────────────────┐
  │  Scoped Functions     │
  │  - writeToLocal()     │
  │                       │
  │                       │
  └───────────────────────┘
      ↓
  LogManager (privileged)
      ↓
  ┌─────────────────────────┐
  │  Storage Layer          │
  │  - Local FS             │
  │  - Cloud Storage        │
  │  - Database             │
  └─────────────────────────┘
      ↓
  ┌─────────────────────────┐
  │  Aggregation Engine     │
  │  (background jobs)      │
  └─────────────────────────┘
      ↓
  Hourly → Daily → Monthly
```

## Installation

```bash
# Core system (no dependencies)
# Just copy the logging.mjs file to your project

# Optional: Install pino for advanced features
npm install pino
```

## Quick Start

### Basic Setup (ES Modules)

```javascript
import { createLogManager } from './common/loganalytics/logging.mjs';

// Create manager (admin/bootstrap code only)
const logManager = createLogManager(datastoreInstance, {
  devLogging: true,
  errorPattern: BACKUP_PATTERNS.SYNCHRONOUS,
  trackPattern: BACKUP_PATTERNS.FLUSH_IDLE,
});

// Get logger for application code (restricted)
const logger = logManager.getLogger();

// Add idle detection middleware
app.use(logManager.idleTimer.middleware());

// Pass logger to routes
app.use((req, res, next) => {
  res.locals.flogger = logger;
  next();
});

// Use in routes
app.get('/photos', (req, res) => {
  res.locals.flogger.track('page_visit', { res });
  // Logger cannot read other users' logs - secure!
});
```

### With Pino (Advanced)

```javascript
import { createLogManager } from './lib/logging/logging.mjs';

const manager = createLogManager(datastoreInstance, {
  // Use Pino adapter
  loggerType: 'pino',
  
  // Pino configuration
  pinoOptions: {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true }
    }
  }
});

const logger = manager.getLogger();
```

## Configuration

### Backup Patterns

Each log level can use a different backup strategy:

```javascript
import { BACKUP_PATTERNS, createLogManager } from './lib/logging/logging.mjs';

const manager = createLogManager(datastore, {
  // Error logs: write immediately (survives crashes)
  errorPattern: BACKUP_PATTERNS.SYNCHRONOUS,
  
  // Warning logs: flush every 30 seconds
  warnPattern: BACKUP_PATTERNS.FLUSH_TIMED,
  warnFlushInterval: 30000,
  
  // Info logs: flush when server is idle
  infoPattern: BACKUP_PATTERNS.FLUSH_IDLE,
  infoBufferThreshold: 50,  // or when buffer reaches 50 events
  
  // Auth logs: write immediately (security audit trail)
  authPattern: BACKUP_PATTERNS.SYNCHRONOUS,
  
  // Track events: flush when idle (analytics)
  trackPattern: BACKUP_PATTERNS.FLUSH_IDLE,
  trackBufferThreshold: 100,
  
  // Dev logs: don't persist (or configure as needed)
  devPattern: BACKUP_PATTERNS.NONE,
});
```

### Available Backup Patterns

| Pattern | Description | Use Case |
|---------|-------------|----------|
| `SYNCHRONOUS` | Write immediately to storage | Critical logs (errors, auth) |
| `FLUSH_TIMED` | Flush at fixed intervals | Warnings, regular events |
| `FLUSH_IDLE` | Flush when server is idle | Info logs, analytics |
| `FLUSH_THRESHOLD` | Flush when buffer reaches size | High-volume events |
| `NONE` | No persistence (testing only) | Development/testing |

### Retention Policies

```javascript
const manager = createLogManager(datastore, {
  detailedLogsRetention: 7,      // Keep detailed logs for 7 days
  hourlyRetention: 30,           // Keep hourly aggregates for 30 days
  dailyRetention: 365,           // Keep daily aggregates for 1 year
  localRetentionDays: 1          // Keep local files for 1 day (cloud backup)
});
```

### Dev Logging Configuration

```javascript
const manager = createLogManager(datastore, {
  // Enable/disable dev logging
  devLogging: true,  // Default: true
  
  // Global filters (optional)
  devMatchers: {
    user: 'alice',  // Only log dev messages for alice
    // or
    users: ['alice', 'bob'],  // Multiple users
  },
  
  // Dev logs pattern (default: NONE - no persistence)
  devPattern: BACKUP_PATTERNS.NONE
});
```

### Local Storage & Cloud Sync

```javascript
const manager = createLogManager(datastore, {
  // Local storage path
  localLogsDir: '/var/freezr/logs',
  
  // How often to sync to cloud (default: 5 minutes)
  cloudSyncInterval: 5 * 60 * 1000,
  
  // Idle detection threshold
  idleThreshold: 5000  // Consider idle after 5 seconds
});
```

## Usage Examples

### Logging

```javascript
// Get logger from manager
const logger = manager.getLogger();

// Info logs (page visits, routine events)
logger.info('Page visited', {
  res,  // Automatically extracts user/app/path
  referrer: req.headers.referer
});

// Warning logs (non-critical issues)
logger.warn('Slow query detected', {
  res,
  query: 'SELECT * FROM photos',
  duration: 1500
});

// Error logs (with Error object)
try {
  await database.connect();
} catch (err) {
  logger.error('Database connection failed', err, { res });
}

// Auth logs (unauthorized access attempts)
logger.auth('Unauthorized access attempt', {
  res,
  reason: 'invalid_token'
});
```

### Track Events (Analytics)

```javascript
// Track page visit - automatically extracts user/app/path from res
logger.track('page_visit', { res });

// Track with custom metadata
logger.track('photo_uploaded', {
  res,
  photo_id: photo.id,
  file_size: 2048000,
  file_type: 'image/jpeg'
});

// Track errors
logger.track('error_occurred', {
  res,
  error_type: 'DatabaseTimeout',
  endpoint: '/api/photos'
});

// Track custom events
logger.track('subscription_upgraded', {
  res,
  plan: 'premium',
  price: 9.99
});
```

### Dev Logging with Filters

```javascript
// Basic dev logging (only if devLogging: true)
logger.dev('Debug value', { res, value: 123 });

// With filters - only logs for specific user
logger.dev('User specific debug', { 
  res,
  value: 456,
  _matchers: { user: 'alice' }
});

// With assertion - only logs if assertion FAILS
logger.dev('Value should be positive', {
  res,
  value: -5
}, (meta) => meta.value > 0);  // Logs because assertion fails

// Multiple filters
logger.dev('Debug info', {
  res,
  _matchers: {
    users: ['alice', 'bob'],  // Array of allowed users
    app: 'photos'
  }
});
```

### Express.js Integration

```javascript
import express from 'express';
import { createLogManager, BACKUP_PATTERNS } from './lib/logging/logging.mjs';

const app = express();

// Create manager in bootstrap/startup code
const manager = createLogManager(datastore, {
  errorPattern: BACKUP_PATTERNS.SYNCHRONOUS,
  trackPattern: BACKUP_PATTERNS.FLUSH_IDLE
});

const logger = manager.getLogger();

// Add idle detection middleware
app.use(manager.idleTimer.middleware());

// Make logger available to routes (restricted access)
app.use((req, res, next) => {
  req.logger = logger;
  next();
});

// Use logger in routes
app.get('/photos', (req, res) => {
  // Track page visit
  req.logger.track('page_visit', { res });
  
  // Dev logging
  req.logger.dev('Route hit', { res, query: req.query });
  
  // ... handle request
  res.render('photos');
});

app.post('/photos/upload', async (req, res) => {
  try {
    const photo = await uploadPhoto(req.file);
    
    req.logger.track('photo_uploaded', {
      res,
      photo_id: photo.id,
      file_size: req.file.size
    });
    
    res.json({ success: true });
  } catch (err) {
    req.logger.error('Photo upload failed', err, { res });
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  req.logger.error('Request error', err, { res });
  res.status(500).json({ error: 'Internal server error' });
});

// Authentication middleware
app.use((req, res, next) => {
  if (!req.user && requiresAuth(req.path)) {
    req.logger.auth('Unauthorized access attempt', { res });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});
```

## Admin Operations (LogManager)

Only admin/bootstrap code should use LogManager methods:

### Query Logs

```javascript
// Query logs (admin only - logger cannot do this!)
const logs = await manager.queryLogs({
  startDate: '2024-11-20',
  endDate: '2024-11-27',
  user: 'alice',
  app: 'photos',
  level: 'track',  // Can filter by level
  serverKey: 'a3f9d8e2',  // Optional: specific server
  limit: 1000
});

// Query errors
const errors = await manager.queryLogs({
  level: 'error',
  startDate: '2024-11-27'
});

// Query auth attempts
const authAttempts = await manager.queryLogs({
  level: 'auth',
  user: 'alice'
});
```

### Aggregation

```javascript
// Aggregate yesterday's data to hourly summaries
const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);
const dateStr = yesterday.toISOString().split('T')[0];

// Provide server keys for aggregation
const serverKeys = [manager.serverKey];  // Or get all server keys
await manager.aggregation.aggregateToHourly(dateStr, serverKeys);

// Schedule with cron or node-cron
import cron from 'node-cron';

// Run aggregation daily at 3 AM
cron.schedule('0 3 * * *', async () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().split('T')[0];
  
  // Would need to get all server keys for complete aggregation
  await manager.aggregation.aggregateToHourly(dateStr, [manager.serverKey]);
});
```

### Manual Flush

```javascript
// Flush all buffers (usually automatic via idle timer)
await manager.flushAll();

// Flush specific level
await manager.flushBuffer('track');

// Flush to cloud
await manager.flushToCloud();
```

### Graceful Shutdown

```javascript
// Automatic shutdown handlers are set up by manager
// But you can also manually trigger:

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  
  // Stop accepting new requests
  server.close();
  
  // Shutdown logging system (flushes all buffers)
  await manager.shutdown();
  
  process.exit(0);
});
```

## Data Storage Structure

### Local Filesystem (per server)

```
/tmp/freezr-logs/  (or configured localLogsDir)
  2024-11-27.jsonl
  2024-11-26.jsonl
  ...
```

### Cloud Storage (server-specific paths)

```
info.freezr.account/
  logs/
    detailed/
      a3f9d8e2/  ← Server 1 (serverKey)
        2024-11-27.jsonl
        2024-11-26.jsonl
      b4e8f1c3/  ← Server 2
        2024-11-27.jsonl
        2024-11-26.jsonl
  
  analytics/
    users/
      alice/
        photos/
          hourly/
            2024-11-27.json   # Aggregated from all servers
          daily/
            2024-11.json
        todos/
          ...
      bob/
        ...
```

### Database Collections

```javascript
// Error logs (queryable)
{
  _id: "...",
  data_type: "error_log",
  serverKey: "a3f9d8e2",
  level: "error",
  timestamp: "2024-11-27T10:30:00Z",
  message: "Database connection failed",
  error: "Connection timeout",
  stack: "Error: Connection timeout\n  at ...",
  user: "alice",
  app: "photos",
  path: "/photos",
  method: "GET",
  ip: "192.168.1.100"
}

// Auth logs (security audit trail)
{
  _id: "...",
  data_type: "auth_log",
  serverKey: "a3f9d8e2",
  level: "auth",
  timestamp: "2024-11-27T10:30:00Z",
  message: "Unauthorized access attempt",
  user: "unknown",
  ip: "192.168.1.100",
  path: "/api/admin",
  method: "POST",
  session: "invalid_token_abc",
  reason: "invalid_token"
}
```

### JSONL Format Example

```jsonl
{"serverKey":"a3f9d8e2","level":"track","timestamp":"2024-11-27T10:30:00Z","message":"page_visit","user":"alice","app":"photos","path":"/albums"}
{"serverKey":"a3f9d8e2","level":"error","timestamp":"2024-11-27T10:31:15Z","message":"Database timeout","error":"Timeout","user":"bob","app":"todos"}
{"serverKey":"a3f9d8e2","level":"auth","timestamp":"2024-11-27T10:32:00Z","message":"Unauthorized access","ip":"192.168.1.100","path":"/api/admin"}
```

## Multi-Server Support

Each server instance generates a unique `serverKey` on startup:

```javascript
// Server 1
const manager1 = createLogManager(datastore);
console.log(manager1.serverKey);  // "a3f9d8e2"

// Server 2 (different container/instance)
const manager2 = createLogManager(datastore);
console.log(manager2.serverKey);  // "b4e8f1c3"
```

**Benefits:**
- No write conflicts (each server writes to its own path)
- Can identify which server logged what (debugging)
- Can see load distribution across servers
- Aggregation combines data from all servers
- If one server crashes, others unaffected

**Aggregation across servers:**
```javascript
// Get all server keys (would need to implement directory listing)
const serverKeys = await manager.getServerKeys();

// Aggregate data from all servers
await manager.aggregation.aggregateToHourly('2024-11-27', serverKeys);
```

## Security Model

### Logger (Restricted)
- ❌ Cannot read logs from cloud storage
- ❌ Cannot query logs
- ❌ Cannot access other users' data
- ❌ Cannot write to arbitrary files
- ❌ Cannot access datastore directly
- ✅ Can write to its designated local log file
- ✅ Can buffer events in memory

### LogManager (Privileged)
- ✅ Full datastore access
- ✅ Can query all logs
- ✅ Can access all users' data
- ✅ Can read/write/delete files
- ✅ Can perform aggregations
- ✅ Controls cloud sync

**Best Practice:**
```javascript
// In bootstrap/main.js (privileged)
const manager = createLogManager(datastore, config);
const logger = manager.getLogger();

// Pass only logger to application code (restricted)
export { logger };  // Safe to expose
// Don't export manager!  // Keep privileged

// In routes/controllers (application code)
import { logger } from '../main.js';

app.get('/route', (req, res) => {
  logger.track('event', { res });  // Safe - restricted access
});
```

## Automatic Metadata Extraction

When you pass `res` in metadata, the logger automatically extracts:

```javascript
logger.track('page_visit', { res });

// Automatically becomes:
{
  serverKey: "a3f9d8e2",
  level: "track",
  timestamp: "2024-11-27T10:30:00Z",
  message: "page_visit",
  user: "alice",           // from res.session.user_id
  session: "abc123",       // from res.session.session_code
  app: "photos",           // from res.locals.app_name
  path: "/albums",         // from res.req.path
  method: "GET",           // from res.req.method
  ip: "192.168.1.100"      // from res.req.ip
}
```

You can still add custom metadata:

```javascript
logger.track('photo_uploaded', {
  res,  // Auto-extracted
  photo_id: photo.id,  // Custom
  file_size: 2048000   // Custom
});
```

## Performance Considerations

### Buffer Sizes

- **Small buffers** (10-50): More frequent writes, lower memory usage, higher I/O
- **Large buffers** (100-500): Less frequent writes, higher memory usage, lower I/O
- **Recommendation**: Start with defaults (50 for logs, 100 for track), adjust based on traffic

### Flush Intervals

- **Frequent** (10-30s): More up-to-date logs, higher I/O
- **Infrequent** (60-120s): Less I/O, potential for more data loss on crash
- **Recommendation**: 30s for warnings, 60s for track events

### Cloud Sync Interval

- **Frequent** (1-2 min): More up-to-date cloud backup, higher cloud I/O
- **Infrequent** (10-30 min): Less cloud I/O, more local storage needed
- **Recommendation**: 5 minutes (default)

### Idle Detection

- **Short threshold** (2-5s): More aggressive flushing, better for low-traffic servers
- **Long threshold** (10-30s): Less aggressive, better for high-traffic servers
- **Recommendation**: 5s for personal servers, 10-15s for production

## Synchronous API with Deferred Persistence

### Current Implementation

The logging system uses a **synchronous API** with **deferred async persistence**:

- **Console output**: Happens immediately (synchronous)
- **File writes**: Deferred using `setImmediate()` to avoid blocking requests
- **All methods are sync**: No `await` needed - can be called from non-async functions

```javascript
// Sync API - works from anywhere
flogger.info('User logged in');
flogger.error('Something failed', error);

// Console appears immediately, file writes happen in background
```

### Known Risks and Limitations

While this design provides a convenient non-blocking API, be aware of these potential issues:

#### 1. **SYNCHRONOUS Pattern Semantics**

**Issue**: Errors and auth logs use `SYNCHRONOUS` pattern, which is meant to write immediately. However, with deferred persistence, they're not truly synchronous.

**Risk**: Critical errors may not be persisted if the process exits immediately after logging.

**Impact**: Low - `setImmediate` typically executes within milliseconds, but not guaranteed on process exit.

#### 2. **Race Condition with Idle Timer**

**Issue**: The idle timer may flush buffers before `setImmediate` callbacks add events to buffers.

**Risk**: Logs could be lost or flushed out of order if:
- Server becomes idle
- Idle timer flushes empty buffer
- `setImmediate` adds event after flush completes

**Impact**: Medium - More likely under high load or rapid idle/active cycles.

#### 3. **Buffer Threshold Timing**

**Issue**: Threshold checks happen synchronously, but events are added asynchronously.

**Risk**: Threshold may be missed, delaying flushes until next check.

**Impact**: Low - Events will still flush on next threshold check or idle timer.

#### 4. **Log Loss on Crash**

**Issue**: If the process crashes before `setImmediate` callbacks execute, deferred logs are lost.

**Risk**: Critical error logs may not be persisted during crashes.

**Impact**: Medium - Console output still appears, but file writes may be lost.

#### 5. **Error Handling**

**Issue**: Errors in async persistence are caught internally but not surfaced to callers.

**Risk**: Silent failures - logging errors won't be visible to application code.

**Impact**: Low - Errors are logged to console, but application can't react to them.

### Monitoring for Issues

Watch for these signs that you may be experiencing the above issues:

- **Missing logs in files**: Logs appear in console but not in persisted storage
- **Out-of-order logs**: Logs appear in unexpected sequence
- **Empty buffers on flush**: Idle timer reports flushing but buffers are empty
- **Missing critical errors**: Error logs don't appear in error_log collection

### Hybrid Solution (Fallback)

If you encounter issues with the current implementation, consider implementing a **hybrid approach** that keeps critical logs truly synchronous while deferring non-critical logs:

```javascript
log(level, message, errorOrMetadata = {}, metadata = {}) {
  // ... create event, console.log (sync) ...
  
  const pattern = this.backupPatterns[level];
  
  // CRITICAL: Keep errors/auth truly synchronous (fire-and-forget async)
  if (pattern.shouldFlushImmediately()) {
    // Start immediately, don't await (non-blocking but immediate)
    (async () => {
      try {
        await this.writeEventToLocal(level, event);
        if (level === 'error') await this.writeErrorToDBFn(event);
        if (level === 'auth') await this.writeAuthToDBFn(event);
      } catch (err) {
        console.error(`[Logger] Failed to write ${level}:`, err);
      }
    })();
    return; // Don't await, but start immediately
  }
  
  // NON-CRITICAL: Defer buffered logs
  if (!pattern.isNone()) {
    setImmediate(() => {
      this.buffers[level].push(event);
      if (pattern.shouldFlushOnThreshold(this.buffers[level].length)) {
        this.flushBuffer(level).catch(err => 
          console.error(`[Logger] Flush error:`, err)
        );
      }
    });
  }
}
```

**Benefits of Hybrid Approach:**
- ✅ Critical logs (errors/auth) start immediately (fire-and-forget async)
- ✅ Non-critical logs (buffered) are deferred to avoid blocking
- ✅ Reduces race conditions (critical logs don't use buffers)
- ✅ Better crash resilience for critical logs
- ✅ Still non-blocking (doesn't await async operations)

**When to Use Hybrid:**
- You're experiencing missing critical error logs
- You notice race conditions with idle timer
- You need guaranteed persistence for errors/auth
- You're running in high-crash-risk environments

**Implementation Note:**
The hybrid approach requires modifying the `Logger.log()` method in `logging.mjs`. The API remains the same (sync methods), but the internal persistence strategy changes.

## Troubleshooting

### Logs not appearing

1. Check if buffers are being flushed:
   ```javascript
   await manager.flushAll();
   ```

2. Check idle timer is receiving activity:
   ```javascript
   // Make sure middleware is installed
   app.use(manager.idleTimer.middleware());
   ```

3. Check backup patterns are configured:
   ```javascript
   // Synchronous writes for immediate persistence
   errorPattern: BACKUP_PATTERNS.SYNCHRONOUS
   ```

### Cannot query logs from application code

This is by design! Only LogManager can query logs:

```javascript
// ❌ Wrong - logger cannot query
const logs = await logger.queryLogs({ user: 'alice' });  // Error!

// ✅ Correct - use manager
const logs = await manager.queryLogs({ user: 'alice' });
```

### Multi-server aggregation missing data

Make sure to provide all server keys:

```javascript
// Get all server keys (you'll need to implement this)
const serverKeys = await getAllServerKeys();

// Aggregate from all servers
await manager.aggregation.aggregateToHourly(date, serverKeys);
```

### Pino not working

1. Check pino is installed:
   ```bash
   npm list pino
   ```

2. Check configuration:
   ```javascript
   const manager = createLogManager(datastore, {
     loggerType: 'pino',
     pinoOptions: { /* ... */ }
   });
   ```

3. System will automatically fall back to SimpleLogger if pino unavailable

### High memory usage

1. Reduce buffer thresholds:
   ```javascript
   infoBufferThreshold: 25,
   trackBufferThreshold: 50
   ```

2. Use more aggressive flushing:
   ```javascript
   trackPattern: BACKUP_PATTERNS.FLUSH_THRESHOLD,
   cloudSyncInterval: 2 * 60 * 1000  // 2 minutes
   ```

## Best Practices

1. **Only expose Logger to application code**, keep Manager in bootstrap
2. **Use track() for analytics events**, not info()
3. **Always pass `res` for automatic metadata extraction**
4. **Use dev() with filters for debugging specific users/apps**
5. **Set up aggregation cron jobs** to process data regularly
6. **Monitor local disk usage** if cloud sync fails
7. **Implement getServerKeys()** for multi-server deployments
8. **Use SYNCHRONOUS pattern for critical logs** (errors, auth)
9. **Use FLUSH_IDLE for high-volume events** (track)
10. **Test shutdown handlers** to ensure data isn't lost
11. **Monitor for missing logs** - Check that console logs appear in persisted storage
12. **Consider hybrid approach** if you experience log loss issues (see "Synchronous API with Deferred Persistence" section)

## License

MIT
