// contact.js

/* global freezr freezrMeta */
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
 
freezr.initPageScripts = async function () {
  
  const urlContactEl = document.getElementById('urlContact')
  if (urlContactEl) {
    urlContactEl.innerText = document.location.origin + '/public?user=' + freezrMeta.userId
  }
  contactsTable = document.getElementById('contactGridDetails')
  groupsTable = document.getElementById('groupGridDetails')
  privateFeedsTable = document.getElementById('privateFeedsGridDetails')

  // Overlay close handler
  const overlay = document.getElementById('overlay')
  const overlayClose = document.getElementById('overlay_close')
  if (overlayClose) {
    overlayClose.onclick = function () {
      if (overlay) overlay.style.display = 'none'
      showHideAddSections()
    }
  }
  if (overlay) {
    overlay.onclick = function (e) {
      if (e.target === overlay) {
        overlay.style.display = 'none'
        showHideAddSections()
      }
    }
  }

  document.addEventListener('click', function (evt) {
    if (evt.target.id && freezr.utils.startsWith(evt.target.id, 'button_')) {
      const parts = evt.target.id.split('_')
      const args = evt.target.id.split('_')
      console.log('button clicked ', parts, args)
      
      // Handle button_addnew_contact, button_addnew_group
      if (parts[1] === 'addnew' && parts[2]) {
        if (buttons.addnew) buttons.addnew([parts[2]], evt.target)
      }
      // Handle button_addfrom_url
      else if (parts[1] === 'addfrom' && parts[2] === 'url') {
        if (buttons.addfromUrl) buttons.addfromUrl(evt.target)
      }
      // Handle button_addnew_privatefeed
      else if (parts[1] === 'addnew' && parts[2] === 'privatefeed') {
        if (buttons.addnewPrivateFeed) buttons.addnewPrivateFeed(evt.target)
      }
      // Handle other buttons
      else if (buttons[parts[1]]) {
        buttons[parts[1]](args, evt.target)
      }
    }
  })
  ALL_FIELDS.forEach((field, i) => {
    const el = document.getElementById('new_' + field.key)
    if (el) {
      el.onkeydown = function (evt) {
        if (evt.keyCode === 13) evt.preventDefault()
      }
    } else if (!field.doNotShow) {
      console.warn('no div for ', field)
    }
  })

  const urlInput = document.getElementById('new_nickname_url')
  if (urlInput) {
    urlInput.onpaste = function (evt) {
      pasteAsText(evt)
      checkIfUrlIsValidAndPopulateContact()
    }
  }

  // Load contacts
  try {
    const contactsResp = await freezr.query('dev.ceps.contacts', {})
    if (!contactsResp || contactsResp.length === 0) {
      state.contacts = []
    } else {
      state.contacts = contactsResp
    }
    redrawContacts()
  } catch (err) {
    showWarning(err?.message || err)
  }

  // Load groups
  try {
    const groupsResp = await freezr.query('dev.ceps.groups', {})
    if (!groupsResp || groupsResp.length === 0) {
      state.groups = []
    } else {
      state.groups = groupsResp
    }
    redrawGroups()
  } catch (err) {
    showWarning(err?.message || err)
  }

  // Load private feeds
  try {
    const appToken = await getPrivateFeedToken()
    const feedsResp = await freezr.query('dev.ceps.privatefeeds.codes', {}, { appToken })
    console.log('feedsResp', { appToken, feedsResp })
    if (!feedsResp || feedsResp.length === 0) {
      state.privatefeeds = []
    } else {
      state.privatefeeds = feedsResp
    }
    redrawPrivateFeeds()
  } catch (err) {
    showWarning(err?.message || err)
  }
}

