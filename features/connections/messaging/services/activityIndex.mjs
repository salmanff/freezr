// freezr.info - Messaging activity index
//
// The per-user table socket events land in — METADATA ONLY, never message
// content. Design rationale (from the plan): freezr must never re-implement the
// provider's visibility rules; apps learn "conversation X changed" here, then
// fetch the actual messages via getNewer WITH THE USER'S OWN TOKEN, so the
// provider stays the enforcer. An over-inclusive index row is harmless (the
// fetch returns nothing); an over-inclusive message store would be a leak.
//
// Table: per-user app_table 'info.freezr.connections.activity', two row types:
//
//   type:'activity' — one per (connectionName, conversationId):
//     { type, connectionName, conversationId, lastActivityTs, lastEventAt,
//       edited: [{id, at}], deleted: [{id, at}], changesOverflowed }
//     Change lists are TIME-ADDRESSED because the index has no per-app read
//     cursor: multiple apps may consume it, so entries are never cleared on
//     read — /changes?since=T filters by at > T per caller. Prune-on-write:
//     entries older than RETENTION_MS dropped; past MAX_CHANGES the list stops
//     growing and changesOverflowed=true ("wider resync needed").
//
//   type:'meta' — one per connectionName:
//     { type, connectionName, gaps: [{from, to|null}] }
//     A gap is a window when the socket was down and events were lost (Slack
//     has no replay). Open gap = socket currently down. readChanges reports
//     complete:false when a gap overlaps the caller's window, so the change
//     list is never silently wrong.

const ACTIVITY_APP_TABLE = 'info.freezr.connections.activity'

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
export const MAX_CHANGES = 100                        // per conversation per list
const MAX_GAPS = 20

const getDb = async (dsManager, freezrPrefs, ownerId) =>
  dsManager.getorInitDb({ app_table: ACTIVITY_APP_TABLE, owner: ownerId }, { freezrPrefs })

const pruneList = (list, now) => {
  const kept = (list || []).filter(e => e && (now - e.at) < RETENTION_MS)
  return kept
}

/**
 * Record one normalized activity event for one user's connection.
 * kind 'message' bumps lastActivityTs; 'edited'/'deleted' also append to the
 * time-addressed change lists (capped + pruned on write).
 */
export const recordActivity = async ({ dsManager, freezrPrefs, ownerId, connectionName, activity }) => {
  const db = await getDb(dsManager, freezrPrefs, ownerId)
  const { conversationId, kind, messageId, at } = activity
  const now = at || Date.now()

  const existing = ((await db.query({ type: 'activity', connectionName, conversationId }, {})) || [])[0]
  const row = existing || {
    type: 'activity',
    connectionName,
    conversationId,
    lastActivityTs: null,
    lastEventAt: null,
    edited: [],
    deleted: [],
    changesOverflowed: false
  }

  row.lastEventAt = now
  if (kind === 'message') {
    // MONOTONIC: Slack redelivers events that went unacked during a disconnect
    // (observed live: a message redelivered ~60s late on reconnect), so an older
    // message can arrive AFTER a newer one. lastActivityTs is a high-water mark —
    // a late old event must never rewind it, or an app using it as a fetch
    // cursor would silently re-window backwards.
    const incoming = parseFloat(messageId)
    const current = parseFloat(row.lastActivityTs)
    if (messageId && (!Number.isFinite(current) || incoming > current)) {
      row.lastActivityTs = messageId
    }
  } else if (kind === 'edited' || kind === 'deleted') {
    const listName = kind
    let list = pruneList(row[listName], now)
    if (list.length >= MAX_CHANGES) {
      row.changesOverflowed = true
    } else if (messageId) {
      // Dedupe: repeated edits of the same message keep the LATEST at.
      list = list.filter(e => e.id !== messageId)
      list.push({ id: messageId, at: now })
    }
    row[listName] = list
    // An edit/delete is activity too — a consumer keying off lastActivityTs alone
    // still learns the conversation moved.
    row.lastActivityTs = row.lastActivityTs || messageId
  }

  if (existing) {
    await db.update(existing._id + '', row, { replaceAllFields: false })
  } else {
    await db.create(null, row, null)
  }
}

