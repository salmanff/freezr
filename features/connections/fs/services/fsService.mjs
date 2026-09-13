// freezr.info - fs connections feature: confined file-store access - fsService.mjs
//
// Opens a HANDLE onto one fs connection record (services ['fs']) and exposes the
// operations the /feps/connections/fs routes need: listDir / listTree / statEntry /
// readFile / writeFile / removeFile. All paths the app supplies are RELATIVE to the
// store's declared root and are confined to it — this file is the security boundary
// for local stores, so read the rules below before changing anything here.
//
// CONFINEMENT RULES (local stores):
//   1. App-supplied paths are sanitized lexically first (sanitizeRelPath): must be
//      relative, no null bytes, no backslashes, no '.'/'..' segments. Character
//      whitelists are deliberately NOT used — real user files have arbitrary names —
//      confinement comes from path resolution, not naming rules.
//   2. The store's rootPath is realpath-resolved and must be a directory OUTSIDE the
//      freezr installation tree (neither inside it, nor containing it): a root that
//      overlaps the freezr tree would expose other users' files and env secrets,
//      bypassing every db permission. Checked at every request, not just at creation.
//   3. Every resolved target is realpath-verified back inside the root, so a symlink
//      inside the mount pointing elsewhere cannot escape it. For writes (target may
//      not exist yet) the deepest EXISTING ancestor is realpath-verified instead.
//
// Cloud stores (dropbox/aws/...) have no symlinks; confinement there is the lexical
// sanitize + key-prefix join. They become creatable in phase 3 (OAuth wiring) but the
// handle already treats them uniformly via createRawFs.
//
// Connector normalization lives here too: listDir returns one level of
// { name, type: 'dir'|'file', size, mtimeMs } whatever the backend — readall (aws/
// azure, recursive-flat) is reduced to direct children; readdir+stat backends get a
// stat per entry; googleDrive's legacy 'folder' stat type is accepted as 'dir'.

import nodeFs from 'node:fs'
import path from 'node:path'
import { createRawFs } from '../../../../adapters/datastore/fsConnectors/fsRawFactory.mjs'

// Caps mirror buildUserFileTreeFromAppFS (cepsfepsApiController.mjs) so an app cannot
// walk a huge mount into server memory.
export const MAX_LIST_ENTRIES = 1000 // per single directory listing
export const MAX_TREE_ENTRIES = 5000 // total entries across a tree walk
export const MAX_TREE_DEPTH = 5 // listTree depth cap (list is depth 1)
export const MAX_READ_BYTES = 100 * 1024 * 1024 // refuse larger file reads (100MB)
export const MAX_WRITE_BYTES = 50 * 1024 * 1024 // refuse larger file writes (50MB)

const fsError = (message, { status = 400, code = 'fs_error' } = {}) => {
  const e = new Error(message)
  e.status = status
  e.code = code
  return e
}

const isEnoent = (e) => e && (e.code === 'ENOENT' || /no such file or directory/i.test(e.message || ''))

/**
 * Lexical sanitize of an app-supplied path. Returns a cleaned RELATIVE posix path
 * ('' = the store root). Throws 400 on anything that is not a plain relative path.
 * This is only the first gate — local stores are additionally realpath-confined.
 */
export const sanitizeRelPath = (input) => {
  if (input === undefined || input === null || input === '') return ''
  if (typeof input !== 'string') throw fsError('path must be a string', { code: 'invalid_path' })
  if (input.length > 4096) throw fsError('path too long', { code: 'invalid_path' })
  if (input.includes('\0')) throw fsError('path contains a null byte', { code: 'invalid_path' })
  if (input.includes('\\')) throw fsError('path must use forward slashes', { code: 'invalid_path' })
  if (input.startsWith('/')) throw fsError('path must be relative to the store root', { code: 'invalid_path' })
  const parts = []
  for (const part of input.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') throw fsError('path may not contain ".." segments', { code: 'invalid_path' })
    parts.push(part)
  }
  return parts.join('/')
}

/**
 * Resolve and vet a LOCAL store's declared rootPath. Throws unless it is an absolute
 * path to an existing directory that neither contains nor sits inside the freezr
 * installation tree. Returns the realpath'd root.
 */
