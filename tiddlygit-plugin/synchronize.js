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

The page is also blocked while the server synchronizes, whoever started it: the
browser asks GET /tiddlygit/status each time it polls the server, and keeps
the answer in the "synchronizing" field ("yes" or "no") of
$:/temp/tiddlygit/server. The server refuses the changes meanwhile (they are
sent again after).

The state is kept in $:/temp/tiddlygit/synchronize: "status" ("running", then
the HTTP status, or "cancelled"), "blocked" ("yes" or "no"), "dismissed" ("yes"
when unblocked by hand, until the server state changes), "code" and "text"
(exit code and output of the script).

\*/
"use strict";

var STATE = "$:/temp/tiddlygit/synchronize",
	SERVER_STATE = "$:/temp/tiddlygit/server",
	CHECK_INTERVAL = 50,
	// The status of the changes refused by the server while it synchronizes
	REFUSED_STATUS = 503;

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
	update({status: "running", blocked: "yes", dismissed: "", code: "", text: ""});
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

/*
A page unblocked by hand while the server synchronizes is blocked again by the
next synchronization of the server
*/
exports.followServer = function(wiki) {
	wiki.addEventListener("change",function(changes) {
		var state = wiki.getTiddler(STATE);
		if(changes[SERVER_STATE] && state && state.fields.dismissed) {
			wiki.addTiddler(new $tw.Tiddler(state,{dismissed: ""}));
		}
	});
};

/*
Ask the server whether it synchronizes each time the syncer polls it.
getStatus(callback) calls callback(err,data), with data the {synchronizing}
answer of the server.
*/
exports.pollServerState = function(wiki,syncer,getStatus) {
	var adaptor = syncer.syncadaptor,
		getSkinnyTiddlers = adaptor.getSkinnyTiddlers;
	adaptor.getSkinnyTiddlers = function() {
		getStatus(function(err,data) {
			var value = data && data.synchronizing ? "yes" : "no";
			if(!err && data && wiki.getTiddler(SERVER_STATE)?.fields.synchronizing !== value) {
				wiki.addTiddler({title: SERVER_STATE, synchronizing: value});
			}
		});
		return getSkinnyTiddlers.apply(this,arguments);
	};
};

/*
The changes refused by the server while it synchronizes are sent again by the
syncer: it is not an error to show
*/
exports.ignoreRefusedChanges = function(syncer) {
	var displayError = syncer.displayError;
	syncer.displayError = function(msg,err) {
		if(String(err).slice(-(": " + REFUSED_STATUS).length) === ": " + REFUSED_STATUS) {
			this.logger.log(msg + ": refused while the server synchronizes, it will be sent again");
			return;
		}
		return displayError.apply(this,arguments);
	};
};
