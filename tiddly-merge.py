#!/usr/bin/env python3
"""
Git merge driver for TiddlyWiki tiddler files (.tid and .json).

Usage (configured by installation.sh): tiddly-merge.py %O %A %B %P
       tiddly-merge.py --resolve-conflicts (run by synchronize.sh)

The tiddlers are merged field by field: a field changed on one side only takes
that value, when both sides changed the text, it is merged line by line, and
when both sides changed a list of titles (tags, list), it is merged title by
title.
When both sides changed the same field differently, our version is kept, and
their version is saved as a new tiddler tagged GitConflict, each one linking to
the other. Conflicts on unimportant fields are ignored (our value is kept).

Other .json files (like plugins) are merged structurally: objects key by key,
arrays element by element and strings line by line. When this is not possible
(conflict, or formatting that cannot be kept), files are merged line by line
like git does by default.

The conflicts git resolves without calling the merge driver are resolved by
--resolve-conflicts: a tiddler deleted on one side and modified (or renamed) on
the other is kept, with a conflict note, and a binary tiddler changed on both
sides keeps our version, theirs being saved as a new tiddler tagged GitConflict.
"""

import json
import os
import re
import subprocess
import sys
import tempfile

TID_PATH = "./wiki/tiddlers/"

UNIMPORTANT_FIELDS = [
	"modified",
	"created",
	"nouvelle-tache",
	"fields-to-show",
	"date-start",
	"date-start-temp",
	"days-count",
	"days-count-temp",
	"show-day-record",
]

# Fields holding a list of titles, merged element by element
TITLE_LIST_FIELDS = ["tags", "list"]

TID, JSON = "tid", "json"


def parse_tid(content):
	"""Parse a .tid file the way TiddlyWiki does."""
	fields = {}
	parts = re.split(r"\r?\n\r?\n", content)
	for line in re.split(r"\r?\n", parts[0]):
		if line.startswith("#"):
			continue
		name, colon, value = line.partition(":")
		if colon and name.strip():
			fields[name.strip()] = value.strip()
	if len(parts) >= 2:
		fields["text"] = "\n\n".join(parts[1:])
	return fields


def parse(content):
	"""
	Return (format, fields) for a file holding one tiddler, or None.
	The format is found from the content, so that a tiddler saved as .tid on
	one side and as .json on the other can still be merged.
	"""
	if content.lstrip().startswith(("[", "{")):
		try:
			data = json.loads(content)
		except ValueError:
			return None
		if isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict) \
				and all(isinstance(value, str) for value in data[0].values()):
			return JSON, data[0]
		return None
	fields = parse_tid(content)
	return (TID, fields) if fields.get("title") else None


def serialize(file_format, fields):
	"""Write a tiddler the way TiddlyWiki does."""
	if file_format == JSON:
		return json.dumps([fields], indent=4, ensure_ascii=False)
	header = "\n".join(f"{name}: {fields[name]}" for name in sorted(fields) if name not in ("text", "bag"))
	text = fields.get("text", "")
	return header + ("\n\n" + text if text else "")


def has_unsafe_fields(fields):
	"""Whether the tiddler cannot be saved as a .tid file (see TiddlyWiki's generateTiddlerFileInfo)."""
	return any(
		re.search(r"[\x00-\x1F]", value) or value.strip() != value or re.search(r"[:#]", name)
		for name, value in fields.items() if name != "text"
	)


def parse_title_list(value):
	"""Parse a list of titles like "One [[Another one]]" the way TiddlyWiki does (parseStringArray)."""
	titles = []
	for match in re.finditer(r"(?:^|[^\S\xA0])(?:\[\[(.*?)\]\])(?=[^\S\xA0]|$)|([\S\xA0]+)", value or ""):
		title = match.group(1) if match.group(1) is not None else match.group(2)
		if title not in titles:
			titles.append(title)
	return titles


