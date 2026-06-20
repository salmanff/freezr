/* global freezr */

import { tsOf } from './utils.js'

export const fetchAppHistory = async (appName, options = {}) => {
  try {
    const count = options.count || 200
    const results = await freezr.query('appUpdates', { appName }, { sort: { _date_modified: -1 }, count })
    if (!results || !Array.isArray(results)) return []
    results.sort((a, b) => tsOf(b) - tsOf(a))
    return results
  } catch (error) {
    console.warn('Could not fetch app history:', error)
    return []
  }
}

export const addHistoryEntry = async (appName, action, extra = {}) => {
  try {
    const entry = { appName, action, timestamp: new Date().toISOString(), ...extra }
    const result = await freezr.create('appUpdates', entry)
    const _id = result?._id || result?.id || null
    return { ...entry, _id }
  } catch (error) {
    console.warn('Could not add history entry:', error)
    return null
  }
}

// NOTE: freezr.update on a CEPS (own-app) collection REPLACES the whole record —
// it does not merge fields (see cepsfepsApiController: replaceAllFields = isCeps ? true).
// So we read the existing entry first and merge `fields` over it; otherwise a partial
// update like { summary } would wipe appName/action and the entry would drop out of
// the appName-scoped history query on the next reload.
export const updateHistoryEntry = async (id, fields, options = {}) => {
  try {
    let base = {}
    try {
      const existing = await freezr.read('appUpdates', id)
      if (existing && typeof existing === 'object' && !existing.error) {
        base = Array.isArray(existing) ? (existing[0] || {}) : existing
      }
    } catch (e) { /* fall back to fields-only if the read fails */ }

    const payload = { ...base, ...fields }
    // Strip freezr system fields (_id, _date_created, _date_modified, …) from the body.
    for (const key of Object.keys(payload)) {
      if (key.startsWith('_')) delete payload[key]
    }
    if (!options.preserveTimestamp) payload.timestamp = new Date().toISOString()

    await freezr.update('appUpdates', id, payload)
    return true
  } catch (error) {
    console.warn('Could not update history entry:', error)
    return false
  }
}

const ACTION_LABELS = {
  created: 'App created',
  updated: 'Files updated',
  chat: 'Chat update',
  manual_update: 'Manual update',
  file_edit: 'File edited',
  image_generation: 'Image generated',
  external_change: 'Changed outside Creator',
  context_updated: 'Reference doc updated',
  published: 'App published',
  unpublished: 'App unpublished',
  renamed: 'App renamed'
}

export const labelForAction = (action) => ACTION_LABELS[action] || action || 'Unknown'
