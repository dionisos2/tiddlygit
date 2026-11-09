/*\
title: $:/plugins/dionisos/tiddlygit/browser-startup.js
type: application/javascript
module-type: startup

In the browser:

- keep the changes not sent to the server yet, instead of replacing them by
  the server version (see keep-local-changes.js),
- handle the tm-tiddlygit-synchronize message sent by the synchronize button,
  and block the page while the server synchronizes (see synchronize.js).

\*/
"use strict";

exports.name = "tiddlygit-browser";
exports.platforms = ["browser"];
exports.after = ["startup"];
exports.before = ["render"];
exports.synchronous = true;

var NOTIFICATION = "$:/plugins/dionisos/tiddlygit/synchronize-notification";

function getStatus(callback) {
	$tw.utils.httpRequest({
		url: "/tiddlygit/status",
		callback: function(err,text) {
			var data = null;
			try {
				data = JSON.parse(text);
			} catch(e) {}
			callback(err,data);
		}
	});
}

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
	var synchronize = require("$:/plugins/dionisos/tiddlygit/synchronize.js");
	require("$:/plugins/dionisos/tiddlygit/keep-local-changes.js").keepLocalChanges($tw.syncer);
	synchronize.ignoreRefusedChanges($tw.syncer);
	synchronize.pollServerState($tw.wiki,$tw.syncer,getStatus);
	synchronize.followServer($tw.wiki);
	$tw.rootWidget.addEventListener("tm-tiddlygit-synchronize",function() {
		synchronize.synchronize({
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
