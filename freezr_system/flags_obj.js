// freezr.info - nodejs system files - flags_obj.js
// objects for keeping various error error and warning flags through out an async waterfall
exports.version = "0.0.1";

Flags = function (meta) {
    this.meta = meta? meta: {};
}

Flags.prototype.add = function (section, code, info) {
    if (!this[section]) this[section] = [];
    if (!info) info = {};
    info.code = code;
    this[section].push(info);
} 

Flags.prototype.sentencify = function (language) {
    var returnObj = {}, sectionItems, sentence;
    if (!language) language = "en";
    for (var section in this) {
        if (this.hasOwnProperty(section)) {
            if (section == "meta") {
                returnObj[section] = this[section];
            } else {
                if (!returnObj[section]) returnObj[section] = [];
                codedItems = this[section];
                codedItems.forEach(function (anItem) {
                    theCode = anItem.code? anItem.code: JSON.stringify(anItem);
                    sentence = sentences[language][theCode]? sentences[language][theCode] : (sentences['en'][theCode]? sentences['en'][theCode]: theCode);
                    if (anItem.text) sentence = sentence + " - " + anItem.text;
                    for (var info in anItem) {
                        if (anItem.hasOwnProperty(info) && info != "code") sentence = sentence.replace("{{"+info+"}}",anItem[info]);
                    }
                    returnObj[section].push({'text':sentence});
                });
            }
        }
    }
    return returnObj;
}

var sentences = {};
sentences.en = {
    'code':'sentence',
    'config_file_errors':'The app configuration file has errors and so it will have to be ignored.',
    'appconfig_missing': "This app does not have a configuration file.",
    'config_inconsistent_version': "The configuration file for this app states a different app version from the one on the name of the file uploaded. The version on the file name was used. The other version number was ignored.",
    'config_inconsistent_app_name': "The configuration file for this app states a different app name from the name of the file uploaded. The file name was used. The other name '{{app_name}}' was discarded.",
    'file_illegal_words': 'Illegal words {{words}} found in file "{{fileName}}"',
    'file_illegal_extension': 'the file "{{fileName}}" had an invalid extension.',
    'config_file_bad_ext': "Application configuration file '{{fileName}}' contain a non-{{ext}} file reference. That wil not work.",
    'extra_directory_illegal':"Currently, directories in application files (except for the static and public directories) are not allowed. Files in the directory '{{dir}}'' can be malicious, and the app should be removed, unless you are sure of the source.",
    'err_unknown': 'Unknown Error in function {{function}}',
    'err_file': 'Error getting file {{fileName}} in function {{function}}',
    'app_updated_msg': "The file uploaded was used to replace the existing app of the same name.",
    'collectionNameWithFiles': 'The collection name for all files is "files". You used "{{collection_name}}", and this was ignored.',
    'dataObjectIdSentWithFiles': 'The data_object_id name for all files is based on their file name and path. You cannot choose a data_object_id.',
    'fileRecordExistsWithNoFile': 'The file was saved, and a record created but no data record was found.',


    'foo':'bar - add more above'
}

module.exports = Flags;



