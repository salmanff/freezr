// Whole-app snapshots for the creator's Versions tab — the unit of rollback.
//
// A snapshot is a zip of EVERY file in the app folder (text and binary alike), stored in the
// creator's user files under snapshots/<appName>/<id>.zip with a record in the creator's
// `appSnapshots` collection. This complements the per-file `fileUpdates` log, which stays as the
// change trace and the baseline for external-change detection but can't rebuild a whole app
// (it never sees binaries, is written client-side best-effort, and misses server-side writes).
//
// This module holds the PURE helpers (hashing, diffing, retention) so they can be unit-tested
// without a datastore; the controller (snapshotController.mjs) does the I/O.

import crypto from 'crypto'

export const SNAPSHOT_COLLECTION = 'appSnapshots'
export const SNAPSHOT_DIR = 'snapshots'

// Retention for UNPINNED snapshots (pinned and published ones are always kept): the newest
// MAX_UNPINNED_SNAPSHOTS plus the very oldest, so the original state of an app never falls off
// a recency cap. Zips are tens of KB, so the cap is about list clutter, not storage.
export const MAX_UNPINNED_SNAPSHOTS = 20

export const SNAPSHOT_REASONS = {
  chat_start: 'Before chat',
  pre_edit: 'Before manual edit',
  pre_restore: 'Before restore',
  pre_upload: 'Before upload',
  upload: 'Uploaded',
  manual: 'Checkpoint',
  published: 'Published'
}

// Zips made by hand (or by GitHub) often wrap everything in one top-level folder. If every entry
// shares the same first segment and the manifest sits inside it rather than at the root, strip it.
export const stripCommonTopFolder = (fileMap) => {
  const paths = Object.keys(fileMap || {})
  if (!paths.length || Object.prototype.hasOwnProperty.call(fileMap, 'manifest.json')) return fileMap
  const first = paths[0].split('/')[0]
  if (!paths.every((p) => p.includes('/') && p.split('/')[0] === first)) return fileMap
  const out = {}
  for (const p of paths) out[p.slice(first.length + 1)] = fileMap[p]
  return out
}

// Who is acting, for the `author` stamped on history records written server-side.
export const authorOf = (req, res) => ({
  user: req?.session?.logged_in_user_id || null,
  server: res?.locals?.freezr?.serverName || (req && req.get ? (req.protocol + '://' + req.get('host')) : null)
})

// Chat-history export/import format (Download Chat / Upload Chat in the creator's app settings).
export const CHAT_EXPORT_FORMAT = 'freezr-creator-chat'
export const CHAT_EXPORT_VERSION = 1

// Identity of a history record for export/import dedup. Every record the creator writes carries a
// creator-owned `uid`; the datastore `_id` is NOT used as the primary key because it is not fully
// ours (unified-db setups qualify ids with app/user). Fallbacks, in order, for records that
// predate `uid`: the exported `_id`, then a deterministic hash of the record's content.
export const importKeyOf = (rec) => {
  if (!rec || typeof rec !== 'object') return null
  if (typeof rec.uid === 'string' && rec.uid) return rec.uid
  if (typeof rec._id === 'string' && rec._id) return rec._id
  return null
}

// Prepare one exported record for import into `appName`: system fields are dropped (the datastore
// assigns a fresh _id and re-stamps dates), `uid` is set to the record's import key so the imported
// copy exports with the same identity next time, and appName is re-pointed. `sourceId` is the
// exporting side's _id, kept so cross-record links (fileUpdates.historyId → appUpdates._id) can be
// remapped to the new local ids. Returns null for a non-record.
export const importableRecord = (rec, appName) => {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null
  const record = {}
  for (const [k, v] of Object.entries(rec)) {
    if (k.startsWith('_')) continue
    record[k] = v
  }
  if (!Object.keys(record).length) return null
  const key = importKeyOf(rec) || derivedRecordId(record)
  record.uid = key
  record.appName = appName
  return { key, sourceId: (typeof rec._id === 'string' && rec._id) || null, record }
}

// Content-derived id for an id-less record: sha256 of its non-system fields (appName excluded so
// the same record exported under a renamed app still matches), in sorted-key order.
export const derivedRecordId = (fields) => {
  const stable = (v) => {
    if (Array.isArray(v)) return v.map(stable)
    if (v && typeof v === 'object') return Object.keys(v).sort().reduce((o, k) => { o[k] = stable(v[k]); return o }, {})
    return v
  }
  const { appName, uid, ...rest } = fields || {}
  return 'imp-' + sha256(JSON.stringify(stable(rest))).slice(0, 24)
}

