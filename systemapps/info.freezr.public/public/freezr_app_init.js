/* freezr apps (electron)
  console.log(TO BE UPDATED)
  Script to be referenced after freezr_core and before manifest and freezer_app_post_scripts
*/
// Electron specific:
// window.nodeRequire = require;
delete window.require
delete window.exports
delete window.module

// all apps..
const exports = { structure: null }

/*
  In all freezr apps, freezrMeta needs to be defined before freezr_core.
  This is done in the html page script for server apps.
  For offline apps, a file like this must be used.
*/

/*
// Below used for electron (Needs to be checked)
var exports = exports || null;
var freezrMeta={}
var freezrMeta.appName = (exports && exports.structure && exports.structure.meta && exports.structure.meta.app_name)? exports.structure.meta.app_name: "";
var freezrMeta.appversion = (exports && exports.structure && exports.structure.meta && exports.structure.meta.app_version)? exports.structure.meta.app_version: "N/A";
var freezrMeta.appDisplayName = (exports && exports.structure && exports.structure.meta && exports.structure.meta.app_display_name)? exports.structure.meta.app_display_name: freezrMeta.appName;
*/

/* exported freezrMeta */

// For offline apps:
function FREEZR_META (appName, appVersion, appDisplayName) {
  this.initialize(appName, appVersion, appDisplayName)
}

const META_INIT_KEYS = ['appName', 'appVersion', 'appDisplayName']
// Keys that need to be set by app: userId. appToken, serverAddress, serverVersion, adminsuer
FREEZR_META.prototype.initialize = function (appName, appVersion, appDisplayName) {
  this.appName = appName
  this.appVersion = appVersion
  this.appDisplayName = appDisplayName
}

FREEZR_META.prototype.reset = function () {
  for (const prop in this) {
    if (Object.prototype.hasOwnProperty.call(this, prop) && META_INIT_KEYS.indexOf(prop) < 0) {
      delete this[prop]
    }
  }
}
FREEZR_META.prototype.set = function (props) {
  this.reset()
  for (const prop in props) {
    if (META_INIT_KEYS.indexOf(prop) < 0) {
      this[prop] = props[prop]
    }
  }
}

const freezrMeta = new FREEZR_META()
freezrMeta.initialize(exports) // eslint hack
