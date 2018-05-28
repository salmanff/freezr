
freezr.initPageScripts = function() {
  msgDiv = document.getElementById("error_message");
  if (startup_errors) {
    msgDiv.innerHTML = "";
      if (!startup_errors.fundamentals_okay) msgDiv.innerHTML += "freezr encuntered a fundamental error.<br/>"
      if (!startup_errors.can_read_write_to_db) msgDiv.innerHTML += "freezr could not access the database. Please make sure a database is running."
      if (!startup_errors.can_write_to_user_folder) msgDiv.innerHTML += "freezr file system error"
  } else {
  	msgDiv.innerHTML += "unknown error"
  }

}


