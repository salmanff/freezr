
freezr.initPageScripts = function() {
  msgDiv = document.getElementById("error_message");
  console.log('startup_errors ', startup_errors)
  const urlQueries = new URLSearchParams(window.location.search)
  const error = urlQueries.get('error')
  const errSource = urlQueries.get('errSource')
  const errorDetail = urlQueries.get('errorDetail')
  // error=couldNotAccessADb&errSource=userAppList&errorDetail
  msgDiv.innerHTML = ''
  if (error) msgDiv.innerHTML += error + '<br/>'
  if (errSource) msgDiv.innerHTML += 'Source: ' + errSource
  if (errorDetail) msgDiv.innerHTML += '<br/>' + errorDetail
  if (startup_errors) {
      if (!startup_errors.fundamentals_okay) msgDiv.innerHTML += "freezr encuntered a fundamental error.<br/>"
      if (!startup_errors.can_read_write_to_db) msgDiv.innerHTML += "freezr could not access the database. Please make sure a database is running."
      if (!startup_errors.can_write_to_user_folder) msgDiv.innerHTML += "freezr file system error"
  }
  if (msgDiv.innerHTML === '') msgDiv.innerHTML += "unknown error"
}
