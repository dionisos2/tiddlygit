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

A file holding a tiddler already stored in another file (copied by hand, or
created on both sides of a git merge...) is renamed: the tiddler gets a title
prefixed by "Duplicate - " (or "Duplicate 2 - "...), and is saved in a new file.

\*/
"use strict";

var fs = require("fs"),
	path = require("path");

var DEBOUNCE_DELAY = 200,
	WATCH_RETRY_DELAY = 5000,
	DRAFTS_FOLDER = "drafts";

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
(including a deletion: the syncer still knows the tiddler, but it is gone)
*/
function hasUnsavedChanges(title) {
	var syncer = $tw.syncer,
		tiddlerInfo = syncer.tiddlerInfo[title];
	if(!$tw.wiki.tiddlerExists(title)) {
		return !!tiddlerInfo;
	}
	if(syncer.getSyncedTiddlers($tw.wiki.makeTiddlerIterator([title])).length === 0) {
		return false;
	}
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
	var existing = $tw.wiki.getTiddler(fields.title),
		fileInfo = $tw.boot.files[fields.title];
	if(existing && isSameTiddler(existing,fields)) {
		// The file was moved: remember where it is now
		if(fileInfo && fileInfo.filepath !== tiddlerFile.filepath) {
			fileInfo.filepath = tiddlerFile.filepath;
			fileInfo.hasMetaFile = tiddlerFile.hasMetaFile;
		}
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
The file, other than filepath, that holds the tiddler with this title, if any
*/
function otherFileHolding(title,filepath) {
	var fileInfo = $tw.boot.files[title];
	if(!fileInfo || fileInfo.filepath === filepath) {
		return null;
	}
	try {
		var holdsTitle = $tw.loadTiddlersFromFile(fileInfo.filepath).tiddlers.some(function(fields) {
			return fields.title === title;
		});
		return holdsTitle ? fileInfo.filepath : null;
	} catch(e) {
		// The tiddler was moved to filepath
		return null;
	}
}

function duplicateTitle(title) {
	for(var number = 1; ; number++) {
		var candidate = "Duplicate" + (number > 1 ? " " + number : "") + " - " + title;
		if(!$tw.wiki.tiddlerExists(candidate) && !$tw.boot.files[candidate]) {
			return candidate;
		}
	}
}

/*
Give a new title to the tiddler of a file that duplicates another file: the
syncer saves it in a new file, named after its title, and the file is removed
*/
function renameDuplicate(fields,tiddlerFile,otherFile) {
	var title = duplicateTitle(fields.title);
	logger.log("Tiddler",fields.title,"is also in",otherFile + ": the one of",tiddlerFile.filepath,"is renamed to",title);
	// Removed first: a file that cannot be removed would make another duplicate at each rescan
	fs.unlinkSync(tiddlerFile.filepath);
	if(tiddlerFile.hasMetaFile) {
		fs.unlinkSync(tiddlerFile.filepath + ".meta");
	}
	$tw.wiki.addTiddler(new $tw.Tiddler(fields,{title: title}));
}

/*
Bring the wiki in line with the current content of a file
*/
function reconcileFile(filepath) {
	var tiddlerFile = null;
	try {
		if(fs.statSync(filepath).isFile()) {
			tiddlerFile = $tw.loadTiddlersFromFile(filepath);
		}
	} catch(e) {
		// A missing file is a deleted file, any other error leaves the wiki as it is
		if(e.code !== "ENOENT") {
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
		if(hasUnsavedChanges(fields.title)) {
			return;
		}
		var otherFile = otherFileHolding(fields.title,filepath);
		if(!otherFile) {
			loadTiddler(fields,tiddlerFile);
		} else if(tiddlers.length === 1) {
			renameDuplicate(fields,tiddlerFile,otherFile);
		} else {
			logger.log("Tiddler",fields.title,"of",filepath,"is ignored, it is also in",otherFile);
		}
	});
}

/*
Like reconcileFile, but an error is only logged: the server must keep running
*/
function reconcileFileSafely(filepath) {
	try {
		reconcileFile(filepath);
	} catch(e) {
		logger.log("Cannot reload",filepath,e.message);
	}
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
	// The events of the files of a new folder can be missed
	if(isDirectory(filepath)) {
		var files = [];
		listTiddlerFiles(filepath,files,[]);
		files.forEach(scheduleReconcile);
		return;
	}
	if(isTiddlerFileName(path.basename(filepath))) {
		scheduleReconcile(filepath);
	}
}

function isDirectory(filepath) {
	try {
		return fs.statSync(filepath).isDirectory();
	} catch(e) {
		return false;
	}
}

function scheduleReconcile(filepath) {
	clearTimeout(timers[filepath]);
	timers[filepath] = setTimeout(function() {
		delete timers[filepath];
		if(!paused) {
			reconcileFileSafely(filepath);
		}
	},DEBOUNCE_DELAY);
}

/*
Add the tiddler files of a folder (and its subfolders) to files, and the
folders that cannot be read to unreadable
*/
function listTiddlerFiles(folder,files,unreadable) {
	var entries;
	try {
		entries = fs.readdirSync(folder,{withFileTypes: true});
	} catch(e) {
		logger.log("Cannot read",folder,e.message);
		unreadable.push(folder);
		return;
	}
	entries.forEach(function(entry) {
		var fullpath = path.join(folder,entry.name);
		if(entry.isDirectory() && entry.name.charAt(0) !== ".") {
			listTiddlerFiles(fullpath,files,unreadable);
		} else if(entry.isFile() && isTiddlerFileName(entry.name)) {
			files.push(fullpath);
		}
	});
}

/*
Reconcile every file of the tiddlers folder, and every tiddler whose file
vanished (but not the ones in a folder that cannot be read)
*/
exports.rescan = function() {
	var files = [],
		unreadable = [];
	listTiddlerFiles(tiddlersPath(),files,unreadable);
	function isReadable(filepath) {
		return unreadable.every(function(folder) {return filepath.indexOf(folder + path.sep) !== 0;});
	}
	Object.keys($tw.boot.files).forEach(function(title) {
		var filepath = $tw.boot.files[title].filepath;
		if(isInTiddlersFolder(filepath) && isReadable(filepath) && files.indexOf(filepath) === -1) {
			files.push(filepath);
		}
	});
	files.forEach(reconcileFileSafely);
};

/*
Once a tiddler is saved as .json (TiddlyWiki does it when a field has leading
or trailing spaces), keep it as .json: going back to .tid would make git see a
deleted file and a created one at each change
*/
function keepJsonFiles(adaptor) {
	var getTiddlerFileInfo = adaptor.getTiddlerFileInfo;
	adaptor.getTiddlerFileInfo = function(tiddler,callback) {
		var oldInfo = $tw.boot.files[tiddler.fields.title];
		getTiddlerFileInfo.call(adaptor,tiddler,function(err,fileInfo) {
			var isJson = oldInfo && oldInfo.type === "application/json" && !oldInfo.hasMetaFile;
			if(!err && isJson && fileInfo.type === "application/x-tiddler") {
				var stem = fileInfo.filepath.replace(/\.tid$/,"");
				fileInfo = $tw.utils.extend({},fileInfo,{
					type: "application/json",
					filepath: oldInfo.filepath === stem + ".json" ? oldInfo.filepath : stem + ".json"
				});
			}
			callback(err,fileInfo);
		});
	};
}

/*
Save the drafts in the drafts/ subfolder, ignored by git: a tiddler being
edited when synchronizing must not be committed
*/
function saveDraftsInDraftsFolder(adaptor) {
	var getTiddlerFileInfo = adaptor.getTiddlerFileInfo;
	adaptor.getTiddlerFileInfo = function(tiddler,callback) {
		getTiddlerFileInfo.call(adaptor,tiddler,function(err,fileInfo) {
			if(!err && tiddler.hasField("draft.of")) {
				var draftsFolder = path.join(tiddlersPath(),DRAFTS_FOLDER);
				if(path.dirname(fileInfo.filepath) !== draftsFolder) {
					fileInfo = $tw.utils.extend({},fileInfo,{
						filepath: path.join(draftsFolder,path.basename(fileInfo.filepath))
					});
				}
			}
			callback(err,fileInfo);
		});
	};
}

/*
Watch the tiddlers folder. The watcher fails on a folder that cannot be read
(or that disappears while it scans it): it is then started again, and the
changes it missed are rescanned.
*/
function watch() {
	function retry(err) {
		logger.log("Cannot watch",tiddlersPath() + ":",err.message);
		setTimeout(function() {
			watch();
			if(!paused) {
				exports.rescan();
			}
		},WATCH_RETRY_DELAY);
	}
	try {
		watcher = fs.watch(tiddlersPath(),{recursive: true},function(eventType,filename) {
			onFileEvent(filename);
		});
	} catch(e) {
		watcher = {close: function() {}};
		retry(e);
		return;
	}
	watcher.on("error",function(err) {
		try {
			watcher.close();
		} catch(e) {}
		retry(err);
	});
}

/*
Start watching the tiddlers folder
*/
exports.start = function() {
	if(watcher || !$tw.syncer || !tiddlersPath()) {
		return;
	}
	watch();
	// The duplicates present at startup
	exports.rescan();
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
	keepJsonFiles(adaptor);
	saveDraftsInDraftsFolder(adaptor);
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
Whether the server writes are held (between pause() and resume())
*/
exports.isPaused = function() {
	return writesHeld;
};

/*
Rescan the tiddlers folder, then apply the held writes and restart the watcher
*/
exports.resume = function() {
	try {
		exports.rescan();
	} catch(e) {
		// The server must write again whatever happens
		logger.log("Cannot rescan the tiddlers folder:",e.message);
	}
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
