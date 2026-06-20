// freezr.info - fsTreeCopy.mjs
//
// Provider-agnostic walk / copy / verify over a user's whole FS subtree, used by the
// file-system migration. Operates on two RAW connectors (see fsRawFactory.mjs) whose
// methods share the standard surface (readdir/readall/getFileToSend/writeFile/stat).
//
// Design notes:
//  - The key-space is the SAME relative string on source and target; only the rootFolder
//    base differs, so a file at `{srcBase}/{relPath}` copies to `{tgtBase}/{relPath}`.
//  - Copy is IDEMPOTENT: a file already present on the target with a matching byte size
//    is skipped. This is what makes the copy crash-resumable — re-running never re-copies
//    completed files, and it lets recoverOnStartup simply re-call copyTree.
//  - Copy is sequential (one file at a time); the `await` per file yields the event loop,
//    and an optional `throttle()` hook lets a busy server pace the copy down further.

const isNotFound = (err) => {
  if (!err) return false
  if (err.code === 'ENOENT') return true
  // AWS / S3-compatible SDK error shapes (HeadObject on a missing key is a normal 404)
  if (err.$metadata && err.$metadata.httpStatusCode === 404) return true
  if (err.name === 'NotFound' || err.name === 'NoSuchKey') return true
  if (err.Code === 'NoSuchKey' || err.Code === 'NotFound') return true
  // Azure / others
  if (err.statusCode === 404 || err.code === 'BlobNotFound') return true
  const m = String(err.message || '')
  return /not exist|no such file|notfound|does not exist|404/i.test(m)
}

const safeStat = async (fs, p) => {
  try {
    return await fs.stat_async(p)
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
}

const statSize = (stat) => {
  if (!stat) return undefined
  if (typeof stat.size === 'number') return stat.size
  if (typeof stat.Size === 'number') return stat.Size
  return undefined
}

// Recursive readdir+stat enumeration (local-style connectors with no readall).
const enumerateRecursive = async (fs, base, rel = '') => {
  const dirPath = rel ? base + '/' + rel : base
  let names
  try {
    names = await fs.readdir_async(dirPath, {})
  } catch (err) {
    if (isNotFound(err)) return []
    throw err
  }
  const out = []
  for (const name of (names || [])) {
    const childRel = rel ? rel + '/' + name : name
    const childPath = base + '/' + childRel
    const st = await safeStat(fs, childPath)
    if (!st) continue
    const isDir = st.type === 'dir' || (typeof st.isDirectory === 'function' && st.isDirectory())
    if (isDir) {
      const sub = await enumerateRecursive(fs, base, childRel)
      out.push(...sub)
    } else {
      out.push({ relPath: childRel, size: statSize(st) })
    }
  }
  return out
}

/**
 * List every file under `base` as { relPath, size }. Uses the connector's recursive
 * `readall` when available (one cloud call), else a recursive readdir+stat walk.
 * @returns {Promise<Array<{relPath: string, size: (number|undefined)}>>}
 */
export const enumerate = async (fs, base) => {
  if (typeof fs.readall_async === 'function') {
    let entries
    try {
      entries = await fs.readall_async(base, { includeMeta: true })
    } catch (err) {
      if (isNotFound(err)) return []
      throw err
    }
    return (entries || [])
      .filter(e => e && e.path && (e.path === base || e.path.startsWith(base + '/')))
      .map(e => ({ relPath: e.path.substring(base.length + 1), size: statSize(e) }))
      .filter(e => e.relPath && !e.relPath.endsWith('/')) // drop folder-marker keys
  }
  return enumerateRecursive(fs, base)
}

/**
 * Copy every manifest entry from source to target, skipping files already present on the
 * target with a matching byte size.
 *
 * @param {Object} args
 * @param {Object} args.srcFs - raw source connector
 * @param {Object} args.tgtFs - raw target connector
 * @param {string} args.srcBase - e.g. "users_freezr/alice" on the source
 * @param {string} args.tgtBase - e.g. "users_freezr_new/alice" on the target
 * @param {Array} args.manifest - from enumerate(srcFs, srcBase)
 * @param {function} [args.onProgress] - (state) => void; state = { filesCopied, filesSkipped, bytesCopied, totalFiles, currentPath }
 * @param {function} [args.shouldCancel] - async/sync () => boolean; checked between files
 * @param {function} [args.throttle] - async () => void; awaited between files (load throttle)
 * @returns {Promise<{filesCopied, filesSkipped, bytesCopied, cancelled}>}
 */
export const copyTree = async ({ srcFs, tgtFs, srcBase, tgtBase, manifest, onProgress, shouldCancel, throttle }) => {
  let filesCopied = 0
  let filesSkipped = 0
  let bytesCopied = 0
  const totalFiles = manifest.length

  for (const entry of manifest) {
    if (shouldCancel && (await shouldCancel())) {
      return { filesCopied, filesSkipped, bytesCopied, cancelled: true }
    }
    if (throttle) await throttle()

    const srcPath = srcBase + '/' + entry.relPath
    const tgtPath = tgtBase + '/' + entry.relPath

    // Idempotent skip: already there with matching size.
    const existing = await safeStat(tgtFs, tgtPath)
    const existingSize = statSize(existing)
    const alreadyCopied = existing && entry.size !== undefined && existingSize === entry.size
    if (alreadyCopied) {
      filesSkipped++
      bytesCopied += (entry.size || 0)
    } else {
      const buf = await srcFs.getFileToSend_async(srcPath, {})
      await tgtFs.writeFile_async(tgtPath, buf, {})
      filesCopied++
      bytesCopied += (entry.size || (buf ? buf.length : 0))
    }

    if (onProgress) {
      onProgress({ filesCopied, filesSkipped, bytesCopied, totalFiles, currentPath: entry.relPath })
    }
  }
  return { filesCopied, filesSkipped, bytesCopied, cancelled: false }
}

/**
 * Verify every manifest entry exists on the target with a matching byte size.
 * @returns {Promise<{ok: boolean, checked: number, mismatches: Array<{relPath, expected, actual, reason}>}>}
 */
export const verifyTree = async ({ tgtFs, tgtBase, manifest }) => {
  const mismatches = []
  let checked = 0
  for (const entry of manifest) {
    checked++
    const st = await safeStat(tgtFs, tgtBase + '/' + entry.relPath)
    if (!st) {
      mismatches.push({ relPath: entry.relPath, expected: entry.size, actual: null, reason: 'missing' })
      continue
    }
    const actual = statSize(st)
    if (entry.size !== undefined && actual !== undefined && actual !== entry.size) {
      mismatches.push({ relPath: entry.relPath, expected: entry.size, actual, reason: 'size_mismatch' })
    }
  }
  return { ok: mismatches.length === 0, checked, mismatches }
}

export default { enumerate, copyTree, verifyTree }
