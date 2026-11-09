/*\
title: $:/plugins/dionisos/tiddlygit/synchronize.js
type: application/javascript
module-type: library

The synchronize button, on the browser side:

- the page is blocked (see synchronize-overlay), so that nothing is typed in a
  tiddler that git is changing,
- once the browser changes are saved, the server runs the synchronization,
- the tiddlers changed by git are loaded, then the page is unblocked.

Unblocking the page by hand before the request is sent (the browser changes
cannot be saved, the server is unreachable...) cancels the synchronization.

The state is kept in $:/temp/tiddlygit/synchronize: "status" ("running", then
the HTTP status, or "cancelled"), "blocked" ("yes" or "no"), "code" and "text"
(exit code and output of the script).

\*/
"use strict";

var STATE = "$:/temp/tiddlygit/synchronize",
	CHECK_INTERVAL = 50;

function waitUntil(condition,callback) {
	(function check() {
		if(condition()) {
			callback();
		} else {
			setTimeout(check,CHECK_INTERVAL);
		}
	})();
}

function isIdle(syncer) {
	return !syncer.forceSyncFromServer && syncer.numTasksInProgress === 0 && Object.keys(syncer.titlesToBeLoaded).length === 0;
}

/*
options:
	wiki, syncer: the browser wiki and its syncer
	post(callback): sends the synchronization request, then calls callback(err,status,data)
		with data the {code, output} answer of the server
	blur(): removes the focus from the field being edited
	notify(): tells the user the synchronization is over
*/
exports.synchronize = function(options) {
	var wiki = options.wiki,
		syncer = options.syncer;
	function update(fields) {
		wiki.addTiddler(new $tw.Tiddler(wiki.getTiddler(STATE),{title: STATE},fields));
	}
	if(wiki.getTiddler(STATE) && wiki.getTiddler(STATE).fields.status === "running") {
		return;
	}
	function isUnblocked() {
		return wiki.getTiddler(STATE).fields.blocked !== "yes";
	}
	update({status: "running", blocked: "yes", code: "", text: ""});
	options.blur();
	waitUntil(function() {return !syncer.isDirty() || isUnblocked();},function() {
		// Unblocked by hand before the request is sent: cancel the synchronization
		if(isUnblocked()) {
			update({status: "cancelled"});
			options.notify();
			return;
		}
		options.post(function(err,status,data) {
			update({status: String(status), code: data ? String(data.code) : "", text: data ? data.output : ""});
			syncer.syncFromServer();
			waitUntil(function() {return isIdle(syncer);},function() {
				update({blocked: "no"});
				options.notify();
			});
		});
	});
};
