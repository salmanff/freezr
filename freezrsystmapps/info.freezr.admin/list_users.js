// list_users

/* global freezr */

freezr.initPageScripts = function () {
  document.onclick = function (e) {
    // onsole.log('click')
    if (e.target.id.indexOf('click') === 0) {
      getUsage(e.target)
    }
  }
}

const getUsage = async function (target) {
  const userId = target.id.split('_')[2]
  const url = '/adminapi/getuserappresources' + (userId ? '?user=' + userId : '')
  
  try {
    const resources = await freezr.apiRequest('GET', url)
    console.log({ resources })
    target.previousElementSibling.innerText = resources?.totalSize ? ((Math.round(resources?.totalSize / 100000) / 10) + 'MB') : ' - '
  } catch (err) {
    console.error({ err })
    alert('error connecting to server ' + err.message)
  }
}