export const resolveLocalRootOrThrow = (rootPath, { freezrRoot = process.cwd() } = {}) => {
  if (!rootPath || typeof rootPath !== 'string') {
    throw fsError('local file store has no rootPath configured', { code: 'invalid_root' })
  }
  if (!path.isAbsolute(rootPath)) {
    throw fsError('local file store rootPath must be an absolute path', { code: 'invalid_root' })
  }
  let rootReal
  try {
    rootReal = nodeFs.realpathSync(rootPath)
  } catch (e) {
    throw fsError('local file store rootPath does not exist: ' + rootPath, { status: 404, code: 'invalid_root' })
  }
  let stat
  try {
    stat = nodeFs.statSync(rootReal)
  } catch (e) {
    throw fsError('local file store rootPath is not accessible', { status: 404, code: 'invalid_root' })
  }
  if (!stat.isDirectory()) throw fsError('local file store rootPath is not a directory', { code: 'invalid_root' })

  let freezrReal
  try {
    freezrReal = nodeFs.realpathSync(freezrRoot)
  } catch (e) {
    freezrReal = path.resolve(freezrRoot)
  }
  const contains = (outer, inner) => inner === outer || inner.startsWith(outer + path.sep)
  if (contains(freezrReal, rootReal) || contains(rootReal, freezrReal)) {
    throw fsError('local file store rootPath may not overlap the freezr installation directory', { status: 403, code: 'forbidden_root' })
  }
  return rootReal
}

// Deepest existing ancestor of an absolute path (for realpath-vetting write targets).
const deepestExistingAncestor = (absPath) => {
  let current = absPath
  for (let i = 0; i < 500; i++) {
    if (nodeFs.existsSync(current)) return current
    const parent = path.dirname(current)
    if (parent === current) return current
    current = parent
  }
  return current
}

/**
 * Confine one sanitized relative path inside a vetted local root. Returns the
 * absolute path to operate on. `mustExist` 404s on a missing target; `forWrite`
 * realpath-vets the deepest existing ancestor instead of the (possibly missing)
 * target itself.
 */
export const confineLocalPath = ({ rootReal, relPath, mustExist = false, forWrite = false }) => {
  const rel = sanitizeRelPath(relPath)
  const abs = rel ? path.resolve(rootReal, rel) : rootReal
  const inRoot = (p) => p === rootReal || p.startsWith(rootReal + path.sep)
  // sanitizeRelPath already bars traversal; this is belt-and-braces against resolve surprises.
  if (!inRoot(abs)) throw fsError('path escapes the file store root', { status: 403, code: 'path_escape' })

  const exists = nodeFs.existsSync(abs)
  if (!exists && mustExist) throw fsError('no such file or directory: ' + rel, { status: 404, code: 'not_found' })
  if (!exists && !forWrite) return abs

  // realpath the target (or, for a missing write target, its deepest existing
  // ancestor) so symlinks inside the mount cannot point operations outside it.
  const vetTarget = exists ? abs : deepestExistingAncestor(abs)
  let real
  try {
    real = nodeFs.realpathSync(vetTarget)
  } catch (e) {
    throw fsError('could not resolve path: ' + rel, { status: 404, code: 'not_found' })
  }
  if (!inRoot(real)) throw fsError('path resolves outside the file store root (symlink?)', { status: 403, code: 'path_escape' })
  return abs
}

const normalizeType = (t) => (t === 'dir' || t === 'directory' || t === 'folder') ? 'dir' : 'file'

const normalizeStat = (name, st) => ({
  name,
  type: normalizeType(st?.type || (typeof st?.isDirectory === 'function' && st.isDirectory() ? 'dir' : 'file')),
  size: typeof st?.size === 'number' ? st.size : null,
  mtimeMs: typeof st?.mtimeMs === 'number' ? st.mtimeMs : (st?.mtime ? new Date(st.mtime).getTime() : null)
})

const sortEntries = (entries) => entries.sort((a, b) =>
  (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)))

/**
 * Open a handle onto one fs connection record's store.
 *
 * @param {Object} connection  decrypted connection record ({ fsParams, connectionName, ... })
 * @returns {Promise<Object>}  { storeType, listDir, listTree, statEntry, readFile, writeFile, removeFile }
 */
