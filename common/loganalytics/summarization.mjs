// ============================================
// summarization.mjs
// FREEZR LOG SUMMARIZATION & AGGREGATION
// Separate from core logging for independent evolution
// ES Module version
// ============================================

// Current summary version - increment when structure changes
const SUMMARY_VERSION = 1;

// ============================================
// 1. LOG SUMMARIZER
// ============================================

export class LogSummarizer {
  constructor(logManager, dbDatastore) {
    this.logManager = logManager;
    this.dbDatastore = dbDatastore;
  }
  
  /**
   * Get summary for a specific date (all servers)
   * Returns object keyed by user (including '_noUser')
   * @param {string|Date} date - Date to summarize (any format accepted)
   */
  async getSummary(date) {
    // Use logManager's getAll which handles all servers and date normalization
    const logs = await this.logManager.getAll(date);
    
    const byUser = {};
    
    for (const log of logs) {
      const user = log.meta?.user || '_noUser';
      
      // Initialize user summary if needed
      if (!byUser[user]) {
        byUser[user] = {
          summaryVersion: SUMMARY_VERSION,
          date: this.logManager.normalizeDate(date),
          serverKeys: new Set(),
          user,
          counts: {
            pageViews: 0,
            apiCalls: 0,
            fileAccess: 0,
            errors: 0,
            authFailures: 0
          },
          devices: {},
          byApp: {},
          authEvents: {},
          topPaths: {},
          ipAddresses: new Set(),
          errors: []
        };
      }
      
      const userSummary = byUser[user];
      
      // Track server key
      userSummary.serverKeys.add(log.serverKey);
      
      // Extract first string message
      const firstMsg = log.messages?.find(m => typeof m === 'string');
      
      // Count by message type (for track level)
      if (log.level === 'track') {
        if (firstMsg === 'page') userSummary.counts.pageViews++;
        else if (firstMsg === 'api') userSummary.counts.apiCalls++;
        else if (firstMsg === 'file') userSummary.counts.fileAccess++;
        
        // Track by app (from track events)
        const appName = this.extractAppName(log);
        if (appName) {
          if (!userSummary.byApp[appName]) {
            userSummary.byApp[appName] = {
              pageViews: 0,
              apiCalls: 0,
              fileAccess: 0,
              errors: 0
            };
          }
          
          if (firstMsg === 'page') userSummary.byApp[appName].pageViews++;
          else if (firstMsg === 'api') userSummary.byApp[appName].apiCalls++;
          else if (firstMsg === 'file') userSummary.byApp[appName].fileAccess++;
        }
      }
      
      // Count errors
      if (log.level === 'error') {
        userSummary.counts.errors++;
        userSummary.errors.push({
          timestamp: log.timestamp,
          message: firstMsg || log.error,
          path: log.meta?.path,
          app: this.extractAppName(log),
          serverKey: log.serverKey
        });
        
        // Also count error by app
        const appName = this.extractAppName(log);
        if (appName && userSummary.byApp[appName]) {
          userSummary.byApp[appName].errors++;
        }
      }
      
      // Count auth events
      if (log.level === 'auth') {
        userSummary.counts.authFailures++;
        
        // Count by auth event type
        const authType = firstMsg || 'unknown';
        userSummary.authEvents[authType] = (userSummary.authEvents[authType] || 0) + 1;
        
        // For login failures, track details
        if (authType === 'loginFailure') {
          if (!userSummary.authEvents.failedLoginAttempts) {
            userSummary.authEvents.failedLoginAttempts = [];
          }
          
          userSummary.authEvents.failedLoginAttempts.push({
            timestamp: log.timestamp,
            attemptedUser: log.meta?.user || user,
            device: log.meta?.device,
            ip: log.meta?.ip,
            serverKey: log.serverKey
          });
        }
      }
      
      // Track devices
      if (log.meta?.device) {
        if (!userSummary.devices[log.meta.device]) {
          userSummary.devices[log.meta.device] = {
            count: 0,
            firstSeen: log.timestamp,
            lastSeen: log.timestamp
          };
        }
        
        userSummary.devices[log.meta.device].count++;
        userSummary.devices[log.meta.device].lastSeen = log.timestamp;
      }
      
      // Track paths
      if (log.meta?.path) {
        userSummary.topPaths[log.meta.path] = 
          (userSummary.topPaths[log.meta.path] || 0) + 1;
      }
      
      // Track IPs
      if (log.meta?.ip) {
        userSummary.ipAddresses.add(log.meta.ip);
      }
    }
    
    // Post-process: Convert Sets to arrays and sort topPaths
    for (const user in byUser) {
      const summary = byUser[user];
      
      // Convert serverKeys set to array
      summary.serverKeys = Array.from(summary.serverKeys);
      
      // Convert IP set to array
      summary.ipAddresses = Array.from(summary.ipAddresses);
      
      // Convert topPaths to sorted array (top 20)
      summary.topPaths = Object.entries(summary.topPaths)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([path, count]) => ({ path, count }));
    }
    
