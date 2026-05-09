/* global freezr */
import { escHtml } from './utils.js'

export const fetchFolderTree = async (appName) => {
  try {
    const result = await freezr.apiRequest('GET', '/creatorapi/read_folder?app_name=' + encodeURIComponent(appName))
    if (result && Array.isArray(result.tree)) return result.tree
    return []
  } catch (error) {
    console.warn('Could not fetch folder tree:', error)
    return []
  }
}

export const fetchFileContent = async (appName, filePath) => {
  const url = '/creatorapi/read_app_file?app_name=' + encodeURIComponent(appName) + '&file_path=' + encodeURIComponent(filePath)
  const result = await freezr.apiRequest('GET', url)
  if (!result || result.error) {
    throw new Error(result?.error || 'Could not read file.')
  }
  return result.content
}

const FILE_ICONS = {
  html: '<span class="ft-icon ft-icon-html">&#9671;</span>',
  htm: '<span class="ft-icon ft-icon-html">&#9671;</span>',
  css: '<span class="ft-icon ft-icon-css">&#9670;</span>',
  js: '<span class="ft-icon ft-icon-js">&#9674;</span>',
  mjs: '<span class="ft-icon ft-icon-js">&#9674;</span>',
  json: '<span class="ft-icon ft-icon-json">{ }</span>',
  md: '<span class="ft-icon ft-icon-md">M</span>',
  txt: '<span class="ft-icon ft-icon-txt">T</span>'
}
const DEFAULT_FILE_ICON = '<span class="ft-icon ft-icon-other">&#9702;</span>'

const fileIcon = (name) => {
  const ext = (name || '').split('.').pop().toLowerCase()
  return FILE_ICONS[ext] || DEFAULT_FILE_ICON
}

const renderNode = (node, depth = 0) => {
  const indent = depth * 16
  if (node.type === 'folder') {
    const childrenHtml = (node.children || []).map((child) => renderNode(child, depth + 1)).join('')
    return `<div class="ft-folder">
      <div class="ft-folder-row" style="padding-left:${indent}px">
        <span class="ft-toggle" data-toggle-path="${escHtml(node.path)}">▼</span>
        <span class="ft-folder-label" data-path="${escHtml(node.path)}">📁 ${escHtml(node.name)}</span>
      </div>
      <div class="ft-folder-children" data-children-path="${escHtml(node.path)}">${childrenHtml}</div>
    </div>`
  }
  const ext = (node.name || '').split('.').pop().toLowerCase()
  return `<div class="ft-file ft-ext-${ext}" style="padding-left:${indent}px" data-path="${escHtml(node.path)}">${fileIcon(node.name)} ${escHtml(node.name)}</div>`
}

export const renderFileTree = (tree) => {
  if (!tree || tree.length === 0) return '<p class="ft-empty">No files yet.</p>'
  const rootEntry = `<div class="ft-folder-row ft-root-row"><span class="ft-folder-label" data-path="">📁 / (root)</span></div>`
  return `<div class="ft-root">${rootEntry}${tree.map((node) => renderNode(node, 0)).join('')}</div>`
}
