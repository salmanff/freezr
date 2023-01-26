// list_users

/* global freezr */

freezr.initPageScripts = function () {
  document.onclick = function (e) {
    console.log('click')
    if (e.target.id.indexOf('click') === 0) {
      getUsage(e.target)
    }
  }
}

const getUsage = function (target) {
  console.log(target.id)
  alert('got it')
}
