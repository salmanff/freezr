// contact.js

/* global freezr freepr freezrMeta */
/* global confirm */

let contactsTable
let groupsTable
let privateFeedsTable
const ALL_FIELDS = [
  { key: 'nickname', title: 'Nick&#8203;name', sortable: true },
  { key: 'username', title: 'User id (on server)', sortable: true },
  { key: 'serverurl', title: 'Server url' },
  { key: 'action', title: 'Actions', doNotShow: true },
  { key: '_id', doNotShow: true }
]
const state = {
  contacts: [],
  groups: [],
  privatefeeds: [],
  privateFeedToken: null
}

freezr.initPageScripts = function () {
  document.getElementById('urlContact').innerText = document.location.origin + '?user=' + freezrMeta.userId
  contactsTable = document.getElementById('contactGridDetails')
  groupsTable = document.getElementById('groupGridDetails')
  privateFeedsTable = document.getElementById('privateFeedsGridDetails')

  document.addEventListener('click', function (evt) {
    if (evt.target.id && freezr.utils.startsWith(evt.target.id, 'button_')) {
      const parts = evt.target.id.split('_')
      const args = evt.target.id.split('_')
      args.splice(0, 2).join('_')
      if (buttons[parts[1]]) buttons[parts[1]](args, evt.target)
    }
  })
  ALL_FIELDS.forEach((field, i) => {
    if (document.getElementById('new_' + field.key)) {
      document.getElementById('new_' + field.key).onkeydown = function (evt) {
        if (evt.keyCode === 13) evt.preventDefault()
      }
    } else if (!field.doNotShow) {
      console.warn('no div for ', field)
    }
  })

  document.getElementById('new_nickname_url').onpaste = function (evt) {
    pasteAsText(evt)
    checkIfUrlIsValidAndPopulateContact()
  }

  freezr.feps.postquery({ app_table: 'dev.ceps.contacts' }, function (err, resp) {
    if (err) {
      showWarning(err)
    } else if (!resp || resp.length === 0) {
      state.contacts = []
    } else {
      state.contacts = resp
    }
    redrawContacts()
  })

  freezr.feps.postquery({ app_table: 'dev.ceps.groups' }, function (err, resp) {
    // onsole.log('intial query ', { resp })
    if (err) {
      showWarning(err)
    } else if (!resp || resp.length === 0) {
      state.groups = []
    } else {
      state.groups = resp
    }
    redrawGroups()
  })

  getPrivateFeedToken(function (err, appToken) {
    if (err) {
      showWarning(err.message)
    } else {
      freezr.ceps.getquery({ appToken, app_table: 'dev.ceps.privatefeeds.codes' }, function (err, resp) {
        // onsole.log('getPrivateFeedToken intial query ', { resp })
        if (err) {
          showWarning(err)
        } else if (!resp || resp.length === 0) {
          state.privatefeeds = []
        } else {
          state.privatefeeds = resp
        }
        redrawPrivateFeeds()
      })
    }
  })
}