    return byUser;
  }
  
  /**
   * Extract app name from log event
   * Checks messages array for objects with app_name or app field
   */
  extractAppName(log) {
    // Check meta first
    if (log.meta?.app) return log.meta.app;
    
    // Check messages for app_name or app
    for (const msg of log.messages || []) {
      if (typeof msg === 'object' && msg !== null) {
        if (msg.app_name) return msg.app_name;
        if (msg.app) return msg.app;
      }
    }
    
    return null;
  }
  
  /**
   * Store daily summary in database
   * Creates one document per user per day
   * @param {string|Date} date - Date to summarize
   */
  async storeDailySummaryToDB(date) {
    const dateStr = this.logManager.normalizeDate(date);
    console.log(`[LogSummarizer] Generating summary for ${dateStr}...`);
    
    const summaries = await this.getSummary(date);
    
    console.log(`[LogSummarizer] Storing ${Object.keys(summaries).length} user summaries...`);
    
    for (const [user, summary] of Object.entries(summaries)) {
      try {
        // Create document ID
        const docId = `summary_${dateStr}_${user}_v${SUMMARY_VERSION}`;
        
        // Store in database
        await this.dbDatastore.create(null, {
          _id: docId,
          data_type: 'daily_user_summary',
          ...summary
        });
        
        console.log(`[LogSummarizer] Stored summary for user: ${user}`);
      } catch (err) {
        console.error(`[LogSummarizer] Failed to store summary for ${user}:`, err);
      }
    }
    
    console.log(`[LogSummarizer] Summary storage complete for ${dateStr}`);
  }
  
  /**
   * Schedule daily summary generation
   * Runs at 3 AM every day for previous day
   */
  scheduleDaily() {
    const schedule = () => {
      const now = new Date();
      const tomorrow3AM = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        3, 0, 0
      );
      const msUntil3AM = tomorrow3AM - now;
      
      console.log(`[LogSummarizer] Next summary generation scheduled for ${tomorrow3AM.toLocaleString()}`);
      
      setTimeout(async () => {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        
        console.log(`[LogSummarizer] Running scheduled summary for ${yesterday.toISOString().split('T')[0]}`);
        
        try {
          await this.storeDailySummaryToDB(yesterday);
        } catch (err) {
          console.error(`[LogSummarizer] Failed to generate scheduled summary:`, err);
        }
        
        // Schedule next run
        schedule();
      }, msUntil3AM);
    };
    
    schedule();
    console.log('[LogSummarizer] Daily summary generation scheduled');
  }
  
  /**
   * Query summaries from database
   */
  async querySummaries(filters = {}) {
    const { startDate, endDate, user, limit = 100 } = filters;
    
    const query = { data_type: 'daily_user_summary' };
    
    if (user) {
      query.user = user;
    }
    
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = this.logManager.normalizeDate(startDate);
      if (endDate) query.date.$lte = this.logManager.normalizeDate(endDate);
    }
    
    // Query from database
    const summaries = await this.dbDatastore.query(query, { limit });
    
    return summaries;
  }
  
  /**
   * Get aggregated stats across multiple days
   */
  async getAggregatedStats(startDate, endDate, user = null) {
    const summaries = await this.querySummaries({ startDate, endDate, user });
    
    const aggregated = {
      totalPageViews: 0,
      totalApiCalls: 0,
      totalFileAccess: 0,
      totalErrors: 0,
      totalAuthFailures: 0,
      uniqueDevices: new Set(),
      uniqueIPs: new Set(),
      byApp: {},
      byDate: {}
    };
    
    for (const summary of summaries) {
      aggregated.totalPageViews += summary.counts.pageViews;
      aggregated.totalApiCalls += summary.counts.apiCalls;
      aggregated.totalFileAccess += summary.counts.fileAccess;
      aggregated.totalErrors += summary.counts.errors;
      aggregated.totalAuthFailures += summary.counts.authFailures;
      
      // Collect unique devices and IPs
      Object.keys(summary.devices || {}).forEach(d => aggregated.uniqueDevices.add(d));
      (summary.ipAddresses || []).forEach(ip => aggregated.uniqueIPs.add(ip));
      
      // Aggregate by app
      for (const [app, stats] of Object.entries(summary.byApp || {})) {
        if (!aggregated.byApp[app]) {
          aggregated.byApp[app] = {
            pageViews: 0,
            apiCalls: 0,
            fileAccess: 0,
            errors: 0
          };
        }
        
        aggregated.byApp[app].pageViews += stats.pageViews;
        aggregated.byApp[app].apiCalls += stats.apiCalls;
        aggregated.byApp[app].fileAccess += stats.fileAccess;
        aggregated.byApp[app].errors += stats.errors;
      }
      
      // Aggregate by date
      const date = summary.date;
      if (!aggregated.byDate[date]) {
        aggregated.byDate[date] = {
          pageViews: 0,
          apiCalls: 0,
          errors: 0
        };
      }
      
      aggregated.byDate[date].pageViews += summary.counts.pageViews;
      aggregated.byDate[date].apiCalls += summary.counts.apiCalls;
      aggregated.byDate[date].errors += summary.counts.errors;
    }
    
    // Convert Sets to counts
    aggregated.uniqueDevices = aggregated.uniqueDevices.size;
    aggregated.uniqueIPs = aggregated.uniqueIPs.size;
    
    return aggregated;
  }
}

// ============================================
// 2. FACTORY
// ============================================

export function createLogSummarizer(logManager, dbDatastore) {
  return new LogSummarizer(logManager, dbDatastore);
}

export default {
  createLogSummarizer,
  LogSummarizer,
  SUMMARY_VERSION
};