const getMetaRow = async (db, connectionName) =>
  (((await db.query({ type: 'meta', connectionName }, {})) || [])[0]) || null

/**
 * Open a gap for a connection: the socket covering it went down (or the manager
 * stopped), so events from `from` onward may be missing. No-op if a gap is
 * already open.
 */
export const openGap = async ({ dsManager, freezrPrefs, ownerId, connectionName, from }) => {
  const db = await getDb(dsManager, freezrPrefs, ownerId)
  const meta = await getMetaRow(db, connectionName)
  const gaps = (meta?.gaps || []).filter(g => g && (Date.now() - (g.to || Date.now())) < RETENTION_MS)
  if (gaps.some(g => g.to === null)) return // already open
  gaps.push({ from: from || Date.now(), to: null })
  while (gaps.length > MAX_GAPS) gaps.shift()
  if (meta) await db.update(meta._id + '', { gaps }, { replaceAllFields: false })
  else await db.create(null, { type: 'meta', connectionName, gaps }, null)
}

/**
 * Close any open gap (socket is delivering again). Events between from and now
 * remain unknown — the gap row stays, telling readChanges to answer honestly.
 */
export const closeGap = async ({ dsManager, freezrPrefs, ownerId, connectionName }) => {
  const db = await getDb(dsManager, freezrPrefs, ownerId)
  const meta = await getMetaRow(db, connectionName)
  if (!meta || !(meta.gaps || []).some(g => g.to === null)) return
  const gaps = meta.gaps.map(g => g.to === null ? { ...g, to: Date.now() } : g)
  await db.update(meta._id + '', { gaps }, { replaceAllFields: false })
}

/**
 * The read side of /changes: conversations with activity after `since`, each
 * with its change lists filtered to entries newer than `since`.
 *
 * Honesty contract: `complete: false` whenever the answer cannot be trusted
 * for the caller's window — since predates the retention horizon, a gap
 * overlaps (since → now), or a change list overflowed. The caller's remedy is
 * always the same: a wider getNewer resync.
 */
export const readChanges = async ({ dsManager, freezrPrefs, ownerId, connectionName, since }) => {
  const db = await getDb(dsManager, freezrPrefs, ownerId)
  const now = Date.now()
  const sinceMs = Number.isFinite(since) ? since : 0

  const meta = await getMetaRow(db, connectionName)
  const gaps = (meta?.gaps || [])
  const openGapRow = gaps.find(g => g.to === null) || null
  const gapOverlaps = gaps.some(g => (g.to === null ? now : g.to) > sinceMs)

  const rows = ((await db.query({ type: 'activity', connectionName }, {})) || [])

  let anyOverflow = false
  const changes = rows
    .filter(r => (r.lastEventAt || 0) > sinceMs)
    .map(r => {
      if (r.changesOverflowed) anyOverflow = true
      return {
        conversationId: r.conversationId,
        lastActivityTs: r.lastActivityTs,
        lastEventAt: r.lastEventAt,
        edited: pruneList(r.edited, now).filter(e => e.at > sinceMs),
        deleted: pruneList(r.deleted, now).filter(e => e.at > sinceMs),
        changesOverflowed: !!r.changesOverflowed
      }
    })
    .sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0))

  const beyondHorizon = sinceMs > 0 && (now - sinceMs) > RETENTION_MS

  return {
    changes,
    gapSince: openGapRow ? openGapRow.from : null,
    // The recorded downtime windows themselves ({from, to|null}, newest last).
    // complete is relative to the CALLER'S window, so exposing the gaps lets a
    // caller (or a human on the test view) see WHICH gap made it false and how
    // old it is — and that a since later than the last gap's end yields
    // complete:true again. No extra state: this is the same data the flag is
    // computed from.
    gaps: gaps.map(g => ({ from: g.from, to: g.to })),
    complete: !gapOverlaps && !beyondHorizon && !anyOverflow,
    retentionMs: RETENTION_MS
  }
}

export default { recordActivity, openGap, closeGap, readChanges, RETENTION_MS, MAX_CHANGES }
