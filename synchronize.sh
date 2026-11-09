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

# Git cannot merge a tiddler saved as .json on one side and as .tid on the other
if [ "$return_code" != 0 ] && ./tiddly-merge.py --resolve-format-changes
then
	git commit --no-edit
	return_code=$?
fi

[ "$return_code" = 0 ] || fail "git merge"

git add --all
git commit -m"Commit conflicts"
git push || fail "git push"
notify "Synchronization successful"
exit 0
