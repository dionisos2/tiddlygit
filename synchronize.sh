#!/usr/bin/env bash

# Run by the TiddlyWiki server (see tiddlygit-plugin/synchronize-route.js) when
# the synchronize button is pressed. The server holds its own file writes while
# this script runs, and reloads the changed files when it ends.
#
# The exit code tells the result (0 when successful); notify-send is only
# informative, it may not be available.

notify() {
	notify-send "$@" 2> /dev/null || true
}

fail() {
	echo "Synchronization failed: $1"
	notify -u critical "Synchronization failed: $1"
	exit 1
}

# Keep the merge driver configuration up to date (see installation.sh)
git config merge.tiddly-merge.name "merge for TiddlyWiki tiddler files"
git config merge.tiddly-merge.driver "./tiddly-merge.py %O %A %B %P"

git add --all
git commit -m"Synchronize with script"
git fetch || fail "git fetch"

git merge --no-edit
return_code=$?
echo "Return code=$return_code"

# Resolve the conflicts git leaves on tiddlers (deleted on one side and modified
# on the other, saved as .json on one side and as .tid on the other...)
if [ "$return_code" != 0 ] && ./tiddly-merge.py --resolve-conflicts
then
	git commit --no-edit
	return_code=$?
fi

if [ "$return_code" != 0 ]
then
	# Go back to our last commit, so that no conflict marker is loaded in the
	# wiki or committed by the next synchronization. Everything was committed
	# before merging, so the untracked files are conflict tiddlers of the merge.
	git merge --abort
	git clean -f -q -- wiki/tiddlers
	fail "git merge"
fi

git add --all
git commit -m"Commit conflicts"
git push || fail "git push"
notify "Synchronization successful"
exit 0
