/*\
title: $:/plugins/dionisos/tiddlygit/keep-local-changes.js
type: application/javascript
module-type: library

Keeps the changes of the browser that are not sent to the server yet.

The syncer of the browser saves a tiddler at most once per second. When the
server version of a tiddler changes (file changed on disk, git
synchronization, another tab...), the syncer loads it even if the browser has
changes not sent yet, and what was typed during the last second disappears.

With keepLocalChanges, the browser version wins: it is kept and will be saved
to the server, like the server keeps its changes not written to disk yet.

\*/
"use strict";

function hasUnsentChanges(syncer,title) {
	var tiddlerInfo = syncer.tiddlerInfo[title];
	return syncer.wiki.tiddlerExists(title) && (!tiddlerInfo || syncer.wiki.getChangeCount(title) > tiddlerInfo.changeCount);
}

exports.keepLocalChanges = function(syncer) {
	var storeTiddler = syncer.storeTiddler;
	syncer.storeTiddler = function(tiddlerFields) {
		var title = tiddlerFields.title;
		if(!hasUnsentChanges(this,title)) {
			return storeTiddler.apply(this,arguments);
		}
		this.logger.log("Keeping the local changes of",title);
		// Remember the server revision, so that it is not loaded again. A
		// tiddler created in the browser and never saved stays to be saved.
		this.tiddlerInfo[title] = $tw.utils.extend({changeCount: -1},this.tiddlerInfo[title],{
			revision: tiddlerFields.revision
		});
	};
};
