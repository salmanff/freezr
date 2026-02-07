// account_logviewer.js
let allFetchedLogs = []; // Store all fetched logs for client-side filtering

freezr.initPageScripts = function () {
  console.log('account_logviewer.js loaded');
  document.getElementById('getDataBtn').onclick = getData;
  document.getElementById('setToday').onclick = setToday;
  document.getElementById('setLast7Days').onclick = setLast7Days;
  
  // Add event listeners for filtering (no fetch, just filter)
  document.getElementById('userFilter').addEventListener('change', applyFilters);
  document.getElementById('levelFilter').addEventListener('change', applyFilters);
  document.getElementById('viewMode').addEventListener('change', applyFilters);

  // Set default dates
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('endDate').value = today;
  document.getElementById('startDate').value = today;
}


function setToday() {
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('startDate').value = today;
  document.getElementById('endDate').value = today;
}

function setLast7Days() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 6);
  
  document.getElementById('endDate').value = end.toISOString().split('T')[0];
  document.getElementById('startDate').value = start.toISOString().split('T')[0];
}

async function getData() {
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;
  
  if (!startDate || !endDate) {
    alert('Please select start and end dates');
    return;
  }
  
  const dataShown = document.getElementById('dataShown');
  dataShown.innerHTML = '<div class="loading">Loading logs</div>';
  
  try {
    // Fetch all logs without filters
    allFetchedLogs = await getLogsForDays(startDate, endDate, {});
    
    // Populate dropdowns based on fetched data
    populateUserFilter(allFetchedLogs);
    populateLevelFilter(allFetchedLogs);
    
    // Apply initial filters and render
    applyFilters();
  } catch (err) {
    dataShown.innerHTML = `<div class="no-data" style="color: #dc3545;">❌ Error loading logs: ${err.message}</div>`;
    console.error('Error loading logs:', err);
    allFetchedLogs = [];
  }
}

function applyFilters() {
  if (allFetchedLogs.length === 0) {
    return; // No data to filter
  }
  
  const user = document.getElementById('userFilter').value;
  const level = document.getElementById('levelFilter').value;
  const viewMode = document.getElementById('viewMode').value;
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;
  
  // Filter logs client-side
  let filteredLogs = [...allFetchedLogs];
  
  // Filter by user
  if (user) {
    if (user === '_noUser') {
      filteredLogs = filteredLogs.filter(log => !log.meta?.user);
    } else {
      filteredLogs = filteredLogs.filter(log => log.meta?.user === user);
    }
  }
  
  // Filter by level
  if (level) {
    filteredLogs = filteredLogs.filter(log => log.level === level);
  }
  
  // Render based on view mode
  const freezerTextureInner = document.querySelector('.freezer_texture_inner');
  if (viewMode === 'summary') {
    if (freezerTextureInner) freezerTextureInner.style.maxWidth = '1200px';
    renderSummary(filteredLogs, startDate, endDate);
  } else if (viewMode === 'timeline') {
      // Set max-width of freezer_texture_inner to null
    if (freezerTextureInner) freezerTextureInner.style.maxWidth = '2000px';
    renderTimeline(filteredLogs, startDate, endDate);
  } else {
    if (freezerTextureInner) freezerTextureInner.style.maxWidth = '1200px';
    renderLogs(filteredLogs);
  }
}

function populateUserFilter(logs) {
  const users = new Set();
  let hasNullUser = false;
  
  logs.forEach(log => {
    if (log.meta?.user) {
      users.add(log.meta.user);
    } else {
      hasNullUser = true;
    }
  });
  
  const userFilter = document.getElementById('userFilter');
  const currentValue = userFilter.value;
  
  // Clear all options
  userFilter.innerHTML = '';
  
  // Check if there's only one user and no null users
  if (users.size === 1 && !hasNullUser) {
    // Just show that one user
    const singleUser = Array.from(users)[0];
    const option = document.createElement('option');
    option.value = singleUser;
    option.textContent = singleUser;
    userFilter.appendChild(option);
    userFilter.value = singleUser;
  } else {
    // Add "All Users" option
    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = 'All Users';
    userFilter.appendChild(allOption);
    
    // Add "No User" option if there are null users
    if (hasNullUser) {
      const noUserOption = document.createElement('option');
      noUserOption.value = '_noUser';
      noUserOption.textContent = 'No User (Unauthenticated)';
      userFilter.appendChild(noUserOption);
    }
    
    // Add discovered users
    Array.from(users).sort().forEach(user => {
      const option = document.createElement('option');
      option.value = user;
      option.textContent = user;
      userFilter.appendChild(option);
    });
    
    // Restore selected value if it still exists, otherwise default to "All Users"
    if (currentValue && Array.from(userFilter.options).some(opt => opt.value === currentValue)) {
      userFilter.value = currentValue;
    } else {
      userFilter.value = '';
    }
  }
}

