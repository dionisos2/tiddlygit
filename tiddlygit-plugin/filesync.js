/*\
title: $:/plugins/dionisos/tiddlygit/filesync.js
type: application/javascript
module-type: library

Keeps the server wiki in sync with the tiddler files on disk:

- files created, modified or deleted by another program (text editor, git...)
  are loaded into the wiki (and then reach the browsers through the usual
  syncer polling),
- while git runs, the server writes are held and the file watcher is paused,
  then the whole tiddlers folder is rescanned.

The wiki always wins over the disk when it has changes not yet written to the
disk, so that a file being written by the server is never reloaded half-written.

\*/
"use strict";

var fs = require("fs"),
	path = require("path");

var DEBOUNCE_DELAY = 200;

var logger = new $tw.utils.Logger("tiddlygit",{colour: "magenta"}),
	watcher = null,
	timers = Object.create(null),
	paused = false,
	writesHeld = false,
	heldWrites = [];

function tiddlersPath() {
	return $tw.boot.wikiTiddlersPath;
}

function isInTiddlersFolder(filepath) {
	return filepath.indexOf(tiddlersPath() + path.sep) === 0;
}

/*
Whether a file name can hold a tiddler. Editor temporary files (vim's "4913",
"foo~", ".foo.swp"...) are ignored.
*/
function isTiddlerFileName(filename) {
	if($tw.boot.excludeRegExp.test(filename) || filename.charAt(0) === "." || filename.slice(-1) === "~") {
		return false;
	}
	return !!$tw.config.fileExtensionInfo[path.extname(filename).toLowerCase()];
}

/*
Whether the wiki has changes for this title that are not written to disk yet
*/
function hasUnsavedChanges(title) {
	var syncer = $tw.syncer;
	if(!$tw.wiki.tiddlerExists(title) || syncer.getSyncedTiddlers($tw.wiki.makeTiddlerIterator([title])).length === 0) {
		return false;
	}
	var tiddlerInfo = syncer.tiddlerInfo[title];
	return !tiddlerInfo || $tw.wiki.getChangeCount(title) > tiddlerInfo.changeCount;
}

function titlesStoredIn(filepath) {
	return Object.keys($tw.boot.files).filter(function(title) {
		return $tw.boot.files[title].filepath === filepath;
	});
}

function removeTiddler(title) {
	logger.log("Removing tiddler whose file disappeared:",title);
	delete $tw.syncer.tiddlerInfo[title];
	delete $tw.boot.files[title];
	$tw.wiki.deleteTiddler(title);
}

/*
Whether the file content is the tiddler of the wiki. A .tid file cannot tell an
empty text from a missing one.
*/
function isSameTiddler(existing,fields) {
	var incoming = new $tw.Tiddler(fields);
	if(!existing.fields.text && !incoming.fields.text) {
		return existing.isEqual(incoming,["text"]);
	}
	return existing.isEqual(incoming);
}

function loadTiddler(fields,tiddlerFile) {
	var existing = $tw.wiki.getTiddler(fields.title);
	if(existing && isSameTiddler(existing,fields)) {
		return;
	}
	logger.log("Loading tiddler changed on disk:",fields.title);
	$tw.boot.files[fields.title] = {
		filepath: tiddlerFile.filepath,
		type: tiddlerFile.type,
		hasMetaFile: tiddlerFile.hasMetaFile,
		isEditableFile: false
	};
	$tw.syncer.storeTiddler(fields);
}