// Draw contacts, groups and feeds based on state
const redrawContacts = function (editableGroup, sortByKey) {
  document.getElementById('titleForContacts').innerText = editableGroup ? ('Choose Contacts for Group: ' + editableGroup.name) : 'Your Contacts'
  document.getElementById('button_exitEditMode').style.display = editableGroup ? 'block' : 'none'
  contactsTable.innerHTML = ''

  if (state.contacts.length === 0) {
    contactsTable.innerHTML = 'You do not have any contacts yet.'
  } else {
    const outer = document.createElement('div')
    outer.className = 'gridlist grid-header'

    ALL_FIELDS.forEach(field => {
      if (field.title) {
        const label = document.createElement('label')
        label.innerHTML = field.title
        if (field.sortable) {
          label.onclick = function () {
            redrawContacts(editableGroup, field.key)
          }
          label.style.cursor = 'pointer'
        }
        outer.appendChild(label)
      }
    })
    contactsTable.appendChild(outer)
    state.sortableOrder = (state.sortableOrder || -1) * -1
    state.contacts.sort(sortObjectsByField(sortByKey, state.sortableOrder))
    state.contacts.forEach((doc, i) => {
      const row = contactsRowFromData(doc, editableGroup)
      contactsTable.appendChild(row)
    })
  }
}
const contactsRowFromData = function (doc, editableGroup) {
  const wrapper = document.createElement('div')
  if (doc.nickname && doc.username) {
    wrapper.id = 'wr_' + doc._id
    wrapper.className = 'gridlist groupChooser'
    ALL_FIELDS.forEach(field => {
      if (!field.doNotShow) {
        const rec = document.createElement('label')
        const caption = document.createElement('span')
        caption.innerHTML = field.title + ': &nbsp;'
        caption.className = 'disappearing'
        rec.appendChild(caption)
        const mainText = document.createElement('span')
        mainText.innerHTML = doc[field.key]
        rec.appendChild(mainText)
        wrapper.appendChild(rec)
      }
    })
    if (editableGroup) {
      const outer = document.createElement('div')
      const caption = document.createElement('span')
      caption.innerText = 'Include in Group : '
      outer.appendChild(caption)
      const ticker = document.createElement('input')
      ticker.type = 'checkbox'
      ticker.id = 'chooseContact_' + doc._id
      ticker.checked = editableGroup.members && editableGroup.members.includes(doc.searchname)
      ticker.onchange = async function (e) {
        // onsole.log('checked ? ' + doc.searchname + ' - ' + e.target.checked, editableGroup)
        const errs = await addOrRemoveFromGroup(editableGroup, doc.searchname, e.target.checked)
        if (errs) {
          showWarning(errs)
        } else {
          drawGroup(editableGroup)
        }
      }
      outer.appendChild(ticker)
      wrapper.appendChild(outer)
    } else {
      const actions = document.createElement('div')
      const deleter = document.createElement('span')
      deleter.className = 'smallTextButt'
      deleter.innerText = 'Delete'
      deleter.id = 'button_remove_de_' + doc._id
      actions.appendChild(deleter)
      const editSpan = document.createElement('span')
      editSpan.className = 'smallTextButt'
      editSpan.innerText = 'Edit'
      editSpan.onclick = function () { editContact(doc, editSpan) }
      actions.appendChild(editSpan)
      wrapper.appendChild(actions)
    }
  } else {
    console.warn('NO WRAPPER HERE???')
    wrapper.style.display = 'none'
  }
  return wrapper
}
const redrawGroups = function () {
  groupsTable.innerHTML = ''
  if (state.groups.length === 0) {
    groupsTable.innerHTML = 'No groups added'
  } else {
    state.groups.forEach((doc, i) => {
      const row = document.createElement('div')
      row.className = 'groupOuter'
      row.id = 'groupRow_' + doc._id
      groupsTable.appendChild(row)
      drawGroup(doc)
    })
  }
}
const drawGroup = function (doc) {
  const row = document.getElementById('groupRow_' + doc._id)
  row.innerHTML = ''
  const gname = document.createElement('span')
  gname.className = 'group groupName'
  gname.innerText = doc.name
  row.appendChild(gname)
  const edit = document.createElement('span')
  edit.className = 'group groupEdit'
  edit.innerText = ' (edit) '
  edit.cursor = 'pointer'
  edit.onclick = function (e) { redrawContacts(doc) }
  row.appendChild(edit)
  const members = document.createElement('span')
  members.className = 'group groupMembers'
  if (doc.members && doc.members.length > 0) {
    members.innerText = '(Current members: ' + doc.members.join(', ') + ')'
  } else {
    members.innerText = '(No members - click on edit to add members)'
  }
  row.appendChild(members)
}
const redrawPrivateFeeds = function () {
  privateFeedsTable.innerHTML = ''
  if (state.privatefeeds.length === 0) {
    privateFeedsTable.innerHTML = 'No feeds'
    document.getElementById('privateFeeds_table').style.display = 'none'
  } else {
    document.getElementById('privateFeeds_table').style.display = 'block'
    state.privatefeeds.forEach((doc, i) => {
      const row = document.createElement('div')
      row.className = 'groupOuter'
      row.id = 'privatefeedRow_' + doc._id
      privateFeedsTable.appendChild(row)
      drawPrivateFeed(doc)
    })
  }
}
const drawPrivateFeed = function (doc) {
  const row = document.getElementById('privatefeedRow_' + doc._id)
  row.innerHTML = ''
  const pname = document.createElement('span')
  pname.className = 'group groupName alink'
  pname.innerText = doc.name
  pname.onclick = function (e) {
    window.open((`/public?feed=${doc.name}&code=${doc.code}`), '_blank')
  }
  row.appendChild(pname)
  const edit = document.createElement('span')
  edit.className = 'group groupEdit'
  edit.innerHTML = ' (edit) '
  edit.cursor = 'pointer'
  edit.onclick = function (e) {
    showHideAddSections('url', { forceOpen: true })
    window.scrollTo(0, 0)
    document.getElementById('privateFeedTitle').innerText = 'Edit the private feed - ' + doc.name
    document.getElementById('button_privateFeedDelete').style.display = 'block'
    document.getElementById('button_visitFeedUrl').style.display = 'block'
    for (const [key, value] of Object.entries(doc)) {
      const theDiv = document.getElementById('new_' + key + '_privatefeeds')
      if (theDiv) {
        if (key === 'group') {
          theDiv.value = value
        } else {
          theDiv.innerText = value
        }
      } // else of as key is _date_created or modified
    }
  }
  row.appendChild(edit)
}