function populateLevelFilter(logs) {
  const levels = new Set();
  logs.forEach(log => {
    if (log.level) {
      levels.add(log.level);
    }
  });
  
  const levelFilter = document.getElementById('levelFilter');
  const currentValue = levelFilter.value;
  
  // Clear all options
  levelFilter.innerHTML = '';
  
  // Add "All Levels" option
  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = 'All Levels';
  levelFilter.appendChild(allOption);
  
  // Add available levels in a specific order
  const levelOrder = ['error', 'warn', 'auth', 'track', 'info', 'debug'];
  levelOrder.forEach(level => {
    if (levels.has(level)) {
      const option = document.createElement('option');
      option.value = level;
      option.textContent = level.charAt(0).toUpperCase() + level.slice(1);
      levelFilter.appendChild(option);
    }
  });
  
  // Add any other levels not in the standard list
  Array.from(levels).sort().forEach(level => {
    if (!levelOrder.includes(level)) {
      const option = document.createElement('option');
      option.value = level;
      option.textContent = level.charAt(0).toUpperCase() + level.slice(1);
      levelFilter.appendChild(option);
    }
  });
  
  // Restore selected value if it still exists, otherwise default to "All Levels"
  if (currentValue && Array.from(levelFilter.options).some(opt => opt.value === currentValue)) {
    levelFilter.value = currentValue;
  } else {
    levelFilter.value = '';
  }
}

function formatCount(count) {
  return count === 0 ? '-' : count;
}

