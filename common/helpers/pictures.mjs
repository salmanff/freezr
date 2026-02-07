// freezr.info - Modern ES6 Module - Picture Utilities
// Picture conversion utilities using sharp
// Modernized version of freezr_system/utils/pictures.js

import sharp from 'sharp'

const ACCEPTED_INPUT_TYPES = ['JPG', 'JPEG', 'PNG', 'WEBP', 'GIF', 'AVIF', 'TIFF', 'SVG']

/**
 * Get file extension from filename
 * @param {string} filename - File name
 * @returns {string|null} - File extension or null
 */
const getFileExtension = (filename) => {
  if (!filename) return null
  const parts = filename.split('.')
  if (parts.length < 2) return null
  return parts[parts.length - 1]
}

/**
 * Get current valid extension from filename
 * @param {string} filename - File name
 * @returns {string|null} - Valid extension or null
 */
const getCurrentValidExtension = (filename) => {
  const ext = getFileExtension(filename)
  if (ext && ACCEPTED_INPUT_TYPES.includes(ext.toUpperCase())) return ext
  console.warn('invalid extension - got null for ' + filename)
  return null
}

/**
 * Convert a picture file using sharp
 * Modernized version with Promise support (callback is optional for backward compatibility)
 * 
 * @param {Object} file - File object with buffer and originalname
 * @param {Object} options - Conversion options
 * @param {number} options.width - Target width for resizing
 * @param {string} options.type - Output format (jpg, png, webp, etc.)
 * @param {Function} callback - Optional callback (for backward compatibility)
 * @returns {Promise<Buffer>|void} - Returns Promise if no callback, void if callback provided
 */
export const convert = async (file, options, callback) => {
  // Support both callback and Promise patterns
  const useCallback = typeof callback === 'function'
  
  try {
    const name = file.originalname
    const currentFileExt = getCurrentValidExtension(name)
    if (!currentFileExt) {
      const error = new Error('invalid file type')
      if (useCallback) return callback(error)
      throw error
    }
    
    if (!options.type) options.type = currentFileExt

    const convertedFile = await sharp(file.buffer)
      .resize({ width: options.width })
      .toFormat(options.type)
      .toBuffer()
    
    if (useCallback) {
      return callback(null, convertedFile)
    }
    return convertedFile
  } catch (e) {
    console.warn('converting picture error ', e)
    if (useCallback) {
      return callback(e)
    }
    throw e
  }
}

/**
 * Get accepted input types for picture conversion
 * @returns {string[]} - Array of accepted file extensions
 */
export const getAcceptedInputTypes = () => {
  return [...ACCEPTED_INPUT_TYPES]
}

/**
 * Check if a file extension is valid for picture conversion
 * @param {string} extension - File extension to check
 * @returns {boolean} - True if extension is valid
 */
export const isValidPictureExtension = (extension) => {
  if (!extension) return false
  return ACCEPTED_INPUT_TYPES.includes(extension.toUpperCase())
}

export default {
  convert,
  getAcceptedInputTypes,
  isValidPictureExtension
}

