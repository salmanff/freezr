// picture.js - a service in freezr

const sharp = require('sharp')

exports.convert = async function (file, options, callback) {
  // options can be width and type
  // onsole.log('converting ', { options })

  try {
    const name = file.originalname
    const currentFileExt = getCurrentValidExtension(name)
    if (!currentFileExt) return callback(new Error('invalid file type'))
    if (!options.type) options.type = currentFileExt

    const convertedFile = await sharp(file.buffer)
      .resize({ width: options.width })
      .toFormat(options.type)
      .toBuffer()
    return callback(null, convertedFile)
  } catch (e) {
    console.warn('converting picture error ', e)
    callback(e)
  }
}

const ACCEPTED_INPUT_TYPES = ['JPG', 'JPEG', 'PNG', 'WEBP', 'GIF', 'AVIF', 'TIFF', 'SVG']

const getCurrentValidExtension = function (filename) {
  const ext = getFileExtension(filename)
  if (ext && ACCEPTED_INPUT_TYPES.includes(ext.toUpperCase())) return ext
  console.warn('invalid extession - got null for ' + filename)
  return null
}

const getFileExtension = function (filename) {
  if (!filename) return null
  const parts = filename.split('.')
  if (parts.length < 2) return null
  const ext = parts[parts.length - 1]
  return ext
}
