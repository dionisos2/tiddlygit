#!/usr/bin/env bash

# Moves a wiki from the old layout (Wikis/<name>/, used with the Bob plugin) to
# the wiki/ folder, keeping the git history of the tiddlers, and removes what
# belonged to Bob.
#
# Usage: ./convert_wiki_folder.sh [Wikis/<name>]
#
# It can be run before or after merging the new version of TiddlyGit (in the
# latter case wiki/ already holds the template tiddlers). The changes are
# staged, not committed.

set -euo pipefail

NEW=wiki
# Paths, relative to the wiki folder, that only Bob used
BOB_PATHS=(
	settings
	example-start-script.sh
	plugins/TW5-Bob
	'tiddlers/$__MultiUser_EditingTiddlers.tid'
	'tiddlers/$__plugins_OokTech_Bob_NodeScriptHandlers.js'
	'tiddlers/$__plugins_OokTech_Bob_NodeScriptHandlers.js.meta'
)

fail() {
	echo "Error: $*" >&2
	exit 1
}

is_tracked() {
	git ls-files --error-unmatch -- "$1" > /dev/null 2>&1
}

is_bob_path() {
	local rel=$1 bob
	for bob in "${BOB_PATHS[@]}"; do
		if [ "$rel" = "$bob" ] || [[ "$rel" == "$bob"/* ]]; then
			return 0
		fi
	done
	return 1
}

# Generated plugins (ignored by git) are copied again by update.sh
is_generated_plugin() {
	[[ "$1" == plugins/* ]] && ! is_tracked "$OLD/$1"
}

remove() {
	if is_tracked "$1"; then
		git rm -r -q --cached -- "$1"
	fi
	rm -rf -- "$1"
}

# --- Find the wiki to convert

if [ $# -ge 1 ]; then
	OLD=${1%/}
	[ -d "$OLD" ] || fail "$OLD does not exist"
else
	shopt -s nullglob
	candidates=(Wikis/*/)
	shopt -u nullglob
	if [ ${#candidates[@]} -eq 0 ]; then
		echo "Nothing to convert: there is no Wikis/ folder"
		exit 0
	fi
	if [ ${#candidates[@]} -gt 1 ]; then
		fail "several wikis found (${candidates[*]}), give the one to convert: $0 Wikis/<name>"
	fi
	OLD=${candidates[0]%/}
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
	fail "there are uncommitted changes, commit them first"
fi

# --- Check that no file would be overwritten, before changing anything

files=()
while IFS= read -r -d '' file; do
	files+=("$file")
done < <(find "$OLD" -type f -print0 | sort -z)

if [ -e "$NEW" ]; then
	conflicts=()
	for file in "${files[@]}"; do
		rel=${file#"$OLD"/}
		dest="$NEW/$rel"
		if [ -e "$dest" ] && [ "$rel" != tiddlywiki.info ] && ! is_bob_path "$rel" \
			&& ! is_generated_plugin "$rel" && ! cmp -s "$file" "$dest"; then
			conflicts+=("$file -> $dest")
		fi
	done
	if [ ${#conflicts[@]} -gt 0 ]; then
		echo "Error: these files exist in both folders with a different content:" >&2
		printf '  %s\n' "${conflicts[@]}" >&2
		fail "merge them by hand (and remove the one in $OLD), then run this script again"
	fi
fi

# --- Remove what belonged to Bob

for bob in "${BOB_PATHS[@]}"; do
	if [ -e "$OLD/$bob" ]; then
		echo "Removing $OLD/$bob"
		remove "$OLD/$bob"
	fi
done

# --- Move the files

if [ ! -e "$NEW" ]; then
	echo "Moving $OLD to $NEW"
	git mv "$OLD" "$NEW"
else
	echo "Moving the files of $OLD to $NEW"
	for file in "${files[@]}"; do
		[ -e "$file" ] || continue
		rel=${file#"$OLD"/}
		dest="$NEW/$rel"
		if [ ! -e "$dest" ]; then
			mkdir -p "$(dirname "$dest")"
			if is_tracked "$file"; then
				git mv "$file" "$dest"
			else
				mv "$file" "$dest"
			fi
		elif [ "$rel" = tiddlywiki.info ] && ! cmp -s "$file" "$dest"; then
			# The configuration of the user wins over the template one
			cp "$file" "$dest"
			git add -- "$dest"
			remove "$file"
		else
			remove "$file"
		fi
	done
	find "$OLD" -depth -type d -empty -delete
fi
rmdir Wikis 2> /dev/null || true

# --- Make the synchronize button use the server instead of Bob's websocket

while IFS= read -r -d '' file; do
	if grep -q "<\$action-websocketmessage[^>]*name=['\"]synchronize['\"]" "$file"; then
		echo "Updating the synchronize button in $file"
		sed -i "s|<\$action-websocketmessage[^>]*name=['\"]synchronize['\"][^>]*/>|<<tiddlygit-synchronize-actions>>|" "$file"
		if is_tracked "$file"; then
			git add -- "$file"
		fi
	fi
done < <(find "$NEW/tiddlers" -type f -name "*.tid" -print0)

others=$(grep -rl "action-websocketmessage" "$NEW/tiddlers" || true)
if [ -n "$others" ]; then
	echo "Warning: these tiddlers still use Bob's websocket messages, which do nothing now:"
	echo "$others" | sed 's/^/  /'
fi

# --- Update .gitignore

if [ -f .gitignore ]; then
	escaped_old=$(printf '%s' "$OLD" | sed 's/[][\.*^$|]/\\&/g')
	sed -i "s|^$escaped_old/|$NEW/|" .gitignore
fi
story_list="$NEW/tiddlers/\$__StoryList.tid"
if ! grep -qxF "$story_list" .gitignore 2> /dev/null; then
	if [ -s .gitignore ] && [ -n "$(tail -c 1 .gitignore)" ]; then
		echo >> .gitignore
	fi
	echo "$story_list" >> .gitignore
fi
git add .gitignore

# Stop tracking the files that are now ignored (they stay on disk)
git ls-files -z --cached --ignored --exclude-standard -- "$NEW" | xargs -0 -r git rm -q --cached --

echo
echo "Done, the changes are staged. Check them with 'git status', commit them,"
echo "then run ./update.sh to install the plugins in $NEW/plugins."