// Other sections
const showHideAddSections = function (thisType, target) {
  const types = ['contact', 'group', 'url']
  // const inputFields = document.getElementsByClassName('field_to_add')
  document.querySelectorAll('.field_to_add').forEach(function (aDiv) { aDiv.innerText = '' })

  const open = (target && (target.className === 'addNewButt' || target.className === 'smallTextButt' || target.forceOpen))
  types.forEach(type => {
    document.getElementById('button_' + type + 'Save').style.display = 'block'
    const blockToHandle = document.getElementById('new_' + type + '_area')
    const sectionHeight = (thisType === type && open) ? (blockToHandle.scrollHeight ? Math.max(blockToHandle.scrollHeight + 50, 200) : 'auto') : 0
    blockToHandle.style.height = (sectionHeight + 'px')
    document.getElementById('button_addnew_' + type).className = (open && thisType === type) ? 'used_butt' : 'addNewButt'
  })
  if (thisType === 'url') {
    document.getElementById('privateFeedTitle').innerText = 'Create a private feed of links!'
    buttons.regenerateCodeForPrivateFeed()
    const select = document.getElementById('new_group_privatefeeds')
    select.innerHTML = ''
    const option = document.createElement('option')
    option.innerHTML = 'None'
    select.appendChild(option)
    if (state.groups && state.groups.length > 0) {
      state.groups.forEach((group) => {
        const option = document.createElement('option')
        option.value = group.name
        option.innerHTML = group.name
        select.appendChild(option)
      })
    }
  }
}
const editContact = function (contact, target) {
  showHideAddSections('contact', target)
  window.scrollTo(0, 0)
  document.getElementById('addContactTitle').innerText = 'Edit Contact'
  for (const [key, value] of Object.entries(contact)) {
    const theDiv = document.getElementById('new_' + key)
    if (theDiv) theDiv.innerText = value
  }
}
const clearNewContactFields = function () {
  document.getElementById('button_privateFeedDelete').style.display = 'none'
  document.getElementById('button_visitFeedUrl').style.display = 'none'
  ALL_FIELDS.forEach((field) => {
    const theDiv = document.getElementById('new_' + field.key)
    if (theDiv) theDiv.innerHTML = ''
  })
}
const checkIfUrlIsValidAndPopulateContact = function () {
  const url = document.getElementById('new_nickname_url').innerText
  const part1 = url.split('?')
  if (part1.length < 2) {
    showWarning('invalid url (1)')
    return
  }
  console.warn('migrate away to origin/@username')
  const origin = part1[0]
  const eqOuter = part1[1].split('&')
  const eqInner = eqOuter[0]
  const equality = eqInner.split('=')
  document.getElementById('new_nickname_url').innerText = ''
  showHideAddSections('contact', { forceOpen: true })
  document.getElementById('new_nickname').innerText = equality[1]
  document.getElementById('new_username').innerText = equality[1]
  document.getElementById('new_serverurl').innerText = origin
}

