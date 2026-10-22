/**
 * LingMou v4.2 RC8
 * AutoX.js v7 file compatibility
 */
function dirName(path){
    if(!path) return "";
    return new java.io.File(path).getParent();
}

function baseName(path){
    if(!path) return "";
    return new java.io.File(path).getName();
}

module.exports = {
    dirName: dirName,
    baseName: baseName
};