def stringify_title_list(titles):
	"""Write a list of titles the way TiddlyWiki does (stringifyList)."""
	return " ".join(f"[[{title}]]" if re.search(r"[^\S\xA0]", title) else title for title in titles)


def merge_title_lists(base, ours, theirs):
	"""
	Merge three versions of a list of titles: the titles removed by one side
	are removed, and the titles added by theirs are inserted after the title
	preceding them in theirs. The order of ours is kept.
	"""
	base, ours, theirs = parse_title_list(base), parse_title_list(ours), parse_title_list(theirs)
	merged = [title for title in ours if title in theirs or title not in base]
	for index, title in enumerate(theirs):
		if title in merged or title in base:
			continue
		previous = [other for other in theirs[:index] if other in merged]
		merged.insert(merged.index(previous[-1]) + 1 if previous else 0, title)
	return stringify_title_list(merged)


def merge_lines(base, ours, theirs):
	"""Merge three texts line by line, return the result or None on conflict."""
	with tempfile.TemporaryDirectory() as folder:
		paths = []
		for name, content in (("ours", ours), ("base", base), ("theirs", theirs)):
			path = os.path.join(folder, name)
			with open(path, "w") as file:
				file.write(content)
			paths.append(path)
		result = subprocess.run(["git", "merge-file", "-p", "--quiet"] + paths, stdout=subprocess.PIPE)
	return result.stdout.decode("utf-8") if result.returncode == 0 else None


class MergeConflict(Exception):
	pass


# A key missing from a json object
MISSING = object()


def same(a, b):
	"""Strict json equality (in Python, True == 1)."""
	if a is MISSING or b is MISSING:
		return a is b
	return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def merge_values(base, ours, theirs):
	"""Three-way merge of json values, raise MergeConflict when it is not possible."""
	if same(ours, theirs) or same(theirs, base):
		return ours
	if same(ours, base):
		return theirs
	if isinstance(ours, dict) and isinstance(theirs, dict):
		base = base if isinstance(base, dict) else {}
		merged = {}
		for key in dict.fromkeys(list(ours) + list(theirs)):
			value = merge_values(base.get(key, MISSING), ours.get(key, MISSING), theirs.get(key, MISSING))
			if value is not MISSING:
				merged[key] = value
		return merged
	if isinstance(ours, str) and isinstance(theirs, str):
		merged = merge_lines(base if isinstance(base, str) else "", ours, theirs)
		if merged is None:
			raise MergeConflict()
		return merged
	if isinstance(ours, list) and isinstance(theirs, list):
		# Merge the elements like lines (a compact json value has no line break)
		def as_lines(values):
			return "".join(json.dumps(value, ensure_ascii=False) + "\n" for value in values)
		merged = merge_lines(as_lines(base if isinstance(base, list) else []), as_lines(ours), as_lines(theirs))
		if merged is None:
			raise MergeConflict()
		return [json.loads(line) for line in merged.splitlines()]
	raise MergeConflict()


def json_format(content):
	"""Return the json.dumps options and the ending reproducing content exactly, or None."""
	data = json.loads(content)
	ending = content[len(content.rstrip("\n")):]
	for ensure_ascii in (False, True):
		for indent in (4, 2, "\t", None, 1, 3, 8):
			options = {"indent": indent, "ensure_ascii": ensure_ascii}
			if indent is None:
				options["separators"] = (",", ":")
			if json.dumps(data, **options) + ending == content:
				return options, ending
	return None


def merge_json_file(base_content, ours_content, theirs_content):
	"""
	Merge json files structurally, return the result or None when it is not
	possible (invalid json, conflict, or formatting that cannot be kept).
	"""
	try:
		result_format = json_format(ours_content)
		if result_format is None:
			return None
		base = json.loads(base_content) if base_content.strip() else MISSING
		merged = merge_values(base, json.loads(ours_content), json.loads(theirs_content))
	except (ValueError, MergeConflict):
		return None
	options, ending = result_format
	return json.dumps(merged, **options) + ending


