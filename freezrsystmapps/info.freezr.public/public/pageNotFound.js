// pageNotFound.js


window.addEventListener('DOMContentLoaded', function() {
  console.log('pageNotFound.js loaded')
  // Helper to get URL params
  const urlParams = new URLSearchParams(window.location.search);
  const errorMsg = urlParams.get('error');
  if (errorMsg) {
    showError('Error messsage: ' + errorMsg);
  }
});

function showError(errorMsg) {
  const errorBox = document.getElementById('errorBox');
  errorBox.style.display = 'block';
  errorBox.innerHTML = errorMsg;
}