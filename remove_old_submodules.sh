#!/usr/bin/env bash

# Removes the submodules that are no longer in .gitmodules (like TW5-Bob, removed
# from TiddlyGit). When a merge removes a submodule, git leaves its directory
# (it cannot remove its .git file), and "git add --all" (see synchronize.sh)
# adds it back without url in .gitmodules: "git submodule init" then fails with
# "No url found for submodule path ... in .gitmodules".
#
# Usage: ./remove_old_submodules.sh
#
# The submodule is removed from the index (the removal is committed), and its
# directory deleted when nothing would be lost: its repository is in
# .git/modules and it has no uncommitted change. Otherwise the directory is
# kept, but ignored (in .git/info/exclude).

set -euo pipefail

cd "$(dirname "$0")"

known=$(git config -f .gitmodules --get-regexp '\.path$' 2> /dev/null | cut -d' ' -f2- || true)
is_known() {
	grep -q -x -F -e "$1" <<< "$known"
}

# The submodules in the index, and the directories left by the merges
candidates=$(
	{
		git ls-files -s | awk '$1 == 160000' | cut -f2-
		for dir in plugins_repositories/*/; do
			if [ -e "$dir.git" ]; then
				echo "${dir%/}"
			fi
		done
	} | sort -u
)

removed=()
while IFS= read -r path; do
	[ -n "$path" ] || continue
	is_known "$path" && continue
	if [ -n "$(git ls-files -- "$path")" ]; then
		echo "Removing the submodule $path (no longer in .gitmodules)"
		git rm -q --cached -- "$path"
		removed+=("$path")
	fi
	git config --remove-section "submodule.$path" 2> /dev/null || true
	[ -d "$path" ] || continue
	if [ -f "$path/.git" ] && [ -z "$(git -C "$path" status --porcelain 2> /dev/null || echo error)" ]; then
		rm -rf -- "$path"
	else
		exclude=$(git rev-parse --git-path info/exclude)
		mkdir -p "$(dirname "$exclude")"
		if ! grep -q -x -F -e "/$path/" "$exclude" 2> /dev/null; then
			echo "/$path/" >> "$exclude"
		fi
		echo "Warning: $path is no longer a submodule, but it is kept (it has a repository or changes of its own), and ignored by git. Delete it if you do not need it."
	fi
done <<< "$candidates"

if [ ${#removed[@]} -gt 0 ]; then
	git commit -q -m "Remove the submodules no longer in .gitmodules" -- "${removed[@]}" \
		|| echo "Warning: the removal of ${removed[*]} could not be committed, commit it yourself"
fi
