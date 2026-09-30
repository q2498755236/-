/**
 * LingMou v4.2 RC13
 * Startup diagnostic
 */
function check(){
    let result={
        files: typeof files !== "undefined",
        engines: typeof engines !== "undefined",
        java: typeof java !== "undefined",
        runtime:"AutoX.js v7"
    };
    return result;
}

module.exports={check:check};
