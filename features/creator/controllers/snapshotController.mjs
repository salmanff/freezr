// Whole-app snapshots: take / list / compare / restore / pin / delete.
//
// Storage (see appSnapshotService.mjs for the rationale):
//   - zip bytes:  creator user files, snapshots/<appName>/<id>.zip
//   - metadata:   creator db collection `appSnapshots`, record id = snapshot id
//   - published versions already have a zip in the creator's user-files root (publishApp); those
//     get an `appSnapshots` record too (reason 'published', pinned) so the Versions tab is one list.
//     Publishes that pre-date this feature are synthesised from the `files` collection with ids
//     prefixed 'pub:' so they can still be compared against and restored.
//
// Restore writes the differing files back through the connector, re-runs the normal
// update-from-files install (manifest/permissions re-registration), then records an `appUpdates`
// entry (action 'restored') and fresh `fileUpdates` snapshots for each changed text file, so the
// per-file history stays coherent and the next open does not flag the restore as an external change.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { zipSync, unzipSync } from 'fflate'
import { sendApiSuccess, sendFailure, sendStream } from '../../../adapters/http/responses.mjs'
import { userAppListOAC } from '../../../common/helpers/config.mjs'
import { updateAppFromFiles } from '../../account/services/appInstallService.mjs'
import { collectAppFileBuffers } from '../services/appFileCollector.mjs'
import {
  SNAPSHOT_COLLECTION, SNAPSHOT_REASONS, normalizeFileMap, hashFileMap, diffFileMaps,
  selectSnapshotsToPrune, newSnapshotId, snapshotZipPath, defaultLabelFor, alignManifestIdentifier, isTextPath,
  stripCommonTopFolder, CHAT_EXPORT_FORMAT, CHAT_EXPORT_VERSION, importableRecord, authorOf
} from '../services/appSnapshotService.mjs'

const CREATOR_APP = 'info.freezr.creator'
const LEGACY_PUB_PREFIX = 'pub:'

const tsDesc = (a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || ''))