// Data Changes
const addOrRemoveFromGroup = async function (editableGroup, searchname, checked) {
  editableGroup.members = checked
    ? addToListAsUniqueItems(editableGroup.members, searchname)
    : removeFromlist(editableGroup.members, searchname)
  const result = await freepr.ceps.update(editableGroup, { app_table: 'dev.ceps.groups' })
  // onsole.log({ result })
  if (!result || result.error) {
    editableGroup.members = !checked
      ? addToListAsUniqueItems(editableGroup.members, searchname)
      : removeFromlist(editableGroup.members, searchname)
  }
  if (!result) return 'Could not finalise change'
  if (result.error) return result.error
  return null
}
const getPrivateFeedToken = function (callback) {
  if (state.privateFeedToken) {
    callback(null, state.privateFeedToken)
  } else {
    const data = {
      data_owner_user: 'public',
      table_id: 'dev.ceps.privatefeeds.codes',
      permission: 'privateCodes',
      app_id: 'info.freezr.account' // requestor app
    }
    freezr.perms.validateDataOwner(data, function (err, ret) {
      console.log({ ret })
      if (err || !ret || ret.error || !ret['access-token']) {
        console.warn('error getting access tokens', { ret })
        callback(new Error('error getting access tokens'))
      } else {
        // onsole.log('got validation ret ', ret)
        state.privateFeedToken = ret['access-token']
        callback(null, ret['access-token'])
      }
    })
  }
}

