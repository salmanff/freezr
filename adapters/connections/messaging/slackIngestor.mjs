// freezr.info - Messaging ingestor: Slack (Socket Mode)
//
// The Slack implementation of the INGESTOR SEAM — the one provider-specific piece
// of the push-based messaging sync. The socket manager
// (features/connections/messaging/services/socketManager.mjs) is provider-blind;
// each provider contributes a createIngestor with this contract:
//
//   createSlackIngestor({ appToken, onActivity, onStatus })
//     → { start(), stop(), getStats() }
//
//   onActivity(activity) — one normalized, CONTENT-FREE activity event:
//     {
//       provider: 'slack',
//       teamId,                // routing key half 1
//       authUserIds: [..],     // routing key half 2 — who the event was delivered FOR
//                              // (Slack's authorizations; ≥1 entry, may be capped at 1
//                              // by Slack even when more users could see the event)
//       conversationId,
//       channelType,           // 'channel' | 'group' | 'im' | 'mpim' (Slack vocab)
//       kind,                  // 'message' | 'edited' | 'deleted'
//       messageId,             // the affected message's id (its ts)
//       at                     // ms — when the EVENT happened (≠ messageId for edits)
//     }
//   onStatus({ event, ... }) — lifecycle notes: 'connected' | 'disconnected' |
//     'reconnect_scheduled' | 'gave_up'. 'disconnected' marks the START of a
//     possible event gap; 'connected' marks its end.
//
// Mechanics proven by scripts/slack-socket-probe.mjs: apps.connections.open mints a
// single-use WSS URL; every envelope MUST be acked or Slack redelivers; Slack sends
// a `disconnect` warning before cycling a socket; there is NO replay for events
// missed while disconnected.
//
// Message text passes through this file transiently inside the raw frame and is
// deliberately never propagated — the activity index stores metadata only.
//
// Uses Node 22's global WebSocket — no dependency.

const OPEN_ENDPOINT = 'https://slack.com/api/apps.connections.open'
const BASE_RECONNECT_MS = 1500
const MAX_RECONNECT_MS = 60 * 1000
const MAX_CONSECUTIVE_FAILURES = 30 // ~30 min of solid failure before giving up

/**
 * @param {Object} opts
 * @param {string} opts.appToken     Slack app-level token (xapp-…, connections:write)
 * @param {(activity: Object) => void} opts.onActivity
 * @param {(status: Object) => void} [opts.onStatus]
 */
