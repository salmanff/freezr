// slack-socket-probe.mjs — does a USER-token Slack app actually receive message
// events over Socket Mode?
//
// This is the one assumption a push-based freezr messaging sync would rest on.
// Slack's event subscriptions are historically bot-shaped; we need the
// "subscribe on behalf of users" path to deliver message.channels / .groups /
// .im / .mpim for the authorizing user, with NO bot user in the app. If that
// works, a persistent connection manager in freezr is viable. If it doesn't,
// per-channel polling is the only option and we should stop there.
//
// Deliberately dependency-free: Node 22's built-in global WebSocket + fetch.
// Nothing here touches freezr — it's a throwaway diagnostic.
//
// USAGE:
//   SLACK_APP_TOKEN=xapp-... node slack-socket-probe.mjs
//
// Then post messages in Slack and watch what arrives:
//   1. a public channel you're in       → expect channel_type "channel"
//   2. a DM with someone                → expect "im"          [verified 2026-08-29]
//   3. an ad-hoc multi-person group DM  → expect "mpim"   ← the important one
//   4. a private channel                → expect "group"       [verified 2026-08-29]
//
// MULTI-USER ATTRIBUTION TEST (the second gate — needs a colleague who has
// authorized the SAME Slack app, e.g. by connecting via freezr /connections/new):
//   a. message in a channel you're BOTH in         → whose id is in authorizations?
//   b. message in a private channel only THEY're in → does it arrive at all?
//      authorizations must name THEM, never you.
//   c. DM between two colleagues (neither is you)   → same as (b).
// Each event prints an "↳ team=… authorizations=[…]" line — that field is what a
// socket manager would route on, so send those lines back for analysis.
//
// AZURE SOAK: leave running a few hours on the App Service box (Always On must be
// enabled); the exit summary's reconnect count tells us how stable the host is.
//
// Ctrl-C prints a summary of what was seen per channel type.

const APP_TOKEN = process.env.SLACK_APP_TOKEN

// ---------- preflight ----------

if (typeof WebSocket !== 'function') {
  console.error('✗ This Node has no global WebSocket (needs Node >= 22).')
  console.error('  Node here is ' + process.version + '. Upgrade, or run this on a newer Node.')
  process.exit(1)
}
if (!APP_TOKEN) {
  console.error('✗ Set SLACK_APP_TOKEN first:\n    SLACK_APP_TOKEN=xapp-... node slack-socket-probe.mjs')
  process.exit(1)
}
if (!APP_TOKEN.startsWith('xapp-')) {
  console.error('✗ That is not an app-level token.')
  console.error('  Socket Mode needs the APP-level token (xapp-…) from')
  console.error('  Basic Information → App-Level Tokens, with the connections:write scope.')
  console.error('  It is NOT the xoxp- user token freezr stores for reading messages.')
  process.exit(1)
}

const seen = { channel: 0, group: 0, im: 0, mpim: 0, other: 0 }
const authUsersSeen = new Set() // distinct user_ids seen in authorizations — multi-user check
let events = 0
let reconnects = 0
const startedAt = Date.now()

const stamp = () => new Date().toLocaleTimeString()

// ---------- connect ----------

/** Ask Slack for a fresh WSS URL. These are single-use and short-lived. */
const openConnection = async () => {
  const res = await fetch('https://slack.com/api/apps.connections.open', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + APP_TOKEN,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  })
  const data = await res.json().catch(() => null)
  if (!data || data.ok !== true) {
    const err = data && data.error
    console.error('✗ apps.connections.open failed: ' + (err || ('HTTP ' + res.status)))
    if (err === 'invalid_auth' || err === 'not_authed') {
      console.error('  → the app token is wrong or revoked.')
    } else if (err === 'missing_scope') {
      console.error('  → the app token lacks connections:write. Recreate it with that scope.')
    }
    process.exit(1)
  }
  return data.url
}

const describe = (event) => {
  const type = event.channel_type || 'other'
  if (seen[type] === undefined) seen.other++
  else seen[type]++
  const who = event.user || event.bot_id || 'unknown'
  const text = (event.text || '').replace(/\s+/g, ' ').slice(0, 80)
  const sub = event.subtype ? (' subtype=' + event.subtype) : ''
  const thread = event.thread_ts && event.thread_ts !== event.ts ? ' (thread reply)' : ''
  console.log('  ' + stamp() + '  [' + type + '] ' + event.channel +
    ' from ' + who + sub + thread + '  "' + text + '"')
}