const TEXT_EXTENSIONS = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'md', 'txt', 'svg', 'xml', 'csv', 'yaml', 'yml'])
export const isTextPath = (filePath) => TEXT_EXTENSIONS.has(String(filePath || '').split('.').pop().toLowerCase())

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

export const newSnapshotId = () => {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) // yyyymmddHHMMSS
  return ts + '-' + crypto.randomBytes(4).toString('hex')
}

export const snapshotZipPath = (appName, snapshotId) => SNAPSHOT_DIR + '/' + appName + '/' + snapshotId + '.zip'

// Normalise a {relPath: bytes} map: forward slashes, no leading slash, no folder entries, no
// __MACOSX junk, and never dot-files (.DS_Store, .git, .freezr-access.local.json) — those are
// local housekeeping, not app content, and must neither be snapshotted nor restored.
export const normalizeFileMap = (fileMap) => {
  const out = {}
  for (const [raw, bytes] of Object.entries(fileMap || {})) {
    if (!raw || raw.endsWith('/')) continue
    const p = String(raw).replace(/\\/g, '/').replace(/^\/+/, '')
    if (!p || p.startsWith('__MACOSX')) continue
    if (p.split('/').some((seg) => seg.startsWith('.'))) continue
    out[p] = bytes
  }
  return out
}

// Content hash of a whole file map: sha256 over the sorted "path\0sha256(bytes)" lines. Two apps
// with the same files in the same state hash the same, whatever order they were read in.
export const hashFileMap = (fileMap) => {
  const lines = Object.keys(fileMap).sort().map((p) => p + '\0' + sha256(fileMap[p]))
  return sha256(lines.join('\n'))
}

const toBuffer = (bytes) => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []))
const sameBytes = (a, b) => toBuffer(a).equals(toBuffer(b))

// File-by-file comparison of two maps. `a` is the older/base side, `b` the newer side, so the
// statuses read as "what happened going from a to b". Text contents are included for changed text
// files only (the compare view needs them); binaries carry sizes and a changed flag.
export const diffFileMaps = (a, b, { includeContent = true } = {}) => {
  const paths = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].sort()
  const files = []
  for (const p of paths) {
    const inA = a && Object.prototype.hasOwnProperty.call(a, p)
    const inB = b && Object.prototype.hasOwnProperty.call(b, p)
    let status
    if (inA && inB) status = sameBytes(a[p], b[p]) ? 'unchanged' : 'modified'
    else status = inB ? 'added' : 'deleted'
    const text = isTextPath(p)
    const entry = {
      path: p,
      status,
      binary: !text,
      aSize: inA ? toBuffer(a[p]).length : null,
      bSize: inB ? toBuffer(b[p]).length : null
    }
    if (includeContent && text && status !== 'unchanged') {
      entry.a = inA ? toBuffer(a[p]).toString('utf8') : null
      entry.b = inB ? toBuffer(b[p]).toString('utf8') : null
    }
    files.push(entry)
  }
  const counts = { modified: 0, added: 0, deleted: 0, unchanged: 0 }
  for (const f of files) counts[f.status]++
  return { files, counts }
}

// Which UNPINNED snapshots to drop so that at most MAX_UNPINNED_SNAPSHOTS remain, always keeping
// the oldest one. Pinned and published records are never candidates. Input: all records for one
// app, any order. Output: the records to delete.
export const selectSnapshotsToPrune = (records, max = MAX_UNPINNED_SNAPSHOTS) => {
  const prunable = (records || [])
    .filter((r) => r && !r.pinned && r.reason !== 'published')
    .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')))
  if (prunable.length <= max) return []
  const oldest = prunable[0]
  const newest = prunable.slice(-max)
  const keep = new Set([oldest, ...newest].map((r) => r._id || r.snapshotId))
  return prunable.filter((r) => !keep.has(r._id || r.snapshotId))
}

// Human label for a snapshot when the caller gave none.
export const defaultLabelFor = (reason, extra = {}) => {
  if (reason === 'published' && extra.version) return 'Published v' + extra.version
  return SNAPSHOT_REASONS[reason] || 'Snapshot'
}

// A restore of a snapshot taken under a previous app name must not resurrect the old identifier
// (the manifest check in fileHandler rejects identifier !== appName). Rewrites manifest.json's
// identifier in place; returns the (possibly unchanged) map.
export const alignManifestIdentifier = (fileMap, appName) => {
  const raw = fileMap['manifest.json']
  if (!raw) return fileMap
  try {
    const manifest = JSON.parse(toBuffer(raw).toString('utf8'))
    if (manifest && manifest.identifier && manifest.identifier !== appName) {
      manifest.identifier = appName
      return { ...fileMap, 'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') }
    }
  } catch (e) { /* unparseable manifest: leave it, validation will report it */ }
  return fileMap
}