const buttons = {
  addnew: function (args, target) {
    document.getElementById('addContactTitle').innerText = 'Add a Contact'
    document.getElementById('button_contactSave').innerText = 'Save Contact'
    clearNewContactFields()
    showHideAddSections(args[0], target)
  },
  contactSave: async function (args, target) {
    if (target.className === 'addNewButt') {
      target.style.display = 'none'
      showLoading(true)
      const params = {}
      let createResults = null
      ALL_FIELDS.forEach(field => {
        const theDiv = document.getElementById('new_' + field.key)
        if (theDiv) params[field.key] = theDiv.innerText.trim() || null
      })
      try {
        if (!params.username) params.username = params.nickname
        if (!params.nickname) throw new Error('`nickname needs to be filled to create a contact')
        if (params.serverurl && params.serverurl.slice(-1) === '/') params.serverurl = params.serverurl.slice(0, -1)
        if (params.serverurl && params.serverurl.slice(0, 4) !== 'http') {
          if (params.serverurl.slice(0, 1) === '/') params.serverurl = params.serverurl.slice(1)
          if (params.serverurl.slice(0, 1) === '/') params.serverurl = params.serverurl.slice(1)
          params.serverurl = 'https://' + params.serverurl
        }
        params.searchname = params.username + (params.serverurl ? ('@' + params.serverurl.replace(/\./g, '_')) : '')
        // This logic needs to be moved server side
        console.warn('SERVER SHOULD BE PINGED BEFORE PERSON IS ADDED and warning given if ping dpesnt respond')
        const existing = await freepr.feps.postquery({ app_table: 'dev.ceps.contacts', q: { nickname: params.nickname } })
        if (existing.error) throw new Error(existing.error)
        if (existing.length > 0 && params._id !== existing[0]._id) throw new Error('You have already used that nickname. It is best to keep nicknames unique')

        if (params._id) {
          createResults = await freepr.ceps.update(params, { app_table: 'dev.ceps.contacts' })
          if (!createResults) throw new Error('Communication error')
          if (createResults.error) throw new Error(createResults.error)
          state.contacts.forEach((item, i) => {
            if (item._id === params._id) state.contacts[i] = params
          })
        } else {
          createResults = await freepr.ceps.create(params, { app_table: 'dev.ceps.contacts' })
          if (!createResults) throw new Error('Communication error')
          if (createResults.error) throw new Error(createResults.error)
          params._id = createResults._id
          state.contacts.push(params)
        }
        showLoading(false)
        clearNewContactFields()
        showHideAddSections()
        redrawContacts()
      } catch (e) {
        console.warn(e)
        showLoading(false)
        showWarning(e.message)
        target.style.display = 'inline-block'
      }
    }
  },
  urlSave: async function (args, target) {
    checkIfUrlIsValidAndPopulateContact()
  },
  groupSave: async function (args, target) {
    let gotErr = false
    let createResults = null
    const name = document.getElementById('new_name_group').innerText
    // todo check is correct
    try {
      if (gotErr) throw gotErr
      console.warn('SERVER SHOULD BE PINGED BEFORE PERSON IS ADDED and warning given if ping dpesnt respond')
      // onsole.log(params)
      const existing = await freepr.feps.postquery({ app_table: 'dev.ceps.groups', q: { name } })
      if (existing.error) throw new Error(existing.error)
      if (existing.length > 0) throw new Error('You have already used that nickname. It is best to keep nicknames unique')
      createResults = await freepr.ceps.create({ name }, { app_table: 'dev.ceps.groups' })
      if (!createResults) throw new Error('Communication error')
      if (createResults.error) throw new Error(createResults.error)
    } catch (e) {
      console.warn(e)
      gotErr = e
    }

    if (!gotErr) {
      state.groups.push({ name, members: [], _id: createResults._id })
      document.getElementById('new_name_group').innerText = ''
      redrawGroups()
      showHideAddSections()
    } else {
      target.className = 'addNewButt'
      showWarning(gotErr)
    }
  },
  remove: async function (args, target) {
    const id = args.slice(1).join('_')
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
  },
  // useSameServerForNewContact: function () {
  //   document.getElementById('new_serverurl').innerText = document.location.origin
  // },
  privateUrlSave: async function () {
    const params = {}
    const fields = ['name', 'url', 'code', 'group', '_id']
    fields.forEach(item => {
      const theDiv = document.getElementById('new_' + item + '_privatefeeds')
      if (theDiv) {
        params[item] =
          item === 'group'
            ? (theDiv.value === 'None' ? null : theDiv.value)
            : theDiv.innerText || null
      }
    })
    // onsole.log({ params })
    const isUpdate = (params._id && params._id !== '')

    if (!params.name) {
      showWarning('The name is obligatory')
    } else if (!params.url && !params.code) {
      showWarning("When creating a new feed, the code is obligatory - if using someone else's, then the url is needed")
    } else {
      if (params.url) {
        console.warn('need to see how to deal with third party rights')
      }
      const existing = await freepr.feps.postquery({ appToken: state.privateFeedToken, app_table: 'dev.ceps.privatefeeds.codes', q: { name: params.name } })
      if (!existing || existing.error) {
        const text = existing && existing.error ? existing.error : (!existing ? 'No response' : 'unknown err')
        showWarning(text)
        return
      }
      if (!isUpdate && existing.length > 0) {
        showWarning('You have already used that nickname. It is best to keep nicknames unique')
        return
      } else if (isUpdate && existing.length === 0) {
        showWarning('Error getting feeder from server')
        return
      }
      if (!isUpdate) {
        const createResults = await freepr.ceps.create(params, { appToken: state.privateFeedToken, app_table: 'dev.ceps.privatefeeds.codes' })
        if (!createResults || createResults.error) {
          const text = createResults && createResults.error ? createResults.error : (!createResults ? 'No response in creating feed' : 'unknown err in creating feed')
          showWarning(text)
          return
        }
        params._id = createResults._id
        state.privatefeeds.push(params)
      } else {
        const createResults = await freepr.ceps.update(params, { appToken: state.privateFeedToken, app_table: 'dev.ceps.privatefeeds.codes' })
        if (!createResults || createResults.error) {
          const text = createResults && createResults.error ? createResults.error : (!createResults ? 'No response in updating feed' : 'unknown err in updating feed')
          showWarning(text)
          return
        }
        state.privatefeeds.forEach((item, i) => {
          if (item._id === params._id) state.privatefeeds[i] = params
        })
      }
      showHideAddSections()
      redrawPrivateFeeds()
    }
  },
  privateFeedDelete: async function () {
    if (confirm('Are you sure you want to delete this feed and all associated records posted to the feed?')) {
      const theId = document.getElementById('new__id_privatefeeds').innerText
      let feedToDelete
      state.privatefeeds.forEach(feed => { if (feed._id === theId) { feedToDelete = feed } })
      console.log({ feed: feedToDelete.name, code: feedToDelete.code })
      const results = await deleteAllFeedElements(feedToDelete)
      console.warn(' rrivatfeeddelete - back from deleting indivudal ones', results)
      if (results && results.success) {
        const deleteResults = await freepr.ceps.delete(theId, { appToken: state.privateFeedToken, app_table: 'dev.ceps.privatefeeds.codes' })
        if (!deleteResults || deleteResults.error) {
          showWarning('there was a problem deleting')
        } else {
          showWarning('Private feed deleted')
          state.privatefeeds.forEach((feed, i) => {
            if (feed._id === theId) {
              state.privatefeeds.splice(i, 1)
            }
          })
        }
      } else {
        showWarning('Could not delete all items. try later')
      }
      redrawPrivateFeeds()
      showHideAddSections()
    }
  },
  visitFeedUrl: function () {
    const theId = document.getElementById('new__id_privatefeeds').innerText
    state.privatefeeds.forEach(feed => {
      if (feed._id === theId) {
        window.open(('/public?feed=' + feed.name + '&code=' + feed.code), '_blank')
      }
    })
  },
  // other...
  copyUrl: async function () {
    const url = document.getElementById('urlContact').innerText
    navigator.clipboard.writeText(url).then(function () {
      console.log('Copied to clipboard.')
    }, function (err) {
      showWarning('Could not copy url')
      console.error('Async: Could not copy text: ', err)
    })
  },
  exitEditMode: function () {
    redrawGroups()
    redrawContacts()
  },
  regenerateCodeForPrivateFeed: function () {
    const codeDiv = document.getElementById('new_code_privatefeeds')
    codeDiv.innerText = randomText()
  }
}

