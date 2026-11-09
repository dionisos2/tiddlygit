/*\
title: $:/plugins/dionisos/tiddlygit/browser-startup.js
type: application/javascript
module-type: startup

In the browser:

- keep the changes not sent to the server yet, instead of replacing them by
  the server version (see keep-local-changes.js),
- handle the tm-tiddlygit-synchronize message sent by the synchronize button
  (see synchronize.js).

\*/
"use strict";

exports.name = "tiddlygit-browser";
exports.platforms = ["browser"];
exports.after = ["startup"];
exports.before = ["render"];
exports.synchronous = true;

var NOTIFICATION = "$:/plugins/dionisos/tiddlygit/synchronize-notification";

function post(callback) {
	$tw.utils.httpRequest({
		url: "/tiddlygit/synchronize",
		type: "POST",
		headers: {"X-Requested-With": "TiddlyWiki"},
		callback: function(err,text,request) {
			var data = null;
			try {
				data = JSON.parse(text);
			} catch(e) {}
			callback(err,request.status,data);
		}
	});
}

exports.startup = function() {
	if(!$tw.syncer) {
		return;
	}
	require("$:/plugins/dionisos/tiddlygit/keep-local-changes.js").keepLocalChanges($tw.syncer);
	$tw.rootWidget.addEventListener("tm-tiddlygit-synchronize",function() {
		require("$:/plugins/dionisos/tiddlygit/synchronize.js").synchronize({
			wiki: $tw.wiki,
			syncer: $tw.syncer,
			post: post,
			blur: function() {
				if(document.activeElement && document.activeElement.blur) {
					document.activeElement.blur();
				}
			},
			notify: function() {
				$tw.notifier.display(NOTIFICATION);
			}
		});
		return false;
	});
};
