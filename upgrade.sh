#!/usr/bin/env bash

# Upgrades a wiki repository to the last version of TiddlyGit: stops the server
# (after asking), merges upstream/master, then runs update.sh to install the new
# version of the plugins. The server must then be restarted.
#
# Usage: ./upgrade.sh
#
# The merge is skipped when there is no "upstream" remote (see README.md).
# It may change this script: git replaces the file instead of rewriting it, so
# bash keeps reading the version it started with.

set -euo pipefail

REMOTE=upstream
BRANCH=upstream/master

fail() {
	echo "Error: $*" >&2
	exit 1
}

cd "$(dirname "$0")"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
	fail "there are uncommitted changes, synchronize or commit them first"
fi

answer=""
read -r -p "The TiddlyWiki server must be stopped during the upgrade. Stop it now? [y/N] " answer || true
case "$answer" in
	[yY] | [yY][eE][sS]) ;;
	*) fail "the server must be stopped, nothing was done" ;;
esac
./kill_tiddlygit.sh

if git remote get-url "$REMOTE" > /dev/null 2>&1; then
	# The merge driver of the tiddlers (see installation.sh)
	git config merge.tiddly-merge.name "merge for TiddlyWiki tiddler files"
	git config merge.tiddly-merge.driver "./tiddly-merge.py %O %A %B %P"
	git fetch "$REMOTE" || fail "git fetch $REMOTE"
	git merge --no-edit "$BRANCH" \
		|| fail "the merge of $BRANCH failed: resolve the conflicts, commit, then run ./update.sh and restart the server"
else
	echo "No \"$REMOTE\" remote, TiddlyGit is not merged (see the Update section of README.md)"
fi

# The version of update.sh that was just merged
./update.sh || fail "update.sh"

echo
echo "Upgrade done: restart the server (./run.sh, or the way you usually start it)."
