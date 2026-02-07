/* global freezr */

freezr.initPageScripts = function () {
  const generateBtn = document.getElementById('generateToken')
  const copyBtn = document.getElementById('copyToken')

  generateBtn.onclick = function () {
    const days = parseInt(document.getElementById('tokenDays').value, 10)
    if (!days || days < 1 || days > 30) {
      showError('Please choose a validity between 1 and 30 days.')
      return
    }

    const { token, expiresAt } = createSetupToken(days)
    document.getElementById('setupToken').value = token
    document.getElementById('tokenValue').textContent = token
    document.getElementById('tokenExpiry').textContent = expiresAt.toISOString()
    document.getElementById('tokenInstructions').style.display = 'block'
    showError('')
  }

  copyBtn.onclick = function () {
    const token = document.getElementById('setupToken').value
    if (!token) return
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(token).then(() => showError('Token copied.'))
        .catch(() => fallbackCopy(token))
    } else {
      fallbackCopy(token)
    }
  }
}

const createSetupToken = function (daysValid) {
  const bytes = new Uint8Array(24)
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  const secret = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  const expiresAt = new Date(Date.now() + (daysValid * 24 * 60 * 60 * 1000))
  const dateStr = expiresAt.toISOString().slice(0, 10)
  return { token: `${secret}.${dateStr}`, expiresAt }
}

const fallbackCopy = function (token) {
  const input = document.getElementById('setupToken')
  input.focus()
  input.select()
  try {
    document.execCommand('copy')
    showError('Token copied.')
  } catch (e) {
    showError('Copy failed. Please select and copy manually.')
  }
}

const showError = function (text) {
  const errorBox = document.getElementById('errorBox')
  if (!errorBox) return
  errorBox.style.display = text ? 'block' : 'none'
  errorBox.innerHTML = text || ''
}
