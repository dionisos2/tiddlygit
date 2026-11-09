/*\
title: $:/plugins/dionisos/tiddlygit/status-route.js
type: application/javascript
module-type: route

GET /tiddlygit/status

Responds with {synchronizing}, true while a synchronization runs (see
synchronize-route.js), so that the browsers block their page.

\*/
"use strict";

exports.methods = ["GET"];

exports.path = /^\/tiddlygit\/status$/;

exports.info = {
	priority: 100
};

exports.handler = function(request,response,state) {
	var synchronizing = require("$:/plugins/dionisos/tiddlygit/synchronize-route.js").isRunning();
	state.sendResponse(200,{"Content-Type": "application/json"},JSON.stringify({synchronizing: synchronizing}));
};
