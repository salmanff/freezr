/* global freezr */

export const fetchAppHistory = async (appName, options = {}) => {
  try {
    const count = options.count || 200
    const results = await freezr.query('appUpdates', { appName }, { sort: { timestamp: -1 }, count })
    if (!results || !Array.isArray(results)) return []
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

export const updateHistoryEntry = async (id, fields, options = {}) => {
  try {
    const payload = options.preserveTimestamp
      ? { ...fields }
      : { ...fields, timestamp: new Date().toISOString() }
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
  published: 'App published',
  unpublished: 'App unpublished',
  renamed: 'App renamed'
}

export const labelForAction = (action) => ACTION_LABELS[action] || action || 'Unknown'
