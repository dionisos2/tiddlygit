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
to the server (or deleted from it), like the server keeps its changes not
written to disk yet.

\*/
"use strict";

/*
Whether the browser has changes for this title not sent to the server yet,
including a deletion: the syncer still knows the tiddler, but it is gone
*/
function hasUnsentChanges(syncer,title) {
	var tiddlerInfo = syncer.tiddlerInfo[title];
	if(!syncer.wiki.tiddlerExists(title)) {
		return !!tiddlerInfo;
	}
	return !tiddlerInfo || syncer.wiki.getChangeCount(title) > tiddlerInfo.changeCount;
}

exports.keepLocalChanges = function(syncer) {
	var storeTiddler = syncer.storeTiddler,
		adaptor = syncer.syncadaptor,
		loadTiddler = adaptor.loadTiddler,
		// Tiddlers whose local deletion was kept: the syncer still wants to load
		// them, but they are deleted from the server too
		keptDeletions = Object.create(null);
	syncer.storeTiddler = function(tiddlerFields) {
		var title = tiddlerFields.title;
		if(!hasUnsentChanges(this,title)) {
			return storeTiddler.apply(this,arguments);
		}
		if(!this.wiki.tiddlerExists(title)) {
			keptDeletions[title] = true;
		}
		this.logger.log("Keeping the local changes of",title);
		// Remember the server revision, so that it is not loaded again. A
		// tiddler created in the browser and never saved stays to be saved.
		this.tiddlerInfo[title] = $tw.utils.extend({changeCount: -1},this.tiddlerInfo[title],{
			revision: tiddlerFields.revision
		});
	};
	adaptor.loadTiddler = function(title,callback) {
		if(keptDeletions[title]) {
			delete keptDeletions[title];
			if(!syncer.wiki.tiddlerExists(title)) {
				return callback(null,null);
			}
		}
		return loadTiddler.apply(this,arguments);
	};
};
