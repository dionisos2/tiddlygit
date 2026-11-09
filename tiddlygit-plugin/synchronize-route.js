/*\
title: $:/plugins/dionisos/tiddlygit/synchronize-route.js
type: application/javascript
module-type: route

POST /tiddlygit/synchronize

Runs the synchronization script (synchronize.sh at the root of the TiddlyGit
repository, or $TIDDLYGIT_SYNC_SCRIPT) and responds with {code, output}.

While a synchronization runs, GET /tiddlygit/status tells it (the browsers
block their page, see synchronize.js), and while the script runs, the requests
changing the wiki are refused (see lockChanges).

\*/
"use strict";

var SETTLE_DELAY = 1500,
	PENDING_SAVES_TIMEOUT = 10000,
	REFUSED_STATUS = 503;

var running = false;

exports.methods = ["POST"];

exports.path = /^\/tiddlygit\/synchronize$/;

exports.info = {
	priority: 100
};

function scriptPath() {
	var path = require("path");
	return process.env.TIDDLYGIT_SYNC_SCRIPT || path.resolve($tw.boot.wikiPath,"../synchronize.sh");
}

function runScript(script,callback) {
	var output = "",
		child = require("child_process").spawn(script,[],{cwd: require("path").dirname(script)});
	child.stdout.on("data",function(data) {output += data;});
	child.stderr.on("data",function(data) {output += data;});
	child.on("error",function(err) {
		output += err.message;
	});
	child.on("close",function(code) {
		callback(code === null ? -1 : code,output);
	});
}

exports.isRunning = function() {
	return running;
};

/*
Refuse the requests changing the wiki (saving or deleting a tiddler...) while
the script runs, so that the wiki does not change while git does. The browsers
send them again after.
*/
exports.lockChanges = function(server) {
	var filesync = require("$:/plugins/dionisos/tiddlygit/filesync.js");
	server.routes.forEach(function(route) {
		var methods = route.methods || [route.method];
		if(route === exports || methods.every(function(method) {return method === "GET" || method === "HEAD";})) {
			return;
		}
		var handler = route.handler;
		route.handler = function(request,response,state) {
			if(filesync.isPaused()) {
				state.sendResponse(REFUSED_STATUS,{"Content-Type": "text/plain"},"A synchronization is running");
			} else {
				handler.apply(this,arguments);
			}
		};
	});
};

exports.handler = function(request,response,state) {
	var filesync = require("$:/plugins/dionisos/tiddlygit/filesync.js");
	if(running) {
		state.sendResponse(409,{"Content-Type": "text/plain"},"A synchronization is already running");
		return;
	}
	running = true;
	// Leave time to the browsers to send their last changes (their syncer
	// waits up to one second between two saves of the same tiddler)
	setTimeout(function() {
		filesync.waitForPendingSaves(PENDING_SAVES_TIMEOUT,function() {
			filesync.pause();
			runScript(scriptPath(),function(code,output) {
				try {
					filesync.resume();
				} finally {
					running = false;
				}
				state.sendResponse(200,{"Content-Type": "application/json"},JSON.stringify({code: code, output: output}));
			});
		});
	},SETTLE_DELAY);
};
