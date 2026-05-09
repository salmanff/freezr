/* global freezr */

export const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const saveFileToBackend = async (appName, filePath, content, action = 'upsert') => {
  return freezr.apiRequest('POST', '/creatorapi/write_app_file', {
    app_name: appName,
    file_path: filePath,
    content,
    action
  })
}

export const updateAppFromFiles = async (appName) => {
  return freezr.apiRequest('POST', '/creatorapi/update_app_from_files', { app_name: appName })
}
