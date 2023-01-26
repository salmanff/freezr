// freezr.info - nodejs system files - user_obj.js
/* global User */
exports.version = "0.0.1";

var bcrypt = require('bcryptjs');

User = function (userJson) {
  if (!userJson) userJson = {}
  this.email_address = userJson.email_address || null
  this.full_name = userJson.full_name || null
  this.user_id = userJson.user_id ? userIdFromUserInput(userJson.user_id) : null
  this.password = userJson.password || null
  this.fsParams = userJson.fsParams || {}
  this.dbParams = userJson.dbParams || {}
  this.limits = userJson.limits || {}
  this.userPrefs = userJson.userPrefs
  this.isAdmin = userJson.isAdmin || false
  this.first_seen_date = userJson.first_seen_date || null
  this.last_modified_date = userJson.last_modified_date || null
  this.deleted = userJson.deleted || null
}

User.prototype.email_address = null
User.prototype.user_id = null
User.prototype.full_name = null
User.prototype.password = null
User.prototype.isAdmin = false
User.prototype.first_seen_date = null
User.prototype.last_modified_date = null
User.prototype.deleted = false

User.prototype.check_password = function (pw, callback) {
  // onsole.log("checking pword "+pw+"for user "+JSON.stringify(this.response_obj()));
  bcrypt.compare(pw, this.password, callback) // compareSync
}
User.prototype.check_passwordSync = function (pw) {
  // onsole.log("checking pword "+pw+"for user "+JSON.stringify(this.response_obj()));
  return pw && this && this.password && bcrypt.compareSync(pw, this.password) // compareSync
}

User.prototype.response_obj = function () {
  const self = this
  return {
    user_id: this.user_id,
    full_name: this.full_name,
    email_address: this.email_address,
    isAdmin: this.isAdmin,
    fsParams: {
      type: self.fsParams?.type,
      choice: self.fsParams?.choice
    },
    dbParams: {
      type: self.dbParams?.type,
      choice: self.dbParams?.choice
    },
    limits: self.limits,
    userPrefs: self.userPrefs,
    first_seen_date: this.first_seen_date,
    last_modified_date: this.last_modified_date
  }
};

const userIdFromUserInput = function (userIdInput) {
  return userIdInput ? userIdInput.trim().toLowerCase().replace(/ /g, '_') : null
}

module.exports = User
