// freezr.info - nodejs system files - user_obj.js
exports.version = "0.0.1";

var bcrypt = require('bcryptjs');


User = function (user_json) {
    this.email_address = (user_json && user_json["email_address"])? user_json["email_address"]: null;
    this.full_name = (user_json && user_json["full_name"])? user_json["full_name"]: null;
    this.user_id = (user_json && user_json["user_id"])? user_id_from_user_input(user_json["user_id"]): null;
    this.password = user_json? user_json["password"] : null;
    this.isAdmin = (user_json && user_json["isAdmin"])? true: false;
    this.first_seen_date = user_json? user_json["first_seen_date"] : null;
    this.last_modified_date = user_json? user_json["last_modified_date"] : null;
    this.deleted = user_json? user_json["deleted"] : null;
}

User.prototype.email_address = null;
User.prototype.user_id = null;
User.prototype.full_name = null;
User.prototype.password = null;
User.prototype.isAdmin = false;
User.prototype.first_seen_date = null;
User.prototype.last_modified_date = null;
User.prototype.deleted = false;

User.prototype.check_password = function (pw, callback) {
    //onsole.log("checking pword "+pw+"for user "+JSON.stringify(this.response_obj()));
    bcrypt.compare(pw, this.password, callback); // compareSync
};
User.prototype.check_passwordSync = function (pw) {
    //onsole.log("checking pword "+pw+"for user "+JSON.stringify(this.response_obj()));
    return pw && this && this.password && bcrypt.compareSync(pw, this.password); // compareSync
};

User.prototype.response_obj = function () {
    return {
        user_id: this.user_id,
        full_name: this.full_name,
        email_address: this.email_address,
        isAdmin: this.isAdmin,
        first_seen_date: this.first_seen_date,
        last_modified_date: this.last_modified_date
    };
};

user_id_from_user_input = function (user_id_input) {
    return user_id_input? user_id_input.trim().toLowerCase().replace(/ /g, "_"): null;
}

module.exports = User;