/*
Bring the wiki in line with the current content of a file
*/
function reconcileFile(filepath) {
	var tiddlerFile = null;
	if(fs.existsSync(filepath) && fs.statSync(filepath).isFile()) {
		try {
			tiddlerFile = $tw.loadTiddlersFromFile(filepath);
		} catch(e) {
			logger.log("Cannot read",filepath,e.message);
			return;
		}
	}
	var tiddlers = tiddlerFile ? tiddlerFile.tiddlers.filter(function(fields) {return !!fields.title;}) : [],
		titlesInFile = tiddlers.map(function(fields) {return fields.title;});
	// Tiddlers no longer in this file (file deleted, or title changed inside it)
	titlesStoredIn(filepath).forEach(function(title) {
		if(titlesInFile.indexOf(title) === -1 && !hasUnsavedChanges(title)) {
			removeTiddler(title);
		}
	});
	tiddlers.forEach(function(fields) {
		if(!hasUnsavedChanges(fields.title)) {
			loadTiddler(fields,tiddlerFile);
		}
	});
}

function onFileEvent(filename) {
	if(paused || !filename) {
		return;
	}
	var filepath = path.resolve(tiddlersPath(),filename);
	// A .meta file belongs to the file it describes
	if(path.extname(filepath) === ".meta") {
		filepath = filepath.slice(0,-5);
	}
	if(!isTiddlerFileName(path.basename(filepath))) {
		return;
	}
	clearTimeout(timers[filepath]);
	timers[filepath] = setTimeout(function() {
		delete timers[filepath];
		if(!paused) {
			reconcileFile(filepath);
		}
	},DEBOUNCE_DELAY);
}

function listTiddlerFiles(folder) {
	var result = [];
	fs.readdirSync(folder,{withFileTypes: true}).forEach(function(entry) {
		var fullpath = path.join(folder,entry.name);
		if(entry.isDirectory() && entry.name.charAt(0) !== ".") {
			result.push.apply(result,listTiddlerFiles(fullpath));
		} else if(entry.isFile() && isTiddlerFileName(entry.name)) {
			result.push(fullpath);
		}
	});
	return result;
}

/*
Reconcile every file of the tiddlers folder, and every tiddler whose file vanished
*/
exports.rescan = function() {
	var files = listTiddlerFiles(tiddlersPath());
	Object.keys($tw.boot.files).forEach(function(title) {
		var filepath = $tw.boot.files[title].filepath;
		if(isInTiddlersFolder(filepath) && files.indexOf(filepath) === -1) {
			files.push(filepath);
		}
	});
	files.forEach(reconcileFile);
};

/*
Start watching the tiddlers folder
*/
exports.start = function() {
	if(watcher || !$tw.syncer || !tiddlersPath()) {
		return;
	}
	watcher = fs.watch(tiddlersPath(),{recursive: true},function(eventType,filename) {
		onFileEvent(filename);
	});
	// Hold the writes of the filesystem adaptor while git runs
	var adaptor = $tw.syncadaptor;
	["saveTiddler","deleteTiddler"].forEach(function(method) {
		var original = adaptor[method];
		adaptor[method] = function() {
			var args = arguments;
			if(writesHeld) {
				heldWrites.push(function() {original.apply(adaptor,args);});
			} else {
				original.apply(adaptor,args);
			}
		};
	});
	logger.log("Watching",tiddlersPath());
};

/*
Pause the watcher and hold the server writes, until resume() is called
*/
exports.pause = function() {
	paused = true;
	writesHeld = true;
	Object.keys(timers).forEach(function(filepath) {
		clearTimeout(timers[filepath]);
		delete timers[filepath];
	});
};

/*
Rescan the tiddlers folder, then apply the held writes and restart the watcher
*/
exports.resume = function() {
	exports.rescan();
	writesHeld = false;
	var writes = heldWrites;
	heldWrites = [];
	writes.forEach(function(write) {write();});
	// Ignore the events of the changes made while paused, they are all rescanned
	setTimeout(function() {
		paused = false;
	},DEBOUNCE_DELAY);
};

/*
Call callback once the wiki changes are written to disk (or after timeout ms)
*/
exports.waitForPendingSaves = function(timeout,callback) {
	var start = Date.now();
	(function check() {
		if(!$tw.syncer.isDirty() || Date.now() - start > timeout) {
			callback();
		} else {
			setTimeout(check,100);
		}
	})();
};