// The ATTRIBUTION line — the whole point of the multi-user test. `wrapper` is the
// event_callback envelope around the event; its `authorizations` array says which
// app installation(s) this event was delivered FOR. That is the field a future
// socket manager would route on, so we print it verbatim per event.
//
// Slack caveat baked into the API: authorizations inline contains AT MOST ONE
// entry even when several users could see the event — the full list needs a
// separate apps.event.authorizations.list call (app token, authorizations:read
// scope). If the multi-user test shows the inline entry is the wrong / an
// ambiguous user, that call becomes mandatory in the real design.
const describeAttribution = (wrapper) => {
  if (!wrapper) return
  const auths = Array.isArray(wrapper.authorizations) ? wrapper.authorizations : []
  auths.forEach(a => { if (a.user_id) authUsersSeen.add(a.user_id) })
  const authText = auths.length === 0
    ? '(none!)'
    : auths.map(a => (a.user_id || '?') + (a.is_bot ? ' (bot)' : '') +
        (a.is_enterprise_install ? ' (enterprise)' : '')).join(', ')
  console.log('             ↳ team=' + (wrapper.team_id || '?') +
    '  authorizations=[' + authText + ']' +
    (wrapper.is_ext_shared_channel ? '  EXT-SHARED-CHANNEL' : '') +
    '  event_context=' + String(wrapper.event_context || '').slice(0, 40) + '…')
}

const connect = async () => {
  const url = await openConnection()
  const ws = new WebSocket(url)

  ws.addEventListener('open', () => {
    console.log((reconnects ? '↻ reconnected' : '✓ socket open') + ' — waiting for events. Post something in Slack now.')
  })

  ws.addEventListener('message', (frame) => {
    let payload
    try { payload = JSON.parse(frame.data) } catch (_) { return }

    // Every envelope must be acknowledged or Slack redelivers it.
    if (payload.envelope_id) {
      ws.send(JSON.stringify({ envelope_id: payload.envelope_id }))
    }

    if (payload.type === 'hello') {
      console.log('✓ hello received — Socket Mode is live (' +
        (payload.num_connections || 1) + ' connection(s) for this app).')
      return
    }

    // Slack cycles sockets periodically; it warns before closing.
    if (payload.type === 'disconnect') {
      console.log('… Slack asked us to reconnect (reason: ' + (payload.reason || 'unknown') + ')')
      try { ws.close() } catch (_) {}
      return
    }

    if (payload.type === 'events_api') {
      const wrapper = payload.payload // the event_callback: carries team_id + authorizations
      const event = wrapper && wrapper.event
      if (!event) return
      if (event.type === 'message') {
        events++
        describe(event)
        describeAttribution(wrapper)
        return
      }
      console.log('  ' + stamp() + '  (non-message event: ' + event.type + ')')
      describeAttribution(wrapper)
      return
    }

    if (payload.type) console.log('  ' + stamp() + '  (envelope type: ' + payload.type + ')')
  })

  ws.addEventListener('error', () => {
    // The close handler does the reconnecting; errors here are usually the
    // socket being cycled and would otherwise print a confusing stack.
  })

  ws.addEventListener('close', () => {
    reconnects++
    if (reconnects > 50) {
      console.error('✗ Too many reconnects — giving up.')
      process.exit(1)
    }
    setTimeout(() => { connect().catch(fatal) }, 1500)
  })
}

const fatal = (err) => {
  console.error('✗ ' + (err && err.message ? err.message : err))
  process.exit(1)
}

// ---------- summary on exit ----------

process.on('SIGINT', () => {
  const hours = ((Date.now() - startedAt) / 3600000).toFixed(1)
  console.log('\n──────── summary ────────')
  console.log('ran for ' + hours + 'h')
  console.log('message events received: ' + events)
  console.log('  public channels (channel): ' + seen.channel)
  console.log('  private channels (group):  ' + seen.group)
  console.log('  DMs (im):                  ' + seen.im)
  console.log('  group DMs (mpim):          ' + seen.mpim)
  if (seen.other) console.log('  other/unknown:             ' + seen.other)
  console.log('socket reconnects: ' + reconnects +
    (Number(hours) > 0.5 ? ('  (~' + (reconnects / Number(hours)).toFixed(1) + '/h — host stability signal)') : ''))
  console.log('distinct users in authorizations: ' + authUsersSeen.size +
    (authUsersSeen.size ? ('  [' + [...authUsersSeen].join(', ') + ']') : '') +
    '  (multi-user attribution needs ≥2 with a colleague authorized)')
  console.log('')
  if (events === 0) {
    console.log('VERDICT: no message events arrived.')
    console.log('  Most likely the user-event subscriptions are missing. Check')
    console.log('  Event Subscriptions → "Subscribe to events on behalf of users"')
    console.log('  contains message.channels / message.groups / message.im / message.mpim,')
    console.log('  and that you REINSTALLED the app afterwards.')
  } else if (seen.mpim > 0) {
    console.log('VERDICT: works, including ad-hoc group DMs (mpim).')
    console.log('  A push-based sync in freezr is viable.')
  } else {
    console.log('VERDICT: message events arrive, but none from a group DM (mpim).')
    console.log('  Retest by posting in a multi-person DM before concluding —')
    console.log('  that case is the whole reason for going push-based.')
  }
  process.exit(0)
})

console.log('Slack Socket Mode probe — Ctrl-C to stop and see a summary.\n')
connect().catch(fatal)