const deleteAllFeedElements = async function (feed, numTry) {
  const items = await freepr.feps.publicquery({ feed: feed.name, code: feed.code })
  // onsole.log('deleteAllFeedElements', {numTry, items})
  if (!items || items.error || !items.results) {
    return { success: false, error: (items?.error ? items.error : 'Coiuld not delete items') }
  } else if (items.results.length === 0) {
    return { success: true }
  } else if (!numTry || numTry < 2) {
    for (const record of items.results) {
      console.log('unsharing record ', { record })
      const deleteResults = await freepr.perms.shareRecords(record._original_id, { grantees: [('_privatefeed:' + feed.name)], name: record._permission_name, action: 'deny', table_id: record._app_table, requestor_app: record._app_name })
      console.log({ deleteResults })
    }
    numTry = numTry ? (numTry + 1) : 1
    // onsole.log('get the next batch')
    return deleteAllFeedElements(feed, numTry)
  } else {
    console.warn('too many tries')
  }
}
// Other ...
const showLoading = function (doShow) {
  document.getElementById('loader').style.display = doShow ? 'block' : 'none'
}
const showWarning = function (msg, timing) {
  if (msg) console.log('WARNING : ' + JSON.stringify(msg))
  const warnDiv = document.getElementById('warnings')
  window.scrollTo(0, 0)
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

// General utils
const addToListAsUniqueItems = function (aList, items, transform) {
  // takes two lists..  integrates items into aList without duplicates
  // if items are strins or numbers, they are treated as a one item list
  if (!aList) aList = []
  if (!items) return aList
  if (typeof items === 'string' || !isNaN(items)) items = [items]
  if (!Array.isArray(items)) { throw new Error('items need to be a list') }
  if (transform) items = items.map(transform)
  items.forEach(function (anItem) { if (anItem && anItem !== ' ' && aList.indexOf(anItem) < 0 && anItem.length > 0) aList.push(anItem) })
  return aList
}
const removeFromlist = function (aList, item, transform) {
  // removes item from a list and returns it
  if (!aList) aList = []
  if (!item) return aList
  if (typeof item !== 'string' && isNaN(item)) throw new Error('need to pass string or number in removeFromlist')
  if (transform) item = transform(item)
  const idx = aList.indexOf(item)
  if (idx > -1) aList.splice(idx, 1)
  return aList
}
const pasteAsText = function (evt) {
  // for more details and improvements: stackoverflow.com/questions/12027137/javascript-trick-for-paste-as-plain-text-in-execcommand
  evt.preventDefault()
  const text = evt.clipboardData.getData('text/plain')
  document.execCommand('insertHTML', false, text)
}
const randomText = function (textlen) {
  // http://stackoverflow.com/questions/1349404/generate-a-string-of-5-random-characters-in-javascript
  let text = ''
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  if (!textlen) textlen = 18
  for (let i = 0; i < textlen; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length))
  }
  return text
}
function sortObjectsByField(property, order) {
  // https://stackoverflow.com/questions/1129216/sort-array-of-objects-by-string-property-value
  if (!order) order = 1
  return function (a, b) {
    const result = (a[property] < b[property]) ? -1 : (a[property] > b[property]) ? 1 : 0
    return result * order
  }
}
