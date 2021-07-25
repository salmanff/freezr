// contact.js

/* global freezr freepr */
/* global requestAnimationFrame, confirm */

var contactsTable
const FIELD_LIST = ['nickname', 'username', 'serverurl']

freezr.initPageScripts = function () {
  contactsTable = document.getElementById('contacts_table')

  document.addEventListener('click', function (evt) {
    if (evt.target.id && freezr.utils.startsWith(evt.target.id, 'button_')) {
      var parts = evt.target.id.split('_')
      var args = evt.target.id.split('_')
      args.splice(0, 2).join('_')
      if (buttons[parts[1]]) buttons[parts[1]](args, evt.target)
    }
  })
  FIELD_LIST.forEach((field, i) => {
    if (document.getElementById('new_' + field)) {
      document.getElementById('new_' + field).onkeydown = function (evt) {
        if (evt.keyCode === 13) evt.preventDefault()
      }
    } else {
      console.log('no div for ', field)
    }
  })

  freezr.feps.postquery({ app_table: 'dev.ceps.contacts' }, function (err, resp) {
    // console.log('intial query ', { resp })
    if (err) {
      showWarning(err)
    } else if (!resp || resp.length === 0) {
      showWarning('No items')
    } else {
      resp.forEach((doc, i) => {
        const row = rowFromData(doc)
        contactsTable.appendChild(row)
      })
    }
  })
}
const rowFromData = function (doc) {
  // console.log('rowfrom data for ', { doc })
  const wrapper = document.createElement('div')
  if (doc.nickname && doc.username) {
    wrapper.id = 'wr_' + doc._id
    wrapper.className = 'gridlist'
    FIELD_LIST.forEach((field, i) => {
      const rec = document.createElement('label')
      rec.innerText = doc[field]
      rec.id = field.substring(0, 1) + 'n_' + doc._id
      wrapper.appendChild(rec)
    })
    const actions = document.createElement('div')
    const deleter = document.createElement('img')
    deleter.src = '/app_files/public/info.freezr.public/public/static/small_trash.png'
    deleter.className = 'smallButt'
    deleter.id = 'button_remove_de_' + doc._id
    actions.appendChild(deleter)
    wrapper.appendChild(actions)
  } else {
    wrapper.style.display = 'none'
  }
  return wrapper
}

const buttons = {
  add: function (args, target) {
    if (target.className === 'contacts_butt') {
      const blockToExpand = document.getElementById('add_new_details')
      const sectionHeight = blockToExpand.scrollHeight || 'auto'
      blockToExpand.style.height = (sectionHeight + 'px')
      target.className = 'used_butt'
      document.getElementById('new_nickname').focus()
    }
  },
  saveNew: async function (args, target) {
    if (target.className === 'contacts_butt') {
      target.className = 'used_butt'
      var params = {}
      let gotErr = false
      let createResults = null
      for (const [i] in FIELD_LIST) {
        const field = FIELD_LIST[i]
        params[field] = document.getElementById('new_' + field).innerText
        if (!params[field]) gotErr = new Error('All fields have to be filled')
      }
      if (params.serverurl && params.serverurl.slice(-1) === '/') params.serverurl = params.serverurl.slice(0,-1)
      params.searchname = params.username + '@' + params.serverurl.replace(/\./g, '_')
      // This logic needs to be moved server side
      try {
        if (gotErr) throw gotErr
        console.warn('SERVER SHOULD BE PINGED BEFORE PERSON IS ADDED and warning given if ping dpesnt respond')
        // console.log(params)
        const existing = await freepr.feps.postquery({ app_table: 'dev.ceps.contacts', q: { nickname: params.nickname } })
        if (existing.error) throw new Error(existing.error)
        if (existing.length > 0) throw new Error('You have already used that nickname. It is best to keep nicknames unique')
        createResults = await freepr.ceps.create(params, { app_table: 'dev.ceps.contacts' })
        // console.log({ createResults })
        if (!createResults) throw new Error('Communication error')
        if (createResults.error) throw new Error(createResults.error)
      } catch (e) {
        console.warn(e)
        gotErr = e
      }

      if (!gotErr) {
        params._id = createResults._id
        const addbutt = document.getElementById('button_add')
        addbutt.className = 'contacts_butt'
        const blockToCollapse = document.getElementById('add_new_details')
        const sectionHeight = blockToCollapse.scrollHeight
        const elementTransition = blockToCollapse.style.transition
        blockToCollapse.style.transition = ''
        requestAnimationFrame(function () {
          blockToCollapse.style.height = sectionHeight + 'px'
          blockToCollapse.style.transition = elementTransition
          requestAnimationFrame(function () {
            blockToCollapse.style.height = 0 + 'px'
          })
        })
        target.className = 'contacts_butt'

        // If successful...
        const newRow = rowFromData(params)
        if (contactsTable.firstChild.nextSibling.nextSibling) {
          contactsTable.insertBefore(newRow, contactsTable.firstChild.nextSibling.nextSibling)
        } else {
          contactsTable.appendChild(newRow)
        }
        FIELD_LIST.forEach((field) => {
          document.getElementById('new_' + field).innerText = ''
        })
      } else {
        target.className = 'contacts_butt'
        showWarning(gotErr)
      }
    }
  },
  remove: async function (args, target) {
    const id = args.slice(1).join('_')
    // console.log('delete ', id)
    if (confirm('Are you sure you want to delete this contact?')) {
      const rowWrapper = document.getElementById('wr_' + id)
      rowWrapper.style.display = 'none'
      freezr.ceps.update({ _id: id, _deleted: true }, { app_table: 'dev.ceps.contacts', replaceAllFields: true }, function (err, returns) {
        if (err) {
          rowWrapper.style.display = 'block'
          showWarning('There was a problem deleting the contact. Try later may be?')
        } else {
          rowWrapper.remove()
        }
      })
    }
  }
}
var showWarning = function (msg, timing) {
  if (msg) console.log('WARNING : ' + JSON.stringify(msg))
  const warnDiv = document.getElementById('warnings')
  if (!msg) {
    warnDiv.innerText = ''
    warnDiv.style.display = 'none'
  } else {
    warnDiv.style.display = 'block'
    warnDiv.innerText = msg
    if (timing) {
      setTimeout(showWarning, timing)
    }
  }
}
