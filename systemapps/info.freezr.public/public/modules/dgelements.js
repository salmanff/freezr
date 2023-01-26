
// originated from David Gilbertson (dg)
// hackernoon.com/how-i-converted-my-react-app-to-vanillajs-and-whether-or-not-it-was-a-terrible-idea-4b14b1b2faff
// v 0.0.02 - reduced in size - removed table, row and added grid and flex

const dg = {
  attributeExceptions: [
    'role', 'colspan', 'href', 'target', 'class', 'dgdata', 'Name', 'width', 'eventListener', 'html' // + all starting with 'data-'
  ],

  addAttributeException: function (attr) {
    if (!this.attributeExceptions.includes(attr)) this.attributeExceptions.push(attr)
  },

  appendText: function (el, text) {
    const textNode = document.createTextNode(text)
    el.appendChild(textNode)
  },

  appendArray: function (el, children) {
    children.forEach((child) => {
      if (Array.isArray(child)) {
        this.appendArray(el, child)
      } else if (child instanceof window.Element) {
        el.appendChild(child)
      } else if (typeof child === 'string') {
        this.appendText(el, child)
      }
    })
  },

  setStyles: function (el, styles) {
    if (!styles) {
      el.removeAttribute('styles')
      return
    }

    Object.keys(styles).forEach((styleName) => {
      if (styleName in el.style) {
        el.style[styleName] = styles[styleName]
      } else {
        console.warn(styleName + 'is not a valid style for a ' + el.tagName)
      }
    })
  },

  makeElement: function (type, textOrPropsOrChild, ...otherChildren) {
    const el = document.createElement(type)

    if (Array.isArray(textOrPropsOrChild)) {
      this.appendArray(el, textOrPropsOrChild)
    } else if (textOrPropsOrChild instanceof window.Element) {
      el.appendChild(textOrPropsOrChild)
    } else if (typeof textOrPropsOrChild === 'string') {
      this.appendText(el, textOrPropsOrChild)
    } else if (!textOrPropsOrChild) {
      // do nothing
    } else if (typeof textOrPropsOrChild === 'object') {
      Object.keys(textOrPropsOrChild).forEach((propName) => {
        if (propName in el || this.attributeExceptions.includes(propName) || propName.indexOf('data-') === 0) {
          const value = textOrPropsOrChild[propName]

          if (propName === 'style') {
            this.setStyles(el, value)
          } else if (propName === 'eventListener') {
            el.addEventListener(value.event, value.func)
          } else if (propName === 'html') {
            el.innerHTML = value
          } else if ((this.attributeExceptions.includes(propName) || propName.indexOf('data-') === 0) && value) {
            el.setAttribute(propName, value)
          } else if (value) {
            el[propName] = value
          }
        } else {
          console.warn(propName + ' is not a valid property of a ' + type)
        }
      });
    }

    if (otherChildren) this.appendArray(el, otherChildren)

    return el
  },

  a: function (...args) { return this.makeElement('a', ...args) },
  button: function (...args) { return this.makeElement('button', ...args) },
  div: function (...args) { return this.makeElement('div', ...args) },
  h1: function (...args) { return this.makeElement('h1', ...args) },
  h2: function (...args) { return this.makeElement('h2', ...args) },
  h3: function (...args) { return this.makeElement('h3', ...args) },
  header: function (...args) { return this.makeElement('header', ...args) },
  center: function (...args) { return this.makeElement('center', ...args) },
  p: function (...args) { return this.makeElement('p', ...args) },
  span: function (...args) { return this.makeElement('span', ...args) },
  img: function (...args) { return this.makeElement('img', ...args) },
  b: function (...args) { return this.makeElement('b', ...args) },
  input: function (...args) { return this.makeElement('input', ...args) },
  label: function (...args) { return this.makeElement('label', ...args) },

  hr: function () { return document.createElement('hr') },
  br: function () { return document.createElement('br') },
  select: function (...args) { return this.makeElement('select', ...args) },
  option: function (...args) { return this.makeElement('option', ...args) },

  createSelect: function (list = [], props = {}, options = {}) {
    // options.value is the item the list is set to
    const theSel = dg.select(props)
    list.forEach(anItem => theSel.appendChild(dg.option(anItem)))
    if (options.value) theSel.value = options.value
    return theSel
  },

  el: function (id, options, ...children) {
    const theEl = document.getElementById(id)
    if (theEl) {
      if (options && options.clear) theEl.innerHTML = ''
      if (options && options.top) theEl.scrollTop = 0
      if (options && options.show) theEl.style.display = 'block'
      if (options && options.showil) theEl.style.display = 'inline-block'
      if (options && options.hide) theEl.style.display = 'none'
      if (children && children.length > 0) {
        children.forEach(child => theEl.appendChild(child))
      }
    }
    return theEl
  },
  showEl: function (elorid, options) {
    const el = (typeof elorid === 'string') ? this.el(elorid) : elorid
    if (el) el.style.display = (options && options.inline) ? 'inline-block' : 'block'
  },
  hideEl: function (elorid, options) {
    const el = (typeof elorid === 'string') ? this.el(elorid) : elorid
    if (el) el.style.display = 'none'
  },
  toggleShow: function (elorid, options) {
    const el = (typeof elorid === 'string') ? this.el(elorid) : elorid
    if (el && el.style.display === 'none') {
      el.style.display = 'block'
    } else if (el) {
      el.style.display = 'none'
    }
  },
  hide_els: function (ids, options) {
    if (!Array.isArray(ids)) ids = [ids]
    ids.forEach(id => { if (this.el(id)) this.el(id).style.display = 'none' })
  },
  populate: function (id, ...children) {
    const theEl = document.getElementById(id)
    if (theEl) {
      theEl.innerHTML = ''
      this.appendArray(theEl, children)
    }
  }
}

export { dg }
