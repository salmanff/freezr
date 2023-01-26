// drawJson.js
// some what prettifies a json object and allows for editing of the object
/* global */

const createObjectDiv = function (record, options = {}) {
  const { isTopLevel, editable } = options
  const recordDiv = document.createElement('div')
  recordDiv.style['background-color'] = 'rgb(255 255 255 / 50%)'
  recordDiv.style['border-radius'] = '5px'
  recordDiv.style.padding = '10px'
  recordDiv.style.margin = '10px'
  recordDiv.style.border = '1px dotted grey'
  recordDiv.style['font-size'] = '14px'

  const sortedKeys = []
  for (const key in record) { sortedKeys.push(key) }
  sortedKeys.sort()
  sortedKeys.forEach(key => {
    const pairDiv = document.createElement('div')
    pairDiv.style.display = 'grid'
    pairDiv.style['grid-template-columns'] = '1fr 5fr'
    pairDiv.style.margin = '3px'
    const keySpan = document.createElement('div')
    keySpan.style['margin-right'] = ' 3px'
    keySpan.style.color = 'red'
    keySpan.innerHTML = key + ':'
    pairDiv.appendChild(keySpan)
    options.key = key
    const valueDiv = createValueDiv(record[key], options)
    if (isTopLevel) {
      valueDiv.setAttribute('data-key', key)
      valueDiv.setAttribute('data-originalValue', JSON.stringify(record[key]))
      valueDiv.setAttribute('data-id', record._id)
    }
    if (editable) {
      valueDiv.ondblclick = function (e) {
        if (!e.target.getAttribute('contenteditable') && e.target.getAttribute('data-key') !== '_id') {
          const originalValueDiv = getTopLevelObjectValueDivFrom(e)
          originalValueDiv.innerHTML = originalValueDiv.getAttribute('data-originalValue')
          e.target.setAttribute('contenteditable', true)
          e.target.style.border = '1px solid grey'
          const saveOuters = getDivWith({ saveOuter: true, id: originalValueDiv.getAttribute('data-id') })
          saveOuters[0].style.display = 'block'
        }
        // show save butt
      }
    }

    pairDiv.appendChild(valueDiv)
    recordDiv.appendChild(pairDiv)
  })
  if (isTopLevel) {
    const outer = document.createElement('div')
    outer.setAttribute('data-id', record._id)
    outer.setAttribute('data-parent', true)
    outer.appendChild(recordDiv)
    const editButt = document.createElement('div')
    editButt.setAttribute('data-id', record._id)
    editButt.setAttribute('data-saveOuter', true)
    editButt.style.margin = '-10px 10px 40px 0px'
    editButt.style['text-align'] = 'right'
    editButt.style.display = 'none'
    const warning = document.createElement('span')
    warning.innerHTML = 'Please only save if you REALLY KNOW what you are doing!'
    warning.style.color = 'red'
    const discardBut = document.createElement('div')
    discardBut.innerHTML = 'Discard Changes'
    discardBut.className = 'freezer_butt'
    discardBut.style.display = 'inline-block'
    discardBut.onclick = function (e) {
      const parent = getRecordOuterDivFrom(e.target)
      parent.parentNode.replaceChild(createObjectDiv(record, options), parent)
    }
    const saveButt = document.createElement('div')
    saveButt.innerHTML = '-- SAVE --'
    saveButt.className = 'freezer_butt'
    saveButt.style.display = 'inline-block'
    saveButt.onclick = async function (e) {
      // get all the changed records
      // change the actual record
      // update the record online
      let failed = false
      for (const key in record) {
        const keyDiv = getDivWith({ id: record._id, key }, true)
        if (!failed && keyDiv && keyDiv.getAttribute('contenteditable')) {
          try {
            const val = JSON.parse(keyDiv.innerHTML)
            record[key] = val
          } catch (e) {
            failed = true
            getDivWith({ id: record._id, warnDiv: true }, true).innerHTML = 'Could Not Parse editing div with key "' + key + '". Please press Discard or re-edit.'
          }
        }
      }
      if (!failed && record._id /* just in case;)  */) {
        if (!options.updateRecord) options.updateRecord = function (record, cb) { cb(null, { error: null, nModified: 0 }) }
        const updateCb = function (err, ret) {
          if (err || !ret || ret.error) {
            getDivWith({ id: record._id, warnDiv: true }, true).innerHTML = 'Error Updating Record. Best to refresh'
          } else {
            // {err: null, ret: {nModified: 1, useage: {…}, error: null} }
            const parent = getRecordOuterDivFrom(e.target)
            parent.parentNode.replaceChild(createObjectDiv(record, options), parent)
          }
        }
        options.updateRecord(record, updateCb)
      }
    }

    editButt.appendChild(warning)
    editButt.appendChild(discardBut)
    editButt.appendChild(saveButt)

    const warnDiv = document.createElement('div')
    warnDiv.setAttribute('data-id', record._id)
    warnDiv.setAttribute('data-warnDiv', true)
    warnDiv.style['font-size'] = '18px'
    warnDiv.style.color = 'red'
    warnDiv.style['margin-bottom'] = '20px'
    warnDiv.style['text-align'] = 'center'

    outer.appendChild(warnDiv)
    outer.appendChild(editButt)
    return outer
  }
  return recordDiv
}
const createValueDiv = function (val, options = {}) {
  const { isTopLevel, key, appTableManifest } = options
  const isDate = checkIfIsDate(key, appTableManifest)

  const valueDiv = document.createElement('div')
  valueDiv.style['overflow-wrap'] = 'anywhere'
  if (!val || ['string', 'number', 'boolean'].includes(typeof val)) {
    valueDiv.innerHTML = isDate ? dateString(val) : JSON.stringify(val)
    valueDiv.style.color = colorOfValType(val)
    if (isTopLevel) valueDiv.setAttribute('data-type', (isEmpty(val) ? 'empty' : typeof val))
    return valueDiv
  }
  if (Array.isArray(val)) {
    if (!val || val.length === 0 || ['string', 'number', 'boolean'].includes(typeof val[0])) {
      valueDiv.innerHTML = JSON.stringify(val)
      valueDiv.style.color = colorOfValType(val[0])
      if (isTopLevel) valueDiv.setAttribute('data-type', 'array')
    } else {
      val.forEach(el => { valueDiv.appendChild(createValueDiv(el, { key, appTableManifest })) })
    }
    return valueDiv
  }
  if (typeof val === 'object') {
    const newAppTablemanifest = appTableManifest?.field_names ? appTableManifest?.field_names[key] : null // (appTableManifest?.field_names[key]?.type === 'object') ? appTableManifest.field_names[key] : null
    const theDiv = createObjectDiv(val, { appTableManifest: newAppTablemanifest })
    if (isTopLevel) theDiv.setAttribute('data-type', 'object')
    return theDiv
  }
  valueDiv.innerHTML = JSON.stringify(val)
  if (isTopLevel) valueDiv.setAttribute('data-type', 'unknown')
  return valueDiv
}
const colorOfValType = function (val) {
  if (isEmpty(val)) return 'magenta'
  const type = typeof val
  return (type === 'string')
    ? 'green'
    : (type === 'number'
        ? 'darkorange'
        : (type === 'boolean' ? 'blue' : 'black'))
}
const isEmpty = function (val) {
  return val === null || val === undefined
}