def merge_fields(base, ours, theirs):
	"""
	Merge the fields of three versions of a tiddler.
	Return the merged fields (in the order of ours) and the conflicting field names.
	"""
	merged = {}
	conflicts = []
	names = list(ours) + [name for name in list(theirs) + list(base) if name not in ours]
	for name in dict.fromkeys(names):
		base_value, ours_value, theirs_value = base.get(name), ours.get(name), theirs.get(name)
		if ours_value == theirs_value or theirs_value == base_value:
			value = ours_value
		elif ours_value == base_value:
			value = theirs_value
		elif name in UNIMPORTANT_FIELDS:
			value = ours_value
		elif name in TITLE_LIST_FIELDS:
			value = merge_title_lists(base_value, ours_value, theirs_value)
			if not value and ours_value is None:
				value = None
		else:
			value = None
			if name == "text" and ours_value is not None and theirs_value is not None:
				value = merge_lines(base_value or "", ours_value, theirs_value)
			if value is None:
				value = ours_value
				conflicts.append(name)
		if value is not None:
			merged[name] = value
	# Fields only in theirs come after the fields of ours
	return merged, conflicts


def run(command):
	return subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout.decode("utf-8").strip()


def theirs_commit():
	"""
	The commit being merged: git gives it in a GITHEAD_<commit> environment
	variable while the merge driver runs, and in MERGE_HEAD after.
	"""
	commits = [name[len("GITHEAD_"):] for name in os.environ if name.startswith("GITHEAD_")]
	return commits[0] if len(commits) == 1 else "MERGE_HEAD"


def ours_user():
	return run(["git", "config", "user.name"])


def theirs_user():
	return run(["git", "show", "-s", "--format=%an", theirs_commit()])


def add_note(fields, note):
	fields["text"] = (fields.get("text", "") + "\n\n" + note).lstrip("\n")


def add_conflict_note(fields, title, user):
	add_note(fields, f"CONFLICT : [[{title}]] (modified by : {user})")


def add_conflict_tag(fields):
	fields["tags"] = (fields.get("tags", "") + " GitConflict").strip()


def save_conflict_copy(file_format, fields, suffix):
	"""Save their version as a new tiddler, return its title."""
	copy = dict(fields)
	copy["title"] = fields["title"] + suffix
	add_conflict_tag(copy)
	if has_unsafe_fields(copy):
		file_format = JSON
	filename = re.sub(r'[<>:"/\\|?*^]', "_", copy["title"]) + (".json" if file_format == JSON else ".tid")
	with open(os.path.join(TID_PATH, filename), "w") as file:
		file.write(serialize(file_format, copy))
	return copy


def other_format_paths(path):
	stem, extension = os.path.splitext(path)
	return [stem + other for other in (".tid", ".json") if other != extension]