function renderTimeline(logs, startDate, endDate) {
  const dataShown = document.getElementById('dataShown');
  
  if (logs.length === 0) {
    dataShown.innerHTML = '<div class="no-data">No logs found for the selected filters</div>';
    return;
  }
  
  // Check if we have more than one day
  const start = new Date(startDate);
  const end = new Date(endDate);
  const daysDiff = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
  
  if (daysDiff <= 1) {
    dataShown.innerHTML = '<div class="no-data">Timeline view requires more than one day. Please select a date range with multiple days.</div>';
    return;
  }
  
  // Generate array of dates (most recent first)
  const dates = [];
  const currentDate = new Date(start);
  while (currentDate <= end) {
    dates.push(new Date(currentDate));
    currentDate.setDate(currentDate.getDate() + 1);
  }
  // Reverse to show most recent date first
  dates.reverse();
  
  // Group logs by date
  const logsByDate = {};
  dates.forEach(date => {
    const dateStr = date.toISOString().split('T')[0];
    logsByDate[dateStr] = logs.filter(log => {
      const logDate = new Date(log.timestamp).toISOString().split('T')[0];
      return logDate === dateStr;
    });
  });
  
  // Calculate metrics for each date
  const metricsByDate = {};
  dates.forEach(date => {
    const dateStr = date.toISOString().split('T')[0];
    const dayLogs = logsByDate[dateStr] || [];
    metricsByDate[dateStr] = calculateDayMetrics(dayLogs);
  });
  
  // Get top applications and paths across all days
  const allApps = {};
  const allPaths = {};
  logs.forEach(log => {
    const appName = extractAppName(log);
    if (appName) {
      allApps[appName] = (allApps[appName] || 0) + 1;
    }
    if (log.meta?.path) {
      allPaths[log.meta.path] = (allPaths[log.meta.path] || 0) + 1;
    }
  });
  
  const topApps = Object.entries(allApps)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([app]) => app);
  
  const topPaths = Object.entries(allPaths)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([path]) => path);
  
  // Build timeline table
  let html = `
    <div style="margin-bottom: 24px;">
      <h2 style="font-size: 20px; color: #333; margin-bottom: 8px;">
        Timeline: ${startDate} to ${endDate}
      </h2>
      <p style="color: #666; font-size: 14px;">
        Total logs: ${logs.length} across ${daysDiff} days
      </p>
    </div>
    
    <div class="timeline-container">
      <table class="timeline-table">
        <thead>
          <tr>
            <th class="timeline-metric-header">Metric</th>
  `;
  
  // Add date headers
  dates.forEach(date => {
    const dateStr = date.toISOString().split('T')[0];
    const displayDate = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    html += `<th class="timeline-date-header">${displayDate}</th>`;
  });
  
  html += `
          </tr>
        </thead>
        <tbody>
  `;
  
  // Total Page Views row
  html += '<tr><td class="timeline-metric-label">Total Page Views</td>';
  dates.forEach(date => {
    const dateStr = date.toISOString().split('T')[0];
    const count = metricsByDate[dateStr]?.pageViews || 0;
    html += `<td class="timeline-value">${formatCount(count)}</td>`;
  });
  html += '</tr>';
  
  // Total API Calls row
  html += '<tr><td class="timeline-metric-label">Total API Calls</td>';
  dates.forEach(date => {
    const dateStr = date.toISOString().split('T')[0];
    const count = metricsByDate[dateStr]?.apiCalls || 0;
    html += `<td class="timeline-value">${formatCount(count)}</td>`;
  });
  html += '</tr>';
  
  // Errors row
  html += '<tr><td class="timeline-metric-label">Errors</td>';
  dates.forEach(date => {
    const dateStr = date.toISOString().split('T')[0];
    const count = metricsByDate[dateStr]?.errors || 0;
    html += `<td class="timeline-value ${count > 0 ? 'timeline-error' : ''}">${formatCount(count)}</td>`;
  });
  html += '</tr>';
  
  // Auth Failures row
  html += '<tr><td class="timeline-metric-label">Auth Failures</td>';
  dates.forEach(date => {
    const dateStr = date.toISOString().split('T')[0];
    const count = metricsByDate[dateStr]?.authFailures || 0;
    html += `<td class="timeline-value ${count > 0 ? 'timeline-warning' : ''}">${formatCount(count)}</td>`;
  });
  html += '</tr>';
  
  // Calculate top 5 users by total activity
  const userActivity = {};
  logs.forEach(log => {
    const user = log.meta?.user || '_noUser';
    if (!userActivity[user]) {
      userActivity[user] = 0;
    }
    userActivity[user]++;
  });
  
  const topUsers = Object.entries(userActivity)
    .filter(([user]) => user !== '_noUser') // Exclude unauthenticated users from top users
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([user]) => user);
  
  // Top Users rows - grouped by metric type (only show if more than one user)
  if (topUsers.length > 1) {
    html += '<tr><td class="timeline-section-header" colspan="' + (dates.length + 1) + '">Top Users</td></tr>';
    
    // Page Views section
    html += '<tr><td class="timeline-subsection-header" colspan="' + (dates.length + 1) + '">Page Views by User</td></tr>';
    topUsers.forEach(user => {
      html += `<tr><td class="timeline-metric-label user-metric">${escapeHtml(user)}</td>`;
      dates.forEach(date => {
        const dateStr = date.toISOString().split('T')[0];
        const dayLogs = logsByDate[dateStr] || [];
        const count = dayLogs.filter(log => {
          const firstMsg = log.messages?.find(m => typeof m === 'string');
          return log.meta?.user === user && log.level === 'track' && firstMsg === 'page';
        }).length;
        html += `<td class="timeline-value">${formatCount(count)}</td>`;
      });
      html += '</tr>';
    });
    
    // API Calls section
    html += '<tr><td class="timeline-subsection-header" colspan="' + (dates.length + 1) + '">API Calls by User</td></tr>';
    topUsers.forEach(user => {
      html += `<tr><td class="timeline-metric-label user-metric">${escapeHtml(user)}</td>`;
      dates.forEach(date => {
        const dateStr = date.toISOString().split('T')[0];
        const dayLogs = logsByDate[dateStr] || [];
        const count = dayLogs.filter(log => {
          const firstMsg = log.messages?.find(m => typeof m === 'string');
          return log.meta?.user === user && log.level === 'track' && firstMsg === 'api';
        }).length;
        html += `<td class="timeline-value">${formatCount(count)}</td>`;
      });
      html += '</tr>';
    });
    
    // Auth Failures section
    html += '<tr><td class="timeline-subsection-header" colspan="' + (dates.length + 1) + '">Auth Failures by User</td></tr>';
    topUsers.forEach(user => {
      html += `<tr><td class="timeline-metric-label user-metric">${escapeHtml(user)}</td>`;
      dates.forEach(date => {
        const dateStr = date.toISOString().split('T')[0];
        const dayLogs = logsByDate[dateStr] || [];
        const count = dayLogs.filter(log => {
          return log.meta?.user === user && log.level === 'auth';
        }).length;
        html += `<td class="timeline-value ${count > 0 ? 'timeline-warning' : ''}">${formatCount(count)}</td>`;
      });
      html += '</tr>';
    });
    
    // Errors section
    html += '<tr><td class="timeline-subsection-header" colspan="' + (dates.length + 1) + '">Errors by User</td></tr>';
    topUsers.forEach(user => {
      html += `<tr><td class="timeline-metric-label user-metric">${escapeHtml(user)}</td>`;
      dates.forEach(date => {
        const dateStr = date.toISOString().split('T')[0];
        const dayLogs = logsByDate[dateStr] || [];
        const count = dayLogs.filter(log => {
          return log.meta?.user === user && log.level === 'error';
        }).length;
        html += `<td class="timeline-value ${count > 0 ? 'timeline-error' : ''}">${formatCount(count)}</td>`;
      });
      html += '</tr>';
    });
  }
  
  // Top Applications rows
  if (topApps.length > 0) {
    html += '<tr><td class="timeline-section-header" colspan="' + (dates.length + 1) + '">Top Applications</td></tr>';
    topApps.forEach(app => {
      html += `<tr><td class="timeline-metric-label">${escapeHtml(app)}</td>`;
      dates.forEach(date => {
        const dateStr = date.toISOString().split('T')[0];
        const dayLogs = logsByDate[dateStr] || [];
        const count = dayLogs.filter(log => {
          const appName = extractAppName(log);
          return appName === app && log.level === 'track';
        }).length;
        html += `<td class="timeline-value">${formatCount(count)}</td>`;
      });
      html += '</tr>';
    });
  }
  
  // Top Paths rows
  if (topPaths.length > 0) {
    html += '<tr><td class="timeline-section-header" colspan="' + (dates.length + 1) + '">Top Paths</td></tr>';
    topPaths.forEach(path => {
      html += `<tr><td class="timeline-metric-label path-label">${escapeHtml(path)}</td>`;
      dates.forEach(date => {
        const dateStr = date.toISOString().split('T')[0];
        const dayLogs = logsByDate[dateStr] || [];
        const count = dayLogs.filter(log => log.meta?.path === path).length;
        html += `<td class="timeline-value">${formatCount(count)}</td>`;
      });
      html += '</tr>';
    });
  }
  
  html += `
        </tbody>
      </table>
    </div>
  `;
  
  dataShown.innerHTML = html;
}

