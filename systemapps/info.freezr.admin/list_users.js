// list_users

/* global freezr, freezerRestricted */

freezr.initPageScripts = function () {
  document.onclick = function (e) {
    // onsole.log('click')
    if (e.target.id.indexOf('click') === 0) {
      getUsage(e.target)
    }
  }
}

const getUsage = function (target) {
  const options = { user: target.id.split('_')[2] }
  freezerRestricted.connect.read('/v1/admin/data/app_resource_use.json', options, function (err, resources) {
    console.log({ err, resources })
    if (err) alert('error conecting to server ' + err.message)
    target.previousElementSibling.innerText = resources?.totalSize ? ((Math.round(resources?.totalSize / 100000) / 10) + 'MB') : ' - '
  })
}
