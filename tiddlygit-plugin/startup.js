/*\
title: $:/plugins/dionisos/tiddlygit/startup.js
type: application/javascript
module-type: startup

Start watching the tiddler files once the server is listening (and only then,
so that commands like --build are not kept alive by the watcher), and refuse
the changes while synchronizing (see synchronize-route.js)

\*/
"use strict";

exports.name = "tiddlygit";
exports.platforms = ["node"];
exports.after = ["startup"];
exports.before = ["commands"];
exports.synchronous = true;

exports.startup = function() {
	$tw.hooks.addHook("th-server-command-post-start",function(server) {
		var route = require("$:/plugins/dionisos/tiddlygit/synchronize-route.js");
		require("$:/plugins/dionisos/tiddlygit/filesync.js").start();
		route.lockChanges(server);
	});
};