function calculateDayMetrics(logs) {
  const metrics = {
    pageViews: 0,
    apiCalls: 0,
    errors: 0,
    authFailures: 0
  };
  
  logs.forEach(log => {
    const firstMsg = log.messages?.find(m => typeof m === 'string');
    
    if (log.level === 'track') {
      if (firstMsg === 'page') metrics.pageViews++;
      else if (firstMsg === 'api') metrics.apiCalls++;
    }
    
    if (log.level === 'error') {
      metrics.errors++;
    }
    
    if (log.level === 'auth') {
      metrics.authFailures++;
    }
  });
  
  return metrics;
}

function renderLogs(logs) {
  const dataShown = document.getElementById('dataShown');
  
  if (logs.length === 0) {
    dataShown.innerHTML = '<div class="no-data">No logs found for the selected filters</div>';
    return;
  }
  
  let html = `<div style="margin-bottom: 16px; color: #666;">Showing ${logs.length} log entries</div>`;
  
  logs.forEach(log => {
    const level = log.level || 'info';
    const timestamp = new Date(log.timestamp).toLocaleString();
    const messages = log.messages || [];
    const meta = log.meta || {};
    
    html += `
      <div class="log-entry ${level}">
        <div class="log-header">
          <span class="log-level ${level}">${level}</span>
          <span class="log-timestamp">${timestamp}</span>
        </div>
        <div class="log-meta">
          ${meta.user ? `<span>User: <strong>${meta.user}</strong></span>` : ''}
          ${meta.app ? `<span>App: <strong>${meta.app}</strong></span>` : ''}
          ${meta.path ? `<span>Path: <strong>${meta.path}</strong></span>` : ''}
          ${meta.device ? `<span>Device: <strong>${meta.device.substring(0, 8)}...</strong></span>` : ''}
          ${meta.ip ? `<span>IP: <strong>${meta.ip}</strong></span>` : ''}
          ${log.serverKey ? `<span>Server: <strong>${log.serverKey.substring(0, 8)}</strong></span>` : ''}
        </div>
        <div class="log-message">
          ${renderMessages(messages, log.error, log.errorStack)}
        </div>
      </div>
    `;
  });
  
  dataShown.innerHTML = html;
}

