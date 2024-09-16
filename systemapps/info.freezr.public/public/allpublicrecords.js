/*
  allpublicrecords
*/
/* global freezr */

let feedcode = null

freezr.initPageScripts = function () {
  document.querySelectorAll('IMG').forEach(picDiv => {
    if (picDiv.naturalHeight === 0 && picDiv.getAttribute('imgerror') === 'hide') picDiv.style.display = 'none'
    picDiv.onerror = function (e) {
      if (picDiv.getAttribute('imgerror') === 'hide') picDiv.style.display = 'none'
    }
  })
  const urlParams = new URLSearchParams(window.location.search)
  let wordString = ''
  if (urlParams.get('feed')) wordString += 'feed:' + urlParams.get('feed') + ' '
  if (urlParams.get('code')) feedcode = urlParams.get('code')
  if (urlParams.get('app')) wordString += 'app:' + urlParams.get('app') + ' '
  if (urlParams.get('user')) wordString += 'user:' + urlParams.get('user') + ' '
  if (urlParams.get('q')) wordString += urlParams.get('q')
  document.getElementById('searchBox').innerText = wordString.toLowerCase()

  document.addEventListener('click', function (e) {
    let el = e.target
    if (el.className === 'freezr_expander') {
      el.style.display = 'none'
      while (el.tagName !== 'body' && el.className.indexOf('freezr_public_genericCardOuter') < 0) { el = el.parentNode }
      if (el.tagName !== 'body') el.className = 'freezr_public_genericCardOuter'
      adjustHeight(el)
    } else if (el.id === 'searchButt') {
      doSearch()
    }
  }, false)

  document.onkeydown = function (evt) {
    if (evt.key === 'Enter' && evt.target?.id === 'searchBox') {
      evt.preventDefault()
      doSearch()
    }
  }
  window.onresize = function (event) {
    const outers = document.getElementsByClassName('freezr_public_genericCardOuter')
    Array.prototype.forEach.call(outers, function (anOuter) {
      if (anOuter.className.indexOf('freezr_public_genericCardOuter_overflower') < 0) adjustHeight(anOuter)
    })
  }
}

const doSearch = function () {
  const originalSearchString = document.getElementById('searchBox').innerText.toLowerCase()

  let newString = ''
  let words = ''
  if (originalSearchString.length > 0) {
    originalSearchString.split(' ').forEach(aterm => {
      if (startsWith(aterm, 'feed:')) {
        newString += '&feed=' + aterm.slice(5)
        if (feedcode) newString += '&code=' + feedcode
      } else if (startsWith(aterm, 'app:')) {
        newString += '&app=' + aterm.slice(4)
      } else if (startsWith(aterm, 'user:')) {
        newString += '&user=' + aterm.slice(5)
      } else if (aterm.trim().length > 0) {
        words += (aterm.trim() + ' ')
      }
    })
    if (newString.length > 0) newString = '?' + newString.slice(1)
    if (words.length > 0) newString += (newString.length > 1 ? '&' : '?') + 'q=' + words.trim()
  }
  window.open('/public' + newString, '_self')
}

const startsWith = function (longertext, checktext) {
  if (checktext.length > longertext.length) {
    return false
  } else {
    return (checktext === longertext.slice(0, checktext.length))
  }
}

const adjustHeight = function (originalEl, el) {
  if (!el) el = originalEl
  Array.from(el.children).forEach((aChild, index) => {
    const diff = (aChild.offsetTop + aChild.offsetHeight) - (originalEl.offsetTop + originalEl.offsetHeight)
    if (diff > 0) { originalEl.style.minHeight = (originalEl.offsetHeight + diff) + 'px' }
    adjustHeight(originalEl, aChild)
  })
}