export const createSlackIngestor = ({ appToken, onActivity, onStatus }) => {
  if (!appToken || !appToken.startsWith('xapp-')) {
    throw new Error('createSlackIngestor: an app-level token (xapp-…) is required')
  }
  if (typeof onActivity !== 'function') {
    throw new Error('createSlackIngestor: onActivity callback is required')
  }

  let ws = null
  let stopped = true
  let reconnectTimer = null
  let consecutiveFailures = 0

  const stats = {
    provider: 'slack',
    connected: false,
    startedAt: null,
    connectedAt: null,
    lastEventAt: null,
    events: 0,
    byChannelType: { channel: 0, group: 0, im: 0, mpim: 0, other: 0 },
    byKind: { message: 0, edited: 0, deleted: 0 },
    reconnects: 0,
    lastDisconnectReason: null,
    gaveUp: false,
    // From Slack's hello frame: how many Socket Mode connections THIS APP has
    // open in total (all servers/probes combined). >1 means Slack is load-
    // balancing events RANDOMLY across them — this instance will silently miss
    // a share of events. The classic cause: a dev machine's socket (or the old
    // CLI probe) left running against the same app token as production.
    appConnectionCount: null
  }

  const emitStatus = (payload) => {
    try { if (onStatus) onStatus(payload) } catch (e) {
      console.warn('slackIngestor: onStatus callback threw:', e?.message || e)
    }
  }

  const openConnection = async () => {
    const res = await fetch(OPEN_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + appToken,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    })
    const data = await res.json().catch(() => null)
    if (!data || data.ok !== true) {
      const err = new Error('apps.connections.open failed: ' + (data?.error || ('HTTP ' + res.status)))
      err.slackError = data?.error || null
      // invalid_auth / missing_scope will never self-heal — surface loudly.
      err.permanent = ['invalid_auth', 'not_authed', 'missing_scope', 'token_revoked'].includes(data?.error)
      throw err
    }
    return data.url
  }

  // Turn one Slack message event into zero-or-one normalized activity events.
  // Subtype mapping mirrors what the probe demonstrated live:
  //   message_changed → 'edited' with the EDITED message's own ts
  //   message_deleted → 'deleted' with deleted_ts
  //   everything else (incl. plain messages, joins, file_share…) → 'message'
  const normalizeEvent = (wrapper, event) => {
    let kind = 'message'
    let messageId = event.ts
    if (event.subtype === 'message_changed') {
      kind = 'edited'
      messageId = event.message?.ts || event.ts
    } else if (event.subtype === 'message_deleted') {
      kind = 'deleted'
      messageId = event.deleted_ts || event.ts
    }
    const auths = Array.isArray(wrapper.authorizations) ? wrapper.authorizations : []
    return {
      provider: 'slack',
      teamId: wrapper.team_id || event.team || null,
      authUserIds: auths.map(a => a.user_id).filter(Boolean),
      conversationId: event.channel,
      channelType: event.channel_type || 'other',
      kind,
      messageId,
      at: Date.now()
    }
  }

  const handleFrame = (frame) => {
    let payload
    try { payload = JSON.parse(frame.data) } catch (_) { return }

    // Ack first — unacked envelopes are redelivered.
    if (payload.envelope_id) {
      try { ws.send(JSON.stringify({ envelope_id: payload.envelope_id })) } catch (_) { /* closing */ }
    }

    if (payload.type === 'hello') {
      stats.appConnectionCount = payload.num_connections || 1
      if (stats.appConnectionCount > 1) {
        console.warn('slackIngestor: this Slack app has ' + stats.appConnectionCount +
          ' open Socket Mode connections — events are split randomly between them. ' +
          'Stop the other one (dev server / probe) or this instance will miss events.')
      }
      return
    }

    if (payload.type === 'disconnect') {
      // Slack cycling the socket — normal, not an error. Close; the close
      // handler reconnects (a brief gap is possible; the manager records it).
      stats.lastDisconnectReason = payload.reason || 'slack_requested'
      try { ws.close() } catch (_) { /* already closing */ }
      return
    }

    if (payload.type === 'events_api') {
      const wrapper = payload.payload
      const event = wrapper && wrapper.event
      if (!event || event.type !== 'message' || !event.channel) return
      const activity = normalizeEvent(wrapper, event)
      stats.events++
      stats.lastEventAt = activity.at
      if (stats.byChannelType[activity.channelType] === undefined) stats.byChannelType.other++
      else stats.byChannelType[activity.channelType]++
      stats.byKind[activity.kind]++
      try {
        onActivity(activity)
      } catch (e) {
        console.warn('slackIngestor: onActivity threw (event dropped):', e?.message || e)
      }
    }
  }

  const scheduleReconnect = () => {
    if (stopped) return
    consecutiveFailures++
    if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
      stats.gaveUp = true
      emitStatus({ event: 'gave_up', failures: consecutiveFailures })
      console.error('slackIngestor: giving up after ' + consecutiveFailures + ' consecutive failures')
      return
    }
    const delay = Math.min(MAX_RECONNECT_MS, BASE_RECONNECT_MS * Math.pow(2, Math.min(consecutiveFailures - 1, 5)))
    emitStatus({ event: 'reconnect_scheduled', delayMs: delay })
    reconnectTimer = setTimeout(() => { connect() }, delay)
  }

  const connect = async () => {
    if (stopped) return
    let url
    try {
      url = await openConnection()
    } catch (e) {
      console.warn('slackIngestor: could not open connection:', e?.message || e)
      if (e.permanent) {
        stopped = true
        stats.gaveUp = true
        stats.lastDisconnectReason = e.slackError || 'permanent_auth_failure'
        emitStatus({ event: 'gave_up', reason: stats.lastDisconnectReason })
        return
      }
      scheduleReconnect()
      return
    }

    ws = new WebSocket(url)

    ws.addEventListener('open', () => {
      const wasReconnect = stats.connectedAt !== null
      stats.connected = true
      stats.connectedAt = Date.now()
      if (wasReconnect) stats.reconnects++
      consecutiveFailures = 0
      emitStatus({ event: 'connected', reconnect: wasReconnect })
    })

    ws.addEventListener('message', handleFrame)

    ws.addEventListener('error', () => {
      // close fires next and owns the reconnect; logging here would double up.
    })

    ws.addEventListener('close', () => {
      const wasConnected = stats.connected
      stats.connected = false
      if (wasConnected) emitStatus({ event: 'disconnected', reason: stats.lastDisconnectReason })
      scheduleReconnect()
    })
  }

  return {
    start () {
      if (!stopped) return
      stopped = false
      stats.startedAt = Date.now()
      stats.gaveUp = false
      consecutiveFailures = 0
      connect()
    },
    stop () {
      stopped = true
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      if (ws) {
        try { ws.close() } catch (_) { /* already closed */ }
        ws = null
      }
      stats.connected = false
    },
    getStats () {
      return { ...stats, byChannelType: { ...stats.byChannelType }, byKind: { ...stats.byKind } }
    }
  }
}

export default { createSlackIngestor }