export const createSnapshotController = () => {
  // ---- shared plumbing -------------------------------------------------------------------------

  const ctxFrom = (req, res) => {
    const userId = req.session?.logged_in_user_id
    const userDS = res.locals?.freezr?.userDS
    const freezrPrefs = res.locals?.freezr?.freezrPrefs
    return { userId, userDS, freezrPrefs, author: authorOf(req, res) }
  }

  const creatorDb = (userDS, userId, freezrPrefs, collection) =>
    userDS.getorInitDb({ owner: userId, app_name: CREATOR_APP, collection_name: collection }, { freezrPrefs })

  const snapshotDb = (c) => creatorDb(c.userDS, c.userId, c.freezrPrefs, SNAPSHOT_COLLECTION)

  const creatorFS = (userDS) => userDS.getorInitAppFS(CREATOR_APP, {})

  const readCurrentFileMap = async (appFS) => normalizeFileMap(await collectAppFileBuffers(appFS))

  // Every stored record for an app, newest first, plus synthesised entries for legacy publishes.
  const listRecords = async (c, appName) => {
    const db = await snapshotDb(c)
    const stored = db ? ((await db.query({ appName }, {})) || []) : []
    const known = new Set(stored.map((r) => r.fileName))
    let legacy = []
    try {
      const filesDb = await creatorDb(c.userDS, c.userId, c.freezrPrefs, 'files')
      const pubs = filesDb ? ((await filesDb.query({ publishedAppName: appName }, {})) || []) : []
      legacy = pubs
        .filter((p) => p.version && p.fileName && !p.isLogo && !known.has(p.fileName))
        .map((p) => ({
          _id: LEGACY_PUB_PREFIX + p.fileName,
          snapshotId: LEGACY_PUB_PREFIX + p.fileName,
          appName,
          reason: 'published',
          label: 'Published v' + p.version,
          version: p.version,
          fileName: p.fileName,
          pinned: true,
          legacy: true,
          timestamp: p.timestamp || p._date_created || null
        }))
    } catch (e) { /* no publishes */ }
    return [...stored, ...legacy].sort(tsDesc)
  }

  const findRecord = async (c, appName, snapshotId) => {
    if (!snapshotId) return null
    if (String(snapshotId).startsWith(LEGACY_PUB_PREFIX)) {
      // Only a zip that the `files` collection vouches for as this app's publish may be opened.
      return (await listRecords(c, appName)).find((r) => r.legacy && r._id === snapshotId) || null
    }
    const db = await snapshotDb(c)
    const rec = db ? await db.read_by_id(snapshotId) : null
    if (!rec || rec.appName !== appName) return null
    return rec
  }

  const loadSnapshotFileMap = async (c, record) => {
    const cfs = await creatorFS(c.userDS)
    const buf = await cfs.getUserFile(record.fileName, { returnBuffer: true })
    if (!buf) throw new Error('Snapshot file not found: ' + record.fileName)
    return normalizeFileMap(unzipSync(new Uint8Array(buf)))
  }

  const removeZip = async (c, record) => {
    if (!record || record.legacy || record.reason === 'published') return // publish zips are the public download
    try {
      const cfs = await creatorFS(c.userDS)
      if (cfs.removeFile) await cfs.removeFile(record.fileName)
    } catch (e) { console.warn('snapshot: could not remove zip', record.fileName, e.message) }
  }

  const pruneSnapshots = async (c, records) => {
    const db = await snapshotDb(c)
    const victims = selectSnapshotsToPrune(records)
    for (const v of victims) {
      await removeZip(c, v)
      try { await db.delete_record(v._id) } catch (e) { console.warn('snapshot: could not prune record', v._id, e.message) }
    }
    return victims.length
  }

  // Core: snapshot the app as it is now. Dedups against the most recent snapshot by content hash
  // (an identical state is recorded as an alias on that record rather than a second zip), then prunes.
  const takeSnapshot = async (c, { appName, reason, label, chatId, historyId, pinned }) => {
    const appFS = await c.userDS.getorInitAppFS(appName, {})
    if (!appFS || !appFS.readAppFile) throw new Error('Could not access app filesystem.')
    const fileMap = await readCurrentFileMap(appFS)
    const fileCount = Object.keys(fileMap).length
    if (!fileCount) throw new Error('App has no files to snapshot.')
    const contentHash = hashFileMap(fileMap)
    const db = await snapshotDb(c)
    if (!db) throw new Error('Could not access snapshot records.')

    const existing = ((await db.query({ appName }, { count: 1000 })) || []).sort(tsDesc)
    const now = new Date().toISOString()
    const finalLabel = label || defaultLabelFor(reason)

    // Identical state already stored (most recent such record wins — two snapshots taken within
    // the same millisecond, e.g. before/after an upload that changed nothing, tie on timestamp, so
    // "the newest" alone is not a safe comparison): record this moment as an alias on it.
    const same = existing.find((r) => r.contentHash === contentHash) || null
    if (same) {
      const aliases = [...(same.aliases || []), { reason, label: finalLabel, chatId: chatId || null, historyId: historyId || null, timestamp: now }]
      const patch = { aliases }
      if (pinned) patch.pinned = true
      await db.update(same._id, patch, { replaceAllFields: false })
      return { created: false, record: { ...same, ...patch }, contentHash }
    }

    const snapshotId = newSnapshotId()
    const zipBuffer = Buffer.from(zipSync(fileMap, { level: 6 }))
    const fileName = snapshotZipPath(appName, snapshotId)
    const cfs = await creatorFS(c.userDS)
    if (!cfs || !cfs.writeToUserFiles) throw new Error('Could not access creator user files.')
    await cfs.writeToUserFiles(fileName, zipBuffer, { doNotOverWrite: false })

    const record = {
      appName,
      snapshotId,
      reason,
      label: finalLabel,
      chatId: chatId || null,
      historyId: historyId || null,
      fileName,
      contentHash,
      fileCount,
      byteSize: zipBuffer.length,
      pinned: !!pinned,
      aliases: [],
      timestamp: now
    }
    await db.create(snapshotId, record, {})
    const stored = { ...record, _id: snapshotId }
    const pruned = await pruneSnapshots(c, [...existing, stored])
    return { created: true, record: stored, contentHash, pruned }
  }

  // Resolve 'current' or a snapshot id to { meta, fileMap }.
  const resolveSide = async (c, appName, ref) => {
    if (!ref || ref === 'current') {
      const appFS = await c.userDS.getorInitAppFS(appName, {})
      const fileMap = await readCurrentFileMap(appFS)
      return { meta: { id: 'current', label: 'Current files', timestamp: new Date().toISOString() }, fileMap }
    }
    const record = await findRecord(c, appName, ref)
    if (!record) throw Object.assign(new Error('Snapshot not found: ' + ref), { status: 404 })
    const fileMap = await loadSnapshotFileMap(c, record)
    return { meta: { id: record._id, label: record.label, reason: record.reason, timestamp: record.timestamp, version: record.version }, fileMap, record }
  }

  // ---- handlers --------------------------------------------------------------------------------

  // POST /creatorapi/snapshot_app { app_name, reason?, label?, chat_id?, history_id?, pinned? }
  const createSnapshot = async (req, res) => {
    const FUNC = 'snapshotController.createSnapshot'
    try {
      const appName = req.body?.app_name
      if (!appName) return sendFailure(res, 'app_name is required.', FUNC, 400)
      const c = ctxFrom(req, res)
      if (!c.userId) return sendFailure(res, 'User not logged in.', FUNC, 401)
      if (!c.userDS) return sendFailure(res, 'User data store not available.', FUNC, 500)
      const reason = SNAPSHOT_REASONS[req.body?.reason] && req.body.reason !== 'published' ? req.body.reason : 'manual'
      const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 200) : ''
      const result = await takeSnapshot(c, {
        appName,
        reason,
        label,
        chatId: req.body?.chat_id || null,
        historyId: req.body?.history_id || null,
        pinned: req.body?.pinned === true
      })
      return sendApiSuccess(res, { success: true, ...result })
    } catch (error) {
      console.error(FUNC + ' error:', error)
      return sendFailure(res, error, FUNC, error.status || 500)
    }
  }

  // GET /creatorapi/app_snapshots?app_name=  → { snapshots, currentHash }
  const listSnapshots = async (req, res) => {
    const FUNC = 'snapshotController.listSnapshots'
    try {
      const appName = req.query?.app_name
      if (!appName) return sendFailure(res, 'app_name is required.', FUNC, 400)
      const c = ctxFrom(req, res)
      if (!c.userId) return sendFailure(res, 'User not logged in.', FUNC, 401)
      if (!c.userDS) return sendFailure(res, 'User data store not available.', FUNC, 500)
      const snapshots = await listRecords(c, appName)
      let currentHash = null
      if (req.query?.with_current !== '0') {
        try {
          const appFS = await c.userDS.getorInitAppFS(appName, {})
          currentHash = hashFileMap(await readCurrentFileMap(appFS))
        } catch (e) { /* hash is a nicety for the "current" marker */ }
      }
      return sendApiSuccess(res, { success: true, snapshots, currentHash })
    } catch (error) {
      console.error(FUNC + ' error:', error)
      return sendFailure(res, error, FUNC, 500)
    }
  }

  // POST /creatorapi/compare_snapshots { app_name, a, b }  (each a snapshot id or 'current')
  // Statuses describe going from a (older/base) to b.
  const compareSnapshots = async (req, res) => {
    const FUNC = 'snapshotController.compareSnapshots'
    try {
      const appName = req.body?.app_name
      if (!appName) return sendFailure(res, 'app_name is required.', FUNC, 400)
      const c = ctxFrom(req, res)
      if (!c.userId) return sendFailure(res, 'User not logged in.', FUNC, 401)
      if (!c.userDS) return sendFailure(res, 'User data store not available.', FUNC, 500)
      const [sideA, sideB] = await Promise.all([
        resolveSide(c, appName, req.body?.a),
        resolveSide(c, appName, req.body?.b)
      ])
      const { files, counts } = diffFileMaps(sideA.fileMap, sideB.fileMap, { includeContent: true })
      return sendApiSuccess(res, { success: true, a: sideA.meta, b: sideB.meta, files, counts })
    } catch (error) {
      console.error(FUNC + ' error:', error)
      return sendFailure(res, error, FUNC, error.status || 500)
    }
  }

  // Shared "make the app folder look like `target`" step used by restore and upload. Writes the
  // files that differ, deletes the ones that should not exist, re-runs the normal update-from-files
  // install (manifest/permissions re-registration — needs ownerPermsDb + publicManifestsDb on
  // res.locals, which the routes add), then records ONE appUpdates entry plus a fileUpdates
  // snapshot per changed text file so the per-file history and external-change baseline stay true.
  const applyTargetMap = async (c, res, { appName, appFS, current, target, action, summaryFor, extra = {} }) => {
    const { files, counts } = diffFileMaps(current, target, { includeContent: false })
    const changed = files.filter((f) => f.status !== 'unchanged')
    if (!changed.length) return { nothingToDo: true, counts, changed: [], historyId: null, installWarning: null }

    for (const f of changed) {
      if (f.status === 'deleted') {
        if (typeof appFS.deleteAppFile === 'function') await appFS.deleteAppFile(f.path)
        else { const abs = path.resolve(appFS.pathToFile(f.path)); if (fs.existsSync(abs)) await fs.promises.unlink(abs) }
      } else {
        await appFS.writeToAppFiles(f.path, Buffer.from(target[f.path]), { doNotOverWrite: false })
      }
    }

    let installWarning = null
    try {
      const ownerPermsDb = res.locals?.freezr?.ownerPermsDb
      const publicManifestsDb = res.locals?.freezr?.publicManifestsDb
      const userAppListDb = await c.userDS.getorInitDb(userAppListOAC(c.userId), { freezrPrefs: c.freezrPrefs })
      if (!ownerPermsDb || !publicManifestsDb || !userAppListDb) throw new Error('install context unavailable')
      const errorLogger = res.locals?.flogger || { log: console.log, error: console.error, warn: console.warn }
      await updateAppFromFiles({
        userId: c.userId,
        realAppName: appName,
        userDS: c.userDS,
        ownerPermsDb,
        publicManifestsDb,
        userAppListDb,
        trustedJobsDb: res.locals?.freezr?.trustedJobsDb || null,
        freezrPrefs: c.freezrPrefs,
        errorLogger,
        appFS: null,
        manifest: null,
        warnings: [],
        installInfo: { isUpdate: true }
      })
    } catch (e) {
      installWarning = e.userMessage || e.message
      console.warn('applyTargetMap: update-from-files failed:', e.message)
    }

    const now = new Date().toISOString()
    const filesChanged = changed.map((f) => f.path)
    const summary = summaryFor(filesChanged, counts)
    let historyId = null
    try {
      const appUpdatesDb = await creatorDb(c.userDS, c.userId, c.freezrPrefs, 'appUpdates')
      const created = await appUpdatesDb.create(null, { uid: crypto.randomUUID(), author: c.author, appName, action, summary, thread: summary, filesChanged, counts, timestamp: now, ...extra }, {})
      historyId = created?._id || null
    } catch (e) { console.warn('applyTargetMap: could not record history entry:', e.message) }

    try {
      const fileUpdatesDb = await creatorDb(c.userDS, c.userId, c.freezrPrefs, 'fileUpdates')
      for (const f of changed) {
        if (!isTextPath(f.path)) continue // binaries are not tracked in fileUpdates (never were)
        const isDelete = f.status === 'deleted'
        await fileUpdatesDb.create(null, {
          uid: crypto.randomUUID(),
          author: c.author,
          appName,
          path: f.path,
          action: isDelete ? 'delete' : 'upsert',
          content: isDelete ? '' : Buffer.from(target[f.path]).toString('utf8'),
          historyId,
          timestamp: now
        }, {})
      }
    } catch (e) { console.warn('applyTargetMap: could not record fileUpdates:', e.message) }

    return { nothingToDo: false, counts, changed, historyId, installWarning }
  }

  // POST /creatorapi/restore_snapshot { app_name, snapshot_id, paths? }
  const restoreSnapshot = async (req, res) => {
    const FUNC = 'snapshotController.restoreSnapshot'
    try {
      const appName = req.body?.app_name
      const snapshotId = req.body?.snapshot_id
      if (!appName || !snapshotId) return sendFailure(res, 'app_name and snapshot_id are required.', FUNC, 400)
      const c = ctxFrom(req, res)
      if (!c.userId) return sendFailure(res, 'User not logged in.', FUNC, 401)
      if (!c.userDS) return sendFailure(res, 'User data store not available.', FUNC, 500)

      const onlyPaths = Array.isArray(req.body?.paths) && req.body.paths.length
        ? req.body.paths.map((p) => String(p).replace(/\\/g, '/').replace(/^\/+/, '')).filter((p) => p && !p.includes('..'))
        : null

      const record = await findRecord(c, appName, snapshotId)
      if (!record) return sendFailure(res, 'Snapshot not found.', FUNC, 404)

      const appFS = await c.userDS.getorInitAppFS(appName, {})
      if (!appFS || !appFS.writeToAppFiles) return sendFailure(res, 'Could not access app filesystem.', FUNC, 500)

      let target = alignManifestIdentifier(await loadSnapshotFileMap(c, record), appName)
      const current = await readCurrentFileMap(appFS)

      // Partial restore: the target is "current, with these paths as they were in the snapshot"
      // (a path absent from the snapshot is removed).
      if (onlyPaths) {
        const partial = { ...current }
        for (const p of onlyPaths) {
          if (Object.prototype.hasOwnProperty.call(target, p)) partial[p] = target[p]
          else delete partial[p]
        }
        target = partial
      }

      const { counts: preCounts, files: preFiles } = diffFileMaps(current, target, { includeContent: false })
      if (!preFiles.some((f) => f.status !== 'unchanged')) {
        return sendApiSuccess(res, { success: true, nothingToDo: true, counts: preCounts, files: [], historyId: null })
      }

      // Safety net first: the state we are about to overwrite becomes its own restore point.
      let preRestore = null
      try {
        preRestore = await takeSnapshot(c, { appName, reason: 'pre_restore', label: 'Before restoring "' + (record.label || record.snapshotId) + '"' })
      } catch (e) { console.warn('restoreSnapshot: pre-restore snapshot failed (continuing):', e.message) }

      const label = record.label || record.snapshotId
      const result = await applyTargetMap(c, res, {
        appName,
        appFS,
        current,
        target,
        action: 'restored',
        summaryFor: (filesChanged) => 'Restored ' + (onlyPaths ? (filesChanged.length === 1 ? filesChanged[0] : filesChanged.length + ' files') : 'app') + ' to "' + label + '"',
        extra: { snapshotId: record._id, snapshotLabel: record.label || null, restoredPaths: onlyPaths, beforeSnapshotId: preRestore?.record?._id || null, afterSnapshotId: record._id }
      })

      return sendApiSuccess(res, {
        success: true,
        counts: result.counts,
        files: result.changed.map((f) => ({ path: f.path, status: f.status })),
        historyId: result.historyId,
        preRestoreSnapshot: preRestore?.record ? { _id: preRestore.record._id, label: preRestore.record.label, created: preRestore.created } : null,
        installWarning: result.installWarning
      })
    } catch (error) {
      console.error(FUNC + ' error:', error)
      return sendFailure(res, error, FUNC, error.status || 500)
    }
  }

  // ---- download / upload (Backup & Transfer in the creator's app settings) -------------------

  const safeFileStem = (appName) => String(appName).replace(/[^a-zA-Z0-9._-]/g, '_')
  const dateStamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')

  // GET /creatorapi/download_app_zip?app_name=  → application/zip of the app folder as it is now.
  const downloadAppZip = async (req, res) => {
    const FUNC = 'snapshotController.downloadAppZip'
    try {
      const appName = req.query?.app_name
      if (!appName) return sendFailure(res, 'app_name is required.', FUNC, 400)
      const c = ctxFrom(req, res)
      if (!c.userId) return sendFailure(res, 'User not logged in.', FUNC, 401)
      if (!c.userDS) return sendFailure(res, 'User data store not available.', FUNC, 500)
      const appFS = await c.userDS.getorInitAppFS(appName, {})
      if (!appFS || !appFS.readAppFile) return sendFailure(res, 'Could not access app filesystem.', FUNC, 500)
      const fileMap = await readCurrentFileMap(appFS)
      if (!Object.keys(fileMap).length) return sendFailure(res, 'App has no files.', FUNC, 404)
      const zipBuffer = Buffer.from(zipSync(fileMap, { level: 6 }))
      const fileName = safeFileStem(appName) + ' ' + dateStamp() + '.zip'
      res.setHeader('Content-Type', 'application/zip')
      res.setHeader('Content-Disposition', 'attachment; filename="' + fileName + '"')
      res.setHeader('X-Freezr-Filename', fileName)
      return sendStream(res, zipBuffer)
    } catch (error) {
      console.error(FUNC + ' error:', error)
      return sendFailure(res, error, FUNC, 500)
    }
  }

  const ALL = { count: 100000 } // the datastore's default query cap is small (nedb: 100)

  // GET /creatorapi/download_chat?app_name=  → JSON export of appUpdates + fileUpdates for the app.
  const downloadChat = async (req, res) => {
    const FUNC = 'snapshotController.downloadChat'
    try {
      const appName = req.query?.app_name
      if (!appName) return sendFailure(res, 'app_name is required.', FUNC, 400)
      const c = ctxFrom(req, res)
      if (!c.userId) return sendFailure(res, 'User not logged in.', FUNC, 401)
      if (!c.userDS) return sendFailure(res, 'User data store not available.', FUNC, 500)
      const appUpdatesDb = await creatorDb(c.userDS, c.userId, c.freezrPrefs, 'appUpdates')
      const fileUpdatesDb = await creatorDb(c.userDS, c.userId, c.freezrPrefs, 'fileUpdates')
      const byTs = (a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || ''))
      const exportedFrom = res.locals?.freezr?.serverName || (req.protocol + '://' + req.get('host'))
      // Records that predate the author stamp are the exporter's own: fill it in on the way out so
      // the recipient still sees whose they were.
      const withAuthor = (r) => (r.author && r.author.user) ? r : { ...r, author: { user: c.userId, server: exportedFrom } }
      const appUpdates = ((await appUpdatesDb.query({ appName }, ALL)) || []).sort(byTs).map(withAuthor)
      const fileUpdates = ((await fileUpdatesDb.query({ appName }, ALL)) || []).sort(byTs).map(withAuthor)
      const fileName = safeFileStem(appName) + ' chat ' + dateStamp() + '.json'
      res.setHeader('Content-Disposition', 'attachment; filename="' + fileName + '"')
      res.setHeader('X-Freezr-Filename', fileName)
      return sendApiSuccess(res, {
        format: CHAT_EXPORT_FORMAT,
        formatVersion: CHAT_EXPORT_VERSION,
        appName,
        exportedAt: new Date().toISOString(),
        exportedBy: c.userId,
        exportedFrom,
        counts: { appUpdates: appUpdates.length, fileUpdates: fileUpdates.length },
        appUpdates,
        fileUpdates
      })
    } catch (error) {
      console.error(FUNC + ' error:', error)
      return sendFailure(res, error, FUNC, 500)
    }
  }

  // POST /creatorapi/upload_app_zip (multipart: file, app_name)
  // Like the front page's install-from-zip, but into THIS app and with history: a "before upload"
  // snapshot, the apply (recorded as an 'uploaded' history entry + fileUpdates), then an "uploaded"
  // snapshot of the result — so both sides of the upload are in Versions.
  const uploadAppZip = async (req, res) => {
    const FUNC = 'snapshotController.uploadAppZip'
    try {
      const appName = req.body?.app_name
      if (!appName) return sendFailure(res, 'app_name is required.', FUNC, 400)
      if (!req.file || !req.file.buffer) return sendFailure(res, 'No file uploaded.', FUNC, 400)
      const originalName = req.file.originalname || 'upload.zip'
      if (!/\.zip$/i.test(originalName)) return sendFailure(res, 'File must be a .zip', FUNC, 400)
      const c = ctxFrom(req, res)
      if (!c.userId) return sendFailure(res, 'User not logged in.', FUNC, 401)
      if (!c.userDS) return sendFailure(res, 'User data store not available.', FUNC, 500)

      let unzipped
      try { unzipped = unzipSync(new Uint8Array(req.file.buffer)) } catch (e) { return sendFailure(res, 'Not a valid zip file: ' + e.message, FUNC, 400) }
      let target = stripCommonTopFolder(normalizeFileMap(unzipped))
      if (!Object.keys(target).length) return sendFailure(res, 'The zip contains no files.', FUNC, 400)
      if (!target['manifest.json']) return sendFailure(res, 'The zip has no manifest.json at its root — is this an app?', FUNC, 400)
      target = alignManifestIdentifier(target, appName)

      const appFS = await c.userDS.getorInitAppFS(appName, {})
      if (!appFS || !appFS.writeToAppFiles) return sendFailure(res, 'Could not access app filesystem.', FUNC, 500)
      const current = await readCurrentFileMap(appFS)

      let before = null
      try {
        before = await takeSnapshot(c, { appName, reason: 'pre_upload', label: 'Before uploading ' + originalName })
      } catch (e) { console.warn('uploadAppZip: pre-upload snapshot failed (continuing):', e.message) }

      const result = await applyTargetMap(c, res, {
        appName,
        appFS,
        current,
        target,
        action: 'uploaded',
        summaryFor: (filesChanged, counts) => 'Uploaded ' + originalName + ' (' + [counts.modified && counts.modified + ' modified', counts.added && counts.added + ' added', counts.deleted && counts.deleted + ' deleted'].filter(Boolean).join(', ') + ')',
        extra: { uploadedFileName: originalName }
      })

      let after = null
      if (!result.nothingToDo) {
        try {
          after = await takeSnapshot(c, { appName, reason: 'upload', label: 'Uploaded ' + originalName, historyId: result.historyId })
        } catch (e) { console.warn('uploadAppZip: post-upload snapshot failed (continuing):', e.message) }
      }

      if (result.historyId && (before?.record || after?.record)) {
        try {
          const appUpdatesDb = await creatorDb(c.userDS, c.userId, c.freezrPrefs, 'appUpdates')
          await appUpdatesDb.update(result.historyId, { beforeSnapshotId: before?.record?._id || null, afterSnapshotId: after?.record?._id || null }, { replaceAllFields: false })
        } catch (e) { console.warn('uploadAppZip: could not stamp snapshot ids on history entry:', e.message) }
      }

      return sendApiSuccess(res, {
        success: true,
        nothingToDo: result.nothingToDo,
        counts: result.counts,
        files: result.changed.map((f) => ({ path: f.path, status: f.status })),
        historyId: result.historyId,
        beforeSnapshot: before?.record ? { _id: before.record._id, label: before.record.label, created: before.created } : null,
        afterSnapshot: after?.record ? { _id: after.record._id, label: after.record.label, created: after.created } : null,
        installWarning: result.installWarning
      })
    } catch (error) {
      console.error(FUNC + ' error:', error)
      return sendFailure(res, error, FUNC, 500)
    }
  }

  // POST /creatorapi/upload_chat (multipart: file = a Download Chat JSON, app_name)
  // Idempotent merge: records keep their original ids, so anything already present is skipped.
  const uploadChat = async (req, res) => {
    const FUNC = 'snapshotController.uploadChat'
    try {
      const appName = req.body?.app_name
      if (!appName) return sendFailure(res, 'app_name is required.', FUNC, 400)
      if (!req.file || !req.file.buffer) return sendFailure(res, 'No file uploaded.', FUNC, 400)
      const c = ctxFrom(req, res)
      if (!c.userId) return sendFailure(res, 'User not logged in.', FUNC, 401)
      if (!c.userDS) return sendFailure(res, 'User data store not available.', FUNC, 500)

      let data
      try { data = JSON.parse(req.file.buffer.toString('utf8')) } catch (e) { return sendFailure(res, 'Not a valid JSON file.', FUNC, 400) }
      if (!data || data.format !== CHAT_EXPORT_FORMAT) return sendFailure(res, 'This is not a creator chat export (expected format "' + CHAT_EXPORT_FORMAT + '").', FUNC, 400)
      if (!Array.isArray(data.appUpdates) || !Array.isArray(data.fileUpdates)) return sendFailure(res, 'Chat export is missing its records.', FUNC, 400)

      // A record is "already here" when a local record carries its import key as uid, or (legacy:
      // imported before uids existed, or created locally before them) when the key IS a local _id.
      const findExisting = async (db, key) => {
        try {
          const byUid = await db.query({ appName, uid: key }, { count: 1 })
          if (byUid && byUid.length) return byUid[0]
        } catch (e) { /* fall through */ }
        try {
          const byId = await db.read_by_id(key)
          if (byId && byId.appName === appName) return byId
        } catch (e) { /* not found */ }
        return null
      }

      // Imported records get a FRESH datastore _id (never the exporter's), so links by _id between
      // records are remapped: idMap is exporter _id → local _id for every record in the export.
      const importedFrom = {
        server: data.exportedFrom || null,
        user: data.exportedBy || null,
        exportedAt: data.exportedAt || null,
        fileName: req.file.originalname || null,
        importedAt: new Date().toISOString()
      }
      const provenance = (rec) => ({
        ...rec,
        author: (rec.author && rec.author.user) ? rec.author : { user: importedFrom.user, server: importedFrom.server },
        importedFrom
      })

      const importInto = async (collection, records, remap) => {
        const db = await creatorDb(c.userDS, c.userId, c.freezrPrefs, collection)
        const out = { imported: 0, skipped: 0, invalid: 0 }
        const idMap = {}
        for (const raw of records) {
          const item = importableRecord(raw, appName)
          if (!item) { out.invalid++; continue }
          const existing = await findExisting(db, item.key)
          if (existing) {
            out.skipped++
            if (item.sourceId && existing._id) idMap[item.sourceId] = existing._id
            continue
          }
          const rec = provenance(remap ? remap(item.record) : item.record)
          const created = await db.create(null, rec, {})
          out.imported++
          if (item.sourceId && created?._id) idMap[item.sourceId] = created._id
        }
        return { out, idMap }
      }

      const appImport = await importInto('appUpdates', data.appUpdates)
      const fileImport = await importInto('fileUpdates', data.fileUpdates, (rec) =>
        (rec.historyId && appImport.idMap[rec.historyId]) ? { ...rec, historyId: appImport.idMap[rec.historyId] } : rec
      )
      const appUpdates = appImport.out
      const fileUpdates = fileImport.out

      let historyId = null
      if (appUpdates.imported || fileUpdates.imported) {
        try {
          const appUpdatesDb = await creatorDb(c.userDS, c.userId, c.freezrPrefs, 'appUpdates')
          const summary = 'Imported chat history from ' + (req.file.originalname || 'upload') + ' (' + appUpdates.imported + ' entries, ' + fileUpdates.imported + ' file records' + (appUpdates.skipped + fileUpdates.skipped ? ', ' + (appUpdates.skipped + fileUpdates.skipped) + ' already present' : '') + ')'
          const created = await appUpdatesDb.create(null, {
            uid: crypto.randomUUID(),
            author: c.author,
            appName,
            action: 'chat_imported',
            summary,
            thread: summary,
            importedFrom: data.exportedFrom || null,
            importedExportedAt: data.exportedAt || null,
            importCounts: { appUpdates, fileUpdates },
            timestamp: new Date().toISOString()
          }, {})
          historyId = created?._id || null
        } catch (e) { console.warn('uploadChat: could not record history entry:', e.message) }
      }

      return sendApiSuccess(res, { success: true, appUpdates, fileUpdates, historyId, sourceApp: data.appName || null })
    } catch (error) {
      console.error(FUNC + ' error:', error)
      return sendFailure(res, error, FUNC, 500)
    }
  }

  // POST /creatorapi/update_snapshot { app_name, snapshot_id, pinned?, label? }
  const updateSnapshot = async (req, res) => {
    const FUNC = 'snapshotController.updateSnapshot'
    try {
      const appName = req.body?.app_name
      const snapshotId = req.body?.snapshot_id
      if (!appName || !snapshotId) return sendFailure(res, 'app_name and snapshot_id are required.', FUNC, 400)
      const c = ctxFrom(req, res)
      if (!c.userId) return sendFailure(res, 'User not logged in.', FUNC, 401)
      if (!c.userDS) return sendFailure(res, 'User data store not available.', FUNC, 500)
      const record = await findRecord(c, appName, snapshotId)
      if (!record) return sendFailure(res, 'Snapshot not found.', FUNC, 404)
      if (record.legacy) return sendFailure(res, 'Published versions cannot be edited here.', FUNC, 400)
      const patch = {}
      if (typeof req.body?.pinned === 'boolean') patch.pinned = req.body.pinned
      if (typeof req.body?.label === 'string' && req.body.label.trim()) patch.label = req.body.label.trim().slice(0, 200)
      if (!Object.keys(patch).length) return sendFailure(res, 'Nothing to update.', FUNC, 400)
      if (record.reason === 'published' && patch.pinned === false) return sendFailure(res, 'Published versions are always kept.', FUNC, 400)
      const db = await snapshotDb(c)
      await db.update(record._id, patch, { replaceAllFields: false })
      return sendApiSuccess(res, { success: true, snapshot: { ...record, ...patch } })
    } catch (error) {
      console.error(FUNC + ' error:', error)
      return sendFailure(res, error, FUNC, 500)
    }
  }

  // POST /creatorapi/delete_snapshot { app_name, snapshot_id }
  const deleteSnapshot = async (req, res) => {
    const FUNC = 'snapshotController.deleteSnapshot'
    try {
      const appName = req.body?.app_name
      const snapshotId = req.body?.snapshot_id
      if (!appName || !snapshotId) return sendFailure(res, 'app_name and snapshot_id are required.', FUNC, 400)
      const c = ctxFrom(req, res)
      if (!c.userId) return sendFailure(res, 'User not logged in.', FUNC, 401)
      if (!c.userDS) return sendFailure(res, 'User data store not available.', FUNC, 500)
      const record = await findRecord(c, appName, snapshotId)
      if (!record) return sendFailure(res, 'Snapshot not found.', FUNC, 404)
      if (record.legacy || record.reason === 'published') return sendFailure(res, 'Published versions cannot be deleted here — unpublish instead.', FUNC, 400)
      await removeZip(c, record)
      const db = await snapshotDb(c)
      await db.delete_record(record._id)
      return sendApiSuccess(res, { success: true })
    } catch (error) {
      console.error(FUNC + ' error:', error)
      return sendFailure(res, error, FUNC, 500)
    }
  }

  // POST /creatorapi/delete_app_snapshots { app_name } — used when the app itself is deleted.
  // Published zips stay (they are the public download); everything else goes.
  const deleteAppSnapshots = async (req, res) => {
    const FUNC = 'snapshotController.deleteAppSnapshots'
    try {
      const appName = req.body?.app_name
      if (!appName) return sendFailure(res, 'app_name is required.', FUNC, 400)
      const c = ctxFrom(req, res)
      if (!c.userId) return sendFailure(res, 'User not logged in.', FUNC, 401)
      if (!c.userDS) return sendFailure(res, 'User data store not available.', FUNC, 500)
      const db = await snapshotDb(c)
      const records = db ? ((await db.query({ appName }, {})) || []) : []
      let removed = 0
      for (const r of records) {
        if (r.reason === 'published') continue
        await removeZip(c, r)
        try { await db.delete_record(r._id); removed++ } catch (e) { /* keep going */ }
      }
      return sendApiSuccess(res, { success: true, removed })
    } catch (error) {
      console.error(FUNC + ' error:', error)
      return sendFailure(res, error, FUNC, 500)
    }
  }

  return {
    createSnapshot,
    listSnapshots,
    compareSnapshots,
    restoreSnapshot,
    updateSnapshot,
    deleteSnapshot,
    deleteAppSnapshots,
    downloadAppZip,
    downloadChat,
    uploadAppZip,
    uploadChat,
    takeSnapshot
  }
}

export default { createSnapshotController }