export const openFsHandle = async (connection) => {
  const fsParams = connection?.fsParams
  if (!fsParams || typeof fsParams !== 'object' || !fsParams.type) {
    throw fsError('file store connection has no usable fsParams', { status: 500, code: 'invalid_store' })
  }
  const isLocal = fsParams.type === 'local'

  // keyFor: sanitized rel path -> the key/path the connector operates on.
  let keyFor
  if (isLocal) {
    const rootReal = resolveLocalRootOrThrow(fsParams.rootPath)
    keyFor = (relPath, opts = {}) => confineLocalPath({ rootReal, relPath, ...opts })
  } else {
    // Cloud stores: keys are relative to the bucket/app-folder root; an optional
    // rootFolder narrows the store to a subtree. No symlinks to vet.
    const base = typeof fsParams.rootFolder === 'string'
      ? fsParams.rootFolder.replace(/^\/+|\/+$/g, '')
      : ''
    keyFor = (relPath) => {
      const rel = sanitizeRelPath(relPath)
      return base ? (rel ? base + '/' + rel : base) : rel
    }
  }

  const conn = await createRawFs(
    isLocal ? { type: 'local' } : fsParams,
    { skipInit: isLocal } // local needs no init; cloud connectors authenticate in initFS
  )

  const statEntry = async (relPath) => {
    const key = keyFor(relPath, { mustExist: true })
    try {
      const st = await conn.stat_async(key)
      const rel = sanitizeRelPath(relPath)
      return normalizeStat(rel ? rel.split('/').pop() : '', st)
    } catch (e) {
      if (isEnoent(e)) throw fsError('no such file or directory: ' + relPath, { status: 404, code: 'not_found' })
      throw e
    }
  }

  // One level of a directory, normalized. readall backends (aws/azure) return a
  // recursive flat key list — reduce it to direct children; the others readdir names
  // and stat each entry.
  const listDir = async (relPath, { limit = MAX_LIST_ENTRIES } = {}) => {
    const cap = Math.min(Math.max(1, limit), MAX_LIST_ENTRIES)
    const key = keyFor(relPath, { mustExist: isLocal })
    if (isLocal) {
      const st = await conn.stat_async(key)
      if (normalizeType(st.type) !== 'dir') throw fsError('not a directory: ' + relPath, { code: 'not_a_directory' })
    }

    if (typeof conn.readall_async === 'function') {
      const all = await conn.readall_async(key, { includeMeta: true }) || []
      const dirs = new Map() // first segment -> true
      const files = []
      for (const item of all) {
        let p = typeof item === 'string' ? item : item.path
        if (!p) continue
        // Tolerate both key shapes (relative to the listed dir, or the full key).
        if (key && p.startsWith(key + '/')) p = p.slice(key.length + 1)
        else if (key && p === key) continue
        const slash = p.indexOf('/')
        if (slash === -1) {
          files.push({ name: p, type: 'file', size: item.size ?? null, mtimeMs: item.mtimeMs ?? null })
        } else {
          dirs.set(p.slice(0, slash), true)
        }
      }
      const entries = [...dirs.keys()].map(name => ({ name, type: 'dir', size: null, mtimeMs: null })).concat(files)
      sortEntries(entries)
      return { entries: entries.slice(0, cap), truncated: entries.length > cap }
    }

    let names = await conn.readdir_async(key, {}) || []
    const truncated = names.length > cap
    names = names.slice(0, cap)
    const entries = []
    for (const name of names) {
      // stat via keyFor so a symlinked entry gets the same confinement vetting;
      // an entry that escapes (or vanished mid-listing) is skipped, not fatal.
      try {
        const rel = (sanitizeRelPath(relPath) ? sanitizeRelPath(relPath) + '/' : '') + name
        const entryKey = keyFor(rel, { mustExist: true })
        const st = await conn.stat_async(entryKey)
        entries.push(normalizeStat(name, st))
      } catch (e) {
        if (e.code === 'path_escape' || e.code === 'invalid_path' || isEnoent(e) || e.code === 'not_found') continue
        throw e
      }
    }
    sortEntries(entries)
    return { entries, truncated }
  }

  // Depth-limited tree walk built on listDir, with a global entry budget.
  const listTree = async (relPath, { depth = 1 } = {}) => {
    const maxDepth = Math.min(Math.max(1, depth), MAX_TREE_DEPTH)
    let count = 0
    let truncated = false
    const walk = async (rel, level) => {
      const { entries, truncated: dirTruncated } = await listDir(rel, {})
      if (dirTruncated) truncated = true
      const out = []
      for (const entry of entries) {
        if (count >= MAX_TREE_ENTRIES) { truncated = true; break }
        count++
        const node = { ...entry }
        if (entry.type === 'dir' && level < maxDepth) {
          try {
            node.children = await walk((rel ? rel + '/' : '') + entry.name, level + 1)
          } catch (e) {
            node.children = []
            node.error = 'unreadable'
          }
        }
        out.push(node)
      }
      return out
    }
    const tree = await walk(sanitizeRelPath(relPath), 1)
    return { tree, count, truncated }
  }

  const readFile = async (relPath) => {
    const rel = sanitizeRelPath(relPath)
    if (!rel) throw fsError('a file path is required', { code: 'invalid_path' })
    const key = keyFor(rel, { mustExist: isLocal })
    try {
      const st = await conn.stat_async(key)
      if (normalizeType(st.type) === 'dir') throw fsError('path is a directory, not a file: ' + rel, { code: 'not_a_file' })
      if (typeof st.size === 'number' && st.size > MAX_READ_BYTES) {
        throw fsError('file too large to read via this API (' + st.size + ' bytes; limit ' + MAX_READ_BYTES + ')', { status: 413, code: 'file_too_large' })
      }
    } catch (e) {
      if (isEnoent(e)) throw fsError('no such file: ' + rel, { status: 404, code: 'not_found' })
      throw e
    }
    // getFileToSend (NOT readFile): readFile string-decodes and corrupts binary.
    const content = await conn.getFileToSend_async(key, {})
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content || '')
    return { buffer, name: rel.split('/').pop() }
  }

  const writeFile = async (relPath, buffer, { overwrite = false } = {}) => {
    const rel = sanitizeRelPath(relPath)
    if (!rel) throw fsError('a file path is required', { code: 'invalid_path' })
    if (!Buffer.isBuffer(buffer)) throw fsError('content must be a buffer', { status: 500, code: 'invalid_content' })
    if (buffer.length > MAX_WRITE_BYTES) {
      throw fsError('content too large to write via this API (' + buffer.length + ' bytes; limit ' + MAX_WRITE_BYTES + ')', { status: 413, code: 'content_too_large' })
    }
    const key = keyFor(rel, { forWrite: true })
    if (isLocal) {
      // Overwriting a directory with a file must fail before the connector tries.
      try {
        const st = await conn.stat_async(key)
        if (normalizeType(st.type) === 'dir') throw fsError('path is a directory: ' + rel, { code: 'not_a_file' })
        if (!overwrite) throw fsError('file exists and overwrite was not set: ' + rel, { status: 409, code: 'file_exists' })
      } catch (e) {
        if (!isEnoent(e) && e.code !== 'not_found') throw e
      }
    }
    try {
      await conn.writeFile_async(key, buffer, { doNotOverWrite: !overwrite })
    } catch (e) {
      if (/File exists/i.test(e.message || '')) throw fsError('file exists and overwrite was not set: ' + rel, { status: 409, code: 'file_exists' })
      throw e
    }
    return { written: true, path: rel, size: buffer.length }
  }

  // Files only — recursive folder removal is deliberately not offered (most
  // destructive, least needed; see the plan doc).
  const removeFile = async (relPath) => {
    const rel = sanitizeRelPath(relPath)
    if (!rel) throw fsError('a file path is required', { code: 'invalid_path' })
    const key = keyFor(rel, { mustExist: isLocal })
    try {
      const st = await conn.stat_async(key)
      if (normalizeType(st.type) === 'dir') throw fsError('path is a directory — folder removal is not supported: ' + rel, { code: 'not_a_file' })
    } catch (e) {
      if (isEnoent(e)) throw fsError('no such file: ' + rel, { status: 404, code: 'not_found' })
      throw e
    }
    await conn.unlink_async(key)
    return { removed: true, path: rel }
  }

  return { storeType: fsParams.type, listDir, listTree, statEntry, readFile, writeFile, removeFile }
}

export default { openFsHandle, sanitizeRelPath, resolveLocalRootOrThrow, confineLocalPath }