function renderMessages(messages, error, errorStack) {
  let html = '';
  
  messages.forEach(msg => {
    if (typeof msg === 'string') {
      html += `<div>${escapeHtml(msg)}</div>`;
    } else if (typeof msg === 'object') {
      html += `<pre>${JSON.stringify(msg, null, 2)}</pre>`;
    }
  });
  
  if (error) {
    html += `<pre style="color: #dc3545;"><strong>Error:</strong> ${escapeHtml(error)}\n${escapeHtml(errorStack || '')}</pre>`;
  }
  
  return html || '<em style="color: #999;">No message</em>';
}

function renderSummary(logs, startDate, endDate) {
  const dataShown = document.getElementById('dataShown');
  
  if (logs.length === 0) {
    dataShown.innerHTML = '<div class="no-data">No logs found for the selected filters</div>';
    return;
  }
  
  // Generate summary using same algorithm as backend
  const summary = generateSummary(logs);
  
  let html = `
    <div style="margin-bottom: 24px;">
      <h2 style="font-size: 20px; color: #333; margin-bottom: 8px;">
        Summary: ${startDate} to ${endDate}
      </h2>
      <p style="color: #666; font-size: 14px;">
        Total logs analyzed: ${logs.length} across ${Object.keys(summary).length} users
      </p>
    </div>
    
    <div class="stats-grid">
      <div class="stat-card">
        <div class="label">Total Page Views</div>
        <div class="value">${getTotalCount(summary, 'pageViews')}</div>
      </div>
      <div class="stat-card">
        <div class="label">Total API Calls</div>
        <div class="value">${getTotalCount(summary, 'apiCalls')}</div>
      </div>
      <div class="stat-card">
        <div class="label">Total Errors</div>
        <div class="value">${getTotalCount(summary, 'errors')}</div>
      </div>
      <div class="stat-card">
        <div class="label">Auth Failures</div>
        <div class="value">${getTotalCount(summary, 'authFailures')}</div>
      </div>
    </div>
  `;
  
  // Render each user's summary
  Object.entries(summary).forEach(([user, userSummary]) => {
    html += renderUserSummary(user, userSummary);
  });
  
  dataShown.innerHTML = html;
}