// Draw contacts, groups and feeds based on state
const redrawContacts = function (editableGroup, sortByKey) {
  const titleEl = document.getElementById('titleForContacts')
  const exitBtn = document.getElementById('button_exitEditMode')
  if (titleEl) {
    titleEl.innerText = editableGroup ? ('Choose Contacts for Group: ' + editableGroup.name) : 'Your Contacts'
  }
  if (exitBtn) {
    exitBtn.style.display = editableGroup ? 'block' : 'none'
  }
  if (!contactsTable) return
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
        mainText.innerHTML = doc[field.key] || ''
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
  if (!groupsTable) return
  groupsTable.innerHTML = ''
  const groupTableEl = document.getElementById('group_table')
  
  if (state.groups.length === 0) {
    groupsTable.innerHTML = 'No groups added'
    if (groupTableEl) groupTableEl.style.display = 'none'
  } else {
    if (groupTableEl) groupTableEl.style.display = 'block'
    state.groups.forEach((doc, i) => {
      const row = document.createElement('div')
      row.className = 'groupOuter'
      row.id = 'groupRow_' + doc._id
      groupsTable.appendChild(row)
      drawGroup(doc)
    })
  }
}

let currentEditingGroup = null

const drawGroup = function (doc) {
  const row = document.getElementById('groupRow_' + doc._id)
  if (!row) return
  row.innerHTML = ''
  const gname = document.createElement('span')
  gname.className = 'group groupName'
  gname.innerText = doc.name
  row.appendChild(gname)
  const edit = document.createElement('span')
  edit.className = 'group groupEdit'
  edit.innerText = ' (edit) '
  edit.style.cursor = 'pointer'
  edit.onclick = function (e) { 
    currentEditingGroup = doc
    startGroupEdit(doc)
  }
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

const startGroupEdit = function (group) {
  // Hide groups card and other cards
  const groupTable = document.getElementById('group_table')
  const privateFeedsTable = document.getElementById('privateFeeds_table')
  if (groupTable) groupTable.style.display = 'none'
  if (privateFeedsTable) privateFeedsTable.style.display = 'none'
  
  // Show group edit header
  const groupEditHeader = document.getElementById('group_edit_header')
  const editGroupName = document.getElementById('edit_group_name')
  if (groupEditHeader) groupEditHeader.style.display = 'block'
  if (editGroupName) editGroupName.innerText = group.name
  
  // Show contacts in edit mode
  redrawContacts(group)
}

const endGroupEdit = function () {
  currentEditingGroup = null
  const groupEditHeader = document.getElementById('group_edit_header')
  if (groupEditHeader) groupEditHeader.style.display = 'none'
  redrawGroups()
  redrawContacts()
  redrawPrivateFeeds()
}

const redrawPrivateFeeds = function () {
  if (!privateFeedsTable) return
  privateFeedsTable.innerHTML = ''
  const privateFeedsTableEl = document.getElementById('privateFeeds_table')
  
  if (state.privatefeeds.length === 0) {
    privateFeedsTable.innerHTML = 'No feeds'
    if (privateFeedsTableEl) privateFeedsTableEl.style.display = 'none'
  } else {
    if (privateFeedsTableEl) privateFeedsTableEl.style.display = 'block'
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
  if (!row) return
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
  edit.style.cursor = 'pointer'
  edit.onclick = function (e) {
    showHideAddSections('privatefeed', { forceOpen: true })
    const titleEl = document.getElementById('privateFeedTitle')
    if (titleEl) titleEl.innerText = 'Edit the private feed - ' + doc.name
    const deleteBtn = document.getElementById('button_privateFeedDelete')
    const visitBtn = document.getElementById('button_visitFeedUrl')
    if (deleteBtn) deleteBtn.style.display = 'block'
    if (visitBtn) visitBtn.style.display = 'block'
    for (const [key, value] of Object.entries(doc)) {
      const theDiv = document.getElementById('new_' + key + '_privatefeeds')
      if (theDiv) {
        if (key === 'group') {
          theDiv.value = value || ''
        } else {
          theDiv.innerText = value || ''
        }
      }
    }
  }
  row.appendChild(edit)
}

// Other sections
const showHideAddSections = function (thisType, target) {
  const overlay = document.getElementById('overlay')
  const types = ['contact', 'group', 'url', 'privatefeed']
  document.querySelectorAll('.field_to_add').forEach(function (aDiv) { aDiv.innerText = '' })

  const open = (target && (target.forceOpen || target.className === 'smallTextButt'))
  
  if (!thisType || !open) {
    // Close overlay
    if (overlay) overlay.style.display = 'none'
    types.forEach(type => {
      const blockToHandle = document.getElementById('new_' + type + '_area')
      if (blockToHandle) blockToHandle.style.display = 'none'
    })
    return
  }

  // Show overlay
  if (overlay) overlay.style.display = 'flex'
  
  types.forEach(type => {
    const saveBtn = document.getElementById('button_' + (type === 'privatefeed' ? 'privateUrl' : type) + 'Save')
    const blockToHandle = document.getElementById('new_' + type + '_area')
    
    if (saveBtn) saveBtn.style.display = 'block'
    if (blockToHandle) {
      blockToHandle.style.display = (thisType === type) ? 'block' : 'none'
    }
  })
  
  if (thisType === 'privatefeed') {
    const titleEl = document.getElementById('privateFeedTitle')
    if (titleEl) titleEl.innerText = 'Create a private feed of links!'
    buttons.regenerateCodeForPrivateFeed()
    const select = document.getElementById('new_group_privatefeeds')
    if (select) {
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
}

const editContact = function (contact, target) {
  showHideAddSections('contact', { forceOpen: true })
  const titleEl = document.getElementById('addContactTitle')
  const saveBtn = document.getElementById('button_contactSave')
  if (titleEl) titleEl.innerText = 'Edit Contact'
  if (saveBtn) saveBtn.innerText = 'Update Contact'
  for (const [key, value] of Object.entries(contact)) {
    const theDiv = document.getElementById('new_' + key)
    if (theDiv) theDiv.innerText = value || ''
  }
}

const clearNewContactFields = function () {
  const deleteBtn = document.getElementById('button_privateFeedDelete')
  const visitBtn = document.getElementById('button_visitFeedUrl')
  const privateFeedTitle = document.getElementById('privateFeedTitle')
  if (deleteBtn) deleteBtn.style.display = 'none'
  if (visitBtn) visitBtn.style.display = 'none'
  if (privateFeedTitle) privateFeedTitle.innerText = 'Create a Private Feed'
  ALL_FIELDS.forEach((field) => {
    const theDiv = document.getElementById('new_' + field.key)
    if (theDiv) theDiv.innerHTML = ''
  })
  // Clear private feed fields
  const privateFeedFields = ['name', 'url', 'code', 'group', '_id']
  privateFeedFields.forEach(key => {
    const el = document.getElementById('new_' + key + '_privatefeeds')
    if (el) {
      if (key === 'group') {
        el.value = 'None'
      } else {
        el.innerText = ''
      }
    }
  })
}

const checkIfUrlIsValidAndPopulateContact = function () {
  const urlInput = document.getElementById('new_nickname_url')
  if (!urlInput) return
  let url = urlInput.innerText.trim()
  
  // Remove /public prefix if present
  if (url.includes('/public?')) {
    url = url.replace('/public?', '?')
  } else if (url.startsWith('/public')) {
    url = url.replace('/public', '')
  }
  
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
  
  if (equality.length < 2 || equality[0] !== 'user') {
    showWarning('invalid url format - expected ?user=username')
    return
  }
  
  urlInput.innerText = ''
  
  // Switch overlay to contact form
  showHideAddSections('contact', { forceOpen: true })
  const titleEl = document.getElementById('addContactTitle')
  const saveBtn = document.getElementById('button_contactSave')
  if (titleEl) titleEl.innerText = 'Add a Contact'
  if (saveBtn) saveBtn.innerText = 'Save Contact'
  
  const nicknameEl = document.getElementById('new_nickname')
  const usernameEl = document.getElementById('new_username')
  const serverurlEl = document.getElementById('new_serverurl')
  if (nicknameEl) nicknameEl.innerText = equality[1] || ''
  if (usernameEl) usernameEl.innerText = equality[1] || ''
  // Only set server URL if origin is a full URL (not empty or just a path)
  if (serverurlEl) {
    if (origin && origin.length > 0 && (origin.startsWith('http://') || origin.startsWith('https://'))) {
      serverurlEl.innerText = origin
    } else {
      serverurlEl.innerText = ''
    }
  }
}

// Data Changes
const addOrRemoveFromGroup = async function (editableGroup, searchname, checked) {
  editableGroup.members = checked
    ? addToListAsUniqueItems(editableGroup.members, searchname)
    : removeFromlist(editableGroup.members, searchname)
  try {
    const result = await freezr.update('dev.ceps.groups', editableGroup._id, editableGroup)
    if (!result || result.error) {
      editableGroup.members = !checked
        ? addToListAsUniqueItems(editableGroup.members, searchname)
        : removeFromlist(editableGroup.members, searchname)
      return result?.error || 'Could not finalise change'
    }
    return null
  } catch (err) {
    editableGroup.members = !checked
      ? addToListAsUniqueItems(editableGroup.members, searchname)
      : removeFromlist(editableGroup.members, searchname)
    return err?.message || 'Could not finalise change'
  }
}

const getPrivateFeedToken = async function () {
  if (state.privateFeedToken) {
    return state.privateFeedToken
  } else {
    const data = {
      data_owner_user: 'public',
      table_id: 'dev.ceps.privatefeeds.codes',
      permission: 'privateCodes',
      app_id: 'info.freezr.account'
    }
    try {
      const ret = await freezr.perms.validateDataOwner(data)
      console.log({ ret })
      if (!ret || ret.error || !ret['access-token']) {
        console.warn('error getting access tokens', { ret })
        throw new Error('error getting access tokens')
      } else {
        state.privateFeedToken = ret['access-token']
        return ret['access-token']
      }
    } catch (err) {
      console.warn('error getting access tokens', { err })
      throw new Error('error getting access tokens')
    }
  }
}

const buttons = {
  addnew: function (args, target) {
    const type = args[0] // 'contact', 'group', or 'url'
    if (type === 'contact') {
      const titleEl = document.getElementById('addContactTitle')
      const saveBtn = document.getElementById('button_contactSave')
      if (titleEl) titleEl.innerText = 'Add a Contact'
      if (saveBtn) saveBtn.innerText = 'Save Contact'
      clearNewContactFields()
    } else if (type === 'group') {
      const nameEl = document.getElementById('new_name_group')
      if (nameEl) nameEl.innerText = ''
    }
    showHideAddSections(type, { forceOpen: true })
  },
  addfromUrl: function (target) {
    const urlInput = document.getElementById('new_nickname_url')
    if (urlInput) urlInput.innerText = ''
    showHideAddSections('url', { forceOpen: true })
  },
  addnewPrivateFeed: function (target) {
    const titleEl = document.getElementById('privateFeedTitle')
    if (titleEl) titleEl.innerText = 'Create a private feed of links!'
    buttons.regenerateCodeForPrivateFeed()
    const select = document.getElementById('new_group_privatefeeds')
    if (select) {
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
    const deleteBtn = document.getElementById('button_privateFeedDelete')
    const visitBtn = document.getElementById('button_visitFeedUrl')
    if (deleteBtn) deleteBtn.style.display = 'none'
    if (visitBtn) visitBtn.style.display = 'none'
    // Clear private feed fields
    const privateFeedFields = ['name', 'url', 'code', 'group', '_id']
    privateFeedFields.forEach(key => {
      const el = document.getElementById('new_' + key + '_privatefeeds')
      if (el) {
        if (key === 'group') {
          el.value = 'None'
        } else {
          el.innerText = ''
        }
      }
    })
    showHideAddSections('privatefeed', { forceOpen: true })
  },
  contactSave: async function (args, target) {
    showLoading(true)
    const params = {}
    let createResults = null
    ALL_FIELDS.forEach(field => {
      const theDiv = document.getElementById('new_' + field.key)
      if (theDiv) params[field.key] = theDiv.innerText.trim() || null
    })
    try {
      if (!params.username) params.username = params.nickname
      if (!params.nickname) throw new Error('nickname needs to be filled to create a contact')
      if (params.serverurl && params.serverurl.slice(-1) === '/') params.serverurl = params.serverurl.slice(0, -1)
      if (params.serverurl && params.serverurl.slice(0, 4) !== 'http') {
        if (params.serverurl.slice(0, 1) === '/') params.serverurl = params.serverurl.slice(1)
        if (params.serverurl.slice(0, 1) === '/') params.serverurl = params.serverurl.slice(1)
        params.serverurl = 'https://' + params.serverurl
      }
      params.searchname = params.username + (params.serverurl ? ('@' + params.serverurl.replace(/\./g, '_')) : '')
      console.warn('SERVER SHOULD BE PINGED BEFORE PERSON IS ADDED and warning given if ping doesnt respond')
      
      const existing = await freezr.query('dev.ceps.contacts', { nickname: params.nickname })
      if (existing.length > 0 && params._id !== existing[0]._id) {
        throw new Error('You have already used that nickname. It is best to keep nicknames unique')
      }

      if (params._id) {
        createResults = await freezr.update('dev.ceps.contacts', params._id, params)
        if (!createResults || createResults.error) {
          throw new Error(createResults?.error || 'Communication error')
        }
        state.contacts.forEach((item, i) => {
          if (item._id === params._id) state.contacts[i] = params
        })
      } else {
        createResults = await freezr.create('dev.ceps.contacts', params)
        if (!createResults || createResults.error) {
          throw new Error(createResults?.error || 'Communication error')
        }
        params._id = createResults._id
        state.contacts.push(params)
      }
      showLoading(false)
      clearNewContactFields()
      const overlay = document.getElementById('overlay')
      if (overlay) overlay.style.display = 'none'
      showHideAddSections()
      redrawContacts()
    } catch (e) {
      console.warn(e)
      showLoading(false)
      showWarning(e.message)
    }
  },
  urlSave: async function (args, target) {
    checkIfUrlIsValidAndPopulateContact()
  },
  groupSave: async function (args, target) {
    const nameEl = document.getElementById('new_name_group')
    if (!nameEl) return
    const name = nameEl.innerText.trim()
    try {
      if (!name) throw new Error('Group name is required')
      console.warn('SERVER SHOULD BE PINGED BEFORE PERSON IS ADDED and warning given if ping doesnt respond')
      
      const existing = await freezr.query('dev.ceps.groups', { name })
      if (existing.length > 0) {
        throw new Error('You have already used that name. It is best to keep names unique')
      }
      
      const createResults = await freezr.create('dev.ceps.groups', { name })
      if (!createResults || createResults.error) {
        throw new Error(createResults?.error || 'Communication error')
      }
      
      state.groups.push({ name, members: [], _id: createResults._id })
      nameEl.innerText = ''
      const overlay = document.getElementById('overlay')
      if (overlay) overlay.style.display = 'none'
      showHideAddSections()
      redrawGroups()
    } catch (e) {
      console.warn(e)
      showWarning(e.message)
    }
  },
  remove: async function (args, target) {
    const id = args.slice(3).join('_')
    if (confirm('Are you sure you want to delete this contact?')) {
      const rowWrapper = document.getElementById('wr_' + id)
      if (rowWrapper) rowWrapper.style.display = 'none'
      try {
        // console.log('deleting contact ', id)
        const delRes =  await freezr.delete('dev.ceps.contacts', id, {})
        console.log('delRes', { delRes })
        if (rowWrapper) rowWrapper.remove()
        state.contacts = state.contacts.filter(c => c._id !== id)
        redrawContacts()
      } catch (err) {
        if (rowWrapper) rowWrapper.style.display = 'block'
        showWarning('There was a problem deleting the contact. Try later may be?')
      }
    }
  },
  deleteGroup: async function () {
    if (!currentEditingGroup) return
    if (confirm('Are you sure you want to delete this group? This will remove the group but will not remove the contacts themselves.')) {
      try {
        await freezr.delete('dev.ceps.groups', currentEditingGroup._id, {})
        state.groups = state.groups.filter(g => g._id !== currentEditingGroup._id)
        endGroupEdit()
      } catch (err) {
        showWarning(err?.message || 'There was a problem deleting the group. Try later may be?')
      }
    }
  },
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
    const isUpdate = (params._id && params._id !== '')

    if (!params.name) {
      showWarning('The name is obligatory')
    } else if (!params.url && !params.code) {
      showWarning("When creating a new feed, the code is obligatory - if using someone else's, then the url is needed")
    } else {
      if (params.url) {
        console.warn('need to see how to deal with third party rights')
      }
      try {
        // { appToken: state.privateFeedToken, app_table: 'dev.ceps.privatefeeds.codes', q: { name: params.name } }
        const existing = await freezr.query('dev.ceps.privatefeeds.codes', { name: params.name }, { appToken: state.privateFeedToken })
        console.log('privateUrlSave existing', { existing })  
        if (!isUpdate && existing.length > 0) {
          showWarning('You have already used that name. It is best to keep names unique')
          return
        } else if (isUpdate && existing.length === 0) {
          showWarning('Error getting feeder from server')
          return
        }
        if (!isUpdate) {
          const createResults = await freezr.create('dev.ceps.privatefeeds.codes', params, { appToken: state.privateFeedToken })
          if (!createResults || createResults.error) {
            showWarning(createResults?.error || 'No response in creating feed')
            return
          }
          params._id = createResults._id
          state.privatefeeds.push(params)
        } else {
          const updateResults = await freezr.update('dev.ceps.privatefeeds.codes', params._id, params, { appToken: state.privateFeedToken })
          if (!updateResults || updateResults.error) {
            showWarning(updateResults?.error || 'No response in updating feed')
            return
          }
          state.privatefeeds.forEach((item, i) => {
            if (item._id === params._id) state.privatefeeds[i] = params
          })
        }
        const overlay = document.getElementById('overlay')
        if (overlay) overlay.style.display = 'none'
        showHideAddSections()
        redrawPrivateFeeds()
        // Reset title
        const titleEl = document.getElementById('privateFeedTitle')
        if (titleEl) titleEl.innerText = 'Create a private feed of links!'
      } catch (err) {
        showWarning(err?.message || 'Error saving feed')
      }
    }
  },
  privateFeedDelete: async function () {
    if (confirm('Are you sure you want to delete this feed and all associated records posted to the feed?')) {
      const idEl = document.getElementById('new__id_privatefeeds')
      if (!idEl) return
      const theId = idEl.innerText
      let feedToDelete
      state.privatefeeds.forEach(feed => { if (feed._id === theId) { feedToDelete = feed } })
      console.log({ feed: feedToDelete?.name, code: feedToDelete?.code })
      const results = await deleteAllFeedElements(feedToDelete)
      console.warn('privatefeeddelete - back from deleting individual ones', results)
      if (results && results.success) {
        try {
          await freezr.delete('dev.ceps.privatefeeds.codes', theId, { appToken: state.privateFeedToken })
          showWarning('Private feed deleted')
          state.privatefeeds = state.privatefeeds.filter(feed => feed._id !== theId)
        } catch (err) {
          showWarning('there was a problem deleting')
        }
      } else {
        showWarning('Could not delete all items. try later')
      }
      const overlay = document.getElementById('overlay')
      if (overlay) overlay.style.display = 'none'
      showHideAddSections()
      redrawPrivateFeeds()
      // Reset title
      const titleEl = document.getElementById('privateFeedTitle')
      if (titleEl) titleEl.innerText = 'Create a private feed of links!'
    }
  },
  visitFeedUrl: function () {
    const idEl = document.getElementById('new__id_privatefeeds')
    if (!idEl) return
    const theId = idEl.innerText
    state.privatefeeds.forEach(feed => {
      if (feed._id === theId) {
        window.open(('/public?feed=' + feed.name + '&code=' + feed.code), '_blank')
      }
    })
  },
  copyUrl: async function () {
    const urlEl = document.getElementById('urlContact')
    if (!urlEl) return
    const url = urlEl.innerText
    try {
      await navigator.clipboard.writeText(url)
      console.log('Copied to clipboard.')
    } catch (err) {
      showWarning('Could not copy url')
      console.error('Async: Could not copy text: ', err)
    }
  },
  exitEditMode: function () {
    endGroupEdit()
  },
  saveGroupName: async function () {
    if (!currentEditingGroup) return
    const nameEl = document.getElementById('edit_group_name')
    if (!nameEl) return
    const newName = nameEl.innerText.trim()
    if (!newName) {
      showWarning('Group name is required')
      return
    }
    try {
      currentEditingGroup.name = newName
      await freezr.update('dev.ceps.groups', currentEditingGroup._id, currentEditingGroup)
      endGroupEdit()
    } catch (err) {
      showWarning(err?.message || 'Error saving group name')
    }
  },
  cancelGroupEdit: function () {
    endGroupEdit()
  },
  regenerateCodeForPrivateFeed: function () {
    const codeDiv = document.getElementById('new_code_privatefeeds')
    if (codeDiv) codeDiv.innerText = randomText()
  }
}

const deleteAllFeedElements = async function (feed, numTry) {
  try {
    console.log('deleteAllFeedElements', { feed })
    const items = await freezr.publicquery({ feed: feed.name, code: feed.code, appToken: state.privateFeedToken  })
    console.log('delete items ret', { items })
    if (!items || items.error || !items.results) {
      return { success: false, error: (items?.error ? items.error : 'Could not delete items') }
    } else if (items.results.length === 0) {
      return { success: true }
    } else if (!numTry || numTry < 2) {
      for (const record of items.results) {
        console.log('unsharing record ', { record })
        const deleteResults = await freezr.perms.shareRecords(record._original_id, { 
          grantees: [('_privatefeed:' + feed.name)], 
          name: record._permission_name, 
          action: 'deny', 
          table_id: record._app_table, 
          requestor_app: record._app_name 
        })
        console.log({ deleteResults })
      }
      numTry = numTry ? (numTry + 1) : 1
      return deleteAllFeedElements(feed, numTry)
    } else {
      console.warn('too many tries')
      return { success: false, error: 'Too many retries' }
    }
  } catch (err) {
    console.error('deleteAllFeedElements error', { err })
    return { success: false, error: err?.message || 'Error deleting feed elements' }
  }
}

const showLoading = function (doShow) {
  const loader = document.getElementById('loader')
  if (loader) loader.style.display = doShow ? 'block' : 'none'
}

const showWarning = function (msg, timing) {
  if (msg) console.log('WARNING : ' + JSON.stringify(msg))
  const warnDiv = document.getElementById('warnings')
  if (!warnDiv) return
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
  if (!aList) aList = []
  if (!items) return aList
  if (typeof items === 'string' || !isNaN(items)) items = [items]
  if (!Array.isArray(items)) { throw new Error('items need to be a list') }
  if (transform) items = items.map(transform)
  items.forEach(function (anItem) { if (anItem && anItem !== ' ' && aList.indexOf(anItem) < 0 && anItem.length > 0) aList.push(anItem) })
  return aList
}

const removeFromlist = function (aList, item, transform) {
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
  if (document.activeElement && typeof document.activeElement.setRangeText === 'function') {
    // Modern input or textarea
    const el = document.activeElement
    const start = el.selectionStart
    const end = el.selectionEnd
    el.setRangeText(text, start, end, 'end')
    // Manually dispatch input event for frameworks/listeners
    el.dispatchEvent(new Event('input', { bubbles: true }))
  } else if (window.getSelection) {
    // Contenteditable elements
    const sel = window.getSelection()
    if (!sel.rangeCount) return
    sel.deleteFromDocument()
    sel.getRangeAt(0).insertNode(document.createTextNode(text))
    // Move caret to after inserted text
    sel.collapseToEnd()
  } else {
    // Fallback
    document.execCommand('insertText', false, text)
  }
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