const getDivWith = function (opts, returnOne) {
  if (!opts) return null
  let queryString = ''
  const keys = ['id', 'key', 'saveOuter', 'parent', 'warnDiv']
  keys.forEach(key => {
    if (opts[key]) queryString += '[data-' + key + '="' + opts[key] + '"]'
  })
  if (queryString === '') return null
  const allDivs = document.querySelectorAll(queryString)
  if (returnOne && allDivs.length > 1) console.warn('asked to reutrn 1 div but got MORE: ' + allDivs.length)
  if (returnOne) return allDivs[0]
  return allDivs
}

const getTopLevelObjectValueDivFrom = function (evt) {
  // Following an event (eg dblclick) goes up the dom to find the first element with an id
  let currentEl = evt.target
  while (currentEl && currentEl.tagName !== 'BODY' && currentEl.getAttribute('data-id') === null) {
    currentEl = currentEl.parentElement
  }
  if (currentEl && currentEl.tagName !== 'BODY') return currentEl
  return null
}

const getRecordOuterDivFrom = function (theEl) {
  // Following an event (eg dblclick) goes up the dom to find the first element with an id
  let currentEl = theEl
  while (currentEl && currentEl.tagName !== 'BODY' && !currentEl.getAttribute('data-parent')) {
    currentEl = currentEl.parentElement
  }
  if (currentEl && currentEl.tagName !== 'BODY') return currentEl
  return null
}

const dateString = function (dateNum) {
  return new Date(dateNum).toLocaleString()
}
const checkIfIsDate = function (key, appTableManifest) {
  return key === '_date_modified' || key === '_date_created' || (appTableManifest?.field_names[key]?.type === 'date')
}

export { createObjectDiv, getTopLevelObjectValueDivFrom, getRecordOuterDivFrom }
