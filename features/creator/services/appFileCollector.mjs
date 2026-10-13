// App-folder listing/reading helpers shared by the creator controllers (file panel, publish/share
// zips, clone, rename, and the whole-app snapshots in snapshotController.mjs).
//
// Moved out of creatorApiController.mjs so the snapshot controller can use them without importing
// the (much larger) main controller.

import fs from 'fs'
import path from 'path'

export const buildFolderTree = async (dirPath, relativeTo) => {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
  const tree = []
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    const relPath = path.relative(relativeTo, fullPath)
    if (entry.isDirectory()) {
      tree.push({ name: entry.name, path: relPath, type: 'folder', children: await buildFolderTree(fullPath, relativeTo) })
    } else {
      tree.push({ name: entry.name, path: relPath, type: 'file' })
    }
  }
  tree.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return tree
}

export const collectFilePaths = (tree, out = []) => {
  for (const node of tree) {
    if (node.type === 'file') out.push(node.path)
    else if (node.children) collectFilePaths(node.children, out)
  }
  return out
}

// On cloud hosts (Azure/AWS/…) the local disk under the repo root is a NON-authoritative, per-instance
// cache — files an app owns live in the cloud store, and may be absent locally (fresh instance, eviction,
// a best-effort local write that failed). So listing/zipping an app's files by reading the local FS
// (fs.promises) silently misses files. These helpers read via the CONNECTOR (dsManager) for cloud
// backends, falling back to the local FS only for the 'local'/'glitch' backends where the disk IS
// authoritative. See freezr_askapp_sharing_summary.md (Azure file-visibility fix).
export const usesLocalDisk = (appFS) => {
  const type = appFS && appFS.fsParams && appFS.fsParams.type
  return !type || type === 'local' || type === 'glitch'
}

// Build a nested folder tree (same shape as buildFolderTree) from a FLAT list of relative file paths.
export const buildTreeFromPaths = (paths) => {
  const root = []
  const dirIndex = new Map() // relDir -> children array
  const ensureDir = (relDir) => {
    if (!relDir) return root
    if (dirIndex.has(relDir)) return dirIndex.get(relDir)
    const parts = relDir.split('/')
    const parent = ensureDir(parts.slice(0, -1).join('/'))
    const children = []
    parent.push({ name: parts[parts.length - 1], path: relDir, type: 'folder', children })
    dirIndex.set(relDir, children)
    return children
  }
  for (const p of (paths || [])) {
    if (!p) continue
    const norm = String(p).replace(/\\/g, '/').replace(/^\/+/, '')
    if (!norm) continue
    const parts = norm.split('/')
    ensureDir(parts.slice(0, -1).join('/')).push({ name: parts[parts.length - 1], path: norm, type: 'file' })
  }
  const sortTree = (nodes) => {
    nodes.sort((a, b) => (a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name)))
    for (const n of nodes) if (n.children) sortTree(n.children)
    return nodes
  }
  return sortTree(root)
}

// All app file paths (relative), authoritative: connector for cloud, local FS for local/glitch.
export const listAppFilePaths = async (appFS) => {
  if (!usesLocalDisk(appFS) && typeof appFS.readAppDir === 'function') {
    const entries = await appFS.readAppDir('') // cloud connectors return a flat recursive list
    return (entries || []).map((e) => String(e).replace(/\\/g, '/').replace(/^\/+/, '')).filter(Boolean)
  }
  const rootAbsPath = path.resolve(appFS.pathToFile(''))
  if (!fs.existsSync(rootAbsPath)) return []
  return collectFilePaths(await buildFolderTree(rootAbsPath, rootAbsPath)).map((p) => p.replace(/\\/g, '/'))
}

// All app files as {relPath: Uint8Array} for zipping — bytes read via readAppFile (connector-backed).
export const collectAppFileBuffers = async (appFS) => {
  const result = {}
  for (const rel of await listAppFilePaths(appFS)) {
    try {
      const buf = await appFS.readAppFile(rel, { doNotToString: true })
      if (buf != null) result[rel] = new Uint8Array(Buffer.isBuffer(buf) ? buf : Buffer.from(buf))
    } catch (e) { console.warn('collectAppFileBuffers: could not read', rel, e.message) }
  }
  return result
}