function generateSummary(logs) {
  const byUser = {};
  
  logs.forEach(log => {
    const user = log.meta?.user || '_noUser';
    
    if (!byUser[user]) {
      byUser[user] = {
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
    const firstMsg = log.messages?.find(m => typeof m === 'string');
    
    // Count by message type (for track level)
    if (log.level === 'track') {
      if (firstMsg === 'page') userSummary.counts.pageViews++;
      else if (firstMsg === 'api') userSummary.counts.apiCalls++;
      else if (firstMsg === 'file') userSummary.counts.fileAccess++;
      
      // Track by app
      const appName = extractAppName(log);
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
        path: log.meta?.path
      });
    }
    
    // Count auth events
    if (log.level === 'auth') {
      userSummary.counts.authFailures++;
      const authType = firstMsg || 'unknown';
      userSummary.authEvents[authType] = (userSummary.authEvents[authType] || 0) + 1;
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
  });
  
  // Convert Sets and sort
  Object.values(byUser).forEach(summary => {
    summary.ipAddresses = Array.from(summary.ipAddresses);
    summary.topPaths = Object.entries(summary.topPaths)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
  });
  
  return byUser;
}

function extractAppName(log) {
  if (log.meta?.app) return log.meta.app;
  
  for (const msg of log.messages || []) {
    if (typeof msg === 'object' && msg !== null) {
      if (msg.app_name) return msg.app_name;
      if (msg.app) return msg.app;
    }
  }
  
  return null;
}

function renderUserSummary(user, summary) {
  const displayName = user === '_noUser' ? '👤 Unauthenticated Users' : `👤 ${user}`;
  
  let html = `
    <div class="summary-section">
      <h2>${displayName}</h2>
      
      <div class="user-summary">
        <h3>Activity Metrics</h3>
        <div class="metric-grid">
          <div class="metric">
            <div class="label">Page Views</div>
            <div class="value">${summary.counts.pageViews}</div>
          </div>
          <div class="metric">
            <div class="label">API Calls</div>
            <div class="value">${summary.counts.apiCalls}</div>
          </div>
          <div class="metric">
            <div class="label">File Access</div>
            <div class="value">${summary.counts.fileAccess}</div>
          </div>
          <div class="metric">
            <div class="label">Errors</div>
            <div class="value" style="color: #dc3545;">${summary.counts.errors}</div>
          </div>
          <div class="metric">
            <div class="label">Auth Failures</div>
            <div class="value" style="color: #ff6b6b;">${summary.counts.authFailures}</div>
          </div>
          <div class="metric">
            <div class="label">Devices</div>
            <div class="value">${Object.keys(summary.devices).length}</div>
          </div>
        </div>
      </div>
  `;
  
  // Apps
  if (Object.keys(summary.byApp).length > 0) {
    html += `
      <div class="user-summary">
        <h3>By Application</h3>
        <div class="metric-grid">
    `;
    
    Object.entries(summary.byApp).forEach(([app, stats]) => {
      html += `
        <div class="metric">
          <div class="label">${app}</div>
          <div class="value">${stats.pageViews + stats.apiCalls + stats.fileAccess}</div>
          <div style="font-size: 11px; color: #666; margin-top: 4px;">
            ${stats.pageViews}p / ${stats.apiCalls}a / ${stats.errors}e
          </div>
        </div>
      `;
    });
    
    html += `
        </div>
      </div>
    `;
  }
  
  // Top Paths
  if (summary.topPaths.length > 0) {
    html += `
      <div class="user-summary">
        <h3>Top Paths</h3>
        <div class="path-list">
    `;
    
    summary.topPaths.forEach(([path, count]) => {
      html += `
        <div class="path-item">
          <span class="path">${escapeHtml(path)}</span>
          <span class="count">${count}</span>
        </div>
      `;
    });
    
    html += `
        </div>
      </div>
    `;
  }
  
  // Devices
  if (Object.keys(summary.devices).length > 0) {
    html += `
      <div class="user-summary">
        <h3>Devices (${Object.keys(summary.devices).length})</h3>
        <div class="device-list">
    `;
    
    Object.keys(summary.devices).forEach(device => {
      html += `<span class="device-tag">${device.substring(0, 12)}...</span>`;
    });
    
    html += `
        </div>
      </div>
    `;
  }
  
  // IP Addresses
  if (summary.ipAddresses.length > 0) {
    html += `
      <div class="user-summary">
        <h3>IP Addresses (${summary.ipAddresses.length})</h3>
        <div class="ip-list">
    `;
    
    summary.ipAddresses.forEach(ip => {
      html += `<span class="ip-tag">${ip}</span>`;
    });
    
    html += `
        </div>
      </div>
    `;
  }
  
  // Errors
  if (summary.errors.length > 0) {
    html += `
      <div class="user-summary">
        <h3>Recent Errors (${summary.errors.length})</h3>
        <div class="error-list">
    `;
    
    summary.errors.slice(0, 10).forEach(error => {
      html += `
        <div class="error-item">
          <div style="font-weight: 600; color: #dc3545;">${escapeHtml(error.message || 'Unknown error')}</div>
          <div style="font-size: 11px; color: #666; margin-top: 2px;">
            ${new Date(error.timestamp).toLocaleString()} 
            ${error.path ? `• ${escapeHtml(error.path)}` : ''}
          </div>
        </div>
      `;
    });
    
    html += `
        </div>
      </div>
    `;
  }
  
  html += `</div>`;
  return html;
}

function getTotalCount(summary, countKey) {
  return Object.values(summary).reduce((sum, user) => {
    return sum + (user.counts[countKey] || 0);
  }, 0);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

// Placeholder functions - these should be replaced with actual API calls
async function getAllLogs(day, options) {
  // This should call your backend API
  // e.g., return fetch(`/api/logs?date=${day}&user=${options.user}...`).then(r => r.json());
  console.log('getAllLogs called with:', day, options);
  throw new Error('getAllLogs() not implemented - connect to your backend API');
}

async function getLogsForDays(start, end, options) {
  // This should call your backend API
  // e.g., return fetch(`/api/logs?start=${start}&end=${end}&user=${options.user}...`).then(r => r.json());


  const fetchResponse = await fetch('/acctapi/getlogs?startDate=' + start + '&endDate=' + end, {
    headers: { Authorization: ('Bearer ' + freezr.utils.getCookie('app_token_' + freezrMeta.userId)) }
  })
  const resp = await fetchResponse.json()
  console.log('🔍 resp:', resp)
  console.log('getLogsForDays called with:', {start, end, options, logs: resp.logs});
  return resp.logs

}