def base_in_other_format(path):
	"""
	When both sides saved a tiddler in a new format (like X.tid becoming
	X.json), git has no common version: find it in the other format, in the
	common ancestor of the merged commits. Git gives the commit being merged
	in a GITHEAD_<commit> environment variable.
	"""
	merge_base = run(["git", "merge-base", "HEAD", theirs_commit()])
	for other_path in other_format_paths(path):
		result = subprocess.run(["git", "show", f"{merge_base}:{other_path}"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
		if merge_base and result.returncode == 0:
			return result.stdout.decode("utf-8")
	return ""


def merge_tiddler_file(base_path, ours_path, theirs_path, path=None):
	contents = []
	for file_path in (base_path, ours_path, theirs_path):
		with open(file_path) as file:
			contents.append(file.read())
	base_content, ours_content, theirs_content = contents
	if not base_content.strip() and path:
		base_content = base_in_other_format(path)
	ours, theirs = parse(ours_content), parse(theirs_content)
	base = parse(base_content) if base_content.strip() else (TID, {})
	if ours is None or theirs is None or base is None:
		# Not a tiddler file
		merged = merge_json_file(base_content, ours_content, theirs_content)
		if merged is None:
			# Do what git does by default
			return subprocess.run(["git", "merge-file", ours_path, base_path, theirs_path]).returncode
		with open(ours_path, "w") as file:
			file.write(merged)
		return 0

	merged = merge_tiddlers(base[1], ours[1], theirs, theirs_content)
	# Git expects the result in the same file, so the format of ours is kept
	with open(ours_path, "w") as file:
		file.write(serialize(ours[0], merged))
	return 0


def merge_tiddlers(base, ours, theirs, theirs_content):
	"""
	Merge the fields of a tiddler (theirs is a (format, fields) pair), saving
	their version as a conflict tiddler when needed. Return the merged fields.
	"""
	merged, conflicts = merge_fields(base, ours, theirs[1])
	if conflicts:
		print(f"Conflict on the fields {', '.join(conflicts)} of {ours['title']}")
		theirs_fields = dict(theirs[1])
		add_conflict_note(theirs_fields, merged["title"], ours_user())
		copy = save_conflict_copy(theirs[0], theirs_fields, str(hash(theirs_content)))
		add_conflict_note(merged, copy["title"], theirs_user())
	return merged


def show(commit, paths):
	"""Return (path, content) of the first path existing in commit, or (None, None)."""
	for path in paths:
		result = subprocess.run(["git", "show", f"{commit}:{path}"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
		if result.returncode == 0:
			return path, result.stdout.decode("utf-8")
	return None, None


def resolve_format_change(path, merge_base):
	"""
	Resolve the modify/delete conflict of a tiddler file saved in another
	format on one side (X.tid deleted and X.json added). Return whether it was
	resolved.
	"""
	paths = [path] + other_format_paths(path)
	ours_path, ours_content = show("HEAD", paths)
	theirs_path, theirs_content = show("MERGE_HEAD", paths)
	_, base_content = show(merge_base, paths)
	if ours_path is None or theirs_path is None or ours_path == theirs_path:
		return False
	ours, theirs = parse(ours_content), parse(theirs_content)
	base = parse(base_content) if base_content else (TID, {})
	if ours is None or theirs is None or base is None or ours[1]["title"] != theirs[1]["title"]:
		return False

	merged = merge_tiddlers(base[1], ours[1], theirs, theirs_content)
	# Once a tiddler is saved as .json, it stays .json (see tiddlygit-plugin)
	result_path = ours_path if ours[0] == JSON else theirs_path
	with open(result_path, "w") as file:
		file.write(serialize(ours[0] if result_path == ours_path else theirs[0], merged))
	for other_path in paths:
		if other_path != result_path:
			subprocess.run(["git", "rm", "-q", "--ignore-unmatch", "--", other_path], check=True)
	subprocess.run(["git", "add", "--", result_path], check=True)
	return True


def unmerged_stages():
	"""Return {path: {stage: blob}} for the unmerged paths (1 base, 2 ours, 3 theirs)."""
	output = subprocess.run(["git", "ls-files", "-u", "-z"], stdout=subprocess.PIPE, check=True).stdout.decode("utf-8")
	stages = {}
	for entry in output.split("\0"):
		if entry:
			info, path = entry.split("\t", 1)
			_, blob, stage = info.split()
			stages.setdefault(path, {})[int(stage)] = blob
	return stages


def blob_content(blob):
	return subprocess.run(["git", "cat-file", "blob", blob], stdout=subprocess.PIPE, check=True).stdout


def is_in_tiddlers_folder(path):
	return os.path.normpath(path).startswith(os.path.normpath(TID_PATH) + os.sep)


def keep_one_side(path, stages):
	"""
	Resolve a conflict where the file exists on one side only (modified or
	renamed on that side, deleted on the other): keep it. When it was deleted on
	the other side, a tiddler gets a conflict note.
	"""
	side = 2 if 2 in stages else 3
	content = blob_content(stages[side])
	tiddler = parse(content.decode("utf-8", errors="replace")) if path.endswith((".tid", ".json")) else None
	if 1 in stages and tiddler is not None:
		deleter, modifier = (theirs_user(), ours_user()) if side == 2 else (ours_user(), theirs_user())
		print(f"{tiddler[1]['title']} was deleted by {deleter}, but modified by {modifier}: it is kept")
		fields = dict(tiddler[1])
		add_note(fields, f"CONFLICT : deleted by {deleter}, but modified by {modifier}")
		add_conflict_tag(fields)
		content = serialize(tiddler[0], fields).encode("utf-8")
	with open(path, "wb") as file:
		file.write(content)
	subprocess.run(["git", "add", "--", path], check=True)


def keep_ours_and_copy_theirs(path, stages):
	"""
	Resolve a conflict on a tiddler file git cannot merge (like an image):
	keep ours, and save theirs as a new tiddler tagged GitConflict.
	"""
	theirs_content = blob_content(stages[3])
	suffix = str(hash(theirs_content))
	stem, extension = os.path.splitext(path)
	copy_path = stem + suffix + extension
	_, meta_content = show("MERGE_HEAD", [path + ".meta"])
	meta = parse_tid(meta_content) if meta_content else {}
	meta["title"] = meta.get("title", os.path.basename(path)) + suffix
	add_conflict_tag(meta)
	print(f"Conflict on {path}: their version is saved as {copy_path}")
	with open(copy_path, "wb") as file:
		file.write(theirs_content)
	with open(copy_path + ".meta", "w") as file:
		file.write(serialize(TID, {name: value for name, value in meta.items() if name != "text"}) + "\n")
	with open(path, "wb") as file:
		file.write(blob_content(stages[2]))
	subprocess.run(["git", "add", "--", path], check=True)


def remove(path):
	subprocess.run(["git", "rm", "-q", "--cached", "--", path], check=True)
	if os.path.exists(path):
		os.remove(path)


def is_renamed_copy(stages, all_stages):
	"""
	Whether the file is the theirs side of a file renamed differently on both
	sides: git puts the merged content (with a conflict on the title) under both
	names, the name of ours is kept.
	"""
	return list(stages) == [3] and any(
		list(other) == [2] and other[2] == stages[3] for other in all_stages.values())


def resolve_conflict(path, stages, all_stages, merge_base):
	"""Resolve the conflict git left on a file, return whether it was resolved."""
	if not is_in_tiddlers_folder(path):
		return False
	if path.endswith((".tid", ".json")) and resolve_format_change(path, merge_base):
		return True
	if (2 not in stages and 3 not in stages) or is_renamed_copy(stages, all_stages):
		# Deleted (or renamed) on both sides
		remove(path)
		return True
	if 2 not in stages or 3 not in stages:
		keep_one_side(path, stages)
		return True
	if not path.endswith((".tid", ".json", ".meta")):
		keep_ours_and_copy_theirs(path, stages)
		return True
	return False


def resolve_conflicts():
	"""
	Resolve the conflicts git leaves without calling the merge driver (see the
	module documentation). Return 0 when no conflict is left.
	"""
	merge_base = run(["git", "merge-base", "HEAD", "MERGE_HEAD"])
	left = []
	initial_stages = unmerged_stages()
	for path in initial_stages:
		# Resolving a format change resolves the file in the other format too
		stages = unmerged_stages().get(path)
		if stages and not resolve_conflict(path, stages, initial_stages, merge_base):
			left.append(path)
	for path in left:
		print(f"Unresolved conflict: {path}")
	return 1 if left else 0


if __name__ == "__main__":
	if sys.argv[1:] == ["--resolve-conflicts"]:
		sys.exit(resolve_conflicts())
	if len(sys.argv) not in (4, 5):
		print("Should take 3 or 4 arguments : %O %A %B [%P]")
		sys.exit(1)
	sys.exit(merge_tiddler_file(*sys.argv[1:]))
