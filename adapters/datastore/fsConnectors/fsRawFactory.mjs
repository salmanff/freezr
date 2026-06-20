// freezr.info - fsRawFactory.mjs
//
// Instantiate a *raw* file-system connector directly from a set of fsParams, with no
// USER_DS / per-app path wrapping and no cache layer. Used by the FS migration to get
// low-level handles on BOTH the source and target file systems at once, so it can walk
// and copy a user's whole subtree ({rootFolder}/{owner}/...) independent of app paths.
//
// USER_DS is built around one user's *current* fs (per-app path helpers, in-memory cache,
// local-disk mirror) and cannot represent two filesystems simultaneously — hence this bare
// factory. The returned connector exposes the standard surface as promisified `*_async`
// methods (readFile/writeFile/readdir/getFileToSend/stat/isPresent/removeFolder/mkdirp/
// size/initFS, plus `readall` where the connector provides it).
//
// Connectors are the modern ones in adapters/datastore/fsConnectors (dbfs_<type>.mjs).
// The instantiate + promisify shape mirrors USER_DS.initAppFS (userDsMgr.mjs ~684-714).

const CLOUD_TYPES = ['azure', 'aws', 'dropbox', 'googleDrive', 'fdsFairOs']

// Callback-style functions we promisify (superset of initAppFS's list, plus isPresent).
// NOTE: `readall` is deliberately NOT in this list — see below.
const FS_FUNCTIONS = [
  'initFS', 'readFile', 'writeFile', 'unlink', 'removeFolder', 'mkdirp',
  'size', 'getFileToSend', 'readdir', 'stat', 'isPresent'
]

const promisify = (fsObj) => {
  FS_FUNCTIONS.forEach(funcName => {
    const asyncFuncName = `${funcName}_async`
    if (!fsObj[asyncFuncName] && typeof fsObj[funcName] === 'function') {
      fsObj[asyncFuncName] = function (...args) {
        return new Promise((resolve, reject) => {
          fsObj[funcName](...args, (err, result) => {
            if (err) reject(err)
            else resolve(result)
          })
        })
      }
    }
  })

  // `readall`, where a connector provides it (aws/azure), is ALREADY a Promise-returning
  // method taking (dirPath, options) — unlike the callback-style methods above. So alias it
  // straight through. Callback-wrapping it (passing a 3rd callback arg it never calls) yields
  // a readall_async that never resolves, which hung the migration in enumerate() for any
  // cloud SOURCE. Connectors without readall (local/dropbox/googleDrive) fall back to the
  // recursive readdir+stat walk in fsTreeCopy.enumerate.
  if (typeof fsObj.readall === 'function' && typeof fsObj.readall_async !== 'function') {
    fsObj.readall_async = (...args) => fsObj.readall(...args)
  }

  return fsObj
}

/**
 * Build and initialise a raw connector for the given (decrypted, resolved) fsParams.
 * @param {Object} fsParams - decrypted fs params: { type, rootFolder, ...creds }. `type`
 *   must be 'local' or one of the modern cloud connectors; 'system' must be resolved by the
 *   caller to its underlying params first.
 * @param {Object} [options]
 * @param {boolean} [options.skipInit] - don't call initFS (e.g. when you only need path math)
 * @returns {Promise<Object>} the connector instance with `*_async` methods
 */
export const createRawFs = async (fsParams, options = {}) => {
  if (!fsParams || !fsParams.type) throw new Error('createRawFs: fsParams.type is required')

  let fsObj
  try {
    if (fsParams.type === 'local') {
      const { default: LocalFS } = await import('./dbfs_local.mjs')
      fsObj = LocalFS // shared stateless singleton; paths carry the rootFolder
    } else if (CLOUD_TYPES.includes(fsParams.type)) {
      const { cloudFS } = await import('./dbfs_' + fsParams.type + '.mjs')
      fsObj = new cloudFS(fsParams, { doNotPersistOnLoad: true })
    } else {
      throw new Error('Unsupported fs type for migration: "' + fsParams.type + '"')
    }
  } catch (e) {
    console.warn('🔴 createRawFs', 'failed to instantiate connector for fs type ' + fsParams.type, { error: e.message })
    throw new Error('Could not instantiate fs connector for type ' + fsParams.type + ': ' + e.message)
  }

  promisify(fsObj)

  if (!options.skipInit && typeof fsObj.initFS_async === 'function') {
    await fsObj.initFS_async()
  }

  return fsObj
}

/**
 * The on-disk/object key-space base for a user's whole subtree on a given fs.
 * Connectors operate on keys relative to the repo root (= process cwd) for local, and
 * relative to the bucket/container root for cloud — the SAME string in both cases.
 * @param {Object} fsParams - decrypted/resolved fs params
 * @param {string} owner - user id
 * @returns {string} e.g. "users_freezr/alice"
 */
export const userSubtreeBase = (fsParams, owner) => {
  const root = (fsParams && fsParams.rootFolder) || 'users_freezr'
  return root + '/' + owner
}

export default { createRawFs, userSubtreeBase }
