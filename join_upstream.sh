#!/usr/bin/env bash

# Joins the git history of a wiki repository created from a copy of TiddlyGit
# (git refuses to merge it: "refusing to merge unrelated histories") with the
# history of TiddlyGit, so that later updates are normal merges.
#
# Usage:
#   git fetch upstream
#   git show upstream/master:join_upstream.sh > /tmp/join_upstream.sh
#   bash /tmp/join_upstream.sh upstream/master [Wikis/<name>]
#
# It converts the wiki to the wiki/ folder (see convert_wiki_folder.sh) and
# commits it, then merges TiddlyGit keeping your wiki, but taking the files of
# TiddlyGit (scripts, plugin...) from upstream. The merge is not committed, so
# that you can review it.

set -euo pipefail

NEW=wiki
# Tiddlers TiddlyGit needs, added when missing
REQUIRED_TIDDLERS=(SynchronizeButton.tid SynchronizeButtonImage.tid GitConflict.tid)

fail() {
	echo "Error: $*" >&2
	exit 1
}

[ $# -ge 1 ] || fail "usage: $0 <TiddlyGit branch, like upstream/master> [Wikis/<name>]"
REF=$1
shift
git rev-parse -q --verify "$REF^{commit}" > /dev/null || fail "unknown branch $REF, run 'git fetch upstream' first"
cd "$(git rev-parse --show-toplevel)"

if git merge-base HEAD "$REF" > /dev/null; then
	echo "The histories are already joined, update with: git merge $REF"
	exit 0
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
	fail "there are uncommitted changes, commit them first"
fi

# --- Convert the wiki to the wiki/ folder

convert=$(mktemp)
trap 'rm -f "$convert"' EXIT
git show "$REF:convert_wiki_folder.sh" > "$convert"
bash "$convert" "$@"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
	git commit -q -m "Move the wiki to $NEW/"
fi

# --- Join the histories, keeping all our files for now

git merge -q --allow-unrelated-histories --no-commit -s ours "$REF"

# --- Take the files of TiddlyGit from upstream

git ls-tree -r -z --name-only "$REF" | grep -z -v -e "^$NEW/" -e '^\.gitignore$' | xargs -0 -r git checkout "$REF" --

# Whether our version of a file is one TiddlyGit had (so we did not modify it).
# Submodules are only pointers to other repositories, they always match.
is_from_tiddlygit() {
	local file=$1 ours commit
	ours=$(git rev-parse -q --verify "HEAD:$file") || return 1
	[ "$(git cat-file -t "$ours")" = commit ] && return 0
	for commit in $(git rev-list "$REF" -- "$file"); do
		if [ "$(git rev-parse -q --verify "$commit:$file" || true)" = "$ours" ]; then
			return 0
		fi
	done
	return 1
}

# Remove the files TiddlyGit deleted (like the Bob plugin)
kept_deleted=()
while IFS= read -r -d '' file; do
	case "$file" in
		"$NEW"/* | Wikis/*) continue ;;
	esac
	if ! git cat-file -e "$REF:$file" 2> /dev/null && [ -n "$(git ls-files -- "$file")" ]; then
		if is_from_tiddlygit "$file"; then
			echo "Removing $file (deleted from TiddlyGit)"
			git rm -r -q --cached -- "$file"
			rm -rf -- "$file"
		else
			kept_deleted+=("$file")
		fi
	fi
done < <(git log --format= --name-only --no-renames --diff-filter=D -z "$REF" | sort -zu)

# .gitignore: the lines of TiddlyGit, then ours
{
	git show "$REF:.gitignore"
	if [ -f .gitignore ]; then
		grep -v -x -F -f <(git show "$REF:.gitignore") .gitignore | grep -v '^$' || true
	fi
} > .gitignore.joined
mv .gitignore.joined .gitignore
git add .gitignore

for tiddler in "${REQUIRED_TIDDLERS[@]}"; do
	if [ ! -e "$NEW/tiddlers/$tiddler" ] && git cat-file -e "$REF:$NEW/tiddlers/$tiddler" 2> /dev/null; then
		echo "Adding $NEW/tiddlers/$tiddler"
		git checkout "$REF" -- "$NEW/tiddlers/$tiddler"
	fi
done

# --- Report

if [ ${#kept_deleted[@]} -gt 0 ]; then
	echo
	echo "These files were deleted from TiddlyGit, but you modified them, they are kept:"
	printf '  %s\n' "${kept_deleted[@]}"
fi

own_files=$(git ls-files | grep -v -e "^$NEW/" | grep -v -x -F -f <(git ls-tree -r --name-only "$REF") || true)
if [ -n "$own_files" ]; then
	echo
	echo "These files are not part of TiddlyGit, they are kept:"
	echo "$own_files" | sed 's/^/  /'
fi
echo
echo "The merge is ready but not committed. Review it with 'git diff --cached HEAD'"
echo "(the TiddlyGit files replace yours), then run 'git commit' and './update.sh'."
