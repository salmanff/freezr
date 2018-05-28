// freezr.info - nodejs system files - file_sensor - 
// very very preliminary version - just an idea at this point
exports.version = "0.0.1";

var path = require('path'), 
	flags_obj = require("./flags_obj.js");


const ILLEGAL_WORD_LIST = ['http','eval','setattribute'];
const ALLOWED_APP_DIRECTORIES = ['static','public',('public'+path.sep+'static')]; // todo deprecate
const ALLOWED_FILE_EXTS = ['json','png','jpg','jpeg','eot','ttf','woff','woff2'] 
	// todo these should only be under static or make sure when reading files in load html that scripts are scripts and html's have html ending

const TEXT_FILE_EXTS = ['json','html','js','css']

exports.is_text_file = function(file_name) {
    var file_ext = fileExt(file_name);
    return (TEXT_FILE_EXTS.indexOf(file_ext.toLowerCase()) >= 0)
}
exports.is_allowed_file_ext = function(file_name) {
    // of course, this can be circumvented to fix
    var file_ext = fileExt(file_name);
    return (ALLOWED_FILE_EXTS.indexOf(file_ext.toLowerCase()) >= 0)
}
exports.sensor_file_text = function (aText, fileName, flags) {
    // todo review and amerliorate (if not too weak a word) sensor algorithm
    // Write now sensor only gives warnings... at some point it will also sensor
    //onsole.log("senoring "+fileName+" with flags"+JSON.stringify(flags));
    if (!flags) flags = new Flags();
    
    var file_ext = fileExt(fileName);
    var found_illegal_words = [];

    if (file_ext == 'js') {
        found_illegal_words = get_illegalWords(aText);
        if (found_illegal_words.length>0) flags.add('illegal','file_illegal_words', {'words':found_illegal_words.join(','), 'fileName':fileName} );
    } else if (file_ext == 'css') {
        // todo... anthing?
    } else if (file_ext == 'html') {
        // to do - go through attributes and sensor

    } else if (ALLOWED_FILE_EXTS.indexOf(file_ext.toLowerCase()) < 0){
        flags.add('warnings','file_illegal_extension',{'fileName':fileName,'text':'All static files should be under static directory'});
    }
    return flags;

}

exports.isStaticFolder = function (filePath) {
    // todo make sure this works in sync too
   // "path_lower":"/userapps/info.freezr.vulog/static/favicon_www.png"
   var parts = filePath.split("/")
   if (parts.length<3) return false;
   if (parts[parts.length-2] == "static") return true;
   return false;
}
                                        

exports.add_directory_flags = function (dirName, flags){
    if (ALLOWED_APP_DIRECTORIES.indexOf(dirName)<0) {flags.add('illegal','extra_directory_illegal', {'dir':dirName} )}
    return flags;
}

var fileExt = function(fileName) {
    var ext = path.extname(fileName);
    if (ext && ext.length>0) ext = ext.slice(1);
    return ext;
}
var get_illegalWords = function (aText) {
    aText = aText.toString();
    found_illegal_words = [];
    ILLEGAL_WORD_LIST.forEach(function (bad_word) {
        if (aText.indexOf(bad_word)>-1) {
            found_illegal_words.push(bad_word);
        }
    });
    return found_illegal_words;
}
