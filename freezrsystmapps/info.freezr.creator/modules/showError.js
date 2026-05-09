let hideTimer = null

export const showError = (message, options = {}) => {
  const box = document.getElementById('creatorErrorBox')
  if (!box) return

  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 4500

  box.textContent = message || 'Something went wrong.'
  box.hidden = false

  if (hideTimer) {
    window.clearTimeout(hideTimer)
    hideTimer = null
  }

  if (timeoutMs > 0) {
    hideTimer = window.setTimeout(() => {
      box.hidden = true
      hideTimer = null
    }, timeoutMs)
  }
}

export const clearError = () => {
  const box = document.getElementById('creatorErrorBox')
  if (!box) return
  if (hideTimer) {
    window.clearTimeout(hideTimer)
    hideTimer = null
  }
  box.hidden = true
}
