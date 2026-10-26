#!/usr/bin/env bash

# Run by the TiddlyWiki server (see tiddlygit-plugin/synchronize-route.js) when
# the synchronize button is pressed. The server holds its own file writes while
# this script runs, and reloads the changed files when it ends.

# Keep the merge driver configuration up to date (see installation.sh)
git config merge.tiddly-merge.name "merge for TiddlyWiki tiddler files"
git config merge.tiddly-merge.driver "./tiddly-merge.py %O %A %B %P"

git add --all
git commit -m"Synchronize with script"
git fetch
return_code=$?
if [ "$return_code" != 0 ]
then
	notify-send -u critical "Synchronization failed: git fetch"
	exit 1
fi

git merge --no-edit
return_code=$?
echo "Return code=$return_code"

# Git cannot merge a tiddler saved as .json on one side and as .tid on the other
if [ "$return_code" != 0 ] && ./tiddly-merge.py --resolve-format-changes
then
	git commit --no-edit
	return_code=$?
fi

if [ "$return_code" = 0 ]
then
	git add --all
	git commit -m"Commit conflicts"
	git push
	notify-send "Synchronization successful"
else
	notify-send -u critical "Synchronization failed: git merge"
	exit 1
fi
