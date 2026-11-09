/*\
title: $:/plugins/dionisos/tiddlygit/browser-startup.js
type: application/javascript
module-type: startup

Keep the changes of the browser that are not sent to the server yet, instead of
replacing them by the server version (see keep-local-changes.js)

\*/
"use strict";

exports.name = "tiddlygit-browser";
exports.platforms = ["browser"];
exports.after = ["startup"];
exports.synchronous = true;

exports.startup = function() {
	if($tw.syncer) {
		require("$:/plugins/dionisos/tiddlygit/keep-local-changes.js").keepLocalChanges($tw.syncer);
	}